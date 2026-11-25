export function triangleDebugEnabled() {
    return globalThis.__KRB_TRI_DEBUG === true;
}
/** Углы треугольника (в градусах) по трём 2D-точкам. */
function angles(p) {
    const out = [];
    for (let k = 0; k < 3; k++) {
        const A = p[k], B = p[(k + 1) % 3], C = p[(k + 2) % 3];
        const v1 = [B[0] - A[0], B[1] - A[1]], v2 = [C[0] - A[0], C[1] - A[1]];
        const d = v1[0] * v2[0] + v1[1] * v2[1];
        const m = Math.hypot(v1[0], v1[1]) * Math.hypot(v2[0], v2[1]);
        out.push(m > 0 ? Math.acos(Math.max(-1, Math.min(1, d / m))) * 180 / Math.PI : 0);
    }
    return out;
}
/**
 * Возвращает индекс треугольника (faceIndex) под курсором или null.
 * Использует тот же raycaster-подход, что и InteractionManager.
 */
export function pickFaceIndex(poly, raycaster, camera, ndc) {
    const mesh = poly._fillMesh;
    if (!mesh)
        return null;
    raycaster.setFromCamera(ndc, camera);
    const hits = raycaster.intersectObject(mesh, false);
    if (!hits.length)
        return null;
    return hits[0].faceIndex ?? null;
}
/**
 * Выводит в консоль всю информацию о треугольнике с номером faceIndex
 * (в топологии _cachedTopIndices) и возвращает его данные.
 */
export function logTriangle(poly, faceIndex) {
    const top = poly._cachedTopIndices;
    if (!top || faceIndex * 3 + 2 >= top.length) {
        console.warn('[tri-debug] faceIndex out of range', faceIndex);
        return;
    }
    const ia = top[faceIndex * 3], ib = top[faceIndex * 3 + 1], ic = top[faceIndex * 3 + 2];
    const wc = poly._worldCoords;
    const ll = poly._vertexLonLat;
    const hs = poly._nodeHeights;
    const ids = [ia, ib, ic];
    const world2 = ids.map(i => [wc[i][0], wc[i][1]]);
    const lonLats = ids.map(i => ll[i] ?? null);
    const ang = angles(world2);
    const dist = (p, q) => Math.hypot(q[0] - p[0], q[1] - p[1]);
    const edges = [dist(world2[0], world2[1]), dist(world2[1], world2[2]), dist(world2[2], world2[0])];
    const minAng = Math.min(...ang);
    const aspect = Math.max(...edges) / Math.max(1e-12, Math.min(...edges));
    // Соседи: треугольники, использующие то же ребро.
    const neighbours = [];
    const edgeKey = (a, b) => (a < b ? `${a},${b}` : `${b},${a}`);
    const mine = new Set([edgeKey(ia, ib), edgeKey(ib, ic), edgeKey(ic, ia)]);
    for (let f = 0; f * 3 + 2 < top.length; f++) {
        if (f === faceIndex)
            continue;
        const a = top[f * 3], b = top[f * 3 + 1], c = top[f * 3 + 2];
        const ks = [edgeKey(a, b), edgeKey(b, c), edgeKey(c, a)];
        if (ks.some(k => mine.has(k)))
            neighbours.push(f);
    }
    console.groupCollapsed(`[tri-debug] faceIndex=${faceIndex} polygon=${poly.name ?? '?'}`);
    console.log('vertex indices (_worldCoords):', ids);
    console.log('world (x,z):', world2);
    console.log('lon/lat:', lonLats);
    console.log('heights:', ids.map(i => hs[i]));
    console.log('angles, deg:', ang.map(a => +a.toFixed(3)));
    console.log('edge lengths (world):', edges.map(e => +e.toFixed(6)));
    console.log('min angle:', +minAng.toFixed(3), 'aspect:', +aspect.toFixed(2), 'thin(<10deg):', minAng < 10);
    console.log('neighbour faces:', neighbours);
    console.log('contourVertexCount:', poly._contourVertexCount);
    console.groupEnd();
}
/**
 * Удаляет треугольник из кэша топологии и пересобирает геометрию заливки.
 */
export function removeTriangle(poly, faceIndex) {
    const top = poly._cachedTopIndices;
    if (!top)
        return;
    top.splice(faceIndex * 3, 3);
    // Пересобираем заливку: геометрия строится из _cachedTopIndices.
    const geom = poly._fillGeometry;
    if (geom && geom.setIndex) {
        geom.setIndex(top.slice());
        geom.index.needsUpdate = true;
        geom.computeBoundingSphere?.();
    }
}
