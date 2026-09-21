/**
 * Модуль для рисования полигонов (многоугольников) на карте.
 * Предоставляет класс Polygon, использующий триангуляцию Earcut
 * для заливки и "толстые" линии для обводки, с поддержкой высот,
 * экструзии, видимости по зуму и подписей через TextManager.
 *
 * Взаимодействие с указателем (hover / click / tooltip) делегировано
 * {@link InteractionManager} — единому менеджеру карты. Полигон лишь
 * регистрирует колбэки при `_attach` и снимает регистрацию в `remove`.
 */

import { Projections } from './Projections.js';
import {
  THREE,
  Line2,
  LineMaterial,
  LineGeometry,
} from '../js_TP/tpb.js';
import { Layer } from './Layers.js';
import earcut from '../js_TP/earcut.js';

/**
 * Порядок отрисовки мешей полигона.
 *
 * @type {{BOTTOM: number, SIDE: number, TOP: number, STROKE: number}}
 */
export const POLYGON_RENDER_ORDER = {
    BOTTOM: 900,
    SIDE:   901,
    TOP:    902,
    STROKE: 903
};

/**
 * Доля от `WORLD_SIZE`, которая считается «нормальной» длиной ребра.
 *
 * Реальные грани объектов (стран, регионов, зданий) на порядки короче
 * полушария. Если хоть одно ребро кольца длиннее `WORLD_SIZE / 8`
 * (≈ 5000 км), это почти наверняка артефакт выхода за область
 * определения проекции (Transverse Mercator, UTM/GK далеко от осевого
 * меридиана): точка «улетает» за пределы мира, и полигон вытягивается
 * в полосу через всю карту. Такие полигоны не отрисовываются целиком.
 *
 * @type {number}
 * @private
 */
const INVALID_EDGE_FRACTION = 8;

/**
 * Вычисляет Y-компоненту векторного произведения (p1 - p0) × (p2 - p0)
 * для треугольника, лежащего в плоскости XZ (Y=0).
 * Используется для определения ориентации обхода (winding) треугольников Earcut.
 *
 * @param {THREE.Vector2} p0 - Первая вершина (x = X, y = Z).
 * @param {THREE.Vector2} p1 - Вторая вершина.
 * @param {THREE.Vector2} p2 - Третья вершина.
 * @returns {number} > 0 — нормаль указывает вверх (+Y), < 0 — вниз (-Y).
 * @private
 */
function crossY(p0, p1, p2) {
    const dx1 = p1.x - p0.x, dz1 = p1.y - p0.y;
    const dx2 = p2.x - p0.x, dz2 = p2.y - p0.y;
    return dz1 * dx2 - dx1 * dz2;
}

/**
 * Класс, представляющий полигон на карте.
 *
 * Поддерживает заливку, обводку, настройку высот, экструзию (объём),
 * ограничения по зуму, текстовую подпись, а также обработчики событий
 * наведения (`onHover`) и клика (`onClick`). Всплывающие подсказки
 * обрабатываются централизованно через PopupManager (доступен как
 * `map.popupManager`), а их показ/скрытие инициируется
 * {@link InteractionManager}.
 *
 * Координаты колец задаются в системе координат `options.crs`.
 * Если `crs` не указан, используется `map.inputCRS` (по умолчанию WGS84).
 * Внутри карты координаты автоматически преобразуются в метры проекции
 * карты (`map.projection`) через {@link KrbMap#project}.
 *
 * @example
 * // Обычный плоский полигон
 * const flatPolygon = new Polygon({
 *     rings: [[[30.5, 50.4], [31.0, 50.5], [30.8, 50.7]]],
 *     fillColor: '#ff0000',
 *     fillOpacity: 0.3,
 *     strokeColor: '#000000',
 *     strokeWidth: 2,
 *     altitudeMode: 'clampToGround',
 *     altitudeOffset: 10,
 *     depthTest: false,
 *     minZoom: 5,
 *     maxZoom: 18,
 *     title: 'Плоский полигон',
 *     tooltip: '<b>Полигон</b>',
 *     onClick: (event, polygon) => console.log('Клик по полигону'),
 *     onHover: (hovered) => console.log('Наведение:', hovered)
 * });
 * flatPolygon.addTo(map);
 *
 * // Экструдированный (объёмный) полигон с тенями
 * const extrudedPolygon = new Polygon({
 *     rings: [[[30.5, 50.4], [31.0, 50.5], [30.8, 50.7]]],
 *     extruded: true,
 *     height: 500,
 *     minHeight: 200,
 *     fillColor: '#ff8800',
 *     fillOpacity: 0.9,
 *     strokeColor: '#000000',
 *     strokeWidth: 3,
 *     altitudeMode: 'clampToGround',
 *     altitudeOffset: 10,
 *     // depthTest/depthWrite для extruded по умолчанию true — можно не задавать
 *     castShadow: true,
 *     receiveShadow: true,
 *     title: 'Объёмный полигон'
 * });
 * extrudedPolygon.addTo(map);
 *
 * @example
 * // Кольца в UTM зоне 37N (EPSG:32637)
 * const utmPolygon = new Polygon({
 *     rings: [[[413500, 6178000], [414000, 6178500], [413800, 6179000]]],
 *     crs: 'EPSG:32637',
 *     title: 'UTM-полигон'
 * });
 * utmPolygon.addTo(map);
 */
