/**
 * Marker3D — 3D-маркер (примитив или GLB-модель). После `addTo()`
 * мутабелен: позиция, размер, поворот, anchor, цвет, видимость, текст
 * и тултип меняются без пересоздания объекта.
 *
 * @module Marker3D
 */

import { THREE, GLTFLoader, DRACOLoader } from './js_TP/tpb.js';
import { Projections } from './Projections.js';
import { Layer } from './Layers.js';

// =====================================================================
// Типы
// =====================================================================

export type LonLat = [number, number];
export type Vec3 = [number, number, number];
export type SizeSpec = number | number[];
export type PrimitiveType = 'box' | 'sphere' | 'cylinder' | 'cone';
export type AltitudeMode = 'clampToGround' | 'absolute';
export type TitlePlacement = 'top' | 'bottom' | 'left' | 'right';
export type TitleAlignH = 'left' | 'center' | 'right';
export type TitleAlignV = 'top' | 'center' | 'bottom';
export type Easing = 'linear' | 'easeIn' | 'easeOut' | 'easeInOut';

export interface Marker3DOptions {
    position: LonLat;
    crs?: string;
    primitiveType?: PrimitiveType;
    size?: SizeSpec | null;
    modelUrl?: string | null;
    altitude?: number;
    altitudeMode?: AltitudeMode;
    rotation?: Vec3;
    anchor?: Vec3;
    minZoom?: number;
    maxZoom?: number;
    title?: string;
    titleStyle?: Record<string, string | number>;
    titleMinZoom?: number;
    titleMaxZoom?: number;
    titlePlacement?: TitlePlacement;
    titleAlign?: TitleAlignH;
    titleOffset?: [number, number];
    tooltip?: string;
    color?: string | number;
    onClick?: (event: MouseEvent, marker: Marker3D) => void;
    onHover?: (hovered: boolean) => void;
    clusterable?: boolean;
    playAnimation?: boolean;
}

interface SizeAnimation {
    startSize: SizeSpec;
    endSize: SizeSpec;
    startTime: number;
    duration: number;
    easing: Easing;
}

const MARKER_RENDER_ORDER = 1000;

// =====================================================================
// Marker3D
// =====================================================================

export class Marker3D {
    // ── Данные позиции ──
    private _coord: LonLat;
    private _crsCode: string | null;
    private _crs: any | null;
    private _lon: number | null = null;
    private _lat: number | null = null;
    private _positionSetAsLonLat = false;

    // ── Оформление ──
    private _primitiveType: PrimitiveType;
    private _size: SizeSpec | null;
    private _modelUrl: string | null;
    private _altitude: number;
    private _altitudeMode: AltitudeMode;
    private _rotation: Vec3;
    private _anchor: Vec3;
    private _minZoom: number;
    private _maxZoom: number;
    private _playAnimation: boolean;
    private _color: string | number;

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
    private _onClick: ((event: MouseEvent, marker: Marker3D) => void) | null;
    private _onHover: ((hovered: boolean) => void) | null;
    private _clusterable: boolean;
    private _unregisterInteraction: (() => void) | null = null;

    // ── Присоединение ──
    private _map: any = null;
    private _layer: Layer | null = null;

    // ── 3D-объекты ──
    private _object3D: any = null;
    private _modelRoot: any = null;
    private _geometry: any = null;
    private _material: any = null;
    private _textLabel: any = null;
    private _isVisible = false;
    private _userVisible = true;
    private _lastHeightUpdateTime = 0;
    private _cachedWorldY = 0;
    private _isModelLoading = false;
    private _modelPromise: Promise<void> | null = null;

    private _worldPosition: any;
    private _localBox: any = null;
    private _originalModelSize: any = null;
    private _originalModelScale: any = null;
    private _originalModelPosition: any = null;
    private _isModel: boolean;
    private _sizeAnimation: SizeAnimation | null = null;
    private _boundingRadius = 0;
    private _boundingSphereOffset: any = null;
    private _raycastMeshesCache: any[] | null = null;
    private _height = 0;

