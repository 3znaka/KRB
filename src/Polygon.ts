/**
 * Polygon — полигон с заливкой, обводкой, экструзией, паттерном и подписью.
 * Геометрия — PolygonGeometry.ts, update + bounds — PolygonUpdate.ts,
 * LOD — PolygonLOD.ts, типы/утилиты — PolygonUtils.ts (реэкспортируются).
 */
import { Projections } from './Projections.js';
import { THREE } from './js_TP/tpb.js';
import { SpatialObject } from './SpatialObject.js';

import {
    type LonLat, type PolygonCoord, type PolygonRing, type PolygonOptions,
    type AltitudeMode, type FillPatternFit, type FillPatternSource, type RenderRing,
    DEFAULT_FILL_PATTERN_SCALE,
} from './PolygonUtils.js';

import { PolygonLODMixin, type PolygonLOD } from './PolygonLOD.js';
import { PolygonGeometryMixin, type PolygonGeometry } from './PolygonGeometry.js';
import { PolygonUpdateMixin, type PolygonUpdate } from './PolygonUpdate.js';

export * from './PolygonUtils.js';

export class Polygon extends SpatialObject {
    // ── Кольца / CRS ──
    _rings: PolygonRing[];
    _crsCode: string | null;
    _crs: any | null;
    _ringStartIndices: number[] = [];

    // ── Оформление ──
    _fillColor: string | number;
    _fillOpacity: number;
    _fillPatternSource: FillPatternSource;
    _fillPatternScale: number;
    _fillPatternFit: FillPatternFit;
    _fillPatternTexture: any = null;
    _fillPatternGeneration = 0;
    _strokeColor: string | number;
    _strokeWidth: number;
    _strokeOpacity: number;
    _altitudeMode: AltitudeMode;
    _tooltipOnHover: boolean;

    // ── LOD ──
    _simplify = true;
    _simplifyTolerance = 0.5;
    _simplifyZoomBucket = 1;
    _simplifyCache = new Map<number, RenderRing[]>();
    _renderRings: RenderRing[] | null = null;
    _fullRenderRings: RenderRing[] | null = null;
    _currentSimplifyBucket = -1;
    _pendingBucket = -1;
    _rebuildTimer: ReturnType<typeof setTimeout> | null = null;
    _pendingRebuild = false;

    _centroidFromOriginal: { x: number; z: number } | null = null;
    _visualCenterCache: LonLat | null = null;

    // ── Экструзия ──
    _extruded: boolean;
    _height: number;
    _minHeight: number;
    _depthTest: boolean;
    _depthWrite: boolean;
    _castShadow: boolean;
    _receiveShadow: boolean;
    _roughness: number;
    _metalness: number;
    _useSimpleStroke: boolean;
    _useWorkerForTriangulation: boolean;

    _unregisterInteraction: (() => void) | null = null;

    // ── 3D-объекты ──
    _group: any;
    _fillMesh: any = null;
    _fillGeometry: any = null;
    _fillMaterial: any = null;
    _bottomMesh: any = null;
    _bottomGeometry: any = null;
    _bottomMaterial: any = null;
    _sideMesh: any = null;
    _sideGeometry: any = null;
    _sideMaterial: any = null;
    _strokeLine: any = null;
    _strokeGeometry: any = null;
    _strokeMaterial: any = null;

    // ── Кэши ──
    _cachedHeights: number[] = [];
    _cachedStrokeHeights: number[] = [];
    _cachedTopIndices: number[] | null = null;
    _nodeHeights: number[] = [];
    _strokeNodeHeights: number[] = [];
    _lastHeightUpdateTime = 0;
    _heightUpdateInterval = 500;
    _heightsFinalized = false;
    _invalidGeometry = false;

    _vertices2D: any[] = [];
    _centroidWorld: any;
    _cachedCentroidHeight = 0;
    _lastCentroidHeightUpdateTime = 0;
    _avgNodeHeight = 0;
    _avgNodeHeightValid = false;

