// Ellipsoid.ts
// @ts-nocheck

/**
 * Параметры эллипсоида в том виде, в котором они хранятся в таблице.
 * Достаточно задать `a` и один из параметров формы: `b`, `f`, `rf` или `e2`.
 * Если не задан ни один — эллипсоид считается сферой (b = a).
 */
export interface EllipsoidDef {
    /** Большая полуось (экваториальный радиус), метры. */
    a: number;
    /** Малая полуось (полярный радиус), метры. */
    b?: number;
    /** Сжатие: f = (a - b) / a. */
    f?: number;
    /** Обратное сжатие: rf = 1 / f. */
    rf?: number;
    /** Квадрат первого эксцентриситета: e² = 2f - f². */
    e2?: number;
    /** Человекочитаемое название (для отладки / документации). */
    name?: string;
}

/**
 * Полный, неизменяемый эллипсоид.
 *
 * Все производные величины (`b`, `f`, `rf`, `e`, `e2`, радиусы) вычисляются
 * один раз в конструкторе и замораживаются. Это гарантирует, что при
 * использовании в горячих путях (проекции, ECEF, площади) не тратится
 * время на повторные вычисления и исключены случайные мутации.
 */
export class Ellipsoid {
    /** Большая полуось, м. */
    readonly a: number;
    /** Малая полуось, м. */
    readonly b: number;
    /** Сжатие: (a - b) / a. */
    readonly f: number;
    /** Обратное сжатие: 1 / f (Infinity для сферы). */
    readonly rf: number;
    /** Первый эксцентриситет: sqrt(e²). */
    readonly e: number;
    /** Квадрат первого эксцентриситета: 2f - f². */
    readonly e2: number;
    /** Человекочитаемое название. */
    readonly name?: string;

    /**
     * @param def — объект с `a` и одним из `b` / `f` / `rf` / `e2`.
     *              Если параметр формы не задан, эллипсоид считается сферой.
     */
    constructor(def: EllipsoidDef) {
        const a = def.a;
        if (!Number.isFinite(a) || a <= 0) {
            throw new Error(`Ellipsoid: некорректная большая полуось a=${def.a}`);
        }

        let b: number;
        let f: number;
        let rf: number;
        let e2: number;

        if (def.b != null) {
            b = def.b;
            if (!Number.isFinite(b) || b <= 0 || b > a) {
                throw new Error(`Ellipsoid: некорректная малая полуось b=${def.b} (a=${a})`);
            }
            f = (a - b) / a;
            rf = f === 0 ? Infinity : 1 / f;
            e2 = 2 * f - f * f;
        } else if (def.f != null) {
            f = def.f;
            if (!Number.isFinite(f) || f < 0 || f >= 1) {
                throw new Error(`Ellipsoid: некорректное сжатие f=${def.f}`);
            }
            b = a * (1 - f);
            rf = f === 0 ? Infinity : 1 / f;
            e2 = 2 * f - f * f;
        } else if (def.rf != null) {
            rf = def.rf;
            if (!Number.isFinite(rf) || rf <= 0) {
                throw new Error(`Ellipsoid: некорректное обратное сжатие rf=${def.rf}`);
            }
            f = 1 / rf;
            b = a * (1 - f);
            e2 = 2 * f - f * f;
        } else if (def.e2 != null) {
            e2 = def.e2;
            if (!Number.isFinite(e2) || e2 < 0 || e2 >= 1) {
                throw new Error(`Ellipsoid: некорректный e²=${def.e2}`);
            }
            f = 1 - Math.sqrt(1 - e2);
            b = a * (1 - f);
            rf = f === 0 ? Infinity : 1 / f;
        } else {
            // Сфера
            b = a;
            f = 0;
            rf = Infinity;
            e2 = 0;
        }

        this.a = a;
        this.b = b;
        this.f = f;
        this.rf = rf;
        this.e2 = e2;
        this.e = Math.sqrt(e2);
        this.name = def.name;

        Object.freeze(this);
    }

    /** Является ли эллипсоид сферой (a === b). */
    get isSphere(): boolean {
        return this.a === this.b;
    }

    /**
     * Средний радиус (2a + b) / 3.
     * Используется для камеры, дистанций и калибровки BASE_DISTANCE.
     */
    get meanRadius(): number {
        return (2 * this.a + this.b) / 3;
    }

    /**
     * Авталический радиус — радиус сферы той же площади поверхности.
     * Используется для расчёта площадей.
     */
    get authalicRadius(): number {
        if (this.isSphere) return this.a;
        const e = this.e;
        // q_p = 1 + (1 - e²)/e * atanh(e)  (эквивалентно ln((1+e)/(1-e))/2)
        const qp = 1 + ((1 - e2Safe(this.e2)) / e) * Math.atanh(e);
        return this.a * Math.sqrt(qp / 2);
    }

