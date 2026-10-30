// VectorTileMaterials.ts
import { THREE, LineMaterial } from './js_TP/tpb.js';
/**
 * Примесь VectorTile — материалы.
 * Применяется через applyMixin(VectorTile.prototype, VectorTileMaterialsMixin).
 */
export const VectorTileMaterialsMixin = {
    _getFillMaterial(styleKey) {
        const cached = this._fillMaterialCache.get(styleKey);
        if (cached)
            return cached;
        const parts = styleKey.split(':');
        const color = parseInt(parts[2], 16);
        const rawOpacity = parseFloat(parts[3]);
        const opacity = (Number.isNaN(rawOpacity) ? 1 : rawOpacity) * this.fillOpacity;
        const mat = new THREE.MeshBasicMaterial({
            color,
            side: THREE.DoubleSide,
            transparent: opacity < 1.0,
            opacity,
            depthTest: this.depthTest === true,
            depthWrite: false,
        });
        this._fillMaterialCache.set(styleKey, mat);
        this._managedMaterials.add(mat);
        return mat;
    },
    _getFillMaterialFromData(layerName, color, opacity) {
        const op = opacity ?? 1;
        const key = `fill:${layerName}:${color.toString(16)}:${op}`;
        return this._getFillMaterial(key);
    },
    _getLineMaterial(styleKey, dash) {
        const cached = this._lineMaterialCache.get(styleKey);
        if (cached)
            return cached;
        const parts = styleKey.split(':');
        const color = parseInt(parts[2], 16);
        const width = parseFloat(parts[3]) * this.lineWidthMultiplier;
        const matOpts = {
            color,
            linewidth: width,
            resolution: new THREE.Vector2(this._map.renderer.domElement.clientWidth, this._map.renderer.domElement.clientHeight),
            depthTest: this.depthTest === true,
            depthWrite: false,
        };
        if (dash && Array.isArray(dash) && dash.length >= 2) {
            matOpts.dashed = true;
            matOpts.dashSize = dash[0];
            matOpts.gapSize = dash[1];
            matOpts.dashScale = 1;
        }
        const mat = new LineMaterial(matOpts);
        this._lineMaterialCache.set(styleKey, mat);
        this._lineMaterialsSet.add(mat);
        this._managedMaterials.add(mat);
        return mat;
    },
    _getLineMaterialFromData(layerName, color, width, dash) {
        const dashKey = dash ? dash.join(',') : 'none';
        const key = `line:${layerName}:${color.toString(16)}:${width}:${dashKey}`;
        return this._getLineMaterial(key, dash);
    },
    _getDynamicLineMaterial(line) {
        if (!this._map)
            return null;
        const wKey = typeof line.width === 'number'
            ? String(line.width)
            : JSON.stringify((line.width && line.width.stops) || line.width);
        const add = line.widthAdd || 0;
        const dashKey = line.dash ? line.dash.join(',') : 'none';
        const key = `dline:${line.layerName}:${line.color.toString(16)}:${wKey}+${add}:${dashKey}`;
        let mat = this._lineMaterialCache.get(key);
        if (mat)
            return mat;
        const canvas = this._map.renderer.domElement;
        const opts = {
            color: line.color,
            linewidth: 1,
            resolution: new THREE.Vector2(canvas.clientWidth, canvas.clientHeight),
            depthTest: this.depthTest === true,
            depthWrite: false,
        };
        if (line.dash && Array.isArray(line.dash) && line.dash.length >= 2) {
            opts.dashed = true;
            opts.dashSize = line.dash[0];
            opts.gapSize = line.dash[1];
            opts.dashScale = 1;
        }
        mat = new LineMaterial(opts);
        mat.userData.dyn = {
            width: line.width,
            add: line.widthAdd || 0,
            hideBelow: line.hideBelow ?? null,
            dashZ: line.dashZ ?? null,
        };
        this._lineMaterialCache.set(key, mat);
        this._lineMaterialsSet.add(mat);
        this._managedMaterials.add(mat);
        this._lastStyleZoom = NaN;
        return mat;
    },
    _evalCurve(c, z) {
        if (typeof c === 'number')
            return c;
        if (!c || !c.stops || c.stops.length === 0)
            return 0;
        const stops = c.stops;
        if (z <= stops[0][0])
            return stops[0][1];
        for (let i = 1; i < stops.length; i++) {
            if (z <= stops[i][0]) {
                const t = (z - stops[i - 1][0]) / (stops[i][0] - stops[i - 1][0]);
                return stops[i - 1][1] + (stops[i][1] - stops[i - 1][1]) * t;
            }
        }
        return stops[stops.length - 1][1];
    },
    _updateDynamicLineMaterials(zoom) {
        if (Math.abs(zoom - this._lastStyleZoom) < 0.005)
            return;
        this._lastStyleZoom = zoom;
        for (const mat of this._lineMaterialsSet) {
            const d = mat.userData.dyn;
            if (!d)
                continue;
            const base = this._evalCurve(d.width, zoom);
            mat.linewidth = (base + (d.add || 0)) * this.lineWidthMultiplier;
            mat.visible = mat.linewidth > 0 && !(d.hideBelow != null && base <= d.hideBelow);
            if (mat.dashed && d.dashZ != null)
                mat.dashScale = Math.pow(2, zoom - d.dashZ);
        }
    },
    _getPointGeometry(radius) {
        const key = `point_${radius}`;
        const cached = this._pointGeometryCache.get(key);
        if (cached)
            return cached;
        const geom = new THREE.CircleGeometry(radius, 8);
        geom.rotateX(-Math.PI / 2);
        this._pointGeometryCache.set(key, geom);
        this._managedGeometries.add(geom);
        return geom;
    },
    _concatF32(arrays) {
        let total = 0;
        for (const a of arrays)
            total += a.length;
        const out = new Float32Array(total);
        let offset = 0;
        for (const a of arrays) {
            out.set(a, offset);
            offset += a.length;
        }
        return out;
    },
    _getBuildingMaterial(color, opacity = 1) {
        const transparent = opacity < 1;
        const key = `bld:${color}:${opacity}`;
        const cached = this._fillMaterialCache.get(key);
        if (cached)
            return cached;
        const mat = new THREE.MeshLambertMaterial({
            color,
            side: THREE.FrontSide,
            transparent,
            opacity,
            depthTest: true,
            depthWrite: !transparent,
            polygonOffset: true,
            polygonOffsetFactor: 1,
            polygonOffsetUnits: 1,
        });
        this._fillMaterialCache.set(key, mat);
        this._managedMaterials.add(mat);
        return mat;
    },
    _getBuildingEdgeMaterial(color, opacity = 1) {
        const transparent = opacity < 1;
        const key = `bldEdge:${color}:${opacity}`;
        const cached = this._lineMaterialCache.get(key);
        if (cached)
            return cached;
        const mat = new THREE.LineBasicMaterial({
            color,
            transparent,
            opacity,
            depthTest: true,
            depthWrite: false,
        });
        this._lineMaterialCache.set(key, mat);
        this._managedMaterials.add(mat);
        return mat;
    },
};
