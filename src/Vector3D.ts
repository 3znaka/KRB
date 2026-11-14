/**
 * Vector3D — направленный 3D-вектор (ломаная со стрелкой) и опциональной
 * анимацией. После `addTo()` мутабелен.
 *
 * Наследует SpatialObject: zoom bounds, видимость, tooltip, onClick/onHover,
 * altitude и TextManager-контракт — из базового класса.
 * Специфика: ECEF, Line2-геометрия, статическая стрелка, анимации,
 * две подписи (start/end), LOD через Douglas–Peucker.
 *
 * @module Vector3D
 */

import { Projections } from './Projections.js';
import { SpatialObject, TitleAlignH, TitleAlignV, ZoomInterpolation } from './SpatialObject.js';
import {
    THREE,
    Line2,
    LineMaterial,
    LineGeometry,
    LineSegments2,
    LineSegmentsGeometry,
} from './js_TP/tpb.js';
import { douglasPeuckerIndices, simplifyRingIndices } from './Simplify.js';

// =====================================================================
// Типы
// =====================================================================

export type LonLat = [number, number];
export type Vector3DPosition = [number, number, number];
export type Vector3DColor = string | number;
export type ArrowSizeMode = 'px' | 'world';
export type Vector3DAltitudeMode = 'clampToGround' | 'absolute';
export type AnimationType = 'movingArrow' | 'flowArrows' | 'pulse' | 'part' | 'none';
export type PartMode = 'extend' | 'center' | 'boomerang' | 'dash';
export type Easing = 'linear' | 'sine' | 'easeIn' | 'easeOut' | 'easeInOut';
export type DashLengthMode = 'world' | 'fraction';
export type TitleRole = 'start' | 'end';

export interface Vector3DTitleOptions {
    text: string;
    style: Record<string, string | number>;
    minZoom: number;
    maxZoom: number;
    align: TitleAlignH;
    verticalAlign: TitleAlignV;
    offset: [number, number];
    allowOverflow: boolean;
    priority: number;
}

export interface AnimationSpec {
    type: AnimationType;
    period?: number;
    speed?: number;
    paused?: boolean;
    reverse?: boolean;
    fadeRatio?: number;
    color?: Vector3DColor | null;
    size?: number | null;
    sizeMode?: ArrowSizeMode | null;
    opacity?: number | null;

    easing?: Easing;
    hideStaticArrow?: boolean;
    count?: number;
    spacing?: number | null;
    minScale?: number;
    maxScale?: number;
    mode?: PartMode;
    dashLength?: number;
    dashLengthMode?: DashLengthMode;
    gapRatio?: number;
    offsetStep?: number;
    headCone?: boolean;
    headConeSize?: number | null;
    headConeColor?: Vector3DColor | null;
    width?: number | null;
    hideBaseLine?: boolean;
    fadeEdges?: boolean;
}

export interface Vector3DOptions {
    positions: Vector3DPosition[];
    crs?: string;
    color?: Vector3DColor;
    width?: number;
    arrowSize?: number;
    arrowSizeMode?: ArrowSizeMode;
    opacity?: number;
    depthTest?: boolean;
    depthWrite?: boolean;
    heightScale?: number;
    altitude?: number;
    /** @deprecated Используйте `altitude`. */
    altitudeOffset?: number;
    altitudeMode?: Vector3DAltitudeMode;
    minZoom?: number;
    maxZoom?: number;

    // Подписи
    title?: string;
    titleStart?: string;
    titleEnd?: string;
    titlePlacement?: TitleRole;
    titleStyle?: Record<string, string | number>;
    titleMinZoom?: number;
    titleMaxZoom?: number;
    titleAlign?: TitleAlignH;
    titleVerticalAlign?: TitleAlignV;
    titleOffset?: [number, number];
    titleAllowOverflow?: boolean;
    titlePriority?: number;

    // Per-role overrides
    titleStartStyle?: Record<string, string | number>;
    titleStartMinZoom?: number;
    titleStartMaxZoom?: number;
    titleStartAlign?: TitleAlignH;
    titleStartVerticalAlign?: TitleAlignV;
    titleStartOffset?: [number, number];
    titleStartAllowOverflow?: boolean;
    titleStartPriority?: number;

    titleEndStyle?: Record<string, string | number>;
    titleEndMinZoom?: number;
    titleEndMaxZoom?: number;
    titleEndAlign?: TitleAlignH;
    titleEndVerticalAlign?: TitleAlignV;
    titleEndOffset?: [number, number];
    titleEndAllowOverflow?: boolean;
    titleEndPriority?: number;

    tooltip?: string;
    onClick?: (event: MouseEvent, vector: Vector3D) => void;
    onHover?: (hovered: boolean) => void;

    animation?: AnimationSpec | string | Array<AnimationSpec | string> | null;
    properties?: Record<string, any>;
    userData?: Record<string, any>;
    zoomInterpolate?: ZoomInterpolation | null;

    // ── LOD ──
    simplify?: boolean;
    simplifyTolerance?: number;
    simplifyZoomBucket?: number;
}

interface ParsedAnimation {
    type: AnimationType;
    period: number;
    speed: number;
    paused: boolean;
    reverse: boolean;
    fadeRatio: number;
    color: Vector3DColor | null;
    size: number | null;
    sizeMode: ArrowSizeMode | null;
    opacity: number | null;
    easing?: Easing;
    hideStaticArrow?: boolean;
    count?: number;
    spacing?: number | null;
    minScale?: number;
    maxScale?: number;
    mode?: PartMode;
    dashLength?: number;
    dashLengthMode?: DashLengthMode;
    gapRatio?: number;
    offsetStep?: number;
    headCone?: boolean;
    headConeSize?: number | null;
    headConeColor?: Vector3DColor | null;
    width?: number | null;
    hideBaseLine?: boolean;
    fadeEdges?: boolean;
}

interface AnimSlot {
    config: ParsedAnimation;
    time: number;
    cone?: any;
    group?: any;
    cones?: any[];
    overlay?: any;
    overlayGeo?: any;
    overlayMat?: any;
    headConeGroup?: any;
    headConePool?: any[];
}

interface LabelEntry {
    role: TitleRole;
    handle: any;
    facade: any;
}

interface BoundingCache {
    cx: number; cy: number; cz: number; r: number;
}

// =====================================================================
// ECEF
// =====================================================================

const _A  = 6378137.0;
const _F  = 1 / 298.257222101;
const _B  = _A * (1 - _F);
const _E2 = 1 - (_B * _B) / (_A * _A);

export function ecefToGeodetic(
    X: number, Y: number, Z: number,
    ell: { a: number; f: number } = { a: _A, f: _F },
): [number, number, number] {
    const { a, f } = ell;
    const e2 = f * (2 - f);
    const b  = a * (1 - f);
    const p  = Math.sqrt(X * X + Y * Y);
    const lon = Math.atan2(Y, X);
    let lat = Math.atan2(Z, p * (1 - e2));
    for (let i = 0; i < 10; i++) {
        const s = Math.sin(lat);
        const N = a / Math.sqrt(1 - e2 * s * s);
        lat = Math.atan2(Z + e2 * N * s, p);
    }
    const sL = Math.sin(lat), cL = Math.cos(lat);
    const N = a / Math.sqrt(1 - e2 * sL * sL);
    const h = cL > 1e-10 ? p / cL - N : Math.abs(Z) - b;
    return [lon * 180 / Math.PI, lat * 180 / Math.PI, h];
}

export function enuToEcefDelta(e: number, n: number, u: number, lonRad: number, latRad: number): [number, number, number] {
    const sLo = Math.sin(lonRad), cLo = Math.cos(lonRad);
    const sLa = Math.sin(latRad), cLa = Math.cos(latRad);
    return [
        -sLo * e - sLa * cLo * n + cLa * cLo * u,
         cLo * e - sLa * sLo * n + cLa * sLo * u,
                      cLa * n    + sLa * u,
    ];
}

export const ECEF_CODES = new Set<string>([
    'EPSG:4978', 'EPSG:10176',
    'EPSG:7901', 'EPSG:7902', 'EPSG:7903', 'EPSG:7904',
    'EPSG:7905', 'EPSG:7906', 'EPSG:7907', 'EPSG:7908',
    'EPSG:7909', 'EPSG:7910', 'EPSG:7911', 'EPSG:7912',
    'EPSG:8403', 'EPSG:8404',
]);

export function isEcefCrs(code: string | null | undefined): boolean {
    return code ? ECEF_CODES.has(code.toUpperCase()) : false;
}

const CONE_RADIUS_RATIO = 0.35;
const FLOW_MAX_CONES = 50;
const MAX_DASH_SEGMENTS = 500;
const MAX_HEAD_CONES = 100;
const REBUILD_DEBOUNCE_MS = 60;

// =====================================================================
// Vector3D
// =====================================================================

export class Vector3D extends SpatialObject {
    // ── Данные ──
    private _positions: Vector3DPosition[];
    private _crsCode: string | null;
    private _crs: any | null;
    private _isEcef: boolean;

    // ── Оформление ── (altitude — в базе)
    private _color: Vector3DColor;
    private _width: number;
    private _arrowSize: number;
    private _arrowSizeMode: ArrowSizeMode;
    private _opacity: number;
    private _depthTest: boolean;
    private _depthWrite: boolean;
    private _heightScale: number;
    private _altitudeMode: Vector3DAltitudeMode;

    // ── Две подписи ──
    private _titles: { start: Vector3DTitleOptions; end: Vector3DTitleOptions };

    // ── Интерактив ──
    private _unregisterInteraction: (() => void) | null = null;

