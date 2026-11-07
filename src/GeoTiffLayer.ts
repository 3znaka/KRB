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

/** @private */ const GEOTIFF_RENDER_ORDER = 995;
/** @private */ const DEFAULT_WORKER_URL = new URL('./js_TP/geotiff.worker.js', import.meta.url).href;
/** @private */ const DEFAULT_HEIGHT_SCALE = 1.0;
/** @private */ const DEFAULT_POLYGON_OFFSET = -4;

/**
 * Слой GeoTIFF-растра. Наследует SpatialObject (zoom bounds, видимость,
 * tooltip/onClick/onHover, подпись, altitude, zoomInterpolate, properties).
 *
 * @example
 * new GeoTiffLayer({ source: 'dem.tif', colorRamp: 'terrain', opacity: 0.8 }).addTo(map);
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

    /* ==== Style ==== */

    setOpacity(v) {
        this._opacity = Math.max(0, Math.min(1, v));
        if (this._material) {
            this._material.opacity = this._opacity;
            this._material.transparent = this._opacity < 1;
            this._material.needsUpdate = true;
        }
        return this;
    }
    getOpacity() { return this._opacity; }

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
        if (!Number.isFinite(v)) return this;
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
        if (this._loaded && this._mesh) this._buildMesh();
        return this;
    }
    getHeightScale() { return this._elevationHeightScale; }

    /* ==== Pixel values ==== */

    /** Значение пикселя по пиксельным координатам. Требует keepRawData: true. */
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

    /** Значение растра по lon/lat (сырое, без heightScale). */
    getValueAtLonLat(lon, lat) {
        if (!this._rawData) return null;
        const v = this._sampleAtLonLat(lon, lat);
        if (v === null || !Number.isFinite(v)) return null;
        if (this._geoNoData !== null && v === this._geoNoData) return null;
        return v;
    }

    /** Значение растра по world-координатам карты. */
    getValueAtWorld(worldX, worldZ, map) {
        const lonLat = map.unprojectToLonLat(worldX, worldZ);
        if (!lonLat) return null;
        return this.getValueAtLonLat(lonLat[0], lonLat[1]);
    }

    /** Pick по событию → { value, lonLat, pixel, point } или null. */
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
        if (this._loadPromise) {
            try { await this._loadPromise; } catch { /* handled */ }
        }
        if (!this._image || !this._isRampImage(this._image)) return;
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
    }

    /* ==== Elevation provider ==== */

    isElevationProvider() {
        return !!this._rawData && this._rawWidth > 0 && this._rawHeight > 0
            && !!this._geoOrigin && !!this._geoResolution;
    }

    getTileHeights(z, virtX, y, segments) {
        const grid = segments + 1;
        const out = new Float32Array(grid * grid);
        if (!this.isElevationProvider()) return out;

        const n = 1 << z;
        const nd = this._geoNoData;
        const hs = this._elevationHeightScale;

        for (let row = 0; row < grid; row++) {
            const v = row / segments;
            const lat = Math.atan(Math.sinh(Math.PI * (1 - 2 * (y + v) / n))) * 180 / Math.PI;
            for (let col = 0; col < grid; col++) {
                const u = col / segments;
                const lon = (virtX + u) / n * 360 - 180;
                const value = this._sampleAtLonLat(lon, lat);
                out[row * grid + col] = (value === null || value === nd || !Number.isFinite(value))
                    ? 0 : value * hs;
            }
        }
        return out;
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

    getTileMaxHeight(z, x, y, segments) {
        const heights = this.getTileHeights(z, x, y, segments);
        let max = -Infinity;
        for (let i = 0; i < heights.length; i++) if (heights[i] > max) max = heights[i];
        return max === -Infinity ? 0 : max;
    }

    get elevationMinZoom() { return 0; }
    get elevationMaxZoom() { return Infinity; }

    /* ==== SpatialObject hooks ==== */

    protected _onAttached(map) { /* scene setup happens in _performLoad */ }

    protected _teardown() {
        if (this._unregisterInteraction) {
            try { this._unregisterInteraction(); } catch { /* swallow */ }
            this._unregisterInteraction = null;
        }
        if (this._map?.elevationProvider === this) this._map.setElevationProvider(null);
        if (this._group.parent) this._group.parent.remove(this._group);
        this._disposeGpu();
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
        this._imageHeight = 0;
        this._colorRampNormalized = null;
        this._effectiveMin = null;
        this._effectiveMax = null;
        this._effectiveNoData = null;
        this._isHovered = false;
        this._isVisible = false;
    }

    protected _applyHidden() {
        if (this._group) this._group.visible = false;
    }

    protected _onAltitudeChanged() {
        if (this._group) this._group.position.y = this._altitude;
        this._centroidWorld.y = this._altitude;
    }

    protected _onTooltipChanged() { this._registerInteraction(); }

    _update(map) {
        if (!this._loaded || !this._group) return;
        this._applyZoomInterpolations(map.continuousZoom);

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
        this._group.visible = true;
        this._isVisible = true;
    }

    getLabelType() { return 'geotiff'; }

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
            this._buildMesh();
            this._map.worldGroup.add(this._group);

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
            return await fromUrl(src.toString(), { pool: this._pool || undefined });
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

    _sampleAtLonLat(lon, lat) {
        if (!this._rawData || !this._geoOrigin || !this._geoResolution) return null;

        let xy;
        const code = this._crs?.code;
        if (code === 'EPSG:4326' || code === 'CRS:84') xy = [lon, lat];
        else if (typeof this._crs?.fromLonLatSafe === 'function') xy = this._crs.fromLonLatSafe([lon, lat]);
        else if (typeof this._crs?.fromLonLat === 'function') {
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

    _bilinearSample(px, py) {
        const w = this._rawWidth, h = this._rawHeight, d = this._rawData, nd = this._geoNoData;
        const x0 = Math.floor(px), y0 = Math.floor(py);
        const x1 = Math.min(x0 + 1, w - 1), y1 = Math.min(y0 + 1, h - 1);
        const fx = px - x0, fy = py - y0;
        const v00 = d[y0 * w + x0], v10 = d[y0 * w + x1];
        const v01 = d[y1 * w + x0], v11 = d[y1 * w + x1];
        const valid = (v) => Number.isFinite(v) && (nd === null || v !== nd);

        if (valid(v00) && valid(v10) && valid(v01) && valid(v11)) {
            const a = v00 * (1 - fx) + v10 * fx;
            const b = v01 * (1 - fx) + v11 * fx;
            return a * (1 - fy) + b * fy;
        }
        let sum = 0, cnt = 0;
        if (valid(v00)) { sum += v00; cnt++; }
        if (valid(v10)) { sum += v10; cnt++; }
        if (valid(v01)) { sum += v01; cnt++; }
        if (valid(v11)) { sum += v11; cnt++; }
        return cnt > 0 ? sum / cnt : null;
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
        const map = this._map;
        const y = this._altitude;
        this._worldPositions = cornersCrs.map(([x, yCrs]) => {
            const [wx, wz] = map.project([x, yCrs], this._crs);
            return new THREE.Vector3(wx, y, wz);
        });
    }

    _autoMeshSegments() {
        const maxDim = Math.max(this._imageWidth || 512, this._imageHeight || 512);
        return Math.min(256, Math.max(64, Math.ceil(maxDim / 8)));
    }

    _buildMesh() {
        const positions = this._worldPositions;
        if (positions.length < 4) return;

        this._disposeMesh();

        const centroid = new THREE.Vector3();
        positions.forEach(p => centroid.add(p));
        centroid.divideScalar(positions.length);
        this._centroidWorld.copy(centroid);

        const canDrape = this._drape && this._rawData && this._geoOrigin
            && this._geoResolution && this._imageWidth > 0 && this._imageHeight > 0;
        const seg = canDrape ? (this._meshSegments ?? this._autoMeshSegments()) : 1;
        const grid = seg + 1;

        const geometry = new THREE.PlaneGeometry(1, 1, seg, seg);
        const posAttr = geometry.attributes.position;

        if (!canDrape) {
            for (let i = 0; i < 4; i++) {
                posAttr.setXYZ(i,
                    positions[i].x - centroid.x,
                    positions[i].y - centroid.y,
                    positions[i].z - centroid.z);
            }
        } else {
            const [ox, oy] = this._geoOrigin;
            const [rx, ry] = this._geoResolution;
            const W = this._imageWidth, H = this._imageHeight;
            const hs = this._elevationHeightScale;
            const map = this._map, crs = this._crs;
            const maxPx = W - 1, maxPy = H - 1;

            for (let j = 0; j < grid; j++) {
                const v = j / seg;
                const srcY = oy + v * H * ry;
                const py = Math.min(maxPy, v * H);
                for (let i = 0; i < grid; i++) {
                    const u = i / seg;
                    const srcX = ox + u * W * rx;
                    const px = Math.min(maxPx, u * W);
                    let hgt = this._bilinearSample(px, py);
                    if (hgt === null || !Number.isFinite(hgt)) hgt = 0;
                    const [wx, wz] = map.project([srcX, srcY], crs);
                    posAttr.setXYZ(j * grid + i,
                        wx - centroid.x,
                        hgt * hs,
                        wz - centroid.z);
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
        if (!this._isVisible || !this._group || !this._map) return null;
        const worldPos = this._tempVec3
            .copy(this._group.position)
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
            if (this._crs === dst) { tx = x; ty = y; }
            else {
                const lonLat = this._crs.toLonLat([x, y]);
                const conv = dst.fromLonLat(lonLat);
                tx = conv[0]; ty = conv[1];
            }
            if (!isFinite(tx) || !isFinite(ty)) continue;
            if (tx < minX) minX = tx;
            if (tx > maxX) maxX = tx;
            if (ty < minY) minY = ty;
            if (ty > maxY) maxY = ty;
        }
        if (!isFinite(minX)) return null;
        return [[minX, minY], [maxX, maxY]];
    }
}