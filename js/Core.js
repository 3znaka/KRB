import {
  THREE,
  OrbitControls,
  TOUCH_MAP_CONTROLS
} from '../js_TP/tpb.js';
import { DEFAULTS, getOriginZ, getVirtKey } from './Utils.js';
import { Projections } from './Projections.js';
import { TileManager } from './Tiles.js';
import { TextManager } from './TextManager.js';
import { initUI } from './Ui.js';
import { PopupManager } from './PopupManager.js';
import { InteractionManager } from './Interaction.js';
import { NoiseElevationProvider } from './NoiseElevation.js';

/**
 * Параметры камеры/зума. `View` не знает CRS карты — координаты
 * хранятся «как передали», а согласование с проекцией рендера делает
 * `KrbMap._resolveViewCenter` в своём конструкторе.
 *
 *  - `centerLonLat` — WGS84 (lon, lat);
 *  - `center` — в CRS `projection` (по умолчанию EPSG:3857).
 *
 * @example
 * new View({ centerLonLat: [37.6178, 55.7558], zoom: 10 });
 * new View({ center: [418013, -6170966], projection: 'EPSG:32637', zoom: 8 });
 */
export class View {
    constructor(options) {
        if (!options) throw new Error('View: options object is required');
        if (!options.centerLonLat && !options.center) {
            throw new Error('View: options.center или options.centerLonLat обязательны');
        }
        if (options.centerLonLat && options.center) {
            console.warn('View: одновременно заданы centerLonLat и center — приоритет centerLonLat.');
        }

        /** @type {Array<number>|null} WGS84 (lon, lat). */
        this.centerLonLat = options.centerLonLat ? options.centerLonLat.slice() : null;
        /** @type {Array<number>|null} в CRS `projection` (y → -z). */
        this.center = options.center ? options.center.slice() : null;
        /** @type {string} CRS для `center` (игнорируется, если задан `centerLonLat`). */
        this.projection = options.projection ?? 'EPSG:3857';

        this.zoom = options.zoom;
        this.minZoom = options.minZoom ?? DEFAULTS.MIN_ZOOM;
        this.maxZoom = options.maxZoom ?? DEFAULTS.MAX_ZOOM;
        this.zoomSensitivity = options.zoomSensitivity ?? DEFAULTS.ZOOM_SENSITIVITY;
        this.pitch = options.pitch ?? 0;
        this.bearing = options.bearing ?? 0;
    }
}

/**
 * Основной класс карты: сцена, тайлы, камера, ввод.
 *
 * Спецзначения полей слоя:
 *  - `texture: 'demo'` — картинки из `demotiles/1.webp … 24.webp`.
 *  - `elevation: 'demo'` — процедурный рельеф через {@link NoiseElevationProvider}.
 *  - `heightScale` (число) — только для URL-источника DEM.
 *  - `crs` (строка) — CRS тайлового сервера, по умолчанию 'EPSG:3857'.
 */
export class KrbMap {
    /**
     * @param {Object} options
     * @param {string} options.target
     * @param {Array<Object>} options.layers
     * @param {View} options.view
     * @param {string} [options.projection='EPSG:3857']
     * @param {string} [options.inputCRS='EPSG:4326']
     * @param {boolean} [options.deformedTiles]
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
     * @param {number} [options.cameraTerrainClearance=5]
     * @param {boolean} [options.antialias=true]
     * @param {boolean} [options.tileLighting=false]
     * @param {number} [options.tileLightingRoughness=0.7]
     * @param {number} [options.tileLightingMetalness=0.0]
     * @param {number} [options.tileLightingEmissive=0.5]
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
        this.hasTileLayers = options.layers.some(layer => !!(layer.texture || layer.elevation));

        this.projection = Projections.get(options.projection ?? 'EPSG:3857');
        this._resolveViewCenter();

        this.inputCRS = options.inputCRS
            ? Projections.get(options.inputCRS)
            : Projections.get('EPSG:4326');

        /**
         * CRS источника тайлов. Все тайловые слои считаются в одной CRS;
         * берётся из первого слоя с `texture` или `elevation`, дефолт —
         * EPSG:3857. Именно она определяет, как `{z}/{x}/{y}` от
         * тайлового сервера переводится в lon/lat.
         * @type {Projection}
         */
        const firstTileLayer = this.layers.find(l => l.texture || l.elevation);
        this.tileCRS = Projections.get(firstTileLayer?.crs ?? 'EPSG:3857');

