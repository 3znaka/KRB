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
export const DEFAULT_GLOBE_INERTIA = {
    halfLifeMs: 220,
    minSpeedPxS: 60,
    maxSpeedPxS: 6000,
    stopSpeedPxS: 4,
};
export class GlobeInertia {
    _opts;
    _buf = [];
    _vx = 0;
    _vy = 0;
    /** Время последнего шага инерции (мс), чтобы считать dt из реального времени. */
    _lastStepTime = 0;
    constructor(_opts = DEFAULT_GLOBE_INERTIA) {
        this._opts = _opts;
    }
    /** Запись пиксельного смещения жеста (вызывается на каждом кадре drag). */
    record(dx, dy, now) {
        this._drain(now);
        this._buf.push({ time: now, dx, dy });
    }
    /** Жест прерван без инерции (курсор ушёл с диска, сброс и т.п.). */
    clear() {
        this._buf.length = 0;
        this._vx = 0;
        this._vy = 0;
    }
    /**
     * Вызывается при отпускании. Измеряет скорость по окну перед отпусканием
     * и запускает затухание, если она выше minSpeed.
     */
    start(now) {
        this._drain(now);
        const entries = this._velocityEntries(now);
        this._buf.length = 0;
        if (entries.length < 2) {
            this._vx = 0;
            this._vy = 0;
            return;
        }
        // Смещение накоплено ДО записи каждого сэмпла, поэтому первый сэмпл лишь
        // задаёт начало интервала (как в MapLibre HandlerInertia._onMoveEnd).
        let sx = 0, sy = 0;
        for (let i = 1; i < entries.length; i++) {
            sx += entries[i].dx;
            sy += entries[i].dy;
        }
        const dtMs = Math.max(now - entries[0].time, 1);
        const dtS = dtMs / 1000;
        let vx = sx / dtS, vy = sy / dtS;
        const speed = Math.hypot(vx, vy);
        const { minSpeedPxS, maxSpeedPxS, stopSpeedPxS } = this._opts;
        if (speed < minSpeedPxS) {
            this._vx = 0;
            this._vy = 0;
            return;
        }
        // Плавное ограничение: v' = vmax·tanh(v / vmax). Направление сохраняется,
        // сильный бросок ограничивается мягко, без излома на пороге.
        const soft = maxSpeedPxS * Math.tanh(speed / maxSpeedPxS);
        const f = soft / speed;
        vx *= f;
        vy *= f;
        if (Math.hypot(vx, vy) < stopSpeedPxS) {
            this._vx = 0;
            this._vy = 0;
            return;
        }
        this._vx = vx;
        this._vy = vy;
        this._lastStepTime = now;
    }
    /**
     * Шаг инерции на кадре. Возвращает пиксельное смещение за прошедшее время
     * либо null, если инерция не активна. Скорость затухает экспоненциально:
     * за halfLife скорость уменьшается вдвое.
     */
    step(now) {
        if (this._vx === 0 && this._vy === 0)
            return null;
        const dtMs = Math.max(0, now - this._lastStepTime);
        this._lastStepTime = now;
        if (dtMs === 0)
            return { dx: 0, dy: 0 };
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
            this._vx = 0;
            this._vy = 0;
            return null;
        }
        return { dx, dy };
    }
    /** Активна ли инерция. */
    isActive() {
        return this._vx !== 0 || this._vy !== 0;
    }
    _drain(now) {
        const b = this._buf;
        while (b.length > 0 && now - b[0].time > BUFFER_CUTOFF_MS)
            b.shift();
    }
    /** Записи, по которым измеряется скорость: окно VELOCITY_WINDOW, но не меньше двух. */
    _velocityEntries(now) {
        const b = this._buf;
        const windowStart = now - VELOCITY_WINDOW_MS;
        let first = Math.max(0, b.length - 2);
        while (first > 0 && b[first - 1].time >= windowStart)
            first--;
        return b.slice(first);
    }
}
