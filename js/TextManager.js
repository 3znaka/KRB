// TextManager.js

import {
  THREE,
} from '../js_TP/tpb.js';

/**
 * Простой пространственный индекс (равномерная сетка) для ускорения
 * проверки коллизий подписей.
 *
 * @private
 */
class _GridIndex {
    /**
     * @param {number} [cellSize=128] - Размер ячейки в пикселях. Меньше —
     *   быстрее запрос, но больше памяти и накладных расходов на вставку.
     */
    constructor(cellSize = 128) {
        this.cellSize = cellSize;
        /** @type {Map<string, Array<Object>>} */
        this.grid = new Map();
    }

    /**
     * Ключ ячейки.
     * @param {number} col
     * @param {number} row
     * @returns {string}
     * @private
     */
    _key(col, row) {
        return col + ',' + row;
    }

    /**
     * Очищает индекс.
     * @returns {void}
     */
    clear() {
        this.grid.clear();
    }

    /**
     * Вставляет значение, ассоциированное с bbox, во все ячейки,
     * которые этот bbox пересекает.
     *
     * @param {{minX:number, minY:number, maxX:number, maxY:number}} bbox
     * @param {Object} value - Произвольное значение (например, label).
     * @returns {void}
     */
    insert(bbox, value) {
        const cs = this.cellSize;
        const c0 = Math.floor(bbox.minX / cs);
        const c1 = Math.floor(bbox.maxX / cs);
        const r0 = Math.floor(bbox.minY / cs);
        const r1 = Math.floor(bbox.maxY / cs);
        for (let c = c0; c <= c1; c++) {
            for (let r = r0; r <= r1; r++) {
                const k = this._key(c, r);
                let cell = this.grid.get(k);
                if (!cell) {
                    cell = [];
                    this.grid.set(k, cell);
                }
                cell.push(value);
            }
        }
    }

    /**
     * Возвращает все значения, чьи bbox лежат в ячейках, пересекаемых
     * переданным bbox. Результат не дедуплицирован на уровне значений —
     * дедупликация выполняется внутри (по ссылке на объект).
     *
     * @param {{minX:number, minY:number, maxX:number, maxY:number}} bbox
     * @returns {Array<Object>} Массив значений (порядок не определён).
     */
    query(bbox) {
        const cs = this.cellSize;
        const c0 = Math.floor(bbox.minX / cs);
        const c1 = Math.floor(bbox.maxX / cs);
        const r0 = Math.floor(bbox.minY / cs);
        const r1 = Math.floor(bbox.maxY / cs);
        const result = [];
        const seen = new Set();
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

/**
 * Менеджер текстовых подписей (лейблов) для карты.
 *
 * Управляет жизненным циклом DOM-элементов подписей: создание, позиционирование,
 * разрешение коллизий и отрисовка. Поддерживает подписи для точечных объектов
 * (Point) и линейных объектов (LineString). Для линейных подписей реализовано
 * анимированное перемещение вдоль линии с целью избежать перекрытий, а также
 * жадная приоритезация всех видимых подписей для предотвращения наложений.
 *
 * Особенности реализации, важные для производительности и отсутствия мерцания:
 *
 *  - **Reuse DOM по stableId.** Вызывающая сторона может передать в
 *    {@link TextManager#addLabel} второй аргумент — стабильный идентификатор
 *    подписи (например, ключ, который не меняется при панорамировании, но
 *    остаётся уникальным в пределах логической сущности). Если подпись с таким
 *    id уже существует, DOM-узел переиспользуется: обновляются только `source`,
 *    стили и (при необходимости) текст. Никаких удаление + пересоздание —
 *    а значит, нет вспышек fade-in/out и reflow при пересборке.
 *
 *  - **Батч-измерение.** Реальные `offsetWidth/offsetHeight` снимаются не в
 *    момент `addLabel`, а в рамках одного прохода {@link TextManager#_flushMeasurements}
 *    (write-фаза: показать скрыто; read-фаза: снять размеры; restore). Так
 *    массовое добавление N подписей даёт один layout, а не N.
 *
 *  - **Троттлинг update().** {@link TextManager#update} делает ранний выход,
 *    если с момента предыдущего вызова не изменились ни зум, ни положение
 *    мира, ни положение камеры, ни состав подписей. Состав помечается флагом
 *    `_dirty` при любой мутации (addLabel/removeLabel/pruneStaleLabels).
 *
 *  - **Защита от реентерабельности `_flushMeasurements`.** Проход по очереди
 *    измерений обёрнут в try/finally. Если во время измерения (например, из
 *    пользовательского геттера `source.getText()`) произойдёт исключение или
 *    реентерабельный вызов `addLabel`, очередь и её служебные флаги корректно
 *    восстанавливаются, а необработанные подписи возвращаются в очередь и
 *    гарантированно получают повторный проход.
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
         * Быстрый доступ к подписям по stableId. Ключ — идентификатор,
         * переданный в {@link TextManager#addLabel}. Значение — объект label.
         * Позволяет переиспользовать DOM-узлы без пересоздания.
         *
         * @type {Map<*, Object>}
         * @private
         */
        this._labelsById = new Map();

        /**
         * DOM-элемент-контейнер, в котором размещаются подписи.
         * @type {HTMLElement|null}
         */
        this.pane = null;

        /**
         * Мягкий ориентир максимального числа подписей. Устанавливается
         * снаружи через {@link TextManager#setMaxLabels}. Внутри менеджера
         * не используется как жёсткий лимит — фактический бюджет контролирует
         * вызывающая сторона (например, VectorTileLayer).
         *
         * @type {number}
         */
        this.maxLabels = 500;

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

        /**
         * Пространственный индекс для жадного размещения подписей.
         * Пересоздаётся на каждом кадре в {@link TextManager#update}.
         *
         * @type {_GridIndex}
         * @private
         */
        this._gridIndex = new _GridIndex(128);

        /**
         * Очередь подписей, ожидающих измерения. Заполняется в
         * {@link TextManager#_scheduleMeasure}, обрабатывается в
         * {@link TextManager#_flushMeasurements}.
         *
         * @type {Object[]}
         * @private
         */
        this._measureQueue = [];

        /**
         * Флаг «замер уже запланирован на ближайший rAF». Защищает от
         * многократного планирования в пределах одного кадра.
         *
         * @type {boolean}
         * @private
         */
        this._measureScheduled = false;

        /**
         * Подпись предыдущего кадра для троттлинга {@link TextManager#update}.
         * Если подпись не менялась и состав подписей тоже (`_dirty === false`),
         * update завершается сразу.
         *
         * @type {string|null}
         * @private
         */
        this._lastFrameSig = null;

        /**
         * Флаг «состав подписей изменился — update нужно выполнить, даже
         * если сигнатура кадра совпадает с прошлой». Выставляется в
         * addLabel / removeLabel / pruneStaleLabels.
         *
         * @type {boolean}
         * @private
         */
        this._dirty = true;

        this._initPane();
    }

