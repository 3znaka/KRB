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
    _raycastToGround(screenX: number, screenY: number, out: any): any | null;
    _rotateAroundPivot(dxPixels: number, dyPixels: number, pivot: any): void;
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

    this._rotatePivotActive = false;
    this._rotatePivot = null;
    this._rotatePivotX = 0;
    this._rotatePivotY = 0;
    this._rotateLastX = 0;
    this._rotateLastY = 0;
},

initTouchState() {
    this.touchState = {
        isPinching: false, startDist: 0, startZoom: 0, accumulatedLineAngle: 0,
        id0: null, id1: null,
        prevDist: 0, prevAngle: 0, prevMidX: 0, prevMidY: 0,
        prevAzimuth: 0, prevPitch: 0,
        startAngle: 0,
        startMidX: 0,
        startMidY: 0,
        startPitch: 0,
        activeGesture: null,
    };
},

onMouseDown(e) {
    if (this._cameraAnimation) return;
    this._zoomPivotActive = false;

    // NEW: right-click → rotate around pivot at cursor
    if (e.button === 2) {
        this._rotatePivotActive = true;
        this._rotatePivotX = e.clientX;
        this._rotatePivotY = e.clientY;
        this._rotateLastX  = e.clientX;
        this._rotateLastY  = e.clientY;
        this._rotatePivot = this._raycastToGround(e.clientX, e.clientY, new THREE.Vector3());
        if (!this._rotatePivot) {
            // горизонт/небо — фолбэк на классическое вращение вокруг target
            this._rotatePivot = this.controls.target.clone();
        }
        return;
    }

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

    // NEW: right-drag → rotate around pivot
    if (this._rotatePivotActive) {
        const dx = e.clientX - this._rotateLastX;
        const dy = e.clientY - this._rotateLastY;
        this._rotateLastX = e.clientX;
        this._rotateLastY = e.clientY;
        if (dx !== 0 || dy !== 0) {
            this._rotateAroundPivot(dx, dy, this._rotatePivot);
        }
        return;
    }
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

onMouseUp(e?: MouseEvent) {
    // завершение rotate-to-cursor
    if (this._rotatePivotActive) {
        this._rotatePivotActive = false;
        this._rotatePivot = null;

        return;
    }

    if (!this.isDragging) return;
    this.isDragging = false;
    if (this._cameraAnimation) return;
    this.syncControlsTarget();
},

    onWheel(e: WheelEvent) {
        if (this._cameraAnimation) return;
        e.preventDefault();
        const delta = -Math.sign(e.deltaY) * this.ZOOM_SENSITIVITY;

        // запоминаем точку-пивот для zoom-to-cursor
        this._zoomPivotActive = true;
        this._zoomPivotX = e.clientX;
        this._zoomPivotY = e.clientY;

        this.applyZoomDelta(delta);
    },

    getTouchDistance(touches) {
        const dx = touches[0].clientX - touches[1].clientX;
        const dy = touches[0].clientY - touches[1].clientY;
        return Math.sqrt(dx * dx + dy * dy);
    },

    _raycastToGround(screenX: number, screenY: number, out: any): any | null {
    const rect = this.renderer.domElement.getBoundingClientRect();
    const ndcX = ((screenX - rect.left) / rect.width) * 2 - 1;
    const ndcY = -((screenY - rect.top) / rect.height) * 2 + 1;
    this._tempMouse.set(ndcX, ndcY);
    this._tempRaycaster.setFromCamera(this._tempMouse, this.camera);

    // начальное приближение — плоскость y = 0
    const plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
    if (!this._tempRaycaster.ray.intersectPlane(plane, out)) return null;

    if (!this.hasElevation) return out;

    // 3 итерации Ньютона по высоте
    for (let i = 0; i < 3; i++) {
        const h = this.getSurfaceHeightAt(out.x, out.z);
        if (Math.abs(h) < 0.05) break;
        plane.constant = -h;                       // плоскость y = h
        if (!this._tempRaycaster.ray.intersectPlane(plane, out)) return null;
    }
    return out;
},

_rotateAroundPivot(dxPixels: number, dyPixels: number, pivot: any) {
    const rotateSpeed = this.controls.rotateSpeed;
    const H = this.renderer.domElement.clientHeight || 1;

    // Знаки соответствуют конвенции OrbitControls:
    //   rotateLeft(2π * dx * s / H)  → sphericalDelta.theta -= ...  → dTheta = -2π·dx·s/H
    //   rotateUp  (2π * dy * s / H)  → sphericalDelta.phi   -= ...  → dPhi   = -2π·dy·s/H
    const dTheta = -2 * Math.PI * dxPixels * rotateSpeed / H;
    const dPhi   = -2 * Math.PI * dyPixels * rotateSpeed / H;

    const cam    = this.camera.position.clone();
    const target = this.controls.target.clone();
    const dir    = cam.clone().sub(target);
    const r      = dir.length();
    if (r < 1e-6) return;

    // Pre-clamp по phi, чтобы OrbitControls потом не «схлопывал» камеру
    const phi0 = Math.acos(Math.max(-1, Math.min(1, dir.y / r)));
    const phiAfter = phi0 + dPhi;
    const minP = this.controls.minPolarAngle;
    const maxP = this.controls.maxPolarAngle;
    if (phiAfter < minP || phiAfter > maxP) return;   // упёрлись в зенит/надир — кадр пропускаем

    const theta0 = Math.atan2(dir.x, dir.z);
    const thetaAfter = theta0 + dTheta;

    // R = qH(dPhi, h_afterAzimuth) * qY(dTheta, Y)
    const qY = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), dTheta);
    const h  = new THREE.Vector3(Math.cos(thetaAfter), 0, -Math.sin(thetaAfter));
    const qH = new THREE.Quaternion().setFromAxisAngle(h, dPhi);
    const R  = new THREE.Quaternion().multiplyQuaternions(qH, qY);

    // Вращаем C и T вокруг W
    cam.sub(pivot).applyQuaternion(R).add(pivot);
    target.sub(pivot).applyQuaternion(R).add(pivot);

    this.camera.position.copy(cam);
    this.controls.target.copy(target);
    this.camera.lookAt(target);
    this.camera.updateMatrixWorld(true);
    this.controls.update();

    if ((window as any).__krbDebugRotate) {
        // sanity-check: пивот должен проецироваться туда же, куда в начале драга
        const rect = this.renderer.domElement.getBoundingClientRect();
        const p = pivot.clone().project(this.camera);
        const sx = ( p.x * 0.5 + 0.5) * rect.width  + rect.left;
        const sy = (-p.y * 0.5 + 0.5) * rect.height + rect.top;
        console.log('[rotate] pivot=(%s,%s) start=(%s,%s) diff=(%s,%s)',
            sx.toFixed(1), sy.toFixed(1),
            this._rotatePivotX, this._rotatePivotY,
            (sx - this._rotatePivotX).toFixed(2),
            (sy - this._rotatePivotY).toFixed(2));
    }
    // target после наклона вокруг пивота ушёл с плоскости земли — возвращаем
    this._retargetToGround();
    this.maybeUpdateVisibleTiles();
},

