/**
 * PolygonGeometry.ts — построение геометрии: заливка, экструзия, обводка, UV,
 * fill-pattern, поверхностные материалы.
 */
import { THREE, Line2, LineMaterial, LineGeometry } from './js_TP/tpb.js';
import { POLYGON_RENDER_ORDER, INVALID_EDGE_FRACTION, DEFAULT_FILL_PATTERN_SCALE, crossY, flipIndices, approxVisualCenter, getSharedPatternTexture, applyGapMaskToMaterial, triangulatePolygonCDT, triangulatePolygonEarcut, azimuthalEquidistant, inverseAzimuthalEquidistant, sphericalCentroidLonLat, centralAngle, } from './PolygonUtils.js';
/**
 * Earcut may emit tiny-area triangles around long runs of nearly collinear
 * boundary vertices. On a globe those degenerate faces can show up as long,
 * dark hairline slivers. Filter only triangles whose altitude/edge ratio is
 * below 1e-6; their removed area is negligible compared with the source ring.
 */
function filterNearDegenerateTriangles(coords, indices, relativeAreaEpsilon = 1e-6) {
    if (indices.length < 3)
        return indices;
    const out = [];
    for (let i = 0; i + 2 < indices.length; i += 3) {
        const ia = indices[i] * 2, ib = indices[i + 1] * 2, ic = indices[i + 2] * 2;
        const ax = coords[ia], ay = coords[ia + 1];
        const bx = coords[ib], by = coords[ib + 1];
        const cx = coords[ic], cy = coords[ic + 1];
        const abx = bx - ax, aby = by - ay;
        const bcx = cx - bx, bcy = cy - by;
        const cax = ax - cx, cay = ay - cy;
        const maxEdgeSq = Math.max(abx * abx + aby * aby, bcx * bcx + bcy * bcy, cax * cax + cay * cay);
        const twiceArea = Math.abs(abx * (cy - ay) - aby * (cx - ax));
        if (!(maxEdgeSq > 0) || twiceArea <= maxEdgeSq * relativeAreaEpsilon)
            continue;
        out.push(indices[i], indices[i + 1], indices[i + 2]);
    }
    return out;
}
/**
 * Максимальная длина ребра на сфере, после которой ребро делится (градусы).
 * Крупный шаг (для больших полигонов), по умолчанию 0.75.
 */
let globeSubdivideDeg = 0.75;
/** Шаг для самых мелких полигонов (размер ≤ SMALL_SIZE_DEG), градусы. */
let globeSubdivideSmallDeg = 5;
/** Размер полигона (градусы), начиная с которого действует мелкий шаг. */
const SMALL_SIZE_DEG = 2;
/** Размер полигона (градусы), начиная с которого действует крупный шаг. */
const LARGE_SIZE_DEG = 15;
export function setGlobeSubdivideDeg(deg) {
    if (Number.isFinite(deg) && deg > 0)
        globeSubdivideDeg = deg;
}
export function getGlobeSubdivideDeg() {
    return globeSubdivideDeg;
}
export function setGlobeSubdivideSmallDeg(deg) {
    if (Number.isFinite(deg) && deg > 0)
        globeSubdivideSmallDeg = deg;
}
/**
 * Шаг субдивизии (радианы) для полигона.
 * Крупные и вытянутые полигоны (размер ≥ LARGE_SIZE_DEG) получают
 * globeSubdivideDeg; мелкие (≤ SMALL_SIZE_DEG) — globeSubdivideSmallDeg;
 * между ними — линейная интерполяция. Размер — наибольший угловой
 * размер ограничивающего прямоугольника по lon/lat вершинам.
 */
export function subdivideStepRadFor(lonLats) {
    let minLon = Infinity, maxLon = -Infinity, minLat = Infinity, maxLat = -Infinity;
    for (const p of lonLats) {
        if (!p)
            continue;
        if (p[0] < minLon)
            minLon = p[0];
        if (p[0] > maxLon)
            maxLon = p[0];
        if (p[1] < minLat)
            minLat = p[1];
        if (p[1] > maxLat)
            maxLat = p[1];
    }
    const size = Math.max(maxLon - minLon, maxLat - minLat);
    let deg;
    if (!Number.isFinite(size) || size >= LARGE_SIZE_DEG)
        deg = globeSubdivideDeg;
    else if (size <= SMALL_SIZE_DEG)
        deg = globeSubdivideSmallDeg;
    else {
        const t = (size - SMALL_SIZE_DEG) / (LARGE_SIZE_DEG - SMALL_SIZE_DEG);
        deg = globeSubdivideSmallDeg + (globeSubdivideDeg - globeSubdivideSmallDeg) * t;
    }
    return deg * Math.PI / 180;
}
/** Включает децимацию контура на глобусе. Выключено: ломало заливку (см. историю). */
const DECIMATE_INTERIOR = false;
/** Порог углового отклонения точки контура от её соседей на сфере, градусы. */
const DECIMATE_TOLERANCE_DEG = 0.2;
/**
 * Децимация контуров с последующей перетриангуляцией earcut.
 *
 * Для каждой вершины контура (внутри каждого кольца) считается угловое
 * отклонение от сферического центра её соседей по кольцу. Если оно меньше
 * порога, точка удаляется. Кольцо всегда сохраняет минимум 3 точки. Затем
 * earcut перетриангулирует полигон по выжившим точкам с теми же дырами —
 * треугольники гарантированно лежат внутри полигона, отдельная проверка
 * валидности звёзд не нужна.
 *
 * Возвращает новый массив индексов. Координаты в `coords` (плоские) заменяются
 * на выжившие, поэтому вызывающий код должен пересобрать свои массивы по
 * возвращённому порядку — см. `result.coords`.
 */
