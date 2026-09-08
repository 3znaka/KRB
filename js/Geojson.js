// geojson.js — загрузка GeoJSON (Point, LineString, MultiLineString, Polygon, MultiPolygon), стилизация через свойства и коллбэки
import { Layer } from './Layers.js';
import { Marker } from './Marker.js';
import { Marker3D } from './Marker3D.js';
import { Area3D } from './Area3D.js'; // Добавлен импорт Area3D
import { Polyline } from './Polyline.js';
import { Polygon } from './Polygon.js';
import { proj } from './Utils.js';

/**
 * Слой, автоматически создающий маркеры, линии и полигоны на основе данных GeoJSON.
 *
 * Поддерживает:
 * - загрузку данных по URL или использование готового объекта GeoJSON;
 * - автоматическое определение типа геометрии (Point, LineString, MultiLineString, Polygon, MultiPolygon);
 * - умолчательные иконки, размеры, якоря и стили для каждого типа объектов;
 * - фильтрацию объектов (feature) перед добавлением на карту;
 * - кастомную стилизацию через коллбэки: pointToOptions, lineToOptions, polygonToOptions;
 * - добавление 3D-маркеров для точечных объектов (см. point3DToOptions и свойства 3d);
 * - добавление 3D-объектов для площадных объектов (см. polygon3DToOptions и свойства 3d);
 * - вызов onEachFeature(feature, object) после создания каждого графического объекта.
 *
 * @param {Object} [options={}] - Объект с настройками слоя.
 * @param {string} [options.url] - URL GeoJSON-файла для загрузки данных.
 * @param {Object} [options.data] - Готовый GeoJSON-объект (FeatureCollection, Feature или отдельная геометрия).
 * @param {Function} [options.pointToOptions] - Функция для создания опций маркера.
 *        Принимает (feature, properties) и должна возвращать объект с опциями для {@link Marker}.
 * @param {Function} [options.point3DToOptions] - Функция для создания опций 3D-маркера.
 *        Принимает (feature, properties) и должна возвращать объект с опциями для {@link Marker3D}.
 * @param {Function} [options.lineToOptions] - Функция для создания опций линии.
 *        Принимает (feature, properties) и должна возвращать объект с опциями для {@link Polyline}.
 * @param {Function} [options.polygonToOptions] - Функция для создания опций полигона.
 *        Принимает (feature, properties) и должна возвращать объект с опциями для {@link Polygon}.
 * @param {Function} [options.polygon3DToOptions] - Функция для создания опций 3D-площадного объекта.
 *        Принимает (feature, properties) и должна возвращать объект с опциями для {@link Area3D}.
 * @param {Function} [options.filter] - Функция фильтрации фич. Принимает feature, должна вернуть true, чтобы фича была добавлена.
 * @param {Function} [options.onEachFeature] - Функция, вызываемая после создания каждого графического объекта.
 *        Принимает (feature, object), где object — экземпляр Marker, Marker3D, Polyline, Polygon или Area3D.
 *
 * @param {string} [options.defaultIconUrl='marker.png'] - URL иконки по умолчанию для маркеров.
 * @param {number[]} [options.defaultIconSize=[16,16]] - Размер иконки по умолчанию [ширина, высота].
 * @param {number[]} [options.defaultAnchor=[0.5,1.0]] - Якорь иконки по умолчанию [x, y] в долях от размеров иконки.
 *
 * @param {string} [options.default3DPrimitiveType='box'] - Тип примитива 3D-маркера по умолчанию ('box', 'sphere', 'cylinder', 'cone').
 * @param {number[]} [options.default3DSize=[100,100,100]] - Размеры 3D-маркера по умолчанию [width, height, depth].
 * @param {number[]} [options.default3DAnchor=[0.5,0,0.5]] - Anchor point 3D-маркера по умолчанию.
 * @param {number} [options.default3DAltitude=0] - Высота 3D-маркера по умолчанию.
 * @param {string} [options.default3DAltitudeMode='clampToGround'] - Режим высоты 3D-маркера по умолчанию.
 *
 * @param {string} [options.defaultLineColor='#3388ff'] - Цвет линии по умолчанию.
 * @param {number} [options.defaultLineWidth=2] - Толщина линии по умолчанию.
 * @param {number} [options.defaultLineOpacity=1] - Прозрачность линии по умолчанию (0..1).
 * @param {'ground'|'clampToGround'} [options.defaultLineAltitudeMode='ground'] - Режим высоты линии по умолчанию.
 * @param {number} [options.defaultLineAltitudeOffset=10] - Смещение высоты линии по умолчанию.
 * @param {boolean} [options.defaultLineDepthTest=false] - Включение теста глубины для линии по умолчанию.
 * @param {boolean} [options.defaultLineDepthWrite=false] - Запись глубины для линии по умолчанию.
 * @param {number} [options.defaultLineMinZoom=-Infinity] - Минимальный zoom видимости линии по умолчанию.
 * @param {number} [options.defaultLineMaxZoom=Infinity] - Максимальный zoom видимости линии по умолчанию.
 *
 * @param {string} [options.defaultFillColor='#3388ff'] - Цвет заливки полигона по умолчанию.
 * @param {number} [options.defaultFillOpacity=0.5] - Прозрачность заливки полигона по умолчанию.
 * @param {string} [options.defaultStrokeColor='#000000'] - Цвет обводки полигона по умолчанию.
 * @param {number} [options.defaultStrokeWidth=2] - Толщина обводки полигона по умолчанию.
 * @param {number} [options.defaultStrokeOpacity=1] - Прозрачность обводки полигона по умолчанию.
 * @param {'ground'|'clampToGround'} [options.defaultPolygonAltitudeMode='ground'] - Режим высоты полигона по умолчанию.
 * @param {number} [options.defaultPolygonAltitudeOffset=10] - Смещение высоты полигона по умолчанию.
 * @param {boolean} [options.defaultPolygonDepthTest=false] - Включение теста глубины для полигона по умолчанию.
 * @param {boolean} [options.defaultPolygonDepthWrite=false] - Запись глубины для полигона по умолчанию.
 * @param {number} [options.defaultPolygonMinZoom=-Infinity] - Минимальный zoom видимости полигона по умолчанию.
 * @param {number} [options.defaultPolygonMaxZoom=Infinity] - Максимальный zoom видимости полигона по умолчанию.
 * @param {boolean} [options.defaultPolygonExtruded=false] - Включить экструзию полигонов по умолчанию.
 * @param {number} [options.defaultPolygonHeight=0] - Толщина экструзии по умолчанию (в метрах).
 * @param {number} [options.defaultPolygonMinHeight=0] - Высота нижней грани над поверхностью по умолчанию (в метрах).
 *
 * @param {string} [options.defaultPolygon3DPrimitiveType='box'] - Тип примитива Area3D по умолчанию.
 * @param {number[]} [options.defaultPolygon3DSize=null] - Размеры Area3D для примитивов (если не задан modelUrl).
 * @param {number[]} [options.defaultPolygon3DAnchor=[0.5,0,0.5]] - Anchor point Area3D по умолчанию.
 * @param {number} [options.defaultPolygon3DAltitude=0] - Высота Area3D по умолчанию.
 * @param {string} [options.defaultPolygon3DAltitudeMode='clampToGround'] - Режим высоты Area3D по умолчанию.
 * @param {string} [options.defaultPolygon3DFit='stretch'] - Режим вписывания модели в полигон ('stretch', 'contain').
 * @param {number} [options.defaultPolygon3DRotate=0] - Поворот модели (0-3, кратно 90°).
 * @param {string} [options.defaultPolygon3DModelUrl=null] - URL GLB-модели для Area3D по умолчанию.
 * @param {boolean} [options.defaultPolygon3DDepthTest=true] - Включение теста глубины для Area3D.
 * @param {boolean} [options.defaultPolygon3DDepthWrite=true] - Запись глубины для Area3D.
 *
/**
 * @example
 * const layer = new GeoJSONLayer({
 *     url: 'data.geojson',
 *     pointToOptions: (feature, props) => ({ title: props.name, iconUrl: props.icon }),
 *     point3DToOptions: (feature, props) => ({ primitiveType: props.primitiveType, altitude: props.altitude }),
 *     lineToOptions: (feature, props) => ({ color: props.stroke }),
 *     polygonToOptions: (feature, props) => ({
 *         fillColor: props.fill,
 *         extruded: props.extruded !== undefined ? props.extruded : true,
 *         height: props.height || 300,
 *         minHeight: props.minHeight || 0
 *     }),
 *     polygon3DToOptions: (feature, props) => ({
 *         modelUrl: props.modelUrl,
 *         fit: props.fit || 'stretch',
 *         rotate: props.rotate || 0,
 *         altitude: props.altitude || 0
 *     }),
 *     filter: (feature) => feature.properties.visible !== false,
 *     onEachFeature: (feature, object) => console.log(feature, object),
 *     defaultIconUrl: 'custom-marker.png',
 *     defaultIconSize: [24, 24],
 *     defaultAnchor: [0.5, 1],
 *     default3DPrimitiveType: 'cylinder',
 *     default3DSize: [50, 50, 50],
 *     default3DAnchor: [0.5, 0, 0.5],
 *     default3DAltitude: 100,
 *     default3DAltitudeMode: 'relativeToGround',
 *     defaultLineColor: '#ff0000',
 *     defaultLineWidth: 4,
 *     defaultLineOpacity: 0.8,
 *     defaultLineAltitudeMode: 'clampToGround',
 *     defaultLineAltitudeOffset: 20,
 *     defaultLineDepthTest: true,
 *     defaultLineDepthWrite: true,
 *     defaultLineMinZoom: 10,
 *     defaultLineMaxZoom: 18,
 *     defaultFillColor: '#00ff00',
 *     defaultFillOpacity: 0.7,
 *     defaultStrokeColor: '#000000',
 *     defaultStrokeWidth: 3,
 *     defaultStrokeOpacity: 0.9,
 *     defaultPolygonAltitudeMode: 'clampToGround',
 *     defaultPolygonAltitudeOffset: 15,
 *     defaultPolygonDepthTest: true,
 *     defaultPolygonDepthWrite: true,
 *     defaultPolygonMinZoom: 10,
 *     defaultPolygonMaxZoom: 18,
 *     defaultPolygonExtruded: false,
 *     defaultPolygonHeight: 500,
 *     defaultPolygonMinHeight: 200,
 *     defaultPolygon3DPrimitiveType: 'box',
 *     defaultPolygon3DSize: null,
 *     defaultPolygon3DAnchor: [0.5, 0, 0.5],
 *     defaultPolygon3DAltitude: 0,
 *     defaultPolygon3DAltitudeMode: 'clampToGround',
 *     defaultPolygon3DFit: 'stretch',
 *     defaultPolygon3DRotate: 0,
 *     defaultPolygon3DModelUrl: null,
 *     defaultPolygon3DDepthTest: true,
 *     defaultPolygon3DDepthWrite: true
 * });
 * layer.addTo(map);
 * layer.reload();
 */
