/**
 * Модуль для рисования полигонов (многоугольников) на карте.
 * Предоставляет класс Polygon, использующий триангуляцию Earcut
 * для заливки и "толстые" линии для обводки, с поддержкой высот,
 * экструзии, видимости по зуму и подписей через TextManager.
 * Добавлена поддержка событий onHover и onClick через raycasting,
 * а также возможность отображения HTML-тултипа через PopupManager.
 */

import { proj } from './Utils.js';
import {
  THREE,
  Line2,
  LineMaterial,
  LineGeometry,
} from '../js_TP/tpb.js';
import { Layer } from './Layers.js';
import earcut from '../js_TP/earcut.js';

/**
 * Вычисляет минимальное расстояние от точки до отрезка.
 *
 * @param {THREE.Vector3} point - Точка.
 * @param {THREE.Vector3} a - Начало отрезка.
 * @param {THREE.Vector3} b - Конец отрезка.
 * @returns {number} Расстояние.
 * @private
 */
function pointToSegmentDistance(point, a, b) {
    const ab = new THREE.Vector3().subVectors(b, a);
    const ap = new THREE.Vector3().subVectors(point, a);
    const abLenSq = ab.lengthSq();
    if (abLenSq === 0) return point.distanceTo(a);
    let t = ap.dot(ab) / abLenSq;
    t = Math.max(0, Math.min(1, t));
    const closest = new THREE.Vector3().copy(a).addScaledVector(ab, t);
    return point.distanceTo(closest);
}

/**
 * Класс, представляющий полигон на карте.
 * Поддерживает заливку, обводку, настройку высот, экструзию (объём),
 * ограничения по зуму, текстовую подпись, а также обработчики событий
 * наведения (onHover) и клика (onClick).
 * Всплывающие подсказки обрабатываются централизованно через PopupManager
 * (доступен как `map.popupManager`).
 *
 * @example
 * // Обычный плоский полигон
 * const flatPolygon = new Polygon({
 *     rings: [[[30.5, 50.4], [31.0, 50.5], [30.8, 50.7]]],
 *     fillColor: '#ff0000',
 *     fillOpacity: 0.3,
 *     strokeColor: '#000000',
 *     strokeWidth: 2,
 *     altitudeMode: 'clampToGround',
 *     altitudeOffset: 10,
 *     depthTest: false,
 *     minZoom: 5,
 *     maxZoom: 18,
 *     title: 'Плоский полигон',
 *     tooltip: '<b>Полигон</b>',
 *     onClick: (event, polygon) => console.log('Клик по полигону'),
 *     onHover: (hovered) => console.log('Наведение:', hovered)
 * });
 * flatPolygon.addTo(map);
 *
 * // Экструдированный (объёмный) полигон
 * const extrudedPolygon = new Polygon({
 *     rings: [[[30.5, 50.4], [31.0, 50.5], [30.8, 50.7]]],
 *     extruded: true,
 *     height: 500,      // толщина экструзии в метрах
 *     minHeight: 200,   // высота нижней грани над поверхностью в метрах
 *     fillColor: '#ff8800',
 *     fillOpacity: 0.8,
 *     strokeColor: '#000000',
 *     strokeWidth: 3,
 *     altitudeMode: 'clampToGround',
 *     altitudeOffset: 10,
 *     depthTest: true,
 *     title: 'Объёмный полигон'
 * });
 * extrudedPolygon.addTo(map);
 */