    // ── 3D-объекты ──
    private _group: any;
    private _line: any = null;
    private _material: any = null;
    private _geometry: any = null;
    private _cone: any = null;
    private _lastSegLen = 0;

    private _labels: LabelEntry[] = [];
    private _worldPoints: Vector3DPosition[] = [];

    // ── Анимации ──
    private _animList: AnimSlot[] = [];
    private _animPolyline: { lengths: number[]; total: number } | null = null;
    private _lastUpdateTime = 0;

    // ── clampToGround ──
    private _lastSurfaceUpdateTime = 0;
    private _lastWorldGroupPos: any;

    // ── LOD ──
    private _simplify: boolean = true;
    private _simplifyTolerance: number = 0.5;
    private _simplifyZoomBucket: number = 1;
    private _simplifyCache = new Map<number, Vector3DPosition[]>();
    private _simplifiedPoints: Vector3DPosition[] = [];
    private _currentSimplifyBucket = -1;
    private _pendingBucket = -1;
    private _rebuildTimer: ReturnType<typeof setTimeout> | null = null;
    private _pendingRebuild = false;

    // ── Кэши / перфоманс ──
    private _positionsDirty = true;
    private _bsCache: BoundingCache | null = null;

    /**
     * Локальный origin геометрии. Line2 / LineSegments2 хранят вершины во
     * Float32 — абсолютные world-координаты (~1e9) теряют точность,
     * соседние вершины после DP-упрощения на высоком зуме коллапсируют
     * в одну → NaN в шейдере. Считаем origin один раз от ПОЛНОГО набора.
     */
    private _localOrigin: any = new THREE.Vector3(0, 0, 0);
    private _localOriginValid = false;

    // ── Временные ──
    private _tempVecA: any;
    private _tempVecB: any;
    private _Y_AXIS: any;

    constructor(options: Vector3DOptions) {
        super();

        if (options.zoomInterpolate) this.setZoomInterpolations(options.zoomInterpolate);
        this._properties = options.properties ?? {};
        this._userData = options.userData ?? {};
        if (!options.positions || options.positions.length < 2) {
            throw new Error('Vector3D: options.positions required, at least 2 points');
        }

        this._positions = options.positions;
        this._crsCode = options.crs ?? null;
        this._crs = null;
        this._isEcef = isEcefCrs(this._crsCode);

        this._color = options.color ?? '#3388ff';
        this._width = options.width ?? 2;
        this._arrowSize = options.arrowSize ?? 10;
        this._arrowSizeMode = options.arrowSizeMode === 'world' ? 'world' : 'px';
        this._opacity = options.opacity ?? 1;
        this._depthTest = options.depthTest ?? false;
        this._depthWrite = options.depthWrite ?? this._depthTest;
        this._minZoom = options.minZoom ?? -Infinity;
        this._maxZoom = options.maxZoom ?? Infinity;
        this._heightScale = options.heightScale ?? 1;
        this._altitude = options.altitude ?? options.altitudeOffset ?? 0;
        this._altitudeMode = options.altitudeMode ?? 'absolute';

        this._simplify = options.simplify ?? true;
        this._simplifyTolerance = options.simplifyTolerance ?? 0.5;
        this._simplifyZoomBucket = options.simplifyZoomBucket ?? 1;

        this._titles = {
            start: this._parseTitleOptions(options, 'start'),
            end: this._parseTitleOptions(options, 'end'),
        };

        this._tooltipText = options.tooltip ?? '';
        this._onClick = options.onClick ?? null;
        this._onHover = options.onHover ?? null;

        this._group = new THREE.Group();

        this._tempVecA = new THREE.Vector3();
        this._tempVecB = new THREE.Vector3();
        this._Y_AXIS = new THREE.Vector3(0, 1, 0);
        this._lastWorldGroupPos = new THREE.Vector3();

        this._parseAnimationsInto(options.animation);
    }

    // =================================================================
    // Хуки SpatialObject
    // =================================================================

    protected _onAttached(map: any): void {
        this._crs = this._crsCode ? Projections.get(this._crsCode) : map.inputCRS;

        this._recomputeWorldPoints();
        if (this._worldPoints.length < 2) return;

        this._localOriginValid = false;
        this._ensureLocalOrigin();
        this._simplifyCache.clear();
        this._currentSimplifyBucket = -1;
        this._pendingBucket = -1;
        this._pendingRebuild = false;
        if (this._rebuildTimer) { clearTimeout(this._rebuildTimer); this._rebuildTimer = null; }

        const initialBucket = this._simplify
            ? Math.floor(map.currentDiscreteZoom / this._simplifyZoomBucket)
            : -1;
        this._doRebuildForBucket(initialBucket);

        this._buildLine(map);
        this._buildStaticCone();
        if (this._animList.length) this._setupAnimations(map);

        map.worldGroup.add(this._group);

        this._registerInteraction(map);
        this._attachLabels(map);

        this._lastWorldGroupPos.copy(map.worldGroup.position);
        this._lastSurfaceUpdateTime = 0;
        this._lastUpdateTime = 0;
        this._positionsDirty = true;
    }

    protected _teardown(): void {
        if (this._rebuildTimer) { clearTimeout(this._rebuildTimer); this._rebuildTimer = null; }
        this._pendingBucket = -1;
        this._pendingRebuild = false;

        if (this._unregisterInteraction) {
            this._unregisterInteraction();
            this._unregisterInteraction = null;
        }

        if (this._map?.textManager) {
            for (const { handle } of this._labels) {
                this._map.textManager.removeLabel(handle);
            }
        }
        this._labels = [];

        this._teardownAnimations();

        if (this._group.parent) this._group.parent.remove(this._group);

        for (const child of [...this._group.children]) {
            if (child.geometry && typeof child.geometry.dispose === 'function') {
                child.geometry.dispose();
            }
            if (child.material) {
                const mats = Array.isArray(child.material) ? child.material : [child.material];
                for (const m of mats) if (m && typeof m.dispose === 'function') m.dispose();
            }
            this._group.remove(child);
        }

        this._line = null;
        this._material = null;
        this._geometry = null;
        this._cone = null;
        this._lastSegLen = 0;
        this._lastUpdateTime = 0;
        this._lastSurfaceUpdateTime = 0;
        this._crs = null;

        this._worldPoints = [];
        this._simplifiedPoints = [];
        this._simplifyCache.clear();
        this._currentSimplifyBucket = -1;
        this._localOriginValid = false;
        this._positionsDirty = true;
        this._bsCache = null;
        this._animPolyline = null;
    }

    protected _applyHidden(): void {
        if (this._group) this._group.visible = false;
    }

    protected _onTooltipChanged(): void {
        if (this._map) this._registerInteraction(this._map);
    }

    protected _onAltitudeChanged(): void {
        if (!this._map) {
            this._positionsDirty = true;
            return;
        }
        this._recomputeWorldPoints();
        this._localOriginValid = false;
        this._ensureLocalOrigin();
        this._invalidateGeometryAndAnimations();
    }

    getLabelType(): 'point' { return 'point'; }

    // =================================================================
    // Подписи: start/end через фасады
    // =================================================================

    override setTitle(text: string): this { return this.setTitleStart(text); }
    override getText(): string { return this._titles.start.text; }

    override getTextStyle(): Record<string, string | number> {
        return Object.assign({
            fontFamily: 'sans-serif',
            color: '#ffffff',
            fontSize: '12px',
            fontWeight: 'bold',
            textShadow: '1px 1px 2px rgba(0,0,0,0.9), -1px -1px 2px rgba(0,0,0,0.9)',
        }, this._titles.start.style);
    }

    override getTextZoomBounds(): { min: number; max: number } {
        return { min: this._titles.start.minZoom, max: this._titles.start.maxZoom };
    }

    override getTitleAlign(): TitleAlignH { return this._titles.start.align; }
    override getTitleVerticalAlign(): TitleAlignV { return this._titles.start.verticalAlign; }
    override getTitleOffset(): [number, number] { return this._titles.start.offset; }
    override getAllowOverflow(): boolean { return this._titles.start.allowOverflow; }
    override getPriority(): number { return this._titles.start.priority; }

    override getScreenPosition(): { x: number; y: number } | null {
        return this._getScreenPositionAt('start');
    }

    private _parseTitleOptions(options: Vector3DOptions, role: TitleRole): Vector3DTitleOptions {
        const isStart = role === 'start';
        const sfx = isStart ? 'Start' : 'End';
        const placement = options.titlePlacement;

        let text: string;
        if (isStart) {
            text = options.titleStart ?? (placement === 'end' ? '' : (options.title ?? ''));
        } else {
            text = options.titleEnd ?? (placement === 'end' ? (options.title ?? '') : '');
        }

        const pick = <K extends keyof Vector3DOptions>(common: K, specific: K, def: any): any =>
            (options as any)[specific] ?? (options as any)[common] ?? def;

        return {
            text,
            style: pick('titleStyle', `title${sfx}Style` as any, {}),
            minZoom: pick('titleMinZoom', `title${sfx}MinZoom` as any, -Infinity),
            maxZoom: pick('titleMaxZoom', `title${sfx}MaxZoom` as any, Infinity),
            align: pick('titleAlign', `title${sfx}Align` as any, 'center'),
            verticalAlign: pick('titleVerticalAlign', `title${sfx}VerticalAlign` as any,
                isStart ? 'bottom' : 'top'),
            offset: pick('titleOffset', `title${sfx}Offset` as any,
                isStart ? [0, -10] : [0, 10]),
            allowOverflow: pick('titleAllowOverflow', `title${sfx}AllowOverflow` as any, false),
            priority: pick('titlePriority', `title${sfx}Priority` as any, 0),
        };
    }