export class GeoJSONLayer extends Layer {
    /**
     * Создаёт экземпляр GeoJSONLayer.
     *
     * @param {Object} [options={}] - Объект с настройками слоя.
     * @param {string} [options.url] - URL GeoJSON-файла для загрузки данных.
     * @param {Object} [options.data] - Готовый GeoJSON-объект (FeatureCollection, Feature или отдельная геометрия).
     * @param {Function} [options.pointToOptions] - Функция для создания опций маркера.
     *        Принимает (feature, properties) и должна возвращать объект с опциями для {@link Marker}.
     * @param {Function} [options.point3DToOptions] - Функция для создания опций 3D-маркера.
     *        Принимает (feature, properties) и должна возвращать объект с опциями для {@link Marker3D}.
     * @param {Function} [options.lineToOptions] - Функция для создания опций линии.
     *        Принимает (feature, properties) и должна возвращать объект с опциями для {@link Polyline}.
     * @param {Function} [options.polygonToOptions] - Функция для создания опций полигона.
     *        Принимает (feature, properties) и должна возвращать объект с опциями для {@link Polygon}.
     * @param {Function} [options.polygon3DToOptions] - Функция для создания опций 3D-площадного объекта.
     *        Принимает (feature, properties) и должна возвращать объект с опциями для {@link Area3D}.
     * @param {Function} [options.filter] - Функция фильтрации фич. Принимает feature, должна вернуть true, чтобы фича была добавлена.
     * @param {Function} [options.onEachFeature] - Функция, вызываемая после создания каждого графического объекта.
     *        Принимает (feature, object), где object — экземпляр Marker, Marker3D, Polyline, Polygon или Area3D.
     *
     * @param {string} [options.defaultIconUrl='marker.png'] - URL иконки по умолчанию для маркеров.
     * @param {number[]} [options.defaultIconSize=[16,16]] - Размер иконки по умолчанию [ширина, высота].
     * @param {number[]} [options.defaultAnchor=[0.5,1.0]] - Якорь иконки по умолчанию [x, y] в долях от размеров иконки.
     *
     * @param {string} [options.default3DPrimitiveType='box'] - Тип примитива 3D-маркера по умолчанию ('box', 'sphere', 'cylinder', 'cone').
     * @param {number[]} [options.default3DSize=[100,100,100]] - Размеры 3D-маркера по умолчанию [width, height, depth].
     * @param {number[]} [options.default3DAnchor=[0.5,0,0.5]] - Anchor point 3D-маркера по умолчанию.
     * @param {number} [options.default3DAltitude=0] - Высота 3D-маркера по умолчанию.
     * @param {string} [options.default3DAltitudeMode='clampToGround'] - Режим высоты 3D-маркера по умолчанию.
     *
     * @param {string} [options.defaultLineColor='#3388ff'] - Цвет линии по умолчанию.
     * @param {number} [options.defaultLineWidth=2] - Толщина линии по умолчанию.
     * @param {number} [options.defaultLineOpacity=1] - Прозрачность линии по умолчанию (0..1).
     * @param {'ground'|'clampToGround'} [options.defaultLineAltitudeMode='ground'] - Режим высоты линии по умолчанию.
     * @param {number} [options.defaultLineAltitudeOffset=10] - Смещение высоты линии по умолчанию.
     * @param {boolean} [options.defaultLineDepthTest=false] - Включение теста глубины для линии по умолчанию.
     * @param {boolean} [options.defaultLineDepthWrite=false] - Запись глубины для линии по умолчанию.
     * @param {number} [options.defaultLineMinZoom=-Infinity] - Минимальный zoom видимости линии по умолчанию.
     * @param {number} [options.defaultLineMaxZoom=Infinity] - Максимальный zoom видимости линии по умолчанию.
     *
     * @param {string} [options.defaultFillColor='#3388ff'] - Цвет заливки полигона по умолчанию.
     * @param {number} [options.defaultFillOpacity=0.5] - Прозрачность заливки полигона по умолчанию.
     * @param {string} [options.defaultStrokeColor='#000000'] - Цвет обводки полигона по умолчанию.
     * @param {number} [options.defaultStrokeWidth=2] - Толщина обводки полигона по умолчанию.
     * @param {number} [options.defaultStrokeOpacity=1] - Прозрачность обводки полигона по умолчанию.
     * @param {'ground'|'clampToGround'} [options.defaultPolygonAltitudeMode='ground'] - Режим высоты полигона по умолчанию.
     * @param {number} [options.defaultPolygonAltitudeOffset=10] - Смещение высоты полигона по умолчанию.
     * @param {boolean} [options.defaultPolygonDepthTest=false] - Включение теста глубины для полигона по умолчанию.
     * @param {boolean} [options.defaultPolygonDepthWrite=false] - Запись глубины для полигона по умолчанию.
     * @param {number} [options.defaultPolygonMinZoom=-Infinity] - Минимальный zoom видимости полигона по умолчанию.
     * @param {number} [options.defaultPolygonMaxZoom=Infinity] - Максимальный zoom видимости полигона по умолчанию.
     * @param {boolean} [options.defaultPolygonExtruded=false] - Включить экструзию полигонов по умолчанию.
     * @param {number} [options.defaultPolygonHeight=0] - Толщина экструзии по умолчанию (в метрах).
     * @param {number} [options.defaultPolygonMinHeight=0] - Высота нижней грани над поверхностью по умолчанию (в метрах).
     * @param {string} [options.defaultPolygon3DPrimitiveType='box'] - Тип примитива Area3D по умолчанию.
     * @param {number[]} [options.defaultPolygon3DSize=null] - Размеры Area3D для примитивов (если не задан modelUrl).
     * @param {number[]} [options.defaultPolygon3DAnchor=[0.5,0,0.5]] - Anchor point Area3D по умолчанию.
     * @param {number} [options.defaultPolygon3DAltitude=0] - Высота Area3D по умолчанию.
     * @param {string} [options.defaultPolygon3DAltitudeMode='clampToGround'] - Режим высоты Area3D по умолчанию.
     * @param {string} [options.defaultPolygon3DFit='stretch'] - Режим вписывания модели в полигон ('stretch', 'contain').
     * @param {number} [options.defaultPolygon3DRotate=0] - Поворот модели (0-3, кратно 90°).
     * @param {string} [options.defaultPolygon3DModelUrl=null] - URL GLB-модели для Area3D по умолчанию.
     * @param {boolean} [options.defaultPolygon3DDepthTest=true] - Включение теста глубины для Area3D.
     * @param {boolean} [options.defaultPolygon3DDepthWrite=true] - Запись глубины для Area3D.
     */
    constructor(options = {}) {
        super();

        this.url = options.url || null;
        this.data = options.data || null;
        this.filter = options.filter || null;
        this.onEachFeature = options.onEachFeature || null;

        this.pointToOptions = options.pointToOptions || null;
        this.point3DToOptions = options.point3DToOptions || null;
        this.lineToOptions = options.lineToOptions || null;
        this.polygonToOptions = options.polygonToOptions || null;
        this.polygon3DToOptions = options.polygon3DToOptions || null; // Новый коллбэк для 3D-площадных объектов

        // --- Параметры по умолчанию для обычных маркеров ---
        this.defaultIconUrl = options.defaultIconUrl || 'marker.png';
        this.defaultIconSize = options.defaultIconSize || [16, 16];
        this.defaultAnchor = options.defaultAnchor || [0.5, 1.0];

        // --- Параметры по умолчанию для 3D-маркеров ---
        this.default3DPrimitiveType = options.default3DPrimitiveType || 'box';
        this.default3DSize = options.default3DSize || [100, 100, 100];
        this.default3DAnchor = options.default3DAnchor || [0.5, 0, 0.5];
        this.default3DAltitude = options.default3DAltitude ?? 0;
        this.default3DAltitudeMode = options.default3DAltitudeMode || 'clampToGround';

        // --- Параметры по умолчанию для линий ---
        this.defaultLineColor = options.defaultLineColor || '#3388ff';
        this.defaultLineWidth = options.defaultLineWidth || 2;
        this.defaultLineOpacity = options.defaultLineOpacity ?? 1;
        this.defaultLineAltitudeMode = options.defaultLineAltitudeMode || 'ground';
        this.defaultLineAltitudeOffset = options.defaultLineAltitudeOffset ?? 10;
        this.defaultLineDepthTest = options.defaultLineDepthTest ?? false;
        this.defaultLineDepthWrite = options.defaultLineDepthWrite ?? false;
        this.defaultLineMinZoom = options.defaultLineMinZoom ?? -Infinity;
        this.defaultLineMaxZoom = options.defaultLineMaxZoom ?? Infinity;

        // --- Параметры по умолчанию для полигонов ---
        this.defaultFillColor = options.defaultFillColor || '#3388ff';
        this.defaultFillOpacity = options.defaultFillOpacity ?? 0.5;
        this.defaultStrokeColor = options.defaultStrokeColor || '#000000';
        this.defaultStrokeWidth = options.defaultStrokeWidth || 2;
        this.defaultStrokeOpacity = options.defaultStrokeOpacity ?? 1;
        this.defaultPolygonAltitudeMode = options.defaultPolygonAltitudeMode || 'ground';
        this.defaultPolygonAltitudeOffset = options.defaultPolygonAltitudeOffset ?? 10;
        this.defaultPolygonDepthTest = options.defaultPolygonDepthTest ?? false;
        this.defaultPolygonDepthWrite = options.defaultPolygonDepthWrite ?? false;
        this.defaultPolygonMinZoom = options.defaultPolygonMinZoom ?? -Infinity;
        this.defaultPolygonMaxZoom = options.defaultPolygonMaxZoom ?? Infinity;
        this.defaultPolygonExtruded = options.defaultPolygonExtruded ?? false;
        this.defaultPolygonHeight = options.defaultPolygonHeight ?? 0;
        this.defaultPolygonMinHeight = options.defaultPolygonMinHeight ?? 0;

        // --- Параметры по умолчанию для Area3D (3D-площадные объекты) ---
        this.defaultPolygon3DPrimitiveType = options.defaultPolygon3DPrimitiveType || 'box';
        this.defaultPolygon3DSize = options.defaultPolygon3DSize || null;
        this.defaultPolygon3DAnchor = options.defaultPolygon3DAnchor || [0.5, 0, 0.5];
        this.defaultPolygon3DAltitude = options.defaultPolygon3DAltitude ?? 0;
        this.defaultPolygon3DAltitudeMode = options.defaultPolygon3DAltitudeMode || 'clampToGround';
        this.defaultPolygon3DFit = options.defaultPolygon3DFit || 'stretch';
        this.defaultPolygon3DRotate = options.defaultPolygon3DRotate || 0;
        this.defaultPolygon3DModelUrl = options.defaultPolygon3DModelUrl || null;
        this.defaultPolygon3DDepthTest = options.defaultPolygon3DDepthTest ?? true;
        this.defaultPolygon3DDepthWrite = options.defaultPolygon3DDepthWrite ?? true;

        this._loaded = false;
    }

