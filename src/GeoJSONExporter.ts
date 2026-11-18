import { Projections } from './Projections.js';
import type {
    GeoJSONExportable,
    GeoJSONGeometry,
    CrsLike,
} from './GeoJSONExportable.js';


export interface GeoJSONExportOptions {
    /** Целевая СК. По умолчанию — СК карты, если экспортёр создан с ней. */
    targetCrs?: string | CrsLike;
    /** Количество знаков после запятой (по умолчанию 6). */
    precision?: number;
    /** Дополнительные свойства на уровне FeatureCollection. */
    collectionProperties?: Record<string, any>;
    /**
     * Если true — в корень FeatureCollection добавляется `crs`
     * с кодом целевой СК (для QGIS). По умолчанию true.
     */
    writeCrsMember?: boolean;
}


export class GeoJSONExporter {
    private _defaultTarget: CrsLike;

    constructor(defaultTarget?: CrsLike) {
        this._defaultTarget = defaultTarget ?? (Projections.get('EPSG:4326') as unknown as CrsLike);
    }


    /**
     * Экспортирует массив объектов в FeatureCollection.
     */
    export(
        objects: GeoJSONExportable[],
        options: GeoJSONExportOptions = {},
    ): any {
        const targetCrs = this._resolveTarget(options.targetCrs);
        const precision = options.precision ?? 6;

        const features: any[] = [];
        for (const obj of objects) {
            const geom = obj.toGeoJSONGeometry(targetCrs);
            if (!geom) continue;

            const props = obj.getGeoJSONProperties();
            features.push({
                type: 'Feature',
                properties: props,
                geometry: this._roundGeometry(geom, precision),
            });
        }

        const collection: any = {
            type: 'FeatureCollection',
            features,
        };

        if (options.collectionProperties) {
            Object.assign(collection, options.collectionProperties);
        }

const crsCode = (targetCrs as any)?.code as string | undefined;
if (options.writeCrsMember !== false && crsCode) {
    collection.crs = {
        type: 'name',
        properties: { name: crsCode },
    };
}

        return collection;
    }

    /** Возвращает строку JSON. */
    exportString(
        objects: GeoJSONExportable[],
        options: GeoJSONExportOptions = {},
    ): string {
        return JSON.stringify(this.export(objects, options));
    }

private _resolveTarget(target?: string | CrsLike): CrsLike {
    if (!target) return this._defaultTarget;
    if (typeof target === 'string') return Projections.get(target) as unknown as CrsLike;
    return target;
}


    private _roundGeometry(geom: GeoJSONGeometry, precision: number): GeoJSONGeometry {
        const p = Math.pow(10, precision);
        const round = (v: number) => Math.round(v * p) / p;

        switch (geom.type) {
            case 'Point':
                return { type: 'Point', coordinates: [round(geom.coordinates[0]), round(geom.coordinates[1])] };
            case 'LineString':
                return { type: 'LineString', coordinates: geom.coordinates.map(([x, y]) => [round(x), round(y)]) };
            case 'Polygon':
                return {
                    type: 'Polygon',
                    coordinates: geom.coordinates.map(ring =>
                        ring.map(([x, y]) => [round(x), round(y)])
                    ),
                };
            case 'MultiPoint':
                return { type: 'MultiPoint', coordinates: geom.coordinates.map(([x, y]) => [round(x), round(y)]) };
            default:
                return geom;
        }
    }
}