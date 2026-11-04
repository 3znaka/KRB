/**
 * Модуль слоёв картографической библиотеки.
 * Предоставляет базовый класс {@link Layer} для группировки объектов
 * и {@link ClusterLayer} с поддержкой динамической кластеризации маркеров.
 *
 * @module layers
 */

import { _getPanes, type Marker } from './Marker.js';
import { THREE } from './js_TP/tpb.js';
import type { SpatialObject } from './SpatialObject.js';

// =====================================================================
// Типы кластеризации
// =====================================================================

export interface ClusterStyleResult {
    iconUrl?: string | null;
    iconSize?: [number, number];
    anchor?: [number, number];
    html?: string;
}

export interface ClusterStyleContext {
    count: number;
    markers: Marker[];
}

export type ClusterStyleFunction = (ctx: ClusterStyleContext) => ClusterStyleResult;

export interface ClusterLayerOptions {
    clusterDistance?: number;
    clusterMinSize?: number;
    clusterMaxZoom?: number;
    clusterIconUrl?: string | null;
    clusterIconSize?: [number, number];
    clusterAnchor?: [number, number];
    clusterTextStyle?: Record<string, string>;
    clusterStyleFunction?: ClusterStyleFunction | null;
    updateThrottle?: number;
    clusterZoomOnClick?: number;
}

