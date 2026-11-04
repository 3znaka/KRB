/**
 * Polygon — полигон с заливкой, обводкой, экструзией, паттерном и подписью.
 * После `addTo()` мутабелен.
 *
 * Наследует SpatialObject: zoom bounds, видимость, tooltip, onClick,
 * onHover, подпись, TextManager-контракт и altitude берутся из базы.
 *
 * @module polygon
 */

import { Projections } from './Projections.js';
import { THREE, Line2, LineMaterial, LineGeometry } from './js_TP/tpb.js';
import { SpatialObject, TitleAlignH, ZoomInterpolation } from './SpatialObject.js';
import earcut from './js_TP/earcut.js';

// =====================================================================
// Типы
// =====================================================================

export type LonLat = [number, number];
export type PolygonCoord = [number, number] | [number, number, number];
export type PolygonRing = PolygonCoord[];
export type TitleAlign = TitleAlignH;
export type AltitudeMode = 'clampToGround' | 'absolute';
export type FillPatternSource =
    | string
    | HTMLImageElement
    | HTMLCanvasElement
    | null;

export interface PolygonOptions {
    rings: PolygonRing[];
    crs?: string;
    fillColor?: string | number;
    fillOpacity?: number;
    /** Текстура заливки: URL, Image или Canvas. Тайлится в world-координатах. */
    fillPattern?: FillPatternSource;
    /** Сколько world-метров на одну плитку паттерна. Default: 64. */
    fillPatternScale?: number;
    strokeColor?: string | number;
    strokeWidth?: number;
    strokeOpacity?: number;
    altitudeMode?: AltitudeMode;
    altitude?: number;
    /** @deprecated Используйте `altitude`. */
    altitudeOffset?: number;
    extruded?: boolean;
    height?: number;
    minHeight?: number;
    depthTest?: boolean;
    depthWrite?: boolean;
    castShadow?: boolean;
    receiveShadow?: boolean;
    roughness?: number;
    metalness?: number;
    minZoom?: number;
    maxZoom?: number;
    title?: string;
    titleOffset?: [number, number];
    titleAlign?: TitleAlign;
    titleStyle?: Record<string, string | number>;
    titleMinZoom?: number;
    titleMaxZoom?: number;
    titleAllowOverflow?: boolean;
    titlePriority?: number;
    onClick?: (event: MouseEvent, polygon: Polygon) => void;
    onHover?: (hovered: boolean) => void;
    tooltip?: string;
    useSimpleStroke?: boolean;
    useWorkerForTriangulation?: boolean;
    properties?: Record<string, any>;
    userData?: Record<string, any>;
    zoomInterpolate?: ZoomInterpolation | null;
}

export interface PolygonRenderOrder {
    BOTTOM: number;
    SIDE: number;
    TOP: number;
    STROKE: number;
}

export const POLYGON_RENDER_ORDER: PolygonRenderOrder = {
    BOTTOM: 900,
    SIDE:   901,
    TOP:    902,
    STROKE: 903,
};

const INVALID_EDGE_FRACTION = 8;
const DEFAULT_FILL_PATTERN_SCALE = 64;

function crossY(p0: any, p1: any, p2: any): number {
    const dx1 = p1.x - p0.x, dz1 = p1.y - p0.y;
    const dx2 = p2.x - p0.x, dz2 = p2.y - p0.y;
    return dz1 * dx2 - dx1 * dz2;
}

// =====================================================================
// Polygon
// =====================================================================

export class Polygon extends SpatialObject {
    // ── Кольца / CRS ──
    private _rings: PolygonRing[];
    private _crsCode: string | null;
    private _crs: any | null;

    // ── Оформление ──
    private _fillColor: string | number;
    private _fillOpacity: number;
    private _fillPatternSource: FillPatternSource;
    private _fillPatternScale: number;
    private _fillPatternTexture: any = null;
    private _strokeColor: string | number;
    private _strokeWidth: number;
    private _strokeOpacity: number;
    private _altitudeMode: AltitudeMode;

    private _extruded: boolean;
    private _height: number;
    private _minHeight: number;
    private _depthTest: boolean;
    private _depthWrite: boolean;
    private _castShadow: boolean;
    private _receiveShadow: boolean;
    private _roughness: number;
    private _metalness: number;

    private _useSimpleStroke: boolean;
    private _useWorkerForTriangulation: boolean;

    // ── Интерактив ──
    private _unregisterInteraction: (() => void) | null = null;

    // ── 3D-объекты ──
    private _group: any;

