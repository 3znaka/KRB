// Core.ts
import { THREE } from './js_TP/tpb.js';
import { DEFAULTS } from './Utils.js';
import { Projections } from './Projections.js';
import { TileManager } from './Tiles.js';
import { TextManager } from './TextManager.js';
import { initUI } from './Ui.js';
import { PopupManager } from './PopupManager.js';
import { InteractionManager } from './Interaction.js';
import { NoiseElevationProvider } from './NoiseElevation.js';
import { View } from './View.js';

// Примеси
import { CoreElevationMixin } from './CoreElevation.js';
import { CoreCameraMixin } from './CoreCamera.js';
import { CoreCoordinatesMixin } from './CoreCoordinates.js';
import { CoreLayersMixin } from './CoreLayers.js';
import { CoreInputMixin } from './CoreInput.js';
import { CoreLifecycleMixin } from './CoreLifecycle.js';

// =====================================================================
// ИНТЕРФЕЙСЫ
// =====================================================================

export interface KrbMapOptions {
    target: string;
    layers?: any[];
    view: View;
    crs?: string;
    projection?: string;
    inputCRS?: string;
    zoomOffset?: number;
    minReliefZ?: number;
    maxReliefZ?: number;
    R?: number;
    segments?: number;
    animDuration?: number;
    tileMargin?: number;
    tileMarginBg?: number;
    visibleUpdateThrottle?: number;
    maxWorkerRequests?: number;
    baseZoom?: number;
    baseDistance?: number;
    objectRenderDistanceFactor?: number;
    staticBgZoom?: number;
    antialias?: boolean;
    tileLighting?: boolean;
    tileLightingRoughness?: number;
    tileLightingMetalness?: number;
    tileLightingEmissive?: number;
    cameraTerrainClearance?: number;
    minCameraHeightOffset?: number;
    autoPause?: boolean;
}

interface TouchState {
    isPinching: boolean;
    startDist: number;
    startZoom: number;
    accumulatedLineAngle: number;
    id0: number | null;
    id1: number | null;
}

// =====================================================================
// КЛАСС КАРТЫ
// =====================================================================

/**
 * Основной класс карты.
 *
 * Все "тяжёлые" группы методов разнесены по примесям:
 *   - CoreElevation   — рельеф, сэмплирование высот, калибровка BASE_DISTANCE
 *   - CoreCamera      — управление камерой, анимации, fitTo / fitToBounds
 *   - CoreCoordinates — проекции, тайловые индексы, URL-ы
 *   - CoreLayers      — порядок и видимость слоёв, tileManager, статичный фон
 *   - CoreInput       — мышь, тач, resize, shift-click
 *   - CoreLifecycle   — pause/resume, dispose, animation loop
 *
 * Класс ниже содержит только свойства, конструктор и несколько
 * самодостаточных вспомогательных методов (инициализация Three.js,
 * освещение, пул временных векторов).
 */
export class KrbMap {
    // --- Публичные свойства ---
    targetElement: HTMLElement;
    layers: any[];
    view: View;
    projection: any;
    inputCRS: any;
    hasTileLayers: boolean;
    R: number;
    WORLD_SIZE: number;
    MAX_MERCATOR: number;
    WORLD_EXTENT: number;
    TILE_PIXELS: number;
    SEGMENTS: number;
    ANIM_DURATION: number;
    MIN_ZOOM: number;
    MAX_ZOOM: number;
    ZOOM_SENSITIVITY: number;
    TILE_MARGIN: number;
    TILE_MARGIN_BG: number;
    VISIBLE_UPDATE_THROTTLE: number;
    MAX_WORKER_REQUESTS: number;
    BASE_ZOOM: number;
    BASE_DISTANCE: number;
    objectRenderDistanceFactor: number;
    staticBgZoom: number;
    antialias: boolean;
    tileLighting: boolean;
    tileLightingRoughness: number;
    tileLightingMetalness: number;
    tileLightingEmissive: number;
    CAMERA_TERRAIN_CLEARANCE: number;
    continuousZoom: number;
    targetContinuousZoom: number;
    currentDiscreteZoom: number;
    tileCRS: any;
    deformedTiles: boolean;

    globalElevCache: Map<any, any>;

    // --- Three.js объекты (пока any, т.к. THREE из tpb.js) ---
    scene: any;
    camera: any;
    renderer: any;
    controls: any;
    worldGroup: any;
    staticBgGroup: any;
    ambientLight: any;
    sunLight: any;
    groundPlane: any;
    raycasterDragger: any;
    mouse: any;
    intersection: any;
    touchMouse: any;
    touchDragLocalPoint: any;
    dragLocalPoint: any;
    clock: any;

