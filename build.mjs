// build.mjs
import { execSync } from 'node:child_process';
import { existsSync, rmSync } from 'node:fs';

console.log('STEP 1: cleanup');
if (existsSync('js')) rmSync('js', { recursive: true, force: true });

console.log('STEP 2: tsc');
execSync('npx tsc', { stdio: 'inherit' });

console.log('STEP 3: copy assets');
const assets = [
  ['src/img',            'js/img'],
  ['src/demotiles',      'js/demotiles'],
  ['src/js_TP',          'js/js_TP'],
  ['src/epsg_defs.json', 'js/epsg_defs.json'],
];

for (const [from, to] of assets) {
  if (!existsSync(from)) {
    console.log('   SKIP ' + from + ' (not found)');
    continue;
  }
  // удаляем приёмник, иначе Copy-Item вложит источник внутрь него
  if (existsSync(to)) rmSync(to, { recursive: true, force: true });
  execSync(
    `powershell -NoProfile -Command "Copy-Item -LiteralPath '${from}' -Destination '${to}' -Recurse -Force"`,
    { stdio: 'inherit' }
  );
  console.log('   OK   ' + from + ' -> ' + to);
}

console.log('STEP 4: done');