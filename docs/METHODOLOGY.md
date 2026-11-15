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

## 4. Sources for the legal rules

- HCD, *SB 79 Advisory Clarifications on Definitions for MPOs* (Mar. 20, 2026). Covers definitions, rail typologies, urban transit counties, and unincorporated areas.
- HCD, Letter of Technical Assistance to the City of Los Angeles (June 22, 2026). Covers the standards table, exclusion criteria, TODAP rules, and the Q&A on zoning, partial parcels, and setbacks.
- HCD, City of San Francisco Enacted SB 79 Ordinance Review Letter (July 1, 2026).
- HCD SB 79 page, "TOD Project Compliance."
- SCAG, SB 79 TOD Map FAQs (Aug. 2026). Covers pedestrian access points, the population rule, and Orange County status.

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
