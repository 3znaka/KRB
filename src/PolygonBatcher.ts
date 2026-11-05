// PolygonBatcher.ts
import { THREE } from './js_TP/tpb.js';

const RENDER_ORDER = { BOTTOM: 900, SIDE: 901, TOP: 902, STROKE: 903 };
const DEFAULT_PATTERN_SCALE = 64;

/** Совместимо с ZoomInterpolation из SpatialObject / Polygon. */
export interface ZoomInterpolationLike {
    fillOpacity?: Array<[number, number]>;
}

interface Batchable {
    _getBatchStyleKey(): string | null;
    _getBatchGeometryData(): BatchGeometryData | null;
    _onBatchChange?(batched: boolean, batch: any): void;
    _batch?: any;
    _onClick?: ((e: MouseEvent, p: any) => void) | null;
    _isVisible?: boolean;
}

export interface BatchGeometryData {
    worldCoords: Array<[number, number]>;
    heights: number[];             // Y TOP-вершин
    indices: ArrayLike<number>;    // CCW-индексы top
    ringStarts: number[];          // границы колец в worldCoords
    extruded: boolean;
    height: number;                // top - bottom
    fillColor: string | number;
    fillOpacity: number;
    strokeColor: string | number;
    strokeWidth: number;
    strokeOpacity: number;
    useSimpleStroke: boolean;
    depthTest: boolean;
    depthWrite: boolean;
    castShadow: boolean;
    receiveShadow: boolean;
    roughness: number;
    metalness: number;
    fillPatternSource: string | null;
    fillPatternScale: number;
    fillPatternFit: 'tile' | 'bounds';
    centroidX: number;
    centroidZ: number;
    minZoom: number;
    maxZoom: number;
    altitudeMode: string;
    /**
     * Опционально: per-batch анимация прозрачности по зуму.
     * Заполняется Polygon._getBatchGeometryData() когда в Polygon снят
     * блокер `if (this._zoomInterpolations) return null;`.
     */
    zoomInterpolations?: ZoomInterpolationLike | null;
}

function isBatchable(obj: any): obj is Batchable {
    return !!obj
        && typeof obj._getBatchStyleKey === 'function'
        && typeof obj._getBatchGeometryData === 'function';
}

// =====================================================================
// BatchedGroup
// =====================================================================

class BatchedGroup {
    mesh: any = null;
    fillMaterial: any = null;
    strokeLine: any = null;
    strokeMaterial: any = null;
    readonly polygons: Batchable[];
    readonly polygonSet: Set<Batchable>;
    private _trianglesToPolygon: Batchable[] = [];
    private _unregister: (() => void) | null = null;
    private _map: any = null;
    private _anchorX = 0;
    private _anchorZ = 0;
    /** Центр сферы в local worldGroup координатах (anchor уже учтён). */
    private _boundingSphere: { center: any; radius: number } | null = null;
    /** Переиспользуемый вектор для getBoundingSphere (мир. координаты). */
    private _boundingSphereWorldCenter: any = null;
    private _minZoom = -Infinity;
    private _maxZoom = Infinity;
    /** Разделяемая текстура паттерна — владелец PolygonBatcher. */
    private _patternTexture: any = null;
    /** Интерполяция прозрачности по зуму (если была в данных). */
    private _zoomFillOpacity: Array<[number, number]> | null = null;
    private _baseFillOpacity = 1;
    private _baseStrokeOpacity = 1;
    private _disposed = false;

    constructor(polygons: Batchable[]) {
        this.polygons = polygons;
        this.polygonSet = new Set(polygons);
        this._boundingSphereWorldCenter = new THREE.Vector3();
    }