    /**
     * Устанавливает мягкий лимит числа подписей. Вызывается извне
     * (например, `VectorTileLayer.addTo`) для синхронизации с настройками слоя.
     *
     * ВАЖНО: метод не удаляет уже добавленные подписи и не блокирует
     * `addLabel`. Ответственность за соблюдение бюджета лежит на вызывающей
     * стороне.
     *
     * @param {number} max - Максимальное число подписей.
     * @returns {void}
     */
    setMaxLabels(max) {
        if (typeof max === 'number' && max > 0) {
            this.maxLabels = max;
        }
    }

    /**
     * Возвращает статистику для отладки.
     *
     * @returns {{total: number, visible: number, hiddenByPriority: number, maxLabels: number, stableIds: number}}
     */
    getDebugStats() {
        let visible = 0;
        let hidden = 0;
        for (const l of this.labels) {
            if (l.hiddenByPriority) hidden++;
            else if (l.element && l.element.style.display !== 'none') visible++;
        }
        return {
            total: this.labels.length,
            visible,
            hiddenByPriority: hidden,
            maxLabels: this.maxLabels,
            stableIds: this._labelsById.size
        };
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
     * Уничтожает менеджер: снимает таймеры у всех подписей, удаляет DOM-элементы
     * и удаляет pane из целевого элемента карты.
     *
     * @returns {void}
     */
    dispose() {
        for (const label of this.labels) {
            if (label._hideTimeout) {
                clearTimeout(label._hideTimeout);
                label._hideTimeout = null;
            }
            if (label.element && label.element.parentNode) {
                label.element.parentNode.removeChild(label.element);
            }
        }
        this.labels.length = 0;
        this._labelsById.clear();
        this._measureQueue.length = 0;
        this._measureScheduled = false;
        if (this.pane && this.pane.parentNode) {
            this.pane.parentNode.removeChild(this.pane);
        }
        this.pane = null;
        this._lastVisibleIds = null;
        this._lastZoom = null;
        this._lastFrameSig = null;
        this._dirty = true;
        this._gridIndex.clear();
    }

    /**
     * Добавляет новую подпись на карту на основе объекта-источника.
     *
     * Если передан `stableId` и подпись с таким id уже существует, DOM-узел
     * **переиспользуется**: обновляются только ссылка на источник, текст (если
     * он изменился) и стили. Это устраняет мерцание и reflow при массовой
     * пересборке подписей (например, при панорамировании карты).
     *
     * Если `stableId` не передан или не найден — создаётся новая подпись.
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
     * @param {*} [stableId=null] - Стабильный идентификатор подписи (любой
     *     примитив или объект, поддерживающий `===`). Позволяет переиспользовать
     *     существующий DOM-узел при повторном вызове с тем же id.
     * @returns {Object} Объект label, содержащий ссылки на source и элемент, а также метаданные (t, размеры, флаги и т.д.).
     */
    addLabel(source, stableId = null) {
        // --- Reuse path -----------------------------------------------------
        if (stableId != null) {
            const existing = this._labelsById.get(stableId);
            if (existing) {
                this._updateLabelSource(existing, source);
                // Состав не изменился, но подпись "освежилась" — update должен
                // её обработать (например, если поменялся текст или стиль).
                this._dirty = true;
                return existing;
            }
        }

        // --- Create path ----------------------------------------------------
        const el = document.createElement('div');
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
            willChange: 'transform'
        });
        Object.assign(el.style, source.getTextStyle());
        el.style.transition = 'opacity 0.08s linear';
        el.style.opacity = '0';

