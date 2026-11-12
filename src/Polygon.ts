/**
 * Polygon — полигон с заливкой, обводкой, экструзией, паттерном и подписью.
 * LOD-упрощение по зуму: Douglas–Peucker в world-координатах, кэш по бакетам.
 *
 * @module polygon
 */

import { Projections } from './Projections.js';
import { THREE, Line2, LineMaterial, LineGeometry } from './js_TP/tpb.js';
import { SpatialObject, TitleAlignH, ZoomInterpolation } from './SpatialObject.js';
import earcut from './js_TP/earcut.js';
import { simplifyRingIndices } from './Simplify.js';

// =====================================================================
// Типы
// =====================================================================

export type LonLat = [number, number];
export type PolygonCoord = [number, number] | [number, number, number];
export type PolygonRing = PolygonCoord[];
export type TitleAlign = TitleAlignH;
export type AltitudeMode = 'clampToGround' | 'absolute';
export type FillPatternFit = 'tile' | 'bounds';
export type FillPatternSource = string | HTMLImageElement | HTMLCanvasElement | null;

export interface PolygonOptions {
    rings: PolygonRing[];
    crs?: string;
    fillColor?: string | number;
    fillOpacity?: number;
    fillPattern?: FillPatternSource;
    fillPatternScale?: number;
    fillPatternFit?: FillPatternFit;
    strokeColor?: string | number;
    strokeWidth?: number;
    strokeOpacity?: number;
    altitudeMode?: AltitudeMode;
    altitude?: number;
    altitudeOffset?: number;
    extruded?: boolean;
    height?: number;
    minHeight?: number;
    depthTest?: boolean;
    depthWrite?: boolean;
    castShadow?: boolean;
    receiveShadow?: boolean;
    roughness?: number;
    metalness?: number;
    minZoom?: number;
    maxZoom?: number;
    title?: string;
    titleOffset?: [number, number];
    titleAlign?: TitleAlign;
    titleStyle?: Record<string, string | number>;
    titleMinZoom?: number;
    titleMaxZoom?: number;
    titleAllowOverflow?: boolean;
    titlePriority?: number;
    onClick?: (event: MouseEvent, polygon: Polygon) => void;
    onHover?: (hovered: boolean) => void;
    tooltip?: string;
    useSimpleStroke?: boolean;
    useWorkerForTriangulation?: boolean;
    properties?: Record<string, any>;
    userData?: Record<string, any>;
    zoomInterpolate?: ZoomInterpolation | null;
    tooltipOnHover?: boolean;
    /** Включать LOD-упрощение по зуму. Default: true. */
    simplify?: boolean;
    /** Допуск в пикселях экрана (OL-подобно). Default: 0.5. */
    simplifyTolerance?: number;
    /** Размер бакета в уровнях зума (1 = каждый целый зум). Default: 1. */
    simplifyZoomBucket?: number;
}

export interface PolygonRenderOrder {
    BOTTOM: number; SIDE: number; TOP: number; STROKE: number;
}

export const POLYGON_RENDER_ORDER: PolygonRenderOrder = {
    BOTTOM: 900, SIDE: 901, TOP: 902, STROKE: 903,
};

const INVALID_EDGE_FRACTION = 8;
const DEFAULT_FILL_PATTERN_SCALE = 64;
/** Дебаунс пересборки при смене зум-бакета (мс). */
const REBUILD_DEBOUNCE_MS = 60; 
const _sharedPatternTextures = new Map<string, any>();

let _rebuildSlotCounter = 0;

function crossY(p0: any, p1: any, p2: any): number {
    const dx1 = p1.x - p0.x, dz1 = p1.y - p0.y;
    const dx2 = p2.x - p0.x, dz2 = p2.y - p0.y;
    return dz1 * dx2 - dx1 * dz2;
}

interface UVParams {
    originX: number; originZ: number; scaleX: number; scaleZ: number;
}

/**
 * Спроецированное кольцо с высотами узлов. Кэшируется по бакету,
 * используется и для заливки, и для обводки — `map.project` вызывается
 * ровно один раз на вершину на кольцо.
 */
interface RenderRing {
    worldCoords: [number, number][];
    heights: number[];
}

// =====================================================================
// Polygon
// =====================================================================

export class Polygon extends SpatialObject {
    // ── Кольца / CRS ──
    private _rings: PolygonRing[];
    private _crsCode: string | null;
    private _crs: any | null;
    private _ringStartIndices: number[] = [];

    // ── Оформление ──
    private _fillColor: string | number;
    private _fillOpacity: number;
    private _fillPatternSource: FillPatternSource;
    private _fillPatternScale: number;
    private _fillPatternFit: FillPatternFit;
    private _fillPatternTexture: any = null;
    private _fillPatternGeneration = 0;
    private _strokeColor: string | number;
    private _strokeWidth: number;
    private _strokeOpacity: number;
    private _altitudeMode: AltitudeMode;
    private _tooltipOnHover: boolean;

    // ── LOD ──
    private _simplify = true;
    private _simplifyTolerance = 0.5;
    private _simplifyZoomBucket = 1;
    private _simplifyCache = new Map<number, RenderRing[]>();
    private _renderRings: RenderRing[] | null = null;
    private _fullRenderRings: RenderRing[] | null = null;
    private _currentSimplifyBucket = -1;
    private _pendingBucket = -1;
    private _rebuildTimer: ReturnType<typeof setTimeout> | null = null;
    private _pendingRebuild = false; 

    /** Кэш визуального центра, считается один раз за жизнь полигона. */
    private _centroidFromOriginal: { x: number; z: number } | null = null;
    private _visualCenterCache: LonLat | null = null;

    // ── Экструзия ──
    private _extruded: boolean;
    private _height: number;
    private _minHeight: number;
    private _depthTest: boolean;
    private _depthWrite: boolean;
    private _castShadow: boolean;
    private _receiveShadow: boolean;
    private _roughness: number;
    private _metalness: number;

    private _useSimpleStroke: boolean;
    private _useWorkerForTriangulation: boolean;

    // ── Интерактив ──
    private _unregisterInteraction: (() => void) | null = null;

    // ── 3D-объекты ──
    private _group: any;
    private _fillMesh: any = null;
    private _fillGeometry: any = null;
    private _fillMaterial: any = null;
    private _bottomMesh: any = null;
    private _bottomGeometry: any = null;
    private _bottomMaterial: any = null;
    private _sideMesh: any = null;
    private _sideGeometry: any = null;
    private _sideMaterial: any = null;
    private _strokeLine: any = null;
    private _strokeGeometry: any = null;
    private _strokeMaterial: any = null;

    // ── Кэши ──
    private _cachedHeights: number[] = [];
    private _cachedStrokeHeights: number[] = [];
    /** Индексы триангуляции top-грани. Переживает `_disposeMeshes()`. */
    private _cachedTopIndices: number[] | null = null;
    private _nodeHeights: number[] = [];
    private _strokeNodeHeights: number[] = [];
    private _lastHeightUpdateTime = 0;
    private _heightUpdateInterval = 500;
    private _heightsFinalized = false;
    private _invalidGeometry = false;

    private _vertices2D: any[] = [];
    private _centroidWorld: any;
    private _cachedCentroidHeight = 0;
    private _lastCentroidHeightUpdateTime = 0;
    private _avgNodeHeight = 0;
    private _avgNodeHeightValid = false;

    private _worldCoords: Array<[number, number]> = [];
    private _strokeWorldCoords: Array<[number, number]> = [];

    _batch: any = null;

    private _sideEdgeIJ: Array<[number, number]> = [];
    private _sideEdgeLengths: number[] = [];
    private _builtSideHeight = -1;

    private _boundsCache = new Map<string, [LonLat, LonLat] | null>();

    private _boundingSphereRadius = 0;
    private _boundingSphereWorldCenter: any;
    private _raycastMeshesCache: any[] | null = null;

    private _heightsDirty = true;
    private _lastWorldGroupPos: any;
    private _lastDiscreteZoom = -1;

    private _centroidScreenPos: { x: number; y: number } | null = null;

    private _strokePositionsArray: number[] = [];

    constructor(options: PolygonOptions) {
        super();

        this._properties = options.properties ?? {};
        this._userData = options.userData ?? {};

        if (!options.rings || !options.rings.length || !options.rings[0].length) {
            throw new Error('Polygon: options.rings required with at least one ring');
        }

        this._rings = options.rings;
        this._simplify = options.simplify ?? true;
        this._simplifyTolerance = options.simplifyTolerance ?? 0.5;
        this._simplifyZoomBucket = options.simplifyZoomBucket ?? 1;

        this._crsCode = options.crs ?? null;
        this._crs = null;

        this._fillColor = options.fillColor ?? '#3388ff';
        this._fillOpacity = options.fillOpacity ?? 0.5;
        this._fillPatternSource = options.fillPattern ?? null;
        this._fillPatternScale = options.fillPatternScale ?? DEFAULT_FILL_PATTERN_SCALE;
        this._fillPatternFit = options.fillPatternFit ?? 'tile';
        this._strokeColor = options.strokeColor ?? '#000000';
        this._strokeWidth = options.strokeWidth ?? 2;
        this._strokeOpacity = options.strokeOpacity ?? 1;
        this._altitudeMode = options.altitudeMode ?? 'clampToGround';
        this._tooltipOnHover = options.tooltipOnHover ?? false;

        this._altitude = options.altitude ?? options.altitudeOffset ?? 10;

        this._extruded = options.extruded ?? false;
        this._height = options.height ?? 0;
        this._minHeight = options.minHeight ?? 0;
        if (this._extruded && (typeof this._height !== 'number' || this._height <= 0)) {
            throw new Error('Polygon: options.height must be a positive number when extruded is true');
        }

        this._depthTest = options.depthTest ?? this._extruded;
        this._depthWrite = options.depthWrite ?? this._extruded;

        this._minZoom = options.minZoom ?? -Infinity;
        this._maxZoom = options.maxZoom ?? Infinity;
        this._useSimpleStroke = options.useSimpleStroke ?? false;
        this._useWorkerForTriangulation = options.useWorkerForTriangulation ?? false;

        this._castShadow = options.castShadow ?? true;
        this._receiveShadow = options.receiveShadow ?? true;
        this._roughness = options.roughness ?? 0.8;
        this._metalness = options.metalness ?? 0.0;

        this._title = options.title ?? '';
        this._titleStyle = options.titleStyle ?? {};
        this._titleMinZoom = options.titleMinZoom ?? -Infinity;
        this._titleMaxZoom = options.titleMaxZoom ?? Infinity;
        this._titleAlign = options.titleAlign ?? 'center';
        this._userTitleOffset = options.titleOffset ? [...options.titleOffset] : null;
        this._titleAllowOverflow = options.titleAllowOverflow ?? false;
        this._titlePriority = options.titlePriority ?? 0;

        this._onClick = options.onClick ?? null;
        this._onHover = options.onHover ?? null;
        this._tooltipText = options.tooltip ?? '';

        if (options.zoomInterpolate) this.setZoomInterpolations(options.zoomInterpolate);

        this._group = new THREE.Group();
        this._centroidWorld = new THREE.Vector3();
        this._boundingSphereWorldCenter = new THREE.Vector3();
        this._lastWorldGroupPos = new THREE.Vector3();

        const initialLen = this._rings[0]?.length ?? 0;
        this._cachedHeights = new Array(initialLen).fill(0);
        this._cachedStrokeHeights = new Array(initialLen).fill(0);
    }

