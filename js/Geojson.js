/**
 * Geojson.ts — слой GeoJSON.
 *
 * Декларативные опции: `style`, `choropleth`, `diagram` (2D), `diagram3D`.
 * Escape hatch: коллбэки `*ToOptions` (мержатся поверх декларатива).
 * Фильтр: строка-выражение, объект-спецификация, предикат или null.
 *
 * Переключение фильтра без пересоздания слоя: `layer.setFeatureFilter(...)`.
 * Смена декларативного конфига: `layer.setChoropleth(...)` / `setDiagram3D(...)`.
 */
import { Layer } from './Layers.js';
import { Marker } from './Marker.js';
import { Marker3D } from './Marker3D.js';
import { Area3D } from './Area3D.js';
import { Polyline } from './Polyline.js';
import { Polygon } from './Polygon.js';
import { Vector3D } from './Vector3D.js';
import { Diagram } from './Diagram.js';
import { Diagram3D } from './Diagram3D.js';
import { calculateBreaks, getClassIndex } from './Classification.js';
import { resolveColorRamp, sampleColorRamp } from './ColorRamps.js';
import { buildDiagramLegend, buildChoroplethLegend, buildDiagram3DLegend, } from './Legend.js';
const POINT_ALIASES = { icon: 'iconUrl' };
const MARKER3D_ALIASES = { model: 'modelUrl' };
const LINE_ALIASES = {
    stroke: 'color', 'stroke-color': 'color',
    'stroke-width': 'width', 'stroke-opacity': 'opacity',
};
const POLYGON_ALIASES = {
    fill: 'fillColor', 'fill-color': 'fillColor', 'fill-opacity': 'fillOpacity',
    stroke: 'strokeColor', 'stroke-color': 'strokeColor',
    'stroke-width': 'strokeWidth', 'stroke-opacity': 'strokeOpacity',
};
const AREA3D_ALIASES = { model: 'modelUrl' };
const VECTOR_ALIASES = LINE_ALIASES;
const NUMERIC_OPTION_KEYS = new Set([
    'fillOpacity', 'strokeOpacity', 'strokeWidth', 'width', 'opacity', 'arrowSize',
]);
// ── expression compiler ──────────────────────────────────────────────
const replaceEqOutsideStrings = (expr) => {
    let out = '', i = 0, str = null;
    while (i < expr.length) {
        const ch = expr[i];
        if (str) {
            out += ch;
            if (ch === '\\' && i + 1 < expr.length) {
                out += expr[++i];
                i++;
                continue;
            }
            if (ch === str)
                str = null;
            i++;
            continue;
        }
        if (ch === "'" || ch === '"' || ch === '`') {
            str = ch;
            out += ch;
            i++;
            continue;
        }
        if (ch === '=') {
            const prev = out[out.length - 1], next = expr[i + 1];
            if (prev === '<' || prev === '>' || prev === '!' || prev === '=' ||
                next === '=' || next === '>') {
                out += ch;
                i++;
                continue;
            }
            out += '===';
            i++;
            continue;
        }
        out += ch;
        i++;
    }
    return out;
};
const interpolate = (tpl, props) => tpl.replace(/\{([\w.]+)\}/g, (_m, key) => {
    const v = key.includes('.')
        ? key.split('.').reduce((o, k) => (o == null ? undefined : o[k]), props)
        : props[key];
    return v == null ? '' : String(v);
});
/** `f === 'a' || 'b'` → `f === 'a' || f === 'b'`. */
const expandOrChains = (expr) => {
    const LIT = String.raw `(?:'[^'\\]*(?:\\.[^'\\]*)*'|"[^"\\]*(?:\\.[^"\\]*)*"|\d+(?:\.\d+)?|true|false|null)`;
    const FIELD = String.raw `[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*`;
    const chainRe = new RegExp(`(${FIELD})\\s*===\\s*(${LIT}(?:\\s*\\|\\|\\s*${LIT})+)`, 'g');
    const litRe = new RegExp(LIT, 'g');
    return expr.replace(chainRe, (_m, field, chain) => {
        const lits = chain.match(litRe);
        return lits && lits.length >= 2
            ? lits.map(l => `${field} === ${l}`).join(' || ')
            : _m;
    });
};
const compileExpressionFilter = (expr) => {
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
    let fn;
    try {
        fn = new Function('feature', src);
    }
    catch (err) {
        console.warn('GeoJSONLayer: invalid filter expression', expr, err);
        return () => false;
    }
    return (f) => {
        try {
            return fn(f);
        }
        catch (err) {
            console.warn('GeoJSONLayer: filter expression threw', err);
            return false;
        }
    };
};
// ── Mapbox filter → JS expression ───────────────────────────────────
const mapboxToJsExpr = (node) => {
    if (!Array.isArray(node) || !node.length)
        throw new Error('Invalid Mapbox filter');
    const op = node[0];
    const rest = node.slice(1);
    switch (op) {
        case '==':
        case '!=':
        case '<':
        case '<=':
        case '>':
        case '>=': {
            if (rest.length !== 2)
                throw new Error(`Mapbox "${op}" needs 2 args`);
            const jsOp = op === '==' ? '===' : op === '!=' ? '!==' : op;
            return `(${mapboxField(rest[0])} ${jsOp} ${mapboxLiteral(rest[1])})`;
        }
        case 'in':
        case '!in': {
            if (rest.length < 2)
                throw new Error(`Mapbox "${op}" needs key + values`);
            const key = mapboxField(rest[0]);
            const vals = (rest.length === 2 && Array.isArray(rest[1]) && rest[1][0] === 'literal')
                ? rest[1][1]
                : rest.slice(1);
            const ors = vals.map(v => `${key} === ${mapboxLiteral(v)}`).join(' || ');
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
const mapboxField = (node) => {
    if (typeof node === 'string') {
        if (node === '$type')
            return 'geometry';
        if (node === '$id')
            return 'feature.id';
        return `props[${JSON.stringify(node)}]`;
    }
    if (Array.isArray(node)) {
        if (node[0] === 'get')
            return mapboxField(node[1]);
        if (node[0] === 'geometry-type')
            return 'geometry';
        if (node[0] === 'id')
            return 'feature.id';
    }
    throw new Error(`Unsupported Mapbox field: ${JSON.stringify(node)}`);
};
const mapboxLiteral = (node) => {
    if (typeof node === 'string')
        return JSON.stringify(node);
    if (typeof node === 'number')
        return Number.isFinite(node) ? String(node) : 'null';
    if (typeof node === 'boolean')
        return String(node);
    if (node === null)
        return 'null';
    if (Array.isArray(node)) {
        if (node[0] === 'literal')
            return JSON.stringify(node[1]);
        if (node[0] === 'get')
            return mapboxField(node[1]);
        return JSON.stringify(node);
    }
    throw new Error(`Unsupported Mapbox literal: ${JSON.stringify(node)}`);
};
// ── object filter ──────────────────────────────────────────────────
const getPath = (obj, path) => {
    if (!path.includes('.'))
        return obj?.[path];
    let cur = obj;
    for (const p of path.split('.')) {
        if (cur == null)
            return undefined;
        cur = cur[p];
    }
    return cur;
};
const matchFilterValue = (actual, expected) => {
    if (Array.isArray(expected))
        return expected.some(v => v === actual);
    if (expected === null)
        return actual == null;
    return actual === expected;
};
const resolveFilterPath = (feature, path) => {
    const props = feature.properties ?? {};
    const geom = feature.geometry?.type ?? null;
    if (path === 'geometry' || path === 'geometryType')
        return geom;
    if (path === 'feature')
        return feature;
    if (path === 'props')
        return props;
    if (path.startsWith('feature.'))
        return getPath(feature, path.slice(8));
    if (path.startsWith('props.'))
        return getPath(props, path.slice(6));
    return getPath(props, path);
};
const compileObjectFilter = (spec) => {
    const entries = Object.entries(spec);
    return (feature) => {
        for (const [path, expected] of entries) {
            if (!matchFilterValue(resolveFilterPath(feature, path), expected))
                return false;
        }
        return true;
    };
};
// =====================================================================
// Color resolution
// =====================================================================
const PALETTE_3D_FALLBACK = [
    '#3498db', '#e74c3c', '#2ecc71', '#f39c12',
    '#9b59b6', '#1abc9c', '#e67e22', '#34495e',
];
const resolveColorMapValue = (spec, value) => {
    if (!spec)
        return undefined;
    if (typeof spec === 'string')
        return spec;
    for (const r of spec) {
        if ((r.min == null || value >= r.min) &&
            (r.max == null || value < r.max))
            return r.color;
    }
    return undefined;
};
// =====================================================================
// GeoJSONLayer
// =====================================================================
/**
 * Слой GeoJSON: маркеры / линии / полигоны / диаграммы 2D и 3D / choropleth.
 * Порядок merge: `defaults → style → callback → enforced`.
 */
export class GeoJSONLayer extends Layer {
    url = null;
    data = null;
    crs = null;
    tooltipOnHover = false;
    legend = null;
    choropleth = null;
    _choroplethBreaks = [];
    _choroplethRamp = null;
    diagram3D = null;
    diagram3DToOptions = null;
    onEachDiagram3D = null;
    /** Кэш авторасчёта для `diagram3D` (unitM + barWidthM/barDepthM). */
    _diagram3DAuto = null;
    _diagramAuto = null;
    featureFilter = null;
    filterSpec = null;
    filterExpression = null;
    onEachFeature = null;
    style = null;
    titleField = null;
    pointToOptions = null;
    point3DToOptions = null;
    lineToOptions = null;
    polygonToOptions = null;
    polygon3DToOptions = null;
    vectorToOptions = null;
    tooltip = null;
    /** @deprecated Используйте `tooltip: '{fieldName}'`. */
    tooltipField = null;
    diagram = null;
    diagramToOptions = null;
    onEachDiagram = null;
    defaultIconUrl = 'marker.png';
    defaultIconSize = [16, 16];
    defaultAnchor = [0.5, 1.0];
    default3DPrimitiveType = 'box';
    default3DSize = [100, 100, 100];
    default3DAnchor = [0.5, 0, 0.5];
    default3DAltitude = 0;
    default3DAltitudeMode = 'clampToGround';
    defaultLineColor = '#3388ff';
    defaultLineWidth = 2;
    defaultLineOpacity = 1;
    defaultLineAltitudeMode = 'absolute';
    defaultLineAltitude = 10;
    defaultLineDepthTest = false;
    defaultLineDepthWrite = false;
    defaultLineMinZoom = -Infinity;
    defaultLineMaxZoom = Infinity;
    defaultFillColor = '#3388ff';
    defaultFillOpacity = 0.5;
    defaultStrokeColor = '#000000';
    defaultStrokeWidth = 2;
    defaultStrokeOpacity = 1;
    defaultPolygonAltitudeMode = 'absolute';
    defaultPolygonAltitude = 10;
    defaultPolygonDepthTest = false;
    defaultPolygonDepthWrite = false;
    defaultPolygonMinZoom = -Infinity;
    defaultPolygonMaxZoom = Infinity;
    defaultPolygonExtruded = false;
    defaultPolygonHeight = 0;
    defaultPolygonMinHeight = 0;
    defaultPolygon3DPrimitiveType = 'box';
    defaultPolygon3DSize = null;
    defaultPolygon3DAnchor = [0.5, 0, 0.5];
    defaultPolygon3DAltitude = 0;
    defaultPolygon3DAltitudeMode = 'clampToGround';
    defaultPolygon3DFit = 'stretch';
    defaultPolygon3DRotate = 0;
    defaultPolygon3DModelUrl = null;
    defaultPolygon3DDepthTest = true;
    defaultPolygon3DDepthWrite = true;
    _loaded = false;
    static fromMapboxFilter(arr) { return mapboxToJsExpr(arr); }
    constructor(o = {}) {
        super();
        this.diagram = o.diagram ?? null;
        this.diagramToOptions = o.diagramToOptions ?? null;
        this.onEachDiagram = o.onEachDiagram ?? null;
        this.diagram3D = o.diagram3D ?? null;
        this.diagram3DToOptions = o.diagram3DToOptions ?? null;
        this.onEachDiagram3D = o.onEachDiagram3D ?? null;
        this.choropleth = o.choropleth ?? null;
        this.url = o.url ?? null;
        this.data = o.data ?? null;
        this.crs = o.crs ?? null;
        this.onEachFeature = o.onEachFeature ?? null;
        this.tooltipOnHover = o.tooltipOnHover ?? false;
        this._applyFilter(o.featureFilter ?? o.filter ?? null);
        this.style = o.style ?? null;
        this.titleField = o.titleField ?? null;
        this.pointToOptions = o.pointToOptions ?? null;
        this.point3DToOptions = o.point3DToOptions ?? null;
        this.lineToOptions = o.lineToOptions ?? null;
        this.polygonToOptions = o.polygonToOptions ?? null;
        this.polygon3DToOptions = o.polygon3DToOptions ?? null;
        this.vectorToOptions = o.vectorToOptions ?? null;
        this.tooltip = o.tooltip ?? null;
        this.tooltipField = o.tooltipField ?? null;
        this.defaultIconUrl = o.defaultIconUrl ?? 'marker.png';
        this.defaultIconSize = o.defaultIconSize ?? [16, 16];
        this.defaultAnchor = o.defaultAnchor ?? [0.5, 1.0];
        this.default3DPrimitiveType = o.default3DPrimitiveType ?? 'box';
        this.default3DSize = o.default3DSize ?? [100, 100, 100];
        this.default3DAnchor = o.default3DAnchor ?? [0.5, 0, 0.5];
        this.default3DAltitude = o.default3DAltitude ?? 0;
        this.default3DAltitudeMode = o.default3DAltitudeMode ?? 'clampToGround';
        this.defaultLineColor = o.defaultLineColor ?? '#3388ff';
        this.defaultLineWidth = o.defaultLineWidth ?? 2;
        this.defaultLineOpacity = o.defaultLineOpacity ?? 1;
        this.defaultLineAltitudeMode = o.defaultLineAltitudeMode ?? 'absolute';
        this.defaultLineAltitude = o.defaultLineAltitude ?? o.defaultLineAltitudeOffset ?? 10;
        this.defaultLineDepthTest = o.defaultLineDepthTest ?? false;
        this.defaultLineDepthWrite = o.defaultLineDepthWrite ?? false;
        this.defaultLineMinZoom = o.defaultLineMinZoom ?? -Infinity;
        this.defaultLineMaxZoom = o.defaultLineMaxZoom ?? Infinity;
        this.defaultFillColor = o.defaultFillColor ?? '#3388ff';
        this.defaultFillOpacity = o.defaultFillOpacity ?? 0.5;
        this.defaultStrokeColor = o.defaultStrokeColor ?? '#000000';
        this.defaultStrokeWidth = o.defaultStrokeWidth ?? 2;
        this.defaultStrokeOpacity = o.defaultStrokeOpacity ?? 1;
        this.defaultPolygonAltitudeMode = o.defaultPolygonAltitudeMode ?? 'absolute';
        this.defaultPolygonAltitude = o.defaultPolygonAltitude ?? o.defaultPolygonAltitudeOffset ?? 10;
        this.defaultPolygonDepthTest = o.defaultPolygonDepthTest ?? false;
        this.defaultPolygonDepthWrite = o.defaultPolygonDepthWrite ?? false;
        this.defaultPolygonMinZoom = o.defaultPolygonMinZoom ?? -Infinity;
        this.defaultPolygonMaxZoom = o.defaultPolygonMaxZoom ?? Infinity;
        this.defaultPolygonExtruded = o.defaultPolygonExtruded ?? false;
        this.defaultPolygonHeight = o.defaultPolygonHeight ?? 0;
        this.defaultPolygonMinHeight = o.defaultPolygonMinHeight ?? 0;
        this.defaultPolygon3DPrimitiveType = o.defaultPolygon3DPrimitiveType ?? 'box';
        this.defaultPolygon3DSize = o.defaultPolygon3DSize ?? null;
        this.defaultPolygon3DAnchor = o.defaultPolygon3DAnchor ?? [0.5, 0, 0.5];
        this.defaultPolygon3DAltitude = o.defaultPolygon3DAltitude ?? 0;
        this.defaultPolygon3DAltitudeMode = o.defaultPolygon3DAltitudeMode ?? 'clampToGround';
        this.defaultPolygon3DFit = o.defaultPolygon3DFit ?? 'stretch';
        this.defaultPolygon3DRotate = o.defaultPolygon3DRotate ?? 0;
        this.defaultPolygon3DModelUrl = o.defaultPolygon3DModelUrl ?? null;
        this.defaultPolygon3DDepthTest = o.defaultPolygon3DDepthTest ?? true;
        this.defaultPolygon3DDepthWrite = o.defaultPolygon3DDepthWrite ?? true;
    }
    // =================================================================
    // Lifecycle
    // =================================================================
    addTo(map) {
        super.addTo(map);
        if (!this._loaded)
            this._load();
        return this;
    }
    reload() {
        const self = this;
        for (const obj of [...(self._objects ?? [])])
            obj.remove();
        self._objects = [];
        if (this.legend) {
            try {
                this.legend.destroy();
            }
            catch { }
            this.legend = null;
        }
        this._loaded = false;
        if (self._map)
            this._load();
    }
    // ── setters (все с авто-reload при активной карте) ─────────────
    setData(data) {
        this.data = data;
        if (this._map)
            this.reload();
        else
            this._loaded = false;
        return this;
    }
    setUrl(url) {
        this.url = url;
        if (this._map)
            this.reload();
        else
            this._loaded = false;
        return this;
    }
    setStyle(style) {
        this.style = style;
        if (this._map && this._loaded)
            this.reload();
        return this;
    }
    setChoropleth(cfg) {
        this.choropleth = cfg;
        if (this._map && this._loaded)
            this.reload();
        return this;
    }
    setDiagram(cfg) {
        this.diagram = cfg;
        if (this._map && this._loaded)
            this.reload();
        return this;
    }
    getLegend() { return this.legend; }
    setDiagram3D(cfg) {
        this.diagram3D = cfg;
        if (this._map && this._loaded)
            this.reload();
        return this;
    }
    /** Меняет feature-фильтр. Пересоздаёт объекты слоя без пересоздания слоя. */
    setFeatureFilter(input) {
        this._applyFilter(input);
        if (this._map && this._loaded)
            this.reload();
        return this;
    }
    /** Alias для `setFeatureFilter`. */
    setFilter(input) {
        return this.setFeatureFilter(input);
    }
    getFilter() {
        if (this.filterExpression != null)
            return this.filterExpression;
        if (this.filterSpec != null)
            return this.filterSpec;
        return this.featureFilter;
    }
    /** Добавляет объекты к уже загруженным. */
    addData(data) {
        this._parse(data);
        return this;
    }
    // =================================================================
    // Filter
    // =================================================================
    _applyFilter(input) {
        if (Array.isArray(input)) {
            try {
                input = GeoJSONLayer.fromMapboxFilter(input);
            }
            catch (err) {
                console.warn('GeoJSONLayer: cannot convert Mapbox filter.', err, input);
                this.featureFilter = this.filterSpec = this.filterExpression = null;
                return;
            }
        }
        if (!input) {
            this.featureFilter = this.filterSpec = this.filterExpression = null;
            return;
        }
        if (typeof input === 'function') {
            this.featureFilter = input;
            this.filterSpec = this.filterExpression = null;
            return;
        }
        if (typeof input === 'string') {
            const trimmed = input.trim();
            if (!trimmed) {
                this.featureFilter = this.filterSpec = this.filterExpression = null;
                return;
            }
            this.featureFilter = compileExpressionFilter(trimmed);
            this.filterSpec = null;
            this.filterExpression = trimmed;
            return;
        }
        const spec = input;
        if (!Object.keys(spec).length) {
            this.featureFilter = this.filterSpec = this.filterExpression = null;
            return;
        }
        this.featureFilter = compileObjectFilter(spec);
        this.filterSpec = spec;
        this.filterExpression = null;
    }
    // =================================================================
    // Load
    // =================================================================
    async _load() {
        let geojson = null;
        try {
            if (this.data)
                geojson = this.data;
            else if (this.url) {
                const resp = await fetch(this.url);
                if (!resp.ok)
                    throw new Error(`HTTP ${resp.status}`);
                geojson = await resp.json();
            }
            if (!geojson) {
                console.warn('GeoJSONLayer: no data or URL');
                return;
            }
            if (this.choropleth) {
                this._choroplethRamp = resolveColorRamp(this.choropleth.colorRamp);
                this._calculateChoroplethBreaks(geojson);
            }
            this._computeDiagram3DAuto(geojson);
            this._computeDiagramAuto(geojson);
            this._parse(geojson);
            this._buildLegend(geojson);
            this._loaded = true;
        }
        catch (err) {
            console.error('GeoJSONLayer: load/parse error', err);
        }
    }
    _buildLegend(geojson) {
        if (this.legend) {
            try {
                this.legend.destroy();
            }
            catch { }
            this.legend = null;
        }
        let legendOpts;
        let builder = null;
        if (this.diagram?.legend) {
            legendOpts = this.diagram.legend;
            builder = () => buildDiagramLegend(this, geojson, this.diagram, legendOpts);
        }
        else if (this.diagram3D?.legend) {
            legendOpts = this.diagram3D.legend;
            builder = () => buildDiagram3DLegend(this, geojson, this.diagram3D, legendOpts);
        }
        else if (this.choropleth?.legend) {
            legendOpts = this.choropleth.legend;
            builder = () => buildChoroplethLegend(this, geojson, this.choropleth, legendOpts);
        }
        if (!builder || !legendOpts)
            return;
        try {
            this.legend = builder();
            if (legendOpts.target)
                this.legend.mount(legendOpts.target);
            legendOpts.onReady?.(this.legend);
        }
        catch (err) {
            console.warn('GeoJSONLayer: legend build failed', err);
        }
    }
    // =================================================================
    // Choropleth
    // =================================================================
    _calculateChoroplethBreaks(geojson) {
        if (!this.choropleth)
            return;
        const values = [];
        const visit = (f) => {
            if (!f.properties)
                return;
            const v = this._evaluateValueExpression(f.properties, this.choropleth.value);
            if (isFinite(v))
                values.push(v);
        };
        if (geojson.type === 'FeatureCollection')
            geojson.features.forEach(visit);
        else if (geojson.type === 'Feature')
            visit(geojson);
        this._choroplethBreaks = calculateBreaks(values, this.choropleth.classification ?? 'jenks', this.choropleth.classes ?? 5);
    }
    // =================================================================
    // 3D diagram: auto-sizing (unitM + bar dimensions)
    // =================================================================
    /**
     * Один раз на слой: если `diagram.unitPx === 'auto'` — считаем
     * `unitPx = maxHeightPx / maxValue`.
     */
    _computeDiagramAuto(geojson) {
        this._diagramAuto = null;
        const cfg = this.diagram;
        if (!cfg?.fields?.length)
            return;
        if (cfg.unitPx !== 'auto')
            return;
        let maxValue = 0;
        const scan = (f) => {
            if (this.featureFilter && !this.featureFilter(f))
                return;
            const p = f.properties ?? {};
            for (const k of cfg.fields) {
                const v = Number(p[k]);
                if (isFinite(v) && v > maxValue)
                    maxValue = v;
            }
        };
        if (geojson.type === 'FeatureCollection')
            geojson.features.forEach(scan);
        else if (geojson.type === 'Feature')
            scan(geojson);
        if (maxValue <= 0)
            return;
        this._diagramAuto = {
            unitPx: (cfg.maxHeightPx ?? 200) / maxValue,
        };
    }
    /**
     * Один раз на слой:
     * - если `unitM: 'auto'` — `unitM = maxHeightM / maxValue`;
     * - если `barWidthM`/`barDepthM` не заданы — подбираем по maxH и n.
     */
    _computeDiagram3DAuto(geojson) {
        this._diagram3DAuto = null;
        const cfg = this.diagram3D;
        if (!cfg?.fields?.length)
            return;
        let maxValue = 0, maxBars = 1;
        const scan = (f) => {
            if (this.featureFilter && !this.featureFilter(f))
                return;
            const p = f.properties ?? {};
            let localMax = 0, cnt = 0;
            for (const k of cfg.fields) {
                const v = Number(p[k]);
                if (isFinite(v) && v > 0) {
                    if (v > localMax)
                        localMax = v;
                    cnt++;
                }
            }
            if (cnt === 0)
                return;
            if (localMax > maxValue)
                maxValue = localMax;
            if (cnt > maxBars)
                maxBars = cnt;
        };
        if (geojson.type === 'FeatureCollection')
            geojson.features.forEach(scan);
        else if (geojson.type === 'Feature')
            scan(geojson);
        if (maxValue <= 0)
            return;
        const unitM = cfg.unitM === 'auto'
            ? (cfg.maxHeightM ?? 1000) / maxValue
            : (typeof cfg.unitM === 'number' ? cfg.unitM : 1);
        let barWidthM = cfg.barWidthM ?? null;
        let barDepthM = cfg.barDepthM ?? null;
        if ((cfg.type ?? 'bar3d') === 'bar3d') {
            if (barWidthM != null && barDepthM == null)
                barDepthM = barWidthM;
            else if (barDepthM != null && barWidthM == null)
                barWidthM = barDepthM;
            else if (barWidthM == null && barDepthM == null) {
                const maxH = maxValue * unitM;
                const gap = cfg.gapM ?? 0;
                const targetW = maxH * 0.3;
                const derived = Math.max(maxH * 0.05, (targetW - gap * Math.max(0, maxBars - 1)) / maxBars);
                barWidthM = derived;
                barDepthM = derived;
            }
        }
        this._diagram3DAuto = {
            unitM,
            barWidthM: barWidthM ?? 0,
            barDepthM: barDepthM ?? 0,
        };
    }
    /** Дополняет `opts` авто-размерами bar3d, если они не заданы. */
    _withDiagram3DAuto(opts) {
        const out = { ...opts };
        const auto = this._diagram3DAuto;
        if (!auto)
            return out;
        if (out.unitM == null)
            out.unitM = auto.unitM;
        if ((out.type ?? 'bar3d') === 'bar3d') {
            if (out.barWidthM != null && out.barDepthM == null)
                out.barDepthM = out.barWidthM;
            else if (out.barDepthM != null && out.barWidthM == null)
                out.barWidthM = out.barDepthM;
            else if (out.barWidthM == null && out.barDepthM == null) {
                out.barWidthM = auto.barWidthM;
                out.barDepthM = auto.barDepthM;
            }
        }
        return out;
    }
    // =================================================================
    // Style helpers
    // =================================================================
    _getTitle(props) {
        if (this.titleField) {
            const v = props[this.titleField];
            if (v != null && v !== '')
                return String(v);
        }
        return props.title || props.name || '';
    }
    _evaluateValueExpression(props, exprOrFn) {
        if (typeof exprOrFn === 'function')
            return exprOrFn(props);
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
        }
        catch {
            return NaN;
        }
    }
    _getTooltip(props) {
        const t = this.tooltip;
        if (typeof t === 'function') {
            try {
                const out = t(props);
                if (out != null)
                    return String(out);
            }
            catch (e) {
                console.warn('GeoJSONLayer: tooltip callback threw', e);
            }
        }
        else if (typeof t === 'string' && t) {
            return t.includes('{') ? interpolate(t, props) : t;
        }
        if (this.tooltipField) {
            const raw = props[this.tooltipField];
            if (raw != null && raw !== '') {
                return String(raw).includes('{') ? interpolate(String(raw), props) : String(raw);
            }
        }
        return props.tooltip || props.description || '';
    }
    _resolveStyle(props, type) {
        const s = this.style;
        if (!s)
            return null;
        const by = s.by ?? 'category';
        const value = props[by];
        const shared = this._pickStyleLevel(s, value);
        const perType = this._pickStyleLevel(s[type], value);
        if (!shared && !perType)
            return null;
        if (!shared)
            return perType;
        if (!perType)
            return shared;
        return { ...shared, ...perType };
    }
    _pickStyleLevel(cfg, value) {
        if (!cfg)
            return null;
        if (value != null && cfg.cases) {
            const c = cfg.cases[value];
            if (c)
                return c;
        }
        return cfg.default ?? null;
    }
    _normalizeStyle(src, aliases) {
        if (!src)
            return null;
        const out = { ...src };
        for (const [alias, canonical] of Object.entries(aliases)) {
            if (out[canonical] === undefined && out[alias] != null) {
                out[canonical] = NUMERIC_OPTION_KEYS.has(canonical)
                    ? this._asNumber(out[alias]) ?? out[alias]
                    : out[alias];
            }
            delete out[alias];
        }
        return out;
    }
    // =================================================================
    // Dispatch
    // =================================================================
    _parse(geojson) {
        const type = geojson.type;
        if (type === 'FeatureCollection') {
            for (const f of geojson.features)
                this._addFeature(f);
        }
        else if (type === 'Feature') {
            this._addFeature(geojson);
        }
        else if (type === 'Point' || type === 'LineString' || type === 'MultiLineString'
            || type === 'Polygon' || type === 'MultiPolygon') {
            this._addFeature({ type: 'Feature', geometry: geojson, properties: {} });
        }
        else {
            console.debug(`GeoJSONLayer: type "${type}" not supported`);
        }
    }
    _addFeature(feature) {
        const props = feature.properties ?? {};
        if (this.featureFilter && !this.featureFilter(feature))
            return;
        const geom = feature.geometry;
        if (!geom)
            return;
        switch (geom.type) {
            case 'Point':
                if (this.vectorToOptions && props.vector === true)
                    this._addVectorFeature(feature);
                else
                    this._addPointFeature(feature);
                break;
            case 'LineString':
            case 'MultiLineString':
                if (this.vectorToOptions || props.vector === true)
                    this._addVectorFeature(feature);
                else
                    this._addLineFeature(feature);
                break;
            case 'Polygon':
            case 'MultiPolygon':
                this._addPolygonFeature(feature);
                break;
            default:
                console.debug(`GeoJSONLayer: type "${geom.type}" not supported`);
        }
    }
    // =================================================================
    // Points
    // =================================================================
    _addPointFeature(feature) {
        const geom = feature.geometry;
        if (geom.type !== 'Point')
            return;
        const props = feature.properties ?? {};
        const [lon, lat, alt] = geom.coordinates;
        const lonLat = [lon, lat];
        const altFromCoords = alt !== undefined ? alt : undefined;
        if ((this.diagram3D || this.diagram3DToOptions) && props.diagram3D !== false) {
            this._addPointDiagram3D(feature, props, lonLat, altFromCoords);
            return;
        }
        if ((this.diagram || this.diagramToOptions) && props.diagram !== false) {
            this._addPointDiagram(feature, props, lonLat);
            return;
        }
        const cb3D = this.point3DToOptions?.(feature, props) ?? null;
        const is3D = cb3D != null
            || props['3d'] === true || props.type === '3d' || props.markerType === '3d';
        if (is3D)
            this._createMarker3D(feature, props, lonLat, altFromCoords, cb3D);
        else
            this._createMarker(feature, props, lonLat, altFromCoords, this.pointToOptions?.(feature, props) ?? null);
    }
    _addPointDiagram3D(feature, props, lonLat, altFromCoords) {
        const raw = this.diagram3DToOptions
            ? this.diagram3DToOptions(feature, props)
            : this._diagram3DFromConfig(feature, props);
        if (!raw)
            return;
        const baseOpts = this._withDiagram3DAuto(raw);
        const d = new Diagram3D({
            ...baseOpts,
            position: lonLat,
            crs: this.crs ?? undefined,
            altitude: baseOpts.altitude ?? altFromCoords ?? 0,
            altitudeMode: baseOpts.altitudeMode ?? 'clampToGround',
            clusterable: false,
        });
        this.add(d);
        this.onEachDiagram3D?.(feature, d);
    }
    _addPointDiagram(feature, props, lonLat) {
        const opts = this.diagramToOptions
            ? this.diagramToOptions(feature, props)
            : this._diagramFromConfig(feature, props);
        if (!opts)
            return;
        const d = new Diagram({
            ...opts,
            position: lonLat,
            crs: this.crs ?? undefined,
            parentPolygon: null,
            fitToPolygon: false,
            clusterable: false,
        });
        this.add(d);
        this.onEachDiagram?.(feature, d);
    }
    _createMarker(feature, props, lonLat, altFromCoords, cb) {
        const defaults = {
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
        const style = this._normalizeStyle(this._resolveStyle(props, 'point'), POINT_ALIASES);
        const cbNorm = this._normalizeStyle(cb, POINT_ALIASES);
        const marker = new Marker({
            ...defaults, ...(style ?? {}), ...(cbNorm ?? {}), position: lonLat,
        });
        this.add(marker);
        this.onEachFeature?.(feature, marker);
    }
    _createMarker3D(feature, props, lonLat, altFromCoords, cb) {
        const defaults = {
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
        const style = this._normalizeStyle(this._resolveStyle(props, 'marker3D'), MARKER3D_ALIASES);
        const cbNorm = this._normalizeStyle(cb, MARKER3D_ALIASES);
        const marker = new Marker3D({
            ...defaults, ...(style ?? {}), ...(cbNorm ?? {}), position: lonLat,
        });
        this.add(marker);
        this.onEachFeature?.(feature, marker);
    }
    // =================================================================
    // Lines
    // =================================================================
    _addLineFeature(feature) {
        const geom = feature.geometry;
        if (geom.type !== 'LineString' && geom.type !== 'MultiLineString')
            return;
        const props = feature.properties ?? {};
        const coordSets = geom.type === 'LineString' ? [geom.coordinates] : geom.coordinates;
        for (const coords of coordSets) {
            if (coords.length < 2)
                continue;
            const cb = this.lineToOptions?.(feature, props) ?? null;
            const defaults = {
                positions: coords,
                crs: this.crs ?? undefined,
                color: props.stroke || props.color || this.defaultLineColor,
                opacity: this._asNumber(props['stroke-opacity'] ?? props.opacity) ?? this.defaultLineOpacity,
                width: this._asNumber(props['stroke-width'] ?? props.width) ?? this.defaultLineWidth,
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
            const style = this._normalizeStyle(this._resolveStyle(props, 'line'), LINE_ALIASES);
            const cbNorm = this._normalizeStyle(cb, LINE_ALIASES);
            const polyline = new Polyline({ ...defaults, ...(style ?? {}), ...(cbNorm ?? {}), positions: coords });
            this.add(polyline);
            this.onEachFeature?.(feature, polyline);
        }
    }
    // =================================================================
    // Polygons
    // =================================================================
    _addPolygonFeature(feature) {
        const geom = feature.geometry;
        if (geom.type !== 'Polygon' && geom.type !== 'MultiPolygon')
            return;
        const props = feature.properties ?? {};
        const ringSets = geom.type === 'Polygon' ? [geom.coordinates] : geom.coordinates;
        for (const rings of ringSets) {
            if (!rings.length || !rings[0].length)
                continue;
            const cb3D = this.polygon3DToOptions?.(feature, props) ?? null;
            const is3D = cb3D != null
                || props['3d'] === true || props.type === '3d' || props.markerType === '3d';
            if (is3D) {
                this._createArea3D(feature, props, rings, cb3D);
                continue;
            }
            const polygon = this._createPolygon(feature, props, rings, this.polygonToOptions?.(feature, props) ?? null);
            if (!polygon)
                continue;
            if (this.diagram3D || this.diagram3DToOptions)
                this._addCartodiagram3D(feature, props, polygon);
            else if (this.diagram || this.diagramToOptions)
                this._addCartodiagram(feature, props, polygon);
        }
    }
    _createPolygon(feature, props, rings, cb) {
        let choroplethColor;
        if (this.choropleth && this._choroplethRamp) {
            const val = this._evaluateValueExpression(props, this.choropleth.value);
            if (isFinite(val)) {
                const idx = getClassIndex(val, this._choroplethBreaks);
                const denom = Math.max(1, this._choroplethBreaks.length - 2);
                const t = idx / denom;
                const rgba = sampleColorRamp(this._choroplethRamp, t);
                choroplethColor = `#${((1 << 24) + (rgba[0] << 16) + (rgba[1] << 8) + rgba[2]).toString(16).slice(1)}`;
            }
            else {
                choroplethColor = this.choropleth.noDataColor ?? '#cccccc';
            }
        }
        const defaults = {
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
        const style = this._normalizeStyle(this._resolveStyle(props, 'polygon'), POLYGON_ALIASES);
        const cbNorm = this._normalizeStyle(cb, POLYGON_ALIASES);
        const merged = {
            ...defaults,
            ...(style ?? {}),
            ...(cbNorm ?? {}),
            rings,
            fillColor: choroplethColor || cbNorm?.fillColor || style?.fillColor || defaults.fillColor,
        };
        const polygon = new Polygon(merged);
        this.add(polygon);
        this.onEachFeature?.(feature, polygon);
        return polygon;
    }
    _addCartodiagram(feature, props, polygon) {
        const opts = this.diagramToOptions
            ? this.diagramToOptions(feature, props)
            : this._diagramFromConfig(feature, props);
        if (!opts)
            return;
        const center = polygon.getVisualCenter();
        if (!center)
            return;
        const d = new Diagram({
            ...opts,
            position: center,
            crs: this.crs,
            parentPolygon: polygon,
            fitToPolygon: opts.fitToPolygon ?? this.diagram?.fitToPolygon ?? true,
            minScreenScale: opts.minScreenScale ?? this.diagram?.minScreenScale ?? 0.5,
            clusterable: false,
        });
        this.add(d);
        this.onEachDiagram?.(feature, d);
    }
    _addCartodiagram3D(feature, props, polygon) {
        const raw = this.diagram3DToOptions
            ? this.diagram3DToOptions(feature, props)
            : this._diagram3DFromConfig(feature, props);
        if (!raw)
            return;
        const baseOpts = this._withDiagram3DAuto(raw);
        const center = polygon.getVisualCenter();
        if (!center)
            return;
        const d = new Diagram3D({
            ...baseOpts,
            position: center,
            crs: 'EPSG:4326',
            altitude: baseOpts.altitude ?? this.defaultPolygonAltitude,
            altitudeMode: baseOpts.altitudeMode ?? this.defaultPolygonAltitudeMode,
            clusterable: false,
        });
        this.add(d);
        this.onEachDiagram3D?.(feature, d);
    }
    // ── config → opts ─────────────────────────────────────────────────
    _diagram3DFromConfig(_f, props) {
        const cfg = this.diagram3D;
        if (!cfg?.fields?.length)
            return null;
        const unitM = this._diagram3DAuto?.unitM
            ?? (typeof cfg.unitM === 'number' ? cfg.unitM : 1);
        const minVal = (cfg.minValueM ?? 0) > 0 ? (cfg.minValueM / unitM) : 0;
        const data = [];
        for (let i = 0; i < cfg.fields.length; i++) {
            const key = cfg.fields[i];
            const raw = Number(props[key]);
            if (!isFinite(raw))
                continue;
            const value = Math.max(raw, minVal);
            const color = resolveColorMapValue(cfg.colorMap?.[key], raw);
            data.push(color !== undefined
                ? { label: key, value, color }
                : { label: key, value });
        }
        if (!data.length)
            return null;
        let tooltip = this._getTooltip(props);
        if (!tooltip) {
            tooltip = cfg.fields.map(k => `${k}: <b>${props[k]}</b>`).join('<br>');
        }
        return {
            type: cfg.type ?? 'bar3d',
            data,
            unitM,
            barWidthM: cfg.barWidthM,
            barDepthM: cfg.barDepthM,
            gapM: cfg.gapM,
            strokeColor: cfg.strokeColor,
            strokeWidthM: cfg.strokeWidthM,
            minZoom: cfg.minZoom,
            maxZoom: cfg.maxZoom,
            tooltip,
            altitude: cfg.altitude,
            altitudeMode: cfg.altitudeMode,
            unitValue: cfg.unitValue,
            maxCols: cfg.maxCols,
            primitiveType: cfg.primitiveType,
        };
    }
    _diagramFromConfig(_f, props) {
        const cfg = this.diagram;
        if (!cfg?.fields?.length)
            return null;
        // Разрешённый unitPx (число или авто)
        const unitPx = this._diagramAuto?.unitPx
            ?? (typeof cfg.unitPx === 'number' ? cfg.unitPx : 1);
        const data = cfg.fields
            .map(key => {
            const v = Number(props[key]);
            if (!isFinite(v))
                return null;
            // Цвет — через тот же resolver, что и в 3D
            const color = resolveColorMapValue(cfg.colorMap?.[key], v);
            return {
                label: cfg.labelField ? String(props[cfg.labelField] ?? key) : key,
                value: v,
                color,
            };
        })
            .filter((d) => d !== null);
        if (!data.length)
            return null;
        let tooltip = this._getTooltip(props);
        if (!tooltip) {
            tooltip = data.map(d => (d.color
                ? `<span style="display:inline-block;width:10px;height:10px;background:${d.color};margin-right:6px;border-radius:2px;"></span>`
                : '') + `${d.label}: <b>${d.value}</b>`).join('<br>');
        }
        const label = cfg.labelField ? String(props[cfg.labelField] ?? '') : '';
        return {
            type: cfg.type ?? 'bar',
            data,
            unitPx,
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
            projection: cfg.projection,
            minZoom: cfg.minZoom,
            maxZoom: cfg.maxZoom,
            tooltip,
            coins: cfg.coins,
            segmentSizes: cfg.segmentSizes,
        };
    }
    _createArea3D(feature, props, rings, cb) {
        const defaults = {
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
        const style = this._normalizeStyle(this._resolveStyle(props, 'area3D'), AREA3D_ALIASES);
        const cbNorm = this._normalizeStyle(cb, AREA3D_ALIASES);
        const area = new Area3D({ ...defaults, ...(style ?? {}), ...(cbNorm ?? {}), rings });
        this.add(area);
        this.onEachFeature?.(feature, area);
    }
    // =================================================================
    // Vector3D
    // =================================================================
    _addVectorFeature(feature) {
        const geom = feature.geometry;
        const props = feature.properties ?? {};
        const coordSets = geom.type === 'LineString' ? [geom.coordinates]
            : geom.type === 'MultiLineString' ? geom.coordinates
                : [null];
        for (const coords of coordSets) {
            const cb = this.vectorToOptions?.(feature, props) ?? null;
            const positions = cb?.positions ?? (coords ? this._toVectorPositions(coords) : undefined);
            if (!positions || positions.length < 2)
                continue;
            const defaults = {
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
            const style = this._normalizeStyle(this._resolveStyle(props, 'vector'), VECTOR_ALIASES);
            const cbNorm = this._normalizeStyle(cb, VECTOR_ALIASES);
            const v = new Vector3D({ ...defaults, ...(style ?? {}), ...(cbNorm ?? {}), positions });
            this.add(v);
            this.onEachFeature?.(feature, v);
        }
    }
    // =================================================================
    // Parsers
    // =================================================================
    _toVectorPositions(coords) {
        return coords.map(c => [c[0], c[1], c[2] ?? 0]);
    }
    _parseSize(raw) {
        if (!raw)
            return null;
        if (Array.isArray(raw))
            return raw;
        if (typeof raw === 'string') {
            const p = raw.split(',').map(Number);
            if (p.length >= 1 && p.length <= 3 && p.every(v => !isNaN(v)))
                return p;
        }
        return null;
    }
    _parseIconSize(raw) {
        const a = this._parseSize(raw);
        return a && a.length === 2 ? [a[0], a[1]] : null;
    }
    _parseSizeSpec(raw) {
        const a = this._parseSize(raw);
        return a && a.length >= 1 && a.length <= 3 ? a : null;
    }
    _parsePair(raw) {
        if (!raw)
            return null;
        if (Array.isArray(raw) && raw.length === 2) {
            const [a, b] = raw;
            if (typeof a === 'number' && typeof b === 'number' && isFinite(a) && isFinite(b))
                return [a, b];
        }
        if (typeof raw === 'string') {
            const p = raw.split(',').map(Number);
            if (p.length === 2 && p.every(v => !isNaN(v)))
                return [p[0], p[1]];
        }
        return null;
    }
    _parseTriple(raw) {
        if (!raw)
            return null;
        if (Array.isArray(raw) && raw.length === 3) {
            const [a, b, c] = raw;
            if (typeof a === 'number' && typeof b === 'number' && typeof c === 'number'
                && isFinite(a) && isFinite(b) && isFinite(c))
                return [a, b, c];
        }
        if (typeof raw === 'string') {
            const p = raw.split(',').map(Number);
            if (p.length === 3 && p.every(v => !isNaN(v)))
                return [p[0], p[1], p[2]];
        }
        return null;
    }
    _asNumber(v) {
        if (typeof v === 'number' && isFinite(v))
            return v;
        if (typeof v === 'string' && v.trim() !== '') {
            const n = Number(v);
            if (isFinite(n))
                return n;
        }
        return undefined;
    }
}
