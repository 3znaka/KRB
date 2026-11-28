// rscParser.ts — декодер цифрового классификатора RSC (ГИС «Панорама», ПАРБ.00046-06 99 05).
// Перенесён из test/sxf/rsc.cjs. Читает заголовок, объекты, слои, семантики, палитру и стили PAR.
const RSC_SIG = 0x00435352; // "RSC"
const TAG_PAR = 0x00524150; // ".PAR"
const TAG_PAL = 0x004C4150; // ".PAL"
const LOC = ['LIN', 'SQR', 'DOT', 'TIT', 'VEC', 'PAT']; // Таблица 5, прим. 1
const PRIM = {
    128: 'line', 129: 'dashed', 148: 'offsetDashed', 135: 'area', 153: 'hatch', 143: 'point',
};
function cp1251(bytes) {
    let end = bytes.indexOf(0);
    if (end < 0)
        end = bytes.length;
    return new TextDecoder('windows-1251').decode(bytes.subarray(0, end)).trim();
}
function toHex(r, g, b) {
    return '#' + [r, g, b].map(v => v.toString(16).padStart(2, '0')).join('');
}
/**
 * Цвет RSC: индекс палитры хранится с старшим байтом 0xF0 (или 0x0F), младший — индекс.
 * Иначе значение — RGB 0x00RRGGBB (Приложение 1). Палитра «Стандартная» хранит байты B,G,R,0.
 */
export function colorFrom(value, palette) {
    const hi = (value >>> 24) & 0xFF;
    if (hi === 0xF0 || hi === 0x0F) {
        const idx = value & 0xFF;
        const rgb = palette && palette[idx];
        return rgb ? { r: rgb.r, g: rgb.g, b: rgb.b, hex: rgb.hex } : { index: idx };
    }
    // Прямой цвет 0x00RRGGBB — по Приложению 1 спецификации (RR в старшем байте).
    return {
        hex: toHex((value >> 16) & 0xFF, (value >> 8) & 0xFF, value & 0xFF),
    };
}
/** Перо фрагмента векторного знака (Таблица 35, «Параметры цепочки по ее типу»). */
function readSymbolPen(dv, b, off, kind, plen, palette) {
    const u32 = (o) => dv.getUint32(o, true);
    switch (kind) {
        case 128: // линия: цвет, толщина (мкм)
            return { kind, color: colorFrom(u32(off), palette), width: u32(off + 4) };
        case 129: // пунктир: цвет, толщина, штрих, пробел
            return { kind, color: colorFrom(u32(off), palette), width: u32(off + 4), dash: u32(off + 8), gap: u32(off + 12) };
        case 135: // площадь: цвет заливки
            return { kind, color: colorFrom(u32(off), palette) };
        default:
            return plen >= 4 ? { kind } : null;
    }
}
/**
 * Векторный знак (тип 149, Таблицы 34–35). Параметры начинаются со смещения off (поле «Длина
 * параметров», N1). Фрагмент: тип цепочки(1) | тип параметров(1) | длина параметров(2) |
 * параметры(plen) | число точек(4) | точки X,Y(по 8).
 */
export function parseVectorSymbol(dv, b, off, palette) {
    const u32 = (o) => dv.getUint32(o, true);
    const i32 = (o) => dv.getInt32(o, true);
    const u16 = (o) => dv.getUint16(o, true);
    // Таблица 34: привязка (+4, +8), база (+12), максимальный габарит (+48), число фрагментов (+52).
    const nFrag = u32(off + 52);
    const fragments = [];
    // Таблица 35: тип цепочки(1) | тип параметров(1) | длина параметров(2) | параметры(N) |
    // число точек(4) | точки X,Y (по 4 байта со знаком).
    let f = off + 56;
    for (let k = 0; k < nFrag; k++) {
        if (f + 8 > b.length)
            break;
        const chain = b[f];
        const penKind = b[f + 1];
        const plen = u16(f + 2);
        const pen = readSymbolPen(dv, b, f + 4, penKind, plen, palette);
        const npts = u32(f + 4 + plen);
        if (npts > 512)
            break; // Таблица 35: число точек не более 512
        const pointsOff = f + 8 + plen;
        const points = [];
        for (let j = 0; j < npts; j++)
            points.push([i32(pointsOff + j * 8), i32(pointsOff + j * 8 + 4)]);
        // Порядок осей (X, Y) одинаков для всех фрагментов; координаты читаются как записаны в файле.
        fragments.push({ chain, pen, points });
        f = pointsOff + npts * 8;
    }
    return {
        kind: 'vector',
        anchor: [i32(off + 4), i32(off + 8)],
        base: i32(off + 12),
        maxGabarit: i32(off + 48),
        fragments,
    };
}
/**
 * Растровый знак (тип 143, Таблица 30): число цветов, размер стороны, привязка, затем по цвету:
 * цвет(4) + маска 32×32 (128 байт, бит на точку).
 */
