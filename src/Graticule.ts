/**
 * Graticule — картографическая сетка.
 * @module graticule
 */

import { THREE, Line2, LineMaterial, LineGeometry } from './js_TP/tpb.js';
import { Projections } from './Projections.js';

export type LabelSide = 'top' | 'bottom' | 'left' | 'right';

export interface GraticuleOptions {
    crs?: string;
    step?: number | null;
    adaptiveStep?: boolean;
    targetPixelsBetweenLines?: number;
    color?: string | number;
    width?: number;
    opacity?: number;
    lineDasharray?: [number, number] | number | null;
    lineDashOffset?: number;
    minZoom?: number;
    maxZoom?: number;
    showLabels?: boolean;
    labelStyle?: Record<string, string | number>;
    labelMinZoom?: number;
    labelMaxZoom?: number;
    labelPriority?: number;
    labelSides?: LabelSide[];
    altitude?: number;
    renderOrder?: number;
    debug?: boolean;
}

// ─────────────────────────────────────────────────────────────────────
// «Красивые» шаги
// ─────────────────────────────────────────────────────────────────────

const NICE_DEGREE_STEPS: number[] = [
    180, 90, 60, 30, 20, 15, 10, 5, 2, 1,
    30 / 60, 20 / 60, 15 / 60, 10 / 60, 5 / 60, 2 / 60, 1 / 60,
    30 / 3600, 20 / 3600, 15 / 3600, 10 / 3600, 5 / 3600, 2 / 3600, 1 / 3600,
    0.5 / 3600, 0.2 / 3600, 0.1 / 3600,
];

function niceLinearStep(target: number): number {
    if (!(target > 0) || !isFinite(target)) return 1;
    const exp = Math.floor(Math.log10(target));
    const base = Math.pow(10, exp);
    const candidates = [base, 2 * base, 5 * base, 10 * base];
    let best = candidates[0];
    let bestDiff = Math.abs(Math.log(candidates[0] / target));
    for (const v of candidates) {
        const d = Math.abs(Math.log(v / target));
        if (d < bestDiff) { best = v; bestDiff = d; }
    }
    return best;
}

function niceDegreeStep(target: number): number {
    if (!(target > 0) || !isFinite(target)) return 1;
    let best = NICE_DEGREE_STEPS[0];
    let bestDiff = Math.abs(Math.log(NICE_DEGREE_STEPS[0] / target));
    for (const v of NICE_DEGREE_STEPS) {
        const d = Math.abs(Math.log(v / target));
        if (d < bestDiff) { best = v; bestDiff = d; }
    }
    return best;
}

// ─────────────────────────────────────────────────────────────────────
// Константы
// ─────────────────────────────────────────────────────────────────────

const SAMPLE_COUNT = 32;
const MAX_CACHED_LINES = 3000;
const PRUNE_PADDING_FACTOR = 3;
const LABEL_MARGIN = 4;

const FULL_WORLD_STEP_DEG = 1;
const FULL_WORLD_STEP_FRAC = 0.01;

const INWARD_ANCHOR: Record<LabelSide, string> = {
    top: 'bottom',
    bottom: 'top',
    left: 'right',
    right: 'left',
};

// ─────────────────────────────────────────────────────────────────────
// Публичные типы для getPoints()
// ─────────────────────────────────────────────────────────────────────

export interface GraticulePoint {
    /** Уникальный id внутри одного вызова getPoints(). */
    id: string;
    kind: 'intersection' | 'edge';
    /**
     * Координаты в CRS сетки:
     *   geographic → [lon, lat] в градусах;
     *   projected  → [x, y] в единицах проекции.
     */
    crs: [number, number];
    /**
     * World-координаты в том же фрейме, что возвращает map.projectSafe:
     * [x, y(altitude), z]. Локальны относительно worldGroup.
     */
    world: [number, number, number];
    /** Для 'edge' — к какому ребру вьюпорта прилипла точка. */
    edge?: LabelSide;
    /** Для 'intersection' — id образующих линий. */
    meridianId?: string;
    parallelId?: string;
    /** Для 'edge' — id линии, пересекающей ребро. */
    lineId?: string;
    lineKind?: 'meridian' | 'parallel';
}

export interface GetPointsOptions {
    includeIntersections?: boolean; // default true
    includeEdges?: boolean;         // default true
    visibleOnly?: boolean;          // default true
    sides?: LabelSide[];            // для edges, default — все четыре
}

// ─────────────────────────────────────────────────────────────────────
// Внутренние типы
// ─────────────────────────────────────────────────────────────────────

class GridLabelSource {
    _graticule: Graticule;
    _anchor: LabelAnchor | null = null;
    _text: string;

    constructor(graticule: Graticule, text: string) {
        this._graticule = graticule;
        this._text = text;
    }

    getText(): string { return this._text; }
    getTextStyle(): Record<string, string | number> { return this._graticule._labelStyle; }
    getTextZoomBounds() { return { min: -Infinity, max: Infinity }; }
    isVisible(): boolean {
        if (!this._graticule._showLabels) return false;
        const z = this._graticule._map?.continuousZoom ?? 0;
        if (z < this._graticule._labelMinZoom || z > this._graticule._labelMaxZoom) return false;
        return this._anchor?.visibleOnScreen ?? false;
    }
    getLabelType(): 'point' { return 'point'; }
    getPriority(): number {
        if (!this._anchor) return this._graticule._labelPriority;
        return this._graticule._labelPriority + this._anchor.roundness;
    }
    getScreenPosition() { return this._anchor?.screenPos ?? null; }
    getTitleVariableAnchor(): string[] | null {
        if (!this._anchor) return null;
        return [INWARD_ANCHOR[this._anchor.renderSide]];
    }
    getTitleAlign() { return 'center' as const; }
    getTitleVerticalAlign() { return 'center' as const; }
}

interface LabelAnchor {
    isStart: boolean;
    side: LabelSide;
    renderSide: LabelSide;
    stableId: string;
    source: GridLabelSource;
    screenPos: { x: number; y: number } | null;
    visibleOnScreen: boolean;
    roundness: number;
}

interface LineInfo {
    stableId: string;
    kind: 'meridian' | 'parallel';
    value: number;
    text: string;
    line2: any;
    points3D: Array<[number, number, number]>;
    crsSamples: Array<[number, number]>;
    labels: LabelAnchor[];
}

interface SampledLine {
    pts: Array<[number, number, number]>;
    crs: Array<[number, number]>;
}

interface Viewport {
    minLon: number;
    maxLon: number;
    minLat: number;
    maxLat: number;
}

interface EdgeCrossing {
    segment: number;
    t: number;
}

// ─────────────────────────────────────────────────────────────────────
// Graticule
// ─────────────────────────────────────────────────────────────────────

