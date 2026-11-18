/**
 * UnitScale — приведение единиц проекции к реальным метрам при экспорте.
 *
 * Калибровка по экватору: коэффициент подбирается так, чтобы ширина
 * экватора в единицах карты совпала с длиной экватора эллипсоида в метрах.
 * Это ровно то, что проверяется линейкой в ГИС «от края до края по экватору».
 *
 * @module UnitScale
 */

import type { CrsLike, GeoJSONGeometry } from './GeoJSONExportable.js';

// ─────────────────────────────────────────────────────────────────
// Константы
// ─────────────────────────────────────────────────────────────────

/** Большая полуось WGS84 — fallback, если у СК нет своего эллипсоида. */
const EARTH_A_WGS84 = 6378137;

/** Шаг сэмплирования экватора, градусы. */
const EQUATOR_STEP_DEG = 1;

/** Кэш коэффициента на объект проекции (проекции неизменяемы). */
let cache = new WeakMap<object, number>();

// ─────────────────────────────────────────────────────────────────
// Калибровка
// ─────────────────────────────────────────────────────────────────

/**
 * Коэффициент, на который надо умножить координаты проекции, чтобы длина
 * экватора в единицах карты равнялась длине экватора эллипсоида в метрах.
 *
 * Для географических (градусы) и геоцентрических (ECEF, уже метры) СК
 * всегда возвращает 1 — масштабировать их нельзя.
 *
 * Результат кэшируется на объекте проекции.
 *
 * @example
 * computeUnitScale(Projections.get('ADPKP:0072')); // ≈ 1.2076901
 * computeUnitScale(Projections.get('EPSG:3857'));  // 1 (уже 1:1)
 * computeUnitScale(Projections.get('EPSG:4326'));  // 1 (градусы)
 */
export function computeUnitScale(crs: CrsLike): number {
    if (!crs || typeof crs.fromLonLat !== 'function') return 1;
    const hit = cache.get(crs);
    if (hit !== undefined) return hit;
    const value = measureEquator(crs);
    cache.set(crs, value);
    return value;
}

/** Сброс кэша: одной проекции или всего (после перерегистрации СК). */
export function resetUnitScaleCache(crs?: CrsLike): void {
    if (crs) cache.delete(crs);
    else cache = new WeakMap<object, number>();
}

function measureEquator(crs: CrsLike): number {
    const code = (crs as any).code ?? '?';

    if ((crs as any).isGeographic) {
        console.log(`[UnitScale] ${code}: географическая СК (градусы) → 1`);
        return 1;
    }
    if ((crs as any).isGeocentric) {
        console.log(`[UnitScale] ${code}: ECEF (уже метры) → 1`);
        return 1;
    }

    // Защита от «на самом деле градусы»: fromLonLat — тождество.
    const o = crs.fromLonLat([0, 0]);
    const e = crs.fromLonLat([1, 0]);
    if (!o || !e || !Number.isFinite(o[0]) || !Number.isFinite(e[0])) {
        console.warn(`[UnitScale] ${code}: fromLonLat не дал валидных проб → 1`);
        return 1;
    }
    if (Math.abs(e[0] - o[0] - 1) < 1e-6 && Math.abs(e[1] - o[1]) < 1e-6) {
        console.log(`[UnitScale] ${code}: fromLonLat — тождество (градусы) → 1`);
        return 1;
    }

    // Ширина экватора в единицах проекции. Сэмплируем, а не берём только
    // ±180: у лопастных проекций край может оказаться не на краю диапазона,
    // а fromLonLat(±180) иногда возвращает NaN.
    let minX = Infinity;
    let maxX = -Infinity;
    for (let lon = -180; lon <= 180; lon += EQUATOR_STEP_DEG) {
        const p = crs.fromLonLat([lon, 0]);
        if (!p || !Number.isFinite(p[0])) continue;
        if (p[0] < minX) minX = p[0];
        if (p[0] > maxX) maxX = p[0];
    }
    const projEquator = maxX - minX;
    if (!(projEquator > 0) || !isFinite(projEquator)) {
        console.warn(`[UnitScale] ${code}: экватор не измерился → 1`);
        return 1;
    }

    // Эллипсоид берём у самой проекции. Порядок важен: у ScaledProjection
    // .semiMajor выражен в world-единицах, а .ellipsoid — в настоящих метрах.
    const a = (crs as any).ellipsoid?.a
        ?? (crs as any).semiMajor
        ?? EARTH_A_WGS84;
    if (!(a > 0) || !isFinite(a)) {
        console.warn(`[UnitScale] ${code}: неверная полуось эллипсоида → 1`);
        return 1;
    }

    const realEquator = 2 * Math.PI * a;
    const k = realEquator / projEquator;
    if (!(k > 0) || !isFinite(k)) return 1;

    console.log(
        `[UnitScale] ${code}: экватор проекции=${Math.round(projEquator)} ` +
        `эллипсоида=${Math.round(realEquator)} (a=${a}) → unitScale=${k.toFixed(7)}`,
    );
    if (k < 0.01 || k > 100) {
        console.warn(
            `[UnitScale] ${code}: коэффициент ${k.toFixed(4)} выглядит неправдоподобно — ` +
            `проверь, что СК мировая, а не зональная/локальная`,
        );
    }
    return k;
}

