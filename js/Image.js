/**
 * Модуль для отображения плоских изображений на карте.
 * Поддерживает позиционирование по четырём угловым точкам (узлам)
 * с билинейной деформацией, а также альтернативное позиционирование
 * через якорь (anchor), размер и углы поворота.
 * Источником может быть URL, HTMLImageElement или HTMLCanvasElement.
 * Поддерживаются прозрачность и режимы смешивания.
 *
 * @module Image
 */

import { THREE } from '../js_TP/tpb.js';
import { proj } from './Utils.js';
import { Layer } from './Layers.js';

/**
 * Рендерит изображения поверх тайлов с высоким приоритетом.
 * @private
 */
const IMAGE_RENDER_ORDER = 997;

/**
 * Класс, представляющий плоское изображение на карте.
 * 
 * @example
 * // Создание изображения по четырём узлам (углам)
 * const img = new Image({
 *     source: 'https://example.com/image.png',
 *     nodes: [
 *         { lon: 30.0, lat: 50.0, alt: 100 },
 *         { lon: 30.1, lat: 50.0, alt: 100 },
 *         { lon: 30.1, lat: 50.1, alt: 120 },
 *         { lon: 30.0, lat: 50.1, alt: 120 }
 *     ],
 *     opacity: 0.8,
 *     blending: 'multiply',
 *     minZoom: 5,
 *     maxZoom: 18
 * });
 * img.addTo(map);
 *
 * // Альтернативное позиционирование через якорь и поворот
 * const img2 = new Image({
 *     source: canvasElement,
 *     position: [30.5, 50.5, 200],
 *     size: [500, 300], // ширина, высота в метрах
 *     anchor: [0.5, 0.5], // центр изображения в точке position
 *     rotation: [0, 0, Math.PI / 4], // поворот на 45° вокруг оси Z
 *     opacity: 0.9
 * });
 * img2.addTo(map);
 */