    // =================================================================
    // LOD-упрощение
    // =================================================================

    private _worldPerPixel(z: number): number {
        return this._map.WORLD_SIZE / (Math.pow(2, z) * this._map.TILE_PIXELS);
    }

    /** Проецирует все исходные кольца один раз и кэширует результат. */
    private _getFullRenderRings(): RenderRing[] {
        if (this._fullRenderRings) return this._fullRenderRings;
        const map = this._map;
        if (!map) return [];

        this._fullRenderRings = this._rings.map(ring => {
            const n = ring.length;
            const worldCoords: [number, number][] = new Array(n);
            const heights: number[] = new Array(n);
            for (let i = 0; i < n; i++) {
                const pt = ring[i];
                worldCoords[i] = map.project(pt, this._crs) as [number, number];
                const h = pt?.[2];
                heights[i] = Number.isFinite(h) ? (h as number) : 0;
            }
            return { worldCoords, heights };
        });
        return this._fullRenderRings;
    }

    /**
     * Возвращает кольца для указанного бакета. Первый вызов бакета
     * считает DP и кэширует; последующие — O(1). Дырки (ringIdx>0)
     * упрощаются с половинным допуском, чтобы не вылезли за контур.
     */
    private _getRenderRings(bucket: number): RenderRing[] {
        if (!this._simplify || !this._map || bucket < 0) {
            return this._getFullRenderRings();
        }
        if (bucket === this._currentSimplifyBucket && this._renderRings) {
            return this._renderRings;
        }

        const cached = this._simplifyCache.get(bucket);
        if (cached) {
            this._renderRings = cached;
            this._currentSimplifyBucket = bucket;
            return cached;
        }

        const z = bucket * this._simplifyZoomBucket;
        const tolWorld = this._worldPerPixel(z) * this._simplifyTolerance;
        const full = this._getFullRenderRings();

        const result: RenderRing[] = full.map((ring, ringIdx) => {
            const { worldCoords, heights } = ring;
            if (worldCoords.length < 4) return ring;

            const tol = ringIdx === 0 ? tolWorld : tolWorld * 0.5;
            const keptIdx = simplifyRingIndices(worldCoords, tol);
            if (keptIdx.length < 3 || keptIdx.length === worldCoords.length) {
                return ring;
            }

            const sWC: [number, number][] = new Array(keptIdx.length);
            const sH: number[] = new Array(keptIdx.length);
            for (let k = 0; k < keptIdx.length; k++) {
                sWC[k] = worldCoords[keptIdx[k]];
                sH[k] = heights[keptIdx[k]];
            }
            return { worldCoords: sWC, heights: sH };
        });

        this._simplifyCache.set(bucket, result);
        this._renderRings = result;
        this._currentSimplifyBucket = bucket;
        return result;
    }

