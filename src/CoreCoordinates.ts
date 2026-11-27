// CoreCoordinates.ts
import { THREE } from './js_TP/tpb.js';
import { Projections } from './Projections.js';
import type { KrbMap } from './Core.js';
import { assetUrl } from './assets.js';

// ── Temp-объекты для проверки перекрытия глобусом (без аллокаций на кадр) ──
const _occPoint = new THREE.Vector3();
const _occCam = new THREE.Vector3();
const _occDir = new THREE.Vector3();
const _occHit = new THREE.Vector3();
const _occRay: any = new THREE.Raycaster();

export interface CoreCoordinatesMethods {
    _resolveViewCenter(): void;
    project(coord: number[], fromCrs?: any): number[];
    projectSafe(coord: number[], fromCrs?: any): number[] | null;
    unproject(worldCoord: number[], toCrs?: any): number[];
    projectLonLat(lon: number, lat: number): [number, number];
    unprojectToLonLat(x: number, z: number): [number, number];
    worldToTileIndex(worldX: number, worldZ: number, z: number, crs?: any): number[];
    tileIndexToWorld(tx: number, ty: number, z: number, crs?: any): number[];
    _layerCrsOrProjection(): any;
    _wrapsLongitude(): boolean;
    getTextureUrl(layer: any, z: number, x: number, y: number): string | null;
    getElevationUrl(layer: any, z: number, x: number, y: number): string | null;
    getTileZoom(layer: any): number;
    get zoomOffset(): number;
    set zoomOffset(v: number);
    readonly maxObjectDistance: number;
    readonly tileZoom: number;
    unprojectToLonLatSafe(x: number, z: number): [number, number] | null;
    /**
     * Точка поверхности в МИРОВЫХ координатах сцены (как `worldGroup`),
     * с учётом режима: на плоскости — (x, y, z) плоского мира,
     * на глобусе — точка эллипсоида (ECEF-подобные world-оси).
     * `height` — высота над поверхностью вдоль местной нормали.
     */
    projectSurfacePoint(coord: number[], fromCrs: any, height: number, out: any, origin?: any): any | null;
    _planarHeightScale(coord: number[], fromCrs?: any): number;
    /** Обратное к projectSurfacePoint: мировые координаты → [lon, lat]. */
    surfacePointToLonLat(worldPoint: any): [number, number] | null;
    /** Мировые координаты → точка под ними у поверхности (для hit-тестов). */
    _surfacePointIntoWorld(local: any, out: any): any;
    /**
     * Скрыта ли точка глобусом от камеры (за горизонтом / на обратной
     * стороне). На плоскости всегда `false`.
     */
    isWorldPointOccluded(worldPoint: any): boolean;
    /**
     * Вершина объекта в ЛОКАЛЬНЫХ координатах его группы (вокруг origin):
     * на плоскости — (dx, height, dz), как раньше;
     * на глобусе — точка эллипсоида ОТНОСИТЕЛЬНО origin группы, умноженная
     * на высоту вдоль местной нормали. Именно это «кладёт» геометрию на шар:
     * у каждой вершины своя высота Y и свои X/Z.
     */
    projectSurfaceVertex(coord: number[], fromCrs: any, height: number,
        origin: any, out: any): any | null;
}

