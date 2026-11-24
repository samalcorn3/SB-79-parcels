# Handoff notes (for the next Claude session)

Last updated 2026-11-24 (second session). Read this first, then README.md and docs/METHODOLOGY.md.

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
  - Sacramento County's server returns 403.
- Don't scrape HCD's Power BI dashboard.
- Don't put model names in commits or PRs.

## Where things live

| Topic | Files |
|---|---|
| SB 79 | `data/sources.json` (MPOs, county parcels, boundaries, fire); `data/standards.json`; `data/jurisdictions.json` (first-hand registry of ordinances, TODAPs, HCD letters); `src/lib/{lookup,policy,standards,zones,fire}.js` |
| Site exclusions, § 65913.4(a)(6) | `src/lib/exclusions.js`; `sources.json` → `siteExclusions`. Applies to SB 79 streamlined approval, and to AB 2011 except clause (A)(iv). |
| AB 2011 | `src/lib/ab2011.js`; `src/lib/row.js` (right-of-way width from parcels); Caltrans functional class; Census urban areas |
| Zoning | `data/zoning.json` (56 sources, plus rules per jurisdiction and shared description rules); `src/lib/zoning.js`; `scripts/check-zoning.mjs` (daily newer-layer watch; `reviewedAlternatives` records reviewed non-replacements) |
| Assessor land use (75% urban perimeter, industrial neighbours, 1–4 units) | `src/lib/landuse.js`; `sources.json` → `counties[].parcels.landUse`. Los Angeles and Sacramento counties only, since San Diego and Alameda publish numeric codes with no legend. |
| UI | `src/ui/{app,report,maplayers}.js`, `assets/app.css` |
| Tests | `npm test` (56 pass); `scripts/browser-smoke.mjs` (Playwright; set `SMOKE_BASE=<url>` to test the published preview); `scripts/check-sources.mjs` |

In this cloud environment, Node scripts need `NODE_USE_ENV_PROXY=1`. Network hosts are allow-listed in the environment settings, so add a host before querying a new city server.

## Open work

1. **Add zoning for remaining cities.**
   - Added 2026-11-24 (second session): Livermore, Pleasanton, Dublin, Milpitas, Cupertino, Palo Alto, Daly City, West Covina, El Cajon, Vista.
   - None found yet (searched ArcGIS Online by extent and by name, and the cities' own servers): Santa Clarita, Lancaster, Inglewood (only a 2022 layer), Hawthorne, Compton, Carson, Alhambra, Norwalk, Berkeley, Redwood City, Carlsbad, National City, Folsom, El Monte (its layer holds only the downtown SP-4 area), and unincorporated Alameda County. Lancaster's server (maps.cityoflancasterca.org) and Folsom's (gis.folsom.ca.us) have no public zoning service; Redwood City's (webgis.redwoodcity.org) did not answer.
   - Excluded as stale: Menlo Park, City of San Mateo, Foster City, Irwindale, Palmdale (its parcel zoning attributes were last updated in 2018), Inglewood (2022).
   - Excluded as incomplete: **Torrance.** Its AGOL layer (`Zoning/FeatureServer/20`, edited Oct. 2026) has no H-DA1 district and labels Del Amo Fashion Center and the offices beside it R3, where city filings place them in H-DA1 of the Hawthorne Boulevard Corridor Specific Plan. Its code is readable at www.codepublishing.com (§ 91.3.2 lists the districts; H- codes are HBCSP subdistricts, Art. 45; P-1 is parking by CUP, § 91.35.1). Add Torrance once the city publishes a complete layer.
   - Unusable: Burbank (Cloudflare), Sacramento County (403), Culver City (download only), Citrus Heights (layer looks incomplete).
   - **Code text.** municode, ecode360, amlegal, berkeley.municipal.codes and the Livermore and El Cajon sites all return Cloudflare bot challenges, so they are not read (standing rule). codepublishing.com still serves plain pages but now redirects most cities to ecode360. Where the code can't be read, rules use the city's own zone descriptions from its layer (`generic: true`) and cite the code by title; `codeUrl` links to the official code where known.
   - Data notes: West Covina's parcel layer leaves about 1% of parcels (the Downtown Plan area and the Plaza West Covina mall) without a 2024 zone, and shows those as not evaluated; its code and description fields sometimes disagree, so its rules key on the code. Vista's and Dublin's layers publish no edit date (read live from the cities' own servers, like Glendale and Santa Monica).
   - Method:
     - Search ArcGIS Online by city extent and by city name (`"<city>" zoning`, `title:zoning "<city>"`), and keep only layers from the city's own organisation (check the owner's other items) or the city's own host. Check a CA state-plane or WGS84 extent: Lancaster, Norwalk and Dublin searches return same-named cities in other states.
     - Read the city's web maps (`/sharing/rest/content/items/<id>/data`) to find which service its zoning map uses.
     - Check the edit date (2023 or later), inspect the codes, and **spot-check well-known sites** (a regional mall, city hall, a downtown block) against the layer before adding it; that is how Torrance's gap was found.
     - Write rules citing the city code; run the scratch classifier (every distinct zone) and `ZONING_ONLY=<ids> npm run check:zoning`.
   - Orange County cities aren't done; SB 79 is pending there.
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