    build(map: any, getPatternTexture: (url: string) => any): void {
        this._map = map;

        const datas: Array<{ poly: Batchable; data: BatchGeometryData }> = [];
        for (const p of this.polygons) {
            const d = p._getBatchGeometryData();
            if (d && d.indices && d.indices.length >= 3) datas.push({ poly: p, data: d });
        }
        if (datas.length === 0) return;

        let sx = 0, sz = 0;
        for (const { data } of datas) { sx += data.centroidX; sz += data.centroidZ; }
        this._anchorX = sx / datas.length;
        this._anchorZ = sz / datas.length;

        const d0 = datas[0].data;
        this._minZoom = d0.minZoom;
        this._maxZoom = d0.maxZoom;
        this._baseFillOpacity = d0.fillOpacity;
        this._baseStrokeOpacity = d0.strokeOpacity;

        if (d0.fillPatternSource) {
            this._patternTexture = getPatternTexture(d0.fillPatternSource);
        }

        // Zoom-интерполяция прозрачности (готово к шагу B).
        const zi = d0.zoomInterpolations?.fillOpacity;
        if (zi && zi.length >= 2) {
            this._zoomFillOpacity = zi as Array<[number, number]>;
        }

        const patternScale = d0.fillPatternScale > 0 ? d0.fillPatternScale : DEFAULT_PATTERN_SCALE;
        const patternFit = d0.fillPatternFit;
        const batchOriginX = Math.floor(this._anchorX / patternScale) * patternScale;
        const batchOriginZ = Math.floor(this._anchorZ / patternScale) * patternScale;

        const positions: number[] = [];
        const uvs: number[] = [];
        const indices: number[] = [];
        const triPoly: Batchable[] = [];

        for (const { poly, data } of datas) {
            const baseVertex = positions.length / 3;
            const wc = data.worldCoords;
            const heights = data.heights;
            const n = wc.length;
            const height = data.height;
            const isExtruded = data.extruded && height > 0;

            let bboxMinX = 0, bboxSizeX = 1, bboxMinZ = 0, bboxSizeZ = 1;
            if (patternFit === 'bounds') {
                let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
                for (let i = 0; i < n; i++) {
                    const [x, z] = wc[i];
                    if (x < minX) minX = x;
                    if (x > maxX) maxX = x;
                    if (z < minZ) minZ = z;
                    if (z > maxZ) maxZ = z;
                }
                bboxMinX = minX; bboxMinZ = minZ;
                bboxSizeX = (maxX - minX) > 1e-6 ? (maxX - minX) : 1;
                bboxSizeZ = (maxZ - minZ) > 1e-6 ? (maxZ - minZ) : 1;
            }

            const pushUV = (wx: number, wz: number) => {
                if (patternFit === 'bounds') {
                    uvs.push((wx - bboxMinX) / bboxSizeX, (wz - bboxMinZ) / bboxSizeZ);
                } else {
                    uvs.push((wx - batchOriginX) / patternScale, (wz - batchOriginZ) / patternScale);
                }
            };

            // ── TOP ──
            for (let i = 0; i < n; i++) {
                const [wx, wz] = wc[i];
                positions.push(wx - this._anchorX, heights[i] ?? 0, wz - this._anchorZ);
                pushUV(wx, wz);
            }
            const idx = data.indices;
            for (let t = 0; t < idx.length; t += 3) {
                indices.push(idx[t] + baseVertex, idx[t + 1] + baseVertex, idx[t + 2] + baseVertex);
                triPoly.push(poly);
            }

            if (!isExtruded) continue;

            // ── BOTTOM ──
            const bottomBase = positions.length / 3;
            for (let i = 0; i < n; i++) {
                const [wx, wz] = wc[i];
                positions.push(wx - this._anchorX, (heights[i] ?? 0) - height, wz - this._anchorZ);
                pushUV(wx, wz);
            }
            for (let t = 0; t < idx.length; t += 3) {
                indices.push(
                    idx[t] + bottomBase,
                    idx[t + 2] + bottomBase,
                    idx[t + 1] + bottomBase,
                );
                triPoly.push(poly);
            }

            // ── SIDES (per-ring) ──
            const ringStarts = (data.ringStarts && data.ringStarts.length > 0) ? data.ringStarts : [0];
            for (let r = 0; r < ringStarts.length; r++) {
                const start = ringStarts[r];
                const end = (r + 1 < ringStarts.length) ? ringStarts[r + 1] : n;
                const count = end - start;
                if (count < 2) continue;

                let cum = 0;
                for (let i = 0; i < count; i++) {
                    const j = (i + 1) % count;
                    const idxI = start + i;
                    const idxJ = start + j;
                    const [wxi, wzi] = wc[idxI];
                    const [wxj, wzj] = wc[idxJ];
                    const topI = heights[idxI] ?? 0;
                    const topJ = heights[idxJ] ?? 0;

                    const quadBase = positions.length / 3;
                    positions.push(wxi - this._anchorX, topI, wzi - this._anchorZ);
                    positions.push(wxi - this._anchorX, topI - height, wzi - this._anchorZ);
                    positions.push(wxj - this._anchorX, topJ, wzj - this._anchorZ);
                    positions.push(wxj - this._anchorX, topJ - height, wzj - this._anchorZ);

                    const ddx = wxj - wxi;
                    const ddz = wzj - wzi;
                    const edgeLen = Math.sqrt(ddx * ddx + ddz * ddz);
                    const u0 = cum / patternScale;
                    const u1 = (cum + edgeLen) / patternScale;
                    const vH = height / patternScale;
                    uvs.push(u0, vH, u0, 0, u1, vH, u1, 0);
                    cum += edgeLen;

                    indices.push(quadBase, quadBase + 1, quadBase + 2);
                    indices.push(quadBase + 1, quadBase + 3, quadBase + 2);
                    triPoly.push(poly, poly);
                }
            }
        }

        this._trianglesToPolygon = triPoly;

        const geom = new THREE.BufferGeometry();
        geom.setAttribute('position', new THREE.BufferAttribute(new Float32Array(positions), 3));
        geom.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(uvs), 2));
        geom.setIndex(indices);
        // Нормали нужны MeshStandardMaterial (extruded). Для MeshBasic
        // они не используются — пропускаем, экономим цикл на rebuild.
        if (d0.extruded) geom.computeVertexNormals();
        geom.computeBoundingBox();
        geom.computeBoundingSphere();

        // Если будет zoom-анимация прозрачности — материал должен быть
        // transparent с самого начала, иначе анимация к 0 работать не будет.
        const animatedOpacity = !!this._zoomFillOpacity;
        const isTransparent = animatedOpacity || d0.fillOpacity < 1;

        let mat: any;
        if (d0.extruded) {
            mat = new THREE.MeshStandardMaterial({
                color: d0.fillColor as any,
                opacity: d0.fillOpacity,
                transparent: isTransparent,
                side: THREE.DoubleSide,
                roughness: d0.roughness,
                metalness: d0.metalness,
                depthTest: d0.depthTest,
                depthWrite: d0.depthWrite,
                polygonOffset: true,
                polygonOffsetFactor: -1,
                polygonOffsetUnits: -1,
                map: this._patternTexture ?? null,
            });
        } else {
            mat = new THREE.MeshBasicMaterial({
                color: d0.fillColor as any,
                opacity: d0.fillOpacity,
                transparent: isTransparent,
                side: THREE.DoubleSide,
                depthTest: d0.depthTest,
                depthWrite: d0.depthWrite,
                polygonOffset: true,
                polygonOffsetFactor: -1,
                polygonOffsetUnits: -1,
                map: this._patternTexture ?? null,
            });
        }
        this.fillMaterial = mat;

        const mesh = new THREE.Mesh(geom, mat);
        mesh.renderOrder = RENDER_ORDER.TOP;
        mesh.frustumCulled = true;
        if (d0.extruded) {
            mesh.castShadow = d0.castShadow;
            mesh.receiveShadow = d0.receiveShadow;
        }
        mesh.position.set(this._anchorX, 0, this._anchorZ);
        mesh.userData.batchedGroup = this;
        this.mesh = mesh;

        // ── Штрих: LineSegments по рёбрам top ──
        if (d0.strokeWidth > 0 && d0.strokeOpacity > 0 && d0.strokeColor != null) {
            const strokePos: number[] = [];
            for (const { data } of datas) {
                const wc = data.worldCoords;
                const h = data.heights;
                const n = wc.length;
                const rs = (data.ringStarts && data.ringStarts.length > 0) ? data.ringStarts : [0];
                for (let r = 0; r < rs.length; r++) {
                    const start = rs[r];
                    const end = (r + 1 < rs.length) ? rs[r + 1] : n;
                    const count = end - start;
                    if (count < 2) continue;
                    for (let i = 0; i < count; i++) {
                        const j = (i + 1) % count;
                        const a = start + i, b = start + j;
                        strokePos.push(
                            wc[a][0] - this._anchorX, h[a] ?? 0, wc[a][1] - this._anchorZ,
                            wc[b][0] - this._anchorX, h[b] ?? 0, wc[b][1] - this._anchorZ,
                        );
                    }
                }
            }
            const sGeom = new THREE.BufferGeometry();
            sGeom.setAttribute('position', new THREE.BufferAttribute(new Float32Array(strokePos), 3));
            sGeom.computeBoundingSphere();
            const sMat = new THREE.LineBasicMaterial({
                color: d0.strokeColor as any,
                opacity: d0.strokeOpacity,
                transparent: animatedOpacity || d0.strokeOpacity < 1,
                depthTest: d0.depthTest,
                depthWrite: d0.depthWrite,
            });
            const line = new THREE.LineSegments(sGeom, sMat);
            line.renderOrder = RENDER_ORDER.STROKE;
            line.position.set(this._anchorX, 0, this._anchorZ);
            this.strokeLine = line;
            this.strokeMaterial = sMat;
        }

        const bs = geom.boundingSphere;
        if (bs) {
            this._boundingSphere = {
                center: new THREE.Vector3(
                    this._anchorX + bs.center.x,
                    bs.center.y,
                    this._anchorZ + bs.center.z,
                ),
                radius: bs.radius,
            };
        }

        this._registerInteraction(map);
    }

    private _registerInteraction(map: any): void {
        if (!map.interaction || !this.mesh) return;
        if (this._unregister) { this._unregister(); this._unregister = null; }
        this._unregister = map.interaction.register(this, {
            getMeshes: () => this.mesh ? [this.mesh] : [],
            // Возвращаем центр в МИРОВЫХ координатах — в отличие от
            // прежней версии, которая отдавала локальные (без
            // worldGroup.position). Из-за этого каллинг ломался
            // при панорамировании (worldGroup сдвигается).
            getBoundingSphere: () => {
                if (!this._boundingSphere) return null;
                const wgPos = map.worldGroup.position;
                this._boundingSphereWorldCenter.set(
                    this._boundingSphere.center.x + wgPos.x,
                    this._boundingSphere.center.y + wgPos.y,
                    this._boundingSphere.center.z + wgPos.z,
                );
                return {
                    center: this._boundingSphereWorldCenter,
                    radius: this._boundingSphere.radius,
                };
            },
            isVisible: () => this.mesh?.visible ?? false,
            onClick: (event: MouseEvent) => {
                const poly = this._pickPolygon(event, map);
                if (poly && poly._onClick) poly._onClick(event, poly);
            },
        });
    }

    private _pickPolygon(event: MouseEvent, map: any): Batchable | null {
        if (!this.mesh) return null;
        const canvas = map.renderer.domElement;
        const rect = canvas.getBoundingClientRect();
        const ndcX = ((event.clientX - rect.left) / rect.width) * 2 - 1;
        const ndcY = -((event.clientY - rect.top) / rect.height) * 2 + 1;
        const rc = map._tempRaycaster;
        const mouse = map._tempMouse;
        rc.setFromCamera(mouse.set(ndcX, ndcY), map.camera);
        const hits = rc.intersectObject(this.mesh, false);
        if (hits.length === 0) return null;
        const faceIdx = hits[0].faceIndex;
        if (faceIdx == null) return null;
        return this._trianglesToPolygon[faceIdx] ?? null;
    }

    update(map: any, layerVisible: boolean): void {
        if (!this.mesh) return;
        const z = map.continuousZoom;
        const visible = layerVisible && z >= this._minZoom && z <= this._maxZoom;
        this.mesh.visible = visible;
        if (this.strokeLine) this.strokeLine.visible = visible;
        if (!visible) return;

        // Zoom-анимация прозрачности. Работает только если
        // BatchGeometryData.zoomInterpolations был передан Polygon'ом.
        if (this._zoomFillOpacity) {
            const [z0, o0] = this._zoomFillOpacity[0];
            const [z1, o1] = this._zoomFillOpacity[1];
            const t = (z <= z0) ? 0 : (z >= z1) ? 1 : (z - z0) / (z1 - z0 || 1);
            const opMul = o0 + (o1 - o0) * t;
            const fillOp = this._baseFillOpacity * opMul;
            const strokeOp = this._baseStrokeOpacity * opMul;
            if (this.fillMaterial && this.fillMaterial.opacity !== fillOp) {
                this.fillMaterial.opacity = fillOp;
            }
            if (this.strokeMaterial && this.strokeMaterial.opacity !== strokeOp) {
                this.strokeMaterial.opacity = strokeOp;
            }
        }
    }

    dispose(): void {
        if (this._disposed) return;
        this._disposed = true;
        if (this._unregister) { try { this._unregister(); } catch { /* swallow */ } this._unregister = null; }
        if (this.mesh) {
            this.mesh.geometry?.dispose();
            this.mesh.material?.dispose();
            if (this.mesh.parent) this.mesh.parent.remove(this.mesh);
        }
        if (this.strokeLine) {
            this.strokeLine.geometry?.dispose();
            this.strokeLine.material?.dispose();
            if (this.strokeLine.parent) this.strokeLine.parent.remove(this.strokeLine);
        }
        // Паттерн НЕ наш — им владеет PolygonBatcher (кэш по URL).
        this._patternTexture = null;
        this.mesh = null;
        this.strokeLine = null;
        this.fillMaterial = null;
        this.strokeMaterial = null;
        this._trianglesToPolygon = [];
        this._boundingSphere = null;
        this._boundingSphereWorldCenter = null;
    }
}

