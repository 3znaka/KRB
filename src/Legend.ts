// Legend.ts
import {
    type DiagramData, type DiagramRenderParams,
    type DiagramOrientation, getDiagramType,
} from './DiagramTypes.js';
import { sampleColorRamp } from './ColorRamps.js';
import type { GeoJSONFeature, GeoJSONInput } from './Geojson.js';

// ─────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────

export interface LegendFieldInfo {
    key: string;
    label: string;
    color: string;
}

export type ExamplePicker =
    | 'auto'
    | number
    | Record<string, any>
    | ((features: GeoJSONFeature[]) => GeoJSONFeature | null);

export interface LegendOptions {
    /** Куда вмонтировать готовую легенду. */
    target?: string | HTMLElement;
    /** Заголовок (доступен как {{title}}). */
    title?: string;
    /** HTML-шаблон с {{placeholders}}. */
    template?: string;
    /** Как выбрать «пример». @default 'auto' */
    example?: ExamplePicker;
    /** Готовый объект легенды (например, чтобы сохранить в переменную). */
    onReady?: (legend: MapLegend) => void;
    /** Скрыть пример (только поля / unitValue). */
    showExample?: boolean;
    dpr?: number;
}

const RESERVED = new Set([
    'layer', 'kind', 'diagramType', 'title', 'fields', 'example',
    'unitPx', 'unitValue', 'maxCols', 'orientation', 'shape', 'coins',
    'breaks', 'colors', 'valueExpr',
    'mount', 'render', 'destroy', 'update',
    '_target', '_renderedEl', '_template',
]);

// ─────────────────────────────────────────────────────────────────
// MapLegend
// ─────────────────────────────────────────────────────────────────

/**
 * Легенда к картодиаграмме / картограмме.
 *
 * Доступные свойства:
 *   legend.title            — заголовок
 *   legend.example          — HTMLCanvasElement с примером (или null)
 *   legend.fields           — Record<string, {color,label}>
 *   legend.<fieldKey>       — сахар: {color,label} (например legend.score.color)
 *   legend.unitValue        — для vienna/viennaCubes
 *   legend.unitPx           — для bar/circle/cube/vienna/coin
 *   legend.maxCols          — для vienna
 *   legend.shape            — для vienna
 *   legend.coins            — для coin
 *   legend.breaks / colors / valueExpr — для choropleth
 */
export class MapLegend {
    readonly layer: any;
    readonly kind: 'diagram' | 'diagram3D' | 'choropleth';
    readonly diagramType: string;
    title: string;
    readonly fields: Record<string, LegendFieldInfo> = {};
    example: HTMLCanvasElement | null = null;
    unitPx?: number;
    unitValue?: number;
    maxCols?: number;
    orientation?: DiagramOrientation;
    shape?: 'square' | 'circle';
    coins?: number[];
    breaks?: number[];
    colors?: string[];
    valueExpr?: string;

    private _target: HTMLElement | null = null;
    private _renderedEl: HTMLElement | null = null;
    private _template: string | null;

    constructor(init: {
        layer: any;
        kind: 'diagram' | 'diagram3D' | 'choropleth';
        diagramType: string;
        title?: string;
        template?: string;
        fields?: LegendFieldInfo[];
    }) {
        this.layer = init.layer;
        this.kind = init.kind;
        this.diagramType = init.diagramType;
        this.title = init.title ?? '';
        this._template = init.template ?? null;

        for (const f of init.fields ?? []) {
            this.fields[f.key] = f;
            if (!RESERVED.has(f.key) && !(f.key in this)) {
                (this as any)[f.key] = { color: f.color, label: f.label };
            }
        }
    }

    // ── API ──────────────────────────────────────────────────────

    render(): string {
        return this._template ? this._interpolate(this._template) : this._defaultRender();
    }

    mount(target: string | HTMLElement): this {
   const el = typeof target === 'string'
    ? (document.getElementById(target)            // сначала по id
        ?? document.querySelector<HTMLElement>(target))  // потом как селектор
    : target;
        if (!el) {
            console.warn('MapLegend.mount: target not found', target);
            return this;
        }
        this._target = el;
        el.innerHTML = this.render();

        if (this.example) {
            const markers = el.querySelectorAll('[data-krb-example]');
            markers.forEach(m => m.replaceWith(this.example!));
            if (!markers.length) {
                const c = el.querySelector('.krb-legend-example');
                if (c) c.appendChild(this.example);
            }
        }
        this._renderedEl = el;
        return this;
    }

    destroy(): void {
        if (this._renderedEl) this._renderedEl.innerHTML = '';
        this._target = null;
        this._renderedEl = null;
    }

    // ── internals ────────────────────────────────────────────────

