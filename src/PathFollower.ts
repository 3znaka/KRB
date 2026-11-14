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

import { SpatialObject, TitleAlignH, TitleAlignV, ZoomInterpolation } from './SpatialObject.js';
import { THREE } from './js_TP/tpb.js';
import type { Vector3D, Vector3DPosition, Easing } from './Vector3D.js';
import { createPrimitiveMesh } from './Marker3D.js';
import type { PrimitiveType, SizeSpec } from './Marker3D.js';

// =====================================================================
// Типы
// =====================================================================

/** `number` = доля длины 0..1; `{fraction}` = то же явно; `{meters}` = метры от начала. */
export type DistanceSpec = number | { fraction: number } | { meters: number };

/** `number` = м/с; `{mps}` = м/с; `{kmh}` = км/ч. */
export type SpeedSpec = number | { mps: number } | { kmh: number };

export type LoopMode = 'none' | 'restart' | 'pingpong';
export type FollowerAxis = 'x' | 'y' | 'z';
export type SizeMode = 'px' | 'world';

export interface FollowerVisual {
    /** Корневой объект, который будет прикреплён к внутренней группе. */
    object: any;
    /**
     * Опционально: как масштабировать объект под запрошенный размер.
     * Если не задано — PathFollower применит uniform-scale по bbox
     * (в px-режиме) или напрямую выставит scale (в world-режиме).
     */
    setSize?: (size: number, mode: SizeMode, ctx: SizeContext) => void;
    dispose?: () => void;
}

export interface SizeContext {
    /** Дистанция от камеры до объекта (метры). */
    distanceToCamera: number;
    /** Сколько world-метров в одном пикселе на этой дистанции. */
    worldPerPixel: number;
}

export type VisualInput =
    | any // THREE.Object3D
    | FollowerVisual
    | ((follower: PathFollower) =>
        | any
        | FollowerVisual
        | Promise<any | FollowerVisual>);

export interface ProgressInfo {
    /** Текущая дистанция от начала пути (м). */
    distance: number;
    /** t ∈ [0..1]. */
    fraction: number;
    /** Остаток до целевой точки (м). */
    remainingDistance: number;
    /** Оценка времени до цели (сек). */
    remainingTime: number;
    /** Текущая мгновенная скорость (м/с). */
    speed: number;
    isPlaying: boolean;
    isPaused: boolean;
}

export interface MoveSpec {
    /** Начальная позиция. Если не задано — где стоит сейчас. */
    from?: DistanceSpec;
    to: DistanceSpec;
    /** Длительность полного перехода, сек. Приоритетнее `speed`. */
    duration?: number;
    /** Скорость. Альтернатива duration. */
    speed?: SpeedSpec;
    /** Тип кривой. При `speed` принудительно 'linear'. */
    easing?: Easing;
    /** Поведение по завершении. */
    loop?: LoopMode;
    onProgress?: (info: ProgressInfo) => void;
    onComplete?: () => void;
    onLoop?: () => void;
}

export interface PathFollowerOptions {
    path: Vector3D; // PathAdapter; пока принимаем Vector3D напрямую

    visual?: VisualInput;
    /** Размер в px (sizeMode='px') или world-метры (sizeMode='world'). */
    size?: number;
    sizeMode?: SizeMode;
    /** Доп. uniform-scale поверх size. По умолчанию 1. */
    scale?: number;
    /** Ориентировать по касательной (по умолчанию true). */
    alignToPath?: boolean;
    /** Какая локальная ось модели — «вперёд». По умолчанию 'y' (конус/стрелка). */
    forwardAxis?: FollowerAxis;
    /** Смещение по вертикали (world Y), м. */
    altitudeOffset?: number;
    /** Смещение вбок (перпендикуляр к касательной в гориз. плоскости), м. */
    lateralOffset?: number;

    // ── стартовое движение ──
    animation?: MoveSpec | null;
    autoPlay?: boolean;

