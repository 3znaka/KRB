// CoreInput.ts
import { THREE } from './js_TP/tpb.js';
import type { KrbMap } from './Core.js';

export interface CoreInputMethods {
    initDragTools(): void;
    initTouchState(): void;
    onMouseDown(e: MouseEvent): void;
    onMouseMove(e: MouseEvent): void;
    onMouseUp(): void;
    onWheel(e: WheelEvent): void;
    getTouchDistance(touches: TouchList): number;
    onTouchStart(e: TouchEvent): void;
    findTouchById(touches: TouchList, id: number | null): Touch | null;
    onTouchMove(e: TouchEvent): void;
    onTouchEnd(e: TouchEvent): void;
    onResize(): void;
    onClick(e: MouseEvent): void;
    bindEvents(): void;
    shiftWorld(dx: number, dz: number): void;
}

export const CoreInputMixin: CoreInputMethods & ThisType<KrbMap> = {
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
    },

    initTouchState() {
        this.touchState = {
            isPinching: false, startDist: 0, startZoom: 0,
            accumulatedLineAngle: 0, id0: null, id1: null,
        };
    },

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
    },

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
    },

    onMouseUp() {
        if (!this.isDragging) return;
        this.isDragging = false;
        if (this._cameraAnimation) return;
        this.syncControlsTarget();
    },

    onWheel(e) {
        if (this._cameraAnimation) return;
        e.preventDefault();
        const delta = -Math.sign(e.deltaY) * this.ZOOM_SENSITIVITY;
        this.applyZoomDelta(delta);
    },

    getTouchDistance(touches) {
        const dx = touches[0].clientX - touches[1].clientX;
        const dy = touches[0].clientY - touches[1].clientY;
        return Math.sqrt(dx * dx + dy * dy);
    },

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
            if (this.touchDragActive) { this.touchDragActive = false; this.syncControlsTarget(); }
            this.touchState.isPinching = true;
            this.touchState.startDist = this.getTouchDistance(e.touches);
            this.touchState.startZoom = this.targetContinuousZoom;
            this.touchState.id0 = e.touches[0].identifier;
            this.touchState.id1 = e.touches[1].identifier;
            const dx = e.touches[0].clientX - e.touches[1].clientX;
            const dy = e.touches[0].clientY - e.touches[1].clientY;
            this.touchState.accumulatedLineAngle = Math.atan2(dy, dx);
        }
    },

    findTouchById(touches, id) {
        for (let i = 0; i < touches.length; i++) {
            if (touches[i].identifier === id) return touches[i];
        }
        return null;
    },

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
            this.targetContinuousZoom = Math.max(this.MIN_ZOOM, Math.min(this.MAX_ZOOM, this.touchState.startZoom + zoomDelta));
            this.controls.update();
            this.maybeUpdateVisibleTiles();
        }
    },

    onTouchEnd(e) {
        if (e.touches.length < 2) this.touchState.isPinching = false;
        if (e.touches.length === 0 && this.touchDragActive) {
            this.touchDragActive = false;
            if (this._cameraAnimation) return;
            this.syncControlsTarget();
        }
    },

    onResize() {
        if (this._disposed) return;
        const w = this.targetElement.clientWidth;
        const h = this.targetElement.clientHeight;
        if (w <= 0 || h <= 0) return;
        this.camera.aspect = w / h;
        this.camera.updateProjectionMatrix();
        this.renderer.setSize(w, h);
        this.maybeUpdateVisibleTiles();
    },

    onClick(e) {
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
            console.log(`[shift-click] Lon ${lon.toFixed(6)}, Lat ${lat.toFixed(6)}` +
                (elevation !== null ? `, Height ${elevation.toFixed(2)}` : '') + ` — no vector layers`);
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
                    lon: +lon.toFixed(6), lat: +lat.toFixed(6),
                    worldX: +groundPoint.x.toFixed(2), worldZ: +groundPoint.z.toFixed(2),
                    elevation: elevation !== null ? +elevation.toFixed(2) : null,
                },
                zoom: { continuous: +this.continuousZoom.toFixed(2), discrete: this.currentDiscreteZoom },
                layers: allResults,
            };
            console.groupCollapsed(`[shift-click] Lon ${lon.toFixed(6)}, Lat ${lat.toFixed(6)} ` +
                `— z${this.currentDiscreteZoom} — ${allResults.length} layer(s)`);
            for (const lr of allResults as any[]) {
                if (lr.error) { console.warn(`[${lr.tag}] error: ${lr.error}`); continue; }
                if (!lr.tile) { console.warn(`[${lr.tag}] no tile info`); continue; }
                const head = `[${lr.tag}] tile ${lr.tile.z}/${lr.tile.x}/${lr.tile.y} — ${lr.features.length} feature(s)`;
                if (lr.features.length === 0) { console.warn(head + ' (nothing nearby — try larger tolerance)'); continue; }
                console.group(head);
                for (const f of lr.features) {
                    const pass = f.filterPass ? '✓' : '✗ FILTER';
                    console.groupCollapsed(`${pass}  ${f.layer} (${f.type}) — dist ${f.distance.toFixed(1)} — order ${f.renderOrder}`);
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
    },

    bindEvents() {
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
    },

    shiftWorld(dx, dz) {
        this.worldGroup.position.x -= dx;
        this.worldGroup.position.z -= dz;
    },
};

declare module './Core.js' {
    interface KrbMap extends CoreInputMethods {}
}