/**
 * Полигон на карте: заливка (Earcut), обводка (Line2 / THREE.Line),
 * экструзия, высоты, подписи, hover/click.
 *
 * Антимеридиан: если кольцо в lon/lat пересекает меридиан 180° (скачок
 * долготы > 180°), оно разрезается на под-кольца, каждое из которых
 * замыкается по нижнему краю карты (для Mercator) через меридианы ±180.
 * Это убирает «усы» — длинные прямые через всю сцену.
 */

import { Projections, WGS84 } from './Projections.js';
import {
  THREE,
  Line2,
  LineMaterial,
  LineGeometry,
} from '../js_TP/tpb.js';
import { Layer } from './Layers.js';
import earcut from '../js_TP/earcut.js';

/** Порядок отрисовки мешей полигона. */
export const POLYGON_RENDER_ORDER = {
    BOTTOM: 900,
    SIDE:   901,
    TOP:    902,
    STROKE: 903
};

/** Y-компонента векторного произведения (p1-p0) × (p2-p0) в плоскости XZ. @private */
function crossY(p0, p1, p2) {
    const dx1 = p1.x - p0.x, dz1 = p1.y - p0.y;
    const dx2 = p2.x - p0.x, dz2 = p2.y - p0.y;
    return dz1 * dx2 - dx1 * dz2;
}

/** Разбивает кольцо (lon/lat) на под-кольца по скачкам долготы > 180°. @private */
function splitAtAntimeridian(lonLat) {
    const n = lonLat.length;
    if (n < 3) return [lonLat];

    const segments = [];
    let current = [lonLat[0]];

    for (let i = 1; i < n; i++) {
        const prev = lonLat[i - 1];
        const curr = lonLat[i];
        if (Math.abs(curr[0] - prev[0]) > 180) {
            if (current.length >= 3) segments.push(current);
            current = [curr];
        } else {
            current.push(curr);
        }
    }

    // Замыкание кольца.
    const first = lonLat[0];
    const last = lonLat[n - 1];
    if (Math.abs(first[0] - last[0]) > 180) {
        // Разрыв на замыкании — закрываем current как отдельный сегмент
        // и переносим first в новый.
        if (current.length >= 3) segments.push(current);
        // сегмент из first уже открыт в самом начале; закончим обход.
    } else {
        if (current.length >= 3) segments.push(current);
    }

    return segments.length > 0 ? segments : [lonLat];
}

