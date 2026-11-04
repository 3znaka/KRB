/**
 * Geojson.ts — слой GeoJSON (Point, LineString, MultiLineString, Polygon,
 * MultiPolygon) с поддержкой 3D-вариантов и векторных линий.
 *
 * Координаты по умолчанию интерпретируются как WGS84 (EPSG:4326);
 * при необходимости задайте `options.crs` или переопределите CRS
 * точечно в коллбэках.
 *
 * Ключевые принципы:
 *   - коллбэки `*ToOptions` вызываются РОВНО ОДИН РАЗ на feature/geometry;
 *   - результат коллбэка мержится с дефолтами через spread — пользователь
 *     может передать любое поле соответствующего `*Options`;
 *   - `[lon, lat, alt]` для Point нормализуется до `[lon, lat]` + `altitude`;
 *   - дефолты `altitudeMode` для линий/полигонов — `'absolute'`, а не `'ground'`
 *     (последнее для `Polyline`/`Polygon` невалидно).
 *
 * @module Geojson
 */

import { Layer } from './Layers.js';
import {
    Marker,
    type MarkerOptions,
    type LonLat,
    type IconSize,
} from './Marker.js';
import {
    Marker3D,
    type Marker3DOptions,
    type Vec3,
    type SizeSpec,
    type PrimitiveType,
} from './Marker3D.js';
import {
    Area3D,
    type Area3DOptions,
    type Area3DRing,
    type Area3DFit,
} from './Area3D.js';
import {
    Polyline,
    type PolylineOptions,
} from './Polyline.js';
import {
    Polygon,
    type PolygonOptions,
} from './Polygon.js';
import {
    Vector3D,
    type Vector3DOptions,
    type Vector3DPosition,
} from './Vector3D.js';
import type { SpatialObject } from './SpatialObject.js';

// =====================================================================
// GeoJSON types
// =====================================================================

export type GeoJSONCoord = [number, number] | [number, number, number];
export type GeoJSONLineString = GeoJSONCoord[];
export type GeoJSONPolygon = GeoJSONCoord[][];

interface GeoJSONPointGeometry { type: 'Point'; coordinates: GeoJSONCoord; }
interface GeoJSONLineStringGeometry { type: 'LineString'; coordinates: GeoJSONLineString; }
interface GeoJSONMultiLineStringGeometry { type: 'MultiLineString'; coordinates: GeoJSONLineString[]; }
interface GeoJSONPolygonGeometry { type: 'Polygon'; coordinates: GeoJSONPolygon; }
interface GeoJSONMultiPolygonGeometry { type: 'MultiPolygon'; coordinates: GeoJSONPolygon[]; }

export type GeoJSONGeometry =
    | GeoJSONPointGeometry
    | GeoJSONLineStringGeometry
    | GeoJSONMultiLineStringGeometry
    | GeoJSONPolygonGeometry
    | GeoJSONMultiPolygonGeometry;

export type GeoJSONProperties = Record<string, any>;

export interface GeoJSONFeature {
    type: 'Feature';
    geometry: GeoJSONGeometry;
    properties?: GeoJSONProperties | null;
    id?: string | number;
}

export interface GeoJSONFeatureCollection {
    type: 'FeatureCollection';
    features: GeoJSONFeature[];
}

export type GeoJSONInput =
    | GeoJSONFeatureCollection
    | GeoJSONFeature
    | GeoJSONGeometry;

// =====================================================================
// Callback types
// =====================================================================

type Props = GeoJSONProperties;

export type PointOptionsCallback =
    (feature: GeoJSONFeature, props: Props) => Partial<MarkerOptions> | null | undefined;
export type Point3DOptionsCallback =
    (feature: GeoJSONFeature, props: Props) => Partial<Marker3DOptions> | null | undefined;
export type LineOptionsCallback =
    (feature: GeoJSONFeature, props: Props) => Partial<PolylineOptions> | null | undefined;
export type PolygonOptionsCallback =
    (feature: GeoJSONFeature, props: Props) => Partial<PolygonOptions> | null | undefined;
export type Polygon3DOptionsCallback =
    (feature: GeoJSONFeature, props: Props) => Partial<Area3DOptions> | null | undefined;
export type VectorOptionsCallback =
    (feature: GeoJSONFeature, props: Props) => Partial<Vector3DOptions> | null | undefined;

export type OnEachFeatureCallback =
    (feature: GeoJSONFeature, object: SpatialObject) => void;

// =====================================================================
// Layer options
// =====================================================================

export interface GeoJSONLayerOptions {
    url?: string;
    data?: GeoJSONInput;
    crs?: string;
    /**
     * Предикат на уровне GeoJSON-feature: `false` — feature не создаётся
     * вообще (не попадает в `_objects`, не влияет на `getBounds`).
     *
     * НЕ путать с унаследованным `Layer.filter(predicate)` — тот работает
     * по уже созданным объектам слоя (`SpatialObject`) и лишь скрывает их.
     */
    featureFilter?: (feature: GeoJSONFeature) => boolean;

