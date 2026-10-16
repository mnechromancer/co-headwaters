// Validates the data contracts (plan 7): the JSON Schemas in schema/ compile,
// the runtime validators in assets/contracts.js agree with them on every
// fixture in tests/fixtures, and any published data file passes.
//
// Fixtures named *-invalid*.json must fail; all others must pass. Fixtures
// are test-only: the Pages deploy publishes index.html, assets/ and data/.

import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { validateEvents, validateSources, validateStatus } from '../assets/contracts.js';

const ROOT = resolve(import.meta.dirname, '..');
const read = (p) => JSON.parse(readFileSync(join(ROOT, p), 'utf8'));

const ajv = new Ajv2020({ allErrors: true, strict: true });
addFormats(ajv);
const kinds = {
  status: { schema: ajv.compile(read('schema/status.schema.json')), runtime: validateStatus },
  events: { schema: ajv.compile(read('schema/events.schema.json')), runtime: validateEvents },
  sources: { schema: ajv.compile(read('schema/sources.schema.json')), runtime: validateSources },
};

// Constraints JSON Schema can't express; the runtime validator enforces them.
function extra(kind, doc) {
  if (kind === 'events' && Array.isArray(doc?.events)) {
    const ids = doc.events.map((e) => e?.id);
    if (new Set(ids).size !== ids.length) return ['duplicate event id'];
  }
  return [];
}

const failures = [];
function check(kind, file, expectValid) {
  const doc = read(file);
  const { schema, runtime } = kinds[kind];
  const schemaOk = schema(doc) && extra(kind, doc).length === 0;
  const runtimeErrors = runtime(doc);
  const runtimeOk = runtimeErrors.length === 0;
  if (schemaOk !== runtimeOk) {
    failures.push(`${file}: schema says ${schemaOk ? 'valid' : 'invalid'}, runtime says ${runtimeOk ? 'valid' : `invalid (${runtimeErrors[0]})`}`);
  }
  if (expectValid !== undefined && schemaOk !== expectValid) {
    failures.push(`${file}: expected ${expectValid ? 'valid' : 'invalid'}${schemaOk ? '' : `: ${ajv.errorsText(schema.errors)}`}`);
  }
  console.log(`  ${schemaOk ? 'valid  ' : 'invalid'} ${file}`);
}

console.log('Fixtures:');
for (const f of readdirSync(join(ROOT, 'tests/fixtures')).filter((x) => x.endsWith('.json')).sort()) {
  const kind = f.split('-')[0];
  if (!kinds[kind]) {
    failures.push(`tests/fixtures/${f}: name must start with status-, events- or sources-`);
    continue;
  }
  check(kind, `tests/fixtures/${f}`, !f.includes('-invalid'));
}

console.log('Published data:');
check('sources', 'data/sources.json', true);
for (const kind of ['status', 'events']) {
  if (existsSync(join(ROOT, `data/${kind}.json`))) check(kind, `data/${kind}.json`, true);
  else console.log(`  absent  data/${kind}.json (dashboard shows its missing state)`);
}

if (failures.length) {
  console.error(`check-data failed (${failures.length}):`);
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}
console.log('check-data passed');