onTouchStart(e: TouchEvent) {
    if (this._cameraAnimation) return;
    this._zoomPivotActive = false;

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
}else if (e.touches.length === 2) {
        e.preventDefault();
        if (this.touchDragActive) { this.touchDragActive = false; this.syncControlsTarget(); }

        const t0 = e.touches[0], t1 = e.touches[1];
        const ts = this.touchState;
        ts.isPinching = true;
        ts.id0 = t0.identifier;
        ts.id1 = t1.identifier;

        const dx = t1.clientX - t0.clientX;
        const dy = t1.clientY - t0.clientY;
        const dist = Math.hypot(dx, dy);
        const angle = Math.atan2(dy, dx);
        const midX = (t0.clientX + t1.clientX) * 0.5;
        const midY = (t0.clientY + t1.clientY) * 0.5;
ts.startDist = ts.prevDist = dist;
ts.startAngle = ts.prevAngle = angle;      // NEW
ts.startMidX = ts.prevMidX = midX;          // NEW
ts.startMidY = ts.prevMidY = midY;          // NEW
ts.startZoom = this.continuousZoom;
ts.accumulatedLineAngle = 0;
ts.activeGesture = null;                    // NEW

const target = this.controls.target;
const dir = this.camera.position.clone().sub(target);
const d = dir.length();
ts.prevAzimuth = Math.atan2(dir.z, dir.x);
ts.prevPitch   = Math.acos(Math.max(-1, Math.min(1, dir.y / d)));
ts.startPitch  = ts.prevPitch;              // NEW
    }
},

    findTouchById(touches, id) {
        for (let i = 0; i < touches.length; i++) {
            if (touches[i].identifier === id) return touches[i];
        }
        return null;
    },

