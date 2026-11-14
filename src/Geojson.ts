/**
 * Geojson.ts — класс GeoJSONLayer. Типы, константы, фильтры, парсеры
 * и стилевые хелперы вынесены в GeojsonUtils.ts (реэкспортируются ниже
 * для обратной совместимости).
 */
import { Layer } from './Layers.js';
import type { IconSize } from './Marker.js';
import type { Vec3, SizeSpec, PrimitiveType } from './Marker3D.js';
import type { Area3DFit } from './Area3D.js';
import type { ArrowSizeMode } from './Vector3D.js';
import type { Diagram } from './Diagram.js';
import type { Diagram3D, Diagram3DSpawnOptions } from './Diagram3D.js';
import { getAutoCoins, resolveDiagramUnitPx, MIN_COIN_DIAMETER_PX } from './DiagramTypes.js';
import type { Diagram3DData } from './Diagram3DTypes.js';
import { calculateBreaks, makeBreaksPretty } from './Classification.js';
import { resolveColorRamp, invertColorRamp } from './ColorRamps.js';
import {
    buildDiagramLegend, buildChoroplethLegend, buildDiagram3DLegend,
    type MapLegend, type LegendOptions, type LegendContext,
} from './Legend.js';

import {
    type GeoJSONFeature, type GeoJSONInput, type GeoJSONGeometry, type GeoJSONFeatureCollection,
    type Props, type ChoroplethConfig, type Diagram3DLayerConfig, type DiagramLayerConfig,
    type StyleConfig, type StyleRule, type StyleTypeConfig, type StyleTypeKey,
    type FeatureFilterSpec, type FeatureFilterInput, type DiagramSpawnOptions,
    type GeoJSONLayerOptions, type PointOptionsCallback, type Point3DOptionsCallback,
    type LineOptionsCallback, type PolygonOptionsCallback, type Polygon3DOptionsCallback,
    type VectorOptionsCallback, type OnEachFeatureCallback,
    compileExpressionFilter, compileObjectFilter, mapboxToJsExpr,
    resolveColorMapValue, resolveStyle, normalizeStyle,
    interpolateStyle, evaluateValueExpression, getTitle, getTooltip,
    parseIconSize, parseSizeSpec, parsePair, parseTriple, asNumber,
} from './GeojsonUtils.js';

import { PointsMixin, type GeoJSONLayerPoints } from './GeojsonPoints.js';
import { ShapesMixin, type GeoJSONLayerShapes } from './GeojsonShapes.js';
import { VectorsMixin, type GeoJSONLayerVectors } from './GeojsonVectors.js';

// Реэкспорт типов/констант/хелперов — сохраняет все текущие импорты.
export * from './GeojsonUtils.js';

// =====================================================================
// GeoJSONLayer
// =====================================================================

export class GeoJSONLayer extends Layer {
    public url: string | null = null;
    public data: GeoJSONInput | null = null;
    public crs: string | null = null;
    public tooltipOnHover = false;
    public legend: MapLegend | null = null;

    public choropleth: ChoroplethConfig | null = null;
    public _choroplethBreaks: number[] = [];
    public _choroplethRamp: any = null;

    public diagram3D: Diagram3DLayerConfig | null = null;
    public diagram3DToOptions: ((f: GeoJSONFeature, p: Props) => Diagram3DSpawnOptions | null) | null = null;
    public onEachDiagram3D: ((f: GeoJSONFeature, d: Diagram3D) => void) | null = null;

    private _diagram3DAuto: { unitM: number; barWidthM: number; barDepthM: number } | null = null;
    private _diagramAuto: { unitPx: number } | null = null;
    private _diagramCoins: number[] | null = null;

    public featureFilter: ((f: GeoJSONFeature) => boolean) | null = null;
    public filterSpec: FeatureFilterSpec | null = null;
    public filterExpression: string | null = null;

    public onEachFeature: OnEachFeatureCallback | null = null;
    public style: StyleConfig | null = null;
    public titleField: string | null = null;

