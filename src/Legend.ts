// Legend.ts
import {
    type DiagramData, type DiagramRenderParams,
    type DiagramOrientation,
    type DiagramScaleInfo,
    type CoinSpec,
    getDiagramType,
    resolveDiagramUnitPx,
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

export interface LegendFormatContext {
    isFirst: boolean;
    isLast: boolean;
    index: number;
    total: number;
}

export interface LegendFormatOptions {
    number?: (v: number) => string;
    range?: (
        lo: number | undefined,
        hi: number | undefined,
        ctx: LegendFormatContext,
    ) => string;
}

export type ExamplePicker =
    | 'auto'
    | number
    | Record<string, any>
    | ((features: GeoJSONFeature[]) => GeoJSONFeature | null);

export interface LegendClassInfo {
    key: string;
    label: string;
    color: string;
    index: number;
    lo?: number;
    hi?: number;
}

export interface LegendOptions {
    target?: string | HTMLElement;
    title?: string;
    template?: string;
    example?: ExamplePicker;
    onReady?: (legend: MapLegend) => void;
    showExample?: boolean;
    dpr?: number;
    format?: LegendFormatOptions;
    /** @internal Используется только на уровне GeoJSONLayerOptions. */
    legendToOptions?: (ctx: LegendContext) => Partial<LegendOptions> | null | undefined;
}

export interface LegendContext {
    layer: any;
    kind: 'diagram' | 'diagram3D' | 'choropleth';
    cfg: any;
    geojson: GeoJSONInput;
    base: LegendOptions;
}

const RESERVED = new Set([
    'layer', 'kind', 'diagramType', 'title', 'fields', 'example', 'classes',
    'unitPx', 'unitValue', 'maxCols', 'orientation', 'shape', 'coins', 'scale',
    'breaks', 'colors', 'valueExpr',
    'mount', 'render', 'destroy', 'update',
    '_target', '_renderedEl', '_template',
    '_render', '_extractBlock', '_truthy', '_resolvePath',
]);

// ─────────────────────────────────────────────────────────────────
// Русские форматтеры по умолчанию
// ─────────────────────────────────────────────────────────────────

export function defaultFormatNumber(v: number): string {
    if (!isFinite(v)) return String(v);
    const abs  = Math.abs(v);
    const sign = v < 0 ? '-' : '';

    const fmt = (unit: number, suffix: string) => {
        const s = abs / unit;
        const rounded = s >= 100 ? Math.round(s) : Math.round(s * 10) / 10;
        return sign + String(rounded).replace('.', ',') + ' ' + suffix;
    };

    if (abs >= 1e12) return fmt(1e12, 'трлн.');
    if (abs >= 1e9)  return fmt(1e9,  'млрд.');
    if (abs >= 1e6)  return fmt(1e6,  'млн.');
    if (abs >= 10000) {
        if (Math.round(abs / 1000) >= 1000) return fmt(1e6, 'млн.');
        return fmt(1000, 'тыс.');
    }
    return sign + String(Math.round(abs));
}

export function defaultFormatRange(
    lo: number | undefined,
    hi: number | undefined,
    ctx: LegendFormatContext,
    fmt: (v: number) => string,
): string {
    const fmtLo = lo != null ? fmt(lo) : '…';
    const fmtHi = hi != null ? fmt(hi) : '…';

    if (ctx.isFirst) return `до ${fmtHi}`;
    if (ctx.isLast)  return `${fmtLo} и более`;
    return `от ${fmtLo} до ${fmtHi}`;
}

// ─────────────────────────────────────────────────────────────────
// MapLegend
// ─────────────────────────────────────────────────────────────────

export class MapLegend {
    readonly layer: any;
    readonly kind: 'diagram' | 'diagram3D' | 'choropleth';
    readonly diagramType: string;
    title: string;
    readonly fields: Record<string, LegendFieldInfo> = {};
    classes?: LegendClassInfo[];

    example: HTMLCanvasElement | null = null;
    unitPx?: number;
    unitValue?: number;
    maxCols?: number;
    orientation?: DiagramOrientation;
    shape?: 'square' | 'circle';
    /** Готовые кружки-монетки для типа 'coin' (шаблон: {{#each coins}}{{html}}{{value}}{{/each}}). */
    coins?: CoinSpec[];
    /** Полное описание масштаба — {{scale.text}}, {{scale.valueText}}, {{scale.unitLabel}}. */
    scale?: DiagramScaleInfo | null = null;
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
        this.layer       = init.layer;
        this.kind        = init.kind;
        this.diagramType = init.diagramType;
        this.title       = init.title ?? '';
        this._template   = init.template ?? null;

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
            ? (document.getElementById(target)
                ?? document.querySelector<HTMLElement>(target))
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

    // ── template engine ─────────────────────────────────────────

    private _interpolate(tpl: string): string {
        return this._render(tpl, this);
    }

    private _render(tpl: string, scope: any): string {
        let out = '';
        let i = 0;
        while (i < tpl.length) {
            const open = tpl.indexOf('{{', i);
            if (open < 0) { out += tpl.slice(i); break; }
            out += tpl.slice(i, open);

            const close = tpl.indexOf('}}', open);
            if (close < 0) { out += tpl.slice(open); break; }

            const tag = tpl.slice(open + 2, close).trim();
            const afterOpen = close + 2;

            if (tag.startsWith('#each ')) {
                const path = tag.slice(6).trim();
                const block = this._extractBlock(tpl, afterOpen, 'each');
                if (!block) { out += tpl.slice(open, afterOpen); i = afterOpen; continue; }
                const arr = this._resolvePath(path, scope);
                if (Array.isArray(arr)) {
                    out += arr.map((item, idx) => {
                        const itemScope: any =
                            (item && typeof item === 'object')
                                ? Object.assign(Object.create(null), item, { this: item })
                                : { this: item };
                        itemScope['@index']  = idx;
                        itemScope['@number'] = idx + 1;
                        itemScope['@first']  = idx === 0;
                        itemScope['@last']   = idx === arr.length - 1;
                        return this._render(block.body, itemScope);
                    }).join('');
                }
                i = block.endIdx;
                continue;
            }

            if (tag.startsWith('#each-reverse ')) {
                const path = tag.slice(14).trim();
                const block = this._extractBlock(tpl, afterOpen, 'each-reverse');
                if (!block) { out += tpl.slice(open, afterOpen); i = afterOpen; continue; }
                const arr = this._resolvePath(path, scope);
                if (Array.isArray(arr)) {
                    const reversed = arr.slice().reverse();
                    out += reversed.map((item, idx) => {
                        const itemScope: any =
                            (item && typeof item === 'object')
                                ? Object.assign(Object.create(null), item, { this: item })
                                : { this: item };
                        itemScope['@index']  = idx;
                        itemScope['@number'] = idx + 1;
                        itemScope['@first']  = idx === 0;
                        itemScope['@last']   = idx === reversed.length - 1;
                        return this._render(block.body, itemScope);
                    }).join('');
                }
                i = block.endIdx;
                continue;
            }

            if (tag.startsWith('#if ')) {
                const path = tag.slice(4).trim();
                const block = this._extractBlock(tpl, afterOpen, 'if');
                if (!block) { out += tpl.slice(open, afterOpen); i = afterOpen; continue; }
                if (this._truthy(this._resolvePath(path, scope))) {
                    out += this._render(block.body, scope);
                }
                i = block.endIdx;
                continue;
            }

            if (tag.startsWith('#unless ')) {
                const path = tag.slice(8).trim();
                const block = this._extractBlock(tpl, afterOpen, 'unless');
                if (!block) { out += tpl.slice(open, afterOpen); i = afterOpen; continue; }
                if (!this._truthy(this._resolvePath(path, scope))) {
                    out += this._render(block.body, scope);
                }
                i = block.endIdx;
                continue;
            }

            if (tag.startsWith('/')) {
                out += tpl.slice(open, afterOpen);
                i = afterOpen;
                continue;
            }

            const v = this._resolvePath(tag, scope);
            if (v instanceof HTMLCanvasElement) out += `<span data-krb-example></span>`;
            else if (v == null)                 out += '';
            else if (typeof v === 'object')     out += JSON.stringify(v);
            else                                out += String(v);

            i = afterOpen;
        }
        return out;
    }

    private _extractBlock(
        tpl: string, start: number,
        kind: 'each' | 'each-reverse' | 'if' | 'unless',
    ): { body: string; endIdx: number } | null {
        const openTag  = `{{#${kind} `;
        const closeTag = `{{/${kind}}}`;
        let depth = 1;
        let i = start;

        while (i < tpl.length) {
            const nextOpen  = tpl.indexOf(openTag,  i);
            const nextClose = tpl.indexOf(closeTag, i);
            if (nextClose < 0) return null;

            if (nextOpen >= 0 && nextOpen < nextClose) {
                depth++;
                i = nextOpen + openTag.length;
            } else {
                depth--;
                if (depth === 0) {
                    return {
                        body:   tpl.slice(start, nextClose),
                        endIdx: nextClose + closeTag.length,
                    };
                }
                i = nextClose + closeTag.length;
            }
        }
        return null;
    }

    private _truthy(v: any): boolean {
        if (Array.isArray(v)) return v.length > 0;
        return !!v;
    }

    private _resolvePath(path: string, scope: any): any {
        const parts = path.split('.');
        let cur: any = scope;
        for (const p of parts) {
            if (cur == null) return undefined;
            if (typeof cur === 'object' && p in cur) {
                cur = cur[p];
            } else if (cur !== this && p in (this as any)) {
                cur = (this as any)[p];   // fallback: {{unitValue}} внутри #each
            } else {
                return undefined;
            }
        }
        return cur;
    }

    private _defaultRender(): string {
        const p: string[] = [];
        if (this.title)   p.push(`<div class="krb-legend-title">${this.title}</div>`);
        if (this.example) p.push(`<div class="krb-legend-example"></div>`);

        const items = Object.values(this.fields)
            .map(f => `<div><span class="krb-legend-swatch" style="background:${f.color}"></span>${f.label}</div>`);
        if (items.length) p.push(`<div class="krb-legend-fields">${items.join('')}</div>`);

        const footer: string[] = [];
        if (this.scale?.text) {
            footer.push(this.scale.text);
        } else {
            if (this.unitValue != null) footer.push(`1 символ = ${this.unitValue}`);
            if (this.unitPx    != null) footer.push(`1 ед. = ${this.unitPx}px`);
        }
        if (footer.length) p.push(`<div class="krb-legend-footer">${footer.join(' · ')}</div>`);

        return p.join('');
    }
}

// ─────────────────────────────────────────────────────────────────
// Builders — helpers
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

// ─────────────────────────────────────────────────────────────────
// buildDiagramLegend
// ─────────────────────────────────────────────────────────────────

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

    const typeName = cfg.type ?? 'bar';

    const legend = new MapLegend({
        layer,
        kind: 'diagram',
        diagramType: typeName,
        title: opts.title,
        template: opts.template,
        fields,
    });

    // ── Масштаб ──────────────────────────────────────────────────
    // Один и тот же unitPx используют рендер, пример и describeScale.
    const type = getDiagramType(typeName);
    const unitPx = resolveDiagramUnitPx(typeName, cfg, layer._diagramAuto?.unitPx);

    // Единый набор номиналов на слой (для 'coin') — иначе пример легенды
    // не совпадёт с рендером.
    const layerCoins: number[] | undefined =
        (typeof layer.getDiagramCoins === 'function'
            ? (layer.getDiagramCoins() as number[] | null)
            : null)
        ?? (Array.isArray(cfg.coins) ? (cfg.coins as number[]) : undefined);

    // Для describeScale('coin') нужен максимум по всем фичам слоя —
    // на случай, если coins пуст.
    let maxVal = 1;
    for (const f of features) {
        for (const k of (cfg.fields ?? [])) {
            const v = Number(f.properties?.[k]);
            if (isFinite(v) && v > maxVal) maxVal = v;
        }
    }

    const scale = type.describeScale?.({
        data: [{ label: '', value: maxVal }],
        width: 0, height: 0, dpr: 1,
        unitPx,
        unitValue: cfg.unitValue,
        coins: layerCoins,
    }) ?? null;

    legend.unitPx       = unitPx;
    legend.unitValue    = cfg.unitValue;
    legend.maxCols      = cfg.maxCols;
    legend.orientation  = cfg.orientation;
    legend.shape        = cfg.shape;
    legend.scale        = scale;
    legend.coins        = scale?.coins;

    // ── Пример ───────────────────────────────────────────────────
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

    if (exampleFeature && opts.showExample !== false) {
        const data: DiagramData[] = cfg.fields
            .map((key: string) => {
                const raw = Number(exampleFeature!.properties?.[key]);
                if (!isFinite(raw)) return null;
                return { label: key, value: Math.max(0, raw), color: legend.fields[key]?.color };
            })
            .filter((d): d is DiagramData => d !== null);

        if (data.length) {
            legend.example = renderDiagramCanvas(legend.diagramType, data, {
                unitPx,
                unitValue:     cfg.unitValue,
                maxCols:       cfg.maxCols,
                orientation:   cfg.orientation,
                shape:         cfg.shape,
                coins:         layerCoins,
                segmentSizes:  cfg.segmentSizes,
                gap:           cfg.gap,
                padding:       cfg.padding,
                strokeColor:   cfg.strokeColor,
                strokeWidth:   cfg.strokeWidth,
                projection:    cfg.projection,
            }, opts.dpr ?? (typeof window !== 'undefined' ? window.devicePixelRatio : 1));
        }
    }

    legend.classes = fields.map((f, i) => ({
        key: f.key, label: f.label, color: f.color, index: i,
    }));

    return legend;
}

