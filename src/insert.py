#!/usr/bin/env python3
"""
insert_zoom_interp.py

Добавляет zoom-интерполяцию числовых свойств во все пространственные объекты.

Запуск из папки с .ts-файлами:
    python insert_zoom_interp.py

Что делает:
  1. SpatialObject.ts — базовые типы, поля, методы
  2. Каждый подкласс (Marker, Marker3D, Polygon, Polyline, Area3D, Image, Vector3D):
       - import { …, ZoomInterpolation } from './SpatialObject.js'
       - zoomInterpolate?: ZoomInterpolation | null;   → в *Options
       - if (options.zoomInterpolate) this.setZoomInterpolations(…);  → в конструкторе
       - this._applyZoomInterpolations(map.continuousZoom);            → в _update

Идемпотентен: повторный запуск ничего не дублирует.
"""

import re
import sys
from pathlib import Path


SPATIAL_TYPES = """

/** `[[zoom, value], [zoom, value], …]` — отсортированные по zoom. */
export type ZoomInterpolationStops = Array<[number, number]>;
export type ZoomInterpolation = Record<string, ZoomInterpolationStops>;"""

SPATIAL_FIELDS = """

    // ── Интерполяция числовых свойств по зуму ──
    protected _zoomInterpolations: ZoomInterpolation | null = null;
    protected _lastZoomValue: number = NaN;"""

SPATIAL_METHODS = """

    // =================================================================
    // Zoom-интерполяция числовых свойств
    // =================================================================

    /**
     * Включает/выключает интерполяцию числовых свойств по зуму.
     * `stops` для каждого свойства — `[[zoom, value], …]`, отсортированные
     * по возрастанию. За пределами — константа (крайние значения).
     * Свойство `foo` применяется через `this.setFoo(value)`.
     *
     * @example
     * poly.setZoomInterpolations({
     *     fillOpacity: [[14, 0], [16, 0.5], [18, 1]],
     *     strokeWidth: [[14, 0.5], [18, 4]],
     * });
     */
    setZoomInterpolations(interp: ZoomInterpolation | null): this {
        if (!interp) {
            this._zoomInterpolations = null;
            this._lastZoomValue = NaN;
            return this;
        }
        const normalized: ZoomInterpolation = {};
        for (const prop in interp) {
            const raw = interp[prop];
            if (!Array.isArray(raw)) continue;
            const stops = raw
                .filter((s): s is [number, number] =>
                    Array.isArray(s) && s.length === 2 &&
                    Number.isFinite(s[0]) && Number.isFinite(s[1]))
                .slice()
                .sort((a, b) => a[0] - b[0]);
            if (stops.length < 2) continue;
            normalized[prop] = stops;
            const setterName = 'set' + prop.charAt(0).toUpperCase() + prop.slice(1);
            if (typeof (this as any)[setterName] !== 'function') {
                console.warn(
                    `SpatialObject.setZoomInterpolations: property "${prop}" ` +
                    `has no setter "${setterName}" on ${this.constructor.name}`
                );
            }
        }
        this._zoomInterpolations = normalized;
        this._lastZoomValue = NaN;
        if (this._map) this._applyZoomInterpolations(this._map.continuousZoom);
        return this;
    }

    /** Возвращает копию текущей карты интерполяций (или `null`). */
    getZoomInterpolations(): ZoomInterpolation | null {
        if (!this._zoomInterpolations) return null;
        const out: ZoomInterpolation = {};
        for (const prop in this._zoomInterpolations) {
            out[prop] = this._zoomInterpolations[prop]
                .map(s => [s[0], s[1]] as [number, number]);
        }
        return out;
    }

    /** Применяет интерполяцию, если zoom изменился с прошлого вызова. */
    protected _applyZoomInterpolations(zoom: number): void {
        if (!this._zoomInterpolations) return;
        if (zoom === this._lastZoomValue) return;
        this._lastZoomValue = zoom;
        for (const prop in this._zoomInterpolations) {
            const stops = this._zoomInterpolations[prop];
            const value = this._evalZoomStops(stops, zoom);
            const setterName = 'set' + prop.charAt(0).toUpperCase() + prop.slice(1);
            const setter = (this as any)[setterName];
            if (typeof setter !== 'function') continue;
            try { setter.call(this, value); } catch { /* swallow */ }
        }
    }

    private _evalZoomStops(stops: ZoomInterpolationStops, zoom: number): number {
        const first = stops[0];
        const last = stops[stops.length - 1];
        if (zoom <= first[0]) return first[1];
        if (zoom >= last[0]) return last[1];
        for (let i = 0; i < stops.length - 1; i++) {
            const [z0, v0] = stops[i];
            const [z1, v1] = stops[i + 1];
            if (zoom >= z0 && zoom <= z1) {
                if (z1 === z0) return v1;
                const t = (zoom - z0) / (z1 - z0);
                return v0 + (v1 - v0) * t;
            }
        }
        return last[1];
    }"""


SUBCLASSES = [
    ('Marker.ts',   'Marker'),
    ('Marker3D.ts', 'Marker3D'),
    ('Polygon.ts',  'Polygon'),
    ('Polyline.ts', 'Polyline'),
    ('Area3D.ts',   'Area3D'),
    ('Image.ts',    'Image'),
    ('Vector3D.ts', 'Vector3D'),
]