    /** @deprecated Используйте `featureFilter`. */
    filter?: (feature: GeoJSONFeature) => boolean;
    onEachFeature?: OnEachFeatureCallback;

    pointToOptions?: PointOptionsCallback;
    point3DToOptions?: Point3DOptionsCallback;
    lineToOptions?: LineOptionsCallback;
    polygonToOptions?: PolygonOptionsCallback;
    polygon3DToOptions?: Polygon3DOptionsCallback;
    vectorToOptions?: VectorOptionsCallback;

    // ── Marker ──
    defaultIconUrl?: string;
    defaultIconSize?: IconSize;
    defaultAnchor?: [number, number];

    // ── Marker3D ──
    default3DPrimitiveType?: PrimitiveType;
    default3DSize?: SizeSpec | null;
    default3DAnchor?: Vec3;
    default3DAltitude?: number;
    default3DAltitudeMode?: 'clampToGround' | 'absolute';

    // ── Polyline ──
    defaultLineColor?: string | number;
    defaultLineWidth?: number;
    defaultLineOpacity?: number;
    /** @default 'absolute' */
    defaultLineAltitudeMode?: 'clampToGround' | 'absolute';
    /** @default 10 */
    defaultLineAltitude?: number;
    /** @deprecated Используйте `defaultLineAltitude`. */
    defaultLineAltitudeOffset?: number;
    defaultLineDepthTest?: boolean;
    defaultLineDepthWrite?: boolean;
    defaultLineMinZoom?: number;
    defaultLineMaxZoom?: number;

    // ── Polygon ──
    defaultFillColor?: string | number;
    defaultFillOpacity?: number;
    defaultStrokeColor?: string | number;
    defaultStrokeWidth?: number;
    defaultStrokeOpacity?: number;
    /** @default 'absolute' */
    defaultPolygonAltitudeMode?: 'clampToGround' | 'absolute';
    /** @default 10 */
    defaultPolygonAltitude?: number;
    /** @deprecated Используйте `defaultPolygonAltitude`. */
    defaultPolygonAltitudeOffset?: number;
    defaultPolygonDepthTest?: boolean;
    defaultPolygonDepthWrite?: boolean;
    defaultPolygonMinZoom?: number;
    defaultPolygonMaxZoom?: number;
    defaultPolygonExtruded?: boolean;
    defaultPolygonHeight?: number;
    defaultPolygonMinHeight?: number;

    // ── Area3D ──
    defaultPolygon3DPrimitiveType?: PrimitiveType;
    defaultPolygon3DSize?: SizeSpec | null;
    defaultPolygon3DAnchor?: [number, number, number];
    defaultPolygon3DAltitude?: number;
    defaultPolygon3DAltitudeMode?: 'clampToGround' | 'absolute';
    defaultPolygon3DFit?: Area3DFit;
    defaultPolygon3DRotate?: number;
    defaultPolygon3DModelUrl?: string | null;
    defaultPolygon3DDepthTest?: boolean;
    defaultPolygon3DDepthWrite?: boolean;
}

// =====================================================================
// GeoJSONLayer
// =====================================================================

/**
 * Слой, создающий маркеры, линии, полигоны и векторные объекты из GeoJSON.
 *
 * @example
 * const layer = new GeoJSONLayer({
 *     url: 'data.geojson',
 *     crs: 'EPSG:4326',
 *     pointToOptions: (f, p) => ({ title: p.name, rotation: p.rot }),
 *     polygonToOptions: (f, p) => ({ fillColor: p.fill }),
 *     onEachFeature: (f, obj) => console.log(f, obj),
 * });
 * layer.addTo(map);
 * layer.reload();
 */
export class GeoJSONLayer extends Layer {
    // ── Данные ──
    public url: string | null = null;
    public data: GeoJSONInput | null = null;
    public crs: string | null = null;
    /**
     * Предикат на уровне GeoJSON-feature. `false` — feature не создаётся.
     *
     * Это НЕ то же самое, что унаследованный {@link Layer#filter}:
     *   - `featureFilter` — применяется при парсинге, feature вообще
     *     не попадает в слой (влияет на `_objects.length` и `getBounds`);
     *   - `filter()` — применяется к уже созданным объектам и лишь
     *     скрывает их через `SpatialObject.setVisible()`, объекты
     *     остаются в `_objects`.
     */
    public featureFilter: ((feature: GeoJSONFeature) => boolean) | null = null;
    public onEachFeature: OnEachFeatureCallback | null = null;

