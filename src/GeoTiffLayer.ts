// @ts-nocheck

import { THREE } from './js_TP/tpb.js';
import { Projections } from './Projections.js';
import { SpatialObject } from './SpatialObject.js';
import { fromUrl, fromArrayBuffer, Pool } from './js_TP/geotiff.bundle.js';
import {
    resolveColorRamp,
    sampleColorRamp,
    parseColorToRGBA
} from './ColorRamps.js';
import { applyGapMaskToMaterial } from './PolygonUtils.js';

/** @private */ const GEOTIFF_RENDER_ORDER = 995;
/** @private */ const DEFAULT_WORKER_URL = new URL('./js_TP/geotiff.worker.js', import.meta.url).href;
/** @private */ const DEFAULT_HEIGHT_SCALE = 1.0;
/** @private */ const DEFAULT_POLYGON_OFFSET = -4;
/** @private */ const TILE_TEXTURE_CACHE_MAX = 200;

/**
 * Слой GeoTIFF-растра.
 *
 * В режиме `asElevation: true` и `mergeIntoTiles: true` (по умолчанию)
 * собственный меш **не строится**: растр инжектится как overlay-текстура
 * в материал тайлов (см. `TileManager.loadTile` → `setMeshOverlay`).
 * Это устраняет z-fighting с поверхностью тайлов, т.к. поверхность одна.
 *
 * Прозрачность и noData пробрасываются через альфу overlay-текстуры
 * (`mix(tileColor, rampColor, ramp.a * opacity)`), так что тайлы под
 * полупрозрачным GeoTIFF остаются видны.
 *
 * Если `mergeIntoTiles: false` (или `asElevation` выключен) — работает
 * классический режим с отдельным мешем (как раньше).
 */
export class GeoTiffLayer extends SpatialObject {
    constructor(options = {}) {
        super();
        if (!options.source) throw new Error('GeoTiffLayer: options.source is required');

        this._source = options.source;
        this._crsCode = options.crs ?? null;
        this._crs = null;

        this._opacity = options.opacity ?? 1;
        this._blending = options.blending || 'normal';
        this._renderOrder = options.renderOrder ?? GEOTIFF_RENDER_ORDER;
        this._alwaysOnTop = options.alwaysOnTop === true;
        this._polygonOffset = Number.isFinite(options.polygonOffset)
            ? options.polygonOffset : DEFAULT_POLYGON_OFFSET;

        this._useWorker = options.useWorker === true;
        this._poolSize = options.poolSize ?? 2;
        this._workerUrl = options.workerUrl ?? DEFAULT_WORKER_URL;
        this._pool = options.pool || null;
        this._ownsPool = false;
        this._blobWorkerUrl = null;

        this._onProgress = options.onProgress || null;
        this._onLoad = options.onLoad || null;
        this._onError = options.onError || null;
                // Merge-mode & elevation caches
        this._tileTextureCache = new Map();   // key "z,srcX,y,size" -> THREE.Texture | null
        this._tileHeightsCache = new Map();   // key "z,srcX,y,seg" -> { heights: Float32Array | null, max: number }
        this._rampLut32 = null;               // Uint32Array(1024) предрассчитанной цветовой шкалы
        this._lonLatBounds = null;            // [minLon, minLat, maxLon, maxLat]
        this._mergedIntoMap = false;

        // SpatialObject state
        this._minZoom = options.minZoom ?? -Infinity;
        this._maxZoom = options.maxZoom ?? Infinity;
        this._altitude = Number.isFinite(options.altitude)
            ? options.altitude
            : (Number.isFinite(options.elevationOffset) ? options.elevationOffset : 0);
        this._title = options.title || '';
        this._titleStyle = options.titleStyle || {};
        this._titleMinZoom = options.titleMinZoom ?? -Infinity;
        this._titleMaxZoom = options.titleMaxZoom ?? Infinity;
        this._titleAlign = options.titleAlign || 'center';
        this._userTitleOffset = options.titleOffset || null;
        this._titleAllowOverflow = options.titleAllowOverflow || false;
        this._titlePriority = options.titlePriority ?? 0;
        this._tooltipText = options.tooltip || '';
        this._onClick = options.onClick || null;
        this._onHover = options.onHover || null;
        this._resolveTitleOffset();

        // Ramp
        this._colorRampInput = options.colorRamp ?? undefined;
        this._colorRampNormalized = null;
        this._minValue = options.minValue ?? null;
        this._maxValue = options.maxValue ?? null;
        this._noDataValue = options.noDataValue ?? null;
        this._noDataColor = options.noDataColor !== undefined ? options.noDataColor : 'transparent';
        this._effectiveMin = null;
        this._effectiveMax = null;
        this._effectiveNoData = null;

        // Elevation
        this._asElevation = options.asElevation === true;
        this._elevationHeightScale = options.heightScale ?? DEFAULT_HEIGHT_SCALE;

        // Merge-into-tiles: применяется только если слой реально elevation.
        this._mergeIntoTiles = options.mergeIntoTiles !== false;

        if (this._asElevation) this._keepRawData = true;
        else if (options.keepRawData === true) this._keepRawData = true;
        else if (options.keepRawData === false) this._keepRawData = false;
        else this._keepRawData = options.colorRamp !== undefined;

        this._rawData = null;
        this._rawWidth = 0;
        this._rawHeight = 0;
        this._geoOrigin = null;
        this._geoResolution = null;
        this._geoNoData = null;

        // Drape
        this._drape = options.drape !== undefined ? options.drape === true : this._asElevation;
        this._meshSegments = (typeof options.meshSegments === 'number' && options.meshSegments > 0)
            ? Math.floor(options.meshSegments) : null;
            this._warpSegments = options.warpSegments ?? null;

this._cornersCrs = null;
        this._imageWidth = 0;
        this._imageHeight = 0;

        // State
        this._group = new THREE.Group();
        this._mesh = null;
        this._geometry = null;
        this._material = null;
        this._texture = null;
        this._textLabel = null;
        this._image = null;
        this._tiff = null;
        this._worldPositions = [];
        this._centroidWorld = new THREE.Vector3();
        this._boundingSphereRadius = 0;
        this._tempVec3 = new THREE.Vector3();

        this._loaded = false;
        this._loading = false;
        this._loadPromise = null;
        this._isHovered = false;
        this._unregisterInteraction = null;

        // Merge-mode state
        this._tileTextureCache = new Map();   // key "z,vx,y,size" -> THREE.Texture | null
        this._mergedIntoMap = false;          // добавили ли мы свой overlay в тайлы

        // GeoJSON Mask state (аналогично Tile / TileManager)
        this.mask = options.mask ?? null;
        this.maskInvert = options.maskInvert ?? false;
        this.maskFeather = Number.isFinite(Number(options.maskFeather))
            ? Math.max(0, Number(options.maskFeather))
            : 0;
        this._maskTexture = null;
        this._maskBounds = null; // { minX, minZ, sizeX, sizeZ } в локальных координатах worldGroup
        this._maskProjPolys = null;
        this._maskEnabled = false;
        this._maskInvert = this.maskInvert;
        this._maskFeather = this.maskFeather;
        this._maskOffsetUniform = { value: new THREE.Vector3() };

        this._properties = options.properties ?? {};
        this._userData = options.userData ?? {};

        if (options.zoomInterpolate) this.setZoomInterpolations(options.zoomInterpolate);
    }

    /* ==== Public API ==== */

    addTo(map) {
        if (this._map === map) return this;
        super.addTo(map);
        if (!this._loaded && !this._loading) this._load();
        return this;
    }

    removeFromMap() { this.remove(); }

    isLoaded() { return this._loaded; }
    isLoading() { return this._loading; }
    getImage() { return this._image; }

    getDataRange() {
        if (this._effectiveMin === null) return null;
        return { min: this._effectiveMin, max: this._effectiveMax };
    }

    /** true, если слой сейчас «слит» в тайлы (без собственного меша). */
    isMergedIntoTiles() { return this._mergedIntoMap; }

    /* ==== Style ==== */

       setOpacity(v) {
        this._opacity = Math.max(0, Math.min(1, v));
        if (this._material) {
            this._material.opacity = this._opacity;
            const needsTransparent = this._opacity < 1 || (this._maskEnabled && this._maskFeather > 0);
            if (this._material.transparent !== needsTransparent) {
                this._material.transparent = needsTransparent;
                this._material.needsUpdate = true;
            }
        }
        if (this._mergedIntoMap) this._syncOverlayOpacity();
        return this;
    }
    getOpacity() { return this._opacity; }


    /* ==== Маска по GeoJSON (как у Tile) ==== */

    setMask(geojson, opts = {}) {
        this.mask = geojson ?? null;
        if (opts.invert !== undefined) this.maskInvert = !!opts.invert;
        if (opts.feather !== undefined) {
            const f = Number(opts.feather);
            this.maskFeather = Number.isFinite(f) ? Math.max(0, f) : 0;
        }
        if (!this.mask) {
            return this.clearMask();
        }
        if (this._map) {
            this._rebuildAndApplyMask();
        }
        return this;
    }

    clearMask() {
        this.mask = null;
        if (this._maskTexture) {
            try { this._maskTexture.dispose(); } catch {}
        }
        this._maskTexture = null;
        this._maskBounds = null;
        this._maskProjPolys = null;
        this._maskEnabled = false;
        this._maskInvert = false;
        this._maskFeather = 0;
        if (this._material) {
            this._updateMaterialMask(this._material);
        }
        return this;
    }

    _rebuildAndApplyMask() {
        if (!this.mask || !this._map) return this.clearMask();
        const built = this._buildMaskTexture(this.mask, this.maskFeather);
        if (!built) {
            console.warn('GeoTiffLayer.setMask: empty or invalid mask');
            return this.clearMask();
        }
        if (this._maskTexture) {
            try { this._maskTexture.dispose(); } catch {}
        }
        this._maskTexture = built.texture;
        this._maskBounds = built.bounds;
        this._maskProjPolys = built.projPolys;
        this._maskEnabled = true;
        this._maskInvert = !!this.maskInvert;
        this._maskFeather = built.feather;

        if (this._material) {
            this._updateMaterialMask(this._material);
        }
        return this;
    }