    private _interpolate(tpl: string): string {
        return tpl.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_m, path: string) => {
            const v = this._resolvePath(path);
            if (v instanceof HTMLCanvasElement) return `<span data-krb-example></span>`;
            if (v == null) return '';
            if (typeof v === 'object') return JSON.stringify(v);
            return String(v);
        });
    }

    private _resolvePath(path: string): any {
        let cur: any = this;
        for (const p of path.split('.')) {
            if (cur == null) return undefined;
            cur = cur[p];
        }
        return cur;
    }

    private _defaultRender(): string {
        const p: string[] = [];
        if (this.title) p.push(`<div class="krb-legend-title">${this.title}</div>`);
        if (this.example) p.push(`<div class="krb-legend-example"></div>`);

        const items = Object.values(this.fields)
            .map(f => `<div><span class="krb-legend-swatch" style="background:${f.color}"></span>${f.label}</div>`);
        if (items.length) p.push(`<div class="krb-legend-fields">${items.join('')}</div>`);

        const footer: string[] = [];
        if (this.unitValue != null) footer.push(`1 символ = ${this.unitValue}`);
        if (this.unitPx    != null) footer.push(`1 ед. = ${this.unitPx}px`);
        if (footer.length) p.push(`<div class="krb-legend-footer">${footer.join(' · ')}</div>`);

        return p.join('');
    }
}

// ─────────────────────────────────────────────────────────────────
// Builders
// ─────────────────────────────────────────────────────────────────

function featuresOf(input: GeoJSONInput): GeoJSONFeature[] {
    if (input.type === 'FeatureCollection') return input.features;
    if (input.type === 'Feature')           return [input];
    return [{ type: 'Feature', geometry: input, properties: {} } as any];
}

function fallbackColor(colorMapValue: any): string {
    if (!colorMapValue) return '#3498db';
    if (typeof colorMapValue === 'string') return colorMapValue;
    if (Array.isArray(colorMapValue) && colorMapValue.length) {
        return colorMapValue[Math.floor(colorMapValue.length / 2)].color;
    }
    return '#3498db';
}

function pickAverageFeature(
    features: GeoJSONFeature[],
    fields: string[],
): GeoJSONFeature | null {
    if (!features.length) return null;
    const n = features.length;
    const m = fields.length;
    const values = features.map(f => fields.map(k => Number(f.properties?.[k]) || 0));
    const mean = new Array(m).fill(0);
    const std  = new Array(m).fill(0);

    for (let i = 0; i < n; i++) for (let j = 0; j < m; j++) mean[j] += values[i][j];
    for (let j = 0; j < m; j++) mean[j] /= n;
    for (let i = 0; i < n; i++) for (let j = 0; j < m; j++) {
        const d = values[i][j] - mean[j];
        std[j] += d * d;
    }
    for (let j = 0; j < m; j++) std[j] = Math.sqrt(std[j] / n) || 1;

    let best = 0, bestScore = Infinity;
    for (let i = 0; i < n; i++) {
        let s = 0;
        for (let j = 0; j < m; j++) {
            const z = (values[i][j] - mean[j]) / std[j];
            s += z * z;
        }
        if (s < bestScore) { bestScore = s; best = i; }
    }
    return features[best];
}

function renderDiagramCanvas(
    typeName: string,
    data: DiagramData[],
    opts: Partial<DiagramRenderParams>,
    dpr: number,
): HTMLCanvasElement {
    const def = getDiagramType(typeName);
    const params = { data, width: 0, height: 0, dpr, unitPx: 1, ...opts } as DiagramRenderParams;
    const size = def.computeSize(params);
    params.width  = size.width;
    params.height = size.height;

    const canvas = document.createElement('canvas');
    canvas.width  = Math.max(1, Math.round(size.width  * dpr));
    canvas.height = Math.max(1, Math.round(size.height * dpr));
    canvas.style.width  = `${size.width}px`;
    canvas.style.height = `${size.height}px`;

    const ctx = canvas.getContext('2d')!;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.scale(dpr, dpr);
    def.render(ctx, params);
    return canvas;
}

export function buildDiagramLegend(
    layer: any,
    geojson: GeoJSONInput,
    cfg: any,
    opts: LegendOptions,
): MapLegend {
    const features = featuresOf(geojson).filter(f =>
        !layer.featureFilter || layer.featureFilter(f),
    );

    const fields: LegendFieldInfo[] = (cfg.fields ?? []).map((key: string) => ({
        key,
        label: key,
        color: fallbackColor(cfg.colorMap?.[key]),
    }));

    const legend = new MapLegend({
        layer,
        kind: 'diagram',
        diagramType: cfg.type ?? 'bar',
        title: opts.title,
        template: opts.template,
        fields,
    });

    // pick example
    const pick = opts.example ?? 'auto';
    let exampleFeature: GeoJSONFeature | null = null;
    if (pick === 'auto')                       exampleFeature = pickAverageFeature(features, cfg.fields);
    else if (typeof pick === 'number')         exampleFeature = features[pick] ?? null;
    else if (typeof pick === 'function')       exampleFeature = pick(features);
    else if (pick && typeof pick === 'object') {
        exampleFeature = features.find(f =>
            Object.entries(pick).every(([k, v]) => f.properties?.[k] === v),
        ) ?? null;
    }

    // example canvas
    if (exampleFeature && opts.showExample !== false) {
        const data: DiagramData[] = cfg.fields
            .map((key: string) => {
                const raw = Number(exampleFeature!.properties?.[key]);
                if (!isFinite(raw)) return null;
                return { label: key, value: Math.max(0, raw), color: legend.fields[key]?.color };
            })
            .filter((d): d is DiagramData => d !== null);

        if (data.length) {
            const unitPx = typeof cfg.unitPx === 'number'
                ? cfg.unitPx
                : (layer._diagramAuto?.unitPx ?? 1);

            legend.unitPx    = unitPx;
            legend.unitValue = cfg.unitValue;
            legend.maxCols   = cfg.maxCols;
            legend.orientation = cfg.orientation;
            legend.shape     = cfg.shape;
            legend.coins     = cfg.coins;

            legend.example = renderDiagramCanvas(legend.diagramType, data, {
                unitPx,
                unitValue: cfg.unitValue,
                maxCols:   cfg.maxCols,
                orientation: cfg.orientation,
                shape:     cfg.shape,
                coins:     cfg.coins,
                segmentSizes: cfg.segmentSizes,
                gap:       cfg.gap,
                padding:   cfg.padding,
                strokeColor: cfg.strokeColor,
                strokeWidth: cfg.strokeWidth,
                projection:  cfg.projection,
            }, opts.dpr ?? (typeof window !== 'undefined' ? window.devicePixelRatio : 1));
        }
    }

    return legend;
}