    // ── Коллбэки ──
    public pointToOptions: PointOptionsCallback | null = null;
    public point3DToOptions: Point3DOptionsCallback | null = null;
    public lineToOptions: LineOptionsCallback | null = null;
    public polygonToOptions: PolygonOptionsCallback | null = null;
    public polygon3DToOptions: Polygon3DOptionsCallback | null = null;
    public vectorToOptions: VectorOptionsCallback | null = null;

    // ── Дефолты: Marker ──
    public defaultIconUrl: string = 'marker.png';
    public defaultIconSize: IconSize = [16, 16];
    public defaultAnchor: [number, number] = [0.5, 1.0];

    // ── Дефолты: Marker3D ──
    public default3DPrimitiveType: PrimitiveType = 'box';
    public default3DSize: SizeSpec | null = [100, 100, 100];
    public default3DAnchor: Vec3 = [0.5, 0, 0.5];
    public default3DAltitude: number = 0;
    public default3DAltitudeMode: 'clampToGround' | 'absolute' = 'clampToGround';

    // ── Дефолты: Polyline ──
    public defaultLineColor: string | number = '#3388ff';
    public defaultLineWidth: number = 2;
    public defaultLineOpacity: number = 1;
    public defaultLineAltitudeMode: 'clampToGround' | 'absolute' = 'absolute';
    public defaultLineAltitude: number = 10;
    public defaultLineDepthTest: boolean = false;
    public defaultLineDepthWrite: boolean = false;
    public defaultLineMinZoom: number = -Infinity;
    public defaultLineMaxZoom: number = Infinity;

    // ── Дефолты: Polygon ──
    public defaultFillColor: string | number = '#3388ff';
    public defaultFillOpacity: number = 0.5;
    public defaultStrokeColor: string | number = '#000000';
    public defaultStrokeWidth: number = 2;
    public defaultStrokeOpacity: number = 1;
    public defaultPolygonAltitudeMode: 'clampToGround' | 'absolute' = 'absolute';
    public defaultPolygonAltitude: number = 10;
    public defaultPolygonDepthTest: boolean = false;
    public defaultPolygonDepthWrite: boolean = false;
    public defaultPolygonMinZoom: number = -Infinity;
    public defaultPolygonMaxZoom: number = Infinity;
    public defaultPolygonExtruded: boolean = false;
    public defaultPolygonHeight: number = 0;
    public defaultPolygonMinHeight: number = 0;

    // ── Дефолты: Area3D ──
    public defaultPolygon3DPrimitiveType: PrimitiveType = 'box';
    public defaultPolygon3DSize: SizeSpec | null = null;
    public defaultPolygon3DAnchor: [number, number, number] = [0.5, 0, 0.5];
    public defaultPolygon3DAltitude: number = 0;
    public defaultPolygon3DAltitudeMode: 'clampToGround' | 'absolute' = 'clampToGround';
    public defaultPolygon3DFit: Area3DFit = 'stretch';
    public defaultPolygon3DRotate: number = 0;
    public defaultPolygon3DModelUrl: string | null = null;
    public defaultPolygon3DDepthTest: boolean = true;
    public defaultPolygon3DDepthWrite: boolean = true;

    private _loaded = false;