    // --- Временные векторы (кэш) ---
    _tempVec3a: any;
    _tempVec3b: any;
    _tempVec3c: any;
    _tempDir: any;
    _tempTarget: any;
    _tempPlacementOut: any;
    _tempRaycaster: any;
    _tempMouse: any;
    _tempPool: {
        v3: any[];
        v2: any[];
        idx: number;
    };

    // --- Менеджеры (пока any, т.к. они не типизированы) ---
    textManager: any;
    popupManager: any;
    interaction: any;

    // --- Внутреннее состояние ---
    _rasterLayers: any[];
    _elevationLayer: any;
    _tileLayer: any;
    _elevationProvider: any;
    _tileManagers: any[];
    _dynamicLayers: any[];

    _surfaceMaxHeightCache: Map<string, number>;
    _surfaceMaxHeightCacheMaxSize: number;
    lastVisibleUpdateTime: number;
    _defaultZoomOffset: number;
    _defaultMinReliefZ: number | undefined;
    _defaultMaxReliefZ: number | undefined;

    _disposed: boolean;
    _paused: boolean;
    _pauseReasons: Set<string>;
    _autoPauseDisabled: boolean;
    _onVisChange: (() => void) | null;
    _io: IntersectionObserver | null;
    _rafId: number | null;
    _abortController: AbortController | null;

    _cameraAnimation: any;
    _cameraAnimations: { pitch: any, bearing: any };
    _cameraAnimFrame: number | null;
    _controlsDampingWasEnabled: boolean;
    _lastWrapCheck: number;
    _currentDeltaTime: number;

    touchDragActive: boolean;
    isDragging: boolean;
    _mouseDownX: number;
    _mouseDownY: number;
    _mouseMoved: boolean;
    touchState: TouchState;

    constructor(options: KrbMapOptions) {
        if (!options) throw new Error('Map constructor: options object is required');

        const el = document.getElementById(options.target);
        if (!el) throw new Error('Target element not found');
        this.targetElement = el;

        this.layers = options.layers || [];
        if (!options.view) throw new Error('View required');
        this.globalElevCache = new Map();
        this.view = options.view;
        this.hasTileLayers = this.layers.some((layer: any) => !!(layer.texture || layer.elevation));

        if (options.crs && options.projection && options.crs !== options.projection) {
            console.warn(
                `KrbMap: заданы и crs='${options.crs}', и projection='${options.projection}'; использую crs.`
            );
        }
        this.projection = Projections.get(options.crs ?? options.projection ?? 'EPSG:3857');
        this._resolveViewCenter();

        this.inputCRS = options.inputCRS
            ? Projections.get(options.inputCRS)
            : Projections.get('EPSG:4326');

        this._rasterLayers = this.layers.filter((l: any) => !!l.texture);
        this._elevationLayer = this.layers.find((l: any) => !!l.elevation) ?? null;
        this._tileLayer = this._rasterLayers[0] ?? this._elevationLayer ?? null;
        this._elevationProvider = null;

        this._surfaceMaxHeightCache = new Map();
        this._surfaceMaxHeightCacheMaxSize = 500;
        this.lastVisibleUpdateTime = 0;

        this._defaultZoomOffset = options.zoomOffset ?? 0;
        this._defaultMinReliefZ = undefined;
        this._defaultMaxReliefZ = undefined;

        if (options.zoomOffset !== undefined && this._tileLayer?.zoomOffset !== undefined) {
            console.warn(
                'KrbMap: заданы и options.zoomOffset, и zoomOffset у тайлового слоя; ' +
                'использую значение слоя. Уберите options.zoomOffset.'
            );
        }

        if (options.minReliefZ !== undefined) {
            console.warn('KrbMap: опция minReliefZ устарела, используйте Tile.minElevationNativeZoom.');
            if (this._elevationLayer) {
                this._elevationLayer.minElevationNativeZoom = options.minReliefZ;
            } else {
                this._defaultMinReliefZ = options.minReliefZ;
            }
        }
        if (options.maxReliefZ !== undefined) {
            console.warn('KrbMap: опция maxReliefZ устарела, используйте Tile.maxElevationNativeZoom.');
            if (this._elevationLayer) {
                this._elevationLayer.maxElevationNativeZoom = options.maxReliefZ;
            } else {
                this._defaultMaxReliefZ = options.maxReliefZ;
            }
        }

        const tileCrsCode = this._tileLayer?.crs ?? this._tileLayer?.projection ?? 'EPSG:3857';
        this.tileCRS = Projections.get(tileCrsCode);

        this.deformedTiles = this._rasterLayers.length > 0
            ? this._rasterLayers.some((l: any) => !this._isLayerLinear(l))
            : !(this.tileCRS === this.projection && this.projection.isMercator);

        this.R = options.R ?? DEFAULTS.R;
        this.WORLD_SIZE = 2 * Math.PI * this.R;
        this.MAX_MERCATOR = this.WORLD_SIZE / 2;
        this.WORLD_EXTENT = this.WORLD_SIZE;

        this.TILE_PIXELS = 256;
        this.SEGMENTS = options.segments ?? DEFAULTS.SEGMENTS;
        this.ANIM_DURATION = options.animDuration ?? DEFAULTS.ANIM_DURATION;
        this.MIN_ZOOM = this.view.minZoom;
        this.MAX_ZOOM = this.view.maxZoom;
        this.ZOOM_SENSITIVITY = this.view.zoomSensitivity;
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

        this._disposed = false;
        this._paused = false;
        this._pauseReasons = new Set();
        this._autoPauseDisabled = options.autoPause === false;
        this._onVisChange = null;
        this._io = null;
        this._rafId = null;
        this._abortController = null;

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

        const [cx, cz] = this.view.center!;
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

        this._tileManagers = this._rasterLayers.map((layer: any) => new TileManager(this, layer));

        for (const mgr of this._tileManagers) {
            mgr.onTileHeightAppliedCallbacks.push(() => {
                if (this._surfaceMaxHeightCache) this._surfaceMaxHeightCache.clear();
            });
        }

        this._rebuildLayerStack();

        if (this._elevationLayer && !this._rasterLayers.includes(this._elevationLayer)) {
            const primary = this._tileManagers[0];
            if (primary) primary.setElevationProvider(this._elevationLayer);
        }

        const demoElevLayer = this.layers.find((l: any) => l.elevation === 'demo');
        if (demoElevLayer) {
            const provider = new NoiseElevationProvider({
                ...(demoElevLayer.noise || {}),
                heightScale: demoElevLayer.heightScale ?? 1,
            });
            this.setElevationProvider(provider);
        }

        this.staticBgGroup = new THREE.Group();
        this.worldGroup.add(this.staticBgGroup);
        if (this._rasterLayers.length > 0) {
            this.createStaticBackgroundLayer();
        }

        this._calibrateBaseDistance();

        this._lastWrapCheck = 0;
        this.clock = new THREE.Clock();

        this.bindEvents();
        this.maybeUpdateVisibleTiles(true);

        this._setupAutoPause();

        this.animate();
        requestAnimationFrame(() => initUI(this));
    }

