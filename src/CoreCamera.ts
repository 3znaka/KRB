// CoreCamera.ts
import { THREE, OrbitControls, TOUCH_MAP_CONTROLS } from './js_TP/tpb.js';
import type { KrbMap } from './Core.js';
import { Projections } from './Projections.js';

// ── Zoom-to-cursor для глобуса: temps без аллокаций на кадр ──
const _pivotQ = new THREE.Quaternion();
const _pivotA = new THREE.Vector3();
const _pivotB = new THREE.Vector3();
const _pivotZero = new THREE.Vector3();

// ── Глобус: поворот (bearing) и наклон (pitch) ──────────────────────
// До GLOBE_TILT_ZOOM_MIN поворот/pitch выключены: глобус выглядит как
// обычный шар «север сверху». Между MIN и FULL значения плавно
// «выпрямляются» при отдалении — см. _globeTiltGate().
const GLOBE_TILT_ZOOM_MIN = 5;
const GLOBE_TILT_ZOOM_FULL = 6;
const GLOBE_MAX_PITCH = (85 * Math.PI) / 180;
// Чуть-чуть не сверху: при pitch=0 «up» камеры (местная нормаль) параллелен
// направлению взгляда, и lookAt вырождается (крен становится произвольным).
// Плоская ветка делает то же через controls.minPolarAngle.
const GLOBE_MIN_PITCH = 0.001;
const _globTmp = new THREE.Vector3();
const _globTmp2 = new THREE.Vector3();
const _globUp = new THREE.Vector3();
const _globNorth = new THREE.Vector3();
const _globEast = new THREE.Vector3();
const _globGeo = { lon: 0, lat: 0, h: 0 };

export interface CoreCameraMethods {
    setAllowPitch(v: boolean): void;
setAllowRotate(v: boolean): void;
    initControls(): void;
    getTargetDistanceForZoom(z: number, latDeg?: number): number;
    getZoomForDistance(d: number): number;
    _globeSubCameraLat(): number;
    _globeLatScale(latDeg: number): number;
    _globeZoomToPivot(P_before: any, sx: number, sy: number, dist: number): boolean;
    _globeTiltGate(z?: number): number;
    _globePitchNow(): number;
    _globeBearingNow(): number;
    _globeTiltEnabled(): boolean;
    _globeMaxPitch(): number;
    _globeTargetGeo(out?: any): any;
    _globeFrame(up: any, north: any, east: any): void;
    _globeApplyPose(dist: number, pitch: number, bearing: number): void;
    _globeSetTargetDir(dirLocal: any): void;
    _globeSnapTarget(): void;
    _globeRetarget(): void;
    _globeProjectTarget(): void;
    _globeSyncStateFromCamera(): void;
    _globeRotateAroundPivot(dxPixels: number, dyPixels: number, pivot: any): void;
    _applyGlobeZoomDistance(): void;
    setPitch(pitchDeg: number, duration?: number): void;
    setBearing(bearingDeg: number, duration?: number): void;
    _startCameraAnimationLoopIfNeeded(): void;
    resetBearing(): void;
    rotateToNorth(duration?: number, resetPitch?: boolean): void;
    moveCameraTo(lon: number, lat: number, targetZoom?: number | null): void;
    moveCameraToSlow(lon: number, lat: number, duration?: number, targetZoom?: number | null): void;
    fitToBounds(bounds: number[][], options?: { crs?: any; padding?: number | number[]; duration?: number; maxZoom?: number }): void;
    fitTo(objectOrArray: any, options?: { crs?: any; [key: string]: any }): void;
    _computeFitDistance(targetX: number, targetZ: number, halfW: number, halfH: number, padX: number, padY: number): number;
    _resolveCameraPlacement(target: any, desiredDist: number, desiredPitch: number, azimuth: number, outPos: any): { pitch: number; dist: number };
    _wrapLongitudeIfNeeded(): void;
    applyZoomDistance(): void;
    applyZoomDelta(delta: number): void;
    peekIdealZoom(continuousZoom: number): number;
    syncControlsTarget(): void;
    readonly targetZoom: number;
    _retargetToGround(): boolean;
    getMaxBounds(): [[number, number], [number, number]] | null;

    easeTo(options: {
    center?: [number, number] | [number, number, number];   // ← 3-я координата = altitude
    altitude?: number;                                      // ← или отдельная опция
    zoom?: number;
    pitch?: number;
    bearing?: number;
    duration?: number;
    padding?: number | { top?: number; right?: number; bottom?: number; left?: number };
}): void;
    setPadding(padding: number | { top?: number; right?: number; bottom?: number; left?: number }): void;
    _applyPadding(padding: number | { top?: number; right?: number; bottom?: number; left?: number }): void;
    getZoom(): number;
    getCenter(): [number, number];
    getBounds(): [[number, number], [number, number]] | null;
    getPitch(): number;
    getBearing(): number;
   jumpTo(options: {
    center?: [number, number] | [number, number, number];
    altitude?: number;
    zoom?: number;
    pitch?: number;
    bearing?: number;
    padding?: number | { top?: number; right?: number; bottom?: number; left?: number };
}): void;
    setMaxBounds(bounds: [[number, number], [number, number]] | null): void;
    _enforceMaxBounds(): void;
}

