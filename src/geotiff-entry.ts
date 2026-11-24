/**
 * Точка входа отдельного файла KRB.geotiff.min.js.
 *
 * Загружается лениво из KRB.bundle.min.js при первом использовании GeoTiffLayer.
 * Пользователь этот файл напрямую не подключает — он лежит рядом с бандлом.
 *
 * Экспортирует ровно то, что нужно GeoTiffLayer, и тексты воркера.
 */
export { fromUrl, fromArrayBuffer, Pool } from './js_TP/geotiff.bundle.js';

// Исходник воркера, чтобы не требовать отдельного файла geotiff.worker.js.
import geotiffWorkerText from './js_TP/geotiff.worker.js?text';
export const geotiffWorkerSource: string = geotiffWorkerText;
