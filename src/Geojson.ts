/**
 * Geojson.ts — слой GeoJSON с поддержкой 3D и векторных линий.
 *
 * Стилизация: декларативный `style` (тематическая карта по одному полю)
 * или коллбэки `*ToOptions` (escape hatch). Оба принимают канонические
 * ключи `*Options` и CSS-подобные алиасы (`fill`, `stroke`, `stroke-width`,
 * `icon`, `model`).
 *
 * Фильтрация: JS-выражение строкой (`"type = 'city'"`), объект-спецификация
 * (`{ type: 'city' }`) или предикат. Строковая форма исполняется через
 * `new Function` и видит глобальный scope — не передавайте в неё
 * пользовательский ввод без валидации.
 *
 * @module Geojson
 */

import { Layer } from './Layers.js';
import {
    Marker,
    type MarkerOptions,
    type LonLat,
    type IconSize,
} from './Marker.js';
import {
    Marker3D,
    type Marker3DOptions,
    type Vec3,
    type SizeSpec,
    type PrimitiveType,
} from './Marker3D.js';
import {
    Area3D,
    type Area3DOptions,
    type Area3DRing,
    type Area3DFit,
} from './Area3D.js';
import {
    Polyline,
    type PolylineOptions,
} from './Polyline.js';
import {
    Polygon,
    type PolygonOptions,
} from './Polygon.js';
import {
    Vector3D,
    type Vector3DOptions,
    type Vector3DPosition,
} from './Vector3D.js';
import { Diagram, type DiagramOptions } from './Diagram.js';
import type { SpatialObject } from './SpatialObject.js';
import type { DiagramOrientation, LabelPosition } from './DiagramTypes.js';
import { calculateBreaks, getClassIndex } from './Classification.js';
import { resolveColorRamp, sampleColorRamp } from './ColorRamps.js';

// =====================================================================
// GeoJSON types
// =====================================================================

export type GeoJSONCoord = [number, number] | [number, number, number];
export type GeoJSONLineString = GeoJSONCoord[];
export type GeoJSONPolygon = GeoJSONCoord[][];
export type DiagramSpawnOptions =
    Omit<DiagramOptions, 'position' | 'crs' | 'parentPolygon'>;


interface GeoJSONPointGeometry { type: 'Point'; coordinates: GeoJSONCoord; }
interface GeoJSONLineStringGeometry { type: 'LineString'; coordinates: GeoJSONLineString; }
interface GeoJSONMultiLineStringGeometry { type: 'MultiLineString'; coordinates: GeoJSONLineString[]; }
interface GeoJSONPolygonGeometry { type: 'Polygon'; coordinates: GeoJSONPolygon; }
interface GeoJSONMultiPolygonGeometry { type: 'MultiPolygon'; coordinates: GeoJSONPolygon[]; }

export type GeoJSONGeometry =
    | GeoJSONPointGeometry
    | GeoJSONLineStringGeometry
    | GeoJSONMultiLineStringGeometry
    | GeoJSONPolygonGeometry
    | GeoJSONMultiPolygonGeometry;

export type GeoJSONProperties = Record<string, any>;

export interface GeoJSONFeature {
    type: 'Feature';
    geometry: GeoJSONGeometry;
    properties?: GeoJSONProperties | null;
    id?: string | number;
}

export interface ChoroplethConfig {
    /** Формула или поле: 'population / area' или просто 'gdp' */
    value: string | ((props: Props) => number);
    /** Имя палитры ('viridis', 'terrain') или массив стопов */
    colorRamp: string | any[];
    /** Метод классификации (по умолчанию 'jenks') */
    classification?: 'equal' | 'quantile' | 'jenks' | number[];
    /** Количество классов (по умолчанию 5) */
    classes?: number;
    /** Цвет для нулевых/пустых значений (по умолчанию 'transparent') */
    noDataColor?: string;
}

export interface GeoJSONFeatureCollection {
    type: 'FeatureCollection';
    features: GeoJSONFeature[];
}

export type GeoJSONInput =
    | GeoJSONFeatureCollection
    | GeoJSONFeature
    | GeoJSONGeometry;

// =====================================================================
// Style aliases
// =====================================================================

export interface PointStyleAliases { icon?: string; }
export interface Marker3DStyleAliases { model?: string | null; }

export interface LineStyleAliases {
    stroke?: string | number;
    'stroke-color'?: string | number;
    'stroke-width'?: number;
    'stroke-opacity'?: number;
}

export interface PolygonStyleAliases {
    fill?: string | number;
    'fill-color'?: string | number;
    'fill-opacity'?: number;
    stroke?: string | number;
    'stroke-color'?: string | number;
    'stroke-width'?: number;
    'stroke-opacity'?: number;
}

export interface Area3DStyleAliases { model?: string | null; }

export interface VectorStyleAliases {
    stroke?: string | number;
    'stroke-color'?: string | number;
    'stroke-width'?: number;
    'stroke-opacity'?: number;
}

const POINT_ALIASES: Record<string, string> = {
    'icon': 'iconUrl',
};
const MARKER3D_ALIASES: Record<string, string> = {
    'model': 'modelUrl',
};
const LINE_ALIASES: Record<string, string> = {
    'stroke': 'color',
    'stroke-color': 'color',
    'stroke-width': 'width',
    'stroke-opacity': 'opacity',
};
const POLYGON_ALIASES: Record<string, string> = {
    'fill': 'fillColor',
    'fill-color': 'fillColor',
    'fill-opacity': 'fillOpacity',
    'stroke': 'strokeColor',
    'stroke-color': 'strokeColor',
    'stroke-width': 'strokeWidth',
    'stroke-opacity': 'strokeOpacity',
};
const AREA3D_ALIASES: Record<string, string> = {
    'model': 'modelUrl',
};
const VECTOR_ALIASES: Record<string, string> = {
    'stroke': 'color',
    'stroke-color': 'color',
    'stroke-width': 'width',
    'stroke-opacity': 'opacity',
};

const NUMERIC_OPTION_KEYS = new Set<string>([
    'fillOpacity', 'strokeOpacity', 'strokeWidth',
    'width', 'opacity', 'arrowSize',
]);



// =====================================================================
// Declarative style types
// =====================================================================

export interface StyleRule {
    fill?: string | number;
    'fill-color'?: string | number;
    'fill-opacity'?: number;
    fillColor?: string | number;
    fillOpacity?: number;
    stroke?: string | number;
    'stroke-color'?: string | number;
    'stroke-width'?: number;
    'stroke-opacity'?: number;
    strokeColor?: string | number;
    strokeWidth?: number;
    strokeOpacity?: number;
    color?: string | number;
    width?: number;
    opacity?: number;
    icon?: string;
    iconUrl?: string;
    iconSize?: IconSize;
    model?: string | null;
    modelUrl?: string | null;
    size?: SizeSpec | null;
    primitiveType?: PrimitiveType;
    title?: string;
    tooltip?: string;
    minZoom?: number;
    maxZoom?: number;
    altitude?: number;
    altitudeMode?: 'clampToGround' | 'absolute';
    anchor?: [number, number] | [number, number, number];
    [key: string]: any;
}

export interface StyleTypeConfig {
    cases?: Record<string, StyleRule>;
    default?: StyleRule;
}

export type StyleTypeKey =
    | 'polygon' | 'line' | 'point' | 'area3D' | 'marker3D' | 'vector';

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
// Feature filter types
// =====================================================================

/**
 * Объектная спецификация. Поддерживает:
 *   - равенство:       `{ type: 'city' }`
 *   - OR по значениям: `{ category: ['park', 'reserve'] }`
 *   - вложенные пути:  `{ 'address.city': 'Москва' }`
 *   - всё вместе = AND.
 */
export type FeatureFilterSpec = Record<
    string,
    string | number | boolean | null
    | readonly (string | number | boolean | null)[]
>;

/**
 * Что принимает `featureFilter` / `setFeatureFilter`:
 *   - строка-выражение (`"type = 'city'"`, `"pop > 100"`);
 *   - объект-спецификация (безопасно для UI);
 *   - предикат (escape hatch);
 *   - `null` — снять.
 */
export type FeatureFilterInput =
    | string
    | FeatureFilterSpec
    | readonly unknown[]
    | ((feature: GeoJSONFeature) => boolean)
    | null;

// =====================================================================
// Expression compiler
// =====================================================================

/**
 * Заменяет одиночный `=` на `===`, не трогая `==`, `===`, `!=`, `!==`,
 * `<=`, `>=`, `=>` и содержимое строк.
 */
