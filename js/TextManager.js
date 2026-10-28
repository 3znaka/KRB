// TextManager.js

import {
  THREE,
} from '../js_TP/tpb.js';

/**
 * Простой пространственный индекс (равномерная сетка).
 * @private
 */
class _GridIndex {
    constructor(cellSize = 128) {
        this.cellSize = cellSize;
        this.grid = new Map();
    }

    _key(col, row) { return col + ',' + row; }

    clear() { this.grid.clear(); }

    insert(bbox, value) {
        const cs = this.cellSize;
        const c0 = Math.floor(bbox.minX / cs);
        const c1 = Math.floor(bbox.maxX / cs);
        const r0 = Math.floor(bbox.minY / cs);
        const r1 = Math.floor(bbox.maxY / cs);
        for (let c = c0; c <= c1; c++) {
            for (let r = r0; r <= r1; r++) {
                const k = this._key(c, r);
                let cell = this.grid.get(k);
                if (!cell) { cell = []; this.grid.set(k, cell); }
                cell.push(value);
            }
        }
    }

    query(bbox) {
        const cs = this.cellSize;
        const c0 = Math.floor(bbox.minX / cs);
        const c1 = Math.floor(bbox.maxX / cs);
        const r0 = Math.floor(bbox.minY / cs);
        const r1 = Math.floor(bbox.maxY / cs);
        const result = [];
        const seen = new Set();
        for (let c = c0; c <= c1; c++) {
            for (let r = r0; r <= r1; r++) {
                const cell = this.grid.get(this._key(c, r));
                if (!cell) continue;
                for (let i = 0; i < cell.length; i++) {
                    const v = cell[i];
                    if (seen.has(v)) continue;
                    seen.add(v);
                    result.push(v);
                }
            }
        }
        return result;
    }
}

export class TextManager {
    constructor(map) {
        this.map = map;
        this.labels = [];
        this._labelsById = new Map();
        this.pane = null;
        this.maxLabels = 500;
        this._lastVisibleIds = null;
        this._lastZoom = null;
        this._gridIndex = new _GridIndex(128);
        this._measureQueue = [];
        this._measureScheduled = false;
        this._lastFrameSig = null;
        this._dirty = true;

        this._lastLayoutTime = 0;
        this._layoutInterval = 150;

        this._initPane();
    }

    setMaxLabels(max) {
        if (typeof max === 'number' && max > 0) this.maxLabels = max;
    }

    getDebugStats() {
        let visible = 0, hidden = 0;
        for (const l of this.labels) {
            if (l.hiddenByPriority) hidden++;
            else if (l.element && l.element.style.display !== 'none') visible++;
        }
        return {
            total: this.labels.length,
            visible,
            hiddenByPriority: hidden,
            maxLabels: this.maxLabels,
            stableIds: this._labelsById.size
        };
    }

    _initPane() {
        const target = this.map.targetElement;
        let pane = target.querySelector('#krb-label-pane');
        if (!pane) {
            pane = document.createElement('div');
            pane.id = 'krb-label-pane';
            Object.assign(pane.style, {
                position: 'absolute',
                top: '0', left: '0',
                width: '100%', height: '100%',
                pointerEvents: 'none',
                zIndex: '625'
            });
            target.appendChild(pane);
        }
        this.pane = pane;
    }

    dispose() {
        for (const label of this.labels) {
            if (label._hideTimeout) { clearTimeout(label._hideTimeout); label._hideTimeout = null; }
            if (label.element && label.element.parentNode) {
                label.element.parentNode.removeChild(label.element);
            }
        }
        this.labels.length = 0;
        this._labelsById.clear();
        this._measureQueue.length = 0;
        this._measureScheduled = false;
        if (this.pane && this.pane.parentNode) this.pane.parentNode.removeChild(this.pane);
        this.pane = null;
        this._lastVisibleIds = null;
        this._lastZoom = null;
        this._lastFrameSig = null;
        this._dirty = true;
        this._gridIndex.clear();
    }

