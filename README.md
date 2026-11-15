# SB 79 Parcel Lookup

A map and address lookup for every parcel in California's SB 79 urban transit counties. For any address or lot it reports:

- **TOD zone**: Tier 1 or Tier 2, and whether the parcel is adjacent (within 200 ft), within ¼ mile, or within ½ mile of a TOD stop.
- **Local delay or exclusion ordinance**: whether one covers the parcel, and HCD's review status.
- **Local TOD Alternative Plan (TODAP)**: whether one covers the parcel, and whether HCD has approved it.
- **Which rules govern**: Gov. Code § 65912.157, the local ordinance, or the TODAP.
- **Development standards**: guaranteed minimum height, density, and residential FAR, the units and floor area those allow on the actual lot, plus setback, demolition, affordability, and labor rules with citations.

**The data is live.** Nothing is downloaded into this repository. Each lookup and each map view queries the authoritative servers at that moment:

| Layer | Authority | How it is used |
|---|---|---|
| TOD stops and zones | Each MPO's SB 79 map: **SCAG**, **MTC/ABAG**, **SANDAG**, **SACOG** | Parcel-to-zone intersection (Gov. Code § 65912.160(f) gives these maps a rebuttable presumption of validity) |
| Parcels | Each **county assessor or GIS** parcel service | Parcel polygon, APN, and situs address |
| City and county limits | **California Department of Technology** | Jurisdiction, and incorporated vs. unincorporated |
| Local exclusion parcels | City-published layers (San Francisco, Los Angeles) | Whether an ordinance covers this exact parcel |
| Ordinances, TODAPs, HCD findings | [`data/jurisdictions.json`](data/jurisdictions.json), a curated registry citing HCD letters | Which instrument governs |

## Coverage

| County | MPO | SB 79 status | Parcel source |
|---|---|---|---|
| Los Angeles | SCAG | In effect since July 1, 2026 | LA County Assessor parcels (hosted), with LA County DRP as fallback |
| Orange | SCAG | **Pending.** Becomes an urban transit county when the OC Streetcar opens; zones appear automatically once SCAG maps them | OC Public Works / OC Survey |
| San Diego | SANDAG (draft map) | In effect | SanGIS/SANDAG parcels |
| Sacramento | SACOG | In effect | Sacramento County parcels |
| Alameda | MTC | In effect | Alameda County parcels |
| San Francisco | MTC | In effect | DataSF parcels (includes zoning) |
| San Mateo | MTC | In effect | San Mateo County "Active Parcels" (**last edited 2022**; the county publishes no current parcel REST service) |
| Santa Clara | MTC | In effect | Santa Clara County Planning parcels |

The other SCAG counties (Riverside, San Bernardino, Ventura, Imperial) are not urban transit counties, so SB 79 does not apply there. To add a county, add an entry to [`data/sources.json`](data/sources.json); no code changes are needed.

## SB 79 standards (Gov. Code § 65912.157)

These are the lowest limits a city may impose. Source: HCD's technical-assistance letter to Los Angeles (June 22, 2026), Table 1.

| | Adjacent (≤ 200 ft) | ≤ ¼ mile | ¼–½ mile (cities with 35,000+ residents) |
|---|---|---|---|
| **Tier 1**: heavy rail, very high frequency commuter rail | 95 ft · 160 du/ac · FAR 4.5 | 75 ft · 120 du/ac · FAR 3.5 | 65 ft · 100 du/ac · FAR 3.0 |
| **Tier 2**: light rail, high frequency commuter rail, dedicated-lane bus | 85 ft · 140 du/ac · FAR 4.0 | 65 ft · 100 du/ac · FAR 3.0 | 55 ft · 80 du/ac · FAR 2.5 |

## Which rules govern a parcel

