/**
 * PopupManager — управление HTML-тултипами на карте.
 *
 * Возможности:
 * - хвостик (SVG-треугольник) с переходником, гасящим субпиксельные щели
 *   между телом тултипа и хвостиком;
 * - авто-выбор позиции (top/bottom/right/left) с учётом вьюпорта;
 * - «плавающий» хвостик при сдвиге тултипа внутрь экрана;
 * - закрытие по клику снаружи (не срабатывает при drag/панорамировании
 *   и мультитач-жестах);
 * - анимация появления (opacity + scale вокруг острия хвостика).
 *
 * @module PopupManager
 */

import { THREE } from './js_TP/tpb.js';
import { Projections } from './Projections.js';

export type LonLat = [number, number];
export type LonLatAlt = [number, number, number];
export type Placement = 'top' | 'bottom' | 'left' | 'right';

export interface PopupPoint {
    lonLat: LonLat | LonLatAlt;
    crs?: string;
    altitude?: number;
}

export interface PopupManagerOptions {
    /** CSS pointer-events тултипа. `'auto'` — содержимое кликабельно. */
    pointerEvents?: 'none' | 'auto';
    /** CSS z-index. По умолчанию 1200. */
    zIndex?: number;
    /** Длина хвостика (px). По умолчанию 10. */
    tailSize?: number;
    /**
     * Высота «переходника» между телом тултипа и хвостиком (px).
     * Переходник — белая заливка, перекрывающая бордер тултипа и
     * субпиксельные щели на стыке. По умолчанию 2.
     */
    tailConnectorSize?: number;
    /** Отступ от края вьюпорта при clamp (px). По умолчанию 8. */
    screenPadding?: number;
    /** Цвет обводки хвостика (должен совпадать с border тултипа). */
    tailColor?: string;
    /** Порядок предпочтения позиций. */
    placementOrder?: Placement[];
    /** Закрывать по клику снаружи. По умолчанию `true`. */
    closeOnClick?: boolean;
    /** Порог drag'а (px), выше которого жест не считается кликом. По умолчанию 5. */
    clickDragThreshold?: number;
    /** Анимация появления (opacity + scale вокруг острия хвостика). По умолчанию `true`. */
    animateOnShow?: boolean;
    /** Длительность анимации появления (мс). По умолчанию 150. */
    animationDuration?: number;
}

export interface PopupAnchor {
    getScreenPosition(): { x: number; y: number } | null;
    /** Необязательный: специальная точка для хвостика (иначе — getScreenPosition). */
    getPopupAnchor?(): { x: number; y: number } | null;
    /** Необязательный хук, вызывается из `hide()`. */
    _onPopupHide?(): void;
}

export interface PopupMapHost {
    targetElement: HTMLElement;
    inputCRS: any;
    worldGroup: { position: { x: number; y: number; z: number } };
    camera: any;
    renderer: { domElement: HTMLCanvasElement };
    project(pt: LonLat, crs: any): number[];

    // ── опциональные: есть в KrbMap (CoreInput / CoreCoordinates) ──
    _raycastToGround?(screenX: number, screenY: number, out: any): any | null;
    unprojectToLonLat?(x: number, z: number): LonLat;
    _getCanvasRect?(): { left: number; top: number; width: number; height: number };
}

// =====================================================================
// PopupManager
// =====================================================================

export class PopupManager {
    private _map: PopupMapHost | null;
    private _activeObject: PopupAnchor | null = null;
    private _animationFrameId: number | null = null;

    private _tooltipElement: HTMLDivElement | null = null;
    private _contentElement: HTMLDivElement | null = null;
    private _tailElement: SVGSVGElement | null = null;

    private _isLoopRunning = false;
    private _nullFrames = 0;

    // Кэши DOM-состояния.
    private _lastHtml: string | null = null;
    private _lastPosKey = '';
    private _lastPlacement: Placement | null = null;
    private _lastTailPosKey = '';

    // Остриё хвостика в ЛОКАЛЬНЫХ координатах тултипа — для анимации появления.
    private _lastTipX = 0;
    private _lastTipY = 0;

