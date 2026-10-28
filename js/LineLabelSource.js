// LineLabelSource.js
import { THREE } from '../js_TP/tpb.js';

const _sharedMeasureCanvas = (() => {
    let c = null;
    return () => (c ??= document.createElement('canvas'));
})();

function _measure(text, fontSize, fontFamily, fontWeight, fontStyle) {
    const ctx = _sharedMeasureCanvas().getContext('2d');
    ctx.font = `${fontStyle || 'normal'} ${fontWeight || 'normal'} ${fontSize || '11px'} ${fontFamily || 'sans-serif'}`;
    return ctx.measureText(text).width;
}

/**
 * Источник подписи для линейных объектов (размещение вдоль линии).
 *
 * Ключевые улучшения по сравнению с предыдущей версией:
 *
 *  1. **Устойчивое определение переворота (isFlipped).**
 *     Вместо угла в начальной точке используется средний угол на всём
 *     протяжении текста. Это исключает «задом наперёд» на изогнутых
 *     линиях и при смене направления.
 *
 *  2. **Гистерезис переворота (text-unflip-range).**
 *     Если текст находится близко к вертикали (угол около ±90°), его
 *     переворот может «дребезжать» при малейшем движении камеры.
 *     Введён допуск: если предыдущее состояние переворота было
 *     зафиксировано и новый угол не выходит за пределы допуска,
 *     состояние сохраняется. Это повторяет логику MapLibre
 *     (`text-unflip-range`) и устраняет мерцание.
 *
 *  3. **Ограничение максимального угла между символами (maxAngle).**
 *     По аналогии с OpenLayers, если на протяжении текста встречается
 *     слишком резкий изгиб (угол между соседними сегментами превышает
 *     `maxAngle`), кандидат отбраковывается. Это предотвращает
 *     «разваливание» текста на острых поворотах.
 *
 *  4. **Кэширование экранных данных.**
 *     Сигнатура кэша расширена: учитываются позиция камеры, смещение
 *     мира, зум и позиция группы. При неизменных параметрах
 *     пересчёт не выполняется.
 *
 *  5. **Ленивое создание кандидатов.**
 *     Кандидаты создаются только по запросу `getCandidates()` и
 *     кэшируются до изменения сигнатуры. TextManager вызывает этот
 *     метод редко (при необходимости поиска новой позиции), а не
 *     каждый кадр.
 *
 *  6. **Совместимость с `text-keep-upright`.**
 *     Флаг `keepUpright` (по умолчанию `true`) управляет тем, можно ли
 *     переворачивать текст. При `false` текст всегда рисуется в
 *     направлении линии, даже если это приводит к «перевёрнутому»
 *     виду.
 */
export class VectorLineLabelSource {
    constructor(map, lineData, group, options = {}) {
        this.map = map;
        this.lineData = lineData;
        this.group = group;

        /** Межтекстовый зазор, × ширины текста. */
        this.tracking       = options.tracking       ?? 1.35;
        /** 'auto' | 'above' | 'below' | 'center' — жёсткая переустановка вертикали. */
        this.placement      = options.placement      ?? 'auto';
        /** 'tile' | 'viewport' — приоритет кандидата. */
        this.priorityMode   = options.priorityMode   ?? 'tile';
        /** «Бонус» ранее выбранному кандидату (px²). */
        this.hysteresisPx   = options.hysteresisPx   ?? 40;
        /** Разрешать ли переворот текста для сохранения читаемости. */
        this.keepUpright    = options.keepUpright    ?? true;
        /**
         * Максимальный угол (в градусах) между соседними сегментами
         * текста. Если изгиб линии превышает это значение, кандидат
         * отбраковывается. По умолчанию 45° (как в OpenLayers).
         */
        this.maxAngle       = options.maxAngle       ?? 45;
        /**
         * Допуск (в градусах) для сохранения предыдущего состояния
         * переворота. Если текст близок к вертикали и предыдущее
         * состояние было зафиксировано, переворот не меняется, пока
         * угол не выйдет за пределы этого допуска. По умолчанию 5°.
         */
        this.unflipRange    = options.unflipRange    ?? 5;

        // Кэш экранных данных.
        this._screenData = null;
        this._screenDataSig = null;

        // Кэш кандидатов.
        this._candidates = null;
        this._candidatesSig = null;

        // Кэш ширин символов.
        this._charWidths = null;

        // Последний выбранный bbox (для гистерезиса позиции).
        this._lastSelectedBBox = null;

        // Последнее зафиксированное состояние переворота (для гистерезиса).
        // Хранится как { flipped: boolean, anchorPx: number }.
        // anchorPx — позиция вдоль линии (в пикселях), к которой относится
        // решение. При изменении позиции якоря более чем на некоторый
        // порог состояние сбрасывается.
        this._lastFlipState = null;
    }

