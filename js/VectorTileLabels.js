// VectorTileLabels.ts
import { THREE } from './js_TP/tpb.js';
import { VectorLineLabelSource } from './LineLabelSource.js';
/**
 * Бонус к приоритету для подписей, выбранных в прошлый refresh.
 * См. комментарий в исходной версии — значение 50 подобрано эмпирически.
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
    getIcon() {
        const name = this.options.iconName;
        if (!name)
            return null;
        return {
            name,
            scale: this.options.iconScale ?? 1,
            offset: this.options.iconOffset || [0, 0],
            bgColor: this.options.iconColor || null,
            circleScale: this.options.iconCircleScale,
            glyphRatio: this.options.iconGlyphRatio,
            sprite: this.options.sprite,
        };
    }
    getLabelPosition() {
        const pos = this.options.labelPosition;
        return (pos === 'left' || pos === 'right' || pos === 'top' || pos === 'bottom')
            ? pos
            : 'right';
    }
    getScreenPosition() {
        const map = this.map;
        const cam = map.camera;
        const v = map.getVec3().copy(this.worldPos).add(map.worldGroup.position);
        // Если точка за near-плоскостью (в т.ч. за камерой) — проекция зеркалится,
        // и подпись улетает в небо. Возвращаем null, чтобы TextManager скрыл её.
        const vCam = map.getVec3().copy(v).applyMatrix4(cam.matrixWorldInverse);
        if (vCam.z >= -cam.near)
            return null;
        v.project(cam);
        const rect = map.renderer.domElement.getBoundingClientRect();
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
            // NEW:
            webkitTextStroke: o.textStroke || '',
            paintOrder: o.textStroke ? 'stroke fill' : '',
            filter: o.textFilter || '',
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
// Helpers
// ============================================================================
function _getLayerHalo(styles, name) {
    const s = name ? (styles[name] || {}) : {};
    return {
        textStroke: s.textStroke || undefined,
        textFilter: s.textFilter || undefined,
    };
}
function _pointRank(pt) {
    const hasIcon = !!pt.iconName;
    const hasText = !!(pt.text && pt.text.length);
    if (hasIcon && hasText)
        return 0;
    if (hasIcon)
        return 1;
    return 2;
}
function _candRank(c) {
    return c.type === 'line' ? 3 : c.rank;
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
        const icon = pt.iconName ?? '';
        const text = pt.text ?? '';
        const cs = pt.iconCircleScale ?? ''; // <--- добавили
        const gr = pt.iconGlyphRatio ?? ''; // <--- добавили
        const featureId = pt.featureId ?? pt.id;
        if (featureId != null) {
            return this._labelIdPrefix + 'p:' + layer + ':' + featureId + ':' + icon + ':' + cs + ':' + gr + ':' + text;
        }
        const x = (pt.x + group.position.x).toFixed(4);
        const z = (pt.z + group.position.z).toFixed(4);
        return this._labelIdPrefix + 'p:' + layer + ':' + x + ':' + z + ':' + icon + ':' + cs + ':' + gr + ':' + text;
    },
    // ── Fix #1: реально удаляем метки группы ──────────────────────────────
    _removeTextLabelsForGroup(group) {
        if (!group?.userData)
            return;
        const manager = this._map?.textManager;
        const labels = group.userData.textLabels;
        if (labels && labels.length > 0 && manager) {
            for (let i = 0; i < labels.length; i++) {
                manager.removeLabel(labels[i]);
            }
        }
        group.userData.textLabels = [];
    },
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
    // ── Fix #7: параметр `force` + ранний выход по состоянию ──────────────
    _refreshTextLabelsForVisibleTiles(force = true) {
        if (!this._map || !this._map.textManager)
            return;
        const map = this._map;
        if (this._needsDefaultSprite) {
            this._needsDefaultSprite = false;
            if (map.sprite) {
                // Если спрайт задан на уровне карты — используем его
                this.sprite = map.sprite;
            }
            else {
                // Иначе грузим дефолтный
                this._initDefaultSprite();
            }
        }
        // Fix #7: пропускаем повторный refresh, если ничего значимо не менялось.
        if (!force) {
            const last = this._lastLabelState;
            if (last) {
                const cam = map.camera.position;
                const off = map.worldGroup.position;
                const zoom = map.continuousZoom;
                const w = map.renderer.domElement.clientWidth;
                const h = map.renderer.domElement.clientHeight;
                if (Math.abs(zoom - last.zoom) < 0.05 &&
                    cam.distanceToSquared(last.cam) < 4 &&
                    off.distanceToSquared(last.off) < 4 &&
                    last.w === w && last.h === h) {
                    return;
                }
            }
        }
        // Запоминаем состояние ДО refresh (даже если ниже кандидатов 0).
        if (!this._lastLabelState) {
            this._lastLabelState = {
                zoom: 0,
                cam: new THREE.Vector3(),
                off: new THREE.Vector3(),
                w: 0,
                h: 0,
            };
        }
        {
            const st = this._lastLabelState;
            st.zoom = map.continuousZoom;
            st.cam.copy(map.camera.position);
            st.off.copy(map.worldGroup.position);
            st.w = map.renderer.domElement.clientWidth;
            st.h = map.renderer.domElement.clientHeight;
        }
        const textManager = map.textManager;
        const { candidates } = this._collectLabelCandidates();
        let selected;
        if (candidates.length === 0) {
            selected = [];
        }
        else {
            candidates.sort((a, b) => {
                if (a.effPriority !== b.effPriority)
                    return b.effPriority - a.effPriority;
                const aR = _candRank(a);
                const bR = _candRank(b);
                if (aR !== bR)
                    return aR - bR;
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
                    const lnAny = cand.ln;
                    const layerName = lnAny.sourceLayer || lnAny.layerName || '';
                    const halo = _getLayerHalo(this._styles, layerName);
                    cached = new VectorLineLabelSource(map, cand.ln, group, {
                        tracking: this.lineLabelTracking,
                        priorityMode: this.lineLabelPriorityMode,
                        hysteresisPx: this.lineLabelHysteresisPx,
                        placement: this.lineLabelPlacement,
                        textStroke: halo.textStroke,
                        textFilter: halo.textFilter,
                    });
                    group.userData.lineLabelSources[cand.lnIndex] = cached;
                }
                source = cached;
            }
            else {
                const pt = cand.pt;
                const rawPos = pt.labelPosition;
                const labelPosition = (rawPos === 'left' || rawPos === 'right' || rawPos === 'top' || rawPos === 'bottom')
                    ? rawPos : this.labelPosition;
                const layerName = pt.sourceLayer || pt.layerName || '';
                const halo = _getLayerHalo(this._styles, layerName);
                source = new VectorPointLabelSource(map, pt.x + group.position.x, pt.z + group.position.z, pt.text, {
                    textColor: pt.textColor, fontSize: pt.fontSize, fontFamily: pt.fontFamily,
                    fontWeight: pt.fontWeight, textShadow: pt.textShadow, textTransform: pt.textTransform,
                    textFontStyle: pt.textFontStyle, textLetterSpacing: pt.textLetterSpacing,
                    textOffset: pt.textOffset, textAlign: pt.textAlign,
                    textVerticalAlign: pt.textVerticalAlign, priority: pt.priority,
                    zoomBounds: pt.zoomBounds,
                    // NEW:
                    iconName: pt.iconName,
                    iconScale: pt.iconScale,
                    iconOffset: pt.iconOffset,
                    iconColor: pt.iconColor,
                    iconCircleScale: pt.iconCircleScale,
                    iconGlyphRatio: pt.iconGlyphRatio,
                    sprite: this.sprite,
                    labelPosition,
                    textStroke: halo.textStroke,
                    textFilter: halo.textFilter,
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
        textManager.pruneStaleLabels(activeIds, this, { fade: true, graceMs: 200 });
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
        // Fix #6: sticky set читаем один раз.
        const sticky = this._lastSelectedLabelIds || new Set();
        this._forEachShownGroup((group) => {
            const gx = group.position.x + worldOffset.x;
            const gz = group.position.z + worldOffset.z;
            const pointData = group.userData.textPointsData;
            if (pointData && pointData.length > 0) {
                for (const pt of pointData) {
                    // NEW: пропускаем только пустые точки (нет ни текста, ни иконки).
                    if (!pt.text && !pt.iconName)
                        continue;
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
                    const id = this._getPointLabelId(pt, group);
                    const priority = pt.priority || 0;
                    const effPriority = priority + (sticky.has(id) ? STICKY_PRIORITY_BONUS : 0);
                    candidates.push({
                        type: 'point', pt, group, id,
                        camDistSq: d2, priority, effPriority, sx, sy,
                        rank: _pointRank(pt), // NEW
                    });
                }
            }
            const lineData = group.userData.textLinesData;
            if (lineData && lineData.length > 0) {
                const groupIdPrefix = this._labelIdPrefix + 'L:' + group.uuid + ':';
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
                    const id = groupIdPrefix + i;
                    const priority = ln.priority || 0;
                    const effPriority = priority + (sticky.has(id) ? STICKY_PRIORITY_BONUS : 0);
                    candidates.push({
                        type: 'line', ln, lnIndex: i, group, id,
                        camDistSq: minDistSq, priority, effPriority,
                        sx: lSx, sy: lSy,
                    });
                }
            }
        });
        return { candidates, isClose };
    },
};
