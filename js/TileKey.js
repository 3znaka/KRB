/**
 * Ключи тайлов для виртуальных экземпляров на сцене.
 *
 * @module TileKey
 */
/**
 * Формирует строковый ключ тайла "z,x,y".
 *
 * Используется как для исходных тайлов (URL), так и для виртуальных
 * экземпляров на сцене — формат идентичен.
 */
export function getVirtKey(z, x, y) {
    return `${z},${x},${y}`;
}
export function getOriginZ(y, tileSize, halfExtentY) {
    return -halfExtentY + y * tileSize;
}
