// CoreCamera.ts
import { THREE, OrbitControls, TOUCH_MAP_CONTROLS } from './js_TP/tpb.js';
import type { KrbMap } from './Core.js';
import { Projections } from './Projections.js';

export interface CoreCameraMethods {
    initControls(): void;
    getTargetDistanceForZoom(z: number): number;
    getZoomForDistance(d: number): number;
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
}

export const CoreCameraMixin: CoreCameraMethods & ThisType<KrbMap> = {
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
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.6;
    this.controls.rotateSpeed = 1;
},

    getTargetDistanceForZoom(z: number): number {
        const canvas = this.renderer?.domElement;
        const H = canvas ? canvas.clientHeight : 0;
        const fov = this.camera?.fov ?? 45;
        if (H <= 0) {
            return this.BASE_DISTANCE * Math.pow(0.5, z - this.BASE_ZOOM);
        }
        const tanHalfFov = Math.tan((fov * Math.PI) / 360);
        return (this.WORLD_SIZE / Math.pow(2, z)) * H / (2 * this.TILE_PIXELS * tanHalfFov);
    },

    getZoomForDistance(d: number): number {
        if (!(d > 0) || !isFinite(d)) return this.continuousZoom;
        const canvas = this.renderer?.domElement;
        const H = canvas ? canvas.clientHeight : 0;
        const fov = this.camera?.fov ?? 45;
        if (H <= 0) return this.BASE_ZOOM + Math.log2(this.BASE_DISTANCE / d);
        const tanHalfFov = Math.tan((fov * Math.PI) / 360);
        const K = H / (2 * this.TILE_PIXELS * tanHalfFov);
        return Math.log2((this.WORLD_SIZE * K) / d);
    },

