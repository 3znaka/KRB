import { THREE } from '../js_TP/tpb.js';
import { getOriginZ, getVirtKey, DEFAULTS } from './Utils.js';
import { Projections } from './Projections.js';

/** Максимальное количество кэшируемых тайлов на один слой. @private */
const MAX_CACHED_TILES = 350;

/** Количество уровней предков для фолбэка при приближении. @private */
const ANCESTOR_FALLBACK = 4;

/** Максимальная глубина поиска потомков при отдалении. @private */
const MAX_COVER_DEPTH = 2;

/** Сегментов по стороне деформированного тайла без рельефа. @private */
const DEFORM_SEGMENTS_FLAT = 8;

/** Освещение тайлов по умолчанию. @private */
const TILE_DEFAULT_ROUGHNESS = 0.7;
const TILE_DEFAULT_METALNESS = 0.0;
const TILE_DEFAULT_EMISSIVE  = 0.5;

/**
 * Растровый тайловый слой.
 *
 * Зумы:
 *  - видимость слоя — `minZoom` / `maxZoom`;
 *  - растровые данные — `minNativeZoom` / `maxNativeZoom` (overzoom выше);
 *  - DEM-данные — `minElevationNativeZoom` / `maxElevationNativeZoom`
 *    (overzoom выше `maxElevationNativeZoom`).
 *
 * CRS сетки `{z}/{x}/{y}` — `crs`. Линейный режим, если совпадает с CRS
 * карты и обе в Mercator-семействе, иначе deformed через lon/lat.
 */
export class Tile {
    constructor(options) {
        this.texture = options.texture;
        this.elevation = options.elevation;
        this.noise = options.noise;
        this.attributionTitle = options.attributionTitle || '';
        this.attributionUrl = options.attributionUrl || '';
        this.heightScale = options.heightScale;
        this.zoomOffset = options.zoomOffset ?? 0;

        // Видимость слоя
        this.visible = options.visible ?? true;
        this.opacity = options.opacity ?? 1;
        this.minZoom = options.minZoom ?? 0;
        this.maxZoom = options.maxZoom ?? Infinity;

        // Зум растровых данных
        if (options.maxSourceZoom !== undefined && options.maxNativeZoom === undefined) {
            console.warn('Tile: maxSourceZoom устарела, используйте maxNativeZoom.');
        }
        if (options.minSourceZoom !== undefined && options.minNativeZoom === undefined) {
            console.warn('Tile: minSourceZoom устарела, используйте minNativeZoom.');
        }
        this.minNativeZoom = options.minNativeZoom ?? options.minSourceZoom ?? 0;
        this.maxNativeZoom = options.maxNativeZoom ?? options.maxSourceZoom ?? 22;

        // Зум DEM-данных
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

        // Deprecated-алиасы без warning'ов.
        Object.defineProperty(this, 'minElevationZoom', {
            configurable: true,
            enumerable: false,
            get: () => this.minElevationNativeZoom,
            set: (v) => { this.minElevationNativeZoom = v; },
        });
        Object.defineProperty(this, 'maxElevationZoom', {
            configurable: true,
            enumerable: false,
            get: () => this.maxElevationNativeZoom,
            set: (v) => { this.maxElevationNativeZoom = v; },
        });

        // CRS
        if (options.crs && options.projection && options.crs !== options.projection) {
            console.warn(
                `Tile: заданы и crs='${options.crs}', и projection='${options.projection}'; использую crs.`
            );
        }
        this.crs = options.crs ?? options.projection ?? 'EPSG:3857';

        /**
         * База для `mesh.renderOrder` (назначает `KrbMap._rebuildLayerStack`).
         * @type {number}
         */
        this.baseRenderOrder = 0;
    }
}

/**
 * Менеджер растровых тайлов одного слоя.
 *
 * ## Источник рельефа
 *
 * Менеджер не хранит собственного «мнения» о наличии рельефа. Источник
 * истины — `KrbMap._elevationProvider` (единственный на карту). Менеджер
 * получает его в конструкторе через `engine.elevationProvider` и
 * обновляет через {@link TileManager#setElevationProvider}.
 *
 * `hasElevation` — геттер: `true`, если задан провайдер карты **или** у
 * самого `layer` есть `elevation` (URL DEM). Никакой ручной синхронизации
 * `this.hasElevation` между картой и менеджером больше нет.
 *
 * ## Порядок отрисовки и depth
 *
 *  - **плоские тайлы** — `depthTest: false`, `depthWrite: false`,
 *    порядок по `renderOrder = baseRenderOrder + z`;
 *  - **тайлы с elevation** — `depthTest: true`, `depthWrite: true`
 *    (реальная 3D-геометрия, без depth-буфера дальняя гора рисовалась
 *    бы поверх ближней).
 *
 * Решение per-layer: наличие elevation у одного слоя не включает depth
 * для плоских слоёв на той же карте.
 *
 * ## DEM-границы и overzoom
 *
 * Границы берутся из приоритета:
 *  1. `elevationProvider.minZoom` / `.maxZoom` (GeoTIFF/Noise — обычно
 *     `[0, Infinity]` — они сэмплируют на любом зуме);
 *  2. `layer.minElevationNativeZoom` / `.maxElevationNativeZoom` (URL DEM);
 *  3. `engine.MIN_RELIEF_Z` / `.MAX_RELIEF_Z` / `DEFAULTS.*`.
 *
 * Выше `maxElevationNativeZoom` — overzoom: `getFallbackElevation`
 * растягивает DEM предка на сетку текущего тайла.
 */