    /**
     * Добавляет слой на карту и запускает загрузку данных, если они ещё не были загружены.
     *
     * @param {Map} map - Экземпляр карты.
     * @returns {this} Текущий экземпляр слоя для цепочек вызовов.
     */
    addTo(map) {
        super.addTo(map);
        if (!this._loaded) {
            this._load();
        }
        return this;
    }

    /**
     * Полностью перезагружает данные слоя: удаляет все созданные объекты, сбрасывает флаг загрузки
     * и повторно запускает процесс загрузки, если слой прикреплён к карте.
     *
     * @returns {void} Метод ничего не возвращает.
     */
    reload() {
        for (const obj of [...this._objects]) {
            obj.remove();
        }
        this._objects = [];
        this._loaded = false;
        if (this._map) {
            this._load();
        }
    }

    /**
     * Загружает GeoJSON-данные: из URL или готового объекта, парсит и создаёт графические объекты.
     *
     * @returns {Promise<void>} Промис без значения.
     * @private
     */
    async _load() {
        let geojson = null;
        try {
            if (this.data) {
                geojson = this.data;
            } else if (this.url) {
                const resp = await fetch(this.url);
                if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
                geojson = await resp.json();
            }
            if (!geojson) {
                console.warn('GeoJSONLayer: не предоставлены данные или URL');
                return;
            }
            this._parse(geojson);
            this._loaded = true;
        } catch (err) {
            console.error('GeoJSONLayer: ошибка загрузки/парсинга', err);
        }
    }

