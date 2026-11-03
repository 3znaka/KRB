/**
 * Marker — маркер на карте с поддержкой мутации после addTo().
 *
 * Изменения относительно предыдущей версии:
 *   - убрана @ts-nocheck, добавлены типы;
 *   - добавлены сеттеры: setLngLat, setIconUrl, setTooltip,
 *     setTitle, setVisible;
 *   - getLngLat() работает до addTo(), если известен CRS;
 *   - сеттеры возвращают `this` для чейнинга.
 *
 * @module marker
 */

import { Projections } from './Projections.js';
import { THREE } from './js_TP/tpb.js';
import { Layer } from './Layers.js';

// =====================================================================
// Типы
// =====================================================================

export type LonLat = [number, number];
export type CoordXY = [number, number];
export type IconSize = [number, number];
export type Anchor = [number, number];
export type TitleAlign = 'left' | 'center' | 'right';
export type AltitudeMode = 'ground' | 'clampToGround' | 'absolute';

export interface MarkerOptions {
    /** Координаты [x, y] в СК `crs` (по умолчанию — lon/lat WGS84). */
    position: LonLat;
    /** Код СК для `position`. По умолчанию — `map.inputCRS`. */
    crs?: string;
    iconSize?: IconSize;
    anchor?: Anchor;
    minZoom?: number;
    maxZoom?: number;
    altitudeMode?: AltitudeMode;
    altitude?: number;
    tooltip?: string;
    /** URL иконки. `null`/undefined → DEFAULT_ICON_URL (или без иконки — см. описание). */
    iconUrl?: string | null;
    onHover?: (hovered: boolean) => void;
    onClick?: (event: MouseEvent, marker: Marker) => void;
    title?: string;
    titleAlign?: TitleAlign;
    titleStyle?: Record<string, string | number>;
    titleMinZoom?: number;
    titleMaxZoom?: number;
    titleOffset?: Anchor | null;
    clusterable?: boolean;
    titleAllowOverflow?: boolean;
    titlePriority?: number;
}

interface MapPanes {
    markerPane: HTMLElement;
}

// =====================================================================
// Панели и дефолты
// =====================================================================

const _mapPanes = new WeakMap<object, MapPanes>();

const DEFAULT_ICON_URL = new URL('./img/marker.png', import.meta.url).href;

/**
 * Возвращает (и при необходимости создаёт) DOM-панель для маркеров,
 * связанную с конкретным экземпляром карты.
 */
export function _getPanes(map: { targetElement: HTMLElement }): MapPanes {
    let panes = _mapPanes.get(map);
    if (!panes) {
        const target = map.targetElement;
        const markerPane = document.createElement('div');
        markerPane.id = 'krb-marker-pane';
        Object.assign(markerPane.style, {
            position: 'absolute',
            top: '0',
            left: '0',
            width: '100%',
            height: '100%',
            pointerEvents: 'none',
            zIndex: '600',
        });
        target.appendChild(markerPane);
        panes = { markerPane };
        _mapPanes.set(map, panes);
    }
    return panes;
}

// =====================================================================
// Marker
// =====================================================================

/**
 * Маркер. После {@link Marker#addTo} объект мутабелен — можно менять
 * позицию, иконку, подпись, тултип и видимость без пересоздания.
 *
 * @example
 * const m = new Marker({ position: [37.66, 55.76], title: 'Точка' }).addTo(map);
 * m.setLngLat([30.31, 59.93]).setTitle('Питер');
 */
export class Marker {
    static _idCounter = 0;

    // ── Данные позиции ──
    private _coord: CoordXY;
    private _crsCode: string | null;
    private _crs: any | null;
    private _lon: number | null = null;
    private _lat: number | null = null;
    /** true, если _coord был записан из setLngLat() до attach без явного crs. */
    private _positionSetAsLonLat = false;

    // ── Оформление ──
    private _iconSize: IconSize;
    private _anchor: Anchor;
    private _iconUrl: string | null;

