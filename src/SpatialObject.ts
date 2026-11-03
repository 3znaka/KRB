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

export type TitleAlignH = 'left' | 'center' | 'right';
export type TitleAlignV = 'top' | 'middle' | 'center' | 'bottom';

export abstract class SpatialObject {
    // ── Границы зума ──
    protected _minZoom: number = -Infinity;
    protected _maxZoom: number = Infinity;

    // ── Видимость ──
    protected _userVisible: boolean = true;
    /** Результат последнего _update — не путать с _userVisible. */
    protected _isVisible: boolean = false;
    protected _lastScreenPos: { x: number; y: number } | null = null;

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

    /** Создаёт персональный слой и добавляет в него объект. */
    addTo(map: any): this {
        if (this._map) this.remove();
        const personalLayer = new Layer();
        personalLayer.addTo(map);
        (personalLayer as any).add(this);
        return this;
    }

    /**
     * Шаблонный метод присоединения к карте. Подкласс реализует
     * `_onAttached(map)` — там создаются DOM/геометрия/слушатели.
     */
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

    /**
     * Шаблонный метод отсоединения. Подкласс реализует `_teardown()` —
     * там освобождаются ресурсы (DOM/меши/слушатели).
     */
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

    /** Создать/привязать ресурсы (DOM, геометрию, слушатели). */
    protected abstract _onAttached(map: any): void;

    /** Освободить ресурсы подкласса (DOM, меши, слушатели, GLTF). */
    protected abstract _teardown(): void;

    /** Скрыть визуальное представление (вызывается из `setVisible(false)`). */
    protected abstract _applyHidden(): void;

    /** Тип подписи для TextManager: 'point' | 'polygon' | 'line' | 'image' | 'area3d'. */
    abstract getLabelType(): string;

    /** Значение `titleOffset` по умолчанию (если пользователь не задал). */
    protected _defaultTitleOffset(): [number, number] {
        return [0, 0];
    }

    /**
     * Хук: вызывается после изменения tooltip/onClick/onHover, когда
     * объект уже присоединён к карте. Подклассы, использующие
     * `map.interaction`, здесь перерегистрируют интерактив. По умолчанию
     * — no-op (для объектов на DOM-событиях, как Marker).
     */
    protected _onTooltipChanged(): void { /* override if needed */ }

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

    /**
     * По умолчанию — последняя известная экранная позиция, пока объект
     * видим. Подклассы, которым нужно считать позицию по геометрии,
     * переопределяют.
     */
    getScreenPosition(): { x: number; y: number } | null {
        return this._isVisible ? this._lastScreenPos : null;
    }

    // =================================================================
    // Внутренние хелперы
    // =================================================================

    /** Вычисляет `_titleOffset` из `_userTitleOffset` или дефолта подкласса. */
    protected _resolveTitleOffset(): void {
        this._titleOffset = this._userTitleOffset
            ? [this._userTitleOffset[0], this._userTitleOffset[1]]
            : this._defaultTitleOffset();
    }

    /** Обновляет/пересоздаёт дескриптор подписи в TextManager. */
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

    /**
     * Общий входной гейт видимости: пользовательская видимость, видимость
     * слоя и границы зума. Кластерная видимость и прочие специфичные
     * проверки — в подклассах.
     */
    protected _isWithinView(): boolean {
        if (!this._map) return false;
        if (!this._userVisible) return false;
        if (this._layer && !(this._layer as any).visible) return false;
        const z = this._map.continuousZoom;
        return z >= this._minZoom && z <= this._maxZoom;
    }
}