// @ts-nocheck
/**
 * Цветовые палитры для одноканальных растров (DEM, маски, индексы).
 * ...
 */

import { THREE } from './js_TP/tpb.js';

/**
 * Встроенные пресеты палитр.
 *
 * Каждый пресет — массив стопов `{ value, r, g, b, a }`,
 * отсортированный по `value` от 0 до 1.
 *
 * @type {Object<string, Array<{value:number,r:number,g:number,b:number,a:number}>>}
 */
export const COLOR_RAMP_PRESETS = {
    // ── Базовые ────────────────────────────────────────────────────
    grayscale: [
        { value: 0, r:   0, g:   0, b:   0, a: 255 },
        { value: 1, r: 255, g: 255, b: 255, a: 255 }
    ],
    terrain: [
        { value: 0.00, r:   0, g:  40, b: 100, a: 255 },
        { value: 0.10, r:   0, g: 100, b: 180, a: 255 },
        { value: 0.20, r: 100, g: 180, b: 220, a: 255 },
        { value: 0.25, r: 190, g: 215, b: 160, a: 255 },
        { value: 0.45, r: 100, g: 160, b:  80, a: 255 },
        { value: 0.65, r: 200, g: 180, b: 120, a: 255 },
        { value: 0.80, r: 170, g: 130, b:  90, a: 255 },
        { value: 0.90, r: 220, g: 220, b: 220, a: 255 },
        { value: 1.00, r: 255, g: 255, b: 255, a: 255 }
    ],

    // ── Перцептуально-равномерные (matplotlib / viridis family) ──
    viridis: [
        { value: 0.00, r:  68, g:   1, b:  84, a: 255 },
        { value: 0.25, r:  59, g:  82, b: 139, a: 255 },
        { value: 0.50, r:  33, g: 145, b: 140, a: 255 },
        { value: 0.75, r:  94, g: 201, b:  98, a: 255 },
        { value: 1.00, r: 253, g: 231, b:  37, a: 255 }
    ],
    plasma: [
        { value: 0.00, r:  13, g:   8, b: 135, a: 255 },
        { value: 0.25, r: 156, g:  23, b: 158, a: 255 },
        { value: 0.50, r: 237, g: 121, b:  83, a: 255 },
        { value: 0.75, r: 240, g: 249, b:  33, a: 255 },
        { value: 1.00, r: 240, g: 249, b:  33, a: 255 } // переопределяется ниже
    ],
    inferno: [
        { value: 0.00, r:   0, g:   0, b:   4, a: 255 },
        { value: 0.25, r: 120, g:  28, b: 109, a: 255 },
        { value: 0.50, r: 237, g: 105, b:  37, a: 255 },
        { value: 0.75, r: 252, g: 255, b: 164, a: 255 },
        { value: 1.00, r: 252, g: 255, b: 164, a: 255 }
    ],
    magma: [
        { value: 0.00, r:   0, g:   0, b:   4, a: 255 },
        { value: 0.25, r:  81, g:  18, b: 124, a: 255 },
        { value: 0.50, r: 183, g:  55, b: 121, a: 255 },
        { value: 0.75, r: 252, g: 137, b:  97, a: 255 },
        { value: 1.00, r: 252, g: 253, b: 191, a: 255 }
    ],
    cividis: [
        { value: 0.00, r:   0, g:  32, b:  76, a: 255 },
        { value: 0.33, r:  87, g:  93, b: 109, a: 255 },
        { value: 0.66, r: 165, g: 156, b: 116, a: 255 },
        { value: 1.00, r: 255, g: 234, b:  70, a: 255 }
    ],
    turbo: [
        { value: 0.00, r:  48, g:  18, b:  59, a: 255 },
        { value: 0.20, r:  33, g: 102, b: 172, a: 255 },
        { value: 0.40, r:  68, g: 190, b: 112, a: 255 },
        { value: 0.60, r: 185, g: 230, b:  66, a: 255 },
        { value: 0.80, r: 251, g: 128, b:  34, a: 255 },
        { value: 1.00, r: 122, g:   4, b:   3, a: 255 }
    ],

    // ── ColorBrewer: diverging ────────────────────────────────────
    RdYlBu: [
        { value: 0.00, r: 215, g:  48, b:  39, a: 255 },
        { value: 0.25, r: 253, g: 174, b:  97, a: 255 },
        { value: 0.50, r: 255, g: 255, b: 191, a: 255 },
        { value: 0.75, r: 171, g: 217, b: 233, a: 255 },
        { value: 1.00, r:  44, g: 123, b: 182, a: 255 }
    ],
    Spectral: [
        { value: 0.00, r: 158, g:   1, b:  66, a: 255 },
        { value: 0.16, r: 213, g:  62, b:  79, a: 255 },
        { value: 0.33, r: 244, g: 109, b:  67, a: 255 },
        { value: 0.50, r: 255, g: 255, b: 191, a: 255 },
        { value: 0.66, r: 171, g: 221, b: 164, a: 255 },
        { value: 0.83, r: 102, g: 194, b: 165, a: 255 },
        { value: 1.00, r:  50, g: 136, b: 189, a: 255 }
    ],
    RdYlGn: [
        { value: 0.00, r: 215, g:  48, b:  39, a: 255 },
        { value: 0.25, r: 252, g: 141, b:  89, a: 255 },
        { value: 0.50, r: 255, g: 255, b: 191, a: 255 },
        { value: 0.75, r: 145, g: 207, b:  96, a: 255 },
        { value: 1.00, r:  26, g: 152, b:  80, a: 255 }
    ],
    RdBu: [
        { value: 0.00, r: 103, g:   0, b:  31, a: 255 },
        { value: 0.25, r: 214, g:  96, b:  77, a: 255 },
        { value: 0.50, r: 247, g: 247, b: 247, a: 255 },
        { value: 0.75, r: 146, g: 197, b: 222, a: 255 },
        { value: 1.00, r:   5, g:  48, b:  97, a: 255 }
    ],
    PiYG: [
        { value: 0.00, r: 142, g:   1, b:  82, a: 255 },
        { value: 0.25, r: 222, g: 119, b: 174, a: 255 },
        { value: 0.50, r: 247, g: 247, b: 247, a: 255 },
        { value: 0.75, r: 184, g: 225, b: 134, a: 255 },
        { value: 1.00, r:  39, g: 100, b:  25, a: 255 }
    ],
    PRGn: [
        { value: 0.00, r:  64, g:   0, b:  75, a: 255 },
        { value: 0.25, r: 153, g: 112, b: 171, a: 255 },
        { value: 0.50, r: 247, g: 247, b: 247, a: 255 },
        { value: 0.75, r: 166, g: 219, b: 160, a: 255 },
        { value: 1.00, r:   0, g:  68, b:  27, a: 255 }
    ],
    BrBG: [
        { value: 0.00, r:  84, g:  48, b:   5, a: 255 },
        { value: 0.25, r: 191, g: 129, b:  45, a: 255 },
        { value: 0.50, r: 245, g: 245, b: 245, a: 255 },
        { value: 0.75, r: 128, g: 205, b: 193, a: 255 },
        { value: 1.00, r:   0, g:  60, b:  48, a: 255 }
    ],
    PuOr: [
        { value: 0.00, r: 127, g:  59, b:   8, a: 255 },
        { value: 0.25, r: 224, g: 130, b:  20, a: 255 },
        { value: 0.50, r: 247, g: 247, b: 247, a: 255 },
        { value: 0.75, r: 128, g: 115, b: 172, a: 255 },
        { value: 1.00, r:  45, g:   0, b:  75, a: 255 }
    ],
    RdGy: [
        { value: 0.00, r: 103, g:   0, b:  31, a: 255 },
        { value: 0.25, r: 214, g:  96, b:  77, a: 255 },
        { value: 0.50, r: 255, g: 255, b: 255, a: 255 },
        { value: 0.75, r: 186, g: 186, b: 186, a: 255 },
        { value: 1.00, r:  26, g:  26, b:  26, a: 255 }
    ],

    // ── ColorBrewer: sequential ───────────────────────────────────
    Blues: [
        { value: 0.00, r: 239, g: 243, b: 255, a: 255 },
        { value: 0.25, r: 189, g: 215, b: 231, a: 255 },
        { value: 0.50, r: 107, g: 174, b: 214, a: 255 },
        { value: 0.75, r:  49, g: 130, b: 189, a: 255 },
        { value: 1.00, r:   8, g:  81, b: 156, a: 255 }
    ],
    Greens: [
        { value: 0.00, r: 237, g: 248, b: 233, a: 255 },
        { value: 0.25, r: 186, g: 228, b: 179, a: 255 },
        { value: 0.50, r: 116, g: 196, b: 118, a: 255 },
        { value: 0.75, r:  49, g: 163, b:  84, a: 255 },
        { value: 1.00, r:   0, g: 109, b:  44, a: 255 }
    ],
    Oranges: [
        { value: 0.00, r: 254, g: 237, b: 222, a: 255 },
        { value: 0.25, r: 253, g: 190, b: 133, a: 255 },
        { value: 0.50, r: 253, g: 141, b:  60, a: 255 },
        { value: 0.75, r: 230, g:  85, b:  13, a: 255 },
        { value: 1.00, r: 166, g:  54, b:   3, a: 255 }
    ],
    Reds: [
        { value: 0.00, r: 254, g: 229, b: 217, a: 255 },
        { value: 0.25, r: 252, g: 174, b: 145, a: 255 },
        { value: 0.50, r: 251, g: 106, b:  74, a: 255 },
        { value: 0.75, r: 222, g:  45, b:  38, a: 255 },
        { value: 1.00, r: 165, g:  15, b:  21, a: 255 }
    ],
    Purples: [
        { value: 0.00, r: 242, g: 240, b: 247, a: 255 },
        { value: 0.25, r: 203, g: 201, b: 226, a: 255 },
        { value: 0.50, r: 158, g: 154, b: 200, a: 255 },
        { value: 0.75, r: 117, g: 107, b: 177, a: 255 },
        { value: 1.00, r:  84, g:  39, b: 143, a: 255 }
    ],
    Greys: [
        { value: 0.00, r: 247, g: 247, b: 247, a: 255 },
        { value: 0.25, r: 217, g: 217, b: 217, a: 255 },
        { value: 0.50, r: 189, g: 189, b: 189, a: 255 },
        { value: 0.75, r: 150, g: 150, b: 150, a: 255 },
        { value: 1.00, r:  99, g:  99, b:  99, a: 255 }
    ],
    YlGnBu: [
        { value: 0.00, r: 255, g: 255, b: 217, a: 255 },
        { value: 0.16, r: 199, g: 233, b: 180, a: 255 },
        { value: 0.33, r: 127, g: 205, b: 187, a: 255 },
        { value: 0.50, r:  65, g: 182, b: 196, a: 255 },
        { value: 0.66, r:  29, g: 145, b: 192, a: 255 },
        { value: 0.83, r:  34, g:  94, b: 168, a: 255 },
        { value: 1.00, r:   8, g:  29, b:  88, a: 255 }
    ],
    YlOrRd: [
        { value: 0.00, r: 255, g: 255, b: 204, a: 255 },
        { value: 0.16, r: 254, g: 217, b: 118, a: 255 },
        { value: 0.33, r: 254, g: 178, b:  76, a: 255 },
        { value: 0.50, r: 253, g: 141, b:  60, a: 255 },
        { value: 0.66, r: 252, g:  78, b:  42, a: 255 },
        { value: 0.83, r: 227, g:  26, b:  28, a: 255 },
        { value: 1.00, r: 128, g:   0, b:  38, a: 255 }
    ],
    BuGn: [
        { value: 0.00, r: 237, g: 248, b: 251, a: 255 },
        { value: 0.25, r: 178, g: 226, b: 226, a: 255 },
        { value: 0.50, r: 102, g: 194, b: 164, a: 255 },
        { value: 0.75, r:  44, g: 162, b:  95, a: 255 },
        { value: 1.00, r:   0, g: 109, b:  44, a: 255 }
    ],
    PuBu: [
        { value: 0.00, r: 255, g: 247, b: 251, a: 255 },
        { value: 0.25, r: 208, g: 209, b: 230, a: 255 },
        { value: 0.50, r: 116, g: 169, b: 207, a: 255 },
        { value: 0.75, r:  54, g: 144, b: 192, a: 255 },
        { value: 1.00, r:   5, g: 112, b: 176, a: 255 }
    ],

    // ── Инженерные / классические градиенты ──────────────────────
    coolwarm: [
        { value: 0.0, r:  59, g:  76, b: 192, a: 255 },
        { value: 0.5, r: 221, g: 221, b: 221, a: 255 },
        { value: 1.0, r: 180, g:   4, b:  38, a: 255 }
    ],
    cool: [
        { value: 0.0, r:   0, g: 255, b: 255, a: 255 },
        { value: 1.0, r: 255, g:   0, b: 255, a: 255 }
    ],
    hot: [
        { value: 0.00, r:   0, g:   0, b:   0, a: 255 },
        { value: 0.33, r: 255, g:   0, b:   0, a: 255 },
        { value: 0.66, r: 255, g: 255, b:   0, a: 255 },
        { value: 1.00, r: 255, g: 255, b: 255, a: 255 }
    ],
    jet: [
        { value: 0.00, r:   0, g:   0, b: 128, a: 255 },
        { value: 0.17, r:   0, g:   0, b: 255, a: 255 },
        { value: 0.33, r:   0, g: 255, b: 255, a: 255 },
        { value: 0.50, r:   0, g: 255, b:   0, a: 255 },
        { value: 0.67, r: 255, g: 255, b:   0, a: 255 },
        { value: 0.83, r: 255, g:   0, b:   0, a: 255 },
        { value: 1.00, r: 128, g:   0, b:   0, a: 255 }
    ],
    rainbow: [
        { value: 0.00, r: 255, g:   0, b:   0, a: 255 },
        { value: 0.17, r: 255, g: 165, b:   0, a: 255 },
        { value: 0.33, r: 255, g: 255, b:   0, a: 255 },
        { value: 0.50, r:   0, g: 255, b:   0, a: 255 },
        { value: 0.67, r:   0, g:   0, b: 255, a: 255 },
        { value: 0.83, r:  75, g:   0, b: 130, a: 255 },
        { value: 1.00, r: 238, g: 130, b: 238, a: 255 }
    ],
};

