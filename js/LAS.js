/**
 * LAS — облако точек из LAS-файла.
 *
 * Интерфейс как у Marker3D / Area3D: конструктор принимает источник данных
 * (`url`, `file` или `buffer`), загрузка и разбор идут внутри объекта,
 * асинхронно, при присоединении к карте.
 *
 *   new KRB.LAS({ crs: 'EPSG:4978', url: 'cloud.las' }).addTo(map);
 *
 * Опция `crs` обязательна: LAS-файл не хранит систему координат.
 * Для геоцентрических координат (ECEF WGS84) — 'EPSG:4978'.
 *
 * @module LAS
 */
import { PointCloud } from './PointCloud.js';
import { parseLAS } from './LASParser.js';
/** Цвет класса по ASPRS (как в las-viewer). */
const CLASS_COLORS = {
    0: [0.6, 0.6, 0.6], 1: [0.7, 0.7, 0.7], 2: [0.55, 0.4, 0.28], 3: [0.5, 0.75, 0.35],
    4: [0.35, 0.65, 0.25], 5: [0.15, 0.5, 0.15], 6: [0.85, 0.4, 0.35], 7: [0.9, 0.2, 0.2],
    8: [0.9, 0.55, 0.2], 9: [0.2, 0.55, 0.9], 10: [0.5, 0.5, 0.5], 11: [0.35, 0.35, 0.35],
    12: [0.8, 0.8, 0.4],
};
const DEFAULT_MAX_POINTS = 2_500_000;
function rgbToHex(r, g, b) {
    return ((Math.round(r * 255) & 255) << 16) | ((Math.round(g * 255) & 255) << 8) | (Math.round(b * 255) & 255);
}
/** Радуга: t 0..1 → от синего (0) до красного (1). */
function rampHex(t) {
    const c = Math.max(0, Math.min(1, t));
    const hue = (1 - c) * 0.66;
    const k = (n) => { const x = (n + hue * 6) % 6; return Math.max(0, Math.min(1, Math.min(x, 4 - x))); };
    return rgbToHex(k(5), k(3), k(1));
}
export class LAS extends PointCloud {
    _las = null;
    _lasCrs;
    _colorBy;
    _loadSource;
    _maxPoints;
    _fileName = '';
    _loadState = 'idle';
    _loadError = null;
    _onLoad;
    _onError;
    _fitOnLoad;
    constructor(options) {
        if (!options || !options.crs) {
            throw new Error('LAS: опция crs обязательна (LAS-файл не хранит систему координат).');
        }
        if (!options.url && !options.file && !options.buffer) {
            throw new Error('LAS: укажите источник — url, file или buffer.');
        }
        // Пустой облако до загрузки: точки появятся в _applyData.
        super({
            positions: [],
            crs: options.crs,
            mode: options.mode ?? 'simple',
            size: options.size ?? 2,
            opacity: options.opacity ?? 1,
            lodBudget: options.lodBudget,
            altitude: options.altitude,
            altitudeMode: options.altitudeMode ?? 'absolute',
            minZoom: options.minZoom,
            maxZoom: options.maxZoom,
            title: options.title,
            tooltip: options.tooltip,
            properties: options.properties,
            userData: options.userData,
            zoomInterpolate: options.zoomInterpolate,
        });
        this._lasCrs = options.crs;
        this._colorBy = options.colorBy ?? null;
        this._loadSource = { url: options.url, file: options.file, buffer: options.buffer };
        this._maxPoints = options.maxPoints ?? DEFAULT_MAX_POINTS;
        this._userVisible = options.visible ?? true;
        this._onLoad = options.onLoad ?? null;
        this._onError = options.onError ?? null;
        this._fitOnLoad = options.fitOnLoad ?? false;
    }
    // =================================================================
    // Загрузка: запускается при присоединении к карте (как modelUrl у Marker3D)
    // =================================================================
    _onAttached(map) {
        super._onAttached(map);
        if (this._loadState === 'idle' || this._loadState === 'error') {
            this._startLoad();
        }
    }
    async _startLoad() {
        this._loadState = 'loading';
        this._loadError = null;
        try {
            const { url, file, buffer } = this._loadSource;
            let ab;
            if (buffer) {
                ab = buffer;
                this._fileName = this._fileName || 'buffer.las';
            }
            else if (file) {
                ab = await file.arrayBuffer();
                this._fileName = file.name;
            }
            else {
                const res = await fetch(url);
                if (!res.ok)
                    throw new Error(`LAS: не удалось загрузить ${url} (${res.status})`);
                ab = await res.arrayBuffer();
                this._fileName = url.split('/').pop() ?? url;
            }
            // Объект могли отсоединить, пока шла загрузка.
            if (!this._map) {
                this._loadState = 'idle';
                return;
            }
            const data = parseLAS(ab, { maxPoints: this._maxPoints });
            this._applyData(data);
            this._loadState = 'loaded';
            if (!this._title)
                this.setTitle(this._fileName);
            // fitTo — после того, как bbox посчитан (он появляется только при загрузке).
            if (this._fitOnLoad && this._map)
                this._map.fitTo(this);
            this._onLoad?.(this);
        }
        catch (e) {
            this._loadState = 'error';
            this._loadError = e instanceof Error ? e : new Error(String(e));
            if (this._onError)
                this._onError(this._loadError);
            else
                console.error('LAS:', this._loadError);
        }
    }
    /** Применяет разобранные данные: позиции и раскраска в PointCloud. */
    _applyData(data) {
        this._las = data;
        const colorBy = this._colorBy ?? (data.color ? 'rgb' : 'elevation');
        this._colorBy = colorBy;
        const { positions, colors } = LAS._toPointCloudArrays(data, colorBy);
        this.setPositions(positions);
        this.setColors(colors);
    }
    /** Перевод данных разбора в массивы, которые понимает PointCloud. */
    static _toPointCloudArrays(data, colorBy) {
        const n = data.count;
        const pos = data.positions;
        const positions = new Array(n);
        for (let i = 0; i < n; i++)
            positions[i] = [pos[i * 3], pos[i * 3 + 1], pos[i * 3 + 2]];
        const colors = new Array(n);
        if (colorBy === 'rgb' && data.color) {
            const c = data.color;
            for (let i = 0; i < n; i++)
                colors[i] = rgbToHex(c[i * 3], c[i * 3 + 1], c[i * 3 + 2]);
        }
        else if (colorBy === 'classification') {
            for (let i = 0; i < n; i++) {
                const c = CLASS_COLORS[data.classification[i]] ?? [0.75, 0.75, 0.75];
                colors[i] = rgbToHex(c[0], c[1], c[2]);
            }
        }
        else if (colorBy === 'intensity') {
            let mn = Infinity, mx = -Infinity;
            for (let i = 0; i < n; i++) {
                const v = data.intensity[i];
                if (v < mn)
                    mn = v;
                if (v > mx)
                    mx = v;
            }
            const span = mx - mn || 1;
            for (let i = 0; i < n; i++)
                colors[i] = rampHex((data.intensity[i] - mn) / span);
        }
        else { // elevation
            let mn = Infinity, mx = -Infinity;
            for (let i = 0; i < n; i++) {
                const z = pos[i * 3 + 2];
                if (z < mn)
                    mn = z;
                if (z > mx)
                    mx = z;
            }
            const span = mx - mn || 1;
            for (let i = 0; i < n; i++)
                colors[i] = rampHex((pos[i * 3 + 2] - mn) / span);
        }
        return { positions, colors };
    }
    // =================================================================
    // Состояние загрузки
    // =================================================================
    /** Состояние: 'idle' | 'loading' | 'loaded' | 'error'. */
    getLoadState() { return this._loadState; }
    /** Ошибка последней загрузки, либо null. */
    getLoadError() { return this._loadError; }
    // =================================================================
    // Информация о файле
    // =================================================================
    /** Заголовок LAS (версия, формат, bbox, число точек в файле). null до загрузки. */
    getHeader() { return this._las?.header ?? null; }
    /** Число точек, загруженных в облако (после прореживания). */
    getLoadedCount() { return this._las?.count ?? 0; }
    /** Число точек в файле. */
    getTotalCount() { return this._las?.header.total ?? 0; }
    getFileName() { return this._fileName; }
    getCRS() { return this._lasCrs; }
    // =================================================================
    // Раскраска
    // =================================================================
    /**
     * Текущий способ раскраски. До загрузки возвращает режим из опции colorBy
     * (или null, если опция не задана — тогда выберется по наличию RGB в файле).
     */
    getColorBy() { return this._colorBy; }
    /**
     * Перекрасить: 'rgb' (если есть цвет в файле), 'elevation', 'intensity', 'classification'.
     * До загрузки запоминает режим; если файл без RGB, а просят 'rgb', — предупреждает и не меняет.
     */
    setColorBy(mode) {
        if (!this._las) {
            this._colorBy = mode;
            return this;
        }
        if (mode === 'rgb' && !this._las.color) {
            console.warn('LAS.setColorBy: в файле нет RGB-цвета, режим rgb не применён.');
            return this;
        }
        this._colorBy = mode;
        const { colors } = LAS._toPointCloudArrays(this._las, mode);
        this.setColors(colors);
        return this;
    }
    // =================================================================
    // Стиль (сеттеры/геттеры в стиле библиотеки)
    // =================================================================
    setPointSize(size) { this.setSize(size); return this; }
    getPointSize() { return this.getSize(); }
    setBudget(budget) { this.setLodBudget(budget); return this; }
    getBudget() { return this.getLodBudget(); }
}
