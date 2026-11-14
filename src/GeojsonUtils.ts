/**
 * GeojsonUtils.ts — типы, константы и чистые вспомогательные функции
 * для Geojson.ts и миксинов GeojsonPoints/Shapes/Vectors.
 */
import type { MarkerOptions, IconSize } from './Marker.js';
import type { Marker3DOptions, Vec3, SizeSpec, PrimitiveType } from './Marker3D.js';
import type { Area3DOptions, Area3DFit } from './Area3D.js';
import type { PolylineOptions } from './Polyline.js';
import type { PolygonOptions } from './Polygon.js';
import type { Vector3DOptions, ArrowSizeMode } from './Vector3D.js';
import type { Diagram, DiagramOptions } from './Diagram.js';
import type { Diagram3D, Diagram3DSpawnOptions } from './Diagram3D.js';
import type { SpatialObject } from './SpatialObject.js';
import type { DiagramOrientation, LabelPosition } from './DiagramTypes.js';
import type { LegendOptions, LegendContext } from './Legend.js';

// =====================================================================
// GeoJSON types
// =====================================================================

export type GeoJSONCoord = [number, number] | [number, number, number];
export type GeoJSONLineString = GeoJSONCoord[];
export type GeoJSONPolygon = GeoJSONCoord[][];
export type GeoJSONProperties = Record<string, any>;
export type Props = GeoJSONProperties;

export interface GeoJSONPointGeometry { type: 'Point'; coordinates: GeoJSONCoord; }
export interface GeoJSONLineStringGeometry { type: 'LineString'; coordinates: GeoJSONLineString; }
export interface GeoJSONMultiLineStringGeometry { type: 'MultiLineString'; coordinates: GeoJSONLineString[]; }
export interface GeoJSONPolygonGeometry { type: 'Polygon'; coordinates: GeoJSONPolygon; }
export interface GeoJSONMultiPolygonGeometry { type: 'MultiPolygon'; coordinates: GeoJSONPolygon[]; }

export type GeoJSONGeometry =
    | GeoJSONPointGeometry | GeoJSONLineStringGeometry | GeoJSONMultiLineStringGeometry
    | GeoJSONPolygonGeometry | GeoJSONMultiPolygonGeometry;

export interface GeoJSONFeature {
    type: 'Feature';
    geometry: GeoJSONGeometry;
    properties?: GeoJSONProperties | null;
    id?: string | number;
}
export interface GeoJSONFeatureCollection { type: 'FeatureCollection'; features: GeoJSONFeature[]; }
export type GeoJSONInput = GeoJSONFeatureCollection | GeoJSONFeature | GeoJSONGeometry;
export type DiagramSpawnOptions = Omit<DiagramOptions, 'position' | 'crs' | 'parentPolygon'>;

// =====================================================================
// Choropleth / color ranges
// =====================================================================

export interface ChoroplethConfig {
    value: string | ((props: Props) => number);
    colorRamp: string | any[];
    colorRampReverse?: boolean;
    classification?: 'equal' | 'quantile' | 'jenks' | 'logarithmic'
                   | 'stddev' | 'geometric' | 'arithmetic' | 'headtail' | number[];
    classes?: number;
    noDataColor?: string;
    pretty?: boolean;
    legend?: LegendOptions;
}

export interface ColorRange { min?: number; max?: number; color: string; }
export type ColorMapValue = string | ColorRange[];

// =====================================================================
// Layer configs
// =====================================================================

export interface Diagram3DLayerConfig {
    type?: string;
    fields: string[];
    unitM?: number | 'auto';
    maxHeightM?: number;
    minValueM?: number;
    barWidthM?: number;
    barDepthM?: number;
    gapM?: number;
    colorMap?: Record<string, ColorMapValue>;
    strokeColor?: string | number;
    strokeWidthM?: number;
    minZoom?: number;
    maxZoom?: number;
    altitude?: number;
    altitudeMode?: 'clampToGround' | 'absolute';
    unitValue?: number;
    maxCols?: number;
    primitiveType?: PrimitiveType;
    legend?: LegendOptions;
}

