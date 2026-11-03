import { execSync } from 'node:child_process';
import { cpSync, existsSync, rmSync } from 'node:fs';
import { mkdirSync, readdirSync, copyFileSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';

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
console.log('STEP 4: done' + (tscOk ? '' : ' (with tsc errors!)'));
process.exit(tscOk ? 0 : 1);