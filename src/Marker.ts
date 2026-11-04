/**
 * Marker — маркер на карте с поддержкой мутации после addTo().
 *
 * Наследует SpatialObject: zoom bounds, видимость, tooltip, onClick,
 * onHover, подпись, altitude и TextManager-контракт берутся из базового
 * класса. Здесь остаётся только то, что специфично для DOM-маркера:
 * CRS/позиция, иконка (размер / anchor / поворот), altitudeMode,
 * кластеризация, DOM-элемент и DOM-события.
 *
 * @module marker
 */

import { Projections } from './Projections.js';
import { THREE } from './js_TP/tpb.js';
import { SpatialObject, TitleAlignH, ZoomInterpolation } from './SpatialObject.js';

// =====================================================================
// Типы
// =====================================================================

export type LonLat = [number, number];
export type CoordXY = [number, number];
export type IconSize = [number, number];
export type Anchor = [number, number];
export type TitleAlign = TitleAlignH;
export type AltitudeMode = 'ground' | 'clampToGround' | 'absolute';

export interface MarkerOptions {
    /** Координаты [x, y] в СК `crs` (по умолчанию — lon/lat WGS84). */
    position: LonLat;
    /** Код СК для `position`. По умолчанию — `map.inputCRS`. */
    crs?: string;
    iconSize?: IconSize;
    anchor?: Anchor;
    /** Поворот иконки в градусах (CSS `rotate`). */
    rotation?: number;
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
    properties?: Record<string, any>;
userData?: Record<string, any>;
    zoomInterpolate?: ZoomInterpolation | null;
}

interface MapPanes {
    markerPane: HTMLElement;
}

// =====================================================================
// Панели и дефолты
// =====================================================================

const _mapPanes = new WeakMap<object, MapPanes>();

const DEFAULT_ICON_URL = new URL('./img/marker.png', import.meta.url).href;

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

const _elementToMarker = new WeakMap<HTMLElement, Marker>();

/** Возвращает Marker по DOM-элементу иконки (или null). */
export function _getMarkerFromElement(el: HTMLElement | null | undefined): Marker | null {
    if (!el) return null;
    return _elementToMarker.get(el) ?? null;
}

// =====================================================================
// Marker
// =====================================================================

export class Marker extends SpatialObject {
    static _idCounter = 0;

    // ── Данные позиции ──
    private _coord: CoordXY;
    private _crsCode: string | null;
    private _crs: any | null;
    private _lon: number | null = null;
    private _lat: number | null = null;
    private _positionSetAsLonLat = false;

    // ── Оформление ──
    private _iconSize: IconSize;
    private _anchor: Anchor;
    private _rotation: number;
    private _iconUrl: string | null;

    // ── Поведение ── (altitude — в базе)
    private _altitudeMode: AltitudeMode;
    private _clusterable: boolean;

    // ── Состояние DOM ──
    private _element: HTMLDivElement | null = null;
    private _isMobile = false;
    private _lastHeightUpdateTime = 0;
    private _cachedWorldY = 0;
    private _hideTimeout: ReturnType<typeof setTimeout> | null = null;

