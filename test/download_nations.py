"""Скачивание данных «Атласа единства» в локальную папку static_nations/.

Источник: https://dev.kartfak.ru/nation (у эндпоинта нет CORS-заголовков,
поэтому браузер не может забирать данные напрямую с live-server).

Структура результата:
    static_nations/geo/<Народ>.json                      ← adm_list_nation.php
    static_nations/graph/nation/<Народ>.json             ← graph_nation.php
    static_nations/graph/subject/<Субъект>.json          ← graph_subject_nation.php
    static_nations/img/pict/<Народ>.png                  ← img/pict/<Народ>.png
    static_nations/manifest.json                         ← список народов/субъектов
"""
import json
import os
import ssl
import sys
import time
import urllib.parse
import urllib.request

BASE = "https://dev.kartfak.ru/nation"
OUT = r"C:\GitHub\KRB\static_nations"
CTX = ssl.create_default_context()

NATIONS = [
    "Русские", "Татары", "Чеченцы", "Башкиры", "Чуваши", "Аварцы", "Украинцы",
    "Армяне", "Даргинцы", "Казахи", "Кумыки", "Кабардинцы", "Чукчи", "Эскимосы",
]


def get(url, tries=3):
    last = None
    for attempt in range(tries):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0 (KRB atlas export)"})
            with urllib.request.urlopen(req, timeout=120, context=CTX) as r:
                return r.read()
        except Exception as e:                       # noqa: BLE001
            last = e
            time.sleep(1.5 * (attempt + 1))
    raise last


def save(path, data):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "wb") as f:
        f.write(data)
    return len(data)


def main():
    report = []
    total = 0

    # ── 1. Геометрия + показатели по народам ──────────────────────────
    subjects = []
    for nation in NATIONS:
        url = f"{BASE}/php/adm_list_nation.php?q={urllib.parse.quote(nation)}"
        raw = get(url)
        data = json.loads(raw)                       # проверяем валидность JSON
        n = save(os.path.join(OUT, "geo", f"{nation}.json"), raw)
        total += n
        feats = data.get("features", [])
        report.append(f"geo  {nation:<12} {len(feats):>3} фич  {n/1e6:.2f} МБ")
        # первый народ-ответ задаёт список субъектов (геометрия у всех одна)
        if not subjects:
            subjects = [f["properties"]["name"] for f in feats]

    # ── 2. График по народам (топ-10 субъектов) ───────────────────────
    for nation in NATIONS:
        url = f"{BASE}/php/graph_nation.php?q={urllib.parse.quote(nation)}"
        raw = get(url)
        json.loads(raw)
        n = save(os.path.join(OUT, "graph", "nation", f"{nation}.json"), raw)
        total += n
        report.append(f"graph {nation:<12} {n:>7} Б")

    # ── 3. Национальный состав по каждому субъекту ────────────────────
    ok, empty = 0, []
    for subject in subjects:
        url = f"{BASE}/php/graph_subject_nation.php?q={urllib.parse.quote(subject)}"
        raw = get(url)
        data = json.loads(raw)
        n = save(os.path.join(OUT, "graph", "subject", f"{subject}.json"), raw)
        total += n
        ok += 1
        if not data:
            empty.append(subject)
    report.append(f"graph subject: сохранено {ok}, пустых ответов {len(empty)}")
    if empty:
        report.append("  пустые: " + ", ".join(empty))

    # ── 4. Портреты ───────────────────────────────────────────────────
    for nation in NATIONS:
        url = f"{BASE}/img/pict/{urllib.parse.quote(nation)}.png"
        raw = get(url)
        if raw[:8] != b"\x89PNG\r\n\x1a\n":
            raise RuntimeError(f"{nation}: ожидался PNG, получено {raw[:8]!r}")
        n = save(os.path.join(OUT, "img", "pict", f"{nation}.png"), raw)
        total += n
        report.append(f"img  {nation:<12} {n/1e6:.2f} МБ")

    # ── 5. Манифест ───────────────────────────────────────────────────
    manifest = {
        "source": BASE,
        "exportedAt": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
        "nations": NATIONS,
        "subjects": subjects,
        "layout": {
            "geo": "geo/{nation}.json",
            "graphNation": "graph/nation/{nation}.json",
            "graphSubject": "graph/subject/{subject}.json",
            "portrait": "img/pict/{nation}.png",
        },
    }
    n = save(os.path.join(OUT, "manifest.json"),
             json.dumps(manifest, ensure_ascii=False, indent=2).encode("utf-8"))
    total += n

    print("\n".join(report))
    print(f"\nВсего: {total/1e6:.1f} МБ в {OUT}")
    print(f"Субъектов: {len(subjects)}")


if __name__ == "__main__":
    sys.exit(main())