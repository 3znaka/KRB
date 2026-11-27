/**
 * PointCloudLOD — прореживание облака точек по числу точек на экране.
 *
 * Точки раскладываются по сетке ячеек. Внутри каждой ячейки порядок
 * случайный (перестановка при построении), поэтому префикс ячейки — это
 * случайная подвыборка её точек. Уровень L ячейки = префикс `ceil(n / 2^L)`.
 *
 * На каждом кадре `update(frustum)`:
 *   1. ячейки вне фрустума камеры отбрасываются (проверка AABB ячейки
 *      через THREE.Frustum — учитывает любой поворот и наклон камеры);
 *   2. видимые ячейки получают полную детализацию, пока суммарное число
 *      точек не превысит `budget`; когда бюджет исчерпан, оставшимся
 *      видимым ячейкам назначается уровень, при котором их точек хватает
 *      на оставшийся бюджет.
 *
 * Приоритета по расстоянию нет: все видимые ячейки обрабатываются одинаково.
 *
 * @module PointCloudLOD
 */

export interface PointCloudLODOptions {
    /** Число ячеек по каждой оси сетки. */
    grid?: number;
    /** Макс. число точек, которые рисуются за кадр. */
    budget?: number;
    /** Макс. уровень детализации (ячейка не дробится сильнее 2^maxLevel). */
    maxLevel?: number;
    /** Сид для случайной перестановки (для воспроизводимости). */
    seed?: number;
}

export interface LODCell {
    /** Смещение ячейки в общем порядке точек. */
    start: number;
    /** Число точек в ячейке. */
    count: number;
    /** AABB ячейки в плоских координатах относительно origin облака. */
    minX: number;
    maxX: number;
    minZ: number;
    maxZ: number;
    /** Текущий уровень детализации. */
    level: number;
}

const DEFAULTS = { grid: 64, budget: 3_000_000, maxLevel: 12, seed: 1 };

/** Простой детерминированный генератор (mulberry32) — для воспроизводимой перестановки. */
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

export class PointCloudLOD {
    /** order[k] — исходный индекс k-й точки после перестановки внутри ячеек. */
    readonly order: Uint32Array;
    readonly cells: LODCell[];

    private readonly _budget: number;
    private readonly _maxLevel: number;
    private _appliedKey = '';

    constructor(xs: Float32Array, zs: Float32Array, options: PointCloudLODOptions = {}) {
        const g = Math.max(1, options.grid ?? DEFAULTS.grid);
        this._budget = options.budget ?? DEFAULTS.budget;
        this._maxLevel = options.maxLevel ?? DEFAULTS.maxLevel;
        const rng = makeRng(options.seed ?? DEFAULTS.seed);

        const n = xs.length;
        let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
        for (let i = 0; i < n; i++) {
            const x = xs[i], z = zs[i];
            if (x < minX) minX = x; if (x > maxX) maxX = x;
            if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;
        }
        const spanX = Math.max(maxX - minX, 1e-9);
        const spanZ = Math.max(maxZ - minZ, 1e-9);
        const cellW = spanX / g, cellH = spanZ / g;

        // Counting sort по ячейкам.
        const cellOf = new Uint32Array(n);
        const counts = new Uint32Array(g * g);
        for (let i = 0; i < n; i++) {
            const cx = Math.min(g - 1, Math.floor(((xs[i] - minX) / spanX) * g));
            const cz = Math.min(g - 1, Math.floor(((zs[i] - minZ) / spanZ) * g));
            const c = cz * g + cx;
            cellOf[i] = c;
            counts[c]++;
        }
        const starts = new Uint32Array(g * g + 1);
        for (let c = 0; c < g * g; c++) starts[c + 1] = starts[c] + counts[c];

        this.order = new Uint32Array(n);
        const fill = starts.slice(0, g * g);
        for (let i = 0; i < n; i++) this.order[fill[cellOf[i]]++] = i;

        // Случайная перестановка внутри каждой ячейки (Fisher–Yates):
        // тогда любой префикс — случайная подвыборка ячейки.
        for (let c = 0; c < g * g; c++) {
            const s = starts[c], m = counts[c];
            for (let k = m - 1; k > 0; k--) {
                const j = Math.floor(rng() * (k + 1));
                const t = this.order[s + k];
                this.order[s + k] = this.order[s + j];
                this.order[s + j] = t;
            }
        }

        this.cells = [];
        for (let c = 0; c < g * g; c++) {
            if (counts[c] === 0) continue;
            const cx = c % g, cz = Math.floor(c / g);
            this.cells.push({
                start: starts[c],
                count: counts[c],
                minX: minX + cx * cellW,
                maxX: minX + (cx + 1) * cellW,
                minZ: minZ + cz * cellH,
                maxZ: minZ + (cz + 1) * cellH,
                level: 0,
            });
        }
    }

