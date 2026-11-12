// VectorTile.ts
import { THREE } from './js_TP/tpb.js';
import { DEFAULT_STYLES, resolveStyle } from './styles/resolve.js';
import { OPENMAPTILES_SPEC } from './styles/spec.openmaptiles.js';
import { LIGHT_THEME } from './styles/theme.light.js';
import { VectorTileDiagnosticsMixin } from './VectorTileDiagnostics.js';
import { Sprite } from './Sprite.js';
import { VectorTileMaterialsMixin } from './VectorTileMaterials.js';
import { VectorTileLabelsMixin } from './VectorTileLabels.js';
import { VectorTileWorkerMixin, _DEFAULT_WORKER_SCRIPTS } from './VectorTileWorker.js';
import { VectorTileCoverageMixin } from './VectorTileCoverage.js';
import { VectorTileLoadingMixin } from './VectorTileLoading.js';
import { VectorTileLifecycleMixin } from './VectorTileLifecycle.js';
let _nextVectorLabelLayerId = 1;
const _MODULE_DIR = new URL('.', import.meta.url).href;
export class VectorTile {
    // Config
    url;
    attributionTitle;
    attributionUrl;
    visible;
    minZoom;
    maxZoom;
    labelPosition;
    minNativeZoom;
    maxNativeZoom;
    lineWidthMultiplier;
    fillOpacity;
    depthTest;
    visibleLayers;
    invisibleLayers;
    zoomOffset;
    buildings3d;
    buildings3dMinZoom;
    buildingEdges;
    buildings3dOpacity;
    buildings3dEdgeOpacity;
    maxTextLabels;
    maxTextPointsPerTile;
    maxTextLinesPerTile;
    labelDistanceSortZoom;
    labelMaxPerTileClose;
    labelCullMargin;
    labelMaxCameraDistance;
    labelScreenGridSize;
    labelMaxPerCell;
    lineLabelTracking;
    lineLabelPriorityMode;
    lineLabelHysteresisPx;
    lineLabelPlacement;
    sprite;
    _needsDefaultSprite;
    // Internals
    _debug;
    _styles;
    _crsCode;
    /** CRS тайловой сетки (z/x/y в URL). Для VT всегда Mercator (pbf-спека), по умолчанию EPSG:3857. */
    _tileCrs = null;
    /** CRS пользовательского GeoJSON в addExclusionArea. По умолчанию map.inputCRS (обычно EPSG:4326). */
    _exclusionCrs = null;
    _labelIdPrefix;
    _themeRef = null;
    _queueProcessing = false;
    _tileGroupRenderOrder;
    _map = null;
    _rootGroup;
    _tileCache = new Map();
    _oldTileGroups = null;
    _retiredOldKeys = new Set();
    _groupCache = new Map();
    _groupCacheMaxSize;
    _pendingLoads = new Set();
    _pendingLoadGenerations = new Map();
    _sortedLoadQueue = [];
    _activeLoads = 0;
    _maxConcurrent;
    _queueInterval;
    _queueTimer = null;
    _lastSourceZoom = -1;
    _lastDiscreteZoom = -1;
    _lastUpdateTime = 0;
    _throttle;
    _generation = 0;
    _transitionStyleZoom = NaN;
    _tileDataCache = new Map();
    _tileDataCacheMaxSize;
    _fillMaterialCache = new Map();
    _lineMaterialCache = new Map();
    _lineMaterialsSet = new Set();
    _dynamicLineMaterialsSet = new Set();
    _managedMaterials = new WeakSet();
    _managedGeometries = new WeakSet();
    _pointGeometryCache = new Map();
    _exclusionAreas = [];
    _exclusionLayers = new Set();
    _lastCanvasSize = { width: -1, height: -1 };
    _lastWorldPos = new THREE.Vector3();
    _lastMovementTime = 0;
    _lastLabelUpdateTime = 0;
    _lastCheckCamPos = new THREE.Vector3();
    _lastCheckZoom = -1;
    _lastCheckInit = false;
    _labelsDirty = false;
    _settledKeys = new Set();
    _requiredKeys = new Set();
    _coverageDirty = false;
    _lastIs3d = undefined;
    _lastStyleZoom = NaN;
    _lastDashDiscreteZoom = -1;
    _lastPrefetchZoom = -1;
    _prefetchInFlight = new Map();
    _raycaster = new THREE.Raycaster();
    _raycastNDC = new THREE.Vector2();
    _raycastPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
    _raycastHit = new THREE.Vector3();
    _tempVec3 = new THREE.Vector3();
    _canvasSizeVec = new THREE.Vector2();
    _workerScriptUrls;
    _worker = null;
    _workerReady;
    _requestId = 0;
    _pendingWorkerRequests = new Map();
    _lastSelectedLabelIds = new Set();
    constructor(options = {}) {
        this.url = options.url;
        const rawScripts = options.workerScripts ?? _DEFAULT_WORKER_SCRIPTS;
        this._crsCode = options.crs ?? null;
        this._tileCrs = null;
        this._exclusionCrs = null;
        this._labelIdPrefix = `vt:${_nextVectorLabelLayerId++}:`;
        this.attributionTitle = options.attributionTitle || '';
        this.attributionUrl = options.attributionUrl || '';
        this.visible = options.visible ?? true;
        this.minZoom = options.minZoom ?? 0;
        this.maxZoom = options.maxZoom ?? Infinity;
        this._themeRef = options.theme ?? LIGHT_THEME;
        this.labelPosition = options.labelPosition ?? 'bottom';
        if (options.maxSourceZoom !== undefined && options.maxNativeZoom === undefined) {
            console.warn('VectorTile: опция maxSourceZoom устарела, используйте maxNativeZoom. ' +
                'Значение maxSourceZoom будет использовано как maxNativeZoom.');
        }
        if (options.minSourceZoom !== undefined && options.minNativeZoom === undefined) {
            console.warn('VectorTile: опция minSourceZoom устарела, используйте minNativeZoom. ' +
                'Значение minSourceZoom будет использовано как minNativeZoom.');
        }
        if (options.sprite !== undefined) {
            this.sprite = options.sprite; // null отключит иконки, Sprite - использует его
            this._needsDefaultSprite = false;
        }
        else {
            this.sprite = null;
            this._needsDefaultSprite = true;
        }
        this.minNativeZoom = options.minNativeZoom ?? options.minSourceZoom ?? 0;
        this.maxNativeZoom = options.maxNativeZoom ?? options.maxSourceZoom ?? 14;
        this.lineWidthMultiplier = options.lineWidthMultiplier ?? 1.0;
        this.fillOpacity = options.fillOpacity ?? 1.0;
        this.depthTest = options.depthTest ?? true;
        this.visibleLayers = options.visibleLayers || null;
        this.invisibleLayers = options.invisibleLayers || null;
        this.zoomOffset = options.zoomOffset ?? -1;
        this.buildings3d = options.buildings3d ?? true;
        this.buildings3dMinZoom = options.buildings3dMinZoom ?? 17;
        this.buildingEdges = options.buildingEdges ?? true;
        this.maxVisibleTiles = options.maxVisibleTiles ?? 50;
        this.maxTileDistanceFactor = options.maxTileDistanceFactor ?? 4;
        this._tileDataCacheMaxSize = options.tileDataCacheMaxSize
            ?? Math.max(200, this.maxVisibleTiles * 2);
        this._groupCacheMaxSize = options.groupCacheMaxSize
            ?? Math.max(100, Math.ceil(this.maxVisibleTiles * 1.5));
        this.maxTextLabels = options.maxTextLabels ?? 150;
        this.maxTextPointsPerTile = options.maxTextPointsPerTile ?? 500;
        this.maxTextLinesPerTile = options.maxTextLinesPerTile ?? 500;
        this.labelDistanceSortZoom = options.labelDistanceSortZoom ?? 17;
        this.labelMaxPerTileClose = options.labelMaxPerTileClose ?? 20;
        this.labelCullMargin = options.labelCullMargin ?? 250;
        this.labelMaxCameraDistance = options.labelMaxCameraDistance ?? 0;
        // Ограничение плотности подписей по экранной сетке
        this.labelScreenGridSize = options.labelScreenGridSize ?? 128;
        this.labelMaxPerCell = Math.max(1, options.labelMaxPerCell ?? 2);
        this._lastSelectedLabelIds = new Set();
        this.lineLabelTracking = options.lineLabelTracking ?? 1.35;
        this.lineLabelPriorityMode = options.lineLabelPriorityMode ?? 'tile';
        this.lineLabelHysteresisPx = options.lineLabelHysteresisPx ?? 40;
        this.lineLabelPlacement = options.lineLabelPlacement ?? 'auto';
        this._debug = options.debug ?? false;
        const baseStyles = (options.tileSpec || options.theme)
            ? resolveStyle(options.tileSpec ?? OPENMAPTILES_SPEC, options.theme ?? LIGHT_THEME)
            : DEFAULT_STYLES;
        this._styles = this._mergeStyles(baseStyles, options.styles || {});
        this._tileGroupRenderOrder = options.tileGroupRenderOrder ?? 1_000_000;
        this._rootGroup = new THREE.Group();
        this._rootGroup.visible = this.visible;
        this._rootGroup.renderOrder = this._tileGroupRenderOrder;
        this._maxConcurrent = options.maxConcurrent ?? 4;
        this._queueInterval = options.queueInterval ?? 250;
        this._throttle = options.updateThrottle ?? 150;
        this._tileDataCacheMaxSize = options.tileDataCacheMaxSize ?? 200;
        this._groupCacheMaxSize = options.groupCacheMaxSize ?? 100;
        this.buildings3dOpacity = options.buildings3dOpacity ?? 0.8;
        this.buildings3dEdgeOpacity = options.buildings3dEdgeOpacity ?? this.buildings3dOpacity;
        this._workerScriptUrls = rawScripts.map((s) => {
            if (/^https?:\/\//i.test(s) || s.startsWith('/'))
                return s;
            try {
                return new URL(s, _MODULE_DIR).href;
            }
            catch (e) {
                console.error('Invalid worker script URL:', s, e);
                return s;
            }
        });
        if (this._workerScriptUrls.length < 2) {
            console.warn('VectorTile: workerScripts должен содержать два URL (tpb.js и earcut.js).');
        }
        this._workerReady = this._initWorker();
    }
    getThemeBackground() {
        return this._themeRef?.backgroundColor ?? null;
    }
    async _initDefaultSprite() {
        try {
            // Резолвим пути относительно папки, где лежит сам VectorTile.js (то есть js/)
            const jsonUrl = new URL('./sprite/sprite.json', _MODULE_DIR).href;
            const pngUrl = new URL('./sprite/sprite.png', _MODULE_DIR).href;
            const s = new Sprite(jsonUrl, pngUrl);
            await s.load();
            this.sprite = s;
            this._labelsDirty = true;
            if (this._map && this._map.textManager) {
                this._refreshTextLabelsForVisibleTiles();
            }
        }
        catch (err) {
            console.warn('VectorTile: Не удалось загрузить дефолтный спрайт. Иконки будут отключены.', err);
        }
    }
    // ========================================================================
    // Проекционные хелперы (tile-CRS ↔ map-CRS)
    // ========================================================================
    /**
     * Нужна ли деформация геометрии из tile-CRS в map-CRS.
     *
     * Возвращает `false`, если проекции эквивалентны:
     *  • один и тот же объект проекции;
     *  • обе проекции принадлежат Mercator-семейству (численно совпадают
     *    на уровне world-координат, деформация не требуется).
     *
     * В сценарии Mercator→Mercator (по умолчанию) деформация НЕ включается —
     * вся ветка `if (this._isDeformed)` пропускается целиком, нулевая
     * стоимость по сравнению с текущим поведением.
     */
    get _isDeformed() {
        const map = this._map;
        const tileCrs = this._tileCrs;
        if (!map || !tileCrs || !map.projection)
            return false;
        if (tileCrs === map.projection)
            return false;
        return tileCrs.code !== map.projection.code;
    }
    /**
     * Проецирует точку из tile-CRS в map-CRS.
     *
     * Обе системы — world-координаты Three.js, где Z-ось направлена «вниз»
     * (юг), а внутренние проекционные координаты используют Y-вверх. То есть
     * `projY = -worldZ`.
     *
     * @param wx tile-CRS world X
     * @param wz tile-CRS world Z (Z-вниз)
     * @returns `{x, z}` в map-CRS world или `null`, если точка вне домена
     *          проекции (например, полюс в Mercator).
     */
    _tileToMap(wx, wz) {
        const map = this._map;
        const tileCrs = this._tileCrs;
        if (!map || !tileCrs)
            return null;
        const lonLat = tileCrs.toLonLat([wx, -wz]);
        if (!lonLat || !Number.isFinite(lonLat[0]) || !Number.isFinite(lonLat[1]))
            return null;
        const p = typeof map.projection.fromLonLatSafe === 'function'
            ? map.projection.fromLonLatSafe(lonLat)
            : map.projection.fromLonLat(lonLat);
        if (!p || !Number.isFinite(p[0]) || !Number.isFinite(p[1]))
            return null;
        return { x: p[0], z: -p[1] };
    }
    /**
     * Обратное к {@link _tileToMap}: map-CRS world → tile-CRS world.
     * Нужно для `identify` (проекция клика) и для сортировки загрузки
     * новых тайлов по расстоянию до цели камеры.
     */
    _mapToTile(mx, mz) {
        const map = this._map;
        const tileCrs = this._tileCrs;
        if (!map || !tileCrs)
            return null;
        const lonLat = map.projection.toLonLat([mx, -mz]);
        if (!lonLat || !Number.isFinite(lonLat[0]) || !Number.isFinite(lonLat[1]))
            return null;
        const p = typeof tileCrs.fromLonLatSafe === 'function'
            ? tileCrs.fromLonLatSafe(lonLat)
            : tileCrs.fromLonLat(lonLat);
        if (!p || !Number.isFinite(p[0]) || !Number.isFinite(p[1]))
            return null;
        return { x: p[0], z: -p[1] };
    }
}
// ============================================================================
// Mixins
// ============================================================================
function applyMixin(target, mixin) {
    const descriptors = Object.getOwnPropertyDescriptors(mixin);
    delete descriptors.constructor;
    Object.defineProperties(target, descriptors);
}
applyMixin(VectorTile.prototype, VectorTileMaterialsMixin);
applyMixin(VectorTile.prototype, VectorTileLabelsMixin);
applyMixin(VectorTile.prototype, VectorTileWorkerMixin);
applyMixin(VectorTile.prototype, VectorTileCoverageMixin);
applyMixin(VectorTile.prototype, VectorTileLoadingMixin);
applyMixin(VectorTile.prototype, VectorTileLifecycleMixin);
applyMixin(VectorTile.prototype, VectorTileDiagnosticsMixin);
// Backward compatibility.
export const VectorTileLayer = VectorTile;
