import { Projections } from './Projections.js';
import { getOriginZ } from './Utils.js';
export const CoreLayersMixin = {
    _isLayerLinear(layer) {
        if (!layer)
            return true;
        const code = layer.crs ?? layer.projection ?? 'EPSG:3857';
        const crs = typeof code === 'string' ? Projections.get(code) : code;
        return crs === this.projection && this.projection.isMercator;
    },
    _getLayersInOrder() {
        return [...new Set([...this.layers, ...this._dynamicLayers])].filter(Boolean);
    },
    _getLayerIndex(layer) { return this._getLayersInOrder().indexOf(layer); },
    _getLayerRenderOrder(layer) {
        const stack = this._getLayersInOrder();
        const index = stack.indexOf(layer);
        return (index < 0 ? stack.length : index) * 1000;
    },
    _getDynamicLayerRenderOrder(layer) { return this._getLayerRenderOrder(layer); },
    _applyLayerRenderOrder(layer, newBase) {
        if (!layer)
            return;
        layer.baseRenderOrder = newBase;
        const mgr = this._tileManagers.find((m) => m.layer === layer);
        if (mgr) {
            for (const inst of mgr.tiles.values()) {
                if (inst.mesh)
                    inst.mesh.renderOrder = newBase + inst.z;
            }
        }
        if (typeof layer._applyRenderOrder === 'function')
            layer._applyRenderOrder(newBase);
    },
    _rebuildLayerStack() {
        this._getLayersInOrder().forEach((layer, index) => {
            this._applyLayerRenderOrder(layer, index * 1000);
        });
    },
    setLayerOrder(layer, index) {
        if (this._disposed || !Number.isFinite(index))
            return;
        const stack = this._getLayersInOrder();
        const currentIndex = stack.indexOf(layer);
        if (currentIndex < 0)
            return;
        const targetIndex = Math.max(0, Math.min(Math.trunc(index), stack.length - 1));
        if (currentIndex === targetIndex) {
            this._rebuildLayerStack();
            return;
        }
        const primaryCount = new Set(this.layers.filter(Boolean)).size;
        stack.splice(currentIndex, 1);
        stack.splice(targetIndex, 0, layer);
        this.layers.splice(0, this.layers.length, ...stack.slice(0, primaryCount));
        this._dynamicLayers.splice(0, this._dynamicLayers.length, ...stack.slice(primaryCount));
        this._rebuildLayerStack();
        this.maybeUpdateVisibleTiles(true);
    },
    bringToFront(layer) { this.setLayerOrder(layer, this._getLayersInOrder().length - 1); },
    sendToBack(layer) { this.setLayerOrder(layer, 0); },
    setLayerVisible(layer, visible) {
        if (this._disposed || !layer)
            return;
        const value = !!visible;
        if (typeof layer.setVisible === 'function')
            layer.setVisible(value);
        else
            layer.visible = value;
        const mgr = this._tileManagers.find((m) => m.layer === layer);
        if (mgr)
            mgr.setVisible(value);
        this.maybeUpdateVisibleTiles(true);
    },
    setLayerOpacity(layer, opacity) {
        const mgr = this._tileManagers.find((m) => m.layer === layer);
        if (!mgr)
            return;
        mgr.setOpacity(opacity);
        this.maybeUpdateVisibleTiles(true);
    },
    get tileManager() { return this._tileManagers?.[0] ?? null; },
    createStaticBackgroundLayer() {
        if (this._rasterLayers.length === 0)
            return;
        const bgLayer = this._rasterLayers[0];
        if (!this._isLayerLinear(bgLayer))
            return;
        while (this.staticBgGroup.children.length > 0) {
            const child = this.staticBgGroup.children[0];
            this.staticBgGroup.remove(child);
            if (child.geometry)
                child.geometry.dispose();
            if (child.material) {
                if (child.material.map)
                    child.material.map.dispose();
                child.material.dispose();
            }
        }
        const mgr = this._tileManagers[0];
        if (!mgr)
            return;
        const z = this.staticBgZoom;
        const tileSize = this.WORLD_SIZE / Math.pow(2, z);
        const maxTile = (1 << z) - 1;
        for (let y = 0; y <= maxTile; y++) {
            const originZ = getOriginZ(y, tileSize, this.MAX_MERCATOR);
            for (let x = 0; x <= maxTile; x++) {
                const originX = x * tileSize - this.MAX_MERCATOR;
                const texUrl = this.getTextureUrl(bgLayer, z, x, y);
                const mesh = mgr.createStaticTileMesh(tileSize, originX, originZ, null);
                this.staticBgGroup.add(mesh);
                mgr.loadTextureAsync(texUrl).then((tex) => {
                    if (this._disposed || !mgr || !this.staticBgGroup)
                        return;
                    if (tex && mesh.parent === this.staticBgGroup)
                        mgr.setMeshTexture(mesh, tex);
                }).catch(() => { });
            }
        }
    },
    maybeUpdateVisibleTiles(force = false) {
        if (this._disposed)
            return;
        const now = performance.now();
        const newZoom = this.peekIdealZoom(this.continuousZoom);
        const zoomChanged = newZoom !== this.currentDiscreteZoom;
        this.currentDiscreteZoom = newZoom;
        if (!force && !zoomChanged && now - this.lastVisibleUpdateTime < this.VISIBLE_UPDATE_THROTTLE)
            return;
        this.lastVisibleUpdateTime = now;
        if (!this._tileManagers.length)
            return;
        this.camera.updateMatrixWorld(true);
        this.worldGroup.updateMatrixWorld(true);
        for (const mgr of this._tileManagers) {
            mgr.update(this.camera, this.controls.target, this.continuousZoom, this.worldGroup.position);
        }
    },
};
