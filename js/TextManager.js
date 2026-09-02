// TextManager.js

import {
  THREE,
} from '../js_TP/tpb.js';  

/**
 * Менеджер текстовых подписей (лейблов) для карты.
 *
 * Управляет жизненным циклом DOM-элементов подписей: создание, позиционирование,
 * разрешение коллизий и отрисовка. Поддерживает подписи для точечных объектов
 * (Point) и линейных объектов (LineString). Для линейных подписей реализовано
 * анимированное перемещение вдоль линии с целью избежать перекрытий, а также
 * жадная приоритезация всех видимых подписей для предотвращения наложений.
 *
 */
export class TextManager {
    /**
     * Создаёт экземпляр менеджера подписей, привязанный к карте.
     *
     * @param {Map} map - Экземпляр карты, к которой прикрепляются подписи.
     */
    constructor(map) {
        /**
         * Ссылка на карту.
         * @type {Map}
         */
        this.map = map;

        /**
         * Массив объектов подписей, управляемых менеджером.
         * @type {Object[]}
         */
        this.labels = [];

        /**
         * DOM-элемент-контейнер, в котором размещаются подписи.
         * @type {HTMLElement|null}
         */
        this.pane = null;




        /**
         * Набор идентификаторов источников подписей, видимых в предыдущем кадре.
         * Используется для сброса флагов stuck при изменении состава подписей.
         *
         * @type {Set|null}
         * @private
         */
        this._lastVisibleIds = null;

        /**
         * Уровень зума в предыдущем кадре.
         *
         * @type {number|null}
         * @private
         */
        this._lastZoom = null;

        this._initPane();
    }

    /**
     * Инициализирует DOM-контейнер для подписей.
     * Если контейнер с id="krb-label-pane" отсутствует в целевом элементе карты,
     * создаёт новый div с абсолютным позиционированием и добавляет его в DOM.
     *
     * @private
     */
    _initPane() {
        const target = this.map.targetElement;
        let pane = target.querySelector('#krb-label-pane');
        if (!pane) {
            pane = document.createElement('div');
            pane.id = 'krb-label-pane';
            Object.assign(pane.style, {
                position: 'absolute',
                top: '0', left: '0',
                width: '100%', height: '100%',
                pointerEvents: 'none',
                zIndex: '625'
            });
            target.appendChild(pane);
        }
        this.pane = pane;
    }

    /**
     * Добавляет новую подпись на карту на основе объекта-источника.
     * Создаёт DOM-элемент, измеряет его размеры и сохраняет во внутренний массив.
     *
     * @param {Object} source - Объект-источник подписи.
     * @property {Function} source.getText - Возвращает текст подписи.
     * @property {Function} source.getTextStyle - Возвращает стили текста.
     * @property {Function} source.getPriority - Возвращает приоритет подписи.
     * @property {Function} source.getAllowOverflow - Возвращает разрешение на переполнение интервала.
     * @property {Function} source.getLabelType - Возвращает тип подписи ('point' или 'line').
     * @property {Function} source.getScreenPosition - Возвращает экранную позицию точки.
     * @property {Function} source.getScreenPositionAt - Возвращает экранную позицию линии по параметру t.
     * @property {Function} source.getScreenAngleAt - Возвращает угол подписи по параметру t.
     * @property {Function} source.getTitleAlign - Возвращает горизонтальное выравнивание.
     * @property {Function} source.getTitleVerticalAlign - Возвращает вертикальное выравнивание.
     * @property {Function} source.getTitleOffset - Возвращает смещение подписи.
     * @property {Function} source.getTextZoomBounds - Возвращает границы видимости по зуму.
     * @property {Function} source.isVisible - Возвращает видимость источника.
     * @property {Function} source.getVisibleInterval - Возвращает видимый интервал линии.
     * @property {Function} source.getLabelParameter - Возвращает текущий параметр линии.
     * @property {Function} source.setLabelParameter - Устанавливает параметр линии.
     * @property {Function} source.getPlacement - Возвращает режим размещения вдоль линии.
     * @returns {Object} Объект label, содержащий ссылки на source и элемент, а также метаданные (t, размеры, флаги и т.д.).
     */
    addLabel(source) {
        const el = document.createElement('div');
el.className = 'krb-text-label';
// Начальные стили (whiteSpace будет переопределён ниже)
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
    left: '0',            // обязательно для transform-позиционирования
    top: '0',             // обязательно для transform-позиционирования
    willChange: 'transform' // подсказка браузеру для GPU-ускорения
});
Object.assign(el.style, source.getTextStyle());