export interface DiagramLayerConfig {
    type?: string;
    fields: string[];
    unitPx?: number | 'auto';
    valuePerPx?: number;
    maxHeightPx?: number;
    orientation?: DiagramOrientation;
    colorMap?: Record<string, ColorMapValue>;
    barWidth?: number;
    gap?: number;
    padding?: number;
    strokeColor?: string;
    strokeWidth?: number;
    segmentSizes?: number[];
    labelField?: string;
    labelPosition?: LabelPosition;
    labelFont?: string;
    labelColor?: string;
    unitValue?: number;
    maxCols?: number;
    shape?: 'square' | 'circle';
    showTotal?: boolean;
    totalFont?: string;
    totalBg?: string;
    totalColor?: string;
    totalBorder?: string;
    projection?: 'oblique' | 'isometric';
    fitToPolygon?: boolean;
    minScreenScale?: number;
    minZoom?: number;
    maxZoom?: number;
    coins?: number[];
    legend?: LegendOptions;
}

// =====================================================================
// Style aliases / rules
// =====================================================================

export interface PointStyleAliases { icon?: string; }
export interface Marker3DStyleAliases { model?: string | null; }
export interface LineStyleAliases {
    stroke?: string | number; 'stroke-color'?: string | number;
    'stroke-width'?: number; 'stroke-opacity'?: number;
}
export interface PolygonStyleAliases extends LineStyleAliases {
    fill?: string | number; 'fill-color'?: string | number; 'fill-opacity'?: number;
}
export interface Area3DStyleAliases { model?: string | null; }
export interface VectorStyleAliases extends LineStyleAliases {
    'arrow-size'?: number; 'arrow-size-mode'?: ArrowSizeMode; 'height-scale'?: number;
}

export const POINT_ALIASES: Record<string, string> = { icon: 'iconUrl' };
export const MARKER3D_ALIASES: Record<string, string> = { model: 'modelUrl' };
export const LINE_ALIASES: Record<string, string> = {
    stroke: 'color', 'stroke-color': 'color',
    'stroke-width': 'width', 'stroke-opacity': 'opacity',
};
export const POLYGON_ALIASES: Record<string, string> = {
    fill: 'fillColor', 'fill-color': 'fillColor', 'fill-opacity': 'fillOpacity',
    stroke: 'strokeColor', 'stroke-color': 'strokeColor',
    'stroke-width': 'strokeWidth', 'stroke-opacity': 'strokeOpacity',
};
export const AREA3D_ALIASES: Record<string, string> = { model: 'modelUrl' };
export const VECTOR_ALIASES: Record<string, string> = {
    ...LINE_ALIASES,
    'arrow-size': 'arrowSize',
    'arrow-size-mode': 'arrowSizeMode',
    'height-scale': 'heightScale',
};

const NUMERIC_OPTION_KEYS = new Set([
    'fillOpacity', 'strokeOpacity', 'strokeWidth', 'width', 'opacity', 'arrowSize',
    'heightScale', 'simplifyTolerance', 'simplifyZoomBucket',
]);

export interface StyleRule {
    fill?: string | number; 'fill-color'?: string | number; 'fill-opacity'?: number;
    fillColor?: string | number; fillOpacity?: number;
    stroke?: string | number; 'stroke-color'?: string | number;
    'stroke-width'?: number; 'stroke-opacity'?: number;
    strokeColor?: string | number; strokeWidth?: number; strokeOpacity?: number;
    color?: string | number; width?: number; opacity?: number;
    icon?: string; iconUrl?: string; iconSize?: IconSize;
    model?: string | null; modelUrl?: string | null;
    size?: SizeSpec | null; primitiveType?: PrimitiveType;
    title?: string; tooltip?: string;
    minZoom?: number; maxZoom?: number;
    altitude?: number; altitudeMode?: 'clampToGround' | 'absolute';
    anchor?: [number, number] | [number, number, number];
    arrowSize?: number; 'arrow-size'?: number;
    arrowSizeMode?: ArrowSizeMode; 'arrow-size-mode'?: ArrowSizeMode;
    heightScale?: number; 'height-scale'?: number;
    titleStart?: string; titleEnd?: string;
    simplify?: boolean; simplifyTolerance?: number; simplifyZoomBucket?: number;
    [key: string]: any;
}

