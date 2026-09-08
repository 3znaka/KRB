/**
 * Модуль Area3D — 3D-объект, привязанный к площадной геометрии (полигону).
 * Позволяет размещать GLB-модели или примитивы внутри четырёхугольного полигона
 * с возможностью растягивания/вписывания, поворота и учётом рельефа.
 *
 * @example
 * const area = new Area3D({
 *     rings: [[[30.5, 50.4], [31.0, 50.5], [31.2, 50.7], [30.8, 50.8], [30.5, 50.4]]],
 *     modelUrl: './ladder.glb',
 *     fit: 'stretch',
 *     rotate: 0,
 *     altitudeMode: 'clampToGround',
 *     altitude: 5,
 *     title: 'Здание',
 *     onClick: (e, obj) => console.log('Клик по Area3D', obj)
 * });
 * area.addTo(map);
 */
import { THREE, GLTFLoader } from '../js_TP/tpb.js';
import { proj } from './Utils.js';
import { Layer } from './Layers.js';

const AREA3D_RENDER_ORDER = 1000;

export class Area3D {
    static _idCounter = 0;
    static _activeAreas = new Set();
    static _hoveredArea = null;
    static _pressedArea = null;
    static _pressStart = null;
    static _raycaster = new THREE.Raycaster();
    static _mapEventHandlers = new WeakMap();
    static _isMobile = (typeof window !== 'undefined') && (('ontouchstart' in window) || (navigator.maxTouchPoints > 0));

    constructor(options = {}) {
        if (!options.rings || !options.rings.length || options.rings[0].length < 3) {
            throw new Error('Area3D: options.rings is required with at least one ring of 3+ points');
        }

        this._rings = options.rings;
        this._modelUrl = options.modelUrl || null;
        this._primitiveType = options.primitiveType || 'box';
        this._size = options.size || null;
        this._fit = options.fit || 'stretch';
        this._rotate = options.rotate || 0;
        this._altitude = options.altitude ?? 0;
        this._altitudeMode = options.altitudeMode || 'clampToGround';
        this._anchor = options.anchor || [0.5, 0, 0.5];
        this._minZoom = options.minZoom ?? -Infinity;
        this._maxZoom = options.maxZoom ?? Infinity;
        this._playAnimation = options.playAnimation !== undefined ? options.playAnimation : true;
        this._color = options.color || 0x3388ff;
        this._depthTest = options.depthTest ?? true;
        this._depthWrite = options.depthWrite ?? true;

        this._title = options.title || '';
        this._titleStyle = options.titleStyle || {};
        this._titleMinZoom = options.titleMinZoom ?? -Infinity;
        this._titleMaxZoom = options.titleMaxZoom ?? Infinity;
        this._titlePlacement = options.titlePlacement || 'top';
        this._titleAlign = options.titleAlign || this._defaultTitleAlign();
        this._titleOffset = options.titleOffset || this._defaultTitleOffset();

        this._tooltipText = options.tooltip || '';
        this._onClick = options.onClick || null;
        this._onHover = options.onHover || null;

        this._map = null;
        this._layer = null;
        this._group = new THREE.Group();
        this._modelContainer = new THREE.Group();
        this._group.add(this._modelContainer);
        this._object3D = null;
        this._mixer = null;
        this._mixerClock = null;
        this._isModelLoading = false;
        this._modelPromise = null;
        this._originalModelSize = null;
        this._originalModelScale = null;
        this._originalModelPosition = null;
        this._modelAnchorOffset = new THREE.Vector3();

        this._centroidWorld = new THREE.Vector3();
        this._polygonAngle = 0;
        this._polygonWidth = 0;
        this._polygonDepth = 0;
        this._worldCoords = [];

        this._cachedSurfaceHeight = 0;
        this._lastHeightUpdateTime = 0;
        this._heightUpdateInterval = 500;
        this._lastWorldGroupPos = new THREE.Vector3();

        this._rotate = Math.min(3, Math.max(0, Math.floor(this._rotate)));

        if (this._onClick || this._onHover || this._tooltipText) {
            Area3D._activeAreas.add(this);
        }
    }

