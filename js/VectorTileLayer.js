// VectorTileLayer.js
/**
 * Модуль слоя векторных тайлов (объёмные здания с выделением острых рёбер).
 * Основная логика управления тайлами, материалов и подписей.
 *
 * ПЕРЕХОД LOD (sourceZoom):
 *  — Новые тайлы добавляются в сцену скрытыми.
 *  — Старый тайл скрывается только тогда, когда готовы ВСЕ нужные новые
 *    тайлы на его площади.
 *  — Новый тайл показывается только тогда, когда скрыты все старые,
 *    которые он перекрывает.
 *  Таким образом в каждой точке экрана всегда ровно один LOD; подмена
 *  атомарна в пределах одного старого тайла. Нет двойных дорог, дыр и
 *  мигания подписей при переключении.
 *
 * ВЫБОР LOD:
 *  — `_pickSourceZoom` целится в `targetContinuousZoom` (куда едет камера),
 *    а не в дискретный зум карты. Гистерезис ±0.65 отсекает дребезг при
 *    остановке зума около x.5.
 *
 * ЖИВАЯ ШИРИНА ЛИНИЙ:
 *  — Воркер отдаёт ширину как кривую (число или {stops}), главный поток
 *    каждый кадр пересчитывает linewidth/dashScale по continuousZoom.
 *    Соседние тайлы одного уровня и оба LOD всегда имеют одинаковую
 *    толщину — при переходе ничего не прыгает.
 *
 * ГЛУБИНА:
 *  — Плоские слои упорядочены renderOrder'ом (алгоритм художника) и
 *    используют `depthTest: this.depthTest` (по умолчанию false).
 *  — Здания рисуются ПОСЛЕ всей плоской графики (renderOrder 5000/5001)
 *    со своей depth-записью — их больше не закрашивают парки и вода.
 *
 * ПОДПИСИ ЛИНЕЙНЫХ ОБЪЕКТОВ:
 *  — Используется `VectorLineLabelSource` из `./LineLabelSource.js`.
 *    Для каждой линии предвычисляется набор «кандидатов» (положение
 *    первого символа по полилинии); TextManager выбирает один, чей bbox
 *    не пересекается с более приоритетными подписями. Каждый символ
 *    рендерится отдельным span'ом с индивидуальным rotate — подпись
 *    «огибает» изгибы.
 *  — Поведение настраивается опциями:
 *      • `lineLabelTracking`      — межтекстовый зазор (× ширины текста),
 *      • `lineLabelPriorityMode`  — 'tile' | 'viewport' — приоритет
 *                                   кандидата по удалённости от центра
 *                                   тайла или от центра экрана,
 *      • `lineLabelHysteresisPx`  — «бонус» ранее выбранному кандидату
 *                                   (меньше дрожания при движении),
 *      • `lineLabelPlacement`     — 'auto' | 'above' | 'below' | 'center',
 *                                   жёстко перекрывает textVerticalAlign.
 */

import {
  THREE,
  Line2,
  LineMaterial,
  LineGeometry,
  LineSegmentsGeometry,
} from '../js_TP/tpb.js';
import { DEFAULT_STYLES } from './vectorTileDefaults.js';
import { stringToBase64, createWorkerCode } from './vectorTileWorkerCode.js';
import { Projections } from './Projections.js';
import { VectorLineLabelSource } from './LineLabelSource.js';

// -----------------------------------------------------------------------------
// Кэш Blob-URL для кода воркера (разделяется между всеми инстансами слоя).
// -----------------------------------------------------------------------------
const _workerBlobUrlCache = new Map();

function _getSharedWorkerBlobUrl(tpbUrl, earcutUrl) {
    const key = tpbUrl + '|' + earcutUrl;
    const cached = _workerBlobUrlCache.get(key);
    if (cached) return cached;

    const promise = (async () => {
        const [tpbRes, earcutRes] = await Promise.all([
            fetch(tpbUrl),
            fetch(earcutUrl),
        ]);
        if (!tpbRes.ok) throw new Error(`HTTP ${tpbRes.status} for ${tpbUrl}`);
        if (!earcutRes.ok) throw new Error(`HTTP ${earcutRes.status} for ${earcutUrl}`);
        const [tpbCode, earcutCode] = await Promise.all([
            tpbRes.text(),
            earcutRes.text(),
        ]);
        const tpbDataURL = 'data:text/javascript;base64,' + stringToBase64(tpbCode);
        const earcutDataURL = 'data:text/javascript;base64,' + stringToBase64(earcutCode);
        const workerCode = createWorkerCode(tpbDataURL, earcutDataURL);
        const blob = new Blob([workerCode], { type: 'text/javascript' });
        return URL.createObjectURL(blob);
    })();

    _workerBlobUrlCache.set(key, promise);
    promise.catch(() => _workerBlobUrlCache.delete(key));
    return promise;
}

// -----------------------------------------------------------------------------
// Источник подписи для точечных объектов векторных тайлов.
// -----------------------------------------------------------------------------
class VectorPointLabelSource {
    constructor(map, worldX, worldZ, text, options = {}) {
        this.map = map;
        this.worldPos = new THREE.Vector3(worldX, 0, worldZ);
        this.text = text;
        this.options = options;
    }

    getText() { return this.text; }
    getLabelType() { return 'point'; }

    getScreenPosition() {
        const v = this.map.getVec3()
            .copy(this.worldPos)
            .add(this.map.worldGroup.position);
        v.project(this.map.camera);
        const rect = this.map.renderer.domElement.getBoundingClientRect();
        return {
            x: (v.x * 0.5 + 0.5) * rect.width,
            y: (-v.y * 0.5 + 0.5) * rect.height
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
            letterSpacing: this.options.textLetterSpacing || ''
        };
    }

    getPriority() { return this.options.priority || 0; }
    getTitleAlign() { return this.options.textAlign || 'center'; }
    getTitleVerticalAlign() { return this.options.textVerticalAlign || 'center'; }
    getTitleOffset() { return this.options.textOffset || [0, 0]; }
    getTextZoomBounds() { return this.options.zoomBounds || { min: 0, max: 24 }; }
    isVisible() { return this.options.visible !== false; }
}

/**
 * Порядок отрисовки элементов векторного тайла.
 * Здания (BUILDING/EDGE) вынесены в конец, чтобы они рисовались ПОСЛЕ
 * всей плоской графики (парков, воды, дорог) со своей глубиной.
 * @type {{FILL:number, LINE:number, STROKE:number, POINT:number, BUILDING:number, EDGE:number}}
 */
export const VECTOR_TILE_RENDER_ORDER = {
    FILL:     10,
    LINE:     20,
    STROKE:   25,
    POINT:    30,
    BUILDING: 5000,
    EDGE:     5001
};
const FLAT_Y_OFFSET = 0.5;
const FLAT_Y_STEP   = 0.002;

function _flatY(renderOrder) {
    return FLAT_Y_OFFSET + (renderOrder || 0) * FLAT_Y_STEP;
}

