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
/**
 * Геодезическая интерполяция между двумя точками поверхности.
 *
 * На плоскости — линейная (обратная совместимость: результат совпадает с
 * прежним `lerp` по worldCoords).
 * На глобусе — проверка «дороже порога?» идёт по углу между
 * направлениями из центра Земли; промежуточные точки берутся сферической
 * интерполяцией (slerp) и нормируются на радиус поверхности, поэтому
 * дуга идёт по эллипсоиду, а не хордой сквозь него.
 *
 * @param t  0…1
 * @param a,b мировые точки (см. WorldPoint3)
 * @param R  радиус эллипсоида (world). Плоскому режиму не нужен.
 */
export function interpolateSurface(a, b, t, R) {
    const dx = b.x - a.x, dy = b.y - a.y, dz = b.z - a.z;
    const la = Math.sqrt(a.x * a.x + a.y * a.y + a.z * a.z);
    const lb = Math.sqrt(b.x * b.x + b.y * b.y + b.z * b.z);
    // Плоский мир (или вырожденные входы) — линейная интерполяция.
    if (!(R > 0) || !(la > 1e-6) || !(lb > 1e-6)) {
        return { x: a.x + dx * t, y: a.y + dy * t, z: a.z + dz * t };
    }
    // Угол между направлениями из центра — «цена» хорды.
    const cosA = Math.max(-1, Math.min(1, (a.x * b.x + a.y * b.y + a.z * b.z) / (la * lb)));
    const omega = Math.acos(cosA);
    if (!(omega > 1e-9))
        return { x: a.x + dx * t, y: a.y + dy * t, z: a.z + dz * t };
    const sinO = Math.sin(omega);
    const wa = Math.sin((1 - t) * omega) / sinO;
    const wb = Math.sin(t * omega) / sinO;
    const x = a.x * wa + b.x * wb;
    const y = a.y * wa + b.y * wb;
    const z = a.z * wa + b.z * wb;
    const len = Math.sqrt(x * x + y * y + z * z);
    // Радиус — линейно между фактическими |a| и |b| (учитывает высоты).
    const r = la + (lb - la) * t;
    const k = len > 1e-9 ? r / len : 1;
    return { x: x * k, y: y * k, z: z * k };
}
/**
 * Угол (рад) между направлениями из центра Земли на две точки.
 * Для плоского режима возвращает NaN — вызывающий использует длину хорды.
 */
export function centralAngle(a, b) {
    const la = Math.sqrt(a.x * a.x + a.y * a.y + a.z * a.z);
    const lb = Math.sqrt(b.x * b.x + b.y * b.y + b.z * b.z);
    if (!(la > 1e-6) || !(lb > 1e-6))
        return NaN;
    const c = (a.x * b.x + a.y * b.y + a.z * b.z) / (la * lb);
    return Math.acos(Math.max(-1, Math.min(1, c)));
}
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
export function hasGapMask(map) {
    if (!map)
        return false;
    // Глобус: плоской stencil-маски нет (см. Graticule._createStencilMask), поэтому
    // stencil-тест у полигонов и тайлов не нужен. Иначе они требуют Equal 1 и пропадают.
    if (map.globe) {
        map.__hasGapMaskCache = false;
        return false;
    }
    // Проверяем кэш (чтобы не тормозить)
    if (map.__hasGapMaskCache !== undefined)
        return map.__hasGapMaskCache;
    let found = false;
    // 1. Ищем Graticule в слоях
    const graticule = map._dynamicLayers?.find((l) => l.constructor?.name === 'Graticule' || l.name === 'graticule');
    if (graticule && graticule._maskEnabled !== false) {
        found = true;
    }
    // 2. Если не нашли, проверяем сцену
    if (!found) {
        map.worldGroup?.traverse((obj) => {
            if (obj.name === 'graticule-mask')
                found = true;
        });
    }
    map.__hasGapMaskCache = found;
    return found;
}
export function applyGapMaskToMaterial(material, map) {
    if (!material)
        return;
    if (hasGapMask(map)) {
        material.stencilWrite = true;
        material.stencilRef = 1;
        material.stencilFunc = THREE.EqualStencilFunc ?? 514;
        material.stencilFail = THREE.KeepStencilOp ?? 7680;
        material.stencilZFail = THREE.KeepStencilOp ?? 7680;
        material.stencilZPass = THREE.KeepStencilOp ?? 7680;
    }
    else {
        material.stencilWrite = false;
    }
    material.needsUpdate = true;
}
/** Не используется в показанном коде; сохранён для совместимости. */
export let _rebuildSlotCounter = 0;
// ---------------------------------------------------------------------
// Constrained Delaunay triangulation (cdt2d)
// ---------------------------------------------------------------------
import cdt2d from './js_TP/cdt2d.js';
import earcut from './js_TP/earcut.js';
/**
 * @param coords — все вершины: сначала контуры (внешнее кольцо, затем дыры),
 *   затем Steiner-точки без ограничений.
 * @param holeIndices — начало каждой дыры (в вершинах).
 * @param contourCount — сколько первых вершин принадлежат контурам (внешнее
 *   кольцо + дыры). Всё после них — Steiner, рёбер-ограничений не получает.
 */