export class Graticule {
    _map: any = null;
    _crsCode: string;
    _crsRaw: any = null;

    _stepOption: number | null;
    _adaptiveStep: boolean;
    _targetPixelsBetweenLines: number;
    _currentStep: number = 0;

    _color: string | number;
    _width: number;
    _opacity: number;
    _lineDasharray: [number, number] | number | null;
    _lineDashOffset: number;

    _minZoom: number;
    _maxZoom: number;
    _visible: boolean = true;
    _renderOrder: number;

    _showLabels: boolean;
    _labelStyle: Record<string, string | number>;
    _labelMinZoom: number;
    _labelMaxZoom: number;
    _labelPriority: number;
    _labelSides: Set<LabelSide>;
    _altitude: number;
    _debug: boolean;

    _material: any = null;
    _linesGroup: any = null;
    _lineInfos: LineInfo[] = [];

    _needsRebuild: boolean = true;
    _genMode: 'full-world' | 'viewport' = 'full-world';

    private _lastCamMatrix = new Float32Array(16);
    private _lastProjMatrix = new Float32Array(16);
    private _lastWgMatrix = new Float32Array(16);
    private _lastActiveLabelIds: Set<string> | null = null;

    private _scratchVx: Float64Array = new Float64Array(SAMPLE_COUNT + 2);
    private _scratchVy: Float64Array = new Float64Array(SAMPLE_COUNT + 2);
    private _scratchVz: Float64Array = new Float64Array(SAMPLE_COUNT + 2);

    private _tmpVec: any = new THREE.Vector3();
    private _mvMatrix: any = new THREE.Matrix4();

    constructor(options: GraticuleOptions = {}) {
        this._crsCode = options.crs ?? 'EPSG:4326';
        this._stepOption = options.step ?? null;
        this._adaptiveStep = options.adaptiveStep ?? (options.step == null);
        this._targetPixelsBetweenLines = options.targetPixelsBetweenLines ?? 100;

        this._color = options.color ?? '#666666';
        this._width = options.width ?? 1;
        this._opacity = options.opacity ?? 1;
        this._lineDasharray = options.lineDasharray ?? null;
        this._lineDashOffset = options.lineDashOffset ?? 0;

        this._minZoom = options.minZoom ?? -Infinity;
        this._maxZoom = options.maxZoom ?? Infinity;
        this._renderOrder = options.renderOrder ?? 100000;

        this._showLabels = options.showLabels ?? true;
        this._labelStyle = options.labelStyle ?? {
            fontSize: '10px',
            fontFamily: 'sans-serif',
            color: '#797979',
            padding: '5px 5px',
        };
        this._labelMinZoom = options.labelMinZoom ?? -Infinity;
        this._labelMaxZoom = options.labelMaxZoom ?? Infinity;
        this._labelPriority = options.labelPriority ?? 1e9;
        this._labelSides = new Set<LabelSide>(
            options.labelSides ?? ['top', 'bottom', 'left', 'right'],
        );
        this._altitude = options.altitude ?? 0;
        this._debug = options.debug ?? false;
    }

    // ─────────────────────────────────────────────────────────────────
    // Сеттеры / геттеры
    // ─────────────────────────────────────────────────────────────────

    setStep(step: number | null): this {
        this._stepOption = step;
        this._adaptiveStep = step == null;
        this._needsRebuild = true;
        this._lastActiveLabelIds = null;
        return this;
    }
    getStep(): number { return this._currentStep; }

    isAdaptiveStep(): boolean { return this._adaptiveStep; }
    setAdaptiveStep(on: boolean): this {
        this._adaptiveStep = !!on;
        this._needsRebuild = true;
        this._lastActiveLabelIds = null;
        return this;
    }

    setTargetPixelsBetweenLines(px: number): this {
        if (px > 0) {
            this._targetPixelsBetweenLines = px;
            this._needsRebuild = true;
        }
        return this;
    }
    getTargetPixelsBetweenLines(): number { return this._targetPixelsBetweenLines; }

    setCrs(code: string): this {
        if (code === this._crsCode) return this;
        this._crsCode = code;
        try {
            this._crsRaw = this._map ? Projections.getRaw(code) : null;
        } catch {
            this._crsRaw = null;
        }
        this._needsRebuild = true;
        this._lastActiveLabelIds = null;
        return this;
    }
    getCrs(): string { return this._crsCode; }

    setColor(color: string | number): this {
        this._color = color;
        if (this._material) {
            this._material.color.set(color as any);
            this._material.needsUpdate = true;
        }
        return this;
    }
    getColor(): string | number { return this._color; }

    setWidth(width: number): this {
        if (!(width > 0)) return this;
        this._width = width;
        if (this._material) {
            this._material.linewidth = width;
            this._material.needsUpdate = true;
        }
        return this;
    }
    getWidth(): number { return this._width; }

    setOpacity(opacity: number): this {
        const v = Math.max(0, Math.min(1, opacity));
        this._opacity = v;
        if (this._material) {
            this._material.opacity = v;
            const tr = v < 1;
            if (this._material.transparent !== tr) {
                this._material.transparent = tr;
                this._material.needsUpdate = true;
            }
        }
        return this;
    }
    getOpacity(): number { return this._opacity; }

    setLineDasharray(v: [number, number] | number | null): this {
        this._lineDasharray = v;
        if (this._material) {
            if (v == null) {
                this._material.dashed = false;
            } else {
                const [d, g] = typeof v === 'number' ? [v, v] : [v[0], v[1]];
                this._material.dashed = true;
                this._material.dashSize = d;
                this._material.gapSize = g;
                this._material.dashOffset = this._lineDashOffset;
            }
            this._material.needsUpdate = true;
        }
        return this;
    }
    getLineDasharray(): [number, number] | number | null { return this._lineDasharray; }

    setLineDashOffset(v: number): this {
        this._lineDashOffset = v;
        if (this._material) {
            this._material.dashOffset = v;
            this._material.needsUpdate = true;
        }
        return this;
    }
    getLineDashOffset(): number { return this._lineDashOffset; }

    setVisible(v: boolean): this {
        this._visible = !!v;
        if (this._linesGroup) this._linesGroup.visible = this._visible;
        return this;
    }
    isVisible(): boolean { return this._visible; }

    setLabelsVisible(v: boolean): this {
        this._showLabels = !!v;
        this._lastActiveLabelIds = null;
        return this;
    }
    isLabelsVisible(): boolean { return this._showLabels; }

    setLabelStyle(style: Record<string, string | number>): this {
        this._labelStyle = { ...style };
        this._lastActiveLabelIds = null;
        return this;
    }
    getLabelStyle(): Record<string, string | number> { return { ...this._labelStyle }; }