    // ── SpatialObject ──
    minZoom?: number;
    maxZoom?: number;
    tooltip?: string;
    onClick?: (event: MouseEvent, follower: PathFollower) => void;
    onHover?: (hovered: boolean) => void;
    title?: string;
    titleStyle?: Record<string, string | number>;
    titleAlign?: TitleAlignH;
    titleVerticalAlign?: TitleAlignV;
    titleOffset?: [number, number];
    titleMinZoom?: number;
    titleMaxZoom?: number;
    titleAllowOverflow?: boolean;
    titlePriority?: number;
    properties?: Record<string, any>;
    userData?: Record<string, any>;
    zoomInterpolate?: ZoomInterpolation | null;
}

// =====================================================================
// PathFollower
// =====================================================================

const _EPS = 1e-9;

export class PathFollower extends SpatialObject {
    // ── путь ──
    private _path: Vector3D;
    private _unsubRebuild: (() => void) | null = null;
    private _unsubDestroy: (() => void) | null = null;
    private _cachedPoints: ReadonlyArray<Vector3DPosition> = [];
    private _cachedLengths: number[] = [0];
    private _cachedTotal = 0;
    private _pathValid = false;

    // ── визуал ──
    private _group: any;
    private _visualRoot: any | null = null;
    private _visualDispose: (() => void) | null = null;
    private _visualSetSize: ((s: number, m: SizeMode, ctx: SizeContext) => void) | null = null;
    private _visualToken = 0;
    private _visualBBox: any | null = null;
    private _visualInput: VisualInput | null = null;

    // ── sizing ──
    private _size: number;
    private _sizeMode: SizeMode;
    private _scale: number;
    private _alignToPath: boolean;
    private _forwardAxis: FollowerAxis;
    private _altitudeOffset: number;
    private _lateralOffset: number;

    // ── движение ──
    private _fromDist = 0;
    private _toDist = 0;
    private _currentDist = 0;
    private _duration = 0;
    private _elapsed = 0;
    private _playing = false;
    private _paused = false;
    private _loop: LoopMode = 'none';
    private _easing: Easing = 'linear';
    private _direction: 1 | -1 = 1;
    private _onProgress: ((info: ProgressInfo) => void) | null = null;
    private _onComplete: (() => void) | null = null;
    private _onLoop: (() => void) | null = null;

    // ── перф / расчёты ──
    private _lastUpdateTime = 0;
    private _lastInstantSpeed = 0;
    private _lastDist = 0;
    private _lastScreenPosDirty = true;
    private _screenPos: { x: number; y: number } | null = null;

    // ── интерактив ──
    private _unregisterInteraction: (() => void) | null = null;

    // ── заголовок (свой vertical align) ──
    private _titleVerticalAlign: TitleAlignV = 'bottom';

    // ── временное ──
    private _tmpPos = new THREE.Vector3();
    private _tmpTangent = new THREE.Vector3();
    private _tmpWorld = new THREE.Vector3();
    private _tmpRight = new THREE.Vector3();
    private _tmpMtx = new THREE.Matrix4();
    private _tmpQuat = new THREE.Quaternion();
    private _upY = new THREE.Vector3(0, 1, 0);

    constructor(o: PathFollowerOptions) {
        super();
        if (!o?.path) throw new Error('PathFollower: options.path is required');
        this._path = o.path;

        this._minZoom = o.minZoom ?? -Infinity;
        this._maxZoom = o.maxZoom ?? Infinity;
        this._properties = o.properties ?? {};
        this._userData = o.userData ?? {};
        this._tooltipText = o.tooltip ?? '';
        this._onClick = (o.onClick as any) ?? null;
        this._onHover = o.onHover ?? null;

        this._size = o.size ?? 20;
        this._sizeMode = o.sizeMode === 'world' ? 'world' : 'px';
        this._scale = o.scale ?? 1;
        this._alignToPath = o.alignToPath ?? true;
        this._forwardAxis = o.forwardAxis ?? 'y';
        this._altitudeOffset = o.altitudeOffset ?? 0;
        this._lateralOffset = o.lateralOffset ?? 0;

        if (o.zoomInterpolate) this.setZoomInterpolations(o.zoomInterpolate);

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

        if (o.visual) this.setVisual(o.visual);

        if (o.animation) this._applyMoveSpec(o.animation, o.autoPlay ?? true);
    }

