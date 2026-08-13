/**
 * Модуль 3D-маркера для картографической библиотеки на three.js.
 * Поддерживает примитивы (куб, сфера, цилиндр, конус) и GLB-модели.
 * Обладает свойствами обычного маркера: position, minZoom, maxZoom, title, tooltip, события.
 * Реализованы:
 * - anchor point для точной привязки объекта к координате;
 * - raycasting для событий onClick и onHover.
 *
 * @module 3dMarker
 */

import { THREE } from '../js_TP/tpb.js';
import { proj } from './Utils.js';
import { Layer } from './Layers.js';

const MARKER_RENDER_ORDER = 1000; // Выше любого уровня зума тайлов

/**
 * Класс 3D-маркера.
 * Добавляется в Layer аналогично обычному Marker.
 *
 * @example
 * const marker3d = new Marker3D({
 *   position: [37.6178, 55.7558],
 *   primitiveType: 'box',
 *   size: [1000, 500, 1000],
 *   anchor: [0.5, 0, 0.5], // низ по центру
 *   altitude: 200,
 *   altitudeMode: 'clampToGround',
 *   minZoom: 5,
 *   maxZoom: 12,
 *   title: '3D объект',
 *   onClick: (e, marker) => console.log('Клик по 3D объекту')
 * });
 * marker3d.addTo(map);
 */
export class Marker3D {
    /** @private */ static _idCounter = 0;
    /** @private */ static _activeMarkers = new Set();
    /** @private */ static _hoveredMarker = null;
    /** @private */ static _pressedMarker = null;
    /** @private */ static _pressStart = null;
    /** @private */ static _raycaster = new THREE.Raycaster();
    /** @private */ static _mapEventHandlers = new WeakMap();

    /**
     * @param {Object} options - Настройки 3D-маркера.
     * @param {[number, number]} options.position - Географические координаты [lon, lat].
     * @param {string} [options.primitiveType='box'] - Тип примитива: 'box', 'sphere', 'cylinder', 'cone'.
     * @param {[number, number, number]} [options.size=[100,100,100]] - Размеры объекта: [width, height, depth] в метрах.
     * @param {string} [options.modelUrl] - URL GLB-модели. Если указан, примитив игнорируется.
     * @param {number} [options.altitude=0] - Высота над поверхностью (если altitudeMode='clampToGround') или абсолютная высота (если altitudeMode='absolute').
     * @param {string} [options.altitudeMode='clampToGround'] - Режим высоты: 'clampToGround' (прижат к рельефу), 'absolute' (абсолютная высота в мировых координатах Y).
     * @param {[number, number, number]} [options.rotation=[0,0,0]] - Углы поворота в радианах [x, y, z].
     * @param {[number, number, number]} [options.anchor=[0.5,0,0.5]] - Точка привязки объекта: нормализованные координаты внутри bounding box ([0..1] по каждой оси, где 0 – низ/лево/зад, 1 – верх/право/перед).
     * @param {number} [options.minZoom=-Infinity] - Минимальный зум видимости.
     * @param {number} [options.maxZoom=Infinity] - Максимальный зум видимости.
     * @param {string} [options.title=''] - Текст постоянной подписи (отображается через TextManager).
     * @param {Object} [options.titleStyle] - Стили подписи (как у Marker).
     * @param {number} [options.titleMinZoom=-Infinity] - Мин. зум для подписи.
     * @param {number} [options.titleMaxZoom=Infinity] - Макс. зум для подписи.
     * @param {string} [options.tooltip=''] - Текст всплывающей подсказки (HTML).
     * @param {Function} [options.onClick] - Обработчик клика по объекту (получает событие и маркер).
     * @param {Function} [options.onHover] - Обработчик наведения (получает true/false).
     * @param {boolean} [options.clusterable=false] - 3D-маркеры по умолчанию не участвуют в кластеризации.
     */
    constructor(options = {}) {
        if (!options.position || options.position.length !== 2) {
            throw new Error('Marker3D: options.position is required [lon, lat]');
        }

        /** @private */ this._lon = options.position[0];
        /** @private */ this._lat = options.position[1];
        /** @private */ this._primitiveType = options.primitiveType || 'box';
        /** @private */ this._size = options.size || [100, 100, 100];
        /** @private */ this._modelUrl = options.modelUrl || null;
        /** @private */ this._altitude = options.altitude || 0;
        /** @private */ this._altitudeMode = options.altitudeMode || 'clampToGround';
        /** @private */ this._rotation = options.rotation || [0, 0, 0];
        /** @private */ this._anchor = options.anchor || [0.5, 0, 0.5]; // по умолчанию низ по центру
        /** @private */ this._minZoom = options.minZoom ?? -Infinity;
        /** @private */ this._maxZoom = options.maxZoom ?? Infinity;

        // Свойства подписи (аналогично обычному Marker)
        /** @private */ this._title = options.title || '';
        /** @private */ this._titleStyle = options.titleStyle || {};
        /** @private */ this._titleMinZoom = options.titleMinZoom ?? -Infinity;
        /** @private */ this._titleMaxZoom = options.titleMaxZoom ?? Infinity;
        /** @private */ this._titleAlign = options.titleAlign || 'center';
        /** @private */ this._titleOffset = options.titleOffset || [0, this._size[1] / 2 + 10];

        /** @private */ this._tooltipText = options.tooltip || '';
        /** @private */ this._onClick = options.onClick || null;
        /** @private */ this._onHover = options.onHover || null;
        /** @private */ this._clusterable = options.clusterable !== undefined ? options.clusterable : false;
        /** @private */ this._color = options.color || 0x3388ff; // цвет примитива

        /** @private */ this._map = null;
        /** @private */ this._layer = null;
        /** @private */ this._object3D = null;      // THREE.Object3D (Mesh или Group)
        /** @private */ this._geometry = null;
        /** @private */ this._material = null;
        /** @private */ this._textLabel = null;     // дескриптор TextManager
        /** @private */ this._tooltipElement = null; // DOM-элемент тултипа
        /** @private */ this._isVisible = false;
        /** @private */ this._lastHeightUpdateTime = 0;
        /** @private */ this._cachedWorldY = 0;
        /** @private */ this._isModelLoading = false;
        /** @private */ this._modelPromise = null;
        /** @private */ this._worldPosition = new THREE.Vector3(); // Мировая позиция (с учётом worldGroup)
    }

