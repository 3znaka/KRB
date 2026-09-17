// Projections.js
import proj4 from '../js_TP/proj4.js';

const HARDCODED = {
    'EPSG:4326': '+proj=longlat +datum=WGS84 +no_defs +type=crs',
    'EPSG:3857': '+proj=merc +a=6378137 +b=6378137 +lat_ts=0 +lon_0=0 +x_0=0 +y_0=0 +k=1 +units=m +nadgrids=@null +no_defs +type=crs',
    'EPSG:3395': '+proj=merc +lon_0=0 +k=1 +x_0=0 +y_0=0 +datum=WGS84 +units=m +no_defs +type=crs',
};

/**
 * Обёртка над проекцией proj4 с информацией об области определения.
 * @example
 * const gk = Projections.get('EPSG:28407');
 * const ok = gk.isValidLonLat([37.6, 55.7]);   // true — внутри зоны
 * const bad = gk.isValidLonLat([-120, 40]);    // false — далеко от lon_0
 * const xy = gk.fromLonLatSafe([37.6, 55.7]);  // [x, y] или null
 */
export class Projection {
    /**
     * @param {string} code - Код СК (например, 'EPSG:4326', 'EPSG:28407').
     * @param {string} def - PROJ-строка (формат proj4js).
     */
    constructor(code, def) {
        /**
         * Код системы координат.
         * @type {string}
         */
        this.code = code;

        /**
         * PROJ-строка.
         * @type {string}
         */
        this.def = def;

        /**
         * Является ли проекция географической (lon/lat).
         * @type {boolean}
         */
        this.isGeographic = /\+proj=longlat/.test(def);

        // --- Разбор PROJ-строки для определения области определения ---

        const projMatch = def.match(/\+proj=(\w+)/);
        /**
         * Имя проекции из PROJ-строки в нижнем регистре
         * ('merc', 'tmerc', 'utm', 'longlat', ...) или null.
         * @type {string|null}
         */
        this.projName = projMatch ? projMatch[1].toLowerCase() : null;

        const lon0Match = def.match(/\+lon_0=([-\d.]+)/);
        /**
         * Осевой меридиан проекции в градусах (для tmerc/utm — центральный
         * меридиан зоны; для merc — 0; если не задан — 0).
         * @type {number}
         */
        this.lon0 = lon0Match ? parseFloat(lon0Match[1]) : 0;

        if (this.projName === 'merc') {
            // Web Mercator / World Mercator: широта ограничена ±85.051129°
            // (для квадрата). Берём 85.0 — численно устойчивее.
            /**
             * Максимальная абсолютная широта в градусах, при которой
             * проекция даёт «разумные» координаты.
             * @type {number}
             */
            this.maxLatDeg = 85.0;

            /**
             * Максимальное отклонение долготы от осевого меридиана
             * (в градусах). 180 = без ограничений.
             * @type {number}
             */
            this.maxLonOffsetDeg = 180;
        } else if (this.projName === 'tmerc' || this.projName === 'utm') {
            // Поперечная Меркатора / UTM / Gauss-Kruger: ряд Тейлора
            // расходится далеко от осевого меридиана. ±6° — комфортный
            // диапазон для визуализации (координаты остаются «человеческими»).
            this.maxLatDeg = 84.0;
            this.maxLonOffsetDeg = 6.0;
        } else if (this.projName === 'longlat') {
            // Географическая: без ограничений по смыслу.
            this.maxLatDeg = 90.0;
            this.maxLonOffsetDeg = 180.0;
        } else {
            // Неизвестная проекция: не ограничиваем по lon/lat,
            // но численно валидируем результат.
            this.maxLatDeg = 90.0;
            this.maxLonOffsetDeg = 180.0;
        }

        /**
         * Численный порог для спроецированных координат (в метрах).
         * Диаметр Земли ~ 4·10⁷ м; всё, что больше 10⁹ м — заведомая
         * «бесконечность» от proj4.
         * @type {number}
         */
        this.maxAbsCoord = 1e9;
    }

