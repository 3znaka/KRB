import {
  THREE
} from '../js_TP/tpb.js';
import { getOriginZ, getVirtKey, DEFAULTS } from './Utils.js';

/**
 * Шаг по вертикали между уровнями тайлов.
 * @type {number}
 * @private
 */
const LEVEL_Y_STEP = 1;

/**
 * Максимальное количество кэшируемых тайлов.
 * @type {number}
 * @private
 */
const MAX_CACHED_TILES = 350;

/**
 * Количество уровней предков для фолбэка при приближении.
 * @type {number}
 * @private
 */
const ANCESTOR_FALLBACK = 4;

/**
 * Максимальная глубина поиска потомков при отдалении.
 * @type {number}
 * @private
 */
const MAX_COVER_DEPTH = 2;

/**
 * Количество сегментов по стороне для деформированного тайла
 * в режиме БЕЗ рельефа. В режиме с рельефом используется
 * `engine.SEGMENTS` — чтобы сетка совпала с сеткой высот,
 * которую возвращает воркер.
 * @type {number}
 * @private
 */
const DEFORM_SEGMENTS_FLAT = 8;

/**
 * Значения по умолчанию для освещаемых тайлов.
 *
 * `roughness = 0.7` — матово, но с лёгким блеском, чтобы плоские
 * участки не выглядели «пластилиновыми».
 *
 * `emissive = 0.5` — половина яркости текстуры идёт «как есть»
 * (эмуляция запечённой освещённости), половина — модулируется
 * динамическим светом. Без этого тайл под `MeshStandardMaterial`
 * темнее, чем под `MeshBasicMaterial`, примерно вдвое.
 *
 * @private
 */
const TILE_DEFAULT_ROUGHNESS = 0.7;
const TILE_DEFAULT_METALNESS = 0.0;
const TILE_DEFAULT_EMISSIVE  = 0.5;

/**
 * Тайл карты с текстурой, данными высоты и атрибуцией.
 *
 * @example
 * const tile = new Tile({
 *     texture: 'https://example.com/tms/{z}/{x}/{y}.png',
 *     elevation: 'https://example.com/elevation/{z}/{x}/{y}.png',
 *     attributionTitle: 'Example',
 *     attributionUrl: 'https://example.com',
 *     heightScale: 1.5
 * });
 */
export class Tile {
    /**
     * @param {Object} options
     * @param {THREE.Texture} options.texture - Текстура тайла.
     * @param {*} options.elevation - Данные о высоте тайла.
     * @param {string} [options.attributionTitle]
     * @param {string} [options.attributionUrl]
     * @param {number} [options.heightScale] - По умолчанию DEFAULTS.HEIGHT_SCALE.
     */
    constructor(options) {
        this.texture = options.texture;
        this.elevation = options.elevation;
        this.attributionTitle = options.attributionTitle || '';
        this.attributionUrl = options.attributionUrl || '';
        this.heightScale = options.heightScale ?? DEFAULTS.HEIGHT_SCALE;
    }
}

/**
 * Менеджер тайлов: загрузка текстур и высот, управление кэшем и видимостью.
 *
 * Поддерживает два режима геометрии:
 *  - Прямоугольный (Mercator): `PlaneGeometry(tileSize, tileSize, seg, seg)`.
 *  - Деформированный: четырёхугольник, углы (и вся сетка) которого
 *    вычисляются через lon/lat XYZ-тайла, спроецированные в проекцию
 *    карты. Режим включается флагом `engine.deformedTiles` (в Core —
 *    авто, если `!projection.isMercator`).
 *
 * Поддерживает два источника высот:
 *  - **URL-источник DEM-тайлов** (`engine.getElevationUrl` → worker);
 *  - **внешний провайдер** (`elevationProvider`, например GeoTiffLayer
 *    в режиме `asElevation`). Подключается методом
 *    {@link TileManager#enableGeotiffElevation}.
 *
 * **Освещение.** При `engine.tileLighting === true` тайлы используют
 * `MeshStandardMaterial`, при `false` — быстрый `MeshBasicMaterial`.
 * Запечённая тайловая текстура обычно «уже освещена» сервером, поэтому
 * чисто физический PBR даёт заметно более тёмную картинку. Чтобы
 * компенсировать это, при `tileLighting === true` текстура дублируется
 * в `emissiveMap` с интенсивностью `engine.tileLightingEmissive`
 * (по умолчанию `0.5`): половина яркости идёт «как есть», половина
 * модулируется сценным светом. Это касается и фоновых (static BG)
 * тайлов — они используют тот же материал.
 *
 * @example
 * const engine = {
 *     currentDiscreteZoom: 3,
 *     TILE_MARGIN: 0.1,
 *     WORLD_SIZE: 2 * Math.PI * 6371000,
 *     MAX_MERCATOR: Math.PI * 6371000,
 *     SEGMENTS: 32,
 *     MIN_ZOOM: 0, MAX_ZOOM: 18,
 *     MIN_RELIEF_Z: 5, MAX_RELIEF_Z: 15,
 *     TILE_PIXELS: 256,
 *     hasElevation: true,
 *     deformedTiles: false,
 *     tileLighting: true,
 *     tileLightingRoughness: 0.7,
 *     tileLightingMetalness: 0.0,
 *     tileLightingEmissive: 0.5,
 *     globalElevCache: new Map(),
 *     worldGroup: new THREE.Group(),
 *     projection: Projections.get('EPSG:3857'),
 *     getTextureUrl: (z, x, y) => `https://example.com/tiles/${z}/${x}/${y}.png`,
 *     getElevationUrl: (z, x, y) => `https://example.com/elevation/${z}/${x}/${y}.png`,
 *     MAX_WORKER_REQUESTS: 4,
 *     layers: [{ elevation: true, heightScale: 1.2 }]
 * };
 * const tileManager = new TileManager(engine);
 */
