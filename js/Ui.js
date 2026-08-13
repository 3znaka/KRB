/**
 * Модуль пользовательского интерфейса картографической библиотеки.
 * Создаёт и управляет элементами управления: масштабная линейка,
 * координаты, кнопки зума/компаса и атрибуция.
 *
 * @module ui
 */

import { DEFAULTS, toLonLat } from './Utils.js';
import {
  THREE
} from '../js_TP/tpb.js';  

/**
 * Инициализирует интерфейс карты внутри указанного контейнера.
 * Добавляет панель с кнопками, масштабной линейкой и атрибуцией,
 * запускает цикл анимации для обновления показаний.
 *
 * @param {Object} map - Экземпляр карты, предоставляющий доступ к состоянию и методам.
 * @param {HTMLElement} map.targetElement - DOM-элемент, в который будет добавлен UI.
 * @param {number} map.continuousZoom - Текущее непрерывное значение зума.
 * @param {Object} map.worldGroup - Группа, содержащая тайлы.
 * @param {THREE.Vector3} map.worldGroup.position - Смещение группы в мировых координатах.
 * @param {Object} map.controls - Орбитальные контролы.
 * @param {THREE.Vector3} map.controls.target - Точка цели камеры.
 * @param {number} [map.R] - Радиус планеты (по умолчанию из {@link DEFAULTS.R}).
 * @param {Function} map.applyZoomDelta - Функция изменения зума на заданный шаг.
 * @param {Function} map.resetBearing - Функция сброса направления (север вверх).
 * @param {number} map.currentDiscreteZoom - Текущий дискретный уровень зума.
 * @param {THREE.Camera} map.camera - Камера сцены.
 * @param {Array} [map.layers] - Массив слоёв карты (первый используется для атрибуции).
 */
