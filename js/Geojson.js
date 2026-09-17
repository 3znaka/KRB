// geojson.js — слой GeoJSON (Point, LineString, MultiLineString, Polygon, MultiPolygon).
// Координаты по умолчанию интерпретируются как WGS84 (EPSG:4326); при необходимости
// задайте options.crs или переопределите CRS точечно в коллбэках (свойство crs).

import { Layer } from './Layers.js';
import { Marker } from './Marker.js';
import { Marker3D } from './Marker3D.js';
import { Area3D } from './Area3D.js';
import { Polyline } from './Polyline.js';
import { Polygon } from './Polygon.js';

/**
 * Слой, создающий маркеры, линии и полигоны из GeoJSON.
 *
 * Проецирование координат делегировано создаваемым объектам (Polygon,
 * Polyline, Marker, …) — они сами вызывают map.projectSafe и корректно
 * обрабатывают точки вне области определения проекции. Этот слой
 * координаты не трогает, только передаёт их вместе с `crs`.
 *
 * @example
 * const layer = new GeoJSONLayer({
 *     url: 'data.geojson',
 *     crs: 'EPSG:4326',
 *     pointToOptions: (f, p) => ({ title: p.name }),
 *     polygonToOptions: (f, p) => ({ fillColor: p.fill }),
 *     onEachFeature: (f, obj) => console.log(f, obj)
 * });
 * layer.addTo(map);
 * layer.reload();
 */
