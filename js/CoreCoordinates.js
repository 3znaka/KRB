// CoreCoordinates.ts
import { Projections } from './Projections.js';
export const CoreCoordinatesMixin = {
    _resolveViewCenter() {
        const v = this.view;
        const mapCode = this.projection.code;
        if (v.centerLonLat) {
            const [x, y] = this.projection.fromLonLat(v.centerLonLat);
            v.center = [x, -y];
            v.projection = mapCode;
            return;
        }
        const srcCode = v.projection ?? mapCode;
        if (srcCode === mapCode) {
            const [lon, lat] = this.projection.toLonLat([v.center[0], -v.center[1]]);
            v.centerLonLat = [lon, lat];
            v.projection = mapCode;
            return;
        }
        console.warn(`KrbMap: view.center пересчитан из ${srcCode} в ${mapCode}. Если view.center уже был в ${mapCode}, укажите view.projection = '${mapCode}' или передавайте координаты в centerLonLat.`);
        const src = typeof srcCode === 'string' ? Projections.get(srcCode) : srcCode;
        const lonLat = src.toLonLat([v.center[0], -v.center[1]]);
        const [x, y] = this.projection.fromLonLat(lonLat);
        v.centerLonLat = lonLat;
        v.center = [x, -y];
        v.projection = mapCode;
    },
    project(coord, fromCrs = this.inputCRS) {
        const src = typeof fromCrs === 'string' ? Projections.get(fromCrs) : fromCrs;
        if (src === this.projection)
            return [coord[0], -coord[1]];
        const lonLat = src.toLonLat(coord);
        const [x, y] = this.projection.fromLonLat(lonLat);
        return [x, -y];
    },
    projectSafe(coord, fromCrs = this.inputCRS) {
        if (!coord || coord.length < 2)
            return null;
        if (!Number.isFinite(coord[0]) || !Number.isFinite(coord[1]))
            return null;
        const src = typeof fromCrs === 'string' ? Projections.get(fromCrs) : fromCrs;
        if (src === this.projection)
            return [coord[0], -coord[1]];
        const lonLat = typeof src.toLonLatSafe === 'function' ? src.toLonLatSafe(coord) : src.toLonLat(coord);
        if (!lonLat || !Number.isFinite(lonLat[0]) || !Number.isFinite(lonLat[1]))
            return null;
        const proj = typeof this.projection.fromLonLatSafe === 'function'
            ? this.projection.fromLonLatSafe(lonLat)
            : this.projection.fromLonLat(lonLat);
        if (!proj || !Number.isFinite(proj[0]) || !Number.isFinite(proj[1]))
            return null;
        return [proj[0], -proj[1]];
    },
    unproject(worldCoord, toCrs = this.inputCRS) {
        const dst = typeof toCrs === 'string' ? Projections.get(toCrs) : toCrs;
        const std = [worldCoord[0], -worldCoord[1]];
        if (dst === this.projection)
            return std;
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
            const tileSize = this.WORLD_SIZE / n;
            return [(lx + this.MAX_MERCATOR) / tileSize, (lz + this.MAX_MERCATOR) / tileSize];
        }
        const lonLat = this.unprojectToLonLat(lx, lz);
        if (!lonLat || !Number.isFinite(lonLat[0]) || !Number.isFinite(lonLat[1]))
            return [NaN, NaN];
        if (Math.abs(lonLat[0]) > 180.0001 || Math.abs(lonLat[1]) > 90.0001)
            return [NaN, NaN];
        const tileWorld = typeof useCrs.fromLonLatSafe === 'function'
            ? useCrs.fromLonLatSafe(lonLat)
            : useCrs.fromLonLat(lonLat);
        if (!tileWorld || !Number.isFinite(tileWorld[0]) || !Number.isFinite(tileWorld[1]))
            return [NaN, NaN];
        return [
            (tileWorld[0] + this.MAX_MERCATOR) / (2 * this.MAX_MERCATOR) * n,
            (this.MAX_MERCATOR - tileWorld[1]) / (2 * this.MAX_MERCATOR) * n,
        ];
    },
    tileIndexToWorld(tx, ty, z, crs = null) {
        const useCrs = crs
            ? (typeof crs === 'string' ? Projections.get(crs) : crs)
            : this._layerCrsOrProjection();
        const isLinear = useCrs === this.projection && this.projection.isMercator;
        const n = 1 << z;
        if (isLinear) {
            const tileSize = this.WORLD_SIZE / n;
            return [
                tx * tileSize - this.MAX_MERCATOR + this.worldGroup.position.x,
                ty * tileSize - this.MAX_MERCATOR + this.worldGroup.position.z,
            ];
        }
        const tileWorldX = (tx / n) * 2 * this.MAX_MERCATOR - this.MAX_MERCATOR;
        const tileWorldY = this.MAX_MERCATOR - (ty / n) * 2 * this.MAX_MERCATOR;
        const lonLat = useCrs.toLonLat([tileWorldX, tileWorldY]);
        if (!lonLat || !Number.isFinite(lonLat[0]) || !Number.isFinite(lonLat[1]))
            return [NaN, NaN];
        const proj = typeof this.projection.fromLonLatSafe === 'function'
            ? this.projection.fromLonLatSafe(lonLat)
            : this.projection.fromLonLat(lonLat);
        if (!proj || !Number.isFinite(proj[0]) || !Number.isFinite(proj[1]))
            return [NaN, NaN];
        return [proj[0] + this.worldGroup.position.x, -proj[1] + this.worldGroup.position.z];
    },
    _layerCrsOrProjection() {
        const layer = this._tileLayer;
        if (!layer)
            return this.projection;
        const code = layer.crs ?? layer.projection ?? 'EPSG:3857';
        return typeof code === 'string' ? Projections.get(code) : code;
    },
    _wrapsLongitude() {
        const def = this.projection.def || '';
        return /\+proj=merc\b/.test(def) || /\+proj=longlat\b/.test(def);
    },
    getTextureUrl(layer, z, x, y) {
        if (!layer || !layer.texture)
            return null;
        if (layer.texture === 'demo') {
            const n = 1 + Math.floor(Math.random() * 24);
            return new URL(`./demotiles/${n}.webp`, import.meta.url).href;
        }
        return layer.texture.replace(/\{z\}/g, z).replace(/\{x\}/g, x).replace(/\{y\}/g, y);
    },
    getElevationUrl(layer, z, x, y) {
        const elevLayer = (layer && layer.elevation) ? layer : this._elevationLayer;
        if (!elevLayer || !elevLayer.elevation)
            return null;
        if (elevLayer.elevation === 'demo')
            return null;
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
        if (this._tileLayer)
            this._tileLayer.zoomOffset = v;
        else
            this._defaultZoomOffset = v;
        if (this._disposed)
            return;
        if (this._surfaceMaxHeightCache)
            this._surfaceMaxHeightCache.clear();
        this.lastVisibleUpdateTime = 0;
        this.maybeUpdateVisibleTiles(true);
    },
    get maxObjectDistance() {
        if (!this.objectRenderDistanceFactor)
            return Infinity;
        const distToTarget = this.camera.position.distanceTo(this.controls.target);
        return distToTarget * this.objectRenderDistanceFactor;
    },
    get tileZoom() {
        const layer = this._elevationLayer ?? this._tileLayer;
        if (!layer)
            return this.currentDiscreteZoom;
        return this.getTileZoom(layer);
    },
};
