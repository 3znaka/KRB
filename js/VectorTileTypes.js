// ============================================================================
// Render order & constants
// ============================================================================
export const VECTOR_TILE_RENDER_ORDER = {
    BUILDING: 5,
    EDGE: 6,
    FILL: 10,
    LINE: 20,
    STROKE: 25,
    POINT: 30,
};
export const FLAT_Y_OFFSET = 0.5;
export const FLAT_Y_STEP = 0.002;
export const flatY = (ro) => FLAT_Y_OFFSET + (ro || 0) * FLAT_Y_STEP;
