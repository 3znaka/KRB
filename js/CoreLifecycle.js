export const CoreLifecycleMixin = {
    _setupAutoPause() {
        if (this._autoPauseDisabled)
            return;
        const apply = () => {
            if (this._disposed)
                return;
            const shouldPause = this._pauseReasons.size > 0;
            if (shouldPause && !this._paused)
                this._doPause();
            else if (!shouldPause && this._paused)
                this._doResume();
        };
        this._onVisChange = () => {
            if (document.hidden)
                this._pauseReasons.add('tab');
            else
                this._pauseReasons.delete('tab');
            apply();
        };
        document.addEventListener('visibilitychange', this._onVisChange);
        if (typeof IntersectionObserver !== 'undefined' && this.targetElement) {
            this._io = new IntersectionObserver(entries => {
                for (const e of entries) {
                    if (e.isIntersecting)
                        this._pauseReasons.delete('viewport');
                    else
                        this._pauseReasons.add('viewport');
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
        if (this._disposed)
            return;
        this._pauseReasons.add('manual');
        this._doPause();
    },
    resume() {
        if (this._disposed)
            return;
        this._pauseReasons.delete('manual');
        if (this._pauseReasons.size === 0)
            this._doResume();
    },
    _doPause() {
        if (this._disposed || this._paused)
            return;
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
    },
    _doResume() {
        if (this._disposed || !this._paused)
            return;
        this._paused = false;
        const w = this.targetElement?.clientWidth ?? 0;
        const h = this.targetElement?.clientHeight ?? 0;
        if (w > 0 && h > 0)
            this.onResize();
        this.lastVisibleUpdateTime = 0;
        this.clock.getDelta();
        this.animate();
        this._currentDeltaTime = 0;
    },
    isPaused() { return this._paused; },
    isDisposed() { return this._disposed; },
    dispose() {
        if (this._disposed)
            return;
        this._disposed = true;
        if (this._onVisChange) {
            try {
                document.removeEventListener('visibilitychange', this._onVisChange);
            }
            catch (e) {
                console.warn(e);
            }
            this._onVisChange = null;
        }
        if (this._io) {
            try {
                this._io.disconnect();
            }
            catch (e) {
                console.warn(e);
            }
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
            try {
                this._abortController.abort();
            }
            catch (e) {
                console.warn(e);
            }
            this._abortController = null;
        }
        for (const layer of this._getLayersInOrder()) {
            if (layer._map !== this || typeof layer.removeFromMap !== 'function')
                continue;
            try {
                layer.removeFromMap();
            }
            catch (err) {
                console.warn('KrbMap.dispose: layer.removeFromMap() failed', err);
            }
        }
        for (const mgr of this._tileManagers) {
            if (!mgr)
                continue;
            try {
                if (mgr.worker && mgr.worker.terminate)
                    mgr.worker.terminate();
            }
            catch (e) {
                console.warn(e);
            }
            mgr.worker = null;
            try {
                mgr.textureCache?.clear();
            }
            catch (e) { }
            try {
                mgr.tiles?.clear();
            }
            catch (e) { }
        }
        this._tileManagers = [];
        this._elevationProvider = null;
        this._dynamicLayers = [];
        const managers = ['textManager', 'popupManager', 'interaction'];
        for (const name of managers) {
            const m = this[name];
            if (m && typeof m.dispose === 'function') {
                try {
                    m.dispose();
                }
                catch (e) {
                    console.warn(`KrbMap.dispose: ${name}.dispose() threw`, e);
                }
            }
            this[name] = null;
        }
        this._disposeObject3D(this.scene);
        if (this.controls && typeof this.controls.dispose === 'function') {
            try {
                this.controls.dispose();
            }
            catch (e) {
                console.warn(e);
            }
        }
        this.controls = null;
        if (this.renderer) {
            const canvas = this.renderer.domElement;
            try {
                this.renderer.dispose();
            }
            catch (e) {
                console.warn(e);
            }
            try {
                if (typeof this.renderer.forceContextLoss === 'function')
                    this.renderer.forceContextLoss();
            }
            catch (e) {
                console.warn(e);
            }
            if (canvas && canvas.parentNode)
                canvas.parentNode.removeChild(canvas);
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
        this._pauseReasons.clear();
        this._tileLayer = null;
        this._elevationLayer = null;
    },
    _disposeObject3D(root) {
        if (!root)
            return;
        root.traverse((obj) => {
            if (obj.geometry && typeof obj.geometry.dispose === 'function') {
                try {
                    obj.geometry.dispose();
                }
                catch (e) {
                    console.warn(e);
                }
            }
            obj.geometry = null;
            const mats = obj.material;
            if (mats) {
                const list = Array.isArray(mats) ? mats : [mats];
                for (const m of list) {
                    if (!m)
                        continue;
                    try {
                        if (typeof m.dispose === 'function')
                            m.dispose();
                    }
                    catch (e) {
                        console.warn(e);
                    }
                }
            }
            obj.material = null;
        });
        if (typeof root.clear === 'function')
            root.clear();
    },
    animate() {
        if (this._disposed || this._paused)
            return;
        this._rafId = requestAnimationFrame(() => this.animate());
        const deltaTime = Math.min(this.clock.getDelta(), 0.1);
        this._currentDeltaTime = deltaTime;
        if (!this._cameraAnimation) {
            const diff = this.targetContinuousZoom - this.continuousZoom;
            if (Math.abs(diff) > 0.001) {
                this.continuousZoom += diff * Math.min(1, 10 * deltaTime);
                this.continuousZoom = Math.max(this.MIN_ZOOM, Math.min(this.MAX_ZOOM, this.continuousZoom));
            }
            else {
                this.continuousZoom = this.targetContinuousZoom;
            }
        }
        this.controls.update();
        this._wrapLongitudeIfNeeded();
        if (!this._cameraAnimation)
            this.applyZoomDistance();
        this.camera.updateMatrixWorld(true);
        this.worldGroup.updateMatrixWorld(true);
        this.maybeUpdateVisibleTiles();
        for (const layer of this._getLayersInOrder()) {
            if (typeof layer._postUpdate !== 'function')
                continue;
            if (layer._map && layer._map !== this)
                continue;
            layer._postUpdate(this);
        }
        if (this.textManager)
            this.textManager.update();
        this.renderer.render(this.scene, this.camera);
    },
};
