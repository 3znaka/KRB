import {
  THREE,
  OrbitControls
} from '../js_TP/tpb.js';  
import { proj, DEFAULTS, getOriginZ, getVirtKey, getSrcKey, toLonLat } from './Utils.js';
import { TileManager } from './Tiles.js';
import { TextManager } from './TextManager.js';
import { initUI } from './Ui.js';

export class View {
    constructor(options) {
        this.center = options.center;
        this.zoom = options.zoom;
        this.minZoom = options.minZoom ?? DEFAULTS.MIN_ZOOM;
        this.maxZoom = options.maxZoom ?? DEFAULTS.MAX_ZOOM;
        this.zoomSensitivity = options.zoomSensitivity ?? DEFAULTS.ZOOM_SENSITIVITY;
        this.pitch = options.pitch ?? 0;
        this.bearing = options.bearing ?? 0;
    }
}

export class KrbMap {
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

        const [cx, cy] = this.view.center;
        const initialZoom = this.view.zoom;
        const initialPitchRad = (this.view.pitch ?? 0) * Math.PI / 180;
        const initialBearingRad = (this.view.bearing ?? 0) * Math.PI / 180;

        this.controls.target.set(cx, 0, cy);
        const dist = this.getTargetDistanceForZoom(initialZoom);

        const sinP = Math.sin(initialPitchRad);
        const cosP = Math.cos(initialPitchRad);
        this.camera.position.set(
            cx - dist * sinP * Math.sin(initialBearingRad),
            dist * cosP,
            cy + dist * sinP * Math.cos(initialBearingRad)
        );
        this.controls.update();

        // ЕДИНСТВЕННАЯ группа мира на всё время жизни
        this.worldGroup = new THREE.Group();
        this.worldGroup.position.set(0, 0, 0);
        this.scene.add(this.worldGroup);
        this._cameraAnimation = null;
        this._controlsDampingWasEnabled = true;
        this._dynamicLayers = [];
        this.textManager = new TextManager(this);
        this.textManager.start();

        // Менеджер тайлов нового поколения
        this.tileManager = new TileManager(this);

        // Статический фон (создаётся один раз, внутри worldGroup)
        this.staticBgGroup = new THREE.Group();
        this.worldGroup.add(this.staticBgGroup);
        if (this.layers.length && this.layers.some(layer => layer.texture)) {
            this.createStaticBackgroundLayer();
        }

        this.lastVisibleUpdateTime = 0;
        this.clock = new THREE.Clock();

        this.bindEvents();
        // Первичное заполнение тайлами
        this.maybeUpdateVisibleTiles(true);

