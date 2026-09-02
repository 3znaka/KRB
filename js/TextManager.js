// TextManager.js

import { THREE } from '../js_TP/tpb.js';

/**
 * Менеджер текстовых подписей (лейблов) для карты.
 *
 * Управляет жизненным циклом спрайтовых подписей: создание, позиционирование,
 * разрешение коллизий и отрисовка. Поддерживает подписи для точечных объектов
 * (Point) и линейных объектов (LineString). Для линейных подписей реализовано
 * анимированное перемещение вдоль линии с целью избежать перекрытий, а также
 * жадная приоритезация всех видимых подписей для предотвращения наложений.
 *
 * Источники подписей могут предоставлять:
 * - экранные координаты (getScreenPosition / getScreenPositionAt) — **обязательно**;
 * - мировые координаты (getWorldPosition / getWorldPositionAt) — **опционально**,
 *   если они есть, будут использованы для более точного позиционирования спрайтов.
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
         * Группа Three.js для всех спрайтов подписей.
         * @type {THREE.Group}
         */
        this.labelGroup = new THREE.Group();
        map.scene.add(this.labelGroup);

        /**
         * Набор идентификаторов источников подписей, видимых в предыдущем кадре.
         * @type {Set|null}
         * @private
         */
        this._lastVisibleIds = null;

        /**
         * Уровень зума в предыдущем кадре.
         * @type {number|null}
         * @private
         */
        this._lastZoom = null;
    }

    /**
     * Добавляет новую подпись на карту на основе объекта-источника.
     * Создаёт canvas, текстуру, материал и спрайт; добавляет спрайт в группу.
     *
     * @param {Object} source - Объект-источник подписи.
     * @returns {Object} Объект label, содержащий ссылки на source и спрайт, а также метаданные.
     */
    addLabel(source) {
        // 1. Подготовка текста и стилей
        const text = source.getText();
        const style = source.getTextStyle() || {};
        const fontSize = parseFloat(style.fontSize) || 12;
        const fontFamily = style.fontFamily || 'sans-serif';
        const color = style.color || '#333';
        const lineHeight = Math.ceil(fontSize * 1.2);

        let lines;
        if (source.getLabelType() === 'point') {
            const wrapped = this._wrapPointText(text, fontSize);
            lines = wrapped.split('\n');
        } else {
            lines = [text];
        }

        // 2. Измерение текста
        const canvas = document.createElement('canvas');
        const ctx = canvas.getContext('2d');
        ctx.font = `${fontSize}px ${fontFamily}`;
        let maxWidth = 0;
        for (const line of lines) {
            const w = ctx.measureText(line).width;
            if (w > maxWidth) maxWidth = w;
        }
        const textWidth = Math.ceil(maxWidth);
        const textHeight = lineHeight * lines.length;

        // 3. Создание canvas с учётом смещения (offset)
        const [offX, offY] = source.getTitleOffset ? source.getTitleOffset() : [0, 0];
        const totalWidth = Math.ceil(textWidth + Math.abs(offX));
        const totalHeight = Math.ceil(textHeight + Math.abs(offY));

        canvas.width = totalWidth;
        canvas.height = totalHeight;

        ctx.font = `${fontSize}px ${fontFamily}`;
        ctx.fillStyle = color;
        ctx.textBaseline = 'top';
        ctx.textAlign = 'left';
        const startX = offX > 0 ? offX : 0;
        const startY = offY > 0 ? offY : 0;
        lines.forEach((line, i) => {
            ctx.fillText(line, startX, startY + i * lineHeight);
        });

        // 4. Создание текстуры и спрайта
        const texture = new THREE.CanvasTexture(canvas);
        texture.minFilter = THREE.LinearFilter;
        texture.magFilter = THREE.LinearFilter;

        const material = new THREE.SpriteMaterial({
            map: texture,
            sizeAttenuation: false,
            transparent: true,
            depthTest: false,
            depthWrite: false
        });
        const sprite = new THREE.Sprite(material);
        sprite.scale.set(canvas.width, canvas.height, 1);
        sprite.center.set(0, 0);

        this.labelGroup.add(sprite);

        const label = {
            source,
            sprite,
            canvas,
            texture,
            material,
            width: textWidth,   // реальная ширина текста (для коллизий)
            height: textHeight, // реальная высота текста (для коллизий)
            t: 0,
            stuck: false,
            hiddenByPriority: false,
            priority: source.getPriority ? source.getPriority() : 0,
            allowOverflow: source.getAllowOverflow ? source.getAllowOverflow() : false
        };
        this.labels.push(label);
        return label;
    }

    /**
     * Удаляет подпись из менеджера и освобождает ресурсы.
     *
     * @param {Object} label - Объект подписи, ранее возвращённый методом addLabel.
     */
    removeLabel(label) {
        const idx = this.labels.indexOf(label);
        if (idx > -1) {
            this.labels.splice(idx, 1);
            this.labelGroup.remove(label.sprite);
            label.texture.dispose();
            label.material.dispose();
        }
    }

    /**
     * Преобразует длинный текст точечной подписи в многострочный.
     * (Без изменений)
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

        return lines.length > 1 ? lines.join('\n') : text;
    }

    /**
     * Вычисляет экранные координаты четырёх углов прямоугольника подписи.
     * Использует экранные методы источника (getScreenPosition / getScreenPositionAt),
     * чтобы сохранить совместимость со старыми источниками.
     *
     * @param {Object} label - Объект подписи.
     * @param {number|null} [tOverride=null] - Параметр t для линейной подписи.
     * @returns {Object[]|null} Массив из четырёх точек {x, y} углов прямоугольника.
     * @private
     */
    _getLabelCorners(label, tOverride = null) {
        const src = label.source;
        let scrX, scrY;

        if (src.getLabelType() === 'line') {
            const t = tOverride !== null ? tOverride : label.t;
            const pos = src.getScreenPositionAt(t);
            if (!pos) return null;
            scrX = pos.x;
            scrY = pos.y;
        } else {
            const pos = src.getScreenPosition();
            if (!pos) return null;
            scrX = pos.x;
            scrY = pos.y;
        }

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

        const top = scrY - anchorY + offY;
        const left = scrX - anchorX + offX;

        return [
            { x: left, y: top },
            { x: left + w, y: top },
            { x: left + w, y: top + h },
            { x: left, y: top + h }
        ];
    }

    /**
     * Преобразует экранные координаты в мировые, используя пересечение луча
     * с плоскостью земли (или поверхностью рельефа, если она доступна).
     * Используется как fallback, когда источник не предоставляет мировые координаты.
     *
     * @param {number} screenX - Экранная координата X (пиксели).
     * @param {number} screenY - Экранная координата Y (пиксели).
     * @returns {THREE.Vector3|null} Мировая позиция или null, если не удалось вычислить.
     * @private
     */
    _worldFromScreen(screenX, screenY) {
        const map = this.map;
        const camera = map.camera;
        const canvas = map.targetElement;
        const rect = canvas.getBoundingClientRect();

        // Нормализованные координаты устройства (NDC)
        const x = ((screenX - rect.left) / rect.width) * 2 - 1;
        const y = -((screenY - rect.top) / rect.height) * 2 + 1;

        const vector = new THREE.Vector3(x, y, 0.5);
        vector.unproject(camera);
        const dir = vector.sub(camera.position).normalize();

        // Пересечение с плоскостью y = 0 (можно улучшить, используя рельеф)
        const t = -camera.position.y / dir.y;
        if (t < 0) return null; // точка за камерой
        const point = camera.position.clone().add(dir.multiplyScalar(t));
        return point;
    }

    /**
     * Получает мировую позицию для подписи.
     * Если у источника есть getWorldPosition (или getWorldPositionAt для линии),
     * использует её; иначе вычисляет через _worldFromScreen.
     *
     * @param {Object} label - Объект подписи.
     * @param {number} [t] - Параметр t для линейной подписи.
     * @returns {THREE.Vector3|null} Мировая позиция.
     * @private
     */
    _getWorldPosition(label, t = null) {
        const src = label.source;
        if (src.getLabelType() === 'line') {
            if (typeof src.getWorldPositionAt === 'function') {
                return src.getWorldPositionAt(t !== null ? t : label.t);
            } else {
                const pos = src.getScreenPositionAt(t !== null ? t : label.t);
                if (!pos) return null;
                return this._worldFromScreen(pos.x, pos.y);
            }
        } else {
            if (typeof src.getWorldPosition === 'function') {
                return src.getWorldPosition();
            } else {
                const pos = src.getScreenPosition();
                if (!pos) return null;
                return this._worldFromScreen(pos.x, pos.y);
            }
        }
    }

    /**
     * Проецирует полигон на заданную ось.
     * (Без изменений)
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
     * Проверяет пересечение двух выпуклых полигонов методом SAT.
     * (Без изменений)
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
     * Главный метод обновления всех подписей.
     * Выполняет сбор видимых, раздвижение линий, жадную приоритезацию и рендеринг спрайтов.
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
                label.sprite.visible = false;
                continue;
            }
            if (!src.isVisible()) {
                label.sprite.visible = false;
                continue;
            }

            label.priority = src.getPriority ? src.getPriority() : 0;
            label.allowOverflow = src.getAllowOverflow ? src.getAllowOverflow() : false;
            label.hiddenByPriority = false;

            if (src.getLabelType() === 'line') {
                const iv = src.getVisibleInterval();
                if (!iv) {
                    label.sprite.visible = false;
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
                // Для точки достаточно проверить наличие экранной позиции
                const pos = src.getScreenPosition();
                if (!pos) {
                    label.sprite.visible = false;
                    continue;
                }
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

                    const relevant = overlapping.filter(o => o.priority >= lbl.priority);
                    if (relevant.length === 0) continue;

                    // Текущая экранная позиция линии
                    const pi = lbl.source.getScreenPositionAt(lbl.t);
                    if (!pi) continue;

                    let forceX = 0, forceY = 0;
                    for (const other of relevant) {
                        let pj;
                        if (other.source.getLabelType() === 'line') {
                            pj = other.source.getScreenPositionAt(other.t);
                        } else {
                            pj = other.source.getScreenPosition();
                        }
                        if (!pj) continue;

                        const dx = pi.x - pj.x;
                        const dy = pi.y - pj.y;
                        const dist2 = dx * dx + dy * dy + 1;
                        const forceMag = 1 / dist2;
                        forceX += (dx / Math.sqrt(dist2)) * forceMag;
                        forceY += (dy / Math.sqrt(dist2)) * forceMag;
                    }

                    // Касательная в экранных координатах (по двум близким точкам)
                    const tEps = 0.001;
                    const p1 = lbl.source.getScreenPositionAt(Math.max(0, lbl.t - tEps));
                    const p2 = lbl.source.getScreenPositionAt(Math.min(1, lbl.t + tEps));
                    if (!p1 || !p2) continue;
                    const tangentX = p2.x - p1.x;
                    const tangentY = p2.y - p1.y;
                    const len = Math.sqrt(tangentX * tangentX + tangentY * tangentY);
                    if (len < 1e-6) continue;
                    const normX = tangentX / len;
                    const normY = tangentY / len;

                    const dot = forceX * normX + forceY * normY;
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

            // Определение stuck
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

            // Сохраняем t для незастрявших
            for (const lbl of lineLabels) {
                if (lbl.stuck) {
                    lbl.t = lbl.source.getLabelParameter();
                } else {
                    lbl.source.setLabelParameter(lbl.t);
                }
            }
        }

        // 3. Жадная приоритезация
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

        // 4. Применение позиций и видимости к спрайтам
        for (const label of visibleLabels) {
            const sprite = label.sprite;
            if (label.hiddenByPriority) {
                sprite.visible = false;
                continue;
            }

            // Получаем мировую позицию (напрямую или через экранные координаты)
            const worldPos = this._getWorldPosition(label);
            if (!worldPos) {
                sprite.visible = false;
                continue;
            }

            sprite.position.copy(worldPos);
            sprite.visible = true;
        }

        // Скрываем спрайты, не попавшие в visibleLabels
        for (const label of this.labels) {
            if (!visibleLabels.includes(label)) {
                label.sprite.visible = false;
            }
        }
    }
}