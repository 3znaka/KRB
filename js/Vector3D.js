/**
 * Vector3D.js — направленный 3D-вектор (отрезок/ломаная) со стрелкой.
 *
 * Первоклассный объект карты, аналог {@link Polyline}, но с двумя
 * дополнительными возможностями:
 *  - третья координата точек интерпретируется как высота и умножается
 *    на `heightScale` + сдвигается на `altitudeOffset` (вертикальное
 *    преувеличение);
 *  - на последнем сегменте рисуется коническая стрелка.
 *
 * Позиции задаются как `[x, y, z]` в СК `crs`:
 *  - если `crs` — геоцентрическая СК (EPSG:4978, 10176, 7901..7912, 8403,
 *    8404), то `[x, y, z]` — это ECEF-координаты в метрах;
 *  - иначе `[x, y]` — плоские координаты в `crs`, `z` — высота над
 *    эллипсоидом WGS84 в метрах.
 *
 * Подписи:
 *  - `titleStart` (`title` — алиас) — текст в начале линии;
 *  - `titleEnd` — текст в конце линии.
 *  Обе могут быть заданы одновременно.
 *
 * Анимации (опция `animation` — объект или массив):
 *  - `movingArrow` — конус скользит по ломаной;
 *  - `flowArrows`  — несколько конусов текут вдоль вектора;
 *  - `pulse`       — концевой конус пульсирует размером;
 *  - `part`        — частичная отрисовка линии.
 *
 * Режимы `part` — визуально РАЗНЫЕ:
 *  - `'extend'`    — «пила»: линия линейно растёт 0→1, в конце периода
 *                    мгновенно сбрасывается в 0 и начинает заново
 *                    (`/|/|/|`). По умолчанию `easing: 'linear'`.
 *  - `'boomerang'` — «туда-обратно»: плавно вырос, плавно вернулся
 *                    (`∧∧∧`). По умолчанию `easing: 'easeInOut'`.
 *  - `'center'`    — растёт от середины наружу и обратно (`<>`).
 *                    По умолчанию `easing: 'sine'`.
 *  - `'dash'`      — пунктир, бегущий вдоль линии.
 *                    По умолчанию `easing: 'linear'`.
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
} from '../js_TP/tpb.js';


/* ================================================================
   ECEF ↔ Geodetic — экспортируемые утилиты
   ================================================================ */

const _A  = 6378137.0;
const _F  = 1 / 298.257222101;
const _B  = _A * (1 - _F);
const _E2 = 1 - (_B * _B) / (_A * _A);

/**
 * ECEF (X, Y, Z, м) → геодезические (lon°, lat°, h м) на GRS-80.
 *
 * @param {number} X @param {number} Y @param {number} Z
 * @returns {[number, number, number]} [lon, lat, h]
 */
export function ecefToGeodetic(X, Y, Z) {
    const p   = Math.sqrt(X * X + Y * Y);
    const lon = Math.atan2(Y, X);
    let lat   = Math.atan2(Z, p * (1 - _E2));
    for (let i = 0; i < 10; i++) {
        const s = Math.sin(lat);
        const N = _A / Math.sqrt(1 - _E2 * s * s);
        lat = Math.atan2(Z + _E2 * N * s, p);
    }
    const sL = Math.sin(lat);
    const cL = Math.cos(lat);
    const N  = _A / Math.sqrt(1 - _E2 * sL * sL);
    const h  = cL > 1e-10 ? p / cL - N : Math.abs(Z) - _B;
    return [lon * 180 / Math.PI, lat * 180 / Math.PI, h];
}

/**
 * Локальное смещение ENU → приращение ECEF в окрестности (lonRad, latRad).
 *
 * @param {number} e @param {number} n @param {number} u
 * @param {number} lonRad @param {number} latRad
 * @returns {[number, number, number]}
 */
export function enuToEcefDelta(e, n, u, lonRad, latRad) {
    const sLo = Math.sin(lonRad), cLo = Math.cos(lonRad);
    const sLa = Math.sin(latRad), cLa = Math.cos(latRad);
    return [
        -sLo * e - sLa * cLo * n + cLa * cLo * u,
         cLo * e - sLa * sLo * n + cLa * sLo * u,
                      cLa * n    + sLa * u
    ];
}

/** @type {Set<string>} */
export const ECEF_CODES = new Set([
    'EPSG:4978',  'EPSG:10176',
    'EPSG:7901',  'EPSG:7902',  'EPSG:7903',  'EPSG:7904',
    'EPSG:7905',  'EPSG:7906',  'EPSG:7907',  'EPSG:7908',
    'EPSG:7909',  'EPSG:7910',  'EPSG:7911',  'EPSG:7912',
    'EPSG:8403',  'EPSG:8404',
]);

/** @param {string|null|undefined} code @returns {boolean} */
export function isEcefCrs(code) {
    return code ? ECEF_CODES.has(code.toUpperCase()) : false;
}


/* ================================================================
   Vector3D
   ================================================================ */

