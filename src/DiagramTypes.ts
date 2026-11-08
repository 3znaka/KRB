// DiagramTypes.ts

export interface DiagramData {
    label: string;
    value: number;
    color?: string;
}

export interface DiagramSize {
    width: number;
    height: number;
    anchor?: [number, number];
}

export type DiagramOrientation = 'horizontal' | 'vertical';
export type LabelPosition = 'top' | 'bottom' | 'left' | 'right' | 'inside';

export interface DiagramRenderParams {
    data: DiagramData[];
    width: number;
    height: number;
    dpr: number;
    unitPx: number;
    orientation?: DiagramOrientation;
    barWidth?: number;
    gap?: number;
    padding?: number;
    strokeColor?: string;
    strokeWidth?: number;

    // ── Подпись ──
    label?: string;
    labelPosition?: LabelPosition;
    labelFont?: string;
    labelColor?: string;

    // ── Венский способ (только для type: 'vienna') ──
    unitValue?: number;
    maxCols?: number;
    shape?: 'square' | 'circle';
    showTotal?: boolean;
    totalFormat?: (total: number) => string;
    totalFont?: string;
    totalBg?: string;
    totalColor?: string;
    totalBorder?: string;

    // ── Новое для vienna_cubes ──
    projection?: 'oblique' | 'isometric';

    coins?: number[];
     segmentSizes?: number[];
}

export interface DiagramTypeDefinition {
    name: string;
    computeSize(p: DiagramRenderParams): DiagramSize;
    render(ctx: CanvasRenderingContext2D, p: DiagramRenderParams): void;
}

// ── Общие утилиты ──────────────────────────────────────────────────
const DEFAULT_PALETTE = [
    '#3498db', '#e74c3c', '#2ecc71', '#f39c12',
    '#9b59b6', '#1abc9c', '#e67e22', '#34495e',
];
const CUBE_DEPTH = 0.35;
const LABEL_GAP = 4;

function shadeColor(hex: string, percent: number): string {
    const m = /^#?([0-9a-f]{6})$/i.exec(hex);
    if (!m) return hex;
    const num = parseInt(m[1], 16);
    const amt = Math.round(2.55 * percent);
    const R = Math.max(0, Math.min(255, (num >> 16) + amt));
    const G = Math.max(0, Math.min(255, ((num >> 8) & 0xff) + amt));
    const B = Math.max(0, Math.min(255, (num & 0xff) + amt));
    return `#${((R << 16) | (G << 8) | B).toString(16).padStart(6, '0')}`;
}

// Измерение текста для computeSize (доступен только в браузере).
let _measureCanvas: HTMLCanvasElement | null = null;
let _measureCtx: CanvasRenderingContext2D | null = null;

function measureText(text: string, font: string): { width: number; height: number } {
    let fontSize = 11;
    const fsMatch = /(\d+(?:\.\d+)?)px/.exec(font);
    if (fsMatch) fontSize = parseFloat(fsMatch[1]);

    if (typeof document !== 'undefined') {
        if (!_measureCanvas) {
            _measureCanvas = document.createElement('canvas');
            _measureCtx = _measureCanvas.getContext('2d');
        }
        if (_measureCtx) {
            _measureCtx.font = font;
            return { width: _measureCtx.measureText(text).width, height: fontSize * 1.2 };
        }
    }
    return { width: text.length * fontSize * 0.6, height: fontSize * 1.2 };
}

