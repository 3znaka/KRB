/**
 * SXF (бинарный, ред. 4.0, ПАРБ.00046-06 99 02) -> GeoJSON.
 *
 * Без внешних зависимостей. Работает в Node.js (CommonJS) и в браузере
 * (через <script>, глобальный объект SXF).
 *
 *   const { toGeoJSON } = require('./sxf2geojson.cjs');
 *   const geo = toGeoJSON(arrayBuffer);
 *
 * Что перекодируется однозначно:
 *   - паспорт листа (номенклатура, масштаб, система/проекция/эллипсоид — как коды);
 *   - объекты: класс (код), локализация (LIN/SQR/DOT/TIT/VEC), номер, группа, видимость;
 *   - метрика: точки, подобъекты (внутренние кольца / продолжения линии), подписи;
 *   - семантика: пары код -> значение.
 *
 * Что НЕ перекодируется (сохраняется в properties как есть или опускается):
 *   - перевод из прямоугольной проекции SXF в WGS84 — требует параметров проекции.
 *     По умолчанию координаты отдаются в исходной системе SXF (X=север, Y=восток
 *     в метрах; GeoJSON-порядок [x=восток, y=север]). Для WGS84 передайте projector;
 *   - графика (условные знаки), векторы привязки 3D, калибровочные точки маршрута.
 */
'use strict';

const SIG_FILE = 0x00465853;   // "SXF"
const SIG_DAT = 0x00544144;    // "DAT"
const SIG_REC = 0x7FFF7FFF;    // начало записи объекта
const SIG_GRAPH = 0x7FFF7FFE;  // графика (внутри записи, учтена в metricLen)
const SIG_VEC3D = 0x7FFF7FFD;  // вектор привязки 3D (внутри записи)
const PASSPORT_LEN = 400;

// Характер локализации (4 бита, Таблица 3, прим. 1)
const LOC = ['LIN', 'SQR', 'DOT', 'TIT', 'VEC', 'PAT'];

// ---------- низкоуровневое чтение (little-endian) ----------
class Reader {
  constructor(arrayBuffer) {
    this.buf = arrayBuffer;
    this.dv = new DataView(arrayBuffer);
    this.len = arrayBuffer.byteLength;
  }
  u8(o) { return this.dv.getUint8(o); }
  i8(o) { return this.dv.getInt8(o); }
  u16(o) { return this.dv.getUint16(o, true); }
  i16(o) { return this.dv.getInt16(o, true); }
  u32(o) { return this.dv.getUint32(o, true); }
  i32(o) { return this.dv.getInt32(o, true); }
  i64(o) { return Number(this.dv.getBigInt64(o, true)); }
  f32(o) { return this.dv.getFloat32(o, true); }
  f64(o) { return this.dv.getFloat64(o, true); }
  bytes(o, n) { return new Uint8Array(this.buf, o, Math.max(0, Math.min(n, this.len - o))); }
  str(o, n) {
    const b = this.bytes(o, n);
    let end = b.indexOf(0);
    if (end < 0) end = b.length;
    return decodeAnsi(b.subarray(0, end));
  }
}

// ANSI = Windows-1251 (спецификация: «символьные поля в формате ANSI»)
const CP1251_HI =
  'ЂЃ‚ѓ„…†‡€‰Љ‹ЊЌЋЏђ‘’“”•–—˜™љ›њќћџ ЎўЈ¤Ґ¦§Ё©Є«¬\u00AD®Ї°±Ііґµ¶·ё№є»јЅѕї' +
  'АБВГДЕЖЗИЙКЛМНОПРСТУФХЦЧШЩЪЫЬЭЮЯабвгдежзийклмнопрстуфхцчшщъыьэюя';
function decodeAnsi(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i++) {
    const c = bytes[i];
    s += c < 0x80 ? String.fromCharCode(c) : (CP1251_HI[c - 0x80] || '?');
  }
  return s.trim();
}
function decodeUtf16(bytes) {
  return new TextDecoder('utf-16le').decode(bytes).replace(/\0+$/, '');
}

