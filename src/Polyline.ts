/**
 * Polyline — полилиния с толстой линией (Line2), высотами узлов,
 * видимостью по зуму и подписью.
 *
 * LOD: Douglas–Peucker в world-координатах, кэш по бакетам зума.
 * Для стабильности Float32 в Line2 геометрия хранится относительно
 * локального origin (аналогично Polygon); абсолютные координаты
 * остаются только в `_absPositions` для подписи/интерактива.
 */

import { Projections } from './Projections.js';
import { THREE, Line2, LineMaterial, LineGeometry } from './js_TP/tpb.js';
import { SpatialObject, ZoomInterpolation } from './SpatialObject.js';
import { douglasPeuckerIndices, simplifyRingIndices } from './Simplify.js';

export type LonLat = [number, number];
export type PolylinePosition = [number, number] | [number, number, number];
export type PolylineTitleAlignH = 'left' | 'center' | 'right';
export type PolylineTitleAlignV = 'top' | 'middle' | 'center' | 'bottom';
export type PolylineTitlePlacement = 'center' | 'along';
export type PolylineAltitudeMode = 'clampToGround' | 'absolute';
export type LineDasharray = [number, number] | number;

export interface PolylineOptions {
    positions: PolylinePosition[];
    crs?: string;
    color?: string | number;
    opacity?: number;
    width?: number;
    altitudeMode?: PolylineAltitudeMode;
    altitude?: number;
    /** @deprecated Используйте `altitude`. */
    altitudeOffset?: number;
    minZoom?: number;
    maxZoom?: number;
    depthTest?: boolean;
    depthWrite?: boolean;
    heightUpdateInterval?: number;
    title?: string;
    titleOffset?: [number, number];
    titleAlign?: PolylineTitleAlignH;
    titleStyle?: Record<string, string | number>;
    titleMinZoom?: number;
    titleMaxZoom?: number;
    titlePlacement?: PolylineTitlePlacement;
    titleVerticalAlign?: PolylineTitleAlignV;
    titleAllowOverflow?: boolean;
    titlePriority?: number;
    tooltip?: string;
    onClick?: (event: MouseEvent, polyline: Polyline) => void;
    onHover?: (hovered: boolean) => void;
    properties?: Record<string, any>;
    userData?: Record<string, any>;
    /** `[dash, gap]` в world-метрах, либо число (`[n, n]`). */
    lineDasharray?: LineDasharray;
    lineDashOffset?: number;
    zoomInterpolate?: ZoomInterpolation | null;

    simplify?: boolean;
    simplifyTolerance?: number;
    simplifyZoomBucket?: number;
}

const REBUILD_DEBOUNCE_MS = 60;

interface BoundingCache {
    cx: number; cy: number; cz: number; r: number;
}

interface SimplifiedLineData {
    abs: [number, number][];
    nodeH: number[];
}

export class Polyline extends SpatialObject {
    // ── Данные ──
    private _positions: PolylinePosition[];
    private _crsCode: string | null;
    private _crs: any | null;

    // ── Оформление ──
    private _color: string | number;
    private _opacity: number;
    private _width: number;
    private _altitudeMode: PolylineAltitudeMode;
    private _depthTest: boolean;
    private _depthWrite: boolean;
    private _lineDasharray: LineDasharray | null = null;
    private _lineDashOffset: number = 0;

    // ── Высоты ──
    private _heightUpdateInterval: number;
    private _lastHeightUpdateTime = 0;
    private _heightsFinalized = false;
    private _absPositions: Array<[number, number]> = [];
    private _nodeHeights: number[] = [];
    private _cachedHeights: number[] | null = null;

    // ── LOD ──
    private _simplify = true;
    private _simplifyTolerance = 0.5;
    private _simplifyZoomBucket = 1;
    private _simplifyCache = new Map<number, SimplifiedLineData>();
    private _fullLineData: SimplifiedLineData | null = null;
    private _currentSimplifyBucket = -1;
    private _pendingBucket = -1;
    private _rebuildTimer: ReturnType<typeof setTimeout> | null = null;
    private _pendingRebuild = false;

    // ── Кэши / перфоманс ──
    private _projectedCache: [number, number][] | null = null;
    private _positionsDirty = true;
    private _bsCache: BoundingCache | null = null;

    /**
     * Локальный origin геометрии. Line2 хранит вершины во Float32,
     * поэтому абсолютные world-координаты (~1e9) теряют точность
     * (ULP ≈ 128) и соседние вершины после LOD-упрощения на высоком
     * зуме коллапсируют в одну → NaN в шейдере, пропадают сегменты.
     * Считаем origin один раз от ПОЛНОГО (не-LOD) набора — при смене
     * бакета origin не меняется.
     */
    private _localOrigin = new THREE.Vector3(0, 0, 0);
    private _localOriginValid = false;

    // ── Подпись ──
    private _titlePlacement: PolylineTitlePlacement;
    private _titleVerticalAlign: PolylineTitleAlignV;
    private _labelT = 0.5;
    private _labelPrefixSums: number[] | null = null;

    private _tmpLabelWorld = new THREE.Vector3();
    private _tmpLabelScreen = new THREE.Vector3();
    private _tmpLabelScreen2 = new THREE.Vector3();

    private _screenData: {
        points3D: any[] | null;
        segLengths: number[] | null;
        totalLen: number;
        visibleInterval: { min: number; max: number } | null;
        camera: any;
        map: any;
        valid: boolean;
    } = {
        points3D: null, segLengths: null, totalLen: 0,
        visibleInterval: null, camera: null, map: null, valid: false,
    };

    // ── 3D-объекты ──
    private _line: any = null;
    private _material: any = null;
    private _geometry: any = null;

    // ── Интерактив ──
    private _unregisterInteraction: (() => void) | null = null;

