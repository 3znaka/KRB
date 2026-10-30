// @ts-nocheck
/**
 * Модуль для рисования полилиний на карте.
 * Предоставляет класс {@link Polyline}, использующий "толстые" линии
 * из three.js (Line2/LineMaterial/LineGeometry) с поддержкой высот
 * (в т.ч. третьей координаты каждой вершины), видимости по зуму и
 * подписей через TextManager.
 *
 * @module polyline
 */

import { Projections } from './Projections.js';
import {
  THREE,
  Line2,
  LineMaterial,
  LineGeometry,
} from './js_TP/tpb.js';
import { Layer } from './Layers.js';

/**
 * Минимальное расстояние от точки до отрезка.
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
 * Полилиния на карте. Каждая точка может задаваться как `[x, y]` или
 * `[x, y, height]`. Третья координата (world-метры) суммируется с
 * `altitudeOffset`, а при `altitudeMode: 'clampToGround'` — ещё и с
 * высотой рельефа в этой точке. Знак третьей координаты учитывается
 * (отрицательные значения опускают узел ниже поверхности).
 *
 * @example
 * const line = new Polyline({
 *   positions: [[30.5, 50.4, 50], [31.0, 50.5, 120]],
 *   color: '#ff0000',
 *   altitudeMode: 'clampToGround',
 *   altitudeOffset: 10,
 *   title: 'Моя линия'
 * }).addTo(map);
 */