    private _pointerEvents: 'none' | 'auto';
    private _zIndex: string;
    private _tailSize: number;
    private _tailConnectorSize: number;
    private _screenPadding: number;
    private _tailColor: string;
    private _placementOrder: Placement[];
    private _closeOnClick: boolean;
    private _clickDragThreshold: number;
    private _animateOnShow: boolean;
    private _animationDuration: number;
    private _currentAnimation: Animation | null = null;

    // Состояние «текущего» pointer-жеста — для различения клика и drag.
    private _onDocPointerDown: ((e: PointerEvent) => void) | null = null;
    private _onDocPointerUp: ((e: PointerEvent) => void) | null = null;
    private _onDocPointerCancel: (() => void) | null = null;

    private _pointerDownX = 0;
    private _pointerDownY = 0;
    private _pointerDownId: number | null = null;
    private _pointerStartedInside = false;
    private _pointerDownActiveObject: PopupAnchor | null = null;
    private _pointerMultiTouch = false;

    constructor(map: PopupMapHost, options: PopupManagerOptions = {}) {
        this._map = map;
        this._pointerEvents = options.pointerEvents ?? 'none';
        this._zIndex = String(options.zIndex ?? 1200);
        this._tailSize = options.tailSize ?? 10;
        this._tailConnectorSize = Math.max(1, options.tailConnectorSize ?? 2);
        this._screenPadding = options.screenPadding ?? 8;
        this._tailColor = options.tailColor ?? '#767676';
        this._placementOrder = options.placementOrder ?? ['top', 'bottom', 'right', 'left'];
        this._closeOnClick = options.closeOnClick ?? true;
        this._clickDragThreshold = options.clickDragThreshold ?? 5;
        this._animateOnShow = options.animateOnShow ?? true;
        this._animationDuration = options.animationDuration ?? 150;

        this._createTooltipElement();
        if (this._closeOnClick) this._bindOutsideClickHandlers();
    }

    // =================================================================
    // Публичное API
    // =================================================================

show(object: PopupAnchor | null | undefined, html: string): void {
    if (!object || !html) { this.hide(); return; }

    // Уведомляем предыдущий объект при замене.
    if (this._activeObject && this._activeObject !== object
        && typeof this._activeObject._onPopupHide === 'function') {
        try { this._activeObject._onPopupHide(); }
        catch (e) { console.warn('[PopupManager] _onPopupHide threw:', e); }
    }

    const wasHidden = this._tooltipElement!.style.visibility !== 'visible';
    const anchorChanged = this._activeObject !== object;   // ← новое

    this._activeObject = object;

    if (this._lastHtml !== html) {
        this._contentElement!.innerHTML = html;
        this._lastHtml = html;
        this._lastPosKey = '';
    }

    const text = this._contentElement!.textContent;
    if (!text || text.trim() === '') { this.hide(); return; }

    this._nullFrames = 0;
    this._updatePosition();
    this._startLoop();

    if (wasHidden || anchorChanged) this._playShowAnimation();
}

    showAt(lonLat: LonLat | LonLatAlt, html: string): void {
        this.showAtPoint({ lonLat }, html);
    }

    showAtPoint(point: PopupPoint, html: string): void {
        this.show(this._makeVirtualAnchor(point), html);
    }

