/**
 * Конвертация SXF + классификатор RSC -> GeoJSON и JSON-таблица соответствия classCode -> name.
 *
 * Использование:
 *   node convert.cjs <файл.sxf> <классификатор.rsc> [папка_вывода]
 *
 * Результат (рядом с исходным SXF или в указанной папке):
 *   <имя>.geojson       — объекты с названиями, слоями и стилями
 *   <имя>.codes.json    — таблица соответствия classCode -> { name, shortName, layer }
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { toGeoJSON } = require('./sxf2geojson.cjs');
const { parseRsc, buildCodeTable } = require('./rsc.cjs');

function toArrayBuffer(buf) {
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
}

function convert(sxfPath, rscPath, outDir) {
  const cls = parseRsc(toArrayBuffer(fs.readFileSync(rscPath)));
  const gj = toGeoJSON(toArrayBuffer(fs.readFileSync(sxfPath)), { includeSemantics: true, classifier: cls });

  const base = path.basename(sxfPath, path.extname(sxfPath));
  const dir = outDir || path.dirname(sxfPath);
  fs.mkdirSync(dir, { recursive: true });

  const geoPath = path.join(dir, base + '.geojson');
  fs.writeFileSync(geoPath, JSON.stringify(gj));

  // Таблица соответствия — только коды, реально встречающиеся в листе (компактнее),
  // плюс отметка, которых нет в классификаторе.
  const full = buildCodeTable(cls);
  const used = new Set(gj.features.map(f => f.properties.classCode));
  const table = {};
  for (const code of [...used].sort((a, b) => a - b)) {
    table[code] = full[code] || { name: null, shortName: null, layer: null };
  }
  const codesPath = path.join(dir, base + '.codes.json');
  fs.writeFileSync(codesPath, JSON.stringify(table, null, 2));

  return { geoPath, codesPath, features: gj.features.length, codes: used.size, missing: Object.values(table).filter(v => !v.name).length };
}

if (require.main === module) {
  const [sxf, rsc, out] = process.argv.slice(2);
  if (!sxf || !rsc) {
    console.error('Использование: node convert.cjs <файл.sxf> <классификатор.rsc> [папка_вывода]');
    process.exit(1);
  }
  const r = convert(sxf, rsc, out);
  console.log(`GeoJSON: ${r.geoPath} (объектов: ${r.features})`);
  console.log(`Коды:    ${r.codesPath} (уникальных кодов: ${r.codes}, без названия: ${r.missing})`);
}

module.exports = { convert };
