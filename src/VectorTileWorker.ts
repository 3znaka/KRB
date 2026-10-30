// VectorTileWorker.ts
import { THREE, Line2, LineSegmentsGeometry } from './js_TP/tpb.js';
import { stringToBase64, createWorkerCode } from './vectorTileWorkerCode.js';
import type { WorkerResult, PendingWorkerRequest } from './VectorTileTypes.js';
import { VECTOR_TILE_RENDER_ORDER, flatY } from './VectorTileTypes.js';

// ============================================================================
// Module-level shared blob cache
// ============================================================================

const _MODULE_DIR = new URL('.', import.meta.url).href;
export const _DEFAULT_WORKER_SCRIPTS = [
    new URL('./js_TP/tpb.js', _MODULE_DIR).href,
    new URL('./js_TP/earcut.js', _MODULE_DIR).href,
];

const _workerBlobUrlCache = new Map<string, Promise<string>>();

function _getSharedWorkerBlobUrl(tpbUrl: string, earcutUrl: string): Promise<string> {
    const key = tpbUrl + '|' + earcutUrl;
    const cached = _workerBlobUrlCache.get(key);
    if (cached) return cached;

    const promise = (async () => {
        const [tpbRes, earcutRes] = await Promise.all([fetch(tpbUrl), fetch(earcutUrl)]);
        if (!tpbRes.ok) throw new Error(`HTTP ${tpbRes.status} for ${tpbUrl}`);
        if (!earcutRes.ok) throw new Error(`HTTP ${earcutRes.status} for ${earcutUrl}`);

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
    async _initWorker(this: any): Promise<void> {
        const [tpbUrl, earcutUrl] = this._workerScriptUrls;
        try {
            const blobUrl = await _getSharedWorkerBlobUrl(tpbUrl, earcutUrl);
            this._worker = new Worker(blobUrl, { type: 'module' });
            this._worker.onmessage = (e: MessageEvent) => this._onWorkerMessage(e.data);
            this._worker.onerror = (err: any) => console.error('VectorTile worker error:', err);
            this._worker.postMessage({ type: 'config', styles: this._styles });
        } catch (err) {
            console.error('Failed to initialize worker:', err);
        }
    },

    _onWorkerMessage(this: any, data: any): void {
        if (!data || typeof data.id === 'undefined') return;
        const pending: PendingWorkerRequest | undefined = this._pendingWorkerRequests.get(data.id);
        if (!pending) return;
        this._pendingWorkerRequests.delete(data.id);

        if (data.error) {
            if (pending.group) this._disposeTile(pending.group);
            pending.reject(new Error(data.error));
            return;
        }
        if (!data.result) {
            if (pending.group) this._disposeTile(pending.group);
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
            if (pending.group) this._disposeTile(pending.group);
            pending.resolve(null);
            return;
        }

        const group = pending.group || new THREE.Group();
        try {
            this._buildGroupFromWorkerResult(group, data.result as WorkerResult);
            group.userData.sourceZoom = pending.sourceZoom;
            group.userData.styleZoom = pending.styleZoom;
            group.userData.generation = pending.generation;
        } catch (err) {
            console.error('[VectorTile] Failed to build tile group:', err);
            this._disposeTile(group);
            pending.reject(err as Error);
            return;
        }

        this._labelsDirty = true;
        pending.resolve(group);
    },

    _buildGroupFromWorkerResult(this: any, group: THREE.Group, result: WorkerResult): void {
        this._removeTextLabelsForGroup(group);
        group.renderOrder = this._tileGroupRenderOrder;

        if (result.centerX !== undefined && result.centerZ !== undefined) {
            group.position.set(result.centerX, 0, result.centerZ);
        }

        while (group.children.length) {
            const child = group.children[0] as any;
            if (child.geometry && !this._managedGeometries.has(child.geometry)) child.geometry.dispose();
            if (child.material && !this._managedMaterials.has(child.material)) child.material.dispose?.();
            group.remove(child);
        }

        for (const fill of result.fills || []) {
            const mat = this._getFillMaterialFromData(fill.layerName, fill.color, fill.opacity);
            const geom = new THREE.BufferGeometry();
            geom.setAttribute('position', new THREE.BufferAttribute(fill.positions, 3));
            if (fill.indices) geom.setIndex(new THREE.BufferAttribute(fill.indices, 1));
            const mesh = new THREE.Mesh(geom, mat);
            const ro = fill.renderOrder ?? VECTOR_TILE_RENDER_ORDER.FILL;
            mesh.renderOrder = ro;
            mesh.position.y = flatY(ro);
            group.add(mesh);
        }

        if (result.buildings && result.buildings.length > 0) {
            const byColor = new Map<number, { color: number; stroke?: number; pos: Float32Array[]; nrm: Float32Array[]; edg: Float32Array[]; }>();
            for (const b of result.buildings) {
                if (!byColor.has(b.color)) {
                    byColor.set(b.color, { color: b.color, stroke: b.stroke, pos: [], nrm: [], edg: [] });
                }
                const g = byColor.get(b.color)!;
                g.pos.push(b.positions);
                g.nrm.push(b.normals);
                if (b.edgePositions) g.edg.push(b.edgePositions);
            }
            const opacity = this.buildings3dOpacity;
            const isTransparent = opacity < 1;
            for (const g of byColor.values()) {
                const geom = new THREE.BufferGeometry();
                geom.setAttribute('position', new THREE.BufferAttribute(this._concatF32(g.pos), 3));
                geom.setAttribute('normal', new THREE.BufferAttribute(this._concatF32(g.nrm), 3));
                const mesh = new THREE.Mesh(geom, this._getBuildingMaterial(g.color, opacity));
                mesh.renderOrder = VECTOR_TILE_RENDER_ORDER.BUILDING;
                group.add(mesh);

                if (this.buildingEdges && g.edg.length) {
                    const edgeGeom = new THREE.BufferGeometry();
                    edgeGeom.setAttribute('position', new THREE.BufferAttribute(this._concatF32(g.edg), 3));
                    const lines = new THREE.LineSegments(
                        edgeGeom,
                        this._getBuildingEdgeMaterial(g.stroke || 0x555555, isTransparent ? opacity * 0.35 : 1)
                    );
                    lines.renderOrder = VECTOR_TILE_RENDER_ORDER.EDGE;
                    group.add(lines);
                }
            }
        }

        for (const line of result.lines || []) {
            const mat = this._getDynamicLineMaterial(line);
            if (!mat) continue;
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
            const ro = pt.renderOrder ?? VECTOR_TILE_RENDER_ORDER.BUILDING;
            mesh.position.set(pt.x, flatY(ro), pt.z);
            mesh.renderOrder = ro;
            group.add(mesh);
        }

        group.userData.textPointsData = result.textPoints || [];
        group.userData.textLinesData = result.textLines || [];
        group.userData.lineLabelSources = null;
        group.userData.textLabels = [];
        group.userData.is3d = !!result.is3d;
    },

    _fatLineSegmentsFromPositions(this: any, positions: Float32Array | ArrayLike<number> | undefined): Float32Array | null {
        if (!positions || positions.length < 6) return null;
        const out: number[] = [];
        let havePrev = false;
        let px = 0, py = 0, pz = 0;
        for (let i = 0; i < positions.length; i += 3) {
            const x = positions[i], y = positions[i + 1], z = positions[i + 2];
            if (Number.isNaN(x)) { havePrev = false; continue; }
            if (havePrev) out.push(px, py, pz, x, y, z);
            px = x; py = y; pz = z; havePrev = true;
        }
        return out.length > 0 ? new Float32Array(out) : null;
    },

    _addFatLineFromPositions(
        this: any,
        group: THREE.Group,
        positions: Float32Array | ArrayLike<number> | undefined,
        material: any,
        renderOrder: number | undefined,
    ): void {
        const segs = this._fatLineSegmentsFromPositions(positions);
        if (!segs) return;

   const lGeo = new LineSegmentsGeometry();
        lGeo.setPositions(segs as unknown as number[]);
        const lineObj = new Line2(lGeo, material);

        if (material.dashed) {
            if (typeof (lineObj as any).computeLineDistances === 'function') {
                (lineObj as any).computeLineDistances();
            } else if (typeof (lGeo as any).computeLineDistances === 'function') {
                (lGeo as any).computeLineDistances();
            } else {
                console.warn('[VectorTile] computeLineDistances() недоступен ни у Line2, ни у LineSegmentsGeometry.');
            }
        }

        lineObj.renderOrder = renderOrder ?? VECTOR_TILE_RENDER_ORDER.LINE;
        lineObj.position.y = flatY(lineObj.renderOrder);
        lineObj.frustumCulled = false;
        group.add(lineObj);
    },

    async _sendToWorker(
        this: any,
        buffer: ArrayBuffer, z: number, x: number, y: number, is3d: boolean,
        existingGroup: THREE.Group | null = null,
        generation = this._generation,
        styleZoom = this._transitionStyleZoom,
    ): Promise<THREE.Group | null> {
        if (generation !== this._generation || z !== this._lastSourceZoom) return null;
        await this._workerReady;
        if (generation !== this._generation || z !== this._lastSourceZoom) return null;
        if (!this._worker || !this._map) return null;

        const map = this._map;
        const id = ++this._requestId;
        const tileSize = map.WORLD_SIZE / (1 << z);
        const effectiveStyleZoom = Number.isFinite(styleZoom)
            ? styleZoom
            : this._getCurrentTileStyleZoom(map);

        const msg = {
            type: 'process', id, buffer, z, x, y, tileSize,
            maxMerc: map.MAX_MERCATOR,
            is3d,
            continuousZoom: map.continuousZoom + this.zoomOffset,
            styleZoom: effectiveStyleZoom,
            visibleLayers: this.visibleLayers,
            buildingEdges: this.buildingEdges,
            exclusionPolygons: this._exclusionAreas,
            exclusionLayers: Array.from(this._exclusionLayers),
            maxTextPointsPerTile: this.maxTextPointsPerTile,
            maxTextLinesPerTile: this.maxTextLinesPerTile,
        };

        return new Promise<THREE.Group | null>((resolve, reject) => {
            this._pendingWorkerRequests.set(id, {
                resolve, reject, group: existingGroup || null,
                key: existingGroup ? null : `${z},${x},${y}`,
                generation, sourceZoom: z,
                styleZoom: effectiveStyleZoom, isIdentify: false,
            });
            try {
                this._worker!.postMessage(msg, [buffer]);
            } catch (err) {
                this._pendingWorkerRequests.delete(id);
                reject(err);
            }
        });
    },

    async identify(this: any, sceneX: number, sceneZ: number, opts: { tolerance?: number } = {}): Promise<any> {
        if (!this._map || !this._worker) return { error: 'layer not attached' };
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
        } else {
            const url = this.url!
                .replaceAll('{z}', String(sourceZoom))
                .replaceAll('{x}', String(xSlippy))
                .replaceAll('{y}', String(ySlippy));
            try {
                const response = await fetch(url);
                if (!response.ok) return { error: `HTTP ${response.status} for ${url}` };
                buffer = await response.arrayBuffer();
                this._setTileDataCache(dataCacheKey, buffer.slice(0));
            } catch (err: any) {
                return { error: `fetch failed: ${err.message}` };
            }
        }

        const centerX = xSlippy * tileSize - map.MAX_MERCATOR + tileSize / 2;
        const centerZ = -map.MAX_MERCATOR + ySlippy * tileSize + tileSize / 2;
        const clickLocalX = localX - centerX;
        const clickLocalZ = localZ - centerZ;

        return new Promise<any>((resolve, reject) => {
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
                this._worker!.postMessage({
                    type: 'identify', id, buffer,
                    z: sourceZoom, x: xSlippy, y: ySlippy,
                    tileSize, maxMerc: map.MAX_MERCATOR,
                    continuousZoom: map.continuousZoom + this.zoomOffset,
                    styleZoom: Number.isFinite(this._transitionStyleZoom)
                        ? this._transitionStyleZoom
                        : map.currentDiscreteZoom + this.zoomOffset,
                    localX: clickLocalX, localZ: clickLocalZ,
                    tolerance: opts.tolerance || tileSize * 0.005,
                }, [buffer]);
            } catch (err) {
                this._pendingWorkerRequests.delete(id);
                reject(err);
            }
        });
    },
};