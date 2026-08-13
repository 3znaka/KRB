/**
 * Модуль для рисования полилиний на карте.
 * Предоставляет класс {@link Polyline}, использующий "толстые" линии
 * из библиотеки three.js (Line2/LineMaterial/LineGeometry) с поддержкой
 * высот, видимости по зуму и подписей через TextManager.
 *
 * @module polyline
 */

import { proj } from './Utils.js';
import {
  THREE,
  Line2,
  LineMaterial,
  LineGeometry,
} from '../js_TP/tpb.js';  
import { Layer } from './Layers.js';


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
    if (abLenSq === 0) return point.distanceTo(a); // отрезок вырожден

    let t = ap.dot(ab) / abLenSq;
    t = Math.max(0, Math.min(1, t));
    const closest = new THREE.Vector3().copy(a).addScaledVector(ab, t);
    return point.distanceTo(closest);
}

/**
 * Класс, представляющий полилинию на карте.
 * Поддерживает настройку цвета, толщины, прозрачности, режима высоты,
 * ограничения по зуму и текстовую подпись.
 *
 * @example
 * const line = new Polyline({
 *   positions: [[30.5, 50.4], [31.0, 50.5]],
 *   color: '#ff0000',
 *   width: 3
 * });
 * line.addTo(map);
 */
export class Polyline {
    /**
     * @param {Object} options - Настройки полилинии.
     * @param {[number, number][]} options.positions - Массив точек [долгота, широта] (минимум 2).
     * @param {string} [options.color='#3388ff'] - Цвет линии (CSS).
     * @param {number} [options.opacity=1] - Прозрачность (0..1).
     * @param {number} [options.width=2] - Толщина линии в пикселях (поддерживается LineMaterial).
     * @param {string} [options.altitudeMode='clampToGround'] - Режим высоты: 'clampToGround' (прилегать к рельефу) или 'absolute' (постоянная высота).
     * @param {number} [options.altitudeOffset=10] - Добавочная высота над поверхностью/уровнем земли.
     * @param {number} [options.minZoom=-Infinity] - Минимальный зум, при котором линия видна.
     * @param {number} [options.maxZoom=Infinity] - Максимальный зум, при котором линия видна.
     * @param {boolean} [options.depthTest=false] - Включить тест глубины для линии.
     * @param {boolean} [options.depthWrite=false] - Включить запись в буфер глубины.
     * @param {number} [options.heightUpdateInterval=500] - Интервал обновления высот (мс).
     * @param {string} [options.title=''] - Текст постоянной подписи.
     * @param {[number, number]} [options.titleOffset=[0,0]] - Смещение подписи в пикселях.
     * @param {string} [options.titleAlign='center'] - Горизонтальное выравнивание подписи ('left', 'center', 'right').
     * @param {Object} [options.titleStyle={}] - CSS-стили подписи.
     * @param {number} [options.titleMinZoom=-Infinity] - Минимальный зум для отображения подписи.
     * @param {number} [options.titleMaxZoom=Infinity] - Максимальный зум для отображения подписи.
     * @param {string} [options.titlePlacement='center'] - Размещение подписи: 'center' (центр линии) или 'along' (вдоль линии с возможностью перемещения).
     * @param {string} [options.titleVerticalAlign='center'] - Вертикальное выравнивание подписи.
     * @param {boolean} [options.titleAllowOverflow=false] - Разрешить выход подписи за границы экрана.
     * @param {number} [options.titlePriority=0] - Приоритет подписи (чем выше, тем приоритетнее).
     */
    constructor(options = {}) {
        if (!options.positions?.length || options.positions.length < 2) {
            throw new Error('Polyline: options.positions required, at least 2 points');
        }
        /** @private */ this._positions = options.positions;
        /** @private */ this._color = options.color || '#3388ff';
        /** @private */ this._opacity = options.opacity ?? 1;
        /** @private */ this._width = options.width || 2;
        /** @private */ this._altitudeMode = options.altitudeMode || 'clampToGround';
        /** @private */ this._altitudeOffset = options.altitudeOffset ?? 10;
        /** @private */ this._minZoom = options.minZoom ?? -Infinity;
        /** @private */ this._maxZoom = options.maxZoom ?? Infinity;
        /** @private */ this._depthTest = options.depthTest ?? false;
        /** @private */ this._depthWrite = options.depthWrite ?? false;

        /** @private */ this._heightUpdateInterval = options.heightUpdateInterval ?? 500;
        /** @private */ this._lastHeightUpdateTime = 0;
        /** @private */ this._absPositions = [];
        /** @private */ this._cachedHeights = null;

        // Подпись
        /** @private */ this._title = options.title || '';
        /** @private */ this._titleOffset = options.titleOffset || [0, 0];
        /** @private */ this._titleAlign = options.titleAlign || 'center';
        /** @private */ this._titleStyle = options.titleStyle || {};
        /** @private */ this._titleMinZoom = options.titleMinZoom ?? -Infinity;
        /** @private */ this._titleMaxZoom = options.titleMaxZoom ?? Infinity;
        /** @private */ this._titlePlacement = options.titlePlacement || 'center';
        /** @private */ this._titleVerticalAlign = options.titleVerticalAlign || 'center';

        /** @private */ this._labelT = 0.5;         // текущий параметр t подписи
        /** @private */ this._labelObj = null;       // дескриптор TextManager

        /** @private */ this._screenData = {
            points3D: null,
            segLengths: null,
            totalLen: 0,
            visibleInterval: null,
            camera: null,
            map: null,
            valid: false
        };

        /** @private */ this._map = null;
        /** @private */ this._layer = null;
        /** @private */ this._line = null;
        /** @private */ this._material = null;
        /** @private */ this._geometry = null;
        
        /** @private */ this._titleAllowOverflow = options.titleAllowOverflow || false;
        /** @private */ this._titlePriority = options.titlePriority ?? 0;
    }