    // ── Публичный API ─────────────────────────────────────────────

    getText()               { return this.lineData.text || ''; }
    getLabelType()          { return 'line-curved'; }
    isVisible()             { return this.lineData.visible !== false; }
    getAllowOverflow()      { return false; }
    getPriority()           { return this.lineData.priority || 0; }
    getPlacement()          { return this.lineData.placement || 'along'; }
    getTextZoomBounds()     { return this.lineData.zoomBounds || { min: 0, max: 24 }; }
    getTitleAlign()         { return 'center'; }
    getTitleVerticalAlign() { return this.lineData.textVerticalAlign || 'middle'; }
    getTitleOffset()        { return this.lineData.textOffset || [0, 0]; }

    getTextStyle() {
        return {
            color: this.lineData.textColor || '#333333',
            fontSize: this.lineData.fontSize || '11px',
            fontFamily: this.lineData.fontFamily || 'sans-serif',
            fontWeight: this.lineData.fontWeight || 'normal',
            textShadow: this.lineData.textShadow || '',
            textTransform: this.lineData.textTransform || '',
            fontStyle: this.lineData.textFontStyle || '',
            letterSpacing: this.lineData.textLetterSpacing || ''
        };
    }

    /**
     * Возвращает массив кандидатов с зафиксированными параметрами `t`.
     * Каждый кандидат содержит:
     *   - `t` — нормализованная позиция начала текста вдоль линии [0..1];
     *   - `isFlipped` — нужно ли рисовать текст в обратном направлении;
     *   - `charLayout` — массив символов с экранными координатами и углами;
     *   - `bbox` — ограничивающий прямоугольник текста в экранных координатах.
     *
     * Метод кэширует результат до изменения сигнатуры (камера, зум,
     * смещение мира, позиция группы).
     *
     * @returns {Array<{t:number, isFlipped:boolean, charLayout:Array, bbox:Object}>}
     */
    getCandidates() {
        const data = this._getScreenData();
        if (!data) return [];
        const cw = this._getCharWidths();
        if (!cw.total) return [];

        const sig = this._candidatesSigKey();
        if (this._candidatesSig === sig && this._candidates) {
            return this._candidates;
        }

        this._candidatesSig = sig;
        this._candidates = this._buildCandidates(data, cw);
        return this._candidates;
    }

    /**
     * Возвращает раскладку символов для заданного `t` и флага разворота.
     * Вызывается TextManager'ом при применении трансформаций.
     * Не кэшируется, так как зависит от конкретного `t`.
     *
     * @param {number} t — нормализованная позиция [0..1].
     * @param {boolean} isFlipped — рисовать ли текст в обратном направлении.
     * @returns {Array<{char:string, x:number, y:number, angle:number, w:number}>|null}
     */
    getCharLayoutAtT(t, isFlipped) {
        const data = this._getScreenData();
        if (!data) return null;
        const cw = this._getCharWidths();
        const startPx = this._tToPx(data, t);
        return this._buildCharLayout(data, cw, startPx, isFlipped);
    }

    // ── Экранные данные ───────────────────────────────────────────

