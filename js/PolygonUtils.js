/**
 * PolygonUtils.ts — типы, константы и чистые вспомогательные функции
 * для Polygon.ts и PolygonLOD.ts.
 */
import { THREE } from './js_TP/tpb.js';
export const POLYGON_RENDER_ORDER = {
    BOTTOM: 900, SIDE: 901, TOP: 902, STROKE: 903,
};
export const INVALID_EDGE_FRACTION = 8;
export const DEFAULT_FILL_PATTERN_SCALE = 64;
export const REBUILD_DEBOUNCE_MS = 60;
// =====================================================================
// Pure helpers
// =====================================================================
export function crossY(p0, p1, p2) {
    const dx1 = p1.x - p0.x, dz1 = p1.y - p0.y;
    const dx2 = p2.x - p0.x, dz2 = p2.y - p0.y;
    return dz1 * dx2 - dx1 * dz2;
}
export function flipIndices(indices) {
    const result = new Array(indices.length);
    for (let i = 0; i < indices.length; i += 3) {
        result[i] = indices[i];
        result[i + 1] = indices[i + 2];
        result[i + 2] = indices[i + 1];
    }
    return result;
}
export function isPointInsideRings(rings, x, y) {
    let inside = false;
    for (const ring of rings) {
        const n = ring.length;
        if (n < 2)
            continue;
        for (let i = 0, j = n - 1; i < n; j = i++) {
            const a = ring[i], b = ring[j];
            if (((a[1] > y) !== (b[1] > y)) &&
                x < ((b[0] - a[0]) * (y - a[1])) / (b[1] - a[1]) + a[0]) {
                inside = !inside;
            }
        }
    }
    return inside;
}
export function minDistToRings(rings, x, y) {
    let bestSq = Infinity;
    for (const ring of rings) {
        const n = ring.length;
        if (n < 2)
            continue;
        for (let i = 0, j = n - 1; i < n; j = i++) {
            const a = ring[i], b = ring[j];
            const dx = b[0] - a[0], dy = b[1] - a[1];
            const l2 = dx * dx + dy * dy;
            let t = l2 > 0 ? ((x - a[0]) * dx + (y - a[1]) * dy) / l2 : 0;
            if (t < 0)
                t = 0;
            else if (t > 1)
                t = 1;
            const px = a[0] + t * dx, py = a[1] + t * dy;
            const ddx = x - px, ddy = y - py;
            const dSq = ddx * ddx + ddy * ddy;
            if (dSq < bestSq)
                bestSq = dSq;
        }
    }
    return Math.sqrt(bestSq);
}
export function approxVisualCenter(rings, precision = 0) {
    if (!rings || !rings.length)
        return null;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const ring of rings) {
        for (const p of ring) {
            if (!p)
                continue;
            if (p[0] < minX)
                minX = p[0];
            if (p[0] > maxX)
                maxX = p[0];
            if (p[1] < minY)
                minY = p[1];
            if (p[1] > maxY)
                maxY = p[1];
        }
    }
    if (!isFinite(minX))
        return null;
    const w = maxX - minX, h = maxY - minY;
    if (w < 1e-12 || h < 1e-12)
        return [(minX + maxX) / 2, (minY + maxY) / 2];
    let step = Math.min(w, h) / 10;
    let bx = (minX + maxX) / 2;
    let by = (minY + maxY) / 2;
    let bestD = -1;
    for (let iter = 0; iter < 3; iter++) {
        const sx = iter === 0 ? minX : bx - step * 2.5;
        const sy = iter === 0 ? minY : by - step * 2.5;
        const ex = iter === 0 ? maxX : bx + step * 2.5;
        const ey = iter === 0 ? maxY : by + step * 2.5;
        for (let x = sx; x <= ex; x += step) {
            for (let y = sy; y <= ey; y += step) {
                if (!isPointInsideRings(rings, x, y))
                    continue;
                const d = minDistToRings(rings, x, y);
                if (d > bestD) {
                    bestD = d;
                    bx = x;
                    by = y;
                }
            }
        }
        step /= 4;
        if (precision > 0 && step < precision)
            break;
    }
    return [bx, by];
}
// =====================================================================
// Shared pattern textures
// =====================================================================
const _sharedPatternTextures = new Map();
export function getSharedPatternTexture(url) {
    let tex = _sharedPatternTextures.get(url);
    if (tex)
        return tex;
    const loader = new THREE.TextureLoader();
    loader.setCrossOrigin('anonymous');
    tex = loader.load(url, undefined, undefined, (err) => {
        console.warn('Polygon: fillPattern load failed', url, err);
        _sharedPatternTextures.delete(url);
    });
    tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
    tex.generateMipmaps = false;
    tex.minFilter = THREE.LinearFilter;
    tex.magFilter = THREE.LinearFilter;
    _sharedPatternTextures.set(url, tex);
    return tex;
}
/** Не используется в показанном коде; сохранён для совместимости. */
export let _rebuildSlotCounter = 0;