function replaceEqualityOutsideStrings(expr: string): string {
    let out = '';
    let i = 0;
    let str: string | null = null;
    while (i < expr.length) {
        const ch = expr[i];
        if (str) {
            out += ch;
            if (ch === '\\' && i + 1 < expr.length) { out += expr[++i]; i++; continue; }
            if (ch === str) str = null;
            i++;
            continue;
        }
        if (ch === "'" || ch === '"' || ch === '`') { str = ch; out += ch; i++; continue; }
        if (ch === '=') {
            const prev = out[out.length - 1];
            const next = expr[i + 1];
            if (prev === '<' || prev === '>' || prev === '!' || prev === '='
                || next === '=' || next === '>') {
                out += ch; i++; continue;
            }
            out += '==='; i++; continue;
        }
        out += ch; i++;
    }
    return out;
}

function interpolate(template: string, props: Record<string, any>): string {
    return template.replace(/\{([\w.]+)\}/g, (_m, key) => {
        const v = key.includes('.')
            ? key.split('.').reduce((o: any, k: string) => (o == null ? undefined : o[k]), props)
            : props[key];
        return v == null ? '' : String(v);
    });
}

/**
 * `field === 'a' || 'b'` → `field === 'a' || field === 'b'`.
 * Трогает только цепочки, целиком состоящие из литералов.
 */
function expandOrChains(expr: string): string {
    const LIT = String.raw`(?:'[^'\\]*(?:\\.[^'\\]*)*'|"[^"\\]*(?:\\.[^"\\]*)*"|\d+(?:\.\d+)?|true|false|null)`;
    const FIELD = String.raw`[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*`;
    const chainRe = new RegExp(
        `(${FIELD})\\s*===\\s*(${LIT}(?:\\s*\\|\\|\\s*${LIT})+)`, 'g',
    );
    const litRe = new RegExp(LIT, 'g');
    return expr.replace(chainRe, (_m, field: string, chain: string) => {
        const lits = chain.match(litRe);
        if (!lits || lits.length < 2) return _m;
        return lits.map(lit => `${field} === ${lit}`).join(' || ');
    });
}

// =====================================================================
// Mapbox filter → JS expression
// =====================================================================

/** Top-level: `['==', key, value]` → `(key === value)`. */
function mapboxToJsExpr(node: unknown): string {
    if (!Array.isArray(node) || node.length === 0) {
        throw new Error('Invalid Mapbox filter (expected non-empty array)');
    }
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
            // New-style: ['in', ['get', 'x'], ['literal', ['a','b']]]
            // Legacy:    ['in', 'x', 'a', 'b']
            const rawValues = (rest.length === 2
                && Array.isArray(rest[1]) && (rest[1] as any[])[0] === 'literal')
                ? (rest[1] as any[])[1]
                : rest.slice(1);
            const ors = (rawValues as unknown[])
                .map(v => `${key} === ${mapboxLiteral(v)}`).join(' || ');
            return op === 'in' ? `(${ors})` : `!(${ors})`;
        }
        case 'has': {
            if (rest.length !== 1) throw new Error('Mapbox "has" needs 1 arg');
            return `(${mapboxField(rest[0])} !== undefined)`;
        }
        case '!has': {
            if (rest.length !== 1) throw new Error('Mapbox "!has" needs 1 arg');
            return `(${mapboxField(rest[0])} === undefined)`;
        }
        case 'all': return rest.length ? `(${rest.map(mapboxToJsExpr).join(' && ')})` : 'true';
        case 'any': return rest.length ? `(${rest.map(mapboxToJsExpr).join(' || ')})` : 'false';
        case 'none': return rest.length ? `!(${rest.map(mapboxToJsExpr).join(' || ')})` : 'true';
        case '!': {
            if (rest.length !== 1) throw new Error('Mapbox "!" needs 1 arg');
            return `!(${mapboxToJsExpr(rest[0])})`;
        }
        default:
            throw new Error(`Unsupported Mapbox operator: "${op}"`);
    }
}

/** Операнд в позиции КЛЮЧА (левая часть сравнения). */
function mapboxField(node: unknown): string {
    if (typeof node === 'string') {
        if (node === '$type') return 'geometry';
        if (node === '$id')   return 'feature.id';
        // Любой другой ключ — bracket access, безопасно для `foo-bar`, `a.b` и т.п.
        return `props[${JSON.stringify(node)}]`;
    }
    if (Array.isArray(node)) {
        const head = node[0];
        if (head === 'get') {
            if (node.length < 2) throw new Error('Mapbox "get" needs a key');
            return mapboxField(node[1]);
        }
        if (head === 'geometry-type') return 'geometry';
        if (head === 'id')            return 'feature.id';
    }
    throw new Error(`Unsupported Mapbox field operand: ${JSON.stringify(node)}`);
}

/** Операнд в позиции ЗНАЧЕНИЯ (правая часть сравнения). */
function mapboxLiteral(node: unknown): string {
    if (typeof node === 'string')  return JSON.stringify(node);
    if (typeof node === 'number')  return Number.isFinite(node) ? String(node) : 'null';
    if (typeof node === 'boolean') return String(node);
    if (node === null)             return 'null';
    if (Array.isArray(node)) {
        // ['literal', x] → JSON x; ['get', x] → поле; иначе литеральный массив.
        if (node[0] === 'literal') return JSON.stringify(node[1]);
        if (node[0] === 'get')     return mapboxField(node[1]);
        return JSON.stringify(node);
    }
    throw new Error(`Unsupported Mapbox literal operand: ${JSON.stringify(node)}`);
}

/**
 * Компилирует строку-выражение в предикат.
 * Идентификаторы резолвятся через `props`; глобалы (`Math`, `Number`) —
 * снаружи.
 */
function compileExpressionFilter(expr: string): (feature: GeoJSONFeature) => boolean {
    const processed = expandOrChains(replaceEqualityOutsideStrings(expr));

    // Резолвер: reserved names → feature-level, иначе → props.
    //   feature      — весь GeoJSONFeature
    //   props        — properties как объект (для явного доступа)
    //   geometry     — feature.geometry.type  (строка!)
    //   geometryType — alias для `geometry`
    //
    // Если имя НЕ зарезервировано и есть в props — берётся из props.
    // Если нет ни там, ни там — уходит в глобальный scope (`Math`, `Number`, …).
    const src = `
        const props = feature.properties ?? {};
        const geometryType = feature.geometry?.type ?? null;
        const __scope = new Proxy(
            Object.assign(Object.create(null), {
                feature,
                props,
                geometry: geometryType,
                geometryType,
            }),
            {
                has: (t, k) => typeof k === 'string' && (
                    Object.prototype.hasOwnProperty.call(t, k) ||
                    Object.prototype.hasOwnProperty.call(props, k)
                ),
                get: (t, k) => {
                    if (typeof k !== 'string') return undefined;
                    if (Object.prototype.hasOwnProperty.call(t, k)) return t[k];
                    return props[k];
                },
            }
        );
        with (__scope) { return Boolean(${processed}); }
    `;

    let fn: (feature: any) => boolean;
    try {
        fn = new Function('feature', src) as (feature: any) => boolean;
    } catch (err) {
        console.warn('GeoJSONLayer: invalid filter expression', expr, err);
        return () => false;
    }

    return (feature) => {
        try {
            return fn(feature);
        } catch (err) {
            console.warn('GeoJSONLayer: filter expression threw, treating as false', err);
            return false;
        }
    };
}

function getPath(obj: any, path: string): any {
    if (!path.includes('.')) return obj?.[path];
    let cur = obj;
    for (const part of path.split('.')) {
        if (cur == null) return undefined;
        cur = cur[part];
    }
    return cur;
}

function matchFilterValue(
    actual: any,
    expected: FeatureFilterSpec[string],
): boolean {
    if (Array.isArray(expected)) return expected.some(v => v === actual);
    if (expected === null) return actual == null;
    return actual === expected;
}

/**
 * Разрешает путь в объектной форме. Симметрично строковой:
 *   - `geometry` / `geometryType` → feature.geometry.type
 *   - `feature`, `feature.type`, `feature.id`, `feature.geometry.*` → из feature
 *   - `props`, `props.category` → из properties
 *   - иначе → путь в properties (с точками).
 */
function resolveFilterPath(feature: GeoJSONFeature, path: string): any {
    const props = feature.properties ?? {};
    const geometryType = feature.geometry?.type ?? null;

    if (path === 'geometry' || path === 'geometryType') return geometryType;
    if (path === 'feature') return feature;
    if (path === 'props')   return props;

    if (path.startsWith('feature.')) {
        return getPath(feature, path.slice('feature.'.length));
    }
    if (path.startsWith('props.')) {
        return getPath(props, path.slice('props.'.length));
    }
    return getPath(props, path);
}

