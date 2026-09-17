/**
 * Модуль 3D-маркера.
 * Поддерживает примитивы (куб, сфера, цилиндр, конус) и GLB-модели.
 *
 * Взаимодействие с указателем (hover / click / tooltip) делегировано
 * {@link InteractionManager} — единому менеджеру карты. Маркер лишь
 * регистрирует колбэки при `_attach` и снимает регистрацию в `remove`.
 *
 * @module Marker3D
 */

import { THREE, GLTFLoader, DRACOLoader } from '../js_TP/tpb.js';
import { Projections } from './Projections.js';
import { Layer } from './Layers.js';

/**
 * Render order, при котором 3D-маркеры рисуются поверх тайлов любого уровня.
 *
 * @private
 * @type {number}
 */
const MARKER_RENDER_ORDER = 1000;

/**
 * 3D-маркер на карте.
 *
 * Поддерживает два режима:
 *  - примитив (Mesh на основе BoxGeometry / SphereGeometry / CylinderGeometry /
 *    ConeGeometry), задаётся `primitiveType` + `size`;
 *  - GLB-модель, загружаемая асинхронно; задаётся `modelUrl`.
 *
 * Все трансформации модели (rotation, scale по `size`, anchor-offset)
 * применяются к `_modelRoot` внутри постоянной Group-обёртки `_object3D`.
 * Это гарантирует, что внешние ссылки на `_object3D` остаются валидными
 * на протяжении всей жизни маркера.
 *
 * @example
 * const marker = new Marker3D({
 *     position: [37.6173, 55.7558],
 *     primitiveType: 'cone',
 *     size: [20, 100, 20],
 *     color: 0xff4400,
 *     altitudeMode: 'clampToGround',
 *     title: 'Точка А',
 *     tooltip: '<b>Привет</b>',
 *     onClick: (e, m) => console.log('clicked', m)
 * });
 * marker.addTo(map);
 */