    constructor(options: GeoJSONLayerOptions = {}) {
        super();

        this.url = options.url ?? null;
        this.data = options.data ?? null;
        this.crs = options.crs ?? null;
this.featureFilter = options.featureFilter ?? options.filter ?? null;
        this.onEachFeature = options.onEachFeature ?? null;

        this.pointToOptions = options.pointToOptions ?? null;
        this.point3DToOptions = options.point3DToOptions ?? null;
        this.lineToOptions = options.lineToOptions ?? null;
        this.polygonToOptions = options.polygonToOptions ?? null;
        this.polygon3DToOptions = options.polygon3DToOptions ?? null;
        this.vectorToOptions = options.vectorToOptions ?? null;

        this.defaultIconUrl = options.defaultIconUrl ?? 'marker.png';
        this.defaultIconSize = options.defaultIconSize ?? [16, 16];
        this.defaultAnchor = options.defaultAnchor ?? [0.5, 1.0];

        this.default3DPrimitiveType = options.default3DPrimitiveType ?? 'box';
        this.default3DSize = options.default3DSize ?? [100, 100, 100];
        this.default3DAnchor = options.default3DAnchor ?? [0.5, 0, 0.5];
        this.default3DAltitude = options.default3DAltitude ?? 0;
        this.default3DAltitudeMode = options.default3DAltitudeMode ?? 'clampToGround';

        this.defaultLineColor = options.defaultLineColor ?? '#3388ff';
        this.defaultLineWidth = options.defaultLineWidth ?? 2;
        this.defaultLineOpacity = options.defaultLineOpacity ?? 1;
        this.defaultLineAltitudeMode = options.defaultLineAltitudeMode ?? 'absolute';
        this.defaultLineAltitude = options.defaultLineAltitude
            ?? options.defaultLineAltitudeOffset
            ?? 10;
        this.defaultLineDepthTest = options.defaultLineDepthTest ?? false;
        this.defaultLineDepthWrite = options.defaultLineDepthWrite ?? false;
        this.defaultLineMinZoom = options.defaultLineMinZoom ?? -Infinity;
        this.defaultLineMaxZoom = options.defaultLineMaxZoom ?? Infinity;

        this.defaultFillColor = options.defaultFillColor ?? '#3388ff';
        this.defaultFillOpacity = options.defaultFillOpacity ?? 0.5;
        this.defaultStrokeColor = options.defaultStrokeColor ?? '#000000';
        this.defaultStrokeWidth = options.defaultStrokeWidth ?? 2;
        this.defaultStrokeOpacity = options.defaultStrokeOpacity ?? 1;
        this.defaultPolygonAltitudeMode = options.defaultPolygonAltitudeMode ?? 'absolute';
        this.defaultPolygonAltitude = options.defaultPolygonAltitude
            ?? options.defaultPolygonAltitudeOffset
            ?? 10;
        this.defaultPolygonDepthTest = options.defaultPolygonDepthTest ?? false;
        this.defaultPolygonDepthWrite = options.defaultPolygonDepthWrite ?? false;
        this.defaultPolygonMinZoom = options.defaultPolygonMinZoom ?? -Infinity;
        this.defaultPolygonMaxZoom = options.defaultPolygonMaxZoom ?? Infinity;
        this.defaultPolygonExtruded = options.defaultPolygonExtruded ?? false;
        this.defaultPolygonHeight = options.defaultPolygonHeight ?? 0;
        this.defaultPolygonMinHeight = options.defaultPolygonMinHeight ?? 0;

        this.defaultPolygon3DPrimitiveType = options.defaultPolygon3DPrimitiveType ?? 'box';
        this.defaultPolygon3DSize = options.defaultPolygon3DSize ?? null;
        this.defaultPolygon3DAnchor = options.defaultPolygon3DAnchor ?? [0.5, 0, 0.5];
        this.defaultPolygon3DAltitude = options.defaultPolygon3DAltitude ?? 0;
        this.defaultPolygon3DAltitudeMode = options.defaultPolygon3DAltitudeMode ?? 'clampToGround';
        this.defaultPolygon3DFit = options.defaultPolygon3DFit ?? 'stretch';
        this.defaultPolygon3DRotate = options.defaultPolygon3DRotate ?? 0;
        this.defaultPolygon3DModelUrl = options.defaultPolygon3DModelUrl ?? null;
        this.defaultPolygon3DDepthTest = options.defaultPolygon3DDepthTest ?? true;
        this.defaultPolygon3DDepthWrite = options.defaultPolygon3DDepthWrite ?? true;
    }

    // =================================================================
    // Lifecycle
    // =================================================================

    override addTo(map: any): this {
        super.addTo(map);
        if (!this._loaded) this._load();
        return this;
    }

    /** Полная перезагрузка: удаляет объекты, сбрасывает флаг, загружает заново. */
    reload(): void {
        const layer = this as any;
        const objects: SpatialObject[] = layer._objects ?? [];
        for (const obj of [...objects]) obj.remove();
        layer._objects = [];
        this._loaded = false;
        if (layer._map) this._load();
    }

    /**
 * Меняет feature-фильтр. При активной карте и загруженных данных
 * автоматически вызывает `reload()`, чтобы применить фильтр к уже
 * загруженным feature.
 *
 * @example
 * layer.setFeatureFilter(f => f.properties?.type === 'city');
 * layer.setFeatureFilter(null);   // снять фильтр
 */
setFeatureFilter(predicate: ((feature: GeoJSONFeature) => boolean) | null): this {
    this.featureFilter = predicate;
    if (this._map && this._loaded) this.reload();
    return this;
}

    private async _load(): Promise<void> {
        let geojson: GeoJSONInput | null = null;
        try {
            if (this.data) {
                geojson = this.data;
            } else if (this.url) {
                const resp = await fetch(this.url);
                if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
                geojson = await resp.json() as GeoJSONInput;
            }
            if (!geojson) {
                console.warn('GeoJSONLayer: no data or URL provided');
                return;
            }
            this._parse(geojson);
            this._loaded = true;
        } catch (err) {
            console.error('GeoJSONLayer: load/parse error', err);
        }
    }

    // =================================================================
    // Dispatch
    // =================================================================

