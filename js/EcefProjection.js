// EcefProjection.ts
import { FormulaProjection } from './Projections.js';
import { ELLIPSOIDS } from './Ellipsoid.js';
/**
 * Единственный источник истины: ECEF определяется PROJ-строкой (+proj=geocent),
 * а не захардкоженным списком кодов.
 */
export function isGeocentricDef(def) {
    return typeof def === 'string' && /\+proj=geocent\b/.test(def);
}
/**
 * Создает 2D-проекцию для ECEF-координат.
 * Архитектурное решение: мы проецируем 3D-глобус на 2D-плоскость карты,
 * отбрасывая ось X (вид "спереди", со стороны нулевого меридиана).
 * Карта X = ECEF Y
 * Карта Y = ECEF Z
 * Обратное преобразование корректно работает для видимой половины глобуса (X >= 0).
 */
export function createEcefProjection(code, ellipsoid = ELLIPSOIDS.wgs84) {
    const a = ellipsoid.a;
    const e2 = ellipsoid.e2;
    const formula = [
        // 0: x(lat, lon) -> Возвращаем ECEF Y как горизонтальную координату карты
        (latDeg, lonDeg) => {
            const lat = latDeg * Math.PI / 180;
            const lon = lonDeg * Math.PI / 180;
            const sinLat = Math.sin(lat);
            const N = a / Math.sqrt(1 - e2 * sinLat * sinLat);
            return N * Math.cos(lat) * Math.sin(lon);
        },
        // 1: y(lat, lon) -> Возвращаем ECEF Z как вертикальную координату карты
        (latDeg, lonDeg) => {
            const lat = latDeg * Math.PI / 180;
            const sinLat = Math.sin(lat);
            const N = a / Math.sqrt(1 - e2 * sinLat * sinLat);
            return (N * (1 - e2)) * sinLat;
        },
        // 2: lat(x, y) <- Обратное преобразование широты
        (x, y) => {
            // x = Y_ecef, y = Z_ecef. Решаем относительно lat, предполагая h=0 (поверхность).
            let lat = Math.asin(y / a); // Сферическое начальное приближение
            for (let i = 0; i < 5; i++) {
                const sinLat = Math.sin(lat);
                const N = a / Math.sqrt(1 - e2 * sinLat * sinLat);
                const denom = N * (1 - e2);
                if (denom === 0)
                    break;
                lat = Math.asin(Math.max(-1, Math.min(1, y / denom)));
            }
            return lat * 180 / Math.PI;
        },
        // 3: lon(x, y) <- Обратное преобразование долготы
        (x, y) => {
            // Сначала находим lat, так как он нужен для знаменателя
            let lat = Math.asin(y / a);
            for (let i = 0; i < 5; i++) {
                const sinLat = Math.sin(lat);
                const N = a / Math.sqrt(1 - e2 * sinLat * sinLat);
                const denom = N * (1 - e2);
                if (denom === 0)
                    break;
                lat = Math.asin(Math.max(-1, Math.min(1, y / denom)));
            }
            const sinLatFinal = Math.sin(lat);
            const cosLat = Math.cos(lat);
            const N_final = a / Math.sqrt(1 - e2 * sinLatFinal * sinLatFinal);
            const denom = N_final * cosLat;
            if (denom < 1e-6)
                return 0; // На полюсах долгота не определена
            // Ограничиваем [-1, 1] для защиты от ошибок плавающей точки
            const sinLon = Math.max(-1, Math.min(1, x / denom));
            // Math.asin возвращает значения от -90 до 90 градусов.
            // Это математически означает, что мы видим только "переднюю" половину глобуса (где X_ecef >= 0).
            // Это именно то "перспективное отображение половинки глобуса", которое вы просили.
            return Math.asin(sinLon) * 180 / Math.PI;
        }
    ];
    return new FormulaProjection(formula, {
        code,
        ellipsoid,
        isGeographic: false,
        isGeocentric: true,
        maxAbsCoord: a * 1.1,
        halfExtentX: a,
        halfExtentY: a,
    });
}