    /**
     * Удобный метод: создаёт персональный слой, добавляет его на карту
     * и помещает в него данную полилинию.
     *
     * @param {Object} map - Экземпляр карты.
     * @returns {Polyline} this
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
     * Создаёт геометрию, материал и линию, добавляет в сцену.
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

        // Преобразование координат в мировую проекцию Меркатора
        this._absPositions = this._positions.map(([lon, lat]) => proj.fromLonLat([lon, lat]));
        this._cachedHeights = null;

        this._geometry = new LineGeometry();
        const canvas = map.renderer.domElement;
        this._material = new LineMaterial({
            color: this._color,
            linewidth: this._width,
            opacity: this._opacity,
            transparent: this._opacity < 1,
            depthTest: this._depthTest,
            depthWrite: this._depthWrite,
            resolution: new THREE.Vector2(canvas.width, canvas.height)
        });
        this._line = new Line2(this._geometry, this._material);
        this._line.renderOrder = 999;
        map.worldGroup.add(this._line);

        // Регистрация подписи в TextManager
        if (this._title && map.textManager) {
            this._labelObj = map.textManager.addLabel(this);
        }
    }

    /**
     * Удаляет полилинию с карты, освобождает ресурсы и удаляет подпись.
     */
    remove() {
        if (this._line) {
            this._line.parent?.remove(this._line);
            this._geometry?.dispose();
            this._material?.dispose();
            this._line = null;
            this._geometry = null;
            this._material = null;
        }
        if (this._labelObj && this._map?.textManager) {
            this._map.textManager.removeLabel(this._labelObj);
            this._labelObj = null;
        }
        this._layer?._removeRef(this);
        this._layer = null;
        this._map = null;
        this._screenData.valid = false;
    }

