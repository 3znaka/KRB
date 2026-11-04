// TextManager.ts

import { THREE } from './js_TP/tpb.js';

// =====================================================================
// Публичные типы
// =====================================================================

export type LabelType = 'point' | 'line' | 'line-curved' | 'polygon' | 'image' | 'area3d';
export type TitleAlignH = 'left' | 'center' | 'right';
export type TitleAlignV = 'top' | 'middle' | 'center' | 'bottom';
export type VariableAnchor =
    | 'center'
    | 'top' | 'bottom' | 'left' | 'right'
    | 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right';
export type IconPosition = 'left' | 'right' | 'top' | 'bottom';
export type LinePlacement = 'along' | 'horizontal' | 'center';

export interface LabelScreenPoint {
    x: number;
    y: number;
}

export interface IconOptions {
    name: string;
    scale?: number;
    bgColor?: string;
    circleScale?: number;
    glyphRatio?: number;
    offset?: [number, number];
    cssStyle?: any;
    sprite?: any;
}

export interface LabelBBox {
    minX: number;
    minY: number;
    maxX: number;
    maxY: number;
    perChar?: LabelBBox[];
}

export interface LineCandidate {
    t: number;
    isFlipped: boolean;
    bbox: LabelBBox;
}

export interface CharLayout {
    char: string;
    x: number;
    y: number;
    w: number;
    angle: number;
}

/**
 * Контракт между TextManager и источником подписи (Marker, VectorTileLayer
 * и т.п.).
 *
 * Обязательны только `getText`, `getTextStyle`, `getTextZoomBounds`,
 * `isVisible` и `getLabelType` — их код вызывает без `?.`. Остальное
 * опционально и проверяется на месте.
 *
 * Методы группы `line-*` нужны только источникам с
 * `getLabelType() === 'line' | 'line-curved'`.
 */
export interface LabelSource {
    // ── обязательные ──
    getText(): string;
    getTextStyle(): Record<string, string | number>;
    getTextZoomBounds(): { min: number; max: number };
    isVisible(): boolean;
    getLabelType(): LabelType;

    // ── опциональные (point / line) ──
    getPriority?(): number;
    getAllowOverflow?(): boolean;
    getScreenPosition?(): LabelScreenPoint | null;
    getTitleOffset?(): [number, number] | null;
    getTitleAlign?(): TitleAlignH;
    getTitleVerticalAlign?(): TitleAlignV;
    getTitleVariableAnchor?(): VariableAnchor[] | null;
    getLabelPosition?(): IconPosition;
    getIcon?(): IconOptions | null;
    getPlacement?(): LinePlacement;

    // ── только для линий ──
    getScreenPositionAt?(t: number): LabelScreenPoint | null;
    getScreenAngleAt?(t: number): number;
    getVisibleInterval?(): { min: number; max: number } | null;
    getLabelParameter?(): number;
    setLabelParameter?(t: number): void;
    getCandidates?(): LineCandidate[];
    getCandidateAtT?(t: number): LineCandidate | null;
    getCharLayoutAtT?(t: number, isFlipped: boolean): CharLayout[] | null;
    /** Внутренние методы LineLayer — оставляем `any`, чтобы не тянуть типы. */
    _getScreenData?(): any;
    _tToPx?(data: any, t: number): number;
    _samplePx?(data: any, px: number): LabelScreenPoint | null;
}

export interface Label {
    source: LabelSource;
    element: HTMLDivElement & { __lastTransform?: string };
    stableId: any | null;
    t: number;
    width: number;
    height: number;
    hiddenByPriority: boolean;
    priority: number;
    allowOverflow: boolean;
    _fontSize: number;
    _bbox: LabelBBox | null;
    _needsMeasure: boolean;
    _queuedForMeasure: boolean;
    _chosenT: number | null;
    _chosenIsFlipped: boolean;
    _pendingChosenT: number | null;
    _pendingChosenIsFlipped: boolean;
    _staleAt: number | null;
    _lastAnchor: LabelScreenPoint | null;
    _display: string;
    _hasIcon: boolean;
    _icon: IconOptions | null;
    _iconCenterX: number | null;
    _iconCenterY: number | null;
    _vectorOwner: any;
    _hideTimeout: ReturnType<typeof setTimeout> | null;
    rect?: LabelScreenPoint[];
    _cachedText: string;
    _cachedStyle: Record<string, string | number>;
    _chosenAnchor: VariableAnchor | null;
    /**
     * Кэш последней валидной экранной позиции. Заполняется в
     * `_updateVisibility`; используется `_getLabelCorners`, чтобы не
     * вызывать `getScreenPosition()` несколько раз для одного кадра
     * (например, при переборе variableAnchor-ов).
     */
    screenPos?: LabelScreenPoint | null;
}

export interface PruneStaleOptions {
    fade?: boolean;
    graceMs?: number;
}

// =====================================================================
// Пространственный индекс
// =====================================================================

class _GridIndex<T> {
    cellSize: number;
    grid: Map<string, T[]>;

    constructor(cellSize = 128) {
        this.cellSize = cellSize;
        this.grid = new Map();
    }

    _key(col: number, row: number): string {
        return col + ',' + row;
    }

    clear(): void {
        this.grid.clear();
    }

    insert(bbox: LabelBBox, value: T): void {
        const cs = this.cellSize;
        const c0 = Math.floor(bbox.minX / cs);
        const c1 = Math.floor(bbox.maxX / cs);
        const r0 = Math.floor(bbox.minY / cs);
        const r1 = Math.floor(bbox.maxY / cs);
        for (let c = c0; c <= c1; c++) {
            for (let r = r0; r <= r1; r++) {
                const k = this._key(c, r);
                let cell = this.grid.get(k);
                if (!cell) { cell = []; this.grid.set(k, cell); }
                cell.push(value);
            }
        }
    }

    query(bbox: LabelBBox): T[] {
        const cs = this.cellSize;
        const c0 = Math.floor(bbox.minX / cs);
        const c1 = Math.floor(bbox.maxX / cs);
        const r0 = Math.floor(bbox.minY / cs);
        const r1 = Math.floor(bbox.maxY / cs);
        const result: T[] = [];
        const seen = new Set<T>();
        for (let c = c0; c <= c1; c++) {
            for (let r = r0; r <= r1; r++) {
                const cell = this.grid.get(this._key(c, r));
                if (!cell) continue;
                for (let i = 0; i < cell.length; i++) {
                    const v = cell[i];
                    if (seen.has(v)) continue;
                    seen.add(v);
                    result.push(v);
                }
            }
        }
        return result;
    }
}

const STABLE_FRAMES = 5;
const OPACITY_MS = 80;
const OPACITY_CSS = `${OPACITY_MS}ms`;

// =====================================================================
// TextManager
// =====================================================================

