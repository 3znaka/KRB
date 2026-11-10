// Diagram.ts
import { Marker, type MarkerOptions, type LonLat } from './Marker.js';
import type { Polygon } from './Polygon.js';
import {
    type DiagramData, type DiagramRenderParams, type DiagramTypeDefinition,
    type DiagramScaleInfo,
    getDiagramType,
    unitPxFromValuePerPx, valuePerPxFromUnitPx,
} from './DiagramTypes.js';

import type { DiagramOrientation, LabelPosition } from './DiagramTypes.js';

export interface DiagramOptions extends Omit<MarkerOptions, 'iconUrl' | 'iconSize' | 'anchor'> {
    type: string;
    data: DiagramData[];
    /** Пикселей на единицу значения. */
    unitPx?: number;
    /** Альтернатива unitPx: «1 px [размерность] = valuePerPx ед.». */
    valuePerPx?: number;
    orientation?: DiagramOrientation;
    barWidth?: number;
    gap?: number;
    padding?: number;
    strokeColor?: string;
    strokeWidth?: number;

    label?: string;
    labelPosition?: LabelPosition;
    labelFont?: string;
    labelColor?: string;

    unitValue?: number;
    maxCols?: number;
    shape?: 'square' | 'circle';
    showTotal?: boolean;
    totalFormat?: (total: number) => string;
    totalFont?: string;
    totalBg?: string;
    totalColor?: string;
    totalBorder?: string;
    projection?: 'oblique' | 'isometric';

    coins?: number[];
    segmentSizes?: number[];

    parentPolygon?: Polygon | null;
    fitToPolygon?: boolean;
    minScreenScale?: number;
}

const DIAGRAM_PRIORITY_BASE = 1e6;

export class Diagram extends Marker {
    private _typeName: string;
    private _type: DiagramTypeDefinition;
    private _data: DiagramData[];
    private _params: DiagramRenderParams;
    private _width: number;
    private _height: number;
    private _dpr: number;
    private _canvas: HTMLCanvasElement;
    private _ctx: CanvasRenderingContext2D;
    private _parentPolygon: Polygon | null;
    private _fitToPolygon: boolean;
    private _minScreenScale: number;

    /** Если пользователь задал valuePerPx — храним его, чтобы пересчитывать при смене типа. */
    private _valuePerPxInput: number | null = null;

