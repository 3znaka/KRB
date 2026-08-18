/**
 * Модуль 3D-маркера для картографической библиотеки на three.js.
 * Поддерживает примитивы (куб, сфера, цилиндр, конус) и GLB-модели.
 * Обладает свойствами обычного маркера: position, minZoom, maxZoom, title, tooltip, события.
 * Реализованы:
 * - anchor point для точной привязки объекта к координате;
 * - raycasting для событий onClick и onHover;
 * - гибкое позиционирование подписи относительно объекта (top, bottom, left, right)
 *   с гарантией отсутствия перекрытия.
 * - масштабирование GLB-моделей через size (число, [height], [width,height], [width,height,depth])
 *
 * @module Marker3D
 */

import { THREE } from '../js_TP/tpb.js';
import { proj } from './Utils.js';
import { Layer } from './Layers.js';

/**
 * Рендерит 3д-маркеры выше любого уровня зума тайлов
 *
 * @private
 */
const MARKER_RENDER_ORDER = 1000;

/**
 * Класс 3D-маркера.
 * Добавляется в Layer аналогично обычному Marker.
 *
 * @example
 * const marker3d = new Marker3D({
 *     position: [37.6178, 55.7558],
 *     primitiveType: 'box',
 *     size: [1000, 500, 1000],
 *     modelUrl: null,
 *     altitude: 200,
 *     altitudeMode: 'clampToGround',
 *     rotation: [0, Math.PI / 2, 0],
 *     anchor: [0.5, 0, 0.5],
 *     minZoom: 5,
 *     maxZoom: 12,
 *     title: '3D объект',
 *     titleStyle: { color: '#ff0000', fontSize: '14px' },
 *     titleMinZoom: 5,
 *     titleMaxZoom: 12,
 *     titlePlacement: 'top',
 *     titleAlign: 'center',
 *     titleOffset: [0, -10],
 *     tooltip: '<b>3D объект</b>',
 *     color: 0x3388ff,
 *     clusterable: false,
 *     onClick: (e, marker) => console.log('Клик по 3D объекту', e, marker),
 *     onHover: (hovered) => console.log('Hover:', hovered)
 * });
 * marker3d.addTo(map);
 * marker3d.setColor(0xff5500);
 * marker3d.setSize(500); // равномерно увеличить модель до 500 м по максимальному габариту
 * console.log(marker3d.getSize()); // 500
 * ...
 */
export class Marker3D {
    /** @private */ static _idCounter = 0;
    /** @private */ static _activeMarkers = new Set();
    /** @private */ static _hoveredMarker = null;
    /** @private */ static _pressedMarker = null;
    /** @private */ static _pressStart = null;
    /** @private */ static _raycaster = new THREE.Raycaster();
    /** @private */ static _mapEventHandlers = new WeakMap();
    /** @private */ static _isMobile = (typeof window !== 'undefined') && (('ontouchstart' in window) || (navigator.maxTouchPoints > 0));

