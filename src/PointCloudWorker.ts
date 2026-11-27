/**
 * PointCloudWorker — точный подсчёт точек облака внутри фрустума в воркере.
 *
 * Тяжёлый O(n) проход по всем точкам выносится из основного потока, чтобы
 * не вызывать подвисания кадра. Позиции передаются воркеру один раз (Float32Array,
 * без массивов кортежей); каждый запрос — только 6 плоскостей фрустума (24 числа).
 *
 * Воркер вшивается строкой и создаётся через Blob — как simplifyWorker.ts,
 * поэтому не требует отдельного файла в бандле.
 *
 * @module PointCloudWorker
 */

const POINT_COUNT_WORKER_SOURCE = `
let xs = null, ys = null, zs = null, n = 0;
self.onmessage = function (ev) {
    const m = ev.data;
    if (m.type === 'set') {
        // Позиции в мировых координатах уже с учётом origin и высоты.
        xs = m.xs; ys = m.ys; zs = m.zs; n = xs.length;
        return;
    }
    if (m.type === 'count') {
        // 6 плоскостей фрустума: (nx, ny, nz, d) каждая, уравнение n·p + d >= 0 — внутри.
        const P = m.planes;
        let count = 0;
        for (let i = 0; i < n; i++) {
            const x = xs[i], y = ys[i], z = zs[i];
            let inside = true;
            for (let k = 0; k < 24; k += 4) {
                if (P[k] * x + P[k + 1] * y + P[k + 2] * z + P[k + 3] < 0) { inside = false; break; }
            }
            if (inside) count++;
        }
        self.postMessage({ type: 'count', id: m.id, count });
    }
};
`;

export interface PointCountWorker {
    /** Передаёт позиции точек (мировые координаты). Вызывается один раз / при смене данных. */
    setPoints(xs: Float32Array, ys: Float32Array, zs: Float32Array): void;
    /** Считает точки внутри фрустума. planes — 24 числа (6 плоскостей × nx,ny,nz,d). */
    count(planes: Float32Array): Promise<number>;
    dispose(): void;
}

/** Создаёт воркер подсчёта. Возвращает null, если воркеры недоступны. */
export function createPointCountWorker(): PointCountWorker | null {
    if (typeof Worker === 'undefined' || typeof Blob === 'undefined' || typeof URL === 'undefined') return null;
    let worker: Worker;
    try {
        const blob = new Blob([POINT_COUNT_WORKER_SOURCE], { type: 'application/javascript' });
        worker = new Worker(URL.createObjectURL(blob));
    } catch {
        return null;
    }

    let nextId = 1;
    const pending = new Map<number, (n: number) => void>();
    worker.onmessage = (ev: MessageEvent) => {
        const m = ev.data;
        if (m.type !== 'count') return;
        const resolve = pending.get(m.id);
        if (resolve) {
            pending.delete(m.id);
            resolve(m.count);
        }
    };

    return {
        setPoints(xs, ys, zs) {
            // Копируем: исходные буферы остаются у владельца, воркер получает свои.
            worker.postMessage({ type: 'set', xs: xs.slice(), ys: ys.slice(), zs: zs.slice() });
        },
        count(planes) {
            const id = nextId++;
            return new Promise<number>((resolve) => {
                pending.set(id, resolve);
                worker.postMessage({ type: 'count', id, planes: planes.slice() });
            });
        },
        dispose() {
            pending.clear();
            worker.terminate();
        },
    };
}
