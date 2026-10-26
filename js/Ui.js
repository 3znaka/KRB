/**
 * Модуль пользовательского интерфейса картографической библиотеки.
 * Создаёт и управляет элементами управления: масштабная линейка,
 * координаты, кнопки зума/компаса и атрибуция.
 *
 * @module ui
 */

import {
  THREE
} from '../js_TP/tpb.js';

/**
 * Инициализирует интерфейс карты внутри указанного контейнера.
 * Добавляет панель с кнопками, масштабной линейкой и атрибуцией,
 * запускает цикл анимации для обновления показаний.
 *
 * Возвращает дескриптор с методом destroy() — для остановки цикла
 * и удаления UI из DOM.
 *
 * @param {Object} map - Экземпляр карты, предоставляющий доступ к состоянию и методам.
 * @param {HTMLElement} map.targetElement - DOM-элемент, в который будет добавлен UI.
 * @param {number} map.continuousZoom - Текущее непрерывное значение зума.
 * @param {number} map.currentDiscreteZoom - Текущий дискретный уровень зума.
 * @param {Object} map.worldGroup - Группа, содержащая тайлы.
 * @param {THREE.Vector3} map.worldGroup.position - Смещение группы в мировых координатах.
 * @param {Object} map.controls - Орбитальные контролы.
 * @param {THREE.Vector3} map.controls.target - Точка цели камеры.
 * @param {number} [map.R] - Радиус планеты карты (используется для отображения).
 * @param {Function} map.applyZoomDelta - Функция изменения зума на заданный шаг.
 * @param {Function} map.resetBearing - Функция сброса направления (север вверх).
 * @param {Function} map.unprojectToLonLat - Преобразование мировых координат в WGS84.
 * @param {THREE.Camera} map.camera - Камера сцены.
 * @param {THREE.WebGLRenderer} map.renderer - Рендерер (для размеров canvas).
 * @param {THREE.Plane} map.groundPlane - Плоскость земли.
 * @param {Array} [map.layers] - Массив слоёв карты (первый используется для атрибуции).
 * @returns {{destroy: Function}} Дескриптор для уничтожения UI.
 */