export const CoreCameraMixin: CoreCameraMethods & ThisType<KrbMap> = {

setAllowPitch(v) {
    this.allowPitch = v;
    if (!this.controls) return;
    if (!v) {
        const cam = this.camera.position, tgt = this.controls.target;
        const dx = cam.x - tgt.x, dy = cam.y - tgt.y, dz = cam.z - tgt.z;
        const d = Math.sqrt(dx*dx + dy*dy + dz*dz);
        const cur = d > 1e-6
            ? Math.acos(Math.max(-1, Math.min(1, dy / d)))
            : 0.001;
        this.controls.minPolarAngle = cur;
        this.controls.maxPolarAngle = cur;
    } else {
        this.controls.minPolarAngle = 0.001;
        this.controls.maxPolarAngle = (85 * Math.PI) / 180;
    }
},

setAllowRotate(v) { this.allowRotate = v; },
    
initControls() {
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableZoom = false;
    this.controls.enablePan = false;
    this.controls.mouseButtons = {
        LEFT: THREE.MOUSE.PAN,
        MIDDLE: THREE.MOUSE.DOLLY,
        RIGHT: null,   // ← было THREE.MOUSE.ROTATE — теперь вращаем сами
    };
    this.controls.touches = { ONE: null, TWO: null };
    this.controls.maxPolarAngle = (85 * Math.PI) / 180;
    this.controls.minPolarAngle = 0.001;
    if (!this.allowPitch) {
    const vp = this.view.pitch ?? 0;
    const lockedPitchRad = Math.max(0.001, (vp * Math.PI) / 180);
    this.controls.minPolarAngle = lockedPitchRad;
    this.controls.maxPolarAngle = lockedPitchRad;
}
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.6;
    this.controls.rotateSpeed = 1;

this.controls.enableRotate = false;   // вращение делаем сами (иначе shift+drag перехватит OrbitControls)

if (this.globe) {
    this.controls.minPolarAngle = 1e-4;
    this.controls.maxPolarAngle = Math.PI - 1e-4;
    this.controls.enablePan  = false;
    this.controls.enableZoom = false;
}

},

easeTo(options) {
    if (this._disposed) return;
      const { center, altitude, zoom, pitch, bearing, duration = 0.5, padding } = options;

    // 1. Отменяем текущую анимацию
    if (this._cameraAnimation || this._cameraAnimFrame !== null) {
        if (this._cameraAnimFrame !== null) {
            cancelAnimationFrame(this._cameraAnimFrame);
            this._cameraAnimFrame = null;
        }
        this._cameraAnimation = null;
        this._cameraAnimations.pitch = null;
        this._cameraAnimations.bearing = null;
        this.controls.enableDamping = this._controlsDampingWasEnabled;
    }

    this._panVelX = 0;
    this._panVelZ = 0;
    // 2. Применяем padding (если задан) — до расчёта end-состояния
    if (padding !== undefined) this._applyPadding(padding);

    // 3. Если ничего не нужно анимировать — выходим
    if (center === undefined && zoom === undefined
        && pitch === undefined && bearing === undefined) return;

    // 4. Start state
    const startTarget = this.controls.target.clone();
    const startPos    = this.camera.position.clone();
    const startDir    = startPos.clone().sub(startTarget);
    const startDist   = startDir.length();
    if (startDist < 1e-6) return;
    const startPitch   = Math.acos(Math.max(-1, Math.min(1, startDir.y / startDist)));
    const startBearing = Math.atan2(-startDir.x, startDir.z);
    const startZoom = this.continuousZoom;

    // 5. End state


let endTarget = startTarget.clone();
if (center) {
    let tx = center[0], ty = center[1];
    if (this._maxBounds) {
        const b = this._maxBounds;
        tx = Math.max(b.minLon, Math.min(b.maxLon, tx));
        ty = Math.max(b.minLat, Math.min(b.maxLat, ty));
    }
    const [cx, cz] = this.projectLonLat(tx, ty);
    const off = this.worldGroup.position;

    // Приоритет: явный options.altitude > 3-й элемент center > 0
    let alt = 0;
    if (altitude !== undefined) {
        alt = altitude;
    } else if (center.length >= 3 && Number.isFinite(center[2])) {
        alt = center[2];
    }

    endTarget.set(cx + off.x, alt, cz + off.z);
}
    const endZoom = zoom ?? startZoom;
    const endPitch = pitch !== undefined
        ? (pitch * Math.PI) / 180
        : startPitch;
    let endBearing = (bearing !== undefined && this.allowRotate)
    ? (bearing * Math.PI) / 180
    : startBearing;
    // кратчайший путь по азимуту
    let dB = endBearing - startBearing;
    while (dB >  Math.PI) dB -= 2 * Math.PI;
    while (dB < -Math.PI) dB += 2 * Math.PI;
    endBearing = startBearing + dB;

    // 6. Мгновенно?
    if (!(duration > 0)) {
        this.continuousZoom = endZoom;
        this.targetContinuousZoom = endZoom;
        this._resolveCameraPlacement(
            endTarget, this.getTargetDistanceForZoom(endZoom),
            endPitch, endBearing + Math.PI / 2, this._tempPlacementOut
        );
        this.camera.position.copy(this._tempPlacementOut);
        this.controls.target.copy(endTarget);
        this.controls.update();
        this.maybeUpdateVisibleTiles(true);
        return;
    }

    // 7. Анимация
    const anim = {
        startTarget, endTarget,
        startZoom, endZoom,
        startPitch, endPitch,
        startBearing, endBearing,
        startTime: performance.now(),
        duration,
    };
    this._cameraAnimation = anim;
    this._controlsDampingWasEnabled = this.controls.enableDamping;
    this.controls.enableDamping = false;

    const animateStep = (now) => {
        if (this._disposed || this._cameraAnimation !== anim) return;
        let t = (now - anim.startTime) / (anim.duration * 1000);
        t = Math.min(t, 1);
        const eased = t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;

        const curTarget  = this._tempVec3a.lerpVectors(anim.startTarget, anim.endTarget, eased);
        const curZoom    = anim.startZoom    + (anim.endZoom    - anim.startZoom)    * eased;
        const curPitch   = anim.startPitch   + (anim.endPitch   - anim.startPitch)   * eased;
        const curBearing = anim.startBearing + (anim.endBearing - anim.startBearing) * eased;

        this._resolveCameraPlacement(
            curTarget, this.getTargetDistanceForZoom(curZoom),
            curPitch, curBearing + Math.PI / 2, this._tempPlacementOut
        );
        this.camera.position.copy(this._tempPlacementOut);
        this.controls.target.copy(curTarget);
        this.controls.update();
        this.continuousZoom = curZoom;
        this.targetContinuousZoom = curZoom;
        this.maybeUpdateVisibleTiles();

        if (t >= 1) {
            if (this._cameraAnimation === anim) this._cameraAnimation = null;
            this.controls.enableDamping = this._controlsDampingWasEnabled;
            // финальная точная установка
            this._resolveCameraPlacement(
                anim.endTarget, this.getTargetDistanceForZoom(anim.endZoom),
                anim.endPitch, anim.endBearing + Math.PI / 2, this._tempPlacementOut
            );
            this.camera.position.copy(this._tempPlacementOut);
            this.controls.target.copy(anim.endTarget);
            this.controls.update();
            this.continuousZoom = anim.endZoom;
            this.targetContinuousZoom = anim.endZoom;
            this.maybeUpdateVisibleTiles(true);
            return;
        }
        this._cameraAnimFrame = requestAnimationFrame(animateStep);
    };
    this._cameraAnimFrame = requestAnimationFrame(animateStep);
},

getZoom(): number {
    return this.continuousZoom;
},

getCenter(): [number, number] {
    if (this.globe) {
        // Центр экрана — цель (точка обзора на поверхности).
        const g = this._globeTargetGeo(_globGeo);
        return [g.lon, g.lat];
    }
    const off = this.worldGroup.position;
    return this.unprojectToLonLat(
        this.controls.target.x - off.x,
        this.controls.target.z - off.z
    );
},

getPitch(): number {
    if (this.globe) return (this._globePitchNow() * 180) / Math.PI;
    const cam = this.camera.position;
    const tgt = this.controls.target;
    const dx = cam.x - tgt.x, dy = cam.y - tgt.y, dz = cam.z - tgt.z;
    const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
    if (d < 1e-9) return 0;
    const pitchRad = Math.acos(Math.max(-1, Math.min(1, dy / d)));
    return (pitchRad * 180) / Math.PI;
},

getBearing(): number {
    if (this.globe) {
        let deg = (this._globeBearingNow() * 180) / Math.PI;
        while (deg > 180) deg -= 360;
        while (deg < -180) deg += 360;
        return deg;
    }
    const cam = this.camera.position;
    const tgt = this.controls.target;
    const dx = cam.x - tgt.x, dz = cam.z - tgt.z;
    if (Math.abs(dx) < 1e-9 && Math.abs(dz) < 1e-9) return 0;
    const bearingRad = Math.atan2(-dx, dz);
    return (bearingRad * 180) / Math.PI;
},

getBounds() {
    const canvas = this.renderer?.domElement;
    if (!canvas) return null;
    this.camera.updateMatrixWorld(true);

    // Reuse cached rect (see CoreInput._getCanvasRect) — matches the
    // rect used inside _raycastToGround, so raycasts hit exactly the
    // pixels we advertise as corners.
    const rect = typeof (this as any)._getCanvasRect === 'function'
        ? (this as any)._getCanvasRect()
        : canvas.getBoundingClientRect();
    const W = rect.width, H = rect.height;
    const off = this.worldGroup.position;
    const corners = [
        [rect.left,          rect.top],
        [rect.left + W,      rect.top],
        [rect.left + W,      rect.top + H],
        [rect.left,          rect.top + H],
    ];
    const lons: number[] = [];
    const lats: number[] = [];

    // Reuse a single temp vector instead of allocating a new one.
    const tmp = this._tempVec3a;

    for (const [px, py] of corners) {
        const world = this._raycastToGround(px, py, tmp);
        if (!world) continue;                     // луч ушёл в горизонт
        const [lon, lat] = this.unprojectToLonLat(
            world.x - off.x, world.z - off.z
        );
        if (Number.isFinite(lon) && Number.isFinite(lat)) {
            lons.push(lon);
            lats.push(lat);
        }
    }
    if (lons.length === 0) return null;
    return [
        [Math.min(...lons), Math.min(...lats)],
        [Math.max(...lons), Math.max(...lats)],
    ];
},

jumpTo(options) {
    this.easeTo({ ...options, duration: 0 });
},

setMaxBounds(bounds) {
    // Invalidate cached bounds check — bounds changed.
    (this as any)._lastBoundsCheck = null;

    if (!bounds) {
        this._maxBounds = null;
        return;
    }
    const [[lng1, lat1], [lng2, lat2]] = bounds;
    this._maxBounds = {
        minLon: Math.min(lng1, lng2),
        maxLon: Math.max(lng1, lng2),
        minLat: Math.min(lat1, lat2),
        maxLat: Math.max(lat1, lat2),
    };
    this._enforceMaxBounds();
    this.maybeUpdateVisibleTiles(true);
},

/**
 * Clamp эффективного центра в maxBounds через сдвиг worldGroup.
 * Вызывается: из pan-путей (CoreInput), из animate() каждый кадр (catch-all),
 * из easeTo.
 *
 * Кэширует последнее состояние (target + worldGroup.position). Если
 * за кадр ничего не изменилось — повторная проекция не выполняется.
 * В типичной сцене (пользователь не двигает камеру) это устраняет
 * 1 unprojectToLonLat + 1 projectLonLat на каждый кадр.
 */
_enforceMaxBounds() {
    if (this.globe) return;
    if (!this._maxBounds) return;
    if (!this.controls || !this.worldGroup) return;

    const tx = this.controls.target.x;
    const tz = this.controls.target.z;
    const wx = this.worldGroup.position.x;
    const wz = this.worldGroup.position.z;

    // Early-out: same state as last check and nothing was clamped.
    const last = (this as any)._lastBoundsCheck;
    if (last &&
        last.tx === tx && last.tz === tz &&
        last.wx === wx && last.wz === wz) {
        return;
    }

    let [lon, lat] = this.unprojectToLonLat(tx - wx, tz - wz);
    if (!Number.isFinite(lon) || !Number.isFinite(lat)) {
        (this as any)._lastBoundsCheck = { tx, tz, wx, wz };
        return;
    }

    // Нормализуем lon — вдруг worldGroup был на «обёрнутой» позиции
    while (lon < -180) lon += 360;
    while (lon >  180) lon -= 360;

    const b = this._maxBounds;
    const newLon = Math.max(b.minLon, Math.min(b.maxLon, lon));
    const newLat = Math.max(b.minLat, Math.min(b.maxLat, lat));

    if (newLon === lon && newLat === lat) {
        // Ничего не меняем — кэшируем текущее состояние.
        (this as any)._lastBoundsCheck = { tx, tz, wx, wz };
        return;
    }

    // Сдвигаем worldGroup так, чтобы controls.target эффективно указывал
    // в (newLon, newLat).
    const [wxNew, wzNew] = this.projectLonLat(newLon, newLat);
    this.worldGroup.position.x = this.controls.target.x - wxNew;
    this.worldGroup.position.z = this.controls.target.z - wzNew;

    // Кэшируем новое (уже clamped) состояние — следующий кадр без
    // изменений пропустит работу.
    (this as any)._lastBoundsCheck = {
        tx: this.controls.target.x,
        tz: this.controls.target.z,
        wx: this.worldGroup.position.x,
        wz: this.worldGroup.position.z,
    };
},

setPadding(padding) { this._applyPadding(padding); },

_applyPadding(padding) {
    const W = this.renderer?.domElement?.clientWidth  ?? 0;
    const H = this.renderer?.domElement?.clientHeight ?? 0;
    if (W <= 0 || H <= 0) return;

    const pad = typeof padding === 'number'
        ? { top: padding, right: padding, bottom: padding, left: padding }
        : {
            top:    padding.top    ?? 0,
            right:  padding.right  ?? 0,
            bottom: padding.bottom ?? 0,
            left:   padding.left   ?? 0,
        };
    this._padding = pad;

    const dx = (pad.left - pad.right) / 2;   // >0 → контент сдвинуть вправо
    const dy = (pad.top  - pad.bottom) / 2;  // >0 → контент сдвинуть вниз

    if (dx === 0 && dy === 0) {
        this.camera.clearViewOffset();
    } else {
        // ВАЖНО: знак отрицательный — setViewOffset сдвигает фрустум,
        // а нам нужен сдвиг контента в противоположную сторону.
        this.camera.setViewOffset(W, H, -dx, -dy, W, H);
    }
},

/**
 * Широта точки обзора (град) — по ней калибруется высота глобуса
 * (h·cos φ), т.к. масштаб считается в центре экрана.
 */
_globeSubCameraLat(): number {
    if (this.globe && this.controls?.target) {
        const g = this._globeTargetGeo(_globGeo);
        if (Number.isFinite(g.lat)) return g.lat;
    }
    const cam = this.camera;
    if (!cam) return 0;
    const tgt = this.controls?.target;
    const dx = cam.position.x - (tgt ? tgt.x : 0);
    const dy = cam.position.y - (tgt ? tgt.y : 0);
    const dz = cam.position.z - (tgt ? tgt.z : 0);
    const len = Math.sqrt(dx * dx + dy * dy + dz * dz);
    if (!(len > 1e-9)) return 0;
    const s = Math.max(-1, Math.min(1, dy / len));
    return (Math.asin(s) * 180) / Math.PI;
},

/**
 * Коэффициент «включённости» поворота/pitch по зуму: 0 до z=5, 1 с z=6.
 * Промежуток — плавное выпрямление при отдалении.
 */
_globeTiltGate(z: number = this.continuousZoom): number {
    if (!this.globe) return 1;
    if (!(z > GLOBE_TILT_ZOOM_MIN)) return 0;
    if (z >= GLOBE_TILT_ZOOM_FULL) return 1;
    const t = (z - GLOBE_TILT_ZOOM_MIN) / (GLOBE_TILT_ZOOM_FULL - GLOBE_TILT_ZOOM_MIN);
    return t * t * (3 - 2 * t);
},

/** Фактический pitch (рад, 0 = взгляд сверху) с учётом гейта. */
_globePitchNow(): number {
    return (this._globePitch || 0) * this._globeTiltGate();
},

/** Фактический bearing (рад, 0 = север сверху) с учётом гейта. */
_globeBearingNow(): number {
    return (this._globeBearing || 0) * this._globeTiltGate();
},

    /** Разрешён ли сейчас поворот/наклон глобуса (zoom ≥ 6). */
    _globeTiltEnabled(): boolean {
        return this.globe === true && this._globeTiltGate() >= 0.999;
    },

    /** Максимальный наклон камеры глобуса (рад). */
    _globeMaxPitch(): number {
        return GLOBE_MAX_PITCH;
    },

/** Геодезические координаты точки обзора (controls.target). */
_globeTargetGeo(out: any = _globGeo): any {
    _globTmp.copy(this.controls.target);
    if (this.worldGroup) this.worldGroup.worldToLocal(_globTmp);
    return this.surface.geodeticFromWorld(_globTmp, out);
},

/**
 * Локальный базис в точке обзора (мировые единицы):
 * up — нормаль эллипсоида, north — на север по касательной, east — на восток.
 */
_globeFrame(up: any, north: any, east: any): void {
    const g = this._globeTargetGeo(_globGeo);
    this.surface.normal(g.lon, g.lat, up);
    if (this.worldGroup) up.transformDirection(this.worldGroup.matrixWorld);
    up.normalize();
    // north = Y - (Y·up)·up (на полюсе выражается — берём произвольный)
    north.set(0, 1, 0).addScaledVector(up, -up.y);
    if (north.lengthSq() < 1e-12) north.set(1, 0, 0);
    else north.normalize();
    east.crossVectors(north, up).normalize();
},

/**
 * Поставить камеру по состоянию глобуса: цель на поверхности, расстояние
 * dist до неё, pitch (0 = строго сверху) и bearing (0 = север сверху).
 */
_globeApplyPose(dist: number, pitch: number, bearing: number): void {
    const tgt = this.controls?.target;
    if (!tgt || !this.camera) return;
    const up = _globUp, north = _globNorth, east = _globEast;
    this._globeFrame(up, north, east);
    const p = Math.max(GLOBE_MIN_PITCH, Math.min(GLOBE_MAX_PITCH, pitch));
    const cp = Math.cos(p), sp = Math.sin(p);
    const cb = Math.cos(bearing), sb = Math.sin(bearing);
    // Горизонтальное направление взгляда: north·cosB + east·sinB.
    // Камера смещена ПРОТИВ него и приподнята на cos(pitch).
    const hx = north.x * cb + east.x * sb;
    const hy = north.y * cb + east.y * sb;
    const hz = north.z * cb + east.z * sb;
    this.camera.position.set(
        tgt.x + dist * (up.x * cp - hx * sp),
        tgt.y + dist * (up.y * cp - hy * sp),
        tgt.z + dist * (up.z * cp - hz * sp),
    );
    this.camera.up.copy(up);
    this.camera.lookAt(tgt);
    this.camera.updateMatrixWorld(true);
},

/** Поставить цель в точку эллипсоида по направлению (локальный единичный вектор). */
_globeSetTargetDir(dirLocal: any): void {
    const g = this.surface.geodeticFromWorld(
        _globTmp2.copy(dirLocal).multiplyScalar(this.R), _globGeo);
    if (!Number.isFinite(g.lon) || !Number.isFinite(g.lat)) return;
    const p = this.surface.position(g.lon, g.lat, 0, _globTmp);
    if (this.worldGroup) this.worldGroup.localToWorld(p);
    this.controls.target.copy(p);
},

/** Перепроецировать цель на эллипсоид по её текущим lon/lat. */
_globeSnapTarget(): void {
    const g = this._globeTargetGeo(_globGeo);
    if (!Number.isFinite(g.lon) || !Number.isFinite(g.lat)) return;
    const p = this.surface.position(g.lon, g.lat, 0, _globTmp);
    if (this.worldGroup) this.worldGroup.localToWorld(p);
    this.controls.target.copy(p);
},

/** Пере-целиться по центру экрана (после доворота камеры вокруг пивота). */
_globeRetarget(): void {
    const el = this.renderer?.domElement;
    if (!el) return;
    const rect = typeof (this as any)._getCanvasRect === 'function'
        ? (this as any)._getCanvasRect()
        : el.getBoundingClientRect();
    const hit = this._raycastToGround(
        rect.left + rect.width * 0.5, rect.top + rect.height * 0.5, _globTmp);
    if (!hit) return;
    const loc = _globTmp2.copy(hit);
    if (this.worldGroup) this.worldGroup.worldToLocal(loc);
    const g = this.surface.geodeticFromWorld(loc, _globGeo);
    if (!Number.isFinite(g.lon) || !Number.isFinite(g.lat)) return;
    const p = this.surface.position(g.lon, g.lat, 0, _globTmp);
    if (this.worldGroup) this.worldGroup.localToWorld(p);
    this.controls.target.copy(p);
},

/**
 * Обратное к _globeApplyPose: восстановить _globePitch/_globeBearing
 * из фактической геометрии камеры (после правого драга).
 */
_globeSyncStateFromCamera(): void {
    const tgt = this.controls?.target;
    const cam = this.camera;
    if (!tgt || !cam) return;
    const gate = this._globeTiltGate();
    if (gate <= 0) return;
    const up = _globUp, north = _globNorth, east = _globEast;
    this._globeFrame(up, north, east);
    const dx = cam.position.x - tgt.x;
    const dy = cam.position.y - tgt.y;
    const dz = cam.position.z - tgt.z;
    const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
    if (!(d > 1e-9)) return;
    const cosP = (dx * up.x + dy * up.y + dz * up.z) / d;
    const pitch = Math.acos(Math.max(-1, Math.min(1, cosP)));

    // Горизонтальная составляющая направления взгляда.
    let vx = -dx, vy = -dy, vz = -dz;
    const vUp = vx * up.x + vy * up.y + vz * up.z;
    vx -= vUp * up.x; vy -= vUp * up.y; vz -= vUp * up.z;
    let bearing = this._globeBearing || 0;
    if (Math.hypot(vx, vy, vz) > 1e-9) {
        bearing = Math.atan2(
            vx * east.x + vy * east.y + vz * east.z,
            vx * north.x + vy * north.y + vz * north.z,
        );
    }

    this._globePitch = Math.max(GLOBE_MIN_PITCH, Math.min(GLOBE_MAX_PITCH, pitch)) / gate;
    this._globeBearing = bearing / gate;
    this._globePitchTarget = this._globePitch;
    this._globeBearingTarget = this._globeBearing;
},

/**
 * Широта, по которой калибруется высота глобуса. Поправка cos φ — это
 * масштабный коэффициент Web Mercator (1/cos φ), поэтому применяем её
 * только к меркаторским сеткам тайлов; для остальных CRS оставляем 1,
 * чтобы не менять прежнее поведение.
 */
_globeLatScale(latDeg: number): number {
    // UX: глобус держит стабильный размер при панорамировании. Раньше дистанция
    // ~ cos φ «дышала» при смене широты (и вместе с дискретными уровнями тайлов).
    // Теперь размер постоянен, а изменения масштаба идут через continuousZoom.
    if (this.globe) return 1;
    const crs = this.tileCRS ?? this.projection;
    if (!crs || crs.isMercator !== true) return 1;
    const mLat = crs.maxLatDeg;
    const lat = mLat != null
        ? Math.max(-mLat, Math.min(mLat, latDeg))
        : Math.max(-90, Math.min(90, latDeg));
    return Math.max(1e-4, Math.cos((lat * Math.PI) / 180));
},

/**
 * Zoom-to-cursor для глобуса: поворачивает точку обзора вокруг центра
 * Земли так, чтобы точка P_before (та, что была под курсором ДО изменения
 * дистанции) снова оказалась под курсором (sx, sy).
 *
 * Поворот идёт вокруг центра Земли, поэтому локальный базис в цели
 * поворачивается вместе с ней — pitch/bearing сохраняются, «север сверху»
 * не сбивается. Итерации нужны из-за пересчёта дистанции под новую
 * широту (h·cos φ) — на каждой итерации ошибка перемеряется.
 */
_globeZoomToPivot(P_before: any, sx: number, sy: number, dist: number): boolean {
    const cam = this.camera;
    if (!P_before || !cam) return false;
    const center = this.worldGroup ? this.worldGroup.position : _pivotZero;
    const el = this.renderer?.domElement;
    const W = el ? el.clientWidth : 0;
    const H = el ? el.clientHeight : 0;
    if (!(W > 0 && H > 0)) return false;

    let moved = false;
    for (let iter = 0; iter < 4; iter++) {
        // Где сейчас проецируется наша точка?
        _pivotA.copy(P_before).project(cam);
        const errX = (_pivotA.x + 1) * 0.5 * W - sx;
        const errY = (1 - _pivotA.y) * 0.5 * H - sy;
        if (Math.sqrt(errX * errX + errY * errY) < 0.1) break;

        // Что под курсором сейчас?
        const P_after = this._raycastToGround(sx, sy, this._tempVec3b);
        if (!P_after) break;

        _pivotA.copy(P_after).sub(center);
        _pivotB.copy(P_before).sub(center);
        const la = _pivotA.length();
        const lb = _pivotB.length();
        if (!(la > 1e-6) || !(lb > 1e-6)) break;
        _pivotA.divideScalar(la);
        _pivotB.divideScalar(lb);

        _pivotQ.setFromUnitVectors(_pivotA, _pivotB);
        if (!Number.isFinite(_pivotQ.x) || !Number.isFinite(_pivotQ.w)) break;

        // Поворачиваем цель (и весь базис) вокруг центра Земли.
        this.controls.target.sub(center).applyQuaternion(_pivotQ).add(center);
        this._globeSnapTarget();
        // Дистанция зависит от широты (h·cos φ) — переставляем под новую.
        const d = this.getTargetDistanceForZoom(this.continuousZoom, this._globeSubCameraLat());
        this._globeApplyPose(d, this._globePitchNow(), this._globeBearingNow());
        moved = true;
    }
    if (moved) this.controls?.update?.();
    return moved;
},

getTargetDistanceForZoom(z: number, latDeg?: number): number {
    const canvas = this.renderer?.domElement;
    const H = canvas ? canvas.clientHeight : 0;
    const fov = this.camera?.fov ?? 45;
    let h;
    if (H <= 0) {
        h = this.BASE_DISTANCE * Math.pow(0.5, z - this.BASE_ZOOM);
    } else {
        const tanHalfFov = Math.tan((fov * Math.PI) / 360);
        h = (this.WORLD_SIZE / Math.pow(2, z)) * H / (2 * this.TILE_PIXELS * tanHalfFov);
    }
    if (!this.globe) return h;

    // ── Глобус: дистанция до ЦЕЛИ (точки обзора на поверхности), ─────
    // поправленная на масштаб проекции в этой широте. ────────────────
    // В Web Mercator тайл z-уровня на широте φ покрывает
    // WORLD_SIZE/2^z · cos φ метров ЗЕМЛИ (проекция растягивает высокие
    // широты), а на глобусе он лежит на сфере в своём истинном размере.
    // Поэтому при постоянной высоте глобус на широте Москвы показывает
    // в 1/cos φ ≈ 1.8 раза больше площади, чем плоская карта на том же
    // зуме. Чтобы «метров на пиксель» совпадали (как в Mapbox:
    // metersPerPixel = cos φ · C / (2^z · tileSize)), высота должна быть
    // h · cos φ — у полюсов камера садится ниже.
    const lat = latDeg ?? this._globeSubCameraLat();
    // Калибровка обзорности: на глобусе при том же зуме камера должна давать
    // ту же видимую площадь, что плоская карта (эталон — плоский pixel-perfect
    // коэффициент). Без поправки глобус был шире (обзорность как при z≈8.8 вместо 8),
    // поэтому дистанция уменьшается.
    return h * this._globeLatScale(lat) * this.GLOBE_VIEW_SCALE;
},

getZoomForDistance(d: number): number {
    if (!(d > 0) || !isFinite(d)) return this.continuousZoom;
    let h;
    if (this.globe) {
        // d — дистанция от камеры до цели на поверхности; отменяем поправку cos φ.
        const cosLat = this._globeLatScale(this._globeSubCameraLat());
        h = Math.max(1e-3, d / cosLat);
    } else {
        h = d;
    }
    const canvas = this.renderer?.domElement;
    const H = canvas ? canvas.clientHeight : 0;
    const fov = this.camera?.fov ?? 45;
    if (H <= 0) return this.BASE_ZOOM + Math.log2(this.BASE_DISTANCE / h);
    const tanHalfFov = Math.tan((fov * Math.PI) / 360);
    const K = H / (2 * this.TILE_PIXELS * tanHalfFov);
    return Math.log2((this.WORLD_SIZE * K) / h);
},
// ───────────────────────────────────────────────────────────────────────
// Optimized _resolveCameraPlacement:
//
// 1. cos(azimuth) / sin(azimuth) hoisted OUT of the `hasElevation`
//    branch, so the output-path trig call uses the same precomputed
//    values (previously cos/sin(azimuth) were computed 2x when
//    hasElevation was true).
// 2. sin(pitch) / cos(pitch) are computed once and reused for output
//    when the loop exits without modifying `pitch` (the common case:
//    camera is above terrain on the first iteration).
//    Only recomputed when `pitch` actually changes inside the loop.
// 3. Elevation sampling is untouched — its iterative refinement is
//    required for correctness.
// ───────────────────────────────────────────────────────────────────────
_resolveCameraPlacement(target, desiredDist, desiredPitch, azimuth, outPos) {
    let dist = desiredDist;
    const minP = this.controls?.minPolarAngle ?? 0.001;
    const maxP = this.controls?.maxPolarAngle ?? (Math.PI - 0.001);
    let pitch = Math.max(minP, Math.min(maxP, desiredPitch));

    const cosAz = Math.cos(azimuth);
    const sinAz = Math.sin(azimuth);

    let sinP = Math.sin(pitch);
    let cosP = Math.cos(pitch);

    if (this.hasElevation) {
        const clearance = this.CAMERA_TERRAIN_CLEARANCE;
        const targetTerrain = this.getSurfaceHeightAt(target.x, target.z);
        const minDistForTarget = targetTerrain + clearance;
        if (dist < minDistForTarget) dist = minDistForTarget;

        for (let iter = 0; iter < 6; iter++) {
            const camX = target.x + dist * sinP * cosAz;
            const camZ = target.z + dist * sinP * sinAz;
            const camY = target.y + dist * cosP;

            const terrain = this.getSurfaceHeightAt(camX, camZ);
            const requiredY = terrain + clearance;
            if (camY >= requiredY) break;

            const requiredCosP = Math.min(1, requiredY / dist);
            pitch = Math.acos(requiredCosP);
            pitch = Math.max(minP, Math.min(maxP, pitch));

            // pitch changed — refresh trig for the next iteration /
            // for the final output below.
            sinP = Math.sin(pitch);
            cosP = Math.cos(pitch);

            if (pitch <= minP) { pitch = minP; break; }
        }
    }

    outPos.set(
        target.x + dist * sinP * cosAz,
        target.y + dist * cosP,
        target.z + dist * sinP * sinAz
    );
    return { pitch, dist };
},

setPitch(pitchDeg, duration = 0.3) {
    if (this.globe) {
        // Глобус: pitch — состояние в локальном базисе, доводится
        // плавно в _applyGlobeZoomDistance() (гейт сам обнулит ниже z=5).
        this._globePitchTarget = Math.max(0, Math.min(GLOBE_MAX_PITCH, pitchDeg * Math.PI / 180));
        if (!(duration > 0)) this._globePitch = this._globePitchTarget;
        return;
    }
    const pitchRad = pitchDeg * Math.PI / 180;
    const clampedRad = Math.max(0.001, Math.min(pitchRad, this.controls.maxPolarAngle));
    const target = this._tempVec3a.copy(this.controls.target);
    const currentPos = this._tempVec3b.copy(this.camera.position);
    const dir = this._tempDir.subVectors(currentPos, target);
    const currentDistance = dir.length();
    if (currentDistance < 1) return;
    const currentPitchRad = Math.acos(Math.max(-1, Math.min(1, dir.y / currentDistance)));
    this._cameraAnimations.pitch = { start: currentPitchRad, end: clampedRad, startTime: performance.now(), duration };
    this._startCameraAnimationLoopIfNeeded();
},

setBearing(bearingDeg, duration = 0.3) {
    if (!this.allowRotate) return;
    if (this.globe) {
        this._globeBearingTarget = bearingDeg * Math.PI / 180;
        if (!(duration > 0)) this._globeBearing = this._globeBearingTarget;
        return;
    }
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
    this._cameraAnimations.bearing = { start: currentBearing, end: endBearing, startTime: performance.now(), duration };
    this._startCameraAnimationLoopIfNeeded();
},

_startCameraAnimationLoopIfNeeded() {
    if (this._disposed || this._paused) return;
    if (this._cameraAnimation || this._cameraAnimFrame) return;
    const animState = { custom: true };
    this._cameraAnimation = animState;
    this._controlsDampingWasEnabled = this.controls.enableDamping;
    this.controls.enableDamping = false;

    const animateStep = (now: number) => {
        if (this._disposed || this._cameraAnimation !== animState) return;
        let anyActive = false;
        const target = this._tempVec3a.copy(this.controls.target);
        const currentPos = this._tempVec3b.copy(this.camera.position);
        const dir = this._tempDir.subVectors(currentPos, target);
        const currentDistance = dir.length();
        if (currentDistance < 1) {
            if (this._cameraAnimation === animState) {
                this._cameraAnimation = null;
                this._cameraAnimFrame = null;
            }
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
        this._resolveCameraPlacement(target, currentDistance, currentPitch, azimuth, this._tempPlacementOut);
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
},

resetBearing() { this.rotateToNorth(0.3); },

moveCameraTo(lon, lat, targetZoom = null) {
    this.moveCameraToSlow(lon, lat, 0, targetZoom);
},

_wrapLongitudeIfNeeded() {
    if (this.globe) return;
    if (this._maxBounds) return;
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
    // worldGroup changed — invalidate cached bounds check
    (this as any)._lastBoundsCheck = null;
    this.maybeUpdateVisibleTiles(true);
},

moveCameraToSlow(lon: number, lat: number, duration = 1.0, targetZoom: number | null = null, altitude?: number) {
    this.easeTo({
        center: altitude !== undefined ? [lon, lat, altitude] : [lon, lat],
        zoom: targetZoom ?? undefined,
        duration,
    });
},

rotateToNorth(duration = 0.3, resetPitch = true) {
    if (this._disposed || this._cameraAnimation) return;
    if (!this.allowRotate) return; 
    if (this.globe) {
        // Плавно к «север сверху» (и, если просили, к виду сверху).
        // Доведение делает _applyGlobeZoomDistance(); при duration=0 — сразу.
        this._globeBearingTarget = 0;
        if (resetPitch) this._globePitchTarget = 0;
        if (!(duration > 0)) {
            this._globeBearing = 0;
            if (resetPitch) this._globePitch = 0;
        }
        return;
    }
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
    if (resetPitch) endDistance = this.getTargetDistanceForZoom(this.continuousZoom);
    let deltaBearing = endBearing - startBearing;
    while (deltaBearing > Math.PI) deltaBearing -= 2 * Math.PI;
    while (deltaBearing < -Math.PI) deltaBearing += 2 * Math.PI;
    const deltaPitch = endPitch - startPitch;
    if (Math.abs(deltaBearing) < 0.001 && Math.abs(deltaPitch) < 0.001 &&
        Math.abs(endDistance - startDistance) < 1) return;
    this._controlsDampingWasEnabled = this.controls.enableDamping;
    this.controls.enableDamping = false;
    const startTime = performance.now();
    const anim = {
        startTarget, startBearing, startPitch, startDistance,
        endBearing, endPitch, endDistance, duration, startTime,
    };
    this._cameraAnimation = anim;

    const animateStep = (now: number) => {
        if (this._disposed || this._cameraAnimation !== anim) return;
        let t = (now - anim.startTime) / (anim.duration * 1000);
        t = Math.min(t, 1.0);
        const eased = t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
        const curBearing = anim.startBearing + (anim.endBearing - anim.startBearing) * eased;
        const curPitch   = anim.startPitch   + (anim.endPitch   - anim.startPitch)   * eased;
        const curDist    = anim.startDistance + (anim.endDistance - anim.startDistance) * eased;
        const azimuth = curBearing + Math.PI / 2;
        this._resolveCameraPlacement(anim.startTarget, curDist, curPitch, azimuth, this._tempPlacementOut);
        this.camera.position.copy(this._tempPlacementOut);
        this.controls.target.copy(anim.startTarget);
        this.controls.update();
        this.maybeUpdateVisibleTiles();
        if (t >= 1.0) {
            if (this._cameraAnimation === anim) this._cameraAnimation = null;
            this.controls.enableDamping = this._controlsDampingWasEnabled;
            const endAz = anim.endBearing + Math.PI / 2;
            this._resolveCameraPlacement(anim.startTarget, anim.endDistance, anim.endPitch, endAz, this._tempPlacementOut);
            this.camera.position.copy(this._tempPlacementOut);
            this.controls.target.copy(anim.startTarget);
            this.controls.update();
            this.maybeUpdateVisibleTiles();
            return;
        }
        requestAnimationFrame(animateStep);
    };
    requestAnimationFrame(animateStep);
},

fitToBounds(bounds, options = {}) {
    if (!bounds || !bounds[0] || !bounds[1]) {
        console.warn('fitToBounds: bounds must be [[minX, minY], [maxX, maxY]]');
        return;
    }
    const { crs = this.inputCRS, padding = 0, duration = 0.5, maxZoom = this.MAX_ZOOM } = options;
    const [[ax, ay], [bx, by]] = bounds;
    const minInX = Math.min(ax, bx), maxInX = Math.max(ax, bx);
    const minInY = Math.min(ay, by), maxInY = Math.max(ay, by);
    const [padX, padY] = Array.isArray(padding) ? [padding[0], padding[1]] : [padding, padding];
    const srcCrs = typeof crs === 'string' ? Projections.getRaw(crs) : crs;
    let minWX = Infinity, maxWX = -Infinity, minWZ = Infinity, maxWZ = -Infinity;
    const corners = [[minInX, minInY], [maxInX, minInY], [minInX, maxInY], [maxInX, maxInY]];
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
        this.easeTo({
            center: [targetLon, targetLat],
            zoom: Math.min(currentZoom, maxZoom),
            duration,
        });
        return;
    }
    const D = this._computeFitDistance(targetX, targetZ, halfW, halfH, padX, padY);
    let z = this.getZoomForDistance(D);
    if (!isFinite(z)) z = this.continuousZoom;
    z = Math.max(this.MIN_ZOOM, Math.min(maxZoom, z));
    this.easeTo({ center: [targetLon, targetLat], zoom: z, duration });
},

fitTo(objectOrArray, options = {}) {
    const objs = Array.isArray(objectOrArray) ? objectOrArray : [objectOrArray];
    const crsCode = options.crs ?? 'EPSG:4326';
    const crs = typeof crsCode === 'string' ? Projections.getRaw(crsCode) : crsCode;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const obj of objs) {
        if (!obj || typeof obj.getBounds !== 'function') continue;
        let b;
        try { b = obj.getBounds(crsCode); }
        catch (err) { console.warn('fitTo: getBounds() threw an error for', obj, err); continue; }
        if (!b) continue;
        if (b[0][0] < minX) minX = b[0][0];
        if (b[0][1] < minY) minY = b[0][1];
        if (b[1][0] > maxX) maxX = b[1][0];
        if (b[1][1] > maxY) maxY = b[1][1];
    }
    if (!isFinite(minX)) return;
    this.fitToBounds([[minX, minY], [maxX, maxY]], { ...options, crs });
},

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
        [targetX + halfW, 0, targetZ + halfH],
    ];
    let dRequired = 0;
    for (const [px, py, pz] of corners) {
        const ox = px - targetX, oy = py, oz = pz - targetZ;
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
},

