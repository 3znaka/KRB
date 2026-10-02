/**
 * VectorLineLayer.js — 3D-векторы (направленные отрезки и ломаные) из GeoJSON.
 *
 * Каждая фича превращается в один {@link Vector3D}: ломаную по узловым точкам
 * с конической стрелкой на конце и опциональной подписью через TextManager.
 *
 * Слой не знает ничего о предметной области — ECEF, ENU, магнитных полях
 * и т.п. Всё, что касается интерпретации свойств фичи, выносится в
 * пользовательские коллбэки:
 *
 *  - `pointsFn(feature, props) → Array<[x,y,z]>` — узлы вектора в СК `crs`;
 *  - `style(feature, props) → Object` — цвет, толщина, стрелка, подпись;
 *  - `filter(feature, props) → boolean` — предварительный отбор.
 *
 * Для удобства экспортируются утилиты ECEF ↔ Geodetic и ENU → ECEF,
 * которые можно вызывать внутри `pointsFn`.
 *
 * @module VectorLineLayer
 */

import { Layer } from './Layers.js';
import {
    THREE,
    Line2,
    LineMaterial,
    LineGeometry,
} from '../js_TP/tpb.js';


/* ================================================================
   ECEF ↔ Geodetic  (эллипсоид GRS-80 / IGS20) — экспортируемые утилиты
   ================================================================ */

const _A  = 6378137.0;
const _F  = 1 / 298.257222101;
const _B  = _A * (1 - _F);
const _E2 = 1 - (_B * _B) / (_A * _A);

/**
 * Преобразование геоцентрических координат ECEF (X, Y, Z, метры)
 * в геодезические (lon°, lat°, h м) на эллипсоиде GRS-80.
 *
 * @param {number} X - ECEF X, метры.
 * @param {number} Y - ECEF Y, метры.
 * @param {number} Z - ECEF Z, метры.
 * @returns {[number, number, number]} [lon, lat, h].
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
 * Преобразование локального смещения ENU (East, North, Up) в приращение
 * ECEF в окрестности точки (lonRad, latRad).
 *
 * @param {number} e - East, метры.
 * @param {number} n - North, метры.
 * @param {number} u - Up, метры.
 * @param {number} lonRad - Долгота базовой точки, радианы.
 * @param {number} latRad - Широта базовой точки, радианы.
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
 * Проверяет, является ли код СК геоцентрической (ECEF).
 *
 * @param {string|null|undefined} code
 * @returns {boolean}
 */
export function isEcefCrs(code) {
    return code ? ECEF_CODES.has(code.toUpperCase()) : false;
}


/* ================================================================
   Дефолтный стиль Vector3D — мержится с результатом пользовательского styleFn
   ================================================================ */

/** @private */
const DEFAULT_STYLE = {
    color: '#3388ff',
    width: 2,
    arrowSize: 10,
    opacity: 1,
    depthTest: true,
    minZoom: -Infinity,
    maxZoom: Infinity,

    title: '',
    titleStyle: {},
    titleMinZoom: -Infinity,
    titleMaxZoom: Infinity,
    titlePlacement: 'start',
    titleOffset: [0, -10],
    titleAlign: 'center',
    titleVerticalAlign: 'bottom',
    titleAllowOverflow: false,
    titlePriority: 0,

    tooltip: '',
    onClick: null,
    onHover: null,
};


/* ================================================================
   Vector3D — один 3D-вектор со стрелкой и подписью
   ================================================================ */

/**
 * Направленный отрезок (или ломаная) в world-метрах карты.
 *
 * Позиции узлов задаются уже в world-координатах: `[x, y, z]`, где `x`/`z` —
 * горизонтальные метры проекции карты, `y` — абсолютная высота.
 * Проецирование исходных данных — задача слоя.
 *
 * Регистрируется в `InteractionManager` (если есть `onClick` / `onHover` /
 * `tooltip`) и в `TextManager` (если задан `title`).
 */