    // ── Анимации GLB ──
    private _mixer: any = null;
    private _mixerClock: any = null;

    // ── Временные объекты ──
    private _tempBox: any;
    private _tempFrustum: any;
    private _tempProjScreenMatrix: any;

    constructor(options: Marker3DOptions) {
        if (!options.position || options.position.length !== 2) {
            throw new Error('Marker3D: options.position is required [x, y]');
        }

        this._coord = [options.position[0], options.position[1]];
        this._crsCode = options.crs ?? null;
        this._crs = null;

        this._primitiveType = options.primitiveType ?? 'box';
        this._size = options.size ?? null;
        this._modelUrl = options.modelUrl ?? null;
        this._altitude = options.altitude ?? 0;
        this._altitudeMode = options.altitudeMode ?? 'clampToGround';
        this._rotation = options.rotation ?? [0, 0, 0];
        this._anchor = options.anchor ?? [0.5, 0, 0.5];
        this._minZoom = options.minZoom ?? -Infinity;
        this._maxZoom = options.maxZoom ?? Infinity;
        this._playAnimation = options.playAnimation !== undefined ? options.playAnimation : true;

        this._title = options.title ?? '';
        this._titleStyle = options.titleStyle ?? {};
        this._titleMinZoom = options.titleMinZoom ?? -Infinity;
        this._titleMaxZoom = options.titleMaxZoom ?? Infinity;
        this._titlePlacement = options.titlePlacement ?? 'top';

        if (options.titleAlign !== undefined) {
            this._titleAlign = options.titleAlign;
        } else {
            switch (this._titlePlacement) {
                case 'top':
                case 'bottom':
                default: this._titleAlign = 'center'; break;
                case 'left': this._titleAlign = 'right'; break;
                case 'right': this._titleAlign = 'left'; break;
            }
        }

        if (options.titleOffset !== undefined) {
            this._titleOffset = options.titleOffset;
        } else {
            switch (this._titlePlacement) {
                case 'top': this._titleOffset = [0, -10]; break;
                case 'bottom': this._titleOffset = [0, 10]; break;
                case 'left': this._titleOffset = [-10, 0]; break;
                case 'right': this._titleOffset = [10, 0]; break;
                default: this._titleOffset = [0, -10];
            }
        }

        this._tooltipText = options.tooltip ?? '';
        this._onClick = options.onClick ?? null;
        this._onHover = options.onHover ?? null;
        this._clusterable = options.clusterable ?? false;
        this._color = options.color ?? 0x3388ff;
        this._isModel = !!this._modelUrl;

        this._worldPosition = new THREE.Vector3();
        this._tempBox = new THREE.Box3();
        this._tempFrustum = new THREE.Frustum();
        this._tempProjScreenMatrix = new THREE.Matrix4();
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

        const newCrs: any = this._crsCode
            ? Projections.get(this._crsCode)
            : map.inputCRS;

        // Пре-аттач setLngLat без явного crs: _coord был записан как
        // EPSG:4326. Пересчитываем, если inputCRS другой.
        if (this._positionSetAsLonLat
            && this._lon !== null
            && this._lat !== null
            && newCrs
            && newCrs.code !== 'EPSG:4326') {
            const conv = newCrs.fromLonLat([this._lon, this._lat]);
            this._coord[0] = conv[0];
            this._coord[1] = conv[1];
        }
        this._positionSetAsLonLat = false;
        this._crs = newCrs;

        // Производные WGS84 для getLngLat.
        const ll = this._crs.toLonLat(this._coord);
        this._lon = ll[0];
        this._lat = ll[1];

        if (this._modelUrl) {
            this._object3D = new THREE.Group();
            this._isModelLoading = true;
            this._loadModel();
        } else {
            this._createPrimitive();
            this._object3D.rotation.set(...this._rotation);
        }
        map.worldGroup.add(this._object3D);

        this._registerInteraction(map);

        if (this._title && map.textManager) {
            this._textLabel = map.textManager.addLabel(this);
        }
    }