export class GeoJSONLayer extends Layer {
    /**
     * @param {Object} [options]
     * @param {string} [options.url] - URL GeoJSON-файла.
     * @param {Object} [options.data] - Готовый GeoJSON (FeatureCollection/Feature/геометрия).
     * @param {string} [options.crs] - Код СК координат; по умолчанию map.inputCRS.
     * @param {Function} [options.pointToOptions] - (feature, props) → опции Marker.
     * @param {Function} [options.point3DToOptions] - (feature, props) → опции Marker3D.
     * @param {Function} [options.lineToOptions] - (feature, props) → опции Polyline.
     * @param {Function} [options.polygonToOptions] - (feature, props) → опции Polygon.
     * @param {Function} [options.polygon3DToOptions] - (feature, props) → опции Area3D.
     * @param {Function} [options.filter] - (feature) → boolean; true — добавить.
     * @param {Function} [options.onEachFeature] - (feature, object) — после создания.
     * @param {string} [options.defaultIconUrl='marker.png']
     * @param {number[]} [options.defaultIconSize=[16,16]]
     * @param {number[]} [options.defaultAnchor=[0.5,1.0]]
     * @param {string} [options.default3DPrimitiveType='box']
     * @param {number[]} [options.default3DSize=[100,100,100]]
     * @param {number[]} [options.default3DAnchor=[0.5,0,0.5]]
     * @param {number} [options.default3DAltitude=0]
     * @param {string} [options.default3DAltitudeMode='clampToGround']
     * @param {string} [options.defaultLineColor='#3388ff']
     * @param {number} [options.defaultLineWidth=2]
     * @param {number} [options.defaultLineOpacity=1]
     * @param {string} [options.defaultLineAltitudeMode='ground']
     * @param {number} [options.defaultLineAltitudeOffset=10]
     * @param {boolean} [options.defaultLineDepthTest=false]
     * @param {boolean} [options.defaultLineDepthWrite=false]
     * @param {number} [options.defaultLineMinZoom=-Infinity]
     * @param {number} [options.defaultLineMaxZoom=Infinity]
     * @param {string} [options.defaultFillColor='#3388ff']
     * @param {number} [options.defaultFillOpacity=0.5]
     * @param {string} [options.defaultStrokeColor='#000000']
     * @param {number} [options.defaultStrokeWidth=2]
     * @param {number} [options.defaultStrokeOpacity=1]
     * @param {string} [options.defaultPolygonAltitudeMode='ground']
     * @param {number} [options.defaultPolygonAltitudeOffset=10]
     * @param {boolean} [options.defaultPolygonDepthTest=false]
     * @param {boolean} [options.defaultPolygonDepthWrite=false]
     * @param {number} [options.defaultPolygonMinZoom=-Infinity]
     * @param {number} [options.defaultPolygonMaxZoom=Infinity]
     * @param {boolean} [options.defaultPolygonExtruded=false]
     * @param {number} [options.defaultPolygonHeight=0]
     * @param {number} [options.defaultPolygonMinHeight=0]
     * @param {string} [options.defaultPolygon3DPrimitiveType='box']
     * @param {number[]} [options.defaultPolygon3DSize=null]
     * @param {number[]} [options.defaultPolygon3DAnchor=[0.5,0,0.5]]
     * @param {number} [options.defaultPolygon3DAltitude=0]
     * @param {string} [options.defaultPolygon3DAltitudeMode='clampToGround']
     * @param {string} [options.defaultPolygon3DFit='stretch']
     * @param {number} [options.defaultPolygon3DRotate=0]
     * @param {string} [options.defaultPolygon3DModelUrl=null]
     * @param {boolean} [options.defaultPolygon3DDepthTest=true]
     * @param {boolean} [options.defaultPolygon3DDepthWrite=true]
     */
    constructor(options = {}) {
        super();

        this.url = options.url || null;
        this.data = options.data || null;
        this.crs = options.crs || null;
        this.filter = options.filter || null;
        this.onEachFeature = options.onEachFeature || null;

        this.pointToOptions = options.pointToOptions || null;
        this.point3DToOptions = options.point3DToOptions || null;
        this.lineToOptions = options.lineToOptions || null;
        this.polygonToOptions = options.polygonToOptions || null;
        this.polygon3DToOptions = options.polygon3DToOptions || null;

        // Обычные маркеры.
        this.defaultIconUrl = options.defaultIconUrl || 'marker.png';
        this.defaultIconSize = options.defaultIconSize || [16, 16];
        this.defaultAnchor = options.defaultAnchor || [0.5, 1.0];

        // 3D-маркеры.
        this.default3DPrimitiveType = options.default3DPrimitiveType || 'box';
        this.default3DSize = options.default3DSize || [100, 100, 100];
        this.default3DAnchor = options.default3DAnchor || [0.5, 0, 0.5];
        this.default3DAltitude = options.default3DAltitude ?? 0;
        this.default3DAltitudeMode = options.default3DAltitudeMode || 'clampToGround';

        // Линии.
        this.defaultLineColor = options.defaultLineColor || '#3388ff';
        this.defaultLineWidth = options.defaultLineWidth || 2;
        this.defaultLineOpacity = options.defaultLineOpacity ?? 1;
        this.defaultLineAltitudeMode = options.defaultLineAltitudeMode || 'ground';
        this.defaultLineAltitudeOffset = options.defaultLineAltitudeOffset ?? 10;
        this.defaultLineDepthTest = options.defaultLineDepthTest ?? false;
        this.defaultLineDepthWrite = options.defaultLineDepthWrite ?? false;
        this.defaultLineMinZoom = options.defaultLineMinZoom ?? -Infinity;
        this.defaultLineMaxZoom = options.defaultLineMaxZoom ?? Infinity;

        // Полигоны.
        this.defaultFillColor = options.defaultFillColor || '#3388ff';
        this.defaultFillOpacity = options.defaultFillOpacity ?? 0.5;
        this.defaultStrokeColor = options.defaultStrokeColor || '#000000';
        this.defaultStrokeWidth = options.defaultStrokeWidth || 2;
        this.defaultStrokeOpacity = options.defaultStrokeOpacity ?? 1;
        this.defaultPolygonAltitudeMode = options.defaultPolygonAltitudeMode || 'ground';
        this.defaultPolygonAltitudeOffset = options.defaultPolygonAltitudeOffset ?? 10;
        this.defaultPolygonDepthTest = options.defaultPolygonDepthTest ?? false;
        this.defaultPolygonDepthWrite = options.defaultPolygonDepthWrite ?? false;
        this.defaultPolygonMinZoom = options.defaultPolygonMinZoom ?? -Infinity;
        this.defaultPolygonMaxZoom = options.defaultPolygonMaxZoom ?? Infinity;
        this.defaultPolygonExtruded = options.defaultPolygonExtruded ?? false;
        this.defaultPolygonHeight = options.defaultPolygonHeight ?? 0;
        this.defaultPolygonMinHeight = options.defaultPolygonMinHeight ?? 0;

        // Area3D (3D-площадные).
        this.defaultPolygon3DPrimitiveType = options.defaultPolygon3DPrimitiveType || 'box';
        this.defaultPolygon3DSize = options.defaultPolygon3DSize || null;
        this.defaultPolygon3DAnchor = options.defaultPolygon3DAnchor || [0.5, 0, 0.5];
        this.defaultPolygon3DAltitude = options.defaultPolygon3DAltitude ?? 0;
        this.defaultPolygon3DAltitudeMode = options.defaultPolygon3DAltitudeMode || 'clampToGround';
        this.defaultPolygon3DFit = options.defaultPolygon3DFit || 'stretch';
        this.defaultPolygon3DRotate = options.defaultPolygon3DRotate || 0;
        this.defaultPolygon3DModelUrl = options.defaultPolygon3DModelUrl || null;
        this.defaultPolygon3DDepthTest = options.defaultPolygon3DDepthTest ?? true;
        this.defaultPolygon3DDepthWrite = options.defaultPolygon3DDepthWrite ?? true;

        this._loaded = false;
    }