class Vector3D {
    /**
     * @param {Object} opts
     * @param {Array<[number, number, number]>} opts.points
     *     Узлы вектора в world-метрах: `[x, y, z]`. Минимум 2 точки.
     * @param {string} [opts.color='#3388ff'] - Цвет (CSS / THREE.Color).
     * @param {number} [opts.width=2] - Толщина линии в пикселях (Line2).
     * @param {number} [opts.arrowSize=10] - Длина стрелки в world-метрах.
     * @param {number} [opts.opacity=1] - Прозрачность (0..1).
     * @param {boolean} [opts.depthTest=true] - Включить тест глубины.
     * @param {number} [opts.minZoom=-Infinity] - Минимальный зум видимости.
     * @param {number} [opts.maxZoom=Infinity] - Максимальный зум видимости.
     *
     * @param {string} [opts.title=''] - Текст постоянной подписи.
     * @param {Object} [opts.titleStyle={}] - CSS-стили подписи.
     * @param {number} [opts.titleMinZoom=-Infinity] - Мин. зум подписи.
     * @param {number} [opts.titleMaxZoom=Infinity] - Макс. зум подписи.
     * @param {'start'|'end'} [opts.titlePlacement='start'] - Куда привязать подпись.
     * @param {[number, number]} [opts.titleOffset=[0,-10]] - Смещение подписи, px.
     * @param {'left'|'center'|'right'} [opts.titleAlign='center'] - Гор. выравнивание.
     * @param {'top'|'middle'|'bottom'} [opts.titleVerticalAlign='bottom'] - Верт. выравнивание.
     * @param {boolean} [opts.titleAllowOverflow=false] - Разрешить выход за границы.
     * @param {number} [opts.titlePriority=0] - Приоритет подписи.
     *
     * @param {string} [opts.tooltip=''] - HTML-тултип (через InteractionManager).
     * @param {Function|null} [opts.onClick=null] - Обработчик клика.
     * @param {Function|null} [opts.onHover=null] - Обработчик hover.
     */
    constructor(opts) {
        this._points = opts.points;

        this._color     = opts.color ?? DEFAULT_STYLE.color;
        this._width     = opts.width ?? DEFAULT_STYLE.width;
        this._arrowSize = opts.arrowSize ?? DEFAULT_STYLE.arrowSize;
        this._opacity   = opts.opacity ?? DEFAULT_STYLE.opacity;
        this._depthTest = opts.depthTest ?? DEFAULT_STYLE.depthTest;
        this._minZoom   = opts.minZoom ?? DEFAULT_STYLE.minZoom;
        this._maxZoom   = opts.maxZoom ?? DEFAULT_STYLE.maxZoom;

        this._title                = opts.title ?? DEFAULT_STYLE.title;
        this._titleStyle           = opts.titleStyle ?? DEFAULT_STYLE.titleStyle;
        this._titleMinZoom         = opts.titleMinZoom ?? DEFAULT_STYLE.titleMinZoom;
        this._titleMaxZoom         = opts.titleMaxZoom ?? DEFAULT_STYLE.titleMaxZoom;
        this._titlePlacement       = opts.titlePlacement ?? DEFAULT_STYLE.titlePlacement;
        this._titleOffset          = opts.titleOffset ?? DEFAULT_STYLE.titleOffset;
        this._titleAlign           = opts.titleAlign ?? DEFAULT_STYLE.titleAlign;
        this._titleVerticalAlign   = opts.titleVerticalAlign ?? DEFAULT_STYLE.titleVerticalAlign;
        this._titleAllowOverflow   = opts.titleAllowOverflow ?? DEFAULT_STYLE.titleAllowOverflow;
        this._titlePriority        = opts.titlePriority ?? DEFAULT_STYLE.titlePriority;

        this._tooltip = opts.tooltip ?? DEFAULT_STYLE.tooltip;
        this._onClick = opts.onClick ?? DEFAULT_STYLE.onClick;
        this._onHover = opts.onHover ?? DEFAULT_STYLE.onHover;

        this._map   = null;
        this._layer = null;
        this._group = new THREE.Group();

        this._line     = null;
        this._material = null;
        this._geometry = null;
        this._cone     = null;

        this._textLabel = null;
        this._unregisterInteraction = null;
    }

