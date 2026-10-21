/**
 * Модуль для отображения полигонов, "натянутых" на рельеф.
 * Создаёт наложение поверх тайлов карты, повторяя рельеф местности
 * с учётом заданного смещения по высоте.
 *
 * @module SurfacePolygon
 */

import {
  THREE,
} from '../js_TP/tpb.js';
import { Projections } from './Projections.js';
import { getOriginZ, getVirtKey } from './Utils.js';
import { Layer } from './Layers.js';

/**
 * Класс, представляющий полигон, который точно ложится на рельеф карты.
 * В отличие от обычного {@link Polygon}, не использует собственную триангуляцию,
 * а копирует геометрию тайлов и накладывает на них текстуру полигона.
 *
 * Поддерживает заливку, обводку и заданное возвышение над поверхностью.
 *
 * Координаты колец задаются в системе координат `options.crs`.
 * Если `crs` не указан, используется `map.inputCRS` (по умолчанию WGS84).
 * Внутри карты координаты автоматически преобразуются в метры проекции
 * карты (`map.projection`) через {@link KrbMap#project}.
 *
 * @example
 * const poly = new SurfacePolygon({
 *   rings: [[[30.5, 50.4], [31.0, 50.5], [30.8, 50.7]]],
 *   fillColor: '#ff0000',
 *   fillOpacity: 0.6,
 *   strokeColor: '#000000',
 *   strokeWidth: 1,
 *   offsetY: 0.2
 * });
 * poly.addTo(map);
 * poly.remove();
 */
export class SurfacePolygon {
    /**
     * Создаёт экземпляр полигона, натянутого на рельеф.
     *
     * @param {Object} options - Настройки полигона.
     * @param {Array<Array<[number,number]>>} options.rings - Массив колец.
     *        Первое кольцо – внешний контур (обязательно), остальные (опционально) – отверстия.
     *        Каждое кольцо – массив точек [x, y] в СК `options.crs`
     *        (по умолчанию — [долгота, широта] в градусах WGS84).
     * @param {string} [options.crs] - Код системы координат для `rings`
     *        (например, 'EPSG:4326', 'EPSG:3857', 'EPSG:32637').
     *        Если не указан — используется `map.inputCRS`.
     *        Перед созданием полигона соответствующая проекция должна быть
     *        зарегистрирована в `Projections` (см. `Projections.ensure`).
     * @param {string} [options.fillColor='#ff0000'] - Цвет заливки (CSS).
     * @param {number} [options.fillOpacity=0.6] - Прозрачность заливки (0..1).
     * @param {string} [options.strokeColor='#000000'] - Цвет обводки.
     * @param {number} [options.strokeWidth=1] - Толщина обводки в пикселях (на текстуре).
     * @param {number} [options.offsetY=0.2] - Вертикальное смещение над рельефом в метрах.
     */
    constructor(options = {}) {
        if (!options.rings?.[0] || options.rings[0].length < 3) {
            throw new Error('SurfacePolygon: rings[0] must contain at least 3 points');
        }

        /** @private */ this._rings = options.rings;
        /**
         * Код СК колец; null — использовать `map.inputCRS`.
         * @private
         * @type {string|null}
         */
        this._crsCode = options.crs ?? null;
        /**
         * Зарезолвленный объект Projection. Устанавливается в `_attach`.
         * @private
         * @type {import('./Projections.js').Projection|null}
         */
        this._crs = null;

        /** @private */ this._fillColor = options.fillColor || '#ff0000';
        /** @private */ this._fillOpacity = options.fillOpacity ?? 0.6;
        /** @private */ this._strokeColor = options.strokeColor || '#000000';
        /** @private */ this._strokeWidth = options.strokeWidth ?? 1;
        /** @private */ this._offsetY = options.offsetY ?? 0.2;

        /** @private */ this._map = null;
        /** @private */ this._layer = null;

        /**
         * Созданные меши-оверлеи, по ключу тайла.
         *
         * Храним именно `Map<virtKey, THREE.Mesh>`, а не массив: при LRU-
         * вытеснении тайл может быть выгружен и снова загружен в течение
         * жизни полигона. Колбэк `onTileHeightAppliedCallbacks` сработает
         * для нового `inst` — и без дедупликации мы бы оставили в сцене
         * «зомби»-оверлей от прошлой загрузки. Map позволяет перед
         * созданием нового оверлея убрать старый.
         *
         * @private
         * @type {Map<string, THREE.Mesh>}
         */
        this._overlays = new Map();

        /**
         * Колбэк, зарегистрированный в `tileManager.onTileHeightAppliedCallbacks`.
         * @private
         * @type {((inst: Object) => void)|null}
         */
        this._callback = null;
    }

