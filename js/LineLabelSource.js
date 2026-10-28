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

export class VectorLineLabelSource {
    constructor(map, lineData, group, options = {}) {
        this.map = map;
        this.lineData = lineData;
        this.group = group;

        this.tracking       = options.tracking       ?? 1.35;
        this.placement      = options.placement      ?? 'auto';
        this.keepUpright    = options.keepUpright    ?? true;
        this.maxAngle       = options.maxAngle       ?? 45;
        this.unflipRange    = options.unflipRange    ?? 5;

        this._screenData = null;
        this._screenDataSig = null;
        this._charWidths = null;
        this._stableTs = null;
        this._lastFlipState = null;
    }

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

    // ── Дебаг-диагностика ────────────────────────────────────────
    diagnose(t) {
        const data = this._getScreenData();
        if (!data) return { error: "getScreenData() returned null (visible interval < 10px or behind camera)" };
        const cw = this._getCharWidths();
        if (!cw.total) return { error: "charWidths total is 0" };

        const startPx = this._tToPx(data, t);
        if (startPx < 0 || startPx + cw.total > data.totalLenPx + 0.01) {
            return {
                error: "Text does not fit on line",
                startPx: startPx.toFixed(1),
                totalLenPx: data.totalLenPx.toFixed(1),
                textW: cw.total.toFixed(1)
            };
        }

        const angleOk = !this._exceedsMaxAngle(data, startPx, cw);
        const w = this._sampleW(data, startPx);
        const camToCenter = this.map.camera.position.distanceTo(this.map.controls.target);
        const perspRatio = w > 1e-6 ? 0.5 + 0.5 * camToCenter / w : 0;

        const isFlipped = this._determineFlipState(data, startPx, cw, false, false);
        const charLayout = this._buildCharLayout(data, cw, startPx, isFlipped);
        const bbox = charLayout ? this._charBBox(charLayout) : null;
        
        let screenOk = false;
        if (bbox) {
            screenOk = this._isBBoxOnScreen(bbox, data);
        }

        return {
            t: t.toFixed(2),
            startPx: startPx.toFixed(1),
            totalLenPx: data.totalLenPx.toFixed(1),
            angleOk,
            perspRatio: perspRatio.toFixed(2),
            screenOk,
            charLayoutOk: !!charLayout,
            bbox: bbox ? `[${bbox.minX.toFixed(0)}, ${bbox.minY.toFixed(0)}, ${bbox.maxX.toFixed(0)}, ${bbox.maxY.toFixed(0)}]` : null,
            error: !charLayout ? "buildCharLayout returned null (w<=0 or out of bounds)" : 
                   (!angleOk ? "angle too sharp" : 
                   (perspRatio < 0.6 ? "perspRatio < 0.6" : 
                   (!screenOk ? "bbox is off-screen" : null)))
        };
    }

    // ── Проверка попадания на экран ──────────────────────────────
    _isBBoxOnScreen(bbox, data) {
        const pad = 50; // Небольшой отступ
        return !(bbox.maxX < -pad || bbox.minX > data.canvasW + pad ||
                 bbox.maxY < -pad || bbox.minY > data.canvasH + pad);
    }

    // ── Кандидаты ────────────────────────────────────────────────

    getCharLayoutAtT(t, isFlipped) {
        const data = this._getScreenData();
        if (!data) return null;
        const cw = this._getCharWidths();
        if (!cw.total) return null;
        const startPx = this._tToPx(data, t);
        return this._buildCharLayout(data, cw, startPx, isFlipped);
    }

    getCandidateAtT(t) {
        const data = this._getScreenData();
        if (!data) return null;
        const cw = this._getCharWidths();
        if (!cw.total) return null;

        const startPx = this._tToPx(data, t);
        if (startPx < 0 || startPx + cw.total > data.totalLenPx + 0.01) return null;

        const isFlipped = this._determineFlipState(data, startPx, cw, /*useHysteresis*/true, /*updateState*/true);
        const charLayout = this._buildCharLayout(data, cw, startPx, isFlipped);
        if (!charLayout) return null;

        const bbox = this._charBBox(charLayout);
        if (!bbox) return null;
        
        if (!this._isBBoxOnScreen(bbox, data)) return null;

        return { t, isFlipped, charLayout, bbox };
    }