    /**
     * Возвращает (и кэширует) экранное представление линии:
     * точки, длины сегментов, углы, интервал видимости.
     *
     * Сигнатура кэша включает:
     *   - позицию камеры (x, y, z) с точностью до 0.1;
     *   - смещение мира и группы (offX, offZ) с точностью до 0.1;
     *   - непрерывный зум с точностью до 0.1.
     *
     * @returns {Object|null}
     */
    _getScreenData() {
        const cam = this.map.camera;
        const wp = this.map.worldGroup.position;
        const gp = this.group.position;
        const offX = wp.x + gp.x;
        const offZ = wp.z + gp.z;
        const zoom = this.map.continuousZoom;

        const sig =
            cam.position.x.toFixed(1) + ',' +
            cam.position.y.toFixed(1) + ',' +
            cam.position.z.toFixed(1) + '|' +
            offX.toFixed(1) + ',' + offZ.toFixed(1) + '|' +
            zoom.toFixed(1);

        if (this._screenDataSig === sig) return this._screenData;

        this._screenDataSig = sig;
        this._screenData = this._computeScreenData(cam, offX, offZ);
        return this._screenData;
    }

    /**
     * Вычисляет экранные координаты точек линии, длины сегментов,
     * углы и видимый интервал.
     *
     * @param {THREE.Camera} camera
     * @param {number} offX — суммарное смещение мира и группы по X.
     * @param {number} offZ — суммарное смещение мира и группы по Z.
     * @returns {Object|null}
     */
    _computeScreenData(camera, offX, offZ) {
        const pts = this.lineData.points;
        if (!pts || pts.length < 2) return null;

        const n = pts.length;
        const points3D = new Array(n);
        for (let i = 0; i < n; i++) {
            points3D[i] = new THREE.Vector3(pts[i].x + offX, 0, pts[i].z + offZ);
        }

        // Длины сегментов в мировых координатах и параметры t.
        const segLengths = new Array(n - 1);
        let totalLen = 0;
        for (let i = 0; i < n - 1; i++) {
            const d = points3D[i].distanceTo(points3D[i + 1]);
            segLengths[i] = d;
            totalLen += d;
        }
        if (totalLen < 1e-9) return null;

        const pointsT = new Array(n);
        pointsT[0] = 0;
        for (let i = 1; i < n; i++) {
            pointsT[i] = pointsT[i - 1] + segLengths[i - 1] / totalLen;
        }

        const canvas = this.map.renderer.domElement;
        const W = canvas.clientWidth;
        const H = canvas.clientHeight;
        if (W <= 0 || H <= 0) return null;

        // Проекция точек на экран.
        const v = new THREE.Vector3();
        const pointsScreen = new Array(n);
        for (let i = 0; i < n; i++) {
            v.copy(points3D[i]).project(camera);
            pointsScreen[i] = {
                x: (v.x * 0.5 + 0.5) * W,
                y: (-v.y * 0.5 + 0.5) * H,
                z: v.z
            };
        }

        // Длины сегментов в пикселях, углы (сглаженные и «сырые»).
        const segLengthsPx = new Array(n - 1);
        const segAngles = new Array(n - 1);
        const segRawAngles = new Array(n - 1);
        const pointsPx = new Array(n);
        pointsPx[0] = 0;
        let totalLenPx = 0;
        let lastAngle = 0;
        let lastRawAngle = 0;

        for (let i = 0; i < n - 1; i++) {
            const dx = pointsScreen[i + 1].x - pointsScreen[i].x;
            const dy = pointsScreen[i + 1].y - pointsScreen[i].y;
            const len = Math.hypot(dx, dy);
            segLengthsPx[i] = len;
            pointsPx[i + 1] = pointsPx[i] + len;
            totalLenPx += len;

            if (len > 1e-6) {
                lastRawAngle = Math.atan2(dy, dx) * 180 / Math.PI;
                let a = lastRawAngle;
                // Приводим угол к диапазону (-90, 90], чтобы текст
                // всегда читался слева направо или сверху вниз.
                if (a > 90) a -= 180;
                else if (a < -90) a += 180;
                lastAngle = a;
            }
            segAngles[i] = lastAngle;
            segRawAngles[i] = lastRawAngle;
        }
        if (totalLenPx < 1e-6) return null;

        // Определение видимого интервала вдоль линии.
        const samples = 40;
        const probe = { pointsPx, pointsScreen, segAngles, segRawAngles, totalLenPx };
        const flags = [];
        for (let i = 0; i <= samples; i++) {
            const px = (i / samples) * totalLenPx;
            const p = this._samplePx(probe, px);
            flags.push(
                p.z > 0 && p.z < 1 &&
                p.x >= -W * 0.5 && p.x <= W * 1.5 &&
                p.y >= -H * 0.5 && p.y <= H * 1.5
            );
        }
        const firstVisible = flags.indexOf(true);
        if (firstVisible === -1) return null;
        let lastVisible = firstVisible;
        for (let i = flags.length - 1; i >= 0; i--) {
            if (flags[i]) { lastVisible = i; break; }
        }
        const visibleIntervalPx = {
            min: (firstVisible / samples) * totalLenPx,
            max: (lastVisible / samples) * totalLenPx
        };
        if (visibleIntervalPx.max - visibleIntervalPx.min < 10) return null;

        // Центр тайла на экране (используется для приоритизации).
        v.set(offX, 0, offZ).project(camera);
        const tileCenterScreen = {
            x: (v.x * 0.5 + 0.5) * W,
            y: (-v.y * 0.5 + 0.5) * H
        };

        return {
            points3D,
            pointsScreen,
            pointsT,
            pointsPx,
            segLengths,
            segLengthsPx,
            segAngles,
            segRawAngles,
            totalLen,
            totalLenPx,
            visibleIntervalPx,
            tileCenterScreen,
            canvasW: W,
            canvasH: H,
            camera
        };
    }