_resolveCameraPlacement(target, desiredDist, desiredPitch, azimuth, outPos) {
    let dist = desiredDist;
    const minP = this.controls?.minPolarAngle ?? 0.001;
    const maxP = this.controls?.maxPolarAngle ?? (Math.PI - 0.001);
    let pitch = Math.max(minP, Math.min(maxP, desiredPitch));   // ← было Math.PI - 0.001
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
            pitch = Math.max(minP, Math.min(maxP, pitch));          
            if (pitch <= minP) { pitch = minP; break; }
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
    },

    setPitch(pitchDeg, duration = 0.3) {
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
    },

    moveCameraToSlow(lon, lat, duration = 1.0, targetZoom = null) {
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
            this._resolveCameraPlacement(endTarget, this.getTargetDistanceForZoom(endZoom), animPitch, animAzimuth, this._tempPlacementOut);
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
        this._cameraAnimation = { startTarget, endTarget, startZoom, endZoom, duration, startTime };
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
            this._resolveCameraPlacement(currentTarget, this.getTargetDistanceForZoom(currentZoom), animPitch, animAzimuth, this._tempPlacementOut);
            this.camera.position.copy(this._tempPlacementOut);
            this.controls.target.copy(currentTarget);
            this.controls.update();
            this.continuousZoom = currentZoom;
            this.targetContinuousZoom = currentZoom;
            this.maybeUpdateVisibleTiles();
            if (t >= 1.0) {
                this._cameraAnimation = null;
                this.controls.enableDamping = this._controlsDampingWasEnabled;
                this._resolveCameraPlacement(anim.endTarget, this.getTargetDistanceForZoom(anim.endZoom), animPitch, animAzimuth, this._tempPlacementOut);
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
    },

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
        this._cameraAnimation = {
            startTarget, startBearing, startPitch, startDistance,
            endBearing, endPitch, endDistance, duration, startTime,
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
            this._resolveCameraPlacement(anim.startTarget, curDist, curPitch, azimuth, this._tempPlacementOut);
            this.camera.position.copy(this._tempPlacementOut);
            this.controls.target.copy(anim.startTarget);
            this.controls.update();
            this.maybeUpdateVisibleTiles();
            if (t >= 1.0) {
                this._cameraAnimation = null;
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
        const srcCrs = typeof crs === 'string' ? Projections.get(crs) : crs;
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
            this.moveCameraToSlow(targetLon, targetLat, duration, Math.min(currentZoom, maxZoom));
            return;
        }
        const D = this._computeFitDistance(targetX, targetZ, halfW, halfH, padX, padY);
        let z = this.getZoomForDistance(D);
        if (!isFinite(z)) z = this.continuousZoom;
        z = Math.max(this.MIN_ZOOM, Math.min(maxZoom, z));
        this.moveCameraToSlow(targetLon, targetLat, duration, z);
    },

    fitTo(objectOrArray, options = {}) {
        const objs = Array.isArray(objectOrArray) ? objectOrArray : [objectOrArray];
        const crsCode = options.crs ?? 'EPSG:4326';
        const crs = typeof crsCode === 'string' ? Projections.get(crsCode) : crsCode;
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
applyZoomDistance() {
    if (this._cameraAnimation) {
        this._zoomPivotActive = false;
        return;
    }

    const zoomDiff = Math.abs(this.continuousZoom - this.targetContinuousZoom);
    const pivotActive = this._zoomPivotActive && zoomDiff > 0.0005;

    // Гарантируем, что matrixWorld соответствует текущей позиции/кватерниону.
    this.camera.updateMatrixWorld(true);

    let P_before: any = null;
    let pivotSx = 0, pivotSy = 0;
    if (pivotActive) {
        pivotSx = this._zoomPivotX;
        pivotSy = this._zoomPivotY;
        P_before = this._raycastToGround(pivotSx, pivotSy, new THREE.Vector3());
    }

    // --- существующее перемещение камеры ---
    const target = this._tempTarget.copy(this.controls.target);
    const currentDir = this._tempDir.subVectors(this.camera.position, target);
    const d0 = currentDir.length();
    if (d0 < 1e-6) return;
    currentDir.divideScalar(d0);
    const pitch = Math.acos(Math.max(-1, Math.min(1, currentDir.y)));
    const azimuth = Math.atan2(currentDir.z, currentDir.x);
    const desiredDist = this.getTargetDistanceForZoom(this.continuousZoom);
    this._resolveCameraPlacement(target, desiredDist, pitch, azimuth, this._tempPlacementOut);
    this.camera.position.copy(this._tempPlacementOut);
    this.camera.lookAt(target);

    // КРИТИЧНО: matrixWorld после lookAt хранит СТАРЫЙ кватернион.
    // Для чистого зума это почти безвредно, но при малейшем изменении
    // ориентации (например, если zoomToCursor идёт во время анимации
    // или terrain-кламп чуть изменил pitch) raycast ошибается.
    this.camera.updateMatrixWorld(true);

    if (pivotActive && P_before) {
        const P_after = this._raycastToGround(pivotSx, pivotSy, new THREE.Vector3());
        if (P_after) {
            this.worldGroup.position.x += P_after.x - P_before.x;
            this.worldGroup.position.z += P_after.z - P_before.z;
        }
        if ((window as any).__krbDebugZoom) {
    console.log(
        '[zoom] z=%s dist=%s shift=(%s,%s) frameDt=%s',
        this.continuousZoom.toFixed(3),
        this.camera.position.distanceTo(this.controls.target).toFixed(1),
        (P_after.x - P_before.x).toFixed(3),
        (P_after.z - P_before.z).toFixed(3),
        (this._currentDeltaTime * 1000).toFixed(1),
    );
}
        if (zoomDiff < 0.001) this._zoomPivotActive = false;
    }
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
    this._retargetToGround();
},

    get targetZoom() {
        return this._cameraAnimation?.endZoom ?? this.targetContinuousZoom;
    },
};

declare module './Core.js' {
    interface KrbMap extends CoreCameraMethods {}
}