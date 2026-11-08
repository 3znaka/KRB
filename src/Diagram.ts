// Diagram.ts
import { Marker, type MarkerOptions, type LonLat } from './Marker.js';
import type { Polygon } from './Polygon.js';
import {
    type DiagramData, type DiagramRenderParams, type DiagramTypeDefinition,
    getDiagramType,
} from './DiagramTypes.js';

import type { DiagramOrientation, LabelPosition } from './DiagramTypes.js';

export interface DiagramOptions extends Omit<MarkerOptions, 'iconUrl' | 'iconSize' | 'anchor'> {
    type: string;
    data: DiagramData[];
    unitPx?: number;
    orientation?: DiagramOrientation;
    barWidth?: number;
    gap?: number;
    padding?: number;
    strokeColor?: string;
    strokeWidth?: number;

    // Подпись
    label?: string;
    labelPosition?: LabelPosition;
    labelFont?: string;
    labelColor?: string;

    // Венский способ
    unitValue?: number;
    maxCols?: number;
    shape?: 'square' | 'circle';
    showTotal?: boolean;
    totalFormat?: (total: number) => string;
    totalFont?: string;
    totalBg?: string;
    totalColor?: string;
    totalBorder?: string;

    parentPolygon?: Polygon | null;
    fitToPolygon?: boolean;
    minScreenScale?: number;
    projection?: 'oblique' | 'isometric'

     coins?: number[];

       segmentSizes?: number[]; 
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

    constructor(options: DiagramOptions) {
        const dpr = (typeof window !== 'undefined' ? window.devicePixelRatio : 1) || 1;
        const type = getDiagramType(options.type);
       const params: DiagramRenderParams = {
    data: options.data,
    width: 0, height: 0, dpr,
    unitPx: options.unitPx ?? 1,
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

        this._canvas = document.createElement('canvas');
        this._applyCanvasSize();
        this._canvas.style.display = 'block';
        this._canvas.style.pointerEvents = 'auto';
        this._ctx = this._canvas.getContext('2d')!;
        this._redraw();
    }

override getIcon(): {
    name: string;
    anchor: [number, number];
    cssStyle: Record<string, any>;
} {
    return {
        name: 'diagram',
        anchor: this.getAnchor(),          // уже [number, number]
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

    // ── Мутация ─────────────────────────────────────────────────────
    setData(data: DiagramData[]): this {
        this._data = data;
        this._params.data = data;
        this._recompute();
        return this;
    }

    setUnitPx(px: number): this {
        if (!(px > 0)) return this;
        this._params.unitPx = px;
        this._recompute();
        return this;
    }

    setDiagramType(name: string): this {
        this._typeName = name;
        this._type = getDiagramType(name);
        this._recompute();
        return this;
    }

    setStyle(patch: Partial<Pick<DiagramRenderParams,
        'barWidth'|'gap'|'padding'|'strokeColor'|'strokeWidth'>>): this {
        Object.assign(this._params, patch);
        this._recompute();
        return this;
    }

    getData(): DiagramData[] { return this._data.map(d => ({ ...d })); }
    getCanvas(): HTMLCanvasElement { return this._canvas; }

    // ── Fit-логика ──────────────────────────────────────────────────
    override _update(map?: any): void {
        // 1. Если родительский полигон скрыт — скрываемся.
if (this._parentPolygon && !this._parentPolygon.isVisible()) {
            this._applyHidden();
            return;
        }
        // 2. Если fitToPolygon — проверяем экранный bbox полигона.
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

    // ── Внутреннее ──────────────────────────────────────────────────
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
        this._refreshLabel(true);     // иконка (canvas) изменилась — просим TM обновить
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