/**
 * Marker3D — 3D-маркер (примитив или GLB-модель). После `addTo()`
 * мутабелен: позиция, размер, поворот, anchor, цвет, видимость, текст
 * и тултип меняются без пересоздания объекта.
 *
 * Наследует SpatialObject: zoom bounds, видимость, tooltip, onClick/onHover,
 * подпись, altitude и TextManager-контракт берутся из базового класса.
 * Здесь остаётся только 3D-специфика: GLTF, примитивы, bbox/frustum,
 * анимация размера, рельеф, depth-флаги, `_titlePlacement`.
 *
 * @module Marker3D
 */
import { THREE, GLTFLoader, DRACOLoader } from './js_TP/tpb.js';
import { Projections } from './Projections.js';
import { SpatialObject } from './SpatialObject.js';
const MARKER_RENDER_ORDER = 1000;
// =====================================================================
// Marker3D
// =====================================================================
export class Marker3D extends SpatialObject {
    // ── Данные позиции ──
    _coord;
    _crsCode;
    _crs;
    _lon = null;
    _lat = null;
    _positionSetAsLonLat = false;
    // ── Оформление ── (altitude — в базе)
    _primitiveType;
    _size;
    _modelUrl;
    _altitudeMode;
    _rotation;
    _anchor;
    _playAnimation;
    _color;
    _depthTest;
    _depthWrite;
    // ── Подпись: размещение (влияет на offset и verticalAlign) ──
    _titlePlacement;
    // ── Интерактив / кластеризация ──
    _clusterable;
    _unregisterInteraction = null;
    // ── 3D-объекты ──
    _object3D = null;
    _modelRoot = null;
    _geometry = null;
    _material = null;
    _lastHeightUpdateTime = 0;
    _cachedWorldY = 0;
    _isModelLoading = false;
    _modelPromise = null;
    _worldPosition;
    _localBox = null;
    _originalModelSize = null;
    _originalModelScale = null;
    _originalModelPosition = null;
    _isModel;
    _sizeAnimation = null;
    _boundingRadius = 0;
    _boundingSphereOffset = null;
    _raycastMeshesCache = null;
    _height = 0;
    // ── Анимации GLB ──
    _mixer = null;
    _mixerClock = null;
    // ── Временные объекты ──
    _tempBox;
    _tempFrustum;
    _tempProjScreenMatrix;
    constructor(options) {
        super();
        if (options.zoomInterpolate)
            this.setZoomInterpolations(options.zoomInterpolate);
        this._properties = options.properties ?? {};
        this._userData = options.userData ?? {};
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
        this._color = options.color ?? 0x3388ff;
        this._depthTest = options.depthTest ?? true;
        this._depthWrite = options.depthWrite ?? true;
        this._isModel = !!this._modelUrl;
        this._title = options.title ?? '';
        this._titleStyle = options.titleStyle ?? {};
        this._titleMinZoom = options.titleMinZoom ?? -Infinity;
        this._titleMaxZoom = options.titleMaxZoom ?? Infinity;
        this._titlePlacement = options.titlePlacement ?? 'top';
        if (options.titleAlign !== undefined) {
            this._titleAlign = options.titleAlign;
        }
        else {
            switch (this._titlePlacement) {
                case 'left':
                    this._titleAlign = 'right';
                    break;
                case 'right':
                    this._titleAlign = 'left';
                    break;
                case 'top':
                case 'bottom':
                default:
                    this._titleAlign = 'center';
                    break;
            }
        }
        this._userTitleOffset = options.titleOffset
            ? [options.titleOffset[0], options.titleOffset[1]]
            : null;
        this._resolveTitleOffset();
        this._tooltipText = options.tooltip ?? '';
        this._onClick = options.onClick ?? null;
        this._onHover = options.onHover ?? null;
        this._clusterable = options.clusterable ?? false;
        this._worldPosition = new THREE.Vector3();
        this._tempBox = new THREE.Box3();
        this._tempFrustum = new THREE.Frustum();
        this._tempProjScreenMatrix = new THREE.Matrix4();
    }
    // =================================================================
    // Хуки SpatialObject
    // =================================================================
    _onAttached(map) {
        const newCrs = this._crsCode
            ? Projections.get(this._crsCode)
            : map.inputCRS;
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
        const ll = this._crs.toLonLat(this._coord);
        this._lon = ll[0];
        this._lat = ll[1];
        if (this._modelUrl) {
            this._object3D = new THREE.Group();
            this._isModelLoading = true;
            this._loadModel();
        }
        else {
            this._createPrimitive();
            this._object3D.rotation.set(...this._rotation);
        }
        map.worldGroup.add(this._object3D);
        this._registerInteraction(map);
    }
    _teardown() {
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
            if (this._object3D.parent)
                this._object3D.parent.remove(this._object3D);
            if (this._geometry)
                this._geometry.dispose();
            if (this._material)
                this._material.dispose();
            this._object3D = null;
            this._modelRoot = null;
            this._geometry = null;
            this._material = null;
        }
        this._crs = null;
        this._worldPosition.set(0, 0, 0);
        this._localBox = null;
        this._boundingRadius = 0;
        this._raycastMeshesCache = null;
        this._boundingSphereOffset = null;
        this._isModelLoading = false;
        this._modelPromise = null;
        this._sizeAnimation = null;
    }
    _applyHidden() {
        if (this._object3D)
            this._object3D.visible = false;
    }
    _defaultTitleOffset() {
        switch (this._titlePlacement) {
            case 'top': return [0, -10];
            case 'bottom': return [0, 10];
            case 'left': return [-10, 0];
            case 'right': return [10, 0];
            default: return [0, -10];
        }
    }
    /** Смена высоты — сбросить кэш рельефа. */
    _onAltitudeChanged() {
        this._lastHeightUpdateTime = 0;
    }
    _onTooltipChanged() {
        if (this._map)
            this._registerInteraction(this._map);
    }
    getLabelType() { return 'point'; }
    // =================================================================
    // Интерактив
    // =================================================================
    _registerInteraction(map) {
        if (!map.interaction || typeof map.interaction.register !== 'function')
            return;
        if (this._unregisterInteraction) {
            this._unregisterInteraction();
            this._unregisterInteraction = null;
        }
        if (!this._onClick && !this._onHover && !this._tooltipText)
            return;
        this._unregisterInteraction = map.interaction.register(this, {
            getMeshes: () => this._getRaycastMeshes(),
            getBoundingSphere: () => {
                if (this._boundingRadius <= 0)
                    return null;
                const center = this._map.getVec3().copy(this._worldPosition);
                if (this._boundingSphereOffset) {
                    const off = this._map.getVec3().copy(this._boundingSphereOffset);
                    if (this._object3D)
                        off.applyQuaternion(this._object3D.quaternion);
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
    _getRaycastMeshes() {
        if (this._raycastMeshesCache)
            return this._raycastMeshesCache;
        if (!this._object3D)
            return [];
        const meshes = [];
        if (!this._isModel) {
            meshes.push(this._object3D);
        }
        else {
            this._object3D.traverse((child) => {
                if (child.isMesh)
                    meshes.push(child);
            });
        }
        this._raycastMeshesCache = meshes;
        return meshes;
    }
    // =================================================================
    // Построение примитива / GLB
    // =================================================================
    _createPrimitive() {
        const [w, h, d] = this._normalizePrimitiveSize(this._size);
        this._height = h;
        let geometry;
        switch (this._primitiveType.toLowerCase()) {
            case 'sphere':
                geometry = new THREE.SphereGeometry(w / 2, 32, 32);
                break;
            case 'cylinder':
                geometry = new THREE.CylinderGeometry(w / 2, w / 2, h, 32);
                break;
            case 'cone':
                geometry = new THREE.ConeGeometry(w / 2, h, 32);
                break;
            case 'box':
            default:
                geometry = new THREE.BoxGeometry(w, h, d);
                break;
        }
        const material = new THREE.MeshStandardMaterial({
            color: this._color,
            roughness: 0.5,
            depthTest: this._depthTest,
            depthWrite: this._depthWrite,
        });
        const mesh = new THREE.Mesh(geometry, material);
        const offset = new THREE.Vector3((0.5 - this._anchor[0]) * w, (0.5 - this._anchor[1]) * h, (0.5 - this._anchor[2]) * d);
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
    _normalizePrimitiveSize(size) {
        if (!size)
            return [100, 100, 100];
        if (typeof size === 'number')
            return [size, size, size];
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
    _rebuildPrimitiveInPlace() {
        if (!this._object3D)
            return;
        const parent = this._object3D.parent;
        const oldPosition = this._object3D.position.clone();
        const oldRotation = this._object3D.rotation.clone();
        if (parent)
            parent.remove(this._object3D);
        if (this._geometry)
            this._geometry.dispose();
        if (this._material)
            this._material.dispose();
        this._geometry = null;
        this._material = null;
        this._createPrimitive();
        this._object3D.position.copy(oldPosition);
        this._object3D.rotation.copy(oldRotation);
        if (parent)
            parent.add(this._object3D);
        this._raycastMeshesCache = null;
    }
    async _loadModel() {
        if (this._modelPromise)
            return this._modelPromise;
        this._modelPromise = (async () => {
            try {
                const loader = new GLTFLoader();
                const dracoLoader = new DRACOLoader();
                dracoLoader.setDecoderPath('https://cdn.mapengine.ru/KRB/js_TP/draco/');
                dracoLoader.setDecoderConfig({ type: 'wasm' });
                loader.setDRACOLoader(dracoLoader);
                const gltf = await loader.loadAsync(this._modelUrl);
                const model = gltf.scene;
                if (this._playAnimation && gltf.animations && gltf.animations.length > 0) {
                    this._mixer = new THREE.AnimationMixer(model);
                    for (const clip of gltf.animations) {
                        this._mixer.clipAction(clip).play();
                    }
                    this._mixerClock = new THREE.Clock();
                }
                const originalBox = new THREE.Box3().setFromObject(model);
                this._originalModelSize = originalBox.getSize(new THREE.Vector3());
                this._originalModelScale = model.scale.clone();
                this._originalModelPosition = model.position.clone();
                this._applyModelSizeAndAnchor(model);
                model.traverse((child) => {
                    if (!child.isMesh)
                        return;
                    child.renderOrder = MARKER_RENDER_ORDER;
                    child.castShadow = true;
                    child.receiveShadow = true;
                    if (child.material) {
                        const mats = Array.isArray(child.material) ? child.material : [child.material];
                        for (const m of mats) {
                            m.depthTest = this._depthTest;
                            m.depthWrite = this._depthWrite;
                            m.needsUpdate = true;
                        }
                    }
                });
                this._modelRoot = model;
                if (this._object3D)
                    this._object3D.add(model);
                this._isModelLoading = false;
                this._raycastMeshesCache = null;
            }
            catch (err) {
                console.warn('Marker3D: GLB model loading failed:', err);
                this._isModelLoading = false;
            }
        })();
        return this._modelPromise;
    }
    _applyModelSizeAndAnchor(model) {
        const prevParent = model.parent;
        if (prevParent)
            prevParent.remove(model);
        model.scale.copy(this._originalModelScale);
        model.position.copy(this._originalModelPosition);
        model.rotation.set(...this._rotation);
        if (this._size) {
            model.scale.copy(this._calculateModelScale(this._size, this._originalModelSize));
        }
        model.updateMatrixWorld(true);
        const box = new THREE.Box3().setFromObject(model);
        const size = box.getSize(new THREE.Vector3());
        this._height = size.y;
        this._boundingRadius = 0.5 * size.length();
        const boxCenter = box.getCenter(new THREE.Vector3());
        const anchorPoint = new THREE.Vector3(box.min.x + this._anchor[0] * size.x, box.min.y + this._anchor[1] * size.y, box.min.z + this._anchor[2] * size.z);
        this._boundingSphereOffset = boxCenter.clone().sub(anchorPoint);
        model.position.sub(anchorPoint);
        model.updateMatrix();
        if (prevParent)
            prevParent.add(model);
    }
    _calculateModelScale(size, originalSize) {
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
                    return new THREE.Vector3(size[0] / originalSize.x, size[1] / originalSize.y, size[2] / originalSize.z);
                default:
                    throw new Error('Marker3D: size array must have 1, 2, or 3 elements');
            }
        }
        throw new Error('Marker3D: invalid size type');
    }
    // =================================================================
    // Позиция / CRS
    // =================================================================
    setLngLat(lonLat) {
        if (!lonLat || lonLat.length !== 2)
            return this;
        this._lon = lonLat[0];
        this._lat = lonLat[1];
        if (this._map && this._crs) {
            const conv = this._crs.fromLonLat(lonLat);
            this._coord[0] = conv[0];
            this._coord[1] = conv[1];
            this._positionSetAsLonLat = false;
        }
        else if (this._crsCode) {
            const crs = Projections.get(this._crsCode);
            const conv = crs.fromLonLat(lonLat);
            this._coord[0] = conv[0];
            this._coord[1] = conv[1];
            this._positionSetAsLonLat = false;
        }
        else {
            this._coord[0] = lonLat[0];
            this._coord[1] = lonLat[1];
            this._positionSetAsLonLat = true;
        }
        this._lastHeightUpdateTime = 0;
        return this;
    }
    getLngLat() {
        if (this._lon !== null && this._lat !== null)
            return [this._lon, this._lat];
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
    getLonLat() { return this.getLngLat(); }
    /** Возвращает исходные координаты в собственной СК маркера. */
    getPosition() { return [this._coord[0], this._coord[1]]; }
    /** Возвращает код СК маркера или null. */
    getCRS() { return this._crsCode; }
    /** Центр (по факту — позиция) в WGS84: `[lon, lat]`, либо `null`. */
    getCenter() {
        const ll = this.getLngLat();
        return ll ? [ll[0], ll[1]] : null;
    }
    // =================================================================
    // Altitude MODE (setAltitude/getAltitude — в базе)
    // =================================================================
    setAltitudeMode(mode) {
        this._altitudeMode = mode;
        this._onAltitudeChanged();
        return this;
    }
    getAltitudeMode() { return this._altitudeMode; }
    // =================================================================
    // Rotation / anchor / size / color
    // =================================================================
    setRotation(rotation) {
        this._rotation = [rotation[0], rotation[1], rotation[2]];
        if (!this._object3D)
            return this;
        if (this._isModel) {
            if (this._modelRoot)
                this._applyModelSizeAndAnchor(this._modelRoot);
        }
        else {
            this._object3D.rotation.set(...this._rotation);
        }
        return this;
    }
    getRotation() {
        return [this._rotation[0], this._rotation[1], this._rotation[2]];
    }
    setAnchor(anchor) {
        this._anchor = [anchor[0], anchor[1], anchor[2]];
        if (!this._object3D)
            return this;
        if (this._isModel) {
            if (this._modelRoot)
                this._applyModelSizeAndAnchor(this._modelRoot);
        }
        else {
            this._rebuildPrimitiveInPlace();
        }
        return this;
    }
    getAnchor() {
        return [this._anchor[0], this._anchor[1], this._anchor[2]];
    }
    setSize(size) {
        this._size = size;
        if (!this._object3D)
            return this;
        if (this._isModel) {
            if (this._isModelLoading || !this._modelRoot)
                return this;
            this._applyModelSizeAndAnchor(this._modelRoot);
        }
        else {
            this._rebuildPrimitiveInPlace();
        }
        return this;
    }
    getSize() { return this._size; }
    setColor(color) {
        this._color = color;
        if (!this._object3D)
            return this;
        if (this._object3D.material) {
            if (this._object3D.material.color) {
                this._object3D.material.color.set(color);
            }
        }
        else {
            this._object3D.traverse((child) => {
                if (child.isMesh && child.material?.color) {
                    child.material.color.set(color);
                }
            });
        }
        return this;
    }
    getColor() { return this._color; }
    /** Участвует ли маркер в кластеризации. */
    getClusterable() { return this._clusterable; }
    // =================================================================
    // Depth
    // =================================================================
    setDepthTest(depthTest) {
        this._depthTest = !!depthTest;
        this._applyDepthFlags();
        return this;
    }
    getDepthTest() { return this._depthTest; }
    setDepthWrite(depthWrite) {
        this._depthWrite = !!depthWrite;
        this._applyDepthFlags();
        return this;
    }
    getDepthWrite() { return this._depthWrite; }
    _applyDepthFlags() {
        if (!this._object3D)
            return;
        const meshes = [];
        if (this._object3D.isMesh)
            meshes.push(this._object3D);
        else
            this._object3D.traverse((child) => { if (child.isMesh)
                meshes.push(child); });
        for (const m of meshes) {
            const mat = m.material;
            if (!mat)
                continue;
            const mats = Array.isArray(mat) ? mat : [mat];
            for (const mm of mats) {
                let changed = false;
                if (mm.depthTest !== this._depthTest) {
                    mm.depthTest = this._depthTest;
                    changed = true;
                }
                if (mm.depthWrite !== this._depthWrite) {
                    mm.depthWrite = this._depthWrite;
                    changed = true;
                }
                if (changed)
                    mm.needsUpdate = true;
            }
        }
    }
    // =================================================================
    // Анимация размера
    // =================================================================
    animateSize(newSize, duration = 1000, easing = 'linear') {
        let startSize = this._size ?? [100, 100, 100];
        if (this._size === null && this._isModel && this._originalModelSize) {
            startSize = Math.max(this._originalModelSize.x, this._originalModelSize.y, this._originalModelSize.z);
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
    _updateSizeAnimation(now) {
        if (!this._sizeAnimation)
            return;
        const anim = this._sizeAnimation;
        const elapsed = now - anim.startTime;
        const t = Math.min(elapsed / anim.duration, 1);
        let progress;
        switch (anim.easing) {
            case 'easeIn':
                progress = t * t;
                break;
            case 'easeOut':
                progress = 1 - Math.pow(1 - t, 2);
                break;
            case 'easeInOut':
                progress = t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
                break;
            case 'linear':
            default:
                progress = t;
                break;
        }
        this.setSize(this._lerpSize(anim.startSize, anim.endSize, progress));
        if (t >= 1) {
            this._sizeAnimation = null;
            this.setSize(anim.endSize);
        }
    }
    _lerpSize(start, end, t) {
        if (typeof start === 'number' && typeof end === 'number') {
            return start + (end - start) * t;
        }
        if (Array.isArray(start) && Array.isArray(end)) {
            const len = Math.min(start.length, end.length);
            const result = [];
            for (let i = 0; i < len; i++) {
                result.push(start[i] + (end[i] - start[i]) * t);
            }
            return result;
        }
        return end;
    }
    // =================================================================
    // Обновление на кадре
    // =================================================================
    _update(_map) {
        if (!this._map || !this._object3D)
            return;
        const map = this._map;
        this._applyZoomInterpolations(map.continuousZoom);
        if (!this._isWithinView()) {
            this._applyHidden();
            this._isVisible = false;
            return;
        }
        this._updateSizeAnimation(performance.now());
        if (this._mixer && this._mixerClock) {
            const delta = this._mixerClock.getDelta();
            this._mixer.update(delta);
        }
        const [absWorldX, absWorldZ] = map.project(this._coord, this._crs);
        const wgPos = map.worldGroup.position;
        const worldX = absWorldX + wgPos.x;
        const worldZ = absWorldZ + wgPos.z;
        let worldY = 0;
        if (this._altitudeMode === 'clampToGround') {
            const now = performance.now();
            if (now - this._lastHeightUpdateTime > 500) {
                map.ensureTileForPoint(worldX, worldZ);
                this._cachedWorldY = map.getSurfaceHeightAt(worldX, worldZ);
                this._lastHeightUpdateTime = now;
            }
            worldY = this._cachedWorldY + this._altitude;
        }
        else {
            worldY = this._altitude;
        }
        this._object3D.position.set(absWorldX, worldY, absWorldZ);
        this._worldPosition.set(worldX, worldY, worldZ);
        if (map.view.objectRenderDistanceFactor > 0) {
            const dist = map.camera.position.distanceTo(this._worldPosition);
            if (dist > map.maxObjectDistance) {
                this._applyHidden();
                this._isVisible = false;
                return;
            }
        }
        this._tempProjScreenMatrix.multiplyMatrices(map.camera.projectionMatrix, map.camera.matrixWorldInverse);
        this._tempFrustum.setFromProjectionMatrix(this._tempProjScreenMatrix);
        if (this._isModel) {
            this._tempBox.setFromObject(this._object3D);
        }
        else if (this._localBox) {
            this._object3D.updateWorldMatrix(true, false);
            this._tempBox.copy(this._localBox).applyMatrix4(this._object3D.matrixWorld);
        }
        else {
            this._applyHidden();
            this._isVisible = false;
            return;
        }
        if (!this._tempFrustum.intersectsBox(this._tempBox)) {
            this._applyHidden();
            this._isVisible = false;
            return;
        }
        this._object3D.visible = true;
        this._isVisible = true;
    }
    // =================================================================
    // TextManager-специфика Marker3D
    // =================================================================
    getTitleVerticalAlign() {
        switch (this._titlePlacement) {
            case 'bottom': return 'top';
            case 'left':
            case 'right': return 'center';
            case 'top':
            default: return 'bottom';
        }
    }
    getScreenPosition() {
        if (!this._isVisible || !this._object3D || !this._map)
            return null;
        const map = this._map;
        const canvas = map.renderer.domElement;
        if (!this._isModel && !this._localBox) {
            const localTop = map.getVec3().set(0, this._height * (1 - this._anchor[1]), 0);
            this._object3D.updateWorldMatrix(false, false);
            localTop.applyMatrix4(this._object3D.matrixWorld);
            const screenPos = map.getVec3().copy(localTop).project(map.camera);
            if (screenPos.z > 1 || Math.abs(screenPos.x) > 1 || Math.abs(screenPos.y) > 1)
                return null;
            return {
                x: (screenPos.x * 0.5 + 0.5) * canvas.clientWidth,
                y: (-screenPos.y * 0.5 + 0.5) * canvas.clientHeight,
            };
        }
        let box;
        if (this._isModel) {
            box = this._tempBox.setFromObject(this._object3D);
        }
        else {
            this._object3D.updateWorldMatrix(true, false);
            box = this._tempBox.copy(this._localBox).applyMatrix4(this._object3D.matrixWorld);
        }
        const corners = [];
        const { min, max } = box;
        for (let i = 0; i < 8; i++) {
            const corner = map.getVec3().set((i & 1) ? max.x : min.x, (i & 2) ? max.y : min.y, (i & 4) ? max.z : min.z);
            corner.project(map.camera);
            if (corner.z > 1 || corner.z < -1)
                continue;
            corners.push({
                x: (corner.x * 0.5 + 0.5) * canvas.clientWidth,
                y: (-corner.y * 0.5 + 0.5) * canvas.clientHeight,
            });
        }
        if (corners.length === 0)
            return null;
        let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
        for (const c of corners) {
            if (c.x < minX)
                minX = c.x;
            if (c.x > maxX)
                maxX = c.x;
            if (c.y < minY)
                minY = c.y;
            if (c.y > maxY)
                maxY = c.y;
        }
        const centerX = (minX + maxX) / 2;
        const centerY = (minY + maxY) / 2;
        switch (this._titlePlacement) {
            case 'bottom': return { x: centerX, y: maxY };
            case 'left': return { x: minX, y: centerY };
            case 'right': return { x: maxX, y: centerY };
            case 'top':
            default: return { x: centerX, y: minY };
        }
    }
    // =================================================================
    // KrbMap#fitTo / getBounds
    // =================================================================
    getBounds(crs = 'EPSG:4326') {
        const src = this._crs
            ?? (this._crsCode ? Projections.get(this._crsCode) : Projections.get('EPSG:4326'));
        const dst = typeof crs === 'string' ? Projections.get(crs) : crs;
        if (!src || !dst)
            return null;
        let x, y;
        if (src === dst) {
            x = this._coord[0];
            y = this._coord[1];
        }
        else {
            const lonLat = src.toLonLat(this._coord);
            const conv = dst.fromLonLat(lonLat);
            x = conv[0];
            y = conv[1];
        }
        return [[x, y], [x, y]];
    }
}