    // ── Поведение ──
    private _minZoom: number;
    private _maxZoom: number;
    private _altitudeMode: AltitudeMode;
    private _altitude: number;
    private _tooltipText: string;
    private _onHover: ((hovered: boolean) => void) | null;
    private _onClick: ((event: MouseEvent, marker: Marker) => void) | null;
    private _clusterable: boolean;

    // ── Подпись ──
    private _title: string;
    private _titleAlign: TitleAlign;
    private _titleStyle: Record<string, string | number>;
    private _titleMinZoom: number;
    private _titleMaxZoom: number;
    private _userTitleOffset: Anchor | null;
    private _titleOffset: Anchor | null = null;
    private _titleAllowOverflow: boolean;
    private _titlePriority: number;

    // ── Состояние ──
    private _map: any = null;
    private _layer: Layer | null = null;
    private _element: HTMLDivElement | null = null;
    private _textLabel: any = null;

    private _isMobile = false;
    private _lastHeightUpdateTime = 0;
    private _cachedWorldY = 0;

    /** Результат последнего _update; не путать с _userVisible. */
    private _isVisible = false;
    private _userVisible = true;
    private _lastScreenPos: { x: number; y: number } | null = null;

    private _hideTimeout: ReturnType<typeof setTimeout> | null = null;

    constructor(options: MarkerOptions) {
        if (!options.position || options.position.length !== 2) {
            throw new Error('Marker: options.position is required [x, y]');
        }
        this._coord = [options.position[0], options.position[1]];
        this._crsCode = options.crs ?? null;
        // Резолвим CRS сразу, если он явно задан — это позволяет
        // setLngLat/getLngLat работать до addTo().
        this._crs = this._crsCode ? Projections.get(this._crsCode) : null;

        this._iconSize = options.iconSize ?? [16, 16];
        this._anchor = options.anchor ?? [0.5, 1.0];
        this._minZoom = options.minZoom ?? -Infinity;
        this._maxZoom = options.maxZoom ?? Infinity;
        this._altitudeMode = options.altitudeMode ?? 'ground';
        this._altitude = options.altitude ?? 0;
        this._tooltipText = options.tooltip ?? '';
        this._iconUrl = options.iconUrl !== undefined ? options.iconUrl : DEFAULT_ICON_URL;
        this._onHover = options.onHover ?? null;
        this._onClick = options.onClick ?? null;
        this._clusterable = options.clusterable !== undefined ? options.clusterable : true;

        this._title = options.title ?? '';
        this._titleAlign = options.titleAlign ?? 'center';
        this._titleStyle = options.titleStyle ?? {};
        this._titleMinZoom = options.titleMinZoom ?? -Infinity;
        this._titleMaxZoom = options.titleMaxZoom ?? Infinity;
        this._userTitleOffset = options.titleOffset ?? null;
        this._titleAllowOverflow = options.titleAllowOverflow ?? false;
        this._titlePriority = options.titlePriority ?? 0;
    }

    // =================================================================
    // Присоединение / отсоединение
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

        const newCrs: any = this._crsCode
            ? Projections.get(this._crsCode)
            : map.inputCRS;

        // Если setLngLat() вызывался до attach без явного crs,
        // _coord хранится в EPSG:4326. Пересчитываем, если inputCRS другой.
        if (this._positionSetAsLonLat
            && this._lon !== null
            && this._lat !== null
            && (!newCrs || !newCrs.code || newCrs.code !== 'EPSG:4326')) {
            const conv = newCrs.fromLonLat([this._lon, this._lat]);
            this._coord[0] = conv[0];
            this._coord[1] = conv[1];
        }
        this._positionSetAsLonLat = false;
        this._crs = newCrs;

        // Производные WGS84 — для обратной совместимости с ClusterLayer
        // и внешним кодом, читающим marker._lon / marker._lat.
        const ll = this._crs.toLonLat(this._coord);
        this._lon = ll[0];
        this._lat = ll[1];

        this._isMobile = window.matchMedia('(hover: none) and (pointer: coarse)').matches;

        this._titleOffset = this._userTitleOffset
            ? [...this._userTitleOffset]
            : [0, this._iconSize[1] / 2 + 4];