// Значение семантики: строка (ANSI), если все байты — печатные/кириллица; иначе целое LE.
function interpretSemanticValue(bytes) {
  let printable = bytes.length > 0;
  for (let i = 0; i < bytes.length && printable; i++) {
    const c = bytes[i];
    if (c === 0) continue;                       // нулевые байты (ASCIIZ / выравнивание)
    if (c < 0x20 && c !== 0x09) printable = false;
  }
  if (printable && bytes.length > 4) return decodeAnsi(bytes).replace(/\0+/g, '').trim();
  if (bytes.length === 1) return bytes[0];
  if (bytes.length === 2) return bytes[0] | (bytes[1] << 8);
  if (bytes.length === 4) return (bytes[0] | (bytes[1] << 8) | (bytes[2] << 16) | (bytes[3] << 24)) >>> 0;
  return Array.from(bytes);
}

// ---------- паспорт (Таблица 1, 400 байт) ----------
function readPassport(r) {
  if (r.len < PASSPORT_LEN) throw new Error('Файл короче паспорта');
  if (r.u32(0) !== SIG_FILE) throw new Error('Нет сигнатуры SXF');
  const passLen = r.u32(4);
  if (passLen !== PASSPORT_LEN) throw new Error('Неожиданная длина паспорта: ' + passLen);

  const edition = r.u32(8);
  const flags = r.u32(96);
  const cornersXY = [0, 1, 2, 3].map(i => ({ x: r.f64(104 + i * 16), y: r.f64(104 + i * 16 + 8) }));
  const cornersGeod = [0, 1, 2, 3].map(i => ({ B: r.f64(168 + i * 16), L: r.f64(168 + i * 16 + 8) }));

  const passport = {
    edition: `${edition >> 16}.${(edition >> 8) & 0xFF}`,
    createdAt: r.str(16, 12),
    nomenclature: r.str(28, 32),
    scaleDenominator: r.u32(60),
    title: r.str(64, 32),
    dataState: flags & 0x3,
    realCoordsFlag: (flags >> 4) & 0x3,
    encodingFlag: (flags >> 7) & 0x3,
    textEncoding: r.u8(97),
    coordPrecision: r.u8(98),
    epsg: r.u32(100),
    cornersXY,                 // SW, NW, NE, SE — метры
    cornersGeodetic: cornersGeod, // SW, NW, NE, SE — радианы
    ellipsoid: r.u8(232),
    heightSystem: r.u8(233),
    projection: r.u8(234),
    coordSystem: r.u8(235),
    unitPlan: r.u8(236),       // 0 — метры/дискреты, 64 — радианы, 65 — градусы
    unitHeight: r.u8(237),
    frameType: r.u8(238),
    mapType: r.u8(239),
    rotationAngle: r.f64(304), // радианы, по часовой
    frameClassCode: r.u32(348),
    date: r.str(240, 12),
    // Расположение рамки на приборе (дискреты), +316, 4 пары int32 (SW, NW, NE, SE)
    deviceFrame: [0, 1, 2, 3].map(i => ({ x: r.i32(316 + i * 8), y: r.i32(316 + i * 8 + 4) })),
    deviceToMetric: null,
  };
  // Координаты в дискретах (флаг наличия реальных координат = 0): переводим аффинно
  const realFlag = (flags >> 4) & 0x3;
  const hasDeviceFrame = passport.deviceFrame.some(p => p.x !== 0 || p.y !== 0);
  if (realFlag === 0 && hasDeviceFrame) passport.deviceToMetric = buildDeviceToMetric(passport);
  return passport;
}

// ---------- дескриптор данных (Таблица 2, 52 байта) ----------
function readDescriptor(r, off) {
  if (r.u32(off) !== SIG_DAT) throw new Error('Нет дескриптора DAT по смещению ' + off);
  return {
    length: r.u32(off + 4),
    nomenclature: r.str(off + 8, 32),
    recordCount: r.u32(off + 40),
    flags: r.u32(off + 44),
  };
}