// Для точечных подписей включаем многострочность и применяем перенос
if (source.getLabelType() === 'point') {
    el.style.whiteSpace = 'pre-line';  // разрешаем перенос по \n
    const wrapped = this._wrapPointText(source.getText(), el.style.fontSize);
    el.textContent = wrapped;
} else {
    // Для линейных подписей оставляем как есть (nowrap)
    el.textContent = source.getText();
}

this.pane.appendChild(el);

        const label = {
            source,
            element: el,
            t: 0,
            width: 0,
            height: 0,
            stuck: false,
            hiddenByPriority: false,
            priority: source.getPriority ? source.getPriority() : 0,
            allowOverflow: source.getAllowOverflow ? source.getAllowOverflow() : false
        };
        this.labels.push(label);
        this._measureLabel(label);
        return label;
    }

    /**
     * Удаляет подпись из менеджера и из DOM.
     *
     * @param {Object} label - Объект подписи, ранее возвращённый методом addLabel.
     */
    removeLabel(label) {
        const idx = this.labels.indexOf(label);
        if (idx > -1) {
            this.labels.splice(idx, 1);
            label.element.remove();
        }
    }


    /**
 * Преобразует длинный текст точечной подписи в многострочный,
 * вставляя переносы \n так, чтобы блок был близок к квадрату.
 * Использует грубые оценки ширины символов (0.6em) и пробела (0.3em).
 *
 * @param {string} text - Исходный однострочный текст.
 * @param {string} fontSize - CSS-значение font-size (например, "12px").
 * @returns {string} Текст с переносами строк.
 * @private
 */