function compileObjectFilter(spec: FeatureFilterSpec): (feature: GeoJSONFeature) => boolean {
    const entries = Object.entries(spec);
    return (feature) => {
        for (const [path, expected] of entries) {
            const actual = resolveFilterPath(feature, path);
            if (!matchFilterValue(actual, expected)) return false;
        }
        return true;
    };
}
// =====================================================================
// Callback types
// =====================================================================

type Props = GeoJSONProperties;

export type PointOptionsCallback =
    (feature: GeoJSONFeature, props: Props) =>
        (Partial<MarkerOptions> & PointStyleAliases) | null | undefined;

export type Point3DOptionsCallback =
    (feature: GeoJSONFeature, props: Props) =>
        (Partial<Marker3DOptions> & Marker3DStyleAliases) | null | undefined;

export type LineOptionsCallback =
    (feature: GeoJSONFeature, props: Props) =>
        (Partial<PolylineOptions> & LineStyleAliases) | null | undefined;

export type PolygonOptionsCallback =
    (feature: GeoJSONFeature, props: Props) =>
        (Partial<PolygonOptions> & PolygonStyleAliases) | null | undefined;

export type Polygon3DOptionsCallback =
    (feature: GeoJSONFeature, props: Props) =>
        (Partial<Area3DOptions> & Area3DStyleAliases) | null | undefined;

export type VectorOptionsCallback =
    (feature: GeoJSONFeature, props: Props) =>
        (Partial<Vector3DOptions> & VectorStyleAliases) | null | undefined;

export type OnEachFeatureCallback =
    (feature: GeoJSONFeature, object: SpatialObject) => void;

// =====================================================================
// Layer options
// =====================================================================


export interface DiagramLayerConfig {
    type?: string;
    fields: string[];
    unitPx?: number;
    orientation?: DiagramOrientation;
    colorMap?: Record<string, string>;
    barWidth?: number;
    gap?: number;
    padding?: number;
    strokeColor?: string;
    strokeWidth?: number;

    segmentSizes?: number[];

    // Подпись
    labelField?: string; 
    labelPosition?: LabelPosition;
    labelFont?: string;
    labelColor?: string;

    // Венский способ
    unitValue?: number;
    maxCols?: number;
    shape?: 'square' | 'circle';
    showTotal?: boolean;
    totalFont?: string;
    totalBg?: string;
    totalColor?: string;
    totalBorder?: string;
    
    projection?: 'oblique' | 'isometric'; // <--- Добавьте, если нет

    fitToPolygon?: boolean;
    minScreenScale?: number;
    minZoom?: number;
    maxZoom?: number;
    coins?: number[];
}

export interface GeoJSONLayerOptions {
    url?: string;
    data?: GeoJSONInput;
    crs?: string;
    choropleth?: ChoroplethConfig;
/**
 * Тултип feature-а.
 * - `string`   — HTML-шаблон; `{field}` подставляется из `properties`.
 *                Без `{}` — одинаковый литеральный HTML для всех features.
 * - `function` — escape hatch, `(props) => html | null`.
 * - `null`/`undefined` — fallback на `tooltipField` → `props.tooltip`/`props.description`.
 */
tooltip?: string | ((props: Props) => string | null) | null;
    /** Фильтр на уровне feature (не путать с `Layer.filter` по объектам). */
    featureFilter?: FeatureFilterInput;
    /** @deprecated Используйте `featureFilter`. */
    filter?: FeatureFilterInput;
    onEachFeature?: OnEachFeatureCallback;

    /** Декларативная таблица стилей. См. {@link StyleConfig}. */
    style?: StyleConfig;

    /** Откуда брать `title`: `props[titleField]` приоритетнее `props.title`/`props.name`. */
    titleField?: string | null;
    /** Откуда брать `tooltip`: `props[tooltipField]` приоритетнее `props.tooltip`/`props.description`. */
    tooltipField?: string | null;
    tooltipOnHover?: boolean;

    pointToOptions?: PointOptionsCallback;
    point3DToOptions?: Point3DOptionsCallback;
    lineToOptions?: LineOptionsCallback;
    polygonToOptions?: PolygonOptionsCallback;
    polygon3DToOptions?: Polygon3DOptionsCallback;
    vectorToOptions?: VectorOptionsCallback;

    // ── Marker ──
    defaultIconUrl?: string;
    defaultIconSize?: IconSize;
    defaultAnchor?: [number, number];

    // ── Marker3D ──
    default3DPrimitiveType?: PrimitiveType;
    default3DSize?: SizeSpec | null;
    default3DAnchor?: Vec3;
    default3DAltitude?: number;
    default3DAltitudeMode?: 'clampToGround' | 'absolute';

    // ── Polyline ──
    defaultLineColor?: string | number;
    defaultLineWidth?: number;
    defaultLineOpacity?: number;
    /** @default 'absolute' */
    defaultLineAltitudeMode?: 'clampToGround' | 'absolute';
    /** @default 10 */
    defaultLineAltitude?: number;
    /** @deprecated Используйте `defaultLineAltitude`. */
    defaultLineAltitudeOffset?: number;
    defaultLineDepthTest?: boolean;
    defaultLineDepthWrite?: boolean;
    defaultLineMinZoom?: number;
    defaultLineMaxZoom?: number;

    // ── Polygon ──
    defaultFillColor?: string | number;
    defaultFillOpacity?: number;
    defaultStrokeColor?: string | number;
    defaultStrokeWidth?: number;
    defaultStrokeOpacity?: number;
    /** @default 'absolute' */
    defaultPolygonAltitudeMode?: 'clampToGround' | 'absolute';
    /** @default 10 */
    defaultPolygonAltitude?: number;
    /** @deprecated Используйте `defaultPolygonAltitude`. */
    defaultPolygonAltitudeOffset?: number;
    defaultPolygonDepthTest?: boolean;
    defaultPolygonDepthWrite?: boolean;
    defaultPolygonMinZoom?: number;
    defaultPolygonMaxZoom?: number;
    defaultPolygonExtruded?: boolean;
    defaultPolygonHeight?: number;
    defaultPolygonMinHeight?: number;

    // ── Area3D ──
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

diagram?: DiagramLayerConfig;
   diagramToOptions?: (feature: GeoJSONFeature, props: Props) => DiagramSpawnOptions | null;
    onEachDiagram?: (feature: GeoJSONFeature, diagram: Diagram) => void;

}

// =====================================================================
// GeoJSONLayer
// =====================================================================

/**
 * Слой GeoJSON: создаёт маркеры, линии, полигоны и векторные объекты из
 * FeatureCollection / Feature / Geometry.
 *
 * Порядок merge для каждого объекта:
 *   `defaults → style → callback → enforced (rings/positions/position)`.
 *
 * @example Декларативный style
 * new GeoJSONLayer({
 *     data,
 *     titleField: 'name',
 *     style: {
 *         by: 'category',
 *         cases: { park: { fill: '#7ed321', stroke: '#3d8b00' } },
 *         default: { fill: '#cccccc' },
 *         line:  { default: { 'stroke-width': 4 } },
 *         point: { default: { icon: 'pin.png', iconSize: [32, 32] } },
 *     },
 * }).addTo(map);
 *
 * @example Коллбэки (escape hatch, мержатся поверх style)
 * new GeoJSONLayer({
 *     data,
 *     polygonToOptions: (f, p) => ({ title: p.name, fill: '#ff0000' }),
 * });
 */
export class GeoJSONLayer extends Layer {
    public url: string | null = null;
    public data: GeoJSONInput | null = null;
    public crs: string | null = null;
    public tooltipOnHover: boolean = false;

    public choropleth: ChoroplethConfig | null = null;
    private _choroplethBreaks: number[] = [];
    private _choroplethRamp: any = null;


    /**
     * Скомпилированный предикат. `null` — фильтра нет.
     * Для установки используйте `setFeatureFilter` — он корректно
     * обновляет `filterSpec` / `filterExpression` и делает `reload()`.
     */
    public featureFilter: ((feature: GeoJSONFeature) => boolean) | null = null;
    /** Исходная объектная спецификация (для UI). */
    public filterSpec: FeatureFilterSpec | null = null;
    /** Исходное строковое выражение (для UI). */
    public filterExpression: string | null = null;

    public onEachFeature: OnEachFeatureCallback | null = null;

    public style: StyleConfig | null = null;
    public titleField: string | null = null;


    public pointToOptions: PointOptionsCallback | null = null;
    public point3DToOptions: Point3DOptionsCallback | null = null;
    public lineToOptions: LineOptionsCallback | null = null;
    public polygonToOptions: PolygonOptionsCallback | null = null;
    public polygon3DToOptions: Polygon3DOptionsCallback | null = null;
    public vectorToOptions: VectorOptionsCallback | null = null;

public tooltip: string | ((props: Props) => string | null) | null = null;
/** @deprecated Используйте `tooltip: '{fieldName}'`. */
public tooltipField: string | null = null;