    private _makeLabelFacade(role: TitleRole): any {
        const v = this;
        const t = () => v._titles[role];
        return {
            getText: () => t().text,
            getTextStyle: () => Object.assign({
                fontFamily: 'sans-serif',
                color: '#ffffff',
                fontSize: '12px',
                fontWeight: 'bold',
                textShadow: '1px 1px 2px rgba(0,0,0,0.9), -1px -1px 2px rgba(0,0,0,0.9)',
            }, t().style),
            getTextZoomBounds: () => ({ min: t().minZoom, max: t().maxZoom }),
            getLabelType: () => 'point' as const,
            isVisible: () => {
                if (!v._layer || !(v._layer as any).visible) return false;
                if (!v._map) return false;
                const z = v._map.continuousZoom;
                return z >= t().minZoom && z <= t().maxZoom;
            },
            getScreenPosition: () => v._getScreenPositionAt(role),
            getTitleAlign: () => t().align,
            getTitleVerticalAlign: () => t().verticalAlign,
            getTitleOffset: () => t().offset,
            getAllowOverflow: () => t().allowOverflow,
            getPriority: () => t().priority,
        };
    }

    private _getScreenPositionAt(role: TitleRole): { x: number; y: number } | null {
        if (!this._map || this._worldPoints.length < 2) return null;
        const pt = role === 'end'
            ? this._worldPoints[this._worldPoints.length - 1]
            : this._worldPoints[0];
        const map = this._map;
        const wgPos = map.worldGroup.position;
        const vec = map.getVec3().set(pt[0] + wgPos.x, pt[1] + wgPos.y, pt[2] + wgPos.z);
        vec.project(map.camera);
        if (vec.z > 1) return null;
        const canvas = map.renderer.domElement;
        return {
            x: (vec.x * 0.5 + 0.5) * canvas.clientWidth,
            y: (-vec.y * 0.5 + 0.5) * canvas.clientHeight,
        };
    }

    setTitleStart(text: string): this { return this._setTitleText('start', text ?? ''); }
    setTitleEnd(text: string): this { return this._setTitleText('end', text ?? ''); }
    getTitleStart(): string { return this._titles.start.text; }
    getTitleEnd(): string { return this._titles.end.text; }

    private _setTitleText(role: TitleRole, text: string): this {
        this._titles[role].text = text;
        const tm = this._map?.textManager;
        if (!tm) return this;

        const entry = this._labels.find(l => l.role === role);
        if (entry) {
            if (text) {
                if (typeof tm.updateLabel === 'function') tm.updateLabel(entry.handle);
            } else {
                tm.removeLabel(entry.handle);
                this._labels = this._labels.filter(l => l !== entry);
            }
        } else if (text) {
            const facade = this._makeLabelFacade(role);
            const handle = tm.addLabel(facade);
            this._labels.push({ role, handle, facade });
        }
        return this;
    }

    private _attachLabels(map: any): void {
        if (!map.textManager) return;
        for (const role of ['start', 'end'] as TitleRole[]) {
            const title = this._titles[role];
            if (!title.text) continue;
            const facade = this._makeLabelFacade(role);
            const handle = map.textManager.addLabel(facade);
            this._labels.push({ role, handle, facade });
        }
    }

    // =================================================================
    // Разбор анимаций
    // =================================================================

    private _parseAnimationsInto(anim: Vector3DOptions['animation']): void {
        this._animList = [];
        if (!anim) return;
        const arr = Array.isArray(anim) ? anim : [anim];
        for (const a of arr) {
            const cfg = this._parseOneAnimation(a);
            if (cfg) this._animList.push({ config: cfg, time: 0 });
        }
    }

    private _parseOneAnimation(
        anim: AnimationSpec | string | null | undefined | false
    ): ParsedAnimation | null {
        if (!anim) return null;
        const src: AnimationSpec = (typeof anim === 'string') ? { type: anim as AnimationType } : anim;
        const type: AnimationType = src.type ?? 'none';
        if (type === 'none') return null;

        const base: ParsedAnimation = {
            type,
            period: src.period ?? 3,
            speed: src.speed ?? 1,
            paused: src.paused ?? false,
            reverse: src.reverse ?? false,
            fadeRatio: Math.min(0.5, Math.max(0, src.fadeRatio ?? 0)),
            color: src.color ?? null,
            size: src.size ?? null,
            sizeMode: src.sizeMode ?? null,
            opacity: src.opacity ?? null,
        };

        if (type === 'movingArrow') {
            base.easing = src.easing ?? 'sine';
            base.hideStaticArrow = src.hideStaticArrow ?? true;
        }

        if (type === 'flowArrows') {
            base.count = src.count ?? 3;
            base.spacing = src.spacing ?? null;
            base.hideStaticArrow = src.hideStaticArrow ?? true;
        }

        if (type === 'pulse') {
            base.minScale = src.minScale ?? 0.4;
            base.maxScale = src.maxScale ?? 1.2;
            base.easing = src.easing ?? 'sine';
            base.hideStaticArrow = src.hideStaticArrow ?? false;
        }

        if (type === 'part') {
            base.mode = src.mode ?? 'extend';
            let defaultEasing: Easing;
            switch (base.mode) {
                case 'dash':      defaultEasing = 'linear';    break;
                case 'extend':    defaultEasing = 'linear';    break;
                case 'boomerang': defaultEasing = 'easeInOut'; break;
                case 'center':
                default:          defaultEasing = 'sine';      break;
            }
            base.easing = src.easing ?? defaultEasing;
            base.dashLength = src.dashLength ?? 20;
            base.dashLengthMode = src.dashLengthMode ?? 'world';
            base.gapRatio = src.gapRatio ?? 1;
            base.offsetStep = src.offsetStep ?? 1;
            base.headCone = src.headCone ?? false;
            base.headConeSize = src.headConeSize ?? null;
            base.headConeColor = src.headConeColor ?? null;
            base.width = src.width ?? null;
            base.hideBaseLine = src.hideBaseLine ?? true;
            base.fadeEdges = src.fadeEdges ?? false;
            base.hideStaticArrow = src.hideStaticArrow ?? true;
        }

        return base;
    }

    private _applyEasing(easing: Easing, phase: number): number {
        if (easing === 'linear') return phase;
        if (easing === 'easeIn') return phase * phase;
        if (easing === 'easeOut') return 1 - (1 - phase) * (1 - phase);
        if (easing === 'easeInOut') {
            return phase < 0.5 ? 2 * phase * phase : 1 - 2 * (1 - phase) * (1 - phase);
        }
        return 0.5 - 0.5 * Math.cos(phase * Math.PI * 2);
    }

    // =================================================================
    // Путь анимации — ВСЕГДА полный (не-LOD)
    // =================================================================

    private _computePolylineData(): { lengths: number[]; total: number } | null {
        const pts = this._worldPoints;
        if (!pts || pts.length < 2) return null;
        const lengths = [0];
        let total = 0;
        for (let i = 1; i < pts.length; i++) {
            const dx = pts[i][0] - pts[i - 1][0];
            const dy = pts[i][1] - pts[i - 1][1];
            const dz = pts[i][2] - pts[i - 1][2];
            total += Math.sqrt(dx * dx + dy * dy + dz * dz);
            lengths.push(total);
        }
        if (total <= 0) return null;
        return { lengths, total };
    }

    private _getPointAtT(t: number, outPos: any, outTangent: any): boolean {
        const poly = this._animPolyline;
        if (!poly || poly.total <= 0) return false;

        const len = (((t % 1) + 1) % 1) * poly.total;
        let i = 1;
        while (i < poly.lengths.length && poly.lengths[i] < len) i++;
        if (i >= poly.lengths.length) i = poly.lengths.length - 1;

        const segStart = poly.lengths[i - 1];
        const segLen = poly.lengths[i] - segStart;
        const localT = segLen > 0 ? (len - segStart) / segLen : 0;

        const p0 = this._worldPoints[i - 1];
        const p1 = this._worldPoints[i];

        outPos.set(
            p0[0] + (p1[0] - p0[0]) * localT,
            p0[1] + (p1[1] - p0[1]) * localT,
            p0[2] + (p1[2] - p0[2]) * localT
        );
        outTangent.set(p1[0] - p0[0], p1[1] - p0[1], p1[2] - p0[2]);
        if (outTangent.lengthSq() < 1e-12) outTangent.set(0, 1, 0);
        else outTangent.normalize();
        return true;
    }

    private _emitRangeSegments(t0: number, t1: number, out: number[]): void {
        const poly = this._animPolyline;
        if (!poly) return;
        const L = poly.total;
        const a = Math.max(0, Math.min(1, t0)) * L;
        const b = Math.max(0, Math.min(1, t1)) * L;
        if (b <= a) return;

        let i = 1;
        while (i < poly.lengths.length && poly.lengths[i] <= a) i++;
        if (i >= poly.lengths.length) return;

        while (i < poly.lengths.length && poly.lengths[i - 1] < b) {
            const segStart = poly.lengths[i - 1];
            const segEnd = poly.lengths[i];
            const segLen = segEnd - segStart;
            if (segLen <= 0) { i++; continue; }

            const u0 = Math.max(0, (a - segStart) / segLen);
            const u1 = Math.min(1, (b - segStart) / segLen);

            if (u1 > u0) {
                const pA = this._worldPoints[i - 1];
                const pB = this._worldPoints[i];
                out.push(
                    pA[0] + (pB[0] - pA[0]) * u0,
                    pA[1] + (pB[1] - pA[1]) * u0,
                    pA[2] + (pB[2] - pA[2]) * u0,
                    pA[0] + (pB[0] - pA[0]) * u1,
                    pA[1] + (pB[1] - pA[1]) * u1,
                    pA[2] + (pB[2] - pA[2]) * u1
                );
            }
            i++;
        }
    }

