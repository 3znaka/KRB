// VectorTileLabels.ts
import { THREE } from './js_TP/tpb.js';
import { VectorLineLabelSource } from './LineLabelSource.js';
/**
 * Бонус к приоритету для подписей, выбранных в прошлый refresh.
 *
 * Это даёт «липкость»: подпись, уже показанная в своей экранной
 * ячейке, не будет вытеснена новичком с тем же или близким
 * приоритетом — только заметно более важным.
 *
 * Значение 50 подобрано так, чтобы:
 *   - City (priority 200) / Town (170) вытесняли POI (60), road-name (100);
 *   - POI (60) не вытеснялся другим POI (60–100);
 *   - метки одной категории не «перетасовывались» при догрузке тайлов.
 *
 * Если понадобится ещё жёстче — увеличь; если наоборот, хочешь
 * быстрее подстраиваться под новые приоритеты — уменьши.
 */
const STICKY_PRIORITY_BONUS = 50;
// ============================================================================
// Point label source
// ============================================================================
class VectorPointLabelSource {
    map;
    worldPos;
    text;
    options;
    constructor(map, worldX, worldZ, text, options = {}) {
        this.map = map;
        this.worldPos = new THREE.Vector3(worldX, 0, worldZ);
        this.text = text;
        this.options = options;
    }
    getText() { return this.text; }
    getLabelType() { return 'point'; }
    getScreenPosition() {
        const v = this.map.getVec3().copy(this.worldPos).add(this.map.worldGroup.position);
        v.project(this.map.camera);
        const rect = this.map.renderer.domElement.getBoundingClientRect();
        return {
            x: (v.x * 0.5 + 0.5) * rect.width,
            y: (-v.y * 0.5 + 0.5) * rect.height,
        };
    }
    getTextStyle() {
        const o = this.options;
        return {
            color: o.textColor || '#333333',
            fontSize: o.fontSize || '12px',
            fontFamily: o.fontFamily || 'sans-serif',
            fontWeight: o.fontWeight || 'normal',
            textShadow: o.textShadow || '',
            textTransform: o.textTransform || '',
            fontStyle: o.textFontStyle || '',
            letterSpacing: o.textLetterSpacing || '',
        };
    }
    getPriority() { return this.options.priority || 0; }
    getTitleAlign() { return this.options.textAlign || 'center'; }
    getTitleVerticalAlign() { return this.options.textVerticalAlign || 'center'; }
    getTitleOffset() { return this.options.textOffset || [0, 0]; }
    getTextZoomBounds() { return this.options.zoomBounds || { min: 0, max: 24 }; }
    isVisible() { return this.options.visible !== false; }
}
// ============================================================================
// Mixin
// ============================================================================
export const VectorTileLabelsMixin = {
    _forEachShownGroup(cb) {
        this._tileCache.forEach((g) => { if (g.visible)
            cb(g); });
        this._oldTileGroups?.forEach((g) => { if (g.visible)
            cb(g); });
    },
    _getPointLabelId(pt, group) {
        const layer = pt.layerName ?? pt.sourceLayer ?? '';
        const featureId = pt.featureId ?? pt.id;
        if (featureId != null) {
            return this._labelIdPrefix + JSON.stringify(['point', layer, featureId, pt.text]);
        }
        const x = Number((pt.x + group.position.x).toPrecision(12));
        const z = Number((pt.z + group.position.z).toPrecision(12));
        return this._labelIdPrefix + JSON.stringify(['point', layer, pt.text, x, z]);
    },
    _removeTextLabelsForGroup(group) {
        if (!group?.userData)
            return;
        const manager = this._map?.textManager;
        for (const label of group.userData.textLabels || []) {
            if (label._vectorOwner === this)
                continue;
            manager?.removeLabel(label);
        }
        group.userData.textLabels = [];
    },
    /**
     * Отбор кандидатов по экранной сетке.
     *
     * Кандидаты уже отсортированы (см. _refreshTextLabelsForVisibleTiles)
     * по «эффективному приоритету», где sticky-подписи получили бонус.
     * Поэтому в каждой ячейке первыми занимают места либо уже показанные
     * подписи, либо заметно более приоритетные новички.
     *
     * Также ограничивает общее количество до maxTextLabels.
     */
    _selectCandidatesByScreenGrid(candidates) {
        const cellSize = this.labelScreenGridSize > 0 ? this.labelScreenGridSize : 256;
        const maxPerCell = this.labelMaxPerCell > 0 ? this.labelMaxPerCell : 6;
        const limit = this.maxTextLabels;
        const cellCounts = new Map();
        const result = [];
        for (let i = 0; i < candidates.length; i++) {
            if (result.length >= limit)
                break;
            const cand = candidates[i];
            const sx = cand.sx;
            const sy = cand.sy;
            if (!Number.isFinite(sx) || !Number.isFinite(sy))
                continue;
            const col = Math.floor(sx / cellSize);
            const row = Math.floor(sy / cellSize);
            const key = col + ',' + row;
            const count = cellCounts.get(key) || 0;
            if (count >= maxPerCell)
                continue;
            cellCounts.set(key, count + 1);
            result.push(cand);
        }
        return result;
    },
    _refreshTextLabelsForVisibleTiles() {
        if (!this._map || !this._map.textManager)
            return;
        const textManager = this._map.textManager;
        const { candidates } = this._collectLabelCandidates();
        let selected;
        if (candidates.length === 0) {
            selected = [];
        }
        else {
            // ── Sticky-сортировка ──────────────────────────────────
            // Подписи, выбранные в прошлый refresh, получают бонус
            // к приоритету. Если новичок их не «перебивает» с запасом
            // STICKY_PRIORITY_BONUS — старая остаётся на месте.
            const sticky = this._lastSelectedLabelIds || new Set();
            candidates.sort((a, b) => {
                const aBonus = sticky.has(a.id) ? STICKY_PRIORITY_BONUS : 0;
                const bBonus = sticky.has(b.id) ? STICKY_PRIORITY_BONUS : 0;
                const aEff = a.priority + aBonus;
                const bEff = b.priority + bBonus;
                if (aEff !== bEff)
                    return bEff - aEff;
                // Линии — приоритетнее точек при равном priority.
                const aL = a.type === 'line' ? 1 : 0;
                const bL = b.type === 'line' ? 1 : 0;
                if (aL !== bL)
                    return bL - aL;
                // Стабильный tiebreaker.
                return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
            });
            selected = this._selectCandidatesByScreenGrid(candidates);
        }
        const activeIds = new Set();
        const groupLabels = new Map();
        for (const cand of selected) {
            const group = cand.group;
            const id = cand.id;
            if (activeIds.has(id))
                continue;
            activeIds.add(id);
            let source;
            if (cand.type === 'line') {
                if (!group.userData.lineLabelSources)
                    group.userData.lineLabelSources = [];
                let cached = group.userData.lineLabelSources[cand.lnIndex];
                if (!cached) {
                    cached = new VectorLineLabelSource(this._map, cand.ln, group, {
                        tracking: this.lineLabelTracking,
                        priorityMode: this.lineLabelPriorityMode,
                        hysteresisPx: this.lineLabelHysteresisPx,
                        placement: this.lineLabelPlacement,
                    });
                    group.userData.lineLabelSources[cand.lnIndex] = cached;
                }
                source = cached;
            }
            else {
                const pt = cand.pt;
                source = new VectorPointLabelSource(this._map, pt.x + group.position.x, pt.z + group.position.z, pt.text, {
                    textColor: pt.textColor, fontSize: pt.fontSize, fontFamily: pt.fontFamily,
                    fontWeight: pt.fontWeight, textShadow: pt.textShadow, textTransform: pt.textTransform,
                    textFontStyle: pt.textFontStyle, textLetterSpacing: pt.textLetterSpacing,
                    textOffset: pt.textOffset, textAlign: pt.textAlign,
                    textVerticalAlign: pt.textVerticalAlign, priority: pt.priority,
                    zoomBounds: pt.zoomBounds,
                });
            }
            const label = textManager.addLabel(source, id, this);
            let labels = groupLabels.get(group);
            if (!labels) {
                labels = [];
                groupLabels.set(group, labels);
            }
            labels.push(label);
        }
        // Мягкое удаление точечных подписей (fade-out, без «застывания»).
        textManager.pruneStaleLabels(activeIds, this, { fade: true, graceMs: 200 });
        // Запоминаем выборку — на следующем refresh эти id будут sticky.
        this._lastSelectedLabelIds = activeIds;
        this._tileCache.forEach((g) => { g.userData.textLabels = groupLabels.get(g) || []; });
        this._oldTileGroups?.forEach((g) => { g.userData.textLabels = groupLabels.get(g) || []; });
    },
    _collectLabelCandidates() {
        const map = this._map;
        const camera = map.camera;
        const continuousZoom = map.continuousZoom + this.zoomOffset;
        const discreteZoom = map.currentDiscreteZoom;
        const worldOffset = map.worldGroup.position;
        const rect = map.renderer.domElement.getBoundingClientRect();
        const cullMargin = this.labelCullMargin ?? 250;
        const isClose = discreteZoom >= (this.labelDistanceSortZoom ?? 17);
        const cameraPos = camera.position;
        const camTargetDist = cameraPos.distanceTo(map.controls.target);
        let maxLabelDist = this.labelMaxCameraDistance;
        if (!(maxLabelDist > 0)) {
            const sinPitch = camTargetDist > 0
                ? Math.max(0, Math.min(1, (cameraPos.y - map.controls.target.y) / camTargetDist))
                : 0;
            maxLabelDist = camTargetDist * Math.max(2.0, 12 / (1 + sinPitch * 4));
        }
        const maxLabelDistSq = maxLabelDist * maxLabelDist;
        const camPosX = cameraPos.x, camPosY = cameraPos.y, camPosZ = cameraPos.z;
        const tempVec = this._tempVec3;
        const candidates = [];
        const rectW = rect.width, rectH = rect.height;
        const screenMarginX = rectW > 0 ? cullMargin / rectW : 0;
        const screenMarginY = rectH > 0 ? cullMargin / rectH : 0;
        this._forEachShownGroup((group) => {
            const gx = group.position.x + worldOffset.x;
            const gz = group.position.z + worldOffset.z;
            const pointData = group.userData.textPointsData;
            if (pointData && pointData.length > 0) {
                for (const pt of pointData) {
                    const zb = pt.zoomBounds || { min: 0, max: 24 };
                    if (continuousZoom < zb.min || continuousZoom > zb.max)
                        continue;
                    const wx = pt.x + gx, wz = pt.z + gz;
                    const cdx = wx - camPosX, cdy = -camPosY, cdz = wz - camPosZ;
                    const d2 = cdx * cdx + cdy * cdy + cdz * cdz;
                    if (d2 > maxLabelDistSq)
                        continue;
                    tempVec.set(wx, 0, wz).project(camera);
                    if (tempVec.z > 1 || tempVec.z < -1)
                        continue;
                    const sx = (tempVec.x * 0.5 + 0.5) * rectW;
                    const sy = (-tempVec.y * 0.5 + 0.5) * rectH;
                    if (sx < -cullMargin || sx > rectW + cullMargin || sy < -cullMargin || sy > rectH + cullMargin)
                        continue;
                    candidates.push({
                        type: 'point', pt, group,
                        id: this._getPointLabelId(pt, group),
                        camDistSq: d2, priority: pt.priority || 0, sx, sy,
                    });
                }
            }
            const lineData = group.userData.textLinesData;
            if (lineData && lineData.length > 0) {
                const groupIdPrefix = this._labelIdPrefix + group.uuid + ':L';
                for (let i = 0; i < lineData.length; i++) {
                    const ln = lineData[i];
                    const zb = ln.zoomBounds || { min: 0, max: 24 };
                    if (continuousZoom < zb.min || continuousZoom > zb.max)
                        continue;
                    const pts = ln.points;
                    if (!pts || pts.length < 2)
                        continue;
                    const step = Math.max(1, Math.floor(pts.length / 20));
                    let minDistSq = Infinity;
                    let minTx = Infinity, maxTx = -Infinity, minTy = Infinity, maxTy = -Infinity;
                    let hasValidPoints = false;
                    for (let k = 0; k < pts.length; k += step) {
                        const wx = pts[k].x + gx, wz = pts[k].z + gz;
                        const cdx = wx - camPosX, cdy = -camPosY, cdz = wz - camPosZ;
                        const d2 = cdx * cdx + cdy * cdy + cdz * cdz;
                        if (d2 < minDistSq)
                            minDistSq = d2;
                        tempVec.set(wx, 0, wz).project(camera);
                        if (tempVec.z > -1 && tempVec.z < 1) {
                            hasValidPoints = true;
                            if (tempVec.x < minTx)
                                minTx = tempVec.x;
                            if (tempVec.x > maxTx)
                                maxTx = tempVec.x;
                            if (tempVec.y < minTy)
                                minTy = tempVec.y;
                            if (tempVec.y > maxTy)
                                maxTy = tempVec.y;
                        }
                    }
                    if (!hasValidPoints)
                        continue;
                    const onScreen = maxTx >= -1 - screenMarginX && minTx <= 1 + screenMarginX
                        && maxTy >= -1 - screenMarginY && minTy <= 1 + screenMarginY;
                    if (!onScreen)
                        continue;
                    if (minDistSq > maxLabelDistSq)
                        continue;
                    const cxNdc = (minTx + maxTx) * 0.5;
                    const cyNdc = (minTy + maxTy) * 0.5;
                    const lSx = (cxNdc * 0.5 + 0.5) * rectW;
                    const lSy = (-cyNdc * 0.5 + 0.5) * rectH;
                    candidates.push({
                        type: 'line', ln, lnIndex: i, group,
                        id: groupIdPrefix + i,
                        camDistSq: minDistSq, priority: ln.priority || 0,
                        sx: lSx, sy: lSy,
                    });
                }
            }
        });
        return { candidates, isClose };
    },
};