    /** Сравнивает только количество вершин — при равенстве геометрия идентична. */
    private _sameRingCounts(a: RenderRing[], b: RenderRing[]): boolean {
        if (a.length !== b.length) return false;
        for (let i = 0; i < a.length; i++) {
            if (a[i].worldCoords.length !== b[i].worldCoords.length) return false;
        }
        return true;
    }

private _onSimplifyBucketChange(bucket: number): void {
    if (bucket === this._currentSimplifyBucket) return;

    const oldRings = this._renderRings;
    const newRings = this._getRenderRings(bucket);
    if (oldRings && this._sameRingCounts(oldRings, newRings)) return;
    if (!this._map) return;

    // NEW: для батченного полигона просто сбрасываем кэш и инвалидируем батч.
    // Батчер пересоберётся через markDirty (debounce 100ms), увидит новый
    // bucket в _getBatchStyleKey и создаст правильную геометрию.
    if (this._batch) {
        // нужно пересчитать _worldCoords / _nodeHeights / _cachedTopIndices
        // под новый бакет — иначе _getBatchGeometryData вернёт старые данные.
        this._refreshWorldCoordsForBatch();
        this._invalidateBatch();
        return;
    }

    if (!this._isVisible) {
        this._pendingRebuild = true;
        return;
    }
    this._rebuildGeometry();
}

/** Пересчитывает _worldCoords / _nodeHeights / _cachedTopIndices
 *  без создания мешей/материалов (для батченного полигона). */
private _refreshWorldCoordsForBatch(): void {
    if (!this._map) return;
    const rings = this._getRenderRings(this._currentSimplifyBucket);
    if (!rings || !rings.length) return;

    this._worldCoords.length = 0;
    this._nodeHeights.length = 0;
    this._ringStartIndices.length = 0;

    const coords: number[] = [];
    const holeIndices: number[] = [];

    for (let ringIdx = 0; ringIdx < rings.length; ringIdx++) {
        const { worldCoords, heights } = rings[ringIdx];
        if (worldCoords.length < 3) continue;
        this._ringStartIndices.push(this._worldCoords.length);
        if (ringIdx > 0) holeIndices.push(coords.length / 2);
        let firstPoint: [number, number] | null = null;
        for (let i = 0; i < worldCoords.length; i++) {
            const [absX, absZ] = worldCoords[i];
            if (i === 0) firstPoint = [absX, absZ];
            if (i > 0 && firstPoint && absX === firstPoint[0] && absZ === firstPoint[1]) continue;
            coords.push(absX - this._centroidWorld.x, absZ - this._centroidWorld.z);
            this._worldCoords.push([absX, absZ]);
            this._nodeHeights.push(heights[i] ?? 0);
        }
    }

    const indices = earcut(coords, holeIndices.length ? holeIndices : undefined, 2);
    if (indices.length === 0) { this._cachedTopIndices = null; return; }
    const p2d = new Array(this._worldCoords.length);
    for (let i = 0; i < this._worldCoords.length; i++) {
        p2d[i] = { x: coords[i * 2], y: coords[i * 2 + 1] };
    }
    const firstCrossY = crossY(p2d[indices[0]], p2d[indices[1]], p2d[indices[2]]);
    this._cachedTopIndices = firstCrossY >= 0 ? indices : this._flipIndices(indices);
}

private _scheduleBucketChange(bucket: number): void {
    if (this._rebuildTimer) {
        // Таймер уже тикает. Не сбрасываем — просто обновляем целевой бакет.
        // Он выстрелит через REBUILD_DEBOUNCE_MS от ПЕРВОГО запроса,
        // но пересоберёт актуальный (последний) бакет.
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
    // Хуки SpatialObject
    // =================================================================

    protected _onAttached(map: any): void {
        this._crs = this._crsCode ? Projections.get(this._crsCode) : map.inputCRS;

        this._loadFillPattern();

        this._currentSimplifyBucket =
            Math.floor(map.currentDiscreteZoom / this._simplifyZoomBucket);
        this._simplifyCache.clear();
        this._renderRings = null;
        this._fullRenderRings = null;
        this._centroidFromOriginal = null;

        this._buildFillGeometry(map);
        this._buildStrokeGeometry(map);
        map.worldGroup.add(this._group);

        this._registerInteraction(map);

        this._lastWorldGroupPos.copy(map.worldGroup.position);
        this._lastDiscreteZoom = map.currentDiscreteZoom;
        this._heightsDirty = true;
        this._heightsFinalized = false;
        this._lastHeightUpdateTime = 0;
        this._lastCentroidHeightUpdateTime = 0;

         (this._layer as any)?._polygonBatcher?.markDirty?.();
    }

    protected _teardown(): void {
        this._fillPatternGeneration++;

        if (this._rebuildTimer) {
            clearTimeout(this._rebuildTimer);
            this._rebuildTimer = null;
        }
        this._pendingBucket = -1;
        this._pendingRebuild = false; 

  if (this._batch) {
        (this._layer as any)?._polygonBatcher?.markDirty?.();
    }

        if (this._batch) {
            const b: any = this._batch;
            this._batch = null;
            b.__batcher?.markDirty?.();
        }

        if (this._unregisterInteraction) {
            this._unregisterInteraction();
            this._unregisterInteraction = null;
        }
        this._disposeMeshes();
        if (this._group.parent) this._group.parent.remove(this._group);

        if (this._fillPatternTexture) {
            try { this._fillPatternTexture.dispose?.(); } catch { /* swallow */ }
            this._fillPatternTexture = null;
        }

        this._worldCoords.length = 0;
        this._strokeWorldCoords.length = 0;
        this._nodeHeights.length = 0;
        this._strokeNodeHeights.length = 0;
        this._ringStartIndices.length = 0;
        this._cachedTopIndices = null;
        this._sideEdgeIJ.length = 0;
        this._sideEdgeLengths.length = 0;
        this._builtSideHeight = -1;
        this._vertices2D = [];
        this._boundingSphereRadius = 0;
        this._cachedHeights = [];
        this._cachedStrokeHeights = [];
        this._raycastMeshesCache = null;
        this._invalidGeometry = false;
        this._centroidScreenPos = null;
        this._avgNodeHeightValid = false;
        this._boundsCache.clear();
        this._simplifyCache.clear();
        this._renderRings = null;
        this._fullRenderRings = null;
        this._currentSimplifyBucket = -1;
        this._centroidFromOriginal = null;
        this._crs = null;
    }

    protected _applyHidden(): void {
        if (this._group) this._group.visible = false;
        this._centroidScreenPos = null;
    }

    protected _onTooltipChanged(): void {
        if (this._map) this._registerInteraction(this._map);
    }

    protected _onAltitudeChanged(): void {
        this._heightsDirty = true;
        this._heightsFinalized = false;
        this._lastHeightUpdateTime = 0;
        this._lastCentroidHeightUpdateTime = 0;
    }

    getLabelType(): 'polygon' { return 'polygon'; }

    getScreenPosition(): { x: number; y: number } | null {
        return this._isVisible ? this._centroidScreenPos : null;
    }

    // =================================================================
    // Batch hooks
    // =================================================================

_getBatchStyleKey(): string | null {
    if (this._invalidGeometry) return null;
    if (this._tooltipText) return null;
    if (this._onHover) return null;
    // bucket теперь часть ключа: батчер сам пересоберётся при смене бакета
    // через свою _shouldRebuild-проверку или через _invalidateBatch ниже.

    if (this._fillPatternSource != null
        && typeof this._fillPatternSource !== 'string') return null;
    if (!this._useSimpleStroke && this._strokeWidth > 1 && this._strokeOpacity > 0) return null;

    return [
        this._extruded ? 'E' : 'NE',
        this._fillColor, this._fillOpacity,
            this._extruded ? this._roughness : '',
            this._extruded ? this._metalness : '',
            this._extruded ? (this._castShadow ? 1 : 0) : '',
            this._extruded ? (this._receiveShadow ? 1 : 0) : '',
            this._strokeColor, this._strokeWidth, this._strokeOpacity,
            this._useSimpleStroke ? 1 : 0,
            this._depthTest ? 1 : 0, this._depthWrite ? 1 : 0,
            this._minZoom, this._maxZoom,
            this._altitudeMode,
            this._fillPatternSource ?? 'nop',
            this._fillPatternScale, this._fillPatternFit,
          'b' + (this._simplify ? this._currentSimplifyBucket : 0),
    ].join('|');
}

    /** @internal */
    _getBatchGeometryData(): any | null {
        if (this._invalidGeometry) return null;
        if (!this._worldCoords.length) return null;

        let indices: ArrayLike<number>;
        if (this._cachedTopIndices) {
            indices = this._cachedTopIndices;
        } else if (this._fillGeometry?.index) {
            const arr = this._fillGeometry.index.array as ArrayLike<number>;
            this._cachedTopIndices = Array.from(arr as any);
            indices = this._cachedTopIndices;
        } else {
            const computed = this._triangulateFromRings();
            if (!computed.length) return null;
            this._cachedTopIndices = computed;
            indices = computed;
        }

        const extrude = this._extruded ? this._height : 0;
        const base = this._altitude + this._minHeight + extrude;
        const heights = new Array(this._worldCoords.length);
        for (let i = 0; i < heights.length; i++) {
            heights[i] = base + (this._nodeHeights[i] ?? 0);
        }

        return {
            worldCoords: this._worldCoords,
            heights,
            indices,
            zoomInterpolations: this._zoomInterpolations ?? null,
            ringStarts: this._ringStartIndices,
            extruded: this._extruded,
            height: this._extruded ? this._height : 0,
            fillColor: this._fillColor,
            fillOpacity: this._fillOpacity,
            strokeColor: this._strokeColor,
            strokeWidth: this._strokeWidth,
            strokeOpacity: this._strokeOpacity,
            useSimpleStroke: this._useSimpleStroke,
            depthTest: this._depthTest,
            depthWrite: this._depthWrite,
            castShadow: this._castShadow,
            receiveShadow: this._receiveShadow,
            roughness: this._roughness,
            metalness: this._metalness,
            fillPatternSource: typeof this._fillPatternSource === 'string'
                ? this._fillPatternSource : null,
            fillPatternScale: this._fillPatternScale,
            fillPatternFit: this._fillPatternFit,
            centroidX: this._centroidWorld.x,
            centroidZ: this._centroidWorld.z,
            minZoom: this._minZoom,
            maxZoom: this._maxZoom,
            altitudeMode: this._altitudeMode,
        };
    }

    /** @internal */
    _onBatchChange(batched: boolean, _batch: any): void {
        if (batched) {
            if (this._unregisterInteraction) {
                this._unregisterInteraction();
                this._unregisterInteraction = null;
            }
            if (this._group) this._group.visible = false;
            if (this._fillPatternTexture) {
                try { this._fillPatternTexture.dispose?.(); } catch { /* swallow */ }
                this._fillPatternTexture = null;
            }
            this._disposeMeshes();
            this._vertices2D = [];
            this._cachedHeights = [];
            this._cachedStrokeHeights = [];
            this._sideEdgeIJ.length = 0;
            this._sideEdgeLengths.length = 0;
            this._builtSideHeight = -1;
            this._heightsFinalized = false;
            this._avgNodeHeightValid = false;
        } else {
            if (!this._fillPatternTexture && this._fillPatternSource) this._loadFillPattern();
            if (this._map) this._rebuildGeometry();
            if (this._group) this._group.visible = true;
            if (this._map) this._registerInteraction(this._map);
            this._heightsDirty = true;
            this._heightsFinalized = false;
        }
    }

    private _invalidateBatch(): void {
        if (!this._batch) return;
        const batcher = (this._layer as any)?._polygonBatcher;
        if (batcher && typeof batcher.markDirty === 'function') batcher.markDirty();
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
        if (this._invalidGeometry) return;

        const wantTooltip = !!this._tooltipText && this._tooltipOnHover;
        if (!this._onClick && !this._onHover && !wantTooltip) return;

        const callbacks: Record<string, any> = {
            getMeshes: () => this._getRaycastMeshes(),
            getBoundingSphere: () => {
                if (this._boundingSphereRadius <= 0) return null;
                const wgPos = map.worldGroup.position;
                this._boundingSphereWorldCenter.set(
                    this._group.position.x + wgPos.x,
                    this._group.position.y + wgPos.y,
                    this._group.position.z + wgPos.z,
                );
                return {
                    center: this._boundingSphereWorldCenter,
                    radius: this._boundingSphereRadius,
                };
            },
            isVisible: () => this._group.visible,
        };
        if (this._onHover) callbacks.onHover = (h: boolean) => this._onHover!(h);
        else if (wantTooltip) callbacks.getTooltip = () => this._tooltipText;
        if (this._onClick) callbacks.onClick = (e: MouseEvent) => this._onClick!(e, this);

        this._unregisterInteraction = map.interaction.register(this, callbacks);
    }

    private _getRaycastMeshes(): any[] {
        if (this._raycastMeshesCache) return this._raycastMeshesCache;
        const meshes: any[] = [];
        if (this._fillMesh) meshes.push(this._fillMesh);
        if (this._sideMesh) meshes.push(this._sideMesh);
        if (this._bottomMesh) meshes.push(this._bottomMesh);
        this._raycastMeshesCache = meshes;
        return meshes;
    }

    // =================================================================
    // Кольца
    // =================================================================

    setRings(rings: PolygonRing[]): this {
        if (!rings || !rings.length || rings[0].length < 3) {
            console.warn('Polygon.setRings: need at least one ring with 3+ points');
            return this;
        }
        this._rings = rings;
        this._boundsCache.clear();
        this._visualCenterCache = null;
        this._centroidFromOriginal = null;
        this._simplifyCache.clear();
        this._renderRings = null;
        this._fullRenderRings = null;

        if (!this._map) {
            this._currentSimplifyBucket = -1;
            return this;
        }

        this._currentSimplifyBucket =
            Math.floor(this._map.currentDiscreteZoom / this._simplifyZoomBucket);
        this._rebuildGeometry();
        this._invalidateBatch();
        return this;
    }

    getRings(): PolygonRing[] {
        return this._rings.map(ring => ring.map(pt => [...pt] as PolygonCoord));
    }

private _rebuildGeometry(): void {
    if (!this._map) return;
    this._pendingRebuild = false;    
    this._disposeMeshes();

        this._worldCoords.length = 0;
        this._strokeWorldCoords.length = 0;
        this._nodeHeights.length = 0;
        this._strokeNodeHeights.length = 0;
        this._ringStartIndices.length = 0;
        this._cachedTopIndices = null;
        this._sideEdgeIJ.length = 0;
        this._sideEdgeLengths.length = 0;
        this._builtSideHeight = -1;
        this._vertices2D = [];
        this._invalidGeometry = false;
        this._avgNodeHeightValid = false;
        this._boundsCache.clear();

        this._buildFillGeometry(this._map);
        this._buildStrokeGeometry(this._map);

        this._registerInteraction(this._map);

        this._lastWorldGroupPos.copy(this._map.worldGroup.position);
        this._lastDiscreteZoom = this._map.currentDiscreteZoom;
        this._heightsDirty = true;
        this._heightsFinalized = false;
        this._lastHeightUpdateTime = 0;
        this._lastCentroidHeightUpdateTime = 0;
        this._visualCenterCache = null;
    }

    private _disposeMeshes(): void {
        if (this._group) {
            while (this._group.children.length > 0) {
                this._group.remove(this._group.children[0]);
            }
        }
        this._fillGeometry?.dispose();
        this._fillMaterial?.dispose();
        this._bottomGeometry?.dispose();
        this._bottomMaterial?.dispose();
        this._sideGeometry?.dispose();
        this._sideMaterial?.dispose();
        this._strokeGeometry?.dispose();
        this._strokeMaterial?.dispose();
        this._fillMesh = null; this._fillGeometry = null; this._fillMaterial = null;
        this._bottomMesh = null; this._bottomGeometry = null; this._bottomMaterial = null;
        this._sideMesh = null; this._sideGeometry = null; this._sideMaterial = null;
        this._strokeLine = null; this._strokeGeometry = null; this._strokeMaterial = null;
        this._raycastMeshesCache = null;
        // _cachedTopIndices НЕ трогаем — батчер пересоберётся по нему.
    }

    // =================================================================
    // Fill pattern
    // =================================================================



    private _loadFillPattern(): void {
        const src = this._fillPatternSource;
        const generation = ++this._fillPatternGeneration;

        if (!src) {
            this._fillPatternTexture = null;
            return;
        }

  if (typeof src === 'string') {
    this._fillPatternTexture = _getSharedPatternTexture(src);
    this._configureFillPatternTexture();
            const loader = new THREE.TextureLoader();
            loader.setCrossOrigin('anonymous');
            const tex = loader.load(
                src,
                (loaded: any) => {
                    if (generation !== this._fillPatternGeneration) {
                        try { loaded?.dispose?.(); } catch { /* swallow */ }
                        return;
                    }
                    this._configureFillPatternTexture();
                    this._applyFillPatternToMaterials();
                },
                undefined,
                (err: any) => {
                    if (generation !== this._fillPatternGeneration) return;
                    console.warn('Polygon: fillPattern load failed', err);
                },
            );
            this._fillPatternTexture = tex;
            this._configureFillPatternTexture();
        } else if (typeof HTMLCanvasElement !== 'undefined' && src instanceof HTMLCanvasElement) {
            this._fillPatternTexture = new THREE.CanvasTexture(src);
            this._configureFillPatternTexture();
        } else {
            this._fillPatternTexture = new THREE.Texture(src as any);
            this._fillPatternTexture.needsUpdate = true;
            this._configureFillPatternTexture();
        }
    }

    private _configureFillPatternTexture(): void {
        const t = this._fillPatternTexture;
        if (!t) return;
        t.wrapS = THREE.RepeatWrapping;
        t.wrapT = THREE.RepeatWrapping;
        t.generateMipmaps = false;
        t.minFilter = THREE.LinearFilter;
        t.magFilter = THREE.LinearFilter;

        const renderer = this._map?.renderer;
        const caps = renderer?.capabilities;
        if (caps && typeof caps.getMaxAnisotropy === 'function') {
            try { t.anisotropy = Math.min(16, caps.getMaxAnisotropy()); } catch { /* swallow */ }
        }
        const Ctor = THREE as any;
        if (Ctor.SRGBColorSpace && !(t as any).colorSpace) {
            (t as any).colorSpace = Ctor.SRGBColorSpace;
        }
        t.needsUpdate = true;
    }

private _applyFillPatternToMaterials(): void {
    const map = this._fillPatternTexture;
    if (!map) return;
    for (const mat of [this._fillMaterial, this._bottomMaterial, this._sideMaterial]) {
        if (!mat) continue;
        mat.map = map;
        mat.needsUpdate = true;
    }
}

    // =================================================================
    // UV
    // =================================================================

    private _computeUVParams(patternScale: number): UVParams {
        if (this._fillPatternFit === 'bounds') {
            let minPX = Infinity, maxPX = -Infinity;
            let minPZ = Infinity, maxPZ = -Infinity;
            for (const wc of this._worldCoords) {
                if (!wc) continue;
                if (wc[0] < minPX) minPX = wc[0];
                if (wc[0] > maxPX) maxPX = wc[0];
                if (wc[1] < minPZ) minPZ = wc[1];
                if (wc[1] > maxPZ) maxPZ = wc[1];
            }
            return {
                originX: isFinite(minPX) ? minPX : 0,
                originZ: isFinite(minPZ) ? minPZ : 0,
                scaleX: (maxPX - minPX) > 1e-6 ? (maxPX - minPX) : 1,
                scaleZ: (maxPZ - minPZ) > 1e-6 ? (maxPZ - minPZ) : 1,
            };
        }
        return {
            originX: Math.floor(this._centroidWorld.x / patternScale) * patternScale,
            originZ: Math.floor(this._centroidWorld.z / patternScale) * patternScale,
            scaleX: patternScale,
            scaleZ: patternScale,
        };
    }

    private _updateFillUVs(): void {
        if (this._invalidGeometry) return;
        if (!this._fillGeometry) return;

        const patternScale = this._fillPatternScale > 0
            ? this._fillPatternScale : DEFAULT_FILL_PATTERN_SCALE;
        const params = this._computeUVParams(patternScale);
        const worldCoords = this._worldCoords;
        const n = worldCoords.length;

        const topAttr = this._fillGeometry.attributes.uv;
        if (topAttr) {
            const topUVs = topAttr.array as Float32Array;
            for (let i = 0; i < n; i++) {
                const wc = worldCoords[i];
                if (!wc) continue;
                topUVs[i * 2]     = (wc[0] - params.originX) / params.scaleX;
                topUVs[i * 2 + 1] = (wc[1] - params.originZ) / params.scaleZ;
            }
            topAttr.needsUpdate = true;
        }

        if (this._bottomGeometry) {
            const botAttr = this._bottomGeometry.attributes.uv;
            if (botAttr && topAttr) {
                (botAttr.array as Float32Array).set(topAttr.array as Float32Array);
                botAttr.needsUpdate = true;
            }
        }

        if (this._sideGeometry && this._sideEdgeLengths.length > 0) {
            const sideAttr = this._sideGeometry.attributes.uv;
            if (sideAttr) {
                const sideUVs = sideAttr.array as Float32Array;
                const vH = this._height / patternScale;
                let cum = 0;
                const edgeCount = this._sideEdgeLengths.length;
                for (let k = 0; k < edgeCount; k++) {
                    const edgeLen = this._sideEdgeLengths[k];
                    const base = k * 8;
                    const u0 = cum / patternScale;
                    const u1 = (cum + edgeLen) / patternScale;
                    sideUVs[base + 0] = u0; sideUVs[base + 1] = vH;
                    sideUVs[base + 2] = u0; sideUVs[base + 3] = 0;
                    sideUVs[base + 4] = u1; sideUVs[base + 5] = vH;
                    sideUVs[base + 6] = u1; sideUVs[base + 7] = 0;
                    cum += edgeLen;
                }
                sideAttr.needsUpdate = true;
            }
            this._builtSideHeight = this._height;
        }
    }

    // =================================================================
    // Построение геометрии
    // =================================================================

private _createSurfaceMaterial(): any {
    const hasOpacityAnim = !!(
        this._zoomInterpolations?.fillOpacity &&
        this._zoomInterpolations.fillOpacity.length >= 2
    );
    const isTransparent = hasOpacityAnim || this._fillOpacity < 1;

    const map = this._fillPatternTexture;
    const patternProps = map ? { map } : {};

    if (this._extruded) {
        return new THREE.MeshStandardMaterial({
            color: this._fillColor,
            opacity: this._fillOpacity,
            transparent: isTransparent,
            side: THREE.FrontSide,
            roughness: this._roughness,
            metalness: this._metalness,
            depthTest: this._depthTest,
            depthWrite: this._depthWrite,
            polygonOffset: true,
            polygonOffsetFactor: -1,
            polygonOffsetUnits: -1,
            ...patternProps,
        });
    }
    return new THREE.MeshBasicMaterial({
        color: this._fillColor,
        opacity: this._fillOpacity,
        transparent: isTransparent,
        side: THREE.FrontSide,
        depthTest: this._depthTest,
        depthWrite: this._depthWrite,
        polygonOffset: true,
        polygonOffsetFactor: -1,
        polygonOffsetUnits: -1,
        ...patternProps,
    });
}

    private _applyShadowFlags(mesh: any): void {
        if (!mesh) return;
        if (this._extruded) {
            mesh.castShadow = this._castShadow;
            mesh.receiveShadow = this._receiveShadow;
        } else {
            mesh.castShadow = false;
            mesh.receiveShadow = false;
        }
    }

    private _flipIndices(indices: number[]): number[] {
        const result = new Array(indices.length);
        for (let i = 0; i < indices.length; i += 3) {
            result[i] = indices[i];
            result[i + 1] = indices[i + 2];
            result[i + 2] = indices[i + 1];
        }
        return result;
    }

    private _hasAntimeridianWrap(): boolean {
        if (!this._crs || !this._crs.isGeographic) return false;
        const rings = this._rings;
        if (!rings) return false;
        for (let r = 0; r < rings.length; r++) {
            const ring = rings[r];
            if (!ring || ring.length < 2) continue;
            const n = ring.length;
            for (let i = 0; i < n; i++) {
                const a = ring[i], b = ring[(i + 1) % n];
                if (!a || !b || a.length < 2 || b.length < 2) continue;
                if (Math.abs(b[0] - a[0]) > 180) return true;
            }
        }
        return false;
    }

    private _isGeometryInvalid(ringStartIndices: number[], worldSize: number): boolean {
        const maxEdge = worldSize / INVALID_EDGE_FRACTION;
        const maxEdgeSq = maxEdge * maxEdge;
        const wc = this._worldCoords;

        for (let ringIdx = 0; ringIdx < ringStartIndices.length; ringIdx++) {
            const start = ringStartIndices[ringIdx];
            if (start === undefined) continue;
            const nextStart = (ringIdx + 1 < ringStartIndices.length)
                ? ringStartIndices[ringIdx + 1] : wc.length;
            const count = nextStart - start;
            if (count < 2) continue;
            for (let i = 0; i < count; i++) {
                const a = wc[start + i];
                const b = wc[start + ((i + 1) % count)];
                if (!a || !b) continue;
                const dx = b[0] - a[0], dz = b[1] - a[1];
                if (dx * dx + dz * dz > maxEdgeSq) return true;
            }
        }
        return false;
    }

    private _triangulateFromRings(): number[] {
        const wc = this._worldCoords;
        const rs = this._ringStartIndices;
        if (!wc.length || !rs.length) return [];

        const coords: number[] = [];
        const holeIndices: number[] = [];
        for (let r = 0; r < rs.length; r++) {
            const start = rs[r];
            const end = (r + 1 < rs.length) ? rs[r + 1] : wc.length;
            if (r > 0) holeIndices.push(coords.length / 2);
            for (let i = start; i < end; i++) coords.push(wc[i][0], wc[i][1]);
        }
        if (coords.length < 6) return [];

        const indices = earcut(coords, holeIndices, 2);
        if (!indices.length) return [];

        const p2d: Array<{ x: number; y: number }> = new Array(coords.length / 2);
        for (let i = 0, j = 0; i < coords.length; i += 2, j++) {
            p2d[j] = { x: coords[i], y: coords[i + 1] };
        }
        const firstCrossY = crossY(p2d[indices[0]], p2d[indices[1]], p2d[indices[2]]);
        return firstCrossY >= 0 ? indices : this._flipIndices(indices);
    }

private _buildFillGeometry(map: any): void {
    this._cachedTopIndices = null;

    const rings = this._getRenderRings(this._currentSimplifyBucket);
    if (!rings || !rings.length || rings[0].worldCoords.length < 3) {
        console.warn('Polygon: rings[0] must have at least 3 points');
        return;
    }

    this._worldCoords.length = 0;
    this._nodeHeights.length = 0;
    this._ringStartIndices.length = 0;
    this._sideEdgeIJ.length = 0;
    this._sideEdgeLengths.length = 0;
    this._builtSideHeight = -1;
    this._avgNodeHeightValid = false;
    this._boundsCache.clear();

    const coords: number[] = [];
    const points2D: any[] = [];
    const holeIndices: number[] = [];
    const ringStartIndices: number[] = [];

    for (let ringIdx = 0; ringIdx < rings.length; ringIdx++) {
        const { worldCoords, heights } = rings[ringIdx];
        if (worldCoords.length < 3) {
            console.warn(`Polygon: hole ring ${ringIdx} must have at least 3 points`);
            continue;
        }

        ringStartIndices.push(points2D.length);
        this._ringStartIndices.push(points2D.length);
        if (ringIdx > 0) holeIndices.push(coords.length / 2);

        let firstPoint: [number, number] | null = null;
        for (let i = 0; i < worldCoords.length; i++) {
            const [absX, absZ] = worldCoords[i];
            if (i === 0) firstPoint = [absX, absZ];
            if (i > 0 && firstPoint && absX === firstPoint[0] && absZ === firstPoint[1]) continue;
            coords.push(absX, absZ);
            points2D.push(new THREE.Vector2(absX, absZ));
            this._worldCoords.push([absX, absZ]);
            this._nodeHeights.push(heights[i] ?? 0);
        }
    }

    if (points2D.length < 3) {
        console.warn('Polygon: after processing rings, less than 3 vertices');
        return;
    }

    if (!this._hasAntimeridianWrap()
        && this._isGeometryInvalid(ringStartIndices, map.WORLD_SIZE)) {
        this._invalidGeometry = true;
        this._group.visible = false;
        this._worldCoords.length = 0;
        this._nodeHeights.length = 0;
        return;
    }
    this._invalidGeometry = false;

    this._vertices2D = points2D;
    this._cachedHeights = new Array(points2D.length).fill(0);

    const indices = earcut(coords, holeIndices, 2);
    if (indices.length === 0) {
        console.warn('Polygon: Earcut returned no triangles');
        return;
    }

    const firstCrossY = crossY(points2D[indices[0]], points2D[indices[1]], points2D[indices[2]]);
    const topIndices = firstCrossY >= 0 ? indices : this._flipIndices(indices);
    const bottomIndices = this._flipIndices(topIndices);
    this._cachedTopIndices = topIndices;

    // Визуальный центр — один раз на полигон, от исходных колец.
    let cx: number, cy: number;
    if (!this._centroidFromOriginal) {
        const fullRings = this._getFullRenderRings();
        const srcRings: [number, number][][] = fullRings.map(r => r.worldCoords);
        const vc = _approxVisualCenter(srcRings, 0);
        if (vc) {
            this._centroidFromOriginal = { x: vc[0], z: vc[1] };
        } else {
            let sx = 0, sy = 0, cnt = 0;
            for (const r of srcRings) for (const p of r) { sx += p[0]; sy += p[1]; cnt++; }
            this._centroidFromOriginal = cnt ? { x: sx / cnt, z: sy / cnt } : { x: 0, z: 0 };
        }
    }
    cx = this._centroidFromOriginal.x;
    cy = this._centroidFromOriginal.z;

    this._centroidWorld.set(cx, 0, cy);
    this._group.position.copy(this._centroidWorld);

    for (let i = 0; i < points2D.length; i++) {
        points2D[i].x -= cx;
        points2D[i].y -= cy;
    }

    let maxRadiusSq = 0;
    for (const pt of points2D) {
        const rSq = pt.x * pt.x + pt.y * pt.y;
        if (rSq > maxRadiusSq) maxRadiusSq = rSq;
    }
    this._boundingSphereRadius = Math.sqrt(maxRadiusSq);

    const patternScale = this._fillPatternScale > 0
        ? this._fillPatternScale : DEFAULT_FILL_PATTERN_SCALE;
    const uvParams = this._computeUVParams(patternScale);

    const topUVs = new Float32Array(points2D.length * 2);
    for (let i = 0; i < points2D.length; i++) {
        const wc = this._worldCoords[i];
        const wx = wc ? wc[0] : 0;
        const wz = wc ? wc[1] : 0;
        topUVs[i * 2]     = (wx - uvParams.originX) / uvParams.scaleX;
        topUVs[i * 2 + 1] = (wz - uvParams.originZ) / uvParams.scaleZ;
    }

    const topGeometry = new THREE.BufferGeometry();
    const topPosArray = new Float32Array(points2D.length * 3);
    for (let i = 0; i < points2D.length; i++) {
        const pt = points2D[i];
        topPosArray[i * 3] = pt.x;
        topPosArray[i * 3 + 1] = 0;
        topPosArray[i * 3 + 2] = pt.y;
    }
    topGeometry.setAttribute('position', new THREE.BufferAttribute(topPosArray, 3));
    topGeometry.setAttribute('uv', new THREE.BufferAttribute(topUVs, 2));
    topGeometry.setIndex(topIndices);

    const topNormals = new Float32Array(points2D.length * 3);
    for (let i = 0; i < points2D.length; i++) topNormals[i * 3 + 1] = 1;
    topGeometry.setAttribute('normal', new THREE.BufferAttribute(topNormals, 3));
    topGeometry.computeBoundingSphere();

    const topMaterial = this._createSurfaceMaterial();
    const topMesh = new THREE.Mesh(topGeometry, topMaterial);
    topMesh.renderOrder = POLYGON_RENDER_ORDER.TOP;
    topMesh.frustumCulled = true;
    topMesh.userData.polygon = this;
    this._applyShadowFlags(topMesh);
    this._fillMesh = topMesh;
    this._fillGeometry = topGeometry;
    this._fillMaterial = topMaterial;
    this._group.add(topMesh);

    if (this._extruded) {
        const bottomGeometry = new THREE.BufferGeometry();
        const bottomPosArray = new Float32Array(points2D.length * 3);
        for (let i = 0; i < points2D.length; i++) {
            const pt = points2D[i];
            bottomPosArray[i * 3] = pt.x;
            bottomPosArray[i * 3 + 1] = 0;
            bottomPosArray[i * 3 + 2] = pt.y;
        }
        bottomGeometry.setAttribute('position', new THREE.BufferAttribute(bottomPosArray, 3));
        bottomGeometry.setAttribute('uv', new THREE.BufferAttribute(topUVs.slice(), 2));
        bottomGeometry.setIndex(bottomIndices);

        const bottomNormals = new Float32Array(points2D.length * 3);
        for (let i = 0; i < points2D.length; i++) bottomNormals[i * 3 + 1] = -1;
        bottomGeometry.setAttribute('normal', new THREE.BufferAttribute(bottomNormals, 3));
        bottomGeometry.computeBoundingSphere();

        const bottomMaterial = this._createSurfaceMaterial();
        const bottomMesh = new THREE.Mesh(bottomGeometry, bottomMaterial);
        bottomMesh.renderOrder = POLYGON_RENDER_ORDER.BOTTOM;
        bottomMesh.frustumCulled = true;
        bottomMesh.userData.polygon = this;
        this._applyShadowFlags(bottomMesh);
        this._bottomMesh = bottomMesh;
        this._bottomGeometry = bottomGeometry;
        this._bottomMaterial = bottomMaterial;
        this._group.add(bottomMesh);

        // ── SIDE ─────────────────────────────────────────────────────────
        // Пред-выделяем типизированные массивы ровно на количество рёбер:
        // каждое ребро → 4 вершины (topI, bottomI, topJ, bottomJ).
        // Это исключает реаллокации и финальные копии new Float32Array(...).
        const sideUvScale = patternScale;
        const initialHeight = this._height;
        const vH = initialHeight / sideUvScale;

        // Сначала посчитаем общее количество рёбер (те же условия, что и в цикле ниже).
        let totalEdges = 0;
        for (let ringIdx = 0; ringIdx < this._ringStartIndices.length; ringIdx++) {
            const start = this._ringStartIndices[ringIdx];
            const nextRingStart = (ringIdx + 1 < this._ringStartIndices.length)
                ? this._ringStartIndices[ringIdx + 1] : points2D.length;
            const count = nextRingStart - start;
            if (count < 2) continue;
            totalEdges += count;
        }

        const sidePositions = new Float32Array(totalEdges * 4 * 3);
        const sideUVs      = new Float32Array(totalEdges * 4 * 2);
        const sideIndices  = new Uint32Array(totalEdges * 6);

        let posK = 0;    // индекс записи в sidePositions (float)
        let uvK = 0;     // индекс записи в sideUVs (float)
        let idxK = 0;    // индекс записи в sideIndices (uint32)
        let vertBase = 0; // текущая база вершин для индексов

        for (let ringIdx = 0; ringIdx < this._ringStartIndices.length; ringIdx++) {
            const start = this._ringStartIndices[ringIdx];
            const nextRingStart = (ringIdx + 1 < this._ringStartIndices.length)
                ? this._ringStartIndices[ringIdx + 1] : points2D.length;
            const count = nextRingStart - start;
            if (count < 2) continue;

            // Знак signed area в плоскости XZ (стандартное 2D-векторное произведение).
            // sa > 0 → против часовой, sa < 0 → по часовой.
            let sa = 0;
            for (let i = 0; i < count; i++) {
                const j = (i + 1) % count;
                const a = points2D[start + i];
                const b = points2D[start + j];
                sa += a.x * b.y - b.x * a.y;
            }
            // Outer (ringIdx=0) хотим CW (sa<0), hole (ringIdx>0) хотим CCW (sa>0).
            const flipSides = (sa > 0) !== (ringIdx > 0);

            let cum = 0;
            for (let i = 0; i < count; i++) {
                const j = (i + 1) % count;
                const idxI = start + i;
                const idxJ = start + j;
                const topI = points2D[idxI];
                const topJ = points2D[idxJ];

                // 4 вершины: topI, bottomI, topJ, bottomJ
                sidePositions[posK++] = topI.x;
                sidePositions[posK++] = initialHeight;
                sidePositions[posK++] = topI.y;

                sidePositions[posK++] = topI.x;
                sidePositions[posK++] = 0;
                sidePositions[posK++] = topI.y;

                sidePositions[posK++] = topJ.x;
                sidePositions[posK++] = initialHeight;
                sidePositions[posK++] = topJ.y;

                sidePositions[posK++] = topJ.x;
                sidePositions[posK++] = 0;
                sidePositions[posK++] = topJ.y;

                const ddx = topJ.x - topI.x;
                const ddz = topJ.y - topI.y;
                const edgeLen = Math.sqrt(ddx * ddx + ddz * ddz);
                const u0 = cum / sideUvScale;
                const u1 = (cum + edgeLen) / sideUvScale;

                sideUVs[uvK++] = u0;
                sideUVs[uvK++] = vH;
                sideUVs[uvK++] = u0;
                sideUVs[uvK++] = 0;
                sideUVs[uvK++] = u1;
                sideUVs[uvK++] = vH;
                sideUVs[uvK++] = u1;
                sideUVs[uvK++] = 0;

                if (!flipSides) {
                    sideIndices[idxK++] = vertBase;
                    sideIndices[idxK++] = vertBase + 1;
                    sideIndices[idxK++] = vertBase + 2;
                    sideIndices[idxK++] = vertBase + 1;
                    sideIndices[idxK++] = vertBase + 3;
                    sideIndices[idxK++] = vertBase + 2;
                } else {
                    // Тот же quad, но с обратным обходом → нормаль на 180°.
                    sideIndices[idxK++] = vertBase;
                    sideIndices[idxK++] = vertBase + 2;
                    sideIndices[idxK++] = vertBase + 1;
                    sideIndices[idxK++] = vertBase + 1;
                    sideIndices[idxK++] = vertBase + 2;
                    sideIndices[idxK++] = vertBase + 3;
                }
                vertBase += 4;

                this._sideEdgeIJ.push([idxI, idxJ]);
                this._sideEdgeLengths.push(edgeLen);
                cum += edgeLen;
            }
        }

        if (totalEdges > 0) {
            const sideGeometry = new THREE.BufferGeometry();
            sideGeometry.setAttribute('position', new THREE.BufferAttribute(sidePositions, 3));
            sideGeometry.setAttribute('uv', new THREE.BufferAttribute(sideUVs, 2));
            sideGeometry.setIndex(new THREE.BufferAttribute(sideIndices, 1));
            sideGeometry.computeVertexNormals();
            sideGeometry.computeBoundingSphere();

            const sideMaterial = this._createSurfaceMaterial();
            const sideMesh = new THREE.Mesh(sideGeometry, sideMaterial);
            sideMesh.renderOrder = POLYGON_RENDER_ORDER.SIDE;
            sideMesh.frustumCulled = true;
            sideMesh.userData.polygon = this;
            this._applyShadowFlags(sideMesh);
            this._sideMesh = sideMesh;
            this._sideGeometry = sideGeometry;
            this._sideMaterial = sideMaterial;
            this._group.add(sideMesh);
            this._builtSideHeight = initialHeight;
        }
    }

    this._raycastMeshesCache = null;
}

    private _buildStrokeGeometry(map: any): void {
        if (this._invalidGeometry) return;
        if (this._strokeWidth <= 0 || this._strokeOpacity <= 0) return;

        const canvas = map.renderer.domElement;
        const rings = this._getRenderRings(this._currentSimplifyBucket);
        const outer = rings[0];
        if (!outer) return;
        const { worldCoords: outerWC, heights: outerH } = outer;

        this._strokeWorldCoords.length = 0;
        this._strokeNodeHeights.length = 0;
        let firstStrokePoint: [number, number] | null = null;
        for (let i = 0; i < outerWC.length; i++) {
            const [absX, absZ] = outerWC[i];
            if (i === 0) {
                firstStrokePoint = [absX, absZ];
            } else if (firstStrokePoint && absX === firstStrokePoint[0] && absZ === firstStrokePoint[1]) {
                continue;
            }
            this._strokeWorldCoords.push([absX, absZ]);
            this._strokeNodeHeights.push(outerH[i] ?? 0);
        }

        this._cachedStrokeHeights = new Array(this._strokeWorldCoords.length).fill(0);

        if (this._useSimpleStroke) {
            const positions: number[] = [];
            for (let i = 0; i < this._strokeWorldCoords.length; i++) {
                const wc = this._strokeWorldCoords[i];
                positions.push(wc[0], 0, wc[1]);
            }
            if (this._strokeWorldCoords.length > 0) {
                const first = this._strokeWorldCoords[0];
                positions.push(first[0], 0, first[1]);
            }

            const lineGeometry = new THREE.BufferGeometry();
            lineGeometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(positions), 3));
            lineGeometry.computeBoundingSphere();

            const lineMaterial = new THREE.LineBasicMaterial({
                color: this._strokeColor,
                opacity: this._strokeOpacity,
                transparent: this._strokeOpacity < 1,
                depthTest: this._depthTest,
                depthWrite: this._depthWrite,
            });
            const line = new THREE.Line(lineGeometry, lineMaterial);
            line.renderOrder = POLYGON_RENDER_ORDER.STROKE;
            this._strokeLine = line;
            this._strokeGeometry = lineGeometry;
            this._strokeMaterial = lineMaterial;
            this._group.add(line);
        } else {
            this._strokeGeometry = new LineGeometry();
            this._strokeMaterial = new LineMaterial({
                color: this._strokeColor,
                linewidth: this._strokeWidth,
                opacity: this._strokeOpacity,
                transparent: this._strokeOpacity < 1,
                depthTest: this._depthTest,
                depthWrite: this._depthWrite,
                resolution: new THREE.Vector2(canvas.width, canvas.height),
            });
            const line = new Line2(this._strokeGeometry, this._strokeMaterial);
            line.renderOrder = POLYGON_RENDER_ORDER.STROKE;
            this._strokeLine = line;
            this._group.add(line);
        }
    }

