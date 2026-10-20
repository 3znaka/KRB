// mulberry32 — маленький seeded-PRNG
function mulberry32(a) {
    return function () {
        a |= 0; a = a + 0x6D2B79F5 | 0;
        let t = Math.imul(a ^ a >>> 15, 1 | a);
        t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
        return ((t ^ t >>> 14) >>> 0) / 4294967296;
    };
}

class Perlin2D {
    constructor(seed) {
        const rand = mulberry32(seed);
        const p = new Uint8Array(256);
        for (let i = 0; i < 256; i++) p[i] = i;
        for (let i = 255; i > 0; i--) {
            const j = Math.floor(rand() * (i + 1));
            const tmp = p[i]; p[i] = p[j]; p[j] = tmp;
        }
        this.perm = new Uint8Array(512);
        for (let i = 0; i < 512; i++) this.perm[i] = p[i & 255];
    }
    _fade(t) { return t * t * t * (t * (t * 6 - 15) + 10); }
    _lerp(a, b, t) { return a + (b - a) * t; }
    _grad(h, x, y) {
        const hh = h & 7;
        const u = hh < 4 ? x : y;
        const v = hh < 4 ? y : x;
        return ((hh & 1) ? -u : u) + ((hh & 2) ? -2 * v : 2 * v);
    }
    noise(x, y) {
        const X = Math.floor(x) & 255;
        const Y = Math.floor(y) & 255;
        x -= Math.floor(x);
        y -= Math.floor(y);
        const u = this._fade(x), v = this._fade(y);
        const p = this.perm;
        const aa = p[p[X] + Y],     ab = p[p[X] + Y + 1];
        const ba = p[p[X + 1] + Y], bb = p[p[X + 1] + Y + 1];
        return this._lerp(
            this._lerp(this._grad(aa, x, y),     this._grad(ba, x - 1, y),     u),
            this._lerp(this._grad(ab, x, y - 1), this._grad(bb, x - 1, y - 1), u),
            v
        );
    }
}

/**
 * Процедурный источник высот: fBm-Перлин по (lon, lat).
 * Детерминирован по seed — одни и те же (z,x,y) → одни и те же высоты.
 * Возвращает метры, сразу в world-масштабе Y.
 */
export class NoiseElevationProvider {
     constructor({
        seed = 42,
        amplitude = 10000,       // ← было 5000
        octaves = 6,             // ← было 5
        baseFrequency = 6,       // ← было 1/30
        lacunarity = 2.0,
        persistence = 0.5,
        heightScale = 1,         // ← НОВОЕ: множитель амплитуды
    } = {}) {
        this.seed = seed >>> 0;
        this.heightScale = heightScale;
        // ВАЖНО: this.amplitude теперь хранит УЖЕ отмасштабированный пик.
        // Core.js читает его для MIN_CAMERA_HEIGHT_OFFSET — это правильно.
        this.amplitude = amplitude * heightScale;
        this.octaves = octaves;
        this.baseFrequency = baseFrequency;
        this.lacunarity = lacunarity;
        this.persistence = persistence;
        this._perlin = new Perlin2D(this.seed);

        let norm = 0, a = 1;
        for (let o = 0; o < octaves; o++) { norm += a; a *= persistence; }
        this._norm = norm || 1;
    }

    isElevationProvider() { return true; }

    /**
     * ВАЖНО: порядок и размерность совпадают с тем, что делает воркер
     * в computeHeightsGeneric (row-major, row=0 → север, col=0 → запад).
     * @returns {Float32Array} длина (segments+1)^2
     */
    getTileHeights(z, virtX, y, segments) {
        const n = 1 << z;
        const grid = segments + 1;
        const out = new Float32Array(grid * grid);

        // lat зависит только от строки — кэшируем, чтобы не крутить atan/sinh grid² раз
        const latRow = new Float64Array(grid);
        for (let row = 0; row < grid; row++) {
            const ty = y + row / segments;
            latRow[row] = Math.atan(Math.sinh(Math.PI * (1 - 2 * ty / n))) * 180 / Math.PI;
        }

        for (let row = 0; row < grid; row++) {
            const lat = latRow[row];
            for (let col = 0; col < grid; col++) {
                const lon = ((virtX + col / segments) / n) * 360 - 180;
                out[row * grid + col] = this._heightAt(lon, lat);
            }
        }
        return out;
    }

    _heightAt(lon, lat) {
        const x = lon * this.baseFrequency;
        const y = lat * this.baseFrequency;
        let h = 0, amp = 1, freq = 1;
        for (let o = 0; o < this.octaves; o++) {
            h += this._perlin.noise(x * freq, y * freq) * amp;
            freq *= this.lacunarity;
            amp *= this.persistence;
        }
        h /= this._norm;          // ≈ [-1, 1]
        h = (h + 1) * 0.5;        // [0, 1] — «суша без моря»
        return h * this.amplitude;
    }
}