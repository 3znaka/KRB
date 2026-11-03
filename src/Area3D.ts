/**
 * Area3D — 3D-объект, привязанный к площадной геометрии (полигону).
 * После `addTo()` мутабелен: кольца, размер, fit, поворот, anchor,
 * цвет, видимость, подпись, тултип, границы видимости меняются без
 * пересоздания объекта.
 *
 * @module Area3D
 */

import { THREE, GLTFLoader, DRACOLoader } from './js_TP/tpb.js';
import { Projections } from './Projections.js';
import { Layer } from './Layers.js';

// =====================================================================
// Типы
// =====================================================================

export type LonLat = [number, number];
export type Area3DCoord = [number, number] | [number, number, number];
export type Area3DRing = Area3DCoord[];
export type SizeSpec = number | number[];
export type PrimitiveType = 'box' | 'sphere' | 'cylinder' | 'cone';
export type Area3DFit = 'stretch' | 'contain';
export type AltitudeMode = 'clampToGround' | 'absolute';
export type TitlePlacement = 'top' | 'bottom' | 'left' | 'right';
export type TitleAlignH = 'left' | 'center' | 'right';
export type TitleAlignV = 'top' | 'center' | 'bottom';
export type Anchor = [number, number, number];

export interface Area3DOptions {
    rings: Area3DRing[];
    crs?: string;
    modelUrl?: string | null;
    primitiveType?: PrimitiveType;
    size?: SizeSpec | null;
    fit?: Area3DFit;
    rotate?: number;
    altitude?: number;
    altitudeMode?: AltitudeMode;
    anchor?: Anchor;
    minZoom?: number;
    maxZoom?: number;
    playAnimation?: boolean;
    color?: string | number;
    depthTest?: boolean;
    depthWrite?: boolean;
    title?: string;
    titleStyle?: Record<string, string | number>;
    titleMinZoom?: number;
    titleMaxZoom?: number;
    titlePlacement?: TitlePlacement;
    titleAlign?: TitleAlignH;
    titleOffset?: [number, number];
    tooltip?: string;
    onClick?: (event: MouseEvent, area: Area3D) => void;
    onHover?: (hovered: boolean) => void;
}

const AREA3D_RENDER_ORDER = 1000;

// =====================================================================
// Area3D
// =====================================================================

export class Area3D {
    // ── Данные ──
    private _rings: Area3DRing[];
    private _crsCode: string | null;
    private _crs: any | null;

    // ── Оформление ──
    private _modelUrl: string | null;
    private _primitiveType: PrimitiveType;
    private _size: SizeSpec | null;
    private _fit: Area3DFit;
    private _rotate: number; // 0..3
    private _altitude: number;
    private _altitudeMode: AltitudeMode;
    private _anchor: Anchor;
    private _minZoom: number;
    private _maxZoom: number;
    private _playAnimation: boolean;
    private _color: string | number;
    private _depthTest: boolean;
    private _depthWrite: boolean;

    // ── Подпись ──
    private _title: string;
    private _titleStyle: Record<string, string | number>;
    private _titleMinZoom: number;
    private _titleMaxZoom: number;
    private _titlePlacement: TitlePlacement;
    private _titleAlign: TitleAlignH;
    private _titleOffset: [number, number];

    // ── Интерактив ──
    private _tooltipText: string;
    private _onClick: ((event: MouseEvent, area: Area3D) => void) | null;
    private _onHover: ((hovered: boolean) => void) | null;
    private _unregisterInteraction: (() => void) | null = null;

    // ── Присоединение ──
    private _map: any = null;
    private _layer: Layer | null = null;

    // ── 3D-иерархия ──
    private _group: any;
    private _modelContainer: any;
    private _object3D: any = null;

    // ── Анимации ──
    private _mixer: any = null;
    private _mixerClock: any = null;

    // ── Загрузка ──
    private _isModelLoading = false;
    private _modelPromise: Promise<void> | null = null;
    private _originalModelSize: any = null;
    private _originalModelScale: any = null;
    private _originalModelPosition: any = null;

