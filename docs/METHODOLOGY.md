# Methodology

## 1. Locating the parcel

1. **Address → point.** Addresses are geocoded with Esri's World Geocoding Service, restricted to California. Map clicks skip this step.
2. **Point → county.** The point is intersected with CDT's California county boundaries. If the county is not in `data/sources.json`, the lookup stops and says so.
3. **Point → parcel.** The point is intersected with that county's parcel service. Where several parcels stack (condos, multi-level parcels), the largest parcel with an APN is used.
4. **Parcel → jurisdiction.** An interior point of the parcel (`turf.pointOnFeature`) is intersected with CDT's city boundaries. No match means the parcel is in an unincorporated area.

## 2. TOD zone

SB 79 measures distance "in a straight line from the nearest edge of the parcel… to a pedestrian access point" (Gov. Code § 65912.157(b)). A parcel is therefore in a zone exactly when its polygon **intersects** the MPO's buffer polygon. The lookup sends the parcel polygon to each MPO zone layer as a server-side `esriSpatialRelIntersects` query. The MPO's own server answers the question.

| MPO | Zone attributes | Adjacency (200 ft) |
|---|---|---|
| SCAG | `TIER`, `BUFFER` (200 Feet / 0.25 Miles / 0.5 Miles); "(Commuter Rail)" variants flagged | Published |
| MTC | `zone_label` ("Tier 1 - 200ft", "… Quarter Mile", "… Half Mile") | Published |
| SANDAG (draft) | Separate ¼- and ½-mile layers with a `Tier` field | **Computed:** a 200-ft distance query against SANDAG's stop points |
| SACOG | `buff_dist` (0.0378788 mi = 200 ft, 0.25, 0.5); no tier field | Published; every stop treated as Tier 2 |

A parcel can sit in several zones at once, such as Tier 2 adjacent and Tier 1 ¼ mile. The report lists them all. Each standard (height, density, FAR) is shown as the most permissive value among the applicable zones, along with the zone it came from.

If a city's population is known to be under 35,000, the ¼–½ mile band is removed (§ 65912.157(a)). SCAG's map already applies this rule. CDT's population field is often empty, so the rule rarely fires on its own.

### Map view

At zoom 17 and above, the map loads parcels in view from each county service. It classifies them in the browser against the same MPO zone polygons, which are fetched at full precision and clipped to the view. You can download the parcels in view as GeoJSON or CSV.

## 3. Local instruments and HCD

Each instrument in `data/jurisdictions.json` is evaluated with HCD's rules:

- `todap`: in force only if `local.status` is enacted or adopted **and** `hcd.status == compliant`.
- `exclusion-ordinance` / `implementing-ordinance`: in force if enacted or adopted **and** `hcd.status != noncompliant`.

Coverage is then checked:

- `jurisdiction-wide`: covers every parcel in the city.
- `arcgis`: the parcel's interior point is queried live against the city's published layer. San Francisco's exclusion layer gives the reason (`Exclusions_June122026`). The Los Angeles layer gives exemption and phasing flags, with field definitions taken from the layer's own aliases.
- `unknown`: the city has an instrument in force but no queryable parcel list. The report says "applies unless the parcel is on the city's exclusion list."

Precedence: an in-force ordinance that covers the parcel → **excluded**. Otherwise, an in-force TODAP that covers it → **TODAP**. Otherwise, an in-force ordinance with unknown coverage → **statute unless excluded**. Otherwise → **statute**.

## 3a. Fire hazard severity zones

Sources: CAL FIRE — Office of the State Fire Marshal, `FHSZLRA25_v1_All` (Local Responsibility Area, map of March 24, 2025, all phases; `FHSZ = 3` is Very High) and `FHSZSRA_23_3` (State Responsibility Area; every polygon is SRA land). The statute's criterion (§ 65912.161(b)(1)(D)) is "very high fire hazard severity zone … or within the state responsibility area", so either qualifies.

For each parcel, the overlapping fire polygons are fetched and the intersected area is computed in the browser. Overlaps under 1 m² are ignored, so lot lines that coincide with zone boundaries don't count. A registry instrument with `coverage.type = "criteria"` and `criteria: ["fire-hazard"]` covers any qualifying parcel. If the ordinance also has criteria that can't be computed (historic resources, low-resource areas), a non-fire parcel is reported as "unconfirmed" rather than "not covered".

## 3b. Site exclusions (§ 65913.4(a)(6))

All eleven checks run in parallel after the SB 79 report renders, each with a 15-second limit, so a slow agency server shows as "not evaluated" instead of holding up the page. Each layer is queried with the parcel polygon. Two queries per polygon layer tell "whole parcel inside" (`esriSpatialRelWithin`) from "partly inside" (`esriSpatialRelIntersects`). The statute doesn't say how a partly covered site is treated, so partial coverage is never marked ✗.