    /**
     * Разбирает корневой объект GeoJSON и направляет фичи на дальнейшую обработку.
     * Поддерживаются типы: FeatureCollection, Feature, Point, LineString, MultiLineString, Polygon, MultiPolygon.
     *
     * @param {Object} geojson - Корневой объект GeoJSON.
     * @private
     */
    _parse(geojson) {
        const type = geojson.type;
        if (type === 'FeatureCollection') {
            for (const feature of geojson.features) {
                this._addFeature(feature);
            }
        } else if (type === 'Feature') {
            this._addFeature(geojson);
        } else if (type === 'Point') {
            this._addFeature({
                type: 'Feature',
                geometry: geojson,
                properties: {}
            });
        } else if (type === 'LineString' || type === 'MultiLineString') {
            this._addFeature({
                type: 'Feature',
                geometry: geojson,
                properties: {}
            });
        } else if (type === 'Polygon' || type === 'MultiPolygon') {
            this._addFeature({
                type: 'Feature',
                geometry: geojson,
                properties: {}
            });
        } else {
            console.debug(`GeoJSONLayer: тип "${type}" пока не поддерживается`);
        }
    }

    /**
     * Обрабатывает отдельную фичу: применяет фильтр и в зависимости от типа геометрии
     * вызывает соответствующий метод создания объектов.
     *
     * @param {Object} feature - Объект GeoJSON Feature.
     * @private
     */
    _addFeature(feature) {
        if (this.filter && !this.filter(feature)) return;

        const geom = feature.geometry;
        if (!geom) return;

        switch (geom.type) {
            case 'Point':
                this._addPointFeature(feature);
                break;
            case 'LineString':
            case 'MultiLineString':
                this._addLineFeature(feature);
                break;
            case 'Polygon':
            case 'MultiPolygon':
                this._addPolygonFeature(feature);
                break;
            default:
                console.debug(`GeoJSONLayer: тип "${geom.type}" пока не поддерживается`);
        }
    }

