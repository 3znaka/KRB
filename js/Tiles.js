import {
  THREE
} from '../js_TP/tpb.js';  
import { getOriginZ, getSrcKey, getVirtKey, DEFAULTS } from './Utils.js';

export class Tile {
    constructor(options) {
        this.texture = options.texture;
        this.elevation = options.elevation;
        this.attributionTitle = options.attributionTitle || '';
        this.attributionUrl = options.attributionUrl || '';
        this.heightScale = options.heightScale ?? DEFAULTS.HEIGHT_SCALE;
    }
}

const LEVEL_Y_STEP = 1;
const MAX_CACHED_TILES = 350;
const ANCESTOR_FALLBACK = 4;
const MAX_COVER_DEPTH = 2; // глубина поиска потомков при отдалении

export class TileManager {
    constructor(engine) {
        this.engine = engine;
        this.tiles = new Map(); // ключ -> { z, virtX, y, mesh, geometry, ready, failed, loading, texUrl, lastUsed, heightsApplied, elevationAppliedLevel, expectsElevation }
        this.textureCache = new Map(); // url -> { texture, refs }
        this.textureLoader = new THREE.TextureLoader();
        this.textureLoader.setCrossOrigin('anonymous');
        this.frame = 0;

        this.hasElevation = engine.hasElevation;
        if (this.hasElevation) {
            this.srcKeyToElevUrl = new Map();
            this.parentElevCache = engine.globalElevCache || new Map();
            this.parentElevPromises = new Map();
            this.elevDirectPromises = new Map();
            this.elevationQueue = [];
            this.activeElevationFetches = 0;
            this.MAX_ELEVATION_FETCHES = 4;
            this.initWorker();
        }

        this.onTileHeightAppliedCallbacks = [];
    }

    key(z, virtX, y) {
        return `${z},${virtX},${y}`;
    }

    /* ---- основной метод, вызывается из Core.maybeUpdateVisibleTiles ---- */
    update(camera, controlsTarget, continuousZoom, worldGroupPos) {
        this.frame++;
        const idealZ = this.engine.currentDiscreteZoom;

        const dist = camera.position.distanceTo(controlsTarget);
        const margin = this.engine.TILE_MARGIN;
        const tileSize = this.engine.WORLD_SIZE / Math.pow(2, idealZ);
        const maxTile = (1 << idealZ) - 1;
        const vFov = (camera.fov * Math.PI) / 180;
        const aspect = camera.aspect;
        const hh = dist * Math.tan(vFov / 2) * aspect + margin * tileSize;
        const hv = dist * Math.tan(vFov / 2) + margin * tileSize;
        const minX = controlsTarget.x - hh, maxX = controlsTarget.x + hh;
        const minZ = controlsTarget.z - hv, maxZ = controlsTarget.z + hv;
        const off = worldGroupPos;
        const xMin = Math.floor((minX - off.x + this.engine.MAX_MERCATOR) / tileSize);
        const xMax = Math.floor((maxX - off.x + this.engine.MAX_MERCATOR) / tileSize);
        const yMin = Math.max(0, Math.floor((minZ - off.z + this.engine.MAX_MERCATOR) / tileSize));
        const yMax = Math.min(maxTile, Math.floor((maxZ - off.z + this.engine.MAX_MERCATOR) / tileSize));

        const visibleKeys = new Set();
        for (let y = yMin; y <= yMax; y++) {
            for (let vx = xMin; vx <= xMax; vx++) {
                visibleKeys.add(getVirtKey(idealZ, vx, y));
            }
        }

        const renderSet = new Set();
        for (const k of visibleKeys) {
            const [, vx, y] = k.split(',').map(Number);

            // Всегда пытаемся загрузить идеальный тайл (ensureTile стартует загрузку при необходимости)
            const inst = this.ensureTile(idealZ, vx, y);

            if (inst.ready) {
                renderSet.add(k);
                continue;
            }

            // 1. Покрытие потомками (отдаление) – только чтение кэша, без загрузок
            const fullyCovered = this.collectCover(idealZ, vx, y, renderSet);

            // 2. Если потомки не закрыли всю область, добавляем предка (приближение / края)
            if (!fullyCovered) {
                const anc = this.findReadyAncestor(idealZ, vx, y);
                if (anc) renderSet.add(this.key(anc.z, anc.virtX, anc.y));
            }
        }

        // Переключение видимости
        for (const [k, inst] of this.tiles) {
            if (!inst.mesh) continue;
            const show = renderSet.has(k);
            if (inst.mesh.visible !== show) inst.mesh.visible = show;
            if (show) inst.lastUsed = this.frame;
        }

        this.gc(renderSet);

        return idealZ;
    }

