// build.bundle.mjs
// Собирает самодостаточный бандл KRB.bundle.min.js (ESM) и KRB.bundle.iife.min.js.
// Все ресурсы (sprite, img, demotiles, draco, customCRS, epsg_defs, исходники воркеров)
// вшиваются внутрь файла — рядом не нужны никакие папки.
//
// Запуск: node build.bundle.mjs   (требует esbuild и уже собранного js/ через build/watch)
//
// Источник: src/bundle-entry.ts. Исходные модули src/*.ts тянут ресурсы через
// src/assets.ts, поэтому в бандле они получают вшитые данные (флаг __KRB_BUNDLED__).

import { build } from 'esbuild';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { resolve, dirname } from 'node:path';

export async function buildBundles() {
    // На новой машине node_modules в src_for_tpb ещё не установлены (папка игнорируется git).
    // Без них шаг 0 упадёт непонятно — даём явную инструкцию.
    if (!existsSync(resolve('src_for_tpb/node_modules/pbf/package.json'))) {
        throw new Error(
            'KRB: не найдены зависимости src_for_tpb. Выполните один раз:\n' +
            '  cd src_for_tpb && npm install'
        );
    }
    mkdirSync(resolve('dist'), { recursive: true });
    const OUT_DIR = resolve('dist');

    // Шаг 0: срез tpb для воркера векторных тайлов (VectorTile + Protobuf).
    // Берётся из src_for_tpb (там же исходники vendor-бандла). Без three.js.
    await build({
        entryPoints: [resolve('src_for_tpb/vendor-entry-worker.js')],
        bundle: true,
        format: 'esm',
        minify: true,
        target: 'es2020',
        legalComments: 'none',
        nodePaths: [resolve('src_for_tpb/node_modules')],
        outfile: resolve(OUT_DIR, 'tpb-worker-slice.min.js'),
        logLevel: 'warning',
    });

    // Файлы, которые в бандл идут как ТЕКСТ (воркеры, wrapper draco).
    // Для них esbuild подставит строку, а не модуль.
    const TEXT_SUFFIX = '?text';

    /**
     * Плагин: разрешает импорты с суффиксом ?text в исходный текст файла.
     * Нужен, чтобы tpb.min.js / earcut.min.js / draco wrapper попали в бандл
     * как строки для Blob-воркеров, а не исполнялись в основном потоке дважды.
     */
    /**
     * Подставляет флаг бандла текстом: globalThis.__KRB_BUNDLED__ → true.
     * define у esbuild не принимает выражения, поэтому используем плагин.
     */
    const bundleFlagPlugin = {
        name: 'bundle-flag',
        setup(b) {
            b.onLoad({ filter: /build-flag\.ts$/ }, (args) => {
                const src = readFileSync(args.path, 'utf8');
                // Единственное место: false /* __KRB_FLAG__ */ → true (только при сборке бандла).
                const contents = src.replace(/false\s*\/\*\s*__KRB_FLAG__\s*\*\//, 'true');
                return { contents, loader: 'ts' };
            });
        },
    };

    const textSuffixPlugin = {
        name: 'text-suffix',
        setup(b) {
            b.onResolve({ filter: /\?text$/ }, (args) => {
                const clean = args.path.slice(0, -TEXT_SUFFIX.length);
                const abs = resolve(args.resolveDir, clean);
                return { path: abs, namespace: 'text-suffix' };
            });
            b.onLoad({ filter: /.*/, namespace: 'text-suffix' }, (args) => {
                const src = readFileSync(args.path, 'utf8');
                return { contents: `export default ${JSON.stringify(src)};`, loader: 'js' };
            });

            // ?gzb64 — файл сжимается gzip и отдаётся как base64-строка.
            // Для epsg_defs.json: ~830 КБ → ~80 КБ gzip → ~105 КБ base64.
            b.onResolve({ filter: /\?gzb64$/ }, (args) => {
                const clean = args.path.slice(0, -'?gzb64'.length);
                return { path: resolve(args.resolveDir, clean), namespace: 'gzb64' };
            });
            b.onLoad({ filter: /.*/, namespace: 'gzb64' }, (args) => {
                const raw = readFileSync(args.path);
                const b64 = gzipSync(raw, { level: 9 }).toString('base64');
                return { contents: `export default ${JSON.stringify(b64)};`, loader: 'js' };
            });
        },
    };

    /**
     * Общие настройки сборки.
     * --define __KRB_BUNDLED__=true включает ветку вшитых ресурсов в assets.ts.
     */
    const common = {
        entryPoints: [resolve('src/bundle-entry.ts')],
        bundle: true,
        minify: true,
        sourcemap: false,
        legalComments: 'none',
        target: 'es2020',
        define: {
            'process.env.NODE_ENV': '"production"',
        },
        // Бинарные и текстовые ресурсы — в data-URI/строки.
        loader: {
            '.png': 'dataurl',
            '.webp': 'dataurl',
            '.svg': 'dataurl',
            '.wasm': 'binary',
            '.json': 'text',
        },
        plugins: [bundleFlagPlugin, textSuffixPlugin],
        logLevel: 'info',
    };

    // Сгенерированный шим для ?text: esbuild сам резолвит 'x.min.js?text'.
    // Импорты воркеров в bundle-entry.ts нужно писать с ?text — см. правки ниже.

    // 1) ESM — основной формат: <script type="module"> или import.
    // metafile нужен для анализа веса (какие модули сколько весят).
    const esmResult = await build({
        ...common,
        format: 'esm',
        outfile: resolve(OUT_DIR, 'KRB.bundle.min.js'),
        metafile: true,
    });
    writeFileSync(resolve(OUT_DIR, 'meta.json'), JSON.stringify(esmResult.metafile, null, 2));

    // 2) IIFE — для обычного <script>, глобальная переменная KRB.
    // import.meta в IIFE недоступен; в бандле он не используется (ресурсы вшиты),
    // поэтому подменяем его на пустой объект.
    await build({
        ...common,
        format: 'iife',
        define: {
            ...common.define,
            'import.meta.url': '""',
        },
        globalName: 'KRB',
        outfile: resolve(OUT_DIR, 'KRB.bundle.iife.min.js'),
    });

    // 3) KRB.geotiff.min.js — ленивый модуль GeoTIFF. Загружается из KRB.bundle.min.js,
    // когда пользователь впервые использует GeoTiffLayer. Лежит рядом с бандлом.
    await build({
        entryPoints: [resolve('src/geotiff-entry.ts')],
        bundle: true,
        format: 'esm',
        minify: true,
        target: 'es2020',
        legalComments: 'none',
        sourcemap: false,
        define: { 'process.env.NODE_ENV': '"production"' },
        loader: { '.json': 'text' },
        plugins: [bundleFlagPlugin, textSuffixPlugin],
        outfile: resolve(OUT_DIR, 'KRB.geotiff.min.js'),
        logLevel: 'warning',
    });

    for (const f of ['KRB.bundle.min.js', 'KRB.bundle.iife.min.js', 'KRB.geotiff.min.js']) {
        const size = statSync(resolve(OUT_DIR, f)).size;
        console.log(`  ${f}: ${(size / 1024 / 1024).toFixed(2)} MB`);
    }
    console.log('done');

}

// Запуск из командной строки: node build.bundle.mjs
import { fileURLToPath } from 'node:url';
if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
    await buildBundles();
}
