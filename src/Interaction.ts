/**
 * Модуль единого менеджера взаимодействия для объектов на карте.
 *
 * Отвечает за:
 *   - регистрацию mesh-объектов (`Polygon`, `Area3D`, `Marker3D`,
 *     `Polyline`, `Vector3D`, `Image`) для hover/click через raycast;
 *   - определение DOM-маркеров (`Marker`) по `elementFromPoint`;
 *   - публичный метод `queryRenderedFeatures({ x, y })` — «что под точкой».
 *
 * DOM-маркеры (`Marker`) в `register()` **не** попадают — у них свои
 * DOM-события. Для `queryRenderedFeatures` они находятся отдельной веткой
 * через `_getMarkerFromElement`.
 *
 * @module Interaction
 */

import { THREE } from './js_TP/tpb.js';
import { _getMarkerFromElement } from './Marker.js';
import type { Marker } from './Marker.js';
import type { SpatialObject } from './SpatialObject.js';
import type { Layer } from './Layers.js';

// =====================================================================
// Публичные типы
// =====================================================================

export interface InteractionCallbacks {
    /** Меши объекта для raycast. Пустой массив / `null` — пропустить. */
    getMeshes: () => any[] | null;
    /** Мировая bounding-сфера для broad-phase. `null` — без отсечения. */
    getBoundingSphere?: () => { center: any; radius: number } | null;
    /** Колбэк hover. Если задан — приоритетнее tooltip-логики. */
    onHover?: (isHovered: boolean) => void;
    /** Колбэк клика. Вызывается только если клик не был драгом. */
    onClick?: (event: PointerEvent | MouseEvent, obj: SpatialObject) => void;
    /** HTML тултипа (или `null`). Показывается через `map.popupManager`. */
    getTooltip?: () => string | null;
    /** Дополнительный фильтр видимости. */
    isVisible?: () => boolean;
    /** Участвовать только в мобильном тач-режиме. */
    isMobileOnly?: boolean;
}

export interface ScreenPoint {
    /** CSS-пиксели относительно левого верхнего угла canvas. */
    x: number;
    y: number;
}

export interface QueryRenderedFeature {
    /** Объект карты (`Polygon`, `Marker`, `Area3D`, `Image`, …). */
    object: SpatialObject;
    /** Слой, к которому привязан объект (`null`, если без слоя). */
    layer: Layer | null;
    /** Точка попадания в WGS84 (`[lon, lat]`). */
    point: [number, number];
    /** `object.getProperties()` — бизнес-данные. */
    properties: Record<string, any>;
}

// =====================================================================
// Внутренние типы
// =====================================================================

interface Entry {
    obj: SpatialObject;
    getMeshes: () => any[] | null;
    getBoundingSphere: (() => { center: any; radius: number } | null) | null;
    onHover: ((isHovered: boolean) => void) | null;
    onClick: ((event: PointerEvent | MouseEvent, obj: SpatialObject) => void) | null;
    getTooltip: (() => string | null) | null;
    isVisible: (() => boolean) | null;
    isMobileOnly: boolean;
    wasHovered: boolean;
}

interface Handlers {
    pointerdown: (e: PointerEvent) => void;
    pointermove: (e: PointerEvent) => void;
    pointerup: (e: PointerEvent) => void;
    pointercancel: (e: PointerEvent) => void;
    pointerleave: (e: PointerEvent) => void;
}

// =====================================================================
// InteractionManager
// =====================================================================

/**
 * Менеджер взаимодействия (один на карту). Создаётся автоматически
 * в `KrbMap` как `map.interaction`.
 *
 * @example
 * // Регистрация полигона
 * const unregister = map.interaction.register(polygon, {
 *     getMeshes: () => [polygon._fillMesh, polygon._sideMesh, polygon._bottomMesh]
 *         .filter(Boolean),
 *     onHover: (isHovered) => polygon._applyHover(isHovered, map),
 *     onClick: (event) => polygon._onClick?.(event, polygon),
 *     getTooltip: () => polygon._tooltipText || null,
 *     isVisible: () => polygon._group.visible,
 * });
 *
 * // Позже
 * unregister();
 */
export class InteractionManager {
    private _map: any;

