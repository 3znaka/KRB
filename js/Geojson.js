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
import { Marker, } from './Marker.js';
import { Marker3D, } from './Marker3D.js';
import { Area3D, } from './Area3D.js';
import { Polyline, } from './Polyline.js';
import { Polygon, } from './Polygon.js';
import { Vector3D, } from './Vector3D.js';
import { Diagram } from './Diagram.js';
import { calculateBreaks, getClassIndex } from './Classification.js';
import { resolveColorRamp, sampleColorRamp } from './ColorRamps.js';
const POINT_ALIASES = {
    'icon': 'iconUrl',
};
const MARKER3D_ALIASES = {
    'model': 'modelUrl',
};
const LINE_ALIASES = {
    'stroke': 'color',
    'stroke-color': 'color',
    'stroke-width': 'width',
    'stroke-opacity': 'opacity',
};
const POLYGON_ALIASES = {
    'fill': 'fillColor',
    'fill-color': 'fillColor',
    'fill-opacity': 'fillOpacity',
    'stroke': 'strokeColor',
    'stroke-color': 'strokeColor',
    'stroke-width': 'strokeWidth',
    'stroke-opacity': 'strokeOpacity',
};
const AREA3D_ALIASES = {
    'model': 'modelUrl',
};
const VECTOR_ALIASES = {
    'stroke': 'color',
    'stroke-color': 'color',
    'stroke-width': 'width',
    'stroke-opacity': 'opacity',
};
const NUMERIC_OPTION_KEYS = new Set([
    'fillOpacity', 'strokeOpacity', 'strokeWidth',
    'width', 'opacity', 'arrowSize',
]);
// =====================================================================
// Expression compiler
// =====================================================================
/**
 * Заменяет одиночный `=` на `===`, не трогая `==`, `===`, `!=`, `!==`,
 * `<=`, `>=`, `=>` и содержимое строк.
 */
