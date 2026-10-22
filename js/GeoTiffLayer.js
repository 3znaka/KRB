/**
 * Модуль для отображения GeoTIFF-растров на карте.
 *
 * Поддерживает:
 *  - загрузку из URL, ArrayBuffer, Blob и URL-объекта;
 *  - автоопределение СК по GeoKeys с фолбэком на WGS84;
 *  - корректное размещение с учётом `ModelPixelScale` / `ModelTiepoint`;
 *  - чтение RGB/palette (8-бит) и одноканальных DEM (float / >8 бит);
 *  - произвольные палитры через {@link module:ColorRamps};
 *  - NoData (авто из GDAL_NODATA или явно);
 *  - Web Worker Pool для декодирования сжатых GeoTIFF;
 *  - интерактивность через `map.interaction`, подписи через `TextManager`;
 *  - `getBounds(crs)` для `map.fitTo(layer)`;
 *  - **режим источника высот** (`asElevation: true`);
 *  - **драпировку меша по рельефу** (`drape`, по умолчанию = `asElevation`).
 *
 * @module GeoTiffLayer
 */

import { THREE } from '../js_TP/tpb.js';
import { Projections } from './Projections.js';
import { Layer } from './Layers.js';
import { fromUrl, fromArrayBuffer, Pool } from '../js_TP/geotiff.bundle.js';
import {
    resolveColorRamp,
    sampleColorRamp,
    parseColorToRGBA
} from './ColorRamps.js';

/** @private */
const GEOTIFF_RENDER_ORDER = 995;

/** @private */
const DEFAULT_WORKER_URL = new URL('../js_TP/geotiff.worker.js', import.meta.url).href;

/** @private */
const DEFAULT_HEIGHT_SCALE = 1.0;

/** @private */
const DEFAULT_POLYGON_OFFSET = -4;

/**
 * Слой GeoTIFF-растра.
 *
 * @example
 * const tiff = new GeoTiffLayer({
 *     source: 'https://example.com/dem.tif',
 *     colorRamp: 'terrain',
 *     opacity: 0.8,
 *     onLoad: (layer) => map.fitTo(layer)
 * });
 * tiff.addTo(map);
 *
 * @example
 * // Раскрашенный DEM + физический рельеф тайлов одновременно:
 * new GeoTiffLayer({
 *     source: 'https://example.com/dem.tif',
 *     asElevation: true,
 *     colorRamp: 'terrain',
 *     opacity: 0.6,
 *     heightScale: 1.2
 * }).addTo(map);
 */
