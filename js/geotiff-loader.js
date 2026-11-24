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
let _modulePromise = null;
/** URL текущего модуля (библиотеки), относительно которого лежат файлы. */
function moduleBaseUrl() {
    try {
        const meta = import.meta?.url;
        if (meta)
            return meta;
    }
    catch { /* нет import.meta */ }
    const cur = document.currentScript?.src;
    return cur || document.baseURI;
}
/**
 * Возвращает модуль GeoTIFF. Загружает один раз, результат кешируется.
 */
export function loadGeoTiffModule() {
    if (_modulePromise)
        return _modulePromise;
    if (!IS_BUNDLE_BUILD) {
        // Обычный ESM: js_TP/geotiff.bundle.js рядом с модулями библиотеки.
        const url = new URL(SOURCE_GEOTIFF_FILE, moduleBaseUrl()).href;
        _modulePromise = import(/* @vite-ignore */ url).then((mod) => mod, (err) => {
            _modulePromise = null;
            const msg = `KRB: не удалось загрузить GeoTIFF-модуль ${url}: ` +
                String(err?.message || err);
            console.error(msg);
            throw new Error(msg);
        });
        return _modulePromise;
    }
    // Бандл: KRB.geotiff.min.js рядом с KRB.bundle.min.js.
    const url = new URL(BUNDLE_GEOTIFF_FILE, moduleBaseUrl()).href;
    _modulePromise = import(/* @vite-ignore */ url).then((mod) => mod, (err) => {
        _modulePromise = null; // повторная попытка после добавления файла
        const msg = `KRB: для работы с GeoTIFF положите файл ${BUNDLE_GEOTIFF_FILE} ` +
            `рядом с вашим KRB.bundle.min.js (ожидался по адресу ${url}). ` +
            `Причина: ${String(err?.message || err)}`;
        console.error(msg);
        throw new Error(msg);
    });
    return _modulePromise;
}
/** Путь к файлу воркера в обычном режиме (используется GeoTiffLayer). */
export const GEOTIFF_SOURCE_WORKER_FILE = SOURCE_WORKER_FILE;