    public diagram: DiagramLayerConfig | null = null;
public diagramToOptions: ((f: GeoJSONFeature, p: Props) => DiagramSpawnOptions | null) | null = null;
public onEachDiagram: ((f, d) => void) | null = null;

    public defaultIconUrl: string = 'marker.png';
    public defaultIconSize: IconSize = [16, 16];
    public defaultAnchor: [number, number] = [0.5, 1.0];

    public default3DPrimitiveType: PrimitiveType = 'box';
    public default3DSize: SizeSpec | null = [100, 100, 100];
    public default3DAnchor: Vec3 = [0.5, 0, 0.5];
    public default3DAltitude: number = 0;
    public default3DAltitudeMode: 'clampToGround' | 'absolute' = 'clampToGround';

    public defaultLineColor: string | number = '#3388ff';
    public defaultLineWidth: number = 2;
    public defaultLineOpacity: number = 1;
    public defaultLineAltitudeMode: 'clampToGround' | 'absolute' = 'absolute';
    public defaultLineAltitude: number = 10;
    public defaultLineDepthTest: boolean = false;
    public defaultLineDepthWrite: boolean = false;
    public defaultLineMinZoom: number = -Infinity;
    public defaultLineMaxZoom: number = Infinity;

    public defaultFillColor: string | number = '#3388ff';
    public defaultFillOpacity: number = 0.5;
    public defaultStrokeColor: string | number = '#000000';
    public defaultStrokeWidth: number = 2;
    public defaultStrokeOpacity: number = 1;
    public defaultPolygonAltitudeMode: 'clampToGround' | 'absolute' = 'absolute';
    public defaultPolygonAltitude: number = 10;
    public defaultPolygonDepthTest: boolean = false;
    public defaultPolygonDepthWrite: boolean = false;
    public defaultPolygonMinZoom: number = -Infinity;
    public defaultPolygonMaxZoom: number = Infinity;
    public defaultPolygonExtruded: boolean = false;
    public defaultPolygonHeight: number = 0;
    public defaultPolygonMinHeight: number = 0;

    public defaultPolygon3DPrimitiveType: PrimitiveType = 'box';
    public defaultPolygon3DSize: SizeSpec | null = null;
    public defaultPolygon3DAnchor: [number, number, number] = [0.5, 0, 0.5];
    public defaultPolygon3DAltitude: number = 0;
    public defaultPolygon3DAltitudeMode: 'clampToGround' | 'absolute' = 'clampToGround';
    public defaultPolygon3DFit: Area3DFit = 'stretch';
    public defaultPolygon3DRotate: number = 0;
    public defaultPolygon3DModelUrl: string | null = null;
    public defaultPolygon3DDepthTest: boolean = true;
    public defaultPolygon3DDepthWrite: boolean = true;

    private _loaded = false;

static fromMapboxFilter(arr: readonly unknown[]): string {
    return mapboxToJsExpr(arr);
}

    constructor(options: GeoJSONLayerOptions = {}) {
        super();

this.diagram = options.diagram ?? null;
this.diagramToOptions = options.diagramToOptions ?? null;
this.onEachDiagram = options.onEachDiagram ?? null;
this.tooltipOnHover = options.tooltipOnHover ?? false;

 this.choropleth = options.choropleth ?? null;
        if (this.choropleth) {
            this._choroplethRamp = resolveColorRamp(this.choropleth.colorRamp);
        }

        this.url = options.url ?? null;
        this.data = options.data ?? null;
        this.crs = options.crs ?? null;
        this.onEachFeature = options.onEachFeature ?? null;

        this._applyFilter(options.featureFilter ?? options.filter ?? null);

        this.style = options.style ?? null;
        this.titleField = options.titleField ?? null;


        this.pointToOptions = options.pointToOptions ?? null;
        this.point3DToOptions = options.point3DToOptions ?? null;
        this.lineToOptions = options.lineToOptions ?? null;
        this.polygonToOptions = options.polygonToOptions ?? null;
        this.polygon3DToOptions = options.polygon3DToOptions ?? null;
        this.vectorToOptions = options.vectorToOptions ?? null;

this.tooltip = options.tooltip ?? null;
this.tooltipField = options.tooltipField ?? null; 
        this.defaultIconUrl = options.defaultIconUrl ?? 'marker.png';
        this.defaultIconSize = options.defaultIconSize ?? [16, 16];
        this.defaultAnchor = options.defaultAnchor ?? [0.5, 1.0];

        this.default3DPrimitiveType = options.default3DPrimitiveType ?? 'box';
        this.default3DSize = options.default3DSize ?? [100, 100, 100];
        this.default3DAnchor = options.default3DAnchor ?? [0.5, 0, 0.5];
        this.default3DAltitude = options.default3DAltitude ?? 0;
        this.default3DAltitudeMode = options.default3DAltitudeMode ?? 'clampToGround';

        this.defaultLineColor = options.defaultLineColor ?? '#3388ff';
        this.defaultLineWidth = options.defaultLineWidth ?? 2;
        this.defaultLineOpacity = options.defaultLineOpacity ?? 1;
        this.defaultLineAltitudeMode = options.defaultLineAltitudeMode ?? 'absolute';
        this.defaultLineAltitude = options.defaultLineAltitude
            ?? options.defaultLineAltitudeOffset ?? 10;
        this.defaultLineDepthTest = options.defaultLineDepthTest ?? false;
        this.defaultLineDepthWrite = options.defaultLineDepthWrite ?? false;
        this.defaultLineMinZoom = options.defaultLineMinZoom ?? -Infinity;
        this.defaultLineMaxZoom = options.defaultLineMaxZoom ?? Infinity;

        this.defaultFillColor = options.defaultFillColor ?? '#3388ff';
        this.defaultFillOpacity = options.defaultFillOpacity ?? 0.5;
        this.defaultStrokeColor = options.defaultStrokeColor ?? '#000000';
        this.defaultStrokeWidth = options.defaultStrokeWidth ?? 2;
        this.defaultStrokeOpacity = options.defaultStrokeOpacity ?? 1;
        this.defaultPolygonAltitudeMode = options.defaultPolygonAltitudeMode ?? 'absolute';
        this.defaultPolygonAltitude = options.defaultPolygonAltitude
            ?? options.defaultPolygonAltitudeOffset ?? 10;
        this.defaultPolygonDepthTest = options.defaultPolygonDepthTest ?? false;
        this.defaultPolygonDepthWrite = options.defaultPolygonDepthWrite ?? false;
        this.defaultPolygonMinZoom = options.defaultPolygonMinZoom ?? -Infinity;
        this.defaultPolygonMaxZoom = options.defaultPolygonMaxZoom ?? Infinity;
        this.defaultPolygonExtruded = options.defaultPolygonExtruded ?? false;
        this.defaultPolygonHeight = options.defaultPolygonHeight ?? 0;
        this.defaultPolygonMinHeight = options.defaultPolygonMinHeight ?? 0;

        this.defaultPolygon3DPrimitiveType = options.defaultPolygon3DPrimitiveType ?? 'box';
        this.defaultPolygon3DSize = options.defaultPolygon3DSize ?? null;
        this.defaultPolygon3DAnchor = options.defaultPolygon3DAnchor ?? [0.5, 0, 0.5];
        this.defaultPolygon3DAltitude = options.defaultPolygon3DAltitude ?? 0;
        this.defaultPolygon3DAltitudeMode = options.defaultPolygon3DAltitudeMode ?? 'clampToGround';
        this.defaultPolygon3DFit = options.defaultPolygon3DFit ?? 'stretch';
        this.defaultPolygon3DRotate = options.defaultPolygon3DRotate ?? 0;
        this.defaultPolygon3DModelUrl = options.defaultPolygon3DModelUrl ?? null;
        this.defaultPolygon3DDepthTest = options.defaultPolygon3DDepthTest ?? true;
        this.defaultPolygon3DDepthWrite = options.defaultPolygon3DDepthWrite ?? true;
    }

    // =================================================================
    // Lifecycle
    // =================================================================

    override addTo(map: any): this {
        super.addTo(map);
        if (!this._loaded) this._load();
        return this;
    }

    /** Полная перезагрузка: удаляет объекты, сбрасывает флаг, загружает заново. */
    reload(): void {
        const layer = this as any;
        const objects: SpatialObject[] = layer._objects ?? [];
        for (const obj of [...objects]) obj.remove();
        layer._objects = [];
        this._loaded = false;
        if (layer._map) this._load();
    }

