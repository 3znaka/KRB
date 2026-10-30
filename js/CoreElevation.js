// CoreElevation.ts
import { THREE } from './js_TP/tpb.js';
import { DEFAULTS, getVirtKey } from './Utils.js';
export const CoreElevationMixin = {
    get hasElevation() {
        if (this._elevationProvider)
            return true;
        if (this._elevationLayer)
            return true;
        const mgrs = this._tileManagers;
        if (!mgrs)
            return false;
        return mgrs.some((m) => !!m.layer?.elevation);
    },
    get elevationProvider() { return this._elevationProvider; },
    setElevationProvider(provider) {
        if (this._elevationProvider === provider)
            return;
        this._elevationProvider = provider;
        for (const mgr of this._tileManagers)
            mgr.setElevationProvider(provider);
        this._surfaceMaxHeightCache?.clear();
    },
    enableGeotiffElevation(layer) {
        if (!layer)
            return;
        this.setElevationProvider(layer);
        if (this._disposed)
            return;
        if (!this.hasTileLayers)
            this.hasTileLayers = true;
        this.lastVisibleUpdateTime = 0;
        this.maybeUpdateVisibleTiles(true);
    },
    disableGeotiffElevation() {
        this.setElevationProvider(null);
        if (this._disposed)
            return;
        this.lastVisibleUpdateTime = 0;
        this.maybeUpdateVisibleTiles(true);
    },
    _measureTileScreenSize(z, worldX, worldZ, crs) {
        const [txf, tyf] = this.worldToTileIndex(worldX, worldZ, z, crs);
        if (!Number.isFinite(txf) || !Number.isFinite(tyf))
            return null;
        const tx = Math.floor(txf);
        const ty = Math.floor(tyf);
        const maxTile = (1 << z) - 1;
        if (ty < 0 || ty > maxTile)
            return null;
        const [x0, z0] = this.tileIndexToWorld(tx, ty, z, crs);
        const [x1, z1] = this.tileIndexToWorld(tx + 1, ty + 1, z, crs);
        if (![x0, z0, x1, z1].every(Number.isFinite))
            return null;
        const canvas = this.renderer.domElement;
        const W = canvas.clientWidth, H = canvas.clientHeight;
        if (W <= 0 || H <= 0)
            return null;
        this.camera.updateMatrixWorld();
        const v = new THREE.Vector3();
        let minSX = Infinity, maxSX = -Infinity, minSY = Infinity, maxSY = -Infinity;
        const corners = [[x0, z0], [x1, z0], [x0, z1], [x1, z1]];
        for (const [wx, wz] of corners) {
            v.set(wx, 0, wz);
            v.project(this.camera);
            if (!Number.isFinite(v.x) || !Number.isFinite(v.y))
                return null;
            const sx = (v.x + 1) * 0.5 * W;
            const sy = (1 - v.y) * 0.5 * H;
            if (sx < minSX)
                minSX = sx;
            if (sx > maxSX)
                maxSX = sx;
            if (sy < minSY)
                minSY = sy;
            if (sy > maxSY)
                maxSY = sy;
        }
        const width = maxSX - minSX, height = maxSY - minSY;
        if (!Number.isFinite(width) || !Number.isFinite(height))
            return null;
        if (width <= 0 || height <= 0)
            return null;
        return { width, height, size: Math.max(width, height) };
    },
    _calibrateBaseDistance() {
        if (this.projection.isMercator)
            return;
        const refLayer = this._rasterLayers[0] ?? null;
        if (!refLayer)
            return;
        const z = this.currentDiscreteZoom;
        const target = this.controls.target;
        const crs = refLayer.crs ?? 'EPSG:3857';
        const m = this._measureTileScreenSize(z, target.x, target.z, crs);
        if (!m || !Number.isFinite(m.size) || m.size <= 0.01) {
            console.warn(`KrbMap: не удалось измерить экранный размер тайла для ${this.projection.code}, BASE_DISTANCE оставлен по умолчанию. Укажите options.baseDistance вручную, если масштаб выглядит неверно.`);
            return;
        }
        const factor = m.size / this.TILE_PIXELS;
        if (!Number.isFinite(factor) || factor <= 0)
            return;
        const oldBD = this.BASE_DISTANCE;
        const oldExtent = this.WORLD_EXTENT;
        const newBD = oldBD * factor;
        const newExtent = this.WORLD_SIZE * factor;
        if (!Number.isFinite(newBD) || newBD <= 0 || !Number.isFinite(newExtent) || newExtent <= 0)
            return;
        this.BASE_DISTANCE = newBD;
        this.WORLD_EXTENT = newExtent;
        console.info(`KrbMap: BASE_DISTANCE калиброван для ${this.projection.code}: ${oldBD.toFixed(0)} → ${newBD.toFixed(0)} (factor=${factor.toFixed(3)}), WORLD_EXTENT ${oldExtent.toFixed(0)} → ${newExtent.toFixed(0)}`);
        const newDist = this.getTargetDistanceForZoom(this.continuousZoom);
        const dir = new THREE.Vector3().subVectors(this.camera.position, target);
        if (dir.lengthSq() < 1e-6)
            return;
        dir.normalize().multiplyScalar(newDist);
        this.camera.position.copy(target).add(dir);
        this.camera.lookAt(target);
        this.controls.update();
    },
    _setSurfaceMaxHeight(key, value) {
        this._surfaceMaxHeightCache.delete(key);
        this._surfaceMaxHeightCache.set(key, value);
        while (this._surfaceMaxHeightCache.size > this._surfaceMaxHeightCacheMaxSize) {
            const oldestKey = this._surfaceMaxHeightCache.keys().next().value;
            this._surfaceMaxHeightCache.delete(oldestKey);
        }
    },
    getSurfaceMaxHeight(worldX, worldZ) {
        if (!this.hasElevation)
            return 0;
        const provider = this._elevationProvider;
        if (provider && typeof provider.getTileMaxHeight === 'function') {
            for (const mgr of this._tileManagers) {
                if (!mgr.hasElevation)
                    continue;
                const elevLayer = mgr.layer;
                const crs = elevLayer?.crs ?? 'EPSG:3857';
                const z = this.getTileZoom(elevLayer);
                const [tx, ty] = this.worldToTileIndex(worldX, worldZ, z, crs);
                if (!Number.isFinite(tx) || !Number.isFinite(ty))
                    continue;
                const h = provider.getTileMaxHeight(z, Math.floor(tx), Math.floor(ty), this.SEGMENTS);
                if (Number.isFinite(h))
                    return h;
            }
        }
        let best = 0;
        for (let mi = 0; mi < this._tileManagers.length; mi++) {
            const mgr = this._tileManagers[mi];
            if (!mgr.hasElevation)
                continue;
            const h = this._sampleMaxHeightFromManager(mi, mgr, worldX, worldZ);
            if (h > best)
                best = h;
        }
        return best;
    },
    _sampleMaxHeightFromManager(mgrIdx, mgr, worldX, worldZ) {
        const elevLayer = mgr.layer;
        const crs = elevLayer?.crs ?? 'EPSG:3857';
        const z = this.getTileZoom(elevLayer);
        const maxTile = (1 << z) - 1;
        const [tx, ty] = this.worldToTileIndex(worldX, worldZ, z, crs);
        if (!Number.isFinite(tx) || !Number.isFinite(ty))
            return 0;
        const virtX = Math.floor(tx);
        const y = Math.floor(ty);
        if (y < 0 || y > maxTile)
            return 0;
        const vk = `${mgrIdx},${getVirtKey(z, virtX, y)}`;
        if (this._surfaceMaxHeightCache.has(vk))
            return this._surfaceMaxHeightCache.get(vk);
        const inst = mgr.tiles.get(getVirtKey(z, virtX, y));
        let maxY = 0;
        if (inst && inst.heightsApplied && inst.mesh) {
            const pos = inst.geometry.attributes.position.array;
            maxY = -Infinity;
            for (let i = 1; i < pos.length; i += 3)
                if (pos[i] > maxY)
                    maxY = pos[i];
            maxY += inst.mesh.position.y;
        }
        this._setSurfaceMaxHeight(vk, maxY);
        return maxY;
    },
    getSurfaceHeightAt(worldX, worldZ) {
        if (!this.hasElevation)
            return 0;
        const provider = this._elevationProvider;
        if (provider && typeof provider.sampleAtWorld === 'function') {
            const h = provider.sampleAtWorld(worldX, worldZ, this);
            if (h !== null && h !== undefined && Number.isFinite(h))
                return h;
        }
        for (const mgr of this._tileManagers) {
            if (!mgr.hasElevation)
                continue;
            if (mgr._elevationProvider)
                continue;
            const h = this._sampleHeightFromManager(mgr, worldX, worldZ);
            if (h !== null)
                return h;
        }
        return 0;
    },
    _sampleHeightFromManager(mgr, worldX, worldZ) {
        const elevLayer = mgr.layer;
        const crs = elevLayer?.crs ?? 'EPSG:3857';
        const zMax = this.getTileZoom(elevLayer);
        const zMin = Math.max(0, mgr._minElevationNativeZoom);
        for (let zz = zMax; zz >= zMin; zz--) {
            const h = this._sampleHeightAtZoom(mgr, worldX, worldZ, zz, crs);
            if (h !== null)
                return h;
        }
        return null;
    },
    _sampleHeightAtZoom(mgr, worldX, worldZ, z, crs) {
        const maxTile = (1 << z) - 1;
        const [tx, ty] = this.worldToTileIndex(worldX, worldZ, z, crs);
        if (!Number.isFinite(tx) || !Number.isFinite(ty))
            return null;
        const virtX = Math.floor(tx);
        const y = Math.floor(ty);
        if (y < 0 || y > maxTile)
            return null;
        const inst = mgr.tiles.get(getVirtKey(z, virtX, y));
        if (!inst || !inst.heightsApplied || !inst.mesh)
            return null;
        const u = tx - virtX, v = ty - y;
        const seg = this.SEGMENTS;
        const pos = inst.geometry.attributes.position.array;
        const rowStride = seg + 1;
        const col = Math.min(seg, Math.max(0, Math.floor(u * seg)));
        const row = Math.min(seg, Math.max(0, Math.floor(v * seg)));
        const nc = Math.min(seg, col + 1);
        const nr = Math.min(seg, row + 1);
        const h00 = pos[(row * rowStride + col) * 3 + 1];
        const h10 = pos[(row * rowStride + nc) * 3 + 1];
        const h01 = pos[(nr * rowStride + col) * 3 + 1];
        const h11 = pos[(nr * rowStride + nc) * 3 + 1];
        const fu = (u * seg) - col;
        const fv = (v * seg) - row;
        const h0 = h00 + (h10 - h00) * fu;
        const h1 = h01 + (h11 - h01) * fu;
        return h0 + (h1 - h0) * fv + inst.mesh.position.y;
    },
    ensureTileForPoint(worldX, worldZ) {
        for (const mgr of this._tileManagers) {
            if (!mgr.hasElevation)
                continue;
            const elevLayer = mgr.layer;
            const crs = elevLayer?.crs ?? 'EPSG:3857';
            const z = this.getTileZoom(elevLayer);
            const maxTile = (1 << z) - 1;
            const [tx, ty] = this.worldToTileIndex(worldX, worldZ, z, crs);
            if (!Number.isFinite(tx) || !Number.isFinite(ty))
                continue;
            const virtX = Math.floor(tx);
            const y = Math.floor(ty);
            if (y < 0 || y > maxTile)
                continue;
            mgr.ensureTile(z, virtX, y);
        }
    },
    get MIN_RELIEF_Z() {
        return this._elevationLayer?.minElevationNativeZoom ?? this._defaultMinReliefZ ?? DEFAULTS.MIN_RELIEF_Z;
    },
    get MAX_RELIEF_Z() {
        return this._elevationLayer?.maxElevationNativeZoom ?? this._defaultMaxReliefZ ?? DEFAULTS.MAX_RELIEF_Z;
    },
};
