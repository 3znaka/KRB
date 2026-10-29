import {
  THREE
} from '../js_TP/tpb.js';
import { getOriginZ, getVirtKey, DEFAULTS } from './Utils.js';

/** Максимальное количество кэшируемых тайлов. @private */
const MAX_CACHED_TILES = 350;

/** Количество уровней предков для фолбэка при приближении. @private */
const ANCESTOR_FALLBACK = 4;

/** Максимальная глубина поиска потомков при отдалении. @private */
const MAX_COVER_DEPTH = 2;

/**
 * Количество сегментов по стороне для деформированного тайла
 * в режиме БЕЗ рельефа. В режиме с рельефом — `engine.SEGMENTS`.
 * @private
 */
const DEFORM_SEGMENTS_FLAT = 8;

/** Значения по умолчанию для освещаемых тайлов. @private */
const TILE_DEFAULT_ROUGHNESS = 0.7;
const TILE_DEFAULT_METALNESS = 0.0;
const TILE_DEFAULT_EMISSIVE  = 0.5;

/**
 * Растровый тайловый слой.
 *
 * ## Зумы
 *
 * В слое разделены четыре независимых понятия:
 *
 *  1. **Зум камеры** — `KRB.View.minZoom`/`maxZoom`. К слою не относится.
 *  2. **Зум видимости слоя** — `minZoom` / `maxZoom` (Leaflet-style).
 *  3. **Зум доступных данных растровых тайлов** — `minNativeZoom` /
 *     `maxNativeZoom`. Выше `maxNativeZoom` — overzoom; ниже
 *     `minNativeZoom` — запросы не уходят.
 *  4. **Зум доступных DEM-данных** — `minElevationZoom` / `maxElevationZoom`.
 *     Вне этого диапазона высоты не запрашиваются, тайл остаётся плоским.
 *
 * `zoomOffset` — смещение запрашиваемого зума тайлов относительно зума
 * камеры. Не влияет ни на видимость, ни на доступность данных.
 *
 * ## Deprecated-алиасы
 *
 *  - `maxSourceZoom` / `minSourceZoom` → `maxNativeZoom` / `minNativeZoom`;
 *  - `maxReliefZ` / `minReliefZ` → `maxElevationZoom` / `minElevationZoom`.
 *
 * При использовании выводят предупреждение в консоль.
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

        // ── Зум видимости слоя ──────────────────────────────────────
        this.minZoom = options.minZoom ?? 0;
        this.maxZoom = options.maxZoom ?? Infinity;

        // ── Зум доступных растровых данных ──────────────────────────
        if (options.maxSourceZoom !== undefined && options.maxNativeZoom === undefined) {
            console.warn(
                'Tile: опция maxSourceZoom устарела, используйте maxNativeZoom. ' +
                'Значение maxSourceZoom будет использовано как maxNativeZoom.'
            );
        }
        if (options.minSourceZoom !== undefined && options.minNativeZoom === undefined) {
            console.warn(
                'Tile: опция minSourceZoom устарела, используйте minNativeZoom. ' +
                'Значение minSourceZoom будет использовано как minNativeZoom.'
            );
        }
        this.minNativeZoom = options.minNativeZoom
            ?? options.minSourceZoom
            ?? 0;
        this.maxNativeZoom = options.maxNativeZoom
            ?? options.maxSourceZoom
            ?? 22;

        // ── Зум доступных DEM-данных ────────────────────────────────
        // Раньше жили на KrbMap как MIN_RELIEF_Z / MAX_RELIEF_Z —
        // переехали сюда, т.к. это свойство источника высот, а не карты.
        if (options.maxReliefZ !== undefined && options.maxElevationZoom === undefined) {
            console.warn(
                'Tile: опция maxReliefZ устарела, используйте maxElevationZoom. ' +
                'Значение maxReliefZ будет использовано как maxElevationZoom.'
            );
        }
        if (options.minReliefZ !== undefined && options.minElevationZoom === undefined) {
            console.warn(
                'Tile: опция minReliefZ устарела, используйте minElevationZoom. ' +
                'Значение minReliefZ будет использовано как minElevationZoom.'
            );
        }
        this.minElevationZoom = options.minElevationZoom
            ?? options.minReliefZ
            ?? DEFAULTS.MIN_RELIEF_Z;
        this.maxElevationZoom = options.maxElevationZoom
            ?? options.maxReliefZ
            ?? DEFAULTS.MAX_RELIEF_Z;

        // ── CRS источника растровых тайлов ──────────────────────────
        if (options.crs && options.projection && options.crs !== options.projection) {
            console.warn(
                `Tile: заданы и crs='${options.crs}', и projection='${options.projection}'; ` +
                `использую crs.`
            );
        }
        /**
         * CRS сетки `{z}/{x}/{y}` растрового тайлового сервера.
         * Mercator-семейство: 'EPSG:3857' (по умолчанию), 'EPSG:3395' (Yandex).
         * @type {string}
         */
        this.crs = options.crs ?? options.projection ?? 'EPSG:3857';
    }
}