// ── Столбчатая ─────────────────────────────────────────────────────
// ── Столбчатая (с поддержкой делений) ──────────────────────────────
export const barDiagram: DiagramTypeDefinition = {
    name: 'bar',
    computeSize({ data, unitPx, barWidth = 12, gap = 2, padding = 4,
                  strokeWidth = 1, orientation = 'vertical' }) {
        const maxVal = Math.max(0, ...data.map(d => d.value));
        const n = data.length;
        if (orientation === 'horizontal') {
            return {
                width:  maxVal * unitPx + padding * 2 + strokeWidth * 2,
                height: n * barWidth + (n - 1) * gap + padding * 2 + strokeWidth * 2,
                anchor: [0.5, 0.5],
            };
        }
        return {
            width:  n * barWidth + (n - 1) * gap + padding * 2 + strokeWidth * 2,
            height: maxVal * unitPx + padding * 2 + strokeWidth * 2,
            anchor: [0.5, 0.5],
        };
    },
    render(ctx, { data, width, height, unitPx, barWidth = 12, gap = 2,
                  padding = 4, strokeColor = '#333', strokeWidth = 1,
                  orientation = 'vertical', segmentSizes }) {
        const maxVal = Math.max(0, ...data.map(d => d.value));

        // Вспомогательная функция для расчета позиций делений
        const getDivisions = (val: number) => {
            if (!segmentSizes || segmentSizes.length === 0) return [];
            const divs: number[] = [];
            let rem = val;
            for (const size of segmentSizes) {
                while (rem >= size) {
                    rem -= size;
                    divs.push(val - rem); // Сохраняем накопленную высоту
                }
            }
            return divs;
        };

        if (orientation === 'horizontal') {
            const chartW = width - padding * 2 - strokeWidth * 2;
            const left = padding + strokeWidth;
            let y = padding + strokeWidth;
            for (const d of data) {
                const bw = maxVal > 0 ? (d.value / maxVal) * chartW : 0;
                ctx.fillStyle = d.color ?? '#3388ff';
                ctx.fillRect(left, y, bw, barWidth);
                
                if (strokeWidth > 0) {
                    ctx.strokeStyle = strokeColor; ctx.lineWidth = strokeWidth;
                    ctx.strokeRect(left + strokeWidth / 2, y + strokeWidth / 2,
                                   Math.max(0, bw - strokeWidth), barWidth - strokeWidth);
                }

                // Отрисовка делений
                const divs = getDivisions(d.value);
                if (divs.length > 0 && strokeWidth > 0) {
                    ctx.beginPath();
                    ctx.strokeStyle = strokeColor;
                    ctx.lineWidth = strokeWidth;
                    for (const v of divs) {
                        const divX = left + v * unitPx;
                        ctx.moveTo(divX, y);
                        ctx.lineTo(divX, y + barWidth);
                    }
                    ctx.stroke();
                }
                y += barWidth + gap;
            }
            return;
        }

        const chartH = height - padding * 2 - strokeWidth * 2;
        const baseline = height - padding - strokeWidth;
        let x = padding + strokeWidth;
        for (const d of data) {
            const bh = maxVal > 0 ? (d.value / maxVal) * chartH : 0;
            const y = baseline - bh;
            ctx.fillStyle = d.color ?? '#3388ff';
            ctx.fillRect(x, y, barWidth, bh);
            
            if (strokeWidth > 0) {
                ctx.strokeStyle = strokeColor; ctx.lineWidth = strokeWidth;
                ctx.strokeRect(x + strokeWidth / 2, y + strokeWidth / 2,
                               barWidth - strokeWidth, Math.max(0, bh - strokeWidth));
            }

            // Отрисовка делений
            const divs = getDivisions(d.value);
            if (divs.length > 0 && strokeWidth > 0) {
                ctx.beginPath();
                ctx.strokeStyle = strokeColor;
                ctx.lineWidth = strokeWidth;
                for (const v of divs) {
                    const divY = baseline - v * unitPx;
                    ctx.moveTo(x, divY);
                    ctx.lineTo(x + barWidth, divY);
                }
                ctx.stroke();
            }
            x += barWidth + gap;
        }
    },
};

// ── Круговая (секторная) ──────────────────────────────────────────
export const pieDiagram: DiagramTypeDefinition = {
    name: 'pie',
    computeSize({ data, unitPx, padding = 4, strokeWidth = 1 }) {
        const total = data.reduce((s, d) => s + Math.max(0, d.value), 0);
        const r = Math.sqrt(total) * unitPx;
        return {
            width:  r * 2 + padding * 2 + strokeWidth * 2,
            height: r * 2 + padding * 2 + strokeWidth * 2,
            anchor: [0.5, 0.5],
        };
    },
    render(ctx, { data, width, height, unitPx, padding = 4,
                  strokeColor = '#333', strokeWidth = 1 }) {
        const total = data.reduce((s, d) => s + Math.max(0, d.value), 0);
        if (total <= 0) return;
        const cx = width / 2, cy = height / 2;
        const radius = Math.sqrt(total) * unitPx;
        let start = -Math.PI / 2;
        for (let i = 0; i < data.length; i++) {
            const d = data[i];
            const angle = (Math.max(0, d.value) / total) * Math.PI * 2;
            const end = start + angle;
            ctx.beginPath();
            ctx.moveTo(cx, cy);
            ctx.arc(cx, cy, radius, start, end);
            ctx.closePath();
            ctx.fillStyle = d.color ?? DEFAULT_PALETTE[i % DEFAULT_PALETTE.length];
            ctx.fill();
            if (strokeWidth > 0) {
                ctx.strokeStyle = strokeColor; ctx.lineWidth = strokeWidth; ctx.stroke();
            }
            start = end;
        }
    },
};

// ── Кружки ────────────────────────────────────────────────────────
export const circleDiagram: DiagramTypeDefinition = {
    name: 'circle',
    computeSize({ data, unitPx, gap = 6, padding = 4, strokeWidth = 1,
                  orientation = 'horizontal' }) {
        const diameters = data.map(d => 2 * Math.sqrt(Math.max(0, d.value)) * unitPx);
        const maxD = Math.max(0, ...diameters);
        const total = diameters.reduce((s, v) => s + v, 0)
                    + gap * Math.max(0, data.length - 1);
        if (orientation === 'vertical') {
            return { width: maxD + padding * 2 + strokeWidth * 2,
                     height: total + padding * 2 + strokeWidth * 2,
                     anchor: [0.5, 0.5] };
        }
        return { width: total + padding * 2 + strokeWidth * 2,
                 height: maxD + padding * 2 + strokeWidth * 2,
                 anchor: [0.5, 0.5] };
    },
    render(ctx, { data, width, height, unitPx, gap = 6, padding = 4,
                  strokeColor = '#333', strokeWidth = 1,
                  orientation = 'horizontal' }) {
        const drawOne = (cx: number, cy: number, r: number, color: string) => {
            if (r <= 0) return;
            ctx.beginPath();
            ctx.arc(cx, cy, r, 0, Math.PI * 2);
            ctx.fillStyle = color; ctx.fill();
            if (strokeWidth > 0) {
                ctx.strokeStyle = strokeColor; ctx.lineWidth = strokeWidth; ctx.stroke();
            }
        };
        if (orientation === 'vertical') {
            const cx = width / 2;
            let y = padding + strokeWidth;
            for (let i = 0; i < data.length; i++) {
                const d = data[i];
                const diameter = 2 * Math.sqrt(Math.max(0, d.value)) * unitPx;
                drawOne(cx, y + diameter / 2, diameter / 2,
                        d.color ?? DEFAULT_PALETTE[i % DEFAULT_PALETTE.length]);
                y += diameter + gap;
            }
            return;
        }
        const cy = height / 2;
        let x = padding + strokeWidth;
        for (let i = 0; i < data.length; i++) {
            const d = data[i];
            const diameter = 2 * Math.sqrt(Math.max(0, d.value)) * unitPx;
            drawOne(x + diameter / 2, cy, diameter / 2,
                    d.color ?? DEFAULT_PALETTE[i % DEFAULT_PALETTE.length]);
            x += diameter + gap;
        }
    },
};

