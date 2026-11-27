/**
 * E57 — облако точек из файла ASTM E57 (E2807).
 *
 * Использует ту же схему, что KRB.LAS: источник (url / file / buffer), загрузка
 * при addTo(map), раскраска, LOD, fitOnLoad, onLoad / onError. Отличаются:
 *   - разбор (E57Parser вместо LASParser);
 *   - CRS берётся из файла (coordinateMetadata), опция crs — переопределение;
 *   - файл может быть частично читаем: если высоты (Z) не читаются из-за
 *     повреждённого XML, точки показываются по X/Y, а в warnings появляется
 *     причина. Пользователь может передать zRange вручную.
 *
 * @module E57
 */

import { LAS, type LASOptions } from './LAS.js';
import { parseE57Header, decodePoints, type E57Header, type E57PointSet, applyPose } from './E57Parser.js';
import type { LASData } from './LASParser.js';

export interface E57Options extends Omit<LASOptions, 'crs'> {
    /**
     * СК координат. По умолчанию берётся из файла (coordinateMetadata).
     * Указывайте, только если CRS в файле неверный или не распознан.
     */
    crs?: string;
    /**
     * Диапазон сырых целых для cartesianZ — [minimum, maximum] как в XML.
     * Нужен, только если в XML повреждён maximum Z: тогда высоты декодируются
     * по этому диапазону. Значения — сырые целые, а не метры.
     */
    zRange?: [number, number];
    /** Номер облака внутри файла (если файл содержит несколько наборов). По умолчанию 0. */
    pointSetIndex?: number;
}

export class E57 extends LAS {
    private _e57Header: E57Header | null = null;
    private _warnings: string[] = [];
    private _zRange: [number, number] | undefined;
    private _pointSetIndex: number;
    private _userCRS: string | undefined;

    constructor(options: E57Options) {
        // Проверка источника — как у LAS, но без обязательного crs.
        if (!options.url && !options.file && !options.buffer) {
            throw new Error('E57: укажите источник — url, file или buffer.');
        }
        // LAS требует crs в конструкторе: передаём заглушку, реальный CRS
        // придёт из файла (см. _parseBuffer → setCRS).
        super({ ...options, crs: options.crs ?? 'EPSG:4326' } as LASOptions);
        this._userCRS = options.crs;
        this._zRange = options.zRange;
        this._pointSetIndex = options.pointSetIndex ?? 0;
    }

    /**
     * Разбор E57: заголовок, XML (CRS, границы, pose), декодирование точек.
     * Возвращает LASData, поэтому остальная логика LAS (раскраска, LOD) работает как есть.
     */
    protected _parseBuffer(ab: ArrayBuffer): LASData {
        const header = parseE57Header(ab);
        this._e57Header = header;

        const set = header.pointSets[this._pointSetIndex];
        if (!set) {
            throw new Error(`E57: в файле нет набора точек с индексом ${this._pointSetIndex} (всего ${header.pointSets.length})`);
        }

        // CRS: опция пользователя важнее файла; иначе — из файла.
        const crs = this._userCRS ?? header.crs;
        if (!crs) {
            throw new Error('E57: CRS не распознан в файле. Передайте опцию crs, например EPSG:4978.');
        }
        if (this._userCRS && header.crs && this._userCRS !== header.crs) {
            this._warnings.push(`CRS из опции (${this._userCRS}) отличается от CRS файла (${header.crs})`);
        }
        this.setCRS(crs);

        const n = set.recordCount;
        const zField = set.fields.find(f => f.name === 'cartesianZ');
        const zXmlOk = !!zField && zField.minimum !== undefined && zField.maximum !== undefined
            && zField.scale !== undefined && zField.offset !== undefined;

        // Цвет: декодируем вместе с координатами, если в файле есть colorRed/Green/Blue.
        const hasColorFields = ['colorRed','colorGreen','colorBlue'].every(nm => set.fields.some(f => f.name === nm));
        const rgbRaw = hasColorFields ? new Float64Array(n * 3) : null;
        let pos: Float64Array;
        if (this._zRange || zXmlOk) {
            // Диапазон Z известен напрямую (опция или исправный XML).
            pos = decodePoints(ab, header, set, { zRange: this._zRange, colors: rgbRaw ?? undefined });
        } else {
            // XML повреждён в maximum Z. Восстанавливаем его из zMaximum (метры)
            // и принимаем результат, только если высоты попадают в [zMin, zMax] из XML.
            const recovered = recoverZRange(ab, header, set);
            if (recovered) {
                pos = decodePoints(ab, header, set, { zRange: recovered, colors: rgbRaw ?? undefined });
            } else {
                // Не угадываем: X/Y декодируются, Z остаётся NaN, пишем причину.
                pos = decodePoints(ab, header, set, { colors: rgbRaw ?? undefined });
                this._warnings.push('высоты (cartesianZ) не восстановлены: XML повреждён; передайте zRange, чтобы увидеть высоту');
            }
        }

        // Переводим из СК сканера в глобальную по pose (единичный pose — без изменений).
        pos = applyPose(pos, set.pose);

        // bbox не задаём: fitTo берёт границы у PointCloud по lon/lat точек.
        return {
            header: { total: n, bbox: computeBBox(pos, n), hasColor: !!rgbRaw },
            count: n,
            positions: pos,
            intensity: new Uint16Array(n),
            classification: new Uint8Array(n),
            color: rgbRaw ? toUnitColor(rgbRaw) : null,
        };
    }