export class Marker3D {
    /**
     * Создаёт 3D-маркер.
     *
     * Координаты маркера задаются в системе координат `options.crs`.
     * Если `crs` не указан, используется `map.inputCRS` (по умолчанию WGS84).
     * Внутри карты координаты автоматически приводятся к метрам проекции
     * карты (`map.projection`) через {@link KrbMap#project}.
     *
     * @param {Object} options - Настройки 3D-маркера.
     * @param {[number, number]} options.position - Координаты [x, y] в СК `options.crs`.
     *     По умолчанию — [долгота, широта] в градусах WGS84.
     * @param {string} [options.crs] - Код системы координат для `position`
     *     (например, 'EPSG:4326', 'EPSG:3857', 'EPSG:32637').
     *     Если не указан — используется `map.inputCRS`.
     *     Перед созданием маркера соответствующая проекция должна быть
     *     зарегистрирована в `Projections`.
     * @param {string} [options.primitiveType='box'] - Тип примитива:
     *     'box', 'sphere', 'cylinder', 'cone'.
     * @param {number|Array<number>} [options.size] - Размеры объекта.
     *     Для примитивов: массив [width, height, depth] в метрах; число или
     *     массивы из 1-3 элементов преобразуются к тройке. Для GLB-моделей:
     *     число — равномерное масштабирование до максимального габарита;
     *     [height] — масштабирование по высоте с сохранением пропорций;
     *     [width, height] — ширина и высота, глубина пропорционально среднему;
     *     [width, height, depth] — точные размеры по осям.
     * @param {string} [options.modelUrl] - URL GLB-модели. Если указан,
     *     примитив игнорируется.
     * @param {number} [options.altitude=0] - Высота над поверхностью
     *     (если `altitudeMode='clampToGround'`) или абсолютная высота
     *     (если `altitudeMode='absolute'`).
     * @param {string} [options.altitudeMode='clampToGround'] - Режим высоты:
     *     'clampToGround' (прижат к рельефу), 'absolute' (абсолютная высота
     *     в мировых координатах Y).
     * @param {[number, number, number]} [options.rotation=[0,0,0]] - Углы
     *     поворота в радианах [x, y, z].
     * @param {[number, number, number]} [options.anchor=[0.5,0,0.5]] - Точка
     *     привязки объекта: нормализованные координаты внутри bounding box
     *     ([0..1] по каждой оси, где 0 — низ/лево/зад, 1 — верх/право/перед).
     * @param {number} [options.minZoom=-Infinity] - Минимальный зум видимости.
     * @param {number} [options.maxZoom=Infinity] - Максимальный зум видимости.
     * @param {string} [options.title=''] - Текст постоянной подписи
     *     (отображается через TextManager).
     * @param {Object} [options.titleStyle] - Стили подписи (как у Marker).
     * @param {number} [options.titleMinZoom=-Infinity] - Мин. зум для подписи.
     * @param {number} [options.titleMaxZoom=Infinity] - Макс. зум для подписи.
     * @param {string} [options.titlePlacement='top'] - Положение подписи
     *     относительно объекта: 'top', 'bottom', 'left', 'right'.
     * @param {string} [options.titleAlign] - Горизонтальное выравнивание
     *     подписи. По умолчанию зависит от `titlePlacement`.
     * @param {[number, number]} [options.titleOffset] - Смещение подписи
     *     в пикселях. По умолчанию зависит от `titlePlacement`.
     * @param {string} [options.tooltip=''] - Текст всплывающей подсказки (HTML),
     *     показывается через `PopupManager` (через InteractionManager).
     * @param {string|number} [options.color=0x3388ff] - Цвет примитива.
     * @param {Function} [options.onClick] - Обработчик клика по объекту
     *     (получает событие и маркер).
     * @param {Function} [options.onHover] - Обработчик наведения
     *     (получает `true`/`false`).
     * @param {boolean} [options.clusterable=false] - 3D-маркеры по умолчанию
     *     не участвуют в кластеризации.
     * @param {boolean} [options.playAnimation=true] - Воспроизводить ли
     *     встроенные анимации GLB-модели (если есть).
     * @throws {Error} Если `options.position` отсутствует или имеет неверный формат.
     */
    constructor(options = {}) {
        if (!options.position || options.position.length !== 2) {
            throw new Error('Marker3D: options.position is required [x, y]');
        }

        /**
         * Координаты маркера в собственной СК.
         * @private
         * @type {[number, number]}
         */
        this._coord = [options.position[0], options.position[1]];

        /**
         * Код СК маркера; `null` — использовать `map.inputCRS`.
         * @private
         * @type {string|null}
         */
        this._crsCode = options.crs ?? null;

        /**
         * Зарезолвленный объект Projection. Устанавливается в `_attach`.
         * @private
         * @type {import('./Projections.js').Projection|null}
         */
        this._crs = null;

        /** @private @type {string} */        this._primitiveType = options.primitiveType || 'box';
        /** @private @type {number|Array<number>|null} */ this._size = options.size || null;
        /** @private @type {string|null} */   this._modelUrl = options.modelUrl || null;
        /** @private @type {number} */        this._altitude = options.altitude || 0;
        /** @private @type {string} */        this._altitudeMode = options.altitudeMode || 'clampToGround';
        /** @private @type {[number, number, number]} */ this._rotation = options.rotation || [0, 0, 0];
        /** @private @type {[number, number, number]} */ this._anchor = options.anchor || [0.5, 0, 0.5];
        /** @private @type {number} */        this._minZoom = options.minZoom ?? -Infinity;
        /** @private @type {number} */        this._maxZoom = options.maxZoom ?? Infinity;
        /** @private @type {boolean} */       this._playAnimation = options.playAnimation !== undefined ? options.playAnimation : true;

        // Подпись
        /** @private @type {string} */        this._title = options.title || '';
        /** @private @type {Object} */        this._titleStyle = options.titleStyle || {};
        /** @private @type {number} */        this._titleMinZoom = options.titleMinZoom ?? -Infinity;
        /** @private @type {number} */        this._titleMaxZoom = options.titleMaxZoom ?? Infinity;
        /** @private @type {string} */        this._titlePlacement = options.titlePlacement || 'top';

        /**
         * Горизонтальное выравнивание подписи. По умолчанию — по `titlePlacement`.
         * @private
         * @type {string}
         */
        if (options.titleAlign !== undefined) {
            this._titleAlign = options.titleAlign;
        } else {
            switch (this._titlePlacement) {
                case 'top': this._titleAlign = 'center'; break;
                case 'bottom': this._titleAlign = 'center'; break;
                case 'left': this._titleAlign = 'right'; break;
                case 'right': this._titleAlign = 'left'; break;
                default: this._titleAlign = 'center';
            }
        }

        /**
         * Смещение подписи в пикселях. По умолчанию — по `titlePlacement`.
         * @private
         * @type {[number, number]}
         */
        if (options.titleOffset !== undefined) {
            this._titleOffset = options.titleOffset;
        } else {
            switch (this._titlePlacement) {
                case 'top': this._titleOffset = [0, -10]; break;
                case 'bottom': this._titleOffset = [0, 10]; break;
                case 'left': this._titleOffset = [-10, 0]; break;
                case 'right': this._titleOffset = [10, 0]; break;
                default: this._titleOffset = [0, -10];
            }
        }

        /** @private @type {number} */        this._height = 0;
        /** @private @type {string} */        this._tooltipText = options.tooltip || '';
        /** @private @type {Function|null} */  this._onClick = options.onClick || null;
        /** @private @type {Function|null} */  this._onHover = options.onHover || null;
        /** @private @type {boolean} */       this._clusterable = options.clusterable !== undefined ? options.clusterable : false;
        /** @private @type {string|number} */ this._color = options.color || 0x3388ff;

        /** @private @type {import('./KrbMap.js').KrbMap|null} */ this._map = null;
        /** @private @type {Layer|null} */ this._layer = null;

        /**
         * Корневой объект маркера, добавляемый в `map.worldGroup`.
         * Для примитива — это `THREE.Mesh`, для GLB-модели — постоянная
         * `THREE.Group`-обёртка. Никогда не подменяется после создания,
         * чтобы внешние ссылки оставались валидными.
         * @private
         * @type {THREE.Object3D|null}
         */
        this._object3D = null;

        /**
         * Ссылка на загруженный `gltf.scene` (только для GLB-моделей).
         * Является ребёнком `this._object3D`. К нему применяются
         * rotation / scale / anchor-offset.
         * @private
         * @type {THREE.Object3D|null}
         */
        this._modelRoot = null;

        /** @private @type {THREE.BufferGeometry|null} */ this._geometry = null;
        /** @private @type {THREE.Material|null} */       this._material = null;
        /** @private @type {Object|null} */               this._textLabel = null;
        /** @private @type {boolean} */                   this._isVisible = false;
        /** @private @type {number} */                    this._lastHeightUpdateTime = 0;
        /** @private @type {number} */                    this._cachedWorldY = 0;
        /** @private @type {boolean} */                   this._isModelLoading = false;
        /** @private @type {Promise<void>|null} */        this._modelPromise = null;

        /**
         * Мировая позиция маркера (с учётом `map.worldGroup.position`).
         * Обновляется каждый кадр в {@link Marker3D#_update}. Используется
         * в `getBoundingSphere` для broad-phase в InteractionManager.
         * @private
         * @type {THREE.Vector3}
         */
        this._worldPosition = new THREE.Vector3();

        /** @private @type {THREE.Box3|null} */           this._localBox = null;
        /** @private @type {THREE.Vector3|null} */        this._originalModelSize = null;
        /** @private @type {THREE.Vector3|null} */        this._originalModelScale = null;
        /** @private @type {THREE.Vector3|null} */        this._originalModelPosition = null;
        /** @private @type {boolean} */                   this._isModel = !!this._modelUrl;
        /** @private @type {Object|null} */               this._sizeAnimation = null;

        /**
         * Радиус bounding-сферы в локальных единицах геометрии (метрах мира).
         * Используется в InteractionManager для broad-phase.
         * @private
         * @type {number}
         */
        this._boundingRadius = 0;

        /**
         * Кэш массива мешей для raycast. Для примитива — `[mesh]`,
         * для GLB-модели — все дочерние `Mesh`. Инвалидируется в
         * `_createPrimitive` и после успешной загрузки модели.
         * @private
         * @type {THREE.Object3D[]|null}
         */
        this._raycastMeshesCache = null;

        /**
         * Функция отмены регистрации в `map.interaction`. Устанавливается
         * в `_registerInteraction`, вызывается в `remove`.
         * @private
         * @type {(() => void)|null}
         */
        this._unregisterInteraction = null;

        // Анимации GLB
        /** @private @type {THREE.AnimationMixer|null} */ this._mixer = null;
        /** @private @type {THREE.Clock|null} */          this._mixerClock = null;

        // Переиспользуемые объекты для проверки попадания в frustum.
        /** @private @type {THREE.Box3} */      this._tempBox = new THREE.Box3();
        /** @private @type {THREE.Frustum} */   this._tempFrustum = new THREE.Frustum();
        /** @private @type {THREE.Matrix4} */   this._tempProjScreenMatrix = new THREE.Matrix4();
    }

