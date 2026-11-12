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
 */
function collectAttributions(map) {
    const result = [];
    const seen = new Set();
    const push = (layer) => {
        if (!layer)
            return;
        const rawTitle = layer.attributionTitle ??
            layer.attribution ??
            layer.attribution_text;
        if (!rawTitle)
            return;
        const title = String(rawTitle).trim();
        if (!title)
            return;
        const url = layer.attributionUrl ??
            layer.attribution_url ??
            '';
        const key = title + '|' + url;
        if (seen.has(key))
            return;
        seen.add(key);
        result.push({ title, url });
    };
    // Сам объект map тоже может нести атрибуцию
    push(map);
    // Пробуем разные возможные контейнеры слоёв
    const candidates = [
        map.layers,
        map._layers,
        map._dynamicLayers,
        map.overlayLayers,
        map.vectorLayers,
        map.rasterLayers,
    ];
    try {
        if (typeof map.getLayers === 'function') {
            candidates.push(map.getLayers());
        }
    }
    catch { /* ignore */ }
    for (const arr of candidates) {
        if (Array.isArray(arr)) {
            for (const layer of arr)
                push(layer);
        }
    }
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
    const existing = container.querySelector('#krb-ui-pane');
    if (existing && existing.parentNode)
        existing.parentNode.removeChild(existing);
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
    let coordLabel = null;
    let fpsLabel = null;
    let zoomValueLabel = null;
    if (map.debug) {
        const zoomLabel = document.createElement('div');
        zoomLabel.className = 'krb-zoom-label';
        coordLabel = document.createElement('span');
        coordLabel.className = 'krb-coord-label';
        zoomLabel.appendChild(coordLabel);
        fpsLabel = document.createElement('span');
        fpsLabel.className = 'krb-fps-label';
        fpsLabel.textContent = 'FPS: --';
        zoomLabel.appendChild(fpsLabel);
        zoomValueLabel = document.createElement('span');
        zoomValueLabel.className = 'krb-zoom-value';
        zoomLabel.appendChild(zoomValueLabel);
        pane.appendChild(zoomLabel);
    }
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
    // Правый нижний угол: основные кнопки + строка (атрибуция + (i))
    const rightBottom = document.createElement('div');
    rightBottom.className = 'krb-right-bottom';
    pane.appendChild(rightBottom);
    // Основные кнопки
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
    // ── Строка «атрибуция + кнопка (i)» ────────────────────────────
    // Атрибуция позиционируется абсолютно слева от кнопки (см. CSS).
    const infoRow = document.createElement('div');
    infoRow.className = 'krb-info-row';
    // Сворачиваемая обёртка атрибуции
    const attributionWrap = document.createElement('div');
    attributionWrap.className = 'krb-attribution-wrap';
    const attribution = document.createElement('div');
    attribution.className = 'krb-attribution';
    attributionWrap.appendChild(attribution);
    infoRow.appendChild(attributionWrap);
    // Кнопка (i)
    const infoBtnGroup = document.createElement('div');
    infoBtnGroup.className = 'krb-buttons krb-info-btn-group';
    const btnInfo = document.createElement('button');
    btnInfo.className = 'krb-btn';
    btnInfo.innerHTML = `<img src="${getImgUrl('../img/info.svg')}" alt="i">`;
    btnInfo.setAttribute('aria-label', 'Информация об источниках данных');
    btnInfo.setAttribute('aria-expanded', 'false');
    infoBtnGroup.appendChild(btnInfo);
    infoRow.appendChild(infoBtnGroup);
    rightBottom.appendChild(infoRow);
    /**
     * Пере-рендерит содержимое атрибуции из актуального состояния слоёв.
     * Возвращает количество записей (0 — нечего показывать).
     */
    const renderAttributions = () => {
        attribution.innerHTML = '';
        const list = collectAttributions(map);
        list.forEach((entry, idx) => {
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
        return list.length;
    };
    // Первичный рендер — на случай, если слои уже переданы в map.layers
    renderAttributions();
    // Кэш ссылки на иконку компаса
    const compassSvg = btnCompass.querySelector('img');
    // ---- Обработчики основных кнопок ----
    const onPlusClick = (e) => { e.stopPropagation(); map.applyZoomDelta(1); };
    const onMinusClick = (e) => { e.stopPropagation(); map.applyZoomDelta(-1); };
    const onCompassClick = (e) => { e.stopPropagation(); map.resetBearing(); };
    btnPlus.addEventListener('click', onPlusClick);
    btnMinus.addEventListener('click', onMinusClick);
    btnCompass.addEventListener('click', onCompassClick);
    // ---- Тоггл атрибуции (горизонтальное раскрытие через clip-path) ----
    let attributionOpen = false;
    const onInfoClick = (e) => {
        e.stopPropagation();
        if (attributionOpen) {
            attributionOpen = false;
            btnInfo.setAttribute('aria-expanded', 'false');
            attributionWrap.classList.remove('krb-attribution-wrap--open');
            return;
        }
        const count = renderAttributions();
        if (count === 0) {
            attribution.textContent = '© Источники данных не указаны';
        }
        attributionOpen = true;
        btnInfo.setAttribute('aria-expanded', 'true');
        // rAF — чтобы браузер успел отрисовать новый контент до смены класса,
        // иначе transition clip-path иногда не срабатывает
        requestAnimationFrame(() => {
            if (!attributionOpen)
                return;
            attributionWrap.classList.add('krb-attribution-wrap--open');
        });
    };
    btnInfo.addEventListener('click', onInfoClick);
    // ---- Переиспользуемые объекты Three.js ----
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
        if (!map.worldGroup || !map.controls || !map.renderer)
            return;
        const worldPos = map.worldGroup.position;
        const target = map.controls.target;
        const centerX = target.x - worldPos.x;
        const centerZ = target.z - worldPos.z;
        // ── центр: используем safe, если есть ────────────────────────
        const centerLL = map.unprojectToLonLatSafe
            ? map.unprojectToLonLatSafe(centerX, centerZ)
            : (() => {
                const v = map.unprojectToLonLat(centerX, centerZ);
                if (!v || !Number.isFinite(v[0]) || !Number.isFinite(v[1]))
                    return null;
                if (Math.abs(v[0]) > 180.0001 || Math.abs(v[1]) > 90.0001)
                    return null;
                return v;
            })();
        if (!centerLL)
            return;
        const [lon, lat] = centerLL;
        if (map.debug && coordLabel) {
            _dirVec.subVectors(map.camera.position, target);
            const dist = _dirVec.length();
            const pitchRad = dist > 1e-6 ? Math.acos(_dirVec.y / dist) : 0;
            const pitchDeg = (pitchRad * 180 / Math.PI).toFixed(1);
            const bearingDeg = computeBearingDeg().toFixed(1);
            coordLabel.textContent =
                `${lon.toFixed(3)}, ${lat.toFixed(3)}  ·  ${pitchDeg}° / ${bearingDeg}°`;
        }
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
        // ── углы: safe-путь ──────────────────────────────────────────
        const h1 = map.unprojectToLonLatSafe
            ? map.unprojectToLonLatSafe(_hit1.x - worldPos.x, _hit1.z - worldPos.z)
            : (() => {
                const v = map.unprojectToLonLat(_hit1.x - worldPos.x, _hit1.z - worldPos.z);
                return v && Number.isFinite(v[0]) && Number.isFinite(v[1])
                    && Math.abs(v[0]) <= 180.0001 && Math.abs(v[1]) <= 90.0001 ? v : null;
            })();
        if (!h1) {
            scaleLabel.textContent = '';
            return;
        }
        const [lon1, lat1] = h1;
        const h2 = map.unprojectToLonLatSafe
            ? map.unprojectToLonLatSafe(_hit2.x - worldPos.x, _hit2.z - worldPos.z)
            : (() => {
                const v = map.unprojectToLonLat(_hit2.x - worldPos.x, _hit2.z - worldPos.z);
                return v && Number.isFinite(v[0]) && Number.isFinite(v[1])
                    && Math.abs(v[0]) <= 180.0001 && Math.abs(v[1]) <= 90.0001 ? v : null;
            })();
        if (!h2) {
            scaleLabel.textContent = '';
            return;
        }
        const [lon2, lat2] = h2;
        const R = (Number.isFinite(map.R) && map.R > 0) ? map.R : 6371008.8;
        const distance = haversineDistance(lon1, lat1, lon2, lat2, R);
        if (distance > 0) {
            const nice = niceDistance(distance);
            const ratio = nice / distance;
            scaleBar.style.width = (barLengthPx * ratio) + 'px';
            scaleLabel.textContent = formatDistance(nice);
        }
        if (map.debug && zoomValueLabel) {
            zoomValueLabel.textContent =
                ` (${map.continuousZoom.toFixed(1)} / z${map.currentDiscreteZoom})`;
        }
    }
    let lastFpsUpdate = performance.now();
    let frames = 0;
    let rafId = null;
    let destroyed = false;
    function animateUI() {
        if (destroyed)
            return;
        if (!map.worldGroup || !map.controls || !map.renderer) {
            destroyed = true;
            return;
        }
        if (map.debug && fpsLabel) {
            const now = performance.now();
            frames++;
            if (now - lastFpsUpdate >= 500) {
                const fps = Math.round((frames * 1000) / (now - lastFpsUpdate));
                fpsLabel.textContent = `FPS: ${fps}`;
                frames = 0;
                lastFpsUpdate = now;
            }
        }
        updateScaleBar();
        const bearingDeg = computeBearingDeg();
        if (compassSvg)
            compassSvg.style.transform = `rotate(${-bearingDeg}deg)`;
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
            btnInfo.removeEventListener('click', onInfoClick);
            if (pane?.parentNode)
                pane.parentNode.removeChild(pane);
        }
    };
}
