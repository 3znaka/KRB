// @ts-nocheck
// Projections.ts
import proj4 from './js_TP/proj4.js';
import { Ellipsoid, ELLIPSOIDS, parseEllipsoid } from './Ellipsoid.js';
import { createEcefProjection, isGeocentricDef } from './EcefProjection.js';
import { DATUMS, convertDatum, datumFromProj, needsDatumShift } from './Datums.js';
import { assetUrl, getBundledCustomCrs, getBundledEpsgDefs } from './assets.js';
export { Ellipsoid, ELLIPSOIDS, parseEllipsoid };
const WORLD_HALF_X = 20037508.342789244;
const PROJ_RE = /\+proj\s*=/i;
const WKT_RE = /^(PROJCS|GEOGCS|PROJCRS|GEOGCRS|GEODCRS|GEOCCS|LOCAL_CS|ENGCRS|COMPD_CS|VERT_CS)\s*\[/i;
/** Эвристика: похоже ли содержимое на определение проекции, а не на код. */
function isProjectionDef(s) {
    const t = s.trim();
    return /\+proj\s*=/i.test(t) ||
        /^(PROJCS|GEOGCS|PROJCRS|GEOGCRS|GEODCRS|GEOCCS|LOCAL_CS|ENGCRS|COMPD_CS|VERT_CS)\s*\[/i.test(t);
}
/** Стабильный короткий хеш для безымянных PROJ-строк. */
function defCode(def) {
    let h = 0x811c9dc5;
    for (let i = 0; i < def.length; i++) {
        h ^= def.charCodeAt(i);
        h = Math.imul(h, 0x01000193) >>> 0;
    }
    return `CUSTOM:${h.toString(36).toUpperCase()}`;
}
/** ESRI_54052.js → 'ESRI:54052'; иначе — имя без расширения. */
function codeFromFilename(name) {
    const stem = name.replace(/\.[^.]+$/, '');
    const m = stem.match(/^([A-Za-z][A-Za-z0-9]*)[_-](\d+)$/);
    return m ? `${m[1].toUpperCase()}:${m[2]}` : (stem || undefined);
}
const HARDCODED = {
    'EPSG:4326': '+proj=longlat +datum=WGS84 +no_defs +type=crs',
    'EPSG:3857': '+proj=merc +a=6378137 +b=6378137 +lat_ts=0 +lon_0=0 +x_0=0 +y_0=0 +k=1 +units=m +nadgrids=@null +no_defs +type=crs',
    'EPSG:3395': '+proj=merc +lon_0=0 +k=1 +x_0=0 +y_0=0 +datum=WGS84 +units=m +no_defs +type=crs',
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
        this.isGeocentric = options.isGeocentric ?? false;
        this.isMercator = options.isMercator ?? false;
        this.projName = 'formula';
        this.lon0 = 0;
        this.maxLatDeg = options.maxLatDeg ?? null;
        this.maxAbsCoord = options.maxAbsCoord ?? 2.5e7;
        this.wrapsLongitude = options.wrapsLongitude ?? false;
        this.lobes = options.lobes ?? null;
        this.options = options;
        this._ellipsoid = options.ellipsoid
            ?? (options.semiMajor != null
                ? new Ellipsoid({ a: options.semiMajor }) // сфера указанного радиуса
                : ELLIPSOIDS.wgs84);
        this._halfExtentX = options.halfExtentX;
        this._halfExtentY = options.halfExtentY;
    }
    get ellipsoid() { return this._ellipsoid; }
    get semiMajor() { return this._ellipsoid.a; }
    get meanRadius() { return this._ellipsoid.meanRadius; }
    get authalicRadius() { return this._ellipsoid.authalicRadius; }
    get isSphere() { return this._ellipsoid.isSphere; }
    get radiusInDomain() { return this.isGeographic ? 180 / Math.PI : this._ellipsoid.a; }
    get halfExtentX() {
        if (this._halfExtentX !== undefined)
            return this._halfExtentX;
        if (this.isGeographic)
            return (this._halfExtentX = 180);
        const m = this._sampleExtent(0);
        return (this._halfExtentX = m > 0 ? m : Math.PI * this._ellipsoid.a);
    }
    get halfExtentY() {
        if (this._halfExtentY !== undefined)
            return this._halfExtentY;
        if (this.isGeographic)
            return (this._halfExtentY = 90);
        const m = this._sampleExtent(1);
        return (this._halfExtentY = m > 0 ? m : Math.PI * this._ellipsoid.a);
    }
    /** @private */
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
// ScaledProjection — world-обёртка
// ============================================================
class ScaledProjection {
    constructor(raw, worldScale) {
        this._raw = raw;
        this.worldScale = worldScale;
        this.code = raw.code;
        this.isMercator = raw.isMercator;
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
    // ── Делегирование ──
    get ellipsoid() { return this._raw.ellipsoid; }
    get isSphere() { return this._raw.isSphere; }
    get isGeocentric() { return this._raw.isGeocentric === true; }
    /**
     * Радиус Земли в world-единицах — той же единице, что halfExtentX_world.
     * Для Mercator ≈ WORLD_HALF_X/π; для geographic — то же значение
     * (180/π × worldScale = WORLD_HALF_X/π); для прочих — a × worldScale.
     */
    get radiusInDomain() { return this._raw.radiusInDomain * this.worldScale; }
    get semiMajor() {
        return this._raw.isGeographic
            ? this.radiusInDomain
            : this._raw.semiMajor * this.worldScale;
    }
    get meanRadius() {
        return this._raw.isGeographic
            ? this.radiusInDomain
            : this._raw.meanRadius * this.worldScale;
    }
    get authalicRadius() {
        return this._raw.isGeographic
            ? this.radiusInDomain
            : this._raw.authalicRadius * this.worldScale;
    }
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
// ============================================================
// Projection
// ============================================================
const _worldCache = new Map();
/**
 * Обёртка над proj4 с валидацией. Полная PROJ-строка идёт в proj4
 * как есть (эллипсоид учитывается там), а `ellipsoid` здесь —
 * для extent'ов, камеры, площадей и ECEF.
 */
export class Projection {
    /**
     * @param code — код СК ('EPSG:4326', 'EPSG:32637', ...).
     * @param def  — PROJ-строка.
     */
    constructor(code, def) {
        if (isGeocentricDef(def)) {
            throw new Error(`${code}: +proj=geocent не поддерживается proj4. ` +
                `Используйте createEcefProjection (addCrs делает это автоматически).`);
        }
        this.code = code;
        this.def = def;
        this.isGeographic = /\+proj=longlat/.test(def);
        const projMatch = def.match(/\+proj=(\w+)/);
        this.projName = projMatch ? projMatch[1].toLowerCase() : null;
        this.isMercator = this.projName === 'merc';
        this.lon0 = this._parseLon0(def);
        /** Предельная широта для Mercator (прижимаем к ±85.05°). */
        this.maxLatDeg = this.isMercator ? 85.05112878 : null;
        /** Порог «мусора» для спроецированных координат (метры). */
        this.maxAbsCoord = 2.5e7;
        this._ellipsoid = parseEllipsoid(def);
        this._halfExtentX = undefined;
        this._halfExtentY = undefined;
        // Датум, отличный от WGS-84 (ГСК-2011, СК-42, ...). Для остальных null,
        // и поведение проекции не меняется.
        this._datumShift = this.isGeographic && needsDatumShift(def)
            ? datumFromProj(def)
            : null;
        this._conv = null; // WGS84 <-> this
        this._convTo = new Map(); // this -> other.code
        this._fastMerc = this.isMercator && this._ellipsoid.isSphere
            && !/\+x_0=(?!0\b)|\+y_0=(?!0\b)|\+k=(?!1\b)/.test(def) && this.lon0 === 0;
        this._a = this._ellipsoid.a;
    }
    get ellipsoid() { return this._ellipsoid; }
    get semiMajor() { return this._ellipsoid.a; }
    get meanRadius() { return this._ellipsoid.meanRadius; }
    get authalicRadius() { return this._ellipsoid.authalicRadius; }
    get isSphere() { return this._ellipsoid.isSphere; }
    // в Projection:
    /** «Радиус Земли» в тех же единицах, что halfExtentX (a для линейных, 180/π для угловых). */
    get radiusInDomain() {
        return this.isGeographic ? 180 / Math.PI : this._ellipsoid.a;
    }
    /** Полу-ширина домена в координатах проекции. */
    get halfExtentX() {
        if (this._halfExtentX !== undefined)
            return this._halfExtentX;
        if (this.isMercator)
            return (this._halfExtentX = Math.PI * this._ellipsoid.a);
        if (this.isGeographic)
            return (this._halfExtentX = 180);
        const p = this.fromLonLatSafe([180, 0]);
        return (this._halfExtentX = p ? Math.abs(p[0]) : Math.PI * this._ellipsoid.a);
    }
    /**
     * Полу-высота домена. Для Mercator — точная формула:
     *   y(φ) = a · ln( tan(π/4 + φ/2) · ((1−e·sinφ)/(1+e·sinφ))^(e/2) )
     * Для сферы (`a === b`) сводится к π·a.
     */
    get halfExtentY() {
        if (this._halfExtentY !== undefined)
            return this._halfExtentY;
        const ell = this._ellipsoid;
        if (this.isGeographic)
            return (this._halfExtentY = 90);
        if (this.isMercator) {
            if (ell.isSphere)
                return (this._halfExtentY = Math.PI * ell.a);
            const phi = (this.maxLatDeg ?? 85.05112878) * Math.PI / 180;
            const s = Math.sin(phi);
            const e = ell.e;
            const y = ell.a * Math.log(Math.tan(Math.PI / 4 + phi / 2) *
                Math.pow((1 - e * s) / (1 + e * s), e / 2));
            return (this._halfExtentY = Math.abs(y));
        }
        const lat = this.maxLatDeg ?? 85.05112878;
        const p = this.fromLonLatSafe([0, lat]) || this.fromLonLatSafe([0, 90]);
        return (this._halfExtentY = p ? Math.abs(p[1]) : Math.PI * ell.a);
    }
    /** @private */
    _parseLon0(def) {
        const lon0Match = def.match(/\+lon_0=(-?[\d.]+)/);
        if (lon0Match)
            return parseFloat(lon0Match[1]);
        const zoneMatch = def.match(/\+zone=(\d+)/);
        if (zoneMatch) {
            const zone = parseInt(zoneMatch[1], 10);
            return -177 + (zone - 1) * 6;
        }
        return 0;
    }
    isValidLonLat(lonLat) {
        if (!lonLat || lonLat.length < 2)
            return false;
        const lon = lonLat[0], lat = lonLat[1];
        if (!Number.isFinite(lon) || !Number.isFinite(lat))
            return false;
        if (Math.abs(lon) > 360.5)
            return false;
        if (Math.abs(lat) > 90.5)
            return false;
        return true;
    }
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
    clampLonLat(lonLat) {
        const lon = lonLat[0], lat = lonLat[1];
        if (!Number.isFinite(lat))
            return lonLat;
        const maxLat = this.maxLatDeg ?? 89.999999;
        const cLat = Math.max(-maxLat, Math.min(maxLat, lat));
        const cLon = (lon < -180 && lon >= -185) ? -180 : ((lon > 180 && lon <= 185) ? 180 : lon);
        return [cLon, cLat];
    }
    _getConv() {
        return this._conv ?? (this._conv = proj4(HARDCODED['EPSG:4326'], this.def));
    }
    fromLonLat(coord) {
        const maxLat = this.maxLatDeg ?? 89.999999;
        const lon = coord[0];
        const lat = Math.max(-maxLat, Math.min(maxLat, coord[1]));
        if (this.isGeographic) {
            // Вход — WGS-84 градусы; для CRS с датумом переводим в её датум.
            if (this._datumShift) {
                const r = convertDatum([lon, lat, 0], DATUMS.wgs84, this._datumShift);
                return [r[0], r[1]];
            }
            return [lon, lat];
        }
        if (this._fastMerc) {
            const a = this._a, D = Math.PI / 180;
            return [a * lon * D, a * Math.log(Math.tan(Math.PI / 4 + lat * D / 2))];
        }
        return this._getConv().forward([lon, lat]);
    }
    toLonLat(coord) {
        if (this.isGeographic) {
            const lat = Math.max(-89.999999, Math.min(89.999999, coord[1]));
            // Выход — WGS-84 градусы; из датума CRS переводим в WGS-84.
            if (this._datumShift) {
                const r = convertDatum([coord[0], lat, 0], this._datumShift, DATUMS.wgs84);
                return [r[0], r[1]];
            }
            return [coord[0], lat];
        }
        if (this._fastMerc) {
            const a = this._a, R = 180 / Math.PI;
            return [coord[0] / a * R, (2 * Math.atan(Math.exp(coord[1] / a)) - Math.PI / 2) * R];
        }
        return this._getConv().inverse(coord);
    }
    convertTo(other, coord) {
        if (!other)
            return coord;
        const inCoord = this.isGeographic
            ? (typeof other.clampLonLat === 'function' ? other.clampLonLat(coord) : this.clampLonLat(coord))
            : coord;
        // Если хотя бы один датум не WGS-84 — прямой proj4 между определениями
        // датум не учитывает, поэтому переход идёт через WGS-84 (lon/lat).
        const datumInvolved = !!this._datumShift || !!other._datumShift;
        if (other.def == null || datumInvolved) {
            return other.fromLonLat(this.toLonLat(inCoord));
        }
        let c = this._convTo.get(other.code);
        if (!c) {
            c = proj4(this.def, other.def);
            this._convTo.set(other.code, c);
        }
        return c.forward(inCoord);
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
        if (Math.abs(out[0]) > 360.5 || Math.abs(out[1]) > 90.5)
            return null;
        return out;
    }
}
/** Канонический WGS84. */
export const WGS84 = new Projection('EPSG:4326', HARDCODED['EPSG:4326']);
// ============================================================
// ProjectionRegistry
// ============================================================
class ProjectionRegistry {
    constructor() {
        this._map = new Map();
        this._defsPromise = null;
        this._customLoading = new Map();
        this._customMisses = new Set();
        this._formulaRawCache = new WeakMap();
        this._formulaWorldCache = new WeakMap();
        this._worldInstanceCache = new WeakMap();
        this.register(WGS84);
        for (const [code, def] of Object.entries(HARDCODED)) {
            if (!this._map.has(code))
                this.register(new Projection(code, def));
        }
    }
    register(p) { this._map.set(p.code, p); _worldCache.delete(p.code); return p; }
    has(code) { return typeof code === 'string' && this._map.has(code); }
    get(code) {
        const p = this._map.get(code);
        if (!p)
            throw new Error(`CRS ${code} не загружен. Вызовите \`await Projections.addCrs('${code}')\` ` +
                `до создания карты.`);
        return p;
    }
    /**
     * Универсальная точка входа для регистрации СК.
     * Автоматически определяет тип ввода и делегирует специализированному методу.
     *
     * @param input Код, массив кодов, PROJ/WKT-строка, File/Blob или CrsSpec.
     * @param fallbackCode Код, который будет использован, если он не указан в input
     *                     (например, для File без spec.code или для анонимной PROJ-строки).
     */
    async add(input, fallbackCode) {
        // 1. Массив кодов
        if (Array.isArray(input)) {
            await this.addCrs(input);
            return;
        }
        // 2. File или Blob (проверка File через typeof, чтобы не упасть в Node.js)
        if ((typeof File !== 'undefined' && input instanceof File) || input instanceof Blob) {
            return await this.addFile(input, fallbackCode);
        }
        // 3. Объект-спецификация (CrsSpec)
        if (typeof input === 'object' && input !== null) {
            const spec = input;
            if (spec.formula || spec.def) {
                return this.addSpec(spec, fallbackCode ?? spec.code);
            }
        }
        // 4. Строка: код или определение?
        if (typeof input === 'string') {
            const trimmed = input.trim();
            if (isProjectionDef(trimmed)) {
                // Это PROJ/WKT. Если код не передан, генерируем стабильный хеш.
                const code = fallbackCode ?? defCode(trimmed);
                return this.addDef(code, trimmed);
            }
            else {
                // Это код (или список кодов через запятую, хотя массив предпочтительнее)
                return this.addCrs(trimmed);
            }
        }
        throw new Error('KRB.crs.add: неподдерживаемый тип аргумента');
    }
    registerFormula(codeOrFormula, formulaOrOptions, maybeOptions) {
        if (codeOrFormula && !Array.isArray(codeOrFormula)
            && typeof codeOrFormula === 'object' && codeOrFormula.formula) {
            return this._registerSpec(codeOrFormula, maybeOptions?.code);
        }
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
        _worldCache.delete(proj.code);
        return proj;
    }
    /** @private Единая точка регистрации по PROJ-строке (epsg_defs.json и customCRS). */
    _registerDef(code, def) {
        _worldCache.delete(code);
        if (isGeocentricDef(def)) {
            // proj4 не поддерживает geocent — строим формульную ECEF-проекцию,
            // эллипсоид парсится ИЗ ЭТОЙ ЖЕ строки (WGS72, GRS80, krass, ...)
            return this.register(createEcefProjection(code, parseEllipsoid(def)));
        }
        return this.register(new Projection(code, def));
    }
    _getOrCreateFormulaRaw(input) {
        const cached = this._formulaRawCache.get(input);
        if (cached)
            return cached;
        if (input && !Array.isArray(input) && input.formula) {
            return this._registerSpec(input);
        }
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
            this._registerDef(code, def);
            return;
        }
        throw new Error(`addCrs(${code}): не найден ни в customCRS/${code.replace(':', '_')}.js, ` +
            `ни в epsg_defs.json`);
    }
    async _loadCustom(code) {
        const fileName = code.replace(':', '_') + '.js';
        // Бандл: модуль CRS вшит заранее. Обычный режим: динамический import файла.
        const embedded = getBundledCustomCrs(code);
        let url;
        if (!embedded) {
            try {
                url = assetUrl(`customCRS/${fileName}`);
            }
            catch {
                this._customMisses.add(code);
                return;
            }
        }
        let mod;
        try {
            mod = embedded ? embedded : await import(/* @vite-ignore */ url);
        }
        catch (err) {
            const msg = String(err?.message || err);
            // Файла customCRS нет — это штатный случай (код берём из epsg_defs).
            // Покрываем формулировки браузеров и Node: "Failed to fetch dynamically imported
            // module", "Cannot find module", "ERR_MODULE_NOT_FOUND", "Error loading ...".
            const isNotFound = /failed to fetch dynamically imported module/i.test(msg) ||
                /error loading dynamically imported module/i.test(msg) ||
                /importing a module script failed/i.test(msg) ||
                /cannot find module/i.test(msg) ||
                /module_not_found/i.test(msg) ||
                /ERR_MODULE_NOT_FOUND/.test(String(err?.code || ''));
            if (isNotFound) {
                this._customMisses.add(code);
                return;
            }
            throw new Error(`addCrs(${code}): файл customCRS/${fileName} есть, но не загрузился: ${msg}`);
        }
        const spec = mod?.default;
        if (!spec || typeof spec !== 'object') {
            throw new Error(`addCrs(${code}): ${fileName} не экспортирует default-спек`);
        }
        // в _loadCustom
        if (spec.formula) {
            if (!Array.isArray(spec.formula) || spec.formula.length !== 4) {
                throw new Error(`addCrs(${code}): spec.formula должен быть массивом из 4 функций`);
            }
            const proj = new FormulaProjection(spec.formula, {
                ...(spec.options || {}),
                lobes: spec.options?.lobes ?? spec.lobes, // ← fallback на корень spec
                code,
            });
            this._formulaRawCache.set(spec.formula, proj);
            this._map.set(code, proj);
            return;
        }
        if (spec.def) {
            this._registerDef(code, spec.def);
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
            // Бандл: распаковка вшитого (ленивая, один раз). Иначе — файл по URL.
            const embeddedDefs = getBundledEpsgDefs();
            if (embeddedDefs) {
                this._defsPromise = embeddedDefs.catch(() => ({}));
                return this._defsPromise;
            }
            this._defsPromise = fetch(assetUrl('epsg_defs.json'))
                .then(r => r.ok ? r.json() : {})
                .catch(() => ({}));
        }
        return this._defsPromise;
    }
    getRaw(codeOrProj) {
        if (isProjectionDef(codeOrProj))
            return this._resolveDefString(codeOrProj);
        if (typeof codeOrProj === 'string')
            return this.get(codeOrProj);
        if (Array.isArray(codeOrProj))
            return this._getOrCreateFormulaRaw(codeOrProj);
        if (codeOrProj && codeOrProj.formula)
            return this._getOrCreateFormulaRaw(codeOrProj);
        return codeOrProj;
    }
    /** URL файла customCRS/<code>.js, если он существует по соглашению об именах. */
    getCustomCrsUrl(code) {
        const fileName = code.replace(':', '_') + '.js';
        try {
            return assetUrl(`customCRS/${fileName}`);
        }
        catch {
            return null;
        }
    }
    /** @private обёртка raw → world. */
    _wrapWorld(raw) {
        let scale = WORLD_HALF_X / raw.halfExtentX;
        if (!Number.isFinite(scale) || scale <= 0)
            scale = 1;
        if (Math.abs(scale - 1) < 1e-9)
            scale = 1;
        return scale === 1 ? raw : new ScaledProjection(raw, scale);
    }
    getWorld(codeOrProj) {
        if (isProjectionDef(codeOrProj))
            return this._resolveDefString(codeOrProj);
        // 1) строковый код
        if (typeof codeOrProj === 'string') {
            const hit = _worldCache.get(codeOrProj);
            if (hit)
                return hit;
            const wrapped = this._wrapWorld(this.get(codeOrProj));
            _worldCache.set(codeOrProj, wrapped);
            return wrapped;
        }
        // 2) массив / спецификация формулы
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
        // 3) готовый инстанс
        if (codeOrProj && typeof codeOrProj.fromLonLat === 'function') {
            if (codeOrProj.worldScale !== undefined)
                return codeOrProj;
            const hit = this._worldInstanceCache.get(codeOrProj);
            if (hit)
                return hit;
            const wrapped = this._wrapWorld(codeOrProj);
            this._worldInstanceCache.set(codeOrProj, wrapped);
            return wrapped;
        }
        return codeOrProj;
    }
    /** @private кэш безымянных PROJ-строк: одна строка → один инстанс. */
    _defByString = new Map();
    /** @private Единая нормализация спека: {def} | {formula}, вложенные options, lobes. */
    _registerSpec(spec, codeOverride, fallbackCode) {
        if (!spec || typeof spec !== 'object') {
            throw new Error('CRS spec: ожидается объект');
        }
        const code = codeOverride ?? spec.code ?? fallbackCode;
        if (spec.def) {
            if (!code)
                throw new Error('CRS spec: для def нужен code');
            return this._registerDef(code, String(spec.def).trim());
        }
        if (Array.isArray(spec.formula)) {
            if (spec.formula.length !== 4 || spec.formula.some(f => typeof f !== 'function')) {
                throw new Error('CRS spec: formula должен быть массивом из 4 функций');
            }
            const opts = {
                ...(spec.options ?? {}),
                lobes: spec.options?.lobes ?? spec.lobes,
                code: code ?? `FORMULA:${++_formulaCounter}`,
            };
            const prev = this._map.get(opts.code);
            if (prev)
                console.warn(`[Projections] СК ${opts.code} перезаписана новой формулой`);
            const proj = new FormulaProjection(spec.formula, opts);
            this._map.set(proj.code, proj);
            this._formulaRawCache.set(spec.formula, proj);
            this._formulaRawCache.set(spec, proj);
            _worldCache.delete(proj.code);
            return proj;
        }
        throw new Error('CRS spec: нужен def или formula');
    }
    /** PROJ-строка или WKT + код. Синхронно. */
    addDef(code, def) {
        if (!code)
            throw new Error('addDef: нужен code');
        if (typeof def !== 'string' || !def.trim())
            throw new Error('addDef: def должен быть строкой');
        const p = this._registerDef(code, def.trim());
        try {
            const probe = p.fromLonLat([0, 0]);
            if (!probe || !Number.isFinite(probe[0])) {
                console.warn(`[Projections] ${code}: fromLonLat([0,0]) не дал числа — проверь определение`);
            }
        }
        catch (e) {
            console.warn(`[Projections] ${code}: определение не прошло проверку`, e);
        }
        return p;
    }
    /** Spec-объект как default-экспорт customCRS/*.js. Синхронно. */
    addSpec(spec, code) { return this._registerSpec(spec, code); }
    /** @private безымянная строка → стабильный код + кэш. */
    _resolveDefString(def) {
        const key = def.trim().replace(/\s+/g, ' ');
        const hit = this._defByString.get(key);
        if (hit)
            return hit;
        const p = this._registerDef(defCode(key), key);
        this._defByString.set(key, p);
        return p;
    }
    /** Каталог customCRS как база для относительных импортов. */
    _customCrsDir() {
        return assetUrl('customCRS/');
    }
    /** '../Ellipsoid.js' → абсолютный URL библиотеки. Эвристика, не AST. */
    _rewriteImports(src) {
        const rel = this._customCrsDir();
        // Относительная база (бандл) не годится для new URL — переписывать нечего:
        // вшитые CRS уже разрешены при сборке.
        let base;
        try {
            base = new URL(rel, document.baseURI).href;
        }
        catch {
            return src;
        }
        return src.replace(/(\bfrom\s*|\bimport\s*\(?\s*)(['"])(\.\.?\/[^'"]+)\2/g, (_m, head, q, spec) => `${head}${q}${new URL(spec, base).href}${q}`);
    }
    /** Текст файла: PROJ/WKT, JSON-спек или JS-модуль. */
    async addText(text, opts = {}) {
        const src = String(text);
        const t = src.trim();
        if (opts.kind === 'def' || (!opts.kind && isProjectionDef(t))) {
            return opts.code
                ? this.addDef(opts.code, t)
                : this._resolveDefString(t);
        }
        if (opts.kind === 'json' || (!opts.kind && t.startsWith('{'))) {
            return this._registerSpec(JSON.parse(t), opts.code, opts.fallbackCode);
        }
        // JS-модуль: переписываем относительные импорты и грузим через blob.
        const named = opts.name ? `\n//# sourceURL=${opts.name}\n` : '';
        const blob = new Blob([this._rewriteImports(src) + named], { type: 'text/javascript' });
        const url = URL.createObjectURL(blob);
        const mod = await import(/* @vite-ignore */ url);
        const spec = mod?.default ?? mod;
        if (!spec || typeof spec !== 'object') {
            throw new Error('addText: файл не экспортирует default-спек');
        }
        return this._registerSpec(spec, opts.code, opts.fallbackCode);
    }
    /** Файл с диска пользователя (File из <input> или drag&drop). */
    async addFile(file, code) {
        const name = file.name ?? '';
        const ext = name.split('.').pop()?.toLowerCase();
        const kind = ext === 'json' ? 'json'
            : (ext === 'prj' || ext === 'wkt') ? 'def'
                : undefined;
        return this.addText(await file.text(), {
            code,
            fallbackCode: codeFromFilename(name),
            kind: kind,
            name: `customCRS/${name || 'uploaded.js'}`,
        });
    }
    /** Файл по URL (свой сервер, CDN) — относительные импорты резолвятся сами. */
    async addUrl(url, code) {
        const abs = new URL(url, document.baseURI).href;
        const ext = abs.split('?')[0].split('.').pop()?.toLowerCase();
        if (ext === 'js' || ext === 'mjs') {
            const mod = await import(/* @vite-ignore */ abs);
            return this.addSpec(mod?.default ?? mod, code);
        }
        const r = await fetch(abs);
        if (!r.ok)
            throw new Error(`addUrl(${url}): HTTP ${r.status}`);
        return this.addText(await r.text(), {
            code,
            kind: ext === 'json' ? 'json' : undefined,
            name: abs,
        });
    }
}
export const Projections = new ProjectionRegistry();
export const addCrs = (codeOrCodes) => Projections.addCrs(codeOrCodes);
/**
 * Является ли CRS геоцентрической (ECEF). Определяется по типу загруженной
 * проекции (+proj=geocent в def), а не по списку кодов.
 * Принимает код ('EPSG:4978') или инстанс проекции.
 * Для строкового кода вернёт false, если CRS ещё не загружена —
 * сначала await Projections.ensure(code).
 */
export function isEcefCrs(crsOrCode) {
    if (!crsOrCode)
        return false;
    const p = typeof crsOrCode === 'string'
        ? (Projections.has(crsOrCode) ? Projections.get(crsOrCode) : null)
        : crsOrCode;
    return !!(p && (p.isGeocentric === true || p._raw?.isGeocentric === true));
}
// ── Namespace для короткого API: KRB.crs.addUrl(...) ──
export const crs = {
    /** Прямой доступ к реестру, если нужен полный контроль. */
    registry: Projections,
    /** Универсальный метод: принимает код, массив, PROJ-строку, File или spec. */
    add: (input, fallbackCode) => Projections.add(input, fallbackCode),
    // Явные методы для случаев, когда нужна строгая типизация или контроль:
    addDef: (code, def) => Projections.addDef(code, def),
    addSpec: (spec, code) => Projections.addSpec(spec, code),
    addFile: (file, code) => Projections.addFile(file, code),
    addUrl: (url, code) => Projections.addUrl(url, code),
    /** Получение инстансов. */
    get: (code) => Projections.get(code),
    has: (code) => Projections.has(code),
    getRaw: (codeOrProj) => Projections.getRaw(codeOrProj),
    getWorld: (codeOrProj) => Projections.getWorld(codeOrProj),
    /** Проверка типа. */
    isEcef: (codeOrInst) => isEcefCrs(codeOrInst),
};