    private _parse(geojson: GeoJSONInput): void {
        const type = (geojson as { type: string }).type;
        if (type === 'FeatureCollection') {
            for (const feature of (geojson as GeoJSONFeatureCollection).features) {
                this._addFeature(feature);
            }
        } else if (type === 'Feature') {
            this._addFeature(geojson as GeoJSONFeature);
        } else if (
            type === 'Point' || type === 'LineString' || type === 'MultiLineString'
            || type === 'Polygon' || type === 'MultiPolygon'
        ) {
            this._addFeature({
                type: 'Feature',
                geometry: geojson as GeoJSONGeometry,
                properties: {},
            });
        } else {
            console.debug(`GeoJSONLayer: type "${type}" not supported`);
        }
    }

    private _addFeature(feature: GeoJSONFeature): void {
 const props = feature.properties ?? {};
    if (this.featureFilter && !this.featureFilter(feature)) return;

        const geom = feature.geometry;
        if (!geom) return;

        switch (geom.type) {
            case 'Point':
                // Для точки нужен явный флаг vector === true — иначе Marker/Marker3D.
                if (this.vectorToOptions && props.vector === true) {
                    this._addVectorFeature(feature);
                } else {
                    this._addPointFeature(feature);
                }
                break;

            case 'LineString':
            case 'MultiLineString':
                // Наличие vectorToOptions — сигнал, что автор слоя хочет вектор.
                if (this.vectorToOptions || props.vector === true) {
                    this._addVectorFeature(feature);
                } else {
                    this._addLineFeature(feature);
                }
                break;

            case 'Polygon':
            case 'MultiPolygon':
                this._addPolygonFeature(feature);
                break;

            default:
                console.debug(`GeoJSONLayer: type "${(geom as any).type}" not supported`);
        }
    }

    // =================================================================
    // Points
    // =================================================================

    private _addPointFeature(feature: GeoJSONFeature): void {
        const geom = feature.geometry;
        if (geom.type !== 'Point') return;
        const props = feature.properties ?? {};

        const coords = geom.coordinates;
        const lonLat: LonLat = [coords[0], coords[1]];
        const altFromCoords = coords.length >= 3 ? coords[2] : undefined;

        // Коллбэк 3D вызываем РОВНО ОДИН РАЗ.
        const cb3D = this.point3DToOptions ? this.point3DToOptions(feature, props) : null;
        const is3D = cb3D != null
            || props['3d'] === true
            || props.type === '3d'
            || props.markerType === '3d';

        if (is3D) {
            this._createMarker3D(feature, props, lonLat, altFromCoords, cb3D);
        } else {
            const cb = this.pointToOptions ? this.pointToOptions(feature, props) : null;
            this._createMarker(feature, props, lonLat, altFromCoords, cb);
        }
    }

    private _createMarker(
        feature: GeoJSONFeature,
        props: Props,
        lonLat: LonLat,
        altFromCoords: number | undefined,
        cb: Partial<MarkerOptions> | null | undefined,
    ): void {
        const defaults: MarkerOptions = {
            position: lonLat,
            crs: this.crs ?? undefined,
            title: props.title || props.name || '',
            tooltip: props.tooltip || props.description || '',
            iconUrl: props.icon || this.defaultIconUrl,
            iconSize: this._parseIconSize(props.iconSize) ?? this.defaultIconSize,
            anchor: this._parsePair(props.anchor) ?? this.defaultAnchor,
            altitude: this._asNumber(props.altitude) ?? altFromCoords ?? 0,
            altitudeMode: props.altitudeMode || 'ground',
            clusterable: props.clusterable ?? true,
            minZoom: this._asNumber(props.minZoom),
            maxZoom: this._asNumber(props.maxZoom),
            titleAlign: props.titleAlign,
            titleStyle: props.titleStyle,
            titleMinZoom: this._asNumber(props.titleMinZoom),
            titleMaxZoom: this._asNumber(props.titleMaxZoom),
            titleOffset: this._parsePair(props.titleOffset) ?? undefined,
            titleAllowOverflow: props.titleAllowOverflow,
            titlePriority: this._asNumber(props.titlePriority),
        };

        const merged: MarkerOptions = { ...defaults, ...(cb ?? {}), position: lonLat };
        const marker = new Marker(merged);
        this.add(marker);
        if (this.onEachFeature) this.onEachFeature(feature, marker);
    }