    /**
     * Добавляет слой на карту и при необходимости запускает загрузку.
     * @param {KrbMap} map @returns {this}
     */
    addTo(map) {
        super.addTo(map);
        if (!this._loaded) this._load();
        return this;
    }

    /** Полная перезагрузка: удаляет объекты, сбрасывает флаг, загружает заново. */
    reload() {
        for (const obj of [...this._objects]) obj.remove();
        this._objects = [];
        this._loaded = false;
        if (this._map) this._load();
    }

    /** @private */
    async _load() {
        let geojson = null;
        try {
            if (this.data) {
                geojson = this.data;
            } else if (this.url) {
                const resp = await fetch(this.url);
                if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
                geojson = await resp.json();
            }
            if (!geojson) {
                console.warn('GeoJSONLayer: не предоставлены данные или URL');
                return;
            }
            this._parse(geojson);
            this._loaded = true;
        } catch (err) {
            console.error('GeoJSONLayer: ошибка загрузки/парсинга', err);
        }
    }

    /** @private */
    _parse(geojson) {
        const type = geojson.type;
        if (type === 'FeatureCollection') {
            for (const feature of geojson.features) this._addFeature(feature);
        } else if (type === 'Feature') {
            this._addFeature(geojson);
        } else if (type === 'Point'
            || type === 'LineString'
            || type === 'MultiLineString'
            || type === 'Polygon'
            || type === 'MultiPolygon') {
            this._addFeature({ type: 'Feature', geometry: geojson, properties: {} });
        } else {
            console.debug(`GeoJSONLayer: тип "${type}" пока не поддерживается`);
        }
    }

    /** @private */
    _addFeature(feature) {
        if (this.filter && !this.filter(feature)) return;

        const geom = feature.geometry;
        if (!geom) return;

        switch (geom.type) {
            case 'Point': this._addPointFeature(feature); break;
            case 'LineString':
            case 'MultiLineString': this._addLineFeature(feature); break;
            case 'Polygon':
            case 'MultiPolygon': this._addPolygonFeature(feature); break;
            default:
                console.debug(`GeoJSONLayer: тип "${geom.type}" пока не поддерживается`);
        }
    }

