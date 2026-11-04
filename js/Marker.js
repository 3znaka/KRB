/**
 * Marker — маркер на карте с поддержкой мутации после addTo().
 *
 * Наследует SpatialObject: zoom bounds, видимость, tooltip, onClick,
 * onHover, подпись, altitude и TextManager-контракт берутся из базового
 * класса. Здесь остаётся только то, что специфично для маркера:
 * CRS/позиция, иконка (размер / anchor / поворот), altitudeMode,
 * кластеризация.
 *
 * Иконка маркера рендерится через TextManager — тем же путём, что и
 * иконки POI векторных тайлов. Это даёт единый collision-check и
 * приоритезацию между маркерами и POI (см. getPriority()).
 *
 * @module marker
 */
import { Projections } from './Projections.js';
import { THREE } from './js_TP/tpb.js';
import { SpatialObject } from './SpatialObject.js';
const _mapPanes = new WeakMap();
const DEFAULT_ICON_URL = new URL('./img/marker.png', import.meta.url).href;
/**
 * @deprecated Панель маркеров больше не используется — иконки
 * рендерятся через TextManager. Оставлено для совместимости.
 */
export function _getPanes(map) {
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
const _elementToMarker = new WeakMap();
/** Возвращает Marker по DOM-элементу (label или .krb-icon) или null. */
export function _getMarkerFromElement(el) {
    if (!el)
        return null;
    return _elementToMarker.get(el) ?? null;
}
// =====================================================================
// Marker
// =====================================================================
export class Marker extends SpatialObject {
    /** Счётчик для внутренних нужд (оставлен для обратной совместимости). */
    static _idCounter = 0;
    // ── Данные позиции ──
    _coord;
    _crsCode;
    _crs;
    _lon = null;
    _lat = null;
    _positionSetAsLonLat = false;
    // ── Оформление ──
    _iconSize;
    _anchor;
    _rotation;
    _iconUrl;
    _iconPriority = null;
    // ── Поведение ── (altitude — в базе)
    _altitudeMode;
    _clusterable;
    // ── Состояние ──
    _isMobile = false;
    _lastHeightUpdateTime = 0;
    _cachedWorldY = 0;
    constructor(options) {
        super();
        if (options.zoomInterpolate)
            this.setZoomInterpolations(options.zoomInterpolate);
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
        this._iconPriority = options.iconPriority ?? null;
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
    // Override _attach: label создаётся всегда, даже при пустом title
    // (иконка маркера рендерится через TextManager).
    // =================================================================
    _attach(map, layer) {
        if (this._map === map && this._layer === layer)
            return;
        this.remove();
        this._map = map;
        this._layer = layer;
        this._resolveTitleOffset();
        this._onAttached(map);
        if (map.textManager) {
            this._textLabel = map.textManager.addLabel(this);
            this._bindLabelDomEvents();
        }
    }
    // =================================================================
    // Хуки SpatialObject
    // =================================================================
    _onAttached(map) {
        const newCrs = this._crsCode
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
    }
    _teardown() {
        // Убираем записи _elementToMarker; сам DOM-элемент удалит
        // SpatialObject.remove() через textManager.removeLabel().
        const el = this._textLabel?.element;
        if (el) {
            _elementToMarker.delete(el);
            const iconEl = el.querySelector('.krb-icon');
            if (iconEl)
                _elementToMarker.delete(iconEl);
        }
        this._isVisible = false;
        this._lastScreenPos = null;
    }
    _applyHidden() {
        this._isVisible = false;
    }
    _defaultTitleOffset() {
        // Позиционирование относительно иконки обеспечивает
        // _computeAnchor через _iconAnchorX/Y. Дополнительный offset
        // по умолчанию не нужен.
        return [0, 0];
    }
    /** Смена высоты должна пересчитать кэши позиции. */
    _onAltitudeChanged() {
        this._afterPositionChange();
    }
    getLabelType() { return 'point'; }
    // =================================================================
    // Позиция / CRS / bounds
    // =================================================================
    setLngLat(lonLat) {
        if (!lonLat || lonLat.length !== 2)
            return this;
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
    getLngLat() {
        if (this._lon !== null && this._lat !== null) {
            return [this._lon, this._lat];
        }
        const crs = this._resolveCrs();
        if (!crs)
            return null;
        const ll = crs.toLonLat(this._coord);
        return [ll[0], ll[1]];
    }
    getLonLat() {
        return this.getLngLat();
    }
    getPosition() {
        return [this._coord[0], this._coord[1]];
    }
    getCRS() {
        return this._crsCode;
    }
    getCenter() {
        return this.getLngLat();
    }
    // =================================================================
    // Иконка: URL / размер / anchor / поворот
    // =================================================================
    setIconUrl(url) {
        const wasNull = this._iconUrl === null;
        const willBeNull = url === null;
        this._iconUrl = url;
        // Смена "иконка ↔ без иконки" меняет структуру DOM-узла внутри
        // label, поэтому требует пересоздания label.
        if (wasNull !== willBeNull)
            this._rebuildLabel();
        else
            this._refreshLabel(true);
        return this;
    }
    setIconSize(size) {
        if (!size || size.length !== 2)
            return this;
        this._iconSize = [size[0], size[1]];
        this._refreshLabel(true);
        return this;
    }
    getIconSize() {
        return [this._iconSize[0], this._iconSize[1]];
    }
    setAnchor(anchor) {
        if (!anchor || anchor.length !== 2)
            return this;
        this._anchor = [anchor[0], anchor[1]];
        this._refreshLabel(true);
        return this;
    }
    getAnchor() {
        return [this._anchor[0], this._anchor[1]];
    }
    setRotation(degrees) {
        this._rotation = Number.isFinite(degrees) ? degrees : 0;
        this._refreshLabel(true);
        return this;
    }
    getRotation() {
        return this._rotation;
    }
    /** Приоритет иконки для разрешения коллизий. */
    getIconPriority() {
        return this._iconPriority ?? this._titlePriority;
    }
    setIconPriority(priority) {
        this._iconPriority = Number.isFinite(priority) ? priority : null;
        return this;
    }
    // =================================================================
    // Altitude MODE (setAltitude/getAltitude — в базе)
    // =================================================================
    setAltitudeMode(mode) {
        this._altitudeMode = mode;
        this._afterPositionChange();
        return this;
    }
    getAltitudeMode() {
        return this._altitudeMode;
    }
    // =================================================================
    // Кластеризация
    // =================================================================
    getClusterable() {
        return this._clusterable;
    }
    // =================================================================
    // TextManager-контракт: иконка + позиция подписи + приоритет
    // =================================================================
    getIcon() {
        if (!this._iconUrl)
            return null;
        const [w, h] = this._iconSize;
        return {
            name: 'marker',
            anchor: [this._anchor[0], this._anchor[1]],
            cssStyle: {
                display: 'inline-block',
                backgroundImage: `url("${this._iconUrl}")`,
                backgroundRepeat: 'no-repeat',
                backgroundSize: '100% 100%',
                width: `${w}px`,
                height: `${h}px`,
                transform: this._rotation ? `rotate(${this._rotation}deg)` : '',
                pointerEvents: 'auto',
                cursor: 'pointer',
            },
        };
    }
    getLabelPosition() {
        // Текст — под иконкой (соответствует старому titleOffset
        // [0, iconH/2 + 4] в горизонтальной компоновке).
        return 'bottom';
    }
    getPriority() {
        // Маркеры всегда выше POI: POI обычно имеют priority 0..20,
        // а маркеры получают +1000.
        return this.getIconPriority() + 1000;
    }
    // =================================================================
    // Внутренние хелперы
    // =================================================================
    _resolveCrs() {
        if (this._crs)
            return this._crs;
        if (this._crsCode) {
            this._crs = Projections.get(this._crsCode);
            return this._crs;
        }
        return null;
    }
    _afterPositionChange() {
        this._lastScreenPos = null;
        this._cachedWorldY = 0;
        this._lastHeightUpdateTime = 0;
        // Позиция изменилась — просим TextManager пересчитать визибилити
        // (иначе при неподвижной камере коллизии останутся устаревшими).
        const tm = this._map?.textManager;
        if (tm && this._textLabel) {
            tm.updateLabel(this._textLabel);
        }
    }
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
     * Обновляет содержимое label через TextManager, не пересоздавая
     * DOM. `refreshIcon = true` нужен, когда поменялись `_iconUrl`,
     * `_iconSize`, `_anchor` или `_rotation` — они упакованы в
     * `getIcon().cssStyle`.
     */
    _refreshLabel(refreshIcon = false) {
        const tm = this._map?.textManager;
        if (!tm || !this._textLabel)
            return;
        tm.updateLabel(this._textLabel, refreshIcon);
    }
    /**
     * Пересоздаёт label с нуля. Нужно, только если меняется структура
     * DOM внутри label (например, "появилась/исчезла иконка").
     */
    _rebuildLabel() {
        const tm = this._map?.textManager;
        if (!tm)
            return;
        if (this._textLabel) {
            tm.removeLabel(this._textLabel);
            this._textLabel = null;
        }
        this._textLabel = tm.addLabel(this);
        this._bindLabelDomEvents();
    }
    /**
     * Регистрирует DOM-элемент(ы) label в _elementToMarker и навешивает
     * обработчики событий на иконку. Вызывается один раз после
     * addLabel (и при _rebuildLabel).
     */
    _bindLabelDomEvents() {
        if (!this._textLabel)
            return;
        const labelEl = this._textLabel.element;
        if (!labelEl)
            return;
        _elementToMarker.set(labelEl, this);
        const iconEl = labelEl.querySelector('.krb-icon');
        if (iconEl) {
            _elementToMarker.set(iconEl, this);
            this._attachPointerHandlers(iconEl);
        }
    }
    _attachPointerHandlers(target) {
        target.addEventListener('click', (e) => {
            e.stopPropagation();
            if (this._onClick)
                this._onClick(e, this);
            else
                this._defaultClickAction();
        });
        if (!this._isMobile) {
            target.addEventListener('pointerenter', () => {
                if (this._onHover) {
                    this._onHover(true);
                }
                else if (this._tooltipText && this._map?.popupManager) {
                    this._map.popupManager.show(this, this._tooltipText);
                }
            });
            target.addEventListener('pointerleave', () => {
                if (this._onHover) {
                    this._onHover(false);
                }
                else if (this._map?.popupManager) {
                    this._map.popupManager.hide();
                }
            });
        }
    }
    // =================================================================
    // Обновление на кадре: только расчёт _lastScreenPos и _isVisible
    // =================================================================
    _update(_map) {
        const map = this._map;
        if (!map)
            return;
        this._applyZoomInterpolations(map.continuousZoom);
        if (!this._textLabel)
            return;
        // Кластерная видимость — особенность Marker.
        if (this._layer && this._layer._clusterActive) {
            const vis = this._layer._clusterVisibleMarkers;
            if (!vis || !vis.has(this)) {
                this._applyHidden();
                return;
            }
        }
        if (!this._isWithinView()) {
            this._applyHidden();
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
                return;
            }
        }
        const screenPos = worldPos.clone().project(map.camera);
        if (screenPos.z > 1 || Math.abs(screenPos.x) > 1 || Math.abs(screenPos.y) > 1) {
            this._applyHidden();
            return;
        }
        const canvas = map.renderer.domElement;
        const x = (screenPos.x * 0.5 + 0.5) * canvas.clientWidth;
        const y = (-screenPos.y * 0.5 + 0.5) * canvas.clientHeight;
        this._lastScreenPos = { x, y };
        this._isVisible = true;
    }
    // =================================================================
    // KrbMap#fitTo / getBounds
    // =================================================================
    getBounds(crs = 'EPSG:4326') {
        const src = this._crs
            ?? (this._crsCode ? Projections.get(this._crsCode) : Projections.get('EPSG:4326'));
        const dst = typeof crs === 'string' ? Projections.get(crs) : crs;
        if (!src || !dst)
            return null;
        let x, y;
        if (src === dst) {
            x = this._coord[0];
            y = this._coord[1];
        }
        else {
            const lonLat = src.toLonLat(this._coord);
            const conv = dst.fromLonLat(lonLat);
            x = conv[0];
            y = conv[1];
        }
        return [[x, y], [x, y]];
    }
}