// =====================================================================
// PolygonBatcher
// =====================================================================

export class PolygonBatcher {
    private _layer: any;
    private _map: any = null;
    private _group: any;
    private _batches = new Map<string, BatchedGroup>();
    private _polygonToBatch = new Map<Batchable, BatchedGroup>();
    private _patternTextures = new Map<string, any>();
    private _pendingRebuild = false;
    private _dirtyTime = 0;
    private _lastCheckTime = 0;
    private _checkInterval = 500;
    private _debounceMs = 100;
    private _disposed = false;

    constructor(layer: any) {
        this._layer = layer;
        this._group = new THREE.Group();
    }

    addTo(map: any): void {
        this._map = map;
        if (this._group.parent !== map.worldGroup) {
            this._group.parent?.remove(this._group);
            map.worldGroup.add(this._group);
        }
        this.markDirty();
    }

    removeFromMap(): void {
        for (const batch of this._batches.values()) {
            batch.dispose();
            for (const p of batch.polygons) {
                (p as any)._batch = null;
                p._onBatchChange?.(false, null);
            }
        }
        this._batches.clear();
        this._polygonToBatch.clear();
        if (this._group.parent) this._group.parent.remove(this._group);
        this._map = null;
    }

    markDirty(): void {
        this._pendingRebuild = true;
        this._dirtyTime = performance.now();
    }