    _defaultTitleAlign() {
        switch (this._titlePlacement) {
            case 'top': case 'bottom': return 'center';
            case 'left': return 'right';
            case 'right': return 'left';
            default: return 'center';
        }
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

    addTo(map) {
        if (this._map) this.remove();
        const personalLayer = new Layer();
        personalLayer.addTo(map);
        personalLayer.add(this);
        return this;
    }

    remove() {
        if (this._mixer) {
            this._mixer.stopAllAction();
            this._mixer = null;
            this._mixerClock = null;
        }
        if (this._group) {
            this._group.parent?.remove(this._group);
            if (this._object3D) {
                this._object3D.traverse(child => {
                    if (child.isMesh) {
                        child.geometry?.dispose();
                        if (Array.isArray(child.material)) child.material.forEach(m => m.dispose());
                        else child.material?.dispose();
                    }
                });
                this._object3D = null;
            }
        }
        Area3D._activeAreas.delete(this);
        if (Area3D._hoveredArea === this) Area3D._hoveredArea = null;
        if (Area3D._pressedArea === this) Area3D._pressedArea = null;
        if (this._textLabel && this._map?.textManager) {
            this._map.textManager.removeLabel(this._textLabel);
            this._textLabel = null;
        }
        if (this._layer) {
            this._layer._removeRef(this);
            this._layer = null;
        }
        this._map = null;
    }

    _attach(map, layer) {
        if (this._map === map && this._layer === layer) return;
        this.remove();
        this._map = map;
        this._layer = layer;

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

        this._registerGlobalEvents(map);
        this._lastWorldGroupPos.copy(map.worldGroup.position);
    }

    _calculatePolygonParams() {
        const outerRing = this._rings[0];
        this._worldCoords.length = 0;

        let sumX = 0, sumZ = 0;
        let uniquePoints = [];
        for (let i = 0; i < outerRing.length; i++) {
            const [lon, lat] = outerRing[i];
            const [absX, absZ] = proj.fromLonLat([lon, lat]);
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

    _createPrimitive() {
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

        let geometry;
        switch (this._primitiveType.toLowerCase()) {
            case 'sphere': geometry = new THREE.SphereGeometry(w / 2, 32, 32); break;
            case 'cylinder': geometry = new THREE.CylinderGeometry(w / 2, w / 2, h, 32); break;
            case 'cone': geometry = new THREE.ConeGeometry(w / 2, h, 32); break;
            case 'box': default: geometry = new THREE.BoxGeometry(w, h, d); break;
        }
        const material = new THREE.MeshStandardMaterial({
            color: this._color,
            roughness: 0.5,
            depthTest: this._depthTest,
            depthWrite: this._depthWrite
        });
        const mesh = new THREE.Mesh(geometry, material);
        mesh.renderOrder = AREA3D_RENDER_ORDER;
        this._object3D = mesh;
        this._modelContainer.add(mesh);
        this._applyModelTransform();
    }

    async _loadModel() {
        if (this._modelPromise) return this._modelPromise;
        this._modelPromise = (async () => {
            try {
                const loader = new GLTFLoader();
                const gltf = await loader.loadAsync(this._modelUrl);
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

                model.traverse(child => {
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
            } catch (err) {
                console.warn('Area3D: GLB loading failed:', err);
                this._isModelLoading = false;
            }
        })();
        return this._modelPromise;
    }

_applyModelTransform() {
    if (!this._object3D) return;

    const model = this._object3D;
    const parent = model.parent;

    // Сброс трансформаций
    model.position.set(0, 0, 0);
    model.scale.set(1, 1, 1);
    model.rotation.set(0, 0, 0);
    model.updateMatrixWorld(true);

    // Временно убираем из родителя, чтобы получить ЛОКАЛЬНЫЙ bounding box
    if (parent) parent.remove(model);
    model.updateMatrixWorld(true);
    const box = new THREE.Box3().setFromObject(model);
    const size = box.getSize(new THREE.Vector3());
    if (parent) parent.add(model);

    let targetW, targetH, targetD;
    if (this._fit === 'stretch') {
        targetW = this._polygonWidth;
        targetD = this._polygonDepth;
        if (this._size) {
            const [, hFromSize] = this._normalizeSize(this._size);
            targetH = hFromSize;
        } else {
            // Равномерный масштаб contain, затем растягиваем только по X/Z
            const containScale = Math.min(this._polygonWidth / size.x, this._polygonDepth / size.z);
            targetH = size.y * containScale;
        }
    } else if (this._fit === 'contain') {
        const scale = Math.min(this._polygonWidth / size.x, this._polygonDepth / size.z);
        targetW = size.x * scale;
        targetH = size.y * scale;
        targetD = size.z * scale;
    } else {
        if (this._size) {
            [targetW, targetH, targetD] = this._normalizeSize(this._size);
        } else {
            targetW = size.x;
            targetH = size.y;
            targetD = size.z;
        }
    }

    const scaleX = targetW / size.x;
    const scaleY = targetH / size.y;
    const scaleZ = targetD / size.z;
    model.scale.set(scaleX, scaleY, scaleZ);

    const totalAngle = this._polygonAngle + this._rotate * Math.PI / 2;
    model.rotation.y = totalAngle;

    model.updateMatrixWorld(true);

    // Снова временно убираем, чтобы получить локальный transformed box
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
}

    _normalizeSize(size) {
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

    _registerGlobalEvents(map) {
        if (Area3D._mapEventHandlers.has(map)) return;
        const domElement = map.renderer.domElement;
        const handlers = {
            pointermove: (e) => this._onPointerMove(e, map),
            pointerdown: (e) => this._onPointerDown(e, map),
            pointerup: (e) => this._onPointerUp(e, map),
            pointerleave: (e) => this._onPointerLeave(e, map)
        };
        domElement.addEventListener('pointermove', handlers.pointermove);
        domElement.addEventListener('pointerdown', handlers.pointerdown);
        domElement.addEventListener('pointerup', handlers.pointerup);
        domElement.addEventListener('pointerleave', handlers.pointerleave);
        Area3D._mapEventHandlers.set(map, handlers);
    }

    _getNDC(e, map) {
        const rect = map.renderer.domElement.getBoundingClientRect();
        return new THREE.Vector2(
            ((e.clientX - rect.left) / rect.width) * 2 - 1,
            -((e.clientY - rect.top) / rect.height) * 2 + 1
        );
    }

    _getAreaUnderPointer(mouse, map) {
        const raycaster = Area3D._raycaster;
        raycaster.setFromCamera(mouse, map.camera);
        const candidates = [];
        for (const area of Area3D._activeAreas) {
            if (area._map !== map || !area._group.visible || !area._object3D) continue;
            const hits = raycaster.intersectObject(area._object3D, true);
            if (hits.length) candidates.push({ area, hit: hits[0] });
        }
        if (!candidates.length) return null;
        candidates.sort((a, b) => a.hit.distance - b.hit.distance);
        return candidates[0].area;
    }

    _onPointerMove(e, map) {
        if (Area3D._isMobile) return;
        const mouse = this._getNDC(e, map);
        const area = this._getAreaUnderPointer(mouse, map);
        if (area !== Area3D._hoveredArea) {
            if (Area3D._hoveredArea) {
                Area3D._hoveredArea._onHover?.(false) || (map.popupManager?.hide());
            }
            if (area) {
                area._onHover?.(true) || (area._tooltipText && map.popupManager?.show(area, area._tooltipText));
            }
            Area3D._hoveredArea = area;
        }
    }

    _onPointerDown(e, map) {
        const mouse = this._getNDC(e, map);
        const area = this._getAreaUnderPointer(mouse, map);
        Area3D._pressedArea = area;
        Area3D._pressStart = { x: e.clientX, y: e.clientY };
    }

    _onPointerUp(e, map) {
        const pressed = Area3D._pressedArea;
        const start = Area3D._pressStart;
        Area3D._pressedArea = null;
        Area3D._pressStart = null;
        if (!start) return;
        const dx = e.clientX - start.x;
        const dy = e.clientY - start.y;
        if (Math.sqrt(dx*dx + dy*dy) > 5) return;

        if (Area3D._isMobile) {
            if (pressed && !pressed._onClick) {
                if (pressed._onHover) pressed._onHover(true);
                else if (pressed._tooltipText && map.popupManager) map.popupManager.show(pressed, pressed._tooltipText);
                Area3D._hoveredArea = pressed;
            }
            return;
        }
        if (pressed && pressed._onClick) {
            pressed._onClick(e, pressed);
        }
    }

    _onPointerLeave(e, map) {
        if (Area3D._isMobile) return;
        if (Area3D._hoveredArea) {
            Area3D._hoveredArea._onHover?.(false) || map.popupManager?.hide();
            Area3D._hoveredArea = null;
        }
    }

    _update(map) {
        if (!this._map || !this._group) return;
        const zoom = map.continuousZoom;

        if (this._layer && !this._layer.visible) {
            this._group.visible = false;
            return;
        }
        if (zoom < this._minZoom || zoom > this._maxZoom) {
            this._group.visible = false;
            return;
        }

        if (map.maxObjectDistance !== Infinity && this._object3D) {
            const worldPos = this._group.position.clone().add(map.worldGroup.position);
            const dist = map.camera.position.distanceTo(worldPos);
            if (dist > map.maxObjectDistance) {
                this._group.visible = false;
                return;
            }
        }

        this._group.visible = true;

        // Обновление высоты основания
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
        } else {
            this._group.position.y = this._altitude;
        }

        if (this._mixer && this._mixerClock) {
            const delta = this._mixerClock.getDelta();
            this._mixer.update(delta);
        }

        // Пересчитываем экранную позицию для подписи каждый кадр
        if (this._textLabel) {
            this._updateScreenPosition();
        }
    }

    _updateScreenPosition() {
        if (!this._map || !this._object3D) {
            this._centroidScreenPos = null;
            return;
        }
        // Box3.setFromObject уже учитывает мировую матрицу объекта,
        // дополнительно применять matrixWorld не нужно.
        const box = new THREE.Box3().setFromObject(this._object3D);
        const canvas = this._map.renderer.domElement;
        const corners = [];
        const { min, max } = box;
        for (let i = 0; i < 8; i++) {
            const corner = new THREE.Vector3(
                (i & 1) ? max.x : min.x,
                (i & 2) ? max.y : min.y,
                (i & 4) ? max.z : min.z
            );
            corner.project(this._map.camera);
            if (corner.z < -1 || corner.z > 1) continue;
            corners.push({
                x: (corner.x * 0.5 + 0.5) * canvas.clientWidth,
                y: (-corner.y * 0.5 + 0.5) * canvas.clientHeight
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
        let x, y;
        switch (this._titlePlacement) {
            case 'bottom': x = centerX; y = maxY; break;
            case 'left':   x = minX;   y = centerY; break;
            case 'right':  x = maxX;   y = centerY; break;
            case 'top': default: x = centerX; y = minY; break;
        }
        this._centroidScreenPos = { x, y };
    }

    // Интерфейс для TextManager
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
    getLabelType() { return 'area3d'; }
    isVisible() { return this._group?.visible ?? false; }
    getScreenPosition() { return this._centroidScreenPos; }
    getTitleAlign() { return this._titleAlign; }
    getTitleOffset() { return this._titleOffset; }
    getTitleVerticalAlign() {
        switch (this._titlePlacement) {
            case 'bottom': return 'top';
            case 'left': case 'right': return 'center';
            case 'top': default: return 'bottom';
        }
    }
    getAllowOverflow() { return false; }
    getPriority() { return 0; }
    getClusterable() { return false; }
}