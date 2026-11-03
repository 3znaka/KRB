/**
 * SpatialObject — базовый класс для всех пространственных объектов карты.
 *
 * Хранит общее состояние, которое есть у каждого объекта (границы зума,
 * пользовательская видимость, интерактив, подпись, tooltip) и реализует
 * единый TextManager-контракт. Подклассы переопределяют только то, что
 * действительно специфично (создание/снос ресурсов, как именно скрывать,
 * как именно перерегистрировать интерактив, labelType).
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
    /** Результат последнего _update — не путать с _userVisible. */
    _isVisible = false;
    _lastScreenPos = null;
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
    /** Создаёт персональный слой и добавляет в него объект. */
    addTo(map) {
        if (this._map)
            this.remove();
        const personalLayer = new Layer();
        personalLayer.addTo(map);
        personalLayer.add(this);
        return this;
    }
    /**
     * Шаблонный метод присоединения к карте. Подкласс реализует
     * `_onAttached(map)` — там создаются DOM/геометрия/слушатели.
     */
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
    /**
     * Шаблонный метод отсоединения. Подкласс реализует `_teardown()` —
     * там освобождаются ресурсы (DOM/меши/слушатели).
     */
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
    /** Значение `titleOffset` по умолчанию (если пользователь не задал). */
    _defaultTitleOffset() {
        return [0, 0];
    }
    /**
     * Хук: вызывается после изменения tooltip/onClick/onHover, когда
     * объект уже присоединён к карте. Подклассы, использующие
     * `map.interaction`, здесь перерегистрируют интерактив. По умолчанию
     * — no-op (для объектов на DOM-событиях, как Marker).
     */
    _onTooltipChanged() { }
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
    /**
     * По умолчанию — последняя известная экранная позиция, пока объект
     * видим. Подклассы, которым нужно считать позицию по геометрии,
     * переопределяют.
     */
    getScreenPosition() {
        return this._isVisible ? this._lastScreenPos : null;
    }
    // =================================================================
    // Внутренние хелперы
    // =================================================================
    /** Вычисляет `_titleOffset` из `_userTitleOffset` или дефолта подкласса. */
    _resolveTitleOffset() {
        this._titleOffset = this._userTitleOffset
            ? [this._userTitleOffset[0], this._userTitleOffset[1]]
            : this._defaultTitleOffset();
    }
    /** Обновляет/пересоздаёт дескриптор подписи в TextManager. */
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
    /**
     * Общий входной гейт видимости: пользовательская видимость, видимость
     * слоя и границы зума. Кластерная видимость и прочие специфичные
     * проверки — в подклассах.
     */
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
