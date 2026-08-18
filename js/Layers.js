/**
 * Модуль слоёв картографической библиотеки.
 * Предоставляет базовый класс {@link Layer} для группировки объектов
 * и {@link ClusterLayer} с поддержкой динамической кластеризации маркеров.
 *
 * @module layers
 */

import { _getPanes } from './Marker.js';
import { proj } from './Utils.js';
import {
  THREE
} from '../js_TP/tpb.js';  

/**
 * Базовый слой, управляющий коллекцией объектов карты.
 * Объекты могут быть маркерами, линиями, полигонами и т. д.
 * Слой автоматически вызывает метод `_update` каждого объекта на каждом кадре,
 * если он определён.
 *
 * @example
 * const layer = new Layer();
 * const map = {
 *   _dynamicLayers: [],
 *   targetElement: document.createElement('div'),
 *   textManager: {
 *     addLabel: () => {},
 *     removeLabel: () => {}
 *   }
 * };
 * layer.addTo(map);
 * const marker = new Marker({
 *   position: [37.662039, 55.763493],
 *   tooltip: 'МИИГАиК'
 * });
 * layer.add(marker);
 * layer.setVisible(false);
 * layer.setVisible(true);
 * layer.remove(marker);
 * layer.removeFromMap();
 */

export class Layer {
    constructor() {
        /** @private */ this._objects = [];
        /** @type {boolean} Видимость слоя. */
        this.visible = true;
        /** @private */ this._map = null;
    }

    /**
     * Добавляет слой на карту. Если слой уже добавлен на другую карту,
     * он будет сначала удалён оттуда.
     *
     * @param {Object} map - Экземпляр карты.
     * @returns {Layer} this
     */
    addTo(map) {
        if (this._map === map) return this;
        this.removeFromMap();
        this._map = map;
        if (map._dynamicLayers && !map._dynamicLayers.includes(this)) {
            map._dynamicLayers.push(this);
        }
        return this;
    }

    /**
     * Удаляет слой с карты, уничтожая все связанные объекты.
     */
    removeFromMap() {
        if (!this._map) return;
        for (const obj of [...this._objects]) {
            obj.remove();
        }
        this._objects = [];
        if (this._map && this._map._dynamicLayers) {
            const idx = this._map._dynamicLayers.indexOf(this);
            if (idx > -1) this._map._dynamicLayers.splice(idx, 1);
        }
        this._map = null;
    }

    /**
     * Добавляет один или несколько объектов на слой.
     * Объекты будут автоматически прикреплены к карте.
     *
     * @param {...Object} objects - Объекты карты (маркеры и т. п.).
     * @returns {Layer} this
     */
    add(...objects) {
        if (!this._map) {
            console.warn('Layer.add(): сначала вызовите layer.addTo(map)');
            return this;
        }
        for (const obj of objects) {
            if (obj._map) obj.remove();
            obj._attach(this._map, this);
            this._objects.push(obj);
        }
        return this;
    }

    /**
     * Удаляет указанный объект со слоя.
     *
     * @param {Object} object - Объект для удаления.
     * @returns {Layer} this
     */
    remove(object) {
        const idx = this._objects.indexOf(object);
        if (idx > -1) object.remove();
        return this;
    }

    /**
     * Удаляет ссылку на объект из внутреннего массива (вызывается при удалении объекта).
     *
     * @param {Object} obj - Удаляемый объект.
     * @private
     */
    _removeRef(obj) {
        const idx = this._objects.indexOf(obj);
        if (idx > -1) this._objects.splice(idx, 1);
    }

    /**
     * Устанавливает видимость слоя.
     *
     * @param {boolean} visible - Новое состояние видимости.
     * @returns {Layer} this
     */
    setVisible(visible) {
        this.visible = visible;
        return this;
    }

    /**
     * Вызывается картой на каждом кадре для обновления всех объектов слоя.
     *
     * @param {Object} map - Экземпляр карты.
     * @private
     */
    _postUpdate(map) {
        if (!this.visible) return;
        for (const obj of this._objects) {
            if (obj._update) obj._update(map);
        }
    }
}

/**
 * Слой с поддержкой кластеризации маркеров.
 * Группирует близко расположенные маркеры в кластеры, отображаемые
 * в виде специальных DOM-элементов. Наследует {@link Layer}.
 *
 * @example
 * const layer = new ClusterLayer({
 *     clusterDistance: 60,
 *     clusterMinSize: 3,
 *     clusterMaxZoom: 16,
 *     clusterIconUrl: 'cluster.png',
 *     clusterIconSize: [50, 50],
 *     clusterAnchor: [0.5, 0.5],
 *     clusterTextStyle: { color: '#ffffff', font: 'bold 14px sans-serif', textShadow: '1px 1px 2px black' },
 *     clusterStyleFunction: ({ count, markers }) => ({ html: `<div>${count}</div>` }),
 *     updateThrottle: 30,
 *     clusterZoomOnClick: 2,
 * });
 * const map = { _dynamicLayers: [], _panes: { markerPane: { addEventListener() {}, removeEventListener() {} } } };
 * layer.addTo(map);
 * const marker = {
 *     _map: null,
 *     _clusterable: true,
 *     _minZoom: 0,
 *     _maxZoom: 22,
 *     _lon: 0,
 *     _lat: 0,
 *     _altitudeMode: 'absolute',
 *     _element: document.createElement('div'),
 *     _attach(map, layer) { this._map = map; this._layer = layer; },
 *     remove() { this._layer._removeRef(this); this._map = null; },
 *     _update(map) {},
 * };
 * layer.add(marker);
 * layer.setVisible(true);
 * layer.remove(marker);
 * layer.removeFromMap();
 */