export class TileManager {
    /**
     * @param {Object} engine — KrbMap.
     * @param {Tile|null} [layer]
     */
    constructor(engine, layer = null) {
        this.engine = engine;
        this.layer = layer ?? engine._tileLayer ?? engine.layers?.[0] ?? null;

        this.tiles = new Map();
        this.textureCache = new Map();
        this._inFlightTextures = new Map();
        this.textureLoader = new THREE.TextureLoader();
        this.textureLoader.setCrossOrigin('anonymous');
        this.frame = 0;

        /**
         * Единственный источник DEM. Задаётся картой; менеджер читает
         * его через `_elevationProvider` (см. геттер `hasElevation`).
         * @private @type {Object|null}
         */
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

        if (this.hasElevation) {
            this.initWorker();
        }

        this.onTileHeightAppliedCallbacks = [];
        this.onTileDisposedCallbacks = [];
    }

    /* ================================================================
       Рельеф: источник, зум-границы, смена провайдера
       ================================================================ */

    /**
     * Есть ли у слоя 3D-рельеф: либо провайдер карты, либо `layer.elevation`.
     * @type {boolean}
     */
    get hasElevation() {
        return !!this._elevationProvider || !!this.layer?.elevation;
    }

    /**
     * Устанавливает источник DEM. Единственная точка входа для смены
     * состояния «есть рельеф / нет рельефа / рельеф из другого источника».
     *
     * При любом изменении тайлы пересоздаются (`_disposeAllTiles`):
     * старые высоты в геометрии уже невалидны.
     *
     * @param {Object|null} provider
     */
    setElevationProvider(provider) {
        if (this._elevationProvider === provider) return;

        const had = this.hasElevation;
        this._elevationProvider = provider;
        const has = this.hasElevation;

        if (!had && !has) return;

        if (has && !this.worker) this.initWorker();

        this._disposeAllTiles();
        this.srcKeyToElevUrl.clear();
        this.frame = 0;
    }

    /** @private */
    _disposeAllTiles() {
        const toDispose = Array.from(this.tiles.values());
        for (const inst of toDispose) this.disposeTile(inst);
    }

    get _maxNativeZoom() {
        return this.layer?.maxNativeZoom ?? this.engine.MAX_ZOOM;
    }

    get _minNativeZoom() {
        return this.layer?.minNativeZoom ?? 0;
    }

get _maxElevationNativeZoom() {
    const p = this._elevationProvider;
    if (p && p.elevationMaxZoom != null) return p.elevationMaxZoom;   // ← было p.maxZoom
    if (this.layer?.elevation) return this.layer.maxElevationNativeZoom;
    return this.engine.MAX_RELIEF_Z ?? DEFAULTS.MAX_RELIEF_Z;
}

get _minElevationNativeZoom() {
    const p = this._elevationProvider;
    if (p && p.elevationMinZoom != null) return p.elevationMinZoom;   // ← было p.minZoom
    if (this.layer?.elevation) return this.layer.minElevationNativeZoom;
    return this.engine.MIN_RELIEF_Z ?? DEFAULTS.MIN_RELIEF_Z;
}

    get _baseRenderOrder() {
        return this.layer?.baseRenderOrder ?? 0;
    }

    get _isVisible() {
        const layer = this.layer;
        if (!layer) return true;
        if (layer.visible === false) return false;
        const dz = this.engine.currentDiscreteZoom;
        if (dz < (layer.minZoom ?? 0)) return false;
        if (dz > (layer.maxZoom ?? Infinity)) return false;
        return true;
    }

    get _isDeformed() {
        if (typeof this.engine._isLayerLinear === 'function') {
            return !this.engine._isLayerLinear(this.layer);
        }
        return this.engine.deformedTiles;
    }

    get _layerCrs() {
        const code = this.layer?.crs ?? 'EPSG:3857';
        return typeof code === 'string' ? Projections.get(code) : code;
    }

    key(z, virtX, y) {
        return getVirtKey(z, virtX, y);
    }

    /* ================================================================
       Материал тайла
       ================================================================ */