        const { markerPane } = _getPanes(map);
        const markerId = `krb-marker-${++Marker._idCounter}`;

        const el = document.createElement('div');
        el.id = markerId;
        el.className = 'krb-marker';
        Object.assign(el.style, {
            position: 'absolute',
            width: `${this._iconSize[0]}px`,
            height: `${this._iconSize[1]}px`,
            transform: `translate(${-this._anchor[0] * 100}%, ${-this._anchor[1] * 100}%)`,
            pointerEvents: 'auto',
            cursor: 'pointer',
            display: 'none',
            transition: 'opacity 0.08s linear',
            opacity: '0',
        });
        if (this._iconUrl) {
            const img = document.createElement('img');
            img.src = this._iconUrl;
            Object.assign(img.style, {
                width: '100%',
                height: '100%',
                display: 'block',
                userSelect: 'none',
            });
            img.draggable = false;
            el.appendChild(img);
        }
        markerPane.appendChild(el);
        this._element = el;

        if (this._title && this._map.textManager) {
            this._textLabel = this._map.textManager.addLabel(this);
        }

        if (this._isMobile) {
            el.addEventListener('click', (e) => {
                e.stopPropagation();
                if (this._onClick) this._onClick(e, this);
                else this._defaultClickAction();
            });
        } else {
            if (this._onHover) {
                el.addEventListener('pointerenter', () => this._onHover?.(true));
                el.addEventListener('pointerleave', () => this._onHover?.(false));
            } else {
                el.addEventListener('pointerenter', () => {
                    if (this._tooltipText && this._map?.popupManager) {
                        this._map.popupManager.show(this, this._tooltipText);
                    }
                });
                el.addEventListener('pointerleave', () => {
                    if (this._map?.popupManager) this._map.popupManager.hide();
                });
            }
            el.addEventListener('click', (e) => {
                e.stopPropagation();
                if (this._onClick) this._onClick(e, this);
                else this._defaultClickAction();
            });
        }
    }

    _defaultClickAction(): void {
        if (this._map && this._crs) {
            const [lon, lat] = this._crs.toLonLat(this._coord);
            this._map.moveCameraToSlow(lon, lat, 0.3);
        }
        if (this._isMobile && this._tooltipText && this._map?.popupManager) {
            this._map.popupManager.show(this, this._tooltipText);
        }
    }

    remove(): void {
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
            (this._layer as any)._removeRef(this);
            this._layer = null;
        }
        this._map = null;
        this._crs = null;
        this._isVisible = false;
        this._lastScreenPos = null;
        // ВАЖНО: _lon/_lat НЕ обнуляем — при повторном attach
        // их можно использовать для пересчёта _coord.
    }

    // =================================================================
    // Мутабельность
    // =================================================================

    /**
     * Устанавливает позицию в WGS84 [lon, lat].
     * Работает до и после addTo(). Если маркер ещё не присоединён и
     * у него нет явного `crs`, позиция временно трактуется как EPSG:4326
     * и пересчитывается в `map.inputCRS` при attach.
     */
    setLngLat(lonLat: LonLat): this {
        if (!lonLat || lonLat.length !== 2) return this;
        const crs = this._resolveCrs() ?? Projections.get('EPSG:4326');
        const conv = crs.fromLonLat(lonLat);
        this._coord[0] = conv[0];
        this._coord[1] = conv[1];
        this._lon = lonLat[0];
        this._lat = lonLat[1];
        this._positionSetAsLonLat = !this._crs && !this._crsCode;
        this._afterPositionChange();
        return this;
    }

    /**
     * Координаты в WGS84. Работает до addTo(), если у маркера есть
     * явный `crs` или вызывался setLngLat(). В остальных случаях
     * (до attach без crs) — `null`.
     */
    getLngLat(): LonLat | null {
        if (this._lon !== null && this._lat !== null) {
            return [this._lon, this._lat];
        }
        const crs = this._resolveCrs();
        if (!crs) return null;
        const ll = crs.toLonLat(this._coord);
        return [ll[0], ll[1]];
    }

    /**
 * Координаты в WGS84 [lon, lat] или `null`, если CRS неизвестна
 * (маркер не присоединён и нет явного crs, либо setLngLat не вызывался).
 *
 * Синоним {@link Marker#getLngLat}. Оставлен для обратной совместимости
 * со старой версией `Marker.getLonLat()`.
 */
