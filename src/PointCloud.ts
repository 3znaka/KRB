/**
 * PointCloud — набор точек (в т.ч. одна точка) на карте.
 *
 * Рендерится одним `THREE.Points` + `BufferGeometry`: один draw call на
 * весь набор, независимо от числа точек. Для каждой точки можно задать
 * позицию, цвет, размер и форму. Размер и форма выводятся в шейдере —
 * стандартный `PointsMaterial` умеет только глобальный размер и не умеет
 * форму, поэтому здесь свой `ShaderMaterial`.
 *
 * Наследует SpatialObject: zoom bounds, видимость, tooltip, подпись,
 * altitude и TextManager-контракт — из базового класса.
 *
 * Геометрия смещена относительно локального origin (среднее точек в
 * плоских координатах карты), чтобы Float32 не терял точность на больших
 * мировых координатах. Положение origin в сцене пересчитывается каждый
 * кадр через `projectSurfacePoint`, как у Marker3D.
 *
 * @module PointCloud
 */

import { THREE } from './js_TP/tpb.js';
import { Projections } from './Projections.js';
import { SpatialObject, ZoomInterpolation, SpatialPosition } from './SpatialObject.js';
import { PointCloudLOD } from './PointCloudLOD.js';
import { createPointCountWorker, type PointCountWorker } from './PointCloudWorker.js';

// =====================================================================
// Типы
// =====================================================================

export type PointShape = 'circle' | 'square' | 'diamond' | 'triangle' | 'cross';
export type PointCloudAltitudeMode = 'clampToGround' | 'absolute';
/**
 * shaped — размер, форма и окантовка на каждую точку (ShaderMaterial).
 * simple — только цвет на точку и один размер; стандартный PointsMaterial,
 *          без шейдера. Рассчитан на очень большое число точек.
 */
export type PointCloudMode = 'shaped' | 'simple';
export type PointCloudColor = string | number;

/** Описание одной точки для `addPoint` / `getPoints`. */
export interface PointDatum {
    position: SpatialPosition;
    color?: PointCloudColor;
    /** Размер в пикселях экрана. */
    size?: number;
    shape?: PointShape;
}

export interface PointCloudOptions {
    /** Позиции точек. Минимум одна. */
    positions: SpatialPosition[];
    crs?: string;
    /** Режим отрисовки. По умолчанию 'shaped'. См. PointCloudMode. */
    mode?: PointCloudMode;
    /** Макс. число точек за кадр после прореживания (LOD). По умолчанию 800 000. */
    lodBudget?: number;
    /** Цвет по умолчанию (для точек без персонального). */
    color?: PointCloudColor;
    /** Персональные цвета; длина = числу точек. */
    colors?: PointCloudColor[];
    /** Размер по умолчанию, px. */
    size?: number;
    /** Персональные размеры, px; длина = числу точек. */
    sizes?: number[];
    /** Форма по умолчанию. */
    shape?: PointShape;
    /** Персональные формы; длина = числу точек. */
    shapes?: PointShape[];
    opacity?: number;
    /** Цвет и толщина окантовки (px). Толщина 0 — без окантовки. */
    strokeColor?: PointCloudColor;
    strokeWidth?: number;
    altitudeMode?: PointCloudAltitudeMode;
    altitude?: number;
    minZoom?: number;
    maxZoom?: number;
    depthTest?: boolean;
    depthWrite?: boolean;
    title?: string;
    titleStyle?: Record<string, string | number>;
    titleMinZoom?: number;
    titleMaxZoom?: number;
    titleOffset?: [number, number];
    tooltip?: string;
    onClick?: (event: MouseEvent, cloud: PointCloud) => void;
    onHover?: (hovered: boolean) => void;
    properties?: Record<string, any>;
    userData?: Record<string, any>;
    zoomInterpolate?: ZoomInterpolation | null;
}

export interface PointOptions extends Omit<PointCloudOptions, 'positions' | 'colors' | 'sizes' | 'shapes'> {
    position: SpatialPosition;
    color?: PointCloudColor;
    size?: number;
    shape?: PointShape;
}

// =====================================================================
// Константы и шейдер
// =====================================================================

const SHAPE_CODE: Record<PointShape, number> = {
    circle: 0,
    square: 1,
    diamond: 2,
    triangle: 3,
    cross: 4,
};

const POINT_RENDER_ORDER = 1000;

/**
 * Вершинный шейдер. `size` и `shape` — per-vertex атрибуты.
 * `gl_PointSize` задаёт квадрат, в котором рисуется фигура; фигура
 * вычисляется в фрагментном шейдере по `gl_PointCoord`.
 */
const VERTEX_SHADER = /* glsl */ `
    attribute float size;
    attribute float shape;
    attribute vec3 color;
    uniform float pixelRatio;
    varying vec3 vColor;
    varying float vShape;
    varying float vSize;

    void main() {
        vColor = color;
        vShape = shape;
        vSize = size * pixelRatio;
        vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
        gl_PointSize = vSize;
        gl_Position = projectionMatrix * mvPosition;
    }
`;

/**
 * Фрагментный шейдер.
 *
 * Расстояние d до контура фигуры в координатах [-0.5..0.5] (отрицательно
 * внутри). Заливка — по d <= 0 со сглаживанием на ~1 px. Окантовка —
 * кольцо внутри контура шириной strokeWidth (px), переведённое в
 * координаты фигуры делением на vSize.
 */
const FRAGMENT_SHADER = /* glsl */ `
    uniform float opacity;
    uniform vec3 strokeColor;
    uniform float strokeWidth;
    varying vec3 vColor;
    varying float vShape;
    varying float vSize;

    float shapeDistance(vec2 p, float shape) {
        if (shape < 0.5) {
            // circle
            return length(p) - 0.5;
        } else if (shape < 1.5) {
            // square
            vec2 d = abs(p) - vec2(0.5);
            return max(d.x, d.y);
        } else if (shape < 2.5) {
            // diamond
            return abs(p.x) + abs(p.y) - 0.5;
        } else if (shape < 3.5) {
            // triangle, вершина вверх; отступ от центра подобран под вписанный круг
            return max(abs(p.x) * 1.732 + p.y, -2.0 * p.y) * 0.5 - 0.25;
        } else {
            // cross: объединение двух полос
            vec2 a = abs(p);
            float bar = 0.16;
            float horiz = max(a.x - 0.5, a.y - bar);
            float vert  = max(a.x - bar, a.y - 0.5);
            return min(horiz, vert);
        }
    }

    void main() {
        vec2 p = gl_PointCoord - vec2(0.5);
        float d = shapeDistance(p, vShape);

        // Ширина сглаживания — примерно один пиксель в координатах фигуры.
        float aa = 1.0 / max(vSize, 1.0);
        float coverage = 1.0 - smoothstep(-aa, aa, d);
        if (coverage <= 0.0) discard;

        // Окантовка: зона [-w, 0] внутри контура.
        float w = strokeWidth / max(vSize, 1.0);
        float inStroke = 0.0;
        if (w > 0.0) {
            inStroke = smoothstep(-w - aa, -w + aa, d);
        }

        vec3 col = mix(vColor, strokeColor, inStroke);
        gl_FragColor = vec4(col, coverage * opacity);
    }
`;