export class Polygon {
    /**
     * Инициализирует новый экземпляр полигона с заданными настройками.
     *
     * @param {Object} options - Настройки полигона.
     * @param {Array.<Array.<Array.<number>>>} options.rings - Массив колец.
     *     Первое кольцо – внешний контур, остальные (опционально) – отверстия.
     *     Каждое кольцо – массив точек [x, y] в СК `options.crs`
     *     (по умолчанию — [долгота, широта] в градусах WGS84).
     * @param {string} [options.crs] - Код системы координат для `rings`
     *     (например, 'EPSG:4326', 'EPSG:3857', 'EPSG:32637').
     *     Если не указан — используется `map.inputCRS`.
     *     Перед созданием полигона соответствующая проекция должна быть
     *     зарегистрирована в `Projections` (см. `Projections.ensure`).
     * @param {string} [options.fillColor='#3388ff'] - Цвет заливки (CSS).
     * @param {number} [options.fillOpacity=0.5] - Прозрачность заливки (0..1).
     * @param {string} [options.strokeColor='#000000'] - Цвет обводки.
     * @param {number} [options.strokeWidth=2] - Толщина обводки в пикселях.
     * @param {number} [options.strokeOpacity=1] - Прозрачность обводки.
     * @param {string} [options.altitudeMode='clampToGround'] - Режим высоты:
     *     'clampToGround' (прилегать к рельефу) или 'absolute' (постоянная высота).
     * @param {number} [options.altitudeOffset=10] - Добавочная высота над
     *     поверхностью (или базовая высота для `absolute`).
     * @param {boolean} [options.extruded=false] - Включить экструзию (объёмный полигон).
     * @param {number} [options.height=0] - Толщина экструзии в метрах
     *     (только если `extruded=true`).
     * @param {number} [options.minHeight=0] - Высота нижней грани над
     *     поверхностью в метрах (только если `extruded=true`).
     * @param {boolean} [options.depthTest] - Включить тест глубины.
     *     По умолчанию: false для плоских, true для extruded.
     * @param {boolean} [options.depthWrite] - Включить запись в буфер глубины.
     *     По умолчанию: false для плоских, true для extruded.
     * @param {boolean} [options.castShadow=true] - Отбрасывать тень
     *     (применяется только к extruded=true).
     * @param {boolean} [options.receiveShadow=true] - Принимать тень
     *     (применяется только к extruded=true).
     * @param {number} [options.roughness=0.8] - Шероховатость PBR-материала
     *     (только для extruded=true).
     * @param {number} [options.metalness=0.0] - Металличность PBR-материала
     *     (только для extruded=true).
     * @param {number} [options.minZoom=-Infinity] - Минимальный зум,
     *     при котором полигон виден.
     * @param {number} [options.maxZoom=Infinity] - Максимальный зум,
     *     при котором полигон виден.
     * @param {string} [options.title=''] - Текст постоянной подписи.
     * @param {Array.<number>} [options.titleOffset=[0,0]] - Смещение подписи
     *     в пикселях.
     * @param {string} [options.titleAlign='center'] - Горизонтальное
     *     выравнивание подписи ('left', 'center', 'right').
     * @param {Object} [options.titleStyle={}] - CSS-стили подписи.
     * @param {number} [options.titleMinZoom=-Infinity] - Минимальный зум
     *     для отображения подписи.
     * @param {number} [options.titleMaxZoom=Infinity] - Максимальный зум
     *     для отображения подписи.
     * @param {boolean} [options.titleAllowOverflow=false] - Разрешить выход
     *     подписи за границы экрана.
     * @param {number} [options.titlePriority=0] - Приоритет подписи
     *     (чем выше, тем приоритетнее).
     * @param {function} [options.onClick] - Callback при клике по полигону.
     *     Получает событие и экземпляр полигона.
     * @param {function} [options.onHover] - Callback при наведении/убирании
     *     курсора. Получает `true`/`false`.
     * @param {string} [options.tooltip=''] - Текст всплывающей подсказки (HTML),
     *     показывается через PopupManager при наведении или клике
     *     (если не задан onClick/onHover).
     * @param {boolean} [options.useSimpleStroke=false] - Использовать обычный
     *     THREE.Line вместо Line2 для обводки (быстрее, но ширина 1px).
     *     Для массовых полигонов настоятельно рекомендуется `true`.
     * @param {boolean} [options.useWorkerForTriangulation=false] - Выполнять
     *     триангуляцию в Web Worker (экспериментально, требует асинхронной
     *     инициализации).
     * @throws {Error} Если не передан массив колец или он пуст.
     * @throws {Error} Если extruded=true и height не положительное число.
     */
    constructor(options = {}) {
        if (!options.rings || !options.rings.length || !options.rings[0].length) {
            throw new Error('Polygon: options.rings required with at least one ring');
        }

        /** @private @type {Array.<Array.<Array.<number>>>} */ this._rings = options.rings;

        /**
         * Код СК колец; null — использовать `map.inputCRS`.
         * @private
         * @type {string|null}
         */
        this._crsCode = options.crs ?? null;

        /**
         * Зарезолвленный объект Projection. Устанавливается в `_attach`.
         * @private
         * @type {import('./Projections.js').Projection|null}
         */
        this._crs = null;

        /** @private @type {string} */  this._fillColor = options.fillColor || '#3388ff';
        /** @private @type {number} */  this._fillOpacity = options.fillOpacity ?? 0.5;
        /** @private @type {string} */  this._strokeColor = options.strokeColor || '#000000';
        /** @private @type {number} */  this._strokeWidth = options.strokeWidth ?? 2;
        /** @private @type {number} */  this._strokeOpacity = options.strokeOpacity ?? 1;
        /** @private @type {string} */  this._altitudeMode = options.altitudeMode || 'clampToGround';
        /** @private @type {number} */  this._altitudeOffset = options.altitudeOffset ?? 10;

        // Экструзия
        /** @private @type {boolean} */ this._extruded = options.extruded ?? false;
        /** @private @type {number} */  this._height = options.height ?? 0;
        /** @private @type {number} */  this._minHeight = options.minHeight ?? 0;
        if (this._extruded && (typeof this._height !== 'number' || this._height <= 0)) {
            throw new Error('Polygon: options.height must be a positive number when extruded is true');
        }

        // Depth-опции: для extruded по умолчанию true, для плоских — false.
        /** @private @type {boolean} */ this._depthTest = options.depthTest ?? this._extruded;
        /** @private @type {boolean} */ this._depthWrite = options.depthWrite ?? this._extruded;

        /** @private @type {number} */  this._minZoom = options.minZoom ?? -Infinity;
        /** @private @type {number} */  this._maxZoom = options.maxZoom ?? Infinity;
        /** @private @type {boolean} */ this._useSimpleStroke = options.useSimpleStroke ?? false;
        /** @private @type {boolean} */ this._useWorkerForTriangulation = options.useWorkerForTriangulation ?? false;

        // Тени и PBR (только для extruded=true)
        /** @private @type {boolean} */ this._castShadow = options.castShadow ?? true;
        /** @private @type {boolean} */ this._receiveShadow = options.receiveShadow ?? true;
        /** @private @type {number} */  this._roughness = options.roughness ?? 0.8;
        /** @private @type {number} */  this._metalness = options.metalness ?? 0.0;

        // Подпись
        /** @private @type {string} */  this._title = options.title || '';
        /** @private @type {Array.<number>} */ this._titleOffset = options.titleOffset || [0, 0];
        /** @private @type {string} */  this._titleAlign = options.titleAlign || 'center';
        /** @private @type {Object} */  this._titleStyle = options.titleStyle || {};
        /** @private @type {number} */  this._titleMinZoom = options.titleMinZoom ?? -Infinity;
        /** @private @type {number} */  this._titleMaxZoom = options.titleMaxZoom ?? Infinity;
        /** @private @type {boolean} */ this._titleAllowOverflow = options.titleAllowOverflow || false;
        /** @private @type {number} */  this._titlePriority = options.titlePriority ?? 0;

        // События
        /** @private @type {Function|null} */ this._onClick = options.onClick || null;
        /** @private @type {Function|null} */ this._onHover = options.onHover || null;

        /**
         * Текущее состояние hover. Обновляется только если у полигона задан
         * пользовательский `onHover` — иначе hover-логикой управляет
         * InteractionManager через PopupManager.
         * @private
         * @type {boolean}
         */
        this._isHovered = false;

        // Тултип
        /** @private @type {string} */  this._tooltipText = options.tooltip || '';

        // Структуры
        /** @private @type {import('./KrbMap.js').KrbMap|null} */ this._map = null;
        /** @private @type {Layer|null} */ this._layer = null;
        /** @private @type {THREE.Group} */ this._group = new THREE.Group();

        // Верхняя крышка
        /** @private @type {THREE.Mesh|null} */           this._fillMesh = null;
        /** @private @type {THREE.BufferGeometry|null} */ this._fillGeometry = null;
        /** @private @type {THREE.Material|null} */       this._fillMaterial = null;

        // Нижняя крышка
        /** @private @type {THREE.Mesh|null} */           this._bottomMesh = null;
        /** @private @type {THREE.BufferGeometry|null} */ this._bottomGeometry = null;
        /** @private @type {THREE.Material|null} */       this._bottomMaterial = null;

        // Боковые стенки
        /** @private @type {THREE.Mesh|null} */           this._sideMesh = null;
        /** @private @type {THREE.BufferGeometry|null} */ this._sideGeometry = null;
        /** @private @type {THREE.Material|null} */       this._sideMaterial = null;
        /** @private @type {number} */                   this._sideVertexCount = 0;

        // Обводка
        /** @private @type {THREE.Object3D|null} */       this._strokeLine = null;
        /** @private @type {THREE.BufferGeometry|null} */ this._strokeGeometry = null;
        /** @private @type {THREE.Material|null} */       this._strokeMaterial = null;

        // Кэш высот
        /** @private @type {Array.<number>} */ this._cachedHeights = new Array(this._rings[0]?.length ?? 0).fill(0);
        /** @private @type {Array.<number>} */ this._cachedStrokeHeights = new Array(this._rings[0]?.length ?? 0).fill(0);
        /** @private @type {number} */        this._lastHeightUpdateTime = 0;
        /** @private @type {number} */        this._heightUpdateInterval = 500;

        /**
         * Флаг, что высоты окончательно зафиксированы для случая, когда
         * они не зависят от рельефа (нет elevation у карты или altitudeMode
         * 'absolute'). Позволяет избежать бесполезных пересчётов в _update.
         * @private
         * @type {boolean}
         */
        this._heightsFinalized = false;

        /**
         * Флаг «невалидной геометрии».
         *
         * Устанавливается в `_buildFillGeometry`, если после проекции у
         * полигона обнаружилось ребро абсурдной длины (см.
         * `INVALID_EDGE_FRACTION`). Это означает, что часть вершин ушла
         * далеко за область определения проекции (типичный случай —
         * страны в UTM/GK, лежащие на краю зоны: Колумбия, Эквадор в N-37).
         * Такой полигон не строит ни заливку, ни обводку, не регистрируется
         * в InteractionManager и не участвует в расчёте высот — вместо
         * «полосы через весь мир» просто ничего не рисуется.
         * @private
         * @type {boolean}
         */
        this._invalidGeometry = false;

        // Центроид и вершины
        /** @private @type {Array.<THREE.Vector2>} */ this._vertices2D = [];
        /** @private @type {THREE.Vector3} */         this._centroidWorld = new THREE.Vector3();
        /** @private @type {number} */                this._cachedCentroidHeight = 0;
        /** @private @type {number} */                this._lastCentroidHeightUpdateTime = 0;

        // Мировые координаты и bounding sphere
        /** @private @type {Array.<[number, number]>} */ this._worldCoords = [];
        /** @private @type {Array.<[number, number]>} */ this._strokeWorldCoords = [];

        /**
         * Радиус bounding-сферы в локальных координатах группы полигона.
         * Используется в InteractionManager для broad-phase.
         * @private
         * @type {number}
         */
        this._boundingSphereRadius = 0;

        /**
         * Переиспользуемый вектор мирового центра bounding-сферы.
         * Каждый вызов `getBoundingSphere` пишет сюда актуальное значение
         * и возвращает ссылку на этот же объект. InteractionManager копирует
         * значения в свою сферу, так что удержание ссылки не требуется.
         * @private
         * @type {THREE.Vector3}
         */
        this._boundingSphereWorldCenter = new THREE.Vector3();

        /**
         * Кэш массива мешей для raycast. Пересобирается в `_buildFillGeometry`.
         * Используется в `getMeshes` InteractionManager.
         * @private
         * @type {THREE.Object3D[]|null}
         */
        this._raycastMeshesCache = null;

        /**
         * Функция отмены регистрации в `map.interaction`. Устанавливается
         * в `_registerInteraction`, вызывается в `_attach` (при перерегистрации)
         * и в `remove`.
         * @private
         * @type {(() => void)|null}
         */
        this._unregisterInteraction = null;

        // Dirty-флаги
        /** @private @type {boolean} */ this._heightsDirty = true;
        /** @private @type {THREE.Vector3} */ this._lastWorldGroupPos = new THREE.Vector3();
        /** @private @type {number} */ this._lastDiscreteZoom = -1;

        // Подпись
        /** @private @type {Object|null} */ this._centroidScreenPos = null;
        /** @private @type {Object|null} */ this._textLabel = null;

        // Переиспользуемые массивы
        /** @private @type {Array.<number>} */ this._strokePositionsArray = [];
        /** @private @type {Array.<number>} */ this._sidePositionsArray = [];
        /** @private @type {Array.<number>} */ this._sideIndicesArray = [];

        // Регистрация в реестре интерактивных выполняется в `_attach`,
        // когда известна карта (`this._map`).
    }