    /**
     * Удобный метод: создаёт персональный слой, добавляет его на карту
     * и помещает в него данный полигон.
     *
     * @param {Object} map - Экземпляр карты.
     * @returns {SurfacePolygon} Текущий экземпляр полигона.
     */
    addTo(map) {
        if (this._map) this.remove();
        const personalLayer = new Layer();
        personalLayer.addTo(map);
        personalLayer.add(this);
        return this;
    }

    /**
     * Внутренний метод, вызываемый слоем при добавлении.
     *
     * Подписывается на `tileManager.onTileHeightAppliedCallbacks` и сразу
     * обрабатывает уже загруженные тайлы с высотами (например, если полигон
     * добавили после того, как пользователь уже подеzoom'ил и тайлы успели
     * загрузиться).
     *
     * Колбэк `TileManager`'а передаёт ровно один аргумент — `inst`.
     * Никакого «контекста слоя» пока нет (он появится, когда в карте
     * будет несколько тайловых слоёв), поэтому все нужные величины
     * (`map.worldGroup`, `map.tileManager.tiles`, `WORLD_SIZE`) берём
     * напрямую у карты.
     *
     * @param {Object} map - Карта.
     * @param {Layer} layer - Слой-владелец.
     * @private
     */
    _attach(map, layer) {
        if (this._map === map && this._layer === layer) return;
        this.remove();
        this._map = map;
        this._layer = layer;

        // Резолвим проекцию полигона: либо заданную явно, либо inputCRS карты.
        this._crs = this._crsCode
            ? Projections.get(this._crsCode)
            : map.inputCRS;

        const callbacks = map.tileManager?.onTileHeightAppliedCallbacks;
        if (callbacks) {
            this._callback = (inst) => this._onTileHeightApplied(inst);
            callbacks.push(this._callback);

            // Обрабатываем уже загруженные тайлы с высотами.
            // `tileManager.tiles` — публичное хранилище инстансов
            // (см. его использование в KrbMap#onClick и TileManager#update).
            for (const inst of map.tileManager.tiles.values()) {
                if (inst.heightsApplied) this._onTileHeightApplied(inst);
            }
        }
    }

    /**
     * Вычисляет ограничивающий прямоугольник тайла в мировых координатах.
     * `bottom` – северная кромка (минимальная Z), `top` – южная кромка (максимальная Z).
     *
     * Размер тайла зависит от его `z` (WORLD_SIZE / 2^z), поэтому
     * вычисляется здесь, а не хранится в каком-либо «контексте».
     *
     * @param {Object} inst - Экземпляр тайла (содержит z, virtX, y).
     * @returns {{left: number, right: number, bottom: number, top: number}} Границы тайла.
     * @private
     */
    _getTileMercatorBBox(inst) {
        const map = this._map;
        const ts = map.WORLD_SIZE / Math.pow(2, inst.z);
        const left = inst.virtX * ts - map.MAX_MERCATOR;
        const bottom = getOriginZ(inst.y, ts, map.MAX_MERCATOR);
        return {
            left,
            right: left + ts,
            bottom,
            top: bottom + ts
        };
    }

    /**
     * Проверяет, пересекает ли полигон (по своим вершинам) заданный bounding box.
     *
     * @param {{left: number, right: number, bottom: number, top: number}} bbox - Границы тайла.
     * @returns {boolean} true, если есть пересечение.
     * @private
     */
    _polygonIntersectsTile(bbox) {
        const ring = this._rings[0];
        let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
        for (const pt of ring) {
            // Координата кольца → метры проекции карты.
            const [x, z] = this._map.project(pt, this._crs);
            if (x < minX) minX = x;
            if (x > maxX) maxX = x;
            if (z < minZ) minZ = z;
            if (z > maxZ) maxZ = z;
        }
        return !(maxX < bbox.left || minX > bbox.right ||
                 maxZ < bbox.bottom || minZ > bbox.top);
    }