    constructor(options: PolylineOptions) {
        super();

        if (options.zoomInterpolate) this.setZoomInterpolations(options.zoomInterpolate);
        this._properties = options.properties ?? {};
        this._userData = options.userData ?? {};
        if (!options.positions?.length || options.positions.length < 2) {
            throw new Error('Polyline: options.positions required, at least 2 points');
        }

        this._positions = options.positions;
        this._simplify = options.simplify ?? true;
        this._simplifyTolerance = options.simplifyTolerance ?? 0.5;
        this._simplifyZoomBucket = options.simplifyZoomBucket ?? 1;
        this._crsCode = options.crs ?? null;
        this._crs = null;

        this._color = options.color ?? '#3388ff';
        this._opacity = options.opacity ?? 1;
        this._width = options.width || 2;
        this._altitudeMode = options.altitudeMode ?? 'clampToGround';
        this._altitude = options.altitude ?? options.altitudeOffset ?? 10;
        this._lineDasharray = options.lineDasharray ?? null;
        this._lineDashOffset = options.lineDashOffset ?? 0;
        this._minZoom = options.minZoom ?? -Infinity;
        this._maxZoom = options.maxZoom ?? Infinity;
        this._depthTest = options.depthTest ?? false;
        this._depthWrite = options.depthWrite ?? false;

        this._heightUpdateInterval = options.heightUpdateInterval ?? 500;

        this._title = options.title ?? '';
        this._titleAlign = options.titleAlign ?? 'center';
        this._titleStyle = options.titleStyle ?? {};
        this._titleMinZoom = options.titleMinZoom ?? -Infinity;
        this._titleMaxZoom = options.titleMaxZoom ?? Infinity;
        this._titlePlacement = options.titlePlacement ?? 'center';
        this._titleVerticalAlign = options.titleVerticalAlign ?? 'center';
        this._userTitleOffset = options.titleOffset
            ? [options.titleOffset[0], options.titleOffset[1]]
            : null;
        this._titleAllowOverflow = options.titleAllowOverflow ?? false;
        this._titlePriority = options.titlePriority ?? 0;
        this._resolveTitleOffset();

        this._tooltipText = options.tooltip ?? '';
        this._onClick = options.onClick ?? null;
        this._onHover = options.onHover ?? null;
    }

    // =================================================================
    // Хуки SpatialObject
    // =================================================================

    protected _onAttached(map: any): void {
        this._crs = this._crsCode ? Projections.get(this._crsCode) : map.inputCRS;

        this._projectedCache = null;
        this._fullLineData = null;
        this._simplifyCache.clear();
        this._localOriginValid = false;
        this._ensureLocalOrigin();

        if (this._rebuildTimer) {
            clearTimeout(this._rebuildTimer);
            this._rebuildTimer = null;
        }
        this._pendingBucket = -1;
        this._pendingRebuild = false;

        this._geometry = new LineGeometry();
        const canvas = map.renderer.domElement;
        this._material = new LineMaterial({
            color: this._color,
            linewidth: this._width,
            opacity: this._opacity,
            transparent: this._opacity < 1,
            depthTest: this._depthTest,
            depthWrite: this._depthWrite,
            resolution: new THREE.Vector2(canvas.width, canvas.height),
            ...this._computeDashUniforms(),
        });

        this._line = new Line2(this._geometry, this._material);
        this._line.position.copy(this._localOrigin);
        this._line.renderOrder = 999;
        map.worldGroup.add(this._line);

        const initialBucket = this._simplify
            ? Math.floor(map.currentDiscreteZoom / this._simplifyZoomBucket)
            : -1;
        this._doRebuildForBucket(initialBucket);

        this._registerInteraction(map);
        this._isVisible = false;
    }

    protected _teardown(): void {
        if (this._rebuildTimer) {
            clearTimeout(this._rebuildTimer);
            this._rebuildTimer = null;
        }
        this._pendingBucket = -1;
        this._pendingRebuild = false;

        if (this._unregisterInteraction) {
            this._unregisterInteraction();
            this._unregisterInteraction = null;
        }
        if (this._line) {
            this._line.parent?.remove(this._line);
            this._geometry?.dispose();
            this._material?.dispose();
            this._line = null;
            this._geometry = null;
            this._material = null;
        }
        this._crs = null;
        this._screenData.valid = false;
        this._screenData.points3D = null;
        this._screenData.segLengths = null;
        this._screenData.map = null;
        this._screenData.camera = null;
        this._labelPrefixSums = null;
        this._projectedCache = null;
        this._fullLineData = null;
        this._simplifyCache.clear();
        this._currentSimplifyBucket = -1;
        this._absPositions = [];
        this._nodeHeights = [];
        this._cachedHeights = null;
        this._heightsFinalized = false;
        this._positionsDirty = true;
        this._bsCache = null;
        this._localOriginValid = false;
    }

    protected _applyHidden(): void {
        if (this._line) this._line.visible = false;
        this._screenData.valid = false;
        this._labelPrefixSums = null;
    }

    protected _onTooltipChanged(): void {
        if (this._map) this._registerInteraction(this._map);
    }

    protected _onAltitudeChanged(): void {
        this._cachedHeights = null;
        this._heightsFinalized = false;
        this._lastHeightUpdateTime = 0;
        this._screenData.valid = false;
        this._labelPrefixSums = null;
        this._positionsDirty = true;
        this._bsCache = null;
    }

    getLabelType(): 'line' { return 'line'; }

    override getTitleVerticalAlign(): PolylineTitleAlignV {
        return this._titleVerticalAlign || 'center';
    }

    override getScreenPosition(): { x: number; y: number } | null {
        return this.getScreenPositionAt(this._labelT);
    }

    // =================================================================
    // Локальный origin
    // =================================================================

    private _worldPerPixel(z: number): number {
        return this._map.WORLD_SIZE / (Math.pow(2, z) * this._map.TILE_PIXELS);
    }

    private _projectClamped(pt: PolylinePosition): [number, number] {
        const p = this._map.project(pt, this._crs);
        let x = p[0];
        let y = p[1];
        if (!Number.isFinite(x)) x = 0;
        if (!Number.isFinite(y)) y = 0;
        return [x, y];
    }

    private _getFullProjected(): [number, number][] {
        if (this._projectedCache) return this._projectedCache;
        const n = this._positions.length;
        const out: [number, number][] = new Array(n);
        for (let i = 0; i < n; i++) out[i] = this._projectClamped(this._positions[i]);
        this._projectedCache = out;
        return out;
    }