interface ScreenPoint {
    marker: Marker;
    sx: number;
    sy: number;
    worldPos: any;
}

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
    protected _objects: SpatialObject[] = [];
    public visible: boolean = true;
    protected _map: any = null;
    protected _filter: ((obj: SpatialObject) => boolean) | null = null;
    protected _filterHidden = new Set<SpatialObject>();

    // ── Batcher ──
    _polygonBatcher: any = null;
    private static _batcherFactory: ((layer: Layer) => any) | null = null;

    static setBatcherFactory(fn: ((layer: Layer) => any) | null): void {
        Layer._batcherFactory = fn;
    }

    private _ensureBatcher(): void {
        if (this._polygonBatcher) return;
        if (!Layer._batcherFactory) return;
        this._polygonBatcher = Layer._batcherFactory(this);
        if (this._map) this._polygonBatcher.addTo(this._map);
    }

    constructor() {}

    // ── Lifecycle ──

    addTo(map: any): this {
        if (this._map === map) return this;
        this.removeFromMap();
        this._map = map;
        if (map._dynamicLayers && !map._dynamicLayers.includes(this)) {
            map._dynamicLayers.push(this);
        }
        if (this._polygonBatcher) this._polygonBatcher.addTo(map);
        return this;
    }

    removeFromMap(): void {
        if (!this._map) return;
        if (this._polygonBatcher) this._polygonBatcher.removeFromMap();
        for (const obj of [...this._objects]) obj.remove();
        this._objects = [];
        this._filterHidden.clear();
        if (this._map._dynamicLayers) {
            const idx = this._map._dynamicLayers.indexOf(this);
            if (idx > -1) this._map._dynamicLayers.splice(idx, 1);
        }
        this._map = null;
    }

    // ── Коллекция ──

    add(...objects: SpatialObject[]): this {
        if (!this._map) {
            console.warn('Layer.add(): call layer.addTo(map) first');
            return this;
        }
        this._ensureBatcher();
        for (const obj of objects) {
            if ((obj as any)._map) obj.remove();
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

    remove(object: SpatialObject): this {
        const idx = this._objects.indexOf(object);
        if (idx > -1) object.remove();
        this._filterHidden.delete(object);
        this._polygonBatcher?.markDirty?.();
        return this;
    }

    /** @internal — вызывается из SpatialObject.remove(). */
    _removeRef(obj: SpatialObject): void {
        this._filterHidden.delete(obj);
        const idx = this._objects.indexOf(obj);
        if (idx > -1) this._objects.splice(idx, 1);
        this._polygonBatcher?.markDirty?.();
    }

    // ── Видимость ──

    setVisible(visible: boolean): this {
        this.visible = visible;
        return this;
    }

    // ── Фильтр ──

    filter(predicate?: ((obj: SpatialObject) => boolean) | null): this {
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

    _postUpdate(map: any, deltaTime: number): void {
        if (this._polygonBatcher) {
            this._polygonBatcher.update(map, deltaTime);
        }
        for (const obj of this._objects) {
            const o = obj as any;
            if (typeof o._update === 'function') o._update(map, deltaTime);
        }
    }

    // ── getBounds ──

    getBounds(crs: string | any = 'EPSG:4326'): [[number, number], [number, number]] | null {
        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
        let count = 0;

        for (const obj of this._objects) {
            const o = obj as any;
            if (!o || typeof o.getBounds !== 'function') continue;

            let b: any;
            try {
                b = o.getBounds(crs);
            } catch (err) {
                console.warn('Layer.getBounds(): getBounds() threw an error for', obj, err);
                continue;
            }
            if (!b || !b[0] || !b[1]) continue;

            if (b[0][0] < minX) minX = b[0][0];
            if (b[0][1] < minY) minY = b[0][1];
            if (b[1][0] > maxX) maxX = b[1][0];
            if (b[1][1] > maxY) maxY = b[1][1];
            count++;
        }

        if (count === 0 || !isFinite(minX)) return null;
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
    public clusterDistance: number = 50;
    public clusterMinSize: number = 2;
    public clusterMaxZoom: number = 18;
    public clusterIconUrl: string | null = null;
    public clusterIconSize: [number, number] = [40, 40];
    public clusterAnchor: [number, number] = [0.5, 0.5];
    public clusterTextStyle: Record<string, string> = {};
    public clusterStyleFunction: ClusterStyleFunction | null = null;
    public updateThrottle: number = 0;
    public clusterZoomOnClick: number = 1.5;

    // ── Внутреннее состояние ──
    private _clusterElements: HTMLElement[] = [];
    private _clusterGroups: ScreenPoint[][] = [];
    private _lastUpdateTime: number = 0;
    /** Читается из `Marker._update` через `(this._layer as any)._clusterActive`. */
    private _clusterActive: boolean = false;
    /** Читается из `Marker._update` через `(this._layer as any)._clusterVisibleMarkers`. */
    private _clusterVisibleMarkers = new Set<Marker>();
    private _panes: { markerPane: HTMLElement } | null = null;
    private _clickHandler: ((e: PointerEvent) => void) | null = null;

    constructor(options: ClusterLayerOptions = {}) {
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

    override addTo(map: any): this {
        super.addTo(map);
        this._panes = _getPanes(map);

        if (!this._clickHandler) {
            this._clickHandler = (e: PointerEvent) => {
                if (e.pointerType === 'mouse' && e.button !== 0) return;
                const clusterEl = (e.target as HTMLElement | null)
                    ?.closest('[data-cluster-id]') as HTMLElement | null;
                if (!clusterEl) return;

                const clusterId = parseInt(clusterEl.dataset.clusterId!, 10);
                const group = this._clusterGroups[clusterId];
                if (!group) return;

                e.preventDefault();
                e.stopPropagation();
                this._handleClusterClick(group, this._map);
            };
            this._panes.markerPane.addEventListener('pointerdown', this._clickHandler, true);
        }
        return this;
    }

    override removeFromMap(): void {
        if (this._clickHandler && this._panes) {
            this._panes.markerPane.removeEventListener('pointerdown', this._clickHandler, true);
            this._clickHandler = null;
        }
        this._panes = null;
        this._clearClusters();
        super.removeFromMap();
    }

    private _clearClusters(): void {
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

    override _postUpdate(map: any, deltaTime: number): void {
        super._postUpdate(map, deltaTime);

        const now = performance.now();
        if (now - this._lastUpdateTime < this.updateThrottle) return;
        this._lastUpdateTime = now;

        // Скрываем все существующие кластеры (переиспользуем)
        for (const el of this._clusterElements) {
            el.style.display = 'none';
        }
        this._clusterGroups = [];
        this._clusterActive = false;
        this._clusterVisibleMarkers.clear();

        if (!this.visible || !this._panes) return;

        const zoom = map.continuousZoom;
        if (zoom >= this.clusterMaxZoom) return;

        // ─── Сбор видимых маркеров, участвующих в кластеризации ───
        const screenPoints: ScreenPoint[] = [];
        const markers = this._objects as Marker[];

        for (const marker of markers) {
            const m = marker as any;
            if (!m._clusterable) continue;
            if (zoom < m._minZoom || zoom > m._maxZoom) continue;
            if (!m._element) continue;

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
            if (screenPos.z > 1) continue;

            const canvas = map.renderer.domElement;
            const sx = (screenPos.x * 0.5 + 0.5) * canvas.clientWidth;
            const sy = (-screenPos.y * 0.5 + 0.5) * canvas.clientHeight;
            screenPoints.push({ marker, sx, sy, worldPos });
        }

        if (screenPoints.length === 0) return;

        // ─── Кластеризация по расстоянию в пикселях ───
        const clustered = new Set<number>();
        const clusters: ScreenPoint[][] = [];

        for (let i = 0; i < screenPoints.length; i++) {
            if (clustered.has(i)) continue;
            const pt = screenPoints[i];
            const group: ScreenPoint[] = [pt];
            clustered.add(i);

            for (let j = i + 1; j < screenPoints.length; j++) {
                if (clustered.has(j)) continue;
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
        const visibleMarkers = new Set<Marker>();
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
                avgX /= n; avgY /= n; avgZ /= n;
                const center = new THREE.Vector3(avgX, avgY, avgZ);
                if (map.camera.position.distanceTo(center) > map.maxObjectDistance) {
                    continue;
                }
            }

            if (group.length < this.clusterMinSize) {
                for (const { marker } of group) visibleMarkers.add(marker);
                continue;
            }

            const count = group.length;
            const avgX = group.reduce((s, p) => s + p.sx, 0) / count;
            const avgY = group.reduce((s, p) => s + p.sy, 0) / count;

            let iconUrl: string | null = this.clusterIconUrl;
            let iconSize: [number, number] = this.clusterIconSize;
            let anchor: [number, number] = this.clusterAnchor;
            let htmlContent: string | null = null;

            if (this.clusterStyleFunction) {
                const style = this.clusterStyleFunction({
                    count,
                    markers: group.map(g => g.marker),
                });
                if (style.iconUrl !== undefined) iconUrl = style.iconUrl;
                if (style.iconSize) iconSize = style.iconSize;
                if (style.anchor) anchor = style.anchor;
                if (style.html !== undefined) htmlContent = style.html;
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
            } else if (iconUrl) {
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
            } else {
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
    private _handleClusterClick(group: ScreenPoint[], map: any): void {
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