    /**
     * Удобный метод: создаёт персональный слой, добавляет его на карту
     * и помещает в него данный 3D-маркер.
     * @param {Object} map - Экземпляр карты.
     * @returns {Marker3D} this
     */
    addTo(map) {
        if (this._map) this.remove();
        const personalLayer = new Layer();
        personalLayer.addTo(map);
        personalLayer.add(this);
        return this;
    }

    /**
     * Внутренний метод, вызываемый слоем при добавлении.
     * Создаёт 3D-объект, загружает модель при необходимости, регистрирует подпись.
     * @param {Object} map - Карта.
     * @param {Layer} layer - Слой-владелец.
     * @private
     */
    _attach(map, layer) {
        if (this._map === map && this._layer === layer) return;
        this.remove();
        this._map = map;
        this._layer = layer;

        // Создание 3D-объекта
        if (this._modelUrl) {
            this._object3D = new THREE.Group(); // заглушка, пока модель не загрузится
            this._isModelLoading = true;
            this._loadModel();
        } else {
            this._createPrimitive();
        }
        this._object3D.rotation.set(...this._rotation);
        map.worldGroup.add(this._object3D);

        // Регистрация в списке активных маркеров для рейкастинга
        Marker3D._activeMarkers.add(this);
        this._registerGlobalEvents(map);

        // Регистрация подписи в TextManager (если есть текст)
        if (this._title && this._map.textManager) {
            this._textLabel = this._map.textManager.addLabel(this);
        }

        // Создание DOM-тултипа (по аналогии с Marker)
        if (this._tooltipText) {
            const { tooltipPane } = this._getPanes(map);
            const tip = document.createElement('div');
            tip.className = 'krb-marker-tooltip';
            Object.assign(tip.style, {
                position: 'absolute', display: 'none', background: 'white', border: '1px solid #767676',
                padding: '4px 8px', borderRadius: '4px', whiteSpace: 'normal', fontSize: '14px',
                transform: 'translate(-50%, -100%)', pointerEvents: 'none', boxShadow: '0 2px 4px rgba(0,0,0,0.2)'
            });
            tip.innerHTML = this._tooltipText;
            tooltipPane.appendChild(tip);
            this._tooltipElement = tip;
        }
    }

