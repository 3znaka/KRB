/**
 * GeojsonShapes.ts — линии, полигоны, Area3D, картодиаграммы.
 */
import { Polyline, type PolylineOptions } from './Polyline.js';
import { Polygon, type PolygonOptions } from './Polygon.js';
import { Area3D, type Area3DOptions, type Area3DRing } from './Area3D.js';
import { Diagram } from './Diagram.js';
import { Diagram3D } from './Diagram3D.js';
import { getClassIndex } from './Classification.js';
import { sampleColorRamp } from './ColorRamps.js';
import {
    LINE_ALIASES, POLYGON_ALIASES, AREA3D_ALIASES,
    type LineStyleAliases, type PolygonStyleAliases, type Area3DStyleAliases,
    type GeoJSONFeature, type GeoJSONPolygon, type Props,
} from './Geojson.js';
import type { GeoJSONLayer } from './Geojson.js';

export interface GeoJSONLayerShapes {
    _addLineFeature(feature: GeoJSONFeature): void;
    _addPolygonFeature(feature: GeoJSONFeature): void;
    _createPolygon(feature: GeoJSONFeature, props: Props, rings: GeoJSONPolygon,
                   cb: (Partial<PolygonOptions> & PolygonStyleAliases) | null): Polygon | null;
    _addCartodiagram(feature: GeoJSONFeature, props: Props, polygon: Polygon): void;
    _addCartodiagram3D(feature: GeoJSONFeature, props: Props, polygon: Polygon): void;
    _createArea3D(feature: GeoJSONFeature, props: Props, rings: Area3DRing[],
                  cb: (Partial<Area3DOptions> & Area3DStyleAliases) | null): void;
}