    /**
 * Показать попап в точке клика/тапа (мышь, pointer, touch).
 *
 * Делает raycast по рельефу (или плоскости y=0, если рельефа нет),
 * получает lon/lat + высоту и вызывает showAtPoint(). Дальше попап
 * ведёт себя как обычный showAt — следует за этой точкой на карте
 * при панорамировании/зуме.
 *
 * @example
 *   polygon = new Polygon({
 *       ...,
 *       onClick: (e) => map.popupManager.showAtEvent(e, '<b>Hi</b>'),
 *   });
 */
showAtEvent(
    event: MouseEvent | PointerEvent | Touch,
    html: string,
): void {
    const map = this._map;
    if (!map || !html) { this.hide(); return; }

    const clientX = (event as MouseEvent).clientX;
    const clientY = (event as MouseEvent).clientY;
    if (!Number.isFinite(clientX) || !Number.isFinite(clientY)) {
        this.hide();
        return;
    }

    // ── 1. Основной путь: raycast по рельефу через KrbMap ──
    if (typeof map._raycastToGround === 'function'
        && typeof map.unprojectToLonLat === 'function') {

        // ВАЖНО: _raycastToGround переиспользует _tempMouse/_tempRaycaster
        // самого KrbMap. Вызов безопасен, потому что onClick полигона
        // синхронно отрабатывает после того, как InteractionManager уже
        // сделал свой raycast.
        const out = new THREE.Vector3();
        const hit = map._raycastToGround(clientX, clientY, out);
        if (hit) {
            const wgPos = map.worldGroup.position;
            const localX = out.x - wgPos.x;
            const localZ = out.z - wgPos.z;
            const lonLat = map.unprojectToLonLat(localX, localZ);
            if (lonLat
                && Number.isFinite(lonLat[0])
                && Number.isFinite(lonLat[1])) {
                // out.y — абсолютная высота в world-координатах;
                // вычитаем worldGroup, чтобы получить локальную высоту,
                // ту же, что ждёт _projectLonLatToScreen.
                const alt = out.y - wgPos.y;
                this.showAtPoint(
                    { lonLat: [lonLat[0], lonLat[1], alt] },
                    html,
                );
                return;
            }
        }
    }

    // ── 2. Fallback: пересечение с плоскостью y=0 без рельефа ──
    const world = this._screenToWorldOnGroundPlane(clientX, clientY);
    if (world && typeof map.unprojectToLonLat === 'function') {
        const wgPos = map.worldGroup.position;
        const localX = world.x - wgPos.x;
        const localZ = world.z - wgPos.z;
        const lonLat = map.unprojectToLonLat(localX, localZ);
        if (lonLat
            && Number.isFinite(lonLat[0])
            && Number.isFinite(lonLat[1])) {
            this.showAtPoint({ lonLat: [lonLat[0], lonLat[1], 0] }, html);
            return;
        }
    }

    this.hide();
}


private _screenToWorldOnGroundPlane(
    clientX: number,
    clientY: number,
): { x: number; y: number; z: number } | null {
    const map = this._map;
    if (!map) return null;

    const rect = typeof map._getCanvasRect === 'function'
        ? map._getCanvasRect()
        : map.renderer.domElement.getBoundingClientRect();

    const ndcX = ((clientX - rect.left) / rect.width) * 2 - 1;
    const ndcY = -((clientY - rect.top) / rect.height) * 2 + 1;

    const rc = new THREE.Raycaster();
    rc.setFromCamera(new THREE.Vector2(ndcX, ndcY), map.camera);

    const plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
    const out = new THREE.Vector3();
    if (!rc.ray.intersectPlane(plane, out)) return null;
    return { x: out.x, y: out.y, z: out.z };
}

    hide(): void {
        this._cancelShowAnimation();

        if (this._activeObject && typeof this._activeObject._onPopupHide === 'function') {
            try { this._activeObject._onPopupHide(); }
            catch (e) { console.warn('[PopupManager] _onPopupHide threw:', e); }
        }
        this._activeObject = null;
        this._hide();
        this._stopLoop();
    }

    destroy(): void {
        this._cancelShowAnimation();
        this._stopLoop();

        if (this._onDocPointerDown) {
            document.removeEventListener('pointerdown', this._onDocPointerDown);
            this._onDocPointerDown = null;
        }
        if (this._onDocPointerUp) {
            document.removeEventListener('pointerup', this._onDocPointerUp);
            this._onDocPointerUp = null;
        }
        if (this._onDocPointerCancel) {
            document.removeEventListener('pointercancel', this._onDocPointerCancel);
            this._onDocPointerCancel = null;
        }
        this._resetPointerState();

        if (this._tooltipElement) {
            this._tooltipElement.parentNode?.removeChild(this._tooltipElement);
            this._tooltipElement = null;
        }
        this._contentElement = null;
        this._tailElement = null;
        this._activeObject = null;
        this._map = null;
        this._lastHtml = null;
        this._lastPosKey = '';
        this._lastPlacement = null;
        this._lastTailPosKey = '';
    }

    // =================================================================
    // Внутреннее: DOM
    // =================================================================

