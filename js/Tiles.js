import {
  THREE
} from '../js_TP/tpb.js';  
import { getOriginZ, getSrcKey, getVirtKey, DEFAULTS } from './Utils.js';

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
const MAX_COVER_DEPTH = 2; // глубина поиска потомков при отдалении

/**
 * Тайл карты с текстурой, данными высоты и атрибуцией.
 *
 * @property {THREE.Texture} texture - Текстура тайла.
 * @property {*} elevation - Данные о высоте тайла.
 * @property {string} attributionTitle - Название атрибуции.
 * @property {string} attributionUrl - URL атрибуции.
 * @property {number} heightScale - Масштаб высот.
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
     * Создаёт тайл карты.
     *
     * @param {Object} options - Объект параметров тайла.
     * @param {THREE.Texture} options.texture - Текстура тайла.
     * @param {*} options.elevation - Данные о высоте тайла.
     * @param {string} [options.attributionTitle] - Название атрибуции.
     * @param {string} [options.attributionUrl] - URL атрибуции.
     * @param {number} [options.heightScale] - Масштаб высот. По умолчанию DEFAULTS.HEIGHT_SCALE.
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
 * @property {Map} tiles - Хранилище тайлов.
 * @property {Map} textureCache - Кэш текстур.
 * @property {THREE.TextureLoader} textureLoader - Загрузчик текстур.
 * @property {number} frame - Счётчик кадров.
 * @property {boolean} hasElevation - Флаг наличия рельефа.
 * @property {Map} srcKeyToElevUrl - Сопоставление ключа исходного тайла и URL высоты.
 * @property {Map} parentElevCache - Кэш данных высот родительских тайлов.
 * @property {Map} parentElevPromises - Промисы загрузки данных высот родительских тайлов.
 * @property {Map} elevDirectPromises - Промисы прямых запросов высот.
 * @property {Array} elevationQueue - Очередь запросов высот.
 * @property {number} activeElevationFetches - Количество активных запросов высот.
 * @property {number} MAX_ELEVATION_FETCHES - Максимум одновременных запросов высот.
 * @property {Worker} worker - Воркер для вычисления высот.
 * @property {Array} pendingWorkerJobs - Очередь задач для воркера.
 * @property {number} activeWorkerJobs - Количество активных задач воркера.
 * @property {number} nextJobId - Следующий идентификатор задачи.
 * @property {Map} workerPromises - Промисы задач воркера.
 * @property {Array} onTileHeightAppliedCallbacks - Колбэки после применения высот.
 *
 * @example
 * (async () => {
 *     const engine = {
 *         currentDiscreteZoom: 3,
 *         TILE_MARGIN: 0.1,
 *         WORLD_SIZE: 2 * Math.PI * 6371000,
 *         MAX_MERCATOR: Math.PI * 6371000,
 *         SEGMENTS: 32,
 *         MIN_ZOOM: 0,
 *         MAX_ZOOM: 18,
 *         MIN_RELIEF_Z: 5,
 *         MAX_RELIEF_Z: 15,
 *         TILE_PIXELS: 256,
 *         hasElevation: true,
 *         globalElevCache: new Map(),
 *         worldGroup: new THREE.Group(),
 *         getTextureUrl: (z, x, y) => `https://example.com/tiles/${z}/${x}/${y}.png`,
 *         getElevationUrl: (z, x, y) => `https://example.com/elevation/${z}/${x}/${y}.png`,
 *         camera: new THREE.PerspectiveCamera(),
 *         controlsTarget: new THREE.Vector3(),
 *         MAX_WORKER_REQUESTS: 4,
 *         layers: [{ elevation: true, heightScale: 1.2 }]
 *     };
 *     const tileManager = new TileManager(engine);
 *     tileManager.update(engine.camera, engine.controlsTarget, 3, engine.worldGroup.position);
 *     tileManager.ensureTile(3, 0, 0);
 *     const texture = await tileManager.loadTextureAsync('https://example.com/tile.png');
 *     tileManager.createStaticTileMesh(1000, -500, -500, texture);
 *     tileManager.prefetchParentElevations(new THREE.Vector3(0, 0, 0), 3, engine.worldGroup.position);
 * })();
 */