// ───────────────────────────────────────────────────────────────────────
// Optimized applyZoomDistance:
//
// 1. Uses _tempVec3a/_tempVec3b for the two pivot raycasts instead of
//    allocating a fresh THREE.Vector3 each call. Applied each zoom frame,
//    this saves ~2 vector allocations/frame.
// 2. Fixed a latent null-deref in the debug log: `P_after.x` was accessed
//    even when P_after was null. Now the shift is captured in locals and
//    only the debug path reads them.
// ───────────────────────────────────────────────────────────────────────
applyZoomDistance() {
    if (this._cameraAnimation) {
        this._zoomPivotActive = false;
        return;
    }
    if (this.globe) {
        this._applyGlobeZoomDistance();
        return;
    }

    const zoomDiff  = Math.abs(this.continuousZoom - this.targetContinuousZoom);
    const zoomActive = zoomDiff > 0.0005;          // ← добавлено
    // Пивот доживает до кадра, в котором зум уже «доехал» (zoomDiff ≈ 0):
    // на нём дистанция делает последний шаг, и без ещё одной коррекции
    // точка под курсором уезжает на доли пикселя. Снимаем флаг в конце
    // кадра, чтобы он не «прилип» к следующему зуму (например, кнопкой UI).
    const pivotActive = this._zoomPivotActive && (zoomActive || zoomDiff < 0.001);

    this.camera.updateMatrixWorld(true);

    let P_before: any = null;
    let pivotSx = 0, pivotSy = 0;
    if (pivotActive) {
        pivotSx = this._zoomPivotX;
        pivotSy = this._zoomPivotY;
        P_before = this._raycastToGround(pivotSx, pivotSy, this._tempVec3a);
    }

    const target = this._tempTarget.copy(this.controls.target);
    const currentDir = this._tempDir.subVectors(this.camera.position, target);
    const d0 = currentDir.length();
    if (d0 < 1e-6) return;
    currentDir.divideScalar(d0);
    const pitch    = Math.acos(Math.max(-1, Math.min(1, currentDir.y)));
    const azimuth  = Math.atan2(currentDir.z, currentDir.x);

    // КЛЮЧЕВОЕ: если зум не активен — стартуем с текущего расстояния,
    // чтобы _resolveCameraPlacement только приподнимал над рельефом,
    // но не «сдёргивал» камеру назад к desiredDist каждый кадр.
    const desiredDist = zoomActive
        ? this.getTargetDistanceForZoom(this.continuousZoom)
        : d0;

    this._resolveCameraPlacement(target, desiredDist, pitch, azimuth, this._tempPlacementOut);
    this.camera.position.copy(this._tempPlacementOut);
    this.camera.lookAt(target);
    this.camera.updateMatrixWorld(true);

    if (pivotActive && P_before) {
        const P_after = this._raycastToGround(pivotSx, pivotSy, this._tempVec3b);
        let shiftX = 0, shiftZ = 0;
        if (P_after) {
            shiftX = P_after.x - P_before.x;
            shiftZ = P_after.z - P_before.z;
            this.worldGroup.position.x += shiftX;
            this.worldGroup.position.z += shiftZ;
            // worldGroup changed — invalidate cached bounds check
            (this as any)._lastBoundsCheck = null;
        }
        if ((window as any).__krbDebugZoom) {
            console.log(
                '[zoom] z=%s dist=%s shift=(%s,%s) frameDt=%s',
                this.continuousZoom.toFixed(3),
                this.camera.position.distanceTo(this.controls.target).toFixed(1),
                shiftX.toFixed(3),
                shiftZ.toFixed(3),
                (this._currentDeltaTime * 1000).toFixed(1),
            );
        }
    }

    // Зум доехал — точка привязки больше не нужна.
    if (!zoomActive) this._zoomPivotActive = false;
},