export class Image {
    /**
     * Инициализирует новое изображение.
     *
     * @param {Object} options - Настройки изображения.
     * @param {string|HTMLImageElement|HTMLCanvasElement} options.source - Источник изображения: URL, готовый элемент или канвас.
     * @param {Array.<Object>} [options.nodes] - Массив из 3 или 4 узлов (углов изображения). Каждый узел: { lon, lat, alt }. Порядок: [нижний левый, нижний правый, верхний левый, верхний правый] (соответствует вершинам PlaneGeometry). Если задано 3 узла, четвёртый игнорируется (будет треугольник). Если 4 узла не лежат в одной плоскости, четвёртый проецируется на плоскость первых трёх.
     * @param {Array.<number>} [options.position] - Географическая позиция [lon, lat, alt] для альтернативного позиционирования (используется, если не заданы nodes).
     * @param {Array.<number>} [options.size] - Размеры изображения [width, height] в метрах (для альтернативного позиционирования).
     * @param {Array.<number>} [options.anchor=[0.5,0.5]] - Точка привязки внутри изображения в нормализованных координатах (0..1). Например, (0,0) – нижний левый угол, (1,1) – верхний правый.
     * @param {Array.<number>} [options.rotation=[0,0,0]] - Углы поворота [x, y, z] в радианах (для альтернативного позиционирования).
     * @param {number} [options.opacity=1] - Прозрачность изображения (0..1).
     * @param {string|THREE.Blending} [options.blending='normal'] - Режим смешивания: 'normal', 'additive', 'multiply', 'subtract' или константа THREE.Blending.
     * @param {number} [options.minZoom=-Infinity] - Минимальный зум видимости.
     * @param {number} [options.maxZoom=Infinity] - Максимальный зум видимости.
     * @param {string} [options.title=''] - Текст подписи (отображается через TextManager).
     * @param {Object} [options.titleStyle] - CSS-стили подписи.
     * @param {number} [options.titleMinZoom=-Infinity] - Мин. зум для подписи.
     * @param {number} [options.titleMaxZoom=Infinity] - Макс. зум для подписи.
     * @param {string} [options.titleAlign='center'] - Горизонтальное выравнивание подписи.
     * @param {Array.<number>} [options.titleOffset=[0,0]] - Смещение подписи в пикселях.
     * @param {boolean} [options.titleAllowOverflow=false] - Разрешить выход подписи за границы экрана.
     * @param {number} [options.titlePriority=0] - Приоритет подписи.
     * @param {string} [options.tooltip=''] - Текст всплывающей подсказки (HTML).
     * @param {Function} [options.onClick] - Обработчик клика (получает событие и экземпляр изображения).
     * @param {Function} [options.onHover] - Обработчик наведения (получает true/false).
     * @throws {Error} Если не задан source или nodes/position.
     */
    constructor(options = {}) {
        if (!options.source) {
            throw new Error('Image: options.source is required');
        }

        /** @private */ this._source = options.source;
        /** @private */ this._nodes = options.nodes || null;
        /** @private */ this._position = options.position || null;
        /** @private */ this._size = options.size || [100, 100];
        /** @private */ this._anchor = options.anchor || [0.5, 0.5];
        /** @private */ this._rotation = options.rotation || [0, 0, 0];
        /** @private */ this._opacity = options.opacity ?? 1;
        /** @private */ this._blending = options.blending || 'normal';
        /** @private */ this._minZoom = options.minZoom ?? -Infinity;
        /** @private */ this._maxZoom = options.maxZoom ?? Infinity;

        // Подпись
        /** @private */ this._title = options.title || '';
        /** @private */ this._titleStyle = options.titleStyle || {};
        /** @private */ this._titleMinZoom = options.titleMinZoom ?? -Infinity;
        /** @private */ this._titleMaxZoom = options.titleMaxZoom ?? Infinity;
        /** @private */ this._titleAlign = options.titleAlign || 'center';
        /** @private */ this._titleOffset = options.titleOffset || [0, 0];
        /** @private */ this._titleAllowOverflow = options.titleAllowOverflow || false;
        /** @private */ this._titlePriority = options.titlePriority ?? 0;

        // События
        /** @private */ this._onClick = options.onClick || null;
        /** @private */ this._onHover = options.onHover || null;
        /** @private */ this._isHovered = false;

        // Тултип
        /** @private */ this._tooltipText = options.tooltip || '';

        // Внутреннее состояние
        /** @private */ this._map = null;
        /** @private */ this._layer = null;
        /** @private */ this._group = new THREE.Group();
        /** @private */ this._mesh = null;
        /** @private */ this._geometry = null;
        /** @private */ this._material = null;
        /** @private */ this._texture = null;
        /** @private */ this._textLabel = null;
        /** @private */ this._isVisible = false;
        /** @private */ this._worldPositions = []; // мировые координаты узлов (без worldGroup)
        /** @private */ this._centroidWorld = new THREE.Vector3(); // центр изображения в координатах worldGroup
        /** @private */ this._lastWorldGroupPos = new THREE.Vector3();
        /** @private */ this._lastDiscreteZoom = -1;
        /** @private */ this._boundingSphereRadius = 0;
        /** @private */ this._boundingSphereWorld = new THREE.Sphere();
        /** @private */ this._tempVec3 = new THREE.Vector3();
        /** @private */ this._dirtyGeometry = true; // флаг, что геометрию нужно перестроить

        // Регистрация в реестре интерактивных объектов, если есть обработчики
        if (this._onClick || this._onHover || this._tooltipText) {
            Image._registerInteractive(this);
        }
    }

    /* ================================================================
       Статический реестр интерактивных изображений и делегирование событий
       ================================================================ */

    /** @private */ static _interactiveImages = new Set();
    /** @private */ static _eventListenersAttached = false;
    /** @private */ static _delegatedHandlers = null;

    /**
     * Регистрирует изображение для обработки событий мыши.
     * @param {Image} image - Экземпляр изображения.
     * @private
     */
    static _registerInteractive(image) {
        Image._interactiveImages.add(image);
        if (!Image._eventListenersAttached) {
            Image._attachGlobalListeners();
        }
    }

    /**
     * Удаляет изображение из реестра интерактивных.
     * @param {Image} image - Экземпляр изображения.
     * @private
     */
    static _unregisterInteractive(image) {
        Image._interactiveImages.delete(image);
        if (Image._interactiveImages.size === 0 && Image._eventListenersAttached) {
            Image._detachGlobalListeners();
        }
    }

