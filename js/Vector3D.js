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
 * Поддерживается анимация (см. опцию `animation`):
 *  - `movingArrow` — единственный конус скользит по ломаной;
 *  - `flowArrows`  — несколько конусов «текут» вдоль вектора;
 *  - `pulse`       — концевой конус пульсирует размером.
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
 * @param {number} X
 * @param {number} Y
 * @param {number} Z
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
 * @param {number} e - East, м.
 * @param {number} n - North, м.
 * @param {number} u - Up, м.
 * @param {number} lonRad
 * @param {number} latRad
 * @returns {[number, number, number]} [dX, dY, dZ] в ECEF.
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

/** Известные коды ECEF-проекций. @type {Set<string>} */
export const ECEF_CODES = new Set([
    'EPSG:4978',  'EPSG:10176',
    'EPSG:7901',  'EPSG:7902',  'EPSG:7903',  'EPSG:7904',
    'EPSG:7905',  'EPSG:7906',  'EPSG:7907',  'EPSG:7908',
    'EPSG:7909',  'EPSG:7910',  'EPSG:7911',  'EPSG:7912',
    'EPSG:8403',  'EPSG:8404',
]);

/**
 * @param {string|null|undefined} code
 * @returns {boolean}
 */
export function isEcefCrs(code) {
    return code ? ECEF_CODES.has(code.toUpperCase()) : false;
}


/* ================================================================
   Vector3D
   ================================================================ */

/** Отношение радиуса конуса к его высоте. @private @type {number} */
const CONE_RADIUS_RATIO = 0.35;

/** Максимум одновременных конусов в `flowArrows`. @private @type {number} */
const FLOW_MAX_CONES = 50;

export class Vector3D {
    /**
     * @param {Object} options
     * @param {Array<[number, number, number]>} options.positions
     *     Узлы вектора `[x, y, z]` в СК `crs`. Минимум 2 точки.
     * @param {string} [options.crs] - Код СК; по умолчанию `map.inputCRS`.
     *     Если задан ECEF-код — точки трактуются как ECEF.
     * @param {string} [options.color='#3388ff']
     * @param {number} [options.width=2] - Толщина линии, px.
     * @param {number} [options.arrowSize=10] - Размер "наконечника".
     *     Единицы измерения определяются `arrowSizeMode`:
     *      - `'px'`    — экранные пиксели (CSS);
     *      - `'world'` — world-метры (абсолютная величина, не зависит от зума).
     * @param {'px'|'world'} [options.arrowSizeMode='px'] - Режим трактовки
     *     `arrowSize`. В режиме `'px'` размер конуса пересчитывается при
     *     каждом зуме так, чтобы визуально на экране он всегда занимал
     *     `arrowSize` пикселей.
     * @param {number} [options.opacity=1]
     * @param {boolean} [options.depthTest=false]
     * @param {number} [options.heightScale=1] - Множитель высоты.
     * @param {number} [options.altitudeOffset=0] - Аддитивный сдвиг Y, м.
     * @param {number} [options.minZoom=-Infinity]
     * @param {number} [options.maxZoom=Infinity]
     *
     * @param {string} [options.title='']
     * @param {Object} [options.titleStyle={}]
     * @param {number} [options.titleMinZoom=-Infinity]
     * @param {number} [options.titleMaxZoom=Infinity]
     * @param {'start'|'end'} [options.titlePlacement='start']
     * @param {[number, number]} [options.titleOffset=[0,-10]]
     * @param {'left'|'center'|'right'} [options.titleAlign='center']
     * @param {'top'|'middle'|'bottom'} [options.titleVerticalAlign='bottom']
     * @param {boolean} [options.titleAllowOverflow=false]
     * @param {number} [options.titlePriority=0]
     *
     * @param {string} [options.tooltip='']
     * @param {Function|null} [options.onClick=null]
     * @param {Function|null} [options.onHover=null]
     *
     * @param {Object|string|null} [options.animation=null] - Анимация вектора.
     *     Может быть строкой (`'movingArrow' | 'flowArrows' | 'pulse' | 'none'`)
     *     или объектом со следующими полями:
     *
     * @param {'movingArrow'|'flowArrows'|'pulse'|'none'} [options.animation.type='none']
     *     `movingArrow` — один конус скользит по ломаной;
     *     `flowArrows`  — N маленьких конусов текут вдоль вектора;
     *     `pulse`       — концевой конус пульсирует размером.
     * @param {number} [options.animation.period=3] - Секунд на один полный цикл.
     * @param {number} [options.animation.speed=1] - Множитель скорости.
     * @param {boolean} [options.animation.paused=false] - Стартовать на паузе.
     * @param {boolean} [options.animation.reverse=false] - Гнать от конца к началу.
     * @param {number} [options.animation.fadeRatio=0.15] - Доля пути у краёв
     *     (0..0.5), на которой конусы плавно появляются/исчезают.
     * @param {string|null} [options.animation.color=null] - null → `this._color`.
     * @param {number|null} [options.animation.size=null] - null → `this._arrowSize`.
     * @param {'px'|'world'|null} [options.animation.sizeMode=null] - null →
     *     `this._arrowSizeMode`.
     * @param {number|null} [options.animation.opacity=null] - null → `this._opacity`.
     * @param {boolean} [options.animation.hideStaticArrow=true] - Скрыть
     *     статичный концевой конус (для `movingArrow` / `flowArrows`;
     *     для `pulse` игнорируется — `pulse` анимирует именно его).
     * @param {number} [options.animation.count=3] - Кол-во конусов для `flowArrows`.
     * @param {number|null} [options.animation.spacing=null] - Альтернатива `count`:
     *     мировой шаг между конусами (если задан — `count` вычисляется
     *     из длины пути).
     * @param {number} [options.animation.minScale=0.4] - Для `pulse`.
     * @param {number} [options.animation.maxScale=1.2] - Для `pulse`.
     * @param {'sine'|'linear'} [options.animation.easing='sine'] - Для `pulse`.
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

        /** @private */ this._title              = options.title ?? '';
        /** @private */ this._titleStyle         = options.titleStyle ?? {};
        /** @private */ this._titleMinZoom       = options.titleMinZoom ?? -Infinity;
        /** @private */ this._titleMaxZoom       = options.titleMaxZoom ?? Infinity;
        /** @private */ this._titlePlacement     = options.titlePlacement ?? 'start';
        /** @private */ this._titleOffset        = options.titleOffset ?? [0, -10];
        /** @private */ this._titleAlign         = options.titleAlign ?? 'center';
        /** @private */ this._titleVerticalAlign = options.titleVerticalAlign ?? 'bottom';
        /** @private */ this._titleAllowOverflow = options.titleAllowOverflow ?? false;
        /** @private */ this._titlePriority      = options.titlePriority ?? 0;

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