    /**
     * Проверяет, лежит ли пара (lon, lat) в области определения проекции.
     *
     * Учитывает:
     *  - конечность значений;
     *  - ограничение по широте (`maxLatDeg`) — критично для Mercator;
     *  - ограничение по долготе относительно `lon0` (`maxLonOffsetDeg`) —
     *    критично для Gauss-Kruger / UTM.
     *
     * @param {Array.<number>} lonLat - [долгота, широта] в градусах.
     * @returns {boolean} true, если точка допустима.
     *
     * @example
     * Projections.get('EPSG:3857').isValidLonLat([0, 89]); // false
     * Projections.get('EPSG:3857').isValidLonLat([0, 80]); // true
     */
    isValidLonLat(lonLat) {
        if (!lonLat || lonLat.length < 2) return false;
        const lon = lonLat[0], lat = lonLat[1];
        if (!Number.isFinite(lon) || !Number.isFinite(lat)) return false;
        if (Math.abs(lat) > this.maxLatDeg) return false;
        if (this.maxLonOffsetDeg < 180) {
            // Нормализуем разницу в (-180, 180].
            const d = ((lon - this.lon0 + 540) % 360) - 180;
            if (Math.abs(d) > this.maxLonOffsetDeg) return false;
        }
        return true;
    }

    /**
     * Проверяет, что спроецированные координаты конечны и «разумны».
     *
     * @param {Array.<number>} coord - [x, y] в метрах проекции.
     * @returns {boolean} true, если координаты допустимы.
     *
     * @example
     * Projections.get('EPSG:3857').isValidCoord([1e6, 2e6]); // true
     * Projections.get('EPSG:3857').isValidCoord([Infinity, 0]); // false
     */
    isValidCoord(coord) {
        if (!coord || coord.length < 2) return false;
        const x = coord[0], y = coord[1];
        if (!Number.isFinite(x) || !Number.isFinite(y)) return false;
        if (Math.abs(x) > this.maxAbsCoord || Math.abs(y) > this.maxAbsCoord) return false;
        return true;
    }

    /**
     * Возвращает прямоугольник области определения проекции в lon/lat
     * или null, если проекция безгранична (например, WGS84).
     *
     * Используется потребителями (Polygon) для клиппинга геометрии
     * в lon/lat перед проецированием — это позволяет корректно отсечь
     * часть полигона, выходящую за пределы области определения.
     *
     * @returns {{lonMin:number, lonMax:number, latMin:number, latMax:number}|null}
     *
     * @example
     * const b = Projections.get('EPSG:28407').getValidLonLatBounds();
     * // → { lonMin: 33, lonMax: 45, latMin: -84, latMax: 84 } для lon_0=39
     */
    getValidLonLatBounds() {
        if (this.maxLatDeg >= 90 && this.maxLonOffsetDeg >= 180) return null;
        const halfLon = Math.min(this.maxLonOffsetDeg, 180);
        return {
            lonMin: this.lon0 - halfLon,
            lonMax: this.lon0 + halfLon,
            latMin: -this.maxLatDeg,
            latMax: this.maxLatDeg
        };
    }

    /**
     * Преобразует координаты из СК этой проекции в другую проекцию.
     *
     * @param {Projection} other - Целевая проекция.
     * @param {Array.<number>} coord - Координаты [x, y] в этой СК.
     * @returns {Array.<number>} Координаты [x, y] в `other`.
     */
    convertTo(other, coord) { return proj4(this.def, other.def, coord); }

    /**
     * Проецирует WGS84 (lon/lat) в эту проекцию.
     *
     * @param {Array.<number>} coord - [долгота, широта] в градусах.
     * @returns {Array.<number>} [x, y] в метрах проекции.
     */
    fromLonLat(coord) { return proj4(HARDCODED['EPSG:4326'], this.def, coord); }

    /**
     * Обратное преобразование: из этой проекции в WGS84 (lon/lat).
     *
     * @param {Array.<number>} coord - [x, y] в метрах проекции.
     * @returns {Array.<number>} [долгота, широта] в градусах.
     */
    toLonLat(coord)   { return proj4(this.def, HARDCODED['EPSG:4326'], coord); }