    constructor(options: DiagramOptions) {
        const dpr = (typeof window !== 'undefined' ? window.devicePixelRatio : 1) || 1;
        const type = getDiagramType(options.type);

        // Резолв unitPx: явный unitPx > valuePerPx (через scaleKind) > 1
        let unitPx: number;
        if (typeof options.unitPx === 'number') {
            unitPx = options.unitPx;
        } else if (typeof options.valuePerPx === 'number') {
            unitPx = unitPxFromValuePerPx(type.scaleKind, options.valuePerPx);
        } else {
            unitPx = 1;
        }

        const params: DiagramRenderParams = {
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
        params.width  = size.width;
        params.height = size.height;

        super({
            ...options,
            iconUrl: null,
            iconSize: [size.width, size.height],
            anchor: size.anchor ?? [0.5, 0.5],
            clusterable: false,
        });

        this._typeName = options.type;
        this._type     = type;
        this._data     = options.data;
        this._params   = params;
        this._width    = size.width;
        this._height   = size.height;
        this._dpr      = dpr;
        this._parentPolygon = options.parentPolygon ?? null;
        this._fitToPolygon  = options.fitToPolygon ?? !!options.parentPolygon;
        this._minScreenScale = options.minScreenScale ?? 0.5;

        // Запоминаем, что именно пользователь задал
        if (typeof options.unitPx !== 'number' && typeof options.valuePerPx === 'number') {
            this._valuePerPxInput = options.valuePerPx;
        }

        this._canvas = document.createElement('canvas');
        this._applyCanvasSize();
        this._canvas.style.display = 'block';
        this._canvas.style.pointerEvents = 'auto';
        this._ctx = this._canvas.getContext('2d')!;
        this._redraw();
    }

    // ── Контракт TextManager ────────────────────────────────────────
    override getIcon(): {
        name: string;
        anchor: [number, number];
        cssStyle: Record<string, any>;
    } {
        return {
            name: 'diagram',
            anchor: this.getAnchor(),
            cssStyle: {
                _element: this._canvas,
                display: 'block',
                width:  `${this._width}px`,
                height: `${this._height}px`,
                pointerEvents: 'auto',
                cursor: 'pointer',
            },
        };
    }

    override getPriority(): number {
        return DIAGRAM_PRIORITY_BASE + this.getIconPriority();
    }

    // =================================================================
    // Геттеры и Сеттеры
    // =================================================================

    getType(): string { return this._typeName; }
    setType(name: string): this {
        if (this._typeName === name) return this;
        this._typeName = name;
        this._type = getDiagramType(name);
        // Если пользователь задавал valuePerPx — пересчитываем под новый scaleKind
        if (this._valuePerPxInput != null) {
            this._params.unitPx = unitPxFromValuePerPx(this._type.scaleKind, this._valuePerPxInput);
        }
        this._recompute();
        return this;
    }

    getData(): DiagramData[] { return this._data.map(d => ({ ...d })); }
    setData(data: DiagramData[]): this {
        this._data = data;
        this._params.data = data;
        this._recompute();
        return this;
    }

    getUnitPx(): number { return this._params.unitPx; }
    setUnitPx(px: number): this {
        if (!(px > 0)) return this;
        this._valuePerPxInput = null;   // явный unitPx отменяет «семантический» вход
        if (this._params.unitPx === px) return this;
        this._params.unitPx = px;
        this._recompute();
        return this;
    }

    /** «1 px [размерность] = N ед.» для текущего типа. */
    getValuePerPx(): number {
        return valuePerPxFromUnitPx(this._type.scaleKind, this._params.unitPx);
    }
    setValuePerPx(v: number): this {
        if (!(v > 0)) return this;
        this._valuePerPxInput = v;
        this._params.unitPx = unitPxFromValuePerPx(this._type.scaleKind, v);
        this._recompute();
        return this;
    }

    /** Готовое описание масштаба для легенды (или null, если тип не поддерживает). */
    getScaleInfo(): DiagramScaleInfo | null {
        return this._type.describeScale?.(this._params) ?? null;
    }

    getOrientation(): DiagramOrientation | undefined { return this._params.orientation; }
    setOrientation(o: DiagramOrientation): this {
        if (this._params.orientation === o) return this;
        this._params.orientation = o;
        this._recompute();
        return this;
    }

    getBarWidth(): number | undefined { return this._params.barWidth; }
    setBarWidth(w: number): this {
        if (this._params.barWidth === w) return this;
        this._params.barWidth = w;
        this._recompute();
        return this;
    }

    getGap(): number | undefined { return this._params.gap; }
    setGap(g: number): this {
        if (this._params.gap === g) return this;
        this._params.gap = g;
        this._recompute();
        return this;
    }

    getPadding(): number | undefined { return this._params.padding; }
    setPadding(p: number): this {
        if (this._params.padding === p) return this;
        this._params.padding = p;
        this._recompute();
        return this;
    }

    getStrokeColor(): string | undefined { return this._params.strokeColor; }
    setStrokeColor(c: string): this {
        if (this._params.strokeColor === c) return this;
        this._params.strokeColor = c;
        this._recompute();
        return this;
    }

    getStrokeWidth(): number | undefined { return this._params.strokeWidth; }
    setStrokeWidth(w: number): this {
        if (this._params.strokeWidth === w) return this;
        this._params.strokeWidth = w;
        this._recompute();
        return this;
    }

    // ── Подпись ──
    getLabel(): string | undefined { return this._params.label; }
    setLabel(l: string | undefined): this {
        if (this._params.label === l) return this;
        this._params.label = l;
        this._recompute();
        return this;
    }

    getDiagramLabelPosition(): LabelPosition | undefined { return this._params.labelPosition; }
    setDiagramLabelPosition(p: LabelPosition | undefined): this {
        if (this._params.labelPosition === p) return this;
        this._params.labelPosition = p;
        this._recompute();
        return this;
    }

    getLabelFont(): string | undefined { return this._params.labelFont; }
    setLabelFont(f: string | undefined): this {
        if (this._params.labelFont === f) return this;
        this._params.labelFont = f;
        this._recompute();
        return this;
    }

    getLabelColor(): string | undefined { return this._params.labelColor; }
    setLabelColor(c: string | undefined): this {
        if (this._params.labelColor === c) return this;
        this._params.labelColor = c;
        this._recompute();
        return this;
    }

    // ── Венский способ ──
    getUnitValue(): number | undefined { return this._params.unitValue; }
    setUnitValue(u: number | undefined): this {
        if (this._params.unitValue === u) return this;
        this._params.unitValue = u;
        this._recompute();
        return this;
    }

    getMaxCols(): number | undefined { return this._params.maxCols; }
    setMaxCols(m: number | undefined): this {
        if (this._params.maxCols === m) return this;
        this._params.maxCols = m;
        this._recompute();
        return this;
    }

    getShape(): 'square' | 'circle' | undefined { return this._params.shape; }
    setShape(s: 'square' | 'circle' | undefined): this {
        if (this._params.shape === s) return this;
        this._params.shape = s;
        this._recompute();
        return this;
    }

    getShowTotal(): boolean | undefined { return this._params.showTotal; }
    setShowTotal(s: boolean | undefined): this {
        if (this._params.showTotal === s) return this;
        this._params.showTotal = s;
        this._recompute();
        return this;
    }

    getTotalFormat(): ((total: number) => string) | undefined { return this._params.totalFormat; }
    setTotalFormat(f: ((total: number) => string) | undefined): this {
        this._params.totalFormat = f;
        this._recompute();
        return this;
    }

    getTotalFont(): string | undefined { return this._params.totalFont; }
    setTotalFont(f: string | undefined): this {
        if (this._params.totalFont === f) return this;
        this._params.totalFont = f;
        this._recompute();
        return this;
    }

    getTotalBg(): string | undefined { return this._params.totalBg; }
    setTotalBg(c: string | undefined): this {
        if (this._params.totalBg === c) return this;
        this._params.totalBg = c;
        this._recompute();
        return this;
    }

    getTotalColor(): string | undefined { return this._params.totalColor; }
    setTotalColor(c: string | undefined): this {
        if (this._params.totalColor === c) return this;
        this._params.totalColor = c;
        this._recompute();
        return this;
    }

    getTotalBorder(): string | undefined { return this._params.totalBorder; }
    setTotalBorder(c: string | undefined): this {
        if (this._params.totalBorder === c) return this;
        this._params.totalBorder = c;
        this._recompute();
        return this;
    }

    // ── Vienne Cubes & Bar Segments ──
    getProjection(): 'oblique' | 'isometric' | undefined { return this._params.projection; }
    setProjection(p: 'oblique' | 'isometric' | undefined): this {
        if (this._params.projection === p) return this;
        this._params.projection = p;
        this._recompute();
        return this;
    }

    getCoins(): number[] | undefined { return this._params.coins; }
    setCoins(c: number[] | undefined): this {
        this._params.coins = c;
        this._recompute();
        return this;
    }

    getSegmentSizes(): number[] | undefined { return this._params.segmentSizes; }
    setSegmentSizes(s: number[] | undefined): this {
        this._params.segmentSizes = s;
        this._recompute();
        return this;
    }

    // ── Полигон и Fit ──
    getParentPolygon(): Polygon | null { return this._parentPolygon; }
    setParentPolygon(p: Polygon | null): this {
        this._parentPolygon = p;
        return this;
    }

    getFitToPolygon(): boolean { return this._fitToPolygon; }
    setFitToPolygon(f: boolean): this {
        this._fitToPolygon = f;
        return this;
    }

    getMinScreenScale(): number { return this._minScreenScale; }
    setMinScreenScale(s: number): this {
        this._minScreenScale = s;
        return this;
    }

    getCanvas(): HTMLCanvasElement { return this._canvas; }

    // ── Универсальный setStyle (для обратной совместимости) ──
    setStyle(patch: Partial<Pick<DiagramRenderParams,
        'barWidth'|'gap'|'padding'|'strokeColor'|'strokeWidth'>>): this {
        Object.assign(this._params, patch);
        this._recompute();
        return this;
    }

    // =================================================================
    // Логика обновления
    // =================================================================

    override _update(map?: any): void {
        if (this._parentPolygon && !this._parentPolygon.isVisible()) {
            this._applyHidden();
            return;
        }
        if (this._parentPolygon && this._fitToPolygon) {
            const bbox = (this._parentPolygon as any).getScreenBBox?.();
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

    private _recompute(): void {
        const size = this._type.computeSize(this._params);
        if (size.width !== this._width || size.height !== this._height) {
            this._width  = size.width;
            this._height = size.height;
            this._params.width  = size.width;
            this._params.height = size.height;
            this._applyCanvasSize();
            this.setIconSize([size.width, size.height]);
            if (size.anchor) this.setAnchor(size.anchor);
        }
        this._redraw();
        this._refreshLabel(true);
    }

    private _applyCanvasSize(): void {
        this._canvas.width  = Math.max(1, Math.round(this._width  * this._dpr));
        this._canvas.height = Math.max(1, Math.round(this._height * this._dpr));
        this._canvas.style.width  = `${this._width}px`;
        this._canvas.style.height = `${this._height}px`;
    }

    private _redraw(): void {
        const ctx = this._ctx;
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.clearRect(0, 0, this._canvas.width, this._canvas.height);
        ctx.scale(this._dpr, this._dpr);
        this._type.render(ctx, this._params);
    }
}