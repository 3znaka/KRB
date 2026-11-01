// VectorTile.ts
import { THREE, LineMaterial } from './js_TP/tpb.js';
import { DEFAULT_STYLES } from './vectorTileDefaults.js';

import type {
    VectorTileOptions,
    WidthSpec,
    WorkerLine,
    WorkerTextPoint,
} from './VectorTileTypes.js';

// Re-exports для backward compatibility
export type {
    VectorTileOptions, Stops, WidthSpec,
    WorkerLine, WorkerTextPoint, WorkerTextLine,
} from './VectorTileTypes.js';
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
    url?: string;
    attributionTitle: string;
    attributionUrl: string;
    visible: boolean;
    minZoom: number;
    maxZoom: number;
    minNativeZoom: number;
    maxNativeZoom: number;
    lineWidthMultiplier: number;
    fillOpacity: number;
    depthTest: boolean;
    visibleLayers: string[] | null;
    zoomOffset: number;
    buildings3d: boolean;
    buildings3dMinZoom: number;
    buildingEdges: boolean;
    buildings3dOpacity: number;
    buildings3dEdgeOpacity: number;
    maxTextLabels: number;
    maxTextPointsPerTile: number;
    maxTextLinesPerTile: number;
    labelDistanceSortZoom: number;
    labelMaxPerTileClose: number;
    labelCullMargin: number;
    labelMaxCameraDistance: number;
    labelScreenGridSize: number;
    labelMaxPerCell: number;
    lineLabelTracking: number;
    lineLabelPriorityMode: string;
    lineLabelHysteresisPx: number;
    lineLabelPlacement: string;

    // Internals
    private _debug: boolean;
    private _styles: Record<string, any>;
    private _crsCode: string | null;
    private _crs: any;
    private _labelIdPrefix: string;

    private _tileGroupRenderOrder: number;
    private _map: any = null;
    private _rootGroup: THREE.Group;

    private _tileCache = new Map<string, THREE.Group>();
    private _oldTileGroups: Map<string, THREE.Group> | null = null;
    private _retiredOldKeys = new Set<string>();
    private _groupCache = new Map<string, THREE.Group>();
    private _groupCacheMaxSize: number;

    private _pendingLoads = new Set<string>();
    private _pendingLoadGenerations = new Map<string, number>();
    private _sortedLoadQueue: string[] = [];
    private _activeLoads = 0;
    private _maxConcurrent: number;
    private _queueInterval: number;
    private _queueTimer: ReturnType<typeof setTimeout> | null = null;

    private _lastSourceZoom = -1;
    private _lastDiscreteZoom = -1;
    private _lastUpdateTime = 0;
    private _throttle: number;
    private _generation = 0;
    private _transitionStyleZoom = NaN;

    private _tileDataCache = new Map<string, ArrayBuffer>();
    private _tileDataCacheMaxSize: number;

    private _fillMaterialCache = new Map<string, THREE.Material>();
    private _lineMaterialCache = new Map<string, THREE.Material>();
    private _lineMaterialsSet = new Set<LineMaterial>();
    private _managedMaterials = new WeakSet<THREE.Material>();
    private _managedGeometries = new WeakSet<THREE.BufferGeometry>();
    private _pointGeometryCache = new Map<string, THREE.BufferGeometry>();

    private _exclusionAreas: Array<Array<{ x: number; z: number }>> = [];
    private _exclusionLayers = new Set<string>();

    private _lastCanvasSize = { width: 0, height: 0 };
    private _lastWorldPos = new THREE.Vector3();
    private _lastMovementTime = 0;
    private _lastLabelUpdateTime = 0;
    private _lastCheckCamPos = new THREE.Vector3();
    private _lastCheckZoom = -1;
    private _lastCheckInit = false;
    private _labelsDirty = false;

    private _settledKeys = new Set<string>();
    private _requiredKeys = new Set<string>();
    private _coverageDirty = false;
    private _lastIs3d: boolean | undefined = undefined;
    private _lastStyleZoom = NaN;

    private _lastPrefetchZoom = -1;
    private _prefetchInFlight = new Map<string, Promise<ArrayBuffer | null>>();

    private _raycaster = new THREE.Raycaster();
    private _raycastNDC = new THREE.Vector2();
    private _raycastPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
    private _raycastHit = new THREE.Vector3();
    private _tempVec3 = new THREE.Vector3();
    private _canvasSizeVec = new THREE.Vector2();

    private _workerScriptUrls: string[];
    private _worker: Worker | null = null;
    private _workerReady: Promise<void>;
    private _requestId = 0;
    private _pendingWorkerRequests = new Map<number, any>();
    private _lastSelectedLabelIds = new Set<string>();

    constructor(options: VectorTileOptions = {}) {
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

        this.maxTextLabels = options.maxTextLabels ?? 150;
        this.maxTextPointsPerTile = options.maxTextPointsPerTile ?? 500;
        this.maxTextLinesPerTile = options.maxTextLinesPerTile ?? 500;
        this.labelDistanceSortZoom = options.labelDistanceSortZoom ?? 17;
        this.labelMaxPerTileClose = options.labelMaxPerTileClose ?? 20;
        this.labelCullMargin = options.labelCullMargin ?? 250;
        this.labelMaxCameraDistance = options.labelMaxCameraDistance ?? 0;

        // Ограничение плотности подписей по экранной сетке
        this.labelScreenGridSize = options.labelScreenGridSize ?? 256;
        this.labelMaxPerCell = Math.max(1, options.labelMaxPerCell ?? 3);
        this._lastSelectedLabelIds = new Set<string>();

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
            if (/^https?:\/\//i.test(s) || s.startsWith('/')) return s;
            try { return new URL(s, _MODULE_DIR).href; }
            catch (e) { console.error('Invalid worker script URL:', s, e); return s; }
        });

        if (this._workerScriptUrls.length < 2) {
            console.warn('VectorTile: workerScripts должен содержать два URL (tpb.js и earcut.js).');
        }

        this._workerReady = this._initWorker();
    }
}

