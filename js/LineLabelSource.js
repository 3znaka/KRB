// LineLabelSource.js
import { THREE } from '../js_TP/tpb.js';

const _sharedMeasureCanvas = (() => {
    let c = null;
    return () => (c ??= document.createElement('canvas'));
})();

function _measure(text, fontSize, fontFamily, fontWeight, fontStyle) {
    const ctx = _sharedMeasureCanvas().getContext('2d');
    ctx.font = `${fontStyle || 'normal'} ${fontWeight || 'normal'} ${fontSize || '11px'} ${fontFamily || 'sans-serif'}`;
    return ctx.measureText(text).width;
}

/**
 * Подписи линейных объектов: предвычисленные кандидаты + посимвольный
 * layout для рендера по кривой.
 *
 * Кандидат — это положение ПЕРВОГО символа (в экранных пикселях) +
 * массив позиций/углов всех символов, вычисленных вдоль полилинии.
 * TextManager выбирает ровно один кандидат на тайл; рендерятся его символы.
 *
 * Позиция каждого символа (x, y) — это ЦЕНТР глифа. Ширина (w) —
 * визуальная ширина (без letterSpacing). Это согласовано с рендером
 * в TextManager: `translate3d(x - w/2, y - fs/2, 0) rotate(angle)`.
 *
 * Вертикальное выравнивание относительно линии:
 *  - `textVerticalAlign`: 'top' | 'middle' | 'bottom' (семантика MapLibre:
 *    'top' = подпись над линией, 'bottom' = под линией).
 *  - `placement` в опциях перекрывает: 'above'|'below'|'center'.
 *  - `textOffset` [dx, dy] в пикселях — добавляется к позиции (экранные оси).
 */
export class VectorLineLabelSource {
    constructor(map, lineData, group, options = {}) {
        this.map = map;
        this.lineData = lineData;
        this.group = group;

        this.tracking       = options.tracking       ?? 1.35;
        this.placement      = options.placement      ?? 'auto';
        this.priorityMode   = options.priorityMode   ?? 'tile';
        this.hysteresisPx   = options.hysteresisPx   ?? 40;

        this._screenData = null;
        this._screenDataSig = null;
        this._candidates = null;
        this._candidatesSig = null;
        this._charWidths = null;
        this._selected = -1;
        this._lastSelectedBBox = null;
    }

    // ── Public API ───────────────────────────────────────────────
    getText()               { return this.lineData.text || ''; }
    getLabelType()          { return 'line-curved'; }
    isVisible()             { return this.lineData.visible !== false; }
    getAllowOverflow()      { return false; }
    getPriority()           { return this.lineData.priority || 0; }
    getPlacement()          { return this.lineData.placement || 'along'; }
    getTextZoomBounds()     { return this.lineData.zoomBounds || { min: 0, max: 24 }; }
    getTitleAlign()         { return 'center'; }
    getTitleVerticalAlign() { return this.lineData.textVerticalAlign || 'middle'; }
    getTitleOffset()        { return this.lineData.textOffset || [0, 0]; }
    getTextStyle() {
        return {
            color: this.lineData.textColor || '#333333',
            fontSize: this.lineData.fontSize || '11px',
            fontFamily: this.lineData.fontFamily || 'sans-serif',
            fontWeight: this.lineData.fontWeight || 'normal',
            textShadow: this.lineData.textShadow || '',
            textTransform: this.lineData.textTransform || '',
            fontStyle: this.lineData.textFontStyle || '',
            letterSpacing: this.lineData.textLetterSpacing || ''
        };
    }

    getSelectedCandidate() { return this._candidates?.[this._selected] ?? null; }
    selectCandidate(idx) {
        this._selected = idx;
        this._lastSelectedBBox = this._candidates?.[idx]?.bbox ?? null;
    }

    /** @returns {Array<{charLayout: Array<{char,x,y,angle,w}>, bbox: Object}>} */
    getCandidates() {
        const data = this._getScreenData();
        if (!data) return [];
        const cw = this._getCharWidths();
        if (!cw.total) return [];

        const sig = this._candidatesSigKey();
        if (this._candidatesSig === sig && this._candidates) return this._candidates;

        this._candidatesSig = sig;
        this._candidates = this._buildCandidates(data, cw);
        return this._candidates;
    }