    /**
     * Считает среднее исходных проекций как локальный origin.
     * Идемпотентно; вычисляется один раз до сброса `_localOriginValid`.
     */
    private _ensureLocalOrigin(): void {
        if (this._localOriginValid) return;
        const projected = this._getFullProjected();
        if (!projected.length) {
            this._localOrigin.set(0, 0, 0);
            this._localOriginValid = true;
            return;
        }
        let sx = 0, sz = 0;
        for (let i = 0; i < projected.length; i++) {
            sx += projected[i][0];
            sz += projected[i][1];
        }
        this._localOrigin.set(sx / projected.length, 0, sz / projected.length);
        this._localOriginValid = true;
    }

    // =================================================================
    // LOD
    // =================================================================

    private _getFullLineData(): SimplifiedLineData {
        if (this._fullLineData) return this._fullLineData;
        const projected = this._getFullProjected();
        const n = this._positions.length;
        const abs: [number, number][] = new Array(n);
        const nodeH: number[] = new Array(n);
        for (let i = 0; i < n; i++) {
            abs[i] = projected[i];
            const h = this._positions[i][2];
            nodeH[i] = Number.isFinite(h) ? (h as number) : 0;
        }
        this._fullLineData = { abs, nodeH };
        return this._fullLineData;
    }

    private _getSimplifiedData(bucket: number): SimplifiedLineData {
        if (!this._simplify || !this._map || bucket < 0) {
            return this._getFullLineData();
        }
        const hit = this._simplifyCache.get(bucket);
        if (hit) return hit;

        const full = this._getFullLineData();
        const pts = full.abs;
        const n = pts.length;
        if (n < 3) {
            this._simplifyCache.set(bucket, full);
            return full;
        }

        const z = bucket * this._simplifyZoomBucket;
        const tolWorld = this._worldPerPixel(z) * this._simplifyTolerance;

        const isClosed =
            n >= 4 &&
            pts[0][0] === pts[n - 1][0] &&
            pts[0][1] === pts[n - 1][1];

        const keptIdx = isClosed
            ? simplifyRingIndices(pts, tolWorld)
            : douglasPeuckerIndices(pts, tolWorld);

        if ((isClosed && keptIdx.length < 3) || keptIdx.length < 2 || keptIdx.length === n) {
            this._simplifyCache.set(bucket, full);
            return full;
        }

        const abs: [number, number][] = new Array(keptIdx.length);
        const nodeH: number[] = new Array(keptIdx.length);
        for (let k = 0; k < keptIdx.length; k++) {
            const idx = keptIdx[k];
            abs[k] = pts[idx];
            nodeH[k] = full.nodeH[idx];
        }

        const result: SimplifiedLineData = { abs, nodeH };
        this._simplifyCache.set(bucket, result);
        return result;
    }

    private _doRebuildForBucket(bucket: number, data?: SimplifiedLineData): void {
        if (!this._map) return;
        this._pendingRebuild = false;
        this._currentSimplifyBucket = bucket;

        this._ensureLocalOrigin();
        if (this._line) this._line.position.copy(this._localOrigin);

        const resolved = data ?? this._getSimplifiedData(bucket);
        this._absPositions = resolved.abs;
        this._nodeHeights = resolved.nodeH;

        this._cachedHeights = null;
        this._heightsFinalized = false;
        this._lastHeightUpdateTime = 0;
        this._screenData.valid = false;
        this._labelPrefixSums = null;
        this._positionsDirty = true;
        this._bsCache = null;
    }

    private _onSimplifyBucketChange(bucket: number): void {
        if (bucket === this._currentSimplifyBucket) return;
        const prevCount = this._absPositions.length;
        const data = this._getSimplifiedData(bucket);
        if (prevCount > 0 && data.abs.length === prevCount && this._currentSimplifyBucket >= 0) {
            this._currentSimplifyBucket = bucket;
            return;
        }
        if (!this._isVisible) {
            this._pendingRebuild = true;
            return;
        }
        this._doRebuildForBucket(bucket, data);
    }

    private _scheduleBucketChange(bucket: number): void {
        if (this._rebuildTimer) {
            this._pendingBucket = bucket;
            return;
        }
        this._pendingBucket = bucket;
        this._rebuildTimer = setTimeout(() => {
            this._rebuildTimer = null;
            if (!this._map) return;
            const b = this._pendingBucket;
            this._pendingBucket = -1;
            if (b >= 0 && b !== this._currentSimplifyBucket) {
                this._onSimplifyBucketChange(b);
            }
        }, REBUILD_DEBOUNCE_MS);
    }

    // =================================================================
    // Интерактив
    // =================================================================

    private _registerInteraction(map: any): void {
        if (!map.interaction || typeof map.interaction.register !== 'function') return;
        if (this._unregisterInteraction) {
            this._unregisterInteraction();
            this._unregisterInteraction = null;
        }
        if (!this._onClick && !this._onHover && !this._tooltipText) return;

        this._unregisterInteraction = map.interaction.register(this, {
            getMeshes: () => this._line ? [this._line] : [],
            getBoundingSphere: () => {
                if (this._absPositions.length === 0) return null;

                let c = this._bsCache;
                if (!c) {
                    let minX = Infinity, minY = Infinity, minZ = Infinity;
                    let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
                    for (let i = 0; i < this._absPositions.length; i++) {
                        const [ax, az] = this._absPositions[i];
                        const y = this._cachedHeights?.[i] ?? this._altitude;
                        if (ax < minX) minX = ax;
                        if (ax > maxX) maxX = ax;
                        if (y < minY) minY = y;
                        if (y > maxY) maxY = y;
                        if (az < minZ) minZ = az;
                        if (az > maxZ) maxZ = az;
                    }
                    if (!isFinite(minX)) return null;
                    const dx = maxX - minX, dy = maxY - minY, dz = maxZ - minZ;
                    c = this._bsCache = {
                        cx: (minX + maxX) / 2,
                        cy: (minY + maxY) / 2,
                        cz: (minZ + maxZ) / 2,
                        r: 0.5 * Math.sqrt(dx * dx + dy * dy + dz * dz),
                    };
                }
                const wgPos = map.worldGroup.position;
                return {
                    center: map.getVec3().set(c.cx + wgPos.x, c.cy + wgPos.y, c.cz + wgPos.z),
                    radius: c.r,
                };
            },
            onHover: this._onHover || null,
            onClick: this._onClick || null,
            getTooltip: this._tooltipText ? () => this._tooltipText : null,
            isVisible: () => this._line?.visible ?? false,
        });
    }