export class TextManager {
    map: any;
    labels: Label[] = [];
    _labelsById: Map<any, Label> = new Map();
    pane: HTMLElement | null = null;
    maxLabels = 500;

    _gridIndex: _GridIndex<Label>;
    _measureQueue: Label[] = [];
    _measureScheduled = false;
    _dirty = true;

    _stableFrameCount = 0;
    _wasStable = false;

    _stableRefPos: any = null;
    _stableRefQ: any = null;
    _stableRefWp: any = null;
    _stableRefZoom: number | null = null;

    _lastMoved: boolean | null = null;

    _onKeyDown: (e: KeyboardEvent) => void;

    constructor(map: any) {
        this.map = map;
        this._gridIndex = new _GridIndex<Label>(128);

        this._initPane();

        this._onKeyDown = (e: KeyboardEvent) => {
            if (e.ctrlKey && e.shiftKey && e.code === 'KeyL') {
                this.debugLabels();
            }
        };
        window.addEventListener('keydown', this._onKeyDown);
    }

    setMaxLabels(max: number): void {
        if (typeof max === 'number' && max > 0) this.maxLabels = max;
    }

    getDebugStats(): {
        total: number;
        visible: number;
        hiddenByPriority: number;
        withIcon: number;
        maxLabels: number;
        stableIds: number;
        stableFrames: number;
        isStable: boolean;
    } {
        let visible = 0, hidden = 0, icons = 0;
        for (const l of this.labels) {
            if (l.hiddenByPriority) hidden++;
            else if (l.element && l.element.style.display !== 'none') visible++;
            if (l._hasIcon) icons++;
        }
        return {
            total: this.labels.length,
            visible,
            hiddenByPriority: hidden,
            withIcon: icons,
            maxLabels: this.maxLabels,
            stableIds: this._labelsById.size,
            stableFrames: this._stableFrameCount,
            isStable: this._stableFrameCount >= STABLE_FRAMES,
        };
    }

    _initPane(): void {
        const target: HTMLElement = this.map.targetElement;
        let pane = target.querySelector('#krb-label-pane') as HTMLElement | null;
        if (!pane) {
            pane = document.createElement('div');
            pane.id = 'krb-label-pane';
            Object.assign(pane.style, {
                position: 'absolute',
                top: '0', left: '0',
                width: '100%', height: '100%',
                pointerEvents: 'none',
                zIndex: '625',
            });
            target.appendChild(pane);
        }
        this.pane = pane;
    }

    dispose(): void {
        window.removeEventListener('keydown', this._onKeyDown);
        for (const label of this.labels) {
            if (label._hideTimeout) { clearTimeout(label._hideTimeout); label._hideTimeout = null; }
            if (label.element && label.element.parentNode) {
                label.element.parentNode.removeChild(label.element);
            }
        }
        this.labels.length = 0;
        this._labelsById.clear();
        this._measureQueue.length = 0;
        this._measureScheduled = false;
        if (this.pane && this.pane.parentNode) this.pane.parentNode.removeChild(this.pane);
        this.pane = null;
        this._dirty = true;
        this._gridIndex.clear();
        this._stableFrameCount = 0;
        this._wasStable = false;
        this._stableRefPos = null;
        this._stableRefQ = null;
        this._stableRefWp = null;
        this._stableRefZoom = null;
    }

    _resolveIconStyle(icon: IconOptions | null): any | null {
        if (!icon) return null;
        if (icon.cssStyle) return icon.cssStyle;

        const sprite = icon.sprite || (this.map && this.map.sprite);
        if (sprite && typeof sprite.cssStyle === 'function') {
            return sprite.cssStyle(
                icon.name,
                icon.scale || 1,
                icon.bgColor,
                icon.circleScale,
                icon.glyphRatio
            );
        }
        return null;
    }

    /**
     * Превращает `haloColor` / `haloWidth` / `haloBlur` из titleStyle в
     * CSS `text-shadow`. Явный `textShadow` в стиле имеет приоритет.
     */
    _applyHalo(style: Record<string, string | number>, el: HTMLElement): void {
        if (style.textShadow !== undefined) return;

        const color = style.haloColor ?? style.textHaloColor;
        const widthRaw = style.haloWidth ?? style.textHaloWidth;

        if (!color || widthRaw == null) {
            if ((el as any).__haloApplied) {
                el.style.textShadow = '';
                (el as any).__haloApplied = false;
            }
            return;
        }

        const w = Number(widthRaw);
        if (!(w > 0)) return;
        const blur = Number(style.haloBlur ?? style.textHaloBlur ?? 0);

        const parts = [
            `-${w}px -${w}px ${blur}px ${color}`,
            ` ${w}px -${w}px ${blur}px ${color}`,
            `-${w}px  ${w}px ${blur}px ${color}`,
            ` ${w}px  ${w}px ${blur}px ${color}`,
        ];
        el.style.textShadow = parts.join(', ');
        (el as any).__haloApplied = true;
    }

    _getVariableAnchors(label: Label): VariableAnchor[] | null {
        let raw: any = null;
        if (label.source.getTitleVariableAnchor) {
            raw = label.source.getTitleVariableAnchor();
        }
        if (raw == null) raw = label._cachedStyle?.variableAnchor;
        if (!raw) return null;

        let arr: VariableAnchor[];
        if (Array.isArray(raw)) arr = raw as VariableAnchor[];
        else if (typeof raw === 'string') {
            arr = raw.split(',').map(s => s.trim()) as VariableAnchor[];
        } else return null;
        if (!arr.length) return null;

        const cur = label._chosenAnchor;
        if (cur && arr.includes(cur)) {
            arr = [cur, ...arr.filter(a => a !== cur)];
        }
        return arr;
    }

    _setupIcon(el: HTMLDivElement, iconStyle: any, icon: IconOptions | null): void {
        let iconEl = el.querySelector('.krb-icon') as HTMLSpanElement | null;
        if (!iconEl) {
            iconEl = document.createElement('span');
            iconEl.className = 'krb-icon';
            el.insertBefore(iconEl, el.firstChild);
        }
        const off = (icon && icon.offset) || [0, 0];

        if (iconStyle._inner) {
            Object.assign(iconEl.style, {
                display: iconStyle.display,
                alignItems: iconStyle.alignItems,
                justifyContent: iconStyle.justifyContent,
                width: iconStyle.width,
                height: iconStyle.height,
                borderRadius: iconStyle.borderRadius,
                backgroundColor: iconStyle.backgroundColor,
                boxShadow: iconStyle.boxShadow,
                boxSizing: iconStyle.boxSizing,
                flex: '0 0 auto',
                transform: (off[0] || off[1]) ? `translate(${off[0]}px, ${off[1]}px)` : '',
            });

            let innerEl = iconEl.querySelector('.krb-icon-inner') as HTMLSpanElement | null;
            if (!innerEl) {
                innerEl = document.createElement('span');
                innerEl.className = 'krb-icon-inner';
                iconEl.appendChild(innerEl);
            }
            Object.assign(innerEl.style, iconStyle._inner);
        } else {
            const innerEl = iconEl.querySelector('.krb-icon-inner');
            if (innerEl) innerEl.remove();

            Object.assign(iconEl.style, {
                display: 'inline-block',
                flex: '0 0 auto',
                backgroundRepeat: 'no-repeat',
                backgroundImage: iconStyle.backgroundImage || '',
                backgroundPosition: iconStyle.backgroundPosition || '',
                backgroundSize: iconStyle.backgroundSize || '',
                width: iconStyle.width || '',
                height: iconStyle.height || '',
                transform: (off[0] || off[1]) ? `translate(${off[0]}px, ${off[1]}px)` : '',
            });
        }
    }

