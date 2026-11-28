// sxfParser.ts — декодер бинарного SXF (ПАРБ.00046-06 99 02, редакция 4.0)
// Перенесён из test/sxf/sxf2geojson.cjs. Без внешних зависимостей.

const SIG_FILE = 0x00465853;   // "SXF"
const SIG_DAT = 0x00544144;    // "DAT"
const SIG_REC = 0x7FFF7FFF;    // начало записи объекта
const SIG_GRAPH = 0x7FFF7FFE;  // графика
const SIG_VEC3D = 0x7FFF7FFD;  // вектор привязки 3D
const PASSPORT_LEN = 400;

const LOC = ['LIN', 'SQR', 'DOT', 'TIT', 'VEC', 'PAT'] as const;

export type SxfPt = number[];

export interface SxfCorner { x: number; y: number }
export interface SxfGeodCorner { B: number; L: number }

export interface SxfPassport {
    edition: string;
    createdAt: string;
    nomenclature: string;
    scaleDenominator: number;
    title: string;
    dataState: number;
    realCoordsFlag: number;
    encodingFlag: number;
    textEncoding: number;
    coordPrecision: number;
    epsg: number;
    cornersXY: SxfCorner[];
    cornersGeodetic: SxfGeodCorner[];
    ellipsoid: number;
    heightSystem: number;
    projection: number;
    coordSystem: number;
    unitPlan: number;
    unitHeight: number;
    frameType: number;
    mapType: number;
    rotationAngle: number;
    frameClassCode: number;
    date: string;
    deviceFrame: SxfCorner[];
    /** Аффинный перевод дискрет прибора в метры (только при realCoordsFlag = 0). */
    deviceToMetric: ((dx: number, dy: number) => [number, number]) | null;
}

export interface SxfDescriptor {
    length: number;
    nomenclature: string;
    recordCount: number;
    flags: number;
}

export interface SxfObject {
    number: number;
    classCode: number;
    locKind: string;
    group: number;
    groupIndex: number;
    visibility: [number, number];
    metric: { parts: SxfPt[][]; text: string | null };
    semantic: Record<number, unknown>;
    semanticRaw?: number[];
    graphic: boolean;
    /** Длина записи с заголовком (служебное, для обхода файла). */
    _len: number;
}

export interface SxfDocument {
    passport: SxfPassport;
    descriptor: SxfDescriptor;
    objects: SxfObject[];
}

// ---------- низкоуровневое чтение (little-endian) ----------
class Reader {
    readonly dv: DataView;
    readonly len: number;
    constructor(readonly buf: ArrayBuffer) {
        this.dv = new DataView(buf);
        this.len = buf.byteLength;
    }
    u8(o: number) { return this.dv.getUint8(o); }
    i8(o: number) { return this.dv.getInt8(o); }
    u16(o: number) { return this.dv.getUint16(o, true); }
    i16(o: number) { return this.dv.getInt16(o, true); }
    u32(o: number) { return this.dv.getUint32(o, true); }
    i32(o: number) { return this.dv.getInt32(o, true); }
    i64(o: number) { return Number(this.dv.getBigInt64(o, true)); }
    f32(o: number) { return this.dv.getFloat32(o, true); }
    f64(o: number) { return this.dv.getFloat64(o, true); }
    bytes(o: number, n: number): Uint8Array {
        return new Uint8Array(this.buf, o, Math.max(0, Math.min(n, this.len - o)));
    }
    str(o: number, n: number): string {
        const b = this.bytes(o, n);
        let end = b.indexOf(0);
        if (end < 0) end = b.length;
        return decodeAnsi(b.subarray(0, end));
    }
}

// ANSI = Windows-1251 (спецификация: символьные поля в формате ANSI)
const CP1251_HI =
    'ЂЃ‚ѓ„…†‡€‰Љ‹ЊЌЋЏђ‘’“”•–—˜™љ›њќћџ ЎўЈ¤Ґ¦§Ё©Є«¬\u00AD®Ї°±Ііґµ¶·ё№є»јЅѕї' +
    'АБВГДЕЖЗИЙКЛМНОПРСТУФХЦЧШЩЪЫЬЭЮЯабвгдежзийклмнопрстуфхцчшщъыьэюя';

export function decodeAnsi(bytes: Uint8Array): string {
    let s = '';
    for (let i = 0; i < bytes.length; i++) {
        const c = bytes[i];
        s += c < 0x80 ? String.fromCharCode(c) : (CP1251_HI[c - 0x80] || '?');
    }
    return s.trim();
}

function decodeUtf16(bytes: Uint8Array): string {
    return new TextDecoder('utf-16le').decode(bytes).replace(/\0+$/, '');
}

