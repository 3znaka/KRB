import { Projections } from './Projections.js';
import type {
    GeoJSONExportable,
    GeoJSONGeometry,
    CrsLike,
} from './GeoJSONExportable.js';
import { resolveUnitScale, scaleGeometry, engineeringCrsWkt } from './UnitScale.js';

export interface GeoJSONExportOptions {
    /** Целевая СК. По умолчанию — СК карты, если экспортёр создан с ней. */
    targetCrs?: string | CrsLike;
    /** Количество знаков после запятой (по умолчанию 6). */
    precision?: number;
    /** Дополнительные свойства на уровне FeatureCollection. */
    collectionProperties?: Record<string, any>;
    /** Если true — в корень FeatureCollection добавляется `crs`. По умолчанию true. */
    writeCrsMember?: boolean;
    /** Ручной коэффициент приведения единиц. Имеет приоритет над `trueScale`. */
    unitScale?: number;
    /**
     * true — автоматически привести координаты к реальным метрам
     * (коэффициент считается по самой проекции). По умолчанию false.
     */
    trueScale?: boolean;
}

export class GeoJSONExporter {
    private _defaultTarget: CrsLike;

    constructor(defaultTarget?: CrsLike) {
        this._defaultTarget = defaultTarget ?? (Projections.get('EPSG:4326') as unknown as CrsLike);
    }

    export(objects: GeoJSONExportable[], options: GeoJSONExportOptions = {}): any {
        const targetCrs = this._resolveTarget(options.targetCrs);
        const precision = options.precision ?? 6;
               const unitScale = resolveUnitScale(targetCrs, options);
        const crsCode = (targetCrs as any)?.code as string | undefined;

        const features: any[] = [];

        for (const obj of objects) {
            const geom = obj.toGeoJSONGeometry(targetCrs);
            if (!geom) continue;
            features.push({
                type: 'Feature',
                properties: obj.getGeoJSONProperties(),
                geometry: this._roundGeometry(this._applyUnitScale(geom, unitScale), precision),
            });
        }

        const collection: any = { type: 'FeatureCollection', features };

        if (unitScale !== 1) {
            collection.unitScale = unitScale;
            if (crsCode) collection.sourceCrs = crsCode;
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

    exportString(objects: GeoJSONExportable[], options: GeoJSONExportOptions = {}): string {
        return JSON.stringify(this.export(objects, options));
    }

    private _resolveTarget(target?: string | CrsLike): CrsLike {
        if (!target) return this._defaultTarget;
        if (typeof target === 'string') return Projections.get(target) as unknown as CrsLike;
        return target;
    }


    private _applyUnitScale(geom: GeoJSONGeometry, scale: number): GeoJSONGeometry {
        return scaleGeometry(geom, scale);
    }

    private _roundGeometry(geom: GeoJSONGeometry, precision: number): GeoJSONGeometry {
        const p = Math.pow(10, precision);
        const round = (v: number) => Math.round(v * p) / p;

        const roundCoord = (
            c: [number, number] | [number, number, number],
        ): [number, number] | [number, number, number] => {
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