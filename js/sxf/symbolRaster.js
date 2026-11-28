/**
 * Размер знака на экране: maxGabarit (мкм) переводится в мм бумажной карты и умножается на
 * SYMBOL_PX_PER_MM. Одинаковый коэффициент для всех знаков сохраняет их соотношения из классификатора.
 */
export const SYMBOL_PX_PER_MM = 30;
/** Минимальный размер знака на экране, px (мелкие знаки не должны исчезнуть). */
export const SYMBOL_MIN_PX = 8;
/** Максимальный размер знака на экране, px (крупные знаки не должны закрывать карту). */
export const SYMBOL_MAX_PX = 96;
/** Размер canvas знака (CSS-px) по его максимальному габариту. */
export function symbolSizePx(maxGabaritMkm) {
    const mm = Math.max(0, maxGabaritMkm) / 1000;
    const px = Math.round(mm * SYMBOL_PX_PER_MM);
    return Math.min(SYMBOL_MAX_PX, Math.max(SYMBOL_MIN_PX, px));
}
const cache = new Map();
function cssColor(c, fallback = '#545454') {
    if (!c)
        return fallback;
    if (c.hex)
        return c.hex;
    if (c.r != null && c.g != null && c.b != null)
        return `rgb(${c.r},${c.g},${c.b})`;
    return fallback;
}
/**
 * Габарит знака в микронах: по максимальному удалению точек от точки привязки. Нужен,
 * чтобы вписать знак в квадрат SYMBOL_PX. Берём max(maxGabarit, реальные точки).
 */
function symbolExtent(sym) {
    let m = sym.maxGabarit > 0 ? sym.maxGabarit : 0;
    for (const f of sym.fragments) {
        for (const [x, y] of f.points)
            m = Math.max(m, Math.abs(x), Math.abs(y));
    }
    return m > 0 ? m : 1000;
}
/**
 * Рисует один фрагмент. Координаты фрагмента: точки привязки (anchor) — центр canvas,
 * ось Y вниз (как в canvas). Окружность: точка 0 — центр, точка 1 — радиусы (по X и по Y).
 */
function drawFragment(ctx, f, scale, ox, oy) {
    const pen = f.pen;
    const lw = pen?.width ? Math.max(1, pen.width * scale) : 1;
    const stroke = pen?.kind === 135 ? null : cssColor(pen?.color);
    const fill = pen?.kind === 135 ? cssColor(pen?.color) : null;
    ctx.beginPath();
    switch (f.chain) {
        case 7: // окружность: центр, радиусы
        case 6: // круг (площадной)
        case 64: // эллипс
        case 65: { // эллипс (площадной)
            if (f.points.length < 2)
                break;
            const [cx, cy] = f.points[0];
            const [rx, ry] = f.points[1];
            ctx.ellipse(ox + cx * scale, oy + cy * scale, Math.max(0.5, Math.abs(rx) * scale), Math.max(0.5, Math.abs(ry) * scale), 0, 0, Math.PI * 2);
            break;
        }
        case 1: // линия
        case 0: { // площадь (контур полигона)
            if (f.points.length < 2)
                break;
            ctx.moveTo(ox + f.points[0][0] * scale, oy + f.points[0][1] * scale);
            for (let i = 1; i < f.points.length; i++)
                ctx.lineTo(ox + f.points[i][0] * scale, oy + f.points[i][1] * scale);
            if (f.chain === 0)
                ctx.closePath();
            break;
        }
        default:
            // Прочие цепочки (дуги, текст) в первой версии не рисуются.
            return;
    }
    if (fill) {
        ctx.fillStyle = fill;
        ctx.fill();
    }
    if (stroke) {
        ctx.strokeStyle = stroke;
        ctx.lineWidth = lw;
        ctx.stroke();
    }
}
/**
 * Растеризует векторный знак в canvas. Возвращает canvas SYMBOL_PX × SYMBOL_PX.
 * Знак вписывается в квадрат с сохранением пропорций; привязка совпадает с центром квадрата.
 */