        this.animate();
        requestAnimationFrame(() => initUI(this));
    }

    // ── Three.js инициализация ───────────────────────────────
    initThree() {
        this.scene = new THREE.Scene();
        this.scene.background = new THREE.Color(0xffffff);
        this.camera = new THREE.PerspectiveCamera(
            45,
            this.targetElement.clientWidth / this.targetElement.clientHeight,
            1,
            200000000
        );
        this.renderer = new THREE.WebGLRenderer({ antialias: false, powerPreference: 'high-performance' });
        this.renderer.setSize(this.targetElement.clientWidth, this.targetElement.clientHeight);
        this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
        this.targetElement.appendChild(this.renderer.domElement);

        this.scene.add(new THREE.AmbientLight(0xffffff, 0.8));
        const sun = new THREE.DirectionalLight(0xffffff, 1.3);
        sun.position.set(1, -1, 1);
        this.scene.add(sun);
    }

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

    initDragTools() {
        this.groundPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
        this.raycasterDragger = new THREE.Raycaster();
        this.mouse = new THREE.Vector2();
        this.intersection = new THREE.Vector3();
        this.isDragging = false;
        this.dragLocalPoint = new THREE.Vector3();
    }

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

    setPitch(pitchDeg, duration = 0.3) {
        if (this._cameraAnimation) return;

        const pitchRad = pitchDeg * Math.PI / 180;
        const maxPolarRad = this.controls.maxPolarAngle;
        const clampedRad = Math.max(0.001, Math.min(pitchRad, maxPolarRad));

        const target = this.controls.target.clone();
        const currentPos = this.camera.position.clone();
        const dir = new THREE.Vector3().subVectors(currentPos, target);
        const currentDistance = dir.length();
        if (currentDistance < 1) return;

        const currentPitchRad = Math.acos(dir.y / currentDistance);
        const azimuth = Math.atan2(-dir.x, dir.z);
        const endDistance = currentDistance;

        this._controlsDampingWasEnabled = this.controls.enableDamping;
        this.controls.enableDamping = false;

        const startTime = performance.now();
        this._cameraAnimation = {
            startTarget: target.clone(),
            startPitch: currentPitchRad,
            startDistance: currentDistance,
            azimuth,
            endPitch: clampedRad,
            endDistance,
            duration,
            startTime
        };

        const animateStep = (now) => {
            if (!this._cameraAnimation) return;
            const a = this._cameraAnimation;
            let t = (now - a.startTime) / (a.duration * 1000);
            t = Math.min(t, 1.0);
            const eased = t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;

            const currentPitch = a.startPitch + (a.endPitch - a.startPitch) * eased;
            const currentDist = a.startDistance + (a.endDistance - a.startDistance) * eased;

            const sinP = Math.sin(currentPitch);
            const cosP = Math.cos(currentPitch);
            this.camera.position.set(
                a.startTarget.x - currentDist * sinP * Math.sin(a.azimuth),
                a.startTarget.y + currentDist * cosP,
                a.startTarget.z + currentDist * sinP * Math.cos(a.azimuth)
            );
            this.controls.target.copy(a.startTarget);
            this.controls.update();

            if (Math.floor(t * 10) !== Math.floor((t - 1/60) * 10)) {
                this.maybeUpdateVisibleTiles();
            }

            if (t >= 1.0) {
                this._cameraAnimation = null;
                this.controls.enableDamping = this._controlsDampingWasEnabled;
                this.controls.target.copy(a.startTarget);
                this.controls.update();
                this.maybeUpdateVisibleTiles();
                return;
            }
            requestAnimationFrame(animateStep);
        };
        requestAnimationFrame(animateStep);
    }

    setBearing(bearingDeg, duration = 0.3) {
        if (this._cameraAnimation) return;

        const bearingRad = bearingDeg * Math.PI / 180;
        const target = this.controls.target.clone();
        const currentPos = this.camera.position.clone();
        const dir = new THREE.Vector3().subVectors(currentPos, target);
        const currentDistance = dir.length();
        if (currentDistance < 1) return;

        const currentAzimuth = Math.atan2(-dir.x, dir.z);
        const pitch = Math.acos(dir.y / currentDistance);
        let delta = bearingRad - currentAzimuth;
        while (delta > Math.PI) delta -= 2 * Math.PI;
        while (delta < -Math.PI) delta += 2 * Math.PI;
        const endAzimuth = currentAzimuth + delta;
        const endDistance = currentDistance;

        this._controlsDampingWasEnabled = this.controls.enableDamping;
        this.controls.enableDamping = false;

        const startTime = performance.now();
        this._cameraAnimation = {
            startTarget: target.clone(),
            startAzimuth: currentAzimuth,
            startDistance: currentDistance,
            pitch,
            endAzimuth,
            endDistance,
            duration,
            startTime
        };

        const animateStep = (now) => {
            if (!this._cameraAnimation) return;
            const a = this._cameraAnimation;
            let t = (now - a.startTime) / (a.duration * 1000);
            t = Math.min(t, 1.0);
            const eased = t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;

            const currentAzimuth = a.startAzimuth + (a.endAzimuth - a.startAzimuth) * eased;
            const currentDist = a.startDistance + (a.endDistance - a.startDistance) * eased;

            const sinP = Math.sin(a.pitch);
            const cosP = Math.cos(a.pitch);
            this.camera.position.set(
                a.startTarget.x - currentDist * sinP * Math.sin(currentAzimuth),
                a.startTarget.y + currentDist * cosP,
                a.startTarget.z + currentDist * sinP * Math.cos(currentAzimuth)
            );
            this.controls.target.copy(a.startTarget);
            this.controls.update();

            if (Math.floor(t * 10) !== Math.floor((t - 1/60) * 10)) {
                this.maybeUpdateVisibleTiles();
            }

            if (t >= 1.0) {
                this._cameraAnimation = null;
                this.controls.enableDamping = this._controlsDampingWasEnabled;
                this.controls.target.copy(a.startTarget);
                this.controls.update();
                this.maybeUpdateVisibleTiles();
                return;
            }
            requestAnimationFrame(animateStep);
        };
        requestAnimationFrame(animateStep);
    }

    resetBearing() {
        this.rotateToNorth(0.3);
    }

    getTargetDistanceForZoom(z) {
        return this.BASE_DISTANCE * Math.pow(0.5, z - this.BASE_ZOOM);
    }

    getTextureUrl(z, x, y) {
        if (!this.layers[0] || !this.layers[0].texture) return null;
        return this.layers[0].texture.replace(/\{z\}/g, z).replace(/\{x\}/g, x).replace(/\{y\}/g, y);
    }

    getElevationUrl(z, x, y) {
        if (!this.layers[0] || !this.layers[0].elevation) return null;
        return this.layers[0].elevation.replace(/\{z\}/g, z).replace(/\{x\}/g, x).replace(/\{y\}/g, y);
    }

    get maxObjectDistance() {
        if (!this.objectRenderDistanceFactor) return Infinity;
        const distToTarget = this.camera.position.distanceTo(this.controls.target);
        return distToTarget * this.objectRenderDistanceFactor;
    }

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
        const inst = this.tileManager.tiles.get(vk);
        if (inst && inst.heightsApplied && inst.mesh) {
            const pos = inst.geometry.attributes.position.array;
            let maxY = -Infinity;
            for (let i = 0; i < pos.length; i += 3) {
                if (pos[i + 1] > maxY) maxY = pos[i + 1];
            }
            return maxY + inst.mesh.position.y;
        }
        return 0;
    }

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
    shiftWorld(dx, dz) {
        this.worldGroup.position.x -= dx;
        this.worldGroup.position.z -= dz;
    }

    syncControlsTarget() {
        const rc = new THREE.Raycaster();
        rc.setFromCamera(new THREE.Vector2(0, 0), this.camera);
        const tp = new THREE.Vector3();
        if (rc.ray.intersectPlane(this.groundPlane, tp)) {
            this.controls.target.copy(tp);
            this.controls.update();
        }
    }

    /* ================================================================
       Ввод: мышь, колёсико, касания
       ================================================================ */
    onMouseDown(e) {
        if (this._cameraAnimation) return;
        if (e.button !== 0) return;
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
        if (this._cameraAnimation) return;
        if (!this.isDragging) return;
        this.isDragging = false;
        this.syncControlsTarget();
    }

    onWheel(e) {
        if (this._cameraAnimation) return;
        e.preventDefault();
        const delta = -Math.sign(e.deltaY) * this.ZOOM_SENSITIVITY;
        this.applyZoomDelta(delta);
    }

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
        if (this._cameraAnimation) return;
        if (e.touches.length < 2) this.touchState.isPinching = false;
        if (e.touches.length === 0 && this.touchDragActive) {
            this.touchDragActive = false;
            this.syncControlsTarget();
        }
    }

    onResize() {
        const w = this.targetElement.clientWidth;
        const h = this.targetElement.clientHeight;
        this.camera.aspect = w / h;
        this.camera.updateProjectionMatrix();
        this.renderer.setSize(w, h);
        this.maybeUpdateVisibleTiles();
    }

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
    }

    /* ================================================================
       Механика зума и видимости
       ================================================================ */
    applyZoomDistance() {
        if (this._cameraAnimation) return;
        const target = this.controls.target;
        const currentDir = new THREE.Vector3()
            .subVectors(this.camera.position, target)
            .normalize();
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

    applyZoomDelta(delta) {
        this.targetContinuousZoom += delta;
        this.targetContinuousZoom = Math.max(this.MIN_ZOOM, Math.min(this.MAX_ZOOM, this.targetContinuousZoom));
        if (this.targetContinuousZoom > this.MAX_RELIEF_Z) {
            const futureCenter = this.controls.target.clone();
            const neededParentZ = Math.min(Math.floor(this.targetContinuousZoom) - 1, this.MAX_RELIEF_Z);
            this.tileManager.prefetchParentElevations(futureCenter, neededParentZ, this.worldGroup.position);
        }
    }

    // Публичный метод peekIdealZoom используется tileManager для гистерезиса
    peekIdealZoom(continuousZoom) {
        const prev = this.currentDiscreteZoom;
        let idealZ = prev;
        if (continuousZoom >= prev + 0.6) idealZ = prev + 1;
        else if (continuousZoom <= prev - 0.6) idealZ = prev - 1;
        return Math.max(this.MIN_ZOOM, Math.min(this.MAX_ZOOM, idealZ));
    }

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

    moveCameraTo(lon, lat) {
        const [cx, cy] = proj.fromLonLat([lon, lat]);
        const z = this.currentDiscreteZoom;
        const worldOffset = this.worldGroup.position;
        const targetX = cx + worldOffset.x;
        const targetZ = cy + worldOffset.z;

        this.controls.target.set(targetX, 0, targetZ);
        this.camera.position.set(targetX, this.getTargetDistanceForZoom(z), targetZ);
        this.controls.update();
        this.continuousZoom = z;
        this.targetContinuousZoom = z;
        this.applyZoomDistance();
        this.maybeUpdateVisibleTiles(true);
    }

    _wrapLongitudeIfNeeded() {
        const now = performance.now();
        if (now - (this._lastWrapCheck || 0) < 1000) return;
        this._lastWrapCheck = now;

        const worldPos = this.worldGroup.position;
        const centerX = this.controls.target.x - worldPos.x;
        const centerZ = this.controls.target.z - worldPos.z;
        const [lon, lat] = toLonLat([centerX, centerZ]);

        let newLon = lon;
        if (lon < -180) {
            newLon = lon + 360;
        } else if (lon > 180) {
            newLon = lon - 360;
        }
        if (newLon === lon) return;

        const [newCenterX, newCenterZ] = proj.fromLonLat([newLon, lat]);
        this.worldGroup.position.x = this.controls.target.x - newCenterX;
        this.worldGroup.position.z = this.controls.target.z - newCenterZ;
        this.maybeUpdateVisibleTiles(true);
    }

    moveCameraToSlow(lon, lat, duration = 1.0, targetZoom = null) {
        if (this._cameraAnimation) return;

        const startTarget = this.controls.target.clone();
        const startPos = this.camera.position.clone();
        const startZoom = this.continuousZoom;

        const [cx, cy] = proj.fromLonLat([lon, lat]);
        const worldOffset = this.worldGroup.position;
        const endTarget = new THREE.Vector3(cx + worldOffset.x, 0, cy + worldOffset.z);

        const currentDir = new THREE.Vector3().subVectors(startPos, startTarget).normalize();
        const endZoom = targetZoom !== null ? targetZoom : startZoom;

        const startTime = performance.now();
        this._cameraAnimation = {
            startTarget, startPos, endTarget,
            startZoom, endZoom,
            duration, startTime
        };

        this._controlsDampingWasEnabled = this.controls.enableDamping;
        this.controls.enableDamping = false;

        const animateStep = (now) => {
            if (!this._cameraAnimation) return;
            const { startTarget, startPos, endTarget, startZoom, endZoom, duration, startTime } = this._cameraAnimation;
            let t = (now - startTime) / (duration * 1000);
            t = Math.min(t, 1.0);
            const eased = t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;

            const currentZoom = startZoom + (endZoom - startZoom) * eased;
            const currentTarget = new THREE.Vector3().lerpVectors(startTarget, endTarget, eased);

            const maxHeight = this.hasElevation ? this.getSurfaceMaxHeight(endTarget.x, endTarget.z) : 0;
            const minDist = this.hasElevation ? (maxHeight + this.MIN_CAMERA_HEIGHT_OFFSET) : 0;
            const desiredDist = this.getTargetDistanceForZoom(currentZoom);
            const finalDist = Math.max(desiredDist, minDist);

            const currentPos = currentTarget.clone().addScaledVector(currentDir, finalDist);

            this.camera.position.copy(currentPos);
            this.controls.target.copy(currentTarget);
            this.controls.update();

            this.continuousZoom = currentZoom;
            this.targetContinuousZoom = currentZoom;

            if (Math.floor(t * 10) !== Math.floor((t - 1/60) * 10)) {
                this.maybeUpdateVisibleTiles();
            }

            if (t >= 1.0) {
                this._cameraAnimation = null;
                this.controls.enableDamping = this._controlsDampingWasEnabled;

                this.controls.target.copy(endTarget);
                const finalMaxHeight = this.hasElevation ? this.getSurfaceMaxHeight(endTarget.x, endTarget.z) : 0;
                const finalMinDist = this.hasElevation ? (finalMaxHeight + this.MIN_CAMERA_HEIGHT_OFFSET) / Math.cos(pitch) : 0;
                const finalDesiredDist = this.getTargetDistanceForZoom(endZoom);
                this.camera.position.copy(
                    endTarget.clone().addScaledVector(currentDir, Math.max(finalDesiredDist, finalMinDist))
                );
                this.controls.update();

                this.continuousZoom = endZoom;
                this.targetContinuousZoom = endZoom;
                this.maybeUpdateVisibleTiles(true);
                return;
            }
            requestAnimationFrame(animateStep);
        };
        requestAnimationFrame(animateStep);
    }

    rotateToNorth(duration = 0.3, resetPitch = true) {
        if (this._cameraAnimation) return;

        const startTarget = this.controls.target.clone();
        const startPos = this.camera.position.clone();
        const dir = new THREE.Vector3().subVectors(startPos, startTarget);
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

            if (Math.floor(t * 10) !== Math.floor((t - 1/60) * 10)) {
                this.maybeUpdateVisibleTiles();
            }

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
       Главный цикл анимации
       ================================================================ */
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
        this.textManager.update();
        this.renderer.render(this.scene, this.camera);

        for (const layer of this._dynamicLayers) {
            if (layer._postUpdate) layer._postUpdate(this);
        }
    }
}