/**
 * PolygonLOD.ts — миксин LOD-упрощения (Douglas–Peucker по бакетам зума).
 */
import earcut from './js_TP/earcut.js';
import { simplifyRingIndices } from './Simplify.js';
import {
    type RenderRing, type PolygonRing,
    crossY, flipIndices, REBUILD_DEBOUNCE_MS,
} from './PolygonUtils.js';
import type { Polygon } from './Polygon.js';

export interface PolygonLOD {
    _worldPerPixel(z: number): number;
    _getFullRenderRings(): RenderRing[];
    _getRenderRings(bucket: number): RenderRing[];
    _sameRingCounts(a: RenderRing[], b: RenderRing[]): boolean;
    _onSimplifyBucketChange(bucket: number): void;
    _refreshWorldCoordsForBatch(): void;
    _scheduleBucketChange(bucket: number): void;
}

export const PolygonLODMixin = {
    _worldPerPixel(this: Polygon, z: number): number {
        const map = (this as any)._map;
        return map.WORLD_SIZE / (Math.pow(2, z) * map.TILE_PIXELS);
    },

    _getFullRenderRings(this: Polygon): RenderRing[] {
        if (this._fullRenderRings) return this._fullRenderRings;
        const map = (this as any)._map;
        if (!map) return [];
        this._fullRenderRings = this._rings.map(ring => {
            const n = ring.length;
            const worldCoords: [number, number][] = new Array(n);
            const heights: number[] = new Array(n);
            for (let i = 0; i < n; i++) {
                const pt = ring[i];
                worldCoords[i] = map.project(pt, this._crs) as [number, number];
                const h = pt?.[2];
                heights[i] = Number.isFinite(h) ? (h as number) : 0;
            }
            return { worldCoords, heights };
        });
        return this._fullRenderRings;
    },

    _getRenderRings(this: Polygon, bucket: number): RenderRing[] {
        if (!this._simplify || !(this as any)._map || bucket < 0) {
            return this._getFullRenderRings();
        }
        if (bucket === this._currentSimplifyBucket && this._renderRings) {
            return this._renderRings;
        }
        const cached = this._simplifyCache.get(bucket);
        if (cached) {
            this._renderRings = cached;
            this._currentSimplifyBucket = bucket;
            return cached;
        }

        const z = bucket * this._simplifyZoomBucket;
        const tolWorld = this._worldPerPixel(z) * this._simplifyTolerance;
        const full = this._getFullRenderRings();

        const result: RenderRing[] = full.map((ring, ringIdx) => {
            const { worldCoords, heights } = ring;
            if (worldCoords.length < 4) return ring;
            const tol = ringIdx === 0 ? tolWorld : tolWorld * 0.5;
            const keptIdx = simplifyRingIndices(worldCoords, tol);

            let effective = keptIdx.length;
            if (effective >= 2) {
                const a = worldCoords[keptIdx[0]];
                const b = worldCoords[keptIdx[effective - 1]];
                if (a && b && a[0] === b[0] && a[1] === b[1]) effective--;
            }
            if (effective < 3 || keptIdx.length === worldCoords.length) return ring;

            let area2 = 0;
            for (let k = 0; k < keptIdx.length - 1; k++) {
                const a = worldCoords[keptIdx[k]];
                const b = worldCoords[keptIdx[k + 1]];
                area2 += a[0] * b[1] - b[0] * a[1];
            }
            if (Math.abs(area2) * 0.5 < tolWorld * tolWorld) return ring;

            const sWC: [number, number][] = new Array(keptIdx.length);
            const sH: number[] = new Array(keptIdx.length);
            for (let k = 0; k < keptIdx.length; k++) {
                sWC[k] = worldCoords[keptIdx[k]];
                sH[k] = heights[keptIdx[k]];
            }
            return { worldCoords: sWC, heights: sH };
        });

        this._simplifyCache.set(bucket, result);
        this._renderRings = result;
        this._currentSimplifyBucket = bucket;
        return result;
    },

    _sameRingCounts(this: Polygon, a: RenderRing[], b: RenderRing[]): boolean {
        if (a.length !== b.length) return false;
        for (let i = 0; i < a.length; i++) {
            if (a[i].worldCoords.length !== b[i].worldCoords.length) return false;
        }
        return true;
    },

    _onSimplifyBucketChange(this: Polygon, bucket: number): void {
        if (bucket === this._currentSimplifyBucket) return;
        const oldRings = this._renderRings;
        const newRings = this._getRenderRings(bucket);
        if (oldRings && this._sameRingCounts(oldRings, newRings)) return;
        if (!(this as any)._map) return;

        if (this._batch) {
            this._refreshWorldCoordsForBatch();
            this._invalidateBatch();
            return;
        }
        if (!(this as any)._isVisible) {
            this._pendingRebuild = true;
            return;
        }
        this._rebuildGeometry();
    },

    _refreshWorldCoordsForBatch(this: Polygon): void {
        if (!(this as any)._map) return;
        const rings = this._getRenderRings(this._currentSimplifyBucket);
        if (!rings || !rings.length) return;

        this._worldCoords.length = 0;
        this._nodeHeights.length = 0;
        this._ringStartIndices.length = 0;

        const coords: number[] = [];
        const holeIndices: number[] = [];

        for (let ringIdx = 0; ringIdx < rings.length; ringIdx++) {
            const { worldCoords, heights } = rings[ringIdx];
            if (worldCoords.length < 3) continue;
            this._ringStartIndices.push(this._worldCoords.length);
            if (ringIdx > 0) holeIndices.push(coords.length / 2);
            let firstPoint: [number, number] | null = null;
            for (let i = 0; i < worldCoords.length; i++) {
                const [absX, absZ] = worldCoords[i];
                if (i === 0) firstPoint = [absX, absZ];
                if (i > 0 && firstPoint && absX === firstPoint[0] && absZ === firstPoint[1]) continue;
                coords.push(absX - this._centroidWorld.x, absZ - this._centroidWorld.z);
                this._worldCoords.push([absX, absZ]);
                this._nodeHeights.push(heights[i] ?? 0);
            }
        }

        const indices = earcut(coords, holeIndices.length ? holeIndices : undefined, 2);
        if (indices.length === 0) { this._cachedTopIndices = null; return; }
        const p2d = new Array(this._worldCoords.length);
        for (let i = 0; i < this._worldCoords.length; i++) {
            p2d[i] = { x: coords[i * 2], y: coords[i * 2 + 1] };
        }
        const firstCrossY = crossY(p2d[indices[0]], p2d[indices[1]], p2d[indices[2]]);
        this._cachedTopIndices = firstCrossY >= 0 ? indices : flipIndices(indices);
    },

    _scheduleBucketChange(this: Polygon, bucket: number): void {
        if (this._rebuildTimer) {
            this._pendingBucket = bucket;
            return;
        }
        this._pendingBucket = bucket;
        this._rebuildTimer = setTimeout(() => {
            this._rebuildTimer = null;
            if (!(this as any)._map) return;
            const b = this._pendingBucket;
            this._pendingBucket = -1;
            if (b >= 0 && b !== this._currentSimplifyBucket) {
                this._onSimplifyBucketChange(b);
            }
        }, REBUILD_DEBOUNCE_MS);
    },
};