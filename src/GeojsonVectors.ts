/**
 * GeojsonVectors.ts — Vector3D (направленные отрезки/стрелки).
 */
import { Vector3D, type Vector3DOptions, type Vector3DPosition } from './Vector3D.js';
import {
    VECTOR_ALIASES,
    type VectorStyleAliases,
    type GeoJSONFeature, type GeoJSONLineString, type Props,
} from './Geojson.js';
import type { GeoJSONLayer } from './Geojson.js';

export interface GeoJSONLayerVectors {
    _addVectorFeature(feature: GeoJSONFeature): void;
    _toVectorPositions(coords: GeoJSONLineString): Vector3DPosition[];
}

export const VectorsMixin = {
    _addVectorFeature(this: GeoJSONLayer, feature: GeoJSONFeature): void {
        const geom = feature.geometry;
        const props = feature.properties ?? {};

        const coordSets: (GeoJSONLineString | null)[] =
            geom.type === 'LineString' ? [geom.coordinates]
          : geom.type === 'MultiLineString' ? geom.coordinates
          : [null];

        const styleN = this._normalizeStyle<Vector3DOptions>(this._resolveStyle(props, 'vector'), VECTOR_ALIASES);
        const num = (v: any): number | undefined => this._asNumber(v);

        for (const coords of coordSets) {
            const cb = this.vectorToOptions?.(feature, props) ?? null;
            const cbNorm = this._normalizeStyle<Vector3DOptions>(cb, VECTOR_ALIASES);
            const positions = cbNorm?.positions ?? (coords ? this._toVectorPositions(coords) : undefined);
            if (!positions || positions.length < 2) continue;

            const defaults: Vector3DOptions = {
                positions,
                crs: this.crs ?? undefined,
                title: this._getTitle(props),
                titleStart: props.titleStart,
                titleEnd: props.titleEnd,
                titlePlacement: props.titlePlacement || 'start',
                titleStyle: props.titleStyle,
                titleOffset: this._parsePair(props.titleOffset) ?? undefined,
                titleAlign: props.titleAlign,
                titleVerticalAlign: props.titleVerticalAlign,
                titleMinZoom: num(props.titleMinZoom),
                titleMaxZoom: num(props.titleMaxZoom),
                titleAllowOverflow: props.titleAllowOverflow,
                titlePriority: num(props.titlePriority),
                tooltip: this._getTooltip(props),
                minZoom: num(props.minZoom) ?? this.defaultVectorMinZoom,
                maxZoom: num(props.maxZoom) ?? this.defaultVectorMaxZoom,
                color: props.stroke || props.color || this.defaultVectorColor,
                width: num(props.width ?? props['stroke-width']) ?? this.defaultVectorWidth,
                arrowSize: num(props.arrowSize) ?? this.defaultVectorArrowSize,
                arrowSizeMode: props.arrowSizeMode ?? this.defaultVectorArrowSizeMode,
                opacity: num(props['stroke-opacity'] ?? props.opacity) ?? this.defaultVectorOpacity,
                heightScale: num(props.heightScale) ?? this.defaultVectorHeightScale,
                altitude: num(props.altitude) ?? this.defaultVectorAltitude,
                altitudeMode: props.altitudeMode || this.defaultVectorAltitudeMode,
                depthTest: props.depthTest ?? this.defaultVectorDepthTest,
                depthWrite: props.depthWrite ?? this.defaultVectorDepthWrite,
                simplify: props.simplify ?? this.defaultVectorSimplify,
                simplifyTolerance: num(props.simplifyTolerance) ?? this.defaultVectorSimplifyTolerance,
                simplifyZoomBucket: num(props.simplifyZoomBucket) ?? this.defaultVectorSimplifyZoomBucket,
                animation: props.animation ?? null,
            };
            const merged: Vector3DOptions = { ...defaults, ...(styleN ?? {}), ...(cbNorm ?? {}), positions };
            if (merged.titleStyle)      merged.titleStyle      = this._interpolateStyle(merged.titleStyle, props);
            if (merged.titleStartStyle) merged.titleStartStyle = this._interpolateStyle(merged.titleStartStyle, props);
            if (merged.titleEndStyle)   merged.titleEndStyle   = this._interpolateStyle(merged.titleEndStyle, props);

            const v = new Vector3D(merged);
            this.add(v);
            this.onEachFeature?.(feature, v);
        }
    },

    _toVectorPositions(this: GeoJSONLayer, coords: GeoJSONLineString): Vector3DPosition[] {
        return coords.map(c => [c[0], c[1], c[2] ?? 0] as Vector3DPosition);
    },
};