getLonLat(): LonLat | null {
    return this.getLngLat();
}

    /** Меняет URL иконки (или убирает иконку при `null`). */
    setIconUrl(url: string | null): this {
        this._iconUrl = url;
        if (!this._element) return this;

        const img = this._element.querySelector('img') as HTMLImageElement | null;
        if (url) {
            if (img) {
                img.src = url;
            } else {
                const newImg = document.createElement('img');
                newImg.src = url;
                Object.assign(newImg.style, {
                    width: '100%',
                    height: '100%',
                    display: 'block',
                    userSelect: 'none',
                });
                newImg.draggable = false;
                this._element.appendChild(newImg);
            }
        } else if (img) {
            img.remove();
        }
        return this;
    }

    /** Меняет текст тултипа (HTML). Пустая строка — отключить тултип. */
    setTooltip(html: string): this {
        this._tooltipText = html ?? '';
        return this;
    }

    /** Меняет постоянную подпись. */
    setTitle(text: string): this {
        const next = text ?? '';
        if (this._title === next) return this;
        this._title = next;
        this._refreshTextLabel();
        return this;
    }

    /** Управляет видимостью маркера (независимо от зума и кластеризации). */
    setVisible(visible: boolean): this {
        this._userVisible = !!visible;
        if (!this._userVisible) {
            this._setVisible(false);
            this._isVisible = false;
        }
        return this;
    }

    // =================================================================
    // Внутренние хелперы мутабельности
    // =================================================================

    /** Резолвит CRS маркера, если он известен без map. */
    private _resolveCrs(): any {
        if (this._crs) return this._crs;
        if (this._crsCode) {
            this._crs = Projections.get(this._crsCode);
            return this._crs;
        }
        return null;
    }

    /**
     * Сбрасывает кэши позиции. Следующий _update() пересчитает
     * экранную позицию и (если нужно) высоту рельефа.
     */
    private _afterPositionChange(): void {
        this._lastScreenPos = null;
        this._cachedWorldY = 0;
        this._lastHeightUpdateTime = 0;
    }

    /** Пересоздаёт дескриптор подписи в TextManager. */
