// CoreEvents.ts
import { THREE } from './js_TP/tpb.js';
import type { KrbMap } from './Core.js';

export type KrbMapEventName =
    | 'load' | 'idle' | 'error'
    | 'movestart' | 'move' | 'moveend'
    | 'zoomstart' | 'zoom' | 'zoomend'
    | 'rotatestart' | 'rotate' | 'rotateend'
    | 'pitchstart' | 'pitch' | 'pitchend'
    | 'click' | 'dblclick' | 'contextmenu'
    | 'mousedown' | 'mouseup' | 'mousemove' | 'mouseenter' | 'mouseleave'
    | 'resize';

export interface PointerEventPayload {
    lngLat: [number, number] | null;
    point: { x: number; y: number };
    originalEvent: PointerEvent | MouseEvent;
}

export interface CoreEventsMethods {
    on(event: KrbMapEventName | string, handler: (p?: any) => void): () => void;
    off(event: KrbMapEventName | string, handler: (p?: any) => void): void;
    once(event: KrbMapEventName | string, handler: (p?: any) => void): () => void;
    emit(event: KrbMapEventName | string, payload?: any): void;

    _initEvents(): void;
    _disposeEvents(): void;
    _updateMoveEvents(): void;
    _bindPointerEvents(): void;
    _emitResize(w: number, h: number): void;
}

