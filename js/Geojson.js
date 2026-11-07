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
 *   - коллбэк может возвращать как канонические ключи (`fillColor`,
 *     `strokeWidth`, `color`, …), так и CSS-подобные алиасы (`fill`,
 *     `stroke`, `stroke-width`, `icon`, `model`, …) — алиасы нормализуются
 *     в канонические до слияния с дефолтами;
 *   - декларативный `style` (см. {@link StyleConfig}) позволяет описать
 *     тематическую карту без коллбэков: `by: 'category'`, `cases: {...}`,
 *     `default: {...}`, плюс per-type override (`style.polygon`, `style.line`, …);
 *   - `[lon, lat, alt]` для Point нормализуется до `[lon, lat]` + `altitude`;
 *   - дефолты `altitudeMode` для линий/полигонов — `'absolute'`, а не `'ground'`
 *     (последнее для `Polyline`/`Polygon` невалидно).
 *
 * @module Geojson
 */
import { Layer } from './Layers.js';
import { Marker, } from './Marker.js';
import { Marker3D, } from './Marker3D.js';
import { Area3D, } from './Area3D.js';
import { Polyline, } from './Polyline.js';
import { Polygon, } from './Polygon.js';
import { Vector3D, } from './Vector3D.js';
const POINT_ALIASES = {
    'icon': 'iconUrl',
};
const MARKER3D_ALIASES = {
    'model': 'modelUrl',
};
const LINE_ALIASES = {
    'stroke': 'color',
    'stroke-color': 'color',
    'stroke-width': 'width',
    'stroke-opacity': 'opacity',
};
const POLYGON_ALIASES = {
    'fill': 'fillColor',
    'fill-color': 'fillColor',
    'fill-opacity': 'fillOpacity',
    'stroke': 'strokeColor',
    'stroke-color': 'strokeColor',
    'stroke-width': 'strokeWidth',
    'stroke-opacity': 'strokeOpacity',
};
const AREA3D_ALIASES = {
    'model': 'modelUrl',
};
const VECTOR_ALIASES = {
    'stroke': 'color',
    'stroke-color': 'color',
    'stroke-width': 'width',
    'stroke-opacity': 'opacity',
};
/**
 * Канонические ключи `*Options`, значения которых должны быть числами.
 * Если пользователь передал строку через alias — прогоняем через `_asNumber`.
 */
const NUMERIC_OPTION_KEYS = new Set([
    'fillOpacity',
    'strokeOpacity',
    'strokeWidth',
    'width',
    'opacity',
    'arrowSize',
]);
// =====================================================================
// GeoJSONLayer
// =====================================================================
/**
 * Слой, создающий маркеры, линии, полигоны и векторные объекты из GeoJSON.
 *
 * Стилизация поддерживает два подхода, которые можно комбинировать:
 *
 *   1. **Декларативный `style`** — тематическая карта без коллбэков:
 *      классификация по одному полю (`style.by`), fallback (`style.default`),
 *      per-type override (`style.polygon`, `style.line`, …).
 *   2. **Коллбэки `*ToOptions`** — escape hatch для нетривиальной логики.
 *      Мержатся поверх `style`; `style` — поверх дефолтов.
 *
 * И ключи `style`, и результаты коллбэков принимают как канонические
 * имена `*Options` (`fillColor`, `strokeWidth`, `iconUrl`, `modelUrl`, …),
 * так и CSS-подобные алиасы (`fill`, `stroke`, `stroke-width`, `icon`,
 * `model`, …). Канонический ключ приоритетнее alias.
 *
 * Порядок merge для каждого объекта:
 *   `defaults → style → callback → enforced (rings/positions/position)`.
 *
 * @example Декларативный style: тематическая карта по одному полю
 * const layer = new GeoJSONLayer({
 *     data,
 *     titleField: 'name',
 *     style: {
 *         by: 'category',
 *         cases: {
 *             residential: { fill: '#4a90e2', stroke: '#1c5fad' },
 *             industrial:  { fill: '#f5a623', stroke: '#a86a10' },
 *             park:        { fill: '#7ed321', stroke: '#3d8b00' },
 *         },
 *         default: { fill: '#cccccc', stroke: '#666666' },
 *         line:  { default: { stroke: '#ff6600', 'stroke-width': 4 } },
 *         point: { default: { icon: 'pin.png', iconSize: [32, 32] } },
 *     },
 * }).addTo(map);
 *
 * @example Callback как escape hatch (мержится поверх style)
 * new GeoJSONLayer({
 *     data,
 *     style: { by: 'category', cases: { park: { fill: '#7ed321' } } },
 *     polygonToOptions: (f, p) => p.highlight ? { strokeWidth: 4 } : null,
 * });
 *
 * @example Только коллбэки (старый API, работает как раньше)
 * new GeoJSONLayer({
 *     data,
 *     polygonToOptions: (f, p) => ({ title: p.name, fill: '#ff0000' }),
 * });
 */