export class ClusterLayer extends Layer {
    /**
     * Создаёт слой кластеризации маркеров.
     *
     * @param {Object} [options] - Настройки кластеризации.
     * @param {number} [options.clusterDistance=50] - Максимальное расстояние в пикселях между маркерами для объединения.
     * @param {number} [options.clusterMinSize=2] - Минимальное количество маркеров для формирования кластера.
     * @param {number} [options.clusterMaxZoom=18] - Уровень зума, выше которого кластеризация отключается.
     * @param {string} [options.clusterIconUrl] - URL изображения для иконки кластера.
     * @param {Array.<number>} [options.clusterIconSize=[40, 40]] - Размер иконки кластера в пикселях [ширина, высота].
     * @param {Array.<number>} [options.clusterAnchor=[0.5, 0.5]] - Якорь иконки (доли от размера).
     * @param {Object} [options.clusterTextStyle] - CSS-стили для текста количества внутри кластера.
     * @param {Function} [options.clusterStyleFunction] - Функция кастомизации внешнего вида кластера.
     *     Принимает объект `{ count, markers }` и может вернуть `{ iconUrl?, iconSize?, anchor?, html? }`.
     * @param {number} [options.updateThrottle=0] - Минимальный интервал между пересчётами кластеров (мс).
     * @param {number} [options.clusterZoomOnClick=1.5] - Величина приближения при клике на кластер.
     */
    constructor(options = {}) {
        super();
        this.clusterDistance = options.clusterDistance ?? 50;
        this.clusterMinSize = options.clusterMinSize ?? 2;
        this.clusterMaxZoom = options.clusterMaxZoom ?? 18;
        this.clusterIconUrl = options.clusterIconUrl || null;
        this.clusterIconSize = options.clusterIconSize || [40, 40];
        this.clusterAnchor = options.clusterAnchor || [0.5, 0.5];
        this.clusterTextStyle = options.clusterTextStyle || {};
        this.clusterStyleFunction = options.clusterStyleFunction || null;
        this.updateThrottle = options.updateThrottle ?? 0;
        this.clusterZoomOnClick = options.clusterZoomOnClick ?? 1.5;

        /** @private */ this._clusterElements = [];
        /** @private */ this._clusterGroups = [];
        /** @private */ this._lastUpdateTime = 0;
        /** @private */ this._clusterActive = false;
        /** @private */ this._clusterVisibleMarkers = new Set();
        /** @private */ this._clickHandler = null;
    }

