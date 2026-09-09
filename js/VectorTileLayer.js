//VectorTileLayer.js
/**
 * Модуль слоя векторных тайлов (объёмные здания с выделением острых рёбер).
 * Основная логика управления тайлами, материалами и подписями.
 * Поддержка исключения областей для скрытия заданных слоёв.
 */

import {
  THREE,
  Line2,
  LineMaterial,
  LineGeometry,
} from '../js_TP/tpb.js';
import { DEFAULT_STYLES } from './vectorTileDefaults.js';
import { stringToBase64, createWorkerCode } from './vectorTileWorkerCode.js';
import { proj } from './Utils.js';

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
 * Поддерживает добавление областей исключения для скрытия выбранных слоёв.
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
 * layer.addExclusionArea(geojson, ['building']);
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

        // Исключения областей
        this._exclusionMasks = [];

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

        // Применяем исключения только после добавления группы в сцену
        if (!pending.group) {
            this._rootGroup.add(group);
            const key = pending.key;
            this._tileCache.set(key, group);
            this._applyExclusionsToGroup(group);
        }
        pending.resolve(group);
    }

    _buildGroupFromWorkerResult(group, result) {
        this._removeTextLabelsForGroup(group);

        // Устанавливаем позицию группы в абсолютный центр тайла
        if (result.centerX !== undefined && result.centerZ !== undefined) {
            group.position.set(result.centerX, 0, result.centerZ);
        }

        while (group.children.length) {
            const child = group.children[0];
            if (child.geometry) child.geometry.dispose();
            if (child.material) {
                if (child.material.map) child.material.map.dispose();
                child.material.dispose();
            }
            group.remove(child);
        }

        // Обычные заливки (кроме зданий)
        for (const fill of result.fills) {
            const mat = this._getFillMaterialFromData(fill.layerName, fill.color, fill.opacity);
            const geom = new THREE.BufferGeometry();
            geom.setAttribute('position', new THREE.BufferAttribute(fill.positions, 3));
            if (fill.indices) geom.setIndex(new THREE.BufferAttribute(fill.indices, 1));
            const mesh = new THREE.Mesh(geom, mat);
            mesh.renderOrder = fill.renderOrder;
            mesh.userData.layerName = fill.layerName;
            group.add(mesh);
        }

        // Плоские здания (если воркер их вернул отдельно)
        if (result.flatBuildings && result.flatBuildings.length > 0) {
            for (const b of result.flatBuildings) {
                const mat = this._getFillMaterialFromData('building', b.color, b.opacity ?? 1);
                const geom = new THREE.BufferGeometry();
                geom.setAttribute('position', new THREE.BufferAttribute(b.positions, 3));
                if (b.indices) geom.setIndex(new THREE.BufferAttribute(b.indices, 1));
                const mesh = new THREE.Mesh(geom, mat);
                mesh.renderOrder = b.renderOrder ?? 7;
                mesh.userData.layerName = 'building';
                group.add(mesh);
            }
        }

        // 3D-здания – каждое отдельным мешем
        if (result.buildings.length > 0) {
            for (const b of result.buildings) {
                const geom = new THREE.BufferGeometry();
                geom.setAttribute('position', new THREE.BufferAttribute(b.positions, 3));
                geom.setAttribute('normal', new THREE.BufferAttribute(b.normals, 3));
                const mesh = new THREE.Mesh(geom, this._getBuildingMaterial(b.color));
                mesh.renderOrder = 50;
                mesh.userData.layerName = 'building';
                group.add(mesh);

                if (this.buildingEdges && b.edgePositions) {
                    const eGeom = new THREE.BufferGeometry();
                    eGeom.setAttribute('position', new THREE.BufferAttribute(b.edgePositions, 3));
                    const lines = new THREE.LineSegments(eGeom, this._getBuildingEdgeMaterial(b.stroke || 0x555555));
                    lines.renderOrder = 51;
                    lines.userData.layerName = 'building';
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
            lineObj.userData.layerName = line.layerName;
            group.add(lineObj);
        }

        for (const stroke of result.strokes) {
            const mat = this._getLineMaterialFromData(stroke.layerName, stroke.color, stroke.width);
            const lGeo = new LineGeometry();
            lGeo.setPositions(stroke.positions);
            const lineObj = new Line2(lGeo, mat);
            lineObj.renderOrder = stroke.renderOrder;
            lineObj.frustumCulled = false;
            lineObj.userData.layerName = stroke.layerName;
            group.add(lineObj);
        }

        for (const pt of result.points) {
            const fillKey = `fill:${pt.layerName}:${pt.color.toString(16)}:${pt.opacity}`;
            const mat = this._getFillMaterial(fillKey);
            const geometry = this._getPointGeometry(pt.radius);
            const mesh = new THREE.Mesh(geometry, mat);
            mesh.position.set(pt.x, 0, pt.z);
            mesh.renderOrder = pt.renderOrder;
            mesh.userData.layerName = pt.layerName;
            group.add(mesh);
        }

        group.userData.textPointsData = result.textPoints || [];
        this._createTextLabelsForGroup(group);

        group.userData.is3d = result.is3d;
    }

    // ... (остальные методы без изменений, кроме добавленных ниже) ...

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
        // ... без изменений ...
    }

    _removeTextLabelsForGroup(group) {
        // ... без изменений ...
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

    /**
     * Добавляет область исключения: в этой области не будут отображаться указанные слои.
     *
     * @param {Object} geojson - GeoJSON объект (Feature или FeatureCollection) с геометрией типа Polygon или MultiPolygon.
     * @param {Array<string>} [layers=['building']] - Массив имён слоёв, которые нужно скрыть.
     * @returns {void}
     * @example
     * layer.addExclusionArea({
     *     type: 'Feature',
     *     geometry: {
     *         type: 'Polygon',
     *         coordinates: [[[37.6, 55.7], [37.7, 55.7], [37.7, 55.8], [37.6, 55.8], [37.6, 55.7]]]
     *     }
     * }, ['building']);
     */
    addExclusionArea(geojson, layers = ['building']) {
        // Если передан FeatureCollection, обрабатываем каждую фичу
        if (geojson && geojson.type === 'FeatureCollection' && Array.isArray(geojson.features)) {
            geojson.features.forEach(feature => this.addExclusionArea(feature, layers));
            return;
        }

        if (!geojson || !geojson.geometry || !geojson.geometry.type) {
            console.warn('Invalid GeoJSON for exclusion area');
            return;
        }

        const geometry = geojson.geometry;
        const polygons = [];
        const coords = geometry.type === 'Polygon' ? [geometry.coordinates] : geometry.coordinates;

        for (const polygon of coords) {
            const rings = polygon.map(ring =>
                ring.map(coord => {
                    const [x, z] = proj.fromLonLat(coord);
                    return { x, z };
                })
            );
            polygons.push(rings);
        }

        this._exclusionMasks.push({
            polygons,
            layers: new Set(layers)
        });

        this._applyExclusionsToAllTiles();
    }

    /**
     * Удаляет все области исключения.
     *
     * @returns {void}
     */
    clearExclusionAreas() {
        this._exclusionMasks = [];
        this._applyExclusionsToAllTiles();
    }

    // -------------------------------------------------------------------------
    // Приватные методы для работы с исключениями
    // -------------------------------------------------------------------------
    /**
     * Применяет все маски исключений ко всем загруженным тайлам.
     * @private
     */
    _applyExclusionsToAllTiles() {
        this._tileCache.forEach(group => this._applyExclusionsToGroup(group));
    }

    /**
     * Применяет маски исключений к конкретной группе тайла.
     * @param {THREE.Group} group - Группа тайла.
     * @private
     */
    _applyExclusionsToGroup(group) {
        if (!group) return;
        group.children.forEach(child => {
            if (!child.userData || !child.userData.layerName) {
                child.visible = true;
                return;
            }

            const layerName = child.userData.layerName;
            let shouldHide = false;

            for (const mask of this._exclusionMasks) {
                if (mask.layers.has(layerName) && this._geometryIntersectsAnyPolygon(child, mask.polygons)) {
                    shouldHide = true;
                    break;
                }
            }

            child.visible = !shouldHide;
        });
    }

    /**
     * Проверяет, пересекается ли геометрия объекта с хотя бы одним полигоном.
     * Учитывает сдвиг мира (worldGroup.position) и преобразует bounding box объекта в мировые координаты.
     * @param {THREE.Object3D} object - Объект с геометрией.
     * @param {Array} polygons - Массив полигонов (каждый полигон - массив колец).
     * @returns {boolean} True, если есть пересечение.
     * @private
     */
    _geometryIntersectsAnyPolygon(object, polygons) {
        if (!object.geometry) return false;
        const geom = object.geometry;
        if (!geom.boundingBox) geom.computeBoundingBox();
        const localBBox = geom.boundingBox;
        if (!localBBox) return false;

        // Получаем мировую матрицу объекта
        object.updateWorldMatrix(true, false);
        const matrix = object.matrixWorld;

        // Углы локального AABB
        const corners = [
            new THREE.Vector3(localBBox.min.x, localBBox.min.y, localBBox.min.z),
            new THREE.Vector3(localBBox.min.x, localBBox.min.y, localBBox.max.z),
            new THREE.Vector3(localBBox.min.x, localBBox.max.y, localBBox.min.z),
            new THREE.Vector3(localBBox.min.x, localBBox.max.y, localBBox.max.z),
            new THREE.Vector3(localBBox.max.x, localBBox.min.y, localBBox.min.z),
            new THREE.Vector3(localBBox.max.x, localBBox.min.y, localBBox.max.z),
            new THREE.Vector3(localBBox.max.x, localBBox.max.y, localBBox.min.z),
            new THREE.Vector3(localBBox.max.x, localBBox.max.y, localBBox.max.z)
        ];

        let minX = Infinity, minZ = Infinity, maxX = -Infinity, maxZ = -Infinity;
        for (const corner of corners) {
            corner.applyMatrix4(matrix);
            if (corner.x < minX) minX = corner.x;
            if (corner.x > maxX) maxX = corner.x;
            if (corner.z < minZ) minZ = corner.z;
            if (corner.z > maxZ) maxZ = corner.z;
        }

        // Приводим к базовой системе координат (вычитаем сдвиг мира)
        const worldOffset = this._map ? this._map.worldGroup.position : new THREE.Vector3();
        const shiftedBBox = {
            min: { x: minX - worldOffset.x, z: minZ - worldOffset.z },
            max: { x: maxX - worldOffset.x, z: maxZ - worldOffset.z }
        };

        for (const rings of polygons) {
            if (this._aabbIntersectsPolygon(shiftedBBox, rings)) {
                return true;
            }
        }
        return false;
    }

    /**
     * Проверяет пересечение AABB с полигоном (грубо, но с учётом пересечения рёбер).
     * @param {Object} aabb - Ограничивающий параллелепипед { min: {x,z}, max: {x,z} }.
     * @param {Array} rings - Массив колец полигона.
     * @returns {boolean} True, если есть пересечение.
     * @private
     */
    _aabbIntersectsPolygon(aabb, rings) {
        const polyBBox = this._computePolygonBBox(rings);
        if (!polyBBox) return false;

        // Быстрая отсечка по общему ограничивающему прямоугольнику
        if (aabb.max.x < polyBBox.minX || aabb.min.x > polyBBox.maxX ||
            aabb.max.z < polyBBox.minZ || aabb.min.z > polyBBox.maxZ) {
            return false;
        }

        // Проверяем вершины полигона внутри AABB
        for (const ring of rings) {
            for (const p of ring) {
                if (p.x >= aabb.min.x && p.x <= aabb.max.x && p.z >= aabb.min.z && p.z <= aabb.max.z) {
                    return true;
                }
            }
        }

        // Проверяем вершины AABB внутри полигона
        const corners = [
            { x: aabb.min.x, z: aabb.min.z },
            { x: aabb.min.x, z: aabb.max.z },
            { x: aabb.max.x, z: aabb.min.z },
            { x: aabb.max.x, z: aabb.max.z }
        ];

        for (const corner of corners) {
            if (this._isPointInPolygon(corner, rings)) {
                return true;
            }
        }

        // Дополнительно: проверяем пересечение рёбер AABB с рёбрами полигона
        const aabbEdges = [
            [{ x: aabb.min.x, z: aabb.min.z }, { x: aabb.max.x, z: aabb.min.z }],
            [{ x: aabb.max.x, z: aabb.min.z }, { x: aabb.max.x, z: aabb.max.z }],
            [{ x: aabb.max.x, z: aabb.max.z }, { x: aabb.min.x, z: aabb.max.z }],
            [{ x: aabb.min.x, z: aabb.max.z }, { x: aabb.min.x, z: aabb.min.z }]
        ];

        for (const ring of rings) {
            for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
                const polyEdge1 = ring[j];
                const polyEdge2 = ring[i];
                for (const [a1, a2] of aabbEdges) {
                    if (this._segmentsIntersect(a1, a2, polyEdge1, polyEdge2)) {
                        return true;
                    }
                }
            }
        }

        return false;
    }

    /**
     * Проверяет пересечение двух отрезков (на плоскости XZ).
     * @param {{x:number,z:number}} p1 - Начало первого отрезка.
     * @param {{x:number,z:number}} p2 - Конец первого отрезка.
     * @param {{x:number,z:number}} p3 - Начало второго отрезка.
     * @param {{x:number,z:number}} p4 - Конец второго отрезка.
     * @returns {boolean} True, если отрезки пересекаются (включая коллинеарные случаи).
     * @private
     */
    _segmentsIntersect(p1, p2, p3, p4) {
        const d1 = this._cross(p2, p3, p1);
        const d2 = this._cross(p2, p4, p1);
        const d3 = this._cross(p4, p1, p3);
        const d4 = this._cross(p4, p2, p3);

        if (((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) &&
            ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0))) {
            return true;
        }

        // Коллинеарные случаи
        if (d1 === 0 && this._onSegment(p3, p1, p2)) return true;
        if (d2 === 0 && this._onSegment(p4, p1, p2)) return true;
        if (d3 === 0 && this._onSegment(p1, p3, p4)) return true;
        if (d4 === 0 && this._onSegment(p2, p3, p4)) return true;
        return false;
    }

    /**
     * Векторное произведение для определения ориентации.
     * @private
     */
    _cross(a, b, c) {
        return (b.x - a.x) * (c.z - a.z) - (b.z - a.z) * (c.x - a.x);
    }

    /**
     * Проверяет, лежит ли точка p на отрезке ab (включая концы).
     * @private
     */
    _onSegment(p, a, b) {
        return Math.min(a.x, b.x) <= p.x && p.x <= Math.max(a.x, b.x) &&
               Math.min(a.z, b.z) <= p.z && p.z <= Math.max(a.z, b.z);
    }

    /**
     * Вычисляет ограничивающий прямоугольник полигона.
     * @param {Array} rings - Массив колец.
     * @returns {{minX: number, minZ: number, maxX: number, maxZ: number}|null}
     * @private
     */
    _computePolygonBBox(rings) {
        if (!rings.length || !rings[0].length) return null;
        let minX = Infinity, minZ = Infinity, maxX = -Infinity, maxZ = -Infinity;
        for (const ring of rings) {
            for (const p of ring) {
                if (p.x < minX) minX = p.x;
                if (p.x > maxX) maxX = p.x;
                if (p.z < minZ) minZ = p.z;
                if (p.z > maxZ) maxZ = p.z;
            }
        }
        return { minX, minZ, maxX, maxZ };
    }

    /**
     * Проверяет, находится ли точка внутри полигона (с учётом дырок).
     * @param {{x:number, z:number}} point - Точка.
     * @param {Array} rings - Массив колец, где первое кольцо внешнее.
     * @returns {boolean}
     * @private
     */
    _isPointInPolygon(point, rings) {
        const [outer, ...holes] = rings;
        if (!this._isPointInRing(point, outer)) return false;
        for (const hole of holes) {
            if (this._isPointInRing(point, hole)) return false;
        }
        return true;
    }

    /**
     * Проверяет, находится ли точка внутри кольца (алгоритм ray casting).
     * @param {{x:number, z:number}} point - Точка.
     * @param {Array<{x:number, z:number}>} ring - Кольцо.
     * @returns {boolean}
     * @private
     */
    _isPointInRing(point, ring) {
        let inside = false;
        for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
            const xi = ring[i].x, zi = ring[i].z;
            const xj = ring[j].x, zj = ring[j].z;
            const intersect = ((zi > point.z) !== (zj > point.z)) &&
                (point.x < (xj - xi) * (point.z - zi) / (zj - zi) + xi);
            if (intersect) inside = !inside;
        }
        return inside;
    }

    // -------------------------------------------------------------------------
    // Остальные приватные методы (управление тайлами и ресурсами)
    // -------------------------------------------------------------------------
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
                        // Применяем исключения после добавления в сцену
                        this._applyExclusionsToGroup(group);
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
                this._applyExclusionsToGroup(group); // применяем исключения после добавления из кэша
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
            // Применяем исключения после добавления в сцену
            this._applyExclusionsToGroup(group);
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