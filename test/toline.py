import geopandas as gpd

# Загружаем исходный GeoJSON
gdf = gpd.read_file("world.geojson")

# Преобразуем геометрию полигонов в линии
gdf["geometry"] = gdf.geometry.boundary

# Сохраняем результат как новый GeoJSON
gdf.to_file("lines.geojson", driver="GeoJSON")