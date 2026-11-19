// CoreCrs.ts
import { Projections } from './Projections.js';
export const CoreCrsMixin = {
    getCrs() { return this.projection.code; },
    getProjection() { return this.projection; },
    getInputCrs() { return this.inputCRS?.code ?? null; },
    setInputCrs(c) { this.inputCRS = typeof c === 'string' ? Projections.getRaw(c) : c; },
    getTileCrs() { return this.tileCRS?.code ?? null; },
    setCrs(crs, opts = {}) {
        if (this._disposed)
            return;
        const newProj = typeof crs === 'string' ? Projections.getWorld(crs) : crs;
        if (!newProj)
            throw new Error(`setCrs: неизвестная проекция ${crs}`);
        if (newProj === this.projection)
            return;
        const { preserveZoom = true, preservePanOffset = false, silent = false, } = opts;
        // ── 1. Снять каноническое состояние ───────────────────────────────
        const centerLonLat = this.getCenter(); // [lon, lat]
        const savedZoom = this.continuousZoom;
        const savedPitch = this.getPitch();
        const savedBearing = this.getBearing();
        const savedPadding = this._padding; // переиспользуем ниже
        // Снимок видимости/прозрачности объектных слоёв — на случай, если
        // removeFromMap сбрасывает эти флаги.
        const dynState = this._dynamicLayers.map(l => ({
            layer: l,
            visible: typeof l.isVisible === 'function' ? l.isVisible() : (l.visible !== false),
        }));
        // ── 2. Отменить анимации и инерцию ────────────────────────────────
        this._resetInertia();
        if (this._cameraAnimFrame !== null)
            cancelAnimationFrame(this._cameraAnimFrame);
        this._cameraAnimation = null;
        this._cameraAnimFrame = null;
        this._cameraAnimations.pitch = null;
        this._cameraAnimations.bearing = null;
        this._zoomPivotActive = false;
        if (this.controls)
            this.controls.enableDamping = this._controlsDampingWasEnabled;
        // ── 3. Сбросить тайловые меши (воркеры НЕ трогаем) ────────────────
        for (const mgr of this._tileManagers) {
            try {
                mgr._disposeAllTiles?.();
            }
            catch (e) {
                console.warn(e);
            }
            try {
                mgr.textureCache?.clear();
            }
            catch { }
            try {
                mgr._staticBgAllowed = false;
            }
            catch { }
            try {
                mgr._inFlightTextures?.clear?.();
            }
            catch { }
        }
        // ── 4. Снять статический фон ──────────────────────────────────────
        if (this.staticBgGroup) {
            while (this.staticBgGroup.children.length > 0) {
                const c = this.staticBgGroup.children[0];
                this.staticBgGroup.remove(c);
                c.geometry?.dispose?.();
                c.material?.map?.dispose?.();
                c.material?.dispose?.();
            }
            this.staticBgGroup.visible = false;
        }
        // ── 5. Отцепить объектные слои ────────────────────────────────────
        for (const l of this._dynamicLayers) {
            if (typeof l.reproject === 'function')
                continue; // ← пропускаем
            try {
                l.removeFromMap?.();
            }
            catch (e) {
                console.warn(e);
            }
            l._map = null;
        }
        // сами объекты сохраняем — перецепим ниже, порядок сохранится
        // ── 6. Поменять проекцию и производные ────────────────────────────
        this.projection = newProj;
        this.R = newProj.meanRadius; // см. «R» ниже
        this._refreshExtents(); // WORLD_SIZE / MAX_MERCATOR / WORLD_EXTENT
        this._calibrateBaseDistance?.(); // BASE_DISTANCE
        // ── 7. Сбросить pan-офсет и world-координатные кеши ───────────────
        if (!preservePanOffset)
            this.worldGroup.position.set(0, 0, 0);
        this._lastBoundsCheck = null;
        this._surfaceMaxHeightCache?.clear?.();
        this.globalElevCache?.clear?.();
        this.lastVisibleUpdateTime = 0;
        this._firstRenderDone = false;
        // ── 8. Пересобрать реестр растра (tileCRS, deformedTiles, hasTileLayers)
        this._rebuildRasterRegistry();
        // ── 9. Перецепить объектные слои в исходном порядке ───────────────
        const reattached = [];
        for (const { layer } of dynState) {
            try {
                if (typeof layer.reproject === 'function') {
                    layer.reproject(); // ← Layer.reproject → SpatialObject.reproject
                }
                else {
                    layer.addTo(this); // ← Graticule и прочие
                }
                reattached.push(layer);
            }
            catch (e) {
                console.warn('setCrs: reattach/reproject failed', layer, e);
            }
        }
        this._dynamicLayers = reattached;
        // ── 10. Восстановить порядок/видимость ────────────────────────────
        this._rebuildLayerStack();
        for (const s of dynState) {
            if (s.visible === false)
                this.setLayerVisible(s.layer, false);
        }
        // ── 11. Пересоздать статический фон ───────────────────────────────
        if (this._rasterLayers.length > 0 && this.staticBgZoom > 0) {
            this.createStaticBackgroundLayer();
        }
        // ── 12. Синхронизировать view ─────────────────────────────────────
        const [wx, wz] = this.projectLonLat(centerLonLat[0], centerLonLat[1]);
        this.view.centerLonLat = centerLonLat;
        this.view.center = [wx, wz];
        this.view.projection = this.projection.code;
        // ── 13. Восстановить камеру мгновенно ─────────────────────────────
        this.jumpTo({
            center: centerLonLat,
            zoom: preserveZoom ? savedZoom : this.peekIdealZoom(savedZoom),
            pitch: savedPitch,
            bearing: savedBearing,
        });
        if (savedPadding)
            this._applyPadding(savedPadding);
        // ── 14. Text / Popup — пересоздать (см. ниже) ─────────────────────
        if (this.textManager?.reset)
            this.textManager.reset();
        if (this.popupManager?.reset)
            this.popupManager.reset();
        // ── 15. Форсировать перестройку тайлов и clamp ────────────────────
        this.maybeUpdateVisibleTiles(true);
        this._enforceMaxBounds();
        // ── 16. Событие ───────────────────────────────────────────────────
        if (!silent) {
            try {
                this.emit?.('crs-changed', { crs: this.projection.code });
            }
            catch { }
        }
    }
};