    /**
     * Возвращает точку и угол на линии для заданного расстояния в пикселях.
     *
     * @param {Object} data — результат `_computeScreenData`.
     * @param {number} px — расстояние вдоль линии в пикселях.
     * @returns {{x:number, y:number, z:number, angle:number}}
     */
    _samplePx(data, px) {
        const { pointsPx, pointsScreen, segAngles } = data;
        const n = pointsPx.length;
        if (px < 0) px = 0;
        if (px > data.totalLenPx) px = data.totalLenPx;

        for (let i = 0; i < n - 1; i++) {
            if (px <= pointsPx[i + 1]) {
                const seg = pointsPx[i + 1] - pointsPx[i];
                const u = seg > 1e-9 ? (px - pointsPx[i]) / seg : 0;
                const s0 = pointsScreen[i];
                const s1 = pointsScreen[i + 1];
                return {
                    x: s0.x + (s1.x - s0.x) * u,
                    y: s0.y + (s1.y - s0.y) * u,
                    z: s0.z + (s1.z - s0.z) * u,
                    angle: segAngles[i]
                };
            }
        }
        const s = pointsScreen[n - 1];
        return { x: s.x, y: s.y, z: s.z, angle: segAngles[n - 2] ?? 0 };
    }

    /**
     * Переводит нормализованную позицию `t` в расстояние в пикселях.
     *
     * @param {Object} data
     * @param {number} t — [0..1].
     * @returns {number}
     */
    _tToPx(data, t) {
        const { pointsT, pointsPx } = data;
        const n = pointsT.length;
        if (t <= 0) return 0;
        if (t >= 1) return data.totalLenPx;
        for (let i = 0; i < n - 1; i++) {
            if (t <= pointsT[i + 1]) {
                const segT = pointsT[i + 1] - pointsT[i];
                const u = segT > 1e-9 ? (t - pointsT[i]) / segT : 0;
                return pointsPx[i] + (pointsPx[i + 1] - pointsPx[i]) * u;
            }
        }
        return data.totalLenPx;
    }

    /**
     * Возвращает «сырой» угол сегмента в заданной точке (без сглаживания).
     *
     * @param {Object} data
     * @param {number} px
     * @returns {number} угол в градусах.
     */
    _getRawAngleAt(data, px) {
        const { pointsPx, segRawAngles } = data;
        const n = pointsPx.length;
        if (px < 0) px = 0;
        if (px > data.totalLenPx) px = data.totalLenPx;

        for (let i = 0; i < n - 1; i++) {
            if (px <= pointsPx[i + 1]) {
                return segRawAngles[i];
            }
        }
        return segRawAngles[n - 2] ?? 0;
    }

    // ── Ширины символов ──────────────────────────────────────────