    /** @private */
    _addPointFeature(feature) {
        const props = feature.properties || {};
        const coords = feature.geometry.coordinates;

        const is3D = (this.point3DToOptions && this.point3DToOptions(feature, props))
            || props['3d'] === true
            || props.type === '3d'
            || props.markerType === '3d';

        if (is3D) {
            const options = this.point3DToOptions
                ? (this.point3DToOptions(feature, props) || {})
                : this._default3DPointOptions(feature, props);

            const marker3DOptions = {
                position: coords,
                crs: options.crs ?? this.crs,
                title: options.title || props.title || props.name || '',
                tooltip: options.tooltip || props.tooltip || props.description || '',
                primitiveType: options.primitiveType || props.primitiveType || this.default3DPrimitiveType,
                size: options.size || this._parseSize(props.size) || this.default3DSize,
                anchor: options.anchor || this._parseTriple(props.anchor) || this.default3DAnchor,
                altitude: options.altitude ?? props.altitude ?? this.default3DAltitude,
                altitudeMode: options.altitudeMode || props.altitudeMode || this.default3DAltitudeMode,
                rotation: options.rotation || props.rotation || [0, 0, 0],
                modelUrl: options.modelUrl || props.modelUrl,
                minZoom: options.minZoom ?? props.minZoom ?? -Infinity,
                maxZoom: options.maxZoom ?? props.maxZoom ?? Infinity,
                titlePlacement: options.titlePlacement || props.titlePlacement || 'top',
                titleAlign: options.titleAlign || props.titleAlign || undefined,
                titleOffset: options.titleOffset || this._parsePair(props.titleOffset) || undefined,
                titleStyle: options.titleStyle || props.titleStyle || {},
                titleMinZoom: options.titleMinZoom ?? props.titleMinZoom ?? -Infinity,
                titleMaxZoom: options.titleMaxZoom ?? props.titleMaxZoom ?? Infinity,
                onHover: options.onHover,
                onClick: options.onClick,
                color: options.color || props.color,
                clusterable: options.clusterable !== undefined ? options.clusterable : false
            };

            const marker3D = new Marker3D(marker3DOptions);
            this.add(marker3D);
            if (this.onEachFeature) this.onEachFeature(feature, marker3D);
        } else {
            const options = this.pointToOptions
                ? (this.pointToOptions(feature, props) || {})
                : this._defaultPointOptions(feature, props);

            const markerOptions = {
                position: coords,
                crs: options.crs ?? this.crs,
                title: options.title || props.title || props.name || '',
                tooltip: options.tooltip || props.tooltip || props.description || '',
                iconUrl: options.iconUrl !== undefined ? options.iconUrl : (props.icon || this.defaultIconUrl),
                iconSize: this._parseSize(options.iconSize || props.iconSize) || this.defaultIconSize,
                anchor: this._parseAnchor(options.anchor || props.anchor) || this.defaultAnchor,
                altitudeMode: options.altitudeMode || props.altitudeMode || 'ground',
                clusterable: options.clusterable !== undefined
                    ? options.clusterable
                    : (props.clusterable !== undefined ? props.clusterable : true),
                minZoom: options.minZoom ?? props.minZoom ?? -Infinity,
                maxZoom: options.maxZoom ?? props.maxZoom ?? Infinity,
                titleMinZoom: options.titleMinZoom ?? props.titleMinZoom ?? -Infinity,
                titleMaxZoom: options.titleMaxZoom ?? props.titleMaxZoom ?? Infinity,
                onHover: options.onHover,
                onClick: options.onClick
            };

            const marker = new Marker(markerOptions);
            this.add(marker);
            if (this.onEachFeature) this.onEachFeature(feature, marker);
        }
    }

    /** @private */
    _defaultPointOptions(feature, props) {
        return {
            title: props.title || props.name || '',
            tooltip: props.tooltip || props.description || '',
            iconUrl: props.icon || this.defaultIconUrl,
            iconSize: this._parseSize(props.iconSize),
            anchor: this._parseAnchor(props.anchor),
            clusterable: props.clusterable !== undefined ? props.clusterable : true,
            altitudeMode: props.altitudeMode || 'ground'
        };
    }

    /** @private */
    _default3DPointOptions(feature, props) {
        return {
            primitiveType: props.primitiveType || this.default3DPrimitiveType,
            size: this._parseSize(props.size) || this.default3DSize,
            anchor: this._parseTriple(props.anchor) || this.default3DAnchor,
            altitude: props.altitude ?? this.default3DAltitude,
            altitudeMode: props.altitudeMode || this.default3DAltitudeMode,
            rotation: props.rotation || [0, 0, 0],
            modelUrl: props.modelUrl,
            minZoom: props.minZoom,
            maxZoom: props.maxZoom,
            color: props.color,
            titleMinZoom: props.titleMinZoom,
            titleMaxZoom: props.titleMaxZoom
        };
    }

    /** @private */
    _addLineFeature(feature) {
        const props = feature.properties || {};
        const geom = feature.geometry;
        const coordSets = geom.type === 'LineString' ? [geom.coordinates] : geom.coordinates;

        for (const coords of coordSets) {
            if (coords.length < 2) continue;

            const options = this.lineToOptions
                ? (this.lineToOptions(feature, props) || {})
                : this._defaultLineOptions(feature, props);

            const lineOptions = {
                positions: coords,
                ...options,
                crs: options.crs ?? this.crs,
                title: options.title ?? props.title ?? props.name ?? '',
                titleOffset: options.titleOffset ?? this._parsePair(props.titleOffset),
                titleAlign: options.titleAlign ?? props.titleAlign ?? 'center',
                titleStyle: options.titleStyle ?? props.titleStyle ?? {},
                titleMinZoom: options.titleMinZoom ?? props.titleMinZoom ?? -Infinity,
                titleMaxZoom: options.titleMaxZoom ?? props.titleMaxZoom ?? Infinity,
                titlePlacement: options.titlePlacement ?? props.titlePlacement ?? 'center'
            };

            const polyline = new Polyline(lineOptions);
            this.add(polyline);
            if (this.onEachFeature) this.onEachFeature(feature, polyline);
        }
    }

