/**
 * Модуль для отображения GeoTIFF-растров на карте.
 *
 * Поддерживает:
 *  - загрузку из URL, ArrayBuffer, Blob и URL-объекта;
 *  - автоопределение СК по GeoKeys (`ProjectedCSTypeGeoKey` /
 *    `GeographicTypeGeoKey`) с фолбэком на `map.inputCRS` / WGS84;
 *  - корректное размещение с учётом `ModelPixelScale` / `ModelTiepoint`
 *    (используются методы `image.getOrigin()` / `getResolution()`);
 *  - чтение растра как RGB-текстуры через `image.readRGB()`;
 *  - опциональный Web Worker Pool (см. `geotiff.worker.js`) — сильно
 *    ускоряет декодирование сжатых GeoTIFF (LZW, Deflate);
 *  - события hover/click/tooltip через общий `map.interaction`;
 *  - подписи через `TextManager` (тот же интерфейс, что у `Image`);
 *  - `getBounds(crs)` для `map.fitTo(layer)`.
 *
 * Координаты внутри TIFF интерпретируются в его собственной СК (см. выше).
 * Для отображения все четыре угла растра проецируются в СК карты
 * (`map.projection`) и ложатся в плоскость через `THREE.PlaneGeometry` —
 * ровно так же, как это делает `Image` со своими `nodes`.
 *
 * @module GeoTiffLayer
 */

import { THREE } from '../js_TP/tpb.js';
import { Projections } from './Projections.js';
import { Layer } from './Layers.js';
import { fromUrl, fromArrayBuffer, Pool } from '../js_TP/geotiff.bundle.js';

/**
 * Приоритет рендера. Чуть выше, чем у тайлов, но ниже, чем у Image —
 * GeoTIFF обычно играет роль «подложки»/«снимка».
 * @private
 */
const GEOTIFF_RENDER_ORDER = 995;

/**
 * URL воркера по умолчанию. Рассчитывается относительно текущего модуля,
 * так что файл `geotiff.worker.js` должен лежать рядом с `tpb.js`.
 * @private
 */
const DEFAULT_WORKER_URL = new URL('../js_TP/geotiff.worker.js', import.meta.url).href;

/**
 * Слой GeoTIFF-растра.
 *
 * @example
 * const tiff = new GeoTiffLayer({
 *     source: 'https://example.com/dem.tif',
 *     useWorker: true,
 *     poolSize: 2,
 *     opacity: 1,
 *     onLoad: (layer) => console.log('loaded:', layer.getBounds()),
 *     onProgress: (p) => console.log(`progress: ${(p * 100).toFixed(0)}%`)
 * });
 * tiff.addTo(map);
 */
export class GeoTiffLayer extends Layer {
    /**
     * @param {Object} options
     * @param {string|URL|ArrayBuffer|ArrayBufferView|Blob} options.source -
     *     Источник данных. URL-строка или URL-объект — грузится по сети;
     *     ArrayBuffer / typed array / Blob — парсится in-memory.
     * @param {string} [options.crs] - Принудительно задать СК растра
     *     (например, 'EPSG:32637'). Если не указан — определяется
     *     автоматически по GeoKeys, с фолбэком на WGS84.
     * @param {boolean} [options.useWorker=false] - Использовать Web Worker
     *     Pool для декодирования. Требует наличия `geotiff.worker.js`
     *     рядом с бандлом. Для больших сжатых файлов — обязательно.
     * @param {number} [options.poolSize=2] - Число воркеров в пуле.
     * @param {string} [options.workerUrl] - Переопределить URL воркера
     *     (по умолчанию — `geotiff.worker.js` рядом с бандлом).
     * @param {Pool} [options.pool] - Готовый пул от пользователя.
     *     Если задан — `useWorker`/`poolSize`/`workerUrl` игнорируются.
     * @param {number} [options.opacity=1] - Прозрачность (0..1).
     * @param {string|THREE.Blending} [options.blending='normal'] - Режим
     *     смешивания: 'normal', 'additive', 'multiply', 'subtract'
     *     или константа THREE.Blending.
     * @param {number} [options.minZoom=-Infinity] - Минимальный зум видимости.
     * @param {number} [options.maxZoom=Infinity] - Максимальный зум видимости.
     * @param {number} [options.renderOrder=995] - Порядок рендера меша.
     * @param {Function} [options.onProgress] - Колбэк прогресса загрузки,
     *     получает число 0..1 (грубая оценка — download + decode).
     * @param {Function} [options.onLoad] - Колбэк успешной загрузки,
     *     получает экземпляр слоя.
     * @param {Function} [options.onError] - Колбэк ошибки, получает Error.
     *
     * @param {string} [options.title=''] - Текст подписи.
     * @param {Object} [options.titleStyle] - CSS-стили подписи.
     * @param {number} [options.titleMinZoom=-Infinity] - Мин. зум подписи.
     * @param {number} [options.titleMaxZoom=Infinity] - Макс. зум подписи.
     * @param {string} [options.titleAlign='center'] - Выравнивание подписи.
     * @param {Array.<number>} [options.titleOffset=[0,0]] - Смещение подписи (px).
     * @param {boolean} [options.titleAllowOverflow=false] - Разрешить выход
     *     подписи за границы экрана.
     * @param {number} [options.titlePriority=0] - Приоритет подписи.
     *
     * @param {string} [options.tooltip=''] - HTML тултипа (через PopupManager).
     * @param {Function} [options.onClick] - Обработчик клика (event, layer).
     * @param {Function} [options.onHover] - Обработчик наведения (isHovered).
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

        // --- Пул воркеров ---
        /** @private */ this._useWorker = options.useWorker === true;
        /** @private */ this._poolSize = options.poolSize ?? 2;
        /** @private */ this._workerUrl = options.workerUrl ?? DEFAULT_WORKER_URL;
        /** @private @type {Pool|null} */ this._pool = options.pool || null;
        /** @private */ this._ownsPool = false;