    constructor(options: MarkerOptions) {
        super();

        if (options.zoomInterpolate) this.setZoomInterpolations(options.zoomInterpolate);

        this._properties = options.properties ?? {};
this._userData = options.userData ?? {};

        if (!options.position || options.position.length !== 2) {
            throw new Error('Marker: options.position is required [x, y]');
        }
        this._coord = [options.position[0], options.position[1]];
        this._crsCode = options.crs ?? null;
        this._crs = this._crsCode ? Projections.get(this._crsCode) : null;

        this._iconSize = options.iconSize ?? [16, 16];
        this._anchor = options.anchor ?? [0.5, 1.0];
        this._rotation = options.rotation ?? 0;
        this._minZoom = options.minZoom ?? -Infinity;
        this._maxZoom = options.maxZoom ?? Infinity;
        this._altitudeMode = options.altitudeMode ?? 'ground';
        this._altitude = options.altitude ?? 0;
        this._iconUrl = options.iconUrl !== undefined ? options.iconUrl : DEFAULT_ICON_URL;
        this._onHover = options.onHover ?? null;
        this._onClick = options.onClick ?? null;
        this._clusterable = options.clusterable !== undefined ? options.clusterable : true;
        this._tooltipText = options.tooltip ?? '';

        this._title = options.title ?? '';
        this._titleAlign = options.titleAlign ?? 'center';
        this._titleStyle = options.titleStyle ?? {};
        this._titleMinZoom = options.titleMinZoom ?? -Infinity;
        this._titleMaxZoom = options.titleMaxZoom ?? Infinity;
        this._userTitleOffset = options.titleOffset ? [...options.titleOffset] : null;
        this._titleAllowOverflow = options.titleAllowOverflow ?? false;
        this._titlePriority = options.titlePriority ?? 0;
        this._resolveTitleOffset();
    }

    // =================================================================
    // Хуки SpatialObject
    // =================================================================