    /** Рекурсивно собирает готовых потомков тайла в renderSet (только чтение) */
    collectCover(z, virtX, y, renderSet, depth = 0) {
        const k = this.key(z, virtX, y);
        const inst = this.tiles.get(k);
        if (inst && inst.ready) {
            renderSet.add(k);
            return true;
        }
        if (depth >= MAX_COVER_DEPTH) return false;
        let full = true;
        for (let dx = 0; dx < 2; dx++) {
            for (let dy = 0; dy < 2; dy++) {
                const covered = this.collectCover(
                    z + 1, virtX * 2 + dx, y * 2 + dy, renderSet, depth + 1
                );
                full = covered && full;
            }
        }
        return full;
    }

    findReadyAncestor(z, virtX, y) {
        for (let dz = 1; dz <= ANCESTOR_FALLBACK && z - dz >= this.engine.MIN_ZOOM; dz++) {
            const az = z - dz;
            const ax = virtX >> dz;
            const ay = y >> dz;
            const inst = this.ensureTile(az, ax, ay);
            if (inst.ready) return inst;
        }
        return null;
    }

    ensureTile(z, virtX, y) {
        const k = this.key(z, virtX, y);
        let inst = this.tiles.get(k);
        if (inst) {
            inst.lastUsed = this.frame;
            return inst;
        }
        inst = {
            z, virtX, y,
            mesh: null,
            geometry: null,
            ready: false,
            failed: false,
            loading: true,
            texUrl: null,
            lastUsed: this.frame,
            heightsApplied: false,
            elevationAppliedLevel: 0,
            expectsElevation: false
        };
        this.tiles.set(k, inst);
        this.loadTile(inst);
        return inst;
    }

    async loadTile(inst) {
        const k = this.key(inst.z, inst.virtX, inst.y);
        try {
            const srcX = ((inst.virtX % (1 << inst.z)) + (1 << inst.z)) % (1 << inst.z);
            const srcKey = getSrcKey(inst.z, srcX, inst.y);
            const texUrl = this.engine.getTextureUrl(inst.z, srcX, inst.y);

            if (this.hasElevation && inst.z >= this.engine.MIN_RELIEF_Z && inst.z <= this.engine.MAX_RELIEF_Z) {
                const elevUrl = this.engine.getElevationUrl(inst.z, srcX, inst.y);
                if (elevUrl) this.srcKeyToElevUrl.set(srcKey, elevUrl);
            }

            const texture = await this.loadTextureAsync(texUrl);
            if (this.tiles.get(k) !== inst) {
                this.releaseTexture(texUrl);
                return;
            }

            const mesh = this.createTileMesh(inst, texture);
            inst.mesh = mesh;
            inst.geometry = mesh.geometry;
            inst.texUrl = texUrl;
            inst.loading = false;

            this.engine.worldGroup.add(mesh);

            if (this.hasElevation && this.shouldRequestElevation(inst)) {
                inst.expectsElevation = true;
                this.requestElevation(inst);
            } else {
                inst.ready = true;
            }
        } catch (err) {
            if (this.tiles.get(k) !== inst) return;
            console.warn(`Tile load error ${inst.z}/${inst.virtX}/${inst.y}:`, err.message);
            inst.loading = false;
            inst.failed = true;
            inst.ready = true;
        }
    }

    shouldRequestElevation(inst) {
        return inst.z >= this.engine.MIN_RELIEF_Z;
    }

    createTileMesh(inst, texture) {
        const { z, virtX, y } = inst;
        const tileSize = this.engine.WORLD_SIZE / Math.pow(2, z);
        const seg = this.hasElevation ? this.engine.SEGMENTS : 1;
        const originX = virtX * tileSize - this.engine.MAX_MERCATOR;
        const originZ = getOriginZ(y, tileSize, this.engine.MAX_MERCATOR);

        let geometry;
        if (!this.hasElevation && this.flatTileGeometry) {
            geometry = this.flatTileGeometry.clone();
            geometry.rotateX(-Math.PI / 2);
            geometry.translate(originX + tileSize / 2, 0, originZ + tileSize / 2);
        } else {
            geometry = new THREE.PlaneGeometry(tileSize, tileSize, seg, seg);
            geometry.rotateX(-Math.PI / 2);
            geometry.translate(originX + tileSize / 2, 0, originZ + tileSize / 2);
        }

        const mat = new THREE.MeshBasicMaterial({
            map: texture,
            depthWrite: this.hasElevation,
            depthTest: this.hasElevation
        });

        const mesh = new THREE.Mesh(geometry, mat);
        mesh.position.y = z * LEVEL_Y_STEP;
        mesh.renderOrder = z;
        mesh.visible = false;
        return mesh;
    }

