/**
 * Модуль слоя векторных тайлов (объёмные здания с выделением острых рёбер).
 */

import {
  THREE,
  Line2,
  LineMaterial,
  LineGeometry,
} from '../js_TP/tpb.js';

/**
 * Стили по умолчанию для различных типов объектов, сгруппированные по слоям.
 * (Документация сохранена в сокращённом виде, подробности в оригинале)
 */
const DEFAULT_STYLES = {
    water: {
        lake: { color: 0xaaccff, opacity: 0.9 },
        river: { color: 0x99bbee, opacity: 0.9 },
        pond: { color: 0xaaccff, opacity: 0.8 },
        swimming_pool: { color: 0x88aadd, opacity: 0.8 },
        dock: { color: 0x8899aa, opacity: 0.8 },
        _default: { color: 0xaaccff, opacity: 0.9 }
    },
    waterway: { color: 0x99bbee, width: 1.5 },
    building: { color: 0xf0f0f0, stroke: 0xaaaaaa },
    landcover: {
        wood: { color: 0xc8e6c9 },
        forest: { color: 0xc8e6c9 },
        grass: { color: 0xdcedc8 },
        park: { color: 0xdcedc8 },
        sand: { color: 0xf5f0c0 },
        farmland: { color: 0xedf0c0 },
        wetland: { color: 0xb8d4c8 },

    },
    landuse: {
        residential: { color: 0xe0e0e0 },
        industrial: { color: 0xd9d9d9 },
        commercial: { color: 0xdddddd },
        railway: { color: 0xd5d5d5 },
        retail: { color: 0xdddddd },
        hospital: { color: 0xd9c8c8 },
        university: { color: 0xd5d5e0 },
        college: { color: 0xd5d5e0 },
        school: { color: 0xd5d5e0 },
        education: { color: 0xd5d5e0 },
        kindergarten: { color: 0xd5d5e0 },
        library: { color: 0xd5d5e0 },
        cemetery: { color: 0xbbddbb },
        military: { color: 0xc8c8c8 },
        allotments: { color: 0xdcedc8 },
        quarry: { color: 0xbbaa99 },
        construction: { color: 0xcccccc },
        pitch: { color: 0xc8e6c9 },
        stadium: { color: 0xc8e6c9 },
        track: { color: 0xc8c8c8 },
        grass: { color: 0xdcedc8 },
        farmyard: { color: 0xedf0c0 },
        zoo: { color: 0xc8e6c9 },
        theme_park: { color: 0xc8e6c9 },
        resort: { color: 0xdcedc8 },
        recreation_ground: { color: 0xdcedc8 },
        exhibition_centre: { color: 0xdddddd },
        bus_station: { color: 0xdddddd },
        dam: { color: 0xaaaaaa },
        playground: { color: 0xdcedc8 },
        neighbourhood: { color: 0xe8e8e8 },
        suburb: { color: 0xe8e8e8 },
        quarter: { color: 0xe8e8e8 },
        garages: { color: 0xd0d0d0 },
        healthcare: { color: 0xd9c8c8 },
        _default: { color: 0xeeeeee }
    },
    park: {
        park: { color: 0xdcedc8 },
        national_park: { color: 0xb8d8a0 },
        nature_reserve: { color: 0xb8d8a0 },
        protected_area: { color: 0xb8d8a0 },
        _default: { color: 0xdcedc8 }
    },
    transportation: {
        motorway:          { color: 0xff9933, width: 2.5 },
        trunk:             { color: 0xffcc66, width: 2.0 },
        primary:           { color: 0xffd699, width: 1.8 },
        secondary:         { color: 0xffe0b3, width: 1.5 },
        tertiary:          { color: 0xffffff, width: 1.2 },
        minor:             { color: 0xeeeeee, width: 1.0 },
        residential:       { color: 0xeeeeee, width: 1.0 },
        path:              { color: 0xaaaaaa, width: 0.8 },
        track:             { color: 0xaaaaaa, width: 0.8 },
        rail:              { color: 0x888888, width: 1.5, dash: [6, 2] },
        ferry:             { color: 0x6699cc, width: 1.2, dash: [4, 4] },
        aerialway:         { color: 0x666666, width: 1.0, dash: [2, 2] },
        bridge:            { color: 0xffaa00, width: 2.0 },
        pier:              { color: 0xcccccc, width: 1.0 },
        raceway:           { color: 0xff6666, width: 1.5 },
        service:           { color: 0xcccccc, width: 0.8 },
        transit:           { color: 0xdddddd, width: 1.2 },
        motorway_construction: { color: 0xff9933, width: 2.5, dash: [8, 4] },
        trunk_construction:    { color: 0xffcc66, width: 2.0, dash: [8, 4] },
        primary_construction:  { color: 0xffd699, width: 1.8, dash: [8, 4] },
        secondary_construction:{ color: 0xffe0b3, width: 1.5, dash: [8, 4] },
        tertiary_construction: { color: 0xffffff, width: 1.2, dash: [8, 4] },
        minor_construction:    { color: 0xeeeeee, width: 1.0, dash: [8, 4] },
        service_construction:  { color: 0xcccccc, width: 0.8, dash: [8, 4] },
        path_construction:     { color: 0xaaaaaa, width: 0.8, dash: [6, 3] },
        _default:             { color: 0xcccccc, width: 1.0 }
    },
    transportation_name: {
        _default: { color: 0xffffff, width: 0.2, opacity: 0.3 }
    },
    aeroway: {
        runway: { color: 0xcccccc, width: 2.0 },
        taxiway: { color: 0xdddddd, width: 1.0 },
        _default: { color: 0xcccccc, width: 1.0 }
    },
    place: {
        city: { 
            color: 0xe8e8e8, stroke: 0xcccccc, opacity: 0.7, radius: 5,
            textColor: '#333333', fontSize: '14px', fontWeight: 'bold',
            textOffset: [0, -10], textZoomMin: 0, textZoomMax: 24
        },
        town: { 
            color: 0xe8e8e8, stroke: 0xcccccc, opacity: 0.6, radius: 4,
            textColor: '#333333', fontSize: '13px', fontWeight: 'bold',
            textOffset: [0, -8], textZoomMin: 0, textZoomMax: 24
        },
        village: { 
            color: 0xe8e8e8, stroke: 0xcccccc, opacity: 0.5, radius: 3,
            textColor: '#333333', fontSize: '12px', fontWeight: 'normal',
            textOffset: [0, -6], textZoomMin: 0, textZoomMax: 24
        },
        hamlet: { 
            color: 0xe8e8e8, stroke: 0xcccccc, opacity: 0.4, radius: 2,
            textColor: '#333333', fontSize: '11px', fontWeight: 'normal',
            textOffset: [0, -4], textZoomMin: 0, textZoomMax: 24
        },
        _default: { 
            color: 0xe8e8e8, opacity: 0.5, radius: 3,
            textColor: '#333333', fontSize: '12px',
            textOffset: [0, -6], textZoomMin: 0, textZoomMax: 24
        }
    },
    poi: {
        _default: { 
            color: 0xcccccc, radius: 4,
            textColor: '#555555', fontSize: '11px', fontWeight: 'normal',
            textOffset: [0, -8], textZoomMin: 13, textZoomMax: 24
        }
    },
    housenumber: {
        _default: { 
            color: 0xffffff, radius: 2,
            textColor: '#333333', fontSize: '10px', fontWeight: 'normal',
            textOffset: [0, -4], textZoomMin: 16, textZoomMax: 24
        }
    },
    mountain_peak: {
        _default: { color: 0xffffff, radius: 3 }
    },
    boundary: { color: 0x999999, width: 1.0, dash: [4, 2] },
    water_name: {
        _default: { color: 0xaaccff, width: 0.2, opacity: 0.3 }
    },
};

