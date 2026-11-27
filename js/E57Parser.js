/**
 * E57Parser вЂ” СЂР°Р·Р±РѕСЂ С„Р°Р№Р»РѕРІ ASTM E57 (E2807) РІ Р±СЂР°СѓР·РµСЂРµ Рё Node.
 *
 * Р­С‚РѕС‚ РјРѕРґСѓР»СЊ РѕС‚РІРµС‡Р°РµС‚ Р·Р° СЂР°Р·Р±РѕСЂ Р·Р°РіРѕР»РѕРІРєР° С„Р°Р№Р»Р° Рё XML-РґРµСЃРєСЂРёРїС‚РѕСЂР°:
 * CRS, pose СЃРєР°РЅРµСЂР°, СЃС…РµРјР° РїРѕР»РµР№ С‚РѕС‡РµРє Рё РіСЂР°РЅРёС†С‹. Р”РµРєРѕРґРёСЂРѕРІР°РЅРёРµ СЃС‚СЂР°РЅРёС†
 * СЃ С‚РѕС‡РєР°РјРё РґРѕР±Р°РІР»СЏРµС‚СЃСЏ РѕС‚РґРµР»СЊРЅРѕ (СЃРј. decodePoints).
 *
 * Р¤РѕСЂРјР°С‚: 48-Р±Р°Р№С‚РЅС‹Р№ Р·Р°РіРѕР»РѕРІРѕРє В«ASTM-E57В», РґР°Р»РµРµ СЃС‚СЂР°РЅРёС†С‹ РїРѕ pageSize Р±Р°Р№С‚
 * (Сѓ РєР°Р¶РґРѕР№ СЃС‚СЂР°РЅРёС†С‹ 4 Р±Р°Р№С‚Р° CRC РІ РєРѕРЅС†Рµ). XML-РґРµСЃРєСЂРёРїС‚РѕСЂ Р»РµР¶РёС‚ РїРѕ
 * СЃРјРµС‰РµРЅРёСЋ xmlPhysicalOffset РІ С‚РµС… Р¶Рµ СЃС‚СЂР°РЅРёС†Р°С….
 *
 * @module E57Parser
 */
export class E57FormatError extends Error {
    constructor(message) {
        super(message);
        this.name = 'E57FormatError';
    }
}
const SIGNATURE = 'ASTM-E57';
const HEADER_SIZE = 48;
/** Р§РёС‚Р°РµС‚ СЃС‚СЂРѕРєСѓ ASCII РёР· Р±СѓС„РµСЂР°. */
function readAscii(bytes, off, len) {
    let s = '';
    for (let i = 0; i < len; i++)
        s += String.fromCharCode(bytes[off + i]);
    return s;
}
/**
 * Р§РёС‚Р°РµС‚ XML-РґРµСЃРєСЂРёРїС‚РѕСЂ. РћРЅ РјРѕР¶РµС‚ Р»РµР¶Р°С‚СЊ РІ РЅРµСЃРєРѕР»СЊРєРёС… СЃС‚СЂР°РЅРёС†Р°С…, РєР°Р¶РґР°СЏ СЃРѕ СЃРІРѕРёРј
 * CRC; РїРѕР»РµР·РЅР°СЏ РЅР°РіСЂСѓР·РєР° СЃС‚СЂР°РЅРёС†С‹ вЂ” pageSize в€’ 4 Р±Р°Р№С‚Р°.
 */
