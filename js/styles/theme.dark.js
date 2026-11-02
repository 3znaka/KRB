import { LIGHT_THEME } from './theme.light.js';
/**
 * Тёмная тема.
 *
 * Наследует структуру и layerOrder от LIGHT_THEME; здесь только то,
 * что реально отличается — цвета фонов, дорог, построек и подписей.
 * Палитра POI (poiCategories) намеренно НЕ меняется: кружки рассчитаны
 * на любой фон и должны оставаться узнаваемыми между темами.
 */
export const DARK_THEME = {
    ...LIGHT_THEME,
    name: 'Dark',
    backgroundColor: '#1a1a1a',
    layers: {
        ...LIGHT_THEME.layers,
        // ─────────────────────────────────────────────────────────────
        // LANDCOVER
        // ─────────────────────────────────────────────────────────────
        landcover: {
            ...LIGHT_THEME.layers.landcover,
            color: {
                type: 'match',
                by: ['class', 'subclass'],
                values: {
                    glacier: 0x3a4a5a,
                    ice_shelf: 0x3a4a5a,
                    wood: 0x2d4a2d,
                    grass: 0x2a3a2a,
                    sand: 0x4a4530,
                    _default: 0x2a2a2a,
                },
            },
        },
        // ─────────────────────────────────────────────────────────────
        // LANDUSE
        // ─────────────────────────────────────────────────────────────
        landuse: {
            ...LIGHT_THEME.layers.landuse,
            color: {
                type: 'match',
                by: 'class',
                values: {
                    residential: 0x2a2a2a,
                    suburb: 0x2a2a2a,
                    neighbourhood: 0x2a2a2a,
                    commercial: 0x3a2a2a,
                    industrial: 0x3a3020,
                    garages: 0x3a3020,
                    dam: 0x3a3020,
                    cemetery: 0x2a302a,
                    hospital: 0x3a2a3a,
                    school: 0x2a2a3a,
                    railway: 0x2a2a2a,
                    _default: undefined,
                },
            },
        },
        // ─────────────────────────────────────────────────────────────
        // PARK
        // ─────────────────────────────────────────────────────────────
        park: {
            ...LIGHT_THEME.layers.park,
            color: 0x1a3a1a,
        },
        // ─────────────────────────────────────────────────────────────
        // WATERWAY / WATER
        // ─────────────────────────────────────────────────────────────
        waterway: {
            ...LIGHT_THEME.layers.waterway,
            color: 0x3a6a9a,
            textColor: '#5a9ad0',
            textShadow: '0 0 2px rgba(0,0,0,0.6)',
        },
        water: {
            ...LIGHT_THEME.layers.water,
            color: 0x1a3a5a,
        },
        // ─────────────────────────────────────────────────────────────
        // BUILDING
        // ─────────────────────────────────────────────────────────────
        building: {
            ...LIGHT_THEME.layers.building,
            color: { type: 'zoom', stops: [[15.5, 0x2a2a2a], [16, 0x2a2a2a]] },
            stroke: 0x555555,
        },
        // ─────────────────────────────────────────────────────────────
        // TRANSPORTATION
        // Полностью переписываем color — вложенная структура geometryType
        // не стоит того, чтобы спредить её по кускам.
        // ─────────────────────────────────────────────────────────────
        transportation: {
            ...LIGHT_THEME.layers.transportation,
            color: {
                type: 'geometryType',
                values: {
                    3: {
                        type: 'match',
                        by: 'class',
                        values: {
                            pier: 0x333333,
                            _default: 0x2a2a2a,
                        },
                    },
                    2: {
                        type: 'match',
                        by: ['brunnel', 'class'],
                        values: {
                            tunnel: 0x4a4a3a,
                            bridge: 0x554433,
                            motorway: 0x6a4a3a,
                            trunk: 0x554433,
                            primary: 0x554433,
                            secondary: 0x554433,
                            tertiary: 0x554433,
                            minor: 0x3a3a3a,
                            service: 0x3a3a3a,
                            track: 0x3a3a3a,
                            path: 0x4a4a3a,
                            steps: 0x3a3a3a,
                            rail: 0x4a4a4a,
                            transit: 0x4a4a4a,
                            ferry: 0x3a5a6a,
                            pier: 0x333333,
                            motorway_construction: 0x3a3a3a,
                            _default: 0x3a3a3a,
                        },
                    },
                },
                _default: 0x3a3a3a,
            },
        },
        // ─────────────────────────────────────────────────────────────
        // AEROWAY
        // ─────────────────────────────────────────────────────────────
        aeroway: {
            ...LIGHT_THEME.layers.aeroway,
            color: {
                type: 'match',
                by: 'class',
                values: {
                    runway: 0x3a3a3a,
                    taxiway: 0x444444,
                    _default: 0x3a3a3a,
                },
            },
        },
        // ─────────────────────────────────────────────────────────────
        // WATER_NAME
        // ─────────────────────────────────────────────────────────────
        water_name: {
            ...LIGHT_THEME.layers.water_name,
            color: 0x3a6a9a,
            textColor: '#5a9ad0',
            textShadow: '0 0 2px rgba(0,0,0,0.6)',
        },
        // ─────────────────────────────────────────────────────────────
        // POI — только текст, кружки остаются из poiCategories
        // ─────────────────────────────────────────────────────────────
        poi: {
            ...LIGHT_THEME.layers.poi,
            textColor: '#cccccc',
        },
        // ─────────────────────────────────────────────────────────────
        // TRANSPORTATION_NAME
        // ─────────────────────────────────────────────────────────────
        transportation_name: {
            ...LIGHT_THEME.layers.transportation_name,
            textColor: '#aaaacc',
            textShadow: '0 0 2px rgba(0,0,0,0.8)',
        },
        // ─────────────────────────────────────────────────────────────
        // AERODROME_LABEL
        // ─────────────────────────────────────────────────────────────
        aerodrome_label: {
            ...LIGHT_THEME.layers.aerodrome_label,
            textColor: '#cccccc',
        },
        // ─────────────────────────────────────────────────────────────
        // PLACE
        // ─────────────────────────────────────────────────────────────
        place: {
            ...LIGHT_THEME.layers.place,
            textColor: {
                type: 'match',
                by: 'class',
                values: {
                    city: '#dddddd',
                    town: '#dddddd',
                    village: '#dddddd',
                    hamlet: '#dddddd',
                    state: '#ccccbb',
                    country: '#ccccdd',
                    continent: '#ccccdd',
                    _default: '#ccccbb',
                },
            },
        },
    },
    // layerOrder наследуется через spread — не дублируем.
};
