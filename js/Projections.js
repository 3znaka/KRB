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
 * Идея: proj4 возвращает либо конечные координаты (возможно, очень
 * большие — это нормально для точек далеко от зоны определения
 * проекции, и такие искажения нужно сохранять), либо NaN / Infinity
 * (вот это уже «мусор» — он и рисует «усы» через всю сцену).
 *
 * Projection умеет:
 *  - сказать, конечны ли входные lon/lat или спроецированные координаты;
 *  - для Mercator — «прижать» широту к ±85.05°, чтобы proj4 не вернул
 *    Infinity на полюсах (стандартный приём Leaflet/Mapbox/Google).
 *
 * Никаких «зон действия», никакого клиппинга. Точки далеко от зоны
 * UTM/Gauss-Kruger проецируются как есть — пусть искажаются, как в QGIS.
 *
 * @example
 * const utm = Projections.get('EPSG:32637');
 * utm.isValidLonLat([37.6, 55.7]);  // true — просто проверка на конечность
 * const merc = Projections.get('EPSG:3857');
 * merc.clampLonLat([0, 89]);        // [0, 85.05112878] — прижали к пределу
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

        // --- Разбор PROJ-строки (только для определения типа проекции) ---

        const projMatch = def.match(/\+proj=(\w+)/);
        /**
         * Имя проекции из PROJ-строки в нижнем регистре
         * ('merc', 'tmerc', 'utm', 'longlat', ...) или null.
         * @type {string|null}
         */
        this.projName = projMatch ? projMatch[1].toLowerCase() : null;

        /**
         * Является ли проекция разновидностью Меркатора (merc).
         * Для них есть смысл в ограничении широты — см. `maxLatDeg`.
         * @type {boolean}
         */
        this.isMercator = this.projName === 'merc';

        /**
         * Предельная широта (по модулю) для проекций Меркатора, до которой
         * потребитель должен «прижимать» точки перед проецированием, чтобы
         * не получить Infinity на полюсах.
         *
         * Стандартное значение ±85.05112878° — именно оно даёт квадратную
         * карту Web Mercator, и именно так поступают Leaflet, Mapbox, Google.
         *
         * `null` — проекция не требует ограничения широты (UTM, Gauss-Kruger,
         * WGS84, …). Заметьте: у UTM/GK область определения формально тоже
         * ограничена, но мы её НЕ проверяем — далёкие точки просто
         * проецируются с большими искажениями (как в QGIS), а не
         * отбрасываются и не клиппуются.
         *
         * @type {number|null}
         */
        this.maxLatDeg = this.isMercator ? 85.05112878 : null;
    }

    /**
     * Проверяет, что пара (lon, lat) — конечные числа.
     *
     * НЕ проверяет принадлежность «зоне действия» проекции: точки далеко
     * от центрального меридиана UTM/GK считаются валидными, потому что
     * мы хотим их проецировать и рисовать с естественными искажениями.
     *
     * @param {Array.<number>} lonLat - [долгота, широта] в градусах.
     * @returns {boolean} true, если оба значения конечны.
     *
     * @example
     * Projections.get('EPSG:32637').isValidLonLat([37.6, 55.7]);   // true
     * Projections.get('EPSG:32637').isValidLonLat([NaN, 55.7]);    // false
     */
    isValidLonLat(lonLat) {
        if (!lonLat || lonLat.length < 2) return false;
        return Number.isFinite(lonLat[0]) && Number.isFinite(lonLat[1]);
    }

    /**
     * Проверяет, что спроецированные координаты — конечные числа.
     *
     * НЕ проверяет «разумность» величины: большие числа (1e9+, 1e12+)
     * считаются валидными, потому что за границей зоны UTM/GK они
     * «закономерно» возникают и должны отображаться как искажения.
     * Отбрасываются только NaN и ±Infinity — именно они рисуют «усы».
     *
     * @param {Array.<number>} coord - [x, y] в метрах проекции.
     * @returns {boolean} true, если оба значения конечны.
     *
     * @example
     * Projections.get('EPSG:3857').isValidCoord([1e6, 2e6]);        // true
     * Projections.get('EPSG:3857').isValidCoord([Infinity, 0]);     // false
     */
    isValidCoord(coord) {
        if (!coord || coord.length < 2) return false;
        return Number.isFinite(coord[0]) && Number.isFinite(coord[1]);
    }

    /**
     * Прижимает широту к предельной, если проекция этого требует.
     *
     * Для Mercator: |lat| > 85.05° → прижимаем к ±85.05°.
     * Для остальных проекций: возвращает входной массив без изменений.
     *
     * Возвращает либо исходный массив (если изменения не требуются),
     * либо новый — вызывающая сторона не должна полагаться на идентичность
     * ссылок.
     *
     * @param {Array.<number>} lonLat - [долгота, широта] в градусах.
     * @returns {Array.<number>} [долгота, широта] с прижатой широтой.
     *
     * @example
     * Projections.get('EPSG:3857').clampLonLat([0, 89]);   // [0, 85.05112878]
     * Projections.get('EPSG:3857').clampLonLat([0, -88]);  // [0, -85.05112878]
     * Projections.get('EPSG:3857').clampLonLat([0, 55]);   // [0, 55] (без изменений)
     * Projections.get('EPSG:32637').clampLonLat([0, 89]);  // [0, 89] (без ограничений)
     */
    clampLonLat(lonLat) {
        if (this.maxLatDeg === null) return lonLat;
        const lon = lonLat[0];
        const lat = lonLat[1];
        if (!Number.isFinite(lat)) return lonLat;
        if (Math.abs(lat) <= this.maxLatDeg) return lonLat;
        return [lon, Math.sign(lat) * this.maxLatDeg];
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
     * Без клампа и проверок — «сырой» proj4. Может вернуть NaN/Infinity.
     * Для безопасной версии см. {@link Projection#fromLonLatSafe}.
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
     * Безопасная версия {@link Projection#fromLonLat}.
     *
     * Что делает:
     *  1. Проверяет конечность входных lon/lat.
     *  2. Применяет {@link Projection#clampLonLat} — прижимает широту
     *     к пределу для Mercator (для UTM/GK — no-op).
     *  3. Проецирует через proj4.
     *  4. Возвращает `null`, если результат не конечен (NaN/Infinity).
     *
     * Именно этой функцией должны пользоваться потребители, чтобы
     * гарантированно не получить «мусор» в буфере вершин.
     *
     * @param {Array.<number>} coord - [долгота, широта] в градусах.
     * @returns {Array.<number>|null} [x, y] в метрах или null.
     *
     * @example
     * const merc = Projections.get('EPSG:3857');
     * merc.fromLonLatSafe([0, 89]);   // [0, 1.99e7] — прижали к 85.05°
     * const utm = Projections.get('EPSG:32637');
     * utm.fromLonLatSafe([-120, 40]); // [огромное число, ...] — как есть
     */
    fromLonLatSafe(coord) {
        if (!this.isValidLonLat(coord)) return null;
        const clamped = this.clampLonLat(coord);
        const out = this.fromLonLat(clamped);
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