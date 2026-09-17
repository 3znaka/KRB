/**
 * Модуль единого менеджера взаимодействия для объектов на карте.
 *
 * Заменяет разрозненные static-реестры `Polygon._interactivePolygons` и
 * `Marker3D._mapEventHandlers` одним общим механизмом:
 *
 *  - один `THREE.Raycaster` на карту;
 *  - один throttled `pointermove` (≈30 Гц) для hover;
 *  - один `pointerdown` / `pointerup` для click/tap;
 *  - broad-phase через bounding sphere, чтобы не гонять полный
 *    raycast по всему миру на каждый чих;
 *  - отсечение «клика после драга» по порогу смещения указателя;
 *  - мобильный режим: hover не обновляется на `pointermove`,
 *    tooltip переключается тапом, пустой тап сбрасывает активный hover.
 *
 * Публичный API рассчитан на регистрацию любого объекта, у которого есть
 * 3D-представление (Mesh/Group/…). Полигон, 3D-маркер, Area3D — все они
 * регистрируются здесь, передавая одинаковый набор колбэков.
 *
 * @example
 * // Регистрация полигона
 * const unregister = map.interaction.register(polygon, {
 *     getMeshes: () => [polygon._fillMesh, polygon._sideMesh, polygon._bottomMesh]
 *         .filter(Boolean),
 *     getBoundingSphere: () => polygon._boundingSphereRadius > 0
 *         ? {
 *             center: polygon._tempVec3
 *                 .copy(polygon._group.position)
 *                 .add(map.worldGroup.position)
 *                 .clone(),
 *             radius: polygon._boundingSphereRadius
 *         }
 *         : null,
 *     onHover: (isHovered) => polygon._applyHover(isHovered, map),
 *     onClick: (event) => polygon._onClick && polygon._onClick(event, polygon),
 *     getTooltip: () => polygon._tooltipText || null,
 *     isVisible: () => polygon._group.visible
 * });
 *
 * // Позже
 * unregister();
 */
import { THREE } from '../js_TP/tpb.js';

/**
 * @typedef {Object} InteractionCallbacks
 * @property {() => (THREE.Object3D[]|null)} getMeshes - Возвращает список мешей
 *     для raycast. Может вернуть пустой массив или null — тогда объект
 *     пропускается.
 * @property {() => ({center: THREE.Vector3, radius: number}|null)} [getBoundingSphere] -
 *     Возвращает мировую bounding-сферу для broad-phase. `null` — без отсечения.
 * @property {(isHovered: boolean) => void} [onHover] - Колбэк изменения hover.
 *     Если задан — приоритетнее tooltip-логики.
 * @property {(event: PointerEvent|MouseEvent) => void} [onClick] - Колбэк клика.
 *     Вызывается только если клик не был драгом.
 * @property {() => (string|null)} [getTooltip] - Возвращает HTML-строку тултипа
 *     (или null). Показывается через `map.popupManager`, если не задан `onHover`.
 * @property {() => boolean} [isVisible] - Дополнительный фильтр видимости.
 *     Не вызывается, если объект уже отсечён по min/maxZoom у себя внутри.
 * @property {boolean} [isMobileOnly] - Если true, объект участвует только
 *     в мобильном тач-режиме (например, крупные hit-area).
 */

/**
 * Менеджер взаимодействия (один на карту).
 *
 * Создаётся автоматически в `KrbMap` как `map.interaction`.
 */