    _removeIcon(el: HTMLDivElement): void {
        const iconEl = el.querySelector('.krb-icon');
        if (iconEl) iconEl.remove();
    }

    addLabel(source: LabelSource, stableId: any = null, owner: any = null): Label {
        if (stableId != null) {
            const existing = this._labelsById.get(stableId);
            if (existing) {
                existing._vectorOwner = owner;
                if (existing._staleAt != null) existing._staleAt = null;
                this._updateLabelSource(existing, source);
                this._dirty = true;
                return existing;
            }
        }

        const type: LabelType = source.getLabelType ? source.getLabelType() : 'point';
        const isCurved = type === 'line-curved';

        const icon = (!isCurved && source.getIcon) ? source.getIcon() : null;
        const iconStyle = icon ? this._resolveIconStyle(icon) : null;
        const hasIcon = !!iconStyle;

        const initialText = source.getText ? source.getText() : '';
        const initialStyle = source.getTextStyle ? source.getTextStyle() : {};

        const el = document.createElement('div') as HTMLDivElement & { __lastTransform?: string };
        el.className = 'krb-text-label';
        Object.assign(el.style, {
            position: 'absolute',
            display: 'none',
            pointerEvents: 'none',
            whiteSpace: 'nowrap',
            fontFamily: 'sans-serif',
            color: '#333',
            fontSize: '12px',
            lineHeight: '1',
            padding: '0',
            margin: '0',
            transformOrigin: '0 0',
            left: '0',
            top: '0',
            willChange: this._lastMoved === false ? 'auto' : 'transform',
        });

        if (hasIcon) {
            const pos: IconPosition = source.getLabelPosition ? source.getLabelPosition() : 'right';
            let flexDirection: string;
            if (pos === 'left')        flexDirection = 'row-reverse';
            else if (pos === 'top')    flexDirection = 'column-reverse';
            else if (pos === 'bottom') flexDirection = 'column';
            else                       flexDirection = 'row';

            Object.assign(el.style, {
                display: 'inline-flex',
                flexDirection,
                alignItems: 'center',
                justifyContent: 'center',
                gap: '4px',
            });
            if (pos === 'top' || pos === 'bottom') {
                el.style.textAlign = 'center';
            }

            this._setupIcon(el, iconStyle, icon);
            if (initialText) {
                const textSpan = document.createElement('span');
                textSpan.className = 'krb-text';
                textSpan.style.whiteSpace = type === 'point' ? 'pre-line' : 'nowrap';
                textSpan.textContent = type === 'point'
                    ? this._wrapPointText(initialText, el.style.fontSize)
                    : initialText;
                el.appendChild(textSpan);
            }
        } else if (type === 'point') {
            el.style.whiteSpace = 'pre-line';
            el.textContent = this._wrapPointText(initialText, el.style.fontSize);
        } else if (!isCurved) {
            el.textContent = initialText;
        }

        Object.assign(el.style, initialStyle);
        this._applyHalo(initialStyle, el);
        el.style.transition = `opacity ${OPACITY_CSS} linear`;
        el.style.opacity = '0';

        this.pane!.appendChild(el);

        const label: Label = {
            source,
            element: el,
            stableId,
            t: 0,
            width: 0,
            height: 0,
            hiddenByPriority: true,
            priority: source.getPriority ? source.getPriority() : 0,
            allowOverflow: source.getAllowOverflow ? source.getAllowOverflow() : false,
            _fontSize: parseFloat(initialStyle.fontSize as string) || 12,
            _bbox: null,
            _needsMeasure: !isCurved,
            _queuedForMeasure: false,
            _chosenT: null,
            _chosenAnchor: null,
            _chosenIsFlipped: false,
            _pendingChosenT: null,
            _pendingChosenIsFlipped: false,
            _staleAt: null,
            _lastAnchor: null,
            _display: hasIcon ? 'inline-flex' : 'block',
            _hasIcon: hasIcon,
            _icon: icon || null,
            _iconCenterX: null,
            _iconCenterY: null,
            _vectorOwner: owner,
            _hideTimeout: null,
            _cachedText: initialText,
            _cachedStyle: { ...initialStyle },
            screenPos: null,
        };

        this.labels.push(label);
        if (stableId != null) this._labelsById.set(stableId, label);

        if (!isCurved) this._scheduleMeasure(label);

        this._dirty = true;
        return label;
    }

    updateLabel(label: Label): void {
        if (!label) return;
        this._updateLabelSource(label, label.source);
        this._dirty = true;
    }

    _updateLabelSource(label: Label, newSource: LabelSource): void {
        const prevSource = label.source;
        const el = label.element;
        const newType: LabelType = newSource.getLabelType ? newSource.getLabelType() : 'point';

        const oldText = label._cachedText;
        const newText = newSource.getText ? newSource.getText() : '';
        const oldStyle = label._cachedStyle;
        const newStyle = newSource.getTextStyle ? newSource.getTextStyle() : {};

        label.source = newSource;
        label._cachedText = newText;
        label._cachedStyle = { ...newStyle };

        if (prevSource !== newSource && newType !== 'line-curved') {
            label._chosenT = null;
            label._chosenIsFlipped = false;
        }

        Object.assign(el.style, newStyle);
        this._applyHalo(newStyle, el);

        if (newType === 'line-curved') {
            label._fontSize = parseFloat(newStyle.fontSize as string) || 12;
            return;
        }

        const textChanged = oldText !== newText;
        const fontChanged = [
            'fontSize', 'fontFamily', 'fontWeight', 'fontStyle',
            'letterSpacing', 'lineHeight', 'textTransform',
        ].some(key => oldStyle[key] !== newStyle[key]);

        if (label._hasIcon) {
            const pos: IconPosition = newSource.getLabelPosition ? newSource.getLabelPosition() : 'right';
            const dir = pos === 'left'  ? 'row-reverse'
                      : pos === 'top'   ? 'column-reverse'
                      : pos === 'bottom' ? 'column'
                      : 'row';
            el.style.flexDirection = dir;
            el.style.textAlign = (pos === 'top' || pos === 'bottom') ? 'center' : '';

            if (textChanged || fontChanged) {
                let textSpan = el.querySelector('.krb-text') as HTMLSpanElement | null;
                if (newText) {
                    if (!textSpan) {
                        textSpan = document.createElement('span');
                        textSpan.className = 'krb-text';
                        textSpan.style.whiteSpace = newType === 'point' ? 'pre-line' : 'nowrap';
                        el.appendChild(textSpan);
                    }
                    textSpan.textContent = newType === 'point'
                        ? this._wrapPointText(newText, el.style.fontSize)
                        : newText;
                } else if (textSpan) {
                    textSpan.remove();
                }
                label._needsMeasure = true;
                this._scheduleMeasure(label);
            }
            return;
        }

        if (textChanged || (newType === 'point' && fontChanged)) {
            if (newType === 'point') {
                el.style.whiteSpace = 'pre-line';
                el.textContent = this._wrapPointText(newText, el.style.fontSize);
            } else {
                el.textContent = newText;
            }
        }

        if (textChanged || fontChanged) {
            label._needsMeasure = true;
            this._scheduleMeasure(label);
        }
    }

