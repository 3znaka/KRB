// theme.sxf.ts — тема отображения данных SXF по классификатору RSC (25t05gm).
//
// Стили классификатора (PAR) в большинстве случаев не задают реальных заливок и обводок,
// поэтому цвета подобраны по названиям объектов (см. N-37-004-V-b.codes.json).
// Ключ — classCode (число). Значение — стиль:
//   fill   — цвет заливки площади (SQR);
//   stroke — цвет обводки площади/линии;
//   line   — цвет линии (LIN/VEC);
//   width  — толщина линии, пиксели;
//   dash   — пунктир [штрих, пробел] в пикселях;
//   poi    — ключ POI (см. sxfPoi.ts) для точечных объектов (DOT).
// Для объектов без явного стиля применяется defaultStyle по локализации.

import type { SxfTheme } from './types.js';

const C = {
    water:    { fill: '#a9d2f0', stroke: '#599cd2' },
    forest:   { fill: '#c5dac2', stroke: '#6b9a5e' },
    grass:    { fill: '#dbeccf', stroke: '#8fb37a' },
    urban:    { fill: '#e6e0d6', stroke: '#8a8074' },
    road:     { fill: '#fdfdfd', stroke: '#7a7a7a' },
    rail:     { fill: '#e4e4e4', stroke: '#545454' },
    building: { fill: '#e8d8c8', stroke: '#6e5f50' },
    industry: { fill: '#e8e0c4', stroke: '#8a7d5a' },
    sport:    { fill: '#d4eec4', stroke: '#5a8f4a' },
    sand:     { fill: '#f4ecc8', stroke: '#b8a470' },
    bog:      { fill: '#cfd9b8', stroke: '#7d8f5c' },
    relief:   { line: '#a86f3c' },
    border:   { line: '#8e2c8e' },
    grid:     { line: '#8c8c8c' },
    label:    { color: '#333333' },
};