// -----------------------------------------------------------------------------
// Основной класс.
// -----------------------------------------------------------------------------
export class VectorTileLayer {
    constructor(options = {}) {
        this.url = options.url;

        this._crsCode = options.crs ?? null;
        this._crs = null;

        this.minZoom = options.minZoom ?? 0;
        this.maxZoom = options.maxZoom ?? Infinity;
        this.maxSourceZoom = options.maxSourceZoom ?? 14;
        this.lineWidthMultiplier = options.lineWidthMultiplier ?? 1.0;
        this.fillOpacity = options.fillOpacity ?? 1.0;
        this.depthTest = options.depthTest ?? false;
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

        // ── Подписи линейных объектов ────────────────────────────────
        // Прокидываются в VectorLineLabelSource при создании источника.
        /** Межтекстовый зазор, × ширины текста (1.0 = вплотную, 2.0 = разнесено). */
        this.lineLabelTracking     = options.lineLabelTracking     ?? 1.35;
        /** 'tile' — кандидат ближе к центру тайла приоритетнее; 'viewport' — к центру экрана. */
        this.lineLabelPriorityMode = options.lineLabelPriorityMode ?? 'tile';
        /** «Бонус» ранее выбранному кандидату (px²), уменьшает дрожание при движении. */
        this.lineLabelHysteresisPx = options.lineLabelHysteresisPx ?? 40;
        /** 'auto' | 'above' | 'below' | 'center' — жёсткая переустановка вертикали. */
        this.lineLabelPlacement    = options.lineLabelPlacement    ?? 'auto';

        this._debug = options.debug ?? false;

        this._styles = this._mergeStyles(DEFAULT_STYLES, options.styles || {});

        this._tileGroupRenderOrder = options.tileGroupRenderOrder ?? 1_000_000;

        this._map = null;
        this._rootGroup = new THREE.Group();

        this._tileCache = new Map();
        this._pendingLoads = new Set();
        this._sortedLoadQueue = [];
        this._activeLoads = 0;
        this._maxConcurrent = 4;
        this._queueInterval = 250;
        this._queueTimer = null;

        this._lastSourceZoom = -1;
        this._lastDiscreteZoom = -1;
        this._lastUpdateTime = 0;
        this._throttle = 500;

        this._generation = 0;

        this._tileDataCache = new Map();
        this._tileDataCacheMaxSize = options.tileDataCacheMaxSize ?? 200;

        this._oldTileGroups = null;
        this._groupCache = new Map();
        this._groupCacheMaxSize = 100;

        this._fillMaterialCache = new Map();
        this._lineMaterialCache = new Map();
        this._lineMaterialsSet = new Set();

        this._managedMaterials = new WeakSet();
        this._managedGeometries = new WeakSet();

        this._pointGeometryCache = new Map();

        this._exclusionAreas = [];
        this._exclusionLayers = new Set();

        this._lastCanvasSize = { width: 0, height: 0 };
        this._lastWorldPos = new THREE.Vector3();
        this._lastMovementTime = 0;
        this._lastLabelUpdateTime = 0;

        this._lastCheckCamPos = new THREE.Vector3();
        this._lastCheckZoom = -1;
        this._lastCheckInit = false;

        this._labelsDirty = false;

        // ── Переход LOD ───────────────────────────────────────────────
        /** @type {Set<string>} ключи текущего LOD, завершившиеся ошибкой. */
        this._settledKeys = new Set();
        /** @type {Set<string>} видимые ключи текущего LOD. */
        this._requiredKeys = new Set();
        /** @type {boolean} */
        this._coverageDirty = false;
        /** @type {boolean|undefined} */
        this._lastIs3d = undefined;
        /** @type {number} последний зум, для которого считали живые стили. */
        this._lastStyleZoom = NaN;

        // ── Префетч следующего sourceZoom ─────────────────────────────
        /** @type {number} */
        this._lastPrefetchZoom = -1;
        /** @type {Map<string, Promise<ArrayBuffer|null>>} */
        this._prefetchInFlight = new Map();

        this._raycaster = new THREE.Raycaster();
        this._raycastNDC = new THREE.Vector2();
        this._raycastPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
        this._raycastHit = new THREE.Vector3();
        this._tempVec3 = new THREE.Vector3();
        this._canvasSizeVec = new THREE.Vector2();

        const rawScripts = options.workerScripts || [
            'https://cdn.mapengine.ru/KRB/js_TP/tpb.js',
            'https://cdn.mapengine.ru/KRB/js_TP/earcut.js'
        ];
        this._workerScriptUrls = rawScripts.map(s => {
            if (/^https?:\/\//i.test(s) || s.startsWith('/')) return s;
            try {
                return new URL(s, window.location.href).href;
            } catch (e) {
                console.error('Invalid worker script URL:', s, e);
                return s;
            }
        });
        if (this._workerScriptUrls.length < 2) {
            console.warn('VectorTileLayer: workerScripts должен содержать два URL (tpb.js и earcut.js).');
        }

        this._worker = null;
        this._workerReady = this._initWorker();
        this._requestId = 0;
        this._pendingWorkerRequests = new Map();
    }

    async _initWorker() {
        const [tpbUrl, earcutUrl] = this._workerScriptUrls;
        try {
            const blobUrl = await _getSharedWorkerBlobUrl(tpbUrl, earcutUrl);
            this._worker = new Worker(blobUrl, { type: 'module' });
            this._worker.onmessage = (e) => this._onWorkerMessage(e.data);
            this._worker.onerror = (err) => console.error('VectorTile worker error:', err);
            this._worker.postMessage({ type: 'config', styles: this._styles });
        } catch (err) {
            console.error('Failed to initialize worker:', err);
        }
    }

    _onWorkerMessage(data) {
        if (!data || typeof data.id === 'undefined') return;

        const pending = this._pendingWorkerRequests.get(data.id);
        if (!pending) return;
        this._pendingWorkerRequests.delete(data.id);

        if (data.error) { pending.reject(new Error(data.error)); return; }
        if (!data.result) { pending.reject(new Error('Worker returned no result')); return; }

        if (pending.isIdentify) {
            pending.resolve(data.result);
            return;
        }

        if (pending.generation !== this._generation) {
            if (pending.group) this._disposeTile(pending.group);
            pending.resolve(null);
            return;
        }

        const result = data.result;
        const group = pending.group || new THREE.Group();
        try {
            this._buildGroupFromWorkerResult(group, result);
        } catch (err) {
            console.error('[VectorTileLayer] Failed to build tile group:', err);
            this._disposeTile(group);
            pending.reject(err);
            return;
        }

        if (!pending.group) {
            const key = pending.key;
            const existing = this._tileCache.get(key);
            if (existing && existing !== group) this._disposeTile(existing);
            this._adoptTile(key, group);
        }
        this._labelsDirty = true;
        pending.resolve(group);
    }

    _buildGroupFromWorkerResult(group, result) {
        this._removeTextLabelsForGroup(group);

        group.renderOrder = this._tileGroupRenderOrder;

        if (result.centerX !== undefined && result.centerZ !== undefined) {
            group.position.set(result.centerX, 0, result.centerZ);
        }

        while (group.children.length) {
            const child = group.children[0];
            if (child.geometry && !this._managedGeometries.has(child.geometry)) {
                child.geometry.dispose();
            }
            if (child.material && !this._managedMaterials.has(child.material)) {
                child.material.dispose?.();
            }
            group.remove(child);
        }

        for (const fill of result.fills) {
            const mat = this._getFillMaterialFromData(fill.layerName, fill.color, fill.opacity);
            const geom = new THREE.BufferGeometry();
            geom.setAttribute('position', new THREE.BufferAttribute(fill.positions, 3));
            if (fill.indices) geom.setIndex(new THREE.BufferAttribute(fill.indices, 1));
            const mesh = new THREE.Mesh(geom, mat);
            const ro = fill.renderOrder ?? VECTOR_TILE_RENDER_ORDER.FILL;
            mesh.renderOrder = ro;
            mesh.position.y = _flatY(ro);
            group.add(mesh);
        }

        if (result.buildings.length > 0) {
            const byColor = new Map();
            for (const b of result.buildings) {
                const key = b.color;
                if (!byColor.has(key)) byColor.set(key, { color: b.color, stroke: b.stroke, pos: [], nrm: [], edg: [] });
                const g = byColor.get(key);
                g.pos.push(b.positions);
                g.nrm.push(b.normals);
                if (b.edgePositions) g.edg.push(b.edgePositions);
            }
            for (const g of byColor.values()) {
                const geom = new THREE.BufferGeometry();
                geom.setAttribute('position', new THREE.BufferAttribute(this._concatF32(g.pos), 3));
                geom.setAttribute('normal', new THREE.BufferAttribute(this._concatF32(g.nrm), 3));
                const mesh = new THREE.Mesh(geom, this._getBuildingMaterial(g.color));
                mesh.renderOrder = VECTOR_TILE_RENDER_ORDER.BUILDING;
                group.add(mesh);

                if (this.buildingEdges && g.edg.length) {
                    const eGeom = new THREE.BufferGeometry();
                    eGeom.setAttribute('position', new THREE.BufferAttribute(this._concatF32(g.edg), 3));
                    const lines = new THREE.LineSegments(eGeom, this._getBuildingEdgeMaterial(g.stroke || 0x555555));
                    lines.renderOrder = VECTOR_TILE_RENDER_ORDER.EDGE;
                    group.add(lines);
                }
            }
        }

        for (const line of result.lines) {
            const mat = this._getDynamicLineMaterial(line);
            this._addFatLineFromPositions(group, line.positions, mat, line.renderOrder);
        }

        for (const stroke of result.strokes) {
            const mat = this._getLineMaterialFromData(stroke.layerName, stroke.color, stroke.width);
            this._addFatLineFromPositions(group, stroke.positions, mat, stroke.renderOrder);
        }

        for (const pt of result.points) {
            const fillKey = `fill:${pt.layerName}:${pt.color.toString(16)}:${pt.opacity}`;
            const mat = this._getFillMaterial(fillKey);
            const geometry = this._getPointGeometry(pt.radius);
            const mesh = new THREE.Mesh(geometry, mat);
            const ro = pt.renderOrder ?? VECTOR_TILE_RENDER_ORDER.BUILDING;
            mesh.position.set(pt.x, _flatY(ro), pt.z);
            mesh.renderOrder = ro;
            group.add(mesh);
        }

        group.userData.textPointsData = result.textPoints || [];
        group.userData.textLinesData  = result.textLines  || [];
        group.userData.lineLabelSources = null;
        group.userData.textLabels = [];
        group.userData.is3d = result.is3d;
    }

    _fatLineSegmentsFromPositions(positions) {
        if (!positions || positions.length < 6) return null;

        const out = [];
        let havePrev = false;
        let prevX = 0, prevY = 0, prevZ = 0;

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
            prevX = x; prevY = y; prevZ = z;
            havePrev = true;
        }

        return out.length > 0 ? new Float32Array(out) : null;
    }

