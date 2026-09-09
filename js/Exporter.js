/**
 * Модуль для экспорта 3D-объектов карты в формат GLB.
 * Позволяет передать массив объектов KRB (например, KRB.Image),
 * извлекает их внутренние Three.js меши, нормализует координаты
 * и скачивает готовый файл .glb.
 *
 * @module Exporter
 */
import { THREE, GLTFExporter } from '../js_TP/tpb.js';

/**
 * Извлекает мировую позицию объекта.
 * Приоритет: _centroidWorld (готовое свойство), затем среднее _worldPositions,
 * затем стандартный getWorldPosition.
 *
 * @param {Object} obj - Исходный объект (например, KRB.Image).
 * @param {THREE.Object3D} mesh - Three.js меш объекта.
 * @returns {THREE.Vector3} Мировая позиция объекта.
 * @private
 */
function getObjectWorldPosition(obj, mesh) {
    if (obj._centroidWorld && obj._centroidWorld.isVector3) {
        return obj._centroidWorld.clone();
    }
    if (Array.isArray(obj._worldPositions) && obj._worldPositions.length > 0) {
        const sum = new THREE.Vector3();
        for (const p of obj._worldPositions) {
            if (p && p.isVector3) {
                sum.add(p);
            }
        }
        if (sum.lengthSq() > 0) {
            sum.divideScalar(obj._worldPositions.length);
            return sum;
        }
    }
    const worldPos = new THREE.Vector3();
    mesh.getWorldPosition(worldPos);
    return worldPos;
}

/**
 * Нормализует позиции объектов, сдвигая их так, чтобы центроид оказался в начале координат.
 * Возвращает новые позиции в виде массива Vector3.
 *
 * @param {Array<{mesh: THREE.Object3D, worldPos: THREE.Vector3}>} items - Массив объектов с мешем и мировой позицией.
 * @returns {THREE.Vector3[]} Массив скорректированных позиций.
 * @private
 */
function computeNormalizedPositions(items) {
    if (!items.length) return [];

    const center = new THREE.Vector3();
    for (const { worldPos } of items) {
        center.add(worldPos);
    }
    center.divideScalar(items.length);

    return items.map(({ worldPos }) => worldPos.clone().sub(center));
}

/**
 * Экспортирует переданные объекты в GLB-файл и автоматически скачивает его.
 *
 * @param {Array<Object>} objects - Массив объектов карты (например, KRB.Image),
 *                                  у которых есть свойство `_mesh` (Three.js Mesh).
 * @param {Object} [options] - Дополнительные параметры.
 * @param {boolean} [options.normalize=true] - Нормализовать координаты, чтобы центроид
 *                                             оказался в начале сцены.
 * @param {string} [options.filename='exported.glb'] - Имя скачиваемого файла.
 * @param {boolean} [options.binary=true] - Использовать бинарный формат GLB (если false, будет GLTF).
 * @param {Function} [options.onProgress] - Колбэк прогресса экспорта.
 * @param {Function} [options.onSuccess] - Колбэк при успешном экспорте (получает Blob).
 * @param {Function} [options.onError] - Колбэк при ошибке (получает Error).
 * @returns {Promise<Blob>} Промис, который разрешается Blob'ом после успешного экспорта.
 *
 * @example
 * import { exportToGLB } from './Exporter.js';
 *
 * const images = [imagePlane1, imagePlane2];
 * await exportToGLB(images, {
 *     filename: 'my-planes.glb',
 *     onSuccess: (blob) => console.log('Экспортировано', blob.size)
 * });
 */
export async function exportToGLB(objects, options = {}) {
    const {
        normalize = true,
        filename = 'exported.glb',
        binary = true,
        onProgress = null,
        onSuccess = null,
        onError = null
    } = options;

    if (!Array.isArray(objects) || objects.length === 0) {
        const error = new Error('exportToGLB: objects должен быть непустым массивом');
        if (onError) onError(error);
        throw error;
    }

    // 1. Собираем меши и корректные мировые позиции
    const items = [];
    for (const obj of objects) {
        const mesh = obj._mesh || (obj.getObject3D && obj.getObject3D());
        if (!mesh || !mesh.isObject3D) {
            console.warn('exportToGLB: пропущен объект без _mesh или isObject3D', obj);
            continue;
        }

        const worldPos = getObjectWorldPosition(obj, mesh);
        items.push({ mesh, worldPos });
    }

    if (!items.length) {
        const error = new Error('exportToGLB: ни один объект не содержит валидный Three.js меш');
        if (onError) onError(error);
        throw error;
    }

    // 2. Нормализация позиций (если требуется)
    let adjustedPositions;
    if (normalize) {
        adjustedPositions = computeNormalizedPositions(items);
    } else {
        adjustedPositions = items.map(({ worldPos }) => worldPos.clone());
    }

    // 3. Создаём сцену и добавляем клоны
    const exportScene = new THREE.Scene();
    let exportedCount = 0;

    for (let i = 0; i < items.length; i++) {
        const { mesh } = items[i];
        const clone = mesh.clone(true);

        clone.position.copy(adjustedPositions[i]);
        clone.quaternion.copy(mesh.quaternion);
        clone.scale.copy(mesh.scale);
        clone.updateMatrixWorld(true);

        exportScene.add(clone);
        exportedCount++;
    }

    // 4. Экспорт через GLTFExporter
    const exporter = new GLTFExporter();

    try {
        const result = await new Promise((resolve, reject) => {
            exporter.parse(
                exportScene,
                resolve,
                reject,
                {
                    binary,
                    // Можно передать onProgress, если поддерживается
                    ...(onProgress ? { onProgress } : {})
                }
            );
        });

        // 5. Создание Blob, скачивание и вызов onSuccess
        const blob = new Blob([result], { type: binary ? 'model/gltf-binary' : 'model/gltf+json' });

        // Всегда скачиваем файл
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);

        if (onSuccess) {
            onSuccess(blob);
        }

        console.log(`exportToGLB: успешно экспортировано ${exportedCount} объектов`);
        return blob;
    } catch (error) {
        console.error('exportToGLB: ошибка экспорта', error);
        if (onError) onError(error);
        throw error;
    }
}