/**
 * Порядок отрисовки слоёв.
 */
const LAYER_RENDER_ORDER = {
    water: 1,
    waterway: 2,
    water_name: 3,
    landuse: 0,
    landcover: 0,
    park: 0,
    building: 7,
    place: 4,
    boundary: 4,
    aeroway: 10,
    transportation: 15,
    transportation_name: 16,
    poi: 20,
    housenumber: 21,
    mountain_peak: 20,
};

// -----------------------------------------------------------------------------
// Генерация кода модульного воркера (с data: URL для библиотек)
// -----------------------------------------------------------------------------
function createWorkerCode(tpbDataURL, earcutDataURL) {
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
            visibleLayers, buildings3dMinZoom
        } = msg;
        try {
            const tile = new VectorTile(new Protobuf(buffer));
            const result = processTile(
                tile, z, x, y, tileSize, maxMerc, is3d,
                visibleLayers, buildings3dMinZoom
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

function extrudeBuilding(rings, height, minHeight = 0, eps) {
    if (!rings || rings.length === 0 || height <= 0) return null;
    const cleaned = rings.map(r => dedupRing(r, eps)).filter(r => r.length >= 3);
    if (cleaned.length === 0) return null;

    const polygons = [];
    for (const ring of cleaned) {
        if (ringArea(ring) > 0) polygons.push({ outer: ring, holes: [] });
        else if (polygons.length > 0) polygons[polygons.length - 1].holes.push(ring);
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
            const a = indices[i], b = indices[i+1], c = indices[i+2];
            positions.push(
                vertices[a*2], height, vertices[a*2+1],
                vertices[b*2], height, vertices[b*2+1],
                vertices[c*2], height, vertices[c*2+1]
            );
            normals.push(0,1,0, 0,1,0, 0,1,0);
        }
        if (minHeight > 0) {
            for (let i = 0; i < indices.length; i += 3) {
                const a = indices[i], b = indices[i+1], c = indices[i+2];
                positions.push(
                    vertices[a*2], minHeight, vertices[a*2+1],
                    vertices[c*2], minHeight, vertices[c*2+1],
                    vertices[b*2], minHeight, vertices[b*2+1]
                );
                normals.push(0,-1,0, 0,-1,0, 0,-1,0);
            }
        }

        for (const ring of [outer, ...holes]) {
            const n = ring.length;
            for (let i = 0; i < n; i++) {
                const p0 = ring[i], p1 = ring[(i + 1) % n];
                const dx = p1.x - p0.x, dz = p1.z - p0.z;
                const len = Math.hypot(dx, dz);
                if (len < eps) continue;
                const nx = dz / len, nz = -dx / len;

                positions.push(
                    p0.x, minHeight, p0.z,  p1.x, minHeight, p1.z,  p1.x, height, p1.z,
                    p0.x, minHeight, p0.z,  p1.x, height, p1.z,    p0.x, height, p0.z
                );
                for (let k = 0; k < 6; k++) normals.push(nx, 0, nz);

                edges.push(p0.x, height, p0.z, p1.x, height, p1.z);
                if (minHeight > 0) edges.push(p0.x, minHeight, p0.z, p1.x, minHeight, p1.z);

                const p2 = ring[(i + 2) % n];
                const dx2 = p2.x - p1.x, dz2 = p2.z - p1.z;
                const len2 = Math.hypot(dx2, dz2);
                if (len2 > eps && (dx * dx2 + dz * dz2) / (len * len2) < cornerCos) {
                    edges.push(p1.x, minHeight, p1.z, p1.x, height, p1.z);
                }
            }
        }
    }

    if (positions.length === 0) return null;
    return {
        positions: new Float32Array(positions),
        normals: new Float32Array(normals),
        edgePositions: edges.length ? new Float32Array(edges) : null
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

function processTile(tile, z, x, y, tileSize, maxMerc, is3d, visibleLayers, buildings3dMinZoom) {
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
                                const geo = extrudeBuilding(rings, height, minHeight, eps);
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

function _stringToBase64(str) {
    const bytes = new TextEncoder().encode(str);
    let binary = '';
    for (let i = 0; i < bytes.length; i++) {
        binary += String.fromCharCode(bytes[i]);
    }
    return btoa(binary);
}

// -----------------------------------------------------------------------------
// Класс источника подписи для точечных объектов векторных тайлов
// -----------------------------------------------------------------------------
class VectorPointLabelSource {
    constructor(map, worldX, worldZ, text, options = {}) {
        this.map = map;
        this.worldPos = new THREE.Vector3(worldX, 0, worldZ);
        this.text = text;
        this.options = options;
    }

    getText() {
        return this.text;
    }

    getLabelType() {
        return 'point';
    }

    getScreenPosition() {
        const local = this.worldPos.clone().add(this.map.worldGroup.position);
        local.project(this.map.camera);
        const rect = this.map.renderer.domElement.getBoundingClientRect();
        return {
            x: (local.x * 0.5 + 0.5) * rect.width,
            y: (-local.y * 0.5 + 0.5) * rect.height
        };
    }

    getTextStyle() {
        return {
            color: this.options.textColor || '#333333',
            fontSize: this.options.fontSize || '12px',
            fontFamily: this.options.fontFamily || 'sans-serif',
            fontWeight: this.options.fontWeight || 'normal',
            textShadow: this.options.textShadow || ''
        };
    }

    getPriority() {
        return this.options.priority || 0;
    }

    getTitleAlign() {
        return this.options.textAlign || 'center';
    }

    getTitleVerticalAlign() {
        return this.options.textVerticalAlign || 'center';
    }

    getTitleOffset() {
        return this.options.textOffset || [0, 0];
    }

    getTextZoomBounds() {
        return this.options.zoomBounds || { min: 0, max: 24 };
    }

    isVisible() {
        return this.options.visible !== false;
    }
}

// -----------------------------------------------------------------------------
// Основной класс
// -----------------------------------------------------------------------------
export class VectorTileLayer {
    constructor(options = {}) {
        this.url = options.url;
        this.minZoom = options.minZoom ?? 0;
        this.maxZoom = options.maxZoom ?? Infinity;
        this.maxSourceZoom = options.maxSourceZoom ?? 14;
        this.lineWidthMultiplier = options.lineWidthMultiplier ?? 1.0;
        this.fillOpacity = options.fillOpacity ?? 1.0;
        this.depthTest = options.depthTest ?? false;
        this.visibleLayers = options.visibleLayers || null;

        this.buildings3d = options.buildings3d ?? true;
        this.buildings3dMinZoom = options.buildings3dMinZoom ?? 17;

        // Оптимизация подписей
        this.maxTextLabels = options.maxTextLabels ?? 500;
        this.maxTextPointsPerTile = options.maxTextPointsPerTile ?? 50;
        this.labelDistanceSortZoom = options.labelDistanceSortZoom ?? 17;
        this.labelMaxPerTileClose = options.labelMaxPerTileClose ?? 20;
        this.labelCullMargin = options.labelCullMargin ?? 50;

        this._debug = options.debug ?? false;
        this._discoveredClasses = new Map();

        this._styles = this._mergeStyles(DEFAULT_STYLES, options.styles || {});

        this._map = null;
        this._rootGroup = new THREE.Group();

        this._tileCache = new Map();
        this._pendingLoads = new Set();
        this._sortedLoadQueue = [];
        this._activeLoads = 0;
        this._maxConcurrent = 4;
        this._queueInterval = 250;

        this._lastSourceZoom = -1;
        this._lastDiscreteZoom = -1;
        this._lastUpdateTime = 0;
        this._throttle = 500;

        this._tileDataCache = new Map();
        this._oldTileGroups = null;
        this._oldTileCleanupTimer = null;
        this._groupCache = new Map();
        this._groupCacheMaxSize = 100;

        this._fillMaterialCache = new Map();
        this._lineMaterialCache = new Map();
        this._lineMaterialsSet = new Set();

        this._pointGeometryCache = new Map();

        this._lastCanvasSize = { width: 0, height: 0 };
        // Для отслеживания панорамирования и периодического обновления подписей
this._lastLabelPanUpdateTime = 0;
this._wasPanning = false;

        // Для отслеживания необходимости пересоздания подписей
this._lastLabelUpdateTarget = new THREE.Vector3();
this._lastLabelUpdateZoom = -1;
this._labelUpdateThreshold = options.labelUpdateThreshold ?? 80; // метров

        const rawScripts = options.workerScripts || ['https://cdn.mapengine.ru/KRB/js_TP/tpb.js', 'https://cdn.mapengine.ru/KRB/js_TP/earcut.js'];
        this._workerScriptUrls = rawScripts.map(s => {
            if (/^https?:\/\//i.test(s) || s.startsWith('/')) return s;
            try {
                return new URL(s, window.location.href).href;
            } catch (e) {
                console.error('Invalid worker script URL:', s, e);
                return s;
            }
        });
        if (this._workerScriptUrls.length < 2) {
            console.warn('VectorTileLayer: workerScripts должен содержать два URL (tpb.js и earcut.js).');
        }

        this._worker = null;
        this._workerReady = this._initWorker();
        this._requestId = 0;
        this._pendingWorkerRequests = new Map();
    }

    async _initWorker() {
        const [tpbUrl, earcutUrl] = this._workerScriptUrls;
        try {
            const [tpbResponse, earcutResponse] = await Promise.all([
                fetch(tpbUrl),
                fetch(earcutUrl)
            ]);
            const tpbCode = await tpbResponse.text();
            const earcutCode = await earcutResponse.text();

            const tpbDataURL = 'data:text/javascript;base64,' + _stringToBase64(tpbCode);
            const earcutDataURL = 'data:text/javascript;base64,' + _stringToBase64(earcutCode);

            const workerCode = createWorkerCode(tpbDataURL, earcutDataURL);
            const blob = new Blob([workerCode], { type: 'text/javascript' });
            this._worker = new Worker(URL.createObjectURL(blob), { type: 'module' });
            this._worker.onmessage = (e) => this._onWorkerMessage(e.data);
            this._worker.onerror = (err) => console.error('VectorTile worker error:', err);

            this._worker.postMessage({ type: 'config', styles: this._styles });
        } catch (err) {
            console.error('Failed to initialize worker:', err);
        }
    }

    _onWorkerMessage(data) {
        if (data.error) {
            const pending = this._pendingWorkerRequests.get(data.id);
            if (pending) {
                pending.reject(new Error(data.error));
                this._pendingWorkerRequests.delete(data.id);
            }
            return;
        }
        if (!data.result) return;
        const pending = this._pendingWorkerRequests.get(data.id);
        if (!pending) return;
        this._pendingWorkerRequests.delete(data.id);

        const result = data.result;
        const group = pending.group || new THREE.Group();
        this._buildGroupFromWorkerResult(group, result);
        if (!pending.group) {
            this._rootGroup.add(group);
            const key = pending.key;
            this._tileCache.set(key, group);
        }
        pending.resolve(group);
    }

    _buildGroupFromWorkerResult(group, result) {
        this._removeTextLabelsForGroup(group);

        while (group.children.length) {
            const child = group.children[0];
            if (child.geometry) child.geometry.dispose();
            if (child.material) {
                if (child.material.map) child.material.map.dispose();
                child.material.dispose();
            }
            group.remove(child);
        }

        for (const fill of result.fills) {
            const mat = this._getFillMaterialFromData(fill.layerName, fill.color, fill.opacity);
            const geom = new THREE.BufferGeometry();
            geom.setAttribute('position', new THREE.BufferAttribute(fill.positions, 3));
            if (fill.indices) geom.setIndex(new THREE.BufferAttribute(fill.indices, 1));
            const mesh = new THREE.Mesh(geom, mat);
            mesh.renderOrder = fill.renderOrder;
            group.add(mesh);
        }

        if (result.buildings.length > 0) {
            const byColor = new Map();
            for (const b of result.buildings) {
                const key = b.color;
                if (!byColor.has(key)) byColor.set(key, { color: b.color, stroke: b.stroke, pos: [], nrm: [], edg: [] });
                const g = byColor.get(key);
                g.pos.push(b.positions);
                g.nrm.push(b.normals);
                if (b.edgePositions) g.edg.push(b.edgePositions);
            }
            for (const g of byColor.values()) {
                const geom = new THREE.BufferGeometry();
                geom.setAttribute('position', new THREE.BufferAttribute(this._concatF32(g.pos), 3));
                geom.setAttribute('normal', new THREE.BufferAttribute(this._concatF32(g.nrm), 3));
                const mesh = new THREE.Mesh(geom, this._getBuildingMaterial(g.color));
                mesh.renderOrder = 50;
                group.add(mesh);

                if (g.edg.length) {
                    const eGeom = new THREE.BufferGeometry();
                    eGeom.setAttribute('position', new THREE.BufferAttribute(this._concatF32(g.edg), 3));
                    const lines = new THREE.LineSegments(eGeom, this._getBuildingEdgeMaterial(g.stroke || 0x555555));
                    lines.renderOrder = 51;
                    group.add(lines);
                }
            }
        }

        for (const line of result.lines) {
            const mat = this._getLineMaterialFromData(line.layerName, line.color, line.width, line.dash);
            const lGeo = new LineGeometry();
            lGeo.setPositions(line.positions);
            const lineObj = new Line2(lGeo, mat);
            lineObj.renderOrder = line.renderOrder;
            lineObj.frustumCulled = false;
            group.add(lineObj);
        }

        for (const stroke of result.strokes) {
            const mat = this._getLineMaterialFromData(stroke.layerName, stroke.color, stroke.width);
            const lGeo = new LineGeometry();
            lGeo.setPositions(stroke.positions);
            const lineObj = new Line2(lGeo, mat);
            lineObj.renderOrder = stroke.renderOrder;
            lineObj.frustumCulled = false;
            group.add(lineObj);
        }

        for (const pt of result.points) {
            const fillKey = `fill:${pt.layerName}:${pt.color.toString(16)}:${pt.opacity}`;
            const mat = this._getFillMaterial(fillKey);
            const geometry = this._getPointGeometry(pt.radius);
            const mesh = new THREE.Mesh(geometry, mat);
            mesh.position.set(pt.x, 0, pt.z);
            mesh.renderOrder = pt.renderOrder;
            group.add(mesh);
        }

        group.userData.textPointsData = result.textPoints || [];
        this._createTextLabelsForGroup(group);

        group.userData.is3d = result.is3d;
    }


/**
 * Пересоздаёт текстовые подписи для всех видимых тайлов из кэша.
 * Используется при панорамировании, чтобы обновить подписи без перестройки геометрии.
 */
_refreshTextLabelsForVisibleTiles() {
    if (!this._map || !this._map.textManager) return;
    this._tileCache.forEach(group => {
        this._createTextLabelsForGroup(group);
    });
}

    _createTextLabelsForGroup(group) {
        if (!this._map || !this._map.textManager) return;

        if (group.userData.textLabels) {
            this._removeTextLabelsForGroup(group);
        }
        group.userData.textLabels = [];

        const map = this._map;
        const textManager = map.textManager;
        const data = group.userData.textPointsData || [];

        if (!data.length) return;

        const continuousZoom = map.continuousZoom;
        const discreteZoom = map.currentDiscreteZoom;
        const camera = map.camera;
        const targetWorld = map.controls.target.clone();
        const worldOffset = map.worldGroup.position;
        const rect = map.renderer.domElement.getBoundingClientRect();
        const cullMargin = this.labelCullMargin ?? 50;

        const isClose = discreteZoom >= (this.labelDistanceSortZoom ?? 17);

        const candidates = [];

        for (const pt of data) {
            const zb = pt.zoomBounds || { min: 0, max: 24 };
            if (continuousZoom < zb.min || continuousZoom > zb.max) continue;

            const worldX = pt.x + worldOffset.x;
            const worldZ = pt.z + worldOffset.z;

            const dx = worldX - targetWorld.x;
            const dz = worldZ - targetWorld.z;
            const distSq = dx * dx + dz * dz;

            const worldPos = new THREE.Vector3(worldX, 0, worldZ);
            const ndc = worldPos.clone().project(camera);

            if (ndc.z > 1 || ndc.z < -1) continue;

            const sx = (ndc.x * 0.5 + 0.5) * rect.width;
            const sy = (-ndc.y * 0.5 + 0.5) * rect.height;

            if (
                sx < -cullMargin ||
                sx > rect.width + cullMargin ||
                sy < -cullMargin ||
                sy > rect.height + cullMargin
            ) {
                continue;
            }

            candidates.push({
                pt,
                distSq,
                priority: pt.priority || 0,
            });
        }

        if (isClose) {
            candidates.sort((a, b) => a.distSq - b.distSq || b.priority - a.priority);
        } else {
            candidates.sort((a, b) => b.priority - a.priority || a.distSq - b.distSq);
        }

        const maxPerTile = isClose
            ? Math.min(this.maxTextPointsPerTile, this.labelMaxPerTileClose ?? 20)
            : this.maxTextPointsPerTile;

        let finalData = candidates.slice(0, maxPerTile);

        if (textManager.labels && textManager.maxLabels !== undefined) {
            const currentCount = textManager.labels.length;
            const remaining = Math.max(0, this.maxTextLabels - currentCount);
            if (remaining <= 0) return;
            finalData = finalData.slice(0, Math.min(finalData.length, remaining));
        }

        for (const cand of finalData) {
            const pt = cand.pt;
            const source = new VectorPointLabelSource(map, pt.x, pt.z, pt.text, {
                textColor: pt.textColor,
                fontSize: pt.fontSize,
                fontFamily: pt.fontFamily,
                fontWeight: pt.fontWeight,
                textShadow: pt.textShadow,
                textOffset: pt.textOffset,
                textAlign: pt.textAlign,
                textVerticalAlign: pt.textVerticalAlign,
                priority: pt.priority,
                zoomBounds: pt.zoomBounds,
            });
            const label = textManager.addLabel(source);
            group.userData.textLabels.push(label);
        }
    }



    _removeTextLabelsForGroup(group) {
        if (group.userData.textLabels && this._map && this._map.textManager) {
            for (const label of group.userData.textLabels) {
                this._map.textManager.removeLabel(label);
            }
        }
        group.userData.textLabels = [];
    }

    _getFillMaterialFromData(layerName, color, opacity) {
        const key = `fill:${layerName}:${color.toString(16)}:${opacity}`;
        return this._getFillMaterial(key);
    }

    _getLineMaterialFromData(layerName, color, width, dash) {
        const dashKey = dash ? dash.join(',') : 'none';
        const key = `line:${layerName}:${color.toString(16)}:${width}:${dashKey}`;
        return this._getLineMaterial(key, dash);
    }

    // -------------------------------------------------------------------------
    // Публичные методы
    // -------------------------------------------------------------------------
    printDiscoveredClasses() {
        if (this._discoveredClasses.size === 0) {
            console.log('[VectorTileLayer] No classes discovered yet.');
            return;
        }
        console.log('[VectorTileLayer] Discovered classes:');
        this._discoveredClasses.forEach((classes, layer) => {
            console.log(`  ${layer}: [${Array.from(classes).join(', ')}]`);
        });
    }

    _mergeStyles(base, overrides) {
        const merged = JSON.parse(JSON.stringify(base));
        for (const [key, val] of Object.entries(overrides)) {
            if (val && typeof val === 'object' && !Array.isArray(val) && merged[key]) {
                merged[key] = this._mergeStyles(merged[key], val);
            } else {
                merged[key] = val;
            }
        }
        return merged;
    }

    addTo(map) {
        if (this._map) this.removeFromMap();
        this._map = map;
        map.worldGroup.add(this._rootGroup);
        if (!map._dynamicLayers.includes(this)) map._dynamicLayers.push(this);

        if (map.textManager && map.textManager.setMaxLabels) {
            map.textManager.setMaxLabels(this.maxTextLabels);
        }

        return this;
    }

    removeFromMap() {
        if (!this._map) return;
        this._clearAllTiles();
        this._rootGroup.parent?.remove(this._rootGroup);
        const idx = this._map._dynamicLayers.indexOf(this);
        if (idx > -1) this._map._dynamicLayers.splice(idx, 1);
        this._map = null;

        this._fillMaterialCache.forEach(m => m.dispose());
        this._lineMaterialCache.forEach(m => m.dispose());
        this._lineMaterialsSet.clear();
        this._fillMaterialCache.clear();
        this._lineMaterialCache.clear();
        this._pointGeometryCache.forEach(g => g.dispose());
        this._pointGeometryCache.clear();
        this._tileDataCache.clear();
        this._clearGroupCache();

        if (this._worker) {
            this._worker.terminate();
            this._worker = null;
        }
    }

    _clearAllTiles() {
        this._tileCache.forEach(group => this._disposeTile(group));
        this._tileCache.clear();
        this._pendingLoads.clear();
        this._sortedLoadQueue = [];
        this._clearOldTilesNow();
        this._activeLoads = 0;
    }

    _clearGroupCache() {
        this._groupCache.forEach(group => this._disposeTile(group));
        this._groupCache.clear();
    }

    _clearOldTilesNow() {
        if (this._oldTileCleanupTimer) {
            clearTimeout(this._oldTileCleanupTimer);
            this._oldTileCleanupTimer = null;
        }
        if (this._oldTileGroups) {
            this._oldTileGroups.forEach(group => this._disposeTile(group));
            this._oldTileGroups = null;
        }
    }

    _disposeTile(group) {
        this._removeTextLabelsForGroup(group);
        while (group.children.length) {
            const child = group.children[0];
            if (child.geometry) child.geometry.dispose();
            if (child.material) {
                if (child.material.map) child.material.map.dispose();
                child.material.dispose();
            }
            group.remove(child);
        }
        this._rootGroup.remove(group);
    }

    _removeTile(key, group) {
        this._rootGroup.remove(group);
        this._tileCache.delete(key);
        if (!this._groupCache.has(key)) {
            this._removeTextLabelsForGroup(group);
            this._groupCache.set(key, group);
            if (this._groupCache.size > this._groupCacheMaxSize) {
                const oldestKey = this._groupCache.keys().next().value;
                this._disposeTile(this._groupCache.get(oldestKey));
                this._groupCache.delete(oldestKey);
            }
        } else {
            this._disposeTile(group);
        }
    }

    _scheduleOldTilesCleanup(delay = 2000) {
        if (this._oldTileCleanupTimer) clearTimeout(this._oldTileCleanupTimer);
        this._oldTileCleanupTimer = setTimeout(() => {
            if (this._sortedLoadQueue.length > 0 || this._activeLoads > 0) {
                this._oldTileCleanupTimer = setTimeout(() => this._clearOldTilesNow(), 1000);
            } else {
                this._clearOldTilesNow();
            }
        }, delay);
    }

    _postUpdate(map) {
        if (!this._map) return;
        const now = performance.now();
        if (now - this._lastUpdateTime < this._throttle) {
            this._processQueue();
            return;
        }
        this._lastUpdateTime = now;

        const discreteZoom = map.currentDiscreteZoom;
        if (discreteZoom < this.minZoom || discreteZoom > this.maxZoom) {
            if (this._tileCache.size > 0 || this._oldTileGroups) this._clearAllTiles();
            this._lastSourceZoom = -1;
            this._lastDiscreteZoom = -1;
            return;
        }

        if (this._lastDiscreteZoom !== -1 && discreteZoom !== this._lastDiscreteZoom) {
            const was3d = this._lastDiscreteZoom >= this.buildings3dMinZoom;
            const is3d = discreteZoom >= this.buildings3dMinZoom;
            if (was3d !== is3d) {
                this._lastSourceZoom = -1;
            }
        }
        this._lastDiscreteZoom = discreteZoom;

        const sourceZoom = Math.max(this.minZoom, Math.min(discreteZoom, this.maxSourceZoom));

        if (sourceZoom !== this._lastSourceZoom) {
            this._clearOldTilesNow();
            if (this._tileCache.size > 0) {
                this._oldTileGroups = new Map(this._tileCache);
                this._oldTileGroups.forEach(group => {
                    group.traverse(child => {
                        if (child.isMesh || child.isLine2) {
                            child.renderOrder = Math.max(0, (child.renderOrder || 0) - 2);
                        }
                    });
                });
            }
            this._tileCache = new Map();
            this._pendingLoads.clear();
            this._sortedLoadQueue = [];
            this._lastSourceZoom = sourceZoom;
            this._scheduleOldTilesCleanup(3000);
        }

        const canvas = map.renderer.domElement;
        const w = canvas.width, h = canvas.height;
        if (this._lineMaterialsSet.size > 0 &&
            (this._lastCanvasSize.width !== w || this._lastCanvasSize.height !== h)) {
            this._lastCanvasSize.width = w;
            this._lastCanvasSize.height = h;
            const res = new THREE.Vector2(w, h);
            this._lineMaterialsSet.forEach(mat => mat.resolution.copy(res));
        }

        const visibleTiles = this._getVisibleTileKeys(sourceZoom);

        for (const key of this._tileCache.keys()) {
            if (!visibleTiles.has(key)) {
                const group = this._tileCache.get(key);
                this._removeTile(key, group);
                this._pendingLoads.delete(key);
            }
        }

                // Пересоздание подписей при панорамировании
        const isPanning = this._map.isDragging || this._map.touchDragActive;
        const now = performance.now();

        // Во время панорамирования обновляем подписи раз в секунду
        if (isPanning && (now - this._lastLabelPanUpdateTime > 1000)) {
            this._lastLabelPanUpdateTime = now;
            this._refreshTextLabelsForVisibleTiles();
        }

        // При завершении панорамирования обновляем немедленно
        if (!isPanning && this._wasPanning) {
            this._refreshTextLabelsForVisibleTiles();
        }

        this._wasPanning = isPanning;

        // Пересоздание подписей при значительном смещении камеры или изменении зума
        const distanceMovedSq = this._lastLabelUpdateTarget.distanceToSquared(map.controls.target);
        const zoomChanged = Math.abs(this._lastLabelUpdateZoom - discreteZoom) > 0.01;

        if (distanceMovedSq > this._labelUpdateThreshold * this._labelUpdateThreshold || zoomChanged) {
            this._lastLabelUpdateTarget.copy(map.controls.target);
            this._lastLabelUpdateZoom = discreteZoom;

            // Пересоздаём подписи для всех активных тайлов
            this._tileCache.forEach(group => {
                this._createTextLabelsForGroup(group);
            });
        }

        const maxMerc = map.MAX_MERCATOR;
        const target = map.controls.target;
        const tileSizeAtZoom = map.WORLD_SIZE / (1 << sourceZoom);

        const newKeys = Array.from(visibleTiles)
            .filter(key => !this._tileCache.has(key) && !this._pendingLoads.has(key))
            .sort((a, b) => {
                const [, xa, ya] = a.split(',').map(Number);
                const [, xb, yb] = b.split(',').map(Number);
                const cxa = xa * tileSizeAtZoom - maxMerc + tileSizeAtZoom / 2;
                const cza = -maxMerc + ya * tileSizeAtZoom + tileSizeAtZoom / 2;
                const cxb = xb * tileSizeAtZoom - maxMerc + tileSizeAtZoom / 2;
                const czb = -maxMerc + yb * tileSizeAtZoom + tileSizeAtZoom / 2;
                const dax = cxa - target.x, daz = cza - target.z;
                const dbx = cxb - target.x, dbz = czb - target.z;
                return (dax * dax + daz * daz) - (dbx * dbx + dbz * dbz);
            });

        this._sortedLoadQueue = newKeys.concat(
            this._sortedLoadQueue.filter(k =>
                !this._tileCache.has(k) && !this._pendingLoads.has(k) && visibleTiles.has(k)
            )
        );
        this._processQueue();
    }

    _processQueue() {
        if (this._activeLoads >= this._maxConcurrent) return;
        if (this._sortedLoadQueue.length === 0) {
            if (this._oldTileGroups && this._activeLoads === 0) this._scheduleOldTilesCleanup(500);
            return;
        }
        const toLoad = this._sortedLoadQueue.splice(0, this._maxConcurrent - this._activeLoads);
        toLoad.forEach(key => {
            const [z, x, y] = key.split(',').map(Number);
            this._loadTile(z, x, y);
        });
        if (this._sortedLoadQueue.length > 0) {
            clearTimeout(this._queueTimer);
            this._queueTimer = setTimeout(() => this._processQueue(), this._queueInterval);
        }
    }

    async _loadTile(z, xSlippy, ySlippy) {
        const key = `${z},${xSlippy},${ySlippy}`;
        if (this._pendingLoads.has(key) || this._tileCache.has(key)) return;

        if (this._groupCache.has(key)) {
            const group = this._groupCache.get(key);
            this._groupCache.delete(key);
            const is3dNow = this.buildings3d && (this._map?.currentDiscreteZoom ?? 0) >= this.buildings3dMinZoom;
            if (group.userData.is3d !== is3dNow) {
                const dataCacheKey = `${z}/${xSlippy}/${ySlippy}`;
                const buffer = this._tileDataCache.get(dataCacheKey);
                if (buffer) {
                    this._pendingLoads.add(key);
                    this._activeLoads++;
                    try {
                        await this._sendToWorker(buffer.slice(0), z, xSlippy, ySlippy, is3dNow, group);
                        this._rootGroup.add(group);
                        this._tileCache.set(key, group);
                    } finally {
                        this._pendingLoads.delete(key);
                        this._activeLoads--;
                        this._processQueue();
                    }
                    return;
                }
                this._disposeTile(group);
            } else {
                this._rootGroup.add(group);
                this._tileCache.set(key, group);
                this._createTextLabelsForGroup(group);
                return;
            }
        }

        this._pendingLoads.add(key);
        this._activeLoads++;
        const dataCacheKey = `${z}/${xSlippy}/${ySlippy}`;
        try {
            let buffer;
            if (this._tileDataCache.has(dataCacheKey)) {
                buffer = this._tileDataCache.get(dataCacheKey).slice(0);
            } else {
                const url = this.url.replace('{z}', z).replace('{x}', xSlippy).replace('{y}', ySlippy);
                const response = await fetch(url);
                if (!response.ok) throw new Error(`HTTP ${response.status}`);
                buffer = await response.arrayBuffer();
                this._tileDataCache.set(dataCacheKey, buffer.slice(0));
            }

            const is3dNow = this.buildings3d && (this._map?.currentDiscreteZoom ?? 0) >= this.buildings3dMinZoom;
            const group = await this._sendToWorker(buffer, z, xSlippy, ySlippy, is3dNow);
            this._rootGroup.add(group);
            this._tileCache.set(key, group);
        } catch (err) {
            // игнорируем ошибки загрузки
        } finally {
            this._pendingLoads.delete(key);
            this._activeLoads--;
            if (this._sortedLoadQueue.length > 0) {
                clearTimeout(this._queueTimer);
                this._queueTimer = setTimeout(() => this._processQueue(), this._queueInterval);
            } else if (this._activeLoads === 0 && this._oldTileGroups) {
                this._clearOldTilesNow();
            }
        }
    }

    async _sendToWorker(buffer, z, x, y, is3d, existingGroup) {
        await this._workerReady;
        return new Promise((resolve, reject) => {
            const id = ++this._requestId;
            const tileSize = this._map.WORLD_SIZE / (1 << z);
            const maxMerc = this._map.MAX_MERCATOR;

            const msg = {
                type: 'process',
                id,
                buffer: buffer,
                z, x, y,
                tileSize,
                maxMerc,
                is3d,
                visibleLayers: this.visibleLayers,
                buildings3dMinZoom: this.buildings3dMinZoom
            };

            this._pendingWorkerRequests.set(id, {
                resolve,
                reject,
                group: existingGroup || null,
                key: existingGroup ? null : `${z},${x},${y}`,
            });
            this._worker.postMessage(msg, [buffer]);
        });
    }

    _getVisibleTileKeys(z) {
        const map = this._map;
        const camera = map.camera;
        const target = map.controls.target;
        const distance = camera.position.distanceTo(target);
        const tileSize = map.WORLD_SIZE / (1 << z);
        const margin = 1;
        const vFov = camera.fov * Math.PI / 180;
        const aspect = camera.aspect;
        const hh = distance * Math.tan(vFov / 2) * aspect + margin * tileSize;
        const hv = distance * Math.tan(vFov / 2) + margin * tileSize;
        const off = map.worldGroup.position;
        const minX = target.x - hh, maxX = target.x + hh;
        const minZ = target.z - hv, maxZ = target.z + hv;
        const maxTile = (1 << z) - 1;
        const numTiles = 1 << z;
        const xMin = Math.floor((minX - off.x + map.MAX_MERCATOR) / tileSize);
        const xMax = Math.floor((maxX - off.x + map.MAX_MERCATOR) / tileSize);
        const yMin = Math.max(0, Math.floor((minZ - off.z + map.MAX_MERCATOR) / tileSize));
        const yMax = Math.min(maxTile, Math.floor((maxZ - off.z + map.MAX_MERCATOR) / tileSize));
        const keys = new Set();
        for (let y = yMin; y <= yMax; y++) {
            for (let x = xMin; x <= xMax; x++) {
                keys.add(`${z},${((x % numTiles) + numTiles) % numTiles},${y}`);
            }
        }
        return keys;
    }

    // -------------------------------------------------------------------------
    // Кеширование материалов
    // -------------------------------------------------------------------------
    _getFillMaterial(styleKey) {
        if (this._fillMaterialCache.has(styleKey)) return this._fillMaterialCache.get(styleKey);
        const parts = styleKey.split(':');
        const color = parseInt(parts[2], 16);
        const opacity = parseFloat(parts[3]) * this.fillOpacity;
        const mat = new THREE.MeshBasicMaterial({
            color,
            side: THREE.DoubleSide,
            transparent: opacity < 1,
            opacity,
            depthTest: true,
            depthWrite: false
        });
        this._fillMaterialCache.set(styleKey, mat);
        return mat;
    }

    _getLineMaterial(styleKey, dash) {
        if (this._lineMaterialCache.has(styleKey)) return this._lineMaterialCache.get(styleKey);
        const parts = styleKey.split(':');
        const color = parseInt(parts[2], 16);
        const width = parseFloat(parts[3]) * this.lineWidthMultiplier;
        const matOpts = {
            color,
            linewidth: width,
            resolution: new THREE.Vector2(
                this._map.renderer.domElement.width,
                this._map.renderer.domElement.height
            ),
            depthTest: true,
            depthWrite: false
        };
        if (dash && Array.isArray(dash) && dash.length >= 2) {
            matOpts.dashed = true;
            matOpts.dashSize = dash[0];
            matOpts.gapSize = dash[1];
            matOpts.dashScale = 1;
        }
        const mat = new LineMaterial(matOpts);
        this._lineMaterialCache.set(styleKey, mat);
        this._lineMaterialsSet.add(mat);
        return mat;
    }

    _getPointGeometry(radius) {
        const key = `point_${radius}`;
        if (this._pointGeometryCache.has(key)) return this._pointGeometryCache.get(key);
        const geom = new THREE.CircleGeometry(radius, 8);
        geom.rotateX(-Math.PI / 2);
        this._pointGeometryCache.set(key, geom);
        return geom;
    }

    _concatF32(arrays) {
        let total = 0;
        for (const a of arrays) total += a.length;
        const out = new Float32Array(total);
        let off = 0;
        for (const a of arrays) { out.set(a, off); off += a.length; }
        return out;
    }

    _getBuildingMaterial(color) {
        const key = 'bld:' + color;
        if (this._fillMaterialCache.has(key)) return this._fillMaterialCache.get(key);
        const mat = new THREE.MeshLambertMaterial({
            color,
            side: THREE.DoubleSide,
            depthTest: true,
            depthWrite: true,
            polygonOffset: true,
            polygonOffsetFactor: 1,
            polygonOffsetUnits: 1
        });
        this._fillMaterialCache.set(key, mat);
        return mat;
    }

    _getBuildingEdgeMaterial(color) {
        const key = 'bldEdge:' + color;
        if (this._lineMaterialCache.has(key)) return this._lineMaterialCache.get(key);
        const mat = new THREE.LineBasicMaterial({ color, depthTest: true, depthWrite: false });
        this._lineMaterialCache.set(key, mat);
        return mat;
    }
}