    private _createTooltipElement(): void {
        const el = document.createElement('div');
        el.className = 'krb-popup-tooltip';
        Object.assign(el.style, {
            position: 'absolute',
            background: 'white',
            border: `1px solid ${this._tailColor}`,
            borderRadius: '6px',
            boxShadow: '0 2px 6px rgba(0,0,0,0.2)',
            padding: '8px 12px',
            fontSize: '14px',
            pointerEvents: this._pointerEvents,
            display: 'none',
            zIndex: this._zIndex,
            maxWidth: '300px',
            left: '0',
            top: '0',
            transformOrigin: '0 0',
            willChange: 'transform, opacity',
        });

        const content = document.createElement('div');
        content.className = 'krb-popup-content';
        el.appendChild(content);

        const ns = 'http://www.w3.org/2000/svg';
        const tail = document.createElementNS(ns, 'svg') as SVGSVGElement;
        tail.classList.add('krb-popup-tail');
        Object.assign(tail.style, {
            position: 'absolute',
            overflow: 'visible',
            pointerEvents: 'none',
            display: 'block',
        });
        el.appendChild(tail);

        this._map!.targetElement.appendChild(el);
        this._tooltipElement = el;
        this._contentElement = content;
        this._tailElement = tail;
    }

    // =================================================================
    // Внутреннее: анимация появления
    // =================================================================

private _playShowAnimation(): void {
    if (!this._shouldAnimate()) return;
    const el = this._tooltipElement;
    if (!el || el.style.visibility !== 'visible') return;

    const sep = this._lastPosKey.indexOf('|');
    if (sep < 0) return;
    const x = parseFloat(this._lastPosKey.slice(0, sep));
    const y = parseFloat(this._lastPosKey.slice(sep + 1));
    if (!isFinite(x) || !isFinite(y)) return;

    this._cancelShowAnimation();

    el.style.transform = `translate3d(${x}px, ${y}px, 0)`;

    const s0 = 0.9;
    const s1 = 1;
    const tipX = this._lastTipX;
    const tipY = this._lastTipY;
    const x0 = x + tipX * (1 - s0);
    const y0 = y + tipY * (1 - s0);

    try {
        this._currentAnimation = el.animate(
            [
                { transform: `translate3d(${x0}px, ${y0}px, 0) scale(${s0})`, opacity: 0 },
                { transform: `translate3d(${x}px, ${y}px, 0) scale(${s1})`, opacity: 1 },
            ],
            {
                duration: this._animationDuration,
                easing: 'cubic-bezier(0.34, 1.56, 0.64, 1)',
                fill: 'none',
            },
        );
        this._currentAnimation.onfinish = () => { this._currentAnimation = null; };
    } catch {
        this._currentAnimation = null;
    }
}

    private _cancelShowAnimation(): void {
        if (this._currentAnimation) {
            try { this._currentAnimation.cancel(); } catch { /* swallow */ }
            this._currentAnimation = null;
        }
    }

    private _shouldAnimate(): boolean {
        if (!this._animateOnShow) return false;
        if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
            return true;
        }
        try {
            return !window.matchMedia('(prefers-reduced-motion: reduce)').matches;
        } catch {
            return true;
        }
    }

    // =================================================================
    // Внутреннее: клик снаружи
    // =================================================================

    private _bindOutsideClickHandlers(): void {
        this._onDocPointerDown = (e: PointerEvent) => this._handlePointerDown(e);
        this._onDocPointerUp = (e: PointerEvent) => this._handlePointerUp(e);
        this._onDocPointerCancel = () => this._resetPointerState();

        document.addEventListener('pointerdown', this._onDocPointerDown);
        document.addEventListener('pointerup', this._onDocPointerUp);
        document.addEventListener('pointercancel', this._onDocPointerCancel);
    }

private _handlePointerDown(e: PointerEvent): void {
    if (e.button !== 0) return;
    if (!this._activeObject) return;

    if (this._pointerDownId !== null && this._pointerDownId !== e.pointerId) {
        this._pointerMultiTouch = true;
        return;
    }

    this._pointerDownX = e.clientX;
    this._pointerDownY = e.clientY;
    this._pointerDownId = e.pointerId;
    this._pointerDownActiveObject = this._activeObject;
    this._pointerStartedInside = this._isPointerInsidePopup(e.clientX, e.clientY);
    this._pointerMultiTouch = false;
}