    // =================================================================
    // Стиль
    // =================================================================

    setColor(color: string | number): this {
        this._color = color;
        if (this._material?.color) this._material.color.set(color as any);
        return this;
    }
    getColor(): string | number { return this._color; }

    setWidth(width: number): this {
        if (!(width > 0)) return this;
        this._width = width;
        if (this._material) {
            this._material.linewidth = width;
            this._material.needsUpdate = true;
        }
        return this;
    }
    getWidth(): number { return this._width; }

    setOpacity(opacity: number): this {
        const v = Math.max(0, Math.min(1, opacity));
        this._opacity = v;
        if (this._material) {
            this._material.opacity = v;
            const transparent = v < 1;
            if (this._material.transparent !== transparent) {
                this._material.transparent = transparent;
                this._material.needsUpdate = true;
            }
        }
        return this;
    }
    getOpacity(): number { return this._opacity; }

    // =================================================================
    // Dash
    // =================================================================

    setLineDasharray(dasharray: LineDasharray | null): this {
        this._lineDasharray = dasharray;
        if (!this._material) return this;

        const u = this._computeDashUniforms();
        this._material.dashed = u.dashed ?? false;
        if (u.dashSize !== undefined)   this._material.dashSize = u.dashSize;
        if (u.gapSize !== undefined)    this._material.gapSize = u.gapSize;
        if (u.dashOffset !== undefined) this._material.dashOffset = u.dashOffset;
        this._material.needsUpdate = true;
        return this;
    }

    getLineDasharray(): LineDasharray | null {
        if (this._lineDasharray == null) return null;
        return Array.isArray(this._lineDasharray)
            ? [this._lineDasharray[0], this._lineDasharray[1]]
            : this._lineDasharray;
    }

    setLineDashOffset(offset: number): this {
        if (!Number.isFinite(offset)) return this;
        this._lineDashOffset = offset;
        if (this._material) {
            this._material.dashOffset = offset;
            this._material.needsUpdate = true;
        }
        return this;
    }
    getLineDashOffset(): number { return this._lineDashOffset; }

    // =================================================================
    // Altitude / Depth
    // =================================================================

    setAltitudeMode(mode: PolylineAltitudeMode): this {
        this._altitudeMode = mode;
        this._onAltitudeChanged();
        return this;
    }
    getAltitudeMode(): PolylineAltitudeMode { return this._altitudeMode; }

    /** @deprecated Используйте унаследованный `setAltitude`. */
    setAltitudeOffset(offset: number): this { return this.setAltitude(offset); }
    /** @deprecated Используйте унаследованный `getAltitude`. */
    getAltitudeOffset(): number { return this.getAltitude(); }

    setDepthTest(depthTest: boolean): this {
        this._depthTest = !!depthTest;
        if (this._material) {
            this._material.depthTest = this._depthTest;
            this._material.needsUpdate = true;
        }
        return this;
    }
    getDepthTest(): boolean { return this._depthTest; }

    setDepthWrite(depthWrite: boolean): this {
        this._depthWrite = !!depthWrite;
        if (this._material) {
            this._material.depthWrite = this._depthWrite;
            this._material.needsUpdate = true;
        }
        return this;
    }
    getDepthWrite(): boolean { return this._depthWrite; }

      getCRS(): string | null { return this._crsCode; }

    // =================================================================
    // LOD (публичный API)
    // =================================================================

    setSimplify(on: boolean): this {
        this._simplify = !!on;
        this._simplifyCache.clear();
        this._currentSimplifyBucket = -1;
        this._pendingBucket = -1;
        this._pendingRebuild = false;
        if (this._rebuildTimer) {
            clearTimeout(this._rebuildTimer);
            this._rebuildTimer = null;
        }
        if (this._map) {
            const b = this._simplify
                ? Math.floor(this._map.currentDiscreteZoom / this._simplifyZoomBucket)
                : -1;
            this._doRebuildForBucket(b);
        }
        return this;
    }
    getSimplify(): boolean { return this._simplify; }

    setSimplifyTolerance(t: number): this {
        if (!(t >= 0) || !Number.isFinite(t)) return this;
        this._simplifyTolerance = t;
        this._simplifyCache.clear();
        this._currentSimplifyBucket = -1;
        if (this._map) {
            const b = this._simplify
                ? Math.floor(this._map.currentDiscreteZoom / this._simplifyZoomBucket)
                : -1;
            this._doRebuildForBucket(b);
        }
        return this;
    }
    getSimplifyTolerance(): number { return this._simplifyTolerance; }

    setSimplifyZoomBucket(n: number): this {
        if (!(n > 0) || !Number.isFinite(n)) return this;
        this._simplifyZoomBucket = n;
        this._simplifyCache.clear();
        this._currentSimplifyBucket = -1;
        if (this._map) {
            const b = this._simplify
                ? Math.floor(this._map.currentDiscreteZoom / this._simplifyZoomBucket)
                : -1;
            this._doRebuildForBucket(b);
        }
        return this;
    }
    getSimplifyZoomBucket(): number { return this._simplifyZoomBucket; }

    // =================================================================
    // Позиции
    // =================================================================

    setPositions(positions: PolylinePosition[]): this {
        if (!positions || positions.length < 2) return this;
        this._positions = positions;
        this._screenData.valid = false;
        this._labelPrefixSums = null;
        this._projectedCache = null;
        this._fullLineData = null;
        this._localOriginValid = false;
        this._bsCache = null;

        if (this._rebuildTimer) {
            clearTimeout(this._rebuildTimer);
            this._rebuildTimer = null;
        }
        this._simplifyCache.clear();
        this._currentSimplifyBucket = -1;
        this._pendingBucket = -1;
        this._pendingRebuild = false;
        this._cachedHeights = null;
        this._heightsFinalized = false;
        this._lastHeightUpdateTime = 0;
        this._positionsDirty = true;

        if (!this._map) return this;

        const bucket = this._simplify
            ? Math.floor(this._map.currentDiscreteZoom / this._simplifyZoomBucket)
            : -1;
        this._doRebuildForBucket(bucket);

        return this;
    }

