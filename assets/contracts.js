// Runtime checks for the watcher's data files, mirroring schema/*.schema.json
// (the site has no dependencies, so no JSON Schema library at runtime).
// scripts/check-data.mjs checks that these agree with the schemas on every
// fixture in tests/fixtures. A file that fails is shown as invalid and none
// of its values are displayed.
//
// No DOM access: Node imports this file too.

export const AXES = ['compact', 'utility', 'supply'];
export const CADENCES = ['hourly', 'daily', 'weekly'];
export const CADENCE_MS = { hourly: 3600e3, daily: 86400e3, weekly: 7 * 86400e3 };

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const DATE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/i;

function isObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

export function isDate(s) {
  if (typeof s !== 'string' || !DATE.test(s)) return false;
  const [y, m, d] = s.split('-').map(Number);
  const t = new Date(Date.UTC(y, m - 1, d));
  return t.getUTCFullYear() === y && t.getUTCMonth() === m - 1 && t.getUTCDate() === d;
}

export function isDateTime(s) {
  return typeof s === 'string' && DATE_TIME.test(s) && isDate(s.slice(0, 10)) && !Number.isNaN(Date.parse(s));
}

function isHttpsUrl(s) {
  if (typeof s !== 'string' || !s.startsWith('https://')) return false;
  try {
    new URL(s);
    return true;
  } catch {
    return false;
  }
}

function exactKeys(obj, keys, where, errors) {
  for (const k of keys) if (!(k in obj)) errors.push(`${where}: missing ${k}`);
  for (const k of Object.keys(obj)) if (!keys.includes(k)) errors.push(`${where}: unexpected ${k}`);
}

const nonEmpty = (v) => typeof v === 'string' && v.length > 0;

export function validateStatus(doc) {
  const errors = [];
  if (!isObject(doc)) return ['status: not an object'];
  exactKeys(doc, ['generated', 'sources'], 'status', errors);
  if ('generated' in doc && !isDateTime(doc.generated)) errors.push('status.generated: not an ISO-8601 date-time');
  if (!Array.isArray(doc.sources)) {
    if ('sources' in doc) errors.push('status.sources: not an array');
    return errors;
  }
  doc.sources.forEach((s, i) => {
    const where = `status.sources[${i}]`;
    if (!isObject(s)) return errors.push(`${where}: not an object`);
    exactKeys(s, ['id', 'label', 'cadence', 'last_success', 'last_error'], where, errors);
    if ('id' in s && !nonEmpty(s.id)) errors.push(`${where}.id: empty or not a string`);
    if ('label' in s && !nonEmpty(s.label)) errors.push(`${where}.label: empty or not a string`);
    if ('cadence' in s && !CADENCES.includes(s.cadence)) errors.push(`${where}.cadence: not one of ${CADENCES.join(', ')}`);
    if ('last_success' in s && s.last_success !== null && !isDateTime(s.last_success)) errors.push(`${where}.last_success: not a date-time or null`);
    if ('last_error' in s && s.last_error !== null && typeof s.last_error !== 'string') errors.push(`${where}.last_error: not a string or null`);
  });
  return errors;
}

export function validateEvents(doc) {
  const errors = [];
  if (!isObject(doc)) return ['events: not an object'];
  exactKeys(doc, ['events'], 'events', errors);
  if (!Array.isArray(doc.events)) {
    if ('events' in doc) errors.push('events.events: not an array');
    return errors;
  }
  const ids = new Set();
  doc.events.forEach((e, i) => {
    const where = `events[${i}]`;
    if (!isObject(e)) return errors.push(`${where}: not an object`);
    exactKeys(e, ['id', 'date', 'axis', 'title', 'source_url', 'archive_url', 'comment_deadline'], where, errors);
    if ('id' in e) {
      if (!nonEmpty(e.id)) errors.push(`${where}.id: empty or not a string`);
      else if (ids.has(e.id)) errors.push(`${where}.id: duplicate "${e.id}"`);
      ids.add(e.id);
    }
    if ('date' in e && !isDate(e.date)) errors.push(`${where}.date: not YYYY-MM-DD`);
    if ('axis' in e && !AXES.includes(e.axis)) errors.push(`${where}.axis: not one of ${AXES.join(', ')}`);
    if ('title' in e && !nonEmpty(e.title)) errors.push(`${where}.title: empty or not a string`);
    if ('source_url' in e && !isHttpsUrl(e.source_url)) errors.push(`${where}.source_url: not an https URL`);
    if ('archive_url' in e && e.archive_url !== null && !isHttpsUrl(e.archive_url)) errors.push(`${where}.archive_url: not an https URL or null`);
    if ('comment_deadline' in e && e.comment_deadline !== null && !isDate(e.comment_deadline)) errors.push(`${where}.comment_deadline: not YYYY-MM-DD or null`);
  });
  return errors;
}

export function validateSources(doc) {
  const errors = [];
  if (!isObject(doc) || !Array.isArray(doc.sources) || doc.sources.length === 0) return ['sources: missing sources list'];
  doc.sources.forEach((s, i) => {
    if (!isObject(s) || !nonEmpty(s.id) || !nonEmpty(s.label)) errors.push(`sources[${i}]: needs id and label`);
  });
  return errors;
}

// Freshness of one configured source against status.json (plan 7.4):
// missing file, not reported, failed poll, never polled, or last success
// older than twice the cadence are all warnings, never a silent pass.
export function freshness(entry, now) {
  if (!entry) return { level: 'warning', code: 'NOT REPORTED' };
  if (entry.last_error) return { level: 'warning', code: 'FAILED' };
  if (!entry.last_success) return { level: 'warning', code: 'NEVER POLLED' };
  const age = now - Date.parse(entry.last_success);
  if (age > 2 * CADENCE_MS[entry.cadence]) return { level: 'warning', code: 'STALE' };
  return { level: 'ok', code: 'FRESH' };
}