    // =================================================================
    // Стиль
    // =================================================================

    setFillColor(color: string | number): this {
        this._fillColor = color;
        if (this._fillMaterial?.color) this._fillMaterial.color.set(color as any);
        if (this._bottomMaterial?.color) this._bottomMaterial.color.set(color as any);
        if (this._sideMaterial?.color) this._sideMaterial.color.set(color as any);
        this._invalidateBatch();
        return this;
    }
    getFillColor(): string | number { return this._fillColor; }

    setFillOpacity(opacity: number): this {
        this._fillOpacity = Math.max(0, Math.min(1, opacity));
        const transparent = this._fillOpacity < 1;
        for (const mat of [this._fillMaterial, this._bottomMaterial, this._sideMaterial]) {
            if (!mat) continue;
            mat.opacity = this._fillOpacity;
            if (mat.transparent !== transparent) {
                mat.transparent = transparent;
                mat.needsUpdate = true;
            }
        }
        this._invalidateBatch();
        return this;
    }
    getFillOpacity(): number { return this._fillOpacity; }

    setFillPattern(source: FillPatternSource): this {
        if (this._fillPatternTexture) {
            try { this._fillPatternTexture.dispose?.(); } catch { /* swallow */ }
            this._fillPatternTexture = null;
        }
        this._fillPatternSource = source;
        if (!this._map) return this;
        this._loadFillPattern();
        this._applyFillPatternToMaterials();
        this._invalidateBatch();
        return this;
    }
    getFillPattern(): FillPatternSource { return this._fillPatternSource; }