    /** @private */
    _defaultLineOptions(feature, props) {
        return {
            color: props.stroke || props.color || this.defaultLineColor,
            opacity: props['stroke-opacity'] ?? props.opacity ?? this.defaultLineOpacity,
            width: props['stroke-width'] ?? props.width ?? this.defaultLineWidth,
            altitudeMode: props.altitudeMode || this.defaultLineAltitudeMode,
            altitudeOffset: props.altitudeOffset ?? this.defaultLineAltitudeOffset,
            depthTest: props.depthTest ?? this.defaultLineDepthTest,
            depthWrite: props.depthWrite ?? this.defaultLineDepthWrite,
            minZoom: props.minZoom ?? this.defaultLineMinZoom,
            maxZoom: props.maxZoom ?? this.defaultLineMaxZoom
        };
    }

    /** @private */
    _addPolygonFeature(feature) {
        const props = feature.properties || {};
        const geom = feature.geometry;
        const polygonSets = geom.type === 'Polygon' ? [geom.coordinates] : geom.coordinates;

        for (const rings of polygonSets) {
            if (!rings.length || !rings[0].length) continue;

            const is3D = (this.polygon3DToOptions && this.polygon3DToOptions(feature, props))
                || props['3d'] === true
                || props.type === '3d'
                || props.markerType === '3d';

            if (is3D) {
                const options3D = this.polygon3DToOptions
                    ? (this.polygon3DToOptions(feature, props) || {})
                    : this._defaultPolygon3DOptions(feature, props);

                const areaOptions = {
                    rings,
                    crs: options3D.crs ?? this.crs,
                    modelUrl: options3D.modelUrl || props.modelUrl || this.defaultPolygon3DModelUrl,
                    fit: options3D.fit || props.fit || this.defaultPolygon3DFit,
                    rotate: options3D.rotate ?? props.rotate ?? this.defaultPolygon3DRotate,
                    primitiveType: options3D.primitiveType || props.primitiveType || this.defaultPolygon3DPrimitiveType,
                    size: options3D.size || this._parseSize(props.size) || this.defaultPolygon3DSize,
                    anchor: options3D.anchor || this._parseTriple(props.anchor) || this.defaultPolygon3DAnchor,
                    altitude: options3D.altitude ?? props.altitude ?? this.defaultPolygon3DAltitude,
                    altitudeMode: options3D.altitudeMode || props.altitudeMode || this.defaultPolygon3DAltitudeMode,
                    color: options3D.color || props.color || 0x3388ff,
                    depthTest: options3D.depthTest ?? props.depthTest ?? this.defaultPolygon3DDepthTest,
                    depthWrite: options3D.depthWrite ?? props.depthWrite ?? this.defaultPolygon3DDepthWrite,
                    minZoom: options3D.minZoom ?? props.minZoom ?? -Infinity,
                    maxZoom: options3D.maxZoom ?? props.maxZoom ?? Infinity,
                    title: options3D.title ?? props.title ?? props.name ?? '',
                    titlePlacement: options3D.titlePlacement || props.titlePlacement || 'top',
                    titleAlign: options3D.titleAlign || props.titleAlign || undefined,
                    titleOffset: options3D.titleOffset || this._parsePair(props.titleOffset) || undefined,
                    titleStyle: options3D.titleStyle || props.titleStyle || {},
                    titleMinZoom: options3D.titleMinZoom ?? props.titleMinZoom ?? -Infinity,
                    titleMaxZoom: options3D.titleMaxZoom ?? props.titleMaxZoom ?? Infinity,
                    tooltip: options3D.tooltip || props.tooltip || props.description || '',
                    onHover: options3D.onHover,
                    onClick: options3D.onClick
                };

                const area = new Area3D(areaOptions);
                this.add(area);
                if (this.onEachFeature) this.onEachFeature(feature, area);
            } else {
                const options = this.polygonToOptions
                    ? (this.polygonToOptions(feature, props) || {})
                    : this._defaultPolygonOptions(feature, props);

                const polygonOptions = {
                    rings,
                    ...options,
                    crs: options.crs ?? this.crs,
                    title: options.title ?? props.title ?? props.name ?? '',
                    titleOffset: options.titleOffset ?? this._parsePair(props.titleOffset),
                    titleAlign: options.titleAlign ?? props.titleAlign ?? 'center',
                    titleStyle: options.titleStyle ?? props.titleStyle ?? {},
                    titleMinZoom: options.titleMinZoom ?? props.titleMinZoom ?? -Infinity,
                    titleMaxZoom: options.titleMaxZoom ?? props.titleMaxZoom ?? Infinity
                };

                const polygon = new Polygon(polygonOptions);
                this.add(polygon);
                if (this.onEachFeature) this.onEachFeature(feature, polygon);
            }
        }
    }

