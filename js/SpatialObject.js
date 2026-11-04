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
        if (this._map)
            this.remove();
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
