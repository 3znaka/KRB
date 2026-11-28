// sxfWorker.ts — фоновая обработка листа SXF: парсинг, классификатор, перевод координат,
// триангуляция заливок. Главный поток получает готовые typed-массивы (передача без копирования).
//
// Протокол:
//   → { type: 'build', id, sheet: ArrayBuffer, classifier?: ArrayBuffer, transform: [a,b,c,d,e,f] }
//   ← { type: 'built', id, fills, lines, points, texts }   (массивы передаются через transferList)
//
// transform — аффинное преобразование (дискреты/метры листа → мировые координаты карты),
// вычисленное главным потоком по 4 углам листа через map.project. Для линейной области листа
// это точно в пределах долей пикселя.

import { parseSxf, type SxfDocument, type SxfObject } from './sxfParser.js';
import { parseRsc, type RscClassifier } from './rscParser.js';
import { poiFor } from './sxfPoi.js';
import earcut from '../js_TP/earcut.js';

export interface SxfTransform { a: number; b: number; c: number; d: number; e: number; f: number }

/** Конфиг стилей, который главный поток передаёт в воркер (по classCode). */
export interface SxfStyleMap {
    /** Стиль по classCode: цвета в #rrggbb, толщина в пикселях, пунктир [штрих, пробел]. */
    [classCode: number]: { fill?: string; stroke?: string; line?: string; width?: number; dash?: number[] };
}

export interface SxfBuildRequest {
    type: 'build';
    id: number;
    sheet: ArrayBuffer;
    classifier?: ArrayBuffer;
    transform: SxfTransform;
    /** Стили по classCode, уже свёрнутые главным потоком (слой + код). */
    styles: SxfStyleMap;
    /** Стиль по умолчанию для объектов без записи в styles. */
    defaultStyle: { fill?: string; stroke?: string; line?: string; width?: number; dash?: number[] };
    /** Строить подписи/POI. */
    poi: boolean;
    /** Белый список слоёв классификатора (имена слоёв). null — все. */
    includeLayers?: string[] | null;
    /** Чёрный список слоёв классификатора. */
    excludeLayers?: string[] | null;
}

export interface FillBatch {
    /** Цвет заливки (rgb как число), прозрачность — на стороне главного потока. */
    color: string;
    /** Порядок отображения слоя (Таблица 11): меньший — рисуется раньше (ниже). */
    order: number;
    positions: Float32Array;   // x,y,z,... (y = 0)
    indices: Uint32Array;
}

export interface LineBatch {
    color: string;
    /** Порядок отображения слоя (Таблица 11): меньший — рисуется раньше (ниже). */
    order: number;
    width: number;
    dash: number[] | null;
    /** Отрезки парами: ax,ay,az,bx,by,bz — для LineSegmentsGeometry. */
    segments: Float32Array;
}

export interface PointItem {
    x: number;
    z: number;
    icon: string;
    label: string;
    color: string;
    /** Код классификатора — по нему на главном потоке берётся векторный знак. */
    classCode: number;
}

export interface SxfBuildResult {
    type: 'built';
    id: number;
    fills: FillBatch[];
    lines: LineBatch[];
    points: PointItem[];
    /** Сколько объектов обработано всего (для статистики). */
    count: number;
}

// ---------- преобразование координат ----------
function applyTransform(t: SxfTransform, x: number, y: number): [number, number] {
    // Точка листа: x = север, y = восток. Проекция ожидает [восток, север], поэтому меняем оси.
    const east = y, north = x;
    return [t.a * east + t.b * north + t.c, t.d * east + t.e * north + t.f];
}

/** Перевод точки листа: дискреты прибора (если есть преобразование) не учитываем — оно уже в transform. */
function toWorld(t: SxfTransform, doc: SxfDocument, pt: number[]): [number, number] {
    let x = pt[0], y = pt[1];
    if (doc.passport.deviceToMetric) [x, y] = doc.passport.deviceToMetric(x, y);
    return applyTransform(t, x, y);
}

