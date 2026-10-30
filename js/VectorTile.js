// @ts-nocheck
// VectorTile.js
import { THREE, Line2, LineMaterial, LineSegmentsGeometry, } from './js_TP/tpb.js';
import { DEFAULT_STYLES } from './vectorTileDefaults.js';
import { stringToBase64, createWorkerCode, } from './vectorTileWorkerCode.js';
import { Projections } from './Projections.js';
import { VectorLineLabelSource } from './LineLabelSource.js';
// -----------------------------------------------------------------------------
// Кэш Blob-URL для кода воркера.
// URL разделяется между всеми экземплярами VectorTile, использующими
// одинаковые workerScripts.
// -----------------------------------------------------------------------------
const _workerBlobUrlCache = new Map();
function _getSharedWorkerBlobUrl(tpbUrl, earcutUrl) {
    const key = tpbUrl + '|' + earcutUrl;
    const cached = _workerBlobUrlCache.get(key);
    if (cached)
        return cached;
    const promise = (async () => {
        const [tpbRes, earcutRes] = await Promise.all([
            fetch(tpbUrl),
            fetch(earcutUrl),
        ]);
        if (!tpbRes.ok) {
            throw new Error(`HTTP ${tpbRes.status} for ${tpbUrl}`);
        }
        if (!earcutRes.ok) {
            throw new Error(`HTTP ${earcutRes.status} for ${earcutUrl}`);
        }
        const [tpbCode, earcutCode] = await Promise.all([
            tpbRes.text(),
            earcutRes.text(),
        ]);
        const tpbDataURL = 'data:text/javascript;base64,' + stringToBase64(tpbCode);
        const earcutDataURL = 'data:text/javascript;base64,' + stringToBase64(earcutCode);
        const workerCode = createWorkerCode(tpbDataURL, earcutDataURL);
        const blob = new Blob([workerCode], {
            type: 'text/javascript',
        });
        return URL.createObjectURL(blob);
    })();
    _workerBlobUrlCache.set(key, promise);
    promise.catch(() => {
        _workerBlobUrlCache.delete(key);
    });
    return promise;
}
// -----------------------------------------------------------------------------
// Источник подписи для точечных объектов.
// -----------------------------------------------------------------------------
class VectorPointLabelSource {
    constructor(map, worldX, worldZ, text, options = {}) {
        this.map = map;
        this.worldPos = new THREE.Vector3(worldX, 0, worldZ);
        this.text = text;
        this.options = options;
    }
    getText() {
        return this.text;
    }
    getLabelType() {
        return 'point';
    }
    getScreenPosition() {
        const v = this.map
            .getVec3()
            .copy(this.worldPos)
            .add(this.map.worldGroup.position);
        v.project(this.map.camera);
        const rect = this.map.renderer.domElement.getBoundingClientRect();
        return {
            x: (v.x * 0.5 + 0.5) * rect.width,
            y: (-v.y * 0.5 + 0.5) * rect.height,
        };
    }
    getTextStyle() {
        return {
            color: this.options.textColor || '#333333',
            fontSize: this.options.fontSize || '12px',
            fontFamily: this.options.fontFamily || 'sans-serif',
            fontWeight: this.options.fontWeight || 'normal',
            textShadow: this.options.textShadow || '',
            textTransform: this.options.textTransform || '',
            fontStyle: this.options.textFontStyle || '',
            letterSpacing: this.options.textLetterSpacing || '',
        };
    }
    getPriority() {
        return this.options.priority || 0;
    }
    getTitleAlign() {
        return this.options.textAlign || 'center';
    }
    getTitleVerticalAlign() {
        return this.options.textVerticalAlign || 'center';
    }
    getTitleOffset() {
        return this.options.textOffset || [0, 0];
    }
    getTextZoomBounds() {
        return this.options.zoomBounds || {
            min: 0,
            max: 24,
        };
    }
    isVisible() {
        return this.options.visible !== false;
    }
}
// -----------------------------------------------------------------------------
// Порядок отрисовки элементов векторного тайла.
// -----------------------------------------------------------------------------
export const VECTOR_TILE_RENDER_ORDER = {
    FILL: 10,
    LINE: 20,
    STROKE: 25,
    POINT: 30,
    BUILDING: 5000,
    EDGE: 5001,
};
const FLAT_Y_OFFSET = 0.5;
const FLAT_Y_STEP = 0.002;
function _flatY(renderOrder) {
    return FLAT_Y_OFFSET + (renderOrder || 0) * FLAT_Y_STEP;
}
let _nextVectorLabelLayerId = 1;
// -----------------------------------------------------------------------------
// Основной класс.
// -----------------------------------------------------------------------------
/**
 * Векторный тайловый слой.
 *
 * Основные понятия:
 *
 * 1. Зум камеры — глобальный зум карты.
 * 2. Зум видимости слоя — minZoom / maxZoom.
 * 3. Зум данных источника — minNativeZoom / maxNativeZoom.
 *
 * zoomOffset изменяет запрашиваемый зум данных относительно зума карты.
 *
 * Переход между LOD выполняется через два набора групп:
 *
 * - _oldTileGroups — старые группы, временно оставшиеся видимыми;
 * - _tileCache — группы текущего LOD.
 *
 * Старая группа скрывается только после того, как новые группы,
 * покрывающие её область, готовы. Старые группы не могут снова стать
 * видимыми в рамках того же перехода.
 */