    /**
     * Добавляет слой на карту и инициализирует обработчик кликов по кластерам.
     *
     * @param {Object} map - Экземпляр карты.
     * @returns {ClusterLayer} this
     */
    addTo(map) {
        super.addTo(map);
        this._panes = _getPanes(map);

        if (!this._clickHandler) {
            this._clickHandler = (e) => {
                if (e.pointerType === 'mouse' && e.button !== 0) return;
                const clusterEl = e.target.closest('[data-cluster-id]');
                if (!clusterEl) return;
                const clusterId = parseInt(clusterEl.dataset.clusterId, 10);
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

    /**
     * Удаляет слой с карты, очищает кластеры и удаляет обработчики.
     */
    removeFromMap() {
        if (this._clickHandler && this._panes) {
            this._panes.markerPane.removeEventListener('pointerdown', this._clickHandler, true);
            this._clickHandler = null;
        }
        this._clearClusters();
        super.removeFromMap();
    }

    /**
     * Удаляет все DOM-элементы кластеров и сбрасывает состояние.
     *
     * @private
     */
    _clearClusters() {
        for (const el of this._clusterElements) {
            el.remove();
        }
        this._clusterElements = [];
        this._clusterGroups = [];
        this._clusterActive = false;
        this._clusterVisibleMarkers.clear();
    }

    /**
     * Обновляет состояние кластеров на каждом кадре с учётом троттлинга.
     *
     * @param {Object} map - Экземпляр карты.
     * @private
     */
    _postUpdate(map) {
        super._postUpdate(map);
        const now = performance.now();
        if (now - this._lastUpdateTime < this.updateThrottle) return;
        this._lastUpdateTime = now;

        // Скрываем все существующие кластеры (не удаляем для переиспользования)
        for (const el of this._clusterElements) {
            el.style.display = 'none';
        }
        this._clusterGroups = [];
        this._clusterActive = false;
        this._clusterVisibleMarkers.clear();

        if (!this.visible) return;

        const zoom = map.continuousZoom;
        if (zoom >= this.clusterMaxZoom) {
            this._clusterActive = false;
            this._clusterVisibleMarkers.clear();
            return;
        }

        // Сбор видимых маркеров, участвующих в кластеризации
        const screenPoints = [];
        for (const marker of this._objects) {
            if (!marker._clusterable) continue;
            if (zoom < marker._minZoom || zoom > marker._maxZoom) continue;
            if (!marker._element) continue;

            const [wx, wz] = proj.fromLonLat([marker._lon, marker._lat]);
            const wgPos = map.worldGroup.position;
            const worldX = wx + wgPos.x;
            const worldZ = wz + wgPos.z;
            let worldY = 0;
            if (marker._altitudeMode === 'clampToGround') {
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

        // Простая кластеризация на основе расстояния в пикселях
        const clustered = new Set();
        const clusters = [];
        for (let i = 0; i < screenPoints.length; i++) {
            if (clustered.has(i)) continue;
            const pt = screenPoints[i];
            const group = [pt];
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
        const visibleMarkers = new Set();
        const markerPane = this._panes.markerPane;
        let clusterIndex = 0;

        for (const group of clusters) {
            // Проверка дистанции от камеры до центра кластера
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
                    continue; // кластер слишком далеко, маркеры не показываем
                }
            }

            if (group.length < this.clusterMinSize) {
                for (const { marker } of group) {
                    visibleMarkers.add(marker);
                }
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
                    markers: group.map(g => g.marker)
                });
                if (style.iconUrl !== undefined) iconUrl = style.iconUrl;
                if (style.iconSize) iconSize = style.iconSize;
                if (style.anchor) anchor = style.anchor;
                if (style.html !== undefined) htmlContent = style.html;
            }

            // Переиспользуем или создаём элемент кластера
            let el = this._clusterElements[clusterIndex];
            if (!el) {
                el = document.createElement('div');
                el.className = 'krb-cluster';
                el.style.position = 'absolute';
                el.style.pointerEvents = 'auto';
                el.style.cursor = 'pointer';
                markerPane.appendChild(el);
                this._clusterElements.push(el);
            }

            el.style.display = 'block';
            el.style.left = avgX + 'px';
            el.style.top = avgY + 'px';
            el.style.width = iconSize[0] + 'px';
            el.style.height = iconSize[1] + 'px';
            el.style.transform = `translate(${-anchor[0] * 100}%, ${-anchor[1] * 100}%)`;
            el.dataset.clusterId = clusterIndex;

            // Формирование внешнего вида
            if (htmlContent) {
                el.innerHTML = htmlContent;
            } else if (iconUrl) {
                el.innerHTML = '';
                el.style.backgroundColor = '';
                el.style.borderRadius = '';
                el.style.display = '';
                el.style.alignItems = '';
                el.style.justifyContent = '';
                el.style.color = '';
                el.style.fontWeight = '';
                el.style.fontSize = '';

                const img = document.createElement('img');
                img.src = iconUrl;
                img.style.width = '100%';
                img.style.height = '100%';
                img.draggable = false;
                el.appendChild(img);
                const span = document.createElement('span');
                span.textContent = count;
                span.style.position = 'absolute';
                span.style.top = '50%';
                span.style.left = '50%';
                span.style.transform = 'translate(-50%, -50%)';
                span.style.color = this.clusterTextStyle.color || '#fff';
                span.style.font = this.clusterTextStyle.font || 'bold 12px sans-serif';
                span.style.textShadow = this.clusterTextStyle.textShadow || '1px 1px 2px black';
                el.appendChild(span);
            } else {
                el.innerHTML = '';
                el.style.backgroundColor = '#3388ff';
                el.style.borderRadius = '50%';
                el.style.display = 'flex';
                el.style.alignItems = 'center';
                el.style.justifyContent = 'center';
                el.style.color = '#fff';
                el.style.fontWeight = 'bold';
                el.style.fontSize = '12px';
                el.textContent = count;
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

    /**
     * Обрабатывает клик по кластеру: перемещает камеру к центру кластера
     * и увеличивает зум, чтобы разгруппировать маркеры.
     *
     * @param {Array} group - Массив объектов { marker, sx, sy, worldPos }.
     * @param {Object} map - Экземпляр карты.
     * @private
     */
    _handleClusterClick(group, map) {
        const markers = group.map(p => p.marker);
        const avgLon = markers.reduce((s, m) => s + m._lon, 0) / markers.length;
        const avgLat = markers.reduce((s, m) => s + m._lat, 0) / markers.length;

        const currentZoom = map.continuousZoom;
        const targetZoom = Math.min(currentZoom + this.clusterZoomOnClick, this.clusterMaxZoom);

        map.moveCameraToSlow(avgLon, avgLat, 0.6, targetZoom);
    }
}