    /**
     * Обновляет состояние линии на каждом кадре:
     * видимость по зуму и слою, высоты, разрешение материала, позиции вершин,
     * а также экранные данные для подписи.
     *
     * @param {Object} map - Экземпляр карты.
     * @private
     */
    _update(map) {
        if (!this._map || !this._line) return;
        const zoom = this._map.continuousZoom;

        const visible = (this._layer ? this._layer.visible : true) &&
                        zoom >= this._minZoom && zoom <= this._maxZoom;
        this._line.visible = visible;
        if (!visible) {
            this._screenData.valid = false;
            return;
        }

        // Убедимся, что линия в правильной группе
        if (this._line.parent !== this._map.worldGroup) {
            this._line.parent?.remove(this._line);
            this._map.worldGroup.add(this._line);
        }

        // Актуализация разрешения материала под размер канваса
        const canvas = this._map.renderer.domElement;
        const res = this._material.resolution;
        if (res.x !== canvas.width || res.y !== canvas.height) {
            this._material.resolution.set(canvas.width, canvas.height);
        }

        // Обновление высот (с учётом рельефа)
        this._updateHeights();

        // Проверка дальности отрисовки
        if (map.view.objectDistanceFactor > 0 && this._absPositions.length >= 2) {
            const wgPos = map.worldGroup.position;
            const points3D = this._absPositions.map(([ax, az], i) => {
                const height = this._cachedHeights?.[i] ?? this._altitudeOffset;
                return new THREE.Vector3(ax + wgPos.x, height + wgPos.y, az + wgPos.z);
            });

            let minDist = Infinity;
            for (let i = 0; i < points3D.length - 1; i++) {
                const dist = pointToSegmentDistance(map.camera.position, points3D[i], points3D[i + 1]);
                if (dist < minDist) minDist = dist;
            }

            if (minDist > map.maxObjectDistance) {
                this._line.visible = false;
                this._screenData.valid = false;
                return;
            }
        }

        // Применяем позиции к геометрии
        this._applyPositions();

        // Пересчёт экранных данных для подписи (если есть)
        if (this._title) {
            this._computeScreenData();
        }
    }

    /**
     * Обновляет кэшированные высоты для всех вершин линии.
     * @private
     */
    _updateHeights() {
        if (!this._map) return;
        const now = performance.now();
        if (now - this._lastHeightUpdateTime < this._heightUpdateInterval && this._cachedHeights) return;

        const wgPos = this._map.worldGroup.position;
        const heights = new Array(this._absPositions.length);
        for (let i = 0; i < this._absPositions.length; i++) {
            const [absX, absZ] = this._absPositions[i];
            let y = this._altitudeOffset;
            if (this._altitudeMode === 'clampToGround') {
                const worldX = absX + wgPos.x;
                const worldZ = absZ + wgPos.z;
                y = this._map.getSurfaceHeightAt(worldX, worldZ) + this._altitudeOffset;
            }
            heights[i] = y;
        }
        this._cachedHeights = heights;
        this._lastHeightUpdateTime = now;
    }

    /**
     * Передаёт позиции вершин в LineGeometry.
     * @private
     */
    _applyPositions() {
        if (!this._map || !this._cachedHeights) return;
        const arr = [];
        for (let i = 0; i < this._absPositions.length; i++) {
            const [absX, absZ] = this._absPositions[i];
            arr.push(absX, this._cachedHeights[i], absZ);
        }
        this._geometry.setPositions(arr);
        this._line.computeLineDistances();
    }

    /* =================================================================
     *  ПОЛНЫЙ РАСЧЁТ ЭКРАННЫХ ДАННЫХ ДЛЯ ПОДПИСИ
     * ================================================================= */