    /**
     * Зарегистрированные записи. `Set` — стабильный порядок обхода
     * (порядок регистрации) + O(1) удаление.
     */
    private _entries: Set<Entry> = new Set();

    /** Маппинг Object3D → entry. Строится на каждый raycast. */
    private _meshToEntry: Map<any, Entry> = new Map();

    private _raycaster: any = new THREE.Raycaster();
    private _mouseNDC: any = new THREE.Vector2();
    private _broadPhaseSphere: any = new THREE.Sphere();

    private _lastRaycastTime = 0;
    /** Троттлинг hover-raycast: 33 мс ≈ 30 Гц. */
    private _raycastThrottleMs = 33;

    private _pointerDownX = 0;
    private _pointerDownY = 0;
    private _pointerDownActive = false;
    /** Порог смещения (px) для «клик vs драг». */
    private _clickMoveThreshold = 5;

    /** Запись, которая сейчас под курсором (desktop) или tap-active (mobile). */
    private _hoveredEntry: Entry | null = null;
    /** Запись, по которой произошёл pointerdown (mobile). */
    private _pressedEntry: Entry | null = null;

    private _handlers: Handlers | null = null;
    private _attached = false;

    private _isMobile = false;
    private _isMobileResolved = false;

    constructor(map: any) {
        this._map = map;
    }

    // =================================================================
    // Публичный API
    // =================================================================

    /**
     * Регистрирует mesh-объект для обработки указателя.
     *
     * Если объект уже зарегистрирован — старая запись заменяется новой
     * (позволяет «обновлять» колбэки без явного `unregister`).
     *
     * @returns функция отмены регистрации (эквивалент `unregister(obj)`).
     */
    register(obj: SpatialObject, callbacks: InteractionCallbacks): () => void {
        if (!obj || !callbacks || typeof callbacks.getMeshes !== 'function') {
            console.warn('InteractionManager.register: obj and callbacks.getMeshes are required');
            return () => {};
        }

        this.unregister(obj);

        const entry: Entry = {
            obj,
            getMeshes: callbacks.getMeshes,
            getBoundingSphere: callbacks.getBoundingSphere ?? null,
            onHover: callbacks.onHover ?? null,
            onClick: callbacks.onClick ?? null,
            getTooltip: callbacks.getTooltip ?? null,
            isVisible: callbacks.isVisible ?? null,
            isMobileOnly: callbacks.isMobileOnly === true,
            wasHovered: false,
        };
        this._entries.add(entry);

        this._ensureListeners();
        return () => this.unregister(obj);
    }

    /**
     * Снимает регистрацию объекта. Если объект был в hover — вызывает
     * `onHover(false)` (или скрывает popup). После удаления последней
     * записи слушатели снимаются с canvas.
     */
    unregister(obj: SpatialObject): void {
        for (const entry of this._entries) {
            if (entry.obj !== obj) continue;

            if (entry.wasHovered) {
                entry.wasHovered = false;
                if (entry.onHover) {
                    try { entry.onHover(false); } catch { /* swallow */ }
                } else if (entry.getTooltip && this._map.popupManager) {
                    this._map.popupManager.hide();
                }
            }
            if (this._hoveredEntry === entry) this._hoveredEntry = null;
            if (this._pressedEntry === entry) this._pressedEntry = null;
            this._entries.delete(entry);
            break;
        }
        if (this._entries.size === 0) {
            this._detachListeners();
        }
    }

    /**
     * Полностью останавливает менеджер: снимает hover со всех записей,
     * очищает реестр и слушатели.
     */
    destroy(): void {
        for (const entry of this._entries) {
            if (entry.wasHovered) {
                entry.wasHovered = false;
                if (entry.onHover) {
                    try { entry.onHover(false); } catch { /* swallow */ }
                }
            }
        }
        this._entries.clear();
        this._meshToEntry.clear();
        this._hoveredEntry = null;
        this._pressedEntry = null;
        this._detachListeners();
    }

