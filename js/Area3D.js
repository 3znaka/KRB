/**
 * Модуль Area3D — 3D-объект, привязанный к площадной геометрии (полигону).
 * Позволяет размещать GLB-модели или примитивы внутри четырёхугольного
 * полигона с возможностью растягивания/вписывания, поворота и учётом рельефа.
 *
 * Координаты колец задаются в системе координат `options.crs`.
 * Если `crs` не указан, используется `map.inputCRS` (по умолчанию WGS84).
 * Внутри карты координаты автоматически преобразуются в метры проекции
 * карты (`map.projection`) через {@link KrbMap#project}.
 *
 * Взаимодействие с указателем (hover / click / tooltip) делегировано
 * {@link InteractionManager} — единому менеджеру карты. Area3D лишь
 * регистрирует колбэки при `_attach` и снимает регистрацию в `remove`.
 *
 * @example
 * const area = new Area3D({
 *     rings: [[[30.5, 50.4], [31.0, 50.5], [31.2, 50.7], [30.8, 50.8], [30.5, 50.4]]],
 *     modelUrl: './ladder.glb',
 *     fit: 'stretch',
 *     rotate: 0,
 *     altitudeMode: 'clampToGround',
 *     altitude: 5,
 *     title: 'Здание',
 *     onClick: (e, obj) => console.log('Клик по Area3D', obj)
 * });
 * area.addTo(map);
 */

import { THREE, GLTFLoader, DRACOLoader } from '../js_TP/tpb.js';
import { Projections } from './Projections.js';
import { Layer } from './Layers.js';

/**
 * Render order, при котором Area3D рисуется поверх тайлов любого уровня.
 *
 * @private
 * @type {number}
 */
const AREA3D_RENDER_ORDER = 1000;

/**
 * 3D-объект на площадной геометрии (полигоне).
 *
 * Отличается от {@link Marker3D} тем, что модель/примитив не привязывается
 * к точке, а «растягивается» или «вписывается» в четырёхугольный полигон,
 * повёрнутый вдоль его самой длинной стороны. Поддерживает GLB-модели
 * (с анимациями) и примитивы (box/sphere/cylinder/cone).
 */
