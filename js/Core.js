import {
  THREE,
  OrbitControls
} from '../js_TP/tpb.js';
import { DEFAULTS, getOriginZ, getVirtKey } from './Utils.js';
import { Projections } from './Projections.js';
import { TileManager } from './Tiles.js';
import { TextManager } from './TextManager.js';
import { initUI } from './Ui.js';
import { PopupManager } from './PopupManager.js';

/**
 * Представление карты, хранящее параметры центра, масштаба и углов обзора.
 *
 * Центр карты можно задать одним из двух способов:
 *
 * 1. `options.centerLonLat` — координаты [lon, lat] в WGS84 (EPSG:4326).
 *    Удобно для обычного кода: не нужно самостоятельно конвертировать
 *    градусы в метры. View сам преобразует их в метры `options.projection`.
 *
 * 2. `options.center` — координаты [x, z] сразу в **мировых** метрах проекции
 *    `options.projection`. Обратите внимание: это world-координаты KrbMap,
 *    где ось Z направлена на юг (север = −Z). Используйте этот вариант,
 *    только если у вас уже есть готовые world-координаты (например,
 *    сохранённое состояние карты или результат `KrbMap#project`).
 *
 * Приоритет: если заданы оба, используется `centerLonLat`, а в консоль
 * выводится предупреждение.
 *
 * Поле `this.projection` содержит код проекции, в метрах которой хранится
 * `this.center`. Он должен совпадать с `KrbMap.options.projection` — иначе
 * карта будет смотреть не туда.
 *
 * @example
 * // Обычный случай: центр в градусах, Web Mercator
 * const view = new View({
 *     centerLonLat: [37.6178, 55.7558],
 *     zoom: 10,
 *     minZoom: 2,
 *     maxZoom: 18,
 *     zoomSensitivity: 0.1,
 *     pitch: 30,
 *     bearing: 45
 * });
 *
 * @example
 * // Готовые world-метры Web Mercator (backward-compat)
 * // (Z север = −Z; для Москвы это [4187596, -7509138])
 * const view = new View({ center: [4187596, -7509138], zoom: 3 });
 *
 * @example
 * // Градусы, но карта в Яндекс-проекции (EPSG:3395)
 * const view = new View({
 *     centerLonLat: [37.6178, 55.7558],
 *     projection: 'EPSG:3395',
 *     zoom: 10
 * });
 */
export class View {
    /**
     * Создаёт представление карты.
     *
     * @param {Object} options - Объект параметров представления.
     * @param {Array.<number>} [options.centerLonLat] - Центр карты в WGS84
     *     [долгота, широта] в градусах. Взаимоисключающий с `options.center`.
     * @param {Array.<number>} [options.center] - Центр карты в **мировых**
     *     метрах проекции `options.projection` — [x, z]. Ось Z направлена
     *     на юг (север = отрицательные Z). Взаимоисключающий с `options.centerLonLat`.
     * @param {string} [options.projection='EPSG:3857'] - Код проекции, в метрах
     *     которой хранится `this.center`. Должен совпадать с `options.projection`,
     *     передаваемым в `KrbMap`. По умолчанию Web Mercator (EPSG:3857) —
     *     именно то, что используют Google Maps, OSM, 2GIS, Mapbox.
     *     Для Яндекс.Карт укажите 'EPSG:3395'.
     * @param {number} options.zoom - Начальный масштаб (в единицах библиотеки).
     * @param {number} [options.minZoom] - Минимальный масштаб.
     * @param {number} [options.maxZoom] - Максимальный масштаб.
     * @param {number} [options.zoomSensitivity] - Чувствительность зума.
     * @param {number} [options.pitch] - Угол наклона камеры в градусах.
     * @param {number} [options.bearing] - Угол поворота камеры в градусах.
     * @throws {Error} Если не задан ни `center`, ни `centerLonLat`.
     * @throws {Error} Если код проекции не зарегистрирован в `Projections`.
     */
    constructor(options) {
        // Резолвим проекцию, в метрах которой задан/будет вычислен центр.
        // По умолчанию — Web Mercator (как и в KrbMap).
        const projectionCode = options.projection ?? 'EPSG:3857';
        const projection = Projections.get(projectionCode);

        /**
         * Код проекции, в метрах которой хранится `this.center`.
         * Должен совпадать с `KrbMap.options.projection`.
         *
         * @type {string}
         */
        this.projection = projectionCode;

        if (options.centerLonLat && options.center) {
            console.warn(
                'View: одновременно заданы centerLonLat и center — ' +
                'приоритет отдан centerLonLat.'
            );
        }

        if (options.centerLonLat) {
            /**
             * Центр карты в WGS84 — [долгота, широта] в градусах.
             * Ровно то, что было передано.
             *
             * @type {Array.<number>}
             */
            this.centerLonLat = options.centerLonLat.slice();

            /**
             * Центр карты в **мировых** метрах проекции `this.projection` — [x, z].
             * Обратите внимание: вторая координата — Z, а не «Y из мира».
             * Север = отрицательные Z (для EPSG:3857/3395).
             *
             * ВАЖНО: `Projection.fromLonLat` возвращает стандартные
             * CRS-координаты (Y направлен на север), а мир карты использует
             * Z-на-юг, поэтому знак Y инвертируется.
             *
             * @type {Array.<number>}
             */
            const [x, y] = projection.fromLonLat(this.centerLonLat);
            this.center = [x, -y];
        } else if (options.center) {
            /**
             * Центр карты в **мировых** метрах проекции `this.projection` — [x, z].
             * Север = отрицательные Z.
             *
             * @type {Array.<number>}
             */
            this.center = options.center.slice();

            /**
             * Обратно вычисленные WGS84-координаты центра — [lon, lat].
             * Удобно для UI/отладки; всегда согласованы с `this.center`.
             * Из world-Z восстанавливаем стандартный CRS-Y (флип знака).
             *
             * @type {Array.<number>}
             */
            this.centerLonLat = projection.toLonLat([this.center[0], -this.center[1]]);
        } else {
            throw new Error(
                'View: options.center или options.centerLonLat обязательны'
            );
        }

        this.zoom = options.zoom;
        this.minZoom = options.minZoom ?? DEFAULTS.MIN_ZOOM;
        this.maxZoom = options.maxZoom ?? DEFAULTS.MAX_ZOOM;
        this.zoomSensitivity = options.zoomSensitivity ?? DEFAULTS.ZOOM_SENSITIVITY;
        this.pitch = options.pitch ?? 0;
        this.bearing = options.bearing ?? 0;
    }
}

/**
 * Основной класс карты, управляющий Three.js сценой, тайлами, камерой и взаимодействием.
 *
 * Карта работает во внутренних метрических координатах выбранной проекции
 * (`options.projection`, по умолчанию EPSG:3857). Внешние объекты (маркеры,
 * полигоны и т. п.) задаются в своей системе координат — по умолчанию WGS84 —
 * и преобразуются в мир карты через {@link KrbMap#project}.
 *
 * ВАЖНО про конвенцию мира:
 *  - Мир карты использует трёхмерную систему координат Three.js: X, Y (высота), Z.
 *  - Ось Z направлена на юг (север = −Z). Это отличается от стандартной
 *    конвенции проекций Меркатора, где Y направлен на север. Флип знака
 *    выполняется автоматически в {@link KrbMap#project} / {@link KrbMap#unproject}.
 *
 * @example
 * const map = new KrbMap({
 *     target: 'map',
 *     layers: [
 *         {
 *             texture: 'https://example.com/tiles/{z}/{x}/{y}.png',
 *             elevation: 'https://example.com/elevation/{z}/{x}/{y}.png',
 *             heightScale: 1.0
 *         }
 *     ],
 *     view: new View({ centerLonLat: [37.6178, 55.7558], zoom: 3 }),
 *     projection: 'EPSG:3857',
 *     inputCRS: 'EPSG:4326',
 *     R: 6378137,
 *     segments: 32,
 *     animDuration: 0.3,
 *     minReliefZ: 0,
 *     maxReliefZ: 15,
 *     tileMargin: 0.1,
 *     tileMarginBg: 0.2,
 *     visibleUpdateThrottle: 100,
 *     maxWorkerRequests: 4,
 *     baseZoom: 0,
 *     baseDistance: 1000000,
 *     objectRenderDistanceFactor: 2,
 *     staticBgZoom: 0,
 *     minCameraHeightOffset: 200
 * });
 * map.setPitch(30, 0.5);
 * map.setBearing(90, 0.5);
 * map.moveCameraTo(37.6173, 55.7558);
 * map.moveCameraToSlow(30.0, 50.0, 1.0, 5);
 * map.rotateToNorth();
 * map.fitToBounds([[37.5, 55.7], [37.7, 55.8]], { padding: 80, duration: 0.6 });
 * map.fitTo(polygon, { padding: 40 });
 * const height = map.getSurfaceHeightAt(1000, 2000);
 * const maxHeight = map.getSurfaceMaxHeight(1000, 2000);
 * const url = map.getTextureUrl(3, 1, 2);
 * map.ensureTileForPoint(1000, 2000);
 */
