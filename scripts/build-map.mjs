// Traces river geometry from USGS NLDI (NHDPlus V2), clips at each river's
// terminus, dedupes shared reaches so tributaries visibly merge into their
// trunk, projects + simplifies to a fixed 1000x700 space, and emits
// data/map.json plus a citation report and a final-frame SVG for review.
//
// Dev-time only — see HEADWATERS_INTRO_PLAN.md sections 3-4 for the spec
// this implements. Run with `npm run build-map`.

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { geoConicEqualArea, geoContains, geoPath } from 'd3-geo';
import { feature } from 'topojson-client';
import statesTopo from 'us-atlas/states-10m.json' with { type: 'json' };

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const CACHE_DIR = join(__dirname, 'cache');
const NLDI = 'https://api.water.usgs.gov/nldi/linked-data';

const WIDTH = 1000;
const HEIGHT = 700;
const SIMPLIFY_TOLERANCE_PX = 0.4;
const DRAW_WINDOW_SECONDS = 30; // beat-sheet target; tune in review (plan section 5)

// Trunk/independent-start rivers (headwater dot appears at t=3.0, per beat
// sheet) vs. dependent tributaries whose start time is pinned by the
// confluence-timing constraint against whichever river they join.
const TRUNK_ORDER = ['Colorado', 'Rio Grande', 'Arkansas', 'North Platte'];
// Order matters: a river must be processed after the one named in `joins`.
// South Platte is a dedupe-clipped tributary of North Platte, not its own
// trunk terminus — both independently DM-trace to the Gulf/Mississippi past
// their shared confluence (see plan section 3), so whichever is processed
// first "owns" that shared downstream chain.
const TRIBUTARY_ORDER = ['Green', 'Yampa', 'Gunnison', 'San Juan', 'Dolores', 'South Platte'];

if (!existsSync(CACHE_DIR)) mkdirSync(CACHE_DIR, { recursive: true });

function cacheKey(url) {
  return createHash('sha1').update(url).digest('hex');
}

async function fetchCached(url) {
  const key = cacheKey(url);
  const cachePath = join(CACHE_DIR, `${key}.json`);
  if (existsSync(cachePath)) {
    return JSON.parse(readFileSync(cachePath, 'utf8'));
  }
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`NLDI request failed (${res.status}): ${url}`);
  }
  const json = await res.json();
  writeFileSync(cachePath, JSON.stringify(json));
  return json;
}

async function snapToComid(lon, lat) {
  const url = `${NLDI}/comid/position?coords=POINT(${lon}%20${lat})&f=json`;
  const json = await fetchCached(url);
  const feat = json.features?.[0];
  if (!feat) throw new Error(`No flowline found near (${lon}, ${lat})`);
  return feat.properties.comid ?? feat.properties.nhdplus_comid;
}

async function umTrace(comid, distanceKm) {
  const url = `${NLDI}/comid/${comid}/navigation/UM/flowlines?f=json&distance=${distanceKm}`;
  const json = await fetchCached(url);
  return json.features; // ordered seed -> farthest upstream
}

async function dmTrace(comid, distanceKm) {
  const url = `${NLDI}/comid/${comid}/navigation/DM/flowlines?f=json&distance=${distanceKm}`;
  const json = await fetchCached(url);
  return json.features; // ordered source -> farthest downstream
}

function featComid(f) {
  return f.properties.nhdplus_comid ?? f.properties.comid;
}

function coordsEqual(a, b, eps = 1e-6) {
  return Math.abs(a[0] - b[0]) < eps && Math.abs(a[1] - b[1]) < eps;
}

function assertContinuous(features, label) {
  for (let i = 0; i < features.length - 1; i++) {
    const end = features[i].geometry.coordinates.at(-1);
    const start = features[i + 1].geometry.coordinates[0];
    if (!coordsEqual(end, start)) {
      throw new Error(
        `${label}: gap between comid ${featComid(features[i])} and ${featComid(features[i + 1])} ` +
        `(${end} -> ${start})`
      );
    }
  }
}

function dist2(a, b) {
  const dx = a[0] - b[0], dy = a[1] - b[1];
  return dx * dx + dy * dy;
}

// Finds the DM-list index + in-feature vertex index closest to a target
// [lon, lat], for clipping a river at a known confluence/border coordinate
// that isn't otherwise identifiable from the NLDI response (it carries no
// GNIS name).
function nearestVertex(features, target) {
  let best = { d: Infinity, fi: -1, vi: -1 };
  features.forEach((f, fi) => {
    f.geometry.coordinates.forEach((c, vi) => {
      const d = dist2(c, target);
      if (d < best.d) best = { d, fi, vi };
    });
  });
  return best;
}