    /**
     * Создаёт маркер (обычный или 3D) на основе точечной фичи.
     * Решение о типе маркера принимается по коллбэку point3DToOptions или по свойству `3d: true` / `type: '3d'` в properties.
     *
     * @param {Object} feature - GeoJSON-фича с геометрией типа Point.
     * @private
     */
    _addPointFeature(feature) {
        const props = feature.properties || {};
        const coords = feature.geometry.coordinates;

        // Определяем, является ли точка 3D
        const is3D = (this.point3DToOptions && this.point3DToOptions(feature, props))
            || props['3d'] === true
            || props.type === '3d'
            || props.markerType === '3d';

        if (is3D) {
            // --- Создание 3D-маркера ---
            let options;
            if (this.point3DToOptions) {
                options = this.point3DToOptions(feature, props) || {};
            } else {
                options = this._default3DPointOptions(feature, props);
            }

            const marker3DOptions = {
                position: coords,
                title: options.title || props.title || props.name || '',
                tooltip: options.tooltip || props.tooltip || props.description || '',
                primitiveType: options.primitiveType || props.primitiveType || this.default3DPrimitiveType,
                size: options.size || this._parseSize(props.size) || this.default3DSize,
                anchor: options.anchor || this._parseTriple(props.anchor) || this.default3DAnchor,
                altitude: options.altitude ?? props.altitude ?? this.default3DAltitude,
                altitudeMode: options.altitudeMode || props.altitudeMode || this.default3DAltitudeMode,
                rotation: options.rotation || props.rotation || [0, 0, 0],
                modelUrl: options.modelUrl || props.modelUrl,
                minZoom: options.minZoom ?? props.minZoom ?? -Infinity,
                maxZoom: options.maxZoom ?? props.maxZoom ?? Infinity,
                titlePlacement: options.titlePlacement || props.titlePlacement || 'top',
                titleAlign: options.titleAlign || props.titleAlign || undefined,
                titleOffset: options.titleOffset || this._parsePair(props.titleOffset) || undefined,
                titleStyle: options.titleStyle || props.titleStyle || {},
                titleMinZoom: options.titleMinZoom ?? props.titleMinZoom ?? -Infinity,
                titleMaxZoom: options.titleMaxZoom ?? props.titleMaxZoom ?? Infinity,
                onHover: options.onHover,
                onClick: options.onClick,
                color: options.color || props.color,
                clusterable: options.clusterable !== undefined ? options.clusterable : false
            };

            const marker3D = new Marker3D(marker3DOptions);
            this.add(marker3D);
            if (this.onEachFeature) {
                this.onEachFeature(feature, marker3D);
            }
        } else {
            // --- Создание обычного маркера (как раньше) ---
            let options;
            if (this.pointToOptions) {
                options = this.pointToOptions(feature, props) || {};
            } else {
                options = this._defaultPointOptions(feature, props);
            }

            const markerOptions = {
                position: coords,
                title: options.title || props.title || props.name || '',
                tooltip: options.tooltip || props.tooltip || props.description || '',
                iconUrl: options.iconUrl !== undefined ? options.iconUrl : (props.icon || this.defaultIconUrl),
                iconSize: this._parseSize(options.iconSize || props.iconSize) || this.defaultIconSize,
                anchor: this._parseAnchor(options.anchor || props.anchor) || this.defaultAnchor,
                altitudeMode: options.altitudeMode || props.altitudeMode || 'ground',
                clusterable: options.clusterable !== undefined ? options.clusterable : (props.clusterable !== undefined ? props.clusterable : true),
                minZoom: options.minZoom ?? props.minZoom ?? -Infinity,
                maxZoom: options.maxZoom ?? props.maxZoom ?? Infinity,
                titleMinZoom: options.titleMinZoom ?? props.titleMinZoom ?? -Infinity,
                titleMaxZoom: options.titleMaxZoom ?? props.titleMaxZoom ?? Infinity,
                onHover: options.onHover,
                onClick: options.onClick
            };

            const marker = new Marker(markerOptions);
            this.add(marker);
            if (this.onEachFeature) {
                this.onEachFeature(feature, marker);
            }
        }
    }