// ---------- запись объекта (Таблицы 3, 11; разделы 2.1.4 и 2.1.8) ----------
function readRecord(r, off) {
  if (r.u32(off) !== SIG_REC) throw new Error('Нет начала записи по смещению ' + off);
  const totalLen = r.u32(off + 4);     // с заголовком
  const metricLen = r.u32(off + 8);    // метрика (+ подписи, графика, вектор); без семантики
  const classCode = r.u32(off + 12);
  const objNumber = r.u32(off + 16);
  const groupIdx = r.u16(off + 20);    // номер в группе
  const groupNum = r.u16(off + 22);    // номер группы

  // Справочные данные (3 байта): см. Таблицу 3
  // ВНИМАНИЕ: в спецификации +20..+22 — это 3 байта «справочных данных»,
  // но номер в группе/группа идут по +16..+19 (по Таблице 3: 4 байта
  // «собственный номер», из которых 2 байта — номер в группе и 2 — номер группы).
  // Поэтому здесь по +16 — номер объекта целиком; группа используется ниже.
  const b0 = r.u8(off + 20), b1 = r.u8(off + 21), b2 = r.u8(off + 22);
  const loc = b0 & 0x0F;               // характер локализации
  const dim4 = (b0 >> 6) & 1;          // 1 — координата 4D (после высоты 8 байт)
  const dim4Int = (b0 >> 7) & 1;       // 1 — формат 4-го измерения int64
  const hasSemantic = b1 & 1;          // наличие семантики (прим. 2)
  const elemFloat = (b1 >> 1) & 1;     // тип элемента метрики: 1 — float
  const elemWide = (b1 >> 2) & 1;      // размер элемента: 1 — 4/8 байт, 0 — 2 байта (int)
  const unicodeText = (b1 >> 4) & 1;   // текст подписи в UTF-16
  const hasGraphic = b2 & 1;           // наличие графики
  const dim3 = (b2 >> 1) & 1;          // размерность 3D

  // Уровень генерализации (+23): нижняя граница 4 бита, верхняя 15 - N2
  const genLevel = r.u8(off + 23);
  const visibleMin = genLevel & 0x0F;
  const visibleMax = 15 - ((genLevel >> 4) & 0x0F);

  // Число точек для больших объектов (+24) и описатель метрики (+28)
  const bigPointCount = r.u32(off + 24);
  const numSub = r.u16(off + 28);
  let numPts = r.u16(off + 30);
  if (numPts === 0xFFFF) numPts = bigPointCount;

  // Размер элемента координаты. Флаги b1/b2 не однозначно соответствуют прим. 3/4 таблицы,
  // поэтому размер точки выводим из самой метрики: без подобъектов и подписи
  // metricLen = numPts * pointBytes. Далее — int/float и размер по pointBytes.
  const spatial = dim3 ? 3 : 2;                  // X, Y[, H]
  const pointBytesByFlags = spatial * (elemFloat ? (elemWide ? 8 : 4) : (elemWide ? 4 : 2)) + (dim4 ? 8 : 0);
  // Вывод размера точки из длины метрики. Формула из проверки на файлах:
  //   metricLen = (numPts + Σm) * pointBytes + numSub * 4,
  // где Σm — сумма точек подобъектов. Для текста подписи метрика содержит хвост — там
  // этот вывод не применяем.
  // Размер точки по формуле: body = metricLen - 4*numSub = (numPts + Σm) * pointBytes.
  // Берём первый кандидат, который делит body и даёт не меньше numPts точек.
  let pointBytes = null;
  const textLoc = loc === 3 || loc === 5;
  if (!textLoc && numPts > 0) {
    const body = metricLen - numSub * 4;
    for (const cand of [16, 24, 8, 12, 4, 32]) {
      if (body % cand === 0 && body / cand >= numPts) { pointBytes = cand; break; }
    }
  }
  if (pointBytes === null && textLoc && numPts > 0 && numPts * 16 <= metricLen) pointBytes = 16;
  if (pointBytes === null) pointBytes = pointBytesByFlags;
  // Размер одного элемента (X/Y/H) внутри точки
  const elem = (pointBytes - (dim4 ? 8 : 0)) / spatial;
  // Координаты в этих файлах — float64 (элемент 8 байт) или float32 (4 байта, при наличии флага float).
  const elemIsFloatEff = elem === 8 || (elemFloat && elem === 4);

  const readPt = (pos) => {
    const pt = [];
    for (let k = 0; k < spatial; k++) {
      const o = pos + k * elem;
      if (elemIsFloatEff) pt.push(elem === 8 ? r.f64(o) : r.f32(o));
      else pt.push(elem === 4 ? r.i32(o) : elem === 2 ? r.i16(o) : r.i32(o));
    }
    if (dim4) pt.push(dim4Int ? r.i64(pos + spatial * elem) : r.f64(pos + spatial * elem));
    return pt;
  };

  const metric = { parts: [], text: null };
  let p = off + 32;
  const metricEnd = off + 32 + metricLen;

  // Блок подписи (для loc 3/5, раздел 2.1.4): после точек — длина (1 байт), текст, нулевой байт.
  // Для подобъектов подписи перед каждым блоком стоят N1 N2 (4 байта), далее точки и свой блок текста.
  const readLabelText = () => {
    if (p >= metricEnd) return null;
    const tl = r.u8(p);
    const bytes = r.bytes(p + 1, Math.min(tl, Math.max(0, metricEnd - p - 1)));
    const txt = unicodeText ? decodeUtf16(bytes) : decodeAnsi(bytes);
    p += 1 + tl + 1;                    // длина + текст + ноль
    return txt;
  };
  const isLabel = loc === 3 || loc === 5;

  // Главная часть метрики
  const mainPts = [];
  for (let i = 0; i < numPts; i++) { mainPts.push(readPt(p)); p += pointBytes; }
  metric.parts.push(mainPts);
  if (isLabel) metric.text = readLabelText();

  // Подобъекты: перед каждым служебное поле (N1 — старшая часть, N2 — число точек)
  for (let s = 0; s < numSub && p + 4 <= metricEnd; s++) {
    const n1 = r.u16(p), n2 = r.u16(p + 2);
    p += 4;
    const m = n2 + (n1 << 16);
    const pts = [];
    for (let i = 0; i < m; i++) { pts.push(readPt(p)); p += pointBytes; }
    metric.parts.push(pts);
    if (isLabel) readLabelText();
  }

  // Семантика — сразу за метрикой (Таблица 11)
  // Семантика: блоки «код(2) | длина(2) | значение(длина)» — проверено на файлах: блок
  // занимает 4 + длина байт. Значение трактуем как ANSI-строку, если оно похоже на текст,
  // иначе как целое (LE) длиной 1/2/4 байта. Блок, не укладывающийся в запись, останавливает
  // разбор семантики этого объекта (сырой остаток сохраняется в _semanticRaw).
  const semantic = {};
  let sp = metricEnd;
  const recEnd = off + totalLen;
  let semanticBroken = false;
  while (sp + 4 <= recEnd) {
    const code = r.u16(sp);
    const len = r.u16(sp + 2);
    if (len <= 0 || sp + 4 + len > recEnd) { semanticBroken = true; break; }
    const val = r.bytes(sp + 4, len);
    semantic[code] = interpretSemanticValue(val);
    sp += 4 + len;
  }
  const semanticRaw = semanticBroken ? Array.from(r.bytes(sp, recEnd - sp)) : undefined;

  return {
    number: objNumber,
    classCode,
    locKind: LOC[loc] || String(loc),
    group: groupNum,
    groupIndex: groupIdx,
    visibility: [visibleMin, visibleMax],
    metric,
    semantic,
    semanticRaw,
    graphic: !!hasGraphic,
    _len: totalLen,
  };
}

