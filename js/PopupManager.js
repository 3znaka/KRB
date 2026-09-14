/**
 * Модуль управления всплывающими подсказками (popup) на карте.
 * Предоставляет единый механизм для отображения HTML-тултипов, привязанных
 * к объектам карты (маркерам, полигонам). Устраняет дублирование логики
 * и конфликты при использовании общего DOM-элемента несколькими объектами.
 *
 * @module PopupManager
 */

import { THREE } from '../js_TP/tpb.js';

/**
 * Менеджер всплывающих подсказок.
 * Создаёт единый HTML-элемент тултипа, добавляет его в DOM карты и
 * автоматически обновляет его позицию на каждом кадре для активного объекта.
 * Активный объект должен предоставлять метод `getScreenPosition()`, возвращающий
 * экранные координаты ({x, y}) или null, если объект невидим.
 *
 * Реализует два стандартных поведения:
 * 1. Скрытие тултипа при клике (или касании) вне его области.
 * 2. Автоматическое скрытие, если переданный HTML не содержит видимого содержимого.
 *
 * Цикл обновления позиции запускается только при наличии активного объекта
 * и останавливается при hide() — это экономит CPU, когда тултип скрыт.
 *
 * @example
 * // В конструкторе карты:
 * this.popupManager = new PopupManager(this);
 *
 * // При клике на объект:
 * map.popupManager.show(polygon, '<b>Комната 101</b><br>Площадь: 50 м²');
 *
 * // Скрыть:
 * map.popupManager.hide();
 *
 * // С кликабельным содержимым:
 * new PopupManager(map, { pointerEvents: 'auto' });
 */
export class PopupManager {
    /**
     * Создаёт экземпляр PopupManager.
     *
     * @param {Object} map - Экземпляр карты (KrbMap).
     * @param {Object} [options] - Опции менеджера.
     * @param {'none'|'auto'} [options.pointerEvents='none'] - Значение CSS pointer-events
     *   для тултипа. 'auto' имеет смысл, если содержимое должно быть кликабельным
     *   (ссылки, кнопки); при этом клик по тултипу не будет закрывать его.
     * @param {number} [options.zIndex=1200] - z-index тултипа.
     */
    constructor(map, options = {}) {
        /** @private */ this._map = map;
        /** @private */ this._activeObject = null;   // объект, к которому привязан текущий тултип
        /** @private */ this._animationFrameId = null;
        /** @private */ this._tooltipElement = null;
        /** @private */ this._isLoopRunning = false;

        // Кэш последней позиции — чтобы не трогать DOM, если ничего не изменилось.
        /** @private */ this._lastX = NaN;
        /** @private */ this._lastY = NaN;
        /** @private */ this._lastHtml = null;

        /** @private */ this._pointerEvents = options.pointerEvents ?? 'none';
        /** @private */ this._zIndex = String(options.zIndex ?? 1200);

        // Привязанный обработчик для возможности удаления.
        /** @private */ this._onDocumentPointerDown = null;

        this._createTooltipElement();
        this._bindOutsideClickHandlers();
    }