    removeLabel(label: Label): void {
        if (!label) return;
        if (label._hideTimeout) { clearTimeout(label._hideTimeout); label._hideTimeout = null; }
        label._staleAt = null;
        const idx = this.labels.indexOf(label);
        if (idx > -1) {
            this.labels.splice(idx, 1);
            if (label.element && label.element.parentNode) {
                label.element.parentNode.removeChild(label.element);
            }
        }
        if (label.stableId != null && this._labelsById.get(label.stableId) === label) {
            this._labelsById.delete(label.stableId);
        }
        label._queuedForMeasure = false;
        this._dirty = true;
    }

    pruneStaleLabels(activeIds: Set<any> | null, owner: any = null, opts: PruneStaleOptions = {}): void {
        if (!activeIds) return;
        const fade = opts.fade === true;
        const graceMs = opts.graceMs ?? Math.max(OPACITY_MS + 10, 10);
        const now = performance.now();
        const toRemove: Label[] = [];
        let changed = false;

        for (const [id, label] of this._labelsById) {
            if ((label._vectorOwner ?? null) !== owner) continue;

            if (activeIds.has(id)) {
                if (label._staleAt != null) {
                    label._staleAt = null;
                    changed = true;
                }
                continue;
            }

            if (!fade || label.source.getLabelType() === 'line-curved') {
                toRemove.push(label);
                continue;
            }

            if (label._staleAt == null) {
                label._staleAt = now;
                label.hiddenByPriority = true;
                this._setLabelVisible(label, false);
                changed = true;
            }
            if (now - label._staleAt > graceMs) {
                toRemove.push(label);
            }
        }

        for (const label of toRemove) this.removeLabel(label);
        if (changed || toRemove.length > 0) this._dirty = true;
    }

    _wrapPointText(text: string, fontSize: string | number): string {
        if (!text || text.indexOf(' ') === -1) return text;
        const words = text.split(/\s+/).filter(w => w.length > 0);
        if (words.length <= 1) return text;
        const fontPx = parseFloat(String(fontSize)) || 12;
        const charWidth = fontPx * 0.6;
        const spaceWidth = fontPx * 0.3;
        const wordWidths = words.map(w => w.length * charWidth);
        const totalSingleLineWidth = wordWidths.reduce((s, w) => s + w, 0) +
            (words.length - 1) * spaceWidth;
        const maxSingleLineWidth = 160;
        if (totalSingleLineWidth <= maxSingleLineWidth) return text;
        const lineHeight = fontPx * 1.2;
        let targetLines = Math.max(2, Math.round(Math.sqrt(totalSingleLineWidth / lineHeight)));
        targetLines = Math.min(targetLines, 5);
        const targetLineWidth = totalSingleLineWidth / targetLines;
        const lines: string[] = [];
        let currentLine: string[] = [];
        let currentWidth = 0;
        for (let i = 0; i < words.length; i++) {
            const word = words[i], w = wordWidths[i];
            if (currentLine.length === 0) {
                currentLine.push(word); currentWidth = w;
            } else {
                const addedWidth = currentWidth + spaceWidth + w;
                if (addedWidth <= targetLineWidth) {
                    currentLine.push(word); currentWidth = addedWidth;
                } else {
                    lines.push(currentLine.join(' '));
                    currentLine = [word]; currentWidth = w;
                }
            }
        }
        if (currentLine.length > 0) lines.push(currentLine.join(' '));
        if (lines.length <= 1) return text;
        return lines.join('\n');
    }

    _scheduleMeasure(label: Label): void {
        if (label._queuedForMeasure) return;
        label._queuedForMeasure = true;
        this._measureQueue.push(label);
        if (this._measureScheduled) return;
        this._measureScheduled = true;
        if (typeof requestAnimationFrame === 'function') {
            requestAnimationFrame(() => this._flushMeasurements());
        }
    }

    _flushMeasurements(): void {
        if (!this._measureScheduled) return;
        this._measureScheduled = false;

        const queue = this._measureQueue;
        this._measureQueue = [];
        const states: Array<{ label: Label; el: HTMLDivElement; display: string; visibility: string }> = [];

        try {
            for (const label of queue) {
                label._queuedForMeasure = false;
                const el = label.element;
                if (!el || el.parentNode !== this.pane) continue;

                states.push({ label, el, display: el.style.display, visibility: el.style.visibility });
                if (el.style.display === 'none' || !el.style.display) {
                    el.style.display = label._display || 'block';
                }
                el.style.visibility = 'hidden';
            }

            for (const { label, el } of states) {
                label.width = el.offsetWidth;
                label.height = el.offsetHeight;
                label._fontSize = parseFloat(window.getComputedStyle(el).fontSize) || 12;

                if (label._hasIcon) {
                    const iconEl = el.querySelector('.krb-icon') as HTMLElement | null;
                    if (iconEl) {
                        const savedTransform = el.style.transform;
                        el.style.transform = 'none';
                        try {
                            const labelRect = el.getBoundingClientRect();
                            const iconRect = iconEl.getBoundingClientRect();
                            label._iconCenterX = (iconRect.left + iconRect.right) * 0.5 - labelRect.left;
                            label._iconCenterY = (iconRect.top + iconRect.bottom) * 0.5 - labelRect.top;
                        } finally {
                            el.style.transform = savedTransform;
                        }
                    }
                }

                label._needsMeasure = false;
            }
        } finally {
            for (const { el, display, visibility } of states) {
                el.style.display = display;
                el.style.visibility = visibility;
            }
        }

        if (states.length) this._dirty = true;
    }

