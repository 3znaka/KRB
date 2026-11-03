// styles/types.ts

export type GeometryKind = 'point' | 'line' | 'polygon';

export interface PoiClassSpec {
  /** Категория для палитры (food / health / transport / ...). */
  category: string;
  /** Имя спрайта. Если не задано — берётся имя класса. */
  icon?: string;
}

export interface LayerSpec {
  geometry: GeometryKind | 'mixed';
  /** Только для poi-слоя: какие классы бывают и к каким категориям. */
  poiClasses?: Record<string, PoiClassSpec>;
}

export interface TileSpec {
  name: string;
  layers: Record<string, LayerSpec>;
}

export interface Theme {
  name: string;
  backgroundColor?: string;
  poiCategories: Record<string, string>;
  poiIconOverrides?: Record<string, string>;
  poiDefaultIcon?: string;
  layers: Record<string, Record<string, any>>;
  layerOrder: Record<string, number>;
}