export function readXmlSection(buffer, offset, length, pageSize) {
    const bytes = new Uint8Array(buffer);
    const payload = pageSize - 4;
    const out = new Uint8Array(length);
    let written = 0;
    // Идём по физическим адресам. Внутри страницы полезны первые payload байт,
    // далее идёт CRC (4 байта). Начало XML может быть внутри страницы.
    let physical = offset;
    while (written < length) {
        const inPage = physical % pageSize;
        if (inPage >= payload) {
            physical += pageSize - inPage;
            continue;
        }
        const take = Math.min(payload - inPage, length - written);
        if (physical + take > bytes.length)
            throw new E57FormatError('XML-секция выходит за пределы файла');
        out.set(bytes.subarray(physical, physical + take), written);
        written += take;
        physical += take;
        if (written < length && physical % pageSize >= payload)
            physical += pageSize - (physical % pageSize);
    }
    return new TextDecoder('utf-8').decode(out);
}
/** РР·РІР»РµРєР°РµС‚ Р·РЅР°С‡РµРЅРёРµ СЌР»РµРјРµРЅС‚Р° РїРѕ РёРјРµРЅРё (РїРµСЂРІРѕРµ РІС…РѕР¶РґРµРЅРёРµ). */
function xmlText(xml, tag) {
    const re = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`);
    const m = xml.match(re);
    if (!m)
        return null;
    return m[1].replace(/<!\[CDATA\[([\s\S]*?)\]\]>/, '$1').trim();
}
/** РР·РІР»РµРєР°РµС‚ РІСЃРµ Р±Р»РѕРєРё СЌР»РµРјРµРЅС‚Р° (РЅР°РїСЂРёРјРµСЂ, РІСЃРµ <vectorChild>). */
function xmlBlocks(xml, tag) {
    const re = new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)</${tag}>`, 'g');
    const out = [];
    let m;
    while ((m = re.exec(xml)))
        out.push(m[1]);
    return out;
}
/**
 * Р Р°СЃРїРѕР·РЅР°С‘С‚ EPSG-РєРѕРґ РІ WKT РёР· coordinateMetadata. Р’ WKT EPSG РѕР±С‹С‡РЅРѕ СѓРєР°Р·Р°РЅ
 * РїРѕСЃР»РµРґРЅРёРј AUTHORITY["EPSG","nnnn"] Сѓ РєРѕСЂРЅРµРІРѕРіРѕ РѕР±СЉРµРєС‚Р° (GEOCCS/PROJCS/GEOGCS).
 * Р’РѕР·РІСЂР°С‰Р°РµС‚ 'EPSG:nnnn' РёР»Рё null, РµСЃР»Рё РєРѕРґ РЅРµ РЅР°Р№РґРµРЅ.
 */
