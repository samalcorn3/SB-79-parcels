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
| Fire hazard severity zones | **CAL FIRE — Office of the State Fire Marshal** (LRA 2025 maps; SRA v23.3) | VHFHSZ / State Responsibility Area status and the fire-zone exclusions cities adopt |
| Ordinances, TODAPs, HCD findings | [`data/jurisdictions.json`](data/jurisdictions.json), a curated registry citing HCD letters | Which instrument governs |

## Coverage

| County | MPO | SB 79 status | Parcel source |
|---|---|---|---|
| Los Angeles | SCAG | In effect since July 1, 2026 | LA County Assessor parcels (hosted), with LA County DRP as fallback |
| Orange | SCAG | **Pending.** Becomes an urban transit county when the OC Streetcar opens; zones appear automatically once SCAG maps them | OC Public Works / OC Survey |
| San Diego | SANDAG (draft map) | In effect | SanGIS/SANDAG parcels |
| Sacramento | SACOG | In effect | Sacramento County GIS parcels (hosted), with the county map server as fallback |
| Alameda | MTC | In effect | Alameda County parcels |
| San Francisco | MTC | In effect | DataSF parcels (includes zoning) |
| San Mateo | MTC | In effect | San Mateo County "Active Parcels" (**last edited 2022**; the county publishes no current parcel REST service) |
| Santa Clara | MTC | In effect | Santa Clara County Planning parcels |

The other SCAG counties (Riverside, San Bernardino, Ventura, Imperial) are not urban transit counties, so SB 79 does not apply there. To add a county, add an entry to [`data/sources.json`](data/sources.json); no code changes are needed.

## SB 79 standards — from the statute text

All standards come from **Gov. Code § 65912.157** as it currently reads in the Legislative Counsel's leginfo database. That is SB 79 (Stats. 2025, ch. 512) as amended by **SB 722** (Stats. 2026, ch. 100, effective July 16, 2026). SB 722 added only § 65912.157(h)(3), which bars sites governed by mobilehome and RV-park laws.

leginfo.legislature.ca.gov blocks scripted access, so `scripts/statute.py` reads the same database from the Legislative Counsel's official export (`downloads.leginfo.legislature.ca.gov`). It pulls only the needed rows via HTTP range requests and writes §§ 65912.155–65912.162 to [`data/statute/`](data/statute/). [`tests/statute.test.mjs`](tests/statute.test.mjs) parses that text and fails if any number in [`data/standards.json`](data/standards.json) doesn't match. The daily monitor re-pulls the statute and opens a `statute-watch` issue if any section is amended.

The table shows what a local government may not go below:

| | Adjacent (≤ 200 ft) — ¼-mile standard + § 65912.157(e) intensifier | ≤ ¼ mile | ¼–½ mile, city of 35,000+ |
|---|---|---|---|
| **Tier 1**: heavy rail, very high frequency commuter rail | 95 ft · 160 du/ac · FAR 4.5 | 75 ft · 120 du/ac · FAR 3.5 — (a)(3) | 65 ft · 100 du/ac · FAR 3.0 — (a)(4) |
| **Tier 2**: light rail, high frequency commuter rail, dedicated-lane bus | 85 ft · 140 du/ac · FAR 4.0 | 65 ft · 100 du/ac · FAR 3.0 — (a)(5) | 55 ft · 80 du/ac · FAR 2.5 — (a)(6) |

Project requirements, also from § 65912.157:
- At least 5 units, and at least 30 du/ac or the local minimum density if greater — (a)(1).
- Average unit size no more than 1,750 net habitable sq ft — (a)(2).
- Additional density-bonus concessions at 90 / 75 / 75 / 60 du/ac, by tier and band — (a)(3)–(6)(D), (d).
- Projects over 10 units must set aside 7% extremely low, 10% very low, or 13% lower income units, for 55 years (rental) or 45 years (ownership) — (i).
- Labor standards apply to any building over 85 ft — (k).
- Setbacks and other local standards apply only if they do not, alone or in concert, prevent achieving these standards — (a)(3)–(6)(C), (c).