    /**
     * Безопасная версия {@link Projection#fromLonLat}: возвращает null,
     * если точка вне области определения или результат невалиден.
     *
     * @param {Array.<number>} coord - [долгота, широта] в градусах.
     * @returns {Array.<number>|null} [x, y] или null.
     */
    fromLonLatSafe(coord) {
        if (!this.isValidLonLat(coord)) return null;
        const out = this.fromLonLat(coord);
        return this.isValidCoord(out) ? out : null;
    }

    /**
     * Безопасная версия {@link Projection#toLonLat}: возвращает null,
     * если входные координаты невалидны или результат не конечен.
     *
     * @param {Array.<number>} coord - [x, y] в метрах проекции.
     * @returns {Array.<number>|null} [долгота, широта] или null.
     */
    toLonLatSafe(coord) {
        if (!this.isValidCoord(coord)) return null;
        const out = this.toLonLat(coord);
        if (!out || !Number.isFinite(out[0]) || !Number.isFinite(out[1])) return null;
        return out;
    }
}

/**
 * Канонический экземпляр WGS84 (EPSG:4326).
 * @type {Projection}
 */
export const WGS84 = new Projection('EPSG:4326', HARDCODED['EPSG:4326']);

/**
 * Реестр проекций. Хранит зарегистрированные `Projection` по коду,
 * умеет дозагружать определения из `epsg_defs.json`.
 *
 * @example
 * Projections.register(new Projection('EPSG:32637', '+proj=utm +zone=37 ...'));
 * const p = Projections.get('EPSG:3857');
 * await Projections.ensure('EPSG:28407');
 */
class ProjectionRegistry {
    constructor() {
        /** @private @type {Map.<string, Projection>} */
        this._map = new Map();

        /** @private @type {Promise.<Object>|null} */
        this._defsPromise = null;

        this.register(WGS84);
        for (const [code, def] of Object.entries(HARDCODED)) {
            if (!this._map.has(code)) this.register(new Projection(code, def));
        }
    }

    /**
     * Регистрирует проекцию в реестре.
     *
     * @param {Projection} p - Экземпляр проекции.
     * @returns {Projection} Тот же экземпляр (для цепочек).
     */
    register(p) { this._map.set(p.code, p); return p; }

    /**
     * Проверяет, зарегистрирована ли проекция с данным кодом.
     *
     * @param {string} code - Код СК.
     * @returns {boolean}
     */
    has(code)   { return this._map.has(code); }

    /**
     * Возвращает проекцию по коду.
     *
     * @param {string} code - Код СК.
     * @returns {Projection}
     * @throws {Error} Если проекция не зарегистрирована.
     */
    get(code)   {
        const p = this._map.get(code);
        if (!p) throw new Error(
            `CRS ${code} не загружен. Сначала вызовите await Projections.ensure('${code}')`
        );
        return p;
    }

    /**
     * Дозагружает определение проекции из `epsg_defs.json` и регистрирует её.
     *
     * @param {string} code - Код СК.
     * @returns {Promise.<Projection>}
     * @throws {Error} Если код не найден в файле определений.
     */
    async ensure(code) {
        if (this._map.has(code)) return this._map.get(code);
        const defs = await this._loadDefs();
        const def = defs[code];
        if (!def) throw new Error(`CRS ${code} не найден в epsg_defs.json`);
        return this.register(new Projection(code, def));
    }

    /**
     * Дозагружает несколько проекций последовательно.
     *
     * @param {Array.<string>} codes - Массив кодов СК.
     * @returns {Promise.<void>}
     */
    async ensureMany(codes) { for (const c of codes) await this.ensure(c); }

    /**
     * Ленивая загрузка JSON с определениями СК.
     *
     * @private
     * @returns {Promise.<Object>}
     */
    _loadDefs() {
        if (!this._defsPromise) {
            this._defsPromise = fetch(new URL('./epsg_defs.json', import.meta.url))
                .then(r => r.json());
        }
        return this._defsPromise;
    }
}

/**
 * Глобальный реестр проекций.
 * @type {ProjectionRegistry}
 */
export const Projections = new ProjectionRegistry();