    addLabel(source, stableId = null) {
        if (stableId != null) {
            const existing = this._labelsById.get(stableId);
            if (existing) {
                this._updateLabelSource(existing, source);
                this._dirty = true;
                return existing;
            }
        }

        const type = source.getLabelType ? source.getLabelType() : 'point';
        const isCurved = type === 'line-curved';

        const el = document.createElement('div');
        el.className = 'krb-text-label';
        Object.assign(el.style, {
            position: 'absolute',
            display: 'none',
            pointerEvents: 'none',
            whiteSpace: 'nowrap',
            fontFamily: 'sans-serif',
            color: '#333',
            fontSize: '12px',
            lineHeight: '1',
            padding: '0',
            margin: '0',
            transformOrigin: '0 0',
            left: '0',
            top: '0',
            willChange: 'transform'
        });
        const styleObj = source.getTextStyle ? source.getTextStyle() : {};
        Object.assign(el.style, styleObj);
        el.style.transition = 'opacity 0.08s linear';
        el.style.opacity = '0';

        if (type === 'point') {
            el.style.whiteSpace = 'pre-line';
            el.textContent = this._wrapPointText(source.getText(), el.style.fontSize);
        } else if (!isCurved) {
            el.textContent = source.getText();
        }

        this.pane.appendChild(el);

        const label = {
            source,
            element: el,
            stableId,
            t: 0,
            width: 0,
            height: 0,
            hiddenByPriority: false,
            priority: source.getPriority ? source.getPriority() : 0,
            allowOverflow: source.getAllowOverflow ? source.getAllowOverflow() : false,
            _fontSize: parseFloat(styleObj.fontSize) || 12,
            _bbox: null,
            _needsMeasure: !isCurved,
            _queuedForMeasure: false,
            _chosenT: null,
            _chosenIsFlipped: false
        };
        this.labels.push(label);
        if (stableId != null) this._labelsById.set(stableId, label);

        if (!isCurved) this._scheduleMeasure(label);

        this._lastVisibleIds = null;
        this._dirty = true;
        return label;
    }

    _updateLabelSource(label, newSource) {
        const oldSource = label.source;
        const el = label.element;
        const newType = newSource.getLabelType ? newSource.getLabelType() : 'point';

        const oldText = oldSource && oldSource.getText ? oldSource.getText() : '';
        const newText = newSource.getText ? newSource.getText() : '';

        const oldStyle = oldSource && oldSource.getTextStyle ? oldSource.getTextStyle() : {};
        const newStyle = newSource.getTextStyle ? newSource.getTextStyle() : {};

        label.source = newSource;
        label._chosenT = null;
        label._chosenIsFlipped = false;

        Object.assign(el.style, newStyle);

        if (newType === 'line-curved') {
            label._fontSize = parseFloat(newStyle.fontSize) || 12;
            return;
        }

        const textChanged = oldText !== newText;
        const fontChanged =
            oldStyle.fontSize !== newStyle.fontSize ||
            oldStyle.fontFamily !== newStyle.fontFamily ||
            oldStyle.fontWeight !== newStyle.fontWeight;

        if (textChanged) {
            if (newType === 'point') {
                el.style.whiteSpace = 'pre-line';
                el.textContent = this._wrapPointText(newText, el.style.fontSize);
            } else {
                el.textContent = newText;
            }
        }

        if (textChanged || fontChanged) {
            label._needsMeasure = true;
            this._scheduleMeasure(label);
        }
    }

    removeLabel(label) {
        if (!label) return;
        if (label._hideTimeout) { clearTimeout(label._hideTimeout); label._hideTimeout = null; }
        const idx = this.labels.indexOf(label);
        if (idx > -1) {
            this.labels.splice(idx, 1);
            if (label.element && label.element.parentNode) {
                label.element.parentNode.removeChild(label.element);
            }
        }
        if (label.stableId != null && this._labelsById.get(label.stableId) === label) {
            this._labelsById.delete(label.stableId);
        }
        label._queuedForMeasure = false;
        this._lastVisibleIds = null;
        this._dirty = true;
    }

    pruneStaleLabels(activeIds) {
        if (!activeIds || this._labelsById.size === 0) return;
        let toRemove = null;
        for (const [id, label] of this._labelsById) {
            if (!activeIds.has(id)) {
                if (!toRemove) toRemove = [];
                toRemove.push(label);
            }
        }
        if (!toRemove) return;
        for (let i = 0; i < toRemove.length; i++) this.removeLabel(toRemove[i]);
    }