    createStaticTileMesh(tileSize, originX, originZ, texture) {
        const geom = new THREE.PlaneGeometry(tileSize, tileSize, 1, 1);
        geom.rotateX(-Math.PI / 2);
        geom.translate(originX + tileSize / 2, -1.5, originZ + tileSize / 2);
        const mat = new THREE.MeshBasicMaterial({
            color: 0xffffff,
            map: texture,
            depthWrite: false,
            depthTest: false
        });
        const mesh = new THREE.Mesh(geom, mat);
        mesh.renderOrder = -2;
        return mesh;
    }

    /* ---- текстуры ---- */
    async loadTextureAsync(url) {
        if (!url) return null;
        if (this.textureCache.has(url)) {
            const e = this.textureCache.get(url);
            e.refs++;
            return e.texture;
        }
        const promise = new Promise((resolve) => {
            this.textureLoader.load(url, tex => {
                tex.colorSpace = THREE.SRGBColorSpace;
                resolve(tex);
            }, undefined, () => resolve(null));
        });
        const texture = await promise;
        if (!texture) return null;
        this.textureCache.set(url, { texture, refs: 1 });
        return texture;
    }

    releaseTexture(url) {
        if (!url) return;
        const e = this.textureCache.get(url);
        if (!e) return;
        e.refs--;
        if (e.refs <= 0) {
            e.texture.dispose();
            this.textureCache.delete(url);
        }
    }

    /* ---- высоты ---- */
    async requestElevation(inst) {
        const k = this.key(inst.z, inst.virtX, inst.y);
        try {
            const srcX = ((inst.virtX % (1 << inst.z)) + (1 << inst.z)) % (1 << inst.z);
            const srcKey = getSrcKey(inst.z, srcX, inst.y);
            const elevUrl = this.srcKeyToElevUrl.get(srcKey);
            const tileSize = this.engine.WORLD_SIZE / Math.pow(2, inst.z);
            const originX = inst.virtX * tileSize - this.engine.MAX_MERCATOR;
            const originZ = getOriginZ(inst.y, tileSize, this.engine.MAX_MERCATOR);

            let heights;
            if (elevUrl) {
                heights = await this.getDirectElevData(srcKey, elevUrl, tileSize, originX, originZ);
            } else {
                heights = await this.getFallbackElevation(inst);
            }
            if (this.tiles.get(k) !== inst || !inst.mesh) return;
            this.applyHeightsToGeometry(inst, heights);
            inst.ready = true;
        } catch (err) {
            if (this.tiles.get(k) !== inst) return;
            console.warn(`Elevation error ${inst.z}/${inst.virtX}/${inst.y}:`, err.message);
            inst.ready = true;
        }
    }

    async getDirectElevData(srcKey, elevUrl, tileSize, originX, originZ) {
        const heightScale = this.getElevationHeightScale();
        if (this.parentElevCache.has(srcKey)) {
            const imageData = this.parentElevCache.get(srcKey);
            if (imageData) {
                return (await this.scheduleWorkerJob('computeFromImageData', {
                    imageData, tileSize, originX, originZ,
                    segments: this.engine.SEGMENTS, heightScale
                })).heights;
            }
        }

        if (this.elevDirectPromises.has(srcKey)) {
            return this.elevDirectPromises.get(srcKey);
        }

        const executeJob = async () => {
            this.activeElevationFetches++;
            try {
                const result = await this.scheduleWorkerJob('computeFromUrl', {
                    url: elevUrl, tileSize, originX, originZ,
                    segments: this.engine.SEGMENTS, heightScale
                });
                if (result.imageData) this.parentElevCache.set(srcKey, result.imageData);
                return result.heights;
            } finally {
                this.activeElevationFetches--;
                this._processElevationQueue();
            }
        };

        const promise = new Promise((resolve, reject) => {
            if (this.activeElevationFetches < this.MAX_ELEVATION_FETCHES) {
                executeJob().then(resolve).catch(reject);
            } else {
                this.elevationQueue.push({ execute: executeJob, resolve, reject });
            }
        });

        this.elevDirectPromises.set(srcKey, promise);
        promise.finally(() => this.elevDirectPromises.delete(srcKey));
        return promise;
    }

