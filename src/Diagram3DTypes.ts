// Diagram3DTypes.ts
import { THREE } from './js_TP/tpb.js';

const PALETTE_3D = [
    '#3498db', '#e74c3c', '#2ecc71', '#f39c12',
    '#9b59b6', '#1abc9c', '#e67e22', '#34495e',
];

export interface Diagram3DData {
    label: string;
    value: number;
    color?: string | number;
}

export interface Diagram3DSize {
    width: number;
    depth: number;
    height: number;
}
export interface Diagram3DRenderParams {
    data: Diagram3DData[];
    unitM: number;      
    barWidthM?: number; 
    barDepthM?: number; 
    gapM?: number;      
    strokeColor?: string | number;
    strokeWidthM?: number; 
    unitValue?: number; 
    maxCols?: number;  
}

export interface Diagram3DTypeDefinition {
    name: string;
    computeSize(p: Diagram3DRenderParams): Diagram3DSize;
    build(p: Diagram3DRenderParams): THREE.Group;
}

// ── Столбчатая 3D ──────────────────────────────────────────────────
export const bar3D: Diagram3DTypeDefinition = {
    name: 'bar3d',
    computeSize({ data, unitM, barWidthM = 10, barDepthM = 10, gapM = 2 }) {
        const maxVal = Math.max(0, ...data.map(d => d.value));
        const n = data.length;
        return {
            width: n * barWidthM + (n - 1) * gapM,
            depth: barDepthM,
            height: maxVal * unitM,
        };
    },
build({ data, unitM, barWidthM = 10, barDepthM = 10, gapM = 2, strokeColor }) {
    const group = new THREE.Group();
    let x = 0;
    for (let i = 0; i < data.length; i++) {
        const d = data[i];
        const h = Math.max(0.1, d.value * unitM);
        const geom = new THREE.BoxGeometry(barWidthM, h, barDepthM);
        geom.translate(0, h / 2, 0);
        
        const mat = new THREE.MeshStandardMaterial({ 
            color: d.color ?? PALETTE_3D[i % PALETTE_3D.length],  // ← ИСПРАВЛЕНО
            roughness: 0.5,
            transparent: true,
            opacity: 1,
            depthWrite: true,
            depthTest: true,
        });
        const mesh = new THREE.Mesh(geom, mat);
        mesh.position.x = x + barWidthM / 2;
        
        if (strokeColor) {
            const edges = new THREE.EdgesGeometry(geom);
            const line = new THREE.LineSegments(
                edges, 
                new THREE.LineBasicMaterial({ 
                    color: strokeColor,
                    transparent: true,
                    opacity: 1,
                    depthWrite: true,
                    depthTest: true,
                })
            );
            line.scale.set(1.01, 1.01, 1.01); 
            mesh.add(line);
        }
        
        group.add(mesh);
        x += barWidthM + gapM;
    }
    return group;
}
};

// ── Круговая 3D (Пирог) ────────────────────────────────────────────
export const pie3D: Diagram3DTypeDefinition = {
    name: 'pie3d',
    computeSize({ data, unitM }) {
        const total = data.reduce((s, d) => s + Math.max(0, d.value), 0);
        const radius = Math.sqrt(total) * unitM;
        return {
            width: radius * 2,
            depth: radius * 2,
            height: radius * 0.5,
        };
    },
   build({ data, unitM, strokeColor }) {
    const group = new THREE.Group();
    const total = data.reduce((s, d) => s + Math.max(0, d.value), 0);
    if (total <= 0) return group;
    
    const radius = Math.sqrt(total) * unitM;
    const depth = radius * 0.5;
    let startAngle = 0;
    
    for (let i = 0; i < data.length; i++) {
        const d = data[i];
        const angle = (Math.max(0, d.value) / total) * Math.PI * 2;
        if (angle <= 0) continue;
        
        const geom = new THREE.CylinderGeometry(
            radius, radius, depth, 32, 1, false, startAngle, angle
        );
        geom.translate(0, depth / 2, 0);
        
        const mat = new THREE.MeshStandardMaterial({ 
            color: d.color ?? PALETTE_3D[i % PALETTE_3D.length],  // ← ИСПРАВЛЕНО
            roughness: 0.5,
            transparent: true,
            opacity: 1,
            depthWrite: true,
            depthTest: true,
        });
        const mesh = new THREE.Mesh(geom, mat);
        
        if (strokeColor) {
            const edges = new THREE.EdgesGeometry(geom, 15);
            const line = new THREE.LineSegments(
                edges, 
                new THREE.LineBasicMaterial({ 
                    color: strokeColor,
                    transparent: true,
                    opacity: 1,
                    depthWrite: true,
                    depthTest: true,
                })
            );
            line.scale.set(1.01, 1.01, 1.01); 
            mesh.add(line);
        }
        
        group.add(mesh);
        startAngle += angle;
    }
    return group;
}
};