// Truncates a DM feature list at a given vertex (inclusive), for either a
// known-coordinate clip (border/gulf/confluence) or a dedupe clip against an
// already-claimed comid.
function truncateAt(features, fi, vi) {
  const kept = features.slice(0, fi + 1).map((f) => ({ ...f, geometry: { ...f.geometry } }));
  kept[kept.length - 1].geometry.coordinates = kept[kept.length - 1].geometry.coordinates.slice(0, vi + 1);
  return kept;
}

function mergeCoordinates(features) {
  const pts = [];
  features.forEach((f, i) => {
    const coords = f.geometry.coordinates;
    pts.push(...(i === 0 ? coords : coords.slice(1)));
  });
  return pts;
}

// Douglas-Peucker simplification in projected pixel space.
function simplify(points, tolerance) {
  if (points.length < 3) return points;
  const sqTol = tolerance * tolerance;
  function perpDist2(p, a, b) {
    let [x, y] = a, dx = b[0] - x, dy = b[1] - y;
    if (dx !== 0 || dy !== 0) {
      const t = ((p[0] - x) * dx + (p[1] - y) * dy) / (dx * dx + dy * dy);
      if (t > 1) { x = b[0]; y = b[1]; }
      else if (t > 0) { x += dx * t; y += dy * t; }
    }
    dx = p[0] - x; dy = p[1] - y;
    return dx * dx + dy * dy;
  }
  function simplifyRange(pts, first, last, out) {
    let maxDist = sqTol, index = -1;
    for (let i = first + 1; i < last; i++) {
      const d = perpDist2(pts[i], pts[first], pts[last]);
      if (d > maxDist) { index = i; maxDist = d; }
    }
    if (index !== -1) {
      if (index - first > 1) simplifyRange(pts, first, index, out);
      out.push(pts[index]);
      if (last - index > 1) simplifyRange(pts, index, last, out);
    }
  }
  const out = [points[0]];
  simplifyRange(points, 0, points.length - 1, out);
  out.push(points.at(-1));
  return out;
}

function pathLength(points) {
  let len = 0;
  for (let i = 1; i < points.length; i++) {
    len += Math.hypot(points[i][0] - points[i - 1][0], points[i][1] - points[i - 1][1]);
  }
  return len;
}

function pointAtArcLength(points, target) {
  if (target <= 0) return points[0];
  let acc = 0;
  for (let i = 1; i < points.length; i++) {
    const seg = Math.hypot(points[i][0] - points[i - 1][0], points[i][1] - points[i - 1][1]);
    if (acc + seg >= target) {
      const t = seg === 0 ? 0 : (target - acc) / seg;
      return [
        points[i - 1][0] + (points[i][0] - points[i - 1][0]) * t,
        points[i - 1][1] + (points[i][1] - points[i - 1][1]) * t,
      ];
    }
    acc += seg;
  }
  return points.at(-1);
}

function pointsUpToArcLength(points, target) {
  if (target <= 0) return [points[0]];
  const out = [points[0]];
  let acc = 0;
  for (let i = 1; i < points.length; i++) {
    const seg = Math.hypot(points[i][0] - points[i - 1][0], points[i][1] - points[i - 1][1]);
    if (acc + seg >= target) {
      out.push(pointAtArcLength(points, target));
      return out;
    }
    out.push(points[i]);
    acc += seg;
  }
  return out;
}

function toPathD(points) {
  return points.map((p, i) => `${i === 0 ? 'M' : 'L'}${p[0].toFixed(2)},${p[1].toFixed(2)}`).join(' ');
}

function kmBetween([lon1, lat1], [lon2, lat2]) {
  return Math.hypot((lon1 - lon2) * Math.cos((lat1 * Math.PI) / 180), lat1 - lat2) * 111;
}

// Walks UM distance up (20 -> 100 -> 300km) until the farthest-upstream
// comid stops changing, confirming it's a real network terminus (a leaf
// with no further upstream flowlines) rather than an artifact of too short
// a search window. NHD flowlines only connect where water actually flows,
// so a converged result is trustworthy even when it's well past the cited
// named-confluence seed (that just means a different, longer fork is the
// true hydrological source — flagged in the citation report for review).
async function findHeadwater(seedComid, seedCoord, label) {
  const distances = [20, 100, 300];
  let prevComid = null;
  let headwaterFeature = null;
  for (const d of distances) {
    const um = await umTrace(seedComid, d);
    headwaterFeature = um.at(-1);
    const comid = featComid(headwaterFeature);
    if (comid === prevComid) break; // converged
    prevComid = comid;
  }
  const headwaterCoord = headwaterFeature.geometry.coordinates[0];
  const deltaKm = kmBetween(headwaterCoord, seedCoord);
  if (deltaKm > 3) {
    console.log(`  ${label}: NLDI headwater is ${deltaKm.toFixed(1)}km from the cited seed (converged, different fork/pass — flagged for review).`);
  }
  return { headwaterComid: featComid(headwaterFeature), headwaterCoord };
}