    getPositions(): PolylinePosition[] {
        return this._positions.map(p => [...p] as PolylinePosition);
    }

    getCenter(): LonLat | null {
        const b = this.getBounds('EPSG:4326');
        if (!b) return null;
        return [(b[0][0] + b[1][0]) / 2, (b[0][1] + b[1][1]) / 2];
    }

    // =================================================================
    // Обновление на кадре
    // =================================================================

    _update(map: any): void {
        if (!this._map || !this._line) return;

        this._applyZoomInterpolations(map.continuousZoom);

        if (!this._isWithinView()) {
            this._line.visible = false;
            this._isVisible = false;
            this._screenData.valid = false;
            this._labelPrefixSums = null;
            return;
        }

        if (this._line.parent !== this._map.worldGroup) {
            this._line.parent?.remove(this._line);
            this._map.worldGroup.add(this._line);
        }

        const canvas = this._map.renderer.domElement;
        const res = this._material.resolution;
        if (res.x !== canvas.width || res.y !== canvas.height) {
            this._material.resolution.set(canvas.width, canvas.height);
        }

        if (this._pendingRebuild) {
            const bucket = this._simplify
                ? Math.floor(map.currentDiscreteZoom / this._simplifyZoomBucket)
                : -1;
            this._doRebuildForBucket(bucket);
        }

        this._applySimplification(map.currentDiscreteZoom);
        this._updateHeights();

        // ── Distance check (голые числа, без Vector3) ──
        if (map.objectRenderDistanceFactor > 0 && this._absPositions.length >= 2) {
            const wgPos = map.worldGroup.position;
            const cam = map.camera.position;
            const pts = this._absPositions;
            const heights = this._cachedHeights;
            const alt = this._altitude;

            let prevX = pts[0][0] + wgPos.x;
            let prevY = (heights ? heights[0] : alt) + wgPos.y;
            let prevZ = pts[0][1] + wgPos.z;
            let minDistSq = Infinity;

            for (let i = 1; i < pts.length; i++) {
                const curX = pts[i][0] + wgPos.x;
                const curY = (heights ? heights[i] : alt) + wgPos.y;
                const curZ = pts[i][1] + wgPos.z;

                const abx = curX - prevX, aby = curY - prevY, abz = curZ - prevZ;
                const apx = cam.x - prevX, apy = cam.y - prevY, apz = cam.z - prevZ;
                const abLenSq = abx * abx + aby * aby + abz * abz;
                let t = abLenSq > 0 ? (apx * abx + apy * aby + apz * abz) / abLenSq : 0;
                if (t < 0) t = 0; else if (t > 1) t = 1;

                const dx = prevX + abx * t - cam.x;
                const dy = prevY + aby * t - cam.y;
                const dz = prevZ + abz * t - cam.z;
                const dSq = dx * dx + dy * dy + dz * dz;
                if (dSq < minDistSq) minDistSq = dSq;

                prevX = curX; prevY = curY; prevZ = curZ;
            }

            if (Math.sqrt(minDistSq) > map.maxObjectDistance) {
                this._line.visible = false;
                this._isVisible = false;
                this._screenData.valid = false;
                this._labelPrefixSums = null;
                return;
            }
        }

        if (!this._applyPositions()) {
            this._isVisible = false;
            this._screenData.valid = false;
            this._labelPrefixSums = null;
            return;
        }
        if (this._title) this._computeScreenData();

        this._line.visible = true;
        this._isVisible = true;
    }

    private _updateHeights(): void {
        if (!this._map) return;
        const isDynamic = this._map.hasElevation && this._altitudeMode === 'clampToGround';
        if (!isDynamic && this._heightsFinalized && this._cachedHeights) return;

        const now = performance.now();
        if (now - this._lastHeightUpdateTime < this._heightUpdateInterval && this._cachedHeights) return;

        const wgPos = this._map.worldGroup.position;
        const n = this._absPositions.length;
        const prev = this._cachedHeights;
        const heights = new Array<number>(n);
        const ensured = isDynamic ? new Set<string>() : null;
        let changed = !prev || prev.length !== n;

        for (let i = 0; i < n; i++) {
            const [absX, absZ] = this._absPositions[i];
            const nodeH = Number.isFinite(this._nodeHeights[i]) ? this._nodeHeights[i] : 0;
            let y: number;

            if (isDynamic) {
                const worldX = absX + wgPos.x;
                const worldZ = absZ + wgPos.z;
                if (ensured) {
                    const k = ((worldX / 500) | 0) + ',' + ((worldZ / 500) | 0);
                    if (!ensured.has(k)) {
                        ensured.add(k);
                        this._map.ensureTileForPoint?.(worldX, worldZ);
                    }
                }
                let surfaceY = this._map.getSurfaceHeightAt(worldX, worldZ);
                if (!Number.isFinite(surfaceY)) surfaceY = 0;
                y = surfaceY + this._altitude + nodeH;
            } else {
                y = this._altitude + nodeH;
            }

            const finalY = Number.isFinite(y) ? y : this._altitude;
            heights[i] = finalY;
            if (!changed && prev![i] !== finalY) changed = true;
        }

        this._cachedHeights = heights;
        this._lastHeightUpdateTime = now;
        if (!isDynamic) this._heightsFinalized = true;
        if (changed) {
            this._positionsDirty = true;
            this._bsCache = null;
        }
    }

    private _applySimplification(zoom: number): void {
        if (!this._simplify || !this._map) return;
        const bucket = Math.floor(zoom / this._simplifyZoomBucket);
        if (bucket === this._currentSimplifyBucket) return;

        if (this._map._zoomActive || this._map._cameraAnimation) {
            this._scheduleBucketChange(bucket);
            return;
        }
        this._doRebuildForBucket(bucket);
    }