// ---------- публичный разбор файла ----------
function parse(arrayBuffer) {
  const r = new Reader(arrayBuffer);
  const passport = readPassport(r);
  const descriptor = readDescriptor(r, PASSPORT_LEN);
  const objects = [];
  let off = PASSPORT_LEN + descriptor.length;
  while (off + 8 <= r.len) {
    const sig = r.u32(off);
    if (sig === SIG_REC) {
      const rec = readRecord(r, off);
      objects.push(rec);
      off += rec._len;
    } else if (sig === SIG_GRAPH || sig === SIG_VEC3D) {
      off += r.u32(off + 4);
    } else {
      break; // конец данных / служебный хвост
    }
  }
  return { passport, descriptor, objects };
}

// ---------- перевод из условной системы (дискреты прибора) в реальные координаты ----------
// Спецификация (паспорт, прим. 2): при «Флаг наличия реальных координат» = 00 вся метрика
// записана в дискретах прибора; расположение рамки на приборе (+316) и углы листа в метрах (+104)
// задают аффинное соответствие. Строим его методом наименьших квадратов по 4 углам.
function buildDeviceToMetric(passport) {
  const dev = passport.deviceFrame;
  const met = passport.cornersXY;
  if (!dev || dev.length < 4 || !met || met.length < 4) return null;
  // Соответствия: угол k: (dev.x,dev.y) -> (met.x, met.y)   (X = север, Y = восток)
  // Решаем X' = a*dx + b*dy + c ; Y' = d*dx + e*dy + f
  const solve = (rhsKey) => {
    // нормальные уравнения для [dx, dy, 1]
    let S = [[0,0,0],[0,0,0],[0,0,0]], T = [0,0,0];
    for (let k = 0; k < 4; k++) {
      const v = [dev[k].x, dev[k].y, 1];
      const t = met[k][rhsKey];
      for (let i = 0; i < 3; i++) { T[i] += v[i] * t; for (let j = 0; j < 3; j++) S[i][j] += v[i] * v[j]; }
    }
    return gauss3(S, T);
  };
  const cx = solve('x'), cy = solve('y');
  if (!cx || !cy) return null;
  return (dx, dy) => [cx[0] * dx + cx[1] * dy + cx[2], cy[0] * dx + cy[1] * dy + cy[2]];
}

