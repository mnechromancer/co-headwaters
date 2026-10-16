// M5: call-to-action card and the shared-element transition into the
// dashboard's basin panel.
import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { buildSchedule, timeline, CTA_HOLD_S, TRANSITION_S } from '../assets/captions.js';

const map = JSON.parse(readFileSync(new URL('../data/map.json', import.meta.url), 'utf8'));
const copy = JSON.parse(readFileSync(new URL('../data/copy.json', import.meta.url), 'utf8'));
const indexHtml = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const captions = [...indexHtml.matchAll(/<li data-id="([^"]+)" data-cue="([^"]+)"><span class="caption-text">([^<]*)<\/span>/g)].map(
  ([, id, cue, text]) => ({ id, cue: JSON.parse(cue.replace(/&quot;/g, '"')), text })
);
const stage = timeline(buildSchedule(captions, map));
const SEEN_KEY = 'headwaters:intro-seen';

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

async function openDebug(page) {
  await page.goto('/index.html?debug=1');
  await expect(page.locator('#map .river-line')).toHaveCount(map.rivers.length);
}

test('timeline: CTA holds 10 s after the last caption, then a 1.2 s transition', () => {
  expect(CTA_HOLD_S).toBe(10);
  expect(stage.ctaEnd - stage.introEnd).toBeCloseTo(10, 5);
  expect(stage.end - stage.ctaEnd).toBeCloseTo(TRANSITION_S, 5);
});

test('the CTA card appears when the last caption has held, with the approved copy', async ({ page }) => {
  await openDebug(page);
  await seek(page, stage.introEnd - 0.5);
  await expect(page.locator('#cta')).toBeHidden();
  await expect(page.locator('#skip')).toBeVisible();
  await seek(page, stage.introEnd + 1);
  await expect(page.locator('#cta')).toBeVisible();
  await expect(page.locator('#cta .cta-text')).toHaveText(copy.cta.text);
  await expect(page.locator('#enter')).toHaveText(copy.cta.button);
  await expect(page.locator('#skip')).toBeHidden();
  expect(Number(await page.locator('#caption').evaluate((el) => el.style.opacity))).toBe(0);
});

test('mid-transition: dashboard fading in under the map, map still in the intro', async ({ page }) => {
  await openDebug(page);
  await seek(page, stage.ctaEnd + TRANSITION_S / 2);
  await expect(page.locator('body')).toHaveClass(/transitioning/);
  await expect(page.locator('#map .river-line')).toHaveCount(map.rivers.length);
  const opacity = Number(await page.locator('#dashboard').evaluate((el) => el.style.opacity));
  expect(opacity).toBeGreaterThan(0);
  expect(opacity).toBeLessThan(1);
  expect(await page.locator('#map svg').evaluate((el) => el.style.transform)).toMatch(/translate.*scale/);
});

// The drawn map must land exactly where the panel shows it: no jump when
// the SVG is handed over to the panel at the end.
test('the map lands on the basin panel without a jump', async ({ page }) => {
  await openDebug(page);
  const contentRect = () =>
    page.evaluate(() => {
      const svg = document.querySelector('#intro svg, #map-slot svg');
      const r = svg.getBoundingClientRect();
      const vb = svg.viewBox.baseVal;
      const fit = Math.min(r.width / vb.width, r.height / vb.height);
      const w = vb.width * fit;
      const hgt = vb.height * fit;
      return { left: r.left + (r.width - w) / 2, top: r.top + (r.height - hgt) / 2, width: w, height: hgt };
    });
  await seek(page, stage.end - 0.02);
  const before = await contentRect();
  await seek(page, stage.end + 0.02);
  await expect(page.locator('#map-slot svg')).toHaveCount(1);
  const after = await contentRect();
  for (const k of ['left', 'top', 'width', 'height']) expect(Math.abs(before[k] - after[k]), k).toBeLessThan(3);
});

