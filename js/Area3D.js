/**
 * Модуль Area3D — 3D-объект, привязанный к площадной геометрии (полигону).
 * Позволяет размещать GLB-модели или примитивы внутри четырёхугольного полигона
 * с возможностью растягивания/вписывания, поворота и учётом рельефа.
 *
 * @example
 * const area = new Area3D({
 *     rings: [[[30.5, 50.4], [31.0, 50.5], [31.2, 50.7], [30.8, 50.8], [30.5, 50.4]]],
 *     modelUrl: 'building.glb',
 *     fit: 'stretch',      // растянуть модель под размеры полигона
 *     rotate: 0,           // передняя грань соответствует первой стороне
 *     altitudeMode: 'clampToGround',
 *     altitude: 5,
 *     title: 'Здание',
 *     onClick: (e, obj) => console.log('Клик по Area3D', obj)
 * });
 * area.addTo(map);
 */
import { THREE, GLTFLoader } from '../js_TP/tpb.js';
import { proj } from './Utils.js';
import { Layer } from './Layers.js';

const AREA3D_RENDER_ORDER = 1000;

export class Area3D {



    
    /** @private */ static _idCounter = 0;
    /** @private */ static _activeAreas = new Set();
    /** @private */ static _hoveredArea = null;
    /** @private */ static _pressedArea = null;
    /** @private */ static _pressStart = null;
    /** @private */ static _raycaster = new THREE.Raycaster();
    /** @private */ static _mapEventHandlers = new WeakMap();
    /** @private */ static _isMobile = (typeof window !== 'undefined') && (('ontouchstart' in window) || (navigator.maxTouchPoints > 0));