    /**
     * Добавляет глобальные обработчики событий на canvas.
     * @private
     */
    static _attachGlobalListeners() {
        const canvas = Image._getCanvas();
        if (!canvas) return;

        Image._delegatedHandlers = {
            mousemove: (e) => Image._handleGlobalMouseMove(e),
            click: (e) => Image._handleGlobalClick(e)
        };

        canvas.addEventListener('mousemove', Image._delegatedHandlers.mousemove, true);
        canvas.addEventListener('click', Image._delegatedHandlers.click, true);
        Image._eventListenersAttached = true;
    }

    /**
     * Удаляет глобальные обработчики.
     * @private
     */
    static _detachGlobalListeners() {
        const canvas = Image._getCanvas();
        if (!canvas || !Image._delegatedHandlers) return;

        canvas.removeEventListener('mousemove', Image._delegatedHandlers.mousemove, true);
        canvas.removeEventListener('click', Image._delegatedHandlers.click, true);
        Image._delegatedHandlers = null;
        Image._eventListenersAttached = false;
    }

    /**
     * Возвращает canvas, к которому привязаны обработчики.
     * @returns {HTMLCanvasElement|null}
     * @private
     */
    static _getCanvas() {
        for (const img of Image._interactiveImages) {
            if (img._map && img._map.renderer && img._map.renderer.domElement) {
                return img._map.renderer.domElement;
            }
        }
        return null;
    }

    /**
     * Глобальный обработчик mousemove.
     * @param {MouseEvent} event - Событие мыши.
     * @private
     */
    static _handleGlobalMouseMove(event) {
        for (const img of Image._interactiveImages) {
            img._handleMouseMove(event);
        }
    }

    /**
     * Глобальный обработчик click.
     * @param {MouseEvent} event - Событие мыши.
     * @private
     */
    static _handleGlobalClick(event) {
        for (const img of Image._interactiveImages) {
            img._handleClick(event);
        }
    }

    /* ================================================================
       Публичные методы
       ================================================================ */

    /**
     * Добавляет изображение на карту в персональный слой.
     * @param {Object} map - Экземпляр карты.
     * @returns {Image} Текущий экземпляр.
     */
    addTo(map) {
        if (this._map) this.remove();
        const personalLayer = new Layer();
        personalLayer.addTo(map);
        personalLayer.add(this);
        return this;
    }

    /**
     * Присоединяет изображение к карте и слою, строит геометрию.
     * @param {Object} map - Экземпляр карты.
     * @param {Layer} layer - Слой-владелец.
     * @private
     */
    _attach(map, layer) {
        if (this._map === map && this._layer === layer) return;
        this.remove();
        this._map = map;
        this._layer = layer;

        this._loadTexture();
        this._buildGeometry(map);
        map.worldGroup.add(this._group);

        if (this._title && map.textManager) {
            this._textLabel = map.textManager.addLabel(this);
        }

        if (this._onClick || this._onHover || this._tooltipText) {
            if (!Image._eventListenersAttached) {
                Image._attachGlobalListeners();
            }
        }

        this._lastWorldGroupPos.copy(map.worldGroup.position);
        this._lastDiscreteZoom = map.currentDiscreteZoom;
    }

    /**
     * Удаляет изображение с карты и освобождает ресурсы.
     * @returns {void}
     */
    remove() {
        if (this._map) {
            Image._unregisterInteractive(this);
        }

        if (this._group.parent) {
            this._group.parent.remove(this._group);
        }

        this._disposeGeometry();
        this._disposeTexture();

        if (this._textLabel && this._map?.textManager) {
            this._map.textManager.removeLabel(this._textLabel);
            this._textLabel = null;
        }

        this._layer?._removeRef(this);
        this._layer = null;
        this._map = null;
        this._isVisible = false;
        this._worldPositions.length = 0;
    }

    /**
     * Обновляет источник изображения (URL, HTMLImageElement или Canvas).
     * @param {string|HTMLImageElement|HTMLCanvasElement} source - Новый источник.
     * @returns {Image} Текущий экземпляр.
     */
    setSource(source) {
        if (!source) {
            console.warn('Image.setSource: source is empty');
            return this;
        }
        this._source = source;
        if (this._map) {
            this._disposeTexture();
            this._loadTexture();
            if (this._material && this._texture) {
                this._material.map = this._texture;
                this._material.needsUpdate = true;
            }
        }
        return this;
    }

