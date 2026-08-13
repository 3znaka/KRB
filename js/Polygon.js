/**
 * Модуль для рисования полигонов (многоугольников) на карте.
 * Предоставляет класс {@link Polygon}, использующий триангуляцию Earcut
 * для заливки и "толстые" линии для обводки, с поддержкой высот,
 * видимости по зуму и подписей через TextManager.
 *
 * @module polygon
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
    if (abLenSq === 0) return point.distanceTo(a); // вырожденный отрезок
    let t = ap.dot(ab) / abLenSq;
    t = Math.max(0, Math.min(1, t));
    const closest = new THREE.Vector3().copy(a).addScaledVector(ab, t);
    return point.distanceTo(closest);
}

/**
 * Класс, представляющий полигон на карте.
 * Поддерживает заливку, обводку, настройку высот, ограничения по зуму
 * и текстовую подпись.
 *
 * @example
 * const polygon = new Polygon({
 *   rings: [[[30.5, 50.4], [31.0, 50.5], [30.8, 50.7]]],
 *   fillColor: '#ff0000',
 *   fillOpacity: 0.3,
 *   strokeColor: '#000',
 *   strokeWidth: 2
 * });
 * polygon.addTo(map);
 */
export class Polygon {
    /**
     * @param {Object} options - Настройки полигона.
     * @param {[number, number][][]} options.rings - Массив колец. Первое кольцо – внешний контур,
     *        остальные (опционально) – отверстия. Каждое кольцо – массив точек [долгота, широта].
     * @param {string} [options.fillColor='#3388ff'] - Цвет заливки (CSS).
     * @param {number} [options.fillOpacity=0.5] - Прозрачность заливки (0..1).
     * @param {string} [options.strokeColor='#000000'] - Цвет обводки.
     * @param {number} [options.strokeWidth=2] - Толщина обводки в пикселях.
     * @param {number} [options.strokeOpacity=1] - Прозрачность обводки.
     * @param {string} [options.altitudeMode='clampToGround'] - Режим высоты: 'clampToGround' (прилегать к рельефу) или 'absolute' (постоянная высота).
     * @param {number} [options.altitudeOffset=10] - Добавочная высота над поверхностью.
     * @param {boolean} [options.depthTest=false] - Включить тест глубины.
     * @param {boolean} [options.depthWrite=false] - Включить запись в буфер глубины.
     * @param {number} [options.minZoom=-Infinity] - Минимальный зум, при котором полигон виден.
     * @param {number} [options.maxZoom=Infinity] - Максимальный зум, при котором полигон виден.
     * @param {string} [options.title=''] - Текст постоянной подписи.
     * @param {[number, number]} [options.titleOffset=[0,0]] - Смещение подписи в пикселях.
     * @param {string} [options.titleAlign='center'] - Горизонтальное выравнивание подписи ('left', 'center', 'right').
     * @param {Object} [options.titleStyle={}] - CSS-стили подписи.
     * @param {number} [options.titleMinZoom=-Infinity] - Минимальный зум для отображения подписи.
     * @param {number} [options.titleMaxZoom=Infinity] - Максимальный зум для отображения подписи.
     * @param {boolean} [options.titleAllowOverflow=false] - Разрешить выход подписи за границы экрана.
     * @param {number} [options.titlePriority=0] - Приоритет подписи (чем выше, тем приоритетнее).
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

        // Подпись
        /** @private */ this._title = options.title || '';
        /** @private */ this._titleOffset = options.titleOffset || [0, 0];
        /** @private */ this._titleAlign = options.titleAlign || 'center';
        /** @private */ this._titleStyle = options.titleStyle || {};
        /** @private */ this._titleMinZoom = options.titleMinZoom ?? -Infinity;
        /** @private */ this._titleMaxZoom = options.titleMaxZoom ?? Infinity;

        /** @private */ this._map = null;
        /** @private */ this._layer = null;
        /** @private */ this._group = new THREE.Group();
        /** @private */ this._fillMesh = null;
        /** @private */ this._strokeLine = null;
        /** @private */ this._fillGeometry = null;
        /** @private */ this._fillMaterial = null;
        /** @private */ this._strokeGeometry = null;
        /** @private */ this._strokeMaterial = null;