// ── Кубики ────────────────────────────────────────────────────────
export const cubeDiagram: DiagramTypeDefinition = {
    name: 'cube',
    computeSize({ data, unitPx, gap = 6, padding = 4, strokeWidth = 1,
                  orientation = 'horizontal' }) {
        const sides  = data.map(d => Math.cbrt(Math.max(0, d.value)) * unitPx);
        const depths = sides.map(s => s * CUBE_DEPTH);
        if (orientation === 'vertical') {
            let cy = 0, maxRight = 0;
            for (let i = 0; i < sides.length; i++) {
                maxRight = Math.max(maxRight, sides[i] + depths[i]);
                cy += sides[i] + gap;
            }
            const totalH = cy - (data.length > 0 ? gap : 0);
            const maxDepth = Math.max(0, ...depths);
            return { width: maxRight + padding * 2 + strokeWidth * 2,
                     height: totalH + maxDepth + padding * 2 + strokeWidth * 2,
                     anchor: [0.5, 0.5] };
        }
        let cx = 0, maxRight = 0, maxH = 0;
        for (let i = 0; i < sides.length; i++) {
            maxRight = Math.max(maxRight, cx + sides[i] + depths[i]);
            maxH     = Math.max(maxH, sides[i] + depths[i]);
            cx += sides[i] + gap;
        }
        return { width: maxRight + padding * 2 + strokeWidth * 2,
                 height: maxH + padding * 2 + strokeWidth * 2,
                 anchor: [0.5, 0.5] };
    },
    render(ctx, { data, width, height, unitPx, gap = 6, padding = 4,
                  strokeColor = '#333', strokeWidth = 1,
                  orientation = 'horizontal' }) {
        const sides  = data.map(d => Math.cbrt(Math.max(0, d.value)) * unitPx);
        const depths = sides.map(s => s * CUBE_DEPTH);
        const drawCube = (fx: number, fy: number, side: number, depth: number, color: string) => {
            if (side <= 0) return;
            ctx.lineJoin = 'round';
            ctx.beginPath();
            ctx.moveTo(fx, fy);
            ctx.lineTo(fx + side, fy);
            ctx.lineTo(fx + side + depth, fy - depth);
            ctx.lineTo(fx + depth, fy - depth);
            ctx.closePath();
            ctx.fillStyle = shadeColor(color, 25); ctx.fill();
            if (strokeWidth > 0) {
                ctx.strokeStyle = strokeColor; ctx.lineWidth = strokeWidth; ctx.stroke();
            }
            ctx.beginPath();
            ctx.moveTo(fx + side, fy);
            ctx.lineTo(fx + side + depth, fy - depth);
            ctx.lineTo(fx + side + depth, fy - depth + side);
            ctx.lineTo(fx + side, fy + side);
            ctx.closePath();
            ctx.fillStyle = shadeColor(color, -20); ctx.fill();
            if (strokeWidth > 0) {
                ctx.strokeStyle = strokeColor; ctx.lineWidth = strokeWidth; ctx.stroke();
            }
            ctx.beginPath();
            ctx.rect(fx, fy, side, side);
            ctx.fillStyle = color; ctx.fill();
            if (strokeWidth > 0) {
                ctx.strokeStyle = strokeColor; ctx.lineWidth = strokeWidth; ctx.stroke();
            }
        };
        if (orientation === 'vertical') {
            const maxDepth = Math.max(0, ...depths);
            const fx = padding + strokeWidth;
            let cy = padding + strokeWidth + maxDepth;
            for (let i = 0; i < data.length; i++) {
                const color = data[i].color ?? DEFAULT_PALETTE[i % DEFAULT_PALETTE.length];
                drawCube(fx, cy, sides[i], depths[i], color);
                cy += sides[i] + gap;
            }
            return;
        }
        const baseline = height - padding - strokeWidth;
        let cx = padding + strokeWidth;
        for (let i = 0; i < data.length; i++) {
            const color = data[i].color ?? DEFAULT_PALETTE[i % DEFAULT_PALETTE.length];
            drawCube(cx, baseline - sides[i], sides[i], depths[i], color);
            cx += sides[i] + gap;
        }
    },
};

