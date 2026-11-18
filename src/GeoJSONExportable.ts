export interface CrsLike {
    code?: string;
    fromLonLat(ll: [number, number]): [number, number] | null;
    toLonLat(xy: [number, number]): [number, number] | null;
}

export type GeoJSONGeometry =
    | { type: 'Point'; coordinates: [number, number] | [number, number, number] }
    | { type: 'LineString'; coordinates: Array<[number, number] | [number, number, number]> }
    | { type: 'Polygon'; coordinates: Array<Array<[number, number] | [number, number, number]>> }
    | { type: 'MultiPoint'; coordinates: Array<[number, number] | [number, number, number]> }
    ;

export interface GeoJSONExportable {
    /**
     * Возвращает геометрию в координатах целевой проекции `targetCrs`.
     * `null` — объект не представим в этой проекции.
     */
    toGeoJSONGeometry(targetCrs: CrsLike): GeoJSONGeometry | null;

    /** Свойства, которые попадут в Feature.properties. */
    getGeoJSONProperties(): Record<string, any>;
}