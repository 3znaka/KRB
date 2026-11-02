import { execSync } from 'node:child_process';
import { cpSync, existsSync, rmSync } from 'node:fs';

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

for (const [from, to] of assets) {
  if (!existsSync(from)) {
    console.log('   SKIP ' + from + ' (not found)');
    continue;
  }
  if (existsSync(to)) rmSync(to, { recursive: true, force: true });
  cpSync(from, to, { recursive: true });
  console.log('   OK   ' + from + ' -> ' + to);
}

console.log('STEP 4: done' + (tscOk ? '' : ' (with tsc errors!)'));
process.exit(tscOk ? 0 : 1);