    /**
     * Создаёт площадной 3D-объект.
     *
     * @param {Object} options - Настройки.
     * @param {Array<Array<number>>} options.rings - Внешнее кольцо полигона (массив точек [lon, lat]).
     * @param {string} [options.modelUrl] - URL GLB-модели. Если не указан, используется примитив.
     * @param {string} [options.primitiveType='box'] - Тип примитива: 'box', 'sphere', 'cylinder', 'cone'.
     * @param {Array<number>|number} [options.size] - Размеры [ширина, высота, глубина] или одно число.
     *   Используется для примитивов и как целевой размер при fit='none'.
     * @param {string} [options.fit='stretch'] - Режим подгонки модели:
     *   'stretch' — растянуть по ширине и глубине полигона;
     *   'contain' — равномерно вписать в полигон;
     *   'none' — оставить исходный размер (или использовать size).
     * @param {number} [options.rotate=0] - Дополнительный поворот модели (0..3), умножается на 90°.
     * @param {number} [options.altitude=0] - Высота основания над поверхностью (clampToGround) или абсолютная (absolute).
     * @param {string} [options.altitudeMode='clampToGround'] - 'clampToGround' или 'absolute'.
     * @param {[number,number,number]} [options.anchor=[0.5,0,0.5]] - Точка привязки модели (нормализованные координаты bounding box).
     * @param {number} [options.minZoom=-Infinity] - Минимальный зум видимости.
     * @param {number} [options.maxZoom=Infinity] - Максимальный зум видимости.
     * @param {string} [options.title=''] - Постоянная подпись.
     * @param {Object} [options.titleStyle] - Стили подписи.
     * @param {number} [options.titleMinZoom=-Infinity] - Мин. зум для подписи.
     * @param {number} [options.titleMaxZoom=Infinity] - Макс. зум для подписи.
     * @param {string} [options.titlePlacement='top'] - Положение подписи: 'top', 'bottom', 'left', 'right'.
     * @param {string} [options.titleAlign] - Горизонтальное выравнивание подписи (по умолчанию зависит от placement).
     * @param {[number,number]} [options.titleOffset] - Смещение подписи в пикселях.
     * @param {string} [options.tooltip=''] - HTML-подсказка.
     * @param {Function} [options.onClick] - Обработчик клика.
     * @param {Function} [options.onHover] - Обработчик наведения.
     * @param {string|number} [options.color=0x3388ff] - Цвет примитива.
     * @param {boolean} [options.playAnimation=true] - Воспроизводить анимации GLB.
     * @param {boolean} [options.depthTest=true] - Тест глубины.
     * @param {boolean} [options.depthWrite=true] - Запись глубины.
     * @throws {Error} Если rings отсутствует или пуст.
     */
    constructor(options = {}) {

        console.log('Area3D constructor called with options:', options);
    console.log('options.rings:', options.rings);
    console.log('options.rings[0]:', options.rings?.[0]);
    console.log('options.rings[0]?.length:', options.rings?.[0]?.length);

        if (!options.rings || !options.rings.length || options.rings[0].length < 3) {
            throw new Error('Area3D: options.rings is required with at least one ring of 3+ points');
        }

        /** @private */ this._rings = options.rings;
        /** @private */ this._modelUrl = options.modelUrl || null;
        /** @private */ this._primitiveType = options.primitiveType || 'box';
        /** @private */ this._size = options.size || null;
        /** @private */ this._fit = options.fit || 'stretch';
        /** @private */ this._rotate = options.rotate || 0;
        /** @private */ this._altitude = options.altitude ?? 0;
        /** @private */ this._altitudeMode = options.altitudeMode || 'clampToGround';
        /** @private */ this._anchor = options.anchor || [0.5, 0, 0.5];
        /** @private */ this._minZoom = options.minZoom ?? -Infinity;
        /** @private */ this._maxZoom = options.maxZoom ?? Infinity;
        /** @private */ this._playAnimation = options.playAnimation !== undefined ? options.playAnimation : true;
        /** @private */ this._color = options.color || 0x3388ff;
        /** @private */ this._depthTest = options.depthTest ?? true;
        /** @private */ this._depthWrite = options.depthWrite ?? true;
    /** @private */ this._lastWorldGroupPos = new THREE.Vector3();

        // Подпись
        /** @private */ this._title = options.title || '';
        /** @private */ this._titleStyle = options.titleStyle || {};
        /** @private */ this._titleMinZoom = options.titleMinZoom ?? -Infinity;
        /** @private */ this._titleMaxZoom = options.titleMaxZoom ?? Infinity;
        /** @private */ this._titlePlacement = options.titlePlacement || 'top';
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

        /** @private */ this._tooltipText = options.tooltip || '';
        /** @private */ this._onClick = options.onClick || null;
        /** @private */ this._onHover = options.onHover || null;

        // Внутренние поля
        /** @private */ this._map = null;
        /** @private */ this._layer = null;
        /** @private */ this._group = new THREE.Group();
        /** @private */ this._modelContainer = new THREE.Group();
        /** @private */ this._group.add(this._modelContainer);
        /** @private */ this._object3D = null; // меш/группа модели
        /** @private */ this._mixer = null;
        /** @private */ this._mixerClock = null;
        /** @private */ this._isModelLoading = false;
        /** @private */ this._modelPromise = null;
        /** @private */ this._originalModelSize = null;
        /** @private */ this._originalModelScale = null;
        /** @private */ this._originalModelPosition = null;
        /** @private */ this._modelAnchorOffset = new THREE.Vector3();

        // Параметры полигона
        /** @private */ this._centroidWorld = new THREE.Vector3();
        /** @private */ this._polygonAngle = 0;
        /** @private */ this._polygonWidth = 0;
        /** @private */ this._polygonDepth = 0;
        /** @private */ this._worldCoords = []; // абсолютные координаты (без worldGroup)

        // Кэш высот
        /** @private */ this._cachedSurfaceHeight = 0;
        /** @private */ this._lastHeightUpdateTime = 0;
        /** @private */ this._heightUpdateInterval = 500;

        // Проверка rotate
        this._rotate = Math.min(3, Math.max(0, Math.floor(this._rotate)));

        // Регистрация для событий
        if (this._onClick || this._onHover || this._tooltipText) {
            Area3D._activeAreas.add(this);
        }
    }



    
    /* ================================================================
       Публичные методы
       ================================================================ */