    private _applyPositions(): boolean {
        if (!this._map || !this._cachedHeights) return false;
        if (!this._positionsDirty) {
            return (this._geometry?.attributes?.instanceStart?.count ?? 0) >= 1;
        }

        this._ensureLocalOrigin();
        const ox = this._localOrigin.x;
        const oz = this._localOrigin.z;

        const n = this._absPositions.length;
        const arr = new Float32Array(n * 3);
        let k = 0;
        let lastFx = NaN, lastFy = NaN, lastFz = NaN;

        for (let i = 0; i < n; i++) {
            const p = this._absPositions[i];
            let x = p[0] - ox;
            let y = this._cachedHeights[i];
            let z = p[1] - oz;
            if (!Number.isFinite(x)) x = 0;
            if (!Number.isFinite(y)) y = this._altitude;
            if (!Number.isFinite(z)) z = 0;

            const fx = Math.fround(x);
            const fy = Math.fround(y);
            const fz = Math.fround(z);
            if (fx === lastFx && fy === lastFy && fz === lastFz) continue;

            arr[k] = fx;
            arr[k + 1] = fy;
            arr[k + 2] = fz;
            k += 3;
            lastFx = fx; lastFy = fy; lastFz = fz;
        }

        if (k < 6) {
            this._line.visible = false;
            this._positionsDirty = false;
            return false;
        }

        const finalArr = k === arr.length ? arr : arr.slice(0, k);

        // КРИТИЧНО: пересоздаём LineGeometry при обновлении буфера.
        // Иначе Three.js сохраняет старый geometry._maxInstanceCount через Math.min(...),
        // и при приближении рисует только то число сегментов, которое было на дальнем зуме.
        if (this._geometry) {
            this._geometry.dispose();
        }
        this._geometry = new LineGeometry();
        this._geometry.setPositions(finalArr);
        this._line.geometry = this._geometry;
        this._line.computeLineDistances();
        this._positionsDirty = false;
        return true;
    }

    private _computeDashUniforms(): {
        dashed?: boolean;
        dashSize?: number;
        gapSize?: number;
        dashOffset?: number;
    } {
        const da = this._lineDasharray;
        if (da == null) return {};
        const [dashSize, gapSize] = typeof da === 'number'
            ? [da, da]
            : [da[0], da[1]];
        return { dashed: true, dashSize, gapSize, dashOffset: this._lineDashOffset };
    }

    // =================================================================
    // Экранные данные для подписи
    // =================================================================

    private _computeScreenData(): void {
        const map = this._map;
        if (!map) { this._screenData.valid = false; this._labelPrefixSums = null; return; }

        const wgPos = map.worldGroup.position;
        const camera = map.camera;
        const pts = this._absPositions;
        const n = pts.length;
        if (n < 2) { this._screenData.valid = false; this._labelPrefixSums = null; return; }

        const points3D: any[] = new Array(n);
        for (let i = 0; i < n; i++) {
            const [ax, az] = pts[i];
            let y = this._altitude + (this._nodeHeights[i] ?? 0);
            if (this._cachedHeights) y = this._cachedHeights[i];
            points3D[i] = new THREE.Vector3(ax + wgPos.x, y + wgPos.y, az + wgPos.z);
        }

        const segLengths = new Array<number>(n - 1);
        const prefix = new Array<number>(n - 1);
        let totalLen = 0;
        for (let i = 0; i < n - 1; i++) {
            prefix[i] = totalLen;
            const d = points3D[i].distanceTo(points3D[i + 1]);
            segLengths[i] = d;
            totalLen += d;
        }
        if (totalLen < 1e-9) {
            this._screenData.valid = false;
            this._labelPrefixSums = null;
            return;
        }

        const world = this._tmpLabelWorld;
        const scr = this._tmpLabelScreen;

        const findSeg = (target: number): number => {
            let lo = 0, hi = segLengths.length - 1;
            while (lo < hi) {
                const mid = (lo + hi + 1) >> 1;
                if (prefix[mid] <= target) lo = mid; else hi = mid - 1;
            }
            return lo;
        };

        const samples = 200;
        const visibleTs: number[] = [];
        for (let i = 0; i < samples; i++) {
            const t = i / (samples - 1);
            const target = t * totalLen;
            const segIdx = findSeg(target);
            const segLen = segLengths[segIdx];
            const local = segLen > 0 ? (target - prefix[segIdx]) / segLen : 0;
            world.lerpVectors(points3D[segIdx], points3D[segIdx + 1], local);

            scr.copy(world).project(camera);
            if (scr.z > 0 && scr.z < 1 &&
                scr.x >= -1 && scr.x <= 1 &&
                scr.y >= -1 && scr.y <= 1) {
                visibleTs.push(t);
            }
        }

        if (visibleTs.length === 0) {
            this._screenData.valid = false;
            this._labelPrefixSums = null;
            return;
        }

        const segments: Array<{ min: number; max: number }> = [];
        let start = visibleTs[0];
        let prev = start;
        const eps = 1.1 / (samples - 1);
        for (let i = 1; i < visibleTs.length; i++) {
            if (visibleTs[i] - prev > eps) {
                segments.push({ min: start, max: prev });
                start = visibleTs[i];
            }
            prev = visibleTs[i];
        }
        segments.push({ min: start, max: prev });

        let best = segments[0];
        for (const s of segments) {
            if (s.max - s.min > best.max - best.min) best = s;
        }

        this._screenData = {
            points3D, segLengths, totalLen,
            visibleInterval: best, camera, map, valid: true,
        };
        this._labelPrefixSums = prefix;

        if (this._labelT < best.min || this._labelT > best.max) {
            this._labelT = (best.min + best.max) / 2;
        }
    }

    // =================================================================
    // Подпись
    // =================================================================

    getVisibleInterval(): { min: number; max: number } | null {
        return this._screenData.valid ? this._screenData.visibleInterval : null;
    }