    /**
     * Устанавливает прозрачность.
     * @param {number} opacity - Прозрачность (0..1).
     * @returns {Image} Текущий экземпляр.
     */
    setOpacity(opacity) {
        this._opacity = Math.max(0, Math.min(1, opacity));
        if (this._material) {
            this._material.opacity = this._opacity;
            this._material.transparent = this._opacity < 1;
        }
        return this;
    }

    /**
     * Устанавливает режим смешивания.
     * @param {string|THREE.Blending} blending - Строка ('normal', 'additive', 'multiply', 'subtract') или константа THREE.Blending.
     * @returns {Image} Текущий экземпляр.
     */
    setBlending(blending) {
        this._blending = blending;
        if (this._material) {
            this._material.blending = this._normalizeBlending(blending);
        }
        return this;
    }

    /**
     * Устанавливает новые узлы (углы) изображения.
     * @param {Array.<Object>} nodes - Массив из 3 или 4 узлов.
     * @returns {Image} Текущий экземпляр.
     */
    setNodes(nodes) {
        if (!Array.isArray(nodes) || (nodes.length !== 3 && nodes.length !== 4)) {
            throw new Error('Image.setNodes: nodes must be an array of 3 or 4 objects');
        }
        this._nodes = nodes;
        this._dirtyGeometry = true;
        if (this._map) {
            this._buildGeometry(this._map);
        }
        return this;
    }

    /**
     * Устанавливает альтернативное позиционирование (позиция, размер, якорь, поворот).
     * @param {Object} params - Параметры: { position, size, anchor, rotation }.
     * @returns {Image} Текущий экземпляр.
     */
    setPositionRotation(params = {}) {
        if (params.position) this._position = params.position;
        if (params.size) this._size = params.size;
        if (params.anchor) this._anchor = params.anchor;
        if (params.rotation) this._rotation = params.rotation;
        this._dirtyGeometry = true;
        if (this._map) {
            this._buildGeometry(this._map);
        }
        return this;
    }

    /* ================================================================
       Внутренние методы
       ================================================================ */

    /**
     * Загружает текстуру из источника.
     * @private
     */
    _loadTexture() {
        if (!this._source) return;

        if (this._source instanceof HTMLCanvasElement) {
            this._texture = new THREE.CanvasTexture(this._source);
        } else if (this._source instanceof HTMLImageElement) {
            this._texture = new THREE.Texture(this._source);
            this._texture.needsUpdate = true;
        } else if (typeof this._source === 'string') {
            const loader = new THREE.TextureLoader();
            loader.setCrossOrigin('anonymous');
            this._texture = loader.load(
                this._source,
                () => { if (this._material) this._material.needsUpdate = true; },
                undefined,
                (err) => console.warn('Image: failed to load texture', err)
            );
        } else {
            console.warn('Image: unsupported source type', this._source);
        }
    }

    /**
     * Освобождает текущую текстуру.
     * @private
     */
    _disposeTexture() {
        if (this._texture) {
            this._texture.dispose();
            this._texture = null;
        }
    }

    /**
     * Освобождает геометрию и материал.
     * @private
     */
    _disposeGeometry() {
        if (this._geometry) {
            this._geometry.dispose();
            this._geometry = null;
        }
        if (this._material) {
            this._material.dispose();
            this._material = null;
        }
        if (this._mesh) {
            this._mesh = null;
        }
    }

    /**
     * Преобразует строковый режим смешивания в константу THREE.
     * @param {string|THREE.Blending} blending - Входной режим.
     * @returns {THREE.Blending} Константа смешивания.
     * @private
     */
    _normalizeBlending(blending) {
        if (typeof blending === 'number') return blending;
        switch (blending.toLowerCase()) {
            case 'additive':
                return THREE.AdditiveBlending;
            case 'multiply':
                return THREE.MultiplyBlending;
            case 'subtract':
                return THREE.SubtractiveBlending;
            case 'normal':
            default:
                return THREE.NormalBlending;
        }
    }