/**
 * Менеджер растровых тайлов.
 *
 * ## LOD и глубина
 *
 * На каждый кадр в {@link TileManager#update} формируется `renderSet`:
 * для каждой видимой клетки на `idealZ` — primary-тайл (готовый), либо
 * покрывающие его потомки (`collectCover`), либо готовый предок-фолбэк
 * (`findReadyAncestor`). Primary (`z >= idealZ`) пишет `depthWrite = true`,
 * fallback (`z < idealZ`) — `false` и рисуется раньше по `renderOrder`.
 * Атомарность — в одном проходе по `this.tiles` в конце `update`.
 *
 * ## Границы зумов
 *
 * Растровые тайлы запрашиваются только в диапазоне
 * `[Tile.minNativeZoom, Tile.maxNativeZoom]`. Выше — overzoom (тот же тайл
 * растягивается); ниже — запросы не уходят. DEM-тайлы — только в
 * `[Tile.minElevationZoom, Tile.maxElevationZoom]`.
 */
export class TileManager {
    constructor(engine) {
        this.engine = engine;
        this.tiles = new Map();
        this.textureCache = new Map();
        this._inFlightTextures = new Map();
        this.textureLoader = new THREE.TextureLoader();
        this.textureLoader.setCrossOrigin('anonymous');
        this.frame = 0;

        this.hasElevation = engine.hasElevation;

        this.tileLighting = engine.tileLighting === true;
        this.tileRoughness = Number.isFinite(engine.tileLightingRoughness)
            ? engine.tileLightingRoughness
            : TILE_DEFAULT_ROUGHNESS;
        this.tileMetalness = Number.isFinite(engine.tileLightingMetalness)
            ? engine.tileLightingMetalness
            : TILE_DEFAULT_METALNESS;
        this.tileEmissive = Number.isFinite(engine.tileLightingEmissive)
            ? engine.tileLightingEmissive
            : TILE_DEFAULT_EMISSIVE;

        /** @type {Object|null} */
        this.elevationProvider = null;

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
       Границы зумов
       ================================================================ */

    /**
     * Верхняя граница зумов растровых тайлов. Выше — overzoom.
     * @type {number}
     */
    get _maxNativeZoom() {
        return this.engine._tileLayer?.maxNativeZoom ?? this.engine.MAX_ZOOM;
    }

    /**
     * Нижняя граница зумов растровых тайлов.
     * @type {number}
     */
    get _minNativeZoom() {
        return this.engine._tileLayer?.minNativeZoom ?? 0;
    }

    /**
     * Верхняя граница зумов DEM-данных. Читается из слоя высот
     * (`engine._elevationLayer.maxElevationZoom`); fallback — на
     * legacy-поле `engine.MAX_RELIEF_Z` и затем на `DEFAULTS`.
     * @type {number}
     */
    get _maxElevationZoom() {
        const layer = this.engine._elevationLayer;
        if (layer && layer.maxElevationZoom !== undefined) return layer.maxElevationZoom;
        return this.engine.MAX_RELIEF_Z ?? DEFAULTS.MAX_RELIEF_Z;
    }

    /**
     * Нижняя граница зумов DEM-данных. Читается из слоя высот
     * (`engine._elevationLayer.minElevationZoom`); fallback — на
     * legacy-поле `engine.MIN_RELIEF_Z` и затем на `DEFAULTS`.
     * @type {number}
     */
    get _minElevationZoom() {
        const layer = this.engine._elevationLayer;
        if (layer && layer.minElevationZoom !== undefined) return layer.minElevationZoom;
        return this.engine.MIN_RELIEF_Z ?? DEFAULTS.MIN_RELIEF_Z;
    }

    /** Строковый ключ тайла. @private */
    key(z, virtX, y) {
        return getVirtKey(z, virtX, y);
    }

    /* ================================================================
       Материал тайла
       ================================================================ */

    /**
     * Создаёт материал тайла. `depthWrite` здесь всегда `false` —
     * глубину включаем динамически в {@link TileManager#update} только
     * для primary-тайлов.
     *
     * @param {THREE.Texture|null} texture
     * @param {{depthWrite?:boolean, depthTest?:boolean}} [opts]
     * @returns {THREE.Material}
     * @private
     */
    _createTileMaterial(texture, opts = {}) {
        const depthWrite = opts.depthWrite !== undefined ? opts.depthWrite : false;
        const depthTest  = opts.depthTest  !== undefined ? opts.depthTest  : true;

        const common = { map: texture, depthWrite, depthTest };

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
            if (texture) {
                mat.emissiveMap = texture;
            }
        }

        return mat;
    }

