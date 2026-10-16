// Validates data/copy.json and keeps the caption list in index.html in sync
// with it. Dev/CI only; the site itself has no build step.
//
//   node scripts/check-copy.mjs           validate + check index.html is in sync
//   node scripts/check-copy.mjs --write   validate + rewrite the list in index.html
//   node scripts/check-copy.mjs --ship    also fail on anything still marked
//                                         verify_before_ship, or an unapproved CTA
//
// The caption list is rendered into index.html (between the captions markers)
// rather than built at runtime so it is in the DOM from first paint, readable
// by screen readers and without JavaScript, and so intro.js has one source.
//
// Computed values ({statesCrossed}) come from data/map.json geometry here,
// never typed into copy.json (plan section 6, C3b).

import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { buildSchedule, resolveCue, CUE_EVENTS } from '../assets/captions.js';

const ROOT = resolve(import.meta.dirname, '..');
const args = new Set(process.argv.slice(2));
const WRITE = args.has('--write');
const SHIP = args.has('--ship');

const copy = JSON.parse(readFileSync(join(ROOT, 'data/copy.json'), 'utf8'));
const map = JSON.parse(readFileSync(join(ROOT, 'data/map.json'), 'utf8'));
const errors = [];
const shipBlockers = [];

// ---- Computed values ------------------------------------------------------

// A state counts as crossed when at least this many vertices of some river
// line fall inside it. 1-2 vertices is a river grazing a boundary at its
// terminus (the Arkansas touches Mississippi at its confluence), not water
// flowing through the state.
const MIN_VERTICES_IN_STATE = 3;

function points(d) {
  return [...d.matchAll(/(-?[\d.]+),(-?[\d.]+)/g)].map((m) => [Number(m[1]), Number(m[2])]);
}

function insideRings([x, y], rings) {
  let inside = false;
  for (const r of rings) {
    for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
      const [xi, yi] = r[i];
      const [xj, yj] = r[j];
      if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
    }
  }
  return inside;
}

function statesCrossed() {
  const rivers = map.rivers.map((r) => points(r.path));
  return map.states.filter((s) => {
    const rings = s.path.split('M').filter(Boolean).map(points);
    return rivers.some((pts) => pts.filter((p) => insideRings(p, rings)).length >= MIN_VERTICES_IN_STATE);
  }).length;
}

const computed = { statesCrossed: statesCrossed() };

function fill(text) {
  return text.replace(/\{(\w+)\}/g, (_, key) => {
    if (!(key in computed)) {
      errors.push(`unknown computed value {${key}}`);
      return `{${key}}`;
    }
    return String(computed[key]);
  });
}

// ---- Validation -------------------------------------------------------------

const KINDS = ['fact', 'computed', 'framing'];
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const ids = new Set();

