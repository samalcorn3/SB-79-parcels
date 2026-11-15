// Minimal Socrata (SODA 2.1) client for geometry queries, used for DataSF parcels.
import { getJSON } from './arcgis.js';

function wktPolygonFromBBox([minX, minY, maxX, maxY]) {
  return `POLYGON((${minX} ${minY}, ${maxX} ${minY}, ${maxX} ${maxY}, ${minX} ${maxY}, ${minX} ${minY}))`;
}

function toFeatures(rows, geometryField) {
  return rows
    .filter((r) => r[geometryField])
    .map((r) => {
      const { [geometryField]: geometry, ...properties } = r;
      return { type: 'Feature', geometry, properties };
    });
}

export async function socrataAtPoint(cfg, [lon, lat]) {
  const where = [`intersects(${cfg.geometryField}, 'POINT(${lon} ${lat})')`, cfg.where].filter(Boolean).join(' AND ');
  const rows = await getJSON(cfg.url, { $where: where, $limit: 5 });
  return toFeatures(rows, cfg.geometryField);
}

export async function socrataInBBox(cfg, bbox, { maxFeatures = 4000 } = {}) {
  const where = [`intersects(${cfg.geometryField}, '${wktPolygonFromBBox(bbox)}')`, cfg.where].filter(Boolean).join(' AND ');
  const rows = await getJSON(cfg.url, { $where: where, $limit: maxFeatures });
  return { features: toFeatures(rows, cfg.geometryField), truncated: rows.length >= maxFeatures };
}