    /**
     * Создаёт DOM-элемент тултипа и добавляет его в контейнер карты.
     *
     * @private
     */
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
            // translate3d задаётся отдельно в _updatePosition() — здесь только
            // общий сдвиг, чтобы попап «висел» над точкой.
            transform: 'translate(-50%, -100%)',
            display: 'none',
            zIndex: this._zIndex,
            maxWidth: '300px',
            // Явно фиксируем начало координат, чтобы translate3d работал предсказуемо.
            left: '0',
            top: '0',
            willChange: 'transform'
        });
        this._map.targetElement.appendChild(el);
        this._tooltipElement = el;
    }

    /**
     * Привязывает обработчик события pointerdown на документе.
     * Использование pointerdown (а не mousedown/touchstart по отдельности)
     * позволяет избежать повторного скрытия тултипа на мобильных устройствах
     * из-за синтетического mousedown после touchend.
     *
     * @private
     */
    _bindOutsideClickHandlers() {
        this._onDocumentPointerDown = (event) => this._handleDocumentPointerDown(event);
        document.addEventListener('pointerdown', this._onDocumentPointerDown);
    }

    /**
     * Обработчик pointerdown на документе.
     * Если тултип активен и клик/касание было вне его прямоугольника, скрывает тултип.
     *
     * @param {PointerEvent} event - Событие pointerdown.
     * @private
     */
    _handleDocumentPointerDown(event) {
        if (!this._activeObject || !this._tooltipElement) return;

        const rect = this._tooltipElement.getBoundingClientRect();
        const { clientX, clientY } = event;

        const isInside =
            clientX >= rect.left &&
            clientX <= rect.right &&
            clientY >= rect.top &&
            clientY <= rect.bottom;

        if (!isInside) {
            this.hide();
        }
    }

    /**
     * Запускает цикл обновления позиции. Идемпотентен: повторный вызов
     * при активном цикле ничего не делает.
     *
     * @private
     */
    _startLoop() {
        if (this._isLoopRunning) return;
        this._isLoopRunning = true;

        const tick = () => {
            if (!this._isLoopRunning) return;
            if (this._activeObject) {
                this._updatePosition();
            } else {
                // Нет активного объекта — дальше крутить цикл нет смысла.
                this._stopLoop();
                return;
            }
            this._animationFrameId = requestAnimationFrame(tick);
        };
        this._animationFrameId = requestAnimationFrame(tick);
    }

    /**
     * Останавливает цикл обновления позиции, если он запущен.
     *
     * @private
     */
    _stopLoop() {
        this._isLoopRunning = false;
        if (this._animationFrameId !== null) {
            cancelAnimationFrame(this._animationFrameId);
            this._animationFrameId = null;
        }
    }

    /**
     * Обновляет позицию тултипа на основе экранных координат активного объекта.
     * Если объект невидим или координаты недоступны, тултип временно прячется
     * (без сброса активного объекта — он может снова стать видимым).
     *
     * @private
     */
    _updatePosition() {
        if (!this._activeObject) {
            this._hide();
            return;
        }
        const screenPos = this._activeObject.getScreenPosition?.();
        if (!screenPos || typeof screenPos.x !== 'number' || typeof screenPos.y !== 'number') {
            this._hide();
            return;
        }

        // Не трогаем DOM, если позиция не изменилась (типично для статичной карты).
        if (screenPos.x === this._lastX && screenPos.y === this._lastY) {
            if (this._tooltipElement.style.display !== 'block') {
                this._tooltipElement.style.display = 'block';
            }
            return;
        }
        this._lastX = screenPos.x;
        this._lastY = screenPos.y;

        const el = this._tooltipElement;
        if (el.style.display !== 'block') el.style.display = 'block';
        // translate3d + центрирующий translate(-50%, -100%) — оба в transform.
        el.style.transform =
            `translate3d(${screenPos.x}px, ${screenPos.y}px, 0) translate(-50%, -100%)`;
    }

    /**
     * Показывает тултип с заданным HTML-содержимым, привязанный к указанному объекту.
     * Если HTML пустой или после установки не содержит видимого текста,
     * тултип не отображается.
     *
     * @param {Object} object - Объект карты (маркер, полигон), реализующий getScreenPosition().
     * @param {string} html - HTML-строка с содержимым тултипа.
     * @returns {void}
     */
    show(object, html) {
        if (!object || !html) {
            this.hide();
            return;
        }

        this._activeObject = object;

        // innerHTML перезаписываем только если он реально изменился —
        // иначе лишний parse-HTML и вызовы textContent.
        if (this._lastHtml !== html) {
            this._tooltipElement.innerHTML = html;
            this._lastHtml = html;

            // Проверяем, есть ли видимое содержимое после установки innerHTML.
            if (!this._tooltipElement.textContent ||
                this._tooltipElement.textContent.trim() === '') {
                this.hide();
                return;
            }
        }

        // Сброс кэша позиции, чтобы первый _updatePosition гарантированно
        // применил transform (даже если координаты совпали со «старыми»).
        this._lastX = NaN;
        this._lastY = NaN;

        this._tooltipElement.style.display = 'block';
        // Немедленно обновляем позицию, чтобы не ждать следующего кадра.
        this._updatePosition();

        this._startLoop();
    }

    /**
     * Скрывает тултип и сбрасывает активный объект.
     * Также уведомляет объект о скрытии через метод `_onPopupHide()`, если он существует.
     * Это позволяет объекту синхронизировать своё состояние (например, сбросить hovered).
     *
     * @returns {void}
     */
    hide() {
        if (this._activeObject && typeof this._activeObject._onPopupHide === 'function') {
            try {
                this._activeObject._onPopupHide();
            } catch (e) {
                console.warn('[PopupManager] _onPopupHide threw:', e);
            }
        }
        this._activeObject = null;
        this._hide();
        this._stopLoop();
    }

    /**
     * Скрывает DOM-элемент тултипа, не сбрасывая активный объект
     * и не останавливая цикл обновления. Используется внутри _updatePosition(),
     * когда объект временно невидим (например, за кадром).
     *
     * @private
     */
    _hide() {
        if (this._tooltipElement && this._tooltipElement.style.display !== 'none') {
            this._tooltipElement.style.display = 'none';
        }
    }

    /**
     * Уничтожает менеджер: останавливает цикл, удаляет обработчики,
     * удаляет DOM-элемент и очищает ссылки. Идемпотентен.
     *
     * @returns {void}
     */
    destroy() {
        this._stopLoop();

        if (this._onDocumentPointerDown) {
            document.removeEventListener('pointerdown', this._onDocumentPointerDown);
            this._onDocumentPointerDown = null;
        }

        if (this._tooltipElement) {
            if (this._tooltipElement.parentNode) {
                this._tooltipElement.parentNode.removeChild(this._tooltipElement);
            }
            this._tooltipElement = null;
        }
        this._activeObject = null;
        this._map = null;
        this._lastHtml = null;
        this._lastX = NaN;
        this._lastY = NaN;
    }
}