/**
 * Список доступных имён пресетов. Удобно для построения легенды/UI.
 * @returns {string[]}
 */
export function getPresetNames() {
    return Object.keys(COLOR_RAMP_PRESETS);
}

/**
 * Разворачивает вход в отсортированный массив стопов.
 */
export function resolveColorRamp(input) {
    let ramp;

    if (typeof input === 'string') {
        ramp = COLOR_RAMP_PRESETS[input];
        if (!ramp) {
            console.warn(`ColorRamps: неизвестный пресет "${input}", используем grayscale`);
            ramp = COLOR_RAMP_PRESETS.grayscale;
        }
    } else if (Array.isArray(input)) {
        ramp = _parseRampArray(input);
    } else {
        ramp = COLOR_RAMP_PRESETS.grayscale;
    }

    return ramp
        .map(s => ({ ...s }))
        .sort((a, b) => a.value - b.value);
}

/**
 * Линейная интерполяция палитры в точке `t ∈ [0, 1]`.
 */
export function sampleColorRamp(ramp, t) {
    if (t <= ramp[0].value) {
        const s = ramp[0];
        return [s.r, s.g, s.b, s.a];
    }
    const last = ramp[ramp.length - 1];
    if (t >= last.value) {
        return [last.r, last.g, last.b, last.a];
    }
    for (let i = 1; i < ramp.length; i++) {
        if (t <= ramp[i].value) {
            const a = ramp[i - 1];
            const b = ramp[i];
            const denom = b.value - a.value;
            const f = denom > 0 ? (t - a.value) / denom : 0;
            return [
                Math.round(a.r + (b.r - a.r) * f),
                Math.round(a.g + (b.g - a.g) * f),
                Math.round(a.b + (b.b - a.b) * f),
                Math.round(a.a + (b.a - a.a) * f)
            ];
        }
    }
    return [last.r, last.g, last.b, last.a];
}

