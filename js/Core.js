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
import { InteractionManager } from './Interaction.js';

/**
 * Параметры камеры/зума, задаваемые пользователем при создании карты.
 * Хранит центр (в градусах или world-метрах), zoom, minZoom/maxZoom,
 * чувствительность зума, pitch и bearing.
 *
 * @example
 * new View({ centerLonLat: [37.6178, 55.7558], zoom: 10 });
 * new View({ center: [4187596, -7509138], zoom: 3 });
 */
export class View {
    /**
     * @param {Object} options
     * @param {Array<number>} [options.centerLonLat] - [lon, lat] в градусах.
     * @param {Array<number>} [options.center] - [x, z] в метрах проекции (Z на юг).
     * @param {string} [options.projection='EPSG:3857'] - Код проекции центра.
     * @param {number} options.zoom
     * @param {number} [options.minZoom]
     * @param {number} [options.maxZoom]
     * @param {number} [options.zoomSensitivity]
     * @param {number} [options.pitch]
     * @param {number} [options.bearing]
     * @throws {Error} Если не задан ни center, ни centerLonLat.
     */
    constructor(options) {
        const projectionCode = options.projection ?? 'EPSG:3857';
        const projection = Projections.get(projectionCode);

        /** @type {string} */
        this.projection = projectionCode;

        if (options.centerLonLat && options.center) {
            console.warn('View: одновременно заданы centerLonLat и center — приоритет centerLonLat.');
        }

        if (options.centerLonLat) {
            /** @type {Array<number>} */
            this.centerLonLat = options.centerLonLat.slice();
            const [x, y] = projection.fromLonLat(this.centerLonLat);
            /** @type {Array<number>} */
            this.center = [x, -y];
        } else if (options.center) {
            /** @type {Array<number>} */
            this.center = options.center.slice();
            /** @type {Array<number>} */
            this.centerLonLat = projection.toLonLat([this.center[0], -this.center[1]]);
        } else {
            throw new Error('View: options.center или options.centerLonLat обязательны');
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
 * Основной класс карты: Three.js-сцена, тайлы, камера, ввод.
 *
 * @example
 * const map = new KrbMap({
 *     target: 'map',
 *     layers: [{ texture: '.../{z}/{x}/{y}.png', elevation: '...', heightScale: 1 }],
 *     view: new View({ centerLonLat: [37.6178, 55.7558], zoom: 3 }),
 *     projection: 'EPSG:3857',
 *     inputCRS: 'EPSG:4326',
 *     R: 6378137
 * });
 */
export class KrbMap {
    /**
     * @param {Object} options
     * @param {string} options.target - ID DOM-элемента.
     * @param {Array<Object>} options.layers - Слои (texture / elevation / heightScale).
     * @param {View} options.view
     * @param {string} [options.projection='EPSG:3857'] - Проекция мира карты.
     * @param {string} [options.inputCRS='EPSG:4326'] - СК по умолчанию для «географических» данных.
     * @param {boolean} [options.deformedTiles] - Использовать ли билинейно-деформированные
     *     тайлы (нужно для всех проекций, кроме Mercator). По умолчанию —
     *     `!projection.isMercator`. Ручное `true`/`false` переопределяет авто-детект.
     * @param {number} [options.R]
     * @param {number} [options.segments]
     * @param {number} [options.animDuration]
     * @param {number} [options.minReliefZ]
     * @param {number} [options.maxReliefZ]
     * @param {number} [options.tileMargin]
     * @param {number} [options.tileMarginBg]
     * @param {number} [options.visibleUpdateThrottle]
     * @param {number} [options.maxWorkerRequests]
     * @param {number} [options.baseZoom]
     * @param {number} [options.baseDistance]
     * @param {number} [options.objectRenderDistanceFactor]
     * @param {number} [options.staticBgZoom]
     * @param {number} [options.minCameraHeightOffset]
     * @param {boolean} [options.antialias=true]
     */
    constructor(options) {
        if (!options) throw new Error('Map constructor: options object is required');

        this.targetElement = document.getElementById(options.target);
        if (!this.targetElement) throw new Error('Target element not found');
        this.layers = options.layers || [];
        if (!options.view) throw new Error('View required');
        this.globalElevCache = new Map();
        this.view = options.view;
        this.hasElevation = options.layers.some(layer => !!layer.elevation);

        /**
         * Есть ли на карте хоть один слой, для которого нужен TileManager
         * (текстура или рельеф). Если нет — TileManager полностью
         * отключается в горячем пути (см. maybeUpdateVisibleTiles).
         *
         * Это принципиально: TileManager строит deformed-тайлы даже в
         * проекциях с узким доменом (Equal Earth и т.п.), и на каждом
         * кадре тратит CPU на proj4. Если тайловых слоёв нет, эта
         * работа бессмысленна.
         *
         * @type {boolean}
         */
        this.hasTileLayers = options.layers.some(layer => !!(layer.texture || layer.elevation));

        // Мир карты в метрах этой проекции.
        this.projection = Projections.get(options.projection ?? 'EPSG:3857');
        // СК по умолчанию для «географических» входных данных.
        this.inputCRS = options.inputCRS
            ? Projections.get(options.inputCRS)
            : Projections.get('EPSG:4326');

        /**
         * Нужно ли деформировать тайлы под проекцию карты.
         *
         * Раньше (Mercator-онли) тайлы ложились прямоугольниками; для
         * остальных проекций это неверно. При `deformedTiles === true`
         * вершины тайла вычисляются через lon/lat углов XYZ-тайла,
         * спроецированные в проекцию карты.
         *
         * По умолчанию — авто: включается, если проекция не Mercator.
         * @type {boolean}
         */
        this.deformedTiles = options.deformedTiles ?? !this.projection.isMercator;

        if (this.view.projection && this.view.projection !== this.projection.code) {
            console.warn(
                `KrbMap: view.projection (${this.view.projection}) != map.projection (${this.projection.code}).`
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
        this.effectiveHeightScale = elevLayer ? elevLayer.heightScale : DEFAULTS.HEIGHT_SCALE;
        this.MIN_CAMERA_HEIGHT_OFFSET = options.minCameraHeightOffset ?? (200 * this.effectiveHeightScale);

        this.continuousZoom = this.view.zoom;
        this.targetContinuousZoom = this.view.zoom;
        this.currentDiscreteZoom = this.view.zoom;

        /** @private @type {boolean} */ this._disposed = false;
        /** @private @type {boolean} */ this._paused = false;
        /** @private @type {number|null} */ this._rafId = null;
        /** @private @type {AbortController|null} */ this._abortController = null;

        this.initThree();
        this.initControls();
        this.initDragTools();
        this.touchDragActive = false;
        this.touchDragLocalPoint = new THREE.Vector3();
        this.touchMouse = new THREE.Vector2();
        this.initTouchState();

        // Переиспользуемые векторы (коротко- и долгоживущие).
        this._tempVec3a = new THREE.Vector3();
        this._tempVec3b = new THREE.Vector3();
        this._tempVec3c = new THREE.Vector3();
        this._tempDir = new THREE.Vector3();
        this._tempTarget = new THREE.Vector3();
        this._tempRaycaster = new THREE.Raycaster();
        this._tempMouse = new THREE.Vector2();

        // Пул временных векторов: ссылку нельзя удерживать между вызовами.
        this._tempPool = {
            v3: Array.from({ length: 16 }, () => new THREE.Vector3()),
            v2: Array.from({ length: 16 }, () => new THREE.Vector2()),
            idx: 0
        };

        const [cx, cz] = this.view.center;
        const initialPitchRad = (this.view.pitch ?? 0) * Math.PI / 180;
        const initialBearingRad = (this.view.bearing ?? 0) * Math.PI / 180;

        this.controls.target.set(cx, 0, cz);
        const dist = this.getTargetDistanceForZoom(this.view.zoom);
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
        this.interaction = new InteractionManager(this);
        this.tileManager = new TileManager(this);

        // LRU-кэш максимальной высоты поверхности; сбрасывается при новых тайлах.
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

    /** Временный Vector3 из пула. Ссылку удерживать нельзя. */
    getVec3() { return this._tempPool.v3[this._tempPool.idx++ & 15]; }

    /** Временный Vector2 из пула. Ссылку удерживать нельзя. */
    getVec2() { return this._tempPool.v2[this._tempPool.idx++ & 15]; }

    /** Инициализация сцены, камеры, рендерера и освещения. @private */
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
       Освещение
       ================================================================ */

    /** @param {number|string} color @param {number} [intensity=0.8] */
    setAmbientLight(color, intensity = 0.8) {
        if (!this.ambientLight) { console.warn('Ambient light is not initialized.'); return; }
        this.ambientLight.color.set(color);
        this.ambientLight.intensity = intensity;
    }

    /**
     * @param {number|string} color
     * @param {number} [intensity=1.3]
     * @param {THREE.Vector3|{x:number,y:number,z:number}|Array<number>} [position]
     */
    setSunLight(color, intensity = 1.3, position = null) {
        if (!this.sunLight) { console.warn('Directional (sun) light is not initialized.'); return; }
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
     * Устанавливает оба источника света за один вызов.
     * @param {{ambientColor?:*, ambientIntensity?:number, sunColor?:*, sunIntensity?:number, sunPosition?:*}} params
     */
    setLighting({ ambientColor, ambientIntensity, sunColor, sunIntensity, sunPosition } = {}) {
        if (ambientColor !== undefined) {
            this.setAmbientLight(ambientColor, ambientIntensity);
        } else if (ambientIntensity !== undefined) {
            this.setAmbientLight(this.ambientLight ? this.ambientLight.color.getHex() : 0xffffff, ambientIntensity);
        }

        if (sunColor !== undefined) {
            this.setSunLight(sunColor, sunIntensity, sunPosition);
        } else if (sunIntensity !== undefined) {
            this.setSunLight(this.sunLight ? this.sunLight.color.getHex() : 0xffffff, sunIntensity, sunPosition);
        } else if (sunPosition !== undefined) {
            this.setSunLight(
                this.sunLight ? this.sunLight.color.getHex() : 0xffffff,
                this.sunLight ? this.sunLight.intensity : 1.3,
                sunPosition
            );
        }
    }

    /** @returns {THREE.AmbientLight|null} */
    getAmbientLight() { return this.ambientLight || null; }

    /** @returns {THREE.DirectionalLight|null} */
    getSunLight() { return this.sunLight || null; }

    /* ================================================================
       Преобразование координат
       ================================================================ */

    /**
     * Координаты из `fromCrs` в world-метры карты. Без валидации.
     * Для безопасного варианта используйте {@link KrbMap#projectSafe}.
     *
     * @param {Array<number>} coord - [x, y] в СК `fromCrs`.
     * @param {Projection|string} [fromCrs=this.inputCRS]
     * @returns {Array<number>} [x, z], Z на юг.
     */
    project(coord, fromCrs = this.inputCRS) {
        const src = typeof fromCrs === 'string' ? Projections.get(fromCrs) : fromCrs;
        if (src === this.projection) {
            return [coord[0], -coord[1]];
        }
        const lonLat = src.toLonLat(coord);
        const [x, y] = this.projection.fromLonLat(lonLat);
        return [x, -y];
    }

    /**
     * Безопасная версия {@link KrbMap#project}: возвращает `null` вместо
     * невалидных координат (кламп широты для Mercator + отсев «мусора»
     * от proj4).
     *
     * @param {Array<number>} coord
     * @param {Projection|string} [fromCrs=this.inputCRS]
     * @returns {Array<number>|null} [x, z] или null.
     */
    projectSafe(coord, fromCrs = this.inputCRS) {
        if (!coord || coord.length < 2) return null;
        if (!Number.isFinite(coord[0]) || !Number.isFinite(coord[1])) return null;

        const src = typeof fromCrs === 'string' ? Projections.get(fromCrs) : fromCrs;
        if (src === this.projection) return [coord[0], -coord[1]];

        const lonLat = typeof src.toLonLatSafe === 'function'
            ? src.toLonLatSafe(coord)
            : src.toLonLat(coord);
        if (!lonLat || !Number.isFinite(lonLat[0]) || !Number.isFinite(lonLat[1])) return null;

        const proj = typeof this.projection.fromLonLatSafe === 'function'
            ? this.projection.fromLonLatSafe(lonLat)
            : this.projection.fromLonLat(lonLat);
        if (!proj || !Number.isFinite(proj[0]) || !Number.isFinite(proj[1])) return null;

        return [proj[0], -proj[1]];
    }

    /**
     * World-метры карты → координаты в `toCrs`.
     * @param {Array<number>} worldCoord - [x, z].
     * @param {Projection|string} [toCrs=this.inputCRS]
     * @returns {Array<number>} [x, y] в целевой СК.
     */
    unproject(worldCoord, toCrs = this.inputCRS) {
        const dst = typeof toCrs === 'string' ? Projections.get(toCrs) : toCrs;
        const std = [worldCoord[0], -worldCoord[1]];
        if (dst === this.projection) return std;
        const lonLat = this.projection.toLonLat(std);
        return dst.fromLonLat(lonLat);
    }

    /** Шорткат: (lon, lat) → [x, z]. @returns {Array<number>} */
    projectLonLat(lon, lat) {
        const [x, y] = this.projection.fromLonLat([lon, lat]);
        return [x, -y];
    }

    /** Шорткат: (x, z) → [lon, lat]. @returns {Array<number>} */
    unprojectToLonLat(x, z) {
        return this.projection.toLonLat([x, -z]);
    }

    /**
     * World-координаты → дробные индексы XYZ-тайла.
     *
     * Для Mercator — линейное преобразование (быстро, без proj4).
     * Для остальных — через lon/lat и стандартную формулу Web Mercator.
     *
     * ВАЖНО: результат проекции за пределами области определения
     * отбраковывается. proj4 не валидирует домен и для координат вне
     * Equal Earth (или другого узкого домена) легко возвращает
     * lon ≈ 470°, что после формулы Web Mercator даёт абсурдные
     * tile-индексы (например, -7..15 на zoom=3) и раздувает bbox
     * в TileManager.update.
     *
     * @param {number} worldX
     * @param {number} worldZ
     * @param {number} z
     * @returns {[number, number]} [tx, ty] — дробные индексы (могут быть NaN,
     *     если world-координаты вне области определения проекции).
     */
    worldToTileIndex(worldX, worldZ, z) {
        const lx = worldX - this.worldGroup.position.x;
        const lz = worldZ - this.worldGroup.position.z;
        const n = 1 << z;

        if (!this.deformedTiles) {
            const tileSize = this.WORLD_SIZE / n;
            return [
                (lx + this.MAX_MERCATOR) / tileSize,
                (lz + this.MAX_MERCATOR) / tileSize
            ];
        }

        const lonLat = this.unprojectToLonLat(lx, lz);
        if (!lonLat || !Number.isFinite(lonLat[0]) || !Number.isFinite(lonLat[1])) {
            return [NaN, NaN];
        }
        if (Math.abs(lonLat[0]) > 180.0001 || Math.abs(lonLat[1]) > 90.0001) {
            return [NaN, NaN];
        }
        const latC = Math.max(-85.05112878, Math.min(85.05112878, lonLat[1]));
        const sin = Math.sin(latC * Math.PI / 180);
        const mercX = (lonLat[0] + 180) / 360;
        const mercY = 0.5 - Math.log((1 + sin) / (1 - sin)) / (4 * Math.PI);
        return [mercX * n, mercY * n];
    }

    /**
     * Обратное к {@link KrbMap#worldToTileIndex}: дробный tile-index → world-метры.
     * @param {number} tx
     * @param {number} ty
     * @param {number} z
     * @returns {[number, number]} [worldX, worldZ]
     */
    tileIndexToWorld(tx, ty, z) {
        const n = 1 << z;
        if (!this.deformedTiles) {
            const tileSize = this.WORLD_SIZE / n;
            return [
                tx * tileSize - this.MAX_MERCATOR + this.worldGroup.position.x,
                ty * tileSize - this.MAX_MERCATOR + this.worldGroup.position.z
            ];
        }
        const lon = tx / n * 360 - 180;
        const lat = Math.atan(Math.sinh(Math.PI * (1 - 2 * ty / n))) * 180 / Math.PI;
        const [x, zWorld] = this.projectLonLat(lon, lat);
        return [x + this.worldGroup.position.x, zWorld + this.worldGroup.position.z];
    }

    /** true, если проекция циклична по долготе (Mercator, longlat). @private */
    _wrapsLongitude() {
        const def = this.projection.def || '';
        return /\+proj=merc\b/.test(def) || /\+proj=longlat\b/.test(def);
    }

    /* ================================================================
       Управление камерой
       ================================================================ */

    /** Инициализация OrbitControls. @private */
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

    /** Инициализация инструментов drag-панорамирования. @private */
    initDragTools() {
        this.groundPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
        this.raycasterDragger = new THREE.Raycaster();
        this.mouse = new THREE.Vector2();
        this.intersection = new THREE.Vector3();
        this.isDragging = false;
        this.dragLocalPoint = new THREE.Vector3();
        this._mouseDownX = 0;
        this._mouseDownY = 0;
        this._mouseMoved = false;
    }

    /** Инициализация состояния touch-жестов. @private */
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

    /** @param {number} pitchDeg @param {number} [duration=0.3] */
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

    /** @param {number} bearingDeg @param {number} [duration=0.3] */
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

    /** Общий rAF-цикл для анимаций pitch/bearing. @private */
    _startCameraAnimationLoopIfNeeded() {
        if (this._disposed || this._paused) return;
        if (this._cameraAnimation || this._cameraAnimFrame) return;

        this._cameraAnimation = { custom: true };
        this._controlsDampingWasEnabled = this.controls.enableDamping;
        this.controls.enableDamping = false;

        const animateStep = (now) => {
            if (this._disposed) {
                this._cameraAnimation = null;
                this._cameraAnimFrame = null;
                return;
            }

            let anyActive = false;
            const target = this._tempVec3a.copy(this.controls.target);
            const currentPos = this._tempVec3b.copy(this.camera.position);
            const dir = this._tempDir.subVectors(currentPos, target);
            const currentDistance = dir.length();
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

    resetBearing() { this.rotateToNorth(0.3); }

    /** @param {number} z @returns {number} */
    getTargetDistanceForZoom(z) {
        return this.BASE_DISTANCE * Math.pow(0.5, z - this.BASE_ZOOM);
    }

    /* ================================================================
       URL-хелперы
       ================================================================ */

    /** @param {number} z @param {number} x @param {number} y @returns {string|null} */
    getTextureUrl(z, x, y) {
        if (!this.layers[0] || !this.layers[0].texture) return null;
        return this.layers[0].texture
            .replace(/\{z\}/g, z).replace(/\{x\}/g, x).replace(/\{y\}/g, y);
    }

    /** @param {number} z @param {number} x @param {number} y @returns {string|null} */
    getElevationUrl(z, x, y) {
        if (!this.layers[0] || !this.layers[0].elevation) return null;
        return this.layers[0].elevation
            .replace(/\{z\}/g, z).replace(/\{x\}/g, x).replace(/\{y\}/g, y);
    }

    /** @returns {number} */
    get maxObjectDistance() {
        if (!this.objectRenderDistanceFactor) return Infinity;
        const distToTarget = this.camera.position.distanceTo(this.controls.target);
        return distToTarget * this.objectRenderDistanceFactor;
    }

    /* ================================================================
       Высоты поверхности
       ================================================================ */

    /** LRU-обновление кэша max height. @private */
    _setSurfaceMaxHeight(key, value) {
        this._surfaceMaxHeightCache.delete(key);
        this._surfaceMaxHeightCache.set(key, value);
        while (this._surfaceMaxHeightCache.size > this._surfaceMaxHeightCacheMaxSize) {
            const oldestKey = this._surfaceMaxHeightCache.keys().next().value;
            this._surfaceMaxHeightCache.delete(oldestKey);
        }
    }

    /**
     * Максимальная высота рельефа в тайле под точкой.
     * @param {number} worldX @param {number} worldZ @returns {number}
     */
    getSurfaceMaxHeight(worldX, worldZ) {
        if (!this.hasElevation) return 0;
        const z = this.currentDiscreteZoom;
        const maxTile = (1 << z) - 1;

        const [tx, ty] = this.worldToTileIndex(worldX, worldZ, z);
        if (!Number.isFinite(tx) || !Number.isFinite(ty)) return 0;

        const virtX = Math.floor(tx);
        const y = Math.floor(ty);
        if (y < 0 || y > maxTile) return 0;
        const vk = getVirtKey(z, virtX, y);

        if (this._surfaceMaxHeightCache.has(vk)) return this._surfaceMaxHeightCache.get(vk);

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
     * Интерполированная высота рельефа в точке.
     *
     * Работает в tile-space: `u, v` — доли внутри тайла, независимо от
     * того, прямоугольный он (Mercator) или деформированный. Это
     * согласуется с раскладкой вершин PlaneGeometry (row-major от NW).
     *
     * @param {number} worldX @param {number} worldZ @returns {number}
     */
    getSurfaceHeightAt(worldX, worldZ) {
        if (!this.hasElevation) return 0;
        const z = this.currentDiscreteZoom;
        const maxTile = (1 << z) - 1;

        const [tx, ty] = this.worldToTileIndex(worldX, worldZ, z);
        if (!Number.isFinite(tx) || !Number.isFinite(ty)) return 0;

        const virtX = Math.floor(tx);
        const y = Math.floor(ty);
        if (y < 0 || y > maxTile) return 0;
        const vk = getVirtKey(z, virtX, y);
        const inst = this.tileManager.tiles.get(vk);
        if (!inst || !inst.heightsApplied || !inst.mesh) return 0;

        const u = tx - virtX;
        const v = ty - y;

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
     * Гарантирует загрузку тайла под точкой.
     * @param {number} worldX @param {number} worldZ
     */
    ensureTileForPoint(worldX, worldZ) {
        const z = this.currentDiscreteZoom;
        const maxTile = (1 << z) - 1;

        const [tx, ty] = this.worldToTileIndex(worldX, worldZ, z);
        if (!Number.isFinite(tx) || !Number.isFinite(ty)) return;

        const virtX = Math.floor(tx);
        const y = Math.floor(ty);
        if (y < 0 || y > maxTile) return;
        this.tileManager.ensureTile(z, virtX, y);
    }

    /**
     * Статический фоновый слой из текстур.
     *
     * В deformed-режиме фон не строится: плоско-прямоугольные
     * заглушки не соответствуют проекции и будут заметно «врать».
     * В этом режиме вся отрисовка — на TileManager.
     */
    createStaticBackgroundLayer() {
        if (this.deformedTiles) return;
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
       Сдвиг мира
       ================================================================ */

    /** @param {number} dx @param {number} dz */
    shiftWorld(dx, dz) {
        this.worldGroup.position.x -= dx;
        this.worldGroup.position.z -= dz;
    }

    /** Ставит controls.target в центр экрана на плоскости земли. */
    syncControlsTarget() {
        this._tempMouse.set(0, 0);
        this._tempRaycaster.setFromCamera(this._tempMouse, this.camera);
        if (this._tempRaycaster.ray.intersectPlane(this.groundPlane, this._tempVec3a)) {
            this.controls.target.copy(this._tempVec3a);
            this.controls.update();
        }
    }

    /* ================================================================
       Мышь
       ================================================================ */

    /** @param {MouseEvent} e */
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

    /** @param {MouseEvent} e */
    onMouseMove(e) {
        if (this._cameraAnimation) return;

        if (!this._mouseMoved) {
            const dx = e.clientX - this._mouseDownX;
            const dy = e.clientY - this._mouseDownY;
            if (dx * dx + dy * dy > 9) this._mouseMoved = true;
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

    onMouseUp() {
        if (!this.isDragging) return;
        this.isDragging = false;
        if (this._cameraAnimation) return;
        this.syncControlsTarget();
    }

    /** @param {WheelEvent} e */
    onWheel(e) {
        if (this._cameraAnimation) return;
        e.preventDefault();
        const delta = -Math.sign(e.deltaY) * this.ZOOM_SENSITIVITY;
        this.applyZoomDelta(delta);
    }

    /* ================================================================
       Тач
       ================================================================ */

    /** @param {TouchList} touches @returns {number} */
    getTouchDistance(touches) {
        const dx = touches[0].clientX - touches[1].clientX;
        const dy = touches[0].clientY - touches[1].clientY;
        return Math.sqrt(dx * dx + dy * dy);
    }

    /** @param {TouchEvent} e */
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

    /** @param {TouchList} touches @param {number} id @returns {Touch|null} */
    findTouchById(touches, id) {
        for (let i = 0; i < touches.length; i++) {
            if (touches[i].identifier === id) return touches[i];
        }
        return null;
    }

    /** @param {TouchEvent} e */
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

    /** @param {TouchEvent} e */
    onTouchEnd(e) {
        if (e.touches.length < 2) this.touchState.isPinching = false;
        if (e.touches.length === 0 && this.touchDragActive) {
            this.touchDragActive = false;
            if (this._cameraAnimation) return;
            this.syncControlsTarget();
        }
    }

    onResize() {
        if (this._disposed) return;
        const w = this.targetElement.clientWidth;
        const h = this.targetElement.clientHeight;
        this.camera.aspect = w / h;
        this.camera.updateProjectionMatrix();
        this.renderer.setSize(w, h);
        this.maybeUpdateVisibleTiles();
    }

    /** Shift+Click: лог координат точки под курсором. @param {MouseEvent} e */
    onClick(e) {
        if (!e.shiftKey) return;
        if (this._mouseMoved) return;

        const rect = this.renderer.domElement.getBoundingClientRect();
        this._tempMouse.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
        this._tempMouse.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
        this._tempRaycaster.setFromCamera(this._tempMouse, this.camera);

        const meshes = [];
        for (const inst of this.tileManager.tiles.values()) {
            if (inst.mesh && inst.mesh.visible) meshes.push(inst.mesh);
        }

        const intersects = this._tempRaycaster.intersectObjects(meshes, false);
        if (intersects.length === 0) return;

        const point = intersects[0].point;
        const localX = point.x - this.worldGroup.position.x;
        const localZ = point.z - this.worldGroup.position.z;
        const [lon, lat] = this.unprojectToLonLat(localX, localZ);

        const height = this.hasElevation ? point.y : null;
        if (height !== null) {
            console.log(`Shift+Click: Lon: ${lon.toFixed(6)}, Lat: ${lat.toFixed(6)}, Height: ${height.toFixed(2)}`);
        } else {
            console.log(`Shift+Click: Lon: ${lon.toFixed(6)}, Lat: ${lat.toFixed(6)}, Height: N/A`);
        }
    }

    /**
     * Навешивает все DOM-слушатели через единый AbortController,
     * чтобы `dispose()` мог снять их одной командой.
     * @private
     */
    bindEvents() {
        this._abortController = new AbortController();
        const signal = this._abortController.signal;
        const el = this.renderer.domElement;

        el.addEventListener('mousedown', (e) => this.onMouseDown(e), { signal });
        window.addEventListener('mousemove', (e) => this.onMouseMove(e), { signal });
        window.addEventListener('mouseup', () => this.onMouseUp(), { signal });
        el.addEventListener('wheel', (e) => this.onWheel(e), { passive: false, signal });
        window.addEventListener('resize', () => this.onResize(), { signal });
        el.addEventListener('touchstart', (e) => this.onTouchStart(e), { passive: false, signal });
        el.addEventListener('touchmove', (e) => this.onTouchMove(e), { passive: false, signal });
        el.addEventListener('touchend', (e) => this.onTouchEnd(e), { signal });
        el.addEventListener('touchcancel', (e) => this.onTouchEnd(e), { signal });
        el.addEventListener('click', (e) => this.onClick(e), { signal });
    }

    /* ================================================================
       Зум и видимость
       ================================================================ */

    /** Применяет дистанцию камеры по текущему непрерывному зуму. */
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

    /** @param {number} delta */
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
     * Идеальный дискретный zoom с гистерезисом.
     * @param {number} continuousZoom @returns {number}
     */
    peekIdealZoom(continuousZoom) {
        const prev = this.currentDiscreteZoom;
        let idealZ = prev;
        if (continuousZoom >= prev + 0.6) idealZ = prev + 1;
        else if (continuousZoom <= prev - 0.6) idealZ = prev - 1;
        return Math.max(this.MIN_ZOOM, Math.min(this.MAX_ZOOM, idealZ));
    }

    /**
     * Обновляет видимые тайлы.
     *
     * ВАЖНО: если на карте нет ни одного тайлового слоя (только
     * векторные полигоны), метод выходит сразу после пересчёта
     * currentDiscreteZoom. Это отключает весь TileManager в горячем
     * пути — включая построение deformed-тайлов через proj4, которое
     * для узких проекций (Equal Earth и т.п.) давало просадку до 1 FPS
     * даже при пустом списке layers.
     *
     * @param {boolean} [force]
     */
    maybeUpdateVisibleTiles(force = false) {
        if (this._disposed) return;
        const now = performance.now();
        if (!force && now - this.lastVisibleUpdateTime < this.VISIBLE_UPDATE_THROTTLE) return;
        this.lastVisibleUpdateTime = now;

        const newZ = this.peekIdealZoom(this.continuousZoom);
        if (newZ !== this.currentDiscreteZoom) this.currentDiscreteZoom = newZ;

        if (!this.hasTileLayers) return;

        this.tileManager.update(
            this.camera, this.controls.target,
            this.continuousZoom, this.worldGroup.position
        );
    }

    /** @param {number} lon @param {number} lat */
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

    /** Перескок через антимеридиан для цикличных по долготе проекций. @private */
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
        if (lon < -180) newLon = lon + 360;
        else if (lon > 180) newLon = lon - 360;
        if (newLon === lon) return;

        const [newCenterX, newCenterZ] = this.projectLonLat(newLon, lat);
        this.worldGroup.position.x = this.controls.target.x - newCenterX;
        this.worldGroup.position.z = this.controls.target.z - newCenterZ;
        this.maybeUpdateVisibleTiles(true);
    }

    /**
     * Анимированный перелёт к (lon, lat).
     * @param {number} lon @param {number} lat
     * @param {number} [duration=1.0]
     * @param {number|null} [targetZoom=null]
     */
    moveCameraToSlow(lon, lat, duration = 1.0, targetZoom = null) {
        if (this._disposed || this._cameraAnimation) return;

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
            if (this._disposed || !this._cameraAnimation) return;
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
     * Поворот к северу (и сброс pitch, если надо).
     * @param {number} [duration=0.3] @param {boolean} [resetPitch=true]
     */
    rotateToNorth(duration = 0.3, resetPitch = true) {
        if (this._disposed || this._cameraAnimation) return;

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
            if (this._disposed || !this._cameraAnimation) return;
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
       fitToBounds / fitTo
       ================================================================ */

    /**
     * Подгоняет вид под прямоугольник. Сохраняет текущий pitch/bearing.
     * @param {Array<Array<number>>} bounds - [[minX, minY], [maxX, maxY]].
     * @param {Object} [options]
     * @param {Projection|string} [options.crs=this.inputCRS]
     * @param {number|Array<number>} [options.padding=0]
     * @param {number} [options.duration=0.5]
     * @param {number} [options.maxZoom=this.MAX_ZOOM]
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

        const epsilon = 1e-6;
        if (halfW < epsilon && halfH < epsilon) {
            const currentZoom = this.continuousZoom;
            this.moveCameraToSlow(targetLon, targetLat, duration, Math.min(currentZoom, maxZoom));
            return;
        }

        const D = this._computeFitDistance(targetX, targetZ, halfW, halfH, padX, padY);
        let z = this.BASE_ZOOM + Math.log2(this.BASE_DISTANCE / D);
        if (!isFinite(z)) z = this.continuousZoom;
        z = Math.max(this.MIN_ZOOM, Math.min(maxZoom, z));

        this.moveCameraToSlow(targetLon, targetLat, duration, z);
    }

    /**
     * Подгоняет вид под объект(ы) с методом `getBounds(crs)`.
     * @param {Object|Array<Object>} objectOrArray
     * @param {Object} [options]
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

    /** Минимальная дистанция, при которой bounds влезает в кадр. @private */
    _computeFitDistance(targetX, targetZ, halfW, halfH, padX, padY) {
        const canvas = this.renderer.domElement;
        const W = canvas.clientWidth;
        const H = canvas.clientHeight;
        if (W <= 0 || H <= 0) return this.BASE_DISTANCE;

        const camera = this.camera;
        camera.updateMatrixWorld();

        const fovYRad = camera.fov * Math.PI / 180;
        const ty = Math.tan(fovYRad / 2);
        const tx = ty * camera.aspect;
        if (ty <= 0 || tx <= 0) return this.BASE_DISTANCE;

        const ndcXMax = 1 - (2 * padX) / W;
        const ndcYMax = 1 - (2 * padY) / H;
        if (ndcXMax <= 0 || ndcYMax <= 0) return this.BASE_DISTANCE;

        const e = camera.matrixWorld.elements;
        const m1x = e[0], m1y = e[1], m1z = e[2];
        const m2x = e[4], m2y = e[5], m2z = e[6];
        const m3x = e[8], m3y = e[9], m3z = e[10];

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

        if (!isFinite(dRequired) || dRequired <= 0) return this.BASE_DISTANCE;
        return dRequired;
    }

    /* ================================================================
       Пауза / уничтожение
       ================================================================ */

    /**
     * Ставит карту на паузу: останавливает главный rAF-цикл и цикл
     * камерных анимаций. DOM-слушатели, менеджеры, GPU-ресурсы остаются
     * на месте — карту можно вернуть через {@link KrbMap#resume}.
     * @returns {void}
     */
    pause() {
        if (this._disposed || this._paused) return;
        this._paused = true;

        if (this._rafId !== null) {
            cancelAnimationFrame(this._rafId);
            this._rafId = null;
        }
        if (this._cameraAnimFrame !== null) {
            cancelAnimationFrame(this._cameraAnimFrame);
            this._cameraAnimFrame = null;
        }
        this._cameraAnimation = null;
        this._cameraAnimations.pitch = null;
        this._cameraAnimations.bearing = null;
    }

    /**
     * Возобновляет работу после {@link KrbMap#pause}.
     * @returns {void}
     */
    resume() {
        if (this._disposed || !this._paused) return;
        this._paused = false;

        this.onResize();
        this.lastVisibleUpdateTime = 0;
        this.clock.getDelta();

        this.animate();
    }

    /** @returns {boolean} `true`, если карта сейчас на паузе. */
    isPaused() { return this._paused; }

    /** @returns {boolean} `true`, если карта уничтожена через `dispose()`. */
    isDisposed() { return this._disposed; }

    /**
     * Полностью уничтожает карту: останавливает циклы, снимает все
     * DOM-слушатели, освобождает GPU-ресурсы и обнуляет ссылки.
     * @returns {void}
     */
    dispose() {
        if (this._disposed) return;
        this._disposed = true;

        // 1. Стоп всех rAF-циклов.
        if (this._rafId !== null) {
            cancelAnimationFrame(this._rafId);
            this._rafId = null;
        }
        if (this._cameraAnimFrame !== null) {
            cancelAnimationFrame(this._cameraAnimFrame);
            this._cameraAnimFrame = null;
        }
        this._cameraAnimation = null;
        this._cameraAnimations = { pitch: null, bearing: null };

        // 2. Снять DOM-слушатели.
        if (this._abortController) {
            try { this._abortController.abort(); } catch (e) { console.warn(e); }
            this._abortController = null;
        }

        // 3. Менеджеры.
        const managers = ['tileManager', 'textManager', 'popupManager', 'interaction'];
        for (const name of managers) {
            const m = this[name];
            if (m && typeof m.dispose === 'function') {
                try { m.dispose(); } catch (e) { console.warn(`KrbMap.dispose: ${name}.dispose() threw`, e); }
            }
            this[name] = null;
        }

        // 4. Геометрии и материалы сцены.
        this._disposeObject3D(this.scene);

        // 5. OrbitControls.
        if (this.controls && typeof this.controls.dispose === 'function') {
            try { this.controls.dispose(); } catch (e) { console.warn(e); }
        }
        this.controls = null;

        // 6. Рендерер.
        if (this.renderer) {
            const canvas = this.renderer.domElement;
            try { this.renderer.dispose(); } catch (e) { console.warn(e); }
            try { if (typeof this.renderer.forceContextLoss === 'function') this.renderer.forceContextLoss(); }
            catch (e) { console.warn(e); }
            if (canvas && canvas.parentNode) canvas.parentNode.removeChild(canvas);
        }
        this.renderer = null;
        this.camera = null;
        this.scene = null;
        this.worldGroup = null;
        this.staticBgGroup = null;
        this.ambientLight = null;
        this.sunLight = null;

        // 7. Прочие ссылки.
        this._dynamicLayers = [];
        this.layers = [];
        this.globalElevCache?.clear?.();
        this.globalElevCache = null;
        this._surfaceMaxHeightCache?.clear?.();
        this._surfaceMaxHeightCache = null;
        this._tempPool = null;
        this._tempVec3a = null;
        this._tempVec3b = null;
        this._tempVec3c = null;
        this._tempDir = null;
        this._tempTarget = null;
        this._tempRaycaster = null;
        this._tempMouse = null;
        this.targetElement = null;
    }

    /**
     * Рекурсивно обходит поддерево и освобождает геометрии/материалы.
     * Текстуры не трогаем: они могут быть закэшированы менеджерами.
     * @param {THREE.Object3D|null} root
     * @private
     */
    _disposeObject3D(root) {
        if (!root) return;
        root.traverse((obj) => {
            if (obj.geometry && typeof obj.geometry.dispose === 'function') {
                try { obj.geometry.dispose(); } catch (e) { console.warn(e); }
            }
            obj.geometry = null;

            const mats = obj.material;
            if (mats) {
                const list = Array.isArray(mats) ? mats : [mats];
                for (const m of list) {
                    if (!m) continue;
                    try { if (typeof m.dispose === 'function') m.dispose(); }
                    catch (e) { console.warn(e); }
                }
            }
            obj.material = null;
        });
        if (typeof root.clear === 'function') root.clear();
    }

    /* ================================================================
       Главный цикл
       ================================================================ */

    /** @private */
    animate() {
        if (this._disposed || this._paused) return;
        this._rafId = requestAnimationFrame(() => this.animate());
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

        if (!this._cameraAnimation) this.applyZoomDistance();

        this.maybeUpdateVisibleTiles();

        for (const layer of this._dynamicLayers) {
            if (layer._postUpdate) layer._postUpdate(this);
        }

        if (this.textManager) this.textManager.update();

        this.renderer.render(this.scene, this.camera);
    }
}