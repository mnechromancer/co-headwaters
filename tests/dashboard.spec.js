// M6: dashboard shell states. Each panel is rendered from the data files as
// served; fixtures stand in for watcher output and are routed in per test
// (they live in tests/fixtures and are never deployed).
import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';

const fixture = (name) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');
const sources = JSON.parse(readFileSync(new URL('../data/sources.json', import.meta.url), 'utf8')).sources;
const SEEN_KEY = 'headwaters:intro-seen';
const NOW = new Date('2026-10-16T12:00:00Z'); // 06:00 in Denver

test.use({ timezoneId: 'America/Denver' });

// body: fixture file name, or { status, body } for a raw response, or null for 404.
async function openDashboard(page, { status = null, events = null } = {}) {
  for (const [file, spec] of [['status', status], ['events', events]]) {
    await page.route(`**/data/${file}.json`, (route) => {
      if (spec === null) return route.fulfill({ status: 404, body: 'not found' });
      if (typeof spec === 'string') return route.fulfill({ status: 200, contentType: 'application/json', body: fixture(spec) });
      return route.fulfill({ status: spec.status, contentType: 'application/json', body: spec.body });
    });
  }
  await page.addInitScript((key) => localStorage.setItem(key, '1'), SEEN_KEY);
  await page.clock.setFixedTime(NOW);
  await page.goto('/index.html');
  await expect(page.locator('#dashboard[data-ready="true"]')).toHaveCount(1);
}

const openPanel = (page) => page.locator('[data-panel="open"]');
const timelinePanel = (page) => page.locator('[data-panel="timeline"]');
const sourcesPanel = (page) => page.locator('[data-panel="sources"]');
const row = (page, id) => page.locator(`.source-row[data-source="${id}"]`);

test.describe('no data files published', () => {
  test('every panel says so explicitly; no values shown', async ({ page }) => {
    await openDashboard(page);
    await expect(openPanel(page)).toHaveText('No open proceedings are being tracked yet.');
    await expect(timelinePanel(page).locator('.tl-track')).toHaveCount(3);
    await expect(timelinePanel(page).locator('.tl-label')).toHaveText(['Compact', 'Utility', 'Local supply']);
    await expect(timelinePanel(page).locator('.tl-empty')).toHaveText(['No records yet', 'No records yet', 'No records yet']);
    await expect(timelinePanel(page).locator('.tl-tick').first()).toBeAttached();
    await expect(sourcesPanel(page).locator('.source-row')).toHaveCount(sources.length);
    for (const s of sources) {
      await expect(row(page, s.id)).toContainText(s.label);
      await expect(row(page, s.id).locator('.warning')).toContainText('NO STATUS FILE');
    }
  });
});

