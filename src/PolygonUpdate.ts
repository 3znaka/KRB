/**
 * PolygonUpdate.ts — per-frame update (видимость, высоты, обводка, экранный
 * centroid), depth-флаги, bounds / visual center / screen bbox.
 */
import { THREE } from './js_TP/tpb.js';
import { Projections } from './Projections.js';
import { DEFAULT_FILL_PATTERN_SCALE, approxVisualCenter, type LonLat } from './PolygonUtils.js';
import type { Polygon } from './Polygon.js';

export interface PolygonUpdate {
    _update(_mapArg?: any): void;
    _updateHeights(): boolean;
    _updateStroke(): void;
    _updateCentroidScreenPos(): void;
    getCenter(): LonLat | null;
    getBounds(crs?: string | any): [LonLat, LonLat] | null;
    _computeBounds(crs: string | any): [LonLat, LonLat] | null;
    getVisualCenter(): LonLat | null;
    getScreenBBox(): { minX: number; minY: number; maxX: number; maxY: number; width: number; height: number } | null;
    setTooltipOnHover(on: boolean): this;
    getTooltipOnHover(): boolean;
}

export const PolygonUpdateMixin = {
    _update(this: Polygon, _mapArg?: any): void {
        const map = (this as any)._map;
        if (!map || !this._group) return;
        const self = this as any;

        if (this._batch) {
            if (this._invalidGeometry || !self._isWithinView()) {
                self._isVisible = false;
                this._centroidScreenPos = null;
                return;
            }
            self._isVisible = true;
            if (this._simplify) {
                const bucket = Math.floor(map.currentDiscreteZoom / this._simplifyZoomBucket);
                if (bucket !== this._currentSimplifyBucket) {
                    this._scheduleBucketChange(bucket);
                }
            }
            this._updateCentroidScreenPos();
            return;
        }

        if (this._simplify) {
            const bucket = Math.floor(map.currentDiscreteZoom / this._simplifyZoomBucket);
            if (bucket !== this._currentSimplifyBucket) {
                this._scheduleBucketChange(bucket);
            }
        }

        if (this._invalidGeometry || !self._isWithinView()) {
            self._applyHidden();
            self._isVisible = false;
            return;
        }

        self._applyZoomInterpolations(map.continuousZoom);

        if (this._group.parent !== map.worldGroup) {
            this._group.parent?.remove(this._group);
            map.worldGroup.add(this._group);
        }

        if (this._strokeMaterial && this._strokeMaterial.resolution) {
            const canvas = map.renderer.domElement;
            const res = this._strokeMaterial.resolution;
            if (res.x !== canvas.width || res.y !== canvas.height) res.set(canvas.width, canvas.height);
        }

        if (this._boundingSphereRadius > 0) {
            const maxDist = map.maxObjectDistance;
            if (maxDist !== Infinity) {
                const worldCenter = map.getVec3().copy(this._group.position).add(map.worldGroup.position);
                const distToCenter = map.camera.position.distanceTo(worldCenter);
                if (distToCenter - this._boundingSphereRadius > maxDist) {
                    self._applyHidden();
                    self._isVisible = false;
                    return;
                }
            }
        }

        this._group.visible = true;
        self._isVisible = true;

        if (this._pendingRebuild) this._rebuildGeometry();

        const now = performance.now();
        const worldGroupPosChanged = !this._lastWorldGroupPos.equals(map.worldGroup.position);
        const discreteZoomChanged = this._lastDiscreteZoom !== map.currentDiscreteZoom;
        if (worldGroupPosChanged || discreteZoomChanged) {
            this._heightsDirty = true;
            this._lastWorldGroupPos.copy(map.worldGroup.position);
            this._lastDiscreteZoom = map.currentDiscreteZoom;
        }

        const isDynamicHeight = map.hasElevation && this._altitudeMode === 'clampToGround';
        const timeExpired = isDynamicHeight
            && (now - this._lastHeightUpdateTime) >= this._heightUpdateInterval;

        if (this._heightsDirty || timeExpired) {
            const changed = this._updateHeights();
            if (changed) this._updateStroke();
            this._heightsDirty = false;
            this._lastHeightUpdateTime = now;
        }

        this._updateCentroidScreenPos();
    },

    _updateHeights(this: Polygon): boolean {
        if (this._invalidGeometry) return false;
        if (!this._fillGeometry || !this._vertices2D.length) return false;
        const map = (this as any)._map;

        const isDynamic = map.hasElevation && this._altitudeMode === 'clampToGround';
        if (!isDynamic && this._heightsFinalized) return false;

        const wgPos = map.worldGroup.position;
        const extrude = this._extruded ? this._height : 0;
        const n = this._vertices2D.length;
        const altitude = (this as any)._altitude;

        const ensuredTiles = isDynamic ? new Set<string>() : null;
        const ensureFor = (wx: number, wz: number) => {
            const k = ((wx / 1000) | 0) + ',' + ((wz / 1000) | 0);
            if (ensuredTiles!.has(k)) return;
            ensuredTiles!.add(k);
            map.ensureTileForPoint?.(wx, wz);
        };

        for (let i = 0; i < n; i++) {
            const wc = this._worldCoords[i];
            if (!wc) continue;
            let base = altitude;
            if (isDynamic) {
                const worldX = wc[0] + wgPos.x;
                const worldZ = wc[1] + wgPos.z;
                ensureFor(worldX, worldZ);
                base = map.getSurfaceHeightAt(worldX, worldZ) + altitude;
            }
            this._cachedHeights[i] = base + (this._nodeHeights[i] ?? 0) + this._minHeight + extrude;
        }

        const strokeLen = this._strokeWorldCoords.length;
        if (this._cachedStrokeHeights.length !== strokeLen) {
            this._cachedStrokeHeights = new Array(strokeLen).fill(0);
        }
        for (let i = 0; i < strokeLen; i++) {
            const wc = this._strokeWorldCoords[i];
            if (!wc) continue;
            let base = altitude;
            if (isDynamic) {
                const worldX = wc[0] + wgPos.x;
                const worldZ = wc[1] + wgPos.z;
                map.ensureTileForPoint?.(worldX, worldZ);
                base = map.getSurfaceHeightAt(worldX, worldZ) + altitude;
            }
            this._cachedStrokeHeights[i] = base + (this._strokeNodeHeights[i] ?? 0) + this._minHeight + extrude;
        }

        const topPos = this._fillGeometry.attributes.position.array as Float32Array;
        for (let i = 0; i < n; i++) topPos[i * 3 + 1] = this._cachedHeights[i];
        this._fillGeometry.attributes.position.needsUpdate = true;
        this._fillGeometry.computeBoundingSphere();

        if (this._bottomGeometry) {
            const bottomPos = this._bottomGeometry.attributes.position.array as Float32Array;
            const height = this._height;
            for (let i = 0; i < n; i++) bottomPos[i * 3 + 1] = this._cachedHeights[i] - height;
            this._bottomGeometry.attributes.position.needsUpdate = true;
            this._bottomGeometry.computeBoundingSphere();
        }

        if (this._sideGeometry) {
            const sidePos = this._sideGeometry.attributes.position.array as Float32Array;
            const height = this._height;
            const edgeCount = this._sideEdgeIJ.length;
            for (let k = 0; k < edgeCount; k++) {
                const pair = this._sideEdgeIJ[k];
                const idxI = pair[0], idxJ = pair[1];
                const upperI = this._cachedHeights[idxI];
                const upperJ = this._cachedHeights[idxJ];
                const base = k * 4;
                sidePos[base * 3 + 1] = upperI;
                sidePos[(base + 1) * 3 + 1] = upperI - height;
                sidePos[(base + 2) * 3 + 1] = upperJ;
                sidePos[(base + 3) * 3 + 1] = upperJ - height;
            }
            this._sideGeometry.attributes.position.needsUpdate = true;

            if (this._builtSideHeight !== height) {
                const uvAttr = this._sideGeometry.attributes.uv;
                if (uvAttr) {
                    const sideUVs = uvAttr.array as Float32Array;
                    const patternScale = this._fillPatternScale > 0
                        ? this._fillPatternScale : DEFAULT_FILL_PATTERN_SCALE;
                    const vH = height / patternScale;
                    for (let k = 0; k < edgeCount; k++) {
                        const base = k * 8;
                        sideUVs[base + 1] = vH;
                        sideUVs[base + 5] = vH;
                    }
                    uvAttr.needsUpdate = true;
                }
                this._builtSideHeight = height;
            }
            this._sideGeometry.computeBoundingSphere();
        }

        if (!isDynamic) this._heightsFinalized = true;
        return true;
    },

    _updateStroke(this: Polygon): void {
        if (this._invalidGeometry) return;
        if (!this._strokeLine || !this._strokeGeometry) return;
        const positions = this._strokePositionsArray;
        positions.length = 0;
        const groupPos = this._group.position;
        const strokeLen = this._strokeWorldCoords.length;
        const altitude = (this as any)._altitude;

        for (let i = 0; i < strokeLen; i++) {
            const wc = this._strokeWorldCoords[i];
            if (!wc) continue;
            const y = this._cachedStrokeHeights[i] ?? altitude;
            positions.push(wc[0] - groupPos.x, y, wc[1] - groupPos.z);
        }
        if (strokeLen > 0) {
            const first = this._strokeWorldCoords[0];
            const fy = this._cachedStrokeHeights[0] ?? altitude;
            positions.push(first[0] - groupPos.x, fy, first[1] - groupPos.z);
        }

        if (this._useSimpleStroke) {
            const count = positions.length / 3;
            const existing = this._strokeGeometry.getAttribute('position');
            if (existing && existing.count === count) {
                (existing.array as Float32Array).set(positions);
                existing.needsUpdate = true;
                this._strokeGeometry.computeBoundingSphere();
            } else {
                this._strokeGeometry.setAttribute(
                    'position', new THREE.BufferAttribute(new Float32Array(positions), 3));
                this._strokeGeometry.computeBoundingSphere();
            }
        } else {
            this._strokeGeometry.setPositions(positions);
            this._strokeLine.computeLineDistances();
        }
    },

    _updateCentroidScreenPos(this: Polygon): void {
        if (this._invalidGeometry) { this._centroidScreenPos = null; return; }
        const map = (this as any)._map;
        if (!map || !this._centroidWorld) { this._centroidScreenPos = null; return; }
        const wgPos = map.worldGroup.position;
        const worldX = this._centroidWorld.x + wgPos.x;
        const worldZ = this._centroidWorld.z + wgPos.z;
        const altitude = (this as any)._altitude;

        let worldY = altitude;
        if (this._altitudeMode === 'clampToGround' && map.hasElevation) {
            const now = performance.now();
            if (now - this._lastCentroidHeightUpdateTime > this._heightUpdateInterval) {
                map.ensureTileForPoint(worldX, worldZ);
                this._cachedCentroidHeight = map.getSurfaceHeightAt(worldX, worldZ);
                this._lastCentroidHeightUpdateTime = now;
            }
            worldY = (this._cachedCentroidHeight ?? 0) + altitude;
        }

        if (!this._avgNodeHeightValid) {
            let sum = 0;
            const n = this._nodeHeights.length;
            for (let i = 0; i < n; i++) sum += this._nodeHeights[i] ?? 0;
            this._avgNodeHeight = n > 0 ? sum / n : 0;
            this._avgNodeHeightValid = true;
        }
        worldY += this._avgNodeHeight;
        worldY += this._minHeight + (this._extruded ? this._height : 0);

        const screenPos = map.getVec3().set(worldX, worldY + wgPos.y, worldZ);
        screenPos.project(map.camera);
        if (screenPos.z > 1 || Math.abs(screenPos.x) > 1 || Math.abs(screenPos.y) > 1) {
            this._centroidScreenPos = null;
        } else {
            const canvas = map.renderer.domElement;
            this._centroidScreenPos = {
                x: (screenPos.x * 0.5 + 0.5) * canvas.clientWidth,
                y: (-screenPos.y * 0.5 + 0.5) * canvas.clientHeight,
            };
        }
    },

    getCenter(this: Polygon): LonLat | null {
        const b = this.getBounds('EPSG:4326');
        if (!b) return null;
        return [(b[0][0] + b[1][0]) / 2, (b[0][1] + b[1][1]) / 2];
    },

    getBounds(this: Polygon, crs: string | any = 'EPSG:4326'): [LonLat, LonLat] | null {
        const key = typeof crs === 'string' ? crs : (crs?.code ?? 'custom');
        if (this._boundsCache.has(key)) return this._boundsCache.get(key)!;
        const result = this._computeBounds(crs);
        this._boundsCache.set(key, result);
        return result;
    },

    _computeBounds(this: Polygon, crs: string | any): [LonLat, LonLat] | null {
        if (!this._rings || !this._rings.length) return null;
        const src = this._crs
            ?? (this._crsCode ? Projections.get(this._crsCode) : Projections.get('EPSG:4326'));
        const dst = typeof crs === 'string' ? Projections.get(crs) : crs;
        if (!src || !dst) return null;

        const sameProjection = src === dst;
        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
        let count = 0;

        for (const ring of this._rings) {
            if (!ring) continue;
            for (const pt of ring) {
                if (!pt || pt.length < 2) continue;
                let x: number, y: number;
                if (sameProjection) { x = pt[0]; y = pt[1]; }
                else {
                    const lonLat = src.toLonLat(pt);
                    const conv = dst.fromLonLat(lonLat);
                    x = conv[0]; y = conv[1];
                }
                if (x < minX) minX = x;
                if (x > maxX) maxX = x;
                if (y < minY) minY = y;
                if (y > maxY) maxY = y;
                count++;
            }
        }
        if (count === 0 || !isFinite(minX)) return null;
        return [[minX, minY], [maxX, maxY]];
    },

    getVisualCenter(this: Polygon): LonLat | null {
        if (this._visualCenterCache) return this._visualCenterCache;
        const rings = this._rings;
        if (!rings || !rings.length) return null;
        const src = this._crs
            ?? (this._crsCode ? Projections.get(this._crsCode) : Projections.get('EPSG:4326'));
        if (!src) return null;

        const wgsRings: Array<Array<[number, number]>> = rings.map(r => r.map(pt => {
            const [lon, lat] = src.toLonLat(pt);
            return [lon, lat] as [number, number];
        }));
        const vc = approxVisualCenter(wgsRings, 0.001);
        if (!vc) return null;
        this._visualCenterCache = vc;
        return this._visualCenterCache;
    },

    getScreenBBox(this: Polygon): { minX: number; minY: number; maxX: number; maxY: number;
                                     width: number; height: number } | null {
        const map = (this as any)._map;
        if (!map || !this._worldCoords.length) return null;
        const wgPos = map.worldGroup.position;
        const canvas = map.renderer.domElement;
        const W = canvas.clientWidth, H = canvas.clientHeight;
        const v = map.getVec3?.() ?? new THREE.Vector3();
        const altitude = (this as any)._altitude;

        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
        for (let i = 0; i < this._worldCoords.length; i++) {
            const wc = this._worldCoords[i];
            const y = this._cachedHeights[i] ?? altitude;
            v.set(wc[0] + wgPos.x, y + wgPos.y, wc[1] + wgPos.z).project(map.camera);
            if (v.z <= -1 || v.z >= 1) return null;
            const px = (v.x * 0.5 + 0.5) * W;
            const py = (-v.y * 0.5 + 0.5) * H;
            if (px < minX) minX = px; if (py < minY) minY = py;
            if (px > maxX) maxX = px; if (py > maxY) maxY = py;
        }
        if (!isFinite(minX)) return null;
        return { minX, minY, maxX, maxY, width: maxX - minX, height: maxY - minY };
    },

        setTooltipOnHover(this: Polygon, on: boolean): Polygon {
        const next = !!on;
        if (this._tooltipOnHover === next) return this;
        this._tooltipOnHover = next;
        const map = (this as any)._map;
        if (map) this._registerInteraction(map);
        return this;
    },
    getTooltipOnHover(this: Polygon): boolean { return this._tooltipOnHover; },
};