    setLabelSides(sides: LabelSide[]): this {
        this._labelSides = new Set<LabelSide>(sides);
        this._needsRebuild = true;
        this._lastActiveLabelIds = null;
        return this;
    }
    getLabelSides(): LabelSide[] { return Array.from(this._labelSides); }

    setZoomBounds(min: number, max: number): this {
        this._minZoom = min;
        this._maxZoom = max;
        return this;
    }
    getZoomBounds(): { min: number; max: number } { return { min: this._minZoom, max: this._maxZoom }; }

    setRenderOrder(order: number): this {
        this._renderOrder = order;
        for (const info of this._lineInfos) {
            if (info.line2) info.line2.renderOrder = order;
        }
        return this;
    }
    getRenderOrder(): number { return this._renderOrder; }

    // ─────────────────────────────────────────────────────────────────
    // Layer lifecycle
    // ─────────────────────────────────────────────────────────────────

    addTo(map: any): this {
        if (this._map === map) return this;
        if (this._map) this.removeFromMap();
        this._map = map;
        this._crsRaw = Projections.getRaw(this._crsCode);

        this._linesGroup = new THREE.Group();
        this._linesGroup.name = 'graticule';
        this._linesGroup.visible = this._visible;
        map.worldGroup.add(this._linesGroup);

        this._createMaterial();
        this._needsRebuild = true;
        this._lastActiveLabelIds = null;
        this._lastCamMatrix.fill(0);
        this._lastProjMatrix.fill(0);
        this._lastWgMatrix.fill(0);
        return this;
    }

    removeFromMap(): void {
        const map = this._map;
        if (!map) return;

        if (map.textManager) {
            try { map.textManager.pruneStaleLabels(new Set(), this, { fade: false }); } catch {}
        }

        this._clearAllLines();

        if (this._material) {
            try { this._material.dispose(); } catch {}
            this._material = null;
        }
        if (this._linesGroup && this._linesGroup.parent) {
            this._linesGroup.parent.remove(this._linesGroup);
        }
        this._linesGroup = null;
        this._map = null;
        this._lastActiveLabelIds = null;
        this._lastCamMatrix.fill(0);
        this._lastProjMatrix.fill(0);
        this._lastWgMatrix.fill(0);
    }

    _dispose(): void { this.removeFromMap(); }

    _applyRenderOrder(_base: number): void {}

    getBounds(_crs?: string): null { return null; }

    // ─────────────────────────────────────────────────────────────────
    // Per-frame update
    // ─────────────────────────────────────────────────────────────────

    _postUpdate(map: any): void {
        if (!this._map || map !== this._map) return;
        if (!this._visible) return;

        const z = map.continuousZoom;
        if (z < this._minZoom || z > this._maxZoom) {
            if (this._linesGroup) this._linesGroup.visible = false;
            return;
        }
        if (this._linesGroup) this._linesGroup.visible = true;

        const cameraMoved = this._syncCameraSnapshot(map);

        if (!cameraMoved && !this._needsRebuild && this._lineInfos.length > 0) {
            this._updateLabelsInTextManager();
            return;
        }

        const viewport = this._getViewport();
        if (!viewport) return;

        const step = this._resolveStep(viewport);
        const stepChanged = step !== this._currentStep;

        const crs = this._crsRaw;
        const isGeo = !!crs.isGeographic;
        const fullWorld = isGeo
            ? step >= FULL_WORLD_STEP_DEG
            : step >= (2 * crs.halfExtentX) * FULL_WORLD_STEP_FRAC;
        const mode: 'full-world' | 'viewport' = fullWorld ? 'full-world' : 'viewport';

        const modeChanged = mode !== this._genMode;

        if (stepChanged || modeChanged || this._needsRebuild || this._lineInfos.length === 0) {
            this._currentStep = step;
            this._genMode = mode;
            this._rebuildAll(viewport, step, mode);
            this._needsRebuild = false;
        } else if (cameraMoved) {
            this._addMissingLines(viewport, step, mode);
        }

        this._updateResolution();
        this._updateLabelPositions(viewport);
        this._updateLabelsInTextManager();
    }

    private _syncCameraSnapshot(map: any): boolean {
        if (!map.camera || !map.worldGroup) return false;
        const camE = map.camera.matrixWorld.elements as Float32Array;
        const projE = map.camera.projectionMatrix.elements as Float32Array;
        const wgE = map.worldGroup.matrixWorld.elements as Float32Array;
        let changed = false;
        for (let i = 0; i < 16; i++) {
            if (Math.abs(camE[i]  - this._lastCamMatrix[i])  > 1e-9) { changed = true; break; }
            if (Math.abs(projE[i] - this._lastProjMatrix[i]) > 1e-9) { changed = true; break; }
            if (Math.abs(wgE[i]   - this._lastWgMatrix[i])   > 1e-9) { changed = true; break; }
        }
        if (changed) {
            this._lastCamMatrix.set(camE);
            this._lastProjMatrix.set(projE);
            this._lastWgMatrix.set(wgE);
        }
        return changed;
    }

    // ─────────────────────────────────────────────────────────────────
    // Внутреннее
    // ─────────────────────────────────────────────────────────────────

    private _createMaterial(): void {
        const canvas = this._map.renderer.domElement;
        const mat = new LineMaterial({
            color: this._color as any,
            linewidth: this._width,
            opacity: this._opacity,
            transparent: this._opacity < 1,
            depthTest: false,
            depthWrite: false,
            resolution: new THREE.Vector2(canvas.width, canvas.height),
            worldUnits: false,
        });
        if (this._lineDasharray != null) {
            const [d, g] = typeof this._lineDasharray === 'number'
                ? [this._lineDasharray, this._lineDasharray]
                : [this._lineDasharray[0], this._lineDasharray[1]];
            mat.dashed = true;
            mat.dashSize = d;
            mat.gapSize = g;
            mat.dashOffset = this._lineDashOffset;
        }
        this._material = mat;
    }

    private _updateResolution(): void {
        if (!this._material || !this._map) return;
        const canvas = this._map.renderer.domElement;
        const r = this._material.resolution;
        if (r.x !== canvas.width || r.y !== canvas.height) {
            r.set(canvas.width, canvas.height);
        }
    }