    /* ================================================================
       Публичные методы
       ================================================================ */

    /**
     * Создаёт персональный слой, добавляет его на карту и помещает в него
     * данный полигон.
     *
     * @param {import('./KrbMap.js').KrbMap} map - Экземпляр карты.
     * @returns {Polygon} Текущий экземпляр полигона.
     */
    addTo(map) {
        if (this._map) this.remove();
        const personalLayer = new Layer();
        personalLayer.addTo(map);
        personalLayer.add(this);
        return this;
    }

    /**
     * Вызывается слоем при добавлении: строит геометрию, регистрирует
     * подпись и интерактивность.
     *
     * @param {import('./KrbMap.js').KrbMap} map - Экземпляр карты.
     * @param {Layer} layer - Слой-владелец.
     * @returns {void}
     * @private
     */
    _attach(map, layer) {
        if (this._map === map && this._layer === layer) return;
        this.remove();
        this._map = map;
        this._layer = layer;

        // Резолвим проекцию полигона: либо заданную явно, либо inputCRS карты.
        this._crs = this._crsCode
            ? Projections.get(this._crsCode)
            : map.inputCRS;

        this._buildFillGeometry(map);
        this._buildStrokeGeometry(map);
        map.worldGroup.add(this._group);

        if (this._title && map.textManager) {
            this._textLabel = map.textManager.addLabel(this);
        }

        this._registerInteraction(map);

        this._lastWorldGroupPos.copy(map.worldGroup.position);
        this._lastDiscreteZoom = map.currentDiscreteZoom;
        this._heightsDirty = true;
        this._heightsFinalized = false;
    }

    /**
     * Регистрирует полигон в общем InteractionManager карты.
     *
     * Если у полигона нет ни `onClick`, ни `onHover`, ни `tooltip` —
     * регистрация не выполняется (объект не интерактивен). Полигоны с
     * невалидной геометрией (`_invalidGeometry`) не регистрируются вовсе,
     * чтобы не ловить клики по «полосе через весь мир».
     *
     * @private
     * @param {import('./KrbMap.js').KrbMap} map - Экземпляр карты.
     */
    _registerInteraction(map) {
        if (!map.interaction || typeof map.interaction.register !== 'function') return;
        if (this._unregisterInteraction) {
            this._unregisterInteraction();
            this._unregisterInteraction = null;
        }
        if (this._invalidGeometry) return;
        if (!this._onClick && !this._onHover && !this._tooltipText) return;

        const callbacks = {
            getMeshes: () => this._getRaycastMeshes(),
            getBoundingSphere: () => {
                if (this._boundingSphereRadius <= 0) return null;
                const wgPos = map.worldGroup.position;
                this._boundingSphereWorldCenter.set(
                    this._group.position.x + wgPos.x,
                    this._group.position.y + wgPos.y,
                    this._group.position.z + wgPos.z
                );
                return {
                    center: this._boundingSphereWorldCenter,
                    radius: this._boundingSphereRadius
                };
            },
            isVisible: () => this._group.visible
        };

        // Hover: пользовательский onHover имеет приоритет над tooltip —
        // если он задан, PopupManager в hover-логике не участвует.
        if (this._onHover) {
            callbacks.onHover = (isHovered) => {
                this._isHovered = isHovered;
                this._onHover(isHovered);
            };
        } else if (this._tooltipText) {
            callbacks.getTooltip = () => this._tooltipText;
        }

        if (this._onClick) {
            callbacks.onClick = (event) => this._onClick(event, this);
        }

        this._unregisterInteraction = map.interaction.register(this, callbacks);
    }

