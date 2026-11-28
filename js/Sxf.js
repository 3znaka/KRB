// Sxf.ts — векторная подложка SXF (ГИС «Панорама») с классификатором RSC.
// Архитектура как у VectorTile: фоновый воркер (sxfWorker.ts) делает парсинг, перевод координат
// и триангуляцию; главный поток получает батчи и строит меши ПОРЦИЯМИ по кадрам, с общим кэшем
// материалов. Одна корневая THREE.Group в worldGroup, POI-подписи через textManager.
import { THREE, Line2, LineMaterial, LineSegmentsGeometry } from './js_TP/tpb.js';
import { parseSxf } from './sxf/sxfParser.js';
import { parseRsc } from './sxf/rscParser.js';
import { rasterizeVectorSymbol } from './sxf/symbolRaster.js';
import { SXF_THEME } from './styles/theme.sxf.js';
import { Sprite } from './Sprite.js';
import { assetUrl } from './assets.js';
import { Projections } from './Projections.js';
const ZOOM_MAX = 24;
/** Сколько пунктов POI создаётся за кадр (при первичной постройке). */
const POI_CHUNK = 60;
/** Бюджет подписей, как у VectorTile: общий лимит и лимит на экранную ячейку. */
const POI_MAX_LABELS = 150;
const POI_GRID_CELL_PX = 128;
const POI_MAX_PER_CELL = 2;
/** Буфер за экраном (px), в котором POI ещё считаются кандидатами. */
const POI_CULL_MARGIN_PX = 250;
/** Минимальный интервал пересчёта бюджета (мс). */
const POI_SYNC_INTERVAL_MS = 150;
// ----------------------------------------------------------------------
// Реестр тем
// ----------------------------------------------------------------------
/** Сравнение списков слоёв (порядок не важен). */
function sameList(a, b) {
    if (a === b)
        return true;
    if (!a || !b || a.length !== b.length)
        return false;
    const s = new Set(a);
    return b.every(x => s.has(x));
}
const SXF_THEMES = { default: SXF_THEME };
/** Регистрация собственной темы под именем (доступна через theme: 'имя'). */
export function registerSxfTheme(name, theme) {
    SXF_THEMES[name] = theme;
}
function resolveSxfTheme(theme) {
    if (theme == null)
        return SXF_THEME;
    if (typeof theme === 'string') {
        const t = SXF_THEMES[theme];
        if (!t)
            throw new Error(`Sxf: неизвестная тема '${theme}'. Доступны: ${Object.keys(SXF_THEMES).join(', ')}`);
        return t;
    }
    return theme;
}
/**
 * CRS листа по паспорту: для СК‑42 (coordSystem = 1, проекция Гаусса–Крюгера = 1)
 * номер зоны берётся из целой части Y (зона·1e6 + ложный восток 500000 + …).
 * Возвращает код EPSG (например 'EPSG:28407') либо null.
 */