    private _getViewport(): Viewport {
        let minLon = -180, maxLon = 180, minLat = -90, maxLat = 90;
        const b = this._map.getBounds();
        if (b) {
            const [[a, c], [d, e]] = b;
            if (isFinite(a) && isFinite(c) && isFinite(d) && isFinite(e)) {
                const loLon = Math.min(a, d), hiLon = Math.max(a, d);
                const loLat = Math.min(c, e), hiLat = Math.max(c, e);
                if (hiLon > loLon && hiLat > loLat) {
                    minLon = Math.max(-180, loLon);
                    maxLon = Math.min(180, hiLon);
                    minLat = Math.max(-90, loLat);
                    maxLat = Math.min(90, hiLat);
                }
            }
        }
        const dLon = (maxLon - minLon) * 0.5;
        const dLat = (maxLat - minLat) * 0.5;
        return {
            minLon: Math.max(-180, minLon - dLon),
            maxLon: Math.min(180, maxLon + dLon),
            minLat: Math.max(-90, minLat - dLat),
            maxLat: Math.min(90, maxLat + dLat),
        };
    }

    private _resolveStep(vp: Viewport): number {
        if (!this._adaptiveStep && this._stepOption != null) return this._stepOption;

        const canvas = this._map.renderer.domElement;
        const W = canvas.clientWidth || 1;
        const H = canvas.clientHeight || 1;

        if (this._crsRaw?.isGeographic) {
            const dLon = vp.maxLon - vp.minLon;
            const dLat = vp.maxLat - vp.minLat;
            const degPerPx = Math.max(dLon / W, dLat / H);
            const target = degPerPx * this._targetPixelsBetweenLines;
            return niceDegreeStep(target);
        }

        const crs = this._crsRaw;
        const [x1, y1] = crs.fromLonLat([vp.minLon, vp.minLat]) || [0, 0];
        const [x2, y2] = crs.fromLonLat([vp.maxLon, vp.maxLat]) || [0, 0];
        const spanX = Math.abs(x2 - x1);
        const spanY = Math.abs(y2 - y1);
        const unitsPerPx = Math.max(spanX / W, spanY / H);
        const target = unitsPerPx * this._targetPixelsBetweenLines;
        return niceLinearStep(target);
    }

    // ─────────────────────────────────────────────────────────────────
    // Генерация линий
    // ─────────────────────────────────────────────────────────────────

    private _clearAllLines(): void {
        if (this._map?.textManager) {
            try { this._map.textManager.pruneStaleLabels(new Set(), this, { fade: false }); } catch {}
        }
        for (const info of this._lineInfos) this._destroyLine(info);
        this._lineInfos = [];
        this._lastActiveLabelIds = null;
    }

    private _rebuildAll(viewport: Viewport, step: number, mode: 'full-world' | 'viewport'): void {
        this._clearAllLines();
        this._addMissingLines(viewport, step, mode);
    }

    private _addMissingLines(
        viewport: Viewport,
        step: number,
        mode: 'full-world' | 'viewport',
    ): void {
        const crs = this._crsRaw;
        const isGeo = !!crs.isGeographic;

        let genMinX: number, genMaxX: number, genMinY: number, genMaxY: number;

        if (mode === 'full-world') {
            if (isGeo) {
                genMinX = -180; genMaxX = 180;
                genMinY = -90;  genMaxY = 90;
            } else {
                genMinX = -crs.halfExtentX; genMaxX = crs.halfExtentX;
                genMinY = -crs.halfExtentY; genMaxY = crs.halfExtentY;
            }
        } else {
            const p1 = crs.fromLonLat([viewport.minLon, viewport.minLat]);
            const p2 = crs.fromLonLat([viewport.maxLon, viewport.maxLat]);
            if (!p1 || !p2) return;
            const cx = (p1[0] + p2[0]) * 0.5;
            const cy = (p1[1] + p2[1]) * 0.5;
            const hx = Math.abs(p2[0] - p1[0]);
            const hy = Math.abs(p2[1] - p1[1]);
            genMinX = cx - hx; genMaxX = cx + hx;
            genMinY = cy - hy; genMaxY = cy + hy;
        }

        const existing = new Set<string>();
        for (const info of this._lineInfos) existing.add(info.stableId);

        const N = SAMPLE_COUNT;
        const newInfos: LineInfo[] = [];
        let addedM = 0, addedP = 0;

        // ── Меридианы ──
        const startX = Math.ceil(genMinX / step - 1e-9) * step;
        for (let v = startX; v <= genMaxX + step * 1e-6; v += step) {
            const value = Math.abs(v) < step * 1e-9 ? 0 : v;
            const id = `grid:m:${round6(value)}`;
            if (existing.has(id)) continue;

            const sampled = isGeo
                ? this._sampleMeridianGeo(value, N)
                : this._sampleMeridianProj(value, N);
            if (sampled.pts.length < 2) continue;

            const text = this._formatLabel(value, false, step, isGeo);
            const info: LineInfo = {
                stableId: id, kind: 'meridian', value, text,
                line2: this._buildLine2(sampled.pts),
                points3D: sampled.pts,
                crsSamples: sampled.crs,
                labels: this._buildLabelAnchors(id, 'meridian', text, value, step, isGeo),
            };
            if (this._linesGroup) this._linesGroup.add(info.line2);
            newInfos.push(info);
            addedM++;
        }

        // ── Параллели ──
        const startY = Math.ceil(genMinY / step - 1e-9) * step;
        for (let v = startY; v <= genMaxY + step * 1e-6; v += step) {
            const value = Math.abs(v) < step * 1e-9 ? 0 : v;
            const id = `grid:p:${round6(value)}`;
            if (existing.has(id)) continue;

            const sampled = isGeo
                ? this._sampleParallelGeo(value, N)
                : this._sampleParallelProj(value, N);
            if (sampled.pts.length < 2) continue;

            const text = this._formatLabel(value, true, step, isGeo);
            const info: LineInfo = {
                stableId: id, kind: 'parallel', value, text,
                line2: this._buildLine2(sampled.pts),
                points3D: sampled.pts,
                crsSamples: sampled.crs,
                labels: this._buildLabelAnchors(id, 'parallel', text, value, step, isGeo),
            };
            if (this._linesGroup) this._linesGroup.add(info.line2);
            newInfos.push(info);
            addedP++;
        }

        for (const info of newInfos) this._lineInfos.push(info);

        if (this._debug && (addedM || addedP)) {
            console.log(`[Graticule] mode=${mode} step=${step} added M=${addedM} P=${addedP} total=${this._lineInfos.length}`);
        }

        if (this._lineInfos.length > MAX_CACHED_LINES) {
            this._pruneFarLines(viewport, mode);
        }
    }

