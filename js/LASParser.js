/**
 * LASParser — разбор несжатых LAS-файлов (форматы записи 0–3, 6–8, LAS 1.0–1.4).
 *
 * Логика взята из las-viewer (Rodosto): заголовок, масштабы/смещения,
 * классификация, RGB. Координаты возвращаются в той СК, в которой записаны
 * в файле — LAS её не хранит, поэтому интерпретацию задаёт вызывающий код
 * (опция `crs` модуля LAS).
 *
 * LAZ (сжатый) не поддерживается.
 *
 * @module LASParser
 */
export class LASFormatError extends Error {
    isLAZ;
    constructor(message, isLAZ = false) {
        super(message);
        this.isLAZ = isLAZ;
        this.name = 'LASFormatError';
    }
}
const SUPPORTED_FORMATS = [0, 1, 2, 3, 6, 7, 8];
/** Читает только заголовок (без точек). */
export function readLASHeader(buffer) {
    const dv = new DataView(buffer);
    const bytes = buffer.byteLength;
    if (bytes < 227)
        throw new LASFormatError('Файл слишком мал или не является LAS');
    if (dv.getUint8(0) !== 0x4c || dv.getUint8(1) !== 0x41 || dv.getUint8(2) !== 0x53 || dv.getUint8(3) !== 0x46) {
        throw new LASFormatError('Сигнатура LASF не найдена');
    }
    const versionMinor = dv.getUint8(25);
    const offToPts = dv.getUint32(96, true);
    let pointFormat = dv.getUint8(104);
    const compressed = (pointFormat & 0x80) !== 0;
    pointFormat &= 0x3f;
    const recordLength = dv.getUint16(105, true);
    let total = dv.getUint32(107, true);
    if (versionMinor >= 4 && total === 0)
        total = Number(dv.getBigUint64(247, true));
    if (compressed)
        throw new LASFormatError('LAZ (сжатые файлы) пока не поддерживается, сконвертируйте в LAS', true);
    if (!SUPPORTED_FORMATS.includes(pointFormat))
        throw new LASFormatError(`Неподдерживаемый формат записи точек: ${pointFormat}`);
    if (!recordLength || !offToPts)
        throw new LASFormatError('Некорректный заголовок LAS');
    // Не больше точек, которые реально помещаются в файл.
    const maxFit = Math.floor((bytes - offToPts) / recordLength);
    if (total <= 0 || total > maxFit)
        total = maxFit;
    if (total <= 0)
        throw new LASFormatError('В файле нет точек');
    const scale = [
        dv.getFloat64(131, true), dv.getFloat64(139, true), dv.getFloat64(147, true),
    ];
    const offset = [
        dv.getFloat64(155, true), dv.getFloat64(163, true), dv.getFloat64(171, true),
    ];
    const bbox = [
        [dv.getFloat64(187, true), dv.getFloat64(203, true), dv.getFloat64(219, true)],
        [dv.getFloat64(179, true), dv.getFloat64(195, true), dv.getFloat64(211, true)],
    ];
    return {
        versionMinor,
        pointFormat,
        recordLength,
        total,
        scale,
        offset,
        bbox,
        hasColor: pointFormat === 2 || pointFormat === 3 || pointFormat === 7 || pointFormat === 8,
    };
}
/** Полный разбор: заголовок и точки. */
export function parseLAS(buffer, options = {}) {
    const header = readLASHeader(buffer);
    const dv = new DataView(buffer);
    const { pointFormat, recordLength, total, scale, offset, hasColor } = header;
    const offToPts = dv.getUint32(96, true);
    const clsOff = pointFormat <= 5 ? 15 : 16;
    const clsMask = pointFormat <= 5 ? 0x1f : 0xff;
    const rgbOff = pointFormat === 2 ? 20 : pointFormat === 3 ? 28 : (pointFormat === 7 || pointFormat === 8) ? 30 : -1;
    // Прореживание равномерным шагом, если точек больше maxPoints.
    const maxPoints = options.maxPoints ?? Infinity;
    const stride = Math.max(1, Math.ceil(total / maxPoints));
    const count = Math.floor(total / stride) || total;
    const positions = new Float64Array(count * 3);
    const intensity = new Uint16Array(count);
    const classification = new Uint8Array(count);
    const colorRaw = hasColor ? new Uint16Array(count * 3) : null;
    let colMax = 0;
    for (let i = 0, j = 0; i < count; i++, j += stride) {
        const p = offToPts + j * recordLength;
        positions[i * 3] = dv.getInt32(p, true) * scale[0] + offset[0];
        positions[i * 3 + 1] = dv.getInt32(p + 4, true) * scale[1] + offset[1];
        positions[i * 3 + 2] = dv.getInt32(p + 8, true) * scale[2] + offset[2];
        intensity[i] = dv.getUint16(p + 12, true);
        classification[i] = dv.getUint8(p + clsOff) & clsMask;
        if (colorRaw && rgbOff >= 0) {
            const r = dv.getUint16(p + rgbOff, true);
            const g = dv.getUint16(p + rgbOff + 2, true);
            const b = dv.getUint16(p + rgbOff + 4, true);
            colorRaw[i * 3] = r;
            colorRaw[i * 3 + 1] = g;
            colorRaw[i * 3 + 2] = b;
            if (r > colMax)
                colMax = r;
            if (g > colMax)
                colMax = g;
            if (b > colMax)
                colMax = b;
        }
    }
    let color = null;
    if (colorRaw && colMax > 0) {
        // 16-битные цвета (стандарт) или 8-битные (встречаются).
        const div = colMax > 255 ? 65535 : 255;
        color = new Float32Array(count * 3);
        for (let k = 0; k < color.length; k++)
            color[k] = colorRaw[k] / div;
    }
    return { header, count, positions, intensity, classification, color };
}