    _worldCoords: Array<[number, number]> = [];
    _strokeWorldCoords: Array<[number, number]> = [];

    _batch: any = null;

    _sideEdgeIJ: Array<[number, number]> = [];
    _sideEdgeLengths: number[] = [];
    _builtSideHeight = -1;

    _boundsCache = new Map<string, [LonLat, LonLat] | null>();

    _boundingSphereRadius = 0;
    _boundingSphereWorldCenter: any;
    _raycastMeshesCache: any[] | null = null;

    _heightsDirty = true;
    _lastWorldGroupPos: any;
    _lastDiscreteZoom = -1;

    _centroidScreenPos: { x: number; y: number } | null = null;
    _strokePositionsArray: number[] = [];

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
    // SpatialObject hooks
    // =================================================================

    protected _onAttached(map: any): void {
        this._crs = this._crsCode ? Projections.get(this._crsCode) : map.inputCRS;
        this._loadFillPattern();

        this._currentSimplifyBucket = Math.floor(map.currentDiscreteZoom / this._simplifyZoomBucket);
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

        if (this._batch) (this._layer as any)?._polygonBatcher?.markDirty?.();
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
        if (this._fillPatternSource != null && typeof this._fillPatternSource !== 'string') return null;
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

    _invalidateBatch(): void {
        if (!this._batch) return;
        const batcher = (this._layer as any)?._polygonBatcher;
        if (batcher && typeof batcher.markDirty === 'function') batcher.markDirty();
    }

    // =================================================================
    // Interaction
    // =================================================================

    _registerInteraction(map: any): void {
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
                return { center: this._boundingSphereWorldCenter, radius: this._boundingSphereRadius };
            },
            isVisible: () => this._group.visible,
        };
        if (this._onHover) callbacks.onHover = (h: boolean) => this._onHover!(h);
        else if (wantTooltip) callbacks.getTooltip = () => this._tooltipText;
        if (this._onClick) callbacks.onClick = (e: MouseEvent) => this._onClick!(e, this);

        this._unregisterInteraction = map.interaction.register(this, callbacks);
    }

    /** @internal */
    _getRaycastMeshes(): any[] {
        if (this._raycastMeshesCache) return this._raycastMeshesCache;
        const meshes: any[] = [];
        if (this._fillMesh) meshes.push(this._fillMesh);
        if (this._sideMesh) meshes.push(this._sideMesh);
        if (this._bottomMesh) meshes.push(this._bottomMesh);
        this._raycastMeshesCache = meshes;
        return meshes;
    }

    // =================================================================
    // Rings
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

        if (!this._map) { this._currentSimplifyBucket = -1; return this; }
        this._currentSimplifyBucket =
            Math.floor(this._map.currentDiscreteZoom / this._simplifyZoomBucket);
        this._rebuildGeometry();
        this._invalidateBatch();
        return this;
    }

    getRings(): PolygonRing[] {
        return this._rings.map(ring => ring.map(pt => [...pt] as PolygonCoord));
    }

    _rebuildGeometry(): void {
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

    // =================================================================
    // Style setters
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
            if (mat.transparent !== transparent) { mat.transparent = transparent; mat.needsUpdate = true; }
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
        if (mat && 'linewidth' in mat) { mat.linewidth = width; mat.needsUpdate = true; }
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
            if (mat.transparent !== transparent) { mat.transparent = transparent; mat.needsUpdate = true; }
        }
        this._invalidateBatch();
        return this;
    }
    getStrokeOpacity(): number { return this._strokeOpacity; }

    // =================================================================
    // Altitude / extrusion / depth
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
}

export interface Polygon extends PolygonLOD, PolygonGeometry, PolygonUpdate {}

Object.assign(Polygon.prototype,
    PolygonLODMixin, PolygonGeometryMixin, PolygonUpdateMixin);