    /**
     * Вычисляет и кэширует ширины символов с учётом шрифта,
     * размера и межбуквенного интервала.
     *
     * @returns {{text:string, advance:number[], visual:number[], total:number}}
     */
    _getCharWidths() {
        if (this._charWidths) return this._charWidths;

        const rawText = this.lineData.text || '';
        const s = this.getTextStyle();
        const tr = this.lineData.textTransform;
        let text = rawText;
        if (tr === 'uppercase') text = text.toUpperCase();
        else if (tr === 'lowercase') text = text.toLowerCase();

        const fsPx = parseFloat(s.fontSize) || 12;
        let lsPx = 0;
        if (s.letterSpacing) {
            const val = parseFloat(s.letterSpacing) || 0;
            lsPx = s.letterSpacing.endsWith('em') ? val * fsPx : val;
        }

        const advance = [];
        const visual = [];
        let total = 0;
        const len = text.length;

        for (let i = 0; i < len; i++) {
            const ch = text[i];
            let w = _measure(ch, s.fontSize, s.fontFamily, s.fontWeight, s.fontStyle);
            // Для пробела гарантируем минимальную ширину, чтобы он не «схлопывался».
            if (ch === ' ' && w < fsPx * 0.25) w = fsPx * 0.25;
            const isLast = i === len - 1;
            visual.push(w);
            const adv = isLast ? w : w + lsPx;
            advance.push(adv);
            total += adv;
        }

        this._charWidths = { text, advance, visual, total };
        return this._charWidths;
    }

    // ── Кандидаты ────────────────────────────────────────────────

    /**
     * Формирует сигнатуру для кэша кандидатов. Включает:
     *   - сигнатуру экранных данных;
     *   - общую ширину текста;
     *   - параметры размещения (tracking, priorityMode, placement, offset);
     *   - вертикальное выравнивание.
     *
     * @returns {string}
     */
    _candidatesSigKey() {
        return this._screenDataSig + '|' +
            (this._charWidths?.total || 0) + '|' +
            this.tracking + '|' +
            this.priorityMode + '|' +
            (this.lineData.textVerticalAlign || '') + '|' +
            this.placement + '|' +
            JSON.stringify(this.lineData.textOffset || [0, 0]) + '|' +
            this.maxAngle + '|' +
            this.unflipRange;
    }

    /**
     * Создаёт массив кандидатов, равномерно распределённых вдоль линии.
     *
     * Для каждого потенциального положения:
     *   1. Определяется `isFlipped` с учётом среднего угла и гистерезиса.
     *   2. Строится раскладка символов.
     *   3. Вычисляется bbox.
     *   4. Проверяется, не превышает ли изгиб линии допустимый `maxAngle`.
     *
     * Кандидаты сортируются: ближайшие к центру вьюпорта — первыми.
     * Ранее выбранный кандидат получает «бонус» (гистерезис).
     *
     * @param {Object} data — экранные данные.
     * @param {Object} cw — ширины символов.
     * @returns {Array}
     */
_buildCandidates(data, cw) {
    const totalPx = data.totalLenPx;
    if (totalPx < cw.total) return [];

    // ВАЖНО: шаг в нормированной длине, а не в пикселях.
    // Пиксельный шаг делал набор кандидатов зависимым от зума.
    const stepT = 0.05;                      // ~20 кандидатов; можно 0.025 для длинных линий
    const numCandidates = Math.max(1, Math.floor(1 / stepT));

    const candidates = [];
    for (let i = 0; i <= numCandidates; i++) {
        const t = Math.min(1, i * stepT);
        const startPx = this._tToPx(data, t);
        // Текст должен поместиться до конца линии
        if (startPx + cw.total > totalPx) continue;
        // И начинаться не раньше начала
        if (startPx < 0) continue;

        const isFlipped = this._determineFlipState(data, startPx, cw);
        if (this._exceedsMaxAngle(data, startPx, cw)) continue;

        const charLayout = this._buildCharLayout(data, cw, startPx, isFlipped);
        if (!charLayout) continue;

        const bbox = this._charBBox(charLayout);
        if (!bbox) continue;

        candidates.push({ t, isFlipped, charLayout, bbox });
    }

    if (candidates.length === 0) return [];

    // Score: близость к центру экрана, с бонусом кандидату рядом
    // с последним *фактически выбранным* bbox (см. ниже Правка 4).
    const ref = { x: data.canvasW / 2, y: data.canvasH / 2 };
    const baseScore = c => (c.bbox.cx - ref.x) ** 2 + (c.bbox.cy - ref.y) ** 2;
    const last = this._lastSelectedBBox;
    const hystSq = this.hysteresisPx ** 2;

    for (const c of candidates) {
        c._score = baseScore(c);
        if (last && hystSq > 0) {
            const d = (c.bbox.cx - last.cx) ** 2 + (c.bbox.cy - last.cy) ** 2;
            if (d < hystSq) c._score -= hystSq * 0.5;
        }
    }

    candidates.sort((a, b) => a._score - b._score);
    return candidates;    // _lastSelectedBBox обновляется в TextManager, см. Правка 4
}

