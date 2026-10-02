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

export class Vector3D {
    /**
     * @param {Object} options
     * @param {Array<[number, number, number]>} options.positions
     *     Узлы вектора `[x, y, z]` в СК `crs`. Минимум 2 точки.
     * @param {string} [options.crs] - Код СК; по умолчанию `map.inputCRS`.
     *     Если задан ECEF-код — точки трактуются как ECEF.
     * @param {string} [options.color='#3388ff']
     * @param {number} [options.width=2] - Толщина линии, px.
     * @param {number} [options.arrowSize=10] - Длина стрелки, world-м.
     * @param {number} [options.opacity=1]
     * @param {boolean} [options.depthTest=true]
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
        /** @private */ this._opacity   = options.opacity ?? 1;
        /** @private */ this._depthTest = options.depthTest ?? true;
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

        /** @private */ this._textLabel = null;
        /** @private */ this._unregisterInteraction = null;

        /** @private @type {Array<[number,number,number]>} */
        this._worldPoints = [];
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
            const cH = Math.min(this._arrowSize, len * 0.4);
            const cR = cH * 0.35;
            const cGeo = new THREE.ConeGeometry(cR, cH, 12);
            cGeo.translate(0, cH / 2, 0);

            this._cone = new THREE.Mesh(cGeo, new THREE.MeshBasicMaterial({
                color: this._color,
                opacity: this._opacity,
                transparent: this._opacity < 1,
                depthTest: this._depthTest,
                depthWrite: this._depthTest,
            }));
            this._cone.renderOrder = 999;
            this._cone.position.copy(pTo);
            this._cone.setRotationFromQuaternion(
                new THREE.Quaternion().setFromUnitVectors(
                    new THREE.Vector3(0, 1, 0), dir.normalize()
                )
            );
            this._group.add(this._cone);
        }

        map.worldGroup.add(this._group);

        // --- InteractionManager --------------------------------------------
        if (map.interaction && (this._onClick || this._onHover || this._tooltip)) {
            this._unregisterInteraction = map.interaction.register(this, {
                getMeshes: () => {
                    const meshes = [];
                    if (this._line) meshes.push(this._line);
                    if (this._cone) meshes.push(this._cone);
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
     * @param {import('./KrbMap.js').KrbMap} map
     * @private
     */
    _update(map) {
        if (!this._map || !this._line) return;

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

        if (this._group.parent) this._group.parent.remove(this._group);

        this._geometry?.dispose();
        this._material?.dispose();
        if (this._cone) {
            this._cone.geometry.dispose();
            this._cone.material.dispose();
        }

        this._line = null;
        this._material = null;
        this._geometry = null;
        this._cone = null;

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