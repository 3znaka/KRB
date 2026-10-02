/**
 * VectorLineLayer.js — устаревший фасад для Vector3D.
 *
 * Сохранён для обратной совместимости: раньше это был самостоятельный
 * слой с доменной логикой. Теперь — тонкая надстройка над
 * {@link GeoJSONLayer}, которая для каждого Vector3D вызывает
 * пользовательские `pointsFn` и `style`.
 *
 * Новый код должен использовать `GeoJSONLayer` с `vectorToOptions`
 * напрямую. ECEF-утилиты по-прежнему живут в {@link Vector3D}.
 *
 * @module VectorLineLayer
 */

import { GeoJSONLayer } from './Geojson.js';

export { ecefToGeodetic, enuToEcefDelta, isEcefCrs, ECEF_CODES } from './Vector3D.js';

/**
 * @deprecated Используйте {@link GeoJSONLayer} с `vectorToOptions`.
 */
export class VectorLineLayer extends GeoJSONLayer {
    /**
     * @param {Object} [opts]
     * @param {string} [opts.url]
     * @param {Object} [opts.data]
     * @param {string} [opts.crs]
     * @param {Function} [opts.pointsFn]  - (feature, props) → Array<[x,y,z]>.
     * @param {Function} [opts.style]     - (feature, props) → style для Vector3D.
     * @param {Function} [opts.filter]
     * @param {number}   [opts.heightScale=1]
     * @param {number}   [opts.altitudeOffset=0]
     * @param {Function} [opts.onEachFeature]
     */
    constructor(opts = {}) {
        super({
            url: opts.url,
            data: opts.data,
            crs: opts.crs,
            filter: opts.filter,
            onEachFeature: opts.onEachFeature,
            vectorToOptions: (feature, props) => {
                const positions = this.pointsFn
                    ? this.pointsFn(feature, props)
                    : null;
                const style = this.styleFn
                    ? (this.styleFn(feature, props) || {})
                    : {};
                return {
                    ...style,
                    positions,
                    heightScale: this.heightScale,
                    altitudeOffset: this.altitudeOffset,
                };
            },
        });

        this.pointsFn       = opts.pointsFn || null;
        this.styleFn        = opts.style || null;
        this.heightScale    = opts.heightScale ?? 1;
        this.altitudeOffset = opts.altitudeOffset ?? 0;
    }

    /**
     * Все поддерживаемые геометрии трактуются как векторы.
     * @private
     */
    _addFeature(feature) {
        const props = feature.properties || {};
        if (this.filter && !this.filter(feature, props)) return;
        if (!feature.geometry) return;

        const t = feature.geometry.type;
        if (t === 'Point' || t === 'LineString' || t === 'MultiLineString') {
            this._addVectorFeature(feature);
        }
    }
}