    /**
     * Возвращает умолчательные опции для точечного объекта, полученные из свойств фичи.
     * Используется, когда не задан коллбэк pointToOptions.
     *
     * @param {Object} feature - GeoJSON-фича.
     * @param {Object} props - Свойства (properties) фичи.
     * @returns {Object} Объект с опциями маркера.
     * @private
     */
    _defaultPointOptions(feature, props) {
        return {
            title: props.title || props.name || '',
            tooltip: props.tooltip || props.description || '',
            iconUrl: props.icon || this.defaultIconUrl,
            iconSize: this._parseSize(props.iconSize),
            anchor: this._parseAnchor(props.anchor),
            clusterable: props.clusterable !== undefined ? props.clusterable : true,
            altitudeMode: props.altitudeMode || 'ground'
        };
    }

    /**
     * Возвращает умолчательные опции для 3D-точечного объекта, полученные из свойств фичи.
     * Используется, когда не задан коллбэк point3DToOptions, но точка определена как 3D.
     *
     * @param {Object} feature - GeoJSON-фича.
     * @param {Object} props - Свойства (properties) фичи.
     * @returns {Object} Объект с опциями Marker3D.
     * @private
     */
    _default3DPointOptions(feature, props) {
        return {
            primitiveType: props.primitiveType || this.default3DPrimitiveType,
            size: this._parseSize(props.size) || this.default3DSize,
            anchor: this._parseTriple(props.anchor) || this.default3DAnchor,
            altitude: props.altitude ?? this.default3DAltitude,
            altitudeMode: props.altitudeMode || this.default3DAltitudeMode,
            rotation: props.rotation || [0, 0, 0],
            modelUrl: props.modelUrl,
            minZoom: props.minZoom,
            maxZoom: props.maxZoom,
            color: props.color,
            titleMinZoom: props.titleMinZoom,
            titleMaxZoom: props.titleMaxZoom
        };
    }

    /**
     * Создаёт линейные объекты (Polyline) на основе фичи с геометрией LineString или MultiLineString.
     * Для MultiLineString создаётся отдельная линия на каждую группу координат.
     *
     * @param {Object} feature - GeoJSON-фича с геометрией LineString или MultiLineString.
     * @private
     */
    _addLineFeature(feature) {
        const props = feature.properties || {};
        const geom = feature.geometry;
        const coordSets = geom.type === 'LineString'
            ? [geom.coordinates]
            : geom.coordinates; // MultiLineString

        for (const coords of coordSets) {
            if (coords.length < 2) continue;

            let options;
            if (this.lineToOptions) {
                options = this.lineToOptions(feature, props) || {};
            } else {
                options = this._defaultLineOptions(feature, props);
            }

            const lineOptions = {
                positions: coords,
                ...options,
                title: options.title ?? props.title ?? props.name ?? '',
                titleOffset: options.titleOffset ?? this._parsePair(props.titleOffset),
                titleAlign: options.titleAlign ?? props.titleAlign ?? 'center',
                titleStyle: options.titleStyle ?? props.titleStyle ?? {},
                titleMinZoom: options.titleMinZoom ?? props.titleMinZoom ?? -Infinity,
                titleMaxZoom: options.titleMaxZoom ?? props.titleMaxZoom ?? Infinity,
                titlePlacement: options.titlePlacement ?? props.titlePlacement ?? 'center'
            };

            const polyline = new Polyline(lineOptions);
            this.add(polyline);
            if (this.onEachFeature) {
                this.onEachFeature(feature, polyline);
            }
        }
    }

