// M3 director tests: renderAt(t) is a pure function of t, so each check seeks
// the clock through the ?debug=1 scrubber and asserts the frame against the
// timings in data/map.json — the same numbers build-map.mjs wrote, not
// hard-coded copies of them.
import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';

const map = JSON.parse(readFileSync(new URL('../data/map.json', import.meta.url), 'utf8'));
const END = Math.max(...map.rivers.map((r) => r.endT));
const SCREENSHOT_TIMES = [2, 6, 12, 20, 30, END];

const clamp01 = (x) => Math.max(0, Math.min(1, x));
const fractionAt = (river, t) => {
  const d = river.endT - river.startT;
  return d > 0 ? clamp01((t - river.startT) / d) : t >= river.startT ? 1 : 0;
};

async function openDebug(page) {
  const errors = [];
  page.on('pageerror', (err) => errors.push(err.message));
  // The site ships no favicon; the browser's automatic request for one isn't
  // a page error.
  page.on('console', (msg) => {
    if (msg.type() === 'error' && !msg.location().url.endsWith('/favicon.ico')) errors.push(msg.text());
  });
  await page.goto('/index.html?debug=1');
  await expect(page.locator('#intro svg .river-line')).toHaveCount(map.rivers.length);
  return errors;
}

// Drive the real scrubber: an input event pauses the clock and seeks it.
// Two rAFs let layout settle so renderAt's px-per-unit maths is final.
async function seek(page, t) {
  await page.locator('.debug-scrubber input').evaluate((input, value) => {
    input.value = String(value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  }, t);
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
}

async function frameState(page) {
  return page.evaluate(() => {
    const op = (n) => Number(n.style.opacity || '0');
    return {
      viewBox: document.querySelector('#intro svg').getAttribute('viewBox'),
      dashoffsets: [...document.querySelectorAll('.river-line')].map((p) => Number(p.style.strokeDashoffset)),
      states: [...document.querySelectorAll('.state-outline')].map(op),
      headwaters: [...document.querySelectorAll('.headwater-dot')].map(op),
      termini: [...document.querySelectorAll('.terminus-dot')].map(op),
      labels: [...document.querySelectorAll('.river-label')].map(op),
    };
  });
}

test('loads without errors and builds one path, dot and label per river', async ({ page }) => {
  const errors = await openDebug(page);
  await expect(page.locator('.headwater-dot')).toHaveCount(map.rivers.length);
  await expect(page.locator('.river-label')).toHaveText(map.rivers.map((r) => r.name));
  await expect(page.locator('.terminus-dot')).toHaveCount(map.rivers.filter((r) => r.terminusPx).length);
  await expect(page.locator('.state-outline')).toHaveCount(map.states.filter((s) => s.path).length);
  expect(errors).toEqual([]);
});

for (const t of [0, 0.5, 6, 12, 15, 20, 25, END]) {
  test(`river draw fraction matches map.json timings at t=${t}`, async ({ page }) => {
    await openDebug(page);
    await seek(page, t);
    const { dashoffsets, headwaters } = await frameState(page);
    map.rivers.forEach((river, i) => {
      expect(dashoffsets[i], river.name).toBeCloseTo(1 - fractionAt(river, t), 3);
      if (t < river.startT) expect(headwaters[i], `${river.name} headwater`).toBe(0);
    });
  });
}

test('seeking is deterministic and order-independent', async ({ page }) => {
  await openDebug(page);
  await seek(page, 17.5);
  const forward = await frameState(page);
  await seek(page, END);
  await seek(page, 3);
  await seek(page, 17.5);
  expect(await frameState(page)).toEqual(forward);
});

test('seeking pauses the clock', async ({ page }) => {
  await openDebug(page);
  await seek(page, 10);
  const before = await frameState(page);
  await page.waitForTimeout(400);
  expect(await frameState(page)).toEqual(before);
  await expect(page.locator('.debug-scrubber [data-role="t"]')).toHaveText('10.00');
});

test('final frame: everything drawn, termini shown, labels gone, final camera', async ({ page }) => {
  await openDebug(page);
  await seek(page, END);
  const s = await frameState(page);
  expect(s.dashoffsets.every((d) => d === 0)).toBe(true);
  expect(s.states.every((o) => o === 1)).toBe(true);
  expect(s.headwaters.every((o) => o === 1)).toBe(true);
  // A river that lands exactly at END has had no time for its terminus fade.
  const settled = map.rivers.filter((r) => r.terminusPx && r.endT <= END - 0.5);
  const terminusRivers = map.rivers.filter((r) => r.terminusPx);
  for (const r of settled) expect(s.termini[terminusRivers.indexOf(r)], r.name).toBe(1);
  // Labels fade out a beat after their river lands; the last river to land
  // still holds its label at END.
  map.rivers.forEach((r, i) => {
    if (r.endT + 1.8 <= END) expect(s.labels[i], `${r.name} label`).toBe(0);
  });
  const last = map.camera[map.camera.length - 1];
  expect(s.viewBox).toBe(`${last.x.toFixed(1)} ${last.y.toFixed(1)} ${last.w.toFixed(1)} ${last.h.toFixed(1)}`);
});

test('states fade in from their enterT', async ({ page }) => {
  await openDebug(page);
  const drawn = map.states.filter((st) => st.path);
  for (const t of [1, 8, 18]) {
    await seek(page, t);
    const { states } = await frameState(page);
    drawn.forEach((st, i) => {
      if (t <= st.enterT) expect(states[i], st.name).toBe(0);
      if (t >= st.enterT + 1.2) expect(states[i], st.name).toBe(1);
    });
  }
});

test('markers and labels keep a constant on-screen size as the camera zooms', async ({ page }) => {
  await openDebug(page);
  const sizes = [];
  for (const t of [3, 12, END]) {
    await seek(page, t);
    sizes.push(await page.evaluate(() => {
      const svg = document.querySelector('#intro svg');
      const pxPerUnit = svg.getScreenCTM().a;
      // Size from the attributes renderAt sets, times the screen transform —
      // not getBoundingClientRect, whose padding for SVG shapes differs
      // between Chromium builds (6px here, 7.16px in the CI headless shell).
      const dot = 2 * Number(document.querySelector('.headwater-dot').getAttribute('r')) * pxPerUnit;
      // Hidden labels keep whatever size they last had; only visible ones
      // are re-sized each frame.
      const fonts = [...document.querySelectorAll('.river-label')]
        .filter((l) => Number(l.style.opacity) > 0)
        .map((l) => Number(l.getAttribute('font-size')) * pxPerUnit);
      return { dot, fonts };
    }));
  }
  for (const { dot, fonts } of sizes) {
    expect(dot).toBeCloseTo(6, 0); // r = 3 screen px
    expect(fonts.length).toBeGreaterThan(0);
    for (const f of fonts) expect(f).toBeCloseTo(11, 0);
  }
});

test.describe('prefers-reduced-motion', () => {
  test.use({ reducedMotion: 'reduce' });

  test('renders the final frame immediately and does not animate', async ({ page }) => {
    await page.goto('/index.html');
    await expect(page.locator('#intro svg .river-line')).toHaveCount(map.rivers.length);
    await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
    const s = await frameState(page);
    expect(s.dashoffsets.every((d) => d === 0)).toBe(true);
    await page.waitForTimeout(300);
    expect(await frameState(page)).toEqual(s);
  });
});

// Tagged so CI can skip them: baselines are rendered on one machine and font
// rasterisation differs across machines.
test.describe('screenshots @screenshot', () => {
  for (const t of SCREENSHOT_TIMES) {
    test(`frame at t=${t === END ? 'END' : t}`, async ({ page }) => {
      await openDebug(page);
      // Scrubber is review chrome, not part of the frame.
      await page.addStyleTag({ content: '.debug-scrubber { visibility: hidden; }' });
      await seek(page, t);
      await expect(page.locator('#intro')).toHaveScreenshot(`intro-t${t === END ? 'END' : t}.png`);
    });
  }
});