/**
 * Покадровое обновление камеры глобуса:
 *  - плавное доведение pitch/bearing (setPitch/setBearing/rotateToNorth);
 *  - постановка камеры по состоянию: цель на поверхности, дистанция по
 *    зуму и широте (h·cos φ), фактический наклон с учётом гейта;
 *  - zoom-to-cursor (доворот цели вокруг центра Земли).
 *
 * Гейт _globeTiltGate() сам «выпрямляет» поворот при отдалении ниже z=5.
 */
_applyGlobeZoomDistance() {
    const dt = this._currentDeltaTime > 0 ? this._currentDeltaTime : 1 / 60;
    const k = Math.min(1, 10 * dt);

    if (this._globePitch === undefined) this._globePitch = 0;
    if (this._globeBearing === undefined) this._globeBearing = 0;
    if (this._globePitchTarget === undefined) this._globePitchTarget = this._globePitch;
    if (this._globeBearingTarget === undefined) this._globeBearingTarget = this._globeBearing;

    const dp = this._globePitchTarget - this._globePitch;
    const db = this._globeBearingTarget - this._globeBearing;
    if (Math.abs(dp) > 1e-4 || Math.abs(db) > 1e-4) {
        this._globePitch += dp * k;
        this._globeBearing += db * k;
    } else {
        this._globePitch = this._globePitchTarget;
        this._globeBearing = this._globeBearingTarget;
    }

    const zoomDiff = Math.abs(this.continuousZoom - this.targetContinuousZoom);
    const zoomActive = zoomDiff > 0.0005;
    const pivotActive = this._zoomPivotActive && (zoomActive || zoomDiff < 0.001);

    let P_before: any = null;
    let pivotSx = 0, pivotSy = 0;
    if (pivotActive) {
        pivotSx = this._zoomPivotX;
        pivotSy = this._zoomPivotY;
        this.camera.updateMatrixWorld(true);
        P_before = this._raycastToGround(pivotSx, pivotSy, this._tempVec3a);
    }

    // Дистанция до цели зависит от зуму и широты центра (h·cos φ).
    const dist = this.getTargetDistanceForZoom(this.continuousZoom);
    this._globeApplyPose(dist, this._globePitchNow(), this._globeBearingNow());

    if (pivotActive && P_before) {
        this._globeZoomToPivot(P_before, pivotSx, pivotSy, dist);
    }
    if (!zoomActive) this._zoomPivotActive = false;
},