// ============================================================================
// Declaration merging — методы, приходящие из миксинов
// ============================================================================

export interface VectorTile {
    // --- labels ---
    _forEachShownGroup(cb: (group: THREE.Group) => void): void;
    _getPointLabelId(pt: WorkerTextPoint, group: THREE.Group): string;
    _removeTextLabelsForGroup(group: THREE.Group | null | undefined): void;
    _refreshTextLabelsForVisibleTiles(): void;
    _collectLabelCandidates(): { candidates: any[]; isClose: boolean };
    _selectCandidatesByScreenGrid(candidates: any[]): any[];

    // --- materials ---
    _getFillMaterial(styleKey: string): THREE.Material;
    _getFillMaterialFromData(layerName: string, color: number, opacity: number | undefined): THREE.Material;
    _getLineMaterial(styleKey: string, dash?: number[]): LineMaterial;
    _getLineMaterialFromData(layerName: string, color: number, width: number, dash: number[] | undefined): LineMaterial;
    _getDynamicLineMaterial(line: WorkerLine): LineMaterial | null;
    _evalCurve(c: WidthSpec, z: number): number;
    _updateDynamicLineMaterials(zoom: number): void;
    _getPointGeometry(radius: number): THREE.BufferGeometry;
    _concatF32(arrays: Float32Array[]): Float32Array;
    _getBuildingMaterial(color: number, opacity?: number): THREE.Material;
    _getBuildingEdgeMaterial(color: number, opacity?: number): THREE.Material;

    // --- worker ---
    _initWorker(): Promise<void>;
    _onWorkerMessage(data: any): void;
    _buildGroupFromWorkerResult(group: THREE.Group, result: any): void;
    _fatLineSegmentsFromPositions(positions: Float32Array | ArrayLike<number> | undefined): Float32Array | null;
    _addFatLineFromPositions(group: THREE.Group, positions: any, material: any, renderOrder: number | undefined): void;
    _sendToWorker(buffer: ArrayBuffer, z: number, x: number, y: number, is3d: boolean,
        existingGroup?: THREE.Group | null, generation?: number, styleZoom?: number): Promise<THREE.Group | null>;
    identify(sceneX: number, sceneZ: number, opts?: { tolerance?: number }): Promise<any>;

    // --- coverage ---
    _is3dNow(): boolean;
    _getCurrentTileStyleZoom(map?: any): number;
    _pickSourceZoom(map: any): number;
    _isTileRequestCurrent(map: any, generation: number, sourceZoom: number, styleZoom: number): boolean;
    _adoptTile(key: string, group: THREE.Group | null | undefined, visible?: boolean, generation?: number, styleZoom?: number): boolean;
    _stashGroup(key: string, group: THREE.Group | null | undefined): void;
    _beginTransition(newZ: number, styleZoom: number): void;
    _resolveCoverage(): void;

    // --- loading ---
    _prefetchNextZoom(z: number): void;
    _processQueue(): void;
    _loadTile(z: number, xSlippy: number, ySlippy: number): Promise<void>;
    _getVisibleTileKeys(z: number): Set<string>;
    _setTileDataCache(key: string, buffer: ArrayBuffer): void;
    _getTileDataCache(key: string): ArrayBuffer | undefined;
    _clearAllTiles(): void;
    _clearGroupCache(): void;
    _clearOldTilesNow(): void;
    _disposeTile(group: THREE.Group | null | undefined): void;
    _invalidateAllTiles(): void;

    // --- lifecycle ---
    setVisible(visible: boolean): void;
    _applyRenderOrder(baseOrder: number): void;
    _mergeStyles(base: Record<string, any>, overrides: Record<string, any>): Record<string, any>;
    addTo(map: any): this;
    removeFromMap(): void;
    addExclusionArea(collection: any, layers: string[]): this;
    _postUpdate(map: any): void;
}

// ============================================================================
// Mixins
// ============================================================================

function applyMixin(target: any, mixin: any): void {
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