    /**
     * Вычисляет мировые координаты (без worldGroup) для заданных узлов.
     * @returns {Array.<THREE.Vector3>} Массив векторов.
     * @private
     */
    _computeWorldPositionsFromNodes() {
        if (!this._nodes || this._nodes.length < 3) return [];

        const positions = this._nodes.map(node => {
            const [x, z] = proj.fromLonLat([node.lon, node.lat]);
            const y = node.alt || 0;
            return new THREE.Vector3(x, y, z);
        });

        // Если задано 4 узла и они не компланарны, проецируем 4-й на плоскость первых трёх
        if (positions.length === 4) {
            const [p0, p1, p2, p3] = positions;
            const normal = new THREE.Vector3().subVectors(p1, p0).cross(new THREE.Vector3().subVectors(p2, p0));
            const denom = normal.lengthSq();
            if (denom > 1e-10) {
                normal.normalize();
                const dist = new THREE.Vector3().subVectors(p3, p0).dot(normal);
                if (Math.abs(dist) > 1e-6) {
                    // Четвёртая точка не в плоскости, проецируем
                    const projected = p3.clone().addScaledVector(normal, -dist);
                    positions[3] = projected;
                }
            }
        }

        return positions;
    }

    /**
     * Вычисляет мировые координаты узлов из альтернативного позиционирования (anchor, rotation, size).
     * @returns {Array.<THREE.Vector3>} Массив из четырёх векторов в порядке [нижний левый, нижний правый, верхний левый, верхний правый].
     * @private
     */
_computeWorldPositionsFromAnchor() {
    if (!this._position) return [];

    const [lon, lat, alt] = this._position;
    const [width, height] = this._size;
    const [ax, ay] = this._anchor;
    const [rx, ry, rz] = this._rotation;

    const center = new THREE.Vector3(...proj.fromLonLat([lon, lat]), alt || 0);

    const halfW = width / 2;
    const halfH = height / 2;

    // Локальные координаты углов в плоскости XZ (Y=0), центр в (0,0,0)
    const cornersLocal = [
        new THREE.Vector3(-halfW, 0, -halfH),
        new THREE.Vector3( halfW, 0, -halfH),
        new THREE.Vector3(-halfW, 0,  halfH),
        new THREE.Vector3( halfW, 0,  halfH)
    ];

    // Смещение из-за якоря: точка якоря должна оказаться в центре (0,0,0) локально
    const anchorOffset = new THREE.Vector3(
        (0.5 - ax) * width,
        0,
        (0.5 - ay) * height
    );
    cornersLocal.forEach(c => c.add(anchorOffset));

    // Применяем вращение
    const euler = new THREE.Euler(rx, ry, rz, 'XYZ');
    const quaternion = new THREE.Quaternion().setFromEuler(euler);
    const rotatedCorners = cornersLocal.map(local => local.clone().applyQuaternion(quaternion));

    // Добавляем к центру в мировых координатах (без перестановки осей)
    const worldCorners = rotatedCorners.map(local => {
        return new THREE.Vector3(
            center.x + local.x,
            center.y + local.y,
            center.z + local.z
        );
    });

    return worldCorners;
}