    private _createMarker3D(
        feature: GeoJSONFeature,
        props: Props,
        lonLat: LonLat,
        altFromCoords: number | undefined,
        cb: Partial<Marker3DOptions> | null | undefined,
    ): void {
        const defaults: Marker3DOptions = {
            position: lonLat,
            crs: this.crs ?? undefined,
            title: props.title || props.name || '',
            tooltip: props.tooltip || props.description || '',
            primitiveType: props.primitiveType || this.default3DPrimitiveType,
            size: this._parseSizeSpec(props.size) ?? this.default3DSize,
            anchor: this._parseTriple(props.anchor) ?? this.default3DAnchor,
            altitude: this._asNumber(props.altitude) ?? altFromCoords ?? this.default3DAltitude,
            altitudeMode: props.altitudeMode || this.default3DAltitudeMode,
            rotation: this._parseTriple(props.rotation) ?? [0, 0, 0],
            modelUrl: props.modelUrl,
            minZoom: this._asNumber(props.minZoom),
            maxZoom: this._asNumber(props.maxZoom),
            titlePlacement: props.titlePlacement || 'top',
            titleAlign: props.titleAlign,
            titleOffset: this._parsePair(props.titleOffset) ?? undefined,
            titleStyle: props.titleStyle,
            titleMinZoom: this._asNumber(props.titleMinZoom),
            titleMaxZoom: this._asNumber(props.titleMaxZoom),
            color: props.color,
            clusterable: props.clusterable,
            depthTest: props.depthTest,
            depthWrite: props.depthWrite,
            playAnimation: props.playAnimation,
        };

        const merged: Marker3DOptions = { ...defaults, ...(cb ?? {}), position: lonLat };
        const marker = new Marker3D(merged);
        this.add(marker);
        if (this.onEachFeature) this.onEachFeature(feature, marker);
    }

    // =================================================================
    // Lines
    // =================================================================

    private _addLineFeature(feature: GeoJSONFeature): void {
        const geom = feature.geometry;
        if (geom.type !== 'LineString' && geom.type !== 'MultiLineString') return;
        const props = feature.properties ?? {};

        const coordSets: GeoJSONLineString[] =
            geom.type === 'LineString' ? [geom.coordinates] : geom.coordinates;

        for (const coords of coordSets) {
            if (coords.length < 2) continue;

            const cb = this.lineToOptions ? this.lineToOptions(feature, props) : null;

            const defaults: PolylineOptions = {
                positions: coords,
                crs: this.crs ?? undefined,
                color: props.stroke || props.color || this.defaultLineColor,
                opacity: this._asNumber(props['stroke-opacity'] ?? props.opacity)
                    ?? this.defaultLineOpacity,
                width: this._asNumber(props['stroke-width'] ?? props.width)
                    ?? this.defaultLineWidth,
                altitudeMode: props.altitudeMode || this.defaultLineAltitudeMode,
                altitude: this._asNumber(props.altitude)
                    ?? this._asNumber(props.altitudeOffset)
                    ?? this.defaultLineAltitude,
                depthTest: props.depthTest ?? this.defaultLineDepthTest,
                depthWrite: props.depthWrite ?? this.defaultLineDepthWrite,
                minZoom: this._asNumber(props.minZoom) ?? this.defaultLineMinZoom,
                maxZoom: this._asNumber(props.maxZoom) ?? this.defaultLineMaxZoom,
                title: props.title || props.name || '',
                tooltip: props.tooltip || props.description || '',
                titleOffset: this._parsePair(props.titleOffset) ?? undefined,
                titleAlign: props.titleAlign,
                titleStyle: props.titleStyle,
                titleMinZoom: this._asNumber(props.titleMinZoom),
                titleMaxZoom: this._asNumber(props.titleMaxZoom),
                titlePlacement: props.titlePlacement,
                titleAllowOverflow: props.titleAllowOverflow,
                titlePriority: this._asNumber(props.titlePriority),
            };

            const merged: PolylineOptions = { ...defaults, ...(cb ?? {}), positions: coords };
            const polyline = new Polyline(merged);
            this.add(polyline);
            if (this.onEachFeature) this.onEachFeature(feature, polyline);
        }
    }

    // =================================================================
    // Polygons
    // =================================================================

    private _addPolygonFeature(feature: GeoJSONFeature): void {
        const geom = feature.geometry;
        if (geom.type !== 'Polygon' && geom.type !== 'MultiPolygon') return;
        const props = feature.properties ?? {};

        const ringSets: GeoJSONPolygon[] =
            geom.type === 'Polygon' ? [geom.coordinates] : geom.coordinates;

        for (const rings of ringSets) {
            if (!rings.length || !rings[0].length) continue;

            // Коллбэк 3D вызываем РОВНО ОДИН РАЗ.
            const cb3D = this.polygon3DToOptions ? this.polygon3DToOptions(feature, props) : null;
            const is3D = cb3D != null
                || props['3d'] === true
                || props.type === '3d'
                || props.markerType === '3d';

            if (is3D) {
                this._createArea3D(feature, props, rings as Area3DRing[], cb3D);
            } else {
                const cb = this.polygonToOptions ? this.polygonToOptions(feature, props) : null;
                this._createPolygon(feature, props, rings, cb);
            }
        }
    }