    _wrapPointText(text, fontSize) {
        if (!text || text.indexOf(' ') === -1) return text;
        const words = text.split(/\s+/).filter(w => w.length > 0);
        if (words.length <= 1) return text;
        const fontPx = parseFloat(fontSize) || 12;
        const charWidth = fontPx * 0.6;
        const spaceWidth = fontPx * 0.3;
        const wordWidths = words.map(w => w.length * charWidth);
        const totalSingleLineWidth = wordWidths.reduce((s, w) => s + w, 0) +
            (words.length - 1) * spaceWidth;
        const maxSingleLineWidth = 160;
        if (totalSingleLineWidth <= maxSingleLineWidth) return text;
        const lineHeight = fontPx * 1.2;
        let targetLines = Math.max(2, Math.round(Math.sqrt(totalSingleLineWidth / lineHeight)));
        targetLines = Math.min(targetLines, 5);
        const targetLineWidth = totalSingleLineWidth / targetLines;
        const lines = [];
        let currentLine = [];
        let currentWidth = 0;
        for (let i = 0; i < words.length; i++) {
            const word = words[i], w = wordWidths[i];
            if (currentLine.length === 0) {
                currentLine.push(word); currentWidth = w;
            } else {
                const addedWidth = currentWidth + spaceWidth + w;
                if (addedWidth <= targetLineWidth) {
                    currentLine.push(word); currentWidth = addedWidth;
                } else {
                    lines.push(currentLine.join(' '));
                    currentLine = [word]; currentWidth = w;
                }
            }
        }
        if (currentLine.length > 0) lines.push(currentLine.join(' '));
        if (lines.length <= 1) return text;
        return lines.join('\n');
    }

    _scheduleMeasure(label) {
        if (label._queuedForMeasure) return;
        label._queuedForMeasure = true;
        this._measureQueue.push(label);
        if (this._measureScheduled) return;
        this._measureScheduled = true;
        if (typeof requestAnimationFrame === 'function') {
            requestAnimationFrame(() => this._flushMeasurements());
        }
    }

    _flushMeasurements() {
        if (!this._measureScheduled) return;
        this._measureScheduled = false;
        const queue = this._measureQueue;
        if (queue.length === 0) return;
        this._measureQueue = [];

        let allMeasured = false;
        let allRestored = false;
        try {
            for (let i = 0; i < queue.length; i++) {
                const el = queue[i].element;
                if (!el) continue;
                el.style.display = 'block';
                el.style.visibility = 'hidden';
            }
            for (let i = 0; i < queue.length; i++) {
                const label = queue[i];
                const el = label.element;
                if (!el) {
                    label._needsMeasure = false;
                    label._queuedForMeasure = false;
                    continue;
                }
                label.width = el.offsetWidth;
                label.height = el.offsetHeight;
                const cs = window.getComputedStyle(el);
                label._fontSize = parseFloat(cs.fontSize) || 12;
                label._needsMeasure = false;
                label._queuedForMeasure = false;
            }
            allMeasured = true;
            for (let i = 0; i < queue.length; i++) {
                const el = queue[i].element;
                if (!el) continue;
                el.style.visibility = '';
                el.style.display = 'none';
            }
            allRestored = true;
        } finally {
            if (!allRestored) {
                for (let i = 0; i < queue.length; i++) {
                    const el = queue[i].element;
                    if (!el) continue;
                    el.style.visibility = '';
                    el.style.display = 'none';
                }
            }
            if (!allMeasured) {
                for (let i = 0; i < queue.length; i++) {
                    const label = queue[i];
                    if (label._queuedForMeasure) this._measureQueue.push(label);
                }
                if (this._measureQueue.length > 0 && !this._measureScheduled) {
                    this._measureScheduled = true;
                    if (typeof requestAnimationFrame === 'function') {
                        requestAnimationFrame(() => this._flushMeasurements());
                    }
                }
            }
        }
    }

