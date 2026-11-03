/**
 * Vector3D — направленный 3D-вектор (ломаная со стрелкой) и опциональной
 * анимацией. После `addTo()` мутабелен: точки, цвет, толщина, размер
 * стрелки, прозрачность, видимость, высотный масштаб, подписи и тултип
 * меняются без пересоздания.
 *
 * @module Vector3D
 */

import { Layer } from './Layers.js';
import { Projections } from './Projections.js';
import {
    THREE,
    Line2,
    LineMaterial,
    LineGeometry,
    LineSegments2,
    LineSegmentsGeometry,
} from './js_TP/tpb.js';

// =====================================================================
// Типы
// =====================================================================

export type LonLat = [number, number];
export type Vector3DPosition = [number, number, number];
export type Vector3DColor = string | number;
export type ArrowSizeMode = 'px' | 'world';
export type TitleAlignH = 'left' | 'center' | 'right';
export type TitleAlignV = 'top' | 'middle' | 'bottom';
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

    // movingArrow
    easing?: Easing;
    hideStaticArrow?: boolean;

    // flowArrows
    count?: number;
    spacing?: number | null;

    // pulse
    minScale?: number;
    maxScale?: number;

    // part
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
    heightScale?: number;
    altitudeOffset?: number;
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
}

/** Разобранный config анимации — со всеми полями по умолчанию. */
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
    // может быть всё, что угодно из AnimationSpec с дефолтами
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

/** Runtime-слот анимации: config + созданные GPU-ресурсы. */
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

// =====================================================================
// Константы и утилиты ECEF
// =====================================================================

const _A  = 6378137.0;
const _F  = 1 / 298.257222101;
const _B  = _A * (1 - _F);
const _E2 = 1 - (_B * _B) / (_A * _A);