export interface StyleTypeConfig { cases?: Record<string, StyleRule>; default?: StyleRule; }
export type StyleTypeKey = 'polygon' | 'line' | 'point' | 'area3D' | 'marker3D' | 'vector';
export interface StyleConfig extends StyleTypeConfig {
    by?: string;
    polygon?: StyleTypeConfig;
    line?: StyleTypeConfig;
    point?: StyleTypeConfig;
    area3D?: StyleTypeConfig;
    marker3D?: StyleTypeConfig;
    vector?: StyleTypeConfig;
}

// =====================================================================
// Filters
// =====================================================================

export type FeatureFilterSpec = Record<
    string,
    string | number | boolean | null | readonly (string | number | boolean | null)[]
>;
export type FeatureFilterInput =
    | string | FeatureFilterSpec | readonly unknown[]
    | ((feature: GeoJSONFeature) => boolean) | null;

const replaceEqOutsideStrings = (expr: string): string => {
    let out = '', i = 0, str: string | null = null;
    while (i < expr.length) {
        const ch = expr[i];
        if (str) {
            out += ch;
            if (ch === '\\' && i + 1 < expr.length) { out += expr[++i]; i++; continue; }
            if (ch === str) str = null;
            i++; continue;
        }
        if (ch === "'" || ch === '"' || ch === '`') { str = ch; out += ch; i++; continue; }
        if (ch === '=') {
            const prev = out[out.length - 1], next = expr[i + 1];
            if (prev === '<' || prev === '>' || prev === '!' || prev === '=' ||
                next === '=' || next === '>') { out += ch; i++; continue; }
            out += '==='; i++; continue;
        }
        out += ch; i++;
    }
    return out;
};

export const interpolate = (tpl: string, props: Record<string, any>): string =>
    tpl.replace(/\{([\w.]+)\}/g, (_m, key) => {
        const v = key.includes('.')
            ? key.split('.').reduce((o: any, k: string) => (o == null ? undefined : o[k]), props)
            : props[key];
        return v == null ? '' : String(v);
    });

const expandOrChains = (expr: string): string => {
    const LIT = String.raw`(?:'[^'\\]*(?:\\.[^'\\]*)*'|"[^"\\]*(?:\\.[^"\\]*)*"|\d+(?:\.\d+)?|true|false|null)`;
    const FIELD = String.raw`[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*`;
    const chainRe = new RegExp(`(${FIELD})\\s*===\\s*(${LIT}(?:\\s*\\|\\|\\s*${LIT})+)`, 'g');
    const litRe = new RegExp(LIT, 'g');
    return expr.replace(chainRe, (_m, field, chain) => {
        const lits = chain.match(litRe);
        return lits && lits.length >= 2 ? lits.map(l => `${field} === ${l}`).join(' || ') : _m;
    });
};

export const compileExpressionFilter = (expr: string): (f: GeoJSONFeature) => boolean => {
    const processed = expandOrChains(replaceEqOutsideStrings(expr));
    const src = `
        const props = feature.properties ?? {};
        const geometry = feature.geometry?.type ?? null;
        const __scope = new Proxy(
            Object.assign(Object.create(null), { feature, props, geometry, geometryType: geometry }),
            {
                has: (t, k) => typeof k === 'string' && (
                    Object.prototype.hasOwnProperty.call(t, k) ||
                    Object.prototype.hasOwnProperty.call(props, k)),
                get: (t, k) => {
                    if (typeof k !== 'string') return undefined;
                    if (Object.prototype.hasOwnProperty.call(t, k)) return t[k];
                    return props[k];
                },
            });
        with (__scope) { return Boolean(${processed}); }
    `;
    let fn: (f: any) => boolean;
    try { fn = new Function('feature', src) as (f: any) => boolean; }
    catch (err) {
        console.warn('GeoJSONLayer: invalid filter expression', expr, err);
        return () => false;
    }
    return (f) => {
        try { return fn(f); }
        catch (err) { console.warn('GeoJSONLayer: filter expression threw', err); return false; }
    };
};