export class GeoTiffLayer extends Layer {
    /**
     * @param {Object} options
     * @param {string|URL|ArrayBuffer|ArrayBufferView|Blob} options.source
     * @param {string} [options.crs] — принудительный CRS растра.
     * @param {boolean} [options.useWorker=false]
     * @param {number} [options.poolSize=2]
     * @param {string} [options.workerUrl]
     * @param {Pool} [options.pool]
     * @param {number} [options.opacity=1]
     * @param {string|number} [options.blending='normal']
     * @param {number} [options.minZoom=-Infinity]
     * @param {number} [options.maxZoom=Infinity]
     * @param {number} [options.renderOrder=995]
     * @param {Function} [options.onProgress]
     * @param {Function} [options.onLoad]
     * @param {Function} [options.onError]
     * @param {boolean} [options.alwaysOnTop=false]
     * @param {number} [options.elevationOffset=0]
     * @param {number} [options.polygonOffset=-4]
     * @param {string|Array} [options.colorRamp]
     * @param {number|null} [options.minValue=null]
     * @param {number|null} [options.maxValue=null]
     * @param {number|null} [options.noDataValue=null]
     * @param {string|null} [options.noDataColor='transparent']
     * @param {boolean} [options.asElevation=false]
     * @param {number} [options.heightScale=1.0]
     * @param {boolean} [options.keepRawData=false]
     * @param {boolean} [options.drape] — драпировать меш по рельефу.
     *     По умолчанию = `asElevation`. Требует `_keepRawData` и геопривязки.
     * @param {number|null} [options.meshSegments] — сегментов сетки драпировки.
     *     null → авто: max(64, min(256, ceil(max(W,H)/8))).
     * @param {string} [options.title='']
     * @param {Object} [options.titleStyle]
     * @param {number} [options.titleMinZoom=-Infinity]
     * @param {number} [options.titleMaxZoom=Infinity]
     * @param {string} [options.titleAlign='center']
     * @param {Array.<number>} [options.titleOffset=[0,0]]
     * @param {boolean} [options.titleAllowOverflow=false]
     * @param {number} [options.titlePriority=0]
     * @param {string} [options.tooltip='']
     * @param {Function} [options.onClick]
     * @param {Function} [options.onHover]
     */
    constructor(options = {}) {
        super();

        if (!options.source) {
            throw new Error('GeoTiffLayer: options.source is required');
        }

        // --- Источник и СК ---
        /** @private */ this._source = options.source;
        /** @private @type {string|null} */ this._crsCode = options.crs ?? null;
        /** @private @type {import('./Projections.js').Projection|null} */ this._crs = null;

        // --- Внешний вид ---
        /** @private */ this._opacity = options.opacity ?? 1;
        /** @private */ this._blending = options.blending || 'normal';
        /** @private */ this._minZoom = options.minZoom ?? -Infinity;
        /** @private */ this._maxZoom = options.maxZoom ?? Infinity;
        /** @private */ this._renderOrder = options.renderOrder ?? GEOTIFF_RENDER_ORDER;

        // --- Z-fighting ---
        /** @private @type {boolean} */
        this._alwaysOnTop = options.alwaysOnTop === true;
        /** @private @type {number} */
        this._elevationOffset = Number.isFinite(options.elevationOffset)
            ? options.elevationOffset
            : 0;
        /** @private @type {number} */
        this._polygonOffset = Number.isFinite(options.polygonOffset)
            ? options.polygonOffset
            : DEFAULT_POLYGON_OFFSET;

        // --- Пул воркеров ---
        /** @private */ this._useWorker = options.useWorker === true;
        /** @private */ this._poolSize = options.poolSize ?? 2;
        /** @private */ this._workerUrl = options.workerUrl ?? DEFAULT_WORKER_URL;
        /** @private @type {Pool|null} */ this._pool = options.pool || null;
        /** @private */ this._ownsPool = false;
        /** @private @type {string|null} */ this._blobWorkerUrl = null;

        // --- Колбэки ---
        /** @private */ this._onProgress = options.onProgress || null;
        /** @private */ this._onLoad = options.onLoad || null;
        /** @private */ this._onError = options.onError || null;

        // --- Подпись ---
        /** @private */ this._title = options.title || '';
        /** @private */ this._titleStyle = options.titleStyle || {};
        /** @private */ this._titleMinZoom = options.titleMinZoom ?? -Infinity;
        /** @private */ this._titleMaxZoom = options.titleMaxZoom ?? Infinity;
        /** @private */ this._titleAlign = options.titleAlign || 'center';
        /** @private */ this._titleOffset = options.titleOffset || [0, 0];
        /** @private */ this._titleAllowOverflow = options.titleAllowOverflow || false;
        /** @private */ this._titlePriority = options.titlePriority ?? 0;

        // --- Интерактивность ---
        /** @private */ this._tooltipText = options.tooltip || '';
        /** @private */ this._onClick = options.onClick || null;
        /** @private */ this._onHover = options.onHover || null;
        /** @private */ this._isHovered = false;

        // --- Рамповый режим ---
        /** @private */ this._colorRampInput = options.colorRamp ?? undefined;
        /** @private @type {Array<{value:number,r:number,g:number,b:number,a:number}>|null} */
        this._colorRampNormalized = null;
        /** @private */ this._minValue = options.minValue ?? null;
        /** @private */ this._maxValue = options.maxValue ?? null;
        /** @private */ this._noDataValue = options.noDataValue ?? null;
        /** @private */ this._noDataColor = options.noDataColor !== undefined
            ? options.noDataColor
            : 'transparent';

        /** @private @type {number|null} */ this._effectiveMin = null;
        /** @private @type {number|null} */ this._effectiveMax = null;
        /** @private @type {number|null} */ this._effectiveNoData = null;

        // --- Источник высот ---
        /** @private @type {boolean} */
        this._asElevation = options.asElevation === true;
        /** @private @type {number} */
        this._elevationHeightScale = options.heightScale ?? DEFAULT_HEIGHT_SCALE;
        /** @private @type {boolean} */
        this._keepRawData = this._asElevation || options.keepRawData === true;

        /** @private @type {ArrayLike<number>|null} */ this._rawData = null;
        /** @private @type {number} */ this._rawWidth = 0;
        /** @private @type {number} */ this._rawHeight = 0;
        /** @private @type {[number, number]|null} */ this._geoOrigin = null;
        /** @private @type {[number, number]|null} */ this._geoResolution = null;
        /** @private @type {number|null} */ this._geoNoData = null;

        // --- Драпировка меша по рельефу ---
        /** @private @type {boolean} */
        this._drape = options.drape !== undefined
            ? options.drape === true
            : this._asElevation;
        /** @private @type {number|null} */
        this._meshSegments = (typeof options.meshSegments === 'number'
            && options.meshSegments > 0)
            ? Math.floor(options.meshSegments)
            : null;
        /** @private @type {number} */ this._imageWidth = 0;
        /** @private @type {number} */ this._imageHeight = 0;

        // --- Внутреннее состояние ---
        /** @private @type {THREE.Group} */ this._group = new THREE.Group();
        /** @private @type {THREE.Mesh|null} */ this._mesh = null;
        /** @private @type {THREE.BufferGeometry|null} */ this._geometry = null;
        /** @private @type {THREE.Material|null} */ this._material = null;
        /** @private @type {THREE.DataTexture|null} */ this._texture = null;
        /** @private */ this._textLabel = null;
        /** @private @type {import('../js_TP/geotiff.bundle.js').GeoTIFFImage|null} */ this._image = null;
        /** @private */ this._tiff = null;
        /** @private @type {THREE.Vector3[]} */ this._worldPositions = [];
        /** @private @type {THREE.Vector3} */ this._centroidWorld = new THREE.Vector3();
        /** @private @type {number} */ this._boundingSphereRadius = 0;
        /** @private @type {THREE.Vector3} */ this._tempVec3 = new THREE.Vector3();

        /** @private */ this._loaded = false;
        /** @private */ this._loading = false;
        /** @private */ this._isVisible = false;

        /** @private @type {(() => void)|null} */
        this._unregisterInteraction = null;
    }

