// @ts-nocheck
/**
 * Цветовые палитры для одноканальных растров (DEM, маски, индексы).
 *
 * Модуль намеренно не зависит от остальной библиотеки: его можно
 * использовать в других слоях, виджетах и утилитах, которым нужна
 * нормализация значений + раскраска.
 *
 * Формат стопа:
 *   `{ value: 0..1, r, g, b, a: 0..255 }`.
 *
 * Публичный API:
 *   - `COLOR_RAMP_PRESETS`   — встроенные палитры;
 *   - `getPresetNames()`     — имена пресетов (для UI);
 *   - `resolveColorRamp(x)`  — строка/массив → отсортированный массив стопов;
 *   - `sampleColorRamp(...)` — линейная интерполяция в точке `t`;
 *   - `parseColorToRGBA(c)`  — CSS-цвет → `{r,g,b,a}`.
 *
 * @module ColorRamps
 */
import { THREE } from './js_TP/tpb.js';
/**
 * Встроенные пресеты палитр.
 *
 * Значения `r/g/b/a` — «сырые» sRGB-байты. При наложении на текстуру
 * с `colorSpace = SRGBColorSpace` они дают ожидаемые цвета.
 *
 * @type {Object<string, Array<{value:number,r:number,g:number,b:number,a:number}>>}
 */
export const COLOR_RAMP_PRESETS = {
    grayscale: [
        { value: 0, r: 0, g: 0, b: 0, a: 255 },
        { value: 1, r: 255, g: 255, b: 255, a: 255 }
    ],
    terrain: [
        { value: 0.00, r: 0, g: 40, b: 100, a: 255 }, // глубокая вода
        { value: 0.10, r: 0, g: 100, b: 180, a: 255 }, // мелководье
        { value: 0.20, r: 100, g: 180, b: 220, a: 255 }, // берег
        { value: 0.25, r: 190, g: 215, b: 160, a: 255 }, // низины
        { value: 0.45, r: 100, g: 160, b: 80, a: 255 }, // равнины
        { value: 0.65, r: 200, g: 180, b: 120, a: 255 }, // плато
        { value: 0.80, r: 170, g: 130, b: 90, a: 255 }, // горы
        { value: 0.90, r: 220, g: 220, b: 220, a: 255 }, // снег
        { value: 1.00, r: 255, g: 255, b: 255, a: 255 } // пики
    ],
    viridis: [
        { value: 0.00, r: 68, g: 1, b: 84, a: 255 },
        { value: 0.25, r: 59, g: 82, b: 139, a: 255 },
        { value: 0.50, r: 33, g: 145, b: 140, a: 255 },
        { value: 0.75, r: 94, g: 201, b: 98, a: 255 },
        { value: 1.00, r: 253, g: 231, b: 37, a: 255 }
    ],
    magma: [
        { value: 0.00, r: 0, g: 0, b: 4, a: 255 },
        { value: 0.25, r: 81, g: 18, b: 124, a: 255 },
        { value: 0.50, r: 183, g: 55, b: 121, a: 255 },
        { value: 0.75, r: 252, g: 137, b: 97, a: 255 },
        { value: 1.00, r: 252, g: 253, b: 191, a: 255 }
    ],
    coolwarm: [
        { value: 0.0, r: 59, g: 76, b: 192, a: 255 },
        { value: 0.5, r: 221, g: 221, b: 221, a: 255 },
        { value: 1.0, r: 180, g: 4, b: 38, a: 255 }
    ]
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
 *
 * Принимает:
 *   - `undefined` / `null` — `grayscale`;
 *   - строку-пресет (`'terrain'`, `'viridis'`, …);
 *   - массив стопов:
 *       `[[0, '#000'], [1, '#fff']]`
 *       `[[0, [0,0,0]], [1, [255,255,255]]]`
 *       `[{ value: 0, color: '#000' }, …]`
 *       `[{ value: 0, r, g, b, a }, …]`
 *
 * Возвращает **новый** массив (отсортированный копией), чтобы
 * вызывающая сторона могла безопасно его кэшировать.
 *
 * @param {string|Array|null|undefined} input
 * @returns {Array<{value:number,r:number,g:number,b:number,a:number}>}
 */
export function resolveColorRamp(input) {
    let ramp;
    if (typeof input === 'string') {
        ramp = COLOR_RAMP_PRESETS[input];
        if (!ramp) {
            console.warn(`ColorRamps: неизвестный пресет "${input}", используем grayscale`);
            ramp = COLOR_RAMP_PRESETS.grayscale;
        }
    }
    else if (Array.isArray(input)) {
        ramp = _parseRampArray(input);
    }
    else {
        ramp = COLOR_RAMP_PRESETS.grayscale;
    }
    return ramp
        .map(s => ({ ...s }))
        .sort((a, b) => a.value - b.value);
}
/**
 * Линейная интерполяция палитры в точке `t ∈ [0, 1]`.
 * Вне `[0, 1]` возвращает крайние цвета.
 *
 * @param {Array<{value:number,r:number,g:number,b:number,a:number}>} ramp
 * @param {number} t
 * @returns {[number, number, number, number]}
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
 *
 * Поддерживает:
 *  - массивы `[r, g, b]` / `[r, g, b, a]`;
 *  - hex-строки `#rgb`, `#rgba`, `#rrggbb`, `#rrggbbaa`;
 *  - `rgb(...)` / `rgba(...)`;
 *  - `'transparent'` → `{r:0,g:0,b:0,a:0}`;
 *  - именованные цвета (`'red'`, …) — через `THREE.Color`.
 *
 * @param {*} c
 * @returns {{r:number,g:number,b:number,a:number}}
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
        const rgba = s.match(/^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*(?:,\s*([\d.]+)\s*)?\)$/i);
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
            const hex = col.getHex(); // sRGB
            return {
                r: (hex >> 16) & 0xff,
                g: (hex >> 8) & 0xff,
                b: hex & 0xff,
                a: 255
            };
        }
        catch (e) { /* fallthrough */ }
    }
    console.warn(`ColorRamps: не удалось разобрать цвет "${c}", используем чёрный`);
    return { r: 0, g: 0, b: 0, a: 255 };
}
/* ================================================================
   Внутренние утилиты
   ================================================================ */
/**
 * Парсит пользовательский массив стопов в нормализованный формат.
 * @private
 * @param {Array} arr
 * @returns {Array<{value:number,r:number,g:number,b:number,a:number}>}
 */
function _parseRampArray(arr) {
    const out = [];
    for (const item of arr) {
        if (Array.isArray(item) && item.length >= 2) {
            // [value, color]
            out.push({ value: item[0], ...parseColorToRGBA(item[1]) });
        }
        else if (item && typeof item === 'object') {
            if (item.color !== undefined) {
                out.push({ value: item.value, ...parseColorToRGBA(item.color) });
            }
            else if ('r' in item && 'g' in item && 'b' in item) {
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
        // растянем одиночный стоп на весь диапазон
        out.push({ ...out[0], value: 1 });
    }
    return out;
}