export const mapboxToJsExpr = (node: unknown): string => {
    if (!Array.isArray(node) || !node.length) throw new Error('Invalid Mapbox filter');
    const op = node[0] as string;
    const rest = node.slice(1) as unknown[];
    switch (op) {
        case '==': case '!=': case '<': case '<=': case '>': case '>=': {
            if (rest.length !== 2) throw new Error(`Mapbox "${op}" needs 2 args`);
            const jsOp = op === '==' ? '===' : op === '!=' ? '!==' : op;
            return `(${mapboxField(rest[0])} ${jsOp} ${mapboxLiteral(rest[1])})`;
        }
        case 'in': case '!in': {
            if (rest.length < 2) throw new Error(`Mapbox "${op}" needs key + values`);
            const key = mapboxField(rest[0]);
            const vals = (rest.length === 2 && Array.isArray(rest[1]) && (rest[1] as any[])[0] === 'literal')
                ? (rest[1] as any[])[1] : rest.slice(1);
            const ors = (vals as unknown[]).map(v => `${key} === ${mapboxLiteral(v)}`).join(' || ');
            return op === 'in' ? `(${ors})` : `!(${ors})`;
        }
        case 'has': return `(${mapboxField(rest[0])} !== undefined)`;
        case '!has': return `(${mapboxField(rest[0])} === undefined)`;
        case 'all': return rest.length ? `(${rest.map(mapboxToJsExpr).join(' && ')})` : 'true';
        case 'any': return rest.length ? `(${rest.map(mapboxToJsExpr).join(' || ')})` : 'false';
        case 'none': return rest.length ? `!(${rest.map(mapboxToJsExpr).join(' || ')})` : 'true';
        case '!': return `!(${mapboxToJsExpr(rest[0])})`;
        default: throw new Error(`Unsupported Mapbox operator: "${op}"`);
    }
};

const mapboxField = (node: unknown): string => {
    if (typeof node === 'string') {
        if (node === '$type') return 'geometry';
        if (node === '$id') return 'feature.id';
        return `props[${JSON.stringify(node)}]`;
    }
    if (Array.isArray(node)) {
        if (node[0] === 'get') return mapboxField(node[1]);
        if (node[0] === 'geometry-type') return 'geometry';
        if (node[0] === 'id') return 'feature.id';
    }
    throw new Error(`Unsupported Mapbox field: ${JSON.stringify(node)}`);
};

const mapboxLiteral = (node: unknown): string => {
    if (typeof node === 'string') return JSON.stringify(node);
    if (typeof node === 'number') return Number.isFinite(node) ? String(node) : 'null';
    if (typeof node === 'boolean') return String(node);
    if (node === null) return 'null';
    if (Array.isArray(node)) {
        if (node[0] === 'literal') return JSON.stringify(node[1]);
        if (node[0] === 'get') return mapboxField(node[1]);
        return JSON.stringify(node);
    }
    throw new Error(`Unsupported Mapbox literal: ${JSON.stringify(node)}`);
};

const getPath = (obj: any, path: string): any => {
    if (!path.includes('.')) return obj?.[path];
    let cur = obj;
    for (const p of path.split('.')) {
        if (cur == null) return undefined;
        cur = cur[p];
    }
    return cur;
};

const matchFilterValue = (actual: any, expected: FeatureFilterSpec[string]): boolean => {
    if (Array.isArray(expected)) return expected.some(v => v === actual);
    if (expected === null) return actual == null;
    return actual === expected;
};

const resolveFilterPath = (feature: GeoJSONFeature, path: string): any => {
    const props = feature.properties ?? {};
    const geom = feature.geometry?.type ?? null;
    if (path === 'geometry' || path === 'geometryType') return geom;
    if (path === 'feature') return feature;
    if (path === 'props') return props;
    if (path.startsWith('feature.')) return getPath(feature, path.slice(8));
    if (path.startsWith('props.')) return getPath(props, path.slice(6));
    return getPath(props, path);
};

