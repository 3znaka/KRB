// ─────────────────────────────────────────────────────────────────
// Глобальный реестр форматов
// ─────────────────────────────────────────────────────────────────
const _registry = new Map();
export function registerDownloadFormat(format, handler) {
    _registry.set(format, handler);
}
export function getDownloadFormat(format) {
    return _registry.get(format);
}
// ─────────────────────────────────────────────────────────────────
// Встроенные форматы
// ─────────────────────────────────────────────────────────────────
registerDownloadFormat('geojson', {
    mimeType: 'application/geo+json',
    extension: 'geojson',
    convert(fc) {
        return new Blob([JSON.stringify(fc)], { type: 'application/geo+json' });
    },
});
// ─────────────────────────────────────────────────────────────────
// Downloader
// ─────────────────────────────────────────────────────────────────
export class Downloader {
    _geoJSONExporter;
    constructor(_geoJSONExporter) {
        this._geoJSONExporter = _geoJSONExporter;
    }
    /** Экспорт массива SpatialObject-ов → файл. */
    async download(objects, options = {}) {
        const fc = this._geoJSONExporter.export(objects, options);
        return this.downloadCollection(fc, options);
    }
    /**
     * Скачивание уже готовой FeatureCollection.
     * Полезно для «генераторов» (Graticule, heatmap и т.п.),
     * которым не нужен GeoJSONExporter — они строят FC сами.
     */
    async downloadCollection(featureCollection, options = {}) {
        if ((options.trueScale || options.unitScale != null)
            && featureCollection?.unitScale == null) {
            console.warn('[Downloader] trueScale/unitScale игнорируются в downloadCollection(): ' +
                'коллекция собрана заранее. Масштабируйте на стороне генератора ' +
                '(Graticule._buildFeatureCollection / GeoJSONExporter.export).');
        }
        const format = options.format ?? 'geojson';
        const handler = _registry.get(format);
        if (!handler) {
            throw new Error(`[Downloader] Unknown format "${format}". ` +
                `Registered: ${Array.from(_registry.keys()).join(', ')}`);
        }
        const blob = await handler.convert(featureCollection);
        const filename = ensureExtension(options.filename ?? defaultFilename(), handler.extension);
        triggerDownload(blob, filename);
    }
    async downloadMultiple(groups, options = {}) {
        if (groups.length === 0)
            return;
        const format = options.format ?? 'geojson';
        const handler = _registry.get(format);
        if (!handler) {
            throw new Error(`[Downloader] Unknown format "${format}"`);
        }
        if (handler.convertMany) {
            const blob = await handler.convertMany(groups);
            const filename = ensureExtension(options.filename ?? defaultFilename(), handler.extension);
            triggerDownload(blob, filename);
            return;
        }
        // Fallback: одно скачивание на каждую группу.
        for (const g of groups) {
            const blob = await handler.convert(g.fc);
            const filename = ensureExtension(g.name, handler.extension);
            triggerDownload(blob, filename);
        }
    }
}
// ─────────────────────────────────────────────────────────────────
// Хелперы
// ─────────────────────────────────────────────────────────────────
function ensureExtension(name, ext) {
    const suffix = '.' + ext.toLowerCase();
    return name.toLowerCase().endsWith(suffix) ? name : name + '.' + ext;
}
function defaultFilename() {
    const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    return `export-${ts}`;
}
function triggerDownload(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
}