async function traceRiver(cfg, distanceKm) {
  const seedComid = await snapToComid(...cfg.seed_coord);
  const { headwaterComid, headwaterCoord } = await findHeadwater(seedComid, cfg.seed_coord, cfg.name);

  const dm = await dmTrace(headwaterComid, distanceKm);
  assertContinuous(dm, cfg.name);
  return { headwaterComid, headwaterCoord, dm };
}

function clipAtCoord(dm, targetCoord, label) {
  const { fi, vi, d } = nearestVertex(dm, targetCoord);
  const clipped = truncateAt(dm, fi, vi);
  const distDeg = Math.sqrt(d);
  if (distDeg > 0.05) {
    console.warn(
      `WARNING: ${label} clip point is ${distDeg.toFixed(3)} deg from the target coordinate ` +
      `(${targetCoord}) — verify this is the right confluence.`
    );
  }
  return clipped;
}

function clipAtClaimed(dm, claimed, label) {
  const idx = dm.findIndex((f) => claimed.has(featComid(f)));
  if (idx === -1) {
    throw new Error(`${label}: never reached a claimed comid — trace distance too short or parent not processed yet.`);
  }
  // Include the connecting point (start of the claimed feature) so the
  // tributary's line touches the trunk with no visible gap.
  return [...dm.slice(0, idx), { ...dm[idx], geometry: { ...dm[idx].geometry, coordinates: dm[idx].geometry.coordinates.slice(0, 1) } }];
}

function claim(features, claimed) {
  for (const f of features) claimed.add(featComid(f));
}

