/**
 * Модуль для рисования полигонов (многоугольников) на карте.
 * Предоставляет класс Polygon, использующий триангуляцию Earcut
 * для заливки и "толстые" линии для обводки, с поддержкой высот,
 * экструзии, видимости по зуму и подписей через TextManager.
 * Добавлена поддержка событий onHover и onClick через raycasting,
 * а также возможность отображения HTML-тултипа через PopupManager.
 *
 * Оптимизирован для большого количества полигонов: кэширование
 * преобразованных координат, dirty-флаги для высот, bounding sphere
 * для отсечения по расстоянию и быстрый предварительный raycasting.
 * Дополнительно: единый обработчик событий мыши для всех полигонов,
 * переиспользование массивов, опция использования обычных линий,
 * а также (опционально) встроенный Web Worker для триангуляции.
 *
 * Экструдированные полигоны (extruded: true) используют MeshStandardMaterial
 * и участвуют в shadow mapping (castShadow/receiveShadow), поэтому на них
 * работают тени так же, как на Marker3D. Для корректного освещения нормали
 * верхней/нижней крышек задаются явно ((0,1,0) и (0,-1,0)), а обход
 * треугольников Earcut при необходимости инвертируется, чтобы нормаль
 * совпадала с направлением фронтальной грани.
 *
 * ВАЖНО: для отображения теней у рендера должно быть включено
 * `renderer.shadowMap.enabled = true`, и хотя бы один источник света
 * должен иметь `castShadow = true`.
 */

import { proj } from './Utils.js';
import {
  THREE,
  Line2,
  LineMaterial,
  LineGeometry,
} from '../js_TP/tpb.js';
import { Layer } from './Layers.js';
import earcut from '../js_TP/earcut.js';

/**
 * Вычисляет минимальное расстояние от точки до отрезка.
 *
 * @param {THREE.Vector3} point - Точка.
 * @param {THREE.Vector3} a - Начало отрезка.
 * @param {THREE.Vector3} b - Конец отрезка.
 * @returns {number} Расстояние.
 * @private
 */
function pointToSegmentDistance(point, a, b) {
    const ab = new THREE.Vector3().subVectors(b, a);
    const ap = new THREE.Vector3().subVectors(point, a);
    const abLenSq = ab.lengthSq();
    if (abLenSq === 0) return point.distanceTo(a); // вырожденный отрезок
    let t = ap.dot(ab) / abLenSq;
    t = Math.max(0, Math.min(1, t));
    const closest = new THREE.Vector3().copy(a).addScaledVector(ab, t);
    return point.distanceTo(closest);
}

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
 * Поддерживает заливку, обводку, настройку высот, экструзию (объём),
 * ограничения по зуму, текстовую подпись, а также обработчики событий
 * наведения (onHover) и клика (onClick).
 * Всплывающие подсказки обрабатываются централизованно через PopupManager
 * (доступен как `map.popupManager`).
 *
 * Для экструдированных полигонов (extruded: true) материалы создаются на
 * основе MeshStandardMaterial, а меши помечаются castShadow/receiveShadow —
 * так же, как в Marker3D. Для корректного освещения нормали верхней/нижней
 * крышек задаются явно, а обход треугольников Earcut согласуется с этими
 * нормалями, чтобы шейдерная логика three.js (флип нормалей на back-face
 * при DoubleSide) давала правильный результат с любой стороны.
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
 *     height: 500,      // толщина экструзии в метрах
 *     minHeight: 200,   // высота нижней грани над поверхностью в метрах
 *     fillColor: '#ff8800',
 *     fillOpacity: 0.9,
 *     strokeColor: '#000000',
 *     strokeWidth: 3,
 *     altitudeMode: 'clampToGround',
 *     altitudeOffset: 10,
 *     depthTest: true,
 *     depthWrite: true,
 *     castShadow: true,
 *     receiveShadow: true,
 *     title: 'Объёмный полигон'
 * });
 * extrudedPolygon.addTo(map);
 */