    /**
     * Создаёт персональный слой и добавляет объект на карту.
     * @param {Object} map - Экземпляр карты.
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
     * Удаляет объект с карты, освобождает ресурсы.
     * @returns {void}
     */
    remove() {
        if (this._mixer) {
            this._mixer.stopAllAction();
            this._mixer = null;
            this._mixerClock = null;
        }
        if (this._group) {
            this._group.parent?.remove(this._group);
            if (this._object3D) {
                this._object3D.traverse(child => {
                    if (child.isMesh) {
                        child.geometry?.dispose();
                        if (Array.isArray(child.material)) child.material.forEach(m => m.dispose());
                        else child.material?.dispose();
                    }
                });
                this._object3D = null;
            }
        }
        Area3D._activeAreas.delete(this);
        if (Area3D._hoveredArea === this) Area3D._hoveredArea = null;
        if (Area3D._pressedArea === this) Area3D._pressedArea = null;

        if (this._textLabel && this._map?.textManager) {
            this._map.textManager.removeLabel(this._textLabel);
            this._textLabel = null;
        }
        if (this._layer) {
            this._layer._removeRef(this);
            this._layer = null;
        }
        this._map = null;
    }

    /* ================================================================
       Внутренние методы прикрепления и построения
       ================================================================ */

    /**
     * Вызывается слоем при добавлении.
     * @param {Object} map - Карта.
     * @param {Layer} layer - Слой-владелец.
     * @private
     */
    _attach(map, layer) {
        if (this._map === map && this._layer === layer) return;
        this.remove();
        this._map = map;
        this._layer = layer;

        // Вычисляем параметры полигона
        this._calculatePolygonParams();

        // Позиционируем группу в центроиде (мировые координаты, но без worldGroup.position)
        this._group.position.set(this._centroidWorld.x, 0, this._centroidWorld.z);
        map.worldGroup.add(this._group);

        // Загружаем модель или создаём примитив
        if (this._modelUrl) {
            this._isModelLoading = true;
            this._loadModel();
        } else {
            this._createPrimitive();
        }

        // Подпись
        if (this._title && map.textManager) {
            this._textLabel = map.textManager.addLabel(this);
        }

        // Регистрируем глобальные события, если ещё не зарегистрированы для этой карты
        this._registerGlobalEvents(map);
    }

