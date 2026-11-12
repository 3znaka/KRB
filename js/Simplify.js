export function douglasPeuckerIndices(points, tolerance) {
    const n = points.length;
    if (n < 3)
        return points.map((_, i) => i);
    const sqTol = tolerance * tolerance;
    const keep = new Uint8Array(n);
    keep[0] = 1;
    keep[n - 1] = 1;
    const stack = [[0, n - 1]];
    while (stack.length) {
        const [first, last] = stack.pop();
        const ax = points[first][0], ay = points[first][1];
        const bx = points[last][0], by = points[last][1];
        const dx = bx - ax, dy = by - ay;
        const lineLenSq = dx * dx + dy * dy;
        let maxDSq = 0, maxIdx = -1;
        for (let i = first + 1; i < last; i++) {
            let dSq;
            if (lineLenSq === 0) {
                const px = points[i][0] - ax, py = points[i][1] - ay;
                dSq = px * px + py * py;
            }
            else {
                let t = ((points[i][0] - ax) * dx + (points[i][1] - ay) * dy) / lineLenSq;
                if (t < 0)
                    t = 0;
                else if (t > 1)
                    t = 1;
                const cx = ax + t * dx, cy = ay + t * dy;
                const px = points[i][0] - cx, py = points[i][1] - cy;
                dSq = px * px + py * py;
            }
            if (dSq > maxDSq) {
                maxDSq = dSq;
                maxIdx = i;
            }
        }
        if (maxDSq > sqTol && maxIdx > 0) {
            keep[maxIdx] = 1;
            stack.push([first, maxIdx], [maxIdx, last]);
        }
    }
    const out = [];
    for (let i = 0; i < n; i++)
        if (keep[i])
            out.push(i);
    return out;
}
export function simplifyRingIndices(points, tolerance) {
    const n = points.length;
    if (n < 4)
        return points.map((_, i) => i);
    let farIdx = 1, maxDSq = 0;
    const ax = points[0][0], ay = points[0][1];
    for (let i = 1; i < n; i++) {
        const dx = points[i][0] - ax, dy = points[i][1] - ay;
        const dSq = dx * dx + dy * dy;
        if (dSq > maxDSq) {
            maxDSq = dSq;
            farIdx = i;
        }
    }
    const h1 = douglasPeuckerIndices(points.slice(0, farIdx + 1), tolerance);
    const h2 = douglasPeuckerIndices(points.slice(farIdx), tolerance);
    const out = h1.slice();
    for (let i = 1; i < h2.length; i++)
        out.push(farIdx + h2[i]);
    return out;
}