test('scrubbing back out of the dashboard returns the map to the intro', async ({ page }) => {
  await openDebug(page);
  await seek(page, stage.end + 0.02);
  await expect(page.locator('#map-slot svg')).toHaveCount(1);
  await seek(page, 10);
  await expect(page.locator('#map svg')).toHaveCount(1);
  await expect(page.locator('body')).not.toHaveClass(/dashboard-mode|transitioning/);
  await expect(page.locator('#dashboard')).toBeHidden();
});

test('auto-advances into the dashboard after the CTA hold', async ({ page }) => {
  await openDebug(page);
  await seek(page, stage.ctaEnd - 0.3);
  await page.locator('.debug-scrubber [data-action="toggle"]').click(); // play
  await expect(page.locator('body')).toHaveClass(/dashboard-mode/, { timeout: 5000 });
  await expect(page.locator('#map-slot .river-line')).toHaveCount(map.rivers.length);
  expect(await page.evaluate((key) => localStorage.getItem(key), SEEN_KEY)).toBe('1');
});

test('Enter Headwaters advances early, animates, and focuses the dashboard', async ({ page }) => {
  await openDebug(page);
  await seek(page, stage.introEnd + 1);
  await page.locator('#enter').click();
  await expect(page.locator('body')).toHaveClass(/transitioning/);
  await expect(page.locator('body')).toHaveClass(/dashboard-mode/, { timeout: 5000 });
  await expect(page.locator('#dash-title')).toBeFocused();
});

for (const [key, animates] of [['Enter', true], [' ', true], ['Escape', false]]) {
  test(`${key === ' ' ? 'Space' : key} on the CTA card ${animates ? 'enters' : 'cuts to'} the dashboard`, async ({ page }) => {
    await openDebug(page);
    await seek(page, stage.introEnd + 1);
    await page.keyboard.press(key);
    if (!animates) await expect(page.locator('body')).toHaveClass(/dashboard-mode/);
    await expect(page.locator('body')).toHaveClass(/dashboard-mode/, { timeout: 5000 });
    await expect(page.locator('#dash-title')).toBeFocused();
  });
}

test('the Enter Headwaters button is reachable by keyboard', async ({ page }) => {
  await openDebug(page);
  await seek(page, stage.introEnd + 1);
  await page.locator('#enter').focus();
  await page.keyboard.press('Enter');
  await expect(page.locator('body')).toHaveClass(/dashboard-mode/, { timeout: 5000 });
});

test('hovering a river in the dashboard map shows its name only', async ({ page }) => {
  await page.addInitScript((key) => localStorage.setItem(key, '1'), SEEN_KEY);
  await page.goto('/index.html');
  await expect(page.locator('#map-slot .river-hit')).toHaveCount(map.rivers.length);
  await settle(page);
  const river = map.rivers.find((r) => r.name === 'Rio Grande');
  const point = await page.locator('#map-slot .river-hit[data-river="Rio Grande"]').evaluate((path) => {
    const len = path.getTotalLength();
    const p = path.getPointAtLength(len * 0.6);
    const m = path.getScreenCTM();
    return { x: p.x * m.a + m.e, y: p.y * m.d + m.f };
  });
  await page.mouse.move(point.x, point.y);
  await expect(page.locator('.river-tip')).toBeVisible();
  await expect(page.locator('.river-tip')).toHaveText(river.name);
  await page.mouse.move(5, 5);
  await expect(page.locator('.river-tip')).toBeHidden();
});

test.describe('screenshots @screenshot', () => {
  test('CTA card', async ({ page }) => {
    await openDebug(page);
    await page.addStyleTag({ content: '.debug-scrubber { visibility: hidden; }' });
    await seek(page, stage.introEnd + 1);
    await expect(page).toHaveScreenshot('cta.png');
  });

  test('dashboard, no data files published', async ({ page }) => {
    await page.addInitScript((key) => localStorage.setItem(key, '1'), SEEN_KEY);
    await page.clock.setFixedTime(new Date('2026-10-16T12:00:00Z'));
    await page.goto('/index.html');
    await expect(page.locator('#dashboard[data-ready="true"]')).toHaveCount(1);
    await settle(page);
    await expect(page).toHaveScreenshot('dashboard-empty.png', { fullPage: true });
  });
});
