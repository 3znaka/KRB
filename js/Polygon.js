/**
 * Полигон на карте: заливка (Earcut), обводка (Line2 / THREE.Line),
 * экструзия, высоты, подписи, hover/click.
 *
 * Проецирование:
 *  1. Кольцо переводится в lon/lat.
 *  2. Долгота «разворачивается» (un-wrap): если соседние точки прыгают
 *     через антимеридиан (> 180°), к последующей прибавляется ±360°.
 *     Это убирает «усы» — сегменты длиной в ширину мира через сцену.
 *  3. Каждая точка проецируется через `map.projectSafe`.
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

        /** @private @type {Array<[number, number]>|null} */
        this._projectedOuterRing = null;

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
     * Проецирует кольцо в world-метры карты с un-wrap долготы.
     *
     * 1) Кольцо переводится в lon/lat.
     * 2) Долгота разворачивается по обходу: если скачок > 180°, к
     *    последующей точке прибавляется ±360°. Это склеивает обход
     *    через антимеридиан (Антарктида и т.п.) в непрерывную кривую.
     * 3) Каждая точка проецируется через `map.projectSafe`.
     * 4) Невалидные точки заменяются предыдущей валидной (циклически).
     *
     * @param {Array<Array<number>>} ring
     * @param {import('./KrbMap.js').KrbMap} map
     * @returns {Array<[number, number]>|null}
     * @private
     */
    _projectRing(ring, map) {
        const n = ring.length;
        if (n < 3) return null;

        const srcCrs = this._crs;

        // 1) В lon/lat с un-wrap долготы.
        const lonLat = [];
        let prevLon = null;
        for (let i = 0; i < n; i++) {
            const ll = typeof srcCrs.toLonLatSafe === 'function'
                ? srcCrs.toLonLatSafe(ring[i])
                : srcCrs.toLonLat(ring[i]);
            if (!ll || !Number.isFinite(ll[0]) || !Number.isFinite(ll[1])) continue;

            let lon = ll[0];
            if (prevLon !== null) {
                while (lon - prevLon > 180)  lon -= 360;
                while (lon - prevLon < -180) lon += 360;
            }
            lonLat.push([lon, ll[1]]);
            prevLon = lon;
        }
        if (lonLat.length < 3) return null;

        // 2) Проекция. Если точки уже в СК карты — широту всё равно
        //    разворачивать не надо, а вот долготу — возможно.
        const m = lonLat.length;
        const projected = new Array(m);
        let firstValid = -1;
        for (let i = 0; i < m; i++) {
            const p = map.projectSafe(lonLat[i], WGS84);
            projected[i] = p;
            if (p && firstValid === -1) firstValid = i;
        }
        if (firstValid === -1) return null;

        // 3) Замена невалидных.
        const out = new Array(m);
        let lastValid = projected[firstValid];
        for (let k = 0; k < m; k++) {
            const idx = (firstValid + k) % m;
            const p = projected[idx];
            if (p) lastValid = p;
            out[idx] = lastValid;
        }

        return out;
    }

    /** Строит заливку (Earcut) и — для extruded — нижнюю крышку и стенки. @private */
    _buildFillGeometry(map) {
        const rings = this._rings;
        if (!rings || !rings.length || rings[0].length < 3) {
            console.warn('Polygon: rings[0] must have at least 3 points');
            return;
        }

        this._worldCoords.length = 0;
        this._projectedOuterRing = null;
        const coords = [];
        const points2D = [];
        const holeIndices = [];
        const ringStartIndices = [];

        for (let ringIdx = 0; ringIdx < rings.length; ringIdx++) {
            const rawRing = rings[ringIdx];
            if (rawRing.length < 3) {
                console.warn(`Polygon: ring ${ringIdx} must have at least 3 points`);
                if (ringIdx === 0) return;
                continue;
            }

            const projected = this._projectRing(rawRing, map);
            if (!projected || projected.length < 3) {
                console.warn(`Polygon: ring ${ringIdx} — все точки невалидны, пропуск`);
                if (ringIdx === 0) return;
                continue;
            }

            if (ringIdx === 0) this._projectedOuterRing = projected;

            ringStartIndices.push(points2D.length);
            if (ringIdx > 0) holeIndices.push(coords.length / 2);

            let firstPoint = null;
            for (let i = 0; i < projected.length; i++) {
                const absX = projected[i][0];
                const absZ = projected[i][1];
                if (i === 0) firstPoint = [absX, absZ];
                if (i > 0 && absX === firstPoint[0] && absZ === firstPoint[1]) continue;
                coords.push(absX, absZ);
                points2D.push(new THREE.Vector2(absX, absZ));
                this._worldCoords.push([absX, absZ]);
            }
        }

        if (points2D.length < 3) {
            console.warn('Polygon: after processing rings, less than 3 vertices');
            return;
        }

        this._vertices2D = points2D;
        this._cachedHeights = new Array(points2D.length).fill(0);

        let indices;
        if (this._useWorkerForTriangulation && typeof Worker !== 'undefined') {
            console.warn('Worker triangulation is experimental, falling back to sync');
            indices = earcut(coords, holeIndices, 2);
        } else {
            indices = earcut(coords, holeIndices, 2);
        }

        if (indices.length === 0) {
            console.warn('Polygon: Earcut returned no triangles');
            return;
        }

        const firstCrossY = crossY(points2D[indices[0]], points2D[indices[1]], points2D[indices[2]]);
        const topIndices = firstCrossY >= 0 ? indices : this._flipIndices(indices);
        const bottomIndices = this._flipIndices(topIndices);

        let cx = 0, cy = 0;
        for (const pt of points2D) { cx += pt.x; cy += pt.y; }
        cx /= points2D.length;
        cy /= points2D.length;

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

        // Верхняя крышка.
        const topGeometry = new THREE.BufferGeometry();
        const topPosArray = new Float32Array(points2D.length * 3);
        for (let i = 0; i < points2D.length; i++) {
            const pt = points2D[i];
            topPosArray[i * 3] = pt.x;
            topPosArray[i * 3 + 1] = 0;
            topPosArray[i * 3 + 2] = pt.y;
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
                const pt = points2D[i];
                bottomPosArray[i * 3] = pt.x;
                bottomPosArray[i * 3 + 1] = 0;
                bottomPosArray[i * 3 + 2] = pt.y;
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

            for (let ringIdx = 0; ringIdx < rings.length; ringIdx++) {
                if (ringStartIndices[ringIdx] === undefined) continue;

                const start = ringStartIndices[ringIdx];
                const nextRingStart = (ringIdx + 1 < ringStartIndices.length)
                    ? ringStartIndices[ringIdx + 1]
                    : points2D.length;
                const count = nextRingStart - start;

                if (count < 2) continue;

                for (let i = 0; i < count; i++) {
                    const j = (i + 1) % count;
                    const topI = points2D[start + i];
                    const topJ = points2D[start + j];
                    const baseIndex = sidePositions.length / 3;

                    sidePositions.push(topI.x, this._height, topI.y);
                    sidePositions.push(topI.x, 0, topI.y);
                    sidePositions.push(topJ.x, this._height, topJ.y);
                    sidePositions.push(topJ.x, 0, topJ.y);

                    sideIndices.push(baseIndex, baseIndex + 1, baseIndex + 2);
                    sideIndices.push(baseIndex + 1, baseIndex + 3, baseIndex + 2);
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

    /** Строит обводку по внешнему кольцу. @private */
    _buildStrokeGeometry(map) {
        if (this._strokeWidth <= 0 || this._strokeOpacity <= 0) return;

        const canvas = map.renderer.domElement;
        const projected = this._projectedOuterRing;

        if (!projected || projected.length < 2) {
            this._strokeWorldCoords.length = 0;
            this._cachedStrokeHeights = [];
            return;
        }

        this._strokeWorldCoords.length = 0;
        const first = projected[0];
        for (let i = 0; i < projected.length; i++) {
            const p = projected[i];
            if (i > 0 && p[0] === first[0] && p[1] === first[1]) continue;
            this._strokeWorldCoords.push([p[0], p[1]]);
        }
        this._cachedStrokeHeights = new Array(this._strokeWorldCoords.length).fill(0);

        if (this._useSimpleStroke) {
            const positions = [];
            for (let i = 0; i < this._strokeWorldCoords.length; i++) {
                const wc = this._strokeWorldCoords[i];
                positions.push(wc[0], 0, wc[1]);
            }
            if (this._strokeWorldCoords.length > 0) {
                const f = this._strokeWorldCoords[0];
                positions.push(f[0], 0, f[1]);
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
        }
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

        if (this._textLabel && this._map?.textManager) {
            this._map.textManager.removeLabel(this._textLabel);
            this._textLabel = null;
        }
        this._worldCoords.length = 0;
        this._strokeWorldCoords.length = 0;
        this._projectedOuterRing = null;
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

        if (strokeLen > 0) {
            const first = this._strokeWorldCoords[0];
            const fy = this._cachedStrokeHeights[0] ?? this._altitudeOffset;
            positions.push(first[0] - groupPos.x, fy, first[1] - groupPos.z);
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