function decimateContourAndRetriangulate(coords, holeIndices, sphere, toleranceRad) {
    const vertCount = coords.length / 2;
    const ringStarts = [0, ...holeIndices].map(s => s);
    const ringEnds = [...holeIndices, vertCount];
    const keep = []; // исходные индексы выживших вершин
    const newHoles = [];
    for (let r = 0; r < ringStarts.length; r++) {
        const s = ringStarts[r], e = ringEnds[r];
        const n = e - s;
        if (r > 0)
            newHoles.push(keep.length);
        if (n < 4) {
            for (let i = s; i < e; i++)
                keep.push(i);
            continue;
        }
        // Итеративно удаляем вершины с малым угловым отклонением.
        const alive = [];
        for (let i = s; i < e; i++)
            alive.push(i);
        let changed = true;
        while (changed && alive.length > 3) {
            changed = false;
            for (let k = 0; k < alive.length && alive.length > 3; k++) {
                const prev = alive[(k - 1 + alive.length) % alive.length];
                const cur = alive[k];
                const next = alive[(k + 1) % alive.length];
                const sp = sphere[prev], sc = sphere[cur], sn = sphere[next];
                if (!sp || !sc || !sn)
                    continue;
                const sx = sp.x + sn.x, sy = sp.y + sn.y, sz = sp.z + sn.z;
                const sl = Math.hypot(sx, sy, sz);
                const lc = Math.hypot(sc.x, sc.y, sc.z);
                if (!(sl > 1e-9) || !(lc > 1e-9))
                    continue;
                const cosA = Math.max(-1, Math.min(1, (sc.x * sx + sc.y * sy + sc.z * sz) / (lc * sl)));
                if (Math.acos(cosA) <= toleranceRad) {
                    alive.splice(k, 1);
                    changed = true;
                    k--;
                }
            }
        }
        for (const i of alive)
            keep.push(i);
    }
    // Новые координаты по выжившим вершинам (порядок сохраняется по кольцам).
    const newCoords = [];
    for (const i of keep)
        newCoords.push(coords[i * 2], coords[i * 2 + 1]);
    const indices = triangulatePolygonEarcut(newCoords, newHoles);
    return { coords: newCoords, indices, keep };
}
/** Упорядоченное по обходу кольцо соседей вершины v по её треугольникам. */
function starRing(v, tris) {
    // Для каждого треугольника (v, a, b) ребро a->b задаёт направление обхода.
    const next = new Map();
    for (const tri of tris) {
        const k = tri.indexOf(v);
        if (k < 0)
            continue;
        const a = tri[(k + 1) % 3];
        const b = tri[(k + 2) % 3];
        next.set(a, b);
    }
    if (next.size === 0)
        return null;
    const start = next.keys().next().value;
    const ring = [start];
    let cur = next.get(start);
    while (cur !== undefined && cur !== start && ring.length <= next.size) {
        ring.push(cur);
        cur = next.get(cur);
    }
    if (ring.length !== next.size)
        return null; // звезда не замкнута — не трогаем
    return ring;
}
/** Earcut по локальному плоскому кольцу (внутренний вызов, без дырок). */
function earcutRing(coords) {
    const idx = triangulatePolygonEarcut(coords, []);
    return idx && idx.length ? idx : null;
}
export const PolygonGeometryMixin = {
    /**
     * 3D-позиции вершин на поверхности (для углового критерия децимации).
     * Вершина без lon/lat получает null и не участвует в децимации.
     */
    _sphereVerticesFor(lonLats) {
        const surface = this._map?.surface;
        const out = new Array(lonLats.length).fill(null);
        if (!surface)
            return out;
        for (let i = 0; i < lonLats.length; i++) {
            const ll = lonLats[i];
            if (!ll)
                continue;
            const v = surface.position(ll[0], ll[1], 0, new THREE.Vector3());
            if (v && Number.isFinite(v.x) && Number.isFinite(v.y) && Number.isFinite(v.z)) {
                out[i] = { x: v.x, y: v.y, z: v.z };
            }
        }
        return out;
    },
    /**
     * Subdivide earcut triangles on the globe surface.
     *
     * MapLibre follows the same high-level strategy: fast earcut topology,
     * then split triangles before the globe projection. Here overlong edges
     * are bisected on the sphere; shared edge midpoints are cached by the
     * unordered endpoint pair so adjacent triangles stitch exactly.
     */
    _subdivideGlobeTriangles(indices, lonLats, contourCount, holeIndices, maxStepRad, planeCenter = null) {
        if (!indices.length || !(maxStepRad > 0))
            return indices;
        const outLonLat = lonLats.slice(0, contourCount);
        const outWorld = this._worldCoords.slice(0, contourCount);
        const outCachedHeights = (this._cachedHeights ?? []).slice(0, contourCount);
        const surface = this._map.surface;
        const worldOffset = this._map.worldGroup.position;
        const midpointCache = new Map();
        const edgeAngle = (a, b) => {
            const la = outLonLat[a], lb = outLonLat[b];
            if (!la || !lb)
                return 0;
            const va = surface.position(la[0], la[1], 0, new THREE.Vector3());
            const vb = surface.position(lb[0], lb[1], 0, new THREE.Vector3());
            const angle = centralAngle(va, vb);
            return Number.isFinite(angle) ? angle : 0;
        };
        const getMidpoint = (a, b) => {
            const lo = Math.min(a, b), hi = Math.max(a, b);
            const key = `${lo}:${hi}`;
            const cached = midpointCache.get(key);
            if (cached != null)
                return cached;
            const la = outLonLat[lo], lb = outLonLat[hi];
            if (!la || !lb)
                return lo;
            let lon, lat;
            if (planeCenter) {
                // Polar/wrapping ring: earcut's parent triangle lives in the
                // azimuthal plane. Take the midpoint there and invert back to
                // lon/lat, so the child stays inside its parent triangle and
                // never crosses the antimeridian seam.
                const pa = azimuthalEquidistant(la[0], la[1], planeCenter[0], planeCenter[1]);
                const pb = azimuthalEquidistant(lb[0], lb[1], planeCenter[0], planeCenter[1]);
                const ll = inverseAzimuthalEquidistant((pa[0] + pb[0]) * 0.5, (pa[1] + pb[1]) * 0.5, planeCenter[0], planeCenter[1]);
                lon = ll[0];
                lat = ll[1];
            }
            else {
                // Earcut's parent triangle lives in the source lon/lat plane.
                // Take the exact arithmetic midpoint there (shortest wrapped lon
                // only for dateline-adjacent endpoints), then project that point
                // onto the ellipsoid. This keeps every child inside its source
                // triangle instead of letting a great-circle midpoint bow outside.
                let deltaLon = lb[0] - la[0];
                if (deltaLon > 180)
                    deltaLon -= 360;
                else if (deltaLon < -180)
                    deltaLon += 360;
                lon = la[0] + deltaLon * 0.5;
                lat = (la[1] + lb[1]) * 0.5;
            }
            while (lon > 180)
                lon -= 360;
            while (lon < -180)
                lon += 360;
            const idx = outLonLat.length;
            outLonLat.push([lon, lat]);
            const height = ((outCachedHeights[lo] ?? 0) + (outCachedHeights[hi] ?? 0)) * 0.5;
            const p = this._map.projectSurfaceVertex([lon, lat], 'EPSG:4326', height, null, new THREE.Vector3());
            if (!p || !Number.isFinite(p.x) || !Number.isFinite(p.y) || !Number.isFinite(p.z)) {
                outLonLat.pop();
                return lo;
            }
            outWorld.push([p.x - worldOffset.x, p.z - worldOffset.z]);
            outCachedHeights.push(height);
            midpointCache.set(key, idx);
            return idx;
        };
        // Conforming midpoint refinement. Each round marks every over-limit
        // edge globally, so both triangles sharing an edge split it together
        // (no T-junctions). A 1/2/3-edge split produces 2/3/4 child triangles;
        // all children are subsets of the original earcut triangle.
        let triangles = [];
        for (let i = 0; i + 2 < indices.length; i += 3) {
            triangles.push([indices[i], indices[i + 1], indices[i + 2]]);
        }
        const maxRounds = 12;
        for (let round = 0; round < maxRounds; round++) {
            const splitEdges = new Set();
            for (const [a, b, c] of triangles) {
                for (const [u, v] of [[a, b], [b, c], [c, a]]) {
                    if (edgeAngle(u, v) > maxStepRad) {
                        splitEdges.add(`${Math.min(u, v)}:${Math.max(u, v)}`);
                    }
                }
            }
            if (!splitEdges.size)
                break;
            for (const key of splitEdges) {
                const [a, b] = key.split(':').map(Number);
                getMidpoint(a, b);
            }
            const midpoint = (a, b) => midpointCache.get(`${Math.min(a, b)}:${Math.max(a, b)}`) ?? null;
            const next = [];
            for (const [a, b, c] of triangles) {
                const ab = midpoint(a, b), bc = midpoint(b, c), ca = midpoint(c, a);
                const count = Number(ab != null) + Number(bc != null) + Number(ca != null);
                if (count === 0) {
                    next.push([a, b, c]);
                    continue;
                }
                if (ab != null && bc == null && ca == null) {
                    next.push([a, ab, c], [ab, b, c]);
                }
                else if (ab == null && bc != null && ca == null) {
                    next.push([b, bc, a], [bc, c, a]);
                }
                else if (ab == null && bc == null && ca != null) {
                    next.push([c, ca, b], [ca, a, b]);
                }
                else if (ab != null && bc != null && ca == null) {
                    next.push([b, bc, ab], [a, ab, c], [ab, bc, c]);
                }
                else if (ab == null && bc != null && ca != null) {
                    next.push([c, ca, bc], [b, bc, a], [bc, ca, a]);
                }
                else if (ab != null && bc == null && ca != null) {
                    next.push([a, ab, ca], [c, ca, b], [ca, ab, b]);
                }
                else {
                    next.push([a, ab, ca], [ab, b, bc], [ca, bc, c], [ab, bc, ca]);
                }
            }
            triangles = next;
        }
        const result = [];
        for (const tri of triangles)
            result.push(tri[0], tri[1], tri[2]);
        // Preserve ring boundaries and contour-vertex metadata; append the
        // generated surface samples after all original contour vertices.
        this._worldCoords.length = 0;
        this._worldCoords.push(...outWorld);
        this._vertexLonLat.length = 0;
        this._vertexLonLat.push(...outLonLat);
        this._nodeHeights.length = outWorld.length;
        for (let i = contourCount; i < outWorld.length; i++)
            this._nodeHeights[i] = 0;
        this._cachedHeights = outCachedHeights;
        while (this._cachedHeights.length < outWorld.length)
            this._cachedHeights.push(0);
        return result;
    },
    /**
     * Полигон разорван антимеридианом (скачок долготы больше 180° между соседними
     * вершинами) или касается полюса (|широта| ≥ 80°). Для таких полигонов lon/lat
     * развёртка не отражает форму на сфере, и используется earcut без Steiner.
     */
    _isPolarOrWrapping() {
        const ll = this._vertexLonLat;
        if (!ll || !ll.length)
            return false;
        let prev = null;
        for (const p of ll) {
            if (!p)
                continue;
            if (Math.abs(p[1]) >= 80)
                return true;
            if (prev && Math.abs(p[0] - prev[0]) > 180)
                return true;
            prev = p;
        }
        return false;
    },
    _disposeMeshes() {
        if (this._group) {
            while (this._group.children.length > 0)
                this._group.remove(this._group.children[0]);
        }
        this._fillGeometry?.dispose();
        this._fillMaterial?.dispose();
        this._bottomGeometry?.dispose();
        this._bottomMaterial?.dispose();
        this._sideGeometry?.dispose();
        this._sideMaterial?.dispose();
        this._strokeGeometry?.dispose();
        this._strokeMaterial?.dispose();
        this._fillMesh = null;
        this._fillGeometry = null;
        this._fillMaterial = null;
        this._bottomMesh = null;
        this._bottomGeometry = null;
        this._bottomMaterial = null;
        this._sideMesh = null;
        this._sideGeometry = null;
        this._sideMaterial = null;
        this._strokeLine = null;
        this._strokeGeometry = null;
        this._strokeMaterial = null;
        this._raycastMeshesCache = null;
    },
    _loadFillPattern() {
        const src = this._fillPatternSource;
        const generation = ++this._fillPatternGeneration;
        if (!src) {
            this._fillPatternTexture = null;
            return;
        }
        if (typeof src === 'string') {
            this._fillPatternTexture = getSharedPatternTexture(src);
            this._configureFillPatternTexture();
            const loader = new THREE.TextureLoader();
            loader.setCrossOrigin('anonymous');
            const tex = loader.load(src, (loaded) => {
                if (generation !== this._fillPatternGeneration) {
                    try {
                        loaded?.dispose?.();
                    }
                    catch { /* swallow */ }
                    return;
                }
                this._configureFillPatternTexture();
                this._applyFillPatternToMaterials();
            }, undefined, (err) => {
                if (generation !== this._fillPatternGeneration)
                    return;
                console.warn('Polygon: fillPattern load failed', err);
            });
            this._fillPatternTexture = tex;
            this._configureFillPatternTexture();
        }
        else if (typeof HTMLCanvasElement !== 'undefined' && src instanceof HTMLCanvasElement) {
            this._fillPatternTexture = new THREE.CanvasTexture(src);
            this._configureFillPatternTexture();
        }
        else {
            this._fillPatternTexture = new THREE.Texture(src);
            this._fillPatternTexture.needsUpdate = true;
            this._configureFillPatternTexture();
        }
    },
    _configureFillPatternTexture() {
        const t = this._fillPatternTexture;
        if (!t)
            return;
        t.wrapS = THREE.RepeatWrapping;
        t.wrapT = THREE.RepeatWrapping;
        t.generateMipmaps = false;
        t.minFilter = THREE.LinearFilter;
        t.magFilter = THREE.LinearFilter;
        const map = this._map;
        const renderer = map?.renderer;
        const caps = renderer?.capabilities;
        if (caps && typeof caps.getMaxAnisotropy === 'function') {
            try {
                t.anisotropy = Math.min(16, caps.getMaxAnisotropy());
            }
            catch { /* swallow */ }
        }
        const Ctor = THREE;
        if (Ctor.SRGBColorSpace && !t.colorSpace) {
            t.colorSpace = Ctor.SRGBColorSpace;
        }
        t.needsUpdate = true;
    },
    _applyFillPatternToMaterials() {
        const map = this._fillPatternTexture;
        if (!map)
            return;
        for (const mat of [this._fillMaterial, this._bottomMaterial, this._sideMaterial]) {
            if (!mat)
                continue;
            mat.map = map;
            mat.needsUpdate = true;
        }
    },
    _computeUVParams(patternScale) {
        if (this._fillPatternFit === 'bounds') {
            let minPX = Infinity, maxPX = -Infinity;
            let minPZ = Infinity, maxPZ = -Infinity;
            for (const wc of this._worldCoords) {
                if (!wc)
                    continue;
                if (wc[0] < minPX)
                    minPX = wc[0];
                if (wc[0] > maxPX)
                    maxPX = wc[0];
                if (wc[1] < minPZ)
                    minPZ = wc[1];
                if (wc[1] > maxPZ)
                    maxPZ = wc[1];
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
    _updateFillUVs() {
        if (this._invalidGeometry)
            return;
        if (!this._fillGeometry)
            return;
        const patternScale = this._fillPatternScale > 0
            ? this._fillPatternScale : DEFAULT_FILL_PATTERN_SCALE;
        const params = this._computeUVParams(patternScale);
        const worldCoords = this._worldCoords;
        const n = worldCoords.length;
        const topAttr = this._fillGeometry.attributes.uv;
        if (topAttr) {
            const topUVs = topAttr.array;
            for (let i = 0; i < n; i++) {
                const wc = worldCoords[i];
                if (!wc)
                    continue;
                topUVs[i * 2] = (wc[0] - params.originX) / params.scaleX;
                topUVs[i * 2 + 1] = (wc[1] - params.originZ) / params.scaleZ;
            }
            topAttr.needsUpdate = true;
        }
        if (this._bottomGeometry) {
            const botAttr = this._bottomGeometry.attributes.uv;
            if (botAttr && topAttr) {
                botAttr.array.set(topAttr.array);
                botAttr.needsUpdate = true;
            }
        }
        if (this._sideGeometry && this._sideEdgeLengths.length > 0) {
            const sideAttr = this._sideGeometry.attributes.uv;
            if (sideAttr) {
                const sideUVs = sideAttr.array;
                const vH = this._height / patternScale;
                let cum = 0;
                const edgeCount = this._sideEdgeLengths.length;
                for (let k = 0; k < edgeCount; k++) {
                    const edgeLen = this._sideEdgeLengths[k];
                    const base = k * 8;
                    const u0 = cum / patternScale;
                    const u1 = (cum + edgeLen) / patternScale;
                    sideUVs[base + 0] = u0;
                    sideUVs[base + 1] = vH;
                    sideUVs[base + 2] = u0;
                    sideUVs[base + 3] = 0;
                    sideUVs[base + 4] = u1;
                    sideUVs[base + 5] = vH;
                    sideUVs[base + 6] = u1;
                    sideUVs[base + 7] = 0;
                    cum += edgeLen;
                }
                sideAttr.needsUpdate = true;
            }
            this._builtSideHeight = this._height;
        }
    },
    _createSurfaceMaterial() {
        const hasOpacityAnim = !!(this._zoomInterpolations?.fillOpacity &&
            this._zoomInterpolations.fillOpacity.length >= 2);
        const isTransparent = hasOpacityAnim || this._fillOpacity < 1;
        const map = this._fillPatternTexture;
        const patternProps = map ? { map } : {};
        let mat;
        if (this._extruded) {
            mat = new THREE.MeshStandardMaterial({
                color: this._fillColor, opacity: this._fillOpacity,
                transparent: isTransparent, side: THREE.FrontSide,
                roughness: this._roughness, metalness: this._metalness,
                depthTest: this._depthTest, depthWrite: this._depthWrite,
                polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1,
                ...patternProps,
            });
        }
        else {
            mat = new THREE.MeshBasicMaterial({
                color: this._fillColor, opacity: this._fillOpacity,
                transparent: isTransparent, side: THREE.FrontSide,
                depthTest: this._depthTest, depthWrite: this._depthWrite,
                polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1,
                ...patternProps,
            });
        }
        applyGapMaskToMaterial(mat, this._map);
        return mat;
    },
    _applyShadowFlags(mesh) {
        if (!mesh)
            return;
        if (this._extruded) {
            mesh.castShadow = this._castShadow;
            mesh.receiveShadow = this._receiveShadow;
        }
        else {
            mesh.castShadow = false;
            mesh.receiveShadow = false;
        }
    },
    _hasAntimeridianWrap() {
        const crs = this._crs;
        if (!crs || !this._rings)
            return false;
        const toLonLat = (pt) => {
            const nn = this._normalizeCoord(pt, crs);
            if (nn.lonLat)
                return nn.lonLat;
            try {
                return crs.toLonLat(nn.coord);
            }
            catch {
                return null;
            }
        };
        for (const ring of this._rings) {
            if (!ring || ring.length < 2)
                continue;
            const lonLats = ring.map(toLonLat);
            for (let i = 0; i < lonLats.length; i++) {
                const a = lonLats[i];
                const b = lonLats[(i + 1) % lonLats.length];
                if (!a || !b)
                    continue;
                if (Math.abs(b[0] - a[0]) > 180)
                    return true;
            }
        }
        return false;
    },
    _isGeometryInvalid(ringStartIndices, worldSize) {
        const maxEdge = worldSize / INVALID_EDGE_FRACTION;
        const maxEdgeSq = maxEdge * maxEdge;
        const wc = this._worldCoords;
        for (let ringIdx = 0; ringIdx < ringStartIndices.length; ringIdx++) {
            const start = ringStartIndices[ringIdx];
            if (start === undefined)
                continue;
            const nextStart = (ringIdx + 1 < ringStartIndices.length)
                ? ringStartIndices[ringIdx + 1] : wc.length;
            const count = nextStart - start;
            if (count < 2)
                continue;
            for (let i = 0; i < count; i++) {
                const a = wc[start + i];
                const b = wc[start + ((i + 1) % count)];
                if (!a || !b)
                    continue;
                const dx = b[0] - a[0], dz = b[1] - a[1];
                if (dx * dx + dz * dz > maxEdgeSq)
                    return true;
            }
        }
        return false;
    },
    _triangulateFromRings() {
        const wc = this._worldCoords;
        const rs = this._ringStartIndices;
        if (!wc.length || !rs.length)
            return [];
        // Триангуляция — в lon/lat (как в _buildFillGeometry): мировые (x,z)
        // сферы склеивают переднюю и заднюю стороны. Откат — мировые (x,z).
        const vll = this._vertexLonLat;
        const coords = [];
        const holeIndices = [];
        for (let r = 0; r < rs.length; r++) {
            const start = rs[r];
            const end = (r + 1 < rs.length) ? rs[r + 1] : wc.length;
            if (r > 0)
                holeIndices.push(coords.length / 2);
            for (let i = start; i < end; i++) {
                const ll = vll?.[i];
                if (ll)
                    coords.push(ll[0], ll[1]);
                else
                    coords.push(wc[i][0], wc[i][1]);
            }
        }
        if (coords.length < 6)
            return [];
        const contourCount = Math.min(this._contourVertexCount || wc.length, wc.length);
        const isGlobeMap = this._map?.globe === true;
        const useEarcut = isGlobeMap || this._isPolarOrWrapping();
        // Полярные/разорванные кольца — азимутальная проекция (см. _buildFillGeometry).
        let planeCenter = null;
        let planeCoords = coords;
        if (isGlobeMap && this._isPolarOrWrapping()) {
            planeCenter = sphericalCentroidLonLat(this._vertexLonLat.slice(0, contourCount).filter((p) => !!p));
            planeCoords = [];
            for (let i = 0; i < coords.length; i += 2) {
                const [px, py] = azimuthalEquidistant(coords[i], coords[i + 1], planeCenter[0], planeCenter[1]);
                planeCoords.push(px, py);
            }
        }
        let indices = useEarcut
            ? triangulatePolygonEarcut(planeCoords, holeIndices)
            : triangulatePolygonCDT(coords, holeIndices, contourCount);
        if (isGlobeMap)
            indices = filterNearDegenerateTriangles(planeCoords, indices);
        if (!indices.length)
            return [];
        if (isGlobeMap) {
            indices = this._subdivideGlobeTriangles(indices, this._vertexLonLat, contourCount, holeIndices, subdivideStepRadFor(this._vertexLonLat), planeCenter);
            if (DECIMATE_INTERIOR) {
                const flat = [];
                for (const w of this._worldCoords)
                    flat.push(w[0], w[1]);
                const sphere = this._sphereVerticesFor(this._vertexLonLat);
                const dec = decimateContourAndRetriangulate(flat, holeIndices, sphere, DECIMATE_TOLERANCE_DEG * Math.PI / 180);
                if (dec.indices.length)
                    indices = dec.indices.map(i => dec.keep[i]);
            }
        }
        const p2d = new Array(this._worldCoords.length);
        for (let i = 0; i < this._worldCoords.length; i++) {
            p2d[i] = { x: this._worldCoords[i][0], y: this._worldCoords[i][1] };
        }
        const firstCrossY = crossY(p2d[indices[0]], p2d[indices[1]], p2d[indices[2]]);
        return firstCrossY >= 0 ? indices : flipIndices(indices);
    },
    _buildFillGeometry(map) {
        this._cachedTopIndices = null;
        const rings = this._getRenderRings(this._currentSimplifyBucket);
        if (!rings || !rings.length || rings[0].worldCoords.length < 3) {
            console.warn('Polygon: rings[0] must have at least 3 points');
            return;
        }
        this._worldCoords.length = 0;
        this._nodeHeights.length = 0;
        this._vertexLonLat.length = 0;
        this._ringStartIndices.length = 0;
        this._sideEdgeIJ.length = 0;
        this._sideEdgeLengths.length = 0;
        this._builtSideHeight = -1;
        this._avgNodeHeightValid = false;
        this._boundsCache.clear();
        const coords = [];
        const triCoords = [];
        const points2D = [];
        const holeIndices = [];
        const ringStartIndices = [];
        for (let ringIdx = 0; ringIdx < rings.length; ringIdx++) {
            const { worldCoords, heights, lonLats } = rings[ringIdx];
            if (worldCoords.length < 3) {
                console.warn(`Polygon: hole ring ${ringIdx} must have at least 3 points`);
                continue;
            }
            ringStartIndices.push(points2D.length);
            this._ringStartIndices.push(points2D.length);
            if (ringIdx > 0)
                holeIndices.push(coords.length / 2);
            let firstPoint = null;
            for (let i = 0; i < worldCoords.length; i++) {
                const [absX, absZ] = worldCoords[i];
                if (i === 0)
                    firstPoint = [absX, absZ];
                if (i > 0 && firstPoint && absX === firstPoint[0] && absZ === firstPoint[1])
                    continue;
                coords.push(absX, absZ);
                points2D.push(new THREE.Vector2(absX, absZ));
                // Триангуляция — в lon/lat (развёртка), а не в мировых (x,z):
                // мировые координаты сферы склеивают переднюю и заднюю стороны.
                const ll = lonLats ? lonLats[i] : null;
                triCoords.push(ll ? ll[0] : absX, ll ? ll[1] : absZ);
                this._worldCoords.push([absX, absZ]);
                this._nodeHeights.push(heights[i] ?? 0);
                // Геодезические координаты вершины — на глобусе по ним
                // вершина кладётся на эллипсоид (а не в плоскость).
                this._vertexLonLat.push(lonLats ? (lonLats[i] ?? null) : null);
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
        // Constrained Delaunay (cdt2d): контуры — constraints, поэтому полигон
        // на глобусе не срезается хордами; дыры вырезаются корректно.
        // Число вершин контуров — зафиксировано ДО добавления Steiner.
        const contourCount = points2D.length;
        this._contourVertexCount = contourCount;
        // Контуры уже денсифицированы с шагом 0.25° на глобусе. Earcut
        // триангулирует их за миллисекунды, тогда как CDT+Steiner блокирует
        // главный поток на 5–10 секунд для 89 субъектов. На коротких рёбрах
        // денсифицированного контура хорда не даёт заметного среза.
        // Steiner/CDT оставляем только для плоского режима и особых разрывов.
        const isGlobe = map.globe === true && !!map.surface;
        const useEarcut = isGlobe || this._isPolarOrWrapping();
        const steiner = useEarcut
            ? { world: [], lonLat: [] }
            : this._globeSteinerPoints();
        for (let k = 0; k < steiner.world.length; k++) {
            const [sx, sz] = steiner.world[k];
            const ll = steiner.lonLat[k];
            coords.push(sx, sz);
            triCoords.push(ll[0], ll[1]);
            points2D.push(new THREE.Vector2(sx, sz));
            this._worldCoords.push([sx, sz]);
            this._nodeHeights.push(0);
            this._vertexLonLat.push(ll);
        }
        // lon/lat-развёртка разрывна у антимеридиана и полюса (Марокко, Чили,
        // Антарктида): CDT там может вернуть пусто. Тогда пробуем мировые (x,z).
        let indices;
        if (useEarcut) {
            // Полярные/разорванные кольца: lon/lat-развёртка разрывна (скачок ±180°,
            // полюс внутри контура). Триангулируем в азимутальной равнодистантной
            // проекции с центром в сферическом центроиде кольца — она непрерывна
            // через антимеридиан и полюс.
            const usePolarPlane = isGlobe && this._isPolarOrWrapping();
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
            if (isGlobe)
                indices = filterNearDegenerateTriangles(planeCoords, indices);
            // После earcut разбиваем крупные globe-треугольники по поверхности;
            // 2° — компромисс между кривизной и количеством вершин.
            if (indices.length && isGlobe) {
                indices = this._subdivideGlobeTriangles(indices, this._vertexLonLat, contourCount, holeIndices, subdivideStepRadFor(this._vertexLonLat), planeCenter);
                // arrays may have grown; regenerate points2D from updated world coords
                points2D.length = 0;
                for (const [x, z] of this._worldCoords)
                    points2D.push(new THREE.Vector2(x, z));
            }
        }
        else {
            indices = triangulatePolygonCDT(triCoords, holeIndices, contourCount);
        }
        if (indices.length === 0) {
            console.warn('Polygon: triangulation returned no triangles');
            return;
        }
        // Децимация внутренних вершин (внешний контур не трогаем). Работаем в
        // плоских координатах, которые совпадают с проекцией earcut.
        if (isGlobe && DECIMATE_INTERIOR) {
            const flat = [];
            for (const pt of points2D)
                flat.push(pt.x, pt.y);
            const sphere = this._sphereVerticesFor(this._vertexLonLat);
            // Заливка перестраивается по выжившим контурным точкам. Стенки и
            // _ringStartIndices остаются по полному контуру (см. комментарий).
            const dec = decimateContourAndRetriangulate(flat, holeIndices, sphere, DECIMATE_TOLERANCE_DEG * Math.PI / 180);
            if (dec.indices.length) {
                indices = dec.indices.map(i => dec.keep[i]);
            }
        }
        const firstCrossY = crossY(points2D[indices[0]], points2D[indices[1]], points2D[indices[2]]);
        const topIndices = firstCrossY >= 0 ? indices : flipIndices(indices);
        const bottomIndices = flipIndices(topIndices);
        this._cachedTopIndices = topIndices;
        let cx, cy;
        if (!this._centroidFromOriginal) {
            const fullRings = this._getFullRenderRings();
            const srcRings = fullRings.map(r => r.worldCoords);
            const vc = approxVisualCenter(srcRings, 0);
            if (vc)
                this._centroidFromOriginal = { x: vc[0], z: vc[1] };
            else {
                let sx = 0, sy = 0, cnt = 0;
                for (const r of srcRings)
                    for (const p of r) {
                        sx += p[0];
                        sy += p[1];
                        cnt++;
                    }
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
            if (rSq > maxRadiusSq)
                maxRadiusSq = rSq;
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
            topUVs[i * 2] = (wx - uvParams.originX) / uvParams.scaleX;
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
        for (let i = 0; i < points2D.length; i++)
            topNormals[i * 3 + 1] = 1;
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
    _buildBottomAndSides(points2D, topUVs, bottomIndices, patternScale) {
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
        for (let i = 0; i < points2D.length; i++)
            bottomNormals[i * 3 + 1] = -1;
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
            if (count < 2)
                continue;
            totalEdges += count;
        }
        const sidePositions = new Float32Array(totalEdges * 4 * 3);
        const sideUVs = new Float32Array(totalEdges * 4 * 2);
        const sideIndices = new Uint32Array(totalEdges * 6);
        let posK = 0, uvK = 0, idxK = 0, vertBase = 0;
        for (let ringIdx = 0; ringIdx < this._ringStartIndices.length; ringIdx++) {
            const start = this._ringStartIndices[ringIdx];
            const nextRingStart = (ringIdx + 1 < this._ringStartIndices.length)
                ? this._ringStartIndices[ringIdx + 1] : points2D.length;
            const count = nextRingStart - start;
            if (count < 2)
                continue;
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
                sidePositions[posK++] = topI.x;
                sidePositions[posK++] = initialHeight;
                sidePositions[posK++] = topI.y;
                sidePositions[posK++] = topI.x;
                sidePositions[posK++] = 0;
                sidePositions[posK++] = topI.y;
                sidePositions[posK++] = topJ.x;
                sidePositions[posK++] = initialHeight;
                sidePositions[posK++] = topJ.y;
                sidePositions[posK++] = topJ.x;
                sidePositions[posK++] = 0;
                sidePositions[posK++] = topJ.y;
                const ddx = topJ.x - topI.x;
                const ddz = topJ.y - topI.y;
                const edgeLen = Math.sqrt(ddx * ddx + ddz * ddz);
                const u0 = cum / sideUvScale;
                const u1 = (cum + edgeLen) / sideUvScale;
                sideUVs[uvK++] = u0;
                sideUVs[uvK++] = vH;
                sideUVs[uvK++] = u0;
                sideUVs[uvK++] = 0;
                sideUVs[uvK++] = u1;
                sideUVs[uvK++] = vH;
                sideUVs[uvK++] = u1;
                sideUVs[uvK++] = 0;
                if (!flipSides) {
                    sideIndices[idxK++] = vertBase;
                    sideIndices[idxK++] = vertBase + 1;
                    sideIndices[idxK++] = vertBase + 2;
                    sideIndices[idxK++] = vertBase + 1;
                    sideIndices[idxK++] = vertBase + 3;
                    sideIndices[idxK++] = vertBase + 2;
                }
                else {
                    sideIndices[idxK++] = vertBase;
                    sideIndices[idxK++] = vertBase + 2;
                    sideIndices[idxK++] = vertBase + 1;
                    sideIndices[idxK++] = vertBase + 1;
                    sideIndices[idxK++] = vertBase + 2;
                    sideIndices[idxK++] = vertBase + 3;
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
    _buildStrokeGeometry(map) {
        if (this._invalidGeometry)
            return;
        if (this._strokeWidth <= 0 || this._strokeOpacity <= 0)
            return;
        const canvas = map.renderer.domElement;
        const rings = this._getRenderRings(this._currentSimplifyBucket);
        const outer = rings[0];
        if (!outer)
            return;
        const { worldCoords: outerWC, heights: outerH, lonLats: outerLL } = outer;
        this._strokeWorldCoords.length = 0;
        this._strokeNodeHeights.length = 0;
        this._strokeVertexLonLat.length = 0;
        let firstStrokePoint = null;
        for (let i = 0; i < outerWC.length; i++) {
            const [absX, absZ] = outerWC[i];
            if (i === 0)
                firstStrokePoint = [absX, absZ];
            else if (firstStrokePoint && absX === firstStrokePoint[0] && absZ === firstStrokePoint[1])
                continue;
            this._strokeWorldCoords.push([absX, absZ]);
            this._strokeNodeHeights.push(outerH[i] ?? 0);
            // Геодезические координаты — чтобы обводка легла на эллипсоид (глобус).
            this._strokeVertexLonLat.push(outerLL ? (outerLL[i] ?? null) : null);
        }
        this._cachedStrokeHeights = new Array(this._strokeWorldCoords.length).fill(0);
        if (this._useSimpleStroke) {
            const positions = [];
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
            applyGapMaskToMaterial(lineMaterial, this._map); // ← добавили
            const line = new THREE.Line(lineGeometry, lineMaterial);
            line.renderOrder = POLYGON_RENDER_ORDER.STROKE;
            this._strokeLine = line;
            this._strokeGeometry = lineGeometry;
            this._strokeMaterial = lineMaterial;
            this._group.add(line);
        }
        else {
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
            applyGapMaskToMaterial(this._strokeMaterial, this._map); // ← добавили
            const line = new Line2(this._strokeGeometry, this._strokeMaterial);
            line.renderOrder = POLYGON_RENDER_ORDER.STROKE;
            this._strokeLine = line;
            this._group.add(line);
        }
    },
};