export class GeoJSONLayer extends Layer {
    // ── Данные ──
    url = null;
    data = null;
    crs = null;
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
    featureFilter = null;
    onEachFeature = null;
    // ── Декларативный стиль ──
    style = null;
    titleField = null;
    tooltipField = null;
    // ── Коллбэки ──
    pointToOptions = null;
    point3DToOptions = null;
    lineToOptions = null;
    polygonToOptions = null;
    polygon3DToOptions = null;
    vectorToOptions = null;
    // ── Дефолты: Marker ──
    defaultIconUrl = 'marker.png';
    defaultIconSize = [16, 16];
    defaultAnchor = [0.5, 1.0];
    // ── Дефолты: Marker3D ──
    default3DPrimitiveType = 'box';
    default3DSize = [100, 100, 100];
    default3DAnchor = [0.5, 0, 0.5];
    default3DAltitude = 0;
    default3DAltitudeMode = 'clampToGround';
    // ── Дефолты: Polyline ──
    defaultLineColor = '#3388ff';
    defaultLineWidth = 2;
    defaultLineOpacity = 1;
    defaultLineAltitudeMode = 'absolute';
    defaultLineAltitude = 10;
    defaultLineDepthTest = false;
    defaultLineDepthWrite = false;
    defaultLineMinZoom = -Infinity;
    defaultLineMaxZoom = Infinity;
    // ── Дефолты: Polygon ──
    defaultFillColor = '#3388ff';
    defaultFillOpacity = 0.5;
    defaultStrokeColor = '#000000';
    defaultStrokeWidth = 2;
    defaultStrokeOpacity = 1;
    defaultPolygonAltitudeMode = 'absolute';
    defaultPolygonAltitude = 10;
    defaultPolygonDepthTest = false;
    defaultPolygonDepthWrite = false;
    defaultPolygonMinZoom = -Infinity;
    defaultPolygonMaxZoom = Infinity;
    defaultPolygonExtruded = false;
    defaultPolygonHeight = 0;
    defaultPolygonMinHeight = 0;
    // ── Дефолты: Area3D ──
    defaultPolygon3DPrimitiveType = 'box';
    defaultPolygon3DSize = null;
    defaultPolygon3DAnchor = [0.5, 0, 0.5];
    defaultPolygon3DAltitude = 0;
    defaultPolygon3DAltitudeMode = 'clampToGround';
    defaultPolygon3DFit = 'stretch';
    defaultPolygon3DRotate = 0;
    defaultPolygon3DModelUrl = null;
    defaultPolygon3DDepthTest = true;
    defaultPolygon3DDepthWrite = true;
    _loaded = false;
    constructor(options = {}) {
        super();
        this.url = options.url ?? null;
        this.data = options.data ?? null;
        this.crs = options.crs ?? null;
        this.featureFilter = options.featureFilter ?? options.filter ?? null;
        this.onEachFeature = options.onEachFeature ?? null;
        this.style = options.style ?? null;
        this.titleField = options.titleField ?? null;
        this.tooltipField = options.tooltipField ?? null;
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
    addTo(map) {
        super.addTo(map);
        if (!this._loaded)
            this._load();
        return this;
    }
    /** Полная перезагрузка: удаляет объекты, сбрасывает флаг, загружает заново. */
    reload() {
        const layer = this;
        const objects = layer._objects ?? [];
        for (const obj of [...objects])
            obj.remove();
        layer._objects = [];
        this._loaded = false;
        if (layer._map)
            this._load();
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
    setFeatureFilter(predicate) {
        this.featureFilter = predicate;
        if (this._map && this._loaded)
            this.reload();
        return this;
    }
    /**
     * Меняет декларативную таблицу стилей. При активной карте автоматически
     * перезагружает объекты, чтобы стили применились к уже созданным фичам.
     *
     * @example
     * layer.setStyle({
     *     by: 'category',
     *     cases: { school: { fill: '#ff0000' } },
     *     default: { fill: '#888888' },
     * });
     * layer.setStyle(null);   // снять декларативный стиль
     */
    setStyle(style) {
        this.style = style;
        if (this._map && this._loaded)
            this.reload();
        return this;
    }
    /**
     * Заменяет данные слоя. При активной карте автоматически перезагружает
     * объекты. Передайте `null`, чтобы очистить слой.
     *
     * @example
     * const layer = new GeoJSONLayer({ url: 'routes.geojson' }).addTo(map);
     * layer.setData(newRoute);          // заменил маршрут
     * layer.setData(null);              // очистил
     */
    setData(data) {
        this.data = data;
        if (this._map) {
            this.reload();
        }
        else {
            this._loaded = false;
        }
        return this;
    }
    setUrl(url) {
        this.url = url;
        if (this._map) {
            this.reload();
        }
        else {
            this._loaded = false;
        }
        return this;
    }
    /**
     * Добавляет новые GeoJSON-объекты к уже загруженным, не удаляя существующие.
     * Полезно для инкрементального обновления (трек, лог событий и т.п.).
     */
    addData(data) {
        this._parse(data);
        return this;
    }
    async _load() {
        let geojson = null;
        try {
            if (this.data) {
                geojson = this.data;
            }
            else if (this.url) {
                const resp = await fetch(this.url);
                if (!resp.ok)
                    throw new Error(`HTTP ${resp.status}`);
                geojson = await resp.json();
            }
            if (!geojson) {
                console.warn('GeoJSONLayer: no data or URL provided');
                return;
            }
            this._parse(geojson);
            this._loaded = true;
        }
        catch (err) {
            console.error('GeoJSONLayer: load/parse error', err);
        }
    }
    // =================================================================
    // Style resolution
    // =================================================================
    /** Заголовок: `props[titleField]` (если задан) иначе `props.title` / `props.name`. */
    _getTitle(props) {
        if (this.titleField) {
            const v = props[this.titleField];
            if (v != null && v !== '')
                return String(v);
        }
        return props.title || props.name || '';
    }
    /** Тултип: `props[tooltipField]` (если задан) иначе `props.tooltip` / `props.description`. */
    _getTooltip(props) {
        if (this.tooltipField) {
            const v = props[this.tooltipField];
            if (v != null && v !== '')
                return String(v);
        }
        return props.tooltip || props.description || '';
    }
    /**
     * Находит стиль для feature: shared (`style.cases[value]` / `style.default`)
     * мержится с per-type (`style[type].cases[value]` / `style[type].default`),
     * per-type перекрывает shared. Возвращает `null`, если стиля нет.
     */
    _resolveStyle(props, type) {
        const style = this.style;
        if (!style)
            return null;
        const by = style.by ?? 'category';
        const value = props[by];
        const shared = this._pickStyleLevel(style, value);
        const perType = this._pickStyleLevel(style[type], value);
        if (!shared && !perType)
            return null;
        if (!shared)
            return perType;
        if (!perType)
            return shared;
        return { ...shared, ...perType };
    }
    _pickStyleLevel(cfg, value) {
        if (!cfg)
            return null;
        if (value != null && cfg.cases) {
            const c = cfg.cases[value];
            if (c)
                return c;
        }
        return cfg.default ?? null;
    }
    /**
     * Приводит результат коллбэка или style-правила к каноническим
     * ключам `*Options`:
     *   - alias (`fill`, `stroke`, `stroke-width`, `icon`, `model`, …)
     *     копируется в канонический ключ, если тот не задан явно;
     *   - alias удаляется из результата, чтобы не улетал в конструктор;
     *   - числовые канонические ключи (`width`, `opacity`, `fillOpacity`, …)
     *     прогоняются через `_asNumber` (строки `"2"` → `2`);
     *   - если alias == null — он не используется (срабатывает дефолт).
     *
     * Канонический ключ имеет приоритет над alias.
     */
    _normalizeStyle(src, aliases) {
        if (!src)
            return null;
        const out = { ...src };
        for (const [alias, canonical] of Object.entries(aliases)) {
            if (out[canonical] === undefined && out[alias] != null) {
                if (NUMERIC_OPTION_KEYS.has(canonical)) {
                    const num = this._asNumber(out[alias]);
                    if (num !== undefined)
                        out[canonical] = num;
                }
                else {
                    out[canonical] = out[alias];
                }
            }
            delete out[alias];
        }
        return out;
    }
    // =================================================================
    // Dispatch
    // =================================================================
    _parse(geojson) {
        const type = geojson.type;
        if (type === 'FeatureCollection') {
            for (const feature of geojson.features) {
                this._addFeature(feature);
            }
        }
        else if (type === 'Feature') {
            this._addFeature(geojson);
        }
        else if (type === 'Point' || type === 'LineString' || type === 'MultiLineString'
            || type === 'Polygon' || type === 'MultiPolygon') {
            this._addFeature({
                type: 'Feature',
                geometry: geojson,
                properties: {},
            });
        }
        else {
            console.debug(`GeoJSONLayer: type "${type}" not supported`);
        }
    }
    _addFeature(feature) {
        const props = feature.properties ?? {};
        if (this.featureFilter && !this.featureFilter(feature))
            return;
        const geom = feature.geometry;
        if (!geom)
            return;
        switch (geom.type) {
            case 'Point':
                // Для точки нужен явный флаг vector === true — иначе Marker/Marker3D.
                if (this.vectorToOptions && props.vector === true) {
                    this._addVectorFeature(feature);
                }
                else {
                    this._addPointFeature(feature);
                }
                break;
            case 'LineString':
            case 'MultiLineString':
                // Наличие vectorToOptions — сигнал, что автор слоя хочет вектор.
                if (this.vectorToOptions || props.vector === true) {
                    this._addVectorFeature(feature);
                }
                else {
                    this._addLineFeature(feature);
                }
                break;
            case 'Polygon':
            case 'MultiPolygon':
                this._addPolygonFeature(feature);
                break;
            default:
                console.debug(`GeoJSONLayer: type "${geom.type}" not supported`);
        }
    }
    // =================================================================
    // Points
    // =================================================================
    _addPointFeature(feature) {
        const geom = feature.geometry;
        if (geom.type !== 'Point')
            return;
        const props = feature.properties ?? {};
        const coords = geom.coordinates;
        const lonLat = [coords[0], coords[1]];
        const altFromCoords = coords.length >= 3 ? coords[2] : undefined;
        // Коллбэк 3D вызываем РОВНО ОДИН РАЗ.
        const cb3D = this.point3DToOptions ? this.point3DToOptions(feature, props) : null;
        const is3D = cb3D != null
            || props['3d'] === true
            || props.type === '3d'
            || props.markerType === '3d';
        if (is3D) {
            this._createMarker3D(feature, props, lonLat, altFromCoords, cb3D);
        }
        else {
            const cb = this.pointToOptions ? this.pointToOptions(feature, props) : null;
            this._createMarker(feature, props, lonLat, altFromCoords, cb);
        }
    }
    _createMarker(feature, props, lonLat, altFromCoords, cb) {
        const defaults = {
            position: lonLat,
            crs: this.crs ?? undefined,
            title: this._getTitle(props),
            tooltip: this._getTooltip(props),
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
        const normStyle = this._normalizeStyle(this._resolveStyle(props, 'point'), POINT_ALIASES);
        const normCb = this._normalizeStyle(cb, POINT_ALIASES);
        const merged = {
            ...defaults,
            ...(normStyle ?? {}),
            ...(normCb ?? {}),
            position: lonLat,
        };
        const marker = new Marker(merged);
        this.add(marker);
        if (this.onEachFeature)
            this.onEachFeature(feature, marker);
    }
    _createMarker3D(feature, props, lonLat, altFromCoords, cb) {
        const defaults = {
            position: lonLat,
            crs: this.crs ?? undefined,
            title: this._getTitle(props),
            tooltip: this._getTooltip(props),
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
        const normStyle = this._normalizeStyle(this._resolveStyle(props, 'marker3D'), MARKER3D_ALIASES);
        const normCb = this._normalizeStyle(cb, MARKER3D_ALIASES);
        const merged = {
            ...defaults,
            ...(normStyle ?? {}),
            ...(normCb ?? {}),
            position: lonLat,
        };
        const marker = new Marker3D(merged);
        this.add(marker);
        if (this.onEachFeature)
            this.onEachFeature(feature, marker);
    }
    // =================================================================
    // Lines
    // =================================================================
    _addLineFeature(feature) {
        const geom = feature.geometry;
        if (geom.type !== 'LineString' && geom.type !== 'MultiLineString')
            return;
        const props = feature.properties ?? {};
        const coordSets = geom.type === 'LineString' ? [geom.coordinates] : geom.coordinates;
        for (const coords of coordSets) {
            if (coords.length < 2)
                continue;
            const cb = this.lineToOptions ? this.lineToOptions(feature, props) : null;
            const defaults = {
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
            const normStyle = this._normalizeStyle(this._resolveStyle(props, 'line'), LINE_ALIASES);
            const normCb = this._normalizeStyle(cb, LINE_ALIASES);
            const merged = {
                ...defaults,
                ...(normStyle ?? {}),
                ...(normCb ?? {}),
                positions: coords,
            };
            const polyline = new Polyline(merged);
            this.add(polyline);
            if (this.onEachFeature)
                this.onEachFeature(feature, polyline);
        }
    }
    // =================================================================
    // Polygons
    // =================================================================
    _addPolygonFeature(feature) {
        const geom = feature.geometry;
        if (geom.type !== 'Polygon' && geom.type !== 'MultiPolygon')
            return;
        const props = feature.properties ?? {};
        const ringSets = geom.type === 'Polygon' ? [geom.coordinates] : geom.coordinates;
        for (const rings of ringSets) {
            if (!rings.length || !rings[0].length)
                continue;
            // Коллбэк 3D вызываем РОВНО ОДИН РАЗ.
            const cb3D = this.polygon3DToOptions ? this.polygon3DToOptions(feature, props) : null;
            const is3D = cb3D != null
                || props['3d'] === true
                || props.type === '3d'
                || props.markerType === '3d';
            if (is3D) {
                this._createArea3D(feature, props, rings, cb3D);
            }
            else {
                const cb = this.polygonToOptions ? this.polygonToOptions(feature, props) : null;
                this._createPolygon(feature, props, rings, cb);
            }
        }
    }
    _createPolygon(feature, props, rings, cb) {
        const defaults = {
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
            title: this._getTitle(props),
            titleOffset: this._parsePair(props.titleOffset) ?? undefined,
            titleAlign: props.titleAlign,
            titleStyle: props.titleStyle,
            titleMinZoom: this._asNumber(props.titleMinZoom),
            titleMaxZoom: this._asNumber(props.titleMaxZoom),
            titleAllowOverflow: props.titleAllowOverflow,
            titlePriority: this._asNumber(props.titlePriority),
            tooltip: this._getTooltip(props),
        };
        const normStyle = this._normalizeStyle(this._resolveStyle(props, 'polygon'), POLYGON_ALIASES);
        const normCb = this._normalizeStyle(cb, POLYGON_ALIASES);
        const merged = {
            ...defaults,
            ...(normStyle ?? {}),
            ...(normCb ?? {}),
            rings,
        };
        const polygon = new Polygon(merged);
        this.add(polygon);
        if (this.onEachFeature)
            this.onEachFeature(feature, polygon);
    }
    _createArea3D(feature, props, rings, cb) {
        const defaults = {
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
        const normStyle = this._normalizeStyle(this._resolveStyle(props, 'area3D'), AREA3D_ALIASES);
        const normCb = this._normalizeStyle(cb, AREA3D_ALIASES);
        const merged = {
            ...defaults,
            ...(normStyle ?? {}),
            ...(normCb ?? {}),
            rings,
        };
        const area = new Area3D(merged);
        this.add(area);
        if (this.onEachFeature)
            this.onEachFeature(feature, area);
    }
    // =================================================================
    // Vector3D
    // =================================================================
    _addVectorFeature(feature) {
        const geom = feature.geometry;
        const props = feature.properties ?? {};
        // Наборы координат по умолчанию. Для Point — null (позиции
        // должен задать vectorToOptions).
        let coordSets;
        if (geom.type === 'LineString')
            coordSets = [geom.coordinates];
        else if (geom.type === 'MultiLineString')
            coordSets = geom.coordinates;
        else
            coordSets = [null];
        for (const coords of coordSets) {
            const cb = this.vectorToOptions ? this.vectorToOptions(feature, props) : null;
            const defaultPositions = coords ? this._toVectorPositions(coords) : undefined;
            const positions = cb?.positions ?? defaultPositions;
            if (!positions || positions.length < 2)
                continue;
            const defaults = {
                positions,
                crs: this.crs ?? undefined,
                title: this._getTitle(props),
                titleStyle: props.titleStyle,
                titleOffset: this._parsePair(props.titleOffset) ?? undefined,
                titleAlign: props.titleAlign,
                titleVerticalAlign: props.titleVerticalAlign,
                titleMinZoom: this._asNumber(props.titleMinZoom),
                titleMaxZoom: this._asNumber(props.titleMaxZoom),
                titlePlacement: props.titlePlacement || 'start',
                tooltip: this._getTooltip(props),
                minZoom: this._asNumber(props.minZoom),
                maxZoom: this._asNumber(props.maxZoom),
                color: props.stroke || props.color || '#3388ff',
                width: this._asNumber(props.width) ?? 2,
                arrowSize: this._asNumber(props.arrowSize) ?? 10,
                opacity: this._asNumber(props['stroke-opacity'] ?? props.opacity) ?? 1,
            };
            const normStyle = this._normalizeStyle(this._resolveStyle(props, 'vector'), VECTOR_ALIASES);
            const normCb = this._normalizeStyle(cb, VECTOR_ALIASES);
            const merged = {
                ...defaults,
                ...(normStyle ?? {}),
                ...(normCb ?? {}),
                positions,
            };
            const vector = new Vector3D(merged);
            this.add(vector);
            if (this.onEachFeature)
                this.onEachFeature(feature, vector);
        }
    }
    // =================================================================
    // Внутренние парсеры / утилиты
    // =================================================================
    /** Pad 2D → `[lon, lat, 0]` для `Vector3D`. */
    _toVectorPositions(coords) {
        return coords.map(c => [c[0], c[1], c[2] ?? 0]);
    }
    /** `[w, h] | [w, h, d] | number` или строка `"w,h"` → `number[]`. */
    _parseSize(raw) {
        if (!raw)
            return null;
        if (Array.isArray(raw))
            return raw;
        if (typeof raw === 'string') {
            const parts = raw.split(',').map(Number);
            if (parts.length >= 1 && parts.length <= 3 && parts.every(v => !isNaN(v))) {
                return parts;
            }
        }
        return null;
    }
    /** Строго 2-элементный размер (для `IconSize`). */
    _parseIconSize(raw) {
        const arr = this._parseSize(raw);
        if (!arr || arr.length !== 2)
            return null;
        return [arr[0], arr[1]];
    }
    /** Строго 1..3-элементный размер (для `SizeSpec` в 3D-объектах). */
    _parseSizeSpec(raw) {
        const arr = this._parseSize(raw);
        if (!arr || arr.length < 1 || arr.length > 3)
            return null;
        return arr;
    }
    /** 2-элементный массив из `[a, b]` или строки `"a,b"`. */
    _parsePair(raw) {
        if (!raw)
            return null;
        if (Array.isArray(raw) && raw.length === 2) {
            const [a, b] = raw;
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
    _parseTriple(raw) {
        if (!raw)
            return null;
        if (Array.isArray(raw) && raw.length === 3) {
            const [a, b, c] = raw;
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
    _asNumber(v) {
        if (typeof v === 'number' && isFinite(v))
            return v;
        if (typeof v === 'string' && v.trim() !== '') {
            const n = Number(v);
            if (isFinite(n))
                return n;
        }
        return undefined;
    }
}