    public pointToOptions: PointOptionsCallback | null = null;
    public point3DToOptions: Point3DOptionsCallback | null = null;
    public lineToOptions: LineOptionsCallback | null = null;
    public polygonToOptions: PolygonOptionsCallback | null = null;
    public polygon3DToOptions: Polygon3DOptionsCallback | null = null;
    public vectorToOptions: VectorOptionsCallback | null = null;
    public legendToOptions:
        ((ctx: LegendContext) => Partial<LegendOptions> | null | undefined) | null = null;

    public tooltip: string | ((props: Props) => string | null) | null = null;
    /** @deprecated Используйте `tooltip: '{fieldName}'`. */
    public tooltipField: string | null = null;

    public diagram: DiagramLayerConfig | null = null;
    public diagramToOptions: ((f: GeoJSONFeature, p: Props) => DiagramSpawnOptions | null) | null = null;
    public onEachDiagram: ((f, d) => void) | null = null;

    public defaultIconUrl = 'marker.png';
    public defaultIconSize: IconSize = [16, 16];
    public defaultAnchor: [number, number] = [0.5, 1.0];

    public default3DPrimitiveType: PrimitiveType = 'box';
    public default3DSize: SizeSpec | null = [100, 100, 100];
    public default3DAnchor: Vec3 = [0.5, 0, 0.5];
    public default3DAltitude = 0;
    public default3DAltitudeMode: 'clampToGround' | 'absolute' = 'clampToGround';

    public defaultLineColor: string | number = '#3388ff';
    public defaultLineWidth = 2;
    public defaultLineOpacity = 1;
    public defaultLineAltitudeMode: 'clampToGround' | 'absolute' = 'absolute';
    public defaultLineAltitude = 10;
    public defaultLineDepthTest = false;
    public defaultLineDepthWrite = false;
    public defaultLineMinZoom = -Infinity;
    public defaultLineMaxZoom = Infinity;

    public defaultVectorColor: string | number = '#3388ff';
    public defaultVectorWidth = 2;
    public defaultVectorOpacity = 1;
    public defaultVectorArrowSize = 10;
    public defaultVectorArrowSizeMode: ArrowSizeMode = 'px';
    public defaultVectorHeightScale = 1;
    public defaultVectorAltitude = 0;
    public defaultVectorAltitudeMode: 'clampToGround' | 'absolute' = 'absolute';
    public defaultVectorDepthTest = false;
    public defaultVectorDepthWrite = false;
    public defaultVectorMinZoom = -Infinity;
    public defaultVectorMaxZoom = Infinity;
    public defaultVectorSimplify = true;
    public defaultVectorSimplifyTolerance = 0.5;
    public defaultVectorSimplifyZoomBucket = 1;

    public defaultFillColor: string | number = '#3388ff';
    public defaultFillOpacity = 0.5;
    public defaultStrokeColor: string | number = '#000000';
    public defaultStrokeWidth = 2;
    public defaultStrokeOpacity = 1;
    public defaultPolygonAltitudeMode: 'clampToGround' | 'absolute' = 'absolute';
    public defaultPolygonAltitude = 10;
    public defaultPolygonDepthTest = false;
    public defaultPolygonDepthWrite = false;
    public defaultPolygonMinZoom = -Infinity;
    public defaultPolygonMaxZoom = Infinity;
    public defaultPolygonExtruded = false;
    public defaultPolygonHeight = 0;
    public defaultPolygonMinHeight = 0;

    public defaultPolygon3DPrimitiveType: PrimitiveType = 'box';
    public defaultPolygon3DSize: SizeSpec | null = null;
    public defaultPolygon3DAnchor: [number, number, number] = [0.5, 0, 0.5];
    public defaultPolygon3DAltitude = 0;
    public defaultPolygon3DAltitudeMode: 'clampToGround' | 'absolute' = 'clampToGround';
    public defaultPolygon3DFit: Area3DFit = 'stretch';
    public defaultPolygon3DRotate = 0;
    public defaultPolygon3DModelUrl: string | null = null;
    public defaultPolygon3DDepthTest = true;
    public defaultPolygon3DDepthWrite = true;

    private _loaded = false;

    static fromMapboxFilter(arr: readonly unknown[]): string { return mapboxToJsExpr(arr); }