        // Для точечных подписей включаем многострочность и применяем перенос
        if (source.getLabelType() === 'point') {
            el.style.whiteSpace = 'pre-line';
            const wrapped = this._wrapPointText(source.getText(), el.style.fontSize);
            el.textContent = wrapped;
        } else {
            el.textContent = source.getText();
        }

        this.pane.appendChild(el);

        const label = {
            source,
            element: el,
            stableId: stableId,
            t: 0,
            width: 0,
            height: 0,
            stuck: false,
            hiddenByPriority: false,
            priority: source.getPriority ? source.getPriority() : 0,
            allowOverflow: source.getAllowOverflow ? source.getAllowOverflow() : false,
            // Кэш значений, чтобы не дёргать layout/getComputedStyle в hot path
            _fontSize: 12,
            _bbox: null,
            // Флаг «размеры ещё не сняты».
            _needsMeasure: true,
            // Защита от дублирования в очереди измерения.
            _queuedForMeasure: false
        };
        this.labels.push(label);
        if (stableId != null) this._labelsById.set(stableId, label);

        // Батч-измерение: реальные размеры снимем одним layout-проходом
        // (в ближайшем _flushMeasurements, который гарантированно вызовется
        // либо из update(), либо из rAF).
        this._scheduleMeasure(label);

        // Состав подписей изменился — сбрасываем снимок прошлого кадра,
        // чтобы stuck-флаги корректно пересчитались на ближайшем update().
        this._lastVisibleIds = null;
        this._dirty = true;