test.describe('events.json', () => {
  test('lists only open comment windows, soonest first, with countdowns', async ({ page }) => {
    await openDashboard(page, { events: 'events-open.json' });
    const items = openPanel(page).locator('li');
    await expect(items).toHaveCount(2);
    await expect(items.nth(0)).toContainText('Fixture: supply record, closes today');
    await expect(items.nth(0)).toContainText('closes today');
    await expect(items.nth(1)).toContainText('Fixture: utility record, comments open');
    await expect(items.nth(1)).toContainText('Comments due Oct 20, 2026 (closes in 4 days) · Utility');
    await expect(items.nth(1).getByRole('link', { name: 'archived copy' })).toHaveAttribute('href', 'https://example.org/archive/utility-2');
    await expect(openPanel(page)).not.toContainText('comments closed');
  });

  test('timeline puts each record on its axis, linked to its source', async ({ page }) => {
    await openDashboard(page, { events: 'events-open.json' });
    const lane = (axis) => timelinePanel(page).locator(`.tl-track[data-axis="${axis}"] .tl-event`);
    await expect(lane('compact')).toHaveCount(1);
    await expect(lane('utility')).toHaveCount(2);
    await expect(lane('supply')).toHaveCount(1);
    await expect(lane('compact')).toHaveAttribute('href', 'https://example.org/fixture/compact-1');
    await expect(lane('compact')).toHaveAttribute('aria-label', 'Aug 21, 2026: Fixture: compact record');
    await expect(timelinePanel(page).locator('.tl-empty')).toHaveCount(0);
    // Later dates sit further right.
    const lefts = await lane('utility').evaluateAll((els) => els.map((e) => parseFloat(e.style.left)));
    expect(lefts[0]).toBeLessThan(lefts[1]);
  });

  test('an empty file shows the empty state', async ({ page }) => {
    await openDashboard(page, { events: 'events-empty.json' });
    await expect(openPanel(page)).toHaveText('No open proceedings are being tracked yet.');
    await expect(timelinePanel(page).locator('.tl-empty')).toHaveCount(3);
  });

  for (const [label, spec] of [
    ['a schema violation', 'events-invalid.json'],
    ['an impossible date', 'events-invalid-date.json'],
    ['malformed JSON', { status: 200, body: '{"events": [' }],
  ]) {
    test(`${label} is flagged and nothing from the file is shown`, async ({ page }) => {
      await openDashboard(page, { events: spec });
      await expect(openPanel(page).locator('.warning')).toContainText('INVALID');
      await expect(openPanel(page).locator('li')).toHaveCount(0);
      await expect(timelinePanel(page).locator('.warning')).toContainText('INVALID');
      await expect(timelinePanel(page).locator('.tl-event')).toHaveCount(0);
    });
  }

  test('a server error is flagged as unavailable', async ({ page }) => {
    await openDashboard(page, { events: { status: 500, body: '' } });
    await expect(openPanel(page).locator('.warning')).toContainText('UNAVAILABLE');
    await expect(openPanel(page).locator('.warning')).toContainText('HTTP 500');
  });
});

test.describe('status.json', () => {
  test('fresh polls show their time and cadence, no warnings', async ({ page }) => {
    await openDashboard(page, { status: 'status-fresh.json' });
    await expect(sourcesPanel(page).locator('.warning')).toHaveCount(0);
    await expect(row(page, 'puc-25AL-0538G')).toContainText('Last successful poll 2026-10-16 06:00 UTC (daily)');
    await expect(row(page, 'reservoirs-earth')).toContainText('(weekly)');
  });

  test('stale, failed, never-polled and unreported sources each get a labelled warning', async ({ page }) => {
    await openDashboard(page, { status: 'status-mixed.json' });
    await expect(row(page, 'puc-25AL-0538G').locator('.warning')).toHaveCount(0);
    await expect(row(page, 'puc-electric').locator('.warning')).toContainText('STALE');
    await expect(row(page, 'puc-electric').locator('.warning')).toContainText('older than twice the daily cadence');
    await expect(row(page, 'denver-water-notices').locator('.warning')).toContainText('FAILED');
    await expect(row(page, 'denver-water-notices').locator('.warning')).toContainText('HTTP 503 from source');
    await expect(row(page, 'lake-powell-elevation').locator('.warning')).toContainText('NEVER POLLED');
    await expect(row(page, 'reservoirs-earth').locator('.warning')).toHaveCount(0);
    await expect(row(page, 'colorado-river-decisions').locator('.warning')).toContainText('NOT REPORTED');
  });

  test('warnings are marked by text and border, not color alone', async ({ page }) => {
    await openDashboard(page, { status: 'status-mixed.json' });
    const w = row(page, 'puc-electric').locator('.warning');
    await expect(w.locator('strong')).toHaveText('STALE');
    const style = await w.evaluate((el) => {
      const cs = getComputedStyle(el);
      return { border: cs.borderTopWidth, color: cs.color };
    });
    expect(parseFloat(style.border)).toBeGreaterThanOrEqual(2);
  });

  test('an invalid file is flagged and no freshness is claimed', async ({ page }) => {
    await openDashboard(page, { status: 'status-invalid.json' });
    await expect(sourcesPanel(page).locator('> .warning')).toContainText('INVALID');
    await expect(sourcesPanel(page).locator('.source-status')).toHaveCount(0);
    for (const s of sources) await expect(row(page, s.id).locator('.warning')).toContainText('NO STATUS');
  });
});

test('every source in data/sources.json gets a row', async ({ page }) => {
  await openDashboard(page, { status: 'status-fresh.json' });
  await expect(sourcesPanel(page).locator('.source-name')).toHaveText(sources.map((s) => s.label));
});
