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

export class SurfacePolygon {
    constructor(options = {}) {
        if (!options.rings?.[0] || options.rings[0].length < 3) {
            throw new Error('SurfacePolygon: rings[0] must contain at least 3 points');
        }

        this._rings = options.rings;
        this._crsCode = options.crs ?? null;
        this._crs = null;

        this._fillColor = options.fillColor || '#ff0000';
        this._fillOpacity = options.fillOpacity ?? 0.6;
        this._strokeColor = options.strokeColor || '#000000';
        this._strokeWidth = options.strokeWidth ?? 1;
        this._offsetY = options.offsetY ?? 0.2;

        this._map = null;
        this._layer = null;

        /** @type {Map<string, THREE.Mesh>} */
        this._overlays = new Map();
        
        this._callback = null;
        this._disposeCallback = null;
    }

    addTo(map) {
        if (this._map) this.remove();
        const personalLayer = new Layer();
        personalLayer.addTo(map);
        personalLayer.add(this);
        return this;
    }

    _attach(map, layer) {
        if (this._map === map && this._layer === layer) return;
        this.remove();
        this._map = map;
        this._layer = layer;

        this._crs = this._crsCode
            ? Projections.get(this._crsCode)
            : map.inputCRS;

        const callbacks = map.tileManager?.onTileHeightAppliedCallbacks;
        if (callbacks) {
            this._callback = (inst) => this._onTileHeightApplied(inst);
            callbacks.push(this._callback);

            for (const inst of map.tileManager.tiles.values()) {
                if (inst.heightsApplied) this._onTileHeightApplied(inst);
            }
        }

        // Подписка на удаление тайлов (для очистки памяти)
        const disposeCallbacks = map.tileManager?.onTileDisposedCallbacks;
        if (disposeCallbacks) {
            this._disposeCallback = (inst) => this._onTileDisposed(inst);
            disposeCallbacks.push(this._disposeCallback);
        }
    }

    _getTileMercatorBBox(inst) {
        const map = this._map;
        const ts = map.WORLD_SIZE / Math.pow(2, inst.z);
        const left = inst.virtX * ts - map.MAX_MERCATOR;
        const bottom = getOriginZ(inst.y, ts, map.MAX_MERCATOR);
        return {
            left, right: left + ts,
            bottom, top: bottom + ts
        };
    }

    _polygonIntersectsTile(bbox) {
        const ring = this._rings[0];
        let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
        for (const pt of ring) {
            const [x, z] = this._map.project(pt, this._crs);
            if (x < minX) minX = x;
            if (x > maxX) maxX = x;
            if (z < minZ) minZ = z;
            if (z > maxZ) maxZ = z;
        }
        return !(maxX < bbox.left || minX > bbox.right ||
                 maxZ < bbox.bottom || minZ > bbox.top);
    }

    _onTileHeightApplied(inst) {
        if (!this._map || !inst.geometry || !inst.mesh) return;
        const bbox = this._getTileMercatorBBox(inst);
        if (!this._polygonIntersectsTile(bbox)) return;
        this._createOverlayForTile(inst, bbox);
    }

    _onTileDisposed(inst) {
        if (!this._map) return;
        const key = getVirtKey(inst.z, inst.virtX, inst.y);
        const overlay = this._overlays.get(key);
        if (overlay) {
            this._disposeOverlayMesh(overlay);
            this._overlays.delete(key);
        }
    }

    _createOverlayForTile(inst, bbox) {
        const map = this._map;
        const ts = map.WORLD_SIZE / Math.pow(2, inst.z);
        const key = getVirtKey(inst.z, inst.virtX, inst.y);

        const old = this._overlays.get(key);
        if (old) {
            this._disposeOverlayMesh(old);
            this._overlays.delete(key);
        }

        // Клонируем геометрию тайла (она в локальных координатах меша тайла)
        const geomCopy = inst.geometry.clone();
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

            ctx2d.fillStyle = this._fillColor;
            ctx2d.globalAlpha = this._fillOpacity;
            ctx2d.fill();

            if (this._strokeWidth > 0) {
                ctx2d.globalAlpha = 1.0;
                ctx2d.strokeStyle = this._strokeColor;
                const scale = texSize / map.TILE_PIXELS;
                ctx2d.lineWidth = this._strokeWidth * scale;
                ctx2d.lineJoin = 'round';
                ctx2d.lineCap = 'round';
                ctx2d.stroke();
            }
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
        
        // Поднимаем меш оверлея над тайлом. 
        // (Геометрию вершин менять не нужно)
        overlayMesh.position.set(0, this._offsetY, 0);
        
        // Оверлей должен рисоваться ПОСЛЕ тайла (у тайла renderOrder = z)
        overlayMesh.renderOrder = inst.mesh.renderOrder + 1;

        // ВАЖНО: добавляем оверлей как ребенка тайла.
        // Теперь он наследует его видимость и трансформации.
        inst.mesh.add(overlayMesh);
        
        this._overlays.set(key, overlayMesh);
    }

    _disposeOverlayMesh(mesh) {
        if (!mesh) return;
        mesh.parent?.remove(mesh);
        mesh.geometry?.dispose();
        if (mesh.material?.map) mesh.material.map.dispose();
        mesh.material?.dispose();
    }

    remove() {
        if (this._map) {
            const tm = this._map.tileManager;
            if (tm) {
                if (this._callback && tm.onTileHeightAppliedCallbacks) {
                    const idx = tm.onTileHeightAppliedCallbacks.indexOf(this._callback);
                    if (idx > -1) tm.onTileHeightAppliedCallbacks.splice(idx, 1);
                }
                if (this._disposeCallback && tm.onTileDisposedCallbacks) {
                    const idx = tm.onTileDisposedCallbacks.indexOf(this._disposeCallback);
                    if (idx > -1) tm.onTileDisposedCallbacks.splice(idx, 1);
                }
            }
        }
        this._callback = null;
        this._disposeCallback = null;

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