## Fire hazard severity zones

SB 79 does **not** remove fire zones from TOD zones on its own, so the MPO maps' smooth buffers are correct as published. The statute uses fire zones in three ways:

- **§ 65912.161(b)(1)(D)** — a city *may* adopt an ordinance temporarily excluding "sites within a very high fire hazard severity zone, as determined by [CAL FIRE] pursuant to Section 51178, or within the state responsibility area."
- **§ 65912.161(a)(2)(A)** — a TOD Alternative Plan may cut density on those sites by more than 50%.
- **§ 65912.159(a)(3)** — the streamlined ministerial path (§ 65913.4) is unavailable on a site in a very high fire hazard severity zone.

The site queries the State Fire Marshal's maps live for every parcel and reports the share of the lot in a VHFHSZ or the SRA. Where a city's ordinance in force excludes fire-zone sites, those parcels are excluded on the map and in the report, so the city's effective TOD zone takes on the fire zone's jagged edge. Currently that's Glendale, San Diego (O-22099), and Los Angeles (from the City's own layer). A parcel counts if any part of it (more than 1 m²) lies in the fire zone; the report shows the share.

## Which rules govern a parcel

From [HCD's SB 79 page](https://www.hcd.ca.gov/planning-and-research/sb79-tod), "TOD Project Compliance":

1. **TOD Alternative Plan**: governs only if **HCD has approved it** (Gov. Code § 65912.161(d)).
2. **Implementing, exemption, or temporary-exclusion ordinance**: governs **unless HCD has found it out of compliance**. This is HCD's position. Under § 65912.160(d)(5)–(6) the city may instead amend the ordinance or re-enact it with findings, and HCD may then notify the Attorney General. If HCD issues no findings within 90 days (120 with an extension), the ordinance is deemed compliant for penalty purposes (§ 65912.160(d)(3)).
3. **Otherwise**: § 65912.157 governs.
4. **Unincorporated areas**: SB 79 does not apply until the county's 7th-cycle housing element is due.

The site implements these rules in [`src/lib/policy.js`](src/lib/policy.js). If a city has an ordinance in force but has not published which parcels it covers, the site says so instead of guessing.

## The jurisdiction registry, and keeping it current

HCD publishes its SB 79 review letters only as PDFs on a [Power BI dashboard](https://www.hcd.ca.gov/hau/enforcement-letters), which cannot be queried programmatically. Local adoption status lives in city council records. So [`data/jurisdictions.json`](data/jurisdictions.json) is maintained by hand. Each entry records:

- the instrument type, local adoption status, date, and link
- HCD's status (`compliant`, `noncompliant`, `pending`, `unknown`, …), with the letter date, link, and any conditions
- coverage: `jurisdiction-wide`, `unknown`, or `arcgis` (a live city layer showing which parcels are covered, and why)
- `verification`: `primary` means the HCD letter or the ordinance itself was read; `secondary` means the status comes from news or law-firm reporting and still needs confirming against the dashboard

**Daily monitoring** ([`.github/workflows/monitor.yml`](.github/workflows/monitor.yml)) does three things:

- `npm run check:sources` verifies every endpoint and every mapped field. If one breaks, it opens a `source-health` issue.
- `python3 scripts/statute.py` re-reads §§ 65912.155–65912.162 from the leginfo export. If any section was amended, it opens a `statute-watch` issue.
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

## Layout

```
data/sources.json        endpoints and field mappings (MPOs, counties, boundaries, geocoder)
data/standards.json      § 65912.157 standards and provisions, transcribed from the statute and tested against it
data/statute/            current text of §§ 65912.155–65912.162 from the leginfo export, plus manifest
data/jurisdictions.json  local ordinances / TODAPs and HCD findings
src/lib/                 browser + Node library (ArcGIS/Socrata clients, zones, standards, policy, lookup)
src/ui/                  Leaflet map and report rendering
scripts/                 CLI lookup, source checker, HCD watcher, statute puller, browser smoke test
tests/                   node:test unit tests
```
