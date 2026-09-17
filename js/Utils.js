/**
 * Вспомогательные утилиты для картографической библиотеки:
 * формирование ключей тайлов, геометрия тайловой сетки и глобальные
 * значения по умолчанию.
 *
 * Преобразования координат между системами координат выполняются
 * в модуле {@link module:projections} (`Projections`, `Projection`)
 * и через публичные методы карты `KrbMap#project` / `KrbMap#unproject`.
 *
 * @module utils
 */

/**
 * Глобальные значения по умолчанию, используемые в библиотеке.
 *
 * Значения этой таблицы — фолбэки для параметров конструктора `KrbMap`.
 * В частности, `R` используется только если `options.R` не задан явно;
 * сама по себе эта константа нигде больше не читается, поэтому она не
 * может «рассинхронизировать» проекцию и мир.
 *
 * @type {Object}
 * @property {number} R - Радиус мира по умолчанию (полуось эллипсоида WGS84).
 *   Должен совпадать с эллипсоидом проекции карты; для EPSG:3857 и EPSG:3395
 *   равен 6378137.
 * @property {number} HEIGHT_SCALE - Масштабный коэффициент для рельефа.
 * @property {number} SEGMENTS - Число сегментов сетки рельефа по умолчанию.
 * @property {number} ANIM_DURATION - Длительность анимации перехода в секундах.
 * @property {number} MIN_ZOOM - Минимальный допустимый уровень зума.
 * @property {number} MAX_ZOOM - Максимальный допустимый уровень зума.
 * @property {number} ZOOM_SENSITIVITY - Чувствительность управления зумом.
 * @property {number} OBJECT_RENDER_DISTANCE_FACTOR - Множитель дальности отрисовки объектов.
 * @property {number} MIN_RELIEF_Z - Минимальный зум, на котором используется рельеф.
 * @property {number} MAX_RELIEF_Z - Максимальный зум, для которого есть собственные данные рельефа.
 * @property {number} TILE_MARGIN - Запас в тайлах вокруг области видимости для основного слоя.
 * @property {number} TILE_MARGIN_BG - Запас в тайлах для фонового слоя.
 * @property {number} VISIBLE_UPDATE_THROTTLE - Минимальный интервал обновления видимости в мс.
 * @property {number} MAX_WORKER_REQUESTS - Максимальное количество одновременных задач Web Worker.
 * @property {number} BASE_ZOOM - Базовый уровень зума для начального отображения.
 * @property {number} BASE_DISTANCE - Базовая дистанция камеры (м).
 * @property {number} STATIC_BG_ZOOM - Уровень зума для статического фона.
 * @property {number} TILE_PIXELS - Размер тайла в пикселях (информативное значение;
 *   KrbMap использует его через this.TILE_PIXELS).
 */
export const DEFAULTS = {
    R: 6378137,
    HEIGHT_SCALE: 2,
    SEGMENTS: 15,
    ANIM_DURATION: 0.2,
    MIN_ZOOM: 2,
    MAX_ZOOM: 12,
    ZOOM_SENSITIVITY: 0.15,
    OBJECT_RENDER_DISTANCE_FACTOR: 2.0,
    MIN_RELIEF_Z: 0,
    MAX_RELIEF_Z: 8,
    TILE_MARGIN: 5,
    TILE_MARGIN_BG: 2,
    VISIBLE_UPDATE_THROTTLE: 150,
    MAX_WORKER_REQUESTS: 8,
    BASE_ZOOM: 4,
    BASE_DISTANCE: 12_000_000,
    STATIC_BG_ZOOM: 2,
    TILE_PIXELS: 256
};

/**
 * Вычисляет координату Z начала тайла (северная граница) в мировой системе.
 *
 * @param {number} y - Номер строки тайла (ось Y направлена на юг).
 * @param {number} tileSize - Размер тайла в мировых единицах.
 * @param {number} maxMercator - Максимальное значение координаты в проекции Меркатора.
 * @returns {number} Z-координата начала тайла.
 *
 * @example
 * const y = 0;
 * const tileSize = 256;
 * const maxMercator = 20037508.34;
 * const originZ = getOriginZ(y, tileSize, maxMercator);
 * console.log(originZ);
 */
export function getOriginZ(y, tileSize, maxMercator) {
    return -maxMercator + y * tileSize;
}

/**
 * Формирует строковый ключ тайла в формате "z,x,y".
 *
 * Используется как для исходных тайлов (URL), так и для виртуальных
 * экземпляров на сцене — формат идентичен.
 *
 * @param {number} z - Уровень зума.
 * @param {number} x - X-координата тайла (виртуальная, не обёрнутая).
 * @param {number} y - Y-координата (строка).
 * @returns {string} Ключ в формате "z,x,y".
 *
 * @example
 * const key = getVirtKey(5, 10, 3);
 * console.log(key); // "5,10,3"
 */
export function getVirtKey(z, x, y) {
    return `${z},${x},${y}`;
}

/**
 * Формирует строковый ключ для исходного тайла.
 *
 * @deprecated Дублирует {@link getVirtKey} — обе функции возвращают одну
 * и ту же строку. Оставлено для обратной совместимости; в новом коде
 * используйте getVirtKey.
 *
 * @param {number} z - Уровень зума.
 * @param {number} srcX - X-координата исходного тайла.
 * @param {number} y - Y-координата (строка).
 * @returns {string} Ключ в формате "z,srcX,y".
 *
 * @example
 * const key = getSrcKey(5, 10, 3);
 * console.log(key); // "5,10,3"
 */
export function getSrcKey(z, srcX, y) {
    return `${z},${srcX},${y}`;
}