        // Линейная сетка тайлов работает только если тайлы и карта — обе
        // в Mercator-семействе (3857/3395): там world-координата тайла
        // совпадает с world-координатой карты без проекции. Во всех
        // остальных случаях — deformed-путь через lon/lat.
        const tileAndMapMatch =
            this.tileCRS === this.projection &&
            this.projection.isMercator;
        this.deformedTiles = options.deformedTiles ?? !tileAndMapMatch;

        this.R = options.R ?? DEFAULTS.R;
        this.WORLD_SIZE = 2 * Math.PI * this.R;
        this.MAX_MERCATOR = this.WORLD_SIZE / 2;

        /**
         * Характерный размер «мира» в world-координатах карты для каллинга
         * (`margin`, `radius`) в deformed-режиме. Для Mercator-карт
         * совпадает с `WORLD_SIZE`; для остальных калибруется в
         * `_calibrateBaseDistance`.
         * @type {number}
         */
        this.WORLD_EXTENT = this.WORLD_SIZE;

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

        this.tileLighting          = options.tileLighting          ?? false;
        this.tileLightingRoughness = options.tileLightingRoughness ?? 0.7;
        this.tileLightingMetalness = options.tileLightingMetalness ?? 0.0;
        this.tileLightingEmissive  = options.tileLightingEmissive  ?? 0.5;

        this.CAMERA_TERRAIN_CLEARANCE =
            options.cameraTerrainClearance
            ?? options.minCameraHeightOffset
            ?? 5;

        this.continuousZoom = this.view.zoom;
        this.targetContinuousZoom = this.view.zoom;
        this.currentDiscreteZoom = this.view.zoom;

        /** @private */ this._disposed = false;
        /** @private */ this._paused = false;
        /** @private */ this._rafId = null;
        /** @private */ this._abortController = null;

        this.initThree();
        this.initControls();
        this.initDragTools();
        this.touchDragActive = false;
        this.touchDragLocalPoint = new THREE.Vector3();
        this.touchMouse = new THREE.Vector2();
        this.initTouchState();

        this._tempVec3a = new THREE.Vector3();
        this._tempVec3b = new THREE.Vector3();
        this._tempVec3c = new THREE.Vector3();
        this._tempDir = new THREE.Vector3();
        this._tempTarget = new THREE.Vector3();
        this._tempPlacementOut = new THREE.Vector3();
        this._tempRaycaster = new THREE.Raycaster();
        this._tempMouse = new THREE.Vector2();

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

        const demoElevLayer = this.layers.find(l => l.elevation === 'demo');
        if (demoElevLayer) {
            const provider = new NoiseElevationProvider({
                ...(demoElevLayer.noise || {}),
                heightScale: demoElevLayer.heightScale ?? 1,
            });
            this.tileManager.enableGeotiffElevation(provider);
        }

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

        // Калибровка масштаба под немеркаторовские проекции — см. метод.
        this._calibrateBaseDistance();

        this.lastVisibleUpdateTime = 0;
        this._lastWrapCheck = 0;
        this.clock = new THREE.Clock();

        this.bindEvents();
        this.maybeUpdateVisibleTiles(true);