export class Polygon {
    /**
     * Инициализирует новый экземпляр полигона с заданными настройками.
     *
     * @param {Object} options - Настройки полигона.
     * @param {Array.<Array.<Array.<number>>>} options.rings - Массив колец.
     * @param {string} [options.fillColor='#3388ff'] - Цвет заливки (CSS).
     * @param {number} [options.fillOpacity=0.5] - Прозрачность заливки (0..1).
     * @param {string} [options.strokeColor='#000000'] - Цвет обводки.
     * @param {number} [options.strokeWidth=2] - Толщина обводки в пикселях.
     * @param {number} [options.strokeOpacity=1] - Прозрачность обводки.
     * @param {string} [options.altitudeMode='clampToGround'] - Режим высоты.
     * @param {number} [options.altitudeOffset=10] - Добавочная высота.
     * @param {boolean} [options.extruded=false] - Включить экструзию.
     * @param {number} [options.height=0] - Толщина экструзии в метрах.
     * @param {number} [options.minHeight=0] - Высота нижней грани.
     * @param {boolean} [options.depthTest=false] - Тест глубины.
     * @param {boolean} [options.depthWrite=false] - Запись глубины.
     * @param {number} [options.minZoom=-Infinity] - Минимальный зум.
     * @param {number} [options.maxZoom=Infinity] - Максимальный зум.
     * @param {string} [options.title=''] - Текст подписи.
     * @param {Array.<number>} [options.titleOffset=[0,0]] - Смещение подписи.
     * @param {string} [options.titleAlign='center'] - Выравнивание подписи.
     * @param {Object} [options.titleStyle={}] - CSS-стили подписи.
     * @param {number} [options.titleMinZoom=-Infinity] - Мин. зум для подписи.
     * @param {number} [options.titleMaxZoom=Infinity] - Макс. зум для подписи.
     * @param {boolean} [options.titleAllowOverflow=false] - Разрешить выход подписи.
     * @param {number} [options.titlePriority=0] - Приоритет подписи.
     * @param {function} [options.onClick] - Колбэк клика.
     * @param {function} [options.onHover] - Колбэк наведения.
     * @param {string} [options.tooltip=''] - HTML-тултип.
     * @throws {Error} Если не передан массив колец или он пуст.
     * @throws {Error} Если extruded=true и height не положительное число.
     */
    constructor(options = {}) {
        if (!options.rings || !options.rings.length || !options.rings[0].length) {
            throw new Error('Polygon: options.rings required with at least one ring');
        }
        /** @private */ this._rings = options.rings;
        /** @private */ this._fillColor = options.fillColor || '#3388ff';
        /** @private */ this._fillOpacity = options.fillOpacity ?? 0.5;
        /** @private */ this._strokeColor = options.strokeColor || '#000000';
        /** @private */ this._strokeWidth = options.strokeWidth ?? 2;
        /** @private */ this._strokeOpacity = options.strokeOpacity ?? 1;
        /** @private */ this._altitudeMode = options.altitudeMode || 'clampToGround';
        /** @private */ this._altitudeOffset = options.altitudeOffset ?? 10;
        /** @private */ this._depthTest = options.depthTest ?? false;
        /** @private */ this._depthWrite = options.depthWrite ?? false;
        /** @private */ this._minZoom = options.minZoom ?? -Infinity;
        /** @private */ this._maxZoom = options.maxZoom ?? Infinity;

        // Экструзия
        /** @private */ this._extruded = options.extruded ?? false;
        /** @private */ this._height = options.height ?? 0;
        /** @private */ this._minHeight = options.minHeight ?? 0;
        if (this._extruded && (typeof this._height !== 'number' || this._height <= 0)) {
            throw new Error('Polygon: options.height must be a positive number when extruded is true');
        }

        // Подпись
        /** @private */ this._title = options.title || '';
        /** @private */ this._titleOffset = options.titleOffset || [0, 0];
        /** @private */ this._titleAlign = options.titleAlign || 'center';
        /** @private */ this._titleStyle = options.titleStyle || {};
        /** @private */ this._titleMinZoom = options.titleMinZoom ?? -Infinity;
        /** @private */ this._titleMaxZoom = options.titleMaxZoom ?? Infinity;

        // События мыши
        /** @private */ this._onClick = options.onClick || null;
        /** @private */ this._onHover = options.onHover || null;
        /** @private */ this._isHovered = false;
        /** @private */ this._boundHandlers = null;

        // Тултип
        /** @private */ this._tooltipText = options.tooltip || '';

        // Внутренние структуры
        /** @private */ this._map = null;
        /** @private */ this._layer = null;
        /** @private */ this._group = new THREE.Group();

        // Геометрии
        /** @private */ this._fillMesh = null;
        /** @private */ this._fillGeometry = null;
        /** @private */ this._fillMaterial = null;
        /** @private */ this._bottomMesh = null;
        /** @private */ this._bottomGeometry = null;
        /** @private */ this._bottomMaterial = null;
        /** @private */ this._sideMesh = null;
        /** @private */ this._sideGeometry = null;
        /** @private */ this._sideMaterial = null;
        /** @private */ this._sideVertexCount = 0;
        /** @private */ this._strokeLine = null;
        /** @private */ this._strokeGeometry = null;
        /** @private */ this._strokeMaterial = null;

        // Кэш высот
        /** @private */ this._cachedHeights = new Array(this._rings[0]?.length ?? 0).fill(0);
        /** @private */ this._cachedStrokeHeights = new Array(this._rings[0]?.length ?? 0).fill(0);
        /** @private */ this._lastHeightUpdateTime = 0;
        /** @private */ this._heightUpdateInterval = 500;
        /** @private */ this._heightsDirty = true;

        // 2D вершины и центроид
        /** @private */ this._vertices2D = [];
        /** @private */ this._centroidWorld = new THREE.Vector3();
        /** @private */ this._cachedCentroidHeight = 0;
        /** @private */ this._lastCentroidHeightUpdateTime = 0;

        // Подпись
        /** @private */ this._centroidScreenPos = null;
        /** @private */ this._textLabel = null;
        /** @private */ this._titleAllowOverflow = options.titleAllowOverflow || false;
        /** @private */ this._titlePriority = options.titlePriority ?? 0;

        // Кэш координат (не очищается при remove)
        /** @private */ this._cachedWorldRings = null; // будет заполнен ниже
        /** @private */ this._cachedLocalRings = null;
        /** @private */ this._boundingSphere = null;
        /** @private */ this._lastWorldGroupPos = new THREE.Vector3();

        // Временные векторы
        /** @private */ this._tempVector3_1 = new THREE.Vector3();
        /** @private */ this._tempVector3_2 = new THREE.Vector3();
        /** @private */ this._tempVector3_3 = new THREE.Vector3();
        /** @private */ this._tempVector3_4 = new THREE.Vector3();

        this._precomputeWorldCoordinates();
    }