    /**
     * Рассчитывает данные, необходимые для позиционирования подписи:
     * 3D-точки линии, длины сегментов, общую длину, видимый интервал на экране.
     * @private
     */
    _computeScreenData() {
        const map = this._map;
        if (!map) { this._screenData.valid = false; return; }

        const wgPos = map.worldGroup.position;
        const camera = map.camera;
        const pts = this._absPositions;
        if (pts.length < 2) { this._screenData.valid = false; return; }

        // 3D вершины в мировых координатах (с учётом высот)
        const points3D = pts.map(([ax, az], i) => {
            let y = this._altitudeOffset;
            if (this._cachedHeights) y = this._cachedHeights[i];
            return new THREE.Vector3(ax + wgPos.x, y + wgPos.y, az + wgPos.z);
        });

        // Длины сегментов и общая длина
        const segLengths = [];
        let totalLen = 0;
        for (let i = 0; i < points3D.length - 1; i++) {
            const d = points3D[i].distanceTo(points3D[i + 1]);
            segLengths.push(d);
            totalLen += d;
        }
        if (totalLen < 1e-9) { this._screenData.valid = false; return; }

        // Функция получения 3D-точки по параметру t (0..1)
        const pointAtT = (t) => {
            let target = t * totalLen;
            let acc = 0;
            for (let i = 0; i < segLengths.length; i++) {
                if (target <= acc + segLengths[i]) {
                    const local = (target - acc) / segLengths[i];
                    return new THREE.Vector3().lerpVectors(points3D[i], points3D[i + 1], local);
                }
                acc += segLengths[i];
            }
            return points3D[points3D.length - 1].clone();
        };

        // Дискретизация пути и поиск видимых участков (проекция на экран)
        const samples = 200;
        const visibleTs = [];
        for (let i = 0; i < samples; i++) {
            const t = i / (samples - 1);
            const pt = pointAtT(t);
            const scr = pt.clone().project(camera);
            if (scr.z > 0 && scr.z < 1 &&
                scr.x >= -1 && scr.x <= 1 &&
                scr.y >= -1 && scr.y <= 1) {
                visibleTs.push(t);
            }
        }

        if (visibleTs.length === 0) {
            this._screenData.valid = false;
            return;
        }

        // Самый длинный непрерывный видимый интервал
        const segments = [];
        let start = visibleTs[0];
        let prev = start;
        const eps = 1.1 / (samples - 1);
        for (let i = 1; i < visibleTs.length; i++) {
            if (visibleTs[i] - prev > eps) {
                segments.push({ min: start, max: prev });
                start = visibleTs[i];
            }
            prev = visibleTs[i];
        }
        segments.push({ min: start, max: prev });

        let best = segments[0];
        for (const s of segments) {
            if (s.max - s.min > best.max - best.min) best = s;
        }

        this._screenData = {
            points3D,
            segLengths,
            totalLen,
            visibleInterval: best,
            camera: camera.clone(),
            map,
            valid: true
        };

        // Если текущий параметр t вне видимого интервала — центрируем его внутри интервала
        if (this._labelT < best.min || this._labelT > best.max) {
            this._labelT = (best.min + best.max) / 2;
        }
    }

    /* =================================================================
     *  Интерфейс для TextManager
     * ================================================================= */

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

    /** @returns {string} Тип подписи ('line') */
    getLabelType() { return 'line'; }

    /** @returns {boolean} Видима ли линия в текущем кадре */
    isVisible() { return this._line?.visible ?? false; }

    /** @returns {{min: number, max: number}|null} Видимый интервал параметра t */
    getVisibleInterval() {
        return this._screenData.valid ? this._screenData.visibleInterval : null;
    }

    /** @returns {boolean} Разрешён ли выход подписи за границы экрана */
    getAllowOverflow() { return this._titleAllowOverflow; }

    /** @returns {number} Приоритет подписи */
    getPriority() { return this._titlePriority; }

