// FLOWER:0000 — проекция «Цветок»
// Развертка мира из N лепестков (по умолчанию 4 × 90°).
// В центре — Северный полюс, Антарктида — на концах лепестков.
// Структура lobes и формат экспорта повторяют ESRI:54052 (проекция Гуда).
// Лепестки строятся в полярных координатах: край лепестка не может выйти
// за свой сектор ±45° от оси, поэтому соседние лепестки никогда не перекрываются.

// ---------- Настраиваемые константы ----------
const R               = 6378245;  // радиус сферы, м
const N_PETALS        = 4;        // количество лепестков
const LON_START       = -180;     // долгота начала первого лепестка, °
const AXIS_START      = 45;       // угол оси первого лепестка на плоскости, °
const CENTER_POLE     = +1;       // +1: в центре Северный полюс; -1: Южный
const LON_DIR         = +1;       // направление обхода долгот по лепесткам: +1 или -1
const PETAL_THICKNESS = 1.3;      // толщина лепестков: 1 — как по умолчанию; >1 — шире; <1 — уже

// ---------- Служебные константы ----------
const D2R        = Math.PI / 180;
const R2D        = 180 / Math.PI;
const PI         = Math.PI;
const HALF_PI    = Math.PI / 2;
const TWO_PI     = 2 * Math.PI;
const EPS        = 1e-12;
const WORLD_HALF = 20037508.342789244;   // полуширина мира в метрах (как в модуле)

const SPAN_DEG   = 360 / N_PETALS;       // ширина лепестка по долготе, ° (90 при 4)
const SPAN_RAD   = TWO_PI / N_PETALS;
const AXIS0_RAD  = AXIS_START * D2R;
const SECTOR_HALF = SPAN_RAD / 2;        // полуугол сектора лепестка (45° при 4)

function wrap180(deg) {
    return ((deg + 180) % 360 + 360) % 360 - 180;
}
function wrapPi(rad) {
    return ((rad + PI) % TWO_PI + TWO_PI) % TWO_PI - PI;
}
function clamp(v, lo, hi) {
    return Math.max(lo, Math.min(hi, v));
}

// ---------- Лепестки (формат как у lobes в ESRI:54052) ----------
const LOBES = Array.from({ length: N_PETALS }, (_, p) => {
    const lonMin = LON_START + p * SPAN_DEG;
    const lonMax = lonMin + SPAN_DEG;
    return {
        index: p,
        latMin: -90,
        latMax:  90,
        lonMin,
        lonMax,
        centralMeridian: wrap180(lonMin + SPAN_DEG / 2),
        xOffset: 0,                          // поле для совместимости; поворот задаёт axisRad
        axisRad: AXIS0_RAD + LON_DIR * p * SPAN_RAD,
    };
});

// Номер лепестка по долготе
function lobeIndexByLon(lonDeg) {
    const u = ((lonDeg - LON_START) % 360 + 360) % 360; // [0, 360)
    return Math.floor(u / SPAN_DEG) % N_PETALS;
}

// Полуугол лепестка на расстоянии a (рад) от полюса.
// Берётся из синусоидального профиля (край = (π/4)·sin a) и умножается на толщину.
// Ограничен сектором ±45°, поэтому соседние лепестки смыкаются, но не перекрываются.
function petalHalfAngle(a) {
    const q = a > EPS ? Math.sin(a) / a : 1;
    const phi0 = Math.atan((PI / 4) * q);
    return Math.min(SECTOR_HALF, PETAL_THICKNESS * phi0);
}

// ---------- Прямая задача: (широта, долгота) → (X, Y), метры ----------
function forward(latDeg, lonDeg) {
    const lat = clamp(latDeg, -90, 90);
    const lon = wrap180(lonDeg);

    const lobe = LOBES[lobeIndexByLon(lon)];

    // расстояние от центрального полюса, рад (0..π)
    const beta = (CENTER_POLE === -1 ? lat : -lat) * D2R;
    const a    = clamp(beta + HALF_PI, 0, PI);

    // положение внутри лепестка: u ∈ [-1, 1], ±1 — края лепестка (меридианы)
    const dLon = wrap180(lon - lobe.centralMeridian) * D2R;
    const lam  = LON_DIR * dLon;
    const u    = clamp(lam / (PI / 4), -1, 1);

    // полярные координаты: радиус = a·R, угол = ось лепестка + u·полуугол
    const theta = lobe.axisRad + u * petalHalfAngle(a);
    const rho   = a * R;
    return [rho * Math.cos(theta), rho * Math.sin(theta)];
}

// ---------- Обратная задача: (X, Y) → (широта, долгота) ----------
function inverse(Xm, Ym) {
    const rho = Math.hypot(Xm, Ym);
    const ang = Math.atan2(Ym, Xm);
    const a   = clamp(rho / R, 0, PI);

    // ближайший лепесток по направлению
    let p = Math.round(LON_DIR * wrapPi(ang - AXIS0_RAD) / SPAN_RAD);
    p = ((p % N_PETALS) + N_PETALS) % N_PETALS;
    const lobe = LOBES[p];

    // отклонение от оси лепестка и нормировка на полуугол
    const d    = wrapPi(ang - lobe.axisRad);
    const half = petalHalfAngle(a);
    const u    = half > EPS ? clamp(d / half, -1, 1) : 0;

    const lam   = u * (PI / 4);
    const dLon  = LON_DIR * lam;
    const beta  = a - HALF_PI;

    let latDeg = beta * R2D;
    if (CENTER_POLE !== -1) latDeg = -latDeg;

    const lonDeg = lobe.centralMeridian + dLon * R2D;
    return [clamp(latDeg, -90, 90), wrap180(lonDeg)];
}

// ---------- Габариты ----------
// Радиус цветка равен πR = WORLD_HALF при любой толщине, поэтому домен фиксирован.
const HALF_X = WORLD_HALF;
const HALF_Y = WORLD_HALF;

export default {
    code: 'FLOWER:0000',
    formula: [
        (lat, lon) => forward(lat, lon)[0],
        (lat, lon) => forward(lat, lon)[1],
        (x, y)     => inverse(x, y)[0],
        (x, y)     => inverse(x, y)[1],
    ],
    lobes: LOBES,
    options: {
        semiMajor:      R,
        halfExtentX:    HALF_X,
        halfExtentY:    HALF_Y,
        maxAbsCoord:    WORLD_HALF * 1.5,
        wrapsLongitude: true,
        lobes: LOBES,
    },
};