// VectorTileWorker.ts
import { THREE, Line2, LineSegmentsGeometry } from './js_TP/tpb.js';
import { stringToBase64, createWorkerCode } from './vectorTileWorkerCode.js';
import { VECTOR_TILE_RENDER_ORDER } from './VectorTileTypes.js';
// ============================================================================
// Module-level shared blob cache
// ============================================================================
const _MODULE_DIR = new URL('.', import.meta.url).href;
export const _DEFAULT_WORKER_SCRIPTS = [
    new URL('./js_TP/tpb.js', _MODULE_DIR).href,
    new URL('./js_TP/earcut.js', _MODULE_DIR).href,
];
/**
 * Fix #4: сознательно «вечный» кэш blob URL.
 *
 * Ключ — пара (tpbUrl, earcutUrl). Количество ключей ограничено числом
 * уникальных пар; blob URL не revoke'ается, т.к. разделяется всеми
 * экземплярами VectorTile с одинаковыми скриптами. Если когда-либо
 * понадобится динамическая смена скриптов — добавьте refcount:
 *   acquireWorkerBlobUrl(urls) / releaseWorkerBlobUrl(urls).
 */
const _workerBlobUrlCache = new Map();
function _getSharedWorkerBlobUrl(tpbUrl, earcutUrl) {
    const key = tpbUrl + '|' + earcutUrl;
    const cached = _workerBlobUrlCache.get(key);
    if (cached)
        return cached;
    const promise = (async () => {
        const [tpbRes, earcutRes] = await Promise.all([fetch(tpbUrl), fetch(earcutUrl)]);
        if (!tpbRes.ok)
            throw new Error(`HTTP ${tpbRes.status} for ${tpbUrl}`);
        if (!earcutRes.ok)
            throw new Error(`HTTP ${earcutRes.status} for ${earcutUrl}`);
        const [tpbCode, earcutCode] = await Promise.all([tpbRes.text(), earcutRes.text()]);
        const tpbDataURL = 'data:text/javascript;base64,' + stringToBase64(tpbCode);
        const earcutDataURL = 'data:text/javascript;base64,' + stringToBase64(earcutCode);
        const workerCode = createWorkerCode(tpbDataURL, earcutDataURL);
        return URL.createObjectURL(new Blob([workerCode], { type: 'text/javascript' }));
    })();
    _workerBlobUrlCache.set(key, promise);
    promise.catch(() => _workerBlobUrlCache.delete(key));
    return promise;
}
// ============================================================================
// Mixin
// ============================================================================
export const VectorTileWorkerMixin = {
    // ── Fix #2: токен против «осиротевшего» воркера ───────────────────────
    async _initWorker() {
        const token = (this._workerInitToken || 0) + 1;
        this._workerInitToken = token;
        const [tpbUrl, earcutUrl] = this._workerScriptUrls;
        try {
            const blobUrl = await _getSharedWorkerBlobUrl(tpbUrl, earcutUrl);
            // Пока ждали fetch — слой мог быть снят с карты (removeFromMap).
            if (this._workerInitToken !== token)
                return;
            if (!this._map)
                return;
            const worker = new Worker(blobUrl, { type: 'module' });
            this._worker = worker;
            worker.onmessage = (e) => this._onWorkerMessage(e.data);
            worker.onerror = (err) => console.error('VectorTile worker error:', err);
            worker.postMessage({ type: 'config', styles: this._styles });
        }
        catch (err) {
            console.error('Failed to initialize worker:', err);
        }
    },
    _onWorkerMessage(data) {
        if (!data || typeof data.id === 'undefined')
            return;
        const pending = this._pendingWorkerRequests.get(data.id);
        if (!pending)
            return;
        this._pendingWorkerRequests.delete(data.id);
        if (data.error) {
            if (pending.group)
                this._disposeTile(pending.group);
            pending.reject(new Error(data.error));
            return;
        }
        if (!data.result) {
            if (pending.group)
                this._disposeTile(pending.group);
            pending.reject(new Error('Worker returned no result'));
            return;
        }
        if (pending.isIdentify) {
            pending.resolve(data.result);
            return;
        }
        const generationIsCurrent = pending.generation === this._generation;
        const sourceZoomIsCurrent = pending.sourceZoom === this._lastSourceZoom;
        const mapIsCurrent = !!this._map;
        if (!generationIsCurrent || !sourceZoomIsCurrent || !mapIsCurrent) {
            if (pending.group)
                this._disposeTile(pending.group);
            pending.resolve(null);
            return;
        }
        const group = pending.group || new THREE.Group();
        try {
            this._buildGroupFromWorkerResult(group, data.result);
            group.userData.sourceZoom = pending.sourceZoom;
            group.userData.styleZoom = pending.styleZoom;
            group.userData.generation = pending.generation;
        }
        catch (err) {
            console.error('[VectorTile] Failed to build tile group:', err);
            this._disposeTile(group);
            pending.reject(err);
            return;
        }
        this._labelsDirty = true;
        pending.resolve(group);
    },
    _buildGroupFromWorkerResult(group, result) {
        this._removeTextLabelsForGroup(group);
        group.renderOrder = this._tileGroupRenderOrder;
        if (result.centerX !== undefined && result.centerZ !== undefined) {
            group.position.set(result.centerX, 0, result.centerZ);
        }
        while (group.children.length) {
            const child = group.children[0];
            if (child.geometry && !this._managedGeometries.has(child.geometry))
                child.geometry.dispose();
            const mats = Array.isArray(child.material) ? child.material : [child.material];
            for (const m of mats) {
                if (m && !this._managedMaterials.has(m))
                    m.dispose?.();
            }
            group.remove(child);
        }
        for (const fill of result.fills || []) {
            const mat = this._getFillMaterialFromData(fill.layerName, fill.color, fill.opacity);
            const geom = new THREE.BufferGeometry();
            geom.setAttribute('position', new THREE.BufferAttribute(fill.positions, 3));
            if (fill.indices)
                geom.setIndex(new THREE.BufferAttribute(fill.indices, 1));
            const mesh = new THREE.Mesh(geom, mat);
            const rawFillOrder = typeof fill.renderOrder === 'number' && Number.isFinite(fill.renderOrder)
                ? fill.renderOrder
                : VECTOR_TILE_RENDER_ORDER.FILL;
            const isTransportationFill = fill.layerName === 'transportation';
            mesh.renderOrder = isTransportationFill
                ? 200_000 + rawFillOrder
                : rawFillOrder;
            mesh.position.y = isTransportationFill ? 0.04 : 0;
            group.add(mesh);
        }
        if (result.buildings && result.buildings.length > 0) {
            const byColor = new Map();
            for (const b of result.buildings) {
                if (!byColor.has(b.color)) {
                    byColor.set(b.color, { color: b.color, stroke: b.stroke, pos: [], nrm: [], edg: [] });
                }
                const g = byColor.get(b.color);
                g.pos.push(b.positions);
                g.nrm.push(b.normals);
                if (b.edgePositions)
                    g.edg.push(b.edgePositions);
            }
            const opacity = this.buildings3dOpacity;
            const isTransparent = opacity < 1;
            for (const g of byColor.values()) {
                const geom = new THREE.BufferGeometry();
                geom.setAttribute('position', new THREE.BufferAttribute(this._concatF32(g.pos), 3));
                geom.setAttribute('normal', new THREE.BufferAttribute(this._concatF32(g.nrm), 3));
                if (isTransparent) {
                    const depthMesh = new THREE.Mesh(geom, this._getBuildingDepthMaterial());
                    depthMesh.renderOrder = 900_000;
                    group.add(depthMesh);
                }
                const mesh = new THREE.Mesh(geom, this._getBuildingMaterial(g.color, opacity));
                mesh.renderOrder = VECTOR_TILE_RENDER_ORDER.BUILDING;
                group.add(mesh);
                if (this.buildingEdges && g.edg.length) {
                    const edgeGeom = new THREE.BufferGeometry();
                    edgeGeom.setAttribute('position', new THREE.BufferAttribute(this._concatF32(g.edg), 3));
                    const lines = new THREE.LineSegments(edgeGeom, this._getBuildingEdgeMaterial(g.stroke || 0x555555, isTransparent ? opacity * 0.35 : 1));
                    lines.renderOrder = VECTOR_TILE_RENDER_ORDER.EDGE;
                    group.add(lines);
                }
            }
        }
        for (const line of result.lines || []) {
            const mat = this._getDynamicLineMaterial(line);
            if (!mat)
                continue;
            this._addFatLineFromPositions(group, line.positions, mat, line.renderOrder);
        }
        for (const stroke of result.strokes || []) {
            const mat = this._getLineMaterialFromData(stroke.layerName, stroke.color, stroke.width, stroke.dash);
            this._addFatLineFromPositions(group, stroke.positions, mat, stroke.renderOrder);
        }
        for (const pt of result.points || []) {
            const fillKey = `fill:${pt.layerName}:${pt.color.toString(16)}:${pt.opacity}`;
            const mat = this._getFillMaterial(fillKey);
            const geometry = this._getPointGeometry(pt.radius);
            const mesh = new THREE.Mesh(geometry, mat);
            mesh.position.set(pt.x, 0, pt.z);
            mesh.renderOrder = pt.renderOrder ?? VECTOR_TILE_RENDER_ORDER.BUILDING;
            group.add(mesh);
        }
        // NEW: обогащаем textPoints иконками из стиля (см. _enrichTextPointsWithIcons).
        // Делаем это до присваивания group.userData.textPointsData, чтобы
        // _refreshTextLabelsForVisibleTiles увидел уже готовые pt.iconName.
        const textPoints = result.textPoints || [];
        this._enrichTextPointsWithIcons(textPoints);
        group.userData.textPointsData = textPoints;
        group.userData.textLinesData = result.textLines || [];
        group.userData.lineLabelSources = null;
        group.userData.textLabels = [];
        group.userData.is3d = !!result.is3d;
    },
    _enrichTextPointsWithIcons(points) {
        if (!points || points.length === 0)
            return;
        const styles = this._styles;
        if (!styles)
            return;
        // Локальный словарь удален — используем импортированный POI_COLORS
        for (let i = 0; i < points.length; i++) {
            const pt = points[i];
            if (pt.iconName)
                continue;
            const layerName = pt.layerName ?? pt.sourceLayer;
            if (!layerName)
                continue;
            const style = styles[layerName];
            if (!style)
                continue;
            const iconSpec = style.iconImage ?? style['icon-image'];
            if (iconSpec == null)
                continue;
            const iconName = this._evalIconImageSpec(iconSpec, pt);
            if (!iconName)
                continue;
            pt.iconName = iconName;
            if (pt.iconScale == null) {
                pt.iconScale = style.iconScale ?? style['icon-scale'] ?? 1;
            }
            if (pt.iconOffset == null) {
                pt.iconOffset = style.iconOffset ?? style['icon-offset'] ?? [0, 0];
            }
            if (pt.iconCircleScale == null) {
                pt.iconCircleScale = style.iconCircleScale;
            }
            if (pt.iconGlyphRatio == null) {
                pt.iconGlyphRatio = style.iconGlyphRatio;
            }
            if (pt.iconColor == null) {
                const cls = pt.properties?.class || pt.class;
                pt.iconColor = style.classColors?.[cls] ?? '#888888';
            }
        }
    },
    /**
     * Резолвит `iconImage`-спеку из стиля в конкретное имя спрайта.
     *
     * Поддерживается:
     *   • 'restaurant_11' — прямое имя;
     *   • { type: 'match', by, values, _default } — по ключам from `by`.
     *
     * В отличие от воркера, `by` может быть как строкой, так и массивом:
     * перебираем ключи по очереди и берём первое совпадение. Это
     * соответствует тому, как мы используем match для иконок, и не
     * требует полной реализации OMT-семантики.
     */
    _evalIconImageSpec(spec, pt) {
        if (spec == null)
            return null;
        if (typeof spec === 'string')
            return spec;
        if (typeof spec !== 'object')
            return null;
        if (spec.type === 'match') {
            const by = spec.by;
            const keys = Array.isArray(by) ? by : [by];
            const values = spec.values || {};
            for (let k = 0; k < keys.length; k++) {
                const key = keys[k];
                const v = (pt.properties && pt.properties[key] !== undefined)
                    ? pt.properties[key]
                    : pt[key]; // ← fallback: pt.class и т.п.
                if (v == null)
                    continue;
                const entry = values[String(v)];
                if (entry !== undefined) {
                    const r = this._evalIconImageSpec(entry, pt);
                    if (r != null)
                        return r;
                }
            }
            if (values._default !== undefined) {
                return this._evalIconImageSpec(values._default, pt);
            }
            return null;
        }
        return null;
    },
    // ── Fix #8: два прохода, без промежуточного JS-массива ────────────────
    _fatLineSegmentsFromPositions(positions) {
        if (!positions || positions.length < 6)
            return null;
        let segCount = 0;
        let havePrev = false;
        for (let i = 0; i < positions.length; i += 3) {
            const x = positions[i];
            if (Number.isNaN(x)) {
                havePrev = false;
                continue;
            }
            if (havePrev)
                segCount++;
            havePrev = true;
        }
        if (segCount === 0)
            return null;
        const out = new Float32Array(segCount * 6);
        let k = 0;
        havePrev = false;
        let px = 0, py = 0, pz = 0;
        for (let i = 0; i < positions.length; i += 3) {
            const x = positions[i], y = positions[i + 1], z = positions[i + 2];
            if (Number.isNaN(x)) {
                havePrev = false;
                continue;
            }
            if (havePrev) {
                out[k++] = px;
                out[k++] = py;
                out[k++] = pz;
                out[k++] = x;
                out[k++] = y;
                out[k++] = z;
            }
            px = x;
            py = y;
            pz = z;
            havePrev = true;
        }
        return out;
    },
    _addFatLineFromPositions(group, positions, material, renderOrder) {
        const segs = this._fatLineSegmentsFromPositions(positions);
        if (!segs)
            return;
        const lGeo = new LineSegmentsGeometry();
        lGeo.setPositions(segs);
        const lineObj = new Line2(lGeo, material);
        if (material.dashed) {
            if (typeof lineObj.computeLineDistances === 'function') {
                lineObj.computeLineDistances();
            }
            else if (typeof lGeo.computeLineDistances === 'function') {
                lGeo.computeLineDistances();
            }
        }
        const dyn = material?.userData?.dyn;
        const role = dyn?.role;
        const semanticOrder = typeof renderOrder === 'number' && Number.isFinite(renderOrder)
            ? renderOrder
            : VECTOR_TILE_RENDER_ORDER.LINE;
        const ROLE_ORDER = {
            casing: 100_000,
            fill: 200_000,
            other: 0,
        };
        if (role === 'casing') {
            lineObj.renderOrder = ROLE_ORDER.casing + semanticOrder;
            lineObj.position.y = 0.02;
        }
        else if (role === 'fill') {
            lineObj.renderOrder = ROLE_ORDER.fill + semanticOrder;
            lineObj.position.y = 0.04;
        }
        else {
            lineObj.renderOrder = semanticOrder;
            lineObj.position.y = 0.01;
        }
        lineObj.frustumCulled = false;
        group.add(lineObj);
    },
    async _sendToWorker(buffer, z, x, y, is3d, existingGroup = null, generation = this._generation, styleZoom = this._transitionStyleZoom) {
        if (generation !== this._generation || z !== this._lastSourceZoom)
            return null;
        await this._workerReady;
        if (generation !== this._generation || z !== this._lastSourceZoom)
            return null;
        if (!this._worker || !this._map)
            return null;
        const map = this._map;
        const id = ++this._requestId;
        const tileSize = map.WORLD_SIZE / (1 << z);
        const effectiveStyleZoom = Number.isFinite(styleZoom)
            ? styleZoom
            : this._getCurrentTileStyleZoom(map);
        // ── Fix #3: не клонируем exclusion-данные, если их нет ─────────────
        // (полное решение — отправка один раз через config — требует
        //  поддержки со стороны воркера; частичный фикс — убрать клон
        //  в самом частом случае, когда exclusion не используются.)
        const hasExclusions = this._exclusionAreas && this._exclusionAreas.length > 0;
        const exclusionPolygons = hasExclusions ? this._exclusionAreas : [];
        const exclusionLayers = hasExclusions ? this._exclusionLayersArray : [];
        const msg = {
            type: 'process', id, buffer, z, x, y, tileSize,
            maxMerc: map.MAX_MERCATOR,
            is3d,
            continuousZoom: map.continuousZoom + this.zoomOffset,
            styleZoom: effectiveStyleZoom,
            visibleLayers: this.visibleLayers,
            invisibleLayers: this.invisibleLayers,
            buildingEdges: this.buildingEdges,
            exclusionPolygons,
            exclusionLayers,
            maxTextPointsPerTile: this.maxTextPointsPerTile,
            maxTextLinesPerTile: this.maxTextLinesPerTile,
        };
        return new Promise((resolve, reject) => {
            this._pendingWorkerRequests.set(id, {
                resolve, reject, group: existingGroup || null,
                key: existingGroup ? null : `${z},${x},${y}`,
                generation, sourceZoom: z,
                styleZoom: effectiveStyleZoom, isIdentify: false,
            });
            try {
                this._worker.postMessage(msg, [buffer]);
            }
            catch (err) {
                this._pendingWorkerRequests.delete(id);
                reject(err);
            }
        });
    },
    async identify(sceneX, sceneZ, opts = {}) {
        if (!this._map || !this._worker)
            return { error: 'layer not attached' };
        const map = this._map;
        const sourceZoom = this._lastSourceZoom >= 0
            ? this._lastSourceZoom
            : Math.max(this.minNativeZoom, Math.min(map.currentDiscreteZoom + this.zoomOffset, this.maxNativeZoom));
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
        }
        else {
            const url = this.url
                .replaceAll('{z}', String(sourceZoom))
                .replaceAll('{x}', String(xSlippy))
                .replaceAll('{y}', String(ySlippy));
            try {
                const response = await fetch(url);
                if (!response.ok)
                    return { error: `HTTP ${response.status} for ${url}` };
                buffer = await response.arrayBuffer();
                this._setTileDataCache(dataCacheKey, buffer.slice(0));
            }
            catch (err) {
                return { error: `fetch failed: ${err.message}` };
            }
        }
        const centerX = xSlippy * tileSize - map.MAX_MERCATOR + tileSize / 2;
        const centerZ = -map.MAX_MERCATOR + ySlippy * tileSize + tileSize / 2;
        const clickLocalX = localX - centerX;
        const clickLocalZ = localZ - centerZ;
        return new Promise((resolve, reject) => {
            const id = ++this._requestId;
            const generation = this._generation;
            this._pendingWorkerRequests.set(id, {
                resolve, reject, group: null, key: null,
                generation, sourceZoom,
                styleZoom: Number.isFinite(this._transitionStyleZoom)
                    ? this._transitionStyleZoom
                    : map.currentDiscreteZoom + this.zoomOffset,
                isIdentify: true,
            });
            try {
                this._worker.postMessage({
                    type: 'identify', id, buffer,
                    z: sourceZoom, x: xSlippy, y: ySlippy,
                    tileSize, maxMerc: map.MAX_MERCATOR,
                    continuousZoom: map.continuousZoom + this.zoomOffset,
                    styleZoom: Number.isFinite(this._transitionStyleZoom)
                        ? this._transitionStyleZoom
                        : map.currentDiscreteZoom + this.zoomOffset,
                    localX: clickLocalX, localZ: clickLocalZ,
                    tolerance: opts.tolerance || tileSize * 0.005,
                    visibleLayers: this.visibleLayers,
                    invisibleLayers: this.invisibleLayers,
                }, [buffer]);
            }
            catch (err) {
                this._pendingWorkerRequests.delete(id);
                reject(err);
            }
        }).then((result) => {
            // ── автовызов диагностики ────────────────────────────────────
            if (this._debug) {
                try {
                    this.diagnoseAt(sceneX, sceneZ, result);
                }
                catch (e) {
                    console.warn('[VT DIAG] diagnoseAt failed:', e);
                }
            }
            // ─────────────────────────────────────────────────────────────
            return result;
        });
    },
};