export function sheetCrsFromPassport(doc) {
    const p = doc.passport;
    if (p.coordSystem === 1 && p.projection === 1) {
        const y = p.cornersXY[0]?.y ?? 0;
        const zone = Math.floor(y / 1e6);
        if (zone >= 4 && zone <= 32)
            return `EPSG:284${String(zone).padStart(2, '0')}`;
    }
    return null;
}
// ----------------------------------------------------------------------
// Класс
// ----------------------------------------------------------------------
export class Sxf {
    url;
    attributionTitle;
    attributionUrl;
    visible;
    minZoom;
    maxZoom;
    fillOpacity;
    lineWidthMultiplier;
    poiEnabled;
    _includeLayers = null;
    _excludeLayers = null;
    _backgroundOverride = null;
    // ------------------------------------------------------------------
    // Геттеры и сеттеры (по образцу VectorTile)
    // ------------------------------------------------------------------
    /** Белый список слоёв классификатора (visibleLayers у VectorTile). */
    get includeLayers() { return this._includeLayers; }
    set includeLayers(v) { this._setLayerFilter('include', v); }
    /** Чёрный список слоёв классификатора (invisibleLayers у VectorTile). */
    get excludeLayers() { return this._excludeLayers; }
    set excludeLayers(v) { this._setLayerFilter('exclude', v); }
    /** Синонимы VectorTile. */
    get visibleLayers() { return this._includeLayers; }
    set visibleLayers(v) { this._setLayerFilter('include', v); }
    get invisibleLayers() { return this._excludeLayers; }
    set invisibleLayers(v) { this._setLayerFilter('exclude', v); }
    /** Включение POI на лету. */
    get poi() { return this.poiEnabled; }
    set poi(v) { this.setPoi(v); }
    /** Фон: переопределение темы. */
    get backgroundColor() { return this._backgroundOverride ?? this._theme.backgroundColor ?? null; }
    set backgroundColor(v) { this._backgroundOverride = v; }
    /** Текущая тема (только чтение; смена — через setTheme). */
    get theme() { return this._theme; }
    /** Смена темы под именем или объектом. Перестраивает слой. */
    setTheme(theme) {
        this._theme = resolveSxfTheme(theme);
        this._rebuild();
        return this;
    }
    /** Смена прозрачности заливок. */
    setFillOpacity(v) {
        if (this.fillOpacity === v)
            return this;
        this.fillOpacity = v;
        this._rebuildMaterials();
        return this;
    }
    /** Смена множителя толщины линий. */
    setLineWidthMultiplier(v) {
        if (this.lineWidthMultiplier === v)
            return this;
        this.lineWidthMultiplier = v;
        this._rebuildMaterials();
        return this;
    }
    /** Включить/выключить POI. */
    setPoi(v) {
        if (this.poiEnabled === !!v)
            return this;
        this.poiEnabled = !!v;
        if (!this.poiEnabled)
            this._releaseAllPoi();
        else if (this._map)
            this._rebuild();
        return this;
    }
    /** Установка фильтра слоёв (белый/чёрный список). Перестраивает геометрию в воркере. */
    _setLayerFilter(kind, v) {
        const next = v && v.length ? [...v] : null;
        if (kind === 'include') {
            if (sameList(this._includeLayers, next))
                return;
            this._includeLayers = next;
        }
        else {
            if (sameList(this._excludeLayers, next))
                return;
            this._excludeLayers = next;
        }
        if (this._map)
            this._rebuild();
    }
    /** Перестройка геометрии через воркер (без полной перезагрузки файлов). */
    _rebuild() {
        if (!this._map || !this.document)
            return;
        const token = ++this._loadToken;
        this._cancelBuild();
        this._clearGroup();
        this._ready = this._buildAsync(token);
    }
    /** Смена материалов без пересборки геометрии. */
    _rebuildMaterials() {
        for (const m of this._matCache.values())
            m.dispose?.();
        this._matCache.clear();
        if (this._map && this._group)
            this._rebuild();
    }
    /** Распарсенный лист для главного потока (паспорт, CRS). Объекты не хранятся — их строит воркер. */
    document = null;
    /** Классификатор (для имён и слоёв в главном потоке). */
    classifier = null;
    _opts;
    _theme;
    _map = null;
    _rootGroup;
    _group = null;
    _ready = null;
    _sprite = null;
    _sheetCrs = null;
    _sheetBuf = null;
    _clsBuf = null;
    _worker = null;
    _workerUrl = null;
    _requestId = 0;
    _pending = new Map();
    _loadToken = 0;
    _buildQueue = [];
    _buildTask = null;
    /** Кэш материалов: общий для всех объектов слоя (по цвету/толщине/пунктиру). */
    _matCache = new Map();
    _geometries = [];
    _labelSources = [];
    /** Все POI листа. В textManager попадают только выбранные бюджетом. */
    _points = [];
    /** Активные подписи: индекс POI → label. */
    _activePoi = new Map();
    _lastSyncMs = 0;
    _lastSyncCam = { x: NaN, z: NaN, wx: NaN, wz: NaN, zoom: NaN };
    constructor(options = {}) {
        options = {
            ...options,
            url: options.url ?? options.sxfUrl,
            classifierUrl: options.classifierUrl ?? options.rscUrl,
        };
        // codeStyles — синоним styles (переопределения по classCode).
        if (options.codeStyles && !options.styles)
            options = { ...options, styles: options.codeStyles };
        this._opts = options;
        this.url = options.url ?? null;
        this.attributionTitle = options.attributionTitle ?? '';
        this.attributionUrl = options.attributionUrl ?? '';
        this.visible = options.visible ?? true;
        this.minZoom = options.minZoom ?? 0;
        this.maxZoom = options.maxZoom ?? ZOOM_MAX;
        this.fillOpacity = options.fillOpacity ?? 1;
        this.lineWidthMultiplier = options.lineWidthMultiplier ?? 1;
        this.poiEnabled = options.poi ?? true;
        this._includeLayers = (options.includeLayers ?? options.visibleLayers) ?? null;
        this._excludeLayers = (options.excludeLayers ?? options.invisibleLayers) ?? null;
        if (options.backgroundColor)
            this._backgroundOverride = options.backgroundColor;
        this._theme = resolveSxfTheme(options.theme);
        this._rootGroup = new THREE.Group();
        this._rootGroup.visible = this.visible;
        this._rootGroup.renderOrder = options.renderOrder ?? 1_000_000;
    }
    // ------------------------------------------------------------------
    // Жизненный цикл (как VectorTile.addTo / removeFromMap)
    // ------------------------------------------------------------------
    addTo(map) {
        if (this._map)
            this.removeFromMap();
        this._map = map;
        map.worldGroup.add(this._rootGroup);
        const alreadyInLayers = Array.isArray(map.layers) && map.layers.includes(this);
        if (!alreadyInLayers && !map._dynamicLayers.includes(this))
            map._dynamicLayers.push(this);
        this._ready = this._load();
        return this;
    }
    removeFromMap() {
        if (!this._map)
            return;
        this._loadToken++;
        this._cancelBuild();
        this._clearGroup();
        this._rootGroup.parent?.remove(this._rootGroup);
        if (Array.isArray(this._map.layers)) {
            const li = this._map.layers.indexOf(this);
            if (li > -1)
                this._map.layers.splice(li, 1);
        }
        const di = this._map._dynamicLayers.indexOf(this);
        if (di > -1)
            this._map._dynamicLayers.splice(di, 1);
        this._worker?.terminate();
        this._worker = null;
        for (const m of this._matCache.values())
            m.dispose?.();
        this._matCache.clear();
        this._map = null;
    }
    setVisible(visible) {
        this.visible = !!visible;
        this._rootGroup.visible = this.visible;
        if (!this.visible)
            this._removeLabels();
    }
    /** Перезагрузка (после смены url или theme). */
    reload() {
        if (!this._map)
            return;
        this._ready = this._load();
    }
    /** Ожидание окончания загрузки и первой порции построения. */
    ready() {
        return this._ready ?? Promise.resolve();
    }
    // ------------------------------------------------------------------
    // Загрузка
    // ------------------------------------------------------------------
    async _load() {
        const token = ++this._loadToken;
        const o = this._opts;
        const sheetBuf = o.data ?? (o.url ? await fetchBuffer(o.url) : null);
        if (!sheetBuf)
            throw new Error('Sxf: нужен url или data');
        const clsBuf = o.classifierData ?? (o.classifierUrl ? await fetchBuffer(o.classifierUrl) : null);
        if (token !== this._loadToken)
            return;
        this._sheetBuf = sheetBuf;
        this._clsBuf = clsBuf;
        // Главный поток парсит только паспорт и классификатор (дёшево), объекты — в воркере.
        this.document = parseSxf(sheetBuf.slice(0));
        this.classifier = clsBuf ? parseRsc(clsBuf.slice(0)) : null;
        await this._resolveSheetCrs(this.document);
        if (token !== this._loadToken)
            return;
        if (this.poiEnabled && !this._sprite)
            await this._loadSprite();
        if (token !== this._loadToken)
            return;
        await this._buildAsync(token);
    }
    async _loadSprite() {
        try {
            const s = new Sprite(assetUrl('sprite/sprite.json'), assetUrl('sprite/sprite.png'));
            await s.load();
            this._sprite = s;
        }
        catch (err) {
            console.warn('Sxf: спрайт не загружен, POI без иконок', err);
        }
    }
    async _resolveSheetCrs(doc) {
        if (this._opts.crs) {
            this._sheetCrs = this._opts.crs;
            return;
        }
        const code = sheetCrsFromPassport(doc);
        if (!code) {
            this._sheetCrs = this._map.inputCRS;
            return;
        }
        try {
            await Projections.addCrs(code);
        }
        catch { /* уже зарегистрирована */ }
        this._sheetCrs = code;
    }
    // ------------------------------------------------------------------
    // Преобразование: аффин по углам листа (через map.project)
    // ------------------------------------------------------------------
    /**
     * Аффинное преобразование «точка листа → мир карты». В SXF X = север, Y = восток;
     * проекции принимают [восток, север]. Коэффициенты находим по трём углам листа
     * (SW, NW, SE), четвёртый угол (NE) служит проверкой.
     */
    _sheetTransform(doc) {
        const map = this._map;
        const crs = this._sheetCrs;
        const toMap = (xNorth, yEast) => {
            // Точка с метрической СК листа → мир карты.
            const w = map.project([yEast, xNorth], crs);
            return [w[0], w[1]];
        };
        // Углы листа в паспорте уже в метрах СК‑42. Перевод дискрет (deviceToMetric) относится
        // только к объектам листа, поэтому к углам его НЕ применяем.
        const m = doc.passport.cornersXY.map(p => [p.x, p.y]);
        const sw = m[0], nw = m[1], se = m[3];
        const sheetSW = toMap(sw[0], sw[1]);
        const sheetNW = toMap(nw[0], nw[1]);
        const sheetSE = toMap(se[0], se[1]);
        // Метрика: east = y, north = x. Решаем [wx, wz] = A·[east, north] + b
        // Базис: SW → (0,0); SE → +east; NW → +north.
        const eastE = sw[1], northN = sw[0];
        const dEast1 = se[1] - eastE, dNorth1 = se[0] - northN; // SW→SE
        const dEast2 = nw[1] - eastE, dNorth2 = nw[0] - northN; // SW→NW
        const det = dEast1 * dNorth2 - dNorth1 * dEast2;
        if (Math.abs(det) < 1e-9)
            throw new Error('Sxf: вырожденные углы листа');
        // Из мировых векторов SW→SE и SW→NW находим матрицу M (2x2) по обратной к базису.
        const vSE = [sheetSE[0] - sheetSW[0], sheetSE[1] - sheetSW[1]];
        const vNW = [sheetNW[0] - sheetSW[0], sheetNW[1] - sheetSW[1]];
        // M = [vSE vNW] · inv([dEast1 dEast2; dNorth1 dNorth2])
        const inv = [dNorth2 / det, -dEast2 / det, -dNorth1 / det, dEast1 / det];
        // Коэффициенты: wx = a*east + b*north + c ; wz = d*east + e*north + f
        const a = vSE[0] * inv[0] + vNW[0] * inv[2];
        const b = vSE[0] * inv[1] + vNW[0] * inv[3];
        const d = vSE[1] * inv[0] + vNW[1] * inv[2];
        const e = vSE[1] * inv[1] + vNW[1] * inv[3];
        const c = sheetSW[0] - a * eastE - b * northN;
        const f = sheetSW[1] - d * eastE - e * northN;
        return { a, b, c, d, e, f };
    }
    // ------------------------------------------------------------------
    // Воркер
    // ------------------------------------------------------------------
    _ensureWorker() {
        if (this._worker)
            return this._worker;
        // Воркер собирается из модуля sxfWorker.js (ES-модуль в js/sxf/).
        const url = assetUrl('sxf/sxfWorker.js');
        const worker = new Worker(url, { type: 'module' });
        worker.onmessage = (e) => {
            const data = e.data;
            const p = this._pending.get(data?.id);
            if (!p)
                return;
            this._pending.delete(data.id);
            if (data.type === 'error')
                p.reject(new Error(data.message));
            else
                p.resolve(data);
        };
        worker.onerror = (err) => console.error('Sxf worker error:', err);
        this._worker = worker;
        this._workerUrl = url;
        return worker;
    }
    _runWorker(req, transfer) {
        const worker = this._ensureWorker();
        return new Promise((resolve, reject) => {
            this._pending.set(req.id, { resolve, reject });
            worker.postMessage(req, transfer);
        });
    }
    /** Стили по classCode: тема ← слой ← код ← пользовательские (сворачиваем на главном потоке). */
    _styleMap(doc) {
        const out = {};
        const codes = new Set(doc.objects.map(o => o.classCode));
        for (const code of codes) {
            const entry = this.classifier?.objectByCode.get(code);
            const layerName = entry ? (this.classifier.layers.find(l => l.number === entry.layer)?.name ?? null) : null;
            const s = this._styleFor(code, layerName);
            out[code] = { fill: s.fill, stroke: s.stroke, line: s.line, width: s.width, dash: s.dash };
        }
        return out;
    }
    _styleFor(classCode, layerName) {
        const t = this._theme;
        return {
            ...t.defaultStyle,
            ...(layerName ? t.layers[layerName] ?? {} : {}),
            ...(t.codes[classCode] ?? {}),
            ...(this._opts.styles?.[classCode] ?? {}),
        };
    }
    // ------------------------------------------------------------------
    // Асинхронная постройка
    // ------------------------------------------------------------------
    async _buildAsync(token) {
        const doc = this.document;
        const map = this._map;
        if (!doc || !map || !this._sheetBuf)
            return;
        this._clearGroup();
        const transform = this._sheetTransform(doc);
        const id = ++this._requestId;
        const sheetCopy = this._sheetBuf.slice(0);
        const clsCopy = this._clsBuf ? this._clsBuf.slice(0) : undefined;
        const req = {
            type: 'build',
            id,
            sheet: sheetCopy,
            classifier: clsCopy,
            transform,
            styles: this._styleMap(doc),
            defaultStyle: { ...this._theme.defaultStyle },
            poi: this.poiEnabled,
            includeLayers: this._includeLayers,
            excludeLayers: this._excludeLayers,
        };
        const transfer = [sheetCopy];
        if (clsCopy)
            transfer.push(clsCopy);
        const result = await this._runWorker(req, transfer);
        if (token !== this._loadToken || !this._map)
            return;
        this._applyResult(result);
    }
    /** Порционная постройка: батчи и POI создаются частями по кадрам, без блокировки рендера. */
    _applyResult(res) {
        const group = new THREE.Group();
        group.renderOrder = this._rootGroup.renderOrder;
        this._rootGroup.add(group);
        this._group = group;
        const chunk = this._opts.chunkSize ?? 8;
        const jobs = [];
        for (const f of res.fills)
            jobs.push(() => this._addFillBatch(group, f));
        for (const l of res.lines)
            jobs.push(() => this._addLineBatch(group, l));
        this._scheduleChunks(jobs, chunk, () => this._addPoiChunked(res.points));
    }
    _scheduleChunks(jobs, perFrame, done) {
        this._cancelBuild();
        let i = 0;
        const step = () => {
            this._buildTask = null;
            for (let k = 0; k < perFrame && i < jobs.length; k++, i++)
                jobs[i]();
            if (i < jobs.length)
                this._buildTask = requestAnimationFrame(step);
            else
                done();
        };
        if (jobs.length === 0) {
            done();
            return;
        }
        this._buildTask = requestAnimationFrame(step);
    }
    _cancelBuild() {
        if (this._buildTask != null) {
            cancelAnimationFrame(this._buildTask);
            this._buildTask = null;
        }
    }
    // ------------------------------------------------------------------
    // Материалы (общий кэш) и меши
    // ------------------------------------------------------------------
    _fillMaterial(color) {
        const key = `fill:${color}:${this.fillOpacity}`;
        let m = this._matCache.get(key);
        if (!m) {
            m = new THREE.MeshBasicMaterial({
                color: parseInt(color.replace('#', ''), 16),
                side: THREE.DoubleSide,
                transparent: this.fillOpacity < 1,
                opacity: this.fillOpacity,
                depthWrite: false,
            });
            this._matCache.set(key, m);
        }
        return m;
    }
    _lineMaterial(color, width, dash) {
        const key = `line:${color}:${width}:${dash ? dash.join(',') : ''}`;
        let m = this._matCache.get(key);
        if (!m) {
            const canvas = this._map.renderer.domElement;
            const opts = {
                color: parseInt(color.replace('#', ''), 16),
                linewidth: Math.max(0.5, width * this.lineWidthMultiplier),
                resolution: new THREE.Vector2(canvas.clientWidth, canvas.clientHeight),
                depthTest: false,
                depthWrite: false,
            };
            if (dash && dash.length >= 2) {
                opts.dashed = true;
                opts.dashSize = dash[0];
                opts.gapSize = dash[1];
                opts.dashScale = 1;
            }
            m = new LineMaterial(opts);
            this._matCache.set(key, m);
        }
        return m;
    }
    _addFillBatch(group, f) {
        const geom = new THREE.BufferGeometry();
        geom.setAttribute('position', new THREE.BufferAttribute(f.positions, 3));
        geom.setIndex(new THREE.BufferAttribute(f.indices, 1));
        geom.computeBoundingSphere();
        this._geometries.push(geom);
        const mesh = new THREE.Mesh(geom, this._fillMaterial(f.color));
        mesh.renderOrder = 10;
        group.add(mesh);
    }
    _addLineBatch(group, l) {
        if (l.segments.length < 6)
            return;
        const geom = new LineSegmentsGeometry();
        geom.setPositions(l.segments);
        this._geometries.push(geom);
        const mat = this._lineMaterial(l.color, l.width, l.dash);
        const line = new Line2(geom, mat);
        if (mat.dashed)
            line.computeLineDistances?.();
        line.renderOrder = 20;
        group.add(line);
    }
    /** Сохраняем все POI листа; в textManager попадают только выбранные бюджетом. */
    _addPoiChunked(points) {
        this._points = this.poiEnabled ? points : [];
        this._lastSyncCam = { x: NaN, z: NaN, wx: NaN, wz: NaN, zoom: NaN };
        this._syncPoiBudget(true);
    }
    /**
     * Бюджет подписей по принципу VectorTile (без тайлов):
     *  1) кандидаты — POI в экране с буфером POI_CULL_MARGIN_PX;
     *  2) сортировка по расстоянию до центра экрана;
     *  3) не больше POI_MAX_PER_CELL в экранной ячейке и POI_MAX_LABELS всего;
     *  4) в textManager — только выбранные, остальные снимаются.
     */
    _syncPoiBudget(force = false) {
        const map = this._map;
        const tm = map?.textManager;
        if (!tm || !this.poiEnabled || this._points.length === 0) {
            this._releaseAllPoi();
            return;
        }
        const now = performance.now();
        const cam = map.camera;
        const zoom = map.currentDiscreteZoom ?? 0;
        const pos = cam.position;
        // Панорама двигает worldGroup, а не камеру — учитываем оба сдвига (как VectorTile).
        const wg = map.worldGroup.position;
        const moved = !Number.isFinite(this._lastSyncCam.x) ||
            Math.abs(pos.x - this._lastSyncCam.x) > 1 || Math.abs(pos.z - this._lastSyncCam.z) > 1 ||
            Math.abs(wg.x - this._lastSyncCam.wx) > 1 || Math.abs(wg.z - this._lastSyncCam.wz) > 1 ||
            zoom !== this._lastSyncCam.zoom;
        if (!force && (!moved || now - this._lastSyncMs < POI_SYNC_INTERVAL_MS))
            return;
        this._lastSyncMs = now;
        this._lastSyncCam = { x: pos.x, z: pos.z, wx: wg.x, wz: wg.z, zoom };
        const rect = map.renderer.domElement.getBoundingClientRect();
        const W = rect.width, H = rect.height;
        const cx = W / 2, cy = H / 2;
        // 1) экранные координаты и кандидаты
        const cands = [];
        const v = map.getVec3();
        for (let i = 0; i < this._points.length; i++) {
            const p = this._points[i];
            v.set(p.x, 0, p.z).add(map.worldGroup.position);
            const vCam = map.getVec3().copy(v).applyMatrix4(cam.matrixWorldInverse);
            if (vCam.z >= -cam.near)
                continue; // за камерой
            v.project(cam);
            const sx = (v.x * 0.5 + 0.5) * W;
            const sy = (-v.y * 0.5 + 0.5) * H;
            if (sx < -POI_CULL_MARGIN_PX || sx > W + POI_CULL_MARGIN_PX ||
                sy < -POI_CULL_MARGIN_PX || sy > H + POI_CULL_MARGIN_PX)
                continue;
            const d2 = (sx - cx) * (sx - cx) + (sy - cy) * (sy - cy);
            cands.push({ i, sx, sy, d2 });
        }
        // 2) ближе к центру экрана — приоритетнее
        cands.sort((a, b) => a.d2 - b.d2);
        // 3) бюджет: общий лимит и лимит на ячейку сетки
        const cellCounts = new Map();
        const selected = new Set();
        for (const c of cands) {
            if (selected.size >= POI_MAX_LABELS)
                break;
            const key = Math.floor(c.sx / POI_GRID_CELL_PX) + ',' + Math.floor(c.sy / POI_GRID_CELL_PX);
            const n = cellCounts.get(key) ?? 0;
            if (n >= POI_MAX_PER_CELL)
                continue;
            cellCounts.set(key, n + 1);
            selected.add(c.i);
        }
        // 4) снимаем невыбранные, добавляем новые выбранные
        for (const [i, label] of this._activePoi) {
            if (!selected.has(i)) {
                tm.removeLabel(label);
                this._activePoi.delete(i);
            }
        }
        for (const i of selected) {
            if (!this._activePoi.has(i))
                this._activePoi.set(i, this._registerPoi(this._points[i], i));
        }
    }
    _registerPoi(p, idx) {
        // Приоритет: векторный знак из классификатора (canvas) → иконка атласа → без иконки.
        const symbolCanvas = this._symbolCanvas(p.classCode);
        const src = new SxfPoiLabelSource(this._map, p.x, p.z, p.label, {
            iconName: !symbolCanvas && this._sprite ? p.icon : null,
            sprite: this._sprite,
            iconColor: p.color,
            symbolCanvas,
            visible: !!p.label,
        });
        const id = `sxf:${this._rootGroup.uuid}:${idx}`;
        return this._map.textManager.addLabel(src, id, this);
    }
    /** Векторный знак классификатора для classCode, растеризованный в canvas (или null). */
    _symbolCanvas(classCode) {
        const entry = this.classifier?.objectByCode.get(classCode);
        const sym = entry?.style?.symbol;
        if (!sym || sym.kind !== 'vector' || sym.fragments.length === 0)
            return null;
        // Кэш растеризации — только исходник. Каждой подписи отдаём СВОЮ копию canvas:
        // общий элемент переносится appendChild'ом из одной подписи в другую и теряется.
        const src = rasterizeVectorSymbol(String(classCode), sym);
        const copy = document.createElement('canvas');
        copy.width = src.width;
        copy.height = src.height;
        copy.style.width = src.style.width;
        copy.style.height = src.style.height;
        copy.getContext('2d')?.drawImage(src, 0, 0);
        return copy;
    }
    _releaseAllPoi() {
        const tm = this._map?.textManager;
        if (tm)
            for (const label of this._activePoi.values())
                tm.removeLabel(label);
        this._activePoi.clear();
    }
    // ------------------------------------------------------------------
    // Очистка
    // ------------------------------------------------------------------
    _clearGroup() {
        this._cancelBuild();
        this._removeLabels();
        if (this._group) {
            this._rootGroup.remove(this._group);
            this._group = null;
        }
        for (const g of this._geometries)
            g.dispose?.();
        this._geometries = [];
    }
    _removeLabels() {
        this._releaseAllPoi();
        this._labelSources = [];
    }
    // ------------------------------------------------------------------
    // Обновление карты (вызывается из CoreLifecycle, как VectorTile._postUpdate)
    // ------------------------------------------------------------------
    _postUpdate(map) {
        if (!this._map)
            return;
        const z = map.currentDiscreteZoom ?? 0;
        const inRange = z >= this.minZoom && z <= this.maxZoom;
        const show = this.visible && inRange;
        if (this._rootGroup.visible !== show) {
            this._rootGroup.visible = show;
            if (!show)
                this._removeLabels();
        }
        // Бюджет подписей: пересчёт при движении камеры (с троттлингом внутри).
        if (show)
            this._syncPoiBudget();
    }
}
// ----------------------------------------------------------------------
// Вспомогательное
// ----------------------------------------------------------------------
async function fetchBuffer(url) {
    const res = await fetch(url);
    if (!res.ok)
        throw new Error(`Sxf: не загрузилось ${url} (${res.status})`);
    return res.arrayBuffer();
}
/** Источник POI-подписи для textManager (повторяет VectorPointLabelSource из VectorTileLabels). */
class SxfPoiLabelSource {
    map;
    worldPos;
    text;
    options;
    constructor(map, wx, wz, text, options = {}) {
        this.map = map;
        this.worldPos = new THREE.Vector3(wx, 0, wz);
        this.text = text;
        this.options = options;
    }
    getText() { return this.text; }
    getLabelType() { return 'point'; }
    getIcon() {
        // Векторный знак классификатора: готовый canvas отдаём как DOM-элемент (см. TextManager._setupIcon).
        const canvas = this.options.symbolCanvas;
        if (canvas) {
            return {
                cssStyle: {
                    _element: canvas,
                    display: 'block',
                    width: canvas.style.width || `${canvas.width}px`,
                    height: canvas.style.height || `${canvas.height}px`,
                    pointerEvents: 'none',
                },
                offset: [0, 0],
            };
        }
        const name = this.options.iconName;
        if (!name)
            return null;
        return { name, scale: 1, offset: [0, 0], bgColor: this.options.iconColor || null, sprite: this.options.sprite };
    }
    getLabelPosition() { return 'right'; }
    getScreenPosition() {
        const map = this.map;
        const cam = map.camera;
        const v = map.getVec3().copy(this.worldPos).add(map.worldGroup.position);
        const vCam = map.getVec3().copy(v).applyMatrix4(cam.matrixWorldInverse);
        if (vCam.z >= -cam.near)
            return null;
        v.project(cam);
        const rect = map.renderer.domElement.getBoundingClientRect();
        return { x: (v.x * 0.5 + 0.5) * rect.width, y: (-v.y * 0.5 + 0.5) * rect.height };
    }
    getTextStyle() {
        return { color: '#333333', fontSize: '11px', fontFamily: 'sans-serif', fontWeight: 'normal' };
    }
    getPriority() { return 0; }
    getTitleAlign() { return 'center'; }
    getTitleVerticalAlign() { return 'center'; }
    getTitleOffset() { return [0, 0]; }
    getTextZoomBounds() { return { min: 0, max: 24 }; }
    isVisible() { return this.options.visible !== false; }
}
