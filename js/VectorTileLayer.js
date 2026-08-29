//VectorTileLayer.js
/**
 * Модуль слоя векторных тайлов (объёмные здания с выделением острых рёбер).
 * Основная логика управления тайлами, материалами и подписями.
 */

import {
  THREE,
  Line2,
  LineMaterial,
  LineGeometry,
} from '../js_TP/tpb.js';
import { DEFAULT_STYLES } from './vectorTileDefaults.js';
import { stringToBase64, createWorkerCode } from './vectorTileWorkerCode.js';

// -----------------------------------------------------------------------------
// Класс источника подписи для точечных объектов векторных тайлов
// -----------------------------------------------------------------------------
/**
 * Источник подписи для точечных объектов векторных тайлов.
 * Используется для создания текстовых подписей через TextManager.
 *
 * @private
 */
class VectorPointLabelSource {
    constructor(map, worldX, worldZ, text, options = {}) {
        this.map = map;
        this.worldPos = new THREE.Vector3(worldX, 0, worldZ);
        this.text = text;
        this.options = options;
    }

    getText() {
        return this.text;
    }

    getLabelType() {
        return 'point';
    }

    getScreenPosition() {
        const local = this.worldPos.clone().add(this.map.worldGroup.position);
        local.project(this.map.camera);
        const rect = this.map.renderer.domElement.getBoundingClientRect();
        return {
            x: (local.x * 0.5 + 0.5) * rect.width,
            y: (-local.y * 0.5 + 0.5) * rect.height
        };
    }

    getTextStyle() {
        return {
            color: this.options.textColor || '#333333',
            fontSize: this.options.fontSize || '12px',
            fontFamily: this.options.fontFamily || 'sans-serif',
            fontWeight: this.options.fontWeight || 'normal',
            textShadow: this.options.textShadow || ''
        };
    }

    getPriority() {
        return this.options.priority || 0;
    }

    getTitleAlign() {
        return this.options.textAlign || 'center';
    }

    getTitleVerticalAlign() {
        return this.options.textVerticalAlign || 'center';
    }

    getTitleOffset() {
        return this.options.textOffset || [0, 0];
    }

    getTextZoomBounds() {
        return this.options.zoomBounds || { min: 0, max: 24 };
    }

    isVisible() {
        return this.options.visible !== false;
    }
}

// -----------------------------------------------------------------------------
// Основной класс
// -----------------------------------------------------------------------------
/**
 * Класс слоя векторных тайлов с поддержкой 3D-зданий и выделением острых рёбер.
 * Управляет загрузкой, кешированием и отображением тайлов, материалов и подписей.
 *
 * @param {Object} options - Объект с настройками слоя.
 * @property {string} options.url - URL шаблона тайлов с плейсхолдерами {z}, {x}, {y}.
 * @property {number} [options.minZoom=0] - Минимальный зум, при котором слой видим.
 * @property {number} [options.maxZoom=Infinity] - Максимальный зум, при котором слой видим.
 * @property {number} [options.maxSourceZoom=14] - Максимальный исходный зум тайлов.
 * @property {number} [options.lineWidthMultiplier=1.0] - Множитель ширины линий.
 * @property {number} [options.fillOpacity=1.0] - Общая непрозрачность заливки.
 * @property {boolean} [options.depthTest=false] - Включить тест глубины.
 * @property {Array.<string>|null} [options.visibleLayers=null] - Список видимых слоёв или null.
 * @property {boolean} [options.buildings3d=true] - Включить 3D-здания.
 * @property {number} [options.buildings3dMinZoom=17] - Минимальный зум для отображения 3D-зданий.
 * @property {boolean} [options.buildingEdges=true] - Выделять острые рёбра зданий.
 * @property {number} [options.maxTextLabels=500] - Максимальное общее количество текстовых подписей.
 * @property {number} [options.maxTextPointsPerTile=50] - Максимум подписей на тайл.
 * @property {number} [options.labelDistanceSortZoom=17] - Зум, начиная с которого сортировка по расстоянию.
 * @property {number} [options.labelMaxPerTileClose=20] - Максимум подписей на тайл при близком зуме.
 * @property {number} [options.labelCullMargin=50] - Отступ за границами экрана для отсечения подписей.
 * @property {boolean} [options.debug=false] - Режим отладки.
 * @property {Object} [options.styles={}] - Пользовательские стили, объединяются с DEFAULT_STYLES.
 * @property {Array.<string>} [options.workerScripts=['https://cdn.mapengine.ru/KRB/js_TP/tpb.js', 'https://cdn.mapengine.ru/KRB/js_TP/earcut.js']] - Массив из двух URL скриптов для воркера.
 *
 * @example
 * const layer = new VectorTileLayer({
 *     url: 'https://example.com/tiles/{z}/{x}/{y}.pbf',
 *     minZoom: 0,
 *     maxZoom: 22,
 *     maxSourceZoom: 14,
 *     lineWidthMultiplier: 1.2,
 *     fillOpacity: 0.9,
 *     depthTest: false,
 *     visibleLayers: ['buildings', 'roads'],
 *     buildings3d: true,
 *     buildings3dMinZoom: 17,
 *     buildingEdges: true,
 *     maxTextLabels: 500,
 *     maxTextPointsPerTile: 50,
 *     labelDistanceSortZoom: 17,
 *     labelMaxPerTileClose: 20,
 *     labelCullMargin: 50,
 *     debug: false,
 *     styles: { building: { color: 0xff0000, stroke: 'black' } },
 *     workerScripts: [
 *         'https://cdn.mapengine.ru/KRB/js_TP/tpb.js',
 *         'https://cdn.mapengine.ru/KRB/js_TP/earcut.js'
 *     ]
 * });
 *
 * layer.printDiscoveredClasses();
 * layer.removeFromMap();
 */
