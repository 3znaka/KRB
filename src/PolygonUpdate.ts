/**
 * PolygonUpdate.ts вЂ” per-frame update (РІРёРґРёРјРѕСЃС‚СЊ, РІС‹СЃРѕС‚С‹, РѕР±РІРѕРґРєР°, СЌРєСЂР°РЅРЅС‹Р№
 * centroid), depth-С„Р»Р°РіРё, bounds / visual center / screen bbox.
 */
import { THREE } from './js_TP/tpb.js';
import { Projections } from './Projections.js';
import { DEFAULT_FILL_PATTERN_SCALE, approxVisualCenter, type LonLat } from './PolygonUtils.js';
import type { Polygon } from './Polygon.js';

/** Temp-РІРµРєС‚РѕСЂ РґР»СЏ РїРµСЂРµСЃС‡С‘С‚Р° РІРµСЂС€РёРЅ (Р±РµР· Р°Р»Р»РѕРєР°С†РёР№ РЅР° РєР°РґСЂ). */
const _v3 = new THREE.Vector3();
/** Temp-вектор для вершин обводки на глобусе. */
const _strokeV = new THREE.Vector3();

export interface PolygonUpdate {
    _update(_mapArg?: any): void;
    _updateHeights(): boolean;
    _vertexLonLatOf(i: number): [number, number] | null;
    _centroidLonLat(): [number, number] | null;
    _averageLonLat(arr: Array<[number, number] | null> | null, nPts: number): [number, number] | null;
    _orientIndicesOutward(posArr: Float32Array, origin: any): void;
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

