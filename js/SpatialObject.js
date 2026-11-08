/**
 * SpatialObject — базовый класс для всех пространственных объектов карты.
 *
 * Хранит общее состояние, которое есть у каждого объекта (границы зума,
 * пользовательская видимость, интерактив, подпись, tooltip, высота) и
 * реализует единый TextManager-контракт. Подклассы переопределяют только
 * то, что действительно специфично.
 *
 * @module SpatialObject
 */
import { Layer } from './Layers.js';
export class SpatialObject {
    // ── Границы зума ──
    _minZoom = -Infinity;
    _maxZoom = Infinity;
    // ── Видимость ──
    _userVisible = true;
    _isVisible = false;
    _lastScreenPos = null;
    // ── Высота ──
    /**
     * Смещение по вертикали (world-метры). Семантика зависит от
     * `altitudeMode` подкласса:
     *   - 'clampToGround' — поверх рельефа + altitude;
     *   - 'absolute'      — абсолютная Y = altitude;
     *   - 'ground'        — плоскость Y = altitude.
     * Реализация интерпретации — в `_update` подкласса.
     */
    _altitude = 0;
    /** Интерполяция числовых свойств по зуму. `null` — выключено. */
    _zoomInterpolations = null;
    /** Последний zoom, на котором применяли интерполяцию. NaN = «форс». */
    _lastZoomValue = NaN;
    // ── Произвольные данные объекта ──
    /** Бизнес-данные (id, type, studyId, …). Не участвуют в рендере. */
    _properties = {};
    /** Служебные данные (пользовательские/прикладные). Не участвуют в рендере. */
    _userData = {};
    // ── Интерактив ──
    _tooltipText = '';
    _onClick = null;
    _onHover = null;
    // ── Подпись ──
    _title = '';
    _titleStyle = {};
    _titleMinZoom = -Infinity;
    _titleMaxZoom = Infinity;
    _titleAlign = 'center';
    _userTitleOffset = null;
    _titleOffset = [0, 0];
    _titleAllowOverflow = false;
    _titlePriority = 0;
    // ── Присоединение ──
    _map = null;
    _layer = null;
    _textLabel = null;
    // =================================================================
    // Жизненный цикл
    // =================================================================
    addTo(map) {
        if (this._map === map && this._layer)
            return this; // уже там — no-op
        if (this._map) {
            // Отсоединяемся от старой карты: personal Layer тоже надо убрать,
            // иначе он утечёт в map._dynamicLayers.
            const oldLayer = this._layer;
            this.remove(); // _layer → null
            if (oldLayer && oldLayer._map && !oldLayer._objects.length) {
                oldLayer.removeFromMap();
            }
        }
        const personalLayer = new Layer();
        personalLayer.addTo(map);
        personalLayer.add(this);
        return this;
    }
    _attach(map, layer) {
        if (this._map === map && this._layer === layer)
            return;
        this.remove();
        this._map = map;
        this._layer = layer;
        this._resolveTitleOffset();
        this._onAttached(map);
        if (this._title && map.textManager) {
            this._textLabel = map.textManager.addLabel(this);
        }
    }
    remove() {
        this._teardown();
        if (this._textLabel && this._map?.textManager) {
            this._map.textManager.removeLabel(this._textLabel);
        }
        this._textLabel = null;
        if (this._layer) {
            this._layer._removeRef(this);
            this._layer = null;
        }
        this._map = null;
        this._isVisible = false;
        this._lastScreenPos = null;
    }
    _defaultTitleOffset() {
        return [0, 0];
    }
    /**
     * Хук: вызывается после изменения tooltip/onClick/onHover, а также
     * после смены altitude/altitudeMode (см. `_onAltitudeChanged`), когда
     * объект уже присоединён к карте. По умолчанию — no-op.
     */
    _onTooltipChanged() { }
    /**
     * Хук: вызывается из `setAltitude`/`setAltitudeMode` после того,
     * как значение обновлено. Нужен подклассам, которые кэшируют
     * высоту рельефа (Marker/Marker3D/Polygon/Polyline). По умолчанию
     * — no-op (для тех, у кого _altitude не влияет на кэш).
     */
    _onAltitudeChanged() { }
    // =================================================================
    // Zoom
    // =================================================================
    setZoomBounds(minZoom, maxZoom) {
        this._minZoom = minZoom;
        this._maxZoom = maxZoom;
        return this;
    }
    getZoomBounds() {
        return { min: this._minZoom, max: this._maxZoom };
    }
    // =================================================================
    // Высота
    // =================================================================
    setAltitude(altitude) {
        if (!Number.isFinite(altitude))
            return this;
        this._altitude = altitude;
        this._onAltitudeChanged();
        return this;
    }
    getAltitude() {
        return this._altitude;
    }
    // =================================================================
    // Интерактив
    // =================================================================
    setTooltip(html) {
        this._tooltipText = html ?? '';
        if (this._map)
            this._onTooltipChanged();
        return this;
    }
    getTooltip() {
        return this._tooltipText;
    }
    setOnClick(fn) {
        this._onClick = fn;
        if (this._map)
            this._onTooltipChanged();
        return this;
    }
    setOnHover(fn) {
        this._onHover = fn;
        if (this._map)
            this._onTooltipChanged();
        return this;
    }
    // =================================================================
    // Видимость
    // =================================================================
    setVisible(visible) {
        this._userVisible = !!visible;
        if (!this._userVisible) {
            this._applyHidden();
            this._isVisible = false;
        }
        return this;
    }
    // SpatialObject.ts
    /**
     * Логическая видимость: должен ли объект отображать подпись,
     * принимать интеракции и т.д.
     *
     * Это НЕ то же самое, что `mesh.visible`. В частности, объект может
     * быть логически видимым, но не рендериться самостоятельно — его
     * может рисовать батчер (см. PolygonBatcher). В батченном режиме
     * `_group.visible = false`, но `_isVisible = true`, потому что объект
     * по-прежнему «жив»: у него есть подпись, интеракция через батчер.
     *
     * **Подклассы НЕ должны переопределять этот метод** для возврата
     * `_group.visible` — это сломает TextManager. Если нужна «рендер-
     * видимость», это отдельное понятие, и его надо выражать отдельным
     * методом / callback-ом.
     */
    isVisible() {
        return this._isVisible;
    }
    // =================================================================
    // Подпись (TextManager contract)
    // =================================================================
    setTitle(text) {
        const next = text ?? '';
        if (this._title === next)
            return this;
        this._title = next;
        this._refreshTextLabel();
        return this;
    }
    getText() { return this._title; }
    getTextStyle() {
        return Object.assign({
            fontFamily: 'sans-serif',
            color: '#333',
            fontSize: '12px',
            textAlign: this._titleAlign,
        }, this._titleStyle);
    }
    getTextZoomBounds() {
        return { min: this._titleMinZoom, max: this._titleMaxZoom };
    }
    getTitleAlign() { return this._titleAlign; }
    getTitleOffset() { return this._titleOffset; }
    getTitleVerticalAlign() { return 'center'; }
    getAllowOverflow() { return this._titleAllowOverflow; }
    getPriority() { return this._titlePriority; }
    getScreenPosition() {
        return this._isVisible ? this._lastScreenPos : null;
    }
    getLayer() {
        return this._layer;
    }
    /** Устанавливает `properties` (заменяет целиком). */
    setProperties(props) {
        this._properties = props ?? {};
        return this;
    }
    /** Возвращает `properties` (живую ссылку). */
    getProperties() {
        return this._properties;
    }
    /**
 * Включает/выключает интерполяцию числовых свойств по зуму.
 *
 * `stops` для каждого свойства — массив `[[zoom, value], …]`,
 * отсортированный по возрастанию zoom (если не отсортирован —
 * отсортируем сами). За пределами массива — константа: крайние
 * значения `stops[0][1]` / `stops[last][1]`.
 *
 * Свойство `foo` применяется через `this.setFoo(value)` —
 * ищится автоматически по имени сеттера. Если сеттера нет —
 * `console.warn` в момент вызова `setZoomInterpolations`.
 *
 * @example
 * poly.setZoomInterpolations({
 *     fillOpacity:  [[14, 0],   [16, 0.5], [18, 1]],
 *     strokeWidth:  [[14, 0.5], [18, 4]],
 * });
 * poly.setZoomInterpolations(null);   // выключить
 */
    setZoomInterpolations(interp) {
        if (!interp) {
            this._zoomInterpolations = null;
            this._lastZoomValue = NaN;
            return this;
        }
        const normalized = {};
        for (const prop in interp) {
            const raw = interp[prop];
            if (!Array.isArray(raw))
                continue;
            const stops = raw
                .filter((s) => Array.isArray(s) && s.length === 2 &&
                Number.isFinite(s[0]) && Number.isFinite(s[1]))
                .slice()
                .sort((a, b) => a[0] - b[0]);
            if (stops.length < 2)
                continue;
            normalized[prop] = stops;
            const setterName = 'set' + prop.charAt(0).toUpperCase() + prop.slice(1);
            if (typeof this[setterName] !== 'function') {
                console.warn(`SpatialObject.setZoomInterpolations: property "${prop}" ` +
                    `has no setter "${setterName}" on ${this.constructor.name}`);
            }
        }
        this._zoomInterpolations = normalized;
        this._lastZoomValue = NaN;
        if (this._map)
            this._applyZoomInterpolations(this._map.continuousZoom);
        return this;
    }
    /** Возвращает копию текущей карты интерполяций (или `null`). */
    getZoomInterpolations() {
        if (!this._zoomInterpolations)
            return null;
        const out = {};
        for (const prop in this._zoomInterpolations) {
            out[prop] = this._zoomInterpolations[prop]
                .map(s => [s[0], s[1]]);
        }
        return out;
    }
    /**
     * Применяет интерполяцию, если zoom изменился с прошлого вызова.
     * Дешёвая no-op, если `_zoomInterpolations === null`.
     */
    _applyZoomInterpolations(zoom) {
        if (!this._zoomInterpolations)
            return;
        if (zoom === this._lastZoomValue)
            return;
        this._lastZoomValue = zoom;
        for (const prop in this._zoomInterpolations) {
            const stops = this._zoomInterpolations[prop];
            const value = this._evalZoomStops(stops, zoom);
            const setter = this['set' + prop.charAt(0).toUpperCase() + prop.slice(1)];
            if (typeof setter !== 'function')
                continue;
            try {
                setter.call(this, value);
            }
            catch { /* swallow */ }
        }
    }
    _evalZoomStops(stops, zoom) {
        const first = stops[0];
        const last = stops[stops.length - 1];
        if (zoom <= first[0])
            return first[1];
        if (zoom >= last[0])
            return last[1];
        for (let i = 0; i < stops.length - 1; i++) {
            const [z0, v0] = stops[i];
            const [z1, v1] = stops[i + 1];
            if (zoom >= z0 && zoom <= z1) {
                if (z1 === z0)
                    return v1;
                const t = (zoom - z0) / (z1 - z0);
                return v0 + (v1 - v0) * t;
            }
        }
        return last[1];
    }
    /** Устанавливает `userData` (заменяет целиком). */
    setUserData(data) {
        this._userData = data ?? {};
        return this;
    }
    /** Возвращает `userData` (живую ссылку). */
    getUserData() {
        return this._userData;
    }
    // =================================================================
    // Внутренние хелперы
    // =================================================================
    _resolveTitleOffset() {
        this._titleOffset = this._userTitleOffset
            ? [this._userTitleOffset[0], this._userTitleOffset[1]]
            : this._defaultTitleOffset();
    }
    _refreshTextLabel() {
        const tm = this._map?.textManager;
        if (!tm)
            return;
        if (this._textLabel) {
            if (typeof tm.updateLabel === 'function') {
                tm.updateLabel(this._textLabel);
            }
            else {
                tm.removeLabel(this._textLabel);
                this._textLabel = null;
                if (this._title)
                    this._textLabel = tm.addLabel(this);
            }
        }
        else if (this._title) {
            this._textLabel = tm.addLabel(this);
        }
    }
    _isWithinView() {
        if (!this._map)
            return false;
        if (!this._userVisible)
            return false;
        if (this._layer && !this._layer.visible)
            return false;
        const z = this._map.continuousZoom;
        return z >= this._minZoom && z <= this._maxZoom;
    }
}