/**
 * Полярные и разорванные по антимеридиану полигоны: earcut по контуру без
 * Steiner и CDT. Для них constrained-триангуляция в lon/lat даёт клинья и
 * пустоты, а earcut ведёт себя предсказуемо (как в исходной версии).
 */
export function triangulatePolygonEarcut(coords, holeIndices) {
    return earcut(coords, holeIndices, 2);
}
/**
 * Азимутальная равнодистантная проекция (lon/lat → локальная плоскость)
 * с центром в (centerLon, centerLat). Непрерывна через антимеридиан и
 * полюс — в отличие от развёртки lon/lat, где кольцо, охватывающее полюс
 * (Антарктида), разрывается скачком ±180° и earcut соединяет далёкие вершины.
 * Возвращает [x, y] в радианах относительно центра.
 */
export function azimuthalEquidistant(lon, lat, centerLon, centerLat) {
    const toRad = Math.PI / 180;
    const φ = lat * toRad, φ0 = centerLat * toRad;
    const Δλ = (lon - centerLon) * toRad;
    const cosC = Math.sin(φ0) * Math.sin(φ) + Math.cos(φ0) * Math.cos(φ) * Math.cos(Δλ);
    const c = Math.acos(Math.max(-1, Math.min(1, cosC)));
    if (c < 1e-12)
        return [0, 0];
    const k = c / Math.sin(c);
    const x = k * Math.cos(φ) * Math.sin(Δλ);
    const y = k * (Math.cos(φ0) * Math.sin(φ) - Math.sin(φ0) * Math.cos(φ) * Math.cos(Δλ));
    return [x, y];
}
/** Обратная к azimuthalEquidistant: плоские (x, y) → [lon, lat] в градусах. */
export function inverseAzimuthalEquidistant(x, y, centerLon, centerLat) {
    const toRad = Math.PI / 180;
    const φ0 = centerLat * toRad, λ0 = centerLon * toRad;
    const c = Math.hypot(x, y);
    if (c < 1e-12)
        return [centerLon, centerLat];
    const sinC = Math.sin(c), cosC = Math.cos(c);
    const φ = Math.asin(Math.max(-1, Math.min(1, cosC * Math.sin(φ0) + (y * sinC * Math.cos(φ0)) / c)));
    const λ = λ0 + Math.atan2(x * sinC, c * Math.cos(φ0) * cosC - y * Math.sin(φ0) * sinC);
    let lon = λ / toRad;
    while (lon > 180)
        lon -= 360;
    while (lon < -180)
        lon += 360;
    return [lon, φ / toRad];
}
/**
 * Центр локальной проекции для кольца: средняя точка единичных векторов
 * вершин (сферический центроид). Для полярного кольца это почти полюс,
 * для Антарктиды — ожидаемая точка «внутри» шапки.
 */
export function sphericalCentroidLonLat(lonLats) {
    const toRad = Math.PI / 180;
    let x = 0, y = 0, z = 0;
    for (const [lo, la] of lonLats) {
        const φ = la * toRad, λ = lo * toRad;
        x += Math.cos(φ) * Math.cos(λ);
        y += Math.cos(φ) * Math.sin(λ);
        z += Math.sin(φ);
    }
    const lat = Math.atan2(z, Math.sqrt(x * x + y * y)) / toRad;
    const lon = Math.atan2(y, x) / toRad;
    return [lon, lat];
}
export function triangulatePolygonCDT(coords, holeIndices, contourCount) {
    const n = coords.length / 2;
    if (n < 3)
        return [];
    const points = new Array(n);
    for (let i = 0; i < n; i++)
        points[i] = [coords[i * 2], coords[i * 2 + 1]];
    // Рёбра-ограничения — только по кольцам контура. Конец каждого кольца —
    // начало следующего (или contourCount для последнего), поэтому Steiner-точки
    // в замыкание колец не попадают.
    const starts = [0, ...holeIndices];
    const ends = [...holeIndices, contourCount];
    const edges = [];
    for (let r = 0; r < starts.length; r++) {
        const s = starts[r], e = ends[r];
        const len = e - s;
        if (len < 2)
            continue;
        for (let i = 0; i < len; i++)
            edges.push([s + i, s + ((i + 1) % len)]);
    }
    // Берём ВСЕ треугольники и сами отбираем внутренние: flood-fill cdt2d
    // (interior) отбрасывает всё, когда контур разорван антимеридианом или
    // полюсом. Критерий — центроид треугольника внутри полигона (even-odd).
    const tris = cdt2d(points, edges, { delaunay: true, interior: true, exterior: true });
    // Bounding box каждого кольца: точка вне bbox заведомо не даёт пересечений
    // с его рёбрами, и кольцо можно пропустить. Без этого проверка
    // «треугольник × все вершины» квадратична и на крупных полигонах
    // (Саха, Красноярский край) съедает секунды.
    const ringBox = starts.map((a, s) => {
        const b = ends[s];
        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
        for (let i = a; i < b; i++) {
            const px = points[i][0], py = points[i][1];
            if (px < minX)
                minX = px;
            if (px > maxX)
                maxX = px;
            if (py < minY)
                minY = py;
            if (py > maxY)
                maxY = py;
        }
        return { minX, minY, maxX, maxY };
    });
    const inside = (x, y) => {
        let c = false;
        for (let s = 0; s < starts.length; s++) {
            const box = ringBox[s];
            if (x < box.minX || x > box.maxX || y < box.minY || y > box.maxY)
                continue;
            const a = starts[s], b = ends[s];
            for (let i = a, j = b - 1; i < b; j = i++) {
                const xi = points[i][0], yi = points[i][1];
                const xj = points[j][0], yj = points[j][1];
                if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi)
                    c = !c;
            }
        }
        return c;
    };
    const out = [];
    for (const t of tris) {
        const a = points[t[0]], b = points[t[1]], c = points[t[2]];
        // Треугольник, у которого ребро пересекает разрыв развёртки (скачок
        // долготы около 180°), — ложный: на сфере он лежит снаружи. Отбрасываем.
        const cx = (a[0] + b[0] + c[0]) / 3, cy = (a[1] + b[1] + c[1]) / 3;
        if (!inside(cx, cy))
            continue;
        out.push(t[0], t[1], t[2]);
    }
    return out;
}
/**
 * Steiner-точки внутри полигона для глобуса, в lon/lat [lon, lat].
 *
 * Сетка идёт вдоль меридианов (шаг по широте stepLat) и по параллелям с
 * шагом, пропорциональным 1/cos(lat), чтобы ячейки на сфере были примерно
 * квадратными. Точка берётся только внутри контура (even-odd по всем
 * кольцам, дыры учитываются) и не ближе 0.5·шага к любому ребру — поэтому
 * constrained-рёбра не нарушаются, а треугольники остаются невырожденными.
 *
 * rings — кольца в lon/lat (первое — внешнее, остальные — дыры).
 * stepDeg — шаг по широте в градусах; ограничивается maxPoints.
 */
