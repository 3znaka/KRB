// @ts-nocheck
// Projections.js
import proj4 from './js_TP/proj4.js';
const WORLD_HALF_X = 20037508.342789244;
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
let _formulaCounter = 0;
export class FormulaProjection {
    constructor(formula, options = {}) {
        if (!Array.isArray(formula) || formula.length !== 4) {
            throw new Error('FormulaProjection: ожидается массив из 4 функций [x(lat,lon), y(lat,lon), lat(x,y), lon(x,y)]');
        }
        for (let i = 0; i < 4; i++) {
            if (typeof formula[i] !== 'function') {
                throw new Error(`FormulaProjection: элемент [${i}] не является функцией`);
            }
        }
        this._formula = formula;
        this.code = options.code ?? `FORMULA:${++_formulaCounter}`;
        this.def = null; // совместимость с Projection
        this.isGeographic = options.isGeographic ?? false;
        this.isMercator = options.isMercator ?? false;
        this.projName = 'formula';
        this.lon0 = 0;
        this.maxLatDeg = options.maxLatDeg ?? null;
        this.maxAbsCoord = options.maxAbsCoord ?? 2.5e7;
        this.wrapsLongitude = options.wrapsLongitude ?? false;
        this._semiMajor = options.semiMajor ?? 6378137;
        this._halfExtentX = options.halfExtentX;
        this._halfExtentY = options.halfExtentY;
    }
    get semiMajor() { return this._semiMajor; }
    get halfExtentX() {
        if (this._halfExtentX !== undefined)
            return this._halfExtentX;
        if (this.isGeographic)
            return (this._halfExtentX = 180);
        const m = this._sampleExtent(0);
        return (this._halfExtentX = m > 0 ? m : Math.PI * this._semiMajor);
    }
    get halfExtentY() {
        if (this._halfExtentY !== undefined)
            return this._halfExtentY;
        if (this.isGeographic)
            return (this._halfExtentY = 90);
        const m = this._sampleExtent(1);
        return (this._halfExtentY = m > 0 ? m : Math.PI * this._semiMajor);
    }
    /** @private max|x| (axis=0) или max|y| (axis=1) по грубой сетке. */
    _sampleExtent(axis) {
        const idx = axis === 0 ? 0 : 1;
        let max = 0;
        const lats = [-90, -89.9, -80, -60, -40, -20, 0, 20, 40, 60, 80, 89.9, 90];
        const lons = [-180, -90, 0, 90, 180];
        for (const lat of lats) {
            for (const lon of lons) {
                let v;
                try {
                    v = this._formula[idx](lat, lon);
                }
                catch {
                    continue;
                }
                if (!Number.isFinite(v))
                    continue;
                const a = Math.abs(v);
                if (a > max)
                    max = a;
            }
        }
        return max;
    }
    isValidLonLat(ll) {
        if (!ll || ll.length < 2)
            return false;
        const lon = ll[0], lat = ll[1];
        if (!Number.isFinite(lon) || !Number.isFinite(lat))
            return false;
        if (Math.abs(lon) > 180.0001)
            return false;
        if (Math.abs(lat) > 90.0001)
            return false;
        return true;
    }
    isValidCoord(c) {
        if (!c || c.length < 2)
            return false;
        const x = c[0], y = c[1];
        if (!Number.isFinite(x) || !Number.isFinite(y))
            return false;
        if (Math.abs(x) > this.maxAbsCoord || Math.abs(y) > this.maxAbsCoord)
            return false;
        return true;
    }
    clampLonLat(ll) {
        if (this.maxLatDeg === null)
            return ll;
        const lon = ll[0], lat = ll[1];
        if (!Number.isFinite(lat))
            return ll;
        if (Math.abs(lat) <= this.maxLatDeg)
            return ll;
        return [lon, Math.sign(lat) * this.maxLatDeg];
    }
    convertTo(other, coord) {
        if (!other)
            return coord;
        if (other.def == null && typeof other.fromLonLat === 'function') {
            return other.fromLonLat(this.toLonLat(coord));
        }
        return proj4(this.def, other.def, coord);
    }
    fromLonLat([lon, lat]) {
        try {
            return [this._formula[0](lat, lon), this._formula[1](lat, lon)];
        }
        catch {
            return [NaN, NaN];
        }
    }
    toLonLat([x, y]) {
        try {
            const lat = this._formula[2](x, y);
            const lon = this._formula[3](x, y);
            return [lon, lat];
        }
        catch {
            return [NaN, NaN];
        }
    }
    fromLonLatSafe(coord) {
        if (!this.isValidLonLat(coord))
            return null;
        const clamped = this.clampLonLat(coord);
        const out = this.fromLonLat(clamped);
        return this.isValidCoord(out) ? out : null;
    }
    toLonLatSafe(coord) {
        if (!this.isValidCoord(coord))
            return null;
        const out = this.toLonLat(coord);
        if (!out || !Number.isFinite(out[0]) || !Number.isFinite(out[1]))
            return null;
        if (Math.abs(out[0]) > 180.0001 || Math.abs(out[1]) > 90.0001)
            return null;
        return out;
    }
}
// ============================================================
// ScaledProjection: добавляем делегирование недостающих полей
// ============================================================
class ScaledProjection {
    constructor(raw, worldScale) {
        this._raw = raw;
        this.worldScale = worldScale;
        this.code = raw.code;
        this.isMercator = raw.isMercator;
        this.semiMajor = raw.semiMajor;
        this.halfExtentX = raw.halfExtentX * worldScale;
        this.halfExtentY = raw.halfExtentY * worldScale;
    }
    fromLonLat(ll) {
        const p = this._raw.fromLonLat(ll);
        return [p[0] * this.worldScale, p[1] * this.worldScale];
    }
    toLonLat(xy) {
        return this._raw.toLonLat([xy[0] / this.worldScale, xy[1] / this.worldScale]);
    }
    fromLonLatSafe(ll) {
        const p = this._raw.fromLonLatSafe
            ? this._raw.fromLonLatSafe(ll)
            : this._raw.fromLonLat(ll);
        if (!p)
            return null;
        return [p[0] * this.worldScale, p[1] * this.worldScale];
    }
    toLonLatSafe(xy) {
        if (this._raw.toLonLatSafe) {
            return this._raw.toLonLatSafe([xy[0] / this.worldScale, xy[1] / this.worldScale]);
        }
        return this._raw.toLonLat([xy[0] / this.worldScale, xy[1] / this.worldScale]);
    }
    // ── NEW: прозрачное делегирование остального ──
    get def() { return this._raw.def; }
    get isGeographic() { return this._raw.isGeographic; }
    get projName() { return this._raw.projName; }
    get lon0() { return this._raw.lon0; }
    get maxLatDeg() { return this._raw.maxLatDeg; }
    get maxAbsCoord() { return this._raw.maxAbsCoord; }
    get wrapsLongitude() { return this._raw.wrapsLongitude; }
    isValidLonLat(ll) { return this._raw.isValidLonLat(ll); }
    isValidCoord(c) { return this._raw.isValidCoord(c); }
    clampLonLat(ll) { return this._raw.clampLonLat(ll); }
    convertTo(o, c) { return this._raw.convertTo(o, c); }
}
const _worldCache = new Map(); // для строковых кодов (оставляем как было)
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
        if (a)
            return parseFloat(a[1]);
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
        if (this._halfExtentX !== undefined)
            return this._halfExtentX;
        if (this.isMercator)
            return (this._halfExtentX = Math.PI * this._semiMajor);
        if (this.isGeographic)
            return (this._halfExtentX = 180);
        const p = this.fromLonLatSafe([180, 0]);
        return (this._halfExtentX = p ? Math.abs(p[0]) : Math.PI * this._semiMajor);
    }
    /** Полу-высота домена в координатах проекции. */
    get halfExtentY() {
        if (this._halfExtentY !== undefined)
            return this._halfExtentY;
        if (this.isMercator)
            return (this._halfExtentY = Math.PI * this._semiMajor);
        if (this.isGeographic)
            return (this._halfExtentY = 90);
        const lat = this.maxLatDeg ?? 85.05112878;
        const p = this.fromLonLatSafe([0, lat]) || this.fromLonLatSafe([0, 90]);
        return (this._halfExtentY = p ? Math.abs(p[1]) : Math.PI * this._semiMajor);
    }
    /** @private */
    _parseLon0(def) {
        const lon0Match = def.match(/\+lon_0=(-?[\d.]+)/);
        if (lon0Match)
            return parseFloat(lon0Match[1]);
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
        if (!lonLat || lonLat.length < 2)
            return false;
        const lon = lonLat[0], lat = lonLat[1];
        if (!Number.isFinite(lon) || !Number.isFinite(lat))
            return false;
        if (Math.abs(lon) > 180.0001)
            return false;
        if (Math.abs(lat) > 90.0001)
            return false;
        return true;
    }
    /**
     * Конечны ли спроецированные координаты и не «мусор» ли это.
     * @param {Array<number>} coord @returns {boolean}
     */
    isValidCoord(coord) {
        if (!coord || coord.length < 2)
            return false;
        const x = coord[0], y = coord[1];
        if (!Number.isFinite(x) || !Number.isFinite(y))
            return false;
        if (Math.abs(x) > this.maxAbsCoord || Math.abs(y) > this.maxAbsCoord)
            return false;
        return true;
    }
    /**
     * Прижимает широту к пределу (только для Mercator).
     * @param {Array<number>} lonLat @returns {Array<number>}
     */
    clampLonLat(lonLat) {
        if (this.maxLatDeg === null)
            return lonLat;
        const lon = lonLat[0], lat = lonLat[1];
        if (!Number.isFinite(lat))
            return lonLat;
        if (Math.abs(lat) <= this.maxLatDeg)
            return lonLat;
        return [lon, Math.sign(lat) * this.maxLatDeg];
    }
    /** @param {Projection} other @param {Array<number>} coord */
    convertTo(other, coord) { return proj4(this.def, other.def, coord); }
    /** «Сырой» proj4 (может вернуть NaN/Infinity). */
    fromLonLat(coord) { return proj4(HARDCODED['EPSG:4326'], this.def, coord); }
    toLonLat(coord) { return proj4(this.def, HARDCODED['EPSG:4326'], coord); }
    /**
     * Безопасная проекция: кламп широты + отсев мусора.
     * @param {Array<number>} coord @returns {Array<number>|null}
     */
    fromLonLatSafe(coord) {
        if (!this.isValidLonLat(coord))
            return null;
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
        if (!this.isValidCoord(coord))
            return null;
        const out = this.toLonLat(coord);
        if (!out || !Number.isFinite(out[0]) || !Number.isFinite(out[1]))
            return null;
        if (Math.abs(out[0]) > 180.0001 || Math.abs(out[1]) > 90.0001)
            return null;
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
        this._map = new Map();
        this._defsPromise = null;
        this._customLoading = new Map(); // code → Promise (дедуп параллельных вызовов)
        this._customMisses = new Set(); // code → 404 (чтобы не дёргать повторно)
        // кэши формул — по идентичности массива/объекта спецификации
        this._formulaRawCache = new WeakMap(); // input → FormulaProjection
        this._formulaWorldCache = new WeakMap(); // input → (FormulaProjection|ScaledProjection)
        this._worldInstanceCache = new WeakMap(); // raw instance → world
        this.register(WGS84);
        for (const [code, def] of Object.entries(HARDCODED)) {
            if (!this._map.has(code))
                this.register(new Projection(code, def));
        }
    }
    register(p) { this._map.set(p.code, p); return p; }
    has(code) { return typeof code === 'string' && this._map.has(code); }
    get(code) {
        const p = this._map.get(code);
        if (!p)
            throw new Error(`CRS ${code} не загружен. Вызовите \`await Projections.addCrs('${code}')\` ` +
                `до создания карты.`);
        return p;
    }
    // ── NEW: регистрация формулы под явным кодом ──
    registerFormula(codeOrFormula, formulaOrOptions, maybeOptions) {
        let code, formula, options;
        if (typeof codeOrFormula === 'string') {
            code = codeOrFormula;
            formula = formulaOrOptions;
            options = maybeOptions ?? {};
        }
        else {
            formula = codeOrFormula;
            options = formulaOrOptions ?? {};
            code = options.code;
        }
        if (!Array.isArray(formula) || formula.length !== 4) {
            throw new Error('registerFormula: ожидается массив из 4 функций');
        }
        if (!code)
            code = `FORMULA:${++_formulaCounter}`;
        const proj = new FormulaProjection(formula, { ...options, code });
        this._map.set(code, proj);
        this._formulaRawCache.set(formula, proj);
        return proj;
    }
    /** @private */
    _getOrCreateFormulaRaw(input) {
        const cached = this._formulaRawCache.get(input);
        if (cached)
            return cached;
        let formula, options;
        if (Array.isArray(input)) {
            formula = input;
            options = {};
        }
        else if (input && input.formula) {
            formula = input.formula;
            options = input;
        }
        else {
            throw new Error('getRaw: неподдерживаемый тип проекции');
        }
        const code = options.code;
        if (code && this._map.has(code)) {
            const existing = this._map.get(code);
            if (existing instanceof FormulaProjection && existing._formula === formula) {
                this._formulaRawCache.set(input, existing);
                return existing;
            }
            throw new Error(`CRS ${code} уже зарегистрирован другой проекцией`);
        }
        const raw = new FormulaProjection(formula, {
            ...options,
            code: code ?? `FORMULA:${++_formulaCounter}`,
        });
        this._map.set(raw.code, raw);
        this._formulaRawCache.set(input, raw);
        if (input !== formula)
            this._formulaRawCache.set(formula, raw);
        return raw;
    }
    async _addOne(code) {
        if (this._map.has(code))
            return;
        // 1) customCRS/<code с : → _>.js
        if (!this._customMisses.has(code)) {
            const inflight = this._customLoading.get(code);
            if (inflight) {
                await inflight;
                if (this._map.has(code))
                    return;
            }
            else {
                const p = this._loadCustom(code)
                    .finally(() => this._customLoading.delete(code));
                this._customLoading.set(code, p);
                await p;
                if (this._map.has(code))
                    return;
            }
        }
        // 2) epsg_defs.json
        const defs = await this._loadDefs();
        const def = defs?.[code];
        if (def) {
            this.register(new Projection(code, def));
            return;
        }
        throw new Error(`addCrs(${code}): не найден ни в customCRS/${code.replace(':', '_')}.js, ` +
            `ни в epsg_defs.json`);
    }
    async _loadCustom(code) {
        const fileName = code.replace(':', '_') + '.js';
        let url;
        try {
            url = new URL(`./customCRS/${fileName}`, import.meta.url).href;
        }
        catch {
            // невалидный код — файла точно нет
            this._customMisses.add(code);
            return;
        }
        let mod;
        try {
            mod = await import(/* @vite-ignore */ url);
        }
        catch (err) {
            const msg = String(err?.message || err);
            const isNotFound = /failed to fetch dynamically imported module/i.test(msg) ||
                /error loading dynamically imported module/i.test(msg) ||
                /importing a module script failed/i.test(msg) ||
                err?.name === 'TypeError'; // сетевые ошибки обычно TypeError
            if (isNotFound) {
                this._customMisses.add(code);
                return;
            }
            // Файл есть, но упал при исполнении/парсинге — не притворяемся, что его нет
            throw new Error(`addCrs(${code}): файл customCRS/${fileName} есть, но не загрузился: ${msg}`);
        }
        const spec = mod?.default;
        if (!spec || typeof spec !== 'object') {
            throw new Error(`addCrs(${code}): ${fileName} не экспортирует default-спек`);
        }
        if (spec.formula) {
            if (!Array.isArray(spec.formula) || spec.formula.length !== 4) {
                throw new Error(`addCrs(${code}): spec.formula должен быть массивом из 4 функций`);
            }
            const proj = new FormulaProjection(spec.formula, { ...(spec.options || {}), code });
            this._formulaRawCache.set(spec.formula, proj);
            this._map.set(code, proj);
            return;
        }
        if (spec.def) {
            this._map.set(code, new Projection(code, spec.def));
            return;
        }
        throw new Error(`addCrs(${code}): спек должен содержать 'formula' или 'def'`);
    }
    async addCrs(codeOrCodes) {
        const list = Array.isArray(codeOrCodes) ? codeOrCodes : [codeOrCodes];
        await Promise.all(list.map(c => this._addOne(c)));
    }
    ensure(code) { return this.addCrs(code); }
    ensureMany(codes) { return this.addCrs(codes); }
    _loadDefs() {
        if (!this._defsPromise) {
            this._defsPromise = fetch(new URL('./epsg_defs.json', import.meta.url))
                .then(r => r.ok ? r.json() : {})
                .catch(() => ({}));
        }
        return this._defsPromise;
    }
    getRaw(codeOrProj) {
        if (typeof codeOrProj === 'string')
            return this.get(codeOrProj);
        if (Array.isArray(codeOrProj))
            return this._getOrCreateFormulaRaw(codeOrProj);
        if (codeOrProj && codeOrProj.formula)
            return this._getOrCreateFormulaRaw(codeOrProj);
        return codeOrProj;
    }
    /** @private обёртка raw → world (та же логика масштабирования, что была). */
    _wrapWorld(raw) {
        let scale = WORLD_HALF_X / raw.halfExtentX;
        if (!Number.isFinite(scale) || scale <= 0)
            scale = 1;
        if (Math.abs(scale - 1) < 1e-9)
            scale = 1;
        return scale === 1 ? raw : new ScaledProjection(raw, scale);
    }
    getWorld(codeOrProj) {
        // 1) строковый код — прежнее поведение
        if (typeof codeOrProj === 'string') {
            const hit = _worldCache.get(codeOrProj);
            if (hit)
                return hit;
            const wrapped = this._wrapWorld(this.get(codeOrProj));
            _worldCache.set(codeOrProj, wrapped);
            return wrapped;
        }
        // 2) массив/спецификация формулы
        if (Array.isArray(codeOrProj) ||
            (codeOrProj && typeof codeOrProj === 'object' && codeOrProj.formula)) {
            const hit = this._formulaWorldCache.get(codeOrProj);
            if (hit)
                return hit;
            const raw = this._getOrCreateFormulaRaw(codeOrProj);
            const wrapped = this._wrapWorld(raw);
            this._formulaWorldCache.set(codeOrProj, wrapped);
            return wrapped;
        }
        // 3) уже готовый инстанс
        if (codeOrProj && typeof codeOrProj.fromLonLat === 'function') {
            if (codeOrProj.worldScale !== undefined)
                return codeOrProj; // уже world
            const hit = this._worldInstanceCache.get(codeOrProj);
            if (hit)
                return hit;
            const wrapped = this._wrapWorld(codeOrProj);
            this._worldInstanceCache.set(codeOrProj, wrapped);
            return wrapped;
        }
        return codeOrProj;
    }
}
export const Projections = new ProjectionRegistry();
export const addCrs = (codeOrCodes) => Projections.addCrs(codeOrCodes);
