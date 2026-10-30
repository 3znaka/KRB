import { DEFAULTS } from './Utils.js';
export class View {
    centerLonLat;
    center;
    projection;
    zoom;
    minZoom;
    maxZoom;
    zoomSensitivity;
    pitch;
    bearing;
    constructor(options) {
        if (!options)
            throw new Error('View: options object is required');
        if (!options.centerLonLat && !options.center) {
            throw new Error('View: options.center или options.centerLonLat обязательны');
        }
        if (options.centerLonLat && options.center) {
            console.warn('View: одновременно заданы centerLonLat и center — приоритет centerLonLat.');
        }
        if (options.crs && options.projection && options.crs !== options.projection) {
            console.warn(`View: заданы и crs='${options.crs}', и projection='${options.projection}'; использую crs.`);
        }
        this.centerLonLat = options.centerLonLat ? options.centerLonLat.slice() : null;
        this.center = options.center ? options.center.slice() : null;
        this.projection = options.crs ?? options.projection ?? 'EPSG:3857';
        this.zoom = options.zoom;
        this.minZoom = options.minZoom ?? DEFAULTS.MIN_ZOOM;
        this.maxZoom = options.maxZoom ?? DEFAULTS.MAX_ZOOM;
        this.zoomSensitivity = options.zoomSensitivity ?? DEFAULTS.ZOOM_SENSITIVITY;
        this.pitch = options.pitch ?? 0;
        this.bearing = options.bearing ?? 0;
    }
}