export function globeSteinerLonLat(rings, stepDeg, maxPoints) {
    if (!rings.length || !(stepDeg > 0))
        return [];
    const outer = rings[0];
    if (outer.length < 3)
        return [];
    let minLon = Infinity, maxLon = -Infinity, minLat = Infinity, maxLat = -Infinity;
    for (const [lo, la] of outer) {
        if (lo < minLon)
            minLon = lo;
        if (lo > maxLon)
            maxLon = lo;
        if (la < minLat)
            minLat = la;
        if (la > maxLat)
            maxLat = la;
    }
    if (!(maxLon > minLon) || !(maxLat > minLat))
        return [];
    // Шаг по широте, при котором число точек не превышает maxPoints.
    let stepLat = stepDeg;
    const estimate = (s) => {
        const midCos = Math.max(0.2, Math.cos(((minLat + maxLat) / 2) * Math.PI / 180));
        return ((maxLon - minLon) * midCos / s) * ((maxLat - minLat) / s);
    };
    while (estimate(stepLat) > maxPoints && stepLat < 90)
        stepLat *= 1.25;
    // Минимальный отступ от рёбер: половина шага — точки не вплотную к контуру.
    const minEdgeDist = stepLat * 0.5;
    const minEdgeDistSq = minEdgeDist * minEdgeDist;
    const inside = (x, y) => {
        let c = false;
        for (const ring of rings) {
            for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
                const xi = ring[i][0], yi = ring[i][1];
                const xj = ring[j][0], yj = ring[j][1];
                if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi)
                    c = !c;
            }
        }
        return c;
    };
    const distSqToEdges = (x, y) => {
        let best = Infinity;
        for (const ring of rings) {
            for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
                const ax = ring[j][0], ay = ring[j][1];
                const bx = ring[i][0], by = ring[i][1];
                const dx = bx - ax, dy = by - ay;
                const len2 = dx * dx + dy * dy;
                let t = len2 > 0 ? ((x - ax) * dx + (y - ay) * dy) / len2 : 0;
                t = t < 0 ? 0 : t > 1 ? 1 : t;
                const px = ax + t * dx - x, py = ay + t * dy - y;
                const d2 = px * px + py * py;
                if (d2 < best)
                    best = d2;
            }
        }
        return best;
    };
    const out = [];
    for (let lat = minLat + stepLat / 2; lat < maxLat; lat += stepLat) {
        // Шаг по долготе, согласованный с широтой: ячейка ~квадратная на сфере.
        const cosLat = Math.max(0.2, Math.cos(lat * Math.PI / 180));
        const stepLon = stepLat / cosLat;
        for (let lon = minLon + stepLon / 2; lon < maxLon; lon += stepLon) {
            if (!inside(lon, lat))
                continue;
            if (distSqToEdges(lon, lat) < minEdgeDistSq)
                continue;
            out.push([lon, lat]);
            if (out.length >= maxPoints)
                return out;
        }
    }
    return out;
}
