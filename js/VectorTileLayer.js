// VectorTileLayer.js
/**
 * Модуль слоя векторных тайлов (объёмные здания с выделением острых рёбер).
 * Основная логика управления тайлами, материалами и подписями.
 *
 * ВАЖНО: Three.js не наследует `Group.renderOrder` по дереву сцены —
 * каждая промежуточная Group при обходе сбрасывает унаследованный
 * `groupOrder` в своё значение `renderOrder`. Все группы векторного слоя
 * явно помечаются большим `renderOrder` (`_tileGroupRenderOrder`),
 * иначе линии/заливки получат `groupOrder = 0` и будут перекрыты
 * растровыми тайлами (у которых `renderOrder = z`, 18+).
 *
 * ПРОЕКЦИИ: слой работает в метрах проекции карты (`map.projection`).
 * Координаты GeoJSON для exclusion-областей задаются в системе координат
 * `options.crs` (по умолчанию `map.inputCRS` = WGS84) и преобразуются
 * в метры через {@link KrbMap#project}.
 */

import {
  THREE,
  Line2,
  LineMaterial,
  LineGeometry,
} from '../js_TP/tpb.js';
import { DEFAULT_STYLES } from './vectorTileDefaults.js';
import { stringToBase64, createWorkerCode } from './vectorTileWorkerCode.js';
import { Projections } from './Projections.js';

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

export const VECTOR_TILE_RENDER_ORDER = {
    FILL:     10,
    LINE:     20,
    STROKE:   25,
    POINT:    30,
    BUILDING: 50,
    EDGE:     51
};

// -----------------------------------------------------------------------------
// Основной класс
// -----------------------------------------------------------------------------
/**
 * Класс слоя векторных тайлов с поддержкой 3D-зданий и выделением острых рёбер.
 * Управляет загрузкой, кешированием и отображением тайлов, материалов и подписей.
 *
 * @param {Object} options - Объект с настройками слоя.
 * @property {string} options.url - URL шаблона тайлов с плейсхолдерами {z}, {x}, {y}.
 * @property {string} [options.crs] - Код системы координат для GeoJSON-координат,
 *   передаваемых в `addExclusionArea`. Если не указан — используется `map.inputCRS`
 *   (по умолчанию EPSG:4326 = WGS84).
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
 * @property {number} [options.tileDataCacheMaxSize=200] - Максимум сырых PBF-буферов в LRU-кэше.
 * @property {number} [options.tileGroupRenderOrder=1000000] - renderOrder для tileGroup
 *   (КРИТИЧНО, см. описание модуля). Только если понимаешь, что делаешь.
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
 * layer.addTo(map);
 * layer.addExclusionArea(geojsonExclusion, ['water', 'landcover']);
 * layer.removeFromMap();
 */