    /** Общая текстура паттерна по URL (для всех батчей слоя). */
    private _getPatternTexture(url: string): any {
        let tex = this._patternTextures.get(url);
        if (tex) return tex;

        const loader = new THREE.TextureLoader();
        loader.setCrossOrigin('anonymous');
        tex = loader.load(url, undefined, undefined, (err: any) => {
            console.warn('PolygonBatcher: pattern load failed', err);
        });
        tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
        tex.generateMipmaps = false;
        tex.minFilter = THREE.LinearFilter;
        tex.magFilter = THREE.LinearFilter;

        const caps = this._map?.renderer?.capabilities;
        if (caps && typeof caps.getMaxAnisotropy === 'function') {
            try { tex.anisotropy = Math.min(16, caps.getMaxAnisotropy()); } catch { /* swallow */ }
        }
        const Ctor = THREE as any;
        if (Ctor.SRGBColorSpace && !tex.colorSpace) tex.colorSpace = Ctor.SRGBColorSpace;
        tex.needsUpdate = true;

        this._patternTextures.set(url, tex);
        return tex;
    }

    update(map: any, _deltaTime?: number): void {
        if (this._disposed || !this._map) return;
        const now = performance.now();

        if (this._pendingRebuild) {
            if (now - this._dirtyTime >= this._debounceMs) {
                this._rebuild();
                this._pendingRebuild = false;
                this._lastCheckTime = now;
            }
        } else if (now - this._lastCheckTime >= this._checkInterval) {
            if (this._shouldRebuild()) this._rebuild();
            this._lastCheckTime = now;
        }

        const layerVisible = this._layer.visible !== false;
        for (const batch of this._batches.values()) {
            batch.update(map, layerVisible);
        }
    }

