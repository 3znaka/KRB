/**
 * Модуль для создания и управления маркерами на карте.
 * Предоставляет класс {@link Marker} и вспомогательную функцию {@link _getPanes}
 * для получения DOM-панели маркеров.
 *
 * @module marker
 */

import { Projections } from './Projections.js';
import {
  THREE
} from '../js_TP/tpb.js';
import { Layer } from './Layers.js';

/**
 * Слабая карта для хранения привязки панели маркеров к экземпляру карты.
 *
 * @type {WeakMap<Object, {markerPane: HTMLElement}>}
 * @private
 */
const _mapPanes = new WeakMap();

/**
 * URL иконки маркера по умолчанию.
 *
 * @type {string}
 * @private
 * @example
 * const iconUrl = DEFAULT_ICON_URL;
 * console.log(iconUrl);
 */
const DEFAULT_ICON_URL = new URL('./img/marker.png', import.meta.url).href;

/**
 * Возвращает (и при необходимости создаёт) DOM-панель для маркеров,
 * связанную с конкретным экземпляром карты.
 *
 * @param {Object} map - Экземпляр карты.
 * @returns {{markerPane: HTMLElement}} Объект с панелью маркеров.
 * @private
 */
export function _getPanes(map) {
    let panes = _mapPanes.get(map);
    if (!panes) {
        const target = map.targetElement;
        const markerPane = document.createElement('div');
        markerPane.id = 'krb-marker-pane';
        Object.assign(markerPane.style, {
            position: 'absolute', top: '0', left: '0', width: '100%', height: '100%',
            pointerEvents: 'none', zIndex: '600'
        });
        target.appendChild(markerPane);
        panes = { markerPane };
        _mapPanes.set(map, panes);
    }
    return panes;
}

/**
 * Класс, представляющий маркер на карте.
 * Поддерживает иконку, текстовую подпись (через TextManager),
 * кластеризацию, ограничения по зуму и события наведения/клика.
 * Всплывающие подсказки обрабатываются централизованно через PopupManager
 * (доступен как `map.popupManager`).
 *
 * Координаты маркера задаются в системе координат `options.crs`.
 * Если `crs` не указан, используется `map.inputCRS` (по умолчанию WGS84).
 * Внутри карты координаты автоматически преобразуются в метры
 * проекции карты (`map.projection`) через {@link KrbMap#project}.
 *
 * @example
 * // Координаты в WGS84 (по умолчанию)
 * const marker = new Marker({
 *   position: [37.662039, 55.763493],
 *   iconSize: [32, 32],
 *   anchor: [0.5, 1.0],
 *   minZoom: 5,
 *   maxZoom: 18,
 *   altitudeMode: 'absolute',
 *   altitude: 150,
 *   tooltip: '<b>МИИГАиК</b>',
 *   iconUrl: './custom-marker.png',
 *   onHover: (hovered) => console.log('Hover:', hovered),
 *   onClick: (event, marker) => console.log('Clicked:', marker),
 *   title: 'Университет',
 *   titleAlign: 'center',
 *   titleStyle: { color: 'blue', fontSize: '14px' },
 *   titleMinZoom: 8,
 *   titleMaxZoom: 16,
 *   titleOffset: [10, -10],
 *   clusterable: true,
 *   titleAllowOverflow: false,
 *   titlePriority: 5
 * });
 * marker.addTo(map);
 *
 * @example
 * // Координаты в UTM зоне 37N (EPSG:32637)
 * const utmMarker = new Marker({
 *   position: [413500, 6178000],
 *   crs: 'EPSG:32637',
 *   title: 'UTM-точка'
 * });
 * utmMarker.addTo(map);
 */
export class Marker {
    /**
     * Счётчик идентификаторов маркеров.
     *
     * @private
     */
    static _idCounter = 0;

