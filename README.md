# KOROBOK (KRB) Cartographic Library

KRB is a high-performance, feature-rich cartographic library designed for rendering interactive 2D and 3D maps. It provides a comprehensive set of tools for terrain visualization, vector data rendering, and spatial data management, suitable for complex geographic information systems and custom mapping solutions.

## Key Features

- **Advanced Terrain Rendering**: Supports elevation data with customizable height scaling and seamless tile management.
- **Versatile Data Layers**: Native support for GeoJSON and Vector Tile layers, including 3D building extrusion and edge highlighting.
- **Rich Map Objects**: Create and manage 2D/3D markers, polylines, polygons, and surface-conforming polygons (`SurfacePolygon`) that drape accurately over terrain.
- **Intelligent Label Management**: Built-in `TextManager` handles collision detection, priority-based rendering, and animated label placement for both point and linear features.
- **Camera & View Control**: Full control over map view parameters, including center coordinates, zoom levels, pitch, and bearing, with smooth, configurable camera animations.
- **Built-in UI Components**: Ready-to-use interface initialization (`initUI`) providing zoom controls, a scale bar, and attribution management.

## Integration

To include KRB in your project, use the provided CDN mirror. This ensures reliable access even if primary repository hosting is temporarily unavailable.

```html
<link href="https://cdn.mapengine.ru/KRB/KRB.css" rel="stylesheet">
<script type="module">
  import * as KRB from 'https://cdn.mapengine.ru/KRB/js/KRB.js';
</script>
```

## Quick Start

The following example demonstrates how to initialize a basic map with a terrain layer and default UI controls.

```javascript
import * as KRB from 'https://cdn.mapengine.ru/KRB/js/KRB.js';

// 1. Define the map view
const view = new KRB.View({
    center: [37.6173, 55.7558], // [longitude, latitude]
    zoom: 10,
    minZoom: 1,
    maxZoom: 18,
    pitch: 30,
    bearing: 0
});

// 2. Initialize the map
const map = new KRB.KrbMap({
    target: 'map-container', // ID of the DOM element
    view: view,
    layers: [
        {
            texture: 'https://example.com/tiles/{z}/{x}/{y}.png',
            elevation: 'https://example.com/elevation/{z}/{x}/{y}.png',
            heightScale: 1.0
        }
    ]
});

// 3. (Optional) Initialize the default user interface
KRB.initUI(map);

// 4. Add a sample marker
const marker = new KRB.Marker({
    position: [37.6173, 55.7558],
    tooltip: '<b>Sample Location</b>',
    clusterable: true
});
marker.addTo(map);
```

## Resources

- **Homepage**: [https://mapengine.ru/](https://mapengine.ru/)
- **Documentation**: [https://mapengine.ru/krb/docs/](https://mapengine.ru/krb/docs/)
- **Interactive Playground**: [https://mapengine.ru/krb/v9/playground.php](https://mapengine.ru/krb/v9/playground.php)
- **Source Code**: [https://github.com/3znaka/KRB/tree/main](https://github.com/3znaka/KRB/tree/main)
