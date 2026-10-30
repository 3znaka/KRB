#!/usr/bin/env python3
"""Добавляет // @ts-nocheck в начало всех .ts файлов в src/, кроме js_TP."""
from pathlib import Path

SRC = Path("src")
SKIP_DIRS = {"js_TP", "node_modules"}
SKIP_PREFIXES = ("// @ts-nocheck", "/* @ts-nocheck")

if not SRC.is_dir():
    raise SystemExit("❌ Запустите из корня проекта (нет папки src/).")

count = 0
for p in sorted(SRC.rglob("*.ts")):
    if any(part in SKIP_DIRS for part in p.parts):
        continue
    text = p.read_text(encoding="utf-8")
    if any(text.lstrip().startswith(pref) for pref in SKIP_PREFIXES):
        print(f"   ⏭  уже есть: {p}")
        continue
    p.write_text("// @ts-nocheck\n" + text, encoding="utf-8")
    print(f"   ✅ {p}")
    count += 1

print(f"\nГотово: {count} файлов.")