    /**
     * Создаёт новый маркер.
     *
     * @param {Object} options - Настройки маркера.
     * @param {[number, number]} options.position - Координаты [x, y] в СК `options.crs`.
     *     По умолчанию — [долгота, широта] в градусах WGS84.
     * @param {string} [options.crs] - Код системы координат для `position`
     *     (например, 'EPSG:4326', 'EPSG:3857', 'EPSG:32637').
     *     Если не указан — используется `map.inputCRS`.
     *     Перед созданием маркера соответствующая проекция должна быть
     *     зарегистрирована в `Projections` (см. `Projections.ensure`).
     * @param {[number, number]} [options.iconSize=[16,16]] - Размер иконки в пикселях [ширина, высота].
     * @param {[number, number]} [options.anchor=[0.5,1.0]] - Якорь иконки (доли от размера), определяет точку привязки.
     * @param {number} [options.minZoom=-Infinity] - Минимальный зум, при котором маркер виден.
     * @param {number} [options.maxZoom=Infinity] - Максимальный зум, при котором маркер виден.
     * @param {string} [options.altitudeMode='ground'] - Режим высоты: 'ground' (на поверхности), 'clampToGround' (прилеплен к рельефу) или 'absolute' (произвольная высота относительно 0).
     * @param {number} [options.altitude=0] - Высота в метрах. Используется только при altitudeMode='absolute'.
     * @param {string} [options.tooltip=''] - Текст всплывающей подсказки (HTML). Будет показан через PopupManager.
     * @param {string} [options.iconUrl=auto] - URL иконки маркера. По умолчанию — путь `./img/marker.png` относительно текущего модуля.
     * @param {function} [options.onHover] - Callback при наведении/убирании курсора. Получает `true`/`false`.
     * @param {function} [options.onClick] - Callback при клике. Получает событие и экземпляр маркера.
     * @param {string} [options.title=''] - Текст постоянной подписи.
     * @param {string} [options.titleAlign='center'] - Выравнивание подписи ('left', 'center', 'right').
     * @param {Object} [options.titleStyle={}] - CSS-стили подписи.
     * @param {number} [options.titleMinZoom=-Infinity] - Минимальный зум для отображения подписи.
     * @param {number} [options.titleMaxZoom=Infinity] - Максимальный зум для отображения подписи.
     * @param {[number, number]|null} [options.titleOffset=null] - Пользовательское смещение подписи (px). Если не задано, рассчитывается автоматически.
     * @param {boolean} [options.clusterable=true] - Участвует ли маркер в кластеризации.
     * @param {boolean} [options.titleAllowOverflow=false] - Разрешить выход подписи за границы экрана.
     * @param {number} [options.titlePriority=0] - Приоритет подписи (чем выше, тем приоритетнее при конфликтах).
     * @throws {Error} Бросает ошибку, если options.position отсутствует или имеет неверный формат.
     */
    constructor(options = {}) {
        if (!options.position || options.position.length !== 2) {
            throw new Error('Marker: options.position is required [x, y]');
        }
        /**
         * Координаты маркера в собственной СК.
         * @private
         * @type {[number, number]}
         */
        this._coord = [options.position[0], options.position[1]];
        /**
         * Код СК маркера; null — использовать `map.inputCRS`.
         * @private
         * @type {string|null}
         */
        this._crsCode = options.crs ?? null;
        /**
         * Зарезолвленный объект Projection. Устанавливается в `_attach`.
         * @private
         * @type {import('./Projections.js').Projection|null}
         */
        this._crs = null;

        // Производные WGS84-координаты (для обратной совместимости с внешним кодом,
        // например ClusterLayer). Заполняются в `_attach`, когда известна карта.
        /** @private */ this._lon = null;
        /** @private */ this._lat = null;

        /** @private */ this._iconSize = options.iconSize || [16, 16];
        /** @private */ this._anchor = options.anchor || [0.5, 1.0];
        /** @private */ this._minZoom = options.minZoom ?? -Infinity;
        /** @private */ this._maxZoom = options.maxZoom ?? Infinity;
        /** @private */ this._altitudeMode = options.altitudeMode || 'ground';
        /** @private */ this._altitude = options.altitude || 0;
        /** @private */ this._tooltipText = options.tooltip || '';
        /** @private */ this._iconUrl = options.iconUrl !== undefined ? options.iconUrl : DEFAULT_ICON_URL;
        /** @private */ this._onHover = options.onHover || null;
        /** @private */ this._onClick = options.onClick || null;

        // Подпись
        /** @private */ this._title = options.title || '';
        /** @private */ this._titleAlign = options.titleAlign || 'center';
        /** @private */ this._titleStyle = options.titleStyle || {};
        /** @private */ this._titleMinZoom = options.titleMinZoom ?? -Infinity;
        /** @private */ this._titleMaxZoom = options.titleMaxZoom ?? Infinity;
        /** @private */ this._userTitleOffset = options.titleOffset || null;
        /** @private */ this._titleOffset = null;

        /** @private */ this._clusterable = options.clusterable !== undefined ? options.clusterable : true;

        /** @private */ this._map = null;
        /** @private */ this._layer = null;
        /** @private */ this._element = null;
        /** @private */ this._textLabel = null;          // дескриптор TextManager

        /** @private */ this._isMobile = false;
        /** @private */ this._lastHeightUpdateTime = 0;
        /** @private */ this._cachedWorldY = 0;

        /** @private */ this._isVisible = false;
        /** @private */ this._lastScreenPos = null;

        /** @private */ this._titleAllowOverflow = options.titleAllowOverflow || false;
        /** @private */ this._titlePriority = options.titlePriority ?? 0;

        /** @private */ this._hideTimeout = null; // таймер для fade-out
    }

