// PolygonBatcher.ts
import { THREE } from './js_TP/tpb.js';
import { applyGapMaskToMaterial } from './PolygonUtils.js';
const RENDER_ORDER = { BOTTOM: 900, SIDE: 901, TOP: 902, STROKE: 903 };
const DEFAULT_PATTERN_SCALE = 64;
function isBatchable(obj) {
    return !!obj
        && typeof obj._getBatchStyleKey === 'function'
        && typeof obj._getBatchGeometryData === 'function';
}
// =====================================================================
// BatchedGroup
// =====================================================================
class BatchedGroup {
    mesh = null;
    fillMaterial = null;
    strokeLine = null;
    strokeMaterial = null;
    polygons;
    polygonSet;
    _trianglesToPolygon = [];
    /** Диапазоны вершин TOP/BOTTOM для быстрой recolor без пересчёта геометрии. */
    _colorRanges = [];
    _unregister = null;
    _map = null;
    _anchorX = 0;
    _anchorY = 0;
    _anchorZ = 0;
    /** Вершины заданы мировыми 3D-позициями (глобус) — меш не сдвигаем по Y. */
    _usesWorldPositions = false;
    /** Р¦РµРЅС‚СЂ СЃС„РµСЂС‹ РІ local worldGroup РєРѕРѕСЂРґРёРЅР°С‚Р°С… (anchor СѓР¶Рµ СѓС‡С‚С‘РЅ). */
    _boundingSphere = null;
    /** РџРµСЂРµРёСЃРїРѕР»СЊР·СѓРµРјС‹Р№ РІРµРєС‚РѕСЂ РґР»СЏ getBoundingSphere (РјРёСЂ. РєРѕРѕСЂРґРёРЅР°С‚С‹). */
    _boundingSphereWorldCenter = null;
    // Глобус: кэш временных объектов для мирового bounding box (без аллокаций на hover).
    _globeBox = null;
    _globeCorner = null;
    _globeSize = null;
    /** Кэш мирового bounding sphere батча на глобусе (см. _registerInteraction). */
    _globeBoxCache = null;
    _globeBoxKey = null;
    _minZoom = -Infinity;
    _maxZoom = Infinity;
    /** Р Р°Р·РґРµР»СЏРµРјР°СЏ С‚РµРєСЃС‚СѓСЂР° РїР°С‚С‚РµСЂРЅР° вЂ” РІР»Р°РґРµР»РµС† PolygonBatcher. */
    _patternTexture = null;
    /** РРЅС‚РµСЂРїРѕР»СЏС†РёСЏ РїСЂРѕР·СЂР°С‡РЅРѕСЃС‚Рё РїРѕ Р·СѓРјСѓ (РµСЃР»Рё Р±С‹Р»Р° РІ РґР°РЅРЅС‹С…). */
    _zoomFillOpacity = null;
    _baseFillOpacity = 1;
    _baseStrokeOpacity = 1;
    _disposed = false;
    constructor(polygons) {
        this.polygons = polygons;
        this.polygonSet = new Set(polygons);
        this._boundingSphereWorldCenter = new THREE.Vector3();
    }
    /** Накопленные данные полигонов (инкрементальный сбор, см. prepareStep). */
    _prepared = [];
    _prepIndex = 0;
    _prepared_done = false;
    /**
     * Инкрементальный сбор геометрии полигонов: обрабатывает полигоны, пока не
     * исчерпан бюджет времени. Тяжёлая работа (триангуляция, субдивизия на
     * сфере) выполняется в _getBatchGeometryData каждого полигона, поэтому
     * батч из сотен полигонов собирается за несколько кадров, а не в один.
     * @returns true, когда все полигоны подготовлены.
     */
    prepareStep(budgetMs) {
        if (this._prepared_done)
            return true;
        const start = performance.now();
        while (this._prepIndex < this.polygons.length) {
            const p = this.polygons[this._prepIndex++];
            const d = p._getBatchGeometryData();
            if (d && d.indices && d.indices.length >= 3)
                this._prepared.push({ poly: p, data: d });
            if (performance.now() - start >= budgetMs)
                return false;
        }
        this._prepared_done = true;
        return true;
    }
    /** Есть ли уже подготовленные данные (для вызова build после prepareStep). */
    get prepared() { return this._prepared_done; }
    build(map, getPatternTexture) {
        this._map = map;
        // Если данные ещё не собраны инкрементально — собираем целиком (фоллбэк).
        if (!this._prepared_done)
            this.prepareStep(Infinity);
        const datas = this._prepared;
        if (datas.length === 0)
            return;
        let sx = 0, sz = 0, sy = 0, syCount = 0;
        for (const { data } of datas) {
            sx += data.centroidX;
            sz += data.centroidZ;
            // Р“Р»РѕР±СѓСЃ: СЃРµСЂРµРґРёРЅР° РїРѕ Y вЂ” РёРЅР°С‡Рµ Р±Р°С‚С‡ В«РїСЂРёР»РёРїР°РµС‚В» Рє y = 0.
            const wp = data.worldPositions;
            if (wp && wp.length >= 3) {
                let acc = 0;
                for (let i = 1; i < wp.length; i += 3)
                    acc += wp[i];
                sy += acc / (wp.length / 3);
                syCount++;
            }
        }
        this._anchorX = sx / datas.length;
        this._anchorZ = sz / datas.length;
        this._anchorY = syCount > 0 ? sy / syCount : 0;
        // Есть ли в батче 3D-позиции (глобус)? Тогда vertex Y — мировые
        // координаты, и меш нельзя опускать в y = 0.
        this._usesWorldPositions = datas.some(({ data }) => !!data.worldPositions);
        const d0 = datas[0].data;
        this._minZoom = d0.minZoom;
        this._maxZoom = d0.maxZoom;
        this._baseFillOpacity = d0.fillOpacity;
        this._baseStrokeOpacity = d0.strokeOpacity;
        if (d0.fillPatternSource) {
            this._patternTexture = getPatternTexture(d0.fillPatternSource);
        }
        // Zoom-РёРЅС‚РµСЂРїРѕР»СЏС†РёСЏ РїСЂРѕР·СЂР°С‡РЅРѕСЃС‚Рё (РіРѕС‚РѕРІРѕ Рє С€Р°РіСѓ B).
        const zi = d0.zoomInterpolations?.fillOpacity;
        if (zi && zi.length >= 2) {
            this._zoomFillOpacity = zi;
        }
        const patternScale = d0.fillPatternScale > 0 ? d0.fillPatternScale : DEFAULT_PATTERN_SCALE;
        const patternFit = d0.fillPatternFit;
        const batchOriginX = Math.floor(this._anchorX / patternScale) * patternScale;
        const batchOriginZ = Math.floor(this._anchorZ / patternScale) * patternScale;
        const positions = [];
        const uvs = [];
        const indices = [];
        const triPoly = [];
        const colorRanges = [];
        for (const { poly, data } of datas) {
            const baseVertex = positions.length / 3;
            const wc = data.worldCoords;
            const colorStart = baseVertex;
            const heights = data.heights;
            const n = wc.length;
            const height = data.height;
            const isExtruded = data.extruded && height > 0;
            let bboxMinX = 0, bboxSizeX = 1, bboxMinZ = 0, bboxSizeZ = 1;
            if (patternFit === 'bounds') {
                let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
                for (let i = 0; i < n; i++) {
                    const [x, z] = wc[i];
                    if (x < minX)
                        minX = x;
                    if (x > maxX)
                        maxX = x;
                    if (z < minZ)
                        minZ = z;
                    if (z > maxZ)
                        maxZ = z;
                }
                bboxMinX = minX;
                bboxMinZ = minZ;
                bboxSizeX = (maxX - minX) > 1e-6 ? (maxX - minX) : 1;
                bboxSizeZ = (maxZ - minZ) > 1e-6 ? (maxZ - minZ) : 1;
            }
            const pushUV = (wx, wz) => {
                if (patternFit === 'bounds') {
                    uvs.push((wx - bboxMinX) / bboxSizeX, (wz - bboxMinZ) / bboxSizeZ);
                }
                else {
                    uvs.push((wx - batchOriginX) / patternScale, (wz - batchOriginZ) / patternScale);
                }
            };
            // в”Ђв”Ђ TOP в”Ђв”Ђ
            // worldPositions вЂ” РіРѕС‚РѕРІС‹Рµ 3D-РїРѕР·РёС†РёРё (РіР»РѕР±СѓСЃ: С‚РѕС‡РєРё СЌР»Р»РёРїСЃРѕРёРґР°).
            // Р‘РµР· РЅРёС… СЃС‚СЂРѕРёРј РїР»РѕСЃРєРѕСЃС‚СЊ (x, height, z), РєР°Рє СЂР°РЅСЊС€Рµ.
            const wp = data.worldPositions;
            for (let i = 0; i < n; i++) {
                const [wx, wz] = wc[i];
                if (wp) {
                    // Абсолютные мировые координаты: сдвигаем только X/Z на
                    // anchor (меш возвращает их через mesh.position).
                    // Y НЕ трогаем — на глобусе это высота над эллипсоидом,
                    // а mesh.position.y = 0 (иначе Y уехал бы дважды).
                    positions.push(wp[i * 3] - this._anchorX, wp[i * 3 + 1], wp[i * 3 + 2] - this._anchorZ);
                }
                else {
                    positions.push(wx - this._anchorX, heights[i] ?? 0, wz - this._anchorZ);
                }
                pushUV(wx, wz);
            }
            const idx = data.indices;
            for (let t = 0; t < idx.length; t += 3) {
                indices.push(idx[t] + baseVertex, idx[t + 1] + baseVertex, idx[t + 2] + baseVertex);
                triPoly.push(poly);
            }
            if (!isExtruded) {
                colorRanges.push({ poly, start: colorStart, count: positions.length / 3 - colorStart });
                continue;
            }
            // в”Ђв”Ђ BOTTOM в”Ђв”Ђ
            const bottomBase = positions.length / 3;
            for (let i = 0; i < n; i++) {
                const [wx, wz] = wc[i];
                positions.push(wx - this._anchorX, (heights[i] ?? 0) - height, wz - this._anchorZ);
                pushUV(wx, wz);
            }
            for (let t = 0; t < idx.length; t += 3) {
                indices.push(idx[t] + bottomBase, idx[t + 2] + bottomBase, idx[t + 1] + bottomBase);
                triPoly.push(poly);
            }
            // в”Ђв”Ђ SIDES (per-ring) в”Ђв”Ђ
            const ringStarts = (data.ringStarts && data.ringStarts.length > 0) ? data.ringStarts : [0];
            for (let r = 0; r < ringStarts.length; r++) {
                const start = ringStarts[r];
                const end = (r + 1 < ringStarts.length) ? ringStarts[r + 1] : n;
                const count = end - start;
                if (count < 2)
                    continue;
                let sa = 0;
                for (let i = 0; i < count; i++) {
                    const j = (i + 1) % count;
                    const a = wc[start + i];
                    const b = wc[start + j];
                    sa += a[0] * b[1] - b[0] * a[1];
                }
                const flipSides = (sa > 0) !== (r > 0);
                let cum = 0;
                for (let i = 0; i < count; i++) {
                    const j = (i + 1) % count;
                    const idxI = start + i;
                    const idxJ = start + j;
                    const [wxi, wzi] = wc[idxI];
                    const [wxj, wzj] = wc[idxJ];
                    const topI = heights[idxI] ?? 0;
                    const topJ = heights[idxJ] ?? 0;
                    const quadBase = positions.length / 3;
                    positions.push(wxi - this._anchorX, topI, wzi - this._anchorZ);
                    positions.push(wxi - this._anchorX, topI - height, wzi - this._anchorZ);
                    positions.push(wxj - this._anchorX, topJ, wzj - this._anchorZ);
                    positions.push(wxj - this._anchorX, topJ - height, wzj - this._anchorZ);
                    const ddx = wxj - wxi;
                    const ddz = wzj - wzi;
                    const edgeLen = Math.sqrt(ddx * ddx + ddz * ddz);
                    const u0 = cum / patternScale;
                    const u1 = (cum + edgeLen) / patternScale;
                    const vH = height / patternScale;
                    uvs.push(u0, vH, u0, 0, u1, vH, u1, 0);
                    cum += edgeLen;
                    if (!flipSides) {
                        indices.push(quadBase, quadBase + 1, quadBase + 2);
                        indices.push(quadBase + 1, quadBase + 3, quadBase + 2);
                    }
                    else {
                        indices.push(quadBase, quadBase + 2, quadBase + 1);
                        indices.push(quadBase + 1, quadBase + 2, quadBase + 3);
                    }
                    triPoly.push(poly, poly);
                }
            }
            colorRanges.push({
                poly,
                start: colorStart,
                count: positions.length / 3 - colorStart,
            });
        }
        this._trianglesToPolygon = triPoly;
        // Кэшируем полный диапазон вершин полигона (TOP + BOTTOM + sides),
        // чтобы recolor() не запрашивал его геометрию заново.
        this._colorRanges = colorRanges;
        // Вершинные цвета: заливка каждого полигона в батче задаётся своими
        // цветами, поэтому перекраска не требует пересборки геометрии.
        // Цвета сторон extruded-полигонов оставляем белыми/neutral как раньше.
        const colors = new Float32Array(positions.length).fill(1);
        const cc = new THREE.Color();
        for (const range of colorRanges) {
            cc.set(range.poly._fillColor ?? 0xffffff);
            for (let i = 0; i < range.count; i++) {
                const k = (range.start + i) * 3;
                colors[k] = cc.r;
                colors[k + 1] = cc.g;
                colors[k + 2] = cc.b;
            }
        }
        const geom = new THREE.BufferGeometry();
        geom.setAttribute('position', new THREE.BufferAttribute(new Float32Array(positions), 3));
        geom.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(uvs), 2));
        geom.setAttribute('color', new THREE.BufferAttribute(colors, 3));
        geom.setIndex(indices);
        // РќРѕСЂРјР°Р»Рё РЅСѓР¶РЅС‹ MeshStandardMaterial (extruded). Р”Р»СЏ MeshBasic
        // РѕРЅРё РЅРµ РёСЃРїРѕР»СЊР·СѓСЋС‚СЃСЏ вЂ” РїСЂРѕРїСѓСЃРєР°РµРј, СЌРєРѕРЅРѕРјРёРј С†РёРєР» РЅР° rebuild.
        if (d0.extruded)
            geom.computeVertexNormals();
        geom.computeBoundingBox();
        geom.computeBoundingSphere();
        // Р•СЃР»Рё Р±СѓРґРµС‚ zoom-Р°РЅРёРјР°С†РёСЏ РїСЂРѕР·СЂР°С‡РЅРѕСЃС‚Рё вЂ” РјР°С‚РµСЂРёР°Р» РґРѕР»Р¶РµРЅ Р±С‹С‚СЊ
        // transparent СЃ СЃР°РјРѕРіРѕ РЅР°С‡Р°Р»Р°, РёРЅР°С‡Рµ Р°РЅРёРјР°С†РёСЏ Рє 0 СЂР°Р±РѕС‚Р°С‚СЊ РЅРµ Р±СѓРґРµС‚.
        const animatedOpacity = !!this._zoomFillOpacity;
        const isTransparent = animatedOpacity || d0.fillOpacity < 1;
        let mat;
        if (d0.extruded) {
            mat = new THREE.MeshStandardMaterial({
                color: 0xffffff,
                vertexColors: true,
                opacity: d0.fillOpacity,
                transparent: isTransparent,
                side: THREE.DoubleSide,
                roughness: d0.roughness,
                metalness: d0.metalness,
                depthTest: d0.depthTest,
                depthWrite: d0.depthWrite,
                polygonOffsetFactor: -1,
                polygonOffset: false,
                polygonOffsetUnits: -1,
                map: this._patternTexture ?? null,
            });
        }
        else {
            mat = new THREE.MeshBasicMaterial({
                color: 0xffffff,
                vertexColors: true,
                opacity: d0.fillOpacity,
                transparent: isTransparent,
                side: THREE.DoubleSide,
                depthTest: d0.depthTest,
                depthWrite: d0.depthWrite,
                polygonOffset: true,
                polygonOffsetFactor: -1,
                polygonOffsetUnits: -1,
                map: this._patternTexture ?? null,
            });
        }
        applyGapMaskToMaterial(mat, this._map);
        this.fillMaterial = mat;
        const mesh = new THREE.Mesh(geom, mat);
        mesh.renderOrder = RENDER_ORDER.TOP;
        mesh.frustumCulled = true;
        if (d0.extruded) {
            mesh.castShadow = d0.castShadow;
            mesh.receiveShadow = d0.receiveShadow;
        }
        // ВАЖНО: на глобусе Y вершин — абсолютная высота над эллипсоидом
        // (его нельзя «сдвигать» в плоскость), поэтому меш ставим в y = 0.
        // На плоскости высоты относительные — сдвигаем на anchorY, как раньше.
        mesh.position.set(this._anchorX, this._usesWorldPositions ? 0 : this._anchorY, this._anchorZ);
        mesh.userData.batchedGroup = this;
        this.mesh = mesh;
        // в”Ђв”Ђ РЁС‚СЂРёС…: LineSegments РїРѕ СЂС‘Р±СЂР°Рј top в”Ђв”Ђ
        if (d0.strokeWidth > 0 && d0.strokeOpacity > 0 && d0.strokeColor != null) {
            const strokePos = [];
            for (const { data } of datas) {
                // Обводка — по контурным вершинам (см. Polygon._getBatchGeometryData).
                const wc = data.strokeWorldCoords ?? data.worldCoords;
                const h = data.strokeHeights ?? data.heights;
                const wpS = data.strokeWorldPositions ?? data.worldPositions;
                const n = wc.length;
                const rs = (data.strokeRingStarts && data.strokeRingStarts.length > 0)
                    ? data.strokeRingStarts
                    : ((data.ringStarts && data.ringStarts.length > 0) ? data.ringStarts : [0]);
                for (let r = 0; r < rs.length; r++) {
                    const start = rs[r];
                    const end = (r + 1 < rs.length) ? rs[r + 1] : n;
                    const count = end - start;
                    if (count < 2)
                        continue;
                    for (let i = 0; i < count; i++) {
                        const j = (i + 1) % count;
                        const a = start + i, b = start + j;
                        if (wpS) {
                            // Глобус: обводка по тем же 3D-точкам, что и заливка.
                            strokePos.push(wpS[a * 3] - this._anchorX, wpS[a * 3 + 1], wpS[a * 3 + 2] - this._anchorZ, wpS[b * 3] - this._anchorX, wpS[b * 3 + 1], wpS[b * 3 + 2] - this._anchorZ);
                        }
                        else {
                            strokePos.push(wc[a][0] - this._anchorX, h[a] ?? 0, wc[a][1] - this._anchorZ, wc[b][0] - this._anchorX, h[b] ?? 0, wc[b][1] - this._anchorZ);
                        }
                    }
                }
            }
            const sGeom = new THREE.BufferGeometry();
            sGeom.setAttribute('position', new THREE.BufferAttribute(new Float32Array(strokePos), 3));
            sGeom.computeBoundingSphere();
            const sMat = new THREE.LineBasicMaterial({
                color: d0.strokeColor,
                opacity: d0.strokeOpacity,
                transparent: animatedOpacity || d0.strokeOpacity < 1,
                depthTest: d0.depthTest,
                depthWrite: d0.depthWrite,
            });
            applyGapMaskToMaterial(sMat, this._map);
            const line = new THREE.LineSegments(sGeom, sMat);
            line.renderOrder = RENDER_ORDER.STROKE;
            line.position.set(this._anchorX, this._usesWorldPositions ? 0 : this._anchorY, this._anchorZ);
            this.strokeLine = line;
            this.strokeMaterial = sMat;
        }
        this._globeBoxCache = null;
        this._globeBoxKey = null;
        const bs = geom.boundingSphere;
        if (bs) {
            this._boundingSphere = {
                center: new THREE.Vector3(this._anchorX + bs.center.x, bs.center.y, this._anchorZ + bs.center.z),
                radius: bs.radius,
            };
        }
        this._registerInteraction(map);
    }
    _registerInteraction(map) {
        if (!map.interaction || !this.mesh)
            return;
        if (this._unregister) {
            this._unregister();
            this._unregister = null;
        }
        this._unregister = map.interaction.register(this, {
            getMeshes: () => this.mesh ? [this.mesh] : [],
            // Р’РѕР·РІСЂР°С‰Р°РµРј С†РµРЅС‚СЂ РІ РњРР РћР’Р«РҐ РєРѕРѕСЂРґРёРЅР°С‚Р°С… вЂ” РІ РѕС‚Р»РёС‡РёРµ РѕС‚
            // РїСЂРµР¶РЅРµР№ РІРµСЂСЃРёРё, РєРѕС‚РѕСЂР°СЏ РѕС‚РґР°РІР°Р»Р° Р»РѕРєР°Р»СЊРЅС‹Рµ (Р±РµР·
            // worldGroup.position). РР·-Р·Р° СЌС‚РѕРіРѕ РєР°Р»Р»РёРЅРі Р»РѕРјР°Р»СЃСЏ
            // РїСЂРё РїР°РЅРѕСЂР°РјРёСЂРѕРІР°РЅРёРё (worldGroup СЃРґРІРёРіР°РµС‚СЃСЏ).
            getBoundingSphere: () => {
                const wgPos = map.worldGroup.position;
                // Глобус: геометрия на эллипсоиде — сфера по мировому боксу мешей
                // (плоский anchor + bs.center не описывает 3D-положение).
                if (map.globe === true && this.mesh) {
                    const mesh = this.mesh;
                    // Кэш мирового бокса: геометрия батча меняется только при
                    // пересборке (build), а сдвиг worldGroup учитываем через
                    // сброс ключа по позиции карты.
                    const key = this._globeBoxKey;
                    const gp = wgPos;
                    if (!this._globeBoxCache || !key
                        || key.x !== gp.x || key.y !== gp.y || key.z !== gp.z
                        || key.geo !== mesh.geometry) {
                        mesh.geometry.computeBoundingBox();
                        const gb = mesh.geometry.boundingBox;
                        if (gb) {
                            mesh.updateMatrixWorld(true);
                            const box = this._globeBox || (this._globeBox = new THREE.Box3());
                            const c = this._globeCorner || (this._globeCorner = new THREE.Vector3());
                            box.makeEmpty();
                            for (const x of [gb.min.x, gb.max.x])
                                for (const y of [gb.min.y, gb.max.y])
                                    for (const z of [gb.min.z, gb.max.z]) {
                                        c.set(x, y, z).applyMatrix4(mesh.matrixWorld);
                                        box.expandByPoint(c);
                                    }
                            if (!box.isEmpty()) {
                                const center = this._boundingSphereWorldCenter;
                                box.getCenter(center);
                                const size = this._globeSize || (this._globeSize = new THREE.Vector3());
                                this._globeBoxCache = { center: center.clone(), radius: box.getSize(size).length() * 0.5 };
                            }
                            else {
                                this._globeBoxCache = null;
                            }
                        }
                        else {
                            this._globeBoxCache = null;
                        }
                        this._globeBoxKey = { x: gp.x, y: gp.y, z: gp.z, geo: mesh.geometry };
                    }
                    if (this._globeBoxCache) {
                        const cached = this._globeBoxCache;
                        this._boundingSphereWorldCenter.copy(cached.center);
                        return { center: this._boundingSphereWorldCenter, radius: cached.radius };
                    }
                }
                if (!this._boundingSphere)
                    return null;
                this._boundingSphereWorldCenter.set(this._boundingSphere.center.x + wgPos.x, this._boundingSphere.center.y + wgPos.y, this._boundingSphere.center.z + wgPos.z);
                return {
                    center: this._boundingSphereWorldCenter,
                    radius: this._boundingSphere.radius,
                };
            },
            isVisible: () => this.mesh?.visible ?? false,
            onClick: (event) => {
                const poly = this._pickPolygon(event, map);
                if (poly && poly._onClick)
                    poly._onClick(event, poly);
            },
        });
    }
    _pickPolygon(event, map) {
        if (!this.mesh)
            return null;
        const canvas = map.renderer.domElement;
        const rect = canvas.getBoundingClientRect();
        const ndcX = ((event.clientX - rect.left) / rect.width) * 2 - 1;
        const ndcY = -((event.clientY - rect.top) / rect.height) * 2 + 1;
        const rc = map._tempRaycaster;
        const mouse = map._tempMouse;
        rc.setFromCamera(mouse.set(ndcX, ndcY), map.camera);
        const hits = rc.intersectObject(this.mesh, false);
        if (hits.length === 0)
            return null;
        const faceIdx = hits[0].faceIndex;
        if (faceIdx == null)
            return null;
        return this._trianglesToPolygon[faceIdx] ?? null;
    }
    /**
     * Перекраска без пересборки геометрии: обновляет только вершинные цвета.
     * Полигоны, у которых сменился цвет заливки, передаются через
     * `poly.fillColor` (поле читается из `_getBatchGeometryData()`).
     *
     * @returns `true`, если цвета удалось обновить; `false` — если геометрия
     *          ещё не построена (тогда нужна пересборка).
     */
    recolor() {
        const geom = this.mesh?.geometry;
        const attr = geom?.getAttribute?.('color');
        if (!attr)
            return false;
        const cc = new THREE.Color();
        let changed = false;
        for (const range of this._colorRanges) {
            // Fill color stored on the Polygon; do not rebuild batch geometry.
            // Используем только цвет объекта: вызов _getBatchGeometryData здесь
            // запрещён, потому что на глобусе он повторно проецирует все вершины.
            cc.set(range.poly._fillColor ?? 0xffffff);
            for (let i = 0; i < range.count; i++) {
                const k = (range.start + i) * 3;
                if (attr.array[k] !== cc.r || attr.array[k + 1] !== cc.g
                    || attr.array[k + 2] !== cc.b) {
                    attr.array[k] = cc.r;
                    attr.array[k + 1] = cc.g;
                    attr.array[k + 2] = cc.b;
                    changed = true;
                }
            }
        }
        if (changed)
            attr.needsUpdate = true;
        return true;
    }
    update(map, layerVisible) {
        if (!this.mesh)
            return;
        const z = map.continuousZoom;
        const visible = layerVisible && z >= this._minZoom && z <= this._maxZoom;
        this.mesh.visible = visible;
        if (this.strokeLine)
            this.strokeLine.visible = visible;
        if (!visible)
            return;
        // Zoom-Р°РЅРёРјР°С†РёСЏ РїСЂРѕР·СЂР°С‡РЅРѕСЃС‚Рё. Р Р°Р±РѕС‚Р°РµС‚ С‚РѕР»СЊРєРѕ РµСЃР»Рё
        // BatchGeometryData.zoomInterpolations Р±С‹Р» РїРµСЂРµРґР°РЅ Polygon'РѕРј.
        if (this._zoomFillOpacity) {
            const [z0, o0] = this._zoomFillOpacity[0];
            const [z1, o1] = this._zoomFillOpacity[1];
            const t = (z <= z0) ? 0 : (z >= z1) ? 1 : (z - z0) / (z1 - z0 || 1);
            const opMul = o0 + (o1 - o0) * t;
            const fillOp = this._baseFillOpacity * opMul;
            const strokeOp = this._baseStrokeOpacity * opMul;
            if (this.fillMaterial && this.fillMaterial.opacity !== fillOp) {
                this.fillMaterial.opacity = fillOp;
            }
            if (this.strokeMaterial && this.strokeMaterial.opacity !== strokeOp) {
                this.strokeMaterial.opacity = strokeOp;
            }
        }
    }
    dispose() {
        if (this._disposed)
            return;
        this._disposed = true;
        if (this._unregister) {
            try {
                this._unregister();
            }
            catch { /* swallow */ }
            this._unregister = null;
        }
        if (this.mesh) {
            this.mesh.geometry?.dispose();
            this.mesh.material?.dispose();
            if (this.mesh.parent)
                this.mesh.parent.remove(this.mesh);
        }
        if (this.strokeLine) {
            this.strokeLine.geometry?.dispose();
            this.strokeLine.material?.dispose();
            if (this.strokeLine.parent)
                this.strokeLine.parent.remove(this.strokeLine);
        }
        // РџР°С‚С‚РµСЂРЅ РќР• РЅР°С€ вЂ” РёРј РІР»Р°РґРµРµС‚ PolygonBatcher (РєСЌС€ РїРѕ URL).
        this._patternTexture = null;
        this.mesh = null;
        this.strokeLine = null;
        this.fillMaterial = null;
        this.strokeMaterial = null;
        this._trianglesToPolygon = [];
        this._boundingSphere = null;
        this._boundingSphereWorldCenter = null;
    }
}
// =====================================================================
// PolygonBatcher
// =====================================================================
export class PolygonBatcher {
    _layer;
    _map = null;
    _group;
    _batches = new Map();
    _polygonToBatch = new Map();
    _patternTextures = new Map();
    _pendingRebuild = false;
    _dirtyTime = 0;
    _lastCheckTime = 0;
    _checkInterval = 2000;
    /** Последние известные размеры для дешёвой проверки _shouldRebuild. */
    _lastObjectCount = -1;
    _lastBatchedCount = -1;
    _debounceMs = 100;
    /** Пересборка откладывается, пока камера движется: нужно «тихо» idleMs. */
    _idleMs = 250;
    /** Предел отсрочки: даже при непрерывном движении пересобрать через maxDeferMs. */
    _maxDeferMs = 1500;
    _lastMoveTime = 0;
    _lastScreenDirtyTime = 0;
    _lastZoom = undefined;
    _lastWG = null;
    _lastCam = null;
    _disposed = false;
    constructor(layer) {
        this._layer = layer;
        this._group = new THREE.Group();
    }
    /**
     * Перекрашивает все батчи без пересборки геометрии.
     *
     * Полигоны в батче рисуются одним мешем с вершинными цветами, поэтому
     * смена цвета заливки (например, при переходе к другому показателю
     * картограммы) обновляет только атрибут `color` и не трогает
     * триангуляцию — в отличие от {@link markDirty}, который пересобирает
     * батчи целиком.
     */
    recolorAll() {
        if (this._disposed)
            return;
        for (const batch of this._batches.values())
            batch.recolor();
    }
    addTo(map) {
        this._map = map;
        if (this._group.parent !== map.worldGroup) {
            this._group.parent?.remove(this._group);
            map.worldGroup.add(this._group);
        }
        this.markDirty();
    }
    removeFromMap() {
        for (const batch of this._batches.values()) {
            batch.dispose();
            for (const p of batch.polygons) {
                p._batch = null;
                p._onBatchChange?.(false, null);
            }
        }
        this._batches.clear();
        this._polygonToBatch.clear();
        this._pendingBuild = [];
        this._currentPrep = null;
        this._pendingOld = null;
        if (this._group.parent)
            this._group.parent.remove(this._group);
        this._map = null;
    }
    markDirty() {
        this._pendingRebuild = true;
        this._dirtyTime = performance.now();
    }
    /** РћР±С‰Р°СЏ С‚РµРєСЃС‚СѓСЂР° РїР°С‚С‚РµСЂРЅР° РїРѕ URL (РґР»СЏ РІСЃРµС… Р±Р°С‚С‡РµР№ СЃР»РѕСЏ). */
    _getPatternTexture(url) {
        let tex = this._patternTextures.get(url);
        if (tex)
            return tex;
        const loader = new THREE.TextureLoader();
        loader.setCrossOrigin('anonymous');
        tex = loader.load(url, undefined, undefined, (err) => {
            console.warn('PolygonBatcher: pattern load failed', err);
        });
        tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
        tex.generateMipmaps = false;
        tex.minFilter = THREE.LinearFilter;
        tex.magFilter = THREE.LinearFilter;
        const caps = this._map?.renderer?.capabilities;
        if (caps && typeof caps.getMaxAnisotropy === 'function') {
            try {
                tex.anisotropy = Math.min(16, caps.getMaxAnisotropy());
            }
            catch { /* swallow */ }
        }
        const Ctor = THREE;
        if (Ctor.SRGBColorSpace && !tex.colorSpace)
            tex.colorSpace = Ctor.SRGBColorSpace;
        tex.needsUpdate = true;
        this._patternTextures.set(url, tex);
        return tex;
    }
    update(map, _deltaTime) {
        if (this._disposed || !this._map)
            return;
        const now = performance.now();
        // Отслеживаем движение камеры: пока она движется (вращение/зум),
        // пересборку батчей не запускаем — она синхронная и даёт заикание.
        const zoom = map.continuousZoom;
        const wg = map.worldGroup?.position;
        const camPos = map.camera?.position;
        const moving = this._lastZoom !== undefined && (zoom !== this._lastZoom
            || (wg && this._lastWG && (wg.x !== this._lastWG.x || wg.y !== this._lastWG.y || wg.z !== this._lastWG.z))
            || (camPos && this._lastCam && (camPos.x !== this._lastCam.x || camPos.y !== this._lastCam.y || camPos.z !== this._lastCam.z)));
        this._lastZoom = zoom;
        if (wg)
            this._lastWG = { x: wg.x, y: wg.y, z: wg.z };
        if (camPos)
            this._lastCam = { x: camPos.x, y: camPos.y, z: camPos.z };
        if (moving) {
            this._lastMoveTime = now;
            // Камера сдвинулась: экранные позиции батченных полигонов устарели.
            // Только флаг — без проекций; пересчёт — лениво в getScreenPosition().
            // Флаги ставим один раз на кадр, а не на каждый полигон при каждом
            // движении: при сотнях полигонов это лишний O(N) на кадр.
            if (now - this._lastScreenDirtyTime >= 16) {
                this._lastScreenDirtyTime = now;
                for (const p of this._polygonToBatch.keys())
                    p._screenPosDirty = true;
            }
        }
        if (this._pendingRebuild) {
            // Ждём, пока камера успокоится (`_idleMs`), но не дольше `_maxDeferMs`
            // с момента первой отложенной пересборки — иначе при непрерывной
            // анимации батч никогда не обновится.
            const idle = now - this._lastMoveTime >= this._idleMs;
            const overdue = now - this._dirtyTime >= this._maxDeferMs;
            if ((idle && now - this._dirtyTime >= this._debounceMs) || overdue) {
                this._rebuild();
                this._pendingRebuild = false;
                this._lastCheckTime = now;
            }
        }
        else if (now - this._lastCheckTime >= this._checkInterval) {
            if (this._shouldRebuild())
                this._rebuild();
            this._lastCheckTime = now;
        }
        // Доделываем отложенную сборку батчей по бюджету времени кадра.
        if (this._pendingBuild.length)
            this._pumpRebuild(performance.now());
        const layerVisible = this._layer.visible !== false;
        for (const batch of this._batches.values()) {
            batch.update(map, layerVisible);
        }
    }
    _shouldRebuild() {
        const objects = this._layer._objects ?? [];
        // Дёшево: если состав слоя не менялся по длине и по последнему набору —
        // полный обход (вызов _getBatchStyleKey для каждого объекта) не нужен.
        if (objects.length === this._lastObjectCount && this._polygonToBatch.size === this._lastBatchedCount) {
            return false;
        }
        this._lastObjectCount = objects.length;
        let batchableCount = 0;
        for (const obj of objects) {
            if (!isBatchable(obj))
                continue;
            const key = obj._getBatchStyleKey();
            if (!key)
                continue;
            batchableCount++;
            const expected = this._batches.get(key);
            if (!expected || !expected.polygonSet.has(obj))
                return true;
        }
        const need = batchableCount !== this._polygonToBatch.size;
        this._lastBatchedCount = this._polygonToBatch.size;
        return need;
    }
    /**
     * Пересборка батчей. Групировка по ключу — дешёвая; тяжёлую часть
     * (build: триангуляция, нормали, материалы) не выполняем за один кадр,
     * а раскладываем по кадрам с бюджетом времени (см. _pumpRebuild).
     * Батчи с неизменившимся ключом и составом переиспользуются.
     */
    _rebuild() {
        if (!this._map)
            return;
        const groups = new Map();
        for (const obj of (this._layer._objects ?? [])) {
            if (!isBatchable(obj))
                continue;
            if (obj._userVisible === false)
                continue;
            const key = obj._getBatchStyleKey();
            if (!key)
                continue;
            let arr = groups.get(key);
            if (!arr) {
                arr = [];
                groups.set(key, arr);
            }
            arr.push(obj);
        }
        // Переиспользуем батч, если ключ и состав полигонов не изменились.
        const reuse = new Map();
        for (const [key, polys] of groups) {
            const old = this._batches.get(key);
            if (old && old.polygons.length === polys.length
                && polys.every(p => old.polygonSet.has(p))) {
                reuse.set(key, old);
            }
        }
        // Старые батчи, которые не переиспользуем, — освобождаем.
        const kept = new Set(reuse.values());
        for (const batch of this._batches.values()) {
            if (!kept.has(batch))
                batch.dispose();
        }
        const oldPolygons = new Set(this._polygonToBatch.keys());
        this._batches = reuse;
        this._polygonToBatch.clear();
        for (const batch of reuse.values()) {
            for (const p of batch.polygons)
                this._polygonToBatch.set(p, batch);
        }
        // Незавершённую подготовку старого набора отбрасываем: её ключ устарел.
        // Полигоны из неё, которые больше не покрыты ни одним батчем, должны
        // вернуться к собственной геометрии — иначе они останутся скрытыми.
        const abandoned = [];
        if (this._currentPrep)
            abandoned.push(...this._currentPrep.polys);
        for (const item of this._pendingBuild)
            abandoned.push(...item.polys);
        this._currentPrep = null;
        this._pendingBuild = [];
        // Полигоны, которым нужна новая геометрия (нет переиспользуемого батча).
        for (const [key, polys] of groups) {
            if (reuse.has(key))
                continue;
            if (this._map.hasElevation && polys.some(p => p._altitudeMode === 'clampToGround'))
                continue;
            this._pendingBuild.push({ key, polys });
        }
        this._pendingOld = oldPolygons;
        // Полигоны, которые сейчас вне батчей и вне очереди, отключаем от батча
        // (сами вернут геометрию через _onBatchChange(false) когда очередь пройдёт).
        const queued = new Set();
        for (const item of this._pendingBuild)
            for (const p of item.polys)
                queued.add(p);
        for (const p of abandoned) {
            if (!this._polygonToBatch.has(p) && !queued.has(p)) {
                p._batch = null;
                p._onBatchChange?.(false, null);
            }
        }
        this._pumpRebuild(performance.now());
    }
    /** Очередь батчей, ждущих build(). Обрабатывается по бюджету времени. */
    _pendingBuild = [];
    _pendingOld = null;
    /** Бюджет времени на сборку батчей за кадр, мс. */
    _buildBudgetMs = 6;
    /**
     * Строит батчи из очереди, пока не исчерпан бюджет времени кадра.
     * Остаток переносится на следующие кадры (вызывается из update()).
     */
    /** Батч в процессе инкрементальной подготовки (переживает кадры). */
    _currentPrep = null;
    _pumpRebuild(start) {
        if (!this._map)
            return;
        while (this._currentPrep || this._pendingBuild.length) {
            if (!this._currentPrep) {
                const { key, polys } = this._pendingBuild.shift();
                this._currentPrep = { key, polys, batch: new BatchedGroup(polys) };
            }
            const cur = this._currentPrep;
            // Этап 1: сбор геометрии полигонов по бюджету (тяжёлая триангуляция).
            const remain = this._buildBudgetMs - (performance.now() - start);
            if (!cur.batch.prepareStep(Math.max(0.5, remain)))
                break;
            // Этап 2: сборка GPU-геометрии/материалов (данные уже готовы).
            cur.batch.build(this._map, (url) => this._getPatternTexture(url));
            this._currentPrep = null;
            const batch = cur.batch;
            if (batch.mesh) {
                this._group.add(batch.mesh);
                if (batch.strokeLine)
                    this._group.add(batch.strokeLine);
                this._batches.set(cur.key, batch);
                for (const p of cur.polys) {
                    p._batch = batch;
                    p._onBatchChange?.(true, batch);
                    this._polygonToBatch.set(p, batch);
                }
            }
            if (performance.now() - start >= this._buildBudgetMs)
                break;
        }
        if (!this._pendingBuild.length && !this._currentPrep && this._pendingOld) {
            // Полигоны, которые больше не входят ни в один батч: отвязываем от
            // устаревшего батча и возвращаем собственную геометрию.
            for (const p of this._pendingOld) {
                if (!this._polygonToBatch.has(p)) {
                    p._batch = null;
                    p._onBatchChange?.(false, null);
                }
            }
            this._pendingOld = null;
        }
    }
    dispose() {
        this._disposed = true;
        this.removeFromMap();
        for (const tex of this._patternTextures.values()) {
            try {
                tex.dispose?.();
            }
            catch { /* swallow */ }
        }
        this._patternTextures.clear();
    }
}
import { Layer } from './Layers.js';
if (typeof Layer.setBatcherFactory === 'function') {
    Layer.setBatcherFactory((layer) => new PolygonBatcher(layer));
}