    /**
     * Строит геометрию плоскости с вершинами в мировых координатах (локально относительно центроида).
     * @param {Object} map - Экземпляр карты.
     * @private
     */
    _buildGeometry(map) {
        // Очищаем старую геометрию и материал, но не трогаем текстуру (она загружается отдельно)
        this._disposeGeometry();

        // Получаем мировые позиции узлов (без учёта worldGroup)
        let worldPositions;
        if (this._nodes) {
            worldPositions = this._computeWorldPositionsFromNodes();
        } else if (this._position) {
            worldPositions = this._computeWorldPositionsFromAnchor();
        } else {
            console.warn('Image: neither nodes nor position provided');
            return;
        }

        if (worldPositions.length < 3) {
            console.warn('Image: not enough positions to build geometry');
            return;
        }

        this._worldPositions = worldPositions;

        // Вычисляем центроид (среднее по всем точкам)
        const centroid = new THREE.Vector3();
        worldPositions.forEach(p => centroid.add(p));
        centroid.divideScalar(worldPositions.length);
        this._centroidWorld.copy(centroid);

        // Создаём PlaneGeometry с 4 вершинами (для треугольника можно использовать также, но 4-я вершина будет продублирована)
        // Если узлов 3, создадим треугольную геометрию: используем три первые вершины, четвёртую ставим в ту же точку, что и третью? 
        // Но текстура будет искажена. Лучше создать геометрию с 3 вершинами и индексами.
        let geometry;
        if (worldPositions.length === 3) {
            // Треугольник
            geometry = new THREE.BufferGeometry();
            const vertices = new Float32Array(9);
            worldPositions.forEach((p, i) => {
                vertices[i*3] = p.x - centroid.x;
                vertices[i*3+1] = p.y - centroid.y;
                vertices[i*3+2] = p.z - centroid.z;
            });
            geometry.setAttribute('position', new THREE.BufferAttribute(vertices, 3));
            geometry.setIndex([0, 1, 2]);
            // UV для треугольника: сопоставим углам изображения (0,0), (1,0), (0,1) или (0,1), (1,1), (0,0)? 
            // Для простоты установим UV: (0,0), (1,0), (0,1) в порядке вершин.
            const uvs = new Float32Array([0,0, 1,0, 0,1]);
            geometry.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
        } else {
            // Четырёхугольник (PlaneGeometry с переопределёнными вершинами)
            geometry = new THREE.PlaneGeometry(1, 1, 1, 1);
            const pos = geometry.attributes.position;
            // Переопределяем вершины в порядке: 0:(0,0) – нижний левый, 1:(1,0) – нижний правый, 2:(0,1) – верхний левый, 3:(1,1) – верхний правый
            // Заменяем координаты на локальные (относительно центроида)
            for (let i = 0; i < 4; i++) {
                pos.setXYZ(i, worldPositions[i].x - centroid.x, worldPositions[i].y - centroid.y, worldPositions[i].z - centroid.z);
            }
            pos.needsUpdate = true;
            geometry.computeVertexNormals();
        }

        // Материал
        const material = new THREE.MeshBasicMaterial({
            map: this._texture || null,
            side: THREE.DoubleSide,
            transparent: this._opacity < 1,
            opacity: this._opacity,
            blending: this._normalizeBlending(this._blending),
            depthTest: true,
            depthWrite: false // чтобы не мешать другим прозрачным объектам
        });

        const mesh = new THREE.Mesh(geometry, material);
        mesh.renderOrder = IMAGE_RENDER_ORDER;

        // Добавляем в группу
        this._group.clear();
        this._group.add(mesh);
        this._group.position.copy(centroid); // позиция группы в координатах worldGroup

        this._geometry = geometry;
        this._material = material;
        this._mesh = mesh;

        // Вычисляем ограничивающую сферу
        let maxRadiusSq = 0;
        const localCenter = new THREE.Vector3(0, 0, 0); // группа в центроиде
        worldPositions.forEach(p => {
            const dx = p.x - centroid.x;
            const dy = p.y - centroid.y;
            const dz = p.z - centroid.z;
            const rSq = dx*dx + dy*dy + dz*dz;
            if (rSq > maxRadiusSq) maxRadiusSq = rSq;
        });
        this._boundingSphereRadius = Math.sqrt(maxRadiusSq);

        this._dirtyGeometry = false;
    }

    /**
     * Пересобирает геометрию, если изменились узлы или позиционирование.
     * @param {Object} map - Экземпляр карты.
     * @private
     */
    _rebuildGeometryIfNeeded(map) {
        if (this._dirtyGeometry) {
            this._buildGeometry(map);
        }
    }

    /**
     * Обрабатывает mousemove для делегированного события.
     * @param {MouseEvent} event - Событие мыши.
     * @private
     */
    _handleMouseMove(event) {
        if (!this._map || !this._isVisible) return;
        const hit = this._raycastImage(event);
        if (hit) {
            if (!this._isHovered) {
                this._isHovered = true;
                if (this._onHover) {
                    this._onHover(true);
                } else if (this._tooltipText && this._map.popupManager) {
                    this._map.popupManager.show(this, this._tooltipText);
                }
            }
        } else {
            if (this._isHovered) {
                this._isHovered = false;
                if (this._onHover) {
                    this._onHover(false);
                } else if (this._tooltipText && this._map.popupManager) {
                    this._map.popupManager.hide();
                }
            }
        }
    }

    /**
     * Обрабатывает click для делегированного события.
     * @param {MouseEvent} event - Событие мыши.
     * @private
     */
    _handleClick(event) {
        if (!this._map || !this._isVisible) return;
        if (this._raycastImage(event)) {
            if (this._onClick) {
                this._onClick(event, this);
            } else if (this._tooltipText && this._map.popupManager) {
                this._map.popupManager.show(this, this._tooltipText);
            }
        }
    }