    /**
     * Возвращает умолчательные опции для линейного объекта, полученные из свойств фичи.
     * Используется, когда не задан коллбэк lineToOptions.
     *
     * @param {Object} feature - GeoJSON-фича.
     * @param {Object} props - Свойства (properties) фичи.
     * @returns {Object} Объект с опциями полилинии.
     * @private
     */
    _defaultLineOptions(feature, props) {
        return {
            color: props.stroke || props.color || this.defaultLineColor,
            opacity: props['stroke-opacity'] ?? props.opacity ?? this.defaultLineOpacity,
            width: props['stroke-width'] ?? props.width ?? this.defaultLineWidth,
            altitudeMode: props.altitudeMode || this.defaultLineAltitudeMode,
            altitudeOffset: props.altitudeOffset ?? this.defaultLineAltitudeOffset,
            depthTest: props.depthTest ?? this.defaultLineDepthTest,
            depthWrite: props.depthWrite ?? this.defaultLineDepthWrite,
            minZoom: props.minZoom ?? this.defaultLineMinZoom,
            maxZoom: props.maxZoom ?? this.defaultLineMaxZoom
        };
    }

    /**
     * Создаёт полигональные объекты (Polygon или Area3D) на основе фичи с геометрией Polygon или MultiPolygon.
     * Для MultiPolygon создаётся отдельный объект на каждый набор колец.
     * Если фича определена как 3D (через polygon3DToOptions или свойства), создаётся Area3D, иначе обычный Polygon.
     *
     * @param {Object} feature - GeoJSON-фича с геометрией Polygon или MultiPolygon.
     * @private
     */
    _addPolygonFeature(feature) {
        const props = feature.properties || {};
        const geom = feature.geometry;
        const polygonSets = geom.type === 'Polygon'
            ? [geom.coordinates]
            : geom.coordinates; // MultiPolygon

        for (const rings of polygonSets) {
            if (!rings.length || !rings[0].length) continue;

            // Определяем, является ли полигон 3D
            const is3D = (this.polygon3DToOptions && this.polygon3DToOptions(feature, props))
                || props['3d'] === true
                || props.type === '3d'
                || props.markerType === '3d';

            if (is3D) {
                // --- Создание 3D-площадного объекта (Area3D) ---
                let options3D;
                if (this.polygon3DToOptions) {
                    options3D = this.polygon3DToOptions(feature, props) || {};
                } else {
                    options3D = this._defaultPolygon3DOptions(feature, props);
                }

                const areaOptions = {
                    rings: rings,
                    modelUrl: options3D.modelUrl || props.modelUrl || this.defaultPolygon3DModelUrl,
                    fit: options3D.fit || props.fit || this.defaultPolygon3DFit,
                    rotate: options3D.rotate ?? props.rotate ?? this.defaultPolygon3DRotate,
                    primitiveType: options3D.primitiveType || props.primitiveType || this.defaultPolygon3DPrimitiveType,
                    size: options3D.size || this._parseSize(props.size) || this.defaultPolygon3DSize,
                    anchor: options3D.anchor || this._parseTriple(props.anchor) || this.defaultPolygon3DAnchor,
                    altitude: options3D.altitude ?? props.altitude ?? this.defaultPolygon3DAltitude,
                    altitudeMode: options3D.altitudeMode || props.altitudeMode || this.defaultPolygon3DAltitudeMode,
                    color: options3D.color || props.color || 0x3388ff,
                    depthTest: options3D.depthTest ?? props.depthTest ?? this.defaultPolygon3DDepthTest,
                    depthWrite: options3D.depthWrite ?? props.depthWrite ?? this.defaultPolygon3DDepthWrite,
                    minZoom: options3D.minZoom ?? props.minZoom ?? -Infinity,
                    maxZoom: options3D.maxZoom ?? props.maxZoom ?? Infinity,
                    title: options3D.title ?? props.title ?? props.name ?? '',
                    titlePlacement: options3D.titlePlacement || props.titlePlacement || 'top',
                    titleAlign: options3D.titleAlign || props.titleAlign || undefined,
                    titleOffset: options3D.titleOffset || this._parsePair(props.titleOffset) || undefined,
                    titleStyle: options3D.titleStyle || props.titleStyle || {},
                    titleMinZoom: options3D.titleMinZoom ?? props.titleMinZoom ?? -Infinity,
                    titleMaxZoom: options3D.titleMaxZoom ?? props.titleMaxZoom ?? Infinity,
                    tooltip: options3D.tooltip || props.tooltip || props.description || '',
                    onHover: options3D.onHover,
                    onClick: options3D.onClick
                };

                const area = new Area3D(areaOptions);
                this.add(area);
                if (this.onEachFeature) {
                    this.onEachFeature(feature, area);
                }
            } else {
                // --- Создание обычного полигона ---
                let options;
                if (this.polygonToOptions) {
                    options = this.polygonToOptions(feature, props) || {};
                } else {
                    options = this._defaultPolygonOptions(feature, props);
                }

                const polygonOptions = {
                    rings: rings,
                    ...options,
                    title: options.title ?? props.title ?? props.name ?? '',
                    titleOffset: options.titleOffset ?? this._parsePair(props.titleOffset),
                    titleAlign: options.titleAlign ?? props.titleAlign ?? 'center',
                    titleStyle: options.titleStyle ?? props.titleStyle ?? {},
                    titleMinZoom: options.titleMinZoom ?? props.titleMinZoom ?? -Infinity,
                    titleMaxZoom: options.titleMaxZoom ?? props.titleMaxZoom ?? Infinity,
                };

                const polygon = new Polygon(polygonOptions);
                this.add(polygon);
                if (this.onEachFeature) {
                    this.onEachFeature(feature, polygon);
                }
            }
        }
    }

