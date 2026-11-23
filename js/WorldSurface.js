// @ts-nocheck
// WorldSurface.ts
/**
 * WorldSurface — абстракция «поверхности мира» для движка.
 *
 * FlatSurface  — плоская карта: lon/lat → projection → плоскость XZ (y = h).
 * GlobeSurface — эллипсоид: lon/lat → ECEF → world.
 *
 * Маппинг осей ECEF → world (правосторонний, det = +1):
 *   world.x =  ECEF.X   (lon=0, lat=0)
 *   world.y =  ECEF.Z   (северный полюс — вверх, Y-up Three.js)
 *   world.z = -ECEF.Y   (долгота -90° → +z)
 *
 * World-единицы ≈ метры эллипсоида: калибровка движка
 * (halfExtent = 20037508 ≈ π·a) делает 1 м на экваторе ≈ 1 world unit,
 * поэтому a и b эллипсоида используются напрямую.
 */
import { THREE } from './js_TP/tpb.js';
import { geodeticToEcef, ecefToGeodetic, ELLIPSOIDS } from './Ellipsoid.js';
const DEG = Math.PI / 180;
const RAD = 180 / Math.PI;
// ── Модульные временные объекты (hot paths без аллокаций) ──
const _v1 = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _v3 = new THREE.Vector3();
const _v4 = new THREE.Vector3();
const _e1 = new THREE.Vector3();
const _e2 = new THREE.Vector3();
const _fn = new THREE.Vector3();
const _rayO = new THREE.Vector3();
const _rayD = new THREE.Vector3();
const _m4 = new THREE.Matrix4();
const _flatPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
const _occN = new THREE.Vector3(); // нормаль окклюдера (к камере)
// ============================================================
// FlatSurface — тонкая обёртка над текущим поведением.
// Сейчас используется только как заглушка контракта: плоский
// путь TileManager никуда не делегирует и работает как раньше.
// ============================================================
export class FlatSurface {
    constructor(projection) {
        this.projection = projection;
        this.ellipsoid = projection?.ellipsoid ?? ELLIPSOIDS.wgs84;
        this.isGlobe = false;
    }
    /** lon/lat/h → world (плоскость XZ, как везде в движке). */
    position(lon, lat, h, out) {
        const p = this.projection.fromLonLat([lon, lat]);
        return out.set(p[0], h || 0, -p[1]);
    }
    normal(lon, lat, out) { return out.set(0, 1, 0); }
    /** world-точка → { lon, lat, h }. */
    geodeticFromWorld(local, out = {}) {
        const ll = this.projection.toLonLat([local.x, -local.z]);
        out.lon = ll[0];
        out.lat = ll[1];
        out.h = local.y;
        return out;
    }
    /** Пересечение луча с плоскостью y=0. Возвращает out | null. */
    raycast(raycaster, out, worldGroup = null) {
        const hit = raycaster.ray.intersectPlane(_flatPlane, out);
        return hit ? out : null;
    }
    /** Плоский движок использует наследованный AABB-путь TileManager. */
    visibleTileRanges() { return null; }
    /** Окклюдера на плоскости нет. */
    createOccluder() { return null; }
    updateOccluder() { }
    buildTileGeometry() { return null; }
    applyHeights() { }
    isOccluded() { return false; }
}
// ============================================================
// GlobeSurface
// ============================================================
export class GlobeSurface {
    /**
     * @param projection — world-проекция карты (берём у неё эллипсоид:
     *   для WGS84-based crs — wgs84, для ГСК-2011 — gsk2011 и т.д.).
     * @param opts.ellipsoid — явный override эллипсоида.
     */
    constructor(projection, opts = {}) {
        this.projection = projection ?? null;
        this.ellipsoid = opts.ellipsoid ?? projection?.ellipsoid ?? ELLIPSOIDS.wgs84;
        this.isGlobe = true;
        this.a = this.ellipsoid.a;
        this.b = this.ellipsoid.b;
    }
    // ── Базовая геометрия ────────────────────────────────────
    /** lon/lat (градусы) + h (метры над эллипсоидом) → world-точка. */
    position(lon, lat, h, out) {
        const e = geodeticToEcef(lon, lat, h || 0, this.ellipsoid);
        return out.set(e.X, e.Z, -e.Y);
    }
    /** Геодезическая нормаль эллипсоида в world-осях (единичная). */
    normal(lon, lat, out) {
        const latR = lat * DEG, lonR = lon * DEG;
        const cosLat = Math.cos(latR);
        // ECEF-нормаль: (cosφ·cosλ, cosφ·sinλ, sinφ) — верна и для эллипсоида
        return out.set(cosLat * Math.cos(lonR), // x = X
        Math.sin(latR), // y = Z
        -cosLat * Math.sin(lonR));
    }
    /** Локальная world-точка (СК worldGroup) → { lon, lat, h }. */
    geodeticFromWorld(local, out = {}) {
        const g = ecefToGeodetic(local.x, -local.z, local.y, this.ellipsoid);
        out.lon = g.lon;
        out.lat = g.lat;
        out.h = g.h;
        return out;
    }
    /**
     * Пересечение луча с эллипсоидом.
     * @param raycaster — THREE.Raycaster в world-координатах сцены.
     * @param out — Vector3 для результата (world-координаты сцены).
     * @param worldGroup — если задан, учитывается его трансформ.
     * @returns out | null (луч мимо эллипсоида).
     */
    raycast(raycaster, out, worldGroup = null) {
        if (worldGroup) {
            _m4.copy(worldGroup.matrixWorld).invert();
            _rayO.copy(raycaster.ray.origin).applyMatrix4(_m4);
            _rayD.copy(raycaster.ray.direction).transformDirection(_m4);
        }
        else {
            _rayO.copy(raycaster.ray.origin);
            _rayD.copy(raycaster.ray.direction);
        }
        const ro = _rayO, rd = _rayD;
        const a = this.a, b = this.b;
        // Приводим эллипсоид к единичной сфере масштабом (1/a, 1/b, 1/a):
        const ox = ro.x / a, oy = ro.y / b, oz = ro.z / a;
        const dx = rd.x / a, dy = rd.y / b, dz = rd.z / a;
        const A = dx * dx + dy * dy + dz * dz;
        const B = 2 * (ox * dx + oy * dy + oz * dz);
        const C = ox * ox + oy * oy + oz * oz - 1;
        const D = B * B - 4 * A * C;
        if (D < 0 || A === 0)
            return null;
        const sq = Math.sqrt(D);
        let t = (-B - sq) / (2 * A);
        if (t < 0)
            t = (-B + sq) / (2 * A); // камера внутри — дальняя стенка
        if (t < 0)
            return null;
        out.copy(rd).multiplyScalar(t).add(ro); // локальная точка
        if (worldGroup)
            worldGroup.localToWorld(out);
        return out;
    }
    /**
     * Точка за горизонтом? (для culling'а объектов/подписей).
     * Сферическая аппроксимация с радиусом b (минимальным) — консервативна:
     * видимую точку никогда не отбросит.
     */
    isOccluded(pointWorld, camWorld, worldGroup = null) {
        const P = _v1.copy(pointWorld);
        const C = _v2.copy(camWorld);
        if (worldGroup) {
            worldGroup.worldToLocal(P);
            worldGroup.worldToLocal(C);
        }
        const cLen = C.length(), pLen = P.length();
        if (cLen < 1e-6 || pLen < 1e-9)
            return false;
        const cos = P.dot(C) / (pLen * cLen);
        return cos < (this.b / cLen) * 0.995; // 0.5% запас
    }
    // ── Видимость тайлов ─────────────────────────────────────
    /**
     * Диапазоны тайлов z-уровня, покрывающие видимый сферический сегмент.
     *
     * Вся видимая с камеры поверхность лежит в сферическом «колпаке»
     * радиуса γ = acos(R / |C|) вокруг подкамерной точки (горизонт —
     * окружность на угловом расстоянии ровно γ). Колпак переводим в
     * lon/lat-бокс стандартными формулами bounding box сферического
     * круга, затем — в тайловые индексы сетки tileCrs.
     * Антимеридиан → два диапазона.
     *
     * Консервативно (суперсет): используем R = b (минимальный радиус),
     * поэтому захватываем чуть больше — лишние тайлы безвредны
     * (отсекаются GPU-фрустумом и backface-culling'ом).
     *
     * @returns массив { xMin, xMax, yMin, yMax, cxTile, cyTile } | null
     */
    visibleTileRanges(camLocal, z, tileCrs, view = null) {
        const dist = camLocal.length();
        if (!Number.isFinite(dist) || dist < 1)
            return null;
        const geo = ecefToGeodetic(camLocal.x, -camLocal.z, camLocal.y, this.ellipsoid);
        if (!Number.isFinite(geo.lon) || !Number.isFinite(geo.lat))
            return null;
        const R = this.b; // минимальный радиус — консервативно
        let gamma = Math.acos(Math.min(1, R / dist)); // горизонт (как было)
        // ── NEW: дальше внешней образующей конуса взгляда ничего не видно ──
        if (view) {
            const { dir, fovY, aspect } = view; // dir — единичный forward в local СК
            _v1.copy(camLocal).divideScalar(dist); // n = подкамерное направление
            const cosA = Math.max(-1, Math.min(1, -_v1.dot(dir)));
            const alpha = Math.acos(cosA); // угол «взгляд ↔ вниз»
            const ty = Math.tan(fovY * DEG / 2);
            const theta = Math.atan(Math.hypot(ty, ty * aspect)); // half-diagonal FOV
            const psi = alpha + theta;
            if (psi < Math.PI / 2) {
                const s = dist * Math.sin(psi);
                if (s < R) {
                    const t = dist * Math.cos(psi) - Math.sqrt(R * R - s * s);
                    if (t > 0) {
                        // asin, не acos — устойчиво при малых γ.
                        // Запас ТОЛЬКО относительный (5%): абсолютный +0.2°
                        // на больших z раздувал бокс на десятки тайлов
                        // (угловой размер тайла ~ 360°/2^z), из-за чего
                        // LOD-фолбэк срабатывал всегда и картинка грубела.
                        const gView = Math.asin(Math.min(1, (t * Math.sin(psi)) / R));
                        gamma = Math.min(gamma, gView * 1.05);
                    }
                }
            }
        }
        const gDeg = gamma * RAD;
        const n = 1 << z;
        const hx = tileCrs.halfExtentX, hy = tileCrs.halfExtentY;
        const xOfLon = (lon) => {
            let l = lon % 360;
            if (l > 180)
                l -= 360;
            else if (l < -180)
                l += 360;
            const p = tileCrs.fromLonLat([l, 0]);
            return ((p[0] + hx) / (2 * hx)) * n;
        };
        const yOfLat = (lat) => {
            const p = tileCrs.fromLonLat([0, lat]);
            return ((hy - p[1]) / (2 * hy)) * n;
        };
        // ── широтный диапазон ──
        // Широту подкамерной точки сразу ограничиваем доменом сетки:
        // выше maxLatDeg тайлов нет. Без этого при |lat| > maxLatDeg
        // (глобус позволяет увести камеру почти на полюс) получалось
        // latMin > latMax → пустой диапазон → полностью белый экран.
        const mLat = tileCrs.maxLatDeg;
        const lat0 = mLat != null
            ? Math.max(-mLat, Math.min(mLat, geo.lat))
            : geo.lat;
        let latMin = lat0 - gDeg;
        let latMax = lat0 + gDeg;
        let fullLon = gDeg >= 180 || latMin <= -90 || latMax >= 90;
        latMin = Math.max(-90, latMin);
        latMax = Math.min(90, latMax);
        if (mLat != null) {
            if (latMin < -mLat)
                latMin = -mLat;
            if (latMax > mLat)
                latMax = mLat;
        }
        if (latMax < latMin)
            return null;
        // ── долготный диапазон ──
        let lonMin = -180, lonMax = 180;
        if (!fullLon) {
            const sinG = Math.sin(gamma);
            const cosLat0 = Math.cos(lat0 * DEG);
            if (sinG >= cosLat0) {
                fullLon = true; // колпак накрывает полюс
            }
            else {
                // Δλ = asin(sin γ / cos φ0) — точная полуширина бокса
                // (проверено численно по границе колпака); ×1.02 — запас.
                const dLon = Math.asin(Math.min(1, sinG / cosLat0)) * RAD * 1.02;
                lonMin = geo.lon - dLon;
                lonMax = geo.lon + dLon;
                if (lonMax - lonMin >= 360)
                    fullLon = true;
            }
        }
        const PAD = 1;
        const clampX = (v) => Math.max(0, Math.min(n - 1, v));
        const yMin = Math.max(0, Math.floor(yOfLat(latMax)) - PAD);
        const yMax = Math.min(n - 1, Math.floor(yOfLat(latMin)) + PAD);
        const cxTile = xOfLon(geo.lon);
        const cyTile = Math.max(0, Math.min(n - 1, yOfLat(lat0)));
        const MAX_SPAN = 128;
        const clampSpan = (lo, hi, c) => {
            if (hi - lo + 1 <= MAX_SPAN)
                return [lo, hi];
            let a = Math.round(c) - (MAX_SPAN >> 1);
            a = Math.max(lo, Math.min(a, hi - MAX_SPAN + 1));
            return [a, a + MAX_SPAN - 1];
        };
        const mk = (xMin, xMax) => {
            const [xa, xb] = clampSpan(xMin, xMax, cxTile);
            const [ya, yb] = clampSpan(yMin, yMax, cyTile);
            return { xMin: xa, xMax: xb, yMin: ya, yMax: yb, cxTile, cyTile };
        };
        if (fullLon)
            return [mk(0, n - 1)];
        const crosses = lonMin < -180 || lonMax > 180;
        if (!crosses) {
            return [mk(clampX(Math.floor(xOfLon(lonMin)) - PAD), clampX(Math.floor(xOfLon(lonMax)) + PAD))];
        }
        // Антимеридиан: интервалы [a0..n-1] и [0..b1].
        const a0 = clampX(Math.floor(xOfLon(lonMin)) - PAD);
        const b1 = clampX(Math.floor(xOfLon(lonMax)) + PAD);
        if (b1 >= a0 - 1)
            return [mk(0, n - 1)]; // интервалы сливаются
        return [mk(a0, n - 1), mk(0, b1)];
    }
    // ── Геометрия тайлов ─────────────────────────────────────
    /**
     * Строит BufferGeometry тайла на эллипсоиде.
     * Позиции — относительно центроида (float32-точность), центроид —
     * в geometry.userData.center (его же ставьте в mesh.position).
     * UV-ориентация совпадает с плоским путём (v=1 — север).
     *
     * @returns { geometry, center } | null
     */
    buildTileGeometry(z, x, y, seg, tileCrs, heights = null) {
        const n = 1 << z;
        const hx = tileCrs.halfExtentX, hy = tileCrs.halfExtentY;
        const grid = seg + 1, count = grid * grid;
        const maxLat = tileCrs.maxLatDeg ?? null;
        // Сепарабельные CRS (меркатор/географическая): lon/lat — 1D-сетки.
        let lons = null, lats = null;
        if (tileCrs.isMercator || tileCrs.isGeographic) {
            lons = new Float64Array(grid);
            lats = new Float64Array(grid);
            for (let i = 0; i < grid; i++) {
                const wx = ((x + i / seg) / n) * 2 * hx - hx;
                lons[i] = tileCrs.toLonLat([wx, 0])[0];
            }
            for (let j = 0; j < grid; j++) {
                const wy = hy - ((y + j / seg) / n) * 2 * hy;
                lats[j] = tileCrs.toLonLat([0, wy])[1];
            }
        }
        const pos = new Float32Array(count * 3);
        const nrm = new Float32Array(count * 3);
        const uv = new Float32Array(count * 2);
        const lonLat = new Float32Array(count * 2);
        let cx = 0, cy = 0, cz = 0, valid = 0;
        const ell = this.ellipsoid;
        for (let j = 0; j < grid; j++) {
            for (let i = 0; i < grid; i++) {
                const idx = j * grid + i;
                let lon, lat;
                if (lons) {
                    lon = lons[i];
                    lat = lats[j];
                }
                else {
                    const wx = ((x + i / seg) / n) * 2 * hx - hx;
                    const wy = hy - ((y + j / seg) / n) * 2 * hy;
                    const r = tileCrs.toLonLat([wx, wy]);
                    lon = r?.[0];
                    lat = r?.[1];
                }
                if (!Number.isFinite(lon) || !Number.isFinite(lat))
                    continue;
                if (maxLat != null)
                    lat = Math.max(-maxLat, Math.min(maxLat, lat));
                lon = Math.max(-180, Math.min(180, lon));
                const h = heights ? (heights[idx] || 0) : 0;
                lonLat[idx * 2] = lon;
                lonLat[idx * 2 + 1] = lat;
                // inline geodeticToEcef + маппинг осей (hot path)
                const latR = lat * DEG, lonR = lon * DEG;
                const sinLat = Math.sin(latR), cosLat = Math.cos(latR);
                const sinLon = Math.sin(lonR), cosLon = Math.cos(lonR);
                const N = ell.a / Math.sqrt(1 - ell.e2 * sinLat * sinLat);
                const X = (N + h) * cosLat * cosLon;
                const Y = (N + h) * cosLat * sinLon;
                const Z = (N * (1 - ell.e2) + h) * sinLat;
                const k = idx * 3;
                pos[k] = X;
                pos[k + 1] = Z;
                pos[k + 2] = -Y;
                nrm[k] = cosLat * cosLon;
                nrm[k + 1] = sinLat;
                nrm[k + 2] = -cosLat * sinLon;
                uv[idx * 2] = i / seg;
                uv[idx * 2 + 1] = 1 - j / seg;
                cx += pos[k];
                cy += pos[k + 1];
                cz += pos[k + 2];
                valid++;
            }
        }
        if (valid < 3)
            return null;
        cx /= valid;
        cy /= valid;
        cz /= valid;
        for (let idx = 0; idx < count; idx++) {
            const k = idx * 3;
            pos[k] -= cx;
            pos[k + 1] -= cy;
            pos[k + 2] -= cz;
        }
        // Индексация — стандартная сетка (как в _createDeformedTileMesh).
        const index = [];
        for (let j = 0; j < seg; j++) {
            for (let i = 0; i < seg; i++) {
                const a = i + grid * j, b = i + grid * (j + 1);
                const c = i + 1 + grid * (j + 1), d = i + 1 + grid * j;
                index.push(a, b, d, b, c, d);
            }
        }
        // Ориентация наружу: первый невырожденный треугольник задаёт знак.
        // (Вырожденные — у полюса в geographic-сетке, там вся строка = точка.)
        let flip = false, found = false;
        outer: for (let j = 0; j < seg && !found; j++) {
            for (let i = 0; i < seg; i++) {
                const a = i + grid * j, b = i + grid * (j + 1), d = i + 1 + grid * j;
                _v2.set(pos[a * 3], pos[a * 3 + 1], pos[a * 3 + 2]);
                _v3.set(pos[b * 3], pos[b * 3 + 1], pos[b * 3 + 2]);
                _v4.set(pos[d * 3], pos[d * 3 + 1], pos[d * 3 + 2]);
                _e1.subVectors(_v3, _v2);
                _e2.subVectors(_v4, _v2);
                _fn.crossVectors(_e1, _e2);
                if (_fn.lengthSq() < 1e-12)
                    continue;
                _v1.set(pos[a * 3] + cx, pos[a * 3 + 1] + cy, pos[a * 3 + 2] + cz);
                flip = _fn.dot(_v1) < 0;
                found = true;
                break outer;
            }
        }
        if (flip) {
            for (let t = 0; t < index.length; t += 3) {
                const tmp = index[t + 1];
                index[t + 1] = index[t + 2];
                index[t + 2] = tmp;
            }
        }
        const IndexArr = count > 65535 ? Uint32Array : Uint16Array;
        const geom = new THREE.BufferGeometry();
        geom.setAttribute('position', new THREE.BufferAttribute(pos, 3));
        geom.setAttribute('normal', new THREE.BufferAttribute(nrm, 3));
        geom.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
        geom.setIndex(new THREE.BufferAttribute(new IndexArr(index), 1));
        const center = new THREE.Vector3(cx, cy, cz);
        geom.userData.globe = true;
        geom.userData.seg = seg;
        geom.userData.lonLat = lonLat; // для перестройки по высотам
        geom.userData.center = center;
        if (heights)
            geom.userData.heights = heights;
        geom.computeBoundingSphere();
        return { geometry: geom, center };
    }
    /**
     * Перестраивает позиции по массиву высот (сдвиг вдоль нормали эллипсоида).
     * Требует geometry.userData.lonLat/center из buildTileGeometry.
     */
    applyHeights(geometry, heights) {
        const lonLat = geometry.userData.lonLat;
        const c = geometry.userData.center;
        if (!lonLat || !c)
            return;
        const pos = geometry.attributes.position.array;
        const ell = this.ellipsoid;
        const count = Math.min(heights.length, lonLat.length / 2);
        for (let idx = 0; idx < count; idx++) {
            const h = heights[idx] || 0;
            const lat = lonLat[idx * 2 + 1], lon = lonLat[idx * 2];
            const latR = lat * DEG, lonR = lon * DEG;
            const sinLat = Math.sin(latR), cosLat = Math.cos(latR);
            const sinLon = Math.sin(lonR), cosLon = Math.cos(lonR);
            const N = ell.a / Math.sqrt(1 - ell.e2 * sinLat * sinLat);
            pos[idx * 3] = (N + h) * cosLat * cosLon - c.x;
            pos[idx * 3 + 1] = (N * (1 - ell.e2) + h) * sinLat - c.y;
            pos[idx * 3 + 2] = -(N + h) * cosLat * sinLon - c.z;
        }
        geometry.userData.heights = heights;
        geometry.attributes.position.needsUpdate = true;
        geometry.computeBoundingSphere();
    }
    // ── Окклюдер (billboard-диск) ────────────────────────────────
    //
    // Невидимый (colorWrite=false) плоский круг, лежащий на касательной
    // плоскости к горизонту и повёрнутый к камере (billboard). Он пишет
    // ТОЛЬКО глубину:
    // всё, что лежит за ним (обратная сторона Земли), depth-тест
    // отбрасывает, а полигоны/тайлы видимого полушария проходят.
    // Рисуется раньше полигонов и тайлов (renderOrder ниже), поэтому
    // его глубина уже на месте, когда они проверяют z-test.
    //
    // Радиус — минимальный b (консервативно): диск не закрывает
    // элементы, поднятые над поверхностью (там r > b).
    /**
     * @returns THREE.Mesh — окклюдер; добавляется в worldGroup.
     */
    createOccluder() {
        // Радиус задаётся в updateOccluder по текущей дистанции до камеры.
        const geom = new THREE.CircleGeometry(1, 192);
        const mat = new THREE.MeshBasicMaterial({
            colorWrite: false, // только глубина, цвет не трогаем
            depthWrite: true,
            depthTest: true,
            side: THREE.DoubleSide,
        });
        const mesh = new THREE.Mesh(geom, mat);
        mesh.name = 'globeOccluder';
        mesh.frustumCulled = false;
        mesh.renderOrder = -500000; // до тайлов и полигонов (см. CoreLifecycle)
        return mesh;
    }
    /**
     * Ставит диск на касательную плоскость к горизонту и растягивает его так,
     * чтобы он перекрывал весь видимый сегмент эллипсоида с запасом.
     *
     * Геометрия (сфера радиуса R, камера на расстоянии C от центра):
     *   - горизонт — окружность в плоскости, ⟂ направлению на камеру,
     *     на расстоянии d = R²/C от центра, радиуса r = R·√(1 − R²/C²);
     *   - диск ставим в эту плоскость (d < C — между камерой и центром)
     *     и растягиваем до r·(1 + HORIZON_MARGIN), так что его край уходит
     *     за видимый горизонт при ЛЮБОМ наклоне камеры.
     *
     * Для эллипсоида берём минимальный радиус b — это консервативно
     * (горизонт только шире, нахлёст его покрывает).
     *
     * @param mesh      — окклюдер из createOccluder()
     * @param camLocal  — позиция камеры в local-СК worldGroup
     */
    updateOccluder(mesh, camLocal) {
        if (!mesh || !camLocal)
            return;
        const R = this.b;
        const C = camLocal.length();
        // Камера внутри/у поверхности: горизонта нет, диск не нужен.
        if (!(C > R * 1.0001)) {
            mesh.visible = false;
            return;
        }
        mesh.visible = true;
        const HORIZON_MARGIN = 0.15; // нахлёст за горизонт, 15%
        const d = (R * R) / C; // расстояние до плоскости горизонта
        const r = R * Math.sqrt(1 - (R * R) / (C * C)); // радиус горизонта
        const radius = Math.max(r, R * 0.5) * (1 + HORIZON_MARGIN);
        // Нормаль к плоскости горизонта — направление на камеру.
        const n = _occN.copy(camLocal).divideScalar(C);
        // Центр диска — на плоскости горизонта.
        mesh.position.copy(n).multiplyScalar(d);
        mesh.scale.set(radius, radius, 1);
        // Диск (CircleGeometry, нормаль +Z) смотрит на камеру.
        mesh.lookAt(camLocal);
    }
}
// ============================================================
// Фабрика
// ============================================================
export function createWorldSurface(projection, globe) {
    return globe ? new GlobeSurface(projection) : new FlatSurface(projection);
}