/**
 * Пере-целиться вдоль луча «камера → текущая цель» до поверхности.
 * Нужно после доворота камеры: её ориентация ещё «старая», поэтому
 * луч к повёрнутой цели — это и есть новый центр кадра.
 */
_globeProjectTarget(): void {
    const cam = this.camera;
    const tgt = this.controls?.target;
    if (!cam || !tgt) return;
    _globTmp.copy(tgt).sub(cam.position);
    const len = _globTmp.length();
    if (!(len > 1e-6)) return;
    _globTmp.divideScalar(len);
    this._tempRaycaster.set(cam.position, _globTmp);
    const hit = this.surface.raycast(this._tempRaycaster, _globTmp2, this.worldGroup);
    if (hit) this.controls.target.copy(hit);
},

/**
 * Правая кнопка на глобусе (zoom ≥ 6): «орбитальная» камера как в плоской
 * ветке — вокруг ЦЕНТРА экрана, только теперь вертикаль в точке обзора
 * местная (нормаль эллипсоида), а не мировая Y.
 *
 *   dTheta — yaw вокруг местной вертикали (работает всегда);
 *   dPhi   — наклон в диапазоне 0…85°, как minPolarAngle/maxPolarAngle
 *            в плоском случае: на упоре наклон стоит, а yaw продолжает
 *            вращать карту — никакого переворота.
 *
 * Вращение вокруг центра (а не вокруг курсора) сохраняет дистанцию, поэтому
 * зум не «прыгает» и картинка не дёргается кадр от кадра.
 */