    getCandidates() {
        const data = this._getScreenData();
        if (!data) return [];
        const cw = this._getCharWidths();
        if (!cw.total) return [];

        const ts = this._getStableCandidateTs();
        const totalPx = data.totalLenPx;
        const camToCenter = this.map.camera.position.distanceTo(this.map.controls.target);
        
        const centerX = data.canvasW / 2;
        const centerY = data.canvasH / 2;

        const result = [];
        for (let i = 0; i < ts.length; i++) {
            const t = ts[i];
            const startPx = this._tToPx(data, t);
            if (startPx < 0) continue;
            if (startPx + cw.total > totalPx + 0.01) continue;

            if (this._exceedsMaxAngle(data, startPx, cw)) continue;

            const wAtStart = this._sampleW(data, startPx);
            if (!(wAtStart > 1e-6)) continue;
            const perspRatio = 0.5 + 0.5 * camToCenter / wAtStart;
            if (perspRatio < 0.6) continue;

            const isFlipped = this._determineFlipState(data, startPx, cw, false, false);

            const charLayout = this._buildCharLayout(data, cw, startPx, isFlipped);
            if (!charLayout) continue;

            const bbox = this._charBBox(charLayout);
            if (!bbox) continue;
            
            if (!this._isBBoxOnScreen(bbox, data)) continue;

            // Сортируем по расстоянию до ЦЕНТРА ЭКРАНА.
            // Так как подписи появляются только когда камера замерла,
            // они не будут "прыгать", но всегда будут стремиться в центр.
            const score = (bbox.cx - centerX) ** 2 + (bbox.cy - centerY) ** 2;

            result.push({
                t,
                isFlipped,
                charLayout,
                bbox,
                score
            });
        }

        result.sort((a, b) => a.score - b.score);
        return result;
    }

    // ── Экранные данные ───────────────────────────────────────────