    /**
     * Удобный метод: создаёт персональный слой, добавляет его на карту
     * и помещает в него данный маркер.
     *
     * @param {Object} map - Экземпляр карты.
     * @returns {Marker} this
     */
    addTo(map) {
        if (this._map) this.remove();
        const personalLayer = new Layer();
        personalLayer.addTo(map);
        personalLayer.add(this);
        return this;
    }

    /**
     * Внутренний метод, вызываемый слоем при добавлении маркера.
     * Создаёт DOM-элемент иконки, подпись и назначает обработчики событий.
     * Тултип не создаётся — он будет показан через PopupManager при необходимости.
     *
     * @param {Object} map - Карта.
     * @param {Layer} layer - Слой-владелец.
     * @private
     */
    _attach(map, layer) {
        if (this._map === map && this._layer === layer) return;
        this.remove();
        this._map = map;
        this._layer = layer;

        // Резолвим проекцию маркера: либо заданная явно, либо inputCRS карты.
        this._crs = this._crsCode
            ? Projections.get(this._crsCode)
            : map.inputCRS;

        // Производные WGS84-координаты — для обратной совместимости
        // (ClusterLayer, внешний код, читающий marker._lon / marker._lat).
        const lonLat = this._crs.toLonLat(this._coord);
        this._lon = lonLat[0];
        this._lat = lonLat[1];

        this._isMobile = window.matchMedia('(hover: none) and (pointer: coarse)').matches;

        if (this._userTitleOffset) {
            this._titleOffset = [...this._userTitleOffset];
        } else {
            this._titleOffset = [0, this._iconSize[1] / 2 + 4];
        }

        const { markerPane } = _getPanes(map);
        const markerId = `krb-marker-${++Marker._idCounter}`;

        // Иконка
        const el = document.createElement('div');
        el.id = markerId;
        el.className = 'krb-marker';
        Object.assign(el.style, {
            position: 'absolute',
            width: this._iconSize[0] + 'px',
            height: this._iconSize[1] + 'px',
            transform: `translate(${-this._anchor[0] * 100}%, ${-this._anchor[1] * 100}%)`,
            pointerEvents: 'auto',
            cursor: 'pointer',
            display: 'none',
            transition: 'opacity 0.08s linear', // fade-анимация
            opacity: '0'
        });
        if (this._iconUrl) {
            const img = document.createElement('img');
            img.src = this._iconUrl;
            Object.assign(img.style, { width:'100%', height:'100%', display:'block', userSelect:'none' });
            img.draggable = false;
            el.appendChild(img);
        }
        markerPane.appendChild(el);
        this._element = el;

        // Регистрируем подпись в TextManager
        if (this._title && this._map.textManager) {
            this._textLabel = this._map.textManager.addLabel(this);
        }

        // Обработчики
        if (this._isMobile) {
            el.addEventListener('click', (e) => {
                e.stopPropagation();
                if (this._onClick) this._onClick(e, this);
                else this._defaultClickAction();
            });
        } else {
            // Наведение мыши
            if (this._onHover) {
                el.addEventListener('pointerenter', () => this._onHover(true));
                el.addEventListener('pointerleave', () => this._onHover(false));
            } else {
                // Показ тултипа при наведении
                el.addEventListener('pointerenter', () => {
                    if (this._tooltipText && this._map?.popupManager) {
                        this._map.popupManager.show(this, this._tooltipText);
                    }
                });
                el.addEventListener('pointerleave', () => {
                    if (this._map?.popupManager) {
                        this._map.popupManager.hide();
                    }
                });
            }

            // Клик
            if (this._onClick) {
                el.addEventListener('click', (e) => {
                    e.stopPropagation();
                    this._onClick(e, this);
                });
            } else {
                el.addEventListener('click', (e) => {
                    e.stopPropagation();
                    this._defaultClickAction();
                });
            }
        }
    }