    getScreenPositionAt(t: number): { x: number; y: number } | null {
        const data = this._screenData;
        if (!data.valid || !data.map) return null;
        const prefix = this._labelPrefixSums;
        if (!prefix) return null;

        const target = t * data.totalLen;
        const segLengths = data.segLengths!;
        const points3D = data.points3D!;

        let lo = 0, hi = segLengths.length - 1;
        while (lo < hi) {
            const mid = (lo + hi + 1) >> 1;
            if (prefix[mid] <= target) lo = mid; else hi = mid - 1;
        }
        const segLen = segLengths[lo];
        const local = segLen > 0 ? (target - prefix[lo]) / segLen : 0;

        const world = this._tmpLabelWorld;
        world.lerpVectors(points3D[lo], points3D[lo + 1], local);

        const scr = this._tmpLabelScreen.copy(world).project(data.camera);
        if (scr.z <= 0 || scr.z >= 1) return null;
        const canvas = data.map.renderer.domElement;
        return {
            x: (scr.x * 0.5 + 0.5) * canvas.clientWidth,
            y: (-scr.y * 0.5 + 0.5) * canvas.clientHeight,
        };
    }

    getScreenAngleAt(t: number): number {
        if (this._titlePlacement !== 'along') return 0;
        const data = this._screenData;
        if (!data.valid) return 0;

        const segIdx = this._getSegmentIndex(t);
        const points3D = data.points3D!;
        if (segIdx < 0 || segIdx >= points3D.length - 1) return 0;

        const p1 = points3D[segIdx];
        const p2 = points3D[segIdx + 1];
        const s1 = this._tmpLabelScreen.copy(p1).project(data.camera);
        const s2 = this._tmpLabelScreen2.copy(p2).project(data.camera);
        if (s1.z <= 0 || s2.z <= 0) return 0;

        const W = data.map.renderer.domElement.clientWidth;
        const H = data.map.renderer.domElement.clientHeight;
        const x1 = (s1.x * 0.5 + 0.5) * W;
        const y1 = (-s1.y * 0.5 + 0.5) * H;
        const x2 = (s2.x * 0.5 + 0.5) * W;
        const y2 = (-s2.y * 0.5 + 0.5) * H;
        let angle = Math.atan2(y2 - y1, x2 - x1) * 180 / Math.PI;
        if (angle > 90) angle -= 180;
        else if (angle < -90) angle += 180;
        return angle;
    }

    private _getSegmentIndex(t: number): number {
        const data = this._screenData;
        if (!data.valid) return -1;
        const prefix = this._labelPrefixSums;
        if (!prefix) return -1;
        const target = t * data.totalLen;
        const segLengths = data.segLengths!;
        let lo = 0, hi = segLengths.length - 1;
        while (lo < hi) {
            const mid = (lo + hi + 1) >> 1;
            if (prefix[mid] <= target) lo = mid; else hi = mid - 1;
        }
        return lo;
    }

    getLabelParameter(): number { return this._labelT; }

    setLabelParameter(t: number): void {
        const iv = this.getVisibleInterval();
        if (iv) this._labelT = Math.max(iv.min, Math.min(iv.max, t));
        else this._labelT = t;
    }

    getPlacement(): PolylineTitlePlacement { return this._titlePlacement; }

    // =================================================================
    // KrbMap#fitTo / getBounds
    // =================================================================

    getBounds(crs: string | any = 'EPSG:4326'): [LonLat, LonLat] | null {
        if (!this._positions || !this._positions.length) return null;

        const src = this._crs
            ?? (this._crsCode ? Projections.get(this._crsCode) : Projections.get('EPSG:4326'));
        const dst = typeof crs === 'string' ? Projections.get(crs) : crs;
        if (!src || !dst) return null;

        const sameProjection = src === dst;
        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
        let count = 0;

        for (let i = 0; i < this._positions.length; i++) {
            const pt = this._positions[i];
            if (!pt || pt.length < 2) continue;
            let x: number, y: number;
            if (sameProjection) {
                x = pt[0]; y = pt[1];
            } else {
                const lonLat = src.toLonLat(pt);
                const conv = dst.fromLonLat(lonLat);
                x = conv[0]; y = conv[1];
            }
            if (x < minX) minX = x;
            if (x > maxX) maxX = x;
            if (y < minY) minY = y;
            if (y > maxY) maxY = y;
            count++;
        }
        if (count === 0 || !isFinite(minX)) return null;
        return [[minX, minY], [maxX, maxY]];
    }