export class TileManager {
    /**
     * Создаёт менеджер тайлов.
     *
     * @param {Object} engine - Объект движка карты.
     * @param {boolean} engine.hasElevation - Флаг наличия рельефа.
     * @param {Map} [engine.globalElevCache] - Глобальный кэш данных высот.
     * @param {THREE.Group} engine.worldGroup - Группа мира.
     * @param {number} engine.MAX_MERCATOR - Максимальное значение проекции Меркатора.
     * @param {number} engine.WORLD_SIZE - Размер мира.
     * @param {number} engine.SEGMENTS - Количество сегментов сетки.
     * @param {number} engine.MIN_ZOOM - Минимальный зум.
     * @param {number} engine.MAX_ZOOM - Максимальный зум.
     * @param {number} engine.MIN_RELIEF_Z - Минимальный зум для рельефа.
     * @param {number} engine.MAX_RELIEF_Z - Максимальный зум для рельефа.
     * @param {number} engine.TILE_PIXELS - Размер тайла в пикселях.
     * @param {Function} engine.getTextureUrl - Функция получения URL текстуры.
     * @param {Function} engine.getElevationUrl - Функция получения URL высоты.
     * @param {number} engine.TILE_MARGIN - Отступ тайлов.
     * @param {number} engine.MAX_WORKER_REQUESTS - Максимум одновременных запросов к воркеру.
     * @param {THREE.Camera} engine.camera - Камера.
     * @param {THREE.Vector3} engine.controlsTarget - Цель контролов.
     * @param {Array.<Object>} engine.layers - Слои карты (для получения масштаба высот).
     */
    constructor(engine) {
        this.engine = engine;
        this.tiles = new Map(); // ключ -> { z, virtX, y, mesh, geometry, ready, failed, loading, texUrl, lastUsed, heightsApplied, elevationAppliedLevel, expectsElevation }
        this.textureCache = new Map(); // url -> { texture, refs }
        this.textureLoader = new THREE.TextureLoader();
        this.textureLoader.setCrossOrigin('anonymous');
        this.frame = 0;

        this.hasElevation = engine.hasElevation;
        if (this.hasElevation) {
            this.srcKeyToElevUrl = new Map();
            this.parentElevCache = engine.globalElevCache || new Map();
            this.parentElevPromises = new Map();
            this.elevDirectPromises = new Map();
            this.elevationQueue = [];
            this.activeElevationFetches = 0;
            this.MAX_ELEVATION_FETCHES = 4;
            this.initWorker();
        }

        this.onTileHeightAppliedCallbacks = [];
    }

    /**
     * Возвращает строковый ключ тайла по координатам.
     *
     * @param {number} z - Уровень зума.
     * @param {number} virtX - Виртуальная координата X.
     * @param {number} y - Координата Y.
     * @returns {string} Ключ тайла.
     * @private
     */
    key(z, virtX, y) {
        return `${z},${virtX},${y}`;
    }

