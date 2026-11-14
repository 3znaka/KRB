export const POINT_ALIASES = { icon: 'iconUrl' };
export const MARKER3D_ALIASES = { model: 'modelUrl' };
export const LINE_ALIASES = {
    stroke: 'color', 'stroke-color': 'color',
    'stroke-width': 'width', 'stroke-opacity': 'opacity',
};
export const POLYGON_ALIASES = {
    fill: 'fillColor', 'fill-color': 'fillColor', 'fill-opacity': 'fillOpacity',
    stroke: 'strokeColor', 'stroke-color': 'strokeColor',
    'stroke-width': 'strokeWidth', 'stroke-opacity': 'strokeOpacity',
};
export const AREA3D_ALIASES = { model: 'modelUrl' };
export const VECTOR_ALIASES = {
    ...LINE_ALIASES,
    'arrow-size': 'arrowSize',
    'arrow-size-mode': 'arrowSizeMode',
    'height-scale': 'heightScale',
};
const NUMERIC_OPTION_KEYS = new Set([
    'fillOpacity', 'strokeOpacity', 'strokeWidth', 'width', 'opacity', 'arrowSize',
    'heightScale', 'simplifyTolerance', 'simplifyZoomBucket',
]);
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
export const interpolate = (tpl, props) => tpl.replace(/\{([\w.]+)\}/g, (_m, key) => {
    const v = key.includes('.')
        ? key.split('.').reduce((o, k) => (o == null ? undefined : o[k]), props)
        : props[key];
    return v == null ? '' : String(v);
});
const expandOrChains = (expr) => {
    const LIT = String.raw `(?:'[^'\\]*(?:\\.[^'\\]*)*'|"[^"\\]*(?:\\.[^"\\]*)*"|\d+(?:\.\d+)?|true|false|null)`;
    const FIELD = String.raw `[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*`;
    const chainRe = new RegExp(`(${FIELD})\\s*===\\s*(${LIT}(?:\\s*\\|\\|\\s*${LIT})+)`, 'g');
    const litRe = new RegExp(LIT, 'g');
    return expr.replace(chainRe, (_m, field, chain) => {
        const lits = chain.match(litRe);
        return lits && lits.length >= 2 ? lits.map(l => `${field} === ${l}`).join(' || ') : _m;
    });
};
export const compileExpressionFilter = (expr) => {
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
export const mapboxToJsExpr = (node) => {
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
                ? rest[1][1] : rest.slice(1);
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
export const compileObjectFilter = (spec) => {
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
// Color helpers
// =====================================================================
export const PALETTE_3D_FALLBACK = [
    '#3498db', '#e74c3c', '#2ecc71', '#f39c12',
    '#9b59b6', '#1abc9c', '#e67e22', '#34495e',
];
export const resolveColorMapValue = (spec, value) => {
    if (!spec)
        return undefined;
    if (typeof spec === 'string')
        return spec;
    for (const r of spec) {
        if ((r.min == null || value >= r.min) && (r.max == null || value < r.max))
            return r.color;
    }
    return undefined;
};
// =====================================================================
// Style helpers (free functions, no `this`)
// =====================================================================
export function pickStyleLevel(cfg, value) {
    if (!cfg)
        return null;
    if (value != null && cfg.cases) {
        const c = cfg.cases[value];
        if (c)
            return c;
    }
    return cfg.default ?? null;
}
export function resolveStyle(style, props, type) {
    if (!style)
        return null;
    const value = props[style.by ?? 'category'];
    const shared = pickStyleLevel(style, value);
    const perType = pickStyleLevel(style[type], value);
    if (!shared && !perType)
        return null;
    if (!shared)
        return perType;
    if (!perType)
        return shared;
    return { ...shared, ...perType };
}
export function normalizeStyle(src, aliases) {
    if (!src)
        return null;
    const out = { ...src };
    for (const [alias, canonical] of Object.entries(aliases)) {
        if (out[canonical] === undefined && out[alias] != null) {
            out[canonical] = NUMERIC_OPTION_KEYS.has(canonical)
                ? asNumber(out[alias]) ?? out[alias]
                : out[alias];
        }
        delete out[alias];
    }
    return out;
}
export function interpolateStyle(style, props) {
    if (!style || typeof style !== 'object')
        return style;
    const out = {};
    for (const [k, v] of Object.entries(style)) {
        out[k] = (typeof v === 'string' && v.includes('{')) ? interpolate(v, props) : v;
    }
    return out;
}
export function evaluateValueExpression(props, exprOrFn) {
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
export function getTitle(titleField, props) {
    if (titleField) {
        const v = props[titleField];
        if (v != null && v !== '')
            return String(v);
    }
    return props.title || props.name || '';
}
export function getTooltip(tooltip, tooltipField, props) {
    if (typeof tooltip === 'function') {
        try {
            const out = tooltip(props);
            if (out != null)
                return String(out);
        }
        catch (e) {
            console.warn('GeoJSONLayer: tooltip callback threw', e);
        }
    }
    else if (typeof tooltip === 'string' && tooltip) {
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
export function parseSize(raw) {
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
export function parseIconSize(raw) {
    const a = parseSize(raw);
    return a && a.length === 2 ? [a[0], a[1]] : null;
}
export function parseSizeSpec(raw) {
    const a = parseSize(raw);
    return a && a.length >= 1 && a.length <= 3 ? a : null;
}
export function parsePair(raw) {
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
export function parseTriple(raw) {
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
export function asNumber(v) {
    if (typeof v === 'number' && isFinite(v))
        return v;
    if (typeof v === 'string' && v.trim() !== '') {
        const n = Number(v);
        if (isFinite(n))
            return n;
    }
    return undefined;
}