    setFillPatternScale(scale: number): this {
        if (!(scale > 0)) return this;
        if (this._fillPatternScale === scale) return this;
        this._fillPatternScale = scale;
        if (this._map) this._updateFillUVs();
        this._invalidateBatch();
        return this;
    }
    getFillPatternScale(): number { return this._fillPatternScale; }

    setFillPatternFit(fit: FillPatternFit): this {
        if (this._fillPatternFit === fit) return this;
        this._fillPatternFit = fit;
        if (this._map) this._updateFillUVs();
        this._invalidateBatch();
        return this;
    }
    getFillPatternFit(): FillPatternFit { return this._fillPatternFit; }

    setStrokeColor(color: string | number): this {
        this._strokeColor = color;
        if (this._strokeMaterial?.color) this._strokeMaterial.color.set(color as any);
        this._invalidateBatch();
        return this;
    }
    getStrokeColor(): string | number { return this._strokeColor; }

    setStrokeWidth(width: number): this {
        if (!(width >= 0)) return this;
        this._strokeWidth = width;
        const mat = this._strokeMaterial;
        if (mat && 'linewidth' in mat) {
            mat.linewidth = width;
            mat.needsUpdate = true;
        }
        this._invalidateBatch();
        return this;
    }
    getStrokeWidth(): number { return this._strokeWidth; }