    /**
     * Добавляет маркер на карту, создавая для него персональный слой.
     *
     * @param {import('./KrbMap.js').KrbMap} map - Экземпляр карты.
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
     * Внутренняя привязка маркера к карте и слою.
     *
     * @private
     * @param {import('./KrbMap.js').KrbMap} map - Экземпляр карты.
     * @param {Layer} layer - Слой, которому принадлежит маркер.
     */
    _attach(map, layer) {
        if (this._map === map && this._layer === layer) return;
        this.remove();
        this._map = map;
        this._layer = layer;

        // Резолвим проекцию маркера: либо заданную явно, либо inputCRS карты.
        this._crs = this._crsCode
            ? Projections.get(this._crsCode)
            : map.inputCRS;

        if (this._modelUrl) {
            // Group-обёртка создаётся один раз и никогда не подменяется.
            // Сам gltf.scene кладётся в неё как this._modelRoot (см. _loadModel).
            this._object3D = new THREE.Group();
            this._isModelLoading = true;
            this._loadModel();
            // rotation / scale / anchor применяются к modelRoot внутри _loadModel.
        } else {
            this._createPrimitive();
            this._object3D.rotation.set(...this._rotation);
        }
        map.worldGroup.add(this._object3D);

        this._registerInteraction(map);

        if (this._title && this._map.textManager) {
            this._textLabel = this._map.textManager.addLabel(this);
        }
    }