    _setLabelVisible(label, visible) {
        const el = label.element;
        if (visible) {
            if (label._hideTimeout) { clearTimeout(label._hideTimeout); label._hideTimeout = null; }
            if (el.style.display === 'none') {
                el.style.display = 'block';
                el.style.opacity = '0';
                void el.offsetWidth;
                el.style.opacity = '1';
            } else {
                el.style.opacity = '1';
            }
        } else {
            if (el.style.display === 'none') return;
            el.style.opacity = '0';
            if (label._hideTimeout) clearTimeout(label._hideTimeout);
            label._hideTimeout = setTimeout(() => {
                if (parseFloat(el.style.opacity) === 0) el.style.display = 'none';
                label._hideTimeout = null;
            }, 80);
        }
    }

    _computeAnchor(label, rotationDeg) {
        const src = label.source;
        if (label._needsMeasure) this._flushMeasurements();
        const w = label.width;
        const h = label.height;
        const align = src.getTitleAlign ? src.getTitleAlign() : 'center';
        const vAlign = src.getTitleVerticalAlign ? src.getTitleVerticalAlign() : 'center';
        const [offX, offY] = src.getTitleOffset ? src.getTitleOffset() : [0, 0];
        let anchorX;
        if (align === 'left') anchorX = 0;
        else if (align === 'right') anchorX = w;
        else anchorX = w / 2;
        let anchorY;
        if (vAlign === 'top') anchorY = 0;
        else if (vAlign === 'bottom') anchorY = h;
        else anchorY = h / 2;
        const rad = rotationDeg * Math.PI / 180;
        const cos = Math.cos(rad);
        const sin = Math.sin(rad);
        const dx = -anchorX * cos + anchorY * sin;
        const dy = -anchorX * sin - anchorY * cos;
        return { dx, dy, offX, offY, w, h, cos, sin };
    }

    _getLabelCorners(label, tOverride = null) {
        const src = label.source;
        const isLine = src.getLabelType() === 'line';
        let scrX, scrY, rotation = 0;
        if (isLine) {
            const t = tOverride !== null ? tOverride : label.t;
            const pos = src.getScreenPositionAt(t);
            if (!pos) return null;
            scrX = pos.x; scrY = pos.y;
            rotation = src.getScreenAngleAt(t);
        } else {
            const pos = label.screenPos || src.getScreenPosition();
            if (!pos) return null;
            scrX = pos.x; scrY = pos.y;
        }
        const a = this._computeAnchor(label, rotation);
        const { dx, dy, offX, offY, w, h, cos, sin } = a;
        const top = scrY + dy + offY;
        const left = scrX + dx + offX;
        const corners = [
            { x: left,      y: top },
            { x: left + w,  y: top },
            { x: left + w,  y: top + h },
            { x: left,      y: top + h }
        ];
        if (rotation !== 0) {
            const cx = left, cy = top;
            for (const pt of corners) {
                const rx = cx + (pt.x - cx) * cos - (pt.y - cy) * sin;
                const ry = cy + (pt.x - cx) * sin + (pt.y - cy) * cos;
                pt.x = rx; pt.y = ry;
            }
        }
        return corners;
    }

    _getBBox(corners) {
        let minX = Infinity, minY = Infinity;
        let maxX = -Infinity, maxY = -Infinity;
        for (const c of corners) {
            if (c.x < minX) minX = c.x;
            if (c.y < minY) minY = c.y;
            if (c.x > maxX) maxX = c.x;
            if (c.y > maxY) maxY = c.y;
        }
        return { minX, minY, maxX, maxY };
    }

    _bboxOverlap(a, b) {
        return !(a.maxX < b.minX || b.maxX < a.minX || a.maxY < b.minY || b.maxY < a.minY);
    }

    _projectPolygon(axis, poly) {
        let min = axis.x * poly[0].x + axis.y * poly[0].y;
        let max = min;
        for (let i = 1; i < poly.length; i++) {
            const proj = axis.x * poly[i].x + axis.y * poly[i].y;
            if (proj < min) min = proj;
            if (proj > max) max = proj;
        }
        return { min, max };
    }

