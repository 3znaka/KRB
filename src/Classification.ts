// Classification.ts

export type ClassificationMethod =
    | 'equal'
    | 'quantile'
    | 'jenks'
    | 'logarithmic'
    | 'stddev'
    | 'geometric'
    | 'arithmetic'
    | 'headtail'
    | number[];

// ─────────────────────────────────────────────────────────────────
// calculateBreaks — единая точка входа
// ─────────────────────────────────────────────────────────────────

/**
 * Считает границы классов (breaks) для массива значений.
 *
 * Все методы возвращают массив вида `[min, b1, …, bn−1, max]`,
 * где `N+1` число задаёт `N` классов. Исключение — `headtail`:
 * он сам решает, сколько классов получится, поэтому длина
 * массива может быть любой (≥ 2).
 *
 * @example
 *   calculateBreaks([1, 10, 100, 1000], 'logarithmic', 3)
 *   // → [1, 10, 100, 1000]
 */
export function calculateBreaks(
    values: number[],
    method: ClassificationMethod,
    numClasses: number = 5,
): number[] {
    if (Array.isArray(method)) return method;

    const sorted = values
        .filter(v => typeof v === 'number' && isFinite(v))
        .sort((a, b) => a - b);
    if (sorted.length === 0) return [];

    const min = sorted[0];
    const max = sorted[sorted.length - 1];
    if (min === max) return [min, max];

    switch (method) {
        case 'equal':        return equalBreaks(min, max, numClasses);
        case 'quantile':     return quantileBreaks(sorted, numClasses);
        case 'jenks':        return jenksFull(sorted, numClasses);
        case 'logarithmic':  return logarithmicBreaks(sorted, numClasses);
        case 'stddev':       return stdDevBreaks(sorted, numClasses);
        case 'geometric':    return geometricBreaks(sorted, numClasses);
        case 'arithmetic':   return arithmeticBreaks(sorted, numClasses);
        case 'headtail':     return headTailBreaks(sorted, numClasses);
        default:             return [];
    }
}

// ─────────────────────────────────────────────────────────────────
// equal — равные интервалы
// ─────────────────────────────────────────────────────────────────

function equalBreaks(min: number, max: number, numClasses: number): number[] {
    const step = (max - min) / numClasses;
    const breaks: number[] = [min];
    for (let i = 1; i < numClasses; i++) breaks.push(min + step * i);
    breaks.push(max);
    return breaks;
}

// ─────────────────────────────────────────────────────────────────
// quantile — равное количество наблюдений в классе
// ─────────────────────────────────────────────────────────────────

function quantileBreaks(sorted: number[], numClasses: number): number[] {
    const n = sorted.length;
    const min = sorted[0];
    const max = sorted[n - 1];
    const breaks: number[] = [min];

    for (let i = 1; i < numClasses; i++) {
        const pos = (n - 1) * (i / numClasses);
        const base = Math.floor(pos);
        const rest = pos - base;
        breaks.push(
            sorted[base + 1] !== undefined
                ? sorted[base] + rest * (sorted[base + 1] - sorted[base])
                : sorted[base],
        );
    }

    breaks.push(max);
    return breaks;
}

// ─────────────────────────────────────────────────────────────────
// jenks — natural breaks (Fisher-Jenks)
// ─────────────────────────────────────────────────────────────────

function jenksFull(sorted: number[], numClasses: number): number[] {
    const internal = jenksInternal(sorted, numClasses);
    return [sorted[0], ...internal, sorted[sorted.length - 1]];
}

function jenksInternal(data: number[], numClasses: number): number[] {
    const n = data.length;
    const mat1 = Array.from({ length: n + 1 }, () => new Array(numClasses + 1).fill(0));
    const mat2 = Array.from({ length: n + 1 }, () => new Array(numClasses + 1).fill(0));

    for (let i = 1; i <= numClasses; i++) {
        mat1[1][i] = 1;
        mat2[1][i] = 0;
        for (let j = 2; j <= n; j++) mat2[j][i] = Infinity;
    }

    let v = 0;
    for (let l = 2; l <= n; l++) {
        let s1 = 0, s2 = 0, w = 0;
        for (let m = 1; m <= l; m++) {
            const i3 = l - m + 1;
            const val = data[i3 - 1];
            s2 += val * val;
            s1 += val;
            w++;
            v = s2 - (s1 * s1) / w;
            const i4 = i3 - 1;
            if (i4 !== 0) {
                for (let j = 2; j <= numClasses; j++) {
                    if (mat2[l][j] >= (v + mat2[i4][j - 1])) {
                        mat1[l][j] = i3;
                        mat2[l][j] = v + mat2[i4][j - 1];
                    }
                }
            }
        }
        mat1[l][1] = 1;
        mat2[l][1] = v;
    }

    const kclass = new Array(numClasses + 1);
    kclass[numClasses] = data[n - 1];
    kclass[0] = data[0];

    let k = n;
    for (let j = numClasses; j >= 2; j--) {
        const idx = mat1[k][j] - 2;
        kclass[j - 1] = data[idx];
        k = mat1[k][j] - 1;
    }

    return kclass.slice(1, numClasses);
}

