#!/usr/bin/env python3
"""
Refactor Utils.ts → Defaults.ts + TileKey.ts + private getOriginZ in Tiles.ts.

Usage:
    python refactor_utils.py [src_dir]
    python refactor_utils.py --dry-run [src_dir]

Default src_dir = "src" relative to CWD.

Actions:
  1. Creates src/Defaults.ts with DEFAULTS (+ Defaults type).
  2. Creates src/TileKey.ts with getVirtKey.
  3. Rewrites every `import { … } from './Utils.js'` in src/**/*.ts
     so each symbol is imported from its new module.
     - getOriginZ is dropped from imports (becomes private in Tiles.ts).
  4. Injects `function getOriginZ(...)` as a private helper into Tiles.ts,
     right after its last import statement.
  5. Deletes src/Utils.ts.

Safety:
  * Refuses to run if any required file is missing.
  * Refuses to run if Utils.ts doesn't have the expected shape.
  * Refuses to run if `getSrcKey` is still referenced anywhere.
  * Refuses to delete Utils.ts if any './Utils.js' import survived.
"""

import re
import sys
from pathlib import Path

# ============================================================
# Шаблоны новых файлов
# ============================================================

DEFAULTS_TS = '''/**
 * Глобальные значения по умолчанию для библиотеки.
 *
 * Все поля — фолбэки для параметров конструктора KrbMap и Tile.
 * Ранее жили в Utils.ts; вынесены сюда, чтобы не превращать
 * "утилиты" в свалку.
 *
 * @module Defaults
 */

export const DEFAULTS = {
    /**
     * Множитель высот DEM (1 = метры, world-единицы ≈ метры по
     * инварианту `Projections._wrapWorld`). Для визуального
     * преувеличения рельефа задайте `layer.heightScale > 1` явно.
     */
    HEIGHT_SCALE: 1,
    /** Число сегментов сетки рельефа по умолчанию. */
    SEGMENTS: 15,
    /** Длительность анимации перехода в секундах. */
    ANIM_DURATION: 0.2,
    /** Минимальный допустимый уровень зума. */
    MIN_ZOOM: 0,
    /** Максимальный допустимый уровень зума. */
    MAX_ZOOM: 24,
    /** Чувствительность управления зумом. */
    ZOOM_SENSITIVITY: 0.15,
    /** Множитель дальности отрисовки объектов. */
    OBJECT_RENDER_DISTANCE_FACTOR: 2.0,
    /** Минимальный зум, на котором используется рельеф. */
    MIN_RELIEF_Z: 0,
    /** Максимальный зум, для которого есть собственные данные рельефа. */
    MAX_RELIEF_Z: 24,
    /** Запас в тайлах вокруг области видимости для основного слоя. */
    TILE_MARGIN: 5,
    /** Запас в тайлах для фонового слоя. */
    TILE_MARGIN_BG: 2,
    /** Минимальный интервал обновления видимости в мс. */
    VISIBLE_UPDATE_THROTTLE: 150,
    /** Максимальное количество одновременных задач Web Worker. */
    MAX_WORKER_REQUESTS: 8,
    /** Базовый уровень зума для начального отображения. */
    BASE_ZOOM: 4,
    /** Fallback-дистанция камеры (world-единицы ≈ метры). */
    BASE_DISTANCE: 12_000_000,
    /** Уровень зума для статического фона. */
    STATIC_BG_ZOOM: 2,
    /** Размер тайла в пикселях (информативное значение). */
    TILE_PIXELS: 256,
} as const;

export type Defaults = typeof DEFAULTS;
'''

TILE_KEY_TS = '''/**
 * Ключи тайлов для виртуальных экземпляров на сцене.
 *
 * @module TileKey
 */

/**
 * Формирует строковый ключ тайла "z,x,y".
 *
 * Используется как для исходных тайлов (URL), так и для виртуальных
 * экземпляров на сцене — формат идентичен.
 */
export function getVirtKey(z: number, x: number, y: number): string {
    return `${z},${x},${y}`;
}
'''

GET_ORIGIN_Z_FN = '''/** Z-координата северного края тайла y в world-единицах (Z вниз). */
function getOriginZ(y: number, tileSize: number, halfExtentY: number): number {
    return -halfExtentY + y * tileSize;
}
'''

# ============================================================
# Утилиты
# ============================================================

IMPORT_RE = re.compile(
    r"import\s*\{([^}]+)\}\s*from\s*['\"]\.\/Utils\.js['\"];?[ \t]*\n?"
)

UTILS_IMPORT_RE = re.compile(r"""from\s*['"]\.\/Utils\.js['"]""")


def die(msg: str, code: int = 1) -> None:
    print(f"\n✗ ERROR: {msg}", file=sys.stderr)
    sys.exit(code)


def read(path: Path) -> str:
    return path.read_text(encoding='utf-8')


def write(path: Path, text: str, dry: bool) -> None:
    if dry:
        print(f"  [dry] would write {path.name} ({len(text)} bytes)")
        return
    path.write_text(text, encoding='utf-8')


def find_utils_imports(src: Path, exclude: set[str]) -> list[str]:
    """Return all lines in src/**/*.ts (excluding `exclude`) that import './Utils.js'."""
    hits = []
    for p in src.rglob('*.ts'):
        if p.name in exclude:
            continue
        for i, line in enumerate(read(p).splitlines(), 1):
            if UTILS_IMPORT_RE.search(line):
                hits.append(f"{p}:{i}: {line.strip()}")
    return hits


