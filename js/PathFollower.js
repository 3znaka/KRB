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
import { Projections } from './Projections.js';
// =====================================================================
// PathFollower
// =====================================================================
const _EPS = 1e-9;
export class PathFollower extends SpatialObject {
    // ── путь ──
    _path;
    /** Исходный источник (Vector3D / Polyline / Polygon / PathAdapter). */
    _pathSource;
    /** Для Polyline/Polygon: ключ сигнатуры, по которому понимаем, что точки устарели. */
    _pathSig = '';
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
    _tmpQuat2 = new THREE.Quaternion();
    _tmpUp = new THREE.Vector3(0, 1, 0);
    _tmpBasisF = new THREE.Vector3();
    _tmpBasisUp = new THREE.Vector3();
    _upY = new THREE.Vector3(0, 1, 0);
    _axisX = new THREE.Vector3(1, 0, 0);
    _axisZ = new THREE.Vector3(0, 0, 1);
    constructor(o) {
        super();
        if (!o?.path)
            throw new Error('PathFollower: options.path is required');
        this._pathSource = o.path;
        this._path = resolveAdapter(o.path);
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
        this._bindAdapter(this._path);
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
        if (this._path instanceof LivePathAdapter)
            this._path.detach();
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
    /** Подписка на перестройку/удаление адаптера пути. */
    _bindAdapter(adapter) {
        this._unsubRebuild?.();
        this._unsubDestroy?.();
        // Live-адаптер (Polyline/Polygon) нужно знать карту, чтобы строить точки.
        if (this._map && adapter instanceof LivePathAdapter)
            adapter.attach(this._map);
        this._unsubRebuild = adapter.onPathRebuild(() => { this._pathValid = false; });
        this._unsubDestroy = adapter.onPathDestroy(() => this.remove());
    }
    _ensurePathData() {
        // Polyline/Polygon: точки зависят от карты и зума — проверяем сигнатуру.
        const sig = this._path.getPathSignature?.() ?? '';
        if (sig !== this._pathSig) {
            this._pathSig = sig;
            this._pathValid = false;
        }
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
        if (newPath === this._pathSource)
            return this;
        this._unsubRebuild?.();
        this._unsubDestroy?.();
        this._unsubRebuild = null;
        this._unsubDestroy = null;
        this._pathSource = newPath;
        this._path = resolveAdapter(newPath);
        if (this._map)
            this._bindAdapter(this._path);
        this._pathValid = false;
        this._pathSig = '';
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
        const globe = !!(map.globe && map.surface);
        // Глобус: «вверх» объекта — местная нормаль эллипсоида в точке пути.
        // Плоскость: нормаль — мировая Y.
        if (globe) {
            this._sampleNormal(map, this._tmpPos, this._tmpUp);
        }
        else {
            this._tmpUp.set(0, 1, 0);
        }
        // lateral offset: вбок в касательной плоскости (перпендикуляр к
        // касательной и к нормали). На плоскости нормаль = Y → прежняя формула.
        if (this._lateralOffset !== 0) {
            this._tmpRight.crossVectors(this._tmpTangent, this._tmpUp);
            if (this._tmpRight.lengthSq() > 1e-12)
                this._tmpRight.normalize();
            this._tmpPos.addScaledVector(this._tmpRight, this._lateralOffset);
        }
        // altitude: вдоль нормали (на глобусе — «вверх» от поверхности,
        // на плоскости — по Y, как раньше).
        // Высота — истинные метры: масштаб по широте центра пути (нормаль на плоскости = Y).
        const kPath = this._path instanceof LivePathAdapter ? this._path.pathScaleLat() : 1;
        const lift = (this._altitude + this._altitudeOffset) * kPath;
        if (lift !== 0)
            this._tmpPos.addScaledVector(this._tmpUp, lift);
        // родитель
        if (this._group.parent !== map.worldGroup) {
            this._group.parent?.remove(this._group);
            map.worldGroup.add(this._group);
        }
        this._group.position.copy(this._tmpPos);
        if (this._alignToPath)
            this._orientToTangent(this._tmpTangent, this._tmpUp);
        else if (globe)
            this._orientToNormal(this._tmpUp);
        // масштаб
        this._applySize(map, this._group.position);
        // Глобус: за горизонтом — скрываем (как Vector3D/Marker).
        if (globe && typeof map.isWorldPointOccluded === 'function') {
            const wgPos = map.worldGroup.position;
            const tmp = map.getVec3().set(this._tmpPos.x + wgPos.x, this._tmpPos.y + wgPos.y, this._tmpPos.z + wgPos.z);
            if (map.isWorldPointOccluded(tmp)) {
                this._applyHidden();
                this._isVisible = false;
                return;
            }
        }
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
    /**
     * Ориентация по касательной. На плоскости — прежнее поведение
     * (setFromUnitVectors по касательной). На глобусе — базис
     * (forward = касательная, up = нормаль), чтобы модель «стояла» на сфере.
     */
    _orientToTangent(t, up) {
        const axis = this._forwardAxis === 'x'
            ? this._axisX
            : this._forwardAxis === 'z'
                ? this._axisZ
                : this._upY;
        // Плоскость (нормаль = Y): прежнее поведение — поворот от оси к касательной.
        if (!up || this._isFlatUp(up)) {
            this._tmpQuat.setFromUnitVectors(axis, t);
            this._group.quaternion.copy(this._tmpQuat);
            return;
        }
        // Глобус: ось модели (axis) ставим на касательную — как на плоскости, вершина идёт
        // вдоль пути. Затем доворачиваем вокруг касательной, чтобы верх модели (Y) был ближе
        // всего к нормали эллипсоида (крен). Порядок «Y → нормаль первым» при axis = Y
        // стирал касательную: вершина всегда вставала по нормали.
        // 1) ось модели → касательная (как на плоскости).
        this._tmpQuat.setFromUnitVectors(axis, t);
        // 2) куда теперь смотрит модельный Y.
        this._tmpBasisF.copy(this._upY).applyQuaternion(this._tmpQuat);
        // 3) нормаль, спроецированная в плоскость, перпендикулярную касательной.
        const upProj = this._tmpBasisUp.copy(up);
        upProj.addScaledVector(t, -upProj.dot(t));
        if (upProj.lengthSq() < 1e-12) {
            this._group.quaternion.copy(this._tmpQuat);
            return;
        }
        upProj.normalize();
        // 4) модельный Y, спроецированный в плоскость ⟂ касательной.
        this._tmpBasisF.addScaledVector(t, -this._tmpBasisF.dot(t));
        if (this._tmpBasisF.lengthSq() < 1e-12) {
            this._group.quaternion.copy(this._tmpQuat);
            return;
        }
        this._tmpBasisF.normalize();
        // 5) доворот вокруг касательной: модельный Y → нормаль (проекция).
        this._tmpQuat2.setFromUnitVectors(this._tmpBasisF, upProj);
        this._tmpQuat2.multiply(this._tmpQuat);
        this._group.quaternion.copy(this._tmpQuat2);
    }
    /** Только нормаль по глобусу (без касательной) — для alignToPath=false. */
    _orientToNormal(up) {
        this._tmpQuat.setFromUnitVectors(this._upY, up);
        this._group.quaternion.copy(this._tmpQuat);
    }
    _isFlatUp(up) {
        return Math.abs(up.x) < 1e-9 && Math.abs(up.z) < 1e-9 && Math.abs(up.y - 1) < 1e-9;
    }
    /**
     * Местная нормаль эллипсоида в точке `worldPos` (локальные координаты
     * worldGroup). Нормаль берётся по геодезическим lon/lat точки пути.
     */
    _sampleNormal(map, localPos, out) {
        // localPos — в системе worldGroup. Переводим в мир через матрицу группы
        // (поворот + сдвиг), а не простым сложением: у повёрнутого глобуса сложение
        // даёт неверную точку и неверную нормаль под конусом.
        const worldPt = map.getVec3().copy(localPos);
        if (map.worldGroup)
            map.worldGroup.localToWorld(worldPt);
        const g = map.surfacePointToLonLat?.(worldPt);
        if (!g || !Number.isFinite(g[0]) || !Number.isFinite(g[1])) {
            out.set(0, 1, 0);
            return;
        }
        const n = map.getVec3().set(0, 0, 0);
        map.surface.normal(g[0], g[1], n);
        if (map.worldGroup)
            n.transformDirection(map.worldGroup.matrixWorld);
        out.copy(n.normalize());
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
// Адаптеры пути: Vector3D / Polyline / Polygon → PathAdapter
// =====================================================================
/**
 * Превращает источник пути в PathAdapter.
 *  - Vector3D и любой уже готовый PathAdapter (есть getPathPoints) — как есть;
 *  - Polyline — точки по её позициям (getPositions) на поверхности карты;
 *  - Polygon — ВНЕШНЕЕ кольцо (getRings()[0]), замкнутое в цикл.
 *
 * Точки строятся в координатах worldGroup, как у Vector3D, поэтому
 * PathFollower использует их без изменений. Для Polyline/Polygon точки
 * пересчитываются при привязке к карте (см. LiveRingAdapter.getPathPoints).
 */
function resolveAdapter(src) {
    const s = src;
    if (s && typeof s.getPathPoints === 'function' && typeof s.onPathRebuild === 'function') {
        return s;
    }
    if (s && typeof s.getRings === 'function') {
        return new LivePathAdapter(s, /*ring*/ true);
    }
    if (s && typeof s.getPositions === 'function') {
        return new LivePathAdapter(s, /*ring*/ false);
    }
    throw new Error('PathFollower: unsupported path source');
}
/**
 * Адаптер Polyline/Polygon. Точки берутся из публичных данных источника и
 * переводятся на поверхность текущей карты (тот же контракт, что Vector3D).
 */
class LivePathAdapter {
    _src;
    _isRing;
    _rebuildListeners = new Set();
    _destroyListeners = new Set();
    _points = [];
    _sig = '';
    _lastTimeBucket = -1;
    constructor(src, isRing) {
        this._src = src;
        this._isRing = isRing;
    }
    /** Список lon/lat исходных точек пути (замкнут для полигона). */
    _lonLats() {
        const crs = this._src.getCRS?.() ?? null;
        const raw = this._isRing
            ? (this._src.getRings()[0] ?? [])
            : (this._src.getPositions() ?? []);
        const out = [];
        for (const p of raw) {
            if (!Array.isArray(p) || p.length < 2)
                continue;
            const ll = crs && Projections.get(crs)
                ? Projections.get(crs).toLonLat([p[0], p[1]])
                : [p[0], p[1]];
            if (!ll || !Number.isFinite(ll[0]) || !Number.isFinite(ll[1]))
                continue;
            out.push([ll[0], ll[1]]);
        }
        // Полигон — замыкаем кольцо, чтобы движение шло по кругу.
        if (this._isRing && out.length > 2) {
            const a = out[0], b = out[out.length - 1];
            if (a[0] !== b[0] || a[1] !== b[1])
                out.push([a[0], a[1]]);
        }
        return out;
    }
    /** Масштаб высоты по центру пути (среднее lon/lat вершин), кешируется до смены пути. */
    _pathScaleCache = null;
    /** Единый масштаб высоты (как SpatialObject._verticalScale): 1/cos(lat) на Меркаторе, 1 на глобусе. */
    _vScale(lonLat) {
        const map = this._attachedMap;
        if (!map || map.globe)
            return 1;
        if (!lonLat || !Number.isFinite(lonLat[1]))
            return 1;
        return map._planarHeightScale(lonLat, 'EPSG:4326');
    }
    pathScaleLat() {
        const sig = this._sig;
        if (this._pathScaleCache && this._pathScaleCache.sig === sig)
            return this._pathScaleCache.k;
        const lls = this._lonLats();
        let sx = 0, sy = 0;
        for (const ll of lls) {
            sx += ll[0];
            sy += ll[1];
        }
        const c = lls.length ? [sx / lls.length, sy / lls.length] : null;
        const k = this._vScale(c);
        this._pathScaleCache = { sig, k };
        return k;
    }
    /** Карта, к которой привязан PathFollower (задаётся через attach). */
    _attachedMap = null;
    attach(map) { this._attachedMap = map; this._sig = ''; this._points = []; }
    detach() { this._attachedMap = null; this._points = []; this._sig = ''; }
    _map() { return this._attachedMap; }
    getPathSignature() {
        const map = this._map();
        if (!map)
            return '';
        // Для clampToGround рельеф меняется — обновляем точки раз в ~0.5 с.
        const clamp = this._src.getAltitudeMode?.() === 'clampToGround';
        const bucket = clamp ? Math.floor(performance.now() / 500) : 0;
        return `${map.globe ? 'g' : 'p'}|${bucket}|${this._src.getPositions?.().length ?? ''}`;
    }
    getPathPoints() {
        const map = this._map();
        if (!map)
            return [];
        const sig = this.getPathSignature();
        if (sig === this._sig && this._points.length)
            return this._points;
        this._sig = sig;
        const lonLats = this._lonLats();
        const pts = [];
        const v = new THREE.Vector3();
        const wg = map.worldGroup;
        const h = this._src.getAltitude?.() ?? 0;
        for (const ll of lonLats) {
            if (map.globe && map.surface) {
                const p = map.projectSurfaceVertex(ll, 'EPSG:4326', h, null, v);
                if (!p)
                    continue;
                if (wg)
                    wg.worldToLocal(p);
                pts.push([p.x, p.y, p.z]);
            }
            else {
                const xy = map.projectSafe(ll, 'EPSG:4326');
                if (!xy)
                    continue;
                // Высота пути — истинные метры: масштаб по широте вершины.
                pts.push([xy[0], h * this._vScale(ll), xy[1]]);
            }
        }
        this._points = pts;
        this._emitRebuild();
        return pts;
    }
    getPathLength() {
        const p = this.getPathPoints();
        let total = 0;
        for (let i = 1; i < p.length; i++) {
            const dx = p[i][0] - p[i - 1][0], dy = p[i][1] - p[i - 1][1], dz = p[i][2] - p[i - 1][2];
            total += Math.sqrt(dx * dx + dy * dy + dz * dz);
        }
        return total;
    }
    samplePathAt(t, outPos, outTangent) {
        const p = this.getPathPoints();
        if (p.length < 2)
            return false;
        const L = this.getPathLength();
        if (L <= 0)
            return false;
        const target = (((t % 1) + 1) % 1) * L;
        let acc = 0;
        for (let i = 1; i < p.length; i++) {
            const a = p[i - 1], b = p[i];
            const dx = b[0] - a[0], dy = b[1] - a[1], dz = b[2] - a[2];
            const seg = Math.sqrt(dx * dx + dy * dy + dz * dz);
            if (acc + seg >= target || i === p.length - 1) {
                const u = seg > 0 ? (target - acc) / seg : 0;
                outPos.set(a[0] + dx * u, a[1] + dy * u, a[2] + dz * u);
                outTangent.set(dx, dy, dz);
                if (outTangent.lengthSq() < 1e-12)
                    outTangent.set(0, 1, 0);
                else
                    outTangent.normalize();
                return true;
            }
            acc += seg;
        }
        return false;
    }
    onPathRebuild(cb) {
        this._rebuildListeners.add(cb);
        return () => this._rebuildListeners.delete(cb);
    }
    onPathDestroy(cb) {
        this._destroyListeners.add(cb);
        return () => this._destroyListeners.delete(cb);
    }
    _emitRebuild() {
        for (const cb of [...this._rebuildListeners]) {
            try {
                cb();
            }
            catch (e) {
                console.error('[PathFollower] rebuild listener threw', e);
            }
        }
    }
    /** Вызывается PathFollower/картой при уничтожении источника. */
    destroy() {
        for (const cb of [...this._destroyListeners]) {
            try {
                cb();
            }
            catch (e) {
                console.error('[PathFollower] destroy listener threw', e);
            }
        }
        this._destroyListeners.clear();
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
