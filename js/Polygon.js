/**
 * Polygon — полигон с заливкой, обводкой, экструзией, паттерном и подписью.
 * После `addTo()` мутабелен.
 *
 * Наследует SpatialObject: zoom bounds, видимость, tooltip, onClick,
 * onHover, подпись, TextManager-контракт и altitude берутся из базы.
 *
 * @module polygon
 */
import { Projections } from './Projections.js';
import { THREE, Line2, LineMaterial, LineGeometry } from './js_TP/tpb.js';
import { SpatialObject } from './SpatialObject.js';
import earcut from './js_TP/earcut.js';
export const POLYGON_RENDER_ORDER = {
    BOTTOM: 900,
    SIDE: 901,
    TOP: 902,
    STROKE: 903,
};
const INVALID_EDGE_FRACTION = 8;
const DEFAULT_FILL_PATTERN_SCALE = 64;
function crossY(p0, p1, p2) {
    const dx1 = p1.x - p0.x, dz1 = p1.y - p0.y;
    const dx2 = p2.x - p0.x, dz2 = p2.y - p0.y;
    return dz1 * dx2 - dx1 * dz2;
}
// =====================================================================
// Polygon
// =====================================================================
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
    /**
     * Монотонный счётчик поколений загрузки текстуры. onLoad-callback,
     * чьё поколение устарело, сам dispose'ит свою текстуру и выходит.
     */
    _fillPatternGeneration = 0;
    _strokeColor;
    _strokeWidth;
    _strokeOpacity;
    _altitudeMode;
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
    // ── Интерактив ──
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
    /** Среднее по `_nodeHeights`. Кэш; инвалидация — при rebuild. */
    _avgNodeHeight = 0;
    _avgNodeHeightValid = false;
    _worldCoords = [];
    _strokeWorldCoords = [];
    _batch = null;
    /**
     * Layout боковых рёбер: `[idxI, idxJ]` для каждого ребра
     * (индексы в `_cachedHeights` / `_vertices2D`). Нужен для
     * корректного обновления высот стенок у полигонов с дырками.
     */
    _sideEdgeIJ = [];
    /** Длины рёбер стенок — для пересчёта UV при `setFillPatternScale`. */
    _sideEdgeLengths = [];
    /** `_height`, при которой построены UV стенок. −1 = невалидно. */
    _builtSideHeight = -1;
    /** Кэш `getBounds` по коду CRS. */
    _boundsCache = new Map();
    _boundingSphereRadius = 0;
    _boundingSphereWorldCenter;
    _raycastMeshesCache = null;
    _heightsDirty = true;
    _lastWorldGroupPos;
    _lastDiscreteZoom = -1;
    _centroidScreenPos = null;
    _strokePositionsArray = [];
    _sidePositionsArray = [];
    _sideIndicesArray = [];
    constructor(options) {
        super();
        this._properties = options.properties ?? {};
        this._userData = options.userData ?? {};
        if (!options.rings || !options.rings.length || !options.rings[0].length) {
            throw new Error('Polygon: options.rings required with at least one ring');
        }
        this._rings = options.rings;
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
    // Хуки SpatialObject
    // =================================================================
    _onAttached(map) {
        this._crs = this._crsCode
            ? Projections.get(this._crsCode)
            : map.inputCRS;
        this._loadFillPattern();
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
    }
    _teardown() {
        this._fillPatternGeneration++;
        if (this._batch) {
            const b = this._batch;
            this._batch = null;
            // Просим батчер пересобраться без этого полигона.
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
        return this._centroidScreenPos;
    }
    isVisible() {
        return this._group?.visible ?? false;
    }
    /** @internal */
    _getBatchStyleKey() {
        if (this._invalidGeometry)
            return null;
        if (this._tooltipText)
            return null;
        if (this._onHover)
            return null;
        if (this._zoomInterpolations)
            return null;
        if (this._fillPatternSource != null
            && typeof this._fillPatternSource !== 'string')
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
        ].join('|');
    }
    /** @internal */
    _getBatchGeometryData() {
        if (this._invalidGeometry || !this._fillGeometry)
            return null;
        const idxAttr = this._fillGeometry.index;
        if (!idxAttr)
            return null;
        // heights — это Y TOP-вершин (для не-extruded это и есть плоскость).
        // Для extruded bottom = heights[i] - height.
        const extrude = this._extruded ? this._height : 0;
        const base = this._altitude + this._minHeight + extrude;
        const heights = new Array(this._worldCoords.length);
        for (let i = 0; i < heights.length; i++) {
            heights[i] = base + (this._nodeHeights[i] ?? 0);
        }
        return {
            worldCoords: this._worldCoords,
            heights,
            indices: idxAttr.array,
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
            // Свою сцену гасим, интерактив снимаем, текстуру паттерна
            // освобождаем (батч держит свою).
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
        }
        else {
            if (this._group)
                this._group.visible = true;
            if (this._map) {
                if (!this._fillPatternTexture && this._fillPatternSource) {
                    this._loadFillPattern();
                    this._applyFillPatternToMaterials();
                }
                this._registerInteraction(this._map);
            }
            this._heightsDirty = true;
            this._heightsFinalized = false;
        }
    }
    /** @internal — дергаем из каждого сеттера стиля. */
    _invalidateBatch() {
        if (!this._batch)
            return;
        const batcher = this._layer?._polygonBatcher;
        if (batcher && typeof batcher.markDirty === 'function') {
            batcher.markDirty();
        }
    }
    // =================================================================
    // Интерактив
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
        if (!this._onClick && !this._onHover && !this._tooltipText)
            return;
        const callbacks = {
            getMeshes: () => this._getRaycastMeshes(),
            getBoundingSphere: () => {
                if (this._boundingSphereRadius <= 0)
                    return null;
                const wgPos = map.worldGroup.position;
                this._boundingSphereWorldCenter.set(this._group.position.x + wgPos.x, this._group.position.y + wgPos.y, this._group.position.z + wgPos.z);
                return {
                    center: this._boundingSphereWorldCenter,
                    radius: this._boundingSphereRadius,
                };
            },
            isVisible: () => this._group.visible,
        };
        if (this._onHover) {
            callbacks.onHover = (isHovered) => this._onHover(isHovered);
        }
        else if (this._tooltipText) {
            callbacks.getTooltip = () => this._tooltipText;
        }
        if (this._onClick) {
            callbacks.onClick = (event) => this._onClick(event, this);
        }
        this._unregisterInteraction = map.interaction.register(this, callbacks);
    }
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
    // Кольца
    // =================================================================
    setRings(rings) {
        if (!rings || !rings.length || rings[0].length < 3) {
            console.warn('Polygon.setRings: need at least one ring with 3+ points');
            return this;
        }
        this._rings = rings;
        this._boundsCache.clear();
        if (!this._map)
            return this;
        this._rebuildGeometry();
        return this;
    }
    getRings() {
        return this._rings.map(ring => ring.map(pt => [...pt]));
    }
    _rebuildGeometry() {
        if (!this._map)
            return;
        this._disposeMeshes();
        this._worldCoords.length = 0;
        this._strokeWorldCoords.length = 0;
        this._nodeHeights.length = 0;
        this._strokeNodeHeights.length = 0;
        this._ringStartIndices.length = 0;
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
    }
    _disposeMeshes() {
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
        this._fillMesh = null;
        this._fillGeometry = null;
        this._fillMaterial = null;
        this._bottomMesh = null;
        this._bottomGeometry = null;
        this._bottomMaterial = null;
        this._sideMesh = null;
        this._sideGeometry = null;
        this._sideMaterial = null;
        this._strokeLine = null;
        this._strokeGeometry = null;
        this._strokeMaterial = null;
        this._raycastMeshesCache = null;
    }
    // =================================================================
    // Fill pattern
    // =================================================================
    _loadFillPattern() {
        const src = this._fillPatternSource;
        const generation = ++this._fillPatternGeneration;
        if (!src) {
            this._fillPatternTexture = null;
            return;
        }
        if (typeof src === 'string') {
            const loader = new THREE.TextureLoader();
            loader.setCrossOrigin('anonymous');
            const tex = loader.load(src, (loaded) => {
                // Защита от stale-callback: пока грузилась текстура,
                // могли вызвать setFillPattern()/remove().
                if (generation !== this._fillPatternGeneration) {
                    try {
                        loaded?.dispose?.();
                    }
                    catch { /* swallow */ }
                    return;
                }
                this._configureFillPatternTexture();
                this._applyFillPatternToMaterials();
            }, undefined, (err) => {
                if (generation !== this._fillPatternGeneration)
                    return;
                console.warn('Polygon: fillPattern load failed', err);
            });
            this._fillPatternTexture = tex;
            this._configureFillPatternTexture();
        }
        else if (typeof HTMLCanvasElement !== 'undefined' && src instanceof HTMLCanvasElement) {
            this._fillPatternTexture = new THREE.CanvasTexture(src);
            this._configureFillPatternTexture();
        }
        else {
            this._fillPatternTexture = new THREE.Texture(src);
            this._fillPatternTexture.needsUpdate = true;
            this._configureFillPatternTexture();
        }
    }
    _configureFillPatternTexture() {
        const t = this._fillPatternTexture;
        if (!t)
            return;
        t.wrapS = THREE.RepeatWrapping;
        t.wrapT = THREE.RepeatWrapping;
        // Mipmap при больших UV выбирает 1×1 level → сплошной блюр.
        t.generateMipmaps = false;
        t.minFilter = THREE.LinearFilter;
        t.magFilter = THREE.LinearFilter;
        const renderer = this._map?.renderer;
        const caps = renderer?.capabilities;
        if (caps && typeof caps.getMaxAnisotropy === 'function') {
            try {
                t.anisotropy = Math.min(16, caps.getMaxAnisotropy());
            }
            catch { /* swallow */ }
        }
        const Ctor = THREE;
        if (Ctor.SRGBColorSpace && !t.colorSpace) {
            t.colorSpace = Ctor.SRGBColorSpace;
        }
        t.needsUpdate = true;
    }
    _applyFillPatternToMaterials() {
        const map = this._fillPatternTexture;
        for (const mat of [this._fillMaterial, this._bottomMaterial, this._sideMaterial]) {
            if (!mat)
                continue;
            mat.map = map;
            mat.needsUpdate = true;
        }
    }
    // =================================================================
    // UV-логика (общая для build и update)
    // =================================================================
    _computeUVParams(patternScale) {
        if (this._fillPatternFit === 'bounds') {
            let minPX = Infinity, maxPX = -Infinity;
            let minPZ = Infinity, maxPZ = -Infinity;
            for (const wc of this._worldCoords) {
                if (!wc)
                    continue;
                if (wc[0] < minPX)
                    minPX = wc[0];
                if (wc[0] > maxPX)
                    maxPX = wc[0];
                if (wc[1] < minPZ)
                    minPZ = wc[1];
                if (wc[1] > maxPZ)
                    maxPZ = wc[1];
            }
            return {
                originX: isFinite(minPX) ? minPX : 0,
                originZ: isFinite(minPZ) ? minPZ : 0,
                scaleX: (maxPX - minPX) > 1e-6 ? (maxPX - minPX) : 1,
                scaleZ: (maxPZ - minPZ) > 1e-6 ? (maxPZ - minPZ) : 1,
            };
        }
        // tile: anchor в ближайшем кратном patternScale от центроида.
        // UV маленькие (точность float32 работает), тайлинг между
        // соседями сохраняется (anchor отличается на N*patternScale
        // → эквивалентно через RepeatWrapping).
        return {
            originX: Math.floor(this._centroidWorld.x / patternScale) * patternScale,
            originZ: Math.floor(this._centroidWorld.z / patternScale) * patternScale,
            scaleX: patternScale,
            scaleZ: patternScale,
        };
    }
    /**
     * Пересчитывает UV-атрибуты существующих геометрий без dispose и
     * повторного earcut. Дёшево (O(vertexCount)) — можно вызывать из
     * `setFillPatternScale`/`setFillPatternFit` без риска для FPS.
     */
    _updateFillUVs() {
        if (this._invalidGeometry)
            return;
        if (!this._fillGeometry)
            return;
        const patternScale = this._fillPatternScale > 0
            ? this._fillPatternScale
            : DEFAULT_FILL_PATTERN_SCALE;
        const params = this._computeUVParams(patternScale);
        const worldCoords = this._worldCoords;
        const n = worldCoords.length;
        // ── Top ──
        const topAttr = this._fillGeometry.attributes.uv;
        if (topAttr) {
            const topUVs = topAttr.array;
            for (let i = 0; i < n; i++) {
                const wc = worldCoords[i];
                if (!wc)
                    continue;
                topUVs[i * 2] = (wc[0] - params.originX) / params.scaleX;
                topUVs[i * 2 + 1] = (wc[1] - params.originZ) / params.scaleZ;
            }
            topAttr.needsUpdate = true;
        }
        // ── Bottom (переиспользует top) ──
        if (this._bottomGeometry) {
            const botAttr = this._bottomGeometry.attributes.uv;
            if (botAttr && topAttr) {
                botAttr.array.set(topAttr.array);
                botAttr.needsUpdate = true;
            }
        }
        // ── Side: U вдоль ребра, V по высоте. Side всегда использует
        //    patternScale (не bbox), поэтому смена fit на стороны не
        //    влияет — но при смене scale U надо пересчитать. ──
        if (this._sideGeometry && this._sideEdgeLengths.length > 0) {
            const sideAttr = this._sideGeometry.attributes.uv;
            if (sideAttr) {
                const sideUVs = sideAttr.array;
                const vH = this._height / patternScale;
                let cum = 0;
                const edgeCount = this._sideEdgeLengths.length;
                for (let k = 0; k < edgeCount; k++) {
                    const edgeLen = this._sideEdgeLengths[k];
                    const base = k * 8;
                    const u0 = cum / patternScale;
                    const u1 = (cum + edgeLen) / patternScale;
                    sideUVs[base + 0] = u0;
                    sideUVs[base + 1] = vH;
                    sideUVs[base + 2] = u0;
                    sideUVs[base + 3] = 0;
                    sideUVs[base + 4] = u1;
                    sideUVs[base + 5] = vH;
                    sideUVs[base + 6] = u1;
                    sideUVs[base + 7] = 0;
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
    _createSurfaceMaterial() {
        const isTransparent = this._fillOpacity < 1;
        const map = this._fillPatternTexture;
        const patternProps = map ? { map } : {};
        if (this._extruded) {
            return new THREE.MeshStandardMaterial({
                color: this._fillColor,
                opacity: this._fillOpacity,
                transparent: isTransparent,
                side: THREE.DoubleSide,
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
            side: THREE.DoubleSide,
            depthTest: this._depthTest,
            depthWrite: this._depthWrite,
            polygonOffset: true,
            polygonOffsetFactor: -1,
            polygonOffsetUnits: -1,
            ...patternProps,
        });
    }
    _applyShadowFlags(mesh) {
        if (!mesh)
            return;
        if (this._extruded) {
            mesh.castShadow = this._castShadow;
            mesh.receiveShadow = this._receiveShadow;
        }
        else {
            mesh.castShadow = false;
            mesh.receiveShadow = false;
        }
    }
    _flipIndices(indices) {
        const result = new Array(indices.length);
        for (let i = 0; i < indices.length; i += 3) {
            result[i] = indices[i];
            result[i + 1] = indices[i + 2];
            result[i + 2] = indices[i + 1];
        }
        return result;
    }
    _hasAntimeridianWrap() {
        if (!this._crs || !this._crs.isGeographic)
            return false;
        const rings = this._rings;
        if (!rings)
            return false;
        for (let r = 0; r < rings.length; r++) {
            const ring = rings[r];
            if (!ring || ring.length < 2)
                continue;
            const n = ring.length;
            for (let i = 0; i < n; i++) {
                const a = ring[i];
                const b = ring[(i + 1) % n];
                if (!a || !b || a.length < 2 || b.length < 2)
                    continue;
                if (Math.abs(b[0] - a[0]) > 180)
                    return true;
            }
        }
        return false;
    }
    _isGeometryInvalid(ringStartIndices, worldSize) {
        const maxEdge = worldSize / INVALID_EDGE_FRACTION;
        const maxEdgeSq = maxEdge * maxEdge;
        const wc = this._worldCoords;
        for (let ringIdx = 0; ringIdx < ringStartIndices.length; ringIdx++) {
            const start = ringStartIndices[ringIdx];
            if (start === undefined)
                continue;
            const nextStart = (ringIdx + 1 < ringStartIndices.length)
                ? ringStartIndices[ringIdx + 1]
                : wc.length;
            const count = nextStart - start;
            if (count < 2)
                continue;
            for (let i = 0; i < count; i++) {
                const a = wc[start + i];
                const b = wc[start + ((i + 1) % count)];
                if (!a || !b)
                    continue;
                const dx = b[0] - a[0];
                const dz = b[1] - a[1];
                if (dx * dx + dz * dz > maxEdgeSq)
                    return true;
            }
        }
        return false;
    }
    _buildFillGeometry(map) {
        const rings = this._rings;
        if (!rings || !rings.length || rings[0].length < 3) {
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
        const coords = [];
        const points2D = [];
        const holeIndices = [];
        const ringStartIndices = [];
        for (let ringIdx = 0; ringIdx < rings.length; ringIdx++) {
            const ring = rings[ringIdx];
            if (ring.length < 3) {
                console.warn(`Polygon: hole ring ${ringIdx} must have at least 3 points`);
                continue;
            }
            ringStartIndices.push(points2D.length);
            this._ringStartIndices.push(points2D.length);
            if (ringIdx > 0) {
                holeIndices.push(coords.length / 2);
            }
            let firstPoint = null;
            for (let i = 0; i < ring.length; i++) {
                const pt = ring[i];
                const [absX, absZ] = map.project(pt, this._crs);
                if (i === 0)
                    firstPoint = [absX, absZ];
                if (i > 0 && firstPoint && absX === firstPoint[0] && absZ === firstPoint[1])
                    continue;
                coords.push(absX, absZ);
                points2D.push(new THREE.Vector2(absX, absZ));
                this._worldCoords.push([absX, absZ]);
                const h = pt?.[2];
                this._nodeHeights.push(Number.isFinite(h) ? h : 0);
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
        let cx = 0, cy = 0;
        for (const pt of points2D) {
            cx += pt.x;
            cy += pt.y;
        }
        cx /= points2D.length;
        cy /= points2D.length;
        this._centroidWorld.set(cx, 0, cy);
        this._group.position.copy(this._centroidWorld);
        for (let i = 0; i < points2D.length; i++) {
            points2D[i].x -= cx;
            points2D[i].y -= cy;
        }
        let maxRadiusSq = 0;
        for (const pt of points2D) {
            const rSq = pt.x * pt.x + pt.y * pt.y;
            if (rSq > maxRadiusSq)
                maxRadiusSq = rSq;
        }
        this._boundingSphereRadius = Math.sqrt(maxRadiusSq);
        // ── UV top/bottom ──
        const patternScale = this._fillPatternScale > 0
            ? this._fillPatternScale
            : DEFAULT_FILL_PATTERN_SCALE;
        const uvParams = this._computeUVParams(patternScale);
        const topUVs = new Float32Array(points2D.length * 2);
        for (let i = 0; i < points2D.length; i++) {
            const wc = this._worldCoords[i];
            const wx = wc ? wc[0] : 0;
            const wz = wc ? wc[1] : 0;
            topUVs[i * 2] = (wx - uvParams.originX) / uvParams.scaleX;
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
        for (let i = 0; i < points2D.length; i++)
            topNormals[i * 3 + 1] = 1;
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
            for (let i = 0; i < points2D.length; i++)
                bottomNormals[i * 3 + 1] = -1;
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
            const sidePositions = this._sidePositionsArray;
            const sideIndices = this._sideIndicesArray;
            sidePositions.length = 0;
            sideIndices.length = 0;
            const sideUVs = [];
            const sideUvScale = patternScale;
            const initialHeight = this._height;
            for (let ringIdx = 0; ringIdx < rings.length; ringIdx++) {
                if (ringStartIndices[ringIdx] === undefined)
                    continue;
                const start = ringStartIndices[ringIdx];
                const nextRingStart = (ringIdx + 1 < ringStartIndices.length)
                    ? ringStartIndices[ringIdx + 1]
                    : points2D.length;
                const count = nextRingStart - start;
                if (count < 2)
                    continue;
                let cum = 0;
                for (let i = 0; i < count; i++) {
                    const j = (i + 1) % count;
                    const idxI = start + i;
                    const idxJ = start + j;
                    const topI = points2D[idxI];
                    const topJ = points2D[idxJ];
                    const baseIndex = sidePositions.length / 3;
                    sidePositions.push(topI.x, initialHeight, topI.y);
                    sidePositions.push(topI.x, 0, topI.y);
                    sidePositions.push(topJ.x, initialHeight, topJ.y);
                    sidePositions.push(topJ.x, 0, topJ.y);
                    const ddx = topJ.x - topI.x;
                    const ddz = topJ.y - topI.y;
                    const edgeLen = Math.sqrt(ddx * ddx + ddz * ddz);
                    const u0 = cum / sideUvScale;
                    const u1 = (cum + edgeLen) / sideUvScale;
                    const vH = initialHeight / sideUvScale;
                    sideUVs.push(u0, vH);
                    sideUVs.push(u0, 0);
                    sideUVs.push(u1, vH);
                    sideUVs.push(u1, 0);
                    sideIndices.push(baseIndex, baseIndex + 1, baseIndex + 2);
                    sideIndices.push(baseIndex + 1, baseIndex + 3, baseIndex + 2);
                    // Запоминаем раскладку для корректного per-ring
                    // обновления высот и пересчёта UV.
                    this._sideEdgeIJ.push([idxI, idxJ]);
                    this._sideEdgeLengths.push(edgeLen);
                    cum += edgeLen;
                }
            }
            const sideGeometry = new THREE.BufferGeometry();
            sideGeometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(sidePositions), 3));
            sideGeometry.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(sideUVs), 2));
            sideGeometry.setIndex(sideIndices);
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
        this._raycastMeshesCache = null;
    }
    _buildStrokeGeometry(map) {
        if (this._invalidGeometry)
            return;
        if (this._strokeWidth <= 0 || this._strokeOpacity <= 0)
            return;
        const canvas = map.renderer.domElement;
        const outerRing = this._rings[0];
        this._strokeWorldCoords.length = 0;
        this._strokeNodeHeights.length = 0;
        let firstStrokePoint = null;
        for (let i = 0; i < outerRing.length; i++) {
            const pt = outerRing[i];
            const [absX, absZ] = map.project(pt, this._crs);
            if (i === 0) {
                firstStrokePoint = [absX, absZ];
            }
            else if (firstStrokePoint && absX === firstStrokePoint[0] && absZ === firstStrokePoint[1]) {
                continue;
            }
            this._strokeWorldCoords.push([absX, absZ]);
            const h = pt?.[2];
            this._strokeNodeHeights.push(Number.isFinite(h) ? h : 0);
        }
        this._cachedStrokeHeights = new Array(this._strokeWorldCoords.length).fill(0);
        if (this._useSimpleStroke) {
            const positions = [];
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
        }
        else {
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
    getFillColor() {
        return this._fillColor;
    }
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
    /**
     * Меняет текстуру заливки. `null` — вернуть однотонную заливку.
     * Работает после `addTo()` без пересоздания геометрии — UV уже
     * посчитаны.
     */
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
    getFillPattern() {
        return this._fillPatternSource;
    }
    /**
     * Масштаб паттерна: world-метры на одну плитку.
     * Патч: обновляет только UV-атрибуты (`_updateFillUVs`), без dispose
     * материалов и без повторного earcut. Раньше — полный rebuild.
     */
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
    getFillPatternScale() {
        return this._fillPatternScale;
    }
    /**
     * `'tile'` — мировой тайлинг (по умолчанию),
     * `'bounds'` — растянуть текстуру на bbox полигона (0..1 UV).
     * Патч: пересчитывает только UV (`_updateFillUVs`).
     */
    setFillPatternFit(fit) {
        if (this._fillPatternFit === fit)
            return this;
        this._fillPatternFit = fit;
        if (this._map)
            this._updateFillUVs();
        this._invalidateBatch();
        return this;
    }
    getFillPatternFit() {
        return this._fillPatternFit;
    }
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
    // Высота
    // =================================================================
    /** @deprecated Используйте унаследованный `setAltitude`. */
    setAltitudeOffset(offset) {
        return this.setAltitude(offset);
    }
    /** @deprecated Используйте унаследованный `getAltitude`. */
    getAltitudeOffset() {
        return this.getAltitude();
    }
    setAltitudeMode(mode) {
        this._altitudeMode = mode;
        this._onAltitudeChanged();
        return this;
    }
    getAltitudeMode() { return this._altitudeMode; }
    // =================================================================
    // Экструзия
    // =================================================================
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
        if (!(height >= 0))
            return this;
        if (this._height === height)
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
        if (!(height >= 0))
            return this;
        if (this._minHeight === height)
            return this;
        this._minHeight = height;
        this._heightsDirty = true;
        this._heightsFinalized = false;
        this._invalidateBatch();
        return this;
    }
    getMinHeight() { return this._minHeight; }
    // =================================================================
    // Depth
    // =================================================================
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
        const mats = [
            this._fillMaterial,
            this._bottomMaterial,
            this._sideMaterial,
            this._strokeMaterial,
        ];
        for (const mat of mats) {
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
    // =================================================================
    // Центр / bounds
    // =================================================================
    getCenter() {
        const b = this.getBounds('EPSG:4326');
        if (!b)
            return null;
        return [
            (b[0][0] + b[1][0]) / 2,
            (b[0][1] + b[1][1]) / 2,
        ];
    }
    // =================================================================
    // Обновление на кадре
    // =================================================================
    _update(_mapArg) {
        const map = this._map;
        if (!map || !this._group)
            return;
        if (this._batch) {
            if (this._invalidGeometry || !this._isWithinView()) {
                this._isVisible = false;
                this._centroidScreenPos = null;
                return;
            }
            this._isVisible = true;
            this._updateCentroidScreenPos();
            return;
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
            if (changed)
                this._updateStroke();
            this._heightsDirty = false;
            this._lastHeightUpdateTime = now;
        }
        this._updateCentroidScreenPos();
    }
    _updateHeights() {
        if (this._invalidGeometry)
            return false;
        if (!this._fillGeometry || !this._vertices2D.length)
            return false;
        const map = this._map;
        const isDynamic = map.hasElevation && this._altitudeMode === 'clampToGround';
        if (!isDynamic && this._heightsFinalized)
            return false;
        const wgPos = map.worldGroup.position;
        const extrude = this._extruded ? this._height : 0;
        const n = this._vertices2D.length;
        // Базовые высоты (рельеф + altitude + nodeH).
        for (let i = 0; i < n; i++) {
            const worldCoord = this._worldCoords[i];
            if (!worldCoord)
                continue;
            let base = this._altitude;
            if (isDynamic) {
                const worldX = worldCoord[0] + wgPos.x;
                const worldZ = worldCoord[1] + wgPos.z;
                map.ensureTileForPoint?.(worldX, worldZ);
                base = map.getSurfaceHeightAt(worldX, worldZ) + this._altitude;
            }
            const nodeH = this._nodeHeights[i] ?? 0;
            this._cachedHeights[i] = base + nodeH + this._minHeight + extrude;
        }
        const strokeLen = this._strokeWorldCoords.length;
        if (this._cachedStrokeHeights.length !== strokeLen) {
            this._cachedStrokeHeights = new Array(strokeLen).fill(0);
        }
        for (let i = 0; i < strokeLen; i++) {
            const worldCoord = this._strokeWorldCoords[i];
            if (!worldCoord)
                continue;
            let base = this._altitude;
            if (isDynamic) {
                const worldX = worldCoord[0] + wgPos.x;
                const worldZ = worldCoord[1] + wgPos.z;
                map.ensureTileForPoint?.(worldX, worldZ);
                base = map.getSurfaceHeightAt(worldX, worldZ) + this._altitude;
            }
            const nodeH = this._strokeNodeHeights[i] ?? 0;
            this._cachedStrokeHeights[i] = base + nodeH + this._minHeight + extrude;
        }
        // ── Top ──
        const topPos = this._fillGeometry.attributes.position.array;
        for (let i = 0; i < n; i++) {
            topPos[i * 3 + 1] = this._cachedHeights[i];
        }
        this._fillGeometry.attributes.position.needsUpdate = true;
        this._fillGeometry.computeBoundingSphere();
        // ── Bottom ──
        if (this._bottomGeometry) {
            const bottomPos = this._bottomGeometry.attributes.position.array;
            const height = this._height;
            for (let i = 0; i < n; i++) {
                bottomPos[i * 3 + 1] = this._cachedHeights[i] - height;
            }
            this._bottomGeometry.attributes.position.needsUpdate = true;
            this._bottomGeometry.computeBoundingSphere();
        }
        // ── Side (per-edge через _sideEdgeIJ — фикс для дырок) ──
        if (this._sideGeometry) {
            const sidePos = this._sideGeometry.attributes.position.array;
            const height = this._height;
            const edgeCount = this._sideEdgeIJ.length;
            for (let k = 0; k < edgeCount; k++) {
                const pair = this._sideEdgeIJ[k];
                const idxI = pair[0];
                const idxJ = pair[1];
                const upperI = this._cachedHeights[idxI];
                const upperJ = this._cachedHeights[idxJ];
                const lowerI = upperI - height;
                const lowerJ = upperJ - height;
                const base = k * 4;
                sidePos[base * 3 + 1] = upperI;
                sidePos[(base + 1) * 3 + 1] = lowerI;
                sidePos[(base + 2) * 3 + 1] = upperJ;
                sidePos[(base + 3) * 3 + 1] = lowerJ;
            }
            this._sideGeometry.attributes.position.needsUpdate = true;
            // Патч: computeVertexNormals() удалён — нормали стенок
            // инвариантны к изменению Y (направление рёбер не меняется,
            // только их масштаб). Это самый дорогой вызов на кадр.
            // UV боковых стенок: V зависит от _height, обновляем при
            // изменении высоты. U не меняется — patternScale тот же.
            if (this._builtSideHeight !== height) {
                const uvAttr = this._sideGeometry.attributes.uv;
                if (uvAttr) {
                    const sideUVs = uvAttr.array;
                    const patternScale = this._fillPatternScale > 0
                        ? this._fillPatternScale
                        : DEFAULT_FILL_PATTERN_SCALE;
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
            // Bounding sphere пересчитываем: Y-диапазон меняется.
            // (O(n), но вызывается раз в 500 мс для dynamic, не каждый кадр.)
            this._sideGeometry.computeBoundingSphere();
        }
        if (!isDynamic)
            this._heightsFinalized = true;
        return true;
    }
    _updateStroke() {
        if (this._invalidGeometry)
            return;
        if (!this._strokeLine || !this._strokeGeometry)
            return;
        const positions = this._strokePositionsArray;
        positions.length = 0;
        const groupPos = this._group.position;
        const strokeLen = this._strokeWorldCoords.length;
        for (let i = 0; i < strokeLen; i++) {
            const worldCoord = this._strokeWorldCoords[i];
            if (!worldCoord)
                continue;
            const y = this._cachedStrokeHeights[i] ?? this._altitude;
            positions.push(worldCoord[0] - groupPos.x, y, worldCoord[1] - groupPos.z);
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
                existing.array.set(positions);
                existing.needsUpdate = true;
                this._strokeGeometry.computeBoundingSphere();
            }
            else {
                this._strokeGeometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(positions), 3));
                this._strokeGeometry.computeBoundingSphere();
            }
        }
        else {
            this._strokeGeometry.setPositions(positions);
            this._strokeLine.computeLineDistances();
        }
    }
    _updateCentroidScreenPos() {
        if (this._invalidGeometry) {
            this._centroidScreenPos = null;
            return;
        }
        if (!this._map || !this._centroidWorld) {
            this._centroidScreenPos = null;
            return;
        }
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
        // Патч: кэш среднего по _nodeHeights. Раньше — O(n) каждый кадр.
        if (!this._avgNodeHeightValid) {
            let sum = 0;
            const n = this._nodeHeights.length;
            for (let i = 0; i < n; i++)
                sum += this._nodeHeights[i] ?? 0;
            this._avgNodeHeight = n > 0 ? sum / n : 0;
            this._avgNodeHeightValid = true;
        }
        worldY += this._avgNodeHeight;
        worldY += this._minHeight + (this._extruded ? this._height : 0);
        const screenPos = map.getVec3().set(worldX, worldY + wgPos.y, worldZ);
        screenPos.project(map.camera);
        if (screenPos.z > 1 || Math.abs(screenPos.x) > 1 || Math.abs(screenPos.y) > 1) {
            this._centroidScreenPos = null;
        }
        else {
            const canvas = map.renderer.domElement;
            this._centroidScreenPos = {
                x: (screenPos.x * 0.5 + 0.5) * canvas.clientWidth,
                y: (-screenPos.y * 0.5 + 0.5) * canvas.clientHeight,
            };
        }
    }
    // =================================================================
    // KrbMap#fitTo / getBounds
    // =================================================================
    getBounds(crs = 'EPSG:4326') {
        const key = typeof crs === 'string' ? crs : (crs?.code ?? 'custom');
        if (this._boundsCache.has(key)) {
            return this._boundsCache.get(key);
        }
        const result = this._computeBounds(crs);
        this._boundsCache.set(key, result);
        return result;
    }
    _computeBounds(crs) {
        if (!this._rings || !this._rings.length)
            return null;
        const src = this._crs
            ?? (this._crsCode ? Projections.get(this._crsCode) : Projections.get('EPSG:4326'));
        const dst = typeof crs === 'string' ? Projections.get(crs) : crs;
        if (!src || !dst)
            return null;
        const sameProjection = src === dst;
        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
        let count = 0;
        for (const ring of this._rings) {
            if (!ring)
                continue;
            for (let i = 0; i < ring.length; i++) {
                const pt = ring[i];
                if (!pt || pt.length < 2)
                    continue;
                let x, y;
                if (sameProjection) {
                    x = pt[0];
                    y = pt[1];
                }
                else {
                    const lonLat = src.toLonLat(pt);
                    const conv = dst.fromLonLat(lonLat);
                    x = conv[0];
                    y = conv[1];
                }
                if (x < minX)
                    minX = x;
                if (x > maxX)
                    maxX = x;
                if (y < minY)
                    minY = y;
                if (y > maxY)
                    maxY = y;
                count++;
            }
        }
        if (count === 0 || !isFinite(minX))
            return null;
        return [[minX, minY], [maxX, maxY]];
    }
}