    /**
     * Проверяет, находится ли точка экрана над изображением.
     * @param {MouseEvent} event - Событие мыши.
     * @returns {boolean} true, если луч пересекает изображение.
     * @private
     */
    _raycastImage(event) {
        if (!this._mesh || !this._mesh.visible) return false;

        const rect = this._map.renderer.domElement.getBoundingClientRect();
        const mouse = new THREE.Vector2(
            ((event.clientX - rect.left) / rect.width) * 2 - 1,
            -((event.clientY - rect.top) / rect.height) * 2 + 1
        );

        const raycaster = new THREE.Raycaster();
        raycaster.setFromCamera(mouse, this._map.camera);

        const intersects = raycaster.intersectObject(this._mesh, false);
        return intersects.length > 0;
    }

    /**
     * Обновляет состояние изображения: видимость, геометрию, подпись.
     * @param {Object} map - Экземпляр карты.
     * @private
     */
    _update(map) {
        if (!this._map || !this._group) return;
        const zoom = this._map.continuousZoom;

        if (this._layer && !this._layer.visible) {
            this._group.visible = false;
            this._isVisible = false;
            return;
        }
        if (zoom < this._minZoom || zoom > this._maxZoom) {
            this._group.visible = false;
            this._isVisible = false;
            return;
        }

        // Пересобираем геометрию, если нужно
        this._rebuildGeometryIfNeeded(map);

        // Проверка расстояния через ограничивающую сферу
        if (this._boundingSphereRadius > 0) {
            const maxDist = map.maxObjectDistance;
            if (maxDist !== Infinity) {
                const worldCenter = this._tempVec3.copy(this._group.position).add(map.worldGroup.position);
                const distToCenter = map.camera.position.distanceTo(worldCenter);
                if (distToCenter - this._boundingSphereRadius > maxDist) {
                    this._group.visible = false;
                    this._isVisible = false;
                    return;
                }
            }
        }

        this._group.visible = true;
        this._isVisible = true;

        // Обновляем подпись
        if (this._textLabel) {
            // Обновление подписи происходит в TextManager через getScreenPosition
        }
    }

    // ---------- Интерфейс для TextManager ----------

    /**
     * Возвращает текст подписи.
     * @returns {string}
     */
    getText() { return this._title; }

    /**
     * Возвращает стили подписи.
     * @returns {Object}
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
     * @returns {Object}
     */
    getTextZoomBounds() { return { min: this._titleMinZoom, max: this._titleMaxZoom }; }

    /**
     * Возвращает тип подписи.
     * @returns {string}
     */
    getLabelType() { return 'image'; }

    /**
     * Проверяет видимость изображения.
     * @returns {boolean}
     */
    isVisible() { return this._isVisible; }

    /**
     * Возвращает экранную позицию для подписи (центр изображения).
     * @returns {Object|null}
     */
    getScreenPosition() {
        if (!this._isVisible || !this._group) return null;
        const worldPos = this._tempVec3.copy(this._group.position).add(this._map.worldGroup.position);
        // Добавляем небольшую высоту, чтобы подпись была над изображением
        worldPos.y += this._boundingSphereRadius * 0.1;
        const screenPos = worldPos.clone().project(this._map.camera);
        if (screenPos.z > 1 || Math.abs(screenPos.x) > 1 || Math.abs(screenPos.y) > 1) return null;
        const canvas = this._map.renderer.domElement;
        return {
            x: (screenPos.x * 0.5 + 0.5) * canvas.clientWidth,
            y: (-screenPos.y * 0.5 + 0.5) * canvas.clientHeight
        };
    }

    /**
     * Возвращает горизонтальное выравнивание подписи.
     * @returns {string}
     */
    getTitleAlign() { return this._titleAlign; }

    /**
     * Возвращает смещение подписи.
     * @returns {Array.<number>}
     */
    getTitleOffset() { return this._titleOffset; }

    /**
     * Возвращает вертикальное выравнивание подписи.
     * @returns {string}
     */
    getTitleVerticalAlign() { return 'bottom'; }

    /**
     * Проверяет разрешение выхода подписи за границы.
     * @returns {boolean}
     */
    getAllowOverflow() { return this._titleAllowOverflow; }

    /**
     * Возвращает приоритет подписи.
     * @returns {number}
     */
    getPriority() { return this._titlePriority; }
}