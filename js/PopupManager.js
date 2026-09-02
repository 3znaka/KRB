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
 * @example
 * // В конструкторе карты:
 * this.popupManager = new PopupManager(this);
 *
 * // При клике на объект:
 * map.popupManager.show(polygon, '<b>Комната 101</b><br>Площадь: 50 м²');
 *
 * // Скрыть:
 * map.popupManager.hide();
 */
export class PopupManager {
    /**
     * Создаёт экземпляр PopupManager.
     *
     * @param {Object} map - Экземпляр карты (KrbMap).
     */
    constructor(map) {
        /** @private */ this._map = map;
        /** @private */ this._activeObject = null;   // объект, к которому привязан текущий тултип
        /** @private */ this._animationFrameId = null; // id requestAnimationFrame
        /** @private */ this._tooltipElement = null;

        this._createTooltipElement();
        this._startUpdateLoop();
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
            pointerEvents: 'none',
            transform: 'translate(-50%, -100%)',
            display: 'none',
            zIndex: '1200',
            maxWidth: '300px',
            whiteSpace: 'nowrap'
        });
        this._map.targetElement.appendChild(el);
        this._tooltipElement = el;
    }

    /**
     * Запускает цикл обновления позиции тултипа.
     * Каждый кадр проверяет активный объект и обновляет координаты.
     *
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
     * Обновляет позицию тултипа на основе экранных координат активного объекта.
     * Если объект невидим или координаты недоступны, скрывает тултип.
     *
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
     * Показывает тултип с заданным HTML-содержимым, привязанный к указанному объекту.
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
        this._tooltipElement.innerHTML = html;
        this._tooltipElement.style.display = 'block';
        // Немедленно обновляем позицию, чтобы не ждать следующего кадра
        this._updatePosition();
    }

    /**
     * Скрывает тултип и сбрасывает активный объект.
     *
     * @returns {void}
     */
    hide() {
        this._activeObject = null;
        this._hide();
    }

    /**
     * Скрывает DOM-элемент тултипа (без сброса активного объекта).
     *
     * @private
     */
    _hide() {
        if (this._tooltipElement) {
            this._tooltipElement.style.display = 'none';
        }
    }

    /**
     * Уничтожает менеджер: останавливает цикл, удаляет DOM-элемент и очищает ссылки.
     *
     * @returns {void}
     */
    destroy() {
        if (this._animationFrameId) {
            cancelAnimationFrame(this._animationFrameId);
            this._animationFrameId = null;
        }
        if (this._tooltipElement) {
            this._tooltipElement.remove();
            this._tooltipElement = null;
        }
        this._activeObject = null;
        this._map = null;
    }
}