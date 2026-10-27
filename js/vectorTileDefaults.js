// vectorTileDefaults.js
/**
 * Модуль стилей и порядка отрисовки векторных тайлов по умолчанию.
 * Используется как в основном потоке (VectorTileLayer), так и внутри воркера.
 *
 * СОГЛАШЕНИЯ:
 * - Для слоёв, которые в воркере обрабатываются как точечные объекты и
 *   попадают в подписи (`place`, `poi`, `housenumber`), стиль может содержать
 *   текстовые поля: textColor, fontSize, fontFamily, fontWeight, fontStyle,
 *   textTransform, textLetterSpacing, textShadow, textOffset, textAlign,
 *   textVerticalAlign, textPriority, textZoomMin, textZoomMax.
 * - Для линейных слоёв (`transportation`, `waterway`, `water_name`,
 *   `transportation_name`) подписи генерируются только если в стиле задан
 *   хотя бы один текстовый атрибут И у фичи есть `name`/`ref`. Дополнительно
 *   используются `textPlacement` (по умолчанию 'along') и
 *   `textMinSegmentLength` (минимальная длина сегмента в долях tileSize,
 *   по умолчанию 0.15) для размещения и фильтрации вдоль линии.
 * - Поле `stroke` имеет смысл только для полигональных слоёв (заливки/обводки
 *   контура). Для точечных слоёв оно игнорируется.
 */

