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

export type TitleAlignH = 'left' | 'center' | 'right';
export type TitleAlignV = 'top' | 'middle' | 'center' | 'bottom';
export type ZoomInterpolationStops = Array<[number, number]>;
export type ZoomInterpolation = Record<string, ZoomInterpolationStops>;

export abstract class SpatialObject {
    // ── Границы зума ──
    protected _minZoom: number = -Infinity;
    protected _maxZoom: number = Infinity;

    // ── Видимость ──
    protected _userVisible: boolean = true;
    protected _isVisible: boolean = false;
    protected _lastScreenPos: { x: number; y: number } | null = null;

    // ── Высота ──
    /**
     * Смещение по вертикали (world-метры). Семантика зависит от
     * `altitudeMode` подкласса:
     *   - 'clampToGround' — поверх рельефа + altitude;
     *   - 'absolute'      — абсолютная Y = altitude;
     *   - 'ground'        — плоскость Y = altitude.
     * Реализация интерпретации — в `_update` подкласса.
     */
    protected _altitude: number = 0;
    /** Интерполяция числовых свойств по зуму. `null` — выключено. */
    protected _zoomInterpolations: ZoomInterpolation | null = null;
    /** Последний zoom, на котором применяли интерполяцию. NaN = «форс». */
    protected _lastZoomValue: number = NaN;
     // ── Произвольные данные объекта ──
    /** Бизнес-данные (id, type, studyId, …). Не участвуют в рендере. */
    protected _properties: Record<string, any> = {};
    /** Служебные данные (пользовательские/прикладные). Не участвуют в рендере. */
    protected _userData: Record<string, any> = {};

    // ── Интерактив ──
    protected _tooltipText: string = '';
    protected _onClick: ((event: MouseEvent, obj: this) => void) | null = null;
    protected _onHover: ((hovered: boolean) => void) | null = null;

    // ── Подпись ──
    protected _title: string = '';
    protected _titleStyle: Record<string, string | number> = {};
    protected _titleMinZoom: number = -Infinity;
    protected _titleMaxZoom: number = Infinity;
    protected _titleAlign: TitleAlignH = 'center';
    protected _userTitleOffset: [number, number] | null = null;
    protected _titleOffset: [number, number] = [0, 0];
    protected _titleAllowOverflow: boolean = false;
    protected _titlePriority: number = 0;

    // ── Присоединение ──
    protected _map: any = null;
    protected _layer: Layer | null = null;
    protected _textLabel: any = null;

    // =================================================================
    // Жизненный цикл
    // =================================================================

    addTo(map: any): this {
        if (this._map) this.remove();
        const personalLayer = new Layer();
        personalLayer.addTo(map);
        (personalLayer as any).add(this);
        return this;
    }

    _attach(map: any, layer: Layer): void {
        if (this._map === map && this._layer === layer) return;
        this.remove();
        this._map = map;
        this._layer = layer;

        this._resolveTitleOffset();
        this._onAttached(map);

        if (this._title && map.textManager) {
            this._textLabel = map.textManager.addLabel(this);
        }
    }

    remove(): void {
        this._teardown();

        if (this._textLabel && this._map?.textManager) {
            this._map.textManager.removeLabel(this._textLabel);
        }
        this._textLabel = null;

        if (this._layer) {
            (this._layer as any)._removeRef(this);
            this._layer = null;
        }
        this._map = null;
        this._isVisible = false;
        this._lastScreenPos = null;
    }

    // =================================================================
    // Абстрактные / шаблонные хуки
    // =================================================================

    protected abstract _onAttached(map: any): void;
    protected abstract _teardown(): void;
    protected abstract _applyHidden(): void;
    abstract getLabelType(): string;

    protected _defaultTitleOffset(): [number, number] {
        return [0, 0];
    }

    /**
     * Хук: вызывается после изменения tooltip/onClick/onHover, а также
     * после смены altitude/altitudeMode (см. `_onAltitudeChanged`), когда
     * объект уже присоединён к карте. По умолчанию — no-op.
     */
    protected _onTooltipChanged(): void { /* override if needed */ }