export class KrbMap {
    /**
     * Создаёт экземпляр карты.
     *
     * @param {Object} options - Объект параметров карты.
     * @param {string} options.target - Идентификатор DOM-элемента для вставки карты.
     * @param {Array.<Object>} options.layers - Массив слоёв карты. Каждый слой может содержать свойства:
     *   texture (URL текстуры), elevation (URL карты высот), heightScale (масштаб высот).
     * @param {View} options.view - Представление карты с параметрами центра, масштаба и углов.
     * @param {string} [options.projection='EPSG:3857'] - Код проекции мира карты.
     *   Определяет систему координат тайлов и метрическое пространство, в котором
     *   отрисовываются все объекты. Для Google/OSM/2GIS — `EPSG:3857`,
     *   для Яндекс.Карт — `EPSG:3395`.
     * @param {string} [options.inputCRS='EPSG:4326'] - Код входной системы координат
     *   по умолчанию. Все методы и объекты, принимающие «географические» координаты
     *   без явного `crs`, интерпретируют их в этой СК.
     * @param {number} [options.R] - Радиус мира (полуось эллипсоида). Должен совпадать
     *   с эллипсоидом проекции; для EPSG:3857 и EPSG:3395 равен 6378137.
     * @param {number} [options.segments] - Количество сегментов сетки рельефа.
     * @param {number} [options.animDuration] - Длительность анимации камеры в секундах.
     * @param {number} [options.minReliefZ] - Минимальный уровень зума для рельефа.
     * @param {number} [options.maxReliefZ] - Максимальный уровень зума для рельефа.
     * @param {number} [options.tileMargin] - Отступ для тайлов.
     * @param {number} [options.tileMarginBg] - Отступ для фоновых тайлов.
     * @param {number} [options.visibleUpdateThrottle] - Минимальный интервал между обновлениями видимых тайлов в мс.
     * @param {number} [options.maxWorkerRequests] - Максимальное количество одновременных запросов к воркерам.
     * @param {number} [options.baseZoom] - Базовый уровень зума для расчёта дистанции.
     * @param {number} [options.baseDistance] - Базовое расстояние камеры при базовом зуме.
     * @param {number} [options.objectRenderDistanceFactor] - Фактор дальности отрисовки объектов.
     * @param {number} [options.staticBgZoom] - Уровень зума для статического фона.
     * @param {number} [options.minCameraHeightOffset] - Минимальный отступ камеры от поверхности.
     * @param {boolean} [options.antialias=true] - Включает сглаживание (антиалиасинг) рендерера.
     * @throws {Error} Если options не передан.
     * @throws {Error} Если целевой элемент не найден.
     * @throws {Error} Если view не передан.
     * @throws {Error} Если проекция не зарегистрирована в Projections.
     */
    constructor(options) {
        if (!options) throw new Error('Map constructor: options object is required');

        this.targetElement = document.getElementById(options.target);
        if (!this.targetElement) throw new Error('Target element not found');
        const tileLayers = options.layers || [];
        this.layers = tileLayers;
        if (!options.view) throw new Error('View required');
        this.globalElevCache = new Map();
        this.view = options.view;
        const hasElevation = options.layers.some(layer => !!layer.elevation);
        this.hasElevation = hasElevation;

        // --- Проекции ---
        // Мир карты задаётся в метрическом пространстве этой проекции.
        // Тайловые URL должны отдавать сетку XYZ именно в этой проекции.
        this.projection = Projections.get(options.projection ?? 'EPSG:3857');
        // Система координат по умолчанию для «географических» входных данных.
        this.inputCRS = options.inputCRS
            ? Projections.get(options.inputCRS)
            : Projections.get('EPSG:4326');

        // Предупреждение о рассогласовании проекций View и Map.
        if (this.view.projection && this.view.projection !== this.projection.code) {
            console.warn(
                `KrbMap: view.projection (${this.view.projection}) не совпадает ` +
                `с map.projection (${this.projection.code}). ` +
                `Камера может смотреть не туда.`
            );
        }

        this.R = options.R ?? DEFAULTS.R;
        this.WORLD_SIZE = 2 * Math.PI * this.R;
        this.MAX_MERCATOR = this.WORLD_SIZE / 2;
        this.TILE_PIXELS = 256;
        this.SEGMENTS = options.segments ?? DEFAULTS.SEGMENTS;
        this.ANIM_DURATION = options.animDuration ?? DEFAULTS.ANIM_DURATION;
        this.MIN_ZOOM = this.view.minZoom;
        this.MAX_ZOOM = this.view.maxZoom;
        this.ZOOM_SENSITIVITY = this.view.zoomSensitivity;
        this.MIN_RELIEF_Z = options.minReliefZ ?? DEFAULTS.MIN_RELIEF_Z;
        this.MAX_RELIEF_Z = options.maxReliefZ ?? DEFAULTS.MAX_RELIEF_Z;
        this.TILE_MARGIN = options.tileMargin ?? DEFAULTS.TILE_MARGIN;
        this.TILE_MARGIN_BG = options.tileMarginBg ?? DEFAULTS.TILE_MARGIN_BG;
        this.VISIBLE_UPDATE_THROTTLE = options.visibleUpdateThrottle ?? DEFAULTS.VISIBLE_UPDATE_THROTTLE;
        this.MAX_WORKER_REQUESTS = options.maxWorkerRequests ?? DEFAULTS.MAX_WORKER_REQUESTS;
        this.BASE_ZOOM = options.baseZoom ?? DEFAULTS.BASE_ZOOM;
        this.BASE_DISTANCE = options.baseDistance ?? DEFAULTS.BASE_DISTANCE;
        this.objectRenderDistanceFactor = options.objectRenderDistanceFactor ?? DEFAULTS.OBJECT_RENDER_DISTANCE_FACTOR;
        this.staticBgZoom = options.staticBgZoom ?? DEFAULTS.STATIC_BG_ZOOM;
        this.antialias = options.antialias ?? true;

        const elevLayer = this.layers.find(l => l.elevation);
        const effectiveHeightScale = elevLayer ? elevLayer.heightScale : DEFAULTS.HEIGHT_SCALE;
        this.effectiveHeightScale = effectiveHeightScale;
        this.MIN_CAMERA_HEIGHT_OFFSET = options.minCameraHeightOffset ?? (200 * effectiveHeightScale);

        this.continuousZoom = this.view.zoom;
        this.targetContinuousZoom = this.view.zoom;
        this.currentDiscreteZoom = this.view.zoom;

        this.initThree();
        this.initControls();
        this.initDragTools();
        this.touchDragActive = false;
        this.touchDragLocalPoint = new THREE.Vector3();
        this.touchMouse = new THREE.Vector2();
        this.initTouchState();

        // --- Временные объекты для уменьшения аллокаций ---
        this._tempVec3a = new THREE.Vector3();
        this._tempVec3b = new THREE.Vector3();
        this._tempVec3c = new THREE.Vector3();
        this._tempDir = new THREE.Vector3();
        this._tempTarget = new THREE.Vector3();
        this._tempRaycaster = new THREE.Raycaster();
        this._tempMouse = new THREE.Vector2();
        // --------------------------------------------------

        const [cx, cz] = this.view.center;
        const initialZoom = this.view.zoom;
        const initialPitchRad = (this.view.pitch ?? 0) * Math.PI / 180;
        const initialBearingRad = (this.view.bearing ?? 0) * Math.PI / 180;

        this.controls.target.set(cx, 0, cz);
        const dist = this.getTargetDistanceForZoom(initialZoom);

        const sinP = Math.sin(initialPitchRad);
        const cosP = Math.cos(initialPitchRad);
        this.camera.position.set(
            cx - dist * sinP * Math.sin(initialBearingRad),
            dist * cosP,
            cz + dist * sinP * Math.cos(initialBearingRad)
        );
        this.controls.update();

        this.worldGroup = new THREE.Group();
        this.worldGroup.position.set(0, 0, 0);
        this.scene.add(this.worldGroup);
        this._cameraAnimation = null;
        this._cameraAnimations = { pitch: null, bearing: null };
        this._cameraAnimFrame = null;
        this._controlsDampingWasEnabled = true;
        this._dynamicLayers = [];
        this.textManager = new TextManager(this);
        this.popupManager = new PopupManager(this);

        this.tileManager = new TileManager(this);

        // Кэш максимальной высоты поверхности (LRU, ограничен по размеру)
        this._surfaceMaxHeightCache = new Map();
        this._surfaceMaxHeightCacheMaxSize = 500;
        this.tileManager.onTileHeightAppliedCallbacks.push(() => {
            this._surfaceMaxHeightCache.clear();
        });

        this.staticBgGroup = new THREE.Group();
        this.worldGroup.add(this.staticBgGroup);
        if (this.layers.length && this.layers.some(layer => layer.texture)) {
            this.createStaticBackgroundLayer();
        }

        this.lastVisibleUpdateTime = 0;
        this._lastWrapCheck = 0;
        this.clock = new THREE.Clock();

        this.bindEvents();
        this.maybeUpdateVisibleTiles(true);

        this.animate();
        requestAnimationFrame(() => initUI(this));
    }

    /**
     * Инициализирует Three.js сцену, камеру, рендерер и освещение.
     *
     * @private
     */
    initThree() {
        this.scene = new THREE.Scene();
        this.scene.background = new THREE.Color(0xffffff);
        this.camera = new THREE.PerspectiveCamera(
            45,
            this.targetElement.clientWidth / this.targetElement.clientHeight,
            1,
            200000000
        );
        this.renderer = new THREE.WebGLRenderer({ antialias: this.antialias, powerPreference: 'high-performance' });
        this.renderer.setSize(this.targetElement.clientWidth, this.targetElement.clientHeight);
        this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
        this.targetElement.appendChild(this.renderer.domElement);

        this.ambientLight = new THREE.AmbientLight(0xffffff, 0.8);
        this.scene.add(this.ambientLight);

        this.sunLight = new THREE.DirectionalLight(0xffffff, 3);
        this.sunLight.position.set(1, 2, 3);
        this.scene.add(this.sunLight);
    }

    /* ================================================================
       Управление освещением (публичные методы)
       ================================================================ */

    /**
     * Устанавливает параметры окружающего (ambient) света.
     *
     * @param {number|string} color - Цвет света в формате числа (0xffffff) или CSS-строки.
     * @param {number} [intensity] - Интенсивность света (по умолчанию 0.8).
     * @returns {void}
     *
     * @example
     * map.setAmbientLight(0x404040, 0.5);
     */
    setAmbientLight(color, intensity = 0.8) {
        if (!this.ambientLight) {
            console.warn('Ambient light is not initialized.');
            return;
        }
        this.ambientLight.color.set(color);
        this.ambientLight.intensity = intensity;
    }

