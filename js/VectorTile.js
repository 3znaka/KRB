// VectorTile.ts
import { THREE } from './js_TP/tpb.js';
import { DEFAULT_STYLES } from './vectorTileDefaults.js';
export { VECTOR_TILE_RENDER_ORDER } from './VectorTileTypes.js';
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
    minNativeZoom;
    maxNativeZoom;
    lineWidthMultiplier;
    fillOpacity;
    depthTest;
    visibleLayers;
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
    lineLabelTracking;
    lineLabelPriorityMode;
    lineLabelHysteresisPx;
    lineLabelPlacement;
    // Internals
    _debug;
    _styles;
    _crsCode;
    _crs;
    _labelIdPrefix;
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
    _managedMaterials = new WeakSet();
    _managedGeometries = new WeakSet();
    _pointGeometryCache = new Map();
    _exclusionAreas = [];
    _exclusionLayers = new Set();
    _lastCanvasSize = { width: 0, height: 0 };
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
    constructor(options = {}) {
        this.url = options.url;
        const rawScripts = options.workerScripts ?? _DEFAULT_WORKER_SCRIPTS;
        this._crsCode = options.crs ?? null;
        this._crs = null;
        this._labelIdPrefix = `vt:${_nextVectorLabelLayerId++}:`;
        this.attributionTitle = options.attributionTitle || '';
        this.attributionUrl = options.attributionUrl || '';
        this.visible = options.visible ?? true;
        this.minZoom = options.minZoom ?? 0;
        this.maxZoom = options.maxZoom ?? Infinity;
        if (options.maxSourceZoom !== undefined && options.maxNativeZoom === undefined) {
            console.warn('VectorTile: опция maxSourceZoom устарела, используйте maxNativeZoom. ' +
                'Значение maxSourceZoom будет использовано как maxNativeZoom.');
        }
        if (options.minSourceZoom !== undefined && options.minNativeZoom === undefined) {
            console.warn('VectorTile: опция minSourceZoom устарела, используйте minNativeZoom. ' +
                'Значение minSourceZoom будет использовано как minNativeZoom.');
        }
        this.minNativeZoom = options.minNativeZoom ?? options.minSourceZoom ?? 0;
        this.maxNativeZoom = options.maxNativeZoom ?? options.maxSourceZoom ?? 14;
        this.lineWidthMultiplier = options.lineWidthMultiplier ?? 1.0;
        this.fillOpacity = options.fillOpacity ?? 1.0;
        this.depthTest = options.depthTest ?? true;
        this.visibleLayers = options.visibleLayers || null;
        this.zoomOffset = options.zoomOffset ?? 0;
        this.buildings3d = options.buildings3d ?? true;
        this.buildings3dMinZoom = options.buildings3dMinZoom ?? 17;
        this.buildingEdges = options.buildingEdges ?? true;
        this.maxTextLabels = options.maxTextLabels ?? 500;
        this.maxTextPointsPerTile = options.maxTextPointsPerTile ?? 500;
        this.maxTextLinesPerTile = options.maxTextLinesPerTile ?? 500;
        this.labelDistanceSortZoom = options.labelDistanceSortZoom ?? 17;
        this.labelMaxPerTileClose = options.labelMaxPerTileClose ?? 20;
        this.labelCullMargin = options.labelCullMargin ?? 250;
        this.labelMaxCameraDistance = options.labelMaxCameraDistance ?? 0;
        this.lineLabelTracking = options.lineLabelTracking ?? 1.35;
        this.lineLabelPriorityMode = options.lineLabelPriorityMode ?? 'tile';
        this.lineLabelHysteresisPx = options.lineLabelHysteresisPx ?? 40;
        this.lineLabelPlacement = options.lineLabelPlacement ?? 'auto';
        this._debug = options.debug ?? false;
        this._styles = this._mergeStyles(DEFAULT_STYLES, options.styles || {});
        this._tileGroupRenderOrder = options.tileGroupRenderOrder ?? 1_000_000;
        this._rootGroup = new THREE.Group();
        this._rootGroup.visible = this.visible;
        this._rootGroup.renderOrder = this._tileGroupRenderOrder;
        this._maxConcurrent = options.maxConcurrent ?? 4;
        this._queueInterval = options.queueInterval ?? 250;
        this._throttle = options.updateThrottle ?? 500;
        this._tileDataCacheMaxSize = options.tileDataCacheMaxSize ?? 200;
        this._groupCacheMaxSize = options.groupCacheMaxSize ?? 100;
        this.buildings3dOpacity = options.buildings3dOpacity ?? 1.0;
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
// Backward compatibility.
export const VectorTileLayer = VectorTile;