// ---------- паспорт (Таблица 1, 400 байт) ----------
function readPassport(r: Reader): SxfPassport {
    if (r.len < PASSPORT_LEN) throw new Error('SXF: файл короче паспорта');
    if (r.u32(0) !== SIG_FILE) throw new Error('SXF: нет сигнатуры SXF');
    const passLen = r.u32(4);
    if (passLen !== PASSPORT_LEN) throw new Error('SXF: неожиданная длина паспорта: ' + passLen);

    const edition = r.u32(8);
    const flags = r.u32(96);
    const cornersXY = [0, 1, 2, 3].map(i => ({ x: r.f64(104 + i * 16), y: r.f64(104 + i * 16 + 8) }));
    const cornersGeodetic = [0, 1, 2, 3].map(i => ({ B: r.f64(168 + i * 16), L: r.f64(168 + i * 16 + 8) }));
    const deviceFrame = [0, 1, 2, 3].map(i => ({ x: r.i32(316 + i * 8), y: r.i32(316 + i * 8 + 4) }));

    const passport: SxfPassport = {
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
        cornersXY,
        cornersGeodetic,
        ellipsoid: r.u8(232),
        heightSystem: r.u8(233),
        projection: r.u8(234),
        coordSystem: r.u8(235),
        unitPlan: r.u8(236),
        unitHeight: r.u8(237),
        frameType: r.u8(238),
        mapType: r.u8(239),
        rotationAngle: r.f64(304),
        frameClassCode: r.u32(348),
        date: r.str(240, 12),
        deviceFrame,
        deviceToMetric: null,
    };

    // Координаты в дискретах прибора (флаг реальных координат = 0): переводим аффинно.
    const hasDeviceFrame = deviceFrame.some(p => p.x !== 0 || p.y !== 0);
    if (passport.realCoordsFlag === 0 && hasDeviceFrame) {
        passport.deviceToMetric = buildDeviceToMetric(passport);
    }
    return passport;
}

// ---------- дескриптор данных (Таблица 2, 52 байта) ----------
function readDescriptor(r: Reader, off: number): SxfDescriptor {
    if (r.u32(off) !== SIG_DAT) throw new Error('SXF: нет дескриптора DAT по смещению ' + off);
    return {
        length: r.u32(off + 4),
        nomenclature: r.str(off + 8, 32),
        recordCount: r.u32(off + 40),
        flags: r.u32(off + 44),
    };
}