// ── Венский способ (группа равнозначных фигур) ────────────────────
export const viennaDiagram: DiagramTypeDefinition = {
    name: 'vienna',

    computeSize({ data, unitPx, unitValue = 1, maxCols = 5,
                  gap = 1, padding = 4, strokeWidth = 1,
                  showTotal = false, totalFont = 'bold 12px sans-serif' }) {
        const total = data.reduce((s, d) => s + Math.max(0, d.value), 0);
        const totalUnits = Math.max(1, Math.round(total / unitValue));
        const cols = Math.min(totalUnits, maxCols);
        const rows = Math.ceil(totalUnits / cols);

        const gridW = cols * unitPx + (cols - 1) * gap;
        const gridH = rows * unitPx + (rows - 1) * gap;

        let w = gridW + padding * 2 + strokeWidth * 2;
        let h = gridH + padding * 2 + strokeWidth * 2;

        if (showTotal) {
            const text = String(total);
            const m = measureText(text, totalFont);
            const badgeR = Math.max(m.width / 2 + 6, 14) + 2;
            w = Math.max(w, badgeR * 2 + padding * 2);
            h += badgeR * 2 + 2;
        }
        return { width: w, height: h, anchor: [0.5, 0.5] };
    },

    render(ctx, { data, width, height, unitPx, unitValue = 1, maxCols = 5,
                  gap = 1, padding = 4, strokeWidth = 1,
                  strokeColor = '#333',
                  shape = 'square',
                  showTotal = false, totalFont = 'bold 12px sans-serif',
                  totalFormat,
                  totalBg = 'rgba(255,255,255,0.95)',
                  totalColor = '#222',
                  totalBorder = '#333' }) {
        const total = data.reduce((s, d) => s + Math.max(0, d.value), 0);
        const totalUnits = Math.max(1, Math.round(total / unitValue));
        const cols = Math.min(totalUnits, maxCols);
        const rows = Math.ceil(totalUnits / cols);

        const gridW = cols * unitPx + (cols - 1) * gap;
        const gridH = rows * unitPx + (rows - 1) * gap;

        // Сколько фигур на каждый ряд данных (с коррекцией до totalUnits)
        const unitsPerSeries = data.map(d => Math.max(0, Math.round(d.value / unitValue)));
        let sum = unitsPerSeries.reduce((s, u) => s + u, 0);
        while (sum < totalUnits && unitsPerSeries.length) { unitsPerSeries[0]++; sum++; }
        while (sum > totalUnits && unitsPerSeries.length) { unitsPerSeries[0]--; sum--; }

        const unitColors: string[] = [];
        for (let i = 0; i < unitsPerSeries.length; i++) {
            const color = data[i].color ?? DEFAULT_PALETTE[i % DEFAULT_PALETTE.length];
            for (let k = 0; k < unitsPerSeries[i]; k++) unitColors.push(color);
        }

        let gridY: number;
        let badgeCy = 0;
        if (showTotal) {
            const text = totalFormat ? totalFormat(total) : String(total);
            const m = measureText(text, totalFont);
            const badgeR = Math.max(m.width / 2 + 6, 14) + 2;
            gridY = padding + strokeWidth;
            badgeCy = gridY + gridH + 2 + badgeR;
        } else {
            gridY = (height - gridH) / 2;
        }
        const gridX = (width - gridW) / 2;

        for (let i = 0; i < totalUnits; i++) {
            const row = Math.floor(i / cols);
            const col = i % cols;
            const x = gridX + col * (unitPx + gap);
            const y = gridY + row * (unitPx + gap);
            const color = unitColors[i] ?? '#888';

            if (shape === 'circle') {
                ctx.beginPath();
                ctx.arc(x + unitPx / 2, y + unitPx / 2, unitPx / 2, 0, Math.PI * 2);
                ctx.fillStyle = color; ctx.fill();
                if (strokeWidth > 0) {
                    ctx.strokeStyle = strokeColor; ctx.lineWidth = strokeWidth; ctx.stroke();
                }
            } else {
                ctx.fillStyle = color;
                ctx.fillRect(x, y, unitPx, unitPx);
                if (strokeWidth > 0) {
                    ctx.strokeStyle = strokeColor; ctx.lineWidth = strokeWidth;
                    ctx.strokeRect(x + strokeWidth / 2, y + strokeWidth / 2,
                                   unitPx - strokeWidth, unitPx - strokeWidth);
                }
            }
        }

        if (showTotal) {
            const text = totalFormat ? totalFormat(total) : String(total);
            const m = measureText(text, totalFont);
            const badgeR = Math.max(m.width / 2 + 6, 14) + 2;
            const cx = width / 2;
            const cy = badgeCy;
            ctx.beginPath();
            ctx.arc(cx, cy, badgeR, 0, Math.PI * 2);
            ctx.fillStyle = totalBg; ctx.fill();
            ctx.strokeStyle = totalBorder; ctx.lineWidth = Math.max(1, strokeWidth); ctx.stroke();
            ctx.font = totalFont;
            ctx.fillStyle = totalColor;
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            ctx.fillText(text, cx, cy + 0.5);
        }
    },
};

// ── Вспомогательные функции для 'coin' ──────────────────────────────
function getAutoCoins(maxVal: number): number[] {
    if (maxVal <= 0) return [1];
    const res = new Set<number>();
    let p = Math.pow(10, Math.floor(Math.log10(maxVal)));
    for (let i = 0; i < 3; i++) {
        res.add(p);
        res.add(p * 5);
        p /= 10;
    }
    return Array.from(res).filter(v => v <= maxVal).sort((a,b) => b - a).slice(0, 4);
}