    /**
     * Регистрирует маркер в общем InteractionManager карты.
     *
     * Если у маркера нет ни `onClick`, ни `onHover`, ни `tooltip` —
     * регистрация не выполняется (объект не интерактивен).
     *
     * @private
     * @param {import('./KrbMap.js').KrbMap} map - Экземпляр карты.
     */
    _registerInteraction(map) {
        if (!map.interaction || typeof map.interaction.register !== 'function') return;
        if (this._unregisterInteraction) {
            this._unregisterInteraction();
            this._unregisterInteraction = null;
        }
        if (!this._onClick && !this._onHover && !this._tooltipText) return;

        this._unregisterInteraction = map.interaction.register(this, {
            getMeshes: () => this._getRaycastMeshes(),
            getBoundingSphere: () => {
                if (this._boundingRadius <= 0) return null;
                return {
                    center: this._worldPosition,
                    radius: this._boundingRadius
                };
            },
            onHover: this._onHover || null,
            onClick: this._onClick || null,
            getTooltip: this._tooltipText ? () => this._tooltipText : null,
            isVisible: () => this._isVisible
        });
    }

    /**
     * Возвращает массив мешей для raycast.
     *
     * Для примитива — массив из одного `Mesh`. Для GLB-модели — все
     * дочерние `Mesh` (кэшируется до следующей пересборки модели).
     *
     * @private
     * @returns {THREE.Object3D[]} Массив мешей (может быть пустым).
     */
    _getRaycastMeshes() {
        if (this._raycastMeshesCache) return this._raycastMeshesCache;
        if (!this._object3D) return [];
        const meshes = [];
        if (!this._isModel) {
            meshes.push(this._object3D);
        } else {
            this._object3D.traverse((child) => {
                if (child.isMesh) meshes.push(child);
            });
        }
        this._raycastMeshesCache = meshes;
        return meshes;
    }

    /**
     * Создаёт примитив (Mesh) по заданным параметрам.
     *
     * @private
     */
    _createPrimitive() {
        const [w, h, d] = this._normalizePrimitiveSize(this._size);
        this._height = h;
        let geometry;
        switch (this._primitiveType.toLowerCase()) {
            case 'sphere':   geometry = new THREE.SphereGeometry(w / 2, 32, 32); break;
            case 'cylinder': geometry = new THREE.CylinderGeometry(w / 2, w / 2, h, 32); break;
            case 'cone':     geometry = new THREE.ConeGeometry(w / 2, h, 32); break;
            case 'box':
            default:         geometry = new THREE.BoxGeometry(w, h, d); break;
        }
        const material = new THREE.MeshStandardMaterial({ color: this._color, roughness: 0.5 });
        const mesh = new THREE.Mesh(geometry, material);

        const offset = new THREE.Vector3(
            (0.5 - this._anchor[0]) * w,
            (0.5 - this._anchor[1]) * h,
            (0.5 - this._anchor[2]) * d
        );
        geometry.translate(offset.x, offset.y, offset.z);
        geometry.computeBoundingBox();
        geometry.computeBoundingSphere();

        this._localBox = geometry.boundingBox.clone();
        this._boundingRadius = geometry.boundingSphere
            ? geometry.boundingSphere.radius
            : 0.5 * Math.sqrt(w * w + h * h + d * d);

        mesh.renderOrder = MARKER_RENDER_ORDER;
        this._geometry = geometry;
        this._material = material;
        this._object3D = mesh;

        // Геометрия сменилась — кэш мешей невалиден.
        this._raycastMeshesCache = null;
    }

    /**
     * Приводит `size` к каноническому виду `[width, height, depth]`.
     *
     * @private
     * @param {number|Array<number>|null} size - Исходное значение размеров.
     * @returns {[number, number, number]} Тройка размеров.
     * @throws {Error} Если массив имеет больше 3 элементов или тип неверный.
     */
    _normalizePrimitiveSize(size) {
        if (!size) return [100, 100, 100];
        if (typeof size === 'number') return [size, size, size];
        if (Array.isArray(size)) {
            switch (size.length) {
                case 1: return [size[0], size[0], size[0]];
                case 2: return [size[0], size[1], size[0]];
                case 3: return [size[0], size[1], size[2]];
                default: throw new Error('Marker3D: size array must have 1, 2, or 3 elements');
            }
        }
        throw new Error('Marker3D: invalid size type');
    }

