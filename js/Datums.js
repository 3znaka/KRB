// Datums.ts
// @ts-nocheck
//
// Геодезические датумы и переход между ними по 7-параметрической модели
// Гельмерта (ГОСТ 32453-2017). Опорный датум — ПЗ-90.11; все остальные
// датумы задаются параметрами перехода «датум → ПЗ-90.11».
//
// Эллипсоид и датум — разные сущности: эллипсоид задаёт форму (Ellipsoid.ts),
// датум — привязку к Земле (сдвиг/поворот/масштаб). Поэтому датум хранится
// отдельно и ссылается на эллипсоид по ключу.
import { ELLIPSOIDS, geodeticToEcef, ecefToGeodetic } from './Ellipsoid.js';
/** Секунды дуги → радианы. */
const ARCSEC = Math.PI / (180 * 3600);
/**
 * Разбор `+towgs84=dx,dy,dz[,rx,ry,rz[,ds]]`.
 * Формат PROJ: повороты в угловых секундах, масштаб ds — в ppm.
 * Возвращает HelmertParams в единицах, принятых в этом модуле (m — безразмерный).
 */
export function parseTowgs84(s) {
    const v = String(s).split(',').map(Number);
    if (v.length < 3 || v.some(x => !Number.isFinite(x)))
        return null;
    const [dx, dy, dz, rx = 0, ry = 0, rz = 0, ds = 0] = v;
    return { dx, dy, dz, rx, ry, rz, m: ds * 1e-6 };
}
/** Параметры перехода в ПЗ-90.11 по ГОСТ 32453-2017 (таблица в ТЗ/статье). */
export const DATUMS = {
    pz90: {
        key: 'pz90', name: 'ПЗ-90.11', ellipsoid: 'pz90', toPZ90: null,
    },
    sk42: {
        key: 'sk42', name: 'СК-42', ellipsoid: 'krass', // эллипсоид Красовского
        toPZ90: {
            dx: 23.557, dy: -140.844, dz: -79.778,
            rx: -0.00230, ry: -0.34646, rz: -0.79421,
            m: -0.228e-6,
        },
    },
    sk95: {
        key: 'sk95', name: 'СК-95', ellipsoid: 'krass',
        toPZ90: {
            dx: 24.457, dy: -130.784, dz: -81.538,
            rx: -0.00230, ry: 0.00354, rz: -0.13421,
            m: -0.228e-6,
        },
    },
    gsk2011: {
        key: 'gsk2011', name: 'ГСК-2011', ellipsoid: 'gsk2011',
        toPZ90: {
            dx: 0.000, dy: 0.014, dz: -0.008,
            rx: -0.000562, ry: -0.000019, rz: 0.000053,
            m: -0.0006e-6,
        },
    },
    wgs84: {
        // WGS-84 (G1150): параметры перехода WGS-84 → ПЗ-90.11 (ГОСТ 32453-2017, Г.1).
        // Обратный переход (ПЗ-90.11 → WGS-84) берётся через обращение формулы.
        key: 'wgs84', name: 'WGS-84', ellipsoid: 'wgs84',
        toPZ90: {
            dx: -0.013, dy: 0.106, dz: 0.022,
            rx: -0.00230, ry: 0.00354, rz: -0.00421,
            m: -0.008e-6,
        },
    },
};
/**
 * Синонимы имён датумов из PROJ (+datum=...) → ключи таблицы.
 * Сюда добавляются только те имена, которые однозначно соответствуют записи.
 */
const DATUM_ALIASES = {
    pz90: 'pz90', pz9011: 'pz90', 'pz-90.11': 'pz90',
    sk42: 'sk42', krass: 'sk42',
    sk95: 'sk95',
    gsk2011: 'gsk2011', 'gsk-2011': 'gsk2011', gsk2011_: 'gsk2011',
    wgs84: 'wgs84',
};
/** Найти датум по ключу или PROJ-имени. Возвращает null, если неизвестен. */
export function getDatum(name) {
    if (!name)
        return null;
    const k = String(name).toLowerCase().replace(/\s+/g, '');
    const key = DATUM_ALIASES[k] ?? (DATUMS[k] ? k : null);
    return key ? DATUMS[key] : null;
}
/**
 * Определить датум по PROJ-строке CRS.
 *
 * Приоритет:
 *   1. `+datum=<name>` — явный датум (если известен таблице).
 *   2. `+ellps=<name>` — эллипсоид, который однозначно задаёт датум в таблице
 *      (например, GSK2011 → ГСК-2011). Это соответствие «эллипсоид → датум»
 *      выполняется только для записей, где датум однозначен; для
 *      неоднозначных эллипсоидов (WGS84, Krassovsky) датум по `+ellps` НЕ
 *      выводится, иначе была бы путаница СК-42/СК-95 или WGS-84/ПЗ-90.
 *   3. Иначе — null (датум не задан, сдвиг не применяется).
 */