// Пробует разложить монеты с заданной шириной targetW
function tryLayout(items: any[], targetW: number, gap: number) {
    let x = 0, y = 0, rowH = 0;
    let maxW = 0;
    const layout: any[] = [];
    
    for (const item of items) {
        if (x > 0 && x + item.d > targetW) {
            x = 0;
            y += rowH + gap; // Отступ между строками
            rowH = 0;
        }
        layout.push({ x: x + item.d / 2, y: y + item.d / 2, r: item.r, color: item.color });
        x += item.d + gap; // Отступ между монетами
        rowH = Math.max(rowH, item.d);
        maxW = Math.max(maxW, x - gap);
    }
    return { layout, totalW: maxW, totalH: y + rowH };
}

function layoutCoins(coins: { val: number, color?: string }[], unitPx: number) {
    const gap = 4;
    const items = coins.map(c => {
        const r = Math.sqrt(Math.max(0, c.val)) * unitPx;
        return { ...c, r, d: r * 2 };
    });
    items.sort((a, b) => b.d - a.d); // Сначала крупные

    if (items.length === 0) return { layout: [], totalW: 0, totalH: 0 };

    const maxD = items[0].d;
    const totalArea = items.reduce((s, item) => s + Math.PI * item.r * item.r, 0);
    const S = Math.sqrt(totalArea) * 1.2;
    
    // Перебираем разные варианты ширины, чтобы bbox стал квадратным
    const candidates = [maxD, S * 0.6, S * 0.8, S * 1.0, S * 1.2, S * 1.5, S * 2.0];
    let best = null;

    for (const targetW of candidates) {
        const res = tryLayout(items, Math.max(maxD, targetW), gap);
        if (!best) {
            best = res;
        } else {
            const aspectBest = Math.abs(best.totalW - best.totalH);
            const aspectCur = Math.abs(res.totalW - res.totalH);
            const areaBest = best.totalW * best.totalH;
            const areaCur = res.totalW * res.totalH;
            // Минимизируем разницу сторон, при равенстве — минимизируем площадь
            if (aspectCur < aspectBest || (aspectCur === aspectBest && areaCur < areaBest)) {
                best = res;
            }
        }
    }
    return best!;
}

function layoutGroups(groups: { coins: { val: number, color?: string }[] }[], unitPx: number) {
    const gap = 10;
    const groupLayouts = groups.map(g => layoutCoins(g.coins, unitPx));
    
    if (groupLayouts.length === 0) return { layout: [], totalW: 0, totalH: 0 };
    if (groupLayouts.length === 1) return groupLayouts[0];

    const totalArea = groupLayouts.reduce((s, g) => s + g.totalW * g.totalH, 0);
    const S = Math.sqrt(totalArea) * 1.2;

    // То же самое: перебираем ширину для упаковки групп друг относительно друга
    const candidates = [S * 0.6, S * 0.8, S * 1.0, S * 1.2, S * 1.5, S * 2.0];
    let best = null;

    for (const targetW of candidates) {
        let x = 0, y = 0, rowH = 0;
        let maxW = 0;
        const layout: any[] = [];
        
        for (const g of groupLayouts) {
            if (x > 0 && x + g.totalW > targetW) {
                x = 0;
                y += rowH + gap;
                rowH = 0;
            }
            for (const item of g.layout) {
                layout.push({ x: x + item.x, y: y + item.y, r: item.r, color: item.color });
            }
            x += g.totalW + gap;
            rowH = Math.max(rowH, g.totalH);
            maxW = Math.max(maxW, x - gap);
        }
        const totalH = y + rowH;
        
        const res = { layout, totalW: maxW, totalH };
        if (!best) {
            best = res;
        } else {
            const aspectBest = Math.abs(best.totalW - best.totalH);
            const aspectCur = Math.abs(res.totalW - res.totalH);
            if (aspectCur < aspectBest) {
                best = res;
            } else if (aspectCur === aspectBest) {
                const areaBest = best.totalW * best.totalH;
                const areaCur = res.totalW * res.totalH;
                if (areaCur < areaBest) {
                    best = res;
                }
            }
        }
    }
    return best!;
}