/** @private */ const CONE_RADIUS_RATIO  = 0.35;
/** @private */ const FLOW_MAX_CONES     = 50;
/** @private */ const MAX_DASH_SEGMENTS  = 500;
/** @private */ const MAX_HEAD_CONES     = 100;

export class Vector3D {
    /**
     * @param {Object} options
     * @param {Array<[number, number, number]>} options.positions - Минимум 2 точки.
     * @param {string} [options.crs]
     * @param {string} [options.color='#3388ff']
     * @param {number} [options.width=2]
     * @param {number} [options.arrowSize=10]
     * @param {'px'|'world'} [options.arrowSizeMode='px']
     * @param {number} [options.opacity=1]
     * @param {boolean} [options.depthTest=false]
     * @param {number} [options.heightScale=1]
     * @param {number} [options.altitudeOffset=0]
     * @param {number} [options.minZoom=-Infinity]
     * @param {number} [options.maxZoom=Infinity]
     *
     * @param {string} [options.title=''] - Алиас `titleStart`.
     * @param {string} [options.titleStart=''] - Текст в начале линии.
     * @param {string} [options.titleEnd=''] - Текст в конце линии.
     *
     * Общие настройки для обеих подписей (переопределяются per-role):
     * @param {Object} [options.titleStyle={}]
     * @param {number} [options.titleMinZoom=-Infinity]
     * @param {number} [options.titleMaxZoom=Infinity]
     * @param {'left'|'center'|'right'} [options.titleAlign='center']
     * @param {'top'|'middle'|'bottom'} [options.titleVerticalAlign]
     * @param {[number, number]} [options.titleOffset]
     * @param {boolean} [options.titleAllowOverflow=false]
     * @param {number} [options.titlePriority=0]
     *
     * Per-role переопределения (все опциональны):
     *  - `titleStartStyle`, `titleEndStyle`
     *  - `titleStartMinZoom`, `titleEndMinZoom`
     *  - `titleStartMaxZoom`, `titleEndMaxZoom`
     *  - `titleStartAlign`, `titleEndAlign`
     *  - `titleStartVerticalAlign`, `titleEndVerticalAlign`
     *  - `titleStartOffset`, `titleEndOffset`
     *  - `titleStartAllowOverflow`, `titleEndAllowOverflow`
     *  - `titleStartPriority`, `titleEndPriority`
     *
     * @param {string} [options.tooltip='']
     * @param {Function|null} [options.onClick=null]
     * @param {Function|null} [options.onHover=null]
     *
     * @param {Object|string|Array|null} [options.animation=null]
     *     Одна анимация или массив анимаций. Каждая — объект или строка
     *     (`'movingArrow' | 'flowArrows' | 'pulse' | 'part' | 'none'`).
     *     Общие поля: `type`, `period`, `speed`, `paused`, `reverse`,
     *     `fadeRatio`, `color`, `size`, `sizeMode`, `opacity`,
     *     `hideStaticArrow`.
     *
     *     `type: 'movingArrow'` — один конус скользит по ломаной.
     *     `type: 'flowArrows'`  — N конусов (поле `count` / `spacing`).
     *     `type: 'pulse'`       — концевой конус пульсирует (`_cone`).
     *         Доп. поля: `minScale`, `maxScale`, `easing`.
     *     `type: 'part'` — частичная отрисовка линии. Поля:
     *       @param {'extend'|'center'|'boomerang'|'dash'} [options.animation.mode='extend']
     *       @param {number} [options.animation.dashLength=20] - В world-метрах
     *           (или в долях от длины линии при `dashLengthMode: 'fraction'`).
     *       @param {'world'|'fraction'} [options.animation.dashLengthMode='world']
     *       @param {number} [options.animation.gapRatio=1] - Отношение gap/dashLength.
     *       @param {number} [options.animation.offsetStep=1] - Сколько «шагов»
     *           (dash+gap) смещать за период. Для бесшовного цикла — целое.
     *       @param {boolean} [options.animation.headCone=false] - Конус на краю
     *           каждого dash (marching ants).
     *       @param {number|null} [options.animation.headConeSize=null]
     *       @param {string|null} [options.animation.headConeColor=null]
     *       @param {number|null} [options.animation.width=null] - Толщина линии.
     *       @param {boolean} [options.animation.hideBaseLine=true] - Скрыть
     *           базовую `Line2` (обязательно true, если вы не хотите смешивать
     *           её с overlay).
     *       @param {'linear'|'sine'|'easeIn'|'easeOut'|'easeInOut'} [options.animation.easing]
     *           Значение по умолчанию зависит от `mode`:
     *             - `extend`    → `'linear'`    (пила, мгновенный сброс)
     *             - `boomerang` → `'easeInOut'` (плавный одиночный пик)
     *             - `center`    → `'sine'`      (плавный out-and-back)
     *             - `dash`      → `'linear'`    (равномерное течение)
     */
    constructor(options = {}) {
        if (!options.positions || options.positions.length < 2) {
            throw new Error('Vector3D: options.positions required, at least 2 points');
        }

        /** @private */ this._positions = options.positions;
        /** @private @type {string|null} */ this._crsCode = options.crs ?? null;
        /** @private @type {import('./Projections.js').Projection|null} */ this._crs = null;
        /** @private */ this._isEcef = isEcefCrs(this._crsCode);

        /** @private */ this._color     = options.color ?? '#3388ff';
        /** @private */ this._width     = options.width ?? 2;
        /** @private */ this._arrowSize = options.arrowSize ?? 10;
        /** @private @type {'px'|'world'} */
        this._arrowSizeMode = options.arrowSizeMode === 'world' ? 'world' : 'px';
        /** @private */ this._opacity   = options.opacity ?? 1;
        /** @private */ this._depthTest = options.depthTest ?? false;
        /** @private */ this._minZoom   = options.minZoom ?? -Infinity;
        /** @private */ this._maxZoom   = options.maxZoom ?? Infinity;
        /** @private */ this._heightScale    = options.heightScale ?? 1;
        /** @private */ this._altitudeOffset = options.altitudeOffset ?? 0;

        // ---------- Подписи ----------
        /**
         * @type {{start: Object, end: Object}}
         * @private
         */
        this._titles = {
            start: this._parseTitleOptions(options, 'start'),
            end:   this._parseTitleOptions(options, 'end'),
        };

        /** @private */ this._tooltip = options.tooltip ?? '';
        /** @private */ this._onClick = options.onClick ?? null;
        /** @private */ this._onHover = options.onHover ?? null;

        /** @private */ this._map = null;
        /** @private */ this._layer = null;
        /** @private */ this._group = new THREE.Group();

        /** @private */ this._line = null;
        /** @private */ this._material = null;
        /** @private */ this._geometry = null;
        /** @private */ this._cone = null;

        /** @private @type {number} */
        this._lastSegLen = 0;

        /** @private @type {Array<{role:string, handle:any, facade:any}>} */
        this._labels = [];
        /** @private */ this._unregisterInteraction = null;

        /** @private @type {Array<[number,number,number]>} */
        this._worldPoints = [];

        /* ---------- Анимации ---------- */
        /** @private @type {Array<{config: Object, time: number}>} */
        this._animList = [];
        this._parseAnimationsInto(options.animation);

        /** @private @type {{lengths:number[], total:number}|null} */
        this._animPolyline = null;
        /** @private */ this._lastUpdateTime = 0;

        /* ---------- Temp-векторы ---------- */
        /** @private */ this._tempVecA = new THREE.Vector3();
        /** @private */ this._tempVecB = new THREE.Vector3();
        /** @private */ this._Y_AXIS   = new THREE.Vector3(0, 1, 0);
    }