export const ShapesMixin = {
    _addLineFeature(this: GeoJSONLayer, feature: GeoJSONFeature): void {
        const geom = feature.geometry;
        if (geom.type !== 'LineString' && geom.type !== 'MultiLineString') return;
        const props = feature.properties ?? {};
        const coordSets = geom.type === 'LineString' ? [geom.coordinates] : geom.coordinates;

        for (const coords of coordSets) {
            if (coords.length < 2) continue;
            const cb = this.lineToOptions?.(feature, props) ?? null;
            const defaults: PolylineOptions = {
                positions: coords,
                crs: this.crs ?? undefined,
                color: props.stroke || props.color || this.defaultLineColor,
                opacity: this._asNumber(props['stroke-opacity'] ?? props.opacity) ?? this.defaultLineOpacity,
                width: this._asNumber(props['stroke-width'] ?? props.width) ?? this.defaultLineWidth,
                altitudeMode: props.altitudeMode || this.defaultLineAltitudeMode,
                altitude: this._asNumber(props.altitude) ?? this._asNumber(props.altitudeOffset) ?? this.defaultLineAltitude,
                depthTest: props.depthTest ?? this.defaultLineDepthTest,
                depthWrite: props.depthWrite ?? this.defaultLineDepthWrite,
                minZoom: this._asNumber(props.minZoom) ?? this.defaultLineMinZoom,
                maxZoom: this._asNumber(props.maxZoom) ?? this.defaultLineMaxZoom,
                title: this._getTitle(props),
                tooltip: this._getTooltip(props),
                titleOffset: this._parsePair(props.titleOffset) ?? undefined,
                titleAlign: props.titleAlign,
                titleStyle: props.titleStyle,
                titleMinZoom: this._asNumber(props.titleMinZoom),
                titleMaxZoom: this._asNumber(props.titleMaxZoom),
                titlePlacement: props.titlePlacement,
                titleAllowOverflow: props.titleAllowOverflow,
                titlePriority: this._asNumber(props.titlePriority),
            };
            const style = this._normalizeStyle<PolylineOptions>(this._resolveStyle(props, 'line'), LINE_ALIASES);
            const cbNorm = this._normalizeStyle<PolylineOptions>(cb, LINE_ALIASES);
            const merged: PolylineOptions = { ...defaults, ...(style ?? {}), ...(cbNorm ?? {}), positions: coords };
            if (merged.titleStyle) merged.titleStyle = this._interpolateStyle(merged.titleStyle, props);

            const polyline = new Polyline(merged);
            this.add(polyline);
            this.onEachFeature?.(feature, polyline);
        }
    },

    _addPolygonFeature(this: GeoJSONLayer, feature: GeoJSONFeature): void {
        const geom = feature.geometry;
        if (geom.type !== 'Polygon' && geom.type !== 'MultiPolygon') return;
        const props = feature.properties ?? {};
        const ringSets = geom.type === 'Polygon' ? [geom.coordinates] : geom.coordinates;

        for (const rings of ringSets) {
            if (!rings.length || !rings[0].length) continue;
            const cb3D = this.polygon3DToOptions?.(feature, props) ?? null;
            const is3D = cb3D != null || props['3d'] === true || props.type === '3d' || props.markerType === '3d';
            if (is3D) { this._createArea3D(feature, props, rings as Area3DRing[], cb3D); continue; }

            const polygon = this._createPolygon(feature, props, rings, this.polygonToOptions?.(feature, props) ?? null);
            if (!polygon) continue;

            if (this.diagram3D || this.diagram3DToOptions) this._addCartodiagram3D(feature, props, polygon);
            else if (this.diagram || this.diagramToOptions) this._addCartodiagram(feature, props, polygon);
        }
    },

    _createPolygon(this: GeoJSONLayer, feature: GeoJSONFeature, props: Props, rings: GeoJSONPolygon,
                   cb: (Partial<PolygonOptions> & PolygonStyleAliases) | null): Polygon | null {
        let choroplethColor: string | undefined;
        if (this.choropleth && this._choroplethRamp) {
            const val = this._evaluateValueExpression(props, this.choropleth.value);
            if (isFinite(val)) {
                const idx = getClassIndex(val, this._choroplethBreaks);
                const denom = Math.max(1, this._choroplethBreaks.length - 2);
                const t = idx / denom;
                const rgba = sampleColorRamp(this._choroplethRamp, t);
                choroplethColor = `#${((1 << 24) + (rgba[0] << 16) + (rgba[1] << 8) + rgba[2]).toString(16).slice(1)}`;
            } else {
                choroplethColor = this.choropleth.noDataColor ?? '#cccccc';
            }
        }
        const defaults: PolygonOptions = {
            rings,
            crs: this.crs ?? undefined,
            fillColor: choroplethColor || props.fill || props['fill-color'] || this.defaultFillColor,
            fillOpacity: this._asNumber(props['fill-opacity']) ?? this.defaultFillOpacity,
            strokeColor: props.stroke || props['stroke-color'] || this.defaultStrokeColor,
            strokeWidth: this._asNumber(props['stroke-width']) ?? this.defaultStrokeWidth,
            strokeOpacity: this._asNumber(props['stroke-opacity']) ?? this.defaultStrokeOpacity,
            altitudeMode: props.altitudeMode || this.defaultPolygonAltitudeMode,
            altitude: this._asNumber(props.altitude) ?? this._asNumber(props.altitudeOffset) ?? this.defaultPolygonAltitude,
            depthTest: props.depthTest ?? this.defaultPolygonDepthTest,
            depthWrite: props.depthWrite ?? this.defaultPolygonDepthWrite,
            minZoom: this._asNumber(props.minZoom) ?? this.defaultPolygonMinZoom,
            maxZoom: this._asNumber(props.maxZoom) ?? this.defaultPolygonMaxZoom,
            extruded: props.extruded ?? this.defaultPolygonExtruded,
            height: this._asNumber(props.height) ?? this.defaultPolygonHeight,
            minHeight: this._asNumber(props.minHeight) ?? this.defaultPolygonMinHeight,
            title: this._getTitle(props),
            titleOffset: this._parsePair(props.titleOffset) ?? undefined,
            titleAlign: props.titleAlign,
            titleStyle: props.titleStyle,
            titleMinZoom: this._asNumber(props.titleMinZoom),
            titleMaxZoom: this._asNumber(props.titleMaxZoom),
            titleAllowOverflow: props.titleAllowOverflow,
            titlePriority: this._asNumber(props.titlePriority),
            tooltip: this._getTooltip(props),
            tooltipOnHover: this.tooltipOnHover,
        };
        const style = this._normalizeStyle<PolygonOptions>(this._resolveStyle(props, 'polygon'), POLYGON_ALIASES);
        const cbNorm = this._normalizeStyle<PolygonOptions>(cb, POLYGON_ALIASES);
        const merged: PolygonOptions = {
            ...defaults, ...(style ?? {}), ...(cbNorm ?? {}), rings,
            fillColor: choroplethColor || cbNorm?.fillColor || style?.fillColor || defaults.fillColor,
        };
        if (merged.titleStyle) merged.titleStyle = this._interpolateStyle(merged.titleStyle, props);

        const polygon = new Polygon(merged);
        this.add(polygon);
        this.onEachFeature?.(feature, polygon);
        return polygon;
    },

    _addCartodiagram(this: GeoJSONLayer, feature: GeoJSONFeature, props: Props, polygon: Polygon): void {
        const opts = this.diagramToOptions
            ? this.diagramToOptions(feature, props)
            : this._diagramFromConfig(feature, props);
        if (!opts) return;
        const center = polygon.getVisualCenter();
        if (!center) return;
        const d = new Diagram({
            ...opts,
            position: center,
            crs: this.crs,
            parentPolygon: polygon,
            fitToPolygon: opts.fitToPolygon ?? this.diagram?.fitToPolygon ?? true,
            minScreenScale: opts.minScreenScale ?? this.diagram?.minScreenScale ?? 0.5,
            clusterable: false,
        });
        this.add(d);
        this.onEachDiagram?.(feature, d);
    },

    _addCartodiagram3D(this: GeoJSONLayer, feature: GeoJSONFeature, props: Props, polygon: Polygon): void {
        const raw = this.diagram3DToOptions
            ? this.diagram3DToOptions(feature, props)
            : this._diagram3DFromConfig(feature, props);
        if (!raw) return;
        const baseOpts = this._withDiagram3DAuto(raw);
        const center = polygon.getVisualCenter();
        if (!center) return;
        const d = new Diagram3D({
            ...baseOpts,
            position: center,
            crs: 'EPSG:4326',
            altitude: baseOpts.altitude ?? this.defaultPolygonAltitude,
            altitudeMode: baseOpts.altitudeMode ?? this.defaultPolygonAltitudeMode,
            clusterable: false,
        });
        this.add(d);
        this.onEachDiagram3D?.(feature, d);
    },

    _createArea3D(this: GeoJSONLayer, feature: GeoJSONFeature, props: Props, rings: Area3DRing[],
                  cb: (Partial<Area3DOptions> & Area3DStyleAliases) | null): void {
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
            title: this._getTitle(props),
            titlePlacement: props.titlePlacement || 'top',
            titleAlign: props.titleAlign,
            titleOffset: this._parsePair(props.titleOffset) ?? undefined,
            titleStyle: props.titleStyle,
            titleMinZoom: this._asNumber(props.titleMinZoom),
            titleMaxZoom: this._asNumber(props.titleMaxZoom),
            tooltip: this._getTooltip(props),
        };
        const style = this._normalizeStyle<Area3DOptions>(this._resolveStyle(props, 'area3D'), AREA3D_ALIASES);
        const cbNorm = this._normalizeStyle<Area3DOptions>(cb, AREA3D_ALIASES);
        const merged: Area3DOptions = { ...defaults, ...(style ?? {}), ...(cbNorm ?? {}), rings };
        if (merged.titleStyle) merged.titleStyle = this._interpolateStyle(merged.titleStyle, props);

        const area = new Area3D(merged);
        this.add(area);
        this.onEachFeature?.(feature, area);
    },
};