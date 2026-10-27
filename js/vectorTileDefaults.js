// vectorTileDefaults.js
/**
 * Стили и порядок отрисовки векторных тайлов по умолчанию.
 * Сгенерированы по образцу MapTiler/OpenMapTiles v4 "Bright" (style-cdn.json).
 *
 * ═══════════════════════════════════════════════════════════════════════
 * СОГЛАШЕНИЯ
 * ═══════════════════════════════════════════════════════════════════════
 *
 * Значение любого свойства (color, width, opacity, dash, radius, height,
 * base, textColor, fontSize, fontWeight, ...) может быть:
 *   1. Примитивом (число, hex-цвет 0xRRGGBB, hex-строка '#RRGGBB', массив).
 *   2. Спекой одного из типов ниже; резолвится воркером через resolveValue.
 *
 *   { type: 'match', by: 'key' | ['k1','k2'], values: { v: <spec>, _default } }
 *       — выбирает values[feature.properties[by]] по первому найденному
 *         ключу (если by — массив). Не найдено → _default.
 *
 *   { type: 'zoom', stops: [[z, v], ...] }
 *       — линейная интерполяция по continuousZoom, clamp по краям.
 *         Для цветов (числа 0xRRGGBB) интерполяция покомпонентная (RGB).
 *
 *   { type: 'step', by: 'zoom', stops: [[z, v], ...], default: v0 }
 *       — ступенчатая (без интерполяции).
 *
 *   { type: 'field', keys: ['a','b'], fallback: <spec|primitive> }
 *       — первое непустое значение из feature.properties, иначе fallback.
 *
 *   { type: 'coalesce', of: [<spec>, <spec>, ...] }
 *       — первая непустая спека.
 *
 *   { type: 'levels', multiplier: 3 }
 *       — parseInt(props['building:levels']) * multiplier, либо 0.
 *
 * Фильтры (`filter` на уровне source-layer):
 *   { type: 'in', key, values: [...] }   // ["in", "key", ...] / match по ключу
 *   { type: 'eq', key, value }           // ["==", "key", v]
 *   { type: 'exists', key }              // ["has", "key"]
 *   { type: 'gt'|'gte'|'lt'|'lte', key, value }
 *   { type: 'any'|'all', of: [<filter>, ...] }
 *   { type: 'not', of: <filter> }
 *   { type: 'geometry', in: [1,2,3] }    // 1=Point, 2=LineString, 3=Polygon
 *
 * Поля текста на точках/линиях (textColor, fontSize, textPlacement,
 * textPriority, textZoomMin, textZoomMax, textOffset и т.д.) — те же, что
 * были, но значения могут быть спеками.
 *
 * `stroke` имеет смысл только для полигонов/зданий; для линий и точек
 * игнорируется. `base` — только для зданий (fill-extrusion).
 */

// ────────────────────────────────────────────────────────────────────────
// Стили
// ────────────────────────────────────────────────────────────────────────