    /* ================================================================
       Публичный API
       ================================================================ */

    /** @param {import('./Core.js').KrbMap} map @returns {GeoTiffLayer} */
    addTo(map) {
        if (this._map === map) return this;
        super.addTo(map);
        if (!this._loaded && !this._loading) {
            this._load();
        }
        return this;
    }

    removeFromMap() {
        if (this._unregisterInteraction) {
            try { this._unregisterInteraction(); } catch (e) { /* swallow */ }
            this._unregisterInteraction = null;
        }

        if (this._map?.tileManager?.elevationProvider === this) {
            this._map.tileManager.elevationProvider = null;
        }

        if (this._group && this._group.parent) {
            this._group.parent.remove(this._group);
        }

        this._disposeGpu();

        if (this._textLabel && this._map?.textManager) {
            this._map.textManager.removeLabel(this._textLabel);
            this._textLabel = null;
        }

        if (this._ownsPool && this._pool) {
            try { this._pool.destroy(); } catch (e) { /* swallow */ }
            this._pool = null;
            this._ownsPool = false;
        }

        if (this._blobWorkerUrl) {
            try { URL.revokeObjectURL(this._blobWorkerUrl); } catch (_) { /* swallow */ }
            this._blobWorkerUrl = null;
        }

        this._image = null;
        this._tiff = null;
        this._loaded = false;
        this._isVisible = false;
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

        super.removeFromMap();
    }

    /** @returns {boolean} */
    isLoaded() { return this._loaded; }

    /** @returns {boolean} */
    isLoading() { return this._loading; }

    /** @returns {import('../js_TP/geotiff.bundle.js').GeoTIFFImage|null} */
    getImage() { return this._image; }

    /** @returns {{min:number, max:number}|null} */
    getDataRange() {
        if (this._effectiveMin === null) return null;
        return { min: this._effectiveMin, max: this._effectiveMax };
    }

    /**
     * Меняет палитру и перестраивает текстуру на лету (только ramp-режим).
     * @param {string|Array} ramp
     * @returns {Promise<void>}
     */
    async setColorRamp(ramp) {
        this._colorRampInput = ramp;
        this._colorRampNormalized = null;

        if (!this._image) return;
        if (!this._isRampImage(this._image)) return;

        const { texture } = await this._readAsRampTexture(
            this._image, this._image.getWidth(), this._image.getHeight()
        );
        if (this._texture) this._texture.dispose();
        this._texture = texture;
        if (this._material) {
            this._material.map = texture;
            this._material.needsUpdate = true;
        }
    }

    /* ================================================================
       Провайдер высот
       ================================================================ */

    /** @returns {boolean} */
    isElevationProvider() {
        return !!this._rawData && this._rawWidth > 0 && this._rawHeight > 0;
    }