    /* ================================================================
       Three.js: сцена, камера, рендерер, свет
       ================================================================ */

    initThree(): void {
        this.scene = new THREE.Scene();
        this.scene.background = new THREE.Color(0xffffff);
        this.camera = new THREE.PerspectiveCamera(
            45,
            this.targetElement.clientWidth / this.targetElement.clientHeight,
            1,
            200000000
        );
        this.renderer = new THREE.WebGLRenderer({ antialias: this.antialias, powerPreference: 'high-performance',  logarithmicDepthBuffer: true,  });
        this.renderer.setSize(this.targetElement.clientWidth, this.targetElement.clientHeight);
        this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
        this.targetElement.appendChild(this.renderer.domElement);

        this.ambientLight = new THREE.AmbientLight(0xffffff, 0.8);
        this.scene.add(this.ambientLight);

        this.sunLight = new THREE.DirectionalLight(0xffffff, 3);
        this.sunLight.position.set(1, 2, 3);
        this.scene.add(this.sunLight);
    }

    setAmbientLight(color: any, intensity: number = 0.8): void {
        if (!this.ambientLight) { console.warn('Ambient light is not initialized.'); return; }
        this.ambientLight.color.set(color);
        this.ambientLight.intensity = intensity;
    }

    setSunLight(color: any, intensity: number = 1.3, position: any = null): void {
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

    setLighting({ ambientColor, ambientIntensity, sunColor, sunIntensity, sunPosition }: any = {}): void {
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

    getAmbientLight(): any { return this.ambientLight || null; }
    getSunLight(): any { return this.sunLight || null; }

    /* ================================================================
       Пул временных векторов
       ================================================================ */

    getVec3(): any { return this._tempPool.v3[this._tempPool.idx++ & 15]; }
    getVec2(): any { return this._tempPool.v2[this._tempPool.idx++ & 15]; }
}


function applyMixin(target: any, mixin: any): void {
    const descriptors = Object.getOwnPropertyDescriptors(mixin);
    delete descriptors.constructor;
    Object.defineProperties(target, descriptors);
}

applyMixin(KrbMap.prototype, CoreElevationMixin);
applyMixin(KrbMap.prototype, CoreCameraMixin);
applyMixin(KrbMap.prototype, CoreCoordinatesMixin);
applyMixin(KrbMap.prototype, CoreLayersMixin);
applyMixin(KrbMap.prototype, CoreInputMixin);
applyMixin(KrbMap.prototype, CoreLifecycleMixin);