import { execSync } from 'node:child_process';
import {
  existsSync, rmSync, mkdirSync, readdirSync, copyFileSync, statSync,
  readFileSync, writeFileSync,
} from 'node:fs';
import { join, dirname } from 'node:path';

// ── Минификатор ────────────────────────────────────────────────────────────
// Требует: npm i -D esbuild
let transformSync;
try {
  ({ transformSync } = await import('esbuild'));
} catch {
  console.error('\n❌ esbuild не установлен. Выполните: npm i -D esbuild\n');
  process.exit(1);
}

// Папки внутри js/, которые НЕ минифицируем.
// js_TP и customCRS — обычно пользовательский/сторонний код, который
// должен остаться читаемым и редактируемым. Уберите из списка, если хотите
// минифицировать их тоже.
const SKIP_MINIFY = [
  'js/js_TP',
  'js/customCRS',
];

console.log('STEP 1: cleanup');
if (existsSync('js')) rmSync('js', { recursive: true, force: true });

console.log('STEP 2: tsc');
let tscOk = true;
try {
  execSync('node node_modules/typescript/bin/tsc', { stdio: 'inherit' });
} catch (e) {
  tscOk = false;
  console.error('WARN: tsc reported errors, assets will still be copied');
}

console.log('STEP 3: copy assets');
const assets = [
  ['src/img',            'js/img'],
  ['src/sprite',         'js/sprite'],
  ['src/demotiles',      'js/demotiles'],
  ['src/js_TP',          'js/js_TP'],
  ['src/customCRS',      'js/customCRS'],
  ['src/epsg_defs.json', 'js/epsg_defs.json'],
];

function copyDirByFile(srcDir, destDir) {
  mkdirSync(destDir, { recursive: true });
  for (const entry of readdirSync(srcDir, { withFileTypes: true })) {
    const srcPath  = join(srcDir,  entry.name);
    const destPath = join(destDir, entry.name);
    if (entry.isDirectory()) {
      copyDirByFile(srcPath, destPath);
    } else if (entry.isFile()) {
      copyFileSync(srcPath, destPath);
    }
    // симлинки/прочее игнорируем; при необходимости — обработать отдельно
  }
}

for (const [from, to] of assets) {
  let st;
  try {
    st = statSync(from);
  } catch {
    console.log('   SKIP ' + from + ' (not found)');
    continue;
  }

  if (existsSync(to)) rmSync(to, { recursive: true, force: true });

  if (st.isDirectory()) {
    copyDirByFile(from, to);
  } else {
    mkdirSync(dirname(to), { recursive: true });
    copyFileSync(from, to);
  }
  console.log('   OK   ' + from + ' -> ' + to);
}

console.log('STEP 4: minify');
if (!tscOk) {
  console.log('   SKIP (tsc failed — js/ содержит только ассеты)');
} else if (!existsSync('js')) {
  console.log('   SKIP (js/ not found)');
} else {
  // Собираем все исходные .js (исключая уже готовые .min.js).
  function collectJs(dir) {
    const out = [];
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, entry.name);
      if (entry.isDirectory()) {
        out.push(...collectJs(p));
      } else if (entry.isFile() && p.endsWith('.js') && !p.endsWith('.min.js')) {
        out.push(p);
      }
    }
    return out;
  }

  // Переписываем относительные ESM-импорты на .min.js:
  //   from './X.js'       / '../X.js'       / './sub/X.js'
  //   import './X.js'     (side-effect)
  //   import('./X.js')    (dynamic)
  //
  // Замечание: регэксп — эвристика, но для вывода tsc (формат ESM)
  // паттерны стабильные. Не трогает bare specifiers ('lodash', 'https://...').
  function rewriteImports(code) {
    return code
      .replace(/(\bfrom\s*["'])((?:\.{1,2}\/)+[^"']+?)\.js(["'])/g,       '$1$2.min.js$3')
      .replace(/(\bimport\s*["'])((?:\.{1,2}\/)+[^"']+?)\.js(["'])/g,      '$1$2.min.js$3')
      .replace(/(\bimport\s*\(\s*["'])((?:\.{1,2}\/)+[^"']+?)\.js(["'])/g, '$1$2.min.js$3');
  }

  const all = collectJs('js');
  const toMinify = all.filter(
    (f) => !SKIP_MINIFY.some((skip) => f === skip || f.startsWith(skip + '/'))
  );

  let count = 0;
  for (const src of toMinify) {
    const dest = src.replace(/\.js$/, '.min.js');
    const code = readFileSync(src, 'utf8');
    const rewritten = rewriteImports(code);
    try {
      const { code: min } = transformSync(rewritten, {
        loader: 'js',
        format: 'esm',
        target: 'es2020',
        minify: true,
        sourcemap: false,
        legalComments: 'none',
      });
      writeFileSync(dest, min);
      count++;
    } catch (e) {
      console.error('   FAIL ' + src + ': ' + e.message);
    }
  }

  const skippedInfo = SKIP_MINIFY.length
    ? ' (skipped: ' + SKIP_MINIFY.join(', ') + ')'
    : '';
  console.log(`   minified ${count} / ${all.length} files${skippedInfo}`);
}

console.log('STEP 5: done' + (tscOk ? '' : ' (with tsc errors!)'));
process.exit(tscOk ? 0 : 1);