    /** Заменяет текстуру у меша тайла (map и emissiveMap). */
    setMeshTexture(mesh, texture) {
        if (!mesh || !mesh.material) return;
        mesh.material.map = texture;
        if (mesh.material.isMeshStandardMaterial && this.tileEmissive > 0) {
            mesh.material.emissiveMap = texture;
        }
        mesh.material.needsUpdate = true;
    }

    /* ================================================================
       Основной метод — вызывается из Core.maybeUpdateVisibleTiles
       ================================================================ */

    /**
     * Обновляет видимые тайлы и роли `depthWrite`.
     *
     * @param {THREE.Camera} camera
     * @param {THREE.Vector3} controlsTarget
     * @param {number} continuousZoom
     * @param {THREE.Vector3} worldGroupPos
     * @returns {number} Идеальный дискретный зум.
     */
    update(camera, controlsTarget, continuousZoom, worldGroupPos) {
        this.frame++;
        const idealZ = this.engine.tileZoom;

        const dist = camera.position.distanceTo(controlsTarget);
        const margin = this.engine.TILE_MARGIN;
        const cullUnit = this.engine.deformedTiles
            ? (this.engine.WORLD_EXTENT ?? this.engine.WORLD_SIZE)
            : this.engine.WORLD_SIZE;
        const tileSize = cullUnit / Math.pow(2, idealZ);
        const maxTile = (1 << idealZ) - 1;
        const vFov = (camera.fov * Math.PI) / 180;
        const aspect = camera.aspect;
        const hh = dist * Math.tan(vFov / 2) * aspect + margin * tileSize;
        const hv = dist * Math.tan(vFov / 2) + margin * tileSize;
        const minX = controlsTarget.x - hh, maxX = controlsTarget.x + hh;
        const minZ = controlsTarget.z - hv, maxZ = controlsTarget.z + hv;

        let xMin, xMax, yMin, yMax;

        if (this.engine.deformedTiles) {
            let minTx = Infinity, maxTx = -Infinity, minTy = Infinity, maxTy = -Infinity;

            const spanW = maxX - minX;
            const spanH = maxZ - minZ;

            const G = 16;
            for (let i = 0; i <= G; i++) {
                const wx = minX + spanW * (i / G);
                for (let j = 0; j <= G; j++) {
                    const wz = minZ + spanH * (j / G);
                    const [tx, ty] = this.engine.worldToTileIndex(wx, wz, idealZ);
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
                        const [tx, ty] = this.engine.worldToTileIndex(wx, wz, idealZ);
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
                        const [tx, ty] = this.engine.worldToTileIndex(wx, wz, idealZ);
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

        // Видимость + роль depthWrite — атомарно в одном проходе.
        for (const [k, inst] of this.tiles) {
            if (!inst.mesh) continue;
            const show = renderSet.has(k);
            if (inst.mesh.visible !== show) inst.mesh.visible = show;
            if (!show) continue;

            const shouldWriteDepth = inst.z >= idealZ;
            const mat = inst.mesh.material;
            if (mat.depthWrite !== shouldWriteDepth) {
                mat.depthWrite = shouldWriteDepth;
            }

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

    /**
     * Рекурсивно ищет потомков, полностью покрывающих клетку.
     * Не уходит выше `Tile.maxNativeZoom` — там данных нет.
     * @private
     */
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

    /**
     * Ищет готового предка-фолбэка. Не спускается ниже
     * `max(MIN_ZOOM, Tile.minNativeZoom)`.
     * @private
     */
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

    /**
     * Возвращает существующий тайл или создаёт и запускает загрузку нового.
     * @param {number} z @param {number} virtX @param {number} y
     * @returns {Object}
     */
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
       Внешний источник высот (GeoTIFF / Noise)
       ================================================================ */

    enableGeotiffElevation(provider) {
        if (!provider) return;
        if (this.elevationProvider === provider) return;

        const wasElevated = this.hasElevation;
        this.elevationProvider = provider;
        this.hasElevation = true;

        if (!wasElevated) {
            this._disposeFlatTiles();
        } else {
            this._refreshElevationsFromProvider();
        }
        this.frame = 0;
    }

    /** @private */
    _disposeFlatTiles() {
        const targetCount = (this.engine.SEGMENTS + 1) * (this.engine.SEGMENTS + 1);
        const toDispose = [];
        for (const inst of this.tiles.values()) {
            if (!inst.mesh || !inst.geometry) continue;
            if (inst.loading) continue;
            const count = inst.geometry.attributes.position.count;
            if (count !== targetCount) toDispose.push(inst);
        }
        for (const inst of toDispose) this.disposeTile(inst);
    }

    /** @private */
    _refreshElevationsFromProvider() {
        for (const inst of this.tiles.values()) {
            if (!inst.mesh || inst.loading || inst.heightsApplied) continue;
            if (!this.shouldRequestElevation(inst)) continue;
            inst.expectsElevation = true;
            this.requestElevation(inst);
        }
    }

    /** @private */
    async loadTile(inst) {
        const k = this.key(inst.z, inst.virtX, inst.y);
        try {
            const srcX = ((inst.virtX % (1 << inst.z)) + (1 << inst.z)) % (1 << inst.z);
            const srcKey = getVirtKey(inst.z, srcX, inst.y);
            const texUrl = this.engine.getTextureUrl(inst.z, srcX, inst.y);

            if (this.hasElevation &&
                inst.z >= this._minElevationZoom &&
                inst.z <= this._maxElevationZoom) {
                const elevUrl = this.engine.getElevationUrl(inst.z, srcX, inst.y);
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

            if (this.hasElevation && this.shouldRequestElevation(inst)) {
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
     * Запрашивать ли для тайла высоты. Ограничено диапазоном
     * `[Tile.minElevationZoom, Tile.maxElevationZoom]`.
     * @private
     */
    shouldRequestElevation(inst) {
        return inst.z >= this._minElevationZoom
            && inst.z <= this._maxElevationZoom;
    }

    /** @private */
    createTileMesh(inst, texture) {
        if (this.engine.deformedTiles) {
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
        mesh.position.set(
            originX + tileSize / 2,
            0,
            originZ + tileSize / 2
        );
        mesh.renderOrder = z;
        mesh.visible = false;
        return mesh;
    }

    /** @private */
    _createDeformedTileMesh(inst, texture) {
        const { z, virtX, y } = inst;
        const n = 1 << z;
        const mapProj = this.engine.projection;
        const tileCrs = this.engine.tileCRS;
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
        mesh.renderOrder = z;
        mesh.visible = false;
        mesh.userData.deformedTile = true;
        return mesh;
    }

    /**
     * Статический фоновый меш: `depthWrite/depthTest = false`,
     * `renderOrder = -2`.
     * @private
     */
    createStaticTileMesh(tileSize, originX, originZ, texture) {
        const geom = new THREE.PlaneGeometry(tileSize, tileSize, 1, 1);
        geom.rotateX(-Math.PI / 2);
        const mat = this._createTileMaterial(texture, {
            depthWrite: false,
            depthTest: false
        });
        const mesh = new THREE.Mesh(geom, mat);
        mesh.position.set(
            originX + tileSize / 2,
            -1.5,
            originZ + tileSize / 2
        );
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

    /** @private */
    async requestElevation(inst) {
        const k = this.key(inst.z, inst.virtX, inst.y);
        try {
            const srcX = ((inst.virtX % (1 << inst.z)) + (1 << inst.z)) % (1 << inst.z);
            const srcKey = getVirtKey(inst.z, srcX, inst.y);

            let heights = null;

            const provider = this.elevationProvider;
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

    /** @private */
    async getFallbackElevation(inst) {
        let fz = inst.z - 1;
        while (fz > this._maxElevationZoom) fz--;
        if (fz < this._minElevationZoom) throw new Error('No elevation fallback');

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
        if (z < this._minElevationZoom || z > this._maxElevationZoom) return null;

        const url = this.engine.getElevationUrl(z, srcX, y);
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
        const layerWithElev = this.engine.layers.find(l => l.elevation);
        return layerWithElev?.heightScale ?? DEFAULTS.HEIGHT_SCALE;
    }

    /**
     * Пре-фетч DEM-предков при отдалении (вызывается из Core).
     * @private
     */
    prefetchParentElevations(center, z, worldGroupPos) {
        if (!this.hasElevation ||
            z < this._minElevationZoom ||
            z > this._maxElevationZoom) return;
        if (this.elevationProvider) return;

        const cullUnit = this.engine.deformedTiles
            ? (this.engine.WORLD_EXTENT ?? this.engine.WORLD_SIZE)
            : this.engine.WORLD_SIZE;
        const tileSize = cullUnit / Math.pow(2, z);
        const margin = 2;
        const radius = tileSize * margin;
        const maxTile = (1 << z) - 1;

        let xMin, xMax, yMin, yMax;

        if (this.engine.deformedTiles) {
            const samples = [
                [center.x - radius, center.z - radius],
                [center.x + radius, center.z - radius],
                [center.x - radius, center.z + radius],
                [center.x + radius, center.z + radius],
                [center.x, center.z]
            ];
            let minTx = Infinity, maxTx = -Infinity, minTy = Infinity, maxTy = -Infinity;
            for (const [wx, wz] of samples) {
                const [tx, ty] = this.engine.worldToTileIndex(wx, wz, z);
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
            if (!this.engine.deformedTiles) {
                const oz = getOriginZ(y, tileSize, this.engine.MAX_MERCATOR) + worldGroupPos.z;
                if (oz + tileSize < center.z - radius || oz > center.z + radius) continue;
            }
            for (let x = xMin; x <= xMax; x++) {
                this.getParentElevData(z, x, y).catch(() => {});
            }
        }
    }

    /**
     * Пре-фетч тайлов следующего зума при приближении. Верхняя граница —
     * `min(engine.MAX_ZOOM, Tile.maxNativeZoom)`.
     * @private
     */
    prefetchNextZoomLevel(center, z, worldGroupPos) {
        const maxZ = Math.min(this.engine.MAX_ZOOM, this._maxNativeZoom);
        if (z < 0 || z > maxZ) return;
        const maxTile = (1 << z) - 1;

        const [txF, tyF] = this.engine.worldToTileIndex(center.x, center.z, z);
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

    /* ---- LRU сборщик мусора ---- */

    /**
     * Освобождает тайлы за пределами `renderSet` до `MAX_CACHED_TILES`.
     * Загружающиеся и входящие в `renderSet` не трогаются.
     * @private
     */
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