export const SXF_THEME: SxfTheme = {
    name: 'SXF-classifier',
    backgroundColor: '#f7f5ef',

    defaultStyle: {
        fill: '#e4e4e4',
        stroke: '#545454',
        line: '#545454',
        width: 1.2,
    },

    // Группировка по слоям классификатора (имя слоя → стиль по умолчанию для слоя).
    layers: {
        'Гидрография':                       { fill: C.water.fill, stroke: C.water.stroke, line: C.water.stroke, width: 1.6 },
        'Растительность':                    { fill: C.forest.fill, stroke: C.forest.stroke, line: C.forest.stroke, width: 1.0 },
        'Рельеф суши':                       { line: C.relief.line, width: 0.8 },
        'Грунты и лавовые покровы':          { fill: C.sand.fill, stroke: C.sand.stroke, line: C.sand.stroke, width: 1.0 },
        'Дорожная сеть и дорожные соор.':    { fill: C.road.fill, stroke: C.road.stroke, line: C.road.stroke, width: 2.2 },
        'Населенные пункты':                 { fill: C.urban.fill, stroke: C.urban.stroke, line: C.urban.stroke, width: 1.0 },
        'Промышлен.и социальные объекты':    { fill: C.industry.fill, stroke: C.industry.stroke, line: C.industry.stroke, width: 1.0 },
        'Границы и ограждения':              { line: C.border.line, width: 1.4 },
        'Математическая и план.-выс.осн.':   { line: C.grid.line, width: 0.6 },
        'Названия и подписи':                { line: '#333333', width: 0.8 },
        'Объекты для картоиздания':          { fill: C.sport.fill, stroke: C.sport.stroke, line: C.sport.stroke, width: 1.0 },
    },

    // Переопределения по classCode (приоритетнее слоя).
    codes: {
        // Гидрография
        31120000: { fill: '#a9d2f0', stroke: '#599cd2' },   // Озера постоянные
        31132000: { fill: '#a9d2f0', stroke: '#599cd2' },   // Пруды
        31133000: { fill: '#a9d2f0', stroke: '#599cd2' },   // Бассейны
        31410000: { fill: '#a9d2f0', stroke: '#599cd2', line: '#599cd2', width: 2.2 }, // Реки и ручьи
        31431120: { line: '#599cd2', width: 1.4, dash: [4, 2] },                    // Каналы/канавы
        31432200: { line: '#599cd2', width: 1.0, dash: [3, 3] },                    // Канавы сухие
        32110000: { fill: '#e4e4e4', stroke: '#545454' },   // Плотины
        32140000: { line: '#545454', width: 1.6 },          // Набережные бетонные
        // Растительность
        71100000: { fill: '#c5dac2', stroke: '#6b9a5e' },   // Древесная растительность
        71111120: { fill: '#b9d2b0', stroke: '#6b9a5e' },   // Леса густые низкорослые
        71113000: { fill: '#d4e6c8', stroke: '#8fb37a' },   // Поросль леса
        71323000: { fill: '#e6f2d8', stroke: '#8fb37a' },   // Парники/теплицы
        71610000: { line: '#545454', width: 1.0, dash: [6, 3] }, // Просеки
        71630000: { fill: '#dcefcf', stroke: '#8fb37a' },   // Поляны
        // Дорожная сеть
        45200000: { fill: '#d2e9ff', stroke: '#7a9cc0' },   // Улицы (площадь)
        61111000: { line: '#545454', width: 1.6 },          // Ж/д широкой колеи
        61121000: { line: '#545454', width: 1.2 },          // Станционные пути
        61210000: { line: '#e89a2e', width: 3.4 },          // Автомагистрали
        61220000: { line: '#e8b25a', width: 2.8 },          // Усовершенствованные шоссе
        61230000: { line: '#f2c06b', width: 2.6 },          // Шоссе действующие
        61310000: { line: '#f7d89b', width: 2.0 },          // Улучшенный грунт
        61320000: { line: '#8a7d5a', width: 1.4 },          // Грунтовые проселочные
        61330000: { line: '#8a7d5a', width: 1.0, dash: [4, 3] }, // Полевые/лесные
        61420000: { line: '#8a7d5a', width: 0.9, dash: [2, 3] }, // Тропы
        62110000: { fill: '#dcdcdc', stroke: '#545454' },   // Депо
        62120000: { fill: '#dcdcdc', stroke: '#545454' },   // Вокзалы
        62311000: { line: '#7a7a7a', width: 3.0 },          // Мосты
        62312000: { line: '#7a7a7a', width: 3.0 },
        62315000: { line: '#7a7a7a', width: 3.0 },
        62317000: { line: '#9a9a9a', width: 1.4, dash: [3, 2] }, // Пешеходные мосты
        62331000: { line: '#9a9a9a', width: 2.0, dash: [5, 3] }, // Туннели
        // Населённые пункты
        42100000: { fill: '#ece4d4', stroke: '#8a8074' },   // Поселки сельского типа
        44200000: { fill: '#c9b9a4', stroke: '#6e5f50' },   // Отдельные строения
        45100000: { fill: '#eee6dd', stroke: '#b1a596' },   // Кварталы редко застроенные
        45160000: { fill: '#e0d4c3', stroke: '#8a8074' },   // Плотно застроенная часть квартала
        45300000: { fill: '#f1ece3', stroke: '#a39788' },   // Площади
        // Промышленность и социальные объекты
        51111000: { fill: '#c8b89a', stroke: '#8a7d5a' },   // Карьеры
        51130000: { fill: '#e8e0c4', stroke: '#8a7d5a' },   // Промышленные предприятия
        53511000: { fill: '#cfd7c2', stroke: '#6e7d5a' },   // Кладбища
        53710000: { fill: '#d4eec4', stroke: '#5a8f4a' },   // Спорт. сооружения
        53711000: { fill: '#c8e8b8', stroke: '#5a8f4a' },   // Стадионы
        53890000: { fill: '#cde9bf', stroke: '#5a8f4a' },   // Парки
        // Грунты
        72250000: { fill: '#f4ecc8', stroke: '#b8a470' },   // Пески
        72310000: { fill: '#cfd9b8', stroke: '#7d8f5c' },   // Болота непроходимые
        // Рельеф
        21200000: { line: '#a86f3c', width: 0.9 },          // Горизонтали основные
        22221000: { line: '#599cd2', width: 1.0, dash: [4, 3] }, // Сухие русла
        // Границы
        81140000: { line: '#8e2c8e', width: 1.8, dash: [8, 3] }, // Граница государства
        82300000: { line: '#545454', width: 1.0, dash: [2, 2] }, // Лёгкие ограждения
        // Математическая основа
        91000000: { line: '#545454', width: 1.0 },          // Рамка листа
        13210000: { line: '#8c8c8c', width: 0.5, dash: [3, 3] }, // Прямоугольная сетка
        13220000: { line: '#8c8c8c', width: 0.5, dash: [3, 3] },
    },
};

export default SXF_THEME;
