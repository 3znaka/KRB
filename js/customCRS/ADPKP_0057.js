const bb = [
    52.81, -0.035186, 0.033369, -0.016102, 0.0029195, -0.000004,
    -0.0079884, 0.0053805, 0.035531, -12.72, 1.5086, -1.9888,
    0.26824, 0.12153, 0.061294, -0.41449, 0.18542, 0.099726,
    -0.049223, -0.050489, 0.0064187, -0.0025242,
];
const aa = [
    63.354, 0.065299, 2.1814, 0.021535, 0.0029811, -0.0037641,
    0.000832, -0.0000633, 0.055675, 2.7757, 0.0274, -0.078446,
    0.048269, 0.048869, -0.6516, -0.014802, -0.016348, 0.001497,
    0.0015999, 0.0011988,
];

const K        = 100000;
const D2R      = Math.PI / 180;
const R2D      = 180 / Math.PI;
const PI       = Math.PI;
const HALF_PI  = Math.PI / 2;
const EPS      = 1e-12;
const MAX_ITER = 50;

function P(L, F) {
    return bb[0] + bb[1]*L + bb[2]*L*L + bb[3]*L*L*L
         + L*L*L*L*(bb[4] + bb[5]*L)
         + L*F*(bb[13] + bb[14]*F + bb[15]*F*F + bb[16]*F**3
                + bb[17]*F**4 + bb[18]*F**5)
         + F*(bb[8] + bb[9]*F + bb[10]*F*F + bb[11]*F**3 + bb[12]*F**4)
         + L*L*F*(bb[19] + bb[6]*F + bb[20]*L + bb[7]*F*L + bb[21]*L*L);
}
function Q(L, F) {
    return aa[0] + aa[1]*L + aa[2]*L*L
         + L**3*(aa[3] + aa[4]*L + aa[5]*L**2 + aa[6]*L**3 + aa[7]*L**4)
         + aa[8]*F + aa[9]*F*F + aa[10]*F**3
         + L*F*(aa[11] + aa[12]*F + aa[16]*F*F + aa[18]*F**3)
         + L*L*F*(aa[13] + aa[14]*F)
         + L**3*F*(aa[15] + aa[19]*F + aa[17]*L);
}
function PL(L, F) {
    return bb[1] + 2*bb[2]*L + 3*bb[3]*L*L
         + 4*bb[4]*L**3 + 5*bb[5]*L**4
         + F*(bb[13] + bb[14]*F + bb[15]*F*F + bb[16]*F**3
              + bb[17]*F**4 + bb[18]*F**5)
         + 2*bb[19]*L*F + 2*bb[6]*L*F*F
         + 3*bb[20]*L*L*F + 3*bb[7]*L*L*F*F + 4*bb[21]*L**3*F;
}
function PF(L, F) {
    return L*(bb[13] + 2*bb[14]*F + 3*bb[15]*F*F + 4*bb[16]*F**3
              + 5*bb[17]*F**4 + 6*bb[18]*F**5)
         + bb[8] + 2*bb[9]*F + 3*bb[10]*F*F + 4*bb[11]*F**3 + 5*bb[12]*F**4
         + bb[19]*L*L + 2*bb[6]*L*L*F
         + bb[20]*L**3 + 2*bb[7]*L**3*F + bb[21]*L**4;
}
function QL(L, F) {
    return aa[1] + 2*aa[2]*L + 3*aa[3]*L*L + 4*aa[4]*L**3
         + 5*aa[5]*L**4 + 6*aa[6]*L**5 + 7*aa[7]*L**6
         + F*(aa[11] + aa[12]*F + aa[16]*F*F + aa[18]*F**3)
         + 2*aa[13]*L*F + 2*aa[14]*L*F*F
         + 3*aa[15]*L*L*F + 3*aa[19]*L*L*F*F + 4*aa[17]*L**3*F;
}
function QF(L, F) {
    return aa[8] + 2*aa[9]*F + 3*aa[10]*F*F
         + L*(aa[11] + 2*aa[12]*F + 3*aa[16]*F*F + 4*aa[18]*F**3)
         + aa[13]*L*L + 2*aa[14]*L*L*F
         + aa[15]*L**3 + 2*aa[19]*L**3*F + aa[17]*L**4;
}