export function ecefToGeodetic(X: number, Y: number, Z: number): [number, number, number] {
    const p = Math.sqrt(X * X + Y * Y);
    const lon = Math.atan2(Y, X);
    let lat = Math.atan2(Z, p * (1 - _E2));
    for (let i = 0; i < 10; i++) {
        const s = Math.sin(lat);
        const N = _A / Math.sqrt(1 - _E2 * s * s);
        lat = Math.atan2(Z + _E2 * N * s, p);
    }
    const sL = Math.sin(lat);
    const cL = Math.cos(lat);
    const N = _A / Math.sqrt(1 - _E2 * sL * sL);
    const h = cL > 1e-10 ? p / cL - N : Math.abs(Z) - _B;
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

// =====================================================================
// Vector3D
// =====================================================================

export class Vector3D {
    // ── Данные ──
    private _positions: Vector3DPosition[];
    private _crsCode: string | null;
    private _crs: any | null;
    private _isEcef: boolean;

    // ── Оформление ──
    private _color: Vector3DColor;
    private _width: number;
    private _arrowSize: number;
    private _arrowSizeMode: ArrowSizeMode;
    private _opacity: number;
    private _depthTest: boolean;
    private _minZoom: number;
    private _maxZoom: number;
    private _heightScale: number;
    private _altitudeOffset: number;

    // ── Подписи ──
    private _titles: { start: Vector3DTitleOptions; end: Vector3DTitleOptions };

    // ── Интерактив ──
    private _tooltip: string;
    private _onClick: ((event: MouseEvent, vec: Vector3D) => void) | null;
    private _onHover: ((hovered: boolean) => void) | null;
    private _unregisterInteraction: (() => void) | null = null;

    // ── Присоединение ──
    private _map: any = null;
    private _layer: Layer | null = null;
    private _group: any;

    // ── 3D-объекты ──
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

    // ── Временные ──
    private _tempVecA: any;
    private _tempVecB: any;
    private _Y_AXIS: any;

    // ── NEW: видимость ──
    private _userVisible = true;

    constructor(options: Vector3DOptions) {
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
        this._minZoom = options.minZoom ?? -Infinity;
        this._maxZoom = options.maxZoom ?? Infinity;
        this._heightScale = options.heightScale ?? 1;
        this._altitudeOffset = options.altitudeOffset ?? 0;

        this._titles = {
            start: this._parseTitleOptions(options, 'start'),
            end: this._parseTitleOptions(options, 'end'),
        };

        this._tooltip = options.tooltip ?? '';
        this._onClick = options.onClick ?? null;
        this._onHover = options.onHover ?? null;

        this._group = new THREE.Group();

        this._tempVecA = new THREE.Vector3();
        this._tempVecB = new THREE.Vector3();
        this._Y_AXIS = new THREE.Vector3(0, 1, 0);

        this._parseAnimationsInto(options.animation);
    }

    // =================================================================
    // Разбор подписей и анимаций
    // =================================================================

    private _parseTitleOptions(options: Vector3DOptions, role: TitleRole): Vector3DTitleOptions {
        const isStart = role === 'start';
        const sfx = isStart ? 'Start' : 'End';
        const placement = options.titlePlacement;

        let text: string;
        if (isStart) {
            text = options.titleStart
                ?? (placement === 'end' ? '' : (options.title ?? ''));
        } else {
            text = options.titleEnd
                ?? (placement === 'end' ? (options.title ?? '') : '');
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
        const vec = map.getVec3().set(
            pt[0] + wgPos.x,
            pt[1] + wgPos.y,
            pt[2] + wgPos.z
        );
        vec.project(map.camera);
        if (vec.z > 1) return null;
        const canvas = map.renderer.domElement;
        return {
            x: (vec.x * 0.5 + 0.5) * canvas.clientWidth,
            y: (-vec.y * 0.5 + 0.5) * canvas.clientHeight,
        };
    }

    private _parseAnimationsInto(anim: Vector3DOptions['animation']): void {
        this._animList = [];
        if (!anim) return;
const arr = Array.isArray(anim) ? anim : [anim];
for (const a of arr) {
    const cfg = this._parseOneAnimation(a);   // ← без as any
    if (cfg) this._animList.push({ config: cfg, time: 0 });
}
    }

private _parseOneAnimation(
    anim: AnimationSpec | string | null | undefined | false
): ParsedAnimation | null {
    if (!anim) return null;   // ← ловит null, undefined, '', false
    const src: AnimationSpec = (typeof anim === 'string')
        ? { type: anim as AnimationType }
        : anim;
        const type: AnimationType = src.type ?? 'none';
        if (type === 'none') return null;

        const base: ParsedAnimation = {
            type,
            period: src.period ?? 3,
            speed: src.speed ?? 1,
            paused: src.paused ?? false,
            reverse: src.reverse ?? false,
            fadeRatio: Math.min(0.5, Math.max(0, src.fadeRatio ?? 0.15)),
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
            return phase < 0.5
                ? 2 * phase * phase
                : 1 - 2 * (1 - phase) * (1 - phase);
        }
        return 0.5 - 0.5 * Math.cos(phase * Math.PI * 2);
    }

    // =================================================================
    // Геометрия маршрута
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
    // Setup / teardown анимаций (внутренние)
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
                depthWrite: this._depthTest,
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
                    depthWrite: this._depthTest,
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
                depthWrite: this._depthTest,
                resolution: new THREE.Vector2(
                    map.renderer.domElement.width,
                    map.renderer.domElement.height
                ),
            });
            const overlay = new LineSegments2(geo, mat);
            overlay.renderOrder = 999;
            overlay.visible = false;
            overlay.frustumCulled = false;
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
        const dashLen = o.dashLengthMode === 'fraction'
            ? o.dashLength! * L
            : o.dashLength!;
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

        anim.overlayGeo.setPositions(positions);
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
                depthWrite: this._depthTest,
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
        if (this._map && this._line) {
            this._setupAnimations(this._map);
        }
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
    // Присоединение / отсоединение
    // =================================================================

    addTo(map: any): this {
        if (this._map === map && this._layer) return this;
        if (this._map) this.remove();
        const personalLayer = new Layer();
        personalLayer.addTo(map);
        (personalLayer as any).add(this);
        return this;
    }

    _attach(map: any, layer: Layer): void {
        if (this._map === map && this._layer === layer) return;
        if (this._map || this._layer) this.remove();
        this._map = map;
        this._layer = layer;

        this._crs = this._crsCode ? Projections.get(this._crsCode) : map.inputCRS;

        this._recomputeWorldPoints();
        if (this._worldPoints.length < 2) return;

        this._buildLine(map);
        this._buildStaticCone();
        if (this._animList.length) this._setupAnimations(map);

        map.worldGroup.add(this._group);

        this._registerInteraction(map);
        this._attachLabels(map);
    }

    /** Пересчитывает `_worldPoints` из `_positions` (требует `_map`). */
    private _recomputeWorldPoints(): void {
        const worldPts: Vector3DPosition[] = [];
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

            const worldY = h * this._heightScale + this._altitudeOffset;
            worldPts.push([xy[0], worldY, xy[1]]);
        }
        this._worldPoints = worldPts;
    }

    private _buildLine(map: any): void {
        const flat: number[] = [];
        for (const wp of this._worldPoints) flat.push(wp[0], wp[1], wp[2]);

        this._geometry = new LineGeometry();
        this._geometry.setPositions(flat);

        const canvas = map.renderer.domElement;
        this._material = new LineMaterial({
            color: this._color,
            linewidth: this._width,
            opacity: this._opacity,
            transparent: this._opacity < 1,
            depthTest: this._depthTest,
            depthWrite: this._depthTest,
            resolution: new THREE.Vector2(canvas.width, canvas.height),
        });

        this._line = new Line2(this._geometry, this._material);
        this._line.computeLineDistances();
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
            depthWrite: this._depthTest,
        }));
        this._cone.renderOrder = 999;
        this._cone.position.copy(pTo);
        this._cone.quaternion.setFromUnitVectors(this._Y_AXIS, dir.normalize());

        this._lastSegLen = len;
        this._applyConeScale(this._map);

        this._group.add(this._cone);
    }

    private _registerInteraction(map: any): void {
        if (!map.interaction) return;
        if (this._unregisterInteraction) {
            this._unregisterInteraction();
            this._unregisterInteraction = null;
        }
        if (!this._onClick && !this._onHover && !this._tooltip) return;

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
            onClick: this._onClick || null,
            onHover: this._onHover || null,
            getTooltip: this._tooltip ? () => this._tooltip : null,
            isVisible: () => this._group.visible,
        });
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
                map.getVec3().set(
                    pos.x + wgPos.x,
                    pos.y + wgPos.y,
                    pos.z + wgPos.z
                )
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

        if (!this._userVisible) {
            this._group.visible = false;
            return;
        }

        if (typeof deltaTime !== 'number' || !isFinite(deltaTime) || deltaTime < 0) {
            const now = performance.now();
            deltaTime = this._lastUpdateTime
                ? Math.min((now - this._lastUpdateTime) / 1000, 0.1)
                : 0;
        }
        if (deltaTime > 0.1) deltaTime = 0.1;
        this._lastUpdateTime = performance.now();

        const zoom = map.continuousZoom;
        let visible = (this._layer ? (this._layer as any).visible : true)
            && zoom >= this._minZoom && zoom <= this._maxZoom;

        if (visible && map.objectRenderDistanceFactor > 0 && this._worldPoints.length >= 2) {
            const mid = this._worldPoints[this._worldPoints.length >> 1];
            const wgPos = map.worldGroup.position;
            const d = map.camera.position.distanceTo(
                map.getVec3().set(mid[0] + wgPos.x, mid[1] + wgPos.y, mid[2] + wgPos.z)
            );
            if (d > map.maxObjectDistance) visible = false;
        }

        this._group.visible = visible;
        if (!visible) return;

        if (this._animList.length > 0 && this._animPolyline) {
            this._stepAllAnimations(map, deltaTime);
        }

        const hasPulse = this._animList.some(a => a.config.type === 'pulse');
        if (!hasPulse && this._arrowSizeMode === 'px' && this._cone && this._cone.visible) {
            this._applyConeScale(map);
        }

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
    }

    // =================================================================
    // Мутабельность
    // =================================================================

    /** Управляет видимостью (перекрывает зум и видимость слоя). */
    setVisible(visible: boolean): this {
        this._userVisible = !!visible;
        if (!this._group) return this;
        if (!this._userVisible) this._group.visible = false;
        return this;
    }

    /** Меняет цвет линии и конусов (где не задан явный override). */
    setColor(color: Vector3DColor): this {
        this._color = color;
        if (this._material?.color) this._material.color.set(color as any);
        if (this._cone?.material?.color) this._cone.material.color.set(color as any);
        for (const anim of this._animList) {
            const o = anim.config;
            if (o.color == null) {
                if (anim.cone?.material?.color) anim.cone.material.color.set(color as any);
                if (anim.cones) {
                    for (const c of anim.cones) c.material.color.set(color as any);
                }
                if (anim.overlayMat?.color) anim.overlayMat.color.set(color as any);
                if (anim.headConePool && o.headConeColor == null) {
                    for (const c of anim.headConePool) c.material.color.set(color as any);
                }
            }
        }
        return this;
    }

    /** Меняет толщину линии. */
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

    /** Меняет прозрачность линии и конусов (где не задан явный override). */
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

    /** Меняет размер стрелки (пиксели или world — зависит от `arrowSizeMode`). */
    setArrowSize(size: number): this {
        if (!(size > 0)) return this;
        this._arrowSize = size;
        if (this._cone && this._map) this._applyConeScale(this._map);
        return this;
    }

    /** Меняет режим размера стрелки. */
    setArrowSizeMode(mode: ArrowSizeMode): this {
        this._arrowSizeMode = mode;
        if (this._cone && this._map) this._applyConeScale(this._map);
        return this;
    }

    /** Включает/отключает depthTest во всех материалах. */
    setDepthTest(depthTest: boolean): this {
        this._depthTest = !!depthTest;
        const all: any[] = [];
        if (this._material) all.push(this._material);
        if (this._cone?.material) all.push(this._cone.material);
        for (const anim of this._animList) {
            if (anim.cone?.material) all.push(anim.cone.material);
            if (anim.cones) for (const c of anim.cones) all.push(c.material);
            if (anim.overlayMat) all.push(anim.overlayMat);
            if (anim.headConePool) for (const c of anim.headConePool) all.push(c.material);
        }
        for (const m of all) {
            if (m.depthTest !== this._depthTest) {
                m.depthTest = this._depthTest;
                m.needsUpdate = true;
            }
        }
        return this;
    }

    /** Устанавливает границы видимости по зуму. */
    setZoomBounds(minZoom: number, maxZoom: number): this {
        this._minZoom = minZoom;
        this._maxZoom = maxZoom;
        return this;
    }

    /** Меняет вертикальное преувеличение. */
    setHeightScale(scale: number): this {
        this._heightScale = scale;
        if (!this._map) return this;
        this._recomputeWorldPoints();
        this._refreshGeometryAfterPositionsChange();
        return this;
    }

    /** Меняет высотное смещение (world-метры). */
    setAltitudeOffset(offset: number): this {
        this._altitudeOffset = offset;
        if (!this._map) return this;
        this._recomputeWorldPoints();
        this._refreshGeometryAfterPositionsChange();
        return this;
    }

    /**
     * Заменяет точки. Пересчитывает `_worldPoints`, обновляет линию,
     * позицию статического конуса и пересоздаёт анимации.
     */
    setPositions(positions: Vector3DPosition[]): this {
        if (!positions || positions.length < 2) return this;
        this._positions = positions;
        if (!this._map) return this;

        this._recomputeWorldPoints();
        if (this._worldPoints.length < 2) return this;
        this._refreshGeometryAfterPositionsChange();
        return this;
    }

    /** Меняет тултип. При необходимости — перерегистрирует интерактив. */
    setTooltip(html: string): this {
        this._tooltip = html ?? '';
        if (this._map) this._registerInteraction(this._map);
        return this;
    }

    /** Меняет стартовую подпись. */
    setTitleStart(text: string): this {
        return this._setTitleText('start', text ?? '');
    }

    /** Меняет конечную подпись. */
    setTitleEnd(text: string): this {
        return this._setTitleText('end', text ?? '');
    }

    private _setTitleText(role: TitleRole, text: string): this {
        this._titles[role].text = text;
        const tm = this._map?.textManager;
        if (!tm) return this;

        const entry = this._labels.find(l => l.role === role);
        if (entry) {
            if (text) {
                if (typeof tm.updateLabel === 'function') tm.updateLabel(entry.handle);
                // else: facade.getText уже видит новый текст, но без
                // updateLabel нет способа форсировать пересчёт. Оставляем
                // как есть — большинство пользователей будет с новой
                // версией TextManager.
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

    /** Пересобирает геометрию и анимации после изменения `_worldPoints`. */
    private _refreshGeometryAfterPositionsChange(): void {
        if (!this._map || !this._line) return;

        const flat: number[] = [];
        for (const wp of this._worldPoints) flat.push(wp[0], wp[1], wp[2]);
        this._geometry.setPositions(flat);
        this._line.computeLineDistances();

        // Обновляем позицию статического конуса.
        if (this._cone) {
            const last = this._worldPoints.length - 1;
            const pFrom = new THREE.Vector3(...this._worldPoints[last - 1]);
            const pTo = new THREE.Vector3(...this._worldPoints[last]);
            const dir = new THREE.Vector3().subVectors(pTo, pFrom);
            const len = dir.length();
            if (len > 1e-6) {
                this._cone.position.copy(pTo);
                this._cone.quaternion.setFromUnitVectors(this._Y_AXIS, dir.normalize());
                this._lastSegLen = len;
                this._applyConeScale(this._map);
            }
        }

        // Пересоздаём анимации.
        this._teardownAnimations();
        if (this._animList.length) this._setupAnimations(this._map);
    }

    // =================================================================
    // Геттеры
    // =================================================================

    getPositions(): Vector3DPosition[] {
        return this._positions.map(p => [p[0], p[1], p[2]] as Vector3DPosition);
    }

    getColor(): Vector3DColor { return this._color; }
    getWidth(): number { return this._width; }
    getOpacity(): number { return this._opacity; }
    getArrowSize(): number { return this._arrowSize; }
    getArrowSizeMode(): ArrowSizeMode { return this._arrowSizeMode; }
    getHeightScale(): number { return this._heightScale; }
    getAltitudeOffset(): number { return this._altitudeOffset; }

    /** Центр bbox в WGS84: `[lon, lat]`, либо `null`. */
    getCenter(): LonLat | null {
        const b = this.getBounds('EPSG:4326');
        if (!b) return null;
        return [
            (b[0][0] + b[1][0]) / 2,
            (b[0][1] + b[1][1]) / 2,
        ];
    }

    // =================================================================
    // Удаление
    // =================================================================

    remove(): void {
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

        this._layer?._removeRef(this);
        this._layer = null;
        this._map = null;
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
    // Legacy-геттеры (делегируют к start)
    // =================================================================

    getText(): string { return this._titles.start.text; }

    getTextStyle(): Record<string, string | number> {
        return Object.assign({
            fontFamily: 'sans-serif',
            color: '#ffffff',
            fontSize: '12px',
            fontWeight: 'bold',
            textShadow: '1px 1px 2px rgba(0,0,0,0.9), -1px -1px 2px rgba(0,0,0,0.9)',
        }, this._titles.start.style);
    }

    getTextZoomBounds(): { min: number; max: number } {
        return { min: this._titles.start.minZoom, max: this._titles.start.maxZoom };
    }

    getLabelType(): 'point' { return 'point'; }

    isVisible(): boolean {
        if (!this._layer || !(this._layer as any).visible) return false;
        if (!this._map) return false;
        const zoom = this._map.continuousZoom;
        return zoom >= this._titles.start.minZoom && zoom <= this._titles.start.maxZoom;
    }

    getScreenPosition(): { x: number; y: number } | null {
        return this._getScreenPositionAt('start');
    }

    getTitleAlign(): TitleAlignH { return this._titles.start.align; }
    getTitleVerticalAlign(): TitleAlignV { return this._titles.start.verticalAlign; }
    getTitleOffset(): [number, number] { return this._titles.start.offset; }
    getAllowOverflow(): boolean { return this._titles.start.allowOverflow; }
    getPriority(): number { return this._titles.start.priority; }
}