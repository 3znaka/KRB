/**
 * Воркер упрощения LOD-колец (вынесено с главного потока).
 *
 * Воркер создаётся из blob-URL (как в Tiles.ts/VectorTileWorker.ts), поэтому
 * не зависит от того, как бандлер кладёт отдельные файлы. Тело воркера —
 * чистый JS без импортов: алгоритм Дугласа–Пекера из Simplify.ts, продублирован
 * здесь строкой, чтобы его можно было выполнить вне бандла.
 *
 * Вход (postMessage): { id, world: Float64Array(x,y пары), tolerance }
 * Выход:              { id, keptIdx: Int32Array }
 */
/** Исходный код воркера (строкой). Держится в синхроне с Simplify.ts. */
export const SIMPLIFY_WORKER_SOURCE = `
function douglasPeuckerIndices(points, tolerance) {
    const n = points.length;
    if (n < 3) return points.map((_, i) => i);
    const sqTol = tolerance * tolerance;
    const keep = new Uint8Array(n);
    keep[0] = 1; keep[n - 1] = 1;
    const stack = [[0, n - 1]];
    while (stack.length) {
        const pair = stack.pop();
        const first = pair[0], last = pair[1];
        const ax = points[first][0], ay = points[first][1];
        const bx = points[last][0], by = points[last][1];
        const dx = bx - ax, dy = by - ay;
        const lineLenSq = dx * dx + dy * dy;
        let maxDSq = 0, maxIdx = -1;
        for (let i = first + 1; i < last; i++) {
            let dSq;
            if (lineLenSq === 0) {
                const px = points[i][0] - ax, py = points[i][1] - ay;
                dSq = px * px + py * py;
            } else {
                let t = ((points[i][0] - ax) * dx + (points[i][1] - ay) * dy) / lineLenSq;
                if (t < 0) t = 0; else if (t > 1) t = 1;
                const cx = ax + t * dx, cy = ay + t * dy;
                const px = points[i][0] - cx, py = points[i][1] - cy;
                dSq = px * px + py * py;
            }
            if (dSq > maxDSq) { maxDSq = dSq; maxIdx = i; }
        }
        if (maxDSq > sqTol && maxIdx > 0) {
            keep[maxIdx] = 1;
            stack.push([first, maxIdx], [maxIdx, last]);
        }
    }
    const out = [];
    for (let i = 0; i < n; i++) if (keep[i]) out.push(i);
    return out;
}
function simplifyRingIndices(points, tolerance) {
    const n = points.length;
    if (n < 4) return points.map((_, i) => i);
    let farIdx = 1, maxDSq = 0;
    const ax = points[0][0], ay = points[0][1];
    for (let i = 1; i < n; i++) {
        const dx = points[i][0] - ax, dy = points[i][1] - ay;
        const dSq = dx * dx + dy * dy;
        if (dSq > maxDSq) { maxDSq = dSq; farIdx = i; }
    }
    const h1 = douglasPeuckerIndices(points.slice(0, farIdx + 1), tolerance);
    const h2 = douglasPeuckerIndices(points.slice(farIdx), tolerance);
    const out = h1.slice();
    for (let i = 1; i < h2.length; i++) out.push(farIdx + h2[i]);
    return out;
}
function centralAngleFlat(ecef, a, b) {
    const ax = ecef[a * 3], ay = ecef[a * 3 + 1], az = ecef[a * 3 + 2];
    const bx = ecef[b * 3], by = ecef[b * 3 + 1], bz = ecef[b * 3 + 2];
    const la = Math.sqrt(ax * ax + ay * ay + az * az);
    const lb = Math.sqrt(bx * bx + by * by + bz * bz);
    if (!(la > 1e-6) || !(lb > 1e-6)) return NaN;
    const c = (ax * bx + ay * by + az * bz) / (la * lb);
    return Math.acos(Math.max(-1, Math.min(1, c)));
}
/**
 * Полный путь упрощения кольца — тот же, что синхронный _getRenderRings:
 * DP → dedup совпадающих точек → восстановление длинных дуг по ECEF.
 */
function computeKept(world, tolerance, ecef, thrRad) {
    const n = world.length / 2;
    const pts = new Array(n);
    for (let i = 0; i < n; i++) pts[i] = [world[i * 2], world[i * 2 + 1]];
    let keptIdx = simplifyRingIndices(pts, tolerance);

    let effective = keptIdx.length;
    if (effective >= 2) {
        const a = pts[keptIdx[0]], b = pts[keptIdx[effective - 1]];
        if (a && b && a[0] === b[0] && a[1] === b[1]) effective--;
    }
    if (effective < 3 || keptIdx.length === n) return null; // без упрощения

    // dedup последовательных совпадающих точек, включая замыкающую
    const dedup = [];
    for (const idx of keptIdx) {
        const p = pts[idx];
        if (dedup.length) {
            const q = pts[dedup[dedup.length - 1]];
            if (p[0] === q[0] && p[1] === q[1]) continue;
        }
        dedup.push(idx);
    }
    while (dedup.length > 3) {
        const f = pts[dedup[0]], l = pts[dedup[dedup.length - 1]];
        if (f[0] === l[0] && f[1] === l[1]) dedup.pop(); else break;
    }
    if (dedup.length >= 3 && dedup.length < keptIdx.length) keptIdx = dedup;

    // восстановление длинных дуг
    if (ecef && thrRad > 0 && keptIdx.length >= 3) {
        const restored = [];
        for (let k = 0; k < keptIdx.length; k++) {
            const a = keptIdx[k];
            const b = keptIdx[(k + 1) % keptIdx.length];
            restored.push(a);
            const arc = centralAngleFlat(ecef, a, b);
            if (!Number.isFinite(arc) || arc <= thrRad) continue;
            const span = (b - a + n) % n;
            const parts = Math.ceil(arc / thrRad);
            const step = Math.max(1, Math.ceil(span / parts));
            for (let j = step; j < span; j += step) restored.push((a + j) % n);
        }
        if (restored.length > keptIdx.length) keptIdx = restored;
    }
    return keptIdx;
}
self.onmessage = function (ev) {
    const req = ev.data;
    const kept = computeKept(req.world, req.tolerance, req.ecef || null, req.thrRad || 0);
    const out = kept ? Int32Array.from(kept) : null;
    self.postMessage({ id: req.id, keptIdx: out }, out ? [out.buffer] : []);
};
`;
/** Создаёт воркер упрощения из blob-URL. Возвращает null, если недоступно. */
export function createSimplifyWorker() {
    if (typeof Worker === 'undefined' || typeof Blob === 'undefined' || typeof URL === 'undefined')
        return null;
    try {
        const blob = new Blob([SIMPLIFY_WORKER_SOURCE], { type: 'application/javascript' });
        return new Worker(URL.createObjectURL(blob));
    }
    catch {
        return null;
    }
}
