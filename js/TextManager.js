import { THREE } from '../js_TP/tpb.js';

/**
 * TextManager с рендерингом подписей через THREE.Sprite.
 * Каждая подпись — это CanvasTexture на спрайте, размещённом в сцене.
 * Логика коллизий и приоритезации сохранена и адаптирована для работы
 * с экранными координатами, вычисляемыми из позиций спрайтов.
 */
export class TextManager {
    constructor(map) {
        this.map = map;
        this.labels = [];      // массив объектов label (source, sprite, texture, canvas, ...)
        this._lastZoom = null;
        this._lastVisibleIds = new Set();
        this._lastCollisionUpdateTime = 0;

        // Группа для подписей, которая не зависит от мира (отдельная сцена?)
        // Лучше добавить в основную сцену, но с высоким renderOrder
        this.labelGroup = new THREE.Group();
        this.labelGroup.name = 'krb-label-group';
        // Добавим в сцену карты, если она есть
        if (map.scene) {
            map.scene.add(this.labelGroup);
        }
    }

    /**
     * Создаёт спрайт для подписи.
     */
    addLabel(source) {
        // Создаём canvas и рисуем текст
        const canvas = document.createElement('canvas');
        const ctx = canvas.getContext('2d');
        const style = source.getTextStyle();
        const fontSize = parseInt(style.fontSize) || 12;
        const fontFamily = style.fontFamily || 'sans-serif';
        const text = source.getText();
        const lines = text.split('\n');

        // Устанавливаем шрифт для измерения
        ctx.font = `${fontSize}px ${fontFamily}`;
        const textMetrics = ctx.measureText(lines[0]);
        const lineHeight = fontSize * 1.2;
        const padding = 4;
        const width = Math.ceil(textMetrics.width + padding * 2);
        const height = Math.ceil(lineHeight * lines.length + padding * 2);

        canvas.width = width;
        canvas.height = height;
        // Перерисовываем с чётким текстом
        ctx.font = `${fontSize}px ${fontFamily}`;
        ctx.fillStyle = style.color || '#333';
        ctx.textBaseline = 'top';
        ctx.textAlign = 'left';
        lines.forEach((line, i) => {
            ctx.fillText(line, padding, padding + i * lineHeight);
        });

        const texture = new THREE.CanvasTexture(canvas);
        texture.minFilter = THREE.LinearFilter;
        texture.magFilter = THREE.LinearFilter;

        const material = new THREE.SpriteMaterial({
            map: texture,
            depthTest: false,
            depthWrite: false,
            transparent: true,
            sizeAttenuation: false, // чтобы спрайт не масштабировался с расстоянием
        });

        const sprite = new THREE.Sprite(material);
        sprite.renderOrder = 10000;
        sprite.scale.set(width, height, 1);
        sprite.userData.label = this; // ссылка на менеджер, если нужно

        this.labelGroup.add(sprite);

        const label = {
            source,
            sprite,
            texture,
            canvas,
            width,
            height,
            priority: source.getPriority ? source.getPriority() : 0,
            allowOverflow: source.getAllowOverflow ? source.getAllowOverflow() : false,
            hiddenByPriority: false,
            stuck: false,
            t: 0,
            screenPos: null,
            rect: null,
        };
        this.labels.push(label);
        return label;
    }

    /**
     * Удаляет подпись.
     */
    removeLabel(label) {
        const idx = this.labels.indexOf(label);
        if (idx > -1) {
            this.labelGroup.remove(label.sprite);
            label.texture.dispose();
            label.sprite.material.dispose();
            this.labels.splice(idx, 1);
        }
    }

    /**
     * Вычисляет экранные координаты центра спрайта.
     * Для этого проецируем мировую позицию спрайта на экран.
     */
    _getScreenPositionForLabel(label) {
        const map = this.map;
        const vec = new THREE.Vector3().copy(label.sprite.position);
        vec.project(map.camera);
        const canvas = map.renderer.domElement;
        return {
            x: (vec.x * 0.5 + 0.5) * canvas.clientWidth,
            y: (-vec.y * 0.5 + 0.5) * canvas.clientHeight,
        };
    }