// ── Кружки 3D (Цилиндры) ───────────────────────────────────────────
export const circle3D: Diagram3DTypeDefinition = {
    name: 'circle3d',
    computeSize({ data, unitM, gapM = 2 }) {
        const radii = data.map(d => Math.sqrt(Math.max(0, d.value)) * unitM);
        const maxR = Math.max(0, ...radii);
        const depth = maxR * 0.5; // Фиксированная высота (как у пирога)
        const totalW = radii.reduce((s, r) => s + r * 2, 0) + gapM * Math.max(0, data.length - 1);
        return {
            width: totalW,
            depth: maxR * 2,
            height: depth,
        };
    },
    build({ data, unitM, gapM = 2, strokeColor }) {
        const group = new THREE.Group();
        const radii = data.map(d => Math.sqrt(Math.max(0, d.value)) * unitM);
        const maxR = Math.max(0, ...radii);
        const depth = maxR * 0.5;
        let x = 0;
        
        for (let i = 0; i < data.length; i++) {
            const d = data[i];
            const r = radii[i];
            if (r <= 0) continue;
            
            const geom = new THREE.CylinderGeometry(r, r, depth, 32);
            geom.translate(0, depth / 2, 0); // Опускаем на землю
            
            const mat = new THREE.MeshStandardMaterial({ 
                color: d.color ?? PALETTE_3D[i % PALETTE_3D.length],
                roughness: 0.5,
                transparent: true,
                opacity: 1,
                depthWrite: true,
                depthTest: true,
            });
            const mesh = new THREE.Mesh(geom, mat);
            mesh.position.x = x + r;
            
            if (strokeColor) {
                const edges = new THREE.EdgesGeometry(geom, 15); // 15° отсекает скругления
                const line = new THREE.LineSegments(
                    edges, 
                    new THREE.LineBasicMaterial({ 
                        color: strokeColor,
                        transparent: true,
                        opacity: 1,
                        depthWrite: true,
                        depthTest: true,
                    })
                );
                line.scale.set(1.01, 1.01, 1.01); 
                mesh.add(line);
            }
            
            group.add(mesh);
            x += r * 2 + gapM;
        }
        return group;
    }
};

// ── Кубики 3D ─────────────────────────────────────────────────────
export const cube3D: Diagram3DTypeDefinition = {
    name: 'cube3d',
    computeSize({ data, unitM, gapM = 2 }) {
        const sides = data.map(d => Math.cbrt(Math.max(0, d.value)) * unitM);
        const maxSide = Math.max(0, ...sides);
        const totalW = sides.reduce((s, side) => s + side, 0) + gapM * Math.max(0, data.length - 1);
        return {
            width: totalW,
            depth: maxSide,
            height: maxSide,
        };
    },
    build({ data, unitM, gapM = 2, strokeColor }) {
        const group = new THREE.Group();
        const sides = data.map(d => Math.cbrt(Math.max(0, d.value)) * unitM);
        let x = 0;
        
        for (let i = 0; i < data.length; i++) {
            const d = data[i];
            const side = sides[i];
            if (side <= 0) continue;
            
            const geom = new THREE.BoxGeometry(side, side, side);
            geom.translate(0, side / 2, 0); // Опускаем на землю
            
            const mat = new THREE.MeshStandardMaterial({ 
                color: d.color ?? PALETTE_3D[i % PALETTE_3D.length],
                roughness: 0.5,
                transparent: true,
                opacity: 1,
                depthWrite: true,
                depthTest: true,
            });
            const mesh = new THREE.Mesh(geom, mat);
            mesh.position.x = x + side / 2;
            
            if (strokeColor) {
                const edges = new THREE.EdgesGeometry(geom);
                const line = new THREE.LineSegments(
                    edges, 
                    new THREE.LineBasicMaterial({ 
                        color: strokeColor,
                        transparent: true,
                        opacity: 1,
                        depthWrite: true,
                        depthTest: true,
                    })
                );
                line.scale.set(1.01, 1.01, 1.01); 
                mesh.add(line);
            }
            
            group.add(mesh);
            x += side + gapM;
        }
        return group;
    }
};