    /**
     * Возвращает массив мешей для raycast.
     *
     * Возвращает закэшированный массив (пересобирается при перестройке
     * геометрии в `_buildFillGeometry`). Возвращаемый массив не должен
     * мутироваться вызывающей стороной.
     *
     * @private
     * @returns {THREE.Object3D[]} Массив мешей (может быть пустым).
     */
    _getRaycastMeshes() {
        if (this._raycastMeshesCache) return this._raycastMeshesCache;
        const meshes = [];
        if (this._fillMesh) meshes.push(this._fillMesh);
        if (this._sideMesh) meshes.push(this._sideMesh);
        if (this._bottomMesh) meshes.push(this._bottomMesh);
        this._raycastMeshesCache = meshes;
        return meshes;
    }

    /**
     * Возвращает CSS-трансформацию для подписи в зависимости от выравнивания.
     *
     * @returns {string} CSS-трансформация.
     * @private
     */
    _getTitleTransform() {
        switch (this._titleAlign) {
            case 'left': return 'translate(0, 0)';
            case 'right': return 'translate(-100%, 0)';
            default: return 'translate(-50%, 0)';
        }
    }

    /**
     * Создаёт материал для поверхности полигона.
     *
     * Для экструдированных полигонов используется `MeshStandardMaterial`
     * (участвует в освещении и shadow mapping). Для плоских —
     * `MeshBasicMaterial`.
     *
     * Прозрачность включается только если `fillOpacity < 1`. При opacity === 1
     * материал рендерится без alpha-blending, что заметно ускоряет
     * фрагментный шейдер и убирает сортировку прозрачных объектов.
     *
     * @returns {THREE.Material} Материал поверхности.
     * @private
     */
    _createSurfaceMaterial() {
        const isTransparent = this._fillOpacity < 1;

        if (this._extruded) {
            return new THREE.MeshStandardMaterial({
                color: this._fillColor,
                opacity: this._fillOpacity,
                transparent: isTransparent,
                side: THREE.DoubleSide,
                roughness: this._roughness,
                metalness: this._metalness,
                depthTest: this._depthTest,
                depthWrite: this._depthWrite,
                polygonOffset: true,
                polygonOffsetFactor: -1,
                polygonOffsetUnits: -1
            });
        }
        return new THREE.MeshBasicMaterial({
            color: this._fillColor,
            opacity: this._fillOpacity,
            transparent: isTransparent,
            side: THREE.DoubleSide,
            depthTest: this._depthTest,
            depthWrite: this._depthWrite,
            polygonOffset: true,
            polygonOffsetFactor: -1,
            polygonOffsetUnits: -1
        });
    }

    /**
     * Применяет флаги теней к мешу, если полигон экструдированный.
     *
     * @param {THREE.Mesh} mesh - Меш полигона.
     * @returns {void}
     * @private
     */
    _applyShadowFlags(mesh) {
        if (!mesh) return;
        if (this._extruded) {
            mesh.castShadow = this._castShadow;
            mesh.receiveShadow = this._receiveShadow;
        } else {
            mesh.castShadow = false;
            mesh.receiveShadow = false;
        }
    }

    /**
     * Инвертирует обход треугольников (swap 2-го и 3-го индексов в каждом
     * треугольнике). Возвращает новый массив, исходный не изменяется.
     *
     * @param {Array.<number>|Uint32Array} indices - Индексы треугольников.
     * @returns {Array.<number>} Новый массив индексов с инвертированным обходом.
     * @private
     */
    _flipIndices(indices) {
        const result = new Array(indices.length);
        for (let i = 0; i < indices.length; i += 3) {
            result[i] = indices[i];
            result[i + 1] = indices[i + 2];
            result[i + 2] = indices[i + 1];
        }
        return result;
    }

    /**
     * Проверяет, не «разъехалась» ли геометрия после проекции настолько,
     * что её нельзя осмысленно отрисовать.
     *
     * Идея: если у полигона найдётся хоть одно ребро длиннее
     * `WORLD_SIZE / INVALID_EDGE_FRACTION`, это артефакт выхода за область
     * определения проекции. Классический пример — Колумбия и Эквадор в
     * N-37 Гаусса-Крюгера: страна вытягивается в полосу через весь мир,
     * потому что часть её точек «улетает» за пределы координатной сетки
     * Transverse Mercator. Такие полигоны нужно просто не рисовать.
     *
     * ВАЖНО: `_worldCoords` должен быть уже заполнен, а `ringStartIndices`
     * соответствовать его разбиению по кольцам.
     *
     * @param {Array.<number>} ringStartIndices - Индексы начала колец в `_worldCoords`.
     * @param {number} worldSize - Полный размер мира карты (2πR), в метрах.
     * @returns {boolean} `true`, если геометрия невалидна.
     * @private
     */
    _isGeometryInvalid(ringStartIndices, worldSize) {
        const maxEdge = worldSize / INVALID_EDGE_FRACTION;
        const maxEdgeSq = maxEdge * maxEdge;
        const wc = this._worldCoords;

        for (let ringIdx = 0; ringIdx < ringStartIndices.length; ringIdx++) {
            const start = ringStartIndices[ringIdx];
            if (start === undefined) continue;
            const nextStart = (ringIdx + 1 < ringStartIndices.length)
                ? ringStartIndices[ringIdx + 1]
                : wc.length;
            const count = nextStart - start;
            if (count < 2) continue;

            for (let i = 0; i < count; i++) {
                const a = wc[start + i];
                const b = wc[start + ((i + 1) % count)];
                if (!a || !b) continue;
                const dx = b[0] - a[0];
                const dz = b[1] - a[1];
                if (dx * dx + dz * dz > maxEdgeSq) return true;
            }
        }
        return false;
    }