    /**
     * Меняет feature-фильтр. При активной карте автоматически `reload()`.
     *
     * @example
     * layer.setFeatureFilter("type = 'city'");
     * layer.setFeatureFilter("type = 'city' || 'village'");
     * layer.setFeatureFilter("population > 100000");
     * layer.setFeatureFilter({ type: 'city' });
     * layer.setFeatureFilter(f => f.properties?.max > f.properties?.min);
     * layer.setFeatureFilter(null);   // снять
     */
    setFeatureFilter(input: FeatureFilterInput): this {
        this._applyFilter(input);
        if (this._map && this._loaded) this.reload();
        return this;
    }

    /** Меняет декларативный style. При активной карте — `reload()`. */
    setStyle(style: StyleConfig | null): this {
        this.style = style;
        if (this._map && this._loaded) this.reload();
        return this;
    }

    /** Заменяет данные. `null` — очистить. При активной карте — `reload()`. */
    setData(data: GeoJSONInput | null): this {
        this.data = data;
        if (this._map) this.reload(); else this._loaded = false;
        return this;
    }

    /**
 * Alias для {@link setFeatureFilter} — удобен при переходе с Mapbox GL JS.
 *
 * НЕ путать с унаследованным {@link Layer#filter}(predicate): тот работает
 * по уже созданным объектам и лишь скрывает их. `setFilter` /
 * `setFeatureFilter` пересобирает слой — отфильтрованные feature
 * вообще не попадают в `_objects` и не влияют на `getBounds()`.
 */
setFilter(input: FeatureFilterInput): this {
    return this.setFeatureFilter(input);
}

setDiagram(cfg: DiagramLayerConfig | null): this {
    this.diagram = cfg;
    if (this._map && this._loaded) this.reload();
    return this;
}

/**
 * Возвращает текущий фильтр в исходной форме:
 * строковое выражение, объект-спецификация, предикат или `null`.
 */
getFilter(): FeatureFilterInput {
    if (this.filterExpression != null) return this.filterExpression;
    if (this.filterSpec != null) return this.filterSpec;
    return this.featureFilter;
}

    /** Заменяет url. При активной карте — `reload()`. */
    setUrl(url: string | null): this {
        this.url = url;
        if (this._map) this.reload(); else this._loaded = false;
        return this;
    }

    /** Добавляет объекты к уже загруженным, не удаляя существующие. */
    addData(data: GeoJSONInput): this {
        this._parse(data);
        return this;
    }

private _applyFilter(input: unknown): void {
    // ── Mapbox-style array → JS expression string ──────────────────
    if (Array.isArray(input)) {
        try {
            const converted = GeoJSONLayer.fromMapboxFilter(input);
            console.debug('GeoJSONLayer: Mapbox filter converted', input, '→', converted);
            input = converted;   // теперь строка, дальше обычный путь
        } catch (err) {
            console.warn(
                'GeoJSONLayer: cannot convert Mapbox filter. ' +
                "Use a JS expression string (e.g. \"type = 'city'\") " +
                'or an object spec (e.g. { type: \'city\' }).',
                err, input,
            );
            this.featureFilter = null;
            this.filterSpec = null;
            this.filterExpression = null;
            return;
        }
    }

    if (!input) {
        this.featureFilter = null;
        this.filterSpec = null;
        this.filterExpression = null;
        return;
    }
    if (typeof input === 'function') {
        this.featureFilter = input as (feature: GeoJSONFeature) => boolean;
        this.filterSpec = null;
        this.filterExpression = null;
        return;
    }
    if (typeof input === 'string') {
        const trimmed = input.trim();
        if (!trimmed) {
            this.featureFilter = null;
            this.filterSpec = null;
            this.filterExpression = null;
            return;
        }
        this.featureFilter = compileExpressionFilter(trimmed);
        this.filterSpec = null;
        this.filterExpression = trimmed;
        return;
    }

    // После всех проверок input — объект-спецификация.
    const spec = input as FeatureFilterSpec;
    if (!Object.keys(spec).length) {
        this.featureFilter = null;
        this.filterSpec = null;
        this.filterExpression = null;
        return;
    }
    this.featureFilter = compileObjectFilter(spec);
    this.filterSpec = spec;
    this.filterExpression = null;
}

    private async _load(): Promise<void> {
        let geojson: GeoJSONInput | null = null;
        try {
            if (this.data) {
                geojson = this.data;
            } else if (this.url) {
                const resp = await fetch(this.url);
                if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
                geojson = await resp.json() as GeoJSONInput;
            }
            if (!geojson) {
                console.warn('GeoJSONLayer: no data or URL provided');
                return;
            }
             if (this.choropleth) {
            this._calculateChoroplethBreaks(geojson);
        }
            this._parse(geojson);
            this._loaded = true;
        } catch (err) {
            console.error('GeoJSONLayer: load/parse error', err);
        }
    }

    private _calculateChoroplethBreaks(geojson: GeoJSONInput): void {
        if (!this.choropleth) return;
        
        let values: number[] = [];
        const processFeature = (f: GeoJSONFeature) => {
            if (f.properties) {
                const val = this._evaluateValueExpression(f.properties, this.choropleth!.value);
                if (isFinite(val)) values.push(val);
            }
        };

        if (geojson.type === 'FeatureCollection') {
            geojson.features.forEach(processFeature);
        } else if (geojson.type === 'Feature') {
            processFeature(geojson);
        }

        this._choroplethBreaks = calculateBreaks(
            values, 
            this.choropleth.classification || 'jenks', 
            this.choropleth.classes || 5
        );
    }

    // =================================================================
    // Style resolution
    // =================================================================

    private _getTitle(props: Props): string {
        if (this.titleField) {
            const v = props[this.titleField];
            if (v != null && v !== '') return String(v);
        }
        return props.title || props.name || '';
    }

        private _evaluateValueExpression(props: Props, exprOrFn: string | ((p: Props) => number)): number {
        if (typeof exprOrFn === 'function') {
            return exprOrFn(props);
        }
        try {
            // Безопасный скоуп: переменные ищутся в props, а не в window
            const fn = new Function('props', `
                const __scope = new Proxy(
                    Object.assign(Object.create(null), { props }),
                    {
                        has: (t, k) => typeof k === 'string' && (
                            Object.prototype.hasOwnProperty.call(t, k) ||
                            Object.prototype.hasOwnProperty.call(props, k)
                        ),
                        get: (t, k) => {
                            if (typeof k !== 'string') return undefined;
                            if (Object.prototype.hasOwnProperty.call(t, k)) return t[k];
                            return props[k];
                        },
                    }
                );
                with (__scope) { return Number(${exprOrFn}); }
            `);
            return fn(props);
        } catch {
            return NaN;
        }
    }

private _getTooltip(props: Props): string {
    // 1. Явный tooltip: функция или шаблон.
    const t = this.tooltip;
    if (typeof t === 'function') {
        try {
            const out = t(props);
            if (out != null) return String(out);
        } catch (e) {
            console.warn('GeoJSONLayer: tooltip callback threw', e);
        }
    } else if (typeof t === 'string' && t) {
        // '{name}' — интерполяция; иначе literal HTML для всех features.
        return t.includes('{') ? interpolate(t, props) : t;
    }

    // 2. Deprecated fallback: одно поле из properties.
    if (this.tooltipField) {
        const raw = props[this.tooltipField];
        if (raw != null && raw !== '' && String(raw).includes('{')) {
            return interpolate(String(raw), props);
        }
        if (raw != null && raw !== '') return String(raw);
    }

    // 3. Дефолты: props.tooltip / props.description.
    return props.tooltip || props.description || '';
}

    /** shared (`style.cases`/`style.default`) ← per-type (`style[type].*`). */
    private _resolveStyle(props: Props, type: StyleTypeKey): StyleRule | null {
        const style = this.style;
        if (!style) return null;
        const by = style.by ?? 'category';
        const value = props[by];
        const shared = this._pickStyleLevel(style, value);
        const perType = this._pickStyleLevel(style[type], value);
        if (!shared && !perType) return null;
        if (!shared) return perType;
        if (!perType) return shared;
        return { ...shared, ...perType };
    }

    private _pickStyleLevel(
        cfg: StyleTypeConfig | undefined,
        value: any,
    ): StyleRule | null {
        if (!cfg) return null;
        if (value != null && cfg.cases) {
            const c = cfg.cases[value];
            if (c) return c;
        }
        return cfg.default ?? null;
    }