// =====================================================================
// PointCloud
// =====================================================================

export class PointCloud extends SpatialObject {
    // ── Данные ──
    private _positions: SpatialPosition[];
    private _crsCode: string | null;
    private _crs: any | null = null;

    // ── Стиль ──
    private _color: PointCloudColor;
    private _colors: PointCloudColor[] | null;
    private _size: number;
    private _sizes: number[] | null;
    private _shape: PointShape;
    private _shapes: PointShape[] | null;
    private _opacity: number;
    private _strokeColor: PointCloudColor;
    private _strokeWidth: number;
    private _depthTest: boolean;
    private _depthWrite: boolean;
    private _altitudeMode: PointCloudAltitudeMode;
    private _mode: PointCloudMode;

    // ── Геометрия в плоских координатах карты ──
    /** Плоские координаты точек карты [x, z] (после project). */
    private _planar: Array<[number, number]> = [];
    /** Высоты узлов (3-я координата позиции / h над эллипсоидом для ECEF). */
    private _nodeHeights: number[] = [];
    /** lon/lat точек — нужны глобусу; null, если не переводятся. */
    private _lonLat: Array<[number, number] | null> = [];
    /** Локальный origin в плоских координатах карты (среднее точек). */
    private _origin: [number, number] = [0, 0];

    // ── Временные объекты ──
    private _worldCenter = new THREE.Vector3();
    private _tmpVec = new THREE.Vector3();
    private _tmpVec2 = new THREE.Vector3();

    // ── 3D-объекты ──
    private _points: any = null;
    private _geometry: any = null;
    private _material: any = null;

    // ── LOD ──
    /** Пороговое число точек, с которого включается прореживание. */
    static readonly LOD_MIN_POINTS = 50000;
    /** Макс. число точек, отрисовываемых за кадр (после прореживания). */
    private _lodBudget = 800000;
    private _lod: PointCloudLOD | null = null;
    private _minH = 0;
    private _maxH = 0;
    /** Мировая Y самой низкой точки облака (обновляется в _update). */
    private _worldBaseY = 0;
    private _tmpPV = new THREE.Matrix4();
    private _tmpFrustum = new THREE.Frustum();
    private _tmpBox = new THREE.Box3();

    // ── Интерактив ──
    private _unregisterInteraction: (() => void) | null = null;

    constructor(options: PointCloudOptions) {
        super();

        if (options.zoomInterpolate) this.setZoomInterpolations(options.zoomInterpolate);
        this._properties = options.properties ?? {};
        this._userData = options.userData ?? {};

        // Пустой набор допустим: облако может получить точки позже (setPositions),
        // например, после асинхронной загрузки файла (см. LAS).
        if (!options.positions) {
            throw new Error('PointCloud: options.positions required (may be empty)');
        }
        const n = options.positions.length;
        if (options.colors && options.colors.length !== n) {
            throw new Error('PointCloud: options.colors length must match positions');
        }
        if (options.sizes && options.sizes.length !== n) {
            throw new Error('PointCloud: options.sizes length must match positions');
        }
        if (options.shapes && options.shapes.length !== n) {
            throw new Error('PointCloud: options.shapes length must match positions');
        }

        this._positions = options.positions.map(p => [...p] as SpatialPosition);
        this._crsCode = options.crs ?? null;

        this._color = options.color ?? 0x3388ff;
        this._colors = options.colors ? [...options.colors] : null;
        this._size = options.size ?? 6;
        this._sizes = options.sizes ? [...options.sizes] : null;
        this._shape = options.shape ?? 'circle';
        this._shapes = options.shapes ? [...options.shapes] : null;
        this._opacity = clamp01(options.opacity ?? 1);
        this._strokeColor = options.strokeColor ?? 0x000000;
        this._strokeWidth = Math.max(0, options.strokeWidth ?? 0);
        this._depthTest = options.depthTest ?? true;
        this._depthWrite = options.depthWrite ?? true;
        // Режим по умолчанию выбирается при присоединении к карте: clampToGround,
        // если на карте нет elevation, иначе absolute (см. _resolveAltitudeMode).
        this._altitudeModeExplicit = options.altitudeMode !== undefined;
        this._altitudeMode = options.altitudeMode ?? 'clampToGround';
        this._mode = options.mode ?? 'shaped';
        if (options.lodBudget !== undefined) this._lodBudget = Math.max(1, options.lodBudget);
        this._altitude = options.altitude ?? 0;

        this._minZoom = options.minZoom ?? -Infinity;
        this._maxZoom = options.maxZoom ?? Infinity;

        this._title = options.title ?? '';
        this._titleStyle = options.titleStyle ?? {};
        this._titleMinZoom = options.titleMinZoom ?? -Infinity;
        this._titleMaxZoom = options.titleMaxZoom ?? Infinity;
        this._userTitleOffset = options.titleOffset
            ? [options.titleOffset[0], options.titleOffset[1]]
            : null;
        this._resolveTitleOffset();

        this._tooltipText = options.tooltip ?? '';
        this._onClick = options.onClick ?? null;
        this._onHover = options.onHover ?? null;
    }

    // =================================================================
    // Хуки SpatialObject
    // =================================================================

    protected _onAttached(map: any): void {
        this._resolveAltitudeMode(map);
        this._crs = this._crsCode ? Projections.get(this._crsCode) : map.inputCRS;
        this._computePlanar(map);
        this._buildGeometry();
        this._buildLOD();
        if (this._exactCount) {
            if (!this._countWorker) this._countWorker = createPointCountWorker();
            this._sendPointsToCountWorker();
        }

        this._points = new THREE.Points(this._geometry, this._material);
        this._points.renderOrder = POINT_RENDER_ORDER;
        this._points.frustumCulled = false;   // отсечение делаем сами через _update
        map.worldGroup.add(this._points);

        this._registerInteraction(map);
        this._isVisible = false;
    }