    /**
     * Создаёт материал тайла. `depthTest`/`depthWrite` по умолчанию равны
     * `hasElevation` (у слоя с рельефом — `true`, у плоского — `false`).
     * Явные `opts.depthTest`/`opts.depthWrite` переопределяют.
     * @private
     */
    _createTileMaterial(texture, opts = {}) {
        const layerHasElevation = this.hasElevation;

        const depthWrite = opts.depthWrite !== undefined ? opts.depthWrite : layerHasElevation;
        const depthTest  = opts.depthTest  !== undefined ? opts.depthTest  : layerHasElevation;

        const rawOpacity = this.layer?.opacity;
        const opacity = Number.isFinite(rawOpacity) ? rawOpacity : 1;
        const transparent = opacity < 1;

        const common = { map: texture, depthWrite, depthTest, opacity, transparent };

        if (!this.tileLighting) {
            return new THREE.MeshBasicMaterial(common);
        }

        const mat = new THREE.MeshStandardMaterial({
            ...common,
            roughness: this.tileRoughness,
            metalness: this.tileMetalness
        });

        if (this.tileEmissive > 0) {
            mat.emissive = new THREE.Color(0xffffff);
            mat.emissiveIntensity = this.tileEmissive;
            if (texture) mat.emissiveMap = texture;
        }
        return mat;
    }

    /** @param {THREE.Mesh} mesh @param {THREE.Texture} texture */
    setMeshTexture(mesh, texture) {
        if (!mesh || !mesh.material) return;
        mesh.material.map = texture;
        if (mesh.material.isMeshStandardMaterial && this.tileEmissive > 0) {
            mesh.material.emissiveMap = texture;
        }
        mesh.material.needsUpdate = true;
    }

    /** @param {boolean} visible */
    setVisible(visible) {
        for (const inst of this.tiles.values()) {
            if (inst.mesh) inst.mesh.visible = !!visible;
        }
    }

    /**
     * Устанавливает прозрачность слоя (0..1). `depth*` не трогает —
     * они зависят только от наличия рельефа.
     * @param {number} opacity
     */
    setOpacity(opacity) {
        if (!this.layer) return;
        const v = Number.isFinite(opacity) ? Math.max(0, Math.min(1, opacity)) : 1;
        if (this.layer.opacity === v) return;
        this.layer.opacity = v;

        const transparent = v < 1;
        for (const inst of this.tiles.values()) {
            const mat = inst.mesh?.material;
            if (!mat) continue;
            mat.opacity = v;
            if (mat.transparent !== transparent) {
                mat.transparent = transparent;
                mat.needsUpdate = true;
            }
        }
    }

    /* ================================================================
       Основной метод — вызывается из Core.maybeUpdateVisibleTiles
       ================================================================ */