    /**
     * Возвращает все видимые объекты под экранной точкой `(x, y)`.
     *
     * Работает для двух категорий объектов:
     *   - mesh-объекты, зарегистрированные через `register()` — находятся
     *     через raycast;
     *   - DOM-маркеры (`Marker`) — через `elementFromPoint` +
     *     `_getMarkerFromElement` (у них нет записи в `_entries`).
     *
     * Результат отсортирован от ближнего к дальнему (порядок raycast).
     * Дубликаты (один `Polygon` = top + side + bottom в одной точке)
     * схлопываются в один `QueryRenderedFeature`.
     *
     * Метод **не** меняет hover-состояние и **не** участвует в throttle
     * hover-цикла — его можно безопасно вызывать из `click`-обработчиков.
     *
     * @example
     * canvas.addEventListener('click', (e) => {
     *     const rect = canvas.getBoundingClientRect();
     *     const features = map.queryRenderedFeatures({
     *         x: e.clientX - rect.left,
     *         y: e.clientY - rect.top,
     *     });
     *     for (const f of features) console.log(f.object, f.properties, f.point);
     * });
     */
    queryRenderedFeatures(screen: ScreenPoint): QueryRenderedFeature[] {
        const result: QueryRenderedFeature[] = [];
        const seen = new Set<SpatialObject>();

        // ── 1. Mesh-объекты через raycast ─────────────────────────────
        this._setNDCFromScreen(screen.x, screen.y);
        this._raycaster.setFromCamera(this._mouseNDC, this._map.camera);
        const meshes = this._collectMeshes(false);

        if (meshes.length > 0) {
            const hits = this._raycaster.intersectObjects(meshes, false);
            for (const hit of hits) {
                const entry = this._meshToEntry.get(hit.object);
                if (!entry) continue;
                const obj = entry.obj;
                if (seen.has(obj)) continue;
                seen.add(obj);
                result.push(this._buildFeatureFromHit(obj, hit));
            }
        }

        // ── 2. DOM-маркеры через elementFromPoint ────────────────────
        const canvas = this._map.renderer?.domElement as HTMLCanvasElement | undefined;
        if (canvas) {
            const rect = canvas.getBoundingClientRect();
            const el = document.elementFromPoint(
                rect.left + screen.x,
                rect.top + screen.y,
            );
            const markerEl = el instanceof HTMLElement
                ? el.closest('.krb-marker')
                : null;
            const marker = markerEl instanceof HTMLElement
                ? _getMarkerFromElement(markerEl)
                : null;

            if (marker && !seen.has(marker)) {
                seen.add(marker);
                const ll = marker.getLngLat() ?? marker.getCenter() ?? null;
result.push({
    object: marker,
    layer: marker.getLayer(),
    point: ll ? [ll[0], ll[1]] : [NaN, NaN],
    properties: marker.getProperties(),
});
            }
        }

        return result;
    }

    // =================================================================
    // Внутреннее: mobile, listeners
    // =================================================================

    private _resolveMobileFlag(): void {
        if (this._isMobileResolved) return;
        try {
            this._isMobile = window.matchMedia('(hover: none) and (pointer: coarse)').matches;
        } catch {
            this._isMobile = false;
        }
        this._isMobileResolved = true;
    }

    private _ensureListeners(): void {
        if (this._attached) return;
        const canvas = this._map.renderer?.domElement as HTMLCanvasElement | undefined;
        if (!canvas) return;

        this._resolveMobileFlag();

        this._handlers = {
            pointerdown:   (e) => this._onPointerDown(e),
            pointermove:   (e) => this._onPointerMove(e),
            pointerup:     (e) => this._onPointerUp(e),
            pointercancel: (e) => this._onPointerCancel(e),
            pointerleave:  (e) => this._onPointerLeave(e),
        };

        canvas.addEventListener('pointerdown',   this._handlers.pointerdown,   true);
        canvas.addEventListener('pointermove',   this._handlers.pointermove,   true);
        canvas.addEventListener('pointerup',     this._handlers.pointerup,     true);
        canvas.addEventListener('pointercancel', this._handlers.pointercancel, true);
        canvas.addEventListener('pointerleave',  this._handlers.pointerleave,  true);
        this._attached = true;
    }