    /**
     * Действие по умолчанию при клике: плавное перемещение камеры к маркеру.
     * На мобильных устройствах также показывает тултип через PopupManager.
     *
     * @private
     */
    _defaultClickAction() {
        if (this._map && this._crs) {
            const [lon, lat] = this._crs.toLonLat(this._coord);
            this._map.moveCameraToSlow(lon, lat, 0.3);
        }
        if (this._isMobile && this._tooltipText && this._map?.popupManager) {
            this._map.popupManager.show(this, this._tooltipText);
        }
    }

    /**
     * Удаляет маркер с карты: уничтожает DOM-элементы, удаляет подпись,
     * отсоединяет от слоя и сбрасывает состояние.
     */
    remove() {
        // Отменяем таймер скрытия, если есть
        if (this._hideTimeout) {
            clearTimeout(this._hideTimeout);
            this._hideTimeout = null;
        }
        if (this._element) {
            this._element.remove();
            this._element = null;
        }
        if (this._textLabel && this._map?.textManager) {
            this._map.textManager.removeLabel(this._textLabel);
            this._textLabel = null;
        }
        if (this._layer) {
            this._layer._removeRef(this);
            this._layer = null;
        }
        this._map = null;
        this._crs = null;
        this._isVisible = false;
        this._lastScreenPos = null;
    }

    /**
     * Плавно показывает или скрывает DOM-элемент маркера.
     * Использует CSS transition для fade-in / fade-out (80 мс ≈ 5 кадров).
     *
     * @param {boolean} visible - Целевое состояние видимости.
     * @private
     */
    _setVisible(visible) {
        const el = this._element;
        if (!el) return;

        if (visible) {
            // Отменяем таймер скрытия, если он был запланирован
            if (this._hideTimeout) {
                clearTimeout(this._hideTimeout);
                this._hideTimeout = null;
            }

            // Если элемент скрыт (display: none) — делаем fade-in
            if (el.style.display === 'none') {
                el.style.display = 'block';
                el.style.opacity = '0';
                // Принудительный reflow для запуска transition
                void el.offsetWidth;
                el.style.opacity = '1';
            } else {
                // Уже видим — просто устанавливаем opacity: 1 (transition анимирует при необходимости)
                el.style.opacity = '1';
            }
        } else {
            // Если уже скрыт — ничего не делаем
            if (el.style.display === 'none') return;

            // Запускаем fade-out
            el.style.opacity = '0';

            // Планируем скрытие после завершения анимации
            if (this._hideTimeout) clearTimeout(this._hideTimeout);
            this._hideTimeout = setTimeout(() => {
                if (parseFloat(el.style.opacity) === 0) {
                    el.style.display = 'none';
                }
                this._hideTimeout = null;
            }, 80);
        }
    }