        /** @private */ this._cachedHeights = new Array(this._rings[0]?.length ?? 0).fill(0);
        /** @private */ this._cachedStrokeHeights = new Array(this._rings[0]?.length ?? 0).fill(0);
        /** @private */ this._lastHeightUpdateTime = 0;
        /** @private */ this._heightUpdateInterval = 500;

        /** @private */ this._vertices2D = [];
        /** @private */ this._centroidLocal = new THREE.Vector2();
        /** @private */ this._cachedCentroidHeight = 0;
        /** @private */ this._lastCentroidHeightUpdateTime = 0;

        /** @private */ this._centroidScreenPos = null;
        /** @private */ this._textLabel = null;
        
        /** @private */ this._titleAllowOverflow = options.titleAllowOverflow || false;
        /** @private */ this._titlePriority = options.titlePriority ?? 0;
    }

    /**
     * Удобный метод: создаёт персональный слой, добавляет его на карту
     * и помещает в него данный полигон.
     *
     * @param {Object} map - Экземпляр карты.
     * @returns {Polygon} this
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
     * Строит геометрию заливки и обводки, добавляет их в сцену
     * и регистрирует подпись.
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

        this._buildFillGeometry(map);
        this._buildStrokeGeometry(map);
        map.worldGroup.add(this._group);

        if (this._title && map.textManager) {
            this._textLabel = map.textManager.addLabel(this);
        }
    }

    /**
     * Возвращает CSS-трансформацию для подписи в зависимости от выравнивания.
     * @returns {string} CSS transform.
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
     * @param {Object} map - Экземпляр карты.
     * @private
     */
    _buildFillGeometry(map) {
        const outerRing = this._rings[0];
        if (outerRing.length < 3) {
            console.warn('Polygon: outer ring must have at least 3 points');
            return;
        }

        const coords = [];
        const points2D = [];
        for (const [lon, lat] of outerRing) {
            const [absX, absZ] = proj.fromLonLat([lon, lat]);
            coords.push(absX, absZ);
            points2D.push(new THREE.Vector2(absX, absZ));
        }

        // Убираем замыкающую точку, если она совпадает с первой
        if (coords.length >= 4) {
            const n = coords.length / 2;
            if (coords[0] === coords[(n-1)*2] && coords[1] === coords[(n-1)*2+1]) {
                coords.length -= 2;
                points2D.pop();
            }
        }

        if (points2D.length < 3) {
            console.warn('Polygon: after dedup, less than 3 vertices');
            return;
        }

        const holeIndices = [];
        const indices = earcut(coords, holeIndices, 2);

        if (indices.length === 0) {
            console.warn('Polygon: Earcut returned no triangles');
            return;
        }

        this._vertices2D = points2D;

        // Центроид (среднее арифметическое вершин)
        let cx = 0, cy = 0;
        for (const pt of points2D) {
            cx += pt.x;
            cy += pt.y;
        }
        this._centroidLocal.set(cx / points2D.length, cy / points2D.length);

        const geometry = new THREE.BufferGeometry();
        const posArray = new Float32Array(points2D.length * 3);
        for (let i = 0; i < points2D.length; i++) {
            const pt = points2D[i];
            posArray[i * 3] = pt.x;
            posArray[i * 3 + 1] = 0;   // Y будет обновлён позже
            posArray[i * 3 + 2] = pt.y; // Vector2.y соответствует Z
        }
        geometry.setAttribute('position', new THREE.BufferAttribute(posArray, 3));
        geometry.setIndex(indices);
        geometry.computeVertexNormals();

        const material = new THREE.MeshBasicMaterial({
            color: this._fillColor,
            opacity: this._fillOpacity,
            transparent: this._fillOpacity < 1,
            side: THREE.DoubleSide,
            depthTest: this._depthTest,
            depthWrite: this._depthWrite
        });

        const mesh = new THREE.Mesh(geometry, material);
        mesh.renderOrder = 998;
        this._fillMesh = mesh;
        this._fillGeometry = geometry;
        this._fillMaterial = material;
        this._group.add(mesh);
    }

    /**
     * Строит геометрию обводки полигона на основе Line2.
     * @param {Object} map - Экземпляр карты.
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
     * Удаляет полигон с карты, освобождает все ресурсы и удаляет подпись.
     */
    remove() {
        if (this._group) {
            this._group.parent?.remove(this._group);
            this._fillGeometry?.dispose();
            this._fillMaterial?.dispose();
            this._strokeGeometry?.dispose();
            this._strokeMaterial?.dispose();
            this._fillMesh = null;
            this._strokeLine = null;
            this._fillGeometry = null;
            this._fillMaterial = null;
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
    }

    /**
     * Обновляет состояние полигона на каждом кадре:
     * видимость по зуму и слою, высоты, обводку, позицию центроида для подписи.
     *
     * @param {Object} map - Экземпляр карты.
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

        // Убедимся, что группа находится в правильной ветке сцены
        if (this._group.parent !== this._map.worldGroup) {
            this._group.parent?.remove(this._group);
            this._map.worldGroup.add(this._group);
        }

        // Актуализация разрешения материала обводки
        if (this._strokeMaterial) {
            const canvas = this._map.renderer.domElement;
            const res = this._strokeMaterial.resolution;
            if (res.x !== canvas.width || res.y !== canvas.height) {
                this._strokeMaterial.resolution.set(canvas.width, canvas.height);
            }
        }

        // Проверка дальности отрисовки
        if (map.view.objectDistanceFactor > 0 && this._vertices2D.length >= 2) {
            const wgPos = map.worldGroup.position;

            const points3D = this._vertices2D.map((v2, i) => {
                const h = this._cachedHeights?.[i] ?? this._altitudeOffset;
                return new THREE.Vector3(v2.x + wgPos.x, h + wgPos.y, v2.y + wgPos.z);
            });

            // Замыкаем кольцо для проверки всех рёбер
            if (points3D.length > 0) {
                points3D.push(points3D[0].clone());
            }

            let minDist = Infinity;
            for (let i = 0; i < points3D.length - 1; i++) {
                const dist = pointToSegmentDistance(
                    map.camera.position,
                    points3D[i],
                    points3D[i + 1]
                );
                if (dist < minDist) minDist = dist;
            }

            if (minDist > map.maxObjectDistance) {
                this._group.visible = false;
                return;
            }
        }

        this._group.visible = true;
        this._updateHeights();
        this._updateStroke();
        this._updateCentroidScreenPos();
    }

    /**
     * Обновляет высоты вершин заливки и обводки в соответствии с рельефом.
     * @private
     */
    _updateHeights() {
        if (!this._fillGeometry || !this._vertices2D.length) return;
        const map = this._map;
        const now = performance.now();
        const needsUpdate = (now - this._lastHeightUpdateTime) >= this._heightUpdateInterval;

        if (needsUpdate) {
            const wgPos = map.worldGroup.position;
            // Высоты для вершин заливки
            for (let i = 0; i < this._vertices2D.length; i++) {
                const localX = this._vertices2D[i].x;
                const localZ = this._vertices2D[i].y;
                let y = this._altitudeOffset;
                if (this._altitudeMode === 'clampToGround') {
                    const worldX = localX + wgPos.x;
                    const worldZ = localZ + wgPos.z;
                    map.ensureTileForPoint?.(worldX, worldZ);
                    y = map.getSurfaceHeightAt(worldX, worldZ) + this._altitudeOffset;
                }
                this._cachedHeights[i] = y;
            }

            // Высоты для вершин обводки (могут отличаться из-за отсутствия дедупликации)
            const outerRing = this._rings[0];
            this._cachedStrokeHeights = new Array(outerRing.length);
            for (let i = 0; i < outerRing.length; i++) {
                const [lon, lat] = outerRing[i];
                const [absX, absZ] = proj.fromLonLat([lon, lat]);
                let y = this._altitudeOffset;
                if (this._altitudeMode === 'clampToGround') {
                    const worldX = absX + wgPos.x;
                    const worldZ = absZ + wgPos.z;
                    map.ensureTileForPoint?.(worldX, worldZ);
                    y = map.getSurfaceHeightAt(worldX, worldZ) + this._altitudeOffset;
                }
                this._cachedStrokeHeights[i] = y;
            }

            this._lastHeightUpdateTime = now;
        }

        // Применяем высоты к заливке
        const pos = this._fillGeometry.attributes.position.array;
        for (let i = 0; i < this._vertices2D.length; i++) {
            pos[i * 3 + 1] = this._cachedHeights[i];
        }
        this._fillGeometry.attributes.position.needsUpdate = true;
        this._fillGeometry.computeVertexNormals();
    }

    /**
     * Обновляет позиции вершин обводки.
     * @private
     */
    _updateStroke() {
        if (!this._strokeLine || !this._strokeGeometry) return;
        const outerRing = this._rings[0];
        const positions = [];

        for (let i = 0; i < outerRing.length; i++) {
            const [lon, lat] = outerRing[i];
            const [absX, absZ] = proj.fromLonLat([lon, lat]);
            const y = this._cachedStrokeHeights[i] ?? this._altitudeOffset;
            positions.push(absX, y, absZ);
        }

        // Замыкаем обводку
        if (outerRing.length > 0) {
            const [firstLon, firstLat] = outerRing[0];
            const [fx, fz] = proj.fromLonLat([firstLon, firstLat]);
            const fy = this._cachedStrokeHeights[0] ?? this._altitudeOffset;
            positions.push(fx, fy, fz);
        }

        this._strokeGeometry.setPositions(positions);
        this._strokeLine.computeLineDistances();
    }

    /**
     * Пересчитывает экранную позицию центроида полигона (для подписи).
     * @private
     */
    _updateCentroidScreenPos() {
        if (!this._map || !this._centroidLocal) {
            this._centroidScreenPos = null;
            return;
        }
        const wgPos = this._map.worldGroup.position;
        const worldX = this._centroidLocal.x + wgPos.x;
        const worldZ = this._centroidLocal.y + wgPos.z;

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

        const worldPos = new THREE.Vector3(worldX, worldY + wgPos.y, worldZ);
        const screenPos = worldPos.clone().project(this._map.camera);
        if (screenPos.z > 1 || Math.abs(screenPos.x) > 1 || Math.abs(screenPos.y) > 1) {
            this._centroidScreenPos = null;
            return;
        }
        const canvas = this._map.renderer.domElement;
        this._centroidScreenPos = {
            x: (screenPos.x * 0.5 + 0.5) * canvas.clientWidth,
            y: (-screenPos.y * 0.5 + 0.5) * canvas.clientHeight
        };
    }

    // ---------- Интерфейс для TextManager ----------

    /** @returns {string} Текст подписи */
    getText() { return this._title; }

    /** @returns {Object} Объект CSS-стилей подписи */
    getTextStyle() {
        return Object.assign({
            fontFamily: 'sans-serif',
            color: '#333',
            fontSize: '12px',
            textAlign: this._titleAlign
        }, this._titleStyle);
    }

    /** @returns {{min: number, max: number}} Границы зума для отображения подписи */
    getTextZoomBounds() { return { min: this._titleMinZoom, max: this._titleMaxZoom }; }

    /** @returns {string} Тип подписи ('polygon') */
    getLabelType() { return 'polygon'; }

    /** @returns {boolean} Видим ли полигон в текущем кадре */
    isVisible() { return this._group?.visible ?? false; }

    /** @returns {{x: number, y: number}|null} Экранная позиция центроида (или null) */
    getScreenPosition() { return this._centroidScreenPos; }

    /** @returns {string} Горизонтальное выравнивание подписи */
    getTitleAlign() { return this._titleAlign; }

    /** @returns {[number, number]} Смещение подписи в пикселях */
    getTitleOffset() { return this._titleOffset; }

    /** @returns {string} Вертикальное выравнивание (всегда 'center') */
    getTitleVerticalAlign() { return 'center'; }

    /** @returns {boolean} Разрешён ли выход подписи за границы */
    getAllowOverflow() { return this._titleAllowOverflow; }

    /** @returns {number} Приоритет подписи */
    getPriority() { return this._titlePriority; }
}