export class Polygon {
    /**
     * @param {Object} options
     * @param {Array<Array<Array<number>>>} options.rings
     * @param {string} [options.crs]
     * @param {string} [options.fillColor='#3388ff']
     * @param {number} [options.fillOpacity=0.5]
     * @param {string} [options.strokeColor='#000000']
     * @param {number} [options.strokeWidth=2]
     * @param {number} [options.strokeOpacity=1]
     * @param {string} [options.altitudeMode='clampToGround']
     * @param {number} [options.altitudeOffset=10]
     * @param {boolean} [options.extruded=false]
     * @param {number} [options.height=0]
     * @param {number} [options.minHeight=0]
     * @param {boolean} [options.depthTest]
     * @param {boolean} [options.depthWrite]
     * @param {boolean} [options.castShadow=true]
     * @param {boolean} [options.receiveShadow=true]
     * @param {number} [options.roughness=0.8]
     * @param {number} [options.metalness=0.0]
     * @param {number} [options.minZoom=-Infinity]
     * @param {number} [options.maxZoom=Infinity]
     * @param {string} [options.title='']
     * @param {Array<number>} [options.titleOffset=[0,0]]
     * @param {string} [options.titleAlign='center']
     * @param {Object} [options.titleStyle={}]
     * @param {number} [options.titleMinZoom=-Infinity]
     * @param {number} [options.titleMaxZoom=Infinity]
     * @param {boolean} [options.titleAllowOverflow=false]
     * @param {number} [options.titlePriority=0]
     * @param {Function} [options.onClick]
     * @param {Function} [options.onHover]
     * @param {string} [options.tooltip='']
     * @param {boolean} [options.useSimpleStroke=false]
     * @param {boolean} [options.useWorkerForTriangulation=false]
     */
    constructor(options = {}) {
        if (!options.rings || !options.rings.length || !options.rings[0].length) {
            throw new Error('Polygon: options.rings required with at least one ring');
        }

        /** @private @type {Array<Array<Array<number>>>} */ this._rings = options.rings;
        /** @private @type {string|null} */ this._crsCode = options.crs ?? null;
        /** @private @type {import('./Projections.js').Projection|null} */ this._crs = null;

        /** @private @type {string} */  this._fillColor = options.fillColor || '#3388ff';
        /** @private @type {number} */  this._fillOpacity = options.fillOpacity ?? 0.5;
        /** @private @type {string} */  this._strokeColor = options.strokeColor || '#000000';
        /** @private @type {number} */  this._strokeWidth = options.strokeWidth ?? 2;
        /** @private @type {number} */  this._strokeOpacity = options.strokeOpacity ?? 1;
        /** @private @type {string} */  this._altitudeMode = options.altitudeMode || 'clampToGround';
        /** @private @type {number} */  this._altitudeOffset = options.altitudeOffset ?? 10;

        /** @private @type {boolean} */ this._extruded = options.extruded ?? false;
        /** @private @type {number} */  this._height = options.height ?? 0;
        /** @private @type {number} */  this._minHeight = options.minHeight ?? 0;
        if (this._extruded && (typeof this._height !== 'number' || this._height <= 0)) {
            throw new Error('Polygon: options.height must be a positive number when extruded is true');
        }

        /** @private @type {boolean} */ this._depthTest = options.depthTest ?? this._extruded;
        /** @private @type {boolean} */ this._depthWrite = options.depthWrite ?? this._extruded;

        /** @private @type {number} */  this._minZoom = options.minZoom ?? -Infinity;
        /** @private @type {number} */  this._maxZoom = options.maxZoom ?? Infinity;
        /** @private @type {boolean} */ this._useSimpleStroke = options.useSimpleStroke ?? false;
        /** @private @type {boolean} */ this._useWorkerForTriangulation = options.useWorkerForTriangulation ?? false;

        /** @private @type {boolean} */ this._castShadow = options.castShadow ?? true;
        /** @private @type {boolean} */ this._receiveShadow = options.receiveShadow ?? true;
        /** @private @type {number} */  this._roughness = options.roughness ?? 0.8;
        /** @private @type {number} */  this._metalness = options.metalness ?? 0.0;

        /** @private @type {string} */  this._title = options.title || '';
        /** @private @type {Array<number>} */ this._titleOffset = options.titleOffset || [0, 0];
        /** @private @type {string} */  this._titleAlign = options.titleAlign || 'center';
        /** @private @type {Object} */  this._titleStyle = options.titleStyle || {};
        /** @private @type {number} */  this._titleMinZoom = options.titleMinZoom ?? -Infinity;
        /** @private @type {number} */  this._titleMaxZoom = options.titleMaxZoom ?? Infinity;
        /** @private @type {boolean} */ this._titleAllowOverflow = options.titleAllowOverflow || false;
        /** @private @type {number} */  this._titlePriority = options.titlePriority ?? 0;

        /** @private @type {Function|null} */ this._onClick = options.onClick || null;
        /** @private @type {Function|null} */ this._onHover = options.onHover || null;
        /** @private @type {boolean} */ this._isHovered = false;
        /** @private @type {string} */  this._tooltipText = options.tooltip || '';

        /** @private @type {import('./KrbMap.js').KrbMap|null} */ this._map = null;
        /** @private @type {Layer|null} */ this._layer = null;
        /** @private @type {THREE.Group} */ this._group = new THREE.Group();

        /** @private @type {THREE.Mesh|null} */           this._fillMesh = null;
        /** @private @type {THREE.BufferGeometry|null} */ this._fillGeometry = null;
        /** @private @type {THREE.Material|null} */       this._fillMaterial = null;
        /** @private @type {THREE.Mesh|null} */           this._bottomMesh = null;
        /** @private @type {THREE.BufferGeometry|null} */ this._bottomGeometry = null;
        /** @private @type {THREE.Material|null} */       this._bottomMaterial = null;
        /** @private @type {THREE.Mesh|null} */           this._sideMesh = null;
        /** @private @type {THREE.BufferGeometry|null} */ this._sideGeometry = null;
        /** @private @type {THREE.Material|null} */       this._sideMaterial = null;
        /** @private @type {number} */                   this._sideVertexCount = 0;
        /** @private @type {THREE.Object3D[]|null} */    this._strokeLines = null;
        /** @private @type {THREE.BufferGeometry[]|null} */ this._strokeGeometries = null;
        /** @private @type {THREE.Material[]|null} */    this._strokeMaterials = null;

        /** @private @type {Array<number>} */ this._cachedHeights = [];
        /** @private @type {Array<Array<number>>} */ this._cachedStrokeHeights = [];
        /** @private @type {number} */        this._lastHeightUpdateTime = 0;
        /** @private @type {number} */        this._heightUpdateInterval = 500;
        /** @private @type {boolean} */       this._heightsFinalized = false;

        /** @private @type {Array<THREE.Vector2>} */ this._vertices2D = [];
        /** @private @type {THREE.Vector3} */         this._centroidWorld = new THREE.Vector3();
        /** @private @type {number} */                this._cachedCentroidHeight = 0;
        /** @private @type {number} */                this._lastCentroidHeightUpdateTime = 0;

        /** @private @type {Array<[number, number]>} */ this._worldCoords = [];

        /** @private @type {Array<Array<[number, number]>>|null} */
        this._projectedOuterSubRings = null;

        /** @private @type {Array<number>} */ this._ringStarts = [];

        /** @private @type {number} */ this._boundingSphereRadius = 0;
        /** @private @type {THREE.Vector3} */ this._boundingSphereWorldCenter = new THREE.Vector3();

        /** @private @type {THREE.Object3D[]|null} */ this._raycastMeshesCache = null;
        /** @private @type {(() => void)|null} */ this._unregisterInteraction = null;

        /** @private @type {boolean} */ this._heightsDirty = true;
        /** @private @type {THREE.Vector3} */ this._lastWorldGroupPos = new THREE.Vector3();
        /** @private @type {number} */ this._lastDiscreteZoom = -1;

        /** @private @type {Object|null} */ this._centroidScreenPos = null;
        /** @private @type {Object|null} */ this._textLabel = null;

        /** @private @type {Array<number>} */ this._sidePositionsArray = [];
        /** @private @type {Array<number>} */ this._sideIndicesArray = [];
    }

