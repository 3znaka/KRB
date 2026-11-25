/**
 * PolygonDiagnostics.ts — диагностика качества триангуляции полигонов на глобусе.
 *
 * Чистые функции, не меняют геометрию. Включаются флагом
 * `window.__KRB_TRI_DIAG = true` (см. Polygon._buildFillGeometry).
 * Результат пишется в console.table и накапливается в window.__KRB_TRI_STATS.
 */

export interface TriangleQualityStats {
    name: string;
    vertices: number;
    triangles: number;
    minAngleMin: number;        // наименьший угол по всем треугольникам, градусы
    minAngleP5: number;         // 5-й перцентиль минимального угла, градусы
    lt20: number;               // доля треугольников с мин. углом < 20°
    lt10: number;               // доля треугольников с мин. углом < 10°
    aspectGt10: number;         // доля с отношением max/min стороны > 10
}

const DEG = 180 / Math.PI;

/** Углы треугольника (в градусах) по трём точкам 2D. */
function triangleAngles(ax: number, ay: number, bx: number, by: number, cx: number, cy: number): [number, number, number] {
    const ab = Math.hypot(bx - ax, by - ay);
    const bc = Math.hypot(cx - bx, cy - by);
    const ca = Math.hypot(ax - cx, ay - cy);
    const clamp = (v: number) => Math.max(-1, Math.min(1, v));
    const A = Math.acos(clamp((ab * ab + ca * ca - bc * bc) / (2 * ab * ca || 1e-12)));
    const B = Math.acos(clamp((ab * ab + bc * bc - ca * ca) / (2 * ab * bc || 1e-12)));
    const C = Math.PI - A - B;
    return [A * DEG, B * DEG, C * DEG];
}

/**
 * Статистика качества треугольников.
 * @param coords  плоские координаты вершин [x0,y0,x1,y1,...] — в той же плоскости,
 *                где строилась триангуляция (для globe — азимутальная или lon/lat).
 * @param indices индексы треугольников (по 3 на треугольник).
 */
export function computeTriangleQuality(
    name: string, coords: ArrayLike<number>, indices: ArrayLike<number>,
): TriangleQualityStats {
    const minAngles: number[] = [];
    let lt20 = 0, lt10 = 0, aspect = 0;

    for (let i = 0; i + 2 < indices.length; i += 3) {
        const ia = indices[i] * 2, ib = indices[i + 1] * 2, ic = indices[i + 2] * 2;
        const ax = coords[ia], ay = coords[ia + 1];
        const bx = coords[ib], by = coords[ib + 1];
        const cx = coords[ic], cy = coords[ic + 1];

        const ab = Math.hypot(bx - ax, by - ay);
        const bc = Math.hypot(cx - bx, cy - by);
        const ca = Math.hypot(ax - cx, ay - cy);
        const minSide = Math.min(ab, bc, ca);
        const maxSide = Math.max(ab, bc, ca);
        if (!(minSide > 0)) {
            minAngles.push(0); lt20++; lt10++; aspect++;
            continue;
        }

        const [A, B, C] = triangleAngles(ax, ay, bx, by, cx, cy);
        const m = Math.min(A, B, C);
        minAngles.push(m);
        if (m < 20) lt20++;
        if (m < 10) lt10++;
        if (maxSide / minSide > 10) aspect++;
    }

    const n = minAngles.length;
    const sorted = minAngles.slice().sort((a, b) => a - b);
    const p5 = n ? sorted[Math.floor(0.05 * (n - 1))] : 0;

    return {
        name,
        vertices: coords.length / 2,
        triangles: n,
        minAngleMin: n ? sorted[0] : 0,
        minAngleP5: p5,
        lt20: n ? lt20 / n : 0,
        lt10: n ? lt10 / n : 0,
        aspectGt10: n ? aspect / n : 0,
    };
}

/** Записывает статистику в window.__KRB_TRI_STATS и выводит в консоль. */
export function recordTriangleQuality(stats: TriangleQualityStats): void {
    const g: any = typeof window !== 'undefined' ? window : globalThis;
    if (!g.__KRB_TRI_STATS) g.__KRB_TRI_STATS = [];
    g.__KRB_TRI_STATS.push(stats);
}

export function isTriDiagEnabled(): boolean {
    const g: any = typeof window !== 'undefined' ? window : globalThis;
    return g.__KRB_TRI_DIAG === true;
}
