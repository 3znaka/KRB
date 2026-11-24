// CoreInput.ts
import { THREE } from './js_TP/tpb.js';
import type { KrbMap } from './Core.js';

// ───────────────────────────────────────────────────────────────────────
// Module-level temporaries for hot paths.
// These are reused across calls to avoid GC pressure at 60+ fps.
// Safe because JS is single-threaded and each is used only inside one
// method at a time (no interleaving within a single call stack).
// ───────────────────────────────────────────────────────────────────────
const _upAxis = new THREE.Vector3(0, 1, 0);

// For _applyRotationDelta
const _qY = new THREE.Quaternion();
const _qH = new THREE.Quaternion();
const _qR = new THREE.Quaternion();
const _hAxis = new THREE.Vector3();
const _camRel = new THREE.Vector3();
const _tgtRel = new THREE.Vector3();
const _testVec = new THREE.Vector3();
const _ndVec = new THREE.Vector3();
const _nhAxis = new THREE.Vector3();
const _crtVec = new THREE.Vector3();
const _qhInner = new THREE.Quaternion();

// ── Globe drag: дифференциальная орбита камеры ──
const _gUp   = new THREE.Vector3(0, 1, 0);
const _gCam  = new THREE.Vector3();
const _gN    = new THREE.Vector3();
const _gAxis = new THREE.Vector3();
const _gA    = new THREE.Vector3();   // hit под ПРОШЛЫМ курсором
const _gB    = new THREE.Vector3();   // hit под ТЕКУЩИМ курсором
const GLOBE_MAX_LAT = 89.99 * Math.PI / 180;
const _clamp1 = (v: number) => Math.max(-1, Math.min(1, v));
const _wrapPi = (a: number) => {
    while (a >  Math.PI) a -= 2 * Math.PI;
    while (a < -Math.PI) a += 2 * Math.PI;
    return a;
};


// For _raycastToGround — separate plane from this.groundPlane,
// because the latter is used for pan-drag with a *frozen* height and must
// not be mutated by the terrain Newton iteration.
const _rayPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);

export interface CoreInputMethods {
    initDragTools(): void;
    initTouchState(): void;
    onMouseDown(e: MouseEvent): void;
    onMouseMove(e: MouseEvent): void;
    onMouseUp(): void;
    onWheel(e: WheelEvent): void;
    _shouldUseCursorPivot(zoomDelta: number): boolean;
    getTouchDistance(touches: TouchList): number;
    _raycastToGround(screenX: number, screenY: number, out: any): any | null;
    _rotateAroundPivot(dxPixels: number, dyPixels: number, pivot: any): void;
    _applyRotationDelta(dTheta: number, dPhi: number, pivot: any): void;
    onTouchStart(e: TouchEvent): void;
    findTouchById(touches: TouchList, id: number | null): Touch | null;
    onTouchMove(e: TouchEvent): void;
    onTouchEnd(e: TouchEvent): void;
    onResize(): void;
    onClick(e: MouseEvent): void;
    bindEvents(): void;
        _globeOrbit(dx: number, dy: number): void;
    _globeGrabAt(screenX: number, screenY: number): boolean;   // ← добавить
    shiftWorld(dx: number, dz: number): void;
    shiftWorld(dx: number, dz: number): void;
    resize(): void;
    _getCanvasRect(): { left: number; top: number; width: number; height: number };
    _invalidateCanvasRect(): void;
    _correctGlobeRoll(): void;  
    
    
}

export const CoreInputMixin: CoreInputMethods & ThisType<KrbMap> = {
initDragTools() {
    // groundPlane используется двумя разными путями:
    //  - в onMouseDown/onTouchStart он временно «ставится» на высоту террейна
    //    под курсором (constant = -hit.y) — это фиксирует плоскость панорамы
    //    на реальной высоте и убирает покадровый LOD-шум при hasElevation.
    //  - в onMouseMove/onTouchMove по этой плоскости идёт линейный рейкаст,
    //    стабильный при любом pitch-угле.
    //  - в onClick — точка «сэмплинга» debug'а shift-click.
    // Между жестами значение constant может быть любым, но первый же
    // mousedown/touchstart его переустанавливает.
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

    // Canvas rect cache — see _getCanvasRect()
    (this as any)._cachedCanvasRect = null;
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

        // ── Dynamic reclassification state ──
        smoothZoom: 0,
        smoothRotate: 0,
        smoothTilt: 0,
        candidateGesture: null,
        candidateFrames: 0,
        lastSwitchTime: 0,
    };
},

// ───────────────────────────────────────────────────────────────────────
// Cached canvas rect. getBoundingClientRect() triggers a layout reflow,
// which is why calling it on every pointermove is expensive. Cache it
// and invalidate only when the layout can actually change.
// ───────────────────────────────────────────────────────────────────────
_getCanvasRect() {
    let r = (this as any)._cachedCanvasRect;
    if (!r) {
        r = this.renderer.domElement.getBoundingClientRect();
        (this as any)._cachedCanvasRect = r;
    }
    return r;
},

_invalidateCanvasRect() {
    (this as any)._cachedCanvasRect = null;
},

/** Фиксирует точку захвата под курсором (единичный вектор в СК глобуса). */
_globeGrabAt(screenX: number, screenY: number): boolean {
    this._globeGrabActive = false;
    if (!this.globe) return false;
    const hit = this._raycastToGround(screenX, screenY, this._globeGrabDir);
    if (!hit) return false;
    this.worldGroup.worldToLocal(hit);
    const len = hit.length();
    if (len < 1e-6) return false;
    hit.divideScalar(len);
    this._globeGrabActive = true;
    return true;
},

/**
 * Дифференциальный драг глобуса. Без якоря и без накопленной ошибки:
 * каждый кадр заново измеряем две точки ОДНОЙ камерой и переносим ТОЧКУ
 * ОБЗОРА (цель) на эту разницу. Камера ставится относительно цели с тем
 * же pitch/bearing, поэтому вся картинка поворачивается как единое целое
 * вокруг центра Земли — при наклоне/повороте это тоже корректно.
 */