    _getScreenData() {
        const cam = this.map.camera;
        const wp = this.map.worldGroup.position;
        const gp = this.group.position;
        const offX = wp.x + gp.x;
        const offZ = wp.z + gp.z;
        const zoom = this.map.continuousZoom;
        const q = cam.quaternion;

        const sig =
            cam.position.x.toFixed(1) + ',' +
            cam.position.y.toFixed(1) + ',' +
            cam.position.z.toFixed(1) + '|' +
            q.x.toFixed(3) + ',' + q.y.toFixed(3) + ',' +
            q.z.toFixed(3) + ',' + q.w.toFixed(3) + '|' +
            offX.toFixed(1) + ',' + offZ.toFixed(1) + '|' +
            zoom.toFixed(1);

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
        const W = canvas.clientWidth;
        const H = canvas.clientHeight;
        if (W <= 0 || H <= 0) return null;

        camera.updateMatrixWorld();
        const viewProj = new THREE.Matrix4().multiplyMatrices(
            camera.projectionMatrix, camera.matrixWorldInverse
        );
        const v4 = new THREE.Vector4();
        const pointsScreen = new Array(n);
        const pointsW = new Array(n);

        for (let i = 0; i < n; i++) {
            const p = points3D[i];
            v4.set(p.x, p.y, p.z, 1).applyMatrix4(viewProj);
            const w = v4.w;
            pointsW[i] = w;
            if (w > 1e-6) {
                const invW = 1 / w;
                pointsScreen[i] = {
                    x: (v4.x * invW * 0.5 + 0.5) * W,
                    y: (-v4.y * invW * 0.5 + 0.5) * H,
                    z: v4.z * invW
                };
            } else {
                pointsScreen[i] = null;
            }
        }

        const segLengthsPx = new Array(n - 1);
        const segAngles = new Array(n - 1);
        const segRawAngles = new Array(n - 1);
        const segTileAngles = new Array(n - 1);
        const pointsPx = new Array(n);
        pointsPx[0] = 0;
        let totalLenPx = 0;
        let lastAngle = 0;
        let lastRawAngle = 0;
        let lastTileAngle = 0;

        for (let i = 0; i < n - 1; i++) {
            const s0 = pointsScreen[i];
            const s1 = pointsScreen[i + 1];

            const tdx = pts[i + 1].x - pts[i].x;
            const tdz = pts[i + 1].z - pts[i].z;
            if (tdx * tdx + tdz * tdz > 1e-18) {
                lastTileAngle = Math.atan2(tdz, tdx) * 180 / Math.PI;
            }
            segTileAngles[i] = lastTileAngle;

            if (s0 && s1) {
                const dx = s1.x - s0.x;
                const dy = s1.y - s0.y;
                const len = Math.hypot(dx, dy);
                segLengthsPx[i] = len;
                pointsPx[i + 1] = pointsPx[i] + len;
                totalLenPx += len;

                if (len > 1e-6) {
                    lastRawAngle = Math.atan2(dy, dx) * 180 / Math.PI;
                    let a = lastRawAngle;
                    if (a > 90) a -= 180;
                    else if (a < -90) a += 180;
                    lastAngle = a;
                }
                segAngles[i] = lastAngle;
                segRawAngles[i] = lastRawAngle;
            } else {
                segLengthsPx[i] = 0;
                pointsPx[i + 1] = pointsPx[i];
                segAngles[i] = lastAngle;
                segRawAngles[i] = lastRawAngle;
            }
        }
        if (totalLenPx < 1e-6) return null;

        const probe = {
            pointsPx, pointsScreen, pointsW,
            segAngles, segRawAngles, segTileAngles,
            pointsT, points3D, totalLenPx
        };

        const samples = 40;
        const flags = [];
        for (let i = 0; i <= samples; i++) {
            const px = (i / samples) * totalLenPx;
            const p = this._samplePx(probe, px);
            if (!p) { flags.push(false); continue; }
            const w = this._sampleW(probe, px);
            if (!(w > 1e-6)) { flags.push(false); continue; }
            // Ужесточили проверку: только реально видимые пиксели
            flags.push(
                p.z >= -1 && p.z <= 1 &&
                p.x >= 0 && p.x <= W &&
                p.y >= 0 && p.y <= H
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

        const tMinVisible = this._pxToT(probe, visibleIntervalPx.min);
        const tMaxVisible = this._pxToT(probe, visibleIntervalPx.max);
        const tMidVisible = (tMinVisible + tMaxVisible) / 2;

        const vc = new THREE.Vector3(offX, 0, offZ).project(camera);
        const tileCenterScreen = {
            x: (vc.x * 0.5 + 0.5) * W,
            y: (-vc.y * 0.5 + 0.5) * H
        };

        return {
            points3D,
            pointsScreen,
            pointsW,
            pointsT,
            pointsPx,
            segLengths,
            segLengthsPx,
            segAngles,
            segRawAngles,
            segTileAngles,
            totalLen,
            totalLenPx,
            visibleIntervalPx,
            tMidVisible,
            tileCenterScreen,
            canvasW: W,
            canvasH: H,
            camera
        };
    }

    _samplePx(data, px) {
        const { pointsPx, pointsScreen, pointsW, segAngles } = data;
        const n = pointsPx.length;
        if (px < 0) px = 0;
        if (px > data.totalLenPx) px = data.totalLenPx;

        for (let i = 0; i < n - 1; i++) {
            if (px <= pointsPx[i + 1]) {
                const w0 = pointsW[i];
                const w1 = pointsW[i + 1];
                if (!(w0 > 1e-6) || !(w1 > 1e-6)) return null;

                const seg = pointsPx[i + 1] - pointsPx[i];
                const u = seg > 1e-9 ? (px - pointsPx[i]) / seg : 0;
                const s0 = pointsScreen[i];
                const s1 = pointsScreen[i + 1];
                return {
                    x: s0.x + (s1.x - s0.x) * u,
                    y: s0.y + (s1.y - s0.y) * u,
                    z: s0.z + (s1.z - s0.z) * u,
                    angle: segAngles[i]
                };
            }
        }
        const last = n - 1;
        if (!(pointsW[last] > 1e-6)) return null;
        const s = pointsScreen[last];
        return { x: s.x, y: s.y, z: s.z, angle: segAngles[n - 2] ?? 0 };
    }

    _sampleW(data, px) {
        const { pointsPx, pointsW } = data;
        const n = pointsPx.length;
        if (px <= 0) return pointsW[0];
        if (px >= data.totalLenPx) return pointsW[n - 1];
        for (let i = 0; i < n - 1; i++) {
            if (px <= pointsPx[i + 1]) {
                const seg = pointsPx[i + 1] - pointsPx[i];
                const u = seg > 1e-9 ? (px - pointsPx[i]) / seg : 0;
                return pointsW[i] * (1 - u) + pointsW[i + 1] * u;
            }
        }
        return pointsW[n - 1];
    }

    _tToPx(data, t) {
        const { pointsT, pointsPx } = data;
        const n = pointsT.length;
        if (t <= 0) return 0;
        if (t >= 1) return data.totalLenPx;
        for (let i = 0; i < n - 1; i++) {
            if (t <= pointsT[i + 1]) {
                const segT = pointsT[i + 1] - pointsT[i];
                const u = segT > 1e-9 ? (t - pointsT[i]) / segT : 0;
                return pointsPx[i] + (pointsPx[i + 1] - pointsPx[i]) * u;
            }
        }
        return data.totalLenPx;
    }

    _pxToT(data, px) {
        const { pointsT, pointsPx } = data;
        const n = pointsT.length;
        if (px <= 0) return 0;
        if (px >= data.totalLenPx) return 1;
        for (let i = 0; i < n - 1; i++) {
            if (px <= pointsPx[i + 1]) {
                const segPx = pointsPx[i + 1] - pointsPx[i];
                const u = segPx > 1e-9 ? (px - pointsPx[i]) / segPx : 0;
                return pointsT[i] + (pointsT[i + 1] - pointsT[i]) * u;
            }
        }
        return 1;
    }

    _getRawAngleAt(data, px) {
        const { pointsPx, segRawAngles } = data;
        const n = pointsPx.length;
        if (px < 0) px = 0;
        if (px > data.totalLenPx) px = data.totalLenPx;
        for (let i = 0; i < n - 1; i++) {
            if (px <= pointsPx[i + 1]) return segRawAngles[i];
        }
        return segRawAngles[n - 2] ?? 0;
    }

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

    _getStableCandidateTs() {
        if (this._stableTs) return this._stableTs;
        const stepT = 0.05;
        const ts = [];
        const n = Math.floor(1 / stepT);
        for (let i = 0; i <= n; i++) ts.push(Math.min(1, i * stepT));
        this._stableTs = ts;
        return ts;
    }

    _determineFlipState(data, startPx, cw, useHysteresis, updateState) {
        if (!this.keepUpright) return false;

        const len = cw.visual.length;
        const firstCenterPx = startPx + cw.visual[0] * 0.5;
        const lastCenterPx  = startPx + cw.total - cw.visual[len - 1] * 0.5;

        const first = this._samplePx(data, firstCenterPx);
        const last  = this._samplePx(data, lastCenterPx);

        if (!first || !last) {
            return this._lastFlipState?.flipped ?? false;
        }

        const dx = last.x - first.x;
        const dy = last.y - first.y;

        let flipped = dx < 0;

        if (useHysteresis && this._lastFlipState) {
            const absDx = Math.abs(dx);
            const absDy = Math.abs(dy);
            const deadZone = Math.sin(this.unflipRange * Math.PI / 180) * absDy;
            if (absDx <= deadZone &&
                Math.abs(this._lastFlipState.anchorPx - startPx) < cw.total * 0.75) {
                flipped = this._lastFlipState.flipped;
            }
        }

        if (updateState) {
            this._lastFlipState = { flipped, anchorPx: startPx };
        }
        return flipped;
    }

    _exceedsMaxAngle(data, startPx, cw) {
        if (this.maxAngle >= 180) return false;

        const endPx = startPx + cw.total;
        const { pointsPx, segTileAngles, segLengthsPx } = data;
        const n = pointsPx.length;

        let firstSeg = -1;
        let lastSeg = -1;
        for (let i = 0; i < n - 1; i++) {
            if (pointsPx[i + 1] < startPx) continue;
            if (pointsPx[i] > endPx) break;
            if (firstSeg === -1) firstSeg = i;
            lastSeg = i;
        }
        if (firstSeg === -1 || lastSeg === -1) return false;
        if (firstSeg === lastSeg) return false;

        for (let i = firstSeg; i < lastSeg; i++) {
            if (segLengthsPx[i] < 1.0 || segLengthsPx[i + 1] < 1.0) continue;

            let diff = Math.abs(segTileAngles[i + 1] - segTileAngles[i]);
            if (diff > 180) diff = 360 - diff;
            if (diff > this.maxAngle) return true;
        }
        return false;
    }

    _buildCharLayout(data, cw, startPx, isFlipped) {
        const s = this.getTextStyle();
        const fs = parseFloat(s.fontSize) || 12;
        const [ox, oy] = this.lineData.textOffset || [0, 0];

        let align = this.lineData.textVerticalAlign || 'middle';
        if (this.placement === 'above') align = 'top';
        else if (this.placement === 'below') align = 'bottom';
        else if (this.placement === 'center') align = 'middle';
        let coeff = 0;
        if (align === 'top') coeff = 1;
        else if (align === 'bottom') coeff = -1;
        const perpDist = coeff * fs * 0.7;

        const layout = [];
        let px = startPx;
        const len = cw.text.length;
        const flipAngleDeg = isFlipped ? 180 : 0;

        for (let i = 0; i < len; i++) {
            const charIndex = isFlipped ? (len - 1 - i) : i;
            const visualW = cw.visual[charIndex];
            const advanceW = cw.advance[charIndex];
            const centerPx = px + visualW * 0.5;

            const rawDeg = this._getRawAngleAt(data, centerPx);
            const effDeg = rawDeg + flipAngleDeg;
            const rad = effDeg * Math.PI / 180;

            const p = this._samplePx(data, centerPx);
            if (!p) return null;

            const sin = Math.sin(rad);
            const cos = Math.cos(rad);
            const dxp = sin * perpDist;
            const dyp = -cos * perpDist;

            layout.push({
                char: cw.text[charIndex],
                x: p.x + dxp + ox,
                y: p.y + dyp + oy,
                angle: effDeg,
                w: visualW
            });

            px += advanceW;
        }
        return layout;
    }

    _charBBox(layout) {
        const s = this.getTextStyle();
        const fs = parseFloat(s.fontSize) || 12;
        let minX = Infinity, minY = Infinity;
        let maxX = -Infinity, maxY = -Infinity;
        const perChar = new Array(layout.length);

        for (let k = 0; k < layout.length; k++) {
            const c = layout[k];
            const rad = c.angle * Math.PI / 180;
            const cos = Math.cos(rad);
            const sin = Math.sin(rad);
            const halfW = c.w * 0.5;
            const halfH = fs * 0.5;
            const rel = [
                { dx: -halfW, dy: -halfH },
                { dx:  halfW, dy: -halfH },
                { dx:  halfW, dy:  halfH },
                { dx: -halfW, dy:  halfH }
            ];
            let cx0 = Infinity, cy0 = Infinity;
            let cx1 = -Infinity, cy1 = -Infinity;
            for (let r = 0; r < 4; r++) {
                const p = rel[r];
                const x = c.x + p.dx * cos - p.dy * sin;
                const y = c.y + p.dx * sin + p.dy * cos;
                if (x < cx0) cx0 = x;
                if (x > cx1) cx1 = x;
                if (y < cy0) cy0 = y;
                if (y > cy1) cy1 = y;
                if (x < minX) minX = x;
                if (x > maxX) maxX = x;
                if (y < minY) minY = y;
                if (y > maxY) maxY = y;
            }
            perChar[k] = { minX: cx0, minY: cy0, maxX: cx1, maxY: cy1 };
        }

        if (!isFinite(minX)) return null;

        return {
            minX, minY, maxX, maxY,
            cx: (minX + maxX) / 2,
            cy: (minY + maxY) / 2,
            perChar
        };
    }
}