    private _createPolygon(
        feature: GeoJSONFeature,
        props: Props,
        rings: GeoJSONPolygon,
        cb: Partial<PolygonOptions> | null | undefined,
    ): void {
        const defaults: PolygonOptions = {
            rings,
            crs: this.crs ?? undefined,
            fillColor: props.fill || props['fill-color'] || this.defaultFillColor,
            fillOpacity: this._asNumber(props['fill-opacity']) ?? this.defaultFillOpacity,
            strokeColor: props.stroke || props['stroke-color'] || this.defaultStrokeColor,
            strokeWidth: this._asNumber(props['stroke-width']) ?? this.defaultStrokeWidth,
            strokeOpacity: this._asNumber(props['stroke-opacity']) ?? this.defaultStrokeOpacity,
            altitudeMode: props.altitudeMode || this.defaultPolygonAltitudeMode,
            altitude: this._asNumber(props.altitude)
                ?? this._asNumber(props.altitudeOffset)
                ?? this.defaultPolygonAltitude,
            depthTest: props.depthTest ?? this.defaultPolygonDepthTest,
            depthWrite: props.depthWrite ?? this.defaultPolygonDepthWrite,
            minZoom: this._asNumber(props.minZoom) ?? this.defaultPolygonMinZoom,
            maxZoom: this._asNumber(props.maxZoom) ?? this.defaultPolygonMaxZoom,
            extruded: props.extruded ?? this.defaultPolygonExtruded,
            height: this._asNumber(props.height) ?? this.defaultPolygonHeight,
            minHeight: this._asNumber(props.minHeight) ?? this.defaultPolygonMinHeight,
            title: props.title || props.name || '',
            titleOffset: this._parsePair(props.titleOffset) ?? undefined,
            titleAlign: props.titleAlign,
            titleStyle: props.titleStyle,
            titleMinZoom: this._asNumber(props.titleMinZoom),
            titleMaxZoom: this._asNumber(props.titleMaxZoom),
            titleAllowOverflow: props.titleAllowOverflow,
            titlePriority: this._asNumber(props.titlePriority),
            tooltip: props.tooltip || props.description || '',
        };

        const merged: PolygonOptions = { ...defaults, ...(cb ?? {}), rings };
        const polygon = new Polygon(merged);
        this.add(polygon);
        if (this.onEachFeature) this.onEachFeature(feature, polygon);
    }

    private _createArea3D(
        feature: GeoJSONFeature,
        props: Props,
        rings: Area3DRing[],
        cb: Partial<Area3DOptions> | null | undefined,
    ): void {
        const defaults: Area3DOptions = {
            rings,
            crs: this.crs ?? undefined,
            modelUrl: props.modelUrl ?? this.defaultPolygon3DModelUrl,
            fit: props.fit || this.defaultPolygon3DFit,
            rotate: this._asNumber(props.rotate) ?? this.defaultPolygon3DRotate,
            primitiveType: props.primitiveType || this.defaultPolygon3DPrimitiveType,
            size: this._parseSizeSpec(props.size) ?? this.defaultPolygon3DSize,
            anchor: this._parseTriple(props.anchor) ?? this.defaultPolygon3DAnchor,
            altitude: this._asNumber(props.altitude) ?? this.defaultPolygon3DAltitude,
            altitudeMode: props.altitudeMode || this.defaultPolygon3DAltitudeMode,
            color: props.color ?? 0x3388ff,
            depthTest: props.depthTest ?? this.defaultPolygon3DDepthTest,
            depthWrite: props.depthWrite ?? this.defaultPolygon3DDepthWrite,
            minZoom: this._asNumber(props.minZoom),
            maxZoom: this._asNumber(props.maxZoom),
            title: props.title || props.name || '',
            titlePlacement: props.titlePlacement || 'top',
            titleAlign: props.titleAlign,
            titleOffset: this._parsePair(props.titleOffset) ?? undefined,
            titleStyle: props.titleStyle,
            titleMinZoom: this._asNumber(props.titleMinZoom),
            titleMaxZoom: this._asNumber(props.titleMaxZoom),
            tooltip: props.tooltip || props.description || '',
        };

        const merged: Area3DOptions = { ...defaults, ...(cb ?? {}), rings };
        const area = new Area3D(merged);
        this.add(area);
        if (this.onEachFeature) this.onEachFeature(feature, area);
    }

    // =================================================================
    // Vector3D
    // =================================================================