// ─────────────────────────────────────────────────────────────────
// logarithmic — логарифмическая шкала (10, 100, 1000, …)
// ─────────────────────────────────────────────────────────────────

/**
 * Строит границы так, чтобы отношения соседних границ были равны.
 * Это классическая логарифмическая шкала: `[1, 10, 100, 1000]`.
 *
 * Если данные содержат нули или отрицательные значения, они
 * сдвигаются в положительную область сдвигом `shift`, а затем
 * сдвиг убирается обратно.
 */
function logarithmicBreaks(sorted: number[], numClasses: number): number[] {
    const min = sorted[0];
    const max = sorted[sorted.length - 1];

    // Сдвиг в положительную область (нули и минусы ломают log10)
    const shift = min <= 0 ? -min + 1 : 0;
    const logMin = Math.log10(min + shift);
    const logMax = Math.log10(max + shift);
    const step = (logMax - logMin) / numClasses;

    const breaks: number[] = [min];
    for (let i = 1; i < numClasses; i++) {
        const v = Math.pow(10, logMin + step * i) - shift;
        breaks.push(v);
    }
    breaks.push(max);
    return breaks;
}

// ─────────────────────────────────────────────────────────────────
// stddev — стандартное отклонение от среднего
// ─────────────────────────────────────────────────────────────────

/**
 * Границы на расстоянии долей стандартного отклонения от среднего.
 *
 * `numClasses = 2k+1` → симметрично вокруг среднего:
 *   `mean ± k·σ`.
 * `numClasses = 2k` → асимметрично: от `mean − k·σ` до `mean + (k−1)·σ`
 * (или наоборот, в зависимости от `numClasses`).
 *
 * Классы вне диапазона `[min, max]` не создаются — границы
 * обрезаются по фактическим min/max данных.
 */
function stdDevBreaks(sorted: number[], numClasses: number): number[] {
    const n = sorted.length;
    const min = sorted[0];
    const max = sorted[n - 1];

    const mean = sorted.reduce((s, v) => s + v, 0) / n;
    const variance = sorted.reduce((s, v) => s + (v - mean) ** 2, 0) / n;
    const sd = Math.sqrt(variance);
    if (sd === 0) return equalBreaks(min, max, numClasses);

    const raw: number[] = [min];
    const k = Math.floor(numClasses / 2);

    if (numClasses % 2 === 1) {
        // нечётное: симметрично mean ± k·σ
        for (let i = -k; i <= k; i++) {
            if (i === 0) continue;
            const v = mean + i * sd;
            if (v > min && v < max) raw.push(v);
        }
    } else {
        // чётное: mean − (k)·σ … mean + (k−1)·σ
        for (let i = -k; i <= k - 1; i++) {
            const v = mean + i * sd;
            if (v > min && v < max) raw.push(v);
        }
    }

    raw.push(max);
    raw.sort((a, b) => a - b);
    return dedupe(raw);
}

// ─────────────────────────────────────────────────────────────────
// geometric — геометрическая прогрессия
// ─────────────────────────────────────────────────────────────────

/**
 * Ширина классов растёт как геометрическая прогрессия:
 * `b_i = min · r^i`, где `r = (max/min)^(1/numClasses)`.
 *
 * Подходит для сильно скошенных распределений (плотность
 * населения, доходы), где мало больших значений и много малых[reference:2].
 *
 * Если данные содержат нули или отрицательные значения,
 * используется сдвиг в положительную область.
 */
function geometricBreaks(sorted: number[], numClasses: number): number[] {
    const min = sorted[0];
    const max = sorted[sorted.length - 1];

    const shift = min <= 0 ? -min + 1 : 0;
    const a = min + shift;
    const b = max + shift;
    if (a <= 0 || b <= 0) return equalBreaks(min, max, numClasses);

    const ratio = Math.pow(b / a, 1 / numClasses);
    const breaks: number[] = [min];
    for (let i = 1; i < numClasses; i++) {
        breaks.push(a * Math.pow(ratio, i) - shift);
    }
    breaks.push(max);
    return breaks;
}

// ─────────────────────────────────────────────────────────────────
// arithmetic — арифметическая прогрессия
// ─────────────────────────────────────────────────────────────────

/**
 * Ширина классов растёт (или убывает) как арифметическая прогрессия.
 *
 * Если `max > min`, ширины линейно возрастают от первого к последнему
 * классу; если `max < min` (не наш случай, но для полноты) — убывают.
 *
 * Параметр `numClasses` задаёт количество классов; разность
 * прогрессии `d` подбирается так, чтобы сумма ширин равнялась
 * `max − min`.
 */