_globeOrbit(dx: number, dy: number): void {
    if (!this.globe || !this.worldGroup) return;
    if (dx === 0 && dy === 0) return;

    const cam = this.camera;
    const wg  = this.worldGroup;
    const H   = this.renderer.domElement.clientHeight || 1;

    _gCam.copy(this.controls.target);
    wg.worldToLocal(_gCam);
    const dT = _gCam.length();
    if (!(dT > 1e-6)) return;
    _gN.copy(_gCam).divideScalar(dT);

    const x0 = this._globeLastX, y0 = this._globeLastY;
    const x1 = x0 + dx,          y1 = y0 + dy;

    // ОБА луча — до перемещения камеры. Это и есть весь фикс.
    const A = this._raycastToGround(x0, y0, _gA);
    const B = this._raycastToGround(x1, y1, _gB);

    let dLon = 0, dLat = 0, picked = false;
    if (A && B) {
        wg.worldToLocal(A);
        wg.worldToLocal(B);
        const la = A.length(), lb = B.length();
        if (la > 1e-6 && lb > 1e-6) {
            A.divideScalar(la);
            B.divideScalar(lb);
            dLon = _wrapPi(Math.atan2(-A.z, A.x) - Math.atan2(-B.z, B.x));
            dLat = Math.asin(_clamp1(A.y)) - Math.asin(_clamp1(B.y));
            picked = true;
        }
    }

    const pix = Math.hypot(dx, dy);
    const cap = (pix / H) * Math.PI;   // ≤ пол-оборота на высоту экрана

    if (picked) {
        const mag = Math.hypot(dLon, dLat);
        if (mag > cap && mag > 0) {
            // режем ВХОД, обрезанное забывается — долга не возникает
            const k = cap / mag;
            dLon *= k; dLat *= k;
        } else if (mag > 1e-12) {
            // запоминаем масштаб только на «честных» шагах (не у кромки)
            const s = mag / pix;
            this._globeRadPerPx = this._globeRadPerPx > 0
                ? this._globeRadPerPx * 0.7 + s * 0.3
                : s;
        }
    } else {
        // один из лучей ушёл с диска — продолжаем в том же масштабе
        let s = this._globeRadPerPx;
        if (!(s > 0)) {
            const h = Math.max(cam.position.distanceTo(this.controls.target), 1);
            s = (2 * h * Math.tan(cam.fov * Math.PI / 360)) / H / this.R;
        }
        s = Math.min(s, Math.PI / H);
        dLon = -dx * s;
        dLat =  dy * s;
    }

    // 1) долгота — вокруг мировой Y (полюс не наклоняется)
    if (dLon !== 0) _gN.applyAxisAngle(_gUp, dLon);

    // 2) широта — вокруг горизонтальной оси «запад» = n × Y
    _gAxis.crossVectors(_gN, _gUp);
    if (_gAxis.lengthSq() < 1e-14) _gAxis.set(1, 0, 0); else _gAxis.normalize();
    const lat = Math.asin(_clamp1(_gN.y));
    const newLat = Math.max(-GLOBE_MAX_LAT, Math.min(GLOBE_MAX_LAT, lat + dLat));
    const eff = newLat - lat;
    if (eff !== 0) _gN.applyAxisAngle(_gAxis, eff);

    // Новая точка обзора на поверхности + поза с прежним наклоном/азимутом.
    this._globeSetTargetDir(_gN);
    const dist = this.getTargetDistanceForZoom(this.continuousZoom);
    this._globeApplyPose(dist, this._globePitchNow(), this._globeBearingNow());
    this.controls.update();

    this._globeLastX = x1;
    this._globeLastY = y1;

    // ── EMA скорости вращения для инерции (px/с), коэффициенты как в плоском pan ──
    // Копим только «честные» шаги (оба луча попали в диск). Если курсор/палец
    // ушёл за пределы глобуса — скорость обнуляем, иначе она берётся из
    // масштабированного фолбэка и при отпускании глобус раскручивается сам.
    const nowT = performance.now();
    this._globeLastPickedHit = picked;
    if (picked) {
        const dtMv = Math.max((nowT - this._globeOrbitLastMoveTime) / 1000, 0.001);
        this._globeOrbitVelX = 0.6 * this._globeOrbitVelX + 0.4 * (dx / dtMv);
        this._globeOrbitVelY = 0.6 * this._globeOrbitVelY + 0.4 * (dy / dtMv);
    } else {
        this._globeOrbitVelX = 0;
        this._globeOrbitVelY = 0;
    }
    this._globeOrbitLastMoveTime = nowT;

    this.maybeUpdateVisibleTiles();
},

_correctGlobeRoll(): void {
    // no-op: крен невозможен по построению. УДАЛИ вызов из CoreLifecycle.animate().
},