    // =================================================================
    // LOD
    // =================================================================

    private _worldPerPixel(z: number): number {
        return this._map.WORLD_SIZE / (Math.pow(2, z) * this._map.TILE_PIXELS);
    }

    private _getSimplifiedData(bucket: number): Vector3DPosition[] {
        if (!this._simplify || !this._map || bucket < 0) return this._worldPoints;
        const hit = this._simplifyCache.get(bucket);
        if (hit) return hit;

        const pts = this._worldPoints;
        const n = pts.length;
        if (n < 3) {
            this._simplifyCache.set(bucket, pts);
            return pts;
        }

        const z = bucket * this._simplifyZoomBucket;
        const tolWorld = this._worldPerPixel(z) * this._simplifyTolerance;

        const pts2D: [number, number][] = new Array(n);
        for (let i = 0; i < n; i++) pts2D[i] = [pts[i][0], pts[i][2]];

        const isClosed =
            n >= 4 &&
            pts2D[0][0] === pts2D[n - 1][0] &&
            pts2D[0][1] === pts2D[n - 1][1];

        const keptIdx = isClosed
            ? simplifyRingIndices(pts2D, tolWorld)
            : douglasPeuckerIndices(pts2D, tolWorld);

        if ((isClosed && keptIdx.length < 3) || keptIdx.length < 2 || keptIdx.length === n) {
            this._simplifyCache.set(bucket, pts);
            return pts;
        }

        const simplified: Vector3DPosition[] = new Array(keptIdx.length);
        for (let k = 0; k < keptIdx.length; k++) simplified[k] = pts[keptIdx[k]];
        this._simplifyCache.set(bucket, simplified);
        return simplified;
    }

    private _doRebuildForBucket(bucket: number, data?: Vector3DPosition[]): void {
        if (!this._map) return;
        this._pendingRebuild = false;
        this._currentSimplifyBucket = bucket;

        this._ensureLocalOrigin();

        const resolved = data ?? this._getSimplifiedData(bucket);
        this._simplifiedPoints = resolved;
        this._positionsDirty = true;
        this._bsCache = null;
    }

    private _onSimplifyBucketChange(bucket: number): void {
        if (bucket === this._currentSimplifyBucket) return;
        const prevCount = this._simplifiedPoints.length;
        const data = this._getSimplifiedData(bucket);
        if (prevCount > 0 && data.length === prevCount && this._currentSimplifyBucket >= 0) {
            this._currentSimplifyBucket = bucket;
            return;
        }
        if (!this._isVisible) { this._pendingRebuild = true; return; }
        this._doRebuildForBucket(bucket, data);
    }

    private _scheduleBucketChange(bucket: number): void {
        if (this._rebuildTimer) { this._pendingBucket = bucket; return; }
        this._pendingBucket = bucket;
        this._rebuildTimer = setTimeout(() => {
            this._rebuildTimer = null;
            if (!this._map) return;
            const b = this._pendingBucket;
            this._pendingBucket = -1;
            if (b >= 0 && b !== this._currentSimplifyBucket) this._onSimplifyBucketChange(b);
        }, REBUILD_DEBOUNCE_MS);
    }

    private _applySimplification(zoom: number): void {
        if (!this._simplify || !this._map) return;
        const bucket = Math.floor(zoom / this._simplifyZoomBucket);
        if (bucket === this._currentSimplifyBucket) return;

        if (this._map._zoomActive || this._map._cameraAnimation) {
            this._scheduleBucketChange(bucket);
            return;
        }
        this._doRebuildForBucket(bucket);
    }

    // =================================================================
    // Локальный origin
    // =================================================================

    private _ensureLocalOrigin(): void {
        if (this._localOriginValid) return;
        const pts = this._worldPoints;
        if (!pts.length) {
            this._localOrigin.set(0, 0, 0);
            this._localOriginValid = true;
            return;
        }
        let sx = 0, sz = 0;
        for (let i = 0; i < pts.length; i++) { sx += pts[i][0]; sz += pts[i][2]; }
        this._localOrigin.set(sx / pts.length, 0, sz / pts.length);
        this._localOriginValid = true;
    }

    // =================================================================
    // Интерактив
    // =================================================================

    private _registerInteraction(map: any): void {
        if (!map.interaction) return;
        if (this._unregisterInteraction) {
            this._unregisterInteraction();
            this._unregisterInteraction = null;
        }
        if (!this._onClick && !this._onHover && !this._tooltipText) return;

        this._unregisterInteraction = map.interaction.register(this, {
            getMeshes: () => {
                const meshes: any[] = [];
                if (this._line && this._line.visible) meshes.push(this._line);
                if (this._cone && this._cone.visible) meshes.push(this._cone);
                for (const anim of this._animList) {
                    if (anim.config.type === 'flowArrows' && anim.cones) {
                        for (const c of anim.cones) if (c.visible) meshes.push(c);
                    }
                    if (anim.config.type === 'movingArrow' && anim.cone && anim.cone.visible) {
                        meshes.push(anim.cone);
                    }
                    if (anim.config.type === 'part' && anim.headConePool) {
                        for (const c of anim.headConePool) if (c.visible) meshes.push(c);
                    }
                }
                return meshes;
            },
            getBoundingSphere: () => {
                if (this._worldPoints.length < 2) return null;

                let c = this._bsCache;
                if (!c) {
                    let minX = Infinity, minY = Infinity, minZ = Infinity;
                    let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
                    for (const p of this._worldPoints) {
                        if (p[0] < minX) minX = p[0];
                        if (p[0] > maxX) maxX = p[0];
                        if (p[1] < minY) minY = p[1];
                        if (p[1] > maxY) maxY = p[1];
                        if (p[2] < minZ) minZ = p[2];
                        if (p[2] > maxZ) maxZ = p[2];
                    }
                    if (!isFinite(minX)) return null;
                    const dx = maxX - minX, dy = maxY - minY, dz = maxZ - minZ;
                    c = this._bsCache = {
                        cx: (minX + maxX) / 2,
                        cy: (minY + maxY) / 2,
                        cz: (minZ + maxZ) / 2,
                        r: 0.5 * Math.sqrt(dx * dx + dy * dy + dz * dz),
                    };
                }
                const wgPos = map.worldGroup.position;
                return {
                    center: map.getVec3().set(c.cx + wgPos.x, c.cy + wgPos.y, c.cz + wgPos.z),
                    radius: c.r,
                };
            },
            onClick: this._onClick || null,
            onHover: this._onHover || null,
            getTooltip: this._tooltipText ? () => this._tooltipText : null,
            isVisible: () => this._isVisible,
        });
    }

    // =================================================================
    // Setup / teardown анимаций
    // =================================================================

    private _setupAnimations(map: any): void {
        this._animPolyline = this._computePolylineData();
        if (!this._animPolyline) return;

        for (const anim of this._animList) {
            anim.time = 0;
            this._setupOneAnimation(anim, map);
        }

        if (this._cone) {
            const hide = this._animList.some(a => a.config.hideStaticArrow);
            if (hide) this._cone.visible = false;
        }
    }

    private _setupOneAnimation(anim: AnimSlot, map: any): void {
        const o = anim.config;

        if (o.type === 'movingArrow') {
            const geo = new THREE.ConeGeometry(CONE_RADIUS_RATIO, 1, 12);
            geo.translate(0, 0.5, 0);
            const opacity = o.opacity ?? this._opacity;
            const mat = new THREE.MeshBasicMaterial({
                color: o.color ?? this._color,
                opacity,
                transparent: opacity < 1,
                depthTest: this._depthTest,
                depthWrite: this._depthWrite,
            });
            const cone = new THREE.Mesh(geo, mat);
            cone.renderOrder = 999;
            cone.visible = false;
            this._group.add(cone);
            anim.cone = cone;
        }

        if (o.type === 'flowArrows') {
            const group = new THREE.Group();
            this._group.add(group);
            anim.group = group;
            anim.cones = [];

            let count = o.count!;
            if (o.spacing != null && o.spacing > 0 && this._animPolyline && this._animPolyline.total > 0) {
                count = Math.round(this._animPolyline.total / o.spacing);
            }
            count = Math.max(1, Math.min(FLOW_MAX_CONES, count));

            const color = o.color ?? this._color;
            const opacity = o.opacity ?? this._opacity;

            for (let i = 0; i < count; i++) {
                const g = new THREE.ConeGeometry(CONE_RADIUS_RATIO, 1, 12);
                g.translate(0, 0.5, 0);
                const m = new THREE.MeshBasicMaterial({
                    color, opacity,
                    transparent: opacity < 1,
                    depthTest: this._depthTest,
                    depthWrite: this._depthWrite,
                });
                const c = new THREE.Mesh(g, m);
                c.renderOrder = 999;
                group.add(c);
                anim.cones.push(c);
            }
        }

        if (o.type === 'part') {
            const geo = new LineSegmentsGeometry();
            geo.setPositions(new Float32Array(0));
            const opacity = o.opacity ?? this._opacity;
            const mat = new LineMaterial({
                color: o.color ?? this._color,
                linewidth: o.width ?? this._width,
                opacity,
                transparent: opacity < 1,
                depthTest: this._depthTest,
                depthWrite: this._depthWrite,
                resolution: new THREE.Vector2(
                    map.renderer.domElement.width,
                    map.renderer.domElement.height
                ),
            });
            const overlay = new LineSegments2(geo, mat);
            overlay.renderOrder = 999;
            overlay.visible = false;
            overlay.frustumCulled = false;
            overlay.position.copy(this._localOrigin);
            this._group.add(overlay);
            anim.overlay = overlay;
            anim.overlayGeo = geo;
            anim.overlayMat = mat;

            if (o.hideBaseLine && this._line) this._line.visible = false;

            if (o.headCone) {
                anim.headConeGroup = new THREE.Group();
                this._group.add(anim.headConeGroup);
                anim.headConePool = [];
            }
        }
    }

