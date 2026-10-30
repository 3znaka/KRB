export const VectorTileLoadingMixin = {
    _prefetchNextZoom(z) {
        const map = this._map;
        if (!map)
            return;
        if (z < this.minNativeZoom || z > this.maxNativeZoom)
            return;
        for (const key of this._getVisibleTileKeys(z)) {
            const c1 = key.indexOf(',');
            const c2 = key.indexOf(',', c1 + 1);
            const pz = +key.slice(0, c1);
            const px = +key.slice(c1 + 1, c2);
            const py = +key.slice(c2 + 1);
            const dataKey = `${pz}/${px}/${py}`;
            if (this._tileDataCache.has(dataKey))
                continue;
            if (this._prefetchInFlight.has(dataKey))
                continue;
            const url = this.url.replaceAll('{z}', String(pz)).replaceAll('{x}', String(px)).replaceAll('{y}', String(py));
            const promise = fetch(url)
                .then((r) => r.ok ? r.arrayBuffer() : null)
                .then((buf) => {
                if (buf && this._map)
                    this._setTileDataCache(dataKey, buf.slice(0));
                return buf;
            })
                .catch(() => null)
                .finally(() => this._prefetchInFlight.delete(dataKey));
            this._prefetchInFlight.set(dataKey, promise);
        }
    },
    _processQueue() {
        if (!this.visible)
            return;
        if (this._activeLoads >= this._maxConcurrent)
            return;
        if (this._sortedLoadQueue.length === 0)
            return;
        const capacity = this._maxConcurrent - this._activeLoads;
        const toLoad = this._sortedLoadQueue.splice(0, capacity);
        for (const key of toLoad) {
            const [z, x, y] = key.split(',').map(Number);
            this._loadTile(z, x, y);
        }
        if (this._sortedLoadQueue.length > 0) {
            clearTimeout(this._queueTimer);
            this._queueTimer = setTimeout(() => {
                this._queueTimer = null;
                this._processQueue();
            }, this._queueInterval);
        }
    },
    async _loadTile(z, xSlippy, ySlippy) {
        const key = `${z},${xSlippy},${ySlippy}`;
        if (this._pendingLoads.has(key) || this._tileCache.has(key))
            return;
        const map = this._map;
        if (!map)
            return;
        const requestGeneration = this._generation;
        const requestStyleZoom = this._transitionStyleZoom;
        const requestSourceZoom = this._lastSourceZoom;
        const isCurrent = () => this._isTileRequestCurrent(map, requestGeneration, z, requestStyleZoom)
            && requestSourceZoom === z;
        if (!isCurrent())
            return;
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
                this._oldTileGroups.delete(key);
                const adopted = this._adoptTile(key, fallback, fallback.visible, requestGeneration, requestStyleZoom);
                if (!adopted)
                    this._disposeTile(fallback);
                return;
            }
            if (this._groupCache.has(key)) {
                const group = this._groupCache.get(key);
                this._groupCache.delete(key);
                const is3dNow = this._is3dNow();
                const compatible = group
                    && group.userData.is3d === is3dNow
                    && group.userData.styleZoom === requestStyleZoom;
                if (compatible) {
                    const adopted = this._adoptTile(key, group, false, requestGeneration, requestStyleZoom);
                    if (!adopted)
                        this._disposeTile(group);
                    return;
                }
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
            beginLoad();
            const dataCacheKey = `${z}/${xSlippy}/${ySlippy}`;
            let buffer = this._getTileDataCache(dataCacheKey);
            if (buffer) {
                buffer = buffer.slice(0);
            }
            else {
                const url = this.url
                    .replaceAll('{z}', String(z))
                    .replaceAll('{x}', String(xSlippy))
                    .replaceAll('{y}', String(ySlippy));
                const prefetchPromise = this._prefetchInFlight.get(dataCacheKey);
                if (prefetchPromise) {
                    buffer = await prefetchPromise ?? undefined;
                    if (buffer)
                        buffer = buffer.slice(0);
                    if (!isCurrent())
                        return;
                }
                if (!buffer) {
                    const response = await fetch(url);
                    if (!isCurrent())
                        return;
                    if (!response.ok)
                        throw new Error(`HTTP ${response.status}`);
                    buffer = await response.arrayBuffer();
                    if (!isCurrent())
                        return;
                    this._setTileDataCache(dataCacheKey, buffer.slice(0));
                }
            }
            if (!buffer || !isCurrent())
                return;
            const is3dNow = this._is3dNow();
            const group = await this._sendToWorker(buffer, z, xSlippy, ySlippy, is3dNow, null, requestGeneration, requestStyleZoom);
            if (!group)
                return;
            if (!isCurrent()) {
                this._disposeTile(group);
                return;
            }
            this._adoptTile(key, group, false, requestGeneration, requestStyleZoom);
        }
        catch (err) {
            if (isCurrent()) {
                this._settledKeys.add(key);
                this._coverageDirty = true;
                if (this._debug)
                    console.warn('[VectorTile] Tile load failed:', key, err);
            }
        }
        finally {
            finishLoad();
        }
    },
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
        let minX = camXLocal, maxX = camXLocal, minZ = camZLocal, maxZ = camZLocal;
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
                if (Math.abs(ray.ray.direction.y) < minRayY)
                    continue;
                if (!ray.ray.intersectPlane(plane, hit))
                    continue;
                const dxCam = hit.x - camera.position.x;
                const dzCam = hit.z - camera.position.z;
                if (dxCam * dxCam + dzCam * dzCam > maxLoadDistSq)
                    continue;
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
            const vFov = camera.fov * Math.PI / 180;
            const aspect = camera.aspect;
            const hh = distance * Math.tan(vFov / 2) * aspect * 2 + 2 * tileSize;
            const hv = distance * Math.tan(vFov / 2) * 2 + 2 * tileSize;
            const tX = target.x - off.x;
            const tZ = target.z - off.z;
            if (tX - hh < minX)
                minX = tX - hh;
            if (tX + hh > maxX)
                maxX = tX + hh;
            if (tZ - hv < minZ)
                minZ = tZ - hv;
            if (tZ + hv > maxZ)
                maxZ = tZ + hv;
        }
        const margin = tileSize * 1.5;
        minX -= margin;
        maxX += margin;
        minZ -= margin;
        maxZ += margin;
        const xMin = Math.floor((minX + map.MAX_MERCATOR) / tileSize);
        const xMax = Math.floor((maxX + map.MAX_MERCATOR) / tileSize);
        const yMin = Math.max(0, Math.floor((minZ + map.MAX_MERCATOR) / tileSize));
        const yMax = Math.min(maxTile, Math.floor((maxZ + map.MAX_MERCATOR) / tileSize));
        const keys = new Set();
        for (let y = yMin; y <= yMax; y++) {
            for (let x = xMin; x <= xMax; x++) {
                const wrappedX = ((x % numTiles) + numTiles) % numTiles;
                keys.add(`${z},${wrappedX},${y}`);
            }
        }
        return keys;
    },
    _setTileDataCache(key, buffer) {
        this._tileDataCache.delete(key);
        this._tileDataCache.set(key, buffer);
        while (this._tileDataCache.size > this._tileDataCacheMaxSize) {
            const oldestKey = this._tileDataCache.keys().next().value;
            this._tileDataCache.delete(oldestKey);
        }
    },
    _getTileDataCache(key) {
        const value = this._tileDataCache.get(key);
        if (value === undefined)
            return undefined;
        this._tileDataCache.delete(key);
        this._tileDataCache.set(key, value);
        return value;
    },
    _clearAllTiles() {
        this._map?.textManager?.pruneStaleLabels(new Set(), this);
        this._generation++;
        this._tileCache.forEach((g) => this._disposeTile(g));
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
    _clearGroupCache() {
        this._groupCache.forEach((g) => this._disposeTile(g));
        this._groupCache.clear();
    },
    _clearOldTilesNow() {
        if (this._oldTileGroups) {
            this._oldTileGroups.forEach((g) => this._disposeTile(g));
            this._oldTileGroups = null;
        }
        this._retiredOldKeys.clear();
    },
    _disposeTile(group) {
        if (!group)
            return;
        this._removeTextLabelsForGroup(group);
        group.traverse((child) => {
            if (child === group)
                return;
            if (child.geometry && !this._managedGeometries.has(child.geometry))
                child.geometry.dispose();
            if (child.material && !this._managedMaterials.has(child.material))
                child.material.dispose?.();
        });
        while (group.children.length)
            group.remove(group.children[0]);
        this._rootGroup.remove(group);
    },
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
    },
};
