// VectorTileWorkerCode.js
/**
 * Модуль генерации кода воркера векторных тайлов.
 * Использует стили и порядок отрисовки из vectorTileDefaults.js.
 */

import { DEFAULT_STYLES, LAYER_RENDER_ORDER } from './vectorTileDefaults.js';

/** Преобразует строку в base64 (для data: URL). */
export function stringToBase64(str) {
    const bytes = new TextEncoder().encode(str);
    let binary = '';
    for (let i = 0; i < bytes.length; i++) {
        binary += String.fromCharCode(bytes[i]);
    }
    return btoa(binary);
}

/** Генерирует код модульного воркера с внедрёнными data: URL библиотек. */
export function createWorkerCode(tpbDataURL, earcutDataURL) {
    return `
let VectorTile, Protobuf, earcut;

async function init() {
    try {
        const [vecModule, earModule] = await Promise.all([
            import('${tpbDataURL}'),
            import('${earcutDataURL}')
        ]);
        VectorTile = vecModule.VectorTile;
        Protobuf = vecModule.Protobuf;
        earcut = earModule.default;
        self.onmessage = onMessage;
    } catch (err) {
        self.postMessage({ error: 'Worker init failed: ' + err.message });
    }
}

init();

function onMessage(e) {
    const msg = e.data;
    if (msg.type === 'config') {
        workerStyles = msg.styles || DEFAULT_STYLES;
        return;
    }
    if (msg.type === 'identify') {
        const { id, buffer, z, x, y, tileSize, maxMerc, localX, localZ,
                tolerance, continuousZoom } = msg;
        try {
            const tile = new VectorTile(new Protobuf(buffer));
            const result = identifyAt(
                tile, z, x, y, tileSize, maxMerc, localX, localZ, tolerance,
                continuousZoom ?? z
            );
            self.postMessage({ id, result });
        } catch (err) {
            self.postMessage({ id, error: err.message });
        }
        return;
    }
    if (msg.type === 'process') {
        const {
            id, buffer, z, x, y, tileSize, maxMerc, is3d,
            visibleLayers, buildingEdges,
            continuousZoom,
            exclusionPolygons = [], exclusionLayers = [],
            maxTextPointsPerTile = 300,
            maxTextLinesPerTile = 30
        } = msg;
        try {
            const tile = new VectorTile(new Protobuf(buffer));
            const result = processTile(
                tile, z, x, y, tileSize, maxMerc, is3d,
                visibleLayers, buildingEdges,
                exclusionPolygons, exclusionLayers,
                maxTextPointsPerTile, maxTextLinesPerTile,
                continuousZoom ?? z
            );
            const transferList = [];
            const payload = { id, result };
            collectTransferables(payload, transferList);
            self.postMessage(payload, transferList);
        } catch (err) {
            self.postMessage({ id, error: err.message });
        }
    }
}

const DEFAULT_STYLES = ${JSON.stringify(DEFAULT_STYLES)};
const LAYER_RENDER_ORDER = ${JSON.stringify(LAYER_RENDER_ORDER)};
let workerStyles = DEFAULT_STYLES;

const CARRIER_ONLY_LINE_LAYERS = new Set(['transportation_name', 'water_name']);

// Casing (обводка) дорог. В style.json casing-слои идут отдельными
// записями (highway-*-casing, bridge-*-casing, tunnel-*-casing);
// здесь — упрощение: +4 px к толщине fill для дорог вне туннеля.
const TRANSPORTATION_CASING = {
    motorway:  { color: 0xe9ac77, extraWidth: 2 },
    trunk:     { color: 0xe9ac77, extraWidth: 2 },
    primary:   { color: 0xe9ac77, extraWidth: 2 },
    secondary: { color: 0xe9ac77, extraWidth: 2 },
    tertiary:  { color: 0xe9ac77, extraWidth: 2 },
    minor:     { color: 0xcfcdca, extraWidth: 1.75 },
    service:   { color: 0xcfcdca, extraWidth: 1.75 },
    track:     { color: 0xcfcdca, extraWidth: 1.75 }
};

function collectTransferables(obj, list) {
    if (obj instanceof ArrayBuffer) {
        list.push(obj);
    } else if (ArrayBuffer.isView(obj)) {
        list.push(obj.buffer);
    } else if (Array.isArray(obj)) {
        obj.forEach(item => collectTransferables(item, list));
    } else if (obj && typeof obj === 'object') {
        Object.values(obj).forEach(val => collectTransferables(val, list));
    }
}

// ════════════════════════════════════════════════════════════════════════
// РЕЗОЛВЕРЫ СПЕК
// ════════════════════════════════════════════════════════════════════════

function resolveValue(spec, props, zoom, geomType) {
    if (spec === null || spec === undefined) return undefined;
    if (typeof spec !== 'object') return spec;
    if (Array.isArray(spec)) return spec;
    switch (spec.type) {
        case 'match':        return resolveMatch(spec, props, zoom, geomType);
        case 'zoom':         return resolveZoom(spec, zoom);
        case 'step':         return resolveStep(spec, zoom);
        case 'field':        return resolveField(spec, props, zoom, geomType);
        case 'coalesce':     return resolveCoalesce(spec, props, zoom, geomType);
        case 'levels':       return resolveLevels(spec, props);
        case 'geometryType': {
            const sub = geomType !== undefined ? spec.values[geomType] : undefined;
            const picked = sub !== undefined ? sub : spec._default;
            return resolveValue(picked, props, zoom, geomType);
        }
        default:             return undefined;
    }
}

function resolveMatch(spec, props, zoom, geomType) {
    const keys = Array.isArray(spec.by) ? spec.by : [spec.by];
    for (const k of keys) {
        const v = props[k];
        if (v === undefined || v === null) continue;
        let found = spec.values[v];
        if (found !== undefined) return resolveValue(found, props, zoom, geomType);
        const sv = String(v);
        if (sv in spec.values) return resolveValue(spec.values[sv], props, zoom, geomType);
        if (v === true && '1' in spec.values) return resolveValue(spec.values['1'], props, zoom, geomType);
    }
    return resolveValue(spec.values._default, props, zoom, geomType);
}

function resolveZoom(spec, zoom) {
    const stops = spec.stops;
    if (!stops || stops.length === 0) return undefined;
    if (zoom <= stops[0][0]) return stops[0][1];
    if (zoom >= stops[stops.length - 1][0]) return stops[stops.length - 1][1];
    for (let i = 0; i < stops.length - 1; i++) {
        const z0 = stops[i][0], v0 = stops[i][1];
        const z1 = stops[i + 1][0], v1 = stops[i + 1][1];
        if (zoom >= z0 && zoom <= z1) {
            const t = (zoom - z0) / (z1 - z0);
            return lerpValue(v0, v1, t);
        }
    }
    return stops[stops.length - 1][1];
}

function lerpValue(a, b, t) {
    if (typeof a === 'number' && typeof b === 'number') {
        if (Number.isInteger(a) && Number.isInteger(b) && a > 255 && b > 255) {
            const ar = (a >> 16) & 0xff, ag = (a >> 8) & 0xff, ab = a & 0xff;
            const br = (b >> 16) & 0xff, bg = (b >> 8) & 0xff, bb = b & 0xff;
            const r = Math.round(ar + (br - ar) * t);
            const g = Math.round(ag + (bg - ag) * t);
            const bl = Math.round(ab + (bb - ab) * t);
            return (r << 16) | (g << 8) | bl;
        }
        return a + (b - a) * t;
    }
    return t < 0.5 ? a : b;
}

function resolveStep(spec, zoom) {
    const stops = spec.stops;
    if (!stops || stops.length === 0) return spec.default;
    let result = spec.default;
    for (const pair of stops) {
        if (zoom >= pair[0]) result = pair[1];
        else break;
    }
    return result;
}

function resolveField(spec, props, zoom, geomType) {
    for (const k of spec.keys) {
        const v = props[k];
        if (v === undefined || v === null || v === '') continue;
        const n = parseFloat(v);
        if (!isNaN(n) && String(n) === String(v).trim()) return n;
        return v;
    }
    return spec.fallback !== undefined ? resolveValue(spec.fallback, props, zoom, geomType) : undefined;
}

function resolveCoalesce(spec, props, zoom, geomType) {
    for (const sub of spec.of) {
        const v = resolveValue(sub, props, zoom, geomType);
        if (v !== undefined && v !== null) return v;
    }
    return undefined;
}

function resolveLevels(spec, props) {
    const lvl = parseInt(props['building:levels'], 10);
    if (!isNaN(lvl) && lvl > 0) return lvl * (spec.multiplier || 3);
    return 0;
}

function resolveColor(spec, props, zoom, geomType) {
    const v = resolveValue(spec, props, zoom, geomType);
    if (v === undefined || v === null) return null;
    if (typeof v === 'number') return v;
    if (typeof v === 'string') {
        if (v.charAt(0) === '#') return parseInt(v.slice(1), 16);
        if (v.startsWith('0x')) return parseInt(v.slice(2), 16);
    }
    return null;
}

function resolveNumber(spec, props, zoom, fallback, geomType) {
    const v = resolveValue(spec, props, zoom, geomType);
    if (v === undefined || v === null) return fallback;
    const n = typeof v === 'number' ? v : parseFloat(v);
    return isNaN(n) ? fallback : n;
}

function resolveString(spec, props, zoom, fallback, geomType) {
    const v = resolveValue(spec, props, zoom, geomType);
    if (v === undefined || v === null) return fallback;
    return String(v);
}

function resolveArray(spec, props, zoom, geomType) {
    const v = resolveValue(spec, props, zoom, geomType);
    return Array.isArray(v) ? v : undefined;
}

function resolveHeight(spec, props, zoom, geomType) {
    const v = resolveValue(spec, props, zoom, geomType);
    if (v === undefined || v === null) return 0;
    const n = typeof v === 'number' ? v : parseFloat(v);
    return isNaN(n) ? 0 : n;
}

/**
 * Пересчитывает dash из «пикселей стиля» в world-units LineMaterial.
 */
function scaleDash(dashPx, tileSize, z, continuousZoom) {
    if (!dashPx || !Array.isArray(dashPx) || dashPx.length < 2) return null;
    const worldSize = tileSize * Math.pow(2, z);
    const worldPerPx = worldSize / (256 * Math.pow(2, continuousZoom));
    const DASH_MULTIPLIER = 2;
    return [
        dashPx[0] * worldPerPx * DASH_MULTIPLIER,
        dashPx[1] * worldPerPx * DASH_MULTIPLIER
    ];
}

// ════════════════════════════════════════════════════════════════════════
// РЕЗОЛВЕР ФИЛЬТРОВ
// ════════════════════════════════════════════════════════════════════════

function resolveFilter(spec, feature) {
    if (!spec) return true;
    try {
        return evalFilter(spec, feature);
    } catch (e) {
        return true;
    }
}

function evalFilter(spec, feature) {
    if (!spec || typeof spec !== 'object') return true;
    const props = feature.properties || {};
    switch (spec.type) {
        case 'in':
            return Array.isArray(spec.values) && spec.values.includes(props[spec.key]);
        case 'eq':
            return props[spec.key] === spec.value;
        case 'exists':
            return props[spec.key] !== undefined && props[spec.key] !== null;
        case 'gt':  return Number(props[spec.key]) > Number(spec.value);
        case 'gte': return Number(props[spec.key]) >= Number(spec.value);
        case 'lt':  return Number(props[spec.key]) < Number(spec.value);
        case 'lte': return Number(props[spec.key]) <= Number(spec.value);
        case 'geometry':
            return Array.isArray(spec.in) && spec.in.includes(feature.type);
        case 'any':
            return Array.isArray(spec.of) && spec.of.some(s => evalFilter(s, feature));
        case 'all':
            return Array.isArray(spec.of) && spec.of.every(s => evalFilter(s, feature));
        case 'not':
            return !evalFilter(spec.of, feature);
        default:
            return true;
    }
}

// ════════════════════════════════════════════════════════════════════════
// ГЕОМЕТРИЧЕСКИЕ УТИЛИТЫ
// ════════════════════════════════════════════════════════════════════════

function toWorldCoords(feature, z, xSlippy, ySlippy, tileSize, maxMerc, isLine = false) {
    const minLen = isLine ? 2 : 3;
    const originZ = -maxMerc + ySlippy * tileSize;
    const originX = xSlippy * tileSize - maxMerc;
    const centerX = originX + tileSize / 2;
    const centerZ = originZ + tileSize / 2;
    const geom = feature.loadGeometry();
    
    if (isLine) {
        const resultRings = [];
        for (const line of geom) {
            const clippedSegments = clipLineToTile(line.map(p => ({ x: p.x, y: p.y })), 4095);
            for (const seg of clippedSegments) {
                if (seg.length >= minLen) {
                    resultRings.push(seg.map(p => ({
                        x: originX + (p.x / 4095) * tileSize - centerX,
                        z: originZ + (p.y / 4095) * tileSize - centerZ
                    })));
                }
            }
        }
        return resultRings;
    } else {
        return geom
            .map(ring => clipRingToTile(ring.map(p => ({ x: p.x, y: p.y })), 4095))
            .filter(ring => ring.length >= minLen)
            .map(ring => ring.map(p => ({
                x: originX + (p.x / 4095) * tileSize - centerX,
                z: originZ + (p.y / 4095) * tileSize - centerZ
            })));
    }
}

// Отсечение линий по границам тайла (Лянга-Барски).
// Возвращает массив кусков линии. Разрывы обрабатываются как отдельные куски.
function clipLineToTile(line, size) {
    if (!line || line.length < 2) return [];
    const result = [];
    let currentSegment = [];

    for (let i = 0; i < line.length - 1; i++) {
        const p1 = line[i];
        const p2 = line[i + 1];
        
        const clipped = clipSegment(p1, p2, 0, size, 0, size);
        if (clipped) {
            const [cp1, cp2] = clipped;
            if (currentSegment.length > 0) {
                const last = currentSegment[currentSegment.length - 1];
                if (Math.abs(last.x - cp1.x) < 1e-5 && Math.abs(last.y - cp1.y) < 1e-5) {
                    currentSegment.push(cp2);
                } else {
                    if (currentSegment.length >= 2) result.push(currentSegment);
                    currentSegment = [cp1, cp2];
                }
            } else {
                currentSegment = [cp1, cp2];
            }
        } else {
            if (currentSegment.length >= 2) result.push(currentSegment);
            currentSegment = [];
        }
    }
    if (currentSegment.length >= 2) result.push(currentSegment);
    return result;
}

function clipSegment(p1, p2, xmin, xmax, ymin, ymax) {
    let t0 = 0, t1 = 1;
    const dx = p2.x - p1.x;
    const dy = p2.y - p1.y;

    const p = [-dx, dx, -dy, dy];
    const q = [p1.x - xmin, xmax - p1.x, p1.y - ymin, ymax - p1.y];

    for (let i = 0; i < 4; i++) {
        if (p[i] === 0) {
            if (q[i] < 0) return null;
        } else {
            const r = q[i] / p[i];
            if (p[i] < 0) {
                if (r > t1) return null;
                if (r > t0) t0 = r;
            } else {
                if (r < t0) return null;
                if (r < t1) t1 = r;
            }
        }
    }
    return [
        { x: p1.x + t0 * dx, y: p1.y + t0 * dy },
        { x: p1.x + t1 * dx, y: p1.y + t1 * dy }
    ];
}

// Отсечение полигонов (Сазерленда-Ходжмана) - только для geomType === 3.
function clipRingToTile(ring, size) {
    if (!ring || ring.length === 0) return [];
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (const p of ring) {
        if (p.x < minX) minX = p.x;
        if (p.x > maxX) maxX = p.x;
        if (p.y < minY) minY = p.y;
        if (p.y > maxY) maxY = p.y;
    }
    if (minX >= 0 && maxX <= size && minY >= 0 && maxY <= size) return ring;

    const edges = [
        { axis: 'x', val: 0, inside: p => p.x >= 0 },
        { axis: 'x', val: size, inside: p => p.x <= size },
        { axis: 'y', val: 0, inside: p => p.y >= 0 },
        { axis: 'y', val: size, inside: p => p.y <= size }
    ];
    let output = ring;
    for (const edge of edges) {
        const input = output;
        output = [];
        if (input.length === 0) break;
        for (let i = 0; i < input.length; i++) {
            const curr = input[i];
            const prev = input[(i + input.length - 1) % input.length];
            const currInside = edge.inside(curr);
            const prevInside = edge.inside(prev);
            if (currInside) {
                if (!prevInside) output.push(intersect(prev, curr, edge));
                output.push(curr);
            } else if (prevInside) {
                output.push(intersect(prev, curr, edge));
            }
        }
    }
    return output;
}

function intersect(p1, p2, edge) {
    const axis = edge.axis, val = edge.val;
    const other = axis === 'x' ? 'y' : 'x';
    const t = (val - p1[axis]) / (p2[axis] - p1[axis]);
    const pt = { x: 0, y: 0 };
    pt[axis] = val;
    pt[other] = p1[other] + t * (p2[other] - p1[other]);
    return pt;
}

function dedupRing(ring, eps) {
    if (ring.length <= 1) return ring;
    const result = [ring[0]];
    for (let i = 1; i < ring.length; i++) {
        const prev = result[result.length - 1];
        const curr = ring[i];
        if (Math.abs(curr.x - prev.x) > eps || Math.abs(curr.z - prev.z) > eps) result.push(curr);
    }
    if (result.length > 2) {
        const first = result[0], last = result[result.length - 1];
        if (Math.abs(last.x - first.x) <= eps && Math.abs(last.z - first.z) <= eps) result.pop();
    }
    return result;
}

function ringArea(ring) {
    let area = 0;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
        area += ring[j].x * ring[i].z - ring[i].x * ring[j].z;
    }
    return area;
}

function orientRing(ring, ccw) {
    const area = ringArea(ring);
    if ((area > 0) === ccw) return ring.slice().reverse();
    return ring;
}

function isVertexOnTileBoundary(x, z, halfTile, eps) {
    return Math.abs(Math.abs(x) - halfTile) < eps ||
           Math.abs(Math.abs(z) - halfTile) < eps;
}

function isEdgeOnTileBoundary(x1, z1, x2, z2, halfTile, eps) {
    const onXPlus1  = Math.abs(x1 - halfTile)  < eps;
    const onXMinus1 = Math.abs(x1 + halfTile)  < eps;
    const onZPlus1  = Math.abs(z1 - halfTile)  < eps;
    const onZMinus1 = Math.abs(z1 + halfTile)  < eps;
    const onXPlus2  = Math.abs(x2 - halfTile)  < eps;
    const onXMinus2 = Math.abs(x2 + halfTile)  < eps;
    const onZPlus2  = Math.abs(z2 - halfTile)  < eps;
    const onZMinus2 = Math.abs(z2 + halfTile)  < eps;
    if (onXPlus1 && onXPlus2)   return true;
    if (onXMinus1 && onXMinus2) return true;
    if (onZPlus1 && onZPlus2)   return true;
    if (onZMinus1 && onZMinus2) return true;
    return false;
}

function triangulatePolygon(outer, holes, eps) {
    if (outer.length < 3) return null;
    const cleanHoles = holes.filter(h => h.length >= 3);
    const allRings = [outer, ...cleanHoles];
    const vertices = [];
    const holeIndices = [];
    allRings.forEach((ring, idx) => {
        if (idx > 0) holeIndices.push(vertices.length / 2);
        ring.forEach(pt => vertices.push(pt.x, pt.z));
    });
    const indices = earcut(vertices, holeIndices.length > 0 ? holeIndices : null, 2);
    if (!indices || indices.length === 0) return null;
    return { vertices, indices };
}

function pushTriangle(positions, normals, ax, ay, az, bx, by, bz, cx, cy, cz, nx, ny, nz) {
    const ux = bx - ax, uy = by - ay, uz = bz - az;
    const vx = cx - ax, vy = cy - ay, vz = cz - az;
    const crx = uy * vz - uz * vy;
    const cry = uz * vx - ux * vz;
    const crz = ux * vy - uy * vx;
    if (crx * nx + cry * ny + crz * nz < 0) {
        positions.push(ax, ay, az, cx, cy, cz, bx, by, bz);
    } else {
        positions.push(ax, ay, az, bx, by, bz, cx, cy, cz);
    }
    for (let i = 0; i < 3; i++) normals.push(nx, ny, nz);
}

function extrudeBuilding(rings, height, minHeight = 0, eps, includeEdges = true, halfTile = 0) {
    if (!rings || rings.length === 0 || height <= 0) return null;
    const cleaned = rings.map(r => dedupRing(r, eps)).filter(r => r.length >= 3);
    if (cleaned.length === 0) return null;
    const checkBoundary = halfTile > 0;
    const boundaryEps = Math.max(eps, halfTile * 1e-4);
    const validRings = [];
    for (const ring of cleaned) {
        const area = ringArea(ring);
        if (Math.abs(area) < 1e-9) continue;
        validRings.push({ ring, area });
    }
    if (validRings.length === 0) return null;
    let posCount = 0, negCount = 0;
    for (const entry of validRings) {
        if (entry.area > 0) posCount++; else negCount++;
    }
    const outerSign = posCount >= negCount ? 1 : -1;
    const polygons = [];
    for (const entry of validRings) {
        const isOuter = Math.sign(entry.area) === outerSign;
        if (isOuter) polygons.push({ outer: entry.ring, holes: [] });
        else if (polygons.length > 0) polygons[polygons.length - 1].holes.push(entry.ring);
        else polygons.push({ outer: entry.ring, holes: [] });
    }
    if (polygons.length === 0) return null;
    const positions = [];
    const normals = [];
    const edges = [];
    const sharpCos = Math.cos(15 * Math.PI / 180);
    for (const poly of polygons) {
        const outer = orientRing(poly.outer, false);
        const holes = poly.holes.map(h => orientRing(h, true));
        const triData = triangulatePolygon(outer, holes, eps);
        if (!triData) continue;
        const vertices = triData.vertices;
        const indices = triData.indices;
        for (let i = 0; i < indices.length; i += 3) {
            const a = indices[i], b = indices[i + 1], c = indices[i + 2];
            const ax = vertices[a * 2], az = vertices[a * 2 + 1];
            const bx = vertices[b * 2], bz = vertices[b * 2 + 1];
            const cx = vertices[c * 2], cz = vertices[c * 2 + 1];
            pushTriangle(positions, normals,
                ax, height, az, bx, height, bz, cx, height, cz, 0, 1, 0);
        }
        if (minHeight > 0) {
            for (let i = 0; i < indices.length; i += 3) {
                const a = indices[i], b = indices[i + 1], c = indices[i + 2];
                const ax = vertices[a * 2], az = vertices[a * 2 + 1];
                const bx = vertices[b * 2], bz = vertices[b * 2 + 1];
                const cx = vertices[c * 2], cz = vertices[c * 2 + 1];
                pushTriangle(positions, normals,
                    ax, minHeight, az, bx, minHeight, bz, cx, minHeight, cz, 0, -1, 0);
            }
        }
        for (const ring of [outer, ...holes]) {
            const n = ring.length;
            for (let i = 0; i < n; i++) {
                const p0 = ring[i];
                const p1 = ring[(i + 1) % n];
                const dx = p1.x - p0.x;
                const dz = p1.z - p0.z;
                const len = Math.hypot(dx, dz);
                if (len < eps) continue;
                const nx = dz / len;
                const nz = -dx / len;
                const onBoundary = checkBoundary &&
                    isEdgeOnTileBoundary(p0.x, p0.z, p1.x, p1.z, halfTile, boundaryEps);
                if (!onBoundary) {
                    pushTriangle(positions, normals,
                        p0.x, minHeight, p0.z, p1.x, minHeight, p1.z,
                        p1.x, height, p1.z, nx, 0, nz);
                    pushTriangle(positions, normals,
                        p0.x, minHeight, p0.z, p1.x, height, p1.z,
                        p0.x, height, p0.z, nx, 0, nz);
                }
                if (includeEdges) {
                    if (!onBoundary) {
                        edges.push(p0.x, height, p0.z, p1.x, height, p1.z);
                        if (minHeight > 0) edges.push(p0.x, minHeight, p0.z, p1.x, minHeight, p1.z);
                    }
                    const p2 = ring[(i + 2) % n];
                    const dx2 = p2.x - p1.x;
                    const dz2 = p2.z - p1.z;
                    const len2 = Math.hypot(dx2, dz2);
                    if (len2 > eps && (dx * dx2 + dz * dz2) / (len * len2) < sharpCos) {
                        const cornerOnBoundary = checkBoundary &&
                            isVertexOnTileBoundary(p1.x, p1.z, halfTile, boundaryEps);
                        if (!cornerOnBoundary) edges.push(p1.x, minHeight, p1.z, p1.x, height, p1.z);
                    }
                }
            }
        }
    }
    if (positions.length === 0) return null;
    return {
        positions: new Float32Array(positions),
        normals: new Float32Array(normals),
        edgePositions: (includeEdges && edges.length) ? new Float32Array(edges) : null
    };
}

function createLinePositions(rings) {
    const pts = [];
    for (const ring of rings) {
        if (!ring || ring.length < 2) continue;
        for (const pt of ring) pts.push(pt.x, 0, pt.z);
        pts.push(NaN, NaN, NaN);
    }
    while (pts.length > 0 && isNaN(pts[pts.length - 1])) pts.pop();
    return pts.length >= 6 ? new Float32Array(pts) : null;
}

function mergePolygonGeometries(geos) {
    if (geos.length === 1) return geos[0];
    const allPos = [];
    const allIdx = [];
    let offset = 0;
    for (const geo of geos) {
        const positions = geo.positions;
        const indices = geo.indices;
        for (let i = 0; i < positions.length; i++) allPos.push(positions[i]);
        for (let i = 0; i < indices.length; i++) allIdx.push(indices[i] + offset);
        offset += positions.length / 3;
    }
    return {
        positions: new Float32Array(allPos),
        indices: new Uint32Array(allIdx)
    };
}

function computePointScale(z) {
    if (z <= 14) return 1.0;
    return 1.0 + (z - 14) * 0.25;
}

function blendWithBackground(color, opacity) {
    if (opacity >= 1) return color;
    if (opacity <= 0) return 0xffffff;
    const r = (color >> 16) & 0xff;
    const g = (color >> 8) & 0xff;
    const b = color & 0xff;
    const br = Math.round(r * opacity + 255 * (1 - opacity));
    const bg = Math.round(g * opacity + 255 * (1 - opacity));
    const bb = Math.round(b * opacity + 255 * (1 - opacity));
    return (br << 16) | (bg << 8) | bb;
}

// ════════════════════════════════════════════════════════════════════════
// IDENTIFY
// ════════════════════════════════════════════════════════════════════════

function identifyAt(tile, z, x, y, tileSize, maxMerc, localX, localZ, tolerance, continuousZoom) {
    const zoom = continuousZoom ?? z;
    const tol = tolerance || tileSize * 0.005;
    const tolSq = tol * tol;
    const results = [];

    for (const layerName in tile.layers) {
        const layer = tile.layers[layerName];
        const layerStyle = workerStyles[layerName];
        for (let i = 0; i < layer.length; i++) {
            const feature = layer.feature(i);
            const props = feature.properties || {};
            const geomType = feature.type;
            const geom = feature.loadGeometry();
            let hit = false;
            let minDistSq = Infinity;

            if (geomType === 1) {
                const pt = geom[0] && geom[0][0];
                if (pt) {
                    const fx = (pt.x / 4095 - 0.5) * tileSize;
                    const fz = (pt.y / 4095 - 0.5) * tileSize;
                    const d2 = (fx - localX) * (fx - localX) + (fz - localZ) * (fz - localZ);
                    if (d2 < tolSq) { hit = true; minDistSq = d2; }
                }
            } else if (geomType === 2) {
                for (const ring of geom) {
                    for (let k = 0; k < ring.length - 1; k++) {
                        const ax = (ring[k].x / 4095 - 0.5) * tileSize;
                        const az = (ring[k].y / 4095 - 0.5) * tileSize;
                        const bx = (ring[k + 1].x / 4095 - 0.5) * tileSize;
                        const bz = (ring[k + 1].y / 4095 - 0.5) * tileSize;
                        const d2 = pointSegDistSq(localX, localZ, ax, az, bx, bz);
                        if (d2 < tolSq && d2 < minDistSq) { hit = true; minDistSq = d2; }
                    }
                }
            } else if (geomType === 3) {
                const rings2d = geom.map(ring => ring.map(p => ({
                    x: (p.x / 4095 - 0.5) * tileSize,
                    z: (p.y / 4095 - 0.5) * tileSize
                })));
                if (pointInPolygonRings({ x: localX, z: localZ }, rings2d)) {
                    hit = true;
                    minDistSq = 0;
                }
            }
            if (!hit) continue;

            const filterPass = layerStyle && layerStyle.filter
                ? resolveFilter(layerStyle.filter, feature)
                : true;

            results.push({
                layer: layerName,
                type: geomType === 1 ? 'Point' : geomType === 2 ? 'LineString' : 'Polygon',
                featureIndex: i,
                distance: Math.sqrt(minDistSq),
                filterPass,
                style: layerStyle ? snapshotStyle(layerStyle, props, zoom, geomType) : null,
                renderOrder: LAYER_RENDER_ORDER[layerName] !== undefined
                    ? LAYER_RENDER_ORDER[layerName] : null,
                properties: props,
            });
        }
    }
    results.sort((a, b) => a.distance - b.distance);
    return { tile: { z, x, y }, features: results };
}

function pointSegDistSq(px, pz, ax, az, bx, bz) {
    const dx = bx - ax, dz = bz - az;
    const lenSq = dx * dx + dz * dz;
    if (lenSq < 1e-12) return (px - ax) * (px - ax) + (pz - az) * (pz - az);
    let t = ((px - ax) * dx + (pz - az) * dz) / lenSq;
    if (t < 0) t = 0; else if (t > 1) t = 1;
    const qx = ax + t * dx, qz = az + t * dz;
    return (px - qx) * (px - qx) + (pz - qz) * (pz - qz);
}

function pointInPolygonRings(pt, rings) {
    let inside = false;
    for (const ring of rings) {
        if (ring.length < 3) continue;
        for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
            const xi = ring[i].x, zi = ring[i].z;
            const xj = ring[j].x, zj = ring[j].z;
            if (((zi > pt.z) !== (zj > pt.z)) &&
                (pt.x < (xj - xi) * (pt.z - zi) / (zj - zi) + xi)) {
                inside = !inside;
            }
        }
    }
    return inside;
}

function snapshotStyle(layerStyle, props, zoom, geomType) {
    if (!layerStyle) return null;
    const keys = [
        'color', 'opacity', 'stroke', 'width', 'dash', 'radius', 'height', 'base',
        'textColor', 'fontSize', 'fontFamily', 'fontWeight', 'textShadow',
        'textOffset', 'textAlign', 'textVerticalAlign', 'textPriority',
        'textZoomMin', 'textZoomMax', 'textPlacement', 'textTransform',
        'textFontStyle', 'textLetterSpacing', 'textMinSegmentLength'
    ];
    const out = {};
    for (const k of keys) {
        if (layerStyle[k] === undefined) continue;
        const v = resolveValue(layerStyle[k], props, zoom, geomType);
        if ((k === 'color' || k === 'stroke') && typeof v === 'number') {
            out[k] = '#' + v.toString(16).padStart(6, '0');
        } else {
            out[k] = v;
        }
    }
    return out;
}

// ════════════════════════════════════════════════════════════════════════
// EXCLUSION AREAS
// ════════════════════════════════════════════════════════════════════════

function pointInPolygon(pt, polygon) {
    let inside = false;
    for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
        const xi = polygon[i].x, zi = polygon[i].z;
        const xj = polygon[j].x, zj = polygon[j].z;
        if (((zi > pt.z) !== (zj > pt.z)) &&
            (pt.x < (xj - xi) * (pt.z - zi) / (zj - zi) + xi)) {
            inside = !inside;
        }
    }
    return inside;
}

function segmentsIntersect(a, b, c, d) {
    function ccw(p, q, r) {
        return (q.x - p.x) * (r.z - p.z) - (q.z - p.z) * (r.x - p.x);
    }
    const d1 = ccw(c, d, a);
    const d2 = ccw(c, d, b);
    const d3 = ccw(a, b, c);
    const d4 = ccw(a, b, d);
    if (((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) &&
        ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0))) return true;
    return false;
}

function polygonIntersectsAny(rings, exclusionPolygons) {
    for (const ring of rings) {
        for (const pt of ring) {
            for (const exPoly of exclusionPolygons) {
                if (pointInPolygon(pt, exPoly)) return true;
            }
        }
        for (let i = 0; i < ring.length; i++) {
            const a = ring[i];
            const b = ring[(i + 1) % ring.length];
            for (const exPoly of exclusionPolygons) {
                for (let j = 0; j < exPoly.length; j++) {
                    const c = exPoly[j];
                    const d = exPoly[(j + 1) % exPoly.length];
                    if (segmentsIntersect(a, b, c, d)) return true;
                }
            }
        }
    }
    return false;
}

function lineIntersectsAny(lineRings, exclusionPolygons) {
    for (const line of lineRings) {
        if (line.length < 2) continue;
        for (let i = 0; i < line.length - 1; i++) {
            const a = line[i];
            const b = line[i + 1];
            for (const exPoly of exclusionPolygons) {
                if (pointInPolygon(a, exPoly) || pointInPolygon(b, exPoly)) return true;
            }
            for (const exPoly of exclusionPolygons) {
                for (let j = 0; j < exPoly.length; j++) {
                    const c = exPoly[j];
                    const d = exPoly[(j + 1) % exPoly.length];
                    if (segmentsIntersect(a, b, c, d)) return true;
                }
            }
        }
    }
    return false;
}

// ════════════════════════════════════════════════════════════════════════
// ОБРАБОТКА ТАЙЛА
// ════════════════════════════════════════════════════════════════════════

function processTile(tile, z, x, y, tileSize, maxMerc, is3d, visibleLayers, buildingEdges,
                     exclusionPolygons = [], exclusionLayers = [],
                     maxTextPointsPerTile = 300, maxTextLinesPerTile = 30,
                     continuousZoom = z) {
    const eps = tileSize * 0.5 / 4096;
    const pointScale = computePointScale(continuousZoom);
    const halfTile = tileSize / 2;
    const styleZoom = continuousZoom;

    const centerX = x * tileSize - maxMerc + tileSize / 2;
    const centerZ = -maxMerc + y * tileSize + tileSize / 2;

    const localExclusionPolygons = exclusionPolygons.map(poly => poly.map(p => ({
        x: p.x - centerX,
        z: p.z - centerZ
    })));
    const exclusionLayerSet = new Set(exclusionLayers);

    const fillsMap = new Map();
    const linesMap = new Map();
    const strokesMap = new Map();
    const buildings = [];
    const points = [];
    const textPoints = [];
    const textLines = [];

    const processLayer = (name) => {
        if (visibleLayers && !visibleLayers.includes(name)) return;
        const layer = tile.layers[name];
        if (!layer) return;
        const layerStyle = workerStyles[name];
        if (!layerStyle) return;

        if (layerStyle.maxZoom !== undefined && styleZoom >= layerStyle.maxZoom) return;

        const isCarrierOnlyLine = CARRIER_ONLY_LINE_LAYERS.has(name);
        const layerBaseOrder = LAYER_RENDER_ORDER[name] ?? 20;

        for (let i = 0; i < layer.length; i++) {
            const feature = layer.feature(i);
            const props = feature.properties || {};

            if (layerStyle.filter && !resolveFilter(layerStyle.filter, feature)) continue;

            const geomType = feature.type;
            const sortKey = props.sort_key != null ? Number(props.sort_key) : 0;

            // ═══════════════════════ POINT ═══════════════════════
            if (geomType === 1) {
                const geom = feature.loadGeometry();
                if (geom.length === 0) continue;
                const ring = geom[0];
                if (ring.length === 0) continue;
                const pt = ring[0];
                if (pt.x < 0 || pt.x > 4095 || pt.y < 0 || pt.y > 4095) continue;

                const worldX = (pt.x / 4095 - 0.5) * tileSize;
                const worldZ = (pt.y / 4095 - 0.5) * tileSize;

                if (exclusionLayerSet.has(name) && localExclusionPolygons.length > 0) {
                    const localPt = { x: worldX, z: worldZ };
                    let excluded = false;
                    for (const exPoly of localExclusionPolygons) {
                        if (pointInPolygon(localPt, exPoly)) { excluded = true; break; }
                    }
                    if (excluded) continue;
                }

                const hasText = layerStyle.textColor !== undefined ||
                                layerStyle.fontSize !== undefined;

                if (hasText) {
                    const text = props.name || '';
                    if (!text) continue;

                    textPoints.push({
                        x: worldX, z: worldZ, text, layerName: name,
                        textColor: resolveString(layerStyle.textColor, props, styleZoom, '#333333', geomType),
                        fontSize: resolveNumber(layerStyle.fontSize, props, styleZoom, 12, geomType) + 'px',
                        fontFamily: resolveString(layerStyle.fontFamily, props, styleZoom, 'sans-serif', geomType),
                        fontWeight: resolveString(layerStyle.fontWeight, props, styleZoom, 'normal', geomType),
                        textFontStyle: resolveString(layerStyle.textFontStyle, props, styleZoom, '', geomType),
                        textTransform: resolveString(layerStyle.textTransform, props, styleZoom, '', geomType),
                        textLetterSpacing: resolveString(layerStyle.textLetterSpacing, props, styleZoom, '', geomType),
                        textShadow: resolveString(layerStyle.textShadow, props, styleZoom, '', geomType),
                        textOffset: resolveArray(layerStyle.textOffset, props, styleZoom, geomType) || [0, 0],
                        textAlign: resolveString(layerStyle.textAlign, props, styleZoom, 'center', geomType),
                        textVerticalAlign: resolveString(layerStyle.textVerticalAlign, props, styleZoom, 'center', geomType),
                        priority: resolveNumber(layerStyle.textPriority, props, styleZoom, layerBaseOrder, geomType) + sortKey * 0.001,
                        zoomBounds: {
                            min: resolveNumber(layerStyle.textZoomMin, props, styleZoom, 0, geomType),
                            max: resolveNumber(layerStyle.textZoomMax, props, styleZoom, 24, geomType)
                        }
                    });
                    continue;
                }

                const color = resolveColor(layerStyle.color, props, styleZoom, geomType);
                if (color === null) continue;
                const radius = resolveNumber(layerStyle.radius, props, styleZoom, 3, geomType) * pointScale;
                const opacity = resolveNumber(layerStyle.opacity, props, styleZoom, 1, geomType);

                points.push({
                    x: worldX, z: worldZ, radius, color, opacity,
                    renderOrder: layerBaseOrder + Math.min(sortKey * 0.001, 0.4)
                });
                continue;
            }

            // ═══════════════════ POLYGON / LINESTRING ═══════════════════
            const rings = toWorldCoords(feature, z, x, y, tileSize, maxMerc, geomType === 2);

            if (geomType === 3) {
                if (exclusionLayerSet.has(name) && localExclusionPolygons.length > 0) {
                    if (polygonIntersectsAny(rings, localExclusionPolygons)) continue;
                }

                // ---- building (fill-extrusion) ----
                if (name === 'building') {
                    if (props.hide_3d === true) continue;
                    const height = resolveHeight(layerStyle.height, props, styleZoom, geomType);
                    const minHeight = resolveHeight(layerStyle.base, props, styleZoom, geomType);
                    if (!isNaN(height) && height > 0 && height > minHeight) {
                        const isPart = props['building:part'] === 'yes';
                        const isSimpleBuilding = props['building:part'] === undefined;
                        if (is3d && (isPart || isSimpleBuilding)) {
                            const geo = extrudeBuilding(rings, height, minHeight, eps, buildingEdges, halfTile);
                            if (geo) {
                                const bColor = resolveColor(layerStyle.color, props, styleZoom, geomType);
                                const bStroke = resolveColor(layerStyle.stroke, props, styleZoom, geomType);
                                buildings.push({
                                    positions: geo.positions,
                                    normals: geo.normals,
                                    edgePositions: geo.edgePositions,
                                    color: bColor !== null ? bColor : 0xf2eae2,
                                    stroke: bStroke !== null ? bStroke : 0xb3b3b3,
                                    renderOrder: layerBaseOrder + Math.min(sortKey * 0.001, 0.4)
                                });
                                continue;
                            }
                        }
                    }
                }

                // ---- polygon fill ----
                const color = resolveColor(layerStyle.color, props, styleZoom, geomType);
                if (color === null) continue;
                const rawOpacity = resolveNumber(layerStyle.opacity, props, styleZoom, 1, geomType);
                const color_out = rawOpacity < 1
                    ? blendWithBackground(color, rawOpacity)
                    : color;
                const opacity = 1;

                const fillKey = 'fill:' + name + ':' + color_out.toString(16) + ':' + opacity;
                let fillGroup = fillsMap.get(fillKey);
                if (!fillGroup) { fillGroup = []; fillsMap.set(fillKey, fillGroup); }

                const validRings = [];
                for (const ring of rings) {
                    const cleaned = dedupRing(ring, eps);
                    if (cleaned.length < 3) continue;
                    const area = ringArea(cleaned);
                    if (Math.abs(area) < eps * eps) continue;
                    validRings.push({ ring: cleaned, area });
                }
                if (validRings.length === 0) continue;

                let maxAbsArea = 0;
                let outerSign = 1;
                for (const r of validRings) {
                    const a = Math.abs(r.area);
                    if (a > maxAbsArea) { maxAbsArea = a; outerSign = Math.sign(r.area); }
                }

                const polygonGroups = [];
                let currentPoly = null;
                for (const r of validRings) {
                    const isOuter = Math.sign(r.area) === outerSign;
                    if (isOuter || currentPoly === null) {
                        currentPoly = { outer: r.ring, holes: [] };
                        polygonGroups.push(currentPoly);
                    } else {
                        currentPoly.holes.push(r.ring);
                    }
                }

                const triData = [];
                for (const poly of polygonGroups) {
                    const outer = orientRing(poly.outer, false);
                    const holes = poly.holes.map(h => orientRing(h, true));
                    const t = triangulatePolygon(outer, holes, eps);
                    if (!t) continue;
                    const positions = new Float32Array(t.vertices.length / 2 * 3);
                    for (let ii = 0, jj = 0; ii < t.vertices.length; ii += 2, jj += 3) {
                        positions[jj] = t.vertices[ii];
                        positions[jj + 1] = 0;
                        positions[jj + 2] = t.vertices[ii + 1];
                    }
                    triData.push({ positions, indices: new Uint32Array(t.indices), sortKey });
                }
                if (triData.length > 0) fillGroup.push(...triData);

                // ---- polygon stroke ----
                const strokeColor = resolveColor(layerStyle.stroke, props, styleZoom, geomType);
                if (strokeColor !== null) {
                    const strokeWidth = resolveNumber(layerStyle.width, props, styleZoom, 1, geomType);
                    const strokeKey = 'stroke:' + name + ':' + strokeColor.toString(16) + ':' + strokeWidth;
                    let strokeGroup = strokesMap.get(strokeKey);
                    if (!strokeGroup) { strokeGroup = []; strokesMap.set(strokeKey, strokeGroup); }
                    for (const ring of rings) {
                        if (ring.length >= 2) strokeGroup.push({ ring, sortKey });
                    }
                }
            } else if (geomType === 2) {
                if (exclusionLayerSet.has(name) && localExclusionPolygons.length > 0) {
                    if (lineIntersectsAny(rings, localExclusionPolygons)) continue;
                }

                // ---- line geometry ----
                if (!isCarrierOnlyLine) {
                    const color = resolveColor(layerStyle.color, props, styleZoom, geomType);
                    if (color !== null) {
                        const width = resolveNumber(layerStyle.width, props, styleZoom, 1, geomType);
                        const opacity = resolveNumber(layerStyle.opacity, props, styleZoom, 1, geomType);
                        const dashPx = resolveArray(layerStyle.dash, props, styleZoom, geomType);
                        const dash = dashPx
                            ? scaleDash(dashPx, tileSize, z, styleZoom)
                            : null;

                        const finalColor = opacity < 1
                            ? blendWithBackground(color, opacity)
                            : color;

                        let dynamicOrder = layerBaseOrder;
                        if (name === 'transportation') {
                            const brunnel = props.brunnel || '';
                            const bridge = brunnel === 'bridge' ? 2 : 0;
                            const tunnel = brunnel === 'tunnel' ? -2 : 0;
                            const layerVal = props.layer ? parseInt(props.layer, 10) : 0;
                            dynamicOrder = dynamicOrder + bridge + tunnel + layerVal;
                        }

                        const dashKey = dash ? dash.map(v => v.toFixed(3)).join(',') : 'none';
                        const lineKey = 'line:' + name + ':' +
                            finalColor.toString(16) + ':' + width + ':' + dashKey;
                        let lineGroup = linesMap.get(lineKey);
                        if (!lineGroup) {
                            lineGroup = { rings: [], renderOrder: dynamicOrder, dash };
                            linesMap.set(lineKey, lineGroup);
                        }
                        for (const ring of rings) {
                            if (ring.length >= 2) lineGroup.rings.push({ ring, sortKey });
                        }

                        // ---- Casing (обводка) для дорог ----
                        const cls = props.class;
                        const brunnel = props.brunnel || '';
                        const casingInfo = TRANSPORTATION_CASING[cls];
                        if (name === 'transportation' && casingInfo &&
                            brunnel !== 'tunnel' && width > 0.5) {
                            const casingWidth = width + casingInfo.extraWidth;
                            const casingKey = 'line:' + name + ':' +
                                casingInfo.color.toString(16) + ':' + casingWidth + ':none';
                            let casingGroup = linesMap.get(casingKey);
                            if (!casingGroup) {
                                casingGroup = {
                                    rings: [],
                                    renderOrder: dynamicOrder - 0.5,
                                    dash: null
                                };
                                linesMap.set(casingKey, casingGroup);
                            }
                            for (const ring of rings) {
                                if (ring.length >= 2) casingGroup.rings.push({ ring, sortKey });
                            }
                        }
                    }
                }

                // ---- text on lines ----
                const hasText = layerStyle.textColor !== undefined ||
                                layerStyle.fontSize !== undefined ||
                                layerStyle.textZoomMin !== undefined ||
                                layerStyle.textPlacement !== undefined;

                if (hasText) {
                    const featureName = props.name || props.ref || '';
                    if (!featureName) continue;

                    const minSegmentFactor = resolveNumber(
                        layerStyle.textMinSegmentLength, props, styleZoom, 0.15, geomType);
                    const minLen = tileSize * minSegmentFactor;

                    for (const ring of rings) {
                        if (ring.length < 2) continue;
                        let len = 0;
                        for (let k = 0; k < ring.length - 1; k++) {
                            const dx = ring[k + 1].x - ring[k].x;
                            const dz = ring[k + 1].z - ring[k].z;
                            len += Math.hypot(dx, dz);
                        }
                        if (len < minLen) continue;

                        textLines.push({
                            points: ring.map(p => ({ x: p.x, z: p.z })),
                            text: featureName, layerName: name,
                            textColor: resolveString(layerStyle.textColor, props, styleZoom, '#333333', geomType),
                            fontSize: resolveNumber(layerStyle.fontSize, props, styleZoom, 11, geomType) + 'px',
                            fontFamily: resolveString(layerStyle.fontFamily, props, styleZoom, 'sans-serif', geomType),
                            fontWeight: resolveString(layerStyle.fontWeight, props, styleZoom, 'normal', geomType),
                            textFontStyle: resolveString(layerStyle.textFontStyle, props, styleZoom, '', geomType),
                            textTransform: resolveString(layerStyle.textTransform, props, styleZoom, '', geomType),
                            textLetterSpacing: resolveString(layerStyle.textLetterSpacing, props, styleZoom, '', geomType),
                            textShadow: resolveString(layerStyle.textShadow, props, styleZoom, '', geomType),
                            textOffset: resolveArray(layerStyle.textOffset, props, styleZoom, geomType) || [0, 0],
                            textAlign: resolveString(layerStyle.textAlign, props, styleZoom, 'center', geomType),
                            textVerticalAlign: resolveString(layerStyle.textVerticalAlign, props, styleZoom, 'middle', geomType),
                            placement: resolveString(layerStyle.textPlacement, props, styleZoom, 'along', geomType),
                            priority: resolveNumber(layerStyle.textPriority, props, styleZoom, layerBaseOrder, geomType) + sortKey * 0.001,
                            zoomBounds: {
                                min: resolveNumber(layerStyle.textZoomMin, props, styleZoom, 14, geomType),
                                max: resolveNumber(layerStyle.textZoomMax, props, styleZoom, 24, geomType)
                            }
                        });
                    }
                }
            }
        }
    };

    for (const name in tile.layers) processLayer(name);

    textPoints.sort((a, b) => b.priority - a.priority);
    textLines.sort((a, b) => b.priority - a.priority);
    if (textPoints.length > maxTextPointsPerTile) textPoints.length = maxTextPointsPerTile;
    if (textLines.length > maxTextLinesPerTile) textLines.length = maxTextLinesPerTile;

    const result = {
        fills: [], lines: [], strokes: [], buildings: [],
        points, textPoints, textLines, centerX, centerZ
    };

    for (const entry of fillsMap) {
        const key = entry[0], triGroup = entry[1];
        const merged = mergePolygonGeometries(triGroup);
        const parts = key.split(':');
        const avgSortKey = triGroup.reduce((sum, g) => sum + (g.sortKey || 0), 0) / triGroup.length;
        const polyFillOffset = parts[1] === 'transportation' ? -0.5 : 0;
        result.fills.push({
            positions: merged.positions,
            indices: merged.indices,
            layerName: parts[1],
            color: parseInt(parts[2], 16),
            opacity: parseFloat(parts[3]),
            renderOrder: (LAYER_RENDER_ORDER[parts[1]] ?? 1) + polyFillOffset + Math.min(avgSortKey * 0.001, 0.4)
        });
    }

    for (const entry of linesMap) {
        const key = entry[0], lineGroup = entry[1];
        const positions = createLinePositions(lineGroup.rings.map(r => r.ring));
        if (!positions) continue;
        const parts = key.split(':');
        const avgSortKey = lineGroup.rings.reduce((sum, r) => sum + (r.sortKey || 0), 0) / lineGroup.rings.length;
        result.lines.push({
            positions,
            layerName: parts[1],
            color: parseInt(parts[2], 16),
            width: parseFloat(parts[3]),
            dash: lineGroup.dash,
            renderOrder: lineGroup.renderOrder + Math.min(avgSortKey * 0.001, 0.4)
        });
    }

    for (const entry of strokesMap) {
        const key = entry[0], strokeGroup = entry[1];
        const positions = createLinePositions(strokeGroup.map(s => s.ring));
        if (!positions) continue;
        const parts = key.split(':');
        const avgSortKey = strokeGroup.reduce((sum, s) => sum + (s.sortKey || 0), 0) / strokeGroup.length;
        result.strokes.push({
            positions,
            layerName: parts[1],
            color: parseInt(parts[2], 16),
            width: parseFloat(parts[3]),
            renderOrder: (LAYER_RENDER_ORDER[parts[1]] ?? 1) + 1 + Math.min(avgSortKey * 0.001, 0.4)
        });
    }

    result.buildings = buildings.map(b => ({
        positions: b.positions,
        normals: b.normals,
        edgePositions: b.edgePositions,
        layerName: 'building',
        color: b.color,
        stroke: b.stroke,
        renderOrder: b.renderOrder
    }));

    result.is3d = is3d;
    return result;
}
`;
}