    private _detachListeners(): void {
        if (!this._attached) return;
        const canvas = this._map.renderer?.domElement as HTMLCanvasElement | undefined;
        if (canvas && this._handlers) {
            canvas.removeEventListener('pointerdown',   this._handlers.pointerdown,   true);
            canvas.removeEventListener('pointermove',   this._handlers.pointermove,   true);
            canvas.removeEventListener('pointerup',     this._handlers.pointerup,     true);
            canvas.removeEventListener('pointercancel', this._handlers.pointercancel, true);
            canvas.removeEventListener('pointerleave',  this._handlers.pointerleave,  true);
        }
        this._handlers = null;
        this._attached = false;
    }

    // =================================================================
    // Внутреннее: NDC, сбор мешей, raycast
    // =================================================================

    private _setNDCFromEvent(event: PointerEvent | MouseEvent): void {
        const rect = this._map.renderer.domElement.getBoundingClientRect();
        this._mouseNDC.set(
            ((event.clientX - rect.left) / rect.width) * 2 - 1,
            -((event.clientY - rect.top) / rect.height) * 2 + 1,
        );
    }

    private _setNDCFromScreen(x: number, y: number): void {
        const rect = this._map.renderer.domElement.getBoundingClientRect();
        this._mouseNDC.set(
            (x / rect.width) * 2 - 1,
            -(y / rect.height) * 2 + 1,
        );
    }

    /**
     * Собирает меши всех видимых записей, прошедших broad-phase.
     * Заполняет `_meshToEntry`.
     *
     * @param clearHover — если `true`, сбрасывает hover у отсечённых записей
     *     (для hover-цикла). `false` — без побочных эффектов (для query).
     */
    private _collectMeshes(clearHover: boolean = true): any[] {
        this._meshToEntry.clear();
        const meshes: any[] = [];
        const ray = this._raycaster.ray;

        for (const entry of this._entries) {
            // 1) Пользовательский фильтр видимости.
            if (entry.isVisible) {
                let visible = false;
                try { visible = entry.isVisible(); } catch { visible = false; }
                if (!visible) {
                    if (clearHover) this._clearEntryHover(entry);
                    continue;
                }
            }

            // 2) Мобильный фильтр.
            if (entry.isMobileOnly && !this._isMobile) {
                if (clearHover) this._clearEntryHover(entry);
                continue;
            }

            // 3) Broad-phase по bounding sphere.
            if (entry.getBoundingSphere) {
                let bs: { center: any; radius: number } | null = null;
                try { bs = entry.getBoundingSphere(); } catch { bs = null; }
                if (bs && bs.center && typeof bs.radius === 'number') {
                    this._broadPhaseSphere.set(bs.center, bs.radius);
                    if (!ray.intersectsSphere(this._broadPhaseSphere)) {
                        if (clearHover) this._clearEntryHover(entry);
                        continue;
                    }
                }
            }

            // 4) Собственно меши.
            let objMeshes: any[] | null = null;
            try { objMeshes = entry.getMeshes(); } catch { objMeshes = null; }
            if (!objMeshes || objMeshes.length === 0) {
                if (clearHover) this._clearEntryHover(entry);
                continue;
            }
            for (const m of objMeshes) {
                if (!m) continue;
                meshes.push(m);
                this._meshToEntry.set(m, entry);
            }
        }

        return meshes;
    }

    private _clearEntryHover(entry: Entry): void {
        if (!entry.wasHovered) return;
        entry.wasHovered = false;
        if (entry.onHover) {
            try { entry.onHover(false); } catch { /* swallow */ }
        } else if (entry.getTooltip && this._map.popupManager) {
            this._map.popupManager.hide();
        }
        if (this._hoveredEntry === entry) this._hoveredEntry = null;
    }

    /**
     * Raycast из текущего NDC, возвращает верхнюю запись (или `null`).
     * Для hover-цикла; `queryRenderedFeatures` использует raycast напрямую.
     */
    private _raycast(): { entry: Entry; hit: any } | null {
        this._raycaster.setFromCamera(this._mouseNDC, this._map.camera);
        const meshes = this._collectMeshes(true);
        if (meshes.length === 0) return null;

        const hits = this._raycaster.intersectObjects(meshes, false);
        for (const hit of hits) {
            const entry = this._meshToEntry.get(hit.object);
            if (entry) return { entry, hit };
        }
        return null;
    }

