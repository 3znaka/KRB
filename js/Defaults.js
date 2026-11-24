/**
 * Глобальные значения по умолчанию для библиотеки.
 *
 * Все поля — фолбэки для параметров конструктора KrbMap и Tile.
 * Ранее жили в Utils.ts; вынесены сюда, чтобы не превращать
 * "утилиты" в свалку.
 *
 * @module Defaults
 */
import { assetUrl, getBundledDraco } from './assets.js';
import { DRACOLoader } from './js_TP/tpb.js';
export const DEFAULTS = {
    /**
     * Множитель высот DEM (1 = метры, world-единицы ≈ метры по
     * инварианту `Projections._wrapWorld`). Для визуального
     * преувеличения рельефа задайте `layer.heightScale > 1` явно.
     */
    HEIGHT_SCALE: 1,
    /** Число сегментов сетки рельефа по умолчанию. */
    SEGMENTS: 15,
    /** Длительность анимации перехода в секундах. */
    ANIM_DURATION: 0.2,
    /** Минимальный допустимый уровень зума. */
    MIN_ZOOM: 0,
    /** Максимальный допустимый уровень зума. */
    MAX_ZOOM: 24,
    /** Чувствительность управления зумом. */
    ZOOM_SENSITIVITY: 0.15,
    /** Множитель дальности отрисовки объектов. */
    OBJECT_RENDER_DISTANCE_FACTOR: 2.0,
    /** Минимальный зум, на котором используется рельеф. */
    MIN_RELIEF_Z: 0,
    /** Максимальный зум, для которого есть собственные данные рельефа. */
    MAX_RELIEF_Z: 24,
    /** Запас в тайлах вокруг области видимости для основного слоя. */
    TILE_MARGIN: 0.5,
    /** Запас в тайлах для фонового слоя. */
    TILE_MARGIN_BG: 2,
    /** Минимальный интервал обновления видимости в мс. */
    VISIBLE_UPDATE_THROTTLE: 150,
    /** Максимальное количество одновременных задач Web Worker. */
    MAX_WORKER_REQUESTS: 8,
    /** Базовый уровень зума для начального отображения. */
    BASE_ZOOM: 4,
    /** Fallback-дистанция камеры (world-единицы ≈ метры). */
    BASE_DISTANCE: 12_000_000,
    /** Уровень зума для статического фона. */
    STATIC_BG_ZOOM: 2,
    /** Размер тайла в пикселях (информативное значение). */
    TILE_PIXELS: 256,
};
// Путь к декодеру Draco вычисляется лениво (при первом обращении), а не на загрузке:
// в бандле ресурсы регистрируются позже, чем выполняется этот модуль.
let _dracoDecoderPath = null;
export function setDracoDecoderPath(path) {
    _dracoDecoderPath = path;
}
export function getDracoDecoderPath() {
    if (_dracoDecoderPath === null)
        _dracoDecoderPath = assetUrl('js_TP/draco/');
    return _dracoDecoderPath;
}
/**
 * Создаёт DRACOLoader с декодером wasm.
 * В обычном режиме — грузит файлы по getDracoDecoderPath().
 * В бандле — подставляет вшитые wrapper.js и wasm через decoderConfig,
 * без сетевых запросов к папке draco/.
 */
export function createDracoLoader() {
    const loader = new DRACOLoader();
    const embedded = getBundledDraco();
    if (embedded) {
        // DRACOLoader._loadLibrary грузит файлы по имени через FileLoader.
        // В бандле подменяем этот метод: отдаём вшитый текст wrapper'а и wasm.
        const anyLoader = loader;
        anyLoader._loadLibrary = (name, responseType) => {
            if (name === 'draco_wasm_wrapper.js')
                return Promise.resolve(embedded.wrapperJs);
            if (name === 'draco_decoder.wasm')
                return Promise.resolve(embedded.wasm.slice(0));
            return Promise.reject(new Error(`KRB bundle: неизвестный draco-ресурс ${name}`));
        };
        loader.setDecoderConfig({ type: 'wasm' });
    }
    else {
        loader.setDecoderPath(getDracoDecoderPath());
        loader.setDecoderConfig({ type: 'wasm' });
    }
    return loader;
}
