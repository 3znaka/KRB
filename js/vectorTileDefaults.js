// @ts-nocheck
// vectorTileDefaults.js
export const DEFAULT_STYLES = {
    // ─────────────────────────────────────────────────────────────────
    // LANDCOVER
    // ─────────────────────────────────────────────────────────────────
    landcover: {
        filter: { type: 'geometry', in: [3] },
        color: {
            type: 'match',
            by: ['class', 'subclass'],
            values: {
                glacier: 0xffffff,
                ice_shelf: 0xffffff,
                wood: 0x66aa44,
                grass: 0xd8e8c8,
                sand: 0xf5eebc,
                _default: 0xffffff
            }
        },
        opacity: {
            type: 'match',
            by: ['class', 'subclass'],
            values: {
                glacier: { type: 'zoom', stops: [[0, 0.9], [10, 0.3]] },
                ice_shelf: { type: 'zoom', stops: [[0, 0.9], [10, 0.3]] },
                wood: 0.1,
                grass: 1,
                sand: 1,
                _default: 0.3
            }
        }
    },
    // ─────────────────────────────────────────────────────────────────
    // LANDUSE
    // ─────────────────────────────────────────────────────────────────
    landuse: {
        filter: { type: 'geometry', in: [3] },
        color: {
            type: 'match',
            by: 'class',
            values: {
                residential: 0xeee6dd,
                suburb: 0xeee6dd,
                neighbourhood: 0xeee6dd,
                commercial: 0xf2cccc,
                industrial: 0xffeec2,
                garages: 0xffeec2,
                dam: 0xffeec2,
                cemetery: 0xe0e4dd,
                hospital: 0xffddee,
                school: 0xf0e8f8,
                railway: 0xeee6dd,
                _default: undefined
            }
        },
        opacity: {
            type: 'match',
            by: 'class',
            values: {
                residential: { type: 'zoom', stops: [[12, 0.4], [16, 0.2]] },
                suburb: { type: 'zoom', stops: [[12, 0.4], [16, 0.2]] },
                neighbourhood: { type: 'zoom', stops: [[12, 0.4], [16, 0.2]] },
                commercial: 0.23,
                industrial: 0.34,
                garages: 0.34,
                dam: 0.34,
                cemetery: 1,
                hospital: 1,
                school: 1,
                railway: 0.4,
                _default: 1
            }
        }
    },
    // ─────────────────────────────────────────────────────────────────
    // PARK
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
    // WATERWAY
    //
    // Подписи — НАД линией (textVerticalAlign='top'). Реки/каналы
    // читаются лучше, когда текст не пересекает саму водную линию.
    // ─────────────────────────────────────────────────────────────────
    waterway: {
        filter: { type: 'geometry', in: [2] },
        color: 0xa0c8f0,
        width: {
            type: 'match',
            by: ['brunnel', 'class'],
            values: {
                tunnel: { type: 'zoom', stops: [[13, 0.5], [20, 6]] },
                river: { type: 'zoom', stops: [[10, 0.8], [20, 6]] },
                stream: { type: 'zoom', stops: [[13, 0.5], [20, 6]] },
                canal: { type: 'zoom', stops: [[13, 0.5], [20, 6]] },
                _default: { type: 'zoom', stops: [[13, 0.5], [20, 2]] }
            }
        },
        dash: {
            type: 'match',
            by: ['brunnel', 'intermittent'],
            values: {
                tunnel: [2, 4],
                1: [4, 3],
                _default: undefined
            }
        },
        textColor: '#74aee9',
        fontSize: '14px',
        textFontStyle: 'italic',
        textPlacement: 'along',
        textShadow: '0 0 2px rgba(255,255,255,0.7)',
        textZoomMin: 10,
        textZoomMax: 21,
        textPriority: 50,
        textMinSegmentLength: 0.1,
        // ── подпись над линией ──────────────────────────────────────
        textVerticalAlign: 'top',
        textOffset: [0, -2],
    },
    // ─────────────────────────────────────────────────────────────────
    // WATER
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
    // ─────────────────────────────────────────────────────────────────
    building: {
        filter: { type: 'geometry', in: [3] },
        color: { type: 'zoom', stops: [[15.5, 0xf2eae2], [16, 0xf2eae2]] },
        stroke: 0xaaaaaa,
        height: {
            type: 'field',
            keys: ['render_height', 'height'],
            fallback: { type: 'levels', multiplier: 2 }
        },
        base: {
            type: 'field',
            keys: ['render_min_height', 'min_height'],
            fallback: 0
        }
    },
    // ─────────────────────────────────────────────────────────────────
    // TRANSPORTATION
    //
    // Все стопы width уменьшены в 2 раза относительно style.json.
    // ─────────────────────────────────────────────────────────────────
    transportation: {
        color: {
            type: 'geometryType',
            values: {
                3: {
                    type: 'match',
                    by: 'class',
                    values: {
                        pier: 0xf8f4f0,
                        _default: 0xe3e3e3
                    }
                },
                2: {
                    type: 'match',
                    by: ['brunnel', 'class'],
                    values: {
                        tunnel: 0xfff4c6,
                        bridge: 0xffeaaa,
                        motorway: 0xffcc88,
                        trunk: 0xffeaaa,
                        primary: 0xffeaaa,
                        secondary: 0xffeaaa,
                        tertiary: 0xffeaaa,
                        minor: 0xffffff,
                        service: 0xffffff,
                        track: 0xffffff,
                        path: 0xccbbaa,
                        steps: 0xffffff,
                        rail: 0xbbbbbb,
                        transit: 0xbbbbbb,
                        ferry: 0x6c9fb6,
                        pier: 0xf8f4f0,
                        motorway_construction: 0xffffff,
                        _default: 0xcccccc
                    }
                }
            },
            _default: 0xcccccc
        },
        width: {
            type: 'match',
            by: 'class',
            values: {
                motorway: { type: 'zoom', stops: [[6.5, 0], [7, 0.25], [20, 9]] },
                trunk: { type: 'zoom', stops: [[6.5, 0], [7, 0.25], [20, 9]] },
                primary: { type: 'zoom', stops: [[8.5, 0], [9, 0.25], [20, 9]] },
                secondary: { type: 'zoom', stops: [[6.5, 0], [8, 0.25], [20, 6.5]] },
                tertiary: { type: 'zoom', stops: [[6.5, 0], [8, 0.25], [20, 6.5]] },
                minor: { type: 'zoom', stops: [[13.5, 0], [14, 1.25], [20, 5.75]] },
                service: { type: 'zoom', stops: [[13.5, 0], [14, 1.25], [20, 5.75]] },
                track: { type: 'zoom', stops: [[13.5, 0], [14, 1.25], [20, 5.75]] },
                path: { type: 'zoom', stops: [[15, 0.6], [20, 2]] },
                steps: { type: 'zoom', stops: [[13.5, 0], [14, 0.625], [20, 2.875]] },
                rail: { type: 'zoom', stops: [[14, 0.2], [15, 0.375], [20, 1]] },
                transit: { type: 'zoom', stops: [[14, 0.2], [20, 0.5]] },
                ferry: 0.55,
                pier: { type: 'zoom', stops: [[15, 0.5], [17, 2]] },
                motorway_construction: { type: 'zoom', stops: [[6.5, 0], [7, 0.25], [20, 9]] },
                _default: 0.5
            }
        },
        dash: {
            type: 'match',
            by: 'class',
            values: {
                rail: [2, 2],
                path: [1.5, 0.75],
                steps: [0.5, 0.25],
                ferry: [2, 2],
                _default: undefined
            }
        },
        opacity: {
            type: 'geometryType',
            values: {
                3: 0.5,
                2: {
                    type: 'match',
                    by: 'class',
                    values: {
                        motorway_construction: { type: 'zoom', stops: [[5, 0], [14, 0.4]] },
                        _default: 1
                    }
                }
            },
            _default: 1
        }
    },
    // ─────────────────────────────────────────────────────────────────
    // AEROWAY
    // ─────────────────────────────────────────────────────────────────
    aeroway: {
        color: {
            type: 'match',
            by: 'class',
            values: {
                runway: 0xcccccc,
                taxiway: 0xdddddd,
                _default: 0xcccccc
            }
        },
        width: {
            type: 'match',
            by: 'class',
            values: {
                runway: { type: 'zoom', stops: [[11, 4], [17, 50]] },
                taxiway: { type: 'zoom', stops: [[11, 1], [17, 10]] },
                _default: 1
            }
        }
    },
    // ─────────────────────────────────────────────────────────────────
    // BOUNDARY
    // ─────────────────────────────────────────────────────────────────
    boundary: {
        maxZoom: 14,
        filter: { type: 'geometry', in: [2] },
        color: {
            type: 'match',
            by: ['maritime', 'admin_level'],
            values: {
                1: 0x9abdd6,
                2: 0xa4a2b2,
                _default: 0x9e9cab
            }
        },
        width: {
            type: 'match',
            by: ['maritime', 'admin_level'],
            values: {
                1: { type: 'zoom', stops: [[0, 0.6], [4, 1.4], [5, 2], [12, 8]] },
                2: { type: 'zoom', stops: [[0, 0.6], [4, 1.4], [5, 2], [12, 2]] },
                _default: { type: 'zoom', stops: [[4, 0.4], [5, 1], [12, 3]] }
            }
        },
        dash: {
            type: 'match',
            by: ['maritime', 'admin_level'],
            values: {
                1: undefined,
                2: undefined,
                _default: [3, 1]
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
    // WATER_NAME
    //
    // Подписи — НАД линией, как у waterway (вода читается лучше,
    // когда текст не пересекает саму линию).
    // ─────────────────────────────────────────────────────────────────
    water_name: {
        color: 0xa0c8f0,
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
        textMinSegmentLength: 0.1,
        // ── подпись над линией ──────────────────────────────────────
        textVerticalAlign: 'top',
        textOffset: [0, -2],
    },
    // ─────────────────────────────────────────────────────────────────
    // POI
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
    // TRANSPORTATION_NAME
    //
    // Подписи — НА линии (textVerticalAlign='middle'): глифы
    // центрируются на дороге, читаются как «надпись на асфальте».
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
        textColor: '#776655',
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
                motorway: 100,
                trunk: 95,
                primary: 90,
                secondary: 85,
                tertiary: 80,
                minor: 75,
                service: 70,
                rail: 65,
                path: 60,
                _default: 65
            }
        },
        textMinSegmentLength: 0.05,
        // ── подпись поверх линии ────────────────────────────────────
        textVerticalAlign: 'middle',
        textOffset: [0, 0],
    },
    // ─────────────────────────────────────────────────────────────────
    // AERODROME_LABEL
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
    // PLACE
    // ─────────────────────────────────────────────────────────────────
    place: {
        filter: { type: 'geometry', in: [1] },
        color: 0xe8e8e8,
        opacity: 0.7,
        radius: {
            type: 'match',
            by: 'class',
            values: {
                city: 5, town: 4, village: 3, hamlet: 2,
                _default: 3
            }
        },
        textColor: {
            type: 'match',
            by: 'class',
            values: {
                city: '#333333',
                town: '#333333',
                village: '#333333',
                hamlet: '#333333',
                state: '#663333',
                country: '#333344',
                continent: '#333344',
                _default: '#663333'
            }
        },
        fontSize: {
            type: 'match',
            by: 'class',
            values: {
                city: { type: 'zoom', stops: [[7, 14], [11, 24]] },
                town: { type: 'zoom', stops: [[10, 14], [15, 24]] },
                village: { type: 'zoom', stops: [[10, 12], [15, 22]] },
                hamlet: { type: 'zoom', stops: [[10, 11], [15, 18]] },
                state: { type: 'zoom', stops: [[12, 10], [15, 14]] },
                country: { type: 'zoom', stops: [[3, 11], [7, 17]] },
                continent: 14,
                _default: { type: 'zoom', stops: [[10, 10], [15, 14]] }
            }
        },
        fontWeight: {
            type: 'match',
            by: 'class',
            values: {
                city: 'bold', town: 'bold', state: 'bold',
                country: 'bold', continent: 'bold',
                _default: 'normal'
            }
        },
        textTransform: {
            type: 'match',
            by: 'class',
            values: {
                state: 'uppercase', country: 'uppercase',
                continent: 'uppercase',
                _default: 'none'
            }
        },
        textLetterSpacing: {
            type: 'match',
            by: 'class',
            values: {
                state: '0.1em', country: '0em', continent: '0em',
                _default: '0.08em'
            }
        },
        textOffset: {
            type: 'match',
            by: 'class',
            values: {
                city: [0, -10], town: [0, -8], village: [0, -6],
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
                city: 200, town: 170, village: 150, hamlet: 130,
                state: 120, country: 110, continent: 100,
                _default: 130
            }
        }
    }
};
// ────────────────────────────────────────────────────────────────────────
// Порядок отрисовки слоёв
// ────────────────────────────────────────────────────────────────────────
export const LAYER_RENDER_ORDER = {
    landcover: 10,
    landuse: 20,
    park: 110,
    waterway: 120,
    water: 190,
    building: 250,
    transportation: 270,
    aeroway: 470,
    boundary: 980,
    water_name: 1030,
    poi: 1080,
    transportation_name: 1120,
    aerodrome_label: 1180,
    place: 1190
};