    /**
     * Создаёт примитивный меш на основе primitiveType и size.
     * Применяет anchor point.
     * @private
     */
    _createPrimitive() {
        const [w, h, d] = this._size;
        let geometry;
        switch (this._primitiveType.toLowerCase()) {
            case 'sphere':
                geometry = new THREE.SphereGeometry(w / 2, 32, 32);
                break;
            case 'cylinder':
                geometry = new THREE.CylinderGeometry(w / 2, w / 2, h, 32);
                break;
            case 'cone':
                geometry = new THREE.ConeGeometry(w / 2, h, 32);
                break;
            case 'box':
            default:
                geometry = new THREE.BoxGeometry(w, h, d);
                break;
        }
        const material = new THREE.MeshStandardMaterial({ color: this._color, roughness: 0.5 });
        const mesh = new THREE.Mesh(geometry, material);

        // Применяем anchor: смещаем меш так, чтобы указанная точка объекта совпала с началом координат
        const offset = new THREE.Vector3(
            (0.5 - this._anchor[0]) * w,
            (0.5 - this._anchor[1]) * h,
            (0.5 - this._anchor[2]) * d
        );
        geometry.translate(offset.x, offset.y, offset.z);

        mesh.renderOrder = MARKER_RENDER_ORDER;
        this._geometry = geometry;
        this._material = material;
        this._object3D = mesh;
    }

    /**
     * Загружает GLB-модель с помощью динамического импорта GLTFLoader с CDN.
     * Применяет anchor point после загрузки.
     * @private
     */
    async _loadModel() {
        if (this._modelPromise) return this._modelPromise;
        this._modelPromise = (async () => {
            try {
                const gltfModule = await import('https://unpkg.com/three@0.160.0/examples/jsm/loaders/GLTFLoader.js');
                const GLTFLoader = gltfModule.GLTFLoader;
                const loader = new GLTFLoader();
                const gltf = await loader.loadAsync(this._modelUrl);
                const model = gltf.scene;

                // Применяем anchor point
                if (this._anchor) {
                    const box = new THREE.Box3().setFromObject(model);
                    const size = box.getSize(new THREE.Vector3());
                    const anchorPoint = new THREE.Vector3(
                        box.min.x + this._anchor[0] * size.x,
                        box.min.y + this._anchor[1] * size.y,
                        box.min.z + this._anchor[2] * size.z
                    );
                    model.position.sub(anchorPoint);
                }

                // Устанавливаем renderOrder для всех мешей
                model.traverse((child) => {
                    if (child.isMesh) {
                        child.renderOrder = MARKER_RENDER_ORDER;
                        child.castShadow = true;
                        child.receiveShadow = true;
                    }
                });

                if (this._object3D) {
                    const parent = this._object3D.parent;
                    if (parent) {
                        parent.remove(this._object3D);
                        this._object3D = model;
                        model.rotation.set(...this._rotation);
                        parent.add(model);
                    }
                }
                this._isModelLoading = false;
            } catch (err) {
                console.warn('Marker3D: GLB model loading failed:', err);
                this._isModelLoading = false;
            }
        })();
        return this._modelPromise;
    }

    /**
     * Регистрирует глобальные обработчики событий для рейкастинга на canvas карты.
     * @param {Object} map - Карта.
     * @private
     */
    _registerGlobalEvents(map) {
        if (Marker3D._mapEventHandlers.has(map)) return;

        const domElement = map.renderer.domElement;

        const handlers = {
            pointermove: (e) => this._onPointerMove(e, map),
            pointerdown: (e) => this._onPointerDown(e, map),
            pointerup: (e) => this._onPointerUp(e, map),
            pointerleave: (e) => this._onPointerLeave(e, map)
        };

        domElement.addEventListener('pointermove', handlers.pointermove);
        domElement.addEventListener('pointerdown', handlers.pointerdown);
        domElement.addEventListener('pointerup', handlers.pointerup);
        domElement.addEventListener('pointerleave', handlers.pointerleave);

        Marker3D._mapEventHandlers.set(map, handlers);
    }