    /**
     * Создаёт 3D-маркер.
     *
     * @param {Object} options - Настройки 3D-маркера.
     * @param {[number, number]} options.position - Географические координаты [lon, lat].
     * @param {string} [options.primitiveType='box'] - Тип примитива: 'box', 'sphere', 'cylinder', 'cone'.
     * @param {number|Array<number>} [options.size] - Размеры объекта. Для примитивов: массив [width, height, depth] в метрах; число или массивы из 1-3 элементов преобразуются к тройке. Для GLB-моделей: число - равномерное масштабирование до максимального габарита; [height] - масштабирование по высоте с сохранением пропорций; [width, height] - ширина и высота, глубина пропорционально среднему; [width, height, depth] - точные размеры по осям.
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
     * @param {string} [options.titlePlacement='top'] - Положение подписи относительно объекта: 'top', 'bottom', 'left', 'right'.
     * @param {string} [options.titleAlign] - Горизонтальное выравнивание подписи. По умолчанию зависит от titlePlacement.
     * @param {[number, number]} [options.titleOffset] - Смещение подписи в пикселях. По умолчанию зависит от titlePlacement.
     * @param {string} [options.tooltip=''] - Текст всплывающей подсказки (HTML).
     * @param {string|number} [options.color=0x3388ff] - Цвет примитива.
     * @param {Function} [options.onClick] - Обработчик клика по объекту (получает событие и маркер).
     * @param {Function} [options.onHover] - Обработчик наведения (получает true/false).
     * @param {boolean} [options.clusterable=false] - 3D-маркеры по умолчанию не участвуют в кластеризации.
     * @throws {Error} Если options.position отсутствует или имеет неверный формат.
     */
    constructor(options = {}) {
        if (!options.position || options.position.length !== 2) {
            throw new Error('Marker3D: options.position is required [lon, lat]');
        }

        /** @private */ this._lon = options.position[0];
        /** @private */ this._lat = options.position[1];
        /** @private */ this._primitiveType = options.primitiveType || 'box';
        /** @private */ this._size = options.size || null; // размер, может быть null/undefined
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
        /** @private */ this._titlePlacement = options.titlePlacement || 'top'; // 'top' | 'bottom' | 'left' | 'right'

        // Выравнивание и смещение подписи. Если пользователь не задал их явно,
        // устанавливаем значения по умолчанию в зависимости от titlePlacement,
        // чтобы подпись гарантированно не перекрывала объект.
        if (options.titleAlign !== undefined) {
            this._titleAlign = options.titleAlign;
        } else {
            switch (this._titlePlacement) {
                case 'top':
                    this._titleAlign = 'center';
                    break;
                case 'bottom':
                    this._titleAlign = 'center';
                    break;
                case 'left':
                    this._titleAlign = 'right';
                    break;
                case 'right':
                    this._titleAlign = 'left';
                    break;
                default:
                    this._titleAlign = 'center';
            }
        }

        if (options.titleOffset !== undefined) {
            this._titleOffset = options.titleOffset;
        } else {
            switch (this._titlePlacement) {
                case 'top':
                    this._titleOffset = [0, -10]; // вверх
                    break;
                case 'bottom':
                    this._titleOffset = [0, 10]; // вниз
                    break;
                case 'left':
                    this._titleOffset = [-10, 0]; // влево
                    break;
                case 'right':
                    this._titleOffset = [10, 0]; // вправо
                    break;
                default:
                    this._titleOffset = [0, -10];
            }
        }

        /** @private */ this._height = 0; // фактическая высота объекта (будет установлена при создании примитива или загрузке модели)

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
        /** @private */ this._localBox = null; // Локальный bounding box объекта (после применения anchor)
        // Для моделей
        /** @private */ this._originalModelSize = null; // Vector3
        /** @private */ this._originalModelScale = null; // Vector3
        /** @private */ this._originalModelPosition = null; // Vector3
        /** @private */ this._isModel = !!this._modelUrl;               // флаг, что используется GLB-модель
        /** @private */ this._modelAnchorOffset = new THREE.Vector3(); // смещение для anchor point модели
        /** @private */ this._sizeAnimation = null; // объект анимации: { startSize, endSize, startTime, duration, easing }
    }

    /**
     * Удобный метод: создаёт персональный слой, добавляет его на карту и помещает в него данный 3D-маркер.
     *
     * @param {Object} map - Экземпляр карты.
     * @returns {Marker3D} Возвращает this для цепочки вызовов.
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
     *
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
     *
     * @private
     */
    _createPrimitive() {
        // Преобразуем size в массив [w, h, d] в зависимости от типа
        let [w, h, d] = this._normalizePrimitiveSize(this._size);
        this._height = h; // сохраняем фактическую высоту примитива
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
        geometry.computeBoundingBox();
        this._localBox = geometry.boundingBox.clone();

        mesh.renderOrder = MARKER_RENDER_ORDER;
        this._geometry = geometry;
        this._material = material;
        this._object3D = mesh;
    }