    /**
     * Вычисляет центроид, угол поворота, ширину и глубину полигона.
     * @private
     */
    _calculatePolygonParams() {
        const outerRing = this._rings[0];
        this._worldCoords.length = 0;

        // Собираем абсолютные координаты (без worldGroup.position)
        let sumX = 0, sumZ = 0;
        let uniquePoints = [];
        for (let i = 0; i < outerRing.length; i++) {
            const [lon, lat] = outerRing[i];
            const [absX, absZ] = proj.fromLonLat([lon, lat]);
            // пропускаем дубликат последней точки
            if (i > 0 && absX === uniquePoints[0]?.[0] && absZ === uniquePoints[0]?.[1]) continue;
            uniquePoints.push([absX, absZ]);
            this._worldCoords.push([absX, absZ]);
            sumX += absX;
            sumZ += absZ;
        }
        const centroidX = sumX / this._worldCoords.length;
        const centroidZ = sumZ / this._worldCoords.length;
        this._centroidWorld.set(centroidX, 0, centroidZ);

        // Если точек меньше 3, выходим
        if (this._worldCoords.length < 3) return;

        // Находим самую длинную сторону для определения ориентации
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

        // Угол поворота такой, чтобы длинная сторона стала параллельна оси X
        this._polygonAngle = Math.atan2(dirZ, dirX);

        // Поворачиваем точки на -угол и вычисляем ограничивающий прямоугольник
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
     * Создаёт примитив на основе заданного типа и размеров.
     * @private
     */
    _createPrimitive() {
        let [w, h, d] = this._normalizeSize(this._size);
        // Если fit='stretch', размеры берём из полигона, а высота из size (если есть)
        if (this._fit === 'stretch') {
            w = this._polygonWidth;
            d = this._polygonDepth;
            if (this._size !== null) {
                const [, customH] = this._normalizeSize(this._size);
                h = customH;
            }
        } else if (this._fit === 'contain') {
            // вписываем с сохранением пропорций
            const scale = Math.min(this._polygonWidth / w, this._polygonDepth / d);
            w *= scale;
            d *= scale;
            h *= scale;
        } // else 'none' оставляем как есть

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
    }

    /**
     * Загружает GLB-модель асинхронно.
     * @private
     */
    async _loadModel() {
        if (this._modelPromise) return this._modelPromise;
        this._modelPromise = (async () => {
            try {
                const loader = new GLTFLoader();
                const gltf = await loader.loadAsync(this._modelUrl);
                const model = gltf.scene;

                if (this._playAnimation && gltf.animations?.length) {
                    this._mixer = new THREE.AnimationMixer(model);
                    for (const clip of gltf.animations) {
                        this._mixer.clipAction(clip).play();
                    }
                    this._mixerClock = new THREE.Clock();
                }

                // Сохраняем исходные параметры
                const box = new THREE.Box3().setFromObject(model);
                this._originalModelSize = box.getSize(new THREE.Vector3());
                this._originalModelScale = model.scale.clone();
                this._originalModelPosition = model.position.clone();

                // Применяем масштаб и поворот
                model.traverse(child => {
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
            } catch (err) {
                console.warn('Area3D: GLB loading failed:', err);
                this._isModelLoading = false;
            }
        })();
        return this._modelPromise;
    }

    /**
     * Применяет масштабирование, поворот и позиционирование модели внутри контейнера.
     * @private
     */
    _applyModelTransform() {
        if (!this._object3D) return;

        const model = this._object3D;
        // Сбрасываем трансформации, чтобы получить исходный bounding box
        model.position.set(0, 0, 0);
        model.scale.set(1, 1, 1);
        model.rotation.set(0, 0, 0);
        model.updateMatrixWorld(true);
        const box = new THREE.Box3().setFromObject(model);
        const size = box.getSize(new THREE.Vector3());
        const center = box.getCenter(new THREE.Vector3());

        // Вычисляем целевые размеры
        let targetW, targetH, targetD;
        if (this._fit === 'stretch') {
            targetW = this._polygonWidth;
            targetD = this._polygonDepth;
            targetH = size.y; // сохраняем исходную высоту, если size не задан
            if (this._size) {
                const [, customH] = this._normalizeSize(this._size);
                targetH = customH;
            }
        } else if (this._fit === 'contain') {
            const scale = Math.min(this._polygonWidth / size.x, this._polygonDepth / size.z);
            targetW = size.x * scale;
            targetH = size.y * scale;
            targetD = size.z * scale;
        } else { // 'none'
            if (this._size) {
                [targetW, targetH, targetD] = this._normalizeSize(this._size);
            } else {
                targetW = size.x;
                targetH = size.y;
                targetD = size.z;
            }
        }

        // Применяем масштаб
        const scaleX = targetW / size.x;
        const scaleY = targetH / size.y;
        const scaleZ = targetD / size.z;
        model.scale.set(scaleX, scaleY, scaleZ);

        // Поворот: угол полигона + дополнительный поворот
        const totalAngle = this._polygonAngle + this._rotate * Math.PI / 2;
        model.rotation.y = totalAngle;

        // Обновляем мировые матрицы для вычисления нового bounding box
        model.updateMatrixWorld(true);
        const transformedBox = new THREE.Box3().setFromObject(model);
        const transformedSize = transformedBox.getSize(new THREE.Vector3());
        const transformedMin = transformedBox.min;

        // Вычисляем точку привязки (якорь) в локальных координатах модели
        const anchorPoint = new THREE.Vector3(
            transformedMin.x + this._anchor[0] * transformedSize.x,
            transformedMin.y + this._anchor[1] * transformedSize.y,
            transformedMin.z + this._anchor[2] * transformedSize.z
        );

        // Смещаем модель так, чтобы anchorPoint оказался в (0,0,0) родительского контейнера
        model.position.sub(anchorPoint);
    }

    /**
     * Нормализует параметр size в массив [w, h, d].
     * @param {*} size - Число или массив.
     * @returns {Array<number>} [w, h, d]
     * @private
     */
    _normalizeSize(size) {
        if (!size) return [100, 100, 100]; // значения по умолчанию для примитивов
        if (typeof size === 'number') return [size, size, size];
        if (Array.isArray(size)) {
            if (size.length === 1) return [size[0], size[0], size[0]];
            if (size.length === 2) return [size[0], size[1], size[0]];
            if (size.length === 3) return [size[0], size[1], size[2]];
            throw new Error('Area3D: size array must have 1, 2, or 3 elements');
        }
        throw new Error('Area3D: invalid size type');
    }

    /* ================================================================
       Обработка событий (аналогично Marker3D)
       ================================================================ */

    /**
     * Регистрирует глобальные обработчики на canvas карты, если ещё не сделано.
     * @param {Object} map - Карта.
     * @private
     */
    _registerGlobalEvents(map) {
        if (Area3D._mapEventHandlers.has(map)) return;
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
        Area3D._mapEventHandlers.set(map, handlers);
    }

    _getNDC(e, map) {
        const rect = map.renderer.domElement.getBoundingClientRect();
        return new THREE.Vector2(
            ((e.clientX - rect.left) / rect.width) * 2 - 1,
            -((e.clientY - rect.top) / rect.height) * 2 + 1
        );
    }

    _getAreaUnderPointer(mouse, map) {
        const raycaster = Area3D._raycaster;
        raycaster.setFromCamera(mouse, map.camera);
        const candidates = [];
        for (const area of Area3D._activeAreas) {
            if (area._map !== map || !area._group.visible || !area._object3D) continue;
            const hits = raycaster.intersectObject(area._object3D, true);
            if (hits.length) candidates.push({ area, hit: hits[0] });
        }
        if (!candidates.length) return null;
        candidates.sort((a, b) => a.hit.distance - b.hit.distance);
        return candidates[0].area;
    }

    _onPointerMove(e, map) {
        if (Area3D._isMobile) return;
        const mouse = this._getNDC(e, map);
        const area = this._getAreaUnderPointer(mouse, map);
        if (area !== Area3D._hoveredArea) {
            if (Area3D._hoveredArea) {
                Area3D._hoveredArea._onHover?.(false) || (map.popupManager?.hide());
            }
            if (area) {
                area._onHover?.(true) || (area._tooltipText && map.popupManager?.show(area, area._tooltipText));
            }
            Area3D._hoveredArea = area;
        }
    }

    _onPointerDown(e, map) {
        const mouse = this._getNDC(e, map);
        const area = this._getAreaUnderPointer(mouse, map);
        Area3D._pressedArea = area;
        Area3D._pressStart = { x: e.clientX, y: e.clientY };
    }

    _onPointerUp(e, map) {
        const pressed = Area3D._pressedArea;
        const start = Area3D._pressStart;
        Area3D._pressedArea = null;
        Area3D._pressStart = null;
        if (!start) return;
        const dx = e.clientX - start.x;
        const dy = e.clientY - start.y;
        if (Math.sqrt(dx*dx + dy*dy) > 5) return;

        if (Area3D._isMobile) {
            // на мобильных обрабатываем как клик только если нет onClick
            if (pressed && !pressed._onClick) {
                if (pressed._onHover) pressed._onHover(true);
                else if (pressed._tooltipText && map.popupManager) map.popupManager.show(pressed, pressed._tooltipText);
                Area3D._hoveredArea = pressed;
            }
            return;
        }
        if (pressed && pressed._onClick) {
            pressed._onClick(e, pressed);
        }
    }

    _onPointerLeave(e, map) {
        if (Area3D._isMobile) return;
        if (Area3D._hoveredArea) {
            Area3D._hoveredArea._onHover?.(false) || map.popupManager?.hide();
            Area3D._hoveredArea = null;
        }
    }

    /* ================================================================
       Обновление на каждом кадре
       ================================================================ */

    /**
     * Вызывается слоем при обновлении кадра.
     * @param {Object} map - Карта.
     * @private
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

    // Проверка дистанции (можно оставить)
    if (map.maxObjectDistance !== Infinity && this._object3D) {
        const worldPos = this._group.position.clone().add(map.worldGroup.position);
        const dist = map.camera.position.distanceTo(worldPos);
        if (dist > map.maxObjectDistance) {
            this._group.visible = false;
            return;
        }
    }

    // Обновление позиции группы: XZ всегда из центроида, Y – из высоты
    const worldGroupPos = map.worldGroup.position;
    const baseX = this._centroidWorld.x;
    const baseZ = this._centroidWorld.z;

    let worldY = 0;
    if (this._altitudeMode === 'clampToGround') {
        const now = performance.now();
        if (now - this._lastHeightUpdateTime > this._heightUpdateInterval ||
            !this._lastWorldGroupPos.equals(worldGroupPos)) {
            const worldX = baseX + worldGroupPos.x;
            const worldZ = baseZ + worldGroupPos.z;
            map.ensureTileForPoint?.(worldX, worldZ);
            this._cachedSurfaceHeight = map.getSurfaceHeightAt(worldX, worldZ);
            this._lastHeightUpdateTime = now;
            this._lastWorldGroupPos.copy(worldGroupPos);
        }
        worldY = this._cachedSurfaceHeight + this._altitude;
    } else {
        worldY = this._altitude;
    }

    // Явно устанавливаем позицию группы
    this._group.position.set(baseX, worldY, baseZ);

    this._group.visible = true;

    // Обновление анимации модели
    if (this._mixer && this._mixerClock) {
        const delta = this._mixerClock.getDelta();
        this._mixer.update(delta);
    }

    // Обновление подписи
    if (this._textLabel) {
        this._updateScreenPosition();
    }
}

    /**
     * Пересчитывает экранную позицию для подписи.
     * @private
     */
    _updateScreenPosition() {
        if (!this._map || !this._object3D) {
            this._centroidScreenPos = null;
            return;
        }
        // Используем bounding box объекта для нахождения верхней/нижней точки
        const box = new THREE.Box3().setFromObject(this._object3D);
        this._object3D.updateWorldMatrix(true, false);
        box.applyMatrix4(this._object3D.matrixWorld);
        const canvas = this._map.renderer.domElement;
        const corners = [];
        const { min, max } = box;
        for (let i = 0; i < 8; i++) {
            const corner = new THREE.Vector3(
                (i & 1) ? max.x : min.x,
                (i & 2) ? max.y : min.y,
                (i & 4) ? max.z : min.z
            );
            corner.project(this._map.camera);
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
            case 'top': default: x = centerX; y = minY; break;
        }
        this._centroidScreenPos = { x, y };
    }

    /* ================================================================
       Интерфейс для TextManager
       ================================================================ */

    getText() { return this._title; }
    getTextStyle() {
        return Object.assign({
            fontFamily: 'sans-serif',
            color: '#333',
            fontSize: '12px',
            textAlign: this._titleAlign
        }, this._titleStyle);
    }
    getTextZoomBounds() { return { min: this._titleMinZoom, max: this._titleMaxZoom }; }
    getLabelType() { return 'area3d'; }
    isVisible() { return this._group?.visible ?? false; }
    getScreenPosition() { return this._centroidScreenPos; }
    getTitleAlign() { return this._titleAlign; }
    getTitleOffset() { return this._titleOffset; }
    getTitleVerticalAlign() {
        switch (this._titlePlacement) {
            case 'bottom': return 'top';
            case 'left': case 'right': return 'center';
            case 'top': default: return 'bottom';
        }
    }
    getAllowOverflow() { return false; }
    getPriority() { return 0; }
    getClusterable() { return false; }
}