    /**
     * Обработчик, вызываемый после применения высот к тайлу.
     * Если тайл пересекается с полигоном – создаёт оверлей.
     *
     * @param {Object} inst - Экземпляр тайла.
     * @private
     */
    _onTileHeightApplied(inst) {
        if (!this._map || !inst.geometry) return;
        const bbox = this._getTileMercatorBBox(inst);
        if (!this._polygonIntersectsTile(bbox)) return;
        this._createOverlayForTile(inst, bbox);
    }

    /**
     * Создаёт mesh-оверлей для конкретного тайла:
     * копирует геометрию (с уже применёнными высотами), поднимает на offsetY,
     * генерирует Canvas-текстуру с заливкой/обводкой полигона в UV-координатах тайла,
     * накладывает её на геометрию и добавляет в сцену.
     *
     * Если для этого тайла уже есть оверлей (например, тайл был выгружен
     * LRU-сборщиком и загружен заново), старый удаляется — иначе в сцене
     * остался бы «зомби»-меш со старой геометрией.
     *
     * @param {Object} inst - Экземпляр тайла.
     * @param {{left: number, right: number, bottom: number, top: number}} bbox - Границы тайла.
     * @private
     */
_createOverlayForTile(inst, bbox) {
    const map = this._map;
    const ts = map.WORLD_SIZE / Math.pow(2, inst.z);
    const key = getVirtKey(inst.z, inst.virtX, inst.y);

    const old = this._overlays.get(key);
    if (old) {
        this._disposeOverlayMesh(old);
        this._overlays.delete(key);
    }

    const geomCopy = inst.geometry.clone();
    const pos = geomCopy.attributes.position.array;
    for (let i = 0; i < pos.length; i += 3) {
        pos[i + 1] += this._offsetY;
    }
    geomCopy.attributes.position.needsUpdate = true;
    geomCopy.computeVertexNormals();
    geomCopy.computeBoundingSphere();

    const texSize = 512;
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = texSize;
    const ctx2d = canvas.getContext('2d');

    const ring = this._rings[0];
    const uvPoints = ring.map((pt) => {
        const [wx, wz] = map.project(pt, this._crs);
        const u = (wx - bbox.left) / ts;
        const v = (wz - bbox.bottom) / ts;
        return { u, v };
    });

    ctx2d.clearRect(0, 0, canvas.width, canvas.height);
    
    if (uvPoints.length > 0) {
        // ВМЕСТО CLAMP: Сохраняем состояние и включаем отсечение по границам холста
        ctx2d.save();
        ctx2d.beginPath();
        ctx2d.rect(0, 0, canvas.width, canvas.height);
        ctx2d.clip();

        ctx2d.beginPath();
        ctx2d.moveTo(uvPoints[0].u * canvas.width, uvPoints[0].v * canvas.height);
        for (let i = 1; i < uvPoints.length; i++) {
            ctx2d.lineTo(uvPoints[i].u * canvas.width, uvPoints[i].v * canvas.height);
        }
        ctx2d.closePath();

        // Заливка
        ctx2d.fillStyle = this._fillColor;
        ctx2d.globalAlpha = this._fillOpacity;
        ctx2d.fill();

        // Обводка
        if (this._strokeWidth > 0) {
            ctx2d.globalAlpha = 1.0;
            ctx2d.strokeStyle = this._strokeColor;
            const scale = texSize / map.TILE_PIXELS;
            ctx2d.lineWidth = this._strokeWidth * scale;
            
            // Делаем углы и концы линий закругленными, чтобы не было "игл"
            ctx2d.lineJoin = 'round';
            ctx2d.lineCap = 'round';
            
            ctx2d.stroke();
        }

        // Восстанавливаем состояние Canvas (снимаем clip)
        ctx2d.restore();
    }

    const texture = new THREE.CanvasTexture(canvas);
    texture.generateMipmaps = false;
    texture.minFilter = THREE.LinearFilter;
    texture.magFilter = THREE.LinearFilter;
    texture.needsUpdate = true;

    const material = new THREE.MeshBasicMaterial({
        map: texture,
        transparent: true,
        depthTest: true,
        depthWrite: false,
        side: THREE.DoubleSide,
        polygonOffset: true,
        polygonOffsetFactor: -1,
        polygonOffsetUnits: -1
    });

    const overlayMesh = new THREE.Mesh(geomCopy, material);
    overlayMesh.position.copy(inst.mesh.position);
    overlayMesh.renderOrder = 1;
    map.worldGroup.add(overlayMesh);
    this._overlays.set(key, overlayMesh);
}
    /**
     * Полностью освобождает ресурсы одного оверлея.
     * @param {THREE.Mesh|null} mesh
     * @private
     */
    _disposeOverlayMesh(mesh) {
        if (!mesh) return;
        mesh.parent?.remove(mesh);
        mesh.geometry?.dispose();
        if (mesh.material?.map) mesh.material.map.dispose();
        mesh.material?.dispose();
    }