    protected _teardown(): void {
        if (this._unregisterInteraction) {
            this._unregisterInteraction();
            this._unregisterInteraction = null;
        }
        if (this._points) {
            this._points.parent?.remove(this._points);
            this._geometry?.dispose();
            this._material?.dispose();
            this._points = null;
            this._geometry = null;
            this._material = null;
        }
        this._planar = [];
        this._nodeHeights = [];
        this._lonLat = [];
        this._lod = null;
        this._crs = null;
        // Воркер держит позиции старой геометрии — освобождаем; при повторном
        // _onAttached создастся заново (если exactCount включён).
        this._countWorker?.dispose();
        this._countWorker = null;
        this._inFrustumBusy = false;
    }

    protected _applyHidden(): void {
        if (this._points) this._points.visible = false;
    }

    protected _onTooltipChanged(): void {
        if (this._map) this._registerInteraction(this._map);
    }

    getLabelType(): 'point' { return 'point'; }

    // =================================================================
    // Перевод позиций в плоские координаты карты
    // =================================================================

    /**
     * Переводит позиции в плоские координаты карты (`map.project`) и
     * вычисляет origin. Для глобуса дополнительно сохраняются lon/lat.
     */
    private _computePlanar(map: any): void {
        const n = this._positions.length;
        this._planar = new Array(n);
        this._nodeHeights = new Array(n);
        this._lonLat = new Array(n);
        this._boundsCache = null;

        for (let i = 0; i < n; i++) {
            const nn = this._normalizePosition(this._positions[i], this._crs);
            let x = 0, z = 0;
            if (map.globe && map.surface) {
                // Глобус: точку кладём той же функцией, что и origin (projectSurfacePoint),
                // иначе относительное положение точек и центра расходятся по знаку (разворот 180°).
                const ll = nn.lonLat ?? this._lonLatOf(nn);
                const v = map.getVec3();
                // Высоту не передаём: nodeHeight уже задаёт Y геометрии (см. _buildGeometry),
                // иначе высота учтётся дважды.
                const w = ll ? map.projectSurfacePoint(ll, 'EPSG:4326', 0, v, null) : null;
                if (w) { x = w.x; z = w.z; }
            } else {
                const p = nn.lonLat
                    ? map.project(nn.lonLat, 'EPSG:4326')
                    : map.project(nn.coord, this._crs);
                x = Number.isFinite(p[0]) ? p[0] : 0;
                z = Number.isFinite(p[1]) ? p[1] : 0;
            }
            this._planar[i] = [x, z];
            this._nodeHeights[i] = nn.nodeHeight;
            this._lonLat[i] = this._lonLatOf(nn);
        }

        let sx = 0, sz = 0;
        for (const [x, z] of this._planar) { sx += x; sz += z; }
        this._origin = n > 0 ? [sx / n, sz / n] : [0, 0];

        // Глобус: origin должен быть ТОЙ ЖЕ точкой, что и _originWorld (центр lon/lat на поверхности).
        // Среднее мировых X/Z даёт другую точку на сфере → облако смещается на десятки метров.
        if (map.globe && map.surface) {
            const ll = this._centerLonLat();
            const o = ll ? map.projectSurfacePoint(ll, 'EPSG:4326', 0, this._tmpVec, null) : null;
            if (o) {
                // Точки храним в мировой системе; геометрия строится как (точка − origin).
                this._origin = [o.x, o.z];
            }
        }

        // Минимум высоты узлов: для clampToGround самая низкая точка облака
        // ставится на уровень поверхности (y=0 на плоскости, эллипсоид на глобусе).
        // Учитываем масштаб высоты точки (тот же, что в геометрии): минимум — по scaled-высотам.
        let minH = Infinity;
        for (let i = 0; i < n; i++) {
            const h = this._nodeHeights[i];
            if (!Number.isFinite(h)) continue;
            const hs = h * this._pointScale(i);
            if (hs < minH) minH = hs;
        }
        this._minNodeHeight = Number.isFinite(minH) ? minH : 0;
    }

    /** Минимальная высота узлов облака (над уровнем поверхности / эллипсоидом). */
    private _minNodeHeight = 0;
    /** true, если режим задан явно (тогда автоматический выбор его не меняет). */
    private _altitudeModeExplicit = false;

    /**
     * Если режим не задан явно: clampToGround при отсутствии elevation на карте
     * (плоская карта без тайлов рельефа и GeoTIFF), иначе absolute.
     */
    protected _resolveAltitudeMode(map: any): void {
        if (this._altitudeModeExplicit) return;
        this._altitudeMode = map.hasElevation ? 'absolute' : 'clampToGround';
    }

    /** Масштаб высоты точки i (SpatialObject._verticalScale) по её WGS-84 широте. */
    private _pointScale(i: number): number {
        return this._verticalScale(this._lonLat[i] ?? null);
    }

    /** lon/lat (WGS-84) узла; null, если перевод невозможен. */
    private _lonLatOf(nn: { coord: [number, number]; lonLat: [number, number] | null }): [number, number] | null {
        if (nn.lonLat) return [nn.lonLat[0], nn.lonLat[1]];
        const src = this._crs ?? this._map?.inputCRS;
        if (!src || typeof src.toLonLat !== 'function') return null;
        const ll = src.toLonLat(nn.coord);
        if (!ll || !Number.isFinite(ll[0]) || !Number.isFinite(ll[1])) return null;
        return [ll[0], ll[1]];
    }

    // =================================================================
    // Геометрия и материал
    // =================================================================

