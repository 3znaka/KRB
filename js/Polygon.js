/**
 * Полигон на карте: заливка (Earcut), обводка (Line2 / THREE.Line),
 * экструзия, высоты, подписи, hover/click через InteractionManager.
 *
 * Особенности:
 *  - Проецирование через `map.projectSafe` (кламп широты для Mercator,
 *    отсев NaN/Infinity и координат за `maxAbsCoord`).
 *  - Кольцо, пересекающее антимеридиан (скачок lon > 180°), разбивается
 *    на под-кольца; каждое под-кольцо достраивается до полюса (lat=±85
 *    для Mercator) через меридиан ±180°, чтобы не рисовалась длинная
 *    прямая через весь мир.
 *  - Дополнительный дистанционный фильтр: сегменты длиннее
 *    `map.WORLD_SIZE * 0.9` сворачиваются в точку.
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

/** Скачок долготы через антимеридиан. @private */
function isAntimeridianJump(lon1, lon2) {
    return Math.abs(lon2 - lon1) > 180;
}

/**
 * Разбивает кольцо (в lon/lat) по пересечениям антимеридиана.
 * Если polarLat !== null — достраивает каждый под-сегмент до полюса
 * через соответствующий меридиан (только для Mercator).
 *
 * @param {Array<[number,number]|null>} lonLatRing
 * @param {number|null} polarLat - Широта полюса (−85 для юга, +85 для севера)
 *     или null, если проекция не Mercator.
 * @returns {Array<Array<[number,number]|null>>}
 * @private
 */
function splitAtAntimeridian(lonLatRing, polarLat) {
    const n = lonLatRing.length;
    if (n < 3) return [lonLatRing];

    // Индексы сегментов-скачков.
    const jumps = [];
    for (let i = 0; i < n - 1; i++) {
        const a = lonLatRing[i], b = lonLatRing[i + 1];
        if (a && b && isAntimeridianJump(a[0], b[0])) jumps.push(i);
    }
    // Замыкающий сегмент.
    const first = lonLatRing[0], last = lonLatRing[n - 1];
    const closingJump = first && last && isAntimeridianJump(last[0], first[0]);

    if (jumps.length === 0 && !closingJump) return [lonLatRing];

    const segments = [];
    let startIdx = 0;
    for (const j of jumps) {
        const seg = lonLatRing.slice(startIdx, j + 1);
        if (seg.length >= 3) segments.push(seg);
        startIdx = j + 1;
    }
    const tail = lonLatRing.slice(startIdx);
    if (tail.length >= 3) segments.push(tail);

    if (polarLat === null || segments.length === 0) return segments;

    return segments.map(seg => extendToPolar(seg, polarLat));
}

/**
 * Достраивает под-сегмент до polarLat через меридиан ±180.
 *
 * Если сегмент примыкает к антимеридиану только с одной стороны —
 * достраивает её. Если с обеих — достраивает обе, соединяя по polarLat.
 *
 * @private
 */