    _processElevationQueue() {
        while (this.activeElevationFetches < this.MAX_ELEVATION_FETCHES && this.elevationQueue.length > 0) {
            const { execute, resolve, reject } = this.elevationQueue.shift();
            execute().then(resolve).catch(reject);
        }
    }

    async getFallbackElevation(inst) {
        let fz = inst.z - 1;
        while (fz > this.engine.MAX_RELIEF_Z) fz--;
        if (fz < this.engine.MIN_RELIEF_Z) throw new Error('No elevation fallback');

        const srcX = ((inst.virtX % (1 << inst.z)) + (1 << inst.z)) % (1 << inst.z);
        const scale = 1 << (inst.z - fz);
        const pSrcX = Math.floor(srcX / scale);
        const pY = Math.floor(inst.y / scale);

        const parentData = await this.getParentElevData(fz, pSrcX, pY);
        if (!parentData) throw new Error('No parent data');

        const tileSize = this.engine.WORLD_SIZE / Math.pow(2, inst.z);
        const originX = inst.virtX * tileSize - this.engine.MAX_MERCATOR;
        const originZ = getOriginZ(inst.y, tileSize, this.engine.MAX_MERCATOR);
        const dx = srcX % scale, dy = inst.y % scale;

        const imageDataCopy = new ImageData(
            new Uint8ClampedArray(parentData.data),
            parentData.width,
            parentData.height
        );
        const result = await this.scheduleWorkerJob('computeFromParent', {
            imageData: imageDataCopy,
            tileSize,
            originX,
            originZ,
            segments: this.engine.SEGMENTS,
            scale,
            dx,
            dy,
            heightScale: this.getElevationHeightScale()
        });
        return result.heights;
    }

    async getParentElevData(z, srcX, y) {
        if (z < this.engine.MIN_RELIEF_Z || z > this.engine.MAX_RELIEF_Z) return null;
        const key = `${z},${srcX},${y}`;
        if (this.parentElevCache.has(key)) return this.parentElevCache.get(key);
        if (this.parentElevPromises.has(key)) return this.parentElevPromises.get(key);

        const promise = new Promise((resolve) => {
            const img = new Image();
            img.crossOrigin = 'anonymous';
            img.onload = () => {
                const canvas = document.createElement('canvas');
                canvas.width = canvas.height = this.engine.TILE_PIXELS;
                const ctx2d = canvas.getContext('2d');
                ctx2d.drawImage(img, 0, 0);
                const imgData = ctx2d.getImageData(0, 0, this.engine.TILE_PIXELS, this.engine.TILE_PIXELS);
                this.parentElevCache.set(key, imgData);
                this.parentElevPromises.delete(key);
                resolve(imgData);
            };
            img.onerror = () => {
                this.parentElevCache.set(key, null);
                this.parentElevPromises.delete(key);
                resolve(null);
            };
            img.src = this.engine.getElevationUrl(z, srcX, y);
        });
        this.parentElevPromises.set(key, promise);
        return promise;
    }

    applyHeightsToGeometry(inst, heights) {
        const pos = inst.geometry.attributes.position.array;
        for (let i = 0; i < heights.length; i++) pos[i * 3 + 1] = heights[i];
        inst.geometry.attributes.position.needsUpdate = true;
        inst.geometry.computeVertexNormals();

        this.syncTileWithNeighbors(inst);

        inst.heightsApplied = true;
        inst.ready = true;

        for (const cb of this.onTileHeightAppliedCallbacks) {
            try { cb(inst); } catch (e) { console.warn('Tile overlay callback error', e); }
        }
    }

    syncTileWithNeighbors(inst) {
        const neighbors = [[1,0], [-1,0], [0,1], [0,-1]];
        for (const [dx, dy] of neighbors) {
            const nVirtX = inst.virtX + dx, nY = inst.y + dy;
            const nKey = this.key(inst.z, nVirtX, nY);
            const nInst = this.tiles.get(nKey);
            if (nInst && nInst.heightsApplied) {
                this.syncEdgesBetween(inst, nInst, dx, dy);
            }
        }
    }

