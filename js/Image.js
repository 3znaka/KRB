/**
 * Image — плоское изображение на карте (nodes / position + size + anchor).
 * После `addTo()` мутабелен.
 *
 * Наследует SpatialObject: zoom bounds, видимость, tooltip, onClick/onHover,
 * подпись, altitude (= elevationOffset), zoom bounds и TextManager-контракт
 * берутся из базового класса.
 *
 * Специфика Image: собственный статический реестр интерактивных
 * (`Image._interactiveImages` + глобальные DOM-слушатели на canvas) вместо
 * `map.interaction`, две модели геометрии (nodes / position+size+anchor+
 * rotation), текстура, blending и "alwaysOnTop" как единственный control
 * над depthTest/polygonOffset.
 *
 * @module Image
 */
import { THREE } from './js_TP/tpb.js';
import { Projections } from './Projections.js';
import { SpatialObject } from './SpatialObject.js';
const IMAGE_RENDER_ORDER = 997;
const DEFAULT_POLYGON_OFFSET = -4;
// =====================================================================
// Image
// =====================================================================
export class Image extends SpatialObject {
    // ── Данные ──
    _source;
    _nodes;
    _position;
    _crsCode;
    _crs;
    // ── Оформление ── (altitude — в базе)
    _size;
    _anchor;
    _rotation;
    _opacity;
    _blending;
    _alwaysOnTop;
    _polygonOffset;
    // ── Интерактив ──
    _isHovered = false;
    // ── Внутреннее состояние ──
    _group;
    _mesh = null;
    _geometry = null;
    _material = null;
    _texture = null;
    _worldPositions = [];
    _centroidWorld;
    _boundingSphereRadius = 0;
    _tempVec3;
    _dirtyGeometry = true;
    // ── Статический реестр интерактивных ──
    static _interactiveImages = new Set();
    static _eventListenersAttached = false;
    static _delegatedHandlers = null;
    static _pointerDownX = 0;
    static _pointerDownY = 0;
    static _pointerDownActive = false;
    static _clickMoveThreshold = 5;
    constructor(options) {
        super();
        if (options.zoomInterpolate)
            this.setZoomInterpolations(options.zoomInterpolate);
        this._properties = options.properties ?? {};
        this._userData = options.userData ?? {};
        if (!options.source) {
            throw new Error('Image: options.source is required');
        }
        this._source = options.source;
        this._nodes = options.nodes ?? null;
        this._position = options.position ?? null;
        this._crsCode = options.crs ?? null;
        this._crs = null;
        this._size = options.size ?? [100, 100];
        this._anchor = options.anchor ?? [0.5, 0.5];
        this._rotation = options.rotation ?? [0, 0, 0];
        this._opacity = options.opacity ?? 1;
        this._blending = options.blending ?? 'normal';
        this._minZoom = options.minZoom ?? -Infinity;
        this._maxZoom = options.maxZoom ?? Infinity;
        this._alwaysOnTop = options.alwaysOnTop === true;
        this._altitude = options.altitude ?? options.elevationOffset ?? 0;
        this._polygonOffset = Number.isFinite(options.polygonOffset)
            ? options.polygonOffset
            : DEFAULT_POLYGON_OFFSET;
        this._title = options.title ?? '';
        this._titleStyle = options.titleStyle ?? {};
        this._titleMinZoom = options.titleMinZoom ?? -Infinity;
        this._titleMaxZoom = options.titleMaxZoom ?? Infinity;
        this._titleAlign = options.titleAlign ?? 'center';
        this._titleAllowOverflow = options.titleAllowOverflow ?? false;
        this._titlePriority = options.titlePriority ?? 0;
        this._userTitleOffset = options.titleOffset
            ? [options.titleOffset[0], options.titleOffset[1]]
            : null;
        this._resolveTitleOffset();
        this._tooltipText = options.tooltip ?? '';
        this._onClick = options.onClick ?? null;
        this._onHover = options.onHover ?? null;
        this._group = new THREE.Group();
        this._centroidWorld = new THREE.Vector3();
        this._tempVec3 = new THREE.Vector3();
    }
    // =================================================================
    // Хуки SpatialObject
    // =================================================================
    _onAttached(map) {
        this._crs = this._crsCode
            ? Projections.get(this._crsCode)
            : map.inputCRS;
        this._loadTexture();
        this._buildGeometry(map);
        map.worldGroup.add(this._group);
        // Регистрируем только если есть интерактив.
        if (this._onClick || this._onHover || this._tooltipText) {
            Image._registerInteractive(this);
        }
    }
    _teardown() {
        if (this._map)
            Image._unregisterInteractive(this);
        if (this._group.parent)
            this._group.parent.remove(this._group);
        this._disposeGeometry();
        this._disposeTexture();
        this._crs = null;
        this._isHovered = false;
        this._dirtyGeometry = true;
        this._worldPositions.length = 0;
    }
    _applyHidden() {
        if (this._group)
            this._group.visible = false;
    }
    _onTooltipChanged() {
        if (!this._map)
            return;
        if (this._onClick || this._onHover || this._tooltipText) {
            Image._registerInteractive(this);
        }
        else {
            Image._unregisterInteractive(this);
        }
    }
    _onAltitudeChanged() {
        this._dirtyGeometry = true;
        if (this._map)
            this._buildGeometry(this._map);
    }
    getLabelType() { return 'image'; }
    getTitleVerticalAlign() { return 'bottom'; }
    getScreenPosition() {
        if (!this._isVisible || !this._group || !this._map)
            return null;
        const worldPos = this._tempVec3
            .copy(this._group.position)
            .add(this._map.worldGroup.position);
        worldPos.y += this._boundingSphereRadius * 0.1;
        const screenPos = worldPos.clone().project(this._map.camera);
        if (screenPos.z > 1 || Math.abs(screenPos.x) > 1 || Math.abs(screenPos.y) > 1)
            return null;
        const canvas = this._map.renderer.domElement;
        return {
            x: (screenPos.x * 0.5 + 0.5) * canvas.clientWidth,
            y: (-screenPos.y * 0.5 + 0.5) * canvas.clientHeight,
        };
    }
    // =================================================================
    // Статический реестр интерактивных
    // =================================================================
    static _registerInteractive(image) {
        Image._interactiveImages.add(image);
        if (!Image._eventListenersAttached) {
            Image._attachGlobalListeners();
        }
    }
    static _unregisterInteractive(image) {
        Image._interactiveImages.delete(image);
        if (Image._interactiveImages.size === 0 && Image._eventListenersAttached) {
            Image._detachGlobalListeners();
        }
    }
    static _attachGlobalListeners() {
        const canvas = Image._getCanvas();
        if (!canvas)
            return;
        Image._delegatedHandlers = {
            pointerdown: (e) => Image._handleGlobalPointerDown(e),
            mousemove: (e) => Image._handleGlobalMouseMove(e),
            click: (e) => Image._handleGlobalClick(e),
        };
        canvas.addEventListener('pointerdown', Image._delegatedHandlers.pointerdown, true);
        canvas.addEventListener('mousemove', Image._delegatedHandlers.mousemove, true);
        canvas.addEventListener('click', Image._delegatedHandlers.click, true);
        Image._eventListenersAttached = true;
    }
    static _detachGlobalListeners() {
        const canvas = Image._getCanvas();
        if (!canvas || !Image._delegatedHandlers)
            return;
        canvas.removeEventListener('pointerdown', Image._delegatedHandlers.pointerdown, true);
        canvas.removeEventListener('mousemove', Image._delegatedHandlers.mousemove, true);
        canvas.removeEventListener('click', Image._delegatedHandlers.click, true);
        Image._delegatedHandlers = null;
        Image._eventListenersAttached = false;
    }
    static _getCanvas() {
        for (const img of Image._interactiveImages) {
            if (img._map?.renderer?.domElement) {
                return img._map.renderer.domElement;
            }
        }
        return null;
    }
    static _handleGlobalPointerDown(event) {
        Image._pointerDownX = event.clientX;
        Image._pointerDownY = event.clientY;
        Image._pointerDownActive = true;
    }
    static _handleGlobalMouseMove(event) {
        for (const img of Image._interactiveImages) {
            img._handleMouseMove(event);
        }
    }
    static _handleGlobalClick(event) {
        const hadPointerDown = Image._pointerDownActive;
        Image._pointerDownActive = false;
        if (hadPointerDown) {
            const dx = event.clientX - Image._pointerDownX;
            const dy = event.clientY - Image._pointerDownY;
            const threshold = Image._clickMoveThreshold;
            if (dx * dx + dy * dy > threshold * threshold)
                return;
        }
        for (const img of Image._interactiveImages) {
            img._handleClick(event);
        }
    }
    // =================================================================
    // Мутабельность
    // =================================================================
    setSource(source) {
        if (!source) {
            console.warn('Image.setSource: source is empty');
            return this;
        }
        this._source = source;
        if (this._map) {
            this._disposeTexture();
            this._loadTexture();
            if (this._material && this._texture) {
                this._material.map = this._texture;
                this._material.needsUpdate = true;
            }
        }
        return this;
    }
    getSource() { return this._source; }
    setOpacity(opacity) {
        this._opacity = Math.max(0, Math.min(1, opacity));
        if (this._material) {
            this._material.opacity = this._opacity;
            this._material.transparent = this._opacity < 1;
        }
        return this;
    }
    getOpacity() { return this._opacity; }
    setBlending(blending) {
        this._blending = blending;
        if (this._material) {
            this._material.blending = this._normalizeBlending(blending);
        }
        return this;
    }
    getBlending() { return this._blending; }
    // ── Altitude (= elevationOffset) ──────────────────────────────────
    /** @deprecated Используйте унаследованный `setAltitude`. */
    setElevationOffset(offset) {
        return this.setAltitude(offset);
    }
    /** @deprecated Используйте унаследованный `getAltitude`. */
    getElevationOffset() {
        return this.getAltitude();
    }
    // ── AlwaysOnTop / PolygonOffset ──────────────────────────────────
    /**
     * Единственный control над depth для Image: `alwaysOnTop` одновременно
     * переключает `depthTest` и `polygonOffset` на материале. Отдельных
     * `setDepthTest`/`setDepthWrite` у Image нет — this._alwaysOnTop и есть
     * абстракция глубины.
     */
    setAlwaysOnTop(alwaysOnTop) {
        this._alwaysOnTop = !!alwaysOnTop;
        if (this._material) {
            this._material.depthTest = !this._alwaysOnTop;
            this._material.polygonOffset = !this._alwaysOnTop;
            this._material.needsUpdate = true;
        }
        return this;
    }
    getAlwaysOnTop() { return this._alwaysOnTop; }
    /** Сдвиг по глубине (отрицательное значение — ближе к камере). */
    setPolygonOffset(offset) {
        if (!Number.isFinite(offset))
            return this;
        this._polygonOffset = offset;
        if (this._material) {
            this._material.polygonOffsetFactor = offset;
            this._material.polygonOffsetUnits = offset;
        }
        return this;
    }
    getPolygonOffset() { return this._polygonOffset; }
    // ── Узлы / позиция / размер / anchor / поворот ───────────────────
    setNodes(nodes) {
        if (!Array.isArray(nodes) || (nodes.length !== 3 && nodes.length !== 4)) {
            throw new Error('Image.setNodes: nodes must be an array of 3 or 4 objects');
        }
        this._nodes = nodes;
        this._dirtyGeometry = true;
        if (this._map)
            this._buildGeometry(this._map);
        return this;
    }
    getNodes() {
        return this._nodes
            ? this._nodes.map(n => ({ lon: n.lon, lat: n.lat, alt: n.alt }))
            : null;
    }
    setPositionRotation(params = {}) {
        if (params.position)
            this._position = params.position;
        if (params.size)
            this._size = params.size;
        if (params.anchor)
            this._anchor = params.anchor;
        if (params.rotation)
            this._rotation = params.rotation;
        this._dirtyGeometry = true;
        if (this._map)
            this._buildGeometry(this._map);
        return this;
    }
    setPosition(position) {
        return this.setPositionRotation({ position });
    }
    setSize(size) {
        return this.setPositionRotation({ size });
    }
    setAnchor(anchor) {
        return this.setPositionRotation({ anchor });
    }
    setRotation(rotation) {
        return this.setPositionRotation({ rotation });
    }
    getPosition() {
        return this._position ? [...this._position] : null;
    }
    getSize() { return [...this._size]; }
    getAnchor() { return [...this._anchor]; }
    getRotation() { return [...this._rotation]; }
    getCenter() {
        const b = this.getBounds('EPSG:4326');
        if (!b)
            return null;
        return [
            (b[0][0] + b[1][0]) / 2,
            (b[0][1] + b[1][1]) / 2,
        ];
    }
    // =================================================================
    // Внутренние — текстура / геометрия / материал
    // =================================================================
    _loadTexture() {
        if (!this._source)
            return;
        if (this._source instanceof HTMLCanvasElement) {
            this._texture = new THREE.CanvasTexture(this._source);
        }
        else if (this._source instanceof HTMLImageElement) {
            this._texture = new THREE.Texture(this._source);
            this._texture.needsUpdate = true;
        }
        else if (typeof this._source === 'string') {
            const loader = new THREE.TextureLoader();
            loader.setCrossOrigin('anonymous');
            this._texture = loader.load(this._source, () => { if (this._material)
                this._material.needsUpdate = true; }, undefined, (err) => console.warn('Image: failed to load texture', err));
        }
        else {
            console.warn('Image: unsupported source type', this._source);
        }
    }
    _disposeTexture() {
        if (this._texture) {
            this._texture.dispose();
            this._texture = null;
        }
    }
    _disposeGeometry() {
        if (this._geometry) {
            this._geometry.dispose();
            this._geometry = null;
        }
        if (this._material) {
            this._material.dispose();
            this._material = null;
        }
        this._mesh = null;
    }
    _normalizeBlending(blending) {
        if (typeof blending === 'number')
            return blending;
        switch (blending.toLowerCase()) {
            case 'additive': return THREE.AdditiveBlending;
            case 'multiply': return THREE.MultiplyBlending;
            case 'subtract': return THREE.SubtractiveBlending;
            case 'normal':
            default: return THREE.NormalBlending;
        }
    }
    _computeWorldPositionsFromNodes() {
        if (!this._nodes || this._nodes.length < 3 || !this._map)
            return [];
        const map = this._map;
        const positions = this._nodes.map(node => {
            const [x, z] = map.project([node.lon, node.lat], this._crs);
            const y = (node.alt || 0) + this._altitude;
            return new THREE.Vector3(x, y, z);
        });
        if (positions.length === 4) {
            const [p0, p1, p2, p3] = positions;
            const normal = new THREE.Vector3().subVectors(p1, p0)
                .cross(new THREE.Vector3().subVectors(p2, p0));
            const denom = normal.lengthSq();
            if (denom > 1e-10) {
                normal.normalize();
                const dist = new THREE.Vector3().subVectors(p3, p0).dot(normal);
                if (Math.abs(dist) > 1e-6) {
                    positions[3] = p3.clone().addScaledVector(normal, -dist);
                }
            }
        }
        return positions;
    }
    _computeWorldPositionsFromAnchor() {
        if (!this._position || !this._map)
            return [];
        const [lon, lat, alt] = this._position;
        const [width, height] = this._size;
        const [ax, ay] = this._anchor;
        const [rx, ry, rz] = this._rotation;
        const [worldX, worldZ] = this._map.project([lon, lat], this._crs);
        const center = new THREE.Vector3(worldX, (alt || 0) + this._altitude, worldZ);
        const halfW = width / 2;
        const halfH = height / 2;
        const cornersLocal = [
            new THREE.Vector3(-halfW, 0, -halfH),
            new THREE.Vector3(halfW, 0, -halfH),
            new THREE.Vector3(-halfW, 0, halfH),
            new THREE.Vector3(halfW, 0, halfH),
        ];
        const anchorOffset = new THREE.Vector3((0.5 - ax) * width, 0, (0.5 - ay) * height);
        cornersLocal.forEach(c => c.add(anchorOffset));
        const euler = new THREE.Euler(rx, ry, rz, 'XYZ');
        const quaternion = new THREE.Quaternion().setFromEuler(euler);
        const rotatedCorners = cornersLocal.map(local => local.clone().applyQuaternion(quaternion));
        return rotatedCorners.map(local => new THREE.Vector3(center.x + local.x, center.y + local.y, center.z + local.z));
    }
    _buildGeometry(map) {
        this._disposeGeometry();
        let worldPositions;
        if (this._nodes) {
            worldPositions = this._computeWorldPositionsFromNodes();
        }
        else if (this._position) {
            worldPositions = this._computeWorldPositionsFromAnchor();
        }
        else {
            console.warn('Image: neither nodes nor position provided');
            return;
        }
        if (worldPositions.length < 3) {
            console.warn('Image: not enough positions to build geometry');
            return;
        }
        this._worldPositions = worldPositions;
        const centroid = new THREE.Vector3();
        worldPositions.forEach(p => centroid.add(p));
        centroid.divideScalar(worldPositions.length);
        this._centroidWorld.copy(centroid);
        let geometry;
        if (worldPositions.length === 3) {
            geometry = new THREE.BufferGeometry();
            const vertices = new Float32Array(9);
            worldPositions.forEach((p, i) => {
                vertices[i * 3] = p.x - centroid.x;
                vertices[i * 3 + 1] = p.y - centroid.y;
                vertices[i * 3 + 2] = p.z - centroid.z;
            });
            geometry.setAttribute('position', new THREE.BufferAttribute(vertices, 3));
            geometry.setIndex([0, 1, 2]);
            const uvs = new Float32Array([0, 0, 1, 0, 0, 1]);
            geometry.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
        }
        else {
            geometry = new THREE.PlaneGeometry(1, 1, 1, 1);
            const pos = geometry.attributes.position;
            for (let i = 0; i < 4; i++) {
                pos.setXYZ(i, worldPositions[i].x - centroid.x, worldPositions[i].y - centroid.y, worldPositions[i].z - centroid.z);
            }
            pos.needsUpdate = true;
            geometry.computeVertexNormals();
        }
        const onTop = this._alwaysOnTop;
        const material = new THREE.MeshBasicMaterial({
            map: this._texture || null,
            side: THREE.DoubleSide,
            transparent: this._opacity < 1,
            opacity: this._opacity,
            blending: this._normalizeBlending(this._blending),
            depthTest: !onTop,
            depthWrite: false,
            polygonOffset: !onTop,
            polygonOffsetFactor: this._polygonOffset,
            polygonOffsetUnits: this._polygonOffset,
        });
        const mesh = new THREE.Mesh(geometry, material);
        mesh.renderOrder = IMAGE_RENDER_ORDER;
        this._group.clear();
        this._group.add(mesh);
        this._group.position.copy(centroid);
        this._geometry = geometry;
        this._material = material;
        this._mesh = mesh;
        let maxRadiusSq = 0;
        worldPositions.forEach(p => {
            const dx = p.x - centroid.x;
            const dy = p.y - centroid.y;
            const dz = p.z - centroid.z;
            const rSq = dx * dx + dy * dy + dz * dz;
            if (rSq > maxRadiusSq)
                maxRadiusSq = rSq;
        });
        this._boundingSphereRadius = Math.sqrt(maxRadiusSq);
        this._dirtyGeometry = false;
    }
    _rebuildGeometryIfNeeded(map) {
        if (this._dirtyGeometry)
            this._buildGeometry(map);
    }
    // =================================================================
    // Обработчики событий
    // =================================================================
    _handleMouseMove(event) {
        if (!this._map || !this._isVisible)
            return;
        const hit = this._raycastImage(event);
        if (hit) {
            if (!this._isHovered) {
                this._isHovered = true;
                if (this._onHover)
                    this._onHover(true);
                else if (this._tooltipText && this._map.popupManager) {
                    this._map.popupManager.show(this, this._tooltipText);
                }
            }
        }
        else if (this._isHovered) {
            this._isHovered = false;
            if (this._onHover)
                this._onHover(false);
            else if (this._tooltipText && this._map.popupManager) {
                this._map.popupManager.hide();
            }
        }
    }
    _handleClick(event) {
        if (!this._map || !this._isVisible)
            return;
        if (this._raycastImage(event)) {
            if (this._onClick)
                this._onClick(event, this);
            else if (this._tooltipText && this._map.popupManager) {
                this._map.popupManager.show(this, this._tooltipText);
            }
        }
    }
    _raycastImage(event) {
        if (!this._mesh || !this._mesh.visible || !this._map)
            return false;
        const rect = this._map.renderer.domElement.getBoundingClientRect();
        const mouse = new THREE.Vector2(((event.clientX - rect.left) / rect.width) * 2 - 1, -((event.clientY - rect.top) / rect.height) * 2 + 1);
        const raycaster = new THREE.Raycaster();
        raycaster.setFromCamera(mouse, this._map.camera);
        return raycaster.intersectObject(this._mesh, false).length > 0;
    }
    // =================================================================
    // Обновление на кадре
    // =================================================================
    _update(map) {
        if (!this._map || !this._group)
            return;
        this._applyZoomInterpolations(map.continuousZoom);
        if (!this._isWithinView()) {
            this._applyHidden();
            this._isVisible = false;
            return;
        }
        this._rebuildGeometryIfNeeded(map);
        if (this._boundingSphereRadius > 0) {
            const maxDist = map.maxObjectDistance;
            if (maxDist !== Infinity) {
                const worldCenter = this._tempVec3
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
    }
    // =================================================================
    // KrbMap#fitTo / getBounds
    // =================================================================
    getBounds(crs = 'EPSG:4326') {
        const srcCrs = this._crs
            ?? (this._crsCode ? Projections.get(this._crsCode) : Projections.get('EPSG:4326'));
        const dstCrs = typeof crs === 'string' ? Projections.get(crs) : crs;
        if (!srcCrs || !dstCrs)
            return null;
        // Режим 1: nodes — по «сырым» координатам.
        if (this._nodes && this._nodes.length >= 3) {
            let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
            let count = 0;
            for (const node of this._nodes) {
                if (!node)
                    continue;
                const px = node.lon, py = node.lat;
                if (!isFinite(px) || !isFinite(py))
                    continue;
                let x, y;
                if (srcCrs === dstCrs) {
                    x = px;
                    y = py;
                }
                else {
                    const lonLat = srcCrs.toLonLat([px, py]);
                    const conv = dstCrs.fromLonLat(lonLat);
                    x = conv[0];
                    y = conv[1];
                }
                if (x < minX)
                    minX = x;
                if (x > maxX)
                    maxX = x;
                if (y < minY)
                    minY = y;
                if (y > maxY)
                    maxY = y;
                count++;
            }
            if (count === 0 || !isFinite(minX))
                return null;
            return [[minX, minY], [maxX, maxY]];
        }
        // Режим 2: position + size + anchor + rotation.
        if (this._position) {
            if (this._map) {
                const worldCorners = this._computeWorldPositionsFromAnchor();
                if (worldCorners.length >= 3) {
                    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
                    let count = 0;
                    for (const v of worldCorners) {
                        const coord = this._map.unproject([v.x, v.z], dstCrs);
                        if (!coord || !isFinite(coord[0]) || !isFinite(coord[1]))
                            continue;
                        if (coord[0] < minX)
                            minX = coord[0];
                        if (coord[0] > maxX)
                            maxX = coord[0];
                        if (coord[1] < minY)
                            minY = coord[1];
                        if (coord[1] > maxY)
                            maxY = coord[1];
                        count++;
                    }
                    if (count > 0 && isFinite(minX))
                        return [[minX, minY], [maxX, maxY]];
                }
            }
            // Fallback: карта не привязана — возвращаем точку position.
            const px = this._position[0], py = this._position[1];
            if (!isFinite(px) || !isFinite(py))
                return null;
            let x, y;
            if (srcCrs === dstCrs) {
                x = px;
                y = py;
            }
            else {
                const lonLat = srcCrs.toLonLat([px, py]);
                const conv = dstCrs.fromLonLat(lonLat);
                x = conv[0];
                y = conv[1];
            }
            return [[x, y], [x, y]];
        }
        return null;
    }
}
