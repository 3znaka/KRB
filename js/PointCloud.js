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
import { SpatialObject } from './SpatialObject.js';
import { PointCloudLOD } from './PointCloudLOD.js';
import { createPointCountWorker } from './PointCloudWorker.js';
// =====================================================================
// Константы и шейдер
// =====================================================================
const SHAPE_CODE = {
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
    _positions;
    _crsCode;
    _crs = null;
    // ── Стиль ──
    _color;
    _colors;
    _size;
    _sizes;
    _shape;
    _shapes;
    _opacity;
    _strokeColor;
    _strokeWidth;
    _depthTest;
    _depthWrite;
    _altitudeMode;
    _mode;
    // ── Геометрия в плоских координатах карты ──
    /** Плоские координаты точек карты [x, z] (после project). */
    _planar = [];
    /** Высоты узлов (3-я координата позиции / h над эллипсоидом для ECEF). */
    _nodeHeights = [];
    /** lon/lat точек — нужны глобусу; null, если не переводятся. */
    _lonLat = [];
    /** Локальный origin в плоских координатах карты (среднее точек). */
    _origin = [0, 0];
    // ── Временные объекты ──
    _worldCenter = new THREE.Vector3();
    _tmpVec = new THREE.Vector3();
    // ── 3D-объекты ──
    _points = null;
    _geometry = null;
    _material = null;
    // ── LOD ──
    /** Пороговое число точек, с которого включается прореживание. */
    static LOD_MIN_POINTS = 50000;
    /** Макс. число точек, отрисовываемых за кадр (после прореживания). */
    _lodBudget = 800000;
    _lod = null;
    _minH = 0;
    _maxH = 0;
    _tmpPV = new THREE.Matrix4();
    _tmpFrustum = new THREE.Frustum();
    _tmpBox = new THREE.Box3();
    // ── Интерактив ──
    _unregisterInteraction = null;
    constructor(options) {
        super();
        if (options.zoomInterpolate)
            this.setZoomInterpolations(options.zoomInterpolate);
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
        this._positions = options.positions.map(p => [...p]);
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
        this._altitudeMode = options.altitudeMode ?? 'clampToGround';
        this._mode = options.mode ?? 'shaped';
        if (options.lodBudget !== undefined)
            this._lodBudget = Math.max(1, options.lodBudget);
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
    _onAttached(map) {
        this._crs = this._crsCode ? Projections.get(this._crsCode) : map.inputCRS;
        this._computePlanar(map);
        this._buildGeometry();
        this._buildLOD();
        if (this._exactCount) {
            if (!this._countWorker)
                this._countWorker = createPointCountWorker();
            this._sendPointsToCountWorker();
        }
        this._points = new THREE.Points(this._geometry, this._material);
        this._points.renderOrder = POINT_RENDER_ORDER;
        this._points.frustumCulled = false; // отсечение делаем сами через _update
        map.worldGroup.add(this._points);
        this._registerInteraction(map);
        this._isVisible = false;
    }
    _teardown() {
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
    _applyHidden() {
        if (this._points)
            this._points.visible = false;
    }
    _onTooltipChanged() {
        if (this._map)
            this._registerInteraction(this._map);
    }
    getLabelType() { return 'point'; }
    // =================================================================
    // Перевод позиций в плоские координаты карты
    // =================================================================
    /**
     * Переводит позиции в плоские координаты карты (`map.project`) и
     * вычисляет origin. Для глобуса дополнительно сохраняются lon/lat.
     */
    _computePlanar(map) {
        const n = this._positions.length;
        this._planar = new Array(n);
        this._nodeHeights = new Array(n);
        this._lonLat = new Array(n);
        this._boundsCache = null;
        for (let i = 0; i < n; i++) {
            const nn = this._normalizePosition(this._positions[i], this._crs);
            const p = nn.lonLat
                ? map.project(nn.lonLat, 'EPSG:4326')
                : map.project(nn.coord, this._crs);
            const x = Number.isFinite(p[0]) ? p[0] : 0;
            const z = Number.isFinite(p[1]) ? p[1] : 0;
            this._planar[i] = [x, z];
            this._nodeHeights[i] = nn.nodeHeight;
            this._lonLat[i] = this._lonLatOf(nn);
        }
        let sx = 0, sz = 0;
        for (const [x, z] of this._planar) {
            sx += x;
            sz += z;
        }
        this._origin = n > 0 ? [sx / n, sz / n] : [0, 0];
    }
    /** lon/lat (WGS-84) узла; null, если перевод невозможен. */
    _lonLatOf(nn) {
        if (nn.lonLat)
            return [nn.lonLat[0], nn.lonLat[1]];
        const src = this._crs ?? this._map?.inputCRS;
        if (!src || typeof src.toLonLat !== 'function')
            return null;
        const ll = src.toLonLat(nn.coord);
        if (!ll || !Number.isFinite(ll[0]) || !Number.isFinite(ll[1]))
            return null;
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
    _buildGeometry() {
        const n = this._planar.length;
        const positionArr = new Float32Array(n * 3);
        const colorArr = new Float32Array(n * 3);
        const [ox, oz] = this._origin;
        for (let i = 0; i < n; i++) {
            const [x, z] = this._planar[i];
            positionArr[i * 3] = Number.isFinite(x - ox) ? x - ox : 0;
            positionArr[i * 3 + 1] = Number.isFinite(this._nodeHeights[i]) ? this._nodeHeights[i] : 0;
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
    _createShapedMaterial() {
        const pixelRatio = this._map?.renderer?.getPixelRatio?.() ?? 1;
        return new THREE.ShaderMaterial({
            uniforms: {
                opacity: { value: this._opacity },
                pixelRatio: { value: pixelRatio },
                strokeColor: { value: new THREE.Color(this._strokeColor) },
                strokeWidth: { value: this._strokeWidth },
            },
            vertexShader: VERTEX_SHADER,
            fragmentShader: FRAGMENT_SHADER,
            transparent: this._opacity < 1,
            depthTest: this._depthTest,
            depthWrite: this._depthWrite,
        });
    }
    _createSimpleMaterial() {
        return new THREE.PointsMaterial({
            vertexColors: true,
            size: this._size,
            sizeAttenuation: false, // размер в пикселях экрана
            opacity: this._opacity,
            transparent: this._opacity < 1,
            depthTest: this._depthTest,
            depthWrite: this._depthWrite,
        });
    }
    /** Заполняет атрибуты цвета (и размер/форму в shaped-режиме). */
    _fillAttributes() {
        if (!this._geometry)
            return;
        const n = this._planar.length;
        const colorArr = this._geometry.getAttribute('color').array;
        const tmp = new THREE.Color();
        for (let i = 0; i < n; i++) {
            const c = tmp.set((this._colors ? this._colors[i] : this._color));
            colorArr[i * 3] = c.r;
            colorArr[i * 3 + 1] = c.g;
            colorArr[i * 3 + 2] = c.b;
        }
        this._geometry.getAttribute('color').needsUpdate = true;
        if (this._mode === 'shaped') {
            const sizeArr = this._geometry.getAttribute('size').array;
            const shapeArr = this._geometry.getAttribute('shape').array;
            for (let i = 0; i < n; i++) {
                sizeArr[i] = this._sizes ? this._sizes[i] : this._size;
                shapeArr[i] = SHAPE_CODE[this._shapes ? this._shapes[i] : this._shape];
            }
            this._geometry.getAttribute('size').needsUpdate = true;
            this._geometry.getAttribute('shape').needsUpdate = true;
        }
    }
    // =================================================================
    // Интерактив
    // =================================================================
    _registerInteraction(map) {
        if (!map.interaction || typeof map.interaction.register !== 'function')
            return;
        if (this._unregisterInteraction) {
            this._unregisterInteraction();
            this._unregisterInteraction = null;
        }
        if (!this._onClick && !this._onHover && !this._tooltipText)
            return;
        this._unregisterInteraction = map.interaction.register(this, {
            getMeshes: () => this._points ? [this._points] : [],
            getBoundingSphere: () => {
                const bs = this._geometry?.boundingSphere;
                if (!bs || !this._points)
                    return null;
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
    _update(map) {
        if (!this._map || !this._points)
            return;
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
        let lift = this._altitude;
        if (this._altitudeMode === 'clampToGround' && !map.globe) {
            const h = map.getSurfaceHeightAt(origin.x, origin.z);
            if (Number.isFinite(h))
                lift += h;
        }
        this._points.position.set(origin.x - wx, origin.y + lift - wy, origin.z - wz);
        this._worldCenter.set(origin.x, origin.y + lift, origin.z);
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
    _buildLOD() {
        const n = this._planar.length;
        // Порог LOD нужен только для большого числа точек: на малых облаках
        // прореживание не окупается и сбивает плотность.
        if (n < PointCloud.LOD_MIN_POINTS) {
            this._lod = null;
            return;
        }
        const [ox, oz] = this._origin;
        const xs = new Float32Array(n);
        const zs = new Float32Array(n);
        let minH = Infinity, maxH = -Infinity;
        for (let i = 0; i < n; i++) {
            xs[i] = this._planar[i][0] - ox;
            zs[i] = this._planar[i][1] - oz;
            const h = this._nodeHeights[i];
            if (h < minH)
                minH = h;
            if (h > maxH)
                maxH = h;
        }
        // Высота AABB ячеек: диапазон высот узлов облака (с запасом на altitude/рельеф).
        // Реальный вертикальный диапазон точек + altitude + небольшой запас
        // на рельеф (clampToGround). Запас 50 м, а не 1000 м: широкий бокс
        // ложно «видит» ячейки, которых на экране нет.
        const pad = 50;
        this._minH = (Number.isFinite(minH) ? minH : 0) + this._altitude - pad;
        this._maxH = (Number.isFinite(maxH) ? maxH : 0) + this._altitude + pad;
        this._lod = new PointCloudLOD(xs, zs, { budget: this._lodBudget });
    }
    /**
     * Выбирает уровни по камере и, если они изменились, переставляет индекс.
     * Камера переводится в систему origin облака (мировые координаты минус origin).
     */
    _updateLOD(map, origin) {
        const lod = this._lod;
        if (!lod || !this._geometry)
            return;
        // Фрустум камеры в мировых координатах — учитывает pitch и любой поворот.
        const cam = map.camera;
        this._tmpPV.multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse);
        this._tmpFrustum.setFromProjectionMatrix(this._tmpPV);
        // AABB ячейки: плоская (x, z) ячейки + высота облака, переведённые в мир.
        const yMin = origin.y + this._minH;
        const yMax = origin.y + this._maxH;
        const changed = lod.update((minX, maxX, minZ, maxZ) => {
            this._tmpBox.min.set(origin.x + minX, yMin, origin.z + minZ);
            this._tmpBox.max.set(origin.x + maxX, yMax, origin.z + maxZ);
            return this._tmpFrustum.intersectsBox(this._tmpBox);
        });
        // Индекс меняем только при реальной смене уровней (changed).
        // Проверку isDirty не используем: она дублирует changed и стоит O(ячеек).
        if (changed) {
            const idx = lod.buildIndex();
            const attr = this._geometry.index;
            if (attr && attr.array.length >= idx.length) {
                // Тот же буфер на GPU: записываем префикс и рисуем drawRange.
                attr.array.set(idx);
                attr.needsUpdate = true;
                this._geometry.setDrawRange(0, idx.length);
            }
            else {
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
    _originWorld(map) {
        if (map.globe) {
            const ll = this._centerLonLat();
            if (!ll)
                return null;
            const p = map.projectSurfacePoint(ll, 'EPSG:4326', 0, this._tmpVec, null);
            return p ? { x: p.x, y: p.y, z: p.z } : null;
        }
        const wg = map.worldGroup ? map.worldGroup.position : null;
        const x = this._origin[0] + (wg ? wg.x : 0);
        const z = this._origin[1] + (wg ? wg.z : 0);
        if (!Number.isFinite(x) || !Number.isFinite(z))
            return null;
        return { x, y: wg ? wg.y : 0, z };
    }
    /** lon/lat центра облака (среднее по точкам, где перевод известен). */
    _centerLonLat() {
        let sx = 0, sy = 0, k = 0;
        for (const ll of this._lonLat) {
            if (!ll)
                continue;
            sx += ll[0];
            sy += ll[1];
            k++;
        }
        return k ? [sx / k, sy / k] : null;
    }
    // =================================================================
    // Публичный API: стиль
    // =================================================================
    /** Цвет по умолчанию (для точек без персонального цвета). */
    setColor(color) {
        this._color = color;
        this._refreshAttributes();
        return this;
    }
    getColor() { return this._color; }
    /** Персональные цвета по точкам; `null` — убрать персональные. */
    setColors(colors) {
        this._assertLength(colors, 'setColors');
        this._colors = colors ? [...colors] : null;
        this._refreshAttributes();
        return this;
    }
    getColors() { return this._colors ? [...this._colors] : null; }
    /** Размер по умолчанию, px. */
    setSize(size) {
        if (!(size >= 0) || !Number.isFinite(size))
            return this;
        this._size = size;
        if (this._mode === 'simple') {
            if (this._material)
                this._material.size = size;
        }
        else {
            this._refreshAttributes();
        }
        return this;
    }
    getSize() { return this._size; }
    /** Персональные размеры, px; `null` — убрать персональные. */
    setSizes(sizes) {
        this._assertLength(sizes, 'setSizes');
        this._warnSimpleIgnores('sizes');
        this._sizes = sizes ? [...sizes] : null;
        this._refreshAttributes();
        return this;
    }
    getSizes() { return this._sizes ? [...this._sizes] : null; }
    /** Форма по умолчанию. */
    setShape(shape) {
        if (!(shape in SHAPE_CODE))
            return this;
        this._warnSimpleIgnores('shape');
        this._shape = shape;
        this._refreshAttributes();
        return this;
    }
    getShape() { return this._shape; }
    /** Персональные формы; `null` — убрать персональные. */
    setShapes(shapes) {
        this._assertLength(shapes, 'setShapes');
        this._shapes = shapes ? [...shapes] : null;
        this._refreshAttributes();
        return this;
    }
    getShapes() { return this._shapes ? [...this._shapes] : null; }
    setOpacity(opacity) {
        this._opacity = clamp01(opacity);
        if (this._material) {
            if (this._mode === 'shaped')
                this._material.uniforms.opacity.value = this._opacity;
            else
                this._material.opacity = this._opacity;
            const transparent = this._opacity < 1;
            if (this._material.transparent !== transparent) {
                this._material.transparent = transparent;
                this._material.needsUpdate = true;
            }
        }
        return this;
    }
    getOpacity() { return this._opacity; }
    /** Окантовка: цвет и толщина (px); width 0 — без окантовки. */
    setStroke(color, width) {
        this._strokeColor = color;
        this._strokeWidth = Math.max(0, width);
        // Окантовка есть только в shaped-режиме (в simple её нет).
        if (this._material && this._mode === 'shaped') {
            this._material.uniforms.strokeColor.value.set(color);
            this._material.uniforms.strokeWidth.value = this._strokeWidth;
        }
        return this;
    }
    getStroke() {
        return { color: this._strokeColor, width: this._strokeWidth };
    }
    setDepthTest(depthTest) {
        this._depthTest = !!depthTest;
        if (this._material) {
            this._material.depthTest = this._depthTest;
            this._material.needsUpdate = true;
        }
        return this;
    }
    getDepthTest() { return this._depthTest; }
    setDepthWrite(depthWrite) {
        this._depthWrite = !!depthWrite;
        if (this._material) {
            this._material.depthWrite = this._depthWrite;
            this._material.needsUpdate = true;
        }
        return this;
    }
    getDepthWrite() { return this._depthWrite; }
    setAltitudeMode(mode) {
        this._altitudeMode = mode;
        return this;
    }
    getAltitudeMode() { return this._altitudeMode; }
    /**
     * Меняет CRS координат точек. Нужен, когда CRS становится известен после
     * создания (например, E57 читает его из файла). Если объект на карте —
     * геометрия пересобирается.
     */
    setCRS(code) {
        this._crsCode = code;
        if (this._map)
            this._rebuildAll();
        return this;
    }
    getCRS() { return this._crsCode; }
    // =================================================================
    // Публичный API: точки
    // =================================================================
    /** Число точек. */
    getCount() { return this._positions.length; }
    /** Копия исходных позиций (в CRS объекта). */
    getPositions() {
        return this._positions.map(p => [...p]);
    }
    /**
     * Заменяет все точки. Персональные стили сбрасываются, если их длина
     * не совпадает с новым числом точек.
     */
    setPositions(positions) {
        if (!positions || positions.length < 1)
            return this;
        this._positions = positions.map(p => [...p]);
        const n = this._positions.length;
        if (this._colors && this._colors.length !== n)
            this._colors = null;
        if (this._sizes && this._sizes.length !== n)
            this._sizes = null;
        if (this._shapes && this._shapes.length !== n)
            this._shapes = null;
        this._rebuildAll();
        return this;
    }
    /** Добавляет точку. Персональные стили дополняются значениями по умолчанию. */
    addPoint(datum) {
        const idx = this._positions.length;
        this._positions.push([...datum.position]);
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
    getPoints() {
        return this._positions.map((p, i) => ({
            position: [...p],
            color: this._colors ? this._colors[i] : this._color,
            size: this._sizes ? this._sizes[i] : this._size,
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
    getBounds(crs = 'EPSG:4326') {
        const code = typeof crs === 'string' ? crs : null;
        if (code && code !== 'EPSG:4326')
            return null; // поддерживаем только WGS-84 (этого достаточно для fitTo)
        if (this._boundsCache)
            return this._boundsCache;
        let minLon = Infinity, minLat = Infinity, maxLon = -Infinity, maxLat = -Infinity;
        for (const ll of this._lonLat) {
            if (!ll)
                continue;
            if (ll[0] < minLon)
                minLon = ll[0];
            if (ll[0] > maxLon)
                maxLon = ll[0];
            if (ll[1] < minLat)
                minLat = ll[1];
            if (ll[1] > maxLat)
                maxLat = ll[1];
        }
        if (!Number.isFinite(minLon))
            return null;
        this._boundsCache = [[minLon, minLat], [maxLon, maxLat]];
        return this._boundsCache;
    }
    _boundsCache = null;
    /** Центр облака в WGS-84 `[lon, lat]` (среднее точек), либо `null`. */
    getCenter() {
        const crs = this._crs ?? (this._crsCode ? Projections.get(this._crsCode) : null);
        const pts = this._positions.map(p => this._normalizePosition(p, crs));
        let sx = 0, sy = 0, k = 0;
        for (const nn of pts) {
            const ll = nn.lonLat ?? (crs ? crs.toLonLat(nn.coord) : null);
            if (!ll || !Number.isFinite(ll[0]) || !Number.isFinite(ll[1]))
                continue;
            sx += ll[0];
            sy += ll[1];
            k++;
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
    setLodBudget(budget) {
        if (!(budget >= 1) || !Number.isFinite(budget))
            return this;
        this._lodBudget = Math.floor(budget);
        if (this._map)
            this._buildLOD();
        return this;
    }
    getLodBudget() { return this._lodBudget; }
    /**
     * Статистика для отладки:
     *  - drawn: точек, которые реально уходят на GPU в этом кадре;
     *  - visibleTotal: точек в видимых ячейках без прореживания;
     *  - total: всего точек в облаке.
     * Без LOD (мало точек) drawn == visibleTotal == total.
     */
    getLodStats() {
        const total = this._planar.length;
        if (!this._lod || !this._geometry || !this._map) {
            return { drawn: total, visibleTotal: total, total, inFrustum: total };
        }
        // Точный счёт — только по запросу (exactCount) и в воркере: кадр его не ждёт.
        if (this._exactCount)
            this._requestExactCount();
        return {
            drawn: this._lod.getDrawnTotal(),
            visibleTotal: this._lod.getVisibleTotal(),
            total,
            inFrustum: this._inFrustumCache,
        };
    }
    /** Последний результат точного счёта из воркера (обновляется асинхронно). */
    _inFrustumCache = 0;
    _inFrustumAt = -Infinity;
    _inFrustumBusy = false;
    _exactCount = false;
    _countWorker = null;
    _countPlanes = new Float32Array(24);
    /** Включает/выключает точный счёт (диагностика). По умолчанию выключен. */
    setExactCount(on) {
        this._exactCount = !!on;
        if (on && !this._countWorker)
            this._countWorker = createPointCountWorker();
        if (on && this._countWorker && this._map)
            this._sendPointsToCountWorker();
        return this;
    }
    /** Отправляет позиции точек воркеру (один раз, при смене данных). */
    _sendPointsToCountWorker() {
        const w = this._countWorker;
        const origin = this._map ? this._originWorld(this._map) : null;
        if (!w || !origin)
            return;
        const n = this._planar.length;
        const xs = new Float32Array(n), ys = new Float32Array(n), zs = new Float32Array(n);
        const [ox, oz] = this._origin;
        for (let i = 0; i < n; i++) {
            const p = this._planar[i];
            xs[i] = origin.x + (p[0] - ox);
            ys[i] = origin.y + this._nodeHeights[i] + this._altitude;
            zs[i] = origin.z + (p[1] - oz);
        }
        w.setPoints(xs, ys, zs);
    }
    /**
     * Запрашивает точный счёт у воркера, не чаще раза в секунду и не параллельно.
     * Главный поток лишь копирует 24 числа фрустума — O(1).
     */
    _requestExactCount() {
        const now = performance.now();
        if (this._inFrustumBusy || now - this._inFrustumAt < 1000)
            return;
        const map = this._map;
        const cam = map.camera;
        this._tmpPV.multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse);
        this._tmpFrustum.setFromProjectionMatrix(this._tmpPV);
        // Плоскости фрустума: (nx, ny, nz, d), внутрь — n·p + d >= 0.
        const planes = this._tmpFrustum.planes;
        for (let k = 0; k < 6; k++) {
            const p = planes[k];
            this._countPlanes[k * 4] = p.normal.x;
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
    getMode() { return this._mode; }
    /** В simple-режиме размер/форму на точку не рисуем: предупреждаем один раз. */
    _warnSimpleIgnores(what) {
        if (this._mode !== 'simple')
            return;
        if (!this._warnedSimple) {
            this._warnedSimple = true;
            console.warn(`PointCloud (mode 'simple'): ${what} игнорируются — используйте mode 'shaped'.`);
        }
    }
    _warnedSimple = false;
    _assertLength(arr, method) {
        if (arr && arr.length !== this._positions.length) {
            throw new Error(`PointCloud.${method}: length must match points count`);
        }
    }
    /** Обновляет только атрибуты стиля (позиции не трогаем). */
    _refreshAttributes() {
        if (!this._geometry)
            return;
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
    _rebuildAll() {
        if (this._map)
            this.reproject();
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
    constructor(options) {
        const { position, ...rest } = options;
        super({ ...rest, positions: [position] });
    }
    /** Исходная позиция единственной точки (в CRS объекта). */
    getPoint() {
        return this.getPositions()[0];
    }
}
// =====================================================================
// Утилиты
// =====================================================================
function clamp01(v) {
    return Math.max(0, Math.min(1, v));
}