    // ── Полилиния в экранных координатах ─────────────────────────

    _getScreenData() {
        const cam = this.map.camera;
        const wp = this.map.worldGroup.position;
        const gp = this.group.position;
        const offX = wp.x + gp.x;
        const offZ = wp.z + gp.z;
        const zoom = this.map.continuousZoom;

        const sig = cam.position.x.toFixed(2) + ',' +
                    cam.position.y.toFixed(2) + ',' +
                    cam.position.z.toFixed(2) + '|' +
                    offX.toFixed(2) + ',' + offZ.toFixed(2) + '|' +
                    zoom.toFixed(2);
        if (this._screenDataSig === sig) return this._screenData;
        this._screenDataSig = sig;
        this._screenData = this._computeScreenData(cam, offX, offZ);
        return this._screenData;
    }

    _computeScreenData(camera, offX, offZ) {
        const pts = this.lineData.points;
        if (!pts || pts.length < 2) return null;

        const n = pts.length;
        const points3D = new Array(n);
        for (let i = 0; i < n; i++) {
            points3D[i] = new THREE.Vector3(pts[i].x + offX, 0, pts[i].z + offZ);
        }

        const segLengths = new Array(n - 1);
        let totalLen = 0;
        for (let i = 0; i < n - 1; i++) {
            const d = points3D[i].distanceTo(points3D[i + 1]);
            segLengths[i] = d;
            totalLen += d;
        }
        if (totalLen < 1e-9) return null;

        const pointsT = new Array(n);
        pointsT[0] = 0;
        for (let i = 1; i < n; i++) {
            pointsT[i] = pointsT[i - 1] + segLengths[i - 1] / totalLen;
        }

        const canvas = this.map.renderer.domElement;
        const W = canvas.clientWidth, H = canvas.clientHeight;
        if (W <= 0 || H <= 0) return null;

        const v = new THREE.Vector3();
        const pointsScreen = new Array(n);
        for (let i = 0; i < n; i++) {
            v.copy(points3D[i]).project(camera);
            pointsScreen[i] = {
                x: (v.x * 0.5 + 0.5) * W,
                y: (-v.y * 0.5 + 0.5) * H,
                z: v.z
            };
        }

        const segLengthsPx = new Array(n - 1);
        const segAngles = new Array(n - 1);
        const pointsPx = new Array(n);
        pointsPx[0] = 0;
        let totalLenPx = 0;
        let lastAngle = 0;
        for (let i = 0; i < n - 1; i++) {
            const dx = pointsScreen[i + 1].x - pointsScreen[i].x;
            const dy = pointsScreen[i + 1].y - pointsScreen[i].y;
            const len = Math.hypot(dx, dy);
            segLengthsPx[i] = len;
            pointsPx[i + 1] = pointsPx[i] + len;
            totalLenPx += len;
            if (len > 1e-6) {
                let a = Math.atan2(dy, dx) * 180 / Math.PI;
                if (a > 90) a -= 180;
                else if (a < -90) a += 180;
                lastAngle = a;
            }
            segAngles[i] = lastAngle;
        }
        if (totalLenPx < 1e-6) return null;

        // Видимый интервал (грубый culling).
        const samples = 40;
        const probe = { pointsPx, pointsScreen, segAngles, totalLenPx };
        const flags = [];
        for (let i = 0; i <= samples; i++) {
            const px = (i / samples) * totalLenPx;
            const p = this._samplePx(probe, px);
            flags.push(
                p.z > 0 && p.z < 1 &&
                p.x >= -W * 0.5 && p.x <= W * 1.5 &&
                p.y >= -H * 0.5 && p.y <= H * 1.5
            );
        }
        const firstVisible = flags.indexOf(true);
        if (firstVisible === -1) return null;
        let lastVisible = firstVisible;
        for (let i = flags.length - 1; i >= 0; i--) {
            if (flags[i]) { lastVisible = i; break; }
        }
        const visibleIntervalPx = {
            min: (firstVisible / samples) * totalLenPx,
            max: (lastVisible / samples) * totalLenPx
        };
        if (visibleIntervalPx.max - visibleIntervalPx.min < 10) return null;

        // Центр тайла в экранных координатах (для приоритета).
        v.set(offX, 0, offZ).project(camera);
        const tileCenterScreen = {
            x: (v.x * 0.5 + 0.5) * W,
            y: (-v.y * 0.5 + 0.5) * H
        };

        return {
            points3D, pointsScreen, pointsT, pointsPx, segLengths, segLengthsPx,
            segAngles, totalLen, totalLenPx, visibleIntervalPx, tileCenterScreen,
            canvasW: W, canvasH: H, camera
        };
    }

