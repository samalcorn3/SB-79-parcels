// AB 2011 — Affordable Housing and High Road Jobs Act of 2022
// (Gov. Code §§ 65912.100–65912.140, as amended by AB 2243 (2024) and AB 893 (2025)).
// Current text: data/statute/65912.1*.txt.
//
// Two paths:
//   Article 2 (§ 65912.111): 100% affordable projects — no corridor requirement.
//   Article 3 (§ 65912.121): mixed-income projects — must abut a commercial
//     corridor (70–150 ft right-of-way, not a freeway) with ≥ 50 ft of frontage.
//
// Each criterion is reported with a status:
//   'meets' | 'fails'     decided from authoritative data
//   'confirm'             depends on facts no authoritative layer holds (zoning
//                         permissions, building use, tenancy, historic register…)
//   'none-mapped'         the agency's map shows nothing, but the statutory test is
//                         broader than the map (see exclusions.js)
//   'not-evaluated'       the source could not be queried
import * as turf from '@turf/turf';
import { queryIntersecting, toEsriGeometry, getJSON } from './arcgis.js';
import { measureFrontages, corridorTest } from './row.js';
import { parcelsInBBox } from './parcels.js';
import { getField } from './spec.js';

export const AB2011 = {
  corridor: { minFt: 70, maxFt: 150, minFrontageFt: 50, wideFt: 100, cite: '§ 65912.101(c); § 65912.121(c)(1)' },
  maxAcres: 20,
  maxAcresRegionalMall: 100,
  freewayBufferFt: 500,
  // § 65912.123(b)(1) metropolitan jurisdictions / (b)(2) other jurisdictions, du/ac
  density: {
    metropolitan: { smallSite: 30, narrowCorridor: 40, wideCorridor: 60, transitOrCampus: 80, cite: '§ 65912.123(b)(1)' },
    other: { smallSite: 20, narrowCorridor: 30, wideCorridor: 50, transitOrCampus: 70, cite: '§ 65912.123(b)(2)' },
  },
  // § 65912.123(c), feet
  height: { narrowCorridor: 35, wideCorridor: 45, transit: 65, transitMinCityPop: 100000, cite: '§ 65912.123(c)' },
};

const C = (id, cite, text, status, detail) => ({ id, cite, text, status, detail });

/** Caltrans federal functional class (F_System) of roads near a point: 1 Interstate, 2 other freeway/expressway, 3+ not a freeway. */
async function roadClassesNear(sources, [lon, lat], radiusFt) {
  const rows = await queryIntersecting(sources.caltrans.functionalClass.url, toEsriGeometry({ type: 'Point', coordinates: [lon, lat] }), {
    outFields: ['RouteID', 'F_System'],
    distanceFeet: radiusFt,
  });
  return rows.map((r) => ({ route: getField(r, 'RouteID'), fSystem: Number(getField(r, 'F_System')) }));
}

/** Is the street a frontage faces a freeway (§ 65912.101(g); Veh. Code § 332)? Checked at the street's centreline. */
async function frontageFreeway(sources, frontage) {
  const mid = frontage.samples[Math.floor(frontage.samples.length / 2)];
  if (!mid || !frontage.widthFt) return { status: 'unknown' };
  // Step half the measured right-of-way outward from the frontage to the street's centreline.
  const half = frontage.widthFt.median / 2;
  const rad = (frontage.facing * Math.PI) / 180;
  const dLat = (half * Math.cos(rad)) / 364000;
  const dLon = (half * Math.sin(rad)) / (364000 * Math.cos((mid.at[1] * Math.PI) / 180));
  const centre = [mid.at[0] + dLon, mid.at[1] + dLat];
  const roads = await roadClassesNear(sources, centre, Math.max(25, half));
  if (!roads.length) return { status: 'unknown', roads };
  const min = Math.min(...roads.map((r) => r.fSystem));
  return { status: min === 1 ? 'freeway' : min === 2 ? 'freeway-or-expressway' : 'not-freeway', roads, fSystem: min };
}

async function urbanArea(sources, point) {
  const u = sources.census.urbanAreas;
  const rows = await queryIntersecting(u.url, toEsriGeometry({ type: 'Point', coordinates: point }), { outFields: ['NAME', 'GEOID'] });
  return rows[0] ? getField(rows[0], 'NAME') : null;
}

