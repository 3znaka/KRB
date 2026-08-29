/**
 * Модуль генерации кода воркера векторных тайлов.
 * Использует стили и порядок отрисовки из vectorTileDefaults.js.
 */

import { DEFAULT_STYLES, LAYER_RENDER_ORDER } from './vectorTileDefaults.js';

/**
 * Преобразует строку в base64 (для data: URL).
 */
export function stringToBase64(str) {
    const bytes = new TextEncoder().encode(str);
    let binary = '';
    for (let i = 0; i < bytes.length; i++) {
        binary += String.fromCharCode(bytes[i]);
    }
    return btoa(binary);
}

/**
 * Генерирует код модульного воркера с внедрёнными data: URL библиотек.
 */
export function createWorkerCode(tpbDataURL, earcutDataURL) {
    return `
// Динамический импорт библиотек из data: URL (не зависит от серверных MIME-типов)
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
    if (msg.type === 'process') {
        const {
    id, buffer, z, x, y, tileSize, maxMerc, is3d,
    visibleLayers, buildings3dMinZoom, buildingEdges
} = msg;
        try {
            const tile = new VectorTile(new Protobuf(buffer));
            const result = processTile(
    tile, z, x, y, tileSize, maxMerc, is3d,
    visibleLayers, buildings3dMinZoom, buildingEdges
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

// Вспомогательные функции
const DEFAULT_STYLES = ${JSON.stringify(DEFAULT_STYLES)};
const LAYER_RENDER_ORDER = ${JSON.stringify(LAYER_RENDER_ORDER)};
let workerStyles = DEFAULT_STYLES;

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

function getFeatureStyle(feature, layerName, styles) {
    const p = feature.properties || {};
    let styleConfig = styles[layerName];
    if (!styleConfig) return null;

    if (typeof styleConfig === 'object' && !styleConfig.hasOwnProperty('color') && !styleConfig.hasOwnProperty('stroke')) {
        const cls = p.class || p.subclass || '_default';
        const classStyle = styleConfig[cls] || styleConfig['_default'];
        if (!classStyle) return null;
        styleConfig = classStyle;
    }

    const result = {};
    if (styleConfig.color !== undefined) result.color = styleConfig.color;
    if (styleConfig.opacity !== undefined) result.opacity = styleConfig.opacity;
    if (styleConfig.stroke !== undefined) result.stroke = styleConfig.stroke;
    if (styleConfig.width !== undefined) {
        result.width = styleConfig.width;
        result.type = 'line';
    }
    if (styleConfig.radius !== undefined) result.radius = styleConfig.radius;
    if (styleConfig.height !== undefined) result.height = styleConfig.height;
    if (styleConfig.dash !== undefined) result.dash = styleConfig.dash;
    if (!result.type) result.type = 'fill';
    if (result.stroke && !result.width) result.type = 'fill';

    for (const [key, value] of Object.entries(styleConfig)) {
        if (!(key in result)) result[key] = value;
    }

    return result;
}

function toWorldCoords(feature, z, xSlippy, ySlippy, tileSize, maxMerc) {
    const originZ = -maxMerc + ySlippy * tileSize;
    const originX = xSlippy * tileSize - maxMerc;
    const geom = feature.loadGeometry();
    return geom
        .map(ring => clipRingToTile(ring.map(p => ({ x: p.x, y: p.y })), 4095))
        .filter(ring => ring.length >= 3)
        .map(ring => ring.map(p => ({
            x: originX + (p.x / 4095) * tileSize,
            z: originZ + (p.y / 4095) * tileSize
        })));
}

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
        { axis: 'x', val: 0,   inside: p => p.x >= 0 },
        { axis: 'x', val: size, inside: p => p.x <= size },
        { axis: 'y', val: 0,   inside: p => p.y >= 0 },
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

    // если порядок вершин не совпадает с нужной нормалью — меняем b и c местами
    if (crx * nx + cry * ny + crz * nz < 0) {
        positions.push(ax, ay, az, cx, cy, cz, bx, by, bz);
    } else {
        positions.push(ax, ay, az, bx, by, bz, cx, cy, cz);
    }

    for (let i = 0; i < 3; i++) {
        normals.push(nx, ny, nz);
    }
}

function extrudeBuilding(rings, height, minHeight = 0, eps, includeEdges = true) {
    if (!rings || rings.length === 0 || height <= 0) return null;
    const cleaned = rings.map(r => dedupRing(r, eps)).filter(r => r.length >= 3);
    if (cleaned.length === 0) return null;

    const polygons = [];
let outerSign = null;

for (const ring of cleaned) {
    const area = ringArea(ring);

    // Почти вырожденные кольца пропускаем
    if (Math.abs(area) < 1e-9) continue;

    if (outerSign === null) {
        // Первое нормальное кольцо считаем внешним
        outerSign = Math.sign(area);
    }

    const isOuter = Math.sign(area) === outerSign;

    if (isOuter) {
        polygons.push({ outer: ring, holes: [] });
    } else if (polygons.length > 0) {
        polygons[polygons.length - 1].holes.push(ring);
    } else {
        // Защитный случай: если дырка встретилась раньше внешнего кольца,
        // не теряем её, а считаем внешним кольцом.
        polygons.push({ outer: ring, holes: [] });
    }
}

if (polygons.length === 0) return null;

    const positions = [];
    const normals = [];
    const edges = [];
    const cornerCos = Math.cos(15 * Math.PI / 180);

    for (const poly of polygons) {
        const outer = orientRing(poly.outer, false);
        const holes = poly.holes.map(h => orientRing(h, true));
        const triData = triangulatePolygon(outer, holes, eps);
        if (!triData) continue;
        const { vertices, indices } = triData;

        for (let i = 0; i < indices.length; i += 3) {
    const a = indices[i], b = indices[i + 1], c = indices[i + 2];

    const ax = vertices[a * 2], az = vertices[a * 2 + 1];
    const bx = vertices[b * 2], bz = vertices[b * 2 + 1];
    const cx = vertices[c * 2], cz = vertices[c * 2 + 1];

    pushTriangle(
        positions, normals,
        ax, height, az,
        bx, height, bz,
        cx, height, cz,
        0, 1, 0
    );
}
       if (minHeight > 0) {
    for (let i = 0; i < indices.length; i += 3) {
        const a = indices[i], b = indices[i + 1], c = indices[i + 2];

        const ax = vertices[a * 2], az = vertices[a * 2 + 1];
        const bx = vertices[b * 2], bz = vertices[b * 2 + 1];
        const cx = vertices[c * 2], cz = vertices[c * 2 + 1];

        pushTriangle(
            positions, normals,
            ax, minHeight, az,
            bx, minHeight, bz,
            cx, minHeight, cz,
            0, -1, 0
        );
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

        // Первый треугольник стенки
        pushTriangle(
            positions, normals,
            p0.x, minHeight, p0.z,
            p1.x, minHeight, p1.z,
            p1.x, height, p1.z,
            nx, 0, nz
        );

        // Второй треугольник стенки
        pushTriangle(
            positions, normals,
            p0.x, minHeight, p0.z,
            p1.x, height, p1.z,
            p0.x, height, p0.z,
            nx, 0, nz
        );

        
        if (includeEdges) {
            // Рёбра оставляем без изменений
            edges.push(p0.x, height, p0.z, p1.x, height, p1.z);
            if (minHeight > 0) {
                edges.push(p0.x, minHeight, p0.z, p1.x, minHeight, p1.z);
            }

            const p2 = ring[(i + 2) % n];
            const dx2 = p2.x - p1.x;
            const dz2 = p2.z - p1.z;
            const len2 = Math.hypot(dx2, dz2);

            if (
                len2 > eps &&
                (dx * dx2 + dz * dz2) / (len * len2) < Math.cos(15 * Math.PI / 180)
            ) {
                edges.push(p1.x, minHeight, p1.z, p1.x, height, p1.z);
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
        const { positions, indices } = geo;
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

function processTile(tile, z, x, y, tileSize, maxMerc, is3d, visibleLayers, buildings3dMinZoom, buildingEdges) {
    const eps = tileSize * 0.5 / 4096;
    const pointScale = computePointScale(z);

    const fillsMap = new Map();
    const linesMap = new Map();
    const strokesMap = new Map();
    const buildings = [];
    const points = [];
    const textPoints = [];

    const textLayers = ['place', 'poi', 'housenumber'];

    const layerOrder = ['water', 'landcover', 'landuse', 'park', 'transportation', 'building', 'boundary', 'place'];
    const processLayer = (name) => {
        if (visibleLayers && !visibleLayers.includes(name)) return;
        const layer = tile.layers[name];
        if (!layer) return;
        for (let i = 0; i < layer.length; i++) {
            const feature = layer.feature(i);
            const props = feature.properties || {};
            const style = getFeatureStyle(feature, name, workerStyles);
            if (!style) continue;

            const geomType = feature.type;
            const sortKey = props.sort_key != null ? Number(props.sort_key) : 0;

            if (geomType === 1) {
                const geom = feature.loadGeometry();
                if (geom.length === 0) continue;
                const ring = geom[0];
                if (ring.length === 0) continue;
                const pt = ring[0];
                if (pt.x < 0 || pt.x > 4095 || pt.y < 0 || pt.y > 4095) continue;
                const originX = x * tileSize - maxMerc;
                const originZ = -maxMerc + y * tileSize;
                const worldX = originX + (pt.x / 4095) * tileSize;
                const worldZ = originZ + (pt.y / 4095) * tileSize;

                if (textLayers.includes(name)) {
                    const text = name === 'housenumber' 
                        ? (props.housenumber || '')
                        : (props.name || '');
                    if (!text) continue;

                    textPoints.push({
                        x: worldX,
                        z: worldZ,
                        text,
                        layerName: name,
                        textColor: style.textColor || '#333333',
                        fontSize: style.fontSize || '12px',
                        fontFamily: style.fontFamily || 'sans-serif',
                        fontWeight: style.fontWeight || 'normal',
                        textShadow: style.textShadow || '',
                        textOffset: style.textOffset || [0, 0],
                        textAlign: style.textAlign || 'center',
                        textVerticalAlign: style.textVerticalAlign || 'center',
                        priority: (style.textPriority !== undefined ? style.textPriority : (LAYER_RENDER_ORDER[name] ?? 20)) + sortKey * 0.001,
                        zoomBounds: {
                            min: style.textZoomMin !== undefined ? style.textZoomMin : 0,
                            max: style.textZoomMax !== undefined ? style.textZoomMax : 24
                        }
                    });
                    continue;
                }

                const radius = (style.radius || 3) * pointScale;
                points.push({
                    x: worldX,
                    z: worldZ,
                    radius,
                    color: style.color,
                    opacity: style.opacity ?? 1,
                    renderOrder: (LAYER_RENDER_ORDER[name] ?? 20) + sortKey * 0.001
                });
                continue;
            }

            const rings = toWorldCoords(feature, z, x, y, tileSize, maxMerc);

            if (geomType === 3) {
                if (name === 'building') {
                    if (props.hide_3d === true) continue;

                    let height = 0;
                    if (props.render_height !== undefined && props.render_height !== null) {
                        height = parseFloat(props.render_height);
                    } else if (props['building:levels'] !== undefined) {
                        const levels = parseInt(props['building:levels'], 10) || 0;
                        height = levels * 3;
                    }
                    let minHeight = 0;
                    const rawMin = props.render_min_height ?? props.min_height;
                    if (rawMin !== undefined && rawMin !== null) {
                        minHeight = parseFloat(rawMin);
                    }

                    if (!isNaN(height) && height > 0) {
                        minHeight = isNaN(minHeight) ? 0 : minHeight;
                        if (height > minHeight) {
                            const isPart = props['building:part'] === 'yes';
                            const isSimpleBuilding = props['building:part'] === undefined;
                            if (is3d && (isPart || isSimpleBuilding)) {
                                const geo = extrudeBuilding(rings, height, minHeight, eps, buildingEdges);
                                if (geo) {
                                    buildings.push({
                                        positions: geo.positions,
                                        normals: geo.normals,
                                        edgePositions: geo.edgePositions,
                                        color: style.color,
                                        stroke: style.stroke || 0xb3b3b3,
                                        renderOrder: (LAYER_RENDER_ORDER[name] ?? 7) + sortKey * 0.001
                                    });
                                    continue;
                                }
                            }
                        }
                    }
                }

                const fillKey = \`fill:\${name}:\${style.color.toString(16)}:\${(style.opacity ?? 1)}\`;
                let fillGroup = fillsMap.get(fillKey);
                if (!fillGroup) { fillGroup = []; fillsMap.set(fillKey, fillGroup); }
                const triData = [];
                for (const ring of rings) {
                    const outer = orientRing(ring, false);
                    const cleanedOuter = dedupRing(outer, eps);
                    if (cleanedOuter.length < 3) continue;
                    const t = triangulatePolygon(cleanedOuter, [], eps);
                    if (t) {
                        const positions = new Float32Array(t.vertices.length / 2 * 3);
                        for (let i = 0, j = 0; i < t.vertices.length; i += 2, j += 3) {
                            positions[j] = t.vertices[i];
                            positions[j+1] = 0;
                            positions[j+2] = t.vertices[i+1];
                        }
                        triData.push({ positions, indices: new Uint32Array(t.indices), sortKey });
                    }
                }
                if (triData.length > 0) {
                    fillGroup.push(...triData);
                }

                if (style.stroke) {
                    const strokeKey = \`stroke:\${name}:\${style.stroke.toString(16)}:\${(style.width ?? 1)}\`;
                    let strokeGroup = strokesMap.get(strokeKey);
                    if (!strokeGroup) { strokeGroup = []; strokesMap.set(strokeKey, strokeGroup); }
                    for (const ring of rings) {
                        if (ring.length >= 2) strokeGroup.push({ ring, sortKey });
                    }
                }
            } else if (geomType === 2) {
                let dynamicOrder = LAYER_RENDER_ORDER[name] ?? 10;
                if (name === 'transportation' || name === 'transportation_name') {
                    const bridge = props.bridge === 'yes' ? 2 : 0;
                    const tunnel = props.tunnel === 'yes' ? -2 : 0;
                    const layerVal = props.layer ? parseInt(props.layer, 10) : 0;
                    dynamicOrder = dynamicOrder + bridge + tunnel + layerVal;
                }

                const lineKey = \`line:\${name}:\${style.color.toString(16)}:\${style.width ?? 1}:\${style.dash ? style.dash.join(',') : 'none'}\`;
                let lineGroup = linesMap.get(lineKey);
                if (!lineGroup) {
                    lineGroup = {
                        rings: [],
                        renderOrder: dynamicOrder,
                        dash: style.dash || null
                    };
                    linesMap.set(lineKey, lineGroup);
                }
                for (const ring of rings) {
                    if (ring.length >= 2) lineGroup.rings.push({ ring, sortKey });
                }
            }
        }
    };

    layerOrder.forEach(processLayer);
    for (const name in tile.layers) {
        if (!layerOrder.includes(name)) processLayer(name);
    }

    // Ограничиваем количество текстовых точек, чтобы не передавать слишком много
    if (textPoints.length > 300) {
        textPoints.length = 300;
    }

    const result = {
        fills: [],
        lines: [],
        strokes: [],
        buildings: [],
        points: points,
        textPoints: textPoints
    };

    for (const [key, triGroup] of fillsMap) {
        const merged = mergePolygonGeometries(triGroup);
        const parts = key.split(':');
        const avgSortKey = triGroup.reduce((sum, g) => sum + (g.sortKey || 0), 0) / triGroup.length;
        result.fills.push({
            positions: merged.positions,
            indices: merged.indices,
            layerName: parts[1],
            color: parseInt(parts[2], 16),
            opacity: parseFloat(parts[3]),
            renderOrder: (LAYER_RENDER_ORDER[parts[1]] ?? 1) + avgSortKey * 0.001
        });
    }

    for (const [key, lineGroup] of linesMap) {
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
            renderOrder: lineGroup.renderOrder + avgSortKey * 0.001
        });
    }

    for (const [key, strokeGroup] of strokesMap) {
        const positions = createLinePositions(strokeGroup.map(s => s.ring));
        if (!positions) continue;
        const parts = key.split(':');
        const avgSortKey = strokeGroup.reduce((sum, s) => sum + (s.sortKey || 0), 0) / strokeGroup.length;
        result.strokes.push({
            positions,
            layerName: parts[1],
            color: parseInt(parts[2], 16),
            width: parseFloat(parts[3]),
            renderOrder: (LAYER_RENDER_ORDER[parts[1]] ?? 1) + 1 + avgSortKey * 0.001
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