    _samplePx(data, px) {
        const { pointsPx, pointsScreen, segAngles } = data;
        const n = pointsPx.length;
        if (px < 0) px = 0;
        if (px > data.totalLenPx) px = data.totalLenPx;

        for (let i = 0; i < n - 1; i++) {
            if (px <= pointsPx[i + 1]) {
                const seg = pointsPx[i + 1] - pointsPx[i];
                const u = seg > 1e-9 ? (px - pointsPx[i]) / seg : 0;
                const s0 = pointsScreen[i], s1 = pointsScreen[i + 1];
                return {
                    x: s0.x + (s1.x - s0.x) * u,
                    y: s0.y + (s1.y - s0.y) * u,
                    z: s0.z + (s1.z - s0.z) * u,
                    angle: segAngles[i]
                };
            }
        }
        const s = pointsScreen[n - 1];
        return { x: s.x, y: s.y, z: s.z, angle: segAngles[n - 2] ?? 0 };
    }

    // ── Ширины символов (с letterSpacing, textTransform, пробелами) ──

    _getCharWidths() {
        if (this._charWidths) return this._charWidths;
        const rawText = this.lineData.text || '';
        const s = this.getTextStyle();
        const tr = this.lineData.textTransform;
        let text = rawText;
        if (tr === 'uppercase') text = text.toUpperCase();
        else if (tr === 'lowercase') text = text.toLowerCase();

        const fsPx = parseFloat(s.fontSize) || 12;
        let lsPx = 0;
        if (s.letterSpacing) {
            const val = parseFloat(s.letterSpacing) || 0;
            lsPx = s.letterSpacing.endsWith('em') ? val * fsPx : val;
        }

        // advance[] — сдвиг курсора после каждого символа.
        // visual[] — визуальная ширина (для рендера и bbox).
        const advance = [];
        const visual = [];
        let total = 0;
        const len = text.length;
        for (let i = 0; i < len; i++) {
            const ch = text[i];
            let w = _measure(ch, s.fontSize, s.fontFamily, s.fontWeight, s.fontStyle);
            if (ch === ' ' && w < fsPx * 0.25) w = fsPx * 0.25;
            const isLast = i === len - 1;
            visual.push(w);
            const adv = isLast ? w : w + lsPx;
            advance.push(adv);
            total += adv;
        }

        this._charWidths = { text, advance, visual, total };
        return this._charWidths;
    }

    _candidatesSigKey() {
        return this._screenDataSig + '|' +
            (this._charWidths?.total || 0) + '|' +
            this.tracking + '|' + this.priorityMode + '|' +
            (this.lineData.textVerticalAlign || '') + '|' +
            this.placement + '|' +
            JSON.stringify(this.lineData.textOffset || [0, 0]);
    }

    // ── Кандидаты ────────────────────────────────────────────────

