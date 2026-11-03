/**
 * Polyline — полилиния с толстой линией (Line2), высотами узлов,
 * видимостью по зуму и подписью. После addTo() мутабелен:
 * цвет / толщина / прозрачность / видимость / текст / вершины
 * меняются без пересоздания объекта.
 *
 * @module polyline
 */

import { Projections } from './Projections.js';
import { THREE, Line2, LineMaterial, LineGeometry } from './js_TP/tpb.js';
import { Layer } from './Layers.js';

// =====================================================================
// Типы
// =====================================================================

export type LonLat = [number, number];
export type PolylinePosition = [number, number] | [number, number, number];
export type PolylineTitleAlignH = 'left' | 'center' | 'right';
export type PolylineTitleAlignV = 'top' | 'middle' | 'center' | 'bottom';
export type PolylineTitlePlacement = 'center' | 'along';
export type PolylineAltitudeMode = 'clampToGround' | 'absolute';

export interface PolylineOptions {
    positions: PolylinePosition[];
    crs?: string;
    color?: string | number;
    opacity?: number;
    width?: number;
    altitudeMode?: PolylineAltitudeMode;
    altitudeOffset?: number;
    minZoom?: number;
    maxZoom?: number;
    depthTest?: boolean;
    depthWrite?: boolean;
    heightUpdateInterval?: number;
    title?: string;
    titleOffset?: [number, number];
    titleAlign?: PolylineTitleAlignH;
    titleStyle?: Record<string, string | number>;
    titleMinZoom?: number;
    titleMaxZoom?: number;
    titlePlacement?: PolylineTitlePlacement;
    titleVerticalAlign?: PolylineTitleAlignV;
    titleAllowOverflow?: boolean;
    titlePriority?: number;
}

function pointToSegmentDistance(point: any, a: any, b: any): number {
    const ab = new THREE.Vector3().subVectors(b, a);
    const ap = new THREE.Vector3().subVectors(point, a);
    const abLenSq = ab.lengthSq();
    if (abLenSq === 0) return point.distanceTo(a);
    let t = ap.dot(ab) / abLenSq;
    t = Math.max(0, Math.min(1, t));
    const closest = new THREE.Vector3().copy(a).addScaledVector(ab, t);
    return point.distanceTo(closest);
}

// =====================================================================
// Polyline
// =====================================================================

export class Polyline {
    // ── Данные ──
    private _positions: PolylinePosition[];
    private _crsCode: string | null;
    private _crs: any | null;

    // ── Оформление ──
    private _color: string | number;
    private _opacity: number;
    private _width: number;
    private _altitudeMode: PolylineAltitudeMode;
    private _altitudeOffset: number;
    private _minZoom: number;
    private _maxZoom: number;
    private _depthTest: boolean;
    private _depthWrite: boolean;

    // ── Высоты ──
    private _heightUpdateInterval: number;
    private _lastHeightUpdateTime = 0;
    private _absPositions: Array<[number, number]> = [];
    private _nodeHeights: number[] = [];
    private _cachedHeights: number[] | null = null;

    // ── Подпись ──
    private _title: string;
    private _titleOffset: [number, number];
    private _titleAlign: PolylineTitleAlignH;
    private _titleStyle: Record<string, string | number>;
    private _titleMinZoom: number;
    private _titleMaxZoom: number;
    private _titlePlacement: PolylineTitlePlacement;
    private _titleVerticalAlign: PolylineTitleAlignV;
    private _titleAllowOverflow: boolean;
    private _titlePriority: number;

    private _labelT = 0.5;
    private _labelObj: any = null;

    private _screenData: {
        points3D: any[] | null;
        segLengths: number[] | null;
        totalLen: number;
        visibleInterval: { min: number; max: number } | null;
        camera: any;
        map: any;
        valid: boolean;
    } = {
        points3D: null,
        segLengths: null,
        totalLen: 0,
        visibleInterval: null,
        camera: null,
        map: null,
        valid: false,
    };

