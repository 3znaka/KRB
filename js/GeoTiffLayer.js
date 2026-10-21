/**
 * Модуль для отображения GeoTIFF-растров на карте.
 *
 * Поддерживает:
 *  - загрузку из URL, ArrayBuffer, Blob и URL-объекта;
 *  - автоопределение СК по GeoKeys (`ProjectedCSTypeGeoKey` /
 *    `GeographicTypeGeoKey`) с фолбэком на `map.inputCRS` / WGS84;
 *  - корректное размещение с учётом `ModelPixelScale` / `ModelTiepoint`
 *    (используются методы `image.getOrigin()` / `getResolution()`);
 *  - чтение многоканальных/палитровых 8-битных снимков через `image.readRGB()`;
 *  - чтение одноканальных (DEM) растров (float / >8 бит) через
 *    `image.readRasters()` с нормализацией значений и раскраской палитрой
 *    (по умолчанию — чёрно-белая);
 *  - произвольные цветовые палитры и пресеты (`terrain`, `viridis`, …)
 *    через общий модуль {@link module:ColorRamps};
 *  - обработку NoData (авто из GDAL_NODATA или явно);
 *  - опциональный Web Worker Pool (см. `geotiff.worker.js`) — сильно
 *    ускоряет декодирование сжатых GeoTIFF (LZW, Deflate);
 *  - события hover/click/tooltip через общий `map.interaction`;
 *  - подписи через `TextManager` (тот же интерфейс, что у `Image`);
 *  - `getBounds(crs)` для `map.fitTo(layer)`;
 *  - **режим источника высот** (`asElevation: true`) — см. ниже.
 *
 * Координаты внутри TIFF интерпретируются в его собственной СК (см. выше).
 * Для отображения все четыре угла растра проецируются в СК карты
 * (`map.projection`) и ложатся в плоскость через `THREE.PlaneGeometry` —
 * ровно так же, как это делает `Image` со своими `nodes`.
 *
 * ### Z-fighting с тайлами
 *
 * Плоскость GeoTIFF по умолчанию лежит на `y = elevationOffset` (0).
 * Primary-тайлы карты после недавней правки TileManager тоже пишут
 * depth и на нулевом уровне высот оказываются строго coplanar с
 * GeoTIFF — это классический z-fighting. Решение — `polygonOffset`
 * в материале: значение глубины сдвигается без изменения геометрии,
 * и GeoTIFF гарантированно «ближе к камере» в coplanar-пикселях.
 * См. опции `alwaysOnTop` и `elevationOffset`.
 *
 * ### Режим источника высот (`asElevation: true`)
 *
 * Если задан `asElevation: true`, одноканальные значения растра
 * сохраняются в памяти и слой регистрируется в `TileManager` как
 * провайдер высот. Тайлы карты в этом случае получают рельеф не из
 * тайлового DEM-источника, а напрямую из GeoTIFF: `TileManager`
 * вызывает {@link GeoTiffLayer#getTileHeights} для каждого тайла и
 * раскладывает полученный массив в геометрию.
 *
 * Слой может быть одновременно и «провайдером высот», и обычной
 * подложкой (например, с `opacity: 0` — тогда виден только рельеф).
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
 * Масштаб высот по умолчанию (совпадает с `DEFAULTS.HEIGHT_SCALE` в Utils,
 * но мы не тянем зависимость ради одной константы).
 * @private
 */
const DEFAULT_HEIGHT_SCALE = 1.0;

/**
 * Величина `polygonOffsetFactor`/`polygonOffsetUnits` по умолчанию.
 *
 * Подобрана так, чтобы уверенно перекрывать coplanar-тайлы на любых
 * разумных дистанциях камеры и при этом не «просвечивать» GeoTIFF
 * сквозь рельеф, стоящий перед камерой. Если z-fighting всё же
 * пробивается на дальних зумах — увеличьте; если GeoTIFF «светится»
 * сквозь холмы — уменьшите (или используйте `alwaysOnTop`/`elevationOffset`).
 * @private
 */
const DEFAULT_POLYGON_OFFSET = -4;