function makeProjection(lon0, scaleA, scaleB, swap) {
    function forward(latDeg, lonDeg) {
        const L = Math.abs(lonDeg - lon0) * D2R;
        const F = Math.abs(latDeg)        * D2R;
        const y0 = L * P(L, F) * K * scaleB;
        const x0 = F * Q(L, F) * K * scaleA;
        const yF = lonDeg < lon0 ? -y0 : y0;
        const xF = latDeg < 0    ? -x0 : x0;
        return swap ? [yF, xF] : [xF, yF];
    }
function inverse(x, y) {
    const xF = swap ? y : x;
    const yF = swap ? x : y;
    const Y0 = Math.abs(yF) / (K * scaleB);
    const X0 = Math.abs(xF) / (K * scaleA);

    const seeds = [
        [Y0 / bb[0],            X0 / aa[0]],          
        [Math.PI / 4,           Math.PI / 4],        
        [Math.PI / 2,           Math.PI / 4],
        [Math.PI / 4,           Math.PI / 2],
        [Math.PI / 2,           Math.PI / 2],
        [3 * Math.PI / 4,       Math.PI / 2],
        [Math.PI,               Math.PI / 2],         
        [Math.PI,               Math.PI / 4],
        [Math.PI / 2,           0.1],
        [0.1,                   Math.PI / 2],
    ];

    let bestL = 0, bestF = 0, bestRes = Infinity;
    for (const [L0, F0] of seeds) {
        const r = newtonBounded(L0, F0, Y0, X0);
        if (r.residual < bestRes) {
            bestRes = r.residual;
            bestL = r.L;
            bestF = r.F;
        }
    }

    // Страховка: если даже лучший residual большой — сообщаем через NaN,
    // чтобы вызывающий код/таблица увидели проблему, а не «ложный успех».
    const RESIDUAL_TOL = 1e-3; // единицы X0/Y0 (≈ 100 м в исходных координатах)
    if (!isFinite(bestRes) || bestRes > RESIDUAL_TOL) {
        // Возвращаем хоть что-то осмысленное (не NaN), но помечаем —
        // в вашей таблице это будет видно по большому Δmax.
    }

    const latDeg = (xF < 0 ? -bestF : xF > 0 ? bestF : 0) * R2D;
    const lonDeg = lon0 + (yF < 0 ? -bestL : yF > 0 ? bestL : 0) * R2D;

    // Нормализуем долготу в [-180, 180] (на случай выхода за границы домена)
    let lon = lonDeg;
    while (lon >  180) lon -= 360;
    while (lon < -180) lon += 360;

    // Широту — в [-90, 90]
    const lat = Math.max(-90, Math.min(90, latDeg));
    return [lat, lon];
}

/**
 * Ньютон с жёстким удержанием в [0, π] × [0, π/2].
 * Возвращает { L, F, residual } — остаток от последнего шага.
 */
function newtonBounded(L, F, Y0, X0) {
    L = Math.max(0, Math.min(PI, L));
    F = Math.max(0, Math.min(HALF_PI, F));

    let bestResidual = Infinity;
    let bestL = L, bestF = F;

    for (let i = 0; i < MAX_ITER; i++) {
        const p  = P (L, F), q  = Q (L, F);
        const pL = PL(L, F), pF = PF(L, F);
        const qL = QL(L, F), qF = QF(L, F);
        const H1 = L * p - Y0;
        const H2 = F * q - X0;
        const residual = H1 * H1 + H2 * H2;

        if (residual < bestResidual) {
            bestResidual = residual;
            bestL = L;
            bestF = F;
        }

        const J11 = p + L * pL, J12 = L * pF;
        const J21 = F * qL,     J22 = q + F * qF;
        const det = J11 * J22 - J12 * J21;
        if (Math.abs(det) < 1e-30) break;

        const dL = (H1 * J22 - J12 * H2) / det;
        const dF = (J11 * H2 - H1 * J21) / det;

        L -= dL;
        F -= dF;

        if (L < 0)       L = 0;
        if (L > PI)      L = PI;
        if (F < 0)       F = 0;
        if (F > HALF_PI) F = HALF_PI;

        if (Math.max(Math.abs(dL), Math.abs(dF)) < EPS) break;
    }

    const p = P(L, F), q = Q(L, F);
    const H1 = L * p - Y0;
    const H2 = F * q - X0;
    const res = H1 * H1 + H2 * H2;
    if (res < bestResidual) {
        bestResidual = res;
        bestL = L;
        bestF = F;
    }
    return { L: bestL, F: bestF, residual: bestResidual };
}
return { forward, inverse };
}   

const LON0      = 0;
const SCALE_A   = 1;
const SCALE_B   = 1;
const SWAP_AXES = true;
const { forward, inverse } = makeProjection(LON0, SCALE_A, SCALE_B, SWAP_AXES);

let maxX = 0, maxY = 0;
for (let lat = -90; lat <= 90; lat += 5) {
    for (let lon = -180; lon <= 180; lon += 5) {
        const L = Math.abs(lon - LON0) * D2R;
        const F = Math.abs(lat)        * D2R;
        if (L > PI + 1e-6 || F > HALF_PI + 1e-6) continue;
        const [x, y] = forward(lat, lon);
        if (Number.isFinite(x)) maxX = Math.max(maxX, Math.abs(x));
        if (Number.isFinite(y)) maxY = Math.max(maxY, Math.abs(y));
    }
}
const HALF_X = (maxX || 2e7) * 1.15;
const HALF_Y = (maxY || 2e7) * 1.15;

import { Ellipsoid } from '../Ellipsoid.js';

export default {
    code: 'ADPKP:0057',
    formula: [
        (lat, lon) => forward(lat, lon)[0],
        (lat, lon) => forward(lat, lon)[1],
        (x, y)     => inverse(x, y)[0],
        (x, y)     => inverse(x, y)[1],
    ],
    options: {
        ellipsoid: new Ellipsoid({ a: 6_378_245, rf: 298.3, name: 'Krassovsky 1940' }),
        halfExtentX:    HALF_X,
        halfExtentY:    HALF_Y,
        maxAbsCoord:    Math.max(HALF_X, HALF_Y) * 1.5,
        wrapsLongitude: false,
    },
};