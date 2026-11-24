"""Profile a zoning layer: fields that look like zoning, with their distinct values.
Usage: python3 -I scripts/zoning-discovery/profile.py <layer url> [field,field...]"""
import warnings; warnings.filterwarnings("ignore")
import sys, json, re, urllib.request, urllib.parse


def get(url, params=None, timeout=40):
    url = url.replace(" ", "%20")
    if params:
        url += "?" + urllib.parse.urlencode(params)
    with urllib.request.urlopen(urllib.request.Request(url, headers={"User-Agent": "sb79-parcels-zoning-discovery"}), timeout=timeout) as r:
        return json.load(r)


u = sys.argv[1]
info = get(u, {"f": "json"})
fields = [f for f in info.get("fields", []) if f["type"] in ("esriFieldTypeString", "esriFieldTypeSmallInteger", "esriFieldTypeInteger")]
pick = sys.argv[2].split(",") if len(sys.argv) > 2 else [f["name"] for f in fields if re.search(r"zon|zone|class|desc|dist|code|type|label|name|categ|plan|gp|land", f["name"], re.I) and not re.search(r"globalid|shape|objectid|user|apn|ain|owner|addr|situs|street|parcel", f["name"], re.I)][:6]
print("fields:", " ".join(f["name"] for f in info.get("fields", [])))
for fn in pick:
    try:
        r = get(f"{u}/query", {"where": "1=1", "returnDistinctValues": "true", "outFields": fn, "returnGeometry": "false", "f": "json", "resultRecordCount": 1000})
        vals = sorted({str(f["attributes"].get(fn)) for f in r.get("features", [])})
    except Exception as e:
        vals = [f"ERR {e}"]
    print(f"-- {fn} ({len(vals)}): " + "; ".join(vals[:90]))