export const coinDiagram: DiagramTypeDefinition = {
    name: 'coin',
    computeSize({ data, unitPx, padding = 4, strokeWidth = 1, coins: coinsInput }) {
        const maxVal = Math.max(...data.map(d => d.value), 1);
        const coins = coinsInput && coinsInput.length > 0
            ? [...coinsInput].sort((a,b) => b - a)
            : getAutoCoins(maxVal);

        const groups: { coins: { val: number, color?: string }[] }[] = [];
        for (let i = 0; i < data.length; i++) {
            const d = data[i];
            let rem = Math.max(0, d.value);
            const color = d.color ?? DEFAULT_PALETTE[i % DEFAULT_PALETTE.length];
            const groupCoins: { val: number, color?: string }[] = [];
            for (const c of coins) {
                const count = Math.floor(rem / c);
                for (let k = 0; k < count; k++) groupCoins.push({ val: c, color });
                rem %= c;
            }
            groups.push({ coins: groupCoins });
        }

        const { totalW, totalH } = layoutGroups(groups, unitPx);

        return {
            width: totalW + padding * 2 + strokeWidth * 2,
            height: totalH + padding * 2 + strokeWidth * 2,
            anchor: [0.5, 0.5]
        };
    },
    render(ctx, { data, width, height, unitPx, padding = 4,
                  strokeColor = '#333', strokeWidth = 1,
                  coins: coinsInput }) {
        const maxVal = Math.max(...data.map(d => d.value), 1);
        const coins = coinsInput && coinsInput.length > 0
            ? [...coinsInput].sort((a,b) => b - a)
            : getAutoCoins(maxVal);

        const groups: { coins: { val: number, color?: string }[] }[] = [];
        for (let i = 0; i < data.length; i++) {
            const d = data[i];
            let rem = Math.max(0, d.value);
            const color = d.color ?? DEFAULT_PALETTE[i % DEFAULT_PALETTE.length];
            const groupCoins: { val: number, color?: string }[] = [];
            for (const c of coins) {
                const count = Math.floor(rem / c);
                for (let k = 0; k < count; k++) groupCoins.push({ val: c, color });
                rem %= c;
            }
            groups.push({ coins: groupCoins });
        }

        const { layout, totalW, totalH } = layoutGroups(groups, unitPx);

        const offsetX = (width - totalW) / 2;
        const offsetY = (height - totalH) / 2;

        for (const item of layout) {
            const cx = offsetX + item.x;
            const cy = offsetY + item.y;
            const r = item.r;

            if (r > 0) {
                ctx.beginPath();
                ctx.arc(cx, cy, r, 0, Math.PI * 2);
                ctx.fillStyle = item.color ?? '#3388ff';
                ctx.fill();
                if (strokeWidth > 0) {
                    ctx.strokeStyle = strokeColor;
                    ctx.lineWidth = strokeWidth;
                    ctx.stroke();
                }
            }
        }
    }
};

// ── Обёртка: подписи для всех типов ────────────────────────────────
function withLabel(def: DiagramTypeDefinition): DiagramTypeDefinition {
    return {
        name: def.name,

        computeSize(params) {
            const inner = def.computeSize(params);
            const { label, labelFont = '11px sans-serif', labelPosition = 'bottom' } = params;
            if (!label) return inner;
            const m = measureText(label, labelFont);
            let w = inner.width, h = inner.height;
            if (labelPosition === 'top' || labelPosition === 'bottom') {
                h += m.height + LABEL_GAP;
            } else if (labelPosition === 'left' || labelPosition === 'right') {
                w += m.width + LABEL_GAP;
            }
            return { width: w, height: h, anchor: [0.5, 0.5] };
        },

        render(ctx, params) {
            const { label, labelFont = '11px sans-serif',
                    labelColor = '#222', labelPosition = 'bottom',
                    width, height } = params;

            let innerX = 0, innerY = 0, innerW = width, innerH = height;
            if (label) {
                const m = measureText(label, labelFont);
                if (labelPosition === 'bottom')      innerH -= m.height + LABEL_GAP;
                else if (labelPosition === 'top')    { innerY = m.height + LABEL_GAP; innerH -= m.height + LABEL_GAP; }
                else if (labelPosition === 'left')   { innerX = m.width + LABEL_GAP;  innerW -= m.width + LABEL_GAP; }
                else if (labelPosition === 'right')  innerW -= m.width + LABEL_GAP;
            }

            ctx.save();
            ctx.translate(innerX, innerY);
            def.render(ctx, { ...params, width: innerW, height: innerH });
            ctx.restore();

            if (!label) return;

            ctx.save();
            ctx.font = labelFont;
            ctx.fillStyle = labelColor;
            ctx.textBaseline = 'middle';
            ctx.textAlign = 'center';
            const m = measureText(label, labelFont);
            let tx = width / 2, ty = height / 2;
            switch (labelPosition) {
                case 'top':    ty = m.height / 2; break;
                case 'left':   tx = m.width / 2; break;
                case 'right':  tx = innerW + LABEL_GAP + m.width / 2; break;
                case 'inside': break;   // центр — дефолт
                case 'bottom':
                default:       ty = innerH + LABEL_GAP + m.height / 2;
            }
            ctx.fillText(label, tx, ty);
            ctx.restore();
        },
    };
}