export class VectorTileLayer {
    constructor(options = {}) {
        this.url = options.url;

        /**
         * Код СК для GeoJSON-координат exclusion-областей.
         * null — использовать `map.inputCRS` (по умолчанию WGS84).
         * @private
         * @type {string|null}
         */
        this._crsCode = options.crs ?? null;
        /**
         * Зарезолвленный объект Projection. Устанавливается в `addTo`.
         * @private
         * @type {import('./Projections.js').Projection|null}
         */
        this._crs = null;

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

        this._styles = this._mergeStyles(DEFAULT_STYLES, options.styles || {});

        // =====================================================================
        // КРИТИЧНО: renderOrder для Group.
        //
        // Three.js при обходе сцены НЕ наследует groupOrder через промежуточные
        // Group — каждая Group сбрасывает унаследованный groupOrder в своё
        // значение renderOrder. Если у tileGroup (промежуточной) renderOrder
        // остаётся 0 (по умолчанию), все её дети (Line2, Mesh) получают
        // groupOrder = 0 — ту же категорию, что и растровые тайлы
        // (у них renderOrder = z = 18+). Тогда painterSortStable сравнивает
        // только их собственные renderOrder: line (15) < raster (18) →
        // растровый тайл рисуется ПОСЛЕ и перекрывает линии.
        //
        // Выставление большого renderOrder на tileGroup сдвигает groupOrder
        // всех её детей выше растра, и они рисуются поверх независимо от
        // их индивидуального renderOrder.
        // =====================================================================
        this._tileGroupRenderOrder = options.tileGroupRenderOrder ?? 1_000_000;

        this._map = null;
        this._rootGroup = new THREE.Group();

        this._tileCache = new Map();
        this._pendingLoads = new Set();
        this._sortedLoadQueue = [];
        this._activeLoads = 0;
        this._maxConcurrent = 4;
        this._queueInterval = 250;
        this._queueTimer = null;

        this._lastSourceZoom = -1;
        this._lastDiscreteZoom = -1;
        this._lastUpdateTime = 0;
        this._throttle = 500;

        // Счётчик «поколения» загрузок. Увеличивается при любой инвалидации
        // кэша тайлов (смена sourceZoom, clearAllTiles, invalidateAllTiles).
        // Ответы воркера, полученные с устаревшим generation, утилизируются.
        this._generation = 0;

        // LRU-кэш сырых PBF-буферов. Ограничен по количеству тайлов.
        this._tileDataCache = new Map();
        this._tileDataCacheMaxSize = options.tileDataCacheMaxSize ?? 200;

        this._oldTileGroups = null;
        this._oldTileCleanupTimer = null;
        this._groupCache = new Map();
        this._groupCacheMaxSize = 100;

        this._fillMaterialCache = new Map();
        this._lineMaterialCache = new Map();
        this._lineMaterialsSet = new Set();

        this._pointGeometryCache = new Map();

        // Exclusion areas
        this._exclusionAreas = [];
        this._exclusionLayers = new Set();

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

    /**
     * Обрабатывает сообщение от воркера.
     * Проверяет актуальность полученного результата по generation.
     *
     * @private
     * @param {Object} data - Данные сообщения.
     */
    _onWorkerMessage(data) {
        if (!data || typeof data.id === 'undefined') return;

        const pending = this._pendingWorkerRequests.get(data.id);
        if (!pending) return;
        this._pendingWorkerRequests.delete(data.id);

        if (data.error) {
            pending.reject(new Error(data.error));
            return;
        }

        if (!data.result) {
            pending.reject(new Error('Worker returned no result'));
            return;
        }

        // Устаревший ответ — утилизируем без добавления в сцену.
        if (pending.generation !== this._generation) {
            if (pending.group) {
                this._disposeTile(pending.group);
            }
            pending.resolve(null);
            return;
        }

        const result = data.result;
        const group = pending.group || new THREE.Group();
        try {
            this._buildGroupFromWorkerResult(group, result);
        } catch (err) {
            console.error('[VectorTileLayer] Failed to build tile group:', err);
            this._disposeTile(group);
            pending.reject(err);
            return;
        }

        if (!pending.group) {
            this._rootGroup.add(group);
            const key = pending.key;
            const existing = this._tileCache.get(key);
            if (existing && existing !== group) this._disposeTile(existing);
            this._tileCache.set(key, group);
        }
        pending.resolve(group);
    }

    /**
     * Строит Three.js-группу тайла из результата воркера.
     *
     * @private
     * @param {THREE.Group} group - Целевая группа.
     * @param {Object} result - Результат обработки воркера.
     */
    _buildGroupFromWorkerResult(group, result) {
        this._removeTextLabelsForGroup(group);

        // =====================================================================
        // КРИТИЧНО: renderOrder для tileGroup.
        //
        // Three.js при обходе сцены НЕ наследует groupOrder через промежуточные
        // Group — каждая Group сбрасывает унаследованный groupOrder в своё
        // значение renderOrder. Если здесь НЕ выставить renderOrder, он
        // останется 0 (по умолчанию), и все дети этой группы получат
        // groupOrder = 0 — тот же, что у растровых тайлов (renderOrder = z = 18+).
        // В результате растр рисуется ПОСЛЕ линий и перекрывает их.
        //
        // НЕ УДАЛЯТЬ. Отсутствие этой строки = линии не видны ближе к камере
        // (там, где растр перекрывает периферию). См. описание модуля.
        // =====================================================================
        group.renderOrder = this._tileGroupRenderOrder;

        if (result.centerX !== undefined && result.centerZ !== undefined) {
            group.position.set(result.centerX, 0, result.centerZ);
        }

        while (group.children.length) {
            const child = group.children[0];
            if (child.geometry) child.geometry.dispose();
            group.remove(child);
        }

        for (const fill of result.fills) {
            const mat = this._getFillMaterialFromData(fill.layerName, fill.color, fill.opacity);
            const geom = new THREE.BufferGeometry();
            geom.setAttribute('position', new THREE.BufferAttribute(fill.positions, 3));
            if (fill.indices) geom.setIndex(new THREE.BufferAttribute(fill.indices, 1));
            const mesh = new THREE.Mesh(geom, mat);
            mesh.renderOrder = fill.renderOrder ?? VECTOR_TILE_RENDER_ORDER.FILL;
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
                mesh.renderOrder = VECTOR_TILE_RENDER_ORDER.BUILDING;
                group.add(mesh);

                if (this.buildingEdges && g.edg.length) {
                    const eGeom = new THREE.BufferGeometry();
                    eGeom.setAttribute('position', new THREE.BufferAttribute(this._concatF32(g.edg), 3));
                    const lines = new THREE.LineSegments(eGeom, this._getBuildingEdgeMaterial(g.stroke || 0x555555));
                    lines.renderOrder = VECTOR_TILE_RENDER_ORDER.EDGE;
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
            mesh.renderOrder = VECTOR_TILE_RENDER_ORDER.BUILDING;
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

            // pt.x, pt.z — локальные относительно центра тайла,
            // добавляем позицию группы тайла и сдвиг мира.
            const worldX = pt.x + group.position.x + worldOffset.x;
            const worldZ = pt.z + group.position.z + worldOffset.z;

            const dx = worldX - targetWorld.x;
            const dz = worldZ - targetWorld.z;
            const distSq = dx * dx + dz * dz;

            const worldPos = new THREE.Vector3(worldX, 0, worldZ);
            const ndc = worldPos.project(camera);

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

            const localWorldX = pt.x + group.position.x;
            const localWorldZ = pt.z + group.position.z;
            const source = new VectorPointLabelSource(map, localWorldX, localWorldZ, pt.text, {
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
        const op = opacity ?? 1;
        const key = `fill:${layerName}:${color.toString(16)}:${op}`;
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
     * Добавляет область исключения. Геометрия указанных слоёв, пересекающаяся с этой областью,
     * не будет отображаться.
     *
     * Координаты GeoJSON интерпретируются в системе координат, заданной в опции `crs`
     * конструктора (по умолчанию — `map.inputCRS`, т.е. WGS84) и преобразуются
     * во внутренние метры карты через {@link KrbMap#project}.
     *
     * Слой должен быть предварительно добавлен на карту через `addTo(map)`, иначе
     * невозможно преобразовать координаты в метры проекции карты.
     *
     * @param {Object} collection - GeoJSON (FeatureCollection, Feature или Geometry).
     * @param {Array<string>} layers - Список имён слоёв, к которым применяется исключение.
     * @returns {VectorTileLayer} Текущий экземпляр слоя.
     * @throws {Error} Если слой не добавлен на карту или передан некорректный GeoJSON.
     */
    addExclusionArea(collection, layers) {
        if (!this._map) {
            throw new Error('VectorTileLayer.addExclusionArea: слой должен быть добавлен на карту (addTo) до вызова addExclusionArea');
        }

        // Извлекаем полигоны из GeoJSON
        const geometries = [];
        if (collection.type === 'FeatureCollection') {
            for (const feature of collection.features) geometries.push(feature.geometry);
        } else if (collection.type === 'Feature') {
            geometries.push(collection.geometry);
        } else if (collection.type) {
            geometries.push(collection);
        } else {
            throw new Error('addExclusionArea: invalid GeoJSON object');
        }

        // Резолвим CRS: либо заданный у слоя, либо inputCRS карты.
        const crs = this._crsCode
            ? Projections.get(this._crsCode)
            : this._map.inputCRS;

        const worldPolygons = [];
        for (const geom of geometries) {
            if (!geom) continue;
            let rings = [];
            if (geom.type === 'Polygon') {
                rings = [geom.coordinates[0]]; // внешнее кольцо
            } else if (geom.type === 'MultiPolygon') {
                rings = geom.coordinates.map(poly => poly[0]);
            } else {
                console.warn('addExclusionArea: unsupported geometry type', geom.type);
                continue;
            }

            for (const ring of rings) {
                const worldRing = ring.map(pt => {
                    // Координата [x, y] в СК слоя → метры проекции карты.
                    const [x, z] = this._map.project(pt, crs);
                    return { x, z };
                });
                worldPolygons.push(worldRing);
            }
        }

        this._exclusionAreas = worldPolygons;
        this._exclusionLayers = new Set(layers);

        // Принудительно пересоздаём все тайлы
        this._invalidateAllTiles();

        return this;
    }

    /**
     * Полностью сбрасывает кэш тайлов и состояния, принуждая к пересозданию всех тайлов.
     * @private
     */
    _invalidateAllTiles() {
        this._clearAllTiles();
        this._clearGroupCache();
        this._tileDataCache.clear();
        this._lastSourceZoom = -1;
        this._lastDiscreteZoom = -1;
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

        // Резолвим СК для exclusion-областей.
        this._crs = this._crsCode
            ? Projections.get(this._crsCode)
            : map.inputCRS;

        // См. комментарий у _tileGroupRenderOrder. Здесь выставляем renderOrder
        // на корневую группу слоя. Само по себе это ничего не даёт (промежуточные
        // tileGroup всё равно сбросят groupOrder), но пусть будет — на случай,
        // если в будущем дерево упростится и tileGroup станет прямой дочерью
        // _rootGroup без посредников.
        this._rootGroup.renderOrder = this._tileGroupRenderOrder;

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

        // Останавливаем все таймеры и реджектим висящие промисы,
        // иначе они повиснут навсегда.
        if (this._queueTimer) {
            clearTimeout(this._queueTimer);
            this._queueTimer = null;
        }
        if (this._oldTileCleanupTimer) {
            clearTimeout(this._oldTileCleanupTimer);
            this._oldTileCleanupTimer = null;
        }
        for (const pending of this._pendingWorkerRequests.values()) {
            try { pending.reject(new Error('Layer removed')); } catch (e) {}
        }
        this._pendingWorkerRequests.clear();

        this._clearAllTiles();
        this._rootGroup.parent?.remove(this._rootGroup);
        const idx = this._map._dynamicLayers.indexOf(this);
        if (idx > -1) this._map._dynamicLayers.splice(idx, 1);
        this._map = null;
        this._crs = null;

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
        // Инвалидация: все in-flight ответы воркера считаются устаревшими.
        this._generation++;
        this._tileCache.forEach(group => this._disposeTile(group));
        this._tileCache.clear();
        this._pendingLoads.clear();
        this._sortedLoadQueue = [];
        this._clearOldTilesNow();
        // НЕ сбрасываем _activeLoads: реальные in-flight запросы
        // сами уменьшат его в finally.
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

    _scheduleOldTilesCleanup(delay = 1500) {
        if (this._oldTileCleanupTimer) clearTimeout(this._oldTileCleanupTimer);
        this._oldTileCleanupTimer = setTimeout(() => {
            if (this._sortedLoadQueue.length > 0 || this._activeLoads > 0) {
                this._oldTileCleanupTimer = setTimeout(() => this._clearOldTilesNow(), 1000);
            } else {
                this._clearOldTilesNow();
            }
        }, delay);
    }

    // -------------------------------------------------------------------------
    // LRU-кэш сырых PBF-буферов
    // -------------------------------------------------------------------------
    _setTileDataCache(key, buffer) {
        // Перезапись перемещает ключ в конец (как «свежий»).
        this._tileDataCache.delete(key);
        this._tileDataCache.set(key, buffer);
        while (this._tileDataCache.size > this._tileDataCacheMaxSize) {
            const oldestKey = this._tileDataCache.keys().next().value;
            this._tileDataCache.delete(oldestKey);
        }
    }

    _getTileDataCache(key) {
        const val = this._tileDataCache.get(key);
        if (val === undefined) return undefined;
        // Освежаем «свежесть».
        this._tileDataCache.delete(key);
        this._tileDataCache.set(key, val);
        return val;
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
            if (this._tileCache.size > 0 || this._oldTileGroups || this._activeLoads > 0) {
                this._clearAllTiles();
            }
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
            // Смена sourceZoom = полная инвалидация кэша тайлов.
            // Увеличиваем generation — все in-flight ответы будут отброшены.
            this._generation++;
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
            this._scheduleOldTilesCleanup(1500);
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
        const settleUpdateDue = timeSinceLastMove > 300 && this._lastLabelUpdateTime < this._lastMovementTime; // после остановки

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

        const map = this._map;
        if (!map) return;

        if (this._groupCache.has(key)) {
            const group = this._groupCache.get(key);
            this._groupCache.delete(key);
            const is3dNow = this.buildings3d && (map.currentDiscreteZoom ?? 0) >= this.buildings3dMinZoom;
            if (group.userData.is3d !== is3dNow) {
                const dataCacheKey = `${z}/${xSlippy}/${ySlippy}`;
                const cached = this._getTileDataCache(dataCacheKey);
                if (cached) {
                    this._pendingLoads.add(key);
                    this._activeLoads++;
                    try {
                        const result = await this._sendToWorker(cached.slice(0), z, xSlippy, ySlippy, is3dNow, group);
                        if (result) {
                            this._rootGroup.add(group);
                            this._tileCache.set(key, group);
                        }
                    } catch (err) {
                        // игнорируем
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
            const cached = this._getTileDataCache(dataCacheKey);
            if (cached) {
                buffer = cached.slice(0);
            } else {
                const url = this.url
                    .replaceAll('{z}', z)
                    .replaceAll('{x}', xSlippy)
                    .replaceAll('{y}', ySlippy);
                const response = await fetch(url);
                if (!response.ok) throw new Error(`HTTP ${response.status}`);
                buffer = await response.arrayBuffer();
                this._setTileDataCache(dataCacheKey, buffer.slice(0));
            }

            const is3dNow = this.buildings3d && (map.currentDiscreteZoom ?? 0) >= this.buildings3dMinZoom;
            const group = await this._sendToWorker(buffer, z, xSlippy, ySlippy, is3dNow);
            if (group) {
                this._rootGroup.add(group);
                this._tileCache.set(key, group);
            }
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
            if (!this._worker || !this._map) {
                reject(new Error('Layer removed'));
                return;
            }

            const map = this._map;
            const id = ++this._requestId;
            const tileSize = map.WORLD_SIZE / (1 << z);
            const maxMerc = map.MAX_MERCATOR;

            const msg = {
                type: 'process',
                id,
                buffer: buffer,
                z, x, y,
                tileSize,
                maxMerc,
                is3d,
                visibleLayers: this.visibleLayers,
                buildingEdges: this.buildingEdges,
                exclusionPolygons: this._exclusionAreas,
                exclusionLayers: Array.from(this._exclusionLayers)
            };

            this._pendingWorkerRequests.set(id, {
                resolve,
                reject,
                group: existingGroup || null,
                key: existingGroup ? null : `${z},${x},${y}`,
                generation: this._generation,
            });
            try {
                this._worker.postMessage(msg, [buffer]);
            } catch (err) {
                this._pendingWorkerRequests.delete(id);
                reject(err);
            }
        });
    }

    _getVisibleTileKeys(z) {
        const map = this._map;
        const camera = map.camera;
        const tileSize = map.WORLD_SIZE / (1 << z);
        const off = map.worldGroup.position;
        const maxTile = (1 << z) - 1;
        const numTiles = 1 << z;

        // 4 луча из углов экрана — реальный фрустум вместо top-down приближения
        const corners = [
            [-1, -1], [1, -1], [-1, 1], [1, 1]
        ];
        const ray = new THREE.Raycaster();
        const ndc = new THREE.Vector2();
        const plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
        const hit = new THREE.Vector3();

        let minX = Infinity, maxX = -Infinity;
        let minZ = Infinity, maxZ = -Infinity;
        let anyHit = false;

const camTargetDist = camera.position.distanceTo(map.controls.target);
const maxLoadDist   = Math.max(camTargetDist * 4, tileSize * 32);
const maxLoadDistSq = maxLoadDist * maxLoadDist;

const MIN_RAY_Y = Math.sin(5 * Math.PI / 180);

for (const [nx, ny] of corners) {
    ndc.set(nx, ny);
    ray.setFromCamera(ndc, camera);

    // Луч почти горизонтален — пересечение ненадёжно, пропускаем.
    if (Math.abs(ray.ray.direction.y) < MIN_RAY_Y) continue;

    if (!ray.ray.intersectPlane(plane, hit)) continue;

    // Слишком далеко от камеры — тоже не тянем этот тайл.
    const dxCam = hit.x - camera.position.x;
    const dzCam = hit.z - camera.position.z;
    if (dxCam * dxCam + dzCam * dzCam > maxLoadDistSq) continue;

    anyHit = true;
    const lx = hit.x - off.x;
    const lz = hit.z - off.z;
    if (lx < minX) minX = lx;
    if (lx > maxX) maxX = lx;
    if (lz < minZ) minZ = lz;
    if (lz > maxZ) maxZ = lz;
}

        // Если углы не пересекли землю (камера смотрит в небо) — падаем на старую логику
        if (!anyHit) {
            const target = map.controls.target;
            const distance = camera.position.distanceTo(target);
            const vFov = camera.fov * Math.PI / 180;
            const aspect = camera.aspect;
            const margin = 1;
            const hh = distance * Math.tan(vFov / 2) * aspect + margin * tileSize;
            const hv = distance * Math.tan(vFov / 2) + margin * tileSize;
            minX = target.x - off.x - hh;
            maxX = target.x - off.x + hh;
            minZ = target.z - off.z - hv;
            maxZ = target.z - off.z + hv;
        }

        // Добавляем позицию камеры — гарантирует загрузку тайла под ногами
        const camX = camera.position.x - off.x;
        const camZ = camera.position.z - off.z;
        if (camX < minX) minX = camX;
        if (camX > maxX) maxX = camX;
        if (camZ < minZ) minZ = camZ;
        if (camZ > maxZ) maxZ = camZ;

        // Небольшой запас, чтобы тайлы на границе экрана не мигали
        const margin = tileSize;
        minX -= margin; maxX += margin;
        minZ -= margin; maxZ += margin;

        const xMin = Math.floor((minX + map.MAX_MERCATOR) / tileSize);
        const xMax = Math.floor((maxX + map.MAX_MERCATOR) / tileSize);
        const yMin = Math.max(0, Math.floor((minZ + map.MAX_MERCATOR) / tileSize));
        const yMax = Math.min(maxTile, Math.floor((maxZ + map.MAX_MERCATOR) / tileSize));

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
        const rawOpacity = parseFloat(parts[3]);
        const opacity = (isNaN(rawOpacity) ? 1 : rawOpacity) * this.fillOpacity;
        const mat = new THREE.MeshBasicMaterial({
            color,
            side: THREE.DoubleSide,
            transparent: opacity < 1.0,
            opacity,
            depthTest: true,
            depthWrite: false,
            polygonOffset: true,
            polygonOffsetFactor: 1,
            polygonOffsetUnits: 1
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
            side: THREE.FrontSide,
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