    _buildMaskTexture(geojson, featherWorld = 0) {
        const proj = this._map?.projection;
        if (!proj || typeof proj.fromLonLat !== 'function') {
            console.warn('GeoTiffLayer.setMask: map.projection.fromLonLat недоступен');
            return null;
        }

        const project = (lon, lat) => {
            let p = null;
            try {
                p = (proj.fromLonLatSafe ?? proj.fromLonLat)([lon, lat]);
            } catch {
                try { p = proj.fromLonLat([lon, lat]); } catch {}
            }
            if (!p || !Number.isFinite(p[0]) || !Number.isFinite(p[1])) return null;
            return [p[0], -p[1]];
        };

        const polys = [];
        const visit = (g) => {
            if (!g) return;
            if (g.type === 'FeatureCollection') g.features.forEach(visit);
            else if (g.type === 'Feature') visit(g.geometry);
            else if (g.type === 'Polygon') polys.push(g.coordinates);
            else if (g.type === 'MultiPolygon') polys.push(...g.coordinates);
            else if (g.type === 'GeometryCollection') g.geometries.forEach(visit);
        };
        visit(geojson);
        if (!polys.length) return null;

        let minX = Infinity, minZ = Infinity, maxX = -Infinity, maxZ = -Infinity;
        const projPolys = [];

        for (const poly of polys) {
            const rings = [];
            for (const ring of poly) {
                const r = [];
                for (const pt of ring) {
                    const p = project(pt[0], pt[1]);
                    if (!p) continue;
                    r.push(p);
                    if (p[0] < minX) minX = p[0];
                    if (p[0] > maxX) maxX = p[0];
                    if (p[1] < minZ) minZ = p[1];
                    if (p[1] > maxZ) maxZ = p[1];
                }
                if (r.length >= 3) rings.push(r);
            }
            if (rings.length) projPolys.push(rings);
        }

        if (!isFinite(minX) || !isFinite(minZ) || maxX <= minX || maxZ <= minZ) return null;

        let feather = Math.max(0, Number(featherWorld) || 0);
        feather = Math.min(feather, 0.25 * Math.min(maxX - minX, maxZ - minZ));

        const pad = feather * 2.5;
        minX -= pad; maxX += pad;
        minZ -= pad; maxZ += pad;

        const sizeX = maxX - minX, sizeZ = maxZ - minZ;

        const MAX_DIM = 2048, MIN_DIM = 128;
        const scale = MAX_DIM / Math.max(sizeX, sizeZ);
        const W = Math.max(MIN_DIM, Math.min(4096, Math.ceil(sizeX * scale)));
        const H = Math.max(MIN_DIM, Math.min(4096, Math.ceil(sizeZ * scale)));

        const canvas = document.createElement('canvas');
        canvas.width = W;
        canvas.height = H;
        const ctx = canvas.getContext('2d');

        ctx.fillStyle = '#000000';
        ctx.fillRect(0, 0, W, H);
        ctx.fillStyle = '#ffffff';

        for (const rings of projPolys) {
            ctx.beginPath();
            for (const ring of rings) {
                for (let i = 0; i < ring.length; i++) {
                    const cx = ((ring[i][0] - minX) / sizeX) * W;
                    const cy = ((ring[i][1] - minZ) / sizeZ) * H;
                    if (i === 0) ctx.moveTo(cx, cy);
                    else ctx.lineTo(cx, cy);
                }
                ctx.closePath();
            }
            ctx.fill('evenodd');
        }

        let outCanvas = canvas;
        if (feather > 0) {
            const blurPx = feather * (W / sizeX);
            if (blurPx >= 0.5) {
                const blurred = document.createElement('canvas');
                blurred.width = W;
                blurred.height = H;
                const bctx = blurred.getContext('2d');
                bctx.fillStyle = '#000000';
                bctx.fillRect(0, 0, W, H);

                const MAX_BLUR = 24;
                if (blurPx <= MAX_BLUR) {
                    bctx.filter = `blur(${blurPx.toFixed(2)}px)`;
                    bctx.drawImage(canvas, 0, 0);
                    bctx.filter = 'none';
                } else {
                    const ratio = MAX_BLUR / blurPx;
                    const sw = Math.max(16, Math.round(W * ratio));
                    const sh = Math.max(16, Math.round(H * ratio));
                    const small = document.createElement('canvas');
                    small.width = sw;
                    small.height = sh;
                    const sctx = small.getContext('2d');
                    sctx.fillStyle = '#000000';
                    sctx.fillRect(0, 0, sw, sh);
                    sctx.filter = `blur(${MAX_BLUR}px)`;
                    sctx.drawImage(canvas, 0, 0, sw, sh);
                    sctx.filter = 'none';
                    bctx.imageSmoothingEnabled = true;
                    bctx.imageSmoothingQuality = 'high';
                    bctx.drawImage(small, 0, 0, W, H);
                }
                outCanvas = blurred;
            }
        }

        const tex = new THREE.CanvasTexture(outCanvas);
        tex.minFilter = THREE.LinearFilter;
        tex.magFilter = THREE.LinearFilter;
        tex.generateMipmaps = false;
        tex.wrapS = THREE.ClampToEdgeWrapping;
        tex.wrapT = THREE.ClampToEdgeWrapping;
tex.colorSpace = 'srgb-linear';
        tex.needsUpdate = true;
        this._map.renderer?.initTexture?.(tex);

        return { texture: tex, bounds: { minX, minZ, sizeX, sizeZ }, feather, projPolys };
    }

    _setupMaterialMask(mat) {
        if (this._map?.worldGroup) {
            this._maskOffsetUniform.value.copy(this._map.worldGroup.position);
        }
        mat.userData._maskUniforms = null;

        if (this._maskEnabled && this._maskFeather > 0 && !mat.transparent) {
            mat.transparent = true;
        }

        mat.onBeforeCompile = (shader) => {
            const b = this._maskBounds;
            const maskUniforms = {
                maskMap: { value: this._maskTexture },
                maskEnabled: { value: this._maskEnabled ? 1 : 0 },
                maskInvert: { value: this._maskInvert ? 1 : 0 },
                maskFeather: { value: this._maskFeather },
                maskBoundsMin: {
                    value: new THREE.Vector2(b ? b.minX : 0, b ? b.minZ : 0),
                },
                maskBoundsSize: {
                    value: new THREE.Vector2(b ? b.sizeX : 1, b ? b.sizeZ : 1),
                },
                maskWorldOffset: this._maskOffsetUniform,
            };

            Object.assign(shader.uniforms, maskUniforms);
            mat.userData._maskUniforms = maskUniforms;

            shader.vertexShader = shader.vertexShader
                .replace(
                    '#include <common>',
                    `#include <common>
                    uniform vec3 maskWorldOffset;
                    varying vec2 vMaskWorldPos;`
                )
                .replace(
                    '#include <project_vertex>',
                    `#include <project_vertex>
                    vec4 maskWp = modelMatrix * vec4( transformed, 1.0 );
                    vMaskWorldPos = maskWp.xz - maskWorldOffset.xz;`
                );

            shader.fragmentShader = shader.fragmentShader
                .replace(
                    '#include <common>',
                    `#include <common>
                    uniform sampler2D maskMap;
                    uniform int maskEnabled;
                    uniform int maskInvert;
                    uniform float maskFeather;
                    uniform vec2 maskBoundsMin;
                    uniform vec2 maskBoundsSize;
                    varying vec2 vMaskWorldPos;`
                )
                .replace(
                    '#include <map_fragment>',
                    `#include <map_fragment>
                    if (maskEnabled == 1) {
                        vec2 maskUV = (vMaskWorldPos - maskBoundsMin) / maskBoundsSize;
                        float maskVal = 0.0;
                        if (maskUV.x >= 0.0 && maskUV.x <= 1.0 && maskUV.y >= 0.0 && maskUV.y <= 1.0) {
                            maskVal = texture2D(maskMap, vec2(maskUV.x, 1.0 - maskUV.y)).r;
                        }
                        if (maskInvert == 1) {
                            maskVal = 1.0 - maskVal;
                        }
                        if (maskFeather > 0.0) {
                            if (maskVal <= 0.001) discard;
                            diffuseColor.a *= maskVal;
                        } else {
                            if (maskVal < 0.5) discard;
                        }
                    }`
                );
        };
        mat.needsUpdate = true;
    }

    _updateMaterialMask(mat) {
        const bounds = this._maskBounds;
        const u = mat.userData._maskUniforms;
        if (u) {
            u.maskMap.value = this._maskTexture;
            u.maskEnabled.value = this._maskEnabled ? 1 : 0;
            u.maskInvert.value = this._maskInvert ? 1 : 0;
            u.maskFeather.value = this._maskFeather;
            if (bounds) {
                u.maskBoundsMin.value.set(bounds.minX, bounds.minZ);
                u.maskBoundsSize.value.set(bounds.sizeX, bounds.sizeZ);
            }
        }

        const needsTransparent = this._opacity < 1 || (this._maskEnabled && this._maskFeather > 0);
        if (mat.transparent !== needsTransparent) {
            mat.transparent = needsTransparent;
            mat.needsUpdate = true;
        }
    }

    /** Проверка попадания точки (в локальных координатах worldGroup) в маску для pick(). */
    _passesMaskAtLocalXZ(x, z) {
        if (!this._maskEnabled || !this._maskProjPolys) return true;
        let insideAny = false;
        for (const rings of this._maskProjPolys) {
            let insidePoly = false;
            for (const ring of rings) {
                for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
                    const xi = ring[i][0], zi = ring[i][1];
                    const xj = ring[j][0], zj = ring[j][1];
                    const intersect = ((zi > z) !== (zj > z)) &&
                        (x < ((xj - xi) * (z - zi)) / (zj - zi) + xi);
                    if (intersect) insidePoly = !insidePoly;
                }
            }
            if (insidePoly) {
                insideAny = true;
                break;
            }
        }
        return this._maskInvert ? !insideAny : insideAny;
    }

    setBlending(v) {
        this._blending = v;
        if (this._material) this._material.blending = this._normalizeBlending(v);
        return this;
    }
    getBlending() { return this._blending; }

    setRenderOrder(v) {
        this._renderOrder = v;
        if (this._mesh) this._mesh.renderOrder = v;
        return this;
    }
    getRenderOrder() { return this._renderOrder; }

    setAlwaysOnTop(v) {
        this._alwaysOnTop = !!v;
        if (this._material) {
            this._material.depthTest = !this._alwaysOnTop;
            this._material.polygonOffset = !this._alwaysOnTop;
            this._material.needsUpdate = true;
        }
        return this;
    }
    getAlwaysOnTop() { return this._alwaysOnTop; }

    setPolygonOffset(v) {
        if (!Number.isFinite(v)) return;
        this._polygonOffset = v;
        if (this._material) {
            this._material.polygonOffsetFactor = v;
            this._material.polygonOffsetUnits = v;
        }
        return this;
    }
    getPolygonOffset() { return this._polygonOffset; }

   setHeightScale(v) {
        if (!Number.isFinite(v) || this._elevationHeightScale === v) return this;
        this._elevationHeightScale = v;
        this._tileHeightsCache.clear();
        if (this._loaded && this._mesh) {
            this._buildMesh();
        } else if (this._mergedIntoMap) {
            this._refreshTerrainTiles();
        }
        return this;
    }
