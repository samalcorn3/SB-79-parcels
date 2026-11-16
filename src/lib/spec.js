// Small declarative language for reading values out of each publisher's
// attribute schema. Keeps publisher-specific quirks in data/sources.json
// instead of in code.
//
//   { "const": 2 }                                   -> 2
//   { "field": "TIER" }                              -> attrs.TIER
//   { "field": "TIER", "regex": "(\\d)" }            -> Number(first capture)
//   { "field": "BUFFER", "map": { "200 Feet": "adjacent" } }
//        -> value whose key equals, or is contained in, attrs.BUFFER (case-insensitive)
//   { "field": "buff_dist", "numeric": [[0.04, "adjacent"], [0.26, "quarter"]] }
//        -> first label whose threshold is >= the numeric value

export function readSpec(spec, attrs = {}) {
  if (spec == null) return undefined;
  if (Object.hasOwn(spec, 'const')) return spec.const;
  const raw = getField(attrs, spec.field);
  if (raw == null || raw === '') return undefined;

  if (spec.map) {
    const s = String(raw).trim().toLowerCase();
    const entries = Object.entries(spec.map);
    const exact = entries.find(([k]) => k.toLowerCase() === s);
    if (exact) return exact[1];
    const partial = entries.find(([k]) => s.includes(k.toLowerCase()));
    return partial ? partial[1] : undefined;
  }
  if (spec.regex) {
    const m = String(raw).match(new RegExp(spec.regex, 'i'));
    if (!m) return undefined;
    const n = Number(m[1]);
    return Number.isNaN(n) ? m[1] : n;
  }
  if (spec.numeric) {
    const n = Number(raw);
    if (Number.isNaN(n)) return undefined;
    const hit = spec.numeric.find(([max]) => n <= max);
    return hit ? hit[1] : undefined;
  }
  return typeof raw === 'string' ? raw.trim() : raw;
}

// Case-insensitive field lookup: ArcGIS GeoJSON output sometimes changes case.
export function getField(attrs, field) {
  if (!field || !attrs) return undefined;
  if (Object.hasOwn(attrs, field)) return attrs[field];
  const lower = field.toLowerCase();
  const key = Object.keys(attrs).find((k) => k.toLowerCase() === lower);
  return key ? attrs[key] : undefined;
}

export function joinFields(attrs, fields = []) {
  return fields
    .map((f) => getField(attrs, f))
    .filter((v) => v != null && String(v).trim() !== '' && String(v).trim() !== '0')
    .map((v) => String(v).trim())
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
}