function getUnitColors(data: Diagram3DData[], unitValue: number): string[] {
    const total = data.reduce((s, d) => s + Math.max(0, d.value), 0);
    const totalUnits = Math.max(1, Math.round(total / unitValue));
    const unitsPerSeries = data.map(d => Math.max(0, Math.round(d.value / unitValue)));
    
    let sum = unitsPerSeries.reduce((s, u) => s + u, 0);
    while (sum < totalUnits && unitsPerSeries.length) { unitsPerSeries[0]++; sum++; }
    while (sum > totalUnits && unitsPerSeries.length) { unitsPerSeries[0]--; sum--; }

    const colors: string[] = [];
    for (let i = 0; i < unitsPerSeries.length; i++) {
        const color = data[i].color ?? PALETTE_3D[i % PALETTE_3D.length];
        for (let k = 0; k < unitsPerSeries[i]; k++) colors.push(color as string);
    }
    return colors;
}

// ── Венский способ 3D (плоская сетка) ─────────────────────────────
export const vienna3D: Diagram3DTypeDefinition = {
    name: 'vienna3d',
    computeSize({ data, unitM, gapM = 2, unitValue = 1, maxCols = 5 }) {
        const total = data.reduce((s, d) => s + Math.max(0, d.value), 0);
        const totalUnits = Math.max(1, Math.round(total / unitValue));
        const cols = Math.min(totalUnits, maxCols);
        const rows = Math.ceil(totalUnits / cols);

        return {
            width: cols * unitM + (cols - 1) * gapM,
            depth: rows * unitM + (rows - 1) * gapM,
            height: unitM,
        };
    },
    build({ data, unitM, gapM = 2, unitValue = 1, maxCols = 5, strokeColor }) {
        const group = new THREE.Group();
        const total = data.reduce((s, d) => s + Math.max(0, d.value), 0);
        const totalUnits = Math.max(1, Math.round(total / unitValue));
        const cols = Math.min(totalUnits, maxCols);
        const unitColors = getUnitColors(data, unitValue);

        for (let i = 0; i < totalUnits; i++) {
            const row = Math.floor(i / cols);
            const col = i % cols;

            const geom = new THREE.BoxGeometry(unitM, unitM, unitM);
            geom.translate(0, unitM / 2, 0); // Стоит на земле

            const mat = new THREE.MeshStandardMaterial({ 
                color: unitColors[i],
                roughness: 0.5,
                transparent: true,
                opacity: 1,
                depthWrite: true,
                depthTest: true,
            });
            const mesh = new THREE.Mesh(geom, mat);
            
            mesh.position.x = col * (unitM + gapM) + unitM / 2;
            mesh.position.z = row * (unitM + gapM) + unitM / 2;

            if (strokeColor) {
                const edges = new THREE.EdgesGeometry(geom);
                const line = new THREE.LineSegments(
                    edges, 
                    new THREE.LineBasicMaterial({ color: strokeColor, transparent: true, opacity: 1 })
                );
                line.scale.set(1.01, 1.01, 1.01); 
                mesh.add(line);
            }
            group.add(mesh);
        }
        return group;
    }
};