async function cityInUrbanArea(sources, cityName) {
  const b = sources.boundaries.cities;
  const json = await getJSON(`${b.url}/query`, {
    where: `${b.fields.name} = '${cityName.replace(/'/g, "''")}'`, returnGeometry: true, outSR: 4326, f: 'geojson', maxAllowableOffset: 0.0005,
  });
  const city = json.features?.[0];
  if (!city) return null;
  const u = sources.census.urbanAreas;
  const rows = await queryIntersecting(u.url, toEsriGeometry(city.geometry), { outFields: ['NAME'] });
  return rows.length ? getField(rows[0], 'NAME') : false;
}

/**
 * Evaluate AB 2011 for a parcel already resolved by the SB 79 lookup.
 * @param data  { sources }
 * @param ctx   { parcel (GeoJSON Feature), county (config), city ({name, population}|null), zones (SB 79 zones), zoning, lotSqFt,
 *               exclusions (exclusionsFor('ab2011', …) items, or null) }
 */
export async function ab2011ForParcel(data, ctx) {
  const { sources } = data;
  const { parcel, county, city, zones, zoning, lotSqFt, exclusions } = ctx;
  const errors = [];
  const soft = (label, p) => p.catch((e) => {
    errors.push(`${label}: ${e.message}`);
    return null;
  });

  // Parcels around the site, for frontage measurement and neighbour uses.
  const [x0, y0, x1, y1] = turf.bbox(parcel);
  const pad = 0.00075; // ~270 ft: corridors are at most 150 ft wide; rays stop at 250 ft
  const around = await soft('Neighbouring parcels', parcelsInBBox(county, [x0 - pad, y0 - pad, x1 + pad, y1 + pad], { maxFeatures: 3000 }));
  const neighbours = around?.features || [];
  const frontages = neighbours.length ? measureFrontages(parcel, neighbours) : [];
  await Promise.all(frontages.map(async (f) => {
    f.test = corridorTest(f, { min: AB2011.corridor.minFt, max: AB2011.corridor.maxFt, minFrontageFt: AB2011.corridor.minFrontageFt });
    f.freeway = f.test.rowInRange ? await soft('Caltrans road class', frontageFreeway(sources, f)) : null;
  }));

  const interior = turf.pointOnFeature(parcel).geometry.coordinates;
  const ua = await soft('Census urban areas', urbanArea(sources, interior));
  const [cityUa, nearFreeway] = await Promise.all([
    // If the parcel itself is in an urban area, its city's boundaries necessarily include part of one.
    city ? (ua ? Promise.resolve(ua) : soft('Census urban areas', cityInUrbanArea(sources, city.name))) : null,
    soft('Caltrans road class', (async () => {
      const rows = await queryIntersecting(sources.caltrans.functionalClass.url, toEsriGeometry(parcel.geometry), {
        where: 'F_System IN (1, 2)', outFields: ['RouteID', 'F_System'], distanceFeet: AB2011.freewayBufferFt,
      });
      return rows.map((r) => Number(getField(r, 'F_System')));
    })()),
  ]);

  const acres = lotSqFt / 43560;
  const corridorFrontages = frontages.filter((f) => f.test?.qualifies && f.freeway?.status !== 'freeway');
  const firm = corridorFrontages.filter((f) => f.freeway?.status === 'not-freeway');
  const width = corridorFrontages.length ? Math.max(...corridorFrontages.map((f) => f.widthFt.median)) : null;

  // ---- criteria shared by both paths ----
  const zoneText = zoning?.code ? `Local zone: ${zoning.code}${zoning.description ? ` (${zoning.description})` : ''}.` : 'This jurisdiction does not publish parcel zoning as a queryable layer.';
  const shared = [
    C('zoning', '§ 65912.111(a); § 65912.121(a)', 'In a zone where office, retail, or parking is a principally permitted use', 'confirm',
      `${zoneText} Whether office, retail, or parking is principally permitted (may occupy more than one-third of the square footage without a conditional use permit, § 65912.101(u)) depends on the local zoning code.`),
    (() => {
      if (city) {
        return cityUa
          ? C('urbanized', '§ 65912.111(b)(1); § 65912.121(b)(1)', 'City boundaries include some portion of an urbanized area', 'meets', `${ua ? `The parcel is in the ${ua}, so ${city.name}'s boundaries include part of it` : `${city.name} overlaps the ${cityUa}`} (U.S. Census Bureau 2020 Urban Areas). The statute says “urbanized area”; since 2020 the Census Bureau designates “Urban Areas”.`)
          : C('urbanized', '§ 65912.111(b)(1); § 65912.121(b)(1)', 'City boundaries include some portion of an urbanized area', cityUa === false ? 'fails' : 'not-evaluated', cityUa === false ? `${city.name} does not overlap any 2020 Census Urban Area.` : 'Census urban-area check unavailable.');
      }
      return C('urbanized', '§ 65912.111(b)(2); § 65912.121(b)(2)', 'Unincorporated parcel wholly within an urbanized area', ua ? 'confirm' : 'fails',
        ua ? `Parcel interior is in the ${ua}; confirm the whole parcel lies within it.` : 'Parcel is not in a 2020 Census Urban Area.');
    })(),
    C('urban-uses', '§ 65912.111(c); § 65912.121(e)', 'At least 75% of the site perimeter adjoins parcels developed with urban uses (parcels across a street count as adjoining)', 'confirm',
      'Requires the current use of the surrounding parcels; assessor land-use codes are not an authoritative record of use.'),
    C('industrial', '§ 65912.111(d); § 65912.121(f)', 'Not on or adjoining (including across a street) a site where more than one-third of the square footage is dedicated to industrial use', 'confirm',
      'Depends on current and most recently permitted uses and the pre-2022 general plan designation.'),
    // § 65912.111(e) / § 65912.121(g): all of § 65913.4(a)(6) except clause (A)(iv), checked map by map.
    ...(exclusions?.length
      ? exclusions.map((x) => C(`a6-${x.id}`, x.cite, x.title, x.status, x.id === 'fire' && x.status === 'confirm'
        ? `${x.detail} If the site is vacant, § 65912.111(h)(2) / § 65912.121(j)(2) bar VHFHSZ sites outright.`
        : x.detail))
      : [C('a6', '§ 65912.111(e); § 65912.121(g) → § 65913.4(a)(6)', 'Site exclusions: coastal zone, farmland, wetlands, fire, hazardous waste, fault zone, flood, conservation lands, habitat, easements', 'not-evaluated', 'Site-exclusion check unavailable.')]),
    C('historic-mobilehome', '§ 65912.111(f); § 65912.121(h)(3), (6)', 'Does not demolish a historic structure on a national, state, or local register; not a mobilehome or RV park', 'confirm', 'No statewide authoritative parcel layer.'),
    C('neighborhood-plan', '§ 65912.111(g); § 65912.121(i)', 'If in a neighborhood plan area, the plan permits multifamily housing on the site', 'confirm', 'Check for a specific, area, community, or similar plan adopted before 2024 (§ 65912.101(t)).'),
    C('tribal', '§ 65912.111(h)(1); § 65912.121(j)(1)', 'If vacant, no tribal cultural resources identified through AB 52 consultation that cannot be mitigated', 'confirm', 'Determined through consultation, not mapping.'),
  ];

  // ---- Article 3 only ----
  const corridor = (() => {
    if (!frontages.length) return C('corridor', AB2011.corridor.cite, 'Abuts a commercial corridor (right-of-way 70–150 ft, not a freeway) with ≥ 50 ft of frontage — or is in a campus development zone', 'not-evaluated', 'Could not measure the street frontage from neighbouring parcels.');
    if (firm.length) {
      const list = firm.map((f) => `${f.lengthFt} ft on a ${f.widthFt.median}-ft right-of-way (${f.widthFt.min}–${f.widthFt.max} ft)`).join('; ');
      return C('corridor', AB2011.corridor.cite, 'Abuts a commercial corridor (right-of-way 70–150 ft, not a freeway) with ≥ 50 ft of frontage', 'meets',
        `Qualifying frontage: ${list}. Widths measured property line to property line from county parcels; Caltrans classifies ${firm.length > 1 ? 'these streets' : 'the street'} as not a freeway.`);
    }
    if (corridorFrontages.length) {
      return C('corridor', AB2011.corridor.cite, 'Abuts a commercial corridor (right-of-way 70–150 ft, not a freeway) with ≥ 50 ft of frontage', 'confirm',
        `Frontage on a ${corridorFrontages[0].widthFt.median}-ft right-of-way, but Caltrans's road class there is ${corridorFrontages[0].freeway?.status === 'freeway-or-expressway' ? '“other freeway or expressway” — confirm it is not a freeway (Veh. Code § 332)' : 'not available — confirm it is not a freeway'}.`);
    }
    const desc = frontages.map((f) => (f.widthFt ? `${f.lengthFt} ft on a ${f.widthFt.median}-ft right-of-way` : `${f.lengthFt} ft (width not measurable)`)).join('; ');
    return C('corridor', AB2011.corridor.cite, 'Abuts a commercial corridor (right-of-way 70–150 ft, not a freeway) with ≥ 50 ft of frontage — or is in a campus development zone', 'fails',
      `Street frontages: ${desc}. None is 70–150 ft wide with ≥ 50 ft of frontage. (Campus development zones, § 65912.101(b), are not yet evaluated.)`);
  })();
  const size = C('size', '§ 65912.121(d)', `Site not greater than ${AB2011.maxAcres} acres (${AB2011.maxAcresRegionalMall} for a regional mall)`, acres <= AB2011.maxAcres ? 'meets' : acres <= AB2011.maxAcresRegionalMall ? 'confirm' : 'fails',
    `This parcel is ${acres.toFixed(2)} acres${acres > AB2011.maxAcres && acres <= AB2011.maxAcresRegionalMall ? ' — eligible only if the site is a regional mall (§ 65912.101(v))' : ''}. A project site combining several parcels is measured as a whole.`);
  const housing = C('existing-housing', '§ 65912.121(h)(1)–(2), (4)–(5)', 'No demolition of rent-restricted, rent-controlled, or recently tenant-occupied housing; not a property with 1–4 units; not vacant land zoned for housing but not multifamily', 'confirm',
    ctx.parcel.properties.use ? `Assessor use: ${ctx.parcel.properties.use}.` : 'Depends on current occupancy and tenancy history.');

  const statusOf = (list) => (list.some((c) => c.status === 'fails') ? 'fails' : list.every((c) => c.status === 'meets') ? 'meets' : 'confirm');
  const affordable = { title: '100% affordable (Article 2, § 65912.110–65912.114)', criteria: shared };
  const mixed = { title: 'Mixed-income (Article 3, § 65912.120–65912.124)', criteria: [corridor, size, ...shared, housing] };
  affordable.status = statusOf(affordable.criteria);
  mixed.status = statusOf(mixed.criteria);

  // ---- standards (§ 65912.123), shown when the corridor is known ----
  const coastalItem = exclusions?.find((x) => x.id === 'coastal' && x.inCoastalZone != null);
  const nearTransit = (zones || []).length > 0; // inside an SB 79 TOD zone ⇒ within ½ mile of a TOD stop, which is a major transit stop (§ 65912.156(p))
  const d = AB2011.density;
  const pick = (t) => (nearTransit ? t.transitOrCampus : acres < 1 ? t.smallSite : width != null && width >= AB2011.corridor.wideFt ? t.wideCorridor : t.narrowCorridor);
  const standards = width == null ? null : {
    corridorWidthFt: width,
    density: {
      metropolitan: pick(d.metropolitan),
      other: pick(d.other),
      basis: nearTransit ? 'within ½ mile of a major transit stop' : acres < 1 ? 'site under one acre' : `corridor ${width >= AB2011.corridor.wideFt ? '≥' : '<'} 100 ft`,
      note: 'Or the local maximum density, if greater. “Metropolitan” jurisdictions (§ 65583.2(f): in a metropolitan statistical area of 2,000,000+, unless under 25,000 residents) use the first figure; others the second. Before 2027 projects must reach 50% of it (75% near rail/BRT or in a campus zone); from 2027, 75% (§ 65912.123(b)(3)).',
      cite: '§ 65912.123(b)',
    },
    heightFt: {
      value: width >= AB2011.corridor.wideFt ? AB2011.height.wideCorridor : AB2011.height.narrowCorridor,
      transitValue: nearTransit ? AB2011.height.transit : null,
      note: nearTransit
        ? `65 ft applies instead if the city has more than 100,000 residents${city?.population ? ` (${city.name}: ${city.population.toLocaleString('en-US')})` : ''} and the site is not in the coastal zone${coastalItem ? (coastalItem.inCoastalZone ? ' (this site is in it)' : ' (this site is outside it)') : ''} (§ 65912.123(c)(4)). Or the local height limit, if greater.`
        : 'Or the local height limit, if greater.',
      cite: '§ 65912.123(c)',
    },
    freewayWithin500Ft: nearFreeway?.includes(1) ? 'yes' : nearFreeway?.includes(2) ? 'possibly' : nearFreeway ? 'no' : null,
  };

  return {
    statute: 'Gov. Code §§ 65912.100–65912.140 (AB 2011, as amended by AB 2243 and AB 893)',
    paths: { affordable, mixed },
    frontages: frontages.map((f) => ({ lengthFt: f.lengthFt, facing: f.facing, widthFt: f.widthFt, corridor: f.test, freeway: f.freeway?.status ?? null, line: f.samples.map((s) => s.at) })),
    standards,
    errors,
  };
}