    /**
 * Р“РµРѕРґРµР·РёС‡РµСЃРєРёРµ РєРѕРѕСЂРґРёРЅР°С‚С‹ i-Р№ РІРµСЂС€РёРЅС‹ РєРѕР»СЊС†Р° (РІ РїРѕСЂСЏРґРєРµ `_worldCoords`).
 * РќР° РіР»РѕР±СѓСЃРµ РїРѕ РЅРёРј РІРµСЂС€РёРЅР° РєР»Р°РґС‘С‚СЃСЏ РЅР° СЌР»Р»РёРїСЃРѕРёРґ.
 */
_vertexLonLatOf(this: Polygon, i: number): [number, number] | null {
    const ll = this._vertexLonLat?.[i];
    return Array.isArray(ll) ? (ll as [number, number]) : null;
},

/**
 * Развернуть треугольники, смотрящие ВНУТРЬ сферы.
 *
 * Триангуляция (earcut) считается в плоской проекции, поэтому на глобусе
 * обход части граней оказывается «лицом к центру Земли» — такие грани
 * пропадают из-за backface culling, и заливка выглядит рваной.
 * Здесь на каждый треугольник считаем нормаль и сравниваем её с
 * направлением от центра Земли: если смотрит внутрь — меняем обход.
 */
_orientIndicesOutward(posArr: Float32Array, origin: any): void {
    const geo = this._fillGeometry;
    const idx = geo.index?.array as ArrayLike<number> | undefined;
    if (!idx) return;
    const ox = origin ? origin.x : 0;
    const oy = origin ? origin.y : 0;
    const oz = origin ? origin.z : 0;

    for (let t = 0; t < idx.length; t += 3) {
        const ia = idx[t], ib = idx[t + 1], ic = idx[t + 2];
        const ax = posArr[ia * 3], ay = posArr[ia * 3 + 1], az = posArr[ia * 3 + 2];
        const bx = posArr[ib * 3], by = posArr[ib * 3 + 1], bz = posArr[ib * 3 + 2];
        const cx = posArr[ic * 3], cy = posArr[ic * 3 + 1], cz = posArr[ic * 3 + 2];

        // нормаль треугольника
        const ux = bx - ax, uy = by - ay, uz = bz - az;
        const vx = cx - ax, vy = cy - ay, vz = cz - az;
        const nx = uy * vz - uz * vy;
        const ny = uz * vx - ux * vz;
        const nz = ux * vy - uy * vx;

        // направление «наружу» = из центра на центр треугольника
        const mx = (ax + bx + cx) / 3 + ox;
        const my = (ay + by + cy) / 3 + oy;
        const mz = (az + bz + cz) / 3 + oz;

        if (nx * mx + ny * my + nz * mz < 0) {
            (idx as any)[t + 1] = ic;
            (idx as any)[t + 2] = ib;
        }
    }
    geo.index.needsUpdate = true;
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

        // РќР° РіР»РѕР±СѓСЃРµ РєР°Р¶РґРѕР№ РІРµСЂС€РёРЅРµ РЅСѓР¶РЅС‹ РЎР’РћР X/Y/Z (С‚РѕС‡РєР° РЅР° СЌР»Р»РёРїСЃРѕРёРґРµ),
        // РёРЅР°С‡Рµ РІСЃСЏ РіРµРѕРјРµС‚СЂРёСЏ РѕСЃС‚Р°С‘С‚СЃСЏ РІ РїР»РѕСЃРєРѕСЃС‚Рё y = const.
        const globe = map.globe === true && !!map.surface;
        const origin = this._centroidWorld;

        // РљРѕРѕСЂРґРёРЅР°С‚Р° РєР°Р¶РґРѕР№ РІРµСЂС€РёРЅС‹ РІ Р»РѕРєР°Р»СЊРЅРѕРј РїСЂРѕСЃС‚СЂР°РЅСЃС‚РІРµ РіСЂСѓРїРїС‹.
        const localPos = new Float32Array(n * 3);
        if (globe) {
            for (let i = 0; i < n; i++) {
                const ll = this._vertexLonLatOf(i);
                const v = _v3;
                const p = ll
                    ? map.projectSurfaceVertex(ll, 'EPSG:4326', this._cachedHeights[i], origin, v)
                    : null;
                // РќРµС‚ РєРѕРѕСЂРґРёРЅР°С‚С‹ (Р°РЅРѕРјР°Р»РёСЏ) вЂ” РѕСЃС‚Р°РІР»СЏРµРј РїСЂРµР¶РЅСЋСЋ РїРѕР·РёС†РёСЋ.
                const src = (this._fillGeometry.attributes.position.array as Float32Array);
                const k = i * 3;
                localPos[k]     = p ? v.x : src[k];
                localPos[k + 1] = p ? v.y : src[k + 1];
                localPos[k + 2] = p ? v.z : src[k + 2];
            }
        }

        const topPos = this._fillGeometry.attributes.position.array as Float32Array;
        if (globe) {
            topPos.set(localPos);
            this._orientIndicesOutward(topPos, origin);
        } else {
            for (let i = 0; i < n; i++) topPos[i * 3 + 1] = this._cachedHeights[i];
        }
        this._fillGeometry.attributes.position.needsUpdate = true;
        this._fillGeometry.computeVertexNormals?.();
        this._fillGeometry.computeBoundingSphere();

        if (this._bottomGeometry) {
            const bottomPos = this._bottomGeometry.attributes.position.array as Float32Array;
            const height = this._height;
            if (globe) {
                for (let i = 0; i < n; i++) {
                    const ll = this._vertexLonLatOf(i);
                    const p = ll
                        ? map.projectSurfaceVertex(ll, 'EPSG:4326', this._cachedHeights[i] - height, origin, _v3)
                        : null;
                    const k = i * 3;
                    if (p) { bottomPos[k] = _v3.x; bottomPos[k + 1] = _v3.y; bottomPos[k + 2] = _v3.z; }
                    else bottomPos[k + 1] = this._cachedHeights[i] - height;
                }
            } else {
                for (let i = 0; i < n; i++) bottomPos[i * 3 + 1] = this._cachedHeights[i] - height;
            }
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
        const map = (this as any)._map;

        // Глобус: вершина обводки = точка эллипсоида (как у заливки),
        // а не (x, y, z) плоскости — иначе обводка «лежит» в экваторе.
        const globe = map?.globe === true && typeof map.projectSurfaceVertex === 'function';
        const v = _strokeV;

        for (let i = 0; i < strokeLen; i++) {
            const wc = this._strokeWorldCoords[i];
            if (!wc) continue;
            const y = this._cachedStrokeHeights[i] ?? altitude;
            const ll = globe ? (this._strokeVertexLonLat?.[i] ?? null) : null;
            if (ll) {
                const p = map.projectSurfaceVertex(ll, 'EPSG:4326', y, this._centroidWorld, v);
                if (p) { positions.push(v.x, v.y, v.z); continue; }
            }
            positions.push(wc[0] - groupPos.x, y, wc[1] - groupPos.z);
        }
        if (strokeLen > 0) {
            const first = this._strokeWorldCoords[0];
            const fy = this._cachedStrokeHeights[0] ?? altitude;
            const ll = globe ? (this._strokeVertexLonLat?.[0] ?? null) : null;
            let pushed = false;
            if (ll) {
                const p = map.projectSurfaceVertex(ll, 'EPSG:4326', fy, this._centroidWorld, v);
                if (p) { positions.push(v.x, v.y, v.z); pushed = true; }
            }
            if (!pushed) positions.push(first[0] - groupPos.x, fy, first[1] - groupPos.z);
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

    /**
 * Геодезические координаты центроида полигона — для подписи.
 *
 * ВАЖНО: на глобусе `_centroidWorld`/`_centroidFromOriginal` — это ECEF
 * (x, z точки на сфере), а не плоская проекция, поэтому переводить их
 * через unproject нельзя. Считаем центр по lon/lat вершин кольца.
 */
_centroidLonLat(this: Polygon): [number, number] | null {
    const map = (this as any)._map;
    if (!map) return null;

    // 1) Быстрый путь: геодезические координаты вершин уже есть
    //    (`_vertexLonLat` заполняется при сборке геометрии).
    //    ВАЖНО: после батчинга `_vertices2D` обнуляется, поэтому
    //    ориентируемся только на сам массив.
    const arr = this._vertexLonLat;
    let ll = this._averageLonLat(arr, arr ? arr.length : 0);
    if (ll) return ll;

    // 2) Own-геометрия ещё не строилась (полигон сразу ушёл в батчер).
    //    Считаем центр прямо из ИСХОДНЫХ колец `_rings` — они всегда есть.
    const rings = this._rings as any;
    if (rings && rings.length) {
        const tmp: Array<[number, number] | null> = [];
        for (let r = 0; r < rings.length; r++) {
            const ring = rings[r];
            if (!ring) continue;
            for (let i = 0; i < ring.length; i++) {
                const nn = this._normalizeCoord(ring[i], this._crs);
                const lonLat = nn.lonLat ?? nn.coord;
                tmp.push(Array.isArray(lonLat)
                    && Number.isFinite(lonLat[0]) && Number.isFinite(lonLat[1])
                    ? [lonLat[0], lonLat[1]] : null);
            }
        }
        ll = this._averageLonLat(tmp, tmp.length);
        if (ll) return ll;
    }

    // 3) Плоская карта (или нет данных): прежний путь через unproject.
    if (!map.globe && this._centroidFromOriginal) {
        const src = this._centroidFromOriginal;
        const conv = typeof map.unprojectToLonLatSafe === 'function'
            ? map.unprojectToLonLatSafe(src.x, src.z)
            : null;
        if (conv && Number.isFinite(conv[0]) && Number.isFinite(conv[1])) ll = [conv[0], conv[1]];
    }
    return ll;
},

/**
 * Среднее lon/lat по массиву вершин с учётом перехода через антимеридиан.
 */
_averageLonLat(arr: Array<[number, number] | null> | null, nPts: number): [number, number] | null {
    if (!arr || nPts <= 0) return null;
    let sx = 0, sy = 0, n = 0;
    let lonRef: number | null = null;
    for (let i = 0; i < nPts; i++) {
        const p = arr[i];
        if (!p) continue;
        if (lonRef === null) lonRef = p[0];
        let dLon = p[0] - lonRef;
        while (dLon > 180) dLon -= 360;
        while (dLon < -180) dLon += 360;
        sx += dLon;
        sy += p[1];
        n++;
    }
    if (n === 0) return null;
    let lon = (lonRef as number) + sx / n;
    while (lon > 180) lon -= 360;
    while (lon < -180) lon += 360;
    return [lon, sy / n];
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

        // ГЛОБУС: центр полигона лежит на ЭЛЛИПСОИДЕ, а `_centroidWorld`
        // хранит плоскую пару (x, z). Берём настоящую мировую точку центра
        // через его lon/lat — иначе подпись висит в плоскости экватора.
        let px = worldX, py = worldY + wgPos.y, pz = worldZ;
        if (map.globe && typeof map.projectSurfacePoint === 'function') {
            const ll = this._centroidLonLat();
            if (ll) {
                const v = map.getVec3();
                const surf = map.projectSurfacePoint(ll, 'EPSG:4326', worldY, v);
                if (surf) { px = surf.x; py = surf.y; pz = surf.z; }
            }
        }

        // Глобус: центр за горизонтом (обратная сторона) — подпись скрываем так же,
        // как Marker: иначе она попадает на экран по X/Y и висит на чужой стороне.
        if (map.globe && typeof map.isWorldPointOccluded === 'function'
            && map.isWorldPointOccluded(map.getVec3().set(px, py, pz))) {
            this._centroidScreenPos = null;
            return;
        }

        const screenPos = map.getVec3().set(px, py, pz);
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

            // РќРѕСЂРјР°Р»РёР·СѓРµРј СЃ src, Р° РЅРµ РѕР±СЏР·Р°С‚РµР»СЊРЅРѕ СЃ this._crs:
            // getBounds() РјРѕР¶РµС‚ РІС‹Р·С‹РІР°С‚СЊСЃСЏ РґРѕ attach.
            const nn = this._normalizeCoord(pt, src);

            let x: number, y: number;

            if (nn.lonLat) {
                // 3D ECEF: С‚РѕС‡РЅС‹Рµ РіРµРѕРґРµР·РёС‡РµСЃРєРёРµ РєРѕРѕСЂРґРёРЅР°С‚С‹.
                const conv = dst.fromLonLat(nn.lonLat);
                x = conv[0];
                y = conv[1];
            } else if (sameProjection) {
                x = nn.coord[0];
                y = nn.coord[1];
            } else {
                const conv = dst.fromLonLat(src.toLonLat(nn.coord));
                x = conv[0];
                y = conv[1];
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

    const wgsRings: Array<Array<[number, number]>> = rings.map(r =>
        r.map(pt => {
            const nn = this._normalizeCoord(pt, src);

            // ECEF 3D в†’ С‚РѕС‡РЅС‹Рµ lon/lat.
            // РћР±С‹С‡РЅР°СЏ CRS в†’ src.toLonLat(coord).
            const ll = nn.lonLat ?? src.toLonLat(nn.coord);

            return [ll[0], ll[1]] as [number, number];
        })
    );

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