    /**
     * Асинхронно загружает GLB-модель.
     *
     * `this._object3D` остаётся `THREE.Group`-обёрткой; загруженный
     * `gltf.scene` кладётся в `this._modelRoot` и добавляется внутрь
     * обёртки. Все трансформации (rotation, scale, anchor-offset)
     * применяются именно к `modelRoot`, а не к обёртке — так внешние
     * ссылки на `this._object3D` остаются валидными.
     *
     * @private
     * @returns {Promise<void>} Промис завершения загрузки.
     */
    async _loadModel() {
        if (this._modelPromise) return this._modelPromise;
        this._modelPromise = (async () => {
            try {
                const loader = new GLTFLoader();

                const dracoLoader = new DRACOLoader();
                dracoLoader.setDecoderPath('https://cdn.mapengine.ru/KRB/js_TP/draco/');
                dracoLoader.setDecoderConfig({ type: 'wasm' });
                loader.setDRACOLoader(dracoLoader);

                const gltf = await loader.loadAsync(this._modelUrl);
                const model = gltf.scene;

                // --- Настройка анимаций (если включены и есть в модели) ---
                if (this._playAnimation && gltf.animations && gltf.animations.length > 0) {
                    this._mixer = new THREE.AnimationMixer(model);
                    for (const clip of gltf.animations) {
                        const action = this._mixer.clipAction(clip);
                        action.play();
                    }
                    this._mixerClock = new THREE.Clock();
                }

                const originalBox = new THREE.Box3().setFromObject(model);
                this._originalModelSize = originalBox.getSize(new THREE.Vector3());
                this._originalModelScale = model.scale.clone();
                this._originalModelPosition = model.position.clone();

                this._applyModelSizeAndAnchor(model);

                model.traverse((child) => {
                    if (child.isMesh) {
                        child.renderOrder = MARKER_RENDER_ORDER;
                        child.castShadow = true;
                        child.receiveShadow = true;
                    }
                });

                this._modelRoot = model;
                if (this._object3D) {
                    this._object3D.add(model);
                }
                this._isModelLoading = false;

                // Модель появилась — кэш мешей для raycast нужно пересобрать.
                this._raycastMeshesCache = null;
            } catch (err) {
                console.warn('Marker3D: GLB model loading failed:', err);
                this._isModelLoading = false;
            }
        })();
        return this._modelPromise;
    }

    /**
     * Применяет к GLB-модели размеры, поворот и смещение anchor.
     *
     * Все трансформации применяются к самой модели (аргумент `model`),
     * а не к Group-обёртке `this._object3D`. Это сохраняет валидность
     * внешних ссылок на `_object3D`.
     *
     * Порядок операций:
     *  1. Сброс scale/position/rotation к оригинальным значениям.
     *  2. Применение rotation из `options.rotation`.
     *  3. Применение scale из `options.size`.
     *  4. Временное отсоединение от родителя и вычисление bbox
     *     в локальных координатах Group (родитель = null → world = local).
     *  5. Смещение `model.position` так, чтобы точка привязки (anchor)
     *     попала в начало координат Group.
     *
     * @private
     * @param {THREE.Object3D} model - Загруженный `gltf.scene`.
     */
    _applyModelSizeAndAnchor(model) {
        // Временно отсоединяем модель, чтобы bbox считался без учёта
        // мировых трансформаций Group/worldGroup.
        const prevParent = model.parent;
        if (prevParent) prevParent.remove(model);

        // Сброс к оригинальным значениям.
        model.scale.copy(this._originalModelScale);
        model.position.copy(this._originalModelPosition);
        model.rotation.set(...this._rotation);

        // Применяем масштаб по size.
        if (this._size) {
            const scaleFactors = this._calculateModelScale(this._size, this._originalModelSize);
            model.scale.copy(scaleFactors);
        }

        // Обновляем мировые матрицы поддерева (родитель отсутствует → world = local).
        model.updateMatrixWorld(true);

        const box = new THREE.Box3().setFromObject(model);
        const size = box.getSize(new THREE.Vector3());
        this._height = size.y;

        // Радиус bounding-сферы: полдиагонали AABB. Anchor лежит внутри AABB,
        // значит сфера с центром в anchor и таким радиусом гарантированно
        // покрывает модель.
        this._boundingRadius = 0.5 * size.length();

        // Точка привязки в локальных координатах Group.
        const anchorPoint = new THREE.Vector3(
            box.min.x + this._anchor[0] * size.x,
            box.min.y + this._anchor[1] * size.y,
            box.min.z + this._anchor[2] * size.z
        );

        // Сдвигаем модель так, чтобы anchor оказался в начале координат Group.
        model.position.sub(anchorPoint);
        model.updateMatrix();

        // Возвращаем модель к прежнему родителю.
        if (prevParent) prevParent.add(model);
    }