    private _buildLabelAnchors(
        lineId: string,
        kind: 'meridian' | 'parallel',
        text: string,
        value: number,
        step: number,
        isGeo: boolean,
    ): LabelAnchor[] {
        const roundness = computeRoundness(value, step, isGeo);
        const startSide: LabelSide = kind === 'meridian' ? 'bottom' : 'left';
        const endSide: LabelSide = kind === 'meridian' ? 'top' : 'right';

        const makeAnchor = (isStart: boolean, side: LabelSide): LabelAnchor => {
            const stableId = `${lineId}:${side}`;
            const source = new GridLabelSource(this, text);
            const anchor: LabelAnchor = {
                isStart,
                side,
                renderSide: side,
                stableId,
                source,
                screenPos: null,
                visibleOnScreen: false,
                roundness,
            };
            source._anchor = anchor;
            return anchor;
        };

        return [
            makeAnchor(true, startSide),
            makeAnchor(false, endSide),
        ];
    }

    private _pruneFarLines(viewport: Viewport, mode: 'full-world' | 'viewport'): void {
        if (mode === 'full-world') return;
        const crs = this._crsRaw;
        const p1 = crs.fromLonLat([viewport.minLon, viewport.minLat]);
        const p2 = crs.fromLonLat([viewport.maxLon, viewport.maxLat]);
        if (!p1 || !p2) return;

        const spanX = Math.abs(p2[0] - p1[0]);
        const spanY = Math.abs(p2[1] - p1[1]);
        const padX = spanX * PRUNE_PADDING_FACTOR;
        const padY = spanY * PRUNE_PADDING_FACTOR;
        const loX = Math.min(p1[0], p2[0]) - padX;
        const hiX = Math.max(p1[0], p2[0]) + padX;
        const loY = Math.min(p1[1], p2[1]) - padY;
        const hiY = Math.max(p1[1], p2[1]) + padY;

        const kept: LineInfo[] = [];
        for (const info of this._lineInfos) {
            const inRange = info.kind === 'meridian'
                ? (info.value >= loX && info.value <= hiX)
                : (info.value >= loY && info.value <= hiY);
            if (inRange) kept.push(info);
            else this._destroyLine(info);
        }
        this._lineInfos = kept;
        this._lastActiveLabelIds = null;
    }

    // ── Сэмплирование ──

    private _sampleMeridianGeo(lon: number, N: number): SampledLine {
        const map = this._map;
        const pts: Array<[number, number, number]> = [];
        const crs: Array<[number, number]> = [];
        const latMin = -89.99, latMax = 89.99;
        for (let i = 0; i <= N; i++) {
            const lat = latMin + (latMax - latMin) * (i / N);
            const world = map.projectSafe([lon, lat], this._crsRaw);
            if (!world) continue;
            pts.push([world[0], this._altitude, world[1]]);
            crs.push([lon, lat]);
        }
        return { pts, crs };
    }

    private _sampleParallelGeo(lat: number, N: number): SampledLine {
        const map = this._map;
        const pts: Array<[number, number, number]> = [];
        const crs: Array<[number, number]> = [];
        for (let i = 0; i <= N; i++) {
            const lon = -180 + 360 * (i / N);
            const world = map.projectSafe([lon, lat], this._crsRaw);
            if (!world) continue;
            pts.push([world[0], this._altitude, world[1]]);
            crs.push([lon, lat]);
        }
        return { pts, crs };
    }

    private _sampleMeridianProj(x: number, N: number): SampledLine {
        const map = this._map;
        const crs = this._crsRaw;
        const yMin = -crs.halfExtentY, yMax = crs.halfExtentY;
        const pts: Array<[number, number, number]> = [];
        const crsArr: Array<[number, number]> = [];
        for (let i = 0; i <= N; i++) {
            const y = yMin + (yMax - yMin) * (i / N);
            const world = map.projectSafe([x, y], crs);
            if (!world) continue;
            pts.push([world[0], this._altitude, world[1]]);
            crsArr.push([x, y]);
        }
        return { pts, crs: crsArr };
    }

    private _sampleParallelProj(y: number, N: number): SampledLine {
        const map = this._map;
        const crs = this._crsRaw;
        const xMin = -crs.halfExtentX, xMax = crs.halfExtentX;
        const pts: Array<[number, number, number]> = [];
        const crsArr: Array<[number, number]> = [];
        for (let i = 0; i <= N; i++) {
            const x = xMin + (xMax - xMin) * (i / N);
            const world = map.projectSafe([x, y], crs);
            if (!world) continue;
            pts.push([world[0], this._altitude, world[1]]);
            crsArr.push([x, y]);
        }
        return { pts, crs: crsArr };
    }

    // ── Line2 ──

