/**
 * Модуль слоёв картографической библиотеки.
 * Предоставляет базовый класс {@link Layer} для группировки объектов
 * и {@link ClusterLayer} с поддержкой динамической кластеризации маркеров.
 *
 * @module layers
 */
import { _getPanes } from './Marker.js';
import { THREE } from './js_TP/tpb.js';
// =====================================================================
// Layer
// =====================================================================
/**
 * Базовый слой, управляющий коллекцией объектов карты.
 * Объекты могут быть маркерами, линиями, полигонами и т.д.
 * Слой автоматически вызывает метод `_update` каждого объекта на каждом
 * кадре, если он определён.
 *
 * @example
 * const layer = new Layer();
 * layer.addTo(map);
 * layer.add(marker);
 * layer.setVisible(false);
 * layer.setVisible(true);
 * layer.filter(m => m.getZoomBounds().max > 10);  // только «дальние»
 * layer.filter(null);                              // снять фильтр
 * layer.remove(marker);
 * layer.removeFromMap();
 */
export class Layer {
    _objects = [];
    visible = true;
    _map = null;
    _filter = null;
    _filterHidden = new Set();
    // ── Batcher ──
    _polygonBatcher = null;
    static _batcherFactory = null;
    static setBatcherFactory(fn) {
        Layer._batcherFactory = fn;
    }
    _ensureBatcher() {
        if (this._polygonBatcher)
            return;
        if (!Layer._batcherFactory)
            return;
        this._polygonBatcher = Layer._batcherFactory(this);
        if (this._map)
            this._polygonBatcher.addTo(this._map);
    }
    constructor() { }
    // ── Lifecycle ──
    addTo(map) {
        if (this._map === map)
            return this;
        this.removeFromMap();
        this._map = map;
        if (map._dynamicLayers && !map._dynamicLayers.includes(this)) {
            map._dynamicLayers.push(this);
        }
        if (this._polygonBatcher)
            this._polygonBatcher.addTo(map);
        return this;
    }
    removeFromMap() {
        if (!this._map)
            return;
        if (this._polygonBatcher)
            this._polygonBatcher.removeFromMap();
        for (const obj of [...this._objects])
            obj.remove();
        this._objects = [];
        this._filterHidden.clear();
        if (this._map._dynamicLayers) {
            const idx = this._map._dynamicLayers.indexOf(this);
            if (idx > -1)
                this._map._dynamicLayers.splice(idx, 1);
        }
        this._map = null;
    }
    // ── Коллекция ──
    add(...objects) {
        if (!this._map) {
            console.warn('Layer.add(): call layer.addTo(map) first');
            return this;
        }
        this._ensureBatcher();
        for (const obj of objects) {
            if (obj._map)
                obj.remove();
            obj._attach(this._map, this);
            this._objects.push(obj);
            if (this._filter && !this._filter(obj)) {
                obj.setVisible(false);
                this._filterHidden.add(obj);
            }
        }
        this._polygonBatcher?.markDirty?.();
        return this;
    }
    remove(object) {
        const idx = this._objects.indexOf(object);
        if (idx > -1)
            object.remove();
        this._filterHidden.delete(object);
        this._polygonBatcher?.markDirty?.();
        return this;
    }
    /** @internal — вызывается из SpatialObject.remove(). */
    _removeRef(obj) {
        this._filterHidden.delete(obj);
        const idx = this._objects.indexOf(obj);
        if (idx > -1)
            this._objects.splice(idx, 1);
        this._polygonBatcher?.markDirty?.();
    }
    // ── Видимость ──
    setVisible(visible) {
        this.visible = visible;
        return this;
    }
    // ── Фильтр ──
    filter(predicate) {
        // Восстановить всё, что было скрыто предыдущим фильтром.
        for (const obj of this._filterHidden) {
            obj.setVisible(true);
        }
        this._filterHidden.clear();
        this._filter = predicate ?? null;
        if (predicate) {
            for (const obj of this._objects) {
                if (!predicate(obj)) {
                    obj.setVisible(false);
                    this._filterHidden.add(obj);
                }
            }
        }
        this._polygonBatcher?.markDirty?.();
        return this;
    }
    // ── Per-frame ──
    _postUpdate(map, deltaTime) {
        if (this._polygonBatcher) {
            this._polygonBatcher.update(map, deltaTime);
        }
        for (const obj of this._objects) {
            const o = obj;
            if (typeof o._update === 'function')
                o._update(map, deltaTime);
        }
    }
    // ── getBounds ──
    getBounds(crs = 'EPSG:4326') {
        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
        let count = 0;
        for (const obj of this._objects) {
            const o = obj;
            if (!o || typeof o.getBounds !== 'function')
                continue;
            let b;
            try {
                b = o.getBounds(crs);
            }
            catch (err) {
                console.warn('Layer.getBounds(): getBounds() threw an error for', obj, err);
                continue;
            }
            if (!b || !b[0] || !b[1])
                continue;
            if (b[0][0] < minX)
                minX = b[0][0];
            if (b[0][1] < minY)
                minY = b[0][1];
            if (b[1][0] > maxX)
                maxX = b[1][0];
            if (b[1][1] > maxY)
                maxY = b[1][1];
            count++;
        }
        if (count === 0 || !isFinite(minX))
            return null;
        return [[minX, minY], [maxX, maxY]];
    }
}
// =====================================================================
// ClusterLayer
// =====================================================================
/**
 * Слой с поддержкой кластеризации маркеров.
 * Группирует близко расположенные маркеры в кластеры, отображаемые
 * в виде специальных DOM-элементов. Наследует {@link Layer}.
 *
 * Координаты маркеров могут быть заданы в любой СК, зарегистрированной
 * в `Projections` (через опцию `crs` у маркера). Внутри слоя они всегда
 * приводятся к мировым координатам карты методом `map.project`, поэтому
 * кластеризация корректно работает даже при смешанных СК у маркеров.
 */