_globeRotateAroundPivot(dxPixels: number, dyPixels: number, pivot: any): void {
    const cam = this.camera;
    const tgt = this.controls?.target;
    if (!cam || !tgt) return;
    const el = this.renderer?.domElement;
    const H = el ? el.clientHeight : 0;
    if (!(H > 0)) return;

    const speed = this.controls?.rotateSpeed ?? 1;
    // Знак yaw — как в плоской ветке: тянем ВПРАВО → мир поворачивается
    // ПРОТИВ часовой, тянем ВЛЕВО → по часовой.
    const dTheta = (2 * Math.PI * dxPixels * speed) / H;
    const dPhi   = (-2 * Math.PI * dyPixels * speed) / H;

    // Местная вертикаль в центре экрана (точке обзора).
    const up = _globUp, north = _globNorth, east = _globEast;
    this._globeFrame(up, north, east);

    // Ось yaw — местная вертикаль; ось наклона — «восток»-направление
    // (горизонталь, перпендикулярная текущему «взгляду сверху»).
    let bearing = this._globeBearingNow();
    const pitch0 = this._globePitchNow();

    if (this.allowRotate && dTheta !== 0) bearing += dTheta;

    let pitch = pitch0;
    if (this.allowPitch && dPhi !== 0) {
        pitch = Math.max(GLOBE_MIN_PITCH, Math.min(GLOBE_MAX_PITCH, pitch0 + dPhi));
    }

    // Если гейт ещё не пустил поворот (zoom < 6), ничего не трогаем.
    if (this._globeTiltGate() <= 0) return;

    const dist = this.getTargetDistanceForZoom(this.continuousZoom);
    this._globeBearing = bearing;
    this._globePitch = pitch;
    this._globeBearingTarget = bearing;
    this._globePitchTarget = pitch;

    this._globeApplyPose(dist, pitch, bearing);

    this.controls?.update?.();
    this.maybeUpdateVisibleTiles();
},

