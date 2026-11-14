/**
 * PolygonGeometry.ts — построение геометрии: заливка, экструзия, обводка, UV,
 * fill-pattern, поверхностные материалы.
 */
import { THREE, Line2, LineMaterial, LineGeometry } from './js_TP/tpb.js';
import earcut from './js_TP/earcut.js';
import {
    type UVParams,
    POLYGON_RENDER_ORDER, INVALID_EDGE_FRACTION, DEFAULT_FILL_PATTERN_SCALE,
    crossY, flipIndices, approxVisualCenter, getSharedPatternTexture,
} from './PolygonUtils.js';
import type { Polygon } from './Polygon.js';


export interface PolygonGeometry {
    _disposeMeshes(): void;
    _loadFillPattern(): void;
    _configureFillPatternTexture(): void;
    _applyFillPatternToMaterials(): void;
    _computeUVParams(patternScale: number): UVParams;
    _updateFillUVs(): void;
    _createSurfaceMaterial(): any;
    _applyShadowFlags(mesh: any): void;
    _hasAntimeridianWrap(): boolean;
    _isGeometryInvalid(ringStartIndices: number[], worldSize: number): boolean;
    _triangulateFromRings(): number[];
    _buildFillGeometry(map: any): void;
    _buildBottomAndSides(points2D: any[], topUVs: Float32Array, bottomIndices: number[], patternScale: number): void;
    _buildStrokeGeometry(map: any): void;
}