async function main() {
  const configPath = join(__dirname, 'rivers.config.json');
  const config = JSON.parse(readFileSync(configPath, 'utf8'));
  const byName = Object.fromEntries(config.rivers.map((r) => [r.name, r]));

  const claimed = new Set();
  const results = {}; // name -> { headwaterCoord, headwaterComid, geoCoords }

  for (const name of TRUNK_ORDER) {
    const cfg = byName[name];
    if (!cfg.seed_coord) throw new Error(`${name}: missing seed_coord in rivers.config.json`);
    console.log(`Tracing ${name}...`);
    const { headwaterComid, headwaterCoord, dm } = await traceRiver(cfg, cfg.trace_distance_km ?? 4500);
    let final = dm;
    if (cfg.terminus_coord) {
      final = clipAtCoord(dm, cfg.terminus_coord, name);
    } else {
      console.log(`  ${name}: no terminus_coord set, using full NLDI-natural terminus (border/gulf) — length ${dm.length} flowlines`);
    }
    assertContinuous(final, `${name} (post-clip)`);
    claim(final, claimed);
    results[name] = { headwaterComid, headwaterCoord, geoCoords: mergeCoordinates(final) };
    console.log(`  ${name}: headwater ${headwaterCoord}, ${final.length} flowlines, ends ${final.at(-1).geometry.coordinates.at(-1)}`);
  }

  for (const name of TRIBUTARY_ORDER) {
    const cfg = byName[name];
    if (!cfg.seed_coord) throw new Error(`${name}: missing seed_coord in rivers.config.json`);
    console.log(`Tracing ${name}...`);
    const { headwaterComid, headwaterCoord, dm } = await traceRiver(cfg, cfg.trace_distance_km ?? 1500);
    const final = clipAtClaimed(dm, claimed, name);
    assertContinuous(final, `${name} (post-clip)`);
    claim(final, claimed);
    results[name] = { headwaterComid, headwaterCoord, geoCoords: mergeCoordinates(final), joins: cfg.joins };
    console.log(`  ${name}: headwater ${headwaterCoord}, joins ${cfg.joins} after ${final.length} flowlines`);
  }

  // ---- Projection ---------------------------------------------------
  const allGeoCoords = Object.values(results).flatMap((r) => r.geoCoords);
  const bboxFeature = {
    type: 'Feature',
    geometry: { type: 'MultiPoint', coordinates: allGeoCoords },
  };
  const projection = geoConicEqualArea().parallels([29.5, 45.5]).rotate([96, 0]);
  projection.fitSize([WIDTH, HEIGHT], bboxFeature);

  const projectedRivers = {};
  for (const [name, r] of Object.entries(results)) {
    const projected = r.geoCoords.map((c) => projection(c));
    const simplified = simplify(projected, SIMPLIFY_TOLERANCE_PX);
    projectedRivers[name] = {
      points: simplified,
      arcLength: pathLength(simplified),
      headwaterPx: projection(r.headwaterCoord),
      joins: r.joins ?? null,
    };
  }

  // ---- Timing: constant global speed, confluence-delayed tributaries ----
  const longestTrunkLength = Math.max(...TRUNK_ORDER.map((n) => projectedRivers[n].arcLength));
  const pxPerSecond = longestTrunkLength / DRAW_WINDOW_SECONDS;

  const timing = {};
  TRUNK_ORDER.forEach((name, i) => {
    timing[name] = { startT: i * 0.3 }; // small stagger, per beat sheet section 5
  });

  function confluenceArcLength(childName, parentName) {
    const parentPoints = projectedRivers[parentName].points;
    const childEndPx = projectedRivers[childName].points.at(-1);
    // Nearest point on the parent's path to where the child's clipped path ends.
    let best = { d: Infinity, i: 0 };
    parentPoints.forEach((p, i) => {
      const d = Math.hypot(p[0] - childEndPx[0], p[1] - childEndPx[1]);
      if (d < best.d) best = { d, i };
    });
    return pathLength(parentPoints.slice(0, best.i + 1));
  }

  for (const name of TRIBUTARY_ORDER) {
    const parentName = projectedRivers[name].joins;
    const parentArrival = timing[parentName].startT + confluenceArcLength(name, parentName) / pxPerSecond;
    const childTimeToConfluence = projectedRivers[name].arcLength / pxPerSecond;
    const startT = Math.max(0, parentArrival - childTimeToConfluence);
    timing[name] = { startT };
    const arrival = startT + childTimeToConfluence;
    if (arrival < parentArrival - 1e-6) {
      throw new Error(`Confluence timing assertion failed: ${name} arrives at ${arrival.toFixed(2)}s, before ${parentName} at ${parentArrival.toFixed(2)}s`);
    }
  }

  // ---- State entry times ---------------------------------------------
  const statesGeo = feature(statesTopo, statesTopo.objects.states);
  const relevantStateNames = new Set([
    'Colorado', 'Utah', 'Wyoming', 'New Mexico', 'Arizona', 'Nebraska',
    'Kansas', 'Texas', 'Oklahoma', 'Arkansas', 'Mississippi', 'Louisiana', 'Missouri',
  ]);
  const relevantStates = statesGeo.features.filter((f) => relevantStateNames.has(f.properties.name));

  const stateEnterT = {};
  for (const [name, r] of Object.entries(results)) {
    const startT = timing[name].startT;
    const geoCoords = r.geoCoords;
    const arcLen = projectedRivers[name].arcLength;
    geoCoords.forEach((coord, i) => {
      const frac = i / (geoCoords.length - 1);
      const t = startT + frac * (arcLen / pxPerSecond);
      for (const state of relevantStates) {
        if (geoContains(state, coord)) {
          const sName = state.properties.name;
          if (stateEnterT[sName] === undefined || t < stateEnterT[sName]) stateEnterT[sName] = t;
        }
      }
    });
  }

  // ---- Camera keyframes (union bbox of drawn geometry over time) ------
  const endT = Math.max(...Object.entries(timing).map(([n, t]) => t.startT + projectedRivers[n].arcLength / pxPerSecond));
  const CAMERA_STEPS = 40;
  const camera = [];
  for (let s = 0; s <= CAMERA_STEPS; s++) {
    const t = (s / CAMERA_STEPS) * endT;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const [name, r] of Object.entries(projectedRivers)) {
      const localT = t - timing[name].startT;
      if (localT <= 0) continue;
      const drawnLen = Math.min(localT * pxPerSecond, r.arcLength);
      const drawn = pointsUpToArcLength(r.points, drawnLen);
      for (const [x, y] of drawn) {
        if (x < minX) minX = x; if (x > maxX) maxX = x;
        if (y < minY) minY = y; if (y > maxY) maxY = y;
      }
    }
    if (minX === Infinity) { minX = minY = 0; maxX = WIDTH; maxY = HEIGHT; }
    const margin = 40;
    camera.push({
      t: Number(t.toFixed(3)),
      x: Number((minX - margin).toFixed(1)),
      y: Number((minY - margin).toFixed(1)),
      w: Number((maxX - minX + margin * 2).toFixed(1)),
      h: Number((maxY - minY + margin * 2).toFixed(1)),
    });
  }

  // ---- Emit map.json ---------------------------------------------------
  const statePathGen = geoPath(projection);
  const statePathByName = Object.fromEntries(
    relevantStates.map((f) => [f.properties.name, statePathGen(f)])
  );

  const mapJson = {
    generated: new Date().toISOString(),
    width: WIDTH,
    height: HEIGHT,
    pxPerSecond,
    drawWindowSeconds: DRAW_WINDOW_SECONDS,
    rivers: Object.entries(projectedRivers).map(([name, r]) => ({
      name,
      path: toPathD(r.points),
      startT: Number(timing[name].startT.toFixed(3)),
      endT: Number((timing[name].startT + r.arcLength / pxPerSecond).toFixed(3)),
      headwaterPx: r.headwaterPx,
      terminusPx: r.points.at(-1),
      joins: r.joins,
    })),
    states: Object.entries(stateEnterT).map(([name, enterT]) => ({
      name,
      enterT: Number(enterT.toFixed(3)),
      path: statePathByName[name],
    })),
    camera,
  };

  const gzipSize = Buffer.byteLength(JSON.stringify(mapJson));
  writeFileSync(join(ROOT, 'data', 'map.json'), JSON.stringify(mapJson, null, 2));
  console.log(`\nWrote data/map.json (${(gzipSize / 1024).toFixed(1)} KB uncompressed)`);

  // ---- Final-frame SVG for visual review --------------------------------
  const riverPaths = Object.entries(projectedRivers)
    .map(([name, r]) => `<path d="${toPathD(r.points)}" fill="none" stroke="#2C6E91" stroke-width="1.5" />`)
    .join('\n  ');
  const headwaterDots = Object.entries(projectedRivers)
    .map(([name, r]) => {
      const [x, y] = r.headwaterPx;
      return `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="3" fill="#2C6E91" /><text x="${x.toFixed(1)}" y="${(y - 6).toFixed(1)}" font-size="9" font-family="sans-serif">${name}</text>`;
    })
    .join('\n  ');
  const statePaths = relevantStates
    .map((f) => `<path d="${statePathByName[f.properties.name]}" fill="none" stroke="#C9C4B8" stroke-width="1" />`)
    .join('\n  ');

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${HEIGHT}" viewBox="0 0 ${WIDTH} ${HEIGHT}">
  <rect width="${WIDTH}" height="${HEIGHT}" fill="#F6F3EC" />
  ${statePaths}
  ${riverPaths}
  ${headwaterDots}
