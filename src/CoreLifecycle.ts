// CoreLifecycle.ts
import { THREE } from './js_TP/tpb.js';
import type { KrbMap } from './Core.js';

// ── Инерция вращения глобуса ──
/** Ниже этой скорости (px/с) инерция останавливается. */
const GLOBE_INERTIA_STOP_PX_S = 2;
/** Время, за которое достигается предельная скорость (с) — задаёт кривую ограничения. */
const GLOBE_INERTIA_CAP_TIME_S = 0.25;
/** Коэффициент затухания скорости за секунду (≈ доля, оставшаяся через 1 с). */
const GLOBE_INERTIA_DECAY = 0.05;
/** Множитель вертикальной (к полюсам) скорости на низких зумах. */
const GLOBE_INERTIA_LAT_DAMP = 0.5;

export interface CoreLifecycleMethods {
    _setupAutoPause(): void;
    pause(): void;
    resume(): void;
    _doPause(): void;
    _doResume(): void;
    isPaused(): boolean;
    isDisposed(): boolean;
    dispose(): void;
    _disposeObject3D(root: any): void;
    animate(): void;
    _updateGlobeOccluder(): void;

    // ── инерция ──
    _processPanInertia(deltaTime: number): void;
    _resetInertia(): void;
}

export const CoreLifecycleMixin: CoreLifecycleMethods & ThisType<KrbMap> = {
    _setupAutoPause() {
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
    },

    pause() {
        if (this._disposed) return;
        this._pauseReasons.add('manual');
        this._doPause();
    },
    resume() {
        if (this._disposed) return;
        this._pauseReasons.delete('manual');
        if (this._pauseReasons.size === 0) this._doResume();
    },

    _resetInertia() {
        this._panVelX = 0;
        this._panVelZ = 0;
        this._globeOrbitVelX = 0;
        this._globeOrbitVelY = 0;
    },

    _doPause() {
        if (this._disposed || this._paused) return;
        this._paused = true;
        if (this._rafId !== null) { cancelAnimationFrame(this._rafId); this._rafId = null; }
        if (this._cameraAnimFrame !== null) { cancelAnimationFrame(this._cameraAnimFrame); this._cameraAnimFrame = null; }
        this._cameraAnimation = null;
        this._cameraAnimations.pitch = null;
        this._cameraAnimations.bearing = null;
        this._currentDeltaTime = 0;
        this._resetInertia();
    },

    _doResume() {
        if (this._disposed || !this._paused) return;
        this._paused = false;
        const w = this.targetElement?.clientWidth ?? 0;
        const h = this.targetElement?.clientHeight ?? 0;
        if (w > 0 && h > 0) this.onResize();
        this.lastVisibleUpdateTime = 0;
        this.clock.getDelta();
        this.animate();
        this._currentDeltaTime = 0;
    },

    isPaused() { return this._paused; },
    isDisposed() { return this._disposed; },

 dispose() {
    if (this._disposed) return;
    this._disposed = true;

    this._disposeEvents();  

    if (this._uiHandle && typeof this._uiHandle.destroy === 'function') {
        try { this._uiHandle.destroy(); } catch (e) { console.warn(e); }
    }
    this._uiHandle = null;

    if (this._onVisChange) {
            try { document.removeEventListener('visibilitychange', this._onVisChange); }
            catch (e) { console.warn(e); }
            this._onVisChange = null;
        }
        if (this._io) {
            try { this._io.disconnect(); } catch (e) { console.warn(e); }
            this._io = null;
        }
        if (this._rafId !== null) { cancelAnimationFrame(this._rafId); this._rafId = null; }
        if (this._cameraAnimFrame !== null) { cancelAnimationFrame(this._cameraAnimFrame); this._cameraAnimFrame = null; }
        this._cameraAnimation = null;
        this._cameraAnimations = { pitch: null, bearing: null };
        this._resetInertia();
        if (this._abortController) {
            try { this._abortController.abort(); } catch (e) { console.warn(e); }
            this._abortController = null;
        }
        for (const layer of this._getLayersInOrder()) {
            if (layer._map !== this || typeof layer.removeFromMap !== 'function') continue;
            try { layer.removeFromMap(); }
            catch (err) { console.warn('KrbMap.dispose: layer.removeFromMap() failed', err); }
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


        
    },

    _disposeObject3D(root) {
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
    },

    /**
     * Billboard-окклюдер глобуса: держим его повёрнутым к камере.
     * Камеру переводим в local-СК worldGroup (там живёт геометрия).
     */
    _updateGlobeOccluder() {
        const occ = this._globeOccluder;
        if (!occ || !this.surface || typeof this.surface.updateOccluder !== 'function') return;
        const camLocal = this._tempVec3c ?? (this._tempVec3c = new THREE.Vector3());
        camLocal.copy(this.camera.position);
        if (this.worldGroup) this.worldGroup.worldToLocal(camLocal);
        this.surface.updateOccluder(occ, camLocal);
    },

    /* ================================================================
       Инерция
       ================================================================ */

    _processPanInertia(dt) {
        if (!this.panInertia) return;
        if (this._cameraAnimation) {
            this._panVelX = 0;
            this._panVelZ = 0;
            this._globeOrbitVelX = 0;
            this._globeOrbitVelY = 0;
            return;
        }
        if (this.isDragging || this.touchDragActive) return;

        // Глобус: инерция — это вращение орбиты (px/с), а не сдвиг мира.
        if (this.globe) {
            const vx = this._globeOrbitVelX;
            const vy = this._globeOrbitVelY;
            if (vx === 0 && vy === 0) return;

            // Порог остановки — в пикселях/с, не зависит от дистанции камеры.
            if (Math.hypot(vx, vy) < GLOBE_INERTIA_STOP_PX_S) {
                this._globeOrbitVelX = 0;
                this._globeOrbitVelY = 0;
                return;
            }

            // Масштаб: на дальнем зуме один пиксель соответствует большему углу,
            // поэтому усиливаем бросок пропорционально дистанции камеры.
            const camDist = this.camera.position.distanceTo(this.controls.target);
            const ref = Math.max(1e-6, this.R * 4);
            const k = Math.max(1, Math.min(camDist / ref, 3));

            const zoomNow = this.continuousZoom;
            const H = this.renderer?.domElement?.clientHeight || 1;
            // Предел угловой скорости: на низком зуме глобус «мяч» — инерции нет,
            // выше предел — доля высоты экрана в секунду (а не за кадр),
            // поэтому частота кадров не влияет на поведение.
            const zoomCap = zoomNow <= 1 ? 0 : (zoomNow <= 2 ? 0.02 : 0.25);
            if (zoomCap <= 0) {
                this._globeOrbitVelX = 0;
                this._globeOrbitVelY = 0;
                return;
            }
            const maxSpeedPxS = zoomCap * H / GLOBE_INERTIA_CAP_TIME_S;

            // Мягкое (гладкое) ограничение скорости вместо жёсткого среза шага:
            // v' = vmax·tanh(|v|·k / vmax) / k — монотонно, без рывка на пороге.
            let vxE = vx * k, vyE = vy * k;
            const vLen = Math.hypot(vxE, vyE);
            if (vLen > 0 && maxSpeedPxS > 0) {
                const soft = maxSpeedPxS * Math.tanh(vLen / maxSpeedPxS);
                const f = soft / vLen;
                vxE *= f; vyE *= f;
            }
            // Вертикаль (к полюсам) — тот же закон, без ручного ослабления:
            // кривая одна, а анизотропия задаётся GLOBE_INERTIA_LAT_DAMP.
            const latDamp = zoomNow <= 5 ? GLOBE_INERTIA_LAT_DAMP : 1;
            this._globeOrbit((vxE * dt) / k, (vyE * dt * latDamp) / k);

            // Экспоненциальное затухание, не зависящее от частоты кадров.
            const decay = Math.pow(GLOBE_INERTIA_DECAY, dt);
            this._globeOrbitVelX *= decay;
            this._globeOrbitVelY *= decay;
            return;
        }

        if (this._panVelX === 0 && this._panVelZ === 0) return;

        const camDist = this.camera.position.distanceTo(this.controls.target);
        const minSpeed = camDist * 0.001;
        const speed = Math.hypot(this._panVelX, this._panVelZ);
        if (speed < minSpeed) {
            this._panVelX = 0;
            this._panVelZ = 0;
            return;
        }

        this.worldGroup.position.x += this._panVelX * dt;
        this.worldGroup.position.z += this._panVelZ * dt;

        const decay = Math.pow(this.panFriction, dt);
        this._panVelX *= decay;
        this._panVelZ *= decay;

        this.maybeUpdateVisibleTiles();
    },



    /* ================================================================
       Animation loop
       ================================================================ */

    animate() {
        if (this._disposed || this._paused) return;
        this._rafId = requestAnimationFrame(() => this.animate());
        const deltaTime = Math.min(this.clock.getDelta(), 0.1);
        this._currentDeltaTime = deltaTime;

        // ── инерция (до пересчёта камеры/зума) ──
        this._processPanInertia(deltaTime);

        if (!this._cameraAnimation) {
            const diff = this.targetContinuousZoom - this.continuousZoom;
            if (Math.abs(diff) > 0.001) {
                this.continuousZoom += diff * Math.min(1, 10 * deltaTime);
                this.continuousZoom = Math.max(this.MIN_ZOOM, Math.min(this.MAX_ZOOM, this.continuousZoom));
            } else {
                this.continuousZoom = this.targetContinuousZoom;
            }
        }

        if (!this._zoomPivotActive) this.controls.update();

        if (!this._zoomPivotActive) this._wrapLongitudeIfNeeded();
        if (!this._cameraAnimation) this.applyZoomDistance();
        this._enforceMaxBounds();

        this.camera.updateMatrixWorld(true);
        this.worldGroup.updateMatrixWorld(true);
        this._updateGlobeOccluder();
        for (const mgr of this._tileManagers) mgr._syncMaskOffset?.();
       this.maybeUpdateVisibleTiles();

this._updateMoveEvents();  

for (const layer of this._getLayersInOrder()) {
            if (typeof layer._postUpdate !== 'function') continue;
            if (layer._map && layer._map !== this) continue;
            layer._postUpdate(this);
        }
        if (this.textManager) this.textManager.update();
       if (this.renderer && typeof this.renderer.clear === 'function') {
    // autoClear = false у нас, поэтому чистим stencil вручную, чтобы
    // старая маска Graticule не «залипла» после движения камеры.
    this.renderer.clear(false, false, true);
}
this.renderer.render(this.scene, this.camera);

        if (!this._firstRenderDone) {        
    this._firstRenderDone = true;
    requestAnimationFrame(() => {
        if (!this._disposed) this.emit('load');
    });
}
    },
};

declare module './Core.js' {
    interface KrbMap extends CoreLifecycleMethods {}
}