    private _buildLine2(points: Array<[number, number, number]>): any {
        const flat: number[] = [];
        for (const [x, y, z] of points) {
            if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) continue;
            flat.push(x, y, z);
        }
        const geom = new LineGeometry();
        geom.setPositions(flat);
        geom.computeBoundingSphere();
        const line = new Line2(geom, this._material);
        line.computeLineDistances();
        line.renderOrder = this._renderOrder;
        line.frustumCulled = true;
        return line;
    }

    private _destroyLine(info: LineInfo): void {
        if (!info.line2) return;
        if (info.line2.parent) info.line2.parent.remove(info.line2);
        try { info.line2.geometry?.dispose(); } catch {}
        info.line2 = null;
    }

    // ─────────────────────────────────────────────────────────────────
    // Позиционирование подписей строго по 5 правилам
    // ─────────────────────────────────────────────────────────────────

    private _findLineEndLabel(
        isStart: boolean,
        defaultSide: LabelSide,
        vx: Float64Array,
        vy: Float64Array,
        vz: Float64Array,
        n: number,
        W: number,
        H: number,
        nearZ: number,
        projMatrix: any,
    ): { x: number; y: number; side: LabelSide; isEdge: boolean } | null {
        const M = LABEL_MARGIN;
        const clampX = (x: number) => Math.max(M, Math.min(W - M, x));
        const clampY = (y: number) => Math.max(M, Math.min(H - M, y));
        const tmp = this._tmpVec;

        const projectViewPoint = (x: number, y: number, z: number): { x: number; y: number } | null => {
            tmp.set(x, y, z).applyMatrix4(projMatrix);
            const sx = (tmp.x * 0.5 + 0.5) * W;
            const sy = (-tmp.y * 0.5 + 0.5) * H;
            if (!Number.isFinite(sx) || !Number.isFinite(sy)) return null;
            return { x: sx, y: sy };
        };

        const isEndpointVisible = (idx: number): { x: number; y: number } | null => {
            if (vz[idx] > nearZ) return null;
            const p = projectViewPoint(vx[idx], vy[idx], vz[idx]);
            if (!p) return null;
            if (p.x >= 0 && p.x <= W && p.y >= 0 && p.y <= H) {
                return p;
            }
            return null;
        };

        if (isStart) {
            // ПРАВИЛО 1: виден ли её начальный конец? Если ВИДЕН — рисуем на нём
            const startPt = isEndpointVisible(0);
            if (startPt) {
                return {
                    x: clampX(startPt.x),
                    y: clampY(startPt.y),
                    side: defaultSide,
                    isEdge: false,
                };
            }

            // ПРАВИЛО 3: если начальный конец НЕ виден — ищем пересечение с экраном, ближайшее к НАЧАЛУ линии
            for (let i = 0; i < n - 1; i++) {
                const hit = this._getClippedSegmentScreenIntersection(
                    vx[i], vy[i], vz[i],
                    vx[i + 1], vy[i + 1], vz[i + 1],
                    W, H, nearZ, projMatrix,
                );
                if (hit) {
                    return {
                        x: clampX(hit.x),
                        y: clampY(hit.y),
                        side: hit.edge,
                        isEdge: true,
                    };
                }
            }
        } else {
            // ПРАВИЛО 2: виден ли её конечный конец? Если ВИДЕН — рисуем на нём
            const endPt = isEndpointVisible(n - 1);
            if (endPt) {
                return {
                    x: clampX(endPt.x),
                    y: clampY(endPt.y),
                    side: defaultSide,
                    isEdge: false,
                };
            }

            // ПРАВИЛО 4: если конечный конец НЕ виден — ищем пересечение с экраном, ближайшее к КОНЦУ линии
            // Важно: передаём отрезок в обратном направлении (от i + 1 к i), чтобы minT искал точку ближе к концу!
            for (let i = n - 2; i >= 0; i--) {
                const hit = this._getClippedSegmentScreenIntersection(
                    vx[i + 1], vy[i + 1], vz[i + 1],
                    vx[i], vy[i], vz[i],
                    W, H, nearZ, projMatrix,
                );
                if (hit) {
                    return {
                        x: clampX(hit.x),
                        y: clampY(hit.y),
                        side: hit.edge,
                        isEdge: true,
                    };
                }
            }
        }

        // ПРАВИЛО 5: ни конец не виден, ни пересечений с экраном нет — подпись не рисуется
        return null;
    }

    /**
     * Отсекает направленный 3D-отрезок A -> B в пространстве камеры по ближней плоскости (z <= nearZ),
     * проецирует на экран и возвращает ближайшее к началу A пересечение с границей экрана [0, W] x [0, H].
     */
    private _getClippedSegmentScreenIntersection(
        vx1: number, vy1: number, vz1: number,
        vx2: number, vy2: number, vz2: number,
        W: number, H: number,
        nearZ: number,
        projMatrix: any,
    ): { x: number; y: number; edge: LabelSide; t: number } | null {
        if (vz1 > nearZ && vz2 > nearZ) return null;

        let ax = vx1, ay = vy1, az = vz1;
        let bx = vx2, by = vy2, bz = vz2;

        if (az > nearZ) {
            const tNear = (nearZ - az) / (bz - az);
            ax += (bx - ax) * tNear;
            ay += (by - ay) * tNear;
            az = nearZ;
        } else if (bz > nearZ) {
            const tNear = (nearZ - az) / (bz - az);
            bx = ax + (bx - ax) * tNear;
            by = ay + (by - ay) * tNear;
            bz = nearZ;
        }

        const tmp = this._tmpVec;
        tmp.set(ax, ay, az).applyMatrix4(projMatrix);
        const x1 = (tmp.x * 0.5 + 0.5) * W;
        const y1 = (-tmp.y * 0.5 + 0.5) * H;

        tmp.set(bx, by, bz).applyMatrix4(projMatrix);
        const x2 = (tmp.x * 0.5 + 0.5) * W;
        const y2 = (-tmp.y * 0.5 + 0.5) * H;

        if (!Number.isFinite(x1) || !Number.isFinite(y1) || !Number.isFinite(x2) || !Number.isFinite(y2)) {
            return null;
        }

        let minT = Infinity;
        let bestHit: { x: number; y: number; edge: LabelSide; t: number } | null = null;

        const epsT = 1e-7;
        const epsPos = 1e-4;

        const checkHit = (t: number, x: number, y: number, edge: LabelSide) => {
            if (t >= -epsT && t <= 1 + epsT && x >= -epsPos && x <= W + epsPos && y >= -epsPos && y <= H + epsPos) {
                const clampedT = Math.max(0, Math.min(1, t));
                if (clampedT < minT) {
                    minT = clampedT;
                    bestHit = {
                        x: Math.max(0, Math.min(W, x)),
                        y: Math.max(0, Math.min(H, y)),
                        edge,
                        t: clampedT,
                    };
                }
            }
        };

        const dx = x2 - x1;
        const dy = y2 - y1;

        // Левый край (x = 0)
        if ((x1 <= 0 && x2 >= 0) || (x1 >= 0 && x2 <= 0)) {
            if (Math.abs(dx) > 1e-12) {
                const t = (0 - x1) / dx;
                checkHit(t, 0, y1 + dy * t, 'left');
            }
        }
        // Правый край (x = W)
        if ((x1 <= W && x2 >= W) || (x1 >= W && x2 <= W)) {
            if (Math.abs(dx) > 1e-12) {
                const t = (W - x1) / dx;
                checkHit(t, W, y1 + dy * t, 'right');
            }
        }
        // Верхний край (y = 0)
        if ((y1 <= 0 && y2 >= 0) || (y1 >= 0 && y2 <= 0)) {
            if (Math.abs(dy) > 1e-12) {
                const t = (0 - y1) / dy;
                checkHit(t, x1 + dx * t, 0, 'top');
            }
        }
        // Нижний край (y = H)
        if ((y1 <= H && y2 >= H) || (y1 >= H && y2 <= H)) {
            if (Math.abs(dy) > 1e-12) {
                const t = (H - y1) / dy;
                checkHit(t, x1 + dx * t, H, 'bottom');
            }
        }

        return bestHit;
    }

    private _ensureScratchCapacity(n: number): void {
        if (this._scratchVx.length < n) {
            const size = Math.max(n, this._scratchVx.length * 2);
            this._scratchVx = new Float64Array(size);
            this._scratchVy = new Float64Array(size);
            this._scratchVz = new Float64Array(size);
        }
    }

    private _updateLabelPositions(_viewport: Viewport): void {
        const map = this._map;
        const camera = map.camera;
        const canvas = map.renderer.domElement;
        const W = canvas.clientWidth;
        const H = canvas.clientHeight;
        const tmp = this._tmpVec;

        // Полная матрица перевода из локальных координат worldGroup в пространство камеры
        const mvMatrix = this._mvMatrix.multiplyMatrices(
            camera.matrixWorldInverse,
            map.worldGroup.matrixWorld,
        );
        const projMatrix = camera.projectionMatrix;
        const isOrtho = !!camera.isOrthographicCamera;
        const nearZ = isOrtho ? Infinity : -Math.max(1e-4, camera.near || 0.1);

        for (const info of this._lineInfos) {
            const pts = info.points3D;
            if (pts.length < 2) {
                for (const lbl of info.labels) {
                    lbl.visibleOnScreen = false;
                    lbl.screenPos = null;
                }
                continue;
            }

            const n = pts.length;
            this._ensureScratchCapacity(n);
            const vx = this._scratchVx;
            const vy = this._scratchVy;
            const vz = this._scratchVz;

            for (let i = 0; i < n; i++) {
                const [px, py, pz] = pts[i];
                tmp.set(px, py, pz).applyMatrix4(mvMatrix);
                vx[i] = tmp.x;
                vy[i] = tmp.y;
                vz[i] = tmp.z;
            }

            for (const lbl of info.labels) {
                const res = this._findLineEndLabel(
                    lbl.isStart,
                    lbl.side,
                    vx, vy, vz,
                    n, W, H,
                    nearZ,
                    projMatrix,
                );

                if (res && (!res.isEdge || this._labelSides.has(res.side))) {
                    lbl.screenPos = { x: res.x, y: res.y };
                    lbl.renderSide = res.side;
                    lbl.visibleOnScreen = true;
                } else {
                    lbl.screenPos = null;
                    lbl.visibleOnScreen = false;
                }
            }
        }
    }

    private _updateLabelsInTextManager(): void {
        const tm = this._map?.textManager;
        if (!tm) return;

        const z = this._map.continuousZoom;
        const show = this._showLabels && z >= this._labelMinZoom && z <= this._labelMaxZoom;

        if (!show) {
            if (this._lastActiveLabelIds !== null) {
                try { tm.pruneStaleLabels(new Set(), this, { fade: false }); } catch {}
                this._lastActiveLabelIds = null;
            }
            return;
        }

        const activeIds = new Set<string>();
        const sources: Array<{ id: string; source: GridLabelSource }> = [];
        for (const info of this._lineInfos) {
            for (const lbl of info.labels) {
                activeIds.add(lbl.stableId);
                sources.push({ id: lbl.stableId, source: lbl.source });
            }
        }

        if (this._lastActiveLabelIds !== null && this._setsEqual(this._lastActiveLabelIds, activeIds)) {
            return;
        }

        try {
            tm.pruneStaleLabels(activeIds, this, { fade: false });
        } catch (e) { console.warn(e); }

        for (const { id, source } of sources) {
            const existing = tm._labelsById ? tm._labelsById.get(id) : null;
            if (existing) {
                if (existing.source === source && !existing.removing && !existing.fadingOut) {
                    continue;
                }
                try { tm.removeLabel?.(id); } catch {}
                try { tm._labelsById.delete(id); } catch {}
            }
            try { tm.addLabel(source, id, this); }
            catch (e) { console.warn(e); }
        }

        this._lastActiveLabelIds = activeIds;
    }

    private _setsEqual(a: Set<string>, b: Set<string>): boolean {
        if (a.size !== b.size) return false;
        for (const v of a) if (!b.has(v)) return false;
        return true;
    }

    // ─────────────────────────────────────────────────────────────────
    // Публичный API: точки сетки
    // ─────────────────────────────────────────────────────────────────

    /**
     * Возвращает точки пересечений меридианов×параллелей и точки
     * пересечения линий сетки с рёбрами вьюпорта.
     *
     * Для каждой точки:
     *   - `crs`   — координаты в CRS сетки: [lon, lat] или [x, y];
     *   - `world` — соответствующие world-координаты (worldGroup-local):
     *               [x, altitude, z].
     */
    getPoints(options: GetPointsOptions = {}): GraticulePoint[] {
        const includeIntersections = options.includeIntersections ?? true;
        const includeEdges = options.includeEdges ?? true;
        const visibleOnly = options.visibleOnly ?? true;
        const sides: LabelSide[] = options.sides
            ?? ['top', 'bottom', 'left', 'right'];

        const result: GraticulePoint[] = [];
        if (!this._map || !this._lineInfos.length) return result;

        const map = this._map;
        const camera = map.camera;
        const canvas = map.renderer.domElement;
        const W = canvas.clientWidth;
        const H = canvas.clientHeight;
        const wgMatrix = map.worldGroup.matrixWorld;
        const mvMatrix = this._mvMatrix.multiplyMatrices(
            camera.matrixWorldInverse,
            wgMatrix,
        );
        const projMatrix = camera.projectionMatrix;
        const isOrtho = !!camera.isOrthographicCamera;
        const nearZ = isOrtho ? Infinity : -Math.max(1e-4, camera.near || 0.1);
        const tmp = new THREE.Vector3();

        const onScreen = (x: number, y: number, z: number): boolean => {
            tmp.set(x, y, z).applyMatrix4(mvMatrix);
            if (tmp.z > nearZ) return false;
            tmp.applyMatrix4(projMatrix);
            const px = (tmp.x * 0.5 + 0.5) * W;
            const py = (-tmp.y * 0.5 + 0.5) * H;
            return px >= -1 && px <= W + 1 && py >= -1 && py <= H + 1;
        };

        // ── 1. Пересечения ──
        if (includeIntersections) {
            const meridians: LineInfo[] = [];
            const parallels: LineInfo[] = [];
            for (const info of this._lineInfos) {
                (info.kind === 'meridian' ? meridians : parallels).push(info);
            }

            for (const m of meridians) {
                for (const p of parallels) {
                    const w2 = map.projectSafe([m.value, p.value], this._crsRaw);
                    if (!w2) continue;
                    const world: [number, number, number] =
                        [w2[0], this._altitude, w2[1]];
                    if (visibleOnly && !onScreen(world[0], world[1], world[2])) continue;
                    result.push({
                        id: `${m.stableId}×${p.stableId}`,
                        kind: 'intersection',
                        crs: [m.value, p.value],
                        world,
                        meridianId: m.stableId,
                        parallelId: p.stableId,
                    });
                }
            }
        }

        // ── 2. Точки на краях ──
        if (includeEdges) {
            const sx  = new Float64Array(SAMPLE_COUNT + 2);
            const sy  = new Float64Array(SAMPLE_COUNT + 2);
            const vis = new Uint8Array(SAMPLE_COUNT + 2);

            for (const info of this._lineInfos) {
                const pts = info.points3D;
                const crsS = info.crsSamples;
                if (pts.length < 2 || crsS.length !== pts.length) continue;
                const n = pts.length;

                for (let i = 0; i < n; i++) {
                    const [px, py, pz] = pts[i];
                    tmp.set(px, py, pz).applyMatrix4(mvMatrix);
                    vis[i] = tmp.z <= nearZ ? 1 : 0;
                    tmp.applyMatrix4(projMatrix);
                    sx[i]  = (tmp.x * 0.5 + 0.5) * W;
                    sy[i]  = (-tmp.y * 0.5 + 0.5) * H;
                }

                for (const side of sides) {
                    const crossings = this._findEdgeCrossings(
                        side, sx, sy, vis, n, W, H,
                    );
                    for (const cr of crossings) {
                        const iA = cr.segment, iB = iA + 1, t = cr.t;
                        const pA = pts[iA], pB = pts[iB];
                        const cA = crsS[iA], cB = crsS[iB];

                        const world: [number, number, number] = [
                            pA[0] + (pB[0] - pA[0]) * t,
                            pA[1] + (pB[1] - pA[1]) * t,
                            pA[2] + (pB[2] - pA[2]) * t,
                        ];
                        const crs: [number, number] = [
                            cA[0] + (cB[0] - cA[0]) * t,
                            cA[1] + (cB[1] - cA[1]) * t,
                        ];

                        if (visibleOnly && !onScreen(world[0], world[1], world[2])) continue;

                        result.push({
                            id: `${info.stableId}:${side}:${iA}:${t.toFixed(4)}`,
                            kind: 'edge',
                            crs,
                            world,
                            edge: side,
                            lineId: info.stableId,
                            lineKind: info.kind,
                        });
                    }
                }
            }
        }

        return result;
    }

    /**
     * То же, что getPoints(), но в виде словаря:
     *   ключ   — "crsX,crsY"
     *   значение — GraticulePoint.
     */
    getPointsMap(options: GetPointsOptions = {}): Map<string, GraticulePoint> {
        const out = new Map<string, GraticulePoint>();
        for (const p of this.getPoints(options)) {
            out.set(`${p.crs[0]},${p.crs[1]}`, p);
        }
        return out;
    }

    // ── Хелпер: все пересечения с ребром ──

    private _findEdgeCrossings(
        side: LabelSide,
        sx: Float64Array,
        sy: Float64Array,
        vis: Uint8Array,
        n: number,
        W: number,
        H: number,
    ): EdgeCrossing[] {
        const out: EdgeCrossing[] = [];

        if (side === 'top' || side === 'bottom') {
            const edgeY = side === 'top' ? 0 : H;
            for (let i = 0; i < n - 1; i++) {
                if (!vis[i] || !vis[i + 1]) continue;
                const y1 = sy[i], y2 = sy[i + 1];
                const crosses = (y1 >= edgeY && y2 < edgeY)
                             || (y1 <  edgeY && y2 >= edgeY);
                if (!crosses) continue;
                const t = (edgeY - y1) / (y2 - y1);
                const x = sx[i] + (sx[i + 1] - sx[i]) * t;
                if (x < 0 || x > W) continue;
                out.push({ segment: i, t });
            }
        } else {
            const edgeX = side === 'left' ? 0 : W;
            for (let i = 0; i < n - 1; i++) {
                if (!vis[i] || !vis[i + 1]) continue;
                const x1 = sx[i], x2 = sx[i + 1];
                const crosses = (x1 >= edgeX && x2 < edgeX)
                             || (x1 <  edgeX && x2 >= edgeX);
                if (!crosses) continue;
                const t = (edgeX - x1) / (x2 - x1);
                const y = sy[i] + (sy[i + 1] - sy[i]) * t;
                if (y < 0 || y > H) continue;
                out.push({ segment: i, t });
            }
        }

        return out;
    }

    // ─────────────────────────────────────────────────────────────────
    // Форматирование
    // ─────────────────────────────────────────────────────────────────

    private _formatLabel(value: number, isLat: boolean, step: number, isGeo: boolean): string {
        if (!isGeo) return this._formatLinear(value, step);

        const abs = Math.abs(value);
        const dir = isLat
            ? (value > 0 ? 'С' : value < 0 ? 'Ю' : '')
            : (value > 0 ? 'В' : value < 0 ? 'З' : '');

        if (value === 0) return '0°';

        if (step >= 1) {
            const d = Math.round(abs);
            return dir ? `${d}°` : `${d}°`;
        }
        if (step >= 1 / 60 - 1e-12) {
            const deg = Math.floor(abs);
            const min = Math.round((abs - deg) * 60);
            if (min === 60) return dir ? `${deg + 1}°${dir}` : `${deg + 1}°`;
            if (deg === 0)  return dir ? `${min}'${dir}`     : `${min}'`;
            if (min === 0)  return dir ? `${deg}°${dir}`     : `${deg}°`;
            return dir ? `${deg}°${min}'${dir}` : `${deg}°${min}'`;
        }
        const deg = Math.floor(abs);
        const mFull = (abs - deg) * 60;
        const min = Math.floor(mFull);
        let sec = Math.round((mFull - min) * 60);
        if (sec === 60) { sec = 0; }
        if (deg === 0 && min === 0) return dir ? `${sec}"${dir}` : `${sec}"`;
        if (deg === 0) return dir ? `${min}'${sec}"${dir}` : `${min}'${sec}"`;
        if (sec === 0 && min === 0) return dir ? `${deg}°${dir}` : `${deg}°`;
        return dir ? `${deg}°${min}'${sec}"${dir}` : `${deg}°${min}'${sec}"`;
    }

    private _formatLinear(value: number, step: number): string {
        if (step >= 1000) return `${(value / 1000).toFixed(0)}km`;
        if (step >= 1) return `${Math.round(value)}m`;
        if (step >= 0.1) return `${value.toFixed(1)}m`;
        return `${value.toFixed(2)}m`;
    }
}

function round6(v: number): number {
    return Math.round(v * 1e6) / 1e6;
}

function computeRoundness(value: number, step: number, isGeo: boolean): number {
    const absV = Math.abs(value);
    const eps  = Math.max(step * 1e-6, 1e-9);

    if (absV < eps) return 1000;
    if (isGeo && absV >= 179.999) return 999;

    if (isGeo) {
        const nice = [90, 60, 45, 30, 20, 15, 10, 5, 2, 1];
        for (let i = 0; i < nice.length; i++) {
            const d = nice[i];
            if (d < step * 0.999) continue;
            const rem = absV % d;
            if (rem < eps || d - rem < eps) {
                return 900 - i * 50;
            }
        }
        return 100;
    }

    const mag = Math.pow(10, Math.floor(Math.log10(Math.max(absV, step))));
    const niceLinear = [mag * 10, mag * 5, mag * 2, mag];
    for (let i = 0; i < niceLinear.length; i++) {
        const d = niceLinear[i];
        if (d < step * 0.999) continue;
        const rem = absV % d;
        if (rem < eps || d - rem < eps) {
            return 900 - i * 100;
        }
    }
    return 100;
}