    /**
     * Нормализует alias'ы (`fill` → `fillColor`, `stroke-width` → `width`/…)
     * и приводит числовые канонические ключи к `number`. Canonical побеждает
     * alias; alias удаляется из результата.
     */
    private _normalizeStyle<T extends Record<string, any>>(
        src: Record<string, any> | null | undefined,
        aliases: Record<string, string>,
    ): Partial<T> | null {
        if (!src) return null;
        const out: any = { ...src };
        for (const [alias, canonical] of Object.entries(aliases)) {
            if (out[canonical] === undefined && out[alias] != null) {
                if (NUMERIC_OPTION_KEYS.has(canonical)) {
                    const num = this._asNumber(out[alias]);
                    if (num !== undefined) out[canonical] = num;
                } else {
                    out[canonical] = out[alias];
                }
            }
            delete out[alias];
        }
        return out as Partial<T>;
    }

    // =================================================================
    // Dispatch
    // =================================================================

    private _parse(geojson: GeoJSONInput): void {
        const type = (geojson as { type: string }).type;
        if (type === 'FeatureCollection') {
            for (const feature of (geojson as GeoJSONFeatureCollection).features) {
                this._addFeature(feature);
            }
        } else if (type === 'Feature') {
            this._addFeature(geojson as GeoJSONFeature);
        } else if (
            type === 'Point' || type === 'LineString' || type === 'MultiLineString'
            || type === 'Polygon' || type === 'MultiPolygon'
        ) {
            this._addFeature({
                type: 'Feature',
                geometry: geojson as GeoJSONGeometry,
                properties: {},
            });
        } else {
            console.debug(`GeoJSONLayer: type "${type}" not supported`);
        }
    }

    private _addFeature(feature: GeoJSONFeature): void {
        const props = feature.properties ?? {};
        if (this.featureFilter && !this.featureFilter(feature)) return;

        const geom = feature.geometry;
        if (!geom) return;

        switch (geom.type) {
            case 'Point':
                if (this.vectorToOptions && props.vector === true) {
                    this._addVectorFeature(feature);
                } else {
                    this._addPointFeature(feature);
                }
                break;

            case 'LineString':
            case 'MultiLineString':
                if (this.vectorToOptions || props.vector === true) {
                    this._addVectorFeature(feature);
                } else {
                    this._addLineFeature(feature);
                }
                break;

            case 'Polygon':
            case 'MultiPolygon':
                this._addPolygonFeature(feature);
                break;

            default:
                console.debug(`GeoJSONLayer: type "${(geom as any).type}" not supported`);
        }
    }

    // =================================================================
    // Points
    // =================================================================

   private _addPointFeature(feature: GeoJSONFeature): void {
    const geom = feature.geometry;
    if (geom.type !== 'Point') return;
    const props = feature.properties ?? {};

    const coords = geom.coordinates;
    const lonLat: LonLat = [coords[0], coords[1]];
    const altFromCoords = coords.length >= 3 ? coords[2] : undefined;

    // --- НОВОЕ: Если задан diagram, рисуем диаграмму вместо маркера ---
    if (this.diagram || this.diagramToOptions) {
        // Можно добавить проверку на props.diagram === false, 
        // чтобы иметь возможность отключить диаграмму для конкретной точки
        if (props.diagram !== false) {
            this._addPointDiagram(feature, props, lonLat);
            return; // Выходим, чтобы не рисовать обычный маркер
        }
    }
    // ----------------------------------------------------------------

    const cb3D = this.point3DToOptions ? this.point3DToOptions(feature, props) : null;
    const is3D = cb3D != null
        || props['3d'] === true
        || props.type === '3d'
        || props.markerType === '3d';

    if (is3D) {
        this._createMarker3D(feature, props, lonLat, altFromCoords, cb3D);
    } else {
        const cb = this.pointToOptions ? this.pointToOptions(feature, props) : null;
        this._createMarker(feature, props, lonLat, altFromCoords, cb);
    }
}

    private _createMarker(
        feature: GeoJSONFeature,
        props: Props,
        lonLat: LonLat,
        altFromCoords: number | undefined,
        cb: (Partial<MarkerOptions> & PointStyleAliases) | null | undefined,
    ): void {
        const defaults: MarkerOptions = {
            position: lonLat,
            crs: this.crs ?? undefined,
            title: this._getTitle(props),
            tooltip: this._getTooltip(props),
            iconUrl: props.icon || this.defaultIconUrl,
            iconSize: this._parseIconSize(props.iconSize) ?? this.defaultIconSize,
            anchor: this._parsePair(props.anchor) ?? this.defaultAnchor,
            altitude: this._asNumber(props.altitude) ?? altFromCoords ?? 0,
            altitudeMode: props.altitudeMode || 'ground',
            clusterable: props.clusterable ?? true,
            minZoom: this._asNumber(props.minZoom),
            maxZoom: this._asNumber(props.maxZoom),
            titleAlign: props.titleAlign,
            titleStyle: props.titleStyle,
            titleMinZoom: this._asNumber(props.titleMinZoom),
            titleMaxZoom: this._asNumber(props.titleMaxZoom),
            titleOffset: this._parsePair(props.titleOffset) ?? undefined,
            titleAllowOverflow: props.titleAllowOverflow,
            titlePriority: this._asNumber(props.titlePriority),
        };

        const normStyle = this._normalizeStyle<MarkerOptions>(
            this._resolveStyle(props, 'point'), POINT_ALIASES);
        const normCb = this._normalizeStyle<MarkerOptions>(cb, POINT_ALIASES);
        const merged: MarkerOptions = {
            ...defaults,
            ...(normStyle ?? {}),
            ...(normCb ?? {}),
            position: lonLat,
        };
        const marker = new Marker(merged);
        this.add(marker);
        if (this.onEachFeature) this.onEachFeature(feature, marker);
    }

    private _createMarker3D(
        feature: GeoJSONFeature,
        props: Props,
        lonLat: LonLat,
        altFromCoords: number | undefined,
        cb: (Partial<Marker3DOptions> & Marker3DStyleAliases) | null | undefined,
    ): void {
        const defaults: Marker3DOptions = {
            position: lonLat,
            crs: this.crs ?? undefined,
            title: this._getTitle(props),
            tooltip: this._getTooltip(props),
            primitiveType: props.primitiveType || this.default3DPrimitiveType,
            size: this._parseSizeSpec(props.size) ?? this.default3DSize,
            anchor: this._parseTriple(props.anchor) ?? this.default3DAnchor,
            altitude: this._asNumber(props.altitude) ?? altFromCoords ?? this.default3DAltitude,
            altitudeMode: props.altitudeMode || this.default3DAltitudeMode,
            rotation: this._parseTriple(props.rotation) ?? [0, 0, 0],
            modelUrl: props.modelUrl,
            minZoom: this._asNumber(props.minZoom),
            maxZoom: this._asNumber(props.maxZoom),
            titlePlacement: props.titlePlacement || 'top',
            titleAlign: props.titleAlign,
            titleOffset: this._parsePair(props.titleOffset) ?? undefined,
            titleStyle: props.titleStyle,
            titleMinZoom: this._asNumber(props.titleMinZoom),
            titleMaxZoom: this._asNumber(props.titleMaxZoom),
            color: props.color,
            clusterable: props.clusterable,
            depthTest: props.depthTest,
            depthWrite: props.depthWrite,
            playAnimation: props.playAnimation,
        };

        const normStyle = this._normalizeStyle<Marker3DOptions>(
            this._resolveStyle(props, 'marker3D'), MARKER3D_ALIASES);
        const normCb = this._normalizeStyle<Marker3DOptions>(cb, MARKER3D_ALIASES);
        const merged: Marker3DOptions = {
            ...defaults,
            ...(normStyle ?? {}),
            ...(normCb ?? {}),
            position: lonLat,
        };
        const marker = new Marker3D(merged);
        this.add(marker);
        if (this.onEachFeature) this.onEachFeature(feature, marker);
    }

    // =================================================================
    // Lines
    // =================================================================