    _addFatLineFromPositions(group, positions, material, renderOrder) {
        const segs = this._fatLineSegmentsFromPositions(positions);
        if (!segs) return;

        const lGeo = new LineSegmentsGeometry();
        lGeo.setPositions(segs);

        const lineObj = new Line2(lGeo, material);
        if (material.dashed) {
            if (typeof lineObj.computeLineDistances === 'function') {
                lineObj.computeLineDistances();
            } else if (typeof lGeo.computeLineDistances === 'function') {
                lGeo.computeLineDistances();
            } else {
                console.warn(
                    '[VectorTileLayer] computeLineDistances() недоступен ни на Line2, ни на LineSegmentsGeometry. ' +
                    'Пунктир не будет работать. Проверьте сборку tpb.js.'
                );
            }
        }

        lineObj.renderOrder = renderOrder;
        lineObj.position.y = _flatY(renderOrder);
        lineObj.frustumCulled = false;
        group.add(lineObj);
    }

    // -------------------------------------------------------------------------
    // Покрытие / переход LOD
    // -------------------------------------------------------------------------

    _is3dNow() {
        return this.buildings3d && (this._map.currentDiscreteZoom ?? 0) >= this.buildings3dMinZoom;
    }

    /** LOD с гистерезисом: целимся в зум, к которому камера едет, без промежуточных уровней. */
    _pickSourceZoom(map) {
        const clamp = z => Math.max(this.minZoom, Math.min(z, this.maxSourceZoom));
        const target = (map._cameraAnimation?.endZoom ?? map.targetContinuousZoom) + this.zoomOffset;
        const cur = this._lastSourceZoom;
        if (cur >= 0 && Math.abs(target - cur) < 0.65) return cur;
        return clamp(Math.round(target));
    }

    _adoptTile(key, group, visible = false) {
        group.visible = visible;
        if (group.parent !== this._rootGroup) this._rootGroup.add(group);
        this._tileCache.set(key, group);
        this._coverageDirty = true;
        this._labelsDirty = true;
    }

    _stashGroup(key, group) {
        this._rootGroup.remove(group);
        group.visible = true;
        this._removeTextLabelsForGroup(group);
        const prev = this._groupCache.get(key);
        if (prev && prev !== group) this._disposeTile(prev);
        this._groupCache.delete(key);
        this._groupCache.set(key, group);
        while (this._groupCache.size > this._groupCacheMaxSize) {
            const k0 = this._groupCache.keys().next().value;
            this._disposeTile(this._groupCache.get(k0));
            this._groupCache.delete(k0);
        }
    }

    _beginTransition(newZ) {
        this._generation++;
        // Подложкой становится то, что реально видно сейчас (даже если это смесь уровней).
        const fallback = new Map();
        const take = (g, k) => {
            if (g.visible && g.parent) fallback.set(k, g);
            else this._stashGroup(k, g);
        };
        this._oldTileGroups?.forEach(take);
        this._tileCache.forEach(take);

        this._oldTileGroups = fallback.size ? fallback : null;
        this._tileCache = new Map();
        this._pendingLoads.clear();
        this._sortedLoadQueue = [];
        this._settledKeys.clear();
        this._requiredKeys = new Set();
        this._lastSourceZoom = newZ;
        this._lastPrefetchZoom = -1;
        this._labelsDirty = true;
        this._coverageDirty = true;
    }

    _resolveCoverage() {
        this._coverageDirty = false;
        const old = this._oldTileGroups;
        let changed = false;
        const setVis = (g, v) => { if (g.visible !== v) { g.visible = v; changed = true; } };

        if (!old) {
            this._tileCache.forEach(g => setVis(g, true));
            if (changed) this._refreshTextLabelsForVisibleTiles();
            return;
        }
        const required = this._requiredKeys;
        if (required.size === 0) return; // видимость нового LOD ещё не посчитана

        const zn = this._lastSourceZoom;
        const parse = k => k.split(',').map(Number);
        const isDone = k => this._tileCache.has(k) || this._settledKeys.has(k);

        const newKeys = new Set(required);
        this._tileCache.forEach((_, k) => newKeys.add(k));

        const oldLinks = new Map(), newLinks = new Map();
        const push = (m, k, v) => { let a = m.get(k); if (!a) m.set(k, a = []); a.push(v); };
        const link = (ok, nk) => { push(oldLinks, ok, nk); push(newLinks, nk, ok); };

        const ancIndex = new Map(); // zo -> Map(предок на zo -> [новые ключи])
        const ancestorsAt = zo => {
            let m = ancIndex.get(zo);
            if (m) return m;
            m = new Map();
            const s = zn - zo;
            for (const nk of newKeys) {
                const [, x, y] = parse(nk);
                push(m, `${zo},${x >> s},${y >> s}`, nk);
            }
            ancIndex.set(zo, m);
            return m;
        };

        old.forEach((g, ok) => {
            const [zo, xo, yo] = parse(ok);
            if (zo >= zn) {
                const s = zo - zn;
                const nk = `${zn},${xo >> s},${yo >> s}`;
                if (newKeys.has(nk)) link(ok, nk);
            } else {
                for (const nk of ancestorsAt(zo).get(ok) ?? []) link(ok, nk);
            }
        });

        // Старый живёт, пока хоть один нужный новый на его площади не готов.
        let anyOldVisible = false;
        old.forEach((g, ok) => {
            const links = oldLinks.get(ok);
            const keep = !!links && links.some(nk => required.has(nk) && !isDone(nk));
            setVis(g, keep);
            if (keep) anyOldVisible = true;
        });
        // Новый показываем, только когда все перекрытые им старые скрыты.
        this._tileCache.forEach((g, nk) => {
            const links = newLinks.get(nk);
            setVis(g, !links || links.every(ok => !old.get(ok).visible));
        });

        if (!anyOldVisible) {
            old.forEach((g, ok) => this._stashGroup(ok, g)); // пригодятся при обратном зуме
            this._oldTileGroups = null;
        }
        // Подписи меняем в тот же кадр, что и геометрию.
        if (changed) this._refreshTextLabelsForVisibleTiles();
    }