export class VectorTileLayer {
    constructor(options = {}) {
        this.url = options.url;
        this.minZoom = options.minZoom ?? 0;
        this.maxZoom = options.maxZoom ?? Infinity;
        this.maxSourceZoom = options.maxSourceZoom ?? 14;
        this.lineWidthMultiplier = options.lineWidthMultiplier ?? 1.0;
        this.fillOpacity = options.fillOpacity ?? 1.0;
        this.depthTest = options.depthTest ?? false;
        this.visibleLayers = options.visibleLayers || null;

        this.buildings3d = options.buildings3d ?? true;
        this.buildings3dMinZoom = options.buildings3dMinZoom ?? 17;
        this.buildingEdges = options.buildingEdges ?? true;

        // Оптимизация подписей
        this.maxTextLabels = options.maxTextLabels ?? 500;
        this.maxTextPointsPerTile = options.maxTextPointsPerTile ?? 50;
        this.labelDistanceSortZoom = options.labelDistanceSortZoom ?? 17;
        this.labelMaxPerTileClose = options.labelMaxPerTileClose ?? 20;
        this.labelCullMargin = options.labelCullMargin ?? 50;

        this._debug = options.debug ?? false;
        this._discoveredClasses = new Map();

        this._styles = this._mergeStyles(DEFAULT_STYLES, options.styles || {});

        this._map = null;
        this._rootGroup = new THREE.Group();

        this._tileCache = new Map();
        this._pendingLoads = new Set();
        this._sortedLoadQueue = [];
        this._activeLoads = 0;
        this._maxConcurrent = 4;
        this._queueInterval = 250;

        this._lastSourceZoom = -1;
        this._lastDiscreteZoom = -1;
        this._lastUpdateTime = 0;
        this._throttle = 500;

        this._tileDataCache = new Map();
        this._oldTileGroups = null;
        this._oldTileCleanupTimer = null;
        this._groupCache = new Map();
        this._groupCacheMaxSize = 100;

        this._fillMaterialCache = new Map();
        this._lineMaterialCache = new Map();
        this._lineMaterialsSet = new Set();

        this._pointGeometryCache = new Map();

        this._lastCanvasSize = { width: 0, height: 0 };
        // Отслеживание перемещения мира для обновления подписей
        this._lastWorldPos = new THREE.Vector3();
        this._lastMovementTime = 0;
        this._lastLabelUpdateTime = 0;

        const rawScripts = options.workerScripts || ['https://cdn.mapengine.ru/KRB/js_TP/tpb.js', 'https://cdn.mapengine.ru/KRB/js_TP/earcut.js'];
        this._workerScriptUrls = rawScripts.map(s => {
            if (/^https?:\/\//i.test(s) || s.startsWith('/')) return s;
            try {
                return new URL(s, window.location.href).href;
            } catch (e) {
                console.error('Invalid worker script URL:', s, e);
                return s;
            }
        });
        if (this._workerScriptUrls.length < 2) {
            console.warn('VectorTileLayer: workerScripts должен содержать два URL (tpb.js и earcut.js).');
        }

        this._worker = null;
        this._workerReady = this._initWorker();
        this._requestId = 0;
        this._pendingWorkerRequests = new Map();
    }

    async _initWorker() {
        const [tpbUrl, earcutUrl] = this._workerScriptUrls;
        try {
            const [tpbResponse, earcutResponse] = await Promise.all([
                fetch(tpbUrl),
                fetch(earcutUrl)
            ]);
            const tpbCode = await tpbResponse.text();
            const earcutCode = await earcutResponse.text();

            const tpbDataURL = 'data:text/javascript;base64,' + stringToBase64(tpbCode);
            const earcutDataURL = 'data:text/javascript;base64,' + stringToBase64(earcutCode);

            const workerCode = createWorkerCode(tpbDataURL, earcutDataURL);
            const blob = new Blob([workerCode], { type: 'text/javascript' });
            this._worker = new Worker(URL.createObjectURL(blob), { type: 'module' });
            this._worker.onmessage = (e) => this._onWorkerMessage(e.data);
            this._worker.onerror = (err) => console.error('VectorTile worker error:', err);

            this._worker.postMessage({ type: 'config', styles: this._styles });
        } catch (err) {
            console.error('Failed to initialize worker:', err);
        }
    }

    _onWorkerMessage(data) {
        if (data.error) {
            const pending = this._pendingWorkerRequests.get(data.id);
            if (pending) {
                pending.reject(new Error(data.error));
                this._pendingWorkerRequests.delete(data.id);
            }
            return;
        }
        if (!data.result) return;
        const pending = this._pendingWorkerRequests.get(data.id);
        if (!pending) return;
        this._pendingWorkerRequests.delete(data.id);

        const result = data.result;
        const group = pending.group || new THREE.Group();
        this._buildGroupFromWorkerResult(group, result);
        if (!pending.group) {
            this._rootGroup.add(group);
            const key = pending.key;
            this._tileCache.set(key, group);
        }
        pending.resolve(group);
    }

    _buildGroupFromWorkerResult(group, result) {
        this._removeTextLabelsForGroup(group);

        while (group.children.length) {
            const child = group.children[0];
            if (child.geometry) child.geometry.dispose();
            if (child.material) {
                if (child.material.map) child.material.map.dispose();
                child.material.dispose();
            }
            group.remove(child);
        }

        for (const fill of result.fills) {
            const mat = this._getFillMaterialFromData(fill.layerName, fill.color, fill.opacity);
            const geom = new THREE.BufferGeometry();
            geom.setAttribute('position', new THREE.BufferAttribute(fill.positions, 3));
            if (fill.indices) geom.setIndex(new THREE.BufferAttribute(fill.indices, 1));
            const mesh = new THREE.Mesh(geom, mat);
            mesh.renderOrder = fill.renderOrder;
            group.add(mesh);
        }

        if (result.buildings.length > 0) {
            const byColor = new Map();
            for (const b of result.buildings) {
                const key = b.color;
                if (!byColor.has(key)) byColor.set(key, { color: b.color, stroke: b.stroke, pos: [], nrm: [], edg: [] });
                const g = byColor.get(key);
                g.pos.push(b.positions);
                g.nrm.push(b.normals);
                if (b.edgePositions) g.edg.push(b.edgePositions);
            }
            for (const g of byColor.values()) {
                const geom = new THREE.BufferGeometry();
                geom.setAttribute('position', new THREE.BufferAttribute(this._concatF32(g.pos), 3));
                geom.setAttribute('normal', new THREE.BufferAttribute(this._concatF32(g.nrm), 3));
                const mesh = new THREE.Mesh(geom, this._getBuildingMaterial(g.color));
                mesh.renderOrder = 50;
                group.add(mesh);

                if (this.buildingEdges && g.edg.length) {
  const eGeom = new THREE.BufferGeometry();
  eGeom.setAttribute('position', new THREE.BufferAttribute(this._concatF32(g.edg), 3));
  const lines = new THREE.LineSegments(eGeom, this._getBuildingEdgeMaterial(g.stroke || 0x555555));
  lines.renderOrder = 51;
  group.add(lines);
}
            }
        }

        for (const line of result.lines) {
            const mat = this._getLineMaterialFromData(line.layerName, line.color, line.width, line.dash);
            const lGeo = new LineGeometry();
            lGeo.setPositions(line.positions);
            const lineObj = new Line2(lGeo, mat);
            lineObj.renderOrder = line.renderOrder;
            lineObj.frustumCulled = false;
            group.add(lineObj);
        }

        for (const stroke of result.strokes) {
            const mat = this._getLineMaterialFromData(stroke.layerName, stroke.color, stroke.width);
            const lGeo = new LineGeometry();
            lGeo.setPositions(stroke.positions);
            const lineObj = new Line2(lGeo, mat);
            lineObj.renderOrder = stroke.renderOrder;
            lineObj.frustumCulled = false;
            group.add(lineObj);
        }

        for (const pt of result.points) {
            const fillKey = `fill:${pt.layerName}:${pt.color.toString(16)}:${pt.opacity}`;
            const mat = this._getFillMaterial(fillKey);
            const geometry = this._getPointGeometry(pt.radius);
            const mesh = new THREE.Mesh(geometry, mat);
            mesh.position.set(pt.x, 0, pt.z);
            mesh.renderOrder = pt.renderOrder;
            group.add(mesh);
        }

        group.userData.textPointsData = result.textPoints || [];
        this._createTextLabelsForGroup(group);

        group.userData.is3d = result.is3d;
    }

    /**
     * Пересоздаёт текстовые подписи для всех видимых тайлов из кэша.
     * Используется при панорамировании, чтобы обновить подписи без перестройки геометрии.
     *
     * @private
     */
    _refreshTextLabelsForVisibleTiles() {
        if (!this._map || !this._map.textManager) return;
        this._tileCache.forEach(group => {
            this._createTextLabelsForGroup(group);
        });
    }

    _createTextLabelsForGroup(group) {
        if (!this._map || !this._map.textManager) return;

        if (group.userData.textLabels) {
            this._removeTextLabelsForGroup(group);
        }
        group.userData.textLabels = [];

        const map = this._map;
        const textManager = map.textManager;
        const data = group.userData.textPointsData || [];

        if (!data.length) return;

        const continuousZoom = map.continuousZoom;
        const discreteZoom = map.currentDiscreteZoom;
        const camera = map.camera;
        const targetWorld = map.controls.target.clone();
        const worldOffset = map.worldGroup.position;
        const rect = map.renderer.domElement.getBoundingClientRect();
        const cullMargin = this.labelCullMargin ?? 50;

        const isClose = discreteZoom >= (this.labelDistanceSortZoom ?? 17);

        const candidates = [];

        for (const pt of data) {
            const zb = pt.zoomBounds || { min: 0, max: 24 };
            if (continuousZoom < zb.min || continuousZoom > zb.max) continue;

            const worldX = pt.x + worldOffset.x;
            const worldZ = pt.z + worldOffset.z;

            const dx = worldX - targetWorld.x;
            const dz = worldZ - targetWorld.z;
            const distSq = dx * dx + dz * dz;

            const worldPos = new THREE.Vector3(worldX, 0, worldZ);
            const ndc = worldPos.clone().project(camera);

            if (ndc.z > 1 || ndc.z < -1) continue;

            const sx = (ndc.x * 0.5 + 0.5) * rect.width;
            const sy = (-ndc.y * 0.5 + 0.5) * rect.height;

            if (
                sx < -cullMargin ||
                sx > rect.width + cullMargin ||
                sy < -cullMargin ||
                sy > rect.height + cullMargin
            ) {
                continue;
            }

            candidates.push({
                pt,
                distSq,
                priority: pt.priority || 0,
            });
        }

        if (isClose) {
            candidates.sort((a, b) => a.distSq - b.distSq || b.priority - a.priority);
        } else {
            candidates.sort((a, b) => b.priority - a.priority || a.distSq - b.distSq);
        }

        const maxPerTile = isClose
            ? Math.min(this.maxTextPointsPerTile, this.labelMaxPerTileClose ?? 20)
            : this.maxTextPointsPerTile;

        let finalData = candidates.slice(0, maxPerTile);

        if (textManager.labels && textManager.maxLabels !== undefined) {
            const currentCount = textManager.labels.length;
            const remaining = Math.max(0, this.maxTextLabels - currentCount);
            if (remaining <= 0) return;
            finalData = finalData.slice(0, Math.min(finalData.length, remaining));
        }

        for (const cand of finalData) {
            const pt = cand.pt;
            const source = new VectorPointLabelSource(map, pt.x, pt.z, pt.text, {
                textColor: pt.textColor,
                fontSize: pt.fontSize,
                fontFamily: pt.fontFamily,
                fontWeight: pt.fontWeight,
                textShadow: pt.textShadow,
                textOffset: pt.textOffset,
                textAlign: pt.textAlign,
                textVerticalAlign: pt.textVerticalAlign,
                priority: pt.priority,
                zoomBounds: pt.zoomBounds,
            });
            const label = textManager.addLabel(source);
            group.userData.textLabels.push(label);
        }
    }

    _removeTextLabelsForGroup(group) {
        if (group.userData.textLabels && this._map && this._map.textManager) {
            for (const label of group.userData.textLabels) {
                this._map.textManager.removeLabel(label);
            }
        }
        group.userData.textLabels = [];
    }

    _getFillMaterialFromData(layerName, color, opacity) {
        const key = `fill:${layerName}:${color.toString(16)}:${opacity}`;
        return this._getFillMaterial(key);
    }

    _getLineMaterialFromData(layerName, color, width, dash) {
        const dashKey = dash ? dash.join(',') : 'none';
        const key = `line:${layerName}:${color.toString(16)}:${width}:${dashKey}`;
        return this._getLineMaterial(key, dash);
    }

    // -------------------------------------------------------------------------
    // Публичные методы
    // -------------------------------------------------------------------------
    /**
     * Выводит в консоль список обнаруженных классов по слоям.
     *
     * @returns {void} Ничего не возвращает.
     */
    printDiscoveredClasses() {
        if (this._discoveredClasses.size === 0) {
            console.log('[VectorTileLayer] No classes discovered yet.');
            return;
        }
        console.log('[VectorTileLayer] Discovered classes:');
        this._discoveredClasses.forEach((classes, layer) => {
            console.log(`  ${layer}: [${Array.from(classes).join(', ')}]`);
        });
    }

    _mergeStyles(base, overrides) {
        const merged = JSON.parse(JSON.stringify(base));
        for (const [key, val] of Object.entries(overrides)) {
            if (val && typeof val === 'object' && !Array.isArray(val) && merged[key]) {
                merged[key] = this._mergeStyles(merged[key], val);
            } else {
                merged[key] = val;
            }
        }
        return merged;
    }

    /**
     * Добавляет слой на карту и подписывается на обновления.
     *
     * @param {Object} map - Объект карты, к которой добавляется слой.
     * @returns {VectorTileLayer} Текущий экземпляр слоя для цепочки вызовов.
     * @throws {Error} Если карта не содержит необходимых методов или свойств.
     */
    addTo(map) {
        if (this._map) this.removeFromMap();
        this._map = map;
        map.worldGroup.add(this._rootGroup);
        if (!map._dynamicLayers.includes(this)) map._dynamicLayers.push(this);

        if (map.textManager && map.textManager.setMaxLabels) {
            map.textManager.setMaxLabels(this.maxTextLabels);
        }

        return this;
    }

    /**
     * Удаляет слой с карты и освобождает все занятые ресурсы.
     *
     * @returns {void} Ничего не возвращает.
     */
    removeFromMap() {
        if (!this._map) return;
        this._clearAllTiles();
        this._rootGroup.parent?.remove(this._rootGroup);
        const idx = this._map._dynamicLayers.indexOf(this);
        if (idx > -1) this._map._dynamicLayers.splice(idx, 1);
        this._map = null;

        this._fillMaterialCache.forEach(m => m.dispose());
        this._lineMaterialCache.forEach(m => m.dispose());
        this._lineMaterialsSet.clear();
        this._fillMaterialCache.clear();
        this._lineMaterialCache.clear();
        this._pointGeometryCache.forEach(g => g.dispose());
        this._pointGeometryCache.clear();
        this._tileDataCache.clear();
        this._clearGroupCache();

        if (this._worker) {
            this._worker.terminate();
            this._worker = null;
        }
    }

    _clearAllTiles() {
        this._tileCache.forEach(group => this._disposeTile(group));
        this._tileCache.clear();
        this._pendingLoads.clear();
        this._sortedLoadQueue = [];
        this._clearOldTilesNow();
        this._activeLoads = 0;
    }

    _clearGroupCache() {
        this._groupCache.forEach(group => this._disposeTile(group));
        this._groupCache.clear();
    }

    _clearOldTilesNow() {
        if (this._oldTileCleanupTimer) {
            clearTimeout(this._oldTileCleanupTimer);
            this._oldTileCleanupTimer = null;
        }
        if (this._oldTileGroups) {
            this._oldTileGroups.forEach(group => this._disposeTile(group));
            this._oldTileGroups = null;
        }
    }

    _disposeTile(group) {
        this._removeTextLabelsForGroup(group);
        while (group.children.length) {
            const child = group.children[0];
            if (child.geometry) child.geometry.dispose();
            if (child.material) {
                if (child.material.map) child.material.map.dispose();
                child.material.dispose();
            }
            group.remove(child);
        }
        this._rootGroup.remove(group);
    }

    _removeTile(key, group) {
        this._rootGroup.remove(group);
        this._tileCache.delete(key);
        if (!this._groupCache.has(key)) {
            this._removeTextLabelsForGroup(group);
            this._groupCache.set(key, group);
            if (this._groupCache.size > this._groupCacheMaxSize) {
                const oldestKey = this._groupCache.keys().next().value;
                this._disposeTile(this._groupCache.get(oldestKey));
                this._groupCache.delete(oldestKey);
            }
        } else {
            this._disposeTile(group);
        }
    }

    _scheduleOldTilesCleanup(delay = 2000) {
        if (this._oldTileCleanupTimer) clearTimeout(this._oldTileCleanupTimer);
        this._oldTileCleanupTimer = setTimeout(() => {
            if (this._sortedLoadQueue.length > 0 || this._activeLoads > 0) {
                this._oldTileCleanupTimer = setTimeout(() => this._clearOldTilesNow(), 1000);
            } else {
                this._clearOldTilesNow();
            }
        }, delay);
    }

    _postUpdate(map) {
        if (!this._map) return;

        // Обновляем информацию о перемещении мира (легковесная проверка каждый кадр)
        const worldPos = map.worldGroup.position;
        if (this._lastWorldPos.distanceToSquared(worldPos) > 1) { // порог 1 метр
            this._lastWorldPos.copy(worldPos);
            this._lastMovementTime = performance.now();
        }

        const now = performance.now();
        if (now - this._lastUpdateTime < this._throttle) {
            this._processQueue();
            return;
        }
        this._lastUpdateTime = now;

        const discreteZoom = map.currentDiscreteZoom;
        if (discreteZoom < this.minZoom || discreteZoom > this.maxZoom) {
            if (this._tileCache.size > 0 || this._oldTileGroups) this._clearAllTiles();
            this._lastSourceZoom = -1;
            this._lastDiscreteZoom = -1;
            return;
        }

        if (this._lastDiscreteZoom !== -1 && discreteZoom !== this._lastDiscreteZoom) {
            const was3d = this._lastDiscreteZoom >= this.buildings3dMinZoom;
            const is3d = discreteZoom >= this.buildings3dMinZoom;
            if (was3d !== is3d) {
                this._lastSourceZoom = -1;
            }
        }
        this._lastDiscreteZoom = discreteZoom;

        const sourceZoom = Math.max(this.minZoom, Math.min(discreteZoom, this.maxSourceZoom));

        if (sourceZoom !== this._lastSourceZoom) {
            this._clearOldTilesNow();
            if (this._tileCache.size > 0) {
                this._oldTileGroups = new Map(this._tileCache);
                this._oldTileGroups.forEach(group => {
                    group.traverse(child => {
                        if (child.isMesh || child.isLine2) {
                            child.renderOrder = Math.max(0, (child.renderOrder || 0) - 2);
                        }
                    });
                });
            }
            this._tileCache = new Map();
            this._pendingLoads.clear();
            this._sortedLoadQueue = [];
            this._lastSourceZoom = sourceZoom;
            this._scheduleOldTilesCleanup(3000);
        }

        const canvas = map.renderer.domElement;
        const w = canvas.width, h = canvas.height;
        if (this._lineMaterialsSet.size > 0 &&
            (this._lastCanvasSize.width !== w || this._lastCanvasSize.height !== h)) {
            this._lastCanvasSize.width = w;
            this._lastCanvasSize.height = h;
            const res = new THREE.Vector2(w, h);
            this._lineMaterialsSet.forEach(mat => mat.resolution.copy(res));
        }

        const visibleTiles = this._getVisibleTileKeys(sourceZoom);

        for (const key of this._tileCache.keys()) {
            if (!visibleTiles.has(key)) {
                const group = this._tileCache.get(key);
                this._removeTile(key, group);
                this._pendingLoads.delete(key);
            }
        }

        // Пересоздание подписей, если мир перемещался
        const labelNow = performance.now();
        const timeSinceLastMove = labelNow - this._lastMovementTime;
        const isMoving = timeSinceLastMove < 1000; // движение было в последнюю секунду
        const periodicUpdateDue = isMoving && (labelNow - this._lastLabelUpdateTime > 1000); // раз в секунду при движении
        const settleUpdateDue = timeSinceLastMove > 300 && this._lastLabelUpdateTime < this._lastMovementTime; // после остановки (движение было)

        if ((settleUpdateDue || periodicUpdateDue) && this._tileCache.size > 0) {
            this._lastLabelUpdateTime = labelNow;
            this._refreshTextLabelsForVisibleTiles();
        }

        const maxMerc = map.MAX_MERCATOR;
        const target = map.controls.target;
        const tileSizeAtZoom = map.WORLD_SIZE / (1 << sourceZoom);

        const newKeys = Array.from(visibleTiles)
            .filter(key => !this._tileCache.has(key) && !this._pendingLoads.has(key))
            .sort((a, b) => {
                const [, xa, ya] = a.split(',').map(Number);
                const [, xb, yb] = b.split(',').map(Number);
                const cxa = xa * tileSizeAtZoom - maxMerc + tileSizeAtZoom / 2;
                const cza = -maxMerc + ya * tileSizeAtZoom + tileSizeAtZoom / 2;
                const cxb = xb * tileSizeAtZoom - maxMerc + tileSizeAtZoom / 2;
                const czb = -maxMerc + yb * tileSizeAtZoom + tileSizeAtZoom / 2;
                const dax = cxa - target.x, daz = cza - target.z;
                const dbx = cxb - target.x, dbz = czb - target.z;
                return (dax * dax + daz * daz) - (dbx * dbx + dbz * dbz);
            });

        this._sortedLoadQueue = newKeys.concat(
            this._sortedLoadQueue.filter(k =>
                !this._tileCache.has(k) && !this._pendingLoads.has(k) && visibleTiles.has(k)
            )
        );
        this._processQueue();
    }

    _processQueue() {
        if (this._activeLoads >= this._maxConcurrent) return;
        if (this._sortedLoadQueue.length === 0) {
            if (this._oldTileGroups && this._activeLoads === 0) this._scheduleOldTilesCleanup(500);
            return;
        }
        const toLoad = this._sortedLoadQueue.splice(0, this._maxConcurrent - this._activeLoads);
        toLoad.forEach(key => {
            const [z, x, y] = key.split(',').map(Number);
            this._loadTile(z, x, y);
        });
        if (this._sortedLoadQueue.length > 0) {
            clearTimeout(this._queueTimer);
            this._queueTimer = setTimeout(() => this._processQueue(), this._queueInterval);
        }
    }

    async _loadTile(z, xSlippy, ySlippy) {
        const key = `${z},${xSlippy},${ySlippy}`;
        if (this._pendingLoads.has(key) || this._tileCache.has(key)) return;

        if (this._groupCache.has(key)) {
            const group = this._groupCache.get(key);
            this._groupCache.delete(key);
            const is3dNow = this.buildings3d && (this._map?.currentDiscreteZoom ?? 0) >= this.buildings3dMinZoom;
            if (group.userData.is3d !== is3dNow) {
                const dataCacheKey = `${z}/${xSlippy}/${ySlippy}`;
                const buffer = this._tileDataCache.get(dataCacheKey);
                if (buffer) {
                    this._pendingLoads.add(key);
                    this._activeLoads++;
                    try {
                        await this._sendToWorker(buffer.slice(0), z, xSlippy, ySlippy, is3dNow, group);
                        this._rootGroup.add(group);
                        this._tileCache.set(key, group);
                    } finally {
                        this._pendingLoads.delete(key);
                        this._activeLoads--;
                        this._processQueue();
                    }
                    return;
                }
                this._disposeTile(group);
            } else {
                this._rootGroup.add(group);
                this._tileCache.set(key, group);
                this._createTextLabelsForGroup(group);
                return;
            }
        }

        this._pendingLoads.add(key);
        this._activeLoads++;
        const dataCacheKey = `${z}/${xSlippy}/${ySlippy}`;
        try {
            let buffer;
            if (this._tileDataCache.has(dataCacheKey)) {
                buffer = this._tileDataCache.get(dataCacheKey).slice(0);
            } else {
                const url = this.url.replace('{z}', z).replace('{x}', xSlippy).replace('{y}', ySlippy);
                const response = await fetch(url);
                if (!response.ok) throw new Error(`HTTP ${response.status}`);
                buffer = await response.arrayBuffer();
                this._tileDataCache.set(dataCacheKey, buffer.slice(0));
            }

            const is3dNow = this.buildings3d && (this._map?.currentDiscreteZoom ?? 0) >= this.buildings3dMinZoom;
            const group = await this._sendToWorker(buffer, z, xSlippy, ySlippy, is3dNow);
            this._rootGroup.add(group);
            this._tileCache.set(key, group);
        } catch (err) {
            // игнорируем ошибки загрузки
        } finally {
            this._pendingLoads.delete(key);
            this._activeLoads--;
            if (this._sortedLoadQueue.length > 0) {
                clearTimeout(this._queueTimer);
                this._queueTimer = setTimeout(() => this._processQueue(), this._queueInterval);
            } else if (this._activeLoads === 0 && this._oldTileGroups) {
                this._clearOldTilesNow();
            }
        }
    }

    async _sendToWorker(buffer, z, x, y, is3d, existingGroup) {
        await this._workerReady;
        return new Promise((resolve, reject) => {
            const id = ++this._requestId;
            const tileSize = this._map.WORLD_SIZE / (1 << z);
            const maxMerc = this._map.MAX_MERCATOR;

            const msg = {
                type: 'process',
                id,
                buffer: buffer,
                z, x, y,
                tileSize,
                maxMerc,
                is3d,
                visibleLayers: this.visibleLayers,
                buildings3dMinZoom: this.buildings3dMinZoom,
                buildingEdges: this.buildingEdges
            };

            this._pendingWorkerRequests.set(id, {
                resolve,
                reject,
                group: existingGroup || null,
                key: existingGroup ? null : `${z},${x},${y}`,
            });
            this._worker.postMessage(msg, [buffer]);
        });
    }

    _getVisibleTileKeys(z) {
        const map = this._map;
        const camera = map.camera;
        const target = map.controls.target;
        const distance = camera.position.distanceTo(target);
        const tileSize = map.WORLD_SIZE / (1 << z);
        const margin = 1;
        const vFov = camera.fov * Math.PI / 180;
        const aspect = camera.aspect;
        const hh = distance * Math.tan(vFov / 2) * aspect + margin * tileSize;
        const hv = distance * Math.tan(vFov / 2) + margin * tileSize;
        const off = map.worldGroup.position;
        const minX = target.x - hh, maxX = target.x + hh;
        const minZ = target.z - hv, maxZ = target.z + hv;
        const maxTile = (1 << z) - 1;
        const numTiles = 1 << z;
        const xMin = Math.floor((minX - off.x + map.MAX_MERCATOR) / tileSize);
        const xMax = Math.floor((maxX - off.x + map.MAX_MERCATOR) / tileSize);
        const yMin = Math.max(0, Math.floor((minZ - off.z + map.MAX_MERCATOR) / tileSize));
        const yMax = Math.min(maxTile, Math.floor((maxZ - off.z + map.MAX_MERCATOR) / tileSize));
        const keys = new Set();
        for (let y = yMin; y <= yMax; y++) {
            for (let x = xMin; x <= xMax; x++) {
                keys.add(`${z},${((x % numTiles) + numTiles) % numTiles},${y}`);
            }
        }
        return keys;
    }

    // -------------------------------------------------------------------------
    // Кеширование материалов
    // -------------------------------------------------------------------------
    _getFillMaterial(styleKey) {
        if (this._fillMaterialCache.has(styleKey)) return this._fillMaterialCache.get(styleKey);
        const parts = styleKey.split(':');
        const color = parseInt(parts[2], 16);
        const opacity = parseFloat(parts[3]) * this.fillOpacity;
        const mat = new THREE.MeshBasicMaterial({
            color,
            side: THREE.DoubleSide,
            transparent: opacity < 1,
            opacity,
            depthTest: true,
            depthWrite: false
        });
        this._fillMaterialCache.set(styleKey, mat);
        return mat;
    }

    _getLineMaterial(styleKey, dash) {
        if (this._lineMaterialCache.has(styleKey)) return this._lineMaterialCache.get(styleKey);
        const parts = styleKey.split(':');
        const color = parseInt(parts[2], 16);
        const width = parseFloat(parts[3]) * this.lineWidthMultiplier;
        const matOpts = {
            color,
            linewidth: width,
            resolution: new THREE.Vector2(
                this._map.renderer.domElement.width,
                this._map.renderer.domElement.height
            ),
            depthTest: true,
            depthWrite: false
        };
        if (dash && Array.isArray(dash) && dash.length >= 2) {
            matOpts.dashed = true;
            matOpts.dashSize = dash[0];
            matOpts.gapSize = dash[1];
            matOpts.dashScale = 1;
        }
        const mat = new LineMaterial(matOpts);
        this._lineMaterialCache.set(styleKey, mat);
        this._lineMaterialsSet.add(mat);
        return mat;
    }

    _getPointGeometry(radius) {
        const key = `point_${radius}`;
        if (this._pointGeometryCache.has(key)) return this._pointGeometryCache.get(key);
        const geom = new THREE.CircleGeometry(radius, 8);
        geom.rotateX(-Math.PI / 2);
        this._pointGeometryCache.set(key, geom);
        return geom;
    }

    _concatF32(arrays) {
        let total = 0;
        for (const a of arrays) total += a.length;
        const out = new Float32Array(total);
        let off = 0;
        for (const a of arrays) { out.set(a, off); off += a.length; }
        return out;
    }

    _getBuildingMaterial(color) {
    const key = 'bld:' + color;
    if (this._fillMaterialCache.has(key)) return this._fillMaterialCache.get(key);

    const mat = new THREE.MeshLambertMaterial({
        color,
        side: THREE.FrontSide, // вместо THREE.DoubleSide
        depthTest: true,
        depthWrite: true,
        polygonOffset: true,
        polygonOffsetFactor: 1,
        polygonOffsetUnits: 1
    });

    this._fillMaterialCache.set(key, mat);
    return mat;
}

    _getBuildingEdgeMaterial(color) {
        const key = 'bldEdge:' + color;
        if (this._lineMaterialCache.has(key)) return this._lineMaterialCache.get(key);
        const mat = new THREE.LineBasicMaterial({ color, depthTest: true, depthWrite: false });
        this._lineMaterialCache.set(key, mat);
        return mat;
    }
}