export function rasterizeVectorSymbol(key, sym) {
    const cached = cache.get(key);
    if (cached)
        return cached;
    const cssPx = symbolSizePx(sym.maxGabarit);
    const canvas = document.createElement('canvas');
    const dpr = typeof window !== 'undefined' && window.devicePixelRatio ? Math.min(2, window.devicePixelRatio) : 1;
    const px = cssPx * dpr;
    canvas.width = px;
    canvas.height = px;
    canvas.style.width = cssPx + 'px';
    canvas.style.height = cssPx + 'px';
    const ctx = canvas.getContext('2d');
    if (ctx) {
        // Масштаб: микроны → пиксели так, чтобы габарит вписался в ~90% квадрата.
        const extent = symbolExtent(sym);
        const scale = (px * 0.45) / extent;
        ctx.clearRect(0, 0, px, px);
        ctx.lineCap = 'round';
        ctx.lineJoin = 'round';
        // Координаты фрагментов отсчитаны от точки привязки (левый верхний угол знака, прим. 9
        // к Таблице 35). Центр знака — на половине габарита от привязки. Переносим центр знака в
        // центр canvas, иначе знак уезжает вправо-вниз и виден только угол.
        // Центр знака — центр bbox всех точек фрагментов: привязка и габарит дают разные центры
        // (для окружности центр совпадает с привязкой, для фонтанов — нет), bbox надёжнее.
        let minx = Infinity, maxx = -Infinity, miny = Infinity, maxy = -Infinity;
        const grow = (x, y) => {
            if (x < minx)
                minx = x;
            if (x > maxx)
                maxx = x;
            if (y < miny)
                miny = y;
            if (y > maxy)
                maxy = y;
        };
        for (const f of sym.fragments) {
            const ellipse = f.chain === 6 || f.chain === 7 || f.chain === 64 || f.chain === 65;
            if (ellipse && f.points.length >= 2) {
                // Окружность/эллипс: точка 0 — центр, точка 1 — радиусы. Берём край, а не центр.
                const [ex, ey] = f.points[0];
                const [rx, ry] = f.points[1];
                grow(ex - Math.abs(rx), ey - Math.abs(ry));
                grow(ex + Math.abs(rx), ey + Math.abs(ry));
            }
            else {
                for (const [x, y] of f.points)
                    grow(x, y);
            }
        }
        // Декодер отдаёт знак в системе центра (0,0): центрирование по bbox здесь не нужно.
        // Эталон центра — основной круг (окружность, chain 7): его центр помещаем в центр canvas.
        // Сдвигаем только точку-центр; радиусы (точка 1) не меняются.
        const base = sym.fragments.find(f => f.chain === 7 && f.points.length >= 2);
        const cx = base ? base.points[0][0] : 0;
        const cy = base ? base.points[0][1] : 0;
        // Порядок отрисовки: сначала заливки (перо площади, kind 135), затем линии (kind 128),
        // чтобы контуры не терялись под заливкой. Внутри группы — порядок хранения.
        const ordered = [
            ...sym.fragments.filter(f => f.pen?.kind !== 128),
            ...sym.fragments.filter(f => f.pen?.kind === 128),
        ];
        for (const f of ordered) {
            const ell = f.chain === 6 || f.chain === 7 || f.chain === 64 || f.chain === 65;
            const shifted = {
                ...f,
                // Подтверждено на тестовой странице: сдвиг только у центров кружков, черты без сдвига.
                points: f.points.map(([x, y], j) => ell && j === 0 ? [x - cx, y - cy] : [x, y]),
            };
            drawFragment(ctx, shifted, scale, px / 2, px / 2);
        }
    }
    cache.set(key, canvas);
    return canvas;
}
/** Очистка кэша (например, при смене классификатора). */
export function clearSymbolRasterCache() {
    cache.clear();
}