// ── Венский способ 3D (объёмная башня) ────────────────────────────
export const viennaCubes3D: Diagram3DTypeDefinition = {
    name: 'viennacubes3d',
    computeSize({ data, unitM, gapM = 2, unitValue = 1 }) {
        const total = data.reduce((s, d) => s + Math.max(0, d.value), 0);
        const totalUnits = Math.max(1, Math.round(total / unitValue));

        let best = { w: 1, d: 1, h: 1, score: Infinity };
        for (let h = 1; h <= Math.ceil(Math.cbrt(totalUnits)) + 1; h++) {
            const w = Math.ceil(Math.sqrt(totalUnits / h));
            const d = Math.ceil(totalUnits / (w * h));
            const vol = w * d * h;
            const score = Math.abs(w - d) * 1.5 + Math.abs(d - h) + (vol - totalUnits) * 0.5;
            if (score < best.score) best = { w, d, h, score };
        }
        const { w, d, h } = best;

        return {
            width: w * unitM + (w - 1) * gapM,
            depth: d * unitM + (d - 1) * gapM,
            height: h * unitM + (h - 1) * gapM,
        };
    },
    build({ data, unitM, gapM = 2, unitValue = 1, strokeColor }) {
        const group = new THREE.Group();
        const total = data.reduce((s, d) => s + Math.max(0, d.value), 0);
        const totalUnits = Math.max(1, Math.round(total / unitValue));

        let best = { w: 1, d: 1, h: 1, score: Infinity };
        for (let h = 1; h <= Math.ceil(Math.cbrt(totalUnits)) + 1; h++) {
            const w = Math.ceil(Math.sqrt(totalUnits / h));
            const d = Math.ceil(totalUnits / (w * h));
            const vol = w * d * h;
            const score = Math.abs(w - d) * 1.5 + Math.abs(d - h) + (vol - totalUnits) * 0.5;
            if (score < best.score) best = { w, d, h, score };
        }
        const { w, d, h } = best;
        const unitColors = getUnitColors(data, unitValue);

        let count = 0;
        // Заполняем слоями: снизу вверх (z), сзади вперед (y), слева направо (x)
        for (let z = 0; z < h; z++) {
            for (let y = d - 1; y >= 0; y--) {
                for (let x = 0; x < w; x++) {
                    if (count < totalUnits) {
                        const geom = new THREE.BoxGeometry(unitM, unitM, unitM);
                        
                        const mat = new THREE.MeshStandardMaterial({ 
                            color: unitColors[count],
                            roughness: 0.5,
                            transparent: true,
                            opacity: 1,
                            depthWrite: true,
                            depthTest: true,
                        });
                        const mesh = new THREE.Mesh(geom, mat);
                        
                        mesh.position.x = x * (unitM + gapM) + unitM / 2;
                        mesh.position.y = z * (unitM + gapM) + unitM / 2; // z в цикле - это высота
                        mesh.position.z = y * (unitM + gapM) + unitM / 2;

                        if (strokeColor) {
                            const edges = new THREE.EdgesGeometry(geom);
                            const line = new THREE.LineSegments(
                                edges, 
                                new THREE.LineBasicMaterial({ color: strokeColor, transparent: true, opacity: 1 })
                            );
                            line.scale.set(1.01, 1.01, 1.01); 
                            mesh.add(line);
                        }
                        group.add(mesh);
                        count++;
                    }
                }
            }
        }
        return group;
    }
};

// ── Реестр ────────────────────────────────────────────────────────
export const DIAGRAM3D_TYPES: Record<string, Diagram3DTypeDefinition> = {
    bar3d: bar3D,
    pie3d: pie3D,
    circle3d: circle3D,
    cube3d: cube3D,
    vienna3d: vienna3D,         
    viennacubes3d: viennaCubes3D 
};

export function getDiagram3DType(name: string): Diagram3DTypeDefinition {
    const t = DIAGRAM3D_TYPES[name];
    if (!t) throw new Error(`Diagram3D: unknown type "${name}". Registered: ${Object.keys(DIAGRAM3D_TYPES).join(', ')}`);
    return t;
}