    syncEdgesBetween(instA, instB, dx, dy) {
        const posA = instA.geometry.attributes.position.array;
        const posB = instB.geometry.attributes.position.array;
        const seg = this.engine.SEGMENTS;
        const pairs = [];
        if (dx === 1 && dy === 0) {
            for (let r = 0; r <= seg; r++) pairs.push([r * (seg + 1) + seg, r * (seg + 1)]);
        } else if (dx === -1 && dy === 0) {
            for (let r = 0; r <= seg; r++) pairs.push([r * (seg + 1), r * (seg + 1) + seg]);
        } else if (dx === 0 && dy === -1) {
            for (let c = 0; c <= seg; c++) pairs.push([c, seg * (seg + 1) + c]);
        } else if (dx === 0 && dy === 1) {
            for (let c = 0; c <= seg; c++) pairs.push([seg * (seg + 1) + c, c]);
        }
        for (const [iA, iB] of pairs) {
            const avg = (posA[iA * 3 + 1] + posB[iB * 3 + 1]) / 2;
            posA[iA * 3 + 1] = avg;
            posB[iB * 3 + 1] = avg;
        }
        instA.geometry.attributes.position.needsUpdate = true;
        instB.geometry.attributes.position.needsUpdate = true;
    }

    getElevationHeightScale() {
        const layerWithElev = this.engine.layers.find(l => l.elevation);
        return layerWithElev ? layerWithElev.heightScale : DEFAULTS.HEIGHT_SCALE;
    }

    prefetchParentElevations(center, z, worldGroupPos) {
        if (!this.hasElevation || z < this.engine.MIN_RELIEF_Z || z > this.engine.MAX_RELIEF_Z) return;
        const tileSize = this.engine.WORLD_SIZE / Math.pow(2, z);
        const maxTile = (1 << z) - 1;
        const margin = 2;
        const xMin = Math.floor((center.x - tileSize * margin - worldGroupPos.x + this.engine.MAX_MERCATOR) / tileSize);
        const xMax = Math.floor((center.x + tileSize * margin - worldGroupPos.x + this.engine.MAX_MERCATOR) / tileSize);
        for (let y = 0; y <= maxTile; y++) {
            const oz = getOriginZ(y, tileSize, this.engine.MAX_MERCATOR) + worldGroupPos.z;
            if (oz + tileSize < center.z - tileSize * margin || oz > center.z + tileSize * margin) continue;
            for (let x = xMin; x <= xMax; x++) {
                this.getParentElevData(z, x, y).catch(() => {});
            }
        }
    }

    /* ---- LRU сборщик мусора ---- */
    gc(renderSet) {
        if (this.tiles.size <= MAX_CACHED_TILES) return;
        const candidates = [];
        for (const [k, inst] of this.tiles) {
            if (renderSet.has(k) || inst.loading) continue;
            candidates.push(inst);
        }
        candidates.sort((a, b) => a.lastUsed - b.lastUsed);
        let budget = this.tiles.size - MAX_CACHED_TILES;
        for (const inst of candidates) {
            if (budget-- <= 0) break;
            this.disposeTile(inst);
        }
    }

    disposeTile(inst) {
        this.tiles.delete(this.key(inst.z, inst.virtX, inst.y));
        if (inst.mesh) {
            this.engine.worldGroup.remove(inst.mesh);
            inst.mesh.geometry.dispose();
            inst.mesh.material.dispose();
        }
        if (inst.texUrl) this.releaseTexture(inst.texUrl);
    }

