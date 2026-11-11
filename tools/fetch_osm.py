"""日本全国の観光スポット（アプリの対象タグ）を Overpass API で取得して保存する。

    python -I tools/fetch_osm.py data/raw/osm_spots_YYYYMMDD.json

対象（アプリの表示対象と同じ）:
  tourism=attraction / museum / gallery / zoo / aquarium / theme_park（name のあるもの）
  tourism=viewpoint（名称なしも含む）
  historic=castle（name のあるもの）
  access=private / no は除外
データは © OpenStreetMap contributors（ODbL 1.0）。
"""
import json
import os
import sys
import time
import urllib.parse
import urllib.request

ENDPOINTS = [
    "https://overpass-api.de/api/interpreter",
    "https://maps.mail.ru/osm/tools/overpass/api/interpreter",
    "https://overpass.private.coffee/api/interpreter",
    "https://overpass.kumi.systems/api/interpreter",
]
QUERY = """[out:json][timeout:900][maxsize:1073741824];
area["ISO3166-1"="JP"][admin_level=2]->.jp;
(
  nwr["tourism"~"^(attraction|museum|gallery|zoo|aquarium|theme_park)$"]["name"](area.jp);
  nwr["tourism"="viewpoint"](area.jp);
  nwr["historic"="castle"]["name"](area.jp);
)->.s;
(.s; - nwr.s["access"~"^(private|no)$"];);
out center tags;"""
USER_AGENT = "SpotMap/1.0 (unofficial personal map; OSM data consumer)"
if os.environ.get("SM_OVERPASS_ENDPOINTS"):
    ENDPOINTS = os.environ["SM_OVERPASS_ENDPOINTS"].split(",")


def fetch():
    body = urllib.parse.urlencode({"data": QUERY}).encode()
    last = None
    for round_ in range(3):
        for ep in ENDPOINTS:
            try:
                req = urllib.request.Request(ep, data=body, headers={"User-Agent": USER_AGENT})
                started = time.time()
                with urllib.request.urlopen(req, timeout=960) as res:
                    data = json.loads(res.read().decode("utf-8"))
                if "elements" in data and data["elements"]:
                    print(f"ok endpoint={ep} elements={len(data['elements'])} sec={time.time() - started:.0f}")
                    return data
                last = f"empty from {ep}: {data.get('remark')}"
            except Exception as exc:  # noqa: BLE001
                last = f"{ep}: {exc}"
            print("retry:", last, flush=True)
            time.sleep(10)
    raise SystemExit(f"Overpass 取得失敗: {last}")


def main(out):
    data = fetch()
    os.makedirs(os.path.dirname(out) or ".", exist_ok=True)
    with open(out, "w", encoding="utf-8", newline="\n") as f:
        json.dump(data, f, ensure_ascii=False)
    print("osm_base:", data.get("osm3s", {}).get("timestamp_osm_base"))


if __name__ == "__main__":
    main(sys.argv[1])
