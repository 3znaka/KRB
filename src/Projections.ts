// @ts-nocheck
// Projections.js
import proj4 from './js_TP/proj4.js';

const HARDCODED = {
    'EPSG:4326': '+proj=longlat +datum=WGS84 +no_defs +type=crs',
    'EPSG:3857': '+proj=merc +a=6378137 +b=6378137 +lat_ts=0 +lon_0=0 +x_0=0 +y_0=0 +k=1 +units=m +nadgrids=@null +no_defs +type=crs',
    'EPSG:3395': '+proj=merc +lon_0=0 +k=1 +x_0=0 +y_0=0 +datum=WGS84 +units=m +no_defs +type=crs',
};

const ELLIPSOID_A = {
    'APL4.9': 6378137.0,
    'CPM': 6375738.7,
    'GRS67': 6378160.0,
    'GRS80': 6378137.0,
    'GSK2011': 6378136.5,
    'IAU76': 6378140.0,
    'MERIT': 6378137.0,
    'NWL9D': 6378145.0,
    'PZ90': 6378136.0,
    'SEasia': 6378155.0,
    'SGS85': 6378136.0,
    'WGS60': 6378165.0,
    'WGS66': 6378145.0,
    'WGS72': 6378135.0,
    'WGS84': 6378137.0,
    'airy': 6377563.396,
    'andrae': 6377104.43,
    'aust_SA': 6378160.0,
    'bess_nam': 6377483.865,
    'bessel': 6377397.155,
    'clrk66': 6378206.4,
    'clrk80': 6378249.145,
    'clrk80ign': 6378249.2,
    'danish': 6377019.2563,
    'delmbr': 6376428.0,
    'engelis': 6378136.05,
    'evrst30': 6377276.345,
    'evrst48': 6377304.063,
    'evrst56': 6377301.243,
    'evrst69': 6377295.664,
    'evrstSS': 6377298.556,
    'fschr60': 6378166.0,
    'fschr60m': 6378155.0,
    'fschr68': 6378150.0,
    'helmert': 6378200.0,
    'hough': 6378270.0,
    'intl': 6378388.0,
    'kaula': 6378163.0,
    'krass': 6378245.0,
    'lerch': 6378139.0,
    'mod_airy': 6377340.189,
    'mprts': 6397300.0,
    'new_intl': 6378157.5,
    'plessis': 6376523.0,
    'sphere': 6370997.0,
    'walbeck': 6376896.0,
};

/**
 * Обёртка над проекцией proj4 с минимальной валидацией.
 *
 * Proj4 не сигнализирует об ошибке: за пределами области определения
 * он молча возвращает NaN/Infinity, огромные числа или «уехавшие»
 * градусы (например, lon ≈ 470° для Equal Earth). Всё это, попав в
 * буфер вершин или в формулу tile-index, даёт артефакты рендера и
 * дикие просадки FPS (см. KrbMap.worldToTileIndex).
 *
 * Projection умеет:
 *  1. Отсеивать мусор через `isValidCoord` (порог `maxAbsCoord`).
 *  2. Для Mercator — прижимать широту к ±85.05°, чтобы proj4 не
 *     возвращал Infinity на полюсах.
 *  3. Отбраковывать lon/lat вне диапазона ±180°/±90° (в isValidLonLat
 *     и на выходе toLonLatSafe) — это защищает от проекций с узким
 *     доменом, для которых proj4 выдаёт «уехавшие» градусы.
 *
 * ВАЖНО: разрывы из-за пересечения антимеридиана (например, кольцо
 * Антарктиды, где lon прыгает с +180 на −180) Projections не чинит —
 * это задача потребителя (Polygon._projectRing).
 */
