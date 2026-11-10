// Diagram.ts
import { Marker } from './Marker.js';
import { getDiagramType, unitPxFromValuePerPx, valuePerPxFromUnitPx, } from './DiagramTypes.js';
const DIAGRAM_PRIORITY_BASE = 1e6;
export class Diagram extends Marker {
    _typeName;
    _type;
    _data;
    _params;
    _width;
    _height;
    _dpr;
    _canvas;
    _ctx;
    _parentPolygon;
    _fitToPolygon;
    _minScreenScale;
    /** Если пользователь задал valuePerPx — храним его, чтобы пересчитывать при смене типа. */
    _valuePerPxInput = null;
    constructor(options) {
        const dpr = (typeof window !== 'undefined' ? window.devicePixelRatio : 1) || 1;
        const type = getDiagramType(options.type);
        // Резолв unitPx: явный unitPx > valuePerPx (через scaleKind) > 1
        let unitPx;
        if (typeof options.unitPx === 'number') {
            unitPx = options.unitPx;
        }
        else if (typeof options.valuePerPx === 'number') {
            unitPx = unitPxFromValuePerPx(type.scaleKind, options.valuePerPx);
        }
        else {
            unitPx = 1;
        }
        const params = {
            data: options.data,
            width: 0, height: 0, dpr,
            unitPx,
            orientation: options.orientation,
            barWidth: options.barWidth,
            gap: options.gap,
            padding: options.padding,
            strokeColor: options.strokeColor,
            strokeWidth: options.strokeWidth,
            label: options.label,
            labelPosition: options.labelPosition,
            labelFont: options.labelFont,
            labelColor: options.labelColor,
            coins: options.coins,
            unitValue: options.unitValue,
            maxCols: options.maxCols,
            shape: options.shape,
            showTotal: options.showTotal,
            totalFormat: options.totalFormat,
            totalFont: options.totalFont,
            totalBg: options.totalBg,
            totalColor: options.totalColor,
            totalBorder: options.totalBorder,
            projection: options.projection,
            segmentSizes: options.segmentSizes,
        };
        const size = type.computeSize(params);
        params.width = size.width;
        params.height = size.height;
        super({
            ...options,
            iconUrl: null,
            iconSize: [size.width, size.height],
            anchor: size.anchor ?? [0.5, 0.5],
            clusterable: false,
        });
        this._typeName = options.type;
        this._type = type;
        this._data = options.data;
        this._params = params;
        this._width = size.width;
        this._height = size.height;
        this._dpr = dpr;
        this._parentPolygon = options.parentPolygon ?? null;
        this._fitToPolygon = options.fitToPolygon ?? !!options.parentPolygon;
        this._minScreenScale = options.minScreenScale ?? 0.5;
        // Запоминаем, что именно пользователь задал
        if (typeof options.unitPx !== 'number' && typeof options.valuePerPx === 'number') {
            this._valuePerPxInput = options.valuePerPx;
        }
        this._canvas = document.createElement('canvas');
        this._applyCanvasSize();
        this._canvas.style.display = 'block';
        this._canvas.style.pointerEvents = 'auto';
        this._ctx = this._canvas.getContext('2d');
        this._redraw();
    }
    // ── Контракт TextManager ────────────────────────────────────────
    getIcon() {
        return {
            name: 'diagram',
            anchor: this.getAnchor(),
            cssStyle: {
                _element: this._canvas,
                display: 'block',
                width: `${this._width}px`,
                height: `${this._height}px`,
                pointerEvents: 'auto',
                cursor: 'pointer',
            },
        };
    }
    getPriority() {
        return DIAGRAM_PRIORITY_BASE + this.getIconPriority();
    }
    // =================================================================
    // Геттеры и Сеттеры
    // =================================================================
    getType() { return this._typeName; }
    setType(name) {
        if (this._typeName === name)
            return this;
        this._typeName = name;
        this._type = getDiagramType(name);
        // Если пользователь задавал valuePerPx — пересчитываем под новый scaleKind
        if (this._valuePerPxInput != null) {
            this._params.unitPx = unitPxFromValuePerPx(this._type.scaleKind, this._valuePerPxInput);
        }
        this._recompute();
        return this;
    }
    getData() { return this._data.map(d => ({ ...d })); }
    setData(data) {
        this._data = data;
        this._params.data = data;
        this._recompute();
        return this;
    }
    getUnitPx() { return this._params.unitPx; }
    setUnitPx(px) {
        if (!(px > 0))
            return this;
        this._valuePerPxInput = null; // явный unitPx отменяет «семантический» вход
        if (this._params.unitPx === px)
            return this;
        this._params.unitPx = px;
        this._recompute();
        return this;
    }
    /** «1 px [размерность] = N ед.» для текущего типа. */
    getValuePerPx() {
        return valuePerPxFromUnitPx(this._type.scaleKind, this._params.unitPx);
    }
    setValuePerPx(v) {
        if (!(v > 0))
            return this;
        this._valuePerPxInput = v;
        this._params.unitPx = unitPxFromValuePerPx(this._type.scaleKind, v);
        this._recompute();
        return this;
    }
    /** Готовое описание масштаба для легенды (или null, если тип не поддерживает). */
    getScaleInfo() {
        return this._type.describeScale?.(this._params) ?? null;
    }
    getOrientation() { return this._params.orientation; }
    setOrientation(o) {
        if (this._params.orientation === o)
            return this;
        this._params.orientation = o;
        this._recompute();
        return this;
    }
    getBarWidth() { return this._params.barWidth; }
    setBarWidth(w) {
        if (this._params.barWidth === w)
            return this;
        this._params.barWidth = w;
        this._recompute();
        return this;
    }
    getGap() { return this._params.gap; }
    setGap(g) {
        if (this._params.gap === g)
            return this;
        this._params.gap = g;
        this._recompute();
        return this;
    }
    getPadding() { return this._params.padding; }
    setPadding(p) {
        if (this._params.padding === p)
            return this;
        this._params.padding = p;
        this._recompute();
        return this;
    }
    getStrokeColor() { return this._params.strokeColor; }
    setStrokeColor(c) {
        if (this._params.strokeColor === c)
            return this;
        this._params.strokeColor = c;
        this._recompute();
        return this;
    }
    getStrokeWidth() { return this._params.strokeWidth; }
    setStrokeWidth(w) {
        if (this._params.strokeWidth === w)
            return this;
        this._params.strokeWidth = w;
        this._recompute();
        return this;
    }
    // ── Подпись ──
    getLabel() { return this._params.label; }
    setLabel(l) {
        if (this._params.label === l)
            return this;
        this._params.label = l;
        this._recompute();
        return this;
    }
    getDiagramLabelPosition() { return this._params.labelPosition; }
    setDiagramLabelPosition(p) {
        if (this._params.labelPosition === p)
            return this;
        this._params.labelPosition = p;
        this._recompute();
        return this;
    }
    getLabelFont() { return this._params.labelFont; }
    setLabelFont(f) {
        if (this._params.labelFont === f)
            return this;
        this._params.labelFont = f;
        this._recompute();
        return this;
    }
    getLabelColor() { return this._params.labelColor; }
    setLabelColor(c) {
        if (this._params.labelColor === c)
            return this;
        this._params.labelColor = c;
        this._recompute();
        return this;
    }
    // ── Венский способ ──
    getUnitValue() { return this._params.unitValue; }
    setUnitValue(u) {
        if (this._params.unitValue === u)
            return this;
        this._params.unitValue = u;
        this._recompute();
        return this;
    }
    getMaxCols() { return this._params.maxCols; }
    setMaxCols(m) {
        if (this._params.maxCols === m)
            return this;
        this._params.maxCols = m;
        this._recompute();
        return this;
    }
    getShape() { return this._params.shape; }
    setShape(s) {
        if (this._params.shape === s)
            return this;
        this._params.shape = s;
        this._recompute();
        return this;
    }
    getShowTotal() { return this._params.showTotal; }
    setShowTotal(s) {
        if (this._params.showTotal === s)
            return this;
        this._params.showTotal = s;
        this._recompute();
        return this;
    }
    getTotalFormat() { return this._params.totalFormat; }
    setTotalFormat(f) {
        this._params.totalFormat = f;
        this._recompute();
        return this;
    }
    getTotalFont() { return this._params.totalFont; }
    setTotalFont(f) {
        if (this._params.totalFont === f)
            return this;
        this._params.totalFont = f;
        this._recompute();
        return this;
    }
    getTotalBg() { return this._params.totalBg; }
    setTotalBg(c) {
        if (this._params.totalBg === c)
            return this;
        this._params.totalBg = c;
        this._recompute();
        return this;
    }
    getTotalColor() { return this._params.totalColor; }
    setTotalColor(c) {
        if (this._params.totalColor === c)
            return this;
        this._params.totalColor = c;
        this._recompute();
        return this;
    }
    getTotalBorder() { return this._params.totalBorder; }
    setTotalBorder(c) {
        if (this._params.totalBorder === c)
            return this;
        this._params.totalBorder = c;
        this._recompute();
        return this;
    }
    // ── Vienne Cubes & Bar Segments ──
    getProjection() { return this._params.projection; }
    setProjection(p) {
        if (this._params.projection === p)
            return this;
        this._params.projection = p;
        this._recompute();
        return this;
    }
    getCoins() { return this._params.coins; }
    setCoins(c) {
        this._params.coins = c;
        this._recompute();
        return this;
    }
    getSegmentSizes() { return this._params.segmentSizes; }
    setSegmentSizes(s) {
        this._params.segmentSizes = s;
        this._recompute();
        return this;
    }
    // ── Полигон и Fit ──
    getParentPolygon() { return this._parentPolygon; }
    setParentPolygon(p) {
        this._parentPolygon = p;
        return this;
    }
    getFitToPolygon() { return this._fitToPolygon; }
    setFitToPolygon(f) {
        this._fitToPolygon = f;
        return this;
    }
    getMinScreenScale() { return this._minScreenScale; }
    setMinScreenScale(s) {
        this._minScreenScale = s;
        return this;
    }
    getCanvas() { return this._canvas; }
    // ── Универсальный setStyle (для обратной совместимости) ──
    setStyle(patch) {
        Object.assign(this._params, patch);
        this._recompute();
        return this;
    }
    // =================================================================
    // Логика обновления
    // =================================================================
    _update(map) {
        if (this._parentPolygon && !this._parentPolygon.isVisible()) {
            this._applyHidden();
            return;
        }
        if (this._parentPolygon && this._fitToPolygon) {
            const bbox = this._parentPolygon.getScreenBBox?.();
            if (!bbox || bbox.width < 1 || bbox.height < 1) {
                this._applyHidden();
                return;
            }
            const scale = Math.min(bbox.width / this._width, bbox.height / this._height);
            if (scale < this._minScreenScale) {
                this._applyHidden();
                return;
            }
        }
        super._update(map);
    }
    _recompute() {
        const size = this._type.computeSize(this._params);
        if (size.width !== this._width || size.height !== this._height) {
            this._width = size.width;
            this._height = size.height;
            this._params.width = size.width;
            this._params.height = size.height;
            this._applyCanvasSize();
            this.setIconSize([size.width, size.height]);
            if (size.anchor)
                this.setAnchor(size.anchor);
        }
        this._redraw();
        this._refreshLabel(true);
    }
    _applyCanvasSize() {
        this._canvas.width = Math.max(1, Math.round(this._width * this._dpr));
        this._canvas.height = Math.max(1, Math.round(this._height * this._dpr));
        this._canvas.style.width = `${this._width}px`;
        this._canvas.style.height = `${this._height}px`;
    }
    _redraw() {
        const ctx = this._ctx;
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.clearRect(0, 0, this._canvas.width, this._canvas.height);
        ctx.scale(this._dpr, this._dpr);
        this._type.render(ctx, this._params);
    }
}
