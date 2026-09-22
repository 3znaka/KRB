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
 *     globalElevCache: new Map(),
 *     worldGroup: new THREE.Group(),
 *     projection: Projections.get('EPSG:3857'),
 *     getTextureUrl: (z, x, y) => `https://example.com/tiles/${z}/${x}/${y}.png`,
 *     getElevationUrl: (z, x, y) => `https://example.com/elevation/${z}/${x}/${y}.png`,
 *     MAX_WORKER_REQUESTS: 4,
 *     layers: [{ elevation: true, heightScale: 1.2 }]
 * };
 * const tileManager = new TileManager(engine);
 * tileManager.update(engine.camera, engine.controlsTarget, 3, engine.worldGroup.position);
 * tileManager.ensureTile(3, 0, 0);
 * const texture = await tileManager.loadTextureAsync('https://example.com/tile.png');
 * tileManager.createStaticTileMesh(1000, -500, -500, texture);
 * tileManager.prefetchParentElevations(new THREE.Vector3(0, 0, 0), 3, engine.worldGroup.position);
 */
export class TileManager {
    /**
     * @param {Object} engine - Объект движка карты.
     * @param {boolean} engine.hasElevation
     * @param {boolean} engine.deformedTiles - Использовать ли деформированные тайлы.
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
     * @param {import('./Projections.js').Projection} engine.projection - Проекция карты.
     * @param {Function} engine.worldToTileIndex - Хелпер Core (world → дробный tile index).
     */
    constructor(engine) {
        this.engine = engine;
        this.tiles = new Map();
        this.textureCache = new Map();
        this._inFlightTextures = new Map();
        this.textureLoader = new THREE.TextureLoader();
        this.textureLoader.setCrossOrigin('anonymous');
        this.frame = 0;

        this.hasElevation = engine.hasElevation;

        this.pendingWorkerJobs = [];
        this.activeWorkerJobs = 0;
        this.nextJobId = 1;
        this.workerPromises = new Map();

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

    /** Строковый ключ тайла. @private */
    key(z, virtX, y) {
        return getVirtKey(z, virtX, y);
    }

    /* ---- основной метод, вызывается из Core.maybeUpdateVisibleTiles ---- */

    /**
     * Обновляет видимые тайлы на основе положения камеры и зума.
     *
     * В Mercator-режиме bbox видимости — прямоугольник в tile-space.
     * В deformed-режиме bbox считается по 8 точкам (углы + середины
     * сторон видимой области) через `engine.worldToTileIndex` — так
     * корректно учитывается нелинейность проекции.
     *
     * ВАЖНО: в deformed-режиме bbox КЛАМПИТСЯ к [0, maxTile] по обеим
     * осям. Без этого проекции с узким доменом (Equal Earth и т.п.)
     * давали tile-индексы вида -7..15, и цикл генерировал сотни
     * «фантомных» тайлов, каждый из которых прогонялся через proj4.
     * Это и вызывало просадку до 1 FPS.
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
            // Углы + середины сторон дают устойчивый bbox даже для
            // сильно нелинейных проекций (UTM/GK далеко от центрального
            // меридиана).
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
                // Клампим ОБЕ оси к валидному диапазону индексов.
                // До этого фикса xMin/xMax не клампились, и для Equal Earth
                // bbox разъезжался до -7..15, что давало 200+ тайлов на кадр.
                xMin = Math.max(0, Math.floor(minTx));
                xMax = Math.min(maxTile, Math.ceil(maxTx));
                yMin = Math.max(0, Math.floor(minTy));
                yMax = Math.min(maxTile, Math.ceil(maxTy));
            } else {
                // Вся видимая область за пределами проекции.
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

            // Всегда пытаемся загрузить идеальный тайл (ensureTile
            // стартует загрузку при необходимости). Для deformed-режима
            // тайлы вне области определения проекции просто «фейлятся»
            // внутри loadTile и не мешают.
            const inst = this.ensureTile(idealZ, vx, y);

            if (inst.ready && inst.mesh) {
                renderSet.add(k);
                continue;
            }

            // 1. Покрытие потомками — только чтение кэша, без загрузок.
            const fullyCovered = this.collectCover(idealZ, vx, y, renderSet);

            // 2. Если потомки не закрыли всю область — пробуем предка.
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
     * @param {number} z
     * @param {number} virtX
     * @param {number} y
     * @param {Set} renderSet
     * @param {number} [depth]
     * @returns {boolean} True, если всё покрытие собрано.
     * @private
     */
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

    /**
     * Ищет ближайшего готового предка для тайла.
     *
     * ВАЖНО: если предок помечен `unrenderable` (например, целиком
     * лежит вне области определения проекции), прекращаем поиск.
     * Логика: если тайл на зуме Z не удалось построить из-за того, что
     * он вне домена, то его родитель на Z-1, покрывающий ту же
     * географическую область, тоже вне домена. Раньше это приводило к
     * бесконечному созданию и выбросу цепочек предков на каждом кадре.
     *
     * @param {number} z
     * @param {number} virtX
     * @param {number} y
     * @returns {Object|null}
     * @private
     */
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
     *
     * @param {number} z
     * @param {number} virtX
     * @param {number} y
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
            /**
             * Тайл невозможно отрисовать в принципе: `createTileMesh`
             * вернул null (вырожден / вне области определения проекции).
             * Не даём `findReadyAncestor` спамить предками по этому
             * поддереву.
             * @type {boolean}
             */
            unrenderable: false,
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
     * Если `createTileMesh` возвращает null (деформированный тайл
     * вырожден/перекручен/вне области определения проекции) —
     * тайл помечается failed+unrenderable без геометрии, текстура
     * освобождается.
     *
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
                // Деформированный тайл «схлопнулся» / вне области определения.
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
     * Нужно ли запрашивать высоты для тайла.
     * @param {Object} inst
     * @returns {boolean}
     * @private
     */
    shouldRequestElevation(inst) {
        return inst.z >= this.engine.MIN_RELIEF_Z;
    }

    /**
     * Создаёт меш тайла с текстурой. В deformed-режиме делегирует
     * `_createDeformedTileMesh`.
     *
     * @param {Object} inst
     * @param {THREE.Texture} texture
     * @returns {THREE.Mesh|null} Меш или null, если тайл вырожден.
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

        const mat = new THREE.MeshBasicMaterial({
            map: texture,
            depthWrite: this.hasElevation,
            depthTest: this.hasElevation
        });

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
     * Создаёт деформированный меш тайла: каждая вершина сетки
     * `(SEG+1)×(SEG+1)` вычисляется через lon/lat соответствующей
     * точки XYZ-тайла, спроецированные в проекцию карты.
     *
     * Раскладка вершин совпадает с PlaneGeometry:
     *   row 0 = север (north), col 0 = запад (west),
     *   UV плавно идут (0,1) NW → (1,0) SE.
     * Это значит `applyHeightsToGeometry` и `syncEdgesBetween`
     * работают без изменений.
     *
     * Возвращает `null`, если тайл:
     *  - выходит за область определения проекции (proj4-safe → null), или
     *  - вырожден / перекручен (знаковая площадь углов ≤ 0).
     *
     * @param {Object} inst
     * @param {THREE.Texture} texture
     * @returns {THREE.Mesh|null}
     * @private
     */
    _createDeformedTileMesh(inst, texture) {
        const { z, virtX, y } = inst;
        const n = 1 << z;
        const proj = this.engine.projection;

        // С рельефом seg = SEGMENTS — иначе воркер вернёт (SEGMENTS+1)²
        // значений, которые applyHeightsToGeometry разложит по вершинам
        // в порядке row-major (совпадает с PlaneGeometry).
        const seg = this.hasElevation ? this.engine.SEGMENTS : DEFORM_SEGMENTS_FLAT;
        const grid = seg + 1;
        const count = grid * grid;

        const geom = new THREE.PlaneGeometry(1, 1, seg, seg);
        geom.rotateX(-Math.PI / 2);

        const arr = geom.attributes.position.array;

        let sumX = 0, sumZ = 0;
        let hasInvalid = false;

        for (let j = 0; j < grid; j++) {
            const v = j / seg;             // 0 = север, 1 = юг
            const tileY = y + v;
            const lat = Math.atan(Math.sinh(Math.PI * (1 - 2 * tileY / n))) * 180 / Math.PI;
            for (let i = 0; i < grid; i++) {
                const u = i / seg;
                // Используем virtX (не srcX): в deformed-режиме мир
                // НЕ замкнут по долготе, и тайл с virtX=-1 должен
                // попасть ровно в свой (невалидный для проекции) сектор.
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
                const wz = -proj2[1]; // Y-флип: Z на юг
                arr[k] = wx;
                arr[k + 1] = 0;
                arr[k + 2] = wz;
                sumX += wx;
                sumZ += wz;
            }
        }

        if (hasInvalid) return null;

        // Проверка «песочных часов»: знаковая площадь четырёхугольника
        // углов (в порядке NW → NE → SE → SW). Для нормального тайла
        // она > 0 (положительная ориентация в системе X×Z, где Z на юг).
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

        // Центрируем по центроиду — mesh.position будет в его координатах.
        const cx = sumX / count;
        const cz = sumZ / count;
        for (let k = 0; k < count; k++) {
            arr[k * 3]     -= cx;
            arr[k * 3 + 2] -= cz;
        }

        geom.attributes.position.needsUpdate = true;
        geom.computeVertexNormals();
        geom.computeBoundingSphere();

        const mat = new THREE.MeshBasicMaterial({
            map: texture,
            depthWrite: this.hasElevation,
            depthTest: this.hasElevation
        });

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
     * @param {number} tileSize
     * @param {number} originX
     * @param {number} originZ
     * @param {THREE.Texture|null} texture
     * @returns {THREE.Mesh}
     */
    createStaticTileMesh(tileSize, originX, originZ, texture) {
        const geom = new THREE.PlaneGeometry(tileSize, tileSize, 1, 1);
        geom.rotateX(-Math.PI / 2);
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
     * Параллельные запросы на один URL разделяют in-flight промис.
     *
     * @param {string} url
     * @returns {Promise<THREE.Texture|null>}
     */
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

    /**
     * Уменьшает счётчик ссылок текстуры и освобождает при необходимости.
     * @param {string} url
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
     * @param {Object} inst
     * @returns {Promise<void>}
     * @private
     */
    async requestElevation(inst) {
        const k = this.key(inst.z, inst.virtX, inst.y);
        try {
            const srcX = ((inst.virtX % (1 << inst.z)) + (1 << inst.z)) % (1 << inst.z);
            const srcKey = getVirtKey(inst.z, srcX, inst.y);
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
        promise.catch(() => {}).finally(() => {
            this.elevDirectPromises.delete(srcKey);
        });
        return promise;
    }

    /** Обрабатывает очередь запросов высот. @private */
    _processElevationQueue() {
        while (this.activeElevationFetches < this.MAX_ELEVATION_FETCHES && this.elevationQueue.length > 0) {
            const { execute, resolve, reject } = this.elevationQueue.shift();
            execute().then(resolve).catch(reject);
        }
    }

    /**
     * Получает высоты из родительского тайла при отсутствии прямых данных.
     * @param {Object} inst
     * @returns {Promise<Float32Array>}
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
            tileSize, originX, originZ,
            segments: this.engine.SEGMENTS,
            scale, dx, dy,
            heightScale: this.getElevationHeightScale()
        });
        return result.heights;
    }

    /**
     * Загружает данные высот родительского тайла.
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
     * Работает в deformed-режиме так же, как в Mercator: раскладка
     * вершин PlaneGeometry одна и та же. Соседи определяются по
     * tile-space (virtX, y), а не по world-координатам.
     * @private
     */
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

    /**
     * Синхронизирует высоты по общему ребру двух тайлов.
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
        instA.geometry.computeVertexNormals();
        instB.geometry.computeVertexNormals();
    }

    /**
     * Масштаб высот из слоёв движка.
     * @returns {number}
     * @private
     */
    getElevationHeightScale() {
        const layerWithElev = this.engine.layers.find(l => l.elevation);
        return layerWithElev ? layerWithElev.heightScale : DEFAULTS.HEIGHT_SCALE;
    }

    /**
     * Предзагружает данные высот родительских тайлов в окрестности точки.
     *
     * В deformed-режиме bbox считается через `engine.worldToTileIndex`
     * по 5 точкам вокруг центра — иначе на нелинейных проекциях легко
     * ошибиться с диапазоном.
     *
     * @param {THREE.Vector3} center
     * @param {number} z
     * @param {THREE.Vector3} worldGroupPos
     */
    prefetchParentElevations(center, z, worldGroupPos) {
        if (!this.hasElevation || z < this.engine.MIN_RELIEF_Z || z > this.engine.MAX_RELIEF_Z) return;
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

    /** LRU-сборщик мусора для тайлов. @private */
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

    /** Освобождает ресурсы тайла. @private */
    disposeTile(inst) {
        this.tiles.delete(this.key(inst.z, inst.virtX, inst.y));
        if (inst.mesh) {
            this.engine.worldGroup.remove(inst.mesh);
            inst.mesh.geometry.dispose();
            inst.mesh.material.dispose();
        }
        if (inst.texUrl) this.releaseTexture(inst.texUrl);
    }

    /**
     * Инициализирует воркер для вычисления высот.
     *
     * Воркер не зависит от проекции: он сэмплит elevation-картинку
     * по UV-сетке и возвращает (SEGMENTS+1)² высот в row-major, что
     * совпадает с раскладкой вершин PlaneGeometry и для deformed,
     * и для плоских тайлов.
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

    /** Обрабатывает очередь задач воркера. @private */
    processWorkerQueue() {
        while (this.activeWorkerJobs < this.engine.MAX_WORKER_REQUESTS && this.pendingWorkerJobs.length > 0) {
            const job = this.pendingWorkerJobs.shift();
            this.activeWorkerJobs++;
            this.worker.postMessage({ id: job.id, type: job.type, payload: job.payload });
        }
    }

    /**
     * Планирует задачу для воркера.
     * @param {string} type
     * @param {Object} payload
     * @returns {Promise<Object>}
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