import { Projections } from './Projections.js';
import { resolveUnitScale, scaleGeometry, engineeringCrsWkt } from './UnitScale.js';
export class GeoJSONExporter {
    _defaultTarget;
    constructor(defaultTarget) {
        this._defaultTarget = defaultTarget ?? Projections.get('EPSG:4326');
    }
    export(objects, options = {}) {
        const targetCrs = this._resolveTarget(options.targetCrs);
        const precision = options.precision ?? 6;
        const unitScale = resolveUnitScale(targetCrs, options);
        const crsCode = targetCrs?.code;
        const features = [];
        for (const obj of objects) {
            const geom = obj.toGeoJSONGeometry(targetCrs);
            if (!geom)
                continue;
            features.push({
                type: 'Feature',
                properties: obj.getGeoJSONProperties(),
                geometry: this._roundGeometry(this._applyUnitScale(geom, unitScale), precision),
            });
        }
        const collection = { type: 'FeatureCollection', features };
        if (unitScale !== 1) {
            collection.unitScale = unitScale;
            if (crsCode)
                collection.sourceCrs = crsCode;
        }
        if (options.collectionProperties) {
            Object.assign(collection, options.collectionProperties);
        }
        if (options.writeCrsMember !== false && crsCode) {
            const isEpsg = /^EPSG:\d+$/i.test(crsCode);
            collection.crs = {
                type: 'name',
                properties: {
                    name: (unitScale !== 1 && !isEpsg)
                        ? engineeringCrsWkt(`${crsCode} (metres)`)
                        : crsCode,
                },
            };
        }
        return collection;
    }
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
    _applyUnitScale(geom, scale) {
        return scaleGeometry(geom, scale);
    }
    _roundGeometry(geom, precision) {
        const p = Math.pow(10, precision);
        const round = (v) => Math.round(v * p) / p;
        const roundCoord = (c) => {
            return c.length >= 3
                ? [round(c[0]), round(c[1]), round(c[2])]
                : [round(c[0]), round(c[1])];
        };
        switch (geom.type) {
            case 'Point':
                return { type: 'Point', coordinates: roundCoord(geom.coordinates) };
            case 'LineString':
                return { type: 'LineString', coordinates: geom.coordinates.map(roundCoord) };
            case 'Polygon':
                return { type: 'Polygon', coordinates: geom.coordinates.map(ring => ring.map(roundCoord)) };
            case 'MultiPoint':
                return { type: 'MultiPoint', coordinates: geom.coordinates.map(roundCoord) };
            default:
                return geom;
        }
    }
}