export function initUI(map) {

    const container = map.targetElement;

    const getImgUrl = (filename) => new URL(`./img/${filename}`, import.meta.url).href;

    // Корневой pane
    const pane = document.createElement('div');
    pane.id = 'krb-ui-pane';
    pane.className = 'krb-ui-pane';
    container.appendChild(pane);

    // Левый нижний угол: масштабная линейка + логотип
    const leftBottom = document.createElement('div');
    leftBottom.className = 'krb-left-bottom';
    pane.appendChild(leftBottom);

    // Масштабная линейка
    const scaleContainer = document.createElement('div');
    const scaleBar = document.createElement('div');
    scaleBar.className = 'krb-scale-bar';
    const scaleLabel = document.createElement('div');
    scaleLabel.className = 'krb-scale-label';
    const zoomLabel = document.createElement('div');
    zoomLabel.className = 'krb-zoom-label';
    const coordLabel = document.createElement('span');
    coordLabel.className = 'krb-coord-label';
    zoomLabel.appendChild(coordLabel);
    pane.appendChild(zoomLabel);
    scaleContainer.appendChild(scaleBar);
    scaleBar.appendChild(scaleLabel);
    leftBottom.appendChild(scaleContainer);

    // Логотип
    const logo = document.createElement('img');
    logo.src = getImgUrl('logo.svg');
    logo.className = 'krb-logo';
    leftBottom.appendChild(logo);

    // Правый нижний угол: кнопки и атрибуция
    const rightBottom = document.createElement('div');
    rightBottom.className = 'krb-right-bottom';
    pane.appendChild(rightBottom);

    // Кнопки
    const buttons = document.createElement('div');
    buttons.className = 'krb-buttons';
    
    const btnPlus = document.createElement('button');
    btnPlus.innerHTML = `<img src="${getImgUrl('plus.svg')}">`;
    btnPlus.className = 'krb-btn';
    
    const btnMinus = document.createElement('button');
    btnMinus.innerHTML = `<img src="${getImgUrl('minus.svg')}">`;
    btnMinus.className = 'krb-btn';
    
    const btnCompass = document.createElement('button');
    btnCompass.innerHTML = `<img src="${getImgUrl('compass.svg')}">`;
    btnCompass.className = 'krb-btn';
    
    buttons.appendChild(btnPlus);
    buttons.appendChild(btnMinus);
    buttons.appendChild(btnCompass);
    rightBottom.appendChild(buttons);

    // Атрибуция
    const attribution = document.createElement('div');
    attribution.className = 'krb-attribution';
    rightBottom.appendChild(attribution);

    const layer = map.layers?.[0];
    if (layer?.attributionTitle) {
        const link = document.createElement('a');
        link.href = layer.attributionUrl || '#';
        link.textContent = '© ' + layer.attributionTitle;
        link.className = 'krb-attribution-link';
        link.target = '_blank';
        attribution.appendChild(link);
    }

    // Обработчики кнопок
    btnPlus.addEventListener('click', (e) => {
        e.stopPropagation();
        map.applyZoomDelta(1);
    });
    btnMinus.addEventListener('click', (e) => {
        e.stopPropagation();
        map.applyZoomDelta(-1);
    });
    btnCompass.addEventListener('click', (e) => {
        e.stopPropagation();
        map.resetBearing();
    });

    /**
     * Обновляет масштабную линейку, координаты и подпись зума.
     * Вызывается в каждом кадре анимации.
     * @private
     */
    function updateScaleBar() {
        const zoom = map.continuousZoom;
        const worldPos = map.worldGroup.position;
        const target = map.controls.target;

        const centerX = target.x - worldPos.x;
        const centerZ = target.z - worldPos.z;

        const [lon, lat] = toLonLat([centerX, centerZ]);

        // Новые вычисления углов камеры
        const cameraPos = map.camera.position;
        const dir = new THREE.Vector3().subVectors(cameraPos, target);
        const dist = dir.length();
        const pitchRad = dist > 1e-6 ? Math.acos(dir.y / dist) : 0;
        const bearingRad = dist > 1e-6 ? Math.atan2(dir.x, -dir.z) : 0;
        const pitchDeg = (pitchRad * 180 / Math.PI).toFixed(1);
        const bearingDeg = (bearingRad * 180 / Math.PI).toFixed(1);

        // Формируем строку с координатами и углами
        coordLabel.textContent = `${lon.toFixed(3)}, ${lat.toFixed(3)}  ·  ${pitchDeg}° / ${bearingDeg}°`;

        const R = map.R ?? DEFAULTS.R;
        const tileSize = 256;
        const resolutionAtEquator = (2 * Math.PI * R) / (tileSize * Math.pow(2, zoom));
        const resolution = resolutionAtEquator * Math.cos(lat * Math.PI / 180);

        const barLengthPx = 100;
        let distance = resolution * barLengthPx * 0.623 * 1.5;

        const nice = niceDistance(distance);
        const ratio = nice / distance;
        scaleBar.style.width = (barLengthPx * ratio) + 'px';
        scaleLabel.textContent = formatDistance(nice);

        zoomLabel.childNodes[1]?.remove();
        zoomLabel.appendChild(document.createTextNode(` (${map.currentDiscreteZoom})`));
    }

    /**
     * Приводит расстояние к "красивому" круглому значению для отображения на линейке.
     * @param {number} value - Фактическое расстояние в метрах.
     * @returns {number} Округлённое расстояние.
     * @private
     */
    function niceDistance(value) {
        const pow = Math.pow(10, Math.floor(Math.log10(value)));
        const frac = value / pow;
        let nice;
        if (frac <= 1.2) nice = 1;
        else if (frac <= 2.4) nice = 2;
        else if (frac <= 6) nice = 5;
        else nice = 10;
        return nice * pow;
    }

    /**
     * Форматирует расстояние в метрах или километрах для отображения.
     * @param {number} m - Расстояние в метрах.
     * @returns {string} Строка с единицами измерения.
     * @private
     */
    function formatDistance(m) {
        if (m >= 1000) return (m / 1000).toFixed(0) + ' км';
        return m.toFixed(0) + ' м';
    }

    /**
     * Цикл анимации: обновляет UI и поворачивает значок компаса.
     * @private
     */
    function animateUI() {
        updateScaleBar();
        
        const dir = new THREE.Vector3().subVectors(
            map.controls.target,
            map.camera.position
        );
        dir.y = 0; // проекция на горизонтальную плоскость

        if (dir.length() > 1e-6) {
            dir.normalize();
            // север – это (0, 0, -1), поэтому atan2(dir.x, -dir.z) даёт угол
            // по часовой стрелке от севера (bearing)
            const bearingRad = Math.atan2(dir.x, -dir.z);
            const bearingDeg = THREE.MathUtils.radToDeg(bearingRad); // или * 180 / Math.PI
            const compassSvg = btnCompass.querySelector('img');
            compassSvg.style.transform = `rotate(${-bearingDeg}deg)`;
        }
        
        requestAnimationFrame(animateUI);
    }
    
    animateUI();
}