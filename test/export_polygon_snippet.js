// Вставьте в консоль браузера на странице nations_krb.html (после загрузки карты).
// Выгружает ВСЕ полигоны региона (мультиполигон разбивается на отдельные Polygon-объекты).
(() => {
  const NAME = 'Красноярский край';
  const seen = new Set();
  const layers = [];
  const visit = (o, depth) => {
    if (!o || typeof o !== 'object' || depth > 4 || seen.has(o)) return;
    seen.add(o);
    if (Array.isArray(o._objects)) layers.push(o);
    for (const k of Object.keys(o)) {
      if (k === 'map' || k === 'renderer' || k === 'scene') continue;
      const v = o[k];
      if (v && typeof v === 'object') visit(v, depth + 1);
    }
  };
  visit(window.map, 0);
  const objs = layers.flatMap(l => l._objects);
  const nameOf = o => (o._properties && o._properties.name) || (o._userData && o._userData.name) || (o.properties && o.properties.name) || o.name;
  const polys = objs.filter(o => nameOf(o) === NAME && Array.isArray(o._rings));
  if (!polys.length) {
    console.error('no polygons for', NAME, '| layers:', layers.length, '| objects:', objs.length);
    return;
  }
  const out = {
    name: NAME,
    polygons: polys.map(poly => ({
      rings: poly._rings.map(r => r.map(p => [p[0], p[1]])),
      triangles: poly._cachedTopIndices ? Array.from(poly._cachedTopIndices) : null,
      vertexLonLat: (poly._vertexLonLat || []).map(v => v ? [v[0], v[1]] : null),
      worldCoords: (poly._worldCoords || []).map(w => [w[0], w[1]]),
      contourVertexCount: poly._contourVertexCount || 0,
    })),
  };
  window.__exportedPoly = out;
  const verts = out.polygons.reduce((s, p) => s + p.vertexLonLat.length, 0);
  const tris = out.polygons.reduce((s, p) => s + (p.triangles ? p.triangles.length / 3 : 0), 0);
  console.log('exported', NAME, '| polygons:', out.polygons.length, '| verts:', verts, '| tris:', tris, '| data in window.__exportedPoly');
})();