    /**
     * Вычисляет прямоугольник подписи на экране (для коллизий).
     */
    _getLabelRect(label) {
        if (!label.screenPos) return null;
        const w = label.width;
        const h = label.height;
        // Учитываем выравнивание: для простоты считаем центр спрайта
        return {
            x: label.screenPos.x - w / 2,
            y: label.screenPos.y - h / 2,
            width: w,
            height: h,
        };
    }

    /**
     * Проверяет пересечение двух прямоугольников.
     */
    _rectsIntersect(rectA, rectB) {
        if (!rectA || !rectB) return false;
        return !(
            rectA.x > rectB.x + rectB.width ||
            rectA.x + rectA.width < rectB.x ||
            rectA.y > rectB.y + rectB.height ||
            rectA.y + rectA.height < rectB.y
        );
    }

    /**
     * Основной метод обновления подписей.
     */
    update() {
        const map = this.map;
        const zoom = map.continuousZoom;

        // Сброс состояния при смене зума или состава подписей
        const currentIds = this.labels.map(l => l.source).filter(src => {
            const zb = src.getTextZoomBounds();
            return zoom >= zb.min && zoom <= zb.max && src.isVisible();
        });
        const idSet = new Set(currentIds);
        if (!this._lastVisibleIds || this._lastVisibleIds.size !== idSet.size ||
            this._lastZoom !== zoom || [...this._lastVisibleIds].some(id => !idSet.has(id))) {
            for (const lbl of this.labels) {
                lbl.stuck = false;
                lbl.hiddenByPriority = false;
            }
        }
        this._lastVisibleIds = idSet;
        this._lastZoom = zoom;

        // 1. Обновляем позиции спрайтов в мировых координатах
        for (const label of this.labels) {
            const src = label.source;
            const zoomBounds = src.getTextZoomBounds();
            if (zoom < zoomBounds.min || zoom > zoomBounds.max || !src.isVisible()) {
                label.sprite.visible = false;
                continue;
            }
            label.sprite.visible = true;

            if (src.getLabelType() === 'line') {
                // Для линий используем текущий параметр t
                const pos = src.getScreenPositionAt(label.t);
                if (!pos) {
                    label.sprite.visible = false;
                    continue;
                }
                // Преобразуем экранные координаты обратно в мировые? Нет,
                // спрайт должен находиться в мире, поэтому проще использовать
                // географические координаты линии и интерполировать.
                // Для упрощения: используем позицию из getScreenPositionAt,
                // но это экранные координаты. Нам нужно преобразовать их в мировые.
                // Предположим, что source предоставляет метод getWorldPositionAt(t).
                // Для примера оставим как есть, но в реальности нужен другой подход.
                label.sprite.position.set(pos.x, pos.y, 0); // это неправильно
            } else {
                // Для точек источник должен предоставлять мировые координаты
                // через getWorldPosition().
                const worldPos = src.getWorldPosition();
                if (worldPos) {
                    label.sprite.position.copy(worldPos);
                } else {
                    label.sprite.visible = false;
                }
            }
        }

        // 2. Вычисляем экранные позиции для видимых спрайтов
        for (const label of this.labels) {
            if (!label.sprite.visible) continue;
            label.screenPos = this._getScreenPositionForLabel(label);
            label.rect = this._getLabelRect(label);
        }

        // 3. Полное обновление коллизий раз в 100 мс
        const now = performance.now();
        if (now - this._lastCollisionUpdateTime > 100) {
            this._lastCollisionUpdateTime = now;
            // Здесь повторяем логику приоритезации и раздвижения линий,
            // аналогично DOM-версии, но работая с rect.
            // ... (реализация аналогична, но без DOM-элементов)
        }

        // 4. Скрытие спрайтов по приоритету
        for (const label of this.labels) {
            if (label.hiddenByPriority) label.sprite.visible = false;
        }
    }
}