    private _fillMesh: any = null;
    private _fillGeometry: any = null;
    private _fillMaterial: any = null;
    private _bottomMesh: any = null;
    private _bottomGeometry: any = null;
    private _bottomMaterial: any = null;
    private _sideMesh: any = null;
    private _sideGeometry: any = null;
    private _sideMaterial: any = null;
    private _strokeLine: any = null;
    private _strokeGeometry: any = null;
    private _strokeMaterial: any = null;

    // ── Кэши ──
    private _cachedHeights: number[];
    private _cachedStrokeHeights: number[];
    private _nodeHeights: number[] = [];
    private _strokeNodeHeights: number[] = [];
    private _lastHeightUpdateTime = 0;
    private _heightUpdateInterval = 500;
    private _heightsFinalized = false;
    private _invalidGeometry = false;

    private _vertices2D: any[] = [];
    private _centroidWorld: any;
    private _cachedCentroidHeight = 0;
    private _lastCentroidHeightUpdateTime = 0;

    private _worldCoords: Array<[number, number]> = [];
    private _strokeWorldCoords: Array<[number, number]> = [];

    private _boundingSphereRadius = 0;
    private _boundingSphereWorldCenter: any;
    private _raycastMeshesCache: any[] | null = null;

    private _heightsDirty = true;
    private _lastWorldGroupPos: any;
    private _lastDiscreteZoom = -1;

    private _centroidScreenPos: { x: number; y: number } | null = null;

    private _strokePositionsArray: number[] = [];
    private _sidePositionsArray: number[] = [];
    private _sideIndicesArray: number[] = [];

    constructor(options: PolygonOptions) {
        super();

        this._properties = options.properties ?? {};
        this._userData = options.userData ?? {};

        if (!options.rings || !options.rings.length || !options.rings[0].length) {
            throw new Error('Polygon: options.rings required with at least one ring');
        }

        this._rings = options.rings;
        this._crsCode = options.crs ?? null;
        this._crs = null;

        this._fillColor = options.fillColor ?? '#3388ff';
        this._fillOpacity = options.fillOpacity ?? 0.5;
        this._fillPatternSource = options.fillPattern ?? null;
        this._fillPatternScale = options.fillPatternScale ?? DEFAULT_FILL_PATTERN_SCALE;
        this._strokeColor = options.strokeColor ?? '#000000';
        this._strokeWidth = options.strokeWidth ?? 2;
        this._strokeOpacity = options.strokeOpacity ?? 1;
        this._altitudeMode = options.altitudeMode ?? 'clampToGround';

        this._altitude = options.altitude ?? options.altitudeOffset ?? 10;

        this._extruded = options.extruded ?? false;
        this._height = options.height ?? 0;
        this._minHeight = options.minHeight ?? 0;
        if (this._extruded && (typeof this._height !== 'number' || this._height <= 0)) {
            throw new Error('Polygon: options.height must be a positive number when extruded is true');
        }

        this._depthTest = options.depthTest ?? this._extruded;
        this._depthWrite = options.depthWrite ?? this._extruded;

        this._minZoom = options.minZoom ?? -Infinity;
        this._maxZoom = options.maxZoom ?? Infinity;
        this._useSimpleStroke = options.useSimpleStroke ?? false;
        this._useWorkerForTriangulation = options.useWorkerForTriangulation ?? false;

        this._castShadow = options.castShadow ?? true;
        this._receiveShadow = options.receiveShadow ?? true;
        this._roughness = options.roughness ?? 0.8;
        this._metalness = options.metalness ?? 0.0;

        this._title = options.title ?? '';
        this._titleStyle = options.titleStyle ?? {};
        this._titleMinZoom = options.titleMinZoom ?? -Infinity;
        this._titleMaxZoom = options.titleMaxZoom ?? Infinity;
        this._titleAlign = options.titleAlign ?? 'center';
        this._userTitleOffset = options.titleOffset ? [...options.titleOffset] : null;
        this._titleAllowOverflow = options.titleAllowOverflow ?? false;
        this._titlePriority = options.titlePriority ?? 0;

        this._onClick = options.onClick ?? null;
        this._onHover = options.onHover ?? null;
        this._tooltipText = options.tooltip ?? '';
    if (options.zoomInterpolate) this.setZoomInterpolations(options.zoomInterpolate);
        this._group = new THREE.Group();
        this._centroidWorld = new THREE.Vector3();
        this._boundingSphereWorldCenter = new THREE.Vector3();
        this._lastWorldGroupPos = new THREE.Vector3();

        const initialLen = this._rings[0]?.length ?? 0;
        this._cachedHeights = new Array(initialLen).fill(0);
        this._cachedStrokeHeights = new Array(initialLen).fill(0);
    }

    // =================================================================
    // Хуки SpatialObject
    // =================================================================

