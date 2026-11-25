"""Second-pass discovery for a city: deep extent search limited to city-sized items,
plus ArcGIS Online users whose name contains the city's name.
Usage: python3 -I scripts/zoning-discovery/by-extent.py "<City>"  -> JSON lines of candidate items."""
import warnings; warnings.filterwarnings("ignore")
import sys, json, re, datetime, urllib.request, urllib.parse

CDT = "https://services3.arcgis.com/uknczv4rpevve42E/arcgis/rest/services/California_Cities_and_Identifiers_Blue_Version_view/FeatureServer/2/query"
SEARCH = "https://www.arcgis.com/sharing/rest/search"


def get(url, params=None, timeout=30):
    if params:
        url += "?" + urllib.parse.urlencode(params)
    with urllib.request.urlopen(urllib.request.Request(url, headers={"User-Agent": "sb79-parcels-zoning-discovery"}), timeout=timeout) as r:
        return json.load(r)


city = sys.argv[1]
q = get(CDT, {"where": f"CDTFA_CITY='{city.replace(chr(39), chr(39)*2)}'", "returnExtentOnly": "true", "outSR": "4326", "f": "json"})
e = q["extent"]
bx = [e["xmin"], e["ymin"], e["xmax"], e["ymax"]]
w, h = bx[2] - bx[0], bx[3] - bx[1]
found = {}


def keep(it, why):
    ex = it.get("extent") or []
    if not ex:
        return
    (x0, y0), (x1, y1) = ex
    cx, cy = (x0 + x1) / 2, (y0 + y1) / 2
    if not (bx[0] - w * 0.2 <= cx <= bx[2] + w * 0.2 and bx[1] - h * 0.2 <= cy <= bx[3] + h * 0.2):
        return
    if (x1 - x0) > max(w * 3, 0.05) or (y1 - y0) > max(h * 3, 0.05):
        return  # far larger than the city: regional or county layer
    found.setdefault(it["id"], {
        "why": why, "owner": it["owner"], "title": it["title"], "type": it["type"], "url": it.get("url"),
        "modified": datetime.date.fromtimestamp(it["modified"] / 1000).isoformat(),
    })


for term in ["title:zoning", "title:zone", "zoning", "title:\"land use\""]:
    for start in range(1, 501, 100):
        try:
            r = get(SEARCH, {"q": f'{term} (type:"Feature Service" OR type:"Map Service" OR type:"Web Map")', "bbox": ",".join(map(str, bx)), "num": 100, "start": start, "f": "json"})
        except Exception:
            break
        for it in r.get("results", []):
            keep(it, f"bbox {term}")
        if r.get("nextStart", -1) < 0:
            break

base = re.sub(r"[^a-z]", "", city.lower().replace("ñ", "n"))
for uq in [base, city.split()[0].lower()]:
    try:
        users = get("https://www.arcgis.com/sharing/rest/community/users", {"q": uq, "num": 100, "f": "json"}).get("results", [])
    except Exception:
        users = []
    for u in users:
        if base[:6] not in re.sub(r"[^a-z]", "", (u.get("username", "") + u.get("fullName", "")).lower()):
            continue
        try:
            r = get(SEARCH, {"q": f'owner:"{u["username"]}" (zon* OR "land use")', "num": 100, "f": "json"})
        except Exception:
            continue
        for it in r.get("results", []):
            if re.search(r"zon", it["title"], re.I):
                keep(it, f"user {u['username']}")

for k, v in found.items():
    if v["type"] == "Web Map" and not re.search(r"zon", v["title"], re.I):
        continue
    print(json.dumps({"city": city, "id": k, **v}))