    /**
     * Строит BufferGeometry и материал из текущего состояния.
     *
     * shaped — ShaderMaterial с размером/формой/окантовкой на точку.
     * simple — стандартный PointsMaterial: только цвет на точку и один
     *          глобальный размер, без атрибутов size/shape и без шейдера.
     */
    private _buildGeometry(): void {
        const n = this._planar.length;
        const positionArr = new Float32Array(n * 3);
        const colorArr = new Float32Array(n * 3);

        const map = this._map;
        const globe = !!(map && map.globe && map.surface);
        if (globe) {
            // Глобус: каждая точка — 3D-позиция на эллипсоиде над своей lon/lat на высоте
            // nodeHeight·k, относительно origin (как Polygon/Polyline). Никаких X/Z-смещений
            // на сфере: они дают сдвиг по касательной плоскости.
            const oc = this._originWorld(map);
            const origin = oc ? new THREE.Vector3(oc.x, oc.y, oc.z) : new THREE.Vector3();
            const v = this._tmpVec;
            for (let i = 0; i < n; i++) {
                const ll = this._lonLat[i];
                const h = (Number.isFinite(this._nodeHeights[i]) ? this._nodeHeights[i] : 0) * this._pointScale(i);
                const p = ll ? map.projectSurfaceVertex(ll, 'EPSG:4326', h, origin, v) : null;
                positionArr[i * 3]     = p ? v.x : 0;
                positionArr[i * 3 + 1] = p ? v.y : 0;
                positionArr[i * 3 + 2] = p ? v.z : 0;
            }
        }
        const [ox, oz] = this._origin;
        for (let i = 0; !globe && i < n; i++) {
            const [x, z] = this._planar[i];
            positionArr[i * 3]     = Number.isFinite(x - ox) ? x - ox : 0;
            // nodeHeight — истинные метры: масштаб по широте точки (как у Polygon/Polyline).
            const kN = this._pointScale(i);
            positionArr[i * 3 + 1] = Number.isFinite(this._nodeHeights[i]) ? this._nodeHeights[i] * kN : 0;
            positionArr[i * 3 + 2] = Number.isFinite(z - oz) ? z - oz : 0;
        }

        this._geometry = new THREE.BufferGeometry();
        this._geometry.setAttribute('position', new THREE.BufferAttribute(positionArr, 3));
        this._geometry.setAttribute('color', new THREE.BufferAttribute(colorArr, 3));

        if (this._mode === 'shaped') {
            this._geometry.setAttribute('size', new THREE.BufferAttribute(new Float32Array(n), 1));
            this._geometry.setAttribute('shape', new THREE.BufferAttribute(new Float32Array(n), 1));
        }
        this._geometry.computeBoundingSphere();

        this._fillAttributes();
        this._material = this._mode === 'shaped'
            ? this._createShapedMaterial()
            : this._createSimpleMaterial();
    }

    private _createShapedMaterial(): any {
        const pixelRatio = this._map?.renderer?.getPixelRatio?.() ?? 1;
        return new THREE.ShaderMaterial({
            uniforms: {
                opacity:     { value: this._opacity },
                pixelRatio:  { value: pixelRatio },
                strokeColor: { value: new THREE.Color(this._strokeColor as any) },
                strokeWidth: { value: this._strokeWidth },
            },
            vertexShader: VERTEX_SHADER,
            fragmentShader: FRAGMENT_SHADER,
            transparent: true,   // сглаженные края фигуры должны смешиваться с фоном, а не давать светлую кайму
            depthTest: this._depthTest,
            depthWrite: this._depthWrite,
        });
    }

    private _createSimpleMaterial(): any {
        return new THREE.PointsMaterial({
            vertexColors: true,
            size: this._size,
            sizeAttenuation: false,     // размер в пикселях экрана
            opacity: this._opacity,
            transparent: true,   // сглаженные края фигуры должны смешиваться с фоном, а не давать светлую кайму
            depthTest: this._depthTest,
            depthWrite: this._depthWrite,
        });
    }

    /** Заполняет атрибуты цвета (и размер/форму в shaped-режиме). */
    private _fillAttributes(): void {
        if (!this._geometry) return;
        const n = this._planar.length;
        const colorArr = this._geometry.getAttribute('color').array as Float32Array;

        const tmp = new THREE.Color();
        for (let i = 0; i < n; i++) {
            const c = tmp.set((this._colors ? this._colors[i] : this._color) as any);
            colorArr[i * 3]     = c.r;
            colorArr[i * 3 + 1] = c.g;
            colorArr[i * 3 + 2] = c.b;
        }
        this._geometry.getAttribute('color').needsUpdate = true;

        if (this._mode === 'shaped') {
            const sizeArr  = this._geometry.getAttribute('size').array as Float32Array;
            const shapeArr = this._geometry.getAttribute('shape').array as Float32Array;
            for (let i = 0; i < n; i++) {
                sizeArr[i]  = this._sizes ? this._sizes[i] : this._size;
                shapeArr[i] = SHAPE_CODE[this._shapes ? this._shapes[i] : this._shape];
            }
            this._geometry.getAttribute('size').needsUpdate = true;
            this._geometry.getAttribute('shape').needsUpdate = true;
        }
    }

    // =================================================================
    // Интерактив
    // =================================================================

    private _registerInteraction(map: any): void {
        if (!map.interaction || typeof map.interaction.register !== 'function') return;
        if (this._unregisterInteraction) {
            this._unregisterInteraction();
            this._unregisterInteraction = null;
        }
        if (!this._onClick && !this._onHover && !this._tooltipText) return;

        this._unregisterInteraction = map.interaction.register(this, {
            getMeshes: () => this._points ? [this._points] : [],
            getBoundingSphere: () => {
                const bs = this._geometry?.boundingSphere;
                if (!bs || !this._points) return null;
                const c = this._map.getVec3().copy(bs.center).add(this._points.position);
                return { center: c, radius: bs.radius };
            },
            onHover: this._onHover || null,
            onClick: this._onClick || null,
            getTooltip: this._tooltipText ? () => this._tooltipText : null,
            isVisible: () => this._isVisible,
        });
    }

    // =================================================================
    // Обновление на кадре
    // =================================================================

