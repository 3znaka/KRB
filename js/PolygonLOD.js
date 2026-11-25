/**
 * PolygonLOD.ts — миксин LOD-упрощения (Douglas–Peucker по бакетам зума).
 */
import { THREE } from './js_TP/tpb.js';
import { simplifyRingIndices } from './Simplify.js';
import { crossY, flipIndices, REBUILD_DEBOUNCE_MS, triangulatePolygonCDT, triangulatePolygonEarcut, globeSteinerLonLat, interpolateSurface, centralAngle, azimuthalEquidistant, sphericalCentroidLonLat, } from './PolygonUtils.js';
import { subdivideStepRadFor } from './PolygonGeometry.js';
/**
 * Допуск упрощения контура в пикселях экрана. Один на всю карту: уровень
 * детализации зависит только от зума, поэтому соседние полигоны стыкуются.
 * 0.1 px давал заметное падение производительности, 0.5 px — грубые страны.
 */
const GLOBE_LOD_PIXELS = 0.25;
export const PolygonLODMixin = {
    _worldPerPixel(z) {
        const map = this._map;
        return map.WORLD_SIZE / (Math.pow(2, z) * map.TILE_PIXELS);
    },
    /**
     * Глобус: Steiner-точки для constrained-триангуляции.
     * Возвращает { world: [x,z][], lonLat: [lon,lat][] } — позиции в мировых
     * координатах (как _worldCoords) и их lon/lat. Пусто для плоской карты.
     * Один источник для всех путей триангуляции, чтобы батч и LOD совпадали.
     */
    _globeSteinerPoints() {
        const empty = { world: [], lonLat: [] };
        const map = this._map;
        if (!map || map.globe !== true || typeof map.projectSurfaceVertex !== 'function')
            return empty;
        // Кеш: точки зависят только от исходных колец и карты, не от зума.
        const cached = this._steinerCache;
        if (cached)
            return cached;
        // Кольца в lon/lat — из исходных _rings (тот же набор, что и для контура).
        const rings = [];
        for (const ring of this._rings) {
            const pts = [];
            for (const pt of ring) {
                const nn = this._normalizeCoord(pt, this._crs);
                const ll = nn.lonLat ?? nn.coord;
                if (Number.isFinite(ll[0]) && Number.isFinite(ll[1]))
                    pts.push([ll[0], ll[1]]);
            }
            if (pts.length >= 3)
                rings.push(pts);
        }
        if (!rings.length)
            return empty;
        // Шаг по широте ~1°; ограничение количества точек, чтобы крупные полигоны
        // (Россия) не раздувались.
        const lonLat = globeSteinerLonLat(rings, 4, 300);
        const world = [];
        const out = [];
        const tmp = new THREE.Vector3();
        for (const ll of lonLat) {
            const p = map.projectSurfaceVertex(ll, 'EPSG:4326', 0, null, tmp);
            if (!p)
                continue;
            world.push([tmp.x, tmp.z]);
            out.push(ll);
        }
        const result = { world, lonLat: out };
        this._steinerCache = result;
        return result;
    },
    _getFullRenderRings() {
        if (this._fullRenderRings)
            return this._fullRenderRings;
        const map = this._map;
        if (!map)
            return [];
        this._fullRenderRings = this._rings.map(ring => {
            const n = ring.length;
            const worldCoords = [];
            const heights = [];
            const lonLats = [];
            // На глобусе кольцо гуще: между узлами дорисовываем дуги, иначе
            // треугольник между двумя соседними точками прошьёт шар по хорде.
            const isGlobe = map.globe === true && !!map.surface;
            const R = isGlobe ? (map.surface.b || map.R || 0) : 0;
            // Шаг по дуге ~0.25°: вершины контура плотно ложатся на сферу, и
            // хорда между соседними узлами не «срезает» край (тот самый срез
            // у края диска на скриншоте).
            const MAX_STEP = (0.25 * Math.PI) / 180;
            // Защита от раздувания: не больше стольких доп. точек на ребро.
            // Длинная граница (Россия) при шаге 0.25° требует до ~400 точек,
            // поэтому лимит поднят.
            const MAX_SUB = 512;
            // Соседние точки ближе этого (в world-единицах) — дугу не дробим.
            const MIN_CHORD = isGlobe ? ((MAX_STEP * R) / 4) : 0;
            let prevWP = null;
            let prevLonLat = null;
            for (let i = 0; i < n; i++) {
                const pt = ring[i];
                // Единая нормализация из SpatialObject:
                // - обычные [x, y] / [x, y, h]
                // - ECEF [X, Y, Z] → точные lonLat + h
                const nn = this._normalizeCoord(pt, this._crs);
                // ВАЖНО: для 3D ECEF проецируем точные lon/lat напрямую.
                // Не через nn.coord → ECEF.toLonLat(), потому что 2D ECEF-проекция
                // ограничена видимой полусферой.
                const lonLat = nn.lonLat ?? nn.coord;
                const crsRef = nn.lonLat ? 'EPSG:4326' : this._crs;
                // Мировая точка поверхности + «высота» вдоль нормали.
                const wp = new THREE.Vector3();
                let ok = true;
                if (isGlobe && typeof map.projectSurfacePoint === 'function') {
                    const r = map.projectSurfacePoint(lonLat, crsRef, nn.nodeHeight, wp);
                    if (!r)
                        ok = false;
                }
                else {
                    const p = nn.lonLat
                        ? map.project(nn.lonLat, 'EPSG:4326')
                        : map.project(nn.coord, this._crs);
                    wp.set(p[0], nn.nodeHeight, p[1]);
                }
                let x = wp.x, z = wp.z;
                if (!Number.isFinite(x)) {
                    x = 0;
                    ok = false;
                }
                if (!Number.isFinite(z)) {
                    z = 0;
                    ok = false;
                }
                if (ok && isGlobe && prevWP) {
                    this._pushDensifiedEdge(prevWP, wp, MAX_STEP, MAX_SUB, MIN_CHORD, R, worldCoords, heights, lonLats, map, lonLat, prevLonLat);
                }
                worldCoords.push([x, z]);
                heights.push(nn.nodeHeight);
                lonLats.push(Number.isFinite(lonLat[0]) && Number.isFinite(lonLat[1])
                    ? [lonLat[0], lonLat[1]] : null);
                prevWP = ok ? wp.clone() : null;
                prevLonLat = [lonLat[0], lonLat[1]];
            }
            return { worldCoords, heights, lonLats };
        });
        return this._fullRenderRings;
    },
    /**
     * Дорисовывает дугу prev → cur (БЕЗ самих концов) по поверхности
     * эллипсоида. Точки кладутся в плоские world-координаты кольца
     * ([-z] как обычно), высота — линейно между узлами.
     */
    _pushDensifiedEdge(prev, cur, maxStep, maxSub, minChord, R, worldCoords, heights, lonLats, map, curLonLat, prevLonLat) {
        const chord = prev.distanceTo(cur);
        if (!(chord > 1e-9) || chord <= minChord)
            return;
        const ang = centralAngle(prev, cur);
        if (!Number.isFinite(ang) || ang <= maxStep)
            return;
        let k = Math.ceil(ang / maxStep);
        if (k > maxSub)
            k = maxSub;
        if (k < 1)
            return;
        const pos = map.worldGroup ? map.worldGroup.position : { x: 0, y: 0, z: 0 };
        for (let j = 1; j < k; j++) {
            const t = j / k;
            const p = interpolateSurface(prev, cur, t, R);
            worldCoords.push([p.x - pos.x, p.z - pos.z]);
            heights.push(0);
            // Геодезические координаты дуги — линейно между узлами кольца
            // (для коротких рёбер вполне достаточно, длина ~0.5°).
            if (prevLonLat) {
                lonLats.push([
                    prevLonLat[0] + (curLonLat[0] - prevLonLat[0]) * t,
                    prevLonLat[1] + (curLonLat[1] - prevLonLat[1]) * t,
                ]);
            }
            else {
                lonLats.push(null);
            }
        }
    },
    _getRenderRings(bucket) {
        if (!this._simplify || !this._map || bucket < 0) {
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
        // Единый допуск для ВСЕХ полигонов и всех колец (контур и дыры): уровень
        // детализации зависит только от зума карты, поэтому соседние полигоны
        // одинаково упрощаются и их стыки совпадают.
        const tolWorld = this._worldPerPixel(z) * GLOBE_LOD_PIXELS;
        const full = this._getFullRenderRings();
        const result = full.map((ring) => {
            const { worldCoords, heights } = ring;
            if (worldCoords.length < 4)
                return ring;
            const keptIdx = simplifyRingIndices(worldCoords, tolWorld);
            let effective = keptIdx.length;
            if (effective >= 2) {
                const a = worldCoords[keptIdx[0]];
                const b = worldCoords[keptIdx[effective - 1]];
                if (a && b && a[0] === b[0] && a[1] === b[1])
                    effective--;
            }
            if (effective < 3 || keptIdx.length === worldCoords.length)
                return ring;
            // Проверку «мелкий полигон не упрощаем» убрали: она делала стыки
            // соседних полигонов несовпадающими (один упрощён, другой нет).
            const sWC = new Array(keptIdx.length);
            const sH = new Array(keptIdx.length);
            const sLL = new Array(keptIdx.length);
            for (let k = 0; k < keptIdx.length; k++) {
                sWC[k] = worldCoords[keptIdx[k]];
                sH[k] = heights[keptIdx[k]];
                // ВАЖНО: lon/lat обязаны переживать упрощение, иначе на
                // глобусе вершины теряют привязку и полигон лежит в плоскости.
                sLL[k] = ring.lonLats ? (ring.lonLats[keptIdx[k]] ?? null) : null;
            }
            return { worldCoords: sWC, heights: sH, lonLats: sLL };
        });
        this._simplifyCache.set(bucket, result);
        this._renderRings = result;
        this._currentSimplifyBucket = bucket;
        return result;
    },
    _sameRingCounts(a, b) {
        if (a.length !== b.length)
            return false;
        for (let i = 0; i < a.length; i++) {
            if (a[i].worldCoords.length !== b[i].worldCoords.length)
                return false;
        }
        return true;
    },
    _onSimplifyBucketChange(bucket) {
        if (bucket === this._currentSimplifyBucket)
            return;
        const oldRings = this._renderRings;
        const newRings = this._getRenderRings(bucket);
        if (oldRings && this._sameRingCounts(oldRings, newRings))
            return;
        if (!this._map)
            return;
        if (this._batch) {
            this._refreshWorldCoordsForBatch();
            this._invalidateBatch();
            return;
        }
        if (!this._isVisible) {
            this._pendingRebuild = true;
            return;
        }
        this._rebuildGeometry();
    },
    _refreshWorldCoordsForBatch() {
        if (!this._map)
            return;
        const rings = this._getRenderRings(this._currentSimplifyBucket);
        if (!rings || !rings.length)
            return;
        this._worldCoords.length = 0;
        this._nodeHeights.length = 0;
        this._ringStartIndices.length = 0;
        this._vertexLonLat.length = 0;
        const coords = [];
        const triCoords = [];
        const holeIndices = [];
        for (let ringIdx = 0; ringIdx < rings.length; ringIdx++) {
            const { worldCoords, heights, lonLats } = rings[ringIdx];
            if (worldCoords.length < 3)
                continue;
            this._ringStartIndices.push(this._worldCoords.length);
            if (ringIdx > 0)
                holeIndices.push(coords.length / 2);
            let firstPoint = null;
            for (let i = 0; i < worldCoords.length; i++) {
                const [absX, absZ] = worldCoords[i];
                if (i === 0)
                    firstPoint = [absX, absZ];
                if (i > 0 && firstPoint && absX === firstPoint[0] && absZ === firstPoint[1])
                    continue;
                coords.push(absX - this._centroidWorld.x, absZ - this._centroidWorld.z);
                this._worldCoords.push([absX, absZ]);
                this._nodeHeights.push(heights[i] ?? 0);
                // ВАЖНО: держим lon/lat заново — иначе после смены LOD-бакета
                // (а это происходит у больших полигонов при зуме) вершины
                // теряют привязку к эллипсоиду и полигон ложится в плоскость.
                const ll = lonLats ? (lonLats[i] ?? null) : null;
                this._vertexLonLat.push(ll);
                // Триангуляция — в lon/lat (см. _buildFillGeometry).
                triCoords.push(ll ? ll[0] : absX, ll ? ll[1] : absZ);
            }
        }
        // Число вершин контуров — зафиксировано ДО добавления Steiner.
        const contourCount = coords.length / 2;
        this._contourVertexCount = contourCount;
        // На глобусе контур уже денсифицирован с шагом 0.25°. Используем
        // быстрый earcut вместо CDT+Steiner: CDT блокирует главный поток на
        // секунды при первой загрузке/перестроении больших наборов.
        const useEarcut = this._map?.globe === true || this._isPolarOrWrapping();
        // Steiner нужен только для плоской/особой CDT-ветки.
        const steiner = useEarcut
            ? { world: [], lonLat: [] }
            : this._globeSteinerPoints();
        for (let k = 0; k < steiner.world.length; k++) {
            const [wx, wz] = steiner.world[k];
            const ll = steiner.lonLat[k];
            coords.push(wx - this._centroidWorld.x, wz - this._centroidWorld.z);
            triCoords.push(ll[0], ll[1]);
            this._worldCoords.push([wx, wz]);
            this._nodeHeights.push(0);
            this._vertexLonLat.push(ll);
        }
        let indices;
        if (useEarcut) {
            // Полярные/разорванные кольца — та же азимутальная проекция, что и в
            // _buildFillGeometry (lon/lat-развёртка разрывна у антимеридиана/полюса).
            const isGlobeMap = this._map?.globe === true;
            const usePolarPlane = isGlobeMap && this._isPolarOrWrapping();
            let planeCoords = triCoords;
            let planeCenter = null;
            if (usePolarPlane) {
                planeCenter = sphericalCentroidLonLat(this._vertexLonLat.slice(0, contourCount).filter((p) => !!p));
                planeCoords = [];
                for (let i = 0; i < triCoords.length; i += 2) {
                    const [px, py] = azimuthalEquidistant(triCoords[i], triCoords[i + 1], planeCenter[0], planeCenter[1]);
                    planeCoords.push(px, py);
                }
            }
            indices = triangulatePolygonEarcut(planeCoords, holeIndices);
            if (indices.length === 0)
                indices = triangulatePolygonEarcut(coords, holeIndices);
            if (indices.length && isGlobeMap) {
                indices = this._subdivideGlobeTriangles(indices, this._vertexLonLat, contourCount, holeIndices, subdivideStepRadFor(this._vertexLonLat), planeCenter);
                coords.length = 0;
                for (const [x, z] of this._worldCoords)
                    coords.push(x - this._centroidWorld.x, z - this._centroidWorld.z);
            }
        }
        else {
            indices = triangulatePolygonCDT(triCoords, holeIndices, contourCount);
        }
        if (indices.length === 0) {
            this._cachedTopIndices = null;
            return;
        }
        const p2d = new Array(this._worldCoords.length);
        for (let i = 0; i < this._worldCoords.length; i++) {
            p2d[i] = { x: coords[i * 2], y: coords[i * 2 + 1] };
        }
        const firstCrossY = crossY(p2d[indices[0]], p2d[indices[1]], p2d[indices[2]]);
        this._cachedTopIndices = firstCrossY >= 0 ? indices : flipIndices(indices);
    },
    _scheduleBucketChange(bucket) {
        if (this._rebuildTimer) {
            this._pendingBucket = bucket;
            return;
        }
        this._pendingBucket = bucket;
        this._rebuildTimer = setTimeout(() => {
            this._rebuildTimer = null;
            if (!this._map)
                return;
            const b = this._pendingBucket;
            this._pendingBucket = -1;
            if (b >= 0 && b !== this._currentSimplifyBucket) {
                this._onSimplifyBucketChange(b);
            }
        }, REBUILD_DEBOUNCE_MS);
    },
};