    /**
     * Преобразует все координаты колец в мировые и сохраняет в кэш.
     * Если кольцо невалидно, сохраняется null.
     *
     * @returns {void}
     * @private
     */
    _precomputeWorldCoordinates() {
        this._cachedWorldRings = this._rings.map(ring => {
            if (!Array.isArray(ring) || ring.length < 3) return null;
            const arr = new Float32Array(ring.length * 2);
            for (let i = 0; i < ring.length; i++) {
                const point = ring[i];
                if (!Array.isArray(point) || point.length < 2) return null;
                const [lon, lat] = point;
                const [x, z] = proj.fromLonLat([lon, lat]);
                arr[i * 2] = x;
                arr[i * 2 + 1] = z;
            }
            return arr;
        });
    }

    /**
     * Создаёт персональный слой, добавляет его на карту и помещает в него данный полигон.
     *
     * @param {Object} map - Экземпляр карты.
     * @returns {Polygon} Текущий экземпляр полигона.
     */
    addTo(map) {
        if (this._map) this.remove();
        const personalLayer = new Layer();
        personalLayer.addTo(map);
        personalLayer.add(this);
        return this;
    }

    /**
     * Вызывается слоем при добавлении, строит геометрию и регистрирует подпись.
     *
     * @param {Object} map - Экземпляр карты.
     * @param {Layer} layer - Слой-владелец.
     * @returns {void}
     * @private
     */
    _attach(map, layer) {
        if (this._map === map && this._layer === layer) return;
        this.remove();
        this._map = map;
        this._layer = layer;

        // Если кэш координат отсутствует (например, после удаления), пересчитаем
        if (!this._cachedWorldRings) {
            this._precomputeWorldCoordinates();
        }

        this._buildFillGeometry(map);
        this._buildStrokeGeometry(map);
        map.worldGroup.add(this._group);

        if (this._title && map.textManager) {
            this._textLabel = map.textManager.addLabel(this);
        }

        if (this._onClick || this._onHover || this._tooltipText) {
            this._bindEventHandlers(map);
        }

        this._lastWorldGroupPos.copy(map.worldGroup.position);
        this._heightsDirty = true;
    }

    /**
     * Возвращает CSS-трансформацию для подписи.
     *
     * @returns {string} CSS-трансформация.
     * @private
     */
    _getTitleTransform() {
        switch (this._titleAlign) {
            case 'left': return 'translate(0, 0)';
            case 'right': return 'translate(-100%, 0)';
            default: return 'translate(-50%, 0)';
        }
    }

