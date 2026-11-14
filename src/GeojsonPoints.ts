/**
 * GeojsonPoints.ts — точки: Marker, Marker3D, точечные диаграммы.
 */
import { Marker, type MarkerOptions, type MarkerPosition, type LonLat } from './Marker.js';
import { Marker3D, type Marker3DOptions, type Marker3DPosition } from './Marker3D.js';
import { Diagram } from './Diagram.js';
import { Diagram3D } from './Diagram3D.js';
import {
    POINT_ALIASES, MARKER3D_ALIASES,
    type PointStyleAliases, type Marker3DStyleAliases,
    type GeoJSONFeature, type Props,
} from './Geojson.js';
import type { GeoJSONLayer } from './Geojson.js';

export interface GeoJSONLayerPoints {
    _addPointFeature(feature: GeoJSONFeature): void;
    _addPointDiagram(feature: GeoJSONFeature, props: Props, lonLat: LonLat): void;
    _addPointDiagram3D(feature: GeoJSONFeature, props: Props, lonLat: LonLat, altFromCoords?: number): void;
    _createMarker(feature: GeoJSONFeature, props: Props, position: MarkerPosition,
                  cb: (Partial<MarkerOptions> & PointStyleAliases) | null): void;
    _createMarker3D(feature: GeoJSONFeature, props: Props, position: Marker3DPosition,
                    cb: (Partial<Marker3DOptions> & Marker3DStyleAliases) | null): void;
}

export const PointsMixin = {
    _addPointFeature(this: GeoJSONLayer, feature: GeoJSONFeature): void {
        const geom = feature.geometry;
        if (geom.type !== 'Point') return;
        const props = feature.properties ?? {};

        const [lon, lat, altRaw] = geom.coordinates;
        const lonLat: LonLat = [lon, lat];
        const altFromCoords = typeof altRaw === 'number' && Number.isFinite(altRaw) ? altRaw : undefined;
        const markerPos: MarkerPosition = altFromCoords !== undefined ? [lon, lat, altFromCoords] : [lon, lat];
        const marker3DPos: Marker3DPosition = altFromCoords !== undefined ? [lon, lat, altFromCoords] : [lon, lat];

        if ((this.diagram3D || this.diagram3DToOptions) && props.diagram3D !== false) {
            this._addPointDiagram3D(feature, props, lonLat, altFromCoords);
            return;
        }
        if ((this.diagram || this.diagramToOptions) && props.diagram !== false) {
            this._addPointDiagram(feature, props, lonLat);
            return;
        }

        const cb3D = this.point3DToOptions?.(feature, props) ?? null;
        const is3D = cb3D != null || props['3d'] === true || props.type === '3d' || props.markerType === '3d';

        if (is3D) this._createMarker3D(feature, props, marker3DPos, cb3D);
        else      this._createMarker(feature, props, markerPos, this.pointToOptions?.(feature, props) ?? null);
    },

    _addPointDiagram3D(this: GeoJSONLayer, feature: GeoJSONFeature, props: Props,
                       lonLat: LonLat, altFromCoords?: number): void {
        const raw = this.diagram3DToOptions
            ? this.diagram3DToOptions(feature, props)
            : this._diagram3DFromConfig(feature, props);
        if (!raw) return;
        const baseOpts = this._withDiagram3DAuto(raw);
        const d = new Diagram3D({
            ...baseOpts,
            position: lonLat,
            crs: this.crs ?? undefined,
            altitude: baseOpts.altitude ?? altFromCoords ?? 0,
            altitudeMode: baseOpts.altitudeMode ?? 'clampToGround',
            clusterable: false,
        });
        this.add(d);
        this.onEachDiagram3D?.(feature, d);
    },

    _addPointDiagram(this: GeoJSONLayer, feature: GeoJSONFeature, props: Props, lonLat: LonLat): void {
        const opts = this.diagramToOptions
            ? this.diagramToOptions(feature, props)
            : this._diagramFromConfig(feature, props);
        if (!opts) return;
        const d = new Diagram({
            ...opts,
            position: lonLat,
            crs: this.crs ?? undefined,
            parentPolygon: null,
            fitToPolygon: false,
            clusterable: false,
        });
        this.add(d);
        this.onEachDiagram?.(feature, d);
    },

    _createMarker(this: GeoJSONLayer, feature: GeoJSONFeature, props: Props,
                  position: MarkerPosition,
                  cb: (Partial<MarkerOptions> & PointStyleAliases) | null): void {
        const defaults: MarkerOptions = {
            position,
            crs: this.crs ?? undefined,
            title: this._getTitle(props),
            tooltip: this._getTooltip(props),
            iconUrl: props.icon || this.defaultIconUrl,
            iconSize: this._parseIconSize(props.iconSize) ?? this.defaultIconSize,
            anchor: this._parsePair(props.anchor) ?? this.defaultAnchor,
            altitude: this._asNumber(props.altitude) ?? 0,
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
        const style = this._normalizeStyle<MarkerOptions>(this._resolveStyle(props, 'point'), POINT_ALIASES);
        const cbNorm = this._normalizeStyle<MarkerOptions>(cb, POINT_ALIASES);
        const merged: MarkerOptions = { ...defaults, ...(style ?? {}), ...(cbNorm ?? {}), position };
        if (merged.titleStyle) merged.titleStyle = this._interpolateStyle(merged.titleStyle, props);

        const marker = new Marker(merged);
        this.add(marker);
        this.onEachFeature?.(feature, marker);
    },

    _createMarker3D(this: GeoJSONLayer, feature: GeoJSONFeature, props: Props,
                    position: Marker3DPosition,
                    cb: (Partial<Marker3DOptions> & Marker3DStyleAliases) | null): void {
        const defaults: Marker3DOptions = {
            position,
            crs: this.crs ?? undefined,
            title: this._getTitle(props),
            tooltip: this._getTooltip(props),
            primitiveType: props.primitiveType || this.default3DPrimitiveType,
            size: this._parseSizeSpec(props.size) ?? this.default3DSize,
            anchor: this._parseTriple(props.anchor) ?? this.default3DAnchor,
            altitude: this._asNumber(props.altitude) ?? this.default3DAltitude,
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
        const style = this._normalizeStyle<Marker3DOptions>(this._resolveStyle(props, 'marker3D'), MARKER3D_ALIASES);
        const cbNorm = this._normalizeStyle<Marker3DOptions>(cb, MARKER3D_ALIASES);
        const merged: Marker3DOptions = { ...defaults, ...(style ?? {}), ...(cbNorm ?? {}), position };
        if (merged.titleStyle) merged.titleStyle = this._interpolateStyle(merged.titleStyle, props);

        const marker = new Marker3D(merged);
        this.add(marker);
        this.onEachFeature?.(feature, marker);
    },
};