    _setLabelVisible(label: Label, visible: boolean): void {
        const el = label.element;
        if (visible) {
            if (label._hideTimeout) { clearTimeout(label._hideTimeout); label._hideTimeout = null; }
            if (el.style.display === 'none') {
                el.style.display = label._display || 'block';
                el.style.opacity = '0';
                void el.offsetWidth;
                el.style.opacity = '1';
            } else {
                el.style.opacity = '1';
            }
        } else {
            if (el.style.display === 'none') return;
            el.style.opacity = '0';
            if (label._hideTimeout) clearTimeout(label._hideTimeout);
            label._hideTimeout = setTimeout(() => {
                if (parseFloat(el.style.opacity) === 0) el.style.display = 'none';
                label._hideTimeout = null;
            }, OPACITY_MS);
        }
    }

    /**
     * Мгновенно скрывает подпись без fade. Используется, когда позиция
     * источника стала недоступна, а подпись уже была в fade-out —
     * иначе она «залипает» на устаревшей экранной точке.
     */
    _forceHide(label: Label): void {
        const el = label.element;
        if (label._hideTimeout) { clearTimeout(label._hideTimeout); label._hideTimeout = null; }
        el.style.opacity = '0';
        el.style.display = 'none';
        if (label.source.getLabelType() === 'line-curved') {
            label._chosenT = null;
            label._chosenIsFlipped = false;
            label._pendingChosenT = null;
            label._pendingChosenIsFlipped = false;
        }
    }

    _hideAllLineLabels(): void {
        for (let i = 0; i < this.labels.length; i++) {
            const label = this.labels[i];
            if (label.source.getLabelType() !== 'line-curved') continue;
            const el = label.element;
            if (label._hideTimeout) { clearTimeout(label._hideTimeout); label._hideTimeout = null; }
            if (el.style.display !== 'none') {
                el.style.opacity = '0';
                el.style.display = 'none';
                void el.offsetWidth;
                el.style.transition = `opacity ${OPACITY_CSS} linear`;
            }
            label.hiddenByPriority = true;
            label._chosenT = null;
            label._pendingChosenT = null;
            label._pendingChosenIsFlipped = false;
        }
    }

    _computeAnchor(
        label: Label,
        rotationDeg: number,
        anchorOverride?: VariableAnchor | null,
    ): { dx: number; dy: number; offX: number; offY: number; w: number; h: number; cos: number; sin: number; } {
        const src = label.source;
        if (label._needsMeasure) this._flushMeasurements();
        const w = label.width;
        const h = label.height;

        let offX = 0, offY = 0;
        let align: TitleAlignH = 'center';
        let vAlign: TitleAlignV = 'center';

        if (anchorOverride) {
            const gap = Math.max(4, label._fontSize * 0.3);
            switch (anchorOverride) {
                case 'center':        align = 'center'; vAlign = 'center'; break;
                case 'top':           align = 'center'; vAlign = 'bottom'; offY = -gap; break;
                case 'bottom':        align = 'center'; vAlign = 'top';    offY =  gap; break;
                case 'left':          align = 'right';  vAlign = 'center'; offX = -gap; break;
                case 'right':         align = 'left';   vAlign = 'center'; offX =  gap; break;
                case 'top-left':      align = 'right';  vAlign = 'bottom'; offX = -gap; offY = -gap; break;
                case 'top-right':     align = 'left';   vAlign = 'bottom'; offX =  gap; offY = -gap; break;
                case 'bottom-left':   align = 'right';  vAlign = 'top';    offX = -gap; offY =  gap; break;
                case 'bottom-right':  align = 'left';   vAlign = 'top';    offX =  gap; offY =  gap; break;
            }
        } else {
            const offset = src.getTitleOffset ? src.getTitleOffset() : null;
            offX = offset ? offset[0] : 0;
            offY = offset ? offset[1] : 0;
            align = src.getTitleAlign ? src.getTitleAlign() : 'center';
            vAlign = src.getTitleVerticalAlign ? src.getTitleVerticalAlign() : 'center';
        }

        const rad = rotationDeg * Math.PI / 180;
        const cos = Math.cos(rad);
        const sin = Math.sin(rad);

        if (!anchorOverride
            && label._hasIcon
            && label._iconCenterX != null
            && label._iconCenterY != null) {
            const anchorX = label._iconCenterX;
            const anchorY = label._iconCenterY;
            const dx = -anchorX * cos + anchorY * sin;
            const dy = -anchorX * sin - anchorY * cos;
            return { dx, dy, offX, offY, w, h, cos, sin };
        }

        let anchorX: number;
        if (align === 'left')       anchorX = 0;
        else if (align === 'right') anchorX = w;
        else                        anchorX = w / 2;

        let anchorY: number;
        if (vAlign === 'top')         anchorY = 0;
        else if (vAlign === 'bottom') anchorY = h;
        else                          anchorY = h / 2;

        const dx = -anchorX * cos + anchorY * sin;
        const dy = -anchorX * sin - anchorY * cos;
        return { dx, dy, offX, offY, w, h, cos, sin };
    }

    _getLabelCorners(
        label: Label,
        tOverride: number | null = null,
        anchorOverride?: VariableAnchor | null,
    ): LabelScreenPoint[] | null {
        const src = label.source;
        const isLine = src.getLabelType() === 'line';
        let scrX: number, scrY: number, rotation = 0;
        if (isLine) {
            const t = tOverride !== null ? tOverride : label.t;
            const pos = src.getScreenPositionAt!(t);
            if (!pos) return null;
            scrX = pos.x; scrY = pos.y;
            rotation = src.getScreenAngleAt!(t);
        } else {
            // Используем кэш, заполненный в _updateVisibility. Это важно
            // для variableAnchor: без кэша getScreenPosition() вызывался
            // бы по разу на каждый anchor.
            const pos = label.screenPos || src.getScreenPosition!();
            if (!pos) return null;
            scrX = pos.x; scrY = pos.y;
        }
        const a = this._computeAnchor(label, rotation, anchorOverride);
        const { dx, dy, offX, offY, w, h, cos, sin } = a;
        const top = scrY + dy + offY;
        const left = scrX + dx + offX;
        const corners: LabelScreenPoint[] = [
            { x: left,      y: top },
            { x: left + w,  y: top },
            { x: left + w,  y: top + h },
            { x: left,      y: top + h },
        ];
        if (rotation !== 0) {
            const cx = left, cy = top;
            for (const pt of corners) {
                const rx = cx + (pt.x - cx) * cos - (pt.y - cy) * sin;
                const ry = cy + (pt.x - cx) * sin + (pt.y - cy) * cos;
                pt.x = rx; pt.y = ry;
            }
        }
        return corners;
    }

    _getBBox(corners: LabelScreenPoint[]): LabelBBox {
        let minX = Infinity, minY = Infinity;
        let maxX = -Infinity, maxY = -Infinity;
        for (const c of corners) {
            if (c.x < minX) minX = c.x;
            if (c.y < minY) minY = c.y;
            if (c.x > maxX) maxX = c.x;
            if (c.y > maxY) maxY = c.y;
        }
        return { minX, minY, maxX, maxY };
    }