    _rectsIntersect(rectA, rectB) {
        if (!rectA || !rectB) return false;
        const polys = [rectA, rectB];
        for (const poly of polys) {
            for (let i = 0; i < poly.length; i++) {
                const p1 = poly[i];
                const p2 = poly[(i + 1) % poly.length];
                const edge = { x: p2.x - p1.x, y: p2.y - p1.y };
                const axis = { x: -edge.y, y: edge.x };
                const projA = this._projectPolygon(axis, rectA);
                const projB = this._projectPolygon(axis, rectB);
                if (projA.max < projB.min || projB.max < projA.min) return false;
            }
        }
        return true;
    }

    _collidesWithGrid(bbox) {
        const others = this._gridIndex.query(bbox);
        for (let i = 0; i < others.length; i++) {
            const other = others[i];
            if (!other._bbox) continue;
            if (this._bboxOverlap(bbox, other._bbox)) return true;
        }
        return false;
    }

    _renderLineChars(label, charLayout) {
        const el = label.element;
        const need = charLayout.length;
        while (el.children.length < need) {
            const span = document.createElement('span');
            span.style.cssText =
                'position:absolute;left:0;top:0;' +
                'transform-origin:50% 50%;white-space:nowrap;' +
                'line-height:1;';
            el.appendChild(span);
        }
        while (el.children.length > need) {
            el.removeChild(el.lastChild);
        }
        const fs = label._fontSize || 12;
        for (let i = 0; i < need; i++) {
            const c = charLayout[i];
            const span = el.children[i];
            if (span.textContent !== c.char) span.textContent = c.char;
            const tx = c.x - c.w * 0.5;
            const ty = c.y - fs * 0.5;
            span.style.transform = `translate3d(${tx}px, ${ty}px, 0) rotate(${c.angle}deg)`;
        }
        el.style.transform = 'translate3d(0,0,0)';
    }