    /* ================================================================
       Подписи
       ================================================================ */

    /**
     * @param {Object} options
     * @param {'start'|'end'} role
     * @returns {{text:string, style:Object, minZoom:number, maxZoom:number,
     *            align:string, verticalAlign:string, offset:[number,number],
     *            allowOverflow:boolean, priority:number}}
     * @private
     */
    _parseTitleOptions(options, role) {
        const isStart = role === 'start';
        const sfx = isStart ? 'Start' : 'End';
        const placement = options.titlePlacement;

        let text;
        if (isStart) {
            text = options.titleStart
                ?? (placement === 'end' ? '' : (options.title ?? ''));
        } else {
            text = options.titleEnd
                ?? (placement === 'end' ? (options.title ?? '') : '');
        }

        const pick = (common, specific, def) =>
            options[specific] ?? options[common] ?? def;

        return {
            text,
            style:         pick('titleStyle',         `title${sfx}Style`,         {}),
            minZoom:       pick('titleMinZoom',       `title${sfx}MinZoom`,       -Infinity),
            maxZoom:       pick('titleMaxZoom',       `title${sfx}MaxZoom`,       Infinity),
            align:         pick('titleAlign',         `title${sfx}Align`,         'center'),
            verticalAlign: pick('titleVerticalAlign', `title${sfx}VerticalAlign`,
                                isStart ? 'bottom' : 'top'),
            offset:        pick('titleOffset',        `title${sfx}Offset`,
                                isStart ? [0, -10] : [0, 10]),
            allowOverflow: pick('titleAllowOverflow', `title${sfx}AllowOverflow`, false),
            priority:      pick('titlePriority',      `title${sfx}Priority`,      0),
        };
    }