    /**
     * Объёмный радиус — радиус сферы того же объёма: (a²b)^(1/3).
     */
    get volumeRadius(): number {
        return Math.cbrt(this.a * this.a * this.b);
    }

    /**
     * Длина дуги меридиана между двумя широтами (в радианах).
     * Численная квадратура (формула Симпсона) — достаточная точность
     * для визуализации и не требует разложения в ряд.
     */
    meridianArc(lat1Rad: number, lat2Rad: number): number {
        const n = 16;
        const h = (lat2Rad - lat1Rad) / n;
        let sum = 0;
        for (let i = 0; i <= n; i++) {
            const lat = lat1Rad + i * h;
            const w = i === 0 || i === n ? 1 : i % 2 === 0 ? 2 : 4;
            sum += w * this._meridianRadius(lat);
        }
        return (h / 3) * sum;
    }

    /** Радиус кривизны меридиана в точке lat (рад). @private */
    _meridianRadius(latRad: number): number {
        const s = Math.sin(latRad);
        const denom = Math.pow(1 - this.e2 * s * s, 1.5);
        return (this.a * (1 - this.e2)) / denom;
    }
}

/** Вспомогательная защита: 1 - e² без потери точности при малых e. */
function e2Safe(e2: number): number {
    return Math.min(1, Math.max(0, e2));
}

export const ELLIPSOIDS: Record<string, Ellipsoid> = {
    merit: new Ellipsoid({ a: 6378137, rf: 298.257, name: 'MERIT 1983' }),
    sgs85: new Ellipsoid({ a: 6378136, rf: 298.257, name: 'Soviet Geodetic System 85' }),
    grs80: new Ellipsoid({ a: 6378137, rf: 298.257222101, name: 'GRS 1980(IUGG, 1980)' }),
    iau76: new Ellipsoid({ a: 6378140, rf: 298.257, name: 'IAU 1976' }),
    airy: new Ellipsoid({ a: 6377563.396, rf: 299.3249646, name: 'Airy 1830' }),
    'apl4.9': new Ellipsoid({ a: 6378137, rf: 298.25, name: 'Appl. Physics. 1965' }),
    nwl9d: new Ellipsoid({ a: 6378145, rf: 298.25, name: 'Naval Weapons Lab., 1965' }),
    mod_airy: new Ellipsoid({ a: 6377340.189, b: 6356034.446, name: 'Modified Airy' }),
    andrae: new Ellipsoid({ a: 6377104.43, rf: 300, name: 'Andrae 1876' }),
    danish: new Ellipsoid({ a: 6377019.2563, rf: 300, name: 'Andrae 1876 (Denmark)' }),
    aust_sa: new Ellipsoid({ a: 6378160, rf: 298.25, name: 'Australian Natl & S. Amer. 1969' }),
    grs67: new Ellipsoid({ a: 6378160, rf: 298.247167427, name: 'GRS 67(IUGG 1967)' }),
    gsk2011: new Ellipsoid({ a: 6378136.5, rf: 298.2564151, name: 'GSK-2011' }),
    bessel: new Ellipsoid({ a: 6377397.155, rf: 299.1528128, name: 'Bessel 1841' }),
    bess_nam: new Ellipsoid({ a: 6377483.865, rf: 299.1528128, name: 'Bessel 1841 (Namibia)' }),
    clrk66: new Ellipsoid({ a: 6378206.4, b: 6356583.8, name: 'Clarke 1866' }),
    clrk80: new Ellipsoid({ a: 6378249.145, rf: 293.4663, name: 'Clarke 1880 mod.' }),
    clrk80ign: new Ellipsoid({ a: 6378249.2, rf: 293.466021293627, name: 'Clarke 1880 (IGN)' }),
    cpm: new Ellipsoid({ a: 6375738.7, rf: 334.29, name: 'Comm. des Poids et Mesures 1799' }),
    delmbr: new Ellipsoid({ a: 6376428, rf: 311.5, name: 'Delambre 1810' }),
    engelis: new Ellipsoid({ a: 6378136.05, rf: 298.2566, name: 'Engelis 1985' }),
    evrst30: new Ellipsoid({ a: 6377276.345, rf: 300.8017, name: 'Everest 1830' }),
    evrst48: new Ellipsoid({ a: 6377304.063, rf: 300.8017, name: 'Everest 1948' }),
    evrst56: new Ellipsoid({ a: 6377301.243, rf: 300.8017, name: 'Everest 1956' }),
    evrst69: new Ellipsoid({ a: 6377295.664, rf: 300.8017, name: 'Everest 1969' }),
    evrstss: new Ellipsoid({ a: 6377298.556, rf: 300.8017, name: 'Everest (Sabah & Sarawak)' }),
    fschr60: new Ellipsoid({ a: 6378166, rf: 298.3, name: 'Fischer (Mercury Datum) 1960' }),
    fschr60m: new Ellipsoid({ a: 6378155, rf: 298.3, name: 'Modified Fischer 1960' }),
    fschr68: new Ellipsoid({ a: 6378150, rf: 298.3, name: 'Fischer 1968' }),
    helmert: new Ellipsoid({ a: 6378200, rf: 298.3, name: 'Helmert 1906' }),
    hough: new Ellipsoid({ a: 6378270, rf: 297, name: 'Hough' }),
    intl: new Ellipsoid({ a: 6378388, rf: 297, name: 'International 1924 (Hayford 1909, 1910)' }),
    krass: new Ellipsoid({ a: 6378245, rf: 298.3, name: 'Krassovsky, 1942' }),
    kaula: new Ellipsoid({ a: 6378163, rf: 298.24, name: 'Kaula 1961' }),
    lerch: new Ellipsoid({ a: 6378139, rf: 298.257, name: 'Lerch 1979' }),
    mprts: new Ellipsoid({ a: 6397300, rf: 191, name: 'Maupertius 1738' }),
    new_intl: new Ellipsoid({ a: 6378157.5, b: 6356772.2, name: 'New International 1967' }),
    plessis: new Ellipsoid({ a: 6376523, b: 6355863, name: 'Plessis 1817 (France)' }),
    pz90: new Ellipsoid({ a: 6378136, rf: 298.25784, name: 'PZ-90' }),
    seasia: new Ellipsoid({ a: 6378155, b: 6356773.3205, name: 'Southeast Asia' }),
    walbeck: new Ellipsoid({ a: 6376896, b: 6355834.8467, name: 'Walbeck' }),
    wgs60: new Ellipsoid({ a: 6378165, rf: 298.3, name: 'WGS 60' }),
    wgs66: new Ellipsoid({ a: 6378145, rf: 298.25, name: 'WGS 66' }),
    wgs72: new Ellipsoid({ a: 6378135, rf: 298.26, name: 'WGS 72' }),
    wgs84: new Ellipsoid({ a: 6378137, rf: 298.257223563, name: 'WGS 84' }),
    sphere: new Ellipsoid({ a: 6370997, b: 6370997, name: 'Normal Sphere' }),
};