    /** @private */
    _defaultPolygonOptions(feature, props) {
        return {
            fillColor: props.fill || props['fill-color'] || this.defaultFillColor,
            fillOpacity: props['fill-opacity'] ?? this.defaultFillOpacity,
            strokeColor: props.stroke || props['stroke-color'] || this.defaultStrokeColor,
            strokeWidth: props['stroke-width'] ?? this.defaultStrokeWidth,
            strokeOpacity: props['stroke-opacity'] ?? this.defaultStrokeOpacity,
            altitudeMode: props.altitudeMode || this.defaultPolygonAltitudeMode,
            altitudeOffset: props.altitudeOffset ?? this.defaultPolygonAltitudeOffset,
            depthTest: props.depthTest ?? this.defaultPolygonDepthTest,
            depthWrite: props.depthWrite ?? this.defaultPolygonDepthWrite,
            minZoom: props.minZoom ?? this.defaultPolygonMinZoom,
            maxZoom: props.maxZoom ?? this.defaultPolygonMaxZoom,
            extruded: props.extruded ?? this.defaultPolygonExtruded,
            height: props.height ?? this.defaultPolygonHeight,
            minHeight: props.minHeight ?? this.defaultPolygonMinHeight
        };
    }

    /** @private */
    _defaultPolygon3DOptions(feature, props) {
        return {
            modelUrl: props.modelUrl || this.defaultPolygon3DModelUrl,
            fit: props.fit || this.defaultPolygon3DFit,
            rotate: props.rotate ?? this.defaultPolygon3DRotate,
            primitiveType: props.primitiveType || this.defaultPolygon3DPrimitiveType,
            size: this._parseSize(props.size) || this.defaultPolygon3DSize,
            anchor: this._parseTriple(props.anchor) || this.defaultPolygon3DAnchor,
            altitude: props.altitude ?? this.defaultPolygon3DAltitude,
            altitudeMode: props.altitudeMode || this.defaultPolygon3DAltitudeMode,
            color: props.color,
            depthTest: props.depthTest ?? this.defaultPolygon3DDepthTest,
            depthWrite: props.depthWrite ?? this.defaultPolygon3DDepthWrite,
            minZoom: props.minZoom,
            maxZoom: props.maxZoom,
            title: props.title || props.name,
            titlePlacement: props.titlePlacement,
            titleAlign: props.titleAlign,
            titleOffset: this._parsePair(props.titleOffset),
            titleStyle: props.titleStyle,
            titleMinZoom: props.titleMinZoom,
            titleMaxZoom: props.titleMaxZoom,
            tooltip: props.tooltip || props.description,
            onHover: props.onHover,
            onClick: props.onClick
        };
    }

    /** @private */
    _parseSize(raw) {
        if (!raw) return null;
        if (Array.isArray(raw)) return raw;
        if (typeof raw === 'string') {
            const parts = raw.split(',').map(Number);
            if (parts.length === 2 && parts.every(v => !isNaN(v))) return parts;
        }
        return null;
    }

    /** @private */
    _parsePair(raw) {
        if (!raw) return null;
        if (Array.isArray(raw)) return raw;
        if (typeof raw === 'string') {
            const parts = raw.split(',').map(Number);
            if (parts.length === 2 && parts.every(v => !isNaN(v))) return parts;
        }
        return null;
    }

    /** @private */
    _parseAnchor(raw) {
        if (!raw) return null;
        if (Array.isArray(raw)) return raw;
        if (typeof raw === 'string') {
            const parts = raw.split(',').map(Number);
            if (parts.length === 2 && parts.every(v => !isNaN(v))) return parts;
        }
        return null;
    }

    /** @private */
    _parseTriple(raw) {
        if (!raw) return null;
        if (Array.isArray(raw)) return raw;
        if (typeof raw === 'string') {
            const parts = raw.split(',').map(Number);
            if (parts.length === 3 && parts.every(v => !isNaN(v))) return parts;
        }
        return null;
    }
}