export const DEFAULT_STYLES = {

    // ─────────────────────────────────────────────────────────────────
    // LANDCOVER
    // Покрывает: landcover-glacier, landcover-wood, landcover-grass,
    //            landcover-ice-shelf, landcover-sand
    // filter (в style.json): подслой subclass=glacier/ice_shelf или
    //                        class=wood/grass/sand
    // Сведено к match по ['class','subclass'] (первый найденный ключ).
    // ─────────────────────────────────────────────────────────────────
    landcover: {
        filter: { type: 'geometry', in: [3] },
        color: {
            type: 'match',
            by: ['class', 'subclass'],
            values: {
                glacier:   0xffffff,
                ice_shelf: 0xffffff,
                wood:      0x66aa44,
                grass:     0xd8e8c8,
                sand:      0xf5eebc,
                _default:  0xffffff
            }
        },
        opacity: {
            type: 'match',
            by: ['class', 'subclass'],
            values: {
                glacier:   { type: 'zoom', stops: [[0, 0.9], [10, 0.3]] },
                ice_shelf: { type: 'zoom', stops: [[0, 0.9], [10, 0.3]] },
                wood:      0.1,
                grass:     1,
                sand:      1,
                _default:  0.3
            }
        }
    },

    // ─────────────────────────────────────────────────────────────────
    // LANDUSE
    // Покрывает: landuse-residential, landuse-commercial,
    //            landuse-industrial, landuse-cemetery, landuse-hospital,
    //            landuse-school, landuse-railway
    // filter: $type=Polygon (все landuse-слои) + class in [...]
    // Классы для residential: residential, suburb, neighbourhood
    // Классы для industrial: industrial, garages, dam
    // Цвета hsla(...) разложены в hex + opacity.
    // ─────────────────────────────────────────────────────────────────
    landuse: {
        filter: { type: 'geometry', in: [3] },
        color: {
            type: 'match',
            by: 'class',
            values: {
                residential:   0xeee6dd,  // hsla(30,19%,90%,*)
                suburb:        0xeee6dd,
                neighbourhood: 0xeee6dd,
                commercial:    0xf2cccc,  // hsla(0,60%,87%,*)
                industrial:    0xffeeC2,  // hsla(49,100%,88%,*)
                garages:       0xffeeC2,
                dam:           0xffeeC2,
                cemetery:      0xe0e4dd,
                hospital:      0xffddee,  // #fde
                school:        0xf0e8f8,
                railway:       0xeee6dd,
                _default:      undefined  // → не рисуем
            }
        },
        opacity: {
            type: 'match',
            by: 'class',
            values: {
                residential:   { type: 'zoom', stops: [[12, 0.4], [16, 0.2]] },
                suburb:        { type: 'zoom', stops: [[12, 0.4], [16, 0.2]] },
                neighbourhood: { type: 'zoom', stops: [[12, 0.4], [16, 0.2]] },
                commercial:    0.23,
                industrial:    0.34,
                garages:       0.34,
                dam:           0.34,
                cemetery:      1,
                hospital:      1,
                school:        1,
                railway:       0.4,
                _default:      1
            }
        }
    },

    // ─────────────────────────────────────────────────────────────────
    // PARK
    // Покрывает: landcover-grass-park (единственный слой)
    // filter: class=public_park
    // ─────────────────────────────────────────────────────────────────
    park: {
        filter: {
            type: 'all',
            of: [
                { type: 'geometry', in: [3] },
                { type: 'eq', key: 'class', value: 'public_park' }
            ]
        },
        color: 0xd8e8c8,
        opacity: 0.8
    },

    // ─────────────────────────────────────────────────────────────────
    // WATERWAY (линии)
    // Покрывает: waterway_tunnel, waterway-other,
    //            waterway-other-intermittent, waterway-stream-canal,
    //            waterway-stream-canal-intermittent, waterway-river,
    //            waterway-river-intermittent
    // Все — линии цвета #a0c8f0. Разница: ширина (по class), пунктир
    // (туннели и intermittent).
    // ─────────────────────────────────────────────────────────────────
    waterway: {
        filter: { type: 'geometry', in: [2] },
        color: 0xa0c8f0,
        width: {
            type: 'match',
            by: ['brunnel', 'class'],
            values: {
                // туннель — ширина как у stream/canal
                tunnel: { type: 'zoom', stops: [[13, 0.5], [20, 6]] },
                river:  { type: 'zoom', stops: [[10, 0.8], [20, 6]] },
                stream: { type: 'zoom', stops: [[13, 0.5], [20, 6]] },
                canal:  { type: 'zoom', stops: [[13, 0.5], [20, 6]] },
                _default: { type: 'zoom', stops: [[13, 0.5], [20, 2]] }
            }
        },
        dash: {
            type: 'match',
            by: ['brunnel', 'intermittent'],
            values: {
                tunnel: [2, 4],
                1:      [4, 3],
                _default: undefined
            }
        },
        // Подписи вдоль линии
        textColor: '#74aee9',
        fontSize: '14px',
        textFontStyle: 'italic',
        textPlacement: 'along',
        textShadow: '0 0 2px rgba(255,255,255,0.7)',
        textZoomMin: 10,
        textZoomMax: 21,
        textPriority: 50,
        textMinSegmentLength: 0.1
    },

    // ─────────────────────────────────────────────────────────────────
    // WATER (полигоны)
    // Покрывает: water-offset, water, water-intermittent
    // filter: $type=Polygon; intermittent=1 → 0.7 opacity
    // Цвет hsl(210,67%,85%) → 0xb3d2f0.
    // ─────────────────────────────────────────────────────────────────
    water: {
        filter: { type: 'geometry', in: [3] },
        color: 0xb3d2f0,
        opacity: {
            type: 'match',
            by: 'intermittent',
            values: {
                1: 0.7,
                _default: 1
            }
        }
    },

    // ─────────────────────────────────────────────────────────────────
    // BUILDING
    // Покрывает: building, building-top
    // filter: $type=Polygon
    // Цвет: fill-color — zoom [[15.5, #f2eae2], [16, #dfdbd7]]
    // Высота: render_height/height или building:levels*3
    // base: render_min_height/min_height
    // ─────────────────────────────────────────────────────────────────
    building: {
        filter: { type: 'geometry', in: [3] },
        color: { type: 'zoom', stops: [[15.5, 0xf2eae2], [16, 0xdfdbd7]] },
        stroke: 0xaaaaaa,
        height: {
            type: 'field',
            keys: ['render_height', 'height'],
            fallback: { type: 'levels', multiplier: 3 }
        },
        base: {
            type: 'field',
            keys: ['render_min_height', 'min_height'],
            fallback: 0
        }
    },

    // ─────────────────────────────────────────────────────────────────
    // TRANSPORTATION (геометрия дорог, ЖД, паромов, мостов, туннелей)
    // Покрывает: tunnel-*, ferry, highway-*, railway-*, bridge-*, cablecar*
    // filter в style.json многообразен, но по сути:
    //   - tunnel-*  : brunnel=tunnel (цвет светлый, ширина как у regular)
    //   - bridge-*  : brunnel=bridge (цвет как у regular)
    //   - highway-* : class=motorway/trunk/primary/secondary/tertiary/minor/
    //                 service/track/path (плюс motorway_construction)
    //   - railway-* : class=rail/transit
    //   - ferry     : class=ferry
    // Сведено к match по ['brunnel', 'class'] (brunnel — приоритет).
    // Casing (обводка) не поддерживается: используется только fill-цвет.
    // ─────────────────────────────────────────────────────────────────
    transportation: {
        color: {
            type: 'match',
            by: ['brunnel', 'class'],
            values: {
                // tunnels — общий приглушённый оттенок
                tunnel: 0xfff4c6,
                // bridges — как у regular
                bridge: 0xffeaaa,
                // regular по классу
                motorway:  0xffcc88,   // #fc8
                trunk:     0xffeaaa,   // #fea
                primary:   0xffeaaa,
                secondary: 0xffeaaa,
                tertiary:  0xffeaaa,
                minor:     0xffffff,
                service:   0xffffff,
                track:     0xffffff,
                path:      0xccbbaa,   // #cba
                steps:     0xffffff,
                rail:      0xbbbbbb,
                transit:   0xbbbbbb,   // hsla(0,0%,73%,0.77)
                ferry:     0x6c9fb6,   // rgba(108,159,182,1)
                pier:      0xf8f4f0,
                motorway_construction: 0xffffff,
                _default:  0xcccccc
            }
        },
        // Ширина — по class (у туннелей и мостов та же, что у regular)
        width: {
            type: 'match',
            by: 'class',
            values: {
                motorway:   { type: 'zoom', stops: [[6.5, 0], [7, 0.5], [20, 18]] },
                trunk:      { type: 'zoom', stops: [[6.5, 0], [7, 0.5], [20, 18]] },
                primary:    { type: 'zoom', stops: [[8.5, 0], [9, 0.5], [20, 18]] },
                secondary:  { type: 'zoom', stops: [[6.5, 0], [8, 0.5], [20, 13]] },
                tertiary:   { type: 'zoom', stops: [[6.5, 0], [8, 0.5], [20, 13]] },
                minor:      { type: 'zoom', stops: [[13.5, 0], [14, 2.5], [20, 11.5]] },
                service:    { type: 'zoom', stops: [[13.5, 0], [14, 2.5], [20, 11.5]] },
                track:      { type: 'zoom', stops: [[13.5, 0], [14, 2.5], [20, 11.5]] },
                path:       { type: 'zoom', stops: [[15, 1.2], [20, 4]] },
                steps:      { type: 'zoom', stops: [[13.5, 0], [14, 1.25], [20, 5.75]] },
                rail:       { type: 'zoom', stops: [[14, 0.4], [15, 0.75], [20, 2]] },
                transit:    { type: 'zoom', stops: [[14, 0.4], [20, 1]] },
                ferry:      1.1,
                pier:       { type: 'zoom', stops: [[15, 1], [17, 4]] },
                motorway_construction: { type: 'zoom', stops: [[6.5, 0], [7, 0.5], [20, 18]] },
                _default:   1
            }
        },
        // Пунктир: rail, path, steps, ferry
        dash: {
            type: 'match',
            by: 'class',
            values: {
                rail:   [2, 2],
                path:   [1.5, 0.75],
                steps:  [0.5, 0.25],
                ferry:  [2, 2],
                _default: undefined
            }
        },
        // Прозрачность: только construction (fade-in на низких зумах)
        opacity: {
            type: 'match',
            by: 'class',
            values: {
                motorway_construction: { type: 'zoom', stops: [[5, 0], [14, 0.4]] },
                _default: 1
            }
        }
    },

    // ─────────────────────────────────────────────────────────────────
    // AEROWAY
    // Покрывает: aeroway-taxiway-casing, aeroway-runway-casing,
    //            aeroway-area, aeroway-taxiway, aeroway-runway
    // Casing (grey) не поддерживается; для видимости на белом фоне
    // взят серый fill вместо белого.
    // ─────────────────────────────────────────────────────────────────
    aeroway: {
        color: {
            type: 'match',
            by: 'class',
            values: {
                runway:  0xcccccc,
                taxiway: 0xdddddd,
                _default: 0xcccccc
            }
        },
        width: {
            type: 'match',
            by: 'class',
            values: {
                runway:  { type: 'zoom', stops: [[11, 4], [17, 50]] },
                taxiway: { type: 'zoom', stops: [[11, 1], [17, 10]] },
                _default: 1
            }
        }
    },

    // ─────────────────────────────────────────────────────────────────
    // BOUNDARY (линии административных границ)
    // Покрывает: boundary-land-level-4, boundary-land-level-2,
    //            boundary-land-disputed, boundary-water
    // filter: admin_level 3–8 (land-4), admin_level=2 (land-2),
    //         maritime=1 (water)
    // Сведено к match по ['maritime', 'admin_level'].
    // ─────────────────────────────────────────────────────────────────
    boundary: {
        filter: { type: 'geometry', in: [2] },
        color: {
            type: 'match',
            by: ['maritime', 'admin_level'],
            values: {
                1: 0x9abdd6,   // maritime (все admin_level с maritime=1)
                2: 0xa4a2b2,   // hsl(248,7%,66%) — граница страны
                _default: 0x9e9cab // #9e9cab — региональные границы
            }
        },
        width: {
            type: 'match',
            by: ['maritime', 'admin_level'],
            values: {
                1: { type: 'zoom', stops: [[0, 0.6], [4, 1.4], [5, 2], [12, 8]] },
                2: { type: 'zoom', stops: [[0, 0.6], [4, 1.4], [5, 2], [12, 8]] },
                _default: { type: 'zoom', stops: [[4, 0.4], [5, 1], [12, 3]] }
            }
        },
        dash: {
            type: 'match',
            by: ['maritime', 'admin_level'],
            values: {
                1: undefined,
                2: undefined,
                _default: [3, 1, 1, 1]
            }
        },
        opacity: {
            type: 'match',
            by: 'maritime',
            values: {
                1: { type: 'zoom', stops: [[6, 0.6], [10, 1]] },
                _default: 1
            }
        }
    },

    // ─────────────────────────────────────────────────────────────────
    // WATER_NAME (подписи водоёмов)
    // Покрывает: waterway-name (line, для рек),
    //            water-name-lakeline (line), water-name-ocean (point),
    //            water-name-other (point)
    // LineString → textLines; Point → textPoints (класс ocean/прочее).
    // ─────────────────────────────────────────────────────────────────
    water_name: {
        color: 0xa0c8f0,  // псевдо-color для carrier-линии (если рисуется)
        opacity: 0.3,
        width: 0.2,
        textColor: '#74aee9',
        fontSize: '14px',
        textFontStyle: 'italic',
        textPlacement: 'along',
        textShadow: '0 0 2px rgba(255,255,255,0.7)',
        textZoomMin: 10,
        textZoomMax: 21,
        textPriority: 45,
        textMinSegmentLength: 0.1
    },

    // ─────────────────────────────────────────────────────────────────
    // POI
    // Покрывает: poi-level-3, poi-level-2, poi-level-1, poi-railway
    // filter: has name (+ rank-фильтр, но упрощён — используем minzoom)
    // ─────────────────────────────────────────────────────────────────
    poi: {
        filter: {
            type: 'all',
            of: [
                { type: 'geometry', in: [1] },
                { type: 'exists', key: 'name' }
            ]
        },
        color: 0xcccccc,
        radius: 3,
        textColor: '#666666',
        fontSize: '12px',
        fontWeight: 'normal',
        textOffset: [0, -8],
        textAlign: 'center',
        textVerticalAlign: 'center',
        textZoomMin: 13,
        textZoomMax: 24,
        textPriority: 60
    },

    // ─────────────────────────────────────────────────────────────────
    // TRANSPORTATION_NAME (подписи дорог)
    // Покрывает: highway-name-path, highway-name-minor,
    //            highway-name-major, highway-shield (пропущен — иконки)
    // filter: $type=LineString + has name
    // ─────────────────────────────────────────────────────────────────
    transportation_name: {
        filter: {
            type: 'all',
            of: [
                { type: 'geometry', in: [2] },
                { type: 'exists', key: 'name' }
            ]
        },
        color: 0xffffff,
        opacity: 0.3,
        width: 0.2,
        textColor: '#776655',  // #765
        fontSize: { type: 'zoom', stops: [[13, 12], [14, 13]] },
        fontWeight: 'normal',
        textPlacement: 'along',
        textShadow: '0 0 2px rgba(255,255,255,0.9)',
        textZoomMin: 12,
        textZoomMax: 21,
        textPriority: {
            type: 'match',
            by: 'class',
            values: {
                motorway:  100,
                trunk:      95,
                primary:    90,
                secondary:  85,
                tertiary:   80,
                minor:      75,
                service:    70,
                rail:       65,
                path:       60,
                _default:   65
            }
        },
        textMinSegmentLength: 0.05
    },

    // ─────────────────────────────────────────────────────────────────
    // AERODROME_LABEL
    // Покрывает: airport-label-major
    // filter: has iata, $type=Point
    // ─────────────────────────────────────────────────────────────────
    aerodrome_label: {
        filter: {
            type: 'all',
            of: [
                { type: 'geometry', in: [1] },
                { type: 'exists', key: 'iata' }
            ]
        },
        color: 0xcccccc,
        radius: 3,
        textColor: '#666666',
        fontSize: '12px',
        fontWeight: 'normal',
        textOffset: [0, -8],
        textAlign: 'center',
        textVerticalAlign: 'center',
        textZoomMin: 10,
        textZoomMax: 24,
        textPriority: 110
    },

    // ─────────────────────────────────────────────────────────────────
    // PLACE (населённые пункты, регионы, страны)
    // Покрывает: place-other, place-village, place-town, place-state,
    //            place-city, place-city-capital, place-country-other,
    //            place-country-3, place-country-2, place-country-1,
    //            place-continent
    // filter: $type=Point (упрощённо)
    // ─────────────────────────────────────────────────────────────────
    place: {
        filter: { type: 'geometry', in: [1] },
        color: 0xe8e8e8,
        opacity: 0.7,
        radius: {
            type: 'match',
            by: 'class',
            values: {
                city:      5,
                town:      4,
                village:   3,
                hamlet:    2,
                _default:  3
            }
        },
        textColor: {
            type: 'match',
            by: 'class',
            values: {
                city:       '#333333',
                town:       '#333333',
                village:    '#333333',
                hamlet:     '#333333',
                state:      '#663333',
                country:    '#333344',
                continent:  '#333344',
                _default:   '#663333'
            }
        },
        fontSize: {
            type: 'match',
            by: 'class',
            values: {
                city:      { type: 'zoom', stops: [[7, 14], [11, 24]] },
                town:      { type: 'zoom', stops: [[10, 14], [15, 24]] },
                village:   { type: 'zoom', stops: [[10, 12], [15, 22]] },
                hamlet:    { type: 'zoom', stops: [[10, 11], [15, 18]] },
                state:     { type: 'zoom', stops: [[12, 10], [15, 14]] },
                country:   { type: 'zoom', stops: [[3, 11], [7, 17]] },
                continent: 14,
                _default:  { type: 'zoom', stops: [[10, 10], [15, 14]] }
            }
        },
        fontWeight: {
            type: 'match',
            by: 'class',
            values: {
                city:       'bold',
                town:       'bold',
                state:      'bold',
                country:    'bold',
                continent:  'bold',
                _default:   'normal'
            }
        },
        textTransform: {
            type: 'match',
            by: 'class',
            values: {
                state:      'uppercase',
                country:    'uppercase',
                continent:  'uppercase',
                _default:   'none'
            }
        },
        textLetterSpacing: {
            type: 'match',
            by: 'class',
            values: {
                state:      '0.1em',
                country:    '0em',
                continent:  '0em',
                _default:   '0.08em'
            }
        },
        textOffset: {
            type: 'match',
            by: 'class',
            values: {
                city:     [0, -10],
                town:     [0, -8],
                village:  [0, -6],
                _default: [0, -6]
            }
        },
        textAlign: 'center',
        textVerticalAlign: 'center',
        textZoomMin: 0,
        textZoomMax: 24,
        textPriority: {
            type: 'match',
            by: 'class',
            values: {
                city:       200,
                town:       170,
                village:    150,
                hamlet:     130,
                state:      120,
                country:    110,
                continent:  100,
                _default:   130
            }
        }
    }
};