export const compileObjectFilter = (spec: FeatureFilterSpec): (f: GeoJSONFeature) => boolean => {
    const entries = Object.entries(spec);
    return (feature) => {
        for (const [path, expected] of entries) {
            if (!matchFilterValue(resolveFilterPath(feature, path), expected)) return false;
        }
        return true;
    };
};

// =====================================================================
// Color helpers
// =====================================================================

export const PALETTE_3D_FALLBACK = [
    '#3498db', '#e74c3c', '#2ecc71', '#f39c12',
    '#9b59b6', '#1abc9c', '#e67e22', '#34495e',
];

export const resolveColorMapValue = (spec: ColorMapValue | undefined, value: number): string | undefined => {
    if (!spec) return undefined;
    if (typeof spec === 'string') return spec;
    for (const r of spec) {
        if ((r.min == null || value >= r.min) && (r.max == null || value < r.max)) return r.color;
    }
    return undefined;
};

// =====================================================================
// Callback types
// =====================================================================

export type PointOptionsCallback =
    (feature: GeoJSONFeature, props: Props) => (Partial<MarkerOptions> & PointStyleAliases) | null | undefined;
export type Point3DOptionsCallback =
    (feature: GeoJSONFeature, props: Props) => (Partial<Marker3DOptions> & Marker3DStyleAliases) | null | undefined;
export type LineOptionsCallback =
    (feature: GeoJSONFeature, props: Props) => (Partial<PolylineOptions> & LineStyleAliases) | null | undefined;
export type PolygonOptionsCallback =
    (feature: GeoJSONFeature, props: Props) => (Partial<PolygonOptions> & PolygonStyleAliases) | null | undefined;
export type Polygon3DOptionsCallback =
    (feature: GeoJSONFeature, props: Props) => (Partial<Area3DOptions> & Area3DStyleAliases) | null | undefined;
export type VectorOptionsCallback =
    (feature: GeoJSONFeature, props: Props) => (Partial<Vector3DOptions> & VectorStyleAliases) | null | undefined;
export type OnEachFeatureCallback = (feature: GeoJSONFeature, object: SpatialObject) => void;

// =====================================================================
// Layer options
// =====================================================================

export interface GeoJSONLayerOptions {
    url?: string;
    data?: GeoJSONInput;
    crs?: string;
    choropleth?: ChoroplethConfig;

    tooltip?: string | ((props: Props) => string | null) | null;
    tooltipField?: string | null;
    tooltipOnHover?: boolean;
    titleField?: string | null;

    featureFilter?: FeatureFilterInput;
    /** @deprecated Используйте `featureFilter`. */
    filter?: FeatureFilterInput;
    onEachFeature?: OnEachFeatureCallback;
    style?: StyleConfig;

    pointToOptions?: PointOptionsCallback;
    point3DToOptions?: Point3DOptionsCallback;
    lineToOptions?: LineOptionsCallback;
    polygonToOptions?: PolygonOptionsCallback;
    polygon3DToOptions?: Polygon3DOptionsCallback;
    vectorToOptions?: VectorOptionsCallback;
    legendToOptions?: (ctx: LegendContext) => Partial<LegendOptions> | null | undefined;

    diagram3D?: Diagram3DLayerConfig;
    diagram3DToOptions?: (feature: GeoJSONFeature, props: Props) => Diagram3DSpawnOptions | null;
    onEachDiagram3D?: (feature: GeoJSONFeature, diagram: Diagram3D) => void;

    diagram?: DiagramLayerConfig;
    diagramToOptions?: (feature: GeoJSONFeature, props: Props) => DiagramSpawnOptions | null;
    onEachDiagram?: (feature: GeoJSONFeature, diagram: Diagram) => void;

    defaultIconUrl?: string;
    defaultIconSize?: IconSize;
    defaultAnchor?: [number, number];

    default3DPrimitiveType?: PrimitiveType;
    default3DSize?: SizeSpec | null;
    default3DAnchor?: Vec3;
    default3DAltitude?: number;
    default3DAltitudeMode?: 'clampToGround' | 'absolute';