    private _teardownAnimations(): void {
        for (const anim of this._animList) {
            const o = anim.config;

            if (o.type === 'movingArrow' && anim.cone) {
                anim.cone.geometry.dispose();
                anim.cone.material.dispose();
                if (anim.cone.parent) anim.cone.parent.remove(anim.cone);
                anim.cone = undefined;
            }

            if (o.type === 'flowArrows' && anim.group) {
                for (const c of anim.cones || []) {
                    c.geometry.dispose();
                    c.material.dispose();
                }
                if (anim.group.parent) anim.group.parent.remove(anim.group);
                anim.group = undefined;
                anim.cones = undefined;
            }

            if (o.type === 'part') {
                if (anim.overlay) {
                    anim.overlay.geometry.dispose();
                    anim.overlay.material.dispose();
                    if (anim.overlay.parent) anim.overlay.parent.remove(anim.overlay);
                    anim.overlay = undefined;
                    anim.overlayGeo = undefined;
                    anim.overlayMat = undefined;
                }
                if (anim.headConeGroup) {
                    for (const c of anim.headConePool || []) {
                        c.geometry.dispose();
                        c.material.dispose();
                    }
                    if (anim.headConeGroup.parent) {
                        anim.headConeGroup.parent.remove(anim.headConeGroup);
                    }
                    anim.headConeGroup = undefined;
                    anim.headConePool = undefined;
                }
                if (o.hideBaseLine && this._line) this._line.visible = true;
            }
        }

        this._animPolyline = null;

        if (this._cone) {
            this._cone.visible = true;
            this._cone.material.opacity = this._opacity;
            this._cone.material.transparent = this._opacity < 1;
            if (this._map && this._worldPoints.length >= 2) {
                this._resetStaticConePosition();
            }
        }
    }

    // =================================================================
    // Шаг анимаций
    // =================================================================

    private _stepAllAnimations(map: any, deltaTime: number): void {
        for (const anim of this._animList) {
            const o = anim.config;
            if (!o.paused) anim.time += deltaTime * o.speed;

            const period = Math.max(0.05, o.period);
            let phase = (anim.time / period) % 1;
            if (phase < 0) phase += 1;

            if (o.type === 'movingArrow')      this._stepMovingArrow(anim, map, phase);
            else if (o.type === 'flowArrows')  this._stepFlowArrows(anim, map, phase);
            else if (o.type === 'pulse')       this._stepPulse(anim, map, phase);
            else if (o.type === 'part')        this._stepPart(anim, map, phase);
        }
    }

    private _stepMovingArrow(anim: AnimSlot, map: any, phase: number): void {
        const o = anim.config;
        if (!anim.cone) return;
        anim.cone.visible = true;

        const t = o.reverse ? 1 - phase : phase;
        if (!this._getPointAtT(t, this._tempVecA, this._tempVecB)) return;

        anim.cone.position.copy(this._tempVecA);
        if (o.reverse) this._tempVecB.negate();
        anim.cone.quaternion.setFromUnitVectors(this._Y_AXIS, this._tempVecB);

        const baseOpacity = o.opacity ?? this._opacity;
        let finalOpacity = baseOpacity;
        if (o.fadeRatio > 0) {
            const edge = Math.min(t, 1 - t) / o.fadeRatio;
            finalOpacity = baseOpacity * Math.max(0, Math.min(1, edge));
        }
        anim.cone.material.opacity = finalOpacity;
        anim.cone.material.transparent = finalOpacity < 1;

        this._applyConeScale(map, anim.cone, o.size, o.sizeMode);
    }

    private _stepFlowArrows(anim: AnimSlot, map: any, phase: number): void {
        if (!anim.cones || !anim.cones.length) return;
        const o = anim.config;
        const n = anim.cones.length;
        const baseOpacity = o.opacity ?? this._opacity;

        for (let i = 0; i < n; i++) {
            const cone = anim.cones[i];
            let t = (phase + i / n) % 1;
            if (o.reverse) t = 1 - t;

            if (!this._getPointAtT(t, this._tempVecA, this._tempVecB)) {
                cone.visible = false;
                continue;
            }
            cone.visible = true;
            cone.position.copy(this._tempVecA);
            if (o.reverse) this._tempVecB.negate();
            cone.quaternion.setFromUnitVectors(this._Y_AXIS, this._tempVecB);

            let finalOpacity = baseOpacity;
            if (o.fadeRatio > 0) {
                const edge = Math.min(t, 1 - t) / o.fadeRatio;
                finalOpacity = baseOpacity * Math.max(0, Math.min(1, edge));
            }
            cone.material.opacity = finalOpacity;
            cone.material.transparent = finalOpacity < 1;

            this._applyConeScale(map, cone, o.size, o.sizeMode);
        }
    }

    private _stepPulse(anim: AnimSlot, map: any, phase: number): void {
        const o = anim.config;
        if (!this._cone || !this._cone.visible) return;

        let s: number;
        if (o.easing === 'linear') {
            s = phase < 0.5 ? phase * 2 : 2 - phase * 2;
        } else if (o.easing === 'sine' || !o.easing) {
            s = 0.5 - 0.5 * Math.cos(phase * Math.PI * 2);
        } else {
            const tri = 1 - Math.abs(2 * phase - 1);
            s = this._applyEasing(o.easing, tri);
        }

        const mult = o.minScale! + (o.maxScale! - o.minScale!) * s;
        const base = o.size ?? this._arrowSize;
        this._applyConeScale(map, this._cone, base * mult, o.sizeMode);
    }

    private _stepPart(anim: AnimSlot, map: any, phase: number): void {
        const o = anim.config;
        if (!anim.overlay) return;

        let ranges: Array<[number, number]> = [];

        if (o.mode === 'extend') {
            const f = this._applyEasing(o.easing!, phase);
            ranges = [o.reverse ? [1 - f, 1] : [0, f]];
        } else if (o.mode === 'center') {
            const f = this._applyEasing(o.easing!, phase);
            ranges = [[0.5 - f / 2, 0.5 + f / 2]];
        } else if (o.mode === 'boomerang') {
            const tri = 1 - Math.abs(2 * phase - 1);
            const f = this._applyEasing(o.easing!, tri);
            ranges = [o.reverse ? [1 - f, 1] : [0, f]];
        } else if (o.mode === 'dash') {
            const f = this._applyEasing(o.easing!, phase);
            ranges = this._computeDashRanges(o, f);
        }

        ranges = ranges.filter(([a, b]) => b > a);
        this._rebuildOverlay(anim, map, ranges);
        if (o.headCone) this._rebuildHeadCones(anim, map, ranges);
    }

    private _computeDashRanges(o: ParsedAnimation, phase: number): Array<[number, number]> {
        if (!this._animPolyline) return [];
        const L = this._animPolyline.total;
        const dashLen = o.dashLengthMode === 'fraction' ? o.dashLength! * L : o.dashLength!;
        const gapLen = dashLen * (o.gapRatio ?? 1);
        const step = dashLen + gapLen;
        if (step <= 0) return [];

        const count = Math.min(MAX_DASH_SEGMENTS, Math.ceil(L / step) + 2);
        let shift = phase * step * (o.offsetStep ?? 1);
        if (o.reverse) shift = -shift;

        const ranges: Array<[number, number]> = [];
        for (let i = -1; i < count; i++) {
            const startLen = i * step + shift;
            const endLen = startLen + dashLen;
            const cs = Math.max(0, startLen);
            const ce = Math.min(L, endLen);
            if (ce > cs) ranges.push([cs / L, ce / L]);
        }
        return ranges;
    }

    private _rebuildOverlay(anim: AnimSlot, map: any, ranges: Array<[number, number]>): void {
        const positions: number[] = [];
        for (const [t0, t1] of ranges) {
            this._emitRangeSegments(t0, t1, positions);
            if (positions.length / 6 > MAX_DASH_SEGMENTS) break;
        }

        if (positions.length === 0) {
            anim.overlay.visible = false;
            return;
        }

        // Сдвигаем в локальный origin (Float32-стабильность LineSegments2).
        this._ensureLocalOrigin();
        const ox = this._localOrigin.x;
        const oz = this._localOrigin.z;
        for (let i = 0; i < positions.length; i += 3) {
            positions[i]     -= ox;
            positions[i + 2] -= oz;
        }
        anim.overlay.position.copy(this._localOrigin);

        const instanceCount = positions.length / 6;

        anim.overlayGeo.setPositions(positions);
        (anim.overlayGeo as any)._maxInstanceCount = undefined;
        anim.overlayGeo.instanceCount = instanceCount;

        anim.overlayGeo.computeBoundingSphere();
        anim.overlay.visible = true;
    }