onMouseDown(e) {
    if (this._rulerDragging) return; 
    if (this._cameraAnimation) return;
    this._zoomPivotActive = false;

    // Invalidate rect on the start of a new gesture, in case the page
    // scrolled without a resize event.
    this._invalidateCanvasRect();

    // ── останавливаем pan-инерцию ──
    this._panVelX = 0;
    this._panVelZ = 0;
    // ── и инерцию вращения глобуса ──
    this._globeOrbitVelX = 0;
    this._globeOrbitVelY = 0;

    if (e.button === 2) {
        if (this.globe) {
            // На глобусе поворот/наклон включаются только с зума ≈6
            // (когда Земля занимает весь кадр) — см. _globeTiltEnabled().
            if (!this._globeTiltEnabled()) return;
            if (!this.allowRotate && !this.allowPitch) return;
        } else if (!this.allowRotate) {
            return;
        }
        this._rotatePivotActive = true;

        this._rotatePivotX = e.clientX;
        this._rotatePivotY = e.clientY;
        this._rotateLastX  = e.clientX;
        this._rotateLastY  = e.clientY;

        // Reuse a persistent Vector3 for the pivot — avoids allocation
        // on every right-click. It's fine to leave stale data after
        // mouseup, since _rotatePivotActive gates all readers.
        if (!this._rotatePivot) this._rotatePivot = new THREE.Vector3();
        const hit = this._raycastToGround(e.clientX, e.clientY, this._rotatePivot);
        if (!hit) {
            // горизонт/небо — фолбэк на классическое вращение вокруг target
            this._rotatePivot.copy(this.controls.target);
        }

        if (this.globe) {
            // Якорь вращения на весь жест: точка, схваченная курсором.
            this._globeRotateAnchor = this._rotatePivot.clone();
            this._globeRotateAnchorX = e.clientX;
            this._globeRotateAnchorY = e.clientY;
        }
        return;
    }

    if (e.button !== 0) return;
    this._mouseDownX = e.clientX;
    this._mouseDownY = e.clientY;
    this._mouseMoved = false;

if (this.globe) {
    this.isDragging = true;
    this._globeLastX = e.clientX;
    this._globeLastY = e.clientY;
    this._globeRadPerPx = 0;     
    this._panVelX = 0;
    this._panVelZ = 0;
    this._globeOrbitVelX = 0;
    this._globeOrbitVelY = 0;
    this._globeOrbitLastMoveTime = performance.now();
    return;
}

    if (this._raycastToGround(e.clientX, e.clientY, this.intersection)) {
        this.isDragging = true;
        this.dragLocalPoint.copy(this.intersection).sub(this.worldGroup.position);
        this.groundPlane.constant = -this.intersection.y;

        this._panLastMoveTime = performance.now();
        this._panLastWorldX   = this.worldGroup.position.x;
        this._panLastWorldZ   = this.worldGroup.position.z;
    }
},

onMouseMove(e) {
    if (this._rulerDragging) return; 
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

if (this.globe) {
    const dx = e.clientX - this._globeLastX;
    const dy = e.clientY - this._globeLastY;
    if (dx !== 0 || dy !== 0) this._globeOrbit(dx, dy);
    return;
}

    // Линейный рейкаст по замороженной плоскости (см. onMouseDown).
    // Никакого getSurfaceHeightAt()/Newton здесь — панорама стабильна.
    const rect = this._getCanvasRect();
    this.mouse.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
    this.mouse.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
    this.raycasterDragger.setFromCamera(this.mouse, this.camera);
    if (this.raycasterDragger.ray.intersectPlane(this.groundPlane, this.intersection)) {
        // Только X/Z: worldGroup.position.y всегда 0. Если писать сюда
        // Y-разницу от драга, весь мир поедет вверх/вниз при рельефе.
        this.worldGroup.position.x = this.intersection.x - this.dragLocalPoint.x;
        this.worldGroup.position.z = this.intersection.z - this.dragLocalPoint.z;
        this._enforceMaxBounds();

        // ── EMA pan-скорости ──
        const now = performance.now();
        const dt  = Math.max((now - this._panLastMoveTime) / 1000, 0.001);
        const dxW = this.worldGroup.position.x - this._panLastWorldX;
        const dzW = this.worldGroup.position.z - this._panLastWorldZ;
        this._panVelX = 0.6 * this._panVelX + 0.4 * (dxW / dt);
        this._panVelZ = 0.6 * this._panVelZ + 0.4 * (dzW / dt);
        this._panLastMoveTime = now;
        this._panLastWorldX   = this.worldGroup.position.x;
        this._panLastWorldZ   = this.worldGroup.position.z;

        this.maybeUpdateVisibleTiles();
    }
},



onMouseUp(e?: MouseEvent) {
    if (this._rulerDragging) return; 
    // завершение rotate-to-cursor
    if (this._rotatePivotActive) {
        this._rotatePivotActive = false;
        // _rotatePivot НЕ обнуляем — переиспользуется на следующем mousedown.
        // Якорь глобуса — сбрасываем: следующий жест схватит новую точку.
        this._globeRotateAnchor = null;
        return;
    }

    if (!this.isDragging) return;
    this.isDragging = false;
    if (this._cameraAnimation) return;

    // ── pan-инерция: гасим, если мышь давно стояла ──
    if (!this.panInertia || performance.now() - this._panLastMoveTime > 100) {
        this._panVelX = 0;
        this._panVelZ = 0;
    }
    // ── инерция вращения глобуса: тот же критерий остановки ──
    if (!this.panInertia || performance.now() - this._globeOrbitLastMoveTime > 100) {
        this._globeOrbitVelX = 0;
        this._globeOrbitVelY = 0;
    }
    // Вне диска скорости нет вообще (см. _globeOrbit): гарантированно гасим.
    if (!this._globeLastPickedHit) {
        this._globeOrbitVelX = 0;
        this._globeOrbitVelY = 0;
    }

    this.syncControlsTarget();
},

/**
 * Глобус: на низких зумах zoom идёт из центра, а не из курсора/пальцев.
 *  - отдаление: из центра при зуме ≤ GLOBE_CENTER_ZOOM_OUT_MAX (по умолчанию 5);
 *  - приближение: из центра при зуме ≤ GLOBE_CENTER_ZOOM_IN_MAX (по умолчанию 4),
 *    т.е. курсорный zoom-in начинается с 5 зума.
 * Иначе точка под курсором далеко от центра Земли, и доворот цели
 * «раскручивает» глобус по инерции.
 * Возвращает true, если pivot по курсору нужно взвести.
 */
_shouldUseCursorPivot(zoomDelta: number): boolean {
    if (!this.globe) return true;
    const zoomingIn = zoomDelta > 0;
    const limit = zoomingIn ? this.GLOBE_CENTER_ZOOM_IN_MAX : this.GLOBE_CENTER_ZOOM_OUT_MAX;
    return this.continuousZoom > limit;
},