function replaceEqualityOutsideStrings(expr) {
    let out = '';
    let i = 0;
    let str = null;
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
            const prev = out[out.length - 1];
            const next = expr[i + 1];
            if (prev === '<' || prev === '>' || prev === '!' || prev === '='
                || next === '=' || next === '>') {
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
}
function interpolate(template, props) {
    return template.replace(/\{([\w.]+)\}/g, (_m, key) => {
        const v = key.includes('.')
            ? key.split('.').reduce((o, k) => (o == null ? undefined : o[k]), props)
            : props[key];
        return v == null ? '' : String(v);
    });
}
/**
 * `field === 'a' || 'b'` → `field === 'a' || field === 'b'`.
 * Трогает только цепочки, целиком состоящие из литералов.
 */
function expandOrChains(expr) {
    const LIT = String.raw `(?:'[^'\\]*(?:\\.[^'\\]*)*'|"[^"\\]*(?:\\.[^"\\]*)*"|\d+(?:\.\d+)?|true|false|null)`;
    const FIELD = String.raw `[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*`;
    const chainRe = new RegExp(`(${FIELD})\\s*===\\s*(${LIT}(?:\\s*\\|\\|\\s*${LIT})+)`, 'g');
    const litRe = new RegExp(LIT, 'g');
    return expr.replace(chainRe, (_m, field, chain) => {
        const lits = chain.match(litRe);
        if (!lits || lits.length < 2)
            return _m;
        return lits.map(lit => `${field} === ${lit}`).join(' || ');
    });
}
// =====================================================================
// Mapbox filter → JS expression
// =====================================================================
/** Top-level: `['==', key, value]` → `(key === value)`. */
function mapboxToJsExpr(node) {
    if (!Array.isArray(node) || node.length === 0) {
        throw new Error('Invalid Mapbox filter (expected non-empty array)');
    }
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
            // New-style: ['in', ['get', 'x'], ['literal', ['a','b']]]
            // Legacy:    ['in', 'x', 'a', 'b']
            const rawValues = (rest.length === 2
                && Array.isArray(rest[1]) && rest[1][0] === 'literal')
                ? rest[1][1]
                : rest.slice(1);
            const ors = rawValues
                .map(v => `${key} === ${mapboxLiteral(v)}`).join(' || ');
            return op === 'in' ? `(${ors})` : `!(${ors})`;
        }
        case 'has': {
            if (rest.length !== 1)
                throw new Error('Mapbox "has" needs 1 arg');
            return `(${mapboxField(rest[0])} !== undefined)`;
        }
        case '!has': {
            if (rest.length !== 1)
                throw new Error('Mapbox "!has" needs 1 arg');
            return `(${mapboxField(rest[0])} === undefined)`;
        }
        case 'all': return rest.length ? `(${rest.map(mapboxToJsExpr).join(' && ')})` : 'true';
        case 'any': return rest.length ? `(${rest.map(mapboxToJsExpr).join(' || ')})` : 'false';
        case 'none': return rest.length ? `!(${rest.map(mapboxToJsExpr).join(' || ')})` : 'true';
        case '!': {
            if (rest.length !== 1)
                throw new Error('Mapbox "!" needs 1 arg');
            return `!(${mapboxToJsExpr(rest[0])})`;
        }
        default:
            throw new Error(`Unsupported Mapbox operator: "${op}"`);
    }
}
/** Операнд в позиции КЛЮЧА (левая часть сравнения). */
function mapboxField(node) {
    if (typeof node === 'string') {
        if (node === '$type')
            return 'geometry';
        if (node === '$id')
            return 'feature.id';
        // Любой другой ключ — bracket access, безопасно для `foo-bar`, `a.b` и т.п.
        return `props[${JSON.stringify(node)}]`;
    }
    if (Array.isArray(node)) {
        const head = node[0];
        if (head === 'get') {
            if (node.length < 2)
                throw new Error('Mapbox "get" needs a key');
            return mapboxField(node[1]);
        }
        if (head === 'geometry-type')
            return 'geometry';
        if (head === 'id')
            return 'feature.id';
    }
    throw new Error(`Unsupported Mapbox field operand: ${JSON.stringify(node)}`);
}
/** Операнд в позиции ЗНАЧЕНИЯ (правая часть сравнения). */
function mapboxLiteral(node) {
    if (typeof node === 'string')
        return JSON.stringify(node);
    if (typeof node === 'number')
        return Number.isFinite(node) ? String(node) : 'null';
    if (typeof node === 'boolean')
        return String(node);
    if (node === null)
        return 'null';
    if (Array.isArray(node)) {
        // ['literal', x] → JSON x; ['get', x] → поле; иначе литеральный массив.
        if (node[0] === 'literal')
            return JSON.stringify(node[1]);
        if (node[0] === 'get')
            return mapboxField(node[1]);
        return JSON.stringify(node);
    }
    throw new Error(`Unsupported Mapbox literal operand: ${JSON.stringify(node)}`);
}
/**
 * Компилирует строку-выражение в предикат.
 * Идентификаторы резолвятся через `props`; глобалы (`Math`, `Number`) —
 * снаружи.
 */
function compileExpressionFilter(expr) {
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
    let fn;
    try {
        fn = new Function('feature', src);
    }
    catch (err) {
        console.warn('GeoJSONLayer: invalid filter expression', expr, err);
        return () => false;
    }
    return (feature) => {
        try {
            return fn(feature);
        }
        catch (err) {
            console.warn('GeoJSONLayer: filter expression threw, treating as false', err);
            return false;
        }
    };
}
function getPath(obj, path) {
    if (!path.includes('.'))
        return obj?.[path];
    let cur = obj;
    for (const part of path.split('.')) {
        if (cur == null)
            return undefined;
        cur = cur[part];
    }
    return cur;
}
function matchFilterValue(actual, expected) {
    if (Array.isArray(expected))
        return expected.some(v => v === actual);
    if (expected === null)
        return actual == null;
    return actual === expected;
}
/**
 * Разрешает путь в объектной форме. Симметрично строковой:
 *   - `geometry` / `geometryType` → feature.geometry.type
 *   - `feature`, `feature.type`, `feature.id`, `feature.geometry.*` → из feature
 *   - `props`, `props.category` → из properties
 *   - иначе → путь в properties (с точками).
 */