export class Polygon {
    /**
     * Инициализирует новый экземпляр полигона с заданными настройками.
     *
     * @param {Object} options - Настройки полигона.
     * @param {Array.<Array.<Array.<number>>>} options.rings - Массив колец. Первое кольцо – внешний контур, остальные (опционально) – отверстия. Каждое кольцо – массив точек [долгота, широта].
     * @param {string} [options.fillColor='#3388ff'] - Цвет заливки (CSS).
     * @param {number} [options.fillOpacity=0.5] - Прозрачность заливки (0..1).
     * @param {string} [options.strokeColor='#000000'] - Цвет обводки.
     * @param {number} [options.strokeWidth=2] - Толщина обводки в пикселях.
     * @param {number} [options.strokeOpacity=1] - Прозрачность обводки.
     * @param {string} [options.altitudeMode='clampToGround'] - Режим высоты: 'clampToGround' (прилегать к рельефу) или 'absolute' (постоянная высота).
     * @param {number} [options.altitudeOffset=10] - Добавочная высота над поверхностью (или базовая высота для absolute).
     * @param {boolean} [options.extruded=false] - Включить экструзию (объёмный полигон).
     * @param {number} [options.height=0] - Толщина экструзии в метрах (только если extruded=true).
     * @param {number} [options.minHeight=0] - Высота нижней грани над поверхностью в метрах (только если extruded=true).
     * @param {boolean} [options.depthTest=false] - Включить тест глубины.
     * @param {boolean} [options.depthWrite=false] - Включить запись в буфер глубины.
     * @param {boolean} [options.castShadow=true] - Отбрасывать тень (применяется только к extruded=true).
     * @param {boolean} [options.receiveShadow=true] - Принимать тень (применяется только к extruded=true).
     * @param {number} [options.roughness=0.8] - Шероховатость PBR-материала (только для extruded=true).
     * @param {number} [options.metalness=0.0] - Металличность PBR-материала (только для extruded=true).
     * @param {number} [options.minZoom=-Infinity] - Минимальный зум, при котором полигон виден.
     * @param {number} [options.maxZoom=Infinity] - Максимальный зум, при котором полигон виден.
     * @param {string} [options.title=''] - Текст постоянной подписи.
     * @param {Array.<number>} [options.titleOffset=[0,0]] - Смещение подписи в пикселях.
     * @param {string} [options.titleAlign='center'] - Горизонтальное выравнивание подписи ('left', 'center', 'right').
     * @param {Object} [options.titleStyle={}] - CSS-стили подписи.
     * @param {number} [options.titleMinZoom=-Infinity] - Минимальный зум для отображения подписи.
     * @param {number} [options.titleMaxZoom=Infinity] - Максимальный зум для отображения подписи.
     * @param {boolean} [options.titleAllowOverflow=false] - Разрешить выход подписи за границы экрана.
     * @param {number} [options.titlePriority=0] - Приоритет подписи (чем выше, тем приоритетнее).
     * @param {function} [options.onClick] - Callback при клике по полигону. Получает событие и экземпляр полигона.
     * @param {function} [options.onHover] - Callback при наведении/убирании курсора. Получает `true`/`false`.
     * @param {string} [options.tooltip=''] - Текст всплывающей подсказки (HTML), показывается через PopupManager при наведении или клике (если не задан onClick/onHover).
     * @param {boolean} [options.useSimpleStroke=false] - Использовать обычный THREE.Line вместо Line2 для обводки (быстрее, но ширина 1px).
     * @param {boolean} [options.useWorkerForTriangulation=false] - Выполнять триангуляцию в Web Worker (экспериментально, требует асинхронной инициализации).
     * @throws {Error} Если не передан массив колец или он пуст.
     * @throws {Error} Если extruded=true и height не положительное число.
     */
    constructor(options = {}) {
        if (!options.rings || !options.rings.length || !options.rings[0].length) {
            throw new Error('Polygon: options.rings required with at least one ring');
        }
        /** @private */ this._rings = options.rings;
        /** @private */ this._fillColor = options.fillColor || '#3388ff';
        /** @private */ this._fillOpacity = options.fillOpacity ?? 0.5;
        /** @private */ this._strokeColor = options.strokeColor || '#000000';
        /** @private */ this._strokeWidth = options.strokeWidth ?? 2;
        /** @private */ this._strokeOpacity = options.strokeOpacity ?? 1;
        /** @private */ this._altitudeMode = options.altitudeMode || 'clampToGround';
        /** @private */ this._altitudeOffset = options.altitudeOffset ?? 10;
        /** @private */ this._depthTest = options.depthTest ?? false;
        /** @private */ this._depthWrite = options.depthWrite ?? false;
        /** @private */ this._minZoom = options.minZoom ?? -Infinity;
        /** @private */ this._maxZoom = options.maxZoom ?? Infinity;
        /** @private */ this._useSimpleStroke = options.useSimpleStroke ?? false;
        /** @private */ this._useWorkerForTriangulation = options.useWorkerForTriangulation ?? false;

        // Экструзия
        /** @private */ this._extruded = options.extruded ?? false;
        /** @private */ this._height = options.height ?? 0;
        /** @private */ this._minHeight = options.minHeight ?? 0;
        if (this._extruded && (typeof this._height !== 'number' || this._height <= 0)) {
            throw new Error('Polygon: options.height must be a positive number when extruded is true');
        }

        // Тени и PBR-параметры (применяются только при extruded=true)
        /** @private */ this._castShadow = options.castShadow ?? true;
        /** @private */ this._receiveShadow = options.receiveShadow ?? true;
        /** @private */ this._roughness = options.roughness ?? 0.8;
        /** @private */ this._metalness = options.metalness ?? 0.0;

        // Подпись
        /** @private */ this._title = options.title || '';
        /** @private */ this._titleOffset = options.titleOffset || [0, 0];
        /** @private */ this._titleAlign = options.titleAlign || 'center';
        /** @private */ this._titleStyle = options.titleStyle || {};
        /** @private */ this._titleMinZoom = options.titleMinZoom ?? -Infinity;
        /** @private */ this._titleMaxZoom = options.titleMaxZoom ?? Infinity;

        // События мыши
        /** @private */ this._onClick = options.onClick || null;
        /** @private */ this._onHover = options.onHover || null;
        /** @private */ this._isHovered = false;
        /** @private */ this._boundHandlers = null;

        // Тултип
        /** @private */ this._tooltipText = options.tooltip || '';

        // Внутренние структуры
        /** @private */ this._map = null;
        /** @private */ this._layer = null;
        /** @private */ this._group = new THREE.Group();

        // Верхняя крышка
        /** @private */ this._fillMesh = null;
        /** @private */ this._fillGeometry = null;
        /** @private */ this._fillMaterial = null;

        // Нижняя крышка
        /** @private */ this._bottomMesh = null;
        /** @private */ this._bottomGeometry = null;
        /** @private */ this._bottomMaterial = null;

        // Боковые стенки
        /** @private */ this._sideMesh = null;
        /** @private */ this._sideGeometry = null;
        /** @private */ this._sideMaterial = null;
        /** @private */ this._sideVertexCount = 0;

        // Обводка
        /** @private */ this._strokeLine = null;
        /** @private */ this._strokeGeometry = null;
        /** @private */ this._strokeMaterial = null;

        // Кэш высот
        /** @private */ this._cachedHeights = new Array(this._rings[0]?.length ?? 0).fill(0);
        /** @private */ this._cachedStrokeHeights = new Array(this._rings[0]?.length ?? 0).fill(0);
        /** @private */ this._lastHeightUpdateTime = 0;
        /** @private */ this._heightUpdateInterval = 500;

        // 2D вершины и центроид
        /** @private */ this._vertices2D = [];
        /** @private */ this._centroidWorld = new THREE.Vector3();
        /** @private */ this._cachedCentroidHeight = 0;
        /** @private */ this._lastCentroidHeightUpdateTime = 0;

        // Кэш мировых координат и bounding sphere
        /** @private */ this._worldCoords = [];
        /** @private */ this._strokeWorldCoords = [];
        /** @private */ this._boundingSphereRadius = 0;
        /** @private */ this._boundingSphereWorld = new THREE.Sphere();

        // Dirty-флаги
        /** @private */ this._heightsDirty = true;
        /** @private */ this._lastWorldGroupPos = new THREE.Vector3();
        /** @private */ this._lastDiscreteZoom = -1;

        // Подпись
        /** @private */ this._centroidScreenPos = null;
        /** @private */ this._textLabel = null;
        /** @private */ this._titleAllowOverflow = options.titleAllowOverflow || false;
        /** @private */ this._titlePriority = options.titlePriority ?? 0;

        // Переиспользуемые массивы
        /** @private */ this._strokePositionsArray = [];
        /** @private */ this._sidePositionsArray = [];
        /** @private */ this._sideIndicesArray = [];
        /** @private */ this._tempVec3 = new THREE.Vector3();

        // Регистрация в реестре интерактивных полигонов
        if (this._onClick || this._onHover || this._tooltipText) {
            Polygon._registerInteractivePolygon(this);
        }
    }

