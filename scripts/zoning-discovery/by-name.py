"""Find candidate zoning layers for a California city.

Usage: python3 -I scripts/zoning-discovery/by-name.py "<City>" > out.json
Searches ArcGIS Online (by name, by the city's extent, and the city's web maps),
expands services to polygon layers whose name mentions zoning, and for each
reports owner, org, edit date, fields and how many features fall in the city.
"""
import warnings; warnings.filterwarnings("ignore")
import sys, json, re, datetime, urllib.request, urllib.parse
from concurrent.futures import ThreadPoolExecutor

CDT = "https://services3.arcgis.com/uknczv4rpevve42E/arcgis/rest/services/California_Cities_and_Identifiers_Blue_Version_view/FeatureServer/2/query"
SEARCH = "https://www.arcgis.com/sharing/rest/search"
SKIP = re.compile(r"overlay|cannabis|fire|flood|climate|coastal|enterprise|opportun|green.?zone|liquef|landslide|buffer|school|trash|sweep|evac|police|tsunami|noise|airport|hardiness|parking.?zone|maint|pruning|bus |weather|fault|seismic|habitat|soil|tree|historic|census|proposed|draft|hmp|hazard|ozone|wildland|ember|vending|cool|response|dispatch|traffic|signal|storm|sewer|water zone|pressure|sign|label|annotation|anno\b|test|copy|backup|lighting|landscape|llmd|cfd|assessment|cra zone|election|council|ward|precinct", re.I)
REGIONAL = re.compile(r"scag|mtc|abag|bayareametro|sandag|sacog|lacounty|planning\.lacounty|ocgis|esri_|tutorial|ucsd|sdsu|ucla|usc|csulb|ucdavis|ucirvine|stanford|berkeley\.edu|student|cannamap|zoneomics|regrid|asu\b|_asu|edu", re.I)


def get(url, params=None, timeout=30):
    url = url.replace(" ", "%20")
    if params:
        url += ("&" if "?" in url else "?") + urllib.parse.urlencode(params)
    with urllib.request.urlopen(urllib.request.Request(url, headers={"User-Agent": "sb79-parcels-zoning-discovery"}), timeout=timeout) as r:
        return json.load(r)


def day(ms):
    return datetime.datetime.fromtimestamp(ms / 1000, datetime.UTC).date().isoformat() if ms else None


city = sys.argv[1]
q = get(CDT, {"where": f"CDTFA_CITY='{city.replace(chr(39), chr(39)*2)}'", "returnExtentOnly": "true", "outSR": "4326", "f": "json"})
e = q["extent"]
bbox = [e["xmin"], e["ymin"], e["xmax"], e["ymax"]]
env = json.dumps({"xmin": bbox[0], "ymin": bbox[1], "xmax": bbox[2], "ymax": bbox[3], "spatialReference": {"wkid": 4326}})

items = {}
short = city.replace("La Cañada Flintridge", "La Canada Flintridge")
queries = [f'"{short}" zoning', f'title:zoning "{short}"', f'"{short}" zone', f'"City of {short}" zoning']
for qq in queries:
    for typ in ['(type:"Feature Service" OR type:"Map Service")', 'type:"Web Map"']:
        try:
            r = get(SEARCH, {"q": f"{qq} {typ}", "num": 100, "f": "json"})
            for it in r.get("results", []):
                items[it["id"]] = it
        except Exception:
            pass
for term in ["zoning", "zone"]:
    try:
        r = get(SEARCH, {"q": f'{term} (type:"Feature Service" OR type:"Map Service")', "bbox": ",".join(map(str, bbox)), "num": 100, "f": "json"})
        for it in r.get("results", []):
            items[it["id"]] = it
    except Exception:
        pass

