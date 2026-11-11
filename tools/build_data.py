"""Overpass の取得結果（tools/fetch_osm.py の出力）から、アプリ同梱用の格子データを作る。

    python -X utf8 -I tools/build_data.py data/raw/osm_spots_YYYYMMDD.json data/spots

出力:
  data/spots/index.json           データ取得時点・種別の一覧・格子（緯度経度0.25度）ごとの件数
  data/spots/<南端緯度>_<西端経度>.json  その格子の地点
    [緯度×10^5, 経度×10^5, 名称, 種別番号, Wikipedia日本語版の記事名, description, OSM要素ID(n/w/r+番号)]
    末尾の空の項目は省略しない（位置で意味を決めるため）。
データは © OpenStreetMap contributors（ODbL 1.0）。
"""
import json
import math
import os
import re
import sys

KINDS = ["attraction", "museum", "gallery", "viewpoint", "zoo", "aquarium", "theme_park", "castle"]
TOURISM_NAMED = {"attraction", "museum", "gallery", "zoo", "aquarium", "theme_park"}
DESCRIPTION_MAX = 300  # これより長い description は同梱しない（説明は Wikipedia を使う）
TILES_PER_DEG = 4  # 格子は緯度経度 0.25 度（boot.js と同じ）。1ファイルを小さくして読み込みを速くする


def tile_edge(v):
    """格子の南端・西端を、JavaScript の数値の文字列化と同じ形で返す（35、35.25、139.75 など）"""
    e = math.floor(v * TILES_PER_DEG) / TILES_PER_DEG
    return str(int(e)) if e == int(e) else repr(e)


def kind_of(tags):
    t = tags.get("tourism")
    if t in TOURISM_NAMED or t == "viewpoint":
        return t
    if tags.get("historic") == "castle":
        return "castle"
    return None


def main(src, out_dir):
    raw = json.load(open(src, encoding="utf-8"))
    base = raw.get("osm3s", {}).get("timestamp_osm_base", "")
    tiles = {}
    seen = set()
    skipped = {"no_coord": 0, "no_name": 0, "access": 0, "kind": 0}
    for e in raw["elements"]:
        osm_id = e["type"][0] + str(e["id"])
        if osm_id in seen:
            continue
        seen.add(osm_id)
        tags = e.get("tags", {})
        lat = e.get("lat", e.get("center", {}).get("lat"))
        lon = e.get("lon", e.get("center", {}).get("lon"))
        if lat is None or lon is None:
            skipped["no_coord"] += 1
            continue
        if re.fullmatch(r"private|no", tags.get("access", "")):
            skipped["access"] += 1
            continue
        kind = kind_of(tags)
        if kind is None:
            skipped["kind"] += 1
            continue
        name = (tags.get("name:ja") or tags.get("name") or "").strip()
        if not name and kind != "viewpoint":
            skipped["no_name"] += 1
            continue
        wiki = tags.get("wikipedia", "")
        wiki = wiki[3:].strip() if wiki.startswith("ja:") else ""
        desc = (tags.get("description") or "").strip()
        if len(desc) > DESCRIPTION_MAX:
            desc = ""
        key = f"{tile_edge(lat)}_{tile_edge(lon)}"
        tiles.setdefault(key, []).append([round(lat * 1e5), round(lon * 1e5), name, KINDS.index(kind), wiki, desc, osm_id])

    os.makedirs(out_dir, exist_ok=True)
    for old in os.listdir(out_dir):
        if old.endswith(".json"):
            os.remove(os.path.join(out_dir, old))
    total = 0
    for key, points in tiles.items():
        points.sort(key=lambda p: (p[0], p[1]))
        total += len(points)
        with open(os.path.join(out_dir, f"{key}.json"), "w", encoding="utf-8", newline="\n") as f:
            json.dump({"points": points}, f, ensure_ascii=False, separators=(",", ":"))
    index = {
        "source": "© OpenStreetMap contributors (ODbL 1.0)",
        "osm_base": base,
        "osm_date": base[:10],
        "total": total,
        "kinds": KINDS,
        "tile_deg": 1 / TILES_PER_DEG,
        "tiles": {k: len(v) for k, v in sorted(tiles.items())},
    }
    with open(os.path.join(out_dir, "index.json"), "w", encoding="utf-8", newline="\n") as f:
        json.dump(index, f, ensure_ascii=False, separators=(",", ":"))
    print(f"total={total} tiles={len(tiles)} skipped={skipped} osm_base={base}")


if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2])