    private _registerInteraction(map: any): void {
        if (!map.interaction || typeof map.interaction.register !== 'function') return;
        if (this._unregisterInteraction) {
            this._unregisterInteraction();
            this._unregisterInteraction = null;
        }
        if (!this._onClick && !this._onHover && !this._tooltipText) return;

        this._unregisterInteraction = map.interaction.register(this, {
            getMeshes: () => this._getRaycastMeshes(),
            getBoundingSphere: () => {
                if (this._boundingRadius <= 0) return null;
                const center = this._map.getVec3().copy(this._worldPosition);
                if (this._boundingSphereOffset) {
                    const off = this._map.getVec3().copy(this._boundingSphereOffset);
                    if (this._object3D) off.applyQuaternion(this._object3D.quaternion);
                    center.add(off);
                }
                return { center, radius: this._boundingRadius };
            },
            onHover: this._onHover || null,
            onClick: this._onClick || null,
            getTooltip: this._tooltipText ? () => this._tooltipText : null,
            isVisible: () => this._isVisible,
        });
    }

    private _getRaycastMeshes(): any[] {
        if (this._raycastMeshesCache) return this._raycastMeshesCache;
        if (!this._object3D) return [];
        const meshes: any[] = [];
        if (!this._isModel) {
            meshes.push(this._object3D);
        } else {
            this._object3D.traverse((child: any) => {
                if (child.isMesh) meshes.push(child);
            });
        }
        this._raycastMeshesCache = meshes;
        return meshes;
    }

    private _createPrimitive(): void {
        const [w, h, d] = this._normalizePrimitiveSize(this._size);
        this._height = h;

        let geometry: any;
        switch (this._primitiveType.toLowerCase() as PrimitiveType) {
            case 'sphere':   geometry = new THREE.SphereGeometry(w / 2, 32, 32); break;
            case 'cylinder': geometry = new THREE.CylinderGeometry(w / 2, w / 2, h, 32); break;
            case 'cone':     geometry = new THREE.ConeGeometry(w / 2, h, 32); break;
            case 'box':
            default:         geometry = new THREE.BoxGeometry(w, h, d); break;
        }

        const material = new THREE.MeshStandardMaterial({
            color: this._color,
            roughness: 0.5,
        });
        const mesh = new THREE.Mesh(geometry, material);

        const offset = new THREE.Vector3(
            (0.5 - this._anchor[0]) * w,
            (0.5 - this._anchor[1]) * h,
            (0.5 - this._anchor[2]) * d
        );
        geometry.translate(offset.x, offset.y, offset.z);
        geometry.computeBoundingBox();
        geometry.computeBoundingSphere();

        this._localBox = geometry.boundingBox.clone();
        this._boundingRadius = geometry.boundingSphere
            ? geometry.boundingSphere.radius
            : 0.5 * Math.sqrt(w * w + h * h + d * d);
        this._boundingSphereOffset = geometry.boundingSphere
            ? geometry.boundingSphere.center.clone()
            : new THREE.Vector3();

        mesh.renderOrder = MARKER_RENDER_ORDER;
        this._geometry = geometry;
        this._material = material;
        this._object3D = mesh;
        this._raycastMeshesCache = null;
    }

    private _normalizePrimitiveSize(size: SizeSpec | null): [number, number, number] {
        if (!size) return [100, 100, 100];
        if (typeof size === 'number') return [size, size, size];
        if (Array.isArray(size)) {
            switch (size.length) {
                case 1: return [size[0], size[0], size[0]];
                case 2: return [size[0], size[1], size[0]];
                case 3: return [size[0], size[1], size[2]];
                default: throw new Error('Marker3D: size array must have 1, 2, or 3 elements');
            }
        }
        throw new Error('Marker3D: invalid size type');
    }

