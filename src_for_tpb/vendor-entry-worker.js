// Срез для воркера векторных тайлов: только то, что нужно createWorkerCode
// (VectorTile и Protobuf). Без three.js, controls, loaders — их воркер не использует.
// Версии совпадают с vendor-entry.js: @mapbox/vector-tile 1.3.1, pbf 3.2.1.
export { VectorTile } from '@mapbox/vector-tile';
export { default as Protobuf } from 'pbf';