onWheel(e: WheelEvent) {
    if (this._cameraAnimation) return;
    e.preventDefault();
    if (e.deltaY === 0) return;

    const delta = -Math.sign(e.deltaY) * this.ZOOM_SENSITIVITY;

    // запоминаем точку-пивот для zoom-to-cursor: работает и на плоской
    // карте, и на глобусе (там камера доворачивается, а не сдвигается мир).
    // На глобусе при отдалении с низких зумов — из центра (см. _shouldUseCursorPivot).
    if (this._shouldUseCursorPivot(delta)) {
        this._zoomPivotActive = true;
        this._zoomPivotX = e.clientX;
        this._zoomPivotY = e.clientY;
    } else {
        this._zoomPivotActive = false;
    }

    // Позиция мыши изменится после зума, но rect останется прежним,
    // так что не инвалидируем — просто используем накопленное.

    this.applyZoomDelta(delta);
},

getTouchDistance(touches) {
    const dx = touches[0].clientX - touches[1].clientX;
    const dy = touches[0].clientY - touches[1].clientY;
    return Math.sqrt(dx * dx + dy * dy);
},

// ───────────────────────────────────────────────────────────────────────
// Raycast against the terrain (or y=0 ground plane when no elevation).
// Uses a module-scoped Plane — safe because the function is synchronous
// and getSurfaceHeightAt does not re-enter raycasting.
//
// Используется:
//  - в onMouseDown/onTouchStart — чтобы получить реальную высоту точки
//    захвата (для последующей заморозки groundPlane);
//  - в onMouseDown(right)/_rotateAroundPivot — пивот вращения;
//  - в _applyRotationDelta — проверки clearance камеры при вращении;
//  - в pinch-жесте — стабилизация точки под пальцами.
// ───────────────────────────────────────────────────────────────────────
_raycastToGround(screenX: number, screenY: number, out: any): any | null {
    const rect = this._getCanvasRect();
    const ndcX = ((screenX - rect.left) / rect.width) * 2 - 1;
    const ndcY = -((screenY - rect.top) / rect.height) * 2 + 1;
    this._tempMouse.set(ndcX, ndcY);
    this._tempRaycaster.setFromCamera(this._tempMouse, this.camera);

    if (this.globe) {
    return this.surface.raycast(this._tempRaycaster, out, this.worldGroup);
}

    // Начальное приближение — плоскость y = 0.
    _rayPlane.constant = 0;
    if (!this._tempRaycaster.ray.intersectPlane(_rayPlane, out)) return null;

    if (!this.hasElevation) return out;

    // 3 итерации Ньютона по высоте
    for (let i = 0; i < 3; i++) {
        const h = this.getSurfaceHeightAt(out.x, out.z);
        if (Math.abs(h) < 0.05) break;
        _rayPlane.constant = -h;                 // плоскость y = h
        if (!this._tempRaycaster.ray.intersectPlane(_rayPlane, out)) return null;
    }
    return out;
},

_rotateAroundPivot(dxPixels: number, dyPixels: number, pivot: any) {
    if (this.globe) {
        // Глобус: вращение вокруг точки под курсором в местном базисе.
        this._globeRotateAroundPivot(dxPixels, dyPixels, pivot);
        return;
    }
    const rotateSpeed = this.controls.rotateSpeed;
    const H = this.renderer.domElement.clientHeight || 1;

    // Знаки соответствуют конвенции OrbitControls:
    //   rotateLeft(2π * dx * s / H)  → sphericalDelta.theta -= ...  → dTheta = -2π·dx·s/H
    //   rotateUp  (2π * dy * s / H)  → sphericalDelta.phi   -= ...  → dPhi   = -2π·dy·s/H
    const dTheta = -2 * Math.PI * dxPixels * rotateSpeed / H;
    const dPhi   = -2 * Math.PI * dyPixels * rotateSpeed / H;

    this._applyRotationDelta(dTheta, dPhi, pivot);

    if ((window as any).__krbDebugRotate) {
        // sanity-check: пивот должен проецироваться туда же, куда в начале драга
        const rect = this._getCanvasRect();
        const p = pivot.clone().project(this.camera);
        const sx = ( p.x * 0.5 + 0.5) * rect.width  + rect.left;
        const sy = (-p.y * 0.5 + 0.5) * rect.height + rect.top;
        console.log('[rotate] pivot=(%s,%s) start=(%s,%s) diff=(%s,%s)',
            sx.toFixed(1), sy.toFixed(1),
            this._rotatePivotX, this._rotatePivotY,
            (sx - this._rotatePivotX).toFixed(2),
            (sy - this._rotatePivotY).toFixed(2));
    }
},