    // ── Присоединение ──
    private _map: any = null;
    private _layer: Layer | null = null;
    private _line: any = null;
    private _material: any = null;
    private _geometry: any = null;

    // ── NEW: пользовательская видимость ──
    private _userVisible = true;

    constructor(options: PolylineOptions) {
        if (!options.positions?.length || options.positions.length < 2) {
            throw new Error('Polyline: options.positions required, at least 2 points');
        }

        this._positions = options.positions;
        this._crsCode = options.crs ?? null;
        this._crs = null;

        this._color = options.color ?? '#3388ff';
        this._opacity = options.opacity ?? 1;
        this._width = options.width || 2;
        this._altitudeMode = options.altitudeMode ?? 'clampToGround';
        this._altitudeOffset = options.altitudeOffset ?? 10;
        this._minZoom = options.minZoom ?? -Infinity;
        this._maxZoom = options.maxZoom ?? Infinity;
        this._depthTest = options.depthTest ?? false;
        this._depthWrite = options.depthWrite ?? false;

        this._heightUpdateInterval = options.heightUpdateInterval ?? 500;

        this._title = options.title ?? '';
        this._titleOffset = options.titleOffset ?? [0, 0];
        this._titleAlign = options.titleAlign ?? 'center';
        this._titleStyle = options.titleStyle ?? {};
        this._titleMinZoom = options.titleMinZoom ?? -Infinity;
        this._titleMaxZoom = options.titleMaxZoom ?? Infinity;
        this._titlePlacement = options.titlePlacement ?? 'center';
        this._titleVerticalAlign = options.titleVerticalAlign ?? 'center';

        this._titleAllowOverflow = options.titleAllowOverflow ?? false;
        this._titlePriority = options.titlePriority ?? 0;
    }

    // =================================================================
    // Присоединение / отсоединение
    // =================================================================

    addTo(map: any): this {
        if (this._map) this.remove();
        const personalLayer = new Layer();
        personalLayer.addTo(map);
        (personalLayer as any).add(this);
        return this;
    }

    _attach(map: any, layer: Layer): void {
        if (this._map === map && this._layer === layer) return;
        this.remove();
        this._map = map;
        this._layer = layer;

        this._crs = this._crsCode
            ? Projections.get(this._crsCode)
            : map.inputCRS;

        this._absPositions = [];
        this._nodeHeights = [];
        for (let i = 0; i < this._positions.length; i++) {
            const pt = this._positions[i];
            this._absPositions.push(map.project(pt, this._crs));
            const h = pt?.[2];
            this._nodeHeights.push(Number.isFinite(h) ? (h as number) : 0);
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
            resolution: new THREE.Vector2(canvas.width, canvas.height),
        });
        this._line = new Line2(this._geometry, this._material);
        this._line.renderOrder = 999;
        map.worldGroup.add(this._line);