export class TileManager {
    /**
     * @param {Object} engine - Объект движка карты.
     * @param {boolean} engine.hasElevation
     * @param {boolean} engine.deformedTiles
     * @param {boolean} [engine.tileLighting=false] - Использовать ли
     *     освещаемый материал (`MeshStandardMaterial`) для тайлов,
     *     включая фоновые BG-тайлы.
     * @param {number} [engine.tileLightingRoughness=0.7]
     * @param {number} [engine.tileLightingMetalness=0.0]
     * @param {number} [engine.tileLightingEmissive=0.5] - Доля «запечённой»
     *     яркости текстуры (0..1). Компенсирует потемнение под PBR.
     * @param {Map} [engine.globalElevCache]
     * @param {THREE.Group} engine.worldGroup
     * @param {number} engine.MAX_MERCATOR
     * @param {number} engine.WORLD_SIZE
     * @param {number} engine.SEGMENTS
     * @param {number} engine.MIN_ZOOM
     * @param {number} engine.MAX_ZOOM
     * @param {number} engine.MIN_RELIEF_Z
     * @param {number} engine.MAX_RELIEF_Z
     * @param {number} engine.TILE_PIXELS
     * @param {Function} engine.getTextureUrl
     * @param {Function} engine.getElevationUrl
     * @param {number} engine.TILE_MARGIN
     * @param {number} engine.MAX_WORKER_REQUESTS
     * @param {Array.<Object>} engine.layers
     * @param {import('./Projections.js').Projection} engine.projection
     * @param {Function} engine.worldToTileIndex
     */
    constructor(engine) {
        this.engine = engine;
        this.tiles = new Map();
        this.textureCache = new Map();
        this._inFlightTextures = new Map();
        this.textureLoader = new THREE.TextureLoader();
        this.textureLoader.setCrossOrigin('anonymous');
        this.frame = 0;

        /**
         * Активен ли рельеф. Может быть поднят в `true` позже методом
         * {@link TileManager#enableGeotiffElevation}.
         * @type {boolean}
         */
        this.hasElevation = engine.hasElevation;

        /**
         * Настройки освещения тайлов. Значения фиксируем в конструкторе,
         * чтобы хот-пас создания материала не трогал `engine` лишний раз.
         * @private
         */
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

        /**
         * Внешний провайдер высот.
         * @type {Object|null}
         */
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

        if (this.hasElevation) {
            this.initWorker();
        }

        this.onTileHeightAppliedCallbacks = [];
    }

    /** Строковый ключ тайла. @private */
    key(z, virtX, y) {
        return getVirtKey(z, virtX, y);
    }

    /* ================================================================
       Материал тайла
       ================================================================ */