    /**
     * Возвращает умолчательные опции для полигонального объекта, полученные из свойств фичи.
     * Используется, когда не задан коллбэк polygonToOptions.
     *
     * @param {Object} feature - GeoJSON-фича.
     * @param {Object} props - Свойства (properties) фичи.
     * @returns {Object} Объект с опциями полигона.
     * @private
     */
    _defaultPolygonOptions(feature, props) {
        return {
            fillColor: props.fill || props['fill-color'] || this.defaultFillColor,
            fillOpacity: props['fill-opacity'] ?? this.defaultFillOpacity,
            strokeColor: props.stroke || props['stroke-color'] || this.defaultStrokeColor,
            strokeWidth: props['stroke-width'] ?? this.defaultStrokeWidth,
            strokeOpacity: props['stroke-opacity'] ?? this.defaultStrokeOpacity,
            altitudeMode: props.altitudeMode || this.defaultPolygonAltitudeMode,
            altitudeOffset: props.altitudeOffset ?? this.defaultPolygonAltitudeOffset,
            depthTest: props.depthTest ?? this.defaultPolygonDepthTest,
            depthWrite: props.depthWrite ?? this.defaultPolygonDepthWrite,
            minZoom: props.minZoom ?? this.defaultPolygonMinZoom,
            maxZoom: props.maxZoom ?? this.defaultPolygonMaxZoom,
            extruded: props.extruded ?? this.defaultPolygonExtruded,
            height: props.height ?? this.defaultPolygonHeight,
            minHeight: props.minHeight ?? this.defaultPolygonMinHeight,
        };
    }

    /**
     * Возвращает умолчательные опции для 3D-площадного объекта (Area3D), полученные из свойств фичи.
     * Используется, когда не задан коллбэк polygon3DToOptions, но полигон определён как 3D.
     *
     * @param {Object} feature - GeoJSON-фича.
     * @param {Object} props - Свойства (properties) фичи.
     * @returns {Object} Объект с опциями Area3D.
     * @private
     */
    _defaultPolygon3DOptions(feature, props) {
        return {
            modelUrl: props.modelUrl || this.defaultPolygon3DModelUrl,
            fit: props.fit || this.defaultPolygon3DFit,
            rotate: props.rotate ?? this.defaultPolygon3DRotate,
            primitiveType: props.primitiveType || this.defaultPolygon3DPrimitiveType,
            size: this._parseSize(props.size) || this.defaultPolygon3DSize,
            anchor: this._parseTriple(props.anchor) || this.defaultPolygon3DAnchor,
            altitude: props.altitude ?? this.defaultPolygon3DAltitude,
            altitudeMode: props.altitudeMode || this.defaultPolygon3DAltitudeMode,
            color: props.color,
            depthTest: props.depthTest ?? this.defaultPolygon3DDepthTest,
            depthWrite: props.depthWrite ?? this.defaultPolygon3DDepthWrite,
            minZoom: props.minZoom,
            maxZoom: props.maxZoom,
            title: props.title || props.name,
            titlePlacement: props.titlePlacement,
            titleAlign: props.titleAlign,
            titleOffset: this._parsePair(props.titleOffset),
            titleStyle: props.titleStyle,
            titleMinZoom: props.titleMinZoom,
            titleMaxZoom: props.titleMaxZoom,
            tooltip: props.tooltip || props.description,
            onHover: props.onHover,
            onClick: props.onClick
        };
    }

    /**
     * Преобразует сырое значение размера (массив или строка с запятой) в массив двух чисел.
     *
     * @param {number[]|string} raw - Исходное значение.
     * @returns {number[]|null} Массив [ширина, высота] или null, если преобразовать не удалось.
     * @private
     */
    _parseSize(raw) {
        if (!raw) return null;
        if (Array.isArray(raw)) return raw;
        if (typeof raw === 'string') {
            const parts = raw.split(',').map(Number);
            if (parts.length === 2 && parts.every(v => !isNaN(v))) return parts;
        }
        return null;
    }

    /**
     * Преобразует сырое значение пары чисел (массив или строка с запятой) в массив двух чисел.
     * Используется, например, для смещения подписи.
     *
     * @param {number[]|string} raw - Исходное значение.
     * @returns {number[]|null} Массив [x, y] или null.
     * @private
     */
    _parsePair(raw) {
        if (!raw) return null;
        if (Array.isArray(raw)) return raw;
        if (typeof raw === 'string') {
            const parts = raw.split(',').map(Number);
            if (parts.length === 2 && parts.every(v => !isNaN(v))) return parts;
        }
        return null;
    }

    /**
     * Преобразует сырое значение якоря (массив или строка с запятой) в массив двух чисел.
     *
     * @param {number[]|string} raw - Исходное значение.
     * @returns {number[]|null} Массив [x, y] или null.
     * @private
     */
    _parseAnchor(raw) {
        if (!raw) return null;
        if (Array.isArray(raw)) return raw;
        if (typeof raw === 'string') {
            const parts = raw.split(',').map(Number);
            if (parts.length === 2 && parts.every(v => !isNaN(v))) return parts;
        }
        return null;
    }

    /**
     * Преобразует сырое значение тройки чисел (массив или строка с запятой) в массив трёх чисел.
     * Используется для anchor и rotation 3D-маркеров.
     *
     * @param {number[]|string} raw - Исходное значение.
     * @returns {number[]|null} Массив [x, y, z] или null.
     * @private
     */
    _parseTriple(raw) {
        if (!raw) return null;
        if (Array.isArray(raw)) return raw;
        if (typeof raw === 'string') {
            const parts = raw.split(',').map(Number);
            if (parts.length === 3 && parts.every(v => !isNaN(v))) return parts;
        }
        return null;
    }
}