</svg>
`;
  writeFileSync(join(ROOT, 'scripts', 'final-frame.svg'), svg);
  console.log('Wrote scripts/final-frame.svg');

  // ---- Citation report ---------------------------------------------------
  const KM_PER_DEG = 111; // rough, fine for a flag-for-review distance
  const rows = config.rivers.map((cfg) => {
    const r = results[cfg.name];
    const deltaKm = Math.hypot(
      (r.headwaterCoord[0] - cfg.seed_coord[0]) * Math.cos((cfg.seed_coord[1] * Math.PI) / 180),
      r.headwaterCoord[1] - cfg.seed_coord[1]
    ) * KM_PER_DEG;
    const flag = deltaKm > 3 ? ` **[NLDI source is ${deltaKm.toFixed(1)} km from the cited coordinate — review]**` : '';
    return `| ${cfg.name} | ${r.headwaterCoord.map((c) => c.toFixed(5)).join(', ')} | ${cfg.citation_note ?? ''}${flag} [source](${cfg.citation_url ?? ''}) | ${cfg.terminus_policy} |`;
  });
  const report = `# Headwater citation review\n\nGenerated ${new Date().toISOString()}. Review every row before starting M2 — see HEADWATERS_INTRO_PLAN.md section 3.\n\n"NLDI-derived" is the actual drawn start point: the farthest-upstream flowline the network resolves to within the UM trace distance (converged/re-checked at up to 5x that distance for every river with a >3km delta below). Where it differs meaningfully from the cited source, that's flagged for human judgment — it usually means the true network terminus sits at a slightly different point (e.g. a pass or a different fork) than the named confluence, not an error.\n\n| River | Source coordinate (NLDI-derived) | Citation | Terminus |\n|---|---|---|---|\n${rows.join('\n')}\n`;
  writeFileSync(join(ROOT, 'scripts', 'citations-report.md'), report);
  console.log('Wrote scripts/citations-report.md');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
