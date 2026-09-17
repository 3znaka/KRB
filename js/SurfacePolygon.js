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
        /** @private */ this._overlayMeshes = [];   // все созданные меши
        /** @private */ this._callback = null;      // колбэк в tileManager
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
     * Подписывается на событие применения высот к тайлам и сразу
     * обрабатывает уже готовые тайлы.
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

        if (map.tileManager?.onTileHeightAppliedCallbacks) {
            this._callback = (ctx, inst) => this._onTileHeightApplied(ctx, inst);
            map.tileManager.onTileHeightAppliedCallbacks.push(this._callback);

            // Обрабатываем уже загруженные тайлы с высотами
            const ctx = map.getCurrentContext();
            if (ctx) {
                for (const [key, inst] of ctx.instanceCache) {
                    if (inst.heightsApplied) {
                        this._onTileHeightApplied(ctx, inst);
                    }
                }
            }
        }
    }

    /**
     * Вычисляет ограничивающий прямоугольник тайла в мировых координатах.
     * `bottom` – северная кромка (минимальная Z), `top` – южная кромка (максимальная Z).
     *
     * @param {Object} ctx - Контекст тайлового слоя.
     * @param {Object} inst - Экземпляр тайла (содержит virtX, y).
     * @returns {{left: number, right: number, bottom: number, top: number}} Границы тайла.
     * @private
     */
    _getTileMercatorBBox(ctx, inst) {
        const ts = ctx.tileSize;
        const left = inst.virtX * ts - this._map.MAX_MERCATOR;
        const bottom = -this._map.MAX_MERCATOR + inst.y * ts;   // getOriginZ
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
     * @param {Object} ctx - Контекст тайлового слоя.
     * @param {Object} inst - Экземпляр тайла.
     * @private
     */
    _onTileHeightApplied(ctx, inst) {
        const bbox = this._getTileMercatorBBox(ctx, inst);
        if (!this._polygonIntersectsTile(bbox)) return;
        this._createOverlayForTile(ctx, inst, bbox);
    }

    /**
     * Создаёт mesh-оверлей для конкретного тайла:
     * копирует геометрию (с уже применёнными высотами), поднимает на offsetY,
     * генерирует Canvas-текстуру с заливкой/обводкой полигона в UV-координатах тайла,
     * накладывает её на геометрию и добавляет в сцену.
     *
     * @param {Object} ctx - Контекст тайла.
     * @param {Object} inst - Экземпляр тайла.
     * @param {{left: number, right: number, bottom: number, top: number}} bbox - Границы тайла.
     * @private
     */
    _createOverlayForTile(ctx, inst, bbox) {
        const map = this._map;
        const ts = ctx.tileSize;

        // Копия геометрии тайла (с уже применёнными высотами)
        const geomCopy = inst.geometry.clone();

        // Поднимаем все вершины на offsetY
        const pos = geomCopy.attributes.position.array;
        for (let i = 0; i < pos.length; i += 3) {
            pos[i + 1] += this._offsetY;
        }
        geomCopy.attributes.position.needsUpdate = true;
        geomCopy.computeVertexNormals();

        // Готовим текстуру (Canvas)
        const canvas = document.createElement('canvas');
        canvas.width = canvas.height = map.TILE_PIXELS;
        const ctx2d = canvas.getContext('2d');

        // Преобразуем координаты кольца полигона в UV тайла (могут выходить за 0..1)
        const ring = this._rings[0];
        const uvPoints = ring.map((pt) => {
            // Координата кольца → метры проекции карты.
            const [wx, wz] = map.project(pt, this._crs);
            const u = (wx - bbox.left) / ts;
            const v = (wz - bbox.bottom) / ts;   // 0 = север, 1 = юг
            return { u, v };
        });

        // Рисуем на Canvas
        ctx2d.clearRect(0, 0, canvas.width, canvas.height);
        if (uvPoints.length > 0) {
            ctx2d.beginPath();
            // v=0 (север) → y=0 (верх canvas), инверсии не требуется
            ctx2d.moveTo(uvPoints[0].u * canvas.width, uvPoints[0].v * canvas.height);
            for (let i = 1; i < uvPoints.length; i++) {
                ctx2d.lineTo(uvPoints[i].u * canvas.width, uvPoints[i].v * canvas.height);
            }
            ctx2d.closePath();
            ctx2d.fillStyle = this._fillColor;
            ctx2d.globalAlpha = this._fillOpacity;
            ctx2d.fill();

            if (this._strokeWidth > 0) {
                ctx2d.globalAlpha = 1.0;
                ctx2d.strokeStyle = this._strokeColor;
                ctx2d.lineWidth = this._strokeWidth;
                ctx2d.stroke();
            }
        }

        const texture = new THREE.CanvasTexture(canvas);
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
        overlayMesh.renderOrder = 1;
        ctx.worldGroup.add(overlayMesh);
        this._overlayMeshes.push(overlayMesh);
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

        for (const mesh of this._overlayMeshes) {
            mesh.parent?.remove(mesh);
            mesh.geometry?.dispose();
            if (mesh.material.map) mesh.material.map.dispose();
            mesh.material.dispose();
        }
        this._overlayMeshes = [];

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