/**
 * Задаёт число сегментов сетки для искривления рёбер GeoTIFF
 * в деформированных проекциях. Больше — плавнее край, дороже геометрия.
 * `null` — авто (по span в градусах: ~1 сегмент на 3°, 8..64).
 */
setWarpSegments(v) {
    const next = v === null ? null
        : (Number.isFinite(v) && v >= 1 ? Math.floor(v) : this._warpSegments);
    if (this._warpSegments === next) return this;
    this._warpSegments = next;
    if (this._loaded && this._mesh) this._buildMesh();
    return this;
}
getWarpSegments() {
    return this._warpSegments ?? this._autoWarpSegments();
}

    getHeightScale() { return this._elevationHeightScale; }

    /* ==== Pixel values ==== */

    getValueAtPixel(px, py, opts = {}) {
        if (!this._rawData) return null;
        if (opts.bilinear) {
            if (px < 0 || py < 0 || px > this._rawWidth - 1 || py > this._rawHeight - 1) return null;
            return this._bilinearSample(px, py);
        }
        const x = Math.floor(px), y = Math.floor(py);
        if (x < 0 || y < 0 || x >= this._rawWidth || y >= this._rawHeight) return null;
        const v = this._rawData[y * this._rawWidth + x];
        if (this._geoNoData !== null && v === this._geoNoData) return null;
        return Number.isFinite(v) ? v : null;
    }

    getValueAtLonLat(lon, lat) {
        if (!this._rawData) return null;
        const v = this._sampleAtLonLat(lon, lat);
        if (v === null || !Number.isFinite(v)) return null;
        if (this._geoNoData !== null && v === this._geoNoData) return null;
        return v;
    }

    getValueAtWorld(worldX, worldZ, map) {
        const lonLat = map.unprojectToLonLat(worldX, worldZ);
        if (!lonLat) return null;
        return this.getValueAtLonLat(lonLat[0], lonLat[1]);
    }

    /**
     * Pick по событию. В merge-режиме собственного меша нет — возвращает
     * null. Для получения значения в этом режиме используйте
     * `map.on('click', e => layer.getValueAtWorld(e.worldX, e.worldZ, map))`.
     */
    pick(event) {
        if (!this._mesh || !this._map) return null;

        const rect = this._map.renderer.domElement.getBoundingClientRect();
        const mouse = new THREE.Vector2(
            ((event.clientX - rect.left) / rect.width) * 2 - 1,
            -((event.clientY - rect.top) / rect.height) * 2 + 1
        );
        const raycaster = new THREE.Raycaster();
        raycaster.setFromCamera(mouse, this._map.camera);
        const hits = raycaster.intersectObject(this._mesh, false);
        if (!hits.length) return null;

        const point = hits[0].point;

        if (this._maskEnabled && this._map.worldGroup) {
            const lx = point.x - this._map.worldGroup.position.x;
            const lz = point.z - this._map.worldGroup.position.z;
            if (!this._passesMaskAtLocalXZ(lx, lz)) return null;
        }

        const lonLat = this._map.unprojectToLonLat(point.x, point.z);
        if (!lonLat) return null;

        const value = this.getValueAtLonLat(lonLat[0], lonLat[1]);
        if (value === null) return null;

        let pixel = null;
        if (this._geoOrigin && this._geoResolution) {
            const code = this._crs?.code;
            let xy;
            if (code === 'EPSG:4326' || code === 'CRS:84') xy = lonLat;
            else if (typeof this._crs?.fromLonLatSafe === 'function') xy = this._crs.fromLonLatSafe(lonLat);
            else if (typeof this._crs?.fromLonLat === 'function') {
                try { xy = this._crs.fromLonLat(lonLat); } catch { xy = null; }
            }
            if (xy) {
                pixel = [
                    (xy[0] - this._geoOrigin[0]) / this._geoResolution[0],
                    (xy[1] - this._geoOrigin[1]) / this._geoResolution[1],
                ];
            }
        }
        return { value, lonLat, pixel, point };
    }

    /* ==== Color ramp ==== */

    async setColorRamp(ramp) {
        this._colorRampInput = ramp;
        this._colorRampNormalized = null;
        this._rampLut32 = null;
        if (this._loadPromise) {
            try { await this._loadPromise; } catch { /* handled */ }
        }

        if (this._mergedIntoMap) {
            this._clearTileTextureCache();
            this._refreshTerrainTiles();
            return this;
        }

        if (!this._image || !this._isRampImage(this._image)) return this;
        try {
            const { texture } = await this._readAsRampTexture(
                this._image, this._image.getWidth(), this._image.getHeight()
            );
            if (this._texture) this._texture.dispose();
            this._texture = texture;
            if (this._material) {
                this._material.map = texture;
                this._material.needsUpdate = true;
            }
        } catch (err) {
            console.error('GeoTiffLayer.setColorRamp: rebuild failed. Use keepRawData: true.', err);
            throw err;
        }
        return this;
    }

    /* ==== Elevation provider ==== */

    isElevationProvider() {
        return !!this._rawData && this._rawWidth > 0 && this._rawHeight > 0
            && !!this._geoOrigin && !!this._geoResolution;
    }


    sampleAtWorld(worldX, worldZ, map) {
        if (!this.isElevationProvider()) return null;
        const lonLat = map.unprojectToLonLat(worldX, worldZ);
        if (!lonLat || !Number.isFinite(lonLat[0]) || !Number.isFinite(lonLat[1])) return null;
        const v = this._sampleAtLonLat(lonLat[0], lonLat[1]);
        if (v === null || !Number.isFinite(v)) return null;
        if (this._geoNoData !== null && v === this._geoNoData) return null;
        return v * this._elevationHeightScale;
    }



    get elevationMinZoom() { return 0; }
    get elevationMaxZoom() { return Infinity; }


    _evictTileTextureCache() {
        while (this._tileTextureCache.size > TILE_TEXTURE_CACHE_MAX) {
            const oldest = this._tileTextureCache.keys().next().value;
            const t = this._tileTextureCache.get(oldest);
            if (t) t.dispose();
            this._tileTextureCache.delete(oldest);
        }
    }

    _clearTileTextureCache() {
        for (const t of this._tileTextureCache.values()) {
            if (t) t.dispose();
        }
        this._tileTextureCache.clear();
    }

    /* ==== SpatialObject hooks ==== */

    protected _onAttached(map) { /* scene setup happens in _performLoad */ }

    protected _teardown() {
        if (this._unregisterInteraction) {
            try { this._unregisterInteraction(); } catch { /* swallow */ }
            this._unregisterInteraction = null;
        }

        this._mergedIntoMap = false;

        if (this._map?.elevationProvider === this) this._map.setElevationProvider(null);

        if (this._group.parent) this._group.parent.remove(this._group);
        this._disposeGpu();
        this._clearTileTextureCache();

        if (this._ownsPool && this._pool) {
            try { this._pool.destroy(); } catch { /* swallow */ }
            this._pool = null;
            this._ownsPool = false;
        }
        if (this._blobWorkerUrl) {
            try { URL.revokeObjectURL(this._blobWorkerUrl); } catch { /* swallow */ }
            this._blobWorkerUrl = null;
        }
        this._image = null;
        this._tiff = null;
        this._loaded = false;
        this._loading = false;
        this._worldPositions.length = 0;
        this._rawData = null;
        this._rawWidth = 0;
        this._rawHeight = 0;
        this._geoOrigin = null;
        this._geoResolution = null;
        this._geoNoData = null;
        this._imageWidth = 0;
        this._cornersCrs = null;  
        this._imageHeight = 0;
        this._colorRampNormalized = null;
        this._effectiveMin = null;
        this._effectiveMax = null;
        this._effectiveNoData = null;
        this._isHovered = false;
        this._isVisible = false;
        this._tileHeightsCache.clear(); this._rampLut32 = null; this._lonLatBounds = null;
    }

    protected _applyHidden() {
        if (this._group) this._group.visible = false;
    }

    protected _onAltitudeChanged() {
        if (this._isGlobe()) {
            // Глобус: высота меняет точки на эллипсоиде — пересобираем меш.
            if (this._loaded && this._mesh) {
                this._computeWorldCorners(this._image);
                this._buildMesh();
            }
            return;
        }
        if (this._group) this._group.position.y = this._altitude;
        this._centroidWorld.y = this._altitude;
    }

    protected _onTooltipChanged() { this._registerInteraction(); }

    _update(map) {
        if (!this._loaded) return;
        this._applyZoomInterpolations(map.continuousZoom);

        if (this._mergedIntoMap) {
            // Меша нет — рендерит тайловый слой. Здесь только:
            //  1) синхронизируем opacity (может поменяться интерполяцией);
            //  2) обновляем видимость для подписи.
            this._syncOverlayOpacity();

            if (!this._isWithinView()) {
                this._isVisible = false;
            } else {
                this._isVisible = true;
            }
            return;
        }

        if (!this._group) return;

        if (!this._isWithinView()) {
            this._applyHidden();
            this._isVisible = false;
            return;
        }

        if (this._boundingSphereRadius > 0) {
            const maxDist = map.maxObjectDistance;
            if (maxDist !== Infinity) {
                const worldCenter = this._tempVec3
                    .copy(this._group.position)
                    .add(map.worldGroup.position);
                const dist = map.camera.position.distanceTo(worldCenter);
                if (dist - this._boundingSphereRadius > maxDist) {
                    this._applyHidden();
                    this._isVisible = false;
                    return;
                }
            }
        }
if (this._material) {
            applyGapMaskToMaterial(this._material, map);
        }
if (this._maskEnabled && map.worldGroup) {
            this._maskOffsetUniform.value.copy(map.worldGroup.position);
        }
        // Глобус: группа стоит на эллипсоиде центром растра; «вверх» группы —
        // местная нормаль. Меш уже в мировых осях относительно центроида, поэтому
        // группу ориентировать не нужно: кривизна уже заложена в вершинах.
        if (this._isGlobe() && !this._mesh) { this._applyHidden(); this._isVisible = false; return; }

        // Глобус: растр скрываем, только если за горизонтом ВСЁ изображение.
        // Проверка одного центра давала пропадание большого растра на крупных
        // зумах, когда центр уходит за край, а его часть остаётся видимой.
        if (this._isGlobe() && typeof map.isWorldPointOccluded === 'function') {
            if (!this._anyPointVisibleOnGlobe(map)) {
                this._applyHidden();
                this._isVisible = false;
                return;
            }
        }

        this._group.visible = true;
        this._isVisible = true;
    }

    /**
     * Глобус: видна ли хотя бы одна точка растра (углы, середины сторон, центр).
     * Сэмплы — в мировых координатах (worldGroup + локальные вершины группы).
     */
    _anyPointVisibleOnGlobe(map) {
        const wg = map.worldGroup.position;
        // _worldPositions — точки эллипсоида в координатах worldGroup
        // (до вычитания центроида), поэтому сдвиг группы НЕ добавляем.
        const samples = [];
        const w = this._worldPositions;
        if (w && w.length >= 4) {
            const cornerIdx = [0, 1, 3, 2];
            for (const k of cornerIdx) samples.push(w[k]);
            // Середины сторон — ловят видимый край между углами.
            samples.push(w[0].clone().lerp(w[1], 0.5), w[1].clone().lerp(w[3], 0.5),
                         w[3].clone().lerp(w[2], 0.5), w[2].clone().lerp(w[0], 0.5));
        }
        samples.push(this._centroidWorld.clone()); // центр растра
        const tmp = this._tempVec3;
        for (const s of samples) {
            tmp.copy(s).add(wg);
            if (!map.isWorldPointOccluded(tmp)) return true;
        }
        return false;
    }

    getLabelType() { return 'geotiff'; }

    /* ==== Merge-mode helpers ==== */

    _syncOverlayOpacity() {
        if (!this._map || !this._map._tileManagers) return;
        const v = this._opacity;
        for (const mgr of this._map._tileManagers) {
            if (mgr && typeof mgr.setOverlayOpacity === 'function') {
                mgr.setOverlayOpacity(v);
            }
        }
    }

    _refreshTerrainTiles() {
        if (!this._map || !this._map._tileManagers) return;
        for (const mgr of this._map._tileManagers) {
            if (mgr && typeof mgr._disposeAllTiles === 'function') {
                mgr._disposeAllTiles();
            }
        }
        if (typeof this._map.maybeUpdateVisibleTiles === 'function') {
            this._map.maybeUpdateVisibleTiles(true);
        }
    }

    /* ==== Loading ==== */

    async _load() {
        if (this._loadPromise) return this._loadPromise;
        this._loading = true;
        this._progress(0);
        this._loadPromise = this._performLoad();
        try { await this._loadPromise; }
        finally { this._loading = false; this._loadPromise = null; }
    }

    async _performLoad() {
        try {
            await this._ensurePool();
            const tiff = await this._openTiff();
            this._tiff = tiff;
            const image = await tiff.getImage();
            this._image = image;
            this._crs = this._resolveCrs(image);
            const { texture } = await this._readAsTexture(image);
            this._texture = texture;
            this._progress(0.9);

            if (!this._map) return;

            this._computeWorldCorners(image);
            this._computeCentroid();

            // Решение: рисовать отдельный меш или слиться в тайлы?
            // Решаем ДО setElevationProvider — иначе не сможем откатиться.
            const canMerge = this._asElevation
                && this._mergeIntoTiles
                && this.isElevationProvider();

            if (canMerge) {
                // Меш не строим. Позицию группы всё равно ставим — она нужна
                // для getScreenPosition (подпись).
                this._group.position.copy(this._centroidWorld);
                this._mergedIntoMap = true;
            } else {
                if (this.mask && !this._maskEnabled) {
            this._rebuildAndApplyMask();
        }
                this._buildMesh();
                this._map.worldGroup.add(this._group);
                this._mergedIntoMap = false;
            }

            if (this._title && this._map.textManager) {
                this._textLabel = this._map.textManager.addLabel(this);
            }
            this._registerInteraction();

            if (this._asElevation) this._map.setElevationProvider(this);

            this._loaded = true;
            this._progress(1);
            if (this._onLoad) {
                try { this._onLoad(this); } catch (e) { console.warn(e); }
            }
        } catch (err) {
            console.error('GeoTiffLayer: load failed', err);
            if (this._onError) {
                try { this._onError(err); } catch (e) { console.warn(e); }
            }
        }
    }

    async _ensurePool() {
        if (this._pool) return;
        if (!this._useWorker) return;
        try {
            const resp = await fetch(this._workerUrl, { mode: 'cors' });
            if (!resp.ok) throw new Error(`worker fetch failed: ${resp.status}`);
            const code = await resp.text();
            const trimmed = code.trimStart();
            if (trimmed.startsWith('<!DOCTYPE') || trimmed.startsWith('<html')) {
                throw new Error('worker URL returned HTML');
            }
            const blob = new Blob([code], { type: 'application/javascript' });
            const blobUrl = URL.createObjectURL(blob);
            this._pool = new Pool(this._poolSize, () => new Worker(blobUrl));
            this._ownsPool = true;
            this._blobWorkerUrl = blobUrl;
        } catch (e) {
            console.warn('GeoTiffLayer: pool creation failed, decoding in main thread', e);
            if (this._blobWorkerUrl) {
                try { URL.revokeObjectURL(this._blobWorkerUrl); } catch { /* swallow */ }
                this._blobWorkerUrl = null;
            }
            this._pool = null;
            this._ownsPool = false;
        }
    }