/**
 * Приводит цвет к `{r, g, b, a}` в 0..255.
 * ...
 */
export function parseColorToRGBA(c) {

    if (Array.isArray(c) && c.length >= 3) {
        return {
            r: c[0] | 0,
            g: c[1] | 0,
            b: c[2] | 0,
            a: c.length >= 4 ? (c[3] | 0) : 255
        };
    }

    if (typeof c === 'string') {
        const s = c.trim();
        if (s.toLowerCase() === 'transparent') {
            return { r: 0, g: 0, b: 0, a: 0 };
        }

        if (s.startsWith('#')) {
            const hex = s.slice(1);
            if (hex.length === 3 || hex.length === 4) {
                return {
                    r: parseInt(hex[0] + hex[0], 16),
                    g: parseInt(hex[1] + hex[1], 16),
                    b: parseInt(hex[2] + hex[2], 16),
                    a: hex.length === 4 ? parseInt(hex[3] + hex[3], 16) : 255
                };
            }
            if (hex.length === 6 || hex.length === 8) {
                return {
                    r: parseInt(hex.slice(0, 2), 16),
                    g: parseInt(hex.slice(2, 4), 16),
                    b: parseInt(hex.slice(4, 6), 16),
                    a: hex.length === 8 ? parseInt(hex.slice(6, 8), 16) : 255
                };
            }
        }

        const rgba = s.match(
            /^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*(?:,\s*([\d.]+)\s*)?\)$/i
        );
        if (rgba) {
            return {
                r: Math.round(+rgba[1]),
                g: Math.round(+rgba[2]),
                b: Math.round(+rgba[3]),
                a: rgba[4] !== undefined ? Math.round(+rgba[4] * 255) : 255
            };
        }

        try {
            const col = new THREE.Color(s);
            const hex = col.getHex();
            return {
                r: (hex >> 16) & 0xff,
                g: (hex >> 8) & 0xff,
                b: hex & 0xff,
                a: 255
            };
        } catch (e) { /* fallthrough */ }
    }

    console.warn(`ColorRamps: не удалось разобрать цвет "${c}", используем чёрный`);
    return { r: 0, g: 0, b: 0, a: 255 };
}