    private _rebuildHeadCones(anim: AnimSlot, map: any, ranges: Array<[number, number]>): void {
        if (!anim.headConeGroup || !anim.headConePool) return;
        const o = anim.config;
        const pool = anim.headConePool;
        const n = Math.min(ranges.length, MAX_HEAD_CONES);

        const coneColor = o.headConeColor ?? o.color ?? this._color;
        const coneOpacity = o.opacity ?? this._opacity;
        const headSize = o.headConeSize ?? o.size ?? this._arrowSize;
        const headSizeMode = o.sizeMode ?? this._arrowSizeMode;

        while (pool.length < n) {
            const g = new THREE.ConeGeometry(CONE_RADIUS_RATIO, 1, 12);
            g.translate(0, 0.5, 0);
            const m = new THREE.MeshBasicMaterial({
                color: coneColor,
                opacity: coneOpacity,
                transparent: coneOpacity < 1,
                depthTest: this._depthTest,
                depthWrite: this._depthWrite,
            });
            const c = new THREE.Mesh(g, m);
            c.renderOrder = 999;
            anim.headConeGroup.add(c);
            pool.push(c);
        }

        for (let i = 0; i < pool.length; i++) {
            const cone = pool[i];
            if (i >= n) { cone.visible = false; continue; }

            const [t0, t1] = ranges[i];
            const tHead = o.reverse ? t0 : t1;

            if (!this._getPointAtT(tHead, this._tempVecA, this._tempVecB)) {
                cone.visible = false;
                continue;
            }
            cone.visible = true;
            cone.position.copy(this._tempVecA);
            if (o.reverse) this._tempVecB.negate();
            cone.quaternion.setFromUnitVectors(this._Y_AXIS, this._tempVecB);

            cone.material.color.set(coneColor as any);
            cone.material.opacity = coneOpacity;
            cone.material.transparent = coneOpacity < 1;

            this._applyConeScale(map, cone, headSize, headSizeMode);
        }
    }

    private _resetStaticConePosition(): void {
        if (!this._cone || !this._map || this._worldPoints.length < 2) return;
        const last = this._worldPoints.length - 1;
        const pFrom = new THREE.Vector3(...this._worldPoints[last - 1]);
        const pTo = new THREE.Vector3(...this._worldPoints[last]);
        const dir = new THREE.Vector3().subVectors(pTo, pFrom);
        const len = dir.length();
        if (len < 1e-6) return;

        this._cone.position.copy(pTo);
        this._cone.quaternion.setFromUnitVectors(this._Y_AXIS, dir.normalize());
        this._lastSegLen = len;
        this._applyConeScale(this._map);
    }

    // =================================================================
    // Публичное API анимации
    // =================================================================

    setAnimation(animation: Vector3DOptions['animation']): this {
        this._teardownAnimations();
        this._parseAnimationsInto(animation);
        if (this._map && this._line) this._setupAnimations(this._map);
        return this;
    }

    pauseAnimation(index = -1): this {
        if (index < 0) this._animList.forEach(a => (a.config.paused = true));
        else if (this._animList[index]) this._animList[index].config.paused = true;
        return this;
    }

    resumeAnimation(index = -1): this {
        if (index < 0) this._animList.forEach(a => (a.config.paused = false));
        else if (this._animList[index]) this._animList[index].config.paused = false;
        return this;
    }

    setAnimationSpeed(speed: number, index = -1): this {
        if (index < 0) this._animList.forEach(a => (a.config.speed = speed));
        else if (this._animList[index]) this._animList[index].config.speed = speed;
        return this;
    }

    // =================================================================
    // Точки / геометрия
    // =================================================================

    /** Пересчитывает `_worldPoints` из `_positions` (требует `_map`). */
    private _recomputeWorldPoints(): void {
        if (!this._map) return;
        const worldPts: Vector3DPosition[] = [];
        const wgPos = this._map.worldGroup.position;
        const clamp = this._altitudeMode === 'clampToGround';

        for (let i = 0; i < this._positions.length; i++) {
            const p = this._positions[i];
            if (!Array.isArray(p) || p.length < 2) continue;

            let xy: [number, number] | null = null;
            let h = 0;
            if (this._isEcef) {
                const [lon, lat, hh] = ecefToGeodetic(p[0], p[1], p[2] ?? 0);
                xy = this._map.projectSafe([lon, lat], 'EPSG:4326');
                h = hh;
            } else {
                xy = this._map.projectSafe([p[0], p[1]], this._crs);
                h = p[2] ?? 0;
            }
            if (!xy) continue;

            let surfaceY = 0;
            if (clamp) {
                surfaceY = this._map.getSurfaceHeightAt(xy[0] + wgPos.x, xy[1] + wgPos.z);
            }
            const worldY = surfaceY + h * this._heightScale + this._altitude;
            worldPts.push([xy[0], worldY, xy[1]]);
        }
        this._worldPoints = worldPts;
    }

    private _buildLine(map: any): void {
        this._geometry = new LineGeometry();
        const canvas = map.renderer.domElement;
        this._material = new LineMaterial({
            color: this._color,
            linewidth: this._width,
            opacity: this._opacity,
            transparent: this._opacity < 1,
            depthTest: this._depthTest,
            depthWrite: this._depthWrite,
            resolution: new THREE.Vector2(canvas.width, canvas.height),
        });

        this._line = new Line2(this._geometry, this._material);
        this._line.position.copy(this._localOrigin);
        this._line.renderOrder = 999;
        this._group.add(this._line);
    }

    private _buildStaticCone(): void {
        const pts = this._worldPoints;
        const last = pts.length - 1;
        const pFrom = new THREE.Vector3(...pts[last - 1]);
        const pTo = new THREE.Vector3(...pts[last]);
        const dir = new THREE.Vector3().subVectors(pTo, pFrom);
        const len = dir.length();

        if (len <= 1e-6) return;

        const cGeo = new THREE.ConeGeometry(CONE_RADIUS_RATIO, 1, 12);
        cGeo.translate(0, 0.5, 0);

        this._cone = new THREE.Mesh(cGeo, new THREE.MeshBasicMaterial({
            color: this._color,
            opacity: this._opacity,
            transparent: this._opacity < 1,
            depthTest: this._depthTest,
            depthWrite: this._depthWrite,
        }));
        this._cone.renderOrder = 999;
        this._cone.position.copy(pTo);
        this._cone.quaternion.setFromUnitVectors(this._Y_AXIS, dir.normalize());

        this._lastSegLen = len;
        this._applyConeScale(this._map);

        this._group.add(this._cone);
    }

    private _applyConeScale(
        map: any,
        cone: any = this._cone,
        size: number | null = null,
        sizeMode: ArrowSizeMode | null = null
    ): void {
        if (!cone) return;

        const s = size ?? this._arrowSize;
        const mode = sizeMode ?? this._arrowSizeMode;

        let h: number;
        if (mode === 'world') {
            h = s;
            if (this._lastSegLen > 0) h = Math.min(h, this._lastSegLen * 0.4);
        } else {
            const wgPos = map.worldGroup.position;
            const pos = cone.position;
            const dist = map.camera.position.distanceTo(
                map.getVec3().set(pos.x + wgPos.x, pos.y + wgPos.y, pos.z + wgPos.z)
            );
            const canvas = map.renderer.domElement;
            const fovRad = map.camera.fov * Math.PI / 180;
            const hPixels = Math.max(1, canvas.clientHeight);
            const worldPerPixel = (2 * dist * Math.tan(fovRad / 2)) / hPixels;
            h = s * worldPerPixel;
        }

        if (!isFinite(h) || h <= 0) h = 1e-6;
        cone.scale.setScalar(h);
    }

    // =================================================================
    // Обновление на кадре
    // =================================================================

    _update(map: any, deltaTime?: number): void {
        if (!this._map || !this._line) return;
        this._applyZoomInterpolations(map.continuousZoom);

        if (!this._isWithinView()) {
            this._applyHidden();
            this._isVisible = false;
            return;
        }

        // ── deltaTime ──
        if (typeof deltaTime !== 'number' || !isFinite(deltaTime) || deltaTime < 0) {
            const now = performance.now();
            deltaTime = this._lastUpdateTime
                ? Math.min((now - this._lastUpdateTime) / 1000, 0.1)
                : 0;
        }
        if (deltaTime > 0.1) deltaTime = 0.1;
        this._lastUpdateTime = performance.now();

        // ── group в worldGroup ──
        if (this._group.parent !== map.worldGroup) {
            this._group.parent?.remove(this._group);
            map.worldGroup.add(this._group);
        }

        // ── resolution ──
        const cv = map.renderer.domElement;
        if (this._material) {
            const res = this._material.resolution;
            if (res.x !== cv.width || res.y !== cv.height) res.set(cv.width, cv.height);
        }
        for (const anim of this._animList) {
            if (anim.config.type === 'part' && anim.overlayMat) {
                const res = anim.overlayMat.resolution;
                if (res.x !== cv.width || res.y !== cv.height) res.set(cv.width, cv.height);
            }
        }

        // ── отложенный ребілд для невидимых ──
        if (this._pendingRebuild) {
            const bucket = this._simplify
                ? Math.floor(map.currentDiscreteZoom / this._simplifyZoomBucket)
                : -1;
            this._doRebuildForBucket(bucket);
        }

        // ── LOD ──
        this._applySimplification(map.currentDiscreteZoom);

        // ── clampToGround: периодически обновляем высоты ──
        if (this._altitudeMode === 'clampToGround' && this._worldPoints.length >= 2) {
            const now = performance.now();
            const posChanged = !this._lastWorldGroupPos.equals(map.worldGroup.position);
            if (now - this._lastSurfaceUpdateTime > 500 || posChanged) {
                this._recomputeWorldPoints();
                this._localOriginValid = false;
                this._ensureLocalOrigin();
                this._simplifyCache.clear();
                this._currentSimplifyBucket = -1; // force re-simplify for new points
                this._doRebuildForBucket(
                    this._simplify
                        ? Math.floor(map.currentDiscreteZoom / this._simplifyZoomBucket)
                        : -1
                );
                this._lastSurfaceUpdateTime = now;
                this._lastWorldGroupPos.copy(map.worldGroup.position);
            }
        }

        // ── distance check ──
        if (map.objectRenderDistanceFactor > 0 && this._worldPoints.length >= 2) {
            const wgPos = map.worldGroup.position;
            const cam = map.camera.position;
            const pts = this._worldPoints;

            let minDistSq = Infinity;
            let prevX = pts[0][0] + wgPos.x;
            let prevY = pts[0][1] + wgPos.y;
            let prevZ = pts[0][2] + wgPos.z;

            for (let i = 1; i < pts.length; i++) {
                const curX = pts[i][0] + wgPos.x;
                const curY = pts[i][1] + wgPos.y;
                const curZ = pts[i][2] + wgPos.z;

                const abx = curX - prevX, aby = curY - prevY, abz = curZ - prevZ;
                const apx = cam.x - prevX, apy = cam.y - prevY, apz = cam.z - prevZ;
                const abLenSq = abx * abx + aby * aby + abz * abz;
                let t = abLenSq > 0 ? (apx * abx + apy * aby + apz * abz) / abLenSq : 0;
                if (t < 0) t = 0; else if (t > 1) t = 1;

                const dx = prevX + abx * t - cam.x;
                const dy = prevY + aby * t - cam.y;
                const dz = prevZ + abz * t - cam.z;
                const dSq = dx * dx + dy * dy + dz * dz;
                if (dSq < minDistSq) minDistSq = dSq;

                prevX = curX; prevY = curY; prevZ = curZ;
            }

            if (Math.sqrt(minDistSq) > map.maxObjectDistance) {
                this._applyHidden();
                this._isVisible = false;
                return;
            }
        }

        // ── apply positions (rebuild Line2 if dirty) ──
        if (!this._applyPositions()) {
            this._isVisible = false;
            return;
        }

        this._group.visible = true;
        this._isVisible = true;

        // ── анимации ──
        if (this._animList.length > 0 && this._animPolyline) {
            this._stepAllAnimations(map, deltaTime);
        }

        // ── cone scale для px-режима (если не управляется pulse) ──
        const hasPulse = this._animList.some(a => a.config.type === 'pulse');
        if (!hasPulse && this._arrowSizeMode === 'px' && this._cone && this._cone.visible) {
            this._applyConeScale(map);
        }
    }