    defaultLineColor?: string | number;
    defaultLineWidth?: number;
    defaultLineOpacity?: number;
    defaultLineAltitudeMode?: 'clampToGround' | 'absolute';
    defaultLineAltitude?: number;
    /** @deprecated */
    defaultLineAltitudeOffset?: number;
    defaultLineDepthTest?: boolean;
    defaultLineDepthWrite?: boolean;
    defaultLineMinZoom?: number;
    defaultLineMaxZoom?: number;

    defaultVectorColor?: string | number;
    defaultVectorWidth?: number;
    defaultVectorOpacity?: number;
    defaultVectorArrowSize?: number;
    defaultVectorArrowSizeMode?: ArrowSizeMode;
    defaultVectorHeightScale?: number;
    defaultVectorAltitude?: number;
    defaultVectorAltitudeMode?: 'clampToGround' | 'absolute';
    defaultVectorDepthTest?: boolean;
    defaultVectorDepthWrite?: boolean;
    defaultVectorMinZoom?: number;
    defaultVectorMaxZoom?: number;
    defaultVectorSimplify?: boolean;
    defaultVectorSimplifyTolerance?: number;
    defaultVectorSimplifyZoomBucket?: number;

    defaultFillColor?: string | number;
    defaultFillOpacity?: number;
    defaultStrokeColor?: string | number;
    defaultStrokeWidth?: number;
    defaultStrokeOpacity?: number;
    defaultPolygonAltitudeMode?: 'clampToGround' | 'absolute';
    defaultPolygonAltitude?: number;
    /** @deprecated */
    defaultPolygonAltitudeOffset?: number;
    defaultPolygonDepthTest?: boolean;
    defaultPolygonDepthWrite?: boolean;
    defaultPolygonMinZoom?: number;
    defaultPolygonMaxZoom?: number;
    defaultPolygonExtruded?: boolean;
    defaultPolygonHeight?: number;
    defaultPolygonMinHeight?: number;

    defaultPolygon3DPrimitiveType?: PrimitiveType;
    defaultPolygon3DSize?: SizeSpec | null;
    defaultPolygon3DAnchor?: [number, number, number];
    defaultPolygon3DAltitude?: number;
    defaultPolygon3DAltitudeMode?: 'clampToGround' | 'absolute';
    defaultPolygon3DFit?: Area3DFit;
    defaultPolygon3DRotate?: number;
    defaultPolygon3DModelUrl?: string | null;
    defaultPolygon3DDepthTest?: boolean;
    defaultPolygon3DDepthWrite?: boolean;
}

// =====================================================================
// Style helpers (free functions, no `this`)
// =====================================================================

export function pickStyleLevel(cfg: StyleTypeConfig | undefined, value: any): StyleRule | null {
    if (!cfg) return null;
    if (value != null && cfg.cases) {
        const c = cfg.cases[value];
        if (c) return c;
    }
    return cfg.default ?? null;
}

export function resolveStyle(style: StyleConfig | null, props: Props, type: StyleTypeKey): StyleRule | null {
    if (!style) return null;
    const value = props[style.by ?? 'category'];
    const shared = pickStyleLevel(style, value);
    const perType = pickStyleLevel(style[type], value);
    if (!shared && !perType) return null;
    if (!shared) return perType;
    if (!perType) return shared;
    return { ...shared, ...perType };
}

export function normalizeStyle<T extends Record<string, any>>(
    src: Record<string, any> | null | undefined,
    aliases: Record<string, string>,
): Partial<T> | null {
    if (!src) return null;
    const out: any = { ...src };
    for (const [alias, canonical] of Object.entries(aliases)) {
        if (out[canonical] === undefined && out[alias] != null) {
            out[canonical] = NUMERIC_OPTION_KEYS.has(canonical)
                ? asNumber(out[alias]) ?? out[alias]
                : out[alias];
        }
        delete out[alias];
    }
    return out as Partial<T>;
}