function drawCube(
    ctx: CanvasRenderingContext2D,
    cx: number, cy: number, S: number,
    color: string, strokeColor: string, strokeWidth: number,
    projection: 'oblique' | 'isometric'
) {
    if (projection === 'oblique') {
        // Кабинетная проекция: фронтальная грань — квадрат (90°), глубина идет под 45°
        const dx = S * Math.cos(Math.PI / 4);
        const dy = S * Math.sin(Math.PI / 4);

        // Передняя грань (базовый цвет)
        ctx.beginPath();
        ctx.rect(cx - S / 2, cy - S / 2, S, S);
        ctx.fillStyle = color; ctx.fill();
        if (strokeWidth > 0) { ctx.strokeStyle = strokeColor; ctx.lineWidth = strokeWidth; ctx.stroke(); }

        // Верхняя грань (светлее)
        ctx.beginPath();
        ctx.moveTo(cx - S / 2, cy - S / 2);
        ctx.lineTo(cx + S / 2, cy - S / 2);
        ctx.lineTo(cx + S / 2 + dx, cy - S / 2 - dy);
        ctx.lineTo(cx - S / 2 + dx, cy - S / 2 - dy);
        ctx.closePath();
        ctx.fillStyle = shadeColor(color, 30); ctx.fill();
        if (strokeWidth > 0) { ctx.strokeStyle = strokeColor; ctx.lineWidth = strokeWidth; ctx.stroke(); }

        // Правая грань (темнее)
        ctx.beginPath();
        ctx.moveTo(cx + S / 2, cy - S / 2);
        ctx.lineTo(cx + S / 2 + dx, cy - S / 2 - dy);
        ctx.lineTo(cx + S / 2 + dx, cy + S / 2 - dy);
        ctx.lineTo(cx + S / 2, cy + S / 2);
        ctx.closePath();
        ctx.fillStyle = shadeColor(color, -20); ctx.fill();
        if (strokeWidth > 0) { ctx.strokeStyle = strokeColor; ctx.lineWidth = strokeWidth; ctx.stroke(); }
    } else {
        // Классическая изометрия (оси под 30° к горизонту)
        const dx = S * Math.sqrt(3) / 2;
        const dy = S * 0.5;

        // Верхняя грань
        ctx.beginPath();
        ctx.moveTo(cx, cy - S);
        ctx.lineTo(cx + dx, cy - S + dy);
        ctx.lineTo(cx, cy);
        ctx.lineTo(cx - dx, cy - S + dy);
        ctx.closePath();
        ctx.fillStyle = shadeColor(color, 30); ctx.fill();
        if (strokeWidth > 0) { ctx.strokeStyle = strokeColor; ctx.lineWidth = strokeWidth; ctx.stroke(); }

        // Левая грань
        ctx.beginPath();
        ctx.moveTo(cx - dx, cy - S + dy);
        ctx.lineTo(cx, cy);
        ctx.lineTo(cx, cy + S);
        ctx.lineTo(cx - dx, cy + S - dy);
        ctx.closePath();
        ctx.fillStyle = color; ctx.fill();
        if (strokeWidth > 0) { ctx.strokeStyle = strokeColor; ctx.lineWidth = strokeWidth; ctx.stroke(); }

        // Правая грань
        ctx.beginPath();
        ctx.moveTo(cx + dx, cy - S + dy);
        ctx.lineTo(cx, cy);
        ctx.lineTo(cx, cy + S);
        ctx.lineTo(cx + dx, cy + S - dy);
        ctx.closePath();
        ctx.fillStyle = shadeColor(color, -20); ctx.fill();
        if (strokeWidth > 0) { ctx.strokeStyle = strokeColor; ctx.lineWidth = strokeWidth; ctx.stroke(); }
    }
}