function resolveFilterPath(feature, path) {
    const props = feature.properties ?? {};
    const geometryType = feature.geometry?.type ?? null;
    if (path === 'geometry' || path === 'geometryType')
        return geometryType;
    if (path === 'feature')
        return feature;
    if (path === 'props')
        return props;
    if (path.startsWith('feature.')) {
        return getPath(feature, path.slice('feature.'.length));
    }
    if (path.startsWith('props.')) {
        return getPath(props, path.slice('props.'.length));
    }
    return getPath(props, path);
}
function compileObjectFilter(spec) {
    const entries = Object.entries(spec);
    return (feature) => {
        for (const [path, expected] of entries) {
            const actual = resolveFilterPath(feature, path);
            if (!matchFilterValue(actual, expected))
                return false;
        }
        return true;
    };
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
    url = null;
    data = null;
    crs = null;
    tooltipOnHover = false;
    choropleth = null;
    _choroplethBreaks = [];
    _choroplethRamp = null;
    /**
     * Скомпилированный предикат. `null` — фильтра нет.
     * Для установки используйте `setFeatureFilter` — он корректно
     * обновляет `filterSpec` / `filterExpression` и делает `reload()`.
     */
    featureFilter = null;
    /** Исходная объектная спецификация (для UI). */
    filterSpec = null;
    /** Исходное строковое выражение (для UI). */
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
    static fromMapboxFilter(arr) {
        return mapboxToJsExpr(arr);
    }
    constructor(options = {}) {
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
    addTo(map) {
        super.addTo(map);
        if (!this._loaded)
            this._load();
        return this;
    }
    /** Полная перезагрузка: удаляет объекты, сбрасывает флаг, загружает заново. */
    reload() {
        const layer = this;
        const objects = layer._objects ?? [];
        for (const obj of [...objects])
            obj.remove();
        layer._objects = [];
        this._loaded = false;
        if (layer._map)
            this._load();
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
    setFeatureFilter(input) {
        this._applyFilter(input);
        if (this._map && this._loaded)
            this.reload();
        return this;
    }
    /** Меняет декларативный style. При активной карте — `reload()`. */
    setStyle(style) {
        this.style = style;
        if (this._map && this._loaded)
            this.reload();
        return this;
    }
    /** Заменяет данные. `null` — очистить. При активной карте — `reload()`. */
    setData(data) {
        this.data = data;
        if (this._map)
            this.reload();
        else
            this._loaded = false;
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
    setFilter(input) {
        return this.setFeatureFilter(input);
    }
    setDiagram(cfg) {
        this.diagram = cfg;
        if (this._map && this._loaded)
            this.reload();
        return this;
    }
    /**
     * Возвращает текущий фильтр в исходной форме:
     * строковое выражение, объект-спецификация, предикат или `null`.
     */
    getFilter() {
        if (this.filterExpression != null)
            return this.filterExpression;
        if (this.filterSpec != null)
            return this.filterSpec;
        return this.featureFilter;
    }
    /** Заменяет url. При активной карте — `reload()`. */
    setUrl(url) {
        this.url = url;
        if (this._map)
            this.reload();
        else
            this._loaded = false;
        return this;
    }
    /** Добавляет объекты к уже загруженным, не удаляя существующие. */
    addData(data) {
        this._parse(data);
        return this;
    }
    _applyFilter(input) {
        // ── Mapbox-style array → JS expression string ──────────────────
        if (Array.isArray(input)) {
            try {
                const converted = GeoJSONLayer.fromMapboxFilter(input);
                console.debug('GeoJSONLayer: Mapbox filter converted', input, '→', converted);
                input = converted; // теперь строка, дальше обычный путь
            }
            catch (err) {
                console.warn('GeoJSONLayer: cannot convert Mapbox filter. ' +
                    "Use a JS expression string (e.g. \"type = 'city'\") " +
                    'or an object spec (e.g. { type: \'city\' }).', err, input);
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
            this.featureFilter = input;
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
        const spec = input;
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
    async _load() {
        let geojson = null;
        try {
            if (this.data) {
                geojson = this.data;
            }
            else if (this.url) {
                const resp = await fetch(this.url);
                if (!resp.ok)
                    throw new Error(`HTTP ${resp.status}`);
                geojson = await resp.json();
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
        }
        catch (err) {
            console.error('GeoJSONLayer: load/parse error', err);
        }
    }
    _calculateChoroplethBreaks(geojson) {
        if (!this.choropleth)
            return;
        let values = [];
        const processFeature = (f) => {
            if (f.properties) {
                const val = this._evaluateValueExpression(f.properties, this.choropleth.value);
                if (isFinite(val))
                    values.push(val);
            }
        };
        if (geojson.type === 'FeatureCollection') {
            geojson.features.forEach(processFeature);
        }
        else if (geojson.type === 'Feature') {
            processFeature(geojson);
        }
        this._choroplethBreaks = calculateBreaks(values, this.choropleth.classification || 'jenks', this.choropleth.classes || 5);
    }
    // =================================================================
    // Style resolution
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
        }
        catch {
            return NaN;
        }
    }
    _getTooltip(props) {
        // 1. Явный tooltip: функция или шаблон.
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
            // '{name}' — интерполяция; иначе literal HTML для всех features.
            return t.includes('{') ? interpolate(t, props) : t;
        }
        // 2. Deprecated fallback: одно поле из properties.
        if (this.tooltipField) {
            const raw = props[this.tooltipField];
            if (raw != null && raw !== '' && String(raw).includes('{')) {
                return interpolate(String(raw), props);
            }
            if (raw != null && raw !== '')
                return String(raw);
        }
        // 3. Дефолты: props.tooltip / props.description.
        return props.tooltip || props.description || '';
    }
    /** shared (`style.cases`/`style.default`) ← per-type (`style[type].*`). */
    _resolveStyle(props, type) {
        const style = this.style;
        if (!style)
            return null;
        const by = style.by ?? 'category';
        const value = props[by];
        const shared = this._pickStyleLevel(style, value);
        const perType = this._pickStyleLevel(style[type], value);
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
    /**
     * Нормализует alias'ы (`fill` → `fillColor`, `stroke-width` → `width`/…)
     * и приводит числовые канонические ключи к `number`. Canonical побеждает
     * alias; alias удаляется из результата.
     */
    _normalizeStyle(src, aliases) {
        if (!src)
            return null;
        const out = { ...src };
        for (const [alias, canonical] of Object.entries(aliases)) {
            if (out[canonical] === undefined && out[alias] != null) {
                if (NUMERIC_OPTION_KEYS.has(canonical)) {
                    const num = this._asNumber(out[alias]);
                    if (num !== undefined)
                        out[canonical] = num;
                }
                else {
                    out[canonical] = out[alias];
                }
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
            for (const feature of geojson.features) {
                this._addFeature(feature);
            }
        }
        else if (type === 'Feature') {
            this._addFeature(geojson);
        }
        else if (type === 'Point' || type === 'LineString' || type === 'MultiLineString'
            || type === 'Polygon' || type === 'MultiPolygon') {
            this._addFeature({
                type: 'Feature',
                geometry: geojson,
                properties: {},
            });
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
                if (this.vectorToOptions && props.vector === true) {
                    this._addVectorFeature(feature);
                }
                else {
                    this._addPointFeature(feature);
                }
                break;
            case 'LineString':
            case 'MultiLineString':
                if (this.vectorToOptions || props.vector === true) {
                    this._addVectorFeature(feature);
                }
                else {
                    this._addLineFeature(feature);
                }
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
        const coords = geom.coordinates;
        const lonLat = [coords[0], coords[1]];
        const altFromCoords = coords.length >= 3 ? coords[2] : undefined;
        const cb3D = this.point3DToOptions ? this.point3DToOptions(feature, props) : null;
        const is3D = cb3D != null
            || props['3d'] === true
            || props.type === '3d'
            || props.markerType === '3d';
        if (is3D) {
            this._createMarker3D(feature, props, lonLat, altFromCoords, cb3D);
        }
        else {
            const cb = this.pointToOptions ? this.pointToOptions(feature, props) : null;
            this._createMarker(feature, props, lonLat, altFromCoords, cb);
        }
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
        const normStyle = this._normalizeStyle(this._resolveStyle(props, 'point'), POINT_ALIASES);
        const normCb = this._normalizeStyle(cb, POINT_ALIASES);
        const merged = {
            ...defaults,
            ...(normStyle ?? {}),
            ...(normCb ?? {}),
            position: lonLat,
        };
        const marker = new Marker(merged);
        this.add(marker);
        if (this.onEachFeature)
            this.onEachFeature(feature, marker);
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
        const normStyle = this._normalizeStyle(this._resolveStyle(props, 'marker3D'), MARKER3D_ALIASES);
        const normCb = this._normalizeStyle(cb, MARKER3D_ALIASES);
        const merged = {
            ...defaults,
            ...(normStyle ?? {}),
            ...(normCb ?? {}),
            position: lonLat,
        };
        const marker = new Marker3D(merged);
        this.add(marker);
        if (this.onEachFeature)
            this.onEachFeature(feature, marker);
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
            const cb = this.lineToOptions ? this.lineToOptions(feature, props) : null;
            const defaults = {
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
            const normStyle = this._normalizeStyle(this._resolveStyle(props, 'line'), LINE_ALIASES);
            const normCb = this._normalizeStyle(cb, LINE_ALIASES);
            const merged = {
                ...defaults,
                ...(normStyle ?? {}),
                ...(normCb ?? {}),
                positions: coords,
            };
            const polyline = new Polyline(merged);
            this.add(polyline);
            if (this.onEachFeature)
                this.onEachFeature(feature, polyline);
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
            const cb3D = this.polygon3DToOptions ? this.polygon3DToOptions(feature, props) : null;
            const is3D = cb3D != null
                || props['3d'] === true
                || props.type === '3d'
                || props.markerType === '3d';
            if (is3D) {
                this._createArea3D(feature, props, rings, cb3D);
                // Картодиаграмму на Area3D пока не навешиваем: другая геометрия,
                // другой смысл fitToPolygon.
            }
            else {
                const cb = this.polygonToOptions ? this.polygonToOptions(feature, props) : null;
                const polygon = this._createPolygon(feature, props, rings, cb);
                if (polygon && (this.diagram || this.diagramToOptions)) {
                    this._addCartodiagram(feature, props, polygon);
                }
            }
        }
    }
    _addCartodiagram(feature, props, polygon) {
        const baseOpts = this.diagramToOptions
            ? this.diagramToOptions(feature, props)
            : this._diagramFromConfig(feature, props);
        if (!baseOpts)
            return;
        const center = polygon.getVisualCenter();
        if (!center)
            return;
        const diagram = new Diagram({
            ...baseOpts,
            position: center,
            crs: 'EPSG:4326',
            parentPolygon: polygon,
            fitToPolygon: baseOpts.fitToPolygon ?? this.diagram?.fitToPolygon ?? true,
            minScreenScale: baseOpts.minScreenScale ?? this.diagram?.minScreenScale ?? 0.5,
            clusterable: false,
        });
        this.add(diagram);
        if (this.onEachDiagram)
            this.onEachDiagram(feature, diagram);
    }
    _diagramFromConfig(feature, props) {
        const cfg = this.diagram;
        if (!cfg?.fields?.length)
            return null;
        const data = cfg.fields
            .map(key => {
            const v = Number(props[key]);
            if (!isFinite(v))
                return null;
            return {
                label: cfg.labelField ? String(props[cfg.labelField] ?? key) : key,
                value: v,
                color: cfg.colorMap?.[key],
            };
        })
            .filter((d) => d !== null);
        if (!data.length)
            return null;
        // ── Tooltip: сначала явный, иначе соберём из данных диаграммы. ──
        let tooltip = this._getTooltip(props);
        if (!tooltip) {
            tooltip = data.map(d => `${d.color ? `<span style="display:inline-block;width:10px;height:10px;` +
                `background:${d.color};margin-right:6px;border-radius:2px;"></span>` : ''}` +
                `${d.label}: <b>${d.value}</b>`).join('<br>');
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
    _createPolygon(feature, props, rings, cb) {
        // Вычисляем цвет, если включена картограмма
        let choroplethColor;
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
        const normStyle = this._normalizeStyle(this._resolveStyle(props, 'polygon'), POLYGON_ALIASES);
        const normCb = this._normalizeStyle(cb, POLYGON_ALIASES);
        const merged = {
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
        if (this.onEachFeature)
            this.onEachFeature(feature, polygon);
        return polygon;
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
        const normStyle = this._normalizeStyle(this._resolveStyle(props, 'area3D'), AREA3D_ALIASES);
        const normCb = this._normalizeStyle(cb, AREA3D_ALIASES);
        const merged = {
            ...defaults,
            ...(normStyle ?? {}),
            ...(normCb ?? {}),
            rings,
        };
        const area = new Area3D(merged);
        this.add(area);
        if (this.onEachFeature)
            this.onEachFeature(feature, area);
    }
    // =================================================================
    // Vector3D
    // =================================================================
    _addVectorFeature(feature) {
        const geom = feature.geometry;
        const props = feature.properties ?? {};
        let coordSets;
        if (geom.type === 'LineString')
            coordSets = [geom.coordinates];
        else if (geom.type === 'MultiLineString')
            coordSets = geom.coordinates;
        else
            coordSets = [null];
        for (const coords of coordSets) {
            const cb = this.vectorToOptions ? this.vectorToOptions(feature, props) : null;
            const defaultPositions = coords ? this._toVectorPositions(coords) : undefined;
            const positions = cb?.positions ?? defaultPositions;
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
            const normStyle = this._normalizeStyle(this._resolveStyle(props, 'vector'), VECTOR_ALIASES);
            const normCb = this._normalizeStyle(cb, VECTOR_ALIASES);
            const merged = {
                ...defaults,
                ...(normStyle ?? {}),
                ...(normCb ?? {}),
                positions,
            };
            const vector = new Vector3D(merged);
            this.add(vector);
            if (this.onEachFeature)
                this.onEachFeature(feature, vector);
        }
    }
    // =================================================================
    // Внутренние парсеры / утилиты
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
            const parts = raw.split(',').map(Number);
            if (parts.length >= 1 && parts.length <= 3 && parts.every(v => !isNaN(v))) {
                return parts;
            }
        }
        return null;
    }
    _parseIconSize(raw) {
        const arr = this._parseSize(raw);
        if (!arr || arr.length !== 2)
            return null;
        return [arr[0], arr[1]];
    }
    _parseSizeSpec(raw) {
        const arr = this._parseSize(raw);
        if (!arr || arr.length < 1 || arr.length > 3)
            return null;
        return arr;
    }
    _parsePair(raw) {
        if (!raw)
            return null;
        if (Array.isArray(raw) && raw.length === 2) {
            const [a, b] = raw;
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
    _parseTriple(raw) {
        if (!raw)
            return null;
        if (Array.isArray(raw) && raw.length === 3) {
            const [a, b, c] = raw;
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
