import {
  THREE,
  OrbitControls,
  TOUCH_MAP_CONTROLS
} from './js_TP/tpb.js';
import { DEFAULTS, getOriginZ, getVirtKey } from './Utils.js';
import { Projections } from './Projections.js';
import { TileManager } from './Tiles.js';
import { TextManager } from './TextManager.js';
import { initUI } from './Ui.js';
import { PopupManager } from './PopupManager.js';
import { InteractionManager } from './Interaction.js';
import { NoiseElevationProvider } from './NoiseElevation.js';
import { View } from './View.js';

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
 * Основной класс карты: сцена, слои, камера, ввод.
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
        this.globalElevCache = new Map(); // (нет в объявлении выше, добавил через any)
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

    // Заглушка, так как globalElevCache не был объявлен в свойствах выше
    globalElevCache: Map<any, any>;

    /* ================================================================
       Рельеф: источник, API
       ================================================================ */

    get hasElevation(): boolean {
        if (this._elevationProvider) return true;
        if (this._elevationLayer) return true;
        const mgrs = this._tileManagers;
        if (!mgrs) return false;
        return mgrs.some((m: any) => !!m.layer?.elevation);
    }

    get elevationProvider(): any {
        return this._elevationProvider;
    }

    setElevationProvider(provider: any): void {
        if (this._elevationProvider === provider) return;
        this._elevationProvider = provider;
        for (const mgr of this._tileManagers) {
            mgr.setElevationProvider(provider);
        }
        this._surfaceMaxHeightCache?.clear();
    }

    enableGeotiffElevation(layer: any): void {
        if (!layer) return;
        this.setElevationProvider(layer);
        if (this._disposed) return;
        if (!this.hasTileLayers) this.hasTileLayers = true;
        this.lastVisibleUpdateTime = 0;
        this.maybeUpdateVisibleTiles(true);
    }

    disableGeotiffElevation(): void {
        this.setElevationProvider(null);
        if (this._disposed) return;
        this.lastVisibleUpdateTime = 0;
        this.maybeUpdateVisibleTiles(true);
    }

    get tileManager(): any | null {
        return this._tileManagers?.[0] ?? null;
    }

    /* ================================================================
       Слои: порядок, видимость
       ================================================================ */

    _isLayerLinear(layer: any): boolean {
        if (!layer) return true;
        const code = layer.crs ?? layer.projection ?? 'EPSG:3857';
        const crs = typeof code === 'string' ? Projections.get(code) : code;
        return crs === this.projection && this.projection.isMercator;
    }

    _getLayersInOrder(): any[] {
        return [...new Set([...this.layers, ...this._dynamicLayers])].filter(Boolean);
    }

    _getLayerIndex(layer: any): number {
        return this._getLayersInOrder().indexOf(layer);
    }

    _getLayerRenderOrder(layer: any): number {
        const stack = this._getLayersInOrder();
        const index = stack.indexOf(layer);
        return (index < 0 ? stack.length : index) * 1000;
    }

    _getDynamicLayerRenderOrder(layer: any): number {
        return this._getLayerRenderOrder(layer);
    }

    _applyLayerRenderOrder(layer: any, newBase: number): void {
        if (!layer) return;
        layer.baseRenderOrder = newBase;

        const mgr = this._tileManagers.find((m: any) => m.layer === layer);
        if (mgr) {
            for (const inst of mgr.tiles.values()) {
                if (inst.mesh) inst.mesh.renderOrder = newBase + inst.z;
            }
        }

        if (typeof layer._applyRenderOrder === 'function') {
            layer._applyRenderOrder(newBase);
        }
    }

    _rebuildLayerStack(): void {
        this._getLayersInOrder().forEach((layer: any, index: number) => {
            this._applyLayerRenderOrder(layer, index * 1000);
        });
    }

    setLayerOrder(layer: any, index: number): void {
        if (this._disposed || !Number.isFinite(index)) return;

        const stack = this._getLayersInOrder();
        const currentIndex = stack.indexOf(layer);
        if (currentIndex < 0) return;

        const targetIndex = Math.max(0, Math.min(Math.trunc(index), stack.length - 1));
        if (currentIndex === targetIndex) {
            this._rebuildLayerStack();
            return;
        }

        const primaryCount = new Set(this.layers.filter(Boolean)).size;
        stack.splice(currentIndex, 1);
        stack.splice(targetIndex, 0, layer);

        this.layers.splice(0, this.layers.length, ...stack.slice(0, primaryCount));
        this._dynamicLayers.splice(0, this._dynamicLayers.length, ...stack.slice(primaryCount));

        this._rebuildLayerStack();
        this.maybeUpdateVisibleTiles(true);
    }

    bringToFront(layer: any): void {
        this.setLayerOrder(layer, this._getLayersInOrder().length - 1);
    }

    sendToBack(layer: any): void {
        this.setLayerOrder(layer, 0);
    }

    setLayerVisible(layer: any, visible: boolean): void {
        if (this._disposed || !layer) return;
        const value = !!visible;

        if (typeof layer.setVisible === 'function') layer.setVisible(value);
        else layer.visible = value;

        const mgr = this._tileManagers.find((m: any) => m.layer === layer);
        if (mgr) mgr.setVisible(value);

        this.maybeUpdateVisibleTiles(true);
    }

    setLayerOpacity(layer: any, opacity: number): void {
        const mgr = this._tileManagers.find((m: any) => m.layer === layer);
        if (!mgr) return;
        mgr.setOpacity(opacity);
        this.maybeUpdateVisibleTiles(true);
    }

    /* ================================================================
       Авто-пауза
       ================================================================ */

    _setupAutoPause(): void {
        if (this._autoPauseDisabled) return;

        const apply = () => {
            if (this._disposed) return;
            const shouldPause = this._pauseReasons.size > 0;
            if (shouldPause && !this._paused) this._doPause();
            else if (!shouldPause && this._paused) this._doResume();
        };

        this._onVisChange = () => {
            if (document.hidden) this._pauseReasons.add('tab');
            else this._pauseReasons.delete('tab');
            apply();
        };
        document.addEventListener('visibilitychange', this._onVisChange);

        if (typeof IntersectionObserver !== 'undefined' && this.targetElement) {
            this._io = new IntersectionObserver(entries => {
                for (const e of entries) {
                    if (e.isIntersecting) this._pauseReasons.delete('viewport');
                    else this._pauseReasons.add('viewport');
                }
                apply();
            }, { rootMargin: '200px' });
            this._io.observe(this.targetElement);
        }

        if (document.hidden) {
            this._pauseReasons.add('tab');
            apply();
        }
    }

    /* ================================================================
       Приведение view.center к CRS карты
       ================================================================ */

    _resolveViewCenter(): void {
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
            const [lon, lat] = this.projection.toLonLat([v.center![0], -v.center![1]]);
            v.centerLonLat = [lon, lat];
            v.projection = mapCode;
            return;
        }

        console.warn(
            `KrbMap: view.center пересчитан из ${srcCode} в ${mapCode}. ` +
            `Если view.center уже был в ${mapCode}, укажите ` +
            `view.projection = '${mapCode}' или передавайте координаты в centerLonLat.`
        );
        const src = typeof srcCode === 'string' ? Projections.get(srcCode) : srcCode;
        const lonLat = src.toLonLat([v.center![0], -v.center![1]]);
        const [x, y] = this.projection.fromLonLat(lonLat);
        v.centerLonLat = lonLat;
        v.center = [x, -y];
        v.projection = mapCode;
    }

    _measureTileScreenSize(z: number, worldX: number, worldZ: number, crs: any): { width: number, height: number, size: number } | null {
        const [txf, tyf] = this.worldToTileIndex(worldX, worldZ, z, crs);
        if (!Number.isFinite(txf) || !Number.isFinite(tyf)) return null;
        const tx = Math.floor(txf);
        const ty = Math.floor(tyf);
        const maxTile = (1 << z) - 1;
        if (ty < 0 || ty > maxTile) return null;

        const [x0, z0] = this.tileIndexToWorld(tx, ty, z, crs);
        const [x1, z1] = this.tileIndexToWorld(tx + 1, ty + 1, z, crs);
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

    _calibrateBaseDistance(): void {
        if (this.projection.isMercator) return;

        const refLayer = this._rasterLayers[0] ?? null;
        if (!refLayer) return;

        const z = this.currentDiscreteZoom;
        const target = this.controls.target;
        const crs = refLayer.crs ?? 'EPSG:3857';
        const m = this._measureTileScreenSize(z, target.x, target.z, crs);
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

    getVec3(): any { return this._tempPool.v3[this._tempPool.idx++ & 15]; }
    getVec2(): any { return this._tempPool.v2[this._tempPool.idx++ & 15]; }

    initThree(): void {
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
       Преобразование координат
       ================================================================ */

    project(coord: number[], fromCrs: any = this.inputCRS): number[] {
        const src = typeof fromCrs === 'string' ? Projections.get(fromCrs) : fromCrs;
        if (src === this.projection) return [coord[0], -coord[1]];
        const lonLat = src.toLonLat(coord);
        const [x, y] = this.projection.fromLonLat(lonLat);
        return [x, -y];
    }

    projectSafe(coord: number[], fromCrs: any = this.inputCRS): number[] | null {
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

    unproject(worldCoord: number[], toCrs: any = this.inputCRS): number[] {
        const dst = typeof toCrs === 'string' ? Projections.get(toCrs) : toCrs;
        const std = [worldCoord[0], -worldCoord[1]];
        if (dst === this.projection) return std;
        const lonLat = this.projection.toLonLat(std);
        return dst.fromLonLat(lonLat);
    }

projectLonLat(lon: number, lat: number): [number, number] {
    const [x, y] = this.projection.fromLonLat([lon, lat]);
    return [x, -y];
}

unprojectToLonLat(x: number, z: number): [number, number] {
    return this.projection.toLonLat([x, -z]);
}

    worldToTileIndex(worldX: number, worldZ: number, z: number, crs: any = null): number[] {
        const useCrs = crs
            ? (typeof crs === 'string' ? Projections.get(crs) : crs)
            : this._layerCrsOrProjection();

        const isLinear = useCrs === this.projection && this.projection.isMercator;

        const lx = worldX - this.worldGroup.position.x;
        const lz = worldZ - this.worldGroup.position.z;
        const n = 1 << z;

        if (isLinear) {
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
        const tileWorld = typeof useCrs.fromLonLatSafe === 'function'
            ? useCrs.fromLonLatSafe(lonLat)
            : useCrs.fromLonLat(lonLat);
        if (!tileWorld || !Number.isFinite(tileWorld[0]) || !Number.isFinite(tileWorld[1])) {
            return [NaN, NaN];
        }
        return [
            (tileWorld[0] + this.MAX_MERCATOR) / (2 * this.MAX_MERCATOR) * n,
            (this.MAX_MERCATOR - tileWorld[1]) / (2 * this.MAX_MERCATOR) * n
        ];
    }

    tileIndexToWorld(tx: number, ty: number, z: number, crs: any = null): number[] {
        const useCrs = crs
            ? (typeof crs === 'string' ? Projections.get(crs) : crs)
            : this._layerCrsOrProjection();

        const isLinear = useCrs === this.projection && this.projection.isMercator;
        const n = 1 << z;

        if (isLinear) {
            const tileSize = this.WORLD_SIZE / n;
            return [
                tx * tileSize - this.MAX_MERCATOR + this.worldGroup.position.x,
                ty * tileSize - this.MAX_MERCATOR + this.worldGroup.position.z
            ];
        }

        const tileWorldX = (tx / n) * 2 * this.MAX_MERCATOR - this.MAX_MERCATOR;
        const tileWorldY = this.MAX_MERCATOR - (ty / n) * 2 * this.MAX_MERCATOR;
        const lonLat = useCrs.toLonLat([tileWorldX, tileWorldY]);
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

    _layerCrsOrProjection(): any {
        const layer = this._tileLayer;
        if (!layer) return this.projection;
        const code = layer.crs ?? layer.projection ?? 'EPSG:3857';
        return typeof code === 'string' ? Projections.get(code) : code;
    }

    _wrapsLongitude(): boolean {
        const def = this.projection.def || '';
        return /\+proj=merc\b/.test(def) || /\+proj=longlat\b/.test(def);
    }

    /* ================================================================
       Управление камерой
       ================================================================ */

    initControls(): void {
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

    initDragTools(): void {
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

    initTouchState(): void {
        this.touchState = {
            isPinching: false,
            startDist: 0,
            startZoom: 0,
            accumulatedLineAngle: 0,
            id0: null,
            id1: null
        };
    }

    _resolveCameraPlacement(target: any, desiredDist: number, desiredPitch: number, azimuth: number, outPos: any): { pitch: number, dist: number } {
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

    setPitch(pitchDeg: number, duration: number = 0.3): void {
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
            start: currentPitchRad, end: clampedRad,
            startTime: performance.now(), duration
        };
        this._startCameraAnimationLoopIfNeeded();
    }

    setBearing(bearingDeg: number, duration: number = 0.3): void {
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
            start: currentBearing, end: endBearing,
            startTime: performance.now(), duration
        };
        this._startCameraAnimationLoopIfNeeded();
    }

    _startCameraAnimationLoopIfNeeded(): void {
        if (this._disposed || this._paused) return;
        if (this._cameraAnimation || this._cameraAnimFrame) return;

        this._cameraAnimation = { custom: true };
        this._controlsDampingWasEnabled = this.controls.enableDamping;
        this.controls.enableDamping = false;

        const animateStep = (now: number) => {
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

    resetBearing(): void { this.rotateToNorth(0.3); }

    getTargetDistanceForZoom(z: number): number {
        const canvas = this.renderer?.domElement;
        const H = canvas ? canvas.clientHeight : 0;
        const fov = this.camera?.fov ?? 45;

        if (H <= 0) {
            return this.BASE_DISTANCE * Math.pow(0.5, z - this.BASE_ZOOM);
        }

        const tanHalfFov = Math.tan((fov * Math.PI) / 360);
        return (this.WORLD_SIZE / Math.pow(2, z)) * H
             / (2 * this.TILE_PIXELS * tanHalfFov);
    }

    getZoomForDistance(d: number): number {
        if (!(d > 0) || !isFinite(d)) return this.continuousZoom;

        const canvas = this.renderer?.domElement;
        const H = canvas ? canvas.clientHeight : 0;
        const fov = this.camera?.fov ?? 45;

        if (H <= 0) {
            return this.BASE_ZOOM + Math.log2(this.BASE_DISTANCE / d);
        }

        const tanHalfFov = Math.tan((fov * Math.PI) / 360);
        const K = H / (2 * this.TILE_PIXELS * tanHalfFov);

        return Math.log2((this.WORLD_SIZE * K) / d);
    }

    getTextureUrl(layer: any, z: number, x: number, y: number): string | null {
        if (!layer || !layer.texture) return null;

        if (layer.texture === 'demo') {
            const n = 1 + Math.floor(Math.random() * 24);
            return new URL(`./demotiles/${n}.webp`, import.meta.url).href;
        }

        return layer.texture
            .replace(/\{z\}/g, z).replace(/\{x\}/g, x).replace(/\{y\}/g, y);
    }

    getElevationUrl(layer: any, z: number, x: number, y: number): string | null {
        const elevLayer = (layer && layer.elevation) ? layer : this._elevationLayer;
        if (!elevLayer || !elevLayer.elevation) return null;
        if (elevLayer.elevation === 'demo') return null;
        return elevLayer.elevation
            .replace(/\{z\}/g, z).replace(/\{x\}/g, x).replace(/\{y\}/g, y);
    }

    get maxObjectDistance(): number {
        if (!this.objectRenderDistanceFactor) return Infinity;
        const distToTarget = this.camera.position.distanceTo(this.controls.target);
        return distToTarget * this.objectRenderDistanceFactor;
    }

    get zoomOffset(): number {
        const z = this._tileLayer?.zoomOffset;
        return (z !== undefined && z !== null) ? z : this._defaultZoomOffset;
    }

    set zoomOffset(v: number) {
        if (this._tileLayer) this._tileLayer.zoomOffset = v;
        else this._defaultZoomOffset = v;

        if (this._disposed) return;
        if (this._surfaceMaxHeightCache) this._surfaceMaxHeightCache.clear();
        this.lastVisibleUpdateTime = 0;
        this.maybeUpdateVisibleTiles(true);
    }

    get targetZoom(): number {
        return this._cameraAnimation?.endZoom ?? this.targetContinuousZoom;
    }

    getTileZoom(layer: any): number {
        const z = this.currentDiscreteZoom + (layer?.zoomOffset ?? 0);
        const min = layer?.minNativeZoom ?? this.MIN_ZOOM;
        const max = layer?.maxNativeZoom ?? this.MAX_ZOOM;
        return Math.max(min, Math.min(max, z));
    }

    get tileZoom(): number {
        const layer = this._elevationLayer ?? this._tileLayer;
        if (!layer) return this.currentDiscreteZoom;
        return this.getTileZoom(layer);
    }

    get MIN_RELIEF_Z(): number {
        return this._elevationLayer?.minElevationNativeZoom
            ?? this._defaultMinReliefZ
            ?? DEFAULTS.MIN_RELIEF_Z;
    }

    get MAX_RELIEF_Z(): number {
        return this._elevationLayer?.maxElevationNativeZoom
            ?? this._defaultMaxReliefZ
            ?? DEFAULTS.MAX_RELIEF_Z;
    }

    maybeUpdateVisibleTiles(force: boolean = false): void {
        if (this._disposed) return;

        const now = performance.now();
        const newZoom = this.peekIdealZoom(this.continuousZoom);
        const zoomChanged = newZoom !== this.currentDiscreteZoom;
        this.currentDiscreteZoom = newZoom;

        if (!force && !zoomChanged &&
            now - this.lastVisibleUpdateTime < this.VISIBLE_UPDATE_THROTTLE) return;

        this.lastVisibleUpdateTime = now;
        if (!this._tileManagers.length) return;

        this.camera.updateMatrixWorld(true);
        this.worldGroup.updateMatrixWorld(true);

        for (const mgr of this._tileManagers) {
            mgr.update(this.camera, this.controls.target, this.continuousZoom, this.worldGroup.position);
        }
    }

    moveCameraTo(lon: number, lat: number, targetZoom: number | null = null): void {
        this.moveCameraToSlow(lon, lat, 0, targetZoom);
    }

    _wrapLongitudeIfNeeded(): void {
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

    moveCameraToSlow(lon: number, lat: number, duration: number = 1.0, targetZoom: number | null = null): void {
        if (this._disposed) return;

        if (!(duration > 0)) {
            if (this._cameraAnimation) {
                this._cameraAnimation = null;
                if (this._cameraAnimFrame !== null) {
                    cancelAnimationFrame(this._cameraAnimFrame);
                    this._cameraAnimFrame = null;
                }
                this._cameraAnimations.pitch = null;
                this._cameraAnimations.bearing = null;
                this.controls.enableDamping = this._controlsDampingWasEnabled;
            }

            const [cx, cz] = this.projectLonLat(lon, lat);
            const off = this.worldGroup.position;
            const endTarget = this._tempVec3a.set(cx + off.x, 0, cz + off.z);

            const currentDir = this._tempDir.subVectors(this.camera.position, this.controls.target);
            const dist0 = currentDir.length();
            const animPitch = dist0 > 1e-6
                ? Math.acos(Math.max(-1, Math.min(1, currentDir.y / dist0)))
                : 0.001;
            const animAzimuth = Math.atan2(currentDir.z, currentDir.x);

            const endZoom = targetZoom !== null ? targetZoom : this.continuousZoom;

            this._resolveCameraPlacement(
                endTarget,
                this.getTargetDistanceForZoom(endZoom),
                animPitch,
                animAzimuth,
                this._tempPlacementOut
            );
            this.camera.position.copy(this._tempPlacementOut);
            this.controls.target.copy(endTarget);
            this.controls.update();

            this.continuousZoom = endZoom;
            this.targetContinuousZoom = endZoom;
            this.maybeUpdateVisibleTiles(true);
            return;
        }

        if (this._cameraAnimation) return;

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
            startTarget, endTarget, startZoom, endZoom, duration, startTime
        };

        this._controlsDampingWasEnabled = this.controls.enableDamping;
        this.controls.enableDamping = false;

        const animateStep = (now: number) => {
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

    rotateToNorth(duration: number = 0.3, resetPitch: boolean = true): void {
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

        const animateStep = (now: number) => {
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

    fitToBounds(bounds: number[][], options: { crs?: any, padding?: number | number[], duration?: number, maxZoom?: number } = {}): void {
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
        let z = this.getZoomForDistance(D);
        if (!isFinite(z)) z = this.continuousZoom;
        z = Math.max(this.MIN_ZOOM, Math.min(maxZoom, z));

        this.moveCameraToSlow(targetLon, targetLat, duration, z);
    }

    fitTo(objectOrArray: any, options: { crs?: any, [key: string]: any } = {}): void {
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

    _computeFitDistance(targetX: number, targetZ: number, halfW: number, halfH: number, padX: number, padY: number): number {
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

    _setSurfaceMaxHeight(key: string, value: number): void {
        this._surfaceMaxHeightCache.delete(key);
        this._surfaceMaxHeightCache.set(key, value);
        while (this._surfaceMaxHeightCache.size > this._surfaceMaxHeightCacheMaxSize) {
            const oldestKey = this._surfaceMaxHeightCache.keys().next().value!;
            this._surfaceMaxHeightCache.delete(oldestKey);
        }
    }

    getSurfaceMaxHeight(worldX: number, worldZ: number): number {
        if (!this.hasElevation) return 0;

        const provider = this._elevationProvider;
        if (provider && typeof provider.getTileMaxHeight === 'function') {
            for (const mgr of this._tileManagers) {
                if (!mgr.hasElevation) continue;
                const elevLayer = mgr.layer;
                const crs = elevLayer?.crs ?? 'EPSG:3857';
                const z = this.getTileZoom(elevLayer);
                const [tx, ty] = this.worldToTileIndex(worldX, worldZ, z, crs);
                if (!Number.isFinite(tx) || !Number.isFinite(ty)) continue;
                const h = provider.getTileMaxHeight(z, Math.floor(tx), Math.floor(ty), this.SEGMENTS);
                if (Number.isFinite(h)) return h;
            }
        }

        let best = 0;
        for (let mi = 0; mi < this._tileManagers.length; mi++) {
            const mgr = this._tileManagers[mi];
            if (!mgr.hasElevation) continue;
            const h = this._sampleMaxHeightFromManager(mi, mgr, worldX, worldZ);
            if (h > best) best = h;
        }
        return best;
    }

    _sampleMaxHeightFromManager(mgrIdx: number, mgr: any, worldX: number, worldZ: number): number {
        const elevLayer = mgr.layer;
        const crs = elevLayer?.crs ?? 'EPSG:3857';
        const z = this.getTileZoom(elevLayer);
        const maxTile = (1 << z) - 1;

        const [tx, ty] = this.worldToTileIndex(worldX, worldZ, z, crs);
        if (!Number.isFinite(tx) || !Number.isFinite(ty)) return 0;

        const virtX = Math.floor(tx);
        const y = Math.floor(ty);
        if (y < 0 || y > maxTile) return 0;

        const vk = `${mgrIdx},${getVirtKey(z, virtX, y)}`;
        if (this._surfaceMaxHeightCache.has(vk)) return this._surfaceMaxHeightCache.get(vk)!;

        const inst = mgr.tiles.get(getVirtKey(z, virtX, y));
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

    getSurfaceHeightAt(worldX: number, worldZ: number): number {
        if (!this.hasElevation) return 0;

        const provider = this._elevationProvider;
        if (provider && typeof provider.sampleAtWorld === 'function') {
            const h = provider.sampleAtWorld(worldX, worldZ, this);
            if (h !== null && h !== undefined && Number.isFinite(h)) return h;
        }

        for (const mgr of this._tileManagers) {
            if (!mgr.hasElevation) continue;
            if (mgr._elevationProvider) continue;
            const h = this._sampleHeightFromManager(mgr, worldX, worldZ);
            if (h !== null) return h;
        }
        return 0;
    }

    _sampleHeightFromManager(mgr: any, worldX: number, worldZ: number): number | null {
        const elevLayer = mgr.layer;
        const crs = elevLayer?.crs ?? 'EPSG:3857';
        const zMax = this.getTileZoom(elevLayer);
        const zMin = Math.max(0, mgr._minElevationNativeZoom);
        for (let zz = zMax; zz >= zMin; zz--) {
            const h = this._sampleHeightAtZoom(mgr, worldX, worldZ, zz, crs);
            if (h !== null) return h;
        }
        return null;
    }

    _sampleHeightAtZoom(mgr: any, worldX: number, worldZ: number, z: number, crs: any): number | null {
        const maxTile = (1 << z) - 1;
        const [tx, ty] = this.worldToTileIndex(worldX, worldZ, z, crs);
        if (!Number.isFinite(tx) || !Number.isFinite(ty)) return null;

        const virtX = Math.floor(tx);
        const y = Math.floor(ty);
        if (y < 0 || y > maxTile) return null;

        const inst = mgr.tiles.get(getVirtKey(z, virtX, y));
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

    ensureTileForPoint(worldX: number, worldZ: number): void {
        for (const mgr of this._tileManagers) {
            if (!mgr.hasElevation) continue;
            const elevLayer = mgr.layer;
            const crs = elevLayer?.crs ?? 'EPSG:3857';
            const z = this.getTileZoom(elevLayer);
            const maxTile = (1 << z) - 1;

            const [tx, ty] = this.worldToTileIndex(worldX, worldZ, z, crs);
            if (!Number.isFinite(tx) || !Number.isFinite(ty)) continue;

            const virtX = Math.floor(tx);
            const y = Math.floor(ty);
            if (y < 0 || y > maxTile) continue;
            mgr.ensureTile(z, virtX, y);
        }
    }

    createStaticBackgroundLayer(): void {
        if (this._rasterLayers.length === 0) return;
        const bgLayer = this._rasterLayers[0];
        if (!this._isLayerLinear(bgLayer)) return;

        while (this.staticBgGroup.children.length > 0) {
            const child = this.staticBgGroup.children[0];
            this.staticBgGroup.remove(child);
            if (child.geometry) child.geometry.dispose();
            if (child.material) {
                if (child.material.map) child.material.map.dispose();
                child.material.dispose();
            }
        }

        const mgr = this._tileManagers[0];
        if (!mgr) return;

        const z = this.staticBgZoom;
        const tileSize = this.WORLD_SIZE / Math.pow(2, z);
        const maxTile = (1 << z) - 1;

        for (let y = 0; y <= maxTile; y++) {
            const originZ = getOriginZ(y, tileSize, this.MAX_MERCATOR);
            for (let x = 0; x <= maxTile; x++) {
                const originX = x * tileSize - this.MAX_MERCATOR;
                const texUrl = this.getTextureUrl(bgLayer, z, x, y);

                const mesh = mgr.createStaticTileMesh(tileSize, originX, originZ, null);
                this.staticBgGroup.add(mesh);

                mgr.loadTextureAsync(texUrl).then((tex: any) => {
                    if (this._disposed || !mgr || !this.staticBgGroup) return;
                    if (tex && mesh.parent === this.staticBgGroup) {
                        mgr.setMeshTexture(mesh, tex);
                    }
                }).catch(() => {});
            }
        }
    }

    shiftWorld(dx: number, dz: number): void {
        this.worldGroup.position.x -= dx;
        this.worldGroup.position.z -= dz;
    }

    syncControlsTarget(): void {
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

    onMouseDown(e: MouseEvent): void {
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

    onMouseMove(e: MouseEvent): void {
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

    onMouseUp(): void {
        if (!this.isDragging) return;
        this.isDragging = false;
        if (this._cameraAnimation) return;
        this.syncControlsTarget();
    }

    onWheel(e: WheelEvent): void {
        if (this._cameraAnimation) return;
        e.preventDefault();
        const delta = -Math.sign(e.deltaY) * this.ZOOM_SENSITIVITY;
        this.applyZoomDelta(delta);
    }

    /* ================================================================
       Тач
       ================================================================ */

    getTouchDistance(touches: TouchList): number {
        const dx = touches[0].clientX - touches[1].clientX;
        const dy = touches[0].clientY - touches[1].clientY;
        return Math.sqrt(dx * dx + dy * dy);
    }

    onTouchStart(e: TouchEvent): void {
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

    findTouchById(touches: TouchList, id: number | null): Touch | null {
        for (let i = 0; i < touches.length; i++) {
            if (touches[i].identifier === id) return touches[i];
        }
        return null;
    }

    onTouchMove(e: TouchEvent): void {
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

    onTouchEnd(e: TouchEvent): void {
        if (e.touches.length < 2) this.touchState.isPinching = false;
        if (e.touches.length === 0 && this.touchDragActive) {
            this.touchDragActive = false;
            if (this._cameraAnimation) return;
            this.syncControlsTarget();
        }
    }

    onResize(): void {
        if (this._disposed) return;
        const w = this.targetElement.clientWidth;
        const h = this.targetElement.clientHeight;
        if (w <= 0 || h <= 0) return;
        this.camera.aspect = w / h;
        this.camera.updateProjectionMatrix();
        this.renderer.setSize(w, h);
        this.maybeUpdateVisibleTiles();
    }

    onClick(e: MouseEvent): void {
        if (!e.shiftKey) return;
        if (this._mouseMoved) return;

        const rect = this.renderer.domElement.getBoundingClientRect();
        this._tempMouse.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
        this._tempMouse.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
        this._tempRaycaster.setFromCamera(this._tempMouse, this.camera);

        const groundPoint = new THREE.Vector3();
        if (!this._tempRaycaster.ray.intersectPlane(this.groundPlane, groundPoint)) {
            console.log('[shift-click] Ray did not hit ground plane (looking at horizon?)');
            return;
        }
        const localX = groundPoint.x - this.worldGroup.position.x;
        const localZ = groundPoint.z - this.worldGroup.position.z;
        const [lon, lat] = this.unprojectToLonLat(localX, localZ);

        let elevation = null;
        const meshes: any[] = [];
        for (const mgr of this._tileManagers) {
            for (const inst of mgr.tiles.values()) {
                if (inst.mesh && inst.mesh.visible) meshes.push(inst.mesh);
            }
        }
        const intersects = this._tempRaycaster.intersectObjects(meshes, false);
        if (intersects.length > 0) elevation = intersects[0].point.y;

        const identLayers = this._getLayersInOrder().filter((layer: any) =>
            layer.visible !== false &&
            (!layer._map || layer._map === this) &&
            typeof layer.identify === 'function'
        );
        if (identLayers.length === 0) {
            console.log(
                `[shift-click] Lon ${lon.toFixed(6)}, Lat ${lat.toFixed(6)}` +
                (elevation !== null ? `, Height ${elevation.toFixed(2)}` : '') +
                ` — no vector layers`
            );
            return;
        }

        const promises = identLayers.map((l: any, idx: number) => {
            const tag = (l.url || `layer${idx}`).split('/').slice(-3).join('/');
            return Promise.resolve(l.identify(groundPoint.x, groundPoint.z))
                .then((res: any) => ({ tag, ...res }))
                .catch((err: any) => ({ tag, error: err.message }));
        });

        Promise.all(promises).then(allResults => {
            const report = {
                click: {
                    lon: +lon.toFixed(6),
                    lat: +lat.toFixed(6),
                    worldX: +groundPoint.x.toFixed(2),
                    worldZ: +groundPoint.z.toFixed(2),
                    elevation: elevation !== null ? +elevation.toFixed(2) : null,
                },
                zoom: {
                    continuous: +this.continuousZoom.toFixed(2),
                    discrete: this.currentDiscreteZoom,
                },
                layers: allResults,
            };

            console.groupCollapsed(
                `[shift-click] Lon ${lon.toFixed(6)}, Lat ${lat.toFixed(6)} ` +
                `— z${this.currentDiscreteZoom} — ${allResults.length} layer(s)`
            );
            for (const lr of allResults as any[]) {
                if (lr.error) {
                    console.warn(`[${lr.tag}] error: ${lr.error}`);
                    continue;
                }
                if (!lr.tile) { console.warn(`[${lr.tag}] no tile info`); continue; }
                const head = `[${lr.tag}] tile ${lr.tile.z}/${lr.tile.x}/${lr.tile.y} — ${lr.features.length} feature(s)`;
                if (lr.features.length === 0) {
                    console.warn(head + ' (nothing nearby — try larger tolerance)');
                    continue;
                }
                console.group(head);
                for (const f of lr.features) {
                    const pass = f.filterPass ? '✓' : '✗ FILTER';
                    console.groupCollapsed(
                        `${pass}  ${f.layer} (${f.type}) — dist ${f.distance.toFixed(1)} — order ${f.renderOrder}`
                    );
                    console.log('properties:', f.properties);
                    console.log('resolvedStyle:', f.style);
                    console.groupEnd();
                }
                console.groupEnd();
            }
            console.groupEnd();

            console.log('[shift-click] JSON dump:');
            console.log(JSON.stringify(report, null, 2));
            (window as any).__lastShiftClick = report;
        });
    }

    bindEvents(): void {
        this._abortController = new AbortController();
        const signal = this._abortController.signal;
        const el = this.renderer.domElement;

        el.addEventListener('mousedown', (e: MouseEvent) => this.onMouseDown(e), { signal });
        window.addEventListener('mousemove', (e: MouseEvent) => this.onMouseMove(e), { signal });
        window.addEventListener('mouseup', () => this.onMouseUp(), { signal });
        el.addEventListener('wheel', (e: WheelEvent) => this.onWheel(e), { passive: false, signal });
        window.addEventListener('resize', () => this.onResize(), { signal });
        el.addEventListener('touchstart', (e: TouchEvent) => this.onTouchStart(e), { passive: false, signal });
        el.addEventListener('touchmove', (e: TouchEvent) => this.onTouchMove(e), { passive: false, signal });
        el.addEventListener('touchend', (e: TouchEvent) => this.onTouchEnd(e), { signal });
        el.addEventListener('touchcancel', (e: TouchEvent) => this.onTouchEnd(e), { signal });
        el.addEventListener('click', (e: MouseEvent) => this.onClick(e), { signal });
    }

    applyZoomDistance(): void {
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

    applyZoomDelta(delta: number): void {
        this.targetContinuousZoom += delta;
        this.targetContinuousZoom = Math.max(this.MIN_ZOOM, Math.min(this.MAX_ZOOM, this.targetContinuousZoom));

        for (const mgr of this._tileManagers) {
            if (!mgr.hasElevation) continue;
            const futureTileZ = this.targetContinuousZoom + (mgr.layer?.zoomOffset ?? 0);
            const maxElevZ = mgr._maxElevationNativeZoom;
            if (futureTileZ > maxElevZ) {
                const futureCenter = this._tempVec3a.copy(this.controls.target);
                const neededParentZ = Math.min(Math.floor(futureTileZ) - 1, maxElevZ);
                mgr.prefetchParentElevations(futureCenter, neededParentZ, this.worldGroup.position);
            }
        }
    }

    peekIdealZoom(continuousZoom: number): number {
        return Math.max(this.MIN_ZOOM,
                        Math.min(this.MAX_ZOOM, Math.round(continuousZoom)));
    }

    pause(): void {
        if (this._disposed) return;
        this._pauseReasons.add('manual');
        this._doPause();
    }

    resume(): void {
        if (this._disposed) return;
        this._pauseReasons.delete('manual');
        if (this._pauseReasons.size === 0) this._doResume();
    }

    _doPause(): void {
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

    _doResume(): void {
        if (this._disposed || !this._paused) return;
        this._paused = false;

        const w = this.targetElement?.clientWidth ?? 0;
        const h = this.targetElement?.clientHeight ?? 0;
        if (w > 0 && h > 0) this.onResize();

        this.lastVisibleUpdateTime = 0;
        this.clock.getDelta();

        this.animate();
        this._currentDeltaTime = 0;
    }

    isPaused(): boolean { return this._paused; }
    isDisposed(): boolean { return this._disposed; }

    dispose(): void {
        if (this._disposed) return;
        this._disposed = true;

        if (this._onVisChange) {
            try { document.removeEventListener('visibilitychange', this._onVisChange); }
            catch (e) { console.warn(e); }
            this._onVisChange = null;
        }
        if (this._io) {
            try { this._io.disconnect(); } catch (e) { console.warn(e); }
            this._io = null;
        }

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

        for (const layer of this._getLayersInOrder()) {
            if (layer._map !== this || typeof layer.removeFromMap !== 'function') continue;
            try {
                layer.removeFromMap();
            } catch (err) {
                console.warn('KrbMap.dispose: layer.removeFromMap() failed', err);
            }
        }

        for (const mgr of this._tileManagers) {
            if (!mgr) continue;
            try { if (mgr.worker && mgr.worker.terminate) mgr.worker.terminate(); }
            catch (e) { console.warn(e); }
            mgr.worker = null;
            try { mgr.textureCache?.clear(); } catch (e) {}
            try { mgr.tiles?.clear(); } catch (e) {}
        }
        this._tileManagers = [];
        this._elevationProvider = null;

        this._dynamicLayers = [];

        const managers = ['textManager', 'popupManager', 'interaction'] as const;
        for (const name of managers) {
            const m = this[name];
            if (m && typeof m.dispose === 'function') {
                try { m.dispose(); } catch (e) { console.warn(`KrbMap.dispose: ${name}.dispose() threw`, e); }
            }
            (this as any)[name] = null;
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

        this.layers = [];
        this._rasterLayers = [];
        this.globalElevCache?.clear?.();
        this.globalElevCache = null as any;
        this._surfaceMaxHeightCache?.clear?.();
        this._surfaceMaxHeightCache = null as any;
        this._tempPool = null as any;
        this._tempVec3a = null;
        this._tempVec3b = null;
        this._tempVec3c = null;
        this._tempDir = null;
        this._tempTarget = null;
        this._tempPlacementOut = null;
        this._tempRaycaster = null;
        this._tempMouse = null;
        this.targetElement = null as any;
        this._pauseReasons.clear();
        this._tileLayer = null;
        this._elevationLayer = null;
    }

    _disposeObject3D(root: any): void {
        if (!root) return;
        root.traverse((obj: any) => {
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

    animate(): void {
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

        this.camera.updateMatrixWorld(true);
        this.worldGroup.updateMatrixWorld(true);
        this.maybeUpdateVisibleTiles();

        for (const layer of this._getLayersInOrder()) {
            if (typeof layer._postUpdate !== 'function') continue;
            if (layer._map && layer._map !== this) continue;
            layer._postUpdate(this);
        }

        if (this.textManager) this.textManager.update();
        this.renderer.render(this.scene, this.camera);
    }
}