    private _shouldRebuild(): boolean {
        const objects: any[] = this._layer._objects ?? [];
        let batchableCount = 0;
        for (const obj of objects) {
            if (!isBatchable(obj)) continue;
            const key = obj._getBatchStyleKey();
            if (!key) continue;
            batchableCount++;
            const expected = this._batches.get(key);
            if (!expected || !expected.polygonSet.has(obj)) return true;
        }
        return batchableCount !== this._polygonToBatch.size;
    }

    private _rebuild(): void {
        if (!this._map) return;

        const groups = new Map<string, Batchable[]>();
        for (const obj of (this._layer._objects ?? [])) {
            if (!isBatchable(obj)) continue;
            if ((obj as any)._userVisible === false) continue;
            const key = obj._getBatchStyleKey();
            if (!key) continue;
            let arr = groups.get(key);
            if (!arr) { arr = []; groups.set(key, arr); }
            arr.push(obj);
        }

        const oldPolygons = new Set<Batchable>(this._polygonToBatch.keys());
        for (const batch of this._batches.values()) batch.dispose();
        this._batches.clear();
        this._polygonToBatch.clear();

        for (const [key, polys] of groups) {
            if (this._map.hasElevation) {
                const anyDynamic = polys.some(p => (p as any)._altitudeMode === 'clampToGround');
                if (anyDynamic) continue;
            }
            const batch = new BatchedGroup(polys);
            batch.build(this._map, (url) => this._getPatternTexture(url));
            if (!batch.mesh) continue;
            this._group.add(batch.mesh);
            if (batch.strokeLine) this._group.add(batch.strokeLine);
            this._batches.set(key, batch);
            for (const p of polys) {
                (p as any)._batch = batch;
                p._onBatchChange?.(true, batch);
                this._polygonToBatch.set(p, batch);
            }
        }

        // Полигоны, которые больше не входят ни в один батч,
        // разбатчиваем — у них пересоберётся своя геометрия.
        for (const p of oldPolygons) {
            if (!this._polygonToBatch.has(p)) {
                p._onBatchChange?.(false, null);
            }
        }
    }

    dispose(): void {
        this._disposed = true;
        this.removeFromMap();
        for (const tex of this._patternTextures.values()) {
            try { tex.dispose?.(); } catch { /* swallow */ }
        }
        this._patternTextures.clear();
    }
}

import { Layer } from './Layers.js';
if (typeof Layer.setBatcherFactory === 'function') {
    Layer.setBatcherFactory((layer: any) => new PolygonBatcher(layer));
}