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

// =====================================================================
// Типы
// =====================================================================

export type LonLat = [number, number];
export type LonLatAlt = [number, number, number];

/**
 * Описание виртуальной точки для {@link PopupManager#showAtPoint}.
 * Позволяет задать попап «в воздухе», без создания объекта на карте.
 */
export interface PopupPoint {
    /** `[lon, lat]` или `[lon, lat, alt]`. Если есть alt — он приоритетнее `altitude`. */
    lngLat: LonLat | LonLatAlt;
    /** Код СК координат. По умолчанию — `map.inputCRS`. */
    crs?: string;
    /** Абсолютная Y в world-метрах. По умолчанию 0. */
    altitude?: number;
}

export interface PopupManagerOptions {
    /** CSS pointer-events. `'auto'` — содержимое кликабельно (ссылки, кнопки). */
    pointerEvents?: 'none' | 'auto';
    /** CSS z-index тултипа. По умолчанию 1200. */
    zIndex?: number;
}

/**
 * Всё, что менеджеру нужно от anchor-объекта.
 * Этому интерфейсу удовлетворяет любой `SpatialObject` (`Marker`, `Polygon`,
 * `Area3D`, …) — у всех них есть `getScreenPosition()`.
 */
export interface PopupAnchor {
    getScreenPosition(): { x: number; y: number } | null;
    /** Необязательный хук: вызывается из `hide()`. */
    _onPopupHide?(): void;
}

/**
 * Минимальный контракт карты (структурная типизация — `KrbMap` удовлетворяет
 * автоматически без импорта).
 */
export interface PopupMapHost {
    targetElement: HTMLElement;
    inputCRS: any;
    worldGroup: { position: { x: number; y: number; z: number } };
    camera: any;
    renderer: { domElement: HTMLCanvasElement };
    /** Координаты в СК `crs` → world-метры карты, `[absX, absZ]`. */
    project(pt: LonLat, crs: any): [number, number];
}

// =====================================================================
// PopupManager
// =====================================================================

export class PopupManager {
    private _map: PopupMapHost | null;
    private _activeObject: PopupAnchor | null = null;
    private _animationFrameId: number | null = null;
    private _tooltipElement: HTMLDivElement | null = null;
    private _isLoopRunning = false;

    // Кэш последней позиции — чтобы не трогать DOM, если ничего не изменилось.
    private _lastX = NaN;
    private _lastY = NaN;
    private _lastHtml: string | null = null;

    private _pointerEvents: 'none' | 'auto';
    private _zIndex: string;

