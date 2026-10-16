// Dashboard shell. Reads data/sources.json, data/status.json and
// data/events.json and renders each panel from what those files actually
// contain. Nothing here invents a value: a missing file, a file that fails
// validation, or a stale poll each get an explicit state (plan 0.4, 7).
//
// The basin map panel is filled by intro.js (the intro map moves into it).

import { AXES, freshness, validateEvents, validateSources, validateStatus } from './contracts.js';

const AXIS_LABELS = { compact: 'Compact', utility: 'Utility', supply: 'Local supply' };
const EMPTY_OPEN = 'No open proceedings are being tracked yet.';

function h(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === null || v === undefined || v === false) continue;
    if (k === 'style') Object.assign(node.style, v);
    else node.setAttribute(k, v);
  }
  for (const c of children.flat()) {
    if (c === null || c === undefined || c === false) continue;
    node.append(c instanceof Node ? c : String(c));
  }
  return node;
}

const empty = (text) => h('p', { class: 'empty-state' }, text);
const warning = (code, text) => h('p', { class: 'warning', role: 'note' }, h('strong', {}, code), ' ', text);

// { state: 'ok', data } | { state: 'missing' } | { state: 'invalid', errors }
// | { state: 'unavailable', error }
async function load(url, validate) {
  let res;
  try {
    res = await fetch(url, { cache: 'no-cache' });
  } catch {
    return { state: 'unavailable', error: 'network error' };
  }
  if (res.status === 404) return { state: 'missing' };
  if (!res.ok) return { state: 'unavailable', error: `HTTP ${res.status}` };
  let json;
  try {
    json = await res.json();
  } catch {
    return { state: 'invalid', errors: ['not valid JSON'] };
  }
  const errors = validate(json);
  return errors.length ? { state: 'invalid', errors } : { state: 'ok', data: json };
}

function fileProblem(name, result) {
  if (result.state === 'invalid') {
    return warning('INVALID', `${name} failed validation (${result.errors[0]}${result.errors.length > 1 ? ` and ${result.errors.length - 1} more` : ''}); nothing from it is shown.`);
  }
  if (result.state === 'unavailable') return warning('UNAVAILABLE', `${name} could not be loaded (${result.error}).`);
  return null;
}