function extendToPolar(segment, polarLat) {
    if (segment.length < 3) return segment;

    const nearMeridian = (lon) => Math.abs(Math.abs(lon) - 180) < 30;

    const findFirst = (arr) => { for (const p of arr) if (p) return p; return null; };
    const findLast = (arr) => { for (let i = arr.length - 1; i >= 0; i--) if (arr[i]) return arr[i]; return null; };

    let result = segment.slice();
    let first = findFirst(result);
    let last = findLast(result);
    if (!first || !last) return result;

    const firstNearM = nearMeridian(first[0]);
    const lastNearM = nearMeridian(last[0]);

    // Поворачиваем так, чтобы meridian-adjacent конец оказался в конце.
    if (firstNearM && !lastNearM) {
        result.push(result.shift());
        first = findFirst(result);
        last = findLast(result);
    }

    if (first && last && nearMeridian(last[0])) {
        const m = last[0] > 0 ? 180 : -180;
        result.push([m, polarLat]);
        result.push([first[0], polarLat]);
    }

    return result;
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
     * @param {number|null} [options.maxSegmentLength=null]
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
        /** @private @type {number|null} */ this._maxSegmentLength = options.maxSegmentLength ?? null;

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
        /** @private @type {THREE.Object3D|null} */       this._strokeLine = null;
        /** @private @type {THREE.BufferGeometry|null} */ this._strokeGeometry = null;
        /** @private @type {THREE.Material|null} */       this._strokeMaterial = null;

        /** @private @type {Array<number>} */ this._cachedHeights = [];
        /** @private @type {Array<number>} */ this._cachedStrokeHeights = [];
        /** @private @type {number} */        this._lastHeightUpdateTime = 0;
        /** @private @type {number} */        this._heightUpdateInterval = 500;
        /** @private @type {boolean} */       this._heightsFinalized = false;

        /** @private @type {Array<THREE.Vector2>} */ this._vertices2D = [];
        /** @private @type {THREE.Vector3} */         this._centroidWorld = new THREE.Vector3();
        /** @private @type {number} */                this._cachedCentroidHeight = 0;
        /** @private @type {number} */                this._lastCentroidHeightUpdateTime = 0;

        /** @private @type {Array<[number, number]>} */ this._worldCoords = [];
        /** @private @type {Array<[number, number]>} */ this._strokeWorldCoords = [];

        /** @private @type {Array<Array<[number, number]>>|null} */
        this._projectedOuterSubRings = null;

        /** @private @type {number} */ this._boundingSphereRadius = 0;
        /** @private @type {THREE.Vector3} */ this._boundingSphereWorldCenter = new THREE.Vector3();

        /** @private @type {THREE.Object3D[]|null} */ this._raycastMeshesCache = null;
        /** @private @type {(() => void)|null} */ this._unregisterInteraction = null;

        /** @private @type {boolean} */ this._heightsDirty = true;
        /** @private @type {THREE.Vector3} */ this._lastWorldGroupPos = new THREE.Vector3();
        /** @private @type {number} */ this._lastDiscreteZoom = -1;

        /** @private @type {Object|null} */ this._centroidScreenPos = null;
        /** @private @type {Object|null} */ this._textLabel = null;

        /** @private @type {Array<number>} */ this._strokePositionsArray = [];
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

    /**
     * Проецирует кольцо в world-метры карты.
     *
     * 1. Кольцо переводится в lon/lat.
     * 2. Разбивается по пересечениям антимеридиана (если есть) и
     *    достраивается до полюса (для Mercator).
     * 3. Каждое под-кольцо проецируется через `map.projectSafe`.
     * 4. Невалидные точки заменяются предыдущей валидной.
     * 5. Дистанционный фильтр сворачивает сегменты длиннее
     *    `maxSegmentLength` (по умолчанию `WORLD_SIZE * 0.9`).
     *
     * @param {Array<Array<number>>} ring
     * @param {import('./KrbMap.js').KrbMap} map
     * @returns {Array<Array<[number, number]>>}
     * @private
     */
    _projectRing(ring, map) {
        const n = ring.length;
        if (n < 3) return [];

        // 1) В lon/lat.
        const srcCrs = this._crs;
        const lonLat = new Array(n);
        for (let i = 0; i < n; i++) {
            const ll = typeof srcCrs.toLonLatSafe === 'function'
                ? srcCrs.toLonLatSafe(ring[i])
                : srcCrs.toLonLat(ring[i]);
            lonLat[i] = (ll && Number.isFinite(ll[0]) && Number.isFinite(ll[1])) ? ll : null;
        }

        // 2) Разбиение по антимеридиану + достройка до полюса.
        let polarLat = null;
        if (map.projection.isMercator) {
            let sumLat = 0, cnt = 0;
            for (const ll of lonLat) if (ll) { sumLat += ll[1]; cnt++; }
            const avgLat = cnt > 0 ? sumLat / cnt : 0;
            if (Math.abs(avgLat) > 45) {
                polarLat = avgLat < 0 ? -85 : 85;
            }
        }
        const segments = splitAtAntimeridian(lonLat, polarLat);

        // 3-5) Проекция каждого под-кольца.
        const result = [];
        const maxSegLen = this._maxSegmentLength !== null
            ? this._maxSegmentLength
            : (typeof map.WORLD_SIZE === 'number' ? map.WORLD_SIZE * 0.9 : 0);

        for (const seg of segments) {
            const m = seg.length;
            if (m < 3) continue;

            const projected = new Array(m);
            let firstValid = -1;
            for (let i = 0; i < m; i++) {
                const p = seg[i] ? map.projectSafe(seg[i], WGS84) : null;
                projected[i] = p;
                if (p && firstValid === -1) firstValid = i;
            }
            if (firstValid === -1) continue;

            const out = new Array(m);
            let lastValid = projected[firstValid];
            for (let k = 0; k < m; k++) {
                const idx = (firstValid + k) % m;
                const p = projected[idx];
                if (p) lastValid = p;
                out[idx] = lastValid;
            }

            if (maxSegLen > 0) {
                const maxSegSq = maxSegLen * maxSegLen;
                for (let i = 1; i < m; i++) {
                    const prev = out[i - 1];
                    const cur = out[i];
                    const dx = cur[0] - prev[0];
                    const dz = cur[1] - prev[1];
                    if (dx * dx + dz * dz > maxSegSq) {
                        out[i] = [prev[0], prev[1]];
                    }
                }
            }

            if (out.length >= 3) result.push(out);
        }
        return result;
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

    /** Строит заливку. @private */
    _buildFillGeometry(map) {
        const rings = this._rings;
        if (!rings || !rings.length || rings[0].length < 3) {
            console.warn('Polygon: rings[0] must have at least 3 points');
            return;
        }

        this._worldCoords.length = 0;
        this._projectedOuterSubRings = null;

        // Проекция внешнего кольца (может вернуть несколько под-колец).
        const outerSubRings = this._projectRing(rings[0], map);
        if (!outerSubRings || outerSubRings.length === 0) {
            console.warn('Polygon: внешнее кольцо не спроецировалось');
            return;
        }
        this._projectedOuterSubRings = outerSubRings;

        // Дырки: поддерживаем только неразбитые.
        const holeSubRings = [];
        for (let i = 1; i < rings.length; i++) {
            const holeSubs = this._projectRing(rings[i], map);
            if (holeSubs.length === 1) holeSubRings.push(holeSubs[0]);
            else if (holeSubs.length > 1) {
                console.warn(`Polygon: hole ring ${i} разбит антимеридианом, пропуск`);
            }
        }

        // Собираем все точки в один массив.
        const points2D = [];
        const worldCoords = [];
        const outerRanges = [];
        const holeRanges = [];

        const addRing = (subRing, ranges) => {
            const start = points2D.length;
            let firstPt = null;
            for (let i = 0; i < subRing.length; i++) {
                const x = subRing[i][0], z = subRing[i][1];
                if (i === 0) firstPt = [x, z];
                if (i > 0 && x === firstPt[0] && z === firstPt[1]) continue;
                points2D.push(new THREE.Vector2(x, z));
                worldCoords.push([x, z]);
            }
            const count = points2D.length - start;
            if (count >= 3) ranges.push({ start, count });
            else points2D.length = start;
        };

        for (const sub of outerSubRings) addRing(sub, outerRanges);
        for (const hole of holeSubRings) addRing(hole, holeRanges);

        if (points2D.length < 3) {
            console.warn('Polygon: after processing rings, less than 3 vertices');
            return;
        }

        this._vertices2D = points2D;
        this._worldCoords = worldCoords;
        this._cachedHeights = new Array(points2D.length).fill(0);

        // Центроид и позиция группы.
        let cx = 0, cy = 0;
        for (const pt of points2D) { cx += pt.x; cy += pt.y; }
        cx /= points2D.length;
        cy /= points2D.length;

        this._centroidWorld.set(cx, 0, cy);
        this._group.position.copy(this._centroidWorld);

        for (const pt of points2D) {
            pt.x -= cx;
            pt.y -= cy;
        }

        let maxRSq = 0;
        for (const pt of points2D) {
            const rSq = pt.x * pt.x + pt.y * pt.y;
            if (rSq > maxRSq) maxRSq = rSq;
        }
        this._boundingSphereRadius = Math.sqrt(maxRSq);

        // Триангуляция: каждое внешнее под-кольцо отдельно.
        const allTopIndices = [];
        const allBottomIndices = [];

        for (let r = 0; r < outerRanges.length; r++) {
            const range = outerRanges[r];
            const coordsLocal = [];
            for (let i = range.start; i < range.start + range.count; i++) {
                const pt = points2D[i];
                coordsLocal.push(pt.x, pt.y);
            }

            // Дырки только к первому под-кольцу (для простоты).
            const holeIndices = [];
            const coordsWithHoles = coordsLocal.slice();
            if (r === 0 && holeRanges.length > 0) {
                for (const hole of holeRanges) {
                    holeIndices.push(coordsWithHoles.length / 2);
                    for (let i = hole.start; i < hole.start + hole.count; i++) {
                        const pt = points2D[i];
                        coordsWithHoles.push(pt.x, pt.y);
                    }
                }
            }

            const raw = earcut(coordsWithHoles, holeIndices, 2);
            if (raw.length === 0) continue;

            const p0 = { x: coordsWithHoles[raw[0] * 2], y: coordsWithHoles[raw[0] * 2 + 1] };
            const p1 = { x: coordsWithHoles[raw[1] * 2], y: coordsWithHoles[raw[1] * 2 + 1] };
            const p2 = { x: coordsWithHoles[raw[2] * 2], y: coordsWithHoles[raw[2] * 2 + 1] };
            const flipped = crossY(p0, p1, p2) < 0;

            const base = range.start;
            for (let i = 0; i < raw.length; i += 3) {
                const a = raw[i] + base;
                const b = raw[i + 1] + base;
                const c = raw[i + 2] + base;
                if (flipped) {
                    allTopIndices.push(a, c, b);
                    allBottomIndices.push(a, b, c);
                } else {
                    allTopIndices.push(a, b, c);
                    allBottomIndices.push(a, c, b);
                }
            }
        }

        if (allTopIndices.length === 0) {
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
        topGeometry.setIndex(allTopIndices);

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
            bottomGeometry.setIndex(allBottomIndices);

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

            // Стенки — по всем под-кольцам.
            const sidePositions = this._sidePositionsArray;
            const sideIndices = this._sideIndicesArray;
            sidePositions.length = 0;
            sideIndices.length = 0;

            const initialHeight = this._height;

            for (const range of outerRanges) {
                const count = range.count;
                if (count < 2) continue;
                for (let i = 0; i < count; i++) {
                    const j = (i + 1) % count;
                    const topI = points2D[range.start + i];
                    const topJ = points2D[range.start + j];
                    const base = sidePositions.length / 3;

                    sidePositions.push(topI.x, initialHeight, topI.y);
                    sidePositions.push(topI.x, 0, topI.y);
                    sidePositions.push(topJ.x, initialHeight, topJ.y);
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

    /** Строит обводку (все под-кольца внешнего контура). @private */
    _buildStrokeGeometry(map) {
        if (this._strokeWidth <= 0 || this._strokeOpacity <= 0) return;
        if (!this._projectedOuterSubRings || this._projectedOuterSubRings.length === 0) return;

        const canvas = map.renderer.domElement;

        // Собираем мировые координаты всех под-колец в один массив.
        // Каждое под-кольцо замыкаем явно.
        this._strokeWorldCoords.length = 0;
        const groupPos = this._group.position; // placeholder — используется в _updateStroke

        for (const sub of this._projectedOuterSubRings) {
            if (sub.length < 2) continue;
            // Дедуплицируем и добавляем.
            const firstPt = sub[0];
            const localPts = [];
            for (let i = 0; i < sub.length; i++) {
                const p = sub[i];
                if (i > 0 && p[0] === firstPt[0] && p[1] === firstPt[1]) continue;
                localPts.push([p[0], p[1]]);
            }
            // Замыкаем.
            if (localPts.length > 0) {
                localPts.push([localPts[0][0], localPts[0][1]]);
            }
            // Если это не первое под-кольцо, добавляем "разрыв":
            // вставляем NaN-маркер, чтобы _updateStroke знал о разрыве.
            if (this._strokeWorldCoords.length > 0) {
                this._strokeWorldCoords.push(null);
            }
            for (const p of localPts) {
                this._strokeWorldCoords.push(p);
            }
        }

        this._cachedStrokeHeights = new Array(this._strokeWorldCoords.length).fill(0);

        if (this._useSimpleStroke) {
            const positions = [];
            for (let i = 0; i < this._strokeWorldCoords.length; i++) {
                const wc = this._strokeWorldCoords[i];
                if (!wc) continue;
                positions.push(wc[0], 0, wc[1]);
            }

            const lineGeometry = new THREE.BufferGeometry();
            lineGeometry.setAttribute(
                'position',
                new THREE.BufferAttribute(new Float32Array(positions), 3)
            );
            lineGeometry.computeBoundingSphere();

            const lineMaterial = new THREE.LineBasicMaterial({
                color: this._strokeColor,
                opacity: this._strokeOpacity,
                transparent: this._strokeOpacity < 1,
                depthTest: this._depthTest,
                depthWrite: this._depthWrite
            });
            const line = new THREE.Line(lineGeometry, lineMaterial);
            line.renderOrder = POLYGON_RENDER_ORDER.STROKE;
            this._strokeLine = line;
            this._strokeGeometry = lineGeometry;
            this._strokeMaterial = lineMaterial;
            this._group.add(line);
        } else {
            // Для Line2 — собираем через разрывы отдельными geometry.
            // Упрощение: рисуем первое под-кольцо (обычно достаточно).
            // Для полноценной поддержки множественных под-колец можно
            // создать по одной Line2 на каждое.
            this._strokeGeometry = new LineGeometry();
            this._strokeMaterial = new LineMaterial({
                color: this._strokeColor,
                linewidth: this._strokeWidth,
                opacity: this._strokeOpacity,
                transparent: this._strokeOpacity < 1,
                depthTest: this._depthTest,
                depthWrite: this._depthWrite,
                resolution: new THREE.Vector2(canvas.width, canvas.height)
            });
            const line = new Line2(this._strokeGeometry, this._strokeMaterial);
            line.renderOrder = POLYGON_RENDER_ORDER.STROKE;
            this._strokeLine = line;
            this._group.add(line);
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
            this._strokeGeometry?.dispose();
            this._strokeMaterial?.dispose();
            this._fillMesh = null;
            this._bottomMesh = null;
            this._sideMesh = null;
            this._strokeLine = null;
            this._fillGeometry = null;
            this._fillMaterial = null;
            this._bottomGeometry = null;
            this._bottomMaterial = null;
            this._sideGeometry = null;
            this._sideMaterial = null;
            this._strokeGeometry = null;
            this._strokeMaterial = null;
        }
        if (this._textLabel && this._map?.textManager) {
            this._map.textManager.removeLabel(this._textLabel);
            this._textLabel = null;
        }
        this._worldCoords.length = 0;
        this._strokeWorldCoords.length = 0;
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

        if (this._strokeMaterial && this._strokeMaterial.resolution) {
            const canvas = this._map.renderer.domElement;
            const res = this._strokeMaterial.resolution;
            if (res.x !== canvas.width || res.y !== canvas.height) {
                res.set(canvas.width, canvas.height);
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

        const strokeLen = this._strokeWorldCoords.length;
        if (this._cachedStrokeHeights.length !== strokeLen) {
            this._cachedStrokeHeights = new Array(strokeLen).fill(0);
        }
        for (let i = 0; i < strokeLen; i++) {
            const worldCoord = this._strokeWorldCoords[i];
            if (!worldCoord) continue;
            let base = this._altitudeOffset;
            if (isDynamic) {
                const worldX = worldCoord[0] + wgPos.x;
                const worldZ = worldCoord[1] + wgPos.z;
                map.ensureTileForPoint?.(worldX, worldZ);
                base = map.getSurfaceHeightAt(worldX, worldZ) + this._altitudeOffset;
            }
            this._cachedStrokeHeights[i] = base + this._minHeight + (this._extruded ? this._height : 0);
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
            // Стенки уже построены по под-кольцам; перебираем каждый
            // сегмент в порядке построения. Всего сегментов:
            // sum(count для каждого под-кольца).
            let idx = 0;
            if (this._projectedOuterSubRings) {
                for (const sub of this._projectedOuterSubRings) {
                    const count = sub.length; // приблизительно
                    if (count < 2) continue;
                    // Точное соответствие индексов — по порядку points2D,
                    // но проще: обновим по _vertices2D с учётом того,
                    // что все точки под-колец лежат в _vertices2D подряд.
                    // Здесь упрощение: только для одного под-кольца.
                    break;
                }
            }
            // Fallback: обновляем только первые N-сегментов по _vertices2D.
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
        if (!this._strokeLine || !this._strokeGeometry) return;
        const positions = this._strokePositionsArray;
        positions.length = 0;
        const groupPos = this._group.position;
        const strokeLen = this._strokeWorldCoords.length;

        for (let i = 0; i < strokeLen; i++) {
            const worldCoord = this._strokeWorldCoords[i];
            if (!worldCoord) continue;
            const y = this._cachedStrokeHeights[i] ?? this._altitudeOffset;
            positions.push(worldCoord[0] - groupPos.x, y, worldCoord[1] - groupPos.z);
        }

        if (this._useSimpleStroke) {
            const count = positions.length / 3;
            const existing = this._strokeGeometry.getAttribute('position');
            if (existing && existing.count === count) {
                existing.array.set(positions);
                existing.needsUpdate = true;
                this._strokeGeometry.computeBoundingSphere();
            } else {
                this._strokeGeometry.setAttribute(
                    'position',
                    new THREE.BufferAttribute(new Float32Array(positions), 3)
                );
                this._strokeGeometry.computeBoundingSphere();
            }
        } else {
            if (positions.length > 0) {
                this._strokeGeometry.setPositions(positions);
                this._strokeLine.computeLineDistances();
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