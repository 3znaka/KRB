// Projections.js
import proj4 from '../js_TP/proj4.js';

const HARDCODED = {
    'EPSG:4326': '+proj=longlat +datum=WGS84 +no_defs +type=crs',
    'EPSG:3857': '+proj=merc +a=6378137 +b=6378137 +lat_ts=0 +lon_0=0 +x_0=0 +y_0=0 +k=1 +units=m +nadgrids=@null +no_defs +type=crs',
    'EPSG:3395': '+proj=merc +lon_0=0 +k=1 +x_0=0 +y_0=0 +datum=WGS84 +units=m +no_defs +type=crs',
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