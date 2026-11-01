export const VectorTileDiagnosticsMixin = {
    async diagnoseAt(sceneX, sceneZ, idResultIn) {
        const map = this._map;
        if (!map) {
            console.warn('diagnoseAt: layer not attached');
            return;
        }
        const srcZ = this._lastSourceZoom;
        const TILE_ZOOM_OK = srcZ >= 0;
        const tileSize = TILE_ZOOM_OK ? map.WORLD_SIZE / (1 << srcZ) : 0;
        const clickLocalX = sceneX - map.worldGroup.position.x;
        const clickLocalZ = sceneZ - map.worldGroup.position.z;
        // ── 1. Базовое состояние ─────────────────────────────────────
        console.log('%c[VT DIAG] === START ===', 'font-weight:bold;color:#06f', {
            continuousZoom: map.continuousZoom,
            currentDiscreteZoom: map.currentDiscreteZoom,
            targetContinuousZoom: map.targetContinuousZoom,
            cameraPos: map.camera.position.toArray(),
            controlsTarget: map.controls.target.toArray(),
            worldGroupPos: map.worldGroup.position.toArray(),
            _generation: this._generation,
            _lastSourceZoom: this._lastSourceZoom,
            _transitionStyleZoom: this._transitionStyleZoom,
            _lastIs3d: this._lastIs3d,
            _tileCacheSize: this._tileCache.size,
            _oldTileGroupsSize: this._oldTileGroups?.size ?? 0,
            _groupCacheSize: this._groupCache.size,
            _pendingLoads: this._pendingLoads.size,
            _activeLoads: this._activeLoads,
            _queueLength: this._sortedLoadQueue.length,
            _lineMaterialsCount: this._lineMaterialsSet.size,
        });
        // ── 2. Identify ──────────────────────────────────────────────
        let idResult = idResultIn ?? null;
        if (!idResult) {
            try {
                idResult = await this.identify(sceneX, sceneZ);
            }
            catch (e) {
                console.warn('[VT DIAG] identify failed:', e);
            }
        }
        console.log('%c[VT DIAG] Identify:', 'font-weight:bold;color:#06f', idResult);
        console.log('%c[VT DIAG] Identify:', 'font-weight:bold;color:#06f', idResult);
        if (idResult?.error) {
            console.warn('[VT DIAG] identify error:', idResult.error);
            return;
        }
        // ── 3. Какие группы РЕАЛЬНО покрывают клик ───────────────────
        //    (это ловит случай «два тайла одновременно видны»)
        const coverClick = [];
        const classify = (g) => {
            if (this._tileCache.has(g.userData.__key))
                return '_tileCache';
            return 'scene';
        };
        // вместо этого пройдёмся по кэшам и проверим bbox
        const checkGroup = (label, key, g) => {
            if (!g || !g.visible)
                return;
            const tz = g.userData.sourceZoom;
            if (tz === undefined)
                return;
            const tSize = map.WORLD_SIZE / (1 << tz);
            const wx = g.position.x + map.worldGroup.position.x;
            const wz = g.position.z + map.worldGroup.position.z;
            const half = tSize / 2;
            if (sceneX < wx - half || sceneX > wx + half ||
                sceneZ < wz - half || sceneZ > wz + half)
                return;
            if (coverClick.some(x => x.group === g))
                return;
            coverClick.push({ key, where: label, group: g, tileZ: tz });
        };
        const clickKeyAt = (z) => {
            const s = map.WORLD_SIZE / (1 << z);
            const x = Math.floor((clickLocalX + map.MAX_MERCATOR) / s);
            const y = Math.floor((clickLocalZ + map.MAX_MERCATOR) / s);
            return `${z},${x},${y}`;
        };
        if (TILE_ZOOM_OK) {
            checkGroup('_tileCache', clickKeyAt(srcZ), this._tileCache.get(clickKeyAt(srcZ)));
            checkGroup('_oldTileGroups', clickKeyAt(srcZ), this._oldTileGroups?.get(clickKeyAt(srcZ)));
            checkGroup('_groupCache', clickKeyAt(srcZ), this._groupCache.get(clickKeyAt(srcZ)));
            if (this._oldTileGroups) {
                for (const [key, g] of this._oldTileGroups) {
                    checkGroup('_oldTileGroups(overlap)', key, g);
                }
            }
        }
        console.log(`%c[VT DIAG] ${coverClick.length} VISIBLE group(s) covering click:`, 'font-weight:bold;color:#06f', coverClick.map(c => `${c.where}[${c.key}]`));
        if (coverClick.length > 1) {
            console.warn('%c❌ MULTIPLE VISIBLE GROUPS COVER CLICK POINT — overdraw / transition overlap!', 'color:red;font-weight:bold');
        }
        const allLines = [];
        for (const c of coverClick) {
            console.log(`\n--- Group ${c.where}[${c.key}] tileZ=${c.tileZ} ---`, {
                visible: c.group.visible,
                renderOrder: c.group.renderOrder,
                pos: c.group.position.toArray(),
                inScene: !!c.group.parent,
                childrenCount: c.group.children.length,
                userData: {
                    is3d: c.group.userData.is3d,
                    styleZoom: c.group.userData.styleZoom,
                    sourceZoom: c.group.userData.sourceZoom,
                    generation: c.group.userData.generation,
                    genMatches: c.group.userData.generation === this._generation,
                },
            });
            c.group.traverse((child) => {
                if (!(child.type === 'Line2' || child.isLine2 === true))
                    return;
                const mat = child.material;
                const dyn = mat?.userData?.dyn ?? {};
                const role = dyn.role ?? (dyn.add > 0 ? 'casing' : 'fill');
                allLines.push({
                    groupWhere: c.where,
                    groupKey: c.key,
                    groupTileZ: c.tileZ,
                    groupRO: c.group.renderOrder,
                    uuid: child.uuid,
                    RO: child.renderOrder,
                    objY: child.position.y,
                    objVis: child.visible,
                    role,
                    layer: dyn.layerName ?? '?',
                    add: dyn.add ?? 0,
                    color: '#' + (mat?.color?.getHexString?.() ?? '??????'),
                    lw: mat?.linewidth ?? -1,
                    matVis: mat?.visible ?? false,
                    transp: mat?.transparent ?? false,
                    opacity: mat?.opacity ?? 1,
                    pOff: mat?.polygonOffset ?? false,
                    pOffF: mat?.polygonOffsetFactor ?? 0,
                    pOffU: mat?.polygonOffsetUnits ?? 0,
                    dTest: mat?.depthTest ?? true,
                    dWrite: mat?.depthWrite ?? false,
                    a2c: mat?.alphaToCoverage ?? false,
                    dashed: mat?.dashed ?? false,
                    instances: child.geometry?.attributes?.instanceStart?.count ?? 0,
                    matId: mat?.id ?? -1,
                    renderable: !!(child.visible && mat?.visible && c.group.visible),
                });
            });
        }
        allLines.sort((a, b) => a.RO - b.RO);
        console.log('%c[VT DIAG] All Line2 objects (sorted by renderOrder):', 'font-weight:bold;color:#06f');
        console.table(allLines.map(l => ({
            group: `${l.groupWhere}[${l.groupKey}]`,
            tileZ: l.groupTileZ,
            RO: l.RO,
            y: l.objY,
            role: l.role,
            layer: l.layer,
            add: l.add,
            color: l.color,
            lw: +l.lw.toFixed(2),
            objVis: l.objVis,
            matVis: l.matVis,
            transp: l.transp,
            op: l.opacity,
            pOff: l.pOff ? `${l.pOffF}/${l.pOffU}` : '-',
            dTest: l.dTest,
            dWrite: l.dWrite,
            a2c: l.a2c,
            inst: l.instances,
            renderable: l.renderable,
        })));
        // ── 5. СТРУКТУРНАЯ ПРОВЕРКА ─────────────────────────────────
        console.log('%c[VT DIAG] Structural check per (group, layer, color-family):', 'font-weight:bold;color:#06f');
        const groups = new Map();
        for (const l of allLines) {
            const k = `${l.groupKey}|${l.layer}`;
            if (!groups.has(k))
                groups.set(k, []);
            groups.get(k).push(l);
        }
        for (const [k, items] of groups) {
            const casings = items.filter(i => i.add > 0);
            const fills = items.filter(i => i.add === 0);
            if (casings.length === 0 || fills.length === 0)
                continue;
            const minFillRO = Math.min(...fills.map(i => i.RO));
            const maxCasingRO = Math.max(...casings.map(i => i.RO));
            const visibleCasings = casings.filter(i => i.renderable).length;
            const visibleFills = fills.filter(i => i.renderable).length;
            const orderOK = minFillRO > maxCasingRO;
            const issue = !orderOK || (visibleCasings > 0 && visibleFills === 0);
            console.log(`${issue ? '❌' : '✓'} ${k}: ` +
                `casings=${casings.length} (renderable:${visibleCasings}), ` +
                `fills=${fills.length} (renderable:${visibleFills}), ` +
                `minFillRO=${minFillRO.toFixed(3)} maxCasingRO=${maxCasingRO.toFixed(3)}` +
                (issue ? ' ← PROBLEM!' : ''));
        }
        // ── 6. Санити-чек всех материалов линий ─────────────────────
        console.log('\n%c[VT DIAG] All dynamic materials:', 'font-weight:bold;color:#06f');
        const mats = [];
        for (const mat of this._lineMaterialsSet) {
            const d = mat.userData?.dyn;
            if (!d)
                continue;
            mats.push({
                matId: mat.id,
                role: d.role ?? (d.add > 0 ? 'casing' : 'fill'),
                layer: d.layerName,
                add: d.add,
                hideBelow: d.hideBelow,
                color: '#' + mat.color?.getHexString?.(),
                matVisible: mat.visible,
                lw: mat.linewidth,
                transparent: mat.transparent,
                opacity: mat.opacity,
                pOffF: mat.polygonOffsetFactor,
                pOffU: mat.polygonOffsetUnits,
                a2c: mat.alphaToCoverage,
            });
        }
        mats.sort((a, b) => a.matId - b.matId);
        console.table(mats);
        const transparentMats = mats.filter(m => m.transparent);
        if (transparentMats.length > 0) {
            console.error('%c❌ TRANSPARENT LINE MATERIALS DETECTED — these will be drawn in ' +
                'the transparent pass, sorted by DEPTH, not renderOrder. This is the ' +
                'most likely cause of angle-dependent flickering.', 'color:red;font-weight:bold');
            console.table(transparentMats);
        }
        console.log('%c[VT DIAG] === END ===', 'font-weight:bold;color:#06f');
    },
};
