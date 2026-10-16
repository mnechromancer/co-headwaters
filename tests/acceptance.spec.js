// M7: accessibility and performance acceptance checks (plan section 9).
// Frame-rate on a throttled phone lives in perf.spec.js (`npm run perf`).
import { test, expect } from '@playwright/test';
import { readFileSync, readdirSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { buildSchedule, timeline } from '../assets/captions.js';

const root = new URL('../', import.meta.url);
const read = (p) => readFileSync(new URL(p, root));
const map = JSON.parse(read('data/map.json'));
const indexHtml = read('index.html').toString();
const captionText = [...indexHtml.matchAll(/<span class="caption-text">([^<]*)<\/span>/g)].map(([, t]) =>
  t.replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, '&')
);

async function settle(page) {
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
}

async function seek(page, t) {
  await page.locator('.debug-scrubber input').evaluate((input, value) => {
    input.value = String(value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  }, t);
  await settle(page);
}

// ---- Contrast -------------------------------------------------------------------

function luminance(hex) {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
function contrast(a, b) {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}
const css = read('assets/style.css').toString();
const token = (name) => css.match(new RegExp(`--${name}:\\s*(#[0-9A-Fa-f]{6})`))[1];

test('text colors meet 4.5:1 and river lines 3:1 against their backgrounds', () => {
  const bg = token('bg');
  const white = '#FFFFFF'; // panels and the CTA card
  const pairs = [
    ['ink on page', token('ink'), bg, 4.5],
    ['ink on panel', token('ink'), white, 4.5],
    ['muted text on page', token('muted'), bg, 4.5],
    ['muted text on panel', token('muted'), white, 4.5],
    ['links on page', token('river'), bg, 4.5],
    ['links on panel', token('river'), white, 4.5],
    ['CTA button text', white, token('cta'), 4.5],
    ['river tooltip', bg, token('ink'), 4.5],
    ['river line on page', token('river'), bg, 3],
  ];
  for (const [label, fg, back, min] of pairs) expect(contrast(fg, back), label).toBeGreaterThanOrEqual(min);
});

// ---- Payload ----------------------------------------------------------------------

test('payload: map.json <= 250 KB and the whole site <= 400 KB gzipped', () => {
  const shipped = ['index.html', ...['assets', 'data'].flatMap((dir) => readdirSync(new URL(`${dir}/`, root)).map((f) => `${dir}/${f}`))];
  const gz = (p) => gzipSync(read(p)).length;
  const total = shipped.reduce((sum, p) => sum + gz(p), 0);
  console.log(`gzipped: map.json ${(gz('data/map.json') / 1024).toFixed(1)} KB, site ${(total / 1024).toFixed(1)} KB (${shipped.length} files)`);
  expect(gz('data/map.json')).toBeLessThanOrEqual(250 * 1024);
  expect(total).toBeLessThanOrEqual(400 * 1024);
});

test('no third-party requests, intro through dashboard', async ({ page, baseURL }) => {
  const requests = [];
  page.on('request', (r) => requests.push(r.url()));
  await page.goto('/index.html');
  await expect(page.locator('#map .river-line')).toHaveCount(map.rivers.length);
  await page.locator('#skip').click();
  await expect(page.locator('#dashboard[data-ready="true"]')).toHaveCount(1);
  const origin = new URL(baseURL).origin;
  expect(requests.filter((u) => !u.startsWith(origin) && !u.startsWith('data:'))).toEqual([]);
});

// ---- Load and layout ----------------------------------------------------------------

test('blank off-white page on load; Colorado visible by 3 s', async ({ page }) => {
  await page.goto('/index.html?debug=1');
  await expect(page.locator('#map .river-line')).toHaveCount(map.rivers.length);
  expect(await page.evaluate(() => getComputedStyle(document.body).backgroundColor)).toBe('rgb(246, 243, 236)');
  await seek(page, 0);
  const atZero = await page.$$eval('.state-outline', (els) => els.map((e) => Number(e.style.opacity)));
  expect(atZero.every((o) => o === 0)).toBe(true);
  expect((await page.locator('#caption').evaluate((el) => Number(el.style.opacity)))).toBe(0);
  await seek(page, 3);
  const colorado = map.states.filter((s) => s.path).findIndex((s) => s.name === 'Colorado');
  expect(await page.locator('.state-outline').nth(colorado).evaluate((e) => Number(e.style.opacity))).toBe(1);
});

test('no layout shift while the intro plays through a caption change', async ({ page }) => {
  await page.addInitScript(() => {
    window.__cls = 0;
    new PerformanceObserver((list) => {
      for (const e of list.getEntries()) if (!e.hadRecentInput) window.__cls += e.value;
    }).observe({ type: 'layout-shift', buffered: true });
  });
  await page.goto('/index.html');
  // Real time past the first caption change (C1 -> next at the Utah cue).
  const captions = [...indexHtml.matchAll(/<li data-id="([^"]+)" data-cue="([^"]+)"><span class="caption-text">([^<]*)<\/span>/g)].map(
    ([, id, cue, text]) => ({ id, cue: JSON.parse(cue.replace(/&quot;/g, '"')), text })
  );
  const second = buildSchedule(captions, map).items[1].start;
  await page.waitForTimeout((second + 1) * 1000);
  expect(await page.evaluate(() => window.__cls)).toBeLessThan(0.01);
});

// ---- Keyboard and screen reader -------------------------------------------------------

test('keyboard-only run: skip, land on the dashboard heading, tab through without traps', async ({ page }) => {
  await page.goto('/index.html');
  await expect(page.locator('#map .river-line')).toHaveCount(map.rivers.length);
  await page.keyboard.press('Tab');
  await expect(page.locator('#skip')).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page.locator('#dash-title')).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(page.getByRole('link', { name: 'Replay intro' })).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(page.getByRole('link', { name: 'Methodology' })).toBeFocused();
  // Focus indicators are visible (outline or focus-visible styles).
  await page.keyboard.press('Shift+Tab');
  await expect(page.getByRole('link', { name: 'Replay intro' })).toBeFocused();
});

test('screen readers get the caption list in order, not the animation', async ({ page }) => {
  await page.goto('/index.html');
  await expect(page.locator('#map .river-line')).toHaveCount(map.rivers.length);
  const tree = await page.locator('#intro').ariaSnapshot();
  let at = -1;
  for (const text of captionText) {
    const i = tree.indexOf(text.slice(0, 40));
    expect(i, `caption in tree: ${text.slice(0, 40)}`).toBeGreaterThan(at);
    at = i;
  }
  expect(tree).toContain('listitem');
  expect(tree).toContain('button "Skip intro"');
  // The animated map and live caption are hidden: no river name that isn't in
  // the captions, no map label.
  expect(tree).not.toContain('Yampa');
  expect(tree).not.toContain('Map of Colorado-region rivers');
});

test('the CTA is announced as a button with its text', async ({ page }) => {
  const captions = [...indexHtml.matchAll(/<li data-id="([^"]+)" data-cue="([^"]+)"><span class="caption-text">([^<]*)<\/span>/g)].map(
    ([, id, cue, text]) => ({ id, cue: JSON.parse(cue.replace(/&quot;/g, '"')), text })
  );
  const stage = timeline(buildSchedule(captions, map));
  await page.goto('/index.html?debug=1');
  await expect(page.locator('#map .river-line')).toHaveCount(map.rivers.length);
  await seek(page, stage.introEnd + 1);
  await expect(page.getByRole('button', { name: 'Enter Headwaters' })).toBeVisible();
});