    /**
     * Пересчитывает уровни. `isCellVisible(minX, maxX, minZ, maxZ)` — проверка
     * AABB ячейки относительно фрустума (ячейки в плоскости, y = 0 относительно origin).
     * Возвращает true, если уровни изменились.
     */
    update(isCellVisible: (minX: number, maxX: number, minZ: number, maxZ: number) => boolean): boolean {
        // 1. Видимость каждой ячейки и суммарное число её точек на полной детализации.
        if (this._vis.length !== this.cells.length) this._vis = new Uint8Array(this.cells.length);
        let fullTotal = 0;
        for (let i = 0; i < this.cells.length; i++) {
            const c = this.cells[i];
            const v = isCellVisible(c.minX, c.maxX, c.minZ, c.maxZ) ? 1 : 0;
            this._vis[i] = v;
            if (v) fullTotal += c.count;
        }

        this._lastFullVisible = fullTotal;

        // 2. Единый уровень для видимых ячеек: подбираем минимальный, при котором
        // точек в видимых ячейках не больше бюджета.
        let target = 0;
        if (fullTotal > this._budget) {
            target = Math.min(this._maxLevel, Math.ceil(Math.log2(fullTotal / this._budget)));
        }

        // 3. Уровни. Невидимые ячейки в индекс не попадают вообще: их маркируем
        // отдельным флагом, а _countAt для них даёт 0 (см. buildIndex).
        let changed = false;
        for (let i = 0; i < this.cells.length; i++) {
            const c = this.cells[i];
            const lvl = this._vis[i] ? target : -1;   // -1 = не рисовать
            if (c.level !== lvl) {
                c.level = lvl;
                changed = true;
            }
        }
        this._drawnTotal = this._sumDrawn();
        return changed;
    }

    private _drawnTotal = 0;

    /** Точек, которые попадут в индекс на текущих уровнях (только видимые ячейки). */
    private _sumDrawn(): number {
        let total = 0;
        for (const c of this.cells) {
            if (c.level >= 0) total += this._countAt(c.count, c.level);
        }
        return total;
    }

    /** Точек, реально идущих в индекс (после прореживания и отбрасывания невидимых). */
    getDrawnTotal(): number { return this._drawnTotal; }

    private _vis: Uint8Array = new Uint8Array(0);
    private _indexBuf: Uint32Array | null = null;
    private _lastFullVisible = 0;

    /** Точек в видимых ячейках на полной детализации (до прореживания). */
    getVisibleTotal(): number { return this._lastFullVisible; }



    /** Число точек в ячейке на уровне `level`. */
    private _countAt(count: number, level: number): number {
        if (level < 0) return 0;   // ячейка вне экрана — не рисуем
        const m = Math.ceil(count / Math.pow(2, level));
        return Math.max(1, Math.min(count, m));
    }

    /** Строит индекс-буфер из текущих уровней. */
    buildIndex(): Uint32Array {
        let total = 0;
        for (const cell of this.cells) total += this._countAt(cell.count, cell.level);
        // Переиспользуем буфер, если хватает ёмкости (без аллокации каждый кадр).
        if (!this._indexBuf || this._indexBuf.length < total) {
            this._indexBuf = new Uint32Array(Math.ceil(total * 1.25));
        }
        const out = this._indexBuf.subarray(0, total);
        let k = 0;
        for (const cell of this.cells) {
            const m = this._countAt(cell.count, cell.level);
            for (let j = 0; j < m; j++) out[k++] = this.order[cell.start + j];
        }
        return out;
    }

    /** Ключ текущих уровней — чтобы не пересобирать индекс без нужды. */
    levelKey(): string {
        let h = 0;
        for (let i = 0; i < this.cells.length; i++) h = (h * 31 + this.cells[i].level + 1) | 0;
        return String(h);
    }

    /** Отмечает текущие уровни как применённые. */
    commit(): void {
        this._appliedKey = this.levelKey();
    }

    isDirty(): boolean {
        return this.levelKey() !== this._appliedKey;
    }
}