    /* ================================================================
       Статический реестр интерактивных полигонов
       ================================================================ */

    /** @private */ static _interactivePolygons = new Set();
    /** @private */ static _eventListenersAttached = false;
    /** @private */ static _delegatedHandlers = null;

    /**
     * Регистрирует полигон для обработки событий мыши через общий обработчик.
     *
     * @param {Polygon} polygon - Экземпляр полигона.
     * @private
     */
    static _registerInteractivePolygon(polygon) {
        Polygon._interactivePolygons.add(polygon);
        if (!Polygon._eventListenersAttached) {
            Polygon._attachGlobalListeners();
        }
    }

    /**
     * Удаляет полигон из реестра интерактивных.
     *
     * @param {Polygon} polygon - Экземпляр полигона.
     * @private
     */
    static _unregisterInteractivePolygon(polygon) {
        Polygon._interactivePolygons.delete(polygon);
        if (Polygon._interactivePolygons.size === 0 && Polygon._eventListenersAttached) {
            Polygon._detachGlobalListeners();
        }
    }

    /**
     * Добавляет глобальные обработчики событий на canvas.
     *
     * @private
     */
    static _attachGlobalListeners() {
        const canvas = Polygon._getCanvas();
        if (!canvas) return;

        Polygon._delegatedHandlers = {
            mousedown: (e) => Polygon._handleGlobalMouseDown(e),
            mousemove: (e) => Polygon._handleGlobalMouseMove(e),
            click: (e) => Polygon._handleGlobalClick(e)
        };

        canvas.addEventListener('mousedown', Polygon._delegatedHandlers.mousedown, true);
        canvas.addEventListener('mousemove', Polygon._delegatedHandlers.mousemove, true);
        canvas.addEventListener('click', Polygon._delegatedHandlers.click, true);
        Polygon._eventListenersAttached = true;
    }