    /**
     * Получение NDC координат из события указателя.
     * @param {PointerEvent} e - Событие.
     * @param {Object} map - Карта.
     * @returns {THREE.Vector2}
     * @private
     */
    _getNDC(e, map) {
        const rect = map.renderer.domElement.getBoundingClientRect();
        const x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
        const y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
        return new THREE.Vector2(x, y);
    }

    /**
     * Находит 3D-маркер под курсором.
     * @param {THREE.Vector2} mouse - NDC координаты.
     * @param {Object} map - Карта.
     * @returns {Marker3D|null}
     * @private
     */
    _getMarkerUnderPointer(mouse, map) {
        const raycaster = Marker3D._raycaster;
        raycaster.setFromCamera(mouse, map.camera);
        const candidates = [];
        for (const marker of Marker3D._activeMarkers) {
            if (marker._map !== map || !marker._isVisible || !marker._object3D) continue;
            const hits = raycaster.intersectObject(marker._object3D, true);
            if (hits.length > 0) {
                candidates.push({ marker, hit: hits[0] });
            }
        }
        if (candidates.length === 0) return null;
        candidates.sort((a, b) => a.hit.distance - b.hit.distance);
        return candidates[0].marker;
    }

    /**
     * Обработчик pointermove: обновляет hover-состояние.
     * @param {PointerEvent} e - Событие.
     * @param {Object} map - Карта.
     * @private
     */
    _onPointerMove(e, map) {
        const mouse = this._getNDC(e, map);
        const marker = this._getMarkerUnderPointer(mouse, map);
        if (marker !== Marker3D._hoveredMarker) {
            if (Marker3D._hoveredMarker) {
                if (Marker3D._hoveredMarker._onHover) {
                    Marker3D._hoveredMarker._onHover(false);
                } else {
                    Marker3D._hoveredMarker.hideTooltip();
                }
            }
            if (marker) {
                if (marker._onHover) {
                    marker._onHover(true);
                } else {
                    marker.showTooltip();
                }
            }
            Marker3D._hoveredMarker = marker;
        }
    }

    /**
     * Обработчик pointerdown: запоминает маркер и координаты для клика.
     * @param {PointerEvent} e - Событие.
     * @param {Object} map - Карта.
     * @private
     */
    _onPointerDown(e, map) {
        const mouse = this._getNDC(e, map);
        const marker = this._getMarkerUnderPointer(mouse, map);
        if (marker) {
            Marker3D._pressedMarker = marker;
            Marker3D._pressStart = { x: e.clientX, y: e.clientY };
        } else {
            Marker3D._pressedMarker = null;
            Marker3D._pressStart = null;
        }
    }

    /**
     * Обработчик pointerup: если было короткое нажатие без перемещения, вызывает onClick.
     * @param {PointerEvent} e - Событие.
     * @param {Object} map - Карта.
     * @private
     */
    _onPointerUp(e, map) {
        const pressed = Marker3D._pressedMarker;
        const start = Marker3D._pressStart;
        Marker3D._pressedMarker = null;
        Marker3D._pressStart = null;
        if (!pressed || !start) return;

        const dx = e.clientX - start.x;
        const dy = e.clientY - start.y;
        const dist = Math.sqrt(dx * dx + dy * dy);
        if (dist > 5) return; // клик не засчитывается, если было перемещение

        if (pressed._onClick) {
            pressed._onClick(e, pressed);
        }
        // Если нет обработчика, можно выполнить действие по умолчанию (например, переместить камеру)
    }

    /**
     * Обработчик pointerleave: сбрасывает hover.
     * @param {PointerEvent} e - Событие.
     * @param {Object} map - Карта.
     * @private
     */
    _onPointerLeave(e, map) {
        if (Marker3D._hoveredMarker) {
            if (Marker3D._hoveredMarker._onHover) {
                Marker3D._hoveredMarker._onHover(false);
            } else {
                Marker3D._hoveredMarker.hideTooltip();
            }
            Marker3D._hoveredMarker = null;
        }
    }