private _handlePointerUp(e: PointerEvent): void {
    if (this._pointerDownId !== e.pointerId) return;

    const startedInside   = this._pointerStartedInside;
    const multiTouch      = this._pointerMultiTouch;
    const downActive      = this._pointerDownActiveObject;
    const button          = e.button;
    const dx = e.clientX - this._pointerDownX;
    const dy = e.clientY - this._pointerDownY;
    this._resetPointerState();

    if (button !== 0) return;
    if (startedInside) return;
    if (multiTouch) return;
    if (Math.hypot(dx, dy) > this._clickDragThreshold) return;

    if (this._activeObject && this._activeObject === downActive) {
        this.hide();
    }
}

private _resetPointerState(): void {
    this._pointerDownId = null;
    this._pointerDownActiveObject = null;
    this._pointerStartedInside = false;
    this._pointerMultiTouch = false;
}

    private _isPointerInsidePopup(x: number, y: number): boolean {
        if (this._tooltipElement && this._rectContains(this._tooltipElement, x, y)) return true;
        if (this._tailElement && this._rectContains(this._tailElement, x, y)) return true;
        return false;
    }

    private _rectContains(el: Element, x: number, y: number): boolean {
        const r = el.getBoundingClientRect();
        return x >= r.left && x <= r.right && y >= r.top && y <= r.bottom;
    }

    // =================================================================
    // Внутреннее: rAF-цикл
    // =================================================================

    private _startLoop(): void {
        if (this._isLoopRunning) return;
        this._isLoopRunning = true;

        const tick = (): void => {
            if (!this._isLoopRunning) return;
            if (this._activeObject) {
                this._updatePosition();
            } else {
                this._stopLoop();
                return;
            }
            this._animationFrameId = requestAnimationFrame(tick);
        };
        this._animationFrameId = requestAnimationFrame(tick);
    }

    private _stopLoop(): void {
        this._isLoopRunning = false;
        if (this._animationFrameId !== null) {
            cancelAnimationFrame(this._animationFrameId);
            this._animationFrameId = null;
        }
    }

    // =================================================================
    // Внутреннее: позиционирование
    // =================================================================

    private _updatePosition(): void {
        if (!this._activeObject) { this._hide(); return; }

        const anchor = this._activeObject;
        const screenPos = typeof anchor.getPopupAnchor === 'function'
            ? (anchor.getPopupAnchor() ?? anchor.getScreenPosition())
            : anchor.getScreenPosition();

        if (!screenPos
            || typeof screenPos.x !== 'number'
            || typeof screenPos.y !== 'number') {
            if (++this._nullFrames >= 3) this.hide();
            else this._hide();
            return;
        }
        this._nullFrames = 0;

        const el = this._tooltipElement!;
        const map = this._map!;
        const canvas = map.renderer.domElement;
        const vw = canvas.clientWidth;
        const vh = canvas.clientHeight;

        if (el.style.display !== 'block') {
            el.style.display = 'block';
            el.style.visibility = 'hidden';
        }

        const w = el.offsetWidth;
        const h = el.offsetHeight;
        if (w === 0 || h === 0) { this._hide(); return; }

        const anchorX = screenPos.x;
        const anchorY = screenPos.y;
        const PAD = this._screenPadding;
        const T = this._tailSize;

        const clamp = (v: number, lo: number, hi: number) =>
            v < lo ? lo : v > hi ? hi : v;

        const tryPlace = (p: Placement): { x: number; y: number } | null => {
            if (p === 'top') {
                const y = anchorY - T - h;
                if (y < PAD) return null;
                return { x: clamp(anchorX - w / 2, PAD, Math.max(PAD, vw - w - PAD)), y };
            }
            if (p === 'bottom') {
                const y = anchorY + T;
                if (y + h > vh - PAD) return null;
                return { x: clamp(anchorX - w / 2, PAD, Math.max(PAD, vw - w - PAD)), y };
            }
            if (p === 'left') {
                const x = anchorX - T - w;
                if (x < PAD) return null;
                return { x, y: clamp(anchorY - h / 2, PAD, Math.max(PAD, vh - h - PAD)) };
            }
            const x = anchorX + T;
            if (x + w > vw - PAD) return null;
            return { x, y: clamp(anchorY - h / 2, PAD, Math.max(PAD, vh - h - PAD)) };
        };

        let placement: Placement = 'top';
        let pos: { x: number; y: number } | null = null;
        for (const p of this._placementOrder) {
            pos = tryPlace(p);
            if (pos) { placement = p; break; }
        }
        if (!pos) {
            placement = 'top';
            pos = {
                x: clamp(anchorX - w / 2, PAD, Math.max(PAD, vw - w - PAD)),
                y: clamp(anchorY - T - h, PAD, Math.max(PAD, vh - h - PAD)),
            };
        }

        this._updateTail(placement, pos.x, pos.y, anchorX, anchorY, w, h);

        const posKey = pos.x + '|' + pos.y;
        if (posKey !== this._lastPosKey) {
            if (!this._currentAnimation) {
                el.style.transform = `translate3d(${pos.x}px, ${pos.y}px, 0)`;
            }
            this._lastPosKey = posKey;
        }
        el.style.visibility = 'visible';
    }

    /**
     * Позиционирует SVG-хвостик. База треугольника ложится на *внешний*
     * край бордера тултипа (`h`/`w` в локальных координатах), а
     * «переходник» закрашивает бордер и субпиксельную щель изнутри.
     */
    private _updateTail(
        placement: Placement,
        posX: number,
        posY: number,
        anchorX: number,
        anchorY: number,
        w: number,
        h: number,
    ): void {
        const tail = this._tailElement!;

        if (placement !== this._lastPlacement) {
            this._rebuildTailSvg(placement);
            this._lastPlacement = placement;
            this._lastTailPosKey = '';
        }

        const T = this._tailSize;
        const C = this._tailConnectorSize;
        const halfW = Math.max(5, Math.round(T * 0.7));
        const edgeInset = halfW + 2;

        let left = '0';
        let top = '0';
        let transform = '';

        const clampAxis = (v: number, size: number) => {
            const lo = Math.min(edgeInset, size / 2);
            const hi = Math.max(size - edgeInset, size / 2);
            return v < lo ? lo : v > hi ? hi : v;
        };

        // Координаты острия хвостика в ЛОКАЛЬНОЙ системе тултипа.
        let tipX = 0;
        let tipY = 0;

        if (placement === 'top') {
            // База на Y = h (низ border-box), переходник закрашивает h-C…h.
            tipX = clampAxis(anchorX - posX, w);
            left = `${tipX}px`;
            top = `calc(100% - ${C - 1}px)`;
            transform = 'translateX(-50%)';
            tipY = h + T;
        } else if (placement === 'bottom') {
            // База на Y = 0 (верх border-box), переходник закрашивает 0…C.
            tipX = clampAxis(anchorX - posX, w);
            left = `${tipX}px`;
            top = `${-(T + 1)}px`;
            transform = 'translateX(-50%)';
            tipY = -T;
        } else if (placement === 'left') {
            // База на X = w (правый край border-box), переходник w-C…w.
            tipY = clampAxis(anchorY - posY, h);
            left = `calc(100% - ${C - 1}px)`;
            top = `${tipY}px`;
            transform = 'translateY(-50%)';
            tipX = w + T;
        } else {
            // 'right': база на X = 0 (левый край border-box), переходник 0…C.
            tipY = clampAxis(anchorY - posY, h);
            left = `${-(T + 1)}px`;
            top = `${tipY}px`;
            transform = 'translateY(-50%)';
            tipX = -T;
        }

        this._lastTipX = tipX;
        this._lastTipY = tipY;

        const key = `${placement}|${left}|${top}`;
        if (key !== this._lastTailPosKey) {
            tail.style.left = left;
            tail.style.top = top;
            tail.style.transform = transform;
            this._lastTailPosKey = key;
        }
    }

    /**
     * Строит SVG-геометрию хвостика с переходником.
     *
     * Переходник — прямоугольная часть полигона, продолжающая треугольник
     * в сторону тела тултипа на `C` px. Заливка белая; обводка идёт только
     * по «наружным» рёбрам (без базы) — стык с тултипом без шва.
     */
    private _rebuildTailSvg(placement: Placement): void {
        const tail = this._tailElement!;
        const ns = 'http://www.w3.org/2000/svg';
        tail.innerHTML = '';

        const T = this._tailSize;
        const C = this._tailConnectorSize;
        const hw = Math.max(5, Math.round(T * 0.7));

        let wAttr: string, hAttr: string, viewBox: string;
        let poly: string, path: string;

        if (placement === 'top' || placement === 'bottom') {
            const W = hw * 2;
            wAttr = String(W);
            hAttr = String(T + C);
            if (placement === 'top') {
                // Острие внизу; сверху — переходник в теле тултипа.
                viewBox = `0 ${-C} ${W} ${T + C}`;
                poly = `0,${-C} ${W},${-C} ${W},0 ${hw},${T} 0,0`;
                path = `M0,0 L${hw},${T} L${W},0`;
            } else {
                // Острие вверху; снизу — переходник в теле тултипа.
                viewBox = `0 0 ${W} ${T + C}`;
                poly = `0,${T + C} ${W},${T + C} ${W},${T} ${hw},0 0,${T}`;
                path = `M0,${T} L${hw},0 L${W},${T}`;
            }
        } else {
            const H = hw * 2;
            wAttr = String(T + C);
            hAttr = String(H);
            if (placement === 'left') {
                // Острие справа; слева — переходник в теле тултипа.
                viewBox = `${-C} 0 ${T + C} ${H}`;
                poly = `${-C},0 0,0 ${T},${hw} 0,${H} ${-C},${H}`;
                path = `M0,0 L${T},${hw} L0,${H}`;
            } else {
                // 'right': острие слева; справа — переходник в теле тултипа.
                viewBox = `0 0 ${T + C} ${H}`;
                poly = `${T},0 ${T + C},0 ${T + C},${H} ${T},${H} 0,${hw}`;
                path = `M${T},0 L0,${hw} L${T},${H}`;
            }
        }

        tail.setAttribute('width', wAttr);
        tail.setAttribute('height', hAttr);
        tail.setAttribute('viewBox', viewBox);

        const polygon = document.createElementNS(ns, 'polygon');
        polygon.setAttribute('points', poly);
        polygon.setAttribute('fill', 'white');
        tail.appendChild(polygon);

        const pathEl = document.createElementNS(ns, 'path');
        pathEl.setAttribute('d', path);
        pathEl.setAttribute('fill', 'none');
        pathEl.setAttribute('stroke', this._tailColor);
        pathEl.setAttribute('stroke-width', '1');
        pathEl.setAttribute('stroke-linejoin', 'round');
        tail.appendChild(pathEl);
    }

    private _hide(): void {
        if (this._tooltipElement && this._tooltipElement.style.visibility !== 'hidden') {
            this._tooltipElement.style.visibility = 'hidden';
        }
    }

    // =================================================================
    // Виртуальный anchor
    // =================================================================

    private _makeVirtualAnchor(point: PopupPoint): PopupAnchor {
        return {
            getScreenPosition: () =>
                this._projectLonLatToScreen(point.lonLat, point.crs, point.altitude),
        };
    }

    private _projectLonLatToScreen(
        lonLat: LonLat | LonLatAlt,
        crs: string | undefined,
        altitude: number | undefined,
    ): { x: number; y: number } | null {
        const map = this._map;
        if (!map) return null;

        const alt = lonLat.length >= 3 ? lonLat[2] : (altitude ?? 0);
        const crsObj = crs
            ? (typeof crs === 'string' ? Projections.get(crs) : crs)
            : map.inputCRS;
        const [absX, absZ] = map.project([lonLat[0], lonLat[1]], crsObj);
        const wgPos = map.worldGroup.position;

        const vec = new THREE.Vector3(
            absX + wgPos.x,
            alt + wgPos.y,
            absZ + wgPos.z,
        );
        vec.project(map.camera);

        if (vec.z > 1 || Math.abs(vec.x) > 1 || Math.abs(vec.y) > 1) return null;

        const canvas = map.renderer.domElement;
        return {
            x: (vec.x * 0.5 + 0.5) * canvas.clientWidth,
            y: (-vec.y * 0.5 + 0.5) * canvas.clientHeight,
        };
    }
}