    /**
     * Удаляет глобальные обработчики.
     *
     * @private
     */
    static _detachGlobalListeners() {
        const canvas = Polygon._getCanvas();
        if (!canvas || !Polygon._delegatedHandlers) return;

        canvas.removeEventListener('mousedown', Polygon._delegatedHandlers.mousedown, true);
        canvas.removeEventListener('mousemove', Polygon._delegatedHandlers.mousemove, true);
        canvas.removeEventListener('click', Polygon._delegatedHandlers.click, true);
        Polygon._delegatedHandlers = null;
        Polygon._eventListenersAttached = false;
    }

    /**
     * Возвращает canvas, к которому привязаны обработчики.
     *
     * @returns {HTMLCanvasElement|null}
     * @private
     */
    static _getCanvas() {
        for (const poly of Polygon._interactivePolygons) {
            if (poly._map && poly._map.renderer && poly._map.renderer.domElement) {
                return poly._map.renderer.domElement;
            }
        }
        return null;
    }

    /**
     * Глобальный обработчик mousedown.
     *
     * @param {MouseEvent} event - Событие мыши.
     * @private
     */
    static _handleGlobalMouseDown(event) {
        for (const poly of Polygon._interactivePolygons) {
            if (poly._raycastPolygon(event, poly._map)) {
                // Событие обрабатываем, но всплытие не останавливаем.
            }
        }
    }

    /**
     * Глобальный обработчик mousemove.
     *
     * @param {MouseEvent} event - Событие мыши.
     * @private
     */
    static _handleGlobalMouseMove(event) {
        for (const poly of Polygon._interactivePolygons) {
            poly._handleMouseMove(event, poly._map);
        }
    }

    /**
     * Глобальный обработчик click.
     *
     * @param {MouseEvent} event - Событие мыши.
     * @private
     */
    static _handleGlobalClick(event) {
        for (const poly of Polygon._interactivePolygons) {
            poly._handleClick(event, poly._map);
        }
    }

    /* ================================================================
       Публичные методы
       ================================================================ */