    debugDump(): void {
        const map = this._map;
        const line = this._line;
        const geo = this._geometry;
        const mat = this._material;
        const abs = this._absPositions;

        // ── 1. LOD-состояние ──
        const lod = {
            simplify: this._simplify,
            tolerance: this._simplifyTolerance,
            zoomBucket: this._simplifyZoomBucket,
            currentBucket: this._currentSimplifyBucket,
            pendingBucket: this._pendingBucket,
            mapZoom: map?.currentDiscreteZoom,
            mapZoomContinuous: map?.continuousZoom,
            originalCount: this._positions.length,
            simplifiedCount: abs.length,
        };

        // ── 2. Проверка направления DP ──
        const dpCheck: Record<string, number> = {};
        const dpOrder: Record<string, string> = {};
        if (map && this._simplify) {
            const z0 = Math.max(0, Math.floor(map.currentDiscreteZoom) - 2);
            const full = this._getFullProjected();
            const isClosed =
                full.length >= 4 &&
                full[0][0] === full[full.length - 1][0] &&
                full[0][1] === full[full.length - 1][1];
            for (const b of [z0, z0 + 1, z0 + 2, z0 + 3, z0 + 4, z0 + 5, z0 + 6]) {
                const tolWorld = this._worldPerPixel(b * this._simplifyZoomBucket) * this._simplifyTolerance;
                const kept = isClosed
                    ? simplifyRingIndices(full, tolWorld)
                    : douglasPeuckerIndices(full, tolWorld);
                dpCheck['b' + b] = kept.length;
                dpOrder['b' + b] = kept.slice(0, 12).join(',') +
                    (kept.length > 12 ? ',…' : '') +
                    (kept.every((v, i) => i === 0 || v > kept[i - 1]) ? '  [mono✓]' : '  [МОНОТОННОСТЬ НАРУШЕНА ❌]');
            }
        }

        // ── 3. Здоровье _absPositions ──
        let nanAbs = 0, zeroAbsSeg = 0, minAbsSeg = Infinity, maxAbsSeg = 0, totalLen = 0;
        for (let i = 0; i < abs.length; i++) {
            if (!Number.isFinite(abs[i][0]) || !Number.isFinite(abs[i][1])) nanAbs++;
        }
        for (let i = 1; i < abs.length; i++) {
            const d = Math.hypot(abs[i][0] - abs[i - 1][0], abs[i][1] - abs[i - 1][1]);
            if (d < 1e-9) zeroAbsSeg++;
            if (d < minAbsSeg) minAbsSeg = d;
            if (d > maxAbsSeg) maxAbsSeg = d;
            totalLen += d;
        }

        // ── 4. Здоровье Line2-буфера ──
        let instCount = 0, geoNaN = 0, geoZero = 0, geoMinLen = Infinity;
        if (geo) {
            const sA = geo.attributes?.instanceStart, eA = geo.attributes?.instanceEnd;
            if (sA && eA) {
                instCount = sA.count;
                const s = sA.array as Float32Array, e = eA.array as Float32Array;
                for (let k = 0; k < instCount; k++) {
                    const sx = s[k * 3], sy = s[k * 3 + 1], sz = s[k * 3 + 2];
                    const ex = e[k * 3], ey = e[k * 3 + 1], ez = e[k * 3 + 2];
                    if (![sx, sy, sz, ex, ey, ez].every(Number.isFinite)) { geoNaN++; continue; }
                    const dx = ex - sx, dy = ey - sy, dz = ez - sz;
                    const len = Math.sqrt(dx * dx + dy * dy + dz * dz);
                    if (len === 0) geoZero++;
                    if (len < geoMinLen) geoMinLen = len;
                }
            }
        }

        // ── 5. Материал и объект ──
        const objInfo = line ? {
            visible: line.visible,
            inWorldGroup: line.parent === map?.worldGroup,
            position: [line.position.x.toFixed(1), line.position.y.toFixed(1), line.position.z.toFixed(1)],
            frustumCulled: line.frustumCulled,
            renderOrder: line.renderOrder,
        } : null;
        const matInfo = mat ? {
            opacity: mat.opacity, linewidth: mat.linewidth,
            dashed: mat.dashed, transparent: mat.transparent,
            depthTest: mat.depthTest, depthWrite: mat.depthWrite,
            resolution: mat.resolution ? [mat.resolution.x, mat.resolution.y] : null,
            visible: mat.visible,
        } : null;

        console.groupCollapsed(
            `%c[Polyline] z=${lod.mapZoom} bucket=${lod.currentBucket} ` +
            `orig=${lod.originalCount} simp=${lod.simplifiedCount} inst=${instCount}`,
            'color:#3af;font-weight:bold');

        console.log('%c1. LOD state', 'color:#3af;font-weight:bold', lod);
        console.log('%c2. DP при разных bucket (ОЖИДАНИЕ: с ростом bucket точек БОЛЬШЕ)', 'color:#3af;font-weight:bold', dpCheck);
        console.log('%c   Порядок индексов DP (первые 12):', 'color:#3af', dpOrder);
        console.log('%c3. _absPositions', 'color:#3af;font-weight:bold',
            { nanAbs, zeroAbsSeg, minAbsSeg: +minAbsSeg.toFixed(3), maxAbsSeg: +maxAbsSeg.toFixed(3), totalLen: +totalLen.toFixed(1) });
        console.log('%c4. Line2 буфер', 'color:#3af;font-weight:bold',
            {
                instances: instCount,
                maxInstanceCount: (geo as any)?._maxInstanceCount,
                expected: abs.length - 1,
                missing: (abs.length - 1) - instCount,
                geoNaN,
                geoZero,
                geoMinLen: +geoMinLen.toFixed(6),
            });
        console.log('%c5. Object', 'color:#3af;font-weight:bold', objInfo);
        console.log('%c6. Material', 'color:#3af;font-weight:bold', matInfo);

        // ── Автоматический вердикт ──
        if (geoNaN > 0) console.error(`❌ ${geoNaN} NaN-сегментов в Line2 — источник «крошек»`);
        if (geoZero > 0) console.error(`❌ ${geoZero} нулевых сегментов в Line2 → NaN в шейдере`);
        if (instCount !== abs.length - 1) console.error(`❌ Буфер Line2 рассинхронизирован с _absPositions (${instCount} vs ${abs.length - 1})`);
        const keys = Object.keys(dpCheck);
        if (keys.length >= 2) {
            const first = dpCheck[keys[0]], last = dpCheck[keys[keys.length - 1]];
            if (last < first) console.error(`❌ ИНВЕРСИЯ DP: b${keys[0]}→${first}, b${keys[keys.length - 1]}→${last}. Чем ближе, тем меньше точек.`);
            if (Object.values(dpOrder).some(v => v.includes('❌'))) console.error(`❌ DP возвращает индексы не по порядку`);
        }
        console.groupEnd();
    }

    debugToggleSimplify(on: boolean): void {
        this.setSimplify(on);
        console.log(`[Polyline] simplify = ${on}`);
    }

    debugSegmentRange(from: number, to: number): void {
        const geo = this._geometry;
        if (!geo) return console.log('no geometry');
        const sA = geo.attributes?.instanceStart, eA = geo.attributes?.instanceEnd;
        if (!sA || !eA) return console.log('no instance attributes');
        const s = sA.array as Float32Array, e = eA.array as Float32Array;
        const rows: any[] = [];
        for (let k = from; k < Math.min(to, sA.count); k++) {
            const sx = s[k * 3], sy = s[k * 3 + 1], sz = s[k * 3 + 2];
            const ex = e[k * 3], ey = e[k * 3 + 1], ez = e[k * 3 + 2];
            const len = Math.hypot(ex - sx, ey - sy, ez - sz);
            rows.push({
                i: k, len: +len.toFixed(4),
                start: [sx, sy, sz].map(v => v.toFixed(1)).join(','),
                end: [ex, ey, ez].map(v => v.toFixed(1)).join(','),
                bad: !Number.isFinite(len) || len === 0,
            });
        }
        console.table(rows);
    }
}