    /**
     * Строит геометрию заливки полигона с использованием триангуляции Earcut.
     * Для экструдированных полигонов дополнительно создаёт нижнюю крышку
     * и боковые стенки.
     *
     * Если после проекции обнаруживается ребро абсурдной длины (см.
     * `_isGeometryInvalid`), полигон помечается как невалидный и ни один
     * меш не создаётся — группа остаётся невидимой.
     *
     * @param {import('./KrbMap.js').KrbMap} map - Экземпляр карты.
     * @returns {void}
     * @private
     */
    _buildFillGeometry(map) {
        const rings = this._rings;
        if (!rings || !rings.length || rings[0].length < 3) {
            console.warn('Polygon: rings[0] must have at least 3 points');
            return;
        }

        this._worldCoords.length = 0;
        const coords = [];
        const points2D = [];
        const holeIndices = [];
        const ringStartIndices = [];

        for (let ringIdx = 0; ringIdx < rings.length; ringIdx++) {
            const ring = rings[ringIdx];
            if (ring.length < 3) {
                console.warn(`Polygon: hole ring ${ringIdx} must have at least 3 points`);
                continue;
            }

            ringStartIndices.push(points2D.length);
            if (ringIdx > 0) {
                holeIndices.push(coords.length / 2);
            }

            let firstPoint = null;
            for (let i = 0; i < ring.length; i++) {
                const pt = ring[i];
                // Координаты кольца → метры проекции карты.
                const [absX, absZ] = map.project(pt, this._crs);
                if (i === 0) {
                    firstPoint = [absX, absZ];
                }
                if (i > 0 && absX === firstPoint[0] && absZ === firstPoint[1]) {
                    continue;
                }
                coords.push(absX, absZ);
                points2D.push(new THREE.Vector2(absX, absZ));
                this._worldCoords.push([absX, absZ]);
            }
        }

        if (points2D.length < 3) {
            console.warn('Polygon: after processing rings, less than 3 vertices');
            return;
        }

        // === Детект «полос через весь мир» ===
        // Проверяем длины рёбер колец в метрах проекции. Если хоть одно
        // ребро длиннее WORLD_SIZE / INVALID_EDGE_FRACTION — полигон
        // выброшен проекцией за область определения, не рисуем его.
        if (this._isGeometryInvalid(ringStartIndices, map.WORLD_SIZE)) {
            this._invalidGeometry = true;
            this._group.visible = false;
            this._worldCoords.length = 0;
            return;
        }
        this._invalidGeometry = false;

        this._vertices2D = points2D;
        this._cachedHeights = new Array(points2D.length).fill(0);

        // Триангуляция.
        let indices;
        if (this._useWorkerForTriangulation && typeof Worker !== 'undefined') {
            console.warn('Worker triangulation is experimental, falling back to sync');
            indices = earcut(coords, holeIndices, 2);
        } else {
            indices = earcut(coords, holeIndices, 2);
        }

        if (indices.length === 0) {
            console.warn('Polygon: Earcut returned no triangles');
            return;
        }

        // Согласуем winding Earcut-вывода: верхняя крышка должна быть CCW при
        // взгляде сверху (нормаль +Y), нижняя — наоборот.
        const firstCrossY = crossY(points2D[indices[0]], points2D[indices[1]], points2D[indices[2]]);
        const topIndices = firstCrossY >= 0 ? indices : this._flipIndices(indices);
        const bottomIndices = this._flipIndices(topIndices);

        // Центроид.
        let cx = 0, cy = 0;
        for (const pt of points2D) {
            cx += pt.x;
            cy += pt.y;
        }
        cx /= points2D.length;
        cy /= points2D.length;

        this._centroidWorld.set(cx, 0, cy);
        this._group.position.copy(this._centroidWorld);

        for (let i = 0; i < points2D.length; i++) {
            points2D[i].x -= cx;
            points2D[i].y -= cy;
        }

        let maxRadiusSq = 0;
        for (const pt of points2D) {
            const rSq = pt.x * pt.x + pt.y * pt.y;
            if (rSq > maxRadiusSq) maxRadiusSq = rSq;
        }
        this._boundingSphereRadius = Math.sqrt(maxRadiusSq);

        // === Верхняя крышка ===
        const topGeometry = new THREE.BufferGeometry();
        const topPosArray = new Float32Array(points2D.length * 3);
        for (let i = 0; i < points2D.length; i++) {
            const pt = points2D[i];
            topPosArray[i * 3] = pt.x;
            topPosArray[i * 3 + 1] = 0;
            topPosArray[i * 3 + 2] = pt.y;
        }
        topGeometry.setAttribute('position', new THREE.BufferAttribute(topPosArray, 3));
        topGeometry.setIndex(topIndices);

        // Явные нормали +Y для верхней крышки.
        const topNormals = new Float32Array(points2D.length * 3);
        for (let i = 0; i < points2D.length; i++) {
            topNormals[i * 3 + 1] = 1;
        }
        topGeometry.setAttribute('normal', new THREE.BufferAttribute(topNormals, 3));
        topGeometry.computeBoundingSphere();

        const topMaterial = this._createSurfaceMaterial();

        const topMesh = new THREE.Mesh(topGeometry, topMaterial);
        topMesh.renderOrder = POLYGON_RENDER_ORDER.TOP;
        // Bounding sphere валидна → frustum culling безопасен и полезен.
        topMesh.frustumCulled = true;
        topMesh.userData.polygon = this;
        this._applyShadowFlags(topMesh);
        this._fillMesh = topMesh;
        this._fillGeometry = topGeometry;
        this._fillMaterial = topMaterial;
        this._group.add(topMesh);

        // === Экструзия ===
        if (this._extruded) {
            // Нижняя крышка
            const bottomGeometry = new THREE.BufferGeometry();
            const bottomPosArray = new Float32Array(points2D.length * 3);
            for (let i = 0; i < points2D.length; i++) {
                const pt = points2D[i];
                bottomPosArray[i * 3] = pt.x;
                bottomPosArray[i * 3 + 1] = 0;
                bottomPosArray[i * 3 + 2] = pt.y;
            }
            bottomGeometry.setAttribute('position', new THREE.BufferAttribute(bottomPosArray, 3));
            bottomGeometry.setIndex(bottomIndices);

            const bottomNormals = new Float32Array(points2D.length * 3);
            for (let i = 0; i < points2D.length; i++) {
                bottomNormals[i * 3 + 1] = -1;
            }
            bottomGeometry.setAttribute('normal', new THREE.BufferAttribute(bottomNormals, 3));
            bottomGeometry.computeBoundingSphere();

            const bottomMaterial = this._createSurfaceMaterial();

            const bottomMesh = new THREE.Mesh(bottomGeometry, bottomMaterial);
            bottomMesh.renderOrder = POLYGON_RENDER_ORDER.BOTTOM;
            bottomMesh.frustumCulled = true;
            bottomMesh.userData.polygon = this;
            this._applyShadowFlags(bottomMesh);
            this._bottomMesh = bottomMesh;
            this._bottomGeometry = bottomGeometry;
            this._bottomMaterial = bottomMaterial;
            this._group.add(bottomMesh);

            // Боковые стенки.
            // ВАЖНО: сразу задаём осмысленные Y (height сверху, 0 снизу), чтобы
            // build-time computeVertexNormals() не получал вырожденные треугольники
            // (иначе нормали будут NaN и стенки перестанут освещаться).
            const sidePositions = this._sidePositionsArray;
            const sideIndices = this._sideIndicesArray;
            sidePositions.length = 0;
            sideIndices.length = 0;

            const initialHeight = this._height;

            for (let ringIdx = 0; ringIdx < rings.length; ringIdx++) {
                if (ringStartIndices[ringIdx] === undefined) continue;

                const start = ringStartIndices[ringIdx];
                const nextRingStart = (ringIdx + 1 < ringStartIndices.length)
                    ? ringStartIndices[ringIdx + 1]
                    : points2D.length;
                const count = nextRingStart - start;

                if (count < 2) continue;

                for (let i = 0; i < count; i++) {
                    const j = (i + 1) % count;
                    const idxI = start + i;
                    const idxJ = start + j;

                    const topI = points2D[idxI];
                    const topJ = points2D[idxJ];

                    const baseIndex = sidePositions.length / 3;

                    // Порядок вершин: 0 = верх I, 1 = низ I, 2 = верх J, 3 = низ J
                    sidePositions.push(topI.x, initialHeight, topI.y);
                    sidePositions.push(topI.x, 0, topI.y);
                    sidePositions.push(topJ.x, initialHeight, topJ.y);
                    sidePositions.push(topJ.x, 0, topJ.y);

                    sideIndices.push(baseIndex, baseIndex + 1, baseIndex + 2);
                    sideIndices.push(baseIndex + 1, baseIndex + 3, baseIndex + 2);
                }
            }

            const sideGeometry = new THREE.BufferGeometry();
            sideGeometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(sidePositions), 3));
            sideGeometry.setIndex(sideIndices);
            sideGeometry.computeVertexNormals();
            sideGeometry.computeBoundingSphere();

