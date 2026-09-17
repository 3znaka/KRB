// Projections.js
import {
proj4
} from '../js_TP/proj4.js';

const HARDCODED = {
    'EPSG:4326': '+proj=longlat +datum=WGS84 +no_defs +type=crs',
    'EPSG:3857': '+proj=merc +a=6378137 +b=6378137 +lat_ts=0 +lon_0=0 +x_0=0 +y_0=0 +k=1 +units=m +nadgrids=@null +no_defs +type=crs',
    'EPSG:3395': '+proj=merc +lon_0=0 +k=1 +x_0=0 +y_0=0 +datum=WGS84 +units=m +no_defs +type=crs',
};

export class Projection {
    constructor(code, def) {
        this.code = code;
        this.def = def;
        this.isGeographic = /\+proj=longlat/.test(def);
    }
    convertTo(other, coord) { return proj4(this.def, other.def, coord); }
    fromLonLat(coord) { return proj4(HARDCODED['EPSG:4326'], this.def, coord); }
    toLonLat(coord)   { return proj4(this.def, HARDCODED['EPSG:4326'], coord); }
}

export const WGS84 = new Projection('EPSG:4326', HARDCODED['EPSG:4326']);

class ProjectionRegistry {
    constructor() {
        this._map = new Map();
        this._defsPromise = null;
        this.register(WGS84);
        for (const [code, def] of Object.entries(HARDCODED)) {
            if (!this._map.has(code)) this.register(new Projection(code, def));
        }
    }

    register(p) { this._map.set(p.code, p); return p; }
    has(code)   { return this._map.has(code); }
    get(code)   {
        const p = this._map.get(code);
        if (!p) throw new Error(
            `CRS ${code} не загружен. Сначала вызовите await Projections.ensure('${code}')`
        );
        return p;
    }

    async ensure(code) {
        if (this._map.has(code)) return this._map.get(code);
        const defs = await this._loadDefs();
        const def = defs[code];
        if (!def) throw new Error(`CRS ${code} не найден в epsg_defs.json`);
        return this.register(new Projection(code, def));
    }

    async ensureMany(codes) { for (const c of codes) await this.ensure(c); }

    _loadDefs() {
        if (!this._defsPromise) {
            this._defsPromise = fetch(new URL('./epsg_defs.json', import.meta.url))
                .then(r => r.json());
        }
        return this._defsPromise;
    }
}

export const Projections = new ProjectionRegistry();