        return label;
    }

    /**
     * Обновляет существующую подпись при переиспользовании по stableId:
     * переназначает источник, применяет новые стили, при необходимости
     * обновляет текст и ставит подпись в очередь на переизмерение.
     *
     * Позиционные метаданные (`t`, `stuck`, `_bbox`) сохраняются — они
     * относятся к жизненному циклу самой подписи, а не к источнику.
     *
     * @param {Object} label - Существующий объект подписи.
     * @param {Object} newSource - Новый источник.
     * @private
     */
    _updateLabelSource(label, newSource) {
        const oldSource = label.source;
        const el = label.element;

        const oldText = oldSource && oldSource.getText ? oldSource.getText() : '';
        const newText = newSource.getText ? newSource.getText() : '';

        const oldStyle = oldSource && oldSource.getTextStyle ? oldSource.getTextStyle() : {};
        const newStyle = newSource.getTextStyle ? newSource.getTextStyle() : {};

        // Переназначаем источник.
        label.source = newSource;

        // Применяем стили (даже если они идентичны — Object.assign дёшев,
        // браузер сам отсечёт no-op изменения).
        Object.assign(el.style, newStyle);

        const textChanged = oldText !== newText;
        const fontChanged =
            oldStyle.fontSize !== newStyle.fontSize ||
            oldStyle.fontFamily !== newStyle.fontFamily ||
            oldStyle.fontWeight !== newStyle.fontWeight;

        if (textChanged) {
            if (newSource.getLabelType && newSource.getLabelType() === 'point') {
                el.style.whiteSpace = 'pre-line';
                el.textContent = this._wrapPointText(newText, el.style.fontSize);
            } else {
                el.textContent = newText;
            }
        }

        // Переизмерение нужно только если реально поменялся текст или шрифт.
        if (textChanged || fontChanged) {
            label._needsMeasure = true;
            this._scheduleMeasure(label);
        }
    }

    /**
     * Удаляет подпись из менеджера и из DOM.
     *
     * @param {Object} label - Объект подписи, ранее возвращённый методом addLabel.
     */
    removeLabel(label) {
        if (!label) return;
        if (label._hideTimeout) {
            clearTimeout(label._hideTimeout);
            label._hideTimeout = null;
        }
        const idx = this.labels.indexOf(label);
        if (idx > -1) {
            this.labels.splice(idx, 1);
            if (label.element && label.element.parentNode) {
                label.element.parentNode.removeChild(label.element);
            }
        }
        // Снимаем привязку по stableId — только если текущий маппинг
        // действительно ведёт на этот объект (защита от рассинхронизации,
        // если по какой-то причине в Map лежит уже другой label).
        if (label.stableId != null && this._labelsById.get(label.stableId) === label) {
            this._labelsById.delete(label.stableId);
        }
        label._queuedForMeasure = false;

        // Инвалидация снимка прошлого кадра.
        this._lastVisibleIds = null;
        this._dirty = true;
    }

    /**
     * Удаляет все подписи, чьи stableId отсутствуют в переданном множестве.
     * Используется вызывающей стороной (например, VectorTileLayer) после
     * серии вызовов {@link TextManager#addLabel} для очистки "устаревших"
     * подписей, которые больше не видны.
     *
     * Если у подписи нет stableId (была добавлена без него), она НЕ
     * удаляется этим методом — за неё отвечает вызывающая сторона через
     * {@link TextManager#removeLabel}.
     *
     * @param {Set<*>} activeIds - Множество stableId, которые нужно сохранить.
     * @returns {void}
     */
    pruneStaleLabels(activeIds) {
        if (!activeIds || this._labelsById.size === 0) return;

        // Собираем сначала список, чтобы не мутировать Map во время итерации.
        let toRemove = null;
        for (const [id, label] of this._labelsById) {
            if (!activeIds.has(id)) {
                if (!toRemove) toRemove = [];
                toRemove.push(label);
            }
        }
        if (!toRemove) return;
        for (let i = 0; i < toRemove.length; i++) {
            this.removeLabel(toRemove[i]);
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
        if (!text || text.indexOf(' ') === -1) return text;

        const words = text.split(/\s+/).filter(w => w.length > 0);
        if (words.length <= 1) return text;

        const fontPx = parseFloat(fontSize) || 12;
        const charWidth = fontPx * 0.6;
        const spaceWidth = fontPx * 0.3;

        const wordWidths = words.map(w => w.length * charWidth);
        const totalSingleLineWidth = wordWidths.reduce((sum, w) => sum + w, 0) +
            (words.length - 1) * spaceWidth;

        const maxSingleLineWidth = 160;
        if (totalSingleLineWidth <= maxSingleLineWidth) return text;

        const lineHeight = fontPx * 1.2;

        let targetLines = Math.max(2, Math.round(Math.sqrt(totalSingleLineWidth / lineHeight)));
        targetLines = Math.min(targetLines, 5);

        const targetLineWidth = totalSingleLineWidth / targetLines;

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

        if (lines.length <= 1) return text;

        return lines.join('\n');
    }

    /**
     * Помечает подпись как требующую измерения и ставит её в батч-очередь.
     * Реальные размеры будут сняты в {@link TextManager#_flushMeasurements}
     * одним layout-проходом (write-фаза → read-фаза → restore).
     *
     * Защищён от повторного попадания в очередь в пределах одного кадра.
     *
     * @param {Object} label - Объект подписи.
     * @private
     */
    _measureLabel(label) {
        label._needsMeasure = true;
        this._scheduleMeasure(label);
    }

    /**
     * Планирует обработку очереди измерений. Обработка происходит в
     * ближайшем rAF-кадре, а также форсируется синхронно в начале
     * {@link TextManager#update}, чтобы размеры были гарантированно
     * доступны уже в текущем кадре.
     *
     * Если этот метод вызывается реентерабельно из середины
     * {@link TextManager#_flushMeasurements}, подпись попадёт в «следующую»
     * очередь (`this._measureQueue`), а новый проход будет запланирован
     * отдельным rAF — текущий проход не пострадает.
     *
     * @param {Object} label - Объект подписи.
     * @private
     */
    _scheduleMeasure(label) {
        if (label._queuedForMeasure) return;
        label._queuedForMeasure = true;
        this._measureQueue.push(label);

        if (this._measureScheduled) return;
        this._measureScheduled = true;

        if (typeof requestAnimationFrame === 'function') {
            requestAnimationFrame(() => this._flushMeasurements());
        }
    }

    /**
     * Единый проход по очереди измерений. Работает в три фазы:
     *
     *  1. **Write.** Все элементы очереди временно делаются видимыми
     *     (`display:block; visibility:hidden`) — без снятия размеров.
     *  2. **Read.** Одним вызовом `offsetWidth/offsetHeight` браузер
     *     выполняет layout, и мы снимаем размеры сразу для всех подписей.
     *     Дополнительно кэшируем `fontSize` через `getComputedStyle`.
     *  3. **Restore.** Возвращаем элементам исходное скрытое состояние.
     *
     * Такая схема даёт **один reflow на пачку** вместо N.
     *
     * Метод защищён от реентерабельности:
     *
     *  - В начале проверяется `_measureScheduled`. Если он уже сброшен —
     *    значит, синхронный flush произошёл раньше (например, из `update()`),
     *    и текущий вызов — «запоздавший» rAF. Ранний выход.
     *
     *  - Обработка обёрнута в `try/finally`. При исключении (в том числе
     *    выброшенном пользовательским геттером `source`) восстанавливаются
     *    стили всех элементов, а подписи, не успевшие пройти read-фазу,
     *    возвращаются в `_measureQueue` и планируется повторный flush.
     *    Это гарантирует, что ни одна подпись не «застрянет» с флагом
     *    `_queuedForMeasure = true` и что новый проход будет выполнен.
     *
     *  - Реентерабельный вызов {@link TextManager#_scheduleMeasure} во время
     *    обработки (например, из `addLabel`) безопасен: он кладёт подпись
     *    в новый массив `_measureQueue` и запрашивает отдельный rAF, не
     *    нарушая текущий проход.
     *
     * @private
     */
    _flushMeasurements() {
        // Ранний выход, если «синхронный» flush уже состоялся (например,
        // из update()) и сбросил флаг. В этом случае запоздавший rAF-колбэк
        // не должен повторно обрабатывать очередь.
        if (!this._measureScheduled) return;
        this._measureScheduled = false;

        const queue = this._measureQueue;
        if (queue.length === 0) return;

        // Забираем очередь в локальную переменную и подменяем поле на новый
        // массив. Всё, что будет добавлено через `_scheduleMeasure` во время
        // обработки (в том числе реентерабельно — из пользовательских
        // геттеров или из `addLabel`), попадёт в этот новый массив и будет
        // обработано отдельным проходом, не разрушая текущий.
        this._measureQueue = [];

        let allMeasured = false;
        let allRestored = false;

        try {
            // --- Фаза 1: write ----------------------------------------------
            // Показываем все скрытые элементы как visibility:hidden —
            // браузер сможет их измерить, но пользователь их не увидит.
            for (let i = 0; i < queue.length; i++) {
                const el = queue[i].element;
                if (!el) continue;
                el.style.display = 'block';
                el.style.visibility = 'hidden';
            }

            // --- Фаза 2: read -----------------------------------------------
            // Один layout на всю пачку.
            for (let i = 0; i < queue.length; i++) {
                const label = queue[i];
                const el = label.element;
                if (!el) {
                    // Страховка от рассинхронизации: подпись без элемента
                    // не может быть измерена — считаем её «обработанной»,
                    // чтобы не зацикливаться.
                    label._needsMeasure = false;
                    label._queuedForMeasure = false;
                    continue;
                }
                label.width = el.offsetWidth;
                label.height = el.offsetHeight;
                const cs = window.getComputedStyle(el);
                label._fontSize = parseFloat(cs.fontSize) || 12;
                label._needsMeasure = false;
                label._queuedForMeasure = false;
            }
            allMeasured = true;

            // --- Фаза 3: restore --------------------------------------------
            // Возвращаем исходное скрытое состояние.
            for (let i = 0; i < queue.length; i++) {
                const el = queue[i].element;
                if (!el) continue;
                el.style.visibility = '';
                el.style.display = 'none';
            }
            allRestored = true;
        } finally {
            // Если restore-фаза не доехала до конца — восстанавливаем стили
            // всех элементов пачки, чтобы не оставить их в «измерительном»
            // состоянии (display:block; visibility:hidden).
            if (!allRestored) {
                for (let i = 0; i < queue.length; i++) {
                    const el = queue[i].element;
                    if (!el) continue;
                    el.style.visibility = '';
                    el.style.display = 'none';
                }
            }

            // Если read-фаза не завершилась — часть подписей осталась
            // с `_queuedForMeasure = true`. Возвращаем их в очередь, чтобы
            // повторный проход гарантированно снял размеры.
            if (!allMeasured) {
                for (let i = 0; i < queue.length; i++) {
                    const label = queue[i];
                    if (label._queuedForMeasure) {
                        this._measureQueue.push(label);
                    }
                }

                // Планируем повторный flush, если он ещё не запланирован
                // (реентерабельный `_scheduleMeasure` мог его уже запросить).
                if (this._measureQueue.length > 0 && !this._measureScheduled) {
                    this._measureScheduled = true;
                    if (typeof requestAnimationFrame === 'function') {
                        requestAnimationFrame(() => this._flushMeasurements());
                    }
                }
            }
        }
    }

    /**
     * Плавно показывает или скрывает подпись с анимацией прозрачности.
     * Использует CSS transition для fade-in / fade-out.
     *
     * @param {Object} label - Объект подписи.
     * @param {boolean} visible - Целевое состояние видимости.
     * @private
     */
    _setLabelVisible(label, visible) {
        const el = label.element;

        if (visible) {
            if (label._hideTimeout) {
                clearTimeout(label._hideTimeout);
                label._hideTimeout = null;
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

            if (label._hideTimeout) clearTimeout(label._hideTimeout);
            label._hideTimeout = setTimeout(() => {
                if (parseFloat(el.style.opacity) === 0) {
                    el.style.display = 'none';
                }
                label._hideTimeout = null;
            }, 80);
        }
    }

    /**
     * Вычисляет anchor-смещение и матрицу поворота подписи.
     *
     * Вынесено из _getLabelCorners и рендера, чтобы избежать дублирования
     * расчёта (ранее формула повторялась в двух местах).
     *
     * @param {Object} label - Объект подписи.
     * @param {number} rotationDeg - Угол поворота в градусах.
     * @returns {{dx: number, dy: number, offX: number, offY: number,
     *            w: number, h: number, cos: number, sin: number}}
     * @private
     */
    _computeAnchor(label, rotationDeg) {
        const src = label.source;

        // Безопасная страховка: если подпись всё ещё «грязная» (например,
        // её добавили извне и update не успел выполнить flush), форсируем
        // измерение ровно один раз — очередь после этого станет пустой.
        if (label._needsMeasure) this._flushMeasurements();

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

        const rad = rotationDeg * Math.PI / 180;
        const cos = Math.cos(rad);
        const sin = Math.sin(rad);

        const dx = -anchorX * cos + anchorY * sin;
        const dy = -anchorX * sin - anchorY * cos;

        return { dx, dy, offX, offY, w, h, cos, sin };
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
        const isLine = src.getLabelType() === 'line';

        let scrX, scrY, rotation = 0;
        if (isLine) {
            const t = tOverride !== null ? tOverride : label.t;
            const pos = src.getScreenPositionAt(t);
            if (!pos) return null;
            scrX = pos.x;
            scrY = pos.y;
            rotation = src.getScreenAngleAt(t);
        } else {
            // Переиспользуем кэшированный screenPos, если он есть,
            // чтобы не вызывать getScreenPosition() лишний раз.
            const pos = label.screenPos || src.getScreenPosition();
            if (!pos) return null;
            scrX = pos.x;
            scrY = pos.y;
        }

        const a = this._computeAnchor(label, rotation);
        const { dx, dy, offX, offY, w, h, cos, sin } = a;

        let top = scrY + dy + offY;
        if (isLine) {
            top += label._fontSize || 12;
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
     * Вычисляет axis-aligned bounding box для массива точек.
     *
     * @param {Object[]} corners - Массив точек {x, y}.
     * @returns {{minX: number, minY: number, maxX: number, maxY: number}}
     * @private
     */
    _getBBox(corners) {
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

    /**
     * Быстрая проверка пересечения двух AABB.
     *
     * @param {{minX: number, minY: number, maxX: number, maxY: number}} a
     * @param {{minX: number, minY: number, maxX: number, maxY: number}} b
     * @returns {boolean}
     * @private
     */
    _bboxOverlap(a, b) {
        return !(a.maxX < b.minX || b.maxX < a.minX ||
                 a.maxY < b.minY || b.maxY < a.minY);
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
     * 0. Форсирует обработку очереди измерений (если что-то накопилось).
     * 1. Ранний выход, если состав и положение сцены не изменились.
     * 2. Сбор видимых подписей с учётом zoom-границ и видимости источника.
     * 3. Сброс stuck-состояний при изменении набора видимых подписей или зума.
     * 4. Итеративное раздвижение линейных подписей для избежания перекрытий.
     * 5. Жадная приоритезация всех подписей: отрисовываются подписи с высшим приоритетом
     *    без перекрытий с уже размещёнными. Для ускорения проверки коллизий
     *    используется пространственный индекс (_GridIndex).
     * 6. Применение вычисленных позиций к DOM-элементам.
     */
    update() {
        // --- 0. Форсируем измерения до любых вычислений ----------------------
        if (this._measureQueue.length > 0) {
            // Синхронный flush: гарантирует, что _measureScheduled выставлен
            // в правильное состояние и не «зависнет» между кадрами.
            if (!this._measureScheduled) {
                this._measureScheduled = true;
            }
            this._flushMeasurements();
        }

        const map = this.map;
        const zoom = map.continuousZoom;

        // --- 1. Троттлинг ----------------------------------------------------
        // Сигнатура кадра: зум + локальное положение мира + позиция камеры
        // + количество подписей. Любое значимое изменение → пересчёт.
        // Округление до 3 знаков после запятой ≈ субмиллиметровая точность
        // в мировых метрах — визуально неразличимое смещение игнорируется.
        const wp = map.worldGroup.position;
        const cam = map.camera.position;
        const sig = zoom
            + '|' + wp.x.toFixed(3) + ',' + wp.z.toFixed(3)
            + '|' + cam.x.toFixed(3) + ',' + cam.y.toFixed(3) + ',' + cam.z.toFixed(3)
            + '|' + this.labels.length;

        if (!this._dirty && this._lastFrameSig === sig) {
            return;
        }
        this._lastFrameSig = sig;
        this._dirty = false;

        // Сброс stuck при изменении состава или зума.
        // Используем Set<source>, чтобы не материализовать промежуточный массив дважды.
        const idSet = new Set();
        for (const l of this.labels) {
            const src = l.source;
            const zb = src.getTextZoomBounds();
            if (zoom >= zb.min && zoom <= zb.max && src.isVisible()) {
                idSet.add(src);
            }
        }
        if (this._lastVisibleIds === null ||
            this._lastZoom === null ||
            this._lastZoom !== zoom ||
            this._lastVisibleIds.size !== idSet.size ||
            this._setDiffers(this._lastVisibleIds, idSet)) {
            for (const lbl of this.labels) {
                lbl.stuck = false;
                lbl.hiddenByPriority = false;
            }
        }
        this._lastVisibleIds = idSet;
        this._lastZoom = zoom;

        // 2. Сбор видимых подписей
        const visibleLabels = [];
        for (const label of this.labels) {
            const src = label.source;
            const zoomBounds = src.getTextZoomBounds();
            if (zoom < zoomBounds.min || zoom > zoomBounds.max) {
                continue;
            }
            if (!src.isVisible()) {
                continue;
            }

            label.priority = src.getPriority ? src.getPriority() : 0;
            label.allowOverflow = src.getAllowOverflow ? src.getAllowOverflow() : false;
            label.hiddenByPriority = false;

            if (src.getLabelType() === 'line') {
                const iv = src.getVisibleInterval();
                if (!iv) {
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
                    continue;
                }
                label.screenPos = pos;
                label.rect = this._getLabelCorners(label);
                if (label.rect) visibleLabels.push(label);
            }
        }

        // 3. Раздвижение линейных подписей
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
                    const lblBBox = this._getBBox(lbl.rect);

                    const overlapping = [];
                    for (const other of visibleLabels) {
                        if (other === lbl) continue;
                        if (!other.rect) continue;
                        const otherBBox = other._bbox || this._getBBox(other.rect);
                        other._bbox = otherBBox;
                        if (!this._bboxOverlap(lblBBox, otherBBox)) continue;
                        if (this._rectsIntersect(lbl.rect, other.rect)) {
                            overlapping.push(other);
                        }
                    }

                    if (overlapping.length === 0) continue;

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
                const lblBBox = this._getBBox(lbl.rect);
                const overlapping = visibleLabels.filter(o => {
                    if (o === lbl || !o.rect) return false;
                    const otherBBox = o._bbox || this._getBBox(o.rect);
                    o._bbox = otherBBox;
                    if (!this._bboxOverlap(lblBBox, otherBBox)) return false;
                    return this._rectsIntersect(lbl.rect, o.rect);
                });
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
                    lbl.t = lbl.source.getLabelParameter();
                } else {
                    lbl.source.setLabelParameter(lbl.t);
                }
            }
        }

        // 4. ЖАДНАЯ ПРИОРИТЕЗАЦИЯ ДЛЯ ВСЕХ ВИДИМЫХ ПОДПИСЕЙ
        //
        // Используем _GridIndex для быстрой проверки коллизий: вместо перебора
        // всех уже размещённых прямоугольников (O(n²)) опрашиваем только те
        // ячейки сетки, которые пересекает bbox текущей подписи.
        const sorted = [...visibleLabels].sort((a, b) => {
            if (a.priority !== b.priority) return b.priority - a.priority;
            const aLine = a.source.getLabelType() === 'line' ? 1 : 0;
            const bLine = b.source.getLabelType() === 'line' ? 1 : 0;
            if (aLine !== bLine) return aLine - bLine;
            return a.source.getText().localeCompare(b.source.getText());
        });

        this._gridIndex.clear();

        for (const lbl of sorted) {
            lbl.rect = this._getLabelCorners(lbl);
            if (!lbl.rect) {
                lbl.hiddenByPriority = true;
                continue;
            }
            const bbox = this._getBBox(lbl.rect);
            lbl._bbox = bbox;

            const candidates = this._gridIndex.query(bbox);
            let overlaps = false;
            for (let i = 0; i < candidates.length; i++) {
                const other = candidates[i];
                // Двойная защита: сначала быстрая AABB-проверка,
                // затем точная SAT (для повёрнутых прямоугольников).
                if (!other._bbox || !this._bboxOverlap(bbox, other._bbox)) continue;
                if (this._rectsIntersect(lbl.rect, other.rect)) {
                    overlaps = true;
                    break;
                }
            }

            if (!overlaps) {
                this._gridIndex.insert(bbox, lbl);
                lbl.hiddenByPriority = false;
            } else {
                lbl.hiddenByPriority = true;
            }
        }

        // Применяем видимость с fade-анимацией
        const visibleSet = new Set(visibleLabels);
        for (const label of this.labels) {
            const shouldBeVisible = visibleSet.has(label) && !label.hiddenByPriority;
            this._setLabelVisible(label, shouldBeVisible);
        }

        // 5. Рендеринг DOM-элементов (только обновление transform)
        for (const label of visibleLabels) {
            const src = label.source;
            const el = label.element;

            let screenX, screenY, rotation = 0;

            if (src.getLabelType() === 'line') {
                const pos = src.getScreenPositionAt(label.t);
                if (!pos) continue;
                screenX = pos.x;
                screenY = pos.y;
                rotation = src.getScreenAngleAt(label.t);
            } else {
                screenX = label.screenPos.x;
                screenY = label.screenPos.y;
            }

            const a = this._computeAnchor(label, rotation);
            const { dx, dy, offX, offY } = a;

            let top = screenY + dy + offY;
            if (src.getLabelType() === 'line') {
                top += label._fontSize || 12;
            }

            let transform = `translate3d(${screenX + dx + offX}px, ${top}px, 0)`;
            if (src.getLabelType() === 'line' && src.getPlacement() === 'along') {
                transform += ` rotate(${rotation}deg)`;
            }
            el.style.transform = transform;
        }
    }

    /**
     * Проверяет, отличаются ли два множества. Используется вместо
     * `[...a].some(x => !b.has(x))`, чтобы не материализовать массив.
     *
     * @param {Set} a - Первое множество.
     * @param {Set} b - Второе множество.
     * @returns {boolean} True, если множества различаются.
     * @private
     */
    _setDiffers(a, b) {
        if (a.size !== b.size) return true;
        for (const item of a) {
            if (!b.has(item)) return true;
        }
        return false;
    }
}