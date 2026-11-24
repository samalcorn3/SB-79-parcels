"""Third pass: zoning apps (Web Mapping Application, Experience Builder, Dashboard, Hub)
whose title names the city; follow app -> web map -> layers with 'zon' in title or URL.
Usage: python3 -I scripts/zoning-discovery/by-app.py "<City>" -> JSON lines."""
import warnings; warnings.filterwarnings("ignore")
import sys, json, re, datetime, urllib.request, urllib.parse

SEARCH = "https://www.arcgis.com/sharing/rest/search"


def get(url, params=None, timeout=25):
    if params:
        url += "?" + urllib.parse.urlencode(params)
    with urllib.request.urlopen(urllib.request.Request(url, headers={"User-Agent": "sb79-parcels-zoning-discovery"}), timeout=timeout) as r:
        return json.load(r)


city = sys.argv[1]
name = city.replace("ñ", "n")
seen = set()
types = '(type:"Web Mapping Application" OR type:"Web Experience" OR type:"Dashboard" OR type:"Hub Site Application" OR type:"Web Map" OR type:"Application")'
for q in [f'"{name}" zoning {types}', f'"{name}" "zoning map" {types}', f'"City of {name}" parcel {types}']:
    try:
        res = get(SEARCH, {"q": q, "num": 50, "f": "json"}).get("results", [])
    except Exception:
        continue
    for it in res:
        if it["id"] in seen:
            continue
        seen.add(it["id"])
        maps = []
        if it["type"] == "Web Map":
            maps = [it["id"]]
        else:
            try:
                d = get(f"https://www.arcgis.com/sharing/rest/content/items/{it['id']}/data", {"f": "json"})
            except Exception:
                continue
            s = json.dumps(d)
            maps = list(dict.fromkeys(re.findall(r'"(?:webmap|itemId|id)"\s*:\s*"([0-9a-f]{32})"', s)))[:6]
        for m in maps:
            try:
                wm = get(f"https://www.arcgis.com/sharing/rest/content/items/{m}/data", {"f": "json"})
            except Exception:
                continue

            def walk(ls):
                for l in ls or []:
                    u = l.get("url") or ""
                    if u and re.search(r"zon", (l.get("title") or "") + u, re.I) and not re.search(r"overlay|fire|flood|evac|coastal|opportun|sweep|liquef|landslide|fault|maint", (l.get("title") or "") + u, re.I):
                        print(json.dumps({"city": city, "app": it["title"], "owner": it["owner"], "modified": datetime.date.fromtimestamp(it["modified"] / 1000).isoformat(), "layer": l.get("title"), "url": u}))
                    walk(l.get("layers"))
            walk(wm.get("operationalLayers"))