    /**
     * Получение DOM-панелей маркера (аналогично Marker._getPanes).
     * @param {Object} map - Карта.
     * @returns {{markerPane: HTMLElement, tooltipPane: HTMLElement}}
     * @private
     */
    _getPanes(map) {
        // Используем глобальную WeakMap из Marker.js для единообразия
        if (!Marker3D._panesMap) Marker3D._panesMap = new WeakMap();
        let panes = Marker3D._panesMap.get(map);
        if (!panes) {
            const target = map.targetElement;
            const markerPane = document.createElement('div');
            markerPane.id = 'krb-marker-pane';
            Object.assign(markerPane.style, {
                position: 'absolute', top: '0', left: '0', width: '100%', height: '100%',
                pointerEvents: 'none', zIndex: '600'
            });
            target.appendChild(markerPane);

            const tooltipPane = document.createElement('div');
            tooltipPane.id = 'krb-tooltip-pane';
            Object.assign(tooltipPane.style, {
                position: 'absolute', top: '0', left: '0', width: '100%', height: '100%',
                pointerEvents: 'none', zIndex: '650'
            });
            target.appendChild(tooltipPane);

            panes = { markerPane, tooltipPane };
            Marker3D._panesMap.set(map, panes);
        }
        return panes;
    }

    /**
     * Удаляет 3D-маркер с карты.
     */
    remove() {
        if (this._object3D) {
            if (this._object3D.parent) this._object3D.parent.remove(this._object3D);
            if (this._geometry) this._geometry.dispose();
            if (this._material) this._material.dispose();
            this._object3D = null;
            this._geometry = null;
            this._material = null;
        }
        if (Marker3D._activeMarkers.has(this)) {
            Marker3D._activeMarkers.delete(this);
        }
        if (Marker3D._hoveredMarker === this) {
            if (this._onHover) this._onHover(false);
            else this.hideTooltip();
            Marker3D._hoveredMarker = null;
        }
        if (Marker3D._pressedMarker === this) {
            Marker3D._pressedMarker = null;
            Marker3D._pressStart = null;
        }
        if (this._textLabel && this._map?.textManager) {
            this._map.textManager.removeLabel(this._textLabel);
            this._textLabel = null;
        }
        if (this._tooltipElement) {
            this._tooltipElement.remove();
            this._tooltipElement = null;
        }
        if (this._layer) {
            this._layer._removeRef(this);
            this._layer = null;
        }
        this._map = null;
        this._isVisible = false;
        this._worldPosition.set(0, 0, 0);
    }

    /**
     * Обновляет позицию и видимость 3D-маркера. Вызывается картой каждый кадр.
     * @param {Object} map - Экземпляр карты (может не совпадать с this._map, если передан извне).
     * @private
     */
    _update(map) {
        if (!this._map || !this._object3D) return;
        const mapInstance = this._map; // используем внутреннюю ссылку
        const zoom = mapInstance.continuousZoom;

        // Проверка видимости по зуму и слою
        if (this._layer && !this._layer.visible) {
            this._object3D.visible = false;
            this._isVisible = false;
            return;
        }
        if (zoom < this._minZoom || zoom > this._maxZoom) {
            this._object3D.visible = false;
            this._isVisible = false;
            return;
        }

        // Абсолютные координаты в проекции Меркатора
        const [absWorldX, absWorldZ] = proj.fromLonLat([this._lon, this._lat]);
        const wgPos = mapInstance.worldGroup.position;

        // Мировые координаты (с учётом сдвига worldGroup)
        const worldX = absWorldX + wgPos.x;
        const worldZ = absWorldZ + wgPos.z;

        let worldY = 0;
        if (this._altitudeMode === 'clampToGround') {
            const now = performance.now();
            if (now - this._lastHeightUpdateTime > 500) {
                mapInstance.ensureTileForPoint(worldX, worldZ);
                this._cachedWorldY = mapInstance.getSurfaceHeightAt(worldX, worldZ);
                this._lastHeightUpdateTime = now;
            }
            worldY = this._cachedWorldY + this._altitude;
        } else if (this._altitudeMode === 'absolute') {
            worldY = this._altitude;
        } else {
            worldY = this._altitude;
        }

        // Объект является ребёнком worldGroup, поэтому позиция задаётся
        // в локальных координатах относительно worldGroup (без wgPos.x/z).
        this._object3D.position.set(absWorldX, worldY, absWorldZ);

        // Сохраняем мировую позицию для расчёта дальности, тултипа, подписи
        this._worldPosition.set(worldX, worldY, worldZ);

        // Дальность отрисовки
        if (mapInstance.view.objectDistanceFactor > 0) {
            const dist = mapInstance.camera.position.distanceTo(this._worldPosition);
            if (dist > mapInstance.maxObjectDistance) {
                this._object3D.visible = false;
                this._isVisible = false;
                return;
            }
        }

        this._object3D.visible = true;
        this._isVisible = true;

        // Обновление тултипа (если он отображается)
        if (this._tooltipElement && this._tooltipElement.style.display === 'block') {
            const screenPos = this._worldPosition.clone().project(mapInstance.camera);
            const canvas = mapInstance.renderer.domElement;
            const x = (screenPos.x * 0.5 + 0.5) * canvas.clientWidth;
            const y = (-screenPos.y * 0.5 + 0.5) * canvas.clientHeight;
            this._tooltipElement.style.left = x + 'px';
            this._tooltipElement.style.top = y + 'px';
        }
    }