function arithmeticBreaks(sorted: number[], numClasses: number): number[] {
    const min = sorted[0];
    const max = sorted[sorted.length - 1];
    const range = max - min;

    // Сумма ширин = numClasses * d + d * numClasses*(numClasses-1)/2
    // = d * numClasses * (numClasses + 1) / 2
    const d = (2 * range) / (numClasses * (numClasses + 1));

    const breaks: number[] = [min];
    let current = min;
    for (let i = 1; i < numClasses; i++) {
        current += d * i;
        breaks.push(current);
    }
    breaks.push(max);
    return breaks;
}

// ─────────────────────────────────────────────────────────────────
// headtail — head/tail breaks
// ─────────────────────────────────────────────────────────────────

/**
 * Итеративное разбиение данных с тяжёлым «хвостом».
 *
 * Алгоритм:
 *   1. Вычислить среднее.
 *   2. Разделить данные на «хвост» (≤ mean) и «голову» (> mean).
 *   3. Если «голова» содержит ≥ 40% (порог можно менять) — остановиться.
 *   4. Иначе повторить шаги 1–3 для «головы».
 *
 * Возвращает границы классов (от min до max). Количество классов
 * определяется автоматически и может быть меньше `numClasses`[reference:3].
 */
function headTailBreaks(sorted: number[], maxClasses: number): number[] {
    const breaks: number[] = [sorted[0]];
    let current = sorted.slice();

    while (current.length > 0 && breaks.length < maxClasses) {
        const mean = current.reduce((s, v) => s + v, 0) / current.length;
        const head = current.filter(v => v > mean);
        if (head.length === 0) break;

        // «Тяжёлый хвост»: голова маленькая относительно общего числа
        if (head.length / current.length < 0.4) {
            breaks.push(mean);
            current = head;
        } else {
            break;
        }
    }

    breaks.push(sorted[sorted.length - 1]);
    return dedupe(breaks);
}

// ─────────────────────────────────────────────────────────────────
// Утилиты
// ─────────────────────────────────────────────────────────────────

function dedupe(arr: number[]): number[] {
    const out: number[] = [];
    for (const v of arr) {
        if (out.length === 0 || v > out[out.length - 1]) out.push(v);
    }
    // Гарантируем, что последний элемент — max исходных данных
    return out;
}

// ─────────────────────────────────────────────────────────────────
// getClassIndex — без изменений
// ─────────────────────────────────────────────────────────────────

export function getClassIndex(v: number, breaks: number[]): number {
    if (breaks.length < 2) return 0;
    for (let i = 1; i < breaks.length; i++) {
        if (v <= breaks[i]) return i - 1;
    }
    return breaks.length - 2;
}

// ─────────────────────────────────────────────────────────────────
// Pretty breaks — без изменений
// ─────────────────────────────────────────────────────────────────

const NICE_SCALE = [1, 1.5, 2, 2.5, 3, 4, 5, 6, 7, 8, 10];

function snapToNice(v: number): number {
    if (v === 0) return 0;
    const sign = v < 0 ? -1 : 1;
    const abs = Math.abs(v);
    const magnitude = Math.pow(10, Math.floor(Math.log10(abs)));
    const normalized = abs / magnitude;

    let best = NICE_SCALE[0];
    let bestDist = Math.abs(normalized - best);
    for (let i = 1; i < NICE_SCALE.length; i++) {
        const d = Math.abs(normalized - NICE_SCALE[i]);
        if (d < bestDist) { best = NICE_SCALE[i]; bestDist = d; }
    }
    return sign * best * magnitude;
}

function nextNice(v: number): number {
    if (v === 0) return NICE_SCALE[0];
    const sign = v < 0 ? -1 : 1;
    const abs = Math.abs(v);
    const magnitude = Math.pow(10, Math.floor(Math.log10(abs)));
    const normalized = abs / magnitude;

    for (const n of NICE_SCALE) {
        if (n > normalized + 1e-9) return sign * n * magnitude;
    }
    return sign * NICE_SCALE[0] * magnitude * 10;
}

/**
 * Округляет внутренние границы классов до «красивых» чисел.
 *
 * - `breaks[0]` (min) и `breaks[last]` (max) не трогаются.
 * - При коллизии вторая граница сдвигается вперёд до следующего красивого.
 * - Если сдвиг выходит за `max`, используется исходное значение (raw).
 */
export function makeBreaksPretty(breaks: number[]): number[] {
    if (!Array.isArray(breaks) || breaks.length < 3) return breaks;

    const lastIdx = breaks.length - 1;
    const maxVal = breaks[lastIdx];
    const result: number[] = [breaks[0]];

    for (let i = 1; i < lastIdx; i++) {
        const prev = result[i - 1];
        let snapped = snapToNice(breaks[i]);

        if (snapped <= prev) snapped = nextNice(prev);

        if (snapped >= maxVal) {
            if (breaks[i] > prev && breaks[i] < maxVal) {
                snapped = breaks[i];
            } else {
                snapped = (prev + maxVal) / 2;
            }
        }

        result.push(snapped);
    }

    result.push(maxVal);
    return result;
}