_wrapPointText(text, fontSize) {
    if (!text || text.indexOf(' ') === -1) return text; // нет пробелов или пусто

    const words = text.split(/\s+/).filter(w => w.length > 0);
    if (words.length <= 1) return text;

    const fontPx = parseFloat(fontSize) || 12;
    const charWidth = fontPx * 0.6;      // примерная ширина символа
    const spaceWidth = fontPx * 0.3;     // примерная ширина пробела

    const wordWidths = words.map(w => w.length * charWidth);
    const totalSingleLineWidth = wordWidths.reduce((sum, w) => sum + w, 0) +
        (words.length - 1) * spaceWidth;

    // Порог, при котором перенос не требуется (можно вынести в настройки)
    const maxSingleLineWidth = 160;
    if (totalSingleLineWidth <= maxSingleLineWidth) return text;

    // Высота одной строки (примерно)
    const lineHeight = fontPx * 1.2;

    // Желаемое количество строк для квадратной формы:
    // totalWidth / lines ≈ lines * lineHeight  =>  lines = sqrt(totalWidth / lineHeight)
    let targetLines = Math.max(2, Math.round(Math.sqrt(totalSingleLineWidth / lineHeight)));
    targetLines = Math.min(targetLines, 5); // ограничение, чтобы не делать слишком много строк

    const targetLineWidth = totalSingleLineWidth / targetLines;

    // Жадное заполнение строк
    const lines = [];
    let currentLine = [];
    let currentWidth = 0;

    for (let i = 0; i < words.length; i++) {
        const word = words[i];
        const w = wordWidths[i];

        if (currentLine.length === 0) {
            currentLine.push(word);
            currentWidth = w;
        } else {
            const addedWidth = currentWidth + spaceWidth + w;
            if (addedWidth <= targetLineWidth) {
                currentLine.push(word);
                currentWidth = addedWidth;
            } else {
                lines.push(currentLine.join(' '));
                currentLine = [word];
                currentWidth = w;
            }
        }
    }
    if (currentLine.length > 0) {
        lines.push(currentLine.join(' '));
    }

    // Если в итоге получилась одна строка (например, из-за ограничений), возвращаем исходный текст
    if (lines.length <= 1) return text;

    return lines.join('\n');
}

    /**
     * Измеряет реальные ширину и высоту DOM-элемента подписи.
     * Временно делает элемент видимым (но невидимым для пользователя через visibility:hidden),
     * считывает offsetWidth/offsetHeight и возвращает исходное состояние.
     *
     * @param {Object} label - Объект подписи.
     * @private
     */
    _measureLabel(label) {
        const el = label.element;
        const prevDisplay = el.style.display;
        const prevVisibility = el.style.visibility;
        el.style.display = 'block';
        el.style.visibility = 'hidden';
        label.width = el.offsetWidth;
        label.height = el.offsetHeight;
        el.style.display = prevDisplay;
        el.style.visibility = prevVisibility;
    }



    /**
     * Вычисляет экранные координаты четырёх углов прямоугольника подписи
     * с учётом выравнивания, смещения и поворота.
     *
     * @param {Object} label - Объект подписи.
     * @param {number|null} [tOverride=null] - Параметр t для линейной подписи (если отличается от label.t).
     * @returns {Object[]|null} Массив из четырёх точек {x, y} углов прямоугольника или null, если позиция не определена.
     * @private
     */
    _getLabelCorners(label, tOverride = null) {
        const src = label.source;
        const el = label.element;

        let scrX, scrY, rotation = 0;
        const isLine = src.getLabelType() === 'line';
        if (isLine) {
            const t = tOverride !== null ? tOverride : label.t;
            const pos = src.getScreenPositionAt(t);
            if (!pos) return null;
            scrX = pos.x;
            scrY = pos.y;
            rotation = src.getScreenAngleAt(t);
        } else {
            const pos = src.getScreenPosition();
            if (!pos) return null;
            scrX = pos.x;
            scrY = pos.y;
        }

        if (!label.width || !label.height) this._measureLabel(label);
        const w = label.width;
        const h = label.height;

        const align = src.getTitleAlign ? src.getTitleAlign() : 'center';
        const vAlign = src.getTitleVerticalAlign ? src.getTitleVerticalAlign() : 'center';
        const [offX, offY] = src.getTitleOffset ? src.getTitleOffset() : [0, 0];

        let anchorX;
        if (align === 'left') anchorX = 0;
        else if (align === 'right') anchorX = w;
        else anchorX = w / 2;

        let anchorY;
        if (vAlign === 'top') anchorY = 0;
        else if (vAlign === 'bottom') anchorY = h;
        else anchorY = h / 2;

        const rad = rotation * Math.PI / 180;
        const cos = Math.cos(rad);
        const sin = Math.sin(rad);

        const dx = -anchorX * cos + anchorY * sin;
        const dy = -anchorX * sin - anchorY * cos;

        let top = scrY + dy + offY;
        if (isLine) {
            const style = window.getComputedStyle(el);
            const fontSize = parseFloat(style.fontSize) || 12;
            top += fontSize;
        }
        const left = scrX + dx + offX;

        const corners = [
            { x: left, y: top },
            { x: left + w, y: top },
            { x: left + w, y: top + h },
            { x: left, y: top + h }
        ];

        if (rotation !== 0) {
            const cx = left, cy = top;
            for (const pt of corners) {
                const rx = cx + (pt.x - cx) * cos - (pt.y - cy) * sin;
                const ry = cy + (pt.x - cx) * sin + (pt.y - cy) * cos;
                pt.x = rx;
                pt.y = ry;
            }
        }

        return corners;
    }

    /**
     * Проецирует полигон на заданную ось и возвращает минимальную и максимальную проекции.
     * Используется в алгоритме разделяющих осей (SAT).
     *
     * @param {{x: number, y: number}} axis - Нормализованный вектор оси.
     * @param {Object[]} poly - Массив точек полигона {x, y}.
     * @returns {{min: number, max: number}} Минимальная и максимальная проекции.
     * @private
     */
    _projectPolygon(axis, poly) {
        let min = axis.x * poly[0].x + axis.y * poly[0].y;
        let max = min;
        for (let i = 1; i < poly.length; i++) {
            const proj = axis.x * poly[i].x + axis.y * poly[i].y;
            if (proj < min) min = proj;
            if (proj > max) max = proj;
        }
        return { min, max };
    }

    /**
     * Проверяет пересечение двух выпуклых полигонов (прямоугольников) методом разделяющих осей (SAT).
     * Прямоугольники задаются массивом из четырёх углов.
     *
     * @param {Object[]|null} rectA - Первый прямоугольник (массив точек).
     * @param {Object[]|null} rectB - Второй прямоугольник.
     * @returns {boolean} True, если прямоугольники пересекаются.
     * @private
     */
    _rectsIntersect(rectA, rectB) {
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

    /**
     * Главный метод обновления всех подписей. Выполняет следующие шаги:
     * 1. Сбор видимых подписей с учётом zoom-границ и видимости источника.
     * 2. Сброс stuck-состояний при изменении набора видимых подписей или зума.
     * 3. Итеративное раздвижение линейных подписей для избежания перекрытий.
     * 4. Жадная приоритезация всех подписей: отрисовываются подписи с высшим приоритетом
     *    без перекрытий с уже размещёнными.
     * 5. Применение вычисленных позиций к DOM-элементам.
     */
    update() {
        const map = this.map;
        const zoom = map.continuousZoom;

        // Сброс stuck при изменении состава или зума
        const currentIds = this.labels.map(l => l.source).filter(src => {
            const zb = src.getTextZoomBounds();
            return zoom >= zb.min && zoom <= zb.max && src.isVisible();
        });
        const idSet = new Set(currentIds);
        if (!this._lastVisibleIds || !this._lastZoom ||
            this._lastZoom !== zoom ||
            this._lastVisibleIds.size !== idSet.size ||
            [...this._lastVisibleIds].some(id => !idSet.has(id))) {
            for (const lbl of this.labels) {
                lbl.stuck = false;
                lbl.hiddenByPriority = false;
            }
        }
        this._lastVisibleIds = idSet;
        this._lastZoom = zoom;

        // 1. Сбор видимых подписей
        const visibleLabels = [];
        for (const label of this.labels) {
            const src = label.source;
            const zoomBounds = src.getTextZoomBounds();
            if (zoom < zoomBounds.min || zoom > zoomBounds.max) {
                label.element.style.display = 'none';
                continue;
            }
            if (!src.isVisible()) {
                label.element.style.display = 'none';
                continue;
            }

            label.priority = src.getPriority ? src.getPriority() : 0;
            label.allowOverflow = src.getAllowOverflow ? src.getAllowOverflow() : false;

            // сбрасываем hiddenByPriority каждый кадр — будет пересчитано ниже
            label.hiddenByPriority = false;

            if (src.getLabelType() === 'line') {
                const iv = src.getVisibleInterval();
                if (!iv) {
                    label.element.style.display = 'none';
                    continue;
                }
                label.visibleInterval = iv;
                label.t = src.getLabelParameter();
                if (!label.allowOverflow) {
                    if (label.t < iv.min || label.t > iv.max) {
                        label.t = Math.max(iv.min, Math.min(iv.max, label.t));
                        src.setLabelParameter(label.t);
                    }
                } else {
                    label.t = Math.max(0, Math.min(1, label.t));
                }
                label.rect = this._getLabelCorners(label);
                if (label.rect) visibleLabels.push(label);
            } else {
                const pos = src.getScreenPosition();
                if (!pos) {
                    label.element.style.display = 'none';
                    continue;
                }
                label.screenPos = pos;
                label.rect = this._getLabelCorners(label);
                if (label.rect) visibleLabels.push(label);
            }
        }

        // 2. Раздвижение линейных подписей
        const lineLabels = visibleLabels.filter(l => l.source.getLabelType() === 'line');
        if (lineLabels.length > 0) {
            const maxIterations = 15;
            const learningRate = 0.4;
            const stuckThreshold = 1e-5;

            for (let iter = 0; iter < maxIterations; iter++) {
                let anyChanged = false;

                for (const lbl of lineLabels) {
                    if (lbl.stuck) continue;

                    lbl.rect = this._getLabelCorners(lbl);
                    if (!lbl.rect) continue;

                    const overlapping = [];
                    for (const other of visibleLabels) {
                        if (other === lbl) continue;
                        if (other.rect && this._rectsIntersect(lbl.rect, other.rect)) {
                            overlapping.push(other);
                        }
                    }

                    if (overlapping.length === 0) continue;

                    // учитываем только тех, у кого приоритет >= нашего
                    const relevant = overlapping.filter(o => o.priority >= lbl.priority);
                    if (relevant.length === 0) continue;

                    const pi = lbl.source.getScreenPositionAt(lbl.t);
                    if (!pi) continue;

                    let forceX = 0, forceY = 0;
                    for (const other of relevant) {
                        const pj = (other.source.getLabelType() === 'line')
                            ? other.source.getScreenPositionAt(other.t)
                            : other.source.getScreenPosition();
                        if (!pj) continue;

                        const dx = pi.x - pj.x;
                        const dy = pi.y - pj.y;
                        const dist2 = dx * dx + dy * dy + 1;
                        const forceMag = 1 / dist2;
                        forceX += (dx / Math.sqrt(dist2)) * forceMag;
                        forceY += (dy / Math.sqrt(dist2)) * forceMag;
                    }

                    const ang = lbl.source.getScreenAngleAt(lbl.t) * Math.PI / 180;
                    const tangentX = Math.cos(ang);
                    const tangentY = Math.sin(ang);
                    const dot = forceX * tangentX + forceY * tangentY;
                    const step = dot * learningRate;

                    const oldT = lbl.t;
                    let newT = oldT + step;

                    if (lbl.allowOverflow) {
                        newT = Math.max(0, Math.min(1, newT));
                    } else {
                        const iv = lbl.visibleInterval;
                        if (iv) {
                            newT = Math.max(iv.min, Math.min(iv.max, newT));
                        }
                    }

                    if (Math.abs(newT - oldT) > 1e-7) {
                        lbl.t = newT;
                        anyChanged = true;
                    }
                }

                if (!anyChanged) break;
            }

            // определение stuck для линий
            for (const lbl of lineLabels) {
                if (lbl.stuck) continue;
                lbl.rect = this._getLabelCorners(lbl);
                if (!lbl.rect) {
                    lbl.stuck = true;
                    continue;
                }
                const overlapping = visibleLabels.filter(o => o !== lbl && o.rect && this._rectsIntersect(lbl.rect, o.rect));
                const oldT = lbl.source.getLabelParameter();
                if (overlapping.length > 0 && Math.abs(lbl.t - oldT) < stuckThreshold) {
                    lbl.stuck = true;
                } else if (overlapping.length === 0) {
                    lbl.stuck = false;
                }
            }

            // сохраняем t в источники для незастрявших
            for (const lbl of lineLabels) {
                if (lbl.stuck) {
                    lbl.t = lbl.source.getLabelParameter(); // откат
                } else {
                    lbl.source.setLabelParameter(lbl.t);
                }
            }
        }

        // 3. ЖАДНАЯ ПРИОРИТЕЗАЦИЯ ДЛЯ ВСЕХ ВИДИМЫХ ПОДПИСЕЙ
        const sorted = [...visibleLabels].sort((a, b) => {
            if (a.priority !== b.priority) return b.priority - a.priority;
            const aLine = a.source.getLabelType() === 'line' ? 1 : 0;
            const bLine = b.source.getLabelType() === 'line' ? 1 : 0;
            if (aLine !== bLine) return aLine - bLine;
            return a.source.getText().localeCompare(b.source.getText());
        });

        const placedRects = [];

        for (const lbl of sorted) {
            lbl.rect = this._getLabelCorners(lbl);
            if (!lbl.rect) {
                lbl.hiddenByPriority = true;
                continue;
            }

            let overlaps = false;
            for (const placed of placedRects) {
                if (this._rectsIntersect(lbl.rect, placed)) {
                    overlaps = true;
                    break;
                }
            }

            if (!overlaps) {
                placedRects.push(lbl.rect);
                lbl.hiddenByPriority = false;
            } else {
                lbl.hiddenByPriority = true;
            }
        }

        // 4. Рендеринг DOM-элементов
        for (const label of visibleLabels) {
            const src = label.source;
            const el = label.element;

            if (label.hiddenByPriority) {
                el.style.display = 'none';
                continue;
            }

            let screenX, screenY, rotation = 0;

            if (src.getLabelType() === 'line') {
                const pos = src.getScreenPositionAt(label.t);
                if (!pos) {
                    el.style.display = 'none';
                    continue;
                }
                screenX = pos.x;
                screenY = pos.y;
                rotation = src.getScreenAngleAt(label.t);
            } else {
                screenX = label.screenPos.x;
                screenY = label.screenPos.y;
            }

            if (!label.width || !label.height) this._measureLabel(label);
            const w = label.width;
            const h = label.height;

            const align = src.getTitleAlign ? src.getTitleAlign() : 'center';
            const vAlign = src.getTitleVerticalAlign ? src.getTitleVerticalAlign() : 'center';

            let localAnchorX;
            if (align === 'left') localAnchorX = 0;
            else if (align === 'right') localAnchorX = w;
            else localAnchorX = w / 2;

            let localAnchorY;
            if (vAlign === 'top') localAnchorY = 0;
            else if (vAlign === 'bottom') localAnchorY = h;
            else localAnchorY = h / 2;

            const rad = rotation * Math.PI / 180;
            const cos = Math.cos(rad);
            const sin = Math.sin(rad);

            const dx = -localAnchorX * cos + localAnchorY * sin;
            const dy = -localAnchorX * sin - localAnchorY * cos;

            const [offX, offY] = src.getTitleOffset ? src.getTitleOffset() : [0, 0];

            let top = screenY + dy + offY;

            if (src.getLabelType() === 'line') {
                const style = window.getComputedStyle(el);
                const fontSize = parseFloat(style.fontSize) || 12;
                top += fontSize;
            }

            el.style.display = 'block';
            let transform = `translate3d(${screenX + dx + offX}px, ${top}px, 0)`;
if (src.getLabelType() === 'line' && src.getPlacement() === 'along') {
    transform += ` rotate(${rotation}deg)`;
}
el.style.transform = transform;
        }
    }
}