// ─────────────────────────────────────────────────────────────────
// buildChoroplethLegend
// ─────────────────────────────────────────────────────────────────

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

    if (!Array.isArray(legend.breaks) || legend.breaks.length < 2) {
        const fb: LegendClassInfo = {
            key: 'class0',
            label: 'Нет данных',
            color: cfg.noDataColor ?? '#ccc',
            index: 0,
        };
        legend.colors   = [];
        legend.classes  = [fb];
        legend.fields['class0'] = { key: fb.key, label: fb.label, color: fb.color };
        (legend as any).class0  = { color: fb.color, label: fb.label };
        return legend;
    }

    const n = legend.breaks.length - 1;
    const colors: string[] = [];
    for (let i = 0; i < n; i++) {
        const t = n > 1 ? i / (n - 1) : 0.5;
        const rgba = sampleColorRamp(ramp, t);
        colors.push(
            `#${((1 << 24) + (rgba[0] << 16) + (rgba[1] << 8) + rgba[2]).toString(16).slice(1)}`,
        );
    }
    legend.colors = colors;

    const fmtNumber = opts.format?.number ?? defaultFormatNumber;
    const fmtRange  = opts.format?.range;

    const classes: LegendClassInfo[] = [];
    for (let i = 0; i < colors.length; i++) {
        const key = `class${i}`;
        const lo  = legend.breaks[i];
        const hi  = legend.breaks[i + 1];
        const ctx: LegendFormatContext = {
            isFirst: i === 0,
            isLast:  i === colors.length - 1,
            index:   i,
            total:   colors.length,
        };

        const label = fmtRange
            ? fmtRange(lo, hi, ctx)
            : defaultFormatRange(lo, hi, ctx, fmtNumber);

        classes.push({ key, label, color: colors[i], index: i, lo, hi });
        legend.fields[key]   = { key, label, color: colors[i] };
        (legend as any)[key] = { color: colors[i], label };
    }
    legend.classes = classes;

    return legend;
}

// ─────────────────────────────────────────────────────────────────
// buildDiagram3DLegend
// ─────────────────────────────────────────────────────────────────

const _3D_TO_2D: Record<string, string> = {
    bar3d:       'bar',
    vienna3d:    'vienna',
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

    legend.classes = fields.map((f, i) => ({
        key: f.key, label: f.label, color: f.color, index: i,
    }));

    return legend;
}