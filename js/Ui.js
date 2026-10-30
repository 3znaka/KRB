/**
 * Модуль пользовательского интерфейса картографической библиотеки.
 * Создаёт и управляет элементами управления: масштабная линейка,
 * координаты, кнопки зума/компаса и атрибуция.
 *
 * @module ui
 */
import { THREE } from './js_TP/tpb.js';
/**
 * Собирает атрибуцию со всех слоёв карты — как растровых, переданных
 * в `layers`, так и векторных/динамических, добавленных через
 * `addTo(map)` и лежащих в `_dynamicLayers`.
 *
 * Устраняет старую проблему: векторный слой с `attributionTitle`
 * не попадал в `map.layers`, поэтому копирайт не отображался.
 */
function collectAttributions(map) {
    const result = [];
    const seen = new Set();
    const push = (layer) => {
        if (!layer || !layer.attributionTitle)
            return;
        const title = String(layer.attributionTitle).trim();
        if (!title)
            return;
        const url = layer.attributionUrl || '';
        const key = title + '|' + url;
        if (seen.has(key))
            return;
        seen.add(key);
        result.push({ title, url });
    };
    const staticLayers = Array.isArray(map.layers) ? map.layers : [];
    for (const layer of staticLayers)
        push(layer);
    const dynamicLayers = Array.isArray(map._dynamicLayers) ? map._dynamicLayers : [];
    for (const layer of dynamicLayers)
        push(layer);
    return result;
}
/**
 * Инициализирует интерфейс карты внутри указанного контейнера.
 * Добавляет панель с кнопками, масштабной линейкой и атрибуцией,
 * запускает цикл анимации для обновления показаний.
 *
 * Возвращает дескриптор с методом destroy() — для остановки цикла
 * и удаления UI из DOM.
 */