private _refreshTextLabel(): void {
    if (!this._map?.textManager) return;
    if (this._textLabel) {
        this._map.textManager.updateLabel(this._textLabel);
    } else if (this._title) {
        this._textLabel = this._map.textManager.addLabel(this);
    }
}

    // =================================================================
    // Видимость (внутренняя)
    // =================================================================

    _setVisible(visible: boolean): void {
        const el = this._element;
        if (!el) return;

        if (visible) {
            if (this._hideTimeout) {
                clearTimeout(this._hideTimeout);
                this._hideTimeout = null;
            }
            if (el.style.display === 'none') {
                el.style.display = 'block';
                el.style.opacity = '0';
                void el.offsetWidth;
                el.style.opacity = '1';
            } else {
                el.style.opacity = '1';
            }
        } else {
            if (el.style.display === 'none') return;
            el.style.opacity = '0';
            if (this._hideTimeout) clearTimeout(this._hideTimeout);
            this._hideTimeout = setTimeout(() => {
                if (el.style.opacity === '0') {
                    el.style.display = 'none';
                }
                this._hideTimeout = null;
            }, 80);
        }
    }

    // =================================================================
    // Обновление позиции на экране
    // =================================================================

    _update(_map?: any): void {
        const map = this._map;
        if (!map || !this._element) return;
        if (!this._userVisible) {
            this._setVisible(false);
            this._isVisible = false;
            return;
        }

        const zoom = map.continuousZoom;

        if (this._layer && (this._layer as any)._clusterActive) {
            const vis = (this._layer as any)._clusterVisibleMarkers as Set<Marker> | undefined;
            if (!vis || !vis.has(this)) {
                this._setVisible(false);
                this._isVisible = false;
                return;
            }
        }

        if (this._layer && !(this._layer as any).visible) {
            this._setVisible(false);
            this._isVisible = false;
            return;
        }

        if (zoom < this._minZoom || zoom > this._maxZoom) {
            this._setVisible(false);
            this._isVisible = false;
            return;
        }

        const [absWorldX, absWorldZ] = map.project(this._coord, this._crs);
        const wgPos = map.worldGroup.position;
        const worldX = absWorldX + wgPos.x;
        const worldZ = absWorldZ + wgPos.z;
        let worldY = 0;

        switch (this._altitudeMode) {
            case 'absolute':
                worldY = this._altitude;
                break;
            case 'clampToGround': {
                const now = performance.now();
                if (now - this._lastHeightUpdateTime > 500) {
                    map.ensureTileForPoint(worldX, worldZ);
                    this._cachedWorldY = map.getSurfaceHeightAt(worldX, worldZ);
                    this._lastHeightUpdateTime = now;
                }
                worldY = this._cachedWorldY;
                break;
            }
            case 'ground':
            default:
                worldY = 0;
                break;
        }

        const worldPos = new THREE.Vector3(worldX, worldY + wgPos.y, worldZ);

        if (map.view.objectRenderDistanceFactor > 0) {
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

        const canvas = map.renderer.domElement;
        const x = (screenPos.x * 0.5 + 0.5) * canvas.clientWidth;
        const y = (-screenPos.y * 0.5 + 0.5) * canvas.clientHeight;

        this._element.style.left = `${x}px`;
        this._element.style.top = `${y}px`;
        this._setVisible(true);

        this._lastScreenPos = { x, y };
        this._isVisible = true;
    }

    // =================================================================
    // TextManager contract
    // =================================================================

    getText(): string { return this._title; }

    getTextStyle(): Record<string, string | number> {
        return Object.assign(
            {
                fontFamily: 'sans-serif',
                color: '#333',
                fontSize: '12px',
                textAlign: this._titleAlign,
            },
            this._titleStyle
        );
    }

    getTextZoomBounds(): { min: number; max: number } {
        return { min: this._titleMinZoom, max: this._titleMaxZoom };
    }

    getLabelType(): 'point' { return 'point'; }

    isVisible(): boolean { return this._isVisible; }

    getScreenPosition(): { x: number; y: number } | null {
        return this._isVisible ? this._lastScreenPos : null;
    }

    getTitleAlign(): TitleAlign { return this._titleAlign; }

    getTitleOffset(): Anchor | null { return this._titleOffset; }

    getTitleVerticalAlign(): 'center' { return 'center'; }

    getAllowOverflow(): boolean { return this._titleAllowOverflow; }

    getPriority(): number { return this._titlePriority; }

    // =================================================================
    // Публичные геттеры
    // =================================================================

    /** Возвращает исходные координаты в собственной СК маркера. */
    getPosition(): CoordXY {
        return [this._coord[0], this._coord[1]];
    }

    /** Возвращает код СК маркера или null. */
    getCRS(): string | null {
        return this._crsCode;
    }

    // =================================================================
    // Интерфейс для KrbMap#fitTo / getBounds
    // =================================================================

    getBounds(crs: string | any = 'EPSG:4326'): [CoordXY, CoordXY] | null {
        const src = this._crs
            ?? (this._crsCode ? Projections.get(this._crsCode) : Projections.get('EPSG:4326'));
        const dst = typeof crs === 'string' ? Projections.get(crs) : crs;
        if (!src || !dst) return null;

        let x: number, y: number;
        if (src === dst) {
            x = this._coord[0];
            y = this._coord[1];
        } else {
            const lonLat = src.toLonLat(this._coord);
            const conv = dst.fromLonLat(lonLat);
            x = conv[0];
            y = conv[1];
        }
        return [[x, y], [x, y]];
    }
}