    // =================================================================
    // SpatialObject hooks
    // =================================================================


protected _onAttached(map: any): void {
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

    protected _teardown(): void {
        this._unsubRebuild?.(); this._unsubRebuild = null;
        this._unsubDestroy?.(); this._unsubDestroy = null;

        this._unregisterInteraction?.(); this._unregisterInteraction = null;

        if (this._map?.textManager && this._textLabel) {
            this._map.textManager.removeLabel(this._textLabel);
        }
        this._textLabel = null;

        if (this._group.parent) this._group.parent.remove(this._group);

        this._disposeVisual();
        this._pathValid = false;
        this._cachedPoints = [];
        this._cachedLengths = [0];
        this._cachedTotal = 0;
        this._screenPos = null;
    }

    protected _applyHidden(): void {
        this._group.visible = false;
    }

    protected _onTooltipChanged(): void {
        if (this._map) this._registerInteraction(this._map);
    }

    protected _onAltitudeChanged(): void {
        // высота добавляется на кадре
    }

    getLabelType(): 'point' { return 'point'; }

    override getTitleVerticalAlign(): TitleAlignV { return this._titleVerticalAlign; }

    override getScreenPosition(): { x: number; y: number } | null {
        return this._screenPos;
    }

    override setTitle(text: string): this {
        super.setTitle(text);
        if (this._map?.textManager && !this._textLabel && this._title) {
            this._textLabel = this._map.textManager.addLabel(this);
        }
        return this;
    }

    // =================================================================
    // PathAdapter — внутренняя копия
    // =================================================================

    private _ensurePathData(): boolean {
        if (this._pathValid) return this._cachedTotal > 0;

        const pts = this._path.getPathPoints();
        this._cachedPoints = pts;
        const n = pts.length;
        if (n < 2) {
            this._cachedLengths = [0];
            this._cachedTotal = 0;
            this._pathValid = true;
            return false;
        }
        const lengths = new Array<number>(n);
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
    private _sampleAtDistance(d: number, outPos: any, outTangent: any): boolean {
        const L = this._cachedTotal;
        if (L <= _EPS) return false;
        const cl = Math.max(0, Math.min(L, d));
        const lengths = this._cachedLengths;
        const pts = this._cachedPoints;

        // binary search сегмента
        let lo = 1, hi = lengths.length - 1;
        while (lo < hi) {
            const mid = (lo + hi) >> 1;
            if (lengths[mid] < cl) lo = mid + 1; else hi = mid;
        }
        const i = lo;
        const segStart = lengths[i - 1];
        const segLen = lengths[i] - segStart;
        const u = segLen > _EPS ? (cl - segStart) / segLen : 0;
        const p0 = pts[i - 1], p1 = pts[i];

        outPos.set(
            p0[0] + (p1[0] - p0[0]) * u,
            p0[1] + (p1[1] - p0[1]) * u,
            p0[2] + (p1[2] - p0[2]) * u
        );
        outTangent.set(p1[0] - p0[0], p1[1] - p0[1], p1[2] - p0[2]);
        if (outTangent.lengthSq() < 1e-12) outTangent.set(0, 1, 0);
        else outTangent.normalize();
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
    moveTo(spec: MoveSpec): this {
        this._ensurePathData();
        this._applyMoveSpec(spec, true);
        return this;
    }

    play(): this {
        if (!this._playing) return this;
        this._paused = false;
        return this;
    }

    pause(): this {
        this._paused = true;
        return this;
    }

    /** Остановить и вернуть в начальную точку последнего moveTo. */
    stop(): this {
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
    seek(target: DistanceSpec): this {
        this._ensurePathData();
        const d = this._resolveDistanceSpec(target);
        this._currentDist = Math.max(0, Math.min(this._cachedTotal, d));
        this._lastDist = this._currentDist;
        return this;
    }

   /** Изменить скорость «на лету», сохранив текущую позицию. */
setSpeed(speed: SpeedSpec): this {
    const v = this._resolveSpeed(speed) ?? 1;
    if (!(v > 0)) return this;
    const remaining = Math.abs(this._toDist - this._currentDist);
    this._duration = remaining / v;
    this._elapsed = 0;
    this._easing = 'linear';
    this._fromDist = this._currentDist;
    this._direction = this._toDist >= this._currentDist ? 1 : -1;
    return this;
}

    getProgress(): ProgressInfo {
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

    getCurrentPosition(): any | null {
        if (!this._ensurePathData()) return null;
        return this._tmpWorld.clone();
    }

    getCurrentTangent(): any | null {
        if (!this._ensurePathData()) return null;
        return this._tmpTangent.clone();
    }

    getTotalPathLength(): number { this._ensurePathData(); return this._cachedTotal; }
    getCurrentDistance(): number { return this._currentDist; }

    isPlaying(): boolean { return this._playing && !this._paused; }
    isPaused(): boolean { return this._playing && this._paused; }

    setLoop(mode: LoopMode): this { this._loop = mode; return this; }
    setEasing(e: Easing): this { this._easing = e; return this; }

    // =================================================================
    // Визуал
    // =================================================================

 setVisual(visual: VisualInput): this {
    this._visualInput = visual;
    this._disposeVisual();
    this._visualToken++;
    const token = this._visualToken;

        const attach = (v: any | FollowerVisual): void => {
            if (token !== this._visualToken) {
                // Устаревший async-резолв.
                try { (v as FollowerVisual)?.dispose?.(); } catch {}
                try {
                    if ((v as any)?.object) (v as any).object.removeFromParent();
                    else (v as any)?.removeFromParent?.();
                } catch {}
                return;
            }
            if (!v) return;
            if ((v as FollowerVisual).object) {
                const fv = v as FollowerVisual;
                this._visualRoot = fv.object;
                this._visualDispose = fv.dispose ?? null;
                this._visualSetSize = fv.setSize ?? null;
            } else {
                this._visualRoot = v as any;
                this._visualDispose = null;
                this._visualSetSize = null;
            }
            this._group.add(this._visualRoot);
            this._visualBBox = this._computeBBox(this._visualRoot);
        };

        if (typeof visual === 'function') {
            try {
                const res = (visual as any)(this);
                if (res && typeof res.then === 'function') {
                    (res as Promise<any>).then(attach).catch(err => {
                        console.error('PathFollower: visual factory rejected', err);
                    });
                } else {
                    attach(res);
                }
            } catch (err) {
                console.error('PathFollower: visual factory threw', err);
            }
        } else {
            attach(visual);
        }
        return this;
    }

    private _disposeVisual(): void {
        if (this._visualRoot) {
            this._visualRoot.removeFromParent?.();
            if (this._visualDispose) {
                try { this._visualDispose(); } catch {}
            }
            this._visualRoot = null;
            this._visualDispose = null;
            this._visualSetSize = null;
            this._visualBBox = null;
        }
    }

    private _computeBBox(root: any): any | null {
        try {
            const box = new THREE.Box3().setFromObject(root);
            if (!box.isEmpty()) {
                const size = new THREE.Vector3();
                box.getSize(size);
                return { size };
            }
        } catch { /* ignore */ }
        return null;
    }

    setSize(size: number, mode: SizeMode = this._sizeMode): this {
        if (!(size > 0)) return this;
        this._size = size;
        this._sizeMode = mode;
        return this;
    }
    setAlignToPath(align: boolean): this { this._alignToPath = !!align; return this; }
    setLateralOffset(off: number): this { this._lateralOffset = off; return this; }
    setAltitudeOffset(off: number): this { this._altitudeOffset = off; return this; }

    // =================================================================
    // Переназначение пути
    // =================================================================

    setPath(newPath: Vector3D): this {
        if (newPath === this._path) return this;
        this._unsubRebuild?.(); this._unsubDestroy?.();
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

    _update(map: any, deltaTime?: number): void {
        if (!this._map) return;

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
        if (deltaTime > 0.1) deltaTime = 0.1;
        this._lastUpdateTime = performance.now();

        // ── движение ──
        if (this._playing && !this._paused) this._advanceMovement(deltaTime);

        // ── сэмпл и трансформ ──
        if (!this._sampleAtDistance(this._currentDist, this._tmpPos, this._tmpTangent)) {
            this._applyHidden();
            this._isVisible = false;
            return;
        }

        // lateral offset
        if (this._lateralOffset !== 0) {
            this._tmpRight.set(-this._tmpTangent.z, 0, this._tmpTangent.x);
            if (this._tmpRight.lengthSq() > 1e-12) this._tmpRight.normalize();
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
        if (this._alignToPath) this._orientToTangent(this._tmpTangent);

        // масштаб
        this._applySize(map, this._group.position);

        this._group.visible = true;
        this._isVisible = true;

        // позиция для подписи
        this._updateScreenPos(map);
    }

    private _advanceMovement(dt: number): void {
        this._elapsed += dt;
        const dur = this._duration;
        if (dur <= 0) { this._playing = false; return; }

        let phase = this._elapsed / dur;
        if (phase >= 1) phase = 1;

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
            try { this._onProgress(this.getProgress()); } catch (e) { console.error(e); }
        }

        if (phase >= 1) {
            // завершение прохода
            if (this._onComplete) try { this._onComplete(); } catch (e) { console.error(e); }

            if (this._loop === 'restart') {
                this._elapsed = 0;
                this._currentDist = this._fromDist;
                this._lastDist = this._currentDist;
                this._lastInstantSpeed = 0;
                if (this._onLoop) try { this._onLoop(); } catch (e) { console.error(e); }
            } else if (this._loop === 'pingpong') {
                const tmp = this._fromDist;
                this._fromDist = this._toDist;
                this._toDist = tmp;
                this._elapsed = 0;
               this._direction = this._direction === 1 ? -1 : 1;
                if (this._onLoop) try { this._onLoop(); } catch (e) { console.error(e); }
            } else {
                this._playing = false;
            }
        }
    }

    private _orientToTangent(t: any): void {
        const axis = this._forwardAxis === 'x'
            ? new THREE.Vector3(1, 0, 0)
            : this._forwardAxis === 'z'
                ? new THREE.Vector3(0, 0, 1)
                : this._upY;
        this._tmpQuat.setFromUnitVectors(axis, t);
        this._group.quaternion.copy(this._tmpQuat);
    }

    private _applySize(map: any, worldPos: any): void {
        let pxFactor = 1;
        let dist = 1;
        let worldPerPx = 1;

        if (this._sizeMode === 'px') {
            const wgPos = map.worldGroup.position;
            dist = map.camera.position.distanceTo(
                map.getVec3().set(worldPos.x + wgPos.x, worldPos.y + wgPos.y, worldPos.z + wgPos.z)
            );
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
            } catch (e) { console.error(e); }
        } else if (this._visualRoot) {
            // универсальный fallback: uniform scale через bbox в px-режиме,
            // прямое присвоение scale в world-режиме.
            if (this._sizeMode === 'world') {
                this._visualRoot.scale.setScalar(finalScale * this._scale);
            } else {
                const bb = this._visualBBox;
                const maxDim = bb ? Math.max(bb.size.x, bb.size.y, bb.size.z) : 1;
                const s = maxDim > 1e-6 ? (finalScale / maxDim) * this._scale : this._scale;
                this._visualRoot.scale.setScalar(s);
            }
        }
    }

    private _updateScreenPos(map: any): void {
        const wgPos = map.worldGroup.position;
        const v = map.getVec3().set(
            this._tmpPos.x + wgPos.x,
            this._tmpPos.y + wgPos.y,
            this._tmpPos.z + wgPos.z,
        );
        this._tmpWorld.copy(v);
        v.project(map.camera);
        if (v.z > 1) { this._screenPos = null; return; }
        const canvas = map.renderer.domElement;
        this._screenPos = {
            x: (v.x * 0.5 + 0.5) * canvas.clientWidth,
            y: (-v.y * 0.5 + 0.5) * canvas.clientHeight,
        };
    }

    // =================================================================
    // Интерпретация спецификаций
    // =================================================================

    private _resolveDistanceSpec(spec: DistanceSpec): number {
        this._ensurePathData();
        if (typeof spec === 'number') return spec * this._cachedTotal;
        if ((spec as any).fraction != null) return (spec as any).fraction * this._cachedTotal;
        if ((spec as any).meters != null) return (spec as any).meters;
        return 0;
    }

private _resolveSpeed(spec?: SpeedSpec): number | null {
    if (spec == null) return null;
    if (typeof spec === 'number') return spec;
    if ((spec as any).mps != null) return (spec as any).mps;
    if ((spec as any).kmh != null) return (spec as any).kmh / 3.6;
    return null;
}

    private _applyMoveSpec(spec: MoveSpec, autoPlay: boolean): void {
        this._ensurePathData();

        const fromDist = spec.from != null
            ? this._resolveDistanceSpec(spec.from)
            : this._currentDist;

        const toDist = this._resolveDistanceSpec(spec.to);

        let duration = spec.duration;
        let easing: Easing = spec.easing ?? 'linear';

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

    private _applyEasingLocal(easing: Easing, phase: number): number {
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

    private _registerInteraction(map: any): void {
        if (!map.interaction) return;
        this._unregisterInteraction?.();
        this._unregisterInteraction = null;

        if (!this._onClick && !this._onHover && !this._tooltipText) return;

        this._unregisterInteraction = map.interaction.register(this, {
            getMeshes: () => {
                const out: any[] = [];
                this._visualRoot?.traverse?.((n: any) => {
                    if (n.isMesh && n.visible) out.push(n);
                });
                return out;
            },
            getBoundingSphere: () => {
                if (!this._screenPos) return null;
                const wg = map.worldGroup.position;
                const center = map.getVec3().set(
                    this._tmpPos.x + wg.x, this._tmpPos.y + wg.y, this._tmpPos.z + wg.z,
                );
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

    debugDump(): void {
        const g = this.getProgress();
        console.groupCollapsed(
            `%c[PathFollower] "${this._title || 'unit'}" ` +
            `d=${g.distance.toFixed(1)}/${this._cachedTotal.toFixed(1)}m ` +
            `t=${g.fraction.toFixed(3)} v=${g.speed.toFixed(2)}m/s`,
            'color:#f90;font-weight:bold');
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
export function createPrimitiveVisual(opts: {
    primitiveType?: PrimitiveType;
    /** Пропорции меша. По умолчанию 1×1×1. */
    baseSize?: SizeSpec;
    color?: string | number;
    opacity?: number;
    depthTest?: boolean;
    depthWrite?: boolean;
} = {}): FollowerVisual {
    const mesh = createPrimitiveMesh({
        primitiveType: opts.primitiveType ?? 'cone',
        size: opts.baseSize ?? 1,
        color: opts.color ?? '#ff6600',
        depthTest: opts.depthTest ?? false,
        depthWrite: opts.depthWrite ?? false,
        anchor: [0.5, 0, 0.5],  // bottom-center: стабильная точка привязки
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
            for (const m of mats) m.dispose();
        },
    };
}