    _forEachShownGroup(cb) {
        this._tileCache.forEach(g => { if (g.visible) cb(g); });
        this._oldTileGroups?.forEach(g => { if (g.visible) cb(g); });
    }

    // -------------------------------------------------------------------------
    // Подписи
    // -------------------------------------------------------------------------

    _refreshTextLabelsForVisibleTiles() {
        if (!this._map || !this._map.textManager) return;
        const textManager = this._map.textManager;

        const { candidates } = this._collectLabelCandidates();

        let selected;
        if (candidates.length === 0) {
            selected = [];
        } else {
            candidates.sort((a, b) => {
                if (a.priority !== b.priority) return b.priority - a.priority;
                const aLine = a.type === 'line' ? 1 : 0;
                const bLine = b.type === 'line' ? 1 : 0;
                if (aLine !== bLine) return bLine - aLine;
                return a.camDistSq - b.camDistSq;
            });
            const limit = Math.min(candidates.length, this.maxTextLabels);
            selected = candidates.slice(0, limit);
        }

        const activeIds = new Set();
        const groupLabels = new Map();

        for (let i = 0; i < selected.length; i++) {
            const cand = selected[i];
            const group = cand.group;
            const id = cand.id;

            activeIds.add(id);

            let source;
            if (cand.type === 'line') {
                if (!group.userData.lineLabelSources) {
                    group.userData.lineLabelSources = [];
                }
                let cached = group.userData.lineLabelSources[cand.lnIndex];
                if (!cached) {
                    cached = new VectorLineLabelSource(this._map, cand.ln, group, {
                        tracking:     this.lineLabelTracking,
                        priorityMode: this.lineLabelPriorityMode,
                        hysteresisPx: this.lineLabelHysteresisPx,
                        placement:    this.lineLabelPlacement,
                    });
                    group.userData.lineLabelSources[cand.lnIndex] = cached;
                }
                source = cached;
            } else {
                const pt = cand.pt;
                const localWorldX = pt.x + group.position.x;
                const localWorldZ = pt.z + group.position.z;

                source = new VectorPointLabelSource(this._map, localWorldX, localWorldZ, pt.text, {
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

            const label = textManager.addLabel(source, id);

            let arr = groupLabels.get(group);
            if (!arr) {
                arr = [];
                groupLabels.set(group, arr);
            }
            arr.push(label);
        }

        textManager.pruneStaleLabels(activeIds);

        this._tileCache.forEach(g => {
            g.userData.textLabels = groupLabels.get(g) || [];
        });
        this._oldTileGroups?.forEach(g => {
            g.userData.textLabels = groupLabels.get(g) || [];
        });
    }

    _collectLabelCandidates() {
        const map = this._map;
        const camera = map.camera;
        const continuousZoom = map.continuousZoom + this.zoomOffset;
        const discreteZoom = map.currentDiscreteZoom;
        const worldOffset = map.worldGroup.position;
        const rect = map.renderer.domElement.getBoundingClientRect();

        const cullMargin = this.labelCullMargin ?? 250;
        const isClose = discreteZoom >= (this.labelDistanceSortZoom ?? 17);

        const cameraPos = camera.position;
        const camTargetDist = cameraPos.distanceTo(map.controls.target);

        let maxLabelDist = this.labelMaxCameraDistance;
        if (!(maxLabelDist > 0)) {
            const sinPitch = camTargetDist > 0
                ? Math.max(0, Math.min(1, (cameraPos.y - map.controls.target.y) / camTargetDist))
                : 0;
            maxLabelDist = camTargetDist * Math.max(2.0, 12 / (1 + sinPitch * 4));
        }
        const maxLabelDistSq = maxLabelDist * maxLabelDist;

        const camPosX = cameraPos.x;
        const camPosY = cameraPos.y;
        const camPosZ = cameraPos.z;

        const tempVec = this._tempVec3;
        const candidates = [];
        const rectW = rect.width;
        const rectH = rect.height;

        const screenMarginX = rectW > 0 ? cullMargin / rectW : 0;
        const screenMarginY = rectH > 0 ? cullMargin / rectH : 0;

        this._forEachShownGroup(group => {
            const gx = group.position.x + worldOffset.x;
            const gz = group.position.z + worldOffset.z;

            const data = group.userData.textPointsData;
            if (data && data.length > 0) {
                const groupIdPrefix = group.uuid + ':';

                for (let i = 0; i < data.length; i++) {
                    const pt = data[i];
                    const zb = pt.zoomBounds || { min: 0, max: 24 };
                    if (continuousZoom < zb.min || continuousZoom > zb.max) continue;

                    const worldX = pt.x + gx;
                    const worldZ = pt.z + gz;

                    const camDx = worldX - camPosX;
                    const camDy = -camPosY;
                    const camDz = worldZ - camPosZ;
                    const camDistSq = camDx * camDx + camDy * camDy + camDz * camDz;

                    if (camDistSq > maxLabelDistSq) continue;

                    tempVec.set(worldX, 0, worldZ).project(camera);
                    if (tempVec.z > 1 || tempVec.z < -1) continue;

                    const sx = (tempVec.x * 0.5 + 0.5) * rectW;
                    const sy = (-tempVec.y * 0.5 + 0.5) * rectH;

                    if (
                        sx < -cullMargin ||
                        sx > rectW + cullMargin ||
                        sy < -cullMargin ||
                        sy > rectH + cullMargin
                    ) {
                        continue;
                    }

                    candidates.push({
                        type: 'point',
                        pt,
                        group,
                        id: groupIdPrefix + i,
                        camDistSq,
                        priority: pt.priority || 0,
                        sx,
                        sy,
                    });
                }
            }

            const lineData = group.userData.textLinesData;
            if (lineData && lineData.length > 0) {
                const groupIdPrefixL = group.uuid + ':L';

                for (let i = 0; i < lineData.length; i++) {
                    const ln = lineData[i];
                    const zb = ln.zoomBounds || { min: 0, max: 24 };
                    if (continuousZoom < zb.min || continuousZoom > zb.max) continue;

                    const pts = ln.points;
                    if (!pts || pts.length < 2) continue;

                    const step = Math.max(1, Math.floor(pts.length / 20));
                    let minDistSq = Infinity;
                    let minTx = Infinity, maxTx = -Infinity;
                    let minTy = Infinity, maxTy = -Infinity;
                    let hasValidPoints = false;

                    for (let k = 0; k < pts.length; k += step) {
                        const worldX = pts[k].x + gx;
                        const worldZ = pts[k].z + gz;

                        const camDx = worldX - camPosX;
                        const camDy = -camPosY;
                        const camDz = worldZ - camPosZ;
                        const d2 = camDx * camDx + camDy * camDy + camDz * camDz;
                        if (d2 < minDistSq) minDistSq = d2;

                        tempVec.set(worldX, 0, worldZ).project(camera);
                        if (tempVec.z > -1 && tempVec.z < 1) {
                            hasValidPoints = true;
                            if (tempVec.x < minTx) minTx = tempVec.x;
                            if (tempVec.x > maxTx) maxTx = tempVec.x;
                            if (tempVec.y < minTy) minTy = tempVec.y;
                            if (tempVec.y > maxTy) maxTy = tempVec.y;
                        }
                    }

                    if (!hasValidPoints) continue;

                    // Проверяем пересечение общего AABB линии с экраном
                    const anyOnScreen =
                        maxTx >= -1 - screenMarginX && minTx <= 1 + screenMarginX &&
                        maxTy >= -1 - screenMarginY && minTy <= 1 + screenMarginY;

                    if (!anyOnScreen) continue;
                    if (minDistSq > maxLabelDistSq) continue;

                    candidates.push({
                        type: 'line',
                        ln,
                        lnIndex: i,
                        group,
                        id: groupIdPrefixL + i,
                        camDistSq: minDistSq,
                        priority: ln.priority || 0,
                    });
                }
            }
        });

        return { candidates, isClose };
    }

    _removeTextLabelsForGroup(group) {
        if (group.userData.textLabels && this._map && this._map.textManager) {
            for (const label of group.userData.textLabels) {
                this._map.textManager.removeLabel(label);
            }
        }
        group.userData.textLabels = [];
    }

    // -------------------------------------------------------------------------
    // Материалы
    // -------------------------------------------------------------------------

    _getFillMaterialFromData(layerName, color, opacity) {
        const op = opacity ?? 1;
        const key = `fill:${layerName}:${color.toString(16)}:${op}`;
        return this._getFillMaterial(key);
    }

    _getLineMaterialFromData(layerName, color, width, dash) {
        const dashKey = dash ? dash.join(',') : 'none';
        const key = `line:${layerName}:${color.toString(16)}:${width}:${dashKey}`;
        return this._getLineMaterial(key, dash);
    }

    _getDynamicLineMaterial(line) {
        if (!this._map) return null;
        const wKey = typeof line.width === 'number'
            ? String(line.width)
            : JSON.stringify((line.width && line.width.stops) || line.width);
        const add = line.widthAdd || 0;
        const dashKey = line.dash ? line.dash.join(',') : 'none';
        const key = `dline:${line.layerName}:${line.color.toString(16)}:${wKey}+${add}:${dashKey}`;
        let mat = this._lineMaterialCache.get(key);
        if (mat) return mat;

        const canvas = this._map.renderer.domElement;
        const opts = {
            color: line.color,
            linewidth: 1,
            resolution: new THREE.Vector2(canvas.clientWidth, canvas.clientHeight),
            depthTest: true,
            depthWrite: false,
        };
        if (line.dash) {
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
        this._lastStyleZoom = NaN; // форсируем пересчёт в следующем кадре
        return mat;
    }

    _evalCurve(c, z) {
        if (typeof c === 'number') return c;
        if (!c || !c.stops || c.stops.length === 0) return 0;
        const s = c.stops;
        if (z <= s[0][0]) return s[0][1];
        for (let i = 1; i < s.length; i++) {
            if (z <= s[i][0]) {
                const t = (z - s[i - 1][0]) / (s[i][0] - s[i - 1][0]);
                return s[i - 1][1] + (s[i][1] - s[i - 1][1]) * t;
            }
        }
        return s[s.length - 1][1];
    }

    _updateDynamicLineMaterials(zoom) {
        if (Math.abs(zoom - this._lastStyleZoom) < 0.005) return;
        this._lastStyleZoom = zoom;
        for (const mat of this._lineMaterialsSet) {
            const d = mat.userData.dyn;
            if (!d) continue;
            const base = this._evalCurve(d.width, zoom);
            mat.linewidth = (base + (d.add || 0)) * this.lineWidthMultiplier;
            mat.visible = mat.linewidth > 0 && !(d.hideBelow != null && base <= d.hideBelow);
            if (mat.dashed && d.dashZ != null) {
                mat.dashScale = Math.pow(2, zoom - d.dashZ);
            }
        }
    }

    // -------------------------------------------------------------------------
    // Префетч следующего sourceZoom
    // -------------------------------------------------------------------------

    _prefetchNextZoom(z) {
        const map = this._map;
        if (!map) return;
        if (z < this.minZoom || z > this.maxSourceZoom) return;

        const visibleTiles = this._getVisibleTileKeys(z);

        for (const key of visibleTiles) {
            const c1 = key.indexOf(',');
            const c2 = key.indexOf(',', c1 + 1);
            const pz = +key.slice(0, c1);
            const px = +key.slice(c1 + 1, c2);
            const py = +key.slice(c2 + 1);

            const dataKey = `${pz}/${px}/${py}`;
            if (this._tileDataCache.has(dataKey)) continue;
            if (this._prefetchInFlight.has(dataKey)) continue;

            const url = this.url
                .replaceAll('{z}', pz)
                .replaceAll('{x}', px)
                .replaceAll('{y}', py);

            const promise = fetch(url)
                .then(resp => resp.ok ? resp.arrayBuffer() : null)
                .then(buffer => {
                    if (buffer && this._map) this._setTileDataCache(dataKey, buffer);
                    return buffer;
                })
                .catch(() => null)
                .finally(() => this._prefetchInFlight.delete(dataKey));
            this._prefetchInFlight.set(dataKey, promise);
        }
    }

    // -------------------------------------------------------------------------
    // Публичные методы
    // -------------------------------------------------------------------------

    addExclusionArea(collection, layers) {
        if (!this._map) {
            throw new Error('VectorTileLayer.addExclusionArea: слой должен быть добавлен на карту (addTo) до вызова addExclusionArea');
        }

        const geometries = [];
        if (collection.type === 'FeatureCollection') {
            for (const feature of collection.features) geometries.push(feature.geometry);
        } else if (collection.type === 'Feature') {
            geometries.push(collection.geometry);
        } else if (collection.type) {
            geometries.push(collection);
        } else {
            throw new Error('addExclusionArea: invalid GeoJSON object');
        }

        const crs = this._crsCode
            ? Projections.get(this._crsCode)
            : this._map.inputCRS;

        const worldPolygons = [];
        for (const geom of geometries) {
            if (!geom) continue;
            let rings = [];
            if (geom.type === 'Polygon') {
                rings = [geom.coordinates[0]];
            } else if (geom.type === 'MultiPolygon') {
                rings = geom.coordinates.map(poly => poly[0]);
            } else {
                console.warn('addExclusionArea: unsupported geometry type', geom.type);
                continue;
            }

            for (const ring of rings) {
                const worldRing = ring.map(pt => {
                    const [x, z] = this._map.project(pt, crs);
                    return { x, z };
                });
                worldPolygons.push(worldRing);
            }
        }

        this._exclusionAreas = worldPolygons;
        this._exclusionLayers = new Set(layers);

        this._invalidateAllTiles();
        return this;
    }

    _invalidateAllTiles() {
        this._clearAllTiles();
        this._clearGroupCache();
        this._tileDataCache.clear();
        this._lastSourceZoom = -1;
        this._lastDiscreteZoom = -1;
        this._labelsDirty = true;
        this._lastCheckInit = false;
    }

    _mergeStyles(base, overrides) {
        const merged = JSON.parse(JSON.stringify(base));
        for (const [key, val] of Object.entries(overrides)) {
            if (val && typeof val === 'object' && !Array.isArray(val) && merged[key]) {
                merged[key] = this._mergeStyles(merged[key], val);
            } else {
                merged[key] = val;
            }
        }
        return merged;
    }

    addTo(map) {
        if (this._map) this.removeFromMap();
        this._map = map;

        this._crs = this._crsCode
            ? Projections.get(this._crsCode)
            : map.inputCRS;

        this._rootGroup.renderOrder = this._tileGroupRenderOrder;

        map.worldGroup.add(this._rootGroup);
        if (!map._dynamicLayers.includes(this)) map._dynamicLayers.push(this);

        if (map.textManager && map.textManager.setMaxLabels) {
            map.textManager.setMaxLabels(this.maxTextLabels);
        }

        this._labelsDirty = true;
        this._lastCheckInit = false;
        return this;
    }

    removeFromMap() {
        if (!this._map) return;

        if (this._queueTimer) { clearTimeout(this._queueTimer); this._queueTimer = null; }

        for (const pending of this._pendingWorkerRequests.values()) {
            try { pending.reject(new Error('Layer removed')); } catch (e) {}
        }
        this._pendingWorkerRequests.clear();

        this._clearAllTiles();
        this._rootGroup.parent?.remove(this._rootGroup);
        const idx = this._map._dynamicLayers.indexOf(this);
        if (idx > -1) this._map._dynamicLayers.splice(idx, 1);
        this._map = null;
        this._crs = null;

        this._fillMaterialCache.forEach(m => m.dispose());
        this._lineMaterialCache.forEach(m => m.dispose());
        this._lineMaterialsSet.clear();
        this._fillMaterialCache.clear();
        this._lineMaterialCache.clear();

        this._pointGeometryCache.forEach(g => g.dispose());
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
    }

    _clearAllTiles() {
        this._generation++;
        this._tileCache.forEach(group => this._disposeTile(group));
        this._tileCache.clear();
        this._pendingLoads.clear();
        this._sortedLoadQueue = [];
        this._clearOldTilesNow();
        this._settledKeys.clear();
        this._requiredKeys = new Set();
        this._labelsDirty = true;
    }

    _clearGroupCache() {
        this._groupCache.forEach(group => this._disposeTile(group));
        this._groupCache.clear();
    }

    _clearOldTilesNow() {
        if (this._oldTileGroups) {
            this._oldTileGroups.forEach(group => this._disposeTile(group));
            this._oldTileGroups = null;
        }
    }

    _disposeTile(group) {
        this._removeTextLabelsForGroup(group);

        group.traverse(child => {
            if (child === group) return;
            const geom = child.geometry;
            if (geom && !this._managedGeometries.has(geom)) geom.dispose();
            const mat = child.material;
            if (mat && !this._managedMaterials.has(mat)) mat.dispose?.();
        });

        while (group.children.length) {
            group.remove(group.children[0]);
        }
        this._rootGroup.remove(group);
    }

    _setTileDataCache(key, buffer) {
        this._tileDataCache.delete(key);
        this._tileDataCache.set(key, buffer);
        while (this._tileDataCache.size > this._tileDataCacheMaxSize) {
            const oldestKey = this._tileDataCache.keys().next().value;
            this._tileDataCache.delete(oldestKey);
        }
    }

    _getTileDataCache(key) {
        const val = this._tileDataCache.get(key);
        if (val === undefined) return undefined;
        this._tileDataCache.delete(key);
        this._tileDataCache.set(key, val);
        return val;
    }

_postUpdate(map) {
    if (!this._map) return;

    // ── Отслеживание движения мира ────────────────────────────────
    // Вычисляем ОДИН раз: используется и для _lastMovementTime,
    // и для camChanged ниже (иначе повторная проверка всегда false,
    // потому что _lastWorldPos уже скопирован).
    const worldPos = map.worldGroup.position;
    const worldMoved = this._lastWorldPos.distanceToSquared(worldPos) > 1;
    if (worldMoved) {
        this._lastWorldPos.copy(worldPos);
        this._lastMovementTime = performance.now();
    }

    // Каждый кадр, без 500-мс троттлинга: живая ширина линий.
    this._updateDynamicLineMaterials(map.continuousZoom + this.zoomOffset);

    const discreteZoom = map.currentDiscreteZoom;
    const inRange = discreteZoom >= this.minZoom && discreteZoom <= this.maxZoom;

    // ── Смена LOD ─────────────────────────────────────────────────
    if (inRange) {
        const is3d = this._is3dNow();
        const sz = this._pickSourceZoom(map);
        if (sz !== this._lastSourceZoom || is3d !== this._lastIs3d) {
            this._lastIs3d = is3d;
            this._beginTransition(sz);
            this._lastUpdateTime = 0; // видимые тайлы пересчитать в этом же кадре
        }
    }
    if (this._coverageDirty) this._resolveCoverage();

    // ── ВАЖНО: обновление подписей — ВНЕ полного прохода ──────────
    // Раньше это было ниже проверки camChanged. Из-за этого при
    // панорамировании в пределах тайла (camChanged=false,
    // _labelsDirty=false) до обновления не доходили, и подписи на
    // вновь увиденных тайлах не появлялись до смены зума.
    const labelNow = performance.now();
    const timeSinceLastMove = labelNow - this._lastMovementTime;
    const isMoving = timeSinceLastMove < 1000;
    const periodicUpdateDue = isMoving && (labelNow - this._lastLabelUpdateTime > 1000);
    const settleUpdateDue = timeSinceLastMove > 300 && this._lastLabelUpdateTime < this._lastMovementTime;

    if ((this._labelsDirty || settleUpdateDue || periodicUpdateDue) &&
        (this._tileCache.size > 0 || this._oldTileGroups)) {
        this._labelsDirty = false;
        this._lastLabelUpdateTime = labelNow;
        this._refreshTextLabelsForVisibleTiles();
    }

    // ── Троттлинг полного прохода (обновление набора тайлов) ──────
    const now = performance.now();
    if (now - this._lastUpdateTime < this._throttle) {
        this._processQueue();
        return;
    }
    this._lastUpdateTime = now;

    const camPos = map.camera.position;
    const camChanged =
        !this._lastCheckInit ||
        this._lastCheckCamPos.distanceToSquared(camPos) > 0.01 ||
        worldMoved ||                          // ← ключевое: движение мира
        this._lastCheckZoom !== discreteZoom;

    if (!camChanged && !this._labelsDirty && this._tileCache.size > 0) {
        this._processQueue();
        return;
    }

    this._lastCheckInit = true;
    this._lastCheckCamPos.copy(camPos);
    this._lastCheckZoom = discreteZoom;

    if (!inRange) {
        if (this._tileCache.size > 0 || this._oldTileGroups || this._activeLoads > 0) {
            this._clearAllTiles();
        }
        this._lastSourceZoom = -1;
        this._lastDiscreteZoom = -1;
        return;
    }

    if (discreteZoom !== this._lastDiscreteZoom) this._labelsDirty = true;
    this._lastDiscreteZoom = discreteZoom;

    const sourceZoom = this._lastSourceZoom;
    const continuousZoom = map.continuousZoom;
    const nextSourceZoom = Math.min(sourceZoom + 1, this.maxSourceZoom);
    if (
        nextSourceZoom > sourceZoom &&
        continuousZoom > discreteZoom + 0.3 &&
        this._lastPrefetchZoom !== sourceZoom
    ) {
        this._lastPrefetchZoom = sourceZoom;
        this._prefetchNextZoom(nextSourceZoom);
    }

    const canvas = map.renderer.domElement;
    const w = canvas.clientWidth, h = canvas.clientHeight;
    if (this._lineMaterialsSet.size > 0 &&
        (this._lastCanvasSize.width !== w || this._lastCanvasSize.height !== h)) {
        this._lastCanvasSize.width = w;
        this._lastCanvasSize.height = h;
        this._canvasSizeVec.set(w, h);
        this._lineMaterialsSet.forEach(mat => mat.resolution.copy(this._canvasSizeVec));
    }

    const visibleTiles = this._getVisibleTileKeys(sourceZoom);
    this._requiredKeys = visibleTiles;
    this._coverageDirty = true;

    for (const key of this._tileCache.keys()) {
        if (!visibleTiles.has(key)) {
            const group = this._tileCache.get(key);
            this._stashGroup(key, group);
            this._tileCache.delete(key);
            this._pendingLoads.delete(key);
            this._labelsDirty = true;
        }
    }

    // (Блок _refreshTextLabelsForVisibleTiles убран — он теперь выше.)

    const maxMerc = map.MAX_MERCATOR;
    const target = map.controls.target;
    const tileSizeAtZoom = map.WORLD_SIZE / (1 << sourceZoom);

    const targetX = target.x;
    const targetZ = target.z;
    const unsortedNewKeys = [];
    visibleTiles.forEach(key => {
        if (this._tileCache.has(key) || this._pendingLoads.has(key)) return;
        const comma1 = key.indexOf(',');
        const comma2 = key.indexOf(',', comma1 + 1);
        const xa = +key.slice(comma1 + 1, comma2);
        const ya = +key.slice(comma2 + 1);
        const cxa = xa * tileSizeAtZoom - maxMerc + tileSizeAtZoom / 2;
        const cza = -maxMerc + ya * tileSizeAtZoom + tileSizeAtZoom / 2;
        const dax = cxa - targetX, daz = cza - targetZ;
        unsortedNewKeys.push({ key, distSq: dax * dax + daz * daz });
    });
    unsortedNewKeys.sort((a, b) => a.distSq - b.distSq);
    const newKeys = unsortedNewKeys.map(o => o.key);

    this._sortedLoadQueue = newKeys.concat(
        this._sortedLoadQueue.filter(k =>
            !this._tileCache.has(k) && !this._pendingLoads.has(k) && visibleTiles.has(k)
        )
    );
    this._processQueue();
}

    _processQueue() {
        if (this._activeLoads >= this._maxConcurrent) return;
        if (this._sortedLoadQueue.length === 0) return;
        const toLoad = this._sortedLoadQueue.splice(0, this._maxConcurrent - this._activeLoads);
        toLoad.forEach(key => {
            const [z, x, y] = key.split(',').map(Number);
            this._loadTile(z, x, y);
        });
        if (this._sortedLoadQueue.length > 0) {
            clearTimeout(this._queueTimer);
            this._queueTimer = setTimeout(() => this._processQueue(), this._queueInterval);
        }
    }

    async _loadTile(z, xSlippy, ySlippy) {
        const key = `${z},${xSlippy},${ySlippy}`;
        if (this._pendingLoads.has(key) || this._tileCache.has(key)) return;

        const map = this._map;
        if (!map) return;

        // Переиспользуем готовый тайл из подложки (быстрый зум туда-обратно).
        const fb = this._oldTileGroups?.get(key);
        if (fb && fb.userData.is3d === this._is3dNow()) {
            this._oldTileGroups.delete(key);
            this._adoptTile(key, fb, fb.visible);
            return;
        }

        if (this._groupCache.has(key)) {
            const group = this._groupCache.get(key);
            this._groupCache.delete(key);
            const is3dNow = this._is3dNow();
            if (group.userData.is3d !== is3dNow) {
                const dataCacheKey = `${z}/${xSlippy}/${ySlippy}`;
                const cached = this._getTileDataCache(dataCacheKey);
                if (cached) {
                    this._pendingLoads.add(key);
                    this._activeLoads++;
                    try {
                        const result = await this._sendToWorker(
                            cached.slice(0), z, xSlippy, ySlippy, is3dNow, group);
                        if (result) this._adoptTile(key, group);
                    } catch (err) {
                        if (z === this._lastSourceZoom) {
                            this._settledKeys.add(key);
                            this._coverageDirty = true;
                        }
                    } finally {
                        this._pendingLoads.delete(key);
                        this._activeLoads--;
                        this._processQueue();
                    }
                    return;
                }
                this._disposeTile(group);
            } else {
                this._adoptTile(key, group);
                return;
            }
        }

        this._pendingLoads.add(key);
        this._activeLoads++;
        const dataCacheKey = `${z}/${xSlippy}/${ySlippy}`;
        try {
            let buffer;
            const cached = this._getTileDataCache(dataCacheKey);
            if (cached) {
                buffer = cached.slice(0);
            } else {
                const url = this.url
                    .replaceAll('{z}', z)
                    .replaceAll('{x}', xSlippy)
                    .replaceAll('{y}', ySlippy);
                const prefetchPromise = this._prefetchInFlight.get(dataCacheKey);
                if (prefetchPromise) {
                    buffer = await prefetchPromise;
                    if (buffer) buffer = buffer.slice(0);
                }
                if (!buffer) {
                    const response = await fetch(url);
                    if (!response.ok) throw new Error(`HTTP ${response.status}`);
                    buffer = await response.arrayBuffer();
                    this._setTileDataCache(dataCacheKey, buffer.slice(0));
                }
            }

            const is3dNow = this._is3dNow();
            const group = await this._sendToWorker(buffer, z, xSlippy, ySlippy, is3dNow);
            if (group) this._adoptTile(key, group);
        } catch (err) {
            // Тайл не загрузился — помечаем settled, чтобы переход не ждал его вечно.
            if (z === this._lastSourceZoom) {
                this._settledKeys.add(key);
                this._coverageDirty = true;
            }
        } finally {
            this._pendingLoads.delete(key);
            this._activeLoads--;
            this._processQueue();
        }
    }

    async identify(sceneX, sceneZ, opts = {}) {
        if (!this._map || !this._worker) return { error: 'layer not attached' };
        const map = this._map;

        // LOD слоя может отличаться от дискретного зума карты — используем
        // фактически загруженный sourceZoom.
        const sourceZoom = this._lastSourceZoom >= 0
            ? this._lastSourceZoom
            : Math.max(this.minZoom,
                       Math.min(map.currentDiscreteZoom + this.zoomOffset, this.maxSourceZoom));

        const tileSize = map.WORLD_SIZE / (1 << sourceZoom);
        const numTiles = 1 << sourceZoom;

        const localX = sceneX - map.worldGroup.position.x;
        const localZ = sceneZ - map.worldGroup.position.z;

        const tx = (localX + map.MAX_MERCATOR) / tileSize;
        const tz = (localZ + map.MAX_MERCATOR) / tileSize;
        const xSlippy = Math.floor(tx);
        const ySlippy = Math.floor(tz);

        if (xSlippy < 0 || xSlippy >= numTiles || ySlippy < 0 || ySlippy >= numTiles) {
            return { error: `tile (${xSlippy},${ySlippy}) outside [0,${numTiles}) at z=${sourceZoom}` };
        }

        const dataCacheKey = `${sourceZoom}/${xSlippy}/${ySlippy}`;
        let buffer = this._getTileDataCache(dataCacheKey);
        if (buffer) {
            buffer = buffer.slice(0);
        } else {
            const url = this.url
                .replaceAll('{z}', sourceZoom)
                .replaceAll('{x}', xSlippy)
                .replaceAll('{y}', ySlippy);
            try {
                const resp = await fetch(url);
                if (!resp.ok) return { error: `HTTP ${resp.status} for ${url}` };
                buffer = await resp.arrayBuffer();
                this._setTileDataCache(dataCacheKey, buffer.slice(0));
            } catch (err) {
                return { error: `fetch failed: ${err.message}` };
            }
        }

        const centerX = xSlippy * tileSize - map.MAX_MERCATOR + tileSize / 2;
        const centerZ = -map.MAX_MERCATOR + ySlippy * tileSize + tileSize / 2;
        const clickLocalX = localX - centerX;
        const clickLocalZ = localZ - centerZ;

        return new Promise((resolve, reject) => {
            const id = ++this._requestId;
            this._pendingWorkerRequests.set(id, {
                resolve,
                reject,
                group: null,
                key: null,
                generation: this._generation,
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
    continuousZoom: map.continuousZoom + this.zoomOffset,
    styleZoom: (map.currentDiscreteZoom ?? sourceZoom) + this.zoomOffset,
    localX: clickLocalX,
    localZ: clickLocalZ,
    tolerance: opts.tolerance || tileSize * 0.005,
}, [buffer]);
            } catch (err) {
                this._pendingWorkerRequests.delete(id);
                reject(err);
            }
        });
    }

    async _sendToWorker(buffer, z, x, y, is3d, existingGroup) {
        await this._workerReady;
        return new Promise((resolve, reject) => {
            if (!this._worker || !this._map) {
                reject(new Error('Layer removed'));
                return;
            }

            const map = this._map;
            const id = ++this._requestId;
            const tileSize = map.WORLD_SIZE / (1 << z);
            const maxMerc = map.MAX_MERCATOR;

const msg = {
    type: 'process',
    id,
    buffer: buffer,
    z, x, y,
    tileSize,
    maxMerc,
    is3d,
    continuousZoom: map.continuousZoom + this.zoomOffset,
    styleZoom: (map.currentDiscreteZoom ?? z) + this.zoomOffset,
    visibleLayers: this.visibleLayers,
    buildingEdges: this.buildingEdges,
    exclusionPolygons: this._exclusionAreas,
    exclusionLayers: Array.from(this._exclusionLayers),
    maxTextPointsPerTile: this.maxTextPointsPerTile,
    maxTextLinesPerTile: this.maxTextLinesPerTile,
};

            this._pendingWorkerRequests.set(id, {
                resolve,
                reject,
                group: existingGroup || null,
                key: existingGroup ? null : `${z},${x},${y}`,
                generation: this._generation,
            });
            try {
                this._worker.postMessage(msg, [buffer]);
            } catch (err) {
                this._pendingWorkerRequests.delete(id);
                reject(err);
            }
        });
    }

    _getVisibleTileKeys(z) {
        const map = this._map;
        const camera = map.camera;
        const tileSize = map.WORLD_SIZE / (1 << z);
        const off = map.worldGroup.position;
        const maxTile = (1 << z) - 1;
        const numTiles = 1 << z;

        const ray = this._raycaster;
        const ndc = this._raycastNDC;
        const plane = this._raycastPlane;
        const hit = this._raycastHit;

        const camXLocal = camera.position.x - off.x;
        const camZLocal = camera.position.z - off.z;
        let minX = camXLocal, maxX = camXLocal;
        let minZ = camZLocal, maxZ = camZLocal;

        const camTargetDist = camera.position.distanceTo(map.controls.target);
        const maxLoadDist = Math.max(camTargetDist * 6, tileSize * 48);
        const maxLoadDistSq = maxLoadDist * maxLoadDist;

        const MIN_RAY_Y = Math.sin(3 * Math.PI / 180);
        const GRID = 5;
        let hitsCount = 0;

        for (let i = 0; i < GRID; i++) {
            for (let j = 0; j < GRID; j++) {
                const nx = (i / (GRID - 1)) * 2 - 1;
                const ny = (j / (GRID - 1)) * 2 - 1;
                ndc.set(nx, ny);
                ray.setFromCamera(ndc, camera);

                if (Math.abs(ray.ray.direction.y) < MIN_RAY_Y) continue;
                if (!ray.ray.intersectPlane(plane, hit)) continue;

                const dxCam = hit.x - camera.position.x;
                const dzCam = hit.z - camera.position.z;
                if (dxCam * dxCam + dzCam * dzCam > maxLoadDistSq) continue;

                hitsCount++;
                const lx = hit.x - off.x;
                const lz = hit.z - off.z;
                if (lx < minX) minX = lx;
                if (lx > maxX) maxX = lx;
                if (lz < minZ) minZ = lz;
                if (lz > maxZ) maxZ = lz;
            }
        }

        if (hitsCount < 4) {
            const target = map.controls.target;
            const distance = camera.position.distanceTo(target);
            const vFov = camera.fov * Math.PI / 180;
            const aspect = camera.aspect;
            const hh = distance * Math.tan(vFov / 2) * aspect * 2 + 2 * tileSize;
            const hv = distance * Math.tan(vFov / 2) * 2 + 2 * tileSize;
            const targetXLocal = target.x - off.x;
            const targetZLocal = target.z - off.z;
            if (targetXLocal - hh < minX) minX = targetXLocal - hh;
            if (targetXLocal + hh > maxX) maxX = targetXLocal + hh;
            if (targetZLocal - hv < minZ) minZ = targetZLocal - hv;
            if (targetZLocal + hv > maxZ) maxZ = targetZLocal + hv;
        }

        const margin = tileSize * 1.5;
        minX -= margin; maxX += margin;
        minZ -= margin; maxZ += margin;

        const xMin = Math.floor((minX + map.MAX_MERCATOR) / tileSize);
        const xMax = Math.floor((maxX + map.MAX_MERCATOR) / tileSize);
        const yMin = Math.max(0, Math.floor((minZ + map.MAX_MERCATOR) / tileSize));
        const yMax = Math.min(maxTile, Math.floor((maxZ + map.MAX_MERCATOR) / tileSize));

        const keys = new Set();
        for (let y = yMin; y <= yMax; y++) {
            for (let x = xMin; x <= xMax; x++) {
                keys.add(`${z},${((x % numTiles) + numTiles) % numTiles},${y}`);
            }
        }
        return keys;
    }

    _getFillMaterial(styleKey) {
        if (this._fillMaterialCache.has(styleKey)) return this._fillMaterialCache.get(styleKey);
        const parts = styleKey.split(':');
        const color = parseInt(parts[2], 16);
        const rawOpacity = parseFloat(parts[3]);
        const opacity = (isNaN(rawOpacity) ? 1 : rawOpacity) * this.fillOpacity;
        const mat = new THREE.MeshBasicMaterial({
            color,
            side: THREE.DoubleSide,
            transparent: opacity < 1.0,
            opacity,
            depthTest: true,
            depthWrite: false
        });
        this._fillMaterialCache.set(styleKey, mat);
        this._managedMaterials.add(mat);
        return mat;
    }

    _getLineMaterial(styleKey, dash) {
        if (this._lineMaterialCache.has(styleKey)) return this._lineMaterialCache.get(styleKey);
        const parts = styleKey.split(':');
        const color = parseInt(parts[2], 16);
        const width = parseFloat(parts[3]) * this.lineWidthMultiplier;
        const matOpts = {
            color,
            linewidth: width,
            resolution: new THREE.Vector2(
                this._map.renderer.domElement.clientWidth,
                this._map.renderer.domElement.clientHeight
            ),
            depthTest: true,
            depthWrite: false
        };
        if (dash && Array.isArray(dash) && dash.length >= 2) {
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
        if (this._pointGeometryCache.has(key)) return this._pointGeometryCache.get(key);
        const geom = new THREE.CircleGeometry(radius, 8);
        geom.rotateX(-Math.PI / 2);
        this._pointGeometryCache.set(key, geom);
        this._managedGeometries.add(geom);
        return geom;
    }

    _concatF32(arrays) {
        let total = 0;
        for (const a of arrays) total += a.length;
        const out = new Float32Array(total);
        let off = 0;
        for (const a of arrays) { out.set(a, off); off += a.length; }
        return out;
    }

    _getBuildingMaterial(color) {
        const key = 'bld:' + color;
        if (this._fillMaterialCache.has(key)) return this._fillMaterialCache.get(key);

        const mat = new THREE.MeshLambertMaterial({
            color,
            side: THREE.FrontSide,
            depthTest: true,
            depthWrite: true,
            polygonOffset: true,
            polygonOffsetFactor: 1,
            polygonOffsetUnits: 1
        });

        this._fillMaterialCache.set(key, mat);
        this._managedMaterials.add(mat);
        return mat;
    }

    _getBuildingEdgeMaterial(color) {
        const key = 'bldEdge:' + color;
        if (this._lineMaterialCache.has(key)) return this._lineMaterialCache.get(key);
        const mat = new THREE.LineBasicMaterial({ color, depthTest: true, depthWrite: false });
        this._lineMaterialCache.set(key, mat);
        this._managedMaterials.add(mat);
        return mat;
    }
}