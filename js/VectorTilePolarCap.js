// @ts-nocheck
import { THREE } from './js_TP/tpb.js';
/**
 * Полярный колпак глобуса для векторных тайлов.
 *
 * MVT-тайлы обрезаны границей Mercator (±85.05°), поэтому над полюсом
 * данных нет и видна «дырка». Колпак — это диск-шапка от широты ±85.05° до
 * ±90°, залитая цветом: север — цвет моря (слой water), юг — цвет льда.
 *
 * Меш строится на поверхности (surface.position), поэтому повторяет
 * эллипсоид; видимость управляется снаружи через setVisible.
 */
const DEFAULT_NORTH = 0xb3d2f0; // море (theme.light water)
const DEFAULT_SOUTH = 0xf3f9ff; // Антарктида
const CAP_SEGMENTS = 96; // сегменты по окружности
const CAP_RINGS = 8; // кольца от границы колпака к полюсу
/** Строит геометрию полярной шапки ярусами (широта от edgeLat до ±90°). */
function buildCapGeometry(surface, edgeLatDeg, sign) {
    const positions = [];
    const indices = [];
    const pole = surface.position(0, sign * 90, 0, new THREE.Vector3());
    // Центральная точка полюса — первый вершинный элемент.
    positions.push(pole.x, pole.y, pole.z);
    const p = new THREE.Vector3();
    for (let r = 1; r <= CAP_RINGS; r++) {
        // Широта кольца: от границы (r=1 — ближе к краю) к полюсу (r=N).
        const t = r / CAP_RINGS;
        const lat = edgeLatDeg + (sign * 90 - edgeLatDeg) * t;
        for (let s = 0; s < CAP_SEGMENTS; s++) {
            const lon = (s / CAP_SEGMENTS) * 360 - 180;
            surface.position(lon, lat, 0, p);
            positions.push(p.x, p.y, p.z);
        }
    }
    // Кольца: r=1 — у края (широта edgeLat), r=CAP_RINGS — у полюса.
    // Индекс вершины кольца r, сегмента s: ringStart(r) + s.
    const ringStart = (r) => 1 + (r - 1) * CAP_SEGMENTS;
    // 1) Веер от полюса (индекс 0) к ПОЛЮСНОМУ кольцу (r=CAP_RINGS).
    //    Центр обязан соединяться с самым внутренним кольцом, иначе дыра.
    for (let s = 0; s < CAP_SEGMENTS; s++) {
        const s1 = (s + 1) % CAP_SEGMENTS;
        indices.push(0, ringStart(CAP_RINGS) + s, ringStart(CAP_RINGS) + s1);
    }
    // 2) Полосы между соседними кольцами от полюса к краю: (r) и (r-1).
    for (let r = CAP_RINGS; r > 1; r--) {
        for (let s = 0; s < CAP_SEGMENTS; s++) {
            const s1 = (s + 1) % CAP_SEGMENTS;
            const a = ringStart(r) + s, b = ringStart(r) + s1;
            const c = ringStart(r - 1) + s, d = ringStart(r - 1) + s1;
            indices.push(a, c, b, b, c, d);
        }
    }
    // Кольцо r=1 — внешний край: он уже соединён полосой с r=2.
    // Дополнительного замыкания не нужно — граница колпака совпадает с
    // краем сетки тайлов на широте edgeLat (см. buildCapGeometry).
    // Южный колпак: обход зеркальный — переворачиваем треугольники, чтобы
    // лицевая сторона смотрела наружу (FrontSide).
    if (sign < 0) {
        for (let i = 0; i < indices.length; i += 3) {
            const t = indices[i + 1];
            indices[i + 1] = indices[i + 2];
            indices[i + 2] = t;
        }
    }
    const geom = new THREE.BufferGeometry();
    geom.setAttribute('position', new THREE.BufferAttribute(new Float32Array(positions), 3));
    geom.setIndex(indices);
    geom.computeVertexNormals();
    return geom;
}
/**
 * Полярные колпаки одного векторного слоя.
 * Использование: new VectorTilePolarCap(map, { north, south }).
 */
export class VectorTilePolarCap {
    constructor(map, opts = {}) {
        this._map = map;
        this._north = opts.north ?? DEFAULT_NORTH;
        this._south = opts.south ?? DEFAULT_SOUTH;
        this._edgeLat = opts.edgeLat ?? 85.05112878;
        this.group = new THREE.Group();
        this.group.name = 'polarCaps';
        this._north_mesh = null;
        this._south_mesh = null;
        this._built = false;
    }
    _build() {
        const surface = this._map.surface;
        if (!surface || typeof surface.position !== 'function')
            return;
        // Один сторона и без записи глубины: колпак — подложка под тайлами,
        // а не геометрия для z-сортировки. DoubleSide + depthWrite давали
        // полупрозрачную голубую вуаль при пересечении с тайлами/окклюдером.
        const mat = (color) => new THREE.MeshBasicMaterial({
            color, side: THREE.FrontSide, depthWrite: false, depthTest: true,
            transparent: false, opacity: 1,
        });
        const gN = buildCapGeometry(surface, this._edgeLat, +1);
        const gS = buildCapGeometry(surface, this._edgeLat, -1);
        this._north_mesh = new THREE.Mesh(gN, mat(this._north));
        this._south_mesh = new THREE.Mesh(gS, mat(this._south));
        // Колпаки лежат в локальной СК worldGroup и не зависят от камеры.
        this._north_mesh.visible = false;
        this._south_mesh.visible = false;
        // Колпак — подложка: рисуется раньше тайлов, но без записи глубины,
        // чтобы не перекрывать материки на любом зуме.
        this._north_mesh.renderOrder = -1000;
        this._south_mesh.renderOrder = -1000;
        this._north_mesh.frustumCulled = true;
        this._south_mesh.frustumCulled = true;
        this.group.add(this._north_mesh, this._south_mesh);
        this._built = true;
    }
    /** Подключает колпаки к worldGroup карты (один раз). */
    attach() {
        if (!this._built)
            this._build();
        const wg = this._map.worldGroup;
        if (wg && !this.group.parent)
            wg.add(this.group);
        return this;
    }
    detach() {
        if (this.group.parent)
            this.group.parent.remove(this.group);
    }
    /**
     * Показывает колпак, если соответствующий полюсный тайл текущего уровня
     * в наборе видимых. north/south — булевы флаги из VectorTileLoading.
     */
    setVisible({ north = false, south = false } = {}) {
        if (!this._built)
            return;
        this._north_mesh.visible = !!north;
        this._south_mesh.visible = !!south;
    }
    setColors({ north, south } = {}) {
        if (north !== undefined && this._north_mesh)
            this._north_mesh.material.color.set(north);
        if (south !== undefined && this._south_mesh)
            this._south_mesh.material.color.set(south);
    }
    dispose() {
        this.detach();
        for (const m of [this._north_mesh, this._south_mesh]) {
            if (!m)
                continue;
            m.geometry.dispose();
            m.material.dispose();
        }
        this._north_mesh = this._south_mesh = null;
        this._built = false;
    }
}
export const POLAR_CAP_DEFAULTS = { north: DEFAULT_NORTH, south: DEFAULT_SOUTH };