export const PolygonGeometryMixin = {
    _disposeMeshes(this: Polygon): void {
        if (this._group) {
            while (this._group.children.length > 0) this._group.remove(this._group.children[0]);
        }
        this._fillGeometry?.dispose(); this._fillMaterial?.dispose();
        this._bottomGeometry?.dispose(); this._bottomMaterial?.dispose();
        this._sideGeometry?.dispose(); this._sideMaterial?.dispose();
        this._strokeGeometry?.dispose(); this._strokeMaterial?.dispose();
        this._fillMesh = null; this._fillGeometry = null; this._fillMaterial = null;
        this._bottomMesh = null; this._bottomGeometry = null; this._bottomMaterial = null;
        this._sideMesh = null; this._sideGeometry = null; this._sideMaterial = null;
        this._strokeLine = null; this._strokeGeometry = null; this._strokeMaterial = null;
        this._raycastMeshesCache = null;
    },

    _loadFillPattern(this: Polygon): void {
        const src = this._fillPatternSource;
        const generation = ++this._fillPatternGeneration;
        if (!src) { this._fillPatternTexture = null; return; }

        if (typeof src === 'string') {
            this._fillPatternTexture = getSharedPatternTexture(src);
            this._configureFillPatternTexture();
            const loader = new THREE.TextureLoader();
            loader.setCrossOrigin('anonymous');
            const tex = loader.load(
                src,
                (loaded: any) => {
                    if (generation !== this._fillPatternGeneration) {
                        try { loaded?.dispose?.(); } catch { /* swallow */ }
                        return;
                    }
                    this._configureFillPatternTexture();
                    this._applyFillPatternToMaterials();
                },
                undefined,
                (err: any) => {
                    if (generation !== this._fillPatternGeneration) return;
                    console.warn('Polygon: fillPattern load failed', err);
                },
            );
            this._fillPatternTexture = tex;
            this._configureFillPatternTexture();
        } else if (typeof HTMLCanvasElement !== 'undefined' && src instanceof HTMLCanvasElement) {
            this._fillPatternTexture = new THREE.CanvasTexture(src);
            this._configureFillPatternTexture();
        } else {
            this._fillPatternTexture = new THREE.Texture(src as any);
            this._fillPatternTexture.needsUpdate = true;
            this._configureFillPatternTexture();
        }
    },

    _configureFillPatternTexture(this: Polygon): void {
        const t = this._fillPatternTexture;
        if (!t) return;
        t.wrapS = THREE.RepeatWrapping;
        t.wrapT = THREE.RepeatWrapping;
        t.generateMipmaps = false;
        t.minFilter = THREE.LinearFilter;
        t.magFilter = THREE.LinearFilter;

        const map = (this as any)._map;
        const renderer = map?.renderer;
        const caps = renderer?.capabilities;
        if (caps && typeof caps.getMaxAnisotropy === 'function') {
            try { t.anisotropy = Math.min(16, caps.getMaxAnisotropy()); } catch { /* swallow */ }
        }
        const Ctor = THREE as any;
        if (Ctor.SRGBColorSpace && !(t as any).colorSpace) {
            (t as any).colorSpace = Ctor.SRGBColorSpace;
        }
        t.needsUpdate = true;
    },

    _applyFillPatternToMaterials(this: Polygon): void {
        const map = this._fillPatternTexture;
        if (!map) return;
        for (const mat of [this._fillMaterial, this._bottomMaterial, this._sideMaterial]) {
            if (!mat) continue;
            mat.map = map;
            mat.needsUpdate = true;
        }
    },

    _computeUVParams(this: Polygon, patternScale: number): UVParams {
        if (this._fillPatternFit === 'bounds') {
            let minPX = Infinity, maxPX = -Infinity;
            let minPZ = Infinity, maxPZ = -Infinity;
            for (const wc of this._worldCoords) {
                if (!wc) continue;
                if (wc[0] < minPX) minPX = wc[0];
                if (wc[0] > maxPX) maxPX = wc[0];
                if (wc[1] < minPZ) minPZ = wc[1];
                if (wc[1] > maxPZ) maxPZ = wc[1];
            }
            return {
                originX: isFinite(minPX) ? minPX : 0,
                originZ: isFinite(minPZ) ? minPZ : 0,
                scaleX: (maxPX - minPX) > 1e-6 ? (maxPX - minPX) : 1,
                scaleZ: (maxPZ - minPZ) > 1e-6 ? (maxPZ - minPZ) : 1,
            };
        }
        return {
            originX: Math.floor(this._centroidWorld.x / patternScale) * patternScale,
            originZ: Math.floor(this._centroidWorld.z / patternScale) * patternScale,
            scaleX: patternScale,
            scaleZ: patternScale,
        };
    },

    _updateFillUVs(this: Polygon): void {
        if (this._invalidGeometry) return;
        if (!this._fillGeometry) return;

        const patternScale = this._fillPatternScale > 0
            ? this._fillPatternScale : DEFAULT_FILL_PATTERN_SCALE;
        const params = this._computeUVParams(patternScale);
        const worldCoords = this._worldCoords;
        const n = worldCoords.length;

        const topAttr = this._fillGeometry.attributes.uv;
        if (topAttr) {
            const topUVs = topAttr.array as Float32Array;
            for (let i = 0; i < n; i++) {
                const wc = worldCoords[i];
                if (!wc) continue;
                topUVs[i * 2]     = (wc[0] - params.originX) / params.scaleX;
                topUVs[i * 2 + 1] = (wc[1] - params.originZ) / params.scaleZ;
            }
            topAttr.needsUpdate = true;
        }
        if (this._bottomGeometry) {
            const botAttr = this._bottomGeometry.attributes.uv;
            if (botAttr && topAttr) {
                (botAttr.array as Float32Array).set(topAttr.array as Float32Array);
                botAttr.needsUpdate = true;
            }
        }
        if (this._sideGeometry && this._sideEdgeLengths.length > 0) {
            const sideAttr = this._sideGeometry.attributes.uv;
            if (sideAttr) {
                const sideUVs = sideAttr.array as Float32Array;
                const vH = this._height / patternScale;
                let cum = 0;
                const edgeCount = this._sideEdgeLengths.length;
                for (let k = 0; k < edgeCount; k++) {
                    const edgeLen = this._sideEdgeLengths[k];
                    const base = k * 8;
                    const u0 = cum / patternScale;
                    const u1 = (cum + edgeLen) / patternScale;
                    sideUVs[base + 0] = u0; sideUVs[base + 1] = vH;
                    sideUVs[base + 2] = u0; sideUVs[base + 3] = 0;
                    sideUVs[base + 4] = u1; sideUVs[base + 5] = vH;
                    sideUVs[base + 6] = u1; sideUVs[base + 7] = 0;
                    cum += edgeLen;
                }
                sideAttr.needsUpdate = true;
            }
            this._builtSideHeight = this._height;
        }
    },

    _createSurfaceMaterial(this: Polygon): any {
        const hasOpacityAnim = !!(
            (this as any)._zoomInterpolations?.fillOpacity &&
            (this as any)._zoomInterpolations.fillOpacity.length >= 2
        );
        const isTransparent = hasOpacityAnim || this._fillOpacity < 1;
        const map = this._fillPatternTexture;
        const patternProps = map ? { map } : {};

        if (this._extruded) {
            return new THREE.MeshStandardMaterial({
                color: this._fillColor, opacity: this._fillOpacity,
                transparent: isTransparent, side: THREE.FrontSide,
                roughness: this._roughness, metalness: this._metalness,
                depthTest: this._depthTest, depthWrite: this._depthWrite,
                polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1,
                ...patternProps,
            });
        }
        return new THREE.MeshBasicMaterial({
            color: this._fillColor, opacity: this._fillOpacity,
            transparent: isTransparent, side: THREE.FrontSide,
            depthTest: this._depthTest, depthWrite: this._depthWrite,
            polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1,
            ...patternProps,
        });
    },

    _applyShadowFlags(this: Polygon, mesh: any): void {
        if (!mesh) return;
        if (this._extruded) {
            mesh.castShadow = this._castShadow;
            mesh.receiveShadow = this._receiveShadow;
        } else {
            mesh.castShadow = false;
            mesh.receiveShadow = false;
        }
    },

    _hasAntimeridianWrap(this: Polygon): boolean {
        const crs = this._crs;
        if (!crs || !crs.isGeographic) return false;
        const rings = this._rings;
        if (!rings) return false;
        for (let r = 0; r < rings.length; r++) {
            const ring = rings[r];
            if (!ring || ring.length < 2) continue;
            const n = ring.length;
            for (let i = 0; i < n; i++) {
                const a = ring[i], b = ring[(i + 1) % n];
                if (!a || !b || a.length < 2 || b.length < 2) continue;
                if (Math.abs(b[0] - a[0]) > 180) return true;
            }
        }
        return false;
    },

    _isGeometryInvalid(this: Polygon, ringStartIndices: number[], worldSize: number): boolean {
        const maxEdge = worldSize / INVALID_EDGE_FRACTION;
        const maxEdgeSq = maxEdge * maxEdge;
        const wc = this._worldCoords;
        for (let ringIdx = 0; ringIdx < ringStartIndices.length; ringIdx++) {
            const start = ringStartIndices[ringIdx];
            if (start === undefined) continue;
            const nextStart = (ringIdx + 1 < ringStartIndices.length)
                ? ringStartIndices[ringIdx + 1] : wc.length;
            const count = nextStart - start;
            if (count < 2) continue;
            for (let i = 0; i < count; i++) {
                const a = wc[start + i];
                const b = wc[start + ((i + 1) % count)];
                if (!a || !b) continue;
                const dx = b[0] - a[0], dz = b[1] - a[1];
                if (dx * dx + dz * dz > maxEdgeSq) return true;
            }
        }
        return false;
    },

    _triangulateFromRings(this: Polygon): number[] {
        const wc = this._worldCoords;
        const rs = this._ringStartIndices;
        if (!wc.length || !rs.length) return [];

        const coords: number[] = [];
        const holeIndices: number[] = [];
        for (let r = 0; r < rs.length; r++) {
            const start = rs[r];
            const end = (r + 1 < rs.length) ? rs[r + 1] : wc.length;
            if (r > 0) holeIndices.push(coords.length / 2);
            for (let i = start; i < end; i++) coords.push(wc[i][0], wc[i][1]);
        }
        if (coords.length < 6) return [];

        const indices = earcut(coords, holeIndices, 2);
        if (!indices.length) return [];

        const p2d: Array<{ x: number; y: number }> = new Array(coords.length / 2);
        for (let i = 0, j = 0; i < coords.length; i += 2, j++) {
            p2d[j] = { x: coords[i], y: coords[i + 1] };
        }
        const firstCrossY = crossY(p2d[indices[0]], p2d[indices[1]], p2d[indices[2]]);
        return firstCrossY >= 0 ? indices : flipIndices(indices);
    },

    _buildFillGeometry(this: Polygon, map: any): void {
        this._cachedTopIndices = null;
        const rings = this._getRenderRings(this._currentSimplifyBucket);
        if (!rings || !rings.length || rings[0].worldCoords.length < 3) {
            console.warn('Polygon: rings[0] must have at least 3 points');
            return;
        }

        this._worldCoords.length = 0;
        this._nodeHeights.length = 0;
        this._ringStartIndices.length = 0;
        this._sideEdgeIJ.length = 0;
        this._sideEdgeLengths.length = 0;
        this._builtSideHeight = -1;
        this._avgNodeHeightValid = false;
        this._boundsCache.clear();

        const coords: number[] = [];
        const points2D: any[] = [];
        const holeIndices: number[] = [];
        const ringStartIndices: number[] = [];

        for (let ringIdx = 0; ringIdx < rings.length; ringIdx++) {
            const { worldCoords, heights } = rings[ringIdx];
            if (worldCoords.length < 3) {
                console.warn(`Polygon: hole ring ${ringIdx} must have at least 3 points`);
                continue;
            }
            ringStartIndices.push(points2D.length);
            this._ringStartIndices.push(points2D.length);
            if (ringIdx > 0) holeIndices.push(coords.length / 2);

            let firstPoint: [number, number] | null = null;
            for (let i = 0; i < worldCoords.length; i++) {
                const [absX, absZ] = worldCoords[i];
                if (i === 0) firstPoint = [absX, absZ];
                if (i > 0 && firstPoint && absX === firstPoint[0] && absZ === firstPoint[1]) continue;
                coords.push(absX, absZ);
                points2D.push(new THREE.Vector2(absX, absZ));
                this._worldCoords.push([absX, absZ]);
                this._nodeHeights.push(heights[i] ?? 0);
            }
        }

        if (points2D.length < 3) {
            this._invalidGeometry = true;
            this._group.visible = false;
            this._worldCoords.length = 0;
            this._nodeHeights.length = 0;
            this._ringStartIndices.length = 0;
            return;
        }

        if (!this._hasAntimeridianWrap()
            && this._isGeometryInvalid(ringStartIndices, map.WORLD_SIZE)) {
            this._invalidGeometry = true;
            this._group.visible = false;
            this._worldCoords.length = 0;
            this._nodeHeights.length = 0;
            return;
        }
        this._invalidGeometry = false;

        this._vertices2D = points2D;
        this._cachedHeights = new Array(points2D.length).fill(0);

        const indices = earcut(coords, holeIndices, 2);
        if (indices.length === 0) {
            console.warn('Polygon: Earcut returned no triangles');
            return;
        }

        const firstCrossY = crossY(points2D[indices[0]], points2D[indices[1]], points2D[indices[2]]);
        const topIndices = firstCrossY >= 0 ? indices : flipIndices(indices);
        const bottomIndices = flipIndices(topIndices);
        this._cachedTopIndices = topIndices;

        let cx: number, cy: number;
        if (!this._centroidFromOriginal) {
            const fullRings = this._getFullRenderRings();
            const srcRings: [number, number][][] = fullRings.map(r => r.worldCoords);
            const vc = approxVisualCenter(srcRings, 0);
            if (vc) this._centroidFromOriginal = { x: vc[0], z: vc[1] };
            else {
                let sx = 0, sy = 0, cnt = 0;
                for (const r of srcRings) for (const p of r) { sx += p[0]; sy += p[1]; cnt++; }
                this._centroidFromOriginal = cnt ? { x: sx / cnt, z: sy / cnt } : { x: 0, z: 0 };
            }
        }
        cx = this._centroidFromOriginal.x;
        cy = this._centroidFromOriginal.z;

        this._centroidWorld.set(cx, 0, cy);
        this._group.position.copy(this._centroidWorld);

        for (let i = 0; i < points2D.length; i++) {
            points2D[i].x -= cx;
            points2D[i].y -= cy;
        }

        let maxRadiusSq = 0;
        for (const pt of points2D) {
            const rSq = pt.x * pt.x + pt.y * pt.y;
            if (rSq > maxRadiusSq) maxRadiusSq = rSq;
        }
        this._boundingSphereRadius = Math.sqrt(maxRadiusSq);

        const patternScale = this._fillPatternScale > 0
            ? this._fillPatternScale : DEFAULT_FILL_PATTERN_SCALE;
        const uvParams = this._computeUVParams(patternScale);

        const topUVs = new Float32Array(points2D.length * 2);
        for (let i = 0; i < points2D.length; i++) {
            const wc = this._worldCoords[i];
            const wx = wc ? wc[0] : 0;
            const wz = wc ? wc[1] : 0;
            topUVs[i * 2]     = (wx - uvParams.originX) / uvParams.scaleX;
            topUVs[i * 2 + 1] = (wz - uvParams.originZ) / uvParams.scaleZ;
        }

        const topGeometry = new THREE.BufferGeometry();
        const topPosArray = new Float32Array(points2D.length * 3);
        for (let i = 0; i < points2D.length; i++) {
            const pt = points2D[i];
            topPosArray[i * 3] = pt.x;
            topPosArray[i * 3 + 1] = 0;
            topPosArray[i * 3 + 2] = pt.y;
        }
        topGeometry.setAttribute('position', new THREE.BufferAttribute(topPosArray, 3));
        topGeometry.setAttribute('uv', new THREE.BufferAttribute(topUVs, 2));
        topGeometry.setIndex(topIndices);

        const topNormals = new Float32Array(points2D.length * 3);
        for (let i = 0; i < points2D.length; i++) topNormals[i * 3 + 1] = 1;
        topGeometry.setAttribute('normal', new THREE.BufferAttribute(topNormals, 3));
        topGeometry.computeBoundingSphere();

        const topMaterial = this._createSurfaceMaterial();
        const topMesh = new THREE.Mesh(topGeometry, topMaterial);
        topMesh.renderOrder = POLYGON_RENDER_ORDER.TOP;
        topMesh.frustumCulled = true;
        topMesh.userData.polygon = this;
        this._applyShadowFlags(topMesh);
        this._fillMesh = topMesh;
        this._fillGeometry = topGeometry;
        this._fillMaterial = topMaterial;
        this._group.add(topMesh);

        if (this._extruded) {
            this._buildBottomAndSides(points2D, topUVs, bottomIndices, patternScale);
        }

        this._raycastMeshesCache = null;
    },

    _buildBottomAndSides(this: Polygon,
        points2D: any[], topUVs: Float32Array, bottomIndices: number[], patternScale: number,
    ): void {
        const bottomGeometry = new THREE.BufferGeometry();
        const bottomPosArray = new Float32Array(points2D.length * 3);
        for (let i = 0; i < points2D.length; i++) {
            const pt = points2D[i];
            bottomPosArray[i * 3] = pt.x;
            bottomPosArray[i * 3 + 1] = 0;
            bottomPosArray[i * 3 + 2] = pt.y;
        }
        bottomGeometry.setAttribute('position', new THREE.BufferAttribute(bottomPosArray, 3));
        bottomGeometry.setAttribute('uv', new THREE.BufferAttribute(topUVs.slice(), 2));
        bottomGeometry.setIndex(bottomIndices);

        const bottomNormals = new Float32Array(points2D.length * 3);
        for (let i = 0; i < points2D.length; i++) bottomNormals[i * 3 + 1] = -1;
        bottomGeometry.setAttribute('normal', new THREE.BufferAttribute(bottomNormals, 3));
        bottomGeometry.computeBoundingSphere();

        const bottomMaterial = this._createSurfaceMaterial();
        const bottomMesh = new THREE.Mesh(bottomGeometry, bottomMaterial);
        bottomMesh.renderOrder = POLYGON_RENDER_ORDER.BOTTOM;
        bottomMesh.frustumCulled = true;
        bottomMesh.userData.polygon = this;
        this._applyShadowFlags(bottomMesh);
        this._bottomMesh = bottomMesh;
        this._bottomGeometry = bottomGeometry;
        this._bottomMaterial = bottomMaterial;
        this._group.add(bottomMesh);

        const sideUvScale = patternScale;
        const initialHeight = this._height;
        const vH = initialHeight / sideUvScale;

        let totalEdges = 0;
        for (let ringIdx = 0; ringIdx < this._ringStartIndices.length; ringIdx++) {
            const start = this._ringStartIndices[ringIdx];
            const nextRingStart = (ringIdx + 1 < this._ringStartIndices.length)
                ? this._ringStartIndices[ringIdx + 1] : points2D.length;
            const count = nextRingStart - start;
            if (count < 2) continue;
            totalEdges += count;
        }

        const sidePositions = new Float32Array(totalEdges * 4 * 3);
        const sideUVs      = new Float32Array(totalEdges * 4 * 2);
        const sideIndices  = new Uint32Array(totalEdges * 6);

        let posK = 0, uvK = 0, idxK = 0, vertBase = 0;

        for (let ringIdx = 0; ringIdx < this._ringStartIndices.length; ringIdx++) {
            const start = this._ringStartIndices[ringIdx];
            const nextRingStart = (ringIdx + 1 < this._ringStartIndices.length)
                ? this._ringStartIndices[ringIdx + 1] : points2D.length;
            const count = nextRingStart - start;
            if (count < 2) continue;

            let sa = 0;
            for (let i = 0; i < count; i++) {
                const j = (i + 1) % count;
                const a = points2D[start + i];
                const b = points2D[start + j];
                sa += a.x * b.y - b.x * a.y;
            }
            const flipSides = (sa > 0) !== (ringIdx > 0);

            let cum = 0;
            for (let i = 0; i < count; i++) {
                const j = (i + 1) % count;
                const idxI = start + i;
                const idxJ = start + j;
                const topI = points2D[idxI];
                const topJ = points2D[idxJ];

                sidePositions[posK++] = topI.x; sidePositions[posK++] = initialHeight; sidePositions[posK++] = topI.y;
                sidePositions[posK++] = topI.x; sidePositions[posK++] = 0;             sidePositions[posK++] = topI.y;
                sidePositions[posK++] = topJ.x; sidePositions[posK++] = initialHeight; sidePositions[posK++] = topJ.y;
                sidePositions[posK++] = topJ.x; sidePositions[posK++] = 0;             sidePositions[posK++] = topJ.y;

                const ddx = topJ.x - topI.x;
                const ddz = topJ.y - topI.y;
                const edgeLen = Math.sqrt(ddx * ddx + ddz * ddz);
                const u0 = cum / sideUvScale;
                const u1 = (cum + edgeLen) / sideUvScale;

                sideUVs[uvK++] = u0; sideUVs[uvK++] = vH;
                sideUVs[uvK++] = u0; sideUVs[uvK++] = 0;
                sideUVs[uvK++] = u1; sideUVs[uvK++] = vH;
                sideUVs[uvK++] = u1; sideUVs[uvK++] = 0;

                if (!flipSides) {
                    sideIndices[idxK++] = vertBase;     sideIndices[idxK++] = vertBase + 1; sideIndices[idxK++] = vertBase + 2;
                    sideIndices[idxK++] = vertBase + 1; sideIndices[idxK++] = vertBase + 3; sideIndices[idxK++] = vertBase + 2;
                } else {
                    sideIndices[idxK++] = vertBase;     sideIndices[idxK++] = vertBase + 2; sideIndices[idxK++] = vertBase + 1;
                    sideIndices[idxK++] = vertBase + 1; sideIndices[idxK++] = vertBase + 2; sideIndices[idxK++] = vertBase + 3;
                }
                vertBase += 4;

                this._sideEdgeIJ.push([idxI, idxJ]);
                this._sideEdgeLengths.push(edgeLen);
                cum += edgeLen;
            }
        }

        if (totalEdges > 0) {
            const sideGeometry = new THREE.BufferGeometry();
            sideGeometry.setAttribute('position', new THREE.BufferAttribute(sidePositions, 3));
            sideGeometry.setAttribute('uv', new THREE.BufferAttribute(sideUVs, 2));
            sideGeometry.setIndex(new THREE.BufferAttribute(sideIndices, 1));
            sideGeometry.computeVertexNormals();
            sideGeometry.computeBoundingSphere();

            const sideMaterial = this._createSurfaceMaterial();
            const sideMesh = new THREE.Mesh(sideGeometry, sideMaterial);
            sideMesh.renderOrder = POLYGON_RENDER_ORDER.SIDE;
            sideMesh.frustumCulled = true;
            sideMesh.userData.polygon = this;
            this._applyShadowFlags(sideMesh);
            this._sideMesh = sideMesh;
            this._sideGeometry = sideGeometry;
            this._sideMaterial = sideMaterial;
            this._group.add(sideMesh);
            this._builtSideHeight = initialHeight;
        }
    },

    _buildStrokeGeometry(this: Polygon, map: any): void {
        if (this._invalidGeometry) return;
        if (this._strokeWidth <= 0 || this._strokeOpacity <= 0) return;

        const canvas = map.renderer.domElement;
        const rings = this._getRenderRings(this._currentSimplifyBucket);
        const outer = rings[0];
        if (!outer) return;
        const { worldCoords: outerWC, heights: outerH } = outer;

        this._strokeWorldCoords.length = 0;
        this._strokeNodeHeights.length = 0;
        let firstStrokePoint: [number, number] | null = null;
        for (let i = 0; i < outerWC.length; i++) {
            const [absX, absZ] = outerWC[i];
            if (i === 0) firstStrokePoint = [absX, absZ];
            else if (firstStrokePoint && absX === firstStrokePoint[0] && absZ === firstStrokePoint[1]) continue;
            this._strokeWorldCoords.push([absX, absZ]);
            this._strokeNodeHeights.push(outerH[i] ?? 0);
        }

        this._cachedStrokeHeights = new Array(this._strokeWorldCoords.length).fill(0);

        if (this._useSimpleStroke) {
            const positions: number[] = [];
            for (let i = 0; i < this._strokeWorldCoords.length; i++) {
                const wc = this._strokeWorldCoords[i];
                positions.push(wc[0], 0, wc[1]);
            }
            if (this._strokeWorldCoords.length > 0) {
                const first = this._strokeWorldCoords[0];
                positions.push(first[0], 0, first[1]);
            }
            const lineGeometry = new THREE.BufferGeometry();
            lineGeometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(positions), 3));
            lineGeometry.computeBoundingSphere();

            const lineMaterial = new THREE.LineBasicMaterial({
                color: this._strokeColor,
                opacity: this._strokeOpacity,
                transparent: this._strokeOpacity < 1,
                depthTest: this._depthTest,
                depthWrite: this._depthWrite,
            });
            const line = new THREE.Line(lineGeometry, lineMaterial);
            line.renderOrder = POLYGON_RENDER_ORDER.STROKE;
            this._strokeLine = line;
            this._strokeGeometry = lineGeometry;
            this._strokeMaterial = lineMaterial;
            this._group.add(line);
        } else {
            this._strokeGeometry = new LineGeometry();
            this._strokeMaterial = new LineMaterial({
                color: this._strokeColor,
                linewidth: this._strokeWidth,
                opacity: this._strokeOpacity,
                transparent: this._strokeOpacity < 1,
                depthTest: this._depthTest,
                depthWrite: this._depthWrite,
                resolution: new THREE.Vector2(canvas.width, canvas.height),
            });
            const line = new Line2(this._strokeGeometry, this._strokeMaterial);
            line.renderOrder = POLYGON_RENDER_ORDER.STROKE;
            this._strokeLine = line;
            this._group.add(line);
        }
    },
};