- **Farmland:** the Department of Conservation publishes each biennial survey as a separate service (`CaliforniaImportantFarmland_YYYY`). The newest year is read from the server's folder listing at query time, so a new survey is used as soon as it's published. `polygon_ty` P = Prime, S = Statewide Importance.
- **Coastal zone:** the Coastal Commission's digital boundary represents its adopted 1977 maps, which remain the legal boundary. Clause (A)(ii) is decided from the Commission's LCP segments: a certified LCP (`LCPCert` or `Effec_Cert` = Y) or a certified Land Use Plan (`LUPDate` set) means it doesn't apply. Areas of deferred certification and federal or tribal land are flagged ?.
- **Wetlands:** USFWS's own National Wetlands Inventory server only. Its firewall rejects some automated clients; if it doesn't answer, the check is shown as not evaluated rather than filled from a copy.
- **Hazardous sites:** DTSC's EnviroStor cleanup sites and hazardous waste facilities whose location point falls on the parcel. Points are approximate. EnviroStor is only part of the Cortese list; GeoTracker leaking-tank sites and Water Board orders have no public map service.

## 3c. AB 2011: zoning and neighbouring uses

**Zoning.** `src/lib/zoning.js` picks the city's own layer from the index in `data/zoning.json`, then the county's for unincorporated land, and fetches only that jurisdiction's file (`data/zoning/<id>.json`). Regional compilations are never used. It queries with the parcel shrunk by 1.5 m, so slivers along a shared boundary don't count as a second zone, and falls back to an interior point if a server refuses the shape. Each zone is classified by the first matching rule. A rule matches either the zone code or, where the city publishes one (Los Angeles), the city's own zone category. Statutory test: "principally permitted" means the use may occupy more than one-third of the floor area without a conditional use permit, and parking counts even with one (§ 65912.101(u)).

**Neighbouring uses.** `src/lib/landuse.js` classifies each parcel from the county assessor's record. Los Angeles County gives use descriptions, dwelling units, and improvement value (no improvements = vacant). Sacramento County gives general and specific land use. It then walks the subject's perimeter in 5-ft steps. A point 3 ft outside each step that falls in a parcel is a touching neighbour. Otherwise a ray perpendicular to the edge finds the first parcel across the street, within 250 ft. Vacant, unclassified, and unmatched stretches are reported as undetermined. The 75% test is met if urban uses reach 75%, fails if they can't even counting undetermined stretches, and is flagged otherwise. San Diego and Alameda counties publish only numeric use codes without a legend, so those tests stay unflagged there.

## 4. Sources for the legal rules

**Development standards and project requirements** come from the statute: Gov. Code §§ 65912.155–65912.162, current text, read from the Legislative Counsel's leginfo database export (`downloads.leginfo.legislature.ca.gov/pubinfo_2025.zip`, `LAW_SECTION_TBL`). The copy in `data/statute/` records each section's history line. § 65912.157 reads "Amended … by Stats. 2026, Ch. 100, Sec. 2 (SB 722), effective July 16, 2026". A diff against SB 79's chaptered text (`BILL_VERSION_TBL`, version `20250SB7984CHP`) shows the only substantive change is new paragraph (h)(3).

How the statute is applied:
- **Adjacency.** "Adjacent" means within 200 ft of a pedestrian access point (§ 65912.156(a)). Subdivision (e) adds +20 ft, +40 du/ac, and +1 FAR "prior to the application of Section 65915." Every adjacent parcel is within ¼ mile, so the intensifier is added to the tier's ¼-mile standards, (a)(3) or (a)(5).
- **FAR.** The statute bars local standards that "would physically preclude achieving a residential floor area ratio of up to" the figure. FAR is net habitable residential square footage divided by lot area (§ 65912.156(i), (l)).
- **Lot figures.** Minimum units = max(5, ⌈30 du/ac × acres⌉). Maximum units = ⌊density × acres⌋. Lot area is computed from the parcel polygon.

**Which instrument governs**:
- **TOD Alternative Plans**: the statute requires HCD approval, § 65912.161(d).
- **Ordinances**: HCD's SB 79 page holds that an ordinance it finds out of compliance stops governing. The statutory process is § 65912.160(d)(3)–(6): a 90-day review, deemed compliant for penalty purposes if HCD is silent, and amend, re-enact with findings, or Attorney General referral.

**HCD guidance** (advisory) is used for definitions the statute leaves open, such as "pedestrian access point" and how to count commuter-rail frequency. These are the definitions the MPOs used to build their maps:
- HCD, *SB 79 Advisory Clarifications on Definitions for MPOs* (Mar. 20, 2026).
- HCD, Letter of Technical Assistance to the City of Los Angeles (June 22, 2026).
- HCD, City of San Francisco Enacted SB 79 Ordinance Review Letter (July 1, 2026).
- SCAG, SB 79 TOD Map FAQs (Aug. 2026).

## 5. Freshness

Each report states which publisher's server answered and when. `npm run check:sources` prints each layer's `lastEditDate`. As of 2026-11-15:

| Layer | Last edited |
|---|---|
| LA County parcels | 2026-11-12 |
| San Diego parcels | 2026-11-03 |
| Alameda parcels | 2026-11-01 |
| Santa Clara parcels | 2026-10-14 |
| MTC zones | 2026-06-02 |
| SANDAG draft zones | 2026-07-09 |
| San Mateo parcels | **2022-08-29** |