    /**
     * Строит геометрию заливки полигона с использованием триангуляции Earcut.
     *
     * @param {Object} map - Экземпляр карты.
     * @returns {void}
     * @private
     */
    _buildFillGeometry(map) {
        const rings = this._rings;
        if (!rings || !rings.length || rings[0].length < 3) {
            console.warn('Polygon: rings[0] must have at least 3 points');
            return;
        }

        // Используем кэшированные мировые координаты (если есть), иначе пересчитываем на лету
        const worldRings = this._cachedWorldRings || this._rings.map(ring => {
            if (!Array.isArray(ring) || ring.length < 3) return null;
            const arr = new Float32Array(ring.length * 2);
            for (let i = 0; i < ring.length; i++) {
                const [lon, lat] = ring[i];
                const [x, z] = proj.fromLonLat([lon, lat]);
                arr[i * 2] = x;
                arr[i * 2 + 1] = z;
            }
            return arr;
        });

        const coords = [];
        const points2D = [];
        const holeIndices = [];
        const ringStartIndices = [];

        for (let ringIdx = 0; ringIdx < rings.length; ringIdx++) {
            const ring = rings[ringIdx];
            const worldRing = worldRings[ringIdx];

            // Пропускаем невалидные кольца (кроме первого, которое обязательно)
            if (!ring || ring.length < 3 || !worldRing) {
                if (ringIdx === 0) {
                    console.warn('Polygon: outer ring is invalid');
                    return;
                }
                continue;
            }

            ringStartIndices.push(points2D.length);
            if (ringIdx > 0) holeIndices.push(coords.length / 2);

            const firstX = worldRing[0];
            const firstZ = worldRing[1];

            for (let i = 0; i < ring.length; i++) {
                const x = worldRing[i * 2];
                const z = worldRing[i * 2 + 1];
                if (i > 0 && x === firstX && z === firstZ) continue;
                coords.push(x, z);
                points2D.push(new THREE.Vector2(x, z));
            }
        }

        if (points2D.length < 3) {
            console.warn('Polygon: after processing rings, less than 3 vertices');
            return;
        }

        this._vertices2D = points2D;
        this._cachedHeights = new Array(points2D.length).fill(0);

        const indices = earcut(coords, holeIndices, 2);
        if (indices.length === 0) {
            console.warn('Polygon: Earcut returned no triangles');
            return;
        }

        // Центроид
        let cx = 0, cz = 0;
        for (const pt of points2D) {
            cx += pt.x;
            cz += pt.y;
        }
        cx /= points2D.length;
        cz /= points2D.length;

        this._centroidWorld.set(cx, 0, cz);
        this._group.position.copy(this._centroidWorld);

        // Локальные координаты
        for (let i = 0; i < points2D.length; i++) {
            points2D[i].x -= cx;
            points2D[i].y -= cz;
        }

        // Сохраняем локальные координаты колец для обводки
        this._cachedLocalRings = worldRings.map(worldRing => {
            if (!worldRing) return null;
            const local = new Float32Array(worldRing.length);
            for (let i = 0; i < worldRing.length; i += 2) {
                local[i] = worldRing[i] - cx;
                local[i + 1] = worldRing[i + 1] - cz;
            }
            return local;
        });

        // ----- Верхняя крышка -----
        const topGeometry = new THREE.BufferGeometry();
        const topPosArray = new Float32Array(points2D.length * 3);
        for (let i = 0; i < points2D.length; i++) {
            const pt = points2D[i];
            topPosArray[i * 3] = pt.x;
            topPosArray[i * 3 + 1] = 0;
            topPosArray[i * 3 + 2] = pt.y;
        }
        topGeometry.setAttribute('position', new THREE.BufferAttribute(topPosArray, 3));
        topGeometry.setIndex(indices);
        topGeometry.computeVertexNormals();

        const topMaterial = new THREE.MeshBasicMaterial({
            color: this._fillColor,
            opacity: this._fillOpacity,
            transparent: this._fillOpacity < 1,
            side: THREE.DoubleSide,
            depthTest: this._depthTest,
            depthWrite: this._depthWrite
        });

        const topMesh = new THREE.Mesh(topGeometry, topMaterial);
        topMesh.renderOrder = 998;
        this._fillMesh = topMesh;
        this._fillGeometry = topGeometry;
        this._fillMaterial = topMaterial;
        this._group.add(topMesh);

        // Bounding sphere
        topGeometry.computeBoundingSphere();
        this._boundingSphere = topGeometry.boundingSphere.clone();
        this._boundingSphere.center.add(this._centroidWorld);

        // ----- Экструзия -----
        if (this._extruded) {
            // Нижняя крышка
            const bottomGeometry = new THREE.BufferGeometry();
            const bottomPosArray = new Float32Array(points2D.length * 3);
            for (let i = 0; i < points2D.length; i++) {
                const pt = points2D[i];
                bottomPosArray[i * 3] = pt.x;
                bottomPosArray[i * 3 + 1] = 0;
                bottomPosArray[i * 3 + 2] = pt.y;
            }
            bottomGeometry.setAttribute('position', new THREE.BufferAttribute(bottomPosArray, 3));
            bottomGeometry.setIndex(indices);
            bottomGeometry.computeVertexNormals();

            const bottomMaterial = new THREE.MeshBasicMaterial({
                color: this._fillColor,
                opacity: this._fillOpacity,
                transparent: this._fillOpacity < 1,
                side: THREE.DoubleSide,
                depthTest: this._depthTest,
                depthWrite: this._depthWrite
            });

            const bottomMesh = new THREE.Mesh(bottomGeometry, bottomMaterial);
            bottomMesh.renderOrder = 998;
            this._bottomMesh = bottomMesh;
            this._bottomGeometry = bottomGeometry;
            this._bottomMaterial = bottomMaterial;
            this._group.add(bottomMesh);

            // Боковые стенки
            const sidePositions = [];
            const sideIndices = [];

            for (let ringIdx = 0; ringIdx < rings.length; ringIdx++) {
                if (ringStartIndices[ringIdx] === undefined) continue;
                const start = ringStartIndices[ringIdx];
                const nextRingStart = (ringIdx + 1 < ringStartIndices.length) ? ringStartIndices[ringIdx + 1] : points2D.length;
                const count = nextRingStart - start;
                if (count < 2) continue;

                for (let i = 0; i < count; i++) {
                    const j = (i + 1) % count;
                    const idxI = start + i;
                    const idxJ = start + j;
                    const topI = points2D[idxI];
                    const topJ = points2D[idxJ];

                    const baseIndex = sidePositions.length / 3;
                    sidePositions.push(topI.x, 0, topI.y);
                    sidePositions.push(topI.x, 0, topI.y);
                    sidePositions.push(topJ.x, 0, topJ.y);
                    sidePositions.push(topJ.x, 0, topJ.y);

                    sideIndices.push(baseIndex, baseIndex + 1, baseIndex + 2);
                    sideIndices.push(baseIndex + 1, baseIndex + 3, baseIndex + 2);
                }
            }

            const sideGeometry = new THREE.BufferGeometry();
            sideGeometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(sidePositions), 3));
            sideGeometry.setIndex(sideIndices);
            sideGeometry.computeVertexNormals();