        this.animate();
        requestAnimationFrame(() => initUI(this));
    }

    /**
     * Приводит `view.center` к проекции карты. После вызова:
     *  - `view.center`       — в CRS карты (world-координаты, y → -z);
     *  - `view.centerLonLat` — WGS84 (lon, lat);
     *  - `view.projection`   — код CRS карты.
     *
     * Приоритет источников — `centerLonLat`. Если задан только `center`,
     * он интерпретируется в `view.projection`.
     *
     * @private
     */
    _resolveViewCenter() {
        const v = this.view;
        const mapCode = this.projection.code;

        if (v.centerLonLat) {
            const [x, y] = this.projection.fromLonLat(v.centerLonLat);
            v.center = [x, -y];
            v.projection = mapCode;
            return;
        }

        const srcCode = v.projection ?? mapCode;
        if (srcCode === mapCode) {
            const [lon, lat] = this.projection.toLonLat([v.center[0], -v.center[1]]);
            v.centerLonLat = [lon, lat];
            v.projection = mapCode;
            return;
        }

        console.warn(
            `KrbMap: view.center пересчитан из ${srcCode} в ${mapCode}. ` +
            `Если view.center уже был в ${mapCode}, укажите ` +
            `view.projection = '${mapCode}' или передавайте координаты ` +
            `в centerLonLat.`
        );
        const src = typeof srcCode === 'string' ? Projections.get(srcCode) : srcCode;
        const lonLat = src.toLonLat([v.center[0], -v.center[1]]);
        const [x, y] = this.projection.fromLonLat(lonLat);
        v.centerLonLat = lonLat;
        v.center = [x, -y];
        v.projection = mapCode;
    }

    /**
     * Экранный AABB тайла уровня z под точкой (worldX, worldZ), в пикселях.
     * Возвращает null, если тайл выходит за домен проекции или камера
     * смотрит мимо.
     *
     * @private
     */
    _measureTileScreenSize(z, worldX, worldZ) {
        const [txf, tyf] = this.worldToTileIndex(worldX, worldZ, z);
        if (!Number.isFinite(txf) || !Number.isFinite(tyf)) return null;
        const tx = Math.floor(txf);
        const ty = Math.floor(tyf);
        const maxTile = (1 << z) - 1;
        if (ty < 0 || ty > maxTile) return null;

        const [x0, z0] = this.tileIndexToWorld(tx, ty, z);
        const [x1, z1] = this.tileIndexToWorld(tx + 1, ty + 1, z);
        if (![x0, z0, x1, z1].every(Number.isFinite)) return null;

        const canvas = this.renderer.domElement;
        const W = canvas.clientWidth;
        const H = canvas.clientHeight;
        if (W <= 0 || H <= 0) return null;

        this.camera.updateMatrixWorld();
        const v = new THREE.Vector3();
        let minSX = Infinity, maxSX = -Infinity;
        let minSY = Infinity, maxSY = -Infinity;

        const corners = [[x0, z0], [x1, z0], [x0, z1], [x1, z1]];
        for (const [wx, wz] of corners) {
            v.set(wx, 0, wz);
            v.project(this.camera);
            if (!Number.isFinite(v.x) || !Number.isFinite(v.y)) return null;
            const sx = (v.x + 1) * 0.5 * W;
            const sy = (1 - v.y) * 0.5 * H;
            if (sx < minSX) minSX = sx;
            if (sx > maxSX) maxSX = sx;
            if (sy < minSY) minSY = sy;
            if (sy > maxSY) maxSY = sy;
        }

        const width = maxSX - minSX;
        const height = maxSY - minSY;
        if (!Number.isFinite(width) || !Number.isFinite(height)) return null;
        if (width <= 0 || height <= 0) return null;

        return { width, height, size: Math.max(width, height) };
    }

    /**
     * Калибрует `BASE_DISTANCE` и `WORLD_EXTENT` под текущую проекцию:
     * после калибровки `continuousZoom = z` означает, что тайл уровня z
     * у `controls.target` рендерится в `TILE_PIXELS` пикселей.
     *
     * Достаточно одного измерения, потому что при `continuousZoom = z`
     * экранный размер тайла от z не зависит:
     *     (WORLD_EXTENT / 2^z) * focal / (BASE_DISTANCE * 2^(BASE_ZOOM-z))
     *     = const
     *
     * Для Mercator-карт с Mercator-тайлами (линейный путь) — no-op.
     *
     * @private
     */
    _calibrateBaseDistance() {
        if (this.projection.isMercator) return;
        if (!this.deformedTiles) return;

        const z = this.currentDiscreteZoom;
        const target = this.controls.target;
        const m = this._measureTileScreenSize(z, target.x, target.z);
        if (!m || !Number.isFinite(m.size) || m.size <= 0.01) {
            console.warn(
                `KrbMap: не удалось измерить экранный размер тайла для ${this.projection.code}, ` +
                `BASE_DISTANCE оставлен по умолчанию. Укажите options.baseDistance вручную, ` +
                `если масштаб выглядит неверно.`
            );
            return;
        }

        const factor = m.size / this.TILE_PIXELS;
        if (!Number.isFinite(factor) || factor <= 0) return;

        const oldBD = this.BASE_DISTANCE;
        const oldExtent = this.WORLD_EXTENT;
        const newBD = oldBD * factor;
        const newExtent = this.WORLD_SIZE * factor;

        if (!Number.isFinite(newBD) || newBD <= 0 ||
            !Number.isFinite(newExtent) || newExtent <= 0) {
            return;
        }

        this.BASE_DISTANCE = newBD;
        this.WORLD_EXTENT = newExtent;

        console.info(
            `KrbMap: BASE_DISTANCE калиброван для ${this.projection.code}: ` +
            `${oldBD.toFixed(0)} → ${newBD.toFixed(0)} (factor=${factor.toFixed(3)}), ` +
            `WORLD_EXTENT ${oldExtent.toFixed(0)} → ${newExtent.toFixed(0)}`
        );

        const newDist = this.getTargetDistanceForZoom(this.continuousZoom);
        const dir = new THREE.Vector3().subVectors(this.camera.position, target);
        if (dir.lengthSq() < 1e-6) return;
        dir.normalize().multiplyScalar(newDist);
        this.camera.position.copy(target).add(dir);
        this.camera.lookAt(target);
        this.controls.update();
    }

    /** @returns {THREE.Vector3} */
    getVec3() { return this._tempPool.v3[this._tempPool.idx++ & 15]; }

    /** @returns {THREE.Vector2} */
    getVec2() { return this._tempPool.v2[this._tempPool.idx++ & 15]; }

    /** @private */
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

    setAmbientLight(color, intensity = 0.8) {
        if (!this.ambientLight) { console.warn('Ambient light is not initialized.'); return; }
        this.ambientLight.color.set(color);
        this.ambientLight.intensity = intensity;
    }

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

    getAmbientLight() { return this.ambientLight || null; }
    getSunLight() { return this.sunLight || null; }

    /* ================================================================
       Преобразование координат
       ================================================================ */

    project(coord, fromCrs = this.inputCRS) {
        const src = typeof fromCrs === 'string' ? Projections.get(fromCrs) : fromCrs;
        if (src === this.projection) return [coord[0], -coord[1]];
        const lonLat = src.toLonLat(coord);
        const [x, y] = this.projection.fromLonLat(lonLat);
        return [x, -y];
    }

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

    unproject(worldCoord, toCrs = this.inputCRS) {
        const dst = typeof toCrs === 'string' ? Projections.get(toCrs) : toCrs;
        const std = [worldCoord[0], -worldCoord[1]];
        if (dst === this.projection) return std;
        const lonLat = this.projection.toLonLat(std);
        return dst.fromLonLat(lonLat);
    }

    projectLonLat(lon, lat) {
        const [x, y] = this.projection.fromLonLat([lon, lat]);
        return [x, -y];
    }

    unprojectToLonLat(x, z) {
        return this.projection.toLonLat([x, -z]);
    }

    /**
     * world (CRS карты) → дробный tile-индекс в `tileCRS`.
     *
     * В линейном режиме (Mercator-карта + Mercator-тайлы) — прямая
     * линейная формула. В deformed — через lon/lat: world → lon/lat
     * (map.projection), lon/lat → tile-world (tileCRS), tile-world →
     * tile-индекс.
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
        const tileWorld = typeof this.tileCRS.fromLonLatSafe === 'function'
            ? this.tileCRS.fromLonLatSafe(lonLat)
            : this.tileCRS.fromLonLat(lonLat);
        if (!tileWorld || !Number.isFinite(tileWorld[0]) || !Number.isFinite(tileWorld[1])) {
            return [NaN, NaN];
        }
        return [
            (tileWorld[0] + this.MAX_MERCATOR) / (2 * this.MAX_MERCATOR) * n,
            (this.MAX_MERCATOR - tileWorld[1]) / (2 * this.MAX_MERCATOR) * n
        ];
    }

    /**
     * tile-индекс (в `tileCRS`) → world (CRS карты). Обратная операция
     * к `worldToTileIndex`. В deformed-режиме — через lon/lat.
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

        const tileWorldX = (tx / n) * 2 * this.MAX_MERCATOR - this.MAX_MERCATOR;
        const tileWorldY = this.MAX_MERCATOR - (ty / n) * 2 * this.MAX_MERCATOR;
        const lonLat = this.tileCRS.toLonLat([tileWorldX, tileWorldY]);
        if (!lonLat || !Number.isFinite(lonLat[0]) || !Number.isFinite(lonLat[1])) {
            return [NaN, NaN];
        }
        const proj = typeof this.projection.fromLonLatSafe === 'function'
            ? this.projection.fromLonLatSafe(lonLat)
            : this.projection.fromLonLat(lonLat);
        if (!proj || !Number.isFinite(proj[0]) || !Number.isFinite(proj[1])) {
            return [NaN, NaN];
        }
        return [
            proj[0] + this.worldGroup.position.x,
            -proj[1] + this.worldGroup.position.z
        ];
    }

    /** @private */
    _wrapsLongitude() {
        const def = this.projection.def || '';
        return /\+proj=merc\b/.test(def) || /\+proj=longlat\b/.test(def);
    }

    /* ================================================================
       Управление камерой
       ================================================================ */

    /** @private */
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
    TWO: TOUCH_MAP_CONTROLS
};
        this.controls.maxPolarAngle = (85 * Math.PI) / 180;
        this.controls.minPolarAngle = 0.001;
        this.controls.enableDamping = true;
        this.controls.dampingFactor = 0.6;
        this.controls.rotateSpeed = 1;
        this.renderer.domElement.removeEventListener('wheel', this.controls.onMouseWheel);
    }

    /** @private */
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

    /** @private */
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

    /**
     * Размещает камеру по орбитальным параметрам (pitch/azimuth/dist)
     * так, чтобы она не оказалась под рельефом. Подробнее — см. историю.
     *
     * @private
     */
    _resolveCameraPlacement(target, desiredDist, desiredPitch, azimuth, outPos) {
        let dist = desiredDist;
        let pitch = Math.max(0.001, Math.min(Math.PI - 0.001, desiredPitch));

        if (this.hasElevation) {
            const clearance = this.CAMERA_TERRAIN_CLEARANCE;
            const targetTerrain = this.getSurfaceHeightAt(target.x, target.z);
            const minDistForTarget = targetTerrain + clearance;
            if (dist < minDistForTarget) dist = minDistForTarget;

            const cosAz = Math.cos(azimuth);
            const sinAz = Math.sin(azimuth);
            for (let iter = 0; iter < 6; iter++) {
                const sinP = Math.sin(pitch);
                const cosP = Math.cos(pitch);
                const camX = target.x + dist * sinP * cosAz;
                const camZ = target.z + dist * sinP * sinAz;
                const camY = target.y + dist * cosP;

                const terrain = this.getSurfaceHeightAt(camX, camZ);
                const requiredY = terrain + clearance;

                if (camY >= requiredY) break;

                const requiredCosP = Math.min(1, requiredY / dist);
                pitch = Math.acos(requiredCosP);
                if (pitch <= 0.001) { pitch = 0.001; break; }
            }
        }

        const sinP = Math.sin(pitch);
        const cosP = Math.cos(pitch);
        outPos.set(
            target.x + dist * sinP * Math.cos(azimuth),
            target.y + dist * cosP,
            target.z + dist * sinP * Math.sin(azimuth)
        );
        return { pitch, dist };
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

        const currentPitchRad = Math.acos(Math.max(-1, Math.min(1, dir.y / currentDistance)));
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

        const currentBearing = Math.atan2(-dir.x, dir.z);
        let delta = bearingRad - currentBearing;
        while (delta > Math.PI) delta -= 2 * Math.PI;
        while (delta < -Math.PI) delta += 2 * Math.PI;
        const endBearing = currentBearing + delta;

        this._cameraAnimations.bearing = {
            start: currentBearing,
            end: endBearing,
            startTime: performance.now(),
            duration
        };
        this._startCameraAnimationLoopIfNeeded();
    }

    /** @private */
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

            let currentPitch = Math.acos(Math.max(-1, Math.min(1, dir.y / currentDistance)));
            let currentBearing = Math.atan2(-dir.x, dir.z);

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
                currentBearing = anim.start + (anim.end - anim.start) * eased;
                if (t >= 1.0) this._cameraAnimations.bearing = null;
                else anyActive = true;
            }

            const azimuth = currentBearing + Math.PI / 2;
            this._resolveCameraPlacement(
                target, currentDistance, currentPitch, azimuth,
                this._tempPlacementOut
            );
            this.camera.position.copy(this._tempPlacementOut);
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

    /** @returns {string|null} */
    getTextureUrl(z, x, y) {
        const layer = this.layers[0];
        if (!layer || !layer.texture) return null;

        if (layer.texture === 'demo') {
            const n = 1 + Math.floor(Math.random() * 24);
            return new URL(`./demotiles/${n}.webp`, import.meta.url).href;
        }

        return layer.texture
            .replace(/\{z\}/g, z).replace(/\{x\}/g, x).replace(/\{y\}/g, y);
    }

    /** @returns {string|null} */
    getElevationUrl(z, x, y) {
        const layer = this.layers[0];
        if (!layer || !layer.elevation) return null;
        if (layer.elevation === 'demo') return null;
        return layer.elevation
            .replace(/\{z\}/g, z).replace(/\{x\}/g, x).replace(/\{y\}/g, y);
    }

    get maxObjectDistance() {
        if (!this.objectRenderDistanceFactor) return Infinity;
        const distToTarget = this.camera.position.distanceTo(this.controls.target);
        return distToTarget * this.objectRenderDistanceFactor;
    }

    /* ================================================================
       Источник высот
       ================================================================ */

    enableGeotiffElevation(layer) {
        if (!layer || !this.tileManager) return;

        this.hasElevation = true;
        if (!this.hasTileLayers) this.hasTileLayers = true;

        this.tileManager.enableGeotiffElevation(layer);
        this._surfaceMaxHeightCache.clear();
        this.maybeUpdateVisibleTiles(true);
    }

    disableGeotiffElevation() {
        if (!this.tileManager) return;
        this.tileManager.elevationProvider = null;
        this._surfaceMaxHeightCache.clear();
        this.maybeUpdateVisibleTiles(true);
    }

    /* ================================================================
       Высоты поверхности
       ================================================================ */

    /** @private */
    _setSurfaceMaxHeight(key, value) {
        this._surfaceMaxHeightCache.delete(key);
        this._surfaceMaxHeightCache.set(key, value);
        while (this._surfaceMaxHeightCache.size > this._surfaceMaxHeightCacheMaxSize) {
            const oldestKey = this._surfaceMaxHeightCache.keys().next().value;
            this._surfaceMaxHeightCache.delete(oldestKey);
        }
    }

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

    getSurfaceHeightAt(worldX, worldZ) {
        if (!this.hasElevation) return 0;
        const zMax = this.currentDiscreteZoom;
        const zMin = Math.max(0, this.MIN_RELIEF_Z);
        for (let zz = zMax; zz >= zMin; zz--) {
            const h = this._sampleHeightAtZoom(worldX, worldZ, zz);
            if (h !== null) return h;
        }
        return 0;
    }

    /** @private */
    _sampleHeightAtZoom(worldX, worldZ, z) {
        const maxTile = (1 << z) - 1;
        const [tx, ty] = this.worldToTileIndex(worldX, worldZ, z);
        if (!Number.isFinite(tx) || !Number.isFinite(ty)) return null;

        const virtX = Math.floor(tx);
        const y = Math.floor(ty);
        if (y < 0 || y > maxTile) return null;

        const inst = this.tileManager.tiles.get(getVirtKey(z, virtX, y));
        if (!inst || !inst.heightsApplied || !inst.mesh) return null;

        const u = tx - virtX;
        const v = ty - y;
        const seg = this.SEGMENTS;
        const pos = inst.geometry.attributes.position.array;
        const rowStride = seg + 1;
        const col = Math.min(seg, Math.max(0, Math.floor(u * seg)));
        const row = Math.min(seg, Math.max(0, Math.floor(v * seg)));
        const nc  = Math.min(seg, col + 1);
        const nr  = Math.min(seg, row + 1);

        const h00 = pos[(row * rowStride + col) * 3 + 1];
        const h10 = pos[(row * rowStride + nc ) * 3 + 1];
        const h01 = pos[(nr  * rowStride + col) * 3 + 1];
        const h11 = pos[(nr  * rowStride + nc ) * 3 + 1];

        const fu = (u * seg) - col;
        const fv = (v * seg) - row;
        const h0 = h00 + (h10 - h00) * fu;
        const h1 = h01 + (h11 - h01) * fu;
        return h0 + (h1 - h0) * fv + inst.mesh.position.y;
    }

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

    /* ================================================================
       Статический фон
       ================================================================ */

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
                    if (this._disposed || !this.tileManager || !this.staticBgGroup) return;
                    if (tex && mesh.parent === this.staticBgGroup) {
                        this.tileManager.setMeshTexture(mesh, tex);
                    }
                }).catch(() => {});
            }
        }
    }

    /* ================================================================
       Сдвиг мира
       ================================================================ */

    shiftWorld(dx, dz) {
        this.worldGroup.position.x -= dx;
        this.worldGroup.position.z -= dz;
    }

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

    onWheel(e) {
        if (this._cameraAnimation) return;
        e.preventDefault();
        const delta = -Math.sign(e.deltaY) * this.ZOOM_SENSITIVITY;
        this.applyZoomDelta(delta);
    }

    /* ================================================================
       Тач
       ================================================================ */

    getTouchDistance(touches) {
        const dx = touches[0].clientX - touches[1].clientX;
        const dy = touches[0].clientY - touches[1].clientY;
        return Math.sqrt(dx * dx + dy * dy);
    }

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

    findTouchById(touches, id) {
        for (let i = 0; i < touches.length; i++) {
            if (touches[i].identifier === id) return touches[i];
        }
        return null;
    }

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

    /** @private */
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

    applyZoomDistance() {
        if (this._cameraAnimation) return;
        const target = this._tempTarget.copy(this.controls.target);
        const currentDir = this._tempDir.subVectors(this.camera.position, target);
        const d0 = currentDir.length();
        if (d0 < 1e-6) return;
        currentDir.divideScalar(d0);

        const pitch = Math.acos(Math.max(-1, Math.min(1, currentDir.y)));
        const azimuth = Math.atan2(currentDir.z, currentDir.x);
        const desiredDist = this.getTargetDistanceForZoom(this.continuousZoom);

        this._resolveCameraPlacement(
            target, desiredDist, pitch, azimuth, this._tempPlacementOut
        );
        this.camera.position.copy(this._tempPlacementOut);
        this.camera.lookAt(target);
    }

    applyZoomDelta(delta) {
        this.targetContinuousZoom += delta;
        this.targetContinuousZoom = Math.max(this.MIN_ZOOM, Math.min(this.MAX_ZOOM, this.targetContinuousZoom));
        if (this.targetContinuousZoom > this.MAX_RELIEF_Z) {
            const futureCenter = this._tempVec3a.copy(this.controls.target);
            const neededParentZ = Math.min(Math.floor(this.targetContinuousZoom) - 1, this.MAX_RELIEF_Z);
            this.tileManager.prefetchParentElevations(futureCenter, neededParentZ, this.worldGroup.position);
        }
    }

    peekIdealZoom(continuousZoom) {
        const prev = this.currentDiscreteZoom;
        let idealZ = prev;
        if (continuousZoom >= prev + 0.6) idealZ = prev + 1;
        else if (continuousZoom <= prev - 0.6) idealZ = prev - 1;
        return Math.max(this.MIN_ZOOM, Math.min(this.MAX_ZOOM, idealZ));
    }

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

    /** @private */
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

        const startTarget = new THREE.Vector3().copy(this.controls.target);
        const startPos = new THREE.Vector3().copy(this.camera.position);
        const startZoom = this.continuousZoom;

        const [cx, cz] = this.projectLonLat(lon, lat);
        const worldOffset = this.worldGroup.position;
        const endTarget = new THREE.Vector3(cx + worldOffset.x, 0, cz + worldOffset.z);

        const currentDir = new THREE.Vector3().subVectors(startPos, startTarget).normalize();
        const animPitch = Math.acos(Math.max(-1, Math.min(1, currentDir.y)));
        const animAzimuth = Math.atan2(currentDir.z, currentDir.x);
        const endZoom = targetZoom !== null ? targetZoom : startZoom;

        const startTime = performance.now();
        this._cameraAnimation = {
            startTarget, endTarget,
            startZoom, endZoom,
            duration, startTime
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

            this._resolveCameraPlacement(
                currentTarget,
                this.getTargetDistanceForZoom(currentZoom),
                animPitch,
                animAzimuth,
                this._tempPlacementOut
            );
            this.camera.position.copy(this._tempPlacementOut);
            this.controls.target.copy(currentTarget);
            this.controls.update();

            this.continuousZoom = currentZoom;
            this.targetContinuousZoom = currentZoom;
            this.maybeUpdateVisibleTiles();

            if (t >= 1.0) {
                this._cameraAnimation = null;
                this.controls.enableDamping = this._controlsDampingWasEnabled;

                this._resolveCameraPlacement(
                    anim.endTarget,
                    this.getTargetDistanceForZoom(anim.endZoom),
                    animPitch,
                    animAzimuth,
                    this._tempPlacementOut
                );
                this.camera.position.copy(this._tempPlacementOut);
                this.controls.target.copy(anim.endTarget);
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

        const startTarget = new THREE.Vector3().copy(this.controls.target);
        const startPos = new THREE.Vector3().copy(this.camera.position);
        const dir = new THREE.Vector3().subVectors(startPos, startTarget);
        const startDistance = dir.length();
        if (startDistance < 1) return;

        const startPitch = Math.acos(Math.max(-1, Math.min(1, dir.y / startDistance)));
        const startBearing = Math.atan2(-dir.x, dir.z);
        const endBearing = 0;
        const endPitch = resetPitch ? 0.001 : startPitch;

        let endDistance = startDistance;
        if (resetPitch) {
            endDistance = this.getTargetDistanceForZoom(this.continuousZoom);
        }

        let deltaBearing = endBearing - startBearing;
        while (deltaBearing > Math.PI) deltaBearing -= 2 * Math.PI;
        while (deltaBearing < -Math.PI) deltaBearing += 2 * Math.PI;
        const deltaPitch = endPitch - startPitch;

        if (Math.abs(deltaBearing) < 0.001 && Math.abs(deltaPitch) < 0.001 &&
            Math.abs(endDistance - startDistance) < 1) return;

        this._controlsDampingWasEnabled = this.controls.enableDamping;
        this.controls.enableDamping = false;

        const startTime = performance.now();
        this._cameraAnimation = {
            startTarget, startBearing, startPitch, startDistance,
            endBearing, endPitch, endDistance, duration, startTime
        };

        const animateStep = (now) => {
            if (this._disposed || !this._cameraAnimation) return;
            const anim = this._cameraAnimation;
            let t = (now - anim.startTime) / (anim.duration * 1000);
            t = Math.min(t, 1.0);
            const eased = t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;

            const curBearing = anim.startBearing + (anim.endBearing - anim.startBearing) * eased;
            const curPitch   = anim.startPitch   + (anim.endPitch   - anim.startPitch)   * eased;
            const curDist    = anim.startDistance + (anim.endDistance - anim.startDistance) * eased;

            const azimuth = curBearing + Math.PI / 2;
            this._resolveCameraPlacement(
                anim.startTarget, curDist, curPitch, azimuth,
                this._tempPlacementOut
            );
            this.camera.position.copy(this._tempPlacementOut);
            this.controls.target.copy(anim.startTarget);
            this.controls.update();
            this.maybeUpdateVisibleTiles();

            if (t >= 1.0) {
                this._cameraAnimation = null;
                this.controls.enableDamping = this._controlsDampingWasEnabled;
                const endAz = anim.endBearing + Math.PI / 2;
                this._resolveCameraPlacement(
                    anim.startTarget, anim.endDistance, anim.endPitch, endAz,
                    this._tempPlacementOut
                );
                this.camera.position.copy(this._tempPlacementOut);
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

    /** @private */
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
        this._currentDeltaTime = 0;
    }

    resume() {
        if (this._disposed || !this._paused) return;
        this._paused = false;

        this.onResize();
        this.lastVisibleUpdateTime = 0;
        this.clock.getDelta();

        this.animate();
        this._currentDeltaTime = 0;
    }

    isPaused() { return this._paused; }
    isDisposed() { return this._disposed; }

    dispose() {
        if (this._disposed) return;
        this._disposed = true;

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

        if (this._abortController) {
            try { this._abortController.abort(); } catch (e) { console.warn(e); }
            this._abortController = null;
        }

        const managers = ['tileManager', 'textManager', 'popupManager', 'interaction'];
        for (const name of managers) {
            const m = this[name];
            if (m && typeof m.dispose === 'function') {
                try { m.dispose(); } catch (e) { console.warn(`KrbMap.dispose: ${name}.dispose() threw`, e); }
            }
            this[name] = null;
        }

        this._disposeObject3D(this.scene);

        if (this.controls && typeof this.controls.dispose === 'function') {
            try { this.controls.dispose(); } catch (e) { console.warn(e); }
        }
        this.controls = null;

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
        this._tempPlacementOut = null;
        this._tempRaycaster = null;
        this._tempMouse = null;
        this.targetElement = null;
    }

    /** @private */
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
        this._currentDeltaTime = deltaTime;

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