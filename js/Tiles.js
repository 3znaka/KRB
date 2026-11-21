// @ts-nocheck
import { THREE } from './js_TP/tpb.js';
import { DEFAULTS } from './Defaults.js';
import { getVirtKey, getOriginZ } from './TileKey.js';
import { Projections } from './Projections.js';
import { applyGapMaskToMaterial } from './PolygonUtils.js';
const MAX_CACHED_TILES = 350;
const ANCESTOR_FALLBACK = 4;
const DEFORM_SEGMENTS_FLAT = 8;
const TILE_DEFAULT_ROUGHNESS = 0.7;
const TILE_DEFAULT_METALNESS = 0.0;
const TILE_DEFAULT_EMISSIVE = 0.5;
const BUILD_BUDGET_MS = 4;
const MAX_TEXTURE_LOADS = 6;
const STABILITY_DELAY_MS = 400;
const ZOOM_STABLE_EPSILON = 0.001;
const RAPID_ZOOM_GAP = 2;
// Горизонтное расширение применяется только при stable-камере
// и ограничено — иначе AABB разрастается в разы и мы тонем в lookup'ах.
const MAX_HORIZON_TILES = 6;
// Сколько новых тайлов разрешено инициировать за кадр в горизонте при stable.
const STABLE_LOAD_BUDGET = 24;
// GC: мягкий и жёсткий бюджеты на кадр.
const GC_SOFT_BUDGET = 16;
const GC_HARD_BUDGET = 64;
/** Растровый тайловый слой (z/x/y сетка `crs`). */
export class Tile {
    constructor(options) {
        this.texture = options.texture;
        this.elevation = options.elevation;
        this.noise = options.noise;
        this.attributionTitle = options.attributionTitle || '';
        this.attributionUrl = options.attributionUrl || '';
        this.heightScale = options.heightScale;
        this.zoomOffset = options.zoomOffset ?? 0;
        this.visible = options.visible ?? true;
        this.opacity = options.opacity ?? 1;
        this.minZoom = options.minZoom ?? 0;
        this.maxZoom = options.maxZoom ?? Infinity;
        this._visibleKeysPrev = null;
        if (options.maxSourceZoom !== undefined && options.maxNativeZoom === undefined) {
            console.warn('Tile: maxSourceZoom устарела, используйте maxNativeZoom.');
        }
        if (options.minSourceZoom !== undefined && options.minNativeZoom === undefined) {
            console.warn('Tile: minSourceZoom устарела, используйте minNativeZoom.');
        }
        this.minNativeZoom = options.minNativeZoom ?? options.minSourceZoom ?? 0;
        this.maxNativeZoom = options.maxNativeZoom ?? options.maxSourceZoom ?? 22;
        if (options.maxReliefZ !== undefined &&
            options.maxElevationZoom === undefined &&
            options.maxElevationNativeZoom === undefined) {
            console.warn('Tile: maxReliefZ устарела, используйте maxElevationNativeZoom.');
        }
        if (options.minReliefZ !== undefined &&
            options.minElevationZoom === undefined &&
            options.minElevationNativeZoom === undefined) {
            console.warn('Tile: minReliefZ устарела, используйте minElevationNativeZoom.');
        }
        if (options.maxElevationZoom !== undefined &&
            options.maxElevationNativeZoom === undefined) {
            console.warn('Tile: maxElevationZoom устарела, используйте maxElevationNativeZoom.');
        }
        if (options.minElevationZoom !== undefined &&
            options.minElevationNativeZoom === undefined) {
            console.warn('Tile: minElevationZoom устарела, используйте minElevationNativeZoom.');
        }
        this.minElevationNativeZoom = options.minElevationNativeZoom
            ?? options.minElevationZoom
            ?? options.minReliefZ
            ?? DEFAULTS.MIN_RELIEF_Z;
        this.maxElevationNativeZoom = options.maxElevationNativeZoom
            ?? options.maxElevationZoom
            ?? options.maxReliefZ
            ?? DEFAULTS.MAX_RELIEF_Z;
        Object.defineProperty(this, 'minElevationZoom', {
            configurable: true, enumerable: false,
            get: () => this.minElevationNativeZoom,
            set: (v) => { this.minElevationNativeZoom = v; },
        });
        Object.defineProperty(this, 'maxElevationZoom', {
            configurable: true, enumerable: false,
            get: () => this.maxElevationNativeZoom,
            set: (v) => { this.maxElevationNativeZoom = v; },
        });
        if (options.crs && options.projection && options.crs !== options.projection) {
            console.warn(`Tile: заданы и crs='${options.crs}', и projection='${options.projection}'; использую crs.`);
        }
        this.crs = options.crs ?? options.projection ?? 'EPSG:3857';
        this.baseRenderOrder = 0;
        this._map = null;
        this.mask = options.mask ?? null;
        this.maskInvert = options.maskInvert ?? false;
        this.maskFeather = options.maskFeather ?? 0;
    }
    addTo(map) {
        if (!map)
            throw new Error('Tile.addTo: map is required');
        if (this._map === map)
            return this;
        if (this._map)
            this.removeFromMap();
        map._registerRasterLayer(this);
        this._map = map;
        if (this.mask) {
            map._tileManagerForLayer?.(this)?.setMask(this.mask, {
                invert: this.maskInvert,
                feather: this.maskFeather,
            });
        }
        return this;
    }
    removeFromMap() {
        if (!this._map)
            return;
        const map = this._map;
        this._map = null;
        map._unregisterRasterLayer(this);
    }
    setVisible(visible) {
        this.visible = !!visible;
        this._map?._tileManagerForLayer?.(this)?.setVisible(this.visible);
    }
    setOpacity(opacity) {
        const v = Number.isFinite(opacity) ? Math.max(0, Math.min(1, opacity)) : 1;
        this.opacity = v; // Сохраняем значение в конфиге
        // Передаем управление менеджеру карты
        this._map?._tileManagerForLayer?.(this)?.setOpacity(v);
    }
    setMask(geojson, opts = {}) {
        this.mask = geojson ?? null;
        if (opts.invert !== undefined)
            this.maskInvert = !!opts.invert;
        if (opts.feather !== undefined) {
            const f = Number(opts.feather);
            this.maskFeather = Number.isFinite(f) ? Math.max(0, f) : 0;
        }
        this._map?._tileManagerForLayer?.(this)?.setMask(this.mask, {
            invert: this.maskInvert,
            feather: this.maskFeather,
        });
        return this;
    }
    clearMask() {
        this.mask = null;
        this._map?._tileManagerForLayer?.(this)?.clearMask();
        return this;
    }
}
/** Менеджер растровых тайлов одного слоя. */
export class TileManager {
    constructor(engine, layer = null) {
        this.engine = engine;
        this.layer = layer ?? engine._tileLayer ?? engine.layers?.[0] ?? null;
        this._deadKeys = new Set();
        this.tiles = new Map();
        this.textureCache = new Map();
        this._inFlightTextures = new Map();
        this.textureLoader = new THREE.TextureLoader();
        this.textureLoader.setCrossOrigin('anonymous');
        this.frame = 0;
        this._textureQueue = [];
        this._activeTextureLoads = 0;
        this._buildQueue = [];
        this._buildRaf = 0;
        this._lastIdealZ = 0;
        this._lastViewKey = '';
        this._viewStableSince = 0;
        this._elevationProvider = engine.elevationProvider ?? null;
        this.tileLighting = engine.tileLighting === true;
        this.tileRoughness = Number.isFinite(engine.tileLightingRoughness)
            ? engine.tileLightingRoughness : TILE_DEFAULT_ROUGHNESS;
        this.tileMetalness = Number.isFinite(engine.tileLightingMetalness)
            ? engine.tileLightingMetalness : TILE_DEFAULT_METALNESS;
        this.tileEmissive = Number.isFinite(engine.tileLightingEmissive)
            ? engine.tileLightingEmissive : TILE_DEFAULT_EMISSIVE;
        this.pendingWorkerJobs = [];
        this.activeWorkerJobs = 0;
        this.nextJobId = 1;
        this.workerPromises = new Map();
        this.srcKeyToElevUrl = new Map();
        this.parentElevCache = engine.globalElevCache || new Map();
        this.parentElevPromises = new Map();
        this.elevDirectPromises = new Map();
        this.elevationQueue = [];
        this.activeElevationFetches = 0;
        this.MAX_ELEVATION_FETCHES = 4;
        this._lastPrefetchZoom = -1;
        this._deformedRangeCache = null;
        this._edgeTileIdxCache = null;
        this._edgePts = undefined;
        this._rangeCache = null;
        if (this.hasElevation)
            this.initWorker();
        this.onTileHeightAppliedCallbacks = [];
        this.onTileDisposedCallbacks = [];
        // --- Mask ---
        this._maskTexture = null;
        this._maskBounds = null; // { minX, minZ, sizeX, sizeZ } в ЛОКАЛЬНЫХ координатах worldGroup
        this._maskEnabled = false;
        this._maskInvert = false;
        this._maskFeather = 0;
        // Общий uniform: сдвиг worldGroup в сцене. Один объект на все материалы менеджера.
        this._maskOffsetUniform = { value: new THREE.Vector3() };
        this._staticBgAllowed = true;
    }
    get _mapHalfX() {
        const v = this.engine.mapHalfExtentX;
        if (v !== undefined)
            return v;
        console.warn('TileManager: engine.mapHalfExtentX отсутствует. Fallback: MAX_MERCATOR.');
        return this.engine.MAX_MERCATOR;
    }
    get _mapHalfY() {
        const v = this.engine.mapHalfExtentY;
        if (v !== undefined)
            return v;
        console.warn('TileManager: engine.mapHalfExtentY отсутствует. Fallback: MAX_MERCATOR.');
        return this.engine.MAX_MERCATOR;
    }
    _liveIdealZ() {
        return typeof this.engine.getTileZoom === 'function'
            ? this.engine.getTileZoom(this.layer)
            : (this.engine.currentDiscreteZoom ?? this._lastIdealZ);
    }
    _enqueueBuild(inst, job) {
        return new Promise((resolve) => {
            this._buildQueue.push({ inst, job, resolve });
            if (!this._buildRaf)
                this._buildRaf = requestAnimationFrame(() => this._pumpBuilds());
        });
    }
    _pumpBuilds() {
        this._buildRaf = 0;
        const q = this._buildQueue;
        if (!q.length)
            return;
        const iz = this._liveIdealZ();
        q.sort((a, b) => Math.abs(a.inst.z - iz) - Math.abs(b.inst.z - iz) ||
            b.inst.lastUsed - a.inst.lastUsed);
        const t0 = performance.now();
        let done = 0;
        while (q.length && (done === 0 || performance.now() - t0 < BUILD_BUDGET_MS)) {
            const { job, resolve } = q.shift();
            try {
                resolve(job());
            }
            catch (e) {
                resolve(null);
                console.warn(e);
            }
            done++;
        }
        if (q.length)
            this._buildRaf = requestAnimationFrame(() => this._pumpBuilds());
    }
    /* ---------- DEM source ---------- */
    get hasElevation() {
        return !!this._elevationProvider || !!this.layer?.elevation;
    }
    setElevationProvider(provider) {
        if (this._elevationProvider === provider)
            return;
        const had = this.hasElevation;
        this._elevationProvider = provider;
        const has = this.hasElevation;
        if (!had && !has)
            return;
        if (has && !this.worker)
            this.initWorker();
        this._disposeAllTiles();
        this.srcKeyToElevUrl.clear();
        this.frame = 0;
    }
    _disposeAllTiles() {
        const toDispose = Array.from(this.tiles.values());
        for (const inst of toDispose)
            this.disposeTile(inst);
    }
    get _maxNativeZoom() { return this.layer?.maxNativeZoom ?? this.engine.MAX_ZOOM; }
    get _minNativeZoom() { return this.layer?.minNativeZoom ?? 0; }
    get _maxElevationNativeZoom() {
        const p = this._elevationProvider;
        if (p && p.elevationMaxZoom != null)
            return p.elevationMaxZoom;
        if (this.layer?.elevation)
            return this.layer.maxElevationNativeZoom;
        return this.engine.MAX_RELIEF_Z ?? DEFAULTS.MAX_RELIEF_Z;
    }
    get _minElevationNativeZoom() {
        const p = this._elevationProvider;
        if (p && p.elevationMinZoom != null)
            return p.elevationMinZoom;
        if (this.layer?.elevation)
            return this.layer.minElevationNativeZoom;
        return this.engine.MIN_RELIEF_Z ?? DEFAULTS.MIN_RELIEF_Z;
    }
    get _baseRenderOrder() { return this.layer?.baseRenderOrder ?? 0; }
    get _isVisible() {
        const layer = this.layer;
        if (!layer)
            return false; // ← было true
        if (layer.visible === false)
            return false;
        const dz = this.engine.currentDiscreteZoom;
        if (dz < (layer.minZoom ?? 0))
            return false;
        if (dz > (layer.maxZoom ?? Infinity))
            return false;
        return true;
    }
    get _isDeformed() {
        if (this.engine.globe)
            return true;
        if (typeof this.engine._isLayerLinear === 'function') {
            return !this.engine._isLayerLinear(this.layer);
        }
        return this.engine.deformedTiles;
    }
    get _layerCrs() {
        const code = this.layer?.crs ?? 'EPSG:3857';
        return typeof code === 'string' ? Projections.get(code) : code;
    }
    key(z, virtX, y) { return getVirtKey(z, virtX, y); }
    _createTileMaterial(texture, opts = {}) {
        const layerHasElevation = this.hasElevation;
        const depthWrite = opts.depthWrite !== undefined ? opts.depthWrite : layerHasElevation;
        const depthTest = opts.depthTest !== undefined ? opts.depthTest : layerHasElevation;
        const opacity = Number.isFinite(this.layer?.opacity) ? this.layer.opacity : 1;
        const transparent = opacity < 1;
        const common = { map: texture, depthWrite, depthTest, opacity, transparent };
        let mat;
        if (!this.tileLighting) {
            mat = new THREE.MeshBasicMaterial(common);
        }
        else {
            mat = new THREE.MeshStandardMaterial({
                ...common,
                roughness: this.tileRoughness,
                metalness: this.tileMetalness
            });
            if (this.tileEmissive > 0) {
                mat.emissive = new THREE.Color(0xffffff);
                mat.emissiveIntensity = this.tileEmissive;
                if (texture)
                    mat.emissiveMap = texture;
            }
        }
        applyGapMaskToMaterial(mat, this.engine);
        // ---- Overlay ----
        mat.userData.overlayMap = null;
        mat.userData.overlayOpacity = 1;
        mat.userData.hasOverlay = 0;
        mat.userData._overlayUniforms = null;
        // ---- Mask: начальный снимок состояния менеджера ----
        mat.userData._maskEnabled = this._maskEnabled;
        mat.userData._maskInvert = this._maskInvert;
        mat.userData._maskFeather = this._maskFeather;
        mat.userData._maskTexture = this._maskTexture;
        mat.userData._maskBounds = this._maskBounds;
        mat.userData._maskUniforms = null;
        mat.userData._maskForcedTransparent = false;
        mat.userData._maskOrigTransparent = mat.transparent;
        if (this._maskEnabled && this._maskFeather > 0 && !mat.transparent) {
            mat.userData._maskForcedTransparent = true;
            mat.transparent = true;
        }
        mat.onBeforeCompile = (shader) => {
            // Overlay
            shader.uniforms.overlayMap = { value: mat.userData.overlayMap };
            shader.uniforms.overlayOpacity = { value: mat.userData.overlayOpacity };
            shader.uniforms.hasOverlay = { value: mat.userData.hasOverlay };
            const mb = mat.userData._maskBounds;
            // Mask
            shader.uniforms.maskMap = { value: mat.userData._maskTexture };
            shader.uniforms.maskBoundsMin = { value: new THREE.Vector2(mb?.minX ?? 0, mb?.minZ ?? 0) };
            shader.uniforms.maskBoundsSize = { value: new THREE.Vector2(mb?.sizeX ?? 1, mb?.sizeZ ?? 1) };
            shader.uniforms.maskEnabled = { value: mat.userData._maskEnabled ? 1 : 0 };
            shader.uniforms.maskInvert = { value: mat.userData._maskInvert ? 1 : 0 };
            shader.uniforms.maskFeather = { value: mat.userData._maskFeather };
            shader.uniforms.maskWorldOffset = this._maskOffsetUniform; // ← общая ссылка, не копия
            // Vertex
            shader.vertexShader =
                'uniform vec3 maskWorldOffset;\n' +
                    'varying vec2 vOverlayUv;\n' +
                    'varying vec3 vMaskWorldPos;\n' +
                    shader.vertexShader.replace('#include <begin_vertex>', `#include <begin_vertex>
         vOverlayUv = uv;
         vMaskWorldPos = (modelMatrix * vec4(transformed, 1.0)).xyz - maskWorldOffset;`);
            // Fragment
            shader.fragmentShader =
                `uniform sampler2D overlayMap;
             uniform float overlayOpacity;
             uniform float hasOverlay;
             varying vec2 vOverlayUv;

             uniform sampler2D maskMap;
             uniform vec2 maskBoundsMin;
             uniform vec2 maskBoundsSize;
             uniform float maskEnabled;
             uniform float maskInvert;
             uniform float maskFeather;
             varying vec3 vMaskWorldPos;
            ` +
                    shader.fragmentShader
                        .replace('#include <map_fragment>', `#include <map_fragment>
                     if (hasOverlay > 0.5) {
                         vec4 ov = texture2D(overlayMap, vOverlayUv);
                         diffuseColor.rgb = mix(diffuseColor.rgb, ov.rgb, ov.a * overlayOpacity);
                     }`)
                        .replace('#include <clipping_planes_fragment>', `#include <clipping_planes_fragment>
                     float vMaskAlpha = 1.0;
                     if (maskEnabled > 0.5) {
                         vec2 mUv = (vMaskWorldPos.xz - maskBoundsMin) / maskBoundsSize;
                         float inside = 0.0;
                         if (mUv.x >= 0.0 && mUv.x <= 1.0 && mUv.y >= 0.0 && mUv.y <= 1.0) {
                             inside = texture2D(maskMap, mUv).r;
                         }
                         if (maskInvert > 0.5) inside = 1.0 - inside;
                         if (maskFeather > 0.0) {
    vMaskAlpha = inside;
    if (vMaskAlpha < 0.001) discard;
} else {
    if (inside < 0.5) discard;
}
                     }`)
                        .replace('#include <opaque_fragment>', `#include <opaque_fragment>
                     gl_FragColor.a *= vMaskAlpha;`);
            mat.userData._overlayUniforms = shader.uniforms;
            mat.userData._maskUniforms = shader.uniforms;
        };
        return mat;
    }
    setMeshOverlay(mesh, texture, opacity = 1) {
        if (!mesh || !mesh.material)
            return;
        const mat = mesh.material;
        mat.userData.overlayMap = texture || null;
        mat.userData.overlayOpacity = Number.isFinite(opacity) ? Math.max(0, Math.min(1, opacity)) : 1;
        mat.userData.hasOverlay = texture ? 1 : 0;
        const u = mat.userData._overlayUniforms;
        if (u) {
            u.overlayMap.value = mat.userData.overlayMap;
            u.overlayOpacity.value = mat.userData.overlayOpacity;
            u.hasOverlay.value = mat.userData.hasOverlay;
        }
        else {
            mat.needsUpdate = true;
        }
    }
    setOverlayOpacity(opacity) {
        const v = Number.isFinite(opacity) ? Math.max(0, Math.min(1, opacity)) : 1;
        for (const inst of this.tiles.values()) {
            if (!inst.overlayTex || !inst.mesh)
                continue;
            const mat = inst.mesh.material;
            if (!mat)
                continue;
            mat.userData.overlayOpacity = v;
            const u = mat.userData._overlayUniforms;
            if (u)
                u.overlayOpacity.value = v;
        }
    }
    setMeshTexture(mesh, texture) {
        if (!mesh || !mesh.material)
            return;
        mesh.material.map = texture;
        if (mesh.material.isMeshStandardMaterial && this.tileEmissive > 0) {
            mesh.material.emissiveMap = texture;
        }
        mesh.material.needsUpdate = true;
    }
    /* ---------- Маска по GeoJSON ---------- */
    setMask(geojson, opts = {}) {
        if (!geojson)
            return this.clearMask();
        const f = Number(opts.feather);
        const feather = Number.isFinite(f) ? Math.max(0, f) : 0;
        const built = this._buildMaskTexture(geojson, feather);
        if (!built) {
            console.warn('TileManager.setMask: empty or invalid mask');
            return this.clearMask();
        }
        if (this._maskTexture) {
            try {
                this._maskTexture.dispose();
            }
            catch { }
        }
        this._maskTexture = built.texture;
        this._maskBounds = built.bounds;
        this._maskEnabled = true;
        this._maskInvert = !!opts.invert;
        this._maskFeather = built.feather; // фактический, после ограничения размером маски
        this._pendingLayerMask = null;
        this._applyMaskToAllTiles();
        return this;
    }
    clearMask() {
        if (this._maskTexture) {
            try {
                this._maskTexture.dispose();
            }
            catch { }
        }
        this._maskTexture = null;
        this._maskBounds = null;
        this._maskEnabled = false;
        this._maskInvert = false;
        this._maskFeather = 0;
        this._pendingLayerMask = null;
        this._applyMaskToAllTiles();
        return this;
    }
    _applyMaskToAllTiles() {
        // 1. Обновляем динамические тайлы
        for (const inst of this.tiles.values()) {
            const mat = inst.mesh?.material;
            if (mat)
                this._updateMaterialMask(mat);
        }
        // 2. ДОБАВИТЬ: Обновляем меши статического фона (низкого разрешения)
        const bgGroup = this.engine.staticBgGroup;
        if (bgGroup) {
            for (const child of bgGroup.children) {
                if (child.material) {
                    this._updateMaterialMask(child.material);
                }
            }
        }
    }
    _syncMaskOffset() {
        const wg = this.engine.worldGroup;
        if (!wg)
            return;
        this._maskOffsetUniform.value.copy(wg.position);
    }
    _updateMaterialMask(mat) {
        const bounds = this._maskBounds;
        mat.userData._maskEnabled = this._maskEnabled;
        mat.userData._maskInvert = this._maskInvert;
        mat.userData._maskFeather = this._maskFeather;
        mat.userData._maskTexture = this._maskTexture;
        mat.userData._maskBounds = bounds;
        const u = mat.userData._maskUniforms;
        if (u) {
            u.maskMap.value = this._maskTexture;
            u.maskEnabled.value = this._maskEnabled ? 1 : 0;
            u.maskInvert.value = this._maskInvert ? 1 : 0;
            u.maskFeather.value = this._maskFeather;
            if (bounds) {
                u.maskBoundsMin.value.set(bounds.minX, bounds.minZ);
                u.maskBoundsSize.value.set(bounds.sizeX, bounds.sizeZ);
            }
        }
        // Feather требует alpha-блендинга — принудительно включаем transparent.
        const needsTransparent = this._maskEnabled && this._maskFeather > 0;
        if (needsTransparent && !mat.userData._maskForcedTransparent) {
            mat.userData._maskOrigTransparent = mat.transparent;
            mat.userData._maskForcedTransparent = true;
            mat.transparent = true;
            mat.needsUpdate = true;
        }
        else if (!needsTransparent && mat.userData._maskForcedTransparent) {
            mat.transparent = !!mat.userData._maskOrigTransparent;
            mat.userData._maskForcedTransparent = false;
            mat.needsUpdate = true;
        }
    }
    _buildMaskTexture(geojson, featherWorld = 0) {
        const proj = this.engine.projection;
        if (!proj || typeof proj.fromLonLat !== 'function') {
            console.warn('TileManager.setMask: engine.projection.fromLonLat недоступен');
            return null;
        }
        const project = (lon, lat) => {
            let p = null;
            try {
                p = (proj.fromLonLatSafe ?? proj.fromLonLat)([lon, lat]);
            }
            catch {
                try {
                    p = proj.fromLonLat([lon, lat]);
                }
                catch { }
            }
            if (!p || !Number.isFinite(p[0]) || !Number.isFinite(p[1]))
                return null;
            // та же world-система, что в _getWorldEdgePoints: x = p[0], z = -p[1]
            return [p[0], -p[1]];
        };
        const polys = [];
        const visit = g => {
            if (!g)
                return;
            if (g.type === 'FeatureCollection')
                g.features.forEach(visit);
            else if (g.type === 'Feature')
                visit(g.geometry);
            else if (g.type === 'Polygon')
                polys.push(g.coordinates);
            else if (g.type === 'MultiPolygon')
                polys.push(...g.coordinates);
            else if (g.type === 'GeometryCollection')
                g.geometries.forEach(visit);
        };
        visit(geojson);
        if (!polys.length)
            return null;
        let minX = Infinity, minZ = Infinity, maxX = -Infinity, maxZ = -Infinity;
        const projPolys = [];
        for (const poly of polys) {
            const rings = [];
            for (const ring of poly) {
                const r = [];
                for (const pt of ring) {
                    const p = project(pt[0], pt[1]);
                    if (!p)
                        continue;
                    r.push(p);
                    if (p[0] < minX)
                        minX = p[0];
                    if (p[0] > maxX)
                        maxX = p[0];
                    if (p[1] < minZ)
                        minZ = p[1];
                    if (p[1] > maxZ)
                        maxZ = p[1];
                }
                if (r.length >= 3)
                    rings.push(r);
            }
            if (rings.length)
                projPolys.push(rings);
        }
        if (!isFinite(minX) || !isFinite(minZ) || maxX <= minX || maxZ <= minZ)
            return null;
        // feather в world-единицах; ограничиваем долей размера маски
        let feather = Math.max(0, Number(featherWorld) || 0);
        feather = Math.min(feather, 0.25 * Math.min(maxX - minX, maxZ - minZ));
        // Запас по краям: у прямоугольного полигона края совпадают с bbox,
        // и без pad размытие наружу обрежется границей текстуры.
        const pad = feather * 2.5;
        minX -= pad;
        maxX += pad;
        minZ -= pad;
        maxZ += pad;
        const sizeX = maxX - minX, sizeZ = maxZ - minZ;
        const MAX_DIM = 2048, MIN_DIM = 128;
        const scale = MAX_DIM / Math.max(sizeX, sizeZ);
        const W = Math.max(MIN_DIM, Math.min(4096, Math.ceil(sizeX * scale)));
        const H = Math.max(MIN_DIM, Math.min(4096, Math.ceil(sizeZ * scale)));
        const canvas = document.createElement('canvas');
        canvas.width = W;
        canvas.height = H;
        const ctx = canvas.getContext('2d');
        // ВАЖНО: фон — непрозрачный чёрный, а не clearRect().
        // Канвас хранит premultiplied alpha; при выгрузке в текстуру белый
        // полупрозрачный ореол разворачивается в r≈1 по ВСЕМУ размытию,
        // и feather снова исчезнет. Непрозрачный чёрный фон убирает проблему.
        ctx.fillStyle = '#000000';
        ctx.fillRect(0, 0, W, H);
        ctx.fillStyle = '#ffffff';
        for (const rings of projPolys) {
            ctx.beginPath();
            for (const ring of rings) {
                for (let i = 0; i < ring.length; i++) {
                    const u = (ring[i][0] - minX) / sizeX * W;
                    const v = (ring[i][1] - minZ) / sizeZ * H;
                    i === 0 ? ctx.moveTo(u, v) : ctx.lineTo(u, v);
                }
                ctx.closePath();
            }
            ctx.fill('evenodd');
        }
        let outCanvas = canvas;
        if (feather > 0) {
            const px = feather * (W / sizeX); // world → пиксели
            const blurred = document.createElement('canvas');
            blurred.width = W;
            blurred.height = H;
            const bctx = blurred.getContext('2d');
            if (typeof bctx.filter === 'string') {
                bctx.filter = `blur(${px.toFixed(1)}px)`;
                bctx.drawImage(canvas, 0, 0);
                bctx.filter = 'none';
            }
            else {
                // fallback без ctx.filter: downscale → upscale
                const s = Math.max(1, px / 2);
                const small = document.createElement('canvas');
                small.width = Math.max(1, Math.round(W / s));
                small.height = Math.max(1, Math.round(H / s));
                small.getContext('2d').drawImage(canvas, 0, 0, small.width, small.height);
                bctx.imageSmoothingEnabled = true;
                bctx.drawImage(small, 0, 0, W, H);
            }
            outCanvas = blurred;
        }
        const tex = new THREE.CanvasTexture(outCanvas);
        tex.minFilter = THREE.LinearFilter;
        tex.magFilter = THREE.LinearFilter;
        tex.generateMipmaps = false;
        tex.wrapS = THREE.ClampToEdgeWrapping;
        tex.wrapT = THREE.ClampToEdgeWrapping;
        // маска — данные, не цвет; не даём Three.js применять sRGB-конверсию
        if (THREE.NoColorSpace)
            tex.colorSpace = THREE.NoColorSpace;
        else if (THREE.LinearSRGBColorSpace)
            tex.colorSpace = THREE.LinearSRGBColorSpace;
        else
            tex.encoding = THREE.LinearEncoding;
        tex.needsUpdate = true;
        this.engine.renderer?.initTexture?.(tex);
        return { texture: tex, bounds: { minX, minZ, sizeX, sizeZ }, feather };
    }
    setVisible(visible) {
        if (visible) {
            // Показываем всё, что есть в кэше, и запоминаем это как «предыдущее видимое»,
            // чтобы следующий update() корректно скрыл лишнее.
            const keys = new Set();
            for (const [k, inst] of this.tiles) {
                if (!inst.mesh)
                    continue;
                inst.mesh.visible = true;
                keys.add(k);
            }
            this._visibleKeysPrev = keys;
            return;
        }
        for (const inst of this.tiles.values()) {
            if (inst.mesh)
                inst.mesh.visible = false;
        }
        this._visibleKeysPrev = null;
    }
    // Внутри класса TileManager:
    setOpacity(opacity) {
        if (!this.layer)
            return;
        const v = Number.isFinite(opacity) ? Math.max(0, Math.min(1, opacity)) : 1;
        // === Управление видимостью статической подложки — ВСЕГДА ===
        if (this.engine.staticBgGroup) {
            if (v < 1) {
                this.engine.staticBgGroup.visible = false;
            }
            else if (this._staticBgAllowed !== false) {
                this.engine.staticBgGroup.visible = true;
            }
        }
        // Обновляем слой, даже если значение совпадает, чтобы гарантировать синхронизацию
        this.layer.opacity = v;
        const transparent = v < 1;
        for (const inst of this.tiles.values()) {
            const mat = inst.mesh?.material;
            if (!mat)
                continue;
            mat.opacity = v;
            if (mat.transparent !== transparent) {
                mat.transparent = transparent;
                mat.needsUpdate = true;
            }
        }
    }
    /* ---------- Обновление видимых тайлов ---------- */
    update(camera, controlsTarget, continuousZoom, worldGroupPos) {
        if (this.engine.globe)
            return this._updateGlobe(camera, continuousZoom);
        if (this._pendingLayerMask) {
            const m = this._pendingLayerMask;
            this._pendingLayerMask = null;
            try {
                this.setMask(m, {
                    invert: this.layer?.maskInvert ?? false,
                    feather: this.layer?.maskFeather ?? 0,
                });
            }
            catch (e) {
                console.warn('TileManager: deferred mask init failed', e);
            }
        }
        if (!this._isVisible) {
            this.setVisible(false);
            return -1;
        }
        this.frame++;
        const prevIdealZ = this._lastIdealZ;
        const idealZ = this._liveIdealZ();
        if (idealZ !== prevIdealZ) {
            this._zoomOut = idealZ < prevIdealZ;
            this._lastIdealZ = idealZ;
        }
        const zoomOut = !!this._zoomOut;
        const targetCont = this.engine.targetContinuousZoom ?? continuousZoom;
        const _layerOffset = this.layer?.zoomOffset ?? 0;
        const _minNZ = this.layer?.minNativeZoom ?? this.engine.MIN_ZOOM;
        const _maxNZ = this.layer?.maxNativeZoom ?? this.engine.MAX_ZOOM;
        const targetZ = Math.max(_minNZ, Math.min(_maxNZ, Math.round(targetCont + _layerOffset)));
        const rapidZoom = Math.abs(targetZ - idealZ) >= RAPID_ZOOM_GAP;
        const layerCrs = this.layer?.crs;
        const isDeformed = this._isDeformed;
        const halfX = this._mapHalfX;
        const halfY = this._mapHalfY;
        const tileSizeX = (2 * halfX) / Math.pow(2, idealZ);
        const tileSizeY = (2 * halfY) / Math.pow(2, idealZ);
        const maxTile = (1 << idealZ) - 1;
        // --- Frustum ---
        const dist = camera.position.distanceTo(controlsTarget);
        const margin = this.engine.TILE_MARGIN;
        const vFov = (camera.fov * Math.PI) / 180;
        const aspect = camera.aspect;
        const hh = dist * Math.tan(vFov / 2) * aspect + margin * tileSizeX;
        const hv = dist * Math.tan(vFov / 2) + margin * tileSizeY;
        const camDX = camera.position.x - controlsTarget.x;
        const camDY = camera.position.y - controlsTarget.y;
        const camDZ = camera.position.z - controlsTarget.z;
        const camLen2D = Math.sqrt(camDX * camDX + camDZ * camDZ);
        const camLen3D = Math.sqrt(camDX * camDX + camDY * camDY + camDZ * camDZ);
        const cosB = camLen2D > 1e-6 ? camDZ / camLen2D : 1;
        const sinB = camLen2D > 1e-6 ? camDX / camLen2D : 0;
        const absCos = Math.abs(cosB);
        const absSin = Math.abs(sinB);
        const hhRot = hh * absCos + hv * absSin;
        const hvRot = hh * absSin + hv * absCos;
        let minX = controlsTarget.x - hhRot, maxX = controlsTarget.x + hhRot;
        let minZ = controlsTarget.z - hvRot, maxZ = controlsTarget.z + hvRot;
        const camX = camera.position.x;
        const camZ = camera.position.z;
        const fpMarginX = tileSizeX * 2;
        const fpMarginZ = tileSizeY * 2;
        if (camX - fpMarginX < minX)
            minX = camX - fpMarginX;
        if (camX + fpMarginX > maxX)
            maxX = camX + fpMarginX;
        if (camZ - fpMarginZ < minZ)
            minZ = camZ - fpMarginZ;
        if (camZ + fpMarginZ > maxZ)
            maxZ = camZ + fpMarginZ;
        // --- Детектор стабильности (нужен ДО горизонта) ---
        const now = performance.now();
        const zoomAnimating = Math.abs(continuousZoom - targetCont) > ZOOM_STABLE_EPSILON;
        const txRound = Math.round(controlsTarget.x / tileSizeX);
        const tzRound = Math.round(controlsTarget.z / tileSizeY);
        const viewKey = `${idealZ}|${txRound}|${tzRound}`;
        if (viewKey !== this._lastViewKey || zoomAnimating) {
            this._lastViewKey = viewKey;
            this._viewStableSince = now;
        }
        const engineIdle = this.engine?._idleFired;
        const stable = !rapidZoom
            && !zoomAnimating
            && (now - this._viewStableSince) >= STABILITY_DELAY_MS
            && (engineIdle === undefined ? true : engineIdle);
        // --- Горизонт: ТОЛЬКО при стабильной камере ---
        // При движении горизонтное расширение не нужно (пользователь всё равно
        // не разглядит дальний край), зато катастрофически раздувает AABB.
        if (stable && MAX_HORIZON_TILES > 0 && camLen3D > 1e-3) {
            const pitchDeg = Math.acos(Math.max(-1, Math.min(1, camDY / camLen3D))) * 180 / Math.PI;
            const t = Math.max(0, Math.min(1, (pitchDeg - 15) / 70));
            if (t > 0 && camLen2D > 1e-3) {
                const nx = -camDX / camLen2D;
                const nz = -camDZ / camLen2D;
                const ext = MAX_HORIZON_TILES * Math.max(tileSizeX, tileSizeY) * t;
                if (nx > 0)
                    maxX += nx * ext;
                else
                    minX += nx * ext;
                if (nz > 0)
                    maxZ += nz * ext;
                else
                    minZ += nz * ext;
            }
        }
        // --- Конвертация в tile-индексы ---
        let xMin, xMax, yMin, yMax;
        const off = worldGroupPos;
        if (isDeformed) {
            if (minX <= -halfX && maxX >= halfX && minZ <= -halfY && maxZ >= halfY) {
                xMin = 0;
                xMax = maxTile;
                yMin = 0;
                yMax = maxTile;
            }
            else {
                const qx = tileSizeX * 0.25, qy = tileSizeY * 0.25;
                const ckey = `${idealZ}|${Math.round(minX / qx)}|${Math.round(maxX / qx)}|` +
                    `${Math.round(minZ / qy)}|${Math.round(maxZ / qy)}`;
                const cached = this._deformedRangeCache;
                if (cached && cached.key === ckey) {
                    ({ xMin, xMax, yMin, yMax } = cached);
                }
                else {
                    let minTx = Infinity, maxTx = -Infinity, minTy = Infinity, maxTy = -Infinity;
                    const spanW = maxX - minX;
                    const spanH = maxZ - minZ;
                    const spanTiles = Math.max(spanW / tileSizeX, spanH / tileSizeY);
                    const G = Math.max(4, Math.min(16, Math.ceil(spanTiles)));
                    for (let i = 0; i <= G; i++) {
                        const wx = minX + spanW * (i / G);
                        for (let j = 0; j <= G; j++) {
                            const wz = minZ + spanH * (j / G);
                            const [tx, ty] = this.engine.worldToTileIndex(wx, wz, idealZ, layerCrs);
                            if (!Number.isFinite(tx) || !Number.isFinite(ty))
                                continue;
                            if (tx < minTx)
                                minTx = tx;
                            if (tx > maxTx)
                                maxTx = tx;
                            if (ty < minTy)
                                minTy = ty;
                            if (ty > maxTy)
                                maxTy = ty;
                        }
                    }
                    const edgePts = this._getWorldEdgePoints();
                    const edgeIdx = this._getEdgeTileIndices(idealZ, layerCrs, edgePts.length);
                    for (let i = 0; i < edgePts.length; i += 2) {
                        const wx = edgePts[i], wz = edgePts[i + 1];
                        if (wx < minX || wx > maxX || wz < minZ || wz > maxZ)
                            continue;
                        const tx = edgeIdx[i], ty = edgeIdx[i + 1];
                        if (!Number.isFinite(tx) || !Number.isFinite(ty))
                            continue;
                        if (tx < minTx)
                            minTx = tx;
                        if (tx > maxTx)
                            maxTx = tx;
                        if (ty < minTy)
                            minTy = ty;
                        if (ty > maxTy)
                            maxTy = ty;
                    }
                    if (Number.isFinite(minTx)) {
                        xMin = Math.max(0, Math.floor(minTx) - 1);
                        xMax = Math.min(maxTile, Math.ceil(maxTx) + 1);
                        yMin = Math.max(0, Math.floor(minTy) - 1);
                        yMax = Math.min(maxTile, Math.ceil(maxTy) + 1);
                    }
                    else if (maxX > -halfX && minX < halfX && maxZ > -halfY && minZ < halfY) {
                        xMin = 0;
                        xMax = maxTile;
                        yMin = 0;
                        yMax = maxTile;
                    }
                    else {
                        xMin = 1;
                        xMax = 0;
                        yMin = 1;
                        yMax = 0;
                    }
                    this._deformedRangeCache = { key: ckey, xMin, xMax, yMin, yMax };
                }
            }
        }
        else {
            xMin = Math.max(0, Math.floor((minX - off.x + halfX) / tileSizeX));
            xMax = Math.min(maxTile, Math.floor((maxX - off.x + halfX) / tileSizeX));
            yMin = Math.max(0, Math.floor((minZ - off.z + halfY) / tileSizeY));
            yMax = Math.min(maxTile, Math.floor((maxZ - off.z + halfY) / tileSizeY));
        }
        // --- Strict bounds (без горизонта) ---
        let sxMin, sxMax, syMin, syMax;
        if (isDeformed) {
            sxMin = xMin;
            sxMax = xMax;
            syMin = yMin;
            syMax = yMax;
        }
        else {
            const strictHh = Math.max(0, hh - margin * tileSizeX);
            const strictHv = Math.max(0, hv - margin * tileSizeY);
            const strictHhRot = strictHh * absCos + strictHv * absSin;
            const strictHvRot = strictHh * absSin + strictHv * absCos;
            let strictMinX = controlsTarget.x - strictHhRot;
            let strictMaxX = controlsTarget.x + strictHhRot;
            let strictMinZ = controlsTarget.z - strictHvRot;
            let strictMaxZ = controlsTarget.z + strictHvRot;
            // Strict тоже расширяем на камеру (1 тайл запаса) — иначе при
            // движении без stable тайлы вплотную к камере ждут бюджета и
            // появляются с задержкой; с расширением — грузятся сразу.
            const sMarginX = tileSizeX;
            const sMarginZ = tileSizeY;
            if (camX - sMarginX < strictMinX)
                strictMinX = camX - sMarginX;
            if (camX + sMarginX > strictMaxX)
                strictMaxX = camX + sMarginX;
            if (camZ - sMarginZ < strictMinZ)
                strictMinZ = camZ - sMarginZ;
            if (camZ + sMarginZ > strictMaxZ)
                strictMaxZ = camZ + sMarginZ;
            sxMin = Math.max(0, Math.floor((strictMinX - off.x + halfX) / tileSizeX));
            sxMax = Math.min(maxTile, Math.floor((strictMaxX - off.x + halfX) / tileSizeX));
            syMin = Math.max(0, Math.floor((strictMinZ - off.z + halfY) / tileSizeY));
            syMax = Math.min(maxTile, Math.floor((strictMaxZ - off.z + halfY) / tileSizeY));
        }
        // --- Центр экрана в tile-space ---
        let cxTile = (xMin + xMax) * 0.5 + 0.5;
        let cyTile = (yMin + yMax) * 0.5 + 0.5;
        try {
            const [tx, ty] = this.engine.worldToTileIndex(controlsTarget.x, controlsTarget.z, idealZ, layerCrs);
            if (Number.isFinite(tx) && Number.isFinite(ty)) {
                cxTile = tx;
                cyTile = ty;
            }
        }
        catch (e) { /* fallback */ }
        // --- Список тайлов, отсортированный center-out ---
        const tileOrder = [];
        for (let y = yMin; y <= yMax; y++) {
            const dy = y + 0.5 - cyTile;
            const dy2 = dy * dy;
            for (let vx = xMin; vx <= xMax; vx++) {
                const dx = vx + 0.5 - cxTile;
                tileOrder.push({ vx, y, d: dx * dx + dy2 });
            }
        }
        tileOrder.sort((a, b) => a.d - b.d);
        // --- Рендер + выборочная загрузка ---
        // Strict-тайлы грузим без ограничений (их немного).
        // Тайлы вне strict (горизонт) — с бюджетом на кадр, чтобы не устроить лавину.
        let loadBudget = stable ? STABLE_LOAD_BUDGET : 0;
        const renderSet = new Set();
        for (const { vx, y } of tileOrder) {
            const k = getVirtKey(idealZ, vx, y);
            const isStrict = vx >= sxMin && vx <= sxMax && y >= syMin && y <= syMax;
            let inst = this.tiles.get(k);
            if (!rapidZoom && !inst) {
                if (isStrict) {
                    inst = this.ensureTile(idealZ, vx, y, k);
                }
                else if (stable && loadBudget > 0) {
                    loadBudget--;
                    inst = this.ensureTile(idealZ, vx, y, k);
                }
            }
            else if (inst && !rapidZoom) {
                inst.lastUsed = this.frame;
            }
            if (inst && inst.ready && inst.mesh) {
                renderSet.add(k);
                continue;
            }
            if (zoomOut) {
                if (!this._collectPartialChildren(idealZ, vx, y, renderSet)) {
                    const anc = this.findReadyAncestor(idealZ, vx, y);
                    if (anc)
                        renderSet.add(this.key(anc.z, anc.virtX, anc.y));
                }
            }
            else {
                const anc = this.findReadyAncestor(idealZ, vx, y);
                if (anc) {
                    renderSet.add(this.key(anc.z, anc.virtX, anc.y));
                }
                else {
                    this._collectPartialChildren(idealZ, vx, y, renderSet);
                }
            }
        }
        // Показать актуальные + обновить lastUsed.
        for (const k of renderSet) {
            const inst = this.tiles.get(k);
            if (!inst || !inst.mesh)
                continue;
            if (!inst.mesh.visible)
                inst.mesh.visible = true;
            inst.lastUsed = this.frame;
        }
        // Скрыть то, что было видимо в прошлом кадре, но пропало из renderSet.
        if (this._visibleKeysPrev) {
            for (const k of this._visibleKeysPrev) {
                if (renderSet.has(k))
                    continue;
                const inst = this.tiles.get(k);
                if (inst && inst.mesh && inst.mesh.visible)
                    inst.mesh.visible = false;
            }
        }
        this._visibleKeysPrev = renderSet;
        this.gc(renderSet);
        // --- Prefetch следующего зума ---
        const viewZ = this.engine.currentDiscreteZoom;
        const zoomSettled = Math.abs(continuousZoom - targetCont) < ZOOM_STABLE_EPSILON;
        if (!rapidZoom && zoomSettled && continuousZoom > viewZ + 0.3 &&
            idealZ < this.engine.MAX_ZOOM &&
            idealZ < this._maxNativeZoom &&
            this._lastPrefetchZoom < idealZ) {
            this._lastPrefetchZoom = idealZ;
            this.prefetchNextZoomLevel(controlsTarget, idealZ + 1, worldGroupPos);
        }
        return idealZ;
    }
    _updateGlobe(camera, continuousZoom) {
        if (!this._isVisible) {
            this.setVisible(false);
            return -1;
        }
        this.frame++;
        const prevIdealZ = this._lastIdealZ;
        let idealZ = Math.max(0, this._liveIdealZ());
        if (idealZ !== prevIdealZ) {
            this._zoomOut = idealZ < prevIdealZ;
            this._lastIdealZ = idealZ;
        }
        const zoomOut = !!this._zoomOut;
        const targetCont = this.engine.targetContinuousZoom ?? continuousZoom;
        const _layerOffset = this.layer?.zoomOffset ?? 0;
        const _minNZ = this.layer?.minNativeZoom ?? 0;
        const _maxNZ = this.layer?.maxNativeZoom ?? this.engine.MAX_ZOOM;
        const targetZ = Math.max(_minNZ, Math.min(_maxNZ, Math.round(targetCont + _layerOffset)));
        const rapidZoom = Math.abs(targetZ - idealZ) >= RAPID_ZOOM_GAP;
        // Камера → локальные координаты worldGroup (у нас identity, но так общее).
        const camLocal = this._tmpCam || (this._tmpCam = new THREE.Vector3());
        camLocal.copy(camera.position);
        if (this.engine.worldGroup)
            this.engine.worldGroup.worldToLocal(camLocal);
        const tileCrs = this._layerCrs;
        // Страховка от лавины: если диапазон слишком широкий — временно грубее LOD.
        let ranges = null, tries = 0;
        while (tries++ < 4) {
            ranges = this.engine.surface.visibleTileRanges(camLocal, idealZ, tileCrs);
            if (!ranges)
                break;
            let total = 0;
            for (const r of ranges)
                total += (r.xMax - r.xMin + 1) * (r.yMax - r.yMin + 1);
            if (total <= 700 || idealZ <= 0)
                break;
            idealZ--;
        }
        if (!ranges || !ranges.length) {
            if (this._visibleKeysPrev) {
                for (const k of this._visibleKeysPrev) {
                    const inst = this.tiles.get(k);
                    if (inst?.mesh)
                        inst.mesh.visible = false;
                }
                this._visibleKeysPrev = null;
            }
            return idealZ;
        }
        const renderSet = new Set();
        // Создаем Frustum для отсечения невидимых тайлов
        const frustum = new THREE.Frustum();
        const projScreenMatrix = new THREE.Matrix4();
        projScreenMatrix.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
        frustum.setFromProjectionMatrix(projScreenMatrix);
        const worldGroup = this.engine.worldGroup;
        const tmpSphere = new THREE.Sphere();
        const tmpVec = new THREE.Vector3();
        const surface = this.engine.surface;
        let loadBudget = 20; // Максимум новых тайлов за кадр
        for (const rg of ranges) {
            const { xMin, xMax, yMin, yMax } = rg;
            const order = [];
            for (let y = yMin; y <= yMax; y++) {
                const dy = y + 0.5 - rg.cyTile, dy2 = dy * dy;
                for (let vx = xMin; vx <= xMax; vx++) {
                    const dx = vx + 0.5 - rg.cxTile;
                    order.push({ vx, y, d: dx * dx + dy2 });
                }
            }
            order.sort((a, b) => a.d - b.d);
            for (const { vx, y } of order) {
                // --- FRUSTUM CULLING ---
                const n = 1 << idealZ;
                const tileCenterX = ((vx + 0.5) / n) * 2 * tileCrs.halfExtentX - tileCrs.halfExtentX;
                const tileCenterY = tileCrs.halfExtentY - ((y + 0.5) / n) * 2 * tileCrs.halfExtentY;
                const lonLat = tileCrs.toLonLat([tileCenterX, tileCenterY]);
                if (!lonLat || !Number.isFinite(lonLat[0]) || !Number.isFinite(lonLat[1]))
                    continue;
                surface.position(lonLat[0], lonLat[1], 0, tmpVec);
                if (worldGroup)
                    worldGroup.localToWorld(tmpVec);
                // Примерный радиус тайла (с запасом)
                const radius = this.engine.R * (Math.PI / n) * 1.5;
                tmpSphere.center.copy(tmpVec);
                tmpSphere.radius = radius;
                // Если тайл не влезает в экран — пропускаем
                if (!frustum.intersectsSphere(tmpSphere))
                    continue;
                // -----------------------
                const k = getVirtKey(idealZ, vx, y);
                let inst = this.tiles.get(k);
                if (!inst) {
                    if (!rapidZoom && loadBudget > 0) {
                        loadBudget--;
                        inst = this.ensureTile(idealZ, vx, y, k);
                    }
                }
                else {
                    inst.lastUsed = this.frame;
                }
                if (inst && inst.ready && inst.mesh) {
                    renderSet.add(k);
                    continue;
                }
                if (zoomOut) {
                    if (!this._collectPartialChildren(idealZ, vx, y, renderSet)) {
                        const anc = this.findReadyAncestor(idealZ, vx, y);
                        if (anc)
                            renderSet.add(this.key(anc.z, anc.virtX, anc.y));
                    }
                }
                else {
                    const anc = this.findReadyAncestor(idealZ, vx, y);
                    if (anc)
                        renderSet.add(this.key(anc.z, anc.virtX, anc.y));
                    else
                        this._collectPartialChildren(idealZ, vx, y, renderSet);
                }
            }
        }
        for (const k of renderSet) {
            const inst = this.tiles.get(k);
            if (!inst || !inst.mesh)
                continue;
            if (!inst.mesh.visible)
                inst.mesh.visible = true;
            inst.lastUsed = this.frame;
        }
        if (this._visibleKeysPrev) {
            for (const k of this._visibleKeysPrev) {
                if (renderSet.has(k))
                    continue;
                const inst = this.tiles.get(k);
                if (inst && inst.mesh && inst.mesh.visible)
                    inst.mesh.visible = false;
            }
        }
        this._visibleKeysPrev = renderSet;
        this.gc(renderSet);
        return idealZ;
    }
    /** Добавляет готовых детей (z+1); true если все 4 готовы. */
    _collectPartialChildren(z, virtX, y, renderSet) {
        if (z + 1 > this._maxNativeZoom)
            return false;
        let count = 0;
        const cz = z + 1;
        const cx = virtX * 2;
        const cy = y * 2;
        for (let dx = 0; dx < 2; dx++) {
            for (let dy = 0; dy < 2; dy++) {
                const ck = this.key(cz, cx + dx, cy + dy);
                const ci = this.tiles.get(ck);
                if (ci && ci.ready && ci.mesh && !ci.unrenderable) {
                    renderSet.add(ck);
                    count++;
                }
            }
        }
        return count === 4;
    }
    findReadyAncestor(z, virtX, y) {
        const minZ = Math.max(this.engine.MIN_ZOOM, this._minNativeZoom);
        for (let dz = 1; dz <= ANCESTOR_FALLBACK && z - dz >= minZ; dz++) {
            const az = z - dz;
            const ax = virtX >> dz;
            const ay = y >> dz;
            const inst = this.tiles.get(this.key(az, ax, ay));
            if (inst && inst.ready && inst.mesh && !inst.unrenderable)
                return inst;
        }
        return null;
    }
    ensureTile(z, virtX, y, k = null) {
        k = k ?? this.key(z, virtX, y);
        if (this._deadKeys.has(k)) {
            const inst = {
                z, virtX, y, mesh: null, geometry: null,
                ready: true, failed: true, unrenderable: true,
                loading: false, lastUsed: this.frame,
            };
            this.tiles.set(k, inst);
            return inst;
        }
        let inst = this.tiles.get(k);
        if (inst) {
            inst.lastUsed = this.frame;
            return inst;
        }
        inst = {
            z, virtX, y,
            mesh: null, geometry: null,
            ready: false, failed: false, unrenderable: false,
            loading: true, texUrl: null, lastUsed: this.frame,
            heightsApplied: false, elevationAppliedLevel: 0, expectsElevation: false,
            overlayTex: null,
        };
        this.tiles.set(k, inst);
        this.loadTile(inst);
        return inst;
    }
    /* ---------- Загрузка тайла ---------- */
    async loadTile(inst) {
        const k = this.key(inst.z, inst.virtX, inst.y);
        let texUrl = null;
        try {
            const srcX = ((inst.virtX % (1 << inst.z)) + (1 << inst.z)) % (1 << inst.z);
            const srcKey = getVirtKey(inst.z, srcX, inst.y);
            texUrl = this.engine.getTextureUrl(this.layer, inst.z, srcX, inst.y);
            if (this.hasElevation &&
                inst.z >= this._minElevationNativeZoom &&
                inst.z <= this._maxElevationNativeZoom) {
                const elevUrl = this.engine.getElevationUrl(this.layer, inst.z, srcX, inst.y);
                if (elevUrl)
                    this.srcKeyToElevUrl.set(srcKey, elevUrl);
            }
            const texture = await this.loadTextureAsync(texUrl, inst);
            if (!texture) {
                if (this.tiles.get(k) === inst) {
                    inst.loading = false;
                    inst.ready = true;
                    inst.failed = true;
                    inst.unrenderable = true;
                }
                this.releaseTexture(texUrl);
                return;
            }
            if (this.tiles.get(k) !== inst || (this.frame - inst.lastUsed > 15 && inst.z !== this._lastIdealZ)) {
                this.releaseTexture(texUrl);
                if (this.tiles.get(k) === inst)
                    this.tiles.delete(k);
                return;
            }
            const build = () => {
                if (this.tiles.get(k) !== inst)
                    return undefined;
                const mesh = this.createTileMesh(inst, texture);
                if (!mesh)
                    return null;
                if (texture)
                    this.engine.renderer?.initTexture?.(texture);
                const provider = this._elevationProvider;
                if (provider &&
                    typeof provider.getTileTexture === 'function' &&
                    provider.isElevationProvider?.()) {
                    const overlayTex = provider.getTileTexture(inst.z, srcX, inst.y, this.engine.TILE_PIXELS);
                    if (overlayTex) {
                        this.setMeshOverlay(mesh, overlayTex, provider.getOpacity?.() ?? 1);
                        inst.overlayTex = overlayTex;
                        this.engine.renderer?.initTexture?.(overlayTex);
                    }
                }
                return mesh;
            };
            const useQueue = this._isDeformed || !!this._elevationProvider;
            const mesh = useQueue ? await this._enqueueBuild(inst, build) : build();
            if (mesh === undefined || this.tiles.get(k) !== inst) {
                if (mesh) {
                    mesh.geometry.dispose();
                    mesh.material.dispose();
                }
                this.releaseTexture(texUrl);
                return;
            }
            if (!mesh) {
                inst.unrenderable = true;
                inst.failed = true;
                inst.loading = false;
                inst.ready = true;
                this._deadKeys.add(k);
                this.releaseTexture(texUrl);
                return;
            }
            inst.mesh = mesh;
            inst.geometry = mesh.geometry;
            inst.texUrl = texUrl;
            inst.loading = false;
            this.engine.worldGroup.add(mesh);
            if (this.hasElevation && this.shouldApplyElevation(inst)) {
                inst.expectsElevation = true;
                this.requestElevation(inst);
            }
            else {
                inst.ready = true;
            }
        }
        catch (err) {
            if (this.tiles.get(k) !== inst)
                return;
            console.warn(`Tile load error ${inst.z}/${inst.virtX}/${inst.y}:`, err.message);
            inst.loading = false;
            inst.failed = true;
            inst.ready = true;
            this.engine.emit?.('error', {
                source: 'tile',
                layer: this.layer,
                z: inst.z, x: inst.virtX, y: inst.y,
                url: texUrl,
                error: err,
            });
        }
    }
    shouldApplyElevation(inst) {
        return inst.z >= this._minElevationNativeZoom;
    }
    createTileMesh(inst, texture) {
        if (this.engine.globe)
            return this._createGlobeTileMesh(inst, texture);
        if (this._isDeformed) {
            return this._createDeformedTileMesh(inst, texture);
        }
        const { z, virtX, y } = inst;
        const tileSizeX = (2 * this._mapHalfX) / Math.pow(2, z);
        const tileSizeY = (2 * this._mapHalfY) / Math.pow(2, z);
        const seg = this.hasElevation ? this.engine.SEGMENTS : 1;
        const originX = virtX * tileSizeX - this._mapHalfX;
        const originZ = getOriginZ(y, tileSizeY, this._mapHalfY);
        const canReuseFlat = !this.hasElevation
            && this.flatTileGeometry
            && this._mapHalfX === this._mapHalfY;
        let geometry;
        if (canReuseFlat) {
            geometry = this.flatTileGeometry.clone();
            geometry.rotateX(-Math.PI / 2);
        }
        else {
            geometry = new THREE.PlaneGeometry(tileSizeX, tileSizeY, seg, seg);
            geometry.rotateX(-Math.PI / 2);
        }
        const mat = this._createTileMaterial(texture);
        const mesh = new THREE.Mesh(geometry, mat);
        mesh.position.set(originX + tileSizeX / 2, 0, originZ + tileSizeY / 2);
        mesh.renderOrder = this._baseRenderOrder + z;
        mesh.visible = false;
        return mesh;
    }
    _createDeformedTileMesh(inst, texture) {
        const { z, virtX, y } = inst;
        const n = 1 << z;
        const mapProj = this.engine.projection;
        const tileCrs = this._layerCrs;
        const tileHalfX = tileCrs.halfExtentX;
        const tileHalfY = tileCrs.halfExtentY;
        const seg = this.hasElevation ? this.engine.SEGMENTS : DEFORM_SEGMENTS_FLAT;
        const grid = seg + 1;
        const count = grid * grid;
        const geom = new THREE.PlaneGeometry(1, 1, seg, seg);
        geom.rotateX(-Math.PI / 2);
        const arr = geom.attributes.position.array;
        const separable = tileCrs.isMercator || tileCrs.isGeographic;
        let lons = null, lats = null;
        if (separable) {
            lons = new Float64Array(grid);
            lats = new Float64Array(grid);
            for (let i = 0; i < grid; i++) {
                const wx = ((virtX + i / seg) / n) * 2 * tileHalfX - tileHalfX;
                lons[i] = tileCrs.toLonLat([wx, 0])[0];
            }
            for (let j = 0; j < grid; j++) {
                const wy = tileHalfY - ((y + j / seg) / n) * 2 * tileHalfY;
                lats[j] = tileCrs.toLonLat([0, wy])[1];
            }
        }
        const safe = typeof mapProj.fromLonLatSafe === 'function';
        const ll = [0, 0];
        const valid = new Uint8Array(count);
        const maxLat = mapProj.maxLatDeg;
        let sumX = 0, sumZ = 0, nValid = 0;
        for (let j = 0; j < grid; j++) {
            const tileWorldY = tileHalfY - ((y + j / seg) / n) * 2 * tileHalfY;
            for (let i = 0; i < grid; i++) {
                const idx = j * grid + i, k = idx * 3;
                let lon, lat;
                if (separable) {
                    lon = lons[i];
                    lat = lats[j];
                }
                else {
                    const tileWorldX = ((virtX + i / seg) / n) * 2 * tileHalfX - tileHalfX;
                    const r = tileCrs.toLonLat([tileWorldX, tileWorldY]);
                    lon = r?.[0];
                    lat = r?.[1];
                }
                if (!Number.isFinite(lon) || !Number.isFinite(lat))
                    continue;
                if (maxLat != null && Math.abs(lat) > maxLat)
                    lat = Math.sign(lat) * maxLat;
                lon = Math.max(-179.9999, Math.min(179.9999, lon));
                ll[0] = lon;
                ll[1] = lat;
                const p = safe ? mapProj.fromLonLatSafe(ll) : mapProj.fromLonLat(ll);
                if (!p || !Number.isFinite(p[0]) || !Number.isFinite(p[1]))
                    continue;
                arr[k] = p[0];
                arr[k + 1] = 0;
                arr[k + 2] = -p[1];
                valid[idx] = 1;
                sumX += p[0];
                sumZ -= p[1];
                nValid++;
            }
        }
        if (nValid < 3) {
            geom.dispose();
            return null;
        }
        const cx = sumX / nValid, cz = sumZ / nValid;
        for (let idx = 0; idx < count; idx++) {
            const k = idx * 3;
            if (valid[idx]) {
                arr[k] -= cx;
                arr[k + 2] -= cz;
            }
            else {
                arr[k] = 0;
                arr[k + 1] = 0;
                arr[k + 2] = 0;
            }
        }
        const maxEdge2 = (0.25 * this.engine.WORLD_SIZE) ** 2;
        const tris = [], signs = [];
        let pos = 0, neg = 0;
        const X = (i) => arr[i * 3], Z = (i) => arr[i * 3 + 2];
        const d2 = (a, b) => (X(a) - X(b)) ** 2 + (Z(a) - Z(b)) ** 2;
        const tryTri = (a, b, c) => {
            if (!valid[a] || !valid[b] || !valid[c])
                return;
            if (d2(a, b) > maxEdge2 || d2(b, c) > maxEdge2 || d2(c, a) > maxEdge2)
                return;
            const s = (X(b) - X(a)) * (Z(c) - Z(a)) - (X(c) - X(a)) * (Z(b) - Z(a));
            if (s === 0)
                return;
            tris.push(a, b, c);
            signs.push(s > 0 ? 1 : -1);
            s > 0 ? pos++ : neg++;
        };
        for (let iy = 0; iy < seg; iy++) {
            for (let ix = 0; ix < seg; ix++) {
                const a = ix + grid * iy, b = ix + grid * (iy + 1);
                const c = ix + 1 + grid * (iy + 1), d = ix + 1 + grid * iy;
                tryTri(a, b, d);
                tryTri(b, c, d);
            }
        }
        const keep = pos >= neg ? 1 : -1;
        const out = [];
        for (let t = 0; t < signs.length; t++) {
            if (signs[t] === keep)
                out.push(tris[t * 3], tris[t * 3 + 1], tris[t * 3 + 2]);
        }
        if (!out.length) {
            geom.dispose();
            return null;
        }
        const IndexArr = count > 65535 ? Uint32Array : Uint16Array;
        geom.setIndex(new THREE.BufferAttribute(new IndexArr(out), 1));
        geom.attributes.position.needsUpdate = true;
        if (this.tileLighting && !this.hasElevation)
            geom.computeVertexNormals();
        geom.computeBoundingSphere();
        const mesh = new THREE.Mesh(geom, this._createTileMaterial(texture));
        mesh.position.set(cx, 0, cz);
        mesh.renderOrder = this._baseRenderOrder + z;
        mesh.visible = false;
        mesh.userData.deformedTile = true;
        return mesh;
    }
    _createGlobeTileMesh(inst, texture) {
        const { z, virtX, y } = inst;
        // Сегментов по зуму: на z=0 тайл — весь шар, нужна плотная сетка.
        const SEG_TABLE = [64, 64, 48, 32, 24, 16, 12, 8];
        const seg = this.hasElevation
            ? this.engine.SEGMENTS
            : SEG_TABLE[Math.min(z, SEG_TABLE.length - 1)];
        const built = this.engine.surface.buildTileGeometry(z, virtX, y, seg, this._layerCrs, null);
        if (!built)
            return null;
        const mesh = new THREE.Mesh(built.geometry, this._createTileMaterial(texture));
        mesh.position.copy(built.center);
        mesh.renderOrder = this._baseRenderOrder + z;
        mesh.visible = false;
        mesh.userData.deformedTile = true;
        mesh.userData.globeTile = true;
        return mesh;
    }
    createStaticTileMesh(tileSize, originX, originZ, texture) {
        const geom = new THREE.PlaneGeometry(tileSize, tileSize, 1, 1);
        geom.rotateX(-Math.PI / 2);
        const mat = this._createTileMaterial(texture, {
            depthWrite: false,
            depthTest: false
        });
        const mesh = new THREE.Mesh(geom, mat);
        mesh.position.set(originX + tileSize / 2, -1.5, originZ + tileSize / 2);
        mesh.renderOrder = -2;
        return mesh;
    }
    /* ---------- Текстуры ---------- */
    async loadTextureAsync(url, inst = null) {
        if (!url)
            return null;
        const cached = this.textureCache.get(url);
        if (cached) {
            cached.refs++;
            return cached.texture;
        }
        if (this._inFlightTextures.has(url)) {
            const tex = await this._inFlightTextures.get(url);
            if (tex) {
                const e = this.textureCache.get(url);
                if (e)
                    e.refs++;
                else
                    this.textureCache.set(url, { texture: tex, refs: 2 });
            }
            return tex;
        }
        const promise = new Promise((resolve) => {
            this._textureQueue.push({ url, inst, resolve });
            this._pumpTextureQueue();
        });
        this._inFlightTextures.set(url, promise);
        const texture = await promise;
        this._inFlightTextures.delete(url);
        if (!texture)
            return null;
        const existing = this.textureCache.get(url);
        if (existing) {
            existing.refs++;
        }
        else {
            this.textureCache.set(url, { texture, refs: 1 });
        }
        return texture;
    }
    _pumpTextureQueue() {
        const q = this._textureQueue;
        if (q.length === 0)
            return;
        if (this._activeTextureLoads >= MAX_TEXTURE_LOADS)
            return;
        const _off = this.layer?.zoomOffset ?? 0;
        const _tc = this.engine.targetContinuousZoom;
        const iz = _tc != null ? Math.round(_tc + _off) : this._liveIdealZ();
        // Вычищаем устаревшие элементы.
        for (let i = q.length - 1; i >= 0; i--) {
            const inst = q[i].inst;
            if (!inst)
                continue;
            const k = this.key(inst.z, inst.virtX, inst.y);
            const isStale = this.tiles.get(k) !== inst
                || (this.frame - inst.lastUsed > 2 && inst.z !== this._lastIdealZ && inst.z !== iz);
            if (isStale) {
                const job = q[i];
                q.splice(i, 1);
                this._inFlightTextures.delete(job.url);
                if (this.tiles.get(k) === inst)
                    this.tiles.delete(k);
                job.resolve(null);
            }
        }
        if (q.length >= 8) {
            q.sort((a, b) => {
                const az = a.inst ? Math.abs(a.inst.z - iz) : Infinity;
                const bz = b.inst ? Math.abs(b.inst.z - iz) : Infinity;
                if (az !== bz)
                    return az - bz;
                return (b.inst?.lastUsed ?? 0) - (a.inst?.lastUsed ?? 0);
            });
        }
        while (this._activeTextureLoads < MAX_TEXTURE_LOADS && q.length > 0) {
            const job = q.shift();
            this._activeTextureLoads++;
            const done = (tex) => {
                this._activeTextureLoads--;
                if (tex)
                    tex.colorSpace = THREE.SRGBColorSpace;
                job.resolve(tex);
                this._pumpTextureQueue();
            };
            this.textureLoader.load(job.url, done, undefined, () => done(null));
        }
    }
    releaseTexture(url) {
        if (!url)
            return;
        const e = this.textureCache.get(url);
        if (!e)
            return;
        e.refs--;
        if (e.refs <= 0) {
            e.texture.dispose();
            this.textureCache.delete(url);
        }
    }
    /* ---------- Высоты ---------- */
    async requestElevation(inst) {
        const k = this.key(inst.z, inst.virtX, inst.y);
        try {
            const srcX = ((inst.virtX % (1 << inst.z)) + (1 << inst.z)) % (1 << inst.z);
            const srcKey = getVirtKey(inst.z, srcX, inst.y);
            let heights = null;
            if (inst.z >= this._minElevationNativeZoom &&
                inst.z <= this._maxElevationNativeZoom) {
                const provider = this._elevationProvider;
                if (provider &&
                    typeof provider.isElevationProvider === 'function' &&
                    provider.isElevationProvider() &&
                    typeof provider.getTileHeights === 'function') {
                    heights = provider.getTileHeights(inst.z, inst.virtX, inst.y, this.engine.SEGMENTS);
                    if (!heights) {
                        inst.ready = true;
                        return;
                    }
                }
                if (!heights) {
                    const elevUrl = this.srcKeyToElevUrl.get(srcKey);
                    if (elevUrl) {
                        const tileSizeX = (2 * this._mapHalfX) / Math.pow(2, inst.z);
                        const tileSizeY = (2 * this._mapHalfY) / Math.pow(2, inst.z);
                        const originX = inst.virtX * tileSizeX - this._mapHalfX;
                        const originZ = getOriginZ(inst.y, tileSizeY, this._mapHalfY);
                        heights = await this.getDirectElevData(srcKey, elevUrl, tileSizeX, originX, originZ);
                    }
                }
            }
            if (!heights) {
                heights = await this.getFallbackElevation(inst);
            }
            if (this.tiles.get(k) !== inst || !inst.mesh)
                return;
            this.applyHeightsToGeometry(inst, heights);
            inst.ready = true;
        }
        catch (err) {
            if (this.tiles.get(k) !== inst)
                return;
            console.warn(`Elevation error ${inst.z}/${inst.virtX}/${inst.y}:`, err.message);
            inst.ready = true;
        }
    }
    async getDirectElevData(srcKey, elevUrl, tileSize, originX, originZ) {
        const heightScale = this.getElevationHeightScale();
        if (this.parentElevCache.has(srcKey)) {
            const imageData = this.parentElevCache.get(srcKey);
            if (imageData) {
                return (await this.scheduleWorkerJob('computeFromImageData', {
                    imageData, tileSize, originX, originZ,
                    segments: this.engine.SEGMENTS, heightScale
                })).heights;
            }
        }
        if (this.elevDirectPromises.has(srcKey)) {
            return this.elevDirectPromises.get(srcKey);
        }
        const executeJob = async () => {
            this.activeElevationFetches++;
            try {
                const result = await this.scheduleWorkerJob('computeFromUrl', {
                    url: elevUrl, tileSize, originX, originZ,
                    segments: this.engine.SEGMENTS, heightScale
                });
                if (result.imageData)
                    this.parentElevCache.set(srcKey, result.imageData);
                return result.heights;
            }
            finally {
                this.activeElevationFetches--;
                this._processElevationQueue();
            }
        };
        const promise = new Promise((resolve, reject) => {
            if (this.activeElevationFetches < this.MAX_ELEVATION_FETCHES) {
                executeJob().then(resolve).catch(reject);
            }
            else {
                this.elevationQueue.push({ execute: executeJob, resolve, reject });
            }
        });
        this.elevDirectPromises.set(srcKey, promise);
        promise.catch(() => { }).finally(() => {
            this.elevDirectPromises.delete(srcKey);
        });
        return promise;
    }
    _processElevationQueue() {
        while (this.activeElevationFetches < this.MAX_ELEVATION_FETCHES && this.elevationQueue.length > 0) {
            const { execute, resolve, reject } = this.elevationQueue.shift();
            execute().then(resolve).catch(reject);
        }
    }
    async getFallbackElevation(inst) {
        let fz = inst.z - 1;
        while (fz > this._maxElevationNativeZoom)
            fz--;
        if (fz < this._minElevationNativeZoom)
            throw new Error('No elevation fallback');
        const srcX = ((inst.virtX % (1 << inst.z)) + (1 << inst.z)) % (1 << inst.z);
        const scale = 1 << (inst.z - fz);
        const pSrcX = Math.floor(srcX / scale);
        const pY = Math.floor(inst.y / scale);
        const parentData = await this.getParentElevData(fz, pSrcX, pY);
        if (!parentData)
            throw new Error('No parent data');
        const tileSizeX = (2 * this._mapHalfX) / Math.pow(2, inst.z);
        const tileSizeY = (2 * this._mapHalfY) / Math.pow(2, inst.z);
        const originX = inst.virtX * tileSizeX - this._mapHalfX;
        const originZ = getOriginZ(inst.y, tileSizeY, this._mapHalfY);
        const dx = srcX % scale, dy = inst.y % scale;
        const imageDataCopy = new ImageData(new Uint8ClampedArray(parentData.data), parentData.width, parentData.height);
        const result = await this.scheduleWorkerJob('computeFromParent', {
            imageData: imageDataCopy,
            tileSize: tileSizeX, originX, originZ,
            segments: this.engine.SEGMENTS,
            scale, dx, dy,
            heightScale: this.getElevationHeightScale()
        });
        return result.heights;
    }
    async getParentElevData(z, srcX, y) {
        if (z < this._minElevationNativeZoom || z > this._maxElevationNativeZoom)
            return null;
        const url = this.engine.getElevationUrl(this.layer, z, srcX, y);
        if (!url)
            return null;
        const key = `${z},${srcX},${y}`;
        if (this.parentElevCache.has(key))
            return this.parentElevCache.get(key);
        if (this.parentElevPromises.has(key))
            return this.parentElevPromises.get(key);
        const promise = new Promise((resolve) => {
            const img = new Image();
            img.crossOrigin = 'anonymous';
            img.onload = () => {
                const canvas = document.createElement('canvas');
                canvas.width = canvas.height = this.engine.TILE_PIXELS;
                const ctx2d = canvas.getContext('2d');
                ctx2d.drawImage(img, 0, 0);
                const imgData = ctx2d.getImageData(0, 0, this.engine.TILE_PIXELS, this.engine.TILE_PIXELS);
                this.parentElevCache.set(key, imgData);
                this.parentElevPromises.delete(key);
                resolve(imgData);
            };
            img.onerror = () => {
                this.parentElevCache.set(key, null);
                this.parentElevPromises.delete(key);
                resolve(null);
            };
            img.src = url;
        });
        this.parentElevPromises.set(key, promise);
        return promise;
    }
    applyHeightsToGeometry(inst, heights) {
        if (this.engine.globe) {
            // Делегируем расчет сферы в GlobeSurface, который правильно 
            // сдвигает вершины вдоль нормали эллипсоида.
            this.engine.surface.applyHeights(inst.geometry, heights);
            inst.heightsApplied = true;
            inst.ready = true;
            if (this.tileLighting) {
                inst.geometry.computeVertexNormals();
            }
            for (const cb of this.onTileHeightAppliedCallbacks) {
                try {
                    cb(inst);
                }
                catch (e) {
                    console.warn('Tile overlay callback error', e);
                }
            }
            return;
        }
        // --- Старый плоский путь ---
        const pos = inst.geometry.attributes.position.array;
        for (let i = 0; i < heights.length; i++)
            pos[i * 3 + 1] = heights[i];
        inst.geometry.attributes.position.needsUpdate = true;
        this.syncTileWithNeighbors(inst);
        if (this.tileLighting)
            inst.geometry.computeVertexNormals();
        inst.heightsApplied = true;
        inst.ready = true;
        for (const cb of this.onTileHeightAppliedCallbacks) {
            try {
                cb(inst);
            }
            catch (e) {
                console.warn('Tile overlay callback error', e);
            }
        }
    }
    syncTileWithNeighbors(inst) {
        if (this.engine.globe)
            return;
        const neighbors = [[1, 0], [-1, 0], [0, 1], [0, -1]];
        for (const [dx, dy] of neighbors) {
            const nVirtX = inst.virtX + dx, nY = inst.y + dy;
            const nKey = this.key(inst.z, nVirtX, nY);
            const nInst = this.tiles.get(nKey);
            if (nInst && nInst.heightsApplied) {
                this.syncEdgesBetween(inst, nInst, dx, dy);
            }
        }
    }
    syncEdgesBetween(instA, instB, dx, dy) {
        const posA = instA.geometry.attributes.position.array;
        const posB = instB.geometry.attributes.position.array;
        const seg = this.engine.SEGMENTS;
        const stride = seg + 1;
        let changed = false;
        for (let i = 0; i <= seg; i++) {
            let iA, iB;
            if (dx === 1 && dy === 0) {
                iA = i * stride + seg;
                iB = i * stride;
            }
            else if (dx === -1 && dy === 0) {
                iA = i * stride;
                iB = i * stride + seg;
            }
            else if (dx === 0 && dy === -1) {
                iA = i;
                iB = seg * stride + i;
            }
            else if (dx === 0 && dy === 1) {
                iA = seg * stride + i;
                iB = i;
            }
            else
                continue;
            const idxA = iA * 3 + 1;
            const idxB = iB * 3 + 1;
            const hA = posA[idxA], hB = posB[idxB];
            if (Math.abs(hA - hB) > 1e-4) {
                const avg = (hA + hB) * 0.5;
                posA[idxA] = avg;
                posB[idxB] = avg;
                changed = true;
            }
        }
        if (changed) {
            instA.geometry.attributes.position.needsUpdate = true;
            instB.geometry.attributes.position.needsUpdate = true;
            if (this.tileLighting) {
                instB.geometry.computeVertexNormals();
            }
        }
    }
    getElevationHeightScale() {
        return this.layer?.heightScale ?? DEFAULTS.HEIGHT_SCALE;
    }
    _getWorldEdgePoints() {
        if (this._edgePts)
            return this._edgePts;
        const proj = this.engine.projection, pts = [], B = 64;
        const push = (lon, lat) => {
            const p = proj.fromLonLatSafe?.([lon, lat]);
            if (p)
                pts.push(p[0], -p[1]);
        };
        for (let k = 0; k <= B; k++) {
            const lat = -90 + 180 * k / B, lon = -180 + 360 * k / B;
            push(-180, lat);
            push(180, lat);
            push(lon, -90);
            push(lon, 90);
        }
        return (this._edgePts = new Float64Array(pts));
    }
    _getEdgeTileIndices(idealZ, layerCrs, count) {
        const c = this._edgeTileIdxCache;
        if (c && c.idealZ === idealZ && c.layer === this.layer && c.count === count) {
            return c.idx;
        }
        const pts = this._getWorldEdgePoints();
        const idx = new Float64Array(count);
        for (let i = 0; i < count; i += 2) {
            const [tx, ty] = this.engine.worldToTileIndex(pts[i], pts[i + 1], idealZ, layerCrs);
            idx[i] = Number.isFinite(tx) ? tx : NaN;
            idx[i + 1] = Number.isFinite(ty) ? ty : NaN;
        }
        this._edgeTileIdxCache = { idealZ, layer: this.layer, count, idx };
        return idx;
    }
    prefetchParentElevations(center, z, worldGroupPos) {
        if (!this.hasElevation ||
            z < this._minElevationNativeZoom ||
            z > this._maxElevationNativeZoom)
            return;
        if (this._elevationProvider)
            return;
        const isDeformed = this._isDeformed;
        const layerCrs = this.layer?.crs;
        const halfX = this._mapHalfX;
        const halfY = this._mapHalfY;
        const tileSizeX = (2 * halfX) / Math.pow(2, z);
        const tileSizeY = (2 * halfY) / Math.pow(2, z);
        const margin = 2;
        const radiusX = tileSizeX * margin;
        const radiusY = tileSizeY * margin;
        const maxTile = (1 << z) - 1;
        let xMin, xMax, yMin, yMax;
        if (isDeformed) {
            const c = this._rangeCache, tol = 0.25 * Math.min(tileSizeX, tileSizeY);
            const minX = center.x - radiusX, maxX = center.x + radiusX;
            const minZ = center.z - radiusY, maxZ = center.z + radiusY;
            if (c && c.z === z &&
                Math.abs(c.minX - minX) < tol && Math.abs(c.maxX - maxX) < tol &&
                Math.abs(c.minZ - minZ) < tol && Math.abs(c.maxZ - maxZ) < tol) {
                ({ xMin, xMax, yMin, yMax } = c);
            }
            else {
                let minTx = Infinity, maxTx = -Infinity, minTy = Infinity, maxTy = -Infinity;
                const acc = (wx, wz) => {
                    const t = this.engine.worldToTileIndex(wx, wz, z, layerCrs);
                    const tx = t[0], ty = t[1];
                    if (!Number.isFinite(tx) || !Number.isFinite(ty))
                        return;
                    if (tx < minTx)
                        minTx = tx;
                    if (tx > maxTx)
                        maxTx = tx;
                    if (ty < minTy)
                        minTy = ty;
                    if (ty > maxTy)
                        maxTy = ty;
                };
                const G = 8, spanW = maxX - minX, spanH = maxZ - minZ;
                for (let i = 0; i <= G; i++) {
                    const f = i / G;
                    acc(minX + spanW * f, minZ);
                    acc(minX + spanW * f, maxZ);
                    acc(minX, minZ + spanH * f);
                    acc(maxX, minZ + spanH * f);
                }
                const e = this._getWorldEdgePoints();
                for (let k = 0; k < e.length; k += 2) {
                    const wx = e[k], wz = e[k + 1];
                    if (wx >= minX && wx <= maxX && wz >= minZ && wz <= maxZ)
                        acc(wx, wz);
                }
                if (Number.isFinite(minTx)) {
                    xMin = Math.max(0, Math.floor(minTx) - 1);
                    xMax = Math.min(maxTile, Math.ceil(maxTx) + 1);
                    yMin = Math.max(0, Math.floor(minTy) - 1);
                    yMax = Math.min(maxTile, Math.ceil(maxTy) + 1);
                }
                else if (maxX > -halfX && minX < halfX && maxZ > -halfY && minZ < halfY) {
                    xMin = 0;
                    xMax = maxTile;
                    yMin = 0;
                    yMax = maxTile;
                }
                else {
                    xMin = 1;
                    xMax = 0;
                    yMin = 1;
                    yMax = 0;
                }
                this._rangeCache = { z, minX, maxX, minZ, maxZ, xMin, xMax, yMin, yMax };
            }
        }
        else {
            xMin = Math.floor((center.x - radiusX - worldGroupPos.x + halfX) / tileSizeX);
            xMax = Math.floor((center.x + radiusX - worldGroupPos.x + halfX) / tileSizeX);
            xMin = Math.max(0, xMin);
            xMax = Math.min(maxTile, xMax);
            yMin = 0;
            yMax = maxTile;
        }
        if (xMin > xMax || yMin > yMax)
            return;
        for (let y = yMin; y <= yMax; y++) {
            if (!isDeformed) {
                const oz = getOriginZ(y, tileSizeY, halfY) + worldGroupPos.z;
                if (oz + tileSizeY < center.z - radiusY || oz > center.z + radiusY)
                    continue;
            }
            for (let x = xMin; x <= xMax; x++) {
                this.getParentElevData(z, x, y).catch(() => { });
            }
        }
    }
    prefetchNextZoomLevel(center, z, worldGroupPos) {
        const maxZ = Math.min(this.engine.MAX_ZOOM, this._maxNativeZoom);
        if (z < 0 || z > maxZ)
            return;
        const maxTile = (1 << z) - 1;
        const [txF, tyF] = this.engine.worldToTileIndex(center.x, center.z, z, this.layer?.crs);
        if (!Number.isFinite(txF) || !Number.isFinite(tyF))
            return;
        const cx = Math.floor(txF);
        const cy = Math.floor(tyF);
        const xMin = Math.max(0, cx - 2);
        const xMax = Math.min(maxTile, cx + 2);
        const yMin = Math.max(0, cy - 2);
        const yMax = Math.min(maxTile, cy + 2);
        for (let y = yMin; y <= yMax; y++) {
            for (let x = xMin; x <= xMax; x++) {
                this.ensureTile(z, x, y);
            }
        }
    }
    /* ---------- LRU ---------- */
    gc(renderSet) {
        const overflow = this.tiles.size - MAX_CACHED_TILES;
        if (overflow <= 0)
            return;
        const candidates = [];
        for (const [k, inst] of this.tiles) {
            if (renderSet.has(k) || inst.loading)
                continue;
            candidates.push(inst);
        }
        if (!candidates.length)
            return;
        candidates.sort((a, b) => a.lastUsed - b.lastUsed);
        // Если переполнение большое — сбрасываем быстрее (жёсткий бюджет),
        // иначе ограничиваемся мягким, чтобы не спамить WebGL dispose.
        const hardOverflow = this.tiles.size - MAX_CACHED_TILES * 1.5;
        const budget = Math.min(hardOverflow > 0 ? GC_HARD_BUDGET : GC_SOFT_BUDGET, candidates.length);
        for (let i = 0; i < budget; i++) {
            this.disposeTile(candidates[i]);
        }
    }
    disposeTile(inst) {
        const k = this.key(inst.z, inst.virtX, inst.y);
        this.tiles.delete(k);
        for (const cb of this.onTileDisposedCallbacks) {
            try {
                cb(inst);
            }
            catch (e) {
                console.warn('Tile disposed callback error', e);
            }
        }
        for (let i = this._buildQueue.length - 1; i >= 0; i--) {
            if (this._buildQueue[i].inst === inst) {
                const { resolve } = this._buildQueue[i];
                this._buildQueue.splice(i, 1);
                resolve(null);
            }
        }
        if (inst.mesh) {
            this.engine.worldGroup.remove(inst.mesh);
            inst.mesh.geometry.dispose();
            inst.mesh.material.dispose();
            inst.mesh.clear();
        }
        if (inst.texUrl)
            this.releaseTexture(inst.texUrl);
        inst.overlayTex = null;
    }
    /* ---------- Воркер ---------- */
    initWorker() {
        const TILE_PIXELS = this.engine.TILE_PIXELS;
        const workerCode = `
            const TILE_PIXELS = ${TILE_PIXELS};
            self.onmessage = async function(e) {
                const { id, type, payload } = e.data;
                try {
                    if (type === 'computeFromImageData') {
                        const { imageData, tileSize, originX, originZ, segments, heightScale } = payload;
                        const heights = computeHeights(imageData.data, tileSize, originX, originZ, segments, heightScale);
                        self.postMessage({ id, result: { heights } }, [heights.buffer]);
                    } else if (type === 'computeFromUrl') {
                        const { url, tileSize, originX, originZ, segments, heightScale } = payload;
                        const result = await computeHeightsFromUrl(url, tileSize, originX, originZ, segments, heightScale);
                        self.postMessage({ id, result: { heights: result.heights, imageData: result.imageData } }, [result.heights.buffer]);
                    } else if (type === 'computeFromParent') {
                        const { imageData, tileSize, originX, originZ, segments, scale, dx, dy, heightScale } = payload;
                        const heights = computeHeightsFromParent(imageData, tileSize, originX, originZ, segments, scale, dx, dy, heightScale);
                        self.postMessage({ id, result: { heights } }, [heights.buffer]);
                    }
                } catch (err) {
                    self.postMessage({ id, error: err.message });
                }
            };

            async function computeHeightsFromUrl(url, tileSize, originX, originZ, segments, heightScale) {
                const resp = await fetch(url);
                if (!resp.ok) throw new Error('Fetch failed');
                const blob = await resp.blob();
                const imgBitmap = await createImageBitmap(blob);
                const canvas = new OffscreenCanvas(TILE_PIXELS, TILE_PIXELS);
                const ctx = canvas.getContext('2d');
                ctx.drawImage(imgBitmap, 0, 0);
                imgBitmap.close();
                const imageData = ctx.getImageData(0, 0, TILE_PIXELS, TILE_PIXELS);
                const heights = computeHeights(imageData.data, tileSize, originX, originZ, segments, heightScale);
                return { heights, imageData };
            }

            function computeHeightsFromParent(imageData, tileSize, originX, originZ, segments, scale, dx, dy, heightScale) {
                const data = imageData.data;
                return computeHeightsGeneric(segments, (u, v) => {
                    const uP = (dx + u) / scale;
                    const vP = (dy + v) / scale;
                    const sx = Math.round(uP * (TILE_PIXELS-1));
                    const sy = Math.round(vP * (TILE_PIXELS-1));
                    const idx = (sy * TILE_PIXELS + sx) * 4;
                    return ((data[idx]*256 + data[idx+1] + data[idx+2]/256) - 32768) * heightScale;
                });
            }

            function computeHeights(pixelData, tileSize, originX, originZ, segments, heightScale) {
                const data = pixelData;
                return computeHeightsGeneric(segments, (u, v) => {
                    const sx = Math.round(u * (TILE_PIXELS-1));
                    const sy = Math.round(v * (TILE_PIXELS-1));
                    const idx = (sy * TILE_PIXELS + sx) * 4;
                    return ((data[idx]*256 + data[idx+1] + data[idx+2]/256) - 32768) * heightScale;
                });
            }

            function computeHeightsGeneric(segments, sampleFn) {
                const count = (segments + 1) * (segments + 1);
                const heights = new Float32Array(count);
                for (let row = 0; row <= segments; row++) {
                    for (let col = 0; col <= segments; col++) {
                        const u = col / segments;
                        const v = row / segments;
                        heights[row * (segments+1) + col] = sampleFn(u, v);
                    }
                }
                return heights;
            }
        `;
        const blob = new Blob([workerCode], { type: 'application/javascript' });
        this.worker = new Worker(URL.createObjectURL(blob));
        this.worker.onmessage = (e) => {
            const { id, result, error } = e.data;
            if (this.workerPromises.has(id)) {
                const { resolve, reject } = this.workerPromises.get(id);
                this.workerPromises.delete(id);
                if (this.activeWorkerJobs > 0)
                    this.activeWorkerJobs--;
                this.processWorkerQueue();
                if (error)
                    reject(new Error(error));
                else
                    resolve(result);
            }
            else {
                console.warn('[TileManager] Unexpected worker message id', id);
                if (this.activeWorkerJobs > 0)
                    this.activeWorkerJobs--;
                this.processWorkerQueue();
            }
        };
        this.worker.onerror = (err) => {
            console.error('[TileManager] Elevation worker error:', err);
        };
    }
    processWorkerQueue() {
        while (this.activeWorkerJobs < this.engine.MAX_WORKER_REQUESTS && this.pendingWorkerJobs.length > 0) {
            const job = this.pendingWorkerJobs.shift();
            this.activeWorkerJobs++;
            this.worker.postMessage({ id: job.id, type: job.type, payload: job.payload });
        }
    }
    scheduleWorkerJob(type, payload) {
        const id = this.nextJobId++;
        const promise = new Promise((resolve, reject) => {
            this.workerPromises.set(id, { resolve, reject });
            this.pendingWorkerJobs.push({ id, type, payload });
            this.processWorkerQueue();
        });
        return promise;
    }
}