export function interpolateStyle<T extends Record<string, any> | null | undefined>(style: T, props: Props): T {
    if (!style || typeof style !== 'object') return style;
    const out: any = {};
    for (const [k, v] of Object.entries(style as any)) {
        out[k] = (typeof v === 'string' && v.includes('{')) ? interpolate(v, props) : v;
    }
    return out as T;
}

export function evaluateValueExpression(props: Props, exprOrFn: string | ((p: Props) => number)): number {
    if (typeof exprOrFn === 'function') return exprOrFn(props);
    try {
        const fn = new Function('props', `
            const __scope = new Proxy(
                Object.assign(Object.create(null), { props }),
                {
                    has: (t, k) => typeof k === 'string' && (
                        Object.prototype.hasOwnProperty.call(t, k) ||
                        Object.prototype.hasOwnProperty.call(props, k)),
                    get: (t, k) => {
                        if (typeof k !== 'string') return undefined;
                        if (Object.prototype.hasOwnProperty.call(t, k)) return t[k];
                        return props[k];
                    },
                });
            with (__scope) { return Number(${exprOrFn}); }
        `);
        return fn(props);
    } catch { return NaN; }
}

export function getTitle(titleField: string | null, props: Props): string {
    if (titleField) {
        const v = props[titleField];
        if (v != null && v !== '') return String(v);
    }
    return props.title || props.name || '';
}

export function getTooltip(
    tooltip: string | ((props: Props) => string | null) | null,
    tooltipField: string | null,
    props: Props,
): string {
    if (typeof tooltip === 'function') {
        try {
            const out = tooltip(props);
            if (out != null) return String(out);
        } catch (e) { console.warn('GeoJSONLayer: tooltip callback threw', e); }
    } else if (typeof tooltip === 'string' && tooltip) {
        return tooltip.includes('{') ? interpolate(tooltip, props) : tooltip;
    }
    if (tooltipField) {
        const raw = props[tooltipField];
        if (raw != null && raw !== '') {
            return String(raw).includes('{') ? interpolate(String(raw), props) : String(raw);
        }
    }
    return props.tooltip || props.description || '';
}

// =====================================================================
// Parsers
// =====================================================================

export function parseSize(raw: any): number[] | null {
    if (!raw) return null;
    if (Array.isArray(raw)) return raw as number[];
    if (typeof raw === 'string') {
        const p = raw.split(',').map(Number);
        if (p.length >= 1 && p.length <= 3 && p.every(v => !isNaN(v))) return p;
    }
    return null;
}
export function parseIconSize(raw: any): IconSize | null {
    const a = parseSize(raw);
    return a && a.length === 2 ? [a[0], a[1]] : null;
}
export function parseSizeSpec(raw: any): SizeSpec | null {
    const a = parseSize(raw);
    return a && a.length >= 1 && a.length <= 3 ? a : null;
}
export function parsePair(raw: any): [number, number] | null {
    if (!raw) return null;
    if (Array.isArray(raw) && raw.length === 2) {
        const [a, b] = raw;
        if (typeof a === 'number' && typeof b === 'number' && isFinite(a) && isFinite(b)) return [a, b];
    }
    if (typeof raw === 'string') {
        const p = raw.split(',').map(Number);
        if (p.length === 2 && p.every(v => !isNaN(v))) return [p[0], p[1]];
    }
    return null;
}
export function parseTriple(raw: any): [number, number, number] | null {
    if (!raw) return null;
    if (Array.isArray(raw) && raw.length === 3) {
        const [a, b, c] = raw;
        if (typeof a === 'number' && typeof b === 'number' && typeof c === 'number'
            && isFinite(a) && isFinite(b) && isFinite(c)) return [a, b, c];
    }
    if (typeof raw === 'string') {
        const p = raw.split(',').map(Number);
        if (p.length === 3 && p.every(v => !isNaN(v))) return [p[0], p[1], p[2]];
    }
    return null;
}
export function asNumber(v: any): number | undefined {
    if (typeof v === 'number' && isFinite(v)) return v;
    if (typeof v === 'string' && v.trim() !== '') {
        const n = Number(v);
        if (isFinite(n)) return n;
    }
    return undefined;
}