    _buildCandidates(data, cw) {
        const totalPx = data.totalLenPx;
        const visibleLen = data.visibleIntervalPx.max - data.visibleIntervalPx.min;
        if (totalPx < cw.total || visibleLen < cw.total * 0.9) return [];

        const step = cw.total * this.tracking;
        const startMin = data.visibleIntervalPx.min;
        const startMax = data.visibleIntervalPx.max - cw.total;
        if (startMax < startMin) return [];

        const positions = [];
        const centerStart = startMin + (visibleLen - cw.total) * 0.5;
        if (centerStart >= startMin && centerStart <= startMax) positions.push(centerStart);

        for (let x = startMin; x <= startMax + 1e-3; x += step) {
            if (Math.abs(x - centerStart) > step * 0.5) positions.push(x);
        }
        if (positions.length === 0) return [];

        const candidates = [];
        for (const startPx of positions) {
            const charLayout = this._buildCharLayout(data, cw, startPx);
            if (!charLayout) continue;
            const bbox = this._charBBox(charLayout);
            if (!bbox) continue;
            candidates.push({ charLayout, bbox });
        }
        if (candidates.length === 0) return [];

        const ref = this.priorityMode === 'viewport'
            ? { x: data.canvasW / 2, y: data.canvasH / 2 }
            : data.tileCenterScreen;
        const baseScore = c => (c.bbox.cx - ref.x) ** 2 + (c.bbox.cy - ref.y) ** 2;

        const last = this._lastSelectedBBox;
        if (last && this.hysteresisPx > 0) {
            const hystSq = this.hysteresisPx ** 2;
            for (const c of candidates) {
                const d = (c.bbox.cx - last.cx) ** 2 + (c.bbox.cy - last.cy) ** 2;
                c._score = baseScore(c) - (d < hystSq ? hystSq * 0.5 : 0);
            }
        }
        candidates.sort((a, b) => (a._score ?? baseScore(a)) - (b._score ?? baseScore(b)));
        return candidates;
    }

    _buildCharLayout(data, cw, startPx) {
        const s = this.getTextStyle();
        const fs = parseFloat(s.fontSize) || 12;
        const [ox, oy] = this.lineData.textOffset || [0, 0];

        // Вертикальное выравнивание относительно линии.
        // 'top'    → подпись над линией (для рек)
        // 'middle' → поверх линии (для дорог)
        // 'bottom' → под линией
        let align = this.lineData.textVerticalAlign || 'middle';
        if (this.placement === 'above') align = 'top';
        else if (this.placement === 'below') align = 'bottom';
        else if (this.placement === 'center') align = 'middle';

        let coeff = 0;               // +1 = над линией, -1 = под
        if (align === 'top') coeff = 1;
        else if (align === 'bottom') coeff = -1;
        const perpDist = coeff * fs * 0.7;

        const layout = [];
        let px = startPx;
        const endPx = data.visibleIntervalPx.max + 1;
        const len = cw.text.length;
        for (let i = 0; i < len; i++) {
            if (px > endPx) return null;
            const visualW = cw.visual[i];
            const advanceW = cw.advance[i];
            // Сэмплируем в ЦЕНТРЕ визуального глифа.
            const centerPx = px + visualW * 0.5;
            const p = this._samplePx(data, centerPx);
            if (p.z <= 0 || p.z >= 1) return null;

            // Перпендикуляр "вверх" относительно направления текста:
            //   tangent = (cos θ, sin θ)  → up = (sin θ, −cos θ) в экранных (y↓) координатах.
            const rad = p.angle * Math.PI / 180;
            const sin = Math.sin(rad), cos = Math.cos(rad);
            const dxp = sin * perpDist;
            const dyp = -cos * perpDist;

            layout.push({
                char: cw.text[i],
                x: p.x + dxp + ox,
                y: p.y + dyp + oy,
                angle: p.angle,
                w: visualW
            });
            px += advanceW;
        }
        return layout;
    }

    _charBBox(layout) {
        const s = this.getTextStyle();
        const fs = parseFloat(s.fontSize) || 12;
        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
        for (const c of layout) {
            const rad = c.angle * Math.PI / 180;
            const cos = Math.cos(rad), sin = Math.sin(rad);
            const halfW = c.w * 0.5;
            const halfH = fs * 0.5;
            const rel = [
                { dx: -halfW, dy: -halfH },
                { dx:  halfW, dy: -halfH },
                { dx:  halfW, dy:  halfH },
                { dx: -halfW, dy:  halfH }
            ];
            for (const p of rel) {
                const x = c.x + p.dx * cos - p.dy * sin;
                const y = c.y + p.dx * sin + p.dy * cos;
                if (x < minX) minX = x;
                if (x > maxX) maxX = x;
                if (y < minY) minY = y;
                if (y > maxY) maxY = y;
            }
        }
        if (!isFinite(minX)) return null;
        return {
            minX, minY, maxX, maxY,
            cx: (minX + maxX) / 2,
            cy: (minY + maxY) / 2
        };
    }
}