applyZoomDelta(delta) {
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
},

peekIdealZoom(continuousZoom) {
    return Math.max(this.MIN_ZOOM, Math.min(this.MAX_ZOOM, Math.round(continuousZoom)));
},

/**
 * Переносит controls.target вдоль текущего луча взгляда на плоскость y = 0
 * и пересчитывает continuousZoom по новому расстоянию.
 * Ориентация камеры не меняется, поэтому картинка не прыгает.
 */
_retargetToGround(): boolean {
    const cam = this.camera.position;
    const dir = this._tempDir.subVectors(this.controls.target, cam);
    const len = dir.length();
    if (len < 1e-6) return false;
    dir.divideScalar(len);
    if (dir.y > -1e-6) return false;          // луч не смотрит вниз, землю не пересекает

    const t = -cam.y / dir.y;                 // расстояние вдоль луча до y = 0
    if (!(t > 0) || !isFinite(t)) return false;

    // сохраняем «недоеденный» зум от колеса, чтобы не обрывать инерцию
    const pending = this.targetContinuousZoom - this.continuousZoom;

    this.controls.target.copy(cam).addScaledVector(dir, t);
    this.camera.lookAt(this.controls.target);
    this.camera.updateMatrixWorld(true);
    this.controls.update();

    const z = Math.max(this.MIN_ZOOM, Math.min(this.MAX_ZOOM, this.getZoomForDistance(t)));
    this.continuousZoom = z;
    this.targetContinuousZoom = Math.max(this.MIN_ZOOM, Math.min(this.MAX_ZOOM, z + pending));
    return true;
},

syncControlsTarget() {
    // На глобусе цель — это и есть точка обзора (центр экрана), трогать нечего.
    if (this.globe) return;
    this._retargetToGround();
},

get targetZoom() {
    return this._cameraAnimation?.endZoom ?? this.targetContinuousZoom;
},

getMaxBounds(): [[number, number], [number, number]] | null {
    if (!this._maxBounds) return null;
    const b = this._maxBounds;
    return [[b.minLon, b.minLat], [b.maxLon, b.maxLat]];
},
};

declare module './Core.js' {
    interface KrbMap extends CoreCameraMethods {}
}