export class Projection {
    /**
     * @param {string} code - Код СК ('EPSG:4326', 'EPSG:32637', ...).
     * @param {string} def - PROJ-строка.
     */
    constructor(code, def) {
        /** @type {string} */ this.code = code;
        /** @type {string} */ this.def = def;
        /** @type {boolean} */ this.isGeographic = /\+proj=longlat/.test(def);

        const projMatch = def.match(/\+proj=(\w+)/);
        /** @type {string|null} */
        this.projName = projMatch ? projMatch[1].toLowerCase() : null;

        /** @type {boolean} */
        this.isMercator = this.projName === 'merc';

        // Осевой меридиан: +lon_0=… либо из +zone=N (UTM/GK).
        this.lon0 = this._parseLon0(def);

        /** Предельная широта для Mercator. null — не ограничиваем.
         *  @type {number|null} */
        this.maxLatDeg = this.isMercator ? 85.05112878 : null;

        /**
         * Порог «мусора» для спроецированных координат (метры).
         *
         * 2.5e7 = 25 000 км ≈ 1.25 ширины мира. Легитимные координаты
         * Web Mercator (до 2e7) и UTM (до ~1e7) сюда влезают с запасом,
         * а результаты деления на ноль в proj4 (Перу в UTM 37N и т.п.) —
         * нет. Это НЕ клиппинг зоны: точки с умеренными координатами
         * (десятки тысяч км) проходят как есть.
         *
         * @type {number}
         */
        this.maxAbsCoord = 2.5e7;

        this._semiMajor = this._parseSemiMajor(def);
        this._halfExtentX = undefined;
        this._halfExtentY = undefined;
    }

    _parseSemiMajor(def) {
        const a = def.match(/\+a=([\d.eE+-]+)/);
        if (a) return parseFloat(a[1]);

        const ellps = def.match(/\+ellps=(\w+)/);
        if (ellps && ELLIPSOID_A[ellps[1].toUpperCase()]) {
            return ELLIPSOID_A[ellps[1].toUpperCase()];
        }
        const datum = def.match(/\+datum=(\w+)/);
        if (datum && ELLIPSOID_A[datum[1].toUpperCase()]) {
            return ELLIPSOID_A[datum[1].toUpperCase()];
        }
        return 6378137;
    }

    /** Полуось a из PROJ-строки. */
    get semiMajor() { return this._semiMajor; }

    /** Полу-ширина домена в координатах проекции (map or tile). */
    get halfExtentX() {
        if (this._halfExtentX !== undefined) return this._halfExtentX;
        if (this.isMercator)    return (this._halfExtentX = Math.PI * this._semiMajor);
        if (this.isGeographic)  return (this._halfExtentX = 180);
        const p = this.fromLonLatSafe([180, 0]);
        return (this._halfExtentX = p ? Math.abs(p[0]) : Math.PI * this._semiMajor);
    }

    /** Полу-высота домена в координатах проекции. */
    get halfExtentY() {
        if (this._halfExtentY !== undefined) return this._halfExtentY;
        if (this.isMercator)    return (this._halfExtentY = Math.PI * this._semiMajor);
        if (this.isGeographic)  return (this._halfExtentY = 90);
        const lat = this.maxLatDeg ?? 85.05112878;
        const p = this.fromLonLatSafe([0, lat]) || this.fromLonLatSafe([0, 90]);
        return (this._halfExtentY = p ? Math.abs(p[1]) : Math.PI * this._semiMajor);
    }

    /** @private */
    _parseLon0(def) {
        const lon0Match = def.match(/\+lon_0=(-?[\d.]+)/);
        if (lon0Match) return parseFloat(lon0Match[1]);

        const zoneMatch = def.match(/\+zone=(\d+)/);
        if (zoneMatch) {
            const zone = parseInt(zoneMatch[1], 10);
            // UTM: зона 1 начинается с −177°, каждая следующая +6°.
            return -177 + (zone - 1) * 6;
        }
        return 0;
    }

    /**
     * Валидны ли географические координаты.
     *
     * Помимо конечности проверяем естественные пределы: долгота в
     * [−180, 180], широта в [−90, 90]. Это отсекает мусор, который
     * proj4 может выдать при работе с проекциями с узким доменом
     * (Equal Earth и т.п.): например, lon ≈ 470° — формально число
     * конечное, но в world-координаты и tile-index превращается в
     * абсурд и раздувает bbox тайлов.
     *
     * Допуск 0.0001° — на случай, если данные пришли из округления.
     *
     * @param {Array<number>} lonLat
     * @returns {boolean}
     */
    isValidLonLat(lonLat) {
        if (!lonLat || lonLat.length < 2) return false;
        const lon = lonLat[0], lat = lonLat[1];
        if (!Number.isFinite(lon) || !Number.isFinite(lat)) return false;
        if (Math.abs(lon) > 180.0001) return false;
        if (Math.abs(lat) > 90.0001) return false;
        return true;
    }

    /**
     * Конечны ли спроецированные координаты и не «мусор» ли это.
     * @param {Array<number>} coord @returns {boolean}
     */
    isValidCoord(coord) {
        if (!coord || coord.length < 2) return false;
        const x = coord[0], y = coord[1];
        if (!Number.isFinite(x) || !Number.isFinite(y)) return false;
        if (Math.abs(x) > this.maxAbsCoord || Math.abs(y) > this.maxAbsCoord) return false;
        return true;
    }