    setStrokeOpacity(opacity: number): this {
        this._strokeOpacity = Math.max(0, Math.min(1, opacity));
        const mat = this._strokeMaterial;
        if (mat) {
            mat.opacity = this._strokeOpacity;
            const transparent = this._strokeOpacity < 1;
            if (mat.transparent !== transparent) {
                mat.transparent = transparent;
                mat.needsUpdate = true;
            }
        }
        this._invalidateBatch();
        return this;
    }
    getStrokeOpacity(): number { return this._strokeOpacity; }

    // =================================================================
    // Высота / экструзия / depth
    // =================================================================

    setAltitudeOffset(offset: number): this { return this.setAltitude(offset); }
    getAltitudeOffset(): number { return this.getAltitude(); }

    setAltitudeMode(mode: AltitudeMode): this {
        this._altitudeMode = mode;
        this._onAltitudeChanged();
        return this;
    }
    getAltitudeMode(): AltitudeMode { return this._altitudeMode; }

    setExtruded(extruded: boolean): this {
        const next = !!extruded;
        if (this._extruded === next) return this;
        this._extruded = next;
        if (next && this._height <= 0) {
            console.warn('Polygon.setExtruded: height is 0, side walls will be flat');
        }
        if (this._map) this._rebuildGeometry();
        this._invalidateBatch();
        return this;
    }
    getExtruded(): boolean { return this._extruded; }

