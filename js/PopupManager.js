/**
 * PopupManager — управление HTML-тултипами на карте.
 *
 * Возможности:
 * - хвостик (SVG-треугольник), указывающий на anchor;
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
// =====================================================================
// PopupManager
// =====================================================================
export class PopupManager {
    _map;
    _activeObject = null;
    _animationFrameId = null;
    _tooltipElement = null;
    _contentElement = null;
    _tailElement = null;
    _isLoopRunning = false;
    _nullFrames = 0;
    // Кэши DOM-состояния.
    _lastHtml = null;
    _lastPosKey = '';
    _lastPlacement = null;
    _lastTailPosKey = '';
    // Остриё хвостика в ЛОКАЛЬНЫХ координатах тултипа — нужно для анимации
    // появления (чтобы «рост» происходил именно из хвостика).
    _lastTipX = 0;
    _lastTipY = 0;
    _pointerEvents;
    _zIndex;
    _tailSize;
    _screenPadding;
    _tailColor;
    _placementOrder;
    _closeOnClick;
    _clickDragThreshold;
    _animateOnShow;
    _animationDuration;
    _currentAnimation = null;
    // Состояние «текущего» pointer-жеста — для различения клика и drag.
    _onDocPointerDown = null;
    _onDocPointerUp = null;
    _onDocPointerCancel = null;
    _pointerDownX = 0;
    _pointerDownY = 0;
    _pointerDownId = null;
    _pointerStartedInside = false;
    _pointerMultiTouch = false;
    constructor(map, options = {}) {
        this._map = map;
        this._pointerEvents = options.pointerEvents ?? 'none';
        this._zIndex = String(options.zIndex ?? 1200);
        this._tailSize = options.tailSize ?? 10;
        this._screenPadding = options.screenPadding ?? 8;
        this._tailColor = options.tailColor ?? '#767676';
        this._placementOrder = options.placementOrder ?? ['top', 'bottom', 'right', 'left'];
        this._closeOnClick = options.closeOnClick ?? true;
        this._clickDragThreshold = options.clickDragThreshold ?? 5;
        this._animateOnShow = options.animateOnShow ?? true;
        this._animationDuration = options.animationDuration ?? 150;
        this._createTooltipElement();
        if (this._closeOnClick)
            this._bindOutsideClickHandlers();
    }
    // =================================================================
    // Публичное API
    // =================================================================
    show(object, html) {
        if (!object || !html) {
            this.hide();
            return;
        }
        const wasHidden = this._tooltipElement.style.visibility !== 'visible';
        this._activeObject = object;
        if (this._lastHtml !== html) {
            this._contentElement.innerHTML = html;
            this._lastHtml = html;
            this._lastPosKey = '';
        }
        const text = this._contentElement.textContent;
        if (!text || text.trim() === '') {
            this.hide();
            return;
        }
        this._nullFrames = 0;
        this._updatePosition();
        this._startLoop();
        if (wasHidden)
            this._playShowAnimation();
    }
    showAt(lonLat, html) {
        this.showAtPoint({ lonLat }, html);
    }
    showAtPoint(point, html) {
        this.show(this._makeVirtualAnchor(point), html);
    }
    hide() {
        this._cancelShowAnimation();
        if (this._activeObject && typeof this._activeObject._onPopupHide === 'function') {
            try {
                this._activeObject._onPopupHide();
            }
            catch (e) {
                console.warn('[PopupManager] _onPopupHide threw:', e);
            }
        }
        this._activeObject = null;
        this._hide();
        this._stopLoop();
    }
    destroy() {
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
    _createTooltipElement() {
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
            // Именно 0 0 — чтобы формула «x(s) = x + tipX*(1-s)» работала без
            // поправок на центр. Анимация translate+scale зашита в keyframes.
            transformOrigin: '0 0',
            willChange: 'transform, opacity',
        });
        const content = document.createElement('div');
        content.className = 'krb-popup-content';
        el.appendChild(content);
        const ns = 'http://www.w3.org/2000/svg';
        const tail = document.createElementNS(ns, 'svg');
        tail.classList.add('krb-popup-tail');
        Object.assign(tail.style, {
            position: 'absolute',
            overflow: 'visible',
            pointerEvents: 'none',
            display: 'block',
        });
        el.appendChild(tail);
        this._map.targetElement.appendChild(el);
        this._tooltipElement = el;
        this._contentElement = content;
        this._tailElement = tail;
    }
    // =================================================================
    // Внутреннее: анимация появления
    // =================================================================
    /**
     * Анимирует `transform: translate3d(x, y, 0) scale(s)` целиком.
     *
     * Не используем standalone `scale` в keyframes — в ряде браузеров он
     * интерпретируется как `transform: scale()`, перекрывая translate3d,
     * из-за чего тултип «выпрыгивает» из точки (0, 0) родителя.
     *
     * Чтобы точка острия хвостика `(tipX, tipY)` (в локальных координатах)
     * оставалась неподвижной при масштабе `s`, координаты translate
     * пересчитываются: `x' = x + tipX*(1-s)`, `y' = y + tipY*(1-s)`.
     */
    _playShowAnimation() {
        if (!this._shouldAnimate())
            return;
        const el = this._tooltipElement;
        if (!el || el.style.visibility !== 'visible')
            return;
        const sep = this._lastPosKey.indexOf('|');
        if (sep < 0)
            return;
        const x = parseFloat(this._lastPosKey.slice(0, sep));
        const y = parseFloat(this._lastPosKey.slice(sep + 1));
        if (!isFinite(x) || !isFinite(y))
            return;
        this._cancelShowAnimation();
        const s0 = 0.9;
        const s1 = 1;
        const tipX = this._lastTipX;
        const tipY = this._lastTipY;
        const x0 = x + tipX * (1 - s0);
        const y0 = y + tipY * (1 - s0);
        try {
            this._currentAnimation = el.animate([
                {
                    transform: `translate3d(${x0}px, ${y0}px, 0) scale(${s0})`,
                    opacity: 0,
                },
                {
                    transform: `translate3d(${x}px, ${y}px, 0) scale(${s1})`,
                    opacity: 1,
                },
            ], {
                duration: this._animationDuration,
                // лёгкий overshoot — «поп» ощущается живее линейного ease-out
                easing: 'cubic-bezier(0.34, 1.56, 0.64, 1)',
                fill: 'none',
            });
            this._currentAnimation.onfinish = () => { this._currentAnimation = null; };
        }
        catch {
            // Старые браузеры без WAAPI — молча без анимации.
            this._currentAnimation = null;
        }
    }
    _cancelShowAnimation() {
        if (this._currentAnimation) {
            try {
                this._currentAnimation.cancel();
            }
            catch { /* swallow */ }
            this._currentAnimation = null;
        }
    }
    _shouldAnimate() {
        if (!this._animateOnShow)
            return false;
        if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
            return true;
        }
        try {
            return !window.matchMedia('(prefers-reduced-motion: reduce)').matches;
        }
        catch {
            return true;
        }
    }
    // =================================================================
    // Внутреннее: клик снаружи (down → up + порог drag'а)
    // =================================================================
    _bindOutsideClickHandlers() {
        this._onDocPointerDown = (e) => this._handlePointerDown(e);
        this._onDocPointerUp = (e) => this._handlePointerUp(e);
        this._onDocPointerCancel = () => this._resetPointerState();
        document.addEventListener('pointerdown', this._onDocPointerDown);
        document.addEventListener('pointerup', this._onDocPointerUp);
        document.addEventListener('pointercancel', this._onDocPointerCancel);
    }
    _handlePointerDown(e) {
        if (!this._activeObject)
            return;
        if (this._pointerDownId !== null && this._pointerDownId !== e.pointerId) {
            this._pointerMultiTouch = true;
            return;
        }
        this._pointerDownX = e.clientX;
        this._pointerDownY = e.clientY;
        this._pointerDownId = e.pointerId;
        this._pointerStartedInside = this._isPointerInsidePopup(e.clientX, e.clientY);
        this._pointerMultiTouch = false;
    }
    _handlePointerUp(e) {
        if (this._pointerDownId !== e.pointerId)
            return;
        const startedInside = this._pointerStartedInside;
        const multiTouch = this._pointerMultiTouch;
        const dx = e.clientX - this._pointerDownX;
        const dy = e.clientY - this._pointerDownY;
        this._resetPointerState();
        if (startedInside)
            return;
        if (multiTouch)
            return;
        if (Math.hypot(dx, dy) > this._clickDragThreshold)
            return;
        if (this._activeObject)
            this.hide();
    }
    _resetPointerState() {
        this._pointerDownId = null;
        this._pointerStartedInside = false;
        this._pointerMultiTouch = false;
    }
    _isPointerInsidePopup(x, y) {
        if (this._tooltipElement && this._rectContains(this._tooltipElement, x, y))
            return true;
        if (this._tailElement && this._rectContains(this._tailElement, x, y))
            return true;
        return false;
    }
    _rectContains(el, x, y) {
        const r = el.getBoundingClientRect();
        return x >= r.left && x <= r.right && y >= r.top && y <= r.bottom;
    }
    // =================================================================
    // Внутреннее: rAF-цикл
    // =================================================================
    _startLoop() {
        if (this._isLoopRunning)
            return;
        this._isLoopRunning = true;
        const tick = () => {
            if (!this._isLoopRunning)
                return;
            if (this._activeObject) {
                this._updatePosition();
            }
            else {
                this._stopLoop();
                return;
            }
            this._animationFrameId = requestAnimationFrame(tick);
        };
        this._animationFrameId = requestAnimationFrame(tick);
    }
    _stopLoop() {
        this._isLoopRunning = false;
        if (this._animationFrameId !== null) {
            cancelAnimationFrame(this._animationFrameId);
            this._animationFrameId = null;
        }
    }
    // =================================================================
    // Внутреннее: позиционирование
    // =================================================================
    _updatePosition() {
        if (!this._activeObject) {
            this._hide();
            return;
        }
        const anchor = this._activeObject;
        const screenPos = typeof anchor.getPopupAnchor === 'function'
            ? (anchor.getPopupAnchor() ?? anchor.getScreenPosition())
            : anchor.getScreenPosition();
        if (!screenPos
            || typeof screenPos.x !== 'number'
            || typeof screenPos.y !== 'number') {
            if (++this._nullFrames >= 3)
                this.hide();
            else
                this._hide();
            return;
        }
        this._nullFrames = 0;
        const el = this._tooltipElement;
        const map = this._map;
        const canvas = map.renderer.domElement;
        const vw = canvas.clientWidth;
        const vh = canvas.clientHeight;
        // Измеряем только когда тултип в потоке layout'а.
        if (el.style.display !== 'block') {
            el.style.display = 'block';
            el.style.visibility = 'hidden';
        }
        const w = el.offsetWidth;
        const h = el.offsetHeight;
        if (w === 0 || h === 0) {
            this._hide();
            return;
        }
        const anchorX = screenPos.x;
        const anchorY = screenPos.y;
        const PAD = this._screenPadding;
        const T = this._tailSize;
        const clamp = (v, lo, hi) => v < lo ? lo : v > hi ? hi : v;
        const tryPlace = (p) => {
            if (p === 'top') {
                const y = anchorY - T - h;
                if (y < PAD)
                    return null;
                return { x: clamp(anchorX - w / 2, PAD, Math.max(PAD, vw - w - PAD)), y };
            }
            if (p === 'bottom') {
                const y = anchorY + T;
                if (y + h > vh - PAD)
                    return null;
                return { x: clamp(anchorX - w / 2, PAD, Math.max(PAD, vw - w - PAD)), y };
            }
            if (p === 'left') {
                const x = anchorX - T - w;
                if (x < PAD)
                    return null;
                return { x, y: clamp(anchorY - h / 2, PAD, Math.max(PAD, vh - h - PAD)) };
            }
            const x = anchorX + T;
            if (x + w > vw - PAD)
                return null;
            return { x, y: clamp(anchorY - h / 2, PAD, Math.max(PAD, vh - h - PAD)) };
        };
        let placement = 'top';
        let pos = null;
        for (const p of this._placementOrder) {
            pos = tryPlace(p);
            if (pos) {
                placement = p;
                break;
            }
        }
        if (!pos) {
            // Fallback: тултип больше вьюпорта — clamp'им 'top'.
            placement = 'top';
            pos = {
                x: clamp(anchorX - w / 2, PAD, Math.max(PAD, vw - w - PAD)),
                y: clamp(anchorY - T - h, PAD, Math.max(PAD, vh - h - PAD)),
            };
        }
        this._updateTail(placement, pos.x, pos.y, anchorX, anchorY, w, h);
        const posKey = pos.x + '|' + pos.y;
        if (posKey !== this._lastPosKey) {
            // Не трогаем transform, пока идёт анимация — WAAPI сейчас
            // главнее, а после её окончания inline-значение снова в силе.
            if (!this._currentAnimation) {
                el.style.transform = `translate3d(${pos.x}px, ${pos.y}px, 0)`;
            }
            this._lastPosKey = posKey;
        }
        el.style.visibility = 'visible';
    }
    /**
     * Ставит SVG-хвостик так, чтобы он смотрел на anchor. Дополнительно
     * запоминает координаты острия в ЛОКАЛЬНОЙ системе тултипа — их
     * использует `_playShowAnimation()`, чтобы «рост» шёл из хвостика.
     */
    _updateTail(placement, posX, posY, anchorX, anchorY, w, h) {
        const tail = this._tailElement;
        if (placement !== this._lastPlacement) {
            this._rebuildTailSvg(placement);
            this._lastPlacement = placement;
            this._lastTailPosKey = '';
        }
        const T = this._tailSize;
        const halfW = Math.max(5, Math.round(T * 0.7));
        const edgeInset = halfW + 2;
        let left = '0';
        let top = '0';
        let transform = '';
        const clampAxis = (v, size) => {
            const lo = Math.min(edgeInset, size / 2);
            const hi = Math.max(size - edgeInset, size / 2);
            return v < lo ? lo : v > hi ? hi : v;
        };
        // Координаты острия хвостика в ЛОКАЛЬНОЙ системе тултипа.
        let tipX = 0;
        let tipY = 0;
        if (placement === 'top') {
            tipX = clampAxis(anchorX - posX, w);
            left = `${tipX}px`;
            top = 'calc(100% - 0.1px)';
            transform = 'translateX(-50%)';
            tipY = h + T;
        }
        else if (placement === 'bottom') {
            tipX = clampAxis(anchorX - posX, w);
            left = `${tipX}px`;
            top = `-${T}px`;
            transform = 'translateX(-50%)';
            tipY = -T;
        }
        else if (placement === 'left') {
            tipY = clampAxis(anchorY - posY, h);
            left = '100%';
            top = `${tipY}px`;
            transform = 'translateY(-50%)';
            tipX = w + T;
        }
        else {
            tipY = clampAxis(anchorY - posY, h);
            left = `-${T}px`;
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
    _rebuildTailSvg(placement) {
        const tail = this._tailElement;
        const ns = 'http://www.w3.org/2000/svg';
        tail.innerHTML = '';
        const T = this._tailSize;
        const hw = Math.max(5, Math.round(T * 0.7));
        let wAttr, hAttr, viewBox;
        let poly, path;
        if (placement === 'top' || placement === 'bottom') {
            wAttr = String(hw * 2);
            hAttr = String(T);
            viewBox = `0 0 ${hw * 2} ${T}`;
            if (placement === 'top') {
                poly = `0,0 ${hw * 2},0 ${hw},${T}`;
                path = `M0,0 L${hw},${T} L${hw * 2},0`;
            }
            else {
                poly = `0,${T} ${hw * 2},${T} ${hw},0`;
                path = `M0,${T} L${hw},0 L${hw * 2},${T}`;
            }
        }
        else {
            wAttr = String(T);
            hAttr = String(hw * 2);
            viewBox = `0 0 ${T} ${hw * 2}`;
            if (placement === 'left') {
                poly = `0,0 ${T},${hw} 0,${hw * 2}`;
                path = `M0,0 L${T},${hw} L0,${hw * 2}`;
            }
            else {
                poly = `${T},0 0,${hw} ${T},${hw * 2}`;
                path = `M${T},0 L0,${hw} L${T},${hw * 2}`;
            }
        }
        tail.setAttribute('width', wAttr);
        tail.setAttribute('height', hAttr);
        tail.setAttribute('viewBox', viewBox);
        const polygon = document.createElementNS(ns, 'polygon');
        polygon.setAttribute('points', poly);
        polygon.setAttribute('fill', 'white');
        tail.appendChild(polygon);
        // Обводка только по «наружным» рёбрам — стык с тултипом без шва.
        const pathEl = document.createElementNS(ns, 'path');
        pathEl.setAttribute('d', path);
        pathEl.setAttribute('fill', 'none');
        pathEl.setAttribute('stroke', this._tailColor);
        pathEl.setAttribute('stroke-width', '1');
        pathEl.setAttribute('stroke-linejoin', 'round');
        tail.appendChild(pathEl);
    }
    _hide() {
        if (this._tooltipElement && this._tooltipElement.style.visibility !== 'hidden') {
            this._tooltipElement.style.visibility = 'hidden';
        }
    }
    // =================================================================
    // Виртуальный anchor
    // =================================================================
    _makeVirtualAnchor(point) {
        return {
            getScreenPosition: () => this._projectLonLatToScreen(point.lonLat, point.crs, point.altitude),
        };
    }
    _projectLonLatToScreen(lonLat, crs, altitude) {
        const map = this._map;
        if (!map)
            return null;
        const alt = lonLat.length >= 3 ? lonLat[2] : (altitude ?? 0);
        const crsObj = crs
            ? (typeof crs === 'string' ? Projections.get(crs) : crs)
            : map.inputCRS;
        const [absX, absZ] = map.project([lonLat[0], lonLat[1]], crsObj);
        const wgPos = map.worldGroup.position;
        const vec = new THREE.Vector3(absX + wgPos.x, alt + wgPos.y, absZ + wgPos.z);
        vec.project(map.camera);
        if (vec.z > 1 || Math.abs(vec.x) > 1 || Math.abs(vec.y) > 1)
            return null;
        const canvas = map.renderer.domElement;
        return {
            x: (vec.x * 0.5 + 0.5) * canvas.clientWidth,
            y: (-vec.y * 0.5 + 0.5) * canvas.clientHeight,
        };
    }
}