// ---------- сборка ----------
export function buildSheet(req: SxfBuildRequest): SxfBuildResult {
    const doc = parseSxf(req.sheet);
    const cls: RscClassifier | null = req.classifier ? parseRsc(req.classifier) : null;

    const fillMap = new Map<string, { pos: number[]; idx: number[]; area: number; count: number }>();
    const lineMap = new Map<string, { width: number; dash: number[] | null; seg: number[] }>();
    const points: PointItem[] = [];

    /** Порядок отображения слоя объекта (Таблица 11). Нет слоя — наверх (255). */
    const orderOf = (code: number): number => {
        const e = cls?.objectByCode.get(code);
        if (!e) return 255;
        return cls!.layers.find(l => l.number === e.layer)?.order ?? 255;
    };

    const layerOf = (code: number): string | null => {
        const e = cls?.objectByCode.get(code);
        if (!e) return null;
        return cls!.layers.find(l => l.number === e.layer)?.name ?? null;
    };

    const include = req.includeLayers && req.includeLayers.length ? new Set(req.includeLayers) : null;
    const exclude = req.excludeLayers && req.excludeLayers.length ? new Set(req.excludeLayers) : null;

    for (const obj of doc.objects) {
        // Фильтр слоёв — как visibleLayers / invisibleLayers у VectorTile (по имени слоя классификатора).
        if (include || exclude) {
            const layer = layerOf(obj.classCode);
            if (include && (!layer || !include.has(layer))) continue;
            if (exclude && layer && exclude.has(layer)) continue;
        }

        const style = req.styles[obj.classCode] ?? req.defaultStyle;
        const loc = obj.locKind;

        if (loc === 'DOT') {
            if (!req.poi) continue;
            const pt = obj.metric.parts[0]?.[0];
            if (!pt) continue;
            const [wx, wz] = toWorld(req.transform, doc, pt);
            const spec = poiFor(obj.classCode);
            const name = cls?.objectByCode.get(obj.classCode)?.name ?? '';
            points.push({ x: wx, z: wz, icon: spec.icon, label: name, color: style.fill ?? '#888888', classCode: obj.classCode });
            continue;
        }

        // Порядок слоя (Таблица 11) — ключ группировки, чтобы батчи одного слоя не смешивались.
        const layerOrder = orderOf(obj.classCode);

        if (loc === 'SQR') {
            // Батч по коду объекта: здания и кварталы одного слоя не смешиваются.
            if (style.fill) addFill(fillMap, `${layerOrder}|${obj.classCode}|${style.fill}`, obj, doc, req.transform);
            if (style.stroke) addRings(lineMap, `${layerOrder}|${obj.classCode}|${style.stroke}`, style.width ?? 1, null, obj, doc, req.transform);
            continue;
        }

        if (loc === 'TIT') continue; // подписи-тексты — отдельный поток (см. POI)

        // LIN / VEC / PAT — линии
        const color = style.line ?? style.stroke;
        if (!color) continue;
        addRings(lineMap, `${layerOrder}|${obj.classCode}|${color}`, style.width ?? 1, style.dash ?? null, obj, doc, req.transform);
    }

    const fills: FillBatch[] = [];
    // Z-order внутри батчей: порядок слоя (Таблица 11) → средняя площадь объектов батча (крупные ниже).
    // Площадь — измеренное свойство: кварталы крупнее отдельных строений, поэтому строения ложатся сверху.
    // Порядок батча: сначала по слою, затем по убыванию средней площади (крупные — ниже).
    const fillArea = new Map<string, number>();
    for (const [key, f] of fillMap) {
        const [order] = key.split('|');
        const pos = new Float32Array(f.pos.length / 2 * 3);
        for (let i = 0, j = 0; i < f.pos.length; i += 2, j += 3) {
            pos[j] = f.pos[i]; pos[j + 1] = 0; pos[j + 2] = f.pos[i + 1];
        }
        const color = key.split('|')[2];
        fillArea.set(key, f.count ? f.area / f.count : 0);
        fills.push({ color, order: Number(order), positions: pos, indices: new Uint32Array(f.idx) });
    }
    const fillKeys = [...fillMap.keys()];
    const areaOfIndex = fills.map((_, i) => fillArea.get(fillKeys[i]) ?? 0);
    const sorted = fills.map((f, i) => ({ f, a: areaOfIndex[i] }))
        .sort((x, y) => x.f.order - y.f.order || y.a - x.a);
    fills.length = 0;
    for (const s of sorted) fills.push(s.f);

    const lines: LineBatch[] = [];
    for (const [key, l] of lineMap) {
        const [order, , color] = key.split('|');
        lines.push({ color, order: Number(order), width: l.width, dash: l.dash, segments: new Float32Array(l.seg) });
    }
    lines.sort((a, b) => a.order - b.order);

    return { type: 'built', id: req.id, fills, lines, points, count: doc.objects.length };
}