export const viennaCubeDiagram: DiagramTypeDefinition = {
    name: 'vienna_cubes',

    computeSize({ data, unitPx, unitValue = 1, padding = 4, strokeWidth = 1,
                  showTotal = false, totalFont = 'bold 12px sans-serif',
                  projection = 'oblique' }) {
        const total = data.reduce((s, d) => s + Math.max(0, d.value), 0);
        const totalUnits = Math.max(1, Math.round(total / unitValue));

        // Оптимальная упаковка в 3D куб
        let best = { w: 1, d: 1, h: 1, score: Infinity };
        for (let h = 1; h <= Math.ceil(Math.cbrt(totalUnits)) + 1; h++) {
            const w = Math.ceil(Math.sqrt(totalUnits / h));
            const d = Math.ceil(totalUnits / (w * h));
            const vol = w * d * h;
            const score = Math.abs(w - d) * 1.5 + Math.abs(d - h) + (vol - totalUnits) * 0.5;
            if (score < best.score) best = { w, d, h, score };
        }
        const { w, d, h } = best;

        const S = unitPx;
        let bboxW, bboxH;

        if (projection === 'oblique') {
            const dx = S * Math.cos(Math.PI / 4);
            const dy = S * Math.sin(Math.PI / 4);
            bboxW = w * S + d * dx;
            bboxH = h * S + d * dy;
        } else {
            const dx = S * Math.sqrt(3) / 2;
            const dy = S * 0.5;
            bboxW = (w + d) * dx;
            bboxH = (w + d) * dy + h * S;
        }

        let finalW = bboxW + padding * 2 + strokeWidth * 2;
        let finalH = bboxH + padding * 2 + strokeWidth * 2;

        if (showTotal) {
            const text = String(total);
            const m = measureText(text, totalFont);
            const badgeR = Math.max(m.width / 2 + 6, 14) + 2;
            finalW = Math.max(finalW, badgeR * 2 + padding * 2);
            finalH += badgeR * 2 + 2;
        }
        return { width: finalW, height: finalH, anchor: [0.5, 0.5] };
    },

    render(ctx, { data, width, height, unitPx, unitValue = 1,
                  padding = 4, strokeWidth = 1, strokeColor = '#333',
                  showTotal = false, totalFont = 'bold 12px sans-serif',
                  totalFormat, totalBg = 'rgba(255,255,255,0.95)',
                  totalColor = '#222', totalBorder = '#333',
                  projection = 'oblique' }) {
        const total = data.reduce((s, d) => s + Math.max(0, d.value), 0);
        const totalUnits = Math.max(1, Math.round(total / unitValue));

        let best = { w: 1, d: 1, h: 1, score: Infinity };
        for (let h = 1; h <= Math.ceil(Math.cbrt(totalUnits)) + 1; h++) {
            const w = Math.ceil(Math.sqrt(totalUnits / h));
            const d = Math.ceil(totalUnits / (w * h));
            const vol = w * d * h;
            const score = Math.abs(w - d) * 1.5 + Math.abs(d - h) + (vol - totalUnits) * 0.5;
            if (score < best.score) best = { w, d, h, score };
        }
        const { w, d, h } = best;

        const S = unitPx;
        let bboxW, bboxH, dx, dy;

        if (projection === 'oblique') {
            dx = S * Math.cos(Math.PI / 4);
            dy = S * Math.sin(Math.PI / 4);
            bboxW = w * S + d * dx;
            bboxH = h * S + d * dy;
        } else {
            dx = S * Math.sqrt(3) / 2;
            dy = S * 0.5;
            bboxW = (w + d) * dx;
            bboxH = (w + d) * dy + h * S;
        }

        const unitsPerSeries = data.map(d => Math.max(0, Math.round(d.value / unitValue)));
        let sum = unitsPerSeries.reduce((s, u) => s + u, 0);
        while (sum < totalUnits && unitsPerSeries.length) { unitsPerSeries[0]++; sum++; }
        while (sum > totalUnits && unitsPerSeries.length) { unitsPerSeries[0]--; sum--; }

        const unitColors: string[] = [];
        for (let i = 0; i < unitsPerSeries.length; i++) {
            const color = data[i].color ?? DEFAULT_PALETTE[i % DEFAULT_PALETTE.length];
            for (let k = 0; k < unitsPerSeries[i]; k++) unitColors.push(color);
        }

        let gridY: number;
        let badgeCy = 0;
        if (showTotal) {
            const text = totalFormat ? totalFormat(total) : String(total);
            const m = measureText(text, totalFont);
            const badgeR = Math.max(m.width / 2 + 6, 14) + 2;
            gridY = padding + strokeWidth;
            badgeCy = gridY + bboxH + 2 + badgeR;
        } else {
            gridY = (height - bboxH) / 2;
        }
        const gridX = (width - bboxW) / 2;

        const cubes = [];
        let count = 0;
        // ИСПРАВЛЕНИЕ: Заполняем СЗАДИ ВПЕРЁД (y от d-1 до 0)
        for (let z = 0; z < h; z++) {
            for (let y = d - 1; y >= 0; y--) {
                for (let x = 0; x < w; x++) {
                    if (count < totalUnits) {
                        cubes.push({ x, y, z, color: unitColors[count] });
                        count++;
                    }
                }
            }
        }

        // СОРТИРОВКА
        if (projection === 'oblique') {
            cubes.sort((a, b) => {
                if (a.y !== b.y) return b.y - a.y; // Дальние (y=max) первыми
                if (a.z !== b.z) return a.z - b.z; // Нижние (z=0) первыми
                return a.x - b.x;                  // Левые (x=0) первыми
            });
        } else {
            cubes.sort((a, b) => {
                if (a.z !== b.z) return a.z - b.z; 
                const depthA = a.x + a.y;
                const depthB = b.x + b.y;
                return depthA - depthB; // Дальние первыми
            });
        }

        ctx.lineJoin = 'round';
        for (const c of cubes) {
            let cx, cy;
            if (projection === 'oblique') {
                cx = gridX + c.x * S + S / 2 + c.y * dx;
                cy = gridY + bboxH - c.z * S - S / 2 - c.y * dy;
            } else {
                cx = gridX + bboxW / 2 + (c.x - c.y - (w - d) / 2) * dx;
                cy = gridY + bboxH / 2 + (c.x + c.y - (w + d) / 2) * dy - (c.z - h / 2) * S;
            }
            drawCube(ctx, cx, cy, S, c.color, strokeColor, strokeWidth, projection);
        }

        if (showTotal) {
            const text = totalFormat ? totalFormat(total) : String(total);
            const m = measureText(text, totalFont);
            const badgeR = Math.max(m.width / 2 + 6, 14) + 2;
            const cx = width / 2;
            const cy = badgeCy;
            ctx.beginPath();
            ctx.arc(cx, cy, badgeR, 0, Math.PI * 2);
            ctx.fillStyle = totalBg; ctx.fill();
            ctx.strokeStyle = totalBorder; ctx.lineWidth = Math.max(1, strokeWidth); ctx.stroke();
            ctx.font = totalFont;
            ctx.fillStyle = totalColor;
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            ctx.fillText(text, cx, cy + 0.5);
        }
    },
};

// ── Реестр ────────────────────────────────────────────────────────
export const DIAGRAM_TYPES: Record<string, DiagramTypeDefinition> = {
    bar:          withLabel(barDiagram),
    pie:          withLabel(pieDiagram),
    circle:       withLabel(circleDiagram),
    cube:         withLabel(cubeDiagram),
    vienna:       withLabel(viennaDiagram),
    viennaCubes: withLabel(viennaCubeDiagram), 
    coin:         withLabel(coinDiagram),
};

export function registerDiagramType(def: DiagramTypeDefinition): void {
    DIAGRAM_TYPES[def.name] = withLabel(def);
}

export function getDiagramType(name: string): DiagramTypeDefinition {
    const t = DIAGRAM_TYPES[name];
    if (!t) throw new Error(
        `Diagram: unknown type "${name}". Registered: ${Object.keys(DIAGRAM_TYPES).join(', ')}`
    );
    return t;
}