    /**
     * Обновляет видимые тайлы слоя.
     * @returns {number} идеальный дискретный зум.
     */
    update(camera, controlsTarget, continuousZoom, worldGroupPos) {
        if (!this._isVisible) {
            this.setVisible(false);
            return -1;
        }

        this.frame++;

        const idealZ = (typeof this.engine.getTileZoom === 'function')
            ? this.engine.getTileZoom(this.layer)
            : this.engine.tileZoom;

        const layerCrs = this.layer?.crs;
        const isDeformed = this._isDeformed;
        const cullUnit = isDeformed
            ? (this.engine.WORLD_EXTENT ?? this.engine.WORLD_SIZE)
            : this.engine.WORLD_SIZE;

        const dist = camera.position.distanceTo(controlsTarget);
        const margin = this.engine.TILE_MARGIN;
        const tileSize = cullUnit / Math.pow(2, idealZ);
        const maxTile = (1 << idealZ) - 1;
        const vFov = (camera.fov * Math.PI) / 180;
        const aspect = camera.aspect;
        const hh = dist * Math.tan(vFov / 2) * aspect + margin * tileSize;
        const hv = dist * Math.tan(vFov / 2) + margin * tileSize;
        const minX = controlsTarget.x - hh, maxX = controlsTarget.x + hh;
        const minZ = controlsTarget.z - hv, maxZ = controlsTarget.z + hv;

        let xMin, xMax, yMin, yMax;

        if (isDeformed) {
            let minTx = Infinity, maxTx = -Infinity, minTy = Infinity, maxTy = -Infinity;

            const spanW = maxX - minX;
            const spanH = maxZ - minZ;

            const G = 16;
            for (let i = 0; i <= G; i++) {
                const wx = minX + spanW * (i / G);
                for (let j = 0; j <= G; j++) {
                    const wz = minZ + spanH * (j / G);
                    const [tx, ty] = this.engine.worldToTileIndex(wx, wz, idealZ, layerCrs);
                    if (!Number.isFinite(tx) || !Number.isFinite(ty)) continue;
                    if (tx < minTx) minTx = tx;
                    if (tx > maxTx) maxTx = tx;
                    if (ty < minTy) minTy = ty;
                    if (ty > maxTy) maxTy = ty;
                }
            }

            const proj = this.engine.projection;
            if (proj && typeof proj.fromLonLatSafe === 'function') {
                const B = 64;
                for (let k = 0; k <= B; k++) {
                    const lat = -90 + 180 * (k / B);
                    for (let e = 0; e < 2; e++) {
                        const lon = e === 0 ? -180 : 180;
                        const p = proj.fromLonLatSafe([lon, lat]);
                        if (!p) continue;
                        const wx = p[0], wz = -p[1];
                        if (wx < minX || wx > maxX || wz < minZ || wz > maxZ) continue;
                        const [tx, ty] = this.engine.worldToTileIndex(wx, wz, idealZ, layerCrs);
                        if (!Number.isFinite(tx) || !Number.isFinite(ty)) continue;
                        if (tx < minTx) minTx = tx;
                        if (tx > maxTx) maxTx = tx;
                        if (ty < minTy) minTy = ty;
                        if (ty > maxTy) maxTy = ty;
                    }
                }
                for (let k = 0; k <= B; k++) {
                    const lon = -180 + 360 * (k / B);
                    for (let e = 0; e < 2; e++) {
                        const lat = e === 0 ? -90 : 90;
                        const p = proj.fromLonLatSafe([lon, lat]);
                        if (!p) continue;
                        const wx = p[0], wz = -p[1];
                        if (wx < minX || wx > maxX || wz < minZ || wz > maxZ) continue;
                        const [tx, ty] = this.engine.worldToTileIndex(wx, wz, idealZ, layerCrs);
                        if (!Number.isFinite(tx) || !Number.isFinite(ty)) continue;
                        if (tx < minTx) minTx = tx;
                        if (tx > maxTx) maxTx = tx;
                        if (ty < minTy) minTy = ty;
                        if (ty > maxTy) maxTy = ty;
                    }
                }
            }

            if (Number.isFinite(minTx)) {
                xMin = Math.max(0, Math.floor(minTx) - 1);
                xMax = Math.min(maxTile, Math.ceil(maxTx) + 1);
                yMin = Math.max(0, Math.floor(minTy) - 1);
                yMax = Math.min(maxTile, Math.ceil(maxTy) + 1);
            } else {
                const halfExtent = (this.engine.WORLD_EXTENT ?? this.engine.WORLD_SIZE) / 2;
                if (maxX > -halfExtent && minX < halfExtent &&
                    maxZ > -halfExtent && minZ < halfExtent) {
                    xMin = 0; xMax = maxTile;
                    yMin = 0; yMax = maxTile;
                } else {
                    xMin = 1; xMax = 0; yMin = 1; yMax = 0;
                }
            }
        } else {
            const off = worldGroupPos;
            xMin = Math.floor((minX - off.x + this.engine.MAX_MERCATOR) / tileSize);
            xMax = Math.floor((maxX - off.x + this.engine.MAX_MERCATOR) / tileSize);
            yMin = Math.max(0, Math.floor((minZ - off.z + this.engine.MAX_MERCATOR) / tileSize));
            yMax = Math.min(maxTile, Math.floor((maxZ - off.z + this.engine.MAX_MERCATOR) / tileSize));
        }

        const visibleKeys = new Set();
        for (let y = yMin; y <= yMax; y++) {
            for (let vx = xMin; vx <= xMax; vx++) {
                visibleKeys.add(getVirtKey(idealZ, vx, y));
            }
        }

        const renderSet = new Set();
        for (const k of visibleKeys) {
            const [, vx, y] = k.split(',').map(Number);
            const inst = this.ensureTile(idealZ, vx, y);

            if (inst.ready && inst.mesh) {
                renderSet.add(k);
                continue;
            }
            const fullyCovered = this.collectCover(idealZ, vx, y, renderSet);
            if (!fullyCovered) {
                const anc = this.findReadyAncestor(idealZ, vx, y);
                if (anc) renderSet.add(this.key(anc.z, anc.virtX, anc.y));
            }
        }

        for (const [k, inst] of this.tiles) {
            if (!inst.mesh) continue;
            const show = renderSet.has(k);
            if (inst.mesh.visible !== show) inst.mesh.visible = show;
            if (!show) continue;
            inst.lastUsed = this.frame;
        }

        this.gc(renderSet);

        const viewZ = this.engine.currentDiscreteZoom;
        if (
            continuousZoom > viewZ + 0.3 &&
            idealZ < this.engine.MAX_ZOOM &&
            idealZ < this._maxNativeZoom &&
            this._lastPrefetchZoom < idealZ
        ) {
            this._lastPrefetchZoom = idealZ;
            this.prefetchNextZoomLevel(controlsTarget, idealZ + 1, worldGroupPos);
        }

        return idealZ;
    }

    /** @private */
    collectCover(z, virtX, y, renderSet, depth = 0) {
        if (z > this._maxNativeZoom) return false;

        const k = this.key(z, virtX, y);
        const inst = this.tiles.get(k);
        if (inst && inst.ready && inst.mesh) {
            renderSet.add(k);
            return true;
        }
        if (depth >= MAX_COVER_DEPTH) return false;
        let full = true;
        for (let dx = 0; dx < 2; dx++) {
            for (let dy = 0; dy < 2; dy++) {
                const covered = this.collectCover(
                    z + 1, virtX * 2 + dx, y * 2 + dy, renderSet, depth + 1
                );
                full = covered && full;
            }
        }
        return full;
    }

    /** @private */
    findReadyAncestor(z, virtX, y) {
        const minZ = Math.max(this.engine.MIN_ZOOM, this._minNativeZoom);
        for (let dz = 1; dz <= ANCESTOR_FALLBACK && z - dz >= minZ; dz++) {
            const az = z - dz;
            const ax = virtX >> dz;
            const ay = y >> dz;
            const inst = this.ensureTile(az, ax, ay);
            if (inst.unrenderable) return null;
            if (inst.ready && inst.mesh) return inst;
        }
        return null;
    }