def find_symbol_usage(src: Path, symbol: str, exclude: set[str]) -> list[str]:
    """Return all lines in src/**/*.ts (excluding `exclude`) that mention `symbol`."""
    hits = []
    for p in src.rglob('*.ts'):
        if p.name in exclude:
            continue
        for i, line in enumerate(read(p).splitlines(), 1):
            if symbol in line:
                hits.append(f"{p}:{i}: {line.strip()}")
    return hits


def patch_imports(
    path: Path,
    mapping: dict[str, list[str]],
    dropped: set[str],
    dry: bool,
) -> None:
    """Rewrite `import { … } from './Utils.js'` lines based on symbol→module mapping."""
    text = read(path)

    def repl(match: re.Match) -> str:
        names = [n.strip() for n in match.group(1).split(',') if n.strip()]
        buckets: dict[str, list[str]] = {}
        for n in names:
            if n in dropped:
                continue
            target = None
            for mod, provides in mapping.items():
                if n in provides:
                    target = mod
                    break
            if target is None:
                die(f"{path.name}: unknown symbol '{n}' in './Utils.js' import")
            buckets.setdefault(target, []).append(n)
        # Порядок импортов = порядок ключей в `mapping`
        ordered = [m for m in mapping if m in buckets]
        return "".join(
            f"import {{ {', '.join(buckets[m])} }} from './{m}.js';\n"
            for m in ordered
        )

    new_text, count = IMPORT_RE.subn(repl, text)
    if count == 0:
        print(f"  · {path.name}: no './Utils.js' import — skipped")
        return
    if dry:
        print(f"  [dry] would patch {path.name} ({count} import(s))")
        return
    path.write_text(new_text, encoding='utf-8')
    print(f"  ✓ {path.name}: patched {count} import(s)")


def inject_get_origin_z(path: Path, dry: bool) -> None:
    """Insert getOriginZ() as a private function after the last import in Tiles.ts."""
    text = read(path)
    if 'function getOriginZ(' in text:
        print(f"  · {path.name}: getOriginZ already present — skipped")
        return

    lines = text.splitlines(keepends=True)
    last_import = -1
    for i, line in enumerate(lines):
        s = line.lstrip()
        if s.startswith('import ') and s.rstrip().endswith(';'):
            last_import = i
    if last_import == -1:
        die(f"{path.name}: cannot locate last import statement")

    injected = ["\n", GET_ORIGIN_Z_FN]
    new_lines = lines[:last_import + 1] + injected + lines[last_import + 1:]
    new_text = "".join(new_lines)

    if dry:
        print(f"  [dry] would inject getOriginZ() into {path.name}")
        return
    path.write_text(new_text, encoding='utf-8')
    print(f"  ✓ {path.name}: injected getOriginZ()")


# ============================================================
# main
# ============================================================

def main() -> None:
    args = [a for a in sys.argv[1:] if not a.startswith('-')]
    dry = '--dry-run' in sys.argv or '-n' in sys.argv

    src = Path(args[0]) if args else Path('src')
    if not src.is_dir():
        die(f"src directory not found: {src}")
    src = src.resolve()

    # --- Preflight ---
    utils = src / 'Utils.ts'
    if not utils.exists():
        die(f"{utils} not found")

    utils_text = read(utils)
    for needle in ('export const DEFAULTS', 'export function getVirtKey'):
        if needle not in utils_text:
            die(f"Utils.ts: '{needle}' not found — unexpected shape")

    required = ['Core.ts', 'Tiles.ts', 'CoreElevation.ts', 'CoreCamera.ts']
    for name in required:
        if not (src / name).exists():
            die(f"missing required file: {src / name}")

    # getSrcKey must be unused everywhere except Utils.ts
    hits = find_symbol_usage(src, 'getSrcKey', exclude={'Utils.ts'})
    if hits:
        die("getSrcKey is still referenced, refusing to drop it:\n  "
            + "\n  ".join(hits))

    print(f"▶ Refactoring {src}{' [DRY RUN]' if dry else ''}")

    # --- 1. Create Defaults.ts ---
    write(src / 'Defaults.ts', DEFAULTS_TS, dry)
    if not dry:
        print("  ✓ created Defaults.ts")

    # --- 2. Create TileKey.ts ---
    write(src / 'TileKey.ts', TILE_KEY_TS, dry)
    if not dry:
        print("  ✓ created TileKey.ts")

    # --- 3. Patch imports across every .ts that still imports Utils ---
    mapping = {
        'Defaults': ['DEFAULTS'],
        'TileKey':  ['getVirtKey'],
    }
    dropped = {'getOriginZ'}  # becomes private in Tiles.ts

    targets = [
        p for p in src.rglob('*.ts')
        if p.name not in ('Utils.ts', 'Defaults.ts', 'TileKey.ts')
    ]
    for p in targets:
        patch_imports(p, mapping, dropped, dry)

    # --- 4. Inject getOriginZ into Tiles.ts ---
    inject_get_origin_z(src / 'Tiles.ts', dry)

    # --- 5. Verify no leftovers, then delete Utils.ts ---
    leftover = find_utils_imports(src, exclude={'Utils.ts'})
    if leftover:
        die("still importing from './Utils.js', refusing to delete Utils.ts:\n  "
            + "\n  ".join(leftover))

    if dry:
        print(f"  [dry] would delete Utils.ts")
    else:
        utils.unlink()
        print("  ✓ deleted Utils.ts")

    print("\n▶ Done.")
    print("  Sanity check (should print nothing):")
    print("    grep -rn \"from './Utils\" src/")


if __name__ == '__main__':
    main()