            const sideMaterial = this._createSurfaceMaterial();

            const sideMesh = new THREE.Mesh(sideGeometry, sideMaterial);
            sideMesh.renderOrder = POLYGON_RENDER_ORDER.SIDE;
            sideMesh.frustumCulled = true;
            sideMesh.userData.polygon = this;
            this._applyShadowFlags(sideMesh);
            this._sideMesh = sideMesh;
            this._sideGeometry = sideGeometry;
            this._sideMaterial = sideMaterial;
            this._sideVertexCount = sidePositions.length / 3;
            this._group.add(sideMesh);
        }

        // Меши пересозданы — кэш для raycast невалиден.
        this._raycastMeshesCache = null;
    }

    /**
     * Строит геометрию обводки полигона. В зависимости от опций использует
     * Line2 или обычный THREE.Line.
     *
     * Если полигон помечен невалидным (`_invalidGeometry`) — обводка
     * не строится.
     *
     * ВАЖНО: `_strokeWorldCoords` заполняется координатами внешнего кольца
     * без замыкающей точки (если последняя совпадает с первой — она
     * отбрасывается). Это значит, что длина `_strokeWorldCoords` может
     * отличаться от `this._rings[0].length`. Все связанные массивы
     * (`_cachedStrokeHeights`) должны инициализироваться по фактической
     * длине `_strokeWorldCoords`, а не по длине исходного кольца.
     *
     * @param {import('./KrbMap.js').KrbMap} map - Экземпляр карты.
     * @returns {void}
     * @private
     */
    _buildStrokeGeometry(map) {
        if (this._invalidGeometry) return;
        if (this._strokeWidth <= 0 || this._strokeOpacity <= 0) return;

        const canvas = map.renderer.domElement;
        const outerRing = this._rings[0];

        // Заполняем _strokeWorldCoords без дубликата замыкающей точки
        // (совпадающей с первой) — так длины массивов остаются
        // согласованными между собой и с _cachedStrokeHeights.
        this._strokeWorldCoords.length = 0;
        let firstStrokePoint = null;
        for (let i = 0; i < outerRing.length; i++) {
            const [absX, absZ] = map.project(outerRing[i], this._crs);
            if (i === 0) {
                firstStrokePoint = [absX, absZ];
            } else if (absX === firstStrokePoint[0] && absZ === firstStrokePoint[1]) {
                continue;
            }
            this._strokeWorldCoords.push([absX, absZ]);
        }

        // _cachedStrokeHeights всегда согласован по длине с _strokeWorldCoords.
        this._cachedStrokeHeights = new Array(this._strokeWorldCoords.length).fill(0);

        if (this._useSimpleStroke) {
            const positions = [];
            for (let i = 0; i < this._strokeWorldCoords.length; i++) {
                const wc = this._strokeWorldCoords[i];
                positions.push(wc[0], 0, wc[1]);
            }
            if (this._strokeWorldCoords.length > 0) {
                const first = this._strokeWorldCoords[0];
                positions.push(first[0], 0, first[1]);
            }

            const lineGeometry = new THREE.BufferGeometry();
            lineGeometry.setAttribute(
                'position',
                new THREE.BufferAttribute(new Float32Array(positions), 3)
            );
            lineGeometry.computeBoundingSphere();

            const lineMaterial = new THREE.LineBasicMaterial({
                color: this._strokeColor,
                opacity: this._strokeOpacity,
                transparent: this._strokeOpacity < 1,
                depthTest: this._depthTest,
                depthWrite: this._depthWrite
            });
            const line = new THREE.Line(lineGeometry, lineMaterial);
            line.renderOrder = POLYGON_RENDER_ORDER.STROKE;
            this._strokeLine = line;
            this._strokeGeometry = lineGeometry;
            this._strokeMaterial = lineMaterial;
            this._group.add(line);
        } else {
            this._strokeGeometry = new LineGeometry();

            this._strokeMaterial = new LineMaterial({
                color: this._strokeColor,
                linewidth: this._strokeWidth,
                opacity: this._strokeOpacity,
                transparent: this._strokeOpacity < 1,
                depthTest: this._depthTest,
                depthWrite: this._depthWrite,
                resolution: new THREE.Vector2(canvas.width, canvas.height)
            });
            const line = new Line2(this._strokeGeometry, this._strokeMaterial);
            line.renderOrder = POLYGON_RENDER_ORDER.STROKE;
            this._strokeLine = line;
            this._group.add(line);
        }
    }

    /**
     * Удаляет полигон с карты, освобождает все ресурсы и удаляет подпись.
     *
     * @returns {void}
     */
    remove() {
        // Отписываемся от InteractionManager.
        if (this._unregisterInteraction) {
            this._unregisterInteraction();
            this._unregisterInteraction = null;
        }

        if (this._group) {
            this._group.parent?.remove(this._group);
            this._fillGeometry?.dispose();
            this._fillMaterial?.dispose();
            this._bottomGeometry?.dispose();
            this._bottomMaterial?.dispose();
            this._sideGeometry?.dispose();
            this._sideMaterial?.dispose();
            this._strokeGeometry?.dispose();
            this._strokeMaterial?.dispose();
            this._fillMesh = null;
            this._bottomMesh = null;
            this._sideMesh = null;
            this._strokeLine = null;
            this._fillGeometry = null;
            this._fillMaterial = null;
            this._bottomGeometry = null;
            this._bottomMaterial = null;
            this._sideGeometry = null;
            this._sideMaterial = null;
            this._strokeGeometry = null;
            this._strokeMaterial = null;
        }
        if (this._textLabel && this._map?.textManager) {
            this._map.textManager.removeLabel(this._textLabel);
            this._textLabel = null;
        }
        this._worldCoords.length = 0;
        this._strokeWorldCoords.length = 0;
        this._vertices2D.length = 0;
        this._boundingSphereRadius = 0;
        this._cachedHeights.length = 0;
        this._cachedStrokeHeights.length = 0;
        this._isHovered = false;
        this._raycastMeshesCache = null;
        this._invalidGeometry = false;

        this._layer?._removeRef(this);
        this._layer = null;
        this._map = null;
        this._crs = null;
    }

    /**
     * Обновляет состояние полигона на каждом кадре: видимость по зуму,
     * высоты и позицию центроида.
     *
     * Полигоны с невалидной геометрией всегда невидимы и не обновляются.
     *
     * @param {import('./KrbMap.js').KrbMap} map - Экземпляр карты.
     * @returns {void}
     * @private
     */
    _update(map) {
        if (!this._map || !this._group) return;

        // Полигон забракован на этапе построения геометрии —
        // держим его скрытым и не тратим CPU на высоты/центроид.
        if (this._invalidGeometry) {
            this._group.visible = false;
            return;
        }

        const zoom = this._map.continuousZoom;

        if (this._layer && !this._layer.visible) {
            this._group.visible = false;
            return;
        }
        if (zoom < this._minZoom || zoom > this._maxZoom) {
            this._group.visible = false;
            return;
        }

        if (this._group.parent !== this._map.worldGroup) {
            this._group.parent?.remove(this._group);
            this._map.worldGroup.add(this._group);
        }

        if (this._strokeMaterial && this._strokeMaterial.resolution) {
            const canvas = this._map.renderer.domElement;
            const res = this._strokeMaterial.resolution;
            if (res.x !== canvas.width || res.y !== canvas.height) {
                res.set(canvas.width, canvas.height);
            }
        }

        if (this._boundingSphereRadius > 0) {
            const maxDist = map.maxObjectDistance;
            if (maxDist !== Infinity) {
                const worldCenter = map.getVec3()
                    .copy(this._group.position)
                    .add(map.worldGroup.position);
                const distToCenter = map.camera.position.distanceTo(worldCenter);
                if (distToCenter - this._boundingSphereRadius > maxDist) {
                    this._group.visible = false;
                    return;
                }
            }
        }

        this._group.visible = true;

        const now = performance.now();
        const worldGroupPosChanged = !this._lastWorldGroupPos.equals(map.worldGroup.position);
        const discreteZoomChanged = this._lastDiscreteZoom !== map.currentDiscreteZoom;

        if (worldGroupPosChanged || discreteZoomChanged) {
            this._heightsDirty = true;
            this._lastWorldGroupPos.copy(map.worldGroup.position);
            this._lastDiscreteZoom = map.currentDiscreteZoom;
        }

        // Таймерный пересчёт высот имеет смысл, только если высоты
        // действительно меняются (есть рельеф и режим clampToGround).
        // Иначе после первого прохода полигон сам себя зафиксирует
        // (см. _heightsFinalized внутри _updateHeights).
        const isDynamicHeight = map.hasElevation && this._altitudeMode === 'clampToGround';
        const timeExpired = isDynamicHeight
            && (now - this._lastHeightUpdateTime) >= this._heightUpdateInterval;

        if (this._heightsDirty || timeExpired) {
            const changed = this._updateHeights();
            if (changed) this._updateStroke();
            this._heightsDirty = false;
            this._lastHeightUpdateTime = now;
        }

        this._updateCentroidScreenPos();
    }

    /**
     * Обновляет высоты вершин всех геометрий в соответствии с режимом
     * высоты и экструзией. После изменения позиций принудительно
     * пересчитывает bounding sphere каждой геометрии — иначе frustum
     * culling отсекает меши, «уехавшие» по Y.
     *
     * @returns {boolean} `true`, если высоты были пересчитаны.
     * @private
     */
    _updateHeights() {
        if (this._invalidGeometry) return false;
        if (!this._fillGeometry || !this._vertices2D.length) return false;
        const map = this._map;

        // Fast-path: если высоты статичны и уже зафиксированы — не тратим CPU.
        const isDynamic = map.hasElevation && this._altitudeMode === 'clampToGround';
        if (!isDynamic && this._heightsFinalized) return false;

        const wgPos = map.worldGroup.position;

        for (let i = 0; i < this._vertices2D.length; i++) {
            const worldCoord = this._worldCoords[i];
            if (!worldCoord) continue;
            let base = this._altitudeOffset;
            if (isDynamic) {
                const worldX = worldCoord[0] + wgPos.x;
                const worldZ = worldCoord[1] + wgPos.z;
                map.ensureTileForPoint?.(worldX, worldZ);
                base = map.getSurfaceHeightAt(worldX, worldZ) + this._altitudeOffset;
            }
            const upperY = base + this._minHeight + (this._extruded ? this._height : 0);
            this._cachedHeights[i] = upperY;
        }

        // Согласуем длину _cachedStrokeHeights с фактической длиной
        // _strokeWorldCoords (а не с длиной исходного внешнего кольца,
        // которая может быть больше из-за замыкающей точки).
        const strokeLen = this._strokeWorldCoords.length;
        if (this._cachedStrokeHeights.length !== strokeLen) {
            this._cachedStrokeHeights = new Array(strokeLen).fill(0);
        }
        for (let i = 0; i < strokeLen; i++) {
            const worldCoord = this._strokeWorldCoords[i];
            if (!worldCoord) continue;
            let base = this._altitudeOffset;
            if (isDynamic) {
                const worldX = worldCoord[0] + wgPos.x;
                const worldZ = worldCoord[1] + wgPos.z;
                map.ensureTileForPoint?.(worldX, worldZ);
                base = map.getSurfaceHeightAt(worldX, worldZ) + this._altitudeOffset;
            }
            this._cachedStrokeHeights[i] = base + this._minHeight + (this._extruded ? this._height : 0);
        }

        // Верхняя крышка.
        const topPos = this._fillGeometry.attributes.position.array;
        for (let i = 0; i < this._vertices2D.length; i++) {
            topPos[i * 3 + 1] = this._cachedHeights[i];
        }
        this._fillGeometry.attributes.position.needsUpdate = true;
        this._fillGeometry.computeBoundingSphere();

        // Нижняя крышка.
        if (this._bottomGeometry) {
            const bottomPos = this._bottomGeometry.attributes.position.array;
            for (let i = 0; i < this._vertices2D.length; i++) {
                bottomPos[i * 3 + 1] = this._cachedHeights[i] - this._height;
            }
            this._bottomGeometry.attributes.position.needsUpdate = true;
            this._bottomGeometry.computeBoundingSphere();
        }

        // Боковые стенки.
        if (this._sideGeometry) {
            const sidePos = this._sideGeometry.attributes.position.array;
            let idx = 0;
            for (let i = 0; i < this._vertices2D.length; i++) {
                const j = (i + 1) % this._vertices2D.length;
                const upperI = this._cachedHeights[i];
                const upperJ = this._cachedHeights[j];
                const lowerI = upperI - this._height;
                const lowerJ = upperJ - this._height;

                // порядок вершин: upper I, lower I, upper J, lower J
                sidePos[idx * 3 + 1] = upperI;
                idx++;
                sidePos[idx * 3 + 1] = lowerI;
                idx++;
                sidePos[idx * 3 + 1] = upperJ;
                idx++;
                sidePos[idx * 3 + 1] = lowerJ;
                idx++;
            }
            this._sideGeometry.attributes.position.needsUpdate = true;
            this._sideGeometry.computeVertexNormals();
            this._sideGeometry.computeBoundingSphere();
        }

        if (!isDynamic) this._heightsFinalized = true;
        return true;
    }

    /**
     * Обновляет позиции вершин обводки.
     *
     * Обход ведётся по фактической длине `_strokeWorldCoords`
     * (а не по длине исходного внешнего кольца), так как дубликат
     * замыкающей точки отбрасывается в `_buildStrokeGeometry`.
     * Замыкающий сегмент добавляется отдельно в конце.
     *
     * Для `useSimpleStroke` атрибут `position` переиспользуется между
     * вызовами (обновляется in-place), если его размер не изменился.
     *
     * @returns {void}
     * @private
     */
    _updateStroke() {
        if (this._invalidGeometry) return;
        if (!this._strokeLine || !this._strokeGeometry) return;
        const positions = this._strokePositionsArray;
        positions.length = 0;
        const groupPos = this._group.position;
        const strokeLen = this._strokeWorldCoords.length;

        for (let i = 0; i < strokeLen; i++) {
            const worldCoord = this._strokeWorldCoords[i];
            if (!worldCoord) continue;
            const y = this._cachedStrokeHeights[i] ?? this._altitudeOffset;
            positions.push(worldCoord[0] - groupPos.x, y, worldCoord[1] - groupPos.z);
        }

        // Замыкающая точка (визуально соединяет последнюю вершину с первой).
        if (strokeLen > 0) {
            const first = this._strokeWorldCoords[0];
            const fy = this._cachedStrokeHeights[0] ?? this._altitudeOffset;
            positions.push(first[0] - groupPos.x, fy, first[1] - groupPos.z);
        }

        if (this._useSimpleStroke) {
            const count = positions.length / 3;
            const existing = this._strokeGeometry.getAttribute('position');
            if (existing && existing.count === count) {
                existing.array.set(positions);
                existing.needsUpdate = true;
                this._strokeGeometry.computeBoundingSphere();
            } else {
                this._strokeGeometry.setAttribute(
                    'position',
                    new THREE.BufferAttribute(new Float32Array(positions), 3)
                );
                this._strokeGeometry.computeBoundingSphere();
            }
        } else {
            this._strokeGeometry.setPositions(positions);
            this._strokeLine.computeLineDistances();
        }
    }

    /**
     * Пересчитывает экранную позицию центроида полигона для подписи.
     *
     * Использует пул временных векторов карты (`map.getVec3()`) —
     * без аллокаций `new THREE.Vector3` в горячем пути.
     *
     * @returns {void}
     * @private
     */
    _updateCentroidScreenPos() {
        if (this._invalidGeometry) {
            this._centroidScreenPos = null;
            return;
        }
        if (!this._map || !this._centroidWorld) {
            this._centroidScreenPos = null;
            return;
        }
        const map = this._map;
        const wgPos = map.worldGroup.position;
        const worldX = this._centroidWorld.x + wgPos.x;
        const worldZ = this._centroidWorld.z + wgPos.z;

        let worldY = this._altitudeOffset;
        if (this._altitudeMode === 'clampToGround' && map.hasElevation) {
            const now = performance.now();
            if (now - this._lastCentroidHeightUpdateTime > this._heightUpdateInterval) {
                map.ensureTileForPoint(worldX, worldZ);
                this._cachedCentroidHeight = map.getSurfaceHeightAt(worldX, worldZ);
                this._lastCentroidHeightUpdateTime = now;
            }
            worldY = (this._cachedCentroidHeight ?? 0) + this._altitudeOffset;
        }
        worldY += this._minHeight + (this._extruded ? this._height : 0);

        // Проекция выполняется in-place над вектором из пула.
        const screenPos = map.getVec3().set(worldX, worldY + wgPos.y, worldZ);
        screenPos.project(map.camera);
        if (screenPos.z > 1 || Math.abs(screenPos.x) > 1 || Math.abs(screenPos.y) > 1) {
            this._centroidScreenPos = null;
        } else {
            const canvas = map.renderer.domElement;
            this._centroidScreenPos = {
                x: (screenPos.x * 0.5 + 0.5) * canvas.clientWidth,
                y: (-screenPos.y * 0.5 + 0.5) * canvas.clientHeight
            };
        }
    }

    // ---------- Интерфейс для TextManager ----------

    /**
     * Возвращает текст подписи.
     *
     * @returns {string} Текст подписи.
     */
    getText() { return this._title; }

    /**
     * Возвращает объект CSS-стилей подписи.
     *
     * @returns {Object} Объект CSS-стилей подписи.
     */
    getTextStyle() {
        return Object.assign({
            fontFamily: 'sans-serif',
            color: '#333',
            fontSize: '12px',
            textAlign: this._titleAlign
        }, this._titleStyle);
    }

    /**
     * Возвращает границы зума для отображения подписи.
     *
     * @returns {{min: number, max: number}} Границы зума.
     */
    getTextZoomBounds() { return { min: this._titleMinZoom, max: this._titleMaxZoom }; }

    /**
     * Возвращает тип подписи.
     *
     * @returns {string} Тип подписи ('polygon').
     */
    getLabelType() { return 'polygon'; }

    /**
     * Проверяет, видим ли полигон в текущем кадре.
     *
     * @returns {boolean} Результат проверки видимости.
     */
    isVisible() { return this._group?.visible ?? false; }

    /**
     * Возвращает экранную позицию центроида.
     *
     * @returns {{x: number, y: number}|null} Экранная позиция центроида (или null).
     */
    getScreenPosition() { return this._centroidScreenPos; }

    /**
     * Возвращает горизонтальное выравнивание подписи.
     *
     * @returns {string} Горизонтальное выравнивание подписи.
     */
    getTitleAlign() { return this._titleAlign; }

    /**
     * Возвращает смещение подписи в пикселях.
     *
     * @returns {Array.<number>} Смещение подписи в пикселях.
     */
    getTitleOffset() { return this._titleOffset; }

    /**
     * Возвращает вертикальное выравнивание.
     *
     * @returns {string} Вертикальное выравнивание (всегда 'center').
     */
    getTitleVerticalAlign() { return 'center'; }

    /**
     * Проверяет, разрешён ли выход подписи за границы.
     *
     * @returns {boolean} Разрешён ли выход подписи за границы.
     */
    getAllowOverflow() { return this._titleAllowOverflow; }

    /**
     * Возвращает приоритет подписи.
     *
     * @returns {number} Приоритет подписи.
     */
    getPriority() { return this._titlePriority; }

    // ---------- Интерфейс для KrbMap#fitTo / getBounds ----------

    /**
     * Возвращает прямоугольник (bounding box), охватывающий полигон
     * целиком, включая все кольца (внешнее и отверстия).
     *
     * Используется методом {@link KrbMap#fitTo} для подгонки вида.
     * Если полигон привязан к карте (`_crs` резолвлена), координаты
     * преобразуются из его СК. Если не привязан, но задан `_crsCode` —
     * из него. В остальных случаях исходные координаты считаются уже
     * в WGS84 (это соответствует поведению конструктора по умолчанию,
     * где `map.inputCRS` = EPSG:4326).
     *
     * @param {string|import('./Projections.js').Projection} [crs='EPSG:4326'] -
     *     Целевая СК для результата (код или объект Projection).
     * @returns {Array.<Array.<number>>|null} [[minX, minY], [maxX, maxY]]
     *     или null, если у полигона нет колец или преобразование невозможно.
     *
     * @example
     * const b = polygon.getBounds();                 // → [[30.5, 50.4], [31.0, 50.7]]
     * const bUtm = polygon.getBounds('EPSG:32637');  // → [[413500, 6178000], ...]
     */
    getBounds(crs = 'EPSG:4326') {
        if (!this._rings || !this._rings.length) return null;

        const src = this._crs
            ?? (this._crsCode ? Projections.get(this._crsCode) : Projections.get('EPSG:4326'));
        const dst = typeof crs === 'string' ? Projections.get(crs) : crs;
        if (!src || !dst) return null;

        const sameProjection = src === dst;
        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
        let count = 0;

        for (const ring of this._rings) {
            if (!ring) continue;
            for (let i = 0; i < ring.length; i++) {
                const pt = ring[i];
                if (!pt || pt.length < 2) continue;
                let x, y;
                if (sameProjection) {
                    x = pt[0];
                    y = pt[1];
                } else {
                    const lonLat = src.toLonLat(pt);
                    const converted = dst.fromLonLat(lonLat);
                    x = converted[0];
                    y = converted[1];
                }
                if (x < minX) minX = x;
                if (x > maxX) maxX = x;
                if (y < minY) minY = y;
                if (y > maxY) maxY = y;
                count++;
            }
        }
        if (count === 0 || !isFinite(minX)) return null;
        return [[minX, minY], [maxX, maxY]];
    }
}