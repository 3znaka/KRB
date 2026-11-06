// CoreCoordinates.ts
import { Projections } from './Projections.js';
import type { KrbMap } from './Core.js';

export interface CoreCoordinatesMethods {
    _resolveViewCenter(): void;
    project(coord: number[], fromCrs?: any): number[];
    projectSafe(coord: number[], fromCrs?: any): number[] | null;
    unproject(worldCoord: number[], toCrs?: any): number[];
    projectLonLat(lon: number, lat: number): [number, number];
    unprojectToLonLat(x: number, z: number): [number, number];
    worldToTileIndex(worldX: number, worldZ: number, z: number, crs?: any): number[];
    tileIndexToWorld(tx: number, ty: number, z: number, crs?: any): number[];
    _layerCrsOrProjection(): any;
    _wrapsLongitude(): boolean;
    getTextureUrl(layer: any, z: number, x: number, y: number): string | null;
    getElevationUrl(layer: any, z: number, x: number, y: number): string | null;
    getTileZoom(layer: any): number;
    get zoomOffset(): number;
    set zoomOffset(v: number);
    readonly maxObjectDistance: number;
    readonly tileZoom: number;
    unprojectToLonLatSafe(x: number, z: number): [number, number] | null;
}

export const CoreCoordinatesMixin: CoreCoordinatesMethods & ThisType<KrbMap> = {

unprojectToLonLatSafe(x, z) {
    const coord = [x, -z];
    const raw   = this.projection?._raw ?? this.projection;   // на случай ScaledProjection без делегата
    const out   = typeof raw?.toLonLatSafe === 'function'
        ? raw.toLonLatSafe(coord)
        : raw?.toLonLat(coord);
    if (!out || !Number.isFinite(out[0]) || !Number.isFinite(out[1])) return null;
    if (Math.abs(out[0]) > 180.0001 || Math.abs(out[1]) > 90.0001) return null;
    return [out[0], out[1]];
},


_resolveViewCenter() {
    const v = this.view;
    const mapCode = this.projection.code;      // строковый код (raw === world)

    // 1) Явно задан lon/lat — самый приоритетный путь.
    if (v.centerLonLat) {
        const [x, y] = this.projection.fromLonLat(v.centerLonLat); // world
        v.center = [x, -y];
        v.projection = mapCode;
        return;
    }

    // 2) v.center задан в v.projection (по умолчанию — mapCode).
    //    Трактуем его как RAW-координаты и переводим в world map-CRS.
    const srcCode = v.projection ?? mapCode;
    const srcRaw = typeof srcCode === 'string'
        ? Projections.getRaw(srcCode)
        : srcCode;

    const lonLat = srcRaw.toLonLat([v.center[0], -v.center[1]]);
    const [x, y] = this.projection.fromLonLat(lonLat);         // world

    v.centerLonLat = lonLat;         // фиксируем «канонический» вид
    v.center = [x, -y];
    v.projection = mapCode;

    if (srcCode !== mapCode) {
        console.warn(`KrbMap: view.center пересчитан из ${srcCode} в ${mapCode}. ` +
            `Если view.center уже был в ${mapCode}, укажите view.projection = '${mapCode}'.`);
    }
},

    project(coord, fromCrs = this.inputCRS) {
        const src = typeof fromCrs === 'string' ? Projections.get(fromCrs) : fromCrs;
        if (src === this.projection) return [coord[0], -coord[1]];
        const lonLat = src.toLonLat(coord);
        const [x, y] = this.projection.fromLonLat(lonLat);
        return [x, -y];
    },

    projectSafe(coord, fromCrs = this.inputCRS) {
        if (!coord || coord.length < 2) return null;
        if (!Number.isFinite(coord[0]) || !Number.isFinite(coord[1])) return null;
        const src = typeof fromCrs === 'string' ? Projections.get(fromCrs) : fromCrs;
        if (src === this.projection) return [coord[0], -coord[1]];
        const lonLat = typeof src.toLonLatSafe === 'function' ? src.toLonLatSafe(coord) : src.toLonLat(coord);
        if (!lonLat || !Number.isFinite(lonLat[0]) || !Number.isFinite(lonLat[1])) return null;
        const proj = typeof this.projection.fromLonLatSafe === 'function'
            ? this.projection.fromLonLatSafe(lonLat)
            : this.projection.fromLonLat(lonLat);
        if (!proj || !Number.isFinite(proj[0]) || !Number.isFinite(proj[1])) return null;
        return [proj[0], -proj[1]];
    },

    unproject(worldCoord, toCrs = this.inputCRS) {
        const dst = typeof toCrs === 'string' ? Projections.get(toCrs) : toCrs;
        const std = [worldCoord[0], -worldCoord[1]];
        if (dst === this.projection) return std;
        const lonLat = this.projection.toLonLat(std);
        return dst.fromLonLat(lonLat);
    },

    projectLonLat(lon, lat) {
        const [x, y] = this.projection.fromLonLat([lon, lat]);
        return [x, -y];
    },

    unprojectToLonLat(x, z) {
        return this.projection.toLonLat([x, -z]);
    },

worldToTileIndex(worldX, worldZ, z, crs = null) {
    const useCrs = crs
        ? (typeof crs === 'string' ? Projections.get(crs) : crs)
        : this._layerCrsOrProjection();

    const isLinear = useCrs === this.projection && this.projection.isMercator;
    const lx = worldX - this.worldGroup.position.x;
    const lz = worldZ - this.worldGroup.position.z;
    const n = 1 << z;

    if (isLinear) {
        // map-local coords → tile indices. map === tileCRS, поэтому
        // используем map-экстенты (они совпадают с tile-экстентами).
        const halfX = this.mapHalfExtentX;
        const halfY = this.mapHalfExtentY;
        const tileSizeX = (2 * halfX) / n;
        const tileSizeY = (2 * halfY) / n;
        return [(lx + halfX) / tileSizeX, (lz + halfY) / tileSizeY];
    }

    const lonLat = this.unprojectToLonLat(lx, lz);
    if (!lonLat || !Number.isFinite(lonLat[0]) || !Number.isFinite(lonLat[1])) return [NaN, NaN];
    if (Math.abs(lonLat[0]) > 180.0001 || Math.abs(lonLat[1]) > 90.0001) return [NaN, NaN];

    const tileWorld = typeof useCrs.fromLonLatSafe === 'function'
        ? useCrs.fromLonLatSafe(lonLat)
        : useCrs.fromLonLat(lonLat);
    if (!tileWorld || !Number.isFinite(tileWorld[0]) || !Number.isFinite(tileWorld[1])) return [NaN, NaN];

    const halfX = useCrs.halfExtentX;
    const halfY = useCrs.halfExtentY;
    return [
        ((tileWorld[0] + halfX) / (2 * halfX)) * n,
        ((halfY - tileWorld[1]) / (2 * halfY)) * n,
    ];
},

tileIndexToWorld(tx, ty, z, crs = null) {
    const useCrs = crs
        ? (typeof crs === 'string' ? Projections.get(crs) : crs)
        : this._layerCrsOrProjection();

    const isLinear = useCrs === this.projection && this.projection.isMercator;
    const n = 1 << z;

    if (isLinear) {
        const halfX = this.mapHalfExtentX;
        const halfY = this.mapHalfExtentY;
        const tileSizeX = (2 * halfX) / n;
        const tileSizeY = (2 * halfY) / n;
        return [
            tx * tileSizeX - halfX + this.worldGroup.position.x,
            ty * tileSizeY - halfY + this.worldGroup.position.z,
        ];
    }

    const halfX = useCrs.halfExtentX;
    const halfY = useCrs.halfExtentY;
    const tileWorldX = (tx / n) * 2 * halfX - halfX;
    const tileWorldY = halfY - (ty / n) * 2 * halfY;

    const lonLat = useCrs.toLonLat([tileWorldX, tileWorldY]);
    if (!lonLat || !Number.isFinite(lonLat[0]) || !Number.isFinite(lonLat[1])) return [NaN, NaN];

    const proj = typeof this.projection.fromLonLatSafe === 'function'
        ? this.projection.fromLonLatSafe(lonLat)
        : this.projection.fromLonLat(lonLat);
    if (!proj || !Number.isFinite(proj[0]) || !Number.isFinite(proj[1])) return [NaN, NaN];

    return [proj[0] + this.worldGroup.position.x, -proj[1] + this.worldGroup.position.z];
},

    _layerCrsOrProjection() {
        const layer = this._tileLayer;
        if (!layer) return this.projection;
        const code = layer.crs ?? layer.projection ?? 'EPSG:3857';
        return typeof code === 'string' ? Projections.get(code) : code;
    },

_wrapsLongitude() {
    const proj = this.projection;
    if (proj?.wrapsLongitude === true)       return true;
    if (proj?._raw?.wrapsLongitude === true) return true;   // ScaledProjection без делегата
    const def = proj?.def || '';
    return /\+proj=merc\b/.test(def) || /\+proj=longlat\b/.test(def);
},

    getTextureUrl(layer, z, x, y) {
        if (!layer || !layer.texture) return null;
        if (layer.texture === 'demo') {
            const n = 1 + Math.floor(Math.random() * 24);
            return new URL(`./demotiles/${n}.webp`, import.meta.url).href;
        }
        return layer.texture.replace(/\{z\}/g, z).replace(/\{x\}/g, x).replace(/\{y\}/g, y);
    },

    getElevationUrl(layer, z, x, y) {
        const elevLayer = (layer && layer.elevation) ? layer : this._elevationLayer;
        if (!elevLayer || !elevLayer.elevation) return null;
        if (elevLayer.elevation === 'demo') return null;
        return elevLayer.elevation.replace(/\{z\}/g, z).replace(/\{x\}/g, x).replace(/\{y\}/g, y);
    },

    getTileZoom(layer) {
        const z = this.currentDiscreteZoom + (layer?.zoomOffset ?? 0);
        const min = layer?.minNativeZoom ?? this.MIN_ZOOM;
        const max = layer?.maxNativeZoom ?? this.MAX_ZOOM;
        return Math.max(min, Math.min(max, z));
    },

    get zoomOffset() {
        const z = this._tileLayer?.zoomOffset;
        return (z !== undefined && z !== null) ? z : this._defaultZoomOffset;
    },
    set zoomOffset(v) {
        if (this._tileLayer) this._tileLayer.zoomOffset = v;
        else this._defaultZoomOffset = v;
        if (this._disposed) return;
        if (this._surfaceMaxHeightCache) this._surfaceMaxHeightCache.clear();
        this.lastVisibleUpdateTime = 0;
        this.maybeUpdateVisibleTiles(true);
    },

    get maxObjectDistance() {
        if (!this.objectRenderDistanceFactor) return Infinity;
        const distToTarget = this.camera.position.distanceTo(this.controls.target);
        return distToTarget * this.objectRenderDistanceFactor;
    },

    get tileZoom() {
        const layer = this._elevationLayer ?? this._tileLayer;
        if (!layer) return this.currentDiscreteZoom;
        return this.getTileZoom(layer);
    },
};

declare module './Core.js' {
    interface KrbMap extends CoreCoordinatesMethods {}
}