function gauss3(A, b) {
  const M = A.map((row, i) => [...row, b[i]]);
  for (let c = 0; c < 3; c++) {
    let piv = c;
    for (let r = c + 1; r < 3; r++) if (Math.abs(M[r][c]) > Math.abs(M[piv][c])) piv = r;
    [M[c], M[piv]] = [M[piv], M[c]];
    if (Math.abs(M[c][c]) < 1e-12) return null;
    for (let r = 0; r < 3; r++) {
      if (r === c) continue;
      const f = M[r][c] / M[c][c];
      for (let k = c; k < 4; k++) M[r][k] -= f * M[c][k];
    }
  }
  return [M[0][3] / M[0][0], M[1][3] / M[1][1], M[2][3] / M[2][2]];
}

// ---------- геометрия ----------
function toPosition(pt, passport, projector) {
  if (passport.deviceToMetric) {
    const [xm, ym] = passport.deviceToMetric(pt[0], pt[1]);
    pt = [xm, ym].concat(pt.slice(2));
  }
  if (projector) return projector(pt[0], pt[1], pt[2]);
  // Геодезические (радианы/градусы): X=B (широта), Y=L (долгота) -> [lon, lat]
  if (passport.unitPlan === 64) return [pt[1] * 180 / Math.PI, pt[0] * 180 / Math.PI];
  if (passport.unitPlan === 65) return [pt[1], pt[0]];
  // Прямоугольные (метры SXF): X=север, Y=восток -> [x=восток, y=север]
  return [pt[1], pt[0]];
}

function closeRing(ring) {
  if (ring.length < 2) return ring;
  const a = ring[0], b = ring[ring.length - 1];
  return (a[0] === b[0] && a[1] === b[1]) ? ring : ring.concat([a]);
}

function buildGeometry(obj, passport, projector) {
  const parts = obj.metric.parts
    .map(pts => pts.map(pt => toPosition(pt, passport, projector)))
    .filter(p => p.length > 0);
  if (parts.length === 0) return null;

  switch (obj.locKind) {
    case 'DOT':
      return { type: 'Point', coordinates: parts[0][0] };
    case 'SQR':
      return { type: 'Polygon', coordinates: parts.map(closeRing) };
    case 'LIN': case 'VEC': case 'TIT': case 'PAT':
      if (parts.length === 1) return { type: 'LineString', coordinates: parts[0] };
      return { type: 'MultiLineString', coordinates: parts };
    default:
      return { type: 'LineString', coordinates: parts[0] };
  }
}

// Классификатор (rsc.cjs) — опционален: без него выводятся только числовые коды.
function toGeoJSON(arrayBuffer, opts = {}) {
  const doc = parse(arrayBuffer);
  const cls = opts.classifier || null;          // результат parseRsc(...)
  const features = [];
  for (const obj of doc.objects) {
    const geometry = buildGeometry(obj, doc.passport, opts.projector);
    if (!geometry) continue;
    const entry = cls ? cls.objectByCode.get(obj.classCode) : null;
    const properties = {
      classCode: obj.classCode,
      name: entry ? entry.name : null,
      shortName: entry ? entry.shortName : null,
      layer: entry ? (cls.layers.find(l => l.number === entry.layer) || { name: entry.layer }).name : null,
      locKind: obj.locKind,
      number: obj.number,
      group: obj.group,
      visibility: obj.visibility,
    };
    if (obj.metric.text != null) properties.text = obj.metric.text;
    if (opts.includeSemantics !== false) properties.semantic = obj.semantic;
    // Стиль по умолчанию из классификатора — отдельным полем (колонкой) style
    if (entry && entry.style) properties.style = entry.style;
    features.push({ type: 'Feature', properties, geometry });
  }
  const fc = {
    type: 'FeatureCollection',
    properties: { passport: doc.passport, descriptor: doc.descriptor },
    features,
  };
  if (!opts.projector) fc.crs = { type: 'name', properties: { name: 'SXF-native (not WGS84)' } };
  return fc;
}

module.exports = { parse, toGeoJSON, readPassport };
