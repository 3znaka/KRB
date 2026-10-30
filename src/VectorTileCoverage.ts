// VectorTileCoverage.ts
import { THREE } from './js_TP/tpb.js';

export const VectorTileCoverageMixin = {
    _is3dNow(this: any): boolean {
        return this.buildings3d && (this._map?.currentDiscreteZoom ?? 0) >= this.buildings3dMinZoom;
    },

    _getCurrentTileStyleZoom(this: any, map: any = this._map): number {
        if (!map) return 0;
        const dz = Number.isFinite(map.currentDiscreteZoom) ? map.currentDiscreteZoom : 0;
        return dz + this.zoomOffset;
    },

    _pickSourceZoom(this: any, map: any): number {
        const clamp = (z: number) => Math.max(this.minNativeZoom, Math.min(z, this.maxNativeZoom));
        const rawTarget = map.targetZoom !== undefined
            ? map.targetZoom
            : (map._cameraAnimation?.endZoom ?? map.targetContinuousZoom);
        const target = (Number.isFinite(rawTarget) ? rawTarget : map.continuousZoom) + this.zoomOffset;
        const current = this._lastSourceZoom;
        if (current >= 0 && Math.abs(target - current) < 0.65) return current;
        return clamp(Math.round(target));
    },

    _isTileRequestCurrent(this: any, map: any, generation: number, sourceZoom: number, styleZoom: number): boolean {
        return this._map === map
            && this._generation === generation
            && this._lastSourceZoom === sourceZoom
            && this._transitionStyleZoom === styleZoom;
    },

    _adoptTile(
        this: any,
        key: string,
        group: THREE.Group | null | undefined,
        visible = false,
        generation = this._generation,
        styleZoom = this._transitionStyleZoom,
    ): boolean {
        if (!group) return false;
        const comma = key.indexOf(',');
        const tileZoom = Number(key.slice(0, comma));
        const valid = !!this._map
            && generation === this._generation
            && tileZoom === this._lastSourceZoom
            && styleZoom === this._transitionStyleZoom;
        if (!valid) { this._disposeTile(group); return false; }

        group.userData.sourceZoom = tileZoom;
        group.userData.styleZoom = styleZoom;
        group.userData.generation = generation;
        group.visible = !!visible;
        if (group.parent !== this._rootGroup) this._rootGroup.add(group);
        this._tileCache.set(key, group);
        this._coverageDirty = true;
        this._labelsDirty = true;
        return true;
    },

    _stashGroup(this: any, key: string, group: THREE.Group | null | undefined): void {
        if (!group) return;
        this._rootGroup.remove(group);
        group.visible = true;
        this._removeTextLabelsForGroup(group);

        const previous = this._groupCache.get(key);
        if (previous && previous !== group) this._disposeTile(previous);

        this._groupCache.delete(key);
        this._groupCache.set(key, group);

        while (this._groupCache.size > this._groupCacheMaxSize) {
            const oldestKey = this._groupCache.keys().next().value as string;
            const oldestGroup = this._groupCache.get(oldestKey);
            this._groupCache.delete(oldestKey);
            if (oldestGroup) this._disposeTile(oldestGroup);
        }
    },

    _beginTransition(this: any, newZ: number, styleZoom: number): void {
        this._generation++;
        const fallback = new Map<string, THREE.Group>();
        const take = (group: THREE.Group, key: string) => {
            if (group.visible && group.parent) fallback.set(key, group);
            else this._stashGroup(key, group);
        };

        this._oldTileGroups?.forEach(take);
        this._tileCache.forEach(take);
        this._oldTileGroups = fallback.size > 0 ? fallback : null;
        this._retiredOldKeys.clear();
        this._tileCache = new Map();

        this._pendingLoads.clear();
        this._pendingLoadGenerations.clear();
        this._sortedLoadQueue = [];
        this._settledKeys.clear();
        this._requiredKeys = new Set();

        this._lastSourceZoom = newZ;
        this._transitionStyleZoom = Number.isFinite(styleZoom) ? styleZoom : this._getCurrentTileStyleZoom();
        this._lastPrefetchZoom = -1;
        this._labelsDirty = true;
        this._coverageDirty = true;
    },

    _resolveCoverage(this: any): void {
        this._coverageDirty = false;
        const old = this._oldTileGroups;
        let changed = false;

        const setVis = (group: THREE.Group | undefined, visible: boolean) => {
            if (!group) return;
            if (group.visible !== visible) { group.visible = visible; changed = true; }
        };

        const required = this._requiredKeys;

        if (!old) {
            this._tileCache.forEach((g: THREE.Group, k: string) => setVis(g, required.has(k)));
            if (changed) this._refreshTextLabelsForVisibleTiles();
            return;
        }
        if (required.size === 0) return;

        const zn = this._lastSourceZoom;
        const parse = (key: string) => key.split(',').map(Number);
        const isDone = (key: string) => this._tileCache.has(key) || this._settledKeys.has(key);

const newKeys = new Set<string>(required);
        const oldLinks = new Map<string, string[]>();
        const newLinks = new Map<string, string[]>();

        const push = (map: Map<string, string[]>, key: string, value: string) => {
            let list = map.get(key);
            if (!list) { list = []; map.set(key, list); }
            list.push(value);
        };
        const link = (o: string, n: string) => { push(oldLinks, o, n); push(newLinks, n, o); };

        const ancestorIndex = new Map<number, Map<string, string[]>>();
        const ancestorsAt = (oldZoom: number): Map<string, string[]> => {
            let index = ancestorIndex.get(oldZoom);
            if (index) return index;
            index = new Map();
            const shift = zn - oldZoom;
            for (const newKey of newKeys) {
                const [, x, y] = parse(newKey);
                push(index, `${oldZoom},${x >> shift},${y >> shift}`, newKey);
            }
            ancestorIndex.set(oldZoom, index);
            return index;
        };

        old.forEach((_g: THREE.Group, oldKey: string) => {
            const [oldZoom, oldX, oldY] = parse(oldKey);
            if (oldZoom >= zn) {
                const shift = oldZoom - zn;
                const newKey = `${zn},${oldX >> shift},${oldY >> shift}`;
                if (newKeys.has(newKey)) link(oldKey, newKey);
            } else {
                const descendants = ancestorsAt(oldZoom).get(oldKey) || [];
                for (const nk of descendants) link(oldKey, nk);
            }
        });

        let anyOldVisible = false;
        old.forEach((group: THREE.Group, oldKey: string) => {
            if (this._retiredOldKeys.has(oldKey)) { setVis(group, false); return; }
            const links = oldLinks.get(oldKey);
            const keep = !!links && links.some((nk) => required.has(nk) && !isDone(nk));
            setVis(group, keep);
            if (keep) anyOldVisible = true;
            else this._retiredOldKeys.add(oldKey);
        });

        this._tileCache.forEach((group: THREE.Group, newKey: string) => {
            if (!required.has(newKey)) { setVis(group, false); return; }
            const links = newLinks.get(newKey);
            const canShow = !links || links.every((ok) => {
                const og = old.get(ok);
                return !og || !og.visible;
            });
            setVis(group, canShow);
        });

        if (!anyOldVisible) {
            old.forEach((g: THREE.Group, k: string) => this._stashGroup(k, g));
            this._oldTileGroups = null;
            this._retiredOldKeys.clear();
        }
        if (changed) this._refreshTextLabelsForVisibleTiles();
    },
};