    /**
     * Устанавливает параметры направленного солнечного света.
     *
     * @param {number|string} color - Цвет света.
     * @param {number} [intensity] - Интенсивность света (по умолчанию 1.3).
     * @param {THREE.Vector3|{x:number, y:number, z:number}|Array<number>} [position] - Позиция источника света (направление).
     * @returns {void}
     *
     * @example
     * map.setSunLight(0xffeedd, 1.5, { x: 1, y: -1, z: 1 });
     */
    setSunLight(color, intensity = 1.3, position = null) {
        if (!this.sunLight) {
            console.warn('Directional (sun) light is not initialized.');
            return;
        }
        this.sunLight.color.set(color);
        this.sunLight.intensity = intensity;
        if (position) {
            if (position instanceof THREE.Vector3) {
                this.sunLight.position.copy(position);
            } else if (Array.isArray(position) && position.length >= 3) {
                this.sunLight.position.set(position[0], position[1], position[2]);
            } else if (typeof position === 'object' && 'x' in position && 'y' in position && 'z' in position) {
                this.sunLight.position.set(position.x, position.y, position.z);
            } else {
                console.warn('Invalid position argument for setSunLight.');
            }
        }
    }

    /**
     * Устанавливает оба источника света одновременно.
     *
     * @param {Object} params - Параметры освещения.
     * @param {number|string} [params.ambientColor] - Цвет окружающего света.
     * @param {number} [params.ambientIntensity] - Интенсивность окружающего света.
     * @param {number|string} [params.sunColor] - Цвет солнечного света.
     * @param {number} [params.sunIntensity] - Интенсивность солнечного света.
     * @param {THREE.Vector3|{x:number, y:number, z:number}|Array<number>} [params.sunPosition] - Позиция солнечного света.
     * @returns {void}
     *
     * @example
     * map.setLighting({
     *     ambientColor: 0xffffff,
     *     ambientIntensity: 0.6,
     *     sunColor: 0xfff5e6,
     *     sunIntensity: 1.2,
     *     sunPosition: [1, -1, 1]
     * });
     */
    setLighting({
        ambientColor,
        ambientIntensity,
        sunColor,
        sunIntensity,
        sunPosition
    } = {}) {
        if (ambientColor !== undefined) {
            this.setAmbientLight(ambientColor, ambientIntensity);
        } else if (ambientIntensity !== undefined) {
            this.setAmbientLight(this.ambientLight ? this.ambientLight.color.getHex() : 0xffffff, ambientIntensity);
        }

        if (sunColor !== undefined) {
            this.setSunLight(sunColor, sunIntensity, sunPosition);
        } else {
            if (sunIntensity !== undefined) {
                this.setSunLight(this.sunLight ? this.sunLight.color.getHex() : 0xffffff, sunIntensity, sunPosition);
            } else if (sunPosition !== undefined) {
                this.setSunLight(this.sunLight ? this.sunLight.color.getHex() : 0xffffff, this.sunLight ? this.sunLight.intensity : 1.3, sunPosition);
            }
        }
    }

    /**
     * Возвращает объект окружающего света для прямого доступа.
     *
     * @returns {THREE.AmbientLight|null} Объект ambient-света или null, если не создан.
     */
    getAmbientLight() {
        return this.ambientLight || null;
    }

    /**
     * Возвращает объект направленного солнечного света для прямого доступа.
     *
     * @returns {THREE.DirectionalLight|null} Объект directional-света или null, если не создан.
     */
    getSunLight() {
        return this.sunLight || null;
    }

    /* ================================================================
       Проекции: преобразование координат
       ================================================================ */

    /**
     * Преобразует координаты из внешней системы координат во внутренние
     * мировые координаты карты (метры проекции `this.projection`).
     *
     * Возвращаемые координаты — в «мировой» конвенции KrbMap: ось Z
     * направлена на юг (север = −Z). Входные координаты — в стандартной
     * конвенции CRS (для EPSG:3857/3395 Y направлен на север); знак Y
     * автоматически инвертируется.
     *
     * @param {Array.<number>} coord - Координаты [x, y] в СК `fromCrs`.
     * @param {Projection|string} [fromCrs=this.inputCRS] - Проекция входных данных
     *     (объект Projection или код вроде 'EPSG:4326').
     * @returns {Array.<number>} Мировые координаты [x, z] (север = −Z).
     *
     * @example
     * const [x, z] = map.project([37.6173, 55.7558]);           // WGS84 → мир
     * const [x2, z2] = map.project([1000, 2000], 'EPSG:32637'); // UTM → мир
     */
    project(coord, fromCrs = this.inputCRS) {
        const src = typeof fromCrs === 'string' ? Projections.get(fromCrs) : fromCrs;
        if (src === this.projection) {
            // Пользователь дал координаты в стандартной CRS проекции карты —
            // остаётся только перевернуть Y (север) в world-Z (юг).
            return [coord[0], -coord[1]];
        }
        // Через WGS84: src → lon/lat → this.projection → world.
        const lonLat = src.toLonLat(coord);
        const [x, y] = this.projection.fromLonLat(lonLat);
        return [x, -y];
    }

    /**
     * Преобразует мировые координаты карты во внешнюю систему координат.
     *
     * Входные `worldCoord` — в «мировой» конвенции (север = −Z).
     * Возвращаемые — в стандартной конвенции CRS (Y направлен на север).
     *
     * @param {Array.<number>} worldCoord - Мировые координаты [x, z].
     * @param {Projection|string} [toCrs=this.inputCRS] - Целевая проекция.
     * @returns {Array.<number>} Координаты [x, y] в целевой СК.
     *
     * @example
     * const lonLat = map.unproject([x, z]);                  // мир → WGS84
     * const utm    = map.unproject([x, z], 'EPSG:32637');    // мир → UTM
     */
    unproject(worldCoord, toCrs = this.inputCRS) {
        const dst = typeof toCrs === 'string' ? Projections.get(toCrs) : toCrs;
        // [x, world-Z] → [x, CRS-Y] (флип знака).
        const std = [worldCoord[0], -worldCoord[1]];
        if (dst === this.projection) return std;
        const lonLat = this.projection.toLonLat(std);
        return dst.fromLonLat(lonLat);
    }

    /**
     * Шорткат: пара (lon, lat) в WGS84 → мировые координаты карты.
     *
     * @param {number} lon - Долгота в градусах.
     * @param {number} lat - Широта в градусах.
     * @returns {Array.<number>} Мировые координаты [x, z] (север = −Z).
     */
    projectLonLat(lon, lat) {
        const [x, y] = this.projection.fromLonLat([lon, lat]);
        return [x, -y];
    }

    /**
     * Шорткат: мировые координаты карты → пара (lon, lat) в WGS84.
     *
     * @param {number} x - Мировая координата X.
     * @param {number} z - Мировая координата Z (север = −Z).
     * @returns {Array.<number>} [долгота, широта] в градусах.
     */
    unprojectToLonLat(x, z) {
        return this.projection.toLonLat([x, -z]);
    }

    /**
     * Возвращает true, если текущая проекция — цилиндрическая Меркатора
     * (или близкая к ней). Такие проекции обладают циклической долготой,
     * и для них имеет смысл «перескок» через антимеридиан.
     *
     * @private
     * @returns {boolean}
     */
    _wrapsLongitude() {
        const def = this.projection.def || '';
        // +proj=merc — все разновидности Меркатора (3857, 3395, ...).
        // +proj=longlat — географическая (используется редко, но тоже циклична).
        return /\+proj=merc\b/.test(def) || /\+proj=longlat\b/.test(def);
    }

    /* ================================================================
       Остальные методы (камера, тайлы, взаимодействие)
       ================================================================ */

    /**
     * Инициализирует и настраивает управление камерой.
     *
     * @private
     */
    initControls() {
        this.controls = new OrbitControls(this.camera, this.renderer.domElement);
        this.controls.enableZoom = true;
        this.controls.enablePan = false;
        this.controls.mouseButtons = {
            LEFT: THREE.MOUSE.PAN,
            MIDDLE: THREE.MOUSE.DOLLY,
            RIGHT: THREE.MOUSE.ROTATE
        };
        this.controls.touches = {
            ONE: THREE.TOUCH.PAN,
            TWO: THREE.TOUCH.MAP_CONTROLS
        };
        this.controls.maxPolarAngle = (85 * Math.PI) / 180;
        this.controls.minPolarAngle = 0.001;
        this.controls.enableDamping = true;
        this.controls.dampingFactor = 0.6;
        this.controls.rotateSpeed = 1;
        this.renderer.domElement.removeEventListener('wheel', this.controls.onMouseWheel);
    }

    /**
     * Инициализирует инструменты перетаскивания мира.
     *
     * @private
     */
    initDragTools() {
        this.groundPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
        this.raycasterDragger = new THREE.Raycaster();
        this.mouse = new THREE.Vector2();
        this.intersection = new THREE.Vector3();
        this.isDragging = false;
        this.dragLocalPoint = new THREE.Vector3();

        // Состояние для отсечения клика от драга.
        this._mouseDownX = 0;
        this._mouseDownY = 0;
        this._mouseMoved = false;
    }

    /**
     * Инициализирует состояние для обработки касаний.
     *
     * @private
     */
    initTouchState() {
        this.touchState = {
            isPinching: false,
            startDist: 0,
            startZoom: 0,
            accumulatedLineAngle: 0,
            id0: null,
            id1: null
        };
    }

    /* ================================================================
       Утилиты камеры и URL
       ================================================================ */