    setHeight(height: number): this {
        if (!(height >= 0) || this._height === height) return this;
        this._height = height;
        if (this._extruded) { this._heightsDirty = true; this._heightsFinalized = false; }
        this._invalidateBatch();
        return this;
    }
    getHeight(): number { return this._height; }

    setMinHeight(height: number): this {
        if (!(height >= 0) || this._minHeight === height) return this;
        this._minHeight = height;
        this._heightsDirty = true;
        this._heightsFinalized = false;
        this._invalidateBatch();
        return this;
    }
    getMinHeight(): number { return this._minHeight; }

    setDepthTest(depthTest: boolean): this {
        this._depthTest = !!depthTest;
        this._applyDepthFlags();
        this._invalidateBatch();
        return this;
    }
    getDepthTest(): boolean { return this._depthTest; }

    setDepthWrite(depthWrite: boolean): this {
        this._depthWrite = !!depthWrite;
        this._applyDepthFlags();
        this._invalidateBatch();
        return this;
    }
    getDepthWrite(): boolean { return this._depthWrite; }

    private _applyDepthFlags(): void {
        for (const mat of [this._fillMaterial, this._bottomMaterial, this._sideMaterial, this._strokeMaterial]) {
            if (!mat) continue;
            let changed = false;
            if (mat.depthTest !== this._depthTest) { mat.depthTest = this._depthTest; changed = true; }
            if (mat.depthWrite !== this._depthWrite) { mat.depthWrite = this._depthWrite; changed = true; }
            if (changed) mat.needsUpdate = true;
        }
    }

    // =================================================================
    // Обновление на кадре
    // =================================================================

    _update(_mapArg?: any): void {
        const map = this._map;
        if (!map || !this._group) return;

 if (this._batch) {
    if (this._invalidGeometry || !this._isWithinView()) {
        this._isVisible = false;
        this._centroidScreenPos = null;
        return;
    }
    this._isVisible = true;

    // NEW: LOD в батче — тоже работает
    if (this._simplify) {
        const bucket = Math.floor(map.currentDiscreteZoom / this._simplifyZoomBucket);
        if (bucket !== this._currentSimplifyBucket) {
            this._scheduleBucketChange(bucket);
        }
    }
    this._updateCentroidScreenPos();
    return;
}

// Polygon._update
if (this._simplify) {
    const bucket = Math.floor(map.currentDiscreteZoom / this._simplifyZoomBucket);
    if (bucket !== this._currentSimplifyBucket) {
        this._scheduleBucketChange(bucket);
    }
}

        if (this._invalidGeometry || !this._isWithinView()) {
            this._applyHidden();
            this._isVisible = false;
            return;
        }

        this._applyZoomInterpolations(map.continuousZoom);

        if (this._group.parent !== this._map.worldGroup) {
            this._group.parent?.remove(this._group);
            this._map.worldGroup.add(this._group);
        }

        if (this._strokeMaterial && this._strokeMaterial.resolution) {
            const canvas = this._map.renderer.domElement;
            const res = this._strokeMaterial.resolution;
            if (res.x !== canvas.width || res.y !== canvas.height) {
                res.set(canvas.width, canvas.height);
            }
        }

        if (this._boundingSphereRadius > 0) {
            const maxDist = map.maxObjectDistance;
            if (maxDist !== Infinity) {
                const worldCenter = map.getVec3()
                    .copy(this._group.position)
                    .add(map.worldGroup.position);
                const distToCenter = map.camera.position.distanceTo(worldCenter);
                if (distToCenter - this._boundingSphereRadius > maxDist) {
                    this._applyHidden();
                    this._isVisible = false;
                    return;
                }
            }
        }

        this._group.visible = true;
        this._isVisible = true;

        if (this._pendingRebuild) {
            this._rebuildGeometry();
        }


        const now = performance.now();
        const worldGroupPosChanged = !this._lastWorldGroupPos.equals(map.worldGroup.position);
        const discreteZoomChanged = this._lastDiscreteZoom !== map.currentDiscreteZoom;
        if (worldGroupPosChanged || discreteZoomChanged) {
            this._heightsDirty = true;
            this._lastWorldGroupPos.copy(map.worldGroup.position);
            this._lastDiscreteZoom = map.currentDiscreteZoom;
        }

        const isDynamicHeight = map.hasElevation && this._altitudeMode === 'clampToGround';
        const timeExpired = isDynamicHeight
            && (now - this._lastHeightUpdateTime) >= this._heightUpdateInterval;

        if (this._heightsDirty || timeExpired) {
            const changed = this._updateHeights();
            if (changed) this._updateStroke();
            this._heightsDirty = false;
            this._lastHeightUpdateTime = now;
        }

        this._updateCentroidScreenPos();
    }

    private _updateHeights(): boolean {
        if (this._invalidGeometry) return false;
        if (!this._fillGeometry || !this._vertices2D.length) return false;
        const map = this._map;

        const isDynamic = map.hasElevation && this._altitudeMode === 'clampToGround';
        if (!isDynamic && this._heightsFinalized) return false;

        const wgPos = map.worldGroup.position;
        const extrude = this._extruded ? this._height : 0;
        const n = this._vertices2D.length;

        const ensuredTiles = isDynamic ? new Set<string>() : null;
const ensureFor = (wx: number, wz: number) => {
    const k = ((wx / 1000) | 0) + ',' + ((wz / 1000) | 0);
    if (ensuredTiles!.has(k)) return;
    ensuredTiles!.add(k);
    map.ensureTileForPoint?.(wx, wz);
};

        for (let i = 0; i < n; i++) {
            const wc = this._worldCoords[i];
            if (!wc) continue;
            let base = this._altitude;
            if (isDynamic) {
    const worldX = wc[0] + wgPos.x;
    const worldZ = wc[1] + wgPos.z;
    ensureFor(worldX, worldZ);
    base = map.getSurfaceHeightAt(worldX, worldZ) + this._altitude;
}
            this._cachedHeights[i] = base + (this._nodeHeights[i] ?? 0) + this._minHeight + extrude;
        }

        const strokeLen = this._strokeWorldCoords.length;
        if (this._cachedStrokeHeights.length !== strokeLen) {
            this._cachedStrokeHeights = new Array(strokeLen).fill(0);
        }
        for (let i = 0; i < strokeLen; i++) {
            const wc = this._strokeWorldCoords[i];
            if (!wc) continue;
            let base = this._altitude;
            if (isDynamic) {
                const worldX = wc[0] + wgPos.x;
                const worldZ = wc[1] + wgPos.z;
                map.ensureTileForPoint?.(worldX, worldZ);
                base = map.getSurfaceHeightAt(worldX, worldZ) + this._altitude;
            }
            this._cachedStrokeHeights[i] = base + (this._strokeNodeHeights[i] ?? 0) + this._minHeight + extrude;
        }

        const topPos = this._fillGeometry.attributes.position.array as Float32Array;
        for (let i = 0; i < n; i++) topPos[i * 3 + 1] = this._cachedHeights[i];
        this._fillGeometry.attributes.position.needsUpdate = true;
        this._fillGeometry.computeBoundingSphere();

        if (this._bottomGeometry) {
            const bottomPos = this._bottomGeometry.attributes.position.array as Float32Array;
            const height = this._height;
            for (let i = 0; i < n; i++) bottomPos[i * 3 + 1] = this._cachedHeights[i] - height;
            this._bottomGeometry.attributes.position.needsUpdate = true;
            this._bottomGeometry.computeBoundingSphere();
        }

        if (this._sideGeometry) {
            const sidePos = this._sideGeometry.attributes.position.array as Float32Array;
            const height = this._height;
            const edgeCount = this._sideEdgeIJ.length;
            for (let k = 0; k < edgeCount; k++) {
                const pair = this._sideEdgeIJ[k];
                const idxI = pair[0], idxJ = pair[1];
                const upperI = this._cachedHeights[idxI];
                const upperJ = this._cachedHeights[idxJ];
                const base = k * 4;
                sidePos[base * 3 + 1] = upperI;
                sidePos[(base + 1) * 3 + 1] = upperI - height;
                sidePos[(base + 2) * 3 + 1] = upperJ;
                sidePos[(base + 3) * 3 + 1] = upperJ - height;
            }
            this._sideGeometry.attributes.position.needsUpdate = true;

            if (this._builtSideHeight !== height) {
                const uvAttr = this._sideGeometry.attributes.uv;
                if (uvAttr) {
                    const sideUVs = uvAttr.array as Float32Array;
                    const patternScale = this._fillPatternScale > 0
                        ? this._fillPatternScale : DEFAULT_FILL_PATTERN_SCALE;
                    const vH = height / patternScale;
                    for (let k = 0; k < edgeCount; k++) {
                        const base = k * 8;
                        sideUVs[base + 1] = vH;
                        sideUVs[base + 5] = vH;
                    }
                    uvAttr.needsUpdate = true;
                }
                this._builtSideHeight = height;
            }
            this._sideGeometry.computeBoundingSphere();
        }

        if (!isDynamic) this._heightsFinalized = true;
        return true;
    }

