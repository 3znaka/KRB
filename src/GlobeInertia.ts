// GlobeInertia.ts
//
// Инерция вращения глобуса по образцу MapLibre (src/ui/handler_inertia.ts):
//  - скорость измеряется по коротком окну перед отпусканием, а не EMA по кадрам;
//  - затухание экспоненциальное с периодом полураспада (friction), поэтому
//    скорость жеста не влияет на форму затухания (нет «резкого» угасания);
//  - бросок ниже minSpeed не даёт инерции, ниже stopSpeed — останавливаем.
//
// Скорости — в пикселях в секунду. Класс не знает о камере: он выдаёт
// пиксельный шаг на кадр, который применяет вызывающий код (_globeOrbit).

/** Максимальный возраст записи жеста (мс): старше — отбрасываем. */
const BUFFER_CUTOFF_MS = 160;
/** Окно, по которому измеряется скорость в момент отпускания (мс). */
const VELOCITY_WINDOW_MS = 60;

/** Параметры затухания — те же, что у MapLibre bearingFrictionOptions, по смыслу. */
export interface GlobeInertiaOptions {
    /** Период полураспада скорости (мс). */
    halfLifeMs: number;
    /** Ниже этой скорости (px/с) бросок не запускает инерцию. */
    minSpeedPxS: number;
    /** Верхний предел скорости (px/с). */
    maxSpeedPxS: number;
    /** Ниже этой скорости (px/с) инерция останавливается. */
    stopSpeedPxS: number;
}

export const DEFAULT_GLOBE_INERTIA: GlobeInertiaOptions = {
    halfLifeMs: 220,
    minSpeedPxS: 60,
    maxSpeedPxS: 6000,
    stopSpeedPxS: 4,
};

interface Sample {
    time: number;
    dx: number;
    dy: number;
}

export class GlobeInertia {
    private _buf: Sample[] = [];
    private _vx = 0;
    private _vy = 0;
    /** Время последнего шага инерции (мс), чтобы считать dt из реального времени. */
    private _lastStepTime = 0;

    constructor(private readonly _opts: GlobeInertiaOptions = DEFAULT_GLOBE_INERTIA) {}

    /** Запись пиксельного смещения жеста (вызывается на каждом кадре drag). */
    record(dx: number, dy: number, now: number): void {
        this._drain(now);
        this._buf.push({ time: now, dx, dy });
    }

    /** Жест прерван без инерции (курсор ушёл с диска, сброс и т.п.). */
    clear(): void {
        this._buf.length = 0;
        this._vx = 0;
        this._vy = 0;
    }

    /**
     * Вызывается при отпускании. Измеряет скорость по окну перед отпусканием
     * и запускает затухание, если она выше minSpeed.
     */
    start(now: number): void {
        this._drain(now);
        const entries = this._velocityEntries(now);
        this._buf.length = 0;
        if (entries.length < 2) { this._vx = 0; this._vy = 0; return; }

        // Смещение накоплено ДО записи каждого сэмпла, поэтому первый сэмпл лишь
        // задаёт начало интервала (как в MapLibre HandlerInertia._onMoveEnd).
        let sx = 0, sy = 0;
        for (let i = 1; i < entries.length; i++) { sx += entries[i].dx; sy += entries[i].dy; }
        const dtMs = Math.max(now - entries[0].time, 1);
        const dtS = dtMs / 1000;
        let vx = sx / dtS, vy = sy / dtS;

        const speed = Math.hypot(vx, vy);
        const { minSpeedPxS, maxSpeedPxS, stopSpeedPxS } = this._opts;
        if (speed < minSpeedPxS) { this._vx = 0; this._vy = 0; return; }
        // Плавное ограничение: v' = vmax·tanh(v / vmax). Направление сохраняется,
        // сильный бросок ограничивается мягко, без излома на пороге.
        const soft = maxSpeedPxS * Math.tanh(speed / maxSpeedPxS);
        const f = soft / speed;
        vx *= f; vy *= f;
        if (Math.hypot(vx, vy) < stopSpeedPxS) { this._vx = 0; this._vy = 0; return; }

        this._vx = vx;
        this._vy = vy;
        this._lastStepTime = now;
    }

    /**
     * Шаг инерции на кадре. Возвращает пиксельное смещение за прошедшее время
     * либо null, если инерция не активна. Скорость затухает экспоненциально:
     * за halfLife скорость уменьшается вдвое.
     */
    step(now: number): { dx: number; dy: number } | null {
        if (this._vx === 0 && this._vy === 0) return null;
        const dtMs = Math.max(0, now - this._lastStepTime);
        this._lastStepTime = now;
        if (dtMs === 0) return { dx: 0, dy: 0 };

        // Экспоненциальное затухание: v(t) = v0 · 2^(-t/T). Смещение за отрезок dt —
        // точный интеграл экспоненты: v0 · T/ln2 · (1 - 2^(-dt/T)).
        const T = this._opts.halfLifeMs;
        const k = Math.pow(2, -dtMs / T);
        const travelS = (T / 1000) / Math.LN2 * (1 - k);
        const dx = this._vx * travelS;
        const dy = this._vy * travelS;

        this._vx *= k;
        this._vy *= k;

        if (Math.hypot(this._vx, this._vy) < this._opts.stopSpeedPxS) {
            this._vx = 0; this._vy = 0;
            return null;
        }
        return { dx, dy };
    }

    /** Активна ли инерция. */
    isActive(): boolean {
        return this._vx !== 0 || this._vy !== 0;
    }

    private _drain(now: number): void {
        const b = this._buf;
        while (b.length > 0 && now - b[0].time > BUFFER_CUTOFF_MS) b.shift();
    }

    /** Записи, по которым измеряется скорость: окно VELOCITY_WINDOW, но не меньше двух. */
    private _velocityEntries(now: number): Sample[] {
        const b = this._buf;
        const windowStart = now - VELOCITY_WINDOW_MS;
        let first = Math.max(0, b.length - 2);
        while (first > 0 && b[first - 1].time >= windowStart) first--;
        return b.slice(first);
    }
}