    /**
     * Определяет, нужно ли переворачивать текст в данной позиции.
     *
     * Логика:
     *   1. Вычисляется «сырой» угол в середине текста (а не в начале).
     *      Это устойчивее для изогнутых линий.
     *   2. Если `keepUpright` выключен — всегда `false`.
     *   3. Если угол попадает в «мёртвую зону» около ±90° и есть
     *      предыдущее зафиксированное состояние, оно сохраняется
     *      (гистерезис `unflipRange`).
     *   4. Иначе: переворот, если абсолютный угол больше 90°.
     *
     * @param {Object} data
     * @param {number} startPx
     * @param {Object} cw
     * @returns {boolean}
     */
_determineFlipState(data, startPx, cw) {
    if (!this.keepUpright) return false;

    const len = cw.visual.length;
    const firstCenterPx = startPx + cw.visual[0] * 0.5;
    const lastCenterPx  = startPx + cw.total - cw.visual[len - 1] * 0.5;

    const first = this._samplePx(data, firstCenterPx);
    const last  = this._samplePx(data, lastCenterPx);

    const dx = last.x - first.x;
    const dy = last.y - first.y;

    // Основной критерий MapLibre: для horizontal — переворачиваем,
    // если первый глиф правее последнего (текст читается R→L).
    let flipped = dx < 0;

    // Гистерезис только в узкой зоне около вертикали:
    // если текст почти вертикальный и мы уже приняли решение — держим его.
    const absDx = Math.abs(dx);
    const absDy = Math.abs(dy);
    const deadZone = Math.sin(this.unflipRange * Math.PI / 180) * absDy;

    if (absDx <= deadZone) {
        const lastState = this._lastFlipState;
        // Валидируем гистерезис: привязываемся к позиции и углу,
        // а не «навсегда».
        if (lastState &&
            Math.abs(lastState.anchorPx - startPx) < cw.total * 0.75) {
            return lastState.flipped;
        }
        // Если позиция сместилась сильно — сбрасываем и решаем заново,
        // но выбираем «читаемое» состояние по умолчанию.
        flipped = false;
    }

    this._lastFlipState = { flipped, anchorPx: startPx };
    return flipped;
}
    /**
     * Проверяет, не превышает ли изгиб линии на протяжении текста
     * допустимый угол `maxAngle`.
     *
     * Идея: проходим по сегментам, которые покрывает текст, и
     * сравниваем углы соседних сегментов. Если разница превышает
     * `maxAngle`, кандидат отбраковывается.
     *
     * @param {Object} data
     * @param {number} startPx
     * @param {Object} cw
     * @returns {boolean} `true`, если изгиб слишком крутой.
     */
    _exceedsMaxAngle(data, startPx, cw) {
        if (this.maxAngle >= 180) return false; // ограничение отключено

        const endPx = startPx + cw.total;
        const { pointsPx, segAngles } = data;
        const n = pointsPx.length;

        // Находим индексы сегментов, пересекаемых текстом.
        let firstSeg = -1;
        let lastSeg = -1;

        for (let i = 0; i < n - 1; i++) {
            const segStart = pointsPx[i];
            const segEnd = pointsPx[i + 1];
            if (segEnd < startPx) continue;
            if (segStart > endPx) break;
            if (firstSeg === -1) firstSeg = i;
            lastSeg = i;
        }

        if (firstSeg === -1 || lastSeg === -1) return false;
        if (firstSeg === lastSeg) return false; // только один сегмент — изгиба нет

        // Сравниваем углы соседних сегментов.
        for (let i = firstSeg; i < lastSeg; i++) {
            const angle1 = segAngles[i];
            const angle2 = segAngles[i + 1];
            let diff = Math.abs(angle2 - angle1);
            if (diff > 180) diff = 360 - diff;
            if (diff > this.maxAngle) {
                return true;
            }
        }

        return false;
    }

