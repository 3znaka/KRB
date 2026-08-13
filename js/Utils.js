/**
 * Вспомогательные утилиты для картографической библиотеки:
 * проекции, формирование ключей тайлов и глобальные константы.
 *
 * @module utils
 */

/**
 * Глобальные значения по умолчанию, используемые в библиотеке.
 * @constant {Object}
 * @property {number} R - Радиус Земли в метрах (6378137).
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
    STATIC_BG_ZOOM: 2
};

/**
 * Утилиты для работы с проекцией Меркатора.
 * @namespace
 */
export const proj = {
    /**
     * Преобразует географические координаты (долготу/широту) в мировые
     * координаты на плоскости Меркатора (в метрах).
     *
     * @param {number[]} lonLat - Массив [долгота, широта] в градусах.
     * @returns {number[]} Массив [x, y] мировых координат.
     */
    fromLonLat(lonLat) {
        const R = DEFAULTS.R;
        const lon = (lonLat[0] * Math.PI) / 180;
        const lat = (lonLat[1] * Math.PI) / 180;
        const x = R * lon;
        const y = -R * Math.log(Math.tan(Math.PI / 4 + lat / 2));
        return [x, y];
    }
};

/**
 * Обратное преобразование из мировых координат Меркатора в географические
 * (долготу/широту).
 *
 * @param {number[]} coord - Массив [x, z] мировых координат (ось Z направлена на север).
 * @returns {number[]} Массив [долгота, широта] в градусах.
 */
export function toLonLat([x, z]) {
    const R = 6378137;
    const lon = (x / R) * (180 / Math.PI);
    const lat = (2 * Math.atan(Math.exp(z / -R)) - Math.PI / 2) * (180 / Math.PI);
    return [lon, lat];
}

/**
 * Вычисляет координату Z начала тайла (северная граница) в мировой системе.
 *
 * @param {number} y - Номер строки тайла (ось Y направлена на юг).
 * @param {number} tileSize - Размер тайла в мировых единицах.
 * @param {number} maxMercator - Максимальное значение координаты в проекции Меркатора.
 * @returns {number} Z-координата начала тайла.
 */
export function getOriginZ(y, tileSize, maxMercator) {
    return -maxMercator + y * tileSize;
}

/**
 * Формирует строковый ключ для исходного тайла (текстуры/высот).
 *
 * @param {number} z - Уровень зума.
 * @param {number} srcX - X-координата исходного тайла.
 * @param {number} y - Y-координата (строка).
 * @returns {string} Ключ в формате "z,srcX,y".
 */
export function getSrcKey(z, srcX, y) {
    return `${z},${srcX},${y}`;
}

/**
 * Формирует строковый ключ для виртуального тайла (экземпляра на сцене).
 *
 * @param {number} z - Уровень зума.
 * @param {number} virtX - Виртуальная X-координата (глобальная, не обёрнутая).
 * @param {number} y - Y-координата (строка).
 * @returns {string} Ключ в формате "z,virtX,y".
 */
export function getVirtKey(z, virtX, y) {
    return `${z},${virtX},${y}`;
}