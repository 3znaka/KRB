// Classification.ts
/**
 * Считает границы классов (breaks) для массива значений.
 * Возвращает массив порогов, например [10, 50, 100].
 * (Значения меньше 10 — класс 0, от 10 до 50 — класс 1 и т.д.)
 */
export function calculateBreaks(values, method, numClasses = 5) {
    if (Array.isArray(method))
        return method;
    const sorted = values.filter(v => typeof v === 'number' && isFinite(v)).sort((a, b) => a - b);
    if (sorted.length === 0)
        return [];
    const min = sorted[0];
    const max = sorted[sorted.length - 1];
    if (min === max)
        return [min, max]; // вырожденный случай
    if (method === 'equal') {
        const step = (max - min) / numClasses;
        const breaks = [min];
        for (let i = 1; i < numClasses; i++)
            breaks.push(min + step * i);
        breaks.push(max);
        return breaks;
    }
    if (method === 'quantile') {
        const breaks = [min];
        const n = sorted.length;
        for (let i = 1; i < numClasses; i++) {
            const pos = (n - 1) * (i / numClasses);
            const base = Math.floor(pos);
            const rest = pos - base;
            breaks.push(sorted[base + 1] !== undefined
                ? sorted[base] + rest * (sorted[base + 1] - sorted[base])
                : sorted[base]);
        }
        breaks.push(max);
        return breaks;
    }
    if (method === 'jenks') {
        const internal = jenksBreaks(sorted, numClasses); // без изменений, всё ещё n−1
        return [min, ...internal, max];
    }
    return [];
}
/**
 * Классический алгоритм Дженкса (Jenks Natural Breaks).
 * Оптимизирован для массивов до ~5000 элементов.
 */
function jenksBreaks(data, numClasses) {
    const n = data.length;
    const mat1 = Array.from({ length: n + 1 }, () => new Array(numClasses + 1).fill(0));
    const mat2 = Array.from({ length: n + 1 }, () => new Array(numClasses + 1).fill(0));
    for (let i = 1; i <= numClasses; i++) {
        mat1[1][i] = 1;
        mat2[1][i] = 0;
        for (let j = 2; j <= n; j++)
            mat2[j][i] = Infinity;
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
    // Возвращаем внутренние границы (без 0-го и последнего элемента)
    return kclass.slice(1, numClasses);
}
/**
 * Возвращает индекс класса (от 0 до breaks.length) для значения v.
 */
export function getClassIndex(v, breaks) {
    if (breaks.length < 2)
        return 0;
    for (let i = 1; i < breaks.length; i++) {
        if (v <= breaks[i])
            return i - 1;
    }
    return breaks.length - 2; // верхний класс (v > max)
}