    _bboxOverlap(a: LabelBBox, b: LabelBBox): boolean {
        return !(a.maxX < b.minX || b.maxX < a.minX || a.maxY < b.minY || b.maxY < a.minY);
    }

    _projectPolygon(axis: LabelScreenPoint, poly: LabelScreenPoint[]): { min: number; max: number } {
        let min = axis.x * poly[0].x + axis.y * poly[0].y;
        let max = min;
        for (let i = 1; i < poly.length; i++) {
            const proj = axis.x * poly[i].x + axis.y * poly[i].y;
            if (proj < min) min = proj;
            if (proj > max) max = proj;
        }
        return { min, max };
    }

    _rectsIntersect(rectA: LabelScreenPoint[], rectB: LabelScreenPoint[]): boolean {
        if (!rectA || !rectB) return false;
        const polys = [rectA, rectB];
        for (const poly of polys) {
            for (let i = 0; i < poly.length; i++) {
                const p1 = poly[i];
                const p2 = poly[(i + 1) % poly.length];
                const edge = { x: p2.x - p1.x, y: p2.y - p1.y };
                const axis = { x: -edge.y, y: edge.x };
                const projA = this._projectPolygon(axis, rectA);
                const projB = this._projectPolygon(axis, rectB);
                if (projA.max < projB.min || projB.max < projA.min) return false;
            }
        }
        return true;
    }

    _perCharOverlap(a: LabelBBox[], b: LabelBBox[]): boolean {
        for (let i = 0; i < a.length; i++) {
            const ca = a[i];
            for (let j = 0; j < b.length; j++) {
                const cb = b[j];
                if (!(ca.maxX < cb.minX || cb.maxX < ca.minX ||
                      ca.maxY < cb.minY || cb.maxY < ca.minY)) {
                    return true;
                }
            }
        }
        return false;
    }

    _collidesWithGrid(bbox: LabelBBox, selfLabel: Label | null = null): boolean {
        const others = this._gridIndex.query(bbox);
        for (let i = 0; i < others.length; i++) {
            const other = others[i];
            if (other === selfLabel) continue;
            if (!other._bbox) continue;
            if (!this._bboxOverlap(bbox, other._bbox)) continue;

            if (bbox.perChar && other._bbox.perChar) {
                if (this._perCharOverlap(bbox.perChar, other._bbox.perChar)) return true;
            } else {
                return true;
            }
        }
        return false;
    }

    _renderLineChars(label: Label, charLayout: CharLayout[]): void {
        const el = label.element;
        const need = charLayout.length;
        while (el.children.length < need) {
            const span = document.createElement('span');
            span.style.cssText =
                'position:absolute;left:0;top:0;' +
                'transform-origin:50% 50%;white-space:nowrap;' +
                'line-height:1;';
            el.appendChild(span);
        }
        while (el.children.length > need) {
            el.removeChild(el.lastChild!);
        }
        const fs = label._fontSize || 12;
        for (let i = 0; i < need; i++) {
            const c = charLayout[i];
            const span = el.children[i] as HTMLSpanElement;
            if (span.textContent !== c.char) span.textContent = c.char;
            const tx = c.x - c.w * 0.5;
            const ty = c.y - fs * 0.5;
            span.style.transform = `translate3d(${tx}px, ${ty}px, 0) rotate(${c.angle}deg)`;
        }
        el.style.transform = 'translate3d(0,0,0)';
    }

    // ═══════════════════════════════════════════════════════════════
    // Дебаг
    // ═══════════════════════════════════════════════════════════════

    debugLabels(): void {
        console.log('%c=== LINE LABELS DEBUG ===', 'color: #00ff00; font-weight: bold; font-size: 14px');
        const zoom = this.map.continuousZoom;
        let visibleCount = 0;
        let hiddenCount = 0;

        for (const label of this.labels) {
            const src = label.source;
            if (src.getLabelType() !== 'line-curved') continue;

            const text = src.getText();
            const zb = src.getTextZoomBounds();

            let status = 'UNKNOWN';
            let reason = '';

            if (zoom < zb.min || zoom > zb.max) {
                status = 'HIDDEN';
                reason = `Zoom ${zoom.toFixed(2)} out of bounds [${zb.min}, ${zb.max}]`;
            } else if (!src.isVisible()) {
                status = 'HIDDEN';
                reason = 'Source isVisible() false';
            } else if (label.hiddenByPriority) {
                status = 'HIDDEN';
                reason = label._chosenT == null
                    ? 'No valid candidate found (collision or filters)'
                    : 'Collision with other label';
            } else {
                status = 'VISIBLE';
            }

            if (status === 'VISIBLE') visibleCount++;
            else hiddenCount++;

            const color = status === 'VISIBLE' ? 'color: #00ff00' : 'color: #ffaa00';
            console.group(`%c[${status}] "${text}" — ${reason}`, color);

            const data = src._getScreenData?.();
            if (data) {
                console.log(`tMidVisible: ${data.tMidVisible.toFixed(2)}`);
                if ((src as any).diagnose) {
                    console.log('Diagnose tMidVisible:', (src as any).diagnose(data.tMidVisible));
                    if (label._chosenT != null) {
                        console.log(`Diagnose chosenT (${label._chosenT.toFixed(2)}):`,
                            (src as any).diagnose(label._chosenT));
                    }
                }
            } else {
                console.log('getScreenData() returned null (line invisible or fully behind camera)');
            }
            console.groupEnd();
        }

        console.log(`%cSummary: ${visibleCount} visible, ${hiddenCount} hidden.`, 'font-weight: bold;');
        console.log('If a line is missing entirely from this list, it was rejected by VectorTileLayer._collectLabelCandidates.');
    }

    // ═══════════════════════════════════════════════════════════════
    // Главный цикл
    // ═══════════════════════════════════════════════════════════════

