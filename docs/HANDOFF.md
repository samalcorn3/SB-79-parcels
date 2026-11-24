# Handoff notes (for the next Claude session)

Last updated 2026-11-24 (third session). Read this first, then README.md and docs/METHODOLOGY.md.

## Repository and branches

- `main` — the live site, https://samalcorn3.github.io/SB-79-parcels/. GitHub Pages deploys it on every push (`.github/workflows/pages.yml`: separate build and deploy jobs with one retry, a fix for GitHub's "No artifacts named github-pages" race).
- `claude/sb79-tod-gis-map-suvz1y` — SB 79 work branch. Fully merged into `main` (PRs #8, #9).
- `claude/ab2011` — **all current work**: AB 2011, site exclusions, zoning, land use, the SB 79 / AB 2011 tabs, and the zoning watch. **Not merged into `main`.** Previewed at https://samalcorn3.github.io/SB-79-parcels/preview/ab2011/ (pages.yml on `main` publishes `PREVIEW_BRANCHES`; `preview-trigger.yml` on the branch redeploys on push).
- The user is not experienced with GitHub. Give compare links (e.g. https://github.com/samalcorn3/SB-79-parcels/compare/main...claude/ab2011) and plain instructions. Don't open PRs unless asked. They merge themselves.
- The daily monitor (`monitor.yml`) runs from `main` only. The new zoning watch runs only after `claude/ab2011` is merged.

## The user's standing requirements

- **Primary, authoritative, current sources only.**
  - No regional compilations (SCAG, MTC/ABAG zoning were removed for this reason).
  - No republished copies (CDFW's copy of the USFWS wetlands map was removed).
  - No third-party sites.
  - Zoning layers last edited before 2023 are excluded, since they may predate the 2023–24 housing-element rezonings.
- **Live data, never snapshots.** Every lookup queries the agency's server.
- **Statute text from leginfo, not HCD guidance.** Use the bulk export via `scripts/statute.py`, since leginfo's website blocks automated requests.
- **Fire zones from the State Fire Marshal.** Overlap of 99.5% or more counts as "within"; partial overlap is "unconfirmed", because the statute has no partial-overlap rule.
- **SB 79 and AB 2011 kept clearly separate in the UI** (tabs).
- **Prefer decided answers over "check it yourself".** Where data can't decide a test, say exactly why.

## Things not to do

- Don't bypass bot protection or spoof user agents. Earlier attempts were refused. Leave these sources out instead:
  - Burbank's and leginfo's sites are behind Cloudflare.
  - Sacramento County's own server returns 403 (its zoning is now read from the county's ArcGIS Online organisation instead).
- Don't scrape HCD's Power BI dashboard.
- Don't put model names in commits or PRs.

## Where things live

| Topic | Files |
|---|---|
| SB 79 | `data/sources.json` (MPOs, county parcels, boundaries, fire); `data/standards.json`; `data/jurisdictions.json` (first-hand registry of ordinances, TODAPs, HCD letters); `src/lib/{lookup,policy,standards,zones,fire}.js` |
| Site exclusions, § 65913.4(a)(6) | `src/lib/exclusions.js`; `sources.json` → `siteExclusions`. Applies to SB 79 streamlined approval, and to AB 2011 except clause (A)(iv). |
| AB 2011 | `src/lib/ab2011.js`; `src/lib/row.js` (right-of-way width from parcels); Caltrans functional class; Census urban areas |
| Zoning | `data/zoning/<id>.json` (one file per jurisdiction: layer, fields, rules); `data/zoning.json` (shared classes and description rules, plus the index built by `npm run zoning:index`; 108 jurisdictions); `scripts/zoning-classify.mjs`; `scripts/zoning-discovery/`; `src/lib/zoning.js`; `scripts/check-zoning.mjs` (daily newer-layer watch; `reviewedAlternatives` records reviewed non-replacements) |
| Assessor land use (75% urban perimeter, industrial neighbours, 1–4 units) | `src/lib/landuse.js`; `sources.json` → `counties[].parcels.landUse`. Los Angeles and Sacramento counties only, since San Diego and Alameda publish numeric codes with no legend. |
| UI | `src/ui/{app,report,maplayers}.js`, `assets/app.css` |
| Tests | `npm test` (57 pass); `scripts/browser-smoke.mjs` (Playwright; set `SMOKE_BASE=<url>` to test the published preview); `scripts/check-sources.mjs` |

In this cloud environment, Node scripts need `NODE_USE_ENV_PROXY=1`. Network hosts are allow-listed in the environment settings, so add a host before querying a new city server.

## Open work

1. **Zoning for the eight SB 79 counties (user's priority: finish these before going statewide).**
   - The user wants AB 2011 eventually statewide (the statute is not limited to SB 79 counties), but asked to finish the eight counties first, and to keep the site fast by loading only the zoning needed. Zoning is now one file per jurisdiction (`data/zoning/<id>.json`), fetched only when a parcel there is looked up.
   - Coverage: 102 of 197 cities, plus unincorporated Los Angeles, Orange, Sacramento, San Diego, San Mateo and Santa Clara counties (108 files).

     | County | Cities covered | Still missing |
     |---|---|---|
     | Los Angeles County | 36 of 88 | Alhambra, Arcadia, Azusa, Baldwin Park, Bell Gardens, Bellflower, Bradbury, Calabasas, Carson, Cerritos, Claremont, Commerce, Compton, Cudahy, Duarte, El Monte, Hawaiian Gardens, Hawthorne, Hidden Hills, Huntington Park, Irwindale, La Cañada Flintridge, La Habra Heights, La Mirada, La Puente, La Verne, Lawndale, Lomita, Lynwood, Maywood, Monrovia, Montebello, Norwalk, Palmdale, Palos Verdes Estates, Paramount, Rancho Palos Verdes, Rolling Hills, Rolling Hills Estates, Rosemead, San Dimas, San Fernando, San Gabriel, San Marino, Santa Clarita, Sierra Madre, South El Monte, South Gate, South Pasadena, Torrance, Vernon, Walnut |
     | Orange County | 14 of 34 | Brea, Costa Mesa, Cypress, Fountain Valley, Fullerton, Garden Grove, La Habra, La Palma, Laguna Beach, Laguna Hills, Laguna Niguel, Laguna Woods, Los Alamitos, Mission Viejo, Santa Ana, Stanton, Tustin, Villa Park, Westminster, Yorba Linda |
     | San Diego County | 16 of 18 | Del Mar, Imperial Beach |
     | Sacramento County | 4 of 7 | Folsom, Galt, Isleton |
     | Alameda County | 10 of 14 | Albany, Berkeley, Newark, Piedmont |
     | San Francisco County | 1 of 1 | — |
     | San Mateo County | 11 of 20 | Burlingame, Colma, Half Moon Bay, Hillsborough, Menlo Park, Millbrae, Pacifica, Redwood City, San Carlos |
     | Santa Clara County | 10 of 15 | Gilroy, Los Altos Hills, Monte Sereno, Morgan Hill, Saratoga |

   - Why the rest are missing (searched by name, extent and the cities' map apps on ArcGIS Online, plus web searches for city servers):
     - **No public layer found:** most of the list above, including Santa Clarita, Garden Grove, Mission Viejo, Westminster, Berkeley, Redwood City, Compton, Carson, South Gate, Hawthorne, Alhambra, Gilroy, Morgan Hill and Folsom. Garden Grove has a custom data portal (ggcity.org/maps); Berkeley publishes GIS through its open data portal (not found as a service); Santa Clarita's GIS group can be emailed.
     - **Stale (data last edited before 2023):** Arcadia (2013), Azusa (2022), Fullerton (city server, updated 2014), Laguna Beach (2019), Menlo Park (2018 AGOL; its city server's Zoning service exposes no layers), Monrovia (2018), Palmdale (2018 attributes), Tustin (2022), unincorporated Orange County's AGOL layer (2021; the county's LMS layer is used instead).
     - **Incomplete or not zoning:** Torrance (no H-DA1 district; Del Amo Fashion Center shows as R3 — city filings put it in H-DA1 of the Hawthorne Boulevard Corridor Specific Plan; code readable at www.codepublishing.com, § 91.3.2, Art. 45), Yorba Linda (city server layer has six zone types), El Monte (downtown only), Lynwood (its "Zoning District" layer carries only a 2006 general plan field), Norwalk (parcel layer without zoning), Irwindale (SCAG regional data re-hosted).
     - **Not public:** Stanton (token required). **Draft only:** Santa Ana (consultant's final draft), unincorporated Alameda County.
     - **Third-party hosted, so not used:** Costa Mesa (Dudek), Newport Beach's consultant copy (the city's own server is used), Santa Ana parcels (Houseal Lavigne), Laguna Niguel (Economics Inc.), Placentia's PlaceWorks copy (the city's own layer is used), student copies (Gilroy, San Fernando and others).
   - **Code text.** municode, ecode360, amlegal and berkeley.municipal.codes return Cloudflare bot challenges, so they are not read (standing rule); those hosts were removed from the environment allowlist. codepublishing.com still serves plain pages (Torrance, Covina) but now redirects most cities to ecode360. Where the code can't be read, rules use the city's own zone descriptions from its layer (`generic: true`) and cite the code by title; `codeUrl` links to the official code where known. Where a layer's code and description fields disagree (West Covina, Culver City, Hermosa Beach, Lancaster), rules key on the code (`generic: false`).
   - Data notes: West Covina's parcel layer leaves about 1% of parcels without a 2024 zone. Layers with no edit date are read live from the city's own server (Vista, Dublin, Belmont, Los Altos, Newport Beach, Carlsbad, Foster City, Lancaster, unincorporated Orange County). Carlsbad, Foster City and Lancaster are reached through ArcGIS Online proxy URLs (`utility.arcgis.com/usrsvcs/...`); if a city rotates its proxy, `check:sources` will flag it.
   - Method (tools in the repo):
     - `python3 -I scripts/zoning-discovery/by-name.py "<City>"`, then `by-extent.py` and `by-app.py` for cities the first pass misses. Keep only layers from the city's own organisation (check the owner's other items, e.g. `/sharing/rest/search?q=owner:<name>`) or the city's own host. Watch for same-named places elsewhere (Lancaster OH, Norwalk IA and CT, Dublin OH, Albany Australia): check the extent's spatial reference.
     - `python3 -I scripts/zoning-discovery/profile.py <layer url>` lists the zoning fields and values.
     - Check the edit date (2023 or later) and count blank zones. **Spot-check landmarks** (a regional mall, city hall, a downtown block) with a point query; that is how Torrance's gap was found.
     - Write `data/zoning/<id>.json`, run `npm run zoning:classify -- <id>` (every distinct zone under the rules), `npm run zoning:index`, `npm test`, and `ZONING_ONLY=<id> npm run check:zoning`. A city server must send `Access-Control-Allow-Origin` for the site's origin (check with `curl -H "Origin: https://samalcorn3.github.io"`).
     - New city hosts must be added to the environment allowlist first; the allowlist appears to have a size limit, so remove unused hosts when adding.
2. **User actions pending:** merge `claude/ab2011` into `main` when satisfied.
3. **Registry follow-ups needing first-hand documents:**
   - HCD letters for Pasadena, Burlingame, Oceanside, Glendale, Santa Monica, South Pasadena, Culver City, and Palo Alto.
   - Confirm LA Ordinance 188968.
   - Beverly Hills' status after July 2026.
4. **AB 2011 items still "confirm":**
   - Historic registers.
   - Neighborhood/specific plans: could use city specific-plan layers.
   - Tribal consultation.
   - Pre-2022 general plan industrial designation.
5. **Gaps elsewhere:**
   - Sea-level-rise clause (A)(iii) isn't mapped (NOAA layer unsuitable).
   - Water Board GeoTracker sites aren't checked: no public map service.