    protected _onAttached(map: any): void {
        this._crs = this._crsCode
            ? Projections.get(this._crsCode)
            : map.inputCRS;

        this._loadFillPattern();
        this._buildFillGeometry(map);
        this._buildStrokeGeometry(map);
        map.worldGroup.add(this._group);

        this._registerInteraction(map);

        this._lastWorldGroupPos.copy(map.worldGroup.position);
        this._lastDiscreteZoom = map.currentDiscreteZoom;
        this._heightsDirty = true;
        this._heightsFinalized = false;
        this._lastHeightUpdateTime = 0;
        this._lastCentroidHeightUpdateTime = 0;
    }

    protected _teardown(): void {
        if (this._unregisterInteraction) {
            this._unregisterInteraction();
            this._unregisterInteraction = null;
        }
        this._disposeMeshes();
        if (this._group.parent) this._group.parent.remove(this._group);

        if (this._fillPatternTexture) {
            try { this._fillPatternTexture.dispose?.(); } catch { /* swallow */ }
            this._fillPatternTexture = null;
        }

        this._worldCoords.length = 0;
        this._strokeWorldCoords.length = 0;
        this._nodeHeights.length = 0;
        this._strokeNodeHeights.length = 0;
        this._vertices2D = [];
        this._boundingSphereRadius = 0;
        this._cachedHeights = [];
        this._cachedStrokeHeights = [];
        this._raycastMeshesCache = null;
        this._invalidGeometry = false;
        this._centroidScreenPos = null;
        this._crs = null;
    }

    protected _applyHidden(): void {
        if (this._group) this._group.visible = false;
        this._centroidScreenPos = null;
    }

    protected _onTooltipChanged(): void {
        if (this._map) this._registerInteraction(this._map);
    }

    protected _onAltitudeChanged(): void {
        this._heightsDirty = true;
        this._heightsFinalized = false;
        this._lastHeightUpdateTime = 0;
        this._lastCentroidHeightUpdateTime = 0;
    }

    getLabelType(): 'polygon' { return 'polygon'; }

    getScreenPosition(): { x: number; y: number } | null {
        return this._centroidScreenPos;
    }

    isVisible(): boolean {
        return this._group?.visible ?? false;
    }

    // =================================================================
    // Интерактив
    // =================================================================

    private _registerInteraction(map: any): void {
        if (!map.interaction || typeof map.interaction.register !== 'function') return;
        if (this._unregisterInteraction) {
            this._unregisterInteraction();
            this._unregisterInteraction = null;
        }
        if (this._invalidGeometry) return;
        if (!this._onClick && !this._onHover && !this._tooltipText) return;

        const callbacks: Record<string, any> = {
            getMeshes: () => this._getRaycastMeshes(),
            getBoundingSphere: () => {
                if (this._boundingSphereRadius <= 0) return null;
                const wgPos = map.worldGroup.position;
                this._boundingSphereWorldCenter.set(
                    this._group.position.x + wgPos.x,
                    this._group.position.y + wgPos.y,
                    this._group.position.z + wgPos.z
                );
                return {
                    center: this._boundingSphereWorldCenter,
                    radius: this._boundingSphereRadius,
                };
            },
            isVisible: () => this._group.visible,
        };

        if (this._onHover) {
            callbacks.onHover = (isHovered: boolean) => this._onHover!(isHovered);
        } else if (this._tooltipText) {
            callbacks.getTooltip = () => this._tooltipText;
        }

        if (this._onClick) {
            callbacks.onClick = (event: MouseEvent) => this._onClick!(event, this);
        }

        this._unregisterInteraction = map.interaction.register(this, callbacks);
    }

    private _getRaycastMeshes(): any[] {
        if (this._raycastMeshesCache) return this._raycastMeshesCache;
        const meshes: any[] = [];
        if (this._fillMesh) meshes.push(this._fillMesh);
        if (this._sideMesh) meshes.push(this._sideMesh);
        if (this._bottomMesh) meshes.push(this._bottomMesh);
        this._raycastMeshesCache = meshes;
        return meshes;
    }

    // =================================================================
    // Кольца
    // =================================================================

    setRings(rings: PolygonRing[]): this {
        if (!rings || !rings.length || rings[0].length < 3) {
            console.warn('Polygon.setRings: need at least one ring with 3+ points');
            return this;
        }
        this._rings = rings;
        if (!this._map) return this;
        this._rebuildGeometry();
        return this;
    }

    getRings(): PolygonRing[] {
        return this._rings.map(ring => ring.map(pt => [...pt] as PolygonCoord));
    }