// ============================================================
// Парсер PROJ-строки
// ============================================================

/**
 * Разбирает PROJ-строку и возвращает эллипсоид.
 *
 * Приоритет:
 *   1. `+R=` (сфера)
 *   2. `+a=` + один из `+b=`, `+f=`, `+rf=`, `+es=`, `+e=`
 *   3. `+ellps=<name>` (таблица ELLIPSOIDS, ключи в нижнем регистре)
 *   4. `+datum=<name>` (раскрывается в `ellps`)
 *   5. Fallback — WGS84.
 */
export function parseEllipsoid(def: string): Ellipsoid {
    if (!def) return ELLIPSOIDS.wgs84;

    const params: Record<string, string> = {};
    for (const m of def.matchAll(/\+(\w+)=([^\s+]+)/g)) {
        params[m[1].toLowerCase()] = m[2];
    }

    // 1) Сфера
    if (params.r) {
        const R = parseFloat(params.r);
        if (Number.isFinite(R) && R > 0) {
            return new Ellipsoid({ a: R, b: R, name: `Sphere R=${R}` });
        }
    }

    // 2) Явные a + форма
    if (params.a) {
        const a = parseFloat(params.a);
        if (Number.isFinite(a) && a > 0) {
            const shape: Partial<EllipsoidDef> = {};
            if (params.b)  shape.b  = parseFloat(params.b);
            if (params.f)  shape.f  = parseFrac(params.f);
            if (params.rf) shape.rf = parseFloat(params.rf);
            if (params.es) shape.e2 = parseFloat(params.es);
            if (params.e)  shape.e2 = Math.pow(parseFloat(params.e), 2);
            return new Ellipsoid({ a, ...shape });
        }
    }

    // 3) +ellps=
    if (params.ellps) {
        const key = params.ellps.toLowerCase();
        if (ELLIPSOIDS[key]) return ELLIPSOIDS[key];
    }

    // 4) +datum= (минимальный маппинг; расширяйте по необходимости)
    if (params.datum) {
        const key = params.datum.toLowerCase();
        const map: Record<string, string> = {
            wgs84: 'wgs84',
            nad27: 'clrk66',
            nad83: 'grs80',
            osgb36: 'airy',
            potsdam: 'bessel',
            carthage: 'clrk80ign',
        };
        const ellpsKey = map[key];
        if (ellpsKey && ELLIPSOIDS[ellpsKey]) return ELLIPSOIDS[ellpsKey];
    }

    // 5) Fallback
    return ELLIPSOIDS.wgs84;
}

/** Парсит `f` в формате `1/298.257` или `0.00335`. @private */
function parseFrac(s: string): number {
    if (s.includes('/')) {
        const [num, den] = s.split('/');
        return parseFloat(num) / parseFloat(den);
    }
    return parseFloat(s);
}