    /** @private */
    ensureTile(z, virtX, y) {
        const k = this.key(z, virtX, y);
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
            heightsApplied: false, elevationAppliedLevel: 0, expectsElevation: false
        };
        this.tiles.set(k, inst);
        this.loadTile(inst);
        return inst;
    }

    /* ================================================================
       Загрузка тайла
       ================================================================ */

    /** @private */
    async loadTile(inst) {
        const k = this.key(inst.z, inst.virtX, inst.y);
        try {
            const srcX = ((inst.virtX % (1 << inst.z)) + (1 << inst.z)) % (1 << inst.z);
            const srcKey = getVirtKey(inst.z, srcX, inst.y);
            const texUrl = this.engine.getTextureUrl(this.layer, inst.z, srcX, inst.y);

            if (this.hasElevation &&
                inst.z >= this._minElevationNativeZoom &&
                inst.z <= this._maxElevationNativeZoom) {
                const elevUrl = this.engine.getElevationUrl(this.layer, inst.z, srcX, inst.y);
                if (elevUrl) this.srcKeyToElevUrl.set(srcKey, elevUrl);
            }

            const texture = await this.loadTextureAsync(texUrl);
            if (this.tiles.get(k) !== inst) {
                this.releaseTexture(texUrl);
                return;
            }

            const mesh = this.createTileMesh(inst, texture);
            if (!mesh) {
                this.releaseTexture(texUrl);
                inst.loading = false;
                inst.failed = true;
                inst.unrenderable = true;
                inst.ready = true;
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
            } else {
                inst.ready = true;
            }
        } catch (err) {
            if (this.tiles.get(k) !== inst) return;
            console.warn(`Tile load error ${inst.z}/${inst.virtX}/${inst.y}:`, err.message);
            inst.loading = false;
            inst.failed = true;
            inst.ready = true;
        }
    }

    /**
     * Применять ли к тайлу рельеф вообще: `true` для всех тайлов не мельче
     * `minElevationNativeZoom`. Выше `maxElevationNativeZoom` рельеф придёт
     * через `getFallbackElevation` (overzoom).
     * @private
     */
    shouldApplyElevation(inst) {
        return inst.z >= this._minElevationNativeZoom;
    }

    /** @private */
    createTileMesh(inst, texture) {
        if (this._isDeformed) {
            return this._createDeformedTileMesh(inst, texture);
        }

        const { z, virtX, y } = inst;
        const tileSize = this.engine.WORLD_SIZE / Math.pow(2, z);
        const seg = this.hasElevation ? this.engine.SEGMENTS : 1;
        const originX = virtX * tileSize - this.engine.MAX_MERCATOR;
        const originZ = getOriginZ(y, tileSize, this.engine.MAX_MERCATOR);

        let geometry;
        if (!this.hasElevation && this.flatTileGeometry) {
            geometry = this.flatTileGeometry.clone();
            geometry.rotateX(-Math.PI / 2);
        } else {
            geometry = new THREE.PlaneGeometry(tileSize, tileSize, seg, seg);
            geometry.rotateX(-Math.PI / 2);
        }

        const mat = this._createTileMaterial(texture);

        const mesh = new THREE.Mesh(geometry, mat);
        mesh.position.set(originX + tileSize / 2, 0, originZ + tileSize / 2);
        mesh.renderOrder = this._baseRenderOrder + z;
        mesh.visible = false;
        return mesh;
    }

    /** @private */
    _createDeformedTileMesh(inst, texture) {
        const { z, virtX, y } = inst;
        const n = 1 << z;
        const mapProj = this.engine.projection;
        const tileCrs = this._layerCrs;
        const MAX = this.engine.MAX_MERCATOR;

        const seg = this.hasElevation ? this.engine.SEGMENTS : DEFORM_SEGMENTS_FLAT;
        const grid = seg + 1;
        const count = grid * grid;

        const geom = new THREE.PlaneGeometry(1, 1, seg, seg);
        geom.rotateX(-Math.PI / 2);

        const arr = geom.attributes.position.array;

        let sumX = 0, sumZ = 0;
        let hasInvalid = false;

        for (let j = 0; j < grid; j++) {
            const v = j / seg;
            const tileY = y + v;
            const tileWorldY = MAX - (tileY / n) * 2 * MAX;
            for (let i = 0; i < grid; i++) {
                const u = i / seg;
                const tileX = virtX + u;
                const tileWorldX = (tileX / n) * 2 * MAX - MAX;

                const lonLat = tileCrs.toLonLat([tileWorldX, tileWorldY]);
                const k = (j * grid + i) * 3;
                if (!lonLat || !Number.isFinite(lonLat[0]) || !Number.isFinite(lonLat[1])) {
                    hasInvalid = true;
                    arr[k] = 0; arr[k + 1] = 0; arr[k + 2] = 0;
                    continue;
                }
                const proj2 = typeof mapProj.fromLonLatSafe === 'function'
                    ? mapProj.fromLonLatSafe(lonLat)
                    : mapProj.fromLonLat(lonLat);
                if (!proj2) {
                    hasInvalid = true;
                    arr[k] = 0; arr[k + 1] = 0; arr[k + 2] = 0;
                    continue;
                }
                const wx = proj2[0];
                const wz = -proj2[1];
                arr[k] = wx;
                arr[k + 1] = 0;
                arr[k + 2] = wz;
                sumX += wx;
                sumZ += wz;
            }
        }

        if (hasInvalid) return null;

        const iNW = 0;
        const iNE = seg;
        const iSE = grid * seg + seg;
        const iSW = grid * seg;
        const nwX = arr[iNW * 3], nwZ = arr[iNW * 3 + 2];
        const neX = arr[iNE * 3], neZ = arr[iNE * 3 + 2];
        const seX = arr[iSE * 3], seZ = arr[iSE * 3 + 2];
        const swX = arr[iSW * 3], swZ = arr[iSW * 3 + 2];
        const area = 0.5 * (
            nwX * neZ - neX * nwZ +
            neX * seZ - seX * neZ +
            seX * swZ - swX * seZ +
            swX * nwZ - nwX * swZ
        );
        if (!(area > 0)) return null;

        const cx = sumX / count;
        const cz = sumZ / count;
        for (let k = 0; k < count; k++) {
            arr[k * 3]     -= cx;
            arr[k * 3 + 2] -= cz;
        }

        geom.attributes.position.needsUpdate = true;
        geom.computeVertexNormals();
        geom.computeBoundingSphere();

        const mat = this._createTileMaterial(texture);

        const mesh = new THREE.Mesh(geom, mat);
        mesh.position.set(cx, 0, cz);
        mesh.renderOrder = this._baseRenderOrder + z;
        mesh.visible = false;
        mesh.userData.deformedTile = true;
        return mesh;
    }

    /** @private */
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

    /* ---- текстуры ---- */

    /** @param {string} url @returns {Promise<THREE.Texture|null>} */
    async loadTextureAsync(url) {
        if (!url) return null;

        if (this.textureCache.has(url)) {
            const e = this.textureCache.get(url);
            e.refs++;
            return e.texture;
        }

        if (this._inFlightTextures.has(url)) {
            const tex = await this._inFlightTextures.get(url);
            if (tex) {
                const e = this.textureCache.get(url);
                if (e) e.refs++;
                else this.textureCache.set(url, { texture: tex, refs: 2 });
            }
            return tex;
        }

        const promise = new Promise((resolve) => {
            this.textureLoader.load(url, tex => {
                tex.colorSpace = THREE.SRGBColorSpace;
                resolve(tex);
            }, undefined, () => resolve(null));
        });

        this._inFlightTextures.set(url, promise);
        const texture = await promise;
        this._inFlightTextures.delete(url);

        if (!texture) return null;
        this.textureCache.set(url, { texture, refs: 1 });
        return texture;
    }

    /** @param {string} url @private */
    releaseTexture(url) {
        if (!url) return;
        const e = this.textureCache.get(url);
        if (!e) return;
        e.refs--;
        if (e.refs <= 0) {
            e.texture.dispose();
            this.textureCache.delete(url);
        }
    }

    /* ---- высоты ---- */

    /**
     * Запрашивает высоты для тайла и применяет их к геометрии.
     *
     * Порядок источников:
     *  - прямой DEM в native-диапазоне: `_elevationProvider` → URL;
     *  - overzoom через `getFallbackElevation` (DEM предка).
     * @private
     */
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
                    heights = provider.getTileHeights(
                        inst.z, inst.virtX, inst.y, this.engine.SEGMENTS
                    );
                }

                if (!heights) {
                    const elevUrl = this.srcKeyToElevUrl.get(srcKey);
                    if (elevUrl) {
                        const tileSize = this.engine.WORLD_SIZE / Math.pow(2, inst.z);
                        const originX = inst.virtX * tileSize - this.engine.MAX_MERCATOR;
                        const originZ = getOriginZ(inst.y, tileSize, this.engine.MAX_MERCATOR);
                        heights = await this.getDirectElevData(srcKey, elevUrl, tileSize, originX, originZ);
                    }
                }
            }

            if (!heights) {
                heights = await this.getFallbackElevation(inst);
            }

            if (this.tiles.get(k) !== inst || !inst.mesh) return;
            this.applyHeightsToGeometry(inst, heights);
            inst.ready = true;
        } catch (err) {
            if (this.tiles.get(k) !== inst) return;
            console.warn(`Elevation error ${inst.z}/${inst.virtX}/${inst.y}:`, err.message);
            inst.ready = true;
        }
    }

    /** @private */
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
                if (result.imageData) this.parentElevCache.set(srcKey, result.imageData);
                return result.heights;
            } finally {
                this.activeElevationFetches--;
                this._processElevationQueue();
            }
        };

        const promise = new Promise((resolve, reject) => {
            if (this.activeElevationFetches < this.MAX_ELEVATION_FETCHES) {
                executeJob().then(resolve).catch(reject);
            } else {
                this.elevationQueue.push({ execute: executeJob, resolve, reject });
            }
        });

        this.elevDirectPromises.set(srcKey, promise);
        promise.catch(() => {}).finally(() => {
            this.elevDirectPromises.delete(srcKey);
        });
        return promise;
    }

    /** @private */
    _processElevationQueue() {
        while (this.activeElevationFetches < this.MAX_ELEVATION_FETCHES && this.elevationQueue.length > 0) {
            const { execute, resolve, reject } = this.elevationQueue.shift();
            execute().then(resolve).catch(reject);
        }
    }

    /**
     * Overzoom: DEM предка растягивается на сетку текущего тайла.
     * @private
     */
    async getFallbackElevation(inst) {
        let fz = inst.z - 1;
        while (fz > this._maxElevationNativeZoom) fz--;
        if (fz < this._minElevationNativeZoom) throw new Error('No elevation fallback');

        const srcX = ((inst.virtX % (1 << inst.z)) + (1 << inst.z)) % (1 << inst.z);
        const scale = 1 << (inst.z - fz);
        const pSrcX = Math.floor(srcX / scale);
        const pY = Math.floor(inst.y / scale);

        const parentData = await this.getParentElevData(fz, pSrcX, pY);
        if (!parentData) throw new Error('No parent data');

        const tileSize = this.engine.WORLD_SIZE / Math.pow(2, inst.z);
        const originX = inst.virtX * tileSize - this.engine.MAX_MERCATOR;
        const originZ = getOriginZ(inst.y, tileSize, this.engine.MAX_MERCATOR);
        const dx = srcX % scale, dy = inst.y % scale;

        const imageDataCopy = new ImageData(
            new Uint8ClampedArray(parentData.data),
            parentData.width,
            parentData.height
        );
        const result = await this.scheduleWorkerJob('computeFromParent', {
            imageData: imageDataCopy,
            tileSize, originX, originZ,
            segments: this.engine.SEGMENTS,
            scale, dx, dy,
            heightScale: this.getElevationHeightScale()
        });
        return result.heights;
    }

    /** @private */
    async getParentElevData(z, srcX, y) {
        if (z < this._minElevationNativeZoom || z > this._maxElevationNativeZoom) return null;

        const url = this.engine.getElevationUrl(this.layer, z, srcX, y);
        if (!url) return null;

        const key = `${z},${srcX},${y}`;
        if (this.parentElevCache.has(key)) return this.parentElevCache.get(key);
        if (this.parentElevPromises.has(key)) return this.parentElevPromises.get(key);

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

    /** @private */
    applyHeightsToGeometry(inst, heights) {
        const pos = inst.geometry.attributes.position.array;
        for (let i = 0; i < heights.length; i++) pos[i * 3 + 1] = heights[i];
        inst.geometry.attributes.position.needsUpdate = true;
        inst.geometry.computeVertexNormals();

        this.syncTileWithNeighbors(inst);

        inst.heightsApplied = true;
        inst.ready = true;

        for (const cb of this.onTileHeightAppliedCallbacks) {
            try { cb(inst); } catch (e) { console.warn('Tile overlay callback error', e); }
        }
    }

    /** @private */
    syncTileWithNeighbors(inst) {
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

    /** @private */
    syncEdgesBetween(instA, instB, dx, dy) {
        const posA = instA.geometry.attributes.position.array;
        const posB = instB.geometry.attributes.position.array;
        const seg = this.engine.SEGMENTS;
        const pairs = [];
        if (dx === 1 && dy === 0) {
            for (let r = 0; r <= seg; r++) pairs.push([r * (seg + 1) + seg, r * (seg + 1)]);
        } else if (dx === -1 && dy === 0) {
            for (let r = 0; r <= seg; r++) pairs.push([r * (seg + 1), r * (seg + 1) + seg]);
        } else if (dx === 0 && dy === -1) {
            for (let c = 0; c <= seg; c++) pairs.push([c, seg * (seg + 1) + c]);
        } else if (dx === 0 && dy === 1) {
            for (let c = 0; c <= seg; c++) pairs.push([seg * (seg + 1) + c, c]);
        }
        for (const [iA, iB] of pairs) {
            const avg = (posA[iA * 3 + 1] + posB[iB * 3 + 1]) / 2;
            posA[iA * 3 + 1] = avg;
            posB[iB * 3 + 1] = avg;
        }
        instA.geometry.attributes.position.needsUpdate = true;
        instB.geometry.attributes.position.needsUpdate = true;
        instA.geometry.computeVertexNormals();
        instB.geometry.computeVertexNormals();
    }

    /** @private */
    getElevationHeightScale() {
        return this.layer?.heightScale ?? DEFAULTS.HEIGHT_SCALE;
    }

    /** @private */
    prefetchParentElevations(center, z, worldGroupPos) {
        if (!this.hasElevation ||
            z < this._minElevationNativeZoom ||
            z > this._maxElevationNativeZoom) return;
        if (this._elevationProvider) return;

        const isDeformed = this._isDeformed;
        const layerCrs = this.layer?.crs;
        const cullUnit = isDeformed
            ? (this.engine.WORLD_EXTENT ?? this.engine.WORLD_SIZE)
            : this.engine.WORLD_SIZE;
        const tileSize = cullUnit / Math.pow(2, z);
        const margin = 2;
        const radius = tileSize * margin;
        const maxTile = (1 << z) - 1;

        let xMin, xMax, yMin, yMax;

        if (isDeformed) {
            const samples = [
                [center.x - radius, center.z - radius],
                [center.x + radius, center.z - radius],
                [center.x - radius, center.z + radius],
                [center.x + radius, center.z + radius],
                [center.x, center.z]
            ];
            let minTx = Infinity, maxTx = -Infinity, minTy = Infinity, maxTy = -Infinity;
            for (const [wx, wz] of samples) {
                const [tx, ty] = this.engine.worldToTileIndex(wx, wz, z, layerCrs);
                if (!Number.isFinite(tx) || !Number.isFinite(ty)) continue;
                if (tx < minTx) minTx = tx;
                if (tx > maxTx) maxTx = tx;
                if (ty < minTy) minTy = ty;
                if (ty > maxTy) maxTy = ty;
            }
            if (!Number.isFinite(minTx)) return;
            xMin = Math.max(0, Math.floor(minTx));
            xMax = Math.min(maxTile, Math.ceil(maxTx));
            yMin = Math.max(0, Math.floor(minTy));
            yMax = Math.min(maxTile, Math.ceil(maxTy));
        } else {
            xMin = Math.floor((center.x - radius - worldGroupPos.x + this.engine.MAX_MERCATOR) / tileSize);
            xMax = Math.floor((center.x + radius - worldGroupPos.x + this.engine.MAX_MERCATOR) / tileSize);
            xMin = Math.max(0, xMin);
            xMax = Math.min(maxTile, xMax);
            yMin = 0;
            yMax = maxTile;
        }

        if (xMin > xMax || yMin > yMax) return;

        for (let y = yMin; y <= yMax; y++) {
            if (!isDeformed) {
                const oz = getOriginZ(y, tileSize, this.engine.MAX_MERCATOR) + worldGroupPos.z;
                if (oz + tileSize < center.z - radius || oz > center.z + radius) continue;
            }
            for (let x = xMin; x <= xMax; x++) {
                this.getParentElevData(z, x, y).catch(() => {});
            }
        }
    }

    /** @private */
    prefetchNextZoomLevel(center, z, worldGroupPos) {
        const maxZ = Math.min(this.engine.MAX_ZOOM, this._maxNativeZoom);
        if (z < 0 || z > maxZ) return;
        const maxTile = (1 << z) - 1;

        const [txF, tyF] = this.engine.worldToTileIndex(center.x, center.z, z, this.layer?.crs);
        if (!Number.isFinite(txF) || !Number.isFinite(tyF)) return;

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

    /* ---- LRU ---- */

    /** @private */
    gc(renderSet) {
        if (this.tiles.size <= MAX_CACHED_TILES) return;
        const candidates = [];
        for (const [k, inst] of this.tiles) {
            if (renderSet.has(k) || inst.loading) continue;
            candidates.push(inst);
        }
        candidates.sort((a, b) => a.lastUsed - b.lastUsed);
        let budget = this.tiles.size - MAX_CACHED_TILES;
        for (const inst of candidates) {
            if (budget-- <= 0) break;
            this.disposeTile(inst);
        }
    }

    /** @private */
    disposeTile(inst) {
        const k = this.key(inst.z, inst.virtX, inst.y);
        this.tiles.delete(k);

        for (const cb of this.onTileDisposedCallbacks) {
            try { cb(inst); } catch (e) { console.warn('Tile disposed callback error', e); }
        }

        if (inst.mesh) {
            this.engine.worldGroup.remove(inst.mesh);
            inst.mesh.geometry.dispose();
            inst.mesh.material.dispose();
            inst.mesh.clear();
        }
        if (inst.texUrl) this.releaseTexture(inst.texUrl);
    }

    /* ================================================================
       Воркер
       ================================================================ */

    /** @private */
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
                if (this.activeWorkerJobs > 0) this.activeWorkerJobs--;
                this.processWorkerQueue();
                if (error) reject(new Error(error));
                else resolve(result);
            } else {
                console.warn('[TileManager] Unexpected worker message id', id);
                if (this.activeWorkerJobs > 0) this.activeWorkerJobs--;
                this.processWorkerQueue();
            }
        };
        this.worker.onerror = (err) => {
            console.error('[TileManager] Elevation worker error:', err);
        };
    }

    /** @private */
    processWorkerQueue() {
        while (this.activeWorkerJobs < this.engine.MAX_WORKER_REQUESTS && this.pendingWorkerJobs.length > 0) {
            const job = this.pendingWorkerJobs.shift();
            this.activeWorkerJobs++;
            this.worker.postMessage({ id: job.id, type: job.type, payload: job.payload });
        }
    }

    /** @private */
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