    /**
     * Обновляет позицию маркера на экране. Вызывается картой на каждом кадре.
     * Учитывает кластеризацию, видимость слоя, зум, расстояние до камеры и рельеф.
     *
     * @param {Object} map - Экземпляр карты.
     * @private
     */
    _update(map) {
        if (!this._map || !this._element) return;
        const mapInstance = this._map;
        const zoom = mapInstance.continuousZoom;

        // Кластеризация
        if (this._layer && this._layer._clusterActive) {
            if (!this._layer._clusterVisibleMarkers || !this._layer._clusterVisibleMarkers.has(this)) {
                this._setVisible(false);
                this._isVisible = false;
                return;
            }
        }

        if (this._layer && !this._layer.visible) {
            this._setVisible(false);
            this._isVisible = false;
            return;
        }

        if (zoom < this._minZoom || zoom > this._maxZoom) {
            this._setVisible(false);
            this._isVisible = false;
            return;
        }

        // Координаты маркера → мировые координаты карты (метры проекции карты).
        const [absWorldX, absWorldZ] = mapInstance.project(this._coord, this._crs);
        const wgPos = mapInstance.worldGroup.position;
        const worldX = absWorldX + wgPos.x;
        const worldZ = absWorldZ + wgPos.z;
        let worldY = 0; // значение по умолчанию для 'ground'

        // Вычисляем мировую Y-координату в зависимости от режима высоты
        switch (this._altitudeMode) {
            case 'absolute':
                worldY = this._altitude; // произвольная высота относительно 0
                break;
            case 'clampToGround':
                {
                    const now = performance.now();
                    if (now - this._lastHeightUpdateTime > 500) {
                        mapInstance.ensureTileForPoint(worldX, worldZ);
                        this._cachedWorldY = mapInstance.getSurfaceHeightAt(worldX, worldZ);
                        this._lastHeightUpdateTime = now;
                    }
                    worldY = this._cachedWorldY;
                }
                break;
            case 'ground':
            default:
                worldY = 0;
                break;
        }

        const worldPos = new THREE.Vector3(worldX, worldY + wgPos.y, worldZ);

        // Дальность отрисовки
        if (map.view.objectDistanceFactor > 0) {
            const dist = map.camera.position.distanceTo(worldPos);
            if (dist > map.maxObjectDistance) {
                this._setVisible(false);
                this._isVisible = false;
                return;
            }
        }

        const screenPos = worldPos.clone().project(map.camera);
        if (screenPos.z > 1 || Math.abs(screenPos.x) > 1 || Math.abs(screenPos.y) > 1) {
            this._setVisible(false);
            this._isVisible = false;
            return;
        }

        const canvas = mapInstance.renderer.domElement;
        const x = (screenPos.x * 0.5 + 0.5) * canvas.clientWidth;
        const y = (-screenPos.y * 0.5 + 0.5) * canvas.clientHeight;

        // Обновляем позицию и показываем элемент
        this._element.style.left = x + 'px';
        this._element.style.top = y + 'px';
        this._setVisible(true);

        this._lastScreenPos = { x, y };
        this._isVisible = true;
    }

    // ---------- Интерфейс для TextManager ----------

    /**
     * Возвращает текст подписи.
     *
     * @returns {string} Текст подписи.
     */
    getText() { return this._title; }

    /**
     * Возвращает объект CSS-стилей подписи.
     *
     * @returns {Object} Объект CSS-стилей подписи.
     */
    getTextStyle() {
        return Object.assign({
            fontFamily: 'sans-serif',
            color: '#333',
            fontSize: '12px',
            textAlign: this._titleAlign
        }, this._titleStyle);
    }

    /**
     * Возвращает границы зума для отображения подписи.
     *
     * @returns {{min: number, max: number}} Границы зума.
     */
    getTextZoomBounds() { return { min: this._titleMinZoom, max: this._titleMaxZoom }; }

    /**
     * Возвращает тип подписи.
     *
     * @returns {string} Тип подписи ('point').
     */
    getLabelType() { return 'point'; }

