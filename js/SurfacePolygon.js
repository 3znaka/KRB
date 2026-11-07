// @ts-nocheck
/**
 * SurfacePolygon — полигон, "натянутый" на рельеф.
 * @module SurfacePolygon
 */
import { THREE } from './js_TP/tpb.js';
import { Projections } from './Projections.js';
import { getVirtKey, getOriginZ } from './TileKey.js';
import { SpatialObject } from './SpatialObject.js';
const DEFAULT_OVERLAY_TEX_SIZE = 512;
// =====================================================================
// SurfacePolygon
// =====================================================================
export class SurfacePolygon extends SpatialObject {
    // ── Геометрия / CRS ──
    _rings;
    _crsCode;
    _crs = null;
    // ── Стиль ──
    _fillColor;
    _fillOpacity;
    _strokeColor;
    _strokeWidth;
    _offsetY;
    // ── Оверлеи / подписки ──
    _overlays = new Map();
    _callback = null;
    _disposeCallback = null;
    _unregisterInteraction = null;
    /**
     * Кэш колец, спроецированных в worldGroup-local XZ
     * (тот же space, что и `map.project()`). Инвалидируется при
     * смене колец/CRS/teardown; переживает движение камеры.
     */
    _projectedRingsCache = null;
    constructor(options) {
        super();
        if (!options.rings?.[0] || options.rings[0].length < 3) {
            throw new Error('SurfacePolygon: rings[0] must contain at least 3 points');
        }
        this._properties = options.properties ?? {};
        this._userData = options.userData ?? {};
        this._rings = options.rings;
        this._crsCode = options.crs ?? null;
        this._fillColor = options.fillColor ?? '#ff0000';
        this._fillOpacity = options.fillOpacity ?? 0.6;
        this._strokeColor = options.strokeColor ?? '#000000';
        this._strokeWidth = options.strokeWidth ?? 1;
        this._offsetY = options.offsetY ?? 0.2;
        this._minZoom = options.minZoom ?? -Infinity;
        this._maxZoom = options.maxZoom ?? Infinity;
        this._tooltipText = options.tooltip ?? '';
        this._onClick = options.onClick ?? null;
        this._onHover = options.onHover ?? null;
        if (options.zoomInterpolate)
            this.setZoomInterpolations(options.zoomInterpolate);
    }
    // =================================================================
    // Хуки SpatialObject
    // =================================================================
    _onAttached(map) {
        this._crs = this._crsCode
            ? Projections.get(this._crsCode)
            : map.inputCRS;
        this._projectedRingsCache = null;
        // Применяем интерполяции по текущему зуму ДО создания оверлеев,
        // чтобы первый рендер шёл с актуальными значениями.
        this._applyZoomInterpolations(map.continuousZoom);
        // Подписка на готовность высот тайлов.
        const callbacks = map.tileManager?.onTileHeightAppliedCallbacks;
        if (callbacks) {
            this._callback = (inst) => this._onTileHeightApplied(inst);
            callbacks.push(this._callback);
            for (const inst of map.tileManager.tiles.values()) {
                if (inst.heightsApplied)
                    this._onTileHeightApplied(inst);
            }
        }
        // Подписка на удаление тайлов (уборка оверлеев).
        const disposeCallbacks = map.tileManager?.onTileDisposedCallbacks;
        if (disposeCallbacks) {
            this._disposeCallback = (inst) => this._onTileDisposed(inst);
            disposeCallbacks.push(this._disposeCallback);
        }
        this._registerInteraction(map);
    }
    _teardown() {
        if (this._unregisterInteraction) {
            this._unregisterInteraction();
            this._unregisterInteraction = null;
        }
        if (this._map) {
            const tm = this._map.tileManager;
            if (tm) {
                if (this._callback && tm.onTileHeightAppliedCallbacks) {
                    const idx = tm.onTileHeightAppliedCallbacks.indexOf(this._callback);
                    if (idx > -1)
                        tm.onTileHeightAppliedCallbacks.splice(idx, 1);
                }
                if (this._disposeCallback && tm.onTileDisposedCallbacks) {
                    const idx = tm.onTileDisposedCallbacks.indexOf(this._disposeCallback);
                    if (idx > -1)
                        tm.onTileDisposedCallbacks.splice(idx, 1);
                }
            }
        }
        this._callback = null;
        this._disposeCallback = null;
        for (const entry of this._overlays.values()) {
            this._disposeOverlayEntry(entry);
        }
        this._overlays.clear();
        this._projectedRingsCache = null;
        this._crs = null;
    }
    _applyHidden() {
        for (const entry of this._overlays.values()) {
            entry.mesh.visible = false;
        }
    }
    _onAltitudeChanged() {
        // altitude наследуется, но не используется для позиционирования:
        // оверлей «сидит» на геометрии тайла, вертикальный сдвиг — `offsetY`.
    }
    _onTooltipChanged() {
        if (this._map)
            this._registerInteraction(this._map);
    }
    getLabelType() { return 'polygon'; }
    /** У SurfacePolygon нет единственной точки — подпись не рисуется. */
    getScreenPosition() { return null; }
    _update(map) {
        if (!this._map)
            return;
        this._applyZoomInterpolations(map.continuousZoom);
        const visible = this._isWithinView();
        this._isVisible = visible;
        for (const entry of this._overlays.values()) {
            entry.mesh.visible = visible;
        }
    }
    // =================================================================
    // Интерактив (через меши оверлеев)
    // =================================================================
    _registerInteraction(map) {
        if (this._unregisterInteraction) {
            this._unregisterInteraction();
            this._unregisterInteraction = null;
        }
        if (!map.interaction || typeof map.interaction.register !== 'function')
            return;
        if (!this._onClick && !this._onHover && !this._tooltipText)
            return;
        this._unregisterInteraction = map.interaction.register(this, {
            getMeshes: () => {
                const meshes = [];
                for (const entry of this._overlays.values())
                    meshes.push(entry.mesh);
                return meshes;
            },
            getBoundingSphere: () => null,
            onHover: this._onHover || null,
            onClick: this._onClick || null,
            getTooltip: this._tooltipText ? () => this._tooltipText : null,
            isVisible: () => this._isWithinView(),
        });
    }
    // =================================================================
    // Стиль — сеттеры/геттеры
    // =================================================================
    setFillColor(color) {
        this._fillColor = color;
        this._redrawAllOverlays();
        return this;
    }
    getFillColor() { return this._fillColor; }
    setFillOpacity(opacity) {
        this._fillOpacity = Math.max(0, Math.min(1, opacity));
        this._redrawAllOverlays();
        return this;
    }
    getFillOpacity() { return this._fillOpacity; }
    setStrokeColor(color) {
        this._strokeColor = color;
        this._redrawAllOverlays();
        return this;
    }
    getStrokeColor() { return this._strokeColor; }
    setStrokeWidth(width) {
        if (!(width >= 0))
            return this;
        this._strokeWidth = width;
        this._redrawAllOverlays();
        return this;
    }
    getStrokeWidth() { return this._strokeWidth; }
    /** Дополнительный подъём над рельефом (мировые метры). */
    setOffsetY(offset) {
        this._offsetY = offset;
        for (const entry of this._overlays.values()) {
            entry.mesh.position.y = offset;
        }
        return this;
    }
    getOffsetY() { return this._offsetY; }
    // =================================================================
    // Геометрия
    // =================================================================
    setRings(rings) {
        if (!rings || !rings.length || rings[0].length < 3) {
            console.warn('SurfacePolygon.setRings: need at least one ring with 3+ points');
            return this;
        }
        this._rings = rings;
        this._projectedRingsCache = null;
        this._rebuildAllOverlays();
        return this;
    }
    getRings() {
        return this._rings.map(r => r.map(p => [...p]));
    }
    // =================================================================
    // CRS / Center / Bounds
    // =================================================================
    getCRS() { return this._crsCode; }
    getCenter() {
        const b = this.getBounds('EPSG:4326');
        if (!b)
            return null;
        return [(b[0][0] + b[1][0]) / 2, (b[0][1] + b[1][1]) / 2];
    }
    getBounds(crs = 'EPSG:4326') {
        if (!this._rings || !this._rings.length)
            return null;
        const src = this._crs
            ?? (this._crsCode ? Projections.get(this._crsCode) : Projections.get('EPSG:4326'));
        const dst = typeof crs === 'string' ? Projections.get(crs) : crs;
        if (!src || !dst)
            return null;
        const sameProjection = src === dst;
        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
        let count = 0;
        for (const ring of this._rings) {
            if (!ring)
                continue;
            for (let i = 0; i < ring.length; i++) {
                const pt = ring[i];
                if (!pt || pt.length < 2)
                    continue;
                let x, y;
                if (sameProjection) {
                    x = pt[0];
                    y = pt[1];
                }
                else {
                    const lonLat = src.toLonLat(pt);
                    const converted = dst.fromLonLat(lonLat);
                    x = converted[0];
                    y = converted[1];
                }
                if (x < minX)
                    minX = x;
                if (x > maxX)
                    maxX = x;
                if (y < minY)
                    minY = y;
                if (y > maxY)
                    maxY = y;
                count++;
            }
        }
        if (count === 0 || !isFinite(minX))
            return null;
        return [[minX, minY], [maxX, maxY]];
    }
    // =================================================================
    // Тайловые колбэки
    // =================================================================
    _onTileHeightApplied(inst) {
        if (!this._map || !inst.geometry || !inst.mesh)
            return;
        if (!this._isWithinView())
            return;
        const bbox = this._getTileMercatorBBox(inst);
        if (!this._polygonIntersectsTile(bbox))
            return;
        this._createOverlayForTile(inst, bbox);
    }
    _onTileDisposed(inst) {
        if (!this._map)
            return;
        const key = getVirtKey(inst.z, inst.virtX, inst.y);
        const entry = this._overlays.get(key);
        if (entry) {
            this._disposeOverlayEntry(entry);
            this._overlays.delete(key);
        }
    }
    // =================================================================
    // Управление оверлеями
    // =================================================================
    _rebuildAllOverlays() {
        if (!this._map)
            return;
        for (const entry of this._overlays.values()) {
            this._disposeOverlayEntry(entry);
        }
        this._overlays.clear();
        if (!this._isWithinView())
            return;
        for (const inst of this._map.tileManager.tiles.values()) {
            if (inst.heightsApplied)
                this._onTileHeightApplied(inst);
        }
    }
    _redrawAllOverlays() {
        if (!this._map)
            return;
        for (const entry of this._overlays.values()) {
            this._drawOverlayCanvas(entry.canvas, entry.ctx, entry.bbox);
            const tex = entry.mesh.material?.map;
            if (tex)
                tex.needsUpdate = true;
        }
    }
    _createOverlayForTile(inst, bbox) {
        const key = getVirtKey(inst.z, inst.virtX, inst.y);
        const old = this._overlays.get(key);
        if (old) {
            this._disposeOverlayEntry(old);
            this._overlays.delete(key);
        }
        const geomCopy = inst.geometry.clone();
        geomCopy.computeBoundingSphere();
        const canvas = document.createElement('canvas');
        canvas.width = canvas.height = DEFAULT_OVERLAY_TEX_SIZE;
        const ctx = canvas.getContext('2d');
        if (!ctx)
            return;
        this._drawOverlayCanvas(canvas, ctx, bbox);
        const texture = new THREE.CanvasTexture(canvas);
        texture.generateMipmaps = false;
        texture.minFilter = THREE.LinearFilter;
        texture.magFilter = THREE.LinearFilter;
        texture.needsUpdate = true;
        const material = new THREE.MeshBasicMaterial({
            map: texture,
            transparent: true,
            depthTest: true,
            depthWrite: false,
            side: THREE.DoubleSide,
            polygonOffset: true,
            polygonOffsetFactor: -1,
            polygonOffsetUnits: -1,
        });
        const overlayMesh = new THREE.Mesh(geomCopy, material);
        overlayMesh.position.set(0, this._offsetY, 0);
        overlayMesh.renderOrder = inst.mesh.renderOrder + 1;
        overlayMesh.userData.surfacePolygon = this;
        // ── Override raycast ───────────────────────────────────────
        // Геометрия оверлея = геометрия всего тайла. Стандартный
        // raycast дал бы попадание в любую точку тайла. Отфильтровываем
        // пересечения, чья XZ-проекция не лежит внутри полигона.
        const meshRef = overlayMesh;
        overlayMesh.raycast = (raycaster, intersects) => {
            if (!meshRef.visible)
                return;
            const start = intersects.length;
            THREE.Mesh.prototype.raycast.call(meshRef, raycaster, intersects);
            if (intersects.length === start)
                return;
            const wg = this._map?.worldGroup;
            if (!wg) {
                intersects.length = start;
                return;
            }
            const rings = this._getProjectedRings();
            if (!rings.length) {
                intersects.length = start;
                return;
            }
            const invMatrix = new THREE.Matrix4().copy(wg.matrixWorld).invert();
            const tmpVec = new THREE.Vector3();
            for (let i = intersects.length - 1; i >= start; i--) {
                const hit = intersects[i];
                if (!hit?.point) {
                    intersects.splice(i, 1);
                    continue;
                }
                tmpVec.copy(hit.point).applyMatrix4(invMatrix);
                if (!this._pointInProjectedPolygon(tmpVec.x, tmpVec.z, rings)) {
                    intersects.splice(i, 1);
                }
            }
        };
        // Оверлей — ребёнок тайла: наследует видимость и трансформации.
        inst.mesh.add(overlayMesh);
        this._overlays.set(key, { mesh: overlayMesh, canvas, ctx, bbox });
    }
    _drawOverlayCanvas(canvas, ctx2d, bbox) {
        const map = this._map;
        if (!map)
            return;
        const ts = (bbox.right - bbox.left) || 1;
        const texSize = canvas.width;
        ctx2d.clearRect(0, 0, canvas.width, canvas.height);
        const ring = this._rings[0];
        const uvPoints = ring.map((pt) => {
            const [wx, wz] = map.project(pt, this._crs);
            return {
                u: (wx - bbox.left) / ts,
                v: (wz - bbox.bottom) / ts,
            };
        });
        if (uvPoints.length === 0)
            return;
        ctx2d.save();
        ctx2d.beginPath();
        ctx2d.rect(0, 0, canvas.width, canvas.height);
        ctx2d.clip();
        ctx2d.beginPath();
        ctx2d.moveTo(uvPoints[0].u * canvas.width, uvPoints[0].v * canvas.height);
        for (let i = 1; i < uvPoints.length; i++) {
            ctx2d.lineTo(uvPoints[i].u * canvas.width, uvPoints[i].v * canvas.height);
        }
        ctx2d.closePath();
        ctx2d.fillStyle = this._fillColor;
        ctx2d.globalAlpha = this._fillOpacity;
        ctx2d.fill();
        if (this._strokeWidth > 0) {
            ctx2d.globalAlpha = 1.0;
            ctx2d.strokeStyle = this._strokeColor;
            const scale = texSize / map.TILE_PIXELS;
            ctx2d.lineWidth = this._strokeWidth * scale;
            ctx2d.lineJoin = 'round';
            ctx2d.lineCap = 'round';
            ctx2d.stroke();
        }
        ctx2d.restore();
    }
    _disposeOverlayEntry(entry) {
        const mesh = entry.mesh;
        if (!mesh)
            return;
        mesh.parent?.remove(mesh);
        mesh.geometry?.dispose();
        if (mesh.material?.map)
            mesh.material.map.dispose();
        mesh.material?.dispose();
    }
    // =================================================================
    // Point-in-polygon (raycast filter)
    // =================================================================
    /**
     * Кольца, спроецированные в worldGroup-local XZ
     * (`map.project(pt, crs) → [x, z]`). Стабильны при движении камеры,
     * кэшируются до `setRings` / смены CRS / teardown.
     */
    _getProjectedRings() {
        if (this._projectedRingsCache)
            return this._projectedRingsCache;
        const map = this._map;
        if (!map)
            return [];
        this._projectedRingsCache = this._rings.map(ring => ring.map(pt => {
            const [x, z] = map.project(pt, this._crs);
            return [x, z];
        }));
        return this._projectedRingsCache;
    }
    /**
     * Even-odd point-in-polygon с поддержкой дырок:
     * точка внутри внешнего кольца и вне всех внутренних.
     */
    _pointInProjectedPolygon(px, pz, rings) {
        if (!rings.length)
            return false;
        if (!this._pointInRingXZ(rings[0], px, pz))
            return false;
        for (let r = 1; r < rings.length; r++) {
            if (this._pointInRingXZ(rings[r], px, pz))
                return false;
        }
        return true;
    }
    _pointInRingXZ(ring, px, pz) {
        let inside = false;
        const n = ring.length;
        for (let i = 0, j = n - 1; i < n; j = i++) {
            const xi = ring[i][0], zi = ring[i][1];
            const xj = ring[j][0], zj = ring[j][1];
            if (((zi > pz) !== (zj > pz)) &&
                (px < (xj - xi) * (pz - zi) / (zj - zi) + xi)) {
                inside = !inside;
            }
        }
        return inside;
    }
    // =================================================================
    // Вспомогательные
    // =================================================================
    _getTileMercatorBBox(inst) {
        const map = this._map;
        const ts = map.WORLD_SIZE / Math.pow(2, inst.z);
        const left = inst.virtX * ts - map.MAX_MERCATOR;
        const bottom = getOriginZ(inst.y, ts, map.MAX_MERCATOR);
        return { left, right: left + ts, bottom, top: bottom + ts };
    }
    _polygonIntersectsTile(bbox) {
        const ring = this._rings[0];
        let minX = Infinity, maxX = -Infinity;
        let minZ = Infinity, maxZ = -Infinity;
        for (const pt of ring) {
            const [x, z] = this._map.project(pt, this._crs);
            if (x < minX)
                minX = x;
            if (x > maxX)
                maxX = x;
            if (z < minZ)
                minZ = z;
            if (z > maxZ)
                maxZ = z;
        }
        return !(maxX < bbox.left || minX > bbox.right ||
            maxZ < bbox.bottom || minZ > bbox.top);
    }
}