// Применяет уже вычисленные dTheta/dPhi — переиспользуется и при drag, и при инерции.
//
// В отличие от исходной версии не создаёт ни одного нового THREE-объекта —
// все промежуточные величины живут в модульных temp-константах.
_applyRotationDelta(dTheta: number, dPhi: number, pivot: any) {
    const cam    = this.camera.position;
    const target = this.controls.target;
    const dir    = this._tempDir.subVectors(cam, target);
    const r      = dir.length();
    if (r < 1e-6) return;

    // 1. Ограничиваем pitch взгляда диапазоном [minPolarAngle, maxPolarAngle]
    const minP = this.controls.minPolarAngle;
    const maxP = this.controls.maxPolarAngle;
    const phi0 = Math.acos(Math.max(-1, Math.min(1, dir.y / r)));
    dPhi = Math.max(minP, Math.min(maxP, phi0 + dPhi)) - phi0;

    const dPhiRequested = dPhi;   // сколько хотели наклонить

    const theta0     = Math.atan2(dir.x, dir.z);
    const thetaAfter = theta0 + dTheta;

    _qY.setFromAxisAngle(_upAxis, dTheta);
    _hAxis.set(Math.cos(thetaAfter), 0, -Math.sin(thetaAfter));

    _camRel.subVectors(cam, pivot);
    _tgtRel.subVectors(target, pivot);

    const buildR = (a: number) => {
        _qH.setFromAxisAngle(_hAxis, a);
        _qR.multiplyQuaternions(_qH, _qY);
    };

    const clearanceAt = (a: number): number => {
        buildR(a);
        _testVec.copy(_camRel).applyQuaternion(_qR).add(pivot);
        const ground = this.hasElevation ? this.getSurfaceHeightAt(_testVec.x, _testVec.z) : 0;
        return _testVec.y - (ground + this.CAMERA_TERRAIN_CLEARANCE);
    };

    // 2. Ограничиваем dPhi так, чтобы камера не ушла под землю при вращении вокруг пивота
    if (dPhi !== 0) {
        const fEnd = clearanceAt(dPhi);
        if (fEnd < 0) {
            const f0 = clearanceAt(0);
            if (f0 >= 0) {
                let lo = 0, hi = dPhi;
                for (let i = 0; i < 10; i++) {
                    const mid = (lo + hi) * 0.5;
                    if (clearanceAt(mid) >= 0) lo = mid; else hi = mid;
                }
                dPhi = lo;
            } else if (fEnd <= f0) {
                dPhi = 0;
            }
        }
    }

    // 3. Применяем вращение вокруг пивота
    buildR(dPhi);
    cam.copy(_camRel).applyQuaternion(_qR).add(pivot);
    target.copy(_tgtRel).applyQuaternion(_qR).add(pivot);

    // 4. Возвращаем target на землю, чтобы дальше вращаться вокруг нормального пивота
    this._retargetToGround();

    // 5. Докручиваем остаток dPhi вокруг controls.target
    let dPhiResidual = dPhiRequested - dPhi;
    if (Math.abs(dPhiResidual) > 1e-6) {
        _ndVec.subVectors(cam, target);
        const nth = Math.atan2(_ndVec.x, _ndVec.z);
        _nhAxis.set(Math.cos(nth), 0, -Math.sin(nth));

        const clearAt = (a: number): number => {
            _crtVec.subVectors(cam, target);
            _qhInner.setFromAxisAngle(_nhAxis, a);
            _crtVec.applyQuaternion(_qhInner);
            const px = target.x + _crtVec.x;
            const py = target.y + _crtVec.y;
            const pz = target.z + _crtVec.z;
            const ground = this.hasElevation ? this.getSurfaceHeightAt(px, pz) : 0;
            return py - (ground + this.CAMERA_TERRAIN_CLEARANCE);
        };

        if (dPhiResidual > 0 && clearAt(dPhiResidual) < 0) {
            if (clearAt(0) >= 0) {
                let lo = 0, hi = dPhiResidual;
                for (let i = 0; i < 10; i++) {
                    const mid = (lo + hi) * 0.5;
                    if (clearAt(mid) >= 0) lo = mid; else hi = mid;
                }
                dPhiResidual = lo;
            } else {
                dPhiResidual = 0;
            }
        }
        if (Math.abs(dPhiResidual) > 1e-6) {
            _crtVec.subVectors(cam, target);
            _qhInner.setFromAxisAngle(_nhAxis, dPhiResidual);
            _crtVec.applyQuaternion(_qhInner);
            cam.copy(target).add(_crtVec);
        }
    }

    this.camera.lookAt(target);
    this.camera.updateMatrixWorld(true);
    this.controls.update();

    this.maybeUpdateVisibleTiles();
},

onTouchStart(e: TouchEvent) {
    if (this._rulerDragging) return; 
    if (this._cameraAnimation) return;
    this._zoomPivotActive = false;
    this._invalidateCanvasRect();

    if (e.touches.length === 1) {

if (this.globe) {
    e.preventDefault();
    const t = e.touches[0];
    this.touchDragActive = true;
    this.touchState.isPinching = false;
    this._globeLastX = t.clientX;
    this._globeLastY = t.clientY;
    this._globeRadPerPx = 0;
    this._globeOrbitVelX = 0;
    this._globeOrbitVelY = 0;
    this._globeOrbitLastMoveTime = performance.now();
    return;
}

        // ── сброс pan-скорости ──
        this._panVelX = 0;
        this._panVelZ = 0;

        // Террейн-осведомлённый рейкаст + заморозка плоскости,
        // аналогично onMouseDown.
        const touch = e.touches[0];
        if (this._raycastToGround(touch.clientX, touch.clientY, this.intersection)) {
            this.touchDragActive = true;
            this.touchDragLocalPoint.copy(this.intersection).sub(this.worldGroup.position);
            this.groundPlane.constant = -this.intersection.y;

            this._panLastMoveTime = performance.now();
            this._panLastWorldX   = this.worldGroup.position.x;
            this._panLastWorldZ   = this.worldGroup.position.z;
        }
        this.touchState.isPinching = false;
    } else if (e.touches.length === 2) {
        e.preventDefault();
        if (this.touchDragActive) { this.touchDragActive = false; this.syncControlsTarget(); }

        // ── останавливаем pan-инерцию ──
        this._panVelX = 0;
        this._panVelZ = 0;
        this._globeOrbitVelX = 0;
        this._globeOrbitVelY = 0;

        const t0 = e.touches[0], t1 = e.touches[1];
        const ts = this.touchState;
        ts.isPinching = true;
        ts.id0 = t0.identifier;
        ts.id1 = t1.identifier;

        const dx = t1.clientX - t0.clientX;
        const dy = t1.clientY - t0.clientY;
        const dist = Math.sqrt(dx * dx + dy * dy);
        const angle = Math.atan2(dy, dx);
        const midX = (t0.clientX + t1.clientX) * 0.5;
        const midY = (t0.clientY + t1.clientY) * 0.5;
        ts.startDist = ts.prevDist = dist;
        ts.startAngle = ts.prevAngle = angle;
        ts.startMidX = ts.prevMidX = midX;
        ts.startMidY = ts.prevMidY = midY;
        ts.startZoom = this.continuousZoom;
        ts.accumulatedLineAngle = 0;
        ts.activeGesture = null;

        // ── reset dynamic-classification state ──
        ts.smoothZoom = 0;
        ts.smoothRotate = 0;
        ts.smoothTilt = 0;
        ts.candidateGesture = null;
        ts.candidateFrames = 0;
        ts.lastSwitchTime = 0;

        if (this.globe) {
            // На глобусе pitch/bearing — состояние в локальном базисе.
            ts.prevAzimuth = this._globeBearingNow();
            ts.prevPitch   = this._globePitchNow();
            ts.startPitch  = ts.prevPitch;
        } else {
            const target = this.controls.target;
            const dir = this._tempVec3a.subVectors(this.camera.position, target);
            const d = dir.length();
            ts.prevAzimuth = Math.atan2(dir.z, dir.x);
            ts.prevPitch   = Math.acos(Math.max(-1, Math.min(1, dir.y / d)));
            ts.startPitch  = ts.prevPitch;
        }
    }
},