    private _onDocumentPointerDown: ((e: PointerEvent) => void) | null = null;

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
     *     { lngLat: [37.62, 55.75], altitude: 200 },
     *     '<b>Высота 200 м</b>'
     * );
     *
     * map.popupManager.hide();
     */
    constructor(map: PopupMapHost, options: PopupManagerOptions = {}) {
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
    show(object: PopupAnchor | null | undefined, html: string): void {
        if (!object || !html) {
            this.hide();
            return;
        }

        this._activeObject = object;

        if (this._lastHtml !== html) {
            this._tooltipElement!.innerHTML = html;
            this._lastHtml = html;

            // Проверяем, есть ли видимое содержимое после установки innerHTML.
            const text = this._tooltipElement!.textContent;
            if (!text || text.trim() === '') {
                this.hide();
                return;
            }
        }

        // Сброс кэша позиции — первый _updatePosition гарантированно
        // применит transform, даже если координаты совпали со «старыми».
        this._lastX = NaN;
        this._lastY = NaN;

        this._tooltipElement!.style.display = 'block';
        this._updatePosition();
        this._startLoop();
    }

    /**
     * Показывает тултип в произвольной точке.
     *
     * `lngLat` — `[lon, lat]` или `[lon, lat, alt]` в WGS84 (или в СК,
     * указанной в {@link PopupPoint#crs} через {@link showAtPoint}).
     * На каждом кадре экранная позиция пересчитывается через `map.project`
     * — при движении камеры попап «висит» в точке.
     *
     * @example
     * map.popupManager.showAt([37.62, 55.75], '<b>Москва</b>');
     * map.popupManager.showAt([37.62, 55.75, 200], '<b>На высоте 200 м</b>');
     */
    showAt(lngLat: LonLat | LonLatAlt, html: string): void {
        this.showAtPoint({ lngLat }, html);
    }

    /**
     * Показывает тултип в произвольной точке с полными опциями
     * (CRS, абсолютная высота).
     *
     * @example
     * map.popupManager.showAtPoint(
     *     { lngLat: [7425000, 6200000], crs: 'EPSG:3857' },
     *     '<b>Точка в Меркаторе</b>'
     * );
     * map.popupManager.showAtPoint(
     *     { lngLat: [37.62, 55.75], altitude: 500 },
     *     '<b>+500 м</b>'
     * );
     */
    showAtPoint(point: PopupPoint, html: string): void {
        this.show(this._makeVirtualAnchor(point), html);
    }

    /**
     * Скрывает тултип и сбрасывает активный anchor.
     * Если у anchor есть `_onPopupHide()`, вызывает его — это позволяет
     * объекту синхронизировать состояние (например, сбросить hovered).
     */
    hide(): void {
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
     * Уничтожает менеджер: останавливает цикл, снимает обработчики,
     * удаляет DOM-элемент. Идемпотентен.
     */
    destroy(): void {
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

    private _createTooltipElement(): void {
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
        this._map!.targetElement.appendChild(el);
        this._tooltipElement = el;
    }

    private _bindOutsideClickHandlers(): void {
        this._onDocumentPointerDown = (event: PointerEvent) =>
            this._handleDocumentPointerDown(event);
        document.addEventListener('pointerdown', this._onDocumentPointerDown);
    }

    private _handleDocumentPointerDown(event: PointerEvent): void {
        if (!this._activeObject || !this._tooltipElement) return;

        const rect = this._tooltipElement.getBoundingClientRect();
        const { clientX, clientY } = event;

        const isInside =
            clientX >= rect.left &&
            clientX <= rect.right &&
            clientY >= rect.top &&
            clientY <= rect.bottom;

        if (!isInside) this.hide();
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

    private _updatePosition(): void {
        if (!this._activeObject) {
            this._hide();
            return;
        }
        const screenPos = this._activeObject.getScreenPosition();
        if (!screenPos
            || typeof screenPos.x !== 'number'
            || typeof screenPos.y !== 'number') {
            this._hide();
            return;
        }

        if (screenPos.x === this._lastX && screenPos.y === this._lastY) {
            if (this._tooltipElement!.style.display !== 'block') {
                this._tooltipElement!.style.display = 'block';
            }
            return;
        }
        this._lastX = screenPos.x;
        this._lastY = screenPos.y;

        const el = this._tooltipElement!;
        if (el.style.display !== 'block') el.style.display = 'block';
        el.style.transform =
            `translate3d(${screenPos.x}px, ${screenPos.y}px, 0) translate(-50%, -100%)`;
    }

    private _hide(): void {
        if (this._tooltipElement && this._tooltipElement.style.display !== 'none') {
            this._tooltipElement.style.display = 'none';
        }
    }

    // =================================================================
    // Внутреннее: виртуальный anchor
    // =================================================================

    private _makeVirtualAnchor(point: PopupPoint): PopupAnchor {
        return {
            getScreenPosition: () =>
                this._projectLngLatToScreen(point.lngLat, point.crs, point.altitude),
        };
    }

    /**
     * Проецирует `[lon, lat(, alt)]` в экранные координаты.
     * Возвращает `null`, если точки нет в видимой области frustum'а
     * или карта уничтожена.
     */
    private _projectLngLatToScreen(
        lngLat: LonLat | LonLatAlt,
        crs: string | undefined,
        altitude: number | undefined,
    ): { x: number; y: number } | null {
        const map = this._map;
        if (!map) return null;

        const alt = lngLat.length >= 3 ? lngLat[2] : (altitude ?? 0);
        const [absX, absZ] = map.project(
            [lngLat[0], lngLat[1]],
            crs ?? map.inputCRS,
        );
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