        // --- Колбэки загрузки ---
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
        /** @private */ this._boundingSphereRadius = 0;
        /** @private @type {THREE.Vector3} */ this._tempVec3 = new THREE.Vector3();

        /** @private */ this._loaded = false;
        /** @private */ this._loading = false;
        /** @private */ this._isVisible = false;

        /**
         * Отмена регистрации в `map.interaction`.
         * @private @type {(() => void)|null}
         */
        this._unregisterInteraction = null;
    }

    /* ================================================================
       Публичный API
       ================================================================ */

    /**
     * Добавляет слой на карту и запускает асинхронную загрузку GeoTIFF.
     *
     * Возвращает `this` синхронно; готовность отслеживается через
     * `onLoad` либо по флагу {@link GeoTiffLayer#isLoaded}.
     *
     * @param {import('./Core.js').KrbMap} map - Экземпляр карты.
     * @returns {GeoTiffLayer} this
     */
    addTo(map) {
        if (this._map === map) return this;
        super.addTo(map);
        if (!this._loaded && !this._loading) {
            this._load();
        }
        return this;
    }

    /**
     * Удаляет слой с карты, освобождает GPU-ресурсы и (если пул создавали
     * мы сами) уничтожает Web Worker Pool.
     *
     * @returns {void}
     */
    removeFromMap() {
        if (this._unregisterInteraction) {
            try { this._unregisterInteraction(); } catch (e) { /* swallow */ }
            this._unregisterInteraction = null;
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

        this._image = null;
        this._tiff = null;
        this._loaded = false;
        this._isVisible = false;
        this._worldPositions.length = 0;

        super.removeFromMap();
    }

    /**
     * @returns {boolean} true, если растр успешно загружен.
     */
    isLoaded() { return this._loaded; }

    /**
     * @returns {boolean} true, если сейчас идёт загрузка.
     */
    isLoading() { return this._loading; }

    /**
     * Возвращает ссылку на распарсенный `GeoTIFFImage` (может быть null).
     * Полезно для ручного чтения пикселей.
     *
     * @returns {import('../js_TP/geotiff.bundle.js').GeoTIFFImage|null}
     */
    getImage() { return this._image; }

    /* ================================================================
       Загрузка
       ================================================================ */

    /**
     * Асинхронная загрузка: открывает TIFF, читает растр, строит текстуру
     * и геометрию, добавляет меш в `map.worldGroup`.
     *
     * @private
     * @returns {Promise<void>}
     */
    async _load() {
        this._loading = true;
        this._progress(0);
        try {
            this._ensurePool();

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

    /**
     * Создаёт Pool, если пользователь запросил `useWorker` и не передал
     * готовый пул.
     *
     * @private
     */
    _ensurePool() {
        if (this._pool) return;
        if (!this._useWorker) return;
        try {
            const url = this._workerUrl;
            this._pool = new Pool(this._poolSize, () => new Worker(url));
            this._ownsPool = true;
        } catch (e) {
            console.warn('GeoTiffLayer: не удалось создать Pool, декодирование в основном потоке', e);
            this._pool = null;
            this._ownsPool = false;
        }
    }

    /**
     * Открывает GeoTIFF из любого поддерживаемого источника.
     *
     * @private
     * @returns {Promise<import('../js_TP/geotiff.bundle.js').GeoTIFF>}
     */
    async _openTiff() {
        const src = this._source;

        if (typeof src === 'string' || src instanceof URL) {
            return await fromUrl(src.toString(), { pool: this._pool || undefined });
        }
        if (src instanceof ArrayBuffer) {
            return await fromArrayBuffer(src);
        }
        if (ArrayBuffer.isView(src)) {
            // Uint8Array и т.п. — приводим к «сырому» буферу нужного окна
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

    /**
     * Определяет СК растра.
     *
     * Приоритет:
     *  1. явный `options.crs`;
     *  2. `ProjectedCSTypeGeoKey` из GeoKeys;
     *  3. `GeographicTypeGeoKey` из GeoKeys;
     *  4. WGS84 (с предупреждением).
     *
     * @private
     * @param {import('../js_TP/geotiff.bundle.js').GeoTIFFImage} image
     * @returns {import('./Projections.js').Projection}
     */
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

    /**
     * Читает пиксели и создаёт `THREE.DataTexture` в формате RGBA.
     *
     * Использует `image.readRGB()`, который корректно обрабатывает
     * PhotometricInterpretation (RGB, palette, grayscale) и
     * BitsPerSample. Для одноканальных DEM получится серая текстура.
     *
     * @private
     * @param {import('../js_TP/geotiff.bundle.js').GeoTIFFImage} image
     * @returns {Promise<{texture: THREE.DataTexture, width: number, height: number}>}
     */
    async _readAsTexture(image) {
        const width = image.getWidth();
        const height = image.getHeight();

        const readOpts = {};
        if (this._pool) readOpts.pool = this._pool;

        // readRGB возвращает Uint8Array длиной width*height*3
        const rgb = await image.readRGB(readOpts);

        // Разворачиваем в RGBA (three.js предпочитает RGBA)
        const rgba = new Uint8Array(width * height * 4);
        for (let i = 0, j = 0; j < rgba.length; i += 3, j += 4) {
            rgba[j]     = rgb[i];
            rgba[j + 1] = rgb[i + 1];
            rgba[j + 2] = rgb[i + 2];
            rgba[j + 3] = 255;
        }

        const texture = new THREE.DataTexture(rgba, width, height, THREE.RGBAFormat);
        // По умолчанию Texture.flipY = true; для DataTexture оставляем true,
        // тогда UV-раскладка PlaneGeometry (0,1)=TL совпадает с рядом 0 массива.
        texture.flipY = true;
        texture.colorSpace = THREE.SRGBColorSpace;
        texture.minFilter = THREE.LinearFilter;
        texture.magFilter = THREE.LinearFilter;
        texture.generateMipmaps = false;
        texture.needsUpdate = true;

        return { texture, width, height };
    }

    /* ================================================================
       Геопривязка и геометрия
       ================================================================ */

    /**
     * Считает 4 угла растра в мировых координатах карты.
     *
     * Порядок вершин — как у `THREE.PlaneGeometry`:
     *  v0 = top-left, v1 = top-right, v2 = bottom-left, v3 = bottom-right.
     *
     * @private
     * @param {import('../js_TP/geotiff.bundle.js').GeoTIFFImage} image
     */
    _computeWorldCorners(image) {
        const width = image.getWidth();
        const height = image.getHeight();
        const origin = image.getOrigin();          // [ox, oy] — координаты TL-угла
        const resolution = image.getResolution();  // [rx, ry], ry обычно отрицательный

        const ox = origin[0], oy = origin[1];
        const rx = resolution[0], ry = resolution[1];

        // 4 угла в исходной СК растра
        const cornersCrs = [
            [ox,             oy],               // TL
            [ox + width * rx, oy],              // TR
            [ox,             oy + height * ry], // BL
            [ox + width * rx, oy + height * ry] // BR
        ];

        const map = this._map;
        /** @type {THREE.Vector3[]} */
        const positions = [];
        for (const [x, y] of cornersCrs) {
            const [wx, wz] = map.project([x, y], this._crs);
            positions.push(new THREE.Vector3(wx, 0, wz));
        }
        this._worldPositions = positions;
    }

    /**
     * Строит `PlaneGeometry` с вершинами в мировых координатах
     * (локально относительно центроида) и материал с текстурой.
     * @private
     */
    _buildMesh() {
        const positions = this._worldPositions;
        if (positions.length < 4) return;

        const centroid = new THREE.Vector3();
        positions.forEach(p => centroid.add(p));
        centroid.divideScalar(positions.length);
        this._centroidWorld.copy(centroid);

        const geometry = new THREE.PlaneGeometry(1, 1, 1, 1);
        const posAttr = geometry.attributes.position;
        for (let i = 0; i < 4; i++) {
            posAttr.setXYZ(
                i,
                positions[i].x - centroid.x,
                positions[i].y - centroid.y,
                positions[i].z - centroid.z
            );
        }
        posAttr.needsUpdate = true;
        geometry.computeVertexNormals();

        // UV у PlaneGeometry по умолчанию:
        //   v0 (TL) → (0, 1), v1 (TR) → (1, 1),
        //   v2 (BL) → (0, 0), v3 (BR) → (1, 0)
        // Порядок вершин у нас совпадает, а flipY=true даёт корректную
        // привязку: строка 0 массива (север растра) попадает на север карты.

        const material = new THREE.MeshBasicMaterial({
            map: this._texture,
            side: THREE.DoubleSide,
            transparent: this._opacity < 1,
            opacity: this._opacity,
            blending: this._normalizeBlending(this._blending),
            depthTest: true,
            depthWrite: false
        });

        const mesh = new THREE.Mesh(geometry, material);
        mesh.renderOrder = this._renderOrder;

        this._group.clear();
        this._group.add(mesh);
        this._group.position.copy(centroid);

        this._geometry = geometry;
        this._material = material;
        this._mesh = mesh;

        // Ограничивающая сфера для быстрого отсечения по расстоянию
        let maxRadiusSq = 0;
        for (const p of positions) {
            const dx = p.x - centroid.x;
            const dy = p.y - centroid.y;
            const dz = p.z - centroid.z;
            const rSq = dx * dx + dy * dy + dz * dz;
            if (rSq > maxRadiusSq) maxRadiusSq = rSq;
        }
        this._boundingSphereRadius = Math.sqrt(maxRadiusSq);
    }

    /* ================================================================
       Интерактивность
       ================================================================ */

    /**
     * Регистрирует меш в общем `map.interaction`, если у слоя есть
     * тултип/onClick/onHover.
     * @private
     */
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

    /**
     * Вызывается картой каждый кадр (через `Layer._postUpdate`).
     * Управляет видимостью меша по зуму и расстоянию до камеры.
     *
     * @param {import('./Core.js').KrbMap} map
     * @private
     */
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

    /**
     * Приводит строковый режим смешивания к константе THREE.
     * @private
     * @param {string|number} blending
     * @returns {number}
     */
    _normalizeBlending(blending) {
        if (typeof blending === 'number') return blending;
        switch (String(blending).toLowerCase()) {
            case 'additive': return THREE.AdditiveBlending;
            case 'multiply': return THREE.MultiplyBlending;
            case 'subtract': return THREE.SubtractiveBlending;
            case 'normal':
            default: return THREE.NormalBlending;
        }
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
            color: '#333',
            fontSize: '12px',
            textAlign: this._titleAlign
        }, this._titleStyle);
    }

    /** @returns {{min:number, max:number}} */
    getTextZoomBounds() {
        return { min: this._titleMinZoom, max: this._titleMaxZoom };
    }

    /** @returns {string} */
    getLabelType() { return 'geotiff'; }

    /** @returns {boolean} */
    isVisible() { return this._isVisible; }

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

    /** @returns {string} */
    getTitleAlign() { return this._titleAlign; }

    /** @returns {Array.<number>} */
    getTitleOffset() { return this._titleOffset; }

    /** @returns {string} */
    getTitleVerticalAlign() { return 'center'; }

    /** @returns {boolean} */
    getAllowOverflow() { return this._titleAllowOverflow; }

    /** @returns {number} */
    getPriority() { return this._titlePriority; }

    /* ================================================================
       Интерфейс для KrbMap#fitTo / getBounds
       ================================================================ */

    /**
     * Возвращает прямоугольник растра в заданной СК.
     *
     * До загрузки вернёт `null`. После загрузки — bbox по четырём углам,
     * преобразованный из СК растра (`this._crs`) в `crs`.
     *
     * @param {string|import('./Projections.js').Projection} [crs='EPSG:4326']
     * @returns {Array.<Array.<number>>|null}
     *
     * @example
     * const b = layer.getBounds();              // → [[lon0, lat0], [lon1, lat1]]
     * const bUtm = layer.getBounds('EPSG:32637');
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
            [ox,             oy],
            [ox + width * rx, oy],
            [ox,             oy + height * ry],
            [ox + width * rx, oy + height * ry]
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