onTouchMove(e: TouchEvent) {
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
    return;
}

if (this.touchState.isPinching && e.touches.length === 2) {
    e.preventDefault();
    const ts = this.touchState;
    const t0 = this.findTouchById(e.touches, ts.id0);
    const t1 = this.findTouchById(e.touches, ts.id1);
    if (!t0 || !t1) return;

    const dx = t1.clientX - t0.clientX;
    const dy = t1.clientY - t0.clientY;
    const curDist  = Math.hypot(dx, dy);
    const curAngle = Math.atan2(dy, dx);
    const midX = (t0.clientX + t1.clientX) * 0.5;
    const midY = (t0.clientY + t1.clientY) * 0.5;
    if (curDist < 1e-3) return;

    // ─────────────────────────────────────────────────────────────
    // 1. КЛАССИФИКАЦИЯ ЖЕСТА (один раз на касание)
    // ─────────────────────────────────────────────────────────────
    if (ts.activeGesture === null) {
        let aDiff = curAngle - ts.startAngle;
        while (aDiff >  Math.PI) aDiff -= 2 * Math.PI;
        while (aDiff < -Math.PI) aDiff += 2 * Math.PI;

        const zoomSignal   = Math.abs(curDist - ts.startDist);
        const rotateSignal = Math.abs(aDiff) * ts.startDist * 0.5; // «пиксели» эквивалент
        const tiltSignal   = Math.abs(midY - ts.startMidY);

        const GESTURE_TRIGGER_PX = 14;   // ниже — «мёртвая зона»
        const TILT_DOMINANCE     = 1.5;  // tilt должен явно доминировать

        const maxSignal = Math.max(zoomSignal, rotateSignal, tiltSignal);
        if (maxSignal < GESTURE_TRIGGER_PX) {
            // ещё не набрали сигнала — просто запоминаем prev
            ts.prevDist = curDist;
            ts.prevAngle = curAngle;
            ts.prevMidX = midX;
            ts.prevMidY = midY;
            return;
        }

        if (tiltSignal >= GESTURE_TRIGGER_PX &&
            tiltSignal >  TILT_DOMINANCE * zoomSignal &&
            tiltSignal >  TILT_DOMINANCE * rotateSignal) {
            // TILT — эксклюзивный режим
            ts.activeGesture = 'tilt';
            ts.startPitch = ts.prevPitch;
            ts.startMidY  = midY;               // база отсчёта — от текущего момента
            ts.startMidX  = midX;
            // для симметрии сохраним дистанцию/угол — вдруг пригодится
            ts.startDist  = curDist;
            ts.startAngle = curAngle;
        } else {
            ts.activeGesture = 'zoomRotate';
        }

        // «мёртвая зона» — накопленное до классификации не применяем
        ts.prevDist = curDist;
        ts.prevAngle = curAngle;
        ts.prevMidX = midX;
        ts.prevMidY = midY;
        return;
    }

    // ─────────────────────────────────────────────────────────────
    // 2. TILT — только pitch, зум и rotate отключены
    // ─────────────────────────────────────────────────────────────
    if (ts.activeGesture === 'tilt') {
        const H = this.renderer.domElement.clientHeight || 1;
        const tiltRange = this.controls.maxPolarAngle - this.controls.minPolarAngle;

        // Полный диапазон pitch (0…85°) за ~35% высоты экрана.
        // Было: maxPolarAngle / H  (полный диапазон за весь экран).
        const TILT_FULL_RANGE_PX = H * 0.35;

        const tiltDeltaPx = ts.startMidY - midY;     // >0, пальцы ушли вверх
        const newPitch = ts.startPitch +
                         tiltDeltaPx * (tiltRange / TILT_FULL_RANGE_PX);

        const target = this.controls.target;
        const currentDist = this.camera.position.distanceTo(target);

        // azimuth не меняем — берём фактический с камеры
        const dir = this._tempVec3a.subVectors(this.camera.position, target);
        const azimuth = Math.atan2(dir.z, dir.x);

        const placement = this._resolveCameraPlacement(
            target, currentDist, newPitch, azimuth, this._tempPlacementOut
        );
        this.camera.position.copy(this._tempPlacementOut);
        this.camera.lookAt(target);
        this.controls.update();

        ts.prevPitch = placement.pitch;
        ts.prevDist  = curDist;
        ts.prevAngle = curAngle;
        ts.prevMidX  = midX;
        ts.prevMidY  = midY;

        this.maybeUpdateVisibleTiles();
        return;
    }

    // ─────────────────────────────────────────────────────────────
    // 3. ZOOM + ROTATE — оригинальное поведение, но БЕЗ tilt
    // ─────────────────────────────────────────────────────────────
    const P_before = this._raycastToGround(ts.prevMidX, ts.prevMidY, this._tempVec3a);

    let angleDelta = curAngle - ts.prevAngle;
    while (angleDelta >  Math.PI) angleDelta -= 2 * Math.PI;
    while (angleDelta < -Math.PI) angleDelta += 2 * Math.PI;

    const zoomDelta = Math.log2(curDist / ts.prevDist);

    const target = this.controls.target;
    const prevCameraDist = this.getTargetDistanceForZoom(this.continuousZoom);
    const newCameraDist  = prevCameraDist * Math.pow(0.5, zoomDelta);
    const newAzimuth     = ts.prevAzimuth - angleDelta;
    const newPitch       = ts.prevPitch;          // ← pitch больше не меняем

    const placement = this._resolveCameraPlacement(
        target, newCameraDist, newPitch, newAzimuth, this._tempPlacementOut
    );
    this.camera.position.copy(this._tempPlacementOut);
    this.camera.lookAt(target);
    this.controls.update();

    const P_after = this._raycastToGround(midX, midY, this._tempVec3b);
    if (P_before && P_after) {
        this.worldGroup.position.x += P_after.x - P_before.x;
        this.worldGroup.position.z += P_after.z - P_before.z;
    }

    ts.prevDist  = curDist;
    ts.prevAngle = curAngle;
    ts.prevMidX  = midX;
    ts.prevMidY  = midY;
    ts.prevAzimuth = newAzimuth;
    ts.prevPitch   = placement.pitch;

    this.continuousZoom = this.getZoomForDistance(
        this.camera.position.distanceTo(target)
    );
    this.targetContinuousZoom = this.continuousZoom;

    this.maybeUpdateVisibleTiles();
}
},

onTouchEnd(e: TouchEvent) {
    if (e.touches.length < 2 && this.touchState.isPinching) {
        this.touchState.isPinching = false;
        this.touchState.activeGesture = null;    // NEW
        if (!this._cameraAnimation) this.syncControlsTarget();
    }
    if (e.touches.length === 0 && this.touchDragActive) {
        this.touchDragActive = false;
        if (!this._cameraAnimation) this.syncControlsTarget();
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