    update(): void {
        if (this._measureQueue.length > 0) {
            if (!this._measureScheduled) this._measureScheduled = true;
            this._flushMeasurements();
        }

        const map = this.map;
        const zoom = map.continuousZoom;
        const cam = map.camera.position;
        const q = map.camera.quaternion;
        const wp = map.worldGroup.position;

        if (!this._stableRefPos) {
            this._stableRefPos = new THREE.Vector3().copy(cam);
            this._stableRefQ = new THREE.Quaternion().copy(q);
            this._stableRefWp = new THREE.Vector3().copy(wp);
            this._stableRefZoom = zoom;
        }

        const dPos = this._stableRefPos.distanceToSquared(cam);
        const dWp = this._stableRefWp.distanceToSquared(wp);
        const dZoom = Math.abs(this._stableRefZoom - zoom);
        const dQ = this._quatDeltaSq(this._stableRefQ, q);

        const moved = dPos > 0.01 || dWp > 1 || dZoom > 0.01 || dQ > 1e-5;
        const zoomChanged = dZoom > 0.01;
        const wasStable = this._wasStable;

        if (moved !== this._lastMoved) {
            const wc = moved ? 'transform' : 'auto';
            for (const lbl of this.labels) {
                if (lbl.element) lbl.element.style.willChange = wc;
            }
            this._lastMoved = moved;
        }

        if (moved) {
            if (zoomChanged && (this._stableFrameCount > 0 || wasStable)) {
                this._hideAllLineLabels();
            }
            this._stableFrameCount = 0;
            this._stableRefPos.copy(cam);
            this._stableRefQ.copy(q);
            this._stableRefWp.copy(wp);
            this._stableRefZoom = zoom;
            // КЛЮЧЕВОЙ ФИКС: пересчитывать коллизии каждый кадр движения.
            // Без этого при панорамировании/наклоне подписи «кучкуются»,
            // пока камера не остановится и не отсчитаются STABLE_FRAMES.
            this._dirty = true;
        } else {
            this._stableFrameCount++;
        }

        const isStable = this._stableFrameCount >= STABLE_FRAMES;
        this._wasStable = isStable;

        if (isStable && !wasStable) this._dirty = true;

        if (this._dirty) {
            this._updateVisibility(zoom, isStable);
            this._dirty = false;
        }

        this._applyTransforms();
    }

    _quatDeltaSq(a: any, b: any): number {
        const dot = a.x * b.x + a.y * b.y + a.z * b.z + a.w * b.w;
        return 2 * (1 - Math.abs(dot));
    }

    _updateVisibility(zoom: number, placeLines: boolean): void {
        const visibleLabels: Label[] = [];
        for (let i = 0; i < this.labels.length; i++) {
            const label = this.labels[i];
            const src = label.source;
            const zb = src.getTextZoomBounds();
            if (zoom < zb.min || zoom > zb.max) { label.hiddenByPriority = true; continue; }
            if (!src.isVisible()) { label.hiddenByPriority = true; continue; }

            const type = src.getLabelType();
            if (type === 'line-curved') continue;

            if (label._staleAt != null) {
                label.hiddenByPriority = true;
                continue;
            }

            label.priority = src.getPriority ? src.getPriority() : 0;
            label.allowOverflow = src.getAllowOverflow ? src.getAllowOverflow() : false;
            label.hiddenByPriority = false;

            if (type === 'line') {
                const iv = src.getVisibleInterval!();
                if (!iv) { label.hiddenByPriority = true; continue; }
                label.t = src.getLabelParameter!();
                if (!label.allowOverflow) {
                    if (label.t < iv.min || label.t > iv.max) {
                        label.t = Math.max(iv.min, Math.min(iv.max, label.t));
                        src.setLabelParameter!(label.t);
                    }
                } else {
                    label.t = Math.max(0, Math.min(1, label.t));
                }
                const rect = this._getLabelCorners(label);
                if (!rect) { label.hiddenByPriority = true; continue; }
                label.rect = rect;
            } else {
                // Кэшируем экранную позицию: _getLabelCorners для point
                // будет использовать её при переборе variableAnchor-ов.
                const pos = src.getScreenPosition!();
                if (!pos) {
                    label.screenPos = null;
                    label.hiddenByPriority = true;
                    continue;
                }
                label.screenPos = pos;
                const rect = this._getLabelCorners(label);
                if (!rect) { label.hiddenByPriority = true; continue; }
                label.rect = rect;
            }
            visibleLabels.push(label);
        }

        const sorted = [...visibleLabels].sort((a, b) => {
            if (a.priority !== b.priority) return b.priority - a.priority;
            const aKind = a.source.getLabelType() === 'point' ? 0 : 1;
            const bKind = b.source.getLabelType() === 'point' ? 0 : 1;
            if (aKind !== bKind) return aKind - bKind;
            return a.source.getText().localeCompare(b.source.getText());
        });

        this._gridIndex.clear();
        for (let i = 0; i < sorted.length; i++) {
            const lbl = sorted[i];

            const anchors = this._getVariableAnchors(lbl);
            const tryList: (VariableAnchor | null)[] = anchors ?? [null];

            let placed = false;
            for (const anchor of tryList) {
                const corners = this._getLabelCorners(lbl, null, anchor);
                if (!corners) continue;
                const bbox = this._getBBox(corners);

                let overlaps = false;
                const others = this._gridIndex.query(bbox);
                for (let j = 0; j < others.length; j++) {
                    const other = others[j];
                    if (!other._bbox || !this._bboxOverlap(bbox, other._bbox)) continue;
                    if (this._rectsIntersect(corners, other.rect!)) { overlaps = true; break; }
                }
                if (overlaps) continue;

                lbl.rect = corners;
                lbl._bbox = bbox;
                lbl._chosenAnchor = anchor;
                this._gridIndex.insert(bbox, lbl);
                lbl.hiddenByPriority = false;
                placed = true;
                break;
            }

            if (!placed) {
                lbl.hiddenByPriority = true;
                lbl._chosenAnchor = null;
            }
        }

        if (placeLines) this._placeLineLabels(zoom);

        const visibleSet = new Set<Label>(sorted);
        if (placeLines) {
            for (let i = 0; i < this.labels.length; i++) {
                const lbl = this.labels[i];
                if (lbl.source.getLabelType() !== 'line-curved') continue;
                if (!lbl.hiddenByPriority) visibleSet.add(lbl);
            }
        }
        for (let i = 0; i < this.labels.length; i++) {
            const lbl = this.labels[i];
            const isCurved = lbl.source.getLabelType() === 'line-curved';

            if (isCurved && !placeLines) {
                const zb = lbl.source.getTextZoomBounds();
                const stillValid =
                    lbl._chosenT != null &&
                    lbl.source.isVisible() &&
                    zoom >= zb.min && zoom <= zb.max;
                if (!stillValid) {
                    lbl.hiddenByPriority = true;
                    this._setLabelVisible(lbl, false);
                }
                continue;
            }
            if (isCurved && lbl._pendingChosenT != null) continue;

            const shouldBeVisible = visibleSet.has(lbl) && !lbl.hiddenByPriority;
            this._setLabelVisible(lbl, shouldBeVisible);
        }
    }

