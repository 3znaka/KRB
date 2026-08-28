//vectorTileDefaults.js
/**
 * Модуль стилей и порядка отрисовки векторных тайлов по умолчанию. Используется как в основном потоке (VectorTileLayer), так и внутри воркера.
 */

/**
 * Стили по умолчанию для различных типов объектов, сгруппированные по слоям.
 *
 * @property {Object} water - Стили водных объектов (озера, реки, пруды, бассейны, доки).
 * @property {Object} waterway - Стиль водных путей.
 * @property {Object} building - Стиль зданий.
 * @property {Object} landcover - Стили растительного покрова (лес, трава, парк и т.д.).
 * @property {Object} landuse - Стили землепользования (жилые, промышленные, коммерческие и т.д.).
 * @property {Object} park - Стили парков и охраняемых территорий.
 * @property {Object} transportation - Стили транспортной сети (дороги, железные дороги, паромы и т.д.).
 * @property {Object} transportation_name - Стили подписей транспортной сети.
 * @property {Object} aeroway - Стили аэропортовой инфраструктуры.
 * @property {Object} place - Стили населенных пунктов (город, поселок, деревня и т.д.).
 * @property {Object} poi - Стили точек интереса.
 * @property {Object} housenumber - Стили номеров домов.
 * @property {Object} mountain_peak - Стили горных вершин.
 * @property {Object} boundary - Стиль границ.
 * @property {Object} water_name - Стили подписей водных объектов.
 *
 * @example
 * const waterLakeStyle = DEFAULT_STYLES.water.lake;
 * const riverStyle = DEFAULT_STYLES.water.river;
 * const motorwayStyle = DEFAULT_STYLES.transportation.motorway;
 * const cityStyle = DEFAULT_STYLES.place.city;
 * console.log(waterLakeStyle.color, waterLakeStyle.opacity);
 * console.log(riverStyle.color, riverStyle.opacity);
 * console.log(motorwayStyle.color, motorwayStyle.width, motorwayStyle.dash);
 * console.log(cityStyle.radius, cityStyle.textColor, cityStyle.fontSize);
 */