    /**
     * Создаёт персональный слой, добавляет его на карту и помещает в него данный полигон.
     *
     * @param {Object} map - Экземпляр карты.
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
     * Вызывается слоем при добавлении, строит геометрию и регистрирует подпись.
     *
     * @param {Object} map - Экземпляр карты.
     * @param {Layer} layer - Слой-владелец.
     * @returns {void}
     * @private
     */
    _attach(map, layer) {
        if (this._map === map && this._layer === layer) return;
        this.remove();
        this._map = map;
        this._layer = layer;

        this._buildFillGeometry(map);
        this._buildStrokeGeometry(map);
        map.worldGroup.add(this._group);

        if (this._title && map.textManager) {
            this._textLabel = map.textManager.addLabel(this);
        }

        if (this._onClick || this._onHover || this._tooltipText) {
            if (!Polygon._eventListenersAttached) {
                Polygon._attachGlobalListeners();
            }
        }

        this._lastWorldGroupPos.copy(map.worldGroup.position);
        this._lastDiscreteZoom = map.currentDiscreteZoom;
        this._heightsDirty = true;
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
     * Для экструдированных полигонов используется MeshStandardMaterial
     * (участвует в освещении и shadow mapping). Для плоских — MeshBasicMaterial,
     * который просто заливает геометрию заданным цветом без реакции на свет.
     *
     * @returns {THREE.Material} Материал поверхности.
     * @private
     */
    _createSurfaceMaterial() {
        if (this._extruded) {
            return new THREE.MeshStandardMaterial({
                color: this._fillColor,
                opacity: this._fillOpacity,
                transparent: this._fillOpacity < 1,
                side: THREE.DoubleSide,
                roughness: this._roughness,
                metalness: this._metalness,
                depthTest: this._depthTest,
                depthWrite: this._depthWrite
            });
        }
        return new THREE.MeshBasicMaterial({
            color: this._fillColor,
            opacity: this._fillOpacity,
            transparent: this._fillOpacity < 1,
            side: THREE.DoubleSide,
            depthTest: this._depthTest,
            depthWrite: this._depthWrite
        });
    }

    /**
     * Применяет флаги теней к мешу, если полигон экструдированный.
     * Для плоских полигонов ничего не делает.
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
     * Инвертирует обход треугольников (swap 2-го и 3-го индексов в каждом треугольнике).
     * Возвращает новый массив, исходный не изменяется.
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
     * Строит геометрию заливки полигона с использованием триангуляции Earcut.
     * Для экструдированных полигонов дополнительно создаёт нижнюю крышку и боковые стенки.
     *
     * @param {Object} map - Экземпляр карты.
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
                const [lon, lat] = ring[i];
                const [absX, absZ] = proj.fromLonLat([lon, lat]);
                if (i === 0) {
                    firstPoint = [absX, absZ];
                }
                if (i > 0 && absX === firstPoint[0] && absZ === firstPoint[1]) {
                    continue; // замыкающая точка
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

        this._vertices2D = points2D;
        this._cachedHeights = new Array(points2D.length).fill(0);

        // Триангуляция
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

        // ▼▼▼ ВАЖНО: согласуем winding Earcut-вывода ▼▼▼
        // Верхняя крышка должна иметь CCW-обход при взгляде сверху (нормаль +Y),
        // чтобы при DoubleSide + MeshStandardMaterial освещение было корректным.
        // Если первый треугольник даёт нормаль вниз — инвертируем обход всего массива.
        const firstCrossY = crossY(points2D[indices[0]], points2D[indices[1]], points2D[indices[2]]);
        const topIndices = firstCrossY >= 0 ? indices : this._flipIndices(indices);
        // Нижняя крышка — та же геометрия в XZ, но с противоположным обходом
        // (фронтальная грань смотрит вниз, нормаль -Y).
        const bottomIndices = this._flipIndices(topIndices);
        // ▲▲▲

        // Центроид
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

        // ▼▼▼ Верхняя крышка ▼▼▼
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

        // Явно задаём нормали +Y для верхней крышки.
        // Это избавляет от зависимости от computeVertexNormals() и гарантирует,
        // что шейдер MeshStandardMaterial получает корректную нормаль
        // независимо от того, как Earcut обошёл контур.
        const topNormals = new Float32Array(points2D.length * 3);
        for (let i = 0; i < points2D.length; i++) {
            topNormals[i * 3 + 1] = 1; // (0, 1, 0)
        }
        topGeometry.setAttribute('normal', new THREE.BufferAttribute(topNormals, 3));

        const topMaterial = this._createSurfaceMaterial();

        const topMesh = new THREE.Mesh(topGeometry, topMaterial);
        topMesh.renderOrder = 998;
        this._applyShadowFlags(topMesh);
        this._fillMesh = topMesh;
        this._fillGeometry = topGeometry;
        this._fillMaterial = topMaterial;
        this._group.add(topMesh);
        // ▲▲▲

        // ▼▼▼ Экструзия: нижняя крышка и боковые стенки ▼▼▼
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

            // Явные нормали -Y для нижней крышки.
            const bottomNormals = new Float32Array(points2D.length * 3);
            for (let i = 0; i < points2D.length; i++) {
                bottomNormals[i * 3 + 1] = -1; // (0, -1, 0)
            }
            bottomGeometry.setAttribute('normal', new THREE.BufferAttribute(bottomNormals, 3));

            const bottomMaterial = this._createSurfaceMaterial();

            const bottomMesh = new THREE.Mesh(bottomGeometry, bottomMaterial);
            bottomMesh.renderOrder = 998;
            this._applyShadowFlags(bottomMesh);
            this._bottomMesh = bottomMesh;
            this._bottomGeometry = bottomGeometry;
            this._bottomMaterial = bottomMaterial;
            this._group.add(bottomMesh);

            // Боковые стенки
            const sidePositions = this._sidePositionsArray;
            const sideIndices = this._sideIndicesArray;
            sidePositions.length = 0;
            sideIndices.length = 0;

            for (let ringIdx = 0; ringIdx < rings.length; ringIdx++) {
                if (ringStartIndices[ringIdx] === undefined) continue;

                const start = ringStartIndices[ringIdx];
                const nextRingStart = (ringIdx + 1 < ringStartIndices.length) ? ringStartIndices[ringIdx + 1] : points2D.length;
                const count = nextRingStart - start;

                if (count < 2) continue;

                for (let i = 0; i < count; i++) {
                    const j = (i + 1) % count;
                    const idxI = start + i;
                    const idxJ = start + j;

                    const topI = points2D[idxI];
                    const topJ = points2D[idxJ];

                    const baseIndex = sidePositions.length / 3;

                    sidePositions.push(topI.x, 0, topI.y);
                    sidePositions.push(topI.x, 0, topI.y);
                    sidePositions.push(topJ.x, 0, topJ.y);
                    sidePositions.push(topJ.x, 0, topJ.y);

                    sideIndices.push(baseIndex, baseIndex + 1, baseIndex + 2);
                    sideIndices.push(baseIndex + 1, baseIndex + 3, baseIndex + 2);
                }
            }

            const sideGeometry = new THREE.BufferGeometry();
            sideGeometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(sidePositions), 3));
            sideGeometry.setIndex(sideIndices);
            // Боковые стенки ориентированы по обходу кольца, поэтому computeVertexNormals()
            // даёт корректные нормали граней. DoubleSide + шейдерный флип для back-face
            // обеспечивают правильное освещение независимо от того, как именно
            // ориентирован обход входного кольца (CW или CCW).
            sideGeometry.computeVertexNormals();

            const sideMaterial = this._createSurfaceMaterial();

            const sideMesh = new THREE.Mesh(sideGeometry, sideMaterial);
            sideMesh.renderOrder = 998;
            this._applyShadowFlags(sideMesh);
            this._sideMesh = sideMesh;
            this._sideGeometry = sideGeometry;
            this._sideMaterial = sideMaterial;
            this._sideVertexCount = sidePositions.length / 3;
            this._group.add(sideMesh);
        }
        // ▲▲▲
    }

    /**
     * Строит геометрию обводки полигона. В зависимости от опций использует Line2 или обычный THREE.Line.
     *
     * @param {Object} map - Экземпляр карты.
     * @returns {void}
     * @private
     */
    _buildStrokeGeometry(map) {
        if (this._strokeWidth <= 0 || this._strokeOpacity <= 0) return;

        const canvas = map.renderer.domElement;

        if (this._useSimpleStroke) {
            const points = [];
            const outerRing = this._rings[0];
            for (let i = 0; i < outerRing.length; i++) {
                const [lon, lat] = outerRing[i];
                const [absX, absZ] = proj.fromLonLat([lon, lat]);
                points.push(new THREE.Vector3(absX, 0, absZ));
            }
            if (outerRing.length > 0) {
                const [lon, lat] = outerRing[0];
                const [absX, absZ] = proj.fromLonLat([lon, lat]);
                points.push(new THREE.Vector3(absX, 0, absZ));
            }

            const lineGeometry = new THREE.BufferGeometry().setFromPoints(points);
            const lineMaterial = new THREE.LineBasicMaterial({
                color: this._strokeColor,
                opacity: this._strokeOpacity,
                transparent: this._strokeOpacity < 1,
                depthTest: this._depthTest,
                depthWrite: this._depthWrite
            });
            const line = new THREE.Line(lineGeometry, lineMaterial);
            line.renderOrder = 999;
            this._strokeLine = line;
            this._strokeGeometry = lineGeometry;
            this._strokeMaterial = lineMaterial;
            this._group.add(line);

            this._strokeWorldCoords.length = 0;
            for (let i = 0; i < outerRing.length; i++) {
                const [lon, lat] = outerRing[i];
                const [absX, absZ] = proj.fromLonLat([lon, lat]);
                this._strokeWorldCoords.push([absX, absZ]);
            }
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
            line.renderOrder = 999;
            this._strokeLine = line;
            this._group.add(line);

            this._strokeWorldCoords.length = 0;
            const outerRing = this._rings[0];
            for (let i = 0; i < outerRing.length; i++) {
                const [lon, lat] = outerRing[i];
                const [absX, absZ] = proj.fromLonLat([lon, lat]);
                this._strokeWorldCoords.push([absX, absZ]);
            }
            this._cachedStrokeHeights = new Array(outerRing.length).fill(0);
        }
    }

    /**
     * Обрабатывает mousemove для делегированного события.
     *
     * @param {MouseEvent} event - Событие мыши.
     * @param {Object} map - Экземпляр карты.
     * @returns {void}
     * @private
     */
    _handleMouseMove(event, map) {
        if (!this._map || this._map !== map) return;
        const hit = this._raycastPolygon(event, map);
        if (hit) {
            if (!this._isHovered) {
                this._isHovered = true;
                if (this._onHover) {
                    this._onHover(true);
                } else if (this._tooltipText && map.popupManager) {
                    map.popupManager.show(this, this._tooltipText);
                }
            }
        } else {
            if (this._isHovered) {
                this._isHovered = false;
                if (this._onHover) {
                    this._onHover(false);
                } else if (this._tooltipText && map.popupManager) {
                    map.popupManager.hide();
                }
            }
        }
    }

    /**
     * Обрабатывает click для делегированного события.
     *
     * @param {MouseEvent} event - Событие мыши.
     * @param {Object} map - Экземпляр карты.
     * @returns {void}
     * @private
     */
    _handleClick(event, map) {
        if (!this._map || this._map !== map) return;
        if (!this._raycastPolygon(event, map)) return;

        if (this._onClick) {
            this._onClick(event, this);
        } else if (this._tooltipText && map.popupManager) {
            map.popupManager.show(this, this._tooltipText);
        }
    }

    /**
     * Проверяет, находится ли точка экрана над геометрией полигона.
     * Использует предварительную проверку bounding sphere.
     *
     * @param {MouseEvent} event - Событие мыши.
     * @param {Object} map - Экземпляр карты.
     * @returns {boolean} true, если луч пересекает хотя бы один меш полигона.
     * @private
     */
    _raycastPolygon(event, map) {
        if (!this._group.visible || this._boundingSphereRadius === 0) return false;

        const rect = map.renderer.domElement.getBoundingClientRect();
        const mouse = new THREE.Vector2(
            ((event.clientX - rect.left) / rect.width) * 2 - 1,
            -((event.clientY - rect.top) / rect.height) * 2 + 1
        );

        const raycaster = new THREE.Raycaster();
        raycaster.setFromCamera(mouse, map.camera);

        const worldCenter = this._tempVec3.copy(this._group.position).add(map.worldGroup.position);
        this._boundingSphereWorld.set(worldCenter, this._boundingSphereRadius);
        if (!raycaster.ray.intersectsSphere(this._boundingSphereWorld)) {
            return false;
        }

        const objects = [];
        if (this._fillMesh) objects.push(this._fillMesh);
        if (this._sideMesh) objects.push(this._sideMesh);
        if (this._bottomMesh) objects.push(this._bottomMesh);
        if (objects.length === 0) return false;

        const intersects = raycaster.intersectObjects(objects, false);
        return intersects.length > 0;
    }

    /**
     * Удаляет полигон с карты, освобождает все ресурсы и удаляет подпись.
     *
     * @returns {void}
     */
    remove() {
        if (this._map) {
            Polygon._unregisterInteractivePolygon(this);
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

        this._layer?._removeRef(this);
        this._layer = null;
        this._map = null;
    }

    /**
     * Обновляет состояние полигона на каждом кадре: видимость по зуму, высоты и позицию центроида.
     *
     * @param {Object} map - Экземпляр карты.
     * @returns {void}
     * @private
     */
    _update(map) {
        if (!this._map || !this._group) return;
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

        if (this._strokeMaterial) {
            const canvas = this._map.renderer.domElement;
            const res = this._strokeMaterial.resolution;
            if (res && (res.x !== canvas.width || res.y !== canvas.height)) {
                this._strokeMaterial.resolution.set(canvas.width, canvas.height);
            }
        }

        if (this._boundingSphereRadius > 0) {
            const maxDist = map.maxObjectDistance;
            if (maxDist !== Infinity) {
                const worldCenter = this._tempVec3.copy(this._group.position).add(map.worldGroup.position);
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
        const timeExpired = (now - this._lastHeightUpdateTime) >= this._heightUpdateInterval;

        if (worldGroupPosChanged || discreteZoomChanged) {
            this._heightsDirty = true;
            this._lastWorldGroupPos.copy(map.worldGroup.position);
            this._lastDiscreteZoom = map.currentDiscreteZoom;
        }

        if (this._heightsDirty || timeExpired) {
            this._updateHeights();
            this._updateStroke();
            this._heightsDirty = false;
            this._lastHeightUpdateTime = now;
        }

        this._updateCentroidScreenPos();
    }

    /**
     * Обновляет высоты вершин всех геометрий в соответствии с режимом высоты и экструзией.
     * Нормали крышек и стенок остаются неизменными (для плоских крышек они константны,
     * а небольшой наклон из-за рельефа даёт визуально приемлемый результат).
     *
     * @returns {void}
     * @private
     */
    _updateHeights() {
        if (!this._fillGeometry || !this._vertices2D.length) return;
        const map = this._map;
        const wgPos = map.worldGroup.position;

        for (let i = 0; i < this._vertices2D.length; i++) {
            const worldCoord = this._worldCoords[i];
            if (!worldCoord) continue;
            let base = this._altitudeOffset;
            if (this._altitudeMode === 'clampToGround') {
                const worldX = worldCoord[0] + wgPos.x;
                const worldZ = worldCoord[1] + wgPos.z;
                map.ensureTileForPoint?.(worldX, worldZ);
                base = map.getSurfaceHeightAt(worldX, worldZ) + this._altitudeOffset;
            }
            const upperY = base + this._minHeight + (this._extruded ? this._height : 0);
            this._cachedHeights[i] = upperY;
        }

        const outerRingLen = this._rings[0].length;
        if (this._cachedStrokeHeights.length !== outerRingLen) {
            this._cachedStrokeHeights = new Array(outerRingLen).fill(0);
        }
        for (let i = 0; i < outerRingLen; i++) {
            const worldCoord = this._strokeWorldCoords[i];
            if (!worldCoord) continue;
            let base = this._altitudeOffset;
            if (this._altitudeMode === 'clampToGround') {
                const worldX = worldCoord[0] + wgPos.x;
                const worldZ = worldCoord[1] + wgPos.z;
                map.ensureTileForPoint?.(worldX, worldZ);
                base = map.getSurfaceHeightAt(worldX, worldZ) + this._altitudeOffset;
            }
            this._cachedStrokeHeights[i] = base + this._minHeight + (this._extruded ? this._height : 0);
        }

        // Верхняя крышка
        const topPos = this._fillGeometry.attributes.position.array;
        for (let i = 0; i < this._vertices2D.length; i++) {
            topPos[i * 3 + 1] = this._cachedHeights[i];
        }
        this._fillGeometry.attributes.position.needsUpdate = true;

        // Нижняя крышка
        if (this._bottomGeometry) {
            const bottomPos = this._bottomGeometry.attributes.position.array;
            for (let i = 0; i < this._vertices2D.length; i++) {
                bottomPos[i * 3 + 1] = this._cachedHeights[i] - this._height;
            }
            this._bottomGeometry.attributes.position.needsUpdate = true;
        }

        // Боковые стенки
        if (this._sideGeometry) {
            const sidePos = this._sideGeometry.attributes.position.array;
            let idx = 0;
            for (let i = 0; i < this._vertices2D.length; i++) {
                const j = (i + 1) % this._vertices2D.length;
                const upperI = this._cachedHeights[i];
                const upperJ = this._cachedHeights[j];
                const lowerI = upperI - this._height;
                const lowerJ = upperJ - this._height;

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
            // Пересчитываем нормали боковых стенок после изменения высот,
            // т.к. при разных высотах соседних вершин грани наклоняются.
            this._sideGeometry.computeVertexNormals();
        }
    }

    /**
     * Обновляет позиции вершин обводки.
     *
     * @returns {void}
     * @private
     */
    _updateStroke() {
        if (!this._strokeLine || !this._strokeGeometry) return;
        const outerRing = this._rings[0];
        const positions = this._strokePositionsArray;
        positions.length = 0;
        const groupPos = this._group.position;

        for (let i = 0; i < outerRing.length; i++) {
            const worldCoord = this._strokeWorldCoords[i];
            if (!worldCoord) continue;
            const y = this._cachedStrokeHeights[i] ?? this._altitudeOffset;
            positions.push(worldCoord[0] - groupPos.x, y, worldCoord[1] - groupPos.z);
        }

        if (outerRing.length > 0 && this._strokeWorldCoords.length > 0) {
            const first = this._strokeWorldCoords[0];
            const fy = this._cachedStrokeHeights[0] ?? this._altitudeOffset;
            positions.push(first[0] - groupPos.x, fy, first[1] - groupPos.z);
        }

        if (this._useSimpleStroke) {
            const pointArray = [];
            for (let i = 0; i < positions.length; i += 3) {
                pointArray.push(new THREE.Vector3(positions[i], positions[i + 1], positions[i + 2]));
            }
            this._strokeGeometry.setFromPoints(pointArray);
        } else {
            this._strokeGeometry.setPositions(positions);
            this._strokeLine.computeLineDistances();
        }
    }

    /**
     * Пересчитывает экранную позицию центроида полигона для подписи.
     *
     * @returns {void}
     * @private
     */
    _updateCentroidScreenPos() {
        if (!this._map || !this._centroidWorld) {
            this._centroidScreenPos = null;
            return;
        }
        const wgPos = this._map.worldGroup.position;
        const worldX = this._centroidWorld.x + wgPos.x;
        const worldZ = this._centroidWorld.z + wgPos.z;

        let worldY = this._altitudeOffset;
        if (this._altitudeMode === 'clampToGround') {
            const now = performance.now();
            if (now - (this._lastCentroidHeightUpdateTime || 0) > this._heightUpdateInterval) {
                this._map.ensureTileForPoint(worldX, worldZ);
                this._cachedCentroidHeight = this._map.getSurfaceHeightAt(worldX, worldZ);
                this._lastCentroidHeightUpdateTime = now;
            }
            worldY = (this._cachedCentroidHeight ?? 0) + this._altitudeOffset;
        }
        worldY += this._minHeight + (this._extruded ? this._height : 0);

        const worldPos = this._tempVec3.set(worldX, worldY + wgPos.y, worldZ);
        const screenPos = worldPos.clone().project(this._map.camera);
        if (screenPos.z > 1 || Math.abs(screenPos.x) > 1 || Math.abs(screenPos.y) > 1) {
            this._centroidScreenPos = null;
        } else {
            const canvas = this._map.renderer.domElement;
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
     * @property {number} min - Минимальный зум.
     * @property {number} max - Максимальный зум.
     * @returns {Object} Границы зума.
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
     * @property {number} x - Координата X.
     * @property {number} y - Координата Y.
     * @returns {Object|null} Экранная позиция центроида (или null).
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
}