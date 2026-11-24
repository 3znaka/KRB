// Декларации для импортов ресурсов, которые в бандле обрабатывает esbuild (build.bundle.mjs).

// Флаг бандла, подставляется esbuild через --define.
declare const __KRB_BUNDLED__: boolean | undefined;

declare module '*.png'  { const src: string; export default src; }
declare module '*.webp' { const src: string; export default src; }
declare module '*.svg'  { const src: string; export default src; }
declare module '*.wasm' { const data: ArrayBuffer; export default data; }
declare module '*.json' { const data: any; export default data; }

// Текстовые импорты (?text) — исходный текст модуля.
declare module '*.min.js?text' { const src: string; export default src; }
declare module '*.js?text'     { const src: string; export default src; }
declare module '*.json?text'   { const src: string; export default src; }
declare module '*.svg?text'    { const src: string; export default src; }
declare module '*.json?gzb64'  { const b64: string; export default b64; }