    /**
     * Пересоздаёт Line2-геометрию из `_simplifiedPoints`, сдвигая вершины
     * в локальный origin. КРИТИЧНО: dispose+new LineGeometry, иначе three.js
     * сохраняет `_maxInstanceCount` через `Math.min(...)` и не перерисовывает
     * больше сегментов, чем было на дальнем зуме.
     */
    private _applyPositions(): boolean {
        if (!this._map || !this._line) return false;
        if (!this._positionsDirty) return this._line.visible;

        this._ensureLocalOrigin();
        this._line.position.copy(this._localOrigin);

        const pts = this._simplifiedPoints;
        const ox = this._localOrigin.x;
        const oz = this._localOrigin.z;
        const n = pts.length;
        const arr = new Float32Array(n * 3);
        let k = 0;
        let lastFx = NaN, lastFy = NaN, lastFz = NaN;

        for (let i = 0; i < n; i++) {
            const p = pts[i];
            let x = p[0] - ox;
            let y = p[1];
            let z = p[2] - oz;
            if (!Number.isFinite(x)) x = 0;
            if (!Number.isFinite(y)) y = 0;
            if (!Number.isFinite(z)) z = 0;

            const fx = Math.fround(x);
            const fy = Math.fround(y);
            const fz = Math.fround(z);
            if (fx === lastFx && fy === lastFy && fz === lastFz) continue;

            arr[k] = fx; arr[k + 1] = fy; arr[k + 2] = fz;
            k += 3;
            lastFx = fx; lastFy = fy; lastFz = fz;
        }

        if (k < 6) {
            this._line.visible = false;
            this._positionsDirty = false;
            return false;
        }

        const finalArr = k === arr.length ? arr : arr.slice(0, k);

        if (this._geometry) this._geometry.dispose();
        this._geometry = new LineGeometry();
        this._geometry.setPositions(finalArr);
        this._line.geometry = this._geometry;
        this._line.computeLineDistances();
        this._line.visible = true;

        this._resetStaticConePosition();
        this._animPolyline = this._computePolylineData();

        this._positionsDirty = false;
        return true;
    }

    /** Помечает геометрию грязной и пересоздаёт анимации. */
    private _invalidateGeometryAndAnimations(): void {
        this._positionsDirty = true;
        this._bsCache = null;
        if (!this._map || !this._line) return;

        this._teardownAnimations();
        if (this._animList.length) this._setupAnimations(this._map);
    }

    // =================================================================
    // Мутабельность
    // =================================================================

    setColor(color: Vector3DColor): this {
        this._color = color;
        if (this._material?.color) this._material.color.set(color as any);
        if (this._cone?.material?.color) this._cone.material.color.set(color as any);
        for (const anim of this._animList) {
            const o = anim.config;
            if (o.color == null) {
                if (anim.cone?.material?.color) anim.cone.material.color.set(color as any);
                if (anim.cones) for (const c of anim.cones) c.material.color.set(color as any);
                if (anim.overlayMat?.color) anim.overlayMat.color.set(color as any);
                if (anim.headConePool && o.headConeColor == null) {
                    for (const c of anim.headConePool) c.material.color.set(color as any);
                }
            }
        }
        return this;
    }

      getColor(): Vector3DColor { return this._color; }

    // ── LOD ──
    setSimplify(on: boolean): this {
        this._simplify = on;
        this._simplifyCache.clear();
        this._currentSimplifyBucket = -1;
        if (this._map) {
            const b = on
                ? Math.floor(this._map.currentDiscreteZoom / this._simplifyZoomBucket)
                : -1;
            this._doRebuildForBucket(b);
        }
        return this;
    }
    getSimplify(): boolean { return this._simplify; }

    setSimplifyTolerance(t: number): this {
        if (!(t >= 0) || !Number.isFinite(t)) return this;
        this._simplifyTolerance = t;
        this._simplifyCache.clear();
        this._currentSimplifyBucket = -1;
        if (this._map) {
            const b = this._simplify
                ? Math.floor(this._map.currentDiscreteZoom / this._simplifyZoomBucket)
                : -1;
            this._doRebuildForBucket(b);
        }
        return this;
    }
    getSimplifyTolerance(): number { return this._simplifyTolerance; }

    setSimplifyZoomBucket(n: number): this {
        if (!(n > 0) || !Number.isFinite(n)) return this;
        this._simplifyZoomBucket = n;
        this._simplifyCache.clear();
        this._currentSimplifyBucket = -1;
        if (this._map) {
            const b = this._simplify
                ? Math.floor(this._map.currentDiscreteZoom / this._simplifyZoomBucket)
                : -1;
            this._doRebuildForBucket(b);
        }
        return this;
    }
    getSimplifyZoomBucket(): number { return this._simplifyZoomBucket; }

    setWidth(width: number): this {
        if (!(width >= 0)) return this;
        this._width = width;
        if (this._material) {
            this._material.linewidth = width;
            this._material.needsUpdate = true;
        }
        for (const anim of this._animList) {
            if (anim.config.type === 'part' && anim.overlayMat && anim.config.width == null) {
                anim.overlayMat.linewidth = width;
                anim.overlayMat.needsUpdate = true;
            }
        }
        return this;
    }

    getWidth(): number { return this._width; }

    setOpacity(opacity: number): this {
        const v = Math.max(0, Math.min(1, opacity));
        this._opacity = v;
        const applyOpacity = (mat: any) => {
            mat.opacity = v;
            const t = v < 1;
            if (mat.transparent !== t) {
                mat.transparent = t;
                mat.needsUpdate = true;
            }
        };
        if (this._material) applyOpacity(this._material);
        if (this._cone?.material) applyOpacity(this._cone.material);
        for (const anim of this._animList) {
            if (anim.config.opacity != null) continue;
            if (anim.cone?.material) applyOpacity(anim.cone.material);
            if (anim.cones) for (const c of anim.cones) applyOpacity(c.material);
            if (anim.overlayMat) applyOpacity(anim.overlayMat);
            if (anim.headConePool) for (const c of anim.headConePool) applyOpacity(c.material);
        }
        return this;
    }

    getOpacity(): number { return this._opacity; }

    setArrowSize(size: number): this {
        if (!(size > 0)) return this;
        this._arrowSize = size;
        if (this._cone && this._map) this._applyConeScale(this._map);
        return this;
    }

    getArrowSize(): number { return this._arrowSize; }

    setArrowSizeMode(mode: ArrowSizeMode): this {
        this._arrowSizeMode = mode;
        if (this._cone && this._map) this._applyConeScale(this._map);
        return this;
    }

    getArrowSizeMode(): ArrowSizeMode { return this._arrowSizeMode; }

    setDepthTest(depthTest: boolean): this {
        this._depthTest = !!depthTest;
        for (const m of this._collectAllMaterials()) {
            if (m.depthTest !== this._depthTest) {
                m.depthTest = this._depthTest;
                m.needsUpdate = true;
            }
        }
        return this;
    }

    getDepthTest(): boolean { return this._depthTest; }

    setDepthWrite(depthWrite: boolean): this {
        this._depthWrite = !!depthWrite;
        for (const m of this._collectAllMaterials()) {
            if (m.depthWrite !== this._depthWrite) {
                m.depthWrite = this._depthWrite;
                m.needsUpdate = true;
            }
        }
        return this;
    }

    getDepthWrite(): boolean { return this._depthWrite; }

