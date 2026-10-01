/**
 * VectorLineLayer.js — 3D-векторы из GeoJSON.
 * Поддержка ECEF (EPSG:10176 IGS20 и др.), ENU-сдвигов,
 * LineString / MultiLineString с произвольным числом узлов.
 * Поддержка раздельного вертикального преувеличения (verticalExag).
 * Поддержка текстовых подписей через TextManager.
 *
 * @module VectorLineLayer
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
   ECEF ↔ Geodetic  (эллипсоид GRS-80 / IGS20)
   ================================================================ */

const _A  = 6378137.0;
const _F  = 1 / 298.257222101;
const _B  = _A * (1 - _F);
const _E2 = 1 - (_B * _B) / (_A * _A);

function ecefToGeodetic(X, Y, Z) {
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

function enuToEcefDelta(e, n, u, lonRad, latRad) {
    const sLo = Math.sin(lonRad), cLo = Math.cos(lonRad);
    const sLa = Math.sin(latRad), cLa = Math.cos(latRad);
    return [
        -sLo * e - sLa * cLo * n + cLa * cLo * u,
         cLo * e - sLa * sLo * n + cLa * sLo * u,
                      cLa * n    + sLa * u
    ];
}

const ECEF_CODES = new Set([
    'EPSG:4978',  'EPSG:10176',
    'EPSG:7901',  'EPSG:7902',  'EPSG:7903',  'EPSG:7904',
    'EPSG:7905',  'EPSG:7906',  'EPSG:7907',  'EPSG:7908',
    'EPSG:7909',  'EPSG:7910',  'EPSG:7911',  'EPSG:7912',
    'EPSG:8403',  'EPSG:8404',
]);

function isEcefCrs(code) {
    return code ? ECEF_CODES.has(code.toUpperCase()) : false;
}

/* ================================================================
   Vector3D — один 3D-вектор / ломаная со стрелкой и подписью
   ================================================================ */

class Vector3D {
    constructor(opts) {
        this.pointsWorld = opts.pointsWorld;
        this.color       = opts.color || '#ff0000';
        this.width       = opts.width || 3;
        this.arrowSize   = opts.arrowSize || 10;
        this.opacity     = opts.opacity ?? 1;
        this.depthTest   = opts.depthTest ?? true;

        // Настройки подписи
        this.title         = opts.title || '';
        this.titleStyle    = opts.titleStyle || {};
        this.titleMinZoom  = opts.titleMinZoom ?? -Infinity;
        this.titleMaxZoom  = opts.titleMaxZoom ?? Infinity;
        this.titlePlacement= opts.titlePlacement || 'start'; // 'start' или 'end'
        this.titleOffset   = opts.titleOffset || [0, -10];
        this.titleAlign    = opts.titleAlign || 'center';

        this._map      = null;
        this._layer    = null;
        this._group    = new THREE.Group();
        this._line     = null;
        this._material = null;
        this._geometry = null;
        this._cone     = null;
        this._textLabel= null; // Ссылка на объект TextManager
    }

    _attach(map, layer) {
        if (this._map === map) return;
        this.remove();
        this._map   = map;
        this._layer = layer;

        const pts = this.pointsWorld;
        if (!pts || pts.length < 2) return;

        const pos = [];
        for (const [wx, wy, wz] of pts) pos.push(wx, wy, wz);

        this._geometry = new LineGeometry();
        this._geometry.setPositions(pos);

        const cv = map.renderer.domElement;
        this._material = new LineMaterial({
            color:       this.color,
            linewidth:   this.width,
            opacity:     this.opacity,
            transparent: this.opacity < 1,
            depthTest:   this.depthTest,
            depthWrite:  this.depthTest,
            resolution:  new THREE.Vector2(cv.width, cv.height),
        });

        this._line = new Line2(this._geometry, this._material);
        this._line.computeLineDistances();
        this._group.add(this._line);

        const last  = pts.length - 1;
        const pFrom = new THREE.Vector3(...pts[last - 1]);
        const pTo   = new THREE.Vector3(...pts[last]);
        const dir   = new THREE.Vector3().subVectors(pTo, pFrom);
        const len   = dir.length();

        if (len > 1e-6) {
            const cH = Math.min(this.arrowSize, len * 0.4);
            const cR = cH * 0.35;
            const cGeo = new THREE.ConeGeometry(cR, cH, 12);
            cGeo.translate(0, cH / 2, 0);

            this._cone = new THREE.Mesh(cGeo, new THREE.MeshBasicMaterial({
                color:       this.color,
                opacity:     this.opacity,
                transparent: this.opacity < 1,
                depthTest:   this.depthTest,
                depthWrite:  this.depthTest,
            }));
            this._cone.position.copy(pTo);
            this._cone.setRotationFromQuaternion(
                new THREE.Quaternion().setFromUnitVectors(
                    new THREE.Vector3(0, 1, 0), dir.normalize()
                )
            );
            this._group.add(this._cone);
        }

        map.worldGroup.add(this._group);

        // Регистрация подписи в TextManager
        if (this.title && map.textManager) {
            this._textLabel = map.textManager.addLabel(this);
        }
    }

    _update(map) {
        if (!this._material || !this._line) return;
        const cv  = map.renderer.domElement;
        const res = this._material.resolution;
        if (res.x !== cv.width || res.y !== cv.height) {
            res.set(cv.width, cv.height);
        }
        if (map.view.objectDistanceFactor > 0 && this.pointsWorld.length >= 2) {
            const mid = this.pointsWorld[this.pointsWorld.length >> 1];
            const d   = map.camera.position.distanceTo(
                new THREE.Vector3(mid[0], mid[1], mid[2])
            );
            this._group.visible = d <= map.maxObjectDistance;
        }
    }

    remove() {
        // Удаление подписи из TextManager
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
        this._layer?._removeRef(this);
        this._layer = null;
        this._map   = null;
    }

    getBounds(crs = 'EPSG:4326') {
        let mnx = Infinity, mnz = Infinity, mxx = -Infinity, mxz = -Infinity;
        for (const [wx, , wz] of this.pointsWorld) {
            if (wx < mnx) mnx = wx;  if (wx > mxx) mxx = wx;
            if (wz < mnz) mnz = wz;  if (wz > mxz) mxz = wz;
        }
        if (!isFinite(mnx)) return null;
        if (this._map) {
            const a = this._map.unproject([mnx, mnz], crs);
            const b = this._map.unproject([mxx, mxz], crs);
            return [[a[0], a[1]], [b[0], b[1]]];
        }
        return [[mnx, mnz], [mxx, mxz]];
    }

    /* ================================================================
       Интерфейс для TextManager
       ================================================================ */
    
    getText() { return this.title; }
    
    getTextStyle() {
        // Дефолтный стиль: белый текст с чёрной обводкой/тенью для читаемости на любом фоне
        return Object.assign({
            fontFamily: 'sans-serif',
            color: '#ffffff',
            fontSize: '12px',
            fontWeight: 'bold',
            textShadow: '1px 1px 2px rgba(0,0,0,0.9), -1px -1px 2px rgba(0,0,0,0.9)'
        }, this.titleStyle);
    }
    
    getTextZoomBounds() { 
        return { min: this.titleMinZoom, max: this.titleMaxZoom }; 
    }
    
    getLabelType() { return 'point'; }
    
    isVisible() {
        if (!this._layer || !this._layer.visible) return false;
        const zoom = this._map.continuousZoom;
        return zoom >= this.titleMinZoom && zoom <= this.titleMaxZoom;
    }
    
    getScreenPosition() {
        if (!this._map || !this.pointsWorld || this.pointsWorld.length < 2) return null;
        
        // Выбираем точку: 'start' (начало вектора, база) или 'end' (кончик стрелки)
        const pt = this.titlePlacement === 'end' 
            ? this.pointsWorld[this.pointsWorld.length - 1] 
            : this.pointsWorld[0];
            
        const vec = new THREE.Vector3(pt[0], pt[1], pt[2]);
        vec.project(this._map.camera);
        
        // Если точка за камерой
        if (vec.z > 1) return null;
        
        const canvas = this._map.renderer.domElement;
        return {
            x: (vec.x * 0.5 + 0.5) * canvas.clientWidth,
            y: (-vec.y * 0.5 + 0.5) * canvas.clientHeight
        };
    }
    
    getTitleAlign() { return this.titleAlign; }
    getTitleVerticalAlign() { return 'bottom'; } // По умолчанию подпись над точкой
    getTitleOffset() { return this.titleOffset; }
    getAllowOverflow() { return false; }
    getPriority() { return 10; } // Приоритет выше обычного, чтобы названия станций не прятались
}

/* ================================================================
   VectorLineLayer
   ================================================================ */

export class VectorLineLayer extends Layer {
    constructor(opts = {}) {
        super();
        this.url          = opts.url || null;
        this.data         = opts.data || null;
        this.crsCode      = opts.crs || null;
        this.ecef         = opts.ecef ?? isEcefCrs(this.crsCode);
        this.defaultExag  = opts.defaultExag ?? 1;
        this.heightScale  = opts.heightScale ?? 1;
        this.styleFn      = opts.style || null;
        this.filter       = opts.filter || null;

        this.exagOption       = opts.exag !== undefined ? opts.exag : null;
        this.verticalExagOption = opts.verticalExag !== undefined ? opts.verticalExag : null; 
        
        this._loaded      = false;
    }

    addTo(map) {
        super.addTo(map);
        if (!this._loaded) this._load();
        return this;
    }

    reload() {
        for (const o of [...this._objects]) o.remove();
        this._objects = [];
        this._loaded  = false;
        if (this._map) this._load();
    }

    async _load() {
        let gj = this.data;
        if (!gj && this.url) {
            try {
                const r = await fetch(this.url);
                gj = await r.json();
            } catch (e) {
                console.error('VectorLineLayer: fetch error', e);
                return;
            }
        }
        if (!gj) return;
        this._parse(gj);
        this._loaded = true;
    }

    _parse(gj) {
        const feats = gj.type === 'FeatureCollection' ? gj.features
                    : gj.type === 'Feature' ? [gj] : [];
        for (const f of feats) this._addFeature(f);
    }

    _addFeature(feature) {
        const props = feature.properties || {};
        const geom  = feature.geometry;
        if (!geom) return;

        if (this.filter && !this.filter(feature, props)) return;

        let pts = null;

        if (geom.type === 'Point') {
            pts = this._fromPoint(props, geom);
        } else if (geom.type === 'LineString') {
            pts = this._fromCoords(geom.coordinates, props);
        } else if (geom.type === 'MultiLineString') {
            for (const c of geom.coordinates) {
                const p = this._fromCoords(c, props);
                if (p) this._spawn(p, feature, props);
            }
            return;
        } else {
            return;
        }

        if (pts) this._spawn(pts, feature, props);
    }

    _spawn(pointsWorld, feature, props) {
        const s = this.styleFn ? this.styleFn(feature, props) : {};
        
        // Если title не задан явно в style, берём ID из свойств (или пустую строку)
        const title = s.title !== undefined ? s.title : (props.ID || '');

        this.add(new Vector3D({
            pointsWorld,
            color:     s.color     || this._colorByMag(props),
            width:     s.width     ?? 3,
            arrowSize: s.arrowSize ?? 15,
            opacity:   s.opacity   ?? 1,
            // Передаём параметры подписи
            title: title,
            titleStyle: s.titleStyle || {},
            titleMinZoom: s.titleMinZoom ?? 8, // Показывать названия только при приближении (зум >= 8)
            titleMaxZoom: s.titleMaxZoom ?? Infinity,
            titlePlacement: s.titlePlacement || 'start',
            titleOffset: s.titleOffset || [0, -12],
            titleAlign: s.titleAlign || 'center'
        }));
    }

    /* ---------- Утилита для расчёта масштаба ---------- */
    _resolveExag(props, option, defaultExag) {
        if (typeof option === 'function') return option(props);
        if (option !== null && option !== undefined) return option;
        return props.EXAG ?? defaultExag;
    }

    /* ---------- Point + ENU ---------- */
    _fromPoint(props, geom) {
        const x0 = props.X0 ?? geom.coordinates[0];
        const y0 = props.Y0 ?? geom.coordinates[1];
        const z0 = props.Z0 ?? (geom.coordinates[2] || 0);

        const exag = this._resolveExag(props, this.exagOption, this.defaultExag);
        const vExag = this._resolveExag(props, this.verticalExagOption, exag);

        if (this.ecef) {
            const [lon0, lat0, h0] = ecefToGeodetic(x0, y0, z0);
            const loR = lon0 * Math.PI / 180;
            const laR = lat0 * Math.PI / 180;

            const e = (props.E ?? props.dX ?? 0) * exag;
            const n = (props.N ?? props.dY ?? 0) * exag;
            const u = (props.U ?? props.dZ ?? 0) * vExag;
            
            const [dX, dY, dZ] = enuToEcefDelta(e, n, u, loR, laR);
            const [lon1, lat1, h1] = ecefToGeodetic(x0 + dX, y0 + dY, z0 + dZ);

            return this._llhToWorld(lon0, lat0, h0, lon1, lat1, h1);
        }

        const crs = this.crsCode || this._map.inputCRS;
        const e = (props.E ?? props.dX ?? 0) * exag;
        const n = (props.N ?? props.dY ?? 0) * exag;
        const u = (props.U ?? props.dZ ?? 0) * vExag;
        
        const s = this._map.project([x0, y0], crs);
        const t = this._map.project([x0 + e, y0 + n], crs);
        
        return [
            [s[0], z0 * this.heightScale,      s[1]],
            [t[0], (z0 + u) * this.heightScale, t[1]],
        ];
    }

    /* ---------- LineString ---------- */
    _fromCoords(coords, props = {}) {
        if (!coords || coords.length < 2) return null;

        const exag = this._resolveExag(props, this.exagOption, this.defaultExag);
        const vExag = this._resolveExag(props, this.verticalExagOption, exag);

        if (this.ecef) {
            return coords.map((c, idx) => {
                const [lon, lat, h] = ecefToGeodetic(c[0], c[1], c[2] || 0);
                const w = this._map.project([lon, lat], 'EPSG:4326');
                
                const baseH = coords[0][2] || 0;
                const deltaH = (c[2] || 0) - baseH;
                const exaggeratedH = baseH + (deltaH * vExag);
                
                return [w[0], exaggeratedH * this.heightScale, w[1]];
            });
        }

        const crs = this.crsCode || this._map.inputCRS;
        return coords.map((c, idx) => {
            const w = this._map.project([c[0], c[1]], crs);
            
            const baseZ = coords[0][2] || 0;
            const deltaZ = (c[2] || 0) - baseZ;
            const exaggeratedZ = baseZ + (deltaZ * vExag);
            
            return [w[0], exaggeratedZ * this.heightScale, w[1]];
        });
    }

    _llhToWorld(lon0, lat0, h0, lon1, lat1, h1) {
        const s = this._map.project([lon0, lat0], 'EPSG:4326');
        const e = this._map.project([lon1, lat1], 'EPSG:4326');
        return [
            [s[0], h0 * this.heightScale, s[1]],
            [e[0], h1 * this.heightScale, e[1]],
        ];
    }

    _colorByMag(p) {
        const m = p.total_mag || p.horiz_mag || 0;
        if (m > 0.02) return '#ff0000';
        if (m > 0.01) return '#ffaa00';
        return '#00ff00';
    }
}