# Service URLs to look at, with the item that pointed to them.
urls = {}
for it in items.values():
    ex = it.get("extent") or []
    if ex and abs(ex[1][0] - ex[0][0]) > 3:
        continue  # statewide or larger
    who = f"{it.get('owner')} | {it.get('title')}"
    if REGIONAL.search(it.get("owner", "")):
        continue
    if it["type"] == "Web Map":
        if not re.search(r"zon", it.get("title", ""), re.I):
            continue
        try:
            d = get(f"https://www.arcgis.com/sharing/rest/content/items/{it['id']}/data", {"f": "json"})
        except Exception:
            continue

        def walk(ls):
            for l in ls:
                if l.get("url") and re.search(r"zon", (l.get("title") or "") + l["url"], re.I):
                    urls.setdefault(l["url"], f"webmap {who}")
                walk(l.get("layers") or [])
        walk(d.get("operationalLayers", []))
    elif it.get("url") and re.search(r"zon", it.get("title", "") + it["url"], re.I):
        urls.setdefault(it["url"], who)


def layers_of(u):
    """Polygon layers under a service or layer URL."""
    u = u.rstrip("/")
    if re.search(r"/\d+$", u):
        return [u]
    try:
        info = get(u, {"f": "json"})
    except Exception:
        return []
    out = []
    for l in info.get("layers", []) or []:
        if l.get("geometryType") in (None, "esriGeometryPolygon") and not l.get("subLayerIds"):
            out.append(f"{u}/{l['id']}")
    return out


cands = {}
for u, who in urls.items():
    if SKIP.search(u.split("/rest/services/")[-1]) and not re.search(r"zoning", u, re.I):
        continue
    for lu in layers_of(u)[:12]:
        cands.setdefault(lu, who)


def inspect(lu):
    try:
        info = get(lu, {"f": "json"})
    except Exception as ex:
        return None
    if info.get("geometryType") != "esriGeometryPolygon":
        return None
    name = info.get("name", "")
    if SKIP.search(name) and not re.search(r"zoning", name, re.I):
        return None
    if not re.search(r"zon", name + lu, re.I):
        return None
    ei = info.get("editingInfo") or {}
    edited = ei.get("dataLastEditDate") or ei.get("lastEditDate")
    fields = [f["name"] for f in info.get("fields", [])]
    datef = [f["name"] for f in info.get("fields", []) if f["type"] == "esriFieldTypeDate"]
    maxdate = None
    for df in datef[:4]:
        try:
            st = get(f"{lu}/query", {"where": "1=1", "outStatistics": json.dumps([{"statisticType": "max", "onStatisticField": df, "outStatisticFieldName": "m"}]), "f": "json"}, timeout=20)
            m = st["features"][0]["attributes"]["m"]
            if isinstance(m, (int, float)) and (not maxdate or m > maxdate[1]):
                maxdate = (df, m)
        except Exception:
            pass
    try:
        n_in = get(f"{lu}/query", {"where": "1=1", "geometry": env, "geometryType": "esriGeometryEnvelope", "inSR": 4326, "spatialRel": "esriSpatialRelIntersects", "returnCountOnly": "true", "f": "json"}, timeout=25).get("count")
        n_all = get(f"{lu}/query", {"where": "1=1", "returnCountOnly": "true", "f": "json"}, timeout=25).get("count")
    except Exception:
        n_in = n_all = None
    return {
        "url": lu, "via": cands[lu], "name": name, "edited": day(edited),
        "maxDate": [maxdate[0], day(maxdate[1])] if maxdate else None,
        "inCity": n_in, "total": n_all, "fields": fields[:40],
        "copyright": (info.get("copyrightText") or "")[:120],
    }


with ThreadPoolExecutor(8) as ex:
    res = [r for r in ex.map(inspect, list(cands)[:40]) if r and r["inCity"]]
res.sort(key=lambda r: (-(r["inCity"] or 0) / max(r["total"] or 1, 1), r["url"]))
print(json.dumps({"city": city, "bbox": bbox, "candidates": res}, indent=1))