export const DEFAULT_STYLES = {
    water: {
        lake: { color: 0xaaccff, opacity: 0.9 },
        river: { color: 0x99bbee, opacity: 0.9 },
        pond: { color: 0xaaccff, opacity: 0.8 },
        swimming_pool: { color: 0x88aadd, opacity: 0.8 },
        dock: { color: 0x8899aa, opacity: 0.8 },
        _default: { color: 0xaaccff, opacity: 0.9 }
    },
    waterway: { color: 0x99bbee, width: 1.5 },
    building: { color: 0xf0f0f0, stroke: 0xaaaaaa },
    landcover: {
        wood: { color: 0xc8e6c9 },
        forest: { color: 0xc8e6c9 },
        grass: { color: 0xdcedc8 },
        park: { color: 0xdcedc8 },
        sand: { color: 0xf5f0c0 },
        farmland: { color: 0xedf0c0 },
        wetland: { color: 0xb8d4c8 },
    },
    landuse: {
        residential: { color: 0xe0e0e0 },
        industrial: { color: 0xd9d9d9 },
        commercial: { color: 0xdddddd },
        railway: { color: 0xd5d5d5 },
        retail: { color: 0xdddddd },
        hospital: { color: 0xd9c8c8 },
        university: { color: 0xd5d5e0 },
        college: { color: 0xd5d5e0 },
        school: { color: 0xd5d5e0 },
        education: { color: 0xd5d5e0 },
        kindergarten: { color: 0xd5d5e0 },
        library: { color: 0xd5d5e0 },
        cemetery: { color: 0xbbddbb },
        military: { color: 0xc8c8c8 },
        allotments: { color: 0xdcedc8 },
        quarry: { color: 0xbbaa99 },
        construction: { color: 0xcccccc },
        pitch: { color: 0xc8e6c9 },
        stadium: { color: 0xc8e6c9 },
        track: { color: 0xc8c8c8 },
        grass: { color: 0xdcedc8 },
        farmyard: { color: 0xedf0c0 },
        zoo: { color: 0xc8e6c9 },
        theme_park: { color: 0xc8e6c9 },
        resort: { color: 0xdcedc8 },
        recreation_ground: { color: 0xdcedc8 },
        exhibition_centre: { color: 0xdddddd },
        bus_station: { color: 0xdddddd },
        dam: { color: 0xaaaaaa },
        playground: { color: 0xdcedc8 },
        neighbourhood: { color: 0xe8e8e8 },
        suburb: { color: 0xe8e8e8 },
        quarter: { color: 0xe8e8e8 },
        garages: { color: 0xd0d0d0 },
        healthcare: { color: 0xd9c8c8 },
        _default: { color: 0xeeeeee }
    },
    park: {
        park: { color: 0xdcedc8 },
        national_park: { color: 0xb8d8a0 },
        nature_reserve: { color: 0xb8d8a0 },
        protected_area: { color: 0xb8d8a0 },
        _default: { color: 0xdcedc8 }
    },
    transportation: {
        motorway:          { color: 0xff9933, width: 2.5 },
        trunk:             { color: 0xffcc66, width: 2.0 },
        primary:           { color: 0xffd699, width: 1.8 },
        secondary:         { color: 0xffe0b3, width: 1.5 },
        tertiary:          { color: 0xffffff, width: 1.2 },
        minor:             { color: 0xeeeeee, width: 1.0 },
        residential:       { color: 0xeeeeee, width: 1.0 },
        path:              { color: 0xaaaaaa, width: 0.8 },
        track:             { color: 0xaaaaaa, width: 0.8 },
        rail:              { color: 0x888888, width: 1.5, dash: [6, 2] },
        ferry:             { color: 0x6699cc, width: 1.2, dash: [4, 4] },
        aerialway:         { color: 0x666666, width: 1.0, dash: [2, 2] },
        bridge:            { color: 0xffaa00, width: 2.0 },
        pier:              { color: 0xcccccc, width: 1.0 },
        raceway:           { color: 0xff6666, width: 1.5 },
        service:           { color: 0xcccccc, width: 0.8 },
        transit:           { color: 0xdddddd, width: 1.2 },
        motorway_construction: { color: 0xff9933, width: 2.5, dash: [8, 4] },
        trunk_construction:    { color: 0xffcc66, width: 2.0, dash: [8, 4] },
        primary_construction:  { color: 0xffd699, width: 1.8, dash: [8, 4] },
        secondary_construction:{ color: 0xffe0b3, width: 1.5, dash: [8, 4] },
        tertiary_construction: { color: 0xffffff, width: 1.2, dash: [8, 4] },
        minor_construction:    { color: 0xeeeeee, width: 1.0, dash: [8, 4] },
        service_construction:  { color: 0xcccccc, width: 0.8, dash: [8, 4] },
        path_construction:     { color: 0xaaaaaa, width: 0.8, dash: [6, 3] },
        _default:             { color: 0xcccccc, width: 1.0 }
    },
    transportation_name: {
        _default: { color: 0xffffff, width: 0.2, opacity: 0.3 }
    },
    aeroway: {
        runway: { color: 0xcccccc, width: 2.0 },
        taxiway: { color: 0xdddddd, width: 1.0 },
        _default: { color: 0xcccccc, width: 1.0 }
    },
    place: {
        city: { 
            color: 0xe8e8e8, stroke: 0xcccccc, opacity: 0.7, radius: 5,
            textColor: '#333333', fontSize: '14px', fontWeight: 'bold',
            textOffset: [0, -10], textZoomMin: 0, textZoomMax: 24
        },
        town: { 
            color: 0xe8e8e8, stroke: 0xcccccc, opacity: 0.6, radius: 4,
            textColor: '#333333', fontSize: '13px', fontWeight: 'bold',
            textOffset: [0, -8], textZoomMin: 0, textZoomMax: 24
        },
        village: { 
            color: 0xe8e8e8, stroke: 0xcccccc, opacity: 0.5, radius: 3,
            textColor: '#333333', fontSize: '12px', fontWeight: 'normal',
            textOffset: [0, -6], textZoomMin: 0, textZoomMax: 24
        },
        hamlet: { 
            color: 0xe8e8e8, stroke: 0xcccccc, opacity: 0.4, radius: 2,
            textColor: '#333333', fontSize: '11px', fontWeight: 'normal',
            textOffset: [0, -4], textZoomMin: 0, textZoomMax: 24
        },
        _default: { 
            color: 0xe8e8e8, opacity: 0.5, radius: 3,
            textColor: '#333333', fontSize: '12px',
            textOffset: [0, -6], textZoomMin: 0, textZoomMax: 24
        }
    },
    poi: {
        _default: { 
            color: 0xcccccc, radius: 4,
            textColor: '#555555', fontSize: '11px', fontWeight: 'normal',
            textOffset: [0, -8], textZoomMin: 13, textZoomMax: 24
        }
    },
    housenumber: {
        _default: { 
            color: 0xffffff, radius: 2,
            textColor: '#333333', fontSize: '10px', fontWeight: 'normal',
            textOffset: [0, -4], textZoomMin: 16, textZoomMax: 24
        }
    },
    mountain_peak: {
        _default: { color: 0xffffff, radius: 3 }
    },
    boundary: { color: 0x999999, width: 1.0, dash: [4, 2] },
    water_name: {
        _default: { color: 0xaaccff, width: 0.2, opacity: 0.3 }
    },
};

/**
 * Порядок отрисовки слоёв. Чем больше число, тем выше слой.
 *
 * @property {number} water - Порядок отрисовки слоя водных объектов.
 * @property {number} waterway - Порядок отрисовки слоя водных путей.
 * @property {number} water_name - Порядок отрисовки подписей водных объектов.
 * @property {number} landuse - Порядок отрисовки слоя землепользования.
 * @property {number} landcover - Порядок отрисовки слоя растительного покрова.
 * @property {number} park - Порядок отрисовки слоя парков.
 * @property {number} building - Порядок отрисовки слоя зданий.
 * @property {number} place - Порядок отрисовки слоя населенных пунктов.
 * @property {number} boundary - Порядок отрисовки слоя границ.
 * @property {number} aeroway - Порядок отрисовки слоя аэропортовой инфраструктуры.
 * @property {number} transportation - Порядок отрисовки слоя транспортной сети.
 * @property {number} transportation_name - Порядок отрисовки подписей транспортной сети.
 * @property {number} poi - Порядок отрисовки слоя точек интереса.
 * @property {number} housenumber - Порядок отрисовки слоя номеров домов.
 * @property {number} mountain_peak - Порядок отрисовки слоя горных вершин.
 *
 * @example
 * const waterOrder = LAYER_RENDER_ORDER.water;
 * const buildingOrder = LAYER_RENDER_ORDER.building;
 * console.log(waterOrder, buildingOrder);
 */
export const LAYER_RENDER_ORDER = {
    water: 1,
    waterway: 2,
    water_name: 3,
    landuse: 0,
    landcover: 0,
    park: 0,
    building: 7,
    place: 4,
    boundary: 4,
    aeroway: 10,
    transportation: 15,
    transportation_name: 16,
    poi: 20,
    housenumber: 21,
    mountain_peak: 20,
};