    /**
     * @param {'start'|'end'} role
     * @returns {Object}
     * @private
     */
    _makeLabelFacade(role) {
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
            getLabelType: () => 'point',
            isVisible: () => {
                if (!v._layer || !v._layer.visible) return false;
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

    /**
     * @param {'start'|'end'} role
     * @returns {{x:number,y:number}|null}
     * @private
     */
    _getScreenPositionAt(role) {
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

    /* ================================================================
       Парсинг анимаций
       ================================================================ */

    /**
     * @param {Object|string|Array|null|undefined|false} anim
     * @private
     */
    _parseAnimationsInto(anim) {
        // Полная замена списка. Старые ресурсы к этому моменту уже должны
        // быть освобождены через _teardownAnimations() (в setAnimation).
        this._animList = [];
        if (!anim) return;
        const arr = Array.isArray(anim) ? anim : [anim];
        for (const a of arr) {
            const cfg = this._parseOneAnimation(a);
            if (cfg) this._animList.push({ config: cfg, time: 0 });
        }
    }

    /**
     * @param {Object|string|null|undefined|false} anim
     * @returns {Object|null}
     * @private
     */
    _parseOneAnimation(anim) {
        if (!anim || anim === false) return null;
        if (typeof anim === 'string') anim = { type: anim };
        const type = anim.type ?? 'none';
        if (type === 'none') return null;

        const base = {
            type,
            period:  anim.period  ?? 3,
            speed:   anim.speed   ?? 1,
            paused:  anim.paused  ?? false,
            reverse: anim.reverse ?? false,
            fadeRatio: Math.min(0.5, Math.max(0, anim.fadeRatio ?? 0.15)),

            color:    anim.color    ?? null,
            size:     anim.size     ?? null,
            sizeMode: anim.sizeMode ?? null,
            opacity:  anim.opacity  ?? null,
        };

        if (type === 'movingArrow') {
            base.easing = anim.easing ?? 'sine';
            base.hideStaticArrow = anim.hideStaticArrow ?? true;
        }

        if (type === 'flowArrows') {
            base.count   = anim.count   ?? 3;
            base.spacing = anim.spacing ?? null;
            base.hideStaticArrow = anim.hideStaticArrow ?? true;
        }

        if (type === 'pulse') {
            base.minScale = anim.minScale ?? 0.4;
            base.maxScale = anim.maxScale ?? 1.2;
            base.easing   = anim.easing   ?? 'sine';
            base.hideStaticArrow = anim.hideStaticArrow ?? false;
        }

        if (type === 'part') {
            base.mode = anim.mode ?? 'extend';

            // Дефолтный easing зависит от режима — именно это делает
            // `extend` и `boomerang` визуально РАЗНЫМИ:
            //   extend    — пила (линейный рост + мгновенный сброс);
            //   boomerang — плавный одиночный out-and-back;
            //   center    — плавный рост от середины;
            //   dash      — равномерное течение пунктира.
            let defaultEasing;
            switch (base.mode) {
                case 'dash':      defaultEasing = 'linear';    break;
                case 'extend':    defaultEasing = 'linear';    break;
                case 'boomerang': defaultEasing = 'easeInOut'; break;
                case 'center':
                default:          defaultEasing = 'sine';      break;
            }
            base.easing = anim.easing ?? defaultEasing;

            base.dashLength     = anim.dashLength     ?? 20;
            base.dashLengthMode = anim.dashLengthMode ?? 'world';
            base.gapRatio       = anim.gapRatio       ?? 1;
            base.offsetStep     = anim.offsetStep     ?? 1;
            base.headCone       = anim.headCone       ?? false;
            base.headConeSize   = anim.headConeSize   ?? null;
            base.headConeColor  = anim.headConeColor  ?? null;
            base.width          = anim.width          ?? null;
            base.hideBaseLine   = anim.hideBaseLine   ?? true;
            base.fadeEdges      = anim.fadeEdges      ?? false;
            base.hideStaticArrow = anim.hideStaticArrow ?? true;
        }

        return base;
    }

    /**
     * Применяет функцию плавности к фазе `phase ∈ [0, 1]`.
     *
     *  - `'linear'`    — `f(t) = t`.                                     (пила при `extend`)
     *  - `'sine'`      — `f(t) = 0.5 − 0.5·cos(2πt)`: 0→1→0.             (полный цикл)
     *  - `'easeIn'`    — `t²`: медленный старт.
     *  - `'easeOut'`   — `1 − (1−t)²`: быстрый старт.
     *  - `'easeInOut'` — S-кривая 0→1: плавный старт и финиш.
     *
     * Для `boomerang` (где поверх этой кривой ещё накладывается
     * треугольная волна) корректны только `'linear'`, `'easeIn'`,
     * `'easeOut'`, `'easeInOut'` — они монотонны на `[0,1]` и дают
     * одиночный пик. `'sine'` не монотонен и даст две осцилляции.
     *
     * @param {string} easing
     * @param {number} phase
     * @returns {number}
     * @private
     */
    _applyEasing(easing, phase) {
        if (easing === 'linear')    return phase;
        if (easing === 'easeIn')    return phase * phase;
        if (easing === 'easeOut')   return 1 - (1 - phase) * (1 - phase);
        if (easing === 'easeInOut') {
            // FIX: монотонная S-кривая 0→1 (не путать с 'sine' ниже,
            // который даёт 0→1→0).
            return phase < 0.5
                ? 2 * phase * phase
                : 1 - 2 * (1 - phase) * (1 - phase);
        }
        // 'sine' или неизвестное: 0→1→0 (полный цикл за фазу)
        return 0.5 - 0.5 * Math.cos(phase * Math.PI * 2);
    }

    /* ================================================================
       Геометрия маршрута
       ================================================================ */

    /**
     * @returns {{lengths:number[], total:number}|null}
     * @private
     */
    _computePolylineData() {
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

    /**
     * Точка и тангенс на ломаной при параметре `t ∈ [0,1]`.
     * @param {number} t
     * @param {THREE.Vector3} outPos
     * @param {THREE.Vector3} outTangent
     * @returns {boolean}
     * @private
     */
    _getPointAtT(t, outPos, outTangent) {
        const poly = this._animPolyline;
        if (!poly || poly.total <= 0) return false;

        const len = (((t % 1) + 1) % 1) * poly.total;
        let i = 1;
        while (i < poly.lengths.length && poly.lengths[i] < len) i++;
        if (i >= poly.lengths.length) i = poly.lengths.length - 1;

        const segStart = poly.lengths[i - 1];
        const segLen   = poly.lengths[i] - segStart;
        const localT   = segLen > 0 ? (len - segStart) / segLen : 0;

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

    /**
     * @param {number} t0
     * @param {number} t1
     * @param {number[]} out
     * @private
     */
    _emitRangeSegments(t0, t1, out) {
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
            const segEnd   = poly.lengths[i];
            const segLen   = segEnd - segStart;
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

    /* ================================================================
       Setup / teardown анимационных ресурсов
       ================================================================ */

    /**
     * @param {import('./KrbMap.js').KrbMap} map
     * @private
     */
    _setupAnimations(map) {
        this._animPolyline = this._computePolylineData();
        if (!this._animPolyline) return;

        for (const anim of this._animList) {
            anim.time = 0;                              // FIX: свежий старт
            this._setupOneAnimation(anim, map);
        }

        if (this._cone) {
            const hide = this._animList.some(a => a.config.hideStaticArrow);
            if (hide) this._cone.visible = false;
        }
    }

    /**
     * @param {{config:Object, time:number}} anim
     * @param {import('./KrbMap.js').KrbMap} map
     * @private
     */
    _setupOneAnimation(anim, map) {
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

            let count = o.count;
            if (o.spacing > 0 && this._animPolyline.total > 0) {
                count = Math.round(this._animPolyline.total / o.spacing);
            }
            count = Math.max(1, Math.min(FLOW_MAX_CONES, count));

            const color   = o.color   ?? this._color;
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
            anim.overlay    = overlay;
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

    /**
     * Освобождает GPU-ресурсы всех анимаций, но **сохраняет** конфиги
     * в `_animList` — чтобы после повторного `_attach()` анимации могли
     * быть созданы заново.
     *
     * @private
     */
    _teardownAnimations() {
        for (const anim of this._animList) {
            const o = anim.config;

            if (o.type === 'movingArrow' && anim.cone) {
                anim.cone.geometry.dispose();
                anim.cone.material.dispose();
                if (anim.cone.parent) anim.cone.parent.remove(anim.cone);
                anim.cone = null;
            }

            if (o.type === 'flowArrows' && anim.group) {
                for (const c of anim.cones) {
                    c.geometry.dispose();
                    c.material.dispose();
                }
                if (anim.group.parent) anim.group.parent.remove(anim.group);
                anim.group = null;
                anim.cones = null;
            }

            if (o.type === 'part') {
                if (anim.overlay) {
                    anim.overlay.geometry.dispose();
                    anim.overlay.material.dispose();
                    if (anim.overlay.parent) anim.overlay.parent.remove(anim.overlay);
                    anim.overlay    = null;
                    anim.overlayGeo = null;
                    anim.overlayMat = null;
                }
                if (anim.headConeGroup) {
                    for (const c of anim.headConePool) {
                        c.geometry.dispose();
                        c.material.dispose();
                    }
                    if (anim.headConeGroup.parent) {
                        anim.headConeGroup.parent.remove(anim.headConeGroup);
                    }
                    anim.headConeGroup = null;
                    anim.headConePool = null;
                }
                if (o.hideBaseLine && this._line) this._line.visible = true;
            }
        }

        // НЕ очищаем _animList — конфиги должны переживать remove().
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

    /* ================================================================
       Шаг анимаций
       ================================================================ */

    /**
     * @param {import('./KrbMap.js').KrbMap} map
     * @param {number} deltaTime
     * @private
     */
    _stepAllAnimations(map, deltaTime) {
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

    /** @private */
    _stepMovingArrow(anim, map, phase) {
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

    /** @private */
    _stepFlowArrows(anim, map, phase) {
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

    /**
     * Пульс масштаба концевого конуса.
     *
     * `easing` управляет формой волны:
     *  - `'sine'`      — плавный 0→1→0 (по умолчанию);
     *  - `'linear'`    — треугольная волна 0→1→0 (резкая);
     *  - `'easeIn'`    — `easeIn(tri(t))` — медленный рост/спад;
     *  - `'easeOut'`   — `easeOut(tri(t))` — быстрый рост/спад;
     *  - `'easeInOut'` — `easeInOut(tri(t))` — S-кривая.
     *
     * @private
     */
    _stepPulse(anim, map, phase) {
        const o = anim.config;
        if (!this._cone || !this._cone.visible) return;

        let s;
        if (o.easing === 'linear') {
            s = phase < 0.5 ? phase * 2 : 2 - phase * 2;
        } else if (o.easing === 'sine' || !o.easing) {
            s = 0.5 - 0.5 * Math.cos(phase * Math.PI * 2);
        } else {
            const tri = 1 - Math.abs(2 * phase - 1);
            s = this._applyEasing(o.easing, tri);
        }

        const mult = o.minScale + (o.maxScale - o.minScale) * s;
        const base = o.size ?? this._arrowSize;
        this._applyConeScale(map, this._cone, base * mult, o.sizeMode);
    }

    /**
     * Разные режимы `part` дают визуально разные анимации:
     *
     *  - `extend`    — `f = easing(phase)`;  диапазон `[0, f]`.
     *                  По умолчанию `linear` — линейный рост, снап в 0
     *                  в начале нового периода (пила `/|/|`).
     *  - `center`    — `f = easing(phase)`;  диапазон `[0.5−f/2, 0.5+f/2]`.
     *                  По умолчанию `sine` — плавный out-and-back от центра.
     *  - `boomerang` — `f = easing(tri(phase))`, где `tri` — треугольная
     *                  волна. По умолчанию `easeInOut` — плавный одиночный
     *                  out-and-back.
     *  - `dash`      — строит набор диапазонов через `_computeDashRanges`.
     *
     * @param {{config:Object, time:number}} anim
     * @param {import('./KrbMap.js').KrbMap} map
     * @param {number} phase
     * @private
     */
    _stepPart(anim, map, phase) {
        const o = anim.config;
        if (!anim.overlay) return;

        let ranges = [];

        if (o.mode === 'extend') {
            // Пила: линейный рост (по умолчанию). Пользователь может
            // переопределить easing — тогда рост будет с ускорением,
            // но снап в 0 всё равно произойдёт в конце периода.
            const f = this._applyEasing(o.easing, phase);
            ranges = [o.reverse ? [1 - f, 1] : [0, f]];
        } else if (o.mode === 'center') {
            const f = this._applyEasing(o.easing, phase);
            ranges = [[0.5 - f / 2, 0.5 + f / 2]];
        } else if (o.mode === 'boomerang') {
            // Треугольная волна 0→1→0, поверх неё — монотонный easing.
            // По умолчанию `easeInOut` — плавный одиночный пик.
            const tri = 1 - Math.abs(2 * phase - 1);
            const f = this._applyEasing(o.easing, tri);
            ranges = [o.reverse ? [1 - f, 1] : [0, f]];
        } else if (o.mode === 'dash') {
            const f = this._applyEasing(o.easing, phase);
            ranges = this._computeDashRanges(o, f);
        }

        ranges = ranges.filter(([a, b]) => b > a);

        this._rebuildOverlay(anim, map, ranges);
        if (o.headCone) this._rebuildHeadCones(anim, map, ranges);
    }

    /**
     * Стартуем с `i = -1`, чтобы при integer `offsetStep` цикл
     * dash-паттерна был бесшовным (первый «dash» на phase=1 совпадает
     * с первым «dash» на phase=0).
     *
     * @param {Object} o
     * @param {number} phase
     * @returns {Array<[number, number]>}
     * @private
     */
    _computeDashRanges(o, phase) {
        if (!this._animPolyline) return [];
        const L = this._animPolyline.total;
        const dashLen = o.dashLengthMode === 'fraction'
            ? o.dashLength * L
            : o.dashLength;
        const gapLen = dashLen * (o.gapRatio ?? 1);
        const step   = dashLen + gapLen;
        if (step <= 0) return [];

        const count = Math.min(MAX_DASH_SEGMENTS, Math.ceil(L / step) + 2);
        let shift = phase * step * (o.offsetStep ?? 1);
        if (o.reverse) shift = -shift;

        const ranges = [];
        for (let i = -1; i < count; i++) {
            const startLen = i * step + shift;
            const endLen   = startLen + dashLen;
            const cs = Math.max(0, startLen);
            const ce = Math.min(L, endLen);
            if (ce > cs) ranges.push([cs / L, ce / L]);
        }
        return ranges;
    }

    /**
     * @param {{config:Object, overlay:any, overlayGeo:any}} anim
     * @param {import('./KrbMap.js').KrbMap} map
     * @param {Array<[number, number]>} ranges
     * @private
     */
    _rebuildOverlay(anim, map, ranges) {
        const positions = [];
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

    /**
     * @param {{config:Object, headConeGroup:any, headConePool:any[]}} anim
     * @param {import('./KrbMap.js').KrbMap} map
     * @param {Array<[number, number]>} ranges
     * @private
     */
    _rebuildHeadCones(anim, map, ranges) {
        if (!anim.headConeGroup) return;
        const o = anim.config;
        const pool = anim.headConePool;
        const n = Math.min(ranges.length, MAX_HEAD_CONES);

        const coneColor   = o.headConeColor ?? o.color ?? this._color;
        const coneOpacity = o.opacity ?? this._opacity;
        const headSize    = o.headConeSize ?? o.size ?? this._arrowSize;
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

            cone.material.color.set(coneColor);
            cone.material.opacity = coneOpacity;
            cone.material.transparent = coneOpacity < 1;

            this._applyConeScale(map, cone, headSize, headSizeMode);
        }
    }

    /**
     * @private
     */
    _resetStaticConePosition() {
        if (!this._cone || !this._map || this._worldPoints.length < 2) return;
        const last = this._worldPoints.length - 1;
        const pFrom = new THREE.Vector3(...this._worldPoints[last - 1]);
        const pTo   = new THREE.Vector3(...this._worldPoints[last]);
        const dir = new THREE.Vector3().subVectors(pTo, pFrom);
        const len = dir.length();
        if (len < 1e-6) return;

        this._cone.position.copy(pTo);
        this._cone.quaternion.setFromUnitVectors(this._Y_AXIS, dir.normalize());
        this._lastSegLen = len;
        this._applyConeScale(this._map);
    }

    /* ================================================================
       Публичное API анимации
       ================================================================ */

    /**
     * @param {Object|string|Array|null} animation
     * @returns {Vector3D}
     */
    setAnimation(animation) {
        this._teardownAnimations();
        this._parseAnimationsInto(animation);
        if (this._map && this._line) {
            this._setupAnimations(this._map);
        }
        return this;
    }

    /** @param {number} index @returns {Vector3D} */
    pauseAnimation(index = -1) {
        if (index < 0) this._animList.forEach(a => (a.config.paused = true));
        else if (this._animList[index]) this._animList[index].config.paused = true;
        return this;
    }

    /** @param {number} index @returns {Vector3D} */
    resumeAnimation(index = -1) {
        if (index < 0) this._animList.forEach(a => (a.config.paused = false));
        else if (this._animList[index]) this._animList[index].config.paused = false;
        return this;
    }

    /** @param {number} speed @param {number} [index=-1] @returns {Vector3D} */
    setAnimationSpeed(speed, index = -1) {
        if (index < 0) this._animList.forEach(a => (a.config.speed = speed));
        else if (this._animList[index]) this._animList[index].config.speed = speed;
        return this;
    }

    /* ================================================================
       Attach
       ================================================================ */

    /**
     * `remove()` вызывается только если объект уже куда-то привязан.
     * Иначе первый `_attach` уничтожал `_animList`.
     *
     * @param {import('./KrbMap.js').KrbMap} map
     * @param {Layer} layer
     * @private
     */
    _attach(map, layer) {
        if (this._map === map && this._layer === layer) return;
        if (this._map || this._layer) this.remove();
        this._map = map;
        this._layer = layer;

        this._crs = this._crsCode ? Projections.get(this._crsCode) : map.inputCRS;

        // --- Проецируем точки в world-метры --------------------------------
        const worldPts = [];
        for (let i = 0; i < this._positions.length; i++) {
            const p = this._positions[i];
            if (!Array.isArray(p) || p.length < 2) continue;

            let xy = null, h = 0;
            if (this._isEcef) {
                const [lon, lat, hh] = ecefToGeodetic(p[0], p[1], p[2] ?? 0);
                xy = map.projectSafe([lon, lat], 'EPSG:4326');
                h = hh;
            } else {
                xy = map.projectSafe([p[0], p[1]], this._crs);
                h = p[2] ?? 0;
            }
            if (!xy) continue;

            const worldY = h * this._heightScale + this._altitudeOffset;
            worldPts.push([xy[0], worldY, xy[1]]);
        }
        this._worldPoints = worldPts;
        if (worldPts.length < 2) return;

        // --- Line2 ---------------------------------------------------------
        const flat = [];
        for (const wp of worldPts) flat.push(wp[0], wp[1], wp[2]);

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

        // --- Статичный концевой конус --------------------------------------
        const last = worldPts.length - 1;
        const pFrom = new THREE.Vector3(...worldPts[last - 1]);
        const pTo   = new THREE.Vector3(...worldPts[last]);
        const dir   = new THREE.Vector3().subVectors(pTo, pFrom);
        const len   = dir.length();

        if (len > 1e-6) {
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
            this._applyConeScale(map);

            this._group.add(this._cone);
        }

        // --- Анимации ------------------------------------------------------
        if (this._animList.length) this._setupAnimations(map);

        map.worldGroup.add(this._group);

        // --- InteractionManager --------------------------------------------
        if (map.interaction && (this._onClick || this._onHover || this._tooltip)) {
            this._unregisterInteraction = map.interaction.register(this, {
                getMeshes: () => {
                    const meshes = [];
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
                onClick:    this._onClick || null,
                onHover:    this._onHover || null,
                getTooltip: this._tooltip ? () => this._tooltip : null,
                isVisible:  () => this._group.visible,
            });
        }

        // --- TextManager (две подписи) -------------------------------------
        if (map.textManager) {
            for (const role of ['start', 'end']) {
                const title = this._titles[role];
                if (!title.text) continue;
                const facade = this._makeLabelFacade(role);
                const handle = map.textManager.addLabel(facade);
                this._labels.push({ role, handle, facade });
            }
        }
    }

    /**
     * @param {import('./KrbMap.js').KrbMap} map
     * @param {THREE.Mesh} [cone=this._cone]
     * @param {number|null} [size=null]
     * @param {'px'|'world'|null} [sizeMode=null]
     * @private
     */
    _applyConeScale(map, cone = this._cone, size = null, sizeMode = null) {
        if (!cone) return;

        const s    = size ?? this._arrowSize;
        const mode = sizeMode ?? this._arrowSizeMode;

        let h;
        if (mode === 'world') {
            h = s;
            if (this._lastSegLen > 0) h = Math.min(h, this._lastSegLen * 0.4);
        } else {
            const wgPos = map.worldGroup.position;
            const pos   = cone.position;
            const dist  = map.camera.position.distanceTo(
                map.getVec3().set(
                    pos.x + wgPos.x,
                    pos.y + wgPos.y,
                    pos.z + wgPos.z
                )
            );
            const canvas  = map.renderer.domElement;
            const fovRad  = map.camera.fov * Math.PI / 180;
            const hPixels = Math.max(1, canvas.clientHeight);
            const worldPerPixel = (2 * dist * Math.tan(fovRad / 2)) / hPixels;
            h = s * worldPerPixel;
        }

        if (!isFinite(h) || h <= 0) h = 1e-6;
        cone.scale.setScalar(h);
    }

    /**
     * @param {import('./KrbMap.js').KrbMap} map
     * @param {number} [deltaTime]
     * @private
     */
    _update(map, deltaTime) {
        if (!this._map || !this._line) return;

        if (typeof deltaTime !== 'number' || !isFinite(deltaTime) || deltaTime < 0) {
            const now = performance.now();
            deltaTime = this._lastUpdateTime
                ? Math.min((now - this._lastUpdateTime) / 1000, 0.1)
                : 0;
        }
        if (deltaTime > 0.1) deltaTime = 0.1;
        this._lastUpdateTime = performance.now();

        const zoom = map.continuousZoom;
        let visible = (this._layer ? this._layer.visible : true)
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

    /**
     * Если уже на этой карте — ранний выход; иначе `remove()` с
     * последующим созданием персонального слоя.
     *
     * @param {import('./KrbMap.js').KrbMap} map
     * @returns {Vector3D}
     */
    addTo(map) {
        if (this._map === map && this._layer) return this;
        if (this._map) this.remove();
        const personalLayer = new Layer();
        personalLayer.addTo(map);
        personalLayer.add(this);
        return this;
    }

    /**
     * Удаляет вектор с карты, освобождает ресурсы и снимает регистрации.
     * Сохраняет `_animList` (см. `_teardownAnimations`).
     */
    remove() {
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

    /**
     * @param {string|import('./Projections.js').Projection} [crs='EPSG:4326']
     * @returns {Array<Array<number>>|null}
     */
    getBounds(crs = 'EPSG:4326') {
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

    /* ---------------- Legacy-геттеры (делегируют к start) ---------------- */

    /** @returns {string} */ getText() { return this._titles.start.text; }
    /** @returns {Object} */
    getTextStyle() {
        return Object.assign({
            fontFamily: 'sans-serif',
            color: '#ffffff',
            fontSize: '12px',
            fontWeight: 'bold',
            textShadow: '1px 1px 2px rgba(0,0,0,0.9), -1px -1px 2px rgba(0,0,0,0.9)',
        }, this._titles.start.style);
    }
    /** @returns {{min:number,max:number}} */
    getTextZoomBounds() {
        return { min: this._titles.start.minZoom, max: this._titles.start.maxZoom };
    }
    /** @returns {'point'} */ getLabelType() { return 'point'; }
    /** @returns {boolean} */
    isVisible() {
        if (!this._layer || !this._layer.visible) return false;
        if (!this._map) return false;
        const zoom = this._map.continuousZoom;
        return zoom >= this._titles.start.minZoom && zoom <= this._titles.start.maxZoom;
    }
    /** @returns {{x:number,y:number}|null} */
    getScreenPosition() { return this._getScreenPositionAt('start'); }
    /** @returns {'left'|'center'|'right'} */ getTitleAlign() { return this._titles.start.align; }
    /** @returns {'top'|'middle'|'bottom'} */ getTitleVerticalAlign() { return this._titles.start.verticalAlign; }
    /** @returns {[number, number]} */ getTitleOffset() { return this._titles.start.offset; }
    /** @returns {boolean} */ getAllowOverflow() { return this._titles.start.allowOverflow; }
    /** @returns {number} */ getPriority() { return this._titles.start.priority; }
}