export function epsgFromWKT(wkt) {
    if (!wkt)
        return null;
    // Р‘РµСЂС‘Рј РїРѕСЃР»РµРґРЅРёР№ AUTHORITY вЂ” Сѓ РєРѕСЂРЅРµРІРѕРіРѕ РѕР±СЉРµРєС‚Р° РѕРЅ РёРґС‘С‚ РІ РєРѕРЅС†Рµ.
    const all = [...wkt.matchAll(/AUTHORITY\["EPSG","(\d+)"\]/g)];
    if (!all.length)
        return null;
    return `EPSG:${all[all.length - 1][1]}`;
}
/** Р§РёСЃР»Р° РёР· СЌР»РµРјРµРЅС‚Р° СЃ С‚РёРїРѕРј Float/Integer/ScaledInteger. */
function num(s) {
    if (s === null)
        return undefined;
    const v = Number(s);
    return Number.isFinite(v) ? v : undefined;
}
/** РЎС…РµРјР° РїРѕР»РµР№ РїСЂРѕС‚РѕС‚РёРїР°: РєР°Р¶РґС‹Р№ РґРѕС‡РµСЂРЅРёР№ СЌР»РµРјРµРЅС‚ <prototype> вЂ” РїРѕР»Рµ. */
function parsePrototype(block) {
    const proto = xmlBlocks(block, 'prototype')[0];
    if (!proto)
        return [];
    const fields = [];
    // РџРѕР»СЏ вЂ” СЌР»РµРјРµРЅС‚С‹ СЃ Р°С‚СЂРёР±СѓС‚РѕРј type, РЅР° РІРµСЂС…РЅРµРј СѓСЂРѕРІРЅРµ РїСЂРѕС‚РѕС‚РёРїР°.
    const re = /<([\w:]+)\s+type="(\w+)"([^>]*?)(\/>|>([\s\S]*?)<\/\1>)/g;
    let m;
    while ((m = re.exec(proto))) {
        const [, name, type, attrs] = m;
        if (type === 'Structure')
            continue;
        // Все атрибуты тега одним проходом: name="value". Устойчиво к мусору в значениях
        // (испорченный minimum не должен терять соседние scale/offset).
        const dict = {};
        for (const am of attrs.matchAll(/([\w:]+)="([^"]*)"/g))
            dict[am[1]] = am[2];
        fields.push({
            name,
            type,
            minimum: num(dict['minimum'] ?? null),
            maximum: num(dict['maximum'] ?? null),
            scale: num(dict['scale'] ?? null),
            offset: num(dict['offset'] ?? null),
        });
    }
    return fields;
}
/** РџРѕР·Р° РёР· <pose>: РєРІР°С‚РµСЂРЅРёРѕРЅ Рё РїРµСЂРµРЅРѕСЃ. */
function parsePose(block) {
    const pose = xmlBlocks(block, 'pose')[0];
    if (!pose)
        return null;
    const rot = xmlBlocks(pose, 'rotation')[0];
    const tr = xmlBlocks(pose, 'translation')[0];
    if (!rot || !tr)
        return null;
    const g = (b, k) => num(xmlText(b, k)) ?? 0;
    return {
        rotation: [g(rot, 'w'), g(rot, 'x'), g(rot, 'y'), g(rot, 'z')],
        translation: [g(tr, 'x'), g(tr, 'y'), g(tr, 'z')],
    };
}
/** Р“СЂР°РЅРёС†С‹ РІ Р»РѕРєР°Р»СЊРЅРѕР№ РЎРљ СЃРєР°РЅРµСЂР° (<cartesianBounds>). */
function parseBounds(block) {
    const cb = xmlBlocks(block, 'cartesianBounds')[0];
    if (!cb)
        return null;
    // Каждое значение читаем отдельно: испорченный yMaximum не должен обнулять
    // исправные zMinimum/zMaximum. Нечитаемое значение становится NaN.
    const g = (k) => {
        const v = num(xmlText(cb, k));
        return v === undefined ? Number.NaN : v;
    };
    return {
        min: [g('xMinimum'), g('yMinimum'), g('zMinimum')],
        max: [g('xMaximum'), g('yMaximum'), g('zMaximum')],
    };
}
/** РќР°Р±РѕСЂС‹ С‚РѕС‡РµРє вЂ” РґРѕС‡РµСЂРЅРёРµ <vectorChild> РІ <data3D>, Сѓ РєРѕС‚РѕСЂС‹С… РµСЃС‚СЊ <points>. */
function parsePointSets(xml) {
    const data3d = xmlBlocks(xml, 'data3D')[0];
    if (!data3d)
        return [];
    const out = [];
    for (const block of xmlBlocks(data3d, 'vectorChild')) {
        const pointsBlock = xmlBlocks(block, 'points')[0];
        if (!pointsBlock)
            continue;
        // РђС‚СЂРёР±СѓС‚С‹ <points> вЂ” fileOffset Рё recordCount. Р‘РµСЂС‘Рј РѕС‚РєСЂС‹РІР°СЋС‰РёР№ С‚РµРі.
        const tag = block.match(/<points\b([^>]*)>/);
        const attrs = tag ? tag[1] : '';
        const fileOffset = num(attrs.match(/fileOffset="(\d+)"/)?.[1] ?? null) ?? 0;
        const recordCount = num(attrs.match(/recordCount="(\d+)"/)?.[1] ?? null) ?? 0;
        out.push({
            name: xmlText(block, 'name') ?? '',
            recordCount,
            fileOffset,
            dataPhysicalOffset: 0,
            sectionLogicalLength: 0, // Р·Р°РїРѕР»РЅСЏРµС‚СЃСЏ РІ parseE57Header РёР· Р·Р°РіРѕР»РѕРІРєР° СЃРµРєС†РёРё
            fields: parsePrototype(pointsBlock),
            bounds: parseBounds(block),
            pose: parsePose(block),
        });
    }
    return out;
}
/**
/**
 * Декодирует точки секции CompressedVector (как libE57Format).
 *
 * Секция — последовательность пакетов данных. Пакет: заголовок 6 байт
 * (packetType, flags, packetLogicalLengthMinus1 u16, bytestreamCount u16),
 * затем bytestreamCount × u16 — длины потоков, затем сами потоки. Каждый поток —
 * один канал (cartesianX, Y, Z, ...).
 *
 * ВАЖНО: битовый поток каждого канала непрерывен МЕЖДУ пакетами. Поэтому сначала
 * собираем байты потока каждого канала по всем пакетам, затем декодируем сквозным
 * битовым счётчиком. Сброс на начало пакета даёт неверные значения.
 *
 * Значение записи: (minimum + bits) * scale + offset, где bits — упаковка
 * ceil(log2(maximum − minimum + 1)) бит, LSB-first.
 *
 * Адресация логическая: страница 1024 байта, из них 1020 полезных (CRC — 4 байта).
 */