    /**
     * Возвращает экранные координаты для заданного параметра t (0..1).
     * @param {number} t - Параметр вдоль линии.
     * @returns {{x: number, y: number}|null} Позиция в пикселях или null, если не видна.
     */
    getScreenPositionAt(t) {
        const data = this._screenData;
        if (!data.valid || !data.map) return null;

        const totalLen = data.totalLen;
        const target = t * totalLen;
        let acc = 0;
        let pt3D = null;
        for (let i = 0; i < data.segLengths.length; i++) {
            if (target <= acc + data.segLengths[i]) {
                const local = (target - acc) / data.segLengths[i];
                pt3D = new THREE.Vector3().lerpVectors(data.points3D[i], data.points3D[i + 1], local);
                break;
            }
            acc += data.segLengths[i];
        }
        if (!pt3D) pt3D = data.points3D[data.points3D.length - 1].clone();

        const scr = pt3D.clone().project(data.camera);
        if (scr.z <= 0 || scr.z >= 1) return null;
        const canvas = data.map.renderer.domElement;
        return {
            x: (scr.x * 0.5 + 0.5) * canvas.clientWidth,
            y: (-scr.y * 0.5 + 0.5) * canvas.clientHeight
        };
    }

    /**
     * Возвращает угол (в градусах) поворота подписи в заданной точке t.
     * Используется, если размещение подписи 'along'.
     * @param {number} t - Параметр вдоль линии.
     * @returns {number} Угол в градусах.
     */
    getScreenAngleAt(t) {
        if (this._titlePlacement !== 'along') return 0;
        const data = this._screenData;
        if (!data.valid) return 0;

        const segIdx = this._getSegmentIndex(t);
        if (segIdx < 0 || segIdx >= data.points3D.length - 1) return 0;

        const p1 = data.points3D[segIdx];
        const p2 = data.points3D[segIdx + 1];
        const s1 = p1.clone().project(data.camera);
        const s2 = p2.clone().project(data.camera);
        if (s1.z <= 0 || s2.z <= 0) return 0;

        const W = data.map.renderer.domElement.clientWidth;
        const H = data.map.renderer.domElement.clientHeight;
        const x1 = (s1.x * 0.5 + 0.5) * W;
        const y1 = (-s1.y * 0.5 + 0.5) * H;
        const x2 = (s2.x * 0.5 + 0.5) * W;
        const y2 = (-s2.y * 0.5 + 0.5) * H;
        const dx = x2 - x1;
        const dy = y2 - y1;
        let angle = Math.atan2(dy, dx) * 180 / Math.PI;
        // Нормализация угла в диапазон [-90, 90]
        if (angle > 90) angle -= 180;
        else if (angle < -90) angle += 180;
        return angle;
    }

    /**
     * Возвращает индекс сегмента, которому принадлежит параметр t.
     * @param {number} t
     * @returns {number} Индекс сегмента.
     * @private
     */
    _getSegmentIndex(t) {
        const data = this._screenData;
        if (!data.valid) return -1;
        let target = t * data.totalLen;
        let acc = 0;
        for (let i = 0; i < data.segLengths.length; i++) {
            if (target <= acc + data.segLengths[i] + 1e-9) return i;
            acc += data.segLengths[i];
        }
        return data.segLengths.length - 1;
    }

    /** @returns {number} Текущий параметр t подписи. */
    getLabelParameter() { return this._labelT; }

    /**
     * Устанавливает параметр t подписи, ограничивая его видимым интервалом.
     * @param {number} t - Новое значение.
     */
    setLabelParameter(t) {
        const iv = this.getVisibleInterval();
        if (iv) {
            this._labelT = Math.max(iv.min, Math.min(iv.max, t));
        } else {
            this._labelT = t;
        }
    }

    /** @returns {string} Тип размещения подписи. */
    getPlacement() { return this._titlePlacement; }

    /** @returns {string} Горизонтальное выравнивание. */
    getTitleAlign() { return this._titleAlign; }

    /** @returns {string} Вертикальное выравнивание. */
    getTitleVerticalAlign() { return this._titleVerticalAlign || 'center'; }

    /** @returns {[number, number]} Смещение подписи. */
    getTitleOffset() { return this._titleOffset; }
}