export function datumFromProj(def) {
    if (!def)
        return null;
    const params = {};
    for (const m of String(def).matchAll(/\+(\w+)=([^\s+]+)/g)) {
        params[m[1].toLowerCase()] = m[2];
    }
    // 0. Явный +towgs84=dx,dy,dz[,rx,ry,rz,ds] — сдвиг прямо к WGS-84.
    //    Имеет приоритет: это то, что задано в определении CRS.
    if (params.towgs84) {
        const tw = parseTowgs84(params.towgs84);
        if (tw) {
            return {
                key: `towgs84:${params.towgs84}`,
                name: 'towgs84',
                ellipsoid: params.ellps ? params.ellps.toLowerCase() : 'wgs84',
                toPZ90: null,
                toWgs84: tw,
            };
        }
    }
    if (params.datum) {
        const d = getDatum(params.datum);
        if (d)
            return d;
    }
    if (params.ellps) {
        const e = params.ellps.toLowerCase();
        // Однозначные соответствия эллипсоид → датум (без неоднозначных).
        const unique = {
            gsk2011: 'gsk2011',
            pz90: 'pz90',
        };
        if (unique[e])
            return DATUMS[unique[e]];
    }
    return null;
}
/**
 * Нужен ли переход: датум задан и отличается от WGS-84.
 * Для WGS-84 и неизвестных датумов координаты не трансформируются.
 */
export function needsDatumShift(def) {
    const d = datumFromProj(def);
    return !!d && d.key !== 'wgs84';
}
/**
 * Матрица поворотов R из формулы (20):
 *   [ 1,   wz, -wy]
 *   [-wz,  1,   wx]
 *   [ wy, -wx,  1 ]
 * (повороты переданы в радианах).
 */
function rotationMatrix(rx, ry, rz) {
    return [
        [1, rz, -ry],
        [-rz, 1, rx],
        [ry, -rx, 1],
    ];
}
/**
 * Прямой переход X_опорн = (1 + m)·R·X_исх + ΔX (формула (20)).
 * Вход/выход — [X, Y, Z] в метрах (ECEF).
 */
export function helmertForward(xyz, p) {
    const R = rotationMatrix(p.rx * ARCSEC, p.ry * ARCSEC, p.rz * ARCSEC);
    const s = 1 + p.m;
    const [x, y, z] = xyz;
    return [
        s * (R[0][0] * x + R[0][1] * y + R[0][2] * z) + p.dx,
        s * (R[1][0] * x + R[1][1] * y + R[1][2] * z) + p.dy,
        s * (R[2][0] * x + R[2][1] * y + R[2][2] * z) + p.dz,
    ];
}
/**
 * Обратный переход X_исх = (1 − m)·Rᵀ·(X_опорн − ΔX) (формула (21)).
 * Точная обратная формула (не просто смена знака), иначе ошибка ~ m·ΔX.
 */
export function helmertInverse(xyz, p) {
    const [x0, y0, z0] = [xyz[0] - p.dx, xyz[1] - p.dy, xyz[2] - p.dz];
    const R = rotationMatrix(p.rx * ARCSEC, p.ry * ARCSEC, p.rz * ARCSEC);
    const s = 1 - p.m;
    // Rᵀ
    return [
        s * (R[0][0] * x0 + R[1][0] * y0 + R[2][0] * z0),
        s * (R[0][1] * x0 + R[1][1] * y0 + R[2][1] * z0),
        s * (R[0][2] * x0 + R[1][2] * y0 + R[2][2] * z0),
    ];
}
/**
 * Переход геодезических координат из датума `from` в датум `to`
 * через ECEF и ПЗ-90.11 (опорный).
 *
 *   geo(from) → ECEF(from) → ПЗ-90.11 → ECEF(to) → geo(to)
 *
 * @param lonLatH — [lon, lat, h], градусы и метры
 * @returns [lon, lat, h] в датуме `to`
 */
export function convertDatum(lonLatH, from, to) {
    if (from.key === to.key)
        return [lonLatH[0], lonLatH[1], lonLatH[2] ?? 0];
    const ellFrom = ELLIPSOIDS[from.ellipsoid];
    const ellTo = ELLIPSOIDS[to.ellipsoid];
    if (!ellFrom || !ellTo)
        throw new Error(`convertDatum: нет эллипсоида для ${from.key} или ${to.key}`);
    const h = lonLatH[2] ?? 0;
    // 1) геодезические → ECEF исходного датума
    const e = geodeticToEcef(lonLatH[0], lonLatH[1], h, ellFrom);
    let xyz = [e.X, e.Y, e.Z];
    // Общая опора — WGS-84. Два пути в неё:
    //   • toWgs84 задан (towgs84, EPSG)  → Гельмерт прямо в WGS-84;
    //   • задан только toPZ90 (ГОСТ)     → Гельмерт в ПЗ-90.11, затем ПЗ-90.11 → WGS-84.
    const toWgs84FromDatum = (d, v) => {
        if (d.toWgs84)
            return helmertForward(v, d.toWgs84);
        if (d.toPZ90)
            return helmertInverse(helmertForward(v, d.toPZ90), DATUMS.wgs84.toPZ90);
        return v; // сам WGS-84 (или неизвестный датум без параметров)
    };
    // Обратный путь: WGS-84 → датум.
    const fromWgs84ToDatum = (d, v) => {
        if (d.toWgs84)
            return helmertInverse(v, d.toWgs84);
        if (d.toPZ90)
            return helmertInverse(helmertForward(v, DATUMS.wgs84.toPZ90), d.toPZ90);
        return v;
    };
    xyz = toWgs84FromDatum(from, xyz); // исходный датум → WGS-84
    xyz = fromWgs84ToDatum(to, xyz); // WGS-84 → целевой датум
    // 4) ECEF → геодезические в целевом эллипсоиде
    const g = ecefToGeodetic(xyz[0], xyz[1], xyz[2], ellTo);
    return [g.lon, g.lat, g.h];
}