export class VectorTile {
    constructor(options = {}) {
        this.url = options.url;
        this._crsCode = options.crs ?? null;
        this._crs = null;
        this._labelIdPrefix = `vt:${_nextVectorLabelLayerId++}:`;
        // ── Атрибуция ────────────────────────────────────────────────
        this.attributionTitle = options.attributionTitle || '';
        this.attributionUrl = options.attributionUrl || '';
        // ── Видимость слоя ──────────────────────────────────────────
        this.visible = options.visible ?? true;
        this.minZoom = options.minZoom ?? 0;
        this.maxZoom = options.maxZoom ?? Infinity;
        // ── Зум доступных данных источника ──────────────────────────
        if (options.maxSourceZoom !== undefined &&
            options.maxNativeZoom === undefined) {
            console.warn('VectorTile: опция maxSourceZoom устарела, ' +
                'используйте maxNativeZoom. ' +
                'Значение maxSourceZoom будет использовано как maxNativeZoom.');
        }
        if (options.minSourceZoom !== undefined &&
            options.minNativeZoom === undefined) {
            console.warn('VectorTile: опция minSourceZoom устарела, ' +
                'используйте minNativeZoom. ' +
                'Значение minSourceZoom будет использовано как minNativeZoom.');
        }
        this.minNativeZoom =
            options.minNativeZoom ??
                options.minSourceZoom ??
                0;
        this.maxNativeZoom =
            options.maxNativeZoom ??
                options.maxSourceZoom ??
                14;
        this.lineWidthMultiplier =
            options.lineWidthMultiplier ?? 1.0;
        this.fillOpacity =
            options.fillOpacity ?? 1.0;
        this.depthTest =
            options.depthTest ?? false;
        this.visibleLayers =
            options.visibleLayers || null;
        this.zoomOffset =
            options.zoomOffset ?? 0;
        this.buildings3d =
            options.buildings3d ?? true;
        this.buildings3dMinZoom =
            options.buildings3dMinZoom ?? 17;
        this.buildingEdges =
            options.buildingEdges ?? true;
        // ── Подписи ─────────────────────────────────────────────────
        this.maxTextLabels =
            options.maxTextLabels ?? 500;
        this.maxTextPointsPerTile =
            options.maxTextPointsPerTile ?? 500;
        this.maxTextLinesPerTile =
            options.maxTextLinesPerTile ?? 500;
        this.labelDistanceSortZoom =
            options.labelDistanceSortZoom ?? 17;
        this.labelMaxPerTileClose =
            options.labelMaxPerTileClose ?? 20;
        this.labelCullMargin =
            options.labelCullMargin ?? 250;
        this.labelMaxCameraDistance =
            options.labelMaxCameraDistance ?? 0;
        // ── Подписи линейных объектов ────────────────────────────────
        this.lineLabelTracking =
            options.lineLabelTracking ?? 1.35;
        this.lineLabelPriorityMode =
            options.lineLabelPriorityMode ?? 'tile';
        this.lineLabelHysteresisPx =
            options.lineLabelHysteresisPx ?? 40;
        this.lineLabelPlacement =
            options.lineLabelPlacement ?? 'auto';
        this._debug =
            options.debug ?? false;
        this._styles = this._mergeStyles(DEFAULT_STYLES, options.styles || {});
        // ── Сцена и порядок слоя ─────────────────────────────────────
        this._tileGroupRenderOrder =
            options.tileGroupRenderOrder ?? 1_000_000;
        this._map = null;
        this._rootGroup = new THREE.Group();
        this._rootGroup.visible = this.visible;
        this._rootGroup.renderOrder = this._tileGroupRenderOrder;
        // ── Текущий кэш тайлов ───────────────────────────────────────
        this._tileCache = new Map();
        // key -> generation.
        //
        // Одного Set недостаточно: после смены поколения старый async
        // запрос может завершиться позже и удалить из Set уже новый
        // запрос с тем же ключом.
        this._pendingLoads = new Set();
        this._pendingLoadGenerations = new Map();
        this._sortedLoadQueue = [];
        this._activeLoads = 0;
        this._maxConcurrent =
            options.maxConcurrent ?? 4;
        this._queueInterval =
            options.queueInterval ?? 250;
        this._queueTimer = null;
        // ── Состояние LOD ────────────────────────────────────────────
        this._lastSourceZoom = -1;
        this._lastDiscreteZoom = -1;
        this._lastUpdateTime = 0;
        this._throttle =
            options.updateThrottle ?? 500;
        /**
         * Поколение текущего состояния слоя.
         *
         * Любой переход LOD, очистка тайлов, удаление слоя или
         * инвалидирование данных увеличивает это число.
         */
        this._generation = 0;
        /**
         * Style zoom, зафиксированный на время одного перехода.
         *
         * Нельзя брать styleZoom из map.currentDiscreteZoom внутри
         * каждого отдельного worker-запроса: соседние тайлы могут
         * собраться с разными версиями стиля.
         */
        this._transitionStyleZoom = NaN;
        // ── Кэш исходных protobuf-данных ─────────────────────────────
        this._tileDataCache = new Map();
        this._tileDataCacheMaxSize =
            options.tileDataCacheMaxSize ?? 200;
        // ── Старые группы во время перехода ──────────────────────────
        this._oldTileGroups = null;
        /**
         * Старые группы, которые уже были выключены в рамках текущего
         * перехода. Они не должны снова становиться видимыми при
         * следующем изменении _requiredKeys.
         */
        this._retiredOldKeys = new Set();
        // ── Кэш готовых групп ────────────────────────────────────────
        this._groupCache = new Map();
        this._groupCacheMaxSize =
            options.groupCacheMaxSize ?? 100;
        // ── Материалы ────────────────────────────────────────────────
        this._fillMaterialCache = new Map();
        this._lineMaterialCache = new Map();
        this._lineMaterialsSet = new Set();
        this._managedMaterials = new WeakSet();
        this._managedGeometries = new WeakSet();
        this._pointGeometryCache = new Map();
        // ── Полупрозрачность 3D-зданий ───────────────────────────────
        this.buildings3dOpacity =
            options.buildings3dOpacity ?? 1.0; // 1 = полностью непрозрачные
        this.buildings3dEdgeOpacity =
            options.buildings3dEdgeOpacity ?? this.buildings3dOpacity;
        // ── Области исключений ───────────────────────────────────────
        this._exclusionAreas = [];
        this._exclusionLayers = new Set();
        // ── Состояние обновления ────────────────────────────────────
        this._lastCanvasSize = {
            width: 0,
            height: 0,
        };
        this._lastWorldPos = new THREE.Vector3();
        this._lastMovementTime = 0;
        this._lastLabelUpdateTime = 0;
        this._lastCheckCamPos = new THREE.Vector3();
        this._lastCheckZoom = -1;
        this._lastCheckInit = false;
        this._labelsDirty = false;
        // ── Состояние покрытия LOD ──────────────────────────────────
        this._settledKeys = new Set();
        this._requiredKeys = new Set();
        this._coverageDirty = false;
        this._lastIs3d = undefined;
        // Этот параметр используется для динамических ширин линий.
        this._lastStyleZoom = NaN;
        // ── Префетч следующего sourceZoom ───────────────────────────
        this._lastPrefetchZoom = -1;
        this._prefetchInFlight = new Map();
        // ── Временные объекты ────────────────────────────────────────
        this._raycaster = new THREE.Raycaster();
        this._raycastNDC = new THREE.Vector2();
        this._raycastPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
        this._raycastHit = new THREE.Vector3();
        this._tempVec3 = new THREE.Vector3();
        this._canvasSizeVec = new THREE.Vector2();
        // ── Worker ───────────────────────────────────────────────────
        const rawScripts = options.workerScripts || [
            'https://cdn.mapengine.ru/KRB/js_TP/tpb.js',
            'https://cdn.mapengine.ru/KRB/js_TP/earcut.js',
        ];
        this._workerScriptUrls = rawScripts.map((s) => {
            if (/^https?:\/\//i.test(s) ||
                s.startsWith('/')) {
                return s;
            }
            try {
                return new URL(s, window.location.href).href;
            }
            catch (e) {
                console.error('Invalid worker script URL:', s, e);
                return s;
            }
        });
        if (this._workerScriptUrls.length < 2) {
            console.warn('VectorTile: workerScripts должен содержать ' +
                'два URL (tpb.js и earcut.js).');
        }
        this._worker = null;
        this._workerReady = this._initWorker();
        this._requestId = 0;
        this._pendingWorkerRequests = new Map();
    }
    // -------------------------------------------------------------------------
    // Worker
    // -------------------------------------------------------------------------
    async _initWorker() {
        const [tpbUrl, earcutUrl] = this._workerScriptUrls;
        try {
            const blobUrl = await _getSharedWorkerBlobUrl(tpbUrl, earcutUrl);
            this._worker = new Worker(blobUrl, {
                type: 'module',
            });
            this._worker.onmessage = (e) => {
                this._onWorkerMessage(e.data);
            };
            this._worker.onerror = (err) => {
                console.error('VectorTile worker error:', err);
            };
            this._worker.postMessage({
                type: 'config',
                styles: this._styles,
            });
        }
        catch (err) {
            console.error('Failed to initialize worker:', err);
        }
    }
    _onWorkerMessage(data) {
        if (!data ||
            typeof data.id === 'undefined') {
            return;
        }
        const pending = this._pendingWorkerRequests.get(data.id);
        if (!pending) {
            return;
        }
        this._pendingWorkerRequests.delete(data.id);
        if (data.error) {
            if (pending.group) {
                this._disposeTile(pending.group);
            }
            pending.reject(new Error(data.error));
            return;
        }
        if (!data.result) {
            if (pending.group) {
                this._disposeTile(pending.group);
            }
            pending.reject(new Error('Worker returned no result'));
            return;
        }
        // identify не зависит от визуального поколения тайлов.
        if (pending.isIdentify) {
            pending.resolve(data.result);
            return;
        }
        const generationIsCurrent = pending.generation === this._generation;
        const sourceZoomIsCurrent = pending.sourceZoom === this._lastSourceZoom;
        const mapIsCurrent = !!this._map;
        if (!generationIsCurrent ||
            !sourceZoomIsCurrent ||
            !mapIsCurrent) {
            if (pending.group) {
                this._disposeTile(pending.group);
            }
            // Для нового group pending.group равен null.
            // В этом случае группа будет создана ниже только для
            // актуального ответа, поэтому здесь её создавать нельзя.
            pending.resolve(null);
            return;
        }
        const result = data.result;
        const group = pending.group || new THREE.Group();
        try {
            this._buildGroupFromWorkerResult(group, result);
            group.userData.sourceZoom =
                pending.sourceZoom;
            group.userData.styleZoom =
                pending.styleZoom;
            group.userData.generation =
                pending.generation;
        }
        catch (err) {
            console.error('[VectorTile] Failed to build tile group:', err);
            this._disposeTile(group);
            pending.reject(err);
            return;
        }
        // Важно: здесь больше нет _adoptTile().
        //
        // Добавление в _tileCache выполняется только в _loadTile()
        // после повторной проверки generation/sourceZoom. Это исключает
        // двойное добавление и гонки между worker response и LOD transition.
        this._labelsDirty = true;
        pending.resolve(group);
    }
    _buildGroupFromWorkerResult(group, result) {
        this._removeTextLabelsForGroup(group);
        group.renderOrder =
            this._tileGroupRenderOrder;
        if (result.centerX !== undefined &&
            result.centerZ !== undefined) {
            group.position.set(result.centerX, 0, result.centerZ);
        }
        while (group.children.length) {
            const child = group.children[0];
            if (child.geometry &&
                !this._managedGeometries.has(child.geometry)) {
                child.geometry.dispose();
            }
            if (child.material &&
                !this._managedMaterials.has(child.material)) {
                child.material.dispose?.();
            }
            group.remove(child);
        }
        // ── Заливки ──────────────────────────────────────────────────
        for (const fill of result.fills || []) {
            const mat = this._getFillMaterialFromData(fill.layerName, fill.color, fill.opacity);
            const geom = new THREE.BufferGeometry();
            geom.setAttribute('position', new THREE.BufferAttribute(fill.positions, 3));
            if (fill.indices) {
                geom.setIndex(new THREE.BufferAttribute(fill.indices, 1));
            }
            const mesh = new THREE.Mesh(geom, mat);
            const ro = fill.renderOrder ??
                VECTOR_TILE_RENDER_ORDER.FILL;
            mesh.renderOrder = ro;
            mesh.position.y = _flatY(ro);
            group.add(mesh);
        }
        // ── Здания ───────────────────────────────────────────────────
        if (result.buildings &&
            result.buildings.length > 0) {
            const byColor = new Map();
            for (const building of result.buildings) {
                const key = building.color;
                if (!byColor.has(key)) {
                    byColor.set(key, {
                        color: building.color,
                        stroke: building.stroke,
                        pos: [],
                        nrm: [],
                        edg: [],
                    });
                }
                const grouped = byColor.get(key);
                grouped.pos.push(building.positions);
                grouped.nrm.push(building.normals);
                if (building.edgePositions) {
                    grouped.edg.push(building.edgePositions);
                }
            }
            const opacity = this.buildings3dOpacity;
            const isTransparent = opacity < 1;
            for (const grouped of byColor.values()) {
                const geom = new THREE.BufferGeometry();
                geom.setAttribute('position', new THREE.BufferAttribute(this._concatF32(grouped.pos), 3));
                geom.setAttribute('normal', new THREE.BufferAttribute(this._concatF32(grouped.nrm), 3));
                const mesh = new THREE.Mesh(geom, this._getBuildingMaterial(grouped.color, opacity));
                mesh.renderOrder = VECTOR_TILE_RENDER_ORDER.BUILDING;
                group.add(mesh);
                if (this.buildingEdges && grouped.edg.length) {
                    const edgeGeom = new THREE.BufferGeometry();
                    edgeGeom.setAttribute('position', new THREE.BufferAttribute(this._concatF32(grouped.edg), 3));
                    const lines = new THREE.LineSegments(edgeGeom, this._getBuildingEdgeMaterial(grouped.stroke || 0x555555, 
                    // Рёбра при прозрачных зданиях либо отключайте,
                    // либо делайте сильно бледнее — см. п.3
                    isTransparent ? opacity * 0.35 : 1));
                    lines.renderOrder = VECTOR_TILE_RENDER_ORDER.EDGE;
                    group.add(lines);
                }
            }
        }
        // ── Линии ────────────────────────────────────────────────────
        for (const line of result.lines || []) {
            const mat = this._getDynamicLineMaterial(line);
            if (!mat)
                continue;
            this._addFatLineFromPositions(group, line.positions, mat, line.renderOrder);
        }
        // ── Контуры ──────────────────────────────────────────────────
        for (const stroke of result.strokes || []) {
            const mat = this._getLineMaterialFromData(stroke.layerName, stroke.color, stroke.width, stroke.dash);
            this._addFatLineFromPositions(group, stroke.positions, mat, stroke.renderOrder);
        }
        // ── Точечные объекты ─────────────────────────────────────────
        for (const pt of result.points || []) {
            const fillKey = `fill:${pt.layerName}:` +
                `${pt.color.toString(16)}:` +
                `${pt.opacity}`;
            const mat = this._getFillMaterial(fillKey);
            const geometry = this._getPointGeometry(pt.radius);
            const mesh = new THREE.Mesh(geometry, mat);
            const ro = pt.renderOrder ??
                VECTOR_TILE_RENDER_ORDER.BUILDING;
            mesh.position.set(pt.x, _flatY(ro), pt.z);
            mesh.renderOrder = ro;
            group.add(mesh);
        }
        // ── Данные подписей ─────────────────────────────────────────
        group.userData.textPointsData =
            result.textPoints || [];
        group.userData.textLinesData =
            result.textLines || [];
        group.userData.lineLabelSources =
            null;
        group.userData.textLabels =
            [];
        group.userData.is3d =
            !!result.is3d;
    }
    _fatLineSegmentsFromPositions(positions) {
        if (!positions ||
            positions.length < 6) {
            return null;
        }
        const out = [];
        let havePrev = false;
        let prevX = 0;
        let prevY = 0;
        let prevZ = 0;
        for (let i = 0; i < positions.length; i += 3) {
            const x = positions[i];
            const y = positions[i + 1];
            const z = positions[i + 2];
            if (Number.isNaN(x)) {
                havePrev = false;
                continue;
            }
            if (havePrev) {
                out.push(prevX, prevY, prevZ, x, y, z);
            }
            prevX = x;
            prevY = y;
            prevZ = z;
            havePrev = true;
        }
        return out.length > 0
            ? new Float32Array(out)
            : null;
    }
    _addFatLineFromPositions(group, positions, material, renderOrder) {
        const segs = this._fatLineSegmentsFromPositions(positions);
        if (!segs)
            return;
        const lGeo = new LineSegmentsGeometry();
        lGeo.setPositions(segs);
        const lineObj = new Line2(lGeo, material);
        if (material.dashed) {
            if (typeof lineObj.computeLineDistances ===
                'function') {
                lineObj.computeLineDistances();
            }
            else if (typeof lGeo.computeLineDistances ===
                'function') {
                lGeo.computeLineDistances();
            }
            else {
                console.warn('[VectorTile] ' +
                    'computeLineDistances() недоступен ' +
                    'ни у Line2, ни у ' +
                    'LineSegmentsGeometry. ' +
                    'Пунктир не будет работать.');
            }
        }
        lineObj.renderOrder =
            renderOrder ??
                VECTOR_TILE_RENDER_ORDER.LINE;
        lineObj.position.y = _flatY(lineObj.renderOrder);
        lineObj.frustumCulled = false;
        group.add(lineObj);
    }
    // -------------------------------------------------------------------------
    // Видимость и стек слоёв
    // -------------------------------------------------------------------------
    setVisible(visible) {
        const v = !!visible;
        if (this.visible === v) {
            return;
        }
        this.visible = v;
        if (this._rootGroup) {
            this._rootGroup.visible = v;
        }
        this._lastCheckInit = false;
        this._lastDiscreteZoom = -1;
        this._labelsDirty = true;
        if (!v) {
            this._map?.textManager?.pruneStaleLabels(new Set(), this);
            this._sortedLoadQueue = [];
            if (this._queueTimer) {
                clearTimeout(this._queueTimer);
                this._queueTimer = null;
            }
            if (this._map?.textManager) {
                this._tileCache.forEach((group) => {
                    this._removeTextLabelsForGroup(group);
                });
                this._oldTileGroups?.forEach((group) => {
                    this._removeTextLabelsForGroup(group);
                });
            }
        }
    }
    _applyRenderOrder(baseOrder) {
        if (this._tileGroupRenderOrder ===
            baseOrder) {
            return;
        }
        this._tileGroupRenderOrder =
            baseOrder;
        if (this._rootGroup) {
            this._rootGroup.renderOrder =
                baseOrder;
        }
        this._tileCache.forEach((group) => {
            group.renderOrder = baseOrder;
        });
        this._oldTileGroups?.forEach((group) => {
            group.renderOrder = baseOrder;
        });
        // Важно: группы из groupCache тоже могут быть возвращены
        // в сцену позднее.
        this._groupCache.forEach((group) => {
            group.renderOrder = baseOrder;
        });
    }
    _getPointLabelId(pt, group) {
        const layer = pt.layerName ?? pt.sourceLayer ?? '';
        const featureId = pt.featureId ?? pt.id;
        // Лучший вариант: идентификатор объекта, одинаковый на разных LOD.
        if (featureId != null) {
            return this._labelIdPrefix + JSON.stringify(['point', layer, featureId, pt.text]);
        }
        // Запасной вариант: текст и координаты в пространстве worldGroup.
        // Положение worldGroup в сцене сюда не входит.
        const x = Number((pt.x + group.position.x).toPrecision(12));
        const z = Number((pt.z + group.position.z).toPrecision(12));
        return this._labelIdPrefix + JSON.stringify(['point', layer, pt.text, x, z]);
    }
    // -------------------------------------------------------------------------
    // Покрытие / переход LOD
    // -------------------------------------------------------------------------
    _is3dNow() {
        return (this.buildings3d &&
            (this._map?.currentDiscreteZoom ?? 0) >=
                this.buildings3dMinZoom);
    }
    _getCurrentTileStyleZoom(map = this._map) {
        if (!map)
            return 0;
        const discreteZoom = Number.isFinite(map.currentDiscreteZoom)
            ? map.currentDiscreteZoom
            : 0;
        return discreteZoom + this.zoomOffset;
    }
    /**
     * LOD выбирается по целевому зуму с гистерезисом.
     */
    _pickSourceZoom(map) {
        const clamp = (z) => Math.max(this.minNativeZoom, Math.min(z, this.maxNativeZoom));
        const rawTarget = map.targetZoom !== undefined
            ? map.targetZoom
            : (map._cameraAnimation?.endZoom ??
                map.targetContinuousZoom);
        const target = (Number.isFinite(rawTarget)
            ? rawTarget
            : map.continuousZoom) +
            this.zoomOffset;
        const current = this._lastSourceZoom;
        if (current >= 0 &&
            Math.abs(target - current) < 0.65) {
            return current;
        }
        return clamp(Math.round(target));
    }
    _isTileRequestCurrent(map, generation, sourceZoom, styleZoom) {
        return (this._map === map &&
            this._generation === generation &&
            this._lastSourceZoom === sourceZoom &&
            this._transitionStyleZoom === styleZoom);
    }
    _adoptTile(key, group, visible = false, generation = this._generation, styleZoom = this._transitionStyleZoom) {
        if (!group) {
            return false;
        }
        const comma = key.indexOf(',');
        const tileZoom = Number(key.slice(0, comma));
        const valid = !!this._map &&
            generation === this._generation &&
            tileZoom === this._lastSourceZoom &&
            styleZoom === this._transitionStyleZoom;
        if (!valid) {
            this._disposeTile(group);
            return false;
        }
        group.userData.sourceZoom =
            tileZoom;
        group.userData.styleZoom =
            styleZoom;
        group.userData.generation =
            generation;
        group.visible = !!visible;
        if (group.parent !== this._rootGroup) {
            this._rootGroup.add(group);
        }
        this._tileCache.set(key, group);
        this._coverageDirty = true;
        this._labelsDirty = true;
        return true;
    }
    _stashGroup(key, group) {
        if (!group)
            return;
        this._rootGroup.remove(group);
        group.visible = true;
        this._removeTextLabelsForGroup(group);
        const previous = this._groupCache.get(key);
        if (previous &&
            previous !== group) {
            this._disposeTile(previous);
        }
        this._groupCache.delete(key);
        this._groupCache.set(key, group);
        while (this._groupCache.size >
            this._groupCacheMaxSize) {
            const oldestKey = this._groupCache.keys().next().value;
            const oldestGroup = this._groupCache.get(oldestKey);
            this._groupCache.delete(oldestKey);
            if (oldestGroup) {
                this._disposeTile(oldestGroup);
            }
        }
    }
    _beginTransition(newZ, styleZoom) {
        this._generation++;
        const fallback = new Map();
        const take = (group, key) => {
            if (group.visible &&
                group.parent) {
                fallback.set(key, group);
            }
            else {
                this._stashGroup(key, group);
            }
        };
        this._oldTileGroups?.forEach(take);
        this._tileCache.forEach(take);
        this._oldTileGroups =
            fallback.size > 0
                ? fallback
                : null;
        this._retiredOldKeys.clear();
        this._tileCache = new Map();
        this._pendingLoads.clear();
        this._pendingLoadGenerations.clear();
        this._sortedLoadQueue = [];
        this._settledKeys.clear();
        this._requiredKeys = new Set();
        this._lastSourceZoom = newZ;
        this._transitionStyleZoom =
            Number.isFinite(styleZoom)
                ? styleZoom
                : this._getCurrentTileStyleZoom();
        this._lastPrefetchZoom = -1;
        this._labelsDirty = true;
        this._coverageDirty = true;
    }
    _resolveCoverage() {
        this._coverageDirty = false;
        const old = this._oldTileGroups;
        let changed = false;
        const setVis = (group, visible) => {
            if (!group)
                return;
            if (group.visible !== visible) {
                group.visible = visible;
                changed = true;
            }
        };
        const required = this._requiredKeys;
        // Если старых групп нет, показываем только группы,
        // которые действительно входят в текущий viewport.
        if (!old) {
            this._tileCache.forEach((group, key) => {
                setVis(group, required.has(key));
            });
            if (changed) {
                this._refreshTextLabelsForVisibleTiles();
            }
            return;
        }
        if (required.size === 0) {
            return;
        }
        const zn = this._lastSourceZoom;
        const parse = (key) => key.split(',').map(Number);
        const isDone = (key) => this._tileCache.has(key) ||
            this._settledKeys.has(key);
        // ВАЖНО:
        // сюда попадают только реально нужные новые ключи.
        // Нельзя добавлять сюда все группы _tileCache:
        // иначе случайная устаревшая группа снова начинает участвовать
        // в покрытии и может вызвать моргание.
        const newKeys = new Set(required);
        const oldLinks = new Map();
        const newLinks = new Map();
        const push = (map, key, value) => {
            let list = map.get(key);
            if (!list) {
                list = [];
                map.set(key, list);
            }
            list.push(value);
        };
        const link = (oldKey, newKey) => {
            push(oldLinks, oldKey, newKey);
            push(newLinks, newKey, oldKey);
        };
        const ancestorIndex = new Map();
        const ancestorsAt = (oldZoom) => {
            let index = ancestorIndex.get(oldZoom);
            if (index) {
                return index;
            }
            index = new Map();
            const shift = zn - oldZoom;
            for (const newKey of newKeys) {
                const [, x, y] = parse(newKey);
                push(index, `${oldZoom},${x >> shift},${y >> shift}`, newKey);
            }
            ancestorIndex.set(oldZoom, index);
            return index;
        };
        // Строим связи старых и новых тайлов.
        old.forEach((group, oldKey) => {
            const [oldZoom, oldX, oldY] = parse(oldKey);
            if (oldZoom >= zn) {
                const shift = oldZoom - zn;
                const newKey = `${zn},${oldX >> shift},${oldY >> shift}`;
                if (newKeys.has(newKey)) {
                    link(oldKey, newKey);
                }
            }
            else {
                const descendants = ancestorsAt(oldZoom).get(oldKey) || [];
                for (const newKey of descendants) {
                    link(oldKey, newKey);
                }
            }
        });
        let anyOldVisible = false;
        old.forEach((group, oldKey) => {
            // После выключения старый тайл больше не включается
            // повторно в рамках текущего перехода.
            if (this._retiredOldKeys.has(oldKey)) {
                setVis(group, false);
                return;
            }
            const links = oldLinks.get(oldKey);
            const keep = !!links &&
                links.some((newKey) => {
                    return (required.has(newKey) &&
                        !isDone(newKey));
                });
            setVis(group, keep);
            if (keep) {
                anyOldVisible = true;
            }
            else {
                this._retiredOldKeys.add(oldKey);
            }
        });
        // Новые группы показываем только если они входят в текущий
        // viewport и все связанные старые группы уже скрыты.
        this._tileCache.forEach((group, newKey) => {
            if (!required.has(newKey)) {
                setVis(group, false);
                return;
            }
            const links = newLinks.get(newKey);
            const canShow = !links ||
                links.every((oldKey) => {
                    const oldGroup = old.get(oldKey);
                    return (!oldGroup ||
                        !oldGroup.visible);
                });
            setVis(group, canShow);
        });
        if (!anyOldVisible) {
            old.forEach((group, oldKey) => {
                this._stashGroup(oldKey, group);
            });
            this._oldTileGroups = null;
            this._retiredOldKeys.clear();
        }
        if (changed) {
            this._refreshTextLabelsForVisibleTiles();
        }
    }
    _forEachShownGroup(callback) {
        this._tileCache.forEach((group) => {
            if (group.visible) {
                callback(group);
            }
        });
        this._oldTileGroups?.forEach((group) => {
            if (group.visible) {
                callback(group);
            }
        });
    }
    // -------------------------------------------------------------------------
    // Подписи
    // -------------------------------------------------------------------------
    _refreshTextLabelsForVisibleTiles() {
        if (!this._map ||
            !this._map.textManager) {
            return;
        }
        const textManager = this._map.textManager;
        const { candidates } = this._collectLabelCandidates();
        let selected;
        if (candidates.length === 0) {
            selected = [];
        }
        else {
            candidates.sort((a, b) => {
                if (a.priority !==
                    b.priority) {
                    return b.priority - a.priority;
                }
                const aLine = a.type === 'line'
                    ? 1
                    : 0;
                const bLine = b.type === 'line'
                    ? 1
                    : 0;
                if (aLine !== bLine) {
                    return bLine - aLine;
                }
                return a.camDistSq - b.camDistSq;
            });
            const limit = Math.min(candidates.length, this.maxTextLabels);
            selected =
                candidates.slice(0, limit);
        }
        const activeIds = new Set();
        const groupLabels = new Map();
        for (let i = 0; i < selected.length; i++) {
            const candidate = selected[i];
            const group = candidate.group;
            const id = candidate.id;
            if (activeIds.has(id))
                continue;
            activeIds.add(id);
            let source;
            if (candidate.type === 'line') {
                if (!group.userData.lineLabelSources) {
                    group.userData.lineLabelSources = [];
                }
                let cached = group.userData.lineLabelSources[candidate.lnIndex];
                if (!cached) {
                    cached =
                        new VectorLineLabelSource(this._map, candidate.ln, group, {
                            tracking: this.lineLabelTracking,
                            priorityMode: this.lineLabelPriorityMode,
                            hysteresisPx: this.lineLabelHysteresisPx,
                            placement: this.lineLabelPlacement,
                        });
                    group.userData.lineLabelSources[candidate.lnIndex] = cached;
                }
                source = cached;
            }
            else {
                const pt = candidate.pt;
                const localWorldX = pt.x + group.position.x;
                const localWorldZ = pt.z + group.position.z;
                source =
                    new VectorPointLabelSource(this._map, localWorldX, localWorldZ, pt.text, {
                        textColor: pt.textColor,
                        fontSize: pt.fontSize,
                        fontFamily: pt.fontFamily,
                        fontWeight: pt.fontWeight,
                        textShadow: pt.textShadow,
                        textTransform: pt.textTransform,
                        textFontStyle: pt.textFontStyle,
                        textLetterSpacing: pt.textLetterSpacing,
                        textOffset: pt.textOffset,
                        textAlign: pt.textAlign,
                        textVerticalAlign: pt.textVerticalAlign,
                        priority: pt.priority,
                        zoomBounds: pt.zoomBounds,
                    });
            }
            const label = textManager.addLabel(source, id, this);
            let labels = groupLabels.get(group);
            if (!labels) {
                labels = [];
                groupLabels.set(group, labels);
            }
            labels.push(label);
        }
        textManager.pruneStaleLabels(activeIds, this);
        this._tileCache.forEach((group) => {
            group.userData.textLabels =
                groupLabels.get(group) || [];
        });
        this._oldTileGroups?.forEach((group) => {
            group.userData.textLabels =
                groupLabels.get(group) || [];
        });
    }
    _collectLabelCandidates() {
        const map = this._map;
        const camera = map.camera;
        const continuousZoom = map.continuousZoom +
            this.zoomOffset;
        const discreteZoom = map.currentDiscreteZoom;
        const worldOffset = map.worldGroup.position;
        const rect = map.renderer.domElement.getBoundingClientRect();
        const cullMargin = this.labelCullMargin ?? 250;
        const isClose = discreteZoom >=
            (this.labelDistanceSortZoom ?? 17);
        const cameraPos = camera.position;
        const camTargetDist = cameraPos.distanceTo(map.controls.target);
        let maxLabelDist = this.labelMaxCameraDistance;
        if (!(maxLabelDist > 0)) {
            const sinPitch = camTargetDist > 0
                ? Math.max(0, Math.min(1, (cameraPos.y -
                    map.controls.target.y) / camTargetDist))
                : 0;
            maxLabelDist =
                camTargetDist *
                    Math.max(2.0, 12 / (1 + sinPitch * 4));
        }
        const maxLabelDistSq = maxLabelDist * maxLabelDist;
        const camPosX = cameraPos.x;
        const camPosY = cameraPos.y;
        const camPosZ = cameraPos.z;
        const tempVec = this._tempVec3;
        const candidates = [];
        const rectW = rect.width;
        const rectH = rect.height;
        const screenMarginX = rectW > 0
            ? cullMargin / rectW
            : 0;
        const screenMarginY = rectH > 0
            ? cullMargin / rectH
            : 0;
        this._forEachShownGroup((group) => {
            const gx = group.position.x +
                worldOffset.x;
            const gz = group.position.z +
                worldOffset.z;
            const pointData = group.userData.textPointsData;
            if (pointData &&
                pointData.length > 0) {
                const groupIdPrefix = group.uuid + ':';
                for (let i = 0; i < pointData.length; i++) {
                    const pt = pointData[i];
                    const zoomBounds = pt.zoomBounds || {
                        min: 0,
                        max: 24,
                    };
                    if (continuousZoom <
                        zoomBounds.min ||
                        continuousZoom >
                            zoomBounds.max) {
                        continue;
                    }
                    const worldX = pt.x + gx;
                    const worldZ = pt.z + gz;
                    const camDx = worldX - camPosX;
                    const camDy = -camPosY;
                    const camDz = worldZ - camPosZ;
                    const camDistSq = camDx * camDx +
                        camDy * camDy +
                        camDz * camDz;
                    if (camDistSq >
                        maxLabelDistSq) {
                        continue;
                    }
                    tempVec
                        .set(worldX, 0, worldZ)
                        .project(camera);
                    if (tempVec.z > 1 ||
                        tempVec.z < -1) {
                        continue;
                    }
                    const sx = (tempVec.x * 0.5 + 0.5) *
                        rectW;
                    const sy = (-tempVec.y * 0.5 + 0.5) *
                        rectH;
                    if (sx < -cullMargin ||
                        sx > rectW + cullMargin ||
                        sy < -cullMargin ||
                        sy > rectH + cullMargin) {
                        continue;
                    }
                    candidates.push({
                        type: 'point',
                        pt,
                        group,
                        id: this._getPointLabelId(pt, group),
                        camDistSq,
                        priority: pt.priority || 0,
                        sx,
                        sy,
                    });
                }
            }
            const lineData = group.userData.textLinesData;
            if (lineData &&
                lineData.length > 0) {
                const groupIdPrefix = this._labelIdPrefix + group.uuid + ':L';
                for (let i = 0; i < lineData.length; i++) {
                    const ln = lineData[i];
                    const zoomBounds = ln.zoomBounds || {
                        min: 0,
                        max: 24,
                    };
                    if (continuousZoom <
                        zoomBounds.min ||
                        continuousZoom >
                            zoomBounds.max) {
                        continue;
                    }
                    const pts = ln.points;
                    if (!pts ||
                        pts.length < 2) {
                        continue;
                    }
                    const step = Math.max(1, Math.floor(pts.length / 20));
                    let minDistSq = Infinity;
                    let minTx = Infinity;
                    let maxTx = -Infinity;
                    let minTy = Infinity;
                    let maxTy = -Infinity;
                    let hasValidPoints = false;
                    for (let k = 0; k < pts.length; k += step) {
                        const worldX = pts[k].x + gx;
                        const worldZ = pts[k].z + gz;
                        const camDx = worldX - camPosX;
                        const camDy = -camPosY;
                        const camDz = worldZ - camPosZ;
                        const d2 = camDx * camDx +
                            camDy * camDy +
                            camDz * camDz;
                        if (d2 < minDistSq) {
                            minDistSq = d2;
                        }
                        tempVec
                            .set(worldX, 0, worldZ)
                            .project(camera);
                        if (tempVec.z > -1 &&
                            tempVec.z < 1) {
                            hasValidPoints = true;
                            if (tempVec.x < minTx) {
                                minTx = tempVec.x;
                            }
                            if (tempVec.x > maxTx) {
                                maxTx = tempVec.x;
                            }
                            if (tempVec.y < minTy) {
                                minTy = tempVec.y;
                            }
                            if (tempVec.y > maxTy) {
                                maxTy = tempVec.y;
                            }
                        }
                    }
                    if (!hasValidPoints) {
                        continue;
                    }
                    const anyOnScreen = maxTx >=
                        -1 - screenMarginX &&
                        minTx <=
                            1 + screenMarginX &&
                        maxTy >=
                            -1 - screenMarginY &&
                        minTy <=
                            1 + screenMarginY;
                    if (!anyOnScreen) {
                        continue;
                    }
                    if (minDistSq >
                        maxLabelDistSq) {
                        continue;
                    }
                    candidates.push({
                        type: 'line',
                        ln,
                        lnIndex: i,
                        group,
                        id: groupIdPrefix + i,
                        camDistSq: minDistSq,
                        priority: ln.priority || 0,
                    });
                }
            }
        });
        return {
            candidates,
            isClose,
        };
    }
    _removeTextLabelsForGroup(group) {
        if (!group?.userData)
            return;
        const manager = this._map?.textManager;
        for (const label of group.userData.textLabels || []) {
            if (label._vectorOwner === this)
                continue;
            manager?.removeLabel(label);
        }
        group.userData.textLabels = [];
    }
    // -------------------------------------------------------------------------
    // Материалы
    // -------------------------------------------------------------------------
    _getFillMaterialFromData(layerName, color, opacity) {
        const op = opacity ?? 1;
        const key = `fill:${layerName}:` +
            `${color.toString(16)}:${op}`;
        return this._getFillMaterial(key);
    }
    _getLineMaterialFromData(layerName, color, width, dash) {
        const dashKey = dash
            ? dash.join(',')
            : 'none';
        const key = `line:${layerName}:` +
            `${color.toString(16)}:` +
            `${width}:${dashKey}`;
        return this._getLineMaterial(key, dash);
    }
    _getDynamicLineMaterial(line) {
        if (!this._map) {
            return null;
        }
        const wKey = typeof line.width === 'number'
            ? String(line.width)
            : JSON.stringify((line.width &&
                line.width.stops) ||
                line.width);
        const add = line.widthAdd || 0;
        const dashKey = line.dash
            ? line.dash.join(',')
            : 'none';
        const key = `dline:${line.layerName}:` +
            `${line.color.toString(16)}:` +
            `${wKey}+${add}:${dashKey}`;
        let mat = this._lineMaterialCache.get(key);
        if (mat) {
            return mat;
        }
        const canvas = this._map.renderer.domElement;
        const opts = {
            color: line.color,
            linewidth: 1,
            resolution: new THREE.Vector2(canvas.clientWidth, canvas.clientHeight),
            // Для плоского векторного слоя depthTest
            // должен управляться настройкой слоя.
            depthTest: this.depthTest === true,
            depthWrite: false,
        };
        if (line.dash &&
            Array.isArray(line.dash) &&
            line.dash.length >= 2) {
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
    }
    _evalCurve(c, z) {
        if (typeof c === 'number') {
            return c;
        }
        if (!c ||
            !c.stops ||
            c.stops.length === 0) {
            return 0;
        }
        const stops = c.stops;
        if (z <= stops[0][0]) {
            return stops[0][1];
        }
        for (let i = 1; i < stops.length; i++) {
            if (z <= stops[i][0]) {
                const t = (z - stops[i - 1][0]) /
                    (stops[i][0] - stops[i - 1][0]);
                return (stops[i - 1][1] +
                    (stops[i][1] -
                        stops[i - 1][1]) * t);
            }
        }
        return stops[stops.length - 1][1];
    }
    _updateDynamicLineMaterials(zoom) {
        if (Math.abs(zoom - this._lastStyleZoom) < 0.005) {
            return;
        }
        this._lastStyleZoom = zoom;
        for (const mat of this._lineMaterialsSet) {
            const d = mat.userData.dyn;
            if (!d) {
                continue;
            }
            const base = this._evalCurve(d.width, zoom);
            mat.linewidth =
                (base +
                    (d.add || 0)) *
                    this.lineWidthMultiplier;
            mat.visible =
                mat.linewidth > 0 &&
                    !(d.hideBelow != null &&
                        base <= d.hideBelow);
            if (mat.dashed &&
                d.dashZ != null) {
                mat.dashScale =
                    Math.pow(2, zoom - d.dashZ);
            }
        }
    }
    // -------------------------------------------------------------------------
    // Префетч следующего sourceZoom
    // -------------------------------------------------------------------------
    _prefetchNextZoom(z) {
        const map = this._map;
        if (!map) {
            return;
        }
        if (z < this.minNativeZoom ||
            z > this.maxNativeZoom) {
            return;
        }
        const visibleTiles = this._getVisibleTileKeys(z);
        for (const key of visibleTiles) {
            const c1 = key.indexOf(',');
            const c2 = key.indexOf(',', c1 + 1);
            const pz = +key.slice(0, c1);
            const px = +key.slice(c1 + 1, c2);
            const py = +key.slice(c2 + 1);
            const dataKey = `${pz}/${px}/${py}`;
            if (this._tileDataCache.has(dataKey)) {
                continue;
            }
            if (this._prefetchInFlight.has(dataKey)) {
                continue;
            }
            const url = this.url
                .replaceAll('{z}', pz)
                .replaceAll('{x}', px)
                .replaceAll('{y}', py);
            const promise = fetch(url)
                .then((response) => {
                return response.ok
                    ? response.arrayBuffer()
                    : null;
            })
                .then((buffer) => {
                if (buffer &&
                    this._map) {
                    this._setTileDataCache(dataKey, buffer.slice(0));
                }
                return buffer;
            })
                .catch(() => null)
                .finally(() => {
                this._prefetchInFlight.delete(dataKey);
            });
            this._prefetchInFlight.set(dataKey, promise);
        }
    }
    // -------------------------------------------------------------------------
    // Публичные методы
    // -------------------------------------------------------------------------
    addExclusionArea(collection, layers) {
        if (!this._map) {
            throw new Error('VectorTile.addExclusionArea: ' +
                'слой должен быть добавлен на карту ' +
                '(addTo) до вызова addExclusionArea');
        }
        const geometries = [];
        if (collection.type ===
            'FeatureCollection') {
            for (const feature of collection.features) {
                geometries.push(feature.geometry);
            }
        }
        else if (collection.type ===
            'Feature') {
            geometries.push(collection.geometry);
        }
        else if (collection.type) {
            geometries.push(collection);
        }
        else {
            throw new Error('addExclusionArea: invalid GeoJSON object');
        }
        const crs = this._crsCode
            ? Projections.get(this._crsCode)
            : this._map.inputCRS;
        const worldPolygons = [];
        for (const geom of geometries) {
            if (!geom) {
                continue;
            }
            let rings = [];
            if (geom.type ===
                'Polygon') {
                rings = [
                    geom.coordinates[0],
                ];
            }
            else if (geom.type ===
                'MultiPolygon') {
                rings =
                    geom.coordinates.map((poly) => poly[0]);
            }
            else {
                console.warn('addExclusionArea: ' +
                    'unsupported geometry type', geom.type);
                continue;
            }
            for (const ring of rings) {
                const worldRing = ring.map((pt) => {
                    const [x, z] = this._map.project(pt, crs);
                    return { x, z };
                });
                worldPolygons.push(worldRing);
            }
        }
        this._exclusionAreas =
            worldPolygons;
        this._exclusionLayers =
            new Set(layers);
        this._invalidateAllTiles();
        return this;
    }
    _invalidateAllTiles() {
        this._clearAllTiles();
        this._clearGroupCache();
        this._tileDataCache.clear();
        this._prefetchInFlight.clear();
        this._lastSourceZoom = -1;
        this._lastDiscreteZoom = -1;
        this._transitionStyleZoom = NaN;
        this._lastIs3d = undefined;
        this._lastPrefetchZoom = -1;
        this._labelsDirty = true;
        this._lastCheckInit = false;
    }
    _mergeStyles(base, overrides) {
        const merged = JSON.parse(JSON.stringify(base));
        for (const [key, val] of Object.entries(overrides)) {
            if (val &&
                typeof val === 'object' &&
                !Array.isArray(val) &&
                merged[key]) {
                merged[key] =
                    this._mergeStyles(merged[key], val);
            }
            else {
                merged[key] = val;
            }
        }
        return merged;
    }
    addTo(map) {
        if (this._map) {
            this.removeFromMap();
        }
        this._map = map;
        this._crs =
            this._crsCode
                ? Projections.get(this._crsCode)
                : map.inputCRS;
        if (typeof map._getDynamicLayerRenderOrder ===
            'function') {
            this._tileGroupRenderOrder =
                map._getDynamicLayerRenderOrder(this);
        }
        this._rootGroup.renderOrder =
            this._tileGroupRenderOrder;
        this._rootGroup.visible =
            this.visible;
        map.worldGroup.add(this._rootGroup);
        if (!map._dynamicLayers.includes(this)) {
            map._dynamicLayers.push(this);
        }
        if (map.textManager &&
            map.textManager.setMaxLabels) {
            map.textManager.setMaxLabels(this.maxTextLabels);
        }
        this._labelsDirty = true;
        this._lastCheckInit = false;
        return this;
    }
    removeFromMap() {
        if (!this._map) {
            return;
        }
        if (this._queueTimer) {
            clearTimeout(this._queueTimer);
            this._queueTimer = null;
        }
        for (const pending of this._pendingWorkerRequests.values()) {
            try {
                pending.reject(new Error('Layer removed'));
            }
            catch (e) {
                // Ничего не делаем.
            }
        }
        this._pendingWorkerRequests.clear();
        this._clearAllTiles();
        this._rootGroup.parent?.remove(this._rootGroup);
        const index = this._map._dynamicLayers.indexOf(this);
        if (index > -1) {
            this._map._dynamicLayers.splice(index, 1);
        }
        this._map = null;
        this._crs = null;
        this._fillMaterialCache.forEach((material) => material.dispose());
        this._lineMaterialCache.forEach((material) => material.dispose());
        this._lineMaterialsSet.clear();
        this._fillMaterialCache.clear();
        this._lineMaterialCache.clear();
        this._pointGeometryCache.forEach((geometry) => geometry.dispose());
        this._pointGeometryCache.clear();
        this._tileDataCache.clear();
        this._prefetchInFlight.clear();
        this._lastPrefetchZoom = -1;
        this._clearGroupCache();
        if (this._worker) {
            this._worker.terminate();
            this._worker = null;
        }
        this._lastCheckInit = false;
        this._transitionStyleZoom = NaN;
    }
    _clearAllTiles() {
        this._map?.textManager?.pruneStaleLabels(new Set(), this);
        this._generation++;
        this._tileCache.forEach((group) => {
            this._disposeTile(group);
        });
        this._tileCache.clear();
        this._pendingLoads.clear();
        this._pendingLoadGenerations.clear();
        this._sortedLoadQueue = [];
        this._clearOldTilesNow();
        this._settledKeys.clear();
        this._requiredKeys = new Set();
        this._retiredOldKeys.clear();
        this._coverageDirty = false;
        this._labelsDirty = true;
    }
    _clearGroupCache() {
        this._groupCache.forEach((group) => {
            this._disposeTile(group);
        });
        this._groupCache.clear();
    }
    _clearOldTilesNow() {
        if (this._oldTileGroups) {
            this._oldTileGroups.forEach((group) => {
                this._disposeTile(group);
            });
            this._oldTileGroups = null;
        }
        this._retiredOldKeys.clear();
    }
    _disposeTile(group) {
        if (!group) {
            return;
        }
        this._removeTextLabelsForGroup(group);
        group.traverse((child) => {
            if (child === group) {
                return;
            }
            const geometry = child.geometry;
            if (geometry &&
                !this._managedGeometries.has(geometry)) {
                geometry.dispose();
            }
            const material = child.material;
            if (material &&
                !this._managedMaterials.has(material)) {
                material.dispose?.();
            }
        });
        while (group.children.length) {
            group.remove(group.children[0]);
        }
        this._rootGroup.remove(group);
    }
    _setTileDataCache(key, buffer) {
        this._tileDataCache.delete(key);
        this._tileDataCache.set(key, buffer);
        while (this._tileDataCache.size >
            this._tileDataCacheMaxSize) {
            const oldestKey = this._tileDataCache.keys().next().value;
            this._tileDataCache.delete(oldestKey);
        }
    }
    _getTileDataCache(key) {
        const value = this._tileDataCache.get(key);
        if (value === undefined) {
            return undefined;
        }
        this._tileDataCache.delete(key);
        this._tileDataCache.set(key, value);
        return value;
    }
    // -------------------------------------------------------------------------
    // Основное обновление слоя
    // -------------------------------------------------------------------------
    _postUpdate(map) {
        if (!this._map) {
            return;
        }
        // ── Видимость слоя ───────────────────────────────────────────
        if (!this.visible) {
            if (this._rootGroup.visible) {
                this._rootGroup.visible = false;
                if (this._map.textManager) {
                    this._tileCache.forEach((group) => {
                        this._removeTextLabelsForGroup(group);
                    });
                    this._oldTileGroups?.forEach((group) => {
                        this._removeTextLabelsForGroup(group);
                    });
                }
                this._labelsDirty = true;
                this._lastCheckInit = false;
                this._lastDiscreteZoom = -1;
            }
            this._map?.textManager?.pruneStaleLabels(new Set(), this);
            return;
        }
        if (!this._rootGroup.visible) {
            this._rootGroup.visible = true;
            this._lastCheckInit = false;
            this._lastDiscreteZoom = -1;
            this._labelsDirty = true;
        }
        // ── Отслеживание движения мира ──────────────────────────────
        const worldPos = map.worldGroup.position;
        const worldMoved = this._lastWorldPos.distanceToSquared(worldPos) > 1;
        if (worldMoved) {
            this._lastWorldPos.copy(worldPos);
            this._lastMovementTime =
                performance.now();
        }
        // Ширины линий обновляются каждый кадр
        // и не должны ждать полного LOD-прохода.
        this._updateDynamicLineMaterials(map.continuousZoom +
            this.zoomOffset);
        const discreteZoom = map.currentDiscreteZoom;
        const inRange = discreteZoom >= this.minZoom &&
            discreteZoom <= this.maxZoom;
        const currentStyleZoom = this._getCurrentTileStyleZoom(map);
        // ── Смена LOD ────────────────────────────────────────────────
        if (inRange) {
            const is3d = this._is3dNow();
            const sourceZoom = this._pickSourceZoom(map);
            const sourceZoomChanged = sourceZoom !==
                this._lastSourceZoom;
            const modeChanged = is3d !==
                this._lastIs3d;
            const styleZoomChanged = currentStyleZoom !==
                this._transitionStyleZoom;
            if (sourceZoomChanged ||
                modeChanged ||
                styleZoomChanged) {
                this._lastIs3d = is3d;
                this._beginTransition(sourceZoom, currentStyleZoom);
                this._lastUpdateTime = 0;
            }
        }
        if (this._coverageDirty) {
            this._resolveCoverage();
        }
        // ── Обновление подписей ─────────────────────────────────────
        const labelNow = performance.now();
        const timeSinceLastMove = labelNow -
            this._lastMovementTime;
        const isMoving = timeSinceLastMove < 1000;
        const periodicUpdateDue = isMoving &&
            labelNow -
                this._lastLabelUpdateTime >
                1000;
        const settleUpdateDue = timeSinceLastMove > 300 &&
            this._lastLabelUpdateTime <
                this._lastMovementTime;
        if ((this._labelsDirty ||
            settleUpdateDue ||
            periodicUpdateDue) &&
            (this._tileCache.size > 0 ||
                this._oldTileGroups)) {
            this._labelsDirty = false;
            this._lastLabelUpdateTime =
                labelNow;
            this._refreshTextLabelsForVisibleTiles();
        }
        // ── Троттлинг полного прохода ───────────────────────────────
        const now = performance.now();
        if (now -
            this._lastUpdateTime <
            this._throttle) {
            this._processQueue();
            return;
        }
        this._lastUpdateTime = now;
        const camPos = map.camera.position;
        const camChanged = !this._lastCheckInit ||
            this._lastCheckCamPos.distanceToSquared(camPos) > 0.01 ||
            worldMoved ||
            this._lastCheckZoom !==
                discreteZoom;
        if (!camChanged &&
            !this._labelsDirty &&
            this._tileCache.size > 0) {
            this._processQueue();
            return;
        }
        this._lastCheckInit = true;
        this._lastCheckCamPos.copy(camPos);
        this._lastCheckZoom = discreteZoom;
        if (!inRange) {
            if (this._tileCache.size > 0 ||
                this._oldTileGroups ||
                this._activeLoads > 0) {
                this._clearAllTiles();
            }
            this._lastSourceZoom = -1;
            this._lastDiscreteZoom = -1;
            this._transitionStyleZoom = NaN;
            this._lastIs3d = undefined;
            return;
        }
        if (discreteZoom !==
            this._lastDiscreteZoom) {
            this._labelsDirty = true;
        }
        this._lastDiscreteZoom =
            discreteZoom;
        const sourceZoom = this._lastSourceZoom;
        const continuousZoom = map.continuousZoom;
        const nextSourceZoom = Math.min(sourceZoom + 1, this.maxNativeZoom);
        if (nextSourceZoom > sourceZoom &&
            continuousZoom >
                discreteZoom + 0.3 &&
            this._lastPrefetchZoom !==
                sourceZoom) {
            this._lastPrefetchZoom =
                sourceZoom;
            this._prefetchNextZoom(nextSourceZoom);
        }
        // ── Размер canvas для LineMaterial ──────────────────────────
        const canvas = map.renderer.domElement;
        const w = canvas.clientWidth;
        const h = canvas.clientHeight;
        if (this._lineMaterialsSet.size > 0 &&
            (this._lastCanvasSize.width !== w ||
                this._lastCanvasSize.height !== h)) {
            this._lastCanvasSize.width = w;
            this._lastCanvasSize.height = h;
            this._canvasSizeVec.set(w, h);
            this._lineMaterialsSet.forEach((mat) => {
                mat.resolution.copy(this._canvasSizeVec);
            });
        }
        // ── Расчёт требуемых тайлов ──────────────────────────────────
        const visibleTiles = this._getVisibleTileKeys(sourceZoom);
        this._requiredKeys =
            visibleTiles;
        this._coverageDirty = true;
        // Убираем из текущего кэша тайлы, которые
        // больше не входят в viewport.
        for (const key of this._tileCache.keys()) {
            if (!visibleTiles.has(key)) {
                const group = this._tileCache.get(key);
                this._stashGroup(key, group);
                this._tileCache.delete(key);
                const pendingGeneration = this._pendingLoadGenerations.get(key);
                if (pendingGeneration ===
                    this._generation) {
                    this._pendingLoads.delete(key);
                    this._pendingLoadGenerations.delete(key);
                }
                this._labelsDirty = true;
            }
        }
        // ── Формирование очереди загрузки ────────────────────────────
        const maxMerc = map.MAX_MERCATOR;
        const target = map.controls.target;
        const tileSizeAtZoom = map.WORLD_SIZE /
            (1 << sourceZoom);
        const targetX = target.x;
        const targetZ = target.z;
        const unsortedNewKeys = [];
        visibleTiles.forEach((key) => {
            if (this._tileCache.has(key) ||
                this._pendingLoads.has(key)) {
                return;
            }
            const comma1 = key.indexOf(',');
            const comma2 = key.indexOf(',', comma1 + 1);
            const x = +key.slice(comma1 + 1, comma2);
            const y = +key.slice(comma2 + 1);
            const centerX = x * tileSizeAtZoom -
                maxMerc +
                tileSizeAtZoom / 2;
            const centerZ = -maxMerc +
                y * tileSizeAtZoom +
                tileSizeAtZoom / 2;
            const dx = centerX - targetX;
            const dz = centerZ - targetZ;
            unsortedNewKeys.push({
                key,
                distSq: dx * dx +
                    dz * dz,
            });
        });
        unsortedNewKeys.sort((a, b) => a.distSq -
            b.distSq);
        const newKeys = unsortedNewKeys.map((item) => item.key);
        this._sortedLoadQueue =
            newKeys.concat(this._sortedLoadQueue.filter((key) => !this._tileCache.has(key) &&
                !this._pendingLoads.has(key) &&
                visibleTiles.has(key)));
        this._processQueue();
    }
    _processQueue() {
        if (!this.visible) {
            return;
        }
        if (this._activeLoads >=
            this._maxConcurrent) {
            return;
        }
        if (this._sortedLoadQueue.length === 0) {
            return;
        }
        const capacity = this._maxConcurrent -
            this._activeLoads;
        const toLoad = this._sortedLoadQueue.splice(0, capacity);
        for (const key of toLoad) {
            const [z, x, y] = key.split(',').map(Number);
            this._loadTile(z, x, y);
        }
        if (this._sortedLoadQueue.length > 0) {
            clearTimeout(this._queueTimer);
            this._queueTimer =
                setTimeout(() => {
                    this._queueTimer = null;
                    this._processQueue();
                }, this._queueInterval);
        }
    }
    async _loadTile(z, xSlippy, ySlippy) {
        const key = `${z},${xSlippy},${ySlippy}`;
        if (this._pendingLoads.has(key) ||
            this._tileCache.has(key)) {
            return;
        }
        const map = this._map;
        if (!map) {
            return;
        }
        // Снимок состояния на момент постановки запроса.
        const requestGeneration = this._generation;
        const requestStyleZoom = this._transitionStyleZoom;
        const requestSourceZoom = this._lastSourceZoom;
        const isCurrent = () => this._isTileRequestCurrent(map, requestGeneration, z, requestStyleZoom) &&
            requestSourceZoom === z;
        if (!isCurrent()) {
            return;
        }
        let countedAsActive = false;
        const beginLoad = () => {
            this._pendingLoads.add(key);
            this._pendingLoadGenerations.set(key, requestGeneration);
            this._activeLoads++;
            countedAsActive = true;
        };
        const finishLoad = () => {
            if (countedAsActive) {
                this._activeLoads--;
                countedAsActive = false;
            }
            // Старый запрос не должен удалить pending-запись
            // нового запроса с тем же key.
            if (this._pendingLoadGenerations.get(key) === requestGeneration) {
                this._pendingLoads.delete(key);
                this._pendingLoadGenerations.delete(key);
            }
            this._processQueue();
        };
        try {
            // ── Переиспользование старой видимой группы ─────────────
            const fallback = this._oldTileGroups?.get(key);
            if (fallback &&
                fallback.userData.is3d ===
                    this._is3dNow() &&
                fallback.userData.styleZoom ===
                    requestStyleZoom) {
                this._oldTileGroups.delete(key);
                const adopted = this._adoptTile(key, fallback, fallback.visible, requestGeneration, requestStyleZoom);
                if (!adopted) {
                    this._disposeTile(fallback);
                }
                return;
            }
            // ── Переиспользование готовой группы из groupCache ──────
            if (this._groupCache.has(key)) {
                const group = this._groupCache.get(key);
                this._groupCache.delete(key);
                const is3dNow = this._is3dNow();
                const compatible = group &&
                    group.userData.is3d ===
                        is3dNow &&
                    group.userData.styleZoom ===
                        requestStyleZoom;
                if (compatible) {
                    const adopted = this._adoptTile(key, group, false, requestGeneration, requestStyleZoom);
                    if (!adopted) {
                        this._disposeTile(group);
                    }
                    return;
                }
                // Группа подходит по ключу, но собрана
                // для другого режима 2D/3D или другого styleZoom.
                const dataCacheKey = `${z}/${xSlippy}/${ySlippy}`;
                const cached = this._getTileDataCache(dataCacheKey);
                if (cached) {
                    beginLoad();
                    const rebuilt = await this._sendToWorker(cached.slice(0), z, xSlippy, ySlippy, is3dNow, group, requestGeneration, requestStyleZoom);
                    if (!rebuilt) {
                        this._disposeTile(group);
                        return;
                    }
                    if (!isCurrent()) {
                        this._disposeTile(rebuilt);
                        return;
                    }
                    this._adoptTile(key, rebuilt, false, requestGeneration, requestStyleZoom);
                    return;
                }
                this._disposeTile(group);
            }
            // ── Загрузка исходных данных ────────────────────────────
            beginLoad();
            const dataCacheKey = `${z}/${xSlippy}/${ySlippy}`;
            let buffer = this._getTileDataCache(dataCacheKey);
            if (buffer) {
                buffer = buffer.slice(0);
            }
            else {
                const url = this.url
                    .replaceAll('{z}', z)
                    .replaceAll('{x}', xSlippy)
                    .replaceAll('{y}', ySlippy);
                const prefetchPromise = this._prefetchInFlight.get(dataCacheKey);
                if (prefetchPromise) {
                    buffer =
                        await prefetchPromise;
                    if (buffer) {
                        buffer = buffer.slice(0);
                    }
                    if (!isCurrent()) {
                        return;
                    }
                }
                if (!buffer) {
                    const response = await fetch(url);
                    if (!isCurrent()) {
                        return;
                    }
                    if (!response.ok) {
                        throw new Error(`HTTP ${response.status}`);
                    }
                    buffer =
                        await response.arrayBuffer();
                    if (!isCurrent()) {
                        return;
                    }
                    this._setTileDataCache(dataCacheKey, buffer.slice(0));
                }
            }
            if (!buffer || !isCurrent()) {
                return;
            }
            const is3dNow = this._is3dNow();
            const group = await this._sendToWorker(buffer, z, xSlippy, ySlippy, is3dNow, null, requestGeneration, requestStyleZoom);
            if (!group) {
                return;
            }
            if (!isCurrent()) {
                this._disposeTile(group);
                return;
            }
            this._adoptTile(key, group, false, requestGeneration, requestStyleZoom);
        }
        catch (err) {
            // Устаревший запрос не должен менять coverage нового LOD.
            if (isCurrent()) {
                this._settledKeys.add(key);
                this._coverageDirty = true;
                if (this._debug) {
                    console.warn('[VectorTile] Tile load failed:', key, err);
                }
            }
        }
        finally {
            finishLoad();
        }
    }
    // -------------------------------------------------------------------------
    // Identify
    // -------------------------------------------------------------------------
    async identify(sceneX, sceneZ, opts = {}) {
        if (!this._map ||
            !this._worker) {
            return {
                error: 'layer not attached',
            };
        }
        const map = this._map;
        const sourceZoom = this._lastSourceZoom >= 0
            ? this._lastSourceZoom
            : Math.max(this.minNativeZoom, Math.min(map.currentDiscreteZoom +
                this.zoomOffset, this.maxNativeZoom));
        const tileSize = map.WORLD_SIZE /
            (1 << sourceZoom);
        const numTiles = 1 << sourceZoom;
        const localX = sceneX -
            map.worldGroup.position.x;
        const localZ = sceneZ -
            map.worldGroup.position.z;
        const tx = (localX + map.MAX_MERCATOR) /
            tileSize;
        const tz = (localZ + map.MAX_MERCATOR) /
            tileSize;
        const xSlippy = Math.floor(tx);
        const ySlippy = Math.floor(tz);
        if (xSlippy < 0 ||
            xSlippy >= numTiles ||
            ySlippy < 0 ||
            ySlippy >= numTiles) {
            return {
                error: `tile (${xSlippy},${ySlippy}) ` +
                    `outside [0,${numTiles}) ` +
                    `at z=${sourceZoom}`,
            };
        }
        const dataCacheKey = `${sourceZoom}/${xSlippy}/${ySlippy}`;
        let buffer = this._getTileDataCache(dataCacheKey);
        if (buffer) {
            buffer = buffer.slice(0);
        }
        else {
            const url = this.url
                .replaceAll('{z}', sourceZoom)
                .replaceAll('{x}', xSlippy)
                .replaceAll('{y}', ySlippy);
            try {
                const response = await fetch(url);
                if (!response.ok) {
                    return {
                        error: `HTTP ${response.status} ` +
                            `for ${url}`,
                    };
                }
                buffer =
                    await response.arrayBuffer();
                this._setTileDataCache(dataCacheKey, buffer.slice(0));
            }
            catch (err) {
                return {
                    error: `fetch failed: ${err.message}`,
                };
            }
        }
        const centerX = xSlippy * tileSize -
            map.MAX_MERCATOR +
            tileSize / 2;
        const centerZ = -map.MAX_MERCATOR +
            ySlippy * tileSize +
            tileSize / 2;
        const clickLocalX = localX - centerX;
        const clickLocalZ = localZ - centerZ;
        return new Promise((resolve, reject) => {
            const id = ++this._requestId;
            const generation = this._generation;
            this._pendingWorkerRequests.set(id, {
                resolve,
                reject,
                group: null,
                key: null,
                generation,
                sourceZoom,
                styleZoom: Number.isFinite(this._transitionStyleZoom)
                    ? this._transitionStyleZoom
                    : (map.currentDiscreteZoom +
                        this.zoomOffset),
                isIdentify: true,
            });
            try {
                this._worker.postMessage({
                    type: 'identify',
                    id,
                    buffer,
                    z: sourceZoom,
                    x: xSlippy,
                    y: ySlippy,
                    tileSize,
                    maxMerc: map.MAX_MERCATOR,
                    continuousZoom: map.continuousZoom +
                        this.zoomOffset,
                    styleZoom: Number.isFinite(this._transitionStyleZoom)
                        ? this._transitionStyleZoom
                        : (map.currentDiscreteZoom +
                            this.zoomOffset),
                    localX: clickLocalX,
                    localZ: clickLocalZ,
                    tolerance: opts.tolerance ||
                        tileSize * 0.005,
                }, [buffer]);
            }
            catch (err) {
                this._pendingWorkerRequests.delete(id);
                reject(err);
            }
        });
    }
    // -------------------------------------------------------------------------
    // Отправка задания worker
    // -------------------------------------------------------------------------
    async _sendToWorker(buffer, z, x, y, is3d, existingGroup = null, generation = this._generation, styleZoom = this._transitionStyleZoom) {
        if (generation !== this._generation ||
            z !== this._lastSourceZoom) {
            return null;
        }
        await this._workerReady;
        if (generation !== this._generation ||
            z !== this._lastSourceZoom) {
            return null;
        }
        if (!this._worker ||
            !this._map) {
            return null;
        }
        const map = this._map;
        const id = ++this._requestId;
        const tileSize = map.WORLD_SIZE /
            (1 << z);
        const maxMerc = map.MAX_MERCATOR;
        const effectiveStyleZoom = Number.isFinite(styleZoom)
            ? styleZoom
            : this._getCurrentTileStyleZoom(map);
        const msg = {
            type: 'process',
            id,
            buffer,
            z,
            x,
            y,
            tileSize,
            maxMerc,
            is3d,
            continuousZoom: map.continuousZoom +
                this.zoomOffset,
            styleZoom: effectiveStyleZoom,
            visibleLayers: this.visibleLayers,
            buildingEdges: this.buildingEdges,
            exclusionPolygons: this._exclusionAreas,
            exclusionLayers: Array.from(this._exclusionLayers),
            maxTextPointsPerTile: this.maxTextPointsPerTile,
            maxTextLinesPerTile: this.maxTextLinesPerTile,
        };
        return new Promise((resolve, reject) => {
            this._pendingWorkerRequests.set(id, {
                resolve,
                reject,
                group: existingGroup || null,
                key: existingGroup
                    ? null
                    : `${z},${x},${y}`,
                generation,
                sourceZoom: z,
                styleZoom: effectiveStyleZoom,
                isIdentify: false,
            });
            try {
                this._worker.postMessage(msg, [buffer]);
            }
            catch (err) {
                this._pendingWorkerRequests.delete(id);
                reject(err);
            }
        });
    }
    // -------------------------------------------------------------------------
    // Видимые тайлы
    // -------------------------------------------------------------------------
    _getVisibleTileKeys(z) {
        const map = this._map;
        const camera = map.camera;
        const tileSize = map.WORLD_SIZE /
            (1 << z);
        const off = map.worldGroup.position;
        const maxTile = (1 << z) - 1;
        const numTiles = 1 << z;
        const ray = this._raycaster;
        const ndc = this._raycastNDC;
        const plane = this._raycastPlane;
        const hit = this._raycastHit;
        const camXLocal = camera.position.x -
            off.x;
        const camZLocal = camera.position.z -
            off.z;
        let minX = camXLocal;
        let maxX = camXLocal;
        let minZ = camZLocal;
        let maxZ = camZLocal;
        const camTargetDist = camera.position.distanceTo(map.controls.target);
        const maxLoadDist = Math.max(camTargetDist * 6, tileSize * 48);
        const maxLoadDistSq = maxLoadDist * maxLoadDist;
        const minRayY = Math.sin(3 * Math.PI / 180);
        const grid = 5;
        let hitsCount = 0;
        for (let i = 0; i < grid; i++) {
            for (let j = 0; j < grid; j++) {
                const nx = (i / (grid - 1)) * 2 - 1;
                const ny = (j / (grid - 1)) * 2 - 1;
                ndc.set(nx, ny);
                ray.setFromCamera(ndc, camera);
                if (Math.abs(ray.ray.direction.y) < minRayY) {
                    continue;
                }
                if (!ray.ray.intersectPlane(plane, hit)) {
                    continue;
                }
                const dxCam = hit.x -
                    camera.position.x;
                const dzCam = hit.z -
                    camera.position.z;
                if (dxCam * dxCam +
                    dzCam * dzCam >
                    maxLoadDistSq) {
                    continue;
                }
                hitsCount++;
                const lx = hit.x - off.x;
                const lz = hit.z - off.z;
                if (lx < minX)
                    minX = lx;
                if (lx > maxX)
                    maxX = lx;
                if (lz < minZ)
                    minZ = lz;
                if (lz > maxZ)
                    maxZ = lz;
            }
        }
        if (hitsCount < 4) {
            const target = map.controls.target;
            const distance = camera.position.distanceTo(target);
            const vFov = camera.fov *
                Math.PI /
                180;
            const aspect = camera.aspect;
            const hh = distance *
                Math.tan(vFov / 2) *
                aspect *
                2 +
                2 * tileSize;
            const hv = distance *
                Math.tan(vFov / 2) *
                2 +
                2 * tileSize;
            const targetXLocal = target.x - off.x;
            const targetZLocal = target.z - off.z;
            if (targetXLocal - hh <
                minX) {
                minX =
                    targetXLocal - hh;
            }
            if (targetXLocal + hh >
                maxX) {
                maxX =
                    targetXLocal + hh;
            }
            if (targetZLocal - hv <
                minZ) {
                minZ =
                    targetZLocal - hv;
            }
            if (targetZLocal + hv >
                maxZ) {
                maxZ =
                    targetZLocal + hv;
            }
        }
        const margin = tileSize * 1.5;
        minX -= margin;
        maxX += margin;
        minZ -= margin;
        maxZ += margin;
        const xMin = Math.floor((minX + map.MAX_MERCATOR) /
            tileSize);
        const xMax = Math.floor((maxX + map.MAX_MERCATOR) /
            tileSize);
        const yMin = Math.max(0, Math.floor((minZ + map.MAX_MERCATOR) /
            tileSize));
        const yMax = Math.min(maxTile, Math.floor((maxZ + map.MAX_MERCATOR) /
            tileSize));
        const keys = new Set();
        for (let y = yMin; y <= yMax; y++) {
            for (let x = xMin; x <= xMax; x++) {
                const wrappedX = (x % numTiles +
                    numTiles) % numTiles;
                keys.add(`${z},${wrappedX},${y}`);
            }
        }
        return keys;
    }
    // -------------------------------------------------------------------------
    // Материалы плоских объектов
    // -------------------------------------------------------------------------
    _getFillMaterial(styleKey) {
        if (this._fillMaterialCache.has(styleKey)) {
            return this._fillMaterialCache.get(styleKey);
        }
        const parts = styleKey.split(':');
        const color = parseInt(parts[2], 16);
        const rawOpacity = parseFloat(parts[3]);
        const opacity = (Number.isNaN(rawOpacity)
            ? 1
            : rawOpacity) *
            this.fillOpacity;
        const mat = new THREE.MeshBasicMaterial({
            color,
            side: THREE.DoubleSide,
            transparent: opacity < 1.0,
            opacity,
            // Плоские векторные объекты не должны
            // неожиданно сравниваться с DEM, если слой
            // не запросил depthTest явно.
            depthTest: this.depthTest === true,
            depthWrite: false,
        });
        this._fillMaterialCache.set(styleKey, mat);
        this._managedMaterials.add(mat);
        return mat;
    }
    _getLineMaterial(styleKey, dash) {
        if (this._lineMaterialCache.has(styleKey)) {
            return this._lineMaterialCache.get(styleKey);
        }
        const parts = styleKey.split(':');
        const color = parseInt(parts[2], 16);
        const width = parseFloat(parts[3]) *
            this.lineWidthMultiplier;
        const matOpts = {
            color,
            linewidth: width,
            resolution: new THREE.Vector2(this._map.renderer.domElement.clientWidth, this._map.renderer.domElement.clientHeight),
            depthTest: this.depthTest === true,
            depthWrite: false,
        };
        if (dash &&
            Array.isArray(dash) &&
            dash.length >= 2) {
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
    }
    _getPointGeometry(radius) {
        const key = `point_${radius}`;
        if (this._pointGeometryCache.has(key)) {
            return this._pointGeometryCache.get(key);
        }
        const geom = new THREE.CircleGeometry(radius, 8);
        geom.rotateX(-Math.PI / 2);
        this._pointGeometryCache.set(key, geom);
        this._managedGeometries.add(geom);
        return geom;
    }
    _concatF32(arrays) {
        let total = 0;
        for (const array of arrays) {
            total += array.length;
        }
        const out = new Float32Array(total);
        let offset = 0;
        for (const array of arrays) {
            out.set(array, offset);
            offset += array.length;
        }
        return out;
    }
    // -------------------------------------------------------------------------
    // Материалы зданий
    // -------------------------------------------------------------------------
    _getBuildingMaterial(color, opacity = 1) {
        const transparent = opacity < 1;
        const key = `bld:${color}:${opacity}`;
        if (this._fillMaterialCache.has(key)) {
            return this._fillMaterialCache.get(key);
        }
        const mat = new THREE.MeshLambertMaterial({
            color,
            side: THREE.FrontSide, // ← всегда FrontSide, БЕЗ BackSide-прохода
            transparent,
            opacity,
            depthTest: true,
            depthWrite: !transparent, // ← не пишем глубину — иначе задние
            //    здания не будут просвечивать
            polygonOffset: true,
            polygonOffsetFactor: 1,
            polygonOffsetUnits: 1,
        });
        this._fillMaterialCache.set(key, mat);
        this._managedMaterials.add(mat);
        return mat;
    }
    _getBuildingEdgeMaterial(color, opacity = 1) {
        const transparent = opacity < 1;
        const key = `bldEdge:${color}:${opacity}`;
        if (this._lineMaterialCache.has(key)) {
            return this._lineMaterialCache.get(key);
        }
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
    }
}
// Обратная совместимость.
export const VectorTileLayer = VectorTile;
