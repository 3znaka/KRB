export type GeometryKind = 'point' | 'line' | 'polygon';

export interface PoiClassSpec {
  /** Категория для палитры (food / health / transport / ...). */
  category: string;
  /** Имя спрайта. Если не задано — берётся имя класса. */
  icon?: string;
}

// types.ts
interface LayerSpec {
  geometry: GeometryKind | 'mixed';
  poiClasses?: Record<string, PoiClassSpec>;
}

export interface TileSpec {
  name: string;
  layers: Record<string, LayerSpec>;
}

export interface Theme {
  name: string;
  /** category → цвет кружка POI. */
  poiCategories: Record<string, string>;
  /** Опциональные оверрайды: class → icon (если не совпадает с дефолтом). */
  poiIconOverrides?: Record<string, string>;
  poiDefaultIcon?: string;
  layers: Record<string, Record<string, any>>;  // как сейчас в DEFAULT_STYLES, без iconImage
  layerOrder: Record<string, number>;
}