export class Area3D {
    /**
     * Создаёт Area3D.
     *
     * @param {Object} options - Настройки.
     * @param {Array<Array<[number,number]>>} options.rings - Кольца полигона
     *     в СК `options.crs` (по умолчанию — [долгота, широта] в градусах WGS84).
     *     Первое кольцо — внешний контур, минимум 3 точки.
     * @param {string} [options.crs] - Код СК координат `rings` (например,
     *     'EPSG:4326', 'EPSG:3857', 'EPSG:32637'). Если не указан —
     *     используется `map.inputCRS`. Перед созданием объекта соответствующая
     *     проекция должна быть зарегистрирована в `Projections`.
     * @param {string} [options.modelUrl] - URL GLB-модели (если не задан —
     *     строится примитив).
     * @param {string} [options.primitiveType='box'] - Тип примитива:
     *     'box', 'sphere', 'cylinder', 'cone'.
     * @param {number|number[]} [options.size] - Размеры примитива.
     * @param {string} [options.fit='stretch'] - Режим вписывания модели
     *     в полигон: 'stretch' или 'contain'.
     * @param {number} [options.rotate=0] - Поворот модели (0-3, кратно 90°).
     * @param {number} [options.altitude=0] - Высота над поверхностью
     *     (для clampToGround) или абсолютная (для absolute).
     * @param {string} [options.altitudeMode='clampToGround'] - Режим высоты.
     * @param {[number, number, number]} [options.anchor=[0.5,0,0.5]] -
     *     Точка привязки.
     * @param {number} [options.minZoom=-Infinity] - Минимальный зум видимости.
     * @param {number} [options.maxZoom=Infinity] - Максимальный зум видимости.
     * @param {boolean} [options.playAnimation=true] - Воспроизводить ли
     *     встроенные анимации GLB.
     * @param {string|number} [options.color=0x3388ff] - Цвет примитива.
     * @param {boolean} [options.depthTest=true] - Тест глубины.
     * @param {boolean} [options.depthWrite=true] - Запись глубины.
     * @param {string} [options.title=''] - Текст постоянной подписи.
     * @param {Object} [options.titleStyle] - CSS-стили подписи.
     * @param {number} [options.titleMinZoom=-Infinity] - Минимальный зум подписи.
     * @param {number} [options.titleMaxZoom=Infinity] - Максимальный зум подписи.
     * @param {string} [options.titlePlacement='top'] - Положение подписи:
     *     'top', 'bottom', 'left', 'right'.
     * @param {string} [options.titleAlign] - Горизонтальное выравнивание
     *     подписи (по умолчанию зависит от placement).
     * @param {[number, number]} [options.titleOffset] - Смещение подписи
     *     в пикселях (по умолчанию зависит от placement).
     * @param {string} [options.tooltip=''] - HTML-текст всплывающей подсказки.
     * @param {Function} [options.onClick] - Обработчик клика.
     * @param {Function} [options.onHover] - Обработчик наведения.
     * @throws {Error} Если `options.rings` не задан или первое кольцо
     *     содержит менее 3 точек.
     */
    constructor(options = {}) {
        if (!options.rings || !options.rings.length || options.rings[0].length < 3) {
            throw new Error('Area3D: options.rings is required with at least one ring of 3+ points');
        }

        /** @private @type {Array<Array<[number,number]>>} */ this._rings = options.rings;

        /**
         * Код СК колец; null — использовать `map.inputCRS`.
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

        /** @private @type {string|null} */  this._modelUrl = options.modelUrl || null;
        /** @private @type {string} */       this._primitiveType = options.primitiveType || 'box';
        /** @private @type {number|number[]|null} */ this._size = options.size || null;
        /** @private @type {string} */       this._fit = options.fit || 'stretch';
        /** @private @type {number} */       this._rotate = options.rotate || 0;
        /** @private @type {number} */       this._altitude = options.altitude ?? 0;
        /** @private @type {string} */       this._altitudeMode = options.altitudeMode || 'clampToGround';
        /** @private @type {[number,number,number]} */ this._anchor = options.anchor || [0.5, 0, 0.5];
        /** @private @type {number} */       this._minZoom = options.minZoom ?? -Infinity;
        /** @private @type {number} */       this._maxZoom = options.maxZoom ?? Infinity;
        /** @private @type {boolean} */      this._playAnimation = options.playAnimation !== undefined ? options.playAnimation : true;
        /** @private @type {string|number} */ this._color = options.color || 0x3388ff;
        /** @private @type {boolean} */      this._depthTest = options.depthTest ?? true;
        /** @private @type {boolean} */      this._depthWrite = options.depthWrite ?? true;

        // Подпись
        /** @private @type {string} */       this._title = options.title || '';
        /** @private @type {Object} */       this._titleStyle = options.titleStyle || {};
        /** @private @type {number} */       this._titleMinZoom = options.titleMinZoom ?? -Infinity;
        /** @private @type {number} */       this._titleMaxZoom = options.titleMaxZoom ?? Infinity;
        /** @private @type {string} */       this._titlePlacement = options.titlePlacement || 'top';
        /** @private @type {string} */       this._titleAlign = options.titleAlign || this._defaultTitleAlign();
        /** @private @type {[number, number]} */ this._titleOffset = options.titleOffset || this._defaultTitleOffset();

        // События
        /** @private @type {string} */       this._tooltipText = options.tooltip || '';
        /** @private @type {Function|null} */ this._onClick = options.onClick || null;
        /** @private @type {Function|null} */ this._onHover = options.onHover || null;

        // Карта и слои
        /** @private @type {import('./KrbMap.js').KrbMap|null} */ this._map = null;
        /** @private @type {Layer|null} */   this._layer = null;

        // Иерархия объектов: group → modelContainer → object3D
        /** @private @type {THREE.Group} */  this._group = new THREE.Group();
        /** @private @type {THREE.Group} */  this._modelContainer = new THREE.Group();
        this._group.add(this._modelContainer);

        /** @private @type {THREE.Object3D|null} */ this._object3D = null;

        // Анимации GLB
        /** @private @type {THREE.AnimationMixer|null} */ this._mixer = null;
        /** @private @type {THREE.Clock|null} */          this._mixerClock = null;

        /** @private @type {boolean} */      this._isModelLoading = false;
        /** @private @type {Promise<void>|null} */ this._modelPromise = null;
        /** @private @type {THREE.Vector3|null} */ this._originalModelSize = null;
        /** @private @type {THREE.Vector3|null} */ this._originalModelScale = null;
        /** @private @type {THREE.Vector3|null} */ this._originalModelPosition = null;

        // Геометрические параметры полигона (мировые метры)
        /** @private @type {THREE.Vector3} */ this._centroidWorld = new THREE.Vector3();
        /** @private @type {number} */       this._polygonAngle = 0;
        /** @private @type {number} */       this._polygonWidth = 0;
        /** @private @type {number} */       this._polygonDepth = 0;
        /** @private @type {Array<[number, number]>} */ this._worldCoords = [];

        // Кэш высоты рельефа
        /** @private @type {number} */       this._cachedSurfaceHeight = 0;
        /** @private @type {number} */       this._lastHeightUpdateTime = 0;
        /** @private @type {number} */       this._heightUpdateInterval = 500;
        /** @private @type {THREE.Vector3} */ this._lastWorldGroupPos = new THREE.Vector3();

        // Нормализуем rotate к 0..3.
        this._rotate = Math.min(3, Math.max(0, Math.floor(this._rotate)));

        // Экранная позиция подписи (кэшируется на время одного кадра).
        /** @private @type {{x: number, y: number}|null} */ this._centroidScreenPos = null;
        /** @private @type {Object|null} */  this._textLabel = null;

        // Вспомогательные поля для InteractionManager
        /**
         * Радиус bounding-сферы в мировых единицах. Вычисляется в
         * `_recomputeBoundingRadius` после сборки/загрузки модели.
         * @private
         * @type {number}
         */
        this._boundingRadius = 0;

        /**
         * Смещение центра bounding-сферы по Y в локальных координатах
         * группы `_group`. Обычно ≈ половина высоты модели.
         * @private
         * @type {number}
         */
        this._boundingCenterYLocal = 0;

        /**
         * Переиспользуемый вектор мирового центра bounding-сферы.
         * Каждый вызов `getBoundingSphere` пишет сюда актуальное значение
         * и возвращает ссылку на этот же объект.
         * @private
         * @type {THREE.Vector3}
         */
        this._boundingSphereWorldCenter = new THREE.Vector3();

        /**
         * Кэш массива мешей для raycast. Пересобирается при смене `_object3D`.
         * @private
         * @type {THREE.Object3D[]|null}
         */
        this._raycastMeshesCache = null;

        /**
         * Функция отмены регистрации в `map.interaction`.
         * @private
         * @type {(() => void)|null}
         */
        this._unregisterInteraction = null;

        /**
         * Переиспользуемый Box3 для `_updateScreenPosition`.
         * @private
         * @type {THREE.Box3}
         */
        this._tempBox = new THREE.Box3();
    }