export function initUI(map) {

    const container = map.targetElement;

    const getImgUrl = (filename) => new URL(`./img/${filename}`, import.meta.url).href;

    // ---- Защита от повторной инициализации ----
    // Если pane уже существует — переиспользуем его, чтобы не плодить
    // дублирующиеся элементы и обработчики.
    let pane = container.querySelector('#krb-ui-pane');
    if (pane) {
        // Уже инициализировано ранее — новая инициализация не требуется.
        return { destroy: () => {} };
    }

    pane = document.createElement('div');
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

    const fpsLabel = document.createElement('span');
    fpsLabel.className = 'krb-fps-label';
    fpsLabel.textContent = 'FPS: --';
    zoomLabel.appendChild(fpsLabel);

    const zoomValueLabel = document.createElement('span');
    zoomValueLabel.className = 'krb-zoom-value';
    zoomLabel.appendChild(zoomValueLabel);

    pane.appendChild(zoomLabel);

    scaleContainer.appendChild(scaleBar);
    scaleBar.appendChild(scaleLabel);
    leftBottom.appendChild(scaleContainer);

    // Логотип
    const logo = document.createElement('img');
    logo.src = getImgUrl('../img/logo.svg');
    logo.className = 'krb-logo';
    const logoLink = document.createElement('a');
    logoLink.href = 'https://mapengine.ru';
    logoLink.style.pointerEvents = 'all';
    logoLink.target = '_blank';
    logoLink.rel = 'noopener noreferrer';
    logoLink.appendChild(logo);
    leftBottom.appendChild(logoLink);

    // Правый нижний угол: кнопки и атрибуция
    const rightBottom = document.createElement('div');
    rightBottom.className = 'krb-right-bottom';
    pane.appendChild(rightBottom);

    // Кнопки
    const buttons = document.createElement('div');
    buttons.className = 'krb-buttons';

    const btnPlus = document.createElement('button');
    btnPlus.innerHTML = `<img src="${getImgUrl('../img/plus.svg')}" alt="+">`;
    btnPlus.className = 'krb-btn';
    btnPlus.setAttribute('aria-label', 'Приблизить');

    const btnMinus = document.createElement('button');
    btnMinus.innerHTML = `<img src="${getImgUrl('../img/minus.svg')}" alt="−">`;
    btnMinus.className = 'krb-btn';
    btnMinus.setAttribute('aria-label', 'Отдалить');

    const btnCompass = document.createElement('button');
    btnCompass.innerHTML = `<img src="${getImgUrl('../img/compass.svg')}" alt="Север">`;
    btnCompass.className = 'krb-btn';
    btnCompass.setAttribute('aria-label', 'Повернуть на север');

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
        const attrLink = document.createElement('a');
        attrLink.href = layer.attributionUrl || '#';
        attrLink.textContent = '© ' + layer.attributionTitle;
        attrLink.className = 'krb-attribution-link';
        attrLink.target = '_blank';
        attrLink.rel = 'noopener noreferrer';
        // Pane имеет pointer-events: none, поэтому ссылка не кликается
        // без явного разрешения pointer-events.
        attrLink.style.pointerEvents = 'all';
        attribution.appendChild(attrLink);
    }

    // Кэш ссылки на иконку компаса — ищем один раз, а не каждый кадр.
    const compassSvg = btnCompass.querySelector('img');

    // ---- Обработчики кнопок ----
    const onPlusClick = (e) => { e.stopPropagation(); map.applyZoomDelta(1); };
    const onMinusClick = (e) => { e.stopPropagation(); map.applyZoomDelta(-1); };
    const onCompassClick = (e) => { e.stopPropagation(); map.resetBearing(); };

    btnPlus.addEventListener('click', onPlusClick);
    btnMinus.addEventListener('click', onMinusClick);
    btnCompass.addEventListener('click', onCompassClick);

    // ---- Переиспользуемые объекты Three.js (без аллокаций в hot path) ----
    const _raycaster = new THREE.Raycaster();
    const _ndc = new THREE.Vector2();
    const _hit1 = new THREE.Vector3();
    const _hit2 = new THREE.Vector3();
    const _dirVec = new THREE.Vector3();
    const _plane = map.groundPlane || new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);

    /**
     * Геодезическое расстояние между двумя точками WGS84 (в метрах)
     * по формуле гаверсинуса.
     *
     * Работает независимо от проекции карты: на вход принимает уже
     * готовые lon/lat, полученные через `map.unprojectToLonLat`
     * (то есть корректно переведённые из world-координат текущей
     * проекции — Mercator, UTM, Equal Earth, азимутальной и т.д.).
     *
     * Корректно обрабатывает переход через антимеридиан (Δlon
     * сворачивается в (−180, 180]) и полюса.
     *
     * @param {number} lon1 - Долгота точки 1, градусы.
     * @param {number} lat1 - Широта точки 1, градусы.
     * @param {number} lon2 - Долгота точки 2, градусы.
     * @param {number} lat2 - Широта точки 2, градусы.
     * @param {number} R - Радиус сферы, метры.
     * @returns {number} Расстояние по большому кругу, метры.
     */
    function haversineDistance(lon1, lat1, lon2, lat2, R) {
        const toRad = Math.PI / 180;

        let dLon = lon2 - lon1;
        if (dLon > 180) dLon -= 360;
        else if (dLon < -180) dLon += 360;

        const dLatRad = (lat2 - lat1) * toRad;
        const dLonRad = dLon * toRad;
        const lat1Rad = lat1 * toRad;
        const lat2Rad = lat2 * toRad;

        const a =
            Math.sin(dLatRad / 2) * Math.sin(dLatRad / 2) +
            Math.cos(lat1Rad) * Math.cos(lat2Rad) *
            Math.sin(dLonRad / 2) * Math.sin(dLonRad / 2);

        return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)));
    }

    /**
     * Приводит расстояние к «красивому» круглому значению для отображения на линейке.
     *
     * @param {number} value - Фактическое расстояние в метрах.
     * @returns {number} Округлённое расстояние.
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
     *
     * @param {number} m - Расстояние в метрах.
     * @returns {string} Строка с единицами измерения.
     */
    function formatDistance(m) {
        if (m >= 1000) return (m / 1000).toFixed(0) + ' км';
        return m.toFixed(0) + ' м';
    }

    /**
     * Вычисляет угол направления камеры (bearing) в градусах.
     * Ноль — север, по часовой стрелке. Использует горизонтальную проекцию
     * вектора target − camera. Результат в диапазоне (−180, 180].
     *
     * @returns {number} Bearing в градусах.
     */
    function computeBearingDeg() {
        _dirVec.subVectors(map.controls.target, map.camera.position);
        _dirVec.y = 0;
        if (_dirVec.lengthSq() < 1e-12) return 0;
        const bearingRad = Math.atan2(_dirVec.x, -_dirVec.z);
        return bearingRad * 180 / Math.PI;
    }

    /**
     * Обновляет масштабную линейку, координаты и подпись зума.
     * Вызывается в каждом кадре анимации.
     *
     * Масштаб вычисляется универсально — через две экранные точки:
     *
     *  1. Берём центр экрана и центр + barLengthPx вправо.
     *  2. Обе точки пересекаем лучом с плоскостью земли (y = 0)
     *     и получаем world-координаты в CRS карты.
     *  3. Переводим обе world-точки в lon/lat через `map.unprojectToLonLat`
     *     (это обратное преобразование именно текущей проекции).
     *  4. Считаем геодезическое расстояние между двумя lon/lat по
     *     гаверсинусу.
     *
     * Такой подход не делает никаких предположений о масштабном
     * факторе проекции и потому корректен для Mercator (3857/3395),
     * UTM, Equal Earth, азимутальных и любых других CRS.
     */
    function updateScaleBar() {
        const worldPos = map.worldGroup.position;
        const target = map.controls.target;

        const centerX = target.x - worldPos.x;
        const centerZ = target.z - worldPos.z;

        // Мировые координаты центра → WGS84 через проекцию карты.
        // Работает для любой зарегистрированной проекции (3857, 3395, ...).
        const [lon, lat] = map.unprojectToLonLat(centerX, centerZ);

        // Точка вне домена проекции (или «уехавшие» градусы) — UI
        // не трогаем, оставляем последнее валидное значение.
        if (!Number.isFinite(lon) || !Number.isFinite(lat) ||
            Math.abs(lon) > 180.0001 || Math.abs(lat) > 90.0001) {
            return;
        }

        // Наклон камеры (pitch) — угол между направлением target→camera и осью Y.
        _dirVec.subVectors(map.camera.position, target);
        const dist = _dirVec.length();
        const pitchRad = dist > 1e-6 ? Math.acos(_dirVec.y / dist) : 0;
        const pitchDeg = (pitchRad * 180 / Math.PI).toFixed(1);

        // Bearing — из общей функции, чтобы значения в линейке и на компасе
        // всегда совпадали.
        const bearingDeg = computeBearingDeg().toFixed(1);

        // Координаты и углы
        coordLabel.textContent = `${lon.toFixed(3)}, ${lat.toFixed(3)}  ·  ${pitchDeg}° / ${bearingDeg}°`;

        // ---- Реальное расстояние для масштабной линейки ----
        const barLengthPx = 100;
        const rect = map.renderer.domElement.getBoundingClientRect();
        if (!rect.width || !rect.height) return;

        // Центр экрана → точка на земле
        _ndc.set(0, 0);
        _raycaster.setFromCamera(_ndc, map.camera);
        if (!_raycaster.ray.intersectPlane(_plane, _hit1)) return;

        // Центр + barLengthPx вправо → точка на земле
        const ndcOffsetX = (2 * barLengthPx) / rect.width;
        _ndc.set(ndcOffsetX, 0);
        _raycaster.setFromCamera(_ndc, map.camera);
        if (!_raycaster.ray.intersectPlane(_plane, _hit2)) return;

        // world → lon/lat (вычитаем offset worldGroup, т.к. unprojectToLonLat
        // ожидает координаты без учёта сдвига мира).
        const [lon1, lat1] = map.unprojectToLonLat(
            _hit1.x - worldPos.x, _hit1.z - worldPos.z
        );
        const [lon2, lat2] = map.unprojectToLonLat(
            _hit2.x - worldPos.x, _hit2.z - worldPos.z
        );

        if (!Number.isFinite(lon1) || !Number.isFinite(lat1) ||
            !Number.isFinite(lon2) || !Number.isFinite(lat2)) {
            return;
        }
        if (Math.abs(lon1) > 180.0001 || Math.abs(lat1) > 90.0001) return;
        if (Math.abs(lon2) > 180.0001 || Math.abs(lat2) > 90.0001) return;

        // Радиус сферы: используем R карты, если он задан (для не-земных
        // карт), иначе средний радиус Земли WGS84.
        const R = (Number.isFinite(map.R) && map.R > 0) ? map.R : 6371008.8;
        const distance = haversineDistance(lon1, lat1, lon2, lat2, R);

        if (distance > 0) {
            const nice = niceDistance(distance);
            const ratio = nice / distance;
            scaleBar.style.width = (barLengthPx * ratio) + 'px';
            scaleLabel.textContent = formatDistance(nice);
        }

        zoomValueLabel.textContent = ` (${map.currentDiscreteZoom})`;
    }

    let lastFpsUpdate = performance.now();
    let frames = 0;
    let rafId = null;
    let destroyed = false;

    /**
     * Цикл анимации: обновляет UI и поворачивает значок компаса.
     */
    function animateUI() {
        if (destroyed) return;

        const now = performance.now();
        frames++;
        if (now - lastFpsUpdate >= 500) {
            const fps = Math.round((frames * 1000) / (now - lastFpsUpdate));
            fpsLabel.textContent = `FPS: ${fps}`;
            frames = 0;
            lastFpsUpdate = now;
        }

        updateScaleBar();

        const bearingDeg = computeBearingDeg();
        if (compassSvg) {
            compassSvg.style.transform = `rotate(${-bearingDeg}deg)`;
        }

        rafId = requestAnimationFrame(animateUI);
    }

    animateUI();

    /**
     * Дескриптор для уничтожения UI: останавливает цикл анимации,
     * снимает обработчики кнопок и удаляет pane из DOM.
     *
     * @returns {{destroy: Function}}
     */
    return {
        destroy() {
            destroyed = true;
            if (rafId !== null) {
                cancelAnimationFrame(rafId);
                rafId = null;
            }
            btnPlus.removeEventListener('click', onPlusClick);
            btnMinus.removeEventListener('click', onMinusClick);
            btnCompass.removeEventListener('click', onCompassClick);
            if (pane.parentNode) pane.parentNode.removeChild(pane);
            pane = null;
        }
    };
}