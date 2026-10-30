// VectorTileLifecycle.ts
import { THREE } from './js_TP/tpb.js';
import { Projections } from './Projections.js';

export const VectorTileLifecycleMixin = {
    setVisible(this: any, visible: boolean): void {
        const v = !!visible;
        if (this.visible === v) return;
        this.visible = v;
        if (this._rootGroup) this._rootGroup.visible = v;

        this._lastCheckInit = false;
        this._lastDiscreteZoom = -1;
        this._labelsDirty = true;

        if (!v) {
            this._map?.textManager?.pruneStaleLabels(new Set(), this);
            this._sortedLoadQueue = [];
            if (this._queueTimer) { clearTimeout(this._queueTimer); this._queueTimer = null; }

            if (this._map?.textManager) {
                this._tileCache.forEach((g: THREE.Group) => this._removeTextLabelsForGroup(g));
                this._oldTileGroups?.forEach((g: THREE.Group) => this._removeTextLabelsForGroup(g));
            }
        }
    },

    _applyRenderOrder(this: any, baseOrder: number): void {
        if (this._tileGroupRenderOrder === baseOrder) return;
        this._tileGroupRenderOrder = baseOrder;
        if (this._rootGroup) this._rootGroup.renderOrder = baseOrder;
        this._tileCache.forEach((g: THREE.Group) => { g.renderOrder = baseOrder; });
        this._oldTileGroups?.forEach((g: THREE.Group) => { g.renderOrder = baseOrder; });
        this._groupCache.forEach((g: THREE.Group) => { g.renderOrder = baseOrder; });
    },

    _mergeStyles(this: any, base: Record<string, any>, overrides: Record<string, any>): Record<string, any> {
        const merged = JSON.parse(JSON.stringify(base));
        for (const [key, val] of Object.entries(overrides)) {
            if (val && typeof val === 'object' && !Array.isArray(val) && merged[key]) {
                merged[key] = this._mergeStyles(merged[key], val as Record<string, any>);
            } else {
                merged[key] = val;
            }
        }
        return merged;
    },

    addTo(this: any, map: any): any {
        if (this._map) this.removeFromMap();
        this._map = map;
        this._crs = this._crsCode ? Projections.get(this._crsCode) : map.inputCRS;

        if (typeof map._getDynamicLayerRenderOrder === 'function') {
            this._tileGroupRenderOrder = map._getDynamicLayerRenderOrder(this);
        }
        this._rootGroup.renderOrder = this._tileGroupRenderOrder;
        this._rootGroup.visible = this.visible;
        map.worldGroup.add(this._rootGroup);

        if (!map._dynamicLayers.includes(this)) map._dynamicLayers.push(this);
        if (map.textManager && map.textManager.setMaxLabels) map.textManager.setMaxLabels(this.maxTextLabels);

        this._labelsDirty = true;
        this._lastCheckInit = false;
        return this;
    },

    removeFromMap(this: any): void {
        if (!this._map) return;
        if (this._queueTimer) { clearTimeout(this._queueTimer); this._queueTimer = null; }

        for (const pending of this._pendingWorkerRequests.values()) {
            try { pending.reject(new Error('Layer removed')); } catch { /* noop */ }
        }
        this._pendingWorkerRequests.clear();
        this._clearAllTiles();
        this._rootGroup.parent?.remove(this._rootGroup);

        const index = this._map._dynamicLayers.indexOf(this);
        if (index > -1) this._map._dynamicLayers.splice(index, 1);

        this._map = null;
        this._crs = null;

        this._fillMaterialCache.forEach((m: THREE.Material) => m.dispose());
        this._lineMaterialCache.forEach((m: THREE.Material) => m.dispose());
        this._lineMaterialsSet.clear();
        this._fillMaterialCache.clear();
        this._lineMaterialCache.clear();
        this._pointGeometryCache.forEach((g: THREE.BufferGeometry) => g.dispose());
        this._pointGeometryCache.clear();

        this._tileDataCache.clear();
        this._prefetchInFlight.clear();
        this._lastPrefetchZoom = -1;
        this._clearGroupCache();

        if (this._worker) { this._worker.terminate(); this._worker = null; }

        this._lastCheckInit = false;
        this._transitionStyleZoom = NaN;
    },

    addExclusionArea(this: any, collection: any, layers: string[]): any {
        if (!this._map) {
            throw new Error('VectorTile.addExclusionArea: слой должен быть добавлен на карту (addTo) до вызова addExclusionArea');
        }

        const geometries: any[] = [];
        if (collection.type === 'FeatureCollection') {
            for (const f of collection.features) geometries.push(f.geometry);
        } else if (collection.type === 'Feature') {
            geometries.push(collection.geometry);
        } else if (collection.type) {
            geometries.push(collection);
        } else {
            throw new Error('addExclusionArea: invalid GeoJSON object');
        }

        const crs = this._crsCode ? Projections.get(this._crsCode) : this._map.inputCRS;
        const worldPolygons: Array<Array<{ x: number; z: number }>> = [];

        for (const geom of geometries) {
            if (!geom) continue;
            let rings: number[][][] = [];
            if (geom.type === 'Polygon') rings = [geom.coordinates[0]];
            else if (geom.type === 'MultiPolygon') rings = geom.coordinates.map((p: any) => p[0]);
            else { console.warn('addExclusionArea: unsupported geometry type', geom.type); continue; }

            for (const ring of rings) {
                worldPolygons.push(ring.map((pt) => {
                    const [x, z] = this._map.project(pt, crs);
                    return { x, z };
                }));
            }
        }

        this._exclusionAreas = worldPolygons;
        this._exclusionLayers = new Set(layers);
        this._invalidateAllTiles();
        return this;
    },

    _postUpdate(this: any, map: any): void {
        if (!this._map) return;

        if (!this.visible) {
            if (this._rootGroup.visible) {
                this._rootGroup.visible = false;
                if (this._map.textManager) {
                    this._tileCache.forEach((g: THREE.Group) => this._removeTextLabelsForGroup(g));
                    this._oldTileGroups?.forEach((g: THREE.Group) => this._removeTextLabelsForGroup(g));
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

        this._updateDynamicLineMaterials(map.continuousZoom + this.zoomOffset);

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

        if (this._coverageDirty) this._resolveCoverage();

        const labelNow = performance.now();
        const timeSinceLastMove = labelNow - this._lastMovementTime;
        const isMoving = timeSinceLastMove < 1000;
        const periodicUpdateDue = isMoving && labelNow - this._lastLabelUpdateTime > 1000;
        const settleUpdateDue = timeSinceLastMove > 300 && this._lastLabelUpdateTime < this._lastMovementTime;

        if ((this._labelsDirty || settleUpdateDue || periodicUpdateDue)
            && (this._tileCache.size > 0 || this._oldTileGroups)) {
            this._labelsDirty = false;
            this._lastLabelUpdateTime = labelNow;
            this._refreshTextLabelsForVisibleTiles();
        }

        const now = performance.now();
        if (now - this._lastUpdateTime < this._throttle) { this._processQueue(); return; }
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

        if (discreteZoom !== this._lastDiscreteZoom) this._labelsDirty = true;
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
            this._lineMaterialsSet.forEach((mat: any) => mat.resolution.copy(this._canvasSizeVec));
        }

        const visibleTiles = this._getVisibleTileKeys(sourceZoom);
        this._requiredKeys = visibleTiles;
        this._coverageDirty = true;

        for (const key of Array.from(this._tileCache.keys()) as string[]) {
            if (!visibleTiles.has(key)) {
                const group = this._tileCache.get(key)!;
                this._stashGroup(key, group);
                this._tileCache.delete(key);
                if (this._pendingLoadGenerations.get(key) === this._generation) {
                    this._pendingLoads.delete(key);
                    this._pendingLoadGenerations.delete(key);
                }
                this._labelsDirty = true;
            }
        }

        const maxMerc = map.MAX_MERCATOR;
        const target = map.controls.target;
        const tileSizeAtZoom = map.WORLD_SIZE / (1 << sourceZoom);
        const targetX = target.x, targetZ = target.z;
        const unsortedNewKeys: Array<{ key: string; distSq: number }> = [];

        visibleTiles.forEach((key: string) => {
            if (this._tileCache.has(key) || this._pendingLoads.has(key)) return;
            const c1 = key.indexOf(',');
            const c2 = key.indexOf(',', c1 + 1);
            const x = +key.slice(c1 + 1, c2);
            const y = +key.slice(c2 + 1);
            const centerX = x * tileSizeAtZoom - maxMerc + tileSizeAtZoom / 2;
            const centerZ = -maxMerc + y * tileSizeAtZoom + tileSizeAtZoom / 2;
            const dx = centerX - targetX;
            const dz = centerZ - targetZ;
            unsortedNewKeys.push({ key, distSq: dx * dx + dz * dz });
        });

        unsortedNewKeys.sort((a, b) => a.distSq - b.distSq);
        const newKeys = unsortedNewKeys.map((it) => it.key);
        this._sortedLoadQueue = newKeys.concat(
            this._sortedLoadQueue.filter((key: string) =>
                !this._tileCache.has(key) && !this._pendingLoads.has(key) && visibleTiles.has(key)
            )
        );

        this._processQueue();
    },
};