    /**
     * Устанавливает наклон камеры с анимацией.
     *
     * @param {number} pitchDeg - Угол наклона в градусах.
     * @param {number} [duration] - Длительность анимации в секундах.
     * @returns {void}
     */
    setPitch(pitchDeg, duration = 0.3) {
        const pitchRad = pitchDeg * Math.PI / 180;
        const maxPolarRad = this.controls.maxPolarAngle;
        const clampedRad = Math.max(0.001, Math.min(pitchRad, maxPolarRad));

        const target = this._tempVec3a.copy(this.controls.target);
        const currentPos = this._tempVec3b.copy(this.camera.position);
        const dir = this._tempDir.subVectors(currentPos, target);
        const currentDistance = dir.length();
        if (currentDistance < 1) return;

        const currentPitchRad = Math.acos(dir.y / currentDistance);

        this._cameraAnimations.pitch = {
            start: currentPitchRad,
            end: clampedRad,
            startTime: performance.now(),
            duration
        };

        this._startCameraAnimationLoopIfNeeded();
    }

    /**
     * Устанавливает поворот камеры с анимацией.
     *
     * @param {number} bearingDeg - Угол поворота в градусах.
     * @param {number} [duration] - Длительность анимации в секундах.
     * @returns {void}
     */
    setBearing(bearingDeg, duration = 0.3) {
        const bearingRad = bearingDeg * Math.PI / 180;
        const target = this._tempVec3a.copy(this.controls.target);
        const currentPos = this._tempVec3b.copy(this.camera.position);
        const dir = this._tempDir.subVectors(currentPos, target);
        const currentDistance = dir.length();
        if (currentDistance < 1) return;

        const currentAzimuth = Math.atan2(-dir.x, dir.z);
        let delta = bearingRad - currentAzimuth;
        while (delta > Math.PI) delta -= 2 * Math.PI;
        while (delta < -Math.PI) delta += 2 * Math.PI;
        const endAzimuth = currentAzimuth + delta;

        this._cameraAnimations.bearing = {
            start: currentAzimuth,
            end: endAzimuth,
            startTime: performance.now(),
            duration
        };

        this._startCameraAnimationLoopIfNeeded();
    }

    /**
     * Запускает общий цикл анимации для плавного изменения pitch/bearing.
     *
     * @private
     */
    _startCameraAnimationLoopIfNeeded() {
        if (this._cameraAnimation || this._cameraAnimFrame) return;

        this._cameraAnimation = { custom: true };
        this._controlsDampingWasEnabled = this.controls.enableDamping;
        this.controls.enableDamping = false;

        const animateStep = (now) => {
            let anyActive = false;
            const target = this._tempVec3a.copy(this.controls.target);
            const currentPos = this._tempVec3b.copy(this.camera.position);
            const dir = this._tempDir.subVectors(currentPos, target);
            let currentDistance = dir.length();
            if (currentDistance < 1) {
                this._cameraAnimation = null;
                this._cameraAnimFrame = null;
                this.controls.enableDamping = this._controlsDampingWasEnabled;
                return;
            }

            let currentPitch = Math.acos(dir.y / currentDistance);
            let currentAzimuth = Math.atan2(-dir.x, dir.z);

            if (this._cameraAnimations.pitch) {
                const anim = this._cameraAnimations.pitch;
                let t = (now - anim.startTime) / (anim.duration * 1000);
                t = Math.min(t, 1.0);
                const eased = t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
                currentPitch = anim.start + (anim.end - anim.start) * eased;
                if (t >= 1.0) this._cameraAnimations.pitch = null;
                else anyActive = true;
            }

            if (this._cameraAnimations.bearing) {
                const anim = this._cameraAnimations.bearing;
                let t = (now - anim.startTime) / (anim.duration * 1000);
                t = Math.min(t, 1.0);
                const eased = t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
                currentAzimuth = anim.start + (anim.end - anim.start) * eased;
                if (t >= 1.0) this._cameraAnimations.bearing = null;
                else anyActive = true;
            }

            const sinP = Math.sin(currentPitch);
            const cosP = Math.cos(currentPitch);
            this.camera.position.set(
                target.x - currentDistance * sinP * Math.sin(currentAzimuth),
                target.y + currentDistance * cosP,
                target.z + currentDistance * sinP * Math.cos(currentAzimuth)
            );
            this.controls.target.copy(target);
            this.controls.update();

            this.maybeUpdateVisibleTiles();

            if (!anyActive) {
                this._cameraAnimation = null;
                this._cameraAnimFrame = null;
                this.controls.enableDamping = this._controlsDampingWasEnabled;
                this.controls.target.copy(target);
                this.controls.update();
                this.maybeUpdateVisibleTiles(true);
                return;
            }

            this._cameraAnimFrame = requestAnimationFrame(animateStep);
        };

        this._cameraAnimFrame = requestAnimationFrame(animateStep);
    }

    /**
     * Сбрасывает поворот камеры к северу.
     *
     * @returns {void}
     */
    resetBearing() {
        this.rotateToNorth(0.3);
    }

    /**
     * Рассчитывает дистанцию камеры до цели для заданного уровня зума.
     *
     * @param {number} z - Уровень зума.
     * @returns {number} Дистанция в мировых единицах.
     */
    getTargetDistanceForZoom(z) {
        return this.BASE_DISTANCE * Math.pow(0.5, z - this.BASE_ZOOM);
    }

    /**
     * Возвращает URL текстуры для тайла по координатам.
     *
     * @param {number} z - Уровень зума.
     * @param {number} x - Координата X тайла.
     * @param {number} y - Координата Y тайла.
     * @returns {string|null} URL текстуры или null, если слой не задан.
     */
    getTextureUrl(z, x, y) {
        if (!this.layers[0] || !this.layers[0].texture) return null;
        return this.layers[0].texture.replace(/\{z\}/g, z).replace(/\{x\}/g, x).replace(/\{y\}/g, y);
    }

    /**
     * Возвращает URL карты высот для тайла.
     *
     * @param {number} z - Уровень зума.
     * @param {number} x - Координата X тайла.
     * @param {number} y - Координата Y тайла.
     * @returns {string|null} URL карты высот или null, если слой не задан.
     */
    getElevationUrl(z, x, y) {
        if (!this.layers[0] || !this.layers[0].elevation) return null;
        return this.layers[0].elevation.replace(/\{z\}/g, z).replace(/\{x\}/g, x).replace(/\{y\}/g, y);
    }

    /**
     * Возвращает максимальное расстояние для отрисовки объектов.
     *
     * @returns {number} Максимальное расстояние или Infinity, если фактор не задан.
     */
    get maxObjectDistance() {
        if (!this.objectRenderDistanceFactor) return Infinity;
        const distToTarget = this.camera.position.distanceTo(this.controls.target);
        return distToTarget * this.objectRenderDistanceFactor;
    }

    /**
     * Записывает значение в LRU-кэш максимальной высоты поверхности.
     *
     * @private
     * @param {string} key - Ключ тайла.
     * @param {number} value - Максимальная высота.
     */
    _setSurfaceMaxHeight(key, value) {
        // Перезапись перемещает ключ в конец (как «свежий»).
        this._surfaceMaxHeightCache.delete(key);
        this._surfaceMaxHeightCache.set(key, value);
        while (this._surfaceMaxHeightCache.size > this._surfaceMaxHeightCacheMaxSize) {
            const oldestKey = this._surfaceMaxHeightCache.keys().next().value;
            this._surfaceMaxHeightCache.delete(oldestKey);
        }
    }

    /**
     * Возвращает максимальную высоту поверхности в заданной мировой точке.
     * Использует кэш; инвалидация происходит при применении новых высот.
     *
     * @param {number} worldX - Мировая координата X.
     * @param {number} worldZ - Мировая координата Z.
     * @returns {number} Максимальная высота поверхности.
     */
    getSurfaceMaxHeight(worldX, worldZ) {
        if (!this.hasElevation) return 0;
        const z = this.currentDiscreteZoom;
        const tileSize = this.WORLD_SIZE / Math.pow(2, z);
        const maxTile = (1 << z) - 1;
        const localX = worldX - this.worldGroup.position.x;
        const localZ = worldZ - this.worldGroup.position.z;
        const virtX = Math.floor((localX + this.MAX_MERCATOR) / tileSize);
        const y = Math.floor((localZ + this.MAX_MERCATOR) / tileSize);
        if (y < 0 || y > maxTile) return 0;
        const vk = getVirtKey(z, virtX, y);

        if (this._surfaceMaxHeightCache.has(vk)) {
            return this._surfaceMaxHeightCache.get(vk);
        }

        const inst = this.tileManager.tiles.get(vk);
        let maxY = 0;
        if (inst && inst.heightsApplied && inst.mesh) {
            const pos = inst.geometry.attributes.position.array;
            maxY = -Infinity;
            for (let i = 1; i < pos.length; i += 3) {
                if (pos[i] > maxY) maxY = pos[i];
            }
            maxY += inst.mesh.position.y;
        }
        this._setSurfaceMaxHeight(vk, maxY);
        return maxY;
    }