export const CoreEventsMixin: CoreEventsMethods & ThisType<KrbMap> = {
    on(event, handler) {
        if (typeof handler !== 'function') return () => {};
        let set = this._eventHandlers.get(event);
        if (!set) { set = new Set(); this._eventHandlers.set(event, set); }
        set.add(handler);
        return () => this.off(event, handler);
    },

    off(event, handler) {
        const set = this._eventHandlers.get(event);
        if (!set) return;
        set.delete(handler);
        if (set.size === 0) this._eventHandlers.delete(event);
    },

    once(event, handler) {
        const wrapper = (p?: any) => { this.off(event, wrapper); handler(p); };
        return this.on(event, wrapper);
    },

    emit(event, payload) {
        const set = this._eventHandlers.get(event);
        if (!set || set.size === 0) return;
        // копия — чтобы можно было отписываться изнутри handler-а
        for (const h of [...set]) {
            try { h(payload); }
            catch (err) { console.error(`KrbMap: '${event}' handler threw`, err); }
        }
    },

    _initEvents() {
        this._eventHandlers = new Map();
        this._lastCamState  = null;
        this._moveActive    = false;
        this._zoomActive    = false;
        this._rotateActive  = false;
        this._pitchActive   = false;
        this._lastMoveTime     = 0;
        this._lastMoveEndTime  = 0;
        this._idleFired        = true;
        this._firstRenderDone  = false;
    },

    _disposeEvents() {
        if (this._eventHandlers) this._eventHandlers.clear();
        this._eventHandlers = new Map();
        this._lastCamState  = null;
    },

    /**
     * Вызывается из animate() каждый кадр.
     * Сравнивает положение/зум/bearing/pitch с предыдущим кадром и
     * генерирует start / * / end / idle. Никаких setTimeout-ов и
     * ручных эмитов в жестах не нужно.
     */
    _updateMoveEvents() {
        if (!this.camera || !this.controls || !this.worldGroup) return;

        const camPos = this.camera.position;
        const tgt    = this.controls.target;
        const dx = camPos.x - tgt.x, dy = camPos.y - tgt.y, dz = camPos.z - tgt.z;
        const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
        if (dist < 1e-9) return;

        const pitch   = Math.acos(Math.max(-1, Math.min(1, dy / dist)));
        const bearing = Math.atan2(-dx, dz);

        // «эффективный центр карты» — учитываем и pan (worldGroup), и moveCameraToSlow (target)
        const centerX = tgt.x - this.worldGroup.position.x;
        const centerZ = tgt.z - this.worldGroup.position.z;
        const zoom    = this.continuousZoom;

        const prev = this._lastCamState;
        this._lastCamState = { centerX, centerZ, zoom, pitch, bearing };
        if (!prev) return;

        const EPS_POS = 1e-3, EPS_ZOOM = 1e-4, EPS_ANGLE = 1e-4;
        const dCenter  = Math.hypot(centerX - prev.centerX, centerZ - prev.centerZ);
        const dZoom    = Math.abs(zoom - prev.zoom);
        const dBearing = Math.abs(bearing - prev.bearing);
        const dPitch   = Math.abs(pitch - prev.pitch);
        const anyDelta = dCenter > EPS_POS || dZoom > EPS_ZOOM
                      || dBearing > EPS_ANGLE || dPitch > EPS_ANGLE;

        const now = performance.now();

        if (anyDelta) {
            this._lastMoveTime = now;
            this._idleFired = false;

            if (!this._moveActive) { this._moveActive = true; this.emit('movestart'); }
            this.emit('move');

            if (dZoom > EPS_ZOOM) {
                if (!this._zoomActive) { this._zoomActive = true; this.emit('zoomstart'); }
                this.emit('zoom');
            }
            if (dBearing > EPS_ANGLE) {
                if (!this._rotateActive) { this._rotateActive = true; this.emit('rotatestart'); }
                this.emit('rotate');
            }
            if (dPitch > EPS_ANGLE) {
                if (!this._pitchActive) { this._pitchActive = true; this.emit('pitchstart'); }
                this.emit('pitch');
            }
        } else {
            const END_DELAY = 100, IDLE_DELAY = 200;

            if (this._moveActive && now - this._lastMoveTime > END_DELAY) {
                this._moveActive = false;
                if (this._zoomActive)   { this._zoomActive   = false; this.emit('zoomend'); }
                if (this._rotateActive) { this._rotateActive = false; this.emit('rotateend'); }
                if (this._pitchActive)  { this._pitchActive  = false; this.emit('pitchend'); }
                this.emit('moveend');
                this._lastMoveEndTime = now;
            }
            if (!this._idleFired && !this._moveActive
                && now - this._lastMoveEndTime > IDLE_DELAY) {
                this._idleFired = true;
                this.emit('idle');
            }
        }
    },

    _bindPointerEvents() {
        if (!this.renderer || !this._abortController) return;
        const el     = this.renderer.domElement;
        const signal = this._abortController.signal;

        const payloadFor = (e: PointerEvent | MouseEvent): PointerEventPayload => {
            const rect  = el.getBoundingClientRect();
            const point = { x: e.clientX - rect.left, y: e.clientY - rect.top };
            let lngLat: [number, number] | null = null;
            if (this.worldGroup && this.camera) {
                const world = this._raycastToGround(e.clientX, e.clientY, new THREE.Vector3());
                if (world) {
                    lngLat = this.unprojectToLonLat(
                        world.x - this.worldGroup.position.x,
                        world.z - this.worldGroup.position.z
                    );
                }
            }
            return { lngLat, point, originalEvent: e };
        };

        const dispatch = (name: KrbMapEventName) => (e: PointerEvent | MouseEvent) => {
            const set = this._eventHandlers.get(name);
            if (!set || set.size === 0) return;         // не жжём CPU зря
            this.emit(name, payloadFor(e));
        };

        el.addEventListener('pointerdown',  dispatch('mousedown')  as any, { signal });
        el.addEventListener('pointerup',    dispatch('mouseup')    as any, { signal });
        el.addEventListener('pointermove',  dispatch('mousemove')  as any, { signal });
        el.addEventListener('pointerenter', dispatch('mouseenter') as any, { signal });
        el.addEventListener('pointerleave', dispatch('mouseleave') as any, { signal });
        el.addEventListener('click',        dispatch('click')      as any, { signal });
        el.addEventListener('dblclick',     dispatch('dblclick')   as any, { signal });
        el.addEventListener('contextmenu',  dispatch('contextmenu') as any, { signal });
    },

    _emitResize(w, h) {
        this.emit('resize', { width: w, height: h });
    },
};

declare module './Core.js' {
    interface KrbMap extends CoreEventsMethods {}
}