    /* ================================================================
       Публичные методы
       ================================================================ */

    addTo(map) {
        if (this._map) this.remove();
        const personalLayer = new Layer();
        personalLayer.addTo(map);
        personalLayer.add(this);
        return this;
    }

    /** @private */
    _attach(map, layer) {
        if (this._map === map && this._layer === layer) return;
        this.remove();
        this._map = map;
        this._layer = layer;

        this._crs = this._crsCode ? Projections.get(this._crsCode) : map.inputCRS;

        this._buildFillGeometry(map);
        this._buildStrokeGeometry(map);
        map.worldGroup.add(this._group);

        if (this._title && map.textManager) {
            this._textLabel = map.textManager.addLabel(this);
        }

        this._registerInteraction(map);

        this._lastWorldGroupPos.copy(map.worldGroup.position);
        this._lastDiscreteZoom = map.currentDiscreteZoom;
        this._heightsDirty = true;
        this._heightsFinalized = false;
    }

    /** @private */
    _registerInteraction(map) {
        if (!map.interaction || typeof map.interaction.register !== 'function') return;
        if (this._unregisterInteraction) {
            this._unregisterInteraction();
            this._unregisterInteraction = null;
        }
        if (!this._onClick && !this._onHover && !this._tooltipText) return;

        const callbacks = {
            getMeshes: () => this._getRaycastMeshes(),
            getBoundingSphere: () => {
                if (this._boundingSphereRadius <= 0) return null;
                const wgPos = map.worldGroup.position;
                this._boundingSphereWorldCenter.set(
                    this._group.position.x + wgPos.x,
                    this._group.position.y + wgPos.y,
                    this._group.position.z + wgPos.z
                );
                return { center: this._boundingSphereWorldCenter, radius: this._boundingSphereRadius };
            },
            isVisible: () => this._group.visible
        };

        if (this._onHover) {
            callbacks.onHover = (isHovered) => {
                this._isHovered = isHovered;
                this._onHover(isHovered);
            };
        } else if (this._tooltipText) {
            callbacks.getTooltip = () => this._tooltipText;
        }

        if (this._onClick) {
            callbacks.onClick = (event) => this._onClick(event, this);
        }

        this._unregisterInteraction = map.interaction.register(this, callbacks);
    }

    /** @private */
    _getRaycastMeshes() {
        if (this._raycastMeshesCache) return this._raycastMeshesCache;
        const meshes = [];
        if (this._fillMesh) meshes.push(this._fillMesh);
        if (this._sideMesh) meshes.push(this._sideMesh);
        if (this._bottomMesh) meshes.push(this._bottomMesh);
        this._raycastMeshesCache = meshes;
        return meshes;
    }

    /** @private */
    _getTitleTransform() {
        switch (this._titleAlign) {
            case 'left': return 'translate(0, 0)';
            case 'right': return 'translate(-100%, 0)';
            default: return 'translate(-50%, 0)';
        }
    }

    /** @private */
    _createSurfaceMaterial() {
        const isTransparent = this._fillOpacity < 1;

        if (this._extruded) {
            return new THREE.MeshStandardMaterial({
                color: this._fillColor,
                opacity: this._fillOpacity,
                transparent: isTransparent,
                side: THREE.DoubleSide,
                roughness: this._roughness,
                metalness: this._metalness,
                depthTest: this._depthTest,
                depthWrite: this._depthWrite,
                polygonOffset: true,
                polygonOffsetFactor: -1,
                polygonOffsetUnits: -1
            });
        }
        return new THREE.MeshBasicMaterial({
            color: this._fillColor,
            opacity: this._fillOpacity,
            transparent: isTransparent,
            side: THREE.DoubleSide,
            depthTest: this._depthTest,
            depthWrite: this._depthWrite,
            polygonOffset: true,
            polygonOffsetFactor: -1,
            polygonOffsetUnits: -1
        });
    }