    /**
     * Возвращает интерполированную высоту поверхности в заданной мировой точке.
     *
     * @param {number} worldX - Мировая координата X.
     * @param {number} worldZ - Мировая координата Z.
     * @returns {number} Высота поверхности.
     */
    getSurfaceHeightAt(worldX, worldZ) {
        if (!this.hasElevation) return 0;
        const z = this.currentDiscreteZoom;
        const tileSize = this.WORLD_SIZE / Math.pow(2, z);
        const maxTile = (1 << z) - 1;
        const localX = worldX - this.worldGroup.position.x;
        const localZ = worldZ - this.worldGroup.position.z;
        const virtX = Math.floor((localX + this.MAX_MERCATOR) / tileSize);
        const y = Math.floor((localZ + this.MAX_MERCATOR) / tileSize);
        if (y < 0 || y > maxTile) return 0;
        const vk = getVirtKey(z, virtX, y);
        const inst = this.tileManager.tiles.get(vk);
        if (!inst || !inst.heightsApplied || !inst.mesh) return 0;

        const originX = virtX * tileSize - this.MAX_MERCATOR;
        const originZ = getOriginZ(y, tileSize, this.MAX_MERCATOR);
        const u = (localX - originX) / tileSize;
        const v = (localZ - originZ) / tileSize;

        const seg = this.SEGMENTS;
        const pos = inst.geometry.attributes.position.array;
        const col = Math.min(seg, Math.max(0, Math.floor(u * seg)));
        const row = Math.min(seg, Math.max(0, Math.floor(v * seg)));
        const nextCol = Math.min(seg, col + 1);
        const nextRow = Math.min(seg, row + 1);

        const idx = (row * (seg + 1) + col) * 3;
        const h00 = pos[idx + 1];
        const h10 = pos[(row * (seg + 1) + nextCol) * 3 + 1];
        const h01 = pos[(nextRow * (seg + 1) + col) * 3 + 1];
        const h11 = pos[(nextRow * (seg + 1) + nextCol) * 3 + 1];

        const fu = (u * seg) - col;
        const fv = (v * seg) - row;
        const h0 = h00 + (h10 - h00) * fu;
        const h1 = h01 + (h11 - h01) * fu;
        return h0 + (h1 - h0) * fv + inst.mesh.position.y;
    }

    /**
     * Обеспечивает загрузку тайла для заданной мировой точки.
     *
     * @param {number} worldX - Мировая координата X.
     * @param {number} worldZ - Мировая координата Z.
     * @returns {void}
     */
    ensureTileForPoint(worldX, worldZ) {
        const z = this.currentDiscreteZoom;
        const tileSize = this.WORLD_SIZE / Math.pow(2, z);
        const maxTile = (1 << z) - 1;
        const localX = worldX - this.worldGroup.position.x;
        const localZ = worldZ - this.worldGroup.position.z;
        const virtX = Math.floor((localX + this.MAX_MERCATOR) / tileSize);
        const y = Math.floor((localZ + this.MAX_MERCATOR) / tileSize);
        if (y < 0 || y > maxTile) return;
        this.tileManager.ensureTile(z, virtX, y);
    }

    /**
     * Создаёт статический фоновый слой из текстурных тайлов.
     *
     * @returns {void}
     */
    createStaticBackgroundLayer() {
        if (!this.layers.length || !this.layers.some(l => l.texture)) return;
        while (this.staticBgGroup.children.length > 0) {
            const child = this.staticBgGroup.children[0];
            this.staticBgGroup.remove(child);
            if (child.geometry) child.geometry.dispose();
            if (child.material) {
                if (child.material.map) child.material.map.dispose();
                child.material.dispose();
            }
        }

        const z = this.staticBgZoom;
        const tileSize = this.WORLD_SIZE / Math.pow(2, z);
        const maxTile = (1 << z) - 1;

        for (let y = 0; y <= maxTile; y++) {
            const originZ = getOriginZ(y, tileSize, this.MAX_MERCATOR);
            for (let x = 0; x <= maxTile; x++) {
                const originX = x * tileSize - this.MAX_MERCATOR;
                const texUrl = this.getTextureUrl(z, x, y);

                const mesh = this.tileManager.createStaticTileMesh(tileSize, originX, originZ, null);
                this.staticBgGroup.add(mesh);

                this.tileManager.loadTextureAsync(texUrl).then(tex => {
                    if (tex && mesh.parent === this.staticBgGroup) {
                        mesh.material.map = tex;
                        mesh.material.needsUpdate = true;
                    }
                }).catch(() => {});
            }
        }
    }

    /* ================================================================
       Перемещение мира и синхронизация контролов
       ================================================================ */

    /**
     * Сдвигает мировую группу на заданные смещения.
     *
     * @param {number} dx - Смещение по X.
     * @param {number} dz - Смещение по Z.
     * @returns {void}
     */
    shiftWorld(dx, dz) {
        this.worldGroup.position.x -= dx;
        this.worldGroup.position.z -= dz;
    }

    /**
     * Синхронизирует цель контролов с точкой пересечения луча из центра экрана с плоскостью земли.
     *
     * @returns {void}
     */
    syncControlsTarget() {
        this._tempMouse.set(0, 0);
        this._tempRaycaster.setFromCamera(this._tempMouse, this.camera);
        if (this._tempRaycaster.ray.intersectPlane(this.groundPlane, this._tempVec3a)) {
            this.controls.target.copy(this._tempVec3a);
            this.controls.update();
        }
    }

    /* ================================================================
       Ввод: мышь, колёсико, касания
       ================================================================ */

    /**
     * Обрабатывает нажатие кнопки мыши.
     *
     * @param {MouseEvent} e - Событие мыши.
     * @returns {void}
     */
    onMouseDown(e) {
        if (this._cameraAnimation) return;
        if (e.button !== 0) return;

        this._mouseDownX = e.clientX;
        this._mouseDownY = e.clientY;
        this._mouseMoved = false;

        const rect = this.renderer.domElement.getBoundingClientRect();
        this.mouse.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
        this.mouse.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
        this.raycasterDragger.setFromCamera(this.mouse, this.camera);
        if (this.raycasterDragger.ray.intersectPlane(this.groundPlane, this.intersection)) {
            this.isDragging = true;
            this.dragLocalPoint.copy(this.intersection).sub(this.worldGroup.position);
        }
    }

    /**
     * Обрабатывает перемещение мыши.
     *
     * @param {MouseEvent} e - Событие мыши.
     * @returns {void}
     */
    onMouseMove(e) {
        if (this._cameraAnimation) return;

        // Отслеживание факта сдвига для отсечения клика от драга.
        if (!this._mouseMoved) {
            const dx = e.clientX - this._mouseDownX;
            const dy = e.clientY - this._mouseDownY;
            if (dx * dx + dy * dy > 9) { // порог ~3px
                this._mouseMoved = true;
            }
        }

        if (!this.isDragging) return;
        const rect = this.renderer.domElement.getBoundingClientRect();
        this.mouse.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
        this.mouse.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
        this.raycasterDragger.setFromCamera(this.mouse, this.camera);
        if (this.raycasterDragger.ray.intersectPlane(this.groundPlane, this.intersection)) {
            this.worldGroup.position.copy(this.intersection).sub(this.dragLocalPoint);
            this.maybeUpdateVisibleTiles();
        }
    }

    /**
     * Обрабатывает отпускание кнопки мыши.
     *
     * @returns {void}
     */
    onMouseUp() {
        if (this._cameraAnimation) return;
        if (!this.isDragging) return;
        this.isDragging = false;
        this.syncControlsTarget();
    }

    /**
     * Обрабатывает прокрутку колеса мыши.
     *
     * @param {WheelEvent} e - Событие колеса.
     * @returns {void}
     */
    onWheel(e) {
        if (this._cameraAnimation) return;
        e.preventDefault();
        const delta = -Math.sign(e.deltaY) * this.ZOOM_SENSITIVITY;
        this.applyZoomDelta(delta);
    }

    /**
     * Вычисляет расстояние между двумя касаниями.
     *
     * @param {TouchList} touches - Список касаний.
     * @returns {number} Расстояние в пикселях.
     */
    getTouchDistance(touches) {
        const dx = touches[0].clientX - touches[1].clientX;
        const dy = touches[0].clientY - touches[1].clientY;
        return Math.sqrt(dx * dx + dy * dy);
    }

    /**
     * Обрабатывает начало касания.
     *
     * @param {TouchEvent} e - Событие касания.
     * @returns {void}
     */
    onTouchStart(e) {
        if (this._cameraAnimation) return;
        if (e.touches.length === 1) {
            const rect = this.renderer.domElement.getBoundingClientRect();
            const touch = e.touches[0];
            this.touchMouse.x = ((touch.clientX - rect.left) / rect.width) * 2 - 1;
            this.touchMouse.y = -((touch.clientY - rect.top) / rect.height) * 2 + 1;
            this.raycasterDragger.setFromCamera(this.touchMouse, this.camera);
            if (this.raycasterDragger.ray.intersectPlane(this.groundPlane, this.intersection)) {
                this.touchDragActive = true;
                this.touchDragLocalPoint.copy(this.intersection).sub(this.worldGroup.position);
            }
            this.touchState.isPinching = false;
        } else if (e.touches.length === 2) {
            e.preventDefault();
            if (this.touchDragActive) {
                this.touchDragActive = false;
                this.syncControlsTarget();
            }
            this.touchState.isPinching = true;
            this.touchState.startDist = this.getTouchDistance(e.touches);
            this.touchState.startZoom = this.targetContinuousZoom;
            this.touchState.id0 = e.touches[0].identifier;
            this.touchState.id1 = e.touches[1].identifier;
            const dx = e.touches[0].clientX - e.touches[1].clientX;
            const dy = e.touches[0].clientY - e.touches[1].clientY;
            this.touchState.accumulatedLineAngle = Math.atan2(dy, dx);
        }
    }

    /**
     * Находит касание по идентификатору.
     *
     * @param {TouchList} touches - Список касаний.
     * @param {number} id - Идентификатор касания.
     * @returns {Touch|null} Найденное касание или null.
     */
    findTouchById(touches, id) {
        for (let i = 0; i < touches.length; i++) {
            if (touches[i].identifier === id) return touches[i];
        }
        return null;
    }