async _openTiff() {
    const src = this._source;

    if (typeof src === 'string' || src instanceof URL) {
        const url = src.toString();
        const resp = await fetch(url, { mode: 'cors' });
        if (!resp.ok) {
            throw new Error(`GeoTIFF fetch failed: ${resp.status} ${resp.statusText}`);
        }
        const buf = await resp.arrayBuffer();

        // Санити-чек: magic bytes TIFF
        if (buf.byteLength < 8) {
            throw new Error(`GeoTIFF: file too small (${buf.byteLength} bytes)`);
        }
        const view = new DataView(buf);
        const b0 = view.getUint8(0);
        const b1 = view.getUint8(1);
        const isLE = b0 === 0x49 && b1 === 0x49;   // 'II'
        const isBE = b0 === 0x4D && b1 === 0x4D;   // 'MM'
        if (!isLE && !isBE) {
            throw new Error(
                `GeoTIFF: invalid magic bytes 0x${b0.toString(16)} 0x${b1.toString(16)} — ` +
                `file is not a TIFF (or download was corrupted)`
            );
        }
        const version = isLE ? view.getUint16(2, true) : view.getUint16(2, false);
        if (version !== 42 && version !== 43) {
            throw new Error(`GeoTIFF: unexpected TIFF version ${version} (expected 42 or 43)`);
        }
        if (version === 43) {
            console.warn(
                'GeoTIFF: BigTIFF (version 43) detected — ' +
                'поддержка зависит от сборки geotiff.js, могут быть ошибки'
            );
        }

        return await fromArrayBuffer(buf, { pool: this._pool || undefined });
    }

    if (src instanceof ArrayBuffer) return await fromArrayBuffer(src);
    if (ArrayBuffer.isView(src)) {
        const buf = src.buffer.slice(src.byteOffset, src.byteOffset + src.byteLength);
        return await fromArrayBuffer(buf);
    }
    if (typeof Blob !== 'undefined' && src instanceof Blob) {
        return await fromArrayBuffer(await src.arrayBuffer());
    }
    throw new Error('GeoTiffLayer: unsupported source type');
}

    _resolveCrs(image) {
        if (this._crsCode) return Projections.get(this._crsCode);
        let geoKeys = null;
        try { geoKeys = image.getGeoKeys(); } catch { /* ignore */ }
        const tryCode = (code) => {
            try { return Projections.get(code); }
            catch { console.warn(`GeoTiffLayer: projection ${code} unavailable`); return null; }
        };
        if (geoKeys) {
            if (geoKeys.ProjectedCSTypeGeoKey) {
                const p = tryCode(`EPSG:${geoKeys.ProjectedCSTypeGeoKey}`);
                if (p) return p;
            }
            if (geoKeys.GeographicTypeGeoKey) {
                const p = tryCode(`EPSG:${geoKeys.GeographicTypeGeoKey}`);
                if (p) return p;
            }
        }
        console.warn('GeoTiffLayer: CRS unknown, using EPSG:4326');
        return Projections.get('EPSG:4326');
    }

    async _readAsTexture(image) {
        const width = image.getWidth();
        const height = image.getHeight();
        if (this._isRampImage(image)) {
            return await this._readAsRampTexture(image, width, height);
        }
        const readOpts = {};
        if (this._pool) readOpts.pool = this._pool;
        const rgb = await image.readRGB(readOpts);
        const rgba = new Uint8Array(width * height * 4);
        for (let i = 0, j = 0; j < rgba.length; i += 3, j += 4) {
            rgba[j] = rgb[i]; rgba[j + 1] = rgb[i + 1]; rgba[j + 2] = rgb[i + 2]; rgba[j + 3] = 255;
        }
        return { texture: this._makeDataTexture(rgba, width, height), width, height };
    }

    _isRampImage(image) {
        const photometric = image.fileDirectory?.PhotometricInterpretation;
        if (photometric === 2 || photometric === 3) {
            if (this._asElevation || this._colorRampInput !== undefined) {
                console.warn('GeoTiffLayer: color image, ramp/elevation ignored');
            }
            return false;
        }
        const samples = typeof image.getSamplesPerPixel === 'function'
            ? image.getSamplesPerPixel()
            : (image.fileDirectory?.SamplesPerPixel ?? 1);
        if (samples !== 1) {
            if (this._asElevation || this._colorRampInput !== undefined) {
                console.warn(`GeoTiffLayer: multi-channel image (spp=${samples}), ramp/elevation ignored`);
            }
            return false;
        }
        if (this._colorRampInput !== undefined) return true;
        if (this._asElevation) return true;
        const bitsRaw = typeof image.getBitsPerSample === 'function'
            ? image.getBitsPerSample()
            : (image.fileDirectory?.BitsPerSample);
        const bits = Array.isArray(bitsRaw) ? bitsRaw[0] : bitsRaw;
        const fmtRaw = typeof image.getSampleFormat === 'function'
            ? image.getSampleFormat()
            : (image.fileDirectory?.SampleFormat);
        const fmt = Array.isArray(fmtRaw) ? fmtRaw[0] : fmtRaw;
        if (fmt === 3) return true;
        if (Number.isFinite(bits) && bits > 8) return true;
        return false;
    }

    async _readAsRampTexture(image, width, height) {
        let noData = this._noDataValue;
        if (noData === null) {
            try {
                if (typeof image.getGDALNoData === 'function') {
                    const gdalNd = image.getGDALNoData();
                    if (gdalNd != null) noData = gdalNd;
                }
            } catch { /* ignore */ }
        }

        let data = this._rawData;
        if (!data) {
            const readOpts = { samples: [0] };
            if (this._pool) readOpts.pool = this._pool;
            const rasters = await image.readRasters(readOpts);
            data = rasters[0];
            if (!data) throw new Error('GeoTiffLayer: readRasters empty');

            if (this._keepRawData) {
                this._rawData = data;
                this._rawWidth = width;
                this._rawHeight = height;
                this._geoNoData = noData;
                try {
                    this._geoOrigin = image.getOrigin();
                    this._geoResolution = image.getResolution();
                } catch (e) {
                    console.warn('GeoTiffLayer: origin/resolution unavailable', e);
                    this._geoOrigin = null;
                    this._geoResolution = null;
                }
            }
        }

        let minV = this._minValue;
        let maxV = this._maxValue;
        if (minV === null || maxV === null) {
            let autoMin = Infinity, autoMax = -Infinity;
            for (let i = 0; i < data.length; i++) {
                const v = data[i];
                if (!Number.isFinite(v)) continue;
                if (noData !== null && v === noData) continue;
                if (v < autoMin) autoMin = v;
                if (v > autoMax) autoMax = v;
            }
            if (minV === null) minV = autoMin === Infinity ? 0 : autoMin;
            if (maxV === null) maxV = autoMax === -Infinity ? 1 : autoMax;
        }
        if (!Number.isFinite(minV) || !Number.isFinite(maxV)) { minV = 0; maxV = 1; }
        if (minV === maxV) maxV = minV + 1;

         this._effectiveMin = minV;
        this._effectiveMax = maxV;
        this._effectiveNoData = noData;

        this._rampLut32 = null;
        this._computeLonLatBounds();

        if (this._asElevation && this._mergeIntoTiles && this.isElevationProvider()) {
            return { texture: null, width, height };
        }

        const ramp = this._getColorRamp();
        const ndColor = this._parseNoDataColor(this._noDataColor);
        const range = maxV - minV;
        const rgba = new Uint8Array(width * height * 4);

        for (let i = 0; i < data.length; i++) {
            const v = data[i];
            const j = i * 4;
            if (!Number.isFinite(v) || (noData !== null && v === noData)) {
                if (ndColor) {
                    rgba[j] = ndColor[0]; rgba[j + 1] = ndColor[1];
                    rgba[j + 2] = ndColor[2]; rgba[j + 3] = ndColor[3];
                }
                continue;
            }
            let t = (v - minV) / range;
            if (t < 0) t = 0; else if (t > 1) t = 1;
            const c = sampleColorRamp(ramp, t);
            rgba[j] = c[0]; rgba[j + 1] = c[1]; rgba[j + 2] = c[2]; rgba[j + 3] = c[3];
        }
        return { texture: this._makeDataTexture(rgba, width, height), width, height };
    }

    _makeDataTexture(rgba, width, height) {
        const texture = new THREE.DataTexture(rgba, width, height, THREE.RGBAFormat);
        texture.flipY = true;
        texture.colorSpace = THREE.SRGBColorSpace;
        texture.minFilter = THREE.LinearFilter;
        texture.magFilter = THREE.LinearFilter;
        texture.generateMipmaps = false;
        texture.needsUpdate = true;
        return texture;
    }

    _getColorRamp() {
        if (this._colorRampNormalized) return this._colorRampNormalized;
        this._colorRampNormalized = resolveColorRamp(this._colorRampInput);
        return this._colorRampNormalized;
    }

    _parseNoDataColor(c) {
        if (c === null || c === undefined) return null;
        if (typeof c === 'string' && c.toLowerCase() === 'transparent') return null;
        const rgba = parseColorToRGBA(c);
        return [rgba.r, rgba.g, rgba.b, rgba.a];
    }

        /** Приводит долготу lon к диапазону [ox, ox + W*rx], если растр в географической СК (напр. 0..360). */
    _normalizeLonForRaster(lon) {
        if (!this._crs?.isGeographic || !this._geoOrigin || !this._geoResolution) return lon;
        const ox = this._geoOrigin[0];
        const rx = this._geoResolution[0];
        const minX = Math.min(ox, ox + this._rawWidth * rx);
        const maxX = Math.max(ox, ox + this._rawWidth * rx);
        if (lon < minX && lon + 360 <= maxX + 1) return lon + 360;
        if (lon > maxX && lon - 360 >= minX - 1) return lon - 360;
        return lon;
    }

    _sampleAtLonLat(lon, lat) {
        if (!this._rawData || !this._geoOrigin || !this._geoResolution) return null;
        let xy;
        const code = this._crs?.code;
        if (code === 'EPSG:4326' || code === 'CRS:84') {
            xy = [this._normalizeLonForRaster(lon), lat];
        } else if (typeof this._crs?.fromLonLatSafe === 'function') {
            xy = this._crs.fromLonLatSafe([lon, lat]);
        } else if (typeof this._crs?.fromLonLat === 'function') {
            try { xy = this._crs.fromLonLat([lon, lat]); } catch { xy = null; }
        } else return null;

        if (!xy || !Number.isFinite(xy[0]) || !Number.isFinite(xy[1])) return null;
        const [ox, oy] = this._geoOrigin;
        const [rx, ry] = this._geoResolution;
        if (!rx || !ry) return null;
        const px = (xy[0] - ox) / rx;
        const py = (xy[1] - oy) / ry;
        if (px < 0 || py < 0 || px > this._rawWidth - 1 || py > this._rawHeight - 1) return null;
        return this._bilinearSample(px, py);
    }

    /** Вычисляет Lon/Lat BBox растра по контуру для быстрого отсечения тайлов. */
    _computeLonLatBounds() {
        if (!this._geoOrigin || !this._geoResolution || !this._crs) {
            this._lonLatBounds = null;
            return;
        }
        const [ox, oy] = this._geoOrigin;
        const [rx, ry] = this._geoResolution;
        const W = this._rawWidth, H = this._rawHeight;
        const crs = this._crs;
        const isGeo = crs.code === 'EPSG:4326' || crs.code === 'CRS:84';

        let minLon = Infinity, minLat = Infinity, maxLon = -Infinity, maxLat = -Infinity;
        const steps = 8;
        const samplePt = (u, v) => {
            const x = ox + u * W * rx;
            const y = oy + v * H * ry;
            let ll;
            if (isGeo) ll = [x, y];
            else if (typeof crs.toLonLat === 'function') {
                try { ll = crs.toLonLat([x, y]); } catch { ll = null; }
            }
            if (!ll || !Number.isFinite(ll[0]) || !Number.isFinite(ll[1])) return;
            if (ll[0] < minLon) minLon = ll[0];
            if (ll[0] > maxLon) maxLon = ll[0];
            if (ll[1] < minLat) minLat = ll[1];
            if (ll[1] > maxLat) maxLat = ll[1];
        };

        for (let i = 0; i <= steps; i++) {
            const t = i / steps;
            samplePt(t, 0); samplePt(t, 1);
            samplePt(0, t); samplePt(1, t);
        }

        if (Number.isFinite(minLon)) {
            // Небольшой запас на кривизну проекции
            const padLon = (maxLon - minLon) * 0.05 + 0.01;
            const padLat = (maxLat - minLat) * 0.05 + 0.01;
            this._lonLatBounds = [minLon - padLon, minLat - padLat, maxLon + padLon, maxLat + padLat];
        } else {
            this._lonLatBounds = null;
        }
    }

    /** Быстрая проверка пересечения тайла (z, srcX, y) с Lon/Lat BBox растра. */
    _tileIntersectsRaster(z, srcX, y) {
        const b = this._lonLatBounds;
        if (!b) return true;
        // Если растр пересекает антимеридиан, не отсекаем по lon
        const n = 1 << z;
        const tileMinLon = (srcX / n) * 360 - 180;
        const tileMaxLon = ((srcX + 1) / n) * 360 - 180;
        const tileMaxLat = Math.atan(Math.sinh(Math.PI * (1 - 2 * y / n))) * 180 / Math.PI;
        const tileMinLat = Math.atan(Math.sinh(Math.PI * (1 - 2 * (y + 1) / n))) * 180 / Math.PI;

        if (tileMaxLat < b[1] || tileMinLat > b[3]) return false;
        if (b[2] - b[0] < 180) {
            if (tileMaxLon < b[0] || tileMinLon > b[2]) return false;
        }
        return true;
    }

    /**
     * Строит опорную сетку (gridSteps + 1) x (gridSteps + 1) в пиксельных координатах
     * растра (gpx, gpy) для тайла (z, srcX, y).
     */
    _buildTilePixelGrid(z, srcX, y, gridSteps) {
        const g = gridSteps + 1;
        const count = g * g;
        const gpxGrid = new Float64Array(count);
        const gpyGrid = new Float64Array(count);

        const n = 1 << z;
        const crs = this._crs;
        const isGeo = crs.code === 'EPSG:4326' || crs.code === 'CRS:84';
        const hasSafe = typeof crs.fromLonLatSafe === 'function';
        const [ox, oy] = this._geoOrigin;
        const [rx, ry] = this._geoResolution;
        const invRx = 1 / rx, invRy = 1 / ry;
        const W = this._rawWidth, H = this._rawHeight;

        const ll = [0, 0];
        let minGpx = Infinity, maxGpx = -Infinity;
        let minGpy = Infinity, maxGpy = -Infinity;
        let validCount = 0;

        for (let r = 0; r < g; r++) {
            const v = r / gridSteps;
            const lat = Math.atan(Math.sinh(Math.PI * (1 - 2 * (y + v) / n))) * 180 / Math.PI;
            const rowOff = r * g;
            for (let c = 0; c < g; c++) {
                const u = c / gridSteps;
                const lon = ((srcX + u) / n) * 360 - 180;
                let xy;
                if (isGeo) {
                    xy = ll;
                    ll[0] = this._normalizeLonForRaster(lon);
                    ll[1] = lat;
                } else if (hasSafe) {
                    ll[0] = lon; ll[1] = lat;
                    xy = crs.fromLonLatSafe(ll);
                } else {
                    try { ll[0] = lon; ll[1] = lat; xy = crs.fromLonLat(ll); } catch { xy = null; }
                }

                const idx = rowOff + c;
                if (!xy || !Number.isFinite(xy[0]) || !Number.isFinite(xy[1])) {
                    gpxGrid[idx] = NaN;
                    gpyGrid[idx] = NaN;
                    continue;
                }
                const gpx = (xy[0] - ox) * invRx;
                const gpy = (xy[1] - oy) * invRy;
                gpxGrid[idx] = gpx;
                gpyGrid[idx] = gpy;
                if (gpx < minGpx) minGpx = gpx;
                if (gpx > maxGpx) maxGpx = gpx;
                if (gpy < minGpy) minGpy = gpy;
                if (gpy > maxGpy) maxGpy = gpy;
                validCount++;
            }
        }

        if (validCount === 0 || maxGpx < 0 || minGpx > W - 1 || maxGpy < 0 || minGpy > H - 1) {
            return null;
        }
        return { gpxGrid, gpyGrid, gridSteps };
    }

    /** Предрассчитанная таблица 1024 цветов в формате ABGR (Uint32 для ImageData). */
    _getRampLut32() {
        if (this._rampLut32) return this._rampLut32;
        const ramp = this._getColorRamp();
        const lut = new Uint32Array(1024);
        for (let i = 0; i < 1024; i++) {
            const c = sampleColorRamp(ramp, i / 1023);
            lut[i] = ((c[3] & 255) << 24) | ((c[2] & 255) << 16) | ((c[1] & 255) << 8) | (c[0] & 255);
        }
        this._rampLut32 = lut;
        return lut;
    }

    _computeTileHeightsEntry(z, virtX, y, segments) {
        if (!this.isElevationProvider()) return { heights: null, max: 0 };
        const n = 1 << z;
        const srcX = ((virtX % n) + n) % n;
        const key = `${z},${srcX},${y},${segments}`;

        if (this._tileHeightsCache.has(key)) {
            const entry = this._tileHeightsCache.get(key);
            this._tileHeightsCache.delete(key);
            this._tileHeightsCache.set(key, entry);
            return entry;
        }

        if (!this._tileIntersectsRaster(z, srcX, y)) {
            const empty = { heights: null, max: 0 };
            this._tileHeightsCache.set(key, empty);
            return empty;
        }

        const coarseSteps = Math.min(segments, 8);
        const coarse = this._buildTilePixelGrid(z, srcX, y, coarseSteps);
        if (!coarse) {
            const empty = { heights: null, max: 0 };
            this._tileHeightsCache.set(key, empty);
            return empty;
        }

        const { gpxGrid, gpyGrid } = coarse;
        const cg = coarseSteps + 1;
        const grid = segments + 1;
        const out = new Float32Array(grid * grid);
        const hs = this._elevationHeightScale;
        const W = this._rawWidth, H = this._rawHeight;

        let max = -Infinity;
        let hasAny = false;

        for (let row = 0; row < grid; row++) {
            const v = (row / segments) * coarseSteps;
            const cy = Math.min(coarseSteps - 1, v | 0);
            const fy = v - cy;
            const rowOut = row * grid;

            for (let col = 0; col < grid; col++) {
                const u = (col / segments) * coarseSteps;
                const cx = Math.min(coarseSteps - 1, u | 0);
                const fx = u - cx;

                const i00 = cy * cg + cx;
                const i10 = i00 + 1;
                const i01 = i00 + cg;
                const i11 = i01 + 1;

                const gpx = (gpxGrid[i00] + (gpxGrid[i10] - gpxGrid[i00]) * fx) * (1 - fy) +
                            (gpxGrid[i01] + (gpxGrid[i11] - gpxGrid[i01]) * fx) * fy;
                const gpy = (gpyGrid[i00] + (gpyGrid[i10] - gpyGrid[i00]) * fx) * (1 - fy) +
                            (gpyGrid[i01] + (gpyGrid[i11] - gpyGrid[i01]) * fx) * fy;

                if (gpx >= 0 && gpy >= 0 && gpx <= W - 1 && gpy <= H - 1) {
                    const val = this._bilinearSample(gpx, gpy);
                    if (val !== null && Number.isFinite(val)) {
                        const h = val * hs;
                        out[rowOut + col] = h;
                        if (h > max) max = h;
                        hasAny = true;
                    }
                }
            }
        }

        const entry = hasAny
            ? { heights: out, max: max === -Infinity ? 0 : max }
            : { heights: null, max: 0 };

        this._tileHeightsCache.set(key, entry);
        while (this._tileHeightsCache.size > TILE_TEXTURE_CACHE_MAX) {
            const oldest = this._tileHeightsCache.keys().next().value;
            this._tileHeightsCache.delete(oldest);
        }
        return entry;
    }

    getTileHeights(z, virtX, y, segments) {
        return this._computeTileHeightsEntry(z, virtX, y, segments).heights;
    }

    getTileMaxHeight(z, x, y, segments) {
        return this._computeTileHeightsEntry(z, x, y, segments).max;
    }

    getTileTexture(z, virtX, y, size = 256) {
        if (!this.isElevationProvider()) return null;
        if (this._effectiveMin === null || this._effectiveMax === null) return null;
        if (typeof document === 'undefined') return null;

        const n = 1 << z;
        const srcX = ((virtX % n) + n) % n;
        // Ограничиваем 256px — линейная фильтрация GPU даёт тот же результат в 4 раза быстрее, чем 512px
        const texSize = Math.min(256, size);
        const key = `${z},${srcX},${y},${texSize}`;

        if (this._tileTextureCache.has(key)) {
            const tex = this._tileTextureCache.get(key);
            this._tileTextureCache.delete(key);
            this._tileTextureCache.set(key, tex);
            return tex;
        }

        if (!this._tileIntersectsRaster(z, srcX, y)) {
            this._tileTextureCache.set(key, null);
            this._evictTileTextureCache();
            return null;
        }

        const coarseSteps = 8;
        const coarse = this._buildTilePixelGrid(z, srcX, y, coarseSteps);
        if (!coarse) {
            this._tileTextureCache.set(key, null);
            this._evictTileTextureCache();
            return null;
        }

        const { gpxGrid, gpyGrid } = coarse;
        const cg = coarseSteps + 1;
        const canvas = document.createElement('canvas');
        canvas.width = canvas.height = texSize;
        const ctx = canvas.getContext('2d');
        const imgData = ctx.createImageData(texSize, texSize);
        const out32 = new Uint32Array(imgData.data.buffer);

        const lut32 = this._getRampLut32();
        const minV = this._effectiveMin;
        const invRange = 1023 / (this._effectiveMax - minV);
        const nd = this._effectiveNoData;
        const ndColor = this._parseNoDataColor(this._noDataColor);
        const ndColor32 = ndColor
            ? (((ndColor[3] & 255) << 24) | ((ndColor[2] & 255) << 16) | ((ndColor[1] & 255) << 8) | (ndColor[0] & 255))
            : 0;
        const hasNdColor = !!ndColor;

        const W = this._rawWidth, H = this._rawHeight;
        const maxW = W - 1, maxH = H - 1;
        const d = this._rawData;
        const denom = texSize - 1;
        let hasPixels = false;

        // Разбиваем тайл на полосы по ячейкам опорной сетки 8x8:
        // внутри каждого сегмента (gpx, gpy) меняются линейно (простое сложение)
        for (let py = 0; py < texSize; py++) {
            const v = (py / denom) * coarseSteps;
            const cy = Math.min(coarseSteps - 1, v | 0);
            const fy = v - cy;
            const rowOff = py * texSize;

            for (let cx = 0; cx < coarseSteps; cx++) {
                const pxStart = Math.ceil((cx / coarseSteps) * denom);
                const pxEnd = cx === coarseSteps - 1 ? denom : Math.floor(((cx + 1) / coarseSteps) * denom);
                if (pxStart > pxEnd) continue;

                const i00 = cy * cg + cx;
                const i10 = i00 + 1;
                const i01 = i00 + cg;
                const i11 = i01 + 1;

                const gpxL = gpxGrid[i00] + (gpxGrid[i01] - gpxGrid[i00]) * fy;
                const gpxR = gpxGrid[i10] + (gpxGrid[i11] - gpxGrid[i10]) * fy;
                const gpyL = gpyGrid[i00] + (gpyGrid[i01] - gpyGrid[i00]) * fy;
                const gpyR = gpyGrid[i10] + (gpyGrid[i11] - gpyGrid[i10]) * fy;

                // Быстрый пропуск всего горизонтального сегмента, если он вне растра
                if ((gpxL < 0 && gpxR < 0) || (gpxL > maxW && gpxR > maxW) ||
                    (gpyL < 0 && gpyR < 0) || (gpyL > maxH && gpyR > maxH)) {
                    continue;
                }

                const invSpan = coarseSteps / denom;
                const fx0 = (pxStart / denom) * coarseSteps - cx;
                const dgpx = (gpxR - gpxL) * invSpan;
                const dgpy = (gpyR - gpyL) * invSpan;
                let gpx = gpxL + (gpxR - gpxL) * fx0;
                let gpy = gpyL + (gpyR - gpyL) * fx0;

                for (let px = pxStart; px <= pxEnd; px++, gpx += dgpx, gpy += dgpy) {
                    if (gpx < 0 || gpy < 0 || gpx > maxW || gpy > maxH) continue;

                    const x0 = gpx | 0, y0 = gpy | 0;
                    const x1 = x0 < maxW ? x0 + 1 : maxW;
                    const y1 = y0 < maxH ? y0 + 1 : maxH;
                    const fx = gpx - x0, fySample = gpy - y0;
                    const r0 = y0 * W, r1 = y1 * W;
                    const v00 = d[r0 + x0], v10 = d[r0 + x1];
                    const v01 = d[r1 + x0], v11 = d[r1 + x1];

                    let val;
                    if (v00 !== nd && v10 !== nd && v01 !== nd && v11 !== nd) {
                        val = (v00 + (v10 - v00) * fx) * (1 - fySample) +
                              (v01 + (v11 - v01) * fx) * fySample;
                        if (val !== val) val = this._bilinearSample(gpx, gpy); // fallback при NaN
                    } else {
                        val = this._bilinearSample(gpx, gpy);
                    }

                    if (val === null || val !== val || (nd !== null && val === nd)) {
                        if (hasNdColor) {
                            out32[rowOff + px] = ndColor32;
                            hasPixels = true;
                        }
                        continue;
                    }

                    let idx = ((val - minV) * invRange + 0.5) | 0;
                    if (idx < 0) idx = 0; else if (idx > 1023) idx = 1023;
                    out32[rowOff + px] = lut32[idx];
                    hasPixels = true;
                }
            }
        }

        if (!hasPixels) {
            this._tileTextureCache.set(key, null);
            this._evictTileTextureCache();
            return null;
        }

        ctx.putImageData(imgData, 0, 0);
        const tex = new THREE.CanvasTexture(canvas);
        tex.flipY = true;
        tex.colorSpace = THREE.SRGBColorSpace;
        tex.minFilter = THREE.LinearFilter;
        tex.magFilter = THREE.LinearFilter;
        tex.generateMipmaps = false;
        tex.needsUpdate = true;

        this._tileTextureCache.set(key, tex);
        this._evictTileTextureCache();
        return tex;
    }

    _bilinearSample(px, py) {
        const w = this._rawWidth, h = this._rawHeight, d = this._rawData, nd = this._geoNoData;
        const x0 = px | 0, y0 = py | 0;
        const x1 = x0 + 1 < w ? x0 + 1 : w - 1;
        const y1 = y0 + 1 < h ? y0 + 1 : h - 1;
        const fx = px - x0, fy = py - y0;
        const r0 = y0 * w, r1 = y1 * w;
        const v00 = d[r0 + x0], v10 = d[r0 + x1];
        const v01 = d[r1 + x0], v11 = d[r1 + x1];

        const ok00 = Number.isFinite(v00) && (nd === null || v00 !== nd);
        const ok10 = Number.isFinite(v10) && (nd === null || v10 !== nd);
        const ok01 = Number.isFinite(v01) && (nd === null || v01 !== nd);
        const ok11 = Number.isFinite(v11) && (nd === null || v11 !== nd);

        if (ok00 && ok10 && ok01 && ok11) {
            const a = v00 + (v10 - v00) * fx;
            const b = v01 + (v11 - v01) * fx;
            return a + (b - a) * fy;
        }
        let sum = 0, cnt = 0;
        if (ok00) { sum += v00; cnt++; }
        if (ok10) { sum += v10; cnt++; }
        if (ok01) { sum += v01; cnt++; }
        if (ok11) { sum += v11; cnt++; }
        return cnt > 0 ? sum / cnt : null;
    }

    /** Глобус: активен ли режим эллипсоида. */
    _isGlobe() {
        return this._map?.globe === true && !!this._map?.surface;
    }

    /**
     * Глобус: точка эллипсоида над координатой CRS растра на высоте `h`
     * (мировые оси). Возвращает локальную точку worldGroup (как у Image).
     */
    _projectCrsToSurface(x, yCrs, h, out) {
        const map = this._map;
        const crs = this._crs ?? map.inputCRS;
        const ll = crs && crs.toLonLat ? crs.toLonLat([x, yCrs]) : [x, yCrs];
        if (!ll || !Number.isFinite(ll[0]) || !Number.isFinite(ll[1])) return null;
        const p = map.projectSurfacePoint(ll, 'EPSG:4326', h, out);
        if (!p) return null;
        const wg = map.worldGroup ? map.worldGroup.position : { x: 0, y: 0, z: 0 };
        return out.clone().sub(new THREE.Vector3(wg.x, wg.y, wg.z));
    }

    /** Безопасное проецирование точки из CRS растра в world-координаты карты. */
    _projectCrsToWorld(x, yCrs) {
        let sx = x, sy = yCrs;
        if (this._crs?.isGeographic) {
            const maxLat = this._map?.projection?.maxLatDeg ?? 85.05112878;
            sy = Math.max(-maxLat, Math.min(maxLat, sy));
            // Поджимаем полупиксельные вылеты за ±180° (например, -180.125 .. +180.125)
            if (sx < -180 && sx >= -185) sx = -180;
            if (sx > 180 && sx <= 185) sx = 180;
        }
        const pt = this._map.project([sx, sy], this._crs);
        if (!pt || !Number.isFinite(pt[0]) || !Number.isFinite(pt[1])) {
            return null;
        }
        return pt;
    }

    _computeWorldCorners(image) {
        const width = image.getWidth(), height = image.getHeight();
        const origin = image.getOrigin(), resolution = image.getResolution();
        this._imageWidth = width;
        this._imageHeight = height;

        const ox = origin[0], oy = origin[1];
        const rx = resolution[0], ry = resolution[1];
        const cornersCrs = [
            [ox, oy],
            [ox + width * rx, oy],
            [ox, oy + height * ry],
            [ox + width * rx, oy + height * ry]
        ];
        this._cornersCrs = cornersCrs;
        const y = this._altitude;
        if (this._isGlobe()) {
            // Глобус: углы на эллипсоиде (высота = altitude над поверхностью).
            const tmp = new THREE.Vector3();
            this._worldPositions = cornersCrs.map(([x, yCrs]) => {
                const p = this._projectCrsToSurface(x, yCrs, y, tmp);
                return p ? p.clone() : new THREE.Vector3();
            });
            return;
        }
        this._worldPositions = cornersCrs.map(([x, yCrs]) => {
            const pt = this._projectCrsToWorld(x, yCrs);
            return pt ? new THREE.Vector3(pt[0], y, pt[1]) : new THREE.Vector3(0, y, 0);
        });
    }

    _computeCentroid() {
        const positions = this._worldPositions;
        this._centroidWorld.set(0, this._altitude, 0);
        if (positions.length < 4) return;

        if (this._isGlobe()) {
            // Глобус: центр растра — точка на эллипсоиде над центром bbox в CRS.
            const cs = this._cornersCrs;
            if (cs && cs.length >= 4) {
                const cx = (cs[0][0] + cs[3][0]) / 2;
                const cy = (cs[0][1] + cs[3][1]) / 2;
                const p = this._projectCrsToSurface(cx, cy, this._altitude, new THREE.Vector3());
                if (p) { this._centroidWorld.copy(p); return; }
            }
        }

        let count = 0;
        let sumX = 0, sumZ = 0;
        for (const p of positions) {
            if (Number.isFinite(p.x) && Number.isFinite(p.z)) {
                sumX += p.x;
                sumZ += p.z;
                count++;
            }
        }
        if (count > 0) {
            this._centroidWorld.set(sumX / count, this._altitude, sumZ / count);
        }
    }

    _autoMeshSegments() {
        const maxDim = Math.max(this._imageWidth || 512, this._imageHeight || 512);
        return Math.min(256, Math.max(64, Math.ceil(maxDim / 8)));
    }

    /** true, если прямые или шаг сетки в source-CRS деформируются в map-CRS. */
    _isWarpedProjection() {
        const mapProj = this._map?.projection;
        const srcCrs = this._crs;
        if (!mapProj || !srcCrs) return false;
        if (mapProj === srcCrs || mapProj.code === srcCrs.code) return false;
        const bothMerc = mapProj.isMercator && srcCrs.isMercator;
        const bothGeo  = mapProj.isGeographic && srcCrs.isGeographic;
        if (bothMerc || bothGeo) return false;
        return true;
    }

    _autoWarpSegments() {
        const corners = this._cornersCrs;
        if (!corners) return 16;
        let span = 60;
        try {
            if (this._crs?.isGeographic) {
                const dLon = Math.abs(corners[3][0] - corners[0][0]);
                const dLat = Math.abs(corners[3][1] - corners[0][1]);
                span = Math.max(dLon, dLat);
            } else {
                const c0 = this._crs.toLonLat(corners[0]);
                const c3 = this._crs.toLonLat(corners[3]);
                if (c0 && c3) {
                    const dLon = Math.abs(c3[0] - c0[0]);
                    const dLat = Math.abs(c3[1] - c0[1]);
                    span = Math.max(dLon, dLat);
                }
            }
        } catch { /* fallback */ }
        return Math.max(8, Math.min(180, Math.ceil(span / 2)));
    }

    _buildMesh() {
        const positions = this._worldPositions;
        if (positions.length < 4) return;

        this._disposeMesh();

        this._computeCentroid();
        const centroid = this._centroidWorld.clone();

        const canDrape = this._drape && this._rawData && this._geoOrigin
            && this._geoResolution && this._imageWidth > 0 && this._imageHeight > 0;

        const warped = this._isWarpedProjection();
        const segDrape = canDrape ? (this._meshSegments ?? this._autoMeshSegments()) : 1;
        const segWarp  = (warped && !canDrape)
            ? (this._warpSegments ?? this._autoWarpSegments())
            : 1;
        const seg = Math.max(segDrape, segWarp);
        const grid = seg + 1;

        const geometry = new THREE.PlaneGeometry(1, 1, seg, seg);
        const posAttr = geometry.attributes.position;

        if (seg === 1) {
            for (let i = 0; i < 4; i++) {
                const px = Number.isFinite(positions[i].x) ? positions[i].x - centroid.x : 0;
                const py = Number.isFinite(positions[i].y) ? positions[i].y - centroid.y : 0;
                const pz = Number.isFinite(positions[i].z) ? positions[i].z - centroid.z : 0;
                posAttr.setXYZ(i, px, py, pz);
            }
        } else {
            const hs = this._elevationHeightScale;
            const corners = this._cornersCrs;
            if (!corners || corners.length < 4) {
                for (let i = 0; i < 4; i++) {
                    const px = Number.isFinite(positions[i].x) ? positions[i].x - centroid.x : 0;
                    const py = Number.isFinite(positions[i].y) ? positions[i].y - centroid.y : 0;
                    const pz = Number.isFinite(positions[i].z) ? positions[i].z - centroid.z : 0;
                    posAttr.setXYZ(i, px, py, pz);
                }
            } else {
                const c0x = corners[0][0], c0y = corners[0][1];
                const spanX = corners[1][0] - c0x;
                const spanY = corners[2][1] - c0y;
                const W = this._imageWidth, H = this._imageHeight;
                const maxPx = W - 1, maxPy = H - 1;

                const count = grid * grid;
                const valid = new Uint8Array(count);
                let sumX = 0, sumZ = 0, nValid = 0;
                const globe = this._isGlobe();
                // Глобус: вершины в мировых осях (эллипсоид), центр — отдельно.
                const gVerts = globe ? new Array(count) : null;
                const gTmp = globe ? new THREE.Vector3() : null;

                for (let j = 0; j < grid; j++) {
                    const v = j / seg;
                    const srcY = c0y + v * spanY;
                    const py = canDrape ? Math.min(maxPy, v * H) : 0;
                    for (let i = 0; i < grid; i++) {
                        const idx = j * grid + i;
                        const u = i / seg;
                        const srcX = c0x + u * spanX;
                        let hgt = 0;
                        if (canDrape) {
                            const px = Math.min(maxPx, u * W);
                            hgt = this._bilinearSample(px, py);
                            if (hgt === null || !Number.isFinite(hgt)) hgt = 0;
                        }
                        if (globe) {
                            // Рельеф откладываем вдоль нормали эллипсоида (как altitude).
                            const p = this._projectCrsToSurface(srcX, srcY, this._altitude + hgt * hs, gTmp);
                            if (p) {
                                gVerts[idx] = p.clone();
                                valid[idx] = 1;
                            } else {
                                gVerts[idx] = null;
                            }
                            continue;
                        }
                        const yWorld = hgt * hs;
                        const pt = this._projectCrsToWorld(srcX, srcY);
                        if (pt) {
                            posAttr.setXYZ(idx, pt[0], yWorld, pt[1]);
                            valid[idx] = 1;
                            sumX += pt[0];
                            sumZ += pt[1];
                            nValid++;
                        } else {
                            posAttr.setXYZ(idx, 0, 0, 0);
                        }
                    }
                }

                if (globe) {
                    // Центр — средняя точка вершин; локальные координаты меша = вершина − центр.
                    let cx = 0, cy = 0, cz = 0, nv = 0;
                    for (let idx = 0; idx < count; idx++) {
                        const g = gVerts[idx];
                        if (!g) continue;
                        cx += g.x; cy += g.y; cz += g.z; nv++;
                    }
                    if (nv > 0) {
                        const cen = new THREE.Vector3(cx / nv, cy / nv, cz / nv);
                        centroid.copy(cen);
                        this._centroidWorld.copy(cen);
                    }
                    for (let idx = 0; idx < count; idx++) {
                        const g = gVerts[idx];
                        if (g) posAttr.setXYZ(idx, g.x - centroid.x, g.y - centroid.y, g.z - centroid.z);
                        else posAttr.setXYZ(idx, 0, 0, 0);
                    }
                }

                if (nValid > 0 && !globe) {
                    centroid.set(sumX / nValid, this._altitude, sumZ / nValid);
                    this._centroidWorld.copy(centroid);
                }

                if (!globe) {
                    for (let idx = 0; idx < count; idx++) {
                        if (valid[idx]) {
                            posAttr.setX(idx, posAttr.getX(idx) - centroid.x);
                            posAttr.setZ(idx, posAttr.getZ(idx) - centroid.z);
                        }
                    }
                }

                // Отсекаем треугольники, перепрыгивающие через разрывы лепестков
                // или антимеридиан (как в Tiles.ts -> _createDeformedTileMesh)
                const worldSize = this._map?.WORLD_SIZE || 40075016.68557849;
                const maxEdge2 = (0.22 * worldSize) ** 2;
                const outIndices = [];

                const d2 = (a, b) => {
                    const dx = posAttr.getX(a) - posAttr.getX(b);
                    const dz = posAttr.getZ(a) - posAttr.getZ(b);
                    return dx * dx + dz * dz;
                };

                const tryTri = (a, b, c) => {
                    if (!valid[a] || !valid[b] || !valid[c]) return;
                    // На глобусе отсечку по XZ-длине не применяем: её метрика плоская
                    // и ложно режет грани на сфере (разрывов лепестков там нет).
                    if (!globe && (d2(a, b) > maxEdge2 || d2(b, c) > maxEdge2 || d2(c, a) > maxEdge2)) return;
                    outIndices.push(a, b, c);
                };

                for (let iy = 0; iy < seg; iy++) {
                    for (let ix = 0; ix < seg; ix++) {
                        const a = ix + grid * iy;
                        const b = ix + grid * (iy + 1);
                        const c = ix + 1 + grid * (iy + 1);
                        const d = ix + 1 + grid * iy;
                        tryTri(a, b, d);
                        tryTri(b, c, d);
                    }
                }

                if (outIndices.length > 0) {
                    const IndexArr = count > 65535 ? Uint32Array : Uint16Array;
                    geometry.setIndex(new THREE.BufferAttribute(new IndexArr(outIndices), 1));
                }
            }
        }

        posAttr.needsUpdate = true;
        geometry.computeVertexNormals();
        geometry.computeBoundingSphere();

        const onTop = this._alwaysOnTop;
        const material = new THREE.MeshBasicMaterial({
            map: this._texture,
            side: THREE.DoubleSide,
            transparent: this._opacity < 1,
            opacity: this._opacity,
            blending: this._normalizeBlending(this._blending),
            depthTest: !onTop,
            depthWrite: false,
            polygonOffset: !onTop,
            polygonOffsetFactor: this._polygonOffset,
            polygonOffsetUnits: this._polygonOffset
        });

        // Применяем stencil-маску Graticule для лепестковых и ограниченных проекций
        applyGapMaskToMaterial(material, this._map);
        this._setupMaterialMask(material);

        const mesh = new THREE.Mesh(geometry, material);
        mesh.renderOrder = this._renderOrder;

        this._group.clear();
        this._group.add(mesh);
        this._group.position.copy(centroid);

        this._geometry = geometry;
        this._material = material;
        this._mesh = mesh;

        let maxRadiusSq = 0;
        const cnt = posAttr.count;
        for (let k = 0; k < cnt; k++) {
            const x = posAttr.getX(k), y = posAttr.getY(k), z = posAttr.getZ(k);
            const rSq = x * x + y * y + z * z;
            if (rSq > maxRadiusSq) maxRadiusSq = rSq;
        }
        this._boundingSphereRadius = Math.sqrt(maxRadiusSq);
    }

    _registerInteraction() {
        if (this._unregisterInteraction) {
            try { this._unregisterInteraction(); } catch { /* swallow */ }
            this._unregisterInteraction = null;
        }
        // В merge-режиме собственного меша нет — интерактив через overlay
        // не поддержан. Пользуйтесь getValueAtWorld.
        if (this._mergedIntoMap) return;

        const hasHandlers = this._onClick || this._onHover || this._tooltipText;
        if (!hasHandlers || !this._map?.interaction || !this._mesh) return;

        const layer = this;
        this._unregisterInteraction = this._map.interaction.register(this, {
            getMeshes: () => (layer._mesh ? [layer._mesh] : []),
            getBoundingSphere: () => {
                if (layer._boundingSphereRadius <= 0) return null;
                const center = layer._tempVec3
                    .copy(layer._group.position)
                    .add(layer._map.worldGroup.position)
                    .clone();
                return { center, radius: layer._boundingSphereRadius };
            },
            onHover: this._onHover ? (isHovered) => layer._onHover(isHovered, layer) : null,
            onClick: this._onClick ? (event) => layer._onClick(event, layer) : null,
            getTooltip: this._tooltipText ? () => layer._tooltipText : null,
            isVisible: () => layer._group.visible
        });
    }

    _progress(value) {
        if (!this._onProgress) return;
        try { this._onProgress(value); } catch { /* swallow */ }
    }

    _disposeMesh() {
        if (this._geometry) { this._geometry.dispose(); this._geometry = null; }
        if (this._material) { this._material.dispose(); this._material = null; }
        this._mesh = null;
    }

    _disposeGpu() {
        this._disposeMesh();
        if (this._texture) { this._texture.dispose(); this._texture = null; }
    }

    _normalizeBlending(blending) {
        if (typeof blending === 'number') return blending;
        switch (String(blending).toLowerCase()) {
            case 'additive': return THREE.AdditiveBlending;
            case 'multiply': return THREE.MultiplyBlending;
            case 'subtract': return THREE.SubtractiveBlending;
            default: return THREE.NormalBlending;
        }
    }

    /* ==== TextManager override ==== */

    getScreenPosition() {
        if (!this._isVisible || !this._map) return null;
        const worldPos = this._tempVec3
            .copy(this._centroidWorld)
            .add(this._map.worldGroup.position);
        const screenPos = worldPos.clone().project(this._map.camera);
        if (screenPos.z > 1 || Math.abs(screenPos.x) > 1 || Math.abs(screenPos.y) > 1) return null;
        const canvas = this._map.renderer.domElement;
        return {
            x: (screenPos.x * 0.5 + 0.5) * canvas.clientWidth,
            y: (-screenPos.y * 0.5 + 0.5) * canvas.clientHeight
        };
    }

    /* ==== Bounds ==== */

    getBounds(crs = 'EPSG:4326') {
        if (!this._image || !this._crs) return null;
        const dst = typeof crs === 'string' ? Projections.get(crs) : crs;
        if (!dst) return null;

        const width = this._image.getWidth(), height = this._image.getHeight();
        const origin = this._image.getOrigin(), resolution = this._image.getResolution();
        const ox = origin[0], oy = origin[1];
        const rx = resolution[0], ry = resolution[1];
        const corners = [
            [ox, oy],
            [ox + width * rx, oy],
            [ox, oy + height * ry],
            [ox + width * rx, oy + height * ry]
        ];

        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
        for (const [x, y] of corners) {
            let tx, ty;
            if (this._crs === dst || this._crs.code === dst.code) {
                tx = x; ty = y;
            } else {
                const lonLat = this._crs. isGeographic ? [x, y] : this._crs.toLonLat([x, y]);
                const clamped = dst.clampLonLat ? dst.clampLonLat(lonLat) : lonLat;
                const conv = dst.fromLonLat(clamped);
                tx = conv[0]; ty = conv[1];
            }
            if (!isFinite(tx) || !isFinite(ty)) continue;
            if (tx < minX) minX = tx;
            if (tx > maxX) maxX = tx;
            if (ty < minY) minY = ty;
            if (ty > maxY) maxY = ty;
        }
        if (!isFinite(minX)) return null;
        if (dst.isGeographic) {
            minX = Math.max(-180, minX);
            maxX = Math.min(180, maxX);
            minY = Math.max(-85.05112878, minY);
            maxY = Math.min(85.05112878, maxY);
        }
        return [[minX, minY], [maxX, maxY]];
    }



    
}