    /**
     * Удаляет полигон с карты: отписывается от событий тайлов,
     * удаляет все созданные оверлеи и освобождает ресурсы.
     *
     * @example
     * poly.remove();
     */
    remove() {
        if (this._map && this._callback) {
            const callbacks = this._map.tileManager?.onTileHeightAppliedCallbacks;
            if (callbacks) {
                const idx = callbacks.indexOf(this._callback);
                if (idx > -1) callbacks.splice(idx, 1);
            }
            this._callback = null;
        }

        for (const mesh of this._overlays.values()) {
            this._disposeOverlayMesh(mesh);
        }
        this._overlays.clear();

        if (this._layer) {
            this._layer._removeRef(this);
            this._layer = null;
        }
        this._map = null;
        this._crs = null;
    }

    // ---------- Интерфейс для KrbMap#fitTo / getBounds ----------

    /**
     * Возвращает прямоугольник (bounding box), охватывающий полигон
     * целиком, включая все кольца (внешнее и отверстия).
     *
     * Используется методом {@link KrbMap#fitTo} для подгонки вида.
     * Если полигон привязан к карте (`_crs` резолвлена), координаты
     * преобразуются из его СК. Если не привязан, но задан `_crsCode` —
     * из него. В остальных случаях исходные координаты считаются уже
     * в WGS84 (это соответствует поведению конструктора по умолчанию,
     * где `map.inputCRS` = EPSG:4326).
     *
     * @param {string|import('./Projections.js').Projection} [crs='EPSG:4326'] -
     *     Целевая СК для результата (код или объект Projection).
     * @returns {Array.<Array.<number>>|null} [[minX, minY], [maxX, maxY]]
     *     или null, если у полигона нет колец или преобразование невозможно.
     *
     * @example
     * const b = poly.getBounds();                 // → [[30.5, 50.4], [31.0, 50.7]]
     * const bUtm = poly.getBounds('EPSG:32637');  // → [[413500, 6178000], ...]
     */
    getBounds(crs = 'EPSG:4326') {
        if (!this._rings || !this._rings.length) return null;

        const src = this._crs
            ?? (this._crsCode ? Projections.get(this._crsCode) : Projections.get('EPSG:4326'));
        const dst = typeof crs === 'string' ? Projections.get(crs) : crs;
        if (!src || !dst) return null;

        const sameProjection = src === dst;
        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
        let count = 0;

        for (const ring of this._rings) {
            if (!ring) continue;
            for (let i = 0; i < ring.length; i++) {
                const pt = ring[i];
                if (!pt || pt.length < 2) continue;
                let x, y;
                if (sameProjection) {
                    x = pt[0];
                    y = pt[1];
                } else {
                    const lonLat = src.toLonLat(pt);
                    const converted = dst.fromLonLat(lonLat);
                    x = converted[0];
                    y = converted[1];
                }
                if (x < minX) minX = x;
                if (x > maxX) maxX = x;
                if (y < minY) minY = y;
                if (y > maxY) maxY = y;
                count++;
            }
        }
        if (count === 0 || !isFinite(minX)) return null;
        return [[minX, minY], [maxX, maxY]];
    }
}