// ────────────────────────────────────────────────────────────────────────
// Порядок отрисовки слоёв
// ────────────────────────────────────────────────────────────────────────
/**
 * Порядок отрисовки по style.json. Чем больше число, тем выше слой.
 *
 * Значения — 10 * (индекс первого вхождения source-layer в массив layers[]).
 * Фоновый слой (id: "background") игнорируется.
 *
 * ВАЖНО про мультислойные source-layers:
 *   - `transportation` встречается в style.json трижды: туннели (idx 27),
 *     ferry (idx 46), обычные дороги/ЖД (idx 54–78), мосты (idx 79–95).
 *     Воркер использует базовое значение как якорь и добавляет ±2 для
 *     brunnel=tunnel/bridge (см. VectorTileLayer/worker dynamicOrder).
 *     Из-за этого мосты (idx 79+) рисуются лишь чуть выше туннелей, но
 *     НЕ выше `aeroway` (idx 47). В 3D-сцене это компенсируется depth-тестом
 *     (мосты и так видны как объёмные по Y=0, здания и вода перекрывают).
 *   - `waterway` встречается дважды: линии (idx 12) и подписи-носители
 *     (idx 102). Подписи попадают в textLines и сортируются отдельно.
 *   - `landcover` встречается 5 раз (idx 1–25); берётся первое вхождение.
 *
 * Полный список source-layers style.json (в порядке первого появления):
 *   landcover → landuse → park → waterway → water → building →
 *   transportation → aeroway → boundary → water_name → poi →
 *   transportation_name → aerodrome_label → place.
 *
 * Source-layers из старой версии, которых НЕТ в style.json:
 *   leisure, mountain_peak, housenumber — удалены.
 */
export const LAYER_RENDER_ORDER = {
    landcover:            10,
    landuse:              20,
    park:                110,
    waterway:            120,
    water:               190,
    building:            250,
    transportation:      270,
    aeroway:             470,
    boundary:            980,
    water_name:         1030,
    poi:                1080,
    transportation_name:1120,
    aerodrome_label:    1180,
    place:              1190
};