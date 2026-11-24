# KOROBOK (KRB) Map Engine

<img src="https://3znaka.github.io/KRB/js/img/logo.svg" alt="KOROBOK Logo" width="250">

KRB — библиотека для интерактивных 2D и 3D карт на Three.js. Подходит для рельефа, векторных данных, GeoTIFF, работы с произвольными системами координат и глобуса.

- **Сайт:** [https://mapengine.ru/](https://mapengine.ru/)
- **Документация:** [https://mapengine.ru/docs/](https://mapengine.ru/docs/)

## Подключение

### Одним файлом (рекомендуется)

Достаточно одного импорта. Бандл содержит все ресурсы: иконки, шрифты-спрайты, Draco-декодер, исходники воркеров, данные систем координат.

```html
<link href="./KRB.css" rel="stylesheet">
<script type="module">
  import * as KRB from './KRB.bundle.min.js';
</script>
```

Файлы для загрузки: `dist/KRB.bundle.min.js` и `dist/KRB.css`.

Для GeoTIFF положите рядом с бандлом `dist/KRB.geotiff.min.js`. Он подгружается автоматически при первом использовании `GeoTiffLayer` — подключать его вручную не нужно. Без этого файла GeoTIFF не отобразится, а в консоли появится инструкция.

### Из CDN (исходные ES-модули)

```html
<link href="https://cdn.jsdelivr.net/gh/3znaka/KRB/KRB.css" rel="stylesheet">
<script type="module">
  import * as KRB from 'https://cdn.jsdelivr.net/gh/3znaka/KRB/js/KRB.js';
</script>
```

Зеркало: `https://cdn.mapengine.ru/min/js/KRB.js`.

## Быстрый старт

```html
<div id="map" style="position:absolute; inset:0"></div>
<script type="module">
  import * as KRB from './KRB.bundle.min.js';

  const map = new KRB.Map({
    target: 'map',
    layers: [
      new KRB.Tile({ texture: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png' })
    ],
    view: new KRB.View({ centerLonLat: [37.6178, 55.7558], zoom: 11 })
  });

  new KRB.Marker({
    position: [37.6178, 55.7558],
    title: 'Москва'
  }).addTo(map);
</script>
```

## Возможности

**Карта и вид**
- 2D-карта и 3D-глобус (`globe: true`), наклон и поворот камеры
- Растровые тайлы (`KRB.Tile`), в том числе с рельефом (DEM)
- Векторные тайлы (`KRB.VectorTile`) с оформлением стилями и иконками

**Системы координат**
- Встроенный набор проекций, включая российские (СК-42, СК-95, ГСК-2011)
- Преобразования между датумами по параметрам `towgs84` и данным EPSG
- Добавление своих систем координат: `KRB.crs.add('EPSG:4200')`, PROJ-строки, файлы

**Объекты на карте**
- Маркеры (`KRB.Marker`) и 3D-маркеры с моделями GLB/GLTF, в том числе Draco (`KRB.Marker3D`)
- Полилинии, полигоны, поверхностные полигоны (`KRB.Polyline`, `KRB.Polygon`, `KRB.SurfacePolygon`)
- 3D-области (`KRB.Area3D`), диаграммы (`KRB.Diagram`)
- Векторные линии с визуальными эффектами (`KRB.VectorLineLayer`)
- Движение объектов по пути (`KRB.PathFollower`)
- Сетка координат (`KRB.Graticule`)

**Данные**
- GeoJSON (`KRB.GeoJSONLayer`) с кластеризацией (`KRB.ClusterLayer`) и фильтрацией
- GeoTIFF-растры (`KRB.GeoTiffLayer`), в том числе как рельеф; маска и цветовые шкалы
- Экспорт сцены в GLB (`KRB.exportToGLB`) и GeoJSON

**Взаимодействие**
- Перетаскивание, зум, вращение, события камеры и объектов
- Наведение и клики по объектам, всплывающие подсказки
- Пауза рендера вне видимости вкладки

## Ресурсы и производительность

- Исходные модули (`js/`) и бандл (`dist/`) собираются одной командой `npm run build`
- Бандл самодостаточен: сторонние зависимости (Three.js, earcut, proj4) и данные внутри
- Ленивая загрузка: GeoTIFF-модуль подгружается только при использовании
- Данные систем координат распаковываются при первом обращении к `KRB.crs.add`

## Сборка

```bash
npm install
cd src_for_tpb && npm install && cd ..
npm run build
```

Результат:
- `js/` — ES-модули (для CDN и прямого подключения)
- `dist/KRB.bundle.min.js`, `dist/KRB.bundle.iife.min.js` — самодостаточные бандлы
- `dist/KRB.geotiff.min.js` — ленивый модуль GeoTIFF

Только бандлы, без пересборки `js/`: `node build.bundle.mjs`.

## Лицензия

MIT