    /**
     * Хук: вызывается из `setAltitude`/`setAltitudeMode` после того,
     * как значение обновлено. Нужен подклассам, которые кэшируют
     * высоту рельефа (Marker/Marker3D/Polygon/Polyline). По умолчанию
     * — no-op (для тех, у кого _altitude не влияет на кэш).
     */
    protected _onAltitudeChanged(): void { /* override if needed */ }

    // =================================================================
    // Zoom
    // =================================================================

    setZoomBounds(minZoom: number, maxZoom: number): this {
        this._minZoom = minZoom;
        this._maxZoom = maxZoom;
        return this;
    }

    getZoomBounds(): { min: number; max: number } {
        return { min: this._minZoom, max: this._maxZoom };
    }

    // =================================================================
    // Высота
    // =================================================================

    setAltitude(altitude: number): this {
        if (!Number.isFinite(altitude)) return this;
        this._altitude = altitude;
        this._onAltitudeChanged();
        return this;
    }

    getAltitude(): number {
        return this._altitude;
    }

    // =================================================================
    // Интерактив
    // =================================================================

    setTooltip(html: string): this {
        this._tooltipText = html ?? '';
        if (this._map) this._onTooltipChanged();
        return this;
    }

    getTooltip(): string {
        return this._tooltipText;
    }

    setOnClick(fn: ((event: MouseEvent, obj: this) => void) | null): this {
        this._onClick = fn;
        if (this._map) this._onTooltipChanged();
        return this;
    }

    setOnHover(fn: ((hovered: boolean) => void) | null): this {
        this._onHover = fn;
        if (this._map) this._onTooltipChanged();
        return this;
    }

    // =================================================================
    // Видимость
    // =================================================================

    setVisible(visible: boolean): this {
        this._userVisible = !!visible;
        if (!this._userVisible) {
            this._applyHidden();
            this._isVisible = false;
        }
        return this;
    }

    isVisible(): boolean {
        return this._isVisible;
    }

    // =================================================================
    // Подпись (TextManager contract)
    // =================================================================

    setTitle(text: string): this {
        const next = text ?? '';
        if (this._title === next) return this;
        this._title = next;
        this._refreshTextLabel();
        return this;
    }

    getText(): string { return this._title; }

    getTextStyle(): Record<string, string | number> {
        return Object.assign({
            fontFamily: 'sans-serif',
            color: '#333',
            fontSize: '12px',
            textAlign: this._titleAlign,
        }, this._titleStyle);
    }

    getTextZoomBounds(): { min: number; max: number } {
        return { min: this._titleMinZoom, max: this._titleMaxZoom };
    }

    getTitleAlign(): TitleAlignH { return this._titleAlign; }
    getTitleOffset(): [number, number] { return this._titleOffset; }
    getTitleVerticalAlign(): TitleAlignV { return 'center'; }
    getAllowOverflow(): boolean { return this._titleAllowOverflow; }
    getPriority(): number { return this._titlePriority; }

    getScreenPosition(): { x: number; y: number } | null {
        return this._isVisible ? this._lastScreenPos : null;
    }

    getLayer(): Layer | null {
        return this._layer;
    }

    /** Устанавливает `properties` (заменяет целиком). */
    setProperties(props: Record<string, any> | null | undefined): this {
        this._properties = props ?? {};
        return this;
    }