export function decodePoints(buffer, header, set, options = {}) {
    const bytes = new Uint8Array(buffer);
    const PAGE = header.pageSize;
    const PAYLOAD = PAGE - 4;
    const dataPhysicalOffset = set.dataPhysicalOffset;
    // Логический адрес → физический (CRC страниц пропускаем).
    const phys = (logical) => {
        const page = Math.floor(logical / PAYLOAD);
        return page * PAGE + (logical - page * PAYLOAD);
    };
    const u8 = (logical) => {
        const p = phys(logical);
        if (p >= bytes.length)
            throw new E57FormatError('Данные точек выходят за пределы файла');
        return bytes[p];
    };
    const u16 = (logical) => u8(logical) | (u8(logical + 1) << 8);
    const fields = set.fields;
    // Каналы: X и Y обязательны (без них нет точек). Z может быть недоступен из-за
    // повреждённого XML — тогда используется zRange из опций, иначе канал пропускается.
    const chanFor = (name, override) => {
        const f = fields.find(x => x.name === name);
        if (!f)
            return null;
        if (f.type !== 'ScaledInteger')
            throw new E57FormatError(`Поле ${name}: нужен ScaledInteger`);
        const min = override ? override[0] : f.minimum;
        const max = override ? override[1] : f.maximum;
        if (min === undefined || max === undefined || f.scale === undefined || f.offset === undefined)
            return null;
        return {
            min,
            scale: f.scale,
            offset: f.offset,
            bits: Math.ceil(Math.log2(max - min + 1)),
            bytes: [],
        };
    };
    const cx = chanFor('cartesianX');
    const cy = chanFor('cartesianY');
    if (!cx || !cy) {
        throw new E57FormatError('Не читаются cartesianX/cartesianY (повреждён XML) — точки не декодируются');
    }
    const cz = chanFor('cartesianZ', options.zRange);
    // Цвет (colorRed/Green/Blue, Integer 0..255): потоки 3,4,5 по порядку прототипа.
    // Значение = minimum + bits (без scale/offset). Опционален: без него цвет не декодируется.
    const colorChan = (name) => {
        const f = fields.find(x => x.name === name);
        if (!f || f.minimum === undefined || f.maximum === undefined)
            return null;
        return { min: f.minimum, scale: 1, offset: 0, bits: Math.max(1, Math.ceil(Math.log2(f.maximum - f.minimum + 1))), bytes: [] };
    };
    const colR = colorChan('colorRed'), colG = colorChan('colorGreen'), colB = colorChan('colorBlue');
    const colorChans = colR && colG && colB ? [colR, colG, colB] : null;
    const chans = [cx, cy, cz, ...(colorChans ?? [null, null, null])];
    // 1. Собираем потоки каналов по всем пакетам данных.
    // Данные начинаются с логического адреса dataPhysicalOffset (с учётом страниц).
    let logical = logicalOfPhysical(dataPhysicalOffset, PAGE, PAYLOAD);
    const sectionEnd = set.sectionLogicalLength + 0; // логическая граница секции
    const sectionStartLogical = logicalOfPhysical(set.fileOffset, PAGE, PAYLOAD);
    const limit = sectionStartLogical + sectionEnd;
    let packets = 0;
    while (logical < limit) {
        const packetType = u8(logical);
        const lenMinus1 = u16(logical + 2);
        const packetLen = lenMinus1 + 1;
        if (packetLen < 4)
            throw new E57FormatError('Некорректная длина пакета');
        if (packetType === 1) { // DATA_PACKET
            packets++;
            const streamCount = u16(logical + 4);
            const lens = [];
            for (let k = 0; k < streamCount; k++)
                lens.push(u16(logical + 6 + 2 * k));
            let s = logical + 6 + 2 * streamCount;
            for (let k = 0; k < streamCount; k++) {
                const ch = k < chans.length ? chans[k] : null;
                if (ch)
                    for (let b = 0; b < lens[k]; b++)
                        ch.bytes.push(u8(s + b));
                s += lens[k];
            }
        }
        logical += packetLen;
    }
    // 2. Декодируем каждый канал сквозным битовым счётчиком.
    const n = set.recordCount;
    const out = new Float64Array(n * 3);
    for (let c = 0; c < 6; c++) {
        const ch = chans[c];
        if (c >= 3 && !options.colors)
            continue; // цвет не запрошен
        if (c >= 3 && !ch)
            continue; // цвета в файле нет
        if (!ch) {
            // Канал недоступен (Z без zRange): значение не декодируем.
            for (let r = 0; r < n; r++)
                out[r * 3 + c] = Number.NaN;
            continue;
        }
        const bytesArr = ch.bytes;
        let bitPos = 0;
        for (let r = 0; r < n; r++) {
            let v = 0;
            for (let b = 0; b < ch.bits; b++) {
                const bp = bitPos + b;
                const byte = bytesArr[bp >>> 3];
                if (byte === undefined)
                    throw new E57FormatError(`Канал ${c}: поток короче, чем записей`);
                v += ((byte >>> (bp & 7)) & 1) * 2 ** b;
            }
            bitPos += ch.bits;
            const value = (ch.min + v) * ch.scale + ch.offset;
            if (c < 3)
                out[r * 3 + c] = value;
            else
                options.colors[r * 3 + (c - 3)] = value;
        }
    }
    void packets;
    return out;
}
/** Логический адрес, соответствующий физическому (начало страницы — кратно pageSize). */
function logicalOfPhysical(physical, page, payload) {
    const pg = Math.floor(physical / page);
    return pg * payload + (physical - pg * page);
}
/**
 * Р Р°Р·Р±РёСЂР°РµС‚ Р·Р°РіРѕР»РѕРІРѕРє E57 Рё XML-РґРµСЃРєСЂРёРїС‚РѕСЂ. РќРµ С‡РёС‚Р°РµС‚ С‚РѕС‡РєРё.
 * РџСЂРѕРІРµСЂСЏРµС‚ СЃРёРіРЅР°С‚СѓСЂСѓ, РІРµСЂСЃРёСЋ Рё СЃРѕРіР»Р°СЃРѕРІР°РЅРЅРѕСЃС‚СЊ СЃРјРµС‰РµРЅРёР№.
 */