        if (this._title && map.textManager) {
            this._labelObj = map.textManager.addLabel(this);
        }
    }

    remove(): void {
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

    // =================================================================
    // Мутабельность
    // =================================================================

    /** Меняет цвет линии (O(1), без перестройки геометрии). */
    setColor(color: string | number): this {
        this._color = color;
        if (this._material?.color) this._material.color.set(color as any);
        return this;
    }

    /** Меняет толщину линии в пикселях. */
    setWidth(width: number): this {
        if (!(width > 0)) return this;
        this._width = width;
        if (this._material) {
            this._material.linewidth = width;
            this._material.needsUpdate = true;
        }
        return this;
    }

    /** Меняет прозрачность (0..1). */
    setOpacity(opacity: number): this {
        const v = Math.max(0, Math.min(1, opacity));
        this._opacity = v;
        if (this._material) {
            this._material.opacity = v;
            const transparent = v < 1;
            if (this._material.transparent !== transparent) {
                this._material.transparent = transparent;
                this._material.needsUpdate = true;
            }
        }
        return this;
    }

    /** Управляет видимостью (перекрывает зум-ограничения и видимость слоя). */
    setVisible(visible: boolean): this {
        this._userVisible = !!visible;
        if (!this._line) return this;
        if (!this._userVisible) {
            this._line.visible = false;
            this._screenData.valid = false;
        }
        return this;
    }

    /** Меняет текст подписи (или убирает, если пусто). */
    setTitle(text: string): this {
        this._title = text ?? '';
        const tm = this._map?.textManager;
        if (!tm) return this;

        if (this._labelObj) {
            if (typeof tm.updateLabel === 'function') {
                tm.updateLabel(this._labelObj);
            } else {
                tm.removeLabel(this._labelObj);
                this._labelObj = null;
                if (this._title) this._labelObj = tm.addLabel(this);
            }
        } else if (this._title) {
            this._labelObj = tm.addLabel(this);
        }
        return this;
    }

    /**
     * Заменяет вершины. Пересчитывает `_absPositions` (если линия уже
     * на карте). Геометрия пересоберётся на следующем кадре через
     * `_update` → `_applyPositions`.
     */
    setPositions(positions: PolylinePosition[]): this {
        if (!positions || positions.length < 2) return this;
        this._positions = positions;
        this._screenData.valid = false;

        if (!this._map) return this;

        this._absPositions = [];
        this._nodeHeights = [];
        for (let i = 0; i < positions.length; i++) {
            const pt = positions[i];
            this._absPositions.push(this._map.project(pt, this._crs));
            const h = pt?.[2];
            this._nodeHeights.push(Number.isFinite(h) ? (h as number) : 0);
        }
        this._cachedHeights = null;
        this._lastHeightUpdateTime = 0;   // force recompute
        return this;
    }

    /** Возвращает копию исходных координат (в `crs` полилинии). */
    getPositions(): PolylinePosition[] {
        return this._positions.map(p => [...p] as PolylinePosition);
    }

    /** Центр bbox в WGS84: `[lon, lat]`, либо `null`. */
    getCenter(): LonLat | null {
        const b = this.getBounds('EPSG:4326');
        if (!b) return null;
        return [
            (b[0][0] + b[1][0]) / 2,
            (b[0][1] + b[1][1]) / 2,
        ];
    }

    // =================================================================
    // Обновление на кадре
    // =================================================================

    _update(map: any): void {
        if (!this._map || !this._line) return;
        const zoom = this._map.continuousZoom;

        const visible =
            this._userVisible &&
            (this._layer ? (this._layer as any).visible : true) &&
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

    private _updateHeights(): void {
        if (!this._map) return;
        const now = performance.now();
        if (now - this._lastHeightUpdateTime < this._heightUpdateInterval && this._cachedHeights) return;

        const wgPos = this._map.worldGroup.position;
        const heights = new Array(this._absPositions.length);
        const clamp = this._altitudeMode === 'clampToGround';

        for (let i = 0; i < this._absPositions.length; i++) {
            const [absX, absZ] = this._absPositions[i];
            const nodeH = this._nodeHeights[i] ?? 0;
            let y: number;
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

    private _applyPositions(): void {
        if (!this._map || !this._cachedHeights) return;
        const arr: number[] = [];
        for (let i = 0; i < this._absPositions.length; i++) {
            const [absX, absZ] = this._absPositions[i];
            arr.push(absX, this._cachedHeights[i], absZ);
        }
        this._geometry.setPositions(arr);
        this._line.computeLineDistances();
    }

    // =================================================================
    // Экранные данные для подписи
    // =================================================================

    private _computeScreenData(): void {
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

        const segLengths: number[] = [];
        let totalLen = 0;
        for (let i = 0; i < points3D.length - 1; i++) {
            const d = points3D[i].distanceTo(points3D[i + 1]);
            segLengths.push(d);
            totalLen += d;
        }
        if (totalLen < 1e-9) { this._screenData.valid = false; return; }

        const pointAtT = (t: number) => {
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
        const visibleTs: number[] = [];
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

        const segments: Array<{ min: number; max: number }> = [];
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
            valid: true,
        };

        if (this._labelT < best.min || this._labelT > best.max) {
            this._labelT = (best.min + best.max) / 2;
        }
    }

    // =================================================================
    // TextManager contract
    // =================================================================

    getText(): string { return this._title; }

    getTextStyle(): Record<string, string | number> {
        return Object.assign({
            fontFamily: 'sans-serif',
            color: '#333',
            fontSize: '12px',
            textAlign: this._titleAlign,
        }, this._titleStyle);
    }

    getTextZoomBounds(): { min: number; max: number } {
        return { min: this._titleMinZoom, max: this._titleMaxZoom };
    }

    getLabelType(): 'line' { return 'line'; }

    isVisible(): boolean { return this._line?.visible ?? false; }

    getVisibleInterval(): { min: number; max: number } | null {
        return this._screenData.valid ? this._screenData.visibleInterval : null;
    }

    getAllowOverflow(): boolean { return this._titleAllowOverflow; }

    getPriority(): number { return this._titlePriority; }

    getScreenPositionAt(t: number): { x: number; y: number } | null {
        const data = this._screenData;
        if (!data.valid || !data.map) return null;

        const totalLen = data.totalLen;
        const target = t * totalLen;
        let acc = 0;
        let pt3D: any = null;
        const segLengths = data.segLengths!;
        const points3D = data.points3D!;
        for (let i = 0; i < segLengths.length; i++) {
            if (target <= acc + segLengths[i]) {
                const local = (target - acc) / segLengths[i];
                pt3D = new THREE.Vector3().lerpVectors(points3D[i], points3D[i + 1], local);
                break;
            }
            acc += segLengths[i];
        }
        if (!pt3D) pt3D = points3D[points3D.length - 1].clone();

        const scr = pt3D.clone().project(data.camera);
        if (scr.z <= 0 || scr.z >= 1) return null;
        const canvas = data.map.renderer.domElement;
        return {
            x: (scr.x * 0.5 + 0.5) * canvas.clientWidth,
            y: (-scr.y * 0.5 + 0.5) * canvas.clientHeight,
        };
    }

    getScreenAngleAt(t: number): number {
        if (this._titlePlacement !== 'along') return 0;
        const data = this._screenData;
        if (!data.valid) return 0;

        const segIdx = this._getSegmentIndex(t);
        const points3D = data.points3D!;
        if (segIdx < 0 || segIdx >= points3D.length - 1) return 0;

        const p1 = points3D[segIdx];
        const p2 = points3D[segIdx + 1];
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

    private _getSegmentIndex(t: number): number {
        const data = this._screenData;
        if (!data.valid) return -1;
        const target = t * data.totalLen;
        let acc = 0;
        const segLengths = data.segLengths!;
        for (let i = 0; i < segLengths.length; i++) {
            if (target <= acc + segLengths[i] + 1e-9) return i;
            acc += segLengths[i];
        }
        return segLengths.length - 1;
    }

    getLabelParameter(): number { return this._labelT; }

    setLabelParameter(t: number): void {
        const iv = this.getVisibleInterval();
        if (iv) {
            this._labelT = Math.max(iv.min, Math.min(iv.max, t));
        } else {
            this._labelT = t;
        }
    }

    getPlacement(): PolylineTitlePlacement { return this._titlePlacement; }

    getTitleAlign(): PolylineTitleAlignH { return this._titleAlign; }

    getTitleVerticalAlign(): PolylineTitleAlignV {
        return this._titleVerticalAlign || 'center';
    }

    getTitleOffset(): [number, number] { return this._titleOffset; }

    // =================================================================
    // KrbMap#fitTo / getBounds
    // =================================================================

    getBounds(crs: string | any = 'EPSG:4326'): [LonLat, LonLat] | null {
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
            let x: number, y: number;
            if (sameProjection) {
                x = pt[0];
                y = pt[1];
            } else {
                const lonLat = src.toLonLat(pt);
                const conv = dst.fromLonLat(lonLat);
                x = conv[0];
                y = conv[1];
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