    // ---------- Интерфейс для TextManager ----------

    /** @returns {string} Текст подписи */
    getText() { return this._title; }

    /** @returns {Object} Стили подписи */
    getTextStyle() {
        return Object.assign({
            fontFamily: 'sans-serif',
            color: '#333',
            fontSize: '12px',
            textAlign: this._titleAlign
        }, this._titleStyle);
    }

    /** @returns {{min: number, max: number}} Границы зума для подписи */
    getTextZoomBounds() { return { min: this._titleMinZoom, max: this._titleMaxZoom }; }

    /** @returns {string} Тип подписи ('point') */
    getLabelType() { return 'point'; }

    /** @returns {boolean} Видим ли маркер в текущем кадре */
    isVisible() { return this._isVisible; }

    /**
     * Возвращает позицию на экране для отображения подписи.
     * @returns {{x: number, y: number}|null}
     */
    getScreenPosition() {
        if (!this._isVisible || !this._worldPosition) return null;
        const screenPos = this._worldPosition.clone().project(this._map.camera);
        const canvas = this._map.renderer.domElement;
        return {
            x: (screenPos.x * 0.5 + 0.5) * canvas.clientWidth,
            y: (-screenPos.y * 0.5 + 0.5) * canvas.clientHeight
        };
    }

    /** @returns {string} Выравнивание подписи */
    getTitleAlign() { return this._titleAlign; }

    /** @returns {[number, number]} Смещение подписи */
    getTitleOffset() { return this._titleOffset; }

    /** @returns {string} Вертикальное выравнивание */
    getTitleVerticalAlign() { return 'center'; }

    /** @returns {boolean} Разрешать ли выход за границы */
    getAllowOverflow() { return false; }

    /** @returns {number} Приоритет подписи */
    getPriority() { return 0; }

    /** @returns {boolean} Участвует ли в кластеризации */
    getClusterable() { return this._clusterable; }

    // ---------- Вспомогательные методы ----------

    /** Показать тултип */
    showTooltip() { if (this._tooltipElement) this._tooltipElement.style.display = 'block'; }

    /** Скрыть тултип */
    hideTooltip() { if (this._tooltipElement) this._tooltipElement.style.display = 'none'; }


/**
 * Устанавливает цвет примитива.
 * @param {string|number} color - Цвет в формате HEX-строки или числа.
 */
setColor(color) {
    this._color = color;
    if (this._object3D && this._object3D.material) {
        this._object3D.material.color.set(color);
    } else if (this._object3D) {
        // Для GLB-моделей: проходим по всем мешам
        this._object3D.traverse(child => {
            if (child.isMesh && child.material) {
                child.material.color.set(color);
            }
        });
    }
}

    /** @private */ _showTooltip() { this.showTooltip(); }
    /** @private */ _hideTooltip() { this.hideTooltip(); }
}