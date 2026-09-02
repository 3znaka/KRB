/**
 * Модуль для создания и управления маркерами на карте.
 * Предоставляет класс {@link Marker} и вспомогательную функцию {@link _getPanes}
 * для получения DOM-панели маркеров.
 *
 * @module marker
 */

import { proj } from './Utils.js';
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
 * @example
 * const marker = new Marker({
 *   position: [37.662039, 55.763493],
 *   iconSize: [32, 32],
 *   anchor: [0.5, 1.0],
 *   minZoom: 5,
 *   maxZoom: 18,
 *   altitudeMode: 'clampToGround',
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
 * console.log(marker.getText());
 * console.log(marker.getTextStyle());
 * console.log(marker.getTextZoomBounds());
 * console.log(marker.getLabelType());
 * console.log(marker.isVisible());
 * console.log(marker.getScreenPosition());
 * console.log(marker.getTitleAlign());
 * console.log(marker.getTitleOffset());
 * console.log(marker.getTitleVerticalAlign());
 * console.log(marker.getAllowOverflow());
 * console.log(marker.getPriority());
 * marker.remove();
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
     * @param {[number, number]} options.position - Географические координаты [долгота, широта] в градусах.
     * @param {[number, number]} [options.iconSize=[16,16]] - Размер иконки в пикселях [ширина, высота].
     * @param {[number, number]} [options.anchor=[0.5,1.0]] - Якорь иконки (доли от размера), определяет точку привязки.
     * @param {number} [options.minZoom=-Infinity] - Минимальный зум, при котором маркер виден.
     * @param {number} [options.maxZoom=Infinity] - Максимальный зум, при котором маркер виден.
     * @param {string} [options.altitudeMode='ground'] - Режим высоты: 'ground' (на поверхности) или 'clampToGround' (прилеплен к рельефу).
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
            throw new Error('Marker: options.position is required [lon, lat]');
        }
        /** @private */ this._lon = options.position[0];
        /** @private */ this._lat = options.position[1];
        /** @private */ this._iconSize = options.iconSize || [16, 16];
        /** @private */ this._anchor = options.anchor || [0.5, 1.0];
        /** @private */ this._minZoom = options.minZoom ?? -Infinity;
        /** @private */ this._maxZoom = options.maxZoom ?? Infinity;
        /** @private */ this._altitudeMode = options.altitudeMode || 'ground';
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
            display: 'none'
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
        if (this._map) this._map.moveCameraToSlow(this._lon, this._lat, 0.3);
        if (this._isMobile && this._tooltipText && this._map?.popupManager) {
            this._map.popupManager.show(this, this._tooltipText);
        }
    }

    /**
     * Удаляет маркер с карты: уничтожает DOM-элементы, удаляет подпись,
     * отсоединяет от слоя и сбрасывает состояние.
     */
    remove() {
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
        this._isVisible = false;
        this._lastScreenPos = null;
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
                this._element.style.display = 'none';
                this._isVisible = false;
                return;
            }
        }

        if (this._layer && !this._layer.visible) {
            this._element.style.display = 'none';
            this._isVisible = false;
            return;
        }

        if (zoom < this._minZoom || zoom > this._maxZoom) {
            this._element.style.display = 'none';
            this._isVisible = false;
            return;
        }

        const [absWorldX, absWorldZ] = proj.fromLonLat([this._lon, this._lat]);
        const wgPos = mapInstance.worldGroup.position;
        const worldX = absWorldX + wgPos.x;
        const worldZ = absWorldZ + wgPos.z;
        let worldY = 0;
        if (this._altitudeMode === 'clampToGround') {
            const now = performance.now();
            if (now - this._lastHeightUpdateTime > 500) {
                mapInstance.ensureTileForPoint(worldX, worldZ);
                this._cachedWorldY = mapInstance.getSurfaceHeightAt(worldX, worldZ);
                this._lastHeightUpdateTime = now;
            }
            worldY = this._cachedWorldY;
        }
        const worldPos = new THREE.Vector3(worldX, worldY + wgPos.y, worldZ);

        // Дальность отрисовки
        if (map.view.objectDistanceFactor > 0) {
            const dist = map.camera.position.distanceTo(worldPos);
            if (dist > map.maxObjectDistance) {
                this._element.style.display = 'none';
                this._isVisible = false;
                return;
            }
        }

        const screenPos = worldPos.clone().project(map.camera);
        if (screenPos.z > 1 || Math.abs(screenPos.x) > 1 || Math.abs(screenPos.y) > 1) {
            this._element.style.display = 'none';
            this._isVisible = false;
            return;
        }

        const canvas = mapInstance.renderer.domElement;
        const x = (screenPos.x * 0.5 + 0.5) * canvas.clientWidth;
        const y = (-screenPos.y * 0.5 + 0.5) * canvas.clientHeight;

        this._element.style.display = 'block';
        this._element.style.left = x + 'px';
        this._element.style.top = y + 'px';

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
}