    /**
     * Вычисляет масштаб модели по спецификации `options.size`.
     *
     * @private
     * @param {number|Array<number>} size - Спецификация размера.
     * @param {THREE.Vector3} originalSize - Оригинальные габариты модели.
     * @returns {THREE.Vector3} Вектор масштабирования по осям.
     * @throws {Error} Если массив имеет больше 3 элементов или тип неверный.
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
                    const scaleZ = (scaleX + scaleY) / 2;
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
     * Меняет размер маркера.
     *
     * Для примитивов пересоздаётся геометрия с сохранением текущей
     * позиции и поворота Mesh. Для GLB-моделей пересчитывается
     * масштаб и anchor-offset самого `_modelRoot` (Group-обёртка
     * остаётся нетронутой).
     *
     * @param {number|Array<number>} size - Новые размеры.
     * @returns {Marker3D} this
     */
    setSize(size) {
        this._size = size;
        if (!this._object3D) return this;
        if (this._modelUrl) {
            // Пока модель не загрузилась (или загрузка не удалась) —
            // просто запоминаем новый размер; он применится в _loadModel.
            if (this._isModelLoading || !this._modelRoot) return this;
            this._applyModelSizeAndAnchor(this._modelRoot);
        } else {
            if (this._object3D.parent) {
                const oldObject = this._object3D;
                const oldPosition = oldObject.position.clone();
                const oldRotation = oldObject.rotation.clone();
                oldObject.parent.remove(oldObject);
                this._createPrimitive();
                this._object3D.position.copy(oldPosition);
                this._object3D.rotation.copy(oldRotation);
                this._map.worldGroup.add(this._object3D);
            }
        }
        return this;
    }