            const sideMaterial = new THREE.MeshBasicMaterial({
                color: this._fillColor,
                opacity: this._fillOpacity,
                transparent: this._fillOpacity < 1,
                side: THREE.DoubleSide,
                depthTest: this._depthTest,
                depthWrite: this._depthWrite
            });

            const sideMesh = new THREE.Mesh(sideGeometry, sideMaterial);
            sideMesh.renderOrder = 998;
            this._sideMesh = sideMesh;
            this._sideGeometry = sideGeometry;
            this._sideMaterial = sideMaterial;
            this._sideVertexCount = sidePositions.length / 3;
            this._group.add(sideMesh);
        }
    }

    /**
     * Строит геометрию обводки полигона на основе Line2.
     *
     * @param {Object} map - Экземпляр карты.
     * @returns {void}
     * @private
     */
    _buildStrokeGeometry(map) {
        if (this._strokeWidth <= 0 || this._strokeOpacity <= 0) return;

        const canvas = map.renderer.domElement;
        this._strokeGeometry = new LineGeometry();
        this._strokeMaterial = new LineMaterial({
            color: this._strokeColor,
            linewidth: this._strokeWidth,
            opacity: this._strokeOpacity,
            transparent: this._strokeOpacity < 1,
            depthTest: this._depthTest,
            depthWrite: this._depthWrite,
            resolution: new THREE.Vector2(canvas.width, canvas.height)
        });
        const line = new Line2(this._strokeGeometry, this._strokeMaterial);
        line.renderOrder = 999;
        this._strokeLine = line;
        this._group.add(line);
    }

    /**
     * Привязывает обработчики событий мыши к canvas.
     *
     * @param {Object} map - Экземпляр карты.
     * @returns {void}
     * @private
     */
    _bindEventHandlers(map) {
        const canvas = map.renderer.domElement;
        this._boundHandlers = {
            mousedown: (e) => this._onCanvasMouseDown(e, map),
            mousemove: (e) => this._onCanvasMouseMove(e, map),
            click: (e) => this._onCanvasClick(e, map)
        };
        canvas.addEventListener('mousedown', this._boundHandlers.mousedown, true);
        canvas.addEventListener('mousemove', this._boundHandlers.mousemove, true);
        canvas.addEventListener('click', this._boundHandlers.click, true);
    }

    /**
     * Удаляет привязанные обработчики событий с canvas.
     *
     * @returns {void}
     * @private
     */
    _unbindEventHandlers() {
        if (!this._boundHandlers || !this._map) return;
        const canvas = this._map.renderer.domElement;
        canvas.removeEventListener('mousedown', this._boundHandlers.mousedown, true);
        canvas.removeEventListener('mousemove', this._boundHandlers.mousemove, true);
        canvas.removeEventListener('click', this._boundHandlers.click, true);
        this._boundHandlers = null;
        this._isHovered = false;
    }

    /**
     * Проверяет, находится ли точка экрана над геометрией полигона.
     *
     * @param {MouseEvent} event - Событие мыши.
     * @param {Object} map - Экземпляр карты.
     * @returns {boolean} true, если луч пересекает хотя бы один меш полигона.
     * @private
     */
    _raycastPolygon(event, map) {
        if (!this._group.visible) return false;

        const rect = map.renderer.domElement.getBoundingClientRect();
        const mouse = new THREE.Vector2(
            ((event.clientX - rect.left) / rect.width) * 2 - 1,
            -((event.clientY - rect.top) / rect.height) * 2 + 1
        );

        const raycaster = new THREE.Raycaster();
        raycaster.setFromCamera(mouse, map.camera);

        if (this._boundingSphere) {
            const worldGroupPos = map.worldGroup.position;
            const worldSphere = this._boundingSphere.clone();
            worldSphere.center.add(worldGroupPos);
            if (!raycaster.ray.intersectsSphere(worldSphere)) return false;
        }

        const objects = [];
        if (this._fillMesh) objects.push(this._fillMesh);
        if (this._sideMesh) objects.push(this._sideMesh);
        if (this._bottomMesh) objects.push(this._bottomMesh);
        if (objects.length === 0) return false;

        const intersects = raycaster.intersectObjects(objects, false);
        return intersects.length > 0;
    }

    /**
     * Обработчик mousedown на canvas.
     *
     * @param {MouseEvent} event - Событие мыши.
     * @param {Object} map - Экземпляр карты.
     * @returns {void}
     * @private
     */
    _onCanvasMouseDown(event, map) {
        if (!this._raycastPolygon(event, map)) return;
    }

    /**
     * Обработчик mousemove на canvas.
     *
     * @param {MouseEvent} event - Событие мыши.
     * @param {Object} map - Экземпляр карты.
     * @returns {void}
     * @private
     */
    _onCanvasMouseMove(event, map) {
        const hit = this._raycastPolygon(event, map);
        if (hit) {
            if (!this._isHovered) {
                this._isHovered = true;
                if (this._onHover) {
                    this._onHover(true);
                } else if (this._tooltipText && map.popupManager) {
                    map.popupManager.show(this, this._tooltipText);
                }
            }
        } else {
            if (this._isHovered) {
                this._isHovered = false;
                if (this._onHover) {
                    this._onHover(false);
                } else if (this._tooltipText && map.popupManager) {
                    map.popupManager.hide();
                }
            }
        }
    }

    /**
     * Обработчик click на canvas.
     *
     * @param {MouseEvent} event - Событие мыши.
     * @param {Object} map - Экземпляр карты.
     * @returns {void}
     * @private
     */
    _onCanvasClick(event, map) {
        if (!this._raycastPolygon(event, map)) return;

        if (this._onClick) {
            this._onClick(event, this);
        } else if (this._tooltipText && map.popupManager) {
            map.popupManager.show(this, this._tooltipText);
        }
    }

    /**
     * Удаляет полигон с карты, освобождает все ресурсы и удаляет подпись.
     * Также отвязывает обработчики событий мыши.
     *
     * @returns {void}
     */
    remove() {
        this._unbindEventHandlers();

        if (this._group) {
            this._group.parent?.remove(this._group);
            this._fillGeometry?.dispose();
            this._fillMaterial?.dispose();
            this._bottomGeometry?.dispose();
            this._bottomMaterial?.dispose();
            this._sideGeometry?.dispose();
            this._sideMaterial?.dispose();
            this._strokeGeometry?.dispose();
            this._strokeMaterial?.dispose();
            this._fillMesh = null;
            this._bottomMesh = null;
            this._sideMesh = null;
            this._strokeLine = null;
            this._fillGeometry = null;
            this._fillMaterial = null;
            this._bottomGeometry = null;
            this._bottomMaterial = null;
            this._sideGeometry = null;
            this._sideMaterial = null;
            this._strokeGeometry = null;
            this._strokeMaterial = null;
        }
        if (this._textLabel && this._map?.textManager) {
            this._map.textManager.removeLabel(this._textLabel);
            this._textLabel = null;
        }
        this._layer?._removeRef(this);
        this._layer = null;
        this._map = null;
        // Не очищаем _cachedWorldRings и _cachedLocalRings, чтобы можно было повторно добавить
    }

    /**
     * Обновляет состояние полигона на каждом кадре: видимость по зуму, высоты и позицию центроида.
     *
     * @param {Object} map - Экземпляр карты.
     * @returns {void}
     * @private
     */
    _update(map) {
        if (!this._map || !this._group) return;
        const zoom = this._map.continuousZoom;

        if (this._layer && !this._layer.visible) {
            this._group.visible = false;
            return;
        }
        if (zoom < this._minZoom || zoom > this._maxZoom) {
            this._group.visible = false;
            return;
        }

        if (this._group.parent !== this._map.worldGroup) {
            this._group.parent?.remove(this._group);
            this._map.worldGroup.add(this._group);
        }

        if (this._strokeMaterial) {
            const canvas = this._map.renderer.domElement;
            const res = this._strokeMaterial.resolution;
            if (res.x !== canvas.width || res.y !== canvas.height) {
                this._strokeMaterial.resolution.set(canvas.width, canvas.height);
            }
        }

        // Проверка дальности отрисовки с помощью bounding sphere
        if (map.view.objectDistanceFactor > 0 && this._boundingSphere) {
            const worldGroupPos = map.worldGroup.position;
            const sphereWorldCenter = this._tempVector3_1.copy(this._boundingSphere.center).add(worldGroupPos);
            const distanceToCenter = map.camera.position.distanceTo(sphereWorldCenter);
            if (distanceToCenter - this._boundingSphere.radius > map.maxObjectDistance) {
                this._group.visible = false;
                return;
            }
        }

        // Обнаружение сдвига мира для установки dirty-флага высот
        if (!this._lastWorldGroupPos.equals(map.worldGroup.position)) {
            this._heightsDirty = true;
            this._lastWorldGroupPos.copy(map.worldGroup.position);
        }

        this._group.visible = true;
        if (this._heightsDirty || (performance.now() - this._lastHeightUpdateTime) >= this._heightUpdateInterval) {
            this._updateHeights();
            this._heightsDirty = false;
            this._lastHeightUpdateTime = performance.now();
        }
        this._updateStroke();
        this._updateCentroidScreenPos();
    }

    /**
     * Обновляет высоты вершин всех геометрий в соответствии с режимом высоты и экструзией.
     *
     * @returns {void}
     * @private
     */
    _updateHeights() {
        if (!this._fillGeometry || !this._vertices2D.length) return;
        const map = this._map;
        const wgPos = map.worldGroup.position;

        // Обновляем высоты для вершин заливки
        for (let i = 0; i < this._vertices2D.length; i++) {
            const localX = this._vertices2D[i].x;
            const localZ = this._vertices2D[i].y;
            let base = this._altitudeOffset;
            if (this._altitudeMode === 'clampToGround') {
                const worldX = this._group.position.x + localX + wgPos.x;
                const worldZ = this._group.position.z + localZ + wgPos.z;
                map.ensureTileForPoint?.(worldX, worldZ);
                base = map.getSurfaceHeightAt(worldX, worldZ) + this._altitudeOffset;
            }
            const upperY = base + this._minHeight + (this._extruded ? this._height : 0);
            this._cachedHeights[i] = upperY;
        }

        // Обновляем высоты для обводки
        const outerWorldRing = this._cachedWorldRings?.[0] || this._rings[0];
        if (outerWorldRing) {
            for (let i = 0; i < this._cachedStrokeHeights.length; i++) {
                const worldX = Array.isArray(outerWorldRing[i * 2]) ? outerWorldRing[i * 2][0] : outerWorldRing[i * 2];
                const worldZ = Array.isArray(outerWorldRing[i * 2 + 1]) ? outerWorldRing[i * 2 + 1][1] : outerWorldRing[i * 2 + 1];
                let base = this._altitudeOffset;
                if (this._altitudeMode === 'clampToGround') {
                    map.ensureTileForPoint?.(worldX, worldZ);
                    base = map.getSurfaceHeightAt(worldX, worldZ) + this._altitudeOffset;
                }
                this._cachedStrokeHeights[i] = base + this._minHeight + (this._extruded ? this._height : 0);
            }
        }

        // Применяем высоты к верхней крышке
        const topPos = this._fillGeometry.attributes.position.array;
        for (let i = 0; i < this._vertices2D.length; i++) {
            topPos[i * 3 + 1] = this._cachedHeights[i];
        }
        this._fillGeometry.attributes.position.needsUpdate = true;
        this._fillGeometry.computeVertexNormals();

        // Нижняя крышка
        if (this._bottomGeometry) {
            const bottomPos = this._bottomGeometry.attributes.position.array;
            for (let i = 0; i < this._vertices2D.length; i++) {
                bottomPos[i * 3 + 1] = this._cachedHeights[i] - this._height;
            }
            this._bottomGeometry.attributes.position.needsUpdate = true;
            this._bottomGeometry.computeVertexNormals();
        }

        // Боковые стенки
        if (this._sideGeometry) {
            const sidePos = this._sideGeometry.attributes.position.array;
            const n = this._vertices2D.length;
            let idx = 0;
            for (let i = 0; i < n; i++) {
                const j = (i + 1) % n;
                const upperI = this._cachedHeights[i];
                const upperJ = this._cachedHeights[j];
                const lowerI = upperI - this._height;
                const lowerJ = upperJ - this._height;

                sidePos[idx * 3 + 1] = upperI;
                idx++;
                sidePos[idx * 3 + 1] = lowerI;
                idx++;
                sidePos[idx * 3 + 1] = upperJ;
                idx++;
                sidePos[idx * 3 + 1] = lowerJ;
                idx++;
            }
            this._sideGeometry.attributes.position.needsUpdate = true;
            this._sideGeometry.computeVertexNormals();
        }
    }

    /**
     * Обновляет позиции вершин обводки.
     *
     * @returns {void}
     * @private
     */
    _updateStroke() {
        if (!this._strokeLine || !this._strokeGeometry || !this._cachedLocalRings) return;
        const outerLocalRing = this._cachedLocalRings[0];
        if (!outerLocalRing) return;
        const positions = [];

        for (let i = 0; i < this._cachedStrokeHeights.length; i++) {
            const x = outerLocalRing[i * 2];
            const z = outerLocalRing[i * 2 + 1];
            const y = this._cachedStrokeHeights[i] ?? this._altitudeOffset;
            positions.push(x, y, z);
        }

        if (this._cachedStrokeHeights.length > 0) {
            const firstX = outerLocalRing[0];
            const firstZ = outerLocalRing[1];
            const firstY = this._cachedStrokeHeights[0] ?? this._altitudeOffset;
            positions.push(firstX, firstY, firstZ);
        }

        this._strokeGeometry.setPositions(positions);
        this._strokeLine.computeLineDistances();
    }

    /**
     * Пересчитывает экранную позицию центроида полигона для подписи.
     *
     * @returns {void}
     * @private
     */
    _updateCentroidScreenPos() {
        if (!this._map || !this._centroidWorld) {
            this._centroidScreenPos = null;
            return;
        }
        const wgPos = this._map.worldGroup.position;
        const worldX = this._centroidWorld.x + wgPos.x;
        const worldZ = this._centroidWorld.z + wgPos.z;

        let worldY = this._altitudeOffset;
        if (this._altitudeMode === 'clampToGround') {
            const now = performance.now();
            if (now - (this._lastCentroidHeightUpdateTime || 0) > this._heightUpdateInterval) {
                this._map.ensureTileForPoint(worldX, worldZ);
                this._cachedCentroidHeight = this._map.getSurfaceHeightAt(worldX, worldZ);
                this._lastCentroidHeightUpdateTime = now;
            }
            worldY = (this._cachedCentroidHeight ?? 0) + this._altitudeOffset;
        }
        worldY += this._minHeight + (this._extruded ? this._height : 0);

        const worldPos = this._tempVector3_1.set(worldX, worldY + wgPos.y, worldZ);
        const screenPos = worldPos.clone().project(this._map.camera);
        if (screenPos.z > 1 || Math.abs(screenPos.x) > 1 || Math.abs(screenPos.y) > 1) {
            this._centroidScreenPos = null;
        } else {
            const canvas = this._map.renderer.domElement;
            this._centroidScreenPos = {
                x: (screenPos.x * 0.5 + 0.5) * canvas.clientWidth,
                y: (-screenPos.y * 0.5 + 0.5) * canvas.clientHeight
            };
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
     * Возвращает объект CSS-стилей подписи.
     *
     * @returns {Object} Объект CSS-стилей подписи.
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
     * Возвращает границы зума для отображения подписи.
     *
     * @property {number} min - Минимальный зум.
     * @property {number} max - Максимальный зум.
     * @returns {Object} Границы зума.
     */
    getTextZoomBounds() { return { min: this._titleMinZoom, max: this._titleMaxZoom }; }

    /**
     * Возвращает тип подписи.
     *
     * @returns {string} Тип подписи ('polygon').
     */
    getLabelType() { return 'polygon'; }

    /**
     * Проверяет, видим ли полигон в текущем кадре.
     *
     * @returns {boolean} Результат проверки видимости.
     */
    isVisible() { return this._group?.visible ?? false; }

    /**
     * Возвращает экранную позицию центроида.
     *
     * @property {number} x - Координата X.
     * @property {number} y - Координата Y.
     * @returns {Object|null} Экранная позиция центроида (или null).
     */
    getScreenPosition() { return this._centroidScreenPos; }

    /**
     * Возвращает горизонтальное выравнивание подписи.
     *
     * @returns {string} Горизонтальное выравнивание подписи.
     */
    getTitleAlign() { return this._titleAlign; }

    /**
     * Возвращает смещение подписи в пикселях.
     *
     * @returns {Array.<number>} Смещение подписи в пикселях.
     */
    getTitleOffset() { return this._titleOffset; }

    /**
     * Возвращает вертикальное выравнивание.
     *
     * @returns {string} Вертикальное выравнивание (всегда 'center').
     */
    getTitleVerticalAlign() { return 'center'; }

    /**
     * Проверяет, разрешён ли выход подписи за границы.
     *
     * @returns {boolean} Разрешён ли выход подписи за границы.
     */
    getAllowOverflow() { return this._titleAllowOverflow; }

    /**
     * Возвращает приоритет подписи.
     *
     * @returns {number} Приоритет подписи.
     */
    getPriority() { return this._titlePriority; }
}