    update() {
        if (this._measureQueue.length > 0) {
            if (!this._measureScheduled) this._measureScheduled = true;
            this._flushMeasurements();
        }

        const map = this.map;
        const zoom = map.continuousZoom;
        const now = performance.now();

        const needLayout = this._dirty || this._lastZoom !== zoom || (now - this._lastLayoutTime > this._layoutInterval);

        if (!needLayout) {
            const wp = map.worldGroup.position;
            const cam = map.camera.position;
            const sig = zoom + '|' + wp.x.toFixed(1) + ',' + wp.z.toFixed(1) + '|' + cam.x.toFixed(1) + ',' + cam.y.toFixed(1) + ',' + cam.z.toFixed(1);
            
            if (this._lastFrameSig !== sig) {
                this._lastFrameSig = sig;
                this._applyTransforms();
            }
            return;
        }

        // --- Тяжёлый Layout ---
        this._lastLayoutTime = now;
        this._lastZoom = zoom;
        this._dirty = false;
        this._lastFrameSig = null;

        const idSet = new Set();
        for (const l of this.labels) {
            const src = l.source;
            const zb = src.getTextZoomBounds();
            if (zoom >= zb.min && zoom <= zb.max && src.isVisible()) {
                idSet.add(src);
            }
        }
        
        const visibleLabels = [];
        for (const label of this.labels) {
            const src = label.source;
            const zb = src.getTextZoomBounds();
            if (zoom < zb.min || zoom > zb.max) continue;
            if (!src.isVisible()) continue;

            label.priority = src.getPriority ? src.getPriority() : 0;
            label.allowOverflow = src.getAllowOverflow ? src.getAllowOverflow() : false;
            label.hiddenByPriority = false;

            const type = src.getLabelType();

            if (type === 'line-curved') {
                visibleLabels.push(label);
                continue;
            }

            if (type === 'line') {
                const iv = src.getVisibleInterval();
                if (!iv) continue;
                label.visibleInterval = iv;
                label.t = src.getLabelParameter();
                if (!label.allowOverflow) {
                    if (label.t < iv.min || label.t > iv.max) {
                        label.t = Math.max(iv.min, Math.min(iv.max, label.t));
                        src.setLabelParameter(label.t);
                    }
                } else {
                    label.t = Math.max(0, Math.min(1, label.t));
                }
                label.rect = this._getLabelCorners(label);
                if (label.rect) visibleLabels.push(label);
            } else {
                const pos = src.getScreenPosition();
                if (!pos) continue;
                label.screenPos = pos;
                label.rect = this._getLabelCorners(label);
                if (label.rect) visibleLabels.push(label);
            }
        }

        const sorted = [...visibleLabels].sort((a, b) => {
            if (a.priority !== b.priority) return b.priority - a.priority;
            const aKind = a.source.getLabelType() === 'point' ? 0 : 1;
            const bKind = b.source.getLabelType() === 'point' ? 0 : 1;
            if (aKind !== bKind) return aKind - bKind;
            return a.source.getText().localeCompare(b.source.getText());
        });

        this._gridIndex.clear();

        for (const lbl of sorted) {
            const type = lbl.source.getLabelType();

            if (type === 'line-curved') {
                const candidates = lbl.source.getCandidates();
                if (!candidates || candidates.length === 0) {
                    lbl.hiddenByPriority = true;
                    lbl._chosenT = null;
                    continue;
                }
                let chosen = null;
                for (let i = 0; i < candidates.length; i++) {
                    const cand = candidates[i];
                    if (!this._collidesWithGrid(cand.bbox)) {
                        chosen = cand;
                        break;
                    }
                }
                if (chosen) {
                    lbl._bbox = chosen.bbox;
                    this._gridIndex.insert(chosen.bbox, lbl);
                    lbl._chosenT = chosen.t;
                    lbl._chosenIsFlipped = chosen.isFlipped;
                    lbl.hiddenByPriority = false;
                } else {
                    lbl._chosenT = null;
                    lbl.hiddenByPriority = true;
                }
                continue;
            }

            lbl.rect = this._getLabelCorners(lbl);
            if (!lbl.rect) { lbl.hiddenByPriority = true; continue; }
            const bbox = this._getBBox(lbl.rect);
            lbl._bbox = bbox;

            const others = this._gridIndex.query(bbox);
            let overlaps = false;
            for (let i = 0; i < others.length; i++) {
                const other = others[i];
                if (!other._bbox || !this._bboxOverlap(bbox, other._bbox)) continue;
                if (this._rectsIntersect(lbl.rect, other.rect)) { overlaps = true; break; }
            }
            if (!overlaps) {
                this._gridIndex.insert(bbox, lbl);
                lbl.hiddenByPriority = false;
            } else {
                lbl.hiddenByPriority = true;
            }
        }

        const visibleSet = new Set(visibleLabels);
        for (const label of this.labels) {
            const shouldBeVisible = visibleSet.has(label) && !label.hiddenByPriority;
            this._setLabelVisible(label, shouldBeVisible);
        }

        this._applyTransforms();
    }

    _applyTransforms() {
        for (const label of this.labels) {
            if (label.hiddenByPriority) continue;
            const src = label.source;
            const type = src.getLabelType();

            if (type === 'line-curved') {
                if (label._chosenT == null) continue;
                const charLayout = src.getCharLayoutAtT(label._chosenT, label._chosenIsFlipped);
                if (charLayout) {
                    this._renderLineChars(label, charLayout);
                }
                continue;
            }

            const el = label.element;
            let screenX, screenY, rotation = 0;

            if (type === 'line') {
                const pos = src.getScreenPositionAt(label.t);
                if (!pos) continue;
                screenX = pos.x;
                screenY = pos.y;
                rotation = src.getScreenAngleAt(label.t);
            } else {
                const pos = src.getScreenPosition();
                if (!pos) continue;
                screenX = pos.x;
                screenY = pos.y;
            }

            const a = this._computeAnchor(label, rotation);
            const { dx, dy, offX, offY } = a;
            const top = screenY + dy + offY;

            let transform = `translate3d(${screenX + dx + offX}px, ${top}px, 0)`;
            if (type === 'line' && src.getPlacement() === 'along') {
                transform += ` rotate(${rotation}deg)`;
            }
            el.style.transform = transform;
        }
    }

    _setDiffers(a, b) {
        if (a.size !== b.size) return true;
        for (const item of a) if (!b.has(item)) return true;
        return false;
    }
}