export const CoreCoordinatesMixin: CoreCoordinatesMethods & ThisType<KrbMap> = {

/**
 * Перевод (coord в произвольной СК, высота) → мировая точка сцены.
 *
 * Плоский режим — (x, height, z) ПЛЮС сдвиг worldGroup (карта панорамируется
 * сдвигом группы), т.е. реальная мировая позиция.
 * Глобус — точка эллипсоида через GlobeSurface.position, высота идёт вдоль
 * геодезической нормали.
 *
 * `origin` — если задан, из результата вычитается он (для объектов,
 * лежащих ВНУТРИ worldGroup: их локальные координаты не должны включать
 * сдвиг мира).
 */
/**
 * Масштаб высоты относительно горизонтали на плоской карте: 1/cos(lat) для Меркатора,
 * иначе 1. Нужен, чтобы высоты в истинных метрах совпадали по виду с горизонталью.
 */
_planarHeightScale(coord, fromCrs) {
    if (!this.projection || !this.projection.isMercator) return 1;
    const src = fromCrs ? (typeof fromCrs === 'string' ? Projections.getRaw(fromCrs) : fromCrs) : this.inputCRS;
    const ll = src && typeof src.toLonLat === 'function' ? src.toLonLat(coord) : null;
    if (!ll || !Number.isFinite(ll[1])) return 1;
    const c = Math.cos(ll[1] * Math.PI / 180);
    if (!(c > 1e-6)) return 1;
    return 1 / c;
},

projectSurfacePoint(coord, fromCrs, height, out, origin?) {
    const h = Number.isFinite(height) ? height : 0;
    const originX = origin ? origin.x : 0;
    const originY = origin ? origin.y : 0;
    const originZ = origin ? origin.z : 0;

    if (!this.globe || !this.surface) {
        const [x, z] = this.project(coord, fromCrs ?? this.inputCRS);
        if (!Number.isFinite(x) || !Number.isFinite(z)) return null;
        // ПЛОСКИЙ режим: карта живёт в worldGroup, который панорамируется.
        const wg = this.worldGroup ? this.worldGroup.position : null;
        // Масштаб высоты (1/cos(lat) для Меркатора) здесь НЕ применяется: объекты сами
        // масштабируют свою геометрию по высоте (см. Area3D._createPrimitive). Иначе высота
        // центра объекта и его геометрия масштабировались бы дважды.
        return out.set(
            x + (wg ? wg.x : 0) - originX,
            h + (wg ? wg.y : 0) - originY,
            z + (wg ? wg.z : 0) - originZ,
        );
    }
    // На глобусе: любую координату приводим к lon/lat и кладём на эллипсоид.
    const crs = fromCrs
        ? (typeof fromCrs === 'string' ? Projections.get(fromCrs) : fromCrs)
        : null;
    const lonLat = crs && crs !== this.projection ? crs.toLonLat(coord) : coord;
    if (!lonLat || !Number.isFinite(lonLat[0]) || !Number.isFinite(lonLat[1])) return null;
    this.surface.position(lonLat[0], lonLat[1], h, out);
    if (this.worldGroup) this.worldGroup.localToWorld(out);
    return out;
},

/** Мировые координаты сцены → [lon, lat] (обратное к projectSurfacePoint). */
surfacePointToLonLat(worldPoint) {
    if (!worldPoint) return null;
    if (this.globe && this.surface) {
        const loc = worldPoint.clone ? worldPoint.clone() : { x: worldPoint.x, y: worldPoint.y, z: worldPoint.z };
        if (this.worldGroup) this.worldGroup.worldToLocal(loc);
        const g = this.surface.geodeticFromWorld(loc);
        if (!g || !Number.isFinite(g.lon) || !Number.isFinite(g.lat)) return null;
        return [g.lon, g.lat];
    }
    return this.unprojectToLonLatSafe(
        worldPoint.x - this.worldGroup.position.x,
        worldPoint.z - this.worldGroup.position.z,
    );
},

/** Локальная (worldGroup) точка → мировая (на глобусе — без сдвига мира). */
_surfacePointIntoWorld(local, out) {
    out.copy(local);
    if (this.worldGroup) this.worldGroup.localToWorld(out);
    return out;
},

/**
 * Вершина объекта в локальных координатах его группы.
 *
 * Плоский режим: (x − originX, height, z − originZ) — прежнее поведение.
 * Глобус: точка поверхности + смещение на height вдоль МЕСТНОЙ нормали,
 * минус origin. Из-за этого Y у каждой вершины свой — геометрия реально
 * облегает сферу, а не лежит в плоскости.
 */
projectSurfaceVertex(coord, fromCrs, height, origin, out) {
    const h = Number.isFinite(height) ? height : 0;
    const originX = origin ? origin.x : 0;
    const originY = origin ? origin.y : 0;
    const originZ = origin ? origin.z : 0;

    // Обе ветки — через projectSurfacePoint, чтобы сдвиг мира
    // (worldGroup.position) учитывался одинаково.
    const wp = this.projectSurfacePoint(coord, fromCrs, h, _occDir);
    if (!wp) return null;
    return out.set(wp.x - originX, wp.y - originY, wp.z - originZ);
},

/**
 * Точка на обратной стороне глобуса?
 *
 * Проверка по «горизонту»: точка видна, пока направление на неё не уходит
 * за касательную к эллипсоиду. Для камеры на расстоянии C от центра и
 * точки на радиусе r условие видимости: cos θ > R / C, где θ — угол между
 * «центр→камера» и «центр→точка», R — минимальный радиус эллипсоида.
 * Чем выше точка над поверхностью (r > R), тем шире её собственный
 * горизонт — учитываем множителем R/r.
 * На плоскости горизонтного ограничения нет — всегда `false`.
 */
isWorldPointOccluded(worldPoint) {
    if (!this.globe || !this.surface || !worldPoint) return false;

    // Работаем в локальных координатах глобуса (центр — в нуле).
    const loc = THREE.Vector3.prototype.copy.call(_occPoint, worldPoint);
    if (this.worldGroup) this.worldGroup.worldToLocal(loc);
    const camLocal = THREE.Vector3.prototype.copy.call(_occCam, this.camera.position);
    if (this.worldGroup) this.worldGroup.worldToLocal(camLocal);

    const camDist = camLocal.length();
    const ptDist = loc.length();
    if (!(camDist > 1e-6) || !(ptDist > 1e-6)) return false;

    const R = this.surface.b ?? this.R;
    // Косинус угла «центр→камера» / «центр→точка».
    const cos = (loc.x * camLocal.x + loc.y * camLocal.y + loc.z * camLocal.z)
        / (ptDist * camDist);
    // Точка на поверхности (r ≈ R): видна, если cos > R/C.
    // Поднятая над поверхностью (r > R) — чуть «за» горизонтом тоже видна,
    // поэтому порог домножаем на R/r.
    const rRatio = Math.min(1, R / ptDist);
    return cos < (R / camDist) * rRatio;
},

unprojectToLonLatSafe(x, z) {
    const coord = [x, -z];
    const raw   = this.projection?._raw ?? this.projection;   // на случай ScaledProjection без делегата
    const out   = typeof raw?.toLonLatSafe === 'function'
        ? raw.toLonLatSafe(coord)
        : raw?.toLonLat(coord);
    if (!out || !Number.isFinite(out[0]) || !Number.isFinite(out[1])) return null;
    if (Math.abs(out[0]) > 180.0001 || Math.abs(out[1]) > 90.0001) return null;
    return [out[0], out[1]];
},


_resolveViewCenter() {
    const v = this.view;
    const mapCode = this.projection.code;      // строковый код (raw === world)

    // 1) Явно задан lon/lat — самый приоритетный путь.
    if (v.centerLonLat) {
        const [x, y] = this.projection.fromLonLat(v.centerLonLat); // world
        v.center = [x, -y];
        v.projection = mapCode;
        return;
    }

    // 2) v.center задан в v.projection (по умолчанию — mapCode).
    //    Трактуем его как RAW-координаты и переводим в world map-CRS.
    const srcCode = v.projection ?? mapCode;
    const srcRaw = typeof srcCode === 'string'
        ? Projections.getRaw(srcCode)
        : srcCode;

    const lonLat = srcRaw.toLonLat([v.center[0], -v.center[1]]);
    const [x, y] = this.projection.fromLonLat(lonLat);         // world

    v.centerLonLat = lonLat;         // фиксируем «канонический» вид
    v.center = [x, -y];
    v.projection = mapCode;

    if (srcCode !== mapCode) {
        console.warn(`KrbMap: view.center пересчитан из ${srcCode} в ${mapCode}. ` +
            `Если view.center уже был в ${mapCode}, укажите view.projection = '${mapCode}'.`);
    }
},

    project(coord, fromCrs = this.inputCRS) {
        const src = typeof fromCrs === 'string' ? Projections.get(fromCrs) : fromCrs;
        if (src === this.projection) return [coord[0], -coord[1]];
        const lonLat = src.toLonLat(coord);
        const [x, y] = this.projection.fromLonLat(lonLat);
        return [x, -y];
    },

    projectSafe(coord, fromCrs = this.inputCRS) {
        if (!coord || coord.length < 2) return null;
        if (!Number.isFinite(coord[0]) || !Number.isFinite(coord[1])) return null;
        const src = typeof fromCrs === 'string' ? Projections.get(fromCrs) : fromCrs;
        if (src === this.projection) return [coord[0], -coord[1]];
        const lonLat = typeof src.toLonLatSafe === 'function' ? src.toLonLatSafe(coord) : src.toLonLat(coord);
        if (!lonLat || !Number.isFinite(lonLat[0]) || !Number.isFinite(lonLat[1])) return null;
        const proj = typeof this.projection.fromLonLatSafe === 'function'
            ? this.projection.fromLonLatSafe(lonLat)
            : this.projection.fromLonLat(lonLat);
        if (!proj || !Number.isFinite(proj[0]) || !Number.isFinite(proj[1])) return null;
        return [proj[0], -proj[1]];
    },

    unproject(worldCoord, toCrs = this.inputCRS) {
        const dst = typeof toCrs === 'string' ? Projections.get(toCrs) : toCrs;
        const std = [worldCoord[0], -worldCoord[1]];
        if (dst === this.projection) return std;
        const lonLat = this.projection.toLonLat(std);
        return dst.fromLonLat(lonLat);
    },

    projectLonLat(lon, lat) {
        const [x, y] = this.projection.fromLonLat([lon, lat]);
        return [x, -y];
    },

    unprojectToLonLat(x, z) {
        return this.projection.toLonLat([x, -z]);
    },

worldToTileIndex(worldX, worldZ, z, crs = null) {
    const useCrs = crs
        ? (typeof crs === 'string' ? Projections.get(crs) : crs)
        : this._layerCrsOrProjection();

    const isLinear = useCrs === this.projection && this.projection.isMercator;
    const lx = worldX - this.worldGroup.position.x;
    const lz = worldZ - this.worldGroup.position.z;
    const n = 1 << z;

    if (isLinear) {
        // map-local coords → tile indices. map === tileCRS, поэтому
        // используем map-экстенты (они совпадают с tile-экстентами).
        const halfX = this.mapHalfExtentX;
        const halfY = this.mapHalfExtentY;
        const tileSizeX = (2 * halfX) / n;
        const tileSizeY = (2 * halfY) / n;
        return [(lx + halfX) / tileSizeX, (lz + halfY) / tileSizeY];
    }

    const lonLat = this.unprojectToLonLat(lx, lz);
    if (!lonLat || !Number.isFinite(lonLat[0]) || !Number.isFinite(lonLat[1])) return [NaN, NaN];
    if (Math.abs(lonLat[0]) > 180.0001 || Math.abs(lonLat[1]) > 90.0001) return [NaN, NaN];

    const tileWorld = typeof useCrs.fromLonLatSafe === 'function'
        ? useCrs.fromLonLatSafe(lonLat)
        : useCrs.fromLonLat(lonLat);
    if (!tileWorld || !Number.isFinite(tileWorld[0]) || !Number.isFinite(tileWorld[1])) return [NaN, NaN];

    const halfX = useCrs.halfExtentX;
    const halfY = useCrs.halfExtentY;
    return [
        ((tileWorld[0] + halfX) / (2 * halfX)) * n,
        ((halfY - tileWorld[1]) / (2 * halfY)) * n,
    ];
},

tileIndexToWorld(tx, ty, z, crs = null) {
    const useCrs = crs
        ? (typeof crs === 'string' ? Projections.get(crs) : crs)
        : this._layerCrsOrProjection();

    const isLinear = useCrs === this.projection && this.projection.isMercator;
    const n = 1 << z;

    if (isLinear) {
        const halfX = this.mapHalfExtentX;
        const halfY = this.mapHalfExtentY;
        const tileSizeX = (2 * halfX) / n;
        const tileSizeY = (2 * halfY) / n;
        return [
            tx * tileSizeX - halfX + this.worldGroup.position.x,
            ty * tileSizeY - halfY + this.worldGroup.position.z,
        ];
    }

    const halfX = useCrs.halfExtentX;
    const halfY = useCrs.halfExtentY;
    const tileWorldX = (tx / n) * 2 * halfX - halfX;
    const tileWorldY = halfY - (ty / n) * 2 * halfY;

    const lonLat = useCrs.toLonLat([tileWorldX, tileWorldY]);
    if (!lonLat || !Number.isFinite(lonLat[0]) || !Number.isFinite(lonLat[1])) return [NaN, NaN];

    const proj = typeof this.projection.fromLonLatSafe === 'function'
        ? this.projection.fromLonLatSafe(lonLat)
        : this.projection.fromLonLat(lonLat);
    if (!proj || !Number.isFinite(proj[0]) || !Number.isFinite(proj[1])) return [NaN, NaN];

    return [proj[0] + this.worldGroup.position.x, -proj[1] + this.worldGroup.position.z];
},

    _layerCrsOrProjection() {
        const layer = this._tileLayer;
        if (!layer) return this.projection;
        const code = layer.crs ?? layer.projection ?? 'EPSG:3857';
        return typeof code === 'string' ? Projections.get(code) : code;
    },

_wrapsLongitude() {
    const proj = this.projection;
    if (proj?.wrapsLongitude === true)       return true;
    if (proj?._raw?.wrapsLongitude === true) return true;   // ScaledProjection без делегата
    const def = proj?.def || '';
    return /\+proj=merc\b/.test(def) || /\+proj=longlat\b/.test(def);
},

    getTextureUrl(layer, z, x, y) {
        if (!layer || !layer.texture) return null;
        if (layer.texture === 'demo') {
            const n = 1 + Math.floor(Math.random() * 24);
            return assetUrl(`demotiles/${n}.webp`);
        }
        return layer.texture.replace(/\{z\}/g, z).replace(/\{x\}/g, x).replace(/\{y\}/g, y);
    },

    getElevationUrl(layer, z, x, y) {
        const elevLayer = (layer && layer.elevation) ? layer : this._elevationLayer;
        if (!elevLayer || !elevLayer.elevation) return null;
        if (elevLayer.elevation === 'demo') return null;
        return elevLayer.elevation.replace(/\{z\}/g, z).replace(/\{x\}/g, x).replace(/\{y\}/g, y);
    },

    getTileZoom(layer) {
        const z = this.currentDiscreteZoom + (layer?.zoomOffset ?? 0);
        const min = layer?.minNativeZoom ?? this.MIN_ZOOM;
        const max = layer?.maxNativeZoom ?? this.MAX_ZOOM;
        return Math.max(min, Math.min(max, z));
    },

    get zoomOffset() {
        const z = this._tileLayer?.zoomOffset;
        return (z !== undefined && z !== null) ? z : this._defaultZoomOffset;
    },
    set zoomOffset(v) {
        if (this._tileLayer) this._tileLayer.zoomOffset = v;
        else this._defaultZoomOffset = v;
        if (this._disposed) return;
        if (this._surfaceMaxHeightCache) this._surfaceMaxHeightCache.clear();
        this.lastVisibleUpdateTime = 0;
        this.maybeUpdateVisibleTiles(true);
    },

    get maxObjectDistance() {
        if (!this.objectRenderDistanceFactor) return Infinity;
        // На глобусе множитель «×N от дистанции до цели» неприменим: точки
        // обратной стороны Земли по 3D ближе видимых, и такой отсечкой их
        // можно срезать неверно. Невидимое полушарие убирает
        // isWorldPointOccluded(), поэтому дальность не ограничиваем.
        if (this.globe) return Infinity;
        const distToTarget = this.camera.position.distanceTo(this.controls.target);
        return distToTarget * this.objectRenderDistanceFactor;
    },

    get tileZoom() {
        const layer = this._elevationLayer ?? this._tileLayer;
        if (!layer) return this.currentDiscreteZoom;
        return this.getTileZoom(layer);
    },
};

declare module './Core.js' {
    interface KrbMap extends CoreCoordinatesMethods {}
}