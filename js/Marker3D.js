/**
 * Модуль 3D-маркера для картографической библиотеки на three.js.
 * Поддерживает примитивы (куб, сфера, цилиндр, конус) и GLB-модели.
 *
 * @module Marker3D
 */

import { THREE, GLTFLoader } from '../js_TP/tpb.js';
import { proj } from './Utils.js';
import { Layer } from './Layers.js';

/**
 * Рендерит 3д-маркеры выше любого уровня зума тайлов
 *
 * @private
 */
const MARKER_RENDER_ORDER = 1000;

export class Marker3D {
    /** @private */ static _idCounter = 0;
    /** @private */ static _activeMarkers = new Set();
    /** @private */ static _hoveredMarker = null;
    /** @private */ static _pressedMarker = null;
    /** @private */ static _pressStart = null;
    /** @private */ static _raycaster = new THREE.Raycaster();
    /** @private */ static _mapEventHandlers = new WeakMap();
    /** @private */ static _isMobile = (typeof window !== 'undefined') && (('ontouchstart' in window) || (navigator.maxTouchPoints > 0));

    /**
     * Создаёт 3D-маркер.
     *
     * @param {Object} options - Настройки 3D-маркера.
     * @param {[number, number]} options.position - Географические координаты [lon, lat].
     * @param {string} [options.primitiveType='box'] - Тип примитива: 'box', 'sphere', 'cylinder', 'cone'.
     * @param {number|Array<number>} [options.size] - Размеры объекта. Для примитивов: массив [width, height, depth] в метрах; число или массивы из 1-3 элементов преобразуются к тройке. Для GLB-моделей: число - равномерное масштабирование до максимального габарита; [height] - масштабирование по высоте с сохранением пропорций; [width, height] - ширина и высота, глубина пропорционально среднему; [width, height, depth] - точные размеры по осям.
     * @param {string} [options.modelUrl] - URL GLB-модели. Если указан, примитив игнорируется.
     * @param {number} [options.altitude=0] - Высота над поверхностью (если altitudeMode='clampToGround') или абсолютная высота (если altitudeMode='absolute').
     * @param {string} [options.altitudeMode='clampToGround'] - Режим высоты: 'clampToGround' (прижат к рельефу), 'absolute' (абсолютная высота в мировых координатах Y).
     * @param {[number, number, number]} [options.rotation=[0,0,0]] - Углы поворота в радианах [x, y, z].
     * @param {[number, number, number]} [options.anchor=[0.5,0,0.5]] - Точка привязки объекта: нормализованные координаты внутри bounding box ([0..1] по каждой оси, где 0 – низ/лево/зад, 1 – верх/право/перед).
     * @param {number} [options.minZoom=-Infinity] - Минимальный зум видимости.
     * @param {number} [options.maxZoom=Infinity] - Максимальный зум видимости.
     * @param {string} [options.title=''] - Текст постоянной подписи (отображается через TextManager).
     * @param {Object} [options.titleStyle] - Стили подписи (как у Marker).
     * @param {number} [options.titleMinZoom=-Infinity] - Мин. зум для подписи.
     * @param {number} [options.titleMaxZoom=Infinity] - Макс. зум для подписи.
     * @param {string} [options.titlePlacement='top'] - Положение подписи относительно объекта: 'top', 'bottom', 'left', 'right'.
     * @param {string} [options.titleAlign] - Горизонтальное выравнивание подписи. По умолчанию зависит от titlePlacement.
     * @param {[number, number]} [options.titleOffset] - Смещение подписи в пикселях. По умолчанию зависит от titlePlacement.
     * @param {string} [options.tooltip=''] - Текст всплывающей подсказки (HTML), показывается через PopupManager.
     * @param {string|number} [options.color=0x3388ff] - Цвет примитива.
     * @param {Function} [options.onClick] - Обработчик клика по объекту (получает событие и маркер).
     * @param {Function} [options.onHover] - Обработчик наведения (получает true/false).
     * @param {boolean} [options.clusterable=false] - 3D-маркеры по умолчанию не участвуют в кластеризации.
     * @throws {Error} Если options.position отсутствует или имеет неверный формат.
     */
    constructor(options = {}) {
        if (!options.position || options.position.length !== 2) {
            throw new Error('Marker3D: options.position is required [lon, lat]');
        }

        /** @private */ this._lon = options.position[0];
        /** @private */ this._lat = options.position[1];
        /** @private */ this._primitiveType = options.primitiveType || 'box';
        /** @private */ this._size = options.size || null;
        /** @private */ this._modelUrl = options.modelUrl || null;
        /** @private */ this._altitude = options.altitude || 0;
        /** @private */ this._altitudeMode = options.altitudeMode || 'clampToGround';
        /** @private */ this._rotation = options.rotation || [0, 0, 0];
        /** @private */ this._anchor = options.anchor || [0.5, 0, 0.5];
        /** @private */ this._minZoom = options.minZoom ?? -Infinity;
        /** @private */ this._maxZoom = options.maxZoom ?? Infinity;

        // Подпись
        /** @private */ this._title = options.title || '';
        /** @private */ this._titleStyle = options.titleStyle || {};
        /** @private */ this._titleMinZoom = options.titleMinZoom ?? -Infinity;
        /** @private */ this._titleMaxZoom = options.titleMaxZoom ?? Infinity;
        /** @private */ this._titlePlacement = options.titlePlacement || 'top';

        if (options.titleAlign !== undefined) {
            this._titleAlign = options.titleAlign;
        } else {
            switch (this._titlePlacement) {
                case 'top': this._titleAlign = 'center'; break;
                case 'bottom': this._titleAlign = 'center'; break;
                case 'left': this._titleAlign = 'right'; break;
                case 'right': this._titleAlign = 'left'; break;
                default: this._titleAlign = 'center';
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

        /** @private */ this._height = 0;
        /** @private */ this._tooltipText = options.tooltip || '';
        /** @private */ this._onClick = options.onClick || null;
        /** @private */ this._onHover = options.onHover || null;
        /** @private */ this._clusterable = options.clusterable !== undefined ? options.clusterable : false;
        /** @private */ this._color = options.color || 0x3388ff;

        /** @private */ this._map = null;
        /** @private */ this._layer = null;
        /** @private */ this._object3D = null;
        /** @private */ this._geometry = null;
        /** @private */ this._material = null;
        /** @private */ this._textLabel = null;
        /** @private */ this._isVisible = false;
        /** @private */ this._lastHeightUpdateTime = 0;
        /** @private */ this._cachedWorldY = 0;
        /** @private */ this._isModelLoading = false;
        /** @private */ this._modelPromise = null;
        /** @private */ this._worldPosition = new THREE.Vector3();
        /** @private */ this._localBox = null;
        /** @private */ this._originalModelSize = null;
        /** @private */ this._originalModelScale = null;
        /** @private */ this._originalModelPosition = null;
        /** @private */ this._isModel = !!this._modelUrl;
        /** @private */ this._modelAnchorOffset = new THREE.Vector3();
        /** @private */ this._sizeAnimation = null;
    }

    addTo(map) {
        if (this._map) this.remove();
        const personalLayer = new Layer();
        personalLayer.addTo(map);
        personalLayer.add(this);
        return this;
    }

    _attach(map, layer) {
        if (this._map === map && this._layer === layer) return;
        this.remove();
        this._map = map;
        this._layer = layer;

        if (this._modelUrl) {
            this._object3D = new THREE.Group();
            this._isModelLoading = true;
            this._loadModel();
        } else {
            this._createPrimitive();
        }
        this._object3D.rotation.set(...this._rotation);
        map.worldGroup.add(this._object3D);

        Marker3D._activeMarkers.add(this);
        this._registerGlobalEvents(map);

        if (this._title && this._map.textManager) {
            this._textLabel = this._map.textManager.addLabel(this);
        }
        // Тултип больше не создаётся — он управляется PopupManager
    }

    _createPrimitive() {
        let [w, h, d] = this._normalizePrimitiveSize(this._size);
        this._height = h;
        let geometry;
        switch (this._primitiveType.toLowerCase()) {
            case 'sphere': geometry = new THREE.SphereGeometry(w / 2, 32, 32); break;
            case 'cylinder': geometry = new THREE.CylinderGeometry(w / 2, w / 2, h, 32); break;
            case 'cone': geometry = new THREE.ConeGeometry(w / 2, h, 32); break;
            case 'box': default: geometry = new THREE.BoxGeometry(w, h, d); break;
        }
        const material = new THREE.MeshStandardMaterial({ color: this._color, roughness: 0.5 });
        const mesh = new THREE.Mesh(geometry, material);
        const offset = new THREE.Vector3(
            (0.5 - this._anchor[0]) * w,
            (0.5 - this._anchor[1]) * h,
            (0.5 - this._anchor[2]) * d
        );
        geometry.translate(offset.x, offset.y, offset.z);
        geometry.computeBoundingBox();
        this._localBox = geometry.boundingBox.clone();
        mesh.renderOrder = MARKER_RENDER_ORDER;
        this._geometry = geometry;
        this._material = material;
        this._object3D = mesh;
    }

    _normalizePrimitiveSize(size) {
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

    async _loadModel() {
        if (this._modelPromise) return this._modelPromise;
        this._modelPromise = (async () => {
            try {
                const loader = new GLTFLoader();
                const gltf = await loader.loadAsync(this._modelUrl);
                const model = gltf.scene;
                const originalBox = new THREE.Box3().setFromObject(model);
                this._originalModelSize = originalBox.getSize(new THREE.Vector3());
                this._originalModelScale = model.scale.clone();
                this._originalModelPosition = model.position.clone();
                this._applyModelSizeAndAnchor(model);
                model.traverse((child) => {
                    if (child.isMesh) {
                        child.renderOrder = MARKER_RENDER_ORDER;
                        child.castShadow = true;
                        child.receiveShadow = true;
                    }
                });
                if (this._object3D) {
                    const parent = this._object3D.parent;
                    if (parent) {
                        parent.remove(this._object3D);
                        this._object3D = model;
                        model.rotation.set(...this._rotation);
                        parent.add(model);
                    }
                }
                this._isModelLoading = false;
            } catch (err) {
                console.warn('Marker3D: GLB model loading failed:', err);
                this._isModelLoading = false;
            }
        })();
        return this._modelPromise;
    }

    _applyModelSizeAndAnchor(model) {
        model.scale.copy(this._originalModelScale);
        model.position.copy(this._originalModelPosition);
        if (this._size) {
            const scaleFactors = this._calculateModelScale(this._size, this._originalModelSize);
            model.scale.copy(scaleFactors);
        }
        const box = new THREE.Box3().setFromObject(model);
        if (model.parent) {
            model.parent.updateWorldMatrix(true, false);
            const parentInv = new THREE.Matrix4().copy(model.parent.matrixWorld).invert();
            box.applyMatrix4(parentInv);
        }
        const size = box.getSize(new THREE.Vector3());
        this._height = size.y;
        if (this._anchor) {
            const anchorPoint = new THREE.Vector3(
                box.min.x + this._anchor[0] * size.x,
                box.min.y + this._anchor[1] * size.y,
                box.min.z + this._anchor[2] * size.z
            );
            this._modelAnchorOffset.copy(anchorPoint);
        } else {
            this._modelAnchorOffset.set(0, 0, 0);
        }
    }

    _calculateModelScale(size, originalSize) {
        if (typeof size === 'number') {
            const targetMaxDim = size;
            const currentMaxDim = Math.max(originalSize.x, originalSize.y, originalSize.z);
            const factor = targetMaxDim / currentMaxDim;
            return new THREE.Vector3(factor, factor, factor);
        }
        if (Array.isArray(size)) {
            switch (size.length) {
                case 1: {
                    const targetHeight = size[0];
                    const factor = targetHeight / originalSize.y;
                    return new THREE.Vector3(factor, factor, factor);
                }
                case 2: {
                    const targetWidth = size[0];
                    const targetHeight = size[1];
                    const scaleX = targetWidth / originalSize.x;
                    const scaleY = targetHeight / originalSize.y;
                    const scaleZ = (scaleX + scaleY) / 2;
                    return new THREE.Vector3(scaleX, scaleY, scaleZ);
                }
                case 3: {
                    return new THREE.Vector3(
                        size[0] / originalSize.x,
                        size[1] / originalSize.y,
                        size[2] / originalSize.z
                    );
                }
                default:
                    throw new Error('Marker3D: size array must have 1, 2, or 3 elements');
            }
        }
        throw new Error('Marker3D: invalid size type');
    }

    setSize(size) {
        this._size = size;
        if (!this._object3D) return this;
        if (this._modelUrl) {
            if (this._isModelLoading) return this;
            this._applyModelSizeAndAnchor(this._object3D);
            this._object3D.rotation.set(...this._rotation);
        } else {
            if (this._object3D.parent) {
                const oldObject = this._object3D;
                const oldPosition = oldObject.position.clone();
                const oldRotation = oldObject.rotation.clone();
                oldObject.parent.remove(oldObject);
                this._createPrimitive();
                this._object3D.position.copy(oldPosition);
                this._object3D.rotation.copy(oldRotation);
                this._map.worldGroup.add(this._object3D);
            }
        }
        return this;
    }

    animateSize(newSize, duration = 1000, easing = 'linear') {
        let startSize = this._size;
        if (startSize === null) {
            if (this._isModel && this._originalModelSize) {
                startSize = Math.max(
                    this._originalModelSize.x,
                    this._originalModelSize.y,
                    this._originalModelSize.z
                );
            } else {
                startSize = [100, 100, 100];
            }
        }
        this._sizeAnimation = {
            startSize,
            endSize: newSize,
            startTime: performance.now(),
            duration,
            easing
        };
        return this;
    }

    getSize() { return this._size; }

    _registerGlobalEvents(map) {
        if (Marker3D._mapEventHandlers.has(map)) return;
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
        Marker3D._mapEventHandlers.set(map, handlers);
    }

    _getNDC(e, map) {
        const rect = map.renderer.domElement.getBoundingClientRect();
        const x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
        const y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
        return new THREE.Vector2(x, y);
    }

    _getMarkerUnderPointer(mouse, map) {
        const raycaster = Marker3D._raycaster;
        raycaster.setFromCamera(mouse, map.camera);
        const candidates = [];
        for (const marker of Marker3D._activeMarkers) {
            if (marker._map !== map || !marker._isVisible || !marker._object3D) continue;
            const hits = raycaster.intersectObject(marker._object3D, true);
            if (hits.length > 0) candidates.push({ marker, hit: hits[0] });
        }
        if (candidates.length === 0) return null;
        candidates.sort((a, b) => a.hit.distance - b.hit.distance);
        return candidates[0].marker;
    }

    _onPointerMove(e, map) {
        if (Marker3D._isMobile) return;
        const mouse = this._getNDC(e, map);
        const marker = this._getMarkerUnderPointer(mouse, map);
        if (marker !== Marker3D._hoveredMarker) {
            if (Marker3D._hoveredMarker) {
                if (Marker3D._hoveredMarker._onHover) {
                    Marker3D._hoveredMarker._onHover(false);
                } else {
                    // Скрываем popup, если он был показан автоматически
                    if (map.popupManager) map.popupManager.hide();
                }
            }
            if (marker) {
                if (marker._onHover) {
                    marker._onHover(true);
                } else if (marker._tooltipText && map.popupManager) {
                    map.popupManager.show(marker, marker._tooltipText);
                }
            }
            Marker3D._hoveredMarker = marker;
        }
    }

    _onPointerDown(e, map) {
        const mouse = this._getNDC(e, map);
        const marker = this._getMarkerUnderPointer(mouse, map);
        Marker3D._pressedMarker = marker;
        Marker3D._pressStart = { x: e.clientX, y: e.clientY };
    }

    _onPointerUp(e, map) {
        const pressed = Marker3D._pressedMarker;
        const start = Marker3D._pressStart;
        Marker3D._pressedMarker = null;
        Marker3D._pressStart = null;
        if (!start) return;
        const dx = e.clientX - start.x;
        const dy = e.clientY - start.y;
        const dist = Math.sqrt(dx * dx + dy * dy);
        if (dist > 5) return;

        if (Marker3D._isMobile) {
            if (!pressed) {
                if (Marker3D._hoveredMarker) {
                    if (Marker3D._hoveredMarker._onHover) Marker3D._hoveredMarker._onHover(false);
                    else if (map.popupManager) map.popupManager.hide();
                    Marker3D._hoveredMarker = null;
                }
                return;
            }
            if (!pressed._onClick && (pressed._onHover || pressed._tooltipText)) {
                if (Marker3D._hoveredMarker && Marker3D._hoveredMarker !== pressed) {
                    if (Marker3D._hoveredMarker._onHover) Marker3D._hoveredMarker._onHover(false);
                    else if (map.popupManager) map.popupManager.hide();
                }
                if (Marker3D._hoveredMarker !== pressed) {
                    if (pressed._onHover) {
                        pressed._onHover(true);
                    } else if (pressed._tooltipText && map.popupManager) {
                        map.popupManager.show(pressed, pressed._tooltipText);
                    }
                    Marker3D._hoveredMarker = pressed;
                }
                return;
            }
        }

        if (pressed && pressed._onClick) {
            pressed._onClick(e, pressed);
        }
    }

    _onPointerLeave(e, map) {
        if (Marker3D._isMobile) return;
        if (Marker3D._hoveredMarker) {
            if (Marker3D._hoveredMarker._onHover) {
                Marker3D._hoveredMarker._onHover(false);
            } else if (map.popupManager) {
                map.popupManager.hide();
            }
            Marker3D._hoveredMarker = null;
        }
    }

    remove() {
        if (this._object3D) {
            if (this._object3D.parent) this._object3D.parent.remove(this._object3D);
            if (this._geometry) this._geometry.dispose();
            if (this._material) this._material.dispose();
            this._object3D = null;
            this._geometry = null;
            this._material = null;
        }
        if (Marker3D._activeMarkers.has(this)) Marker3D._activeMarkers.delete(this);
        if (Marker3D._hoveredMarker === this) {
            if (this._onHover) this._onHover(false);
            Marker3D._hoveredMarker = null;
        }
        if (Marker3D._pressedMarker === this) {
            Marker3D._pressedMarker = null;
            Marker3D._pressStart = null;
        }
        if (this._textLabel && this._map?.textManager) {
            this._map.textManager.removeLabel(this._textLabel);
            this._textLabel = null;
        }
        if (this._layer) {
            this._layer._removeRef(this);
            this._layer = null;
        }
        this._map = null;
        this._isVisible = false;
        this._worldPosition.set(0, 0, 0);
        this._localBox = null;
    }

    _updateSizeAnimation(now) {
        if (!this._sizeAnimation) return;
        const anim = this._sizeAnimation;
        const elapsed = now - anim.startTime;
        const t = Math.min(elapsed / anim.duration, 1);
        let progress;
        switch (anim.easing) {
            case 'easeIn': progress = t * t; break;
            case 'easeOut': progress = 1 - Math.pow(1 - t, 2); break;
            case 'easeInOut': progress = t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2; break;
            case 'linear': default: progress = t; break;
        }
        const currentSize = this._lerpSize(anim.startSize, anim.endSize, progress);
        this.setSize(currentSize);
        if (t >= 1) {
            this._sizeAnimation = null;
            this.setSize(anim.endSize);
        }
    }

    _lerpSize(start, end, t) {
        if (typeof start === 'number' && typeof end === 'number') return start + (end - start) * t;
        if (Array.isArray(start) && Array.isArray(end)) {
            const len = Math.min(start.length, end.length);
            const result = [];
            for (let i = 0; i < len; i++) result.push(start[i] + (end[i] - start[i]) * t);
            return result;
        }
        return end;
    }

    _update(map) {
        if (!this._map || !this._object3D) return;
        const mapInstance = this._map;
        const zoom = mapInstance.continuousZoom;
        if (this._layer && !this._layer.visible) {
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
        const [absWorldX, absWorldZ] = proj.fromLonLat([this._lon, this._lat]);
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
        if (this._isModel && this._modelAnchorOffset) {
            this._object3D.position.set(
                absWorldX + this._modelAnchorOffset.x,
                worldY + this._modelAnchorOffset.y,
                absWorldZ + this._modelAnchorOffset.z
            );
        } else {
            this._object3D.position.set(absWorldX, worldY, absWorldZ);
        }
        this._worldPosition.set(worldX, worldY, worldZ);
        if (mapInstance.view.objectDistanceFactor > 0) {
            const dist = mapInstance.camera.position.distanceTo(this._worldPosition);
            if (dist > mapInstance.maxObjectDistance) {
                this._object3D.visible = false;
                this._isVisible = false;
                return;
            }
        }
        // Проверка видимости bounding box
        if (this._isModel) {
            const worldBox = new THREE.Box3().setFromObject(this._object3D);
            const projScreenMatrix = new THREE.Matrix4().multiplyMatrices(
                mapInstance.camera.projectionMatrix,
                mapInstance.camera.matrixWorldInverse
            );
            const frustum = new THREE.Frustum().setFromProjectionMatrix(projScreenMatrix);
            if (!frustum.intersectsBox(worldBox)) {
                this._object3D.visible = false;
                this._isVisible = false;
                return;
            }
        } else if (this._localBox) {
            this._object3D.updateWorldMatrix(true, false);
            const worldBox = this._localBox.clone().applyMatrix4(this._object3D.matrixWorld);
            const projScreenMatrix = new THREE.Matrix4().multiplyMatrices(
                mapInstance.camera.projectionMatrix,
                mapInstance.camera.matrixWorldInverse
            );
            const frustum = new THREE.Frustum().setFromProjectionMatrix(projScreenMatrix);
            if (!frustum.intersectsBox(worldBox)) {
                this._object3D.visible = false;
                this._isVisible = false;
                return;
            }
        }
        this._object3D.visible = true;
        this._isVisible = true;
    }

    // ---------- Интерфейс для TextManager ----------
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
    getLabelType() { return 'point'; }
    isVisible() { return this._isVisible; }

    getScreenPosition() {
        if (!this._isVisible || !this._object3D) return null;
        const canvas = this._map.renderer.domElement;
        let box;
        if (this._isModel) {
            box = new THREE.Box3().setFromObject(this._object3D);
        } else if (this._localBox) {
            this._object3D.updateWorldMatrix(true, false);
            box = this._localBox.clone().applyMatrix4(this._object3D.matrixWorld);
        } else {
            const localTop = new THREE.Vector3(0, this._height * (1 - this._anchor[1]), 0);
            this._object3D.updateWorldMatrix(false, false);
            const worldTop = localTop.clone().applyMatrix4(this._object3D.matrixWorld);
            const screenPos = worldTop.clone().project(this._map.camera);
            if (screenPos.z > 1 || Math.abs(screenPos.x) > 1 || Math.abs(screenPos.y) > 1) return null;
            return {
                x: (screenPos.x * 0.5 + 0.5) * canvas.clientWidth,
                y: (-screenPos.y * 0.5 + 0.5) * canvas.clientHeight
            };
        }
        const corners = [];
        const { min, max } = box;
        for (let i = 0; i < 8; i++) {
            const corner = new THREE.Vector3(
                (i & 1) ? max.x : min.x,
                (i & 2) ? max.y : min.y,
                (i & 4) ? max.z : min.z
            );
            corner.project(this._map.camera);
            if (corner.z > 1 || corner.z < -1) continue;
            corners.push({
                x: (corner.x * 0.5 + 0.5) * canvas.clientWidth,
                y: (-corner.y * 0.5 + 0.5) * canvas.clientHeight
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
        let x, y;
        switch (this._titlePlacement) {
            case 'bottom': x = centerX; y = maxY; break;
            case 'left':   x = minX;   y = centerY; break;
            case 'right':  x = maxX;   y = centerY; break;
            case 'top': default: x = centerX; y = minY; break;
        }
        return { x, y };
    }

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
    getClusterable() { return this._clusterable; }

    setColor(color) {
        this._color = color;
        if (this._object3D && this._object3D.material) {
            this._object3D.material.color.set(color);
        } else if (this._object3D) {
            this._object3D.traverse(child => {
                if (child.isMesh && child.material) {
                    child.material.color.set(color);
                }
            });
        }
    }
}