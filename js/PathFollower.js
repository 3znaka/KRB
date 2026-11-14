/**
 * PathFollower — объект, движущийся вдоль пути (`Vector3D` или любой PathAdapter).
 *
 * Отделяет «юнит движения» от «геометрии пути»: одна и та же линия может
 * обслуживать десятки машинок, каждая со своей скоростью, моделью, меткой
 * и событиями. Наследует SpatialObject (zoom bounds, tooltip, onClick/onHover,
 * подпись через TextManager, altitude).
 *
 * Ключевые идеи:
 *   • движение задаётся в терминах {from, to} × {duration | speed} и
 *     автоматически пересчитывается в мировые метры вдоль пути;
 *   • `from`/`to` — либо fraction 0..1 (как `t` в Vector3D), либо `{meters: N}`;
 *   • `speed` — либо м/с (число), либо `{mps}`, `{kmh}`;
 *   • модель — любой `Object3D` (в т.ч. клон GLB-сцены); px/world-масштаб,
 *     выравнивание по касательной, lateral/altitude-offset.
 *
 * @module PathFollower
 */
import { SpatialObject } from './SpatialObject.js';
import { THREE } from './js_TP/tpb.js';
import { createPrimitiveMesh } from './Marker3D.js';
// =====================================================================
// PathFollower
// =====================================================================
const _EPS = 1e-9;
export class PathFollower extends SpatialObject {
    // ── путь ──
    _path;
    _unsubRebuild = null;
    _unsubDestroy = null;
    _cachedPoints = [];
    _cachedLengths = [0];
    _cachedTotal = 0;
    _pathValid = false;
    // ── визуал ──
    _group;
    _visualRoot = null;
    _visualDispose = null;
    _visualSetSize = null;
    _visualToken = 0;
    _visualBBox = null;
    _visualInput = null;
    // ── sizing ──
    _size;
    _sizeMode;
    _scale;
    _alignToPath;
    _forwardAxis;
    _altitudeOffset;
    _lateralOffset;
    // ── движение ──
    _fromDist = 0;
    _toDist = 0;
    _currentDist = 0;
    _duration = 0;
    _elapsed = 0;
    _playing = false;
    _paused = false;
    _loop = 'none';
    _easing = 'linear';
    _direction = 1;
    _onProgress = null;
    _onComplete = null;
    _onLoop = null;
    // ── перф / расчёты ──
    _lastUpdateTime = 0;
    _lastInstantSpeed = 0;
    _lastDist = 0;
    _lastScreenPosDirty = true;
    _screenPos = null;
    // ── интерактив ──
    _unregisterInteraction = null;
    // ── заголовок (свой vertical align) ──
    _titleVerticalAlign = 'bottom';
    // ── временное ──
    _tmpPos = new THREE.Vector3();
    _tmpTangent = new THREE.Vector3();
    _tmpWorld = new THREE.Vector3();
    _tmpRight = new THREE.Vector3();
    _tmpMtx = new THREE.Matrix4();
    _tmpQuat = new THREE.Quaternion();
    _upY = new THREE.Vector3(0, 1, 0);
    constructor(o) {
        super();
        if (!o?.path)
            throw new Error('PathFollower: options.path is required');
        this._path = o.path;
        this._minZoom = o.minZoom ?? -Infinity;
        this._maxZoom = o.maxZoom ?? Infinity;
        this._properties = o.properties ?? {};
        this._userData = o.userData ?? {};
        this._tooltipText = o.tooltip ?? '';
        this._onClick = o.onClick ?? null;
        this._onHover = o.onHover ?? null;
        this._size = o.size ?? 20;
        this._sizeMode = o.sizeMode === 'world' ? 'world' : 'px';
        this._scale = o.scale ?? 1;
        this._alignToPath = o.alignToPath ?? true;
        this._forwardAxis = o.forwardAxis ?? 'y';
        this._altitudeOffset = o.altitudeOffset ?? 0;
        this._lateralOffset = o.lateralOffset ?? 0;
        if (o.zoomInterpolate)
            this.setZoomInterpolations(o.zoomInterpolate);
        // Заголовок
        this._title = o.title ?? '';
        this._titleStyle = o.titleStyle ?? {};
        this._titleAlign = o.titleAlign ?? 'center';
        this._titleVerticalAlign = o.titleVerticalAlign ?? 'bottom';
        this._userTitleOffset = o.titleOffset ?? null;
        this._titleMinZoom = o.titleMinZoom ?? -Infinity;
        this._titleMaxZoom = o.titleMaxZoom ?? Infinity;
        this._titleAllowOverflow = o.titleAllowOverflow ?? false;
        this._titlePriority = o.titlePriority ?? 0;
        this._group = new THREE.Group();
        this._group.visible = false;
        if (o.visual)
            this.setVisual(o.visual);
        if (o.animation)
            this._applyMoveSpec(o.animation, o.autoPlay ?? true);
    }
    // =================================================================
    // SpatialObject hooks
    // =================================================================
    _onAttached(map) {
        // Восстановить визуал, если предыдущий _teardown его сбросил (переаттач).
        // Безопасно только для фабрик — готовый Object3D после dispose не воскресить.
        if (!this._visualRoot && typeof this._visualInput === 'function') {
            this.setVisual(this._visualInput);
        }
        this._unsubRebuild = this._path.onPathRebuild(() => { this._pathValid = false; });
        this._unsubDestroy = this._path.onPathDestroy(() => {
            // Путь убрали с карты — аккуратно убираем и себя.
            this.remove();
        });
        this._pathValid = false;
        this._ensurePathData();
        map.worldGroup.add(this._group);
        this._registerInteraction(map);
        this._lastUpdateTime = 0;
        this._lastDist = this._currentDist;
        this._screenPos = null;
        this._lastScreenPosDirty = true;
        // Метка через TextManager
        if (this._title && map.textManager) {
            this._textLabel = map.textManager.addLabel(this);
        }
    }
    _teardown() {
        this._unsubRebuild?.();
        this._unsubRebuild = null;
        this._unsubDestroy?.();
        this._unsubDestroy = null;
        this._unregisterInteraction?.();
        this._unregisterInteraction = null;
        if (this._map?.textManager && this._textLabel) {
            this._map.textManager.removeLabel(this._textLabel);
        }
        this._textLabel = null;
        if (this._group.parent)
            this._group.parent.remove(this._group);
        this._disposeVisual();
        this._pathValid = false;
        this._cachedPoints = [];
        this._cachedLengths = [0];
        this._cachedTotal = 0;
        this._screenPos = null;
    }
    _applyHidden() {
        this._group.visible = false;
    }
    _onTooltipChanged() {
        if (this._map)
            this._registerInteraction(this._map);
    }
    _onAltitudeChanged() {
        // высота добавляется на кадре
    }
    getLabelType() { return 'point'; }
    getTitleVerticalAlign() { return this._titleVerticalAlign; }
    getScreenPosition() {
        return this._screenPos;
    }
    setTitle(text) {
        super.setTitle(text);
        if (this._map?.textManager && !this._textLabel && this._title) {
            this._textLabel = this._map.textManager.addLabel(this);
        }
        return this;
    }
    // =================================================================
    // PathAdapter — внутренняя копия
    // =================================================================
    _ensurePathData() {
        if (this._pathValid)
            return this._cachedTotal > 0;
        const pts = this._path.getPathPoints();
        this._cachedPoints = pts;
        const n = pts.length;
        if (n < 2) {
            this._cachedLengths = [0];
            this._cachedTotal = 0;
            this._pathValid = true;
            return false;
        }
        const lengths = new Array(n);
        lengths[0] = 0;
        let total = 0;
        for (let i = 1; i < n; i++) {
            const a = pts[i - 1], b = pts[i];
            const dx = b[0] - a[0], dy = b[1] - a[1], dz = b[2] - a[2];
            total += Math.sqrt(dx * dx + dy * dy + dz * dz);
            lengths[i] = total;
        }
        this._cachedLengths = lengths;
        this._cachedTotal = total;
        this._pathValid = true;
        return total > _EPS;
    }
    /** Сэмпл по дистанции (м). Использует бинарный поиск. */
    _sampleAtDistance(d, outPos, outTangent) {
        const L = this._cachedTotal;
        if (L <= _EPS)
            return false;
        const cl = Math.max(0, Math.min(L, d));
        const lengths = this._cachedLengths;
        const pts = this._cachedPoints;
        // binary search сегмента
        let lo = 1, hi = lengths.length - 1;
        while (lo < hi) {
            const mid = (lo + hi) >> 1;
            if (lengths[mid] < cl)
                lo = mid + 1;
            else
                hi = mid;
        }
        const i = lo;
        const segStart = lengths[i - 1];
        const segLen = lengths[i] - segStart;
        const u = segLen > _EPS ? (cl - segStart) / segLen : 0;
        const p0 = pts[i - 1], p1 = pts[i];
        outPos.set(p0[0] + (p1[0] - p0[0]) * u, p0[1] + (p1[1] - p0[1]) * u, p0[2] + (p1[2] - p0[2]) * u);
        outTangent.set(p1[0] - p0[0], p1[1] - p0[1], p1[2] - p0[2]);
        if (outTangent.lengthSq() < 1e-12)
            outTangent.set(0, 1, 0);
        else
            outTangent.normalize();
        return true;
    }
    // =================================================================
    // Публичное API движения
    // =================================================================
    /**
     * Настроить и (опционально) запустить движение.
     *
     * Примеры:
     *   f.moveTo({ from: 0.15, to: 0.26, duration: 10 });
     *   f.moveTo({ to: 0.26, speed: { kmh: 60 } });
     *   f.moveTo({ from: { meters: 500 }, to: { meters: 2000 }, duration: 30 });
     *   f.moveTo({ to: 1, duration: 60, loop: 'pingpong', easing: 'sine' });
     */
    moveTo(spec) {
        this._ensurePathData();
        this._applyMoveSpec(spec, true);
        return this;
    }
    play() {
        if (!this._playing)
            return this;
        this._paused = false;
        return this;
    }
    pause() {
        this._paused = true;
        return this;
    }
    /** Остановить и вернуть в начальную точку последнего moveTo. */
    stop() {
        this._paused = false;
        this._playing = false;
        this._elapsed = 0;
        this._direction = 1;
        this._currentDist = this._fromDist;
        this._lastDist = this._currentDist;
        this._lastInstantSpeed = 0;
        return this;
    }
    /** Прыжок в точку без пересчёта анимации. */
    seek(target) {
        this._ensurePathData();
        const d = this._resolveDistanceSpec(target);
        this._currentDist = Math.max(0, Math.min(this._cachedTotal, d));
        this._lastDist = this._currentDist;
        return this;
    }
    /** Изменить скорость «на лету», сохранив текущую позицию. */
    setSpeed(speed) {
        const v = this._resolveSpeed(speed) ?? 1;
        if (!(v > 0))
            return this;
        const remaining = Math.abs(this._toDist - this._currentDist);
        this._duration = remaining / v;
        this._elapsed = 0;
        this._easing = 'linear';
        this._fromDist = this._currentDist;
        this._direction = this._toDist >= this._currentDist ? 1 : -1;
        return this;
    }
    getProgress() {
        const L = this._cachedTotal || 1;
        const remainingDistance = Math.abs(this._toDist - this._currentDist);
        const avgSpeed = this._duration > 0
            ? Math.abs(this._toDist - this._fromDist) / this._duration
            : 0;
        return {
            distance: this._currentDist,
            fraction: this._currentDist / L,
            remainingDistance,
            remainingTime: avgSpeed > 0 ? remainingDistance / avgSpeed : 0,
            speed: this._lastInstantSpeed,
            isPlaying: this._playing,
            isPaused: this._paused,
        };
    }
    getCurrentPosition() {
        if (!this._ensurePathData())
            return null;
        return this._tmpWorld.clone();
    }
    getCurrentTangent() {
        if (!this._ensurePathData())
            return null;
        return this._tmpTangent.clone();
    }
    getTotalPathLength() { this._ensurePathData(); return this._cachedTotal; }
    getCurrentDistance() { return this._currentDist; }
    isPlaying() { return this._playing && !this._paused; }
    isPaused() { return this._playing && this._paused; }
    setLoop(mode) { this._loop = mode; return this; }
    setEasing(e) { this._easing = e; return this; }
    // =================================================================
    // Визуал
    // =================================================================
    setVisual(visual) {
        this._visualInput = visual;
        this._disposeVisual();
        this._visualToken++;
        const token = this._visualToken;
        const attach = (v) => {
            if (token !== this._visualToken) {
                // Устаревший async-резолв.
                try {
                    v?.dispose?.();
                }
                catch { }
                try {
                    if (v?.object)
                        v.object.removeFromParent();
                    else
                        v?.removeFromParent?.();
                }
                catch { }
                return;
            }
            if (!v)
                return;
            if (v.object) {
                const fv = v;
                this._visualRoot = fv.object;
                this._visualDispose = fv.dispose ?? null;
                this._visualSetSize = fv.setSize ?? null;
            }
            else {
                this._visualRoot = v;
                this._visualDispose = null;
                this._visualSetSize = null;
            }
            this._group.add(this._visualRoot);
            this._visualBBox = this._computeBBox(this._visualRoot);
        };
        if (typeof visual === 'function') {
            try {
                const res = visual(this);
                if (res && typeof res.then === 'function') {
                    res.then(attach).catch(err => {
                        console.error('PathFollower: visual factory rejected', err);
                    });
                }
                else {
                    attach(res);
                }
            }
            catch (err) {
                console.error('PathFollower: visual factory threw', err);
            }
        }
        else {
            attach(visual);
        }
        return this;
    }
    _disposeVisual() {
        if (this._visualRoot) {
            this._visualRoot.removeFromParent?.();
            if (this._visualDispose) {
                try {
                    this._visualDispose();
                }
                catch { }
            }
            this._visualRoot = null;
            this._visualDispose = null;
            this._visualSetSize = null;
            this._visualBBox = null;
        }
    }
    _computeBBox(root) {
        try {
            const box = new THREE.Box3().setFromObject(root);
            if (!box.isEmpty()) {
                const size = new THREE.Vector3();
                box.getSize(size);
                return { size };
            }
        }
        catch { /* ignore */ }
        return null;
    }
    setSize(size, mode = this._sizeMode) {
        if (!(size > 0))
            return this;
        this._size = size;
        this._sizeMode = mode;
        return this;
    }
    setAlignToPath(align) { this._alignToPath = !!align; return this; }
    setLateralOffset(off) { this._lateralOffset = off; return this; }
    setAltitudeOffset(off) { this._altitudeOffset = off; return this; }
    // =================================================================
    // Переназначение пути
    // =================================================================
    setPath(newPath) {
        if (newPath === this._path)
            return this;
        this._unsubRebuild?.();
        this._unsubDestroy?.();
        this._path = newPath;
        if (this._map) {
            this._unsubRebuild = newPath.onPathRebuild(() => { this._pathValid = false; });
            this._unsubDestroy = newPath.onPathDestroy(() => this.remove());
        }
        this._pathValid = false;
        this._ensurePathData();
        // Обрезать текущую позицию под новый путь
        this._currentDist = Math.max(0, Math.min(this._cachedTotal, this._currentDist));
        this._fromDist = Math.max(0, Math.min(this._cachedTotal, this._fromDist));
        this._toDist = Math.max(0, Math.min(this._cachedTotal, this._toDist));
        return this;
    }
    // =================================================================
    // Кадр
    // =================================================================
    _update(map, deltaTime) {
        if (!this._map)
            return;
        this._applyZoomInterpolations(map.continuousZoom);
        if (!this._isWithinView()) {
            this._applyHidden();
            this._isVisible = false;
            return;
        }
        // ── путь ──
        if (!this._ensurePathData()) {
            this._applyHidden();
            this._isVisible = false;
            return;
        }
        // ── dt ──
        if (typeof deltaTime !== 'number' || !isFinite(deltaTime) || deltaTime <= 0) {
            const now = performance.now();
            deltaTime = this._lastUpdateTime ? Math.min((now - this._lastUpdateTime) / 1000, 0.1) : 0;
        }
        if (deltaTime > 0.1)
            deltaTime = 0.1;
        this._lastUpdateTime = performance.now();
        // ── движение ──
        if (this._playing && !this._paused)
            this._advanceMovement(deltaTime);
        // ── сэмпл и трансформ ──
        if (!this._sampleAtDistance(this._currentDist, this._tmpPos, this._tmpTangent)) {
            this._applyHidden();
            this._isVisible = false;
            return;
        }
        // lateral offset
        if (this._lateralOffset !== 0) {
            this._tmpRight.set(-this._tmpTangent.z, 0, this._tmpTangent.x);
            if (this._tmpRight.lengthSq() > 1e-12)
                this._tmpRight.normalize();
            this._tmpPos.x += this._tmpRight.x * this._lateralOffset;
            this._tmpPos.z += this._tmpRight.z * this._lateralOffset;
        }
        // altitude
        this._tmpPos.y += this._altitude + this._altitudeOffset;
        // родитель
        if (this._group.parent !== map.worldGroup) {
            this._group.parent?.remove(this._group);
            map.worldGroup.add(this._group);
        }
        this._group.position.copy(this._tmpPos);
        if (this._alignToPath)
            this._orientToTangent(this._tmpTangent);
        // масштаб
        this._applySize(map, this._group.position);
        this._group.visible = true;
        this._isVisible = true;
        // позиция для подписи
        this._updateScreenPos(map);
    }
    _advanceMovement(dt) {
        this._elapsed += dt;
        const dur = this._duration;
        if (dur <= 0) {
            this._playing = false;
            return;
        }
        let phase = this._elapsed / dur;
        if (phase >= 1)
            phase = 1;
        // при speed — easing принудительно linear
        const eased = this._applyEasingLocal(this._easing, phase);
        // направление учитывается через sign(_toDist - _fromDist)
        const from = this._fromDist;
        const to = this._toDist;
        const newDist = from + (to - from) * eased;
        // мгновенная скорость
        const dd = newDist - this._lastDist;
        this._lastInstantSpeed = dt > 0 ? Math.abs(dd) / dt : 0;
        this._currentDist = newDist;
        this._lastDist = newDist;
        // события
        if (this._onProgress) {
            try {
                this._onProgress(this.getProgress());
            }
            catch (e) {
                console.error(e);
            }
        }
        if (phase >= 1) {
            // завершение прохода
            if (this._onComplete)
                try {
                    this._onComplete();
                }
                catch (e) {
                    console.error(e);
                }
            if (this._loop === 'restart') {
                this._elapsed = 0;
                this._currentDist = this._fromDist;
                this._lastDist = this._currentDist;
                this._lastInstantSpeed = 0;
                if (this._onLoop)
                    try {
                        this._onLoop();
                    }
                    catch (e) {
                        console.error(e);
                    }
            }
            else if (this._loop === 'pingpong') {
                const tmp = this._fromDist;
                this._fromDist = this._toDist;
                this._toDist = tmp;
                this._elapsed = 0;
                this._direction = this._direction === 1 ? -1 : 1;
                if (this._onLoop)
                    try {
                        this._onLoop();
                    }
                    catch (e) {
                        console.error(e);
                    }
            }
            else {
                this._playing = false;
            }
        }
    }
    _orientToTangent(t) {
        const axis = this._forwardAxis === 'x'
            ? new THREE.Vector3(1, 0, 0)
            : this._forwardAxis === 'z'
                ? new THREE.Vector3(0, 0, 1)
                : this._upY;
        this._tmpQuat.setFromUnitVectors(axis, t);
        this._group.quaternion.copy(this._tmpQuat);
    }
    _applySize(map, worldPos) {
        let pxFactor = 1;
        let dist = 1;
        let worldPerPx = 1;
        if (this._sizeMode === 'px') {
            const wgPos = map.worldGroup.position;
            dist = map.camera.position.distanceTo(map.getVec3().set(worldPos.x + wgPos.x, worldPos.y + wgPos.y, worldPos.z + wgPos.z));
            const canvas = map.renderer.domElement;
            const fovRad = (map.camera.fov * Math.PI) / 180;
            const hPx = Math.max(1, canvas.clientHeight);
            worldPerPx = (2 * dist * Math.tan(fovRad / 2)) / hPx;
            pxFactor = this._size * worldPerPx;
        }
        const finalScale = this._sizeMode === 'world' ? this._size : pxFactor;
        if (this._visualSetSize) {
            try {
                this._visualSetSize(this._size, this._sizeMode, {
                    distanceToCamera: dist,
                    worldPerPixel: worldPerPx,
                });
            }
            catch (e) {
                console.error(e);
            }
        }
        else if (this._visualRoot) {
            // универсальный fallback: uniform scale через bbox в px-режиме,
            // прямое присвоение scale в world-режиме.
            if (this._sizeMode === 'world') {
                this._visualRoot.scale.setScalar(finalScale * this._scale);
            }
            else {
                const bb = this._visualBBox;
                const maxDim = bb ? Math.max(bb.size.x, bb.size.y, bb.size.z) : 1;
                const s = maxDim > 1e-6 ? (finalScale / maxDim) * this._scale : this._scale;
                this._visualRoot.scale.setScalar(s);
            }
        }
    }
    _updateScreenPos(map) {
        const wgPos = map.worldGroup.position;
        const v = map.getVec3().set(this._tmpPos.x + wgPos.x, this._tmpPos.y + wgPos.y, this._tmpPos.z + wgPos.z);
        this._tmpWorld.copy(v);
        v.project(map.camera);
        if (v.z > 1) {
            this._screenPos = null;
            return;
        }
        const canvas = map.renderer.domElement;
        this._screenPos = {
            x: (v.x * 0.5 + 0.5) * canvas.clientWidth,
            y: (-v.y * 0.5 + 0.5) * canvas.clientHeight,
        };
    }
    // =================================================================
    // Интерпретация спецификаций
    // =================================================================
    _resolveDistanceSpec(spec) {
        this._ensurePathData();
        if (typeof spec === 'number')
            return spec * this._cachedTotal;
        if (spec.fraction != null)
            return spec.fraction * this._cachedTotal;
        if (spec.meters != null)
            return spec.meters;
        return 0;
    }
    _resolveSpeed(spec) {
        if (spec == null)
            return null;
        if (typeof spec === 'number')
            return spec;
        if (spec.mps != null)
            return spec.mps;
        if (spec.kmh != null)
            return spec.kmh / 3.6;
        return null;
    }
    _applyMoveSpec(spec, autoPlay) {
        this._ensurePathData();
        const fromDist = spec.from != null
            ? this._resolveDistanceSpec(spec.from)
            : this._currentDist;
        const toDist = this._resolveDistanceSpec(spec.to);
        let duration = spec.duration;
        let easing = spec.easing ?? 'linear';
        if (duration == null) {
            const v = this._resolveSpeed(spec.speed) ?? 1;
            const dist = Math.abs(toDist - fromDist);
            duration = v > 0 ? dist / v : 0;
            easing = 'linear'; // при speed easing не имеет смысла
        }
        this._fromDist = fromDist;
        this._toDist = toDist;
        this._currentDist = fromDist;
        this._lastDist = fromDist;
        this._duration = Math.max(0, duration);
        this._elapsed = 0;
        this._easing = easing;
        this._loop = spec.loop ?? this._loop;
        this._onProgress = spec.onProgress ?? null;
        this._onComplete = spec.onComplete ?? null;
        this._onLoop = spec.onLoop ?? null;
        this._direction = toDist >= fromDist ? 1 : -1;
        if (autoPlay) {
            this._playing = this._duration > 0;
            this._paused = false;
        }
    }
    _applyEasingLocal(easing, phase) {
        switch (easing) {
            case 'linear': return phase;
            case 'easeIn': return phase * phase;
            case 'easeOut': return 1 - (1 - phase) * (1 - phase);
            case 'easeInOut':
                return phase < 0.5
                    ? 2 * phase * phase
                    : 1 - 2 * (1 - phase) * (1 - phase);
            case 'sine':
            default:
                return 0.5 - 0.5 * Math.cos(phase * Math.PI * 2);
        }
    }
    // =================================================================
    // Интерактив
    // =================================================================
    _registerInteraction(map) {
        if (!map.interaction)
            return;
        this._unregisterInteraction?.();
        this._unregisterInteraction = null;
        if (!this._onClick && !this._onHover && !this._tooltipText)
            return;
        this._unregisterInteraction = map.interaction.register(this, {
            getMeshes: () => {
                const out = [];
                this._visualRoot?.traverse?.((n) => {
                    if (n.isMesh && n.visible)
                        out.push(n);
                });
                return out;
            },
            getBoundingSphere: () => {
                if (!this._screenPos)
                    return null;
                const wg = map.worldGroup.position;
                const center = map.getVec3().set(this._tmpPos.x + wg.x, this._tmpPos.y + wg.y, this._tmpPos.z + wg.z);
                const bb = this._visualBBox;
                const r = bb ? Math.max(bb.size.x, bb.size.y, bb.size.z) * 0.5 : this._size;
                return { center, radius: r };
            },
            onClick: this._onClick || null,
            onHover: this._onHover || null,
            getTooltip: this._tooltipText ? () => this._tooltipText : null,
            isVisible: () => this._isVisible,
        });
    }
    // =================================================================
    // Debug
    // =================================================================
    debugDump() {
        const g = this.getProgress();
        console.groupCollapsed(`%c[PathFollower] "${this._title || 'unit'}" ` +
            `d=${g.distance.toFixed(1)}/${this._cachedTotal.toFixed(1)}m ` +
            `t=${g.fraction.toFixed(3)} v=${g.speed.toFixed(2)}m/s`, 'color:#f90;font-weight:bold');
        console.log('progress', g);
        console.log('path', {
            points: this._cachedPoints.length,
            total: this._cachedTotal,
            valid: this._pathValid,
        });
        console.log('state', {
            playing: this._playing, paused: this._paused,
            loop: this._loop, easing: this._easing,
            from: this._fromDist, to: this._toDist,
            duration: this._duration, elapsed: this._elapsed,
        });
        console.log('visual', {
            hasRoot: !!this._visualRoot,
            size: this._size, sizeMode: this._sizeMode,
            scale: this._scale, alignToPath: this._alignToPath,
        });
        console.groupEnd();
    }
}
// =====================================================================
// Хелперы для типовых визуалов
// =====================================================================
/**
 * Готовый FollowerVisual на примитиве (box/sphere/cylinder/cone).
 *
 * Меш строится в размере `baseSize` (по умолчанию 1×1×1), а `setSize`
 * затем приводит его к `size` в px или world — единообразно с тем,
 * как это делает сам PathFollower в фолбэке.
 */
export function createPrimitiveVisual(opts = {}) {
    const mesh = createPrimitiveMesh({
        primitiveType: opts.primitiveType ?? 'cone',
        size: opts.baseSize ?? 1,
        color: opts.color ?? '#ff6600',
        depthTest: opts.depthTest ?? false,
        depthWrite: opts.depthWrite ?? false,
        anchor: [0.5, 0, 0.5], // bottom-center: стабильная точка привязки
    });
    if (opts.opacity != null && opts.opacity < 1) {
        const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
        for (const m of mats) {
            m.transparent = true;
            m.opacity = opts.opacity;
        }
    }
    return {
        object: mesh,
        setSize(size, mode, ctx) {
            const s = mode === 'px' ? size * ctx.worldPerPixel : size;
            mesh.scale.setScalar(s);
        },
        dispose() {
            mesh.geometry.dispose();
            const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
            for (const m of mats)
                m.dispose();
        },
    };
}