function addFill(
    map: Map<string, { pos: number[]; idx: number[]; area: number; count: number }>,
    color: string,
    obj: SxfObject,
    doc: SxfDocument,
    t: SxfTransform,
): void {
    const parts = obj.metric.parts.filter(p => p.length >= 3);
    if (parts.length === 0) return;

    const flat: number[] = [];
    const holes: number[] = [];
    let off = 0;
    for (let i = 0; i < parts.length; i++) {
        if (i > 0) holes.push(off / 2);
        for (const pt of parts[i]) {
            const [wx, wz] = toWorld(t, doc, pt);
            flat.push(wx, wz);
            off += 2;
        }
    }
    const idx = earcut(flat, holes, 2);
    if (idx.length < 3) return;

    let bucket = map.get(color);
    if (!bucket) { bucket = { pos: [], idx: [], area: 0, count: 0 }; map.set(color, bucket); }
    // Площадь внешнего контура (формула шнурования) — для порядка батчей внутри слоя.
    let a = 0;
    for (let i = 0; i < flat.length; i += 2) {
        const j = (i + 2) % flat.length;
        a += flat[i] * flat[j + 1] - flat[j] * flat[i + 1];
    }
    bucket.area += Math.abs(a) / 2;
    bucket.count += 1;
    const base = bucket.pos.length / 2;
    for (const v of flat) bucket.pos.push(v);
    for (const i of idx) bucket.idx.push(i + base);
}

function addRings(
    map: Map<string, { width: number; dash: number[] | null; seg: number[] }>,
    color: string,
    width: number,
    dash: number[] | null,
    obj: SxfObject,
    doc: SxfDocument,
    t: SxfTransform,
): void {
    const key = `${color}|${width}|${dash ? dash.join(',') : ''}`;
    let bucket = map.get(key);
    if (!bucket) { bucket = { width, dash, seg: [] }; map.set(key, bucket); }

    for (const part of obj.metric.parts) {
        if (part.length < 2) continue;
        for (let i = 0; i + 1 < part.length; i++) {
            const [ax, az] = toWorld(t, doc, part[i]);
            const [bx, bz] = toWorld(t, doc, part[i + 1]);
            bucket.seg.push(ax, 0, az, bx, 0, bz);
        }
    }
}

// ---------- обвязка воркера ----------
// Воркер запускается только в браузере; в Node тестируем buildSheet напрямую.
declare const self: any;
// Мы в воркере, если нет window (главный поток) и есть postMessage глобальной области.
if (typeof window === 'undefined' && typeof self !== 'undefined' && typeof self.postMessage === 'function') {
    self.onmessage = (e: MessageEvent<SxfBuildRequest>) => {
        const req = e.data;
        if (!req || req.type !== 'build') return;
        try {
            const res = buildSheet(req);
            const transfer: ArrayBuffer[] = [];
            for (const f of res.fills) { transfer.push(f.positions.buffer as ArrayBuffer, f.indices.buffer as ArrayBuffer); }
            for (const l of res.lines) transfer.push(l.segments.buffer as ArrayBuffer);
            self.postMessage(res, transfer);
        } catch (err: any) {
            self.postMessage({ type: 'error', id: req.id, message: String(err?.message ?? err) });
        }
    };
}