    _placeLineLabels(zoom: number): void {
        const lineLabels: Label[] = [];
        for (let i = 0; i < this.labels.length; i++) {
            const label = this.labels[i];
            const src = label.source;
            if (src.getLabelType() !== 'line-curved') continue;
            const zb = src.getTextZoomBounds();
            if (zoom < zb.min || zoom > zb.max) { label.hiddenByPriority = true; continue; }
            if (!src.isVisible()) { label.hiddenByPriority = true; continue; }
            lineLabels.push(label);
        }
        lineLabels.sort((a, b) => {
            const ap = a.source.getPriority ? a.source.getPriority() : 0;
            const bp = b.source.getPriority ? b.source.getPriority() : 0;
            return bp - ap;
        });
        for (let i = 0; i < lineLabels.length; i++) {
            const lbl = lineLabels[i];
            const src = lbl.source;

            let chosen: LineCandidate | null = null;
            if (lbl._chosenT != null) {
                const keep = src.getCandidateAtT!(lbl._chosenT);
                if (keep && !this._collidesWithGrid(keep.bbox, lbl)) chosen = keep;
            }

            if (!chosen) {
                const candidates = src.getCandidates!();
                for (let j = 0; j < candidates.length; j++) {
                    const c = candidates[j];
                    if (!this._collidesWithGrid(c.bbox, lbl)) { chosen = c; break; }
                }
            }

            if (chosen) {
                lbl._bbox = chosen.bbox;
                this._gridIndex.insert(chosen.bbox, lbl);
                lbl.hiddenByPriority = false;

                if (lbl._chosenT == null) {
                    lbl._chosenT = chosen.t;
                    lbl._chosenIsFlipped = chosen.isFlipped;
                    lbl._pendingChosenT = null;
                    lbl._pendingChosenIsFlipped = false;
                } else {
                    const sameAsCurrent =
                        lbl._chosenT === chosen.t &&
                        lbl._chosenIsFlipped === chosen.isFlipped;
                    const sameAsPending =
                        lbl._pendingChosenT != null &&
                        lbl._pendingChosenT === chosen.t &&
                        lbl._pendingChosenIsFlipped === chosen.isFlipped;

                    if (sameAsCurrent) {
                        lbl._pendingChosenT = null;
                        lbl._pendingChosenIsFlipped = false;
                    } else if (sameAsPending) {
                        // уже ждём
                    } else {
                        lbl._pendingChosenT = chosen.t;
                        lbl._pendingChosenIsFlipped = chosen.isFlipped;
                    }
                }
            } else {
                lbl._pendingChosenT = null;
                lbl._pendingChosenIsFlipped = false;
                lbl._bbox = null;
                lbl.hiddenByPriority = true;
            }
        }
    }

    _applyTransforms(): void {
        const zoom = this.map.continuousZoom;

        for (let i = 0; i < this.labels.length; i++) {
            const label = this.labels[i];
            const src = label.source;
            const type = src.getLabelType();
            const isCurved = type === 'line-curved';

            const zb = src.getTextZoomBounds();
            const sourceVisible = src.isVisible() && zoom >= zb.min && zoom <= zb.max;
            const shouldBeVisible = sourceVisible && !label.hiddenByPriority;

            // ── Фаза скрытия ───────────────────────────────────────────
            // Если подпись должна быть невидимой — запускаем fade-out один
            // раз, но НЕ пропускаем transform ниже: пока идёт fade-out,
            // подпись должна продолжать следовать за якорем, иначе она
            // «залипает» на краю экрана при панорамировании.
            if (!shouldBeVisible) {
                const el = label.element;
                const isFadingOut = label._hideTimeout != null;
                const isFullyHidden = !isFadingOut && el.style.display === 'none';

                if (isFullyHidden) {
                    if (isCurved) {
                        label._chosenT = null;
                        label._chosenIsFlipped = false;
                        label._pendingChosenT = null;
                        label._pendingChosenIsFlipped = false;
                    }
                    continue;
                }

                if (!isFadingOut) {
                    if (isCurved && label._pendingChosenT != null) {
                        label._pendingChosenT = null;
                        label._pendingChosenIsFlipped = false;
                    }
                    this._setLabelVisible(label, false);
                }
            }

            // ── Кривые (line-curved) ───────────────────────────────────
            if (isCurved) {
                let inTransition = false;

                if (shouldBeVisible && label._pendingChosenT != null) {
                    const el = label.element;
                    const fadeOutDone = label._hideTimeout == null && el.style.display === 'none';
                    if (!fadeOutDone) {
                        if (label._hideTimeout == null) this._setLabelVisible(label, false);
                        inTransition = true;
                    } else {
                        label._chosenT = label._pendingChosenT;
                        label._chosenIsFlipped = label._pendingChosenIsFlipped;
                        label._pendingChosenT = null;
                        label._pendingChosenIsFlipped = false;
                    }
                }

                if (label._chosenT == null) {
                    if (shouldBeVisible) this._setLabelVisible(label, false);
                    continue;
                }

                const charLayout = src.getCharLayoutAtT!(label._chosenT, label._chosenIsFlipped);

                if (charLayout) {
                    this._renderLineChars(label, charLayout);

                    const data = src._getScreenData?.();
                    if (data) {
                        const anchorPx = src._tToPx!(data, label._chosenT);
                        const anchor = src._samplePx!(data, anchorPx);
                        if (anchor) label._lastAnchor = anchor;
                    }

                    if (shouldBeVisible && !inTransition) this._setLabelVisible(label, true);
                    continue;
                }

                if (shouldBeVisible && !inTransition) this._setLabelVisible(label, false);

                if (label._lastAnchor) {
                    const data = src._getScreenData?.();
                    if (data) {
                        const curAnchorPx = src._tToPx!(data, label._chosenT);
                        const curAnchor = src._samplePx!(data, curAnchorPx);
                        if (curAnchor) {
                            const dx = curAnchor.x - label._lastAnchor.x;
                            const dy = curAnchor.y - label._lastAnchor.y;
                            if (dx !== 0 || dy !== 0) {
                                label.element.style.transform = `translate3d(${dx}px, ${dy}px, 0)`;
                            }
                        }
                    }
                }
                continue;
            }

            // ── Точечные и обычные линии ───────────────────────────────
            let pos: LabelScreenPoint | null | undefined;
            if (type === 'line') pos = src.getScreenPositionAt!(label.t);
            else                 pos = src.getScreenPosition!();

            if (!pos) {
                if (!shouldBeVisible) {
                    // Позиция недоступна, а подпись уже фейдится — гасим
                    // мгновенно, чтобы она не «прилипла» к краю экрана
                    // в устаревшей точке.
                    this._forceHide(label);
                    continue;
                }
                this._setLabelVisible(label, false);
                continue;
            }

            const rotation = type === 'line' ? src.getScreenAngleAt!(label.t) : 0;
            const a = this._computeAnchor(label, rotation, label._chosenAnchor);
            const { dx, dy, offX, offY } = a;
            const top = pos.y + dy + offY;

            let transform = `translate3d(${pos.x + dx + offX}px, ${top}px, 0)`;
            if (type === 'line' && src.getPlacement?.() === 'along') {
                transform += ` rotate(${rotation}deg)`;
            }
            if (label.element.__lastTransform !== transform) {
                label.element.style.transform = transform;
                label.element.__lastTransform = transform;
            }

            if (shouldBeVisible) this._setLabelVisible(label, true);
        }
    }
}