export class ClusterLayer extends Layer {
    // ── Настройки кластеризации ──
    clusterDistance = 50;
    clusterMinSize = 2;
    clusterMaxZoom = 18;
    clusterIconUrl = null;
    clusterIconSize = [40, 40];
    clusterAnchor = [0.5, 0.5];
    clusterTextStyle = {};
    clusterStyleFunction = null;
    updateThrottle = 0;
    clusterZoomOnClick = 1.5;
    // ── Внутреннее состояние ──
    _clusterElements = [];
    _clusterGroups = [];
    _lastUpdateTime = 0;
    /** Читается из `Marker._update` через `(this._layer as any)._clusterActive`. */
    _clusterActive = false;
    /** Читается из `Marker._update` через `(this._layer as any)._clusterVisibleMarkers`. */
    _clusterVisibleMarkers = new Set();
    _panes = null;
    _clickHandler = null;
    constructor(options = {}) {
        super();
        this.clusterDistance = options.clusterDistance ?? 50;
        this.clusterMinSize = options.clusterMinSize ?? 2;
        this.clusterMaxZoom = options.clusterMaxZoom ?? 18;
        this.clusterIconUrl = options.clusterIconUrl ?? null;
        this.clusterIconSize = options.clusterIconSize ?? [40, 40];
        this.clusterAnchor = options.clusterAnchor ?? [0.5, 0.5];
        this.clusterTextStyle = options.clusterTextStyle ?? {};
        this.clusterStyleFunction = options.clusterStyleFunction ?? null;
        this.updateThrottle = options.updateThrottle ?? 0;
        this.clusterZoomOnClick = options.clusterZoomOnClick ?? 1.5;
    }
    // =================================================================
    // Присоединение / отсоединение
    // =================================================================
    addTo(map) {
        super.addTo(map);
        this._panes = _getPanes(map);
        if (!this._clickHandler) {
            this._clickHandler = (e) => {
                if (e.pointerType === 'mouse' && e.button !== 0)
                    return;
                const clusterEl = e.target
                    ?.closest('[data-cluster-id]');
                if (!clusterEl)
                    return;
                const clusterId = parseInt(clusterEl.dataset.clusterId, 10);
                const group = this._clusterGroups[clusterId];
                if (!group)
                    return;
                e.preventDefault();
                e.stopPropagation();
                this._handleClusterClick(group, this._map);
            };
            this._panes.markerPane.addEventListener('pointerdown', this._clickHandler, true);
        }
        return this;
    }
    removeFromMap() {
        if (this._clickHandler && this._panes) {
            this._panes.markerPane.removeEventListener('pointerdown', this._clickHandler, true);
            this._clickHandler = null;
        }
        this._panes = null;
        this._clearClusters();
        super.removeFromMap();
    }
    _clearClusters() {
        for (const el of this._clusterElements) {
            el.remove();
        }
        this._clusterElements = [];
        this._clusterGroups = [];
        this._clusterActive = false;
        this._clusterVisibleMarkers.clear();
    }
    // =================================================================
    // Обновление на кадре
    // =================================================================
    _postUpdate(map, deltaTime) {
        super._postUpdate(map, deltaTime);
        const now = performance.now();
        if (now - this._lastUpdateTime < this.updateThrottle)
            return;
        this._lastUpdateTime = now;
        // Скрываем все существующие кластеры (переиспользуем)
        for (const el of this._clusterElements) {
            el.style.display = 'none';
        }
        this._clusterGroups = [];
        this._clusterActive = false;
        this._clusterVisibleMarkers.clear();
        if (!this.visible || !this._panes)
            return;
        const zoom = map.continuousZoom;
        if (zoom >= this.clusterMaxZoom)
            return;
        // ─── Сбор видимых маркеров, участвующих в кластеризации ───
        const screenPoints = [];
        const markers = this._objects;
        for (const marker of markers) {
            const m = marker;
            if (!m._clusterable)
                continue;
            if (zoom < m._minZoom || zoom > m._maxZoom)
                continue;
            if (!m._element)
                continue;
            // Координаты маркера → метры проекции карты.
            const [wx, wz] = map.project(m._coord, m._crs);
            const wgPos = map.worldGroup.position;
            const worldX = wx + wgPos.x;
            const worldZ = wz + wgPos.z;
            let worldY = 0;
            if (m._altitudeMode === 'clampToGround') {
                worldY = map.getSurfaceHeightAt(worldX, worldZ);
            }
            const worldPos = new THREE.Vector3(worldX, worldY, worldZ);
            const screenPos = worldPos.clone().project(map.camera);
            if (screenPos.z > 1)
                continue;
            const canvas = map.renderer.domElement;
            const sx = (screenPos.x * 0.5 + 0.5) * canvas.clientWidth;
            const sy = (-screenPos.y * 0.5 + 0.5) * canvas.clientHeight;
            screenPoints.push({ marker, sx, sy, worldPos });
        }
        if (screenPoints.length === 0)
            return;
        // ─── Кластеризация по расстоянию в пикселях ───
        const clustered = new Set();
        const clusters = [];
        for (let i = 0; i < screenPoints.length; i++) {
            if (clustered.has(i))
                continue;
            const pt = screenPoints[i];
            const group = [pt];
            clustered.add(i);
            for (let j = i + 1; j < screenPoints.length; j++) {
                if (clustered.has(j))
                    continue;
                const other = screenPoints[j];
                const dx = pt.sx - other.sx;
                const dy = pt.sy - other.sy;
                if (Math.sqrt(dx * dx + dy * dy) < this.clusterDistance) {
                    group.push(other);
                    clustered.add(j);
                }
            }
            clusters.push(group);
        }
        this._clusterActive = true;
        const visibleMarkers = new Set();
        const markerPane = this._panes.markerPane;
        let clusterIndex = 0;
        // ─── Создание / обновление элементов кластеров ───
        for (const group of clusters) {
            // Отсечение по дистанции до камеры
            if (map.view.objectDistanceFactor > 0) {
                let avgX = 0, avgY = 0, avgZ = 0;
                for (const pt of group) {
                    avgX += pt.worldPos.x;
                    avgY += pt.worldPos.y;
                    avgZ += pt.worldPos.z;
                }
                const n = group.length;
                avgX /= n;
                avgY /= n;
                avgZ /= n;
                const center = new THREE.Vector3(avgX, avgY, avgZ);
                if (map.camera.position.distanceTo(center) > map.maxObjectDistance) {
                    continue;
                }
            }
            if (group.length < this.clusterMinSize) {
                for (const { marker } of group)
                    visibleMarkers.add(marker);
                continue;
            }
            const count = group.length;
            const avgX = group.reduce((s, p) => s + p.sx, 0) / count;
            const avgY = group.reduce((s, p) => s + p.sy, 0) / count;
            let iconUrl = this.clusterIconUrl;
            let iconSize = this.clusterIconSize;
            let anchor = this.clusterAnchor;
            let htmlContent = null;
            if (this.clusterStyleFunction) {
                const style = this.clusterStyleFunction({
                    count,
                    markers: group.map(g => g.marker),
                });
                if (style.iconUrl !== undefined)
                    iconUrl = style.iconUrl;
                if (style.iconSize)
                    iconSize = style.iconSize;
                if (style.anchor)
                    anchor = style.anchor;
                if (style.html !== undefined)
                    htmlContent = style.html;
            }
            let el = this._clusterElements[clusterIndex];
            if (!el) {
                el = document.createElement('div');
                el.className = 'krb-cluster';
                Object.assign(el.style, {
                    position: 'absolute',
                    pointerEvents: 'auto',
                    cursor: 'pointer',
                });
                markerPane.appendChild(el);
                this._clusterElements.push(el);
            }
            el.style.display = 'block';
            el.style.left = avgX + 'px';
            el.style.top = avgY + 'px';
            el.style.width = iconSize[0] + 'px';
            el.style.height = iconSize[1] + 'px';
            el.style.transform = `translate(${-anchor[0] * 100}%, ${-anchor[1] * 100}%)`;
            el.dataset.clusterId = String(clusterIndex);
            if (htmlContent) {
                el.innerHTML = htmlContent;
            }
            else if (iconUrl) {
                el.innerHTML = '';
                Object.assign(el.style, {
                    backgroundColor: '',
                    borderRadius: '',
                    display: '',
                    alignItems: '',
                    justifyContent: '',
                    color: '',
                    fontWeight: '',
                    fontSize: '',
                });
                const img = document.createElement('img');
                img.src = iconUrl;
                img.style.width = '100%';
                img.style.height = '100%';
                img.draggable = false;
                el.appendChild(img);
                const span = document.createElement('span');
                span.textContent = String(count);
                Object.assign(span.style, {
                    position: 'absolute',
                    top: '50%',
                    left: '50%',
                    transform: 'translate(-50%, -50%)',
                    color: this.clusterTextStyle.color || '#fff',
                    font: this.clusterTextStyle.font || 'bold 12px sans-serif',
                    textShadow: this.clusterTextStyle.textShadow || '1px 1px 2px black',
                });
                el.appendChild(span);
            }
            else {
                el.innerHTML = '';
                Object.assign(el.style, {
                    backgroundColor: '#3388ff',
                    borderRadius: '50%',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    color: '#fff',
                    fontWeight: 'bold',
                    fontSize: '12px',
                });
                el.textContent = String(count);
            }
            this._clusterGroups[clusterIndex] = group;
            clusterIndex++;
        }
        // Скрываем лишние элементы
        for (let i = clusterIndex; i < this._clusterElements.length; i++) {
            this._clusterElements[i].style.display = 'none';
        }
        this._clusterVisibleMarkers = visibleMarkers;
    }
    // =================================================================
    // Клик по кластеру
    // =================================================================
    /**
     * Обрабатывает клик по кластеру: перемещает камеру к центру кластера
     * и увеличивает зум, чтобы разгруппировать маркеры.
     *
     * Центр кластера вычисляется в мировых координатах (усреднение
     * `worldPos` из группы), затем переводится в WGS84 через
     * `map.unprojectToLonLat`. Такой подход корректно работает даже
     * если маркеры в кластере заданы в разных СК.
     */
    _handleClusterClick(group, map) {
        let avgX = 0, avgZ = 0;
        for (const pt of group) {
            avgX += pt.worldPos.x;
            avgZ += pt.worldPos.z;
        }
        avgX /= group.length;
        avgZ /= group.length;
        const [lon, lat] = map.unprojectToLonLat(avgX, avgZ);
        const currentZoom = map.continuousZoom;
        const targetZoom = Math.min(currentZoom + this.clusterZoomOnClick, this.clusterMaxZoom);
        map.moveCameraToSlow(lon, lat, 0.6, targetZoom);
    }
}