findTouchById(touches, id) {
    for (let i = 0; i < touches.length; i++) {
        if (touches[i].identifier === id) return touches[i];
    }
    return null;
},

onTouchMove(e: TouchEvent) {
    if (this._rulerDragging) return; 
    if (this._cameraAnimation) return;

    if (this.touchDragActive && e.touches.length === 1) {
    e.preventDefault();
    if (this.globe) {
        const t = e.touches[0];
        const dx = t.clientX - this._globeLastX;
        const dy = t.clientY - this._globeLastY;
        if (dx !== 0 || dy !== 0) this._globeOrbit(dx, dy);
        return;
    }

        // Линейный рейкаст по замороженной плоскости (см. onMouseDown).
        const touch = e.touches[0];
        const rect = this._getCanvasRect();
        this.touchMouse.x = ((touch.clientX - rect.left) / rect.width) * 2 - 1;
        this.touchMouse.y = -((touch.clientY - rect.top) / rect.height) * 2 + 1;
        this.raycasterDragger.setFromCamera(this.touchMouse, this.camera);
        if (this.raycasterDragger.ray.intersectPlane(this.groundPlane, this.intersection)) {
            // Только X/Z, как и в mouse-пути.
            this.worldGroup.position.x = this.intersection.x - this.touchDragLocalPoint.x;
            this.worldGroup.position.z = this.intersection.z - this.touchDragLocalPoint.z;
            this._enforceMaxBounds();

            // ── EMA pan-скорости ──
            const now = performance.now();
            const dt  = Math.max((now - this._panLastMoveTime) / 1000, 0.001);
            const dxW = this.worldGroup.position.x - this._panLastWorldX;
            const dzW = this.worldGroup.position.z - this._panLastWorldZ;
            this._panVelX = 0.6 * this._panVelX + 0.4 * (dxW / dt);
            this._panVelZ = 0.6 * this._panVelZ + 0.4 * (dzW / dt);
            this._panLastMoveTime = now;
            this._panLastWorldX   = this.worldGroup.position.x;
            this._panLastWorldZ   = this.worldGroup.position.z;

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
        const curDist  = Math.sqrt(dx * dx + dy * dy);
        const curAngle = Math.atan2(dy, dx);
        const midX = (t0.clientX + t1.clientX) * 0.5;
        const midY = (t0.clientY + t1.clientY) * 0.5;
        if (curDist < 1e-3) return;

if (this.globe) {
    // ── Pinch на глобусе ────────────────────────────────────────────
    // Та же идея, что в плоской ветке: классифицируем жест на «tilt» и
    // «zoom+rotate» (EMA-пороги + 3 стабильных кадра), чтобы вертикальное
    // движение двух пальцев не мешало зуму/повороту и наоборот.
    const angleDelta = _wrapPi(curAngle - ts.prevAngle);
    const dDist   = Math.abs(curDist - ts.prevDist);
    const dRotate = this.allowRotate ? Math.abs(angleDelta) * curDist * 0.5 : 0;
    const dMidY   = this.allowPitch ? Math.abs(midY - ts.prevMidY) : 0;

    const EMA = 0.3;
    ts.smoothZoom   = (1 - EMA) * ts.smoothZoom   + EMA * dDist;
    ts.smoothRotate = (1 - EMA) * ts.smoothRotate + EMA * dRotate;
    ts.smoothTilt   = (1 - EMA) * ts.smoothTilt   + EMA * dMidY;
    const smoothTotal = ts.smoothZoom + ts.smoothRotate + ts.smoothTilt;
    if (smoothTotal < 0.5) {
        ts.candidateGesture = null;
        ts.candidateFrames = 0;
        ts.prevDist = curDist; ts.prevAngle = curAngle;
        ts.prevMidX = midX; ts.prevMidY = midY;
        return;
    }

    const tiltWeighted = ts.smoothTilt / 0.9;
    const winner = (this.allowPitch && tiltWeighted > Math.max(ts.smoothZoom, ts.smoothRotate))
        ? 'tilt' : 'zoomRotate';
    if (winner !== ts.activeGesture) {
        if (winner === ts.candidateGesture) ts.candidateFrames++;
        else { ts.candidateGesture = winner; ts.candidateFrames = 1; }
        const now = performance.now();
        const canSwitch = ts.activeGesture === null || now - ts.lastSwitchTime > 120;
        if (ts.candidateFrames >= 3 && canSwitch) {
            ts.activeGesture = winner;
            ts.lastSwitchTime = now;
            ts.candidateGesture = null;
            ts.candidateFrames = 0;
            // Перебазирование входящего жеста.
            if (winner === 'tilt') {
                ts.startMidY = midY;
                ts.startPitch = this._globePitchNow();
            }
            ts.prevDist = curDist; ts.prevAngle = curAngle;
            ts.prevMidX = midX; ts.prevMidY = midY;
        }
    } else {
        ts.candidateGesture = null;
        ts.candidateFrames = 0;
    }

    if (ts.activeGesture === 'tilt') {
        // Вертикальное движение середины → наклон камеры.
        const H2 = this.renderer.domElement.clientHeight || 1;
        const TILT_FULL_RANGE_PX = H2 * 0.30;
        const maxPitch = this._globeMaxPitch();
        const tiltDeltaPx = ts.startMidY - midY;
        const newPitch = ts.startPitch + tiltDeltaPx * (maxPitch / TILT_FULL_RANGE_PX);
        this._globePitch = Math.max(0, Math.min(maxPitch, newPitch));
        this._globePitchTarget = this._globePitch;
        this._globeApplyPose(this.getTargetDistanceForZoom(this.continuousZoom),
            this._globePitchNow(), this._globeBearingNow());
        ts.prevDist = curDist; ts.prevAngle = curAngle;
        ts.prevMidX = midX; ts.prevMidY = midY;
        this.maybeUpdateVisibleTiles();
        return;
    }

    // ── zoom + rotate + панорама ──
    const zd = Math.log2(curDist / ts.prevDist);
    // Пинч-отдаление на низких зумах — из центра (как колесо), без пивота по пальцам.
    this._zoomPivotActive = this._shouldUseCursorPivot(zd);
    this._zoomPivotX = midX;
    this._zoomPivotY = midY;
    if (isFinite(zd) && zd !== 0) this.applyZoomDelta(zd);

    // Поворот карты по углу между пальцами (знак как в плоской ветке).
    if (this.allowRotate && angleDelta !== 0) {
        this._globeBearing -= angleDelta;
        this._globeBearingTarget = this._globeBearing;
        this._globeApplyPose(this.getTargetDistanceForZoom(this.continuousZoom),
            this._globePitchNow(), this._globeBearingNow());
    }

    // Панорама по смещению середины (пивот — предыдущая середина).
    const mdx = midX - ts.prevMidX;
    const mdy = midY - ts.prevMidY;
    if (mdx !== 0 || mdy !== 0) {
        this._globeLastX = midX - mdx;
        this._globeLastY = midY - mdy;
        this._globeOrbit(mdx, mdy);
        // Жест двумя пальцами — без инерции вращения (как flat-путь).
        this._globeOrbitVelX = 0;
        this._globeOrbitVelY = 0;
    }

    ts.prevDist = curDist; ts.prevAngle = curAngle;
    ts.prevMidX = midX;    ts.prevMidY = midY;
    return;
}

        // ─────────────────────────────────────────────────────────────
        // Мгновенные дельты текущего кадра (для классификации).
        // ─────────────────────────────────────────────────────────────
        let angleDelta = curAngle - ts.prevAngle;
        while (angleDelta >  Math.PI) angleDelta -= 2 * Math.PI;
        while (angleDelta < -Math.PI) angleDelta += 2 * Math.PI;

        const dDist   = Math.abs(curDist - ts.prevDist);
        const dRotate = this.allowRotate ? Math.abs(angleDelta) * curDist * 0.5 : 0;
        const dMidY   = this.allowPitch  ? Math.abs(midY - ts.prevMidY)         : 0;

        // ─────────────────────────────────────────────────────────────
        // EMA-сглаживание (α = 0.3)
        // ─────────────────────────────────────────────────────────────
        const EMA = 0.3;
        ts.smoothZoom   = (1 - EMA) * ts.smoothZoom   + EMA * dDist;
        ts.smoothRotate = (1 - EMA) * ts.smoothRotate + EMA * dRotate;
        ts.smoothTilt   = (1 - EMA) * ts.smoothTilt   + EMA * dMidY;

        // ─────────────────────────────────────────────────────────────
        // ДИНАМИЧЕСКАЯ КЛАССИФИКАЦИЯ / РЕКЛАССИФИКАЦИЯ
        // ─────────────────────────────────────────────────────────────
        const TILT_BIAS          = 0.9;   // <1 = tilt легче; >1 = tilt строже
        const MOTION_FLOOR       = 0.5;   // порог покоя EMA
        const SWITCH_FRAMES      = 3;     // стабильных кадров для переключения
        const SWITCH_COOLDOWN_MS = 120;   // анти-дребезг

        const smoothTotal = ts.smoothZoom + ts.smoothRotate + ts.smoothTilt;

        if (smoothTotal < MOTION_FLOOR) {
            // пользователь стоит — кандидат сбрасываем, prev обновляем
            ts.candidateGesture = null;
            ts.candidateFrames  = 0;
            ts.prevDist  = curDist;
            ts.prevAngle = curAngle;
            ts.prevMidX  = midX;
            ts.prevMidY  = midY;
            return;
        }

        const tiltWeighted = ts.smoothTilt / TILT_BIAS;
        const otherMax     = Math.max(ts.smoothZoom, ts.smoothRotate);
        const winner: 'tilt' | 'zoomRotate' =
            (this.allowPitch && tiltWeighted > otherMax) ? 'tilt' : 'zoomRotate';

        if (winner !== ts.activeGesture) {
            if (winner === ts.candidateGesture) {
                ts.candidateFrames++;
            } else {
                ts.candidateGesture = winner;
                ts.candidateFrames  = 1;
            }

            const now = performance.now();
            const canSwitch = ts.activeGesture === null ||
                              now - ts.lastSwitchTime > SWITCH_COOLDOWN_MS;

            if (ts.candidateFrames >= SWITCH_FRAMES && canSwitch) {
                ts.activeGesture    = winner;
                ts.lastSwitchTime   = now;
                ts.candidateGesture = null;
                ts.candidateFrames  = 0;

                // ── перебазирование входящего жеста ──
                if (winner === 'tilt') {
                    ts.startMidX = midX;
                    ts.startMidY = midY;
                    const _d = this._tempVec3a.subVectors(this.camera.position, this.controls.target);
                    const _l = _d.length() || 1;
                    ts.startPitch = Math.acos(Math.max(-1, Math.min(1, _d.y / _l)));
                    ts.prevPitch  = ts.startPitch;
                } else {
                    ts.prevDist  = curDist;
                    ts.prevAngle = curAngle;
                    ts.prevMidX  = midX;
                    ts.prevMidY  = midY;
                    const _d = this._tempVec3a.subVectors(this.camera.position, this.controls.target);
                    const _l = _d.length() || 1;
                    ts.prevAzimuth = Math.atan2(_d.z, _d.x);
                    ts.prevPitch   = Math.acos(Math.max(-1, Math.min(1, _d.y / _l)));
                }

                if ((window as any).__krbDebugGesture) {
                    console.log('[gesture] switch → %s (zoom=%s rot=%s tilt=%s)',
                        winner,
                        ts.smoothZoom.toFixed(2),
                        ts.smoothRotate.toFixed(2),
                        ts.smoothTilt.toFixed(2));
                }
            }
        } else {
            // жест стабилен — сбрасываем кандидата
            ts.candidateGesture = null;
            ts.candidateFrames  = 0;
        }

        // ── ещё не классифицировано — ждём ──
        if (ts.activeGesture === null) {
            ts.prevDist  = curDist;
            ts.prevAngle = curAngle;
            ts.prevMidX  = midX;
            ts.prevMidY  = midY;
            return;
        }

        // ─────────────────────────────────────────────────────────────
        // TILT — только pitch, зум и rotate отключены
        // ─────────────────────────────────────────────────────────────
        if (ts.activeGesture === 'tilt') {
            const H = this.renderer.domElement.clientHeight || 1;
            const tiltRange = this.controls.maxPolarAngle - this.controls.minPolarAngle;

            // Полный диапазон pitch (0…85°) за ~30% высоты экрана.
            const TILT_FULL_RANGE_PX = H * 0.30;

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
        // ZOOM + ROTATE — оригинальное поведение, без tilt
        // ─────────────────────────────────────────────────────────────
        const P_before = this._raycastToGround(ts.prevMidX, ts.prevMidY, this._tempVec3a);

        let angleDelta2 = curAngle - ts.prevAngle;
        while (angleDelta2 >  Math.PI) angleDelta2 -= 2 * Math.PI;
        while (angleDelta2 < -Math.PI) angleDelta2 += 2 * Math.PI;

        const zoomDelta = Math.log2(curDist / ts.prevDist);

        const target = this.controls.target;

        const proposedZoom  = this.continuousZoom + zoomDelta;
        const clampedZoom   = Math.max(this.MIN_ZOOM, Math.min(this.MAX_ZOOM, proposedZoom));
        const newCameraDist = this.getTargetDistanceForZoom(clampedZoom);

        const newAzimuth = this.allowRotate
            ? ts.prevAzimuth - angleDelta2
            : ts.prevAzimuth;
        const newPitch   = ts.prevPitch;          // pitch не меняем

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
    if (this._rulerDragging) return; 
    if (e.touches.length < 2 && this.touchState.isPinching) {
        this.touchState.isPinching = false;
        this.touchState.activeGesture = null;
        this.touchState.candidateGesture = null;
        this.touchState.candidateFrames = 0;
        if (!this._cameraAnimation) this.syncControlsTarget();
    }
    if (e.touches.length === 0 && this.touchDragActive) {
        this.touchDragActive = false;
        if (!this._cameraAnimation) this.syncControlsTarget();

        // ── pan-инерция ──
        if (!this.panInertia || performance.now() - this._panLastMoveTime > 100) {
            this._panVelX = 0;
            this._panVelZ = 0;
        }
        // ── инерция вращения глобуса ──
        if (!this.panInertia || performance.now() - this._globeOrbitLastMoveTime > 100) {
            this._globeOrbitVelX = 0;
            this._globeOrbitVelY = 0;
        }
    }
},

resize(): void {
    this.onResize();
},

onResize() {
    if (this._disposed) return;
    const w = this.targetElement.clientWidth;
    const h = this.targetElement.clientHeight;
    if (w <= 0 || h <= 0) return;
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(w, h);
    // Layout changed — canvas rect cache must be refreshed.
    this._invalidateCanvasRect();
    this.maybeUpdateVisibleTiles();
    this._emitResize(w, h);
    if (this._padding) this._applyPadding(this._padding);
},

onClick(e) {
    if (!e.shiftKey) return;
    if (this._mouseMoved) return;
    const rect = this._getCanvasRect();
    this._tempMouse.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
    this._tempMouse.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
    this._tempRaycaster.setFromCamera(this._tempMouse, this.camera);
    const groundPoint = new THREE.Vector3();
    // Глобус: точка на ЭЛЛИПСОИДЕ через surface.raycast (как _raycastToGround).
    // Плоскость groundPlane на глобусе даёт неверные lon/lat и identify.
    if (this.globe && this.surface) {
        if (!this.surface.raycast(this._tempRaycaster, groundPoint, this.worldGroup)) {
            console.log('[shift-click] Ray did not hit globe (looking at horizon?)');
            return;
        }
    } else if (!this._tempRaycaster.ray.intersectPlane(this.groundPlane, groundPoint)) {
        // groundPlane к этому моменту уже стоит на высоте террейна под точкой
        // клика (его только что установил onMouseDown).
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

    // Canvas rect may shift when the page scrolls (without a resize).
    // Invalidate the cache so the next gesture reads fresh values.
    window.addEventListener('scroll', () => this._invalidateCanvasRect(), { passive: true, signal });

    el.addEventListener('touchstart', (e: TouchEvent) => this.onTouchStart(e), { passive: false, signal });
    el.addEventListener('touchmove', (e: TouchEvent) => this.onTouchMove(e), { passive: false, signal });
    el.addEventListener('touchend', (e: TouchEvent) => this.onTouchEnd(e), { signal });
    el.addEventListener('touchcancel', (e: TouchEvent) => this.onTouchEnd(e), { signal });
    el.addEventListener('click', (e: MouseEvent) => this.onClick(e), { signal });
    this._bindPointerEvents();
},

shiftWorld(dx, dz) {
    this.worldGroup.position.x -= dx;
    this.worldGroup.position.z -= dz;
},
};

declare module './Core.js' {
    interface KrbMap extends CoreInputMethods {}
}