    // ── Геометрия полигона (мировые метры) ──
    private _centroidWorld: any;
    private _polygonAngle = 0;
    private _polygonWidth = 0;
    private _polygonDepth = 0;
    private _worldCoords: Array<[number, number]> = [];

    // ── Кэш рельефа ──
    private _cachedSurfaceHeight = 0;
    private _lastHeightUpdateTime = 0;
    private _heightUpdateInterval = 500;
    private _lastWorldGroupPos: any;

    // ── Подпись (экран) ──
    private _centroidScreenPos: { x: number; y: number } | null = null;
    private _textLabel: any = null;

    // ── Bounding sphere (для interaction) ──
    private _boundingRadius = 0;
    private _boundingCenterYLocal = 0;
    private _boundingSphereWorldCenter: any;
    private _raycastMeshesCache: any[] | null = null;
    private _tempBox: any;

    // ── NEW: пользовательская видимость ──
    private _userVisible = true;

    constructor(options: Area3DOptions) {
        if (!options.rings || !options.rings.length || options.rings[0].length < 3) {
            throw new Error('Area3D: options.rings is required with at least one ring of 3+ points');
        }

        this._rings = options.rings;
        this._crsCode = options.crs ?? null;
        this._crs = null;

        this._modelUrl = options.modelUrl ?? null;
        this._primitiveType = options.primitiveType ?? 'box';
        this._size = options.size ?? null;
        this._fit = options.fit ?? 'stretch';
        this._rotate = options.rotate ?? 0;
        this._altitude = options.altitude ?? 0;
        this._altitudeMode = options.altitudeMode ?? 'clampToGround';
        this._anchor = options.anchor ?? [0.5, 0, 0.5];
        this._minZoom = options.minZoom ?? -Infinity;
        this._maxZoom = options.maxZoom ?? Infinity;
        this._playAnimation = options.playAnimation !== undefined ? options.playAnimation : true;
        this._color = options.color ?? 0x3388ff;
        this._depthTest = options.depthTest ?? true;
        this._depthWrite = options.depthWrite ?? true;

        this._title = options.title ?? '';
        this._titleStyle = options.titleStyle ?? {};
        this._titleMinZoom = options.titleMinZoom ?? -Infinity;
        this._titleMaxZoom = options.titleMaxZoom ?? Infinity;
        this._titlePlacement = options.titlePlacement ?? 'top';

        if (options.titleAlign !== undefined) {
            this._titleAlign = options.titleAlign;
        } else {
            this._titleAlign = this._defaultTitleAlign();
        }
        if (options.titleOffset !== undefined) {
            this._titleOffset = options.titleOffset;
        } else {
            this._titleOffset = this._defaultTitleOffset();
        }

        this._tooltipText = options.tooltip ?? '';
        this._onClick = options.onClick ?? null;
        this._onHover = options.onHover ?? null;

        this._group = new THREE.Group();
        this._modelContainer = new THREE.Group();
        this._group.add(this._modelContainer);

        this._centroidWorld = new THREE.Vector3();
        this._lastWorldGroupPos = new THREE.Vector3();
        this._boundingSphereWorldCenter = new THREE.Vector3();
        this._tempBox = new THREE.Box3();

        this._rotate = Math.min(3, Math.max(0, Math.floor(this._rotate)));
    }

    private _defaultTitleAlign(): TitleAlignH {
        switch (this._titlePlacement) {
            case 'top':
            case 'bottom': return 'center';
            case 'left': return 'right';
            case 'right': return 'left';
            default: return 'center';
        }
    }

    private _defaultTitleOffset(): [number, number] {
        switch (this._titlePlacement) {
            case 'top': return [0, -10];
            case 'bottom': return [0, 10];
            case 'left': return [-10, 0];
            case 'right': return [10, 0];
            default: return [0, -10];
        }
    }

    // =================================================================
    // Присоединение / отсоединение
    // =================================================================