    /**
     * Строит раскладку символов вдоль линии для заданной начальной
     * позиции и флага переворота.
     *
     * Каждый символ получает экранные координаты (x, y), угол поворота
     * и ширину. Перпендикулярное смещение (выше/ниже линии) зависит от
     * `textVerticalAlign` и `placement`.
     *
     * @param {Object} data
     * @param {Object} cw
     * @param {number} startPx
     * @param {boolean} isFlipped
     * @returns {Array|null}
     */
 _buildCharLayout(data, cw, startPx, isFlipped) {
    const s = this.getTextStyle();
    const fs = parseFloat(s.fontSize) || 12;
    const [ox, oy] = this.lineData.textOffset || [0, 0];

    let align = this.lineData.textVerticalAlign || 'middle';
    if (this.placement === 'above') align = 'top';
    else if (this.placement === 'below') align = 'bottom';
    else if (this.placement === 'center') align = 'middle';
    let coeff = 0;
    if (align === 'top') coeff = 1;
    else if (align === 'bottom') coeff = -1;
    const perpDist = coeff * fs * 0.7;

    const layout = [];
    let px = startPx;
    const endPx = data.totalLenPx + 1;
    const len = cw.text.length;
    const flipAngleDeg = isFlipped ? 180 : 0;

    for (let i = 0; i < len; i++) {
        const charIndex = isFlipped ? (len - 1 - i) : i;
        if (px > endPx) return null;

        const visualW  = cw.visual[charIndex];
        const advanceW = cw.advance[charIndex];
        const centerPx = px + visualW * 0.5;

        // ВАЖНО: сырой угол сегмента, без нормировки
        const rawDeg = this._getRawAngleAt(data, centerPx);
        const effDeg = rawDeg + flipAngleDeg;
        const rad    = effDeg * Math.PI / 180;

        const p = this._samplePx(data, centerPx);
        if (p.z <= 0 || p.z >= 1) return null;

        const sin = Math.sin(rad);
        const cos = Math.cos(rad);
        const dxp = sin * perpDist;
        const dyp = -cos * perpDist;

        layout.push({
            char: cw.text[charIndex],
            x: p.x + dxp + ox,
            y: p.y + dyp + oy,
            angle: effDeg,
            w: visualW
        });

        px += advanceW;
    }
    return layout;
}

    /**
     * Вычисляет ограничивающий прямоугольник (bbox) для раскладки
     * символов. Учитывает поворот каждого символа.
     *
     * @param {Array} layout — массив символов из `_buildCharLayout`.
     * @returns {{minX:number, minY:number, maxX:number, maxY:number, cx:number, cy:number}|null}
     */
    _charBBox(layout) {
        const s = this.getTextStyle();
        const fs = parseFloat(s.fontSize) || 12;
        let minX = Infinity;
        let minY = Infinity;
        let maxX = -Infinity;
        let maxY = -Infinity;

        for (const c of layout) {
            const rad = c.angle * Math.PI / 180;
            const cos = Math.cos(rad);
            const sin = Math.sin(rad);
            const halfW = c.w * 0.5;
            const halfH = fs * 0.5;

            // Четыре угла символа с учётом поворота.
            const rel = [
                { dx: -halfW, dy: -halfH },
                { dx:  halfW, dy: -halfH },
                { dx:  halfW, dy:  halfH },
                { dx: -halfW, dy:  halfH }
            ];

            for (const p of rel) {
                const x = c.x + p.dx * cos - p.dy * sin;
                const y = c.y + p.dx * sin + p.dy * cos;
                if (x < minX) minX = x;
                if (x > maxX) maxX = x;
                if (y < minY) minY = y;
                if (y > maxY) maxY = y;
            }
        }

        if (!isFinite(minX)) return null;

        return {
            minX,
            minY,
            maxX,
            maxY,
            cx: (minX + maxX) / 2,
            cy: (minY + maxY) / 2
        };
    }
}