export function initUI(map) {
    const container = map.targetElement;
    const getImgUrl = (filename) => new URL(`./img/${filename}`, import.meta.url).href;
    // ---- Защита от повторной инициализации ----
    let pane = container.querySelector('#krb-ui-pane');
    if (pane) {
        return { destroy: () => { } };
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
    const attributions = collectAttributions(map);
    if (attributions.length > 0) {
        attributions.forEach((entry, idx) => {
            if (idx > 0) {
                const sep = document.createElement('span');
                sep.className = 'krb-attribution-sep';
                sep.textContent = ' · ';
                attribution.appendChild(sep);
            }
            const text = '© ' + entry.title;
            if (entry.url) {
                const attrLink = document.createElement('a');
                attrLink.href = entry.url;
                attrLink.textContent = text;
                attrLink.className = 'krb-attribution-link';
                attrLink.target = '_blank';
                attrLink.rel = 'noopener noreferrer';
                attrLink.style.pointerEvents = 'all';
                attribution.appendChild(attrLink);
            }
            else {
                const attrSpan = document.createElement('span');
                attrSpan.className = 'krb-attribution-text';
                attrSpan.textContent = text;
                attribution.appendChild(attrSpan);
            }
        });
    }
    // Кэш ссылки на иконку компаса
    const compassSvg = btnCompass.querySelector('img');
    // ---- Обработчики кнопок ----
    const onPlusClick = (e) => { e.stopPropagation(); map.applyZoomDelta(1); };
    const onMinusClick = (e) => { e.stopPropagation(); map.applyZoomDelta(-1); };
    const onCompassClick = (e) => { e.stopPropagation(); map.resetBearing(); };
    btnPlus.addEventListener('click', onPlusClick);
    btnMinus.addEventListener('click', onMinusClick);
    btnCompass.addEventListener('click', onCompassClick);
    // ---- Переиспользуемые объекты Three.js ----
    // Используем any, так как THREE грузится из JS-файла без типов
    const _raycaster = new THREE.Raycaster();
    const _ndc = new THREE.Vector2();
    const _hit1 = new THREE.Vector3();
    const _hit2 = new THREE.Vector3();
    const _dirVec = new THREE.Vector3();
    const _plane = map.groundPlane || new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
    /**
     * Геодезическое расстояние между двумя точками WGS84 (в метрах)
     * по формуле гаверсинуса.
     */
    function haversineDistance(lon1, lat1, lon2, lat2, R) {
        const toRad = Math.PI / 180;
        let dLon = lon2 - lon1;
        if (dLon > 180)
            dLon -= 360;
        else if (dLon < -180)
            dLon += 360;
        const dLatRad = (lat2 - lat1) * toRad;
        const dLonRad = dLon * toRad;
        const lat1Rad = lat1 * toRad;
        const lat2Rad = lat2 * toRad;
        const a = Math.sin(dLatRad / 2) * Math.sin(dLatRad / 2) +
            Math.cos(lat1Rad) * Math.cos(lat2Rad) *
                Math.sin(dLonRad / 2) * Math.sin(dLonRad / 2);
        return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)));
    }
    /**
     * Приводит расстояние к «красивому» круглому значению.
     */
    function niceDistance(value) {
        const pow = Math.pow(10, Math.floor(Math.log10(value)));
        const frac = value / pow;
        let nice;
        if (frac <= 1.2)
            nice = 1;
        else if (frac <= 2.4)
            nice = 2;
        else if (frac <= 6)
            nice = 5;
        else
            nice = 10;
        return nice * pow;
    }
    /**
     * Форматирует расстояние в метрах или километрах.
     */
    function formatDistance(m) {
        if (m >= 1000)
            return (m / 1000).toFixed(0) + ' км';
        return m.toFixed(0) + ' м';
    }
    /**
     * Вычисляет угол направления камеры (bearing) в градусах.
     */
    function computeBearingDeg() {
        _dirVec.subVectors(map.controls.target, map.camera.position);
        _dirVec.y = 0;
        if (_dirVec.lengthSq() < 1e-12)
            return 0;
        const bearingRad = Math.atan2(_dirVec.x, -_dirVec.z);
        return bearingRad * 180 / Math.PI;
    }
    /**
     * Обновляет масштабную линейку, координаты и подпись зума.
     */
    function updateScaleBar() {
        const worldPos = map.worldGroup.position;
        const target = map.controls.target;
        const centerX = target.x - worldPos.x;
        const centerZ = target.z - worldPos.z;
        const [lon, lat] = map.unprojectToLonLat(centerX, centerZ);
        if (!Number.isFinite(lon) || !Number.isFinite(lat) ||
            Math.abs(lon) > 180.0001 || Math.abs(lat) > 90.0001) {
            return;
        }
        _dirVec.subVectors(map.camera.position, target);
        const dist = _dirVec.length();
        const pitchRad = dist > 1e-6 ? Math.acos(_dirVec.y / dist) : 0;
        const pitchDeg = (pitchRad * 180 / Math.PI).toFixed(1);
        const bearingDeg = computeBearingDeg().toFixed(1);
        coordLabel.textContent = `${lon.toFixed(3)}, ${lat.toFixed(3)}  ·  ${pitchDeg}° / ${bearingDeg}°`;
        const barLengthPx = 100;
        const rect = map.renderer.domElement.getBoundingClientRect();
        if (!rect.width || !rect.height)
            return;
        _ndc.set(0, 0);
        _raycaster.setFromCamera(_ndc, map.camera);
        if (!_raycaster.ray.intersectPlane(_plane, _hit1))
            return;
        const ndcOffsetX = (2 * barLengthPx) / rect.width;
        _ndc.set(ndcOffsetX, 0);
        _raycaster.setFromCamera(_ndc, map.camera);
        if (!_raycaster.ray.intersectPlane(_plane, _hit2))
            return;
        const [lon1, lat1] = map.unprojectToLonLat(_hit1.x - worldPos.x, _hit1.z - worldPos.z);
        const [lon2, lat2] = map.unprojectToLonLat(_hit2.x - worldPos.x, _hit2.z - worldPos.z);
        if (!Number.isFinite(lon1) || !Number.isFinite(lat1) ||
            !Number.isFinite(lon2) || !Number.isFinite(lat2)) {
            return;
        }
        if (Math.abs(lon1) > 180.0001 || Math.abs(lat1) > 90.0001)
            return;
        if (Math.abs(lon2) > 180.0001 || Math.abs(lat2) > 90.0001)
            return;
        // Non-null assertion (!) говорит компилятору, что map.R точно есть,
        // так как мы уже проверили это через Number.isFinite.
        const R = (Number.isFinite(map.R) && map.R > 0) ? map.R : 6371008.8;
        const distance = haversineDistance(lon1, lat1, lon2, lat2, R);
        if (distance > 0) {
            const nice = niceDistance(distance);
            const ratio = nice / distance;
            scaleBar.style.width = (barLengthPx * ratio) + 'px';
            scaleLabel.textContent = formatDistance(nice);
        }
        zoomValueLabel.textContent =
            ` (${map.continuousZoom.toFixed(1)} / z${map.currentDiscreteZoom})`;
    }
    let lastFpsUpdate = performance.now();
    let frames = 0;
    let rafId = null;
    let destroyed = false;
    /**
     * Цикл анимации: обновляет UI и поворачивает значок компаса.
     */
    function animateUI() {
        if (destroyed)
            return;
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
            if (pane?.parentNode)
                pane.parentNode.removeChild(pane);
        }
    };
}
