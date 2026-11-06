/**
 * Graticule — картографическая сетка.
 * @module graticule
 */
import { THREE, Line2, LineMaterial, LineGeometry } from './js_TP/tpb.js';
import { Projections } from './Projections.js';
// ─────────────────────────────────────────────────────────────────────
// «Красивые» шаги
// ─────────────────────────────────────────────────────────────────────
const NICE_DEGREE_STEPS = [
    180, 90, 60, 30, 20, 15, 10, 5, 2, 1,
    30 / 60, 20 / 60, 15 / 60, 10 / 60, 5 / 60, 2 / 60, 1 / 60,
    30 / 3600, 20 / 3600, 15 / 3600, 10 / 3600, 5 / 3600, 2 / 3600, 1 / 3600,
    0.5 / 3600, 0.2 / 3600, 0.1 / 3600,
];
function niceLinearStep(target) {
    if (!(target > 0) || !isFinite(target))
        return 1;
    const exp = Math.floor(Math.log10(target));
    const base = Math.pow(10, exp);
    const candidates = [base, 2 * base, 5 * base, 10 * base];
    let best = candidates[0];
    let bestDiff = Math.abs(Math.log(candidates[0] / target));
    for (const v of candidates) {
        const d = Math.abs(Math.log(v / target));
        if (d < bestDiff) {
            best = v;
            bestDiff = d;
        }
    }
    return best;
}
function niceDegreeStep(target) {
    if (!(target > 0) || !isFinite(target))
        return 1;
    let best = NICE_DEGREE_STEPS[0];
    let bestDiff = Math.abs(Math.log(NICE_DEGREE_STEPS[0] / target));
    for (const v of NICE_DEGREE_STEPS) {
        const d = Math.abs(Math.log(v / target));
        if (d < bestDiff) {
            best = v;
            bestDiff = d;
        }
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
const INWARD_ANCHOR = {
    top: 'bottom',
    bottom: 'top',
    left: 'right',
    right: 'left',
};
// ─────────────────────────────────────────────────────────────────────
// Внутренние типы
// ─────────────────────────────────────────────────────────────────────
class GridLabelSource {
    _graticule;
    _anchor = null;
    _text;
    constructor(graticule, text) {
        this._graticule = graticule;
        this._text = text;
    }
    getText() { return this._text; }
    getTextStyle() { return this._graticule._labelStyle; }
    getTextZoomBounds() { return { min: -Infinity, max: Infinity }; }
    isVisible() {
        if (!this._graticule._showLabels)
            return false;
        const z = this._graticule._map?.continuousZoom ?? 0;
        if (z < this._graticule._labelMinZoom || z > this._graticule._labelMaxZoom)
            return false;
        return this._anchor?.visibleOnScreen ?? false;
    }
    getLabelType() { return 'point'; }
    getPriority() {
        if (!this._anchor)
            return this._graticule._labelPriority;
        return this._graticule._labelPriority + this._anchor.roundness;
    }
    getScreenPosition() { return this._anchor?.screenPos ?? null; }
    getTitleVariableAnchor() {
        if (!this._anchor)
            return null;
        return [INWARD_ANCHOR[this._anchor.side]];
    }
    getTitleAlign() { return 'center'; }
    getTitleVerticalAlign() { return 'center'; }
}
// ─────────────────────────────────────────────────────────────────────
// Graticule
// ─────────────────────────────────────────────────────────────────────
export class Graticule {
    _map = null;
    _crsCode;
    _crsRaw = null;
    _stepOption;
    _adaptiveStep;
    _targetPixelsBetweenLines;
    _currentStep = 0;
    _color;
    _width;
    _opacity;
    _lineDasharray;
    _lineDashOffset;
    _minZoom;
    _maxZoom;
    _visible = true;
    _renderOrder;
    _showLabels;
    _labelStyle;
    _labelMinZoom;
    _labelMaxZoom;
    _labelPriority;
    _labelSides;
    _altitude;
    _debug;
    _material = null;
    _linesGroup = null;
    _lineInfos = [];
    _needsRebuild = true;
    _genMode = 'full-world';
    _lastCamMatrix = new Float32Array(16);
    _lastWgMatrix = new Float32Array(16);
    _lastActiveLabelIds = null;
    _scratchSx = new Float32Array(SAMPLE_COUNT + 2);
    _scratchSy = new Float32Array(SAMPLE_COUNT + 2);
    _scratchVis = new Uint8Array(SAMPLE_COUNT + 2);
    _tmpVec = new THREE.Vector3();
    constructor(options = {}) {
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
        this._labelSides = new Set(options.labelSides ?? ['top', 'bottom', 'left', 'right']);
        this._altitude = options.altitude ?? 0;
        this._debug = options.debug ?? false;
    }
    // ─────────────────────────────────────────────────────────────────
    // Сеттеры / геттеры
    // ─────────────────────────────────────────────────────────────────
    setStep(step) {
        this._stepOption = step;
        this._adaptiveStep = step == null;
        this._needsRebuild = true;
        this._lastActiveLabelIds = null;
        return this;
    }
    getStep() { return this._currentStep; }
    isAdaptiveStep() { return this._adaptiveStep; }
    setAdaptiveStep(on) {
        this._adaptiveStep = !!on;
        this._needsRebuild = true;
        this._lastActiveLabelIds = null;
        return this;
    }
    setTargetPixelsBetweenLines(px) {
        if (px > 0) {
            this._targetPixelsBetweenLines = px;
            this._needsRebuild = true;
        }
        return this;
    }
    getTargetPixelsBetweenLines() { return this._targetPixelsBetweenLines; }
    setCrs(code) {
        if (code === this._crsCode)
            return this;
        this._crsCode = code;
        try {
            this._crsRaw = this._map ? Projections.getRaw(code) : null;
        }
        catch {
            this._crsRaw = null;
        }
        this._needsRebuild = true;
        this._lastActiveLabelIds = null;
        return this;
    }
    getCrs() { return this._crsCode; }
    setColor(color) {
        this._color = color;
        if (this._material) {
            this._material.color.set(color);
            this._material.needsUpdate = true;
        }
        return this;
    }
    getColor() { return this._color; }
    setWidth(width) {
        if (!(width > 0))
            return this;
        this._width = width;
        if (this._material) {
            this._material.linewidth = width;
            this._material.needsUpdate = true;
        }
        return this;
    }
    getWidth() { return this._width; }
    setOpacity(opacity) {
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
    getOpacity() { return this._opacity; }
    setLineDasharray(v) {
        this._lineDasharray = v;
        if (this._material) {
            if (v == null) {
                this._material.dashed = false;
            }
            else {
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
    getLineDasharray() { return this._lineDasharray; }
    setLineDashOffset(v) {
        this._lineDashOffset = v;
        if (this._material) {
            this._material.dashOffset = v;
            this._material.needsUpdate = true;
        }
        return this;
    }
    getLineDashOffset() { return this._lineDashOffset; }
    setVisible(v) {
        this._visible = !!v;
        if (this._linesGroup)
            this._linesGroup.visible = this._visible;
        return this;
    }
    isVisible() { return this._visible; }
    setLabelsVisible(v) {
        this._showLabels = !!v;
        this._lastActiveLabelIds = null;
        return this;
    }
    isLabelsVisible() { return this._showLabels; }
    setLabelStyle(style) {
        this._labelStyle = { ...style };
        this._lastActiveLabelIds = null;
        return this;
    }
    getLabelStyle() { return { ...this._labelStyle }; }
    setLabelSides(sides) {
        this._labelSides = new Set(sides);
        this._needsRebuild = true;
        this._lastActiveLabelIds = null;
        return this;
    }
    getLabelSides() { return Array.from(this._labelSides); }
    setZoomBounds(min, max) {
        this._minZoom = min;
        this._maxZoom = max;
        return this;
    }
    getZoomBounds() { return { min: this._minZoom, max: this._maxZoom }; }
    setRenderOrder(order) {
        this._renderOrder = order;
        for (const info of this._lineInfos) {
            if (info.line2)
                info.line2.renderOrder = order;
        }
        return this;
    }
    getRenderOrder() { return this._renderOrder; }
    // ─────────────────────────────────────────────────────────────────
    // Layer lifecycle
    // ─────────────────────────────────────────────────────────────────
    addTo(map) {
        if (this._map === map)
            return this;
        if (this._map)
            this.removeFromMap();
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
        this._lastWgMatrix.fill(0);
        return this;
    }
    removeFromMap() {
        const map = this._map;
        if (!map)
            return;
        if (map.textManager) {
            try {
                map.textManager.pruneStaleLabels(new Set(), this, { fade: false });
            }
            catch { }
        }
        this._clearAllLines();
        if (this._material) {
            try {
                this._material.dispose();
            }
            catch { }
            this._material = null;
        }
        if (this._linesGroup && this._linesGroup.parent) {
            this._linesGroup.parent.remove(this._linesGroup);
        }
        this._linesGroup = null;
        this._map = null;
        this._lastActiveLabelIds = null;
        this._lastCamMatrix.fill(0);
        this._lastWgMatrix.fill(0);
    }
    _dispose() { this.removeFromMap(); }
    _applyRenderOrder(_base) { }
    getBounds(_crs) { return null; }
    // ─────────────────────────────────────────────────────────────────
    // Per-frame update
    // ─────────────────────────────────────────────────────────────────
    _postUpdate(map) {
        if (!this._map || map !== this._map)
            return;
        if (!this._visible)
            return;
        const z = map.continuousZoom;
        if (z < this._minZoom || z > this._maxZoom) {
            if (this._linesGroup)
                this._linesGroup.visible = false;
            return;
        }
        if (this._linesGroup)
            this._linesGroup.visible = true;
        const cameraMoved = this._syncCameraSnapshot(map);
        if (!cameraMoved && !this._needsRebuild && this._lineInfos.length > 0) {
            this._updateLabelsInTextManager();
            return;
        }
        const viewport = this._getViewport();
        if (!viewport)
            return;
        const step = this._resolveStep(viewport);
        const stepChanged = step !== this._currentStep;
        const crs = this._crsRaw;
        const isGeo = !!crs.isGeographic;
        const fullWorld = isGeo
            ? step >= FULL_WORLD_STEP_DEG
            : step >= (2 * crs.halfExtentX) * FULL_WORLD_STEP_FRAC;
        const mode = fullWorld ? 'full-world' : 'viewport';
        const modeChanged = mode !== this._genMode;
        if (stepChanged || modeChanged || this._needsRebuild || this._lineInfos.length === 0) {
            this._currentStep = step;
            this._genMode = mode;
            this._rebuildAll(viewport, step, mode);
            this._needsRebuild = false;
        }
        else if (cameraMoved) {
            this._addMissingLines(viewport, step, mode);
        }
        this._updateResolution();
        this._updateLabelPositions(viewport);
        this._updateLabelsInTextManager();
    }
    _syncCameraSnapshot(map) {
        if (!map.camera || !map.worldGroup)
            return false;
        const camE = map.camera.matrixWorld.elements;
        const wgE = map.worldGroup.matrixWorld.elements;
        let changed = false;
        for (let i = 0; i < 16; i++) {
            if (Math.abs(camE[i] - this._lastCamMatrix[i]) > 1e-9) {
                changed = true;
                break;
            }
            if (Math.abs(wgE[i] - this._lastWgMatrix[i]) > 1e-9) {
                changed = true;
                break;
            }
        }
        if (changed) {
            this._lastCamMatrix.set(camE);
            this._lastWgMatrix.set(wgE);
        }
        return changed;
    }
    // ─────────────────────────────────────────────────────────────────
    // Внутреннее
    // ─────────────────────────────────────────────────────────────────
    _createMaterial() {
        const canvas = this._map.renderer.domElement;
        const mat = new LineMaterial({
            color: this._color,
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
    _updateResolution() {
        if (!this._material || !this._map)
            return;
        const canvas = this._map.renderer.domElement;
        const r = this._material.resolution;
        if (r.x !== canvas.width || r.y !== canvas.height) {
            r.set(canvas.width, canvas.height);
        }
    }
    _getViewport() {
        let minLon = -180, maxLon = 180, minLat = -90, maxLat = 90;
        const b = this._map.getBounds();
        if (b) {
            const [[a, c], [d, e]] = b;
            if (isFinite(a) && isFinite(c) && isFinite(d) && isFinite(e)
                && d > a && e > c) {
                minLon = Math.max(-180, a);
                maxLon = Math.min(180, d);
                minLat = Math.max(-90, c);
                maxLat = Math.min(90, e);
            }
        }
        const dLon = (maxLon - minLon) * 0.3;
        const dLat = (maxLat - minLat) * 0.3;
        return {
            minLon: Math.max(-180, minLon - dLon),
            maxLon: Math.min(180, maxLon + dLon),
            minLat: Math.max(-90, minLat - dLat),
            maxLat: Math.min(90, maxLat + dLat),
        };
    }
    _resolveStep(vp) {
        if (!this._adaptiveStep && this._stepOption != null)
            return this._stepOption;
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
    _clearAllLines() {
        for (const info of this._lineInfos)
            this._destroyLine(info);
        this._lineInfos = [];
        this._lastActiveLabelIds = null;
    }
    _rebuildAll(viewport, step, mode) {
        this._clearAllLines();
        this._addMissingLines(viewport, step, mode);
    }
    _addMissingLines(viewport, step, mode) {
        const crs = this._crsRaw;
        const isGeo = !!crs.isGeographic;
        let genMinX, genMaxX, genMinY, genMaxY;
        if (mode === 'full-world') {
            if (isGeo) {
                genMinX = -180;
                genMaxX = 180;
                genMinY = -90;
                genMaxY = 90;
            }
            else {
                genMinX = -crs.halfExtentX;
                genMaxX = crs.halfExtentX;
                genMinY = -crs.halfExtentY;
                genMaxY = crs.halfExtentY;
            }
        }
        else {
            const p1 = crs.fromLonLat([viewport.minLon, viewport.minLat]);
            const p2 = crs.fromLonLat([viewport.maxLon, viewport.maxLat]);
            if (!p1 || !p2)
                return;
            const cx = (p1[0] + p2[0]) * 0.5;
            const cy = (p1[1] + p2[1]) * 0.5;
            const hx = Math.abs(p2[0] - p1[0]) * 0.75;
            const hy = Math.abs(p2[1] - p1[1]) * 0.75;
            genMinX = cx - hx;
            genMaxX = cx + hx;
            genMinY = cy - hy;
            genMaxY = cy + hy;
        }
        const existing = new Set();
        for (const info of this._lineInfos)
            existing.add(info.stableId);
        const N = SAMPLE_COUNT;
        const newInfos = [];
        let addedM = 0, addedP = 0;
        // ── Меридианы ──
        const startX = Math.ceil(genMinX / step - 1e-9) * step;
        for (let v = startX; v <= genMaxX + step * 1e-6; v += step) {
            const value = Math.abs(v) < step * 1e-9 ? 0 : v;
            const id = `grid:m:${round6(value)}`;
            if (existing.has(id))
                continue;
            const sampled = isGeo
                ? this._sampleMeridianGeo(value, N)
                : this._sampleMeridianProj(value, N);
            if (sampled.pts.length < 2)
                continue;
            const text = this._formatLabel(value, false, step, isGeo);
            const info = {
                stableId: id, kind: 'meridian', value, text,
                line2: this._buildLine2(sampled.pts),
                points3D: sampled.pts,
                crsSamples: sampled.crs,
                labels: this._buildLabelAnchors(id, text, value, step, isGeo),
            };
            if (this._linesGroup)
                this._linesGroup.add(info.line2);
            newInfos.push(info);
            addedM++;
        }
        // ── Параллели ──
        const startY = Math.ceil(genMinY / step - 1e-9) * step;
        for (let v = startY; v <= genMaxY + step * 1e-6; v += step) {
            const value = Math.abs(v) < step * 1e-9 ? 0 : v;
            const id = `grid:p:${round6(value)}`;
            if (existing.has(id))
                continue;
            const sampled = isGeo
                ? this._sampleParallelGeo(value, N)
                : this._sampleParallelProj(value, N);
            if (sampled.pts.length < 2)
                continue;
            const text = this._formatLabel(value, true, step, isGeo);
            const info = {
                stableId: id, kind: 'parallel', value, text,
                line2: this._buildLine2(sampled.pts),
                points3D: sampled.pts,
                crsSamples: sampled.crs,
                labels: this._buildLabelAnchors(id, text, value, step, isGeo),
            };
            if (this._linesGroup)
                this._linesGroup.add(info.line2);
            newInfos.push(info);
            addedP++;
        }
        for (const info of newInfos)
            this._lineInfos.push(info);
        if (this._debug && (addedM || addedP)) {
            console.log(`[Graticule] mode=${mode} step=${step} added M=${addedM} P=${addedP} total=${this._lineInfos.length}`);
        }
        if (this._lineInfos.length > MAX_CACHED_LINES) {
            this._pruneFarLines(viewport, mode);
        }
    }
    _buildLabelAnchors(lineId, text, value, step, isGeo) {
        const roundness = computeRoundness(value, step, isGeo);
        const result = [];
        for (const side of this._labelSides) {
            const stableId = `${lineId}:${side}`;
            const source = new GridLabelSource(this, text);
            const anchor = {
                side,
                stableId,
                source,
                screenPos: null,
                visibleOnScreen: false,
                roundness,
            };
            source._anchor = anchor;
            result.push(anchor);
        }
        return result;
    }
    _pruneFarLines(viewport, mode) {
        if (mode === 'full-world')
            return;
        const crs = this._crsRaw;
        const p1 = crs.fromLonLat([viewport.minLon, viewport.minLat]);
        const p2 = crs.fromLonLat([viewport.maxLon, viewport.maxLat]);
        if (!p1 || !p2)
            return;
        const spanX = Math.abs(p2[0] - p1[0]);
        const spanY = Math.abs(p2[1] - p1[1]);
        const padX = spanX * PRUNE_PADDING_FACTOR;
        const padY = spanY * PRUNE_PADDING_FACTOR;
        const loX = Math.min(p1[0], p2[0]) - padX;
        const hiX = Math.max(p1[0], p2[0]) + padX;
        const loY = Math.min(p1[1], p2[1]) - padY;
        const hiY = Math.max(p1[1], p2[1]) + padY;
        const kept = [];
        for (const info of this._lineInfos) {
            const inRange = info.kind === 'meridian'
                ? (info.value >= loX && info.value <= hiX)
                : (info.value >= loY && info.value <= hiY);
            if (inRange)
                kept.push(info);
            else
                this._destroyLine(info);
        }
        this._lineInfos = kept;
        this._lastActiveLabelIds = null;
    }
    // ── Сэмплирование ──
    _sampleMeridianGeo(lon, N) {
        const map = this._map;
        const pts = [];
        const crs = [];
        const latMin = -89.99, latMax = 89.99;
        for (let i = 0; i <= N; i++) {
            const lat = latMin + (latMax - latMin) * (i / N);
            const world = map.projectSafe([lon, lat], this._crsRaw);
            if (!world)
                continue;
            pts.push([world[0], this._altitude, world[1]]);
            crs.push([lon, lat]);
        }
        return { pts, crs };
    }
    _sampleParallelGeo(lat, N) {
        const map = this._map;
        const pts = [];
        const crs = [];
        for (let i = 0; i <= N; i++) {
            const lon = -180 + 360 * (i / N);
            const world = map.projectSafe([lon, lat], this._crsRaw);
            if (!world)
                continue;
            pts.push([world[0], this._altitude, world[1]]);
            crs.push([lon, lat]);
        }
        return { pts, crs };
    }
    _sampleMeridianProj(x, N) {
        const map = this._map;
        const crs = this._crsRaw;
        const yMin = -crs.halfExtentY, yMax = crs.halfExtentY;
        const pts = [];
        const crsArr = [];
        for (let i = 0; i <= N; i++) {
            const y = yMin + (yMax - yMin) * (i / N);
            const world = map.projectSafe([x, y], crs);
            if (!world)
                continue;
            pts.push([world[0], this._altitude, world[1]]);
            crsArr.push([x, y]);
        }
        return { pts, crs: crsArr };
    }
    _sampleParallelProj(y, N) {
        const map = this._map;
        const crs = this._crsRaw;
        const xMin = -crs.halfExtentX, xMax = crs.halfExtentX;
        const pts = [];
        const crsArr = [];
        for (let i = 0; i <= N; i++) {
            const x = xMin + (xMax - xMin) * (i / N);
            const world = map.projectSafe([x, y], crs);
            if (!world)
                continue;
            pts.push([world[0], this._altitude, world[1]]);
            crsArr.push([x, y]);
        }
        return { pts, crs: crsArr };
    }
    // ── Line2 ──
    _buildLine2(points) {
        const flat = [];
        for (const [x, y, z] of points) {
            if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z))
                continue;
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
    _destroyLine(info) {
        if (!info.line2)
            return;
        if (info.line2.parent)
            info.line2.parent.remove(info.line2);
        try {
            info.line2.geometry?.dispose();
        }
        catch { }
        info.line2 = null;
    }
    // ── Подписи ──
    _findEdgeAnchor(side, kind, sx, sy, vis, n, W, H) {
        const M = LABEL_MARGIN;
        const clampX = (x) => Math.max(M, Math.min(W - M, x));
        const clampY = (y) => Math.max(M, Math.min(H - M, y));
        for (let i = 0; i < n - 1; i++) {
            if (!vis[i] || !vis[i + 1])
                continue;
            const x1 = sx[i], y1 = sy[i];
            const x2 = sx[i + 1], y2 = sy[i + 1];
            if (side === 'top' || side === 'bottom') {
                const edgeY = side === 'top' ? 0 : H;
                const crosses = (y1 >= edgeY && y2 < edgeY)
                    || (y1 < edgeY && y2 >= edgeY);
                if (!crosses)
                    continue;
                const t = (edgeY - y1) / (y2 - y1);
                const x = x1 + (x2 - x1) * t;
                if (x < 0 || x > W)
                    continue;
                return { x: clampX(x), y: side === 'top' ? M : H - M };
            }
            else {
                const edgeX = side === 'left' ? 0 : W;
                const crosses = (x1 >= edgeX && x2 < edgeX)
                    || (x1 < edgeX && x2 >= edgeX);
                if (!crosses)
                    continue;
                const t = (edgeX - x1) / (x2 - x1);
                const y = y1 + (y2 - y1) * t;
                if (y < 0 || y > H)
                    continue;
                return { x: side === 'left' ? M : W - M, y: clampY(y) };
            }
        }
        const isNaturalSide = kind === 'meridian'
            ? (side === 'top' || side === 'bottom')
            : (side === 'left' || side === 'right');
        if (!isNaturalSide)
            return null;
        if (n < 2)
            return null;
        const lastI = n - 1;
        const isPositiveSide = kind === 'meridian'
            ? (side === 'top')
            : (side === 'right');
        if (isPositiveSide) {
            const endI = Math.ceil(lastI * 0.51);
            for (let i = lastI; i >= endI; i--) {
                if (!vis[i])
                    continue;
                const x = sx[i], y = sy[i];
                if (x < 0 || x > W || y < 0 || y > H)
                    continue;
                return { x: clampX(x), y: clampY(y) };
            }
        }
        else {
            const endI = Math.floor(lastI * 0.49);
            for (let i = 0; i <= endI; i++) {
                if (!vis[i])
                    continue;
                const x = sx[i], y = sy[i];
                if (x < 0 || x > W || y < 0 || y > H)
                    continue;
                return { x: clampX(x), y: clampY(y) };
            }
        }
        return null;
    }
    _updateLabelPositions(_viewport) {
        const map = this._map;
        const camera = map.camera;
        const canvas = map.renderer.domElement;
        const W = canvas.clientWidth;
        const H = canvas.clientHeight;
        const wgPos = map.worldGroup.position;
        const tmp = this._tmpVec;
        const sx = this._scratchSx;
        const sy = this._scratchSy;
        const vis = this._scratchVis;
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
            for (let i = 0; i < n; i++) {
                const [px, py, pz] = pts[i];
                tmp.set(px + wgPos.x, py + wgPos.y, pz + wgPos.z);
                tmp.project(camera);
                vis[i] = (tmp.z > -1 && tmp.z < 1) ? 1 : 0;
                sx[i] = (tmp.x * 0.5 + 0.5) * W;
                sy[i] = (-tmp.y * 0.5 + 0.5) * H;
            }
            for (const lbl of info.labels) {
                const anchor = this._findEdgeAnchor(lbl.side, info.kind, sx, sy, vis, n, W, H);
                if (anchor) {
                    lbl.screenPos = anchor;
                    lbl.visibleOnScreen = true;
                }
                else {
                    lbl.screenPos = null;
                    lbl.visibleOnScreen = false;
                }
            }
        }
    }
    _updateLabelsInTextManager() {
        const tm = this._map?.textManager;
        if (!tm)
            return;
        const z = this._map.continuousZoom;
        const show = this._showLabels && z >= this._labelMinZoom && z <= this._labelMaxZoom;
        if (!show) {
            if (this._lastActiveLabelIds !== null) {
                try {
                    tm.pruneStaleLabels(new Set(), this, { fade: true });
                }
                catch { }
                this._lastActiveLabelIds = null;
            }
            return;
        }
        const activeIds = new Set();
        const sources = [];
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
            tm.pruneStaleLabels(activeIds, this, { fade: true, graceMs: 200 });
        }
        catch (e) {
            console.warn(e);
        }
        for (const { id, source } of sources) {
            if (tm._labelsById && tm._labelsById.has(id))
                continue;
            try {
                tm.addLabel(source, id, this);
            }
            catch (e) {
                console.warn(e);
            }
        }
        this._lastActiveLabelIds = activeIds;
    }
    _setsEqual(a, b) {
        if (a.size !== b.size)
            return false;
        for (const v of a)
            if (!b.has(v))
                return false;
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
    getPoints(options = {}) {
        const includeIntersections = options.includeIntersections ?? true;
        const includeEdges = options.includeEdges ?? true;
        const visibleOnly = options.visibleOnly ?? true;
        const sides = options.sides
            ?? ['top', 'bottom', 'left', 'right'];
        const result = [];
        if (!this._map || !this._lineInfos.length)
            return result;
        const map = this._map;
        const camera = map.camera;
        const canvas = map.renderer.domElement;
        const W = canvas.clientWidth;
        const H = canvas.clientHeight;
        const wgPos = map.worldGroup.position;
        const tmp = new THREE.Vector3();
        const onScreen = (x, y, z) => {
            tmp.set(x + wgPos.x, y + wgPos.y, z + wgPos.z);
            tmp.project(camera);
            if (tmp.z <= -1 || tmp.z >= 1)
                return false;
            const px = (tmp.x * 0.5 + 0.5) * W;
            const py = (-tmp.y * 0.5 + 0.5) * H;
            return px >= -1 && px <= W + 1 && py >= -1 && py <= H + 1;
        };
        // ── 1. Пересечения ──
        if (includeIntersections) {
            const meridians = [];
            const parallels = [];
            for (const info of this._lineInfos) {
                (info.kind === 'meridian' ? meridians : parallels).push(info);
            }
            for (const m of meridians) {
                for (const p of parallels) {
                    const w2 = map.projectSafe([m.value, p.value], this._crsRaw);
                    if (!w2)
                        continue;
                    const world = [w2[0], this._altitude, w2[1]];
                    if (visibleOnly && !onScreen(world[0], world[1], world[2]))
                        continue;
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
            const sx = new Float32Array(SAMPLE_COUNT + 2);
            const sy = new Float32Array(SAMPLE_COUNT + 2);
            const vis = new Uint8Array(SAMPLE_COUNT + 2);
            for (const info of this._lineInfos) {
                const pts = info.points3D;
                const crsS = info.crsSamples;
                if (pts.length < 2 || crsS.length !== pts.length)
                    continue;
                const n = pts.length;
                for (let i = 0; i < n; i++) {
                    const [px, py, pz] = pts[i];
                    tmp.set(px + wgPos.x, py + wgPos.y, pz + wgPos.z);
                    tmp.project(camera);
                    vis[i] = (tmp.z > -1 && tmp.z < 1) ? 1 : 0;
                    sx[i] = (tmp.x * 0.5 + 0.5) * W;
                    sy[i] = (-tmp.y * 0.5 + 0.5) * H;
                }
                for (const side of sides) {
                    const crossings = this._findEdgeCrossings(side, sx, sy, vis, n, W, H);
                    for (const cr of crossings) {
                        const iA = cr.segment, iB = iA + 1, t = cr.t;
                        const pA = pts[iA], pB = pts[iB];
                        const cA = crsS[iA], cB = crsS[iB];
                        const world = [
                            pA[0] + (pB[0] - pA[0]) * t,
                            pA[1] + (pB[1] - pA[1]) * t,
                            pA[2] + (pB[2] - pA[2]) * t,
                        ];
                        const crs = [
                            cA[0] + (cB[0] - cA[0]) * t,
                            cA[1] + (cB[1] - cA[1]) * t,
                        ];
                        if (visibleOnly && !onScreen(world[0], world[1], world[2]))
                            continue;
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
    getPointsMap(options = {}) {
        const out = new Map();
        for (const p of this.getPoints(options)) {
            out.set(`${p.crs[0]},${p.crs[1]}`, p);
        }
        return out;
    }
    // ── Хелпер: все пересечения с ребром ──
    _findEdgeCrossings(side, sx, sy, vis, n, W, H) {
        const out = [];
        if (side === 'top' || side === 'bottom') {
            const edgeY = side === 'top' ? 0 : H;
            for (let i = 0; i < n - 1; i++) {
                if (!vis[i] || !vis[i + 1])
                    continue;
                const y1 = sy[i], y2 = sy[i + 1];
                const crosses = (y1 >= edgeY && y2 < edgeY)
                    || (y1 < edgeY && y2 >= edgeY);
                if (!crosses)
                    continue;
                const t = (edgeY - y1) / (y2 - y1);
                const x = sx[i] + (sx[i + 1] - sx[i]) * t;
                if (x < 0 || x > W)
                    continue;
                out.push({ segment: i, t });
            }
        }
        else {
            const edgeX = side === 'left' ? 0 : W;
            for (let i = 0; i < n - 1; i++) {
                if (!vis[i] || !vis[i + 1])
                    continue;
                const x1 = sx[i], x2 = sx[i + 1];
                const crosses = (x1 >= edgeX && x2 < edgeX)
                    || (x1 < edgeX && x2 >= edgeX);
                if (!crosses)
                    continue;
                const t = (edgeX - x1) / (x2 - x1);
                const y = sy[i] + (sy[i + 1] - sy[i]) * t;
                if (y < 0 || y > H)
                    continue;
                out.push({ segment: i, t });
            }
        }
        return out;
    }
    // ─────────────────────────────────────────────────────────────────
    // Форматирование
    // ─────────────────────────────────────────────────────────────────
    _formatLabel(value, isLat, step, isGeo) {
        if (!isGeo)
            return this._formatLinear(value, step);
        const abs = Math.abs(value);
        const dir = isLat
            ? (value > 0 ? 'С' : value < 0 ? 'Ю' : '')
            : (value > 0 ? 'В' : value < 0 ? 'З' : '');
        if (value === 0)
            return '0°';
        if (step >= 1) {
            const d = Math.round(abs);
            return dir ? `${d}°` : `${d}°`;
        }
        if (step >= 1 / 60 - 1e-12) {
            const deg = Math.floor(abs);
            const min = Math.round((abs - deg) * 60);
            if (min === 60)
                return dir ? `${deg + 1}°${dir}` : `${deg + 1}°`;
            if (deg === 0)
                return dir ? `${min}'${dir}` : `${min}'`;
            if (min === 0)
                return dir ? `${deg}°${dir}` : `${deg}°`;
            return dir ? `${deg}°${min}'${dir}` : `${deg}°${min}'`;
        }
        const deg = Math.floor(abs);
        const mFull = (abs - deg) * 60;
        const min = Math.floor(mFull);
        let sec = Math.round((mFull - min) * 60);
        if (sec === 60) {
            sec = 0;
        }
        if (deg === 0 && min === 0)
            return dir ? `${sec}"${dir}` : `${sec}"`;
        if (deg === 0)
            return dir ? `${min}'${sec}"${dir}` : `${min}'${sec}"`;
        if (sec === 0 && min === 0)
            return dir ? `${deg}°${dir}` : `${deg}°`;
        return dir ? `${deg}°${min}'${sec}"${dir}` : `${deg}°${min}'${sec}"`;
    }
    _formatLinear(value, step) {
        if (step >= 1000)
            return `${(value / 1000).toFixed(0)}km`;
        if (step >= 1)
            return `${Math.round(value)}m`;
        if (step >= 0.1)
            return `${value.toFixed(1)}m`;
        return `${value.toFixed(2)}m`;
    }
}
function round6(v) {
    return Math.round(v * 1e6) / 1e6;
}
function computeRoundness(value, step, isGeo) {
    const absV = Math.abs(value);
    const eps = Math.max(step * 1e-6, 1e-9);
    if (absV < eps)
        return 1000;
    if (isGeo && absV >= 179.999)
        return 999;
    if (isGeo) {
        const nice = [90, 60, 45, 30, 20, 15, 10, 5, 2, 1];
        for (let i = 0; i < nice.length; i++) {
            const d = nice[i];
            if (d < step * 0.999)
                continue;
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
        if (d < step * 0.999)
            continue;
        const rem = absV % d;
        if (rem < eps || d - rem < eps) {
            return 900 - i * 100;
        }
    }
    return 100;
}
