/**
 * Polygon — полигон с заливкой, обводкой, экструзией, паттерном и подписью.
 * Геометрия — PolygonGeometry.ts, update + bounds — PolygonUpdate.ts,
 * LOD — PolygonLOD.ts, типы/утилиты — PolygonUtils.ts (реэкспортируются).
 */
import { Projections } from './Projections.js';
import { THREE } from './js_TP/tpb.js';
import { SpatialObject } from './SpatialObject.js';
import { DEFAULT_FILL_PATTERN_SCALE, } from './PolygonUtils.js';
import { PolygonLODMixin } from './PolygonLOD.js';
import { PolygonGeometryMixin } from './PolygonGeometry.js';
import { PolygonUpdateMixin } from './PolygonUpdate.js';
export * from './PolygonUtils.js';
export class Polygon extends SpatialObject {
    // ── Кольца / CRS ──
    _rings;
    _crsCode;
    _crs;
    _ringStartIndices = [];
    // ── Оформление ──
    _fillColor;
    _fillOpacity;
    _fillPatternSource;
    _fillPatternScale;
    _fillPatternFit;
    _fillPatternTexture = null;
    _fillPatternGeneration = 0;
    _strokeColor;
    _strokeWidth;
    _strokeOpacity;
    _altitudeMode;
    _tooltipOnHover;
    // ── LOD ──
    _simplify = true;
    _simplifyTolerance = 0.5;
    _simplifyZoomBucket = 1;
    _simplifyCache = new Map();
    _renderRings = null;
    _fullRenderRings = null;
    _currentSimplifyBucket = -1;
    _pendingBucket = -1;
    _rebuildTimer = null;
    _pendingRebuild = false;
    _centroidFromOriginal = null;
    _visualCenterCache = null;
    // ── Экструзия ──
    _extruded;
    _height;
    _minHeight;
    _depthTest;
    _depthWrite;
    _castShadow;
    _receiveShadow;
    _roughness;
    _metalness;
    _useSimpleStroke;
    _useWorkerForTriangulation;
    _unregisterInteraction = null;
    // ── 3D-объекты ──
    _group;
    _fillMesh = null;
    _fillGeometry = null;
    _fillMaterial = null;
    _bottomMesh = null;
    _bottomGeometry = null;
    _bottomMaterial = null;
    _sideMesh = null;
    _sideGeometry = null;
    _sideMaterial = null;
    _strokeLine = null;
    _strokeGeometry = null;
    _strokeMaterial = null;
    // ── Кэши ──
    _cachedHeights = [];
    _cachedStrokeHeights = [];
    _cachedTopIndices = null;
    _nodeHeights = [];
    _strokeNodeHeights = [];
    _lastHeightUpdateTime = 0;
    _heightUpdateInterval = 500;
    _heightsFinalized = false;
    _invalidGeometry = false;
    _vertices2D = [];
    _centroidWorld;
    _cachedCentroidHeight = 0;
    _lastCentroidHeightUpdateTime = 0;
    _avgNodeHeight = 0;
    _avgNodeHeightValid = false;
    _worldCoords = [];
    _strokeWorldCoords = [];
    _batch = null;
    _sideEdgeIJ = [];
    _sideEdgeLengths = [];
    _builtSideHeight = -1;
    _boundsCache = new Map();
    _boundingSphereRadius = 0;
    _boundingSphereWorldCenter;
    _raycastMeshesCache = null;
    _heightsDirty = true;
    _lastWorldGroupPos;
    _lastDiscreteZoom = -1;
    _centroidScreenPos = null;
    _strokePositionsArray = [];
    constructor(options) {
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
        if (options.zoomInterpolate)
            this.setZoomInterpolations(options.zoomInterpolate);
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
    _onAttached(map) {
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
        this._layer?._polygonBatcher?.markDirty?.();
    }
    _teardown() {
        this._fillPatternGeneration++;
        if (this._rebuildTimer) {
            clearTimeout(this._rebuildTimer);
            this._rebuildTimer = null;
        }
        this._pendingBucket = -1;
        this._pendingRebuild = false;
        if (this._batch)
            this._layer?._polygonBatcher?.markDirty?.();
        if (this._batch) {
            const b = this._batch;
            this._batch = null;
            b.__batcher?.markDirty?.();
        }
        if (this._unregisterInteraction) {
            this._unregisterInteraction();
            this._unregisterInteraction = null;
        }
        this._disposeMeshes();
        if (this._group.parent)
            this._group.parent.remove(this._group);
        if (this._fillPatternTexture) {
            try {
                this._fillPatternTexture.dispose?.();
            }
            catch { /* swallow */ }
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
    _applyHidden() {
        if (this._group)
            this._group.visible = false;
        this._centroidScreenPos = null;
    }
    _onTooltipChanged() {
        if (this._map)
            this._registerInteraction(this._map);
    }
    _onAltitudeChanged() {
        this._heightsDirty = true;
        this._heightsFinalized = false;
        this._lastHeightUpdateTime = 0;
        this._lastCentroidHeightUpdateTime = 0;
    }
    getLabelType() { return 'polygon'; }
    getScreenPosition() {
        return this._isVisible ? this._centroidScreenPos : null;
    }
    // =================================================================
    // Batch hooks
    // =================================================================
    _getBatchStyleKey() {
        if (this._invalidGeometry)
            return null;
        if (this._tooltipText)
            return null;
        if (this._onHover)
            return null;
        if (this._fillPatternSource != null && typeof this._fillPatternSource !== 'string')
            return null;
        if (!this._useSimpleStroke && this._strokeWidth > 1 && this._strokeOpacity > 0)
            return null;
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
    _getBatchGeometryData() {
        if (this._invalidGeometry)
            return null;
        if (!this._worldCoords.length)
            return null;
        let indices;
        if (this._cachedTopIndices) {
            indices = this._cachedTopIndices;
        }
        else if (this._fillGeometry?.index) {
            const arr = this._fillGeometry.index.array;
            this._cachedTopIndices = Array.from(arr);
            indices = this._cachedTopIndices;
        }
        else {
            const computed = this._triangulateFromRings();
            if (!computed.length)
                return null;
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
    _onBatchChange(batched, _batch) {
        if (batched) {
            if (this._unregisterInteraction) {
                this._unregisterInteraction();
                this._unregisterInteraction = null;
            }
            if (this._group)
                this._group.visible = false;
            if (this._fillPatternTexture) {
                try {
                    this._fillPatternTexture.dispose?.();
                }
                catch { /* swallow */ }
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
        }
        else {
            if (!this._fillPatternTexture && this._fillPatternSource)
                this._loadFillPattern();
            if (this._map)
                this._rebuildGeometry();
            if (this._group)
                this._group.visible = true;
            if (this._map)
                this._registerInteraction(this._map);
            this._heightsDirty = true;
            this._heightsFinalized = false;
        }
    }
    _invalidateBatch() {
        if (!this._batch)
            return;
        const batcher = this._layer?._polygonBatcher;
        if (batcher && typeof batcher.markDirty === 'function')
            batcher.markDirty();
    }
    // =================================================================
    // Interaction
    // =================================================================
    _registerInteraction(map) {
        if (!map.interaction || typeof map.interaction.register !== 'function')
            return;
        if (this._unregisterInteraction) {
            this._unregisterInteraction();
            this._unregisterInteraction = null;
        }
        if (this._invalidGeometry)
            return;
        const wantTooltip = !!this._tooltipText && this._tooltipOnHover;
        if (!this._onClick && !this._onHover && !wantTooltip)
            return;
        const callbacks = {
            getMeshes: () => this._getRaycastMeshes(),
            getBoundingSphere: () => {
                if (this._boundingSphereRadius <= 0)
                    return null;
                const wgPos = map.worldGroup.position;
                this._boundingSphereWorldCenter.set(this._group.position.x + wgPos.x, this._group.position.y + wgPos.y, this._group.position.z + wgPos.z);
                return { center: this._boundingSphereWorldCenter, radius: this._boundingSphereRadius };
            },
            isVisible: () => this._group.visible,
        };
        if (this._onHover)
            callbacks.onHover = (h) => this._onHover(h);
        else if (wantTooltip)
            callbacks.getTooltip = () => this._tooltipText;
        if (this._onClick)
            callbacks.onClick = (e) => this._onClick(e, this);
        this._unregisterInteraction = map.interaction.register(this, callbacks);
    }
    /** @internal */
    _getRaycastMeshes() {
        if (this._raycastMeshesCache)
            return this._raycastMeshesCache;
        const meshes = [];
        if (this._fillMesh)
            meshes.push(this._fillMesh);
        if (this._sideMesh)
            meshes.push(this._sideMesh);
        if (this._bottomMesh)
            meshes.push(this._bottomMesh);
        this._raycastMeshesCache = meshes;
        return meshes;
    }
    // =================================================================
    // Rings
    // =================================================================
    setRings(rings) {
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
    getRings() {
        return this._rings.map(ring => ring.map(pt => [...pt]));
    }
    _rebuildGeometry() {
        if (!this._map)
            return;
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
    setFillColor(color) {
        this._fillColor = color;
        if (this._fillMaterial?.color)
            this._fillMaterial.color.set(color);
        if (this._bottomMaterial?.color)
            this._bottomMaterial.color.set(color);
        if (this._sideMaterial?.color)
            this._sideMaterial.color.set(color);
        this._invalidateBatch();
        return this;
    }
    getFillColor() { return this._fillColor; }
    setFillOpacity(opacity) {
        this._fillOpacity = Math.max(0, Math.min(1, opacity));
        const transparent = this._fillOpacity < 1;
        for (const mat of [this._fillMaterial, this._bottomMaterial, this._sideMaterial]) {
            if (!mat)
                continue;
            mat.opacity = this._fillOpacity;
            if (mat.transparent !== transparent) {
                mat.transparent = transparent;
                mat.needsUpdate = true;
            }
        }
        this._invalidateBatch();
        return this;
    }
    getFillOpacity() { return this._fillOpacity; }
    setFillPattern(source) {
        if (this._fillPatternTexture) {
            try {
                this._fillPatternTexture.dispose?.();
            }
            catch { /* swallow */ }
            this._fillPatternTexture = null;
        }
        this._fillPatternSource = source;
        if (!this._map)
            return this;
        this._loadFillPattern();
        this._applyFillPatternToMaterials();
        this._invalidateBatch();
        return this;
    }
    getFillPattern() { return this._fillPatternSource; }
    setFillPatternScale(scale) {
        if (!(scale > 0))
            return this;
        if (this._fillPatternScale === scale)
            return this;
        this._fillPatternScale = scale;
        if (this._map)
            this._updateFillUVs();
        this._invalidateBatch();
        return this;
    }
    getFillPatternScale() { return this._fillPatternScale; }
    setFillPatternFit(fit) {
        if (this._fillPatternFit === fit)
            return this;
        this._fillPatternFit = fit;
        if (this._map)
            this._updateFillUVs();
        this._invalidateBatch();
        return this;
    }
    getFillPatternFit() { return this._fillPatternFit; }
    setStrokeColor(color) {
        this._strokeColor = color;
        if (this._strokeMaterial?.color)
            this._strokeMaterial.color.set(color);
        this._invalidateBatch();
        return this;
    }
    getStrokeColor() { return this._strokeColor; }
    setStrokeWidth(width) {
        if (!(width >= 0))
            return this;
        this._strokeWidth = width;
        const mat = this._strokeMaterial;
        if (mat && 'linewidth' in mat) {
            mat.linewidth = width;
            mat.needsUpdate = true;
        }
        this._invalidateBatch();
        return this;
    }
    getStrokeWidth() { return this._strokeWidth; }
    setStrokeOpacity(opacity) {
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
    getStrokeOpacity() { return this._strokeOpacity; }
    // =================================================================
    // Altitude / extrusion / depth
    // =================================================================
    setAltitudeOffset(offset) { return this.setAltitude(offset); }
    getAltitudeOffset() { return this.getAltitude(); }
    setAltitudeMode(mode) {
        this._altitudeMode = mode;
        this._onAltitudeChanged();
        return this;
    }
    getAltitudeMode() { return this._altitudeMode; }
    setExtruded(extruded) {
        const next = !!extruded;
        if (this._extruded === next)
            return this;
        this._extruded = next;
        if (next && this._height <= 0) {
            console.warn('Polygon.setExtruded: height is 0, side walls will be flat');
        }
        if (this._map)
            this._rebuildGeometry();
        this._invalidateBatch();
        return this;
    }
    getExtruded() { return this._extruded; }
    setHeight(height) {
        if (!(height >= 0) || this._height === height)
            return this;
        this._height = height;
        if (this._extruded) {
            this._heightsDirty = true;
            this._heightsFinalized = false;
        }
        this._invalidateBatch();
        return this;
    }
    getHeight() { return this._height; }
    setMinHeight(height) {
        if (!(height >= 0) || this._minHeight === height)
            return this;
        this._minHeight = height;
        this._heightsDirty = true;
        this._heightsFinalized = false;
        this._invalidateBatch();
        return this;
    }
    getMinHeight() { return this._minHeight; }
    setDepthTest(depthTest) {
        this._depthTest = !!depthTest;
        this._applyDepthFlags();
        this._invalidateBatch();
        return this;
    }
    getDepthTest() { return this._depthTest; }
    setDepthWrite(depthWrite) {
        this._depthWrite = !!depthWrite;
        this._applyDepthFlags();
        this._invalidateBatch();
        return this;
    }
    getDepthWrite() { return this._depthWrite; }
    _applyDepthFlags() {
        for (const mat of [this._fillMaterial, this._bottomMaterial, this._sideMaterial, this._strokeMaterial]) {
            if (!mat)
                continue;
            let changed = false;
            if (mat.depthTest !== this._depthTest) {
                mat.depthTest = this._depthTest;
                changed = true;
            }
            if (mat.depthWrite !== this._depthWrite) {
                mat.depthWrite = this._depthWrite;
                changed = true;
            }
            if (changed)
                mat.needsUpdate = true;
        }
    }
}
Object.assign(Polygon.prototype, PolygonLODMixin, PolygonGeometryMixin, PolygonUpdateMixin);