    private _addVectorFeature(feature: GeoJSONFeature): void {
        const geom = feature.geometry;
        const props = feature.properties ?? {};

        // Наборы координат по умолчанию. Для Point — null (позиции
        // должен задать vectorToOptions).
        let coordSets: (GeoJSONLineString | null)[];
        if (geom.type === 'LineString')          coordSets = [geom.coordinates];
        else if (geom.type === 'MultiLineString') coordSets = geom.coordinates;
        else                                      coordSets = [null];

        for (const coords of coordSets) {
            const cb = this.vectorToOptions ? this.vectorToOptions(feature, props) : null;
            const defaultPositions = coords ? this._toVectorPositions(coords) : undefined;
            const positions = cb?.positions ?? defaultPositions;
            if (!positions || positions.length < 2) continue;

            const defaults: Vector3DOptions = {
                positions,
                crs: this.crs ?? undefined,
                title: props.title || props.name || '',
                titleStyle: props.titleStyle,
                titleOffset: this._parsePair(props.titleOffset) ?? undefined,
                titleAlign: props.titleAlign,
                titleVerticalAlign: props.titleVerticalAlign,
                titleMinZoom: this._asNumber(props.titleMinZoom),
                titleMaxZoom: this._asNumber(props.titleMaxZoom),
                titlePlacement: props.titlePlacement || 'start',
                tooltip: props.tooltip || props.description || '',
                minZoom: this._asNumber(props.minZoom),
                maxZoom: this._asNumber(props.maxZoom),
                color: props.stroke || props.color || '#3388ff',
                width: this._asNumber(props.width) ?? 2,
                arrowSize: this._asNumber(props.arrowSize) ?? 10,
                opacity: this._asNumber(props['stroke-opacity'] ?? props.opacity) ?? 1,
            };

            const merged: Vector3DOptions = { ...defaults, ...(cb ?? {}), positions };
            const vector = new Vector3D(merged);
            this.add(vector);
            if (this.onEachFeature) this.onEachFeature(feature, vector);
        }
    }

    // =================================================================
    // Внутренние парсеры / утилиты
    // =================================================================

    /** Pad 2D → `[lon, lat, 0]` для `Vector3D`. */
    private _toVectorPositions(coords: GeoJSONLineString): Vector3DPosition[] {
        return coords.map(c => [c[0], c[1], c[2] ?? 0] as Vector3DPosition);
    }

    /** `[w, h] | [w, h, d] | number` или строка `"w,h"` → `number[]`. */
    private _parseSize(raw: any): number[] | null {
        if (!raw) return null;
        if (Array.isArray(raw)) return raw as number[];
        if (typeof raw === 'string') {
            const parts = raw.split(',').map(Number);
            if (parts.length >= 1 && parts.length <= 3 && parts.every(v => !isNaN(v))) {
                return parts;
            }
        }
        return null;
    }

    /** Строго 2-элементный размер (для `IconSize`). */
    private _parseIconSize(raw: any): IconSize | null {
        const arr = this._parseSize(raw);
        if (!arr || arr.length !== 2) return null;
        return [arr[0], arr[1]];
    }

    /** Строго 1..3-элементный размер (для `SizeSpec` в 3D-объектах). */
    private _parseSizeSpec(raw: any): SizeSpec | null {
        const arr = this._parseSize(raw);
        if (!arr || arr.length < 1 || arr.length > 3) return null;
        return arr;
    }

    /** 2-элементный массив из `[a, b]` или строки `"a,b"`. */
    private _parsePair(raw: any): [number, number] | null {
        if (!raw) return null;
        if (Array.isArray(raw) && raw.length === 2) {
            const [a, b] = raw as any[];
            if (typeof a === 'number' && typeof b === 'number' && isFinite(a) && isFinite(b)) {
                return [a, b];
            }
        }
        if (typeof raw === 'string') {
            const parts = raw.split(',').map(Number);
            if (parts.length === 2 && parts.every(v => !isNaN(v))) {
                return [parts[0], parts[1]];
            }
        }
        return null;
    }

    /** 3-элементный массив из `[a, b, c]` или строки `"a,b,c"`. */
    private _parseTriple(raw: any): [number, number, number] | null {
        if (!raw) return null;
        if (Array.isArray(raw) && raw.length === 3) {
            const [a, b, c] = raw as any[];
            if (typeof a === 'number' && typeof b === 'number' && typeof c === 'number'
                && isFinite(a) && isFinite(b) && isFinite(c)) {
                return [a, b, c];
            }
        }
        if (typeof raw === 'string') {
            const parts = raw.split(',').map(Number);
            if (parts.length === 3 && parts.every(v => !isNaN(v))) {
                return [parts[0], parts[1], parts[2]];
            }
        }
        return null;
    }

    /** Безопасное приведение к `number` (строки тоже принимаются). */
    private _asNumber(v: any): number | undefined {
        if (typeof v === 'number' && isFinite(v)) return v;
        if (typeof v === 'string' && v.trim() !== '') {
            const n = Number(v);
            if (isFinite(n)) return n;
        }
        return undefined;
    }
}