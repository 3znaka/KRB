export function resolveStyle(spec, theme) {
    const result = {};
    for (const [layerName, layerStyle] of Object.entries(theme.layers)) {
        result[layerName] = structuredClone(layerStyle);
    }
    const poiSpec = spec.layers.poi;
    const poiStyle = result.poi;
    if (poiSpec?.poiClasses && poiStyle) {
        const iconValues = {};
        const classColors = {};
        for (const [cls, info] of Object.entries(poiSpec.poiClasses)) {
            const icon = theme.poiIconOverrides?.[cls] ?? info.icon ?? cls;
            iconValues[cls] = icon;
            classColors[cls] = theme.poiCategories[info.category] ?? theme.poiCategories.other ?? '#888888';
        }
        poiStyle.iconImage = {
            type: 'match',
            by: 'class',
            values: iconValues,
            _default: theme.poiDefaultIcon ?? 'marker',
        };
        poiStyle.classColors = classColors;
    }
    return result;
}
// Экспортируем «собранный» дефолт — совместим с тем, что раньше лежало
// в vectorTileDefaults.ts.
import { OPENMAPTILES_SPEC } from './spec.openmaptiles.js';
import { LIGHT_THEME } from './theme.light.js';
export const DEFAULT_STYLES = resolveStyle(OPENMAPTILES_SPEC, LIGHT_THEME);
export const LAYER_RENDER_ORDER = LIGHT_THEME.layerOrder;