def patch_spatial(path: Path) -> None:
    print(f'[{path.name}]')
    text = path.read_text(encoding='utf-8')
    orig = text

    if 'ZoomInterpolationStops' in text:
        print('  . types: already present')
    else:
        m = re.search(
            r"export type TitleAlignV\s*=\s*'top'\s*\|\s*'middle'\s*\|\s*'center'\s*\|\s*'bottom';",
            text
        )
        if m:
            text = text[:m.end()] + SPATIAL_TYPES + text[m.end():]
            print('  + types')
        else:
            print('  ! types: anchor not found')

    if '_zoomInterpolations' in text:
        print('  . fields: already present')
    else:
        m = re.search(r'protected _userData:\s*Record<string,\s*any>\s*=\s*\{\};', text)
        if m:
            text = text[:m.end()] + SPATIAL_FIELDS + text[m.end():]
            print('  + fields')
        else:
            print('  ! fields: anchor not found')

    if 'setZoomInterpolations' in text:
        print('  . methods: already present')
    else:
        m = re.search(
            r'getUserData\(\)\s*:\s*Record<string,\s*any>\s*\{\s*\n\s*return this\._userData;\s*\n\s*\}',
            text
        )
        if m:
            text = text[:m.end()] + SPATIAL_METHODS + text[m.end():]
            print('  + methods')
        else:
            print('  ! methods: anchor not found')

    if text != orig:
        path.write_text(text, encoding='utf-8')
        print('  → written')
    else:
        print('  = unchanged')


def patch_subclass(path: Path, class_name: str) -> None:
    print(f'[{path.name}]')
    text = path.read_text(encoding='utf-8')
    orig = text

    # ── 1) import ──
    m = re.search(
        r"import\s*\{([^}]*)\}\s*from\s*['\"]\./SpatialObject\.js['\"]",
        text
    )
    if not m:
        print('  ! import: SpatialObject.js import not found')
    elif 'ZoomInterpolation' in m.group(1):
        print('  . import: ZoomInterpolation present')
    else:
        imports = m.group(1).strip().rstrip(',')
        new_line = f"import {{ {imports}, ZoomInterpolation }} from './SpatialObject.js'"
        text = text[:m.start()] + new_line + text[m.end():]
        print('  + import: ZoomInterpolation')

    # ── 2) Options interface ──
    if 'zoomInterpolate?:' in text:
        print('  . options: zoomInterpolate present')
    else:
        m = re.search(rf'export interface {re.escape(class_name)}Options\s*\{{', text)
        if not m:
            print(f'  ! options: interface {class_name}Options not found')
        else:
            end_m = re.search(r'\n\}', text[m.end():])
            if end_m:
                insert_pos = m.end() + end_m.start()
                text = text[:insert_pos] + '\n    zoomInterpolate?: ZoomInterpolation | null;' + text[insert_pos:]
                print('  + options: zoomInterpolate')
            else:
                print(f'  ! options: closing brace of {class_name}Options not found')

    # ── 3) Constructor ──
    if 'this.setZoomInterpolations(options.zoomInterpolate)' in text:
        print('  . constructor: already patched')
    else:
        m = re.search(rf'constructor\(options:\s*{re.escape(class_name)}Options\)\s*\{{', text)
        if not m:
            print('  ! constructor: not found')
        else:
            body = text[m.end():m.end() + 800]
            super_m = re.search(r'\bsuper\(\);', body)
            if super_m:
                insert_pos = m.end() + super_m.end()
                insert_line = ('\n\n        if (options.zoomInterpolate) '
                               'this.setZoomInterpolations(options.zoomInterpolate);')
                text = text[:insert_pos] + insert_line + text[insert_pos:]
                print('  + constructor: setZoomInterpolations')
            else:
                print('  ! constructor: super() not found')

    # ── 4) _update ──
    if 'this._applyZoomInterpolations(map.continuousZoom)' in text:
        print('  . _update: already patched')
    else:
        m = re.search(r'\n    _update\([^)]*\)\s*(?::\s*void)?\s*\{', text)
        if not m:
            print('  ! _update: method not found')
        else:
            body_start = m.end()
            chunk = text[body_start:body_start + 800]

            const_map_m = re.search(r'\n(\s*)const map\s*=\s*this\._map;', chunk)
            guard_m     = re.search(r'\n(\s*)if\s*\([^)]*this\._map[^)]*\)\s*return;', chunk)

            insert_pos = None
            indent = '        '
            if const_map_m:
                insert_pos = body_start + const_map_m.end()
                indent = const_map_m.group(1)
            elif guard_m:
                insert_pos = body_start + guard_m.end()
                indent = guard_m.group(1)

            if insert_pos is not None:
                insert_line = '\n' + indent + 'this._applyZoomInterpolations(map.continuousZoom);'
                text = text[:insert_pos] + insert_line + text[insert_pos:]
                print('  + _update: _applyZoomInterpolations')
            else:
                print('  ! _update: insertion anchor not found')

    if text != orig:
        path.write_text(text, encoding='utf-8')
        print('  → written')
    else:
        print('  = unchanged')


def main() -> None:
    cwd = Path.cwd()

    spatial = cwd / 'SpatialObject.ts'
    if not spatial.exists():
        print(f'ERROR: SpatialObject.ts not found in {cwd}')
        sys.exit(1)

    patch_spatial(spatial)

    for filename, class_name in SUBCLASSES:
        p = cwd / filename
        if not p.exists():
            print(f'[{filename}] SKIP: not found')
            continue
        patch_subclass(p, class_name)

    print('\nDone. Review with: git diff')


if __name__ == '__main__':
    main()