From [HCD's SB 79 page](https://www.hcd.ca.gov/planning-and-research/sb79-tod), "TOD Project Compliance":

1. **TOD Alternative Plan**: governs only if **HCD has approved it** (Gov. Code § 65912.161(d)).
2. **Implementing, exemption, or temporary-exclusion ordinance**: governs **unless HCD has found it out of compliance**.
3. **Otherwise**: § 65912.157 governs.
4. **Unincorporated areas**: SB 79 does not apply until the county's 7th-cycle housing element is due.

The site implements these rules in [`src/lib/policy.js`](src/lib/policy.js). If a city has an ordinance in force but has not published which parcels it covers, the site says so instead of guessing.

## The jurisdiction registry, and keeping it current

HCD publishes its SB 79 review letters only as PDFs on a [Power BI dashboard](https://www.hcd.ca.gov/hau/enforcement-letters), which cannot be queried programmatically. Local adoption status lives in city council records. So [`data/jurisdictions.json`](data/jurisdictions.json) is maintained by hand. Each entry records:

- the instrument type, local adoption status, date, and link
- HCD's status (`compliant`, `noncompliant`, `pending`, `unknown`, …), with the letter date, link, and any conditions
- coverage: `jurisdiction-wide`, `unknown`, or `arcgis` (a live city layer showing which parcels are covered, and why)
- `verification`: `primary` means the HCD letter or the ordinance itself was read; `secondary` means the status comes from news or law-firm reporting and still needs confirming against the dashboard

**Daily monitoring** ([`.github/workflows/monitor.yml`](.github/workflows/monitor.yml)) does two things:

- `npm run check:sources` verifies every endpoint and every mapped field. If one breaks, it opens a `source-health` issue.
- `npm run check:hcd` fingerprints HCD's SB 79 and letters pages, checks every registry link, and flags the registry once it is 30+ days old. Any of these opens an `hcd-watch` issue.

To update the registry: edit `data/jurisdictions.json` and set `lastReviewed`. Run `npm test`, which validates the schema. Then run `npm run check:hcd -- --update` and commit both files.

## Running locally

```bash
npm install
npm test                       # offline unit tests (zone parsing, standards, governing rules)
npm run check:sources          # live check of every endpoint
npm run lookup -- "1221 Broadway, Oakland, CA"   # full JSON report from the command line
npm run serve                  # then open http://localhost:8080
```

`scripts/browser-smoke.mjs` runs the real site in headless Chromium against the live sources.

## Deploying

The site is static: `index.html`, `assets/`, `src/`, and `data/`. [`.github/workflows/pages.yml`](.github/workflows/pages.yml) runs the tests and publishes to GitHub Pages on every push to `main`. One-time setup: **Settings → Pages → Source: GitHub Actions**.

## Known limitations

- **Not a zoning determination.** Confirm with the local planning department.
- **SANDAG's map is a draft.** It also has no 200-ft layer, so San Diego adjacency is computed live from SANDAG's stop points.
- **SACOG's zone layer has no tier field.** All SACOG stops are treated as Tier 2, since SacRT is light rail per HCD's March 2026 advisory and the region has no heavy rail.
- **SCAG commuter-rail zones** follow HCD's advisory method, which counts all services at a station. They are flagged in the report.
- **Setbacks and lot coverage.** SB 79 sets no numeric values for these. Local objective standards apply as long as they don't physically preclude the SB 79 density and FAR. The report shows local zoning where a county or city publishes it (San Francisco, Sacramento County, City of San Diego, and unincorporated LA County).
- **Partial registry.** Many entries are still `secondary`, and most cities have not published parcel-level exclusion layers. See [docs/METHODOLOGY.md](docs/METHODOLOGY.md).
- **Statute text.** The text on leginfo.legislature.ca.gov sits behind a bot challenge, so the standards are taken from HCD's official letters and advisory, which quote the statute.

## Layout

```
data/sources.json        endpoints and field mappings (MPOs, counties, boundaries, geocoder)
data/standards.json      § 65912.157 standards and provisions, with citations
data/jurisdictions.json  local ordinances / TODAPs and HCD findings
src/lib/                 browser + Node library (ArcGIS/Socrata clients, zones, standards, policy, lookup)
src/ui/                  Leaflet map and report rendering
scripts/                 CLI lookup, source checker, HCD watcher, browser smoke test
tests/                   node:test unit tests
```