    /**
     * Обрабатывает перемещение касания.
     *
     * @param {TouchEvent} e - Событие касания.
     * @returns {void}
     */
    onTouchMove(e) {
        if (this._cameraAnimation) return;
        if (this.touchDragActive && e.touches.length === 1) {
            e.preventDefault();
            const rect = this.renderer.domElement.getBoundingClientRect();
            const touch = e.touches[0];
            this.touchMouse.x = ((touch.clientX - rect.left) / rect.width) * 2 - 1;
            this.touchMouse.y = -((touch.clientY - rect.top) / rect.height) * 2 + 1;
            this.raycasterDragger.setFromCamera(this.touchMouse, this.camera);
            if (this.raycasterDragger.ray.intersectPlane(this.groundPlane, this.intersection)) {
                this.worldGroup.position.copy(this.intersection).sub(this.touchDragLocalPoint);
                this.maybeUpdateVisibleTiles();
            }
        } else if (this.touchState.isPinching && e.touches.length === 2) {
            e.preventDefault();
            const t0 = this.findTouchById(e.touches, this.touchState.id0);
            const t1 = this.findTouchById(e.touches, this.touchState.id1);
            if (!t0 || !t1) return;
            const currentDist = Math.hypot(t0.clientX - t1.clientX, t0.clientY - t1.clientY);
            const scale = currentDist / this.touchState.startDist;
            const zoomDelta = Math.log2(scale) * 6 * this.ZOOM_SENSITIVITY;
            this.targetContinuousZoom = Math.max(
                this.MIN_ZOOM,
                Math.min(this.MAX_ZOOM, this.touchState.startZoom + zoomDelta)
            );
            this.controls.update();
            this.maybeUpdateVisibleTiles();
        }
    }

    /**
     * Обрабатывает окончание касания.
     *
     * @param {TouchEvent} e - Событие касания.
     * @returns {void}
     */
    onTouchEnd(e) {
        if (this._cameraAnimation) return;
        if (e.touches.length < 2) this.touchState.isPinching = false;
        if (e.touches.length === 0 && this.touchDragActive) {
            this.touchDragActive = false;
            this.syncControlsTarget();
        }
    }

    /**
     * Обрабатывает изменение размера элемента.
     *
     * @returns {void}
     */
    onResize() {
        const w = this.targetElement.clientWidth;
        const h = this.targetElement.clientHeight;
        this.camera.aspect = w / h;
        this.camera.updateProjectionMatrix();
        this.renderer.setSize(w, h);
        this.maybeUpdateVisibleTiles();
    }

    /**
     * Обрабатывает клик по карте с зажатой клавишей Shift.
     * Определяет точку пересечения луча с видимыми тайлами,
     * преобразует её в географические координаты и выводит их в консоль.
     *
     * Игнорируется, если мышь сдвинулась между mousedown и mouseup
     * (чтобы клик не срабатывал после драга).
     *
     * @param {MouseEvent} e - Событие клика.
     * @returns {void}
     */
    onClick(e) {
        if (!e.shiftKey) return;
        if (this._mouseMoved) return;

        const rect = this.renderer.domElement.getBoundingClientRect();
        this._tempMouse.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
        this._tempMouse.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
        this._tempRaycaster.setFromCamera(this._tempMouse, this.camera);

        // Собираем все видимые меши тайлов из менеджера тайлов
        const meshes = [];
        for (const inst of this.tileManager.tiles.values()) {
            if (inst.mesh && inst.mesh.visible) {
                meshes.push(inst.mesh);
            }
        }

        const intersects = this._tempRaycaster.intersectObjects(meshes, false);
        if (intersects.length === 0) return;

        const point = intersects[0].point;
        const localX = point.x - this.worldGroup.position.x;
        const localZ = point.z - this.worldGroup.position.z;
        const [lon, lat] = this.unprojectToLonLat(localX, localZ);

        // Высота доступна только при наличии рельефа
        const height = this.hasElevation ? point.y : null;
        if (height !== null) {
            console.log(`Shift+Click: Lon: ${lon.toFixed(6)}, Lat: ${lat.toFixed(6)}, Height: ${height.toFixed(2)}`);
        } else {
            console.log(`Shift+Click: Lon: ${lon.toFixed(6)}, Lat: ${lat.toFixed(6)}, Height: N/A`);
        }
    }

    /**
     * Привязывает обработчики событий к элементам.
     *
     * @returns {void}
     */
    bindEvents() {
        this.renderer.domElement.addEventListener('mousedown', (e) => this.onMouseDown(e));
        window.addEventListener('mousemove', (e) => this.onMouseMove(e));
        window.addEventListener('mouseup', () => this.onMouseUp());
        this.renderer.domElement.addEventListener('wheel', (e) => this.onWheel(e), { passive: false });
        window.addEventListener('resize', () => this.onResize());
        this.renderer.domElement.addEventListener('touchstart', (e) => this.onTouchStart(e), { passive: false });
        this.renderer.domElement.addEventListener('touchmove', (e) => this.onTouchMove(e), { passive: false });
        this.renderer.domElement.addEventListener('touchend', (e) => this.onTouchEnd(e));
        this.renderer.domElement.addEventListener('touchcancel', (e) => this.onTouchEnd(e));
        this.renderer.domElement.addEventListener('click', (e) => this.onClick(e));
    }

    /* ================================================================
       Механика зума и видимости
       ================================================================ */

    /**
     * Применяет дистанцию камеры в соответствии с текущим непрерывным зумом.
     *
     * @returns {void}
     */
    applyZoomDistance() {
        if (this._cameraAnimation) return;
        const target = this._tempTarget.copy(this.controls.target);
        const currentDir = this._tempDir.subVectors(this.camera.position, target).normalize();
        const pitch = Math.acos(currentDir.y);

        let minDist = 0;
        if (this.hasElevation) {
            const maxHeight = this.getSurfaceMaxHeight(target.x, target.z);
            minDist = (maxHeight + this.MIN_CAMERA_HEIGHT_OFFSET) / Math.cos(pitch);
        }

        let dist = this.getTargetDistanceForZoom(this.continuousZoom);
        dist = Math.max(dist, minDist);

        const azimuth = Math.atan2(currentDir.z, currentDir.x);
        this.camera.position.set(
            target.x + dist * Math.sin(pitch) * Math.cos(azimuth),
            target.y + dist * Math.cos(pitch),
            target.z + dist * Math.sin(pitch) * Math.sin(azimuth)
        );
        this.camera.lookAt(target);
    }

    /**
     * Применяет изменение зума на заданную величину.
     *
     * @param {number} delta - Величина изменения зума.
     * @returns {void}
     */
    applyZoomDelta(delta) {
        this.targetContinuousZoom += delta;
        this.targetContinuousZoom = Math.max(this.MIN_ZOOM, Math.min(this.MAX_ZOOM, this.targetContinuousZoom));
        if (this.targetContinuousZoom > this.MAX_RELIEF_Z) {
            const futureCenter = this._tempVec3a.copy(this.controls.target);
            const neededParentZ = Math.min(Math.floor(this.targetContinuousZoom) - 1, this.MAX_RELIEF_Z);
            this.tileManager.prefetchParentElevations(futureCenter, neededParentZ, this.worldGroup.position);
        }
    }

    /**
     * Возвращает идеальный дискретный уровень зума на основе непрерывного с учётом гистерезиса.
     *
     * @param {number} continuousZoom - Непрерывный уровень зума.
     * @returns {number} Дискретный уровень зума.
     */
    peekIdealZoom(continuousZoom) {
        const prev = this.currentDiscreteZoom;
        let idealZ = prev;
        if (continuousZoom >= prev + 0.6) idealZ = prev + 1;
        else if (continuousZoom <= prev - 0.6) idealZ = prev - 1;
        return Math.max(this.MIN_ZOOM, Math.min(this.MAX_ZOOM, idealZ));
    }

    /**
     * Обновляет видимые тайлы, если прошло достаточно времени или принудительно.
     *
     * @param {boolean} [force] - Принудительное обновление.
     * @returns {void}
     */
    maybeUpdateVisibleTiles(force = false) {
        const now = performance.now();
        if (!force && now - this.lastVisibleUpdateTime < this.VISIBLE_UPDATE_THROTTLE) return;
        this.lastVisibleUpdateTime = now;

        const newZ = this.peekIdealZoom(this.continuousZoom);
        if (newZ !== this.currentDiscreteZoom) {
            this.currentDiscreteZoom = newZ;
        }

        this.tileManager.update(
            this.camera, this.controls.target,
            this.continuousZoom, this.worldGroup.position
        );
    }

    /**
     * Перемещает камеру к указанным географическим координатам (WGS84).
     *
     * @param {number} lon - Долгота.
     * @param {number} lat - Широта.
     * @returns {void}
     */
    moveCameraTo(lon, lat) {
        const [cx, cz] = this.projectLonLat(lon, lat);
        const z = this.currentDiscreteZoom;
        const worldOffset = this.worldGroup.position;
        const targetX = cx + worldOffset.x;
        const targetZ = cz + worldOffset.z;

        this.controls.target.set(targetX, 0, targetZ);
        this.camera.position.set(targetX, this.getTargetDistanceForZoom(z), targetZ);
        this.controls.update();
        this.continuousZoom = z;
        this.targetContinuousZoom = z;
        this.applyZoomDistance();
        this.maybeUpdateVisibleTiles(true);
    }

    /**
     * Корректирует мировую позицию при пересечении антимеридиана.
     * Имеет смысл только для проекций с циклической долготой
     * (цилиндрический Меркатор, географическая и т. п.).
     *
     * @private
     */
    _wrapLongitudeIfNeeded() {
        if (!this._wrapsLongitude()) return;

        const now = performance.now();
        if (now - this._lastWrapCheck < 1000) return;
        this._lastWrapCheck = now;

        const worldPos = this.worldGroup.position;
        const centerX = this.controls.target.x - worldPos.x;
        const centerZ = this.controls.target.z - worldPos.z;
        const [lon, lat] = this.unprojectToLonLat(centerX, centerZ);

        let newLon = lon;
        if (lon < -180) {
            newLon = lon + 360;
        } else if (lon > 180) {
            newLon = lon - 360;
        }
        if (newLon === lon) return;

        const [newCenterX, newCenterZ] = this.projectLonLat(newLon, lat);
        this.worldGroup.position.x = this.controls.target.x - newCenterX;
        this.worldGroup.position.z = this.controls.target.z - newCenterZ;
        this.maybeUpdateVisibleTiles(true);
    }