    /**
     * Возвращает горизонтальное выравнивание подписи по умолчанию
     * для текущего `titlePlacement`.
     *
     * @private
     * @returns {string} 'left' | 'center' | 'right'
     */
    _defaultTitleAlign() {
        switch (this._titlePlacement) {
            case 'top':
            case 'bottom': return 'center';
            case 'left':   return 'right';
            case 'right':  return 'left';
            default:       return 'center';
        }
    }

    /**
     * Возвращает смещение подписи по умолчанию (в пикселях)
     * для текущего `titlePlacement`.
     *
     * @private
     * @returns {[number, number]}
     */
    _defaultTitleOffset() {
        switch (this._titlePlacement) {
            case 'top':    return [0, -10];
            case 'bottom': return [0, 10];
            case 'left':   return [-10, 0];
            case 'right':  return [10, 0];
            default:       return [0, -10];
        }
    }

    /**
     * Создаёт персональный слой, добавляет его на карту и помещает в него
     * данный Area3D.
     *
     * @param {import('./KrbMap.js').KrbMap} map - Экземпляр карты.
     * @returns {Area3D} this
     */
    addTo(map) {
        if (this._map) this.remove();
        const personalLayer = new Layer();
        personalLayer.addTo(map);
        personalLayer.add(this);
        return this;
    }

