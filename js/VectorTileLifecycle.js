import { Projections } from './Projections.js';
export const VectorTileLifecycleMixin = {
    setVisible(visible) {
        const v = !!visible;
        if (this.visible === v)
            return;
        this.visible = v;
        if (this._rootGroup)
            this._rootGroup.visible = v;
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
                this._tileCache.forEach((g) => this._removeTextLabelsForGroup(g));
                this._oldTileGroups?.forEach((g) => this._removeTextLabelsForGroup(g));
            }
        }
    },
    _applyRenderOrder(baseOrder) {
        if (this._tileGroupRenderOrder === baseOrder)
            return;
        this._tileGroupRenderOrder = baseOrder;
        if (this._rootGroup)
            this._rootGroup.renderOrder = baseOrder;
        this._tileCache.forEach((g) => { g.renderOrder = baseOrder; });
        this._oldTileGroups?.forEach((g) => { g.renderOrder = baseOrder; });
        this._groupCache.forEach((g) => { g.renderOrder = baseOrder; });
    },
    _mergeStyles(base, overrides) {
        const out = structuredClone(base);
        for (const key of Object.keys(overrides)) {
            const v = overrides[key];
            if (v && typeof v === 'object' && !Array.isArray(v) && out[key] && typeof out[key] === 'object') {
                out[key] = this._mergeStyles(out[key], v);
            }
            else {
                out[key] = v;
            }
        }
        return out;
    },
    addTo(map) {
        if (this._map)
            this.removeFromMap();
        this._map = map;
        this._exclusionCrs = this._crsCode
            ? Projections.getRaw(this._crsCode) // ← пользовательский GeoJSON
            : map.inputCRS; //   (inputCRS уже raw, см. Core.js)
        this._tileCrs = this._crsCode
            ? Projections.getWorld(this._crsCode) // ← сетка тайлов z/x/y
            : (map.tileCRS?.isMercator ? map.tileCRS : Projections.getWorld('EPSG:3857'));
        if (this._isDeformed && this._debug) {
            console.info(`VectorTile: тайлы деформируются из ${this._tileCrs.code} в ${map.projection.code}`);
        }
        if (typeof map._getDynamicLayerRenderOrder === 'function') {
            this._tileGroupRenderOrder = map._getDynamicLayerRenderOrder(this);
        }
        this._rootGroup.renderOrder = this._tileGroupRenderOrder;
        this._rootGroup.visible = this.visible;
        map.worldGroup.add(this._rootGroup);
        const alreadyInLayers = Array.isArray(map.layers) && map.layers.includes(this);
        if (!alreadyInLayers && !map._dynamicLayers.includes(this)) {
            map._dynamicLayers.push(this);
        }
        if (map.textManager && map.textManager.setMaxLabels) {
            map.textManager.setMaxLabels(this.maxTextLabels);
        }
        if (!this._worker) {
            this._workerReady = this._initWorker();
        }
        this._labelsDirty = true;
        this._lastCheckInit = false;
        this._disposed = false;
        return this;
    },
    removeFromMap() {
        if (!this._map)
            return;
        if (this._queueTimer) {
            clearTimeout(this._queueTimer);
            this._queueTimer = null;
        }
        this._workerInitToken = (this._workerInitToken || 0) + 1;
        for (const pending of this._pendingWorkerRequests.values()) {
            try {
                pending.reject(new Error('Layer removed'));
            }
            catch { /* noop */ }
        }
        this._pendingWorkerRequests.clear();
        this._clearAllTiles();
        this._rootGroup.parent?.remove(this._rootGroup);
        if (Array.isArray(this._map.layers)) {
            const li = this._map.layers.indexOf(this);
            if (li > -1)
                this._map.layers.splice(li, 1);
        }
        const index = this._map._dynamicLayers.indexOf(this);
        if (index > -1)
            this._map._dynamicLayers.splice(index, 1);
        this._map = null;
        this._tileCrs = null;
        this._exclusionCrs = null;
        this._fillMaterialCache.forEach((m) => m.dispose());
        this._lineMaterialCache.forEach((m) => m.dispose());
        this._lineMaterialsSet.clear();
        this._fillMaterialCache.clear();
        this._dynamicLineMaterialsSet.clear();
        this._lineMaterialCache.clear();
        this._pointGeometryCache.forEach((g) => g.dispose());
        this._pointGeometryCache.clear();
        this._tileDataCache.clear();
        this._tileDataCacheBytes = 0;
        this._prefetchInFlight.clear();
        this._lastPrefetchZoom = -1;
        this._clearGroupCache();
        if (this._worker) {
            this._worker.terminate();
            this._worker = null;
        }
        this._lastCheckInit = false;
        this._transitionStyleZoom = NaN;
        this._lastLabelState = undefined;
        this._disposed = true;
    },
    addExclusionArea(collection, layers) {
        if (!this._map) {
            throw new Error('VectorTile.addExclusionArea: слой должен быть добавлен на карту (addTo) до вызова addExclusionArea');
        }
        const geometries = [];
        if (collection.type === 'FeatureCollection') {
            for (const f of collection.features)
                geometries.push(f.geometry);
        }
        else if (collection.type === 'Feature') {
            geometries.push(collection.geometry);
        }
        else if (collection.type) {
            geometries.push(collection);
        }
        else {
            throw new Error('addExclusionArea: invalid GeoJSON object');
        }
        const crs = this._exclusionCrs;
        const deformed = this._isDeformed;
        const worldPolygons = [];
        for (const geom of geometries) {
            if (!geom)
                continue;
            let rings = [];
            if (geom.type === 'Polygon')
                rings = [geom.coordinates[0]];
            else if (geom.type === 'MultiPolygon')
                rings = geom.coordinates.map((p) => p[0]);
            else {
                console.warn('addExclusionArea: unsupported geometry type', geom.type);
                continue;
            }
            for (const ring of rings) {
                // Проекция в map-world, затем (при деформации) в tile-CRS —
                // воркер ожидает exclusion-полигоны именно в tile-CRS.
                const projected = ring.map((pt) => {
                    const [mx, mz] = this._map.project(pt, crs);
                    if (!deformed)
                        return { x: mx, z: mz };
                    return this._mapToTile(mx, mz);
                });
                let ok = projected.length >= 3;
                for (const p of projected) {
                    if (!p || !Number.isFinite(p.x) || !Number.isFinite(p.z)) {
                        ok = false;
                        break;
                    }
                }
                if (ok)
                    worldPolygons.push(projected);
            }
        }
        this._exclusionAreas = worldPolygons;
        this._exclusionLayers = new Set(layers);
        this._exclusionLayersArray = layers.slice();
        this._invalidateAllTiles();
        return this;
    },
    _postUpdate(map) {
        if (!this._map)
            return;
        if (!this.visible) {
            if (this._rootGroup.visible) {
                this._rootGroup.visible = false;
                if (this._map.textManager) {
                    this._tileCache.forEach((g) => this._removeTextLabelsForGroup(g));
                    this._oldTileGroups?.forEach((g) => this._removeTextLabelsForGroup(g));
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
        const worldPos = map.worldGroup.position;
        const worldMoved = this._lastWorldPos.distanceToSquared(worldPos) > 1;
        if (worldMoved) {
            this._lastWorldPos.copy(worldPos);
            this._lastMovementTime = performance.now();
        }
        if (this._lineMaterialsSet.size > 0) {
            this._updateDynamicLineMaterials(map.continuousZoom + this.zoomOffset, map.currentDiscreteZoom + this.zoomOffset);
        }
        const discreteZoom = map.currentDiscreteZoom;
        const inRange = discreteZoom >= this.minZoom && discreteZoom <= this.maxZoom;
        const currentStyleZoom = this._getCurrentTileStyleZoom(map);
        if (inRange) {
            const is3d = this._is3dNow();
            const sourceZoom = this._pickSourceZoom(map);
            const sourceZoomChanged = sourceZoom !== this._lastSourceZoom;
            const modeChanged = is3d !== this._lastIs3d;
            const styleZoomChanged = currentStyleZoom !== this._transitionStyleZoom;
            if (sourceZoomChanged || modeChanged || styleZoomChanged) {
                this._lastIs3d = is3d;
                this._beginTransition(sourceZoom, currentStyleZoom);
                this._lastUpdateTime = 0;
            }
        }
        if (this._coverageDirty)
            this._resolveCoverage();
        const labelNow = performance.now();
        const timeSinceLastMove = labelNow - this._lastMovementTime;
        const isMoving = timeSinceLastMove < 1000;
        const zoomNow = map.continuousZoom + this.zoomOffset;
        const lastRefreshZoom = this._lastLabelRefreshZoom ?? -Infinity;
        const zoomChangedForLabels = Math.abs(zoomNow - lastRefreshZoom) > 0.1;
        const periodicUpdateDue = isMoving && zoomChangedForLabels
            && labelNow - this._lastLabelUpdateTime > 1000;
        const settleUpdateDue = timeSinceLastMove > 300
            && this._lastLabelUpdateTime < this._lastMovementTime;
        if ((this._labelsDirty || settleUpdateDue || periodicUpdateDue)
            && (this._tileCache.size > 0 || this._oldTileGroups)) {
            const force = !!this._labelsDirty;
            // Не форсим чаще ~8 Гц — обычный refresh и так идёт с settle-задержкой.
            if (force && labelNow - (this._lastForceRefreshTime ?? 0) < 120) {
                // оставляем dirty — отработаем позже
            }
            else {
                this._labelsDirty = false;
                this._lastForceRefreshTime = labelNow;
                this._lastLabelUpdateTime = labelNow;
                this._lastLabelRefreshZoom = zoomNow;
                this._refreshTextLabelsForVisibleTiles(force);
            }
        }
        const now = performance.now();
        if (now - this._lastUpdateTime < this._throttle) {
            this._processQueue();
            return;
        }
        this._lastUpdateTime = now;
        const camPos = map.camera.position;
        const camChanged = !this._lastCheckInit
            || this._lastCheckCamPos.distanceToSquared(camPos) > 0.01
            || worldMoved
            || this._lastCheckZoom !== discreteZoom;
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
            this._transitionStyleZoom = NaN;
            this._lastIs3d = undefined;
            return;
        }
        if (discreteZoom !== this._lastDiscreteZoom)
            this._labelsDirty = true;
        this._lastDiscreteZoom = discreteZoom;
        const sourceZoom = this._lastSourceZoom;
        const nextSourceZoom = Math.min(sourceZoom + 1, this.maxNativeZoom);
        if (nextSourceZoom > sourceZoom
            && map.continuousZoom > discreteZoom + 0.3
            && this._lastPrefetchZoom !== sourceZoom) {
            this._lastPrefetchZoom = sourceZoom;
            this._prefetchNextZoom(nextSourceZoom);
        }
        const canvas = map.renderer.domElement;
        const w = canvas.clientWidth, h = canvas.clientHeight;
        if (this._lineMaterialsSet.size > 0
            && (this._lastCanvasSize.width !== w || this._lastCanvasSize.height !== h)) {
            this._lastCanvasSize.width = w;
            this._lastCanvasSize.height = h;
            this._canvasSizeVec.set(w, h);
            this._lineMaterialsSet.forEach((mat) => mat.resolution.copy(this._canvasSizeVec));
        }
        const visibleTiles = this._getVisibleTileKeys(sourceZoom);
        this._requiredKeys = visibleTiles;
        this._coverageDirty = true;
        for (const key of Array.from(this._tileCache.keys())) {
            if (!visibleTiles.has(key)) {
                const group = this._tileCache.get(key);
                this._stashGroup(key, group);
                this._tileCache.delete(key);
                if (this._pendingLoadGenerations.get(key) === this._generation) {
                    this._pendingLoads.delete(key);
                    this._pendingLoadGenerations.delete(key);
                }
                this._labelsDirty = true;
            }
        }
        const tileHalfX = this._tileCrs.halfExtentX;
        const tileHalfY = this._tileCrs.halfExtentY;
        const tileSizeAtZoomX = (2 * tileHalfX) / (1 << sourceZoom);
        const tileSizeAtZoomY = (2 * tileHalfY) / (1 << sourceZoom);
        const target = map.controls.target;
        let targetX, targetZ;
        if (this._isDeformed) {
            const t = this._mapToTile(target.x - map.worldGroup.position.x, target.z - map.worldGroup.position.z);
            targetX = t ? t.x : 0;
            targetZ = t ? t.z : 0;
        }
        else {
            targetX = target.x;
            targetZ = target.z;
        }
        const unsortedNewKeys = [];
        visibleTiles.forEach((key) => {
            if (this._tileCache.has(key) || this._pendingLoads.has(key))
                return;
            const c1 = key.indexOf(',');
            const c2 = key.indexOf(',', c1 + 1);
            const x = +key.slice(c1 + 1, c2);
            const y = +key.slice(c2 + 1);
            const centerX = x * tileSizeAtZoomX - tileHalfX + tileSizeAtZoomX / 2;
            const centerZ = -tileHalfY + y * tileSizeAtZoomY + tileSizeAtZoomY / 2;
            const dx = centerX - targetX;
            const dz = centerZ - targetZ;
            unsortedNewKeys.push({ key, distSq: dx * dx + dz * dz });
        });
        unsortedNewKeys.sort((a, b) => a.distSq - b.distSq);
        const newKeys = unsortedNewKeys.map(it => it.key);
        const newKeySet = new Set(newKeys);
        const oldKeys = this._sortedLoadQueue.filter(key => !newKeySet.has(key) && // ← дедуп
            !this._tileCache.has(key) &&
            !this._pendingLoads.has(key) &&
            !this._settledKeys.has(key) &&
            visibleTiles.has(key));
        this._sortedLoadQueue = newKeys.concat(oldKeys);
        this._processQueue();
    },
};
