#!/usr/bin/env python3
"""pip install pyproj && python gen_golden.py > golden.json"""
import json
from pyproj import Transformer

# Тестовые точки: экватор, средние широты, антимеридиан, maxLatDeg Mercator,
# реальные города в разных полушариях и зонах UTM.
POINTS = [
    [0, 0], [0, 45], [0, 60], [0, 80], [0, -45],
    [0, 85.05112878],               # maxLatDeg Mercator
    [179.999, 0], [-179.999, 0],    # near antimeridian
    [37.6173, 55.7558],             # Moscow  — zone 37N
    [-0.1278, 51.5074],             # London  — zone 30/31N
    [-74.006, 40.7128],             # NYC     — zone 18N
    [151.2093, -33.8688],           # Sydney  — zone 56S
    [139.6917, 35.6895],            # Tokyo   — zone 54N
    [10, 20],                       # твой текущий center
]

# Добавляем проекцию, которой нет в EPSG, но которая тебе критична
CUSTOM = {
    'ADPKP:0057': None,   # заполним отдельно, pyproj её не знает
}

CODES = ['EPSG:3857', 'EPSG:3395', 'EPSG:4326', 'EPSG:32637', 'EPSG:32601', 'EPSG:32618']

out = {'points': [{'lon': lon, 'lat': lat} for lon, lat in POINTS], 'projections': {}}

for code in CODES:
    fwd = Transformer.from_crs('EPSG:4326', code, always_xy=True)
    inv = Transformer.from_crs(code, 'EPSG:4326', always_xy=True)
    fwd_list, rt_list = [], []
    for lon, lat in POINTS:
        x, y = fwd.transform(lon, lat)
        fwd_list.append([x, y])
        lon2, lat2 = inv.transform(x, y)
        rt_list.append([lon2 - lon, lat2 - lat])
    out['projections'][code] = {'forward': fwd_list, 'roundtrip': rt_list}

print(json.dumps(out, indent=2))