export function parseE57Header(buffer) {
    if (buffer.byteLength < HEADER_SIZE)
        throw new E57FormatError('Р¤Р°Р№Р» СЃР»РёС€РєРѕРј РјР°Р» РґР»СЏ E57');
    const bytes = new Uint8Array(buffer);
    const dv = new DataView(buffer);
    if (readAscii(bytes, 0, 8) !== SIGNATURE)
        throw new E57FormatError('РЎРёРіРЅР°С‚СѓСЂР° ASTM-E57 РЅРµ РЅР°Р№РґРµРЅР°');
    const versionMajor = dv.getUint32(8, true);
    const versionMinor = dv.getUint32(12, true);
    const fileLength = Number(dv.getBigUint64(16, true));
    const xmlPhysicalOffset = Number(dv.getBigUint64(24, true));
    const xmlLength = Number(dv.getBigUint64(32, true));
    const pageSize = Number(dv.getBigUint64(40, true));
    if (fileLength !== buffer.byteLength) {
        throw new E57FormatError(`Р”Р»РёРЅР° РІ Р·Р°РіРѕР»РѕРІРєРµ (${fileLength}) РЅРµ СЃРѕРІРїР°РґР°РµС‚ СЃ СЂР°Р·РјРµСЂРѕРј С„Р°Р№Р»Р° (${buffer.byteLength})`);
    }
    if (pageSize < 8)
        throw new E57FormatError(`РќРµРєРѕСЂСЂРµРєС‚РЅС‹Р№ СЂР°Р·РјРµСЂ СЃС‚СЂР°РЅРёС†С‹: ${pageSize}`);
    if (xmlPhysicalOffset + xmlLength > buffer.byteLength) {
        throw new E57FormatError('XML-СЃРµРєС†РёСЏ РІС‹С…РѕРґРёС‚ Р·Р° РїСЂРµРґРµР»С‹ С„Р°Р№Р»Р°');
    }
    const xml = readXmlSection(buffer, xmlPhysicalOffset, xmlLength, pageSize);
    if (!xml.includes('e57Root'))
        throw new E57FormatError('XML-РґРµСЃРєСЂРёРїС‚РѕСЂ РЅРµ РїРѕС…РѕР¶ РЅР° E57 (РЅРµС‚ e57Root)');
    const pointSets = parsePointSets(xml);
    // Р¤РёР·РёС‡РµСЃРєРѕРµ РЅР°С‡Р°Р»Рѕ РґР°РЅРЅС‹С… РєР°Р¶РґРѕР№ СЃРµРєС†РёРё вЂ” РёР· РµС‘ Р·Р°РіРѕР»РѕРІРєР° (РїРѕР»Рµ dataPhysicalOffset, +16).
    for (const s of pointSets) {
        if (s.fileOffset + 32 > buffer.byteLength)
            throw new E57FormatError('РЎРµРєС†РёСЏ С‚РѕС‡РµРє РІС‹С…РѕРґРёС‚ Р·Р° РїСЂРµРґРµР»С‹ С„Р°Р№Р»Р°');
        s.dataPhysicalOffset = Number(dv.getBigUint64(s.fileOffset + 16, true));
        s.sectionLogicalLength = Number(dv.getBigUint64(s.fileOffset + 8, true));
    }
    // CRS: coordinateMetadata вЂ” СЃС‚СЂРѕРєР° WKT (CDATA).
    const crsWKT = xmlText(xml, 'coordinateMetadata');
    const crs = epsgFromWKT(crsWKT);
    return {
        versionMajor,
        versionMinor,
        fileLength,
        xmlPhysicalOffset,
        xmlLength,
        pageSize,
        crs,
        crsWKT,
        pointSets,
    };
}
/**
 * Переводит точки из локальной СК сканера в глобальную по pose секции:
 * v' = q·v·q⁻¹ + t (кватернион w,x,y,z). Для единичного pose (Д2, Д3) — без изменений.
 */
export function applyPose(points, pose) {
    if (!pose)
        return points;
    const [w, x, y, z] = pose.rotation;
    const [tx, ty, tz] = pose.translation;
    const identity = w === 1 && x === 0 && y === 0 && z === 0 && tx === 0 && ty === 0 && tz === 0;
    if (identity)
        return points;
    const out = new Float64Array(points.length);
    for (let i = 0; i < points.length; i += 3) {
        const vx = points[i], vy = points[i + 1], vz = points[i + 2];
        // v + 2w(u×v) + 2u×(u×v), u = (x,y,z)
        const cx = y * vz - z * vy, cy = z * vx - x * vz, cz = x * vy - y * vx;
        const ccx = y * cz - z * cy, ccy = z * cx - x * cz, ccz = x * cy - y * cx;
        out[i] = vx + 2 * w * cx + 2 * ccx + tx;
        out[i + 1] = vy + 2 * w * cy + 2 * ccy + ty;
        out[i + 2] = vz + 2 * w * cz + 2 * ccz + tz;
    }
    return out;
}
