const D2R = Math.PI / 180;
const R2D = 180 / Math.PI;
const PI = Math.PI;
const EPS = 1e-12;
const MAX_ITER = 50;

// Константы проекции Гуда
const PHI_LIM = 0.71093078197902358062; // ≈ 40°44'11.8" в радианах
const Y_COR = 0.05280;                  // Вертикальная поправка Мольвейде
const R = 6378245;                      // Большая полуось эллипсоида Красовского

/**
 * Определение лепестков (лоба) для прерывистой (interrupted) проекции.
 * xOffset — смещение по оси X в градусах (для стыковки на экваторе).
 * lonMin/lonMax — границы лепестка по долготе.
 * centralMeridian — центральный меридиан лепестка.
 */
const LOBES = [
    // Северное полушарие (2 лепестка)
    { latMin: 0,   latMax: 90, lonMin: -180, lonMax: -40, centralMeridian: -100, xOffset: 0 },
    { latMin: 0,   latMax: 90, lonMin: -40,  lonMax: 180, centralMeridian: 30,   xOffset: 130 },
    // Южное полушарие (3 лепестка)
    { latMin: -90, latMax: 0,  lonMin: -180, lonMax: -20, centralMeridian: -60,  xOffset: 40 },
    { latMin: -90, latMax: 0,  lonMin: -20,  lonMax: 80,  centralMeridian: 20,   xOffset: 120 },
    { latMin: -90, latMax: 0,  lonMin: 80,   lonMax: 180, centralMeridian: 140,  xOffset: 240 },
];

function solveMollweideTheta(lat) {
    let theta = lat;
    for (let i = 0; i < MAX_ITER; i++) {
        const f  = 2 * theta + Math.sin(2 * theta) - PI * Math.sin(lat);
        const fp = 2 + 2 * Math.cos(2 * theta);
        const d  = f / fp;
        theta -= d;
        if (Math.abs(d) < EPS) break;
    }
    return theta;
}

function mollweideInverseLat(theta) {
    const s = (2 * theta + Math.sin(2 * theta)) / PI;
    return Math.asin(Math.max(-1, Math.min(1, s)));
}

function makeProjection() {
    function forward(latDeg, lonDeg) {
        // Нормализация долготы
        let dLon = lonDeg;
        while (dLon >  180) dLon -= 360;
        while (dLon < -180) dLon += 360;

        // Поиск подходящего лепестка
        let lobe = LOBES[0];
        for (const l of LOBES) {
            if (latDeg >= l.latMin && latDeg <= l.latMax &&
                dLon >= l.lonMin && dLon <= l.lonMax) {
                lobe = l;
                break;
            }
        }

        const lat = latDeg * D2R;
        const lon0 = lobe.centralMeridian * D2R;
        const lonLocal = (dLon * D2R) - lon0;

        let x, y;
        if (Math.abs(lat) <= PHI_LIM) {
            // Синусоидальная часть
            x = lonLocal * Math.cos(lat);
            y = lat;
        } else {
            // Часть Мольвейде
            const theta = solveMollweideTheta(lat);
            x = (2 * Math.SQRT2 / PI) * lonLocal * Math.cos(theta);
            y = Math.SQRT2 * Math.sin(theta) + (lat >= 0 ? -Y_COR : Y_COR);
        }

        // Применяем смещение лепестка и масштабируем
        const xM = (x + lobe.xOffset * D2R) * R;
        const yM = y * R;

        return [xM, yM];
    }

    function inverse(xM, yM) {
        const x = xM / R;
        const y = yM / R;

        // Определяем лепесток по координате X
        let lobe;
        if (y >= 0) {
            // Северное полушарие
            lobe = x < 60 * D2R ? LOBES[0] : LOBES[1];
        } else {
            // Южное полушарие
            if (x < 80 * D2R) lobe = LOBES[2];
            else if (x < 180 * D2R) lobe = LOBES[3];
            else lobe = LOBES[4];
        }

        // Убираем смещение лепестка
        const xLocal = x - lobe.xOffset * D2R;

        let lat, lonLocal;
        if (Math.abs(y) <= PHI_LIM) {
            // Обратная синусоидальная
            lat = y;
            const c = Math.cos(lat);
            lonLocal = Math.abs(c) < EPS ? 0 : xLocal / c;
        } else {
            // Обратная Мольвейде
            const yc = y >= 0 ? y + Y_COR : y - Y_COR;
            const s  = Math.max(-1, Math.min(1, yc / Math.SQRT2));
            const theta = Math.asin(s);
            lat = mollweideInverseLat(theta);
            const ct = Math.cos(theta);
            lonLocal = Math.abs(ct) < EPS ? 0 : (PI * xLocal) / (2 * Math.SQRT2 * ct);
        }

        let latDeg = lat * R2D;
        let lonDeg = lobe.centralMeridian + lonLocal * R2D;

        // Нормализация
        while (lonDeg >  180) lonDeg -= 360;
        while (lonDeg < -180) lonDeg += 360;
        latDeg = Math.max(-90, Math.min(90, latDeg));

        return [latDeg, lonDeg];
    }

    return { forward, inverse };
}

const { forward, inverse } = makeProjection();

// Оценка габаритов по сетке
let maxX = 0, maxY = 0;
for (let lat = -90; lat <= 90; lat += 5) {
    for (let lon = -180; lon <= 180; lon += 5) {
        const [x, y] = forward(lat, lon);
        if (Number.isFinite(x)) maxX = Math.max(maxX, Math.abs(x));
        if (Number.isFinite(y)) maxY = Math.max(maxY, Math.abs(y));
    }
}
const HALF_X = (maxX || 2e7) * 1.15;
const HALF_Y = (maxY || 2e7) * 1.15;

import { Ellipsoid } from '../Ellipsoid.js';

export default {
    code: 'ESRI:54052',
    formula: [
        (lat, lon) => forward(lat, lon)[0],
        (lat, lon) => forward(lat, lon)[1],
        (x, y)     => inverse(x, y)[0],
        (x, y)     => inverse(x, y)[1],
    ],
    lobes: LOBES, 
    options: {
        halfExtentX:   HALF_X,
        halfExtentY:   HALF_Y,
        maxAbsCoord:   Math.max(HALF_X, HALF_Y) * 1.5,
        wrapsLongitude: true,
        lobes: LOBES, 
    },
};