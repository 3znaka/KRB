/**
 * DotsBuilder — расчёт точек точечного способа по значениям растра.
 *
 * Точечный способ (учебник, §3.8): каждая точка обозначает «вес» единиц явления.
 * Число точек в пикселе = значение / вес. Остаток переносится в соседние
 * пиксели, чтобы суммарное число точек совпадало с суммой значений (иначе
 * мелкие значения терялись бы: пиксель со значением 99 при весе 100 дал бы 0).
 *
 * Точки раскладываются равномерно внутри пикселя (детерминированно, без
 * случайности), чтобы карта была воспроизводима.
 *
 * Модуль не зависит от растра и PointCloud: на входе сетка значений и геопривязка,
 * на выходе — позиции в координатах карты. Так же он будет работать для изолиний.
 *
 * @module DotsBuilder
 */

/** Детерминированный генератор (mulberry32): одна и та же последовательность для одного сида. */
function makeRng(seed: number): () => number {
    let a = seed >>> 0;
    return () => {
        a = (a + 0x6d2b79f5) >>> 0;
        let t = a;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

/**
 * Пуассоновская случайная величина с средним lambda (метод Кнута; для больших lambda —
 * нормальное приближение, чтобы не терять точность и не переполнять exp()).
 */
function poisson(lambda: number, rnd: () => number): number {
    if (!(lambda > 0)) return 0;
    if (lambda < 30) {
        const L = Math.exp(-lambda);
        let k = 0, p = 1;
        do { k++; p *= rnd(); } while (p > L);
        return k - 1;
    }
    // Нормальное приближение N(lambda, lambda), Box–Muller.
    const u1 = Math.max(rnd(), 1e-12), u2 = rnd();
    const z = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
    return Math.max(0, Math.round(lambda + Math.sqrt(lambda) * z));
}

/** Сид пикселя: разный для каждой клетки растра, стабильный между загрузками. */
function pixelSeed(row: number, col: number): number {
    // Хэш двух целых: соседние клетки не дают похожих сидов.
    let h = Math.imul(row, 374761393) ^ Math.imul(col, 668265263);
    h = Math.imul(h ^ (h >>> 13), 1274126177);
    return (h ^ (h >>> 16)) >>> 0;
}

export interface DotParams {
    /** Вес одной точки: единиц явления на точку. Обязателен, > 0. */
    weight: number;
    /** Цвет точек (CSS-строка или число 0xRRGGBB). */
    color?: string | number;
    /** Размер точки, px. */
    size?: number;
    /** Форма точки (см. PointCloud). */
    shape?: 'circle' | 'square' | 'diamond' | 'triangle' | 'cross';
}

export interface DotGrid {
    /** Значения пикселей, row-major (строка за строкой). */
    data: ArrayLike<number>;
    width: number;
    height: number;
    /** Координаты левого верхнего угла и размер пикселя в единицах CRS (x, y). */
    origin: [number, number];
    resolution: [number, number];
    /** Значения, которые считаются отсутствием данных (пропускаются). */
    noData?: number | null;
}

/** Точки в координатах CRS растра. */
export interface DotPoints {
    /** Позиции [x, y] для каждой точки. */
    positions: Array<[number, number]>;
    /** Сумма значений, которую представляют точки (для проверки). */
    totalValue: number;
    /** Число точек. */
    count: number;
}

/**
 * Считает точки по сетке значений.
 *
 * Алгоритм: проходим пиксели по порядку, накапливаем «долг» (остаток от предыдущих
 * пикселей), на каждый пиксель выдаём целое число точек = floor((значение + долг) / weight),
 * остаток переносим дальше. Так сумма точек ≈ сумма значений / weight с погрешностью
 * меньше одной точки на весь растр.
 */
export function buildDots(grid: DotGrid, params: DotParams): DotPoints {
    const { weight } = params;
    if (!(weight > 0) || !Number.isFinite(weight)) {
        throw new Error('DotsBuilder: weight должен быть положительным числом');
    }
    const { data, width, height, origin, resolution, noData = null } = grid;
    const [ox, oy] = origin;
    const [rx, ry] = resolution;

    const positions: Array<[number, number]> = [];
    let totalValue = 0;

    for (let row = 0; row < height; row++) {
        for (let col = 0; col < width; col++) {
            const v = data[row * width + col];
            if (!Number.isFinite(v) || (noData !== null && v === noData)) continue;
            if (v <= 0) continue;
            totalValue += v;

            // Среднее число точек пикселя — V / weight (может быть дробным).
            const lambda = v / weight;

            // Пиксель: x слева направо, y сверху вниз (геопривязка по origin/resolution).
            const cx = ox + (col + 0.5) * rx;
            const cy = oy + (row + 0.5) * ry;
            // Число точек — случайное (Пуассон со средним V/weight), воспроизводимо по
            // сиду пикселя. Фиксированное число точек на пиксель давало видимую решётку.
            const rnd = makeRng(pixelSeed(row, col));
            const n = poisson(lambda, rnd);
            for (let i = 0; i < n; i++) {
                const gx = rnd() - 0.5;
                const gy = rnd() - 0.5;
                positions.push([cx + gx * rx, cy + gy * ry]);
            }
        }
    }
    return { positions, totalValue, count: positions.length };
}