    protected _onAttached(map: any): void {
        const newCrs: any = this._crsCode
            ? Projections.get(this._crsCode)
            : map.inputCRS;

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

        const ll = this._crs.toLonLat(this._coord);
        this._lon = ll[0];
        this._lat = ll[1];

        this._isMobile = window.matchMedia('(hover: none) and (pointer: coarse)').matches;

        const { markerPane } = _getPanes(map);
        const markerId = `krb-marker-${++Marker._idCounter}`;

        const el = document.createElement('div');
        el.id = markerId;
        el.className = 'krb-marker';
        Object.assign(el.style, {
            position: 'absolute',
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
        _elementToMarker.set(el, this);

        this._applyStyleTransforms();

        el.addEventListener('click', (e) => {
            e.stopPropagation();
            if (this._onClick) this._onClick(e, this);
            else this._defaultClickAction();
        });

        if (!this._isMobile) {
            el.addEventListener('pointerenter', () => {
                if (this._onHover) {
                    this._onHover(true);
                } else if (this._tooltipText && this._map?.popupManager) {
                    this._map.popupManager.show(this, this._tooltipText);
                }
            });
            el.addEventListener('pointerleave', () => {
                if (this._onHover) {
                    this._onHover(false);
                } else if (this._map?.popupManager) {
                    this._map.popupManager.hide();
                }
            });
        }
    }

    protected _teardown(): void {
        if (this._hideTimeout) {
            clearTimeout(this._hideTimeout);
            this._hideTimeout = null;
        }
        if (this._element) {
            if (this._element) _elementToMarker.delete(this._element);
            this._element.remove();
            this._element = null;
        }
    }

    protected _applyHidden(): void {
        this._setVisible(false);
    }

    protected _defaultTitleOffset(): [number, number] {
        return [0, this._iconSize[1] / 2 + 4];
    }

    /** Смена высоты должна пересчитать кэши позиции. */
    protected _onAltitudeChanged(): void {
        this._afterPositionChange();
    }

    getLabelType(): 'point' { return 'point'; }

    // =================================================================
    // Позиция / CRS / bounds
    // =================================================================

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

    getLngLat(): LonLat | null {
        if (this._lon !== null && this._lat !== null) {
            return [this._lon, this._lat];
        }
        const crs = this._resolveCrs();
        if (!crs) return null;
        const ll = crs.toLonLat(this._coord);
        return [ll[0], ll[1]];
    }

    getLonLat(): LonLat | null {
        return this.getLngLat();
    }

    getPosition(): CoordXY {
        return [this._coord[0], this._coord[1]];
    }

    getCRS(): string | null {
        return this._crsCode;
    }

    getCenter(): LonLat | null {
        return this.getLngLat();
    }

    // =================================================================
    // Иконка: URL / размер / anchor / поворот
    // =================================================================

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

    setIconSize(size: IconSize): this {
        if (!size || size.length !== 2) return this;
        this._iconSize = [size[0], size[1]];
        this._applyStyleTransforms();
        this._resolveTitleOffset();
        return this;
    }

    getIconSize(): IconSize {
        return [this._iconSize[0], this._iconSize[1]];
    }

    setAnchor(anchor: Anchor): this {
        if (!anchor || anchor.length !== 2) return this;
        this._anchor = [anchor[0], anchor[1]];
        this._applyStyleTransforms();
        return this;
    }

    getAnchor(): Anchor {
        return [this._anchor[0], this._anchor[1]];
    }

    setRotation(degrees: number): this {
        this._rotation = Number.isFinite(degrees) ? degrees : 0;
        this._applyStyleTransforms();
        return this;
    }

    getRotation(): number {
        return this._rotation;
    }

    // =================================================================
    // Altitude MODE (setAltitude/getAltitude — в базе)
    // =================================================================

    setAltitudeMode(mode: AltitudeMode): this {
        this._altitudeMode = mode;
        this._afterPositionChange();
        return this;
    }

    getAltitudeMode(): AltitudeMode {
        return this._altitudeMode;
    }

    // =================================================================
    // Кластеризация
    // =================================================================

    getClusterable(): boolean {
        return this._clusterable;
    }

    // =================================================================
    // Внутренние хелперы
    // =================================================================

    private _resolveCrs(): any {
        if (this._crs) return this._crs;
        if (this._crsCode) {
            this._crs = Projections.get(this._crsCode);
            return this._crs;
        }
        return null;
    }

    private _afterPositionChange(): void {
        this._lastScreenPos = null;
        this._cachedWorldY = 0;
        this._lastHeightUpdateTime = 0;
    }

    private _defaultClickAction(): void {
        if (this._map && this._crs) {
            const [lon, lat] = this._crs.toLonLat(this._coord);
            this._map.moveCameraToSlow(lon, lat, 0.3);
        }
        if (this._isMobile && this._tooltipText && this._map?.popupManager) {
            this._map.popupManager.show(this, this._tooltipText);
        }
    }

    private _applyStyleTransforms(): void {
        const el = this._element;
        if (!el) return;
        const [ax, ay] = this._anchor;
        el.style.width = `${this._iconSize[0]}px`;
        el.style.height = `${this._iconSize[1]}px`;
        el.style.transformOrigin = `${ax * 100}% ${ay * 100}%`;
        el.style.transform =
            `translate(${-ax * 100}%, ${-ay * 100}%) rotate(${this._rotation}deg)`;
    }

    // =================================================================
    // Видимость (DOM-специфичная)
    // =================================================================

    private _setVisible(visible: boolean): void {
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
    // Обновление на кадре
    // =================================================================

    _update(_map?: any): void {
        const map = this._map;
        this._applyZoomInterpolations(map.continuousZoom);
        if (!map || !this._element) return;

        // Кластерная видимость — особенность Marker.
        if (this._layer && (this._layer as any)._clusterActive) {
            const vis = (this._layer as any)._clusterVisibleMarkers as Set<Marker> | undefined;
            if (!vis || !vis.has(this)) {
                this._applyHidden();
                this._isVisible = false;
                return;
            }
        }

        if (!this._isWithinView()) {
            this._applyHidden();
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
                worldY = this._cachedWorldY + this._altitude;
                break;
            }
            case 'ground':
            default:
                worldY = this._altitude;
                break;
        }

        const worldPos = new THREE.Vector3(worldX, worldY + wgPos.y, worldZ);

        if (map.view.objectRenderDistanceFactor > 0) {
            const dist = map.camera.position.distanceTo(worldPos);
            if (dist > map.maxObjectDistance) {
                this._applyHidden();
                this._isVisible = false;
                return;
            }
        }

        const screenPos = worldPos.clone().project(map.camera);
        if (screenPos.z > 1 || Math.abs(screenPos.x) > 1 || Math.abs(screenPos.y) > 1) {
            this._applyHidden();
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
    // KrbMap#fitTo / getBounds
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