    /** Возвращает `properties` (живую ссылку). */
    getProperties(): Record<string, any> {
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
    setZoomInterpolations(interp: ZoomInterpolation | null): this {
        if (!interp) {
            this._zoomInterpolations = null;
            this._lastZoomValue = NaN;
            return this;
        }

        const normalized: ZoomInterpolation = {};
        for (const prop in interp) {
            const raw = interp[prop];
            if (!Array.isArray(raw)) continue;

            const stops = raw
                .filter((s): s is [number, number] =>
                    Array.isArray(s) && s.length === 2 &&
                    Number.isFinite(s[0]) && Number.isFinite(s[1]))
                .slice()
                .sort((a, b) => a[0] - b[0]);

            if (stops.length < 2) continue;
            normalized[prop] = stops;

            const setterName = 'set' + prop.charAt(0).toUpperCase() + prop.slice(1);
            if (typeof (this as any)[setterName] !== 'function') {
                console.warn(
                    `SpatialObject.setZoomInterpolations: property "${prop}" ` +
                    `has no setter "${setterName}" on ${this.constructor.name}`
                );
            }
        }

        this._zoomInterpolations = normalized;
        this._lastZoomValue = NaN;
        if (this._map) this._applyZoomInterpolations(this._map.continuousZoom);
        return this;
    }

    /** Возвращает копию текущей карты интерполяций (или `null`). */
    getZoomInterpolations(): ZoomInterpolation | null {
        if (!this._zoomInterpolations) return null;
        const out: ZoomInterpolation = {};
        for (const prop in this._zoomInterpolations) {
            out[prop] = this._zoomInterpolations[prop]
                .map(s => [s[0], s[1]] as [number, number]);
        }
        return out;
    }

    /**
     * Применяет интерполяцию, если zoom изменился с прошлого вызова.
     * Дешёвая no-op, если `_zoomInterpolations === null`.
     */
    protected _applyZoomInterpolations(zoom: number): void {
        if (!this._zoomInterpolations) return;
        if (zoom === this._lastZoomValue) return;
        this._lastZoomValue = zoom;

        for (const prop in this._zoomInterpolations) {
            const stops = this._zoomInterpolations[prop];
            const value = this._evalZoomStops(stops, zoom);
            const setter = (this as any)['set' + prop.charAt(0).toUpperCase() + prop.slice(1)];
            if (typeof setter !== 'function') continue;
            try { setter.call(this, value); } catch { /* swallow */ }
        }
    }

    private _evalZoomStops(stops: ZoomInterpolationStops, zoom: number): number {
        const first = stops[0];
        const last = stops[stops.length - 1];
        if (zoom <= first[0]) return first[1];
        if (zoom >= last[0]) return last[1];

        for (let i = 0; i < stops.length - 1; i++) {
            const [z0, v0] = stops[i];
            const [z1, v1] = stops[i + 1];
            if (zoom >= z0 && zoom <= z1) {
                if (z1 === z0) return v1;
                const t = (zoom - z0) / (z1 - z0);
                return v0 + (v1 - v0) * t;
            }
        }
        return last[1];
    }

    /** Устанавливает `userData` (заменяет целиком). */
    setUserData(data: Record<string, any> | null | undefined): this {
        this._userData = data ?? {};
        return this;
    }

    /** Возвращает `userData` (живую ссылку). */
    getUserData(): Record<string, any> {
        return this._userData;
    }

    // =================================================================
    // Внутренние хелперы
    // =================================================================

    protected _resolveTitleOffset(): void {
        this._titleOffset = this._userTitleOffset
            ? [this._userTitleOffset[0], this._userTitleOffset[1]]
            : this._defaultTitleOffset();
    }

    protected _refreshTextLabel(): void {
        const tm = this._map?.textManager;
        if (!tm) return;
        if (this._textLabel) {
            if (typeof tm.updateLabel === 'function') {
                tm.updateLabel(this._textLabel);
            } else {
                tm.removeLabel(this._textLabel);
                this._textLabel = null;
                if (this._title) this._textLabel = tm.addLabel(this);
            }
        } else if (this._title) {
            this._textLabel = tm.addLabel(this);
        }
    }

    protected _isWithinView(): boolean {
        if (!this._map) return false;
        if (!this._userVisible) return false;
        if (this._layer && !(this._layer as any).visible) return false;
        const z = this._map.continuousZoom;
        return z >= this._minZoom && z <= this._maxZoom;
    }
}