/**
 * Слой GeoTIFF-растра.
 *
 * @example
 * const tiff = new GeoTiffLayer({
 *     source: 'https://example.com/dem.tif',
 *     useWorker: true,
 *     poolSize: 2,
 *     opacity: 1,
 *     colorRamp: 'terrain',       // опционально, по умолчанию grayscale
 *     onLoad: (layer) => console.log('loaded:', layer.getBounds(), layer.getDataRange()),
 *     onProgress: (p) => console.log(`progress: ${(p * 100).toFixed(0)}%`)
 * });
 * tiff.addTo(map);
 *
 * @example
 * // Только как источник высот (без отрисовки растра):
 * const dem = new GeoTiffLayer({
 *     source: 'https://example.com/dem.tif',
 *     asElevation: true,
 *     heightScale: 1.5,
 *     opacity: 0
 * });
 * dem.addTo(map);
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
     * @param {boolean} [options.alwaysOnTop=false] - Отключить depthTest у
     *     материала: GeoTIFF рисуется поверх всей сцены. Простейший способ
     *     победить z-fighting, но `polygonOffset` (по умолчанию) лучше —
     *     он сохраняет корректную окклюзию рельефом. Используйте
     *     `alwaysOnTop`, если GeoTIFF — чисто 2D-оверлей.
     * @param {number} [options.elevationOffset=0] - Подъём плоскости
     *     GeoTIFF над нулевым уровнем в world-метрах. Полезно, когда
     *     GeoTIFF должен «висеть» над рельефом, но не драпируется
     *     (например, при `asElevation: true` с видимой текстурой).
     * @param {number} [options.polygonOffset=-4] - Значение
     *     `polygonOffsetFactor`/`polygonOffsetUnits` (с отрицательным
     *     знаком — «к камере»). Увеличивайте, если z-fighting всё же
     *     пробивается; уменьшайте, если GeoTIFF «просвечивает» сквозь
     *     рельеф, стоящий перед камерой. Игнорируется при `alwaysOnTop`.
     *
     * @param {string|Array} [options.colorRamp=undefined] - Палитра для
     *     одноканальных (DEM) данных. Строка — имя пресета
     *     (`'grayscale'`, `'terrain'`, `'viridis'`, `'magma'`, `'coolwarm'`),
     *     либо массив стопов:
     *       - `[[0, '#000000'], [0.5, '#808080'], [1, '#ffffff']]`
     *       - `[{ value: 0, color: '#000' }, { value: 1, color: '#fff' }]`
     *       - `[{ value: 0, r: 0, g: 0, b: 0, a: 255 }, ...]`
     *     Если не задан — для float / >8 бит одноканальных GeoTIFF
     *     автоматически включается `'grayscale'`.
     *     Полный список пресетов — см. {@link module:ColorRamps}.
     * @param {number|null} [options.minValue=null] - Нижняя граница
     *     нормализации. `null` — авто по данным.
     * @param {number|null} [options.maxValue=null] - Верхняя граница
     *     нормализации. `null` — авто по данным.
     * @param {number|null} [options.noDataValue=null] - Значение NoData.
     *     `null` — авто (пытаемся прочитать GDAL_NODATA из TIFF).
     * @param {string|null} [options.noDataColor='transparent'] - Цвет для
     *     NoData (`'transparent'` / `null` = не рисовать, иначе CSS-цвет).
     *
     * @param {boolean} [options.asElevation=false] - Включить режим
     *     источника высот: слой зарегистрируется в `TileManager` и
     *     будет отдавать рельеф для тайлов карты через
     *     {@link GeoTiffLayer#getTileHeights}. Требует одноканального
     *     (DEM) растра — RGB/палитровые будут проигнорированы с
     *     предупреждением. Слой при этом продолжает рисоваться как
     *     обычный растр (можно скрыть через `opacity: 0`).
     * @param {number} [options.heightScale=1.0] - Множитель высот при
     *     работе в режиме источника высот. Значения растра умножаются
     *     на этот коэффициент перед записью в Y-координату вершин
     *     тайлов карты.
     * @param {boolean} [options.keepRawData=false] - Хранить сырые
     *     (не раскрашенные) значения растра в памяти. Автоматически
     *     включается при `asElevation: true`. Для больших DEM это
     *     ощутимый объём (например, 5000×5000 float = 100 МБ).
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

        // --- Рендеринг над тайлами (z-fighting fix) ---
        /**
         * Не проверять depth-буфер: GeoTIFF всегда рисуется поверх
         * сцены. Простейший способ победить z-fighting, но ломает
         * окклюзию рельефом. По умолчанию выключено — используется
         * polygonOffset.
         * @private @type {boolean}
         */
        this._alwaysOnTop = options.alwaysOnTop === true;
        /**
         * Подъём плоскости GeoTIFF над нулевым уровнем в world-метрах.
         * @private @type {number}
         */
        this._elevationOffset = Number.isFinite(options.elevationOffset)
            ? options.elevationOffset
            : 0;
        /**
         * Значение `polygonOffsetFactor`/`polygonOffsetUnits`.
         * @private @type {number}
         */
        this._polygonOffset = Number.isFinite(options.polygonOffset)
            ? options.polygonOffset
            : DEFAULT_POLYGON_OFFSET;

        // --- Пул воркеров ---
        /** @private */ this._useWorker = options.useWorker === true;
        /** @private */ this._poolSize = options.poolSize ?? 2;
        /** @private */ this._workerUrl = options.workerUrl ?? DEFAULT_WORKER_URL;
        /** @private @type {Pool|null} */ this._pool = options.pool || null;
        /** @private */ this._ownsPool = false;

        /**
         * Blob URL, из которого создан воркер (для revokeObjectURL).
         * Используется, когда `workerUrl` кросс-доменный: браузер
         * запрещает `new Worker(crossOriginUrl)` даже с CORS, поэтому
         * мы скачиваем исходник воркера через `fetch` и оборачиваем в Blob.
         * @private @type {string|null}
         */
        this._blobWorkerUrl = null;

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

        // --- Рендеринг одноканальных (DEM) данных ---
        /** @private */ this._colorRampInput = options.colorRamp ?? undefined;
        /**
         * Кэш нормализованной палитры. Заполняется в `_getColorRamp()`.
         * @private @type {Array<{value:number,r:number,g:number,b:number,a:number}>|null}
         */
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

        // --- Режим источника высот ---
        /** @private @type {boolean} */
        this._asElevation = options.asElevation === true;
        /** @private @type {number} */
        this._elevationHeightScale = options.heightScale ?? DEFAULT_HEIGHT_SCALE;
        /**
         * Хранить ли сырые значения растра. Автоматически включается в
         * elevation-режиме. В остальных случаях — по явному запросу.
         * @private @type {boolean}
         */
        this._keepRawData = this._asElevation || options.keepRawData === true;

        /** @private @type {Float32Array|Uint16Array|Uint8Array|Int16Array|null} */
        this._rawData = null;
        /** @private @type {number} */ this._rawWidth = 0;
        /** @private @type {number} */ this._rawHeight = 0;
        /** @private @type {[number, number]|null} */ this._geoOrigin = null;
        /** @private @type {[number, number]|null} */ this._geoResolution = null;
        /** @private @type {number|null} */ this._geoNoData = null;

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
     * Если слой был зарегистрирован как источник высот в `TileManager`,
     * регистрация снимается.
     *
     * @returns {void}
     */
    removeFromMap() {
        if (this._unregisterInteraction) {
            try { this._unregisterInteraction(); } catch (e) { /* swallow */ }
            this._unregisterInteraction = null;
        }

        // Отвязываемся от TileManager, если мы — текущий провайдер высот.
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

        // Освобождаем сырые DEM-данные.
        this._rawData = null;
        this._rawWidth = 0;
        this._rawHeight = 0;
        this._geoOrigin = null;
        this._geoResolution = null;
        this._geoNoData = null;

        this._colorRampNormalized = null;
        this._effectiveMin = null;
        this._effectiveMax = null;
        this._effectiveNoData = null;

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

    /**
     * Фактический диапазон значений, использованный для нормализации.
     * Заполняется только для рампового режима (одноканальные DEM).
     * Для RGB-растров вернёт `null`.
     *
     * @returns {{min:number, max:number}|null}
     */
    getDataRange() {
        if (this._effectiveMin === null) return null;
        return { min: this._effectiveMin, max: this._effectiveMax };
    }

    /**
     * Меняет палитру и перестраивает текстуру «на лету».
     *
     * Имеет смысл только для одноканальных (DEM) растров.
     * Для RGB/палитровых снимков метод ничего не делает
     * (возвращает `Promise.resolve()`).
     *
     * @param {string|Array} ramp - Строка-пресет или массив стопов
     *     (формат см. в описании `options.colorRamp` и {@link module:ColorRamps}).
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
       Публичный API провайдера высот
       ================================================================ */

    /**
     * Готов ли слой отдавать высоты. Возвращает `true` только после
     * того, как сырые DEM-данные прочитаны из TIFF.
     *
     * @returns {boolean}
     */
    isElevationProvider() {
        return !!this._rawData && this._rawWidth > 0 && this._rawHeight > 0;
    }

    /**
     * Возвращает высоты для сетки тайла `(z, virtX, y)` размером
     * `(segments+1) × (segments+1)`, row-major от NW к SE — ровно
     * в той раскладке, которую ожидает `TileManager.applyHeightsToGeometry`.
     *
     * `virtX` — «виртуальный» X-индекс тайла (может быть < 0 или >= 2^z
     * для тайлов, развёрнутых через антимеридиан). Lon/lat вычисляются
     * по стандартной XYZ-Web-Mercator формуле, значение сэмплится
     * билинейно из сырого растра.
     *
     * Для точек за пределами экстента GeoTIFF возвращается `0`
     * (плоская поверхность на уровне моря).
     *
     * @param {number} z - Дискретный зум (XYZ).
     * @param {number} virtX - Виртуальный X-индекс тайла.
     * @param {number} y - Y-индекс тайла.
     * @param {number} segments - Число сегментов сетки (SEGMENTS движка).
     * @returns {Float32Array} Массив высот длиной `(segments+1)²`,
     *     уже умноженный на `options.heightScale`.
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

    /**
     * Асинхронная загрузка: открывает TIFF, читает растр, строит текстуру
     * и геометрию, добавляет меш в `map.worldGroup`.
     *
     * Если слой создан с `asElevation: true`, после чтения растра он
     * автоматически регистрируется как источник высот в `TileManager`.
     *
     * @private
     * @returns {Promise<void>}
     */
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

            // Регистрация в TileManager как источника высот.
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

    /**
     * Создаёт Pool, если пользователь запросил `useWorker` и не передал
     * готовый пул.
     *
     * Если `workerUrl` кросс-доменный, браузер блокирует
     * `new Worker(url)` из-за same-origin политики воркеров (CORS для
     * этого конструктора не применяется). Обходим: скачиваем исходник
     * воркера через `fetch` (CORS на CDN уже настроен), заворачиваем в
     * Blob и создаём воркер из Blob URL — он считается same-origin с
     * документом.
     *
     * @private
     * @returns {Promise<void>}
     */
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

            // На случай, если сервер вернул HTML-страницу ошибки
            // с кодом 200 (бывает с SPA-fallback'ами).
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
     * Ветвление:
     *  - **рамповый режим** (одноканальный float / >8 бит, либо явный
     *    `colorRamp`, либо `asElevation`): чтение сырых значений через
     *    `readRasters()` с нормализацией и палитрой;
     *  - **RGB/palette режим**: старый путь через `readRGB()`.
     *
     * @private
     * @param {import('../js_TP/geotiff.bundle.js').GeoTIFFImage} image
     * @returns {Promise<{texture: THREE.DataTexture, width: number, height: number}>}
     */
    async _readAsTexture(image) {
        const width = image.getWidth();
        const height = image.getHeight();

        if (this._isRampImage(image)) {
            return await this._readAsRampTexture(image, width, height);
        }

        // --- Старый путь: RGB / palette / 8-бит grayscale ---
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

    /**
     * Решает, нужно ли применять палитру для данного изображения.
     *
     * Логика:
     *  - RGB (PhotometricInterpretation=2) и palette (Photometric=3) —
     *    всегда через `readRGB` (палитра встроена в файл);
     *  - одноканальное (SamplesPerPixel=1) + (`SampleFormat=3` (float)
     *    или `BitsPerSample>8` или явно задан `colorRamp`, или включён
     *    режим `asElevation`) — рампа;
     *  - всё остальное — `readRGB`.
     *
     * В режиме `asElevation` для RGB/палитровых файлов выводим
     * предупреждение — они не годятся как DEM.
     *
     * @private
     * @param {import('../js_TP/geotiff.bundle.js').GeoTIFFImage} image
     * @returns {boolean}
     */
    _isRampImage(image) {
        const photometric = image.fileDirectory?.PhotometricInterpretation;
        // RGB (2) или Palette (3) — раскраска уже «внутри» файла.
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

        // Пользователь явно попросил палитру.
        if (this._colorRampInput !== undefined) return true;

        // Режим источника высот: гарантированно читаем сырые значения.
        if (this._asElevation) return true;

        // Авто: float или >8 бит одноканальные.
        const bitsRaw = typeof image.getBitsPerSample === 'function'
            ? image.getBitsPerSample()
            : (image.fileDirectory?.BitsPerSample);
        const bits = Array.isArray(bitsRaw) ? bitsRaw[0] : bitsRaw;

        const fmtRaw = typeof image.getSampleFormat === 'function'
            ? image.getSampleFormat()
            : (image.fileDirectory?.SampleFormat);
        const fmt = Array.isArray(fmtRaw) ? fmtRaw[0] : fmtRaw;

        if (fmt === 3) return true;                         // IEEE float
        if (Number.isFinite(bits) && bits > 8) return true; // >8 бит
        return false;
    }

    /* ================================================================
       Рамповый режим (одноканальные DEM)
       ================================================================ */

    /**
     * Читает сырые значения и раскрашивает их палитрой.
     *
     * Если включён `_keepRawData`, сырые значения и геопривязка
     * сохраняются в поля экземпляра — они используются методом
     * {@link GeoTiffLayer#getTileHeights} в режиме источника высот.
     *
     * @private
     * @param {import('../js_TP/geotiff.bundle.js').GeoTIFFImage} image
     * @param {number} width
     * @param {number} height
     * @returns {Promise<{texture: THREE.DataTexture, width: number, height: number}>}
     */
    async _readAsRampTexture(image, width, height) {
        const readOpts = { samples: [0] };
        if (this._pool) readOpts.pool = this._pool;

        const rasters = await image.readRasters(readOpts);
        /** @type {ArrayLike<number>} */
        const data = rasters[0];
        if (!data) throw new Error('GeoTiffLayer: readRasters вернул пустой результат');

        // NoData: явный или GDAL_NODATA
        let noData = this._noDataValue;
        if (noData === null) {
            try {
                if (typeof image.getGDALNoData === 'function') {
                    const gdalNd = image.getGDALNoData();
                    if (gdalNd !== null && gdalNd !== undefined) noData = gdalNd;
                }
            } catch (e) { /* ignore */ }
        }

        // Сохраняем сырые данные и геопривязку, если нужно.
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
                // Без геопривязки сэмплировать по lon/lat нельзя —
                // сбрасываем rawData, чтобы провайдер не отдавал мусор.
                this._rawData = null;
            }
        }

        // Диапазон нормализации
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
                // иначе — (0,0,0,0), прозрачно
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

    /**
     * Создаёт `THREE.DataTexture` из RGBA-байтов.
     * @private
     */
    _makeDataTexture(rgba, width, height) {
        const texture = new THREE.DataTexture(rgba, width, height, THREE.RGBAFormat);
        // flipY=true: строка 0 массива (север растра) → верх плоскости,
        // что совпадает с UV-раскладкой PlaneGeometry (v0=TL → (0,1)).
        texture.flipY = true;
        texture.colorSpace = THREE.SRGBColorSpace;
        texture.minFilter = THREE.LinearFilter;
        texture.magFilter = THREE.LinearFilter;
        texture.generateMipmaps = false;
        texture.needsUpdate = true;
        return texture;
    }

    /**
     * Возвращает нормализованную палитру (сортированную по `value`).
     * Результат кэшируется в `_colorRampNormalized`.
     *
     * Вся логика разбора пресетов/массивов — в {@link module:ColorRamps}.
     *
     * @private
     * @returns {Array<{value:number,r:number,g:number,b:number,a:number}>}
     */
    _getColorRamp() {
        if (this._colorRampNormalized) return this._colorRampNormalized;
        this._colorRampNormalized = resolveColorRamp(this._colorRampInput);
        return this._colorRampNormalized;
    }

    /**
     * Приводит `noDataColor` к `[r,g,b,a]` или `null` (не рисовать).
     * @private
     * @param {*} c
     * @returns {[number,number,number,number]|null}
     */
    _parseNoDataColor(c) {
        if (c === null || c === undefined) return null;
        if (typeof c === 'string' && c.toLowerCase() === 'transparent') return null;
        const rgba = parseColorToRGBA(c);
        return [rgba.r, rgba.g, rgba.b, rgba.a];
    }

    /* ================================================================
       Сэмплирование сырых DEM-данных
       ================================================================ */

    /**
     * Возвращает значение растра в точке `(lon, lat)` (в градусах WGS84)
     * с билинейной интерполяцией.
     *
     * Внутри:
     *  1. `lon/lat` → координаты СК растра (`this._crs`) через proj4
     *     (для `EPSG:4326`/`CRS:84` — без преобразования);
     *  2. смещение по `_geoOrigin` / `_geoResolution` → пиксельные
     *     координаты (с учётом того, что `_geoOrigin` — это центр
     *     TL-пикселя, а не его угол);
     *  3. билинейная интерполяция по 4 соседним пикселям.
     *
     * Возвращает `null`, если точка вне экстента растра, или
     * `_geoNoData`, если все 4 соседа — NoData.
     *
     * @private
     * @param {number} lon
     * @param {number} lat
     * @returns {number|null}
     */
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

    /**
     * Билинейная интерполяция в пиксельных координатах.
     *
     * @private
     * @param {number} px - Дробный X (0..width-1).
     * @param {number} py - Дробный Y (0..height-1).
     * @returns {number|null}
     */
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

        // Если все 4 валидны — обычная билинейная интерполяция.
        if (isValid(v00) && isValid(v10) && isValid(v01) && isValid(v11)) {
            const a = v00 * (1 - fx) + v10 * fx;
            const b = v01 * (1 - fx) + v11 * fx;
            return a * (1 - fy) + b * fy;
        }

        // Иначе — среднее по валидным (сглаживаем NoData на границе).
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

    /**
     * Считает 4 угла растра в мировых координатах карты.
     *
     * Порядок вершин — как у `THREE.PlaneGeometry`:
     *  v0 = top-left, v1 = top-right, v2 = bottom-left, v3 = bottom-right.
     *
     * Y-координата всех углов равна `_elevationOffset` (по умолчанию 0).
     * Это позволяет поднять плоскость GeoTIFF над уровнем тайлов, если
     * нужно — см. описание `options.elevationOffset`.
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
            [ox,               oy],               // TL
            [ox + width * rx,  oy],               // TR
            [ox,               oy + height * ry], // BL
            [ox + width * rx,  oy + height * ry]  // BR
        ];

        const map = this._map;
        const y = this._elevationOffset;
        /** @type {THREE.Vector3[]} */
        const positions = [];
        for (const [x, yCrs] of cornersCrs) {
            const [wx, wz] = map.project([x, yCrs], this._crs);
            positions.push(new THREE.Vector3(wx, y, wz));
        }
        this._worldPositions = positions;
    }

    /**
     * Строит `PlaneGeometry` с вершинами в мировых координатах
     * (локально относительно центроида) и материал с текстурой.
     *
     * **Z-fighting.** Материал получает `polygonOffset` (по умолчанию
     * `factor = units = -4`): значение глубины сдвигается «к камере»,
     * не трогая геометрию. Это гарантирует, что GeoTIFF перекрывает
     * coplanar-тайлы карты (после правки TileManager primary-тайлы
     * пишут depth и без polygonOffset дают мерцание). См. также
     * `options.alwaysOnTop` (отключает depthTest полностью).
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

        const transparent = this._opacity < 1;
        const onTop = this._alwaysOnTop;

        const material = new THREE.MeshBasicMaterial({
            map: this._texture,
            side: THREE.DoubleSide,
            transparent,
            opacity: this._opacity,
            blending: this._normalizeBlending(this._blending),

            // polygonOffset сдвигает значение глубины, не трогая геометрию.
            // Это устраняет z-fighting с coplanar primary-тайлами карты:
            // GeoTIFF гарантированно «ближе к камере», но по-прежнему
            // корректно скрыт рельефом, стоящим перед ним.
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
            default:         return THREE.NormalBlending;
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