    private _addLineFeature(feature: GeoJSONFeature): void {
        const geom = feature.geometry;
        if (geom.type !== 'LineString' && geom.type !== 'MultiLineString') return;
        const props = feature.properties ?? {};

        const coordSets: GeoJSONLineString[] =
            geom.type === 'LineString' ? [geom.coordinates] : geom.coordinates;

        for (const coords of coordSets) {
            if (coords.length < 2) continue;

            const cb = this.lineToOptions ? this.lineToOptions(feature, props) : null;

            const defaults: PolylineOptions = {
                positions: coords,
                crs: this.crs ?? undefined,
                color: props.stroke || props.color || this.defaultLineColor,
                opacity: this._asNumber(props['stroke-opacity'] ?? props.opacity)
                    ?? this.defaultLineOpacity,
                width: this._asNumber(props['stroke-width'] ?? props.width)
                    ?? this.defaultLineWidth,
                altitudeMode: props.altitudeMode || this.defaultLineAltitudeMode,
                altitude: this._asNumber(props.altitude)
                    ?? this._asNumber(props.altitudeOffset)
                    ?? this.defaultLineAltitude,
                depthTest: props.depthTest ?? this.defaultLineDepthTest,
                depthWrite: props.depthWrite ?? this.defaultLineDepthWrite,
                minZoom: this._asNumber(props.minZoom) ?? this.defaultLineMinZoom,
                maxZoom: this._asNumber(props.maxZoom) ?? this.defaultLineMaxZoom,
                title: this._getTitle(props),
                tooltip: this._getTooltip(props),
                titleOffset: this._parsePair(props.titleOffset) ?? undefined,
                titleAlign: props.titleAlign,
                titleStyle: props.titleStyle,
                titleMinZoom: this._asNumber(props.titleMinZoom),
                titleMaxZoom: this._asNumber(props.titleMaxZoom),
                titlePlacement: props.titlePlacement,
                titleAllowOverflow: props.titleAllowOverflow,
                titlePriority: this._asNumber(props.titlePriority),
            };

            const normStyle = this._normalizeStyle<PolylineOptions>(
                this._resolveStyle(props, 'line'), LINE_ALIASES);
            const normCb = this._normalizeStyle<PolylineOptions>(cb, LINE_ALIASES);
            const merged: PolylineOptions = {
                ...defaults,
                ...(normStyle ?? {}),
                ...(normCb ?? {}),
                positions: coords,
            };
            const polyline = new Polyline(merged);
            this.add(polyline);
            if (this.onEachFeature) this.onEachFeature(feature, polyline);
        }
    }

    // =================================================================
    // Polygons
    // =================================================================

private _addPolygonFeature(feature: GeoJSONFeature): void {
    const geom = feature.geometry;
    if (geom.type !== 'Polygon' && geom.type !== 'MultiPolygon') return;
    const props = feature.properties ?? {};

    const ringSets: GeoJSONPolygon[] =
        geom.type === 'Polygon' ? [geom.coordinates] : geom.coordinates;

    for (const rings of ringSets) {
        if (!rings.length || !rings[0].length) continue;

        const cb3D = this.polygon3DToOptions ? this.polygon3DToOptions(feature, props) : null;
        const is3D = cb3D != null
            || props['3d'] === true
            || props.type === '3d'
            || props.markerType === '3d';

        if (is3D) {
            this._createArea3D(feature, props, rings as Area3DRing[], cb3D);
            // Картодиаграмму на Area3D пока не навешиваем: другая геометрия,
            // другой смысл fitToPolygon.
        } else {
            const cb = this.polygonToOptions ? this.polygonToOptions(feature, props) : null;
            const polygon = this._createPolygon(feature, props, rings, cb);
            if (polygon && (this.diagram || this.diagramToOptions)) {
                this._addCartodiagram(feature, props, polygon);
            }
        }
    }
}


private _addPointDiagram(feature: GeoJSONFeature, props: Props, lonLat: LonLat): void {
    const baseOpts = this.diagramToOptions
        ? this.diagramToOptions(feature, props)
        : this._diagramFromConfig(feature, props);
    if (!baseOpts) return;

    const diagram = new Diagram({
        ...baseOpts,
        position: lonLat,
        crs: this.crs ?? undefined,
        parentPolygon: null,      // Нет полигона-родителя
        fitToPolygon: false,      // Отключаем fit-логику
        clusterable: false,
    });
    this.add(diagram);
    if (this.onEachDiagram) this.onEachDiagram(feature, diagram);
}

private _addCartodiagram(feature: GeoJSONFeature, props: Props, polygon: Polygon): void {
    const baseOpts = this.diagramToOptions
        ? this.diagramToOptions(feature, props)
        : this._diagramFromConfig(feature, props);
    if (!baseOpts) return;

    const center = polygon.getVisualCenter();
    if (!center) return;

    const diagram = new Diagram({
        ...baseOpts,
        position: center,
        crs: this.crs,
        parentPolygon: polygon,
        fitToPolygon: baseOpts.fitToPolygon ?? this.diagram?.fitToPolygon ?? true,
        minScreenScale: baseOpts.minScreenScale ?? this.diagram?.minScreenScale ?? 0.5,
        clusterable: false,
    });
    this.add(diagram);
    if (this.onEachDiagram) this.onEachDiagram(feature, diagram);
}

private _diagramFromConfig(feature: GeoJSONFeature, props: Props): DiagramSpawnOptions | null {
    const cfg = this.diagram;
    if (!cfg?.fields?.length) return null;

    const data = cfg.fields
        .map(key => {
            const v = Number(props[key]);
            if (!isFinite(v)) return null;
            return {
                label: cfg.labelField ? String(props[cfg.labelField] ?? key) : key,
                value: v,
                color: cfg.colorMap?.[key],
            };
        })
        .filter((d): d is NonNullable<typeof d> => d !== null);
    if (!data.length) return null;

    // ── Tooltip: сначала явный, иначе соберём из данных диаграммы. ──
    let tooltip = this._getTooltip(props);
    if (!tooltip) {
        tooltip = data.map(d =>
            `${d.color ? `<span style="display:inline-block;width:10px;height:10px;` +
                          `background:${d.color};margin-right:6px;border-radius:2px;"></span>` : ''}` +
            `${d.label}: <b>${d.value}</b>`
        ).join('<br>');
    }

const label = cfg.labelField ? String(props[cfg.labelField] ?? '') : '';

return {
    type: cfg.type ?? 'bar',
    data,
    unitPx: cfg.unitPx,
    orientation: cfg.orientation,
    barWidth: cfg.barWidth,
    gap: cfg.gap,
    padding: cfg.padding,
    strokeColor: cfg.strokeColor,
    strokeWidth: cfg.strokeWidth,
    
    label: label || undefined,
    labelPosition: cfg.labelPosition,
    labelFont: cfg.labelFont,
    labelColor: cfg.labelColor,
    
    unitValue: cfg.unitValue,
    maxCols: cfg.maxCols,
    shape: cfg.shape,
    showTotal: cfg.showTotal,
    totalFont: cfg.totalFont,
    totalBg: cfg.totalBg,
    totalColor: cfg.totalColor,
    totalBorder: cfg.totalBorder,
    projection: cfg.projection, // <--- Добавьте
    
    minZoom: cfg.minZoom,
    maxZoom: cfg.maxZoom,
    tooltip,
    coins: cfg.coins,
    segmentSizes: cfg.segmentSizes,
};
}

 private _createPolygon(
        feature: GeoJSONFeature,
        props: Props,
        rings: GeoJSONPolygon,
        cb: (Partial<PolygonOptions> & PolygonStyleAliases) | null | undefined,
    ): Polygon | null {
        
        // Вычисляем цвет, если включена картограмма
        let choroplethColor: string | undefined;
        if (this.choropleth && this._choroplethRamp) {
            const val = this._evaluateValueExpression(props, this.choropleth.value);

            if (isFinite(val)) {
                const classIdx = getClassIndex(val, this._choroplethBreaks);
                const t = this._choroplethBreaks.length > 0 
                    ? classIdx / this._choroplethBreaks.length 
                    : 0;
                
                const rgba = sampleColorRamp(this._choroplethRamp, t);
                // ВАЖНО: Three.js ожидает hex-строку для цвета, а не rgba()
                choroplethColor = `#${((1 << 24) + (rgba[0] << 16) + (rgba[1] << 8) + rgba[2]).toString(16).slice(1)}`;
            } else {
                choroplethColor = this.choropleth.noDataColor ?? '#cccccc';
            }
        }

        const defaults: PolygonOptions = {
            rings,
            crs: this.crs ?? undefined,
            fillColor: choroplethColor || props.fill || props['fill-color'] || this.defaultFillColor,
            fillOpacity: this._asNumber(props['fill-opacity']) ?? this.defaultFillOpacity,
            strokeColor: props.stroke || props['stroke-color'] || this.defaultStrokeColor,
            strokeWidth: this._asNumber(props['stroke-width']) ?? this.defaultStrokeWidth,
            strokeOpacity: this._asNumber(props['stroke-opacity']) ?? this.defaultStrokeOpacity,
            altitudeMode: props.altitudeMode || this.defaultPolygonAltitudeMode,
            altitude: this._asNumber(props.altitude)
                ?? this._asNumber(props.altitudeOffset)
                ?? this.defaultPolygonAltitude,
            depthTest: props.depthTest ?? this.defaultPolygonDepthTest,
            depthWrite: props.depthWrite ?? this.defaultPolygonDepthWrite,
            minZoom: this._asNumber(props.minZoom) ?? this.defaultPolygonMinZoom,
            maxZoom: this._asNumber(props.maxZoom) ?? this.defaultPolygonMaxZoom,
            extruded: props.extruded ?? this.defaultPolygonExtruded,
            height: this._asNumber(props.height) ?? this.defaultPolygonHeight,
            minHeight: this._asNumber(props.minHeight) ?? this.defaultPolygonMinHeight,
            title: this._getTitle(props),
            titleOffset: this._parsePair(props.titleOffset) ?? undefined,
            titleAlign: props.titleAlign,
            titleStyle: props.titleStyle,
            titleMinZoom: this._asNumber(props.titleMinZoom),
            titleMaxZoom: this._asNumber(props.titleMaxZoom),
            titleAllowOverflow: props.titleAllowOverflow,
            titlePriority: this._asNumber(props.titlePriority),
            tooltip: this._getTooltip(props),
            tooltipOnHover: this.tooltipOnHover,
        };

