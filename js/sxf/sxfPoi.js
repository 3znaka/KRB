// sxfPoi.ts — соответствие точечных объектов SXF (classCode) OSM-классам и иконкам атласа sprite.
//
// Иконки берутся только из атласа src/sprite/sprite.json (410 имён). Для объектов без точного
// аналога подобран ближайший по смыслу класс. Коды, которых нет в таблице, получают POI по
// умолчанию (`other`) — маркер без отдельного значка.
export const SXF_POI = {
    // Религиозные объекты
    53420000: { osmClass: 'place_of_worship', icon: 'place_of_worship' }, // Церкви, костёлы, кирхи
    53450000: { osmClass: 'chapel', icon: 'chapel' }, // Часовни
    // Памятники и достопримечательности
    53530000: { osmClass: 'monument', icon: 'monument' }, // Памятники, монументы
    53600000: { osmClass: 'social_facility', icon: 'town_hall' }, // Социально-культурные объекты
    44100000: { osmClass: 'landmark', icon: 'landmark' }, // Отдельные строения выдающиеся
    // Смотровые и природные точки
    12120000: { osmClass: 'peak', icon: 'peak' }, // Отметки высот прочие
    22250000: { osmClass: 'pit', icon: 'mineshaft' }, // Ямы
    34000000: { osmClass: 'island', icon: 'beach' }, // Острова
    31650000: { osmClass: 'spring', icon: 'spring' }, // Фонтаны
    31612000: { osmClass: 'spring', icon: 'spring' }, // Источники необорудованные
    31510000: { osmClass: 'water_point', icon: 'drinking_water' }, // Отметки урезов воды
    31131000: { osmClass: 'reservoir', icon: 'water' }, // Водохранилища
    // Транспорт
    62132000: { osmClass: 'subway_entrance', icon: 'subway' }, // Станции метрополитена
    62133000: { osmClass: 'bus_stop', icon: 'bus_stop' }, // Остановочные пункты
    62136000: { osmClass: 'railway_halt', icon: 'railway' }, // Разъезды, остановочные
    62143000: { osmClass: 'traffic_signals', icon: 'crossing' }, // Семафоры и светофоры
    62144000: { osmClass: 'turntable', icon: 'railway' }, // Поворотные круги
    63300000: { osmClass: 'route_marker', icon: 'marker' }, // Номер автомобильной дороги
    63310000: { osmClass: 'railway_electrified', icon: 'railway' }, // Указатель электрифиц. ж/д
    51220000: { osmClass: 'fuel', icon: 'fuel' }, // Заправочные станции
    62230000: { osmClass: 'parking', icon: 'parking' }, // Стоянки транспорта
    // Промышленность и инфраструктура
    51131000: { osmClass: 'industrial', icon: 'industry' }, // Пром. предприятия с трубами
    51132000: { osmClass: 'industrial', icon: 'industry' }, // Пром. предприятия без труб
    51410000: { osmClass: 'tower', icon: 'tower' }, // Капит. сооружения башенного типа
    51420000: { osmClass: 'chimney', icon: 'tower' }, // Заводские трубы
    51431000: { osmClass: 'tower', icon: 'tower' }, // Вышки лёгкого типа
    51461000: { osmClass: 'substation', icon: 'lighting' }, // Электрические подстанции
    51470000: { osmClass: 'pylon', icon: 'tower' }, // Опоры на ЛЭП, трубопроводах
    53340000: { osmClass: 'communications_tower', icon: 'communications_tower' }, // Мачты
    52100000: { osmClass: 'farm', icon: 'farm' }, // Сельскохозяйственные предприятия
    // Службы и здания
    53610000: { osmClass: 'public_building', icon: 'town_hall' }, // Здания соц-культурного назн.
    53720000: { osmClass: 'sports_centre', icon: 'sports_centre' }, // Спорт. сооружения крытые
    53710000: { osmClass: 'stadium', icon: 'pitch' }, // Спорт. сооружения открытого типа
    53711000: { osmClass: 'stadium', icon: 'pitch' }, // Стадионы
    // Растительность (значки для картоиздания)
    71132100: { osmClass: 'tree', icon: 'garden' }, // Деревья отдельные
    71211200: { osmClass: 'shrub', icon: 'garden' }, // Кустарники
    79714000: { osmClass: 'wood', icon: 'park' }, // Значок редкого высокого леса
    79719000: { osmClass: 'wood', icon: 'park' }, // Значок поросли леса
    79732000: { osmClass: 'scrub', icon: 'garden' }, // Значок кустарника
    79741000: { osmClass: 'reedbed', icon: 'wetland' }, // Значок камыша
    79743000: { osmClass: 'grass', icon: 'garden' }, // Значок низкотравной раст.
    79744000: { osmClass: 'meadow', icon: 'garden' }, // Значок луговой раст.
    // Прочее
    51480000: { osmClass: 'settling_tank', icon: 'waste_basket' }, // Отстойники
    62371000: { osmClass: 'tunnel', icon: 'gate' }, // Туннели (точка)
    91020000: { osmClass: 'place_label', icon: 'marker' }, // Географические названия (точка)
};
/** POI по умолчанию для точечных объектов без записи в SXF_POI. */
export const SXF_POI_DEFAULT = { osmClass: 'other', icon: 'marker' };
/** Иконка для classCode (с учётом значения по умолчанию). */
export function poiFor(classCode) {
    return SXF_POI[classCode] ?? SXF_POI_DEFAULT;
}