    _update(map: any): void {
        if (!this._map || !this._points) return;
        this._applyZoomInterpolations(map.continuousZoom);

        if (!this._isWithinView()) {
            this._applyHidden();
            this._isVisible = false;
            return;
        }

        // Положение origin в мире. На глобусе — через lon/lat центра
        // (projectSurfacePoint требует lon/lat, а не плоские координаты).
        const origin = this._originWorld(map);
        if (!origin) {
            this._applyHidden();
            this._isVisible = false;
            return;
        }

        const wg = map.worldGroup ? map.worldGroup.position : null;
        const wx = wg ? wg.x : 0;
        const wy = wg ? wg.y : 0;
        const wz = wg ? wg.z : 0;

        // Локальная позиция меша = мировой origin − сдвиг worldGroup.
        // Высота каждой точки уже внутри геометрии (nodeHeight); здесь
        // добавляем altitude и (для clampToGround на плоскости) рельеф.
        // Правило (как у Marker3D):
        //  - clampToGround: самая низкая точка облака ставится на поверхность
        //    (y=0 на плоскости; эллипсоид — на глобусе), затем + altitude.
        //  - absolute: высоты точек как есть, затем + altitude.
        // Высоты точек уже внутри геометрии (nodeHeight), поэтому для clampToGround
        // вычитаем минимум, а рельеф (hasElevation) добавляем в точке облака.
        // altitude — истинные метры: масштаб по центроиду облака. minNodeHeight уже масштабирован.
        const kC = this._verticalScale(this._centerLonLat());
        let lift = this._altitude * kC;
        if (this._altitudeMode === 'clampToGround') {
            lift += -this._minNodeHeight;
            if (!map.globe && map.hasElevation) {
                const h = map.getSurfaceHeightAt(origin.x, origin.z);
                if (Number.isFinite(h)) lift += h;
            }
        }

        if (map.globe && map.surface) {
            // Глобус: origin — мировая точка на эллипсоиде. Подъём (lift) откладываем вдоль
            // местной нормали, как и на плоскости по Y: для clampToGround — самая низкая точка
            // облака на поверхности (−minNodeHeight) плюс рельеф, если elevation включён.
            const ll = this._centerLonLat();
            let liftG = this._altitude * kC;
            if (this._altitudeMode === 'clampToGround') {
                liftG += -this._minNodeHeight;
                if (map.hasElevation && ll) {
                    const sp = map.projectSurfacePoint(ll, 'EPSG:4326', 0, this._tmpVec2, null);
                    if (sp) {
                        const sh = map.getSurfaceHeightAt(sp.x, sp.z);
                        if (Number.isFinite(sh)) liftG += sh;
                    }
                }
            }
            const lp = this._tmpVec.set(origin.x, origin.y, origin.z);
            if (ll && liftG) {
                const nrm = this._tmpVec2.set(0, 0, 0);
                map.surface.normal(ll[0], ll[1], nrm);
                if (map.worldGroup) nrm.transformDirection(map.worldGroup.matrixWorld);
                lp.addScaledVector(nrm.normalize(), liftG);
            }
            // Группа живёт в worldGroup → переводим мировую точку в локальную систему.
            if (map.worldGroup) map.worldGroup.worldToLocal(lp);
            this._points.position.copy(lp);
        } else {
            this._points.position.set(origin.x - wx, origin.y + lift - wy, origin.z - wz);
        }

        // Глобус: облако «стоит» вдоль местной нормали эллипсоида в точке origin (как Marker3D),
        // а не вдоль мировой Y. Иначе вертикаль облака отклонена от поверхности.
        if (map.globe && map.surface) {
            // Глобус: позиции точек уже заданы в мировых осях относительно origin
            // (projectSurfaceVertex), поэтому поворот меша не нужен.
            this._points.quaternion.identity();
        } else {
            this._points.quaternion.identity();
        }
        this._worldCenter.set(origin.x, origin.y + lift, origin.z);
        // Мировая Y самой низкой точки облака (геометрия от 0 до maxH − minH).
        this._worldBaseY = origin.y + lift;

        // Дистанционный LOD.
        if (map.view?.objectRenderDistanceFactor > 0) {
            const dist = map.camera.position.distanceTo(this._worldCenter);
            if (dist > map.maxObjectDistance) {
                this._applyHidden();
                this._isVisible = false;
                return;
            }
        }

        // Глобус: за горизонтом не показываем.
        if (map.globe && typeof map.isWorldPointOccluded === 'function'
            && map.isWorldPointOccluded(this._worldCenter)) {
            this._applyHidden();
            this._isVisible = false;
            return;
        }

        this._updateLOD(map, origin);

        this._points.visible = true;
        this._isVisible = true;
    }

    // =================================================================
    // LOD (прореживание по расстоянию)
    // =================================================================

    /** Строит LOD по плоским координатам относительно origin. */
    private _buildLOD(): void {
        const n = this._planar.length;
        // Порог LOD нужен только для большого числа точек: на малых облаках
        // прореживание не окупается и сбивает плотность.
        if (n < PointCloud.LOD_MIN_POINTS) {
            this._lod = null;
            return;
        }
        // Координаты LOD — ровно те, что у геометрии (глобус: 3D-позиции; плоскость: X/Z−origin).
        const pos = this._geometry?.getAttribute('position')?.array as Float32Array | undefined;
        const xs = new Float32Array(n);
        const zs = new Float32Array(n);
        let minH = Infinity, maxH = -Infinity;
        for (let i = 0; i < n; i++) {
            xs[i] = pos ? pos[i * 3]     : this._planar[i][0] - this._origin[0];
            zs[i] = pos ? pos[i * 3 + 2] : this._planar[i][1] - this._origin[1];
            const h = pos ? pos[i * 3 + 1] : this._nodeHeights[i] * this._pointScale(i);
            if (h < minH) minH = h;
            if (h > maxH) maxH = h;
        }
        // Высота AABB ячеек: диапазон высот узлов облака (с запасом на altitude/рельеф).
        // Реальный вертикальный диапазон точек + altitude + небольшой запас
        // на рельеф (clampToGround). Запас 50 м, а не 1000 м: широкий бокс
        // ложно «видит» ячейки, которых на экране нет.
        // Храним чистый диапазон высот узлов (без altitude и без запаса):
        // запас и сдвиг применяются в _updateLOD относительно реального origin.
        this._minH = Number.isFinite(minH) ? minH : 0;
        this._maxH = Number.isFinite(maxH) ? maxH : 0;
        // Высоты точек в системе геометрии (nodeHeight − minNodeHeight): нужны LOD для точного AABB ячейки.
        // Высоты точек ровно как в геометрии (nodeHeight, без вычитания minNodeHeight):
        // их мировое положение задаётся мешем (см. _update), поэтому бокс совпадает с рисуемым.
        // Высоты — в той же системе, что геометрия меша (nodeHeight · k точки), иначе AABB ячеек не совпадает с точками.
        const ys = new Float32Array(n);
        for (let i = 0; i < n; i++) ys[i] = this._nodeHeights[i] * this._pointScale(i);
        this._lod = new PointCloudLOD(xs, zs, { budget: this._lodBudget, ys });
    }

    /**
     * Выбирает уровни по камере и, если они изменились, переставляет индекс.
     * Камера переводится в систему origin облака (мировые координаты минус origin).
     */
    private _updateLOD(map: any, origin: { x: number; y: number; z: number }): void {
        const lod = this._lod;
        if (!lod || !this._geometry) return;

        // Фрустум камеры в мировых координатах — учитывает pitch и любой поворот.
        const cam = map.camera;
        this._tmpPV.multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse);
        this._tmpFrustum.setFromProjectionMatrix(this._tmpPV);