    private _collectAllMaterials(): any[] {
        const all: any[] = [];
        if (this._material) all.push(this._material);
        if (this._cone?.material) all.push(this._cone.material);
        for (const anim of this._animList) {
            if (anim.cone?.material) all.push(anim.cone.material);
            if (anim.cones) for (const c of anim.cones) all.push(c.material);
            if (anim.overlayMat) all.push(anim.overlayMat);
            if (anim.headConePool) for (const c of anim.headConePool) all.push(c.material);
        }
        return all;
    }

    // =================================================================
    // HeightScale / altitudeMode
    // =================================================================

    setHeightScale(scale: number): this {
        this._heightScale = scale;
        if (!this._map) { this._positionsDirty = true; return this; }
        this._recomputeWorldPoints();
        this._localOriginValid = false;
        this._ensureLocalOrigin();
        this._simplifyCache.clear();
        this._currentSimplifyBucket = -1;
        this._doRebuildForBucket(
            this._simplify
                ? Math.floor(this._map.currentDiscreteZoom / this._simplifyZoomBucket)
                : -1
        );
        this._invalidateGeometryAndAnimations();
        return this;
    }

    getHeightScale(): number { return this._heightScale; }

    setAltitudeMode(mode: Vector3DAltitudeMode): this {
        this._altitudeMode = mode;
        this._onAltitudeChanged();
        return this;
    }

    getAltitudeMode(): Vector3DAltitudeMode { return this._altitudeMode; }

    /** @deprecated Используйте унаследованный `setAltitude`. */
    setAltitudeOffset(offset: number): this { return this.setAltitude(offset); }
    /** @deprecated Используйте унаследованный `getAltitude`. */
    getAltitudeOffset(): number { return this.getAltitude(); }

    // =================================================================
    // Позиции
    // =================================================================

    setPositions(positions: Vector3DPosition[]): this {
        if (!positions || positions.length < 2) return this;
        this._positions = positions;

        this._positionsDirty = true;
        this._bsCache = null;
        this._simplifyCache.clear();
        this._currentSimplifyBucket = -1;
        this._pendingBucket = -1;
        this._pendingRebuild = false;
        if (this._rebuildTimer) { clearTimeout(this._rebuildTimer); this._rebuildTimer = null; }

        if (!this._map) return this;

        this._recomputeWorldPoints();
        if (this._worldPoints.length < 2) return this;

        this._localOriginValid = false;
        this._ensureLocalOrigin();

        const bucket = this._simplify
            ? Math.floor(this._map.currentDiscreteZoom / this._simplifyZoomBucket)
            : -1;
        this._doRebuildForBucket(bucket);

        this._teardownAnimations();
        if (this._animList.length) this._setupAnimations(this._map);

        return this;
    }

    getPositions(): Vector3DPosition[] {
        return this._positions.map(p => [p[0], p[1], p[2]] as Vector3DPosition);
    }

    /** Центр bbox в WGS84: `[lon, lat]`, либо `null`. */
    getCenter(): LonLat | null {
        const b = this.getBounds('EPSG:4326');
        if (!b) return null;
        return [(b[0][0] + b[1][0]) / 2, (b[0][1] + b[1][1]) / 2];
    }

    // =================================================================
    // KrbMap#fitTo / getBounds
    // =================================================================

    getBounds(crs: string | any = 'EPSG:4326'): [LonLat, LonLat] | null {
        let mnx = Infinity, mnz = Infinity, mxx = -Infinity, mxz = -Infinity;
        for (const p of this._worldPoints) {
            if (p[0] < mnx) mnx = p[0];
            if (p[0] > mxx) mxx = p[0];
            if (p[2] < mnz) mnz = p[2];
            if (p[2] > mxz) mxz = p[2];
        }
        if (!isFinite(mnx)) return null;

        if (this._map) {
            const a = this._map.unproject([mnx, mnz], crs);
            const b = this._map.unproject([mxx, mxz], crs);
            return [[a[0], a[1]], [b[0], b[1]]];
        }
        return [[mnx, mnz], [mxx, mxz]];
    }

    // =================================================================
    // Debug
    // =================================================================

    debugDump(): void {
        const map = this._map;
        const line = this._line;
        const geo = this._geometry;
        const mat = this._material;
        const full = this._worldPoints;
        const simp = this._simplifiedPoints;

        const lod = {
            simplify: this._simplify,
            tolerance: this._simplifyTolerance,
            zoomBucket: this._simplifyZoomBucket,
            currentBucket: this._currentSimplifyBucket,
            pendingBucket: this._pendingBucket,
            mapZoom: map?.currentDiscreteZoom,
            mapZoomContinuous: map?.continuousZoom,
            originalCount: this._positions.length,
            worldCount: full.length,
            simplifiedCount: simp.length,
        };

        // Line2 buffer health
        let instCount = 0, geoNaN = 0, geoZero = 0, geoMinLen = Infinity;
        if (geo) {
            const sA = geo.attributes?.instanceStart, eA = geo.attributes?.instanceEnd;
            if (sA && eA) {
                instCount = sA.count;
                const s = sA.array as Float32Array, e = eA.array as Float32Array;
                for (let k = 0; k < instCount; k++) {
                    const sx = s[k * 3], sy = s[k * 3 + 1], sz = s[k * 3 + 2];
                    const ex = e[k * 3], ey = e[k * 3 + 1], ez = e[k * 3 + 2];
                    if (![sx, sy, sz, ex, ey, ez].every(Number.isFinite)) { geoNaN++; continue; }
                    const dx = ex - sx, dy = ey - sy, dz = ez - sz;
                    const len = Math.sqrt(dx * dx + dy * dy + dz * dz);
                    if (len === 0) geoZero++;
                    if (len < geoMinLen) geoMinLen = len;
                }
            }
        }

        const objInfo = line ? {
            visible: line.visible,
            inGroup: line.parent === this._group,
            groupInWorld: this._group.parent === map?.worldGroup,
            linePosition: [line.position.x.toFixed(1), line.position.y.toFixed(1), line.position.z.toFixed(1)],
            localOrigin: [this._localOrigin.x.toFixed(1), this._localOrigin.y.toFixed(1), this._localOrigin.z.toFixed(1)],
            frustumCulled: line.frustumCulled,
            renderOrder: line.renderOrder,
        } : null;

        const matInfo = mat ? {
            opacity: mat.opacity, linewidth: mat.linewidth,
            transparent: mat.transparent,
            depthTest: mat.depthTest, depthWrite: mat.depthWrite,
            resolution: mat.resolution ? [mat.resolution.x, mat.resolution.y] : null,
            visible: mat.visible,
        } : null;

        console.groupCollapsed(
            `%c[Vector3D] z=${lod.mapZoom} bucket=${lod.currentBucket} ` +
            `orig=${lod.originalCount} world=${lod.worldCount} simp=${lod.simplifiedCount} inst=${instCount}`,
            'color:#3af;font-weight:bold');

        console.log('%c1. LOD state', 'color:#3af;font-weight:bold', lod);
        console.log('%c2. Line2 буфер', 'color:#3af;font-weight:bold', {
            instances: instCount,
            maxInstanceCount: (geo as any)?._maxInstanceCount,
            expected: simp.length - 1,
            missing: (simp.length - 1) - instCount,
            geoNaN, geoZero,
            geoMinLen: +geoMinLen.toFixed(6),
        });
        console.log('%c3. Object', 'color:#3af;font-weight:bold', objInfo);
        console.log('%c4. Material', 'color:#3af;font-weight:bold', matInfo);
        console.log('%c5. Animations', 'color:#3af;font-weight:bold',
            this._animList.map(a => ({ type: a.config.type, paused: a.config.paused })));

        if (geoNaN > 0) console.error(`❌ ${geoNaN} NaN-сегментов в Line2 — источник «крошек»`);
        if (geoZero > 0) console.error(`❌ ${geoZero} нулевых сегментов в Line2 → NaN в шейдере`);
        if (instCount !== simp.length - 1) {
            console.error(`❌ Буфер Line2 рассинхронизирован (${instCount} vs ${simp.length - 1})`);
        }
        if (this._positionsDirty) console.warn('⚠ _positionsDirty = true, буфер не пересобран');
        console.groupEnd();
    }

    debugToggleSimplify(on: boolean): void {
        this._simplify = on;
        this._simplifyCache.clear();
        this._currentSimplifyBucket = -1;
        if (this._map) {
            const b = on ? Math.floor(this._map.currentDiscreteZoom / this._simplifyZoomBucket) : -1;
            this._doRebuildForBucket(b);
        }
        console.log(`[Vector3D] simplify = ${on}`);
    }

    debugSegmentRange(from: number, to: number): void {
        const geo = this._geometry;
        if (!geo) return console.log('no geometry');
        const sA = geo.attributes?.instanceStart, eA = geo.attributes?.instanceEnd;
        if (!sA || !eA) return console.log('no instance attributes');
        const s = sA.array as Float32Array, e = eA.array as Float32Array;
        const rows: any[] = [];
        for (let k = from; k < Math.min(to, sA.count); k++) {
            const sx = s[k * 3], sy = s[k * 3 + 1], sz = s[k * 3 + 2];
            const ex = e[k * 3], ey = e[k * 3 + 1], ez = e[k * 3 + 2];
            const len = Math.hypot(ex - sx, ey - sy, ez - sz);
            rows.push({
                i: k, len: +len.toFixed(4),
                start: [sx, sy, sz].map(v => v.toFixed(1)).join(','),
                end: [ex, ey, ez].map(v => v.toFixed(1)).join(','),
                bad: !Number.isFinite(len) || len === 0,
            });
        }
        console.table(rows);
    }
}