export class Polyline {
    /**
     * @param {Object} options
     * @param {Array<[number, number]|[number, number, number]>} options.positions -
     *     Минимум 2 точки `[x, y]` или `[x, y, height]` в СК `options.crs`.
     *     `height` (world-метры) — дополнительная высота узла.
     * @param {string} [options.crs] - Код СК точек (по умолчанию `map.inputCRS`).
     * @param {string} [options.color='#3388ff']
     * @param {number} [options.opacity=1]
     * @param {number} [options.width=2]
     * @param {'clampToGround'|'absolute'} [options.altitudeMode='clampToGround']
     * @param {number} [options.altitudeOffset=10] - Смещение над поверхностью
     *     (или над 0 в режиме `absolute`). Суммируется с `height` узла.
     * @param {number} [options.minZoom=-Infinity]
     * @param {number} [options.maxZoom=Infinity]
     * @param {boolean} [options.depthTest=false]
     * @param {boolean} [options.depthWrite=false]
     * @param {number} [options.heightUpdateInterval=500]
     * @param {string} [options.title='']
     * @param {[number, number]} [options.titleOffset=[0,0]]
     * @param {'left'|'center'|'right'} [options.titleAlign='center']
     * @param {Object} [options.titleStyle={}]
     * @param {number} [options.titleMinZoom=-Infinity]
     * @param {number} [options.titleMaxZoom=Infinity]
     * @param {'center'|'along'} [options.titlePlacement='center']
     * @param {'top'|'middle'|'bottom'} [options.titleVerticalAlign='center']
     * @param {boolean} [options.titleAllowOverflow=false]
     * @param {number} [options.titlePriority=0]
     * @throws {Error} Если `positions` отсутствует или содержит < 2 точек.
     */
    constructor(options = {}) {
        if (!options.positions?.length || options.positions.length < 2) {
            throw new Error('Polyline: options.positions required, at least 2 points');
        }

        /** @private */ this._positions = options.positions;
        /** @private @type {string|null} */ this._crsCode = options.crs ?? null;
        /** @private */ this._crs = null;

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
        /** @private @type {number[]} */ this._nodeHeights = [];
        /** @private */ this._cachedHeights = null;

        /** @private */ this._title = options.title || '';
        /** @private */ this._titleOffset = options.titleOffset || [0, 0];
        /** @private */ this._titleAlign = options.titleAlign || 'center';
        /** @private */ this._titleStyle = options.titleStyle || {};
        /** @private */ this._titleMinZoom = options.titleMinZoom ?? -Infinity;
        /** @private */ this._titleMaxZoom = options.titleMaxZoom ?? Infinity;
        /** @private */ this._titlePlacement = options.titlePlacement || 'center';
        /** @private */ this._titleVerticalAlign = options.titleVerticalAlign || 'center';

        /** @private */ this._labelT = 0.5;
        /** @private */ this._labelObj = null;

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
     * Создаёт персональный слой, добавляет его на карту и помещает
     * в него эту полилинию.
     *
     * @param {Object} map
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
     * @private
     */
    _attach(map, layer) {
        if (this._map === map && this._layer === layer) return;
        this.remove();
        this._map = map;
        this._layer = layer;

        this._crs = this._crsCode
            ? Projections.get(this._crsCode)
            : map.inputCRS;

        // Проекция горизонтальных координат + извлечение высоты узла
        // (третьей координаты). Отсутствующая/невалидная — считается 0.
        this._absPositions = [];
        this._nodeHeights = [];
        for (let i = 0; i < this._positions.length; i++) {
            const pt = this._positions[i];
            this._absPositions.push(map.project(pt, this._crs));
            const h = pt?.[2];
            this._nodeHeights.push(Number.isFinite(h) ? h : 0);
        }
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

        if (this._title && map.textManager) {
            this._labelObj = map.textManager.addLabel(this);
        }
    }

    /**
     * Удаляет полилинию с карты и освобождает ресурсы.
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
        this._crs = null;
        this._screenData.valid = false;
    }

    /**
     * Обновление состояния линии на кадре.
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

        if (this._line.parent !== this._map.worldGroup) {
            this._line.parent?.remove(this._line);
            this._map.worldGroup.add(this._line);
        }

        const canvas = this._map.renderer.domElement;
        const res = this._material.resolution;
        if (res.x !== canvas.width || res.y !== canvas.height) {
            this._material.resolution.set(canvas.width, canvas.height);
        }

        this._updateHeights();

        if (map.objectRenderDistanceFactor > 0 && this._absPositions.length >= 2) {
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

        this._applyPositions();

        if (this._title) {
            this._computeScreenData();
        }
    }

    /**
     * Обновляет кэш высот для всех вершин.
     *
     * Формула высоты узла:
     *   y = clampToGround ? surface(x, z) + altitudeOffset + nodeHeight
     *                     : altitudeOffset + nodeHeight
     *
     * @private
     */
    _updateHeights() {
        if (!this._map) return;
        const now = performance.now();
        if (now - this._lastHeightUpdateTime < this._heightUpdateInterval && this._cachedHeights) return;

        const wgPos = this._map.worldGroup.position;
        const heights = new Array(this._absPositions.length);
        const clamp = this._altitudeMode === 'clampToGround';

        for (let i = 0; i < this._absPositions.length; i++) {
            const [absX, absZ] = this._absPositions[i];
            const nodeH = this._nodeHeights[i] ?? 0;
            let y;
            if (clamp) {
                const worldX = absX + wgPos.x;
                const worldZ = absZ + wgPos.z;
                y = this._map.getSurfaceHeightAt(worldX, worldZ) + this._altitudeOffset + nodeH;
            } else {
                y = this._altitudeOffset + nodeH;
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
     *  Экранные данные для подписи
     * ================================================================= */

    /** @private */
    _computeScreenData() {
        const map = this._map;
        if (!map) { this._screenData.valid = false; return; }

        const wgPos = map.worldGroup.position;
        const camera = map.camera;
        const pts = this._absPositions;
        if (pts.length < 2) { this._screenData.valid = false; return; }

        const points3D = pts.map(([ax, az], i) => {
            let y = this._altitudeOffset + (this._nodeHeights[i] ?? 0);
            if (this._cachedHeights) y = this._cachedHeights[i];
            return new THREE.Vector3(ax + wgPos.x, y + wgPos.y, az + wgPos.z);
        });

        const segLengths = [];
        let totalLen = 0;
        for (let i = 0; i < points3D.length - 1; i++) {
            const d = points3D[i].distanceTo(points3D[i + 1]);
            segLengths.push(d);
            totalLen += d;
        }
        if (totalLen < 1e-9) { this._screenData.valid = false; return; }

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

        if (this._labelT < best.min || this._labelT > best.max) {
            this._labelT = (best.min + best.max) / 2;
        }
    }

    /* =================================================================
     *  Интерфейс для TextManager
     * ================================================================= */

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
    getLabelType() { return 'line'; }
    isVisible() { return this._line?.visible ?? false; }
    getVisibleInterval() { return this._screenData.valid ? this._screenData.visibleInterval : null; }
    getAllowOverflow() { return this._titleAllowOverflow; }
    getPriority() { return this._titlePriority; }

    /** @returns {{x:number,y:number}|null} */
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

    /** @returns {number} */
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
        let angle = Math.atan2(y2 - y1, x2 - x1) * 180 / Math.PI;
        if (angle > 90) angle -= 180;
        else if (angle < -90) angle += 180;
        return angle;
    }

    /** @private */
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

    getLabelParameter() { return this._labelT; }

    setLabelParameter(t) {
        const iv = this.getVisibleInterval();
        if (iv) {
            this._labelT = Math.max(iv.min, Math.min(iv.max, t));
        } else {
            this._labelT = t;
        }
    }

    getPlacement() { return this._titlePlacement; }
    getTitleAlign() { return this._titleAlign; }
    getTitleVerticalAlign() { return this._titleVerticalAlign || 'center'; }
    getTitleOffset() { return this._titleOffset; }

    /* =================================================================
     *  getBounds
     * ================================================================= */

    /**
     * Bounding box по всем точкам полилинии (только x/y).
     *
     * @param {string|Object} [crs='EPSG:4326']
     * @returns {Array<Array<number>>|null} [[minX, minY], [maxX, maxY]] или null.
     */
    getBounds(crs = 'EPSG:4326') {
        if (!this._positions || !this._positions.length) return null;

        const src = this._crs
            ?? (this._crsCode ? Projections.get(this._crsCode) : Projections.get('EPSG:4326'));
        const dst = typeof crs === 'string' ? Projections.get(crs) : crs;
        if (!src || !dst) return null;

        const sameProjection = src === dst;
        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
        let count = 0;

        for (let i = 0; i < this._positions.length; i++) {
            const pt = this._positions[i];
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
        if (count === 0 || !isFinite(minX)) return null;
        return [[minX, minY], [maxX, maxY]];
    }
}