export class InteractionManager {
    /**
     * @param {import('./KrbMap.js').KrbMap} map - Экземпляр карты.
     */
    constructor(map) {
        /** @private @type {import('./KrbMap.js').KrbMap} */
        this._map = map;

        /**
         * Зарегистрированные записи. `Set` — чтобы порядок обхода был
         * стабильным (порядок регистрации), а удаление — O(1).
         * @private
         * @type {Set<Object>}
         */
        this._entries = new Set();

        /**
         * Маппинг Object3D → entry, строится на каждый raycast.
         * Позволяет восстановить владельца по `intersection.object`.
         * @private
         * @type {Map<THREE.Object3D, Object>}
         */
        this._meshToEntry = new Map();

        /** @private @type {THREE.Raycaster} */
        this._raycaster = new THREE.Raycaster();

        /** @private @type {THREE.Vector2} */
        this._mouseNDC = new THREE.Vector2();

        /** @private @type {THREE.Sphere} */
        this._broadPhaseSphere = new THREE.Sphere();

        /** @private @type {number} */
        this._lastRaycastTime = 0;

        /**
         * Троттлинг hover-raycast в миллисекундах.
         * 33 мс ≈ 30 Гц — выше смысла нет: мышь всё равно шлёт чаще,
         * а между кадрами результат не меняется.
         * @private
         * @type {number}
         */
        this._raycastThrottleMs = 33;

        /** @private @type {number} */
        this._pointerDownX = 0;
        /** @private @type {number} */
        this._pointerDownY = 0;
        /** @private @type {boolean} */
        this._pointerDownActive = false;

        /**
         * Порог смещения указателя (в пикселях) между pointerdown и
         * pointerup, выше которого событие считается драгом, а не кликом.
         * @private
         * @type {number}
         */
        this._clickMoveThreshold = 5;

        /**
         * Запись, которая сейчас находится под курсором (desktop) или
         * последняя «включённая» тапом (mobile).
         * @private
         * @type {Object|null}
         */
        this._hoveredEntry = null;

        /**
         * Запись, по которой произошёл pointerdown (для mobile-сценария,
         * когда мы не делаем raycast на move).
         * @private
         * @type {Object|null}
         */
        this._pressedEntry = null;

        /** @private @type {?Object} */
        this._handlers = null;

        /** @private @type {boolean} */
        this._attached = false;

        /**
         * Кэш «мобильности» устройства. Вычисляется один раз при первой
         * регистрации (после того, как DOM готов).
         * @private
         * @type {boolean}
         */
        this._isMobile = false;
        /** @private @type {boolean} */
        this._isMobileResolved = false;
    }

    /* ================================================================
       Публичный API
       ================================================================ */

    /**
     * Регистрирует объект для обработки событий указателя.
     *
     * Если объект уже зарегистрирован — старая запись заменяется на новую
     * (это позволяет «обновлять» колбэки без явного unregister).
     *
     * @param {Object} obj - Произвольный объект-владелец (Polygon, Marker3D,
     *     Area3D, …). Не обязан быть `THREE.Object3D`.
     * @param {InteractionCallbacks} callbacks - Колбэки.
     * @returns {() => void} Функция отмены регистрации (эквивалент
     *     `this.unregister(obj)`). Удобно сохранить и вызвать в `remove()`.
     */
    register(obj, callbacks) {
        if (!obj || !callbacks || typeof callbacks.getMeshes !== 'function') {
            console.warn('InteractionManager.register: obj and callbacks.getMeshes are required');
            return () => {};
        }

        // Если уже был — снимаем старую запись.
        this.unregister(obj);

        const entry = {
            obj,
            getMeshes: callbacks.getMeshes,
            getBoundingSphere: callbacks.getBoundingSphere || null,
            onHover: callbacks.onHover || null,
            onClick: callbacks.onClick || null,
            getTooltip: callbacks.getTooltip || null,
            isVisible: callbacks.isVisible || null,
            isMobileOnly: callbacks.isMobileOnly === true,
            wasHovered: false
        };
        this._entries.add(entry);

        this._ensureListeners();
        return () => this.unregister(obj);
    }