    private _rebuildGeometry(): void {
        if (!this._map) return;
        this._disposeMeshes();

        this._worldCoords.length = 0;
        this._strokeWorldCoords.length = 0;
        this._nodeHeights.length = 0;
        this._strokeNodeHeights.length = 0;
        this._vertices2D = [];
        this._invalidGeometry = false;

        this._buildFillGeometry(this._map);
        this._buildStrokeGeometry(this._map);

        this._registerInteraction(this._map);

        this._lastWorldGroupPos.copy(this._map.worldGroup.position);
        this._lastDiscreteZoom = this._map.currentDiscreteZoom;
        this._heightsDirty = true;
        this._heightsFinalized = false;
        this._lastHeightUpdateTime = 0;
        this._lastCentroidHeightUpdateTime = 0;
    }

    private _disposeMeshes(): void {
        if (this._group) {
            while (this._group.children.length > 0) {
                this._group.remove(this._group.children[0]);
            }
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
    }

    // =================================================================
    // Fill pattern
    // =================================================================

    private _loadFillPattern(): void {
        const src = this._fillPatternSource;
        if (!src) {
            this._fillPatternTexture = null;
            return;
        }

        if (typeof src === 'string') {
            const loader = new THREE.TextureLoader();
            loader.setCrossOrigin('anonymous');
            this._fillPatternTexture = loader.load(
                src,
                () => {
                    this._configureFillPatternTexture();
                    this._applyFillPatternToMaterials();
                },
                undefined,
                (err: any) => console.warn('Polygon: fillPattern load failed', err),
            );
            this._configureFillPatternTexture();
        } else if (typeof HTMLCanvasElement !== 'undefined' && src instanceof HTMLCanvasElement) {
            this._fillPatternTexture = new THREE.CanvasTexture(src);
            this._configureFillPatternTexture();
        } else {
            this._fillPatternTexture = new THREE.Texture(src as any);
            this._fillPatternTexture.needsUpdate = true;
            this._configureFillPatternTexture();
        }
    }

    private _configureFillPatternTexture(): void {
        const t = this._fillPatternTexture;
        if (!t) return;
        t.wrapS = THREE.RepeatWrapping;
        t.wrapT = THREE.RepeatWrapping;
        t.needsUpdate = true;
    }

    private _applyFillPatternToMaterials(): void {
        const map = this._fillPatternTexture;
        for (const mat of [this._fillMaterial, this._bottomMaterial, this._sideMaterial]) {
            if (!mat) continue;
            mat.map = map;
            mat.needsUpdate = true;
        }
    }

    // =================================================================
    // Построение геометрии
    // =================================================================

    private _createSurfaceMaterial(): any {
        const isTransparent = this._fillOpacity < 1;
        const map = this._fillPatternTexture;
        const patternProps = map ? { map } : {};

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
                polygonOffsetUnits: -1,
                ...patternProps,
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
            polygonOffsetUnits: -1,
            ...patternProps,
        });
    }

    private _applyShadowFlags(mesh: any): void {
        if (!mesh) return;
        if (this._extruded) {
            mesh.castShadow = this._castShadow;
            mesh.receiveShadow = this._receiveShadow;
        } else {
            mesh.castShadow = false;
            mesh.receiveShadow = false;
        }
    }

    private _flipIndices(indices: number[]): number[] {
        const result = new Array(indices.length);
        for (let i = 0; i < indices.length; i += 3) {
            result[i] = indices[i];
            result[i + 1] = indices[i + 2];
            result[i + 2] = indices[i + 1];
        }
        return result;
    }

    private _hasAntimeridianWrap(): boolean {
        if (!this._crs || !this._crs.isGeographic) return false;
        const rings = this._rings;
        if (!rings) return false;
        for (let r = 0; r < rings.length; r++) {
            const ring = rings[r];
            if (!ring || ring.length < 2) continue;
            const n = ring.length;
            for (let i = 0; i < n; i++) {
                const a = ring[i];
                const b = ring[(i + 1) % n];
                if (!a || !b || a.length < 2 || b.length < 2) continue;
                if (Math.abs(b[0] - a[0]) > 180) return true;
            }
        }
        return false;
    }

    private _isGeometryInvalid(ringStartIndices: number[], worldSize: number): boolean {
        const maxEdge = worldSize / INVALID_EDGE_FRACTION;
        const maxEdgeSq = maxEdge * maxEdge;
        const wc = this._worldCoords;

        for (let ringIdx = 0; ringIdx < ringStartIndices.length; ringIdx++) {
            const start = ringStartIndices[ringIdx];
            if (start === undefined) continue;
            const nextStart = (ringIdx + 1 < ringStartIndices.length)
                ? ringStartIndices[ringIdx + 1]
                : wc.length;
            const count = nextStart - start;
            if (count < 2) continue;

            for (let i = 0; i < count; i++) {
                const a = wc[start + i];
                const b = wc[start + ((i + 1) % count)];
                if (!a || !b) continue;
                const dx = b[0] - a[0];
                const dz = b[1] - a[1];
                if (dx * dx + dz * dz > maxEdgeSq) return true;
            }
        }
        return false;
    }

    private _buildFillGeometry(map: any): void {
        const rings = this._rings;
        if (!rings || !rings.length || rings[0].length < 3) {
            console.warn('Polygon: rings[0] must have at least 3 points');
            return;
        }

        this._worldCoords.length = 0;
        this._nodeHeights.length = 0;
        const coords: number[] = [];
        const points2D: any[] = [];
        const holeIndices: number[] = [];
        const ringStartIndices: number[] = [];

        for (let ringIdx = 0; ringIdx < rings.length; ringIdx++) {
            const ring = rings[ringIdx];
            if (ring.length < 3) {
                console.warn(`Polygon: hole ring ${ringIdx} must have at least 3 points`);
                continue;
            }

            ringStartIndices.push(points2D.length);
            if (ringIdx > 0) {
                holeIndices.push(coords.length / 2);
            }

            let firstPoint: [number, number] | null = null;
            for (let i = 0; i < ring.length; i++) {
                const pt = ring[i];
                const [absX, absZ] = map.project(pt, this._crs);
                if (i === 0) firstPoint = [absX, absZ];
                if (i > 0 && firstPoint && absX === firstPoint[0] && absZ === firstPoint[1]) continue;
                coords.push(absX, absZ);
                points2D.push(new THREE.Vector2(absX, absZ));
                this._worldCoords.push([absX, absZ]);

                const h = pt?.[2];
                this._nodeHeights.push(Number.isFinite(h) ? h! : 0);
            }
        }

        if (points2D.length < 3) {
            console.warn('Polygon: after processing rings, less than 3 vertices');
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
        const topIndices = firstCrossY >= 0 ? indices : this._flipIndices(indices);
        const bottomIndices = this._flipIndices(topIndices);

        let cx = 0, cy = 0;
        for (const pt of points2D) {
            cx += pt.x;
            cy += pt.y;
        }
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

        // UV — из абсолютных world-координат, чтобы паттерн тайлился
        // бесшовно между соседними полигонами.
        const uvScale = this._fillPatternScale > 0
            ? this._fillPatternScale
            : DEFAULT_FILL_PATTERN_SCALE;
        const topUVs = new Float32Array(points2D.length * 2);
        for (let i = 0; i < points2D.length; i++) {
            const wc = this._worldCoords[i];
            topUVs[i * 2]     = (wc ? wc[0] : 0) / uvScale;
            topUVs[i * 2 + 1] = (wc ? wc[1] : 0) / uvScale;
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
        topGeometry.setAttribute('uv',       new THREE.BufferAttribute(topUVs, 2));
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
            const bottomGeometry = new THREE.BufferGeometry();
            const bottomPosArray = new Float32Array(points2D.length * 3);
            for (let i = 0; i < points2D.length; i++) {
                const pt = points2D[i];
                bottomPosArray[i * 3] = pt.x;
                bottomPosArray[i * 3 + 1] = 0;
                bottomPosArray[i * 3 + 2] = pt.y;
            }
            bottomGeometry.setAttribute('position', new THREE.BufferAttribute(bottomPosArray, 3));
            // DoubleSide — UV можно переиспользовать с top.
            bottomGeometry.setAttribute('uv',       new THREE.BufferAttribute(topUVs.slice(), 2));
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

            const sidePositions = this._sidePositionsArray;
            const sideIndices = this._sideIndicesArray;
            sidePositions.length = 0;
            sideIndices.length = 0;

            const sideUVs: number[] = [];
            const sideUvScale = uvScale;

            const initialHeight = this._height;

            for (let ringIdx = 0; ringIdx < rings.length; ringIdx++) {
                if (ringStartIndices[ringIdx] === undefined) continue;
                const start = ringStartIndices[ringIdx];
                const nextRingStart = (ringIdx + 1 < ringStartIndices.length)
                    ? ringStartIndices[ringIdx + 1]
                    : points2D.length;
                const count = nextRingStart - start;
                if (count < 2) continue;

                let cum = 0;
                for (let i = 0; i < count; i++) {
                    const j = (i + 1) % count;
                    const idxI = start + i;
                    const idxJ = start + j;
                    const topI = points2D[idxI];
                    const topJ = points2D[idxJ];
                    const baseIndex = sidePositions.length / 3;

                    sidePositions.push(topI.x, initialHeight, topI.y);
                    sidePositions.push(topI.x, 0, topI.y);
                    sidePositions.push(topJ.x, initialHeight, topJ.y);
                    sidePositions.push(topJ.x, 0, topJ.y);

                    // UV: U — длина вдоль ребра, V — высота стенки.
                    const ddx = topJ.x - topI.x;
                    const ddz = topJ.y - topI.y;
                    const edgeLen = Math.sqrt(ddx * ddx + ddz * ddz);
                    const u0 = cum / sideUvScale;
                    const u1 = (cum + edgeLen) / sideUvScale;
                    const vH = initialHeight / sideUvScale;
                    sideUVs.push(u0, vH);  // top-I
                    sideUVs.push(u0, 0);   // bottom-I
                    sideUVs.push(u1, vH);  // top-J
                    sideUVs.push(u1, 0);   // bottom-J
                    cum += edgeLen;

                    sideIndices.push(baseIndex, baseIndex + 1, baseIndex + 2);
                    sideIndices.push(baseIndex + 1, baseIndex + 3, baseIndex + 2);
                }
            }

            const sideGeometry = new THREE.BufferGeometry();
            sideGeometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(sidePositions), 3));
            sideGeometry.setAttribute('uv',       new THREE.BufferAttribute(new Float32Array(sideUVs), 2));
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
            this._group.add(sideMesh);
        }

        this._raycastMeshesCache = null;
    }

    private _buildStrokeGeometry(map: any): void {
        if (this._invalidGeometry) return;
        if (this._strokeWidth <= 0 || this._strokeOpacity <= 0) return;

        const canvas = map.renderer.domElement;
        const outerRing = this._rings[0];

        this._strokeWorldCoords.length = 0;
        this._strokeNodeHeights.length = 0;
        let firstStrokePoint: [number, number] | null = null;
        for (let i = 0; i < outerRing.length; i++) {
            const pt = outerRing[i];
            const [absX, absZ] = map.project(pt, this._crs);
            if (i === 0) {
                firstStrokePoint = [absX, absZ];
            } else if (firstStrokePoint && absX === firstStrokePoint[0] && absZ === firstStrokePoint[1]) {
                continue;
            }
            this._strokeWorldCoords.push([absX, absZ]);
            const h = pt?.[2];
            this._strokeNodeHeights.push(Number.isFinite(h) ? h! : 0);
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
    }

    // =================================================================
    // Стиль
    // =================================================================

    setFillColor(color: string | number): this {
        this._fillColor = color;
        if (this._fillMaterial?.color) this._fillMaterial.color.set(color as any);
        if (this._bottomMaterial?.color) this._bottomMaterial.color.set(color as any);
        if (this._sideMaterial?.color) this._sideMaterial.color.set(color as any);
        return this;
    }

    getFillColor(): string | number { return this._fillColor; }

    setFillOpacity(opacity: number): this {
        this._fillOpacity = Math.max(0, Math.min(1, opacity));
        const transparent = this._fillOpacity < 1;
        for (const mat of [this._fillMaterial, this._bottomMaterial, this._sideMaterial]) {
            if (!mat) continue;
            mat.opacity = this._fillOpacity;
            if (mat.transparent !== transparent) {
                mat.transparent = transparent;
                mat.needsUpdate = true;
            }
        }
        return this;
    }

    getFillOpacity(): number { return this._fillOpacity; }

    /**
     * Меняет текстуру заливки. `null` — вернуть однотонную заливку.
     * Работает после `addTo()` без пересоздания геометрии — UV уже
     * посчитаны.
     */
    setFillPattern(source: FillPatternSource): this {
        if (this._fillPatternTexture) {
            try { this._fillPatternTexture.dispose?.(); } catch { /* swallow */ }
            this._fillPatternTexture = null;
        }
        this._fillPatternSource = source;
        if (!this._map) return this;

        this._loadFillPattern();
        this._applyFillPatternToMaterials();
        return this;
    }

    getFillPattern(): FillPatternSource {
        return this._fillPatternSource;
    }

    /** Масштаб паттерна: world-метры на одну плитку. Пересобирает UV. */
    setFillPatternScale(scale: number): this {
        if (!(scale > 0)) return this;
        this._fillPatternScale = scale;
        if (this._map) this._rebuildGeometry();
        return this;
    }

    getFillPatternScale(): number {
        return this._fillPatternScale;
    }

    setStrokeColor(color: string | number): this {
        this._strokeColor = color;
        if (this._strokeMaterial?.color) this._strokeMaterial.color.set(color as any);
        return this;
    }

    getStrokeColor(): string | number { return this._strokeColor; }

    setStrokeWidth(width: number): this {
        if (!(width >= 0)) return this;
        this._strokeWidth = width;
        const mat = this._strokeMaterial;
        if (mat && 'linewidth' in mat) {
            mat.linewidth = width;
            mat.needsUpdate = true;
        }
        return this;
    }

    getStrokeWidth(): number { return this._strokeWidth; }

    setStrokeOpacity(opacity: number): this {
        this._strokeOpacity = Math.max(0, Math.min(1, opacity));
        const mat = this._strokeMaterial;
        if (mat) {
            mat.opacity = this._strokeOpacity;
            const transparent = this._strokeOpacity < 1;
            if (mat.transparent !== transparent) {
                mat.transparent = transparent;
                mat.needsUpdate = true;
            }
        }
        return this;
    }

    getStrokeOpacity(): number { return this._strokeOpacity; }

    // =================================================================
    // Высота
    // =================================================================

    /** @deprecated Используйте унаследованный `setAltitude`. */
    setAltitudeOffset(offset: number): this {
        return this.setAltitude(offset);
    }

    /** @deprecated Используйте унаследованный `getAltitude`. */
    getAltitudeOffset(): number {
        return this.getAltitude();
    }

    setAltitudeMode(mode: AltitudeMode): this {
        this._altitudeMode = mode;
        this._onAltitudeChanged();
        return this;
    }

    getAltitudeMode(): AltitudeMode { return this._altitudeMode; }

    // =================================================================
    // Экструзия
    // =================================================================

    setExtruded(extruded: boolean): this {
        const next = !!extruded;
        if (this._extruded === next) return this;
        this._extruded = next;
        if (next && this._height <= 0) {
            console.warn('Polygon.setExtruded: height is 0, side walls will be flat');
        }
        if (this._map) this._rebuildGeometry();
        return this;
    }

    getExtruded(): boolean { return this._extruded; }

    setHeight(height: number): this {
        if (!(height >= 0)) return this;
        this._height = height;
        if (this._extruded) {
            this._heightsDirty = true;
            this._heightsFinalized = false;
        }
        return this;
    }

    getHeight(): number { return this._height; }

    setMinHeight(height: number): this {
        if (!(height >= 0)) return this;
        this._minHeight = height;
        this._heightsDirty = true;
        this._heightsFinalized = false;
        return this;
    }

    getMinHeight(): number { return this._minHeight; }

    // =================================================================
    // Depth
    // =================================================================

    setDepthTest(depthTest: boolean): this {
        this._depthTest = !!depthTest;
        this._applyDepthFlags();
        return this;
    }

    getDepthTest(): boolean { return this._depthTest; }

    setDepthWrite(depthWrite: boolean): this {
        this._depthWrite = !!depthWrite;
        this._applyDepthFlags();
        return this;
    }

    getDepthWrite(): boolean { return this._depthWrite; }

    private _applyDepthFlags(): void {
        const mats = [
            this._fillMaterial,
            this._bottomMaterial,
            this._sideMaterial,
            this._strokeMaterial,
        ];
        for (const mat of mats) {
            if (!mat) continue;
            let changed = false;
            if (mat.depthTest !== this._depthTest) { mat.depthTest = this._depthTest; changed = true; }
            if (mat.depthWrite !== this._depthWrite) { mat.depthWrite = this._depthWrite; changed = true; }
            if (changed) mat.needsUpdate = true;
        }
    }

    // =================================================================
    // Центр / bounds
    // =================================================================

    getCenter(): LonLat | null {
        const b = this.getBounds('EPSG:4326');
        if (!b) return null;
        return [
            (b[0][0] + b[1][0]) / 2,
            (b[0][1] + b[1][1]) / 2,
        ];
    }

    // =================================================================
    // Обновление на кадре
    // =================================================================

_update(_mapArg?: any): void {
    const map = this._map;
    if (!map || !this._group) return;
    this._applyZoomInterpolations(map.continuousZoom);

        if (this._invalidGeometry || !this._isWithinView()) {
            this._applyHidden();
            this._isVisible = false;
            return;
        }

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
                    this._applyHidden();
                    this._isVisible = false;
                    return;
                }
            }
        }

        this._group.visible = true;
        this._isVisible = true;

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

    private _updateHeights(): boolean {
        if (this._invalidGeometry) return false;
        if (!this._fillGeometry || !this._vertices2D.length) return false;
        const map = this._map;

        const isDynamic = map.hasElevation && this._altitudeMode === 'clampToGround';
        if (!isDynamic && this._heightsFinalized) return false;

        const wgPos = map.worldGroup.position;
        const extrude = this._extruded ? this._height : 0;

        for (let i = 0; i < this._vertices2D.length; i++) {
            const worldCoord = this._worldCoords[i];
            if (!worldCoord) continue;
            let base = this._altitude;
            if (isDynamic) {
                const worldX = worldCoord[0] + wgPos.x;
                const worldZ = worldCoord[1] + wgPos.z;
                map.ensureTileForPoint?.(worldX, worldZ);
                base = map.getSurfaceHeightAt(worldX, worldZ) + this._altitude;
            }
            const nodeH = this._nodeHeights[i] ?? 0;
            this._cachedHeights[i] = base + nodeH + this._minHeight + extrude;
        }

        const strokeLen = this._strokeWorldCoords.length;
        if (this._cachedStrokeHeights.length !== strokeLen) {
            this._cachedStrokeHeights = new Array(strokeLen).fill(0);
        }
        for (let i = 0; i < strokeLen; i++) {
            const worldCoord = this._strokeWorldCoords[i];
            if (!worldCoord) continue;
            let base = this._altitude;
            if (isDynamic) {
                const worldX = worldCoord[0] + wgPos.x;
                const worldZ = worldCoord[1] + wgPos.z;
                map.ensureTileForPoint?.(worldX, worldZ);
                base = map.getSurfaceHeightAt(worldX, worldZ) + this._altitude;
            }
            const nodeH = this._strokeNodeHeights[i] ?? 0;
            this._cachedStrokeHeights[i] = base + nodeH + this._minHeight + extrude;
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

                sidePos[idx * 3 + 1] = upperI; idx++;
                sidePos[idx * 3 + 1] = lowerI; idx++;
                sidePos[idx * 3 + 1] = upperJ; idx++;
                sidePos[idx * 3 + 1] = lowerJ; idx++;
            }
            this._sideGeometry.attributes.position.needsUpdate = true;
            this._sideGeometry.computeVertexNormals();
            this._sideGeometry.computeBoundingSphere();
        }

        if (!isDynamic) this._heightsFinalized = true;
        return true;
    }

    private _updateStroke(): void {
        if (this._invalidGeometry) return;
        if (!this._strokeLine || !this._strokeGeometry) return;
        const positions = this._strokePositionsArray;
        positions.length = 0;
        const groupPos = this._group.position;
        const strokeLen = this._strokeWorldCoords.length;

        for (let i = 0; i < strokeLen; i++) {
            const worldCoord = this._strokeWorldCoords[i];
            if (!worldCoord) continue;
            const y = this._cachedStrokeHeights[i] ?? this._altitude;
            positions.push(worldCoord[0] - groupPos.x, y, worldCoord[1] - groupPos.z);
        }

        if (strokeLen > 0) {
            const first = this._strokeWorldCoords[0];
            const fy = this._cachedStrokeHeights[0] ?? this._altitude;
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
            this._strokeGeometry.setPositions(positions);
            this._strokeLine.computeLineDistances();
        }
    }

    private _updateCentroidScreenPos(): void {
        if (this._invalidGeometry) {
            this._centroidScreenPos = null;
            return;
        }
        if (!this._map || !this._centroidWorld) {
            this._centroidScreenPos = null;
            return;
        }
        const map = this._map;
        const wgPos = map.worldGroup.position;
        const worldX = this._centroidWorld.x + wgPos.x;
        const worldZ = this._centroidWorld.z + wgPos.z;

        let worldY = this._altitude;
        if (this._altitudeMode === 'clampToGround' && map.hasElevation) {
            const now = performance.now();
            if (now - this._lastCentroidHeightUpdateTime > this._heightUpdateInterval) {
                map.ensureTileForPoint(worldX, worldZ);
                this._cachedCentroidHeight = map.getSurfaceHeightAt(worldX, worldZ);
                this._lastCentroidHeightUpdateTime = now;
            }
            worldY = (this._cachedCentroidHeight ?? 0) + this._altitude;
        }

        let avgNodeH = 0;
        if (this._nodeHeights.length > 0) {
            let sum = 0;
            for (let i = 0; i < this._nodeHeights.length; i++) sum += this._nodeHeights[i] ?? 0;
            avgNodeH = sum / this._nodeHeights.length;
        }
        worldY += avgNodeH;
        worldY += this._minHeight + (this._extruded ? this._height : 0);

        const screenPos = map.getVec3().set(worldX, worldY + wgPos.y, worldZ);
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
    }

    // =================================================================
    // KrbMap#fitTo / getBounds
    // =================================================================

    getBounds(crs: string | any = 'EPSG:4326'): [LonLat, LonLat] | null {
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
                let x: number, y: number;
                if (sameProjection) {
                    x = pt[0];
                    y = pt[1];
                } else {
                    const lonLat = src.toLonLat(pt);
                    const conv = dst.fromLonLat(lonLat);
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
    }
}