/* ================================================================
   Внутренние утилиты
   ================================================================ */

function _parseRampArray(arr) {
    const out = [];

    for (const item of arr) {
        if (Array.isArray(item) && item.length >= 2) {
            out.push({ value: item[0], ...parseColorToRGBA(item[1]) });
        } else if (item && typeof item === 'object') {
            if (item.color !== undefined) {
                out.push({ value: item.value, ...parseColorToRGBA(item.color) });
            } else if ('r' in item && 'g' in item && 'b' in item) {
                out.push({
                    value: item.value,
                    r: item.r | 0,
                    g: item.g | 0,
                    b: item.b | 0,
                    a: item.a ?? 255
                });
            }
        }
    }

    if (out.length === 0) {
        console.warn('ColorRamps: пустой массив стопов, используем grayscale');
        return COLOR_RAMP_PRESETS.grayscale.map(s => ({ ...s }));
    }
    if (out.length === 1) {
        out.push({ ...out[0], value: 1 });
    }
    return out;
}

/**
 * Инвертирует палитру: значение каждого стопа `v` заменяется на `1 − v`,
 * после чего массив пересортировывается. Семантически эквивалентно
 * `sampleColorRamp(ramp, 1 − t)`.
 *
 * @param {Array<{value:number,r:number,g:number,b:number,a:number}>} ramp
 * @returns {Array<{value:number,r:number,g:number,b:number,a:number}>}
 */
export function invertColorRamp(ramp) {
    return ramp
        .map(s => ({ ...s, value: 1 - s.value }))
        .sort((a, b) => a.value - b.value);
}