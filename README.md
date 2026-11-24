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
| Site exclusions, § 65913.4(a)(6) | **Coastal Commission** (coastal zone, LCP certification); **Dept. of Conservation** (Important Farmland, newest survey found live; ag easements); **California Geological Survey** (Alquist-Priolo fault zones); **FEMA** (National Flood Hazard Layer); **USFWS** (National Wetlands Inventory; critical habitat); **DTSC** (EnviroStor, updated daily); **CDFW** (NCCP/HCP plan areas) | Whether the site clears the exclusions that apply to SB 79 streamlining and to AB 2011 |
| Ordinances, TODAPs, HCD findings | [`data/jurisdictions.json`](data/jurisdictions.json), a curated registry citing HCD letters | Which instrument governs |

## Coverage

| County | MPO | SB 79 status | Parcel source |
|---|---|---|---|
| Los Angeles | SCAG | In effect since July 1, 2026 | LA County Assessor parcels (hosted), with LA County DRP as fallback |
| Orange | SCAG | **Pending.** Not yet an urban transit county: HCD counts only stations in operation, and SCAG says OC qualifies when the OC Streetcar opens (OCTA: "service starting early 2027"). Zones appear automatically once SCAG maps them | OC Public Works / OC Survey |
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

The site queries the State Fire Marshal's maps live for every parcel and reports the share of the lot in a VHFHSZ or the SRA. Where a city's ordinance in force excludes fire-zone sites, those parcels are excluded on the map and in the report, so the city's effective TOD zone takes on the fire zone's jagged edge. Currently that's San Diego (O-22099 § 4, very high FHSZ only) and Los Angeles (from the City's own layer).

**Partly covered sites.** Neither SB 79 ("sites within", § 65912.161) nor § 65913.4(a)(6)(D) ("located on a site that is … within") says how to treat a site only partly inside a fire zone, so the site doesn't decide for the city. A parcel ≥ 99.5% inside counts as within. One partly inside is shown as "partly within (X%)", and the city's exclusion is marked *unconfirmed* rather than applied.

**Streamlining.** § 65913.4(a)(6)(D) excludes sites in a VHFHSZ *or the State Responsibility Area*, but "does not apply to sites that have adopted fire hazard mitigation measures pursuant to existing building standards or state fire mitigation measures applicable to the development" (Pub. Resources Code §§ 4290–4291, Gov. Code § 51182, Building Code ch. 7A). The text is in [`data/statute/GOV-65913.4.txt`](data/statute/GOV-65913.4.txt).

## Site exclusions — § 65913.4(a)(6)

Each report checks the eleven site exclusions of Gov. Code § 65913.4(a)(6)(A)–(K), each against the map of the agency the statute names or the closest authoritative one ([`src/lib/exclusions.js`](src/lib/exclusions.js)).

**Which laws apply them.**
- **SB 79:** only if the project uses streamlined ministerial approval. § 65912.159(a)(3) requires such projects to "comply with all other requirements of Section 65913.4". A project reviewed through the city's ordinary process (§ 65912.159(b)) is not subject to them.
- **AB 2011:** both paths, "exclusive of clause (iv) of subparagraph (A)" (§§ 65912.111(e), 65912.121(g)).

| | Exclusion | Source | How it's decided |
|---|---|---|---|
| (A) | Coastal zone (appeal area, uncertified LCP, 5 ft sea-level rise, not zoned multifamily, near wetlands/prime ag) | Coastal Commission boundary and LCP segments | Outside the zone: ✓. Inside: clause (ii) is decided from the LCP's certification; the other clauses are flagged ? |
| (B) | Prime farmland / farmland of statewide importance | DOC Farmland Mapping and Monitoring Program | ✓ / ✗ (? if partly covered) |
| (C) | Wetlands | USFWS National Wetlands Inventory | ? if mapped; ○ if not, since the legal test is the USFWS definition, not the map |
| (D) | Very high fire hazard zone or State Responsibility Area | State Fire Marshal | ✓, or ? because of the fire-mitigation exception |
| (E) | Hazardous waste site (Cortese list, H&S Code § 25356) | DTSC EnviroStor | ? if a site is on the parcel; ○ otherwise, since the Water Board's GeoTracker part of the Cortese list has no public map service |
| (F) | Earthquake fault zone | California Geological Survey (Alquist-Priolo) | ✓, or ? because of the seismic-code exception |
| (G) | 100-year flood zone | FEMA National Flood Hazard Layer | ✓, or ? (Letter of Map Revision / NFIP criteria exception) |
| (H) | Regulatory floodway | FEMA National Flood Hazard Layer | ✓, or ? (no-rise certification exception) |
| (I) | Lands identified for conservation in an NCCP, HCP, or other plan | CDFW plan boundaries | ? inside a plan area (only its reserve lands are excluded); ○ otherwise |
| (J) | Protected-species habitat | USFWS designated critical habitat | ? if mapped; ○ otherwise (the legal test is broader than critical habitat) |
| (K) | Conservation easement | DOC agricultural conservation easements | ✗ / ? if mapped; ○ otherwise (easements are recorded with the county; check a title report) |

