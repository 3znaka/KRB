/**
 * Декодер цифрового классификатора RSC (ГИС «Панорама»), ПАРБ.00046-06 99 05.
 *
 * Читает: заголовок, таблицу объектов (название, код, слой, характер локализации),
 * таблицу семантик, слоёв, палитры, таблицу параметров отображения PAR (стили).
 *
 * Использование:
 *   const { parseRsc } = require('./rsc.cjs');
 *   const cls = parseRsc(arrayBuffer);
 *   cls.objectByCode.get(31120000)  // { name, shortName, layer, style: {...} }
 */
'use strict';

const RSC_SIG = 0x00435352;  // "RSC"
const TAG = {
  OBJ: 0x004A424F, SEM: 0x004D4553, CLS: 0x00534C43, DEF: 0x00464544,
  POS: 0x00534F50, SEG: 0x00474553, PAR: 0x00524150, PRN: 0x004E5250,
  PAL: 0x004C4150, TXT: 0x00545854, TAB: 0x00424154,
};

const LOC = ['LIN', 'SQR', 'DOT', 'TIT', 'VEC', 'PAT'];   // Таблица 5, прим. 1
const PRIM = { 128: 'line', 129: 'dashed', 148: 'offsetDashed', 135: 'area', 153: 'hatch', 143: 'point' };

// Строка CP1251 (ограниченная нулём).
function cp1251(bytes) {
  let end = bytes.indexOf(0);
  if (end < 0) end = bytes.length;
  return new TextDecoder('windows-1251').decode(bytes.subarray(0, end)).trim();
}

// Цвет RSC: индекс палитры записан как 0xF0XXXXXX (в файле: байты «XX 00 00 F0»), иначе
// 0x00RRGGBB (Приложение 1). По реальным данным старший байт = 0xF0, индекс — младший байт.
// Палитра «Стандартная» в файле хранит байты в порядке B,G,R,0.
function colorFrom(value, palette) {
  const hi = (value >>> 24) & 0xFF;             // беззнаковый старший байт
  if (hi === 0xF0 || hi === 0x0F) {
    const idx = value & 0xFF;
    const rgb = palette && palette[idx];
    return rgb ? rgb : { index: idx };
  }
  return {
    hex: '#' + ((value >> 16) & 0xFF).toString(16).padStart(2, '0') +
      ((value >> 8) & 0xFF).toString(16).padStart(2, '0') +
      (value & 0xFF).toString(16).padStart(2, '0'),
  };
}

function toHex(rgb) {
  return '#' + rgb.r.toString(16).padStart(2, '0') + rgb.g.toString(16).padStart(2, '0') + rgb.b.toString(16).padStart(2, '0');
}