/**
 * Стили по умолчанию для различных типов объектов, сгруппированные по слоям.
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
    waterway: {
        color: 0x99bbee,
        width: 1.5,
        // Подписи рек/каналов вдоль линии. Появляются при zoom ≥ 14,
        // чтобы избежать «каши» из ручьёв и канав на обзорных уровнях.
        textColor: '#1e4d6b',
        fontSize: '11px',
        textPlacement: 'along',
        textFontStyle: 'italic',
        textShadow: '0 0 2px rgba(255,255,255,0.85)',
        textZoomMin: 14,
        textZoomMax: 21,
        textPriority: 50,
        textMinSegmentLength: 0.1
    },
    building: { color: 0xf0f0f0, stroke: 0xaaaaaa },
    landcover: {
        wood: { color: 0xc8e6c9 },
        forest: { color: 0xc8e6c9 },
        grass: { color: 0xdcedc8 },
        park: { color: 0xdcedc8 },
        sand: { color: 0xf5f0c0 },
        farmland: { color: 0xedf0c0 },
        wetland: { color: 0xb8d4c8 }
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
    leisure: {
        park: { color: 0xdcedc8 },
        garden: { color: 0xdcedc8 },
        playground: { color: 0xdcedc8 },
        pitch: { color: 0xc8e6c9 },
        stadium: { color: 0xc8e6c9 },
        sports_centre: { color: 0xc8e6c9 },
        golf_course: { color: 0xc8e6c9 },
        _default: { color: 0xdcedc8 }
    },

    // Транспорт: линейные подписи вдоль дорог (кроме мелких/временных типов).
    // Приоритеты убывают от магистралей к местным улицам, но остаются
    // выше POI (60) и воды (50), чтобы названия улиц всегда читались первыми.
    // textMinSegmentLength — минимальная длина сегмента в долях tileSize:
    // короткие куски улиц не подписываются.
    transportation: {
        motorway: {
            color: 0xff9933, width: 2.5,
            textColor: '#5c3a00',
            fontSize: '11px',
            fontWeight: 'bold',
            textPlacement: 'along',
            textShadow: '0 0 2px rgba(255,255,255,0.9)',
            textZoomMin: 10, textZoomMax: 21,
            textPriority: 100,
            textMinSegmentLength: 0.03
        },
        trunk: {
            color: 0xffcc66, width: 2.0,
            textColor: '#5c4400',
            fontSize: '11px',
            fontWeight: 'bold',
            textPlacement: 'along',
            textShadow: '0 0 2px rgba(255,255,255,0.9)',
            textZoomMin: 11, textZoomMax: 21,
            textPriority: 95,
            textMinSegmentLength: 0.03
        },
        primary: {
            color: 0xffd699, width: 1.8,
            textColor: '#553a1a',
            fontSize: '11px',
            fontWeight: 'normal',
            textPlacement: 'along',
            textShadow: '0 0 2px rgba(255,255,255,0.9)',
            textZoomMin: 12, textZoomMax: 21,
            textPriority: 90,
            textMinSegmentLength: 0.05
        },
        secondary: {
            color: 0xffe0b3, width: 1.5,
            textColor: '#554a33',
            fontSize: '10px',
            fontWeight: 'normal',
            textPlacement: 'along',
            textShadow: '0 0 2px rgba(255,255,255,0.9)',
            textZoomMin: 13, textZoomMax: 21,
            textPriority: 85,
            textMinSegmentLength: 0.05
        },
        tertiary: {
            color: 0xffffff, width: 1.2,
            textColor: '#444444',
            fontSize: '10px',
            fontWeight: 'normal',
            textPlacement: 'along',
            textShadow: '0 0 2px rgba(255,255,255,0.9)',
            textZoomMin: 14, textZoomMax: 21,
            textPriority: 80,
            textMinSegmentLength: 0.08
        },
        minor: {
            color: 0xeeeeee, width: 1.0,
            textColor: '#555555',
            fontSize: '10px',
            fontWeight: 'normal',
            textPlacement: 'along',
            textShadow: '0 0 2px rgba(255,255,255,0.9)',
            textZoomMin: 16, textZoomMax: 20,
            textPriority: 75,
            textMinSegmentLength: 0.1
        },
        residential: {
            color: 0xeeeeee, width: 1.0,
            textColor: '#555555',
            fontSize: '10px',
            fontWeight: 'normal',
            textPlacement: 'along',
            textShadow: '0 0 2px rgba(255,255,255,0.9)',
            textZoomMin: 16, textZoomMax: 20,
            textPriority: 75,
            textMinSegmentLength: 0.1
        },
        service: {
            color: 0xcccccc, width: 0.8,
            textColor: '#666666',
            fontSize: '9px',
            fontWeight: 'normal',
            textPlacement: 'along',
            textShadow: '0 0 2px rgba(255,255,255,0.9)',
            textZoomMin: 18, textZoomMax: 21,
            textPriority: 70,
            textMinSegmentLength: 0.15
        },
        rail: {
            color: 0x888888, width: 1.5, dash: [6, 2],
            textColor: '#444444',
            fontSize: '10px',
            fontWeight: 'normal',
            textFontStyle: 'italic',
            textPlacement: 'along',
            textShadow: '0 0 2px rgba(255,255,255,0.9)',
            textZoomMin: 15, textZoomMax: 20,
            textPriority: 65,
            textMinSegmentLength: 0.1
        },
        // Без текста: path, track, ferry, aerialway, bridge, pier, raceway,
        // transit, *_construction — либо слишком мелкие, либо временные,
        // либо не несут самостоятельного имени.
        path:              { color: 0xaaaaaa, width: 0.8 },
        track:             { color: 0xaaaaaa, width: 0.8 },
        ferry:             { color: 0x6699cc, width: 1.2, dash: [4, 4] },
        aerialway:         { color: 0x666666, width: 1.0, dash: [2, 2] },
        bridge:            { color: 0xffaa00, width: 2.0 },
        pier:              { color: 0xcccccc, width: 1.0 },
        raceway:           { color: 0xff6666, width: 1.5 },
        transit:           { color: 0xdddddd, width: 1.2 },
        motorway_construction: { color: 0xff9933, width: 2.5, dash: [8, 4] },
        trunk_construction:    { color: 0xffcc66, width: 2.0, dash: [8, 4] },
        primary_construction:  { color: 0xffd699, width: 1.8, dash: [8, 4] },
        secondary_construction:{ color: 0xffe0b3, width: 1.5, dash: [8, 4] },
        tertiary_construction: { color: 0xffffff, width: 1.2, dash: [8, 4] },
        minor_construction:    { color: 0xeeeeee, width: 1.0, dash: [8, 4] },
        service_construction:  { color: 0xcccccc, width: 0.8, dash: [8, 4] },
        path_construction:     { color: 0xaaaaaa, width: 0.8, dash: [6, 3] },
        _default: {
            color: 0xcccccc, width: 1.0,
            textColor: '#555555',
            fontSize: '10px',
            fontWeight: 'normal',
            textPlacement: 'along',
            textShadow: '0 0 2px rgba(255,255,255,0.9)',
            textZoomMin: 16, textZoomMax: 20,
            textPriority: 70,
            textMinSegmentLength: 0.12
        }
    },


    transportation_name: {
        motorway: {
            color: 0xffffff, width: 0.2, opacity: 0.3,
            textColor: '#5c3a00',
            fontSize: '11px',
            fontWeight: 'bold',
            textPlacement: 'along',
            textShadow: '0 0 2px rgba(255,255,255,0.9)',
            textZoomMin: 10, textZoomMax: 21,
            textPriority: 100,
            textMinSegmentLength: 0.03
        },
        trunk: {
            color: 0xffffff, width: 0.2, opacity: 0.3,
            textColor: '#5c4400',
            fontSize: '11px',
            fontWeight: 'bold',
            textPlacement: 'along',
            textShadow: '0 0 2px rgba(255,255,255,0.9)',
            textZoomMin: 11, textZoomMax: 21,
            textPriority: 95,
            textMinSegmentLength: 0.03
        },
        primary: {
            color: 0xffffff, width: 0.2, opacity: 0.3,
            textColor: '#553a1a',
            fontSize: '11px',
            fontWeight: 'normal',
            textPlacement: 'along',
            textShadow: '0 0 2px rgba(255,255,255,0.9)',
            textZoomMin: 12, textZoomMax: 21,
            textPriority: 90,
            textMinSegmentLength: 0.05
        },
        secondary: {
            color: 0xffffff, width: 0.2, opacity: 0.3,
            textColor: '#554a33',
            fontSize: '10px',
            fontWeight: 'normal',
            textPlacement: 'along',
            textShadow: '0 0 2px rgba(255,255,255,0.9)',
            textZoomMin: 13, textZoomMax: 21,
            textPriority: 85,
            textMinSegmentLength: 0.05
        },
        tertiary: {
            color: 0xffffff, width: 0.2, opacity: 0.3,
            textColor: '#444444',
            fontSize: '10px',
            fontWeight: 'normal',
            textPlacement: 'along',
            textShadow: '0 0 2px rgba(255,255,255,0.9)',
            textZoomMin: 14, textZoomMax: 21,
            textPriority: 80,
            textMinSegmentLength: 0.08
        },
        minor: {
            color: 0xffffff, width: 0.2, opacity: 0.3,
            textColor: '#555555',
            fontSize: '10px',
            fontWeight: 'normal',
            textPlacement: 'along',
            textShadow: '0 0 2px rgba(255,255,255,0.9)',
            textZoomMin: 16, textZoomMax: 20,
            textPriority: 75,
            textMinSegmentLength: 0.1
        },
        residential: {
            color: 0xffffff, width: 0.2, opacity: 0.3,
            textColor: '#555555',
            fontSize: '10px',
            fontWeight: 'normal',
            textPlacement: 'along',
            textShadow: '0 0 2px rgba(255,255,255,0.9)',
            textZoomMin: 16, textZoomMax: 20,
            textPriority: 75,
            textMinSegmentLength: 0.1
        },
        service: {
            color: 0xffffff, width: 0.2, opacity: 0.3,
            textColor: '#666666',
            fontSize: '9px',
            fontWeight: 'normal',
            textPlacement: 'along',
            textShadow: '0 0 2px rgba(255,255,255,0.9)',
            textZoomMin: 18, textZoomMax: 21,
            textPriority: 70,
            textMinSegmentLength: 0.15
        },
        rail: {
            color: 0xffffff, width: 0.2, opacity: 0.3,
            textColor: '#444444',
            fontSize: '10px',
            fontWeight: 'normal',
            textFontStyle: 'italic',
            textPlacement: 'along',
            textShadow: '0 0 2px rgba(255,255,255,0.9)',
            textZoomMin: 15, textZoomMax: 20,
            textPriority: 65,
            textMinSegmentLength: 0.1
        },
        _default: {
            color: 0xffffff, width: 0.2, opacity: 0.3,
            textColor: '#555555',
            fontSize: '10px',
            fontWeight: 'normal',
            textPlacement: 'along',
            textShadow: '0 0 2px rgba(255,255,255,0.9)',
            textZoomMin: 14, textZoomMax: 21,
            textPriority: 70,
            textMinSegmentLength: 0.1
        }
    },

    aeroway: {
        runway: { color: 0xcccccc, width: 2.0 },
        taxiway: { color: 0xdddddd, width: 1.0 },
        _default: { color: 0xcccccc, width: 1.0 }
    },

    // Населённые пункты и районы.
    // Города — жирные, крупные; районы (_default) — капителью с разрядкой,
    // чтобы визуально отличаться от названий улиц.
    place: {
        city: {
            color: 0xe8e8e8, opacity: 0.7, radius: 5,
            textColor: '#333333',
            fontSize: '14px',
            fontWeight: 'bold',
            textOffset: [0, -10],
            textZoomMin: 0, textZoomMax: 24,
            textPriority: 200
        },
        town: {
            color: 0xe8e8e8, opacity: 0.6, radius: 4,
            textColor: '#333333',
            fontSize: '13px',
            fontWeight: 'bold',
            textOffset: [0, -8],
            textZoomMin: 0, textZoomMax: 24,
            textPriority: 180
        },
        village: {
            color: 0xe8e8e8, opacity: 0.5, radius: 3,
            textColor: '#333333',
            fontSize: '12px',
            fontWeight: 'normal',
            textOffset: [0, -6],
            textZoomMin: 0, textZoomMax: 24,
            textPriority: 160
        },
        hamlet: {
            color: 0xe8e8e8, opacity: 0.4, radius: 2,
            textColor: '#333333',
            fontSize: '11px',
            fontWeight: 'normal',
            textOffset: [0, -4],
            textZoomMin: 0, textZoomMax: 24,
            textPriority: 140
        },
        _default: {
            color: 0xe8e8e8, opacity: 0.5, radius: 3,
            textColor: '#444444',
            fontSize: '11px',
            fontWeight: 'normal',
            textTransform: 'uppercase',
            textLetterSpacing: '0.08em',
            textOffset: [0, -6],
            textZoomMin: 10, textZoomMax: 24,
            textPriority: 120
        }
    },

    // POI: приоритет ниже названий улиц (75–100), но выше воды (50)
    // и номеров домов (30). Так улицы всегда читаются первыми.
    poi: {
        _default: {
            color: 0xcccccc, radius: 4,
            textColor: '#555555',
            fontSize: '11px',
            fontWeight: 'normal',
            textOffset: [0, -8],
            textZoomMin: 13, textZoomMax: 24,
            textPriority: 60
        }
    },

    // Номера домов — самые низкоприоритетные, чтобы не забивать карту.
    housenumber: {
        _default: {
            color: 0xffffff, radius: 2,
            textColor: '#333333',
            fontSize: '10px',
            fontWeight: 'normal',
            textOffset: [0, -4],
            textZoomMin: 16, textZoomMax: 24,
            textPriority: 30
        }
    },

    mountain_peak: {
        _default: {
            color: 0xffffff, radius: 3,
            textColor: '#333333',
            fontSize: '11px',
            fontWeight: 'bold',
            textOffset: [0, -6],
            textZoomMin: 12, textZoomMax: 24,
            textPriority: 110
        }
    },

    // Границы: подписи намеренно не добавлены — названия стран/регионов
    // уже приходят через слой `place` (точки), и текст на самих линиях
    // дублировал бы их.
    boundary: { color: 0x999999, width: 1.0, dash: [4, 2] },

    // Carrier-слой для названий водоёмов (озёр, морей) и рек в тайлах
    // Mapbox-стиля. Приоритет ниже дорог и POI, но выше номеров домов.
    water_name: {
        _default: {
            color: 0xaaccff, width: 0.2, opacity: 0.3,
            textColor: '#1e4d6b',
            fontSize: '11px',
            fontWeight: 'normal',
            textFontStyle: 'italic',
            textPlacement: 'along',
            textShadow: '0 0 2px rgba(255,255,255,0.85)',
            textZoomMin: 12, textZoomMax: 21,
            textPriority: 45,
            textMinSegmentLength: 0.1
        }
    }
};

/**
 * Порядок отрисовки слоёв. Чем больше число, тем выше слой.
 *
 * Числа уникальны и расставлены с шагом 10: это оставляет запас для
 * вставки новых слоёв без переписывания всего блока.
 *
 * Иерархия (снизу вверх):
 *   1. Фоновые площадные объекты (landuse, landcover, park, leisure).
 *   2. Гидрография (water, waterway).
 *   3. Границы и аэродромная инфраструктура (boundary, aeroway).
 *   4. Дорожная сеть (transportation).
 *   5. Здания (building) — перекрывают дороги.
 *   6. Подписи (water_name, transportation_name, poi, place, mountain_peak,
 *      aerodrome_label, housenumber) — всегда выше геометрии.
 *
 * Набор слоёв соответствует схеме OpenMapTiles (docs.maptiler.com/schema/
 * omt-planet/): aerodrome_label, aeroway, boundary, building, housenumber,
 * landcover, landuse, mountain_peak, park, place, poi, transportation,
 * transportation_name, water, water_name, waterway. Слой `leisure` добавлен
 * отдельно — в некоторых OSM-схемах он выносится из `landuse`.
 *
 * @property {number} landuse            — Землепользование (жилые, промышленные зоны).
 * @property {number} landcover          — Растительный/почвенный покров (лес, трава, песок).
 * @property {number} park               — Парки и охраняемые территории.
 * @property {number} leisure            — Зоны отдыха (спортплощадки, стадионы).
 * @property {number} water              — Водные полигоны (озёра, моря, реки-полигоны).
 * @property {number} waterway           — Водные линии (реки, каналы, ручьи).
 * @property {number} boundary           — Административные границы.
 * @property {number} aeroway            — Аэродромная инфраструктура (ВПП, рулёжки).
 * @property {number} transportation     — Дороги, железные дороги, паромы.
 * @property {number} building           — Здания (в т.ч. 3D).
 * @property {number} water_name         — Подписи водоёмов (carrier-линии).
 * @property {number} transportation_name— Подписи дорог (carrier-линии).
 * @property {number} poi                — Точки интереса (POI).
 * @property {number} place              — Населённые пункты (города, деревни).
 * @property {number} mountain_peak      — Горные вершины.
 * @property {number} aerodrome_label    — Подписи аэродромов.
 * @property {number} housenumber        — Номера домов.
 */
export const LAYER_RENDER_ORDER = {
    landuse:             10,
    landcover:           20,
    park:                30,
    leisure:             40,
    water:               50,
    waterway:            60,
    boundary:            70,
    aeroway:             80,
    transportation:      90,
    building:           100,
    water_name:         110,
    transportation_name:120,
    poi:                130,
    place:              140,
    mountain_peak:      150,
    aerodrome_label:    160,
    housenumber:        170
};