    private _applyHover(newEntry: Entry | null): void {
        if (this._hoveredEntry === newEntry) return;

        const old = this._hoveredEntry;
        if (old) {
            old.wasHovered = false;
            if (old.onHover) {
                try { old.onHover(false); } catch { /* swallow */ }
            } else if (old.getTooltip && this._map.popupManager) {
                this._map.popupManager.hide();
            }
        }

        this._hoveredEntry = newEntry;
        if (newEntry) {
            newEntry.wasHovered = true;
            if (newEntry.onHover) {
                try { newEntry.onHover(true); } catch { /* swallow */ }
            } else if (newEntry.getTooltip && this._map.popupManager) {
                let text: string | null = null;
                try { text = newEntry.getTooltip(); } catch { text = null; }
                if (text) this._map.popupManager.show(newEntry.obj, text);
            }
        }
    }

    // =================================================================
    // Внутреннее: сборка QueryRenderedFeature
    // =================================================================

    private _buildFeatureFromHit(obj: SpatialObject, hit: any): QueryRenderedFeature {
        let lon = NaN;
        let lat = NaN;
        try {
            const wp = hit.point as { x: number; y: number; z: number };
            const ll = typeof this._map.unprojectToLonLat === 'function'
                ? this._map.unprojectToLonLat(wp.x, wp.z)
                : this._map.unproject([wp.x, wp.z], 'EPSG:4326');
            lon = ll[0];
            lat = ll[1];
        } catch {
            // объект может быть вне домена проекции — оставляем NaN
        }

const layer: Layer | null = obj.getLayer();

        return {
            object: obj,
            layer,
            point: [lon, lat],
            properties: obj.getProperties(),
        };
    }

    // =================================================================
    // Обработчики указателя
    // =================================================================

    private _onPointerDown(e: PointerEvent): void {
        this._pointerDownX = e.clientX;
        this._pointerDownY = e.clientY;
        this._pointerDownActive = true;

        if (this._isMobile) {
            this._setNDCFromEvent(e);
            const result = this._raycast();
            this._pressedEntry = result ? result.entry : null;
        }
    }

    private _onPointerMove(e: PointerEvent): void {
        if (this._isMobile) return;

        const now = performance.now();
        if (now - this._lastRaycastTime < this._raycastThrottleMs) return;
        this._lastRaycastTime = now;

        this._setNDCFromEvent(e);
        const result = this._raycast();
        this._applyHover(result ? result.entry : null);
    }

    private _onPointerCancel(_e: PointerEvent): void {
        this._pointerDownActive = false;
        this._pressedEntry = null;
    }

    private _onPointerUp(e: PointerEvent): void {
        const hadPointerDown = this._pointerDownActive;
        const pressedEntry = this._pressedEntry;
        this._pointerDownActive = false;
        this._pressedEntry = null;

        if (!hadPointerDown) return;

        const dx = e.clientX - this._pointerDownX;
        const dy = e.clientY - this._pointerDownY;
        const threshold = this._clickMoveThreshold;
        if (dx * dx + dy * dy > threshold * threshold) return;

        let entry: Entry | null = null;
        if (this._isMobile) {
            entry = pressedEntry;
        } else {
            this._setNDCFromEvent(e);
            const result = this._raycast();
            entry = result ? result.entry : null;
        }

        if (!entry) {
            if (this._isMobile && this._hoveredEntry) {
                this._applyHover(null);
            }
            return;
        }

        // 1) onClick имеет приоритет.
        if (entry.onClick) {
            try {
                entry.onClick(e, entry.obj);
            } catch (err) {
                console.error('InteractionManager.onClick threw:', err);
            }
            return;
        }

        // 2) Ни hover, ни tooltip — объекту нечего делать.
        const hasHover = !!(entry.onHover || (entry.getTooltip && this._map.popupManager));
        if (!hasHover) return;

        // 3) Mobile: toggle. Desktop: обычно hover уже применён на pointermove,
        //    но подстрахуемся на случай «клика без движения».
        if (this._isMobile) {
            if (this._hoveredEntry === entry) {
                this._applyHover(null);
            } else {
                this._applyHover(entry);
            }
        } else if (this._hoveredEntry !== entry) {
            this._applyHover(entry);
        }
    }

    private _onPointerLeave(_e: PointerEvent): void {
        if (this._isMobile) return;
        this._applyHover(null);
    }
}