    /**
     * Создаёт материал для тайла.
     *
     * При `tileLighting === false` — быстрый `MeshBasicMaterial`, как
     * раньше. При `true` — `MeshStandardMaterial` с эмуляцией
     * «запечённой» яркости через `emissiveMap`: та же текстура, что и
     * `map`, но с `emissiveIntensity = tileEmissive`. Это компенсирует
     * потемнение под PBR (текстура-то уже «освещена» сервером).
     *
     * @param {THREE.Texture|null} texture
     * @param {Object} [opts]
     * @param {boolean} [opts.depthWrite] - Переопределить `depthWrite`.
     *     По умолчанию `this.hasElevation`.
     * @param {boolean} [opts.depthTest] - Переопределить `depthTest`.
     *     По умолчанию `this.hasElevation`.
     * @returns {THREE.Material}
     * @private
     */
    _createTileMaterial(texture, opts = {}) {
        const depthWrite = opts.depthWrite !== undefined
            ? opts.depthWrite
            : this.hasElevation;
        const depthTest = opts.depthTest !== undefined
            ? opts.depthTest
            : this.hasElevation;

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
                // Та же текстура, что и в `map`. Её `colorSpace` уже
                // выставлен в SRGB при загрузке через loadTextureAsync.
                mat.emissiveMap = texture;
            }
        }

        return mat;
    }

    /**
     * Заменяет текстуру у меша-тайла: и `map`, и `emissiveMap` (если
     * материал освещаемый и `tileEmissive > 0`).
     *
     * Нужен для фоновых BG-тайлов: они создаются до загрузки текстуры,
     * а `emissiveMap` без явной установки останется `null` — и BG
     * будет заметно темнее подробных тайлов.
     *
     * @param {THREE.Mesh} mesh
     * @param {THREE.Texture|null} texture
     */
    setMeshTexture(mesh, texture) {
        if (!mesh || !mesh.material) return;
        mesh.material.map = texture;
        if (mesh.material.isMeshStandardMaterial && this.tileEmissive > 0) {
            mesh.material.emissiveMap = texture;
        }
        mesh.material.needsUpdate = true;
    }

    /* ---- основной метод, вызывается из Core.maybeUpdateVisibleTiles ---- */

    /**
     * Обновляет видимые тайлы на основе положения камеры и зума.
     *
     * @param {THREE.Camera} camera
     * @param {THREE.Vector3} controlsTarget
     * @param {number} continuousZoom
     * @param {THREE.Vector3} worldGroupPos
     * @returns {number} Идеальный дискретный зум.
     */
    update(camera, controlsTarget, continuousZoom, worldGroupPos) {
        this.frame++;
        const idealZ = this.engine.currentDiscreteZoom;

        const dist = camera.position.distanceTo(controlsTarget);
        const margin = this.engine.TILE_MARGIN;
        const tileSize = this.engine.WORLD_SIZE / Math.pow(2, idealZ);
        const maxTile = (1 << idealZ) - 1;
        const vFov = (camera.fov * Math.PI) / 180;
        const aspect = camera.aspect;
        const hh = dist * Math.tan(vFov / 2) * aspect + margin * tileSize;
        const hv = dist * Math.tan(vFov / 2) + margin * tileSize;
        const minX = controlsTarget.x - hh, maxX = controlsTarget.x + hh;
        const minZ = controlsTarget.z - hv, maxZ = controlsTarget.z + hv;

        let xMin, xMax, yMin, yMax;

        if (this.engine.deformedTiles) {
            const samples = [
                [minX, minZ], [maxX, minZ], [minX, maxZ], [maxX, maxZ],
                [(minX + maxX) * 0.5, minZ], [(minX + maxX) * 0.5, maxZ],
                [minX, (minZ + maxZ) * 0.5], [maxX, (minZ + maxZ) * 0.5]
            ];
            let minTx = Infinity, maxTx = -Infinity, minTy = Infinity, maxTy = -Infinity;
            for (const [wx, wz] of samples) {
                const [tx, ty] = this.engine.worldToTileIndex(wx, wz, idealZ);
                if (!Number.isFinite(tx) || !Number.isFinite(ty)) continue;
                if (tx < minTx) minTx = tx;
                if (tx > maxTx) maxTx = tx;
                if (ty < minTy) minTy = ty;
                if (ty > maxTy) maxTy = ty;
            }
            if (Number.isFinite(minTx)) {
                xMin = Math.max(0, Math.floor(minTx));
                xMax = Math.min(maxTile, Math.ceil(maxTx));
                yMin = Math.max(0, Math.floor(minTy));
                yMax = Math.min(maxTile, Math.ceil(maxTy));
            } else {
                xMin = 1; xMax = 0; yMin = 1; yMax = 0;
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
            if (show) inst.lastUsed = this.frame;
        }

        this.gc(renderSet);
        return idealZ;
    }

    /** @private */
    collectCover(z, virtX, y, renderSet, depth = 0) {
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
        for (let dz = 1; dz <= ANCESTOR_FALLBACK && z - dz >= this.engine.MIN_ZOOM; dz++) {
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
       Подключение внешнего источника высот (GeoTIFF)
       ================================================================ */

    /**
     * @param {Object} provider
     * @returns {void}
     */
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

    /**
     * @param {Object} inst
     * @returns {Promise<void>}
     * @private
     */
    async loadTile(inst) {
        const k = this.key(inst.z, inst.virtX, inst.y);
        try {
            const srcX = ((inst.virtX % (1 << inst.z)) + (1 << inst.z)) % (1 << inst.z);
            const srcKey = getVirtKey(inst.z, srcX, inst.y);
            const texUrl = this.engine.getTextureUrl(inst.z, srcX, inst.y);

            if (this.hasElevation && inst.z >= this.engine.MIN_RELIEF_Z && inst.z <= this.engine.MAX_RELIEF_Z) {
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

    /** @private */
    shouldRequestElevation(inst) {
        return inst.z >= this.engine.MIN_RELIEF_Z;
    }

    /**
     * Создаёт меш тайла (прямоугольный режим).
     * @private
     */
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
            this.hasElevation ? -(this.engine.MAX_ZOOM - z) * 0.05 : 0,
            originZ + tileSize / 2
        );
        mesh.renderOrder = z;
        mesh.visible = false;
        return mesh;
    }

    /**
     * Создаёт деформированный меш тайла.
     * @private
     */
    _createDeformedTileMesh(inst, texture) {
        const { z, virtX, y } = inst;
        const n = 1 << z;
        const proj = this.engine.projection;

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
            const lat = Math.atan(Math.sinh(Math.PI * (1 - 2 * tileY / n))) * 180 / Math.PI;
            for (let i = 0; i < grid; i++) {
                const u = i / seg;
                const tileX = virtX + u;
                const lon = tileX / n * 360 - 180;

                const proj2 = proj.fromLonLatSafe([lon, lat]);
                const k = (j * grid + i) * 3;
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
        mesh.position.set(
            cx,
            this.hasElevation ? -(this.engine.MAX_ZOOM - z) * 0.05 : 0,
            cz
        );
        mesh.renderOrder = z;
        mesh.visible = false;
        mesh.userData.deformedTile = true;
        return mesh;
    }

    /**
     * Создаёт статический фоновый меш тайла.
     *
     * Используется для `staticBgGroup` — подложки в Mercator-режиме.
     * **Теперь использует тот же материал, что и подробные тайлы**:
     * при `tileLighting: true` это `MeshStandardMaterial` с
     * `emissiveMap`, и BG-тайлы освещаются так же, как подробные.
     * Переопределяем только `depthWrite`/`depthTest` — BG должен
     * рисоваться поверх depth-буфера (`renderOrder = -2`).
     *
     * Текстура приходит позже (асинхронно) — см. {@link TileManager#setMeshTexture}.
     *
     * @param {number} tileSize
     * @param {number} originX
     * @param {number} originZ
     * @param {THREE.Texture|null} texture
     * @returns {THREE.Mesh}
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
        while (fz > this.engine.MAX_RELIEF_Z) fz--;
        if (fz < this.engine.MIN_RELIEF_Z) throw new Error('No elevation fallback');

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
        if (z < this.engine.MIN_RELIEF_Z || z > this.engine.MAX_RELIEF_Z) return null;

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
        return layerWithElev ? layerWithElev.heightScale : DEFAULTS.HEIGHT_SCALE;
    }

    /** @param {THREE.Vector3} center @param {number} z @param {THREE.Vector3} worldGroupPos */
    prefetchParentElevations(center, z, worldGroupPos) {
        if (!this.hasElevation || z < this.engine.MIN_RELIEF_Z || z > this.engine.MAX_RELIEF_Z) return;
        if (this.elevationProvider) return;
        const tileSize = this.engine.WORLD_SIZE / Math.pow(2, z);
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

    /* ---- LRU сборщик мусора ---- */

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
        this.tiles.delete(this.key(inst.z, inst.virtX, inst.y));
        if (inst.mesh) {
            this.engine.worldGroup.remove(inst.mesh);
            inst.mesh.geometry.dispose();
            // Material.dispose() не трогает текстуру — она в ref-кэше.
            inst.mesh.material.dispose();
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