    /**
     * Запускает анимацию изменения размера.
     *
     * @param {number|Array<number>} newSize - Конечный размер.
     * @param {number} [duration=1000] - Длительность анимации в миллисекундах.
     * @param {'linear'|'easeIn'|'easeOut'|'easeInOut'} [easing='linear'] - Функция плавности.
     * @returns {Marker3D} this
     */
    animateSize(newSize, duration = 1000, easing = 'linear') {
        let startSize = this._size;
        if (startSize === null) {
            if (this._isModel && this._originalModelSize) {
                startSize = Math.max(
                    this._originalModelSize.x,
                    this._originalModelSize.y,
                    this._originalModelSize.z
                );
            } else {
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
     * Возвращает текущую спецификацию размера.
     *
     * @returns {number|Array<number>|null} Размер.
     */
    getSize() { return this._size; }

    /**
     * Удаляет маркер с карты, освобождает ресурсы и сбрасывает состояние.
     *
     * @returns {void}
     */
    remove() {
        // Отписываемся от InteractionManager.
        if (this._unregisterInteraction) {
            this._unregisterInteraction();
            this._unregisterInteraction = null;
        }

        // Останавливаем и очищаем анимации.
        if (this._mixer) {
            this._mixer.stopAllAction();
            this._mixer = null;
            this._mixerClock = null;
        }

        if (this._object3D) {
            if (this._object3D.parent) this._object3D.parent.remove(this._object3D);
            if (this._geometry) this._geometry.dispose();
            if (this._material) this._material.dispose();
            this._object3D = null;
            this._modelRoot = null;
            this._geometry = null;
            this._material = null;
        }
        if (this._textLabel && this._map?.textManager) {
            this._map.textManager.removeLabel(this._textLabel);
            this._textLabel = null;
        }
        if (this._layer) {
            this._layer._removeRef(this);
            this._layer = null;
        }
        this._map = null;
        this._crs = null;
        this._isVisible = false;
        this._worldPosition.set(0, 0, 0);
        this._localBox = null;
        this._boundingRadius = 0;
        this._raycastMeshesCache = null;
    }

    /**
     * Обновляет анимацию размера (если активна).
     *
     * @private
     * @param {number} now - Текущее время в мс (`performance.now()`).
     */
    _updateSizeAnimation(now) {
        if (!this._sizeAnimation) return;
        const anim = this._sizeAnimation;
        const elapsed = now - anim.startTime;
        const t = Math.min(elapsed / anim.duration, 1);
        let progress;
        switch (anim.easing) {
            case 'easeIn':    progress = t * t; break;
            case 'easeOut':   progress = 1 - Math.pow(1 - t, 2); break;
            case 'easeInOut': progress = t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2; break;
            case 'linear':
            default:          progress = t; break;
        }
        const currentSize = this._lerpSize(anim.startSize, anim.endSize, progress);
        this.setSize(currentSize);
        if (t >= 1) {
            this._sizeAnimation = null;
            this.setSize(anim.endSize);
        }
    }

    /**
     * Линейная интерполяция двух спецификаций размера.
     *
     * @private
     * @param {number|Array<number>} start - Начальное значение.
     * @param {number|Array<number>} end - Конечное значение.
     * @param {number} t - Прогресс [0..1].
     * @returns {number|Array<number>} Интерполированное значение.
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
        return end;
    }

    /**
     * Ежекадровое обновление маркера: позиционирование, видимость,
     * проигрывание анимаций.
     *
     * @private
     * @param {import('./KrbMap.js').KrbMap} map - Экземпляр карты.
     */
    _update(map) {
        if (!this._map || !this._object3D) return;
        const mapInstance = this._map;
        const zoom = mapInstance.continuousZoom;

        // 1) Видимость слоя и диапазон зума.
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

        // 2) Анимация размера и GLB-анимации.
        this._updateSizeAnimation(performance.now());
        if (this._mixer && this._mixerClock) {
            const delta = this._mixerClock.getDelta();
            this._mixer.update(delta);
        }

        // 3) Координаты маркера → мировые координаты карты.
        const [absWorldX, absWorldZ] = mapInstance.project(this._coord, this._crs);
        const wgPos = mapInstance.worldGroup.position;
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
        } else {
            worldY = this._altitude;
        }

        // Позиция Group-обёртки (или Mesh для примитива) — чисто географическая.
        // Anchor-offset для моделей уже применён к _modelRoot внутри Group,
        // для примитивов — к геометрии.
        this._object3D.position.set(absWorldX, worldY, absWorldZ);
        this._worldPosition.set(worldX, worldY, worldZ);

        // 4) Отсечение по дальности.
        if (mapInstance.view.objectRenderDistanceFactor > 0) {
            const dist = mapInstance.camera.position.distanceTo(this._worldPosition);
            if (dist > mapInstance.maxObjectDistance) {
                this._object3D.visible = false;
                this._isVisible = false;
                return;
            }
        }

        // 5) Frustum culling.
        // Переиспользуем _tempProjScreenMatrix и _tempFrustum — без аллокаций.
        this._tempProjScreenMatrix.multiplyMatrices(
            mapInstance.camera.projectionMatrix,
            mapInstance.camera.matrixWorldInverse
        );
        this._tempFrustum.setFromProjectionMatrix(this._tempProjScreenMatrix);

        if (this._isModel) {
            this._tempBox.setFromObject(this._object3D);
        } else if (this._localBox) {
            this._object3D.updateWorldMatrix(true, false);
            this._tempBox.copy(this._localBox).applyMatrix4(this._object3D.matrixWorld);
        } else {
            this._object3D.visible = false;
            this._isVisible = false;
            return;
        }

        if (!this._tempFrustum.intersectsBox(this._tempBox)) {
            this._object3D.visible = false;
            this._isVisible = false;
            return;
        }

        this._object3D.visible = true;
        this._isVisible = true;
    }

    // ---------- Интерфейс для TextManager ----------

    /**
     * @returns {string} Текст подписи.
     */
    getText() { return this._title; }

    /**
     * @returns {Object} Стиль подписи.
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
     * @returns {{min: number, max: number}} Границы зума для подписи.
     */
    getTextZoomBounds() { return { min: this._titleMinZoom, max: this._titleMaxZoom }; }

    /**
     * @returns {'point'} Тип метки для TextManager.
     */
    getLabelType() { return 'point'; }

    /**
     * @returns {boolean} Видим ли маркер в данный момент.
     */
    isVisible() { return this._isVisible; }

    /**
     * Возвращает экранные координаты точки привязки подписи.
     *
     * Использует пул временных векторов карты (`map.getVec3()`) — без
     * аллокаций `new THREE.Vector3` в горячем пути.
     *
     * @returns {{x: number, y: number}|null} Экранные координаты или null.
     */
    getScreenPosition() {
        if (!this._isVisible || !this._object3D || !this._map) return null;
        const map = this._map;
        const canvas = map.renderer.domElement;

        // Ветка «не удалось получить bounding box»: примитив без _localBox
        // или ещё не загруженная модель. Используем точечную вершину.
        if (!this._isModel && !this._localBox) {
            const localTop = map.getVec3().set(
                0,
                this._height * (1 - this._anchor[1]),
                0
            );
            this._object3D.updateWorldMatrix(false, false);
            localTop.applyMatrix4(this._object3D.matrixWorld);
            const screenPos = map.getVec3().copy(localTop).project(map.camera);
            if (screenPos.z > 1 || Math.abs(screenPos.x) > 1 || Math.abs(screenPos.y) > 1) return null;
            return {
                x: (screenPos.x * 0.5 + 0.5) * canvas.clientWidth,
                y: (-screenPos.y * 0.5 + 0.5) * canvas.clientHeight
            };
        }

        // Иначе — стандартная ветка по 8 углам AABB.
        let box;
        if (this._isModel) {
            box = this._tempBox.setFromObject(this._object3D);
        } else {
            this._object3D.updateWorldMatrix(true, false);
            box = this._tempBox.copy(this._localBox).applyMatrix4(this._object3D.matrixWorld);
        }

        const corners = [];
        const { min, max } = box;
        for (let i = 0; i < 8; i++) {
            const corner = map.getVec3().set(
                (i & 1) ? max.x : min.x,
                (i & 2) ? max.y : min.y,
                (i & 4) ? max.z : min.z
            );
            corner.project(map.camera);
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
            default:       x = centerX; y = minY; break;
        }
        return { x, y };
    }

    /**
     * @returns {string} Горизонтальное выравнивание подписи.
     */
    getTitleAlign() { return this._titleAlign; }

    /**
     * @returns {[number, number]} Смещение подписи в пикселях.
     */
    getTitleOffset() { return this._titleOffset; }

    /**
     * @returns {'top'|'bottom'|'center'} Вертикальное выравнивание подписи.
     */
    getTitleVerticalAlign() {
        switch (this._titlePlacement) {
            case 'bottom': return 'top';
            case 'left':
            case 'right': return 'center';
            case 'top':
            default: return 'bottom';
        }
    }

    /**
     * @returns {boolean} Разрешать ли переполнение подписи за границы карты.
     */
    getAllowOverflow() { return false; }

    /**
     * @returns {number} Приоритет подписи (для разрешения коллизий).
     */
    getPriority() { return 0; }

    /**
     * @returns {boolean} Участвует ли маркер в кластеризации.
     */
    getClusterable() { return this._clusterable; }

    /**
     * Устанавливает цвет примитива или всех материалов модели.
     *
     * @param {string|number} color - Цвет в формате, поддерживаемом `THREE.Color`.
     * @returns {void}
     */
    setColor(color) {
        this._color = color;
        if (this._object3D && this._object3D.material) {
            this._object3D.material.color.set(color);
        } else if (this._object3D) {
            this._object3D.traverse((child) => {
                if (child.isMesh && child.material) {
                    child.material.color.set(color);
                }
            });
        }
    }

    // ---------- Интерфейс для KrbMap#fitTo / getBounds ----------

    /**
     * Возвращает прямоугольник (bounding box), охватывающий 3D-маркер.
     *
     * Поскольку 3D-маркер — точечный объект (позиция привязки), метод
     * возвращает вырожденный прямоугольник `[[x, y], [x, y]]`. Его реальный
     * «след» на земле не учитывается: для `fitTo` важна именно точка
     * привязки — так же, как для обычного {@link Marker}.
     *
     * Используется методом {@link KrbMap#fitTo} для подгонки вида.
     * Если маркер привязан к карте (`_crs` резолвлена), преобразование
     * выполняется из его СК. Если не привязан, но задан `_crsCode` —
     * из него. В остальных случаях координаты считаются уже в WGS84.
     *
     * @param {string|import('./Projections.js').Projection} [crs='EPSG:4326'] -
     *     Целевая СК для результата (код или объект Projection).
     * @returns {Array.<Array.<number>>|null} [[x, y], [x, y]] или null,
     *     если преобразование невозможно.
     *
     * @example
     * const b = marker3d.getBounds();               // → [[37.66, 55.76], [37.66, 55.76]]
     * const bUtm = marker3d.getBounds('EPSG:32637'); // → [[413500, 6178000], ...]
     */
    getBounds(crs = 'EPSG:4326') {
        const src = this._crs
            ?? (this._crsCode ? Projections.get(this._crsCode) : Projections.get('EPSG:4326'));
        const dst = typeof crs === 'string' ? Projections.get(crs) : crs;
        if (!src || !dst) return null;

        let x, y;
        if (src === dst) {
            x = this._coord[0];
            y = this._coord[1];
        } else {
            const lonLat = src.toLonLat(this._coord);
            const converted = dst.fromLonLat(lonLat);
            x = converted[0];
            y = converted[1];
        }
        return [[x, y], [x, y]];
    }
}