function parseRsc(arrayBuffer) {
  const dv = new DataView(arrayBuffer);
  const b = new Uint8Array(arrayBuffer);
  const u32 = (o) => dv.getUint32(o, true);
  const u16 = (o) => dv.getUint16(o, true);
  const i32 = (o) => dv.getInt32(o, true);

  if (u32(0) !== RSC_SIG) throw new Error('Не классификатор RSC (нет сигнатуры)');

  // ---- заголовок (Таблица 1–3) ----
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
  // Таблицы: смещение (от начала файла), длина, число записей
  const tbl = {
    objects: { off: u32(120), len: u32(124), count: u32(128) },
    semantics: { off: u32(132), len: u32(136), count: u32(140) },
    semClass: { off: u32(144), len: u32(148), count: u32(152) },
    defaults: { off: u32(156), len: u32(160), count: u32(164) },
    segments: { off: u32(180), len: u32(184), count: u32(188) },
  };

  // Таблица параметров экрана PAR: тег «.PAR» перед таблицей; ищем тег по заголовку.
  const findTag = (tagVal, from = 0) => {
    for (let o = from; o + 4 <= b.length; o++) if (u32(o) === tagVal) return o + 4;
    return -1;
  };

  // ---- палитра (Таблица 16): 1024 байта BGR0 + 32 байта название, тег «.PAL» ----
  // Смещения таблиц в заголовке по таблице 3 не совпадают с фактическими данными в файле,
  // поэтому ищем тег и берём данные сразу за ним.
  const palette = [];
  let paletteName = null;
  const palOff = findTag(TAG.PAL);
  if (palOff > 0) {
    for (let i = 0; i < 256; i++) {
      const o = palOff + i * 4;
      const B = b[o], G = b[o + 1], R = b[o + 2];
      palette.push({ r: R, g: G, b: B, hex: toHex({ r: R, g: G, b: B }) });
    }
    paletteName = cp1251(b.subarray(palOff + 1024, palOff + 1056));
  }

  // ---- таблица объектов (Таблица 5) ----
  const objects = [];
  const objByCode = new Map();
  let o = tbl.objects.off;
  const oEnd = tbl.objects.off + tbl.objects.len;
  while (o + 8 <= oEnd) {
    const L = u32(o);
    if (L < 112 || o + L > oEnd) break;
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
      isRealClassificator: undefined,
    };
    objects.push(rec);
    if (!objByCode.has(rec.code)) objByCode.set(rec.code, rec);
    o += L;
  }

  // ---- таблица PAR: стили отображения по внутреннему коду объекта ----
  const parOff = findTag(TAG.PAR);
  const styleByInternal = new Map();
  if (parOff > 0) {
    // Длина таблицы — из заголовка PAR (записей со своими длинами). Идём, пока длины разумны.
    let p = parOff;
    const parEnd = b.length;
    let guard = 0;
    while (p + 8 <= parEnd && guard++ < 100000) {
      const L = u32(p);
      if (L < 8 || L > 100000) break;
      const internal = u16(p + 4);
      const fn = u16(p + 6);
      const prm = p + 8;
      const style = { primitive: PRIM[fn] || fn };
      if (fn === 128 || fn === 129 || fn === 148) {
        style.color = colorFrom(u32(prm), palette);
        style.width = u32(prm + 4);                 // микроны
        if (fn === 129 || fn === 148) {
          style.dash = u32(prm + 8);
          style.gap = u32(prm + 12);
        }
        if (fn === 148) style.offset = i32(prm + 16);
      } else if (fn === 135) {
        style.fillColor = colorFrom(u32(prm), palette);
      } else if (fn === 153) {
        style.angle = u32(prm + 4);
        style.step = u32(prm + 8);
      }
      if (!styleByInternal.has(internal)) styleByInternal.set(internal, style);
      else (styleByInternal.get(internal).more = styleByInternal.get(internal).more || []).push(style);
      p += L;
    }
  }

  // Связываем объекты со стилями по внутреннему коду.
  for (const obj of objects) obj.style = styleByInternal.get(obj.internalId) || null;

  // ---- слои (Таблица 11) ----
  const layers = [];
  let s = tbl.segments.off;
  const sEnd = tbl.segments.off + tbl.segments.len;
  while (s + 60 <= sEnd) {
    const L = u32(s);
    if (L < 60 || s + L > sEnd) break;
    layers.push({
      name: cp1251(b.subarray(s + 4, s + 36)),
      shortName: cp1251(b.subarray(s + 36, s + 52)),
      number: b[s + 52],
      order: b[s + 53],
    });
    s += L;
  }

  // ---- семантики (Таблица 7): постоянная длина 84 байта ----
  const semantics = [];
  for (let i = 0; i < tbl.semantics.count; i++) {
    const q = tbl.semantics.off + i * 84;
    if (q + 84 > b.length) break;
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

// Таблица соответствия classCode -> название (для отдельного JSON рядом с GeoJSON).
function buildCodeTable(cls) {
  const table = {};
  for (const [code, entry] of cls.objectByCode) {
    table[code] = { name: entry.name, shortName: entry.shortName, layer: entry.layer };
  }
  return table;
}

module.exports = { parseRsc, cp1251, colorFrom, buildCodeTable };
