// VectorTileTypes.ts
import type { THREE } from './js_TP/tpb.js';

// ============================================================================
// Options
// ============================================================================

export interface VectorTileOptions {
    url?: string;
    workerScripts?: string[];
    crs?: string | null;
    attributionTitle?: string;
    attributionUrl?: string;
    visible?: boolean;
    minZoom?: number;
    maxZoom?: number;
    minNativeZoom?: number;
    maxNativeZoom?: number;
    /** @deprecated use minNativeZoom */
    minSourceZoom?: number;
    /** @deprecated use maxNativeZoom */
    maxSourceZoom?: number;
    lineWidthMultiplier?: number;
    fillOpacity?: number;
    depthTest?: boolean;
    visibleLayers?: string[] | null;
    zoomOffset?: number;
    buildings3d?: boolean;
    buildings3dMinZoom?: number;
    buildingEdges?: boolean;
    buildings3dOpacity?: number;
    buildings3dEdgeOpacity?: number;
    maxTextLabels?: number;
    maxTextPointsPerTile?: number;
    maxTextLinesPerTile?: number;
    labelDistanceSortZoom?: number;
    labelMaxPerTileClose?: number;
    labelCullMargin?: number;
    labelMaxCameraDistance?: number;
    lineLabelTracking?: number;
    lineLabelPriorityMode?: string;
    lineLabelHysteresisPx?: number;
    lineLabelPlacement?: string;
    debug?: boolean;
    styles?: Record<string, unknown>;
    tileGroupRenderOrder?: number;
    maxConcurrent?: number;
    queueInterval?: number;
    updateThrottle?: number;
    tileDataCacheMaxSize?: number;
    groupCacheMaxSize?: number;
}

export type Stops = Array<[number, number]>;
export type WidthSpec = number | { stops: Stops } | null;

// ============================================================================
// Worker payload types
// ============================================================================

export interface WorkerFill {
    layerName: string; color: number; opacity: number;
    positions: Float32Array; indices?: Uint32Array; renderOrder?: number;
}
export interface WorkerBuilding {
    color: number; stroke?: number;
    positions: Float32Array; normals: Float32Array; edgePositions?: Float32Array;
}
export interface WorkerLine {
    layerName: string; color: number;
    width: WidthSpec; widthAdd?: number;
    dash?: number[]; hideBelow?: number; dashZ?: number;
    positions: Float32Array; renderOrder?: number;
}
export interface WorkerStroke {
    layerName: string; color: number; width: number;
    dash?: number[]; positions: Float32Array; renderOrder?: number;
}
export interface WorkerPoint {
    layerName: string; color: number; opacity: number;
    radius: number; x: number; z: number; renderOrder?: number;
}
export interface WorkerTextPoint {
    layerName?: string;
    sourceLayer?: string;
    featureId?: string | number;
    id?: string | number;
    x: number; z: number; text: string;
    textColor?: string; fontSize?: string; fontFamily?: string; fontWeight?: string;
    textShadow?: string; textTransform?: string; textFontStyle?: string; textLetterSpacing?: string;
    textOffset?: [number, number]; textAlign?: string; textVerticalAlign?: string;
    priority?: number; zoomBounds?: { min: number; max: number };
}
export interface WorkerTextLine {
    points: Array<{ x: number; z: number }>;
    priority?: number;
    zoomBounds?: { min: number; max: number };
}
export interface WorkerResult {
    centerX?: number;
    centerZ?: number;
    fills?: WorkerFill[];
    buildings?: WorkerBuilding[];
    lines?: WorkerLine[];
    strokes?: WorkerStroke[];
    points?: WorkerPoint[];
    textPoints?: WorkerTextPoint[];
    textLines?: WorkerTextLine[];
    is3d?: boolean;
}
export interface PendingWorkerRequest {
    resolve: (v: any) => void;
    reject: (e: Error) => void;
    group: THREE.Group | null;
    key: string | null;
    generation: number;
    sourceZoom: number;
    styleZoom: number;
    isIdentify: boolean;
}

// ============================================================================
// Render order & constants
// ============================================================================

export const VECTOR_TILE_RENDER_ORDER = {
    FILL: 10,
    LINE: 20,
    STROKE: 25,
    POINT: 30,
    BUILDING: 5000,
    EDGE: 5001,
} as const;

export const FLAT_Y_OFFSET = 0.5;
export const FLAT_Y_STEP = 0.002;
export const flatY = (ro?: number): number => FLAT_Y_OFFSET + (ro || 0) * FLAT_Y_STEP;