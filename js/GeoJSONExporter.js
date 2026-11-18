import { Projections } from './Projections.js';
export class GeoJSONExporter {
    _defaultTarget;
    constructor(defaultTarget) {
        this._defaultTarget = defaultTarget ?? Projections.get('EPSG:4326');
    }
    /**
     * Экспортирует массив объектов в FeatureCollection.
     */
    export(objects, options = {}) {
        const targetCrs = this._resolveTarget(options.targetCrs);
        const precision = options.precision ?? 6;
        const features = [];
        for (const obj of objects) {
            const geom = obj.toGeoJSONGeometry(targetCrs);
            if (!geom)
                continue;
            const props = obj.getGeoJSONProperties();
            features.push({
                type: 'Feature',
                properties: props,
                geometry: this._roundGeometry(geom, precision),
            });
        }
        const collection = {
            type: 'FeatureCollection',
            features,
        };
        if (options.collectionProperties) {
            Object.assign(collection, options.collectionProperties);
        }
        const crsCode = targetCrs?.code;
        if (options.writeCrsMember !== false && crsCode) {
            collection.crs = {
                type: 'name',
                properties: { name: crsCode },
            };
        }
        return collection;
    }
    /** Возвращает строку JSON. */
    exportString(objects, options = {}) {
        return JSON.stringify(this.export(objects, options));
    }
    _resolveTarget(target) {
        if (!target)
            return this._defaultTarget;
        if (typeof target === 'string')
            return Projections.get(target);
        return target;
    }
    _roundGeometry(geom, precision) {
        const p = Math.pow(10, precision);
        const round = (v) => Math.round(v * p) / p;
        switch (geom.type) {
            case 'Point':
                return { type: 'Point', coordinates: [round(geom.coordinates[0]), round(geom.coordinates[1])] };
            case 'LineString':
                return { type: 'LineString', coordinates: geom.coordinates.map(([x, y]) => [round(x), round(y)]) };
            case 'Polygon':
                return {
                    type: 'Polygon',
                    coordinates: geom.coordinates.map(ring => ring.map(([x, y]) => [round(x), round(y)])),
                };
            case 'MultiPoint':
                return { type: 'MultiPoint', coordinates: geom.coordinates.map(([x, y]) => [round(x), round(y)]) };
            default:
                return geom;
        }
    }
}