    /**
     * Проверяет, виден ли маркер в текущем кадре.
     *
     * @returns {boolean} Видимость маркера.
     */
    isVisible() { return this._isVisible; }

    /**
     * Возвращает позицию маркера на экране в пикселях или null.
     *
     * @returns {{x: number, y: number}|null} Позиция маркера на экране или null.
     */
    getScreenPosition() { return this._isVisible ? this._lastScreenPos : null; }

    /**
     * Возвращает выравнивание подписи.
     *
     * @returns {string} Выравнивание подписи.
     */
    getTitleAlign() { return this._titleAlign; }

    /**
     * Возвращает смещение подписи в пикселях.
     *
     * @returns {[number, number]} Смещение подписи.
     */
    getTitleOffset() { return this._titleOffset; }

    /**
     * Возвращает вертикальное выравнивание подписи.
     *
     * @returns {string} Вертикальное выравнивание (всегда 'center').
     */
    getTitleVerticalAlign() { return 'center'; }

    /**
     * Проверяет, разрешён ли выход подписи за границы экрана.
     *
     * @returns {boolean} Разрешение на выход за границы.
     */
    getAllowOverflow() { return this._titleAllowOverflow; }

    /**
     * Возвращает приоритет подписи.
     *
     * @returns {number} Приоритет подписи.
     */
    getPriority() { return this._titlePriority; }

    /**
     * Возвращает исходные координаты маркера в его собственной СК.
     *
     * @returns {[number, number]} Координаты [x, y] в СК маркера.
     */
    getPosition() { return this._coord.slice(); }

    /**
     * Возвращает код СК маркера или null, если используется `map.inputCRS`.
     *
     * @returns {string|null} Код СК или null.
     */
    getCRS() { return this._crsCode; }

    /**
     * Возвращает координаты маркера в WGS84 (долгота, широта).
     * Доступно только после добавления маркера на карту (когда резолвлена СК).
     *
     * @returns {[number, number]|null} [lon, lat] или null, если маркер не привязан к карте.
     */
    getLonLat() {
        if (!this._crs) return null;
        return this._crs.toLonLat(this._coord);
    }

    // ---------- Интерфейс для KrbMap#fitTo / getBounds ----------

    /**
     * Возвращает прямоугольник (bounding box), охватывающий маркер.
     * Для точечного объекта это вырожденный прямоугольник:
     * `[[x, y], [x, y]]` с одинаковыми углами.
     *
     * Используется методом {@link KrbMap#fitTo} для подгонки вида.
     * Если маркер привязан к карте (`_crs` резолвлена), преобразование
     * выполняется из его СК. Если не привязан, но задан `_crsCode` —
     * из него. В остальных случаях координаты считаются уже в WGS84
     * (это соответствует поведению конструктора по умолчанию, где
     * `map.inputCRS` = EPSG:4326).
     *
     * @param {string|import('./Projections.js').Projection} [crs='EPSG:4326'] -
     *     Целевая СК для результата (код или объект Projection).
     * @returns {Array.<Array.<number>>|null} [[x, y], [x, y]] или null,
     *     если преобразование невозможно.
     *
     * @example
     * const b = marker.getBounds();               // → [[37.662039, 55.763493], [37.662039, 55.763493]]
     * const bUtm = marker.getBounds('EPSG:32637'); // → [[413500, 6178000], [413500, 6178000]]
     */
    getBounds(crs = 'EPSG:4326') {
        const src = this._crs
            ?? (this._crsCode ? Projections.get(this._crsCode) : Projections.get('EPSG:4326'));
        const dst = typeof crs === 'string' ? Projections.get(crs) : crs;
        if (!src || !dst) return null;

        let x, y;
        if (src === dst) {
            x = this._coord[0];
            y = this._coord[1];
        } else {
            const lonLat = src.toLonLat(this._coord);
            const converted = dst.fromLonLat(lonLat);
            x = converted[0];
            y = converted[1];
        }
        return [[x, y], [x, y]];
    }
}