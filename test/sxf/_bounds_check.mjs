import fs from 'node:fs';
import { parseRsc } from '../../js/sxf/rscParser.js';

const b = fs.readFileSync('test/sxf/25t05gm.rsc');
const cls = parseRsc(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength));
const PX = 22;

// Повторяем расчёт symbolRaster: центр по bbox с учётом радиусов, масштаб по extent.
function layout(sym) {
    let minx = Infinity, maxx = -Infinity, miny = Infinity, maxy = -Infinity;
    const grow = (x, y) => { minx = Math.min(minx, x); maxx = Math.max(maxx, x); miny = Math.min(miny, y); maxy = Math.max(maxy, y); };
    for (const f of sym.fragments) {
        const ell = [6, 7, 64, 65].includes(f.chain) && f.points.length >= 2;
        if (ell) {
            const [ex, ey] = f.points[0], [rx, ry] = f.points[1];
            grow(ex - Math.abs(rx), ey - Math.abs(ry)); grow(ex + Math.abs(rx), ey + Math.abs(ry));
        } else for (const [x, y] of f.points) grow(x, y);
    }
    const cx = (minx + maxx) / 2, cy = (miny + maxy) / 2;
    const extent = Math.max(maxx - minx, maxy - miny) || 1;
    return { cx, cy, extent, scale: (PX * 0.45) / extent };
}

for (const [name, code] of [['Фонтаны', 31650000], ['Ямы', 22250000], ['Монументы', 53530000], ['Церкви', 53420000]]) {
    const s = cls.objectByCode.get(code).style.symbol;
    const L = layout(s);
    // Границы каждого фрагмента в пикселях (окружность — с радиусом, остальное — по точкам).
    let out = 0, total = 0, minPx = Infinity, maxPx = -Infinity, minPy = Infinity, maxPy = -Infinity;
    for (const f of s.fragments) {
        const ell = [6, 7, 64, 65].includes(f.chain) && f.points.length >= 2;
        const pts = ell
            ? [[f.points[0][0] - Math.abs(f.points[1][0]), f.points[0][1] - Math.abs(f.points[1][1])],
               [f.points[0][0] + Math.abs(f.points[1][0]), f.points[0][1] + Math.abs(f.points[1][1])]]
            : f.points;
        for (const [x, y] of pts) {
            const px = (x - L.cx) * L.scale + PX / 2, py = (y - L.cy) * L.scale + PX / 2;
            total++;
            if (px < 0 || px > PX || py < 0 || py > PX) out++;
            minPx = Math.min(minPx, px); maxPx = Math.max(maxPx, px);
            minPy = Math.min(minPy, py); maxPy = Math.max(maxPy, py);
        }
    }
    console.log(name, 'extent', L.extent, 'scale', L.scale.toFixed(5),
        'px bbox x', minPx.toFixed(1), maxPx.toFixed(1), 'y', minPy.toFixed(1), maxPy.toFixed(1),
        'outside', out, 'of', total);
}
