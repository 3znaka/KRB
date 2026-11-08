/**
 * Модуль управления всплывающими подсказками (popup) на карте.
 *
 * Предоставляет единый механизм для отображения HTML-тултипов, привязанных
 * к объектам карты (маркерам, полигонам), либо к «виртуальным» точкам
 * координат — без создания отдельного объекта-маркера.
 *
 * Активный anchor (объект карты или виртуальная точка) должен предоставлять
 * `getScreenPosition()`. Менеджер сам крутит `requestAnimationFrame`-цикл,
 * пока попап виден, и прячет его, когда anchor временно вне экрана.
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
    _isLoopRunning = false;
    // Кэш последней позиции — чтобы не трогать DOM, если ничего не изменилось.
    _lastX = NaN;
    _lastY = NaN;
    _lastHtml = null;
    _pointerEvents;
    _zIndex;
    _onDocumentPointerDown = null;
    /**
     * @param map - Экземпляр карты (`KrbMap`).
     * @param options - Опции менеджера.
     *
     * @example
     * // В конструкторе карты:
     * this.popupManager = new PopupManager(this);
     *
     * // По клику на объект:
     * map.popupManager.show(polygon, '<b>Комната 101</b>');
     *
     * // По произвольной точке WGS84:
     * map.popupManager.showAt([37.62, 55.75], '<b>Москва</b>');
     *
     * // С полными опциями точки:
     * map.popupManager.showAtPoint(
     *     { lonLat: [37.62, 55.75], altitude: 200 },
     *     '<b>Высота 200 м</b>'
     * );
     *
     * map.popupManager.hide();
     */
    constructor(map, options = {}) {
        this._map = map;
        this._pointerEvents = options.pointerEvents ?? 'none';
        this._zIndex = String(options.zIndex ?? 1200);
        this._createTooltipElement();
        this._bindOutsideClickHandlers();
    }
    // =================================================================
    // Публичное API
    // =================================================================
    /**
     * Показывает тултип с заданным HTML, привязанный к объекту карты.
     * Если HTML пустой или после установки не содержит видимого текста,
     * тултип не отображается.
     *
     * @param object - Anchor: объект карты или виртуальная точка.
     * @param html - HTML-строка с содержимым.
     */
    show(object, html) {
        if (!object || !html) {
            this.hide();
            return;
        }
        this._activeObject = object;
        if (this._lastHtml !== html) {
            this._tooltipElement.innerHTML = html;
            this._lastHtml = html;
        }
        // Проверяем КАЖДЫЙ раз — дёшево (textContent уже распарсен).
        const text = this._tooltipElement.textContent;
        if (!text || text.trim() === '') {
            this.hide();
            return;
        }
        // Сброс кэша позиции — первый _updatePosition гарантированно
        // применит transform, даже если координаты совпали со «старыми».
        this._lastX = NaN;
        this._lastY = NaN;
        this._tooltipElement.style.display = 'block';
        this._updatePosition();
        this._startLoop();
    }
    /**
     * Показывает тултип в произвольной точке.
     *
     * Координаты интерпретируются в `map.inputCRS`. Чтобы задать другую СК,
     * используйте `showAtPoint({ lonLat, crs: 'EPSG:3857' })`.
     */
    showAt(lonLat, html) {
        this.showAtPoint({ lonLat }, html);
    }
    /**
     * Показывает тултип в произвольной точке с полными опциями
     * (CRS, абсолютная высота).
     *
     * @example
     * map.popupManager.showAtPoint(
     *     { lonLat: [7425000, 6200000], crs: 'EPSG:3857' },
     *     '<b>Точка в Меркаторе</b>'
     * );
     * map.popupManager.showAtPoint(
     *     { lonLat: [37.62, 55.75], altitude: 500 },
     *     '<b>+500 м</b>'
     * );
     */
    showAtPoint(point, html) {
        this.show(this._makeVirtualAnchor(point), html);
    }
    /**
     * Скрывает тултип и сбрасывает активный anchor.
     * Если у anchor есть `_onPopupHide()`, вызывает его — это позволяет
     * объекту синхронизировать состояние (например, сбросить hovered).
     */
    hide() {
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
    /**
     * Уничтожает менеджер: останавливает цикл, снимает обработчики,
     * удаляет DOM-элемент. Идемпотентен.
     */
    destroy() {
        this._stopLoop();
        if (this._onDocumentPointerDown) {
            document.removeEventListener('pointerdown', this._onDocumentPointerDown);
            this._onDocumentPointerDown = null;
        }
        if (this._tooltipElement) {
            this._tooltipElement.parentNode?.removeChild(this._tooltipElement);
            this._tooltipElement = null;
        }
        this._activeObject = null;
        this._map = null;
        this._lastHtml = null;
        this._lastX = NaN;
        this._lastY = NaN;
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
            border: '1px solid #767676',
            borderRadius: '6px',
            boxShadow: '0 2px 6px rgba(0,0,0,0.2)',
            padding: '8px 12px',
            fontSize: '14px',
            pointerEvents: this._pointerEvents,
            transform: 'translate(-50%, -100%)',
            display: 'none',
            zIndex: this._zIndex,
            maxWidth: '300px',
            left: '0',
            top: '0',
            willChange: 'transform',
        });
        this._map.targetElement.appendChild(el);
        this._tooltipElement = el;
    }
    _bindOutsideClickHandlers() {
        this._onDocumentPointerDown = (event) => this._handleDocumentPointerDown(event);
        document.addEventListener('pointerdown', this._onDocumentPointerDown);
    }
    _handleDocumentPointerDown(event) {
        if (!this._activeObject || !this._tooltipElement)
            return;
        const rect = this._tooltipElement.getBoundingClientRect();
        const { clientX, clientY } = event;
        const isInside = clientX >= rect.left &&
            clientX <= rect.right &&
            clientY >= rect.top &&
            clientY <= rect.bottom;
        if (!isInside)
            this.hide();
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
    _nullFrames = 0;
    _updatePosition() {
        if (!this._activeObject) {
            this._hide();
            return;
        }
        const screenPos = this._activeObject.getScreenPosition();
        if (!screenPos || typeof screenPos.x !== 'number' || typeof screenPos.y !== 'number') {
            // 3 кадра подряд без позиции = объект «мёртв», закрываем окончательно.
            if (++this._nullFrames >= 3)
                this.hide();
            else
                this._hide();
            return;
        }
        this._nullFrames = 0;
        if (!screenPos
            || typeof screenPos.x !== 'number'
            || typeof screenPos.y !== 'number') {
            this._hide();
            return;
        }
        if (screenPos.x === this._lastX && screenPos.y === this._lastY) {
            if (this._tooltipElement.style.display !== 'block') {
                this._tooltipElement.style.display = 'block';
            }
            return;
        }
        this._lastX = screenPos.x;
        this._lastY = screenPos.y;
        const el = this._tooltipElement;
        if (el.style.display !== 'block')
            el.style.display = 'block';
        el.style.transform =
            `translate3d(${screenPos.x}px, ${screenPos.y}px, 0) translate(-50%, -100%)`;
    }
    _hide() {
        if (this._tooltipElement && this._tooltipElement.style.display !== 'none') {
            this._tooltipElement.style.display = 'none';
        }
    }
    // =================================================================
    // Внутреннее: виртуальный anchor
    // =================================================================
    _makeVirtualAnchor(point) {
        return {
            getScreenPosition: () => this._projectLonLatToScreen(point.lonLat, point.crs, point.altitude),
        };
    }
    /**
     * Проецирует `[lon, lat(, alt)]` в экранные координаты.
     * Возвращает `null`, если точки нет в видимой области frustum'а
     * или карта уничтожена.
     */
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