       const normStyle = this._normalizeStyle<PolygonOptions>(
            this._resolveStyle(props, 'polygon'), POLYGON_ALIASES);
        const normCb = this._normalizeStyle<PolygonOptions>(cb, POLYGON_ALIASES);
        
        const merged: PolygonOptions = {
            ...defaults,
            ...(normStyle ?? {}),
            ...(normCb ?? {}),
            rings,
            // Гарантируем, что цвет картограммы не будет перезаписан стилями,
            // если только пользователь явно не передал fillColor в callback
            fillColor: choroplethColor || normCb?.fillColor || normStyle?.fillColor || defaults.fillColor
        };
        
        const polygon = new Polygon(merged);
        this.add(polygon);
        if (this.onEachFeature) this.onEachFeature(feature, polygon);
        return polygon;
    }

    private _createArea3D(
        feature: GeoJSONFeature,
        props: Props,
        rings: Area3DRing[],
        cb: (Partial<Area3DOptions> & Area3DStyleAliases) | null | undefined,
    ): void {
        const defaults: Area3DOptions = {
            rings,
            crs: this.crs ?? undefined,
            modelUrl: props.modelUrl ?? this.defaultPolygon3DModelUrl,
            fit: props.fit || this.defaultPolygon3DFit,
            rotate: this._asNumber(props.rotate) ?? this.defaultPolygon3DRotate,
            primitiveType: props.primitiveType || this.defaultPolygon3DPrimitiveType,
            size: this._parseSizeSpec(props.size) ?? this.defaultPolygon3DSize,
            anchor: this._parseTriple(props.anchor) ?? this.defaultPolygon3DAnchor,
            altitude: this._asNumber(props.altitude) ?? this.defaultPolygon3DAltitude,
            altitudeMode: props.altitudeMode || this.defaultPolygon3DAltitudeMode,
            color: props.color ?? 0x3388ff,
            depthTest: props.depthTest ?? this.defaultPolygon3DDepthTest,
            depthWrite: props.depthWrite ?? this.defaultPolygon3DDepthWrite,
            minZoom: this._asNumber(props.minZoom),
            maxZoom: this._asNumber(props.maxZoom),
            title: this._getTitle(props),
            titlePlacement: props.titlePlacement || 'top',
            titleAlign: props.titleAlign,
            titleOffset: this._parsePair(props.titleOffset) ?? undefined,
            titleStyle: props.titleStyle,
            titleMinZoom: this._asNumber(props.titleMinZoom),
            titleMaxZoom: this._asNumber(props.titleMaxZoom),
            tooltip: this._getTooltip(props),
        };

        const normStyle = this._normalizeStyle<Area3DOptions>(
            this._resolveStyle(props, 'area3D'), AREA3D_ALIASES);
        const normCb = this._normalizeStyle<Area3DOptions>(cb, AREA3D_ALIASES);
        const merged: Area3DOptions = {
            ...defaults,
            ...(normStyle ?? {}),
            ...(normCb ?? {}),
            rings,
        };
        const area = new Area3D(merged);
        this.add(area);
        if (this.onEachFeature) this.onEachFeature(feature, area);
    }

    // =================================================================
    // Vector3D
    // =================================================================

    private _addVectorFeature(feature: GeoJSONFeature): void {
        const geom = feature.geometry;
        const props = feature.properties ?? {};

        let coordSets: (GeoJSONLineString | null)[];
        if (geom.type === 'LineString')           coordSets = [geom.coordinates];
        else if (geom.type === 'MultiLineString') coordSets = geom.coordinates;
        else                                      coordSets = [null];

        for (const coords of coordSets) {
            const cb = this.vectorToOptions ? this.vectorToOptions(feature, props) : null;
            const defaultPositions = coords ? this._toVectorPositions(coords) : undefined;
            const positions = cb?.positions ?? defaultPositions;
            if (!positions || positions.length < 2) continue;

            const defaults: Vector3DOptions = {
                positions,
                crs: this.crs ?? undefined,
                title: this._getTitle(props),
                titleStyle: props.titleStyle,
                titleOffset: this._parsePair(props.titleOffset) ?? undefined,
                titleAlign: props.titleAlign,
                titleVerticalAlign: props.titleVerticalAlign,
                titleMinZoom: this._asNumber(props.titleMinZoom),
                titleMaxZoom: this._asNumber(props.titleMaxZoom),
                titlePlacement: props.titlePlacement || 'start',
                tooltip: this._getTooltip(props),
                minZoom: this._asNumber(props.minZoom),
                maxZoom: this._asNumber(props.maxZoom),
                color: props.stroke || props.color || '#3388ff',
                width: this._asNumber(props.width) ?? 2,
                arrowSize: this._asNumber(props.arrowSize) ?? 10,
                opacity: this._asNumber(props['stroke-opacity'] ?? props.opacity) ?? 1,
            };

            const normStyle = this._normalizeStyle<Vector3DOptions>(
                this._resolveStyle(props, 'vector'), VECTOR_ALIASES);
            const normCb = this._normalizeStyle<Vector3DOptions>(cb, VECTOR_ALIASES);
            const merged: Vector3DOptions = {
                ...defaults,
                ...(normStyle ?? {}),
                ...(normCb ?? {}),
                positions,
            };
            const vector = new Vector3D(merged);
            this.add(vector);
            if (this.onEachFeature) this.onEachFeature(feature, vector);
        }
    }

    // =================================================================
    // Внутренние парсеры / утилиты
    // =================================================================

    private _toVectorPositions(coords: GeoJSONLineString): Vector3DPosition[] {
        return coords.map(c => [c[0], c[1], c[2] ?? 0] as Vector3DPosition);
    }

    private _parseSize(raw: any): number[] | null {
        if (!raw) return null;
        if (Array.isArray(raw)) return raw as number[];
        if (typeof raw === 'string') {
            const parts = raw.split(',').map(Number);
            if (parts.length >= 1 && parts.length <= 3 && parts.every(v => !isNaN(v))) {
                return parts;
            }
        }
        return null;
    }

    private _parseIconSize(raw: any): IconSize | null {
        const arr = this._parseSize(raw);
        if (!arr || arr.length !== 2) return null;
        return [arr[0], arr[1]];
    }

    private _parseSizeSpec(raw: any): SizeSpec | null {
        const arr = this._parseSize(raw);
        if (!arr || arr.length < 1 || arr.length > 3) return null;
        return arr;
    }

    private _parsePair(raw: any): [number, number] | null {
        if (!raw) return null;
        if (Array.isArray(raw) && raw.length === 2) {
            const [a, b] = raw as any[];
            if (typeof a === 'number' && typeof b === 'number' && isFinite(a) && isFinite(b)) {
                return [a, b];
            }
        }
        if (typeof raw === 'string') {
            const parts = raw.split(',').map(Number);
            if (parts.length === 2 && parts.every(v => !isNaN(v))) {
                return [parts[0], parts[1]];
            }
        }
        return null;
    }

    private _parseTriple(raw: any): [number, number, number] | null {
        if (!raw) return null;
        if (Array.isArray(raw) && raw.length === 3) {
            const [a, b, c] = raw as any[];
            if (typeof a === 'number' && typeof b === 'number' && typeof c === 'number'
                && isFinite(a) && isFinite(b) && isFinite(c)) {
                return [a, b, c];
            }
        }
        if (typeof raw === 'string') {
            const parts = raw.split(',').map(Number);
            if (parts.length === 3 && parts.every(v => !isNaN(v))) {
                return [parts[0], parts[1], parts[2]];
            }
        }
        return null;
    }

    private _asNumber(v: any): number | undefined {
        if (typeof v === 'number' && isFinite(v)) return v;
        if (typeof v === 'string' && v.trim() !== '') {
            const n = Number(v);
            if (isFinite(n)) return n;
        }
        return undefined;
    }
}