    /* ---- Worker (без изменений) ---- */
    initWorker() {
        const TILE_PIXELS = this.engine.TILE_PIXELS;
        const workerCode = `
            const TILE_PIXELS = ${TILE_PIXELS};
            self.onmessage = async function(e) {
                const { id, type, payload } = e.data;
                try {
                    if (type === 'computeFromImageData') {
                        const { imageData, tileSize, originX, originZ, segments, heightScale } = payload;
                        const heights = computeHeights(imageData.data, tileSize, originX, originZ, segments, heightScale);
                        self.postMessage({ id, result: { heights } }, [heights.buffer]);
                    } else if (type === 'computeFromUrl') {
                        const { url, tileSize, originX, originZ, segments, heightScale } = payload;
                        const result = await computeHeightsFromUrl(url, tileSize, originX, originZ, segments, heightScale);
                        self.postMessage({ id, result: { heights: result.heights, imageData: result.imageData } }, [result.heights.buffer]);
                    } else if (type === 'computeFromParent') {
                        const { imageData, tileSize, originX, originZ, segments, scale, dx, dy, heightScale } = payload;
                        const heights = computeHeightsFromParent(imageData, tileSize, originX, originZ, segments, scale, dx, dy, heightScale);
                        self.postMessage({ id, result: { heights } }, [heights.buffer]);
                    }
                } catch (err) {
                    self.postMessage({ id, error: err.message });
                }
            };

            async function computeHeightsFromUrl(url, tileSize, originX, originZ, segments, heightScale) {
                const resp = await fetch(url);
                if (!resp.ok) throw new Error('Fetch failed');
                const blob = await resp.blob();
                const imgBitmap = await createImageBitmap(blob);
                const canvas = new OffscreenCanvas(TILE_PIXELS, TILE_PIXELS);
                const ctx = canvas.getContext('2d');
                ctx.drawImage(imgBitmap, 0, 0);
                imgBitmap.close();
                const imageData = ctx.getImageData(0, 0, TILE_PIXELS, TILE_PIXELS);
                const heights = computeHeights(imageData.data, tileSize, originX, originZ, segments, heightScale);
                return { heights, imageData };
            }

            function computeHeightsFromParent(imageData, tileSize, originX, originZ, segments, scale, dx, dy, heightScale) {
                const data = imageData.data;
                return computeHeightsGeneric(segments, (u, v) => {
                    const uP = (dx + u) / scale;
                    const vP = (dy + v) / scale;
                    const sx = Math.round(uP * (TILE_PIXELS-1));
                    const sy = Math.round(vP * (TILE_PIXELS-1));
                    const idx = (sy * TILE_PIXELS + sx) * 4;
                    return ((data[idx]*256 + data[idx+1] + data[idx+2]/256) - 32768) * heightScale;
                });
            }

            function computeHeights(pixelData, tileSize, originX, originZ, segments, heightScale) {
                const data = pixelData;
                return computeHeightsGeneric(segments, (u, v) => {
                    const sx = Math.round(u * (TILE_PIXELS-1));
                    const sy = Math.round(v * (TILE_PIXELS-1));
                    const idx = (sy * TILE_PIXELS + sx) * 4;
                    return ((data[idx]*256 + data[idx+1] + data[idx+2]/256) - 32768) * heightScale;
                });
            }

            function computeHeightsGeneric(segments, sampleFn) {
                const count = (segments + 1) * (segments + 1);
                const heights = new Float32Array(count);
                for (let row = 0; row <= segments; row++) {
                    for (let col = 0; col <= segments; col++) {
                        const u = col / segments;
                        const v = row / segments;
                        heights[row * (segments+1) + col] = sampleFn(u, v);
                    }
                }
                return heights;
            }
        `;
        const blob = new Blob([workerCode], { type: 'application/javascript' });
        this.worker = new Worker(URL.createObjectURL(blob));
        this.worker.onmessage = (e) => {
            const { id, result, error } = e.data;
            if (this.workerPromises.has(id)) {
                const { resolve, reject } = this.workerPromises.get(id);
                this.workerPromises.delete(id);
                this.activeWorkerJobs--;
                this.processWorkerQueue();
                if (error) reject(new Error(error));
                else resolve(result);
            } else {
                this.activeWorkerJobs--;
                this.processWorkerQueue();
            }
        };
        this.pendingWorkerJobs = [];
        this.activeWorkerJobs = 0;
        this.nextJobId = 1;
        this.workerPromises = new Map();
    }

    processWorkerQueue() {
        while (this.activeWorkerJobs < this.engine.MAX_WORKER_REQUESTS && this.pendingWorkerJobs.length > 0) {
            const job = this.pendingWorkerJobs.shift();
            this.activeWorkerJobs++;
            this.worker.postMessage({ id: job.id, type: job.type, payload: job.payload });
        }
    }

    scheduleWorkerJob(type, payload) {
        const id = this.nextJobId++;
        const promise = new Promise((resolve, reject) => {
            this.workerPromises.set(id, { resolve, reject });
            this.pendingWorkerJobs.push({ id, type, payload });
            this.processWorkerQueue();
        });
        return promise;
    }
}