export function buildChoroplethLegend(
    layer: any,
    _geojson: GeoJSONInput,
    cfg: any,
    opts: LegendOptions,
): MapLegend {
    const legend = new MapLegend({
        layer,
        kind: 'choropleth',
        diagramType: 'choropleth',
        title: opts.title,
        template: opts.template,
        fields: [],
    });

    legend.breaks    = layer._choroplethBreaks ?? [];
    legend.valueExpr = typeof cfg.value === 'string' ? cfg.value : '(fn)';

   const ramp = layer._choroplethRamp;
if (!ramp) {
    console.warn('Legend: choropleth ramp is null');
    return legend;
}
const breaksLen = Array.isArray(legend.breaks) ? legend.breaks.length : 0;
const n = Math.max(1, breaksLen - 1);
if (!legend.breaks || legend.breaks.length < 2) {
    legend.colors = [];
    (legend as any).class0 = { color: cfg.noDataColor ?? '#ccc', label: 'Нет данных' };
    return legend;
}
    const colors: string[] = [];
    for (let i = 0; i < n; i++) {
        const t = n > 1 ? i / (n - 1) : 0.5;
        const rgba = sampleColorRamp(ramp, t);
        colors.push(
            `#${((1 << 24) + (rgba[0] << 16) + (rgba[1] << 8) + rgba[2]).toString(16).slice(1)}`,
        );
    }
    legend.colors = colors;

    // pseudo-fields: class0.color, class1.color, ...
    for (let i = 0; i < colors.length; i++) {
        const key = `class${i}`;
        const lo = legend.breaks[i];
        const hi = legend.breaks[i + 1];
        const fmtNum = (v: number | undefined): string => {
    if (v == null) return '…';
    const n = Number(v);
    if (!isFinite(n)) return String(v);
    if (Math.abs(n) >= 1e9) return (n / 1e9).toFixed(1).replace(/\.0$/, '') + 'B';
    if (Math.abs(n) >= 1e6) return (n / 1e6).toFixed(1).replace(/\.0$/, '') + 'M';
    if (Math.abs(n) >= 1e3) return (n / 1e3).toFixed(0) + 'K';
    return String(Math.round(n));
};

const label = `${fmtNum(lo)} – ${fmtNum(hi)}`;
        legend.fields[key] = { key, label, color: colors[i] };
        (legend as any)[key] = { color: colors[i], label };
    }

    return legend;
}

const _3D_TO_2D: Record<string, string> = {
    bar3d: 'bar',
    vienna3d: 'vienna',
    viennacubes: 'vienna',
};

export function buildDiagram3DLegend(
    layer: any,
    _geojson: GeoJSONInput,
    cfg: any,
    opts: LegendOptions,
): MapLegend {
    const fields: LegendFieldInfo[] = (cfg.fields ?? []).map((key: string) => ({
        key,
        label: key,
        color: fallbackColor(cfg.colorMap?.[key]),
    }));

    const diagType = cfg.type ?? 'bar3d';
    const legend = new MapLegend({
        layer,
        kind: 'diagram3D',
        diagramType: diagType,
        title: opts.title,
        template: opts.template,
        fields,
    });
    legend.unitValue = cfg.unitValue;

    // Пример: 2D-эквивалент
    const twoD = _3D_TO_2D[String(diagType).toLowerCase()];
    if (twoD && opts.showExample !== false && fields.length) {
        const syntheticData: DiagramData[] = fields.map(f => ({
            label: f.label, value: 1, color: f.color,
        }));
        legend.example = renderDiagramCanvas(twoD, syntheticData, {
            unitPx: 6,
            strokeColor: cfg.strokeColor,
            strokeWidth: cfg.strokeWidthM ?? 1,
        }, opts.dpr ?? 1);
    }
    return legend;
}