    // =================================================================
    // Информация о файле
    // =================================================================

    /** Заголовок E57: версия, CRS, наборы точек. null до загрузки. */
    getE57Header(): E57Header | null { return this._e57Header; }

    /**
     * Предупреждения о частичной загрузке или неоднозначностях
     * (например, высоты не прочитаны, CRS переопределён опцией).
     */
    getWarnings(): string[] { return [...this._warnings]; }
}

/**
 * Восстанавливает сырой [minimum, maximum] для Z, если XML повреждён в maximum.
 * maximum = round((zMaximum − offset) / scale), minimum берётся из поля, если читается.
 * Результат принимается только если все декодированные высоты лежат в [zMin, zMax] из XML
 * (с допуском в один шаг scale). Иначе возвращает null — не угадываем.
 */
function recoverZRange(
    ab: ArrayBuffer,
    header: E57Header,
    set: E57PointSet,
): [number, number] | null {
    const zb = set.bounds;
    const zf = set.fields.find(f => f.name === 'cartesianZ');
    if (!zb || !zf || zf.scale === undefined || zf.offset === undefined) return null;
    const zMinM = zb.min[2], zMaxM = zb.max[2];
    if (!Number.isFinite(zMinM) || !Number.isFinite(zMaxM)) return null;

    const rawMax = Math.round((zMaxM - zf.offset) / zf.scale);
    const rawMin = zf.minimum !== undefined ? zf.minimum : Math.round((zMinM - zf.offset) / zf.scale);
    if (!(rawMax > rawMin)) return null;

    const probe = decodePoints(ab, header, set, { zRange: [rawMin, rawMax] });
    const tol = zf.scale;
    for (let i = 2; i < probe.length; i += 3) {
        const z = probe[i];
        if (!Number.isFinite(z) || z < zMinM - tol || z > zMaxM + tol) return null;
    }
    return [rawMin, rawMax];
}

/** Ограничивающий прямоугольник по декодированным точкам (если в XML границ нет). */
function computeBBox(pos: Float64Array, n: number): [[number, number, number], [number, number, number]] {
    const mn: [number, number, number] = [Infinity, Infinity, Infinity];
    const mx: [number, number, number] = [-Infinity, -Infinity, -Infinity];
    for (let i = 0; i < n; i++) {
        for (let k = 0; k < 3; k++) {
            const v = pos[i * 3 + k];
            if (!Number.isFinite(v)) continue;
            if (v < mn[k]) mn[k] = v;
            if (v > mx[k]) mx[k] = v;
        }
    }
    return [mn, mx];
}

/** RGB 0..255 (E57 Integer) → 0..1, как ожидает LAS-раскраска. */
function toUnitColor(raw: Float64Array): Float32Array {
    const out = new Float32Array(raw.length);
    for (let i = 0; i < raw.length; i++) out[i] = raw[i] / 255;
    return out;
}