    /** @private */
    _applyShadowFlags(mesh) {
        if (!mesh) return;
        if (this._extruded) {
            mesh.castShadow = this._castShadow;
            mesh.receiveShadow = this._receiveShadow;
        } else {
            mesh.castShadow = false;
            mesh.receiveShadow = false;
        }
    }

    /** @private */
    _flipIndices(indices) {
        const result = new Array(indices.length);
        for (let i = 0; i < indices.length; i += 3) {
            result[i] = indices[i];
            result[i + 1] = indices[i + 2];
            result[i + 2] = indices[i + 1];
        }
        return result;
    }

    /**
     * Проецирует кольцо в world-метры карты, разрезая его по антимеридиану.
     *
     * Каждое под-кольцо (в lon/lat) проецируется отдельно через
     * `map.projectSafe`. Если под-кольцо целиком в одном полушарии
     * (типично для Антарктиды), оно замыкается по нижнему краю карты:
     * добавляются две точки [lon_end, polarLat], [lon_start, polarLat],
     * где polarLat = ±(85.05) для Mercator. Это превращает длинный
     * сегмент через весь мир в короткий по нижней границе.
     *
     * @param {Array<Array<number>>} ring
     * @param {import('./KrbMap.js').KrbMap} map
     * @returns {Array<Array<[number, number]>>} Массив под-колец.
     * @private
     */
    _projectRing(ring, map) {
        const n = ring.length;
        if (n < 3) return [];

        const srcCrs = this._crs;

        // 1) В lon/lat.
        const lonLat = [];
        for (let i = 0; i < n; i++) {
            const ll = typeof srcCrs.toLonLatSafe === 'function'
                ? srcCrs.toLonLatSafe(ring[i])
                : srcCrs.toLonLat(ring[i]);
            if (ll && Number.isFinite(ll[0]) && Number.isFinite(ll[1])) {
                lonLat.push([ll[0], ll[1]]);
            }
        }
        if (lonLat.length < 3) return [];

        // 2) Разбиение по антимеридиану.
        const segments = splitAtAntimeridian(lonLat);

        // 3) Определяем polarLat (для замыкания под-колец).
        //    Меркатор: ±85.05. Иначе — самая удалённая по широте сторона.
        let avgLat = 0;
        for (const p of lonLat) avgLat += p[1];
        avgLat /= lonLat.length;

        let polarLat = null;
        if (map.projection.isMercator && Number.isFinite(map.projection.maxLatDeg)) {
            polarLat = Math.sign(avgLat) * map.projection.maxLatDeg;
        } else {
            // Fallback: чуть за полярным кругом, в стороне от контура.
            let maxAbs = 0;
            for (const p of lonLat) if (Math.abs(p[1]) > maxAbs) maxAbs = Math.abs(p[1]);
            polarLat = Math.sign(avgLat) * Math.min(89.5, maxAbs + 1);
        }

        // 4) Проекция каждого под-кольца.
        const result = [];
        for (let s = 0; s < segments.length; s++) {
            const seg = segments[s];
            const isFirst = (s === 0);
            const isLast = (s === segments.length - 1);
            const hasClosingGap = segments.length > 1;

            // Строим расширенный lon/lat список: сами точки + точки замыкания
            // по нижнему краю карты.
            const extended = seg.slice();
            if (hasClosingGap) {
                // Для первого сегмента — замыкание от последней точки
                // под-кольца к первой через polarLat (только в конце).
                // Для последнего — тоже, но закрываем круг к началу
                // исходного кольца.
                if (isFirst || isLast) {
                    const first = seg[0];
                    const last = seg[seg.length - 1];
                    extended.push([last[0], polarLat]);
                    extended.push([first[0], polarLat]);
                }
            }

            const m = extended.length;
            if (m < 3) continue;

            const out = new Array(m);
            let prevValid = null;
            let validCount = 0;
            for (let i = 0; i < m; i++) {
                const p = map.projectSafe(extended[i], WGS84);
                if (p) {
                    out[i] = p;
                    prevValid = p;
                    validCount++;
                } else if (prevValid) {
                    out[i] = [prevValid[0], prevValid[1]];
                } else {
                    out[i] = [0, 0];
                }
            }
            if (validCount >= 3) result.push(out);
        }

        return result;
    }