    /**
     * Снимает регистрацию объекта.
     *
     * Если объект был в состоянии hover — вызывается `onHover(false)`
     * (или скрывается popup). После удаления последней записи слушатели
     * снимаются с canvas.
     *
     * @param {Object} obj - Тот же объект, что передан в `register`.
     * @returns {void}
     */
    unregister(obj) {
        for (const entry of this._entries) {
            if (entry.obj !== obj) continue;

            if (entry.wasHovered) {
                entry.wasHovered = false;
                if (entry.onHover) {
                    try { entry.onHover(false); } catch (e) { /* swallow */ }
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
     *
     * @returns {void}
     */
    destroy() {
        for (const entry of this._entries) {
            if (entry.wasHovered) {
                entry.wasHovered = false;
                if (entry.onHover) {
                    try { entry.onHover(false); } catch (e) { /* swallow */ }
                }
            }
        }
        this._entries.clear();
        this._meshToEntry.clear();
        this._hoveredEntry = null;
        this._pressedEntry = null;
        this._detachListeners();
    }

    /* ================================================================
       Внутренняя механика
       ================================================================ */

    /**
     * Ленивое определение «мобильности» устройства.
     * @private
     */
    _resolveMobileFlag() {
        if (this._isMobileResolved) return;
        try {
            this._isMobile = window.matchMedia('(hover: none) and (pointer: coarse)').matches;
        } catch (e) {
            this._isMobile = false;
        }
        this._isMobileResolved = true;
    }

    /**
     * Устанавливает слушатели на canvas карты (идемпотентно).
     * @private
     */
    _ensureListeners() {
        if (this._attached) return;
        const canvas = this._map.renderer?.domElement;
        if (!canvas) return;

        this._resolveMobileFlag();

        this._handlers = {
            pointerdown: (e) => this._onPointerDown(e),
            pointermove: (e) => this._onPointerMove(e),
            pointerup: (e) => this._onPointerUp(e),
            pointerleave: (e) => this._onPointerLeave(e)
        };

        // capture=true — гарантированно до OrbitControls, чтобы hover
        // не сбивался при начале панорамирования.
        canvas.addEventListener('pointerdown', this._handlers.pointerdown, true);
        canvas.addEventListener('pointermove', this._handlers.pointermove, true);
        canvas.addEventListener('pointerup', this._handlers.pointerup, true);
        canvas.addEventListener('pointerleave', this._handlers.pointerleave, true);
        this._attached = true;
    }

    /**
     * Снимает слушатели с canvas.
     * @private
     */
    _detachListeners() {
        if (!this._attached) return;
        const canvas = this._map.renderer?.domElement;
        if (canvas && this._handlers) {
            canvas.removeEventListener('pointerdown', this._handlers.pointerdown, true);
            canvas.removeEventListener('pointermove', this._handlers.pointermove, true);
            canvas.removeEventListener('pointerup', this._handlers.pointerup, true);
            canvas.removeEventListener('pointerleave', this._handlers.pointerleave, true);
        }
        this._handlers = null;
        this._attached = false;
    }

    /**
     * Переводит экранные координаты события в NDC.
     * @private
     * @param {PointerEvent|MouseEvent} event
     */
    _setNDCFromEvent(event) {
        const rect = this._map.renderer.domElement.getBoundingClientRect();
        this._mouseNDC.set(
            ((event.clientX - rect.left) / rect.width) * 2 - 1,
            -((event.clientY - rect.top) / rect.height) * 2 + 1
        );
    }

    /**
     * Собирает меши всех видимых записей, прошедших broad-phase.
     * Параллельно строит `_meshToEntry` и сбрасывает hover у отсечённых.
     *
     * @private
     * @returns {THREE.Object3D[]}
     */
    _collectMeshes() {
        this._meshToEntry.clear();
        const meshes = [];
        const ray = this._raycaster.ray;

        for (const entry of this._entries) {
            // 1) Пользовательский фильтр видимости.
            if (entry.isVisible) {
                let visible = false;
                try { visible = entry.isVisible(); } catch (e) { visible = false; }
                if (!visible) {
                    this._clearEntryHover(entry);
                    continue;
                }
            }

            // 2) Мобильный фильтр.
            if (entry.isMobileOnly && !this._isMobile) {
                this._clearEntryHover(entry);
                continue;
            }

            // 3) Broad-phase по bounding sphere.
            if (entry.getBoundingSphere) {
                let bs = null;
                try { bs = entry.getBoundingSphere(); } catch (e) { bs = null; }
                if (bs && bs.center && typeof bs.radius === 'number') {
                    this._broadPhaseSphere.set(bs.center, bs.radius);
                    if (!ray.intersectsSphere(this._broadPhaseSphere)) {
                        this._clearEntryHover(entry);
                        continue;
                    }
                }
            }

            // 4) Собственно меши.
            let objMeshes = null;
            try { objMeshes = entry.getMeshes(); } catch (e) { objMeshes = null; }
            if (!objMeshes || objMeshes.length === 0) {
                this._clearEntryHover(entry);
                continue;
            }
            for (let i = 0; i < objMeshes.length; i++) {
                const m = objMeshes[i];
                if (!m) continue;
                meshes.push(m);
                this._meshToEntry.set(m, entry);
            }
        }

        return meshes;
    }

    /**
     * Сбрасывает hover у записи, если он был активен.
     * @private
     * @param {Object} entry
     */
    _clearEntryHover(entry) {
        if (!entry.wasHovered) return;
        entry.wasHovered = false;
        if (entry.onHover) {
            try { entry.onHover(false); } catch (e) { /* swallow */ }
        } else if (entry.getTooltip && this._map.popupManager) {
            this._map.popupManager.hide();
        }
        if (this._hoveredEntry === entry) this._hoveredEntry = null;
    }

    /**
     * Выполняет raycast из текущего NDC и возвращает верхнюю запись
     * (или null, если попаданий нет).
     *
     * @private
     * @returns {{entry: Object, hit: Object}|null}
     */
    _raycast() {
        this._raycaster.setFromCamera(this._mouseNDC, this._map.camera);
        const meshes = this._collectMeshes();
        if (meshes.length === 0) return null;

        const hits = this._raycaster.intersectObjects(meshes, false);
        for (let i = 0; i < hits.length; i++) {
            const entry = this._meshToEntry.get(hits[i].object);
            if (entry) return { entry, hit: hits[i] };
        }
        return null;
    }

    /**
     * Применяет новое состояние hover. Если запись не изменилась —
     * ничего не делает.
     *
     * @private
     * @param {Object|null} newEntry
     */
    _applyHover(newEntry) {
        if (this._hoveredEntry === newEntry) return;

        // Снимаем hover со старой.
        const old = this._hoveredEntry;
        if (old) {
            old.wasHovered = false;
            if (old.onHover) {
                try { old.onHover(false); } catch (e) { /* swallow */ }
            } else if (old.getTooltip && this._map.popupManager) {
                this._map.popupManager.hide();
            }
        }

        // Ставим hover на новую.
        this._hoveredEntry = newEntry;
        if (newEntry) {
            newEntry.wasHovered = true;
            if (newEntry.onHover) {
                try { newEntry.onHover(true); } catch (e) { /* swallow */ }
            } else if (newEntry.getTooltip && this._map.popupManager) {
                let text = null;
                try { text = newEntry.getTooltip(); } catch (e) { text = null; }
                if (text) this._map.popupManager.show(newEntry.obj, text);
            }
        }
    }

    /* ================================================================
       Обработчики событий
       ================================================================ */

    /**
     * @private
     * @param {PointerEvent} e
     */
    _onPointerDown(e) {
        this._pointerDownX = e.clientX;
        this._pointerDownY = e.clientY;
        this._pointerDownActive = true;

        // На мобильных сразу raycast’им, чтобы на pointerup знать,
        // по кому именно тапнули (move там не помогает — hover не отслеживаем).
        if (this._isMobile) {
            this._setNDCFromEvent(e);
            const result = this._raycast();
            this._pressedEntry = result ? result.entry : null;
        }
    }

    /**
     * @private
     * @param {PointerEvent} e
     */
    _onPointerMove(e) {
        // На мобильных hover не отслеживаем — только тап.
        if (this._isMobile) return;

        const now = performance.now();
        if (now - this._lastRaycastTime < this._raycastThrottleMs) return;
        this._lastRaycastTime = now;

        this._setNDCFromEvent(e);
        const result = this._raycast();
        this._applyHover(result ? result.entry : null);
    }

    /**
     * @private
     * @param {PointerEvent} e
     */
    _onPointerUp(e) {
        const hadPointerDown = this._pointerDownActive;
        const pressedEntry = this._pressedEntry;
        this._pointerDownActive = false;
        this._pressedEntry = null;

        if (!hadPointerDown) return;

        // Отсечение «клик после драга».
        const dx = e.clientX - this._pointerDownX;
        const dy = e.clientY - this._pointerDownY;
        const threshold = this._clickMoveThreshold;
        if (dx * dx + dy * dy > threshold * threshold) {
            return;
        }

        // Определяем, по кому клик.
        let entry = null;
        if (this._isMobile) {
            entry = pressedEntry;
        } else {
            this._setNDCFromEvent(e);
            const result = this._raycast();
            entry = result ? result.entry : null;
        }

        if (!entry) {
            // Клик по пустому месту.
            if (this._isMobile && this._hoveredEntry) {
                this._applyHover(null);
            }
            return;
        }

        // Приоритет: onClick → tooltip-тап (mobile) → hover (desktop,
        // если почему-то hover ещё не был выставлен).
        if (entry.onClick) {
            try { entry.onClick(e, entry.obj); } catch (err) {
                console.error('InteractionManager.onClick threw:', err);
            }
            return;
        }

        if (entry.getTooltip && this._map.popupManager) {
            if (this._isMobile) {
                // Тап — тумблер: если уже открыт — закрыть, иначе открыть.
                if (this._hoveredEntry === entry) {
                    this._applyHover(null);
                } else {
                    this._applyHover(entry);
                }
            } else {
                // На десктопе tooltip обычно уже показан через hover.
                if (this._hoveredEntry !== entry) {
                    this._applyHover(entry);
                }
            }
        }
    }

    /**
     * @private
     * @param {PointerEvent} e
     */
    _onPointerLeave(e) {
        if (this._isMobile) return;
        this._applyHover(null);
    }
}