export function parseRasterSymbol(dv, b, off, palette) {
    const u32 = (o) => dv.getUint32(o, true);
    const i32 = (o) => dv.getInt32(o, true);
    const nColors = u32(off + 4);
    const size = u32(off + 8);
    const anchor = [i32(off + 12), i32(off + 16)];
    const masks = [];
    let m = off + 20;
    for (let k = 0; k < nColors && k < 16; k++) {
        masks.push({ color: colorFrom(u32(m), palette), bits: b.slice(m + 4, m + 4 + 128) });
        m += 132;
    }
    return { kind: 'raster', size, anchor, masks };
}
/** Разбор классификатора RSC целиком. */
export function parseRsc(buffer) {
    const dv = new DataView(buffer);
    const b = new Uint8Array(buffer);
    const u32 = (o) => dv.getUint32(o, true);
    const u16 = (o) => dv.getUint16(o, true);
    const i32 = (o) => dv.getInt32(o, true);
    if (u32(0) !== RSC_SIG)
        throw new Error('RSC: не классификатор (нет сигнатуры)');
    const header = {
        fileLength: u32(4),
        version: u32(8),
        encoding: u32(12),
        language: u32(24),
        maxObjectId: u32(28),
        date: cp1251(b.subarray(32, 40)),
        mapType: cp1251(b.subarray(40, 72)),
        name: cp1251(b.subarray(72, 104)),
        code: cp1251(b.subarray(104, 112)),
        baseScale: u32(112),
    };
    // Таблицы: смещение (от начала файла), длина, число записей (Таблицы 2–3)
    const tbl = {
        objects: { off: u32(120), len: u32(124) },
        semantics: { off: u32(132), count: u32(140) },
        segments: { off: u32(180), len: u32(184) },
    };
    // Смещения таблиц в заголовке по Таблице 3 не совпадают с фактическими данными,
    // поэтому палитру и стили ищем по тегам (.PAL, .PAR) — как и в проверенном прототипе.
    const findTag = (tagVal) => {
        for (let o = 0; o + 4 <= b.length; o++)
            if (u32(o) === tagVal)
                return o + 4;
        return -1;
    };
    const palette = [];
    let paletteName = null;
    const palOff = findTag(TAG_PAL);
    if (palOff > 0) {
        for (let i = 0; i < 256; i++) {
            const o = palOff + i * 4;
            // Порядок байт палитры: R, G, B (индексы 13/0 подтверждают: фонтаны — синие, ямы — коричневые).
            const R = b[o], G = b[o + 1], B = b[o + 2];
            palette.push({ r: R, g: G, b: B, hex: toHex(R, G, B) });
        }
        paletteName = cp1251(b.subarray(palOff + 1024, palOff + 1056));
    }
    // Таблица объектов (Таблица 5)
    const objects = [];
    const objByCode = new Map();
    let o = tbl.objects.off;
    const oEnd = tbl.objects.off + tbl.objects.len;
    while (o + 8 <= oEnd) {
        const L = u32(o);
        if (L < 112 || o + L > oEnd)
            break;
        const rec = {
            code: u32(o + 4),
            internalId: u32(o + 8),
            idCode: u32(o + 12),
            shortName: cp1251(b.subarray(o + 16, o + 48)),
            name: cp1251(b.subarray(o + 48, o + 80)),
            localization: LOC[b[o + 80]] || String(b[o + 80]),
            layer: b[o + 81],
            scalable: !!b[o + 82],
            minVisibility: b[o + 83],
            maxVisibility: 15 - b[o + 84],
            directionality: b[o + 86],
            style: null,
        };
        objects.push(rec);
        if (!objByCode.has(rec.code))
            objByCode.set(rec.code, rec);
        o += L;
    }
    // Таблица PAR: стили по внутреннему коду объекта
    const styleByInternal = new Map();
    const parOff = findTag(TAG_PAR);
    if (parOff > 0) {
        let p = parOff;
        let guard = 0;
        while (p + 8 <= b.length && guard++ < 100000) {
            const L = u32(p);
            if (L < 8 || L > 100000)
                break;
            const internal = u16(p + 4);
            const fn = u16(p + 6);
            const prm = p + 8;
            const style = { primitive: PRIM[fn] || fn };
            if (fn === 128 || fn === 129 || fn === 148) {
                style.color = colorFrom(u32(prm), palette);
                style.width = u32(prm + 4);
                if (fn === 129 || fn === 148) {
                    style.dash = u32(prm + 8);
                    style.gap = u32(prm + 12);
                }
                if (fn === 148)
                    style.offset = i32(prm + 16);
            }
            else if (fn === 135) {
                style.fillColor = colorFrom(u32(prm), palette);
            }
            else if (fn === 153) {
                style.angle = u32(prm + 4);
                style.step = u32(prm + 8);
            }
            else if (fn === 149) {
                // Векторный точечный знак (Таблица 34). Ошибки разбора не должны ронять классификатор.
                try {
                    style.symbol = parseVectorSymbol(dv, b, prm, palette);
                }
                catch { /* пропуск */ }
            }
            else if (fn === 143) {
                // Растровый точечный знак 32×32 (Таблица 30).
                try {
                    style.symbol = parseRasterSymbol(dv, b, prm, palette);
                }
                catch { /* пропуск */ }
            }
            const prev = styleByInternal.get(internal);
            if (!prev)
                styleByInternal.set(internal, style);
            else
                (prev.more ??= []).push(style);
            p += L;
        }
    }
    for (const obj of objects)
        obj.style = styleByInternal.get(obj.internalId) ?? null;
    // Слои (Таблица 11)
    const layers = [];
    let s = tbl.segments.off;
    const sEnd = tbl.segments.off + tbl.segments.len;
    while (s + 60 <= sEnd) {
        const L = u32(s);
        if (L < 60 || s + L > sEnd)
            break;
        layers.push({
            name: cp1251(b.subarray(s + 4, s + 36)),
            shortName: cp1251(b.subarray(s + 36, s + 52)),
            number: b[s + 52],
            order: b[s + 53],
        });
        s += L;
    }
    // Семантики (Таблица 7): постоянная длина 84 байта
    const semantics = [];
    for (let i = 0; i < tbl.semantics.count; i++) {
        const q = tbl.semantics.off + i * 84;
        if (q + 84 > b.length)
            break;
        semantics.push({
            code: u32(q),
            valueType: u16(q + 4),
            repeatable: !!b[q + 6],
            name: cp1251(b.subarray(q + 8, q + 40)),
            shortName: cp1251(b.subarray(q + 40, q + 56)),
            unit: cp1251(b.subarray(q + 56, q + 64)),
            size: u16(q + 64),
            precision: b[q + 66],
        });
    }
    return {
        header,
        paletteName,
        palette,
        objects,
        objectByCode: objByCode,
        layers,
        semantics,
        semanticByCode: new Map(semantics.map(x => [x.code, x])),
    };
}
/** Таблица соответствия classCode -> название (для JSON рядом с GeoJSON). */
export function buildCodeTable(cls) {
    const table = {};
    for (const [code, entry] of cls.objectByCode) {
        table[code] = { name: entry.name, shortName: entry.shortName, layer: entry.layer };
    }
    return table;
}
