"""OSM の日本データから公衆トイレだけを抜き出し、スマホへ同梱する JSON を作る。

    pip install osmium
    curl -L -o japan-latest.osm.pbf https://download.geofabrik.de/asia/japan-latest.osm.pbf
    python tools/build_toilets.py japan-latest.osm.pbf public/data/toilets-jp.json

出力: {"built": "YYYY-MM-DD", "points": [[緯度*1e5, 経度*1e5, "名称"], ...]}
データは OpenStreetMap contributors（ODbL）。月1回ほど作り直せば十分。
"""
import datetime
import json
import os
import sys

import osmium

SKIP_ACCESS = {"private", "no"}


def main(pbf, out):
    points = []
    skipped = 0
    tag_filter = osmium.filter.TagFilter(("amenity", "toilets"))
    processor = osmium.FileProcessor(pbf).with_locations().with_filter(tag_filter)
    for obj in processor:
        if obj.tags.get("access") in SKIP_ACCESS:
            skipped += 1
            continue
        if obj.is_node():
            lat, lon = obj.location.lat, obj.location.lon
        elif obj.is_way():
            nodes = [n.location for n in obj.nodes if n.location.valid()]
            if not nodes:
                continue
            lat = sum(n.lat for n in nodes) / len(nodes)
            lon = sum(n.lon for n in nodes) / len(nodes)
        else:
            continue
        points.append([round(lat * 1e5), round(lon * 1e5), obj.tags.get("name:ja") or obj.tags.get("name") or ""])

    os.makedirs(os.path.dirname(out), exist_ok=True)
    built = datetime.date.today().isoformat()
    with open(out, "w", encoding="utf-8", newline="\n") as f:
        json.dump({"built": built, "points": points}, f, ensure_ascii=False, separators=(",", ":"))
    named = sum(1 for p in points if p[2])
    print(f"points={len(points)} named={named} skipped_private={skipped} bytes={os.path.getsize(out)}")


if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2])
