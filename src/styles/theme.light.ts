// theme.light.ts
import type { Theme } from './types.js';

export const LIGHT_THEME: Theme = {
  name: 'Light',
  backgroundColor: '#ffffff',

poiCategories: {
  food:      '#e74c3c',
  health:    '#dc3545',
  education: '#3f51b5',
  culture:   '#7b1fa2',
  sport:     '#43a047',
  shopping:  '#ff5722',
  finance:   '#388e3c',
  service:   '#546e7a',
  transport: '#1565c0',
  lodging:   '#1976d2',
  nature:    '#6d9e3f',
  religion:  '#7e57c2',
  other:     '#888888',
},

  poiDefaultIcon: 'marker',

  layers: {
    // ─────────────────────────────────────────────────────────────
    // LANDUSE — базовая подложка города (z=5, ПОД greenery).
    //
    // Медицина/образование → landuse_amenity (z=10).
    // Спорт/рекреация/парки → landuse_recreation (z=20).
    // Остальное — жильё, коммерция, промзона, стройка, кладбища,
    // военные, тюрьмы — здесь.
    // ─────────────────────────────────────────────────────────────
    landuse: {
      filter: { type: 'geometry', in: [3] },
      color: {
        type: 'match',
        by: 'class',
        values: {
          // жильё/застройка
          residential:   0xeee6dd,
          suburb:        0xeee6dd,
          neighbourhood: 0xeee6dd,
          railway:       0xeee6dd,
          // коммерция
          commercial:    0xf2cccc,
          retail:        0xf5cccc,
          // промышленность/инфраструктура
          industrial:    0xffeec2,
          garages:       0xffeec2,
          dam:           0xffeec2,
          quarry:        0xe8dcc8,
          landfill:      0xe0d8c8,
          power:         0xe8e8e8,
          port:          0xe0e8f0,
          // стройка
          brownfield:    0xe0dcc8,
          construction:  0xe0dcc8,
          greenfield:    0xe0f0e0,
          // спец-территории
          cemetery:      0xe0e4dd,
          military:      0xe8d0cc,
          prison:        0xe0e0e0,
          // медицина/образование → landuse_amenity
          hospital:      undefined,
          school:        undefined,
          university:    undefined,
          college:       undefined,
          kindergarten:  undefined,
          // спорт/рекреация/парки → landuse_recreation
          pitch:             undefined,
          playground:        undefined,
          stadium:           undefined,
          track:             undefined,
          garden:            undefined,
          golf_course:       undefined,
          village_green:     undefined,
          recreation_ground: undefined,
          zoo:               undefined,
          theme_park:        undefined,
          park:              undefined,
          orchard:           undefined,
          vineyard:          undefined,
          allotments:        undefined,
          meadow:            undefined,
          _default:      undefined,
        },
      },
      opacity: {
        type: 'match',
        by: 'class',
        values: {
          residential:   { type: 'zoom', stops: [[12, 0.4], [16, 0.2]] },
          suburb:        { type: 'zoom', stops: [[12, 0.4], [16, 0.2]] },
          neighbourhood: { type: 'zoom', stops: [[12, 0.4], [16, 0.2]] },
          railway:       0.4,
          commercial:    0.23,
          retail:        0.23,
          industrial:    0.34,
          garages:       0.34,
          dam:           0.34,
          quarry:        0.4,
          landfill:      0.4,
          power:         0.3,
          port:          0.3,
          brownfield:    0.4,
          construction:  0.4,
          greenfield:    0.4,
          cemetery:      1,
          military:      0.3,
          prison:        0.3,
          _default:      1,
        },
      },
    },

    // ─────────────────────────────────────────────────────────────
    // LANDUSE_AMENITY (z=10, между landuse и landcover)
    //
    // Больницы/вузы/школы/детсады — ПОД greenery, чтобы газоны и лес
    // отрисовывались поверх заливки. Классы селектируются через
    // color.match (`_default: undefined` = не рисовать остальную
    // часть landuse-тайла).
    // ─────────────────────────────────────────────────────────────
    landuse_amenity: {
      sourceLayer: 'landuse',
      filter: { type: 'geometry', in: [3] },
      color: {
        type: 'match',
        by: 'class',
        values: {
          hospital:      0xffddee,
          school:        0xf0e8f8,
          university:    0xf0e8f8,
          college:       0xf0e8f8,
          kindergarten:  0xf0e8f8,
          _default:      undefined,
        },
      },
      opacity: 1,
    },

    // ─────────────────────────────────────────────────────────────
    // LANDCOVER — greenery (z=15, МЕЖДУ amenity и recreation).
    // ─────────────────────────────────────────────────────────────
    landcover: {
      filter: { type: 'geometry', in: [3] },
      color: {
        type: 'match',
        by: 'class',
        values: {
          glacier:   0xffffff,
          ice_shelf: 0xffffff,
          ice:       0xf0f8ff,
          wood:      0x66aa44,
          grass:     0xd8e8c8,
          sand:      0xf5eebc,
          farmland:  0xf0ecdc,
          rock:      0xe0ddd8,
          wetland:   0xd0e8e0,
          _default:  undefined,
        },
      },
      opacity: {
        type: 'match',
        by: 'class',
        values: {
          glacier:   { type: 'zoom', stops: [[0, 0.9], [10, 0.3]] },
          ice_shelf: { type: 'zoom', stops: [[0, 0.9], [10, 0.3]] },
          ice:       0.8,
          wood:      0.1,
          grass:     1,
          sand:      1,
          farmland:  0.7,
          rock:      0.5,
          wetland:   0.7,
          _default:  0.3,
        },
      },
    },

    // ─────────────────────────────────────────────────────────────
    // LANDUSE_RECREATION (z=20, НАД greenery).
    //
    // Спорт/рекреация/парки — должны быть ВИДНЫ поверх газонов,
    // иначе pitch/playground/garden сливаются с grass и «пропадают».
    // pitch рендерится при opacity 1.0 — иначе blendWithBackground
    // размывает цвет до почти-белого и он теряется на фоне газона.
    // ─────────────────────────────────────────────────────────────
    landuse_recreation: {
      sourceLayer: 'landuse',
      filter: { type: 'geometry', in: [3] },
      color: {
        type: 'match',
        by: 'class',
        values: {
          pitch:             0xa8d8a0,   // насыщенный газон поля
          playground:        0xf0e8c8,
          stadium:           0xc0dcc0,
          track:             0xd8e0c0,
          garden:            0xcde8c0,
          golf_course:       0xb0d8a0,
          village_green:     0xc8e0b8,
          recreation_ground: 0xd0e8d0,
          zoo:               0xd8e8c0,
          theme_park:        0xf0d8e0,
          park:              0xd8e8c8,
          orchard:           0xe0f0c8,
          vineyard:          0xe0e8d0,
          allotments:        0xe8f0d8,
          meadow:            0xeef4e0,
          _default:          undefined,
        },
      },
      opacity: {
        type: 'match',
        by: 'class',
        values: {
          pitch:             1.0,   // ← прямое наложение, без блендинга
          playground:        0.7,
          stadium:           0.6,
          track:             0.6,
          garden:            0.6,
          golf_course:       0.6,
          village_green:     0.7,
          recreation_ground: 0.6,
          zoo:               0.6,
          theme_park:        0.6,
          park:              0.5,
          orchard:           0.5,
          vineyard:          0.5,
          allotments:        0.5,
          meadow:            0.4,
          _default:          1,
        },
      },
    },

    // ─────────────────────────────────────────────────────────────
    // PARK — охраняемые природные территории (OMT-слой `park`)
    // ─────────────────────────────────────────────────────────────
    park: {
      filter: { type: 'geometry', in: [3] },
      color: {
        type: 'match',
        by: 'class',
        values: {
          national_park:  0xc8e0b8,
          nature_reserve: 0xc8e0b8,
          protected_area: 0xc8e0b8,
          _default:       undefined,
        },
      },
      opacity: 0.5,
    },

    // ─────────────────────────────────────────────────────────────
    // WATERWAY
    // ─────────────────────────────────────────────────────────────
    waterway: {
      filter: { type: 'geometry', in: [2] },
      color: 0xa0c8f0,
      width: {
        type: 'match',
        by: ['brunnel', 'class'],
        values: {
          tunnel:  { type: 'zoom', stops: [[13, 0.5], [20, 6]] },
          river:   { type: 'zoom', stops: [[10, 0.8], [20, 6]] },
          stream:  { type: 'zoom', stops: [[13, 0.5], [20, 6]] },
          canal:   { type: 'zoom', stops: [[13, 0.5], [20, 6]] },
          drain:   { type: 'zoom', stops: [[13, 0.5], [20, 1.5]] },
          ditch:   { type: 'zoom', stops: [[13, 0.5], [20, 1.5]] },
          _default:{ type: 'zoom', stops: [[13, 0.5], [20, 2]] },
        },
      },
      dash: {
        type: 'match',
        by: ['brunnel', 'intermittent'],
        values: {
          tunnel: [2, 4],
          1:      [4, 3],
          _default: undefined,
        },
      },
      textColor: '#74aee9',
      fontSize: '14px',
      textFontStyle: 'italic',
      textPlacement: 'along',
      textFilter: 'drop-shadow(0 0 2px #ffffff)',
      textZoomMin: 10,
      textZoomMax: 21,
      textPriority: 50,
      textMinSegmentLength: 0.1,
      textVerticalAlign: 'top',
      textOffset: [0, -2],
    },

    // ─────────────────────────────────────────────────────────────
    // WATER
    // ─────────────────────────────────────────────────────────────
    water: {
      filter: { type: 'geometry', in: [3] },
      color: 0xb3d2f0,
      opacity: {
        type: 'match',
        by: 'intermittent',
        values: { 1: 0.7, _default: 1 },
      },
    },

    // ─────────────────────────────────────────────────────────────
    // BUILDING
    // ─────────────────────────────────────────────────────────────
    building: {
      filter: { type: 'geometry', in: [3] },
      color: { type: 'zoom', stops: [[15.5, 0xf2eae2], [16, 0xf2eae2]] },
      stroke: 0xaaaaaa,
      height: {
        type: 'field',
        keys: ['render_height', 'height'],
        fallback: { type: 'levels', multiplier: 2 },
      },
      base: {
        type: 'field',
        keys: ['render_min_height', 'min_height'],
        fallback: 0,
      },
    },

    // ─────────────────────────────────────────────────────────────
    // HOUSENUMBER
    // ─────────────────────────────────────────────────────────────
    housenumber: {
      filter: {
        type: 'all',
        of: [
          { type: 'geometry', in: [1] },
          { type: 'exists', key: 'housenumber' },
        ],
      },
      textColor: '#666666',
      fontSize: { type: 'zoom', stops: [[17, 10], [20, 11]] },
      fontWeight: 'normal',
      textZoomMin: 17,
      textZoomMax: 24,
      textPriority: 10,
      textStroke: '1.5px #ffffff',
      textAlign: 'center',
      textVerticalAlign: 'center',
    },

    // ─────────────────────────────────────────────────────────────
    // TRANSPORTATION
    // ─────────────────────────────────────────────────────────────
    transportation: {
      color: {
        type: 'geometryType',
        values: {
          3: {
            type: 'match',
            by: 'class',
            values: { pier: 0xf8f4f0, _default: 0xe3e3e3 },
          },
          2: {
            type: 'match',
            by: ['brunnel', 'class'],
            values: {
              tunnel:    0xfff4c6,
              bridge:    0xffeaaa,
              motorway:  0xffcc88,
              trunk:     0xffeaaa,
              primary:   0xffeaaa,
              secondary: 0xffeaaa,
              tertiary:  0xffeaaa,
              minor:     0xffffff,
              service:   0xffffff,
              track:     0xffffff,
              pedestrian:0xf0f0f0,
              living_street: 0xffffff,
              path:      0xccbbaa,
              steps:     0xffffff,
              platform:  0xdddddd,
              raceway:   0xcccccc,
              rail:      0xbbbbbb,
              transit:   0xbbbbbb,
              ferry:     0x6c9fb6,
              pier:      0xf8f4f0,
              cable_car: 0x888888,
              gondola:   0x888888,
              funicular: 0x888888,
              motorway_construction:  0xffffff,
              trunk_construction:     0xffffff,
              primary_construction:   0xffffff,
              secondary_construction: 0xffffff,
              tertiary_construction:  0xffffff,
              minor_construction:     0xffffff,
              service_construction:   0xffffff,
              track_construction:     0xffffff,
              path_construction:      0xffffff,
              steps_construction:     0xffffff,
              rail_construction:      0xbbbbbb,
              _default:  0xcccccc,
            },
          },
        },
        _default: 0xcccccc,
      },
      width: {
        type: 'match',
        by: 'class',
        values: {
          motorway:   { type: 'zoom', stops: [[6.5, 0], [7, 0.25], [20, 9]] },
          trunk:      { type: 'zoom', stops: [[6.5, 0], [7, 0.25], [20, 9]] },
          primary:    { type: 'zoom', stops: [[8.5, 0], [9, 0.25], [20, 9]] },
          secondary:  { type: 'zoom', stops: [[6.5, 0], [8, 0.25], [20, 6.5]] },
          tertiary:   { type: 'zoom', stops: [[6.5, 0], [8, 0.25], [20, 6.5]] },
          minor:      { type: 'zoom', stops: [[13.5, 0], [14, 1.25], [20, 5.75]] },
          service:    { type: 'zoom', stops: [[13.5, 0], [14, 1.25], [20, 5.75]] },
          track:      { type: 'zoom', stops: [[13.5, 0], [14, 1.25], [20, 5.75]] },
          pedestrian: { type: 'zoom', stops: [[14, 0], [14.5, 1], [20, 4]] },
          living_street: { type: 'zoom', stops: [[14, 0], [14.5, 1.25], [20, 4]] },
          path:       { type: 'zoom', stops: [[15, 0.6], [20, 2]] },
          steps:      { type: 'zoom', stops: [[13.5, 0], [14, 0.625], [20, 2.875]] },
          platform:   { type: 'zoom', stops: [[15, 0.5], [17, 2]] },
          raceway:    { type: 'zoom', stops: [[13, 0.5], [20, 2]] },
          rail:       { type: 'zoom', stops: [[14, 0.2], [15, 0.375], [20, 1]] },
          transit:    { type: 'zoom', stops: [[14, 0.2], [20, 0.5]] },
          cable_car:  { type: 'zoom', stops: [[13, 0.5], [20, 1.5]] },
          gondola:    { type: 'zoom', stops: [[13, 0.5], [20, 1.5]] },
          funicular:  { type: 'zoom', stops: [[13, 0.5], [20, 1.5]] },
          ferry:      0.55,
          pier:       { type: 'zoom', stops: [[15, 0.5], [17, 2]] },
          motorway_construction:  { type: 'zoom', stops: [[6.5, 0], [7, 0.25], [20, 9]] },
          trunk_construction:     { type: 'zoom', stops: [[6.5, 0], [7, 0.25], [20, 9]] },
          primary_construction:   { type: 'zoom', stops: [[8.5, 0], [9, 0.25], [20, 9]] },
          secondary_construction: { type: 'zoom', stops: [[6.5, 0], [8, 0.25], [20, 6.5]] },
          tertiary_construction:  { type: 'zoom', stops: [[6.5, 0], [8, 0.25], [20, 6.5]] },
          minor_construction:     { type: 'zoom', stops: [[13.5, 0], [14, 1.25], [20, 5.75]] },
          service_construction:   { type: 'zoom', stops: [[13.5, 0], [14, 1.25], [20, 5.75]] },
          track_construction:     { type: 'zoom', stops: [[13.5, 0], [14, 1.25], [20, 5.75]] },
          path_construction:      { type: 'zoom', stops: [[15, 0.6], [20, 2]] },
          steps_construction:     { type: 'zoom', stops: [[13.5, 0], [14, 0.625], [20, 2.875]] },
          rail_construction:      { type: 'zoom', stops: [[14, 0.2], [15, 0.375], [20, 1]] },
          _default:   0.5,
        },
      },
      dash: {
        type: 'match',
        by: 'class',
        values: {
          rail:      [2, 2],
          rail_construction: [2, 2],
          path:      [1.5, 0.75],
          path_construction: [1.5, 0.75],
          steps:     [0.5, 0.25],
          steps_construction: [0.5, 0.25],
          ferry:     [2, 2],
          cable_car: [3, 2],
          gondola:   [3, 2],
          funicular: [2, 2],
          _default: undefined,
        },
      },
      opacity: {
        type: 'geometryType',
        values: {
          3: 0.5,
          2: {
            type: 'match',
            by: 'class',
            values: {
              motorway_construction:  { type: 'zoom', stops: [[5, 0], [14, 0.4]] },
              trunk_construction:     { type: 'zoom', stops: [[5, 0], [14, 0.4]] },
              primary_construction:   { type: 'zoom', stops: [[5, 0], [14, 0.4]] },
              secondary_construction: { type: 'zoom', stops: [[5, 0], [14, 0.4]] },
              tertiary_construction:  { type: 'zoom', stops: [[5, 0], [14, 0.4]] },
              minor_construction:     { type: 'zoom', stops: [[5, 0], [14, 0.4]] },
              service_construction:   { type: 'zoom', stops: [[5, 0], [14, 0.4]] },
              track_construction:     { type: 'zoom', stops: [[5, 0], [14, 0.4]] },
              path_construction:      { type: 'zoom', stops: [[5, 0], [14, 0.4]] },
              steps_construction:     { type: 'zoom', stops: [[5, 0], [14, 0.4]] },
              rail_construction:      { type: 'zoom', stops: [[5, 0], [14, 0.4]] },
              _default: 1,
            },
          },
        },
        _default: 1,
      },
    },

    // ─────────────────────────────────────────────────────────────
    // AEROWAY
    // ─────────────────────────────────────────────────────────────
    aeroway: {
      color: {
        type: 'match',
        by: 'class',
        values: {
          runway:   0xcccccc,
          taxiway:  0xdddddd,
          apron:    0xd8d8d8,
          helipad:  0xdddddd,
          heliport: 0xd8d8d8,
          gate:     0xcccccc,
          _default: 0xcccccc,
        },
      },
      width: {
        type: 'match',
        by: 'class',
        values: {
          runway:   { type: 'zoom', stops: [[11, 4], [17, 50]] },
          taxiway:  { type: 'zoom', stops: [[11, 1], [17, 10]] },
          apron:    { type: 'zoom', stops: [[10, 1], [17, 20]] },
          helipad:  { type: 'zoom', stops: [[13, 0.5], [20, 2]] },
          heliport: { type: 'zoom', stops: [[11, 1], [17, 10]] },
          gate:     { type: 'zoom', stops: [[15, 0.2], [20, 1]] },
          _default: 1,
        },
      },
    },

    // ─────────────────────────────────────────────────────────────
    // BOUNDARY
    // ─────────────────────────────────────────────────────────────
    boundary: {
      maxZoom: 14,
      filter: { type: 'geometry', in: [2] },
      color: {
        type: 'match',
        by: ['maritime', 'admin_level'],
        values: { 1: 0x9abdd6, 2: 0xa4a2b2, _default: 0x9e9cab },
      },
      width: {
        type: 'match',
        by: ['maritime', 'admin_level'],
        values: {
          1: { type: 'zoom', stops: [[0, 0.6], [4, 1.4], [5, 2], [12, 8]] },
          2: { type: 'zoom', stops: [[0, 0.6], [4, 1.4], [5, 2], [12, 2]] },
          _default: { type: 'zoom', stops: [[4, 0.4], [5, 1], [12, 3]] },
        },
      },
      dash: {
        type: 'match',
        by: ['maritime', 'admin_level'],
        values: { 1: undefined, 2: undefined, _default: [3, 1] },
      },
      opacity: {
        type: 'match',
        by: 'maritime',
        values: {
          1: { type: 'zoom', stops: [[6, 0.6], [10, 1]] },
          _default: 1,
        },
      },
    },

    // ─────────────────────────────────────────────────────────────
    // WATER_NAME
    // ─────────────────────────────────────────────────────────────
    water_name: {
      color: 0xa0c8f0,
      opacity: 0.3,
      width: 0.2,
      textColor: '#74aee9',
      fontSize: '14px',
      textFontStyle: 'italic',
      textPlacement: 'along',
      textZoomMin: 10,
      textZoomMax: 21,
      textPriority: 45,
      textMinSegmentLength: 0.1,
      textVerticalAlign: 'top',
      textOffset: [0, -2],
      textFilter: 'drop-shadow(0 0 2px #ffffff)',
    },

    // ─────────────────────────────────────────────────────────────
    // POI
    // ─────────────────────────────────────────────────────────────
    poi: {
      filter: {
        type: 'all',
        of: [
          { type: 'geometry', in: [1] },
          { type: 'exists', key: 'name' },
        ],
      },
      color: 0xcccccc,
      radius: 1,
      iconScale: 1,
      iconOffset: [0, 0],
      iconCircleScale: 1,
      iconGlyphRatio: 1,
      textColor: '#666666',
      fontSize: '12px',
      fontWeight: 'normal',
      textOffset: [0, -8],
      textAlign: 'center',
      textVerticalAlign: 'center',
      textZoomMin: 13,
      textZoomMax: 24,
      textPriority: 60,
      textStroke: '2px #ffffff',
    },

    // ─────────────────────────────────────────────────────────────
    // MOUNTAIN_PEAK
    // ─────────────────────────────────────────────────────────────
    mountain_peak: {
      filter: {
        type: 'all',
        of: [
          { type: 'geometry', in: [1] },
          { type: 'exists', key: 'name' },
        ],
      },
      color: '#a08060',
      radius: 4,
      iconScale: 1,
      textColor: '#6b5a45',
      fontSize: { type: 'zoom', stops: [[10, 10], [15, 12]] },
      fontWeight: 'normal',
      textOffset: [0, -10],
      textAlign: 'center',
      textVerticalAlign: 'center',
      textZoomMin: 10,
      textZoomMax: 24,
      textPriority: 80,
      textStroke: '2px #ffffff',
    },

    // ─────────────────────────────────────────────────────────────
    // TRANSPORTATION_NAME
    // ─────────────────────────────────────────────────────────────
    transportation_name: {
      filter: {
        type: 'all',
        of: [
          { type: 'geometry', in: [2] },
          { type: 'exists', key: 'name' },
        ],
      },
      color: 0xffffff,
      opacity: 0.3,
      width: 0.2,
      textColor: '#776655',
      fontSize: { type: 'zoom', stops: [[13, 12], [14, 13]] },
      fontWeight: 'normal',
      textPlacement: 'along',
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
          pedestrian: 72,
          living_street: 70,
          service:    70,
          rail:       65,
          path:       60,
          _default:   65,
        },
      },
      textMinSegmentLength: 0.05,
      textVerticalAlign: 'middle',
      textOffset: [0, 0],
      textFilter: 'drop-shadow(0 0 1.5px #ffffff)',
    },

    // ─────────────────────────────────────────────────────────────
    // AERODROME_LABEL
    // ─────────────────────────────────────────────────────────────
    aerodrome_label: {
      filter: {
        type: 'all',
        of: [
          { type: 'geometry', in: [1] },
          { type: 'exists', key: 'iata' },
        ],
      },
      color: 0xcccccc,
      radius: 3,
      iconImage: 'airport',
      iconScale: 1,
      iconOffset: [0, 0],
      textColor: '#666666',
      fontSize: '12px',
      fontWeight: 'normal',
      textOffset: [0, -8],
      textAlign: 'center',
      textVerticalAlign: 'center',
      textZoomMin: 10,
      textZoomMax: 24,
      textPriority: 110,
      textStroke: '2px #ffffff',
    },

    // ─────────────────────────────────────────────────────────────
    // PLACE
    // ─────────────────────────────────────────────────────────────
    place: {
      filter: { type: 'geometry', in: [1] },
      color: 0xe8e8e8,
      opacity: 0.7,
      radius: {
        type: 'match',
        by: 'class',
        values: {
          city: 5, town: 4, village: 3, hamlet: 2,
          suburb: 3, quarter: 3, neighbourhood: 3,
          isolated_dwelling: 2,
          island: 0, archipelago: 0,
          sea: 0, ocean: 0, bay: 0, strait: 0,
          province: 0,
          _default: 3,
        },
      },
      textColor: {
        type: 'match',
        by: 'class',
        values: {
          city:      '#333333',
          town:      '#333333',
          village:   '#333333',
          hamlet:    '#333333',
          suburb:    '#555555',
          quarter:   '#555555',
          neighbourhood: '#555555',
          isolated_dwelling: '#666666',
          island:    '#7a7a7a',
          archipelago: '#7a7a7a',
          sea:       '#4a7ec7',
          ocean:     '#4a7ec7',
          bay:       '#5a94d0',
          strait:    '#5a94d0',
          state:     '#663333',
          province:  '#663333',
          country:   '#333344',
          continent: '#333344',
          _default:  '#663333',
        },
      },
      fontSize: {
        type: 'match',
        by: 'class',
        values: {
          city:      { type: 'zoom', stops: [[7, 14], [11, 24]] },
          town:      { type: 'zoom', stops: [[10, 14], [15, 24]] },
          village:   { type: 'zoom', stops: [[10, 12], [15, 22]] },
          hamlet:    { type: 'zoom', stops: [[10, 11], [15, 18]] },
          suburb:    { type: 'zoom', stops: [[11, 11], [15, 15]] },
          quarter:   { type: 'zoom', stops: [[12, 11], [15, 15]] },
          neighbourhood: { type: 'zoom', stops: [[12, 10], [15, 14]] },
          isolated_dwelling: { type: 'zoom', stops: [[14, 10], [20, 12]] },
          island:    { type: 'zoom', stops: [[10, 11], [15, 14]] },
          archipelago: { type: 'zoom', stops: [[8, 11], [15, 14]] },
          sea:       { type: 'zoom', stops: [[3, 12], [7, 18]] },
          ocean:     { type: 'zoom', stops: [[1, 14], [5, 20]] },
          bay:       { type: 'zoom', stops: [[10, 12], [15, 16]] },
          strait:    { type: 'zoom', stops: [[10, 11], [15, 14]] },
          state:     { type: 'zoom', stops: [[12, 10], [15, 14]] },
          province:  { type: 'zoom', stops: [[8, 10], [12, 14]] },
          country:   { type: 'zoom', stops: [[3, 11], [7, 17]] },
          continent: 14,
          _default:  { type: 'zoom', stops: [[10, 10], [15, 14]] },
        },
      },
      fontWeight: {
        type: 'match',
        by: 'class',
        values: {
          city: 'bold', town: 'bold', state: 'bold',
          province: 'bold',
          country: 'bold', continent: 'bold',
          sea: 'bold', ocean: 'bold',
          _default: 'normal',
        },
      },
      textFontStyle: {
        type: 'match',
        by: 'class',
        values: {
          island: 'italic',
          archipelago: 'italic',
          sea: 'italic',
          ocean: 'italic',
          bay: 'italic',
          strait: 'italic',
          _default: 'normal',
        },
      },
      textTransform: {
        type: 'match',
        by: 'class',
        values: {
          state: 'uppercase', province: 'uppercase',
          country: 'uppercase', continent: 'uppercase',
          sea: 'uppercase', ocean: 'uppercase',
          _default: 'none',
        },
      },
      textLetterSpacing: {
        type: 'match',
        by: 'class',
        values: {
          state: '0.1em', province: '0.1em',
          country: '0em', continent: '0em',
          sea: '0.15em', ocean: '0.2em',
          _default: '0.08em',
        },
      },
      textOffset: {
        type: 'match',
        by: 'class',
        values: {
          city: [0, -10], town: [0, -8], village: [0, -6],
          suburb: [0, -6], quarter: [0, -6], neighbourhood: [0, -6],
          isolated_dwelling: [0, -4],
          island: [0, -4], archipelago: [0, -4],
          sea: [0, 0], ocean: [0, 0], bay: [0, 0], strait: [0, 0],
          province: [0, -8],
          _default: [0, -6],
        },
      },
      textAlign: 'center',
      textVerticalAlign: 'center',
      textZoomMin: 0,
      textZoomMax: 24,
      textPriority: {
        type: 'match',
        by: 'class',
        values: {
          city: 200, town: 170, village: 150, hamlet: 130,
          suburb: 140, quarter: 140, neighbourhood: 130,
          isolated_dwelling: 110,
          island: 100, archipelago: 100,
          sea: 90, ocean: 80, bay: 95, strait: 100,
          state: 120, province: 115,
          country: 110, continent: 100,
          _default: 130,
        },
      },
      textStroke: '2px #ffffff',
    },
  },

  // ─────────────────────────────────────────────────────────────────
  // Порядок отрисовки (bottom → top):
  //   landuse (5)          — базовая подложка города
  //   landuse_amenity (10) — больницы/вузы/школы — ПОД зеленью
  //   landcover (15)       — greenery
  //   landuse_recreation(20) — pitch/playground/парки — НАД зеленью
  // ─────────────────────────────────────────────────────────────────
  layerOrder: {
    landuse:              5,
    landuse_amenity:     10,
    landcover:           15,
    landuse_recreation:  20,
    park:               110,
    waterway:           120,
    water:              190,
    building:           250,
    housenumber:        260,
    transportation:     270,
    aeroway:            470,
    boundary:           980,
    water_name:        1030,
    poi:               1080,
    transportation_name:1120,
    mountain_peak:     1170,
    aerodrome_label:   1180,
    place:             1190,
  },
};