    /**
     * Прижимает широту к пределу (только для Mercator).
     * @param {Array<number>} lonLat @returns {Array<number>}
     */
    clampLonLat(lonLat) {
        if (this.maxLatDeg === null) return lonLat;
        const lon = lonLat[0], lat = lonLat[1];
        if (!Number.isFinite(lat)) return lonLat;
        if (Math.abs(lat) <= this.maxLatDeg) return lonLat;
        return [lon, Math.sign(lat) * this.maxLatDeg];
    }

    /** @param {Projection} other @param {Array<number>} coord */
    convertTo(other, coord) { return proj4(this.def, other.def, coord); }

    /** «Сырой» proj4 (может вернуть NaN/Infinity). */
    fromLonLat(coord) { return proj4(HARDCODED['EPSG:4326'], this.def, coord); }
    toLonLat(coord)   { return proj4(this.def, HARDCODED['EPSG:4326'], coord); }

    /**
     * Безопасная проекция: кламп широты + отсев мусора.
     * @param {Array<number>} coord @returns {Array<number>|null}
     */
    fromLonLatSafe(coord) {
        if (!this.isValidLonLat(coord)) return null;
        const clamped = this.clampLonLat(coord);
        const out = this.fromLonLat(clamped);
        return this.isValidCoord(out) ? out : null;
    }

    /**
     * Безопасное обратное преобразование.
     *
     * Помимо конечности проверяем, что proj4 вернул осмысленные
     * градусы. Для проекций с узким доменом (Equal Earth, некоторые
     * азимутальные) координаты вне области определения дают lon
     * далеко за пределами [−180, 180]. Такие значения нельзя
     * пропускать: KrbMap.worldToTileIndex через формулу Web Mercator
     * превратит lon=470° в tile-индекс 1.8, xMin/xMax раздуются,
     * и TileManager сгенерирует сотни «фантомных» тайлов — это и
     * вызывало просадку до 1 FPS.
     *
     * @param {Array<number>} coord @returns {Array<number>|null}
     */
    toLonLatSafe(coord) {
        if (!this.isValidCoord(coord)) return null;
        const out = this.toLonLat(coord);
        if (!out || !Number.isFinite(out[0]) || !Number.isFinite(out[1])) return null;
        if (Math.abs(out[0]) > 180.0001 || Math.abs(out[1]) > 90.0001) return null;
        return out;
    }
}

/** Канонический WGS84. @type {Projection} */
export const WGS84 = new Projection('EPSG:4326', HARDCODED['EPSG:4326']);

/**
 * Реестр проекций: get/has/ensure/ensureMany + загрузка из epsg_defs.json.
 */
class ProjectionRegistry {
    constructor() {
        /** @private @type {Map<string, Projection>} */
        this._map = new Map();
        /** @private @type {Promise<Object>|null} */
        this._defsPromise = null;

        this.register(WGS84);
        for (const [code, def] of Object.entries(HARDCODED)) {
            if (!this._map.has(code)) this.register(new Projection(code, def));
        }
    }

    /** @param {Projection} p @returns {Projection} */
    register(p) { this._map.set(p.code, p); return p; }

    /** @param {string} code @returns {boolean} */
    has(code) { return this._map.has(code); }

    /** @param {string} code @returns {Projection} */
    get(code) {
        const p = this._map.get(code);
        if (!p) throw new Error(
            `CRS ${code} не загружен. Сначала вызовите await Projections.ensure('${code}')`
        );
        return p;
    }

    /** @param {string} code @returns {Promise<Projection>} */
    async ensure(code) {
        if (this._map.has(code)) return this._map.get(code);
        const defs = await this._loadDefs();
        const def = defs[code];
        if (!def) throw new Error(`CRS ${code} не найден в epsg_defs.json`);
        return this.register(new Projection(code, def));
    }

    /** @param {Array<string>} codes @returns {Promise<void>} */
    async ensureMany(codes) { for (const c of codes) await this.ensure(c); }

    /** @private @returns {Promise<Object>} */
    _loadDefs() {
        if (!this._defsPromise) {
            this._defsPromise = fetch(new URL('./epsg_defs.json', import.meta.url))
                .then(r => r.json());
        }
        return this._defsPromise;
    }
}

/** Глобальный реестр. @type {ProjectionRegistry} */
export const Projections = new ProjectionRegistry();