    addTo(map: any): this {
        if (this._map) this.remove();
        const personalLayer = new Layer();
        personalLayer.addTo(map);
        (personalLayer as any).add(this);
        return this;
    }

    _attach(map: any, layer: Layer): void {
        if (this._map === map && this._layer === layer) return;
        this.remove();
        this._map = map;
        this._layer = layer;

        this._crs = this._crsCode
            ? Projections.get(this._crsCode)
            : map.inputCRS;

        this._calculatePolygonParams();
        this._group.position.set(this._centroidWorld.x, 0, this._centroidWorld.z);
        map.worldGroup.add(this._group);

        if (this._modelUrl) {
            this._isModelLoading = true;
            this._loadModel();
        } else {
            this._createPrimitive();
        }

        if (this._title && map.textManager) {
            this._textLabel = map.textManager.addLabel(this);
        }

        this._registerInteraction(map);
        this._lastWorldGroupPos.copy(map.worldGroup.position);
    }

    private _registerInteraction(map: any): void {
        if (!map.interaction || typeof map.interaction.register !== 'function') return;
        if (this._unregisterInteraction) {
            this._unregisterInteraction();
            this._unregisterInteraction = null;
        }
        if (!this._onClick && !this._onHover && !this._tooltipText) return;

        const callbacks: Record<string, any> = {
            getMeshes: () => this._getRaycastMeshes(),
            getBoundingSphere: () => {
                if (this._boundingRadius <= 0) return null;
                const wgPos = map.worldGroup.position;
                this._boundingSphereWorldCenter.set(
                    this._group.position.x + wgPos.x,
                    this._group.position.y + wgPos.y + this._boundingCenterYLocal,
                    this._group.position.z + wgPos.z
                );
                return {
                    center: this._boundingSphereWorldCenter,
                    radius: this._boundingRadius,
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
        if (!this._object3D) return [];
        const meshes: any[] = [];
        if (this._object3D.isMesh) {
            meshes.push(this._object3D);
        } else {
            this._object3D.traverse((child: any) => {
                if (child.isMesh) meshes.push(child);
            });
        }
        this._raycastMeshesCache = meshes;
        return meshes;
    }

    // =================================================================
    // Расчёт полигона
    // =================================================================

    private _calculatePolygonParams(): void {
        const outerRing = this._rings[0];
        this._worldCoords.length = 0;

        let sumX = 0, sumZ = 0;
        const uniquePoints: Array<[number, number]> = [];
        for (let i = 0; i < outerRing.length; i++) {
            const [absX, absZ] = this._map.project(outerRing[i], this._crs);
            if (i > 0 && absX === uniquePoints[0]?.[0] && absZ === uniquePoints[0]?.[1]) continue;
            uniquePoints.push([absX, absZ]);
            this._worldCoords.push([absX, absZ]);
            sumX += absX;
            sumZ += absZ;
        }
        const centroidX = sumX / this._worldCoords.length;
        const centroidZ = sumZ / this._worldCoords.length;
        this._centroidWorld.set(centroidX, 0, centroidZ);

        if (this._worldCoords.length < 3) return;

        let maxLenSq = -1;
        let dirX = 0, dirZ = 0;
        for (let i = 0; i < this._worldCoords.length; i++) {
            const j = (i + 1) % this._worldCoords.length;
            const dx = this._worldCoords[j][0] - this._worldCoords[i][0];
            const dz = this._worldCoords[j][1] - this._worldCoords[i][1];
            const lenSq = dx * dx + dz * dz;
            if (lenSq > maxLenSq) {
                maxLenSq = lenSq;
                dirX = dx;
                dirZ = dz;
            }
        }
        if (maxLenSq === 0) return;

        this._polygonAngle = Math.atan2(dirZ, dirX);

        const cos = Math.cos(-this._polygonAngle);
        const sin = Math.sin(-this._polygonAngle);
        let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
        for (const [x, z] of this._worldCoords) {
            const localX = x - centroidX;
            const localZ = z - centroidZ;
            const rotatedX = localX * cos - localZ * sin;
            const rotatedZ = localX * sin + localZ * cos;
            if (rotatedX < minX) minX = rotatedX;
            if (rotatedX > maxX) maxX = rotatedX;
            if (rotatedZ < minZ) minZ = rotatedZ;
            if (rotatedZ > maxZ) maxZ = rotatedZ;
        }
        this._polygonWidth = maxX - minX;
        this._polygonDepth = maxZ - minZ;
    }

    // =================================================================
    // Построение примитива / загрузка модели
    // =================================================================

    private _createPrimitive(): void {
        let [w, h, d] = this._normalizeSize(this._size);
        if (this._fit === 'stretch') {
            w = this._polygonWidth;
            d = this._polygonDepth;
            if (this._size !== null) {
                [, h] = this._normalizeSize(this._size);
            }
        } else if (this._fit === 'contain') {
            const scale = Math.min(this._polygonWidth / w, this._polygonDepth / d);
            w *= scale;
            d *= scale;
            h *= scale;
        }

        let geometry: any;
        switch (this._primitiveType.toLowerCase() as PrimitiveType) {
            case 'sphere': geometry = new THREE.SphereGeometry(w / 2, 32, 32); break;
            case 'cylinder': geometry = new THREE.CylinderGeometry(w / 2, w / 2, h, 32); break;
            case 'cone': geometry = new THREE.ConeGeometry(w / 2, h, 32); break;
            case 'box':
            default: geometry = new THREE.BoxGeometry(w, h, d); break;
        }
        const material = new THREE.MeshStandardMaterial({
            color: this._color,
            roughness: 0.5,
            depthTest: this._depthTest,
            depthWrite: this._depthWrite,
        });
        const mesh = new THREE.Mesh(geometry, material);
        mesh.renderOrder = AREA3D_RENDER_ORDER;
        this._object3D = mesh;
        this._modelContainer.add(mesh);
        this._applyModelTransform();
        this._raycastMeshesCache = null;
    }

    private async _loadModel(): Promise<void> {
        if (this._modelPromise) return this._modelPromise;
        this._modelPromise = (async () => {
            try {
                const loader = new GLTFLoader();
                const dracoLoader = new DRACOLoader();
                dracoLoader.setDecoderPath('https://cdn.mapengine.ru/KRB/js_TP/draco/');
                dracoLoader.setDecoderConfig({ type: 'wasm' });
                loader.setDRACOLoader(dracoLoader);

                const gltf = await (loader as any).loadAsync(this._modelUrl!);
                const model = gltf.scene;

                if (this._playAnimation && gltf.animations?.length) {
                    this._mixer = new THREE.AnimationMixer(model);
                    for (const clip of gltf.animations) {
                        this._mixer.clipAction(clip).play();
                    }
                    this._mixerClock = new THREE.Clock();
                }

                const box = new THREE.Box3().setFromObject(model);
                this._originalModelSize = box.getSize(new THREE.Vector3());
                this._originalModelScale = model.scale.clone();
                this._originalModelPosition = model.position.clone();

                model.traverse((child: any) => {
                    if (child.isMesh) {
                        child.renderOrder = AREA3D_RENDER_ORDER;
                        child.castShadow = true;
                        child.receiveShadow = true;
                        if (child.material) {
                            child.material.depthTest = this._depthTest;
                            child.material.depthWrite = this._depthWrite;
                        }
                    }
                });
                this._object3D = model;
                this._modelContainer.add(model);
                this._applyModelTransform();
                this._isModelLoading = false;
                this._raycastMeshesCache = null;
            } catch (err) {
                console.warn('Area3D: GLB loading failed:', err);
                this._isModelLoading = false;
            }
        })();
        return this._modelPromise;
    }

    private _applyModelTransform(): void {
        if (!this._object3D) return;

        const model = this._object3D;
        const parent = model.parent;

        model.position.set(0, 0, 0);
        model.scale.set(1, 1, 1);
        model.rotation.set(0, 0, 0);
        model.updateMatrixWorld(true);

        if (parent) parent.remove(model);
        model.updateMatrixWorld(true);
        const box = new THREE.Box3().setFromObject(model);
        const size = box.getSize(new THREE.Vector3());
        if (parent) parent.add(model);

        const rotate = this._rotate;
        const widthModel = (rotate % 2 === 0) ? size.x : size.z;
        const depthModel = (rotate % 2 === 0) ? size.z : size.x;

        let targetW: number, targetH: number, targetD: number;
        if (this._fit === 'stretch') {
            targetW = this._polygonWidth;
            targetD = this._polygonDepth;
            if (this._size) {
                const [, hFromSize] = this._normalizeSize(this._size);
                targetH = hFromSize;
            } else {
                const containScale = Math.min(
                    this._polygonWidth / widthModel,
                    this._polygonDepth / depthModel
                );
                targetH = size.y * containScale;
            }
        } else if (this._fit === 'contain') {
            const containScale = Math.min(
                this._polygonWidth / widthModel,
                this._polygonDepth / depthModel
            );
            targetW = widthModel * containScale;
            targetH = size.y * containScale;
            targetD = depthModel * containScale;
        } else {
            if (this._size) {
                [targetW, targetH, targetD] = this._normalizeSize(this._size);
            } else {
                targetW = size.x;
                targetH = size.y;
                targetD = size.z;
            }
        }

        let scaleX: number, scaleZ: number;
        if (rotate % 2 === 0) {
            scaleX = targetW / size.x;
            scaleZ = targetD / size.z;
        } else {
            scaleX = targetD / size.x;
            scaleZ = targetW / size.z;
        }
        const scaleY = targetH / size.y;

        model.scale.set(scaleX, scaleY, scaleZ);

        const totalAngle = this._polygonAngle + rotate * Math.PI / 2;
        model.rotation.y = totalAngle;

        model.updateMatrixWorld(true);

        if (parent) parent.remove(model);
        model.updateMatrixWorld(true);
        const transformedBox = new THREE.Box3().setFromObject(model);
        const transformedSize = transformedBox.getSize(new THREE.Vector3());
        const transformedMin = transformedBox.min.clone();
        if (parent) parent.add(model);

        const anchorPoint = new THREE.Vector3(
            transformedMin.x + this._anchor[0] * transformedSize.x,
            transformedMin.y + this._anchor[1] * transformedSize.y,
            transformedMin.z + this._anchor[2] * transformedSize.z
        );

        model.position.sub(anchorPoint);
        model.updateMatrixWorld(true);

        this._recomputeBoundingRadius();
    }

    private _recomputeBoundingRadius(): void {
        if (!this._object3D) {
            this._boundingRadius = 0;
            this._boundingCenterYLocal = 0;
            return;
        }
        const parent = this._object3D.parent;
        if (parent) parent.remove(this._object3D);
        this._object3D.updateMatrixWorld(true);
        const box = new THREE.Box3().setFromObject(this._object3D);
        if (parent) parent.add(this._object3D);

        const size = box.getSize(new THREE.Vector3());
        this._boundingRadius = 0.5 * size.length();
        this._boundingCenterYLocal = box.min.y + size.y / 2;
    }

    private _normalizeSize(size: SizeSpec | null): [number, number, number] {
        if (!size) return [100, 100, 100];
        if (typeof size === 'number') return [size, size, size];
        if (Array.isArray(size)) {
            if (size.length === 1) return [size[0], size[0], size[0]];
            if (size.length === 2) return [size[0], size[1], size[0]];
            if (size.length === 3) return [size[0], size[1], size[2]];
            throw new Error('Area3D: size array must have 1, 2, or 3 elements');
        }
        throw new Error('Area3D: invalid size type');
    }

    // =================================================================
    // Мутабельность
    // =================================================================

    /** Управляет видимостью (перекрывает зум и видимость слоя). */
    setVisible(visible: boolean): this {
        this._userVisible = !!visible;
        if (!this._group) return this;
        if (!this._userVisible) this._group.visible = false;
        return this;
    }

    /** Меняет тултип. При необходимости — регистрирует интерактив. */
    setTooltip(html: string): this {
        this._tooltipText = html ?? '';
        if (this._map) this._registerInteraction(this._map);
        return this;
    }

    /** Меняет текст подписи (пустая строка — убрать). */
    setTitle(text: string): this {
        this._title = text ?? '';
        const tm = this._map?.textManager;
        if (!tm) return this;

        if (this._textLabel) {
            if (typeof tm.updateLabel === 'function') {
                tm.updateLabel(this._textLabel);
            } else {
                tm.removeLabel(this._textLabel);
                this._textLabel = null;
                if (this._title) this._textLabel = tm.addLabel(this);
            }
        } else if (this._title) {
            this._textLabel = tm.addLabel(this);
        }
        return this;
    }

    /** Меняет кольца. Пересобирает параметры полигона и трансформации. */
    setRings(rings: Area3DRing[]): this {
        if (!rings || !rings.length || rings[0].length < 3) {
            console.warn('Area3D.setRings: need at least one ring with 3+ points');
            return this;
        }
        this._rings = rings;
        if (!this._map) return this;

        this._calculatePolygonParams();
        this._group.position.x = this._centroidWorld.x;
        this._group.position.z = this._centroidWorld.z;
        this._applyModelTransform();
        return this;
    }

    /** Меняет размер (см. описание `options.size`). */
    setSize(size: SizeSpec | null): this {
        this._size = size;
        if (this._object3D) this._applyModelTransform();
        return this;
    }

    /** Меняет режим вписывания (`'stretch'` или `'contain'`). */
    setFit(fit: Area3DFit): this {
        this._fit = fit;
        if (this._object3D) this._applyModelTransform();
        return this;
    }

    /** Меняет поворот модели (0..3, кратно 90°). */
    setRotate(rotate: number): this {
        this._rotate = Math.min(3, Math.max(0, Math.floor(rotate)));
        if (this._object3D) this._applyModelTransform();
        return this;
    }

    /** Меняет anchor (нормализованные [0..1] по bounding box). */
    setAnchor(anchor: Anchor): this {
        this._anchor = [anchor[0], anchor[1], anchor[2]];
        if (this._object3D) this._applyModelTransform();
        return this;
    }

    /** Меняет высоту (интерпретация зависит от `altitudeMode`). */
    setAltitude(altitude: number): this {
        this._altitude = altitude;
        this._lastHeightUpdateTime = 0;
        return this;
    }

    /** Меняет режим высоты. */
    setAltitudeMode(mode: AltitudeMode): this {
        this._altitudeMode = mode;
        this._lastHeightUpdateTime = 0;
        return this;
    }

    /** Меняет цвет примитива или материалов GLB-модели. */
    setColor(color: string | number): this {
        this._color = color;
        if (!this._object3D) return this;
        if (this._object3D.material) {
            if (this._object3D.material.color) {
                this._object3D.material.color.set(color as any);
            }
        } else {
            this._object3D.traverse((child: any) => {
                if (child.isMesh && child.material?.color) {
                    child.material.color.set(color as any);
                }
            });
        }
        return this;
    }

    /** Включает/отключает depthTest на всех материалах объекта. */
    setDepthTest(depthTest: boolean): this {
        this._depthTest = !!depthTest;
        if (!this._object3D) return this;
        const meshes: any[] = [];
        if (this._object3D.isMesh) meshes.push(this._object3D);
        else this._object3D.traverse((child: any) => { if (child.isMesh) meshes.push(child); });
        for (const m of meshes) {
            const mat = m.material;
            if (!mat) continue;
            if (Array.isArray(mat)) mat.forEach((x: any) => { if (x.depthTest !== this._depthTest) { x.depthTest = this._depthTest; x.needsUpdate = true; } });
            else if (mat.depthTest !== this._depthTest) { mat.depthTest = this._depthTest; mat.needsUpdate = true; }
        }
        return this;
    }

    /** Включает/отключает depthWrite на всех материалах объекта. */
    setDepthWrite(depthWrite: boolean): this {
        this._depthWrite = !!depthWrite;
        if (!this._object3D) return this;
        const meshes: any[] = [];
        if (this._object3D.isMesh) meshes.push(this._object3D);
        else this._object3D.traverse((child: any) => { if (child.isMesh) meshes.push(child); });
        for (const m of meshes) {
            const mat = m.material;
            if (!mat) continue;
            if (Array.isArray(mat)) mat.forEach((x: any) => { if (x.depthWrite !== this._depthWrite) { x.depthWrite = this._depthWrite; x.needsUpdate = true; } });
            else if (mat.depthWrite !== this._depthWrite) { mat.depthWrite = this._depthWrite; mat.needsUpdate = true; }
        }
        return this;
    }

    /** Устанавливает границы видимости по зуму. */
    setZoomBounds(minZoom: number, maxZoom: number): this {
        this._minZoom = minZoom;
        this._maxZoom = maxZoom;
        return this;
    }

    // =================================================================
    // Геттеры
    // =================================================================

    getRings(): Area3DRing[] {
        return this._rings.map(r => r.map(p => [...p] as Area3DCoord));
    }

    getSize(): SizeSpec | null { return this._size; }
    getFit(): Area3DFit { return this._fit; }
    getRotate(): number { return this._rotate; }
    getAnchor(): Anchor { return [this._anchor[0], this._anchor[1], this._anchor[2]]; }
    getAltitude(): number { return this._altitude; }
    getAltitudeMode(): AltitudeMode { return this._altitudeMode; }

    /** Центр bbox в WGS84: `[lon, lat]`, либо `null`. */
    getCenter(): LonLat | null {
        const b = this.getBounds('EPSG:4326');
        if (!b) return null;
        return [
            (b[0][0] + b[1][0]) / 2,
            (b[0][1] + b[1][1]) / 2,
        ];
    }

    // =================================================================
    // Удаление
    // =================================================================

    remove(): void {
        if (this._unregisterInteraction) {
            this._unregisterInteraction();
            this._unregisterInteraction = null;
        }
        if (this._mixer) {
            this._mixer.stopAllAction();
            this._mixer = null;
            this._mixerClock = null;
        }
        if (this._group) {
            this._group.parent?.remove(this._group);
            if (this._object3D) {
                this._object3D.traverse((child: any) => {
                    if (child.isMesh) {
                        child.geometry?.dispose();
                        if (Array.isArray(child.material)) {
                            child.material.forEach((m: any) => m.dispose());
                        } else {
                            child.material?.dispose();
                        }
                    }
                });
                this._object3D = null;
            }
        }
        if (this._textLabel && this._map?.textManager) {
            this._map.textManager.removeLabel(this._textLabel);
            this._textLabel = null;
        }
        if (this._layer) {
            (this._layer as any)._removeRef(this);
            this._layer = null;
        }
        this._map = null;
        this._crs = null;
        this._raycastMeshesCache = null;
        this._boundingRadius = 0;
        this._boundingCenterYLocal = 0;
        this._centroidScreenPos = null;
    }

    // =================================================================
    // Обновление на кадре
    // =================================================================

    _update(map: any): void {
        if (!this._map || !this._group) return;

        if (!this._userVisible) {
            this._group.visible = false;
            return;
        }

        const zoom = map.continuousZoom;
        if (this._layer && !(this._layer as any).visible) {
            this._group.visible = false;
            return;
        }
        if (zoom < this._minZoom || zoom > this._maxZoom) {
            this._group.visible = false;
            return;
        }

        if (map.maxObjectDistance !== Infinity && this._object3D) {
            const worldPos = map.getVec3()
                .copy(this._group.position)
                .add(map.worldGroup.position);
            const dist = map.camera.position.distanceTo(worldPos);
            if (dist > map.maxObjectDistance) {
                this._group.visible = false;
                return;
            }
        }

        this._group.visible = true;

        if (this._altitudeMode === 'clampToGround') {
            const now = performance.now();
            if (now - this._lastHeightUpdateTime > this._heightUpdateInterval ||
                !this._lastWorldGroupPos.equals(map.worldGroup.position)) {
                const worldX = this._centroidWorld.x + map.worldGroup.position.x;
                const worldZ = this._centroidWorld.z + map.worldGroup.position.z;
                map.ensureTileForPoint?.(worldX, worldZ);
                this._cachedSurfaceHeight = map.getSurfaceHeightAt(worldX, worldZ);
                this._lastHeightUpdateTime = now;
                this._lastWorldGroupPos.copy(map.worldGroup.position);
            }
            this._group.position.y = this._cachedSurfaceHeight + this._altitude;
            this._group.updateMatrixWorld(true);
        } else {
            this._group.position.y = this._altitude;
            this._group.updateMatrixWorld(true);
        }

        if (this._mixer && this._mixerClock) {
            const delta = this._mixerClock.getDelta();
            this._mixer.update(delta);
        }
    }

    private _updateScreenPosition(): void {
        if (!this._map || !this._object3D) {
            this._centroidScreenPos = null;
            return;
        }
        this._object3D.updateWorldMatrix(true, true);
        const box = this._tempBox.setFromObject(this._object3D);
        const canvas = this._map.renderer.domElement;
        const camera = this._map.camera;
        const corners: Array<{ x: number; y: number }> = [];
        const { min, max } = box;
        for (let i = 0; i < 8; i++) {
            const corner = this._map.getVec3().set(
                (i & 1) ? max.x : min.x,
                (i & 2) ? max.y : min.y,
                (i & 4) ? max.z : min.z
            );
            corner.project(camera);
            if (corner.z < -1 || corner.z > 1) continue;
            corners.push({
                x: (corner.x * 0.5 + 0.5) * canvas.clientWidth,
                y: (-corner.y * 0.5 + 0.5) * canvas.clientHeight,
            });
        }
        if (!corners.length) {
            this._centroidScreenPos = null;
            return;
        }
        let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
        for (const c of corners) {
            if (c.x < minX) minX = c.x;
            if (c.x > maxX) maxX = c.x;
            if (c.y < minY) minY = c.y;
            if (c.y > maxY) maxY = c.y;
        }
        const centerX = (minX + maxX) / 2;
        const centerY = (minY + maxY) / 2;
        let x: number, y: number;
        switch (this._titlePlacement) {
            case 'bottom': x = centerX; y = maxY; break;
            case 'left': x = minX; y = centerY; break;
            case 'right': x = maxX; y = centerY; break;
            case 'top':
            default: x = centerX; y = minY; break;
        }
        this._centroidScreenPos = { x, y };
    }

    // =================================================================
    // TextManager contract
    // =================================================================

    getText(): string { return this._title; }

    getTextStyle(): Record<string, string | number> {
        return Object.assign({
            fontFamily: 'sans-serif',
            color: '#333',
            fontSize: '12px',
            textAlign: this._titleAlign,
        }, this._titleStyle);
    }

    getTextZoomBounds(): { min: number; max: number } {
        return { min: this._titleMinZoom, max: this._titleMaxZoom };
    }

    getLabelType(): 'area3d' { return 'area3d'; }

    isVisible(): boolean { return this._group?.visible ?? false; }

    getScreenPosition(): { x: number; y: number } | null {
        this._updateScreenPosition();
        return this._centroidScreenPos;
    }

    getTitleAlign(): TitleAlignH { return this._titleAlign; }

    getTitleOffset(): [number, number] { return this._titleOffset; }

    getTitleVerticalAlign(): TitleAlignV {
        switch (this._titlePlacement) {
            case 'bottom': return 'top';
            case 'left':
            case 'right': return 'center';
            case 'top':
            default: return 'bottom';
        }
    }

    getAllowOverflow(): boolean { return false; }

    getPriority(): number { return 0; }

    getClusterable(): boolean { return false; }

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