    /** Строит заливку (Earcut) и — для extruded — нижнюю крышку и стенки. @private */
    _buildFillGeometry(map) {
        const rings = this._rings;
        if (!rings || !rings.length || rings[0].length < 3) {
            console.warn('Polygon: rings[0] must have at least 3 points');
            return;
        }

        this._worldCoords.length = 0;
        this._projectedOuterSubRings = null;
        this._ringStarts = [];

        // Проецируем внешнее кольцо (может дать несколько под-колец).
        const outerSubRings = this._projectRing(rings[0], map);
        if (!outerSubRings || outerSubRings.length === 0) {
            console.warn('Polygon: внешнее кольцо не спроецировалось');
            return;
        }
        this._projectedOuterSubRings = outerSubRings;

        // Дырки: применяем только если у внешнего кольца один под-сегмент.
        const holeSubRings = [];
        const useHoles = (outerSubRings.length === 1);
        for (let i = 1; i < rings.length; i++) {
            const subs = this._projectRing(rings[i], map);
            if (subs.length === 1) holeSubRings.push(subs[0]);
            else if (subs.length > 1 && !useHoles) {
                // дырка разбилась — пропускаем
            }
        }

        // Собираем все точки в один массив.
        const points2D = [];
        const worldCoords = [];

        const addSub = (sub, isHole) => {
            const start = points2D.length;
            let firstPt = null;
            for (let i = 0; i < sub.length; i++) {
                const x = sub[i][0], z = sub[i][1];
                if (i === 0) firstPt = [x, z];
                if (i > 0 && x === firstPt[0] && z === firstPt[1]) continue;
                points2D.push(new THREE.Vector2(x, z));
                worldCoords.push([x, z]);
            }
            const count = points2D.length - start;
            if (count >= 3) this._ringStarts.push({ start, count, isHole });
            else points2D.length = start;
        };

        for (const sub of outerSubRings) addSub(sub, false);
        if (useHoles) {
            for (const h of holeSubRings) addSub(h, true);
        }

        if (points2D.length < 3) {
            console.warn('Polygon: after processing rings, less than 3 vertices');
            return;
        }

        this._vertices2D = points2D;
        this._worldCoords = worldCoords;
        this._cachedHeights = new Array(points2D.length).fill(0);

        // Центроид.
        let cx = 0, cy = 0;
        for (const pt of points2D) { cx += pt.x; cy += pt.y; }
        cx /= points2D.length;
        cy /= points2D.length;

        this._centroidWorld.set(cx, 0, cy);
        this._group.position.copy(this._centroidWorld);

        for (const pt of points2D) { pt.x -= cx; pt.y -= cy; }

        let maxRSq = 0;
        for (const pt of points2D) {
            const rSq = pt.x * pt.x + pt.y * pt.y;
            if (rSq > maxRSq) maxRSq = rSq;
        }
        this._boundingSphereRadius = Math.sqrt(maxRSq);

        // Триангуляция — по каждому под-кольцу отдельно.
        const outerRanges = this._ringStarts.filter(r => !r.isHole);
        const holeRanges = this._ringStarts.filter(r => r.isHole);

        const topIndices = [];
        const bottomIndices = [];

        for (let r = 0; r < outerRanges.length; r++) {
            const range = outerRanges[r];
            const coordsLocal = [];
            for (let i = range.start; i < range.start + range.count; i++) {
                coordsLocal.push(points2D[i].x, points2D[i].y);
            }

            const holeIndices = [];
            const coordsWithHoles = coordsLocal.slice();
            if (r === 0 && holeRanges.length > 0) {
                for (const hole of holeRanges) {
                    holeIndices.push(coordsWithHoles.length / 2);
                    for (let i = hole.start; i < hole.start + hole.count; i++) {
                        coordsWithHoles.push(points2D[i].x, points2D[i].y);
                    }
                }
            }

            const raw = earcut(coordsWithHoles, holeIndices, 2);
            if (raw.length === 0) continue;

            // Winding.
            let cross = 0;
            if (raw.length >= 3) {
                const p0x = coordsWithHoles[raw[0] * 2];
                const p0y = coordsWithHoles[raw[0] * 2 + 1];
                const p1x = coordsWithHoles[raw[1] * 2];
                const p1y = coordsWithHoles[raw[1] * 2 + 1];
                const p2x = coordsWithHoles[raw[2] * 2];
                const p2y = coordsWithHoles[raw[2] * 2 + 1];
                cross = (p1y - p0y) * (p2x - p0x) - (p1x - p0x) * (p2y - p0y);
            }
            const flipped = cross < 0;

            const base = range.start;
            for (let i = 0; i < raw.length; i += 3) {
                const a = raw[i] + base;
                const b = raw[i + 1] + base;
                const c = raw[i + 2] + base;
                if (flipped) {
                    topIndices.push(a, c, b);
                    bottomIndices.push(a, b, c);
                } else {
                    topIndices.push(a, b, c);
                    bottomIndices.push(a, c, b);
                }
            }
        }

        if (topIndices.length === 0) {
            console.warn('Polygon: Earcut returned no triangles');
            return;
        }

        // Верхняя крышка.
        const topGeometry = new THREE.BufferGeometry();
        const topPosArray = new Float32Array(points2D.length * 3);
        for (let i = 0; i < points2D.length; i++) {
            topPosArray[i * 3] = points2D[i].x;
            topPosArray[i * 3 + 1] = 0;
            topPosArray[i * 3 + 2] = points2D[i].y;
        }
        topGeometry.setAttribute('position', new THREE.BufferAttribute(topPosArray, 3));
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
            // Нижняя крышка.
            const bottomGeometry = new THREE.BufferGeometry();
            const bottomPosArray = new Float32Array(points2D.length * 3);
            for (let i = 0; i < points2D.length; i++) {
                bottomPosArray[i * 3] = points2D[i].x;
                bottomPosArray[i * 3 + 1] = 0;
                bottomPosArray[i * 3 + 2] = points2D[i].y;
            }
            bottomGeometry.setAttribute('position', new THREE.BufferAttribute(bottomPosArray, 3));
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

            // Стенки.
            const sidePositions = this._sidePositionsArray;
            const sideIndices = this._sideIndicesArray;
            sidePositions.length = 0;
            sideIndices.length = 0;

            for (const range of outerRanges) {
                if (range.count < 2) continue;
                for (let i = 0; i < range.count; i++) {
                    const j = (i + 1) % range.count;
                    const topI = points2D[range.start + i];
                    const topJ = points2D[range.start + j];
                    const base = sidePositions.length / 3;

                    sidePositions.push(topI.x, this._height, topI.y);
                    sidePositions.push(topI.x, 0, topI.y);
                    sidePositions.push(topJ.x, this._height, topJ.y);
                    sidePositions.push(topJ.x, 0, topJ.y);

                    sideIndices.push(base, base + 1, base + 2);
                    sideIndices.push(base + 1, base + 3, base + 2);
                }
            }

            const sideGeometry = new THREE.BufferGeometry();
            sideGeometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(sidePositions), 3));
            sideGeometry.setIndex(sideIndices);
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
            this._sideVertexCount = sidePositions.length / 3;
            this._group.add(sideMesh);
        }

        this._raycastMeshesCache = null;
    }

    /** Строит обводку по каждому под-кольцу отдельно. @private */
    _buildStrokeGeometry(map) {
        if (this._strokeWidth <= 0 || this._strokeOpacity <= 0) return;
        if (!this._projectedOuterSubRings || this._projectedOuterSubRings.length === 0) return;

        const canvas = map.renderer.domElement;

        this._strokeLines = [];
        this._strokeGeometries = [];
        this._strokeMaterials = [];
        this._cachedStrokeHeights = [];

        for (const sub of this._projectedOuterSubRings) {
            if (sub.length < 2) continue;

            // Дедупликация замыкания.
            const pts = [];
            const firstPt = sub[0];
            for (let i = 0; i < sub.length; i++) {
                const p = sub[i];
                if (i > 0 && p[0] === firstPt[0] && p[1] === firstPt[1]) continue;
                pts.push([p[0], p[1]]);
            }
            if (pts.length < 2) continue;

            if (this._useSimpleStroke) {
                const positions = [];
                for (const p of pts) positions.push(p[0], 0, p[1]);
                positions.push(pts[0][0], 0, pts[0][1]);

                const geom = new THREE.BufferGeometry();
                geom.setAttribute('position', new THREE.BufferAttribute(new Float32Array(positions), 3));
                geom.computeBoundingSphere();

                const mat = new THREE.LineBasicMaterial({
                    color: this._strokeColor,
                    opacity: this._strokeOpacity,
                    transparent: this._strokeOpacity < 1,
                    depthTest: this._depthTest,
                    depthWrite: this._depthWrite
                });
                const line = new THREE.Line(geom, mat);
                line.renderOrder = POLYGON_RENDER_ORDER.STROKE;
                this._strokeLines.push(line);
                this._strokeGeometries.push(geom);
                this._strokeMaterials.push(mat);
                this._group.add(line);
            } else {
                const geom = new LineGeometry();
                const mat = new LineMaterial({
                    color: this._strokeColor,
                    linewidth: this._strokeWidth,
                    opacity: this._strokeOpacity,
                    transparent: this._strokeOpacity < 1,
                    depthTest: this._depthTest,
                    depthWrite: this._depthWrite,
                    resolution: new THREE.Vector2(canvas.width, canvas.height)
                });
                const line = new Line2(geom, mat);
                line.renderOrder = POLYGON_RENDER_ORDER.STROKE;
                this._strokeLines.push(line);
                this._strokeGeometries.push(geom);
                this._strokeMaterials.push(mat);
                this._group.add(line);
            }

            this._cachedStrokeHeights.push(new Array(pts.length + 1).fill(0));
        }
    }

    /** Удаляет полигон с карты. */
    remove() {
        if (this._unregisterInteraction) {
            this._unregisterInteraction();
            this._unregisterInteraction = null;
        }

        if (this._group) {
            this._group.parent?.remove(this._group);
            this._fillGeometry?.dispose();
            this._fillMaterial?.dispose();
            this._bottomGeometry?.dispose();
            this._bottomMaterial?.dispose();
            this._sideGeometry?.dispose();
            this._sideMaterial?.dispose();
            if (this._strokeGeometries) for (const g of this._strokeGeometries) g.dispose();
            if (this._strokeMaterials) for (const m of this._strokeMaterials) m.dispose();
        }
        this._fillMesh = null;
        this._bottomMesh = null;
        this._sideMesh = null;
        this._strokeLines = null;
        this._strokeGeometries = null;
        this._strokeMaterials = null;
        this._fillGeometry = null;
        this._fillMaterial = null;
        this._bottomGeometry = null;
        this._bottomMaterial = null;
        this._sideGeometry = null;
        this._sideMaterial = null;

        if (this._textLabel && this._map?.textManager) {
            this._map.textManager.removeLabel(this._textLabel);
            this._textLabel = null;
        }
        this._worldCoords.length = 0;
        this._projectedOuterSubRings = null;
        this._vertices2D.length = 0;
        this._boundingSphereRadius = 0;
        this._cachedHeights.length = 0;
        this._cachedStrokeHeights.length = 0;
        this._isHovered = false;
        this._raycastMeshesCache = null;

        this._layer?._removeRef(this);
        this._layer = null;
        this._map = null;
        this._crs = null;
    }

    /** @private */
    _update(map) {
        if (!this._map || !this._group) return;
        const zoom = this._map.continuousZoom;

        if (this._layer && !this._layer.visible) { this._group.visible = false; return; }
        if (zoom < this._minZoom || zoom > this._maxZoom) { this._group.visible = false; return; }

        if (this._group.parent !== this._map.worldGroup) {
            this._group.parent?.remove(this._group);
            this._map.worldGroup.add(this._group);
        }

        if (this._strokeMaterials) {
            const canvas = this._map.renderer.domElement;
            for (const mat of this._strokeMaterials) {
                if (mat.resolution) {
                    const res = mat.resolution;
                    if (res.x !== canvas.width || res.y !== canvas.height) {
                        res.set(canvas.width, canvas.height);
                    }
                }
            }
        }

        if (this._boundingSphereRadius > 0) {
            const maxDist = map.maxObjectDistance;
            if (maxDist !== Infinity) {
                const worldCenter = map.getVec3()
                    .copy(this._group.position)
                    .add(map.worldGroup.position);
                const distToCenter = map.camera.position.distanceTo(worldCenter);
                if (distToCenter - this._boundingSphereRadius > maxDist) {
                    this._group.visible = false;
                    return;
                }
            }
        }

        this._group.visible = true;

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
    }

    /** @private */
    _updateHeights() {
        if (!this._fillGeometry || !this._vertices2D.length) return false;
        const map = this._map;

        const isDynamic = map.hasElevation && this._altitudeMode === 'clampToGround';
        if (!isDynamic && this._heightsFinalized) return false;

        const wgPos = map.worldGroup.position;

        for (let i = 0; i < this._vertices2D.length; i++) {
            const worldCoord = this._worldCoords[i];
            if (!worldCoord) continue;
            let base = this._altitudeOffset;
            if (isDynamic) {
                const worldX = worldCoord[0] + wgPos.x;
                const worldZ = worldCoord[1] + wgPos.z;
                map.ensureTileForPoint?.(worldX, worldZ);
                base = map.getSurfaceHeightAt(worldX, worldZ) + this._altitudeOffset;
            }
            this._cachedHeights[i] = base + this._minHeight + (this._extruded ? this._height : 0);
        }

        const topPos = this._fillGeometry.attributes.position.array;
        for (let i = 0; i < this._vertices2D.length; i++) {
            topPos[i * 3 + 1] = this._cachedHeights[i];
        }
        this._fillGeometry.attributes.position.needsUpdate = true;
        this._fillGeometry.computeBoundingSphere();

        if (this._bottomGeometry) {
            const bottomPos = this._bottomGeometry.attributes.position.array;
            for (let i = 0; i < this._vertices2D.length; i++) {
                bottomPos[i * 3 + 1] = this._cachedHeights[i] - this._height;
            }
            this._bottomGeometry.attributes.position.needsUpdate = true;
            this._bottomGeometry.computeBoundingSphere();
        }

        if (this._sideGeometry) {
            const sidePos = this._sideGeometry.attributes.position.array;
            let idx = 0;
            for (let i = 0; i < this._vertices2D.length; i++) {
                const j = (i + 1) % this._vertices2D.length;
                const upperI = this._cachedHeights[i];
                const upperJ = this._cachedHeights[j];
                const lowerI = upperI - this._height;
                const lowerJ = upperJ - this._height;

                if (idx * 3 + 1 >= sidePos.length) break;
                sidePos[idx * 3 + 1] = upperI; idx++;
                if (idx * 3 + 1 >= sidePos.length) break;
                sidePos[idx * 3 + 1] = lowerI; idx++;
                if (idx * 3 + 1 >= sidePos.length) break;
                sidePos[idx * 3 + 1] = upperJ; idx++;
                if (idx * 3 + 1 >= sidePos.length) break;
                sidePos[idx * 3 + 1] = lowerJ; idx++;
            }
            this._sideGeometry.attributes.position.needsUpdate = true;
            this._sideGeometry.computeVertexNormals();
            this._sideGeometry.computeBoundingSphere();
        }

        if (!isDynamic) this._heightsFinalized = true;
        return true;
    }

    /** @private */
    _updateStroke() {
        if (!this._strokeLines || !this._strokeGeometries) return;
        const groupPos = this._group.position;

        for (let li = 0; li < this._strokeLines.length; li++) {
            const line = this._strokeLines[li];
            const geom = this._strokeGeometries[li];
            const sub = this._projectedOuterSubRings[li];
            if (!sub) continue;

            // Собираем позиции, дедуплицируя замыкание.
            const pts = [];
            const firstPt = sub[0];
            for (let i = 0; i < sub.length; i++) {
                const p = sub[i];
                if (i > 0 && p[0] === firstPt[0] && p[1] === firstPt[1]) continue;
                pts.push(p);
            }
            if (pts.length < 2) continue;

            const positions = [];
            for (const p of pts) {
                positions.push(p[0] - groupPos.x, 0, p[1] - groupPos.z);
            }
            // Замыкание.
            positions.push(pts[0][0] - groupPos.x, 0, pts[0][1] - groupPos.z);

            if (this._useSimpleStroke) {
                const count = positions.length / 3;
                const existing = geom.getAttribute('position');
                if (existing && existing.count === count) {
                    existing.array.set(positions);
                    existing.needsUpdate = true;
                    geom.computeBoundingSphere();
                } else {
                    geom.setAttribute('position', new THREE.BufferAttribute(new Float32Array(positions), 3));
                    geom.computeBoundingSphere();
                }
            } else {
                if (positions.length > 0) {
                    geom.setPositions(positions);
                    line.computeLineDistances();
                }
            }
        }
    }

    /** @private */
    _updateCentroidScreenPos() {
        if (!this._map || !this._centroidWorld) {
            this._centroidScreenPos = null;
            return;
        }
        const map = this._map;
        const wgPos = map.worldGroup.position;
        const worldX = this._centroidWorld.x + wgPos.x;
        const worldZ = this._centroidWorld.z + wgPos.z;

        let worldY = this._altitudeOffset;
        if (this._altitudeMode === 'clampToGround' && map.hasElevation) {
            const now = performance.now();
            if (now - this._lastCentroidHeightUpdateTime > this._heightUpdateInterval) {
                map.ensureTileForPoint(worldX, worldZ);
                this._cachedCentroidHeight = map.getSurfaceHeightAt(worldX, worldZ);
                this._lastCentroidHeightUpdateTime = now;
            }
            worldY = (this._cachedCentroidHeight ?? 0) + this._altitudeOffset;
        }
        worldY += this._minHeight + (this._extruded ? this._height : 0);

        const screenPos = map.getVec3().set(worldX, worldY + wgPos.y, worldZ);
        screenPos.project(map.camera);
        if (screenPos.z > 1 || Math.abs(screenPos.x) > 1 || Math.abs(screenPos.y) > 1) {
            this._centroidScreenPos = null;
        } else {
            const canvas = map.renderer.domElement;
            this._centroidScreenPos = {
                x: (screenPos.x * 0.5 + 0.5) * canvas.clientWidth,
                y: (-screenPos.y * 0.5 + 0.5) * canvas.clientHeight
            };
        }
    }

    /* ================================================================
       Интерфейс для TextManager
       ================================================================ */

    getText() { return this._title; }

    getTextStyle() {
        return Object.assign({
            fontFamily: 'sans-serif',
            color: '#333',
            fontSize: '12px',
            textAlign: this._titleAlign
        }, this._titleStyle);
    }

    getTextZoomBounds() { return { min: this._titleMinZoom, max: this._titleMaxZoom }; }
    getLabelType() { return 'polygon'; }
    isVisible() { return this._group?.visible ?? false; }
    getScreenPosition() { return this._centroidScreenPos; }
    getTitleAlign() { return this._titleAlign; }
    getTitleOffset() { return this._titleOffset; }
    getTitleVerticalAlign() { return 'center'; }
    getAllowOverflow() { return this._titleAllowOverflow; }
    getPriority() { return this._titlePriority; }

    /* ================================================================
       getBounds (для KrbMap#fitTo)
       ================================================================ */

    getBounds(crs = 'EPSG:4326') {
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
            for (let i = 0; i < ring.length; i++) {
                const pt = ring[i];
                if (!pt || pt.length < 2) continue;
                let x, y;
                if (sameProjection) {
                    x = pt[0];
                    y = pt[1];
                } else {
                    const lonLat = src.toLonLat(pt);
                    const converted = dst.fromLonLat(lonLat);
                    x = converted[0];
                    y = converted[1];
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
    }
}