    /* ---- основной метод, вызывается из Core.maybeUpdateVisibleTiles ---- */
    /**
     * Обновляет видимые тайлы на основе положения камеры и зума.
     *
     * @param {THREE.Camera} camera - Камера.
     * @param {THREE.Vector3} controlsTarget - Цель контролов.
     * @param {number} continuousZoom - Непрерывный зум.
     * @param {THREE.Vector3} worldGroupPos - Позиция мировой группы.
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
        const off = worldGroupPos;
        const xMin = Math.floor((minX - off.x + this.engine.MAX_MERCATOR) / tileSize);
        const xMax = Math.floor((maxX - off.x + this.engine.MAX_MERCATOR) / tileSize);
        const yMin = Math.max(0, Math.floor((minZ - off.z + this.engine.MAX_MERCATOR) / tileSize));
        const yMax = Math.min(maxTile, Math.floor((maxZ - off.z + this.engine.MAX_MERCATOR) / tileSize));

        const visibleKeys = new Set();
        for (let y = yMin; y <= yMax; y++) {
            for (let vx = xMin; vx <= xMax; vx++) {
                visibleKeys.add(getVirtKey(idealZ, vx, y));
            }
        }

        const renderSet = new Set();
        for (const k of visibleKeys) {
            const [, vx, y] = k.split(',').map(Number);

            // Всегда пытаемся загрузить идеальный тайл (ensureTile стартует загрузку при необходимости)
            const inst = this.ensureTile(idealZ, vx, y);

            if (inst.ready) {
                renderSet.add(k);
                continue;
            }

            // 1. Покрытие потомками (отдаление) – только чтение кэша, без загрузок
            const fullyCovered = this.collectCover(idealZ, vx, y, renderSet);

            // 2. Если потомки не закрыли всю область, добавляем предка (приближение / края)
            if (!fullyCovered) {
                const anc = this.findReadyAncestor(idealZ, vx, y);
                if (anc) renderSet.add(this.key(anc.z, anc.virtX, anc.y));
            }
        }

        // Переключение видимости
        for (const [k, inst] of this.tiles) {
            if (!inst.mesh) continue;
            const show = renderSet.has(k);
            if (inst.mesh.visible !== show) inst.mesh.visible = show;
            if (show) inst.lastUsed = this.frame;
        }

        this.gc(renderSet);

        return idealZ;
    }

    /**
     * Рекурсивно собирает готовых потомков тайла в renderSet.
     *
     * @param {number} z - Уровень зума.
     * @param {number} virtX - Виртуальная координата X.
     * @param {number} y - Координата Y.
     * @param {Set} renderSet - Множество ключей для отрисовки.
     * @param {number} [depth] - Текущая глубина рекурсии.
     * @returns {boolean} True, если все потомки покрывают тайл.
     * @private
     */
    collectCover(z, virtX, y, renderSet, depth = 0) {
        const k = this.key(z, virtX, y);
        const inst = this.tiles.get(k);
        if (inst && inst.ready) {
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
     * Ищет ближайшего готового предка для тайла.
     *
     * @param {number} z - Уровень зума.
     * @param {number} virtX - Виртуальная координата X.
     * @param {number} y - Координата Y.
     * @returns {Object|null} Объект тайла или null.
     * @private
     */
    findReadyAncestor(z, virtX, y) {
        for (let dz = 1; dz <= ANCESTOR_FALLBACK && z - dz >= this.engine.MIN_ZOOM; dz++) {
            const az = z - dz;
            const ax = virtX >> dz;
            const ay = y >> dz;
            const inst = this.ensureTile(az, ax, ay);
            if (inst.ready) return inst;
        }
        return null;
    }

    /**
     * Возвращает существующий тайл или создаёт и запускает загрузку нового.
     *
     * @param {number} z - Уровень зума.
     * @param {number} virtX - Виртуальная координата X.
     * @param {number} y - Координата Y.
     * @returns {Object} Объект тайла.
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
            mesh: null,
            geometry: null,
            ready: false,
            failed: false,
            loading: true,
            texUrl: null,
            lastUsed: this.frame,
            heightsApplied: false,
            elevationAppliedLevel: 0,
            expectsElevation: false
        };
        this.tiles.set(k, inst);
        this.loadTile(inst);
        return inst;
    }

    /**
     * Асинхронно загружает текстуру тайла и создаёт меш.
     *
     * @param {Object} inst - Объект тайла.
     * @returns {Promise<void>}
     * @private
     */
    async loadTile(inst) {
        const k = this.key(inst.z, inst.virtX, inst.y);
        try {
            const srcX = ((inst.virtX % (1 << inst.z)) + (1 << inst.z)) % (1 << inst.z);
            const srcKey = getSrcKey(inst.z, srcX, inst.y);
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
     * Определяет, нужно ли запрашивать данные высот для тайла.
     *
     * @param {Object} inst - Объект тайла.
     * @returns {boolean} True, если нужно.
     * @private
     */
    shouldRequestElevation(inst) {
        return inst.z >= this.engine.MIN_RELIEF_Z;
    }

    /**
     * Создаёт меш для тайла с текстурой.
     *
     * @param {Object} inst - Объект тайла.
     * @param {THREE.Texture} texture - Текстура.
     * @returns {THREE.Mesh} Меш тайла.
     * @private
     */
createTileMesh(inst, texture) {
    const { z, virtX, y } = inst;
    const tileSize = this.engine.WORLD_SIZE / Math.pow(2, z);
    const seg = this.hasElevation ? this.engine.SEGMENTS : 1;
    const originX = virtX * tileSize - this.engine.MAX_MERCATOR;
    const originZ = getOriginZ(y, tileSize, this.engine.MAX_MERCATOR);

    let geometry;
    if (!this.hasElevation && this.flatTileGeometry) {
        geometry = this.flatTileGeometry.clone();
        geometry.rotateX(-Math.PI / 2);
        // Трансляция убрана
    } else {
        geometry = new THREE.PlaneGeometry(tileSize, tileSize, seg, seg);
        geometry.rotateX(-Math.PI / 2);
        // Трансляция убрана
    }

    const mat = new THREE.MeshBasicMaterial({
        map: texture,
        depthWrite: this.hasElevation,
        depthTest: this.hasElevation
    });

    const mesh = new THREE.Mesh(geometry, mat);
    mesh.position.set(
        originX + tileSize / 2,
        z * LEVEL_Y_STEP,
        originZ + tileSize / 2
    );
    mesh.renderOrder = z;
    mesh.visible = false;
    return mesh;
}

    /**
     * Создаёт статический фоновый меш тайла.
     *
     * @param {number} tileSize - Размер тайла в мировых единицах.
     * @param {number} originX - Мировая координата X начала тайла.
     * @param {number} originZ - Мировая координата Z начала тайла.
     * @param {THREE.Texture|null} texture - Текстура (может быть null).
     * @returns {THREE.Mesh} Меш фонового тайла.
     */
createStaticTileMesh(tileSize, originX, originZ, texture) {
    const geom = new THREE.PlaneGeometry(tileSize, tileSize, 1, 1);
    geom.rotateX(-Math.PI / 2);
    // Трансляция убрана
    const mat = new THREE.MeshBasicMaterial({
        color: 0xffffff,
        map: texture,
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
    /**
     * Асинхронно загружает текстуру по URL с кэшированием.
     *
     * @param {string} url - URL текстуры.
     * @returns {Promise<THREE.Texture|null>} Текстура или null при ошибке.
     */
    async loadTextureAsync(url) {
        if (!url) return null;
        if (this.textureCache.has(url)) {
            const e = this.textureCache.get(url);
            e.refs++;
            return e.texture;
        }
        const promise = new Promise((resolve) => {
            this.textureLoader.load(url, tex => {
                tex.colorSpace = THREE.SRGBColorSpace;
                resolve(tex);
            }, undefined, () => resolve(null));
        });
        const texture = await promise;
        if (!texture) return null;
        this.textureCache.set(url, { texture, refs: 1 });
        return texture;
    }

    /**
     * Уменьшает счётчик ссылок текстуры и освобождает при необходимости.
     *
     * @param {string} url - URL текстуры.
     * @returns {void}
     * @private
     */
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
     * Запрашивает данные высот для тайла и применяет их к геометрии.
     *
     * @param {Object} inst - Объект тайла.
     * @returns {Promise<void>}
     * @private
     */
    async requestElevation(inst) {
        const k = this.key(inst.z, inst.virtX, inst.y);
        try {
            const srcX = ((inst.virtX % (1 << inst.z)) + (1 << inst.z)) % (1 << inst.z);
            const srcKey = getSrcKey(inst.z, srcX, inst.y);
            const elevUrl = this.srcKeyToElevUrl.get(srcKey);
            const tileSize = this.engine.WORLD_SIZE / Math.pow(2, inst.z);
            const originX = inst.virtX * tileSize - this.engine.MAX_MERCATOR;
            const originZ = getOriginZ(inst.y, tileSize, this.engine.MAX_MERCATOR);

            let heights;
            if (elevUrl) {
                heights = await this.getDirectElevData(srcKey, elevUrl, tileSize, originX, originZ);
            } else {
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

    /**
     * Получает данные высот напрямую по URL или из кэша.
     *
     * @param {string} srcKey - Ключ исходного тайла.
     * @param {string} elevUrl - URL карты высот.
     * @param {number} tileSize - Размер тайла.
     * @param {number} originX - Мировая X начала тайла.
     * @param {number} originZ - Мировая Z начала тайла.
     * @returns {Promise<Float32Array>} Массив высот.
     * @private
     */
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
        promise.finally(() => this.elevDirectPromises.delete(srcKey));
        return promise;
    }

    /**
     * Обрабатывает очередь запросов высот.
     *
     * @returns {void}
     * @private
     */
    _processElevationQueue() {
        while (this.activeElevationFetches < this.MAX_ELEVATION_FETCHES && this.elevationQueue.length > 0) {
            const { execute, resolve, reject } = this.elevationQueue.shift();
            execute().then(resolve).catch(reject);
        }
    }

    /**
     * Получает высоты из родительского тайла при отсутствии прямых данных.
     *
     * @param {Object} inst - Объект тайла.
     * @returns {Promise<Float32Array>} Массив высот.
     * @throws {Error} Если нет доступного родительского тайла.
     * @private
     */
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
            tileSize,
            originX,
            originZ,
            segments: this.engine.SEGMENTS,
            scale,
            dx,
            dy,
            heightScale: this.getElevationHeightScale()
        });
        return result.heights;
    }

    /**
     * Загружает данные высот родительского тайла.
     *
     * @param {number} z - Уровень зума.
     * @param {number} srcX - Исходная координата X.
     * @param {number} y - Координата Y.
     * @returns {Promise<ImageData|null>} Данные изображения или null.
     * @private
     */
    async getParentElevData(z, srcX, y) {
        if (z < this.engine.MIN_RELIEF_Z || z > this.engine.MAX_RELIEF_Z) return null;
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
            img.src = this.engine.getElevationUrl(z, srcX, y);
        });
        this.parentElevPromises.set(key, promise);
        return promise;
    }

    /**
     * Применяет массив высот к геометрии тайла.
     *
     * @param {Object} inst - Объект тайла.
     * @param {Float32Array} heights - Массив высот.
     * @returns {void}
     * @private
     */
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

    /**
     * Синхронизирует высоты с соседними тайлами.
     *
     * @param {Object} inst - Объект тайла.
     * @returns {void}
     * @private
     */
    syncTileWithNeighbors(inst) {
        const neighbors = [[1,0], [-1,0], [0,1], [0,-1]];
        for (const [dx, dy] of neighbors) {
            const nVirtX = inst.virtX + dx, nY = inst.y + dy;
            const nKey = this.key(inst.z, nVirtX, nY);
            const nInst = this.tiles.get(nKey);
            if (nInst && nInst.heightsApplied) {
                this.syncEdgesBetween(inst, nInst, dx, dy);
            }
        }
    }

    /**
     * Синхронизирует высоты по общему ребру двух тайлов.
     *
     * @param {Object} instA - Первый тайл.
     * @param {Object} instB - Второй тайл.
     * @param {number} dx - Смещение по X от A к B.
     * @param {number} dy - Смещение по Y от A к B.
     * @returns {void}
     * @private
     */
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
    }

    /**
     * Возвращает масштаб высот из слоёв движка.
     *
     * @returns {number} Масштаб высот.
     * @private
     */
    getElevationHeightScale() {
        const layerWithElev = this.engine.layers.find(l => l.elevation);
        return layerWithElev ? layerWithElev.heightScale : DEFAULTS.HEIGHT_SCALE;
    }

    /**
     * Предзагружает данные высот родительских тайлов в окрестности точки.
     *
     * @param {THREE.Vector3} center - Центральная точка.
     * @param {number} z - Уровень зума.
     * @param {THREE.Vector3} worldGroupPos - Позиция мировой группы.
     * @returns {void}
     */
    prefetchParentElevations(center, z, worldGroupPos) {
        if (!this.hasElevation || z < this.engine.MIN_RELIEF_Z || z > this.engine.MAX_RELIEF_Z) return;
        const tileSize = this.engine.WORLD_SIZE / Math.pow(2, z);
        const maxTile = (1 << z) - 1;
        const margin = 2;
        const xMin = Math.floor((center.x - tileSize * margin - worldGroupPos.x + this.engine.MAX_MERCATOR) / tileSize);
        const xMax = Math.floor((center.x + tileSize * margin - worldGroupPos.x + this.engine.MAX_MERCATOR) / tileSize);
        for (let y = 0; y <= maxTile; y++) {
            const oz = getOriginZ(y, tileSize, this.engine.MAX_MERCATOR) + worldGroupPos.z;
            if (oz + tileSize < center.z - tileSize * margin || oz > center.z + tileSize * margin) continue;
            for (let x = xMin; x <= xMax; x++) {
                this.getParentElevData(z, x, y).catch(() => {});
            }
        }
    }

    /* ---- LRU сборщик мусора ---- */
    /**
     * Выполняет сборку мусора для тайлов.
     *
     * @param {Set} renderSet - Множество ключей для отрисовки.
     * @returns {void}
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

    /**
     * Освобождает ресурсы тайла.
     *
     * @param {Object} inst - Объект тайла.
     * @returns {void}
     * @private
     */
    disposeTile(inst) {
        this.tiles.delete(this.key(inst.z, inst.virtX, inst.y));
        if (inst.mesh) {
            this.engine.worldGroup.remove(inst.mesh);
            inst.mesh.geometry.dispose();
            inst.mesh.material.dispose();
        }
        if (inst.texUrl) this.releaseTexture(inst.texUrl);
    }

    /* ---- Worker (без изменений) ---- */
    /**
     * Инициализирует воркер для вычисления высот.
     *
     * @returns {void}
     * @private
     */
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
                this.activeWorkerJobs--;
                this.processWorkerQueue();
                if (error) reject(new Error(error));
                else resolve(result);
            } else {
                this.activeWorkerJobs--;
                this.processWorkerQueue();
            }
        };
        this.pendingWorkerJobs = [];
        this.activeWorkerJobs = 0;
        this.nextJobId = 1;
        this.workerPromises = new Map();
    }

    /**
     * Обрабатывает очередь задач воркера.
     *
     * @returns {void}
     * @private
     */
    processWorkerQueue() {
        while (this.activeWorkerJobs < this.engine.MAX_WORKER_REQUESTS && this.pendingWorkerJobs.length > 0) {
            const job = this.pendingWorkerJobs.shift();
            this.activeWorkerJobs++;
            this.worker.postMessage({ id: job.id, type: job.type, payload: job.payload });
        }
    }

    /**
     * Планирует задачу для воркера.
     *
     * @param {string} type - Тип задачи.
     * @param {Object} payload - Данные задачи.
     * @returns {Promise<Object>} Результат задачи.
     * @private
     */
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