    /**
     * Возвращает высоты для сетки тайла (segments+1)², row-major от NW к SE,
     * уже умноженные на `heightScale`. Используется `TileManager`.
     *
     * @param {number} z @param {number} virtX @param {number} y @param {number} segments
     * @returns {Float32Array}
     */
    getTileHeights(z, virtX, y, segments) {
        const grid = segments + 1;
        const count = grid * grid;
        const out = new Float32Array(count);

        if (!this.isElevationProvider()) return out;

        const n = 1 << z;
        const nd = this._geoNoData;
        const hs = this._elevationHeightScale;

        for (let row = 0; row < grid; row++) {
            const v = row / segments;
            const tileY = y + v;
            const lat = Math.atan(
                Math.sinh(Math.PI * (1 - 2 * tileY / n))
            ) * 180 / Math.PI;

            for (let col = 0; col < grid; col++) {
                const u = col / segments;
                const tileX = virtX + u;
                const lon = tileX / n * 360 - 180;

                const value = this._sampleAtLonLat(lon, lat);
                out[row * grid + col] =
                    (value === null || value === nd || !Number.isFinite(value))
                        ? 0
                        : value * hs;
            }
        }
        return out;
    }

    /* ================================================================
       Загрузка
       ================================================================ */

    /** @private */
    async _load() {
        this._loading = true;
        this._progress(0);
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

            this._computeWorldCorners(image);
            this._buildMesh();

            this._map.worldGroup.add(this._group);

            if (this._title && this._map.textManager) {
                this._textLabel = this._map.textManager.addLabel(this);
            }

            this._registerInteraction();

            if (this._asElevation && typeof this._map.enableGeotiffElevation === 'function') {
                this._map.enableGeotiffElevation(this);
            }

            this._loaded = true;
            this._progress(1);
            if (this._onLoad) {
                try { this._onLoad(this); } catch (e) { console.warn(e); }
            }
        } catch (err) {
            console.error('GeoTiffLayer: ошибка загрузки', err);
            if (this._onError) {
                try { this._onError(err); } catch (e) { console.warn(e); }
            }
        } finally {
            this._loading = false;
        }
    }

    /** @private */
    async _ensurePool() {
        if (this._pool) return;
        if (!this._useWorker) return;

        try {
            const url = this._workerUrl;
            const resp = await fetch(url, { mode: 'cors' });
            if (!resp.ok) {
                throw new Error(`worker fetch failed: ${resp.status} ${resp.statusText}`);
            }
            const code = await resp.text();

            const trimmed = code.trimStart();
            if (trimmed.startsWith('<!DOCTYPE') || trimmed.startsWith('<html')) {
                throw new Error('worker URL вернул HTML вместо JavaScript');
            }

            const blob = new Blob([code], { type: 'application/javascript' });
            const blobUrl = URL.createObjectURL(blob);

            this._pool = new Pool(this._poolSize, () => new Worker(blobUrl));
            this._ownsPool = true;
            this._blobWorkerUrl = blobUrl;
        } catch (e) {
            console.warn(
                'GeoTiffLayer: не удалось создать Pool, декодирование в основном потоке',
                e
            );
            if (this._blobWorkerUrl) {
                try { URL.revokeObjectURL(this._blobWorkerUrl); } catch (_) { /* swallow */ }
                this._blobWorkerUrl = null;
            }
            this._pool = null;
            this._ownsPool = false;
        }
    }

    /** @private */
    async _openTiff() {
        const src = this._source;

        if (typeof src === 'string' || src instanceof URL) {
            return await fromUrl(src.toString(), { pool: this._pool || undefined });
        }
        if (src instanceof ArrayBuffer) {
            return await fromArrayBuffer(src);
        }
        if (ArrayBuffer.isView(src)) {
            const view = src;
            const buf = view.buffer.slice(view.byteOffset, view.byteOffset + view.byteLength);
            return await fromArrayBuffer(buf);
        }
        if (typeof Blob !== 'undefined' && src instanceof Blob) {
            const buf = await src.arrayBuffer();
            return await fromArrayBuffer(buf);
        }
        throw new Error('GeoTiffLayer: неподдерживаемый тип source');
    }

    /** @private */
    _resolveCrs(image) {
        if (this._crsCode) {
            return Projections.get(this._crsCode);
        }

        let geoKeys = null;
        try { geoKeys = image.getGeoKeys(); } catch (e) { /* ignore */ }

        const tryCode = (code) => {
            try { return Projections.get(code); }
            catch (e) {
                console.warn(`GeoTiffLayer: проекция ${code} недоступна в Projections, пропускаем`);
                return null;
            }
        };

        if (geoKeys) {
            if (geoKeys.ProjectedCSTypeGeoKey) {
                const proj = tryCode(`EPSG:${geoKeys.ProjectedCSTypeGeoKey}`);
                if (proj) return proj;
            }
            if (geoKeys.GeographicTypeGeoKey) {
                const proj = tryCode(`EPSG:${geoKeys.GeographicTypeGeoKey}`);
                if (proj) return proj;
            }
        }

        console.warn('GeoTiffLayer: не удалось определить CRS из GeoKeys, используем EPSG:4326');
        return Projections.get('EPSG:4326');
    }

    /** @private */
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
            rgba[j]     = rgb[i];
            rgba[j + 1] = rgb[i + 1];
            rgba[j + 2] = rgb[i + 2];
            rgba[j + 3] = 255;
        }

        return { texture: this._makeDataTexture(rgba, width, height), width, height };
    }

    /** @private */
    _isRampImage(image) {
        const photometric = image.fileDirectory?.PhotometricInterpretation;
        if (photometric === 2 || photometric === 3) {
            if (this._asElevation) {
                console.warn(
                    'GeoTiffLayer: asElevation проигнорирован — ' +
                    `изображение цветное/палитровое (PhotometricInterpretation=${photometric})`
                );
            } else if (this._colorRampInput !== undefined) {
                console.warn(
                    'GeoTiffLayer: colorRamp проигнорирован — изображение цветное/палитровое ' +
                    `(PhotometricInterpretation=${photometric})`
                );
            }
            return false;
        }

        const samples = typeof image.getSamplesPerPixel === 'function'
            ? image.getSamplesPerPixel()
            : (image.fileDirectory?.SamplesPerPixel ?? 1);

        if (samples !== 1) {
            if (this._asElevation) {
                console.warn(
                    'GeoTiffLayer: asElevation проигнорирован — ' +
                    `изображение многоканальное (samplesPerPixel=${samples})`
                );
            } else if (this._colorRampInput !== undefined) {
                console.warn(
                    `GeoTiffLayer: colorRamp проигнорирован — изображение многоканальное (samplesPerPixel=${samples})`
                );
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

    /* ================================================================
       Рамповый режим
       ================================================================ */

    /** @private */
    async _readAsRampTexture(image, width, height) {
        const readOpts = { samples: [0] };
        if (this._pool) readOpts.pool = this._pool;

        const rasters = await image.readRasters(readOpts);
        const data = rasters[0];
        if (!data) throw new Error('GeoTiffLayer: readRasters вернул пустой результат');

        let noData = this._noDataValue;
        if (noData === null) {
            try {
                if (typeof image.getGDALNoData === 'function') {
                    const gdalNd = image.getGDALNoData();
                    if (gdalNd !== null && gdalNd !== undefined) noData = gdalNd;
                }
            } catch (e) { /* ignore */ }
        }

        if (this._keepRawData) {
            this._rawData = data;
            this._rawWidth = width;
            this._rawHeight = height;
            this._geoNoData = noData;
            try {
                this._geoOrigin = image.getOrigin();
                this._geoResolution = image.getResolution();
            } catch (e) {
                console.warn('GeoTiffLayer: не удалось прочитать origin/resolution', e);
                this._geoOrigin = null;
                this._geoResolution = null;
                this._rawData = null;
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
        const n = data.length;
        for (let i = 0; i < n; i++) {
            const v = data[i];
            const j = i * 4;

            if (!Number.isFinite(v) || (noData !== null && v === noData)) {
                if (ndColor) {
                    rgba[j]     = ndColor[0];
                    rgba[j + 1] = ndColor[1];
                    rgba[j + 2] = ndColor[2];
                    rgba[j + 3] = ndColor[3];
                }
                continue;
            }

            let t = (v - minV) / range;
            if (t < 0) t = 0;
            else if (t > 1) t = 1;

            const c = sampleColorRamp(ramp, t);
            rgba[j]     = c[0];
            rgba[j + 1] = c[1];
            rgba[j + 2] = c[2];
            rgba[j + 3] = c[3];
        }

        return { texture: this._makeDataTexture(rgba, width, height), width, height };
    }

    /** @private */
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

    /** @private */
    _getColorRamp() {
        if (this._colorRampNormalized) return this._colorRampNormalized;
        this._colorRampNormalized = resolveColorRamp(this._colorRampInput);
        return this._colorRampNormalized;
    }

    /** @private */
    _parseNoDataColor(c) {
        if (c === null || c === undefined) return null;
        if (typeof c === 'string' && c.toLowerCase() === 'transparent') return null;
        const rgba = parseColorToRGBA(c);
        return [rgba.r, rgba.g, rgba.b, rgba.a];
    }

    /* ================================================================
       Сэмплирование сырых DEM-данных
       ================================================================ */

    /** @private */
    _sampleAtLonLat(lon, lat) {
        if (!this._rawData || !this._geoOrigin || !this._geoResolution) return null;

        let xy;
        const code = this._crs?.code;
        if (code === 'EPSG:4326' || code === 'CRS:84') {
            xy = [lon, lat];
        } else if (typeof this._crs?.fromLonLatSafe === 'function') {
            xy = this._crs.fromLonLatSafe([lon, lat]);
        } else if (typeof this._crs?.fromLonLat === 'function') {
            try { xy = this._crs.fromLonLat([lon, lat]); }
            catch (e) { xy = null; }
        } else {
            return null;
        }

        if (!xy || !Number.isFinite(xy[0]) || !Number.isFinite(xy[1])) return null;

        const [ox, oy] = this._geoOrigin;
        const [rx, ry] = this._geoResolution;
        if (!rx || !ry) return null;

        const px = (xy[0] - ox) / rx;
        const py = (xy[1] - oy) / ry;

        if (px < 0 || py < 0 || px > this._rawWidth - 1 || py > this._rawHeight - 1) {
            return null;
        }

        return this._bilinearSample(px, py);
    }

    /** @private */
    _bilinearSample(px, py) {
        const w = this._rawWidth;
        const h = this._rawHeight;
        const d = this._rawData;
        const nd = this._geoNoData;

        const x0 = Math.floor(px);
        const y0 = Math.floor(py);
        const x1 = Math.min(x0 + 1, w - 1);
        const y1 = Math.min(y0 + 1, h - 1);
        const fx = px - x0;
        const fy = py - y0;

        const v00 = d[y0 * w + x0];
        const v10 = d[y0 * w + x1];
        const v01 = d[y1 * w + x0];
        const v11 = d[y1 * w + x1];

        const isValid = (v) => Number.isFinite(v) && (nd === null || v !== nd);

        if (isValid(v00) && isValid(v10) && isValid(v01) && isValid(v11)) {
            const a = v00 * (1 - fx) + v10 * fx;
            const b = v01 * (1 - fx) + v11 * fx;
            return a * (1 - fy) + b * fy;
        }

        let sum = 0;
        let cnt = 0;
        if (isValid(v00)) { sum += v00; cnt++; }
        if (isValid(v10)) { sum += v10; cnt++; }
        if (isValid(v01)) { sum += v01; cnt++; }
        if (isValid(v11)) { sum += v11; cnt++; }
        return cnt > 0 ? sum / cnt : null;
    }

    /* ================================================================
       Геопривязка и геометрия
       ================================================================ */

    /** @private */
    _computeWorldCorners(image) {
        const width = image.getWidth();
        const height = image.getHeight();
        const origin = image.getOrigin();
        const resolution = image.getResolution();

        this._imageWidth = width;
        this._imageHeight = height;

        const ox = origin[0], oy = origin[1];
        const rx = resolution[0], ry = resolution[1];

        const cornersCrs = [
            [ox,               oy],
            [ox + width * rx,  oy],
            [ox,               oy + height * ry],
            [ox + width * rx,  oy + height * ry]
        ];

        const map = this._map;
        const y = this._elevationOffset;
        const positions = [];
        for (const [x, yCrs] of cornersCrs) {
            const [wx, wz] = map.project([x, yCrs], this._crs);
            positions.push(new THREE.Vector3(wx, y, wz));
        }
        this._worldPositions = positions;
    }

    /** @private */
    _autoMeshSegments() {
        const w = this._imageWidth  || 512;
        const h = this._imageHeight || 512;
        const maxDim = Math.max(w, h);
        return Math.min(256, Math.max(64, Math.ceil(maxDim / 8)));
    }

    /**
     * Строит геометрию меша. Если `drape` включён и есть сырые данные,
     * вершины сетки поднимаются по тем же высотам, что отдаются тайлам.
     * Иначе — плоский quad, как раньше.
     *
     * @private
     */
    _buildMesh() {
        const positions = this._worldPositions;
        if (positions.length < 4) return;

        const centroid = new THREE.Vector3();
        positions.forEach(p => centroid.add(p));
        centroid.divideScalar(positions.length);
        this._centroidWorld.copy(centroid);

        const canDrape = this._drape
            && this._rawData
            && this._geoOrigin
            && this._geoResolution
            && this._imageWidth > 0
            && this._imageHeight > 0;

        const seg  = canDrape ? (this._meshSegments ?? this._autoMeshSegments()) : 1;
        const grid = seg + 1;

        const geometry = new THREE.PlaneGeometry(1, 1, seg, seg);
        const posAttr  = geometry.attributes.position;

        if (!canDrape) {
            for (let i = 0; i < 4; i++) {
                posAttr.setXYZ(
                    i,
                    positions[i].x - centroid.x,
                    positions[i].y - centroid.y,
                    positions[i].z - centroid.z
                );
            }
        } else {
            const [ox, oy] = this._geoOrigin;
            const [rx, ry] = this._geoResolution;
            const W = this._imageWidth;
            const H = this._imageHeight;
            const hs = this._elevationHeightScale;
            const map = this._map;
            const crs = this._crs;
            const maxPx = W - 1;
            const maxPy = H - 1;

            for (let j = 0; j < grid; j++) {
                const v = j / seg;
                const srcY = oy + v * H * ry;
                const py   = Math.min(maxPy, v * H);

                for (let i = 0; i < grid; i++) {
                    const u = i / seg;
                    const srcX = ox + u * W * rx;
                    const px   = Math.min(maxPx, u * W);

                    let hgt = this._bilinearSample(px, py);
                    if (hgt === null || !Number.isFinite(hgt)) hgt = 0;

                    const [wx, wz] = map.project([srcX, srcY], crs);
                    const idx = j * grid + i;
                    posAttr.setXYZ(
                        idx,
                        wx - centroid.x,
                        hgt * hs,               // локальный Y; offset — в group.position.y
                        wz - centroid.z
                    );
                }
            }
        }

        posAttr.needsUpdate = true;
        geometry.computeVertexNormals();
        geometry.computeBoundingSphere();

        const transparent = this._opacity < 1;
        const onTop = this._alwaysOnTop;

        const material = new THREE.MeshBasicMaterial({
            map: this._texture,
            side: THREE.DoubleSide,
            transparent,
            opacity: this._opacity,
            blending: this._normalizeBlending(this._blending),
            depthTest:  !onTop,
            depthWrite: false,
            polygonOffset:       !onTop,
            polygonOffsetFactor: this._polygonOffset,
            polygonOffsetUnits:  this._polygonOffset
        });

        const mesh = new THREE.Mesh(geometry, material);
        mesh.renderOrder = this._renderOrder;

        this._group.clear();
        this._group.add(mesh);
        this._group.position.copy(centroid);

        this._geometry = geometry;
        this._material = material;
        this._mesh = mesh;

        // Bounding sphere — по фактическим вершинам.
        let maxRadiusSq = 0;
        const cnt = posAttr.count;
        for (let k = 0; k < cnt; k++) {
            const x = posAttr.getX(k);
            const y = posAttr.getY(k);
            const z = posAttr.getZ(k);
            const rSq = x * x + y * y + z * z;
            if (rSq > maxRadiusSq) maxRadiusSq = rSq;
        }
        this._boundingSphereRadius = Math.sqrt(maxRadiusSq);
    }

    /* ================================================================
       Интерактивность
       ================================================================ */

    /** @private */
    _registerInteraction() {
        const hasHandlers = this._onClick || this._onHover || this._tooltipText;
        if (!hasHandlers || !this._map.interaction || !this._mesh) return;

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
            onHover: this._onHover
                ? (isHovered) => layer._onHover(isHovered, layer)
                : null,
            onClick: this._onClick
                ? (event) => layer._onClick(event, layer)
                : null,
            getTooltip: this._tooltipText
                ? () => layer._tooltipText
                : null,
            isVisible: () => layer._group.visible
        });
    }

    /* ================================================================
       Апдейт / видимость
       ================================================================ */

    /** @private */
    _postUpdate(map) {
        if (!this._loaded || !this._group) return;

        const zoom = map.continuousZoom;

        if (!this.visible) {
            this._group.visible = false;
            this._isVisible = false;
            return;
        }
        if (zoom < this._minZoom || zoom > this._maxZoom) {
            this._group.visible = false;
            this._isVisible = false;
            return;
        }

        if (this._boundingSphereRadius > 0) {
            const maxDist = map.maxObjectDistance;
            if (maxDist !== Infinity) {
                const worldCenter = this._tempVec3
                    .copy(this._group.position)
                    .add(map.worldGroup.position);
                const distToCenter = map.camera.position.distanceTo(worldCenter);
                if (distToCenter - this._boundingSphereRadius > maxDist) {
                    this._group.visible = false;
                    this._isVisible = false;
                    return;
                }
            }
        }

        this._group.visible = true;
        this._isVisible = true;
    }

    /* ================================================================
       Внутренние утилиты
       ================================================================ */

    /** @private */
    _progress(value) {
        if (!this._onProgress) return;
        try { this._onProgress(value); } catch (e) { /* swallow */ }
    }

    /** @private */
    _disposeGpu() {
        if (this._geometry) { this._geometry.dispose(); this._geometry = null; }
        if (this._material) { this._material.dispose(); this._material = null; }
        if (this._texture) { this._texture.dispose(); this._texture = null; }
        this._mesh = null;
    }

    /** @private */
    _normalizeBlending(blending) {
        if (typeof blending === 'number') return blending;
        switch (String(blending).toLowerCase()) {
            case 'additive': return THREE.AdditiveBlending;
            case 'multiply': return THREE.MultiplyBlending;
            case 'subtract': return THREE.SubtractiveBlending;
            case 'normal':
            default:         return THREE.NormalBlending;
        }
    }

    /* ================================================================
       Интерфейс для TextManager
       ================================================================ */

    /** @returns {string} */ getText() { return this._title; }

    /** @returns {Object} */
    getTextStyle() {
        return Object.assign({
            fontFamily: 'sans-serif',
            color: '#333',
            fontSize: '12px',
            textAlign: this._titleAlign
        }, this._titleStyle);
    }

    /** @returns {{min:number, max:number}} */
    getTextZoomBounds() {
        return { min: this._titleMinZoom, max: this._titleMaxZoom };
    }

    /** @returns {string} */ getLabelType() { return 'geotiff'; }
    /** @returns {boolean} */ isVisible() { return this._isVisible; }

    /** @returns {{x:number, y:number}|null} */
    getScreenPosition() {
        if (!this._isVisible || !this._group) return null;
        const worldPos = this._tempVec3
            .copy(this._group.position)
            .add(this._map.worldGroup.position);
        const screenPos = worldPos.clone().project(this._map.camera);
        if (screenPos.z > 1 || Math.abs(screenPos.x) > 1 || Math.abs(screenPos.y) > 1) {
            return null;
        }
        const canvas = this._map.renderer.domElement;
        return {
            x: (screenPos.x * 0.5 + 0.5) * canvas.clientWidth,
            y: (-screenPos.y * 0.5 + 0.5) * canvas.clientHeight
        };
    }

    /** @returns {string} */ getTitleAlign() { return this._titleAlign; }
    /** @returns {Array.<number>} */ getTitleOffset() { return this._titleOffset; }
    /** @returns {string} */ getTitleVerticalAlign() { return 'center'; }
    /** @returns {boolean} */ getAllowOverflow() { return this._titleAllowOverflow; }
    /** @returns {number} */ getPriority() { return this._titlePriority; }

    /* ================================================================
       Интерфейс для KrbMap#fitTo / getBounds
       ================================================================ */

    /**
     * @param {string|import('./Projections.js').Projection} [crs='EPSG:4326']
     * @returns {Array.<Array.<number>>|null}
     */
    getBounds(crs = 'EPSG:4326') {
        if (!this._image || !this._crs) return null;

        const dst = typeof crs === 'string' ? Projections.get(crs) : crs;
        if (!dst) return null;

        const width = this._image.getWidth();
        const height = this._image.getHeight();
        const origin = this._image.getOrigin();
        const resolution = this._image.getResolution();
        const ox = origin[0], oy = origin[1];
        const rx = resolution[0], ry = resolution[1];

        const cornersCrs = [
            [ox,               oy],
            [ox + width * rx,  oy],
            [ox,               oy + height * ry],
            [ox + width * rx,  oy + height * ry]
        ];

        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
        for (const [x, y] of cornersCrs) {
            let tx, ty;
            if (this._crs === dst) {
                tx = x; ty = y;
            } else {
                const lonLat = this._crs.toLonLat([x, y]);
                const converted = dst.fromLonLat(lonLat);
                tx = converted[0]; ty = converted[1];
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