    /**
     * Внутренняя привязка Area3D к карте и слою.
     *
     * @private
     * @param {import('./KrbMap.js').KrbMap} map - Экземпляр карты.
     * @param {Layer} layer - Слой-владелец.
     */
    _attach(map, layer) {
        if (this._map === map && this._layer === layer) return;
        this.remove();
        this._map = map;
        this._layer = layer;

        // Резолвим проекцию Area3D: либо заданную явно, либо inputCRS карты.
        this._crs = this._crsCode
            ? Projections.get(this._crsCode)
            : map.inputCRS;

        this._calculatePolygonParams();
        this._group.position.set(this._centroidWorld.x, 0, this._centroidWorld.z);
        map.worldGroup.add(this._group);

        if (this._modelUrl) {
            this._isModelLoading = true;
            this._loadModel();
        } else {
            this._createPrimitive();
        }

        if (this._title && map.textManager) {
            this._textLabel = map.textManager.addLabel(this);
        }

        this._registerInteraction(map);
        this._lastWorldGroupPos.copy(map.worldGroup.position);
    }

    /**
     * Регистрирует Area3D в общем InteractionManager карты.
     *
     * Если у объекта нет ни `onClick`, ни `onHover`, ни `tooltip` —
     * регистрация не выполняется.
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

        const callbacks = {
            getMeshes: () => this._getRaycastMeshes(),
            getBoundingSphere: () => {
                if (this._boundingRadius <= 0) return null;
                const wgPos = map.worldGroup.position;
                this._boundingSphereWorldCenter.set(
                    this._group.position.x + wgPos.x,
                    this._group.position.y + wgPos.y + this._boundingCenterYLocal,
                    this._group.position.z + wgPos.z
                );
                return {
                    center: this._boundingSphereWorldCenter,
                    radius: this._boundingRadius
                };
            },
            isVisible: () => this._group.visible
        };

        // Пользовательский onHover имеет приоритет над tooltip.
        if (this._onHover) {
            callbacks.onHover = (isHovered) => this._onHover(isHovered);
        } else if (this._tooltipText) {
            callbacks.getTooltip = () => this._tooltipText;
        }

        if (this._onClick) {
            callbacks.onClick = (event) => this._onClick(event, this);
        }

        this._unregisterInteraction = map.interaction.register(this, callbacks);
    }

    /**
     * Возвращает массив мешей для raycast.
     *
     * Возвращает закэшированный массив (пересобирается при смене `_object3D`).
     * Возвращаемый массив не должен мутироваться вызывающей стороной.
     *
     * @private
     * @returns {THREE.Object3D[]} Массив мешей (может быть пустым).
     */
    _getRaycastMeshes() {
        if (this._raycastMeshesCache) return this._raycastMeshesCache;
        if (!this._object3D) return [];
        const meshes = [];
        if (this._object3D.isMesh) {
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
     * Вычисляет параметры полигона: центроид, направление длинной стороны,
     * ширину и глубину в системе координат, выровненной по длинной стороне.
     * Результаты сохраняются в поля `_centroidWorld`, `_polygonAngle`,
     * `_polygonWidth`, `_polygonDepth`.
     *
     * @private
     */
    _calculatePolygonParams() {
        const outerRing = this._rings[0];
        this._worldCoords.length = 0;

        let sumX = 0, sumZ = 0;
        const uniquePoints = [];
        for (let i = 0; i < outerRing.length; i++) {
            // Координата кольца → метры проекции карты.
            const [absX, absZ] = this._map.project(outerRing[i], this._crs);
            if (i > 0 && absX === uniquePoints[0]?.[0] && absZ === uniquePoints[0]?.[1]) continue;
            uniquePoints.push([absX, absZ]);
            this._worldCoords.push([absX, absZ]);
            sumX += absX;
            sumZ += absZ;
        }
        const centroidX = sumX / this._worldCoords.length;
        const centroidZ = sumZ / this._worldCoords.length;
        this._centroidWorld.set(centroidX, 0, centroidZ);

        if (this._worldCoords.length < 3) return;

        let maxLenSq = -1;
        let dirX = 0, dirZ = 0;
        for (let i = 0; i < this._worldCoords.length; i++) {
            const j = (i + 1) % this._worldCoords.length;
            const dx = this._worldCoords[j][0] - this._worldCoords[i][0];
            const dz = this._worldCoords[j][1] - this._worldCoords[i][1];
            const lenSq = dx * dx + dz * dz;
            if (lenSq > maxLenSq) {
                maxLenSq = lenSq;
                dirX = dx;
                dirZ = dz;
            }
        }
        if (maxLenSq === 0) return;

        this._polygonAngle = Math.atan2(dirZ, dirX);

        const cos = Math.cos(-this._polygonAngle);
        const sin = Math.sin(-this._polygonAngle);
        let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
        for (const [x, z] of this._worldCoords) {
            const localX = x - centroidX;
            const localZ = z - centroidZ;
            const rotatedX = localX * cos - localZ * sin;
            const rotatedZ = localX * sin + localZ * cos;
            if (rotatedX < minX) minX = rotatedX;
            if (rotatedX > maxX) maxX = rotatedX;
            if (rotatedZ < minZ) minZ = rotatedZ;
            if (rotatedZ > maxZ) maxZ = rotatedZ;
        }
        this._polygonWidth = maxX - minX;
        this._polygonDepth = maxZ - minZ;
    }

    /**
     * Создаёт примитив (Mesh) по заданным параметрам и вписывает его
     * в полигон в соответствии с `fit`.
     *
     * @private
     */
    _createPrimitive() {
        let [w, h, d] = this._normalizeSize(this._size);
        if (this._fit === 'stretch') {
            w = this._polygonWidth;
            d = this._polygonDepth;
            if (this._size !== null) {
                [, h] = this._normalizeSize(this._size);
            }
        } else if (this._fit === 'contain') {
            const scale = Math.min(this._polygonWidth / w, this._polygonDepth / d);
            w *= scale;
            d *= scale;
            h *= scale;
        }

        let geometry;
        switch (this._primitiveType.toLowerCase()) {
            case 'sphere':   geometry = new THREE.SphereGeometry(w / 2, 32, 32); break;
            case 'cylinder': geometry = new THREE.CylinderGeometry(w / 2, w / 2, h, 32); break;
            case 'cone':     geometry = new THREE.ConeGeometry(w / 2, h, 32); break;
            case 'box':
            default:         geometry = new THREE.BoxGeometry(w, h, d); break;
        }
        const material = new THREE.MeshStandardMaterial({
            color: this._color,
            roughness: 0.5,
            depthTest: this._depthTest,
            depthWrite: this._depthWrite
        });
        const mesh = new THREE.Mesh(geometry, material);
        mesh.renderOrder = AREA3D_RENDER_ORDER;
        this._object3D = mesh;
        this._modelContainer.add(mesh);
        this._applyModelTransform();

        // Модель сменилась — кэш мешей невалиден.
        this._raycastMeshesCache = null;
    }

    /**
     * Асинхронно загружает GLB-модель и добавляет её в `_modelContainer`.
     *
     * @private
     * @returns {Promise<void>} Промис завершения загрузки.
     */
    async _loadModel() {
        if (this._modelPromise) return this._modelPromise;
        this._modelPromise = (async () => {
            try {
                const loader = new GLTFLoader();

                // Настройка DRACOLoader для поддержки сжатых моделей.
                const dracoLoader = new DRACOLoader();
                dracoLoader.setDecoderPath('https://cdn.mapengine.ru/KRB/js_TP/draco/');
                dracoLoader.setDecoderConfig({ type: 'wasm' });
                loader.setDRACOLoader(dracoLoader);

                const gltf = await loader.loadAsync(this._modelUrl);
                const model = gltf.scene;

                if (this._playAnimation && gltf.animations?.length) {
                    this._mixer = new THREE.AnimationMixer(model);
                    for (const clip of gltf.animations) {
                        this._mixer.clipAction(clip).play();
                    }
                    this._mixerClock = new THREE.Clock();
                }

                const box = new THREE.Box3().setFromObject(model);
                this._originalModelSize = box.getSize(new THREE.Vector3());
                this._originalModelScale = model.scale.clone();
                this._originalModelPosition = model.position.clone();

                model.traverse((child) => {
                    if (child.isMesh) {
                        child.renderOrder = AREA3D_RENDER_ORDER;
                        child.castShadow = true;
                        child.receiveShadow = true;
                        if (child.material) {
                            child.material.depthTest = this._depthTest;
                            child.material.depthWrite = this._depthWrite;
                        }
                    }
                });
                this._object3D = model;
                this._modelContainer.add(model);
                this._applyModelTransform();
                this._isModelLoading = false;

                // Модель сменилась — кэш мешей невалиден.
                this._raycastMeshesCache = null;
            } catch (err) {
                console.warn('Area3D: GLB loading failed:', err);
                this._isModelLoading = false;
            }
        })();
        return this._modelPromise;
    }

    /**
     * Применяет к объекту трансформации: масштаб (по `fit` и `size`),
     * поворот по длинной стороне полигона, anchor-offset.
     *
     * Работает одинаково для примитивов и GLB. Порядок операций:
     *  1. Сброс position/scale/rotation.
     *  2. Временное отсоединение модели для честного расчёта bbox в локальных
     *     координатах (без родителя).
     *  3. Применение масштаба по `fit` и `size`.
     *  4. Применение поворота вокруг Y.
     *  5. Расчёт transformed bbox, вычисление anchor-offset, сдвиг `position`.
     *  6. Пересчёт радиуса bounding-сферы (для InteractionManager).
     *
     * @private
     */
    _applyModelTransform() {
        if (!this._object3D) return;

        const model = this._object3D;
        const parent = model.parent;

        // Сброс трансформаций.
        model.position.set(0, 0, 0);
        model.scale.set(1, 1, 1);
        model.rotation.set(0, 0, 0);
        model.updateMatrixWorld(true);

        // Получаем локальный bounding box (без родительского поворота).
        if (parent) parent.remove(model);
        model.updateMatrixWorld(true);
        const box = new THREE.Box3().setFromObject(model);
        const size = box.getSize(new THREE.Vector3());
        if (parent) parent.add(model);

        const rotate = this._rotate; // 0..3

        // Определяем, какие исходные оси модели после поворота rotate*90°
        // будут соответствовать ширине и глубине полигона.
        const widthModel = (rotate % 2 === 0) ? size.x : size.z;
        const depthModel = (rotate % 2 === 0) ? size.z : size.x;

        let targetW, targetH, targetD;
        if (this._fit === 'stretch') {
            targetW = this._polygonWidth;
            targetD = this._polygonDepth;
            if (this._size) {
                const [, hFromSize] = this._normalizeSize(this._size);
                targetH = hFromSize;
            } else {
                // Равномерный масштаб contain на основе "повёрнутых" осей.
                const containScale = Math.min(
                    this._polygonWidth / widthModel,
                    this._polygonDepth / depthModel
                );
                targetH = size.y * containScale;
            }
        } else if (this._fit === 'contain') {
            const containScale = Math.min(
                this._polygonWidth / widthModel,
                this._polygonDepth / depthModel
            );
            targetW = widthModel * containScale;
            targetH = size.y * containScale;
            targetD = depthModel * containScale;
        } else {
            if (this._size) {
                [targetW, targetH, targetD] = this._normalizeSize(this._size);
            } else {
                targetW = size.x;
                targetH = size.y;
                targetD = size.z;
            }
        }

        // Вычисляем масштабы с учётом rotate: при нечётном повороте
        // оси X и Z меняются местами.
        let scaleX, scaleZ;
        if (rotate % 2 === 0) {
            scaleX = targetW / size.x;
            scaleZ = targetD / size.z;
        } else {
            scaleX = targetD / size.x;
            scaleZ = targetW / size.z;
        }
        const scaleY = targetH / size.y;

        model.scale.set(scaleX, scaleY, scaleZ);

        const totalAngle = this._polygonAngle + rotate * Math.PI / 2;
        model.rotation.y = totalAngle;

        model.updateMatrixWorld(true);

        // Временно убираем модель, чтобы получить локальный transformed box.
        if (parent) parent.remove(model);
        model.updateMatrixWorld(true);
        const transformedBox = new THREE.Box3().setFromObject(model);
        const transformedSize = transformedBox.getSize(new THREE.Vector3());
        const transformedMin = transformedBox.min.clone();
        if (parent) parent.add(model);

        const anchorPoint = new THREE.Vector3(
            transformedMin.x + this._anchor[0] * transformedSize.x,
            transformedMin.y + this._anchor[1] * transformedSize.y,
            transformedMin.z + this._anchor[2] * transformedSize.z
        );

        model.position.sub(anchorPoint);
        model.updateMatrixWorld(true);

        this._recomputeBoundingRadius();
    }

    /**
     * Пересчитывает радиус и вертикальный центр bounding-сферы,
     * используемой InteractionManager для broad-phase.
     *
     * Радиус берётся как полдиагональ AABB объекта (без родительских
     * трансформаций), центр по Y — середина AABB. Это безопасная
     * верхняя оценка, покрывающая модель с запасом.
     *
     * @private
     */
    _recomputeBoundingRadius() {
        if (!this._object3D) {
            this._boundingRadius = 0;
            this._boundingCenterYLocal = 0;
            return;
        }
        const parent = this._object3D.parent;
        if (parent) parent.remove(this._object3D);
        this._object3D.updateMatrixWorld(true);
        const box = new THREE.Box3().setFromObject(this._object3D);
        if (parent) parent.add(this._object3D);

        const size = box.getSize(new THREE.Vector3());
        this._boundingRadius = 0.5 * size.length();
        this._boundingCenterYLocal = box.min.y + size.y / 2;
    }

    /**
     * Приводит `size` к каноническому виду `[width, height, depth]`.
     *
     * @private
     * @param {number|Array<number>|null} size - Исходное значение.
     * @returns {[number, number, number]} Тройка размеров.
     * @throws {Error} Если массив содержит более 3 элементов или тип неверный.
     */
    _normalizeSize(size) {
        if (!size) return [100, 100, 100];
        if (typeof size === 'number') return [size, size, size];
        if (Array.isArray(size)) {
            if (size.length === 1) return [size[0], size[0], size[0]];
            if (size.length === 2) return [size[0], size[1], size[0]];
            if (size.length === 3) return [size[0], size[1], size[2]];
            throw new Error('Area3D: size array must have 1, 2, or 3 elements');
        }
        throw new Error('Area3D: invalid size type');
    }

    /**
     * Ежекадровое обновление: видимость по зуму и дальности, положение
     * по рельефу, проигрывание GLB-анимаций.
     *
     * @private
     * @param {import('./KrbMap.js').KrbMap} map - Экземпляр карты.
     */
    _update(map) {
        if (!this._map || !this._group) return;
        const zoom = map.continuousZoom;

        if (this._layer && !this._layer.visible) {
            this._group.visible = false;
            return;
        }
        if (zoom < this._minZoom || zoom > this._maxZoom) {
            this._group.visible = false;
            return;
        }

        if (map.maxObjectDistance !== Infinity && this._object3D) {
            const worldPos = map.getVec3()
                .copy(this._group.position)
                .add(map.worldGroup.position);
            const dist = map.camera.position.distanceTo(worldPos);
            if (dist > map.maxObjectDistance) {
                this._group.visible = false;
                return;
            }
        }

        this._group.visible = true;

        // Обновление высоты основания.
        if (this._altitudeMode === 'clampToGround') {
            const now = performance.now();
            if (now - this._lastHeightUpdateTime > this._heightUpdateInterval ||
                !this._lastWorldGroupPos.equals(map.worldGroup.position)) {
                const worldX = this._centroidWorld.x + map.worldGroup.position.x;
                const worldZ = this._centroidWorld.z + map.worldGroup.position.z;
                map.ensureTileForPoint?.(worldX, worldZ);
                this._cachedSurfaceHeight = map.getSurfaceHeightAt(worldX, worldZ);
                this._lastHeightUpdateTime = now;
                this._lastWorldGroupPos.copy(map.worldGroup.position);
            }
            this._group.position.y = this._cachedSurfaceHeight + this._altitude;
            this._group.updateMatrixWorld(true);
        } else {
            this._group.position.y = this._altitude;
            this._group.updateMatrixWorld(true);
        }

        if (this._mixer && this._mixerClock) {
            const delta = this._mixerClock.getDelta();
            this._mixer.update(delta);
        }
    }

    /**
     * Пересчитывает экранную позицию точки привязки подписи.
     *
     * Использует переиспользуемый `_tempBox` и пул векторов карты
     * (`map.getVec3()`) — без аллокаций `new THREE.Vector3` в цикле
     * по 8 углам AABB.
     *
     * @private
     */
    _updateScreenPosition() {
        if (!this._map || !this._object3D) {
            this._centroidScreenPos = null;
            return;
        }
        this._object3D.updateWorldMatrix(true, true);
        const box = this._tempBox.setFromObject(this._object3D);
        const canvas = this._map.renderer.domElement;
        const camera = this._map.camera;
        const corners = [];
        const { min, max } = box;
        for (let i = 0; i < 8; i++) {
            const corner = this._map.getVec3().set(
                (i & 1) ? max.x : min.x,
                (i & 2) ? max.y : min.y,
                (i & 4) ? max.z : min.z
            );
            corner.project(camera);
            if (corner.z < -1 || corner.z > 1) continue;
            corners.push({
                x: (corner.x * 0.5 + 0.5) * canvas.clientWidth,
                y: (-corner.y * 0.5 + 0.5) * canvas.clientHeight
            });
        }
        if (!corners.length) {
            this._centroidScreenPos = null;
            return;
        }
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
        this._centroidScreenPos = { x, y };
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
     * @returns {'area3d'} Тип метки для TextManager.
     */
    getLabelType() { return 'area3d'; }

    /**
     * @returns {boolean} Видим ли объект в данный момент.
     */
    isVisible() { return this._group?.visible ?? false; }

    /**
     * Возвращает экранную позицию точки привязки подписи.
     *
     * На каждом вызове пересчитывает bbox объекта — так же, как раньше.
     * Если нужно реже — можно вынести вызов `_updateScreenPosition()`
     * в `_update` и кэшировать на кадр.
     *
     * @returns {{x: number, y: number}|null} Экранные координаты или null.
     */
    getScreenPosition() {
        this._updateScreenPosition();
        return this._centroidScreenPos;
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
     * @returns {number} Приоритет подписи.
     */
    getPriority() { return 0; }

    /**
     * @returns {boolean} Участвует ли объект в кластеризации.
     */
    getClusterable() { return false; }

    /**
     * Удаляет объект с карты, освобождает ресурсы и сбрасывает состояние.
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

        if (this._group) {
            this._group.parent?.remove(this._group);
            if (this._object3D) {
                this._object3D.traverse((child) => {
                    if (child.isMesh) {
                        child.geometry?.dispose();
                        if (Array.isArray(child.material)) {
                            child.material.forEach((m) => m.dispose());
                        } else {
                            child.material?.dispose();
                        }
                    }
                });
                this._object3D = null;
            }
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
        this._raycastMeshesCache = null;
        this._boundingRadius = 0;
        this._boundingCenterYLocal = 0;
        this._centroidScreenPos = null;
    }

    // ---------- Интерфейс для KrbMap#fitTo / getBounds ----------

    /**
     * Возвращает прямоугольник (bounding box), охватывающий площадную
     * геометрию Area3D целиком, включая все кольца (внешнее и отверстия).
     *
     * Используется методом {@link KrbMap#fitTo} для подгонки вида.
     * Если объект привязан к карте (`_crs` резолвлена), координаты
     * преобразуются из его СК. Если не привязан, но задан `_crsCode` —
     * из него. В остальных случаях исходные координаты считаются уже
     * в WGS84 (это соответствует поведению конструктора по умолчанию,
     * где `map.inputCRS` = EPSG:4326).
     *
     * @param {string|import('./Projections.js').Projection} [crs='EPSG:4326'] -
     *     Целевая СК для результата (код или объект Projection).
     * @returns {Array.<Array.<number>>|null} [[minX, minY], [maxX, maxY]]
     *     или null, если у объекта нет колец или преобразование невозможно.
     *
     * @example
     * const b = area.getBounds();                 // → [[30.5, 50.4], [31.2, 50.8]]
     * const bUtm = area.getBounds('EPSG:32637');  // → [[413500, 6178000], ...]
     */
    getBounds(crs = 'EPSG:4326') {
        if (!this._rings || !this._rings.length) return null;

        const src = this._crs
            ?? (this._crsCode ? Projections.get(this._crsCode) : Projections.get('EPSG:4326'));
        const dst = typeof crs === 'string' ? Projections.get(crs) : crs;
        if (!src || !dst) return null;

        const sameProjection = src === dst;
        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
        let count = 0;

        for (const ring of this._rings) {
            if (!ring) continue;
            for (let i = 0; i < ring.length; i++) {
                const pt = ring[i];
                if (!pt || pt.length < 2) continue;
                let x, y;
                if (sameProjection) {
                    x = pt[0];
                    y = pt[1];
                } else {
                    const lonLat = src.toLonLat(pt);
                    const converted = dst.fromLonLat(lonLat);
                    x = converted[0];
                    y = converted[1];
                }
                if (x < minX) minX = x;
                if (x > maxX) maxX = x;
                if (y < minY) minY = y;
                if (y > maxY) maxY = y;
                count++;
            }
        }
        if (count === 0 || !isFinite(minX)) return null;
        return [[minX, minY], [maxX, maxY]];
    }
}