// Calendar dates are compared as local YYYY-MM-DD strings.
function localToday(now) {
  const d = new Date(now);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function dayNumber(iso) {
  const [y, m, d] = iso.split('-').map(Number);
  return Date.UTC(y, m - 1, d) / 86400e3;
}

function fromDayNumber(n) {
  return new Date(n * 86400e3).toISOString().slice(0, 10);
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function formatDate(iso) {
  const [y, m, d] = iso.split('-').map(Number);
  return `${MONTHS[m - 1]} ${d}, ${y}`;
}

function formatDateTime(iso) {
  const d = new Date(iso);
  return `${d.toISOString().slice(0, 10)} ${d.toISOString().slice(11, 16)} UTC`;
}

// ---- Open this week -----------------------------------------------------------

export function renderOpen(body, events, today) {
  const problem = fileProblem('events.json', events);
  if (problem) return body.replaceChildren(problem);
  if (events.state === 'missing') return body.replaceChildren(empty(EMPTY_OPEN));

  const open = events.data.events
    .filter((e) => e.comment_deadline && e.comment_deadline >= today)
    .sort((a, b) => a.comment_deadline.localeCompare(b.comment_deadline));
  if (!open.length) return body.replaceChildren(empty(EMPTY_OPEN));

  body.replaceChildren(
    h(
      'ul',
      { class: 'open-list' },
      open.map((e) => {
        const days = dayNumber(e.comment_deadline) - dayNumber(today);
        const when = days === 0 ? 'closes today' : `closes in ${days} day${days === 1 ? '' : 's'}`;
        return h(
          'li',
          {},
          h('a', { href: e.source_url }, e.title),
          h(
            'span',
            { class: 'open-meta' },
            `Comments due ${formatDate(e.comment_deadline)} (${when}) · ${AXIS_LABELS[e.axis]}`,
            e.archive_url ? [' · ', h('a', { href: e.archive_url }, 'archived copy')] : null
          )
        );
      })
    )
  );
}

// ---- Three-axes timeline ------------------------------------------------------

export function renderTimeline(body, events, today) {
  const problem = fileProblem('events.json', events);
  const list = events.state === 'ok' ? events.data.events : [];

  // Axis range: all events plus today, padded; a default window when empty.
  const todayN = dayNumber(today);
  let lo = todayN - 180;
  let hi = todayN + 60;
  if (list.length) {
    const days = list.map((e) => dayNumber(e.date)).concat(todayN);
    lo = Math.min(...days);
    hi = Math.max(...days);
    const pad = Math.max(15, (hi - lo) * 0.06);
    lo -= pad;
    hi += pad;
  }
  const x = (n) => `${(((n - lo) / (hi - lo)) * 100).toFixed(2)}%`;

  const tracks = AXES.map((axis) => {
    const items = list.filter((e) => e.axis === axis);
    return h(
      'div',
      { class: 'tl-track', 'data-axis': axis },
      h('div', { class: 'tl-label' }, AXIS_LABELS[axis]),
      h(
        'div',
        { class: 'tl-lane' },
        items.length
          ? items.map((e) => {
              const label = `${formatDate(e.date)}: ${e.title}`;
              return h('a', { class: 'tl-event', href: e.source_url, title: label, 'aria-label': label, style: { left: x(dayNumber(e.date)) } });
            })
          : h('span', { class: 'tl-empty' }, 'No records yet')
      )
    );
  });

  // Month ticks, thinned so labels don't collide.
  const months = [];
  const start = new Date(fromDayNumber(Math.ceil(lo)));
  let y = start.getUTCFullYear();
  let m = start.getUTCMonth() + (start.getUTCDate() > 1 ? 1 : 0);
  for (;;) {
    const n = Date.UTC(y + Math.floor(m / 12), m % 12, 1) / 86400e3;
    if (n > hi) break;
    months.push({ n, label: `${MONTHS[m % 12]} ${String(y + Math.floor(m / 12)).slice(2)}` });
    m++;
  }
  const stride = Math.ceil(months.length / 8) || 1;
  const ticks = months.filter((_, i) => i % stride === 0);

  const axis = h(
    'div',
    { class: 'tl-axis', 'aria-hidden': 'true' },
    h('div', {}),
    h(
      'div',
      { class: 'tl-ticks' },
      ticks.map((t, i) => h('span', { class: i % 2 ? 'tl-tick tl-tick-minor' : 'tl-tick', style: { left: x(t.n) } }, t.label)),
      h('span', { class: 'tl-today', style: { left: x(todayN) }, title: 'Today' })
    )
  );

  body.replaceChildren(...[problem, h('div', { class: 'timeline' }, tracks, axis)].filter(Boolean));
}

// ---- Sources and freshness ----------------------------------------------------

const FRESHNESS_TEXT = {
  'NOT REPORTED': () => 'status.json has no entry for this source; freshness unknown.',
  FAILED: (e) => `Last poll failed: ${e.last_error}${e.last_success ? ` (last success ${formatDateTime(e.last_success)})` : ''}.`,
  'NEVER POLLED': () => 'No successful poll on record.',
  STALE: (e) => `Last successful poll ${formatDateTime(e.last_success)}, older than twice the ${e.cadence} cadence. Treat its data as out of date.`,
};

export function renderSources(body, sources, status, now) {
  if (sources.state !== 'ok') {
    return body.replaceChildren(fileProblem('sources.json', sources) ?? warning('MISSING', 'sources.json has not been published.'));
  }
  const problem = fileProblem('status.json', status);
  const entries = status.state === 'ok' ? new Map(status.data.sources.map((s) => [s.id, s])) : null;

  const rows = sources.data.sources.map((src) => {
    let detail;
    if (!entries) {
      detail = warning(
        status.state === 'missing' ? 'NO STATUS FILE' : 'NO STATUS',
        status.state === 'missing' ? 'status.json has not been published; freshness unknown.' : 'Freshness unknown.'
      );
    } else {
      const entry = entries.get(src.id);
      const f = freshness(entry, now);
      detail =
        f.level === 'ok'
          ? h('span', { class: 'source-status' }, `Last successful poll ${formatDateTime(entry.last_success)} (${entry.cadence})`)
          : warning(f.code, FRESHNESS_TEXT[f.code](entry));
    }
    return h('li', { class: 'source-row', 'data-source': src.id }, h('span', { class: 'source-name' }, src.label), detail);
  });

  body.replaceChildren(...[problem, h('ul', { class: 'source-list' }, rows)].filter(Boolean));
}

// ---- Boot ---------------------------------------------------------------------

async function init() {
  const panel = (name) => document.querySelector(`[data-panel="${name}"]`);
  const open = panel('open');
  const timeline = panel('timeline');
  const sourcesBody = panel('sources');
  if (!open || !timeline || !sourcesBody) return;
  for (const body of [open, timeline, sourcesBody]) body.replaceChildren(empty('Loading…'));

  const [sources, status, events] = await Promise.all([
    load('data/sources.json', validateSources),
    load('data/status.json', validateStatus),
    load('data/events.json', validateEvents),
  ]);
  const now = Date.now();
  const today = localToday(now);
  renderOpen(open, events, today);
  renderTimeline(timeline, events, today);
  renderSources(sourcesBody, sources, status, now);
  document.getElementById('dashboard')?.setAttribute('data-ready', 'true');
}

init();