// ---------- запись объекта (Таблицы 3, 11; разделы 2.1.4 и 2.1.8) ----------
function readRecord(r: Reader, off: number): SxfObject {
    if (r.u32(off) !== SIG_REC) throw new Error('SXF: нет начала записи по смещению ' + off);
    const totalLen = r.u32(off + 4);
    const metricLen = r.u32(off + 8);
    const classCode = r.u32(off + 12);
    const objNumber = r.u32(off + 16);
    const groupIdx = r.u16(off + 20);
    const groupNum = r.u16(off + 22);

    // Справочные данные (3 байта, +20..+22) — битовые поля (см. Таблицу 3)
    const b0 = r.u8(off + 20), b1 = r.u8(off + 21), b2 = r.u8(off + 22);
    const loc = b0 & 0x0F;
    const dim4 = (b0 >> 6) & 1;
    const dim4Int = (b0 >> 7) & 1;
    const hasSemantic = b1 & 1;
    const elemFloat = (b1 >> 1) & 1;
    const elemWide = (b1 >> 2) & 1;
    const unicodeText = (b1 >> 4) & 1;
    const hasGraphic = b2 & 1;
    const dim3 = (b2 >> 1) & 1;

    // Уровень генерализации (+23)
    const genLevel = r.u8(off + 23);
    const visibleMin = genLevel & 0x0F;
    const visibleMax = 15 - ((genLevel >> 4) & 0x0F);

    // Число точек для больших объектов (+24), описатель (+28)
    const bigPointCount = r.u32(off + 24);
    const numSub = r.u16(off + 28);
    let numPts = r.u16(off + 30);
    if (numPts === 0xFFFF) numPts = bigPointCount;

    const spatial = dim3 ? 3 : 2;
    const pointBytesByFlags = spatial * (elemFloat ? (elemWide ? 8 : 4) : (elemWide ? 4 : 2)) + (dim4 ? 8 : 0);

    // Размер точки выводим из длины метрики: metricLen = (numPts + Σm)*pointBytes + numSub*4
    const textLoc = loc === 3 || loc === 5;
    let pointBytes: number | null = null;
    if (!textLoc && numPts > 0) {
        const body = metricLen - numSub * 4;
        for (const cand of [16, 24, 8, 12, 4, 32]) {
            if (body % cand === 0 && body / cand >= numPts) { pointBytes = cand; break; }
        }
    }
    if (pointBytes === null && textLoc && numPts > 0 && numPts * 16 <= metricLen) pointBytes = 16;
    if (pointBytes === null) pointBytes = pointBytesByFlags;

    const elem = (pointBytes - (dim4 ? 8 : 0)) / spatial;
    const elemIsFloatEff = elem === 8 || (elemFloat === 1 && elem === 4);

    const readPt = (pos: number): SxfPt => {
        const pt: number[] = [];
        for (let k = 0; k < spatial; k++) {
            const o = pos + k * elem;
            if (elemIsFloatEff) pt.push(elem === 8 ? r.f64(o) : r.f32(o));
            else pt.push(elem === 4 ? r.i32(o) : elem === 2 ? r.i16(o) : r.i32(o));
        }
        if (dim4) pt.push(dim4Int ? r.i64(pos + spatial * elem) : r.f64(pos + spatial * elem));
        return pt;
    };

    const metric = { parts: [] as SxfPt[][], text: null as string | null };
    let p = off + 32;
    const metricEnd = off + 32 + metricLen;

    // Блок подписи: длина (1 байт), текст, нулевой байт (раздел 2.1.4)
    const readLabelText = (): string | null => {
        if (p >= metricEnd) return null;
        const tl = r.u8(p);
        const bytes = r.bytes(p + 1, Math.min(tl, Math.max(0, metricEnd - p - 1)));
        const txt = unicodeText ? decodeUtf16(bytes) : decodeAnsi(bytes);
        p += 1 + tl + 1;
        return txt;
    };

    const mainPts: SxfPt[] = [];
    for (let i = 0; i < numPts; i++) { mainPts.push(readPt(p)); p += pointBytes; }
    metric.parts.push(mainPts);
    if (textLoc) metric.text = readLabelText();

    for (let s = 0; s < numSub && p + 4 <= metricEnd; s++) {
        const n1 = r.u16(p), n2 = r.u16(p + 2);
        p += 4;
        const m = n2 + (n1 << 16);
        const pts: SxfPt[] = [];
        for (let i = 0; i < m; i++) { pts.push(readPt(p)); p += pointBytes; }
        metric.parts.push(pts);
        if (textLoc) readLabelText();
    }

    // Семантика: блоки «код(2) | длина(2) | значение(длина)» — блок занимает 4 + длина байт
    const semantic: Record<number, unknown> = {};
    let sp = metricEnd;
    const recEnd = off + totalLen;
    let semanticBroken = false;
    while (sp + 4 <= recEnd) {
        const code = r.u16(sp);
        const len = r.u16(sp + 2);
        if (len <= 0 || sp + 4 + len > recEnd) { semanticBroken = true; break; }
        semantic[code] = interpretSemanticValue(r.bytes(sp + 4, len));
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

function interpretSemanticValue(bytes: Uint8Array): unknown {
    let printable = bytes.length > 0;
    for (let i = 0; i < bytes.length && printable; i++) {
        const c = bytes[i];
        if (c === 0) continue;
        if (c < 0x20 && c !== 0x09) printable = false;
    }
    if (printable && bytes.length > 4) return decodeAnsi(bytes).replace(/\0+/g, '').trim();
    if (bytes.length === 1) return bytes[0];
    if (bytes.length === 2) return bytes[0] | (bytes[1] << 8);
    if (bytes.length === 4) return (bytes[0] | (bytes[1] << 8) | (bytes[2] << 16) | (bytes[3] << 24)) >>> 0;
    return Array.from(bytes);
}

// ---------- перевод дискрет прибора в метры (аффинное МНК по 4 углам) ----------
function buildDeviceToMetric(passport: SxfPassport): ((dx: number, dy: number) => [number, number]) | null {
    const dev = passport.deviceFrame;
    const met = passport.cornersXY;
    const solve = (key: 'x' | 'y'): [number, number, number] | null => {
        const S = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
        const T = [0, 0, 0];
        for (let k = 0; k < 4; k++) {
            const v = [dev[k].x, dev[k].y, 1];
            const t = met[k][key];
            for (let i = 0; i < 3; i++) {
                T[i] += v[i] * t;
                for (let j = 0; j < 3; j++) S[i][j] += v[i] * v[j];
            }
        }
        return gauss3(S, T);
    };
    const cx = solve('x'), cy = solve('y');
    if (!cx || !cy) return null;
    return (dx: number, dy: number): [number, number] =>
        [cx[0] * dx + cx[1] * dy + cx[2], cy[0] * dx + cy[1] * dy + cy[2]];
}

function gauss3(A: number[][], b: number[]): [number, number, number] | null {
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

/** Разбор всего SXF-файла: паспорт, дескриптор, объекты. */
export function parseSxf(buffer: ArrayBuffer): SxfDocument {
    const r = new Reader(buffer);
    const passport = readPassport(r);
    const descriptor = readDescriptor(r, PASSPORT_LEN);
    const objects: SxfObject[] = [];
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
            break;
        }
    }
    return { passport, descriptor, objects };
}
