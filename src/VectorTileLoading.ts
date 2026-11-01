// VectorTileLoading.ts
import { THREE } from './js_TP/tpb.js';

export const VectorTileLoadingMixin = {
    _prefetchNextZoom(this: any, z: number): void {
        const map = this._map;
        if (!map) return;
        if (this._disposed) return;
        if (z < this.minNativeZoom || z > this.maxNativeZoom) return;

        // Ограничиваем параллельные префетч-запросы. Если лимит упёрся —
        // прогресс продолжится на следующем тике (метод дёргается из _postUpdate).
        const maxPrefetch = this._maxPrefetchInFlight
            ?? Math.min(this._maxConcurrent ?? 4, 2);

        for (const key of this._getVisibleTileKeys(z)) {
            if (this._prefetchInFlight.size >= maxPrefetch) break;

            const c1 = key.indexOf(',');
            const c2 = key.indexOf(',', c1 + 1);
            const pz = +key.slice(0, c1);
            const px = +key.slice(c1 + 1, c2);
            const py = +key.slice(c2 + 1);
            const dataKey = `${pz}/${px}/${py}`;
            if (this._tileDataCache.has(dataKey)) continue;
            if (this._prefetchInFlight.has(dataKey)) continue;

            const url = this.url!
                .replaceAll('{z}', String(pz))
                .replaceAll('{x}', String(px))
                .replaceAll('{y}', String(py));
            const promise = fetch(url)
                .then((r) => (r.ok ? r.arrayBuffer() : null))
                .then((buf) => {
                    if (buf && this._map && !this._disposed) {
                        this._setTileDataCache(dataKey, buf.slice(0));
                    }
                    return buf;
                })
                .catch(() => null)
                .finally(() => this._prefetchInFlight.delete(dataKey));

            this._prefetchInFlight.set(dataKey, promise);
        }
    },

    _processQueue(this: any): void {
        if (!this.visible) return;
        if (this._disposed) return;
        if (this._activeLoads >= this._maxConcurrent) return;
        if (this._sortedLoadQueue.length === 0) return;

        const capacity = this._maxConcurrent - this._activeLoads;
        const toLoad = this._sortedLoadQueue.splice(0, capacity);
        for (const key of toLoad) {
            const [z, x, y] = key.split(',').map(Number);
            this._loadTile(z, x, y);
        }

        if (this._sortedLoadQueue.length > 0) {
            clearTimeout(this._queueTimer!);
            this._queueTimer = setTimeout(() => {
                this._queueTimer = null;
                this._processQueue();
            }, this._queueInterval);
        }
    },

    async _loadTile(this: any, z: number, xSlippy: number, ySlippy: number): Promise<void> {
        const key = `${z},${xSlippy},${ySlippy}`;
        if (this._pendingLoads.has(key) || this._tileCache.has(key)) return;

        const map = this._map;
        if (!map) return;
        if (this._disposed) return;

        const requestGeneration = this._generation;
        const requestStyleZoom = this._transitionStyleZoom;
        const requestSourceZoom = this._lastSourceZoom;

        const isCurrent = () =>
            !this._disposed
            && this._isTileRequestCurrent(map, requestGeneration, z, requestStyleZoom)
            && requestSourceZoom === z;

        if (!isCurrent()) return;

        let countedAsActive = false;
        const beginLoad = () => {
            this._pendingLoads.add(key);
            this._pendingLoadGenerations.set(key, requestGeneration);
            this._activeLoads++;
            countedAsActive = true;
        };
        const finishLoad = () => {
            if (countedAsActive) { this._activeLoads--; countedAsActive = false; }
            if (this._pendingLoadGenerations.get(key) === requestGeneration) {
                this._pendingLoads.delete(key);
                this._pendingLoadGenerations.delete(key);
            }
            this._processQueue();
        };

        try {
            const fallback = this._oldTileGroups?.get(key);
            if (fallback
                && fallback.userData.is3d === this._is3dNow()
                && fallback.userData.styleZoom === requestStyleZoom) {
                this._oldTileGroups!.delete(key);
                const adopted = this._adoptTile(key, fallback, fallback.visible, requestGeneration, requestStyleZoom);
                if (!adopted) this._disposeTile(fallback);
                return;
            }

            if (this._groupCache.has(key)) {
                const group = this._groupCache.get(key)!;
                this._groupCache.delete(key);
                const is3dNow = this._is3dNow();
                const compatible = group
                    && group.userData.is3d === is3dNow
                    && group.userData.styleZoom === requestStyleZoom;

                if (compatible) {
                    const adopted = this._adoptTile(key, group, false, requestGeneration, requestStyleZoom);
                    if (!adopted) this._disposeTile(group);
                    return;
                }

                const dataCacheKey = `${z}/${xSlippy}/${ySlippy}`;
                const cached = this._getTileDataCache(dataCacheKey);
                if (cached) {
                    beginLoad();
                    const rebuilt = await this._sendToWorker(
                        cached.slice(0), z, xSlippy, ySlippy, is3dNow, group,
                        requestGeneration, requestStyleZoom,
                    );
                    if (!rebuilt) { this._disposeTile(group); return; }
                    if (!isCurrent()) { this._disposeTile(rebuilt); return; }
                    this._adoptTile(key, rebuilt, false, requestGeneration, requestStyleZoom);
                    return;
                }
                this._disposeTile(group);
            }

            beginLoad();
            const dataCacheKey = `${z}/${xSlippy}/${ySlippy}`;
            let buffer = this._getTileDataCache(dataCacheKey);
            if (buffer) {
                buffer = buffer.slice(0);
            } else {
                const url = this.url!
                    .replaceAll('{z}', String(z))
                    .replaceAll('{x}', String(xSlippy))
                    .replaceAll('{y}', String(ySlippy));
                const prefetchPromise = this._prefetchInFlight.get(dataCacheKey);
                if (prefetchPromise) {
                    buffer = await prefetchPromise ?? undefined;
                    if (buffer) buffer = buffer.slice(0);
                    if (!isCurrent()) return;
                }
                if (!buffer) {
                    const response = await fetch(url);
                    if (!isCurrent()) return;
                    if (!response.ok) throw new Error(`HTTP ${response.status}`);
                    buffer = await response.arrayBuffer();
                    if (!isCurrent()) return;
                    this._setTileDataCache(dataCacheKey, buffer.slice(0));
                }
            }
            if (!buffer || !isCurrent()) return;

            const is3dNow = this._is3dNow();
            const group = await this._sendToWorker(
                buffer, z, xSlippy, ySlippy, is3dNow, null,
                requestGeneration, requestStyleZoom,
            );
            if (!group) return;
            if (!isCurrent()) { this._disposeTile(group); return; }
            this._adoptTile(key, group, false, requestGeneration, requestStyleZoom);
        } catch (err) {
            if (isCurrent()) {
                this._settledKeys.add(key);
                this._coverageDirty = true;
                if (this._debug) console.warn('[VectorTile] Tile load failed:', key, err);
            }
        } finally {
            finishLoad();
        }
    },

_getVisibleTileKeys(this: any, z: number): Set<string> {
    const map = this._map;
    const camera = map.camera;
    const numTiles = 1 << z;
    const maxTile = numTiles - 1;
    const tileSize = map.WORLD_SIZE / numTiles;
    const maxMerc = map.MAX_MERCATOR;
    const off = map.worldGroup.position;
    const ray = this._raycaster;
    const ndc = this._raycastNDC;

    camera.updateMatrixWorld();

    // Всё считаем в локальных координатах worldGroup
    const camX = camera.position.x - off.x;
    const camZ = camera.position.z - off.z;
    const target = map.controls.target;
    const tX = target.x - off.x;
    const tZ = target.z - off.z;
    const camTargetDist = camera.position.distanceTo(target);

    // ── 1. Жёсткий радиус загрузки, привязанный к дистанции камеры ──
    const factor = this.maxTileDistanceFactor ?? 4;
    const maxDist = Math.max(camTargetDist * factor, tileSize * 2);

    // ── 2. Контур видимой области на земле (с подрезкой по maxDist) ──
    const pts: number[] = [camX, camZ];
    const addRay = (nx: number, ny: number) => {
        ndc.set(nx, ny);
        ray.setFromCamera(ndc, camera);
        const o = ray.ray.origin;
        const d = ray.ray.direction;
        let px: number, pz: number;
        if (d.y < -1e-6) {
            const t = -o.y / d.y;
            px = o.x + d.x * t - off.x;
            pz = o.z + d.z * t - off.z;
            const ddx = px - camX, ddz = pz - camZ;
            const dist = Math.hypot(ddx, ddz);
            if (dist > maxDist) {
                const s = maxDist / dist;
                px = camX + ddx * s;
                pz = camZ + ddz * s;
            }
        } else {
            // Луч выше горизонта: ставим точку на границу радиуса
            const hLen = Math.hypot(d.x, d.z);
            if (hLen < 1e-9) return;
            px = camX + (d.x / hLen) * maxDist;
            pz = camZ + (d.z / hLen) * maxDist;
        }
        pts.push(px, pz);
    };

    const steps = 8;
    for (let i = 0; i <= steps; i++) {
        const t = -1 + (2 * i) / steps;
        addRay(t, -1); addRay(t, 1);
        addRay(-1, t); addRay(1, t);
    }

    // ── 3. Выпуклая оболочка (monotone chain, CCW) ──
    const P: Array<[number, number]> = [];
    for (let i = 0; i < pts.length; i += 2) P.push([pts[i], pts[i + 1]]);
    P.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    const cross = (o: number[], a: number[], b: number[]) =>
        (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
    const lower: Array<[number, number]> = [];
    for (const p of P) {
        while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) lower.pop();
        lower.push(p);
    }
    const upper: Array<[number, number]> = [];
    for (let i = P.length - 1; i >= 0; i--) {
        const p = P[i];
        while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) upper.pop();
        upper.push(p);
    }
    upper.pop(); lower.pop();
    const hull = lower.concat(upper);

    let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
    for (const [x, zz] of hull) {
        if (x < minX) minX = x; if (x > maxX) maxX = x;
        if (zz < minZ) minZ = zz; if (zz > maxZ) maxZ = zz;
    }

    // Расстояние от точки до выпуклого полигона (0, если внутри)
    const distToHull = (x: number, zz: number): number => {
        const n = hull.length;
        if (n < 3) return Math.hypot(x - tX, zz - tZ);
        let inside = true;
        let best = Infinity;
        for (let i = 0; i < n; i++) {
            const a = hull[i], b = hull[(i + 1) % n];
            const ex = b[0] - a[0], ez = b[1] - a[1];
            if (ex * (zz - a[1]) - ez * (x - a[0]) < 0) inside = false;
            const len2 = ex * ex + ez * ez || 1e-12;
            let t = ((x - a[0]) * ex + (zz - a[1]) * ez) / len2;
            t = t < 0 ? 0 : t > 1 ? 1 : t;
            const qx = a[0] + ex * t - x, qz = a[1] + ez * t - zz;
            const d = qx * qx + qz * qz;
            if (d < best) best = d;
        }
        return inside ? 0 : Math.sqrt(best);
    };

    // ── 4. Перебор тайлов в bbox оболочки + точная проверка ──
    const margin = tileSize * 0.5;
    const reach = tileSize * Math.SQRT1_2 + margin;

    let xMin = Math.floor((minX - margin + maxMerc) / tileSize);
    let xMax = Math.floor((maxX + margin + maxMerc) / tileSize);
    if (xMax - xMin + 1 > numTiles) xMax = xMin + numTiles - 1;
    const yMin = Math.max(0, Math.floor((minZ - margin + maxMerc) / tileSize));
    const yMax = Math.min(maxTile, Math.floor((maxZ + margin + maxMerc) / tileSize));

    const found = new Map<string, number>();
    for (let y = yMin; y <= yMax; y++) {
        const cz = -maxMerc + (y + 0.5) * tileSize;
        for (let x = xMin; x <= xMax; x++) {
            const cx = -maxMerc + (x + 0.5) * tileSize;
            if (distToHull(cx, cz) > reach) continue;
            const wx = ((x % numTiles) + numTiles) % numTiles;
            const key = `${z},${wx},${y}`;
            const d = (cx - tX) * (cx - tX) + (cz - tZ) * (cz - tZ);
            const prev = found.get(key);
            if (prev === undefined || d < prev) found.set(key, d);
        }
    }

    // ── 5. Жёсткий лимит количества: ближайшие к центру экрана ──
    const limit = this.maxVisibleTiles ?? 96;
    const sorted = Array.from(found.entries()).sort((a, b) => a[1] - b[1]);
    if (sorted.length > limit) sorted.length = limit;

    return new Set(sorted.map(([k]) => k));
},

    _setTileDataCache(this: any, key: string, buffer: ArrayBuffer): void {
        const existing = this._tileDataCache.get(key);
        let bytes = this._tileDataCacheBytes ?? 0;
        if (existing) {
            bytes -= existing.byteLength;
            this._tileDataCache.delete(key);
        }
        this._tileDataCache.set(key, buffer);
        bytes += buffer.byteLength;

        const maxSize = this._tileDataCacheMaxSize ?? 200;
        const maxBytes = this._tileDataCacheMaxBytes ?? 100 * 1024 * 1024;
        while (
            (this._tileDataCache.size > maxSize || bytes > maxBytes)
            && this._tileDataCache.size > 1
        ) {
            const oldestKey = this._tileDataCache.keys().next().value as string;
            const removed = this._tileDataCache.get(oldestKey);
            if (removed) bytes -= removed.byteLength;
            this._tileDataCache.delete(oldestKey);
        }
        this._tileDataCacheBytes = bytes;
    },

    _getTileDataCache(this: any, key: string): ArrayBuffer | undefined {
        const value = this._tileDataCache.get(key);
        if (value === undefined) return undefined;
        this._tileDataCache.delete(key);
        this._tileDataCache.set(key, value);
        return value;
    },

    _clearAllTiles(this: any): void {
        this._map?.textManager?.pruneStaleLabels(new Set(), this);
        this._generation++;
        this._tileCache.forEach((g: THREE.Group) => this._disposeTile(g));
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
    },

    _clearGroupCache(this: any): void {
        this._groupCache.forEach((g: THREE.Group) => this._disposeTile(g));
        this._groupCache.clear();
    },

    _clearOldTilesNow(this: any): void {
        if (this._oldTileGroups) {
            this._oldTileGroups.forEach((g: THREE.Group) => this._disposeTile(g));
            this._oldTileGroups = null;
        }
        this._retiredOldKeys.clear();
    },

    _disposeTile(this: any, group: THREE.Group | null | undefined): void {
        if (!group) return;
        this._removeTextLabelsForGroup(group);
        group.traverse((child: any) => {
            if (child === group) return;
            if (child.geometry && !this._managedGeometries.has(child.geometry)) child.geometry.dispose();
            if (child.material) {
                const mats = Array.isArray(child.material) ? child.material : [child.material];
                for (const m of mats) {
                    if (m && !this._managedMaterials.has(m)) m.dispose?.();
                }
            }
        });
        // O(1) вместо while(remove(children[0])) — та была O(n) с memmove
        // массива на каждой итерации (заметно при массовом диспоузе).
        if (typeof (group as any).clear === 'function') {
            (group as any).clear();
        } else {
            while (group.children.length) group.remove(group.children[0]);
        }
        this._rootGroup.remove(group);
    },

    _invalidateAllTiles(this: any): void {
        this._clearAllTiles();
        this._clearGroupCache();
        this._tileDataCache.clear();
        this._tileDataCacheBytes = 0;
        this._prefetchInFlight.clear();
        this._lastSourceZoom = -1;
        this._lastDiscreteZoom = -1;
        this._transitionStyleZoom = NaN;
        this._lastIs3d = undefined;
        this._lastPrefetchZoom = -1;
        this._labelsDirty = true;
        this._lastCheckInit = false;
    },
};