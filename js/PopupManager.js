/**
 * Модуль управления всплывающими подсказками (popup) на карте.
 * Предоставляет единый механизм для отображения HTML-тултипов, привязанных
 * к объектам карты (маркерам, полигонам). Устраняет дублирование логики
 * и конфликты при использовании общего DOM-элемента несколькими объектами.
 *
 * @module PopupManager
 */

import { THREE } from '../js_TP/tpb.js';

export class PopupManager {
    /**
     * Создаёт экземпляр PopupManager.
     *
     * @param {Object} map - Экземпляр карты (KrbMap).
     */
    constructor(map) {
        this._map = map;
        this._activeObject = null;
        this._animationFrameId = null;
        this._tooltipElement = null;

        // Привязанные обработчики для возможности удаления
        this._onDocumentPointerDown = null; // единый обработчик pointerdown

        this._createTooltipElement();
        this._startUpdateLoop();
        this._bindOutsideClickHandlers();
    }

    /**
     * Создаёт DOM-элемент тултипа и добавляет его в контейнер карты.
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
            pointerEvents: 'none',
            transform: 'translate(-50%, -100%)',
            display: 'none',
            zIndex: '1200',
            maxWidth: '300px'
        });
        this._map.targetElement.appendChild(el);
        this._tooltipElement = el;
    }

    /**
     * Запускает цикл обновления позиции тултипа.
     * @private
     */
    _startUpdateLoop() {
        const tick = () => {
            if (this._activeObject) {
                this._updatePosition();
            }
            this._animationFrameId = requestAnimationFrame(tick);
        };
        this._animationFrameId = requestAnimationFrame(tick);
    }

    /**
     * Привязывает обработчик события pointerdown на документе.
     * Использование pointerdown вместо отдельно mousedown и touchstart
     * позволяет избежать повторного скрытия тултипа на мобильных устройствах
     * из-за синтетического mousedown после touchend.
     * @private
     */
    _bindOutsideClickHandlers() {
        this._onDocumentPointerDown = (event) => this._handleDocumentPointerDown(event);
        document.addEventListener('pointerdown', this._onDocumentPointerDown);
    }

    /**
     * Обработчик pointerdown на документе.
     * Если тултип активен и касание/клик произошло вне его прямоугольника, скрывает тултип.
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
     * Обновляет позицию тултипа на основе экранных координат активного объекта.
     * @private
     */
    _updatePosition() {
        if (!this._activeObject) {
            this._hide();
            return;
        }
        const screenPos = this._activeObject.getScreenPosition?.();
        if (!screenPos || (typeof screenPos.x !== 'number' || typeof screenPos.y !== 'number')) {
            this._hide();
            return;
        }
        this._tooltipElement.style.display = 'block';
        this._tooltipElement.style.left = screenPos.x + 'px';
        this._tooltipElement.style.top = screenPos.y + 'px';
    }

    /**
     * Показывает тултип с заданным HTML-содержимым.
     * @param {Object} object - Объект карты, реализующий getScreenPosition().
     * @param {string} html - HTML-строка с содержимым тултипа.
     */
    show(object, html) {
        if (!object || !html) {
            this.hide();
            return;
        }

        this._activeObject = object;
        this._tooltipElement.innerHTML = html;

        if (!this._tooltipElement.textContent || this._tooltipElement.textContent.trim() === '') {
            this.hide();
            return;
        }

        this._tooltipElement.style.display = 'block';
        this._updatePosition();
    }

    /**
     * Скрывает тултип и сбрасывает активный объект.
     */
    hide() {
        this._activeObject = null;
        this._hide();
    }

    /**
     * Скрывает DOM-элемент тултипа (без сброса активного объекта).
     * @private
     */
    _hide() {
        if (this._tooltipElement) {
            this._tooltipElement.style.display = 'none';
        }
    }

    /**
     * Уничтожает менеджер: останавливает цикл, удаляет обработчики,
     * удаляет DOM-элемент и очищает ссылки.
     */
    destroy() {
        if (this._animationFrameId) {
            cancelAnimationFrame(this._animationFrameId);
            this._animationFrameId = null;
        }

        if (this._onDocumentPointerDown) {
            document.removeEventListener('pointerdown', this._onDocumentPointerDown);
            this._onDocumentPointerDown = null;
        }

        if (this._tooltipElement) {
            this._tooltipElement.remove();
            this._tooltipElement = null;
        }
        this._activeObject = null;
        this._map = null;
    }
}