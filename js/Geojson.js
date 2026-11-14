/**
 * Geojson.ts — класс GeoJSONLayer. Типы, константы, фильтры, парсеры
 * и стилевые хелперы вынесены в GeojsonUtils.ts (реэкспортируются ниже
 * для обратной совместимости).
 */
import { Layer } from './Layers.js';
import { getAutoCoins, resolveDiagramUnitPx, MIN_COIN_DIAMETER_PX } from './DiagramTypes.js';
import { calculateBreaks, makeBreaksPretty } from './Classification.js';
import { resolveColorRamp, invertColorRamp } from './ColorRamps.js';
import { buildDiagramLegend, buildChoroplethLegend, buildDiagram3DLegend, } from './Legend.js';
import { compileExpressionFilter, compileObjectFilter, mapboxToJsExpr, resolveColorMapValue, resolveStyle, normalizeStyle, interpolateStyle, evaluateValueExpression, getTitle, getTooltip, parseIconSize, parseSizeSpec, parsePair, parseTriple, asNumber, } from './GeojsonUtils.js';
import { PointsMixin } from './GeojsonPoints.js';
import { ShapesMixin } from './GeojsonShapes.js';
import { VectorsMixin } from './GeojsonVectors.js';
// Реэкспорт типов/констант/хелперов — сохраняет все текущие импорты.
export * from './GeojsonUtils.js';
// =====================================================================
// GeoJSONLayer
// =====================================================================
export class GeoJSONLayer extends Layer {
    url = null;
    data = null;
    crs = null;
    tooltipOnHover = false;
    legend = null;
    choropleth = null;
    _choroplethBreaks = [];
    _choroplethRamp = null;
    diagram3D = null;
    diagram3DToOptions = null;
    onEachDiagram3D = null;
    _diagram3DAuto = null;
    _diagramAuto = null;
    _diagramCoins = null;
    featureFilter = null;
    filterSpec = null;
    filterExpression = null;
    onEachFeature = null;
    style = null;
    titleField = null;
    pointToOptions = null;
    point3DToOptions = null;
    lineToOptions = null;
    polygonToOptions = null;
    polygon3DToOptions = null;
    vectorToOptions = null;
    legendToOptions = null;
    tooltip = null;
    /** @deprecated Используйте `tooltip: '{fieldName}'`. */
    tooltipField = null;
    diagram = null;
    diagramToOptions = null;
    onEachDiagram = null;
    defaultIconUrl = 'marker.png';
    defaultIconSize = [16, 16];
    defaultAnchor = [0.5, 1.0];
    default3DPrimitiveType = 'box';
    default3DSize = [100, 100, 100];
    default3DAnchor = [0.5, 0, 0.5];
    default3DAltitude = 0;
    default3DAltitudeMode = 'clampToGround';
    defaultLineColor = '#3388ff';
    defaultLineWidth = 2;
    defaultLineOpacity = 1;
    defaultLineAltitudeMode = 'absolute';
    defaultLineAltitude = 10;
    defaultLineDepthTest = false;
    defaultLineDepthWrite = false;
    defaultLineMinZoom = -Infinity;
    defaultLineMaxZoom = Infinity;
    defaultVectorColor = '#3388ff';
    defaultVectorWidth = 2;
    defaultVectorOpacity = 1;
    defaultVectorArrowSize = 10;
    defaultVectorArrowSizeMode = 'px';
    defaultVectorHeightScale = 1;
    defaultVectorAltitude = 0;
    defaultVectorAltitudeMode = 'absolute';
    defaultVectorDepthTest = false;
    defaultVectorDepthWrite = false;
    defaultVectorMinZoom = -Infinity;
    defaultVectorMaxZoom = Infinity;
    defaultVectorSimplify = true;
    defaultVectorSimplifyTolerance = 0.5;
    defaultVectorSimplifyZoomBucket = 1;
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
    static fromMapboxFilter(arr) { return mapboxToJsExpr(arr); }
    constructor(o = {}) {
        super();
        this.diagram = o.diagram ?? null;
        this.diagramToOptions = o.diagramToOptions ?? null;
        this.onEachDiagram = o.onEachDiagram ?? null;
        this.diagram3D = o.diagram3D ?? null;
        this.diagram3DToOptions = o.diagram3DToOptions ?? null;
        this.onEachDiagram3D = o.onEachDiagram3D ?? null;
        this.choropleth = o.choropleth ?? null;
        this.url = o.url ?? null;
        this.data = o.data ?? null;
        this.crs = o.crs ?? null;
        this.onEachFeature = o.onEachFeature ?? null;
        this.tooltipOnHover = o.tooltipOnHover ?? false;
        this._applyFilter(o.featureFilter ?? o.filter ?? null);
        this.style = o.style ?? null;
        this.titleField = o.titleField ?? null;
        this.pointToOptions = o.pointToOptions ?? null;
        this.point3DToOptions = o.point3DToOptions ?? null;
        this.lineToOptions = o.lineToOptions ?? null;
        this.polygonToOptions = o.polygonToOptions ?? null;
        this.polygon3DToOptions = o.polygon3DToOptions ?? null;
        this.vectorToOptions = o.vectorToOptions ?? null;
        this.tooltip = o.tooltip ?? null;
        this.tooltipField = o.tooltipField ?? null;
        this.defaultIconUrl = o.defaultIconUrl ?? 'marker.png';
        this.defaultIconSize = o.defaultIconSize ?? [16, 16];
        this.defaultAnchor = o.defaultAnchor ?? [0.5, 1.0];
        this.default3DPrimitiveType = o.default3DPrimitiveType ?? 'box';
        this.default3DSize = o.default3DSize ?? [100, 100, 100];
        this.default3DAnchor = o.default3DAnchor ?? [0.5, 0, 0.5];
        this.default3DAltitude = o.default3DAltitude ?? 0;
        this.default3DAltitudeMode = o.default3DAltitudeMode ?? 'clampToGround';
        this.defaultLineColor = o.defaultLineColor ?? '#3388ff';
        this.defaultLineWidth = o.defaultLineWidth ?? 2;
        this.defaultLineOpacity = o.defaultLineOpacity ?? 1;
        this.defaultLineAltitudeMode = o.defaultLineAltitudeMode ?? 'absolute';
        this.defaultLineAltitude = o.defaultLineAltitude ?? o.defaultLineAltitudeOffset ?? 10;
        this.defaultLineDepthTest = o.defaultLineDepthTest ?? false;
        this.defaultLineDepthWrite = o.defaultLineDepthWrite ?? false;
        this.defaultLineMinZoom = o.defaultLineMinZoom ?? -Infinity;
        this.defaultLineMaxZoom = o.defaultLineMaxZoom ?? Infinity;
        this.defaultVectorColor = o.defaultVectorColor ?? '#3388ff';
        this.defaultVectorWidth = o.defaultVectorWidth ?? 2;
        this.defaultVectorOpacity = o.defaultVectorOpacity ?? 1;
        this.defaultVectorArrowSize = o.defaultVectorArrowSize ?? 10;
        this.defaultVectorArrowSizeMode = o.defaultVectorArrowSizeMode ?? 'px';
        this.defaultVectorHeightScale = o.defaultVectorHeightScale ?? 1;
        this.defaultVectorAltitude = o.defaultVectorAltitude ?? 0;
        this.defaultVectorAltitudeMode = o.defaultVectorAltitudeMode ?? 'absolute';
        this.defaultVectorDepthTest = o.defaultVectorDepthTest ?? false;
        this.defaultVectorDepthWrite = o.defaultVectorDepthWrite ?? false;
        this.defaultVectorMinZoom = o.defaultVectorMinZoom ?? -Infinity;
        this.defaultVectorMaxZoom = o.defaultVectorMaxZoom ?? Infinity;
        this.defaultVectorSimplify = o.defaultVectorSimplify ?? true;
        this.defaultVectorSimplifyTolerance = o.defaultVectorSimplifyTolerance ?? 0.5;
        this.defaultVectorSimplifyZoomBucket = o.defaultVectorSimplifyZoomBucket ?? 1;
        this.defaultFillColor = o.defaultFillColor ?? '#3388ff';
        this.defaultFillOpacity = o.defaultFillOpacity ?? 0.5;
        this.defaultStrokeColor = o.defaultStrokeColor ?? '#000000';
        this.defaultStrokeWidth = o.defaultStrokeWidth ?? 2;
        this.defaultStrokeOpacity = o.defaultStrokeOpacity ?? 1;
        this.defaultPolygonAltitudeMode = o.defaultPolygonAltitudeMode ?? 'absolute';
        this.defaultPolygonAltitude = o.defaultPolygonAltitude ?? o.defaultPolygonAltitudeOffset ?? 10;
        this.defaultPolygonDepthTest = o.defaultPolygonDepthTest ?? false;
        this.defaultPolygonDepthWrite = o.defaultPolygonDepthWrite ?? false;
        this.defaultPolygonMinZoom = o.defaultPolygonMinZoom ?? -Infinity;
        this.defaultPolygonMaxZoom = o.defaultPolygonMaxZoom ?? Infinity;
        this.defaultPolygonExtruded = o.defaultPolygonExtruded ?? false;
        this.defaultPolygonHeight = o.defaultPolygonHeight ?? 0;
        this.defaultPolygonMinHeight = o.defaultPolygonMinHeight ?? 0;
        this.defaultPolygon3DPrimitiveType = o.defaultPolygon3DPrimitiveType ?? 'box';
        this.defaultPolygon3DSize = o.defaultPolygon3DSize ?? null;
        this.defaultPolygon3DAnchor = o.defaultPolygon3DAnchor ?? [0.5, 0, 0.5];
        this.defaultPolygon3DAltitude = o.defaultPolygon3DAltitude ?? 0;
        this.defaultPolygon3DAltitudeMode = o.defaultPolygon3DAltitudeMode ?? 'clampToGround';
        this.defaultPolygon3DFit = o.defaultPolygon3DFit ?? 'stretch';
        this.defaultPolygon3DRotate = o.defaultPolygon3DRotate ?? 0;
        this.defaultPolygon3DModelUrl = o.defaultPolygon3DModelUrl ?? null;
        this.defaultPolygon3DDepthTest = o.defaultPolygon3DDepthTest ?? true;
        this.defaultPolygon3DDepthWrite = o.defaultPolygon3DDepthWrite ?? true;
        this.legendToOptions = o.legendToOptions ?? null;
    }
    // ── lifecycle ───────────────────────────────────────────────────
    addTo(map) {
        super.addTo(map);
        if (!this._loaded)
            this._load();
        return this;
    }
    reload() {
        const self = this;
        for (const obj of [...(self._objects ?? [])])
            obj.remove();
        self._objects = [];
        if (this.legend) {
            try {
                this.legend.destroy();
            }
            catch { }
            this.legend = null;
        }
        this._loaded = false;
        if (self._map)
            this._load();
    }
    // ── setters ─────────────────────────────────────────────────────
    setData(data) {
        this.data = data;
        if (this._map)
            this.reload();
        else
            this._loaded = false;
        return this;
    }
    setUrl(url) {
        this.url = url;
        if (this._map)
            this.reload();
        else
            this._loaded = false;
        return this;
    }
    setStyle(style) {
        this.style = style;
        if (this._map && this._loaded)
            this.reload();
        return this;
    }
    setChoropleth(cfg) {
        this.choropleth = cfg;
        if (this._map && this._loaded)
            this.reload();
        return this;
    }
    setDiagram(cfg) {
        this.diagram = cfg;
        if (this._map && this._loaded)
            this.reload();
        return this;
    }
    setDiagram3D(cfg) {
        this.diagram3D = cfg;
        if (this._map && this._loaded)
            this.reload();
        return this;
    }
    getLegend() { return this.legend; }
    getDiagramCoins() { return this._diagramCoins; }
    setFeatureFilter(input) {
        this._applyFilter(input);
        if (this._map && this._loaded)
            this.reload();
        return this;
    }
    setFilter(input) { return this.setFeatureFilter(input); }
    getFilter() {
        if (this.filterExpression != null)
            return this.filterExpression;
        if (this.filterSpec != null)
            return this.filterSpec;
        return this.featureFilter;
    }
    addData(data) { this._parse(data); return this; }
    // ── filter ──────────────────────────────────────────────────────
    _applyFilter(input) {
        if (Array.isArray(input)) {
            try {
                input = GeoJSONLayer.fromMapboxFilter(input);
            }
            catch (err) {
                console.warn('GeoJSONLayer: cannot convert Mapbox filter.', err, input);
                this.featureFilter = this.filterSpec = this.filterExpression = null;
                return;
            }
        }
        if (!input) {
            this.featureFilter = this.filterSpec = this.filterExpression = null;
            return;
        }
        if (typeof input === 'function') {
            this.featureFilter = input;
            this.filterSpec = this.filterExpression = null;
            return;
        }
        if (typeof input === 'string') {
            const trimmed = input.trim();
            if (!trimmed) {
                this.featureFilter = this.filterSpec = this.filterExpression = null;
                return;
            }
            this.featureFilter = compileExpressionFilter(trimmed);
            this.filterSpec = null;
            this.filterExpression = trimmed;
            return;
        }
        const spec = input;
        if (!Object.keys(spec).length) {
            this.featureFilter = this.filterSpec = this.filterExpression = null;
            return;
        }
        this.featureFilter = compileObjectFilter(spec);
        this.filterSpec = spec;
        this.filterExpression = null;
    }
    // ── load ────────────────────────────────────────────────────────
    async _load() {
        let geojson = null;
        try {
            if (this.data)
                geojson = this.data;
            else if (this.url) {
                const resp = await fetch(this.url);
                if (!resp.ok)
                    throw new Error(`HTTP ${resp.status}`);
                geojson = await resp.json();
            }
            if (!geojson) {
                console.warn('GeoJSONLayer: no data or URL');
                return;
            }
            if (this.choropleth) {
                const baseRamp = resolveColorRamp(this.choropleth.colorRamp);
                this._choroplethRamp = this.choropleth.colorRampReverse ? invertColorRamp(baseRamp) : baseRamp;
                this._calculateChoroplethBreaks(geojson);
            }
            this._computeDiagram3DAuto(geojson);
            this._computeDiagramAuto(geojson);
            this._computeCoinDenoms(geojson);
            this._parse(geojson);
            this._buildLegend(geojson);
            this._loaded = true;
        }
        catch (err) {
            console.error('GeoJSONLayer: load/parse error', err);
        }
    }
    _buildLegend(geojson) {
        if (this.legend) {
            try {
                this.legend.destroy();
            }
            catch { }
            this.legend = null;
        }
        let kind = null;
        let cfg = null;
        let legendOpts;
        if (this.diagram?.legend) {
            kind = 'diagram';
            cfg = this.diagram;
            legendOpts = this.diagram.legend;
        }
        else if (this.diagram3D?.legend) {
            kind = 'diagram3D';
            cfg = this.diagram3D;
            legendOpts = this.diagram3D.legend;
        }
        else if (this.choropleth?.legend) {
            kind = 'choropleth';
            cfg = this.choropleth;
            legendOpts = this.choropleth.legend;
        }
        if (!kind || !legendOpts)
            return;
        if (this.legendToOptions) {
            try {
                const ctx = { layer: this, kind, cfg, geojson, base: legendOpts };
                const patch = this.legendToOptions(ctx);
                if (patch === null)
                    return;
                if (patch)
                    legendOpts = { ...legendOpts, ...patch };
            }
            catch (err) {
                console.warn('GeoJSONLayer: legendToOptions threw', err);
            }
        }
        try {
            const builder = kind === 'diagram'
                ? buildDiagramLegend(this, geojson, cfg, legendOpts)
                : kind === 'diagram3D'
                    ? buildDiagram3DLegend(this, geojson, cfg, legendOpts)
                    : buildChoroplethLegend(this, geojson, cfg, legendOpts);
            this.legend = builder;
            if (legendOpts.target)
                this.legend.mount(legendOpts.target);
            legendOpts.onReady?.(this.legend);
        }
        catch (err) {
            console.warn('GeoJSONLayer: legend build failed', err);
        }
    }
    // ── choropleth / autoscale ──────────────────────────────────────
    _calculateChoroplethBreaks(geojson) {
        if (!this.choropleth)
            return;
        const values = [];
        const visit = (f) => {
            if (!f.properties)
                return;
            const v = this._evaluateValueExpression(f.properties, this.choropleth.value);
            if (isFinite(v))
                values.push(v);
        };
        if (geojson.type === 'FeatureCollection')
            geojson.features.forEach(visit);
        else if (geojson.type === 'Feature')
            visit(geojson);
        this._choroplethBreaks = calculateBreaks(values, this.choropleth.classification ?? 'jenks', this.choropleth.classes ?? 5);
        if (this.choropleth.pretty && !Array.isArray(this.choropleth.classification)) {
            this._choroplethBreaks = makeBreaksPretty(this._choroplethBreaks);
        }
    }
    _computeDiagramAuto(geojson) {
        this._diagramAuto = null;
        const cfg = this.diagram;
        if (!cfg?.fields?.length || cfg.unitPx !== 'auto')
            return;
        let maxValue = 0;
        const scan = (f) => {
            if (this.featureFilter && !this.featureFilter(f))
                return;
            const p = f.properties ?? {};
            for (const k of cfg.fields) {
                const v = Number(p[k]);
                if (isFinite(v) && v > maxValue)
                    maxValue = v;
            }
        };
        if (geojson.type === 'FeatureCollection')
            geojson.features.forEach(scan);
        else if (geojson.type === 'Feature')
            scan(geojson);
        if (maxValue <= 0)
            return;
        this._diagramAuto = { unitPx: (cfg.maxHeightPx ?? 200) / maxValue };
    }
    /** Для `coin`: единый набор номиналов на слой — рендер и легенда совпадают. */
    _computeCoinDenoms(geojson) {
        this._diagramCoins = null;
        const cfg = this.diagram;
        if (!cfg || (cfg.type ?? 'bar') !== 'coin')
            return;
        if (cfg.coins && cfg.coins.length > 0) {
            this._diagramCoins = [...cfg.coins].sort((a, b) => b - a);
            return;
        }
        const allValues = [];
        const scan = (f) => {
            if (this.featureFilter && !this.featureFilter(f))
                return;
            const p = f.properties ?? {};
            if (p.diagram === false)
                return;
            for (const k of cfg.fields) {
                const v = Number(p[k]);
                if (isFinite(v) && v > 0)
                    allValues.push(v);
            }
        };
        if (geojson.type === 'FeatureCollection')
            geojson.features.forEach(scan);
        else if (geojson.type === 'Feature')
            scan(geojson);
        if (!allValues.length)
            return;
        const unitPx = resolveDiagramUnitPx('coin', cfg, this._diagramAuto?.unitPx);
        const minValue = unitPx > 0 ? (MIN_COIN_DIAMETER_PX / 2 / unitPx) ** 2 : Infinity;
        const candidates = getAutoCoins(Math.max(...allValues));
        const visible = candidates.filter(c => c >= minValue);
        if (!visible.length) {
            console.warn('GeoJSONLayer: all coin denominations below ' +
                `${MIN_COIN_DIAMETER_PX}px at unitPx=${unitPx}; keeping the largest.`);
            visible.push(candidates[0]);
        }
        const used = new Set();
        for (const v of allValues) {
            let rem = v;
            for (const c of visible)
                if (rem >= c) {
                    used.add(c);
                    rem %= c;
                }
        }
        const filtered = visible.filter(c => used.has(c));
        this._diagramCoins = filtered.length ? filtered : visible;
    }
    _computeDiagram3DAuto(geojson) {
        this._diagram3DAuto = null;
        const cfg = this.diagram3D;
        if (!cfg?.fields?.length)
            return;
        let maxValue = 0, maxBars = 1;
        const scan = (f) => {
            if (this.featureFilter && !this.featureFilter(f))
                return;
            const p = f.properties ?? {};
            let localMax = 0, cnt = 0;
            for (const k of cfg.fields) {
                const v = Number(p[k]);
                if (isFinite(v) && v > 0) {
                    if (v > localMax)
                        localMax = v;
                    cnt++;
                }
            }
            if (cnt === 0)
                return;
            if (localMax > maxValue)
                maxValue = localMax;
            if (cnt > maxBars)
                maxBars = cnt;
        };
        if (geojson.type === 'FeatureCollection')
            geojson.features.forEach(scan);
        else if (geojson.type === 'Feature')
            scan(geojson);
        if (maxValue <= 0)
            return;
        const unitM = cfg.unitM === 'auto'
            ? (cfg.maxHeightM ?? 1000) / maxValue
            : (typeof cfg.unitM === 'number' ? cfg.unitM : 1);
        let barWidthM = cfg.barWidthM ?? null;
        let barDepthM = cfg.barDepthM ?? null;
        if ((cfg.type ?? 'bar3d') === 'bar3d') {
            if (barWidthM != null && barDepthM == null)
                barDepthM = barWidthM;
            else if (barDepthM != null && barWidthM == null)
                barWidthM = barDepthM;
            else if (barWidthM == null && barDepthM == null) {
                const maxH = maxValue * unitM;
                const gap = cfg.gapM ?? 0;
                const targetW = maxH * 0.3;
                const derived = Math.max(maxH * 0.05, (targetW - gap * Math.max(0, maxBars - 1)) / maxBars);
                barWidthM = derived;
                barDepthM = derived;
            }
        }
        this._diagram3DAuto = { unitM, barWidthM: barWidthM ?? 0, barDepthM: barDepthM ?? 0 };
    }
    _withDiagram3DAuto(opts) {
        const out = { ...opts };
        const auto = this._diagram3DAuto;
        if (!auto)
            return out;
        if (out.unitM == null)
            out.unitM = auto.unitM;
        if ((out.type ?? 'bar3d') === 'bar3d') {
            if (out.barWidthM != null && out.barDepthM == null)
                out.barDepthM = out.barWidthM;
            else if (out.barDepthM != null && out.barWidthM == null)
                out.barWidthM = out.barDepthM;
            else if (out.barWidthM == null && out.barDepthM == null) {
                out.barWidthM = auto.barWidthM;
                out.barDepthM = auto.barDepthM;
            }
        }
        return out;
    }
    // ── style helpers (тонкие обёртки над GeojsonUtils) ─────────────
    _getTitle(props) { return getTitle(this.titleField, props); }
    _getTooltip(props) { return getTooltip(this.tooltip, this.tooltipField, props); }
    _evaluateValueExpression(props, exprOrFn) {
        return evaluateValueExpression(props, exprOrFn);
    }
    _resolveStyle(props, type) {
        return resolveStyle(this.style, props, type);
    }
    _normalizeStyle(src, aliases) { return normalizeStyle(src, aliases); }
    _interpolateStyle(style, props) {
        return interpolateStyle(style, props);
    }
    // ── dispatch ────────────────────────────────────────────────────
    _parse(geojson) {
        const type = geojson.type;
        if (type === 'FeatureCollection') {
            for (const f of geojson.features)
                this._addFeature(f);
        }
        else if (type === 'Feature') {
            this._addFeature(geojson);
        }
        else if (type === 'Point' || type === 'LineString' || type === 'MultiLineString'
            || type === 'Polygon' || type === 'MultiPolygon') {
            this._addFeature({ type: 'Feature', geometry: geojson, properties: {} });
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
                if (this.vectorToOptions && props.vector === true)
                    this._addVectorFeature(feature);
                else
                    this._addPointFeature(feature);
                break;
            case 'LineString':
            case 'MultiLineString':
                if (this.vectorToOptions || props.vector === true || this.style?.vector) {
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
    // ── diagram config → opts ───────────────────────────────────────
    _diagram3DFromConfig(_f, props) {
        const cfg = this.diagram3D;
        if (!cfg?.fields?.length)
            return null;
        const unitM = this._diagram3DAuto?.unitM ?? (typeof cfg.unitM === 'number' ? cfg.unitM : 1);
        const minVal = (cfg.minValueM ?? 0) > 0 ? (cfg.minValueM / unitM) : 0;
        const data = [];
        for (const key of cfg.fields) {
            const raw = Number(props[key]);
            if (!isFinite(raw))
                continue;
            const value = Math.max(raw, minVal);
            const color = resolveColorMapValue(cfg.colorMap?.[key], raw);
            data.push(color !== undefined ? { label: key, value, color } : { label: key, value });
        }
        if (!data.length)
            return null;
        let tooltip = this._getTooltip(props);
        if (!tooltip)
            tooltip = cfg.fields.map(k => `${k}: <b>${props[k]}</b>`).join('<br>');
        return {
            type: cfg.type ?? 'bar3d', data, unitM,
            barWidthM: cfg.barWidthM, barDepthM: cfg.barDepthM, gapM: cfg.gapM,
            strokeColor: cfg.strokeColor, strokeWidthM: cfg.strokeWidthM,
            minZoom: cfg.minZoom, maxZoom: cfg.maxZoom, tooltip,
            altitude: cfg.altitude, altitudeMode: cfg.altitudeMode,
            unitValue: cfg.unitValue, maxCols: cfg.maxCols, primitiveType: cfg.primitiveType,
        };
    }
    _diagramFromConfig(_f, props) {
        const cfg = this.diagram;
        if (!cfg?.fields?.length)
            return null;
        const typeName = cfg.type ?? 'bar';
        const unitPx = resolveDiagramUnitPx(typeName, cfg, this._diagramAuto?.unitPx);
        const data = cfg.fields.map(key => {
            const v = Number(props[key]);
            if (!isFinite(v))
                return null;
            const color = resolveColorMapValue(cfg.colorMap?.[key], v);
            return {
                label: cfg.labelField ? String(props[cfg.labelField] ?? key) : key,
                value: v, color,
            };
        }).filter((d) => d !== null);
        if (!data.length)
            return null;
        let tooltip = this._getTooltip(props);
        if (!tooltip) {
            tooltip = data.map(d => (d.color
                ? `<span style="display:inline-block;width:10px;height:10px;background:${d.color};margin-right:6px;border-radius:2px;"></span>`
                : '') + `${d.label}: <b>${d.value}</b>`).join('<br>');
        }
        const label = cfg.labelField ? String(props[cfg.labelField] ?? '') : '';
        return {
            type: typeName, data, unitPx,
            orientation: cfg.orientation, barWidth: cfg.barWidth, gap: cfg.gap, padding: cfg.padding,
            strokeColor: cfg.strokeColor, strokeWidth: cfg.strokeWidth,
            label: label || undefined, labelPosition: cfg.labelPosition,
            labelFont: cfg.labelFont, labelColor: cfg.labelColor,
            unitValue: cfg.unitValue, maxCols: cfg.maxCols, shape: cfg.shape,
            showTotal: cfg.showTotal, totalFont: cfg.totalFont, totalBg: cfg.totalBg,
            totalColor: cfg.totalColor, totalBorder: cfg.totalBorder, projection: cfg.projection,
            minZoom: cfg.minZoom, maxZoom: cfg.maxZoom, tooltip,
            coins: this._diagramCoins ?? cfg.coins,
            segmentSizes: cfg.segmentSizes,
        };
    }
    // ── parsers (тонкие обёртки) ────────────────────────────────────
    _parseIconSize(raw) { return parseIconSize(raw); }
    _parseSizeSpec(raw) { return parseSizeSpec(raw); }
    _parsePair(raw) { return parsePair(raw); }
    _parseTriple(raw) { return parseTriple(raw); }
    _asNumber(v) { return asNumber(v); }
}
Object.assign(GeoJSONLayer.prototype, PointsMixin, ShapesMixin, VectorsMixin);
