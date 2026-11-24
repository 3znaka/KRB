/**
 * Единая точка доступа к встроенным ресурсам библиотеки.
 *
 * Два режима:
 *  - обычный (ESM-файлы рядом): ресурсы грузятся по URL относительно модуля,
 *    как и раньше (папки sprite/, img/, js_TP/draco/ и т.д.);
 *  - бандл (сборка build.bundle.mjs, флаг __KRB_BUNDLED__): ресурсы вшиты в
 *    сам JS-файл как data-URI / строки, внешних файлов не нужно.
 *
 * Все модули должны получать ресурсы ТОЛЬКО через эти функции, а не
 * через `new URL(..., import.meta.url)`, иначе бандл будет тянуть файлы по сети.
 *
 * @module assets
 */

import { IS_BUNDLE_BUILD } from './build-flag.js';
const _IS_BUNDLED: boolean = IS_BUNDLE_BUILD;
// В бандле (IIFE) import.meta недоступен — путь не нужен, т.к. assetUrl возвращает вшитые данные.
const _MODULE_DIR = _IS_BUNDLED ? '' : new URL('.', import.meta.url).href;

/**
 * Реестр вшитых ресурсов. Заполняется сгенерированным кодом бандла
 * (build.bundle.mjs) и пуст в обычном режиме.
 * Ключ — относительный путь внутри библиотеки (например 'img/marker.png').
 */
const _bundledAssets: Map<string, string> = new Map();

/** Регистрирует вшитый ресурс (вызывается сгенерированным кодом бандла). */
export function registerBundledAsset(relPath: string, dataUrl: string): void {
    _bundledAssets.set(relPath, dataUrl);
}

/** Схлопывает '.', '..' и лишние слэши: 'img/../img/x.svg' → 'img/x.svg'. */
function normalizeAssetKey(p: string): string {
    const out: string[] = [];
    for (const seg of p.split('/')) {
        if (seg === '' || seg === '.') continue;
        if (seg === '..') { out.pop(); continue; }
        out.push(seg);
    }
    return out.join('/');
}

/**
 * Возвращает URL ресурса по относительному пути внутри библиотеки.
 * В бандле — data-URI, иначе — URL относительно модуля.
 */
export function assetUrl(relPath: string): string {
    if (_IS_BUNDLED) {
        // Нормализуем путь: схлопываем '.' и '..' сегменты, чтобы
        // 'img/../img/x.svg' и '../img/x.svg' совпали с ключом 'img/x.svg'.
        const key = normalizeAssetKey(relPath);
        const embedded = _bundledAssets.get(key);
        if (embedded) return embedded;
        console.warn(`KRB: ассет "${key}" не вшит в бандл`);
        return relPath;
    }
    return new URL(relPath, _MODULE_DIR).href;
}

/**
 * Вшитые содержимое Draco (текст wrapper'а и бинарник wasm).
 * Заполняется в бандле; в обычном режиме null — DRACOLoader грузит файлы по пути.
 */
export interface BundledDraco {
    wrapperJs: string;
    wasm: ArrayBuffer;
}
let _bundledDraco: BundledDraco | null = null;

export function registerBundledDraco(d: BundledDraco): void {
    _bundledDraco = d;
}

export function getBundledDraco(): BundledDraco | null {
    return _IS_BUNDLED ? _bundledDraco : null;
}

/**
 * Вшитые исходники для воркеров (tpb.js и earcut.js как текст).
 * Нужны, чтобы воркер векторных тайлов не делал fetch к файлам.
 */
export interface BundledWorkerSources {
    tpb: string;
    earcut: string;
}
let _bundledWorkerSources: BundledWorkerSources | null = null;

export function registerBundledWorkerSources(s: BundledWorkerSources): void {
    _bundledWorkerSources = s;
}

export function getBundledWorkerSources(): BundledWorkerSources | null {
    return _IS_BUNDLED ? _bundledWorkerSources : null;
}

/** Вшитый исходник GeoTIFF-воркера (текст, для Blob-воркера). */
let _bundledGeotiffWorker: string | null = null;

export function registerBundledGeotiffWorker(code: string): void {
    _bundledGeotiffWorker = code;
}

export function getBundledGeotiffWorker(): string | null {
    return _IS_BUNDLED ? _bundledGeotiffWorker : null;
}

/** Вшитые модули customCRS: ключ — код CRS ('ESRI:54052'), значение — { default: spec }. */
const _bundledCustomCrs: Map<string, { default: any }> = new Map();

export function registerBundledCustomCrs(code: string, mod: { default: any }): void {
    _bundledCustomCrs.set(code, mod);
}

export function getBundledCustomCrs(code: string): { default: any } | null {
    return _IS_BUNDLED ? (_bundledCustomCrs.get(code) ?? null) : null;
}

/**
 * epsg_defs.json вшит сжатым: gzip → base64. Регистрируется строка base64.
 * Распаковка ленивая: только при первом обращении (addCrs), результат кешируется.
 */
let _epsgDefsGzB64: string | null = null;
let _epsgDefsPromise: Promise<Record<string, string>> | null = null;

export function registerBundledEpsgDefsGz(gzBase64: string): void {
    _epsgDefsGzB64 = gzBase64;
}

/** Асинхронно распаковывает вшитый epsg_defs; null — если не в бандле. */
export function getBundledEpsgDefs(): Promise<Record<string, string>> | null {
    if (!_IS_BUNDLED || !_epsgDefsGzB64) return null;
    if (!_epsgDefsPromise) {
        _epsgDefsPromise = (async () => {
            const bin = atob(_epsgDefsGzB64!);
            const bytes = new Uint8Array(bin.length);
            for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
            const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'));
            const text = await new Response(stream).text();
            return JSON.parse(text) as Record<string, string>;
        })();
        // Освобождаем сжатую строку: распакованное уже в кеше промиса.
        _epsgDefsGzB64 = null;
    }
    return _epsgDefsPromise;
}

/** true, если библиотека собрана как самодостаточный бандл. */
export function isBundled(): boolean {
    return _IS_BUNDLED;
}