    private _updateStroke(): void {
        if (this._invalidGeometry) return;
        if (!this._strokeLine || !this._strokeGeometry) return;
        const positions = this._strokePositionsArray;
        positions.length = 0;
        const groupPos = this._group.position;
        const strokeLen = this._strokeWorldCoords.length;

        for (let i = 0; i < strokeLen; i++) {
            const wc = this._strokeWorldCoords[i];
            if (!wc) continue;
            const y = this._cachedStrokeHeights[i] ?? this._altitude;
            positions.push(wc[0] - groupPos.x, y, wc[1] - groupPos.z);
        }
        if (strokeLen > 0) {
            const first = this._strokeWorldCoords[0];
            const fy = this._cachedStrokeHeights[0] ?? this._altitude;
            positions.push(first[0] - groupPos.x, fy, first[1] - groupPos.z);
        }

        if (this._useSimpleStroke) {
            const count = positions.length / 3;
            const existing = this._strokeGeometry.getAttribute('position');
            if (existing && existing.count === count) {
                (existing.array as Float32Array).set(positions);
                existing.needsUpdate = true;
                this._strokeGeometry.computeBoundingSphere();
            } else {
                this._strokeGeometry.setAttribute(
                    'position', new THREE.BufferAttribute(new Float32Array(positions), 3));
                this._strokeGeometry.computeBoundingSphere();
            }
        } else {
            this._strokeGeometry.setPositions(positions);
            this._strokeLine.computeLineDistances();
        }
    }

    private _updateCentroidScreenPos(): void {
        if (this._invalidGeometry) { this._centroidScreenPos = null; return; }
        if (!this._map || !this._centroidWorld) { this._centroidScreenPos = null; return; }
        const map = this._map;
        const wgPos = map.worldGroup.position;
        const worldX = this._centroidWorld.x + wgPos.x;
        const worldZ = this._centroidWorld.z + wgPos.z;

        let worldY = this._altitude;
        if (this._altitudeMode === 'clampToGround' && map.hasElevation) {
            const now = performance.now();
            if (now - this._lastCentroidHeightUpdateTime > this._heightUpdateInterval) {
                map.ensureTileForPoint(worldX, worldZ);
                this._cachedCentroidHeight = map.getSurfaceHeightAt(worldX, worldZ);
                this._lastCentroidHeightUpdateTime = now;
            }
            worldY = (this._cachedCentroidHeight ?? 0) + this._altitude;
        }

        if (!this._avgNodeHeightValid) {
            let sum = 0;
            const n = this._nodeHeights.length;
            for (let i = 0; i < n; i++) sum += this._nodeHeights[i] ?? 0;
            this._avgNodeHeight = n > 0 ? sum / n : 0;
            this._avgNodeHeightValid = true;
        }
        worldY += this._avgNodeHeight;
        worldY += this._minHeight + (this._extruded ? this._height : 0);

        const screenPos = map.getVec3().set(worldX, worldY + wgPos.y, worldZ);
        screenPos.project(map.camera);
        if (screenPos.z > 1 || Math.abs(screenPos.x) > 1 || Math.abs(screenPos.y) > 1) {
            this._centroidScreenPos = null;
        } else {
            const canvas = map.renderer.domElement;
            this._centroidScreenPos = {
                x: (screenPos.x * 0.5 + 0.5) * canvas.clientWidth,
                y: (-screenPos.y * 0.5 + 0.5) * canvas.clientHeight,
            };
        }
    }

    // =================================================================
    // Бounds / visual center / bbox
    // =================================================================

    getCenter(): LonLat | null {
        const b = this.getBounds('EPSG:4326');
        if (!b) return null;
        return [(b[0][0] + b[1][0]) / 2, (b[0][1] + b[1][1]) / 2];
    }

    getBounds(crs: string | any = 'EPSG:4326'): [LonLat, LonLat] | null {
        const key = typeof crs === 'string' ? crs : (crs?.code ?? 'custom');
        if (this._boundsCache.has(key)) return this._boundsCache.get(key)!;
        const result = this._computeBounds(crs);
        this._boundsCache.set(key, result);
        return result;
    }

    private _computeBounds(crs: string | any): [LonLat, LonLat] | null {
        if (!this._rings || !this._rings.length) return null;
        const src = this._crs
            ?? (this._crsCode ? Projections.get(this._crsCode) : Projections.get('EPSG:4326'));
        const dst = typeof crs === 'string' ? Projections.get(crs) : crs;
        if (!src || !dst) return null;

        const sameProjection = src === dst;
        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
        let count = 0;

        for (const ring of this._rings) {
            if (!ring) continue;
            for (const pt of ring) {
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
        }
        if (count === 0 || !isFinite(minX)) return null;
        return [[minX, minY], [maxX, maxY]];
    }

    getVisualCenter(): LonLat | null {
        if (this._visualCenterCache) return this._visualCenterCache;
        const rings = this._rings;
        if (!rings || !rings.length) return null;
        const src = this._crs
            ?? (this._crsCode ? Projections.get(this._crsCode) : Projections.get('EPSG:4326'));
        if (!src) return null;

        const wgsRings: Array<Array<[number, number]>> = rings.map(r => r.map(pt => {
            const [lon, lat] = src.toLonLat(pt);
            return [lon, lat] as [number, number];
        }));
        const vc = _approxVisualCenter(wgsRings, 0.001);
        if (!vc) return null;
        this._visualCenterCache = vc;
        return this._visualCenterCache;
    }

    /** Экранный bbox полигона в пикселях. */
    getScreenBBox(): { minX: number; minY: number; maxX: number; maxY: number;
                       width: number; height: number } | null {
        const map = this._map;
        if (!map || !this._worldCoords.length) return null;
        const wgPos = map.worldGroup.position;
        const canvas = map.renderer.domElement;
        const W = canvas.clientWidth, H = canvas.clientHeight;
        const v = map.getVec3?.() ?? new THREE.Vector3();

        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
        for (let i = 0; i < this._worldCoords.length; i++) {
            const wc = this._worldCoords[i];
            const y = this._cachedHeights[i] ?? this._altitude;
            v.set(wc[0] + wgPos.x, y + wgPos.y, wc[1] + wgPos.z).project(map.camera);
            if (v.z <= -1 || v.z >= 1) return null;
            const px = (v.x * 0.5 + 0.5) * W;
            const py = (-v.y * 0.5 + 0.5) * H;
            if (px < minX) minX = px; if (py < minY) minY = py;
            if (px > maxX) maxX = px; if (py > maxY) maxY = py;
        }
        if (!isFinite(minX)) return null;
        return { minX, minY, maxX, maxY, width: maxX - minX, height: maxY - minY };
    }

    setTooltipOnHover(on: boolean): this {
        const next = !!on;
        if (this._tooltipOnHover === next) return this;
        this._tooltipOnHover = next;
        if (this._map) this._registerInteraction(this._map);
        return this;
    }
    getTooltipOnHover(): boolean { return this._tooltipOnHover; }
}

// =====================================================================
// Approximate visual center (grid-сканер, ST_LabelPoint-style)
// =====================================================================

function _isPointInsideRings(
    rings: ReadonlyArray<ReadonlyArray<readonly [number, number]>>,
    x: number, y: number,
): boolean {
    let inside = false;
    for (const ring of rings) {
        const n = ring.length;
        if (n < 2) continue;
        for (let i = 0, j = n - 1; i < n; j = i++) {
            const a = ring[i], b = ring[j];
            if (((a[1] > y) !== (b[1] > y)) &&
                x < ((b[0] - a[0]) * (y - a[1])) / (b[1] - a[1]) + a[0]) {
                inside = !inside;
            }
        }
    }
    return inside;
}

function _minDistToRings(
    rings: ReadonlyArray<ReadonlyArray<readonly [number, number]>>,
    x: number, y: number,
): number {
    let bestSq = Infinity;
    for (const ring of rings) {
        const n = ring.length;
        if (n < 2) continue;
        for (let i = 0, j = n - 1; i < n; j = i++) {
            const a = ring[i], b = ring[j];
            const dx = b[0] - a[0], dy = b[1] - a[1];
            const l2 = dx * dx + dy * dy;
            let t = l2 > 0 ? ((x - a[0]) * dx + (y - a[1]) * dy) / l2 : 0;
            if (t < 0) t = 0; else if (t > 1) t = 1;
            const px = a[0] + t * dx, py = a[1] + t * dy;
            const ddx = x - px, ddy = y - py;
            const dSq = ddx * ddx + ddy * ddy;
            if (dSq < bestSq) bestSq = dSq;
        }
    }
    return Math.sqrt(bestSq);
}

function _approxVisualCenter(
    rings: ReadonlyArray<ReadonlyArray<readonly [number, number]>>,
    precision: number = 0,
): [number, number] | null {
    if (!rings || !rings.length) return null;

    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const ring of rings) {
        for (const p of ring) {
            if (!p) continue;
            if (p[0] < minX) minX = p[0];
            if (p[0] > maxX) maxX = p[0];
            if (p[1] < minY) minY = p[1];
            if (p[1] > maxY) maxY = p[1];
        }
    }
    if (!isFinite(minX)) return null;
    const w = maxX - minX, h = maxY - minY;
    if (w < 1e-12 || h < 1e-12) return [(minX + maxX) / 2, (minY + maxY) / 2];

    let step = Math.min(w, h) / 10;
    let bx = (minX + maxX) / 2;
    let by = (minY + maxY) / 2;
    let bestD = -1;

    for (let iter = 0; iter < 3; iter++) {
        const sx = iter === 0 ? minX : bx - step * 2.5;
        const sy = iter === 0 ? minY : by - step * 2.5;
        const ex = iter === 0 ? maxX : bx + step * 2.5;
        const ey = iter === 0 ? maxY : by + step * 2.5;

        for (let x = sx; x <= ex; x += step) {
            for (let y = sy; y <= ey; y += step) {
                if (!_isPointInsideRings(rings, x, y)) continue;
                const d = _minDistToRings(rings, x, y);
                if (d > bestD) { bestD = d; bx = x; by = y; }
            }
        }
        step /= 4;
        if (precision > 0 && step < precision) break;
    }
    return [bx, by];
}


function _getSharedPatternTexture(url: string): any {
    let tex = _sharedPatternTextures.get(url);
    if (tex) return tex;
    const loader = new THREE.TextureLoader();
    loader.setCrossOrigin('anonymous');
    tex = loader.load(url, undefined, undefined, (err: any) => {
        console.warn('Polygon: fillPattern load failed', url, err);
        _sharedPatternTextures.delete(url);
    });
    tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
    tex.generateMipmaps = false;
    tex.minFilter = THREE.LinearFilter;
    tex.magFilter = THREE.LinearFilter;
    _sharedPatternTextures.set(url, tex);
    return tex;
}