// ─────────────────────────────────────────────────────────────────
// Применение к геометрии
// ─────────────────────────────────────────────────────────────────

/**
 * Умножает все координаты геометрии на коэффициент.
 * Любая вложенность (Point … MultiPolygon), Z тоже масштабируется.
 * GeometryCollection обходится рекурсивно.
 */
export function scaleGeometry(geom: any, scale: number): any {
    if (!geom || scale === 1) return geom;

    const walk = (c: any): any => {
        if (!Array.isArray(c)) return c;
        if (typeof c[0] === 'number') return c.map(v => v * scale);
        return c.map(walk);
    };

    if (geom.type === 'GeometryCollection') {
        return {
            ...geom,
            geometries: (geom.geometries ?? []).map(
                (g: GeoJSONGeometry) => scaleGeometry(g, scale),
            ),
        };
    }
    return { ...geom, coordinates: walk(geom.coordinates) };
}

// ─────────────────────────────────────────────────────────────────
// Определение СК для ГИС
// ─────────────────────────────────────────────────────────────────

/**
 * Локальная декартова СК в метрах (ESRI-стиль WKT1).
 * Предпочтительный вариант для GDAL/QGIS: `LOCAL_CS` парсится всеми
 * версиями без справочника EPSG.
 */
export function localCsWkt(name: string): string {
    return `LOCAL_CS["${name}",`
         + `UNIT["metre",1,AUTHORITY["EPSG","9001"]],`
         + `AXIS["Easting",EAST],AXIS["Northing",NORTH]]`;
}

/**
 * Инженерная СК в метрах (WKT2). Оставлена для совместимости;
 * поддержка `ENGCRS` зависит от версии GDAL — если QGIS не принимает,
 * используй `localCsWkt`.
 */
export function engineeringCrsWkt(name: string): string {
    return `ENGCRS["${name}",EDATUM["Unknown engineering datum"],CS[Cartesian,2],`
         + `AXIS["(E)",east,ORDER[1],LENGTHUNIT["metre",1]],`
         + `AXIS["(N)",north,ORDER[2],LENGTHUNIT["metre",1]]]`;
}

// ─────────────────────────────────────────────────────────────────
// Единая политика приведения единиц
// ─────────────────────────────────────────────────────────────────

/** Глобальный дефолт для `trueScale`. */
let _defaultTrueScale = true;

/** Меняет дефолт сразу для всех: карта, сетка, любые генераторы. */
export function setDefaultTrueScale(on: boolean): void {
    _defaultTrueScale = !!on;
}

export function getDefaultTrueScale(): boolean {
    return _defaultTrueScale;
}

export interface UnitScaleOptions {
    trueScale?: boolean;
    unitScale?: number;
}

/**
 * Итоговый коэффициент: явный `unitScale` > `trueScale` > глобальный дефолт.
 * Единая точка решения для GeoJSONExporter и Graticule.
 */
export function resolveUnitScale(
    crs: CrsLike,
    options: UnitScaleOptions = {},
): number {
    const manual = options.unitScale;
    if (manual != null && isFinite(manual) && manual > 0) return manual;
    const on = options.trueScale ?? _defaultTrueScale;
    return on ? computeUnitScale(crs) : 1;
}