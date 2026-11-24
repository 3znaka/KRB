/**
 * Entry самодостаточного бандла KRB.bundle.min.js.
 *
 * Собирается build.bundle.mjs. Здесь:
 *  - регистрируются все ресурсы, вшитые esbuild'ом (sprite, img, demotiles,
 *    customCRS, epsg_defs, draco, исходники воркеров);
 *  - реэкспортируется публичный API из KRB.ts.
 *
 * Файлы ресурсов импортируются через loaders esbuild (см. build.bundle.mjs):
 *   .png/.webp/.svg → dataurl;  .json → text (затем JSON.parse);
 *   .wasm → binary (Uint8Array → ArrayBuffer);  .js (воркеры) → text.
 *
 * @module bundle-entry
 */
import { registerBundledAsset, registerBundledDraco, registerBundledWorkerSources, registerBundledCustomCrs, registerBundledEpsgDefsGz, } from './assets.js';
// ── sprite (VectorTile иконки) ────────────────────────────────────────────
import spriteJsonText from './sprite/sprite.json?text';
import spritePng from './sprite/sprite.png';
// ── Растровые ассеты ─────────────────────────────────────────────────────
import markerPng from './img/marker.png';
// SVG импортируются как текст (?text) и кодируются в base64 ниже:
// dataurl-loader вставляет сырой XML в src, где кавычки/пробелы ломают атрибут.
import logoSvgText from './img/logo.svg?text';
import compassSvgText from './img/compass.svg?text';
import infoSvgText from './img/info.svg?text';
import plusSvgText from './img/plus.svg?text';
import minusSvgText from './img/minus.svg?text';
// ── Демо-тайлы (CoreCoordinates.getTextureUrl('demo')) ───────────────────
import demo1 from './demotiles/1.webp';
import demo2 from './demotiles/2.webp';
import demo3 from './demotiles/3.webp';
import demo4 from './demotiles/4.webp';
import demo5 from './demotiles/5.webp';
import demo6 from './demotiles/6.webp';
import demo7 from './demotiles/7.webp';
import demo8 from './demotiles/8.webp';
import demo9 from './demotiles/9.webp';
import demo10 from './demotiles/10.webp';
import demo11 from './demotiles/11.webp';
import demo12 from './demotiles/12.webp';
import demo13 from './demotiles/13.webp';
import demo14 from './demotiles/14.webp';
import demo15 from './demotiles/15.webp';
import demo16 from './demotiles/16.webp';
import demo17 from './demotiles/17.webp';
import demo18 from './demotiles/18.webp';
import demo19 from './demotiles/19.webp';
import demo20 from './demotiles/20.webp';
import demo21 from './demotiles/21.webp';
import demo22 from './demotiles/22.webp';
import demo23 from './demotiles/23.webp';
import demo24 from './demotiles/24.webp';
// ── Draco ────────────────────────────────────────────────────────────────
import dracoWrapperText from './js_TP/draco/draco_wasm_wrapper.js?text';
import dracoWasm from './js_TP/draco/draco_decoder.wasm';
// ── Воркеры (исходники как строки, ?text) ───────────────────────────────
// Срез для воркера (VectorTile + Protobuf, ~17 КБ) вместо полного tpb (~695 КБ).
// Собирается из src_for_tpb/vendor-entry-worker.js — см. build.bundle.mjs.
import tpbText from '../dist/tpb-worker-slice.min.js?text';
import earcutText from './js_TP/earcut.js?text';
// geotiff.worker.js больше не вшивается в основной бандл: он в KRB.geotiff.min.js
// и отдаётся модулем GeoTIFF (см. geotiff-entry.ts).
// ── Данные CRS ───────────────────────────────────────────────────────────
// epsg_defs.json сжимается gzip и вшивается base64 (см. плагин ?gzb64 в build.bundle.mjs).
import epsgDefsGzB64 from './epsg_defs.json?gzb64';
import adpkp0072 from './customCRS/ADPKP_0072.js';
import esri54052 from './customCRS/ESRI_54052.js';
// Регистрация (выполняется при загрузке модуля, до первого использования API)
registerBundledAsset('img/marker.png', markerPng);
// UTF-8 → base64 (btoa не понимает не-Latin1, поэтому через TextEncoder).
const svgDataUrl = (text) => {
    const bytes = new TextEncoder().encode(text);
    let bin = '';
    for (let i = 0; i < bytes.length; i++)
        bin += String.fromCharCode(bytes[i]);
    return 'data:image/svg+xml;base64,' + btoa(bin);
};
registerBundledAsset('img/logo.svg', svgDataUrl(logoSvgText));
registerBundledAsset('img/compass.svg', svgDataUrl(compassSvgText));
registerBundledAsset('img/info.svg', svgDataUrl(infoSvgText));
registerBundledAsset('img/plus.svg', svgDataUrl(plusSvgText));
registerBundledAsset('img/minus.svg', svgDataUrl(minusSvgText));
registerBundledAsset('sprite/sprite.png', spritePng);
registerBundledAsset('sprite/sprite.json', 'data:application/json;base64,' + btoa(unescape(encodeURIComponent(spriteJsonText))));
const demoTiles = [
    demo1, demo2, demo3, demo4, demo5, demo6, demo7, demo8, demo9, demo10, demo11, demo12,
    demo13, demo14, demo15, demo16, demo17, demo18, demo19, demo20, demo21, demo22, demo23, demo24,
];
demoTiles.forEach((url, i) => registerBundledAsset(`demotiles/${i + 1}.webp`, url));
registerBundledWorkerSources({ tpb: tpbText, earcut: earcutText });
registerBundledDraco({
    wrapperJs: dracoWrapperText,
    wasm: dracoWasm,
});
// Файлы экспортируют спек через `export default {...}`. Регистрируем в форме модуля
// { default: spec } — так же, как его получает динамический import() в обычном режиме.
registerBundledCustomCrs('ADPKP:0072', { default: adpkp0072 });
registerBundledCustomCrs('ESRI:54052', { default: esri54052 });
registerBundledEpsgDefsGz(epsgDefsGzB64);
export * from './KRB.js';