    constructor(o: GeoJSONLayerOptions = {}) {
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
    override addTo(map: any): this {
        super.addTo(map);
        if (!this._loaded) this._load();
        return this;
    }

    reload(): void {
        const self = this as any;
        for (const obj of [...(self._objects ?? [])]) obj.remove();
        self._objects = [];
        if (this.legend) { try { this.legend.destroy(); } catch {} this.legend = null; }
        this._loaded = false;
        if (self._map) this._load();
    }

    // ── setters ─────────────────────────────────────────────────────
    setData(data: GeoJSONInput | null): this {
        this.data = data;
        if (this._map) this.reload(); else this._loaded = false;
        return this;
    }
    setUrl(url: string | null): this {
        this.url = url;
        if (this._map) this.reload(); else this._loaded = false;
        return this;
    }
    setStyle(style: StyleConfig | null): this {
        this.style = style;
        if (this._map && this._loaded) this.reload();
        return this;
    }
    setChoropleth(cfg: ChoroplethConfig | null): this {
        this.choropleth = cfg;
        if (this._map && this._loaded) this.reload();
        return this;
    }
    setDiagram(cfg: DiagramLayerConfig | null): this {
        this.diagram = cfg;
        if (this._map && this._loaded) this.reload();
        return this;
    }
    setDiagram3D(cfg: Diagram3DLayerConfig | null): this {
        this.diagram3D = cfg;
        if (this._map && this._loaded) this.reload();
        return this;
    }
    getLegend(): MapLegend | null { return this.legend; }
    getDiagramCoins(): number[] | null { return this._diagramCoins; }

    setFeatureFilter(input: FeatureFilterInput): this {
        this._applyFilter(input);
        if (this._map && this._loaded) this.reload();
        return this;
    }
    setFilter(input: FeatureFilterInput): this { return this.setFeatureFilter(input); }
    getFilter(): FeatureFilterInput {
        if (this.filterExpression != null) return this.filterExpression;
        if (this.filterSpec != null) return this.filterSpec;
        return this.featureFilter;
    }
    addData(data: GeoJSONInput): this { this._parse(data); return this; }

    // ── filter ──────────────────────────────────────────────────────
    private _applyFilter(input: unknown): void {
        if (Array.isArray(input)) {
            try { input = GeoJSONLayer.fromMapboxFilter(input); }
            catch (err) {
                console.warn('GeoJSONLayer: cannot convert Mapbox filter.', err, input);
                this.featureFilter = this.filterSpec = this.filterExpression = null;
                return;
            }
        }
        if (!input) { this.featureFilter = this.filterSpec = this.filterExpression = null; return; }
        if (typeof input === 'function') {
            this.featureFilter = input as (f: GeoJSONFeature) => boolean;
            this.filterSpec = this.filterExpression = null;
            return;
        }
        if (typeof input === 'string') {
            const trimmed = input.trim();
            if (!trimmed) { this.featureFilter = this.filterSpec = this.filterExpression = null; return; }
            this.featureFilter = compileExpressionFilter(trimmed);
            this.filterSpec = null;
            this.filterExpression = trimmed;
            return;
        }
        const spec = input as FeatureFilterSpec;
        if (!Object.keys(spec).length) {
            this.featureFilter = this.filterSpec = this.filterExpression = null;
            return;
        }
        this.featureFilter = compileObjectFilter(spec);
        this.filterSpec = spec;
        this.filterExpression = null;
    }

    // ── load ────────────────────────────────────────────────────────
    private async _load(): Promise<void> {
        let geojson: GeoJSONInput | null = null;
        try {
            if (this.data) geojson = this.data;
            else if (this.url) {
                const resp = await fetch(this.url);
                if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
                geojson = await resp.json() as GeoJSONInput;
            }
            if (!geojson) { console.warn('GeoJSONLayer: no data or URL'); return; }
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
        } catch (err) { console.error('GeoJSONLayer: load/parse error', err); }
    }

    private _buildLegend(geojson: GeoJSONInput): void {
        if (this.legend) { try { this.legend.destroy(); } catch {} this.legend = null; }
        let kind: 'diagram' | 'diagram3D' | 'choropleth' | null = null;
        let cfg: any = null;
        let legendOpts: LegendOptions | undefined;
        if (this.diagram?.legend) { kind = 'diagram'; cfg = this.diagram; legendOpts = this.diagram.legend; }
        else if (this.diagram3D?.legend) { kind = 'diagram3D'; cfg = this.diagram3D; legendOpts = this.diagram3D.legend; }
        else if (this.choropleth?.legend) { kind = 'choropleth'; cfg = this.choropleth; legendOpts = this.choropleth.legend; }
        if (!kind || !legendOpts) return;
        if (this.legendToOptions) {
            try {
                const ctx: LegendContext = { layer: this, kind, cfg, geojson, base: legendOpts };
                const patch = this.legendToOptions(ctx);
                if (patch === null) return;
                if (patch) legendOpts = { ...legendOpts, ...patch };
            } catch (err) { console.warn('GeoJSONLayer: legendToOptions threw', err); }
        }
        try {
            const builder = kind === 'diagram'
                ? buildDiagramLegend(this, geojson, cfg, legendOpts)
                : kind === 'diagram3D'
                    ? buildDiagram3DLegend(this, geojson, cfg, legendOpts)
                    : buildChoroplethLegend(this, geojson, cfg, legendOpts);
            this.legend = builder;
            if (legendOpts.target) this.legend.mount(legendOpts.target);
            legendOpts.onReady?.(this.legend);
        } catch (err) { console.warn('GeoJSONLayer: legend build failed', err); }
    }

    // ── choropleth / autoscale ──────────────────────────────────────
    private _calculateChoroplethBreaks(geojson: GeoJSONInput): void {
        if (!this.choropleth) return;
        const values: number[] = [];
        const visit = (f: GeoJSONFeature) => {
            if (!f.properties) return;
            const v = this._evaluateValueExpression(f.properties, this.choropleth!.value);
            if (isFinite(v)) values.push(v);
        };
        if (geojson.type === 'FeatureCollection') geojson.features.forEach(visit);
        else if (geojson.type === 'Feature') visit(geojson);

        this._choroplethBreaks = calculateBreaks(
            values,
            this.choropleth.classification ?? 'jenks',
            this.choropleth.classes ?? 5,
        );
        if (this.choropleth.pretty && !Array.isArray(this.choropleth.classification)) {
            this._choroplethBreaks = makeBreaksPretty(this._choroplethBreaks);
        }
    }

    private _computeDiagramAuto(geojson: GeoJSONInput): void {
        this._diagramAuto = null;
        const cfg = this.diagram;
        if (!cfg?.fields?.length || cfg.unitPx !== 'auto') return;
        let maxValue = 0;
        const scan = (f: GeoJSONFeature) => {
            if (this.featureFilter && !this.featureFilter(f)) return;
            const p = f.properties ?? {};
            for (const k of cfg.fields) {
                const v = Number(p[k]);
                if (isFinite(v) && v > maxValue) maxValue = v;
            }
        };
        if (geojson.type === 'FeatureCollection') geojson.features.forEach(scan);
        else if (geojson.type === 'Feature') scan(geojson);
        if (maxValue <= 0) return;
        this._diagramAuto = { unitPx: (cfg.maxHeightPx ?? 200) / maxValue };
    }

    /** Для `coin`: единый набор номиналов на слой — рендер и легенда совпадают. */
    private _computeCoinDenoms(geojson: GeoJSONInput): void {
        this._diagramCoins = null;
        const cfg = this.diagram;
        if (!cfg || (cfg.type ?? 'bar') !== 'coin') return;
        if (cfg.coins && cfg.coins.length > 0) {
            this._diagramCoins = [...cfg.coins].sort((a, b) => b - a);
            return;
        }
        const allValues: number[] = [];
        const scan = (f: GeoJSONFeature) => {
            if (this.featureFilter && !this.featureFilter(f)) return;
            const p = f.properties ?? {};
            if (p.diagram === false) return;
            for (const k of cfg.fields) {
                const v = Number(p[k]);
                if (isFinite(v) && v > 0) allValues.push(v);
            }
        };
        if (geojson.type === 'FeatureCollection') geojson.features.forEach(scan);
        else if (geojson.type === 'Feature') scan(geojson);
        if (!allValues.length) return;

        const unitPx = resolveDiagramUnitPx('coin', cfg, this._diagramAuto?.unitPx);
        const minValue = unitPx > 0 ? (MIN_COIN_DIAMETER_PX / 2 / unitPx) ** 2 : Infinity;
        const candidates = getAutoCoins(Math.max(...allValues));
        const visible = candidates.filter(c => c >= minValue);
        if (!visible.length) {
            console.warn('GeoJSONLayer: all coin denominations below ' +
                `${MIN_COIN_DIAMETER_PX}px at unitPx=${unitPx}; keeping the largest.`);
            visible.push(candidates[0]);
        }
        const used = new Set<number>();
        for (const v of allValues) {
            let rem = v;
            for (const c of visible) if (rem >= c) { used.add(c); rem %= c; }
        }
        const filtered = visible.filter(c => used.has(c));
        this._diagramCoins = filtered.length ? filtered : visible;
    }

    private _computeDiagram3DAuto(geojson: GeoJSONInput): void {
        this._diagram3DAuto = null;
        const cfg = this.diagram3D;
        if (!cfg?.fields?.length) return;

        let maxValue = 0, maxBars = 1;
        const scan = (f: GeoJSONFeature) => {
            if (this.featureFilter && !this.featureFilter(f)) return;
            const p = f.properties ?? {};
            let localMax = 0, cnt = 0;
            for (const k of cfg.fields) {
                const v = Number(p[k]);
                if (isFinite(v) && v > 0) { if (v > localMax) localMax = v; cnt++; }
            }
            if (cnt === 0) return;
            if (localMax > maxValue) maxValue = localMax;
            if (cnt > maxBars) maxBars = cnt;
        };
        if (geojson.type === 'FeatureCollection') geojson.features.forEach(scan);
        else if (geojson.type === 'Feature') scan(geojson);
        if (maxValue <= 0) return;

        const unitM = cfg.unitM === 'auto'
            ? (cfg.maxHeightM ?? 1000) / maxValue
            : (typeof cfg.unitM === 'number' ? cfg.unitM : 1);

        let barWidthM = cfg.barWidthM ?? null;
        let barDepthM = cfg.barDepthM ?? null;
        if ((cfg.type ?? 'bar3d') === 'bar3d') {
            if (barWidthM != null && barDepthM == null) barDepthM = barWidthM;
            else if (barDepthM != null && barWidthM == null) barWidthM = barDepthM;
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

    _withDiagram3DAuto(opts: Diagram3DSpawnOptions): Diagram3DSpawnOptions {
        const out = { ...opts };
        const auto = this._diagram3DAuto;
        if (!auto) return out;
        if (out.unitM == null) out.unitM = auto.unitM;
        if ((out.type ?? 'bar3d') === 'bar3d') {
            if (out.barWidthM != null && out.barDepthM == null) out.barDepthM = out.barWidthM;
            else if (out.barDepthM != null && out.barWidthM == null) out.barWidthM = out.barDepthM;
            else if (out.barWidthM == null && out.barDepthM == null) {
                out.barWidthM = auto.barWidthM;
                out.barDepthM = auto.barDepthM;
            }
        }
        return out;
    }

    // ── style helpers (тонкие обёртки над GeojsonUtils) ─────────────
    _getTitle(props: Props): string { return getTitle(this.titleField, props); }
    _getTooltip(props: Props): string { return getTooltip(this.tooltip, this.tooltipField, props); }
    _evaluateValueExpression(props: Props, exprOrFn: string | ((p: Props) => number)): number {
        return evaluateValueExpression(props, exprOrFn);
    }
    _resolveStyle(props: Props, type: StyleTypeKey): StyleRule | null {
        return resolveStyle(this.style, props, type);
    }
    _normalizeStyle<T extends Record<string, any>>(
        src: Record<string, any> | null | undefined,
        aliases: Record<string, string>,
    ): Partial<T> | null { return normalizeStyle<T>(src, aliases); }
    _interpolateStyle<T extends Record<string, any> | null | undefined>(style: T, props: Props): T {
        return interpolateStyle(style, props);
    }

    // ── dispatch ────────────────────────────────────────────────────
    private _parse(geojson: GeoJSONInput): void {
        const type = (geojson as { type: string }).type;
        if (type === 'FeatureCollection') {
            for (const f of (geojson as GeoJSONFeatureCollection).features) this._addFeature(f);
        } else if (type === 'Feature') {
            this._addFeature(geojson as GeoJSONFeature);
        } else if (
            type === 'Point' || type === 'LineString' || type === 'MultiLineString'
            || type === 'Polygon' || type === 'MultiPolygon'
        ) {
            this._addFeature({ type: 'Feature', geometry: geojson as GeoJSONGeometry, properties: {} });
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
                if (this.vectorToOptions && props.vector === true) this._addVectorFeature(feature);
                else this._addPointFeature(feature);
                break;
            case 'LineString':
            case 'MultiLineString':
                if (this.vectorToOptions || props.vector === true || this.style?.vector) {
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

    // ── diagram config → opts ───────────────────────────────────────
    _diagram3DFromConfig(_f: GeoJSONFeature, props: Props): Diagram3DSpawnOptions | null {
        const cfg = this.diagram3D;
        if (!cfg?.fields?.length) return null;
        const unitM = this._diagram3DAuto?.unitM ?? (typeof cfg.unitM === 'number' ? cfg.unitM : 1);
        const minVal = (cfg.minValueM ?? 0) > 0 ? (cfg.minValueM! / unitM) : 0;

        const data: Diagram3DData[] = [];
        for (const key of cfg.fields) {
            const raw = Number(props[key]);
            if (!isFinite(raw)) continue;
            const value = Math.max(raw, minVal);
            const color = resolveColorMapValue(cfg.colorMap?.[key], raw);
            data.push(color !== undefined ? { label: key, value, color } : { label: key, value });
        }
        if (!data.length) return null;

        let tooltip = this._getTooltip(props);
        if (!tooltip) tooltip = cfg.fields.map(k => `${k}: <b>${props[k]}</b>`).join('<br>');

        return {
            type: cfg.type ?? 'bar3d', data, unitM,
            barWidthM: cfg.barWidthM, barDepthM: cfg.barDepthM, gapM: cfg.gapM,
            strokeColor: cfg.strokeColor, strokeWidthM: cfg.strokeWidthM,
            minZoom: cfg.minZoom, maxZoom: cfg.maxZoom, tooltip,
            altitude: cfg.altitude, altitudeMode: cfg.altitudeMode,
            unitValue: cfg.unitValue, maxCols: cfg.maxCols, primitiveType: cfg.primitiveType,
        };
    }

    _diagramFromConfig(_f: GeoJSONFeature, props: Props): DiagramSpawnOptions | null {
        const cfg = this.diagram;
        if (!cfg?.fields?.length) return null;
        const typeName = cfg.type ?? 'bar';
        const unitPx = resolveDiagramUnitPx(typeName, cfg, this._diagramAuto?.unitPx);

        const data = cfg.fields.map(key => {
            const v = Number(props[key]);
            if (!isFinite(v)) return null;
            const color = resolveColorMapValue(cfg.colorMap?.[key], v);
            return {
                label: cfg.labelField ? String(props[cfg.labelField] ?? key) : key,
                value: v, color,
            };
        }).filter((d): d is NonNullable<typeof d> => d !== null);
        if (!data.length) return null;

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
    _parseIconSize(raw: any): IconSize | null { return parseIconSize(raw); }
    _parseSizeSpec(raw: any): SizeSpec | null { return parseSizeSpec(raw); }
    _parsePair(raw: any): [number, number] | null { return parsePair(raw); }
    _parseTriple(raw: any): [number, number, number] | null { return parseTriple(raw); }
    _asNumber(v: any): number | undefined { return asNumber(v); }
}

// interface-merge для доступа TS к методам из миксинов
export interface GeoJSONLayer extends
    GeoJSONLayerPoints, GeoJSONLayerShapes, GeoJSONLayerVectors {}

Object.assign(GeoJSONLayer.prototype, PointsMixin, ShapesMixin, VectorsMixin);