    /**
     * Внутренний метод, вызываемый слоем при добавлении. Создаёт геометрию,
     * материалы, стрелку, регистрирует объект в InteractionManager и
     * TextManager.
     *
     * @param {import('./KrbMap.js').KrbMap} map
     * @param {Layer} layer
     * @private
     */
    _attach(map, layer) {
        if (this._map === map && this._layer === layer) return;
        this.remove();
        this._map = map;
        this._layer = layer;

        const pts = this._points;
        if (!pts || pts.length < 2) return;

        // --- Line2 --------------------------------------------------------
        const flat = [];
        for (let i = 0; i < pts.length; i++) {
            flat.push(pts[i][0], pts[i][1], pts[i][2]);
        }

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
        const last  = pts.length - 1;
        const pFrom = new THREE.Vector3(pts[last - 1][0], pts[last - 1][1], pts[last - 1][2]);
        const pTo   = new THREE.Vector3(pts[last][0],     pts[last][1],     pts[last][2]);
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

        // --- InteractionManager -------------------------------------------
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

        // --- TextManager --------------------------------------------------
        if (this._title && map.textManager) {
            this._textLabel = map.textManager.addLabel(this);
        }
    }

    /**
     * Ежекадровое обновление: видимость по зуму и дальности,
     * актуализация resolution LineMaterial.
     *
     * @param {import('./KrbMap.js').KrbMap} map
     * @private
     */
    _update(map) {
        if (!this._map || !this._line) return;

        const zoom = map.continuousZoom;
        let visible = (this._layer ? this._layer.visible : true)
            && zoom >= this._minZoom && zoom <= this._maxZoom;

        if (visible && map.objectRenderDistanceFactor > 0 && this._points.length >= 2) {
            const mid = this._points[this._points.length >> 1];
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

    /**
     * Удаляет вектор с карты, освобождает ресурсы и снимает регистрации.
     */
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
     * Возвращает объединённый прямоугольник по узлам вектора.
     *
     * @param {string|import('./Projections.js').Projection} [crs='EPSG:4326']
     * @returns {Array<Array<number>>|null}
     */
    getBounds(crs = 'EPSG:4326') {
        let mnx = Infinity, mnz = Infinity, mxx = -Infinity, mxz = -Infinity;
        for (const p of this._points) {
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
        // Без карты перевести world → CRS невозможно; вернём world-метры.
        return [[mnx, mnz], [mxx, mxz]];
    }

    /* ================================================================
       Интерфейс для TextManager
       ================================================================ */

    /** @returns {string} */
    getText() { return this._title; }

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

    /** @returns {{min: number, max: number}} */
    getTextZoomBounds() {
        return { min: this._titleMinZoom, max: this._titleMaxZoom };
    }

    /** @returns {'point'} */
    getLabelType() { return 'point'; }

    /** @returns {boolean} */
    isVisible() {
        if (!this._layer || !this._layer.visible) return false;
        if (!this._map) return false;
        const zoom = this._map.continuousZoom;
        return zoom >= this._titleMinZoom && zoom <= this._titleMaxZoom;
    }

    /**
     * Экранные координаты точки привязки подписи.
     * `'end'` — кончик стрелки, иначе — начало вектора.
     *
     * @returns {{x: number, y: number}|null}
     */
    getScreenPosition() {
        if (!this._map || !this._points || this._points.length < 2) return null;

        const pt = this._titlePlacement === 'end'
            ? this._points[this._points.length - 1]
            : this._points[0];

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

    /** @returns {'left'|'center'|'right'} */
    getTitleAlign() { return this._titleAlign; }

    /** @returns {'top'|'middle'|'bottom'} */
    getTitleVerticalAlign() { return this._titleVerticalAlign; }

    /** @returns {[number, number]} */
    getTitleOffset() { return this._titleOffset; }

    /** @returns {boolean} */
    getAllowOverflow() { return this._titleAllowOverflow; }

    /** @returns {number} */
    getPriority() { return this._titlePriority; }
}


/* ================================================================
   VectorLineLayer
   ================================================================ */

/**
 * Слой 3D-векторов из GeoJSON.
 *
 * Каждая фича преобразуется в узлы `[x, y, z]` (коллбэк `pointsFn`), узлы
 * проецируются в world-метры карты и попадают в {@link Vector3D} вместе со
 * стилем из `styleFn`.
 *
 * ECEF-координаты (EPSG:4978, 10176, 7901..7912, 8403, 8404) распознаются
 * автоматически: каждая точка проходит через `ecefToGeodetic` и далее
 * проецируется из WGS84. Слой всё равно ожидает, что `pointsFn` возвращает
 * точки **в СК `crs`**, то есть если у вас ECEF — возвращайте ECEF.
 *
 * @example
 * const layer = new VectorLineLayer({
 *     data: featureCollection,
 *     crs: 'EPSG:4978',
 *     pointsFn: (f, p) => {
 *         const [lon0, lat0, h0] = ecefToGeodetic(p.X0, p.Y0, p.Z0);
 *         const [dX, dY, dZ] = enuToEcefDelta(p.E, p.N, p.U,
 *                                             lon0 * Math.PI / 180,
 *                                             lat0 * Math.PI / 180);
 *         const [lon1, lat1, h1] = ecefToGeodetic(p.X0 + dX, p.Y0 + dY, p.Z0 + dZ);
 *         return [[lon0, lat0, h0], [lon1, lat1, h1]];
 *     },
 *     style: (f, p) => ({ color: p.color, width: 4, title: p.ID })
 * });
 * layer.addTo(map);
 */
export class VectorLineLayer extends Layer {
    /**
     * @param {Object} [opts]
     * @param {string} [opts.url] - URL GeoJSON-файла.
     * @param {Object} [opts.data] - Готовый GeoJSON (приоритетнее `url`).
     * @param {string} [opts.crs] - Код СК координат `pointsFn`.
     *     По умолчанию используется `map.inputCRS`.
     * @param {Function} [opts.filter] - `(feature, props) → boolean`.
     * @param {Function} [opts.pointsFn] - `(feature, props) → Array<[x,y,z]>`.
     *     Возвращает узлы вектора в СК `crs`. Для MultiLineString можно
     *     вернуть массив массивов (`Array<Array<[x,y,z]>>`) — тогда будет
     *     создан отдельный {@link Vector3D} на каждую линию.
     *     По умолчанию: координаты `LineString` / `MultiLineString` из геометрии.
     * @param {Function} [opts.style] - `(feature, props) → Object` — стиль
     *     {@link Vector3D}. Любое незаданное поле берётся из `DEFAULT_STYLE`.
     * @param {number} [opts.heightScale=1] - Глобальный множитель вертикали,
     *     применяется к `z` после `pointsFn`.
     * @param {number} [opts.altitudeOffset=0] - Аддитивный сдвиг по Y, метры.
     */
    constructor(opts = {}) {
        super();

        this.url       = opts.url || null;
        this.data      = opts.data || null;
        this._crsCode  = opts.crs || null;
        this._isEcef   = isEcefCrs(this._crsCode);

        this.filter    = opts.filter || null;
        this.pointsFn  = opts.pointsFn || null;
        this.styleFn   = opts.style || null;

        this.heightScale    = opts.heightScale ?? 1;
        this.altitudeOffset = opts.altitudeOffset ?? 0;

        this._loaded = false;
    }

    /**
     * Добавляет слой на карту и запускает загрузку данных.
     * @param {import('./KrbMap.js').KrbMap} map
     * @returns {VectorLineLayer} this
     */
    addTo(map) {
        super.addTo(map);
        if (!this._loaded) this._load();
        return this;
    }

    /** Полная перезагрузка: удаляет объекты и повторно парсит данные. */
    reload() {
        for (const o of [...this._objects]) o.remove();
        this._objects = [];
        this._loaded = false;
        if (this._map) this._load();
    }

    /**
     * Загрузка GeoJSON (из `data` или `url`) и запуск парсинга.
     * @private
     */
    async _load() {
        let geojson = this.data;
        if (!geojson && this.url) {
            try {
                const r = await fetch(this.url);
                if (!r.ok) throw new Error(`HTTP ${r.status}`);
                geojson = await r.json();
            } catch (e) {
                console.error('VectorLineLayer: fetch error', e);
                return;
            }
        }
        if (!geojson) return;
        this._parse(geojson);
        this._loaded = true;
    }

    /**
     * Разбор GeoJSON: FeatureCollection / Feature / одиночная геометрия.
     * @param {Object} geojson
     * @private
     */
    _parse(geojson) {
        const t = geojson.type;
        if (t === 'FeatureCollection') {
            for (const f of geojson.features) this._addFeature(f);
        } else if (t === 'Feature') {
            this._addFeature(geojson);
        } else if (t === 'LineString' || t === 'MultiLineString' || t === 'Point') {
            this._addFeature({ type: 'Feature', geometry: geojson, properties: {} });
        }
    }

    /**
     * @param {Object} feature
     * @private
     */
    _addFeature(feature) {
        const props = feature.properties || {};
        if (this.filter && !this.filter(feature, props)) return;

        const raw = this.pointsFn
            ? this.pointsFn(feature, props)
            : this._defaultPoints(feature, props);

        if (!raw) return;

        // Нормализация: [[x,y,z],...] — один вектор; [[...],[...]] — несколько.
        const vectors = this._isSingleVector(raw) ? [raw] : raw;

        for (const pts of vectors) {
            if (!Array.isArray(pts) || pts.length < 2) continue;
            this._spawn(pts, feature, props);
        }
    }

    /**
     * Дефолтный извлекатель точек — читает координаты геометрии.
     * @private
     */
    _defaultPoints(feature, props) {
        const geom = feature.geometry;
        if (!geom) return null;
        if (geom.type === 'LineString')       return geom.coordinates;
        if (geom.type === 'MultiLineString')  return geom.coordinates;
        return null;
    }

    /**
     * Определяет, является ли аргумент одним вектором (`[[x,y,z],…]`) или
     * массивом векторов (`[[[…]],[[…]]]`).
     * @private
     */
    _isSingleVector(arr) {
        if (!Array.isArray(arr) || arr.length === 0) return false;
        return Array.isArray(arr[0]) && typeof arr[0][0] === 'number';
    }

    /**
     * Проецирует одну точку из исходной СК в world-метры.
     * Для ECEF-кодов сначала конвертирует в геодезические.
     * @private
     * @returns {[number, number]|null}
     */
    _projectPoint(p) {
        const x = p[0], y = p[1], z = p[2] ?? 0;

        if (this._isEcef) {
            const [lon, lat] = ecefToGeodetic(x, y, z);
            return this._map.projectSafe([lon, lat], 'EPSG:4326');
        }

        const crs = this._crsCode || this._map.inputCRS;
        return this._map.projectSafe([x, y], crs);
    }

    /**
     * Создаёт {@link Vector3D} из узловых точек.
     * @private
     */
    _spawn(pointsSource, feature, props) {
        const style = Object.assign(
            {},
            DEFAULT_STYLE,
            this.styleFn ? this.styleFn(feature, props) : null
        );

        const pointsWorld = [];
        for (let i = 0; i < pointsSource.length; i++) {
            const p = pointsSource[i];
            if (!Array.isArray(p) || p.length < 2) continue;
            const xy = this._projectPoint(p);
            if (!xy) continue;
            const y = (p[2] ?? 0) * this.heightScale + this.altitudeOffset;
            pointsWorld.push([xy[0], y, xy[1]]);
        }
        if (pointsWorld.length < 2) return;

        this.add(new Vector3D(Object.assign({ points: pointsWorld }, style)));
    }
}