    /**
     * Плавно перемещает камеру к указанным географическим координатам (WGS84) с анимацией.
     *
     * @param {number} lon - Долгота.
     * @param {number} lat - Широта.
     * @param {number} [duration] - Длительность анимации в секундах.
     * @param {number|null} [targetZoom] - Целевой уровень зума или null для сохранения текущего.
     * @returns {void}
     */
    moveCameraToSlow(lon, lat, duration = 1.0, targetZoom = null) {
        if (this._cameraAnimation) return;

        const startTarget = this._tempVec3a.copy(this.controls.target);
        const startPos = this._tempVec3b.copy(this.camera.position);
        const startZoom = this.continuousZoom;

        const [cx, cz] = this.projectLonLat(lon, lat);
        const worldOffset = this.worldGroup.position;
        const endTarget = this._tempVec3c.set(cx + worldOffset.x, 0, cz + worldOffset.z);

        const currentDir = this._tempDir.subVectors(startPos, startTarget).normalize();
        const endZoom = targetZoom !== null ? targetZoom : startZoom;

        const startTime = performance.now();
        this._cameraAnimation = {
            startTarget, startPos, endTarget,
            startZoom, endZoom,
            duration, startTime,
            dir: currentDir.clone()
        };

        this._controlsDampingWasEnabled = this.controls.enableDamping;
        this.controls.enableDamping = false;

        const animateStep = (now) => {
            if (!this._cameraAnimation) return;
            const anim = this._cameraAnimation;
            let t = (now - anim.startTime) / (anim.duration * 1000);
            t = Math.min(t, 1.0);
            const eased = t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;

            const currentZoom = anim.startZoom + (anim.endZoom - anim.startZoom) * eased;
            const currentTarget = this._tempVec3a.lerpVectors(anim.startTarget, anim.endTarget, eased);

            const maxHeight = this.hasElevation ? this.getSurfaceMaxHeight(anim.endTarget.x, anim.endTarget.z) : 0;
            const minDist = this.hasElevation ? (maxHeight + this.MIN_CAMERA_HEIGHT_OFFSET) : 0;
            const desiredDist = this.getTargetDistanceForZoom(currentZoom);
            const finalDist = Math.max(desiredDist, minDist);

            const currentPos = this._tempVec3b.copy(currentTarget).addScaledVector(anim.dir, finalDist);

            this.camera.position.copy(currentPos);
            this.controls.target.copy(currentTarget);
            this.controls.update();

            this.continuousZoom = currentZoom;
            this.targetContinuousZoom = currentZoom;

            this.maybeUpdateVisibleTiles();

            if (t >= 1.0) {
                this._cameraAnimation = null;
                this.controls.enableDamping = this._controlsDampingWasEnabled;

                const finalMaxHeight = this.hasElevation ? this.getSurfaceMaxHeight(anim.endTarget.x, anim.endTarget.z) : 0;
                const finalMinDist = this.hasElevation ? (finalMaxHeight + this.MIN_CAMERA_HEIGHT_OFFSET) : 0;
                const finalDesiredDist = this.getTargetDistanceForZoom(anim.endZoom);
                this.camera.position.copy(
                    this._tempVec3b.copy(anim.endTarget).addScaledVector(anim.dir, Math.max(finalDesiredDist, finalMinDist))
                );
                this.controls.update();

                this.continuousZoom = anim.endZoom;
                this.targetContinuousZoom = anim.endZoom;
                this.maybeUpdateVisibleTiles(true);
                return;
            }
            requestAnimationFrame(animateStep);
        };
        requestAnimationFrame(animateStep);
    }

    /**
     * Поворачивает камеру к северу и, при необходимости, сбрасывает наклон.
     *
     * @param {number} [duration] - Длительность анимации в секундах.
     * @param {boolean} [resetPitch] - Сбросить ли наклон камеры.
     * @returns {void}
     */
    rotateToNorth(duration = 0.3, resetPitch = true) {
        if (this._cameraAnimation) return;

        const startTarget = this._tempVec3a.copy(this.controls.target);
        const startPos = this._tempVec3b.copy(this.camera.position);
        const dir = this._tempDir.subVectors(startPos, startTarget);
        const startDistance = dir.length();
        if (startDistance < 1) return;

        const startPitch = Math.acos(dir.y / startDistance);
        const startAzimuth = Math.atan2(-dir.x, dir.z);
        const endAzimuth = 0;
        const endPitch = resetPitch ? 0 : startPitch;

        let endDistance = startDistance;
        if (resetPitch) {
            const baseDist = this.getTargetDistanceForZoom(this.continuousZoom);
            const maxHeight = this.getSurfaceMaxHeight(startTarget.x, startTarget.z);
            const minDist = maxHeight + this.MIN_CAMERA_HEIGHT_OFFSET;
            endDistance = Math.max(baseDist, minDist);
        }

        let deltaAzimuth = endAzimuth - startAzimuth;
        while (deltaAzimuth > Math.PI) deltaAzimuth -= 2 * Math.PI;
        while (deltaAzimuth < -Math.PI) deltaAzimuth += 2 * Math.PI;
        const deltaPitch = endPitch - startPitch;

        if (Math.abs(deltaAzimuth) < 0.001 && Math.abs(deltaPitch) < 0.001 && Math.abs(endDistance - startDistance) < 1) return;

        this._controlsDampingWasEnabled = this.controls.enableDamping;
        this.controls.enableDamping = false;

        const startTime = performance.now();
        this._cameraAnimation = {
            startTarget, startAzimuth, startPitch, startDistance,
            endAzimuth, endPitch, endDistance, duration, startTime
        };

        const animateStep = (now) => {
            if (!this._cameraAnimation) return;
            const anim = this._cameraAnimation;
            let t = (now - anim.startTime) / (anim.duration * 1000);
            t = Math.min(t, 1.0);
            const eased = t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;

            const currentAzimuth = anim.startAzimuth + (anim.endAzimuth - anim.startAzimuth) * eased;
            const currentPitch = anim.startPitch + (anim.endPitch - anim.startPitch) * eased;
            const currentDistance = anim.startDistance + (anim.endDistance - anim.startDistance) * eased;

            const sinPitch = Math.sin(currentPitch);
            const cosPitch = Math.cos(currentPitch);
            const x = anim.startTarget.x - currentDistance * sinPitch * Math.sin(currentAzimuth);
            const y = anim.startTarget.y + currentDistance * cosPitch;
            const z = anim.startTarget.z + currentDistance * sinPitch * Math.cos(currentAzimuth);

            this.camera.position.set(x, y, z);
            this.controls.target.copy(anim.startTarget);
            this.controls.update();

            this.maybeUpdateVisibleTiles();

            if (t >= 1.0) {
                this._cameraAnimation = null;
                this.controls.enableDamping = this._controlsDampingWasEnabled;
                this.camera.position.set(x, y, z);
                this.controls.target.copy(anim.startTarget);
                this.controls.update();
                this.maybeUpdateVisibleTiles();
                return;
            }
            requestAnimationFrame(animateStep);
        };
        requestAnimationFrame(animateStep);
    }

    /* ================================================================
       Подгонка вида под bounds / объект
       ================================================================ */

    /**
     * Подгоняет вид так, чтобы прямоугольник `bounds` целиком попал в кадр
     * с учётом отступов. Корректно работает при любых текущих наклонах
     * и поворотах камеры (pitch/bearing сохраняются).
     *
     * Как это работает: расстояние до цели вычисляется аналитически из
     * того факта, что при изменении дистанции камеры (при фиксированном
     * направлении target→camera) лучи через углы экрана пересекают плоскость
     * земли в точках, линейно зависящих от дистанции. Решая неравенства
     * «углы bounds внутри кадра», получаем минимально необходимую дистанцию.
     *
     * @param {Array.<Array.<number>>} bounds - Прямоугольник в СК `options.crs`:
     *     [[minX, minY], [maxX, maxY]] (порядок углов нормализуется).
     * @param {Object} [options] - Дополнительные параметры.
     * @param {Projection|string} [options.crs=this.inputCRS] - СК прямоугольника.
     * @param {number|Array.<number>} [options.padding=0] - Отступ в пикселях:
     *     число — одинаково со всех сторон; [x, y] — по горизонтали и вертикали.
     * @param {number} [options.duration=0.5] - Длительность анимации в секундах.
     *     0 — мгновенный переход.
     * @param {number} [options.maxZoom=this.MAX_ZOOM] - Верхняя граница зума
     *     (не позволяет «залипнуть» на слишком близком расстоянии для точек
     *     и маленьких bounds).
     * @returns {void}
     *
     * @example
     * map.fitToBounds([[37.5, 55.7], [37.7, 55.8]], { padding: 80, duration: 0.6 });
     */
    fitToBounds(bounds, options = {}) {
        if (!bounds || !bounds[0] || !bounds[1]) {
            console.warn('fitToBounds: bounds must be [[minX, minY], [maxX, maxY]]');
            return;
        }
        const {
            crs = this.inputCRS,
            padding = 0,
            duration = 0.5,
            maxZoom = this.MAX_ZOOM
        } = options;

        const [[ax, ay], [bx, by]] = bounds;
        const minInX = Math.min(ax, bx), maxInX = Math.max(ax, bx);
        const minInY = Math.min(ay, by), maxInY = Math.max(ay, by);

        const [padX, padY] = Array.isArray(padding)
            ? [padding[0], padding[1]]
            : [padding, padding];

        const srcCrs = typeof crs === 'string' ? Projections.get(crs) : crs;

        // Проецируем все 4 угла в world-координаты карты (в локальных координатах
        // worldGroup — трансляция worldGroup не влияет на дальнейшие вычисления,
        // т.к. они инвариантны относительно сдвига).
        let minWX = Infinity, maxWX = -Infinity, minWZ = Infinity, maxWZ = -Infinity;
        const corners = [
            [minInX, minInY], [maxInX, minInY],
            [minInX, maxInY], [maxInX, maxInY]
        ];
        for (const [px, py] of corners) {
            const lonLat = srcCrs.toLonLat([px, py]);
            const [wx, wy] = this.projection.fromLonLat(lonLat);
            const wz = -wy;
            if (wx < minWX) minWX = wx;
            if (wx > maxWX) maxWX = wx;
            if (wz < minWZ) minWZ = wz;
            if (wz > maxWZ) maxWZ = wz;
        }

        const targetX = (minWX + maxWX) / 2;
        const targetZ = (minWZ + maxWZ) / 2;
        const halfW = (maxWX - minWX) / 2;
        const halfH = (maxWZ - minWZ) / 2;

        const [targetLon, targetLat] = this.projection.toLonLat([targetX, -targetZ]);

        // Degenerate case: bounds-точка → просто центрируем, зум не меняем.
        const epsilon = 1e-6;
        if (halfW < epsilon && halfH < epsilon) {
            const currentZoom = this.continuousZoom;
            this.moveCameraToSlow(targetLon, targetLat, duration,
                Math.min(currentZoom, maxZoom));
            return;
        }

        const D = this._computeFitDistance(targetX, targetZ, halfW, halfH, padX, padY);

        // D → zoom: getTargetDistanceForZoom(z) = BASE_DISTANCE * 2^(BASE_ZOOM - z)
        let z = this.BASE_ZOOM + Math.log2(this.BASE_DISTANCE / D);
        if (!isFinite(z)) z = this.continuousZoom;
        z = Math.max(this.MIN_ZOOM, Math.min(maxZoom, z));

        this.moveCameraToSlow(targetLon, targetLat, duration, z);
    }