for (const c of copy.captions) {
  const where = `caption ${c.id ?? '(no id)'}`;
  if (!c.id) errors.push(`${where}: missing id`);
  if (ids.has(c.id)) errors.push(`${where}: duplicate id`);
  ids.add(c.id);
  if (!KINDS.includes(c.kind)) errors.push(`${where}: kind must be one of ${KINDS.join(', ')}`);
  if (!c.text?.trim()) errors.push(`${where}: missing text`);
  if (!CUE_EVENTS.includes(c.cue?.event)) {
    errors.push(`${where}: cue.event must be one of ${CUE_EVENTS.join(', ')}`);
  } else {
    try {
      resolveCue(c.cue, map);
    } catch (err) {
      errors.push(`${where}: ${err.message}`);
    }
  }

  if (c.kind === 'fact') {
    if (!/^https:\/\//.test(c.source_url ?? '')) errors.push(`${where}: fact needs an https source_url`);
    if (!c.source_label) errors.push(`${where}: fact needs a source_label`);
    if (!DATE.test(c.retrieved ?? '')) errors.push(`${where}: fact needs retrieved (YYYY-MM-DD)`);
    if (c.as_of !== undefined && !DATE.test(c.as_of)) errors.push(`${where}: as_of must be YYYY-MM-DD`);
  }
  if (c.kind === 'computed') {
    if (!c.derived_from) errors.push(`${where}: computed caption needs derived_from`);
    if (!/\{\w+\}/.test(c.text ?? '')) errors.push(`${where}: computed caption has no {value} to fill`);
  }
  if (c.kind !== 'framing' && typeof c.verify_before_ship !== 'boolean') {
    errors.push(`${where}: verify_before_ship must be true or false`);
  }
  if (c.verify_before_ship) shipBlockers.push(`${c.id}: marked verify_before_ship`);
}

if (!copy.cta?.text) errors.push('cta: missing text');
if (copy.cta && copy.cta.approved !== true) shipBlockers.push('CTA: wording not approved');

// ---- Crypto vocabulary gate (plan 0.2, acceptance criteria) ----------------

const BANNED = [
  /\bblockchain\b/i,
  /\bNEAR\b/, // case-sensitive: the protocol name, not the word "near"
  /(?<!text-)\banchor(s|ed|ing)?\b/i, // SVG/CSS text-anchor is fine
  /\bon-chain\b/i,
  /\bcrypto\w*/i,
];

function shippedFiles() {
  const list = ['index.html'];
  for (const dir of ['assets', 'data']) {
    for (const f of readdirSync(join(ROOT, dir))) {
      if (/\.(html|js|css|json)$/.test(f)) list.push(`${dir}/${f}`);
    }
  }
  return list;
}

for (const file of shippedFiles()) {
  readFileSync(join(ROOT, file), 'utf8').split('\n').forEach((line, i) => {
    for (const re of BANNED) {
      if (re.test(line)) errors.push(`${file}:${i + 1}: banned vocabulary ${re} in: ${line.trim().slice(0, 100)}`);
    }
  });
}

// ---- Render the caption list into index.html --------------------------------

const MONTHS = ['Jan.', 'Feb.', 'March', 'April', 'May', 'June', 'July', 'Aug.', 'Sept.', 'Oct.', 'Nov.', 'Dec.'];

function formatAsOf(iso) {
  const [y, m, d] = iso.split('-').map(Number);
  return `As of ${MONTHS[m - 1]} ${d}, ${y}`;
}

function esc(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

const INDENT = '    ';
const listHtml = copy.captions
  .map((c) => {
    const asOf = c.as_of ? ` <small class="as-of">${esc(formatAsOf(c.as_of))}</small>` : '';
    return `${INDENT}<li data-id="${esc(c.id)}" data-cue="${esc(JSON.stringify(c.cue))}"><span class="caption-text">${esc(fill(c.text))}</span>${asOf}</li>`;
  })
  .join('\n');

const START = '<!-- captions:start (generated from data/copy.json by scripts/check-copy.mjs; do not edit) -->';
const END = '<!-- captions:end -->';
const indexPath = join(ROOT, 'index.html');
const index = readFileSync(indexPath, 'utf8');
const startAt = index.indexOf(START);
const endAt = index.indexOf(END);
if (startAt === -1 || endAt === -1) {
  errors.push('index.html: caption markers not found');
} else {
  const current = index.slice(startAt + START.length, endAt);
  const wanted = `\n${listHtml}\n${INDENT.slice(2)}`;
  if (current !== wanted) {
    if (WRITE) {
      writeFileSync(indexPath, index.slice(0, startAt + START.length) + wanted + index.slice(endAt));
      console.log('Rewrote caption list in index.html');
    } else {
      errors.push('index.html: caption list is out of date with data/copy.json (run npm run build-copy)');
    }
  }
}

// ---- Report -------------------------------------------------------------------

if (!errors.length) {
  const schedule = buildSchedule(copy.captions.map((c) => ({ ...c, text: fill(c.text) })), map);
  console.log(`statesCrossed = ${computed.statesCrossed}`);
  console.log('Caption schedule (s):');
  for (const item of schedule.items) {
    console.log(`  ${item.id.padEnd(4)} ${item.start.toFixed(1).padStart(5)} - ${item.end.toFixed(1).padStart(5)}`);
  }
  console.log(`  intro ends at ${schedule.end.toFixed(1)} s (CTA follows in M5)`);
}

if (shipBlockers.length) {
  const log = SHIP ? console.error : console.log;
  log(`${SHIP ? 'Ship blockers' : 'Open before ship'} (${shipBlockers.length}):`);
  for (const b of shipBlockers) log(`  - ${b}`);
}

if (errors.length) {
  console.error(`check-copy failed (${errors.length}):`);
  for (const e of errors) console.error(`  - ${e}`);
  process.exit(1);
}
if (SHIP && shipBlockers.length) process.exit(1);
console.log('check-copy passed');