    /**
     * Преобразует входной size для примитива в массив [width, height, depth].
     * Поддерживает number, [h], [w,h], [w,h,d].
     *
     * @param {number|Array<number>} size - Входной размер.
     * @returns {[number, number, number]} Нормализованный размер.
     * @private
     */
    _normalizePrimitiveSize(size) {
        if (!size) return [100, 100, 100]; // default
        if (typeof size === 'number') {
            return [size, size, size];
        }
        if (Array.isArray(size)) {
            switch (size.length) {
                case 1: return [size[0], size[0], size[0]];
                case 2: return [size[0], size[1], size[0]]; // глубина = ширине
                case 3: return [size[0], size[1], size[2]];
                default: throw new Error('Marker3D: size array must have 1, 2, or 3 elements');
            }
        }
        throw new Error('Marker3D: invalid size type');
    }

    /**
     * Загружает GLB-модель с помощью динамического импорта GLTFLoader с CDN.
     * Применяет anchor point и масштабирование после загрузки.
     *
     * @returns {Promise<void>} Промис, который разрешается после завершения загрузки модели.
     * @private
     */
    async _loadModel() {
        if (this._modelPromise) return this._modelPromise;
        this._modelPromise = (async () => {
            try {
                const gltfModule = await import('https://esm.sh/three@0.160.0/examples/jsm/loaders/GLTFLoader.js');
                const GLTFLoader = gltfModule.GLTFLoader;
                const loader = new GLTFLoader();
                const gltf = await loader.loadAsync(this._modelUrl);
                const model = gltf.scene;

                // Сохраняем исходные параметры модели для последующего изменения размера
                const originalBox = new THREE.Box3().setFromObject(model);
                this._originalModelSize = originalBox.getSize(new THREE.Vector3());
                this._originalModelScale = model.scale.clone();
                this._originalModelPosition = model.position.clone();

                // Применяем размер и anchor
                this._applyModelSizeAndAnchor(model);

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
 * Применяет масштабирование и anchor к модели на основе this._size и this._anchor.
 * Пересчитывает this._height и сохраняет смещение anchor в this._modelAnchorOffset.
 * Не изменяет позицию модели напрямую — смещение будет применяться в _update.
 *
 * @param {THREE.Object3D} model - Корневой объект модели.
 * @private
 */
_applyModelSizeAndAnchor(model) {
    const currentPos = model.position.clone();   // сохраняем текущую позицию
    model.scale.copy(this._originalModelScale);  // сбрасываем масштаб

    if (this._size) {
        const scaleFactors = this._calculateModelScale(this._size, this._originalModelSize);
        model.scale.copy(scaleFactors);
    }

    // Вычисляем bounding box после масштабирования (без изменения позиции)
    const box = new THREE.Box3().setFromObject(model);
    const size = box.getSize(new THREE.Vector3());
    this._height = size.y;

    if (this._anchor) {
        const anchorPoint = new THREE.Vector3(
            box.min.x + this._anchor[0] * size.x,
            box.min.y + this._anchor[1] * size.y,
            box.min.z + this._anchor[2] * size.z
        );
        this._modelAnchorOffset.copy(anchorPoint);
    } else {
        this._modelAnchorOffset.set(0, 0, 0);
    }

    model.position.copy(currentPos);             // восстанавливаем позицию
}


    /**
     * Вычисляет коэффициенты масштабирования модели на основе size и исходных размеров.
     *
     * @param {number|Array<number>} size - Желаемый размер.
     * @param {THREE.Vector3} originalSize - Исходные размеры модели по осям.
     * @returns {THREE.Vector3} Вектор масштабных коэффициентов.
     * @private
     */
    _calculateModelScale(size, originalSize) {
        if (typeof size === 'number') {
            const targetMaxDim = size;
            const currentMaxDim = Math.max(originalSize.x, originalSize.y, originalSize.z);
            const factor = targetMaxDim / currentMaxDim;
            return new THREE.Vector3(factor, factor, factor);
        }

        if (Array.isArray(size)) {
            switch (size.length) {
                case 1: {
                    const targetHeight = size[0];
                    const factor = targetHeight / originalSize.y;
                    return new THREE.Vector3(factor, factor, factor);
                }
                case 2: {
                    const targetWidth = size[0];
                    const targetHeight = size[1];
                    const scaleX = targetWidth / originalSize.x;
                    const scaleY = targetHeight / originalSize.y;
                    const scaleZ = (scaleX + scaleY) / 2; // глубина пропорционально среднему
                    return new THREE.Vector3(scaleX, scaleY, scaleZ);
                }
                case 3: {
                    return new THREE.Vector3(
                        size[0] / originalSize.x,
                        size[1] / originalSize.y,
                        size[2] / originalSize.z
                    );
                }
                default:
                    throw new Error('Marker3D: size array must have 1, 2, or 3 elements');
            }
        }

        throw new Error('Marker3D: invalid size type');
    }

    /**
     * Устанавливает новый размер объекта (для моделей и примитивов).
     * Для моделей изменяет масштаб, для примитивов пересоздаёт меш.
     *
     * @param {number|Array<number>} size - Новый размер (см. документацию конструктора).
     * @returns {Marker3D} this для цепочки вызовов.
     */
    setSize(size) {
        this._size = size;

        if (!this._object3D) {
            // Если объект ещё не создан, просто сохраняем размер
            return this;
        }

        if (this._modelUrl) {
            // Для модели
            if (this._isModelLoading) {
                // Модель ещё загружается, размер будет применён после загрузки
                return this;
            }
            // Если модель уже загружена и является this._object3D
            this._applyModelSizeAndAnchor(this._object3D);
            // Обновляем поворот (на случай если был изменён)
            this._object3D.rotation.set(...this._rotation);
        } else {
            // Для примитива пересоздаём меш
            if (this._object3D.parent) {
                const oldObject = this._object3D;
                const oldPosition = oldObject.position.clone();
                const oldRotation = oldObject.rotation.clone();
                oldObject.parent.remove(oldObject);

                this._createPrimitive(); // создаст новый this._object3D
                this._object3D.position.copy(oldPosition);
                this._object3D.rotation.copy(oldRotation);
                this._map.worldGroup.add(this._object3D);
            }
        }
        return this;
    }

/**
 * Плавно изменяет размер объекта в течение заданного времени.
 * Поддерживает как GLB-модели, так и примитивы.
 *
 * @param {number|Array<number>} newSize - Новый размер (см. документацию конструктора).
 * @param {number} [duration=1000] - Длительность анимации в миллисекундах.
 * @param {string} [easing='linear'] - Тип анимации: 'linear', 'easeIn', 'easeOut', 'easeInOut'.
 * @returns {Marker3D} this для цепочки вызовов.
 */
animateSize(newSize, duration = 1000, easing = 'linear') {
    // Определяем начальный размер
    let startSize = this._size;

    if (startSize === null) {
        if (this._isModel && this._originalModelSize) {
            // Для GLB-моделей используем максимальный габарит исходной модели
            startSize = Math.max(
                this._originalModelSize.x,
                this._originalModelSize.y,
                this._originalModelSize.z
            );
        } else {
            // Для примитивов (или если модель ещё не загружена) — размер по умолчанию
            startSize = [100, 100, 100];
        }
    }

    this._sizeAnimation = {
        startSize,
        endSize: newSize,
        startTime: performance.now(),
        duration,
        easing
    };

    return this;
}

    /**
     * Возвращает текущий размер объекта.
     *
     * @returns {number|Array<number>|null} Текущий размер.
     */
    getSize() {
        return this._size;
    }

 

    /**
     * Регистрирует глобальные обработчики событий для рейкастинга на canvas карты.
     *
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
     * Получает NDC координаты из события указателя.
     *
     * @param {PointerEvent} e - Событие указателя.
     * @param {Object} map - Карта.
     * @returns {THREE.Vector2} NDC координаты указателя.
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
     *
     * @param {THREE.Vector2} mouse - NDC координаты.
     * @param {Object} map - Карта.
     * @returns {Marker3D|null} Найденный маркер или null, если под курсором нет маркеров.
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
     *
     * @param {PointerEvent} e - Событие указателя.
     * @param {Object} map - Карта.
     * @private
     */
    _onPointerMove(e, map) {
        if (Marker3D._isMobile) return; // на мобильных не обрабатываем движение пальца как hover

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
     *
     * @param {PointerEvent} e - Событие указателя.
     * @param {Object} map - Карта.
     * @private
     */
    _onPointerDown(e, map) {
        const mouse = this._getNDC(e, map);
        const marker = this._getMarkerUnderPointer(mouse, map);
        Marker3D._pressedMarker = marker; // может быть null
        Marker3D._pressStart = { x: e.clientX, y: e.clientY };
    }

    /**
     * Обработчик pointerup: если было короткое нажатие без перемещения, вызывает onClick.
     *
     * @param {PointerEvent} e - Событие указателя.
     * @param {Object} map - Карта.
     * @private
     */
    _onPointerUp(e, map) {
        const pressed = Marker3D._pressedMarker;
        const start = Marker3D._pressStart;
        Marker3D._pressedMarker = null;
        Marker3D._pressStart = null;
        if (!start) return;

        const dx = e.clientX - start.x;
        const dy = e.clientY - start.y;
        const dist = Math.sqrt(dx * dx + dy * dy);
        if (dist > 5) return; // клик не засчитывается, если было перемещение

        // Эмуляция onHover как клика на мобильных устройствах
        if (Marker3D._isMobile) {
            if (!pressed) {
                // Тап по пустому месту — скрываем текущий тултип/ховер
                if (Marker3D._hoveredMarker) {
                    if (Marker3D._hoveredMarker._onHover) {
                        Marker3D._hoveredMarker._onHover(false);
                    } else {
                        Marker3D._hoveredMarker.hideTooltip();
                    }
                    Marker3D._hoveredMarker = null;
                }
                return;
            }

            // Если у маркера нет onClick, но есть onHover или tooltip, показываем как при клике
            if (!pressed._onClick && (pressed._onHover || pressed._tooltipText)) {
                // Скрываем предыдущий hovered маркер
                if (Marker3D._hoveredMarker && Marker3D._hoveredMarker !== pressed) {
                    if (Marker3D._hoveredMarker._onHover) {
                        Marker3D._hoveredMarker._onHover(false);
                    } else {
                        Marker3D._hoveredMarker.hideTooltip();
                    }
                }
                // Показываем текущий
                if (Marker3D._hoveredMarker !== pressed) {
                    if (pressed._onHover) {
                        pressed._onHover(true);
                    } else {
                        pressed.showTooltip();
                    }
                    Marker3D._hoveredMarker = pressed;
                }
                return; // не вызываем onClick
            }
        }

        // Если есть onClick, вызываем его
        if (pressed && pressed._onClick) {
            pressed._onClick(e, pressed);
        }
    }

    /**
     * Обработчик pointerleave: сбрасывает hover.
     *
     * @param {PointerEvent} e - Событие указателя.
     * @param {Object} map - Карта.
     * @private
     */
    _onPointerLeave(e, map) {
        if (Marker3D._isMobile) return; // на мобильных тултип скрывается только по тапу на пустое место или другой маркер

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
     * Получает DOM-панели маркера (аналогично Marker._getPanes).
     *
     * @param {Object} map - Карта.
     * @returns {{markerPane: HTMLElement, tooltipPane: HTMLElement}} Объект с DOM-панелями маркера и тултипа.
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
        this._localBox = null;
    }


/**
 * Обновляет анимацию размера, если она активна.
 * Вызывается в _update.
 *
 * @param {number} now - Текущее время performance.now().
 * @private
 */
_updateSizeAnimation(now) {
    if (!this._sizeAnimation) return;

    const anim = this._sizeAnimation;
    const elapsed = now - anim.startTime;
    const t = Math.min(elapsed / anim.duration, 1);

    // Применяем easing
    let progress;
    switch (anim.easing) {
        case 'easeIn':
            progress = t * t;
            break;
        case 'easeOut':
            progress = 1 - Math.pow(1 - t, 2);
            break;
        case 'easeInOut':
            progress = t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
            break;
        case 'linear':
        default:
            progress = t;
            break;
    }

    // Интерполируем размер
    const currentSize = this._lerpSize(anim.startSize, anim.endSize, progress);
    this.setSize(currentSize);

    // Если анимация завершена, очищаем
    if (t >= 1) {
        this._sizeAnimation = null;
        this.setSize(anim.endSize); // гарантируем точное конечное значение
    }
}

/**
 * Линейная интерполяция между двумя значениями size (число или массив).
 *
 * @param {number|Array<number>} start - Начальный размер.
 * @param {number|Array<number>} end - Конечный размер.
 * @param {number} t - Коэффициент прогресса (0..1).
 * @returns {number|Array<number>} Промежуточный размер.
 * @private
 */
_lerpSize(start, end, t) {
    if (typeof start === 'number' && typeof end === 'number') {
        return start + (end - start) * t;
    }

    if (Array.isArray(start) && Array.isArray(end)) {
        const len = Math.min(start.length, end.length);
        const result = [];
        for (let i = 0; i < len; i++) {
            result.push(start[i] + (end[i] - start[i]) * t);
        }
        return result;
    }

    // Если типы не совпадают, просто возвращаем конечное значение
    return end;
}


    /**
     * Обновляет позицию и видимость 3D-маркера. Вызывается картой каждый кадр.
     *
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

this._updateSizeAnimation(performance.now());

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

if (this._isModel && this._modelAnchorOffset) {
    this._object3D.position.set(
        absWorldX - this._modelAnchorOffset.x,
        worldY - this._modelAnchorOffset.y,
        absWorldZ - this._modelAnchorOffset.z
    );
} else {
    // для примитивов якорь уже учтён в геометрии
    this._object3D.position.set(absWorldX, worldY, absWorldZ);
}

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


// Проверка видимости bounding box объекта в камере.
if (this._isModel) {
    // Для GLB-моделей используем точный мировой bounding box
    const worldBox = new THREE.Box3().setFromObject(this._object3D);

    const projScreenMatrix = new THREE.Matrix4().multiplyMatrices(
        mapInstance.camera.projectionMatrix,
        mapInstance.camera.matrixWorldInverse
    );
    const frustum = new THREE.Frustum().setFromProjectionMatrix(projScreenMatrix);

    if (!frustum.intersectsBox(worldBox)) {
        this._object3D.visible = false;
        this._isVisible = false;
        return;
    }
} else if (this._localBox) {
    // Для примитивов сохраняем прежнюю оптимизированную проверку
    this._object3D.updateWorldMatrix(true, false);
    const worldBox = this._localBox.clone().applyMatrix4(this._object3D.matrixWorld);

    const projScreenMatrix = new THREE.Matrix4().multiplyMatrices(
        mapInstance.camera.projectionMatrix,
        mapInstance.camera.matrixWorldInverse
    );
    const frustum = new THREE.Frustum().setFromProjectionMatrix(projScreenMatrix);

    if (!frustum.intersectsBox(worldBox)) {
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

    /**
     * Возвращает текст подписи.
     *
     * @returns {string} Текст подписи.
     */
    getText() { return this._title; }

    /**
     * Возвращает стили подписи.
     *
     * @returns {Object} Стили подписи.
     */
    getTextStyle() {
        return Object.assign({
            fontFamily: 'sans-serif',
            color: '#333',
            fontSize: '12px',
            textAlign: this._titleAlign
        }, this._titleStyle);
    }

    /**
     * Возвращает границы зума для подписи.
     *
     * @returns {{min: number, max: number}} Границы зума для подписи.
     */
    getTextZoomBounds() { return { min: this._titleMinZoom, max: this._titleMaxZoom }; }

    /**
     * Возвращает тип подписи.
     *
     * @returns {string} Тип подписи ('point').
     */
    getLabelType() { return 'point'; }

    /**
     * Возвращает видимость маркера в текущем кадре.
     *
     * @returns {boolean} Видим ли маркер в текущем кадре.
     */
    isVisible() { return this._isVisible; }

    /**
     * Возвращает позицию на экране для отображения подписи.
     * Вычисляется на основе экранного ограничивающего прямоугольника объекта
     * с учётом выбранного titlePlacement, чтобы подпись не перекрывала объект.
     *
     * @returns {{x: number, y: number}|null} Позиция на экране для подписи или null, если маркер не видим.
     */
    getScreenPosition() {
    if (!this._isVisible || !this._object3D) return null;

    const canvas = this._map.renderer.domElement;
    let box;

    if (this._isModel) {
        // Для модели используем актуальный bounding box
        box = new THREE.Box3().setFromObject(this._object3D);
    } else if (this._localBox) {
        // Для примитива применяем локальный box к мировой матрице
        this._object3D.updateWorldMatrix(true, false);
        box = this._localBox.clone().applyMatrix4(this._object3D.matrixWorld);
    } else {
        // Fallback, если ничего нет
        const localTop = new THREE.Vector3(0, this._height * (1 - this._anchor[1]), 0);
        this._object3D.updateWorldMatrix(false, false);
        const worldTop = localTop.clone().applyMatrix4(this._object3D.matrixWorld);
        const screenPos = worldTop.clone().project(this._map.camera);
        if (screenPos.z > 1 || Math.abs(screenPos.x) > 1 || Math.abs(screenPos.y) > 1) return null;
        return {
            x: (screenPos.x * 0.5 + 0.5) * canvas.clientWidth,
            y: (-screenPos.y * 0.5 + 0.5) * canvas.clientHeight
        };
    }

    // Проецируем 8 углов bounding box
    const corners = [];
    const { min, max } = box;
    for (let i = 0; i < 8; i++) {
        const corner = new THREE.Vector3(
            (i & 1) ? max.x : min.x,
            (i & 2) ? max.y : min.y,
            (i & 4) ? max.z : min.z
        );
        corner.project(this._map.camera);
        if (corner.z > 1 || corner.z < -1) continue;
        corners.push({
            x: (corner.x * 0.5 + 0.5) * canvas.clientWidth,
            y: (-corner.y * 0.5 + 0.5) * canvas.clientHeight
        });
    }
    if (corners.length === 0) return null;

    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (const c of corners) {
        if (c.x < minX) minX = c.x;
        if (c.x > maxX) maxX = c.x;
        if (c.y < minY) minY = c.y;
        if (c.y > maxY) maxY = c.y;
    }

    const centerX = (minX + maxX) / 2;
    const centerY = (minY + maxY) / 2;

    let x, y;
    switch (this._titlePlacement) {
        case 'bottom': x = centerX; y = maxY; break;
        case 'left':   x = minX;   y = centerY; break;
        case 'right':  x = maxX;   y = centerY; break;
        case 'top':
        default:       x = centerX; y = minY;   break;
    }
    return { x, y };
}

    /**
     * Возвращает выравнивание подписи.
     *
     * @returns {string} Выравнивание подписи.
     */
    getTitleAlign() { return this._titleAlign; }

    /**
     * Возвращает смещение подписи.
     *
     * @returns {[number, number]} Смещение подписи в пикселях.
     */
    getTitleOffset() { return this._titleOffset; }

    /**
     * Возвращает вертикальное выравнивание подписи.
     *
     * @returns {string} Вертикальное выравнивание.
     */
    getTitleVerticalAlign() {
        switch (this._titlePlacement) {
            case 'bottom':
                return 'top';       // подпись ниже точки, растёт вниз
            case 'left':
            case 'right':
                return 'center';    // по вертикали центр
            case 'top':
            default:
                return 'bottom';    // подпись выше точки, растёт вверх
        }
    }

    /**
     * Возвращает разрешение на выход за границы.
     *
     * @returns {boolean} Разрешать ли выход за границы.
     */
    getAllowOverflow() { return false; }

    /**
     * Возвращает приоритет подписи.
     *
     * @returns {number} Приоритет подписи.
     */
    getPriority() { return 0; }

    /**
     * Возвращает участие в кластеризации.
     *
     * @returns {boolean} Участвует ли в кластеризации.
     */
    getClusterable() { return this._clusterable; }

    // ---------- Вспомогательные методы ----------

    /**
     * Показывает тултип.
     */
    showTooltip() { if (this._tooltipElement) this._tooltipElement.style.display = 'block'; }

    /**
     * Скрывает тултип.
     */
    hideTooltip() { if (this._tooltipElement) this._tooltipElement.style.display = 'none'; }

    /**
     * Устанавливает цвет примитива.
     *
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

    /**
     * Показывает тултип.
     *
     * @private
     */
    _showTooltip() { this.showTooltip(); }

    /**
     * Скрывает тултип.
     *
     * @private
     */
    _hideTooltip() { this.hideTooltip(); }
}