Marks: ✓ not excluded, per the map the statute names · ○ nothing on the agency's map, but the map isn't conclusive · ? a mapped constraint that an exception or a site-specific fact decides · ✗ excluded. `tests/exclusions.test.mjs` checks each check against the text of its subparagraph and checks which laws apply them.

## Which rules govern a parcel

From [HCD's SB 79 page](https://www.hcd.ca.gov/planning-and-research/sb79-tod), "TOD Project Compliance":

1. **TOD Alternative Plan**: governs only if **HCD has approved it** (Gov. Code § 65912.161(d)).
2. **Implementing, exemption, or temporary-exclusion ordinance**: governs **unless HCD has found it out of compliance**. This is HCD's position. Under § 65912.160(d)(5)–(6) the city may instead amend the ordinance or re-enact it with findings, and HCD may then notify the Attorney General. If HCD issues no findings within 90 days (120 with an extension), the ordinance is deemed compliant for penalty purposes (§ 65912.160(d)(3)).
3. **Otherwise**: § 65912.157 governs.
4. **Unincorporated areas**: SB 79 does not apply until the county's 7th-cycle housing element is due.

The site implements these rules in [`src/lib/policy.js`](src/lib/policy.js). If a city has an ordinance in force but has not published which parcels it covers, the site says so instead of guessing.

## The jurisdiction registry, and keeping it current

[`data/jurisdictions.json`](data/jurisdictions.json) lists local SB 79 instruments and HCD's review of each. **It uses first-hand sources only**: HCD's own letters, the jurisdiction's adopted ordinance or official page, or the jurisdiction's own GIS layer. Every document cited was read for the registry, and `npm test` rejects entries without primary documents, entries citing news or law-firm sites, and any HCD status not backed by HCD's letter.

Each entry records:
- the instrument type, local adoption status, date, and link
- HCD's status (`compliant`, `noncompliant`, `pending`, `unknown`, …), with the letter date, link, and any conditions
- coverage: `jurisdiction-wide`, `unknown`, `arcgis` (a live city layer showing which parcels are covered, and why), or `criteria` (a statutory criterion computed live, e.g. San Diego O-22099 § 4's very high FHSZ phase-in)
- `documents`: the primary sources
- `verification`: `primary` means every document was read; `located` means a cited primary document exists but couldn't be downloaded by script and should be confirmed by hand

As of the last review: San Francisco, San Jose, Beverly Hills, San Diego and Oakland are `primary`. Los Angeles is `located`: HCD's letter and the City's GIS layer were read, but the City Clerk's server won't serve Ordinance No. 188968 to scripts.

Jurisdictions reported elsewhere to have instruments or HCD letters (Pasadena, Burlingame, Oceanside, Glendale, Santa Monica, South Pasadena, Culver City, Palo Alto) are **left out** until their primary documents are obtained. HCD posts its letters only through a [Power BI dashboard](https://www.hcd.ca.gov/hau/enforcement-letters) that can't be read by script, so new letters must be added by hand.

**Daily monitoring** ([`.github/workflows/monitor.yml`](.github/workflows/monitor.yml)) does three things:

- `npm run check:sources` verifies every endpoint and every mapped field. If one breaks, it opens a `source-health` issue.
- `python3 scripts/statute.py` re-reads §§ 65912.155–65912.162 and §§ 65912.100–65912.140 from the leginfo export, along with the sections they cite (§ 65913.4, §§ 51178–51179, § 65583.2, Pub. Res. Code § 4102). If any section was amended, it opens a `statute-watch` issue.
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

## AB 2011 (preview branch)

Each parcel report also checks **AB 2011**, the Affordable Housing and High Road Jobs Act (Gov. Code §§ 65912.100–65912.140, as amended by AB 2243 and AB 893). It covers both paths: 100% affordable (§ 65912.111) and mixed-income (§ 65912.121). Each requirement is marked:

The report shows SB 79 and AB 2011 on separate tabs.

| Mark | Meaning |
|---|---|
| ✓ / ✗ | Decided from authoritative data |
| ? | Depends on facts no public layer holds; confirm with the city |
| ○ | Nothing on the agency's map, but the map isn't conclusive |
| – | Not evaluated (the source didn't answer) |

What it computes:
- **Commercial corridor (§ 65912.101(c), § 65912.121(c)).** The right-of-way is measured property line to property line from the county assessor's parcels: perpendicular to each street frontage, sampled every 10 ft, ignoring samples near corners ([`src/lib/row.js`](src/lib/row.js)). Per HCD's draft AB 2011 guidelines (May 5, 2026), a site qualifies if any portion of the right-of-way fronting it is 70–150 ft wide. At least two adjacent samples must be in range, and the frontage must be at least 50 ft. Measured frontages are drawn on the map, green where they qualify.
- **Not a freeway (§ 65912.101(g); Veh. Code § 332).** Uses Caltrans's Public Road Functional Classification. Class 1 (Interstate) is a freeway. Class 2 ("other freeway or expressway") is flagged to confirm, since expressways aren't freeways. Caltrans publishes no live layer of access control; its State Highway Network lines carry only route type.
- **Urbanized area (§ 65912.121(b)).** Uses Census Bureau 2020 Urban Areas (TIGERweb).
- **Zoning: office, retail, or parking principally permitted (§§ 65912.111(a), 65912.121(a); § 65912.101(u)).** From each city's own zoning layer, queried live, with rules in [`data/zoning.json`](data/zoning.json) that map zone codes (or the city's own zone categories) to a class, cited to the zoning code. Covered so far (46 jurisdictions, listed in `data/zoning.json`): Los Angeles, Long Beach, Glendale, Pasadena, Santa Monica, Beverly Hills, West Hollywood, Pomona, Glendora, Redondo Beach, Whittier, Downey, Gardena, Monterey Park, Malibu, Avalon, Industry; San Diego, Chula Vista, Oceanside, Escondido, Encinitas, San Marcos, La Mesa, Poway; San José, Santa Clara, Sunnyvale, Mountain View, Campbell, Los Gatos; Oakland, Fremont, Hayward, Alameda, San Leandro, Emeryville; San Francisco; South San Francisco; Sacramento, Elk Grove, Rancho Cordova; and unincorporated Los Angeles, San Diego, Santa Clara, and San Mateo counties. Layers last edited before 2023, which may predate the 2023–24 housing-element rezonings, are not used. Only a jurisdiction’s own current zoning layer is used; regional compilations (MTC/ABAG, SCAG) are not, because they lag local zoning. Where a city’s layer isn’t wired in yet, the test is shown as not evaluated. Each result shows the date the agency last updated its layer. Commercial, office, parking, and commercial mixed-use zones meet the test. Residential, open-space, and agricultural zones fail it. Residential mixed-use, industrial, public, and planned districts are flagged with the reason, as are Los Angeles [Q] conditions and split-zoned parcels.
- **Neighbouring uses (§§ 65912.111(c)–(d), 65912.121(e)–(f)).** From the county assessor's use on each parcel record (Los Angeles and Sacramento counties, which publish readable use descriptions; [`src/lib/landuse.js`](src/lib/landuse.js)). The site's perimeter is walked every 5 ft and each stretch matched to the parcel touching it or straight across the street. The report gives the share adjoining urban uses (§ 65912.101(x)) and lists any industrial or utility use on or next to the site.
- **Existing housing (§ 65912.121(h)(4)–(6)).** The assessor's use and unit count: one to four units fails; five or more is flagged for the tenancy rules; a mobilehome park fails.
- **Site size (§ 65912.121(d)).**
- **Site exclusions (§§ 65912.111(e), 65912.121(g)).** All of § 65913.4(a)(6) except clause (A)(iv), from the same checks as the Site exclusions card (see above).
- **Density and height (§ 65912.123).** Shown from the measured corridor width and whether the parcel is within ½ mile of an SB 79 TOD stop. Every TOD stop is a major transit stop (§ 65912.156(p)).

`tests/ab2011.test.mjs` checks every AB 2011 figure against the statute text.

## Previews, merging, and undoing

- **The live site is always the `main` branch.** Nothing on another branch changes it.
- **Work in progress lives on its own branch** and is published as a preview next to the live site. For example, `claude/ab2011` appears at `https://samalcorn3.github.io/SB-79-parcels/preview/ab2011/`. Branches to preview are listed in `PREVIEW_BRANCHES` in [`.github/workflows/pages.yml`](.github/workflows/pages.yml).
- **To adopt a branch:** open a pull request from it into `main` and merge it.
- **To drop a branch:** close its pull request, or never open one. The live site is unaffected.
- **To undo something already merged:** open the merged pull request on GitHub and click **Revert**. GitHub creates a new pull request that reverses it; merge that. Nothing is lost, since every past version stays in the history.

## Known limitations

- **Not a zoning determination.** Confirm with the local planning department.
- **SANDAG's map is a draft.** It also has no 200-ft layer, so San Diego adjacency is computed live from SANDAG's stop points.
- **SACOG's zone layer has no tier field.** All SACOG stops are treated as Tier 2, since SacRT is light rail per HCD's March 2026 advisory and the region has no heavy rail.
- **SCAG commuter-rail zones** follow HCD's advisory method, which counts all services at a station. They are flagged in the report.
- **Setbacks and lot coverage.** SB 79 sets no numeric values for these. Local objective standards apply as long as they don't physically preclude the SB 79 density and FAR. The report shows local zoning where a county or city publishes it (San Francisco, Sacramento County, City of San Diego, and unincorporated LA County).
- **Partial registry.** Most cities have not published parcel-level exclusion layers. See [docs/METHODOLOGY.md](docs/METHODOLOGY.md).

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