    /**
     * Пересоздаёт примитив в текущей позиции/повороте, освобождая
     * старые geometry и material. Используется `setSize` и `setAnchor`.
     */
    private _rebuildPrimitiveInPlace(): void {
        if (!this._object3D) return;
        const parent = this._object3D.parent;
        const oldPosition = this._object3D.position.clone();
        const oldRotation = this._object3D.rotation.clone();

        if (parent) parent.remove(this._object3D);
        if (this._geometry) this._geometry.dispose();
        if (this._material) this._material.dispose();
        this._geometry = null;
        this._material = null;

        this._createPrimitive();
        this._object3D.position.copy(oldPosition);
        this._object3D.rotation.copy(oldRotation);
        if (parent) parent.add(this._object3D);
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

                if (this._playAnimation && gltf.animations && gltf.animations.length > 0) {
                    this._mixer = new THREE.AnimationMixer(model);
                    for (const clip of gltf.animations) {
                        const action = this._mixer.clipAction(clip);
                        action.play();
                    }
                    this._mixerClock = new THREE.Clock();
                }

                const originalBox = new THREE.Box3().setFromObject(model);
                this._originalModelSize = originalBox.getSize(new THREE.Vector3());
                this._originalModelScale = model.scale.clone();
                this._originalModelPosition = model.position.clone();

                this._applyModelSizeAndAnchor(model);

                model.traverse((child: any) => {
                    if (child.isMesh) {
                        child.renderOrder = MARKER_RENDER_ORDER;
                        child.castShadow = true;
                        child.receiveShadow = true;
                    }
                });

                this._modelRoot = model;
                if (this._object3D) this._object3D.add(model);
                this._isModelLoading = false;
                this._raycastMeshesCache = null;
            } catch (err) {
                console.warn('Marker3D: GLB model loading failed:', err);
                this._isModelLoading = false;
            }
        })();
        return this._modelPromise;
    }

    private _applyModelSizeAndAnchor(model: any): void {
        const prevParent = model.parent;
        if (prevParent) prevParent.remove(model);

        model.scale.copy(this._originalModelScale);
        model.position.copy(this._originalModelPosition);
        model.rotation.set(...this._rotation);

        if (this._size) {
            const scaleFactors = this._calculateModelScale(this._size, this._originalModelSize);
            model.scale.copy(scaleFactors);
        }

        model.updateMatrixWorld(true);

        const box = new THREE.Box3().setFromObject(model);
        const size = box.getSize(new THREE.Vector3());
        this._height = size.y;
        this._boundingRadius = 0.5 * size.length();

        const boxCenter = box.getCenter(new THREE.Vector3());
        const anchorPoint = new THREE.Vector3(
            box.min.x + this._anchor[0] * size.x,
            box.min.y + this._anchor[1] * size.y,
            box.min.z + this._anchor[2] * size.z
        );
        this._boundingSphereOffset = boxCenter.clone().sub(anchorPoint);

        model.position.sub(anchorPoint);
        model.updateMatrix();

        if (prevParent) prevParent.add(model);
    }

    private _calculateModelScale(size: SizeSpec, originalSize: any): any {
        if (typeof size === 'number') {
            const currentMaxDim = Math.max(originalSize.x, originalSize.y, originalSize.z);
            const factor = size / currentMaxDim;
            return new THREE.Vector3(factor, factor, factor);
        }
        if (Array.isArray(size)) {
            switch (size.length) {
                case 1: {
                    const factor = size[0] / originalSize.y;
                    return new THREE.Vector3(factor, factor, factor);
                }
                case 2: {
                    const scaleX = size[0] / originalSize.x;
                    const scaleY = size[1] / originalSize.y;
                    const scaleZ = (scaleX + scaleY) / 2;
                    return new THREE.Vector3(scaleX, scaleY, scaleZ);
                }
                case 3:
                    return new THREE.Vector3(
                        size[0] / originalSize.x,
                        size[1] / originalSize.y,
                        size[2] / originalSize.z
                    );
                default:
                    throw new Error('Marker3D: size array must have 1, 2, or 3 elements');
            }
        }
        throw new Error('Marker3D: invalid size type');
    }

    // =================================================================
    // Мутабельность
    // =================================================================

    /** Устанавливает позицию в WGS84 [lon, lat]. */
    setLngLat(lonLat: LonLat): this {
        if (!lonLat || lonLat.length !== 2) return this;

        this._lon = lonLat[0];
        this._lat = lonLat[1];

        if (this._map && this._crs) {
            const conv = this._crs.fromLonLat(lonLat);
            this._coord[0] = conv[0];
            this._coord[1] = conv[1];
            this._positionSetAsLonLat = false;
        } else if (this._crsCode) {
            const crs = Projections.get(this._crsCode);
            const conv = crs.fromLonLat(lonLat);
            this._coord[0] = conv[0];
            this._coord[1] = conv[1];
            this._positionSetAsLonLat = false;
        } else {
            this._coord[0] = lonLat[0];
            this._coord[1] = lonLat[1];
            this._positionSetAsLonLat = true;
        }

        this._lastHeightUpdateTime = 0;
        return this;
    }

    /** Координаты в WGS84 [lon, lat], либо `null`. */
    getLngLat(): LonLat | null {
        if (this._lon !== null && this._lat !== null) return [this._lon, this._lat];
        if (this._crs) {
            const ll = this._crs.toLonLat(this._coord);
            return [ll[0], ll[1]];
        }
        if (this._crsCode) {
            const crs = Projections.get(this._crsCode);
            const ll = crs.toLonLat(this._coord);
            return [ll[0], ll[1]];
        }
        return null;
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

    /** Меняет углы поворота (радианы). */
    setRotation(rotation: Vec3): this {
        this._rotation = [rotation[0], rotation[1], rotation[2]];
        if (!this._object3D) return this;
        if (this._isModel) {
            if (this._modelRoot) this._applyModelSizeAndAnchor(this._modelRoot);
        } else {
            this._object3D.rotation.set(...this._rotation);
        }
        return this;
    }

    /**
     * Меняет точку привязки (нормализованные [0..1] по bounding box).
     * Пересчитывает геометрию/смещение модели — «центр» маркера
     * визуально остаётся на той же географической точке.
     */
    setAnchor(anchor: Vec3): this {
        this._anchor = [anchor[0], anchor[1], anchor[2]];
        if (!this._object3D) return this;
        if (this._isModel) {
            if (this._modelRoot) this._applyModelSizeAndAnchor(this._modelRoot);
        } else {
            this._rebuildPrimitiveInPlace();
        }
        return this;
    }

    /** Меняет размер. См. описание `options.size` для примитивов и GLB. */
    setSize(size: SizeSpec): this {
        this._size = size;
        if (!this._object3D) return this;
        if (this._isModel) {
            if (this._isModelLoading || !this._modelRoot) return this;
            this._applyModelSizeAndAnchor(this._modelRoot);
        } else {
            this._rebuildPrimitiveInPlace();
        }
        return this;
    }

    /** Возвращает текущую спецификацию размера. */
    getSize(): SizeSpec | null { return this._size; }

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

    /** Управляет видимостью (перекрывает зум и видимость слоя). */
    setVisible(visible: boolean): this {
        this._userVisible = !!visible;
        if (!this._object3D) return this;
        if (!this._userVisible) {
            this._object3D.visible = false;
            this._isVisible = false;
        }
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

    /** Устанавливает границы видимости по зуму. */
    setZoomBounds(minZoom: number, maxZoom: number): this {
        this._minZoom = minZoom;
        this._maxZoom = maxZoom;
        return this;
    }

    /** Запускает анимацию размера. */
    animateSize(newSize: SizeSpec, duration = 1000, easing: Easing = 'linear'): this {
        let startSize: SizeSpec = this._size ?? [100, 100, 100];
        if (this._size === null && this._isModel && this._originalModelSize) {
            startSize = Math.max(
                this._originalModelSize.x,
                this._originalModelSize.y,
                this._originalModelSize.z
            );
        }
        this._sizeAnimation = {
            startSize,
            endSize: newSize,
            startTime: performance.now(),
            duration,
            easing,
        };
        return this;
    }

    /** Центр (по факту — позиция) в WGS84: `[lon, lat]`, либо `null`. */
    getCenter(): LonLat | null {
        const ll = this.getLngLat();
        return ll ? [ll[0], ll[1]] : null;
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
        if (this._object3D) {
            if (this._object3D.parent) this._object3D.parent.remove(this._object3D);
            if (this._geometry) this._geometry.dispose();
            if (this._material) this._material.dispose();
            this._object3D = null;
            this._modelRoot = null;
            this._geometry = null;
            this._material = null;
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
        this._isVisible = false;
        this._worldPosition.set(0, 0, 0);
        this._localBox = null;
        this._boundingRadius = 0;
        this._raycastMeshesCache = null;
        this._boundingSphereOffset = null;
        this._isModelLoading = false;
        this._modelPromise = null;
    }

    // =================================================================
    // Обновление на кадре
    // =================================================================

    private _updateSizeAnimation(now: number): void {
        if (!this._sizeAnimation) return;
        const anim = this._sizeAnimation;
        const elapsed = now - anim.startTime;
        const t = Math.min(elapsed / anim.duration, 1);

        let progress: number;
        switch (anim.easing) {
            case 'easeIn':    progress = t * t; break;
            case 'easeOut':   progress = 1 - Math.pow(1 - t, 2); break;
            case 'easeInOut': progress = t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2; break;
            case 'linear':
            default:          progress = t; break;
        }

        const currentSize = this._lerpSize(anim.startSize, anim.endSize, progress);
        this.setSize(currentSize);

        if (t >= 1) {
            this._sizeAnimation = null;
            this.setSize(anim.endSize);
        }
    }

    private _lerpSize(start: SizeSpec, end: SizeSpec, t: number): SizeSpec {
        if (typeof start === 'number' && typeof end === 'number') {
            return start + (end - start) * t;
        }
        if (Array.isArray(start) && Array.isArray(end)) {
            const len = Math.min(start.length, end.length);
            const result: number[] = [];
            for (let i = 0; i < len; i++) {
                result.push(start[i] + (end[i] - start[i]) * t);
            }
            return result;
        }
        return end;
    }

    _update(_map: any): void {
        if (!this._map || !this._object3D) return;
        const mapInstance = this._map;
        const zoom = mapInstance.continuousZoom;

        if (!this._userVisible) {
            this._object3D.visible = false;
            this._isVisible = false;
            return;
        }
        if (this._layer && !(this._layer as any).visible) {
            this._object3D.visible = false;
            this._isVisible = false;
            return;
        }
        if (zoom < this._minZoom || zoom > this._maxZoom) {
            this._object3D.visible = false;
            this._isVisible = false;
            return;
        }

        this._updateSizeAnimation(performance.now());
        if (this._mixer && this._mixerClock) {
            const delta = this._mixerClock.getDelta();
            this._mixer.update(delta);
        }

        const [absWorldX, absWorldZ] = mapInstance.project(this._coord, this._crs);
        const wgPos = mapInstance.worldGroup.position;
        const worldX = absWorldX + wgPos.x;
        const worldZ = absWorldZ + wgPos.z;
        let worldY = 0;
        if (this._altitudeMode === 'clampToGround') {
            const now = performance.now();
            if (now - this._lastHeightUpdateTime > 500) {
                mapInstance.ensureTileForPoint(worldX, worldZ);
                this._cachedWorldY = mapInstance.getSurfaceHeightAt(worldX, worldZ);
                this._lastHeightUpdateTime = now;
            }
            worldY = this._cachedWorldY + this._altitude;
        } else {
            worldY = this._altitude;
        }

        this._object3D.position.set(absWorldX, worldY, absWorldZ);
        this._worldPosition.set(worldX, worldY, worldZ);

        if (mapInstance.view.objectRenderDistanceFactor > 0) {
            const dist = mapInstance.camera.position.distanceTo(this._worldPosition);
            if (dist > mapInstance.maxObjectDistance) {
                this._object3D.visible = false;
                this._isVisible = false;
                return;
            }
        }

        this._tempProjScreenMatrix.multiplyMatrices(
            mapInstance.camera.projectionMatrix,
            mapInstance.camera.matrixWorldInverse
        );
        this._tempFrustum.setFromProjectionMatrix(this._tempProjScreenMatrix);

        if (this._isModel) {
            this._tempBox.setFromObject(this._object3D);
        } else if (this._localBox) {
            this._object3D.updateWorldMatrix(true, false);
            this._tempBox.copy(this._localBox).applyMatrix4(this._object3D.matrixWorld);
        } else {
            this._object3D.visible = false;
            this._isVisible = false;
            return;
        }

        if (!this._tempFrustum.intersectsBox(this._tempBox)) {
            this._object3D.visible = false;
            this._isVisible = false;
            return;
        }

        this._object3D.visible = true;
        this._isVisible = true;
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

    getLabelType(): 'point' { return 'point'; }

    isVisible(): boolean { return this._isVisible; }

    getScreenPosition(): { x: number; y: number } | null {
        if (!this._isVisible || !this._object3D || !this._map) return null;
        const map = this._map;
        const canvas = map.renderer.domElement;

        if (!this._isModel && !this._localBox) {
            const localTop = map.getVec3().set(0, this._height * (1 - this._anchor[1]), 0);
            this._object3D.updateWorldMatrix(false, false);
            localTop.applyMatrix4(this._object3D.matrixWorld);
            const screenPos = map.getVec3().copy(localTop).project(map.camera);
            if (screenPos.z > 1 || Math.abs(screenPos.x) > 1 || Math.abs(screenPos.y) > 1) return null;
            return {
                x: (screenPos.x * 0.5 + 0.5) * canvas.clientWidth,
                y: (-screenPos.y * 0.5 + 0.5) * canvas.clientHeight,
            };
        }

        let box: any;
        if (this._isModel) {
            box = this._tempBox.setFromObject(this._object3D);
        } else {
            this._object3D.updateWorldMatrix(true, false);
            box = this._tempBox.copy(this._localBox).applyMatrix4(this._object3D.matrixWorld);
        }

        const corners: Array<{ x: number; y: number }> = [];
        const { min, max } = box;
        for (let i = 0; i < 8; i++) {
            const corner = map.getVec3().set(
                (i & 1) ? max.x : min.x,
                (i & 2) ? max.y : min.y,
                (i & 4) ? max.z : min.z
            );
            corner.project(map.camera);
            if (corner.z > 1 || corner.z < -1) continue;
            corners.push({
                x: (corner.x * 0.5 + 0.5) * canvas.clientWidth,
                y: (-corner.y * 0.5 + 0.5) * canvas.clientHeight,
            });
        }
        if (corners.length === 0) return null;

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
            case 'left':   x = minX;   y = centerY; break;
            case 'right':  x = maxX;   y = centerY; break;
            case 'top':
            default:       x = centerX; y = minY; break;
        }
        return { x, y };
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

    /** Участвует ли маркер в кластеризации (информационный геттер). */
    getClusterable(): boolean { return this._clusterable; }

    // =================================================================
    // KrbMap#fitTo / getBounds
    // =================================================================

    getBounds(crs: string | any = 'EPSG:4326'): [LonLat, LonLat] | null {
        const src = this._crs
            ?? (this._crsCode ? Projections.get(this._crsCode) : Projections.get('EPSG:4326'));
        const dst = typeof crs === 'string' ? Projections.get(crs) : crs;
        if (!src || !dst) return null;

        let x: number, y: number;
        if (src === dst) {
            x = this._coord[0];
            y = this._coord[1];
        } else {
            const lonLat = src.toLonLat(this._coord);
            const conv = dst.fromLonLat(lonLat);
            x = conv[0];
            y = conv[1];
        }
        return [[x, y], [x, y]];
    }
}