/**
 * TEST_PROJ.js — тестовая формульная проекция «Трапеция» (TRAPAZE).
 *
 * Назначение: проверка загрузки кастомной СК из файла. Файл НАМЕРЕННО
 * самодостаточен — ни одного import, поэтому грузится и через blob-URL
 * (выбор файла с диска), и обычным import() по URL.
 *
 * Геометрия:
 *   • параллели — горизонтальные отрезки, равноотстоящие (y = R·φ);
 *   • меридианы — прямые, сходятся к полюсу;
 *   • полюс — отрезок длиной POLE_RATIO от экватора (не точка!);
 *   • силуэт — равнобедренная трапеция.
 *
 *   y
 *   ↑    ┌───────────────┐   ← полюс:  9 998 551 м  (φ = +90°)
 *   │   ╱                 ╲
 *   │  ╱                   ╲
 *   │ ┌─────────────────────┐ ← экватор: 40 075 017 м (φ = 0)
 *   │  ╲                   ╱
 *   │   ╲                 ╱
 *   │    └───────────────┘   ← полюс:  9 998 551 м  (φ = −90°)
 *
 * Прямая:   x = R·λ·w(φ),  y = R·φ,  w(φ) = 1 − (1 − POLE_RATIO)·|φ|/(π/2)
 * Обратная: φ = y/R,       λ = x/(R·w(φ))
 *
 * Свойства: не равновеликая, не конформная, без разрывов. Зато обратная
 * формула точная и всё считается руками — то, что нужно для теста.
 *
 * Контрольные числа (R = 6378137, POLE_RATIO = 0.5):
 *   экватор в проекции        40 075 016.686 м  (= 2πR, ровно как у WGS84)
 *   меридиан полюс–полюс      20 037 508.343 м  (= πR)
 *   полуширина halfExtentX    20 237 883.426 м  (габарит + 1 %)
 *   полувысота halfExtentY    10 118 941.713 м
 *   computeUnitScale(crs)     1                 (экватор уже 1:1)
 *
 * Загрузка:
 *   await Projections.addFile(file);              // <input type="file"> / drag&drop
 *   await Projections.addUrl('./TEST_PROJ.js');   // со своего сервера
 *   await Projections.addCrs('TEST:PROJ');        // если положить в customCRS/
 *
 * @module customCRS/TEST_PROJ
 */

// ─────────────────────────────────────────────────────────────────
// Параметры
// ─────────────────────────────────────────────────────────────────

const D2R = Math.PI / 180;
const R2D = 180 / Math.PI;
const PI  = Math.PI;

/** Радиус сферы-основы, м. Совпадает с большой полуосью WGS84. */
const R = 6378137;

/** Длина полярного отрезка в долях экватора. 0 → треугольник, 1 → прямоугольник. */
const POLE_RATIO = 0.5;

/** Запас по габариту: чтобы край геометрии не лип к границе домена. */
const MARGIN = 1.01;

const HALF_LON = PI * R;            // 20 037 508.343 — полуширина на экваторе
const HALF_LAT = (PI / 2) * R;      // 10 018 754.171 — полувысота (полюс)

// ─────────────────────────────────────────────────────────────────
// Прямая и обратная
// ─────────────────────────────────────────────────────────────────

/** Коэффициент сжатия по X на широте latDeg: 1 на экваторе, POLE_RATIO на полюсе. */
function widthFactor(latDeg) {
    const t = Math.min(1, Math.abs(latDeg) / 90);
    return 1 - (1 - POLE_RATIO) * t;
}

/** [lat°, lon°] → [x, y] в метрах. */
function forward(latDeg, lonDeg) {
    const x = R * (lonDeg * D2R) * widthFactor(latDeg);
    const y = R * (latDeg * D2R);
    return [x, y];
}

/** [x, y] в метрах → [lat°, lon°]. Точная, без итераций. */
function inverse(xM, yM) {
    const lat = (yM / R) * R2D;
    const w = widthFactor(lat);
    const lon = w === 0 ? 0 : (xM / (R * w)) * R2D;
    return [lat, lon];
}

// ─────────────────────────────────────────────────────────────────
// Spec — то, что читает загрузчик (mod.default)
// ─────────────────────────────────────────────────────────────────

export default {
    code: 'TEST:PROJ',

    /**
     * Порядок строго [x(lat,lon), y(lat,lon), lat(x,y), lon(x,y)].
     * lat/lon в ГРАДУСАХ, x/y в метрах.
     */
    formula: [
        (lat, lon) => forward(lat, lon)[0],
        (lat, lon) => forward(lat, lon)[1],
        (x, y)     => inverse(x, y)[0],
        (x, y)     => inverse(x, y)[1],
    ],

    /** Непрерывная проекция — лепестков нет. */
    lobes: null,

    options: {
        /** Сфера радиуса R:椭 эллипсоид библиотеки строится из этого числа. */
        semiMajor: R,

        halfExtentX: HALF_LON * MARGIN,
        halfExtentY: HALF_LAT * MARGIN,

        /** Порог «мусорных» координат: за габаритом объект невалиден. */
        maxAbsCoord: HALF_LON * 1.5,

        wrapsLongitude: true,
        lobes: null,
    },

    /** Произвольная мета — загрузчик её игнорирует, но в файле полезна. */
    meta: {
        name: 'Трапеция (TRAPAZE)',
        kind: 'pseudocylindrical, straight meridians, polar line',
        equalArea: false,
        conformal: false,
        poleRatio: POLE_RATIO,
        equatorMeters: 2 * PI * R,
        meridianMeters: PI * R,
    },
};

// ─────────────────────────────────────────────────────────────────
// Именованные экспорты — для тестов, загрузчиком не используются
// ─────────────────────────────────────────────────────────────────

export { forward, inverse, widthFactor };

export const EXPECTED = {
    code: 'TEST:PROJ',
    radius: R,
    poleRatio: POLE_RATIO,
    equatorMeters: 2 * PI * R,          // 40 075 016.686
    poleLineMeters: 2 * PI * R * POLE_RATIO,
    meridianMeters: PI * R,             // 20 037 508.343
    halfExtentX: HALF_LON * MARGIN,
    halfExtentY: HALF_LAT * MARGIN,
    unitScale: 1,                       // экватор уже 1:1
};

/**
 * Round-trip по сетке 5°×5°. Вызывай после загрузки — проверяет и формулы,
 * и то, что файл действительно исполняется, а не просто парсится.
 *
 * @returns {{ok: boolean, tested: number, skipped: number,
 *            maxErrorDeg: number, maxErrorMeters: number}}
 */
export function selfTest() {
    let maxDeg = 0;
    let maxM = 0;
    let tested = 0;
    let skipped = 0;

    for (let lat = -90; lat <= 90; lat += 5) {
        for (let lon = -180; lon <= 180; lon += 5) {
            const [x, y] = forward(lat, lon);
            if (!Number.isFinite(x) || !Number.isFinite(y)) { skipped++; continue; }
            const [lat2, lon2] = inverse(x, y);
            maxDeg = Math.max(maxDeg, Math.abs(lat2 - lat), Math.abs(lon2 - lon));
            const [x2, y2] = forward(lat2, lon2);
            maxM = Math.max(maxM, Math.hypot(x2 - x, y2 - y));
            tested++;
        }
    }

    return {
        ok: tested > 0 && maxDeg < 1e-9 && maxM < 1e-6,
        tested,
        skipped,
        maxErrorDeg: maxDeg,
        maxErrorMeters: maxM,
    };
}