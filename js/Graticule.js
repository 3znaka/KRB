/**
 * Graticule — картографическая сетка.
 * @module graticule
 */
import { THREE, Line2, LineMaterial, LineGeometry, } from './js_TP/tpb.js';
import { Projections } from './Projections.js';
import { resolveUnitScale, scaleGeometry, engineeringCrsWkt } from './UnitScale.js';
// ─────────────────────────────────────────────────────────────────────
// «Красивые» шаги
// ─────────────────────────────────────────────────────────────────────
const NICE_DEGREE_STEPS = [
    180, 90, 60, 30, 20, 15, 10, 5, 2, 1,
    30 / 60, 20 / 60, 15 / 60, 10 / 60, 5 / 60, 2 / 60, 1 / 60,
    30 / 3600, 20 / 3600, 15 / 3600, 10 / 3600, 5 / 3600, 2 / 3600, 1 / 3600,
    0.5 / 3600, 0.2 / 3600, 0.1 / 3600,
];
function niceLinearStep(target) {
    if (!(target > 0) || !isFinite(target))
        return 1;
    const exp = Math.floor(Math.log10(target));
    const base = Math.pow(10, exp);
    const candidates = [base, 2 * base, 5 * base, 10 * base];
    let best = candidates[0];
    let bestDiff = Math.abs(Math.log(candidates[0] / target));
    for (const v of candidates) {
        const d = Math.abs(Math.log(v / target));
        if (d < bestDiff) {
            best = v;
            bestDiff = d;
        }
    }
    return best;
}
function niceDegreeStep(target) {
    if (!(target > 0) || !isFinite(target))
        return 1;
    let best = NICE_DEGREE_STEPS[0];
    let bestDiff = Math.abs(Math.log(NICE_DEGREE_STEPS[0] / target));
    for (const v of NICE_DEGREE_STEPS) {
        const d = Math.abs(Math.log(v / target));
        if (d < bestDiff) {
            best = v;
            bestDiff = d;
        }
    }
    return best;
}
// ─────────────────────────────────────────────────────────────────────
// Нормализация StepValue
// ─────────────────────────────────────────────────────────────────────
/** Превращает «сырое» значение шага в число (>0) или `null` (адаптив). */
function normalizeStep(v) {
    return v != null && isFinite(v) && v > 0 ? v : null;
}
/** Разбирает `StepValue` в пару `{ lat, lon }`, где `null` = адаптив. */
function parseStepValue(sv) {
    if (sv == null)
        return { lat: null, lon: null };
    if (typeof sv === 'number') {
        const v = normalizeStep(sv);
        return { lat: v, lon: v };
    }
    if (Array.isArray(sv)) {
        // Порядок как в OpenLayers: [lon, lat].
        // Array.isArray не сужает readonly tuples — приводим явно.
        const arr = sv;
        return { lat: normalizeStep(arr[1]), lon: normalizeStep(arr[0]) };
    }
    // Осталась только объектная форма.
    const obj = sv;
    return { lat: normalizeStep(obj.lat), lon: normalizeStep(obj.lon) };
}
// ─────────────────────────────────────────────────────────────────────
// Константы
// ─────────────────────────────────────────────────────────────────────
const SAMPLE_COUNT = 32;
const MAX_CACHED_LINES = 3000;
const PRUNE_PADDING_FACTOR = 3;
const LABEL_MARGIN = 4;
const FULL_WORLD_STEP_DEG = 1;
const FULL_WORLD_STEP_FRAC = 0.01;
const INWARD_ANCHOR = {
    top: 'bottom',
    bottom: 'top',
    left: 'right',
    right: 'left',
};
// ─────────────────────────────────────────────────────────────────────
// Внутренние типы
// ─────────────────────────────────────────────────────────────────────
class GridLabelSource {
    _graticule;
    _anchor = null;
    _text;
    constructor(graticule, text) {
        this._graticule = graticule;
        this._text = text;
    }
    getText() { return this._text; }
    getTextStyle() { return this._graticule._labelStyle; }
    getTextZoomBounds() { return { min: -Infinity, max: Infinity }; }
    isVisible() {
        if (!this._graticule._showLabels)
            return false;
        const z = this._graticule._map?.continuousZoom ?? 0;
        if (z < this._graticule._labelMinZoom || z > this._graticule._labelMaxZoom)
            return false;
        return this._anchor?.visibleOnScreen ?? false;
    }
    getLabelType() { return 'point'; }
    getPriority() {
        if (!this._anchor)
            return this._graticule._labelPriority;
        return this._graticule._labelPriority + this._anchor.roundness;
    }
    getScreenPosition() { return this._anchor?.screenPos ?? null; }
    getTitleVariableAnchor() {
        if (!this._anchor)
            return null;
        return [INWARD_ANCHOR[this._anchor.renderSide]];
    }
    getTitleAlign() { return 'center'; }
    getTitleVerticalAlign() { return 'center'; }
}
export class Graticule {
    _map = null;
    _crsCode;
    _crsRaw = null;
    /** Шаг по широте (параллели). `null` — адаптив. */
    _stepLat;
    /** Шаг по долготе (меридианы). `null` — адаптив. */
    _stepLon;
    _targetPixelsBetweenLines;
    _currentStepLat = 0;
    _currentStepLon = 0;
    _maskGroup = null;
    _maskEnabled;
    _color;
    _width;
    _opacity;
    _lineDasharray;
    _lineDashOffset;
    _minZoom;
    _maxZoom;
    _visible = true;
    _renderOrder;
    _showLabels;
    _labelStyle;
    _labelMinZoom;
    _labelMaxZoom;
    _labelPriority;
    _labelSides;
    _altitude;
    _debug;
    _material = null;
    _linesGroup = null;
    _lineInfos = [];
    _needsRebuild = true;
    _genMode = 'full-world';
    _lastCamMatrix = new Float32Array(16);
    _lastProjMatrix = new Float32Array(16);
    _lastWgMatrix = new Float32Array(16);
    _lastActiveLabelIds = null;
    _scratchVx = new Float64Array(SAMPLE_COUNT + 2);
    _scratchVy = new Float64Array(SAMPLE_COUNT + 2);
    _scratchVz = new Float64Array(SAMPLE_COUNT + 2);
    _tmpVec = new THREE.Vector3();
    /** Центр и радиус силуэта глобуса на экране (для выбора переходов). */
    _silCenter = null;
    _silRadius = null;
    _mvMatrix = new THREE.Matrix4();
    constructor(options = {}) {
        this._crsCode = options.crs ?? 'EPSG:4326';
        // ── Шаги по осям ──
        const parsed = parseStepValue(options.step);
        this._stepLat = options.stepLat !== undefined
            ? normalizeStep(options.stepLat)
            : parsed.lat;
        this._stepLon = options.stepLon !== undefined
            ? normalizeStep(options.stepLon)
            : parsed.lon;
        // Мастер-переключатель adaptiveStep (для обратной совместимости).
        if (options.adaptiveStep === true) {
            this._stepLat = null;
            this._stepLon = null;
        }
        else if (options.adaptiveStep === false) {
            if (this._stepLat == null) {
                console.warn('[Graticule] adaptiveStep=false, but stepLat is not set — freezing to 1');
                this._stepLat = 1;
            }
            if (this._stepLon == null) {
                console.warn('[Graticule] adaptiveStep=false, but stepLon is not set — freezing to 1');
                this._stepLon = 1;
            }
        }
        this._targetPixelsBetweenLines = options.targetPixelsBetweenLines ?? 100;
        this._color = options.color ?? '#666666';
        this._width = options.width ?? 1;
        this._opacity = options.opacity ?? 1;
        this._lineDasharray = options.lineDasharray ?? null;
        this._lineDashOffset = options.lineDashOffset ?? 0;
        this._minZoom = options.minZoom ?? -Infinity;
        this._maxZoom = options.maxZoom ?? Infinity;
        this._renderOrder = options.renderOrder ?? 100000;
        this._showLabels = options.showLabels ?? true;
        this._labelStyle = options.labelStyle ?? {
            fontSize: '10px',
            fontFamily: 'sans-serif',
            color: '#797979',
            padding: '5px 5px',
        };
        this._labelMinZoom = options.labelMinZoom ?? -Infinity;
        this._labelMaxZoom = options.labelMaxZoom ?? Infinity;
        this._labelPriority = options.labelPriority ?? 1e9;
        this._labelSides = new Set(options.labelSides ?? ['top', 'bottom', 'left', 'right']);
        this._altitude = options.altitude ?? 0;
        this._debug = options.debug ?? false;
        this._maskEnabled = options.maskGaps ?? true;
    }
    // ─────────────────────────────────────────────────────────────────
    // Сеттеры / геттеры шага
    // ─────────────────────────────────────────────────────────────────
    /** Задать шаг сразу по обеим осям (или разный — см. `StepValue`). */
    setStep(step) {
        const parsed = parseStepValue(step);
        this._stepLat = parsed.lat;
        this._stepLon = parsed.lon;
        this._needsRebuild = true;
        this._lastActiveLabelIds = null;
        return this;
    }
    /** Возвращает lon-шаг (для обратной совместимости). */
    getStep() { return this._currentStepLon; }
    /** Задать шаг только для параллелей (широт). `null` — адаптив. */
    setStepLat(step) {
        this._stepLat = normalizeStep(step);
        this._needsRebuild = true;
        this._lastActiveLabelIds = null;
        return this;
    }
    /** Задать шаг только для меридианов (долгот). `null` — адаптив. */
    setStepLon(step) {
        this._stepLon = normalizeStep(step);
        this._needsRebuild = true;
        this._lastActiveLabelIds = null;
        return this;
    }
    getStepLat() { return this._currentStepLat; }
    getStepLon() { return this._currentStepLon; }
    getSteps() {
        return { lat: this._currentStepLat, lon: this._currentStepLon };
    }
    isAdaptiveStep() {
        return this._stepLat === null || this._stepLon === null;
    }
    isAdaptiveStepLat() { return this._stepLat === null; }
    isAdaptiveStepLon() { return this._stepLon === null; }
    setAdaptiveStep(on) {
        if (on) {
            this._stepLat = null;
            this._stepLon = null;
        }
        else {
            if (this._stepLat === null)
                this._stepLat = this._currentStepLat || 1;
            if (this._stepLon === null)
                this._stepLon = this._currentStepLon || 1;
        }
        this._needsRebuild = true;
        this._lastActiveLabelIds = null;
        return this;
    }
    // ─────────────────────────────────────────────────────────────────
    // Прочие сеттеры / геттеры
    // ─────────────────────────────────────────────────────────────────
    setTargetPixelsBetweenLines(px) {
        if (px > 0) {
            this._targetPixelsBetweenLines = px;
            this._needsRebuild = true;
        }
        return this;
    }
    getTargetPixelsBetweenLines() { return this._targetPixelsBetweenLines; }
    setCrs(code) {
        if (code === this._crsCode)
            return this;
        this._crsCode = code;
        try {
            this._crsRaw = this._map ? Projections.getRaw(code) : null;
        }
        catch {
            this._crsRaw = null;
        }
        this._needsRebuild = true;
        this._lastActiveLabelIds = null;
        if (this._map)
            this._createStencilMask();
        return this;
    }
    getCrs() { return this._crsCode; }
    setColor(color) {
        this._color = color;
        if (this._material) {
            this._material.color.set(color);
            this._material.needsUpdate = true;
        }
        return this;
    }
    getColor() { return this._color; }
    setWidth(width) {
        if (!(width > 0))
            return this;
        this._width = width;
        if (this._material) {
            this._material.linewidth = width;
            this._material.needsUpdate = true;
        }
        return this;
    }
    getWidth() { return this._width; }
    setOpacity(opacity) {
        const v = Math.max(0, Math.min(1, opacity));
        this._opacity = v;
        if (this._material) {
            this._material.opacity = v;
            const tr = v < 1;
            if (this._material.transparent !== tr) {
                this._material.transparent = tr;
                this._material.needsUpdate = true;
            }
        }
        return this;
    }
    getOpacity() { return this._opacity; }
    setLineDasharray(v) {
        this._lineDasharray = v;
        if (this._material) {
            if (v == null) {
                this._material.dashed = false;
            }
            else {
                const [d, g] = typeof v === 'number' ? [v, v] : [v[0], v[1]];
                this._material.dashed = true;
                this._material.dashSize = d;
                this._material.gapSize = g;
                this._material.dashOffset = this._lineDashOffset;
            }
            this._material.needsUpdate = true;
        }
        return this;
    }
    getLineDasharray() { return this._lineDasharray; }
    setLineDashOffset(v) {
        this._lineDashOffset = v;
        if (this._material) {
            this._material.dashOffset = v;
            this._material.needsUpdate = true;
        }
        return this;
    }
    getLineDashOffset() { return this._lineDashOffset; }
    setVisible(v) {
        this._visible = !!v;
        if (this._linesGroup)
            this._linesGroup.visible = this._visible;
        return this;
    }
    isVisible() { return this._visible; }
    setLabelsVisible(v) {
        this._showLabels = !!v;
        this._lastActiveLabelIds = null;
        return this;
    }
    isLabelsVisible() { return this._showLabels; }
    setLabelStyle(style) {
        this._labelStyle = { ...style };
        this._lastActiveLabelIds = null;
        return this;
    }
    getLabelStyle() { return { ...this._labelStyle }; }
    setLabelSides(sides) {
        this._labelSides = new Set(sides);
        this._needsRebuild = true;
        this._lastActiveLabelIds = null;
        return this;
    }
    getLabelSides() { return Array.from(this._labelSides); }
    setZoomBounds(min, max) {
        this._minZoom = min;
        this._maxZoom = max;
        return this;
    }
    getZoomBounds() { return { min: this._minZoom, max: this._maxZoom }; }
    setRenderOrder(order) {
        this._renderOrder = order;
        for (const info of this._lineInfos) {
            if (!info.line2)
                continue;
            if (typeof info.line2.traverse === 'function') {
                info.line2.traverse((obj) => { obj.renderOrder = order; });
            }
            else {
                info.line2.renderOrder = order;
            }
        }
        return this;
    }
    getRenderOrder() { return this._renderOrder; }
    // ─────────────────────────────────────────────────────────────────
    // Layer lifecycle
    // ─────────────────────────────────────────────────────────────────
    /** Режим глобуса: карта в globe-режиме и есть поверхность эллипсоида. */
    _isGlobe() {
        const m = this._map;
        return !!(m && m.globe && m.surface && typeof m.projectSurfaceVertex === 'function');
    }
    /**
     * Глобус, параллель: подписи слева и справа от видимой дуги.
     * Видимая точка — не за горизонтом и попадает в экран. Левый якорь — видимая точка
     * с наименьшим экранным X, правый — с наибольшим.
     */
    _assignParallelSilhouetteAnchors(info, pts, mvMatrix, projMatrix, W, H, nearZ) {
        // Силуэт глобуса на экране: центр диска и радиус (в пикселях).
        const disk = this._silhouetteDisk(mvMatrix, projMatrix, W, H, nearZ);
        if (!disk) {
            for (const lbl of info.labels) {
                lbl.screenPos = null;
                lbl.visibleOnScreen = false;
            }
            return;
        }
        const OUTSET = 30; // px наружу от силуэта
        // Центр и радиус силуэта — для выбора переходов на самом краю диска.
        this._silCenter = { x: disk.cx, y: disk.cy };
        this._silRadius = disk.r;
        // Экранные точки параллели (null — за горизонтом или вне near).
        const scr = new Array(pts.length);
        for (let i = 0; i < pts.length; i++) {
            if (this._isPointOccluded(pts[i])) {
                scr[i] = null;
                continue;
            }
            const v = this._tmpVec.set(pts[i][0], pts[i][1], pts[i][2]).applyMatrix4(mvMatrix);
            scr[i] = this._projectPointToScreen(v.x, v.y, v.z, projMatrix, W, H, nearZ);
        }
        for (const lbl of info.labels) {
            const edge = this._findSilhouetteCrossing(scr, lbl.side, pts, mvMatrix, projMatrix, W, H, nearZ);
            if (!edge) {
                lbl.screenPos = null;
                lbl.visibleOnScreen = false;
                continue;
            }
            lbl.anchorIdx = edge.idx;
            // Итоговая позиция — после всех расчётов: левые на OUTSET px левее,
            // правые на OUTSET px правее (по X).
            const dxSide = lbl.side === 'left' ? -OUTSET : OUTSET;
            lbl.screenPos = {
                x: edge.x + dxSide,
                y: edge.y,
            };
            lbl.renderSide = lbl.side;
            lbl.visibleOnScreen = true;
        }
    }
    /**
     * Точка силуэта на параллели: граница видимой дуги (переход видно ↔ невидно между
     * соседними сэмплами), интерполированная по экрану. Выбираем переход на нужной стороне:
     * для 'left' — тот, у которого экранный X минимален, для 'right' — максимален.
     * Интерполяция даёт непрерывную позицию, поэтому подпись плавно скользит по параллели.
     */
    _findSilhouetteCrossing(scr, side, pts, mvMatrix, projMatrix, W, H, nearZ) {
        // Порог видимости: точка на силуэте, если cos(угла между нормалью и камерой) = R/C.
        const surf = this._map?.surface;
        const R = surf?.b ?? surf?.a ?? 6378137;
        const camLocal = this._tmpVec.set(0, 0, 0).applyMatrix4(this._mvMatrix.clone().invert());
        const C = camLocal.length();
        const thr = C > 0 ? R / C : 1;
        // cos в точке p (локальные координаты) относительно направления на камеру
        const cosAt = (p) => {
            const pl = Math.hypot(p[0], p[1], p[2]) || 1;
            return (p[0] * camLocal.x + p[1] * camLocal.y + p[2] * camLocal.z) / (pl * C);
        };
        let best = null;
        let bestScore = Infinity;
        const n = scr.length;
        for (let i = 0; i < n; i++) {
            const j = (i + 1) % n;
            const a = scr[i];
            const b = scr[j];
            // переход видимость ↔ невидимость между соседними сэмплами
            if (!!a === !!b)
                continue;
            const iv = a ? i : j; // видимый сэмпл
            const ih = a ? j : i; // невидимый
            const vis = a ?? b;
            // Интерполяция по cos: находим долю t между видимым и невидимым,
            // где cos проходит через порог → точка на силуэте, плавно меняется.
            const cv = cosAt(pts[iv]);
            const ch = cosAt(pts[ih]);
            const den = cv - ch;
            const t = Math.abs(den) > 1e-12 ? Math.min(1, Math.max(0, (cv - thr) / den)) : 0;
            const pa = pts[iv], pb = pts[ih];
            const p = [
                pa[0] + (pb[0] - pa[0]) * t,
                pa[1] + (pb[1] - pa[1]) * t,
                pa[2] + (pb[2] - pa[2]) * t,
            ];
            const v = this._tmpVec.set(p[0], p[1], p[2]).applyMatrix4(mvMatrix);
            const sp = this._projectPointToScreen(v.x, v.y, v.z, projMatrix, W, H, nearZ)
                ?? { x: vis.x, y: vis.y };
            // Переход должен лежать НА силуэте, а не внутри диска: берём только тех, у кого
            // радиус от центра диска не меньше радиуса силуэта (с запасом на погрешность).
            const cx = this._silCenter?.x ?? sp.x;
            const cy = this._silCenter?.y ?? sp.y;
            const rad = Math.hypot(sp.x - cx, sp.y - cy);
            const rimR = this._silRadius ?? rad;
            if (rad < rimR * 0.97)
                continue;
            // Среди силуэтных переходов выбираем нужную сторону по экранному X
            // (min для left, max для right) — это стабильнее, чем минимум по всем.
            const score = side === 'left' ? sp.x : -sp.x;
            if (score < bestScore) {
                bestScore = score;
                best = { x: sp.x, y: sp.y, idx: iv };
            }
        }
        return best;
    }
    /**
     * Края глобуса видны, если диск целиком помещается в экран. Если диск выходит
     * за границы (глобус заполняет экран), силуэтные подписи не имеют смысла.
     */
    _silhouetteVisible(mvMatrix, projMatrix, W, H, nearZ) {
        const disk = this._silhouetteDisk(mvMatrix, projMatrix, W, H, nearZ);
        if (!disk)
            return false;
        return disk.cx - disk.r >= 0 && disk.cx + disk.r <= W
            && disk.cy - disk.r >= 0 && disk.cy + disk.r <= H;
    }
    /**
     * Силуэт глобуса на экране: центр диска (проекция центра Земли) и его радиус.
     * Радиус — проекция точки на видимом краю: расстояние от центра до камеры C,
     * угловой радиус диска α = asin(R/C), точка края — на касательной плоскости.
     */
    _silhouetteDisk(mvMatrix, projMatrix, W, H, nearZ) {
        const surf = this._map?.surface;
        const R = surf?.b ?? surf?.a ?? 6378137;
        // камера в системе worldGroup — обратная матрица mv
        const camLocal = this._tmpVec.set(0, 0, 0).applyMatrix4(this._mvMatrix.clone().invert());
        const C = camLocal.length();
        if (!(C > R * 1.0001))
            return null;
        // центр Земли (начало координат local) → экран; mvMatrix переводит в view-space
        const cRaw = this._projectRaw(0, 0, 0, projMatrix, W, H, mvMatrix);
        if (!cRaw)
            return null;
        // точка края диска: сдвиг от центра по направлению, перпендикулярному к камере
        const d = R * R / C; // расстояние до плоскости края
        const rEdge = R * Math.sqrt(1 - (R * R) / (C * C)); // радиус края в мировых ед.
        const n = camLocal.clone().normalize(); // направление на камеру
        // перпендикуляр к n (любой, в плоскости края)
        const up = Math.abs(n.y) < 0.9 ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3(1, 0, 0);
        const e1 = new THREE.Vector3().crossVectors(n, up).normalize();
        const edgePt = n.clone().multiplyScalar(d).add(e1.multiplyScalar(rEdge));
        const eRaw = this._projectRaw(edgePt.x, edgePt.y, edgePt.z, projMatrix, W, H, mvMatrix);
        if (!eRaw)
            return null;
        const r = Math.hypot(eRaw.x - cRaw.x, eRaw.y - cRaw.y);
        return { cx: cRaw.x, cy: cRaw.y, r };
    }
    /** Проекция точки без отсечения по экрану (для центра и края диска). */
    _projectRaw(x, y, z, projMatrix, W, H, mvMatrix) {
        const v = this._tmpVec.set(x, y, z);
        if (mvMatrix)
            v.applyMatrix4(mvMatrix);
        const t = v.applyMatrix4(projMatrix);
        const sx = (t.x * 0.5 + 0.5) * W;
        const sy = (-t.y * 0.5 + 0.5) * H;
        if (!Number.isFinite(sx) || !Number.isFinite(sy))
            return null;
        return { x: sx, y: sy };
    }
    /** View-space точка → экранные координаты; null, если за near или вне экрана. */
    _projectPointToScreen(x, y, z, projMatrix, W, H, nearZ) {
        if (z > nearZ)
            return null;
        const t = this._tmpVec.set(x, y, z).applyMatrix4(projMatrix);
        const sx = (t.x * 0.5 + 0.5) * W;
        const sy = (-t.y * 0.5 + 0.5) * H;
        if (!Number.isFinite(sx) || !Number.isFinite(sy))
            return null;
        if (sx < 0 || sx > W || sy < 0 || sy > H)
            return null;
        return { x: sx, y: sy };
    }
    /**
     * Точка сетки (в local-координатах worldGroup, как points3D) за горизонтом?
     * Переводим в мировые координаты и спрашиваем карту (isWorldPointOccluded).
     */
    _isPointOccluded(p) {
        const m = this._map;
        if (!m || typeof m.isWorldPointOccluded !== 'function')
            return false;
        const v = this._tmpVec.set(p[0], p[1], p[2]);
        const wg = m.worldGroup;
        if (wg)
            v.applyMatrix4(wg.matrixWorld);
        return !!m.isWorldPointOccluded(v);
    }
    addTo(map) {
        if (this._map === map)
            return this;
        if (this._map)
            this.removeFromMap();
        this._map = map;
        this._crsRaw = Projections.getRaw(this._crsCode);
        this._linesGroup = new THREE.Group();
        this._linesGroup.name = 'graticule';
        this._linesGroup.visible = this._visible;
        map.worldGroup.add(this._linesGroup);
        this._createMaterial();
        this._createStencilMask();
        this._needsRebuild = true;
        this._lastActiveLabelIds = null;
        this._lastCamMatrix.fill(0);
        this._lastProjMatrix.fill(0);
        this._lastWgMatrix.fill(0);
        return this;
    }
    removeFromMap() {
        const map = this._map;
        if (!map)
            return;
        if (map.textManager) {
            try {
                map.textManager.pruneStaleLabels(new Set(), this, { fade: false });
            }
            catch { }
        }
        this._clearAllLines();
        this._destroyStencilMask();
        if (this._map)
            this._map.__hasGapMaskCache = undefined;
        if (this._material) {
            try {
                this._material.dispose();
            }
            catch { }
            this._material = null;
        }
        if (this._linesGroup && this._linesGroup.parent) {
            this._linesGroup.parent.remove(this._linesGroup);
        }
        this._linesGroup = null;
        this._map = null;
        this._lastActiveLabelIds = null;
        this._lastCamMatrix.fill(0);
        this._lastProjMatrix.fill(0);
        this._lastWgMatrix.fill(0);
    }
    _dispose() { this.removeFromMap(); }
    _applyRenderOrder(_base) { }
    getBounds(_crs) { return null; }
    // ─────────────────────────────────────────────────────────────────
    // Per-frame update
    // ─────────────────────────────────────────────────────────────────
    _postUpdate(map) {
        if (!this._map || map !== this._map)
            return;
        if (!this._visible)
            return;
        const z = map.continuousZoom;
        if (z < this._minZoom || z > this._maxZoom) {
            if (this._linesGroup)
                this._linesGroup.visible = false;
            return;
        }
        if (this._linesGroup)
            this._linesGroup.visible = true;
        const cameraMoved = this._syncCameraSnapshot(map);
        if (!cameraMoved && !this._needsRebuild && this._lineInfos.length > 0) {
            this._updateLabelsInTextManager();
            return;
        }
        const viewport = this._getViewport();
        if (!viewport)
            return;
        const steps = this._resolveSteps(viewport);
        const stepChanged = steps.lat !== this._currentStepLat ||
            steps.lon !== this._currentStepLon;
        const crs = this._crsRaw;
        const isGeo = !!crs.isGeographic;
        const hasLobes = this._getLobes() !== null;
        // Per-axis проверка «full-world» (для Y исправлено halfExtentX → halfExtentY).
        const fullWorldLat = (isGeo || hasLobes)
            ? steps.lat >= FULL_WORLD_STEP_DEG
            : steps.lat >= (2 * crs.halfExtentY) * FULL_WORLD_STEP_FRAC;
        const fullWorldLon = (isGeo || hasLobes)
            ? steps.lon >= FULL_WORLD_STEP_DEG
            : steps.lon >= (2 * crs.halfExtentX) * FULL_WORLD_STEP_FRAC;
        const mode = (fullWorldLat || fullWorldLon) ? 'full-world' : 'viewport';
        const modeChanged = mode !== this._genMode;
        if (stepChanged || modeChanged || this._needsRebuild || this._lineInfos.length === 0) {
            this._currentStepLat = steps.lat;
            this._currentStepLon = steps.lon;
            this._genMode = mode;
            this._rebuildAll(viewport, steps, mode);
            this._needsRebuild = false;
        }
        else if (cameraMoved) {
            this._addMissingLines(viewport, steps, mode);
            // Глобус: горизонт зависит от камеры — видимые куски линий пересобираем.
            if (this._isGlobe())
                this._rebuildVisibleRuns();
        }
        this._updateResolution();
        this._updateLabelPositions(viewport);
        this._updateLabelsInTextManager();
    }
    _syncCameraSnapshot(map) {
        if (!map.camera || !map.worldGroup)
            return false;
        const camE = map.camera.matrixWorld.elements;
        const projE = map.camera.projectionMatrix.elements;
        const wgE = map.worldGroup.matrixWorld.elements;
        let changed = false;
        for (let i = 0; i < 16; i++) {
            if (Math.abs(camE[i] - this._lastCamMatrix[i]) > 1e-9) {
                changed = true;
                break;
            }
            if (Math.abs(projE[i] - this._lastProjMatrix[i]) > 1e-9) {
                changed = true;
                break;
            }
            if (Math.abs(wgE[i] - this._lastWgMatrix[i]) > 1e-9) {
                changed = true;
                break;
            }
        }
        if (changed) {
            this._lastCamMatrix.set(camE);
            this._lastProjMatrix.set(projE);
            this._lastWgMatrix.set(wgE);
        }
        return changed;
    }
    _getLobes() {
        // Lobes лежат в RAW-модуле проекции (ESRI_54052.js), а не в обёртке
        // Projections.getWorld(...). Достаём raw по коду проекции карты.
        const map = this._map;
        const code = map?.projection?.code ?? this._crsRaw?.code ?? null;
        let raw = null;
        if (code) {
            try {
                raw = Projections.getRaw(code);
            }
            catch {
                raw = null;
            }
        }
        if (!raw)
            raw = this._crsRaw;
        if (!raw)
            return null;
        if (this._debug) {
            console.log('[Graticule] _getLobes:', 'code=', code, 'rawCtor=', raw.constructor?.name, 'raw.lobes=', raw.lobes, 'raw.options?.lobes=', raw.options?.lobes);
        }
        const lobes = raw.lobes ?? raw.options?.lobes;
        return (Array.isArray(lobes) && lobes.length > 0) ? lobes : null;
    }
    /** Лепестки, реально «владеющие» данной параллелью (lat). */
    _getEligibleLobesForLat(lat, lobes) {
        const out = [];
        const covered = [];
        for (const lobe of lobes) {
            if (lat < lobe.latMin || lat > lobe.latMax)
                continue;
            if (_isRangeCovered(lobe.lonMin, lobe.lonMax, covered))
                continue;
            out.push(lobe);
            covered.push([lobe.lonMin, lobe.lonMax]);
        }
        return out; // порядок = порядок в LOBES (слева → направо)
    }
    _getEligibleLobesForLon(lon, lobes) {
        const out = [];
        for (const lobe of lobes) {
            // Небольшой допуск (1e-9), чтобы граница попадала в оба лепестка
            if (lon < lobe.lonMin - 1e-9 || lon > lobe.lonMax + 1e-9)
                continue;
            out.push(lobe);
        }
        // для меридианов нужен порядок юг → север (для подписей start/end)
        out.sort((a, b) => a.latMin - b.latMin);
        return out;
    }
    _createMaterial() {
        const canvas = this._map.renderer.domElement;
        // Глобус: включаем depthTest, чтобы эллипсоидный окклюдер (WorldSurface.createOccluder)
        // закрывал обратную сторону сетки — так же, как у полилиний и полигонов.
        // depthWrite оставляем выключенным: сетка не должна портить глубину других объектов.
        const globe = this._isGlobe();
        const mat = new LineMaterial({
            color: this._color,
            linewidth: this._width,
            opacity: this._opacity,
            transparent: this._opacity < 1,
            depthTest: globe,
            depthWrite: false,
            resolution: new THREE.Vector2(canvas.width, canvas.height),
            worldUnits: false,
        });
        if (this._lineDasharray != null) {
            const [d, g] = typeof this._lineDasharray === 'number'
                ? [this._lineDasharray, this._lineDasharray]
                : [this._lineDasharray[0], this._lineDasharray[1]];
            mat.dashed = true;
            mat.dashSize = d;
            mat.gapSize = g;
            mat.dashOffset = this._lineDashOffset;
        }
        if (this._maskEnabled && !globe) {
            mat.stencilWrite = true;
            mat.stencilRef = 1;
            mat.stencilFunc = THREE.EqualStencilFunc ?? 514;
            mat.stencilFail = THREE.KeepStencilOp ?? 7680;
            mat.stencilZFail = THREE.KeepStencilOp ?? 7680;
            mat.stencilZPass = THREE.KeepStencilOp ?? 7680;
        }
        else {
            mat.stencilWrite = false;
        }
        this._material = mat;
    }
    _updateResolution() {
        if (!this._material || !this._map)
            return;
        const canvas = this._map.renderer.domElement;
        const r = this._material.resolution;
        if (r.x !== canvas.width || r.y !== canvas.height) {
            r.set(canvas.width, canvas.height);
        }
    }
    _getViewport() {
        let minLon = -180, maxLon = 180, minLat = -90, maxLat = 90;
        const b = this._map.getBounds();
        if (b) {
            const [[a, c], [d, e]] = b;
            if (isFinite(a) && isFinite(c) && isFinite(d) && isFinite(e)) {
                const loLon = Math.min(a, d), hiLon = Math.max(a, d);
                const loLat = Math.min(c, e), hiLat = Math.max(c, e);
                if (hiLon > loLon && hiLat > loLat) {
                    minLon = Math.max(-180, loLon);
                    maxLon = Math.min(180, hiLon);
                    minLat = Math.max(-90, loLat);
                    maxLat = Math.min(90, hiLat);
                }
            }
        }
        const dLon = (maxLon - minLon) * 0.5;
        const dLat = (maxLat - minLat) * 0.5;
        return {
            minLon: Math.max(-180, minLon - dLon),
            maxLon: Math.min(180, maxLon + dLon),
            minLat: Math.max(-90, minLat - dLat),
            maxLat: Math.min(90, maxLat + dLat),
        };
    }
    /** Разрешает шаги по обеим осям с учётом адаптивности. */
    _resolveSteps(vp) {
        return {
            lat: this._resolveAxisStep(vp, 'lat'),
            lon: this._resolveAxisStep(vp, 'lon'),
        };
    }
    /**
     * Шаг по одной оси. При адаптивном шаге каждая ось масштабируется
     * своим масштабом (`degPerPx` / `unitsPerPx`), чтобы визуальная
     * плотность линий была одинаковой.
     */
    _resolveAxisStep(vp, axis) {
        const fixed = axis === 'lat' ? this._stepLat : this._stepLon;
        if (fixed != null)
            return fixed;
        const canvas = this._map.renderer.domElement;
        const W = canvas.clientWidth || 1;
        const H = canvas.clientHeight || 1;
        const hasLobes = this._getLobes() !== null;
        if (this._crsRaw?.isGeographic || hasLobes) {
            const span = axis === 'lat'
                ? (vp.maxLat - vp.minLat) / H
                : (vp.maxLon - vp.minLon) / W;
            return niceDegreeStep(span * this._targetPixelsBetweenLines);
        }
        const crs = this._crsRaw;
        const [x1, y1] = crs.fromLonLat([vp.minLon, vp.minLat]) || [0, 0];
        const [x2, y2] = crs.fromLonLat([vp.maxLon, vp.maxLat]) || [0, 0];
        const span = axis === 'lat'
            ? Math.abs(y2 - y1) / H
            : Math.abs(x2 - x1) / W;
        return niceLinearStep(span * this._targetPixelsBetweenLines);
    }
    // ─────────────────────────────────────────────────────────────────
    // Генерация линий
    // ─────────────────────────────────────────────────────────────────
    _clearAllLines() {
        if (this._map?.textManager) {
            try {
                this._map.textManager.pruneStaleLabels(new Set(), this, { fade: false });
            }
            catch { }
        }
        for (const info of this._lineInfos)
            this._destroyLine(info);
        this._lineInfos = [];
        this._lastActiveLabelIds = null;
    }
    _rebuildAll(viewport, steps, mode) {
        this._clearAllLines();
        this._addMissingLines(viewport, steps, mode);
    }
    _addMissingLines(viewport, steps, mode) {
        const crs = this._crsRaw;
        const isGeo = !!crs.isGeographic;
        const hasLobes = this._getLobes() !== null;
        // Итерация по долготе/широте, если CRS geographic ИЛИ есть разрывы
        const useGeoIter = isGeo || hasLobes;
        let genMinX, genMaxX, genMinY, genMaxY;
        if (mode === 'full-world') {
            if (useGeoIter) {
                genMinX = -180;
                genMaxX = 180;
                genMinY = -90;
                genMaxY = 90;
            }
            else {
                genMinX = -crs.halfExtentX;
                genMaxX = crs.halfExtentX;
                genMinY = -crs.halfExtentY;
                genMaxY = crs.halfExtentY;
            }
        }
        else {
            if (useGeoIter) {
                genMinX = viewport.minLon;
                genMaxX = viewport.maxLon;
                genMinY = viewport.minLat;
                genMaxY = viewport.maxLat;
            }
            else {
                const p1 = crs.fromLonLat([viewport.minLon, viewport.minLat]);
                const p2 = crs.fromLonLat([viewport.maxLon, viewport.maxLat]);
                if (!p1 || !p2)
                    return;
                const cx = (p1[0] + p2[0]) * 0.5;
                const cy = (p1[1] + p2[1]) * 0.5;
                const hx = Math.abs(p2[0] - p1[0]);
                const hy = Math.abs(p2[1] - p1[1]);
                genMinX = cx - hx;
                genMaxX = cx + hx;
                genMinY = cy - hy;
                genMaxY = cy + hy;
            }
        }
        const existing = new Set();
        for (const info of this._lineInfos)
            existing.add(info.stableId);
        const N = SAMPLE_COUNT;
        const newInfos = [];
        let addedM = 0, addedP = 0;
        // ── Меридианы (шаг по долготе = steps.lon) ──
        const stepLon = steps.lon;
        const startX = Math.ceil(genMinX / stepLon - 1e-9) * stepLon;
        for (let v = startX; v <= genMaxX + stepLon * 1e-6; v += stepLon) {
            const value = Math.abs(v) < stepLon * 1e-9 ? 0 : v;
            const id = `grid:m:${round6(value)}`;
            if (existing.has(id))
                continue;
            const segments = useGeoIter
                ? this._sampleMeridianGeo(value, N)
                : this._sampleMeridianProj(value, N);
            if (!segments.length)
                continue;
            const pts = concatSegmentsPts(segments);
            if (pts.length < 2)
                continue;
            const crsPts = concatSegmentsCrs(segments);
            const text = this._formatLabel(value, false, stepLon, isGeo);
            const info = {
                stableId: id, kind: 'meridian', value, text,
                line2: this._buildLine2(segments),
                segments,
                points3D: pts,
                crsSamples: crsPts,
                labels: this._buildLabelAnchors(id, 'meridian', text, value, stepLon, isGeo),
            };
            if (this._linesGroup)
                this._linesGroup.add(info.line2);
            newInfos.push(info);
            addedM++;
        }
        // ── Параллели (шаг по широте = steps.lat) ──
        const stepLat = steps.lat;
        const startY = Math.ceil(genMinY / stepLat - 1e-9) * stepLat;
        for (let v = startY; v <= genMaxY + stepLat * 1e-6; v += stepLat) {
            const value = Math.abs(v) < stepLat * 1e-9 ? 0 : v;
            const id = `grid:p:${round6(value)}`;
            if (existing.has(id))
                continue;
            const segments = useGeoIter
                ? this._sampleParallelGeo(value, N)
                : this._sampleParallelProj(value, N);
            if (!segments.length)
                continue;
            const pts = concatSegmentsPts(segments);
            if (pts.length < 2)
                continue;
            const crsPts = concatSegmentsCrs(segments);
            const text = this._formatLabel(value, true, stepLat, isGeo);
            const info = {
                stableId: id, kind: 'parallel', value, text,
                line2: this._buildLine2(segments),
                segments,
                points3D: pts,
                crsSamples: crsPts,
                labels: this._buildLabelAnchors(id, 'parallel', text, value, stepLat, isGeo),
            };
            if (this._linesGroup)
                this._linesGroup.add(info.line2);
            newInfos.push(info);
            addedP++;
        }
        for (const info of newInfos)
            this._lineInfos.push(info);
        if (this._debug && (addedM || addedP)) {
            console.log(`[Graticule] mode=${mode} stepLat=${stepLat} stepLon=${stepLon} ` +
                `hasLobes=${hasLobes} added M=${addedM} P=${addedP} total=${this._lineInfos.length}`);
        }
        if (this._lineInfos.length > MAX_CACHED_LINES) {
            this._pruneFarLines(viewport, mode);
        }
    }
    _buildLabelAnchors(lineId, kind, text, value, step, isGeo) {
        const roundness = computeRoundness(value, step, isGeo);
        const startSide = kind === 'meridian' ? 'bottom' : 'left';
        const endSide = kind === 'meridian' ? 'top' : 'right';
        const makeAnchor = (isStart, side) => {
            const stableId = `${lineId}:${side}`;
            const source = new GridLabelSource(this, text);
            const anchor = {
                isStart,
                side,
                renderSide: side,
                stableId,
                source,
                screenPos: null,
                visibleOnScreen: false,
                roundness,
            };
            source._anchor = anchor;
            return anchor;
        };
        // Глобус: меридианы подписываем на экваторе (середина по широте), параллели —
        // на силуэте (индекс выбирается динамически в _updateLabelScreenPositions).
        // Меридианы на глобусе: обе подписи (bottom/top) создаём всегда; экваторный якорь
        // ставим на кадре, только когда силуэт виден (см. _updateLabelScreenPositions).
        if (this._isGlobe() && kind === 'meridian') {
            const eq = makeAnchor(true, 'bottom');
            eq.anchorIdx = Math.floor(SAMPLE_COUNT / 2); // lat ≈ 0 при равномерной выборке по широте
            const topA = makeAnchor(false, 'top');
            return [eq, topA];
        }
        return [
            makeAnchor(true, startSide),
            makeAnchor(false, endSide),
        ];
    }
    _pruneFarLines(viewport, mode) {
        if (mode === 'full-world')
            return;
        const crs = this._crsRaw;
        const p1 = crs.fromLonLat([viewport.minLon, viewport.minLat]);
        const p2 = crs.fromLonLat([viewport.maxLon, viewport.maxLat]);
        if (!p1 || !p2)
            return;
        const spanX = Math.abs(p2[0] - p1[0]);
        const spanY = Math.abs(p2[1] - p1[1]);
        const padX = spanX * PRUNE_PADDING_FACTOR;
        const padY = spanY * PRUNE_PADDING_FACTOR;
        const loX = Math.min(p1[0], p2[0]) - padX;
        const hiX = Math.max(p1[0], p2[0]) + padX;
        const loY = Math.min(p1[1], p2[1]) - padY;
        const hiY = Math.max(p1[1], p2[1]) + padY;
        const kept = [];
        for (const info of this._lineInfos) {
            const inRange = info.kind === 'meridian'
                ? (info.value >= loX && info.value <= hiX)
                : (info.value >= loY && info.value <= hiY);
            if (inRange)
                kept.push(info);
            else
                this._destroyLine(info);
        }
        this._lineInfos = kept;
        this._lastActiveLabelIds = null;
    }
    // ── Сэмплирование ──
    /**
     * Параллель. Возвращает от 1 до N сегментов: по одному на каждый лепесток,
     * в котором реально лежит lat. Проекция без разрывов → 1 сегмент.
     */
    _sampleParallelGeo(lat, N) {
        const map = this._map;
        const lobes = this._getLobes();
        if (this._debug) {
            console.log(`[Graticule] _sampleParallelGeo lat=${lat} lobes=${lobes ? lobes.length : 'null'}`);
            if (lobes) {
                console.log(`[Graticule] lobes:`, lobes.map(l => `${l.lonMin}-${l.lonMax}`));
            }
        }
        if (!lobes) {
            const pts = [];
            const crs = [];
            const globe = this._isGlobe();
            const v = globe ? new THREE.Vector3() : null;
            for (let i = 0; i <= N; i++) {
                const lon = -180 + 360 * (i / N);
                if (globe) {
                    const p = map.projectSurfaceVertex([lon, lat], 'EPSG:4326', this._altitude, null, v);
                    if (!p)
                        continue;
                    pts.push([p.x, p.y, p.z]);
                    crs.push([lon, lat]);
                    continue;
                }
                const world = map.projectSafe([lon, lat], this._crsRaw);
                if (!world)
                    continue;
                pts.push([world[0], this._altitude, world[1]]);
                crs.push([lon, lat]);
            }
            return pts.length >= 2 ? [{ pts, crs }] : [];
        }
        const eligible = this._getEligibleLobesForLat(lat, lobes);
        if (!eligible.length)
            return [];
        if (this._debug) {
            console.log(`[Graticule] eligible lobes for lat=${lat}: ${eligible.length}`);
        }
        const EPS_LON = 1e-6;
        const segments = [];
        for (let li = 0; li < eligible.length; li++) {
            const lobe = eligible[li];
            const isFirst = li === 0;
            // Точка lonMin принадлежит ПЕРВОМУ лепестку, который её содержит
            // (forward() делает break по первому совпадению), поэтому для
            // не-первых лепестков отступаем внутрь.
            // Правый край тоже отступаем внутрь: lon=180 wrap180'ом уходит в лепесток 0.
            const lonStart = lobe.lonMin + (isFirst ? 0 : EPS_LON);
            const lonEnd = lobe.lonMax - EPS_LON;
            if (lonEnd - lonStart <= 0)
                continue;
            const pts = [];
            const crs = [];
            for (let i = 0; i <= N; i++) {
                const lon = lonStart + (lonEnd - lonStart) * (i / N);
                const world = map.projectSafe([lon, lat], this._crsRaw);
                if (!world)
                    continue;
                pts.push([world[0], this._altitude, world[1]]);
                crs.push([lon, lat]);
            }
            if (pts.length >= 2)
                segments.push({ pts, crs });
        }
        return segments;
    }
    /**
     * Меридиан. Возвращает сегменты по лепесткам, отсортированные юг → север.
     */
    _sampleMeridianGeo(lon, N) {
        const map = this._map;
        const lobes = this._getLobes();
        if (!lobes) {
            const pts = [];
            const crs = [];
            const latMin = -89.99, latMax = 89.99;
            // Глобус: точка на поверхности эллипсоида (как полилиния), а не плоская проекция.
            const globe = this._isGlobe();
            const v = globe ? new THREE.Vector3() : null;
            for (let i = 0; i <= N; i++) {
                const lat = latMin + (latMax - latMin) * (i / N);
                if (globe) {
                    const p = map.projectSurfaceVertex([lon, lat], 'EPSG:4326', this._altitude, null, v);
                    if (!p)
                        continue;
                    pts.push([p.x, p.y, p.z]);
                    crs.push([lon, lat]);
                    continue;
                }
                const world = map.projectSafe([lon, lat], this._crsRaw);
                if (!world)
                    continue;
                pts.push([world[0], this._altitude, world[1]]);
                crs.push([lon, lat]);
            }
            return pts.length >= 2 ? [{ pts, crs }] : [];
        }
        const eligible = this._getEligibleLobesForLon(lon, lobes); // уже юг → север
        if (!eligible.length)
            return [];
        const EPS_LAT = 1e-6;
        const EPS_LON = 1e-6; // <-- добавили
        const segments = [];
        for (let li = 0; li < eligible.length; li++) {
            const lobe = eligible[li];
            const isFirst = li === 0;
            const isLast = li === eligible.length - 1;
            // Если меридиан проходит точно по границе лепестка, смещаем его
            // немного внутрь, чтобы projectSafe не выбрал соседний лепесток.
            let sampleLon = lon;
            if (lon <= lobe.lonMin + EPS_LON)
                sampleLon = lobe.lonMin + EPS_LON;
            else if (lon >= lobe.lonMax - EPS_LON)
                sampleLon = lobe.lonMax - EPS_LON;
            const latStart = Math.max(-89.99, lobe.latMin + (isFirst ? 0 : EPS_LAT));
            const latEnd = Math.min(89.99, lobe.latMax - (isLast ? 0 : EPS_LAT));
            if (latEnd - latStart <= 0)
                continue;
            const pts = [];
            const crs = [];
            for (let i = 0; i <= N; i++) {
                const lat = latStart + (latEnd - latStart) * (i / N);
                // Проецируем со сдвинутой долготой
                const world = map.projectSafe([sampleLon, lat], this._crsRaw);
                if (!world)
                    continue;
                pts.push([world[0], this._altitude, world[1]]);
                crs.push([lon, lat]); // в метках оставляем исходную lon
            }
            if (pts.length >= 2)
                segments.push({ pts, crs });
        }
        return segments;
    }
    _sampleMeridianProj(x, N) {
        const map = this._map;
        const crs = this._crsRaw;
        const yMin = -crs.halfExtentY, yMax = crs.halfExtentY;
        const pts = [];
        const crsArr = [];
        for (let i = 0; i <= N; i++) {
            const y = yMin + (yMax - yMin) * (i / N);
            const world = map.projectSafe([x, y], crs);
            if (!world)
                continue;
            pts.push([world[0], this._altitude, world[1]]);
            crsArr.push([x, y]);
        }
        return pts.length >= 2 ? [{ pts, crs: crsArr }] : [];
    }
    _sampleParallelProj(y, N) {
        const map = this._map;
        const crs = this._crsRaw;
        const xMin = -crs.halfExtentX, xMax = crs.halfExtentX;
        const pts = [];
        const crsArr = [];
        for (let i = 0; i <= N; i++) {
            const x = xMin + (xMax - xMin) * (i / N);
            const world = map.projectSafe([x, y], crs);
            if (!world)
                continue;
            pts.push([world[0], this._altitude, world[1]]);
            crsArr.push([x, y]);
        }
        return pts.length >= 2 ? [{ pts, crs: crsArr }] : [];
    }
    _createStencilMask() {
        this._destroyStencilMask();
        // Глобус: плоская маска (контур по projectSafe) не совпадает с видимым полушарием
        // и не нужна — окклюзию даёт depthTest + эллипсоидный окклюдер.
        if (this._isGlobe())
            return;
        if (!this._maskEnabled || !this._map || !this._crsRaw)
            return;
        const realLobes = this._getLobes();
        // Если лепестков нет (непрерывная проекция), создаем один искусственный,
        // покрывающий весь мир.
        const lobes = realLobes ?? [{ latMin: -90, latMax: 90, lonMin: -180, lonMax: 180 }];
        const group = new THREE.Group();
        group.name = 'graticule-mask';
        group.renderOrder = -1000000;
        for (const lobe of lobes) {
            const boundary = this._sampleLobeBoundary(lobe);
            if (boundary.length < 3)
                continue;
            const shape = new THREE.Shape();
            shape.moveTo(boundary[0][0], boundary[0][1]);
            for (let i = 1; i < boundary.length; i++) {
                shape.lineTo(boundary[i][0], boundary[i][1]);
            }
            shape.closePath();
            const geom = new THREE.ShapeGeometry(shape);
            geom.rotateX(Math.PI / 2);
            const pos = geom.attributes.position;
            for (let i = 0; i < pos.count; i++)
                pos.setY(i, this._altitude);
            const mat = new THREE.MeshBasicMaterial({
                colorWrite: false,
                depthWrite: false,
                depthTest: false,
                stencilWrite: true,
                stencilRef: 1,
                stencilFunc: THREE.AlwaysStencilFunc ?? 519,
                stencilZPass: THREE.ReplaceStencilOp ?? 7681,
                stencilFail: THREE.KeepStencilOp ?? 7680,
                stencilZFail: THREE.KeepStencilOp ?? 7680,
                side: THREE.DoubleSide,
            });
            const mesh = new THREE.Mesh(geom, mat);
            mesh.renderOrder = -1000000;
            mesh.frustumCulled = false;
            group.add(mesh);
        }
        this._maskGroup = group;
        this._map.worldGroup.add(group);
        this._map.__hasGapMaskCache = undefined; // сбрасываем кэш
        if (this._debug)
            console.log(`[Graticule] stencil mask: ${group.children.length} lobes`);
    }
    /** Обход границы лепестка в lon/lat, проекция каждой точки. */
    _sampleLobeBoundary(lobe) {
        const N = 64;
        const pts = [];
        const EPS = 1e-4;
        const EPS_LON = 1e-4; // Сдвиг для разрыва маски
        const push = (lon, lat) => {
            const w = this._map.projectSafe([lon, lat], this._crsRaw);
            if (w)
                pts.push([w[0], w[1]]);
        };
        const latTop = lobe.latMax - (Math.abs(lobe.latMax) >= 90 ? EPS : 0);
        const latBot = lobe.latMin + (Math.abs(lobe.latMin) >= 90 ? EPS : 0);
        // Границы лепестков на долготе ±180 обязаны попасть в свой лепесток:
        // проекция нормализует 180° → -180° (wrap180), и точка уходит в соседний
        // лепесток. Поэтому сдвигаем ОБЕ границы внутрь на EPS_LON — и для глобальных
        // краёв, и для внутренних. Иначе маска шва 180° строится неверно.
        const lonMin = lobe.lonMin + EPS_LON;
        const lonMax = lobe.lonMax - EPS_LON;
        for (let i = 0; i <= N; i++) {
            push(lonMin + (lonMax - lonMin) * (i / N), latTop);
        }
        for (let i = 1; i < N; i++) {
            push(lonMax, latTop + (latBot - latTop) * (i / N));
        }
        for (let i = 0; i <= N; i++) {
            push(lonMax + (lonMin - lonMax) * (i / N), latBot);
        }
        for (let i = 1; i < N; i++) {
            push(lonMin, latBot + (latTop - latBot) * (i / N));
        }
        return pts;
    }
    _destroyStencilMask() {
        if (!this._maskGroup)
            return;
        if (this._maskGroup.parent)
            this._maskGroup.parent.remove(this._maskGroup);
        this._maskGroup.traverse((obj) => {
            try {
                obj.geometry?.dispose();
            }
            catch { }
            try {
                obj.material?.dispose();
            }
            catch { }
        });
        this._maskGroup = null;
    }
    // ── Line2 ──
    _buildLine2(segments) {
        const group = new THREE.Group();
        if (this._debug) {
            console.log(`[Graticule] _buildLine2 segments=${segments.length}`);
        }
        // Глобус: геометрия режется по горизонту, а не полагается на depthTest.
        // Иначе дальние дуги, выходящие за силуэт диска при наклоне, рисуются
        // фантомно (окклюдер эллипсоида не закрывает их на краю).
        const globe = this._isGlobe();
        for (const seg of segments) {
            const runs = [];
            let run = [];
            for (const p of seg.pts) {
                const [x, y, z] = p;
                if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)
                    || (globe && this._isPointOccluded(p))) {
                    if (run.length) {
                        runs.push(run);
                        run = [];
                    }
                    continue;
                }
                run.push(p);
            }
            if (run.length)
                runs.push(run);
            for (const r of runs) {
                if (r.length < 2)
                    continue;
                const flat = [];
                for (const [x, y, z] of r)
                    flat.push(x, y, z);
                const geom = new LineGeometry();
                geom.setPositions(flat);
                geom.computeBoundingSphere();
                const line = new Line2(geom, this._material);
                line.computeLineDistances();
                line.renderOrder = this._renderOrder;
                line.frustumCulled = true;
                group.add(line);
            }
        }
        if (this._debug) {
            console.log(`[Graticule] _buildLine2 created ${group.children.length} lines`);
        }
        return group;
    }
    /**
     * Глобус: пересобрать геометрию линий, если изменилась маска горизонта.
     * Маска — битовая строка видимости сэмплов; пересборка только при её смене,
     * поэтому плавное вращение без смены видимости почти ничего не стоит.
     */
    _rebuildVisibleRuns() {
        for (const info of this._lineInfos) {
            if (!info.segments.length)
                continue;
            let mask = '';
            for (const seg of info.segments) {
                for (const p of seg.pts)
                    mask += this._isPointOccluded(p) ? '0' : '1';
                mask += '|';
            }
            if (mask === info.visMask)
                continue;
            info.visMask = mask;
            if (info.line2) {
                if (info.line2.parent)
                    info.line2.parent.remove(info.line2);
                if (typeof info.line2.traverse === 'function') {
                    info.line2.traverse((obj) => { try {
                        obj.geometry?.dispose();
                    }
                    catch { } });
                }
            }
            info.line2 = this._buildLine2(info.segments);
            info.line2.traverse?.((obj) => { obj.renderOrder = this._renderOrder; });
            if (this._linesGroup)
                this._linesGroup.add(info.line2);
        }
    }
    _destroyLine(info) {
        if (!info.line2)
            return;
        if (info.line2.parent)
            info.line2.parent.remove(info.line2);
        if (typeof info.line2.traverse === 'function') {
            info.line2.traverse((obj) => {
                try {
                    obj.geometry?.dispose();
                }
                catch { }
            });
        }
        else {
            try {
                info.line2.geometry?.dispose();
            }
            catch { }
        }
        info.line2 = null;
    }
    // ─────────────────────────────────────────────────────────────────
    // Позиционирование подписей (с учётом сегментов)
    // ─────────────────────────────────────────────────────────────────
    /**
     * Ищет позицию подписи начала/конца линии.
     *
     * 1. Если крайняя точка (start = самая первая точки первого сегмента;
     *    end = самая последняя точка последнего сегмента) видна на экране —
     *    ставим подпись на ней.
     * 2. Иначе ищем первое/последнее пересечение с границей экрана
     *    по сегментам (не переходя «прыжок» между лепестками).
     */
    _findLineEndLabel(info, isStart, defaultSide, vx, vy, vz, W, H, nearZ, projMatrix) {
        const M = LABEL_MARGIN;
        const clampX = (x) => Math.max(M, Math.min(W - M, x));
        const clampY = (y) => Math.max(M, Math.min(H - M, y));
        const tmp = this._tmpVec;
        const projectViewPoint = (x, y, z) => {
            tmp.set(x, y, z).applyMatrix4(projMatrix);
            const sx = (tmp.x * 0.5 + 0.5) * W;
            const sy = (-tmp.y * 0.5 + 0.5) * H;
            if (!Number.isFinite(sx) || !Number.isFinite(sy))
                return null;
            return { x: sx, y: sy };
        };
        const isEndpointVisible = (idx) => {
            if (vz[idx] > nearZ)
                return null;
            // Глобус: конец за горизонтом не считается видимым, даже если попадает в экран.
            if (this._isGlobe() && this._isPointOccluded(pts[idx]))
                return null;
            const p = projectViewPoint(vx[idx], vy[idx], vz[idx]);
            if (!p)
                return null;
            if (p.x >= 0 && p.x <= W && p.y >= 0 && p.y <= H)
                return p;
            return null;
        };
        // Границы сегментов в конкатенированном массиве точек.
        const ranges = [];
        {
            let idx = 0;
            for (const seg of info.segments) {
                ranges.push([idx, idx + seg.pts.length]);
                idx += seg.pts.length;
            }
        }
        const total = ranges.length ? ranges[ranges.length - 1][1] : 0;
        const pts = info.points3D;
        if (isStart) {
            // Правило 1: начальный конец всей линии виден?
            if (total > 0) {
                const startPt = isEndpointVisible(0);
                if (startPt) {
                    return { x: clampX(startPt.x), y: clampY(startPt.y), side: defaultSide, isEdge: false };
                }
            }
            // Правило 3: первое пересечение с экраном, идя от начала — только
            // внутри сегментов (без «прыжка» между лепестками) и только на видимой стороне.
            for (const [s, e] of ranges) {
                for (let i = s; i < e - 1; i++) {
                    if (this._isGlobe() && (this._isPointOccluded(pts[i]) || this._isPointOccluded(pts[i + 1])))
                        continue;
                    const hit = this._getClippedSegmentScreenIntersection(vx[i], vy[i], vz[i], vx[i + 1], vy[i + 1], vz[i + 1], W, H, nearZ, projMatrix);
                    if (hit) {
                        return { x: clampX(hit.x), y: clampY(hit.y), side: hit.edge, isEdge: true };
                    }
                }
            }
        }
        else {
            // Правило 2: конечный конец всей линии виден?
            if (total > 0) {
                const endPt = isEndpointVisible(total - 1);
                if (endPt) {
                    return { x: clampX(endPt.x), y: clampY(endPt.y), side: defaultSide, isEdge: false };
                }
            }
            // Правило 4: последнее пересечение с экраном, идя от конца —
            // только внутри сегментов (в обратном порядке).
            for (let k = ranges.length - 1; k >= 0; k--) {
                const [s, e] = ranges[k];
                for (let i = e - 2; i >= s; i--) {
                    if (this._isGlobe() && (this._isPointOccluded(pts[i]) || this._isPointOccluded(pts[i + 1])))
                        continue;
                    const hit = this._getClippedSegmentScreenIntersection(vx[i + 1], vy[i + 1], vz[i + 1], vx[i], vy[i], vz[i], W, H, nearZ, projMatrix);
                    if (hit) {
                        return { x: clampX(hit.x), y: clampY(hit.y), side: hit.edge, isEdge: true };
                    }
                }
            }
        }
        // Правило 5 (вариант А, только глобус): пересечения с краем нет, но видимая дуга
        // есть — ставим подпись на её видимом конце (ближайшем к нужной стороне).
        if (this._isGlobe()) {
            const scan = isStart
                ? (k) => k
                : (k) => total - 1 - k;
            for (let k = 0; k < total; k++) {
                const idx = scan(k);
                if (this._isPointOccluded(pts[idx]))
                    continue;
                const p = this._projectPointToScreen(vx[idx], vy[idx], vz[idx], projMatrix, W, H, nearZ);
                if (p) {
                    return { x: p.x, y: p.y, side: defaultSide, isEdge: false };
                }
            }
        }
        // Правило 6: ни край, ни пересечение не найдены.
        return null;
    }
    _getClippedSegmentScreenIntersection(vx1, vy1, vz1, vx2, vy2, vz2, W, H, nearZ, projMatrix) {
        if (vz1 > nearZ && vz2 > nearZ)
            return null;
        let ax = vx1, ay = vy1, az = vz1;
        let bx = vx2, by = vy2, bz = vz2;
        if (az > nearZ) {
            const tNear = (nearZ - az) / (bz - az);
            ax += (bx - ax) * tNear;
            ay += (by - ay) * tNear;
            az = nearZ;
        }
        else if (bz > nearZ) {
            const tNear = (nearZ - az) / (bz - az);
            bx = ax + (bx - ax) * tNear;
            by = ay + (by - ay) * tNear;
            bz = nearZ;
        }
        const tmp = this._tmpVec;
        tmp.set(ax, ay, az).applyMatrix4(projMatrix);
        const x1 = (tmp.x * 0.5 + 0.5) * W;
        const y1 = (-tmp.y * 0.5 + 0.5) * H;
        tmp.set(bx, by, bz).applyMatrix4(projMatrix);
        const x2 = (tmp.x * 0.5 + 0.5) * W;
        const y2 = (-tmp.y * 0.5 + 0.5) * H;
        if (!Number.isFinite(x1) || !Number.isFinite(y1) || !Number.isFinite(x2) || !Number.isFinite(y2)) {
            return null;
        }
        let minT = Infinity;
        let bestHit = null;
        const epsT = 1e-7;
        const epsPos = 1e-4;
        const checkHit = (t, x, y, edge) => {
            if (t >= -epsT && t <= 1 + epsT && x >= -epsPos && x <= W + epsPos && y >= -epsPos && y <= H + epsPos) {
                const clampedT = Math.max(0, Math.min(1, t));
                if (clampedT < minT) {
                    minT = clampedT;
                    bestHit = {
                        x: Math.max(0, Math.min(W, x)),
                        y: Math.max(0, Math.min(H, y)),
                        edge,
                        t: clampedT,
                    };
                }
            }
        };
        const dx = x2 - x1;
        const dy = y2 - y1;
        if ((x1 <= 0 && x2 >= 0) || (x1 >= 0 && x2 <= 0)) {
            if (Math.abs(dx) > 1e-12) {
                const t = (0 - x1) / dx;
                checkHit(t, 0, y1 + dy * t, 'left');
            }
        }
        if ((x1 <= W && x2 >= W) || (x1 >= W && x2 <= W)) {
            if (Math.abs(dx) > 1e-12) {
                const t = (W - x1) / dx;
                checkHit(t, W, y1 + dy * t, 'right');
            }
        }
        if ((y1 <= 0 && y2 >= 0) || (y1 >= 0 && y2 <= 0)) {
            if (Math.abs(dy) > 1e-12) {
                const t = (0 - y1) / dy;
                checkHit(t, x1 + dx * t, 0, 'top');
            }
        }
        if ((y1 <= H && y2 >= H) || (y1 >= H && y2 <= H)) {
            if (Math.abs(dy) > 1e-12) {
                const t = (H - y1) / dy;
                checkHit(t, x1 + dx * t, H, 'bottom');
            }
        }
        return bestHit;
    }
    _ensureScratchCapacity(n) {
        if (this._scratchVx.length < n) {
            const size = Math.max(n, this._scratchVx.length * 2);
            this._scratchVx = new Float64Array(size);
            this._scratchVy = new Float64Array(size);
            this._scratchVz = new Float64Array(size);
        }
    }
    _updateLabelPositions(_viewport) {
        const map = this._map;
        const camera = map.camera;
        const canvas = map.renderer.domElement;
        const W = canvas.clientWidth;
        const H = canvas.clientHeight;
        const tmp = this._tmpVec;
        const mvMatrix = this._mvMatrix.multiplyMatrices(camera.matrixWorldInverse, map.worldGroup.matrixWorld);
        const projMatrix = camera.projectionMatrix;
        const isOrtho = !!camera.isOrthographicCamera;
        const nearZ = isOrtho ? Infinity : -Math.max(1e-4, camera.near || 0.1);
        const silVisible = this._isGlobe() && this._silhouetteVisible(mvMatrix, projMatrix, W, H, nearZ);
        for (const info of this._lineInfos) {
            const pts = info.points3D;
            // Глобус, края не видны: меридианы — как на плоской карте (сверху/снизу).
            // Экваторный якорь отключаем, чтобы сработала плоская ветка _findLineEndLabel.
            if (this._isGlobe() && info.kind === 'meridian') {
                for (const lbl of info.labels) {
                    if (silVisible) {
                        if (lbl.side === 'bottom')
                            lbl.anchorIdx = Math.floor(SAMPLE_COUNT / 2);
                        else
                            lbl.anchorIdx = undefined;
                    }
                    else {
                        lbl.anchorIdx = undefined;
                    }
                }
            }
            // Глобус, края видны: параллели подписываются снаружи силуэта.
            // Глобус, края не видны (диск заполняет экран): как на плоской карте — подпись
            // в точке пересечения линии с краем экрана (ветка _findLineEndLabel ниже).
            if (this._isGlobe() && info.kind === 'parallel' && pts.length >= 2 && this._silhouetteVisible(mvMatrix, projMatrix, W, H, nearZ)) {
                this._assignParallelSilhouetteAnchors(info, pts, mvMatrix, projMatrix, W, H, nearZ);
                continue;
            }
            if (pts.length < 2) {
                for (const lbl of info.labels) {
                    lbl.visibleOnScreen = false;
                    lbl.screenPos = null;
                }
                continue;
            }
            const n = pts.length;
            this._ensureScratchCapacity(n);
            const vx = this._scratchVx;
            const vy = this._scratchVy;
            const vz = this._scratchVz;
            for (let i = 0; i < n; i++) {
                const [px, py, pz] = pts[i];
                tmp.set(px, py, pz).applyMatrix4(mvMatrix);
                vx[i] = tmp.x;
                vy[i] = tmp.y;
                vz[i] = tmp.z;
            }
            for (const lbl of info.labels) {
                // Глобус с явным якорем: подпись садится на выбранную точку линии.
                if (this._isGlobe() && lbl.anchorIdx !== undefined) {
                    const idx = lbl.anchorIdx;
                    const occluded = this._isPointOccluded(pts[idx]);
                    const sp = occluded ? null : this._projectPointToScreen(vx[idx], vy[idx], vz[idx], projMatrix, W, H, nearZ);
                    if (sp) {
                        lbl.screenPos = { x: sp.x, y: sp.y };
                        lbl.renderSide = lbl.side;
                        lbl.visibleOnScreen = true;
                    }
                    else {
                        lbl.screenPos = null;
                        lbl.visibleOnScreen = false;
                    }
                    continue;
                }
                const res = this._findLineEndLabel(info, lbl.isStart, lbl.side, vx, vy, vz, W, H, nearZ, projMatrix);
                // Видимость решает _findLineEndLabel: он уже отбрасывает невидимые точки
                // (правила 3–5), поэтому здесь отдельную проверку конца линии не делаем.
                if (res && (!res.isEdge || this._labelSides.has(res.side))) {
                    lbl.screenPos = { x: res.x, y: res.y };
                    lbl.renderSide = res.side;
                    lbl.visibleOnScreen = true;
                }
                else {
                    lbl.screenPos = null;
                    lbl.visibleOnScreen = false;
                }
            }
        }
    }
    _updateLabelsInTextManager() {
        const tm = this._map?.textManager;
        if (!tm)
            return;
        const z = this._map.continuousZoom;
        const show = this._showLabels && z >= this._labelMinZoom && z <= this._labelMaxZoom;
        if (!show) {
            if (this._lastActiveLabelIds !== null) {
                try {
                    tm.pruneStaleLabels(new Set(), this, { fade: false });
                }
                catch { }
                this._lastActiveLabelIds = null;
            }
            return;
        }
        const activeIds = new Set();
        const sources = [];
        for (const info of this._lineInfos) {
            for (const lbl of info.labels) {
                activeIds.add(lbl.stableId);
                sources.push({ id: lbl.stableId, source: lbl.source });
            }
        }
        if (this._lastActiveLabelIds !== null && this._setsEqual(this._lastActiveLabelIds, activeIds)) {
            return;
        }
        try {
            tm.pruneStaleLabels(activeIds, this, { fade: false });
        }
        catch (e) {
            console.warn(e);
        }
        for (const { id, source } of sources) {
            const existing = tm._labelsById ? tm._labelsById.get(id) : null;
            if (existing) {
                if (existing.source === source && !existing.removing && !existing.fadingOut) {
                    continue;
                }
                try {
                    tm.removeLabel?.(id);
                }
                catch { }
                try {
                    tm._labelsById.delete(id);
                }
                catch { }
            }
            try {
                tm.addLabel(source, id, this);
            }
            catch (e) {
                console.warn(e);
            }
        }
        this._lastActiveLabelIds = activeIds;
    }
    _setsEqual(a, b) {
        if (a.size !== b.size)
            return false;
        for (const v of a)
            if (!b.has(v))
                return false;
        return true;
    }
    // ─────────────────────────────────────────────────────────────────
    // Публичный API: точки сетки
    // ─────────────────────────────────────────────────────────────────
    getPoints(options = {}) {
        const includeIntersections = options.includeIntersections ?? true;
        const includeEdges = options.includeEdges ?? true;
        const visibleOnly = options.visibleOnly ?? true;
        const sides = options.sides
            ?? ['top', 'bottom', 'left', 'right'];
        const result = [];
        if (!this._map || !this._lineInfos.length)
            return result;
        const map = this._map;
        const camera = map.camera;
        const canvas = map.renderer.domElement;
        const W = canvas.clientWidth;
        const H = canvas.clientHeight;
        const wgMatrix = map.worldGroup.matrixWorld;
        const mvMatrix = this._mvMatrix.multiplyMatrices(camera.matrixWorldInverse, wgMatrix);
        const projMatrix = camera.projectionMatrix;
        const isOrtho = !!camera.isOrthographicCamera;
        const nearZ = isOrtho ? Infinity : -Math.max(1e-4, camera.near || 0.1);
        const tmp = new THREE.Vector3();
        const onScreen = (x, y, z) => {
            tmp.set(x, y, z).applyMatrix4(mvMatrix);
            if (tmp.z > nearZ)
                return false;
            tmp.applyMatrix4(projMatrix);
            const px = (tmp.x * 0.5 + 0.5) * W;
            const py = (-tmp.y * 0.5 + 0.5) * H;
            return px >= -1 && px <= W + 1 && py >= -1 && py <= H + 1;
        };
        // ── 1. Пересечения ──
        if (includeIntersections) {
            const meridians = [];
            const parallels = [];
            for (const info of this._lineInfos) {
                (info.kind === 'meridian' ? meridians : parallels).push(info);
            }
            for (const m of meridians) {
                for (const p of parallels) {
                    const w2 = map.projectSafe([m.value, p.value], this._crsRaw);
                    if (!w2)
                        continue;
                    const world = [w2[0], this._altitude, w2[1]];
                    if (visibleOnly && !onScreen(world[0], world[1], world[2]))
                        continue;
                    result.push({
                        id: `${m.stableId}×${p.stableId}`,
                        kind: 'intersection',
                        crs: [m.value, p.value],
                        world,
                        meridianId: m.stableId,
                        parallelId: p.stableId,
                    });
                }
            }
        }
        // ── 2. Точки на краях ──
        // Каждый сегмент обрабатываем отдельно: между лепестками нет
        // реального «отрезка», по которому можно было бы искать пересечение.
        if (includeEdges) {
            const CAP = SAMPLE_COUNT + 2;
            const sx = new Float64Array(CAP);
            const sy = new Float64Array(CAP);
            const vis = new Uint8Array(CAP);
            for (const info of this._lineInfos) {
                for (let segIdx = 0; segIdx < info.segments.length; segIdx++) {
                    const seg = info.segments[segIdx];
                    const pts = seg.pts;
                    const crsS = seg.crs;
                    if (pts.length < 2 || crsS.length !== pts.length)
                        continue;
                    const n = pts.length;
                    if (n > CAP)
                        continue;
                    for (let i = 0; i < n; i++) {
                        const [px, py, pz] = pts[i];
                        tmp.set(px, py, pz).applyMatrix4(mvMatrix);
                        vis[i] = tmp.z <= nearZ ? 1 : 0;
                        tmp.applyMatrix4(projMatrix);
                        sx[i] = (tmp.x * 0.5 + 0.5) * W;
                        sy[i] = (-tmp.y * 0.5 + 0.5) * H;
                    }
                    for (const side of sides) {
                        const crossings = this._findEdgeCrossings(side, sx, sy, vis, n, W, H);
                        for (const cr of crossings) {
                            const iA = cr.segment, iB = iA + 1, t = cr.t;
                            const pA = pts[iA], pB = pts[iB];
                            const cA = crsS[iA], cB = crsS[iB];
                            const world = [
                                pA[0] + (pB[0] - pA[0]) * t,
                                pA[1] + (pB[1] - pA[1]) * t,
                                pA[2] + (pB[2] - pA[2]) * t,
                            ];
                            const crs = [
                                cA[0] + (cB[0] - cA[0]) * t,
                                cA[1] + (cB[1] - cA[1]) * t,
                            ];
                            if (visibleOnly && !onScreen(world[0], world[1], world[2]))
                                continue;
                            result.push({
                                id: `${info.stableId}:${segIdx}:${side}:${iA}:${t.toFixed(4)}`,
                                kind: 'edge',
                                crs,
                                world,
                                edge: side,
                                lineId: info.stableId,
                                lineKind: info.kind,
                            });
                        }
                    }
                }
            }
        }
        return result;
    }
    getPointsMap(options = {}) {
        const out = new Map();
        for (const p of this.getPoints(options)) {
            out.set(`${p.crs[0]},${p.crs[1]}`, p);
        }
        return out;
    }
    // ── Хелпер: все пересечения с ребром ──
    _findEdgeCrossings(side, sx, sy, vis, n, W, H) {
        const out = [];
        if (side === 'top' || side === 'bottom') {
            const edgeY = side === 'top' ? 0 : H;
            for (let i = 0; i < n - 1; i++) {
                if (!vis[i] || !vis[i + 1])
                    continue;
                const y1 = sy[i], y2 = sy[i + 1];
                const crosses = (y1 >= edgeY && y2 < edgeY)
                    || (y1 < edgeY && y2 >= edgeY);
                if (!crosses)
                    continue;
                const t = (edgeY - y1) / (y2 - y1);
                const x = sx[i] + (sx[i + 1] - sx[i]) * t;
                if (x < 0 || x > W)
                    continue;
                out.push({ segment: i, t });
            }
        }
        else {
            const edgeX = side === 'left' ? 0 : W;
            for (let i = 0; i < n - 1; i++) {
                if (!vis[i] || !vis[i + 1])
                    continue;
                const x1 = sx[i], x2 = sx[i + 1];
                const crosses = (x1 >= edgeX && x2 < edgeX)
                    || (x1 < edgeX && x2 >= edgeX);
                if (!crosses)
                    continue;
                const t = (edgeX - x1) / (x2 - x1);
                const y = sy[i] + (sy[i + 1] - sy[i]) * t;
                if (y < 0 || y > H)
                    continue;
                out.push({ segment: i, t });
            }
        }
        return out;
    }
    // ─────────────────────────────────────────────────────────────────
    // Форматирование
    // ─────────────────────────────────────────────────────────────────
    _formatLabel(value, isLat, step, isGeo) {
        if (!isGeo)
            return this._formatLinear(value, step);
        const abs = Math.abs(value);
        const dir = isLat
            ? (value > 0 ? 'С' : value < 0 ? 'Ю' : '')
            : (value > 0 ? 'В' : value < 0 ? 'З' : '');
        if (value === 0)
            return '0°';
        if (step >= 1) {
            const d = Math.round(abs);
            return dir ? `${d}°` : `${d}°`;
        }
        if (step >= 1 / 60 - 1e-12) {
            const deg = Math.floor(abs);
            const min = Math.round((abs - deg) * 60);
            if (min === 60)
                return dir ? `${deg + 1}°${dir}` : `${deg + 1}°`;
            if (deg === 0)
                return dir ? `${min}'${dir}` : `${min}'`;
            if (min === 0)
                return dir ? `${deg}°${dir}` : `${deg}°`;
            return dir ? `${deg}°${min}'${dir}` : `${deg}°${min}'`;
        }
        const deg = Math.floor(abs);
        const mFull = (abs - deg) * 60;
        const min = Math.floor(mFull);
        let sec = Math.round((mFull - min) * 60);
        if (sec === 60) {
            sec = 0;
        }
        if (deg === 0 && min === 0)
            return dir ? `${sec}"${dir}` : `${sec}"`;
        if (deg === 0)
            return dir ? `${min}'${sec}"${dir}` : `${min}'${sec}"`;
        if (sec === 0 && min === 0)
            return dir ? `${deg}°${dir}` : `${deg}°`;
        return dir ? `${deg}°${min}'${sec}"${dir}` : `${deg}°${min}'${sec}"`;
    }
    _formatLinear(value, step) {
        if (step >= 1000)
            return `${(value / 1000).toFixed(0)}km`;
        if (step >= 1)
            return `${Math.round(value)}m`;
        if (step >= 0.1)
            return `${value.toFixed(1)}m`;
        return `${value.toFixed(2)}m`;
    }
    // ── Новый внутренний метод: только сборка FeatureCollection ──
    _buildFeatureCollection(options = {}) {
        if (!this._map)
            throw new Error('[Graticule] Cannot export: map is not attached');
        const gridCrsCode = options.gridCrs ?? this._crsCode;
        const gridCrsRaw = Projections.getRaw(gridCrsCode);
        if (!gridCrsRaw)
            throw new Error(`[Graticule] Unknown gridCrs: ${gridCrsCode}`);
        const isGeo = !!gridCrsRaw.isGeographic;
        let stepLat = options.stepLat ?? (this._currentStepLat > 0 ? this._currentStepLat : 10);
        let stepLon = options.stepLon ?? (this._currentStepLon > 0 ? this._currentStepLon : 10);
        if (!(stepLat > 0))
            stepLat = 10;
        if (!(stepLon > 0))
            stepLon = 10;
        let minLon = -180, maxLon = 180, minLat = -90, maxLat = 90;
        if (options.extent)
            [minLon, minLat, maxLon, maxLat] = options.extent;
        const N = Math.max(2, options.samplesPerLine ?? 64);
        const features = [];
        // По умолчанию — проекция карты, как и у SpatialObject.download()
        const targetCrsCode = options.targetCrs
            ?? this._map.projection?.code
            ?? 'EPSG:4326';
        const isLocal = targetCrsCode === 'local';
        const targetCrsRaw = isLocal
            ? Projections.getRaw(this._map.projection?.code ?? gridCrsCode)
            : Projections.getRaw(targetCrsCode);
        if (!targetCrsRaw)
            throw new Error(`[Graticule] Unknown targetCrs: ${targetCrsCode}`);
        const project = (lon, lat) => {
            if (!Number.isFinite(lon) || !Number.isFinite(lat))
                return null;
            if (Math.abs(lon) > 180.0001 || Math.abs(lat) > 90.0001)
                return null;
            let out = null;
            try {
                if (gridCrsRaw.isGeographic) {
                    out = targetCrsRaw.fromLonLat([lon, lat]);
                }
                else {
                    const gc = gridCrsRaw.fromLonLat([lon, lat]);
                    if (!gc || !Number.isFinite(gc[0]) || !Number.isFinite(gc[1]))
                        return null;
                    out = (targetCrsRaw === gridCrsRaw) ? gc : gridCrsRaw.convertTo(targetCrsRaw, gc);
                }
            }
            catch {
                return null;
            }
            if (!out || !Number.isFinite(out[0]) || !Number.isFinite(out[1]))
                return null;
            return [out[0], out[1]];
        };
        const buildLine = (kind, value, start, end, isLon) => {
            const coords = [];
            const stepSize = (end - start) / N;
            const flush = () => {
                if (coords.length >= 2) {
                    features.push({
                        type: 'Feature',
                        properties: {
                            kind,
                            value,
                            gridCrs: gridCrsCode,
                            label: this._formatLabel(value, !isLon, isLon ? stepLon : stepLat, isGeo),
                        },
                        geometry: { type: 'LineString', coordinates: coords.slice() },
                    });
                }
                coords.length = 0;
            };
            for (let i = 0; i <= N; i++) {
                const v = start + stepSize * i;
                const lon = isLon ? value : v;
                const lat = isLon ? v : value;
                const p = project(lon, lat);
                if (p)
                    coords.push(p);
                else
                    flush();
            }
            flush();
        };
        const startLon = Math.ceil(minLon / stepLon - 1e-9) * stepLon;
        for (let lon = startLon; lon <= maxLon + stepLon * 1e-6; lon += stepLon) {
            const v = Math.abs(lon) < stepLon * 1e-9 ? 0 : lon;
            buildLine('meridian', v, minLat, maxLat, true);
        }
        const startLat = Math.ceil(minLat / stepLat - 1e-9) * stepLat;
        for (let lat = startLat; lat <= maxLat + stepLat * 1e-6; lat += stepLat) {
            const v = Math.abs(lat) < stepLat * 1e-9 ? 0 : lat;
            buildLine('parallel', v, minLon, maxLon, false);
        }
        const manual = options.unitScale;
        const unitScale = resolveUnitScale(targetCrsRaw, options);
        if (unitScale !== 1) {
            for (const f of features)
                f.geometry = scaleGeometry(f.geometry, unitScale);
        }
        const fc = { type: 'FeatureCollection', features };
        if (unitScale !== 1) {
            fc.unitScale = unitScale;
            fc.sourceCrs = targetCrsCode;
        }
        if (options.writeCrsMember !== false) {
            if (isLocal) {
                fc.crs = {
                    type: 'name',
                    properties: {
                        name: `ENGCRS["Local Cartesian (World Units)",` +
                            `EDATUM["Unknown engineering datum"],` +
                            `CS[Cartesian,2],` +
                            `AXIS["(E)",east,ORDER[1],LENGTHUNIT["metre",1]],` +
                            `AXIS["(N)",north,ORDER[2],LENGTHUNIT["metre",1]]]`,
                    },
                };
            }
            else {
                const m = targetCrsCode.match(/^EPSG:(\d+)$/i);
                const name = m
                    ? `urn:ogc:def:crs:EPSG::${m[1]}`
                    : (unitScale !== 1
                        ? engineeringCrsWkt(`${targetCrsCode} (metres)`)
                        : targetCrsCode);
                fc.crs = { type: 'name', properties: { name } };
            }
        }
        return fc;
    }
    // ── Старый API: строка ──
    toGeoJSON(options = {}) {
        return JSON.stringify(this._buildFeatureCollection(options));
    }
    // ── Новый единый API ──
    async download(options = {}) {
        if (!this._map)
            throw new Error('[Graticule] Cannot export: map is not attached');
        const fc = this._buildFeatureCollection(options);
        // downloader есть у карты; fallback — на случай, если понадобится
        // использовать Graticule вне карты (сейчас невозможно, но на будущее).
        const downloader = this._map.downloader;
        await downloader.downloadCollection(fc, {
            format: options.format,
            filename: options.filename ?? 'graticule',
        });
    }
    // ── Обратная совместимость ──
    async downloadGeoJSON(options = {}, filename) {
        return this.download({ ...options, format: 'geojson', filename });
    }
}
// ─────────────────────────────────────────────────────────────────────
// Утилиты
// ─────────────────────────────────────────────────────────────────────
function concatSegmentsPts(segments) {
    const out = [];
    for (const seg of segments)
        for (const p of seg.pts)
            out.push(p);
    return out;
}
function concatSegmentsCrs(segments) {
    const out = [];
    for (const seg of segments)
        for (const p of seg.crs)
            out.push(p);
    return out;
}
/**
 * Проверяет, полностью ли отрезок [lo, hi] покрыт объединением ranges.
 * Используется для отсева дублирующихся лепестков.
 */
function _isRangeCovered(lo, hi, ranges) {
    if (lo >= hi)
        return true;
    const relevant = ranges
        .filter(([a, b]) => b > lo && a < hi)
        .sort((a, b) => a[0] - b[0]);
    let cur = lo;
    for (const [a, b] of relevant) {
        if (a > cur)
            return false;
        if (b > cur)
            cur = b;
        if (cur >= hi)
            return true;
    }
    return cur >= hi;
}
function round6(v) {
    return Math.round(v * 1e6) / 1e6;
}
function computeRoundness(value, step, isGeo) {
    const absV = Math.abs(value);
    const eps = Math.max(step * 1e-6, 1e-9);
    if (absV < eps)
        return 1000;
    if (isGeo && absV >= 179.999)
        return 999;
    if (isGeo) {
        const nice = [90, 60, 45, 30, 20, 15, 10, 5, 2, 1];
        for (let i = 0; i < nice.length; i++) {
            const d = nice[i];
            if (d < step * 0.999)
                continue;
            const rem = absV % d;
            if (rem < eps || d - rem < eps) {
                return 900 - i * 50;
            }
        }
        return 100;
    }
    const mag = Math.pow(10, Math.floor(Math.log10(Math.max(absV, step))));
    const niceLinear = [mag * 10, mag * 5, mag * 2, mag];
    for (let i = 0; i < niceLinear.length; i++) {
        const d = niceLinear[i];
        if (d < step * 0.999)
            continue;
        const rem = absV % d;
        if (rem < eps || d - rem < eps) {
            return 900 - i * 100;
        }
    }
    return 100;
}