    /**
     * Подгоняет вид под один или несколько объектов, реализующих метод
     * `getBounds(crs)` (возвращает [[minX, minY], [maxX, maxY]] или null).
     * Прямоугольники всех объектов объединяются, затем вызывается
     * {@link KrbMap#fitToBounds}.
     *
     * Соглашение о `getBounds(crs)`: объект возвращает прямоугольник в СК `crs`
     * (по умолчанию — WGS84). Это позволяет объединять результаты от объектов
     * с разными собственными СК.
     *
     * @param {Object|Array.<Object>} objectOrArray - Объект или массив объектов
     *     с методом `getBounds`.
     * @param {Object} [options] - Те же, что у {@link KrbMap#fitToBounds}.
     * @returns {void}
     *
     * @example
     * map.fitTo(polygon, { padding: 60 });
     * map.fitTo([marker1, polygon1, polyline1], { duration: 1.0, maxZoom: 16 });
     */
    fitTo(objectOrArray, options = {}) {
        const objs = Array.isArray(objectOrArray) ? objectOrArray : [objectOrArray];
        const crsCode = options.crs ?? 'EPSG:4326';
        const crs = typeof crsCode === 'string' ? Projections.get(crsCode) : crsCode;

        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
        for (const obj of objs) {
            if (!obj || typeof obj.getBounds !== 'function') continue;
            let b;
            try {
                b = obj.getBounds(crsCode);
            } catch (err) {
                console.warn('fitTo: getBounds() threw an error for', obj, err);
                continue;
            }
            if (!b) continue;
            if (b[0][0] < minX) minX = b[0][0];
            if (b[0][1] < minY) minY = b[0][1];
            if (b[1][0] > maxX) maxX = b[1][0];
            if (b[1][1] > maxY) maxY = b[1][1];
        }
        if (!isFinite(minX)) return;

        this.fitToBounds([[minX, minY], [maxX, maxY]], { ...options, crs });
    }

    /**
     * Вычисляет минимальную дистанцию камеры до цели, при которой bounds
     * `[targetX ± halfW] × [targetZ ± halfH]` целиком попадает в кадр.
     *
     * Математика (кратко). Пусть:
     *   - T = (targetX, 0, targetZ) — новая цель;
     *   - dir — единичный вектор от текущей цели к текущей камере
     *     (сохраняется в moveCameraToSlow);
     *   - D — искомая дистанция (камера будет в T + dir·D);
     *   - M = R_cam^T — матрица перехода world→view (R_cam — ориентация камеры,
     *     сохраняется при движении камеры вдоль dir);
     *   - m1, m2, m3 — строки M (то есть столбцы R_cam), т.е. right/up/backward
     *     камеры в мировых координатах;
     *   - tx = tan(fovY/2)·aspect, ty = tan(fovY/2).
     *
     * Для точки P на плоскости земли O = P − T. В view-пространстве:
     *   R.x = m1·O, R.y = m2·O, R.z = m3·O − D
     * (использовано, что M·dir = (0, 0, 1), так как dir направлен «назад» камеры).
     *
     * NDC: ndc.x = R.x / (−R.z·tx), ndc.y = R.y / (−R.z·ty).
     * Условие «точка внутри кадра с учётом padding»:
     *   |ndc.x| ≤ ndcXMax,  |ndc.y| ≤ ndcYMax,
     *   где ndcXMax = 1 − 2·padX/W, ndcYMax = 1 − 2·padY/H.
     *
     * Из |ndc.x| ≤ ndcXMax:
     *   D ≥ m3·O + |m1·O| / (ndcXMax·tx)
     * Аналогично для y. Итоговое D = max по 4 углам bounds от этих величин.
     *
     * @private
     * @param {number} targetX - X-координата центра bounds (мир карты, без worldGroup).
     * @param {number} targetZ - Z-координата центра bounds.
     * @param {number} halfW - Полуширина bounds в метрах.
     * @param {number} halfH - Полувысота bounds в метрах.
     * @param {number} padX - Отступ по горизонтали в пикселях.
     * @param {number} padY - Отступ по вертикали в пикселях.
     * @returns {number} Минимальная дистанция камеры до цели.
     */
    _computeFitDistance(targetX, targetZ, halfW, halfH, padX, padY) {
        const canvas = this.renderer.domElement;
        const W = canvas.clientWidth;
        const H = canvas.clientHeight;
        if (W <= 0 || H <= 0) return this.BASE_DISTANCE;

        const camera = this.camera;
        // Гарантируем актуальность матрицы мира (после controls.update() она уже
        // актуальна, но лишний вызов дешёв и защищает от нестандартных сценариев).
        camera.updateMatrixWorld();

        // Полууглы обзора в тангенсах.
        const fovYRad = camera.fov * Math.PI / 180;
        const ty = Math.tan(fovYRad / 2);
        const tx = ty * camera.aspect;
        if (ty <= 0 || tx <= 0) return this.BASE_DISTANCE;

        // NDC-границы с учётом padding.
        const ndcXMax = 1 - (2 * padX) / W;
        const ndcYMax = 1 - (2 * padY) / H;
        if (ndcXMax <= 0 || ndcYMax <= 0) {
            // Отступы «съели» экран целиком — фолбэк на базовую дистанцию.
            return this.BASE_DISTANCE;
        }

        // Столбцы матрицы мира (right, up, backward камеры в world-координатах).
        const e = camera.matrixWorld.elements;
        const m1x = e[0], m1y = e[1], m1z = e[2]; // right
        const m2x = e[4], m2y = e[5], m2z = e[6]; // up
        const m3x = e[8], m3y = e[9], m3z = e[10]; // backward

        // 4 угла bounds (y = 0, на плоскости земли).
        const corners = [
            [targetX - halfW, 0, targetZ - halfH],
            [targetX + halfW, 0, targetZ - halfH],
            [targetX - halfW, 0, targetZ + halfH],
            [targetX + halfW, 0, targetZ + halfH]
        ];

        let dRequired = 0;
        for (const [px, py, pz] of corners) {
            const ox = px - targetX;
            const oy = py;
            const oz = pz - targetZ;

            const r1 = m1x * ox + m1y * oy + m1z * oz;
            const r2 = m2x * ox + m2y * oy + m2z * oz;
            const r3 = m3x * ox + m3y * oy + m3z * oz;

            const dX = r3 + Math.abs(r1) / (ndcXMax * tx);
            const dY = r3 + Math.abs(r2) / (ndcYMax * ty);
            const dCorner = Math.max(dX, dY);

            if (dCorner > dRequired) dRequired = dCorner;
        }

        if (!isFinite(dRequired) || dRequired <= 0) {
            return this.BASE_DISTANCE;
        }
        return dRequired;
    }

    /* ================================================================
       Главный цикл анимации
       ================================================================ */

    /**
     * Главный цикл анимации, обновляющий камеру, тайлы и рендеринг.
     *
     * @private
     */
    animate() {
        requestAnimationFrame(() => this.animate());
        const deltaTime = Math.min(this.clock.getDelta(), 0.1);

        if (!this._cameraAnimation) {
            const diff = this.targetContinuousZoom - this.continuousZoom;
            if (Math.abs(diff) > 0.001) {
                this.continuousZoom += diff * Math.min(1, 10 * deltaTime);
                this.continuousZoom = Math.max(this.MIN_ZOOM, Math.min(this.MAX_ZOOM, this.continuousZoom));
            } else {
                this.continuousZoom = this.targetContinuousZoom;
            }
        }

        this.controls.update();
        this._wrapLongitudeIfNeeded();

        if (!this._cameraAnimation) {
            this.applyZoomDistance();
        }

        this.maybeUpdateVisibleTiles();

        for (const layer of this._dynamicLayers) {
            if (layer._postUpdate) layer._postUpdate(this);
        }

        if (this.textManager) {
            this.textManager.update();
        }

        // Рендерим сцену
        this.renderer.render(this.scene, this.camera);
    }
}