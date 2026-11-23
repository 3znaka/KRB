// Тесты переходов между датумами (ГОСТ 32453-2017).
// Запуск: node --test tests/datums.test.mjs
// Перед запуском собирается src/Datums.ts через esbuild во временный файл.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';

const here = path.dirname(fileURLToPath(import.meta.url));
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'krb-datums-'));
const outFile = path.join(tmpDir, 'datums.mjs');

await build({
    entryPoints: [path.join(here, '..', 'src', 'Datums.ts')],
    bundle: true,
    format: 'esm',
    platform: 'node',
    outfile: outFile,
    logLevel: 'silent',
});

const { DATUMS, helmertForward, helmertInverse, convertDatum, getDatum,
    datumFromProj, needsDatumShift } = await import(pathToFileURL(outFile).href);

// Эталон из статьи: центр Москвы, WGS-84, H = 0.
const MSK = { lon: 37.618423, lat: 55.751244 };
const WGS_ECEF = [2849770.029, 2196078.480, 5248904.819];
const PZ90_ECEF = [2849769.858, 2196078.568, 5248904.872];

function ecefWgs84(lon, lat, h = 0) {
    const a = 6378137;
    const f = 1 / 298.257223563;
    const e2 = 2 * f - f * f;
    const la = (lat * Math.PI) / 180;
    const lo = (lon * Math.PI) / 180;
    const N = a / Math.sqrt(1 - e2 * Math.sin(la) ** 2);
    return [
        (N + h) * Math.cos(la) * Math.cos(lo),
        (N + h) * Math.cos(la) * Math.sin(lo),
        (N * (1 - e2) + h) * Math.sin(la),
    ];
}

test('WGS-84 → ECEF совпадает с эталоном статьи (до 1 мм)', () => {
    const xyz = ecefWgs84(MSK.lon, MSK.lat);
    xyz.forEach((v, i) => assert.ok(Math.abs(v - WGS_ECEF[i]) < 1e-3, `ось ${i}: ${v}`));
});

test('WGS-84 → ПЗ-90.11 по формуле (20) совпадает с эталоном (до 1 мм)', () => {
    const pz = helmertForward(WGS_ECEF, DATUMS.wgs84.toPZ90);
    pz.forEach((v, i) => assert.ok(Math.abs(v - PZ90_ECEF[i]) < 1e-3, `ось ${i}: ${v}`));
});

test('обратный переход (21) возвращает исходные координаты', () => {
    const pz = helmertForward(WGS_ECEF, DATUMS.wgs84.toPZ90);
    const back = helmertInverse(pz, DATUMS.wgs84.toPZ90);
    back.forEach((v, i) => assert.ok(Math.abs(v - WGS_ECEF[i]) < 1e-6, `ось ${i}`));
});

// Допуск 1 мм: обратная формула (21) — приближение первого порядка по
// малым параметрам (m, повороты), остаточная невязка ~5e-5 м для СК-42.
// Это точность самой модели ГОСТ, а не баг; строгий 1e-6 м здесь не достижим.
test('прямой и обратный переход взаимно обратны для СК-42 (до 1 мм)', () => {
    const p = DATUMS.sk42.toPZ90;
    const x = [2849770, 2196078, 5248905];
    const back = helmertInverse(helmertForward(x, p), p);
    back.forEach((v, i) => assert.ok(Math.abs(v - x[i]) < 1e-3, `ось ${i}: ${v - x[i]}`));
});

test('ПЗ-90.11 — опорный датум, перевод в себя тождественен', () => {
    const r = convertDatum([MSK.lon, MSK.lat, 0], DATUMS.pz90, DATUMS.pz90);
    assert.equal(r[0], MSK.lon);
    assert.equal(r[1], MSK.lat);
});

test('convertDatum WGS-84 → WGS-84 тождественен', () => {
    const r = convertDatum([MSK.lon, MSK.lat, 0], DATUMS.wgs84, DATUMS.wgs84);
    assert.deepEqual(r, [MSK.lon, MSK.lat, 0]);
});

test('ГСК-2011: смещение к WGS-84 около 0.2 м, а не 30 см и не 0', () => {
    const r = convertDatum([MSK.lon, MSK.lat, 0], DATUMS.wgs84, DATUMS.gsk2011);
    const dLat = (r[1] - MSK.lat) * 111_000;
    const dLon = (r[0] - MSK.lon) * 111_000 * Math.cos((MSK.lat * Math.PI) / 180);
    const dist = Math.hypot(dLat, dLon);
    assert.ok(dist > 0.05 && dist < 0.5, `расхождение ${dist.toFixed(3)} м вне ожидаемого диапазона`);
});

test('datumFromProj: ГСК-2011 по +ellps, WGS-84 и неоднозначные — без датума', () => {
    assert.equal(datumFromProj('+proj=longlat +ellps=GSK2011 +no_defs')?.key, 'gsk2011');
    assert.equal(datumFromProj('+proj=longlat +datum=WGS84')?.key, 'wgs84');
    // Krassovsky неоднозначен (СК-42 или СК-95) — датум не выводим.
    assert.equal(datumFromProj('+proj=longlat +ellps=krass'), null);
    assert.equal(needsDatumShift('+proj=longlat +datum=WGS84'), false);
    assert.equal(needsDatumShift('+proj=longlat +ellps=GSK2011'), true);
});

test('getDatum распознаёт алиасы PROJ', () => {
    assert.equal(getDatum('GSK-2011')?.key, 'gsk2011');
    assert.equal(getDatum('krass')?.key, 'sk42');
    assert.equal(getDatum('pz-90.11')?.key, 'pz90');
    assert.equal(getDatum('unknown-datum'), null);
});
