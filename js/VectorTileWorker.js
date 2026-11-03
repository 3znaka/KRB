// VectorTileWorker.ts
import { THREE, Line2, LineSegmentsGeometry } from './js_TP/tpb.js';
import { stringToBase64, createWorkerCode } from './vectorTileWorkerCode.js';
import { VECTOR_TILE_RENDER_ORDER } from './VectorTileTypes.js';
const _MODULE_DIR = new URL('.', import.meta.url).href;
export const _DEFAULT_WORKER_SCRIPTS = [
    new URL('./js_TP/tpb.js', _MODULE_DIR).href,
    new URL('./js_TP/earcut.js', _MODULE_DIR).href,
];
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
export const VectorTileWorkerMixin = {
    async _initWorker() {
        const token = (this._workerInitToken || 0) + 1;
        this._workerInitToken = token;
        const [tpbUrl, earcutUrl] = this._workerScriptUrls;
        try {
            const blobUrl = await _getSharedWorkerBlobUrl(tpbUrl, earcutUrl);
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
            const built = this._buildGroupFromWorkerResult(group, data.result, pending.sourceZoom);
            if (!built) {
                pending.resolve(null);
                return;
            }
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
    // ── Деформация tile-CRS → map-CRS ─────────────────────────────────────
    _computeTileDeform(z, tileCX, tileCZ) {
        const tileCrs = this._tileCrs;
        const halfX = tileCrs.halfExtentX;
        const halfY = tileCrs.halfExtentY;
        const tsX = (2 * halfX) / (1 << z);
        const tsY = (2 * halfY) / (1 << z);
        const htX = tsX / 2;
        const htY = tsY / 2;
        const c00 = this._tileToMap(tileCX - htX, tileCZ - htY);
        const c10 = this._tileToMap(tileCX + htX, tileCZ - htY);
        const c01 = this._tileToMap(tileCX - htX, tileCZ + htY);
        const c11 = this._tileToMap(tileCX + htX, tileCZ + htY);
        if (!c00 || !c10 || !c01 || !c11)
            return null;
        const mapCX = (c00.x + c10.x + c01.x + c11.x) / 4;
        const mapCZ = (c00.z + c10.z + c01.z + c11.z) / 4;
        // Порог вырожденности — по большему из размеров тайла в tile-CRS.
        const maxSide = Math.max(Math.hypot(c10.x - c00.x, c10.z - c00.z), Math.hypot(c01.x - c00.x, c01.z - c00.z), Math.hypot(c11.x - c10.x, c11.z - c10.z), Math.hypot(c11.x - c01.x, c11.z - c01.z));
        if (!Number.isFinite(maxSide))
            return null;
        if (maxSide > Math.max(tsX, tsY) * 20)
            return null;
        return { c00, c10, c01, c11, mapCX, mapCZ, htX, htY };
    },
    _bilinear(df, lx, lz, out) {
        const u = (lx + df.htX) / (2 * df.htX);
        const v = (lz + df.htY) / (2 * df.htY);
        const { c00, c10, c01, c11 } = df;
        const x = (1 - u) * (1 - v) * c00.x + u * (1 - v) * c10.x +
            (1 - u) * v * c01.x + u * v * c11.x;
        const z = (1 - u) * (1 - v) * c00.z + u * (1 - v) * c10.z +
            (1 - u) * v * c01.z + u * v * c11.z;
        out.x = x - df.mapCX;
        out.z = z - df.mapCZ;
    },
    _deformArray(pos, df) {
        const tmp = { x: 0, z: 0 };
        for (let i = 0; i < pos.length; i += 3) {
            this._bilinear(df, pos[i], pos[i + 2], tmp);
            pos[i] = tmp.x;
            pos[i + 2] = tmp.z;
        }
    },
    _deformGeometry(geom, df) {
        const attr = geom.attributes.position;
        this._deformArray(attr.array, df);
        attr.needsUpdate = true;
    },
    _deformXZ(x, z, df) {
        const out = { x: 0, z: 0 };
        this._bilinear(df, x, z, out);
        return out;
    },
    // ── Сборка группы ─────────────────────────────────────────────────────
    _buildGroupFromWorkerResult(group, result, sourceZoom) {
        this._removeTextLabelsForGroup(group);
        group.renderOrder = this._tileGroupRenderOrder;
        const tileCX = result.centerX ?? 0;
        const tileCZ = result.centerZ ?? 0;
        let df = null;
        if (this._isDeformed) {
            df = this._computeTileDeform(sourceZoom, tileCX, tileCZ);
            if (!df)
                return false; // тайл вне домена / вырожден — пропускаем целиком
        }
        group.position.set(df ? df.mapCX : tileCX, 0, df ? df.mapCZ : tileCZ);
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
        // ── Fills ─────────────────────────────────────────────────────
        for (const fill of result.fills || []) {
            const mat = this._getFillMaterialFromData(fill.layerName, fill.color, fill.opacity);
            const geom = new THREE.BufferGeometry();
            geom.setAttribute('position', new THREE.BufferAttribute(fill.positions, 3));
            if (fill.indices)
                geom.setIndex(new THREE.BufferAttribute(fill.indices, 1));
            if (df)
                this._deformGeometry(geom, df);
            const mesh = new THREE.Mesh(geom, mat);
            const rawFillOrder = typeof fill.renderOrder === 'number' && Number.isFinite(fill.renderOrder)
                ? fill.renderOrder
                : VECTOR_TILE_RENDER_ORDER.FILL;
            const isTransportationFill = fill.layerName === 'transportation';
            mesh.renderOrder = isTransportationFill ? 200_000 + rawFillOrder : rawFillOrder;
            mesh.position.y = isTransportationFill ? 0.04 : 0;
            group.add(mesh);
        }
        // ── Buildings ─────────────────────────────────────────────────
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
                if (df) {
                    this._deformGeometry(geom, df);
                    geom.computeVertexNormals();
                }
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
                    if (df)
                        this._deformGeometry(edgeGeom, df);
                    const lines = new THREE.LineSegments(edgeGeom, this._getBuildingEdgeMaterial(g.stroke || 0x555555, isTransparent ? opacity * 0.35 : 1));
                    lines.renderOrder = VECTOR_TILE_RENDER_ORDER.EDGE;
                    group.add(lines);
                }
            }
        }
        // ── Lines / strokes ───────────────────────────────────────────
        for (const line of result.lines || []) {
            const mat = this._getDynamicLineMaterial(line);
            if (!mat)
                continue;
            this._addFatLineFromPositions(group, line.positions, mat, line.renderOrder, df);
        }
        for (const stroke of result.strokes || []) {
            const mat = this._getLineMaterialFromData(stroke.layerName, stroke.color, stroke.width, stroke.dash);
            this._addFatLineFromPositions(group, stroke.positions, mat, stroke.renderOrder, df);
        }
        // ── Points ────────────────────────────────────────────────────
        for (const pt of result.points || []) {
            if (df) {
                const p = this._deformXZ(pt.x, pt.z, df);
                pt.x = p.x;
                pt.z = p.z;
            }
            const fillKey = `fill:${pt.layerName}:${pt.color.toString(16)}:${pt.opacity}`;
            const mat = this._getFillMaterial(fillKey);
            const geometry = this._getPointGeometry(pt.radius);
            const mesh = new THREE.Mesh(geometry, mat);
            mesh.position.set(pt.x, 0, pt.z);
            mesh.renderOrder = pt.renderOrder ?? VECTOR_TILE_RENDER_ORDER.BUILDING;
            group.add(mesh);
        }
        // ── TextPoints / TextLines ────────────────────────────────────
        const textPoints = result.textPoints || [];
        if (df) {
            for (const tp of textPoints) {
                const p = this._deformXZ(tp.x, tp.z, df);
                tp.x = p.x;
                tp.z = p.z;
            }
        }
        this._enrichTextPointsWithIcons(textPoints);
        group.userData.textPointsData = textPoints;
        const textLines = result.textLines || [];
        if (df) {
            for (const tl of textLines) {
                for (const p of tl.points) {
                    const r = this._deformXZ(p.x, p.z, df);
                    p.x = r.x;
                    p.z = r.z;
                }
            }
        }
        group.userData.textLinesData = textLines;
        group.userData.lineLabelSources = null;
        group.userData.textLabels = [];
        group.userData.is3d = !!result.is3d;
        return true;
    },
    _enrichTextPointsWithIcons(points) {
        if (!points || points.length === 0)
            return;
        const styles = this._styles;
        if (!styles)
            return;
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
            if (pt.iconScale == null)
                pt.iconScale = style.iconScale ?? style['icon-scale'] ?? 1;
            if (pt.iconOffset == null)
                pt.iconOffset = style.iconOffset ?? style['icon-offset'] ?? [0, 0];
            if (pt.iconCircleScale == null)
                pt.iconCircleScale = style.iconCircleScale;
            if (pt.iconGlyphRatio == null)
                pt.iconGlyphRatio = style.iconGlyphRatio;
            if (pt.iconColor == null) {
                const cls = pt.properties?.class || pt.class;
                pt.iconColor = style.classColors?.[cls] ?? '#888888';
            }
        }
    },
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
                    : pt[key];
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
    _addFatLineFromPositions(group, positions, material, renderOrder, deform = null) {
        const segs = this._fatLineSegmentsFromPositions(positions);
        if (!segs)
            return;
        if (deform)
            this._deformArray(segs, deform);
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
        const tileHalfX = this._tileCrs.halfExtentX;
        const effectiveStyleZoom = Number.isFinite(styleZoom)
            ? styleZoom
            : this._getCurrentTileStyleZoom(map);
        const hasExclusions = this._exclusionAreas && this._exclusionAreas.length > 0;
        const exclusionPolygons = hasExclusions ? this._exclusionAreas : [];
        const exclusionLayers = hasExclusions ? this._exclusionLayersArray : [];
        const tileHalfY = this._tileCrs.halfExtentY;
        const tileSizeX = (2 * tileHalfX) / (1 << z);
        const tileSizeY = (2 * tileHalfY) / (1 << z);
        const msg = {
            type: 'process', id, buffer, z, x, y,
            tileSizeX, tileSizeY,
            maxMercX: tileHalfX, maxMercY: tileHalfY,
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
        const tileHalfX = this._tileCrs.halfExtentX;
        const tileHalfY = this._tileCrs.halfExtentY;
        const tileSizeX = (2 * tileHalfX) / (1 << sourceZoom);
        const tileSizeY = (2 * tileHalfY) / (1 << sourceZoom);
        const numTiles = 1 << sourceZoom;
        let localX = sceneX - map.worldGroup.position.x;
        let localZ = sceneZ - map.worldGroup.position.z;
        if (this._isDeformed) {
            const t = this._mapToTile(localX, localZ);
            if (!t)
                return { error: 'click outside projection domain' };
            localX = t.x;
            localZ = t.z;
        }
        const tx = (localX + tileHalfX) / tileSizeX;
        const tz = (localZ + tileHalfY) / tileSizeY;
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
        const centerX = xSlippy * tileSizeX - tileHalfX + tileSizeX / 2;
        const centerZ = -tileHalfY + ySlippy * tileSizeY + tileSizeY / 2;
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
                    tileSizeX, tileSizeY, maxMercX: tileHalfX, maxMercY: tileHalfY,
                    continuousZoom: map.continuousZoom + this.zoomOffset,
                    styleZoom: Number.isFinite(this._transitionStyleZoom)
                        ? this._transitionStyleZoom
                        : map.currentDiscreteZoom + this.zoomOffset,
                    localX: clickLocalX, localZ: clickLocalZ,
                    tolerance: opts.tolerance || Math.min(tileSizeX, tileSizeY) * 0.005,
                    visibleLayers: this.visibleLayers,
                    invisibleLayers: this.invisibleLayers,
                }, [buffer]);
            }
            catch (err) {
                this._pendingWorkerRequests.delete(id);
                reject(err);
            }
        }).then((result) => {
            if (this._debug) {
                try {
                    this.diagnoseAt(sceneX, sceneZ, result);
                }
                catch (e) {
                    console.warn('[VT DIAG] diagnoseAt failed:', e);
                }
            }
            return result;
        });
    },
};