        // AABB ячейки: плоская (x, z) ячейки + высота облака, переведённые в мир.
        // Вертикальный диапазон бокса — относительно фактической точки origin, которую
        // мы уже вычислили в _update (с учётом altitudeMode, minNodeHeight и рельефа).
        // Диапазон высот точек: от 0 до (maxH − minH) над уровнем облака, с запасом.
        // В геометрии высота узла = nodeHeight − minNodeHeight (минимум вычитается в lift),
        // поэтому мировой диапазон по Y: [origin.y − pad, origin.y + (maxH − minH) + pad].
        // Низ облака — фактическая мировая высота меша (уже включает altitude и рельеф),
        // а не оценка. Запас небольшой: геометрия смещена на minH − minH = 0.
        // Точный AABB ячейки в мировых координатах: X/Z — относительно origin, Y — от
        // мировой высоты низа геометрии (_worldBaseY). Небольшой запас против погрешности float32.
        const pad = 0.5;
        // Глобус: меш повёрнут к нормали эллипсоида, а AABB строится по мировым осям,
        // поэтому бокс не совпадает с точками и ячейки ложно отбрасываются у камеры.
        // Для повёрнутого облака отсечение по боксу отключаем: все ячейки видимы
        // (облако небольшое, экономия от отсечения здесь не нужна).
        // Бокс ячейки строится в ЛОКАЛЬНОЙ системе геометрии (8 углов), затем переносится в мир
        // матрицей меша (поворот + позиция). Так бокс корректен и для повёрнутого (глобус),
        // и для неповёрнутого меша. Мировой AABB от 8 углов содержит повёрнутую ячейку целиком.
        const mesh = this._points;
        mesh.updateMatrix();
        mesh.updateMatrixWorld(true);
        const M = mesh.matrixWorld;
        const corner = this._tmpVec;
        // Локальный низ геометрии по Y — 0 (геометрия от nodeHeight; см. _buildGeometry).
        const changed = lod.update((minX, maxX, minY, maxY, minZ, maxZ) => {
            let bx0 = Infinity, by0 = Infinity, bz0 = Infinity;
            let bx1 = -Infinity, by1 = -Infinity, bz1 = -Infinity;
            for (let c = 0; c < 8; c++) {
                const lx = (c & 1) ? maxX + pad : minX - pad;
                const ly = (c & 2) ? maxY + pad : minY - pad;
                const lz = (c & 4) ? maxZ + pad : minZ - pad;
                corner.set(lx, ly, lz).applyMatrix4(M);
                if (corner.x < bx0) bx0 = corner.x; if (corner.x > bx1) bx1 = corner.x;
                if (corner.y < by0) by0 = corner.y; if (corner.y > by1) by1 = corner.y;
                if (corner.z < bz0) bz0 = corner.z; if (corner.z > bz1) bz1 = corner.z;
            }
            this._tmpBox.min.set(bx0, by0, bz0);
            this._tmpBox.max.set(bx1, by1, bz1);
            return this._tmpFrustum.intersectsBox(this._tmpBox);
        });

        // Индекс меняем только при реальной смене уровней (changed).
        // Проверку isDirty не используем: она дублирует changed и стоит O(ячеек).
        if (changed) {
            const idx = lod.buildIndex();
            const attr = this._geometry.index;
            if (attr && attr.array.length >= idx.length) {
                // Тот же буфер на GPU: записываем префикс и рисуем drawRange.
                (attr.array as Uint32Array).set(idx);
                attr.needsUpdate = true;
                this._geometry.setDrawRange(0, idx.length);
            } else {
                // Буфер мал — создаём с запасом, иначе будут пересоздания.
                const cap = Math.ceil(idx.length * 1.25);
                const big = new Uint32Array(cap);
                big.set(idx);
                this._geometry.setIndex(new THREE.BufferAttribute(big, 1));
                this._geometry.setDrawRange(0, idx.length);
            }
        }
    }

    /**
     * Мировая точка origin облака.
     *
     * Плоскость: `_origin` уже в координатах сцены (результат `map.project`,
     * где Y инвертирован и становится Z), поэтому мировая позиция — это
     * сам origin плюс сдвиг worldGroup. Вызывать `projectSurfacePoint` с
     * ним нельзя: он ожидает координаты CRS и применил бы проекцию повторно.
     *
     * Глобус: `projectSurfacePoint` требует lon/lat, берём среднее по точкам.
     */
    private _originWorld(map: any): { x: number; y: number; z: number } | null {
        if (map.globe) {
            const ll = this._centerLonLat();
            if (!ll) return null;
            const p = map.projectSurfacePoint(ll, 'EPSG:4326', 0, this._tmpVec, null);
            return p ? { x: p.x, y: p.y, z: p.z } : null;
        }
        const wg = map.worldGroup ? map.worldGroup.position : null;
        const x = this._origin[0] + (wg ? wg.x : 0);
        const z = this._origin[1] + (wg ? wg.z : 0);
        if (!Number.isFinite(x) || !Number.isFinite(z)) return null;
        return { x, y: wg ? wg.y : 0, z };
    }

    /** lon/lat центра облака (среднее по точкам, где перевод известен). */
    private _centerLonLat(): [number, number] | null {
        let sx = 0, sy = 0, k = 0;
        for (const ll of this._lonLat) {
            if (!ll) continue;
            sx += ll[0]; sy += ll[1]; k++;
        }
        return k ? [sx / k, sy / k] : null;
    }

    // =================================================================
    // Публичный API: стиль
    // =================================================================

    /** Цвет по умолчанию (для точек без персонального цвета). */
    setColor(color: PointCloudColor): this {
        this._color = color;
        this._refreshAttributes();
        return this;
    }
    getColor(): PointCloudColor { return this._color; }

    /** Персональные цвета по точкам; `null` — убрать персональные. */
    setColors(colors: PointCloudColor[] | null): this {
        this._assertLength(colors, 'setColors');
        this._colors = colors ? [...colors] : null;
        this._refreshAttributes();
        return this;
    }
    getColors(): PointCloudColor[] | null { return this._colors ? [...this._colors] : null; }

    /** Размер по умолчанию, px. */
    setSize(size: number): this {
        if (!(size >= 0) || !Number.isFinite(size)) return this;
        this._size = size;
        if (this._mode === 'simple') {
            if (this._material) this._material.size = size;
        } else {
            this._refreshAttributes();
        }
        return this;
    }
    getSize(): number { return this._size; }

    /** Персональные размеры, px; `null` — убрать персональные. */
    setSizes(sizes: number[] | null): this {
        this._assertLength(sizes, 'setSizes');
        this._warnSimpleIgnores('sizes');
        this._sizes = sizes ? [...sizes] : null;
        this._refreshAttributes();
        return this;
    }
    getSizes(): number[] | null { return this._sizes ? [...this._sizes] : null; }

    /** Форма по умолчанию. */
    setShape(shape: PointShape): this {
        if (!(shape in SHAPE_CODE)) return this;
        this._warnSimpleIgnores('shape');
        this._shape = shape;
        this._refreshAttributes();
        return this;
    }
    getShape(): PointShape { return this._shape; }

    /** Персональные формы; `null` — убрать персональные. */
    setShapes(shapes: PointShape[] | null): this {
        this._assertLength(shapes, 'setShapes');
        this._shapes = shapes ? [...shapes] : null;
        this._refreshAttributes();
        return this;
    }
    getShapes(): PointShape[] | null { return this._shapes ? [...this._shapes] : null; }

    setOpacity(opacity: number): this {
        this._opacity = clamp01(opacity);
        if (this._material) {
            if (this._mode === 'shaped') this._material.uniforms.opacity.value = this._opacity;
            else this._material.opacity = this._opacity;
            const transparent = this._opacity < 1;
            if (this._material.transparent !== transparent) {
                this._material.transparent = transparent;
                this._material.needsUpdate = true;
            }
        }
        return this;
    }
    getOpacity(): number { return this._opacity; }

    /** Окантовка: цвет и толщина (px); width 0 — без окантовки. */
    setStroke(color: PointCloudColor, width: number): this {
        this._strokeColor = color;
        this._strokeWidth = Math.max(0, width);
        // Окантовка есть только в shaped-режиме (в simple её нет).
        if (this._material && this._mode === 'shaped') {
            this._material.uniforms.strokeColor.value.set(color as any);
            this._material.uniforms.strokeWidth.value = this._strokeWidth;
        }
        return this;
    }
    getStroke(): { color: PointCloudColor; width: number } {
        return { color: this._strokeColor, width: this._strokeWidth };
    }

    setDepthTest(depthTest: boolean): this {
        this._depthTest = !!depthTest;
        if (this._material) {
            this._material.depthTest = this._depthTest;
            this._material.needsUpdate = true;
        }
        return this;
    }
    getDepthTest(): boolean { return this._depthTest; }

    setDepthWrite(depthWrite: boolean): this {
        this._depthWrite = !!depthWrite;
        if (this._material) {
            this._material.depthWrite = this._depthWrite;
            this._material.needsUpdate = true;
        }
        return this;
    }
    getDepthWrite(): boolean { return this._depthWrite; }

    setAltitudeMode(mode: PointCloudAltitudeMode): this {
        this._altitudeMode = mode;
        return this;
    }
    getAltitudeMode(): PointCloudAltitudeMode { return this._altitudeMode; }

    /**
     * Меняет CRS координат точек. Нужен, когда CRS становится известен после
     * создания (например, E57 читает его из файла). Если объект на карте —
     * геометрия пересобирается.
     */
    setCRS(code: string | null): this {
        this._crsCode = code;
        if (this._map) this._rebuildAll();
        return this;
    }

    getCRS(): string | null { return this._crsCode; }

    // =================================================================
    // Публичный API: точки
    // =================================================================

    /** Число точек. */
    getCount(): number { return this._positions.length; }

    /** Копия исходных позиций (в CRS объекта). */
    getPositions(): SpatialPosition[] {
        return this._positions.map(p => [...p] as SpatialPosition);
    }

    /**
     * Заменяет все точки. Персональные стили сбрасываются, если их длина
     * не совпадает с новым числом точек.
     */
    setPositions(positions: SpatialPosition[]): this {
        if (!positions || positions.length < 1) return this;
        this._positions = positions.map(p => [...p] as SpatialPosition);
        const n = this._positions.length;
        if (this._colors && this._colors.length !== n) this._colors = null;
        if (this._sizes && this._sizes.length !== n) this._sizes = null;
        if (this._shapes && this._shapes.length !== n) this._shapes = null;
        this._rebuildAll();
        return this;
    }

    /** Добавляет точку. Персональные стили дополняются значениями по умолчанию. */
    addPoint(datum: PointDatum): this {
        const idx = this._positions.length;
        this._positions.push([...datum.position] as SpatialPosition);
        if (datum.color !== undefined || this._colors) {
            this._colors = this._colors ?? new Array(idx).fill(this._color);
            this._colors.push(datum.color ?? this._color);
        }
        if (datum.size !== undefined || this._sizes) {
            this._sizes = this._sizes ?? new Array(idx).fill(this._size);
            this._sizes.push(datum.size ?? this._size);
        }
        if (datum.shape !== undefined || this._shapes) {
            this._shapes = this._shapes ?? new Array(idx).fill(this._shape);
            this._shapes.push(datum.shape ?? this._shape);
        }
        this._rebuildAll();
        return this;
    }

    /** Описание всех точек с учётом персональных стилей. */
    getPoints(): PointDatum[] {
        return this._positions.map((p, i) => ({
            position: [...p] as SpatialPosition,
            color: this._colors ? this._colors[i] : this._color,
            size:  this._sizes ? this._sizes[i]  : this._size,
            shape: this._shapes ? this._shapes[i] : this._shape,
        }));
    }

    /**
     * Ограничивающий прямоугольник облака в WGS-84: `[[minLon, minLat], [maxLon, maxLat]]`
     * (по точкам, для которых известна широта/долгота). Контракт fitTo/fitToBounds.
     * Для ECEF-облака — bbox по lon/lat, а не по ECEF-кубу: ECEF-прямоугольник
     * не даёт корректных углов при переводе в lon/lat.
     * Возвращает null, если точек нет.
     */
    getBounds(crs: string | any = 'EPSG:4326'): [[number, number], [number, number]] | null {
        const code = typeof crs === 'string' ? crs : null;
        if (code && code !== 'EPSG:4326') return null;   // поддерживаем только WGS-84 (этого достаточно для fitTo)
        if (this._boundsCache) return this._boundsCache;
        let minLon = Infinity, minLat = Infinity, maxLon = -Infinity, maxLat = -Infinity;
        for (const ll of this._lonLat) {
            if (!ll) continue;
            if (ll[0] < minLon) minLon = ll[0];
            if (ll[0] > maxLon) maxLon = ll[0];
            if (ll[1] < minLat) minLat = ll[1];
            if (ll[1] > maxLat) maxLat = ll[1];
        }
        if (!Number.isFinite(minLon)) return null;
        this._boundsCache = [[minLon, minLat], [maxLon, maxLat]];
        return this._boundsCache;
    }
    private _boundsCache: [[number, number], [number, number]] | null = null;

    /** Центр облака в WGS-84 `[lon, lat]` (среднее точек), либо `null`. */
    getCenter(): [number, number] | null {
        const crs = this._crs ?? (this._crsCode ? Projections.get(this._crsCode) : null);
        const pts = this._positions.map(p => this._normalizePosition(p, crs));
        let sx = 0, sy = 0, k = 0;
        for (const nn of pts) {
            const ll = nn.lonLat ?? (crs ? crs.toLonLat(nn.coord) : null);
            if (!ll || !Number.isFinite(ll[0]) || !Number.isFinite(ll[1])) continue;
            sx += ll[0]; sy += ll[1]; k++;
        }
        return k ? [sx / k, sy / k] : null;
    }

    // =================================================================
    // Внутреннее
    // =================================================================

    /**
     * Бюджет точек за кадр (LOD). Меньше — сильнее прореживание и выше FPS.
     * Применяется сразу; для облака меньше LOD_MIN_POINTS не действует.
     */
    setLodBudget(budget: number): this {
        if (!(budget >= 1) || !Number.isFinite(budget)) return this;
        this._lodBudget = Math.floor(budget);
        if (this._map) this._buildLOD();
        return this;
    }
    getLodBudget(): number { return this._lodBudget; }

    /**
     * Статистика для отладки:
     *  - drawn: точек, которые реально уходят на GPU в этом кадре;
     *  - visibleTotal: точек в видимых ячейках без прореживания;
     *  - total: всего точек в облаке.
     * Без LOD (мало точек) drawn == visibleTotal == total.
     */
    getLodStats(): { drawn: number; visibleTotal: number; total: number; inFrustum: number } {
        const total = this._planar.length;
        if (!this._lod || !this._geometry || !this._map) {
            return { drawn: total, visibleTotal: total, total, inFrustum: total };
        }
        // Точный счёт — только по запросу (exactCount) и в воркере: кадр его не ждёт.
        if (this._exactCount) this._requestExactCount();

        return {
            drawn: this._lod.getDrawnTotal(),
            visibleTotal: this._lod.getVisibleTotal(),
            total,
            inFrustum: this._inFrustumCache,
        };
    }

    /** Последний результат точного счёта из воркера (обновляется асинхронно). */
    private _inFrustumCache = 0;
    private _inFrustumAt = -Infinity;
    private _inFrustumBusy = false;
    private _exactCount = false;
    private _countWorker: PointCountWorker | null = null;
    private _countPlanes = new Float32Array(24);

    /** Включает/выключает точный счёт (диагностика). По умолчанию выключен. */
    setExactCount(on: boolean): this {
        this._exactCount = !!on;
        if (on && !this._countWorker) this._countWorker = createPointCountWorker();
        if (on && this._countWorker && this._map) this._sendPointsToCountWorker();
        return this;
    }

    /** Отправляет позиции точек воркеру (один раз, при смене данных). */
    private _sendPointsToCountWorker(): void {
        const w = this._countWorker;
        const origin = this._map ? this._originWorld(this._map) : null;
        if (!w || !origin) return;
        const n = this._planar.length;
        const xs = new Float32Array(n), ys = new Float32Array(n), zs = new Float32Array(n);
        const [ox, oz] = this._origin;
        for (let i = 0; i < n; i++) {
            const p = this._planar[i];
            xs[i] = origin.x + (p[0] - ox);
            ys[i] = origin.y + this._nodeHeights[i] * this._pointScale(i) + this._altitude * this._verticalScale(this._centerLonLat());
            zs[i] = origin.z + (p[1] - oz);
        }
        w.setPoints(xs, ys, zs);
    }

    /**
     * Запрашивает точный счёт у воркера, не чаще раза в секунду и не параллельно.
     * Главный поток лишь копирует 24 числа фрустума — O(1).
     */
    private _requestExactCount(): void {
        const now = performance.now();
        if (this._inFrustumBusy || now - this._inFrustumAt < 1000) return;
        const map = this._map;
        const cam = map.camera;
        this._tmpPV.multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse);
        this._tmpFrustum.setFromProjectionMatrix(this._tmpPV);
        // Плоскости фрустума: (nx, ny, nz, d), внутрь — n·p + d >= 0.
        const planes = this._tmpFrustum.planes;
        for (let k = 0; k < 6; k++) {
            const p = planes[k];
            this._countPlanes[k * 4]     = p.normal.x;
            this._countPlanes[k * 4 + 1] = p.normal.y;
            this._countPlanes[k * 4 + 2] = p.normal.z;
            this._countPlanes[k * 4 + 3] = p.constant;
        }
        this._inFrustumBusy = true;
        this._inFrustumAt = now;
        this._countWorker?.count(this._countPlanes).then((c) => {
            this._inFrustumCache = c;
            this._inFrustumBusy = false;
        });
    }

    /** Режим отрисовки, с которым создан объект. */
    getMode(): PointCloudMode { return this._mode; }

    /** В simple-режиме размер/форму на точку не рисуем: предупреждаем один раз. */
    private _warnSimpleIgnores(what: string): void {
        if (this._mode !== 'simple') return;
        if (!this._warnedSimple) {
            this._warnedSimple = true;
            console.warn(`PointCloud (mode 'simple'): ${what} игнорируются — используйте mode 'shaped'.`);
        }
    }
    private _warnedSimple = false;

    private _assertLength(arr: unknown[] | null | undefined, method: string): void {
        if (arr && arr.length !== this._positions.length) {
            throw new Error(`PointCloud.${method}: length must match points count`);
        }
    }

    /** Обновляет только атрибуты стиля (позиции не трогаем). */
    private _refreshAttributes(): void {
        if (!this._geometry) return;
        this._fillAttributes();
    }

    /**
     * Полная пересборка после изменения набора точек. Если объект не
     * прикреплён к карте — данные уже сохранены, геометрию построит
     * `_onAttached` при `_attach`. Если прикреплён — `reproject()` из
     * SpatialObject сносит 3D через `_teardown` и переаттачит на тот же
     * слой, не трогая `layer._objects` (в отличие от `remove()`, который
     * вырезает объект из слоя).
     */
    private _rebuildAll(): void {
        if (this._map) this.reproject();
    }
}

// =====================================================================
// Point — одна точка (PointCloud из одного элемента)
// =====================================================================

/**
 * Point — одна точка на карте. Тот же рендер и тот же API, что у
 * PointCloud; конструктор принимает одну позицию.
 */
export class Point extends PointCloud {
    constructor(options: PointOptions) {
        const { position, ...rest } = options;
        super({ ...rest, positions: [position] });
    }

    /** Исходная позиция единственной точки (в CRS объекта). */
    getPoint(): SpatialPosition {
        return this.getPositions()[0];
    }
}

// =====================================================================
// Утилиты
// =====================================================================

function clamp01(v: number): number {
    return Math.max(0, Math.min(1, v));
}
