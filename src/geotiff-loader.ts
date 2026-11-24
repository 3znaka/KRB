/**
 * Загрузка GeoTIFF-модуля.
 *
 * Два режима:
 *  - обычный ESM (исходники, js/): модуль берётся из js_TP/geotiff.bundle.js рядом
 *    с библиотекой — как и раньше, новых файлов не нужно;
 *  - бандл (KRB.bundle.min.js): модуль KRB.geotiff.min.js лежит рядом с бандлом
 *    и догружается лениво при первом использовании GeoTiffLayer.
 *
 * @module geotiff-loader
 */

import { IS_BUNDLE_BUILD } from './build-flag.js';

const BUNDLE_GEOTIFF_FILE = 'KRB.geotiff.min.js';
const SOURCE_GEOTIFF_FILE = 'js_TP/geotiff.bundle.js';
const SOURCE_WORKER_FILE = 'js_TP/geotiff.worker.js';

export interface GeoTiffModule {
    fromUrl: (...args: any[]) => Promise<any>;
    fromArrayBuffer: (...args: any[]) => Promise<any>;
    Pool: new (...args: any[]) => any;
    /** Исходник воркера (только в бандле); в обычном режиме — undefined. */
    geotiffWorkerSource?: string;
}

let _modulePromise: Promise<GeoTiffModule> | null = null;

/** URL текущего модуля (библиотеки), относительно которого лежат файлы. */
function moduleBaseUrl(): string {
    try {
        const meta = (import.meta as any)?.url;
        if (meta) return meta;
    } catch { /* нет import.meta */ }
    const cur = (document.currentScript as HTMLScriptElement | null)?.src;
    return cur || document.baseURI;
}

/**
 * Возвращает модуль GeoTIFF. Загружает один раз, результат кешируется.
 */
export function loadGeoTiffModule(): Promise<GeoTiffModule> {
    if (_modulePromise) return _modulePromise;

    if (!IS_BUNDLE_BUILD) {
        // Обычный ESM: js_TP/geotiff.bundle.js рядом с модулями библиотеки.
        const url = new URL(SOURCE_GEOTIFF_FILE, moduleBaseUrl()).href;
        _modulePromise = import(/* @vite-ignore */ url).then(
            (mod: any) => mod as GeoTiffModule,
            (err: unknown) => {
                _modulePromise = null;
                const msg = `KRB: не удалось загрузить GeoTIFF-модуль ${url}: ` +
                    String((err as any)?.message || err);
                console.error(msg);
                throw new Error(msg);
            },
        );
        return _modulePromise;
    }

    // Бандл: KRB.geotiff.min.js рядом с KRB.bundle.min.js.
    const url = new URL(BUNDLE_GEOTIFF_FILE, moduleBaseUrl()).href;
    _modulePromise = import(/* @vite-ignore */ url).then(
        (mod: any) => mod as GeoTiffModule,
        (err: unknown) => {
            _modulePromise = null; // повторная попытка после добавления файла
            const msg =
                `KRB: для работы с GeoTIFF положите файл ${BUNDLE_GEOTIFF_FILE} ` +
                `рядом с вашим KRB.bundle.min.js (ожидался по адресу ${url}). ` +
                `Причина: ${String((err as any)?.message || err)}`;
            console.error(msg);
            throw new Error(msg);
        },
    );
    return _modulePromise;
}

/** Путь к файлу воркера в обычном режиме (используется GeoTiffLayer). */
export const GEOTIFF_SOURCE_WORKER_FILE = SOURCE_WORKER_FILE;