        /**
         * Длина последнего сегмента в world-метрах — для ограничения
         * размера конуса в `'world'`-режиме (не больше 40 % сегмента).
         * @private @type {number}
         */
        this._lastSegLen = 0;

        /** @private */ this._textLabel = null;
        /** @private */ this._unregisterInteraction = null;

        /** @private @type {Array<[number,number,number]>} */
        this._worldPoints = [];

        /* ---------- Анимация ---------- */
        /** @private @type {Object|null} */
        this._animOptions   = this._parseAnimationOptions(options.animation);
        /** @private */ this._animTime      = 0;
        /** @private */ this._animGroup     = null;
        /** @private @type {Array<THREE.Mesh>|null} */
        this._flowCones     = null;
        /** @private @type {{lengths:number[], total:number}|null} */
        this._animPolyline  = null;
        /** @private */ this._lastUpdateTime = 0;

        /* ---------- Temp-векторы (без аллокаций в кадре) ---------- */
        /** @private */ this._tempVecA = new THREE.Vector3();
        /** @private */ this._tempVecB = new THREE.Vector3();
        /** @private */ this._Y_AXIS   = new THREE.Vector3(0, 1, 0);
    }

    /**
     * Создаёт персональный слой и добавляет на него вектор.
     * @param {import('./KrbMap.js').KrbMap} map
     * @returns {Vector3D} this
     */
    addTo(map) {
        if (this._map) this.remove();
        const personalLayer = new Layer();
        personalLayer.addTo(map);
        personalLayer.add(this);
        return this;
    }

    /* ================================================================
       Парсинг и настройка анимации
       ================================================================ */

    /**
     * @param {Object|string|null|undefined|false} anim
     * @returns {Object|null}
     * @private
     */
    _parseAnimationOptions(anim) {
        if (!anim || anim === false) return null;
        if (typeof anim === 'string') anim = { type: anim };
        const type = anim.type ?? 'none';
        if (type === 'none') return null;
        return {
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
            hideStaticArrow: anim.hideStaticArrow ?? true,

            count:   anim.count   ?? 3,
            spacing: anim.spacing ?? null,

            minScale: anim.minScale ?? 0.4,
            maxScale: anim.maxScale ?? 1.2,
            easing:   anim.easing   ?? 'sine',
        };
    }

    /**
     * Готовит анимационные объекты. Вызывается из {@link #_attach} или
     * {@link #setAnimation}.
     *
     * @param {import('./KrbMap.js').KrbMap} map
     * @private
     */
    _setupAnimation(map) {
        this._animPolyline = this._computePolylineData();
        if (!this._animPolyline) return; // нечего анимировать

        const o = this._animOptions;
        if (o.type === 'flowArrows') {
            this._animGroup = new THREE.Group();
            this._group.add(this._animGroup);

            let count = o.count;
            if (o.spacing > 0 && this._animPolyline.total > 0) {
                count = Math.round(this._animPolyline.total / o.spacing);
            }
            count = Math.max(1, Math.min(FLOW_MAX_CONES, count));

            const color   = o.color   ?? this._color;
            const opacity = o.opacity ?? this._opacity;

            this._flowCones = [];
            for (let i = 0; i < count; i++) {
                const g = new THREE.ConeGeometry(CONE_RADIUS_RATIO, 1, 12);
                g.translate(0, 0.5, 0);
                const mat = new THREE.MeshBasicMaterial({
                    color,
                    opacity,
                    transparent: opacity < 1,
                    depthTest: this._depthTest,
                    depthWrite: this._depthTest,
                });
                const cone = new THREE.Mesh(g, mat);
                cone.renderOrder = 999;
                this._animGroup.add(cone);
                this._flowCones.push(cone);
            }
        }

        // Скрываем статичный конус для movingArrow / flowArrows.
        // Для pulse его не трогаем — pulse анимирует именно его.
        if (o.type !== 'pulse' && o.hideStaticArrow && this._cone) {
            this._cone.visible = false;
        }
    }

    /**
     * @private
     * @returns {{lengths:number[], total:number}|null}
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
     * Возвращает точку и тангенс на ломаной при параметре `t`.
     * `t` может быть любым числом — приводится к `[0, 1)`.
     *
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

    /* ================================================================
       Шаг анимации
       ================================================================ */

    /** @private */
    _stepAnimation(map, deltaTime) {
        const o = this._animOptions;
        if (!o) return;
        if (!o.paused) this._animTime += deltaTime * o.speed;

        const period = Math.max(0.05, o.period);
        let phase = (this._animTime / period) % 1;
        if (phase < 0) phase += 1;

        if (o.type === 'movingArrow')      this._updateMovingArrow(map, phase);
        else if (o.type === 'flowArrows')  this._updateFlowArrows(map, phase);
        else if (o.type === 'pulse')       this._updatePulse(map, phase);
    }

    /** @private */
    _updateMovingArrow(map, phase) {
        if (!this._cone) return;
        this._cone.visible = true;

        const o = this._animOptions;
        const t = o.reverse ? 1 - phase : phase;
        if (!this._getPointAtT(t, this._tempVecA, this._tempVecB)) return;

        this._cone.position.copy(this._tempVecA);
        if (o.reverse) this._tempVecB.negate();
        this._cone.quaternion.setFromUnitVectors(this._Y_AXIS, this._tempVecB);

        const baseOpacity = o.opacity ?? this._opacity;
        let finalOpacity = baseOpacity;
        if (o.fadeRatio > 0) {
            const edge = Math.min(t, 1 - t) / o.fadeRatio;
            finalOpacity = baseOpacity * Math.max(0, Math.min(1, edge));
        }
        this._cone.material.opacity = finalOpacity;
        this._cone.material.transparent = finalOpacity < 1;

        this._applyConeScale(map, this._cone, o.size, o.sizeMode);
    }

    /** @private */
    _updateFlowArrows(map, phase) {
        if (!this._flowCones || !this._flowCones.length) return;

        const o = this._animOptions;
        const n = this._flowCones.length;
        const baseOpacity = o.opacity ?? this._opacity;

        for (let i = 0; i < n; i++) {
            const cone = this._flowCones[i];
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

    /** @private */
    _updatePulse(map, phase) {
        if (!this._cone) return;
        this._cone.visible = true;

        const o = this._animOptions;
        const s = o.easing === 'linear'
            ? (phase < 0.5 ? phase * 2 : 2 - phase * 2)
            : 0.5 - 0.5 * Math.cos(phase * Math.PI * 2);

        const mult = o.minScale + (o.maxScale - o.minScale) * s;
        const base = o.size ?? this._arrowSize;
        this._applyConeScale(map, this._cone, base * mult, o.sizeMode);
    }

    /**
     * Возвращает статичный концевой конус в исходное положение/масштаб.
     * Используется при `setAnimation(null)`.
     * @private
     */
    _resetStaticConePosition() {
        if (!this._cone || !this._map || this._worldPoints.length < 2) return;
        const last = this._worldPoints.length - 1;
        const pFrom = new THREE.Vector3(
            this._worldPoints[last - 1][0],
            this._worldPoints[last - 1][1],
            this._worldPoints[last - 1][2]
        );
        const pTo = new THREE.Vector3(
            this._worldPoints[last][0],
            this._worldPoints[last][1],
            this._worldPoints[last][2]
        );
        const dir = new THREE.Vector3().subVectors(pTo, pFrom);
        const len = dir.length();
        if (len < 1e-6) return;

        this._cone.position.copy(pTo);
        this._cone.quaternion.setFromUnitVectors(this._Y_AXIS, dir.normalize());
        this._lastSegLen = len;
        this._cone.visible = true;
        this._cone.material.opacity = this._opacity;
        this._cone.material.transparent = this._opacity < 1;
        this._applyConeScale(this._map);
    }

    /** @private */
    _teardownAnimation() {
        if (this._animGroup) {
            for (const c of this._animGroup.children) {
                if (c.geometry) c.geometry.dispose();
                if (c.material) c.material.dispose();
            }
            this._animGroup.clear();
            if (this._animGroup.parent) this._animGroup.parent.remove(this._animGroup);
            this._animGroup = null;
        }
        this._flowCones    = null;
        this._animPolyline = null;
    }

    /* ================================================================
       Публичное API анимации
       ================================================================ */

    /**
     * Задаёт / заменяет / снимает (`null`) анимацию.
     * @param {Object|string|null} animation
     * @returns {Vector3D} this
     */
    setAnimation(animation) {
        this._teardownAnimation();
        this._animOptions = this._parseAnimationOptions(animation);
        this._animTime = 0;

        if (this._map && this._line) {
            if (this._animOptions) this._setupAnimation(this._map);
            if (!this._animPolyline) this._resetStaticConePosition();
        }
        return this;
    }

    /** @returns {Vector3D} this */
    pauseAnimation() {
        if (this._animOptions) this._animOptions.paused = true;
        return this;
    }

    /** @returns {Vector3D} this */
    resumeAnimation() {
        if (this._animOptions) this._animOptions.paused = false;
        return this;
    }

    /**
     * @param {number} speed
     * @returns {Vector3D} this
     */
    setAnimationSpeed(speed) {
        if (this._animOptions) this._animOptions.speed = speed;
        return this;
    }

    /* ================================================================
       Attach
       ================================================================ */

    /**
     * @param {import('./KrbMap.js').KrbMap} map
     * @param {Layer} layer
     * @private
     */
    _attach(map, layer) {
        if (this._map === map && this._layer === layer) return;
        this.remove();
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

        // --- Стрелка на последнем сегменте --------------------------------
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

        // --- Анимация ------------------------------------------------------
        if (this._animOptions) this._setupAnimation(map);

        map.worldGroup.add(this._group);

        // --- InteractionManager --------------------------------------------
        if (map.interaction && (this._onClick || this._onHover || this._tooltip)) {
            this._unregisterInteraction = map.interaction.register(this, {
                getMeshes: () => {
                    const meshes = [];
                    if (this._line) meshes.push(this._line);
                    if (this._cone && this._cone.visible) meshes.push(this._cone);
                    if (this._flowCones) {
                        for (const c of this._flowCones) {
                            if (c.visible) meshes.push(c);
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

        // --- TextManager ---------------------------------------------------
        if (this._title && map.textManager) {
            this._textLabel = map.textManager.addLabel(this);
        }
    }

    /**
     * Пересчитывает масштаб конуса. Может применяться как к статичному
     * конусу (`this._cone`), так и к любому анимационному.
     *
     * В режиме `'px'` переводит пиксели в world-метры по текущему
     * состоянию камеры:
     *
     *     worldPerPixel = 2 * dist * tan(fov/2) / canvas.clientHeight
     *
     * В режиме `'world'` действует прежний предел 40 % длины последнего
     * сегмента (`this._lastSegLen`), чтобы конус не «съедал» всю линию.
     *
     * @param {import('./KrbMap.js').KrbMap} map
     * @param {THREE.Mesh} [cone=this._cone]
     * @param {number|null} [size=null] - null → `this._arrowSize`.
     * @param {'px'|'world'|null} [sizeMode=null] - null → `this._arrowSizeMode`.
     * @private
     */
    _applyConeScale(map, cone = this._cone, size = null, sizeMode = null) {
        if (!cone) return;

        const s    = size ?? this._arrowSize;
        const mode = sizeMode ?? this._arrowSizeMode;

        let h;
        if (mode === 'world') {
            h = s;
            if (this._lastSegLen > 0) {
                h = Math.min(h, this._lastSegLen * 0.4);
            }
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
     * @param {number} [deltaTime] - Время с прошлого кадра, сек.
     *     Если не передан — вычисляется из `performance.now()`.
     * @private
     */
    _update(map, deltaTime) {
        if (!this._map || !this._line) return;

        // Fallback для прямых вызовов (вне цепочки Layer._postUpdate)
        if (typeof deltaTime !== 'number' || !isFinite(deltaTime) || deltaTime < 0) {
            const now = performance.now();
            deltaTime = this._lastUpdateTime
                ? Math.min((now - this._lastUpdateTime) / 1000, 0.1)
                : 0;
        }
        // Защита от гигантских скачков (вкладка была в фоне и т.п.)
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

        if (this._animOptions && this._animPolyline) {
            this._stepAnimation(map, deltaTime);
        } else if (this._arrowSizeMode === 'px' && this._cone && this._cone.visible) {
            this._applyConeScale(map);
        }

        const cv = map.renderer.domElement;
        const res = this._material.resolution;
        if (res.x !== cv.width || res.y !== cv.height) {
            res.set(cv.width, cv.height);
        }
    }

    /** Удаляет вектор с карты, освобождает ресурсы и снимает регистрации. */
    remove() {
        if (this._unregisterInteraction) {
            this._unregisterInteraction();
            this._unregisterInteraction = null;
        }

        if (this._textLabel && this._map?.textManager) {
            this._map.textManager.removeLabel(this._textLabel);
            this._textLabel = null;
        }

        this._teardownAnimation();

        if (this._group.parent) this._group.parent.remove(this._group);

        // Чистим оставшихся детей (основная линия + статичный конус).
        // Это же защищает от «накопления» мешей при повторном `_attach`.
        for (const child of [...this._group.children]) {
            if (child.geometry && typeof child.geometry.dispose === 'function') {
                child.geometry.dispose();
            }
            if (child.material) {
                const mats = Array.isArray(child.material) ? child.material : [child.material];
                for (const m of mats) {
                    if (m && typeof m.dispose === 'function') m.dispose();
                }
            }
            this._group.remove(child);
        }

        this._line = null;
        this._material = null;
        this._geometry = null;
        this._cone = null;
        this._lastSegLen = 0;
        this._animTime = 0;
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

    /* ---------------- Интерфейс для TextManager ---------------- */

    /** @returns {string} */ getText() { return this._title; }

    /** @returns {Object} */
    getTextStyle() {
        return Object.assign({
            fontFamily: 'sans-serif',
            color: '#ffffff',
            fontSize: '12px',
            fontWeight: 'bold',
            textShadow: '1px 1px 2px rgba(0,0,0,0.9), -1px -1px 2px rgba(0,0,0,0.9)',
        }, this._titleStyle);
    }

    /** @returns {{min:number,max:number}} */
    getTextZoomBounds() { return { min: this._titleMinZoom, max: this._titleMaxZoom }; }

    /** @returns {'point'} */ getLabelType() { return 'point'; }

    /** @returns {boolean} */
    isVisible() {
        if (!this._layer || !this._layer.visible) return false;
        if (!this._map) return false;
        const zoom = this._map.continuousZoom;
        return zoom >= this._titleMinZoom && zoom <= this._titleMaxZoom;
    }

    /** @returns {{x:number,y:number}|null} */
    getScreenPosition() {
        if (!this._map || this._worldPoints.length < 2) return null;

        const pt = this._titlePlacement === 'end'
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

    /** @returns {'left'|'center'|'right'} */ getTitleAlign() { return this._titleAlign; }
    /** @returns {'top'|'middle'|'bottom'} */ getTitleVerticalAlign() { return this._titleVerticalAlign; }
    /** @returns {[number, number]} */ getTitleOffset() { return this._titleOffset; }
    /** @returns {boolean} */ getAllowOverflow() { return this._titleAllowOverflow; }
    /** @returns {number} */ getPriority() { return this._titlePriority; }
}