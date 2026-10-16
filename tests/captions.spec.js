// M4: captions, skip, returning-visitor flag, reduced motion, no-JS.
// The expected schedule comes from assets/captions.js run over the caption
// list in index.html and data/map.json, the same inputs the page uses.
import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { buildSchedule } from '../assets/captions.js';

const map = JSON.parse(readFileSync(new URL('../data/map.json', import.meta.url), 'utf8'));
const copy = JSON.parse(readFileSync(new URL('../data/copy.json', import.meta.url), 'utf8'));
const MAP_END = Math.max(...map.rivers.map((r) => r.endT));
const SEEN_KEY = 'headwaters:intro-seen';

// Caption text as it appears on the page (computed values filled in by
// check-copy), read from the generated list in index.html.
const indexHtml = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const pageText = Object.fromEntries(
  [...indexHtml.matchAll(/<li data-id="([^"]+)"[^>]*><span class="caption-text">([^<]*)<\/span>/g)].map(([, id, text]) =>
    [id, text.replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')]
  )
);
const captions = copy.captions.map((c) => ({ ...c, text: pageText[c.id] }));
const schedule = buildSchedule(captions, map);
const INTRO_END = schedule.end;

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

const liveCaption = (page) =>
  page.evaluate(() => {
    const el = document.getElementById('caption');
    return { text: el.querySelector('.caption-text')?.textContent ?? '', opacity: Number(el.style.opacity) };
  });

const seen = (page) => page.evaluate((key) => localStorage.getItem(key), SEEN_KEY);

test('every caption is in the DOM from load, in order, and the animation is hidden from assistive tech', async ({ page }) => {
  await page.goto('/index.html');
  await expect(page.locator('#caption-list li .caption-text')).toHaveText(captions.map((c) => c.text));
  await expect(page.locator('#map')).toHaveAttribute('aria-hidden', 'true');
  await expect(page.locator('#caption')).toHaveAttribute('aria-hidden', 'true');
  await expect(page.locator('[aria-live]')).toHaveCount(0);
  // Dated facts carry a visible as-of line.
  for (const c of copy.captions.filter((x) => x.as_of)) {
    await expect(page.locator(`#caption-list li[data-id="${c.id}"] .as-of`)).toHaveCount(1);
  }
});

test('captions follow their map cues, one at a time', async ({ page }) => {
  await page.goto('/index.html?debug=1');
  await expect(page.locator('#map .river-line')).toHaveCount(map.rivers.length);
  await seek(page, Math.max(0, schedule.items[0].start - 0.5));
  expect((await liveCaption(page)).opacity).toBe(0);
  for (const [i, item] of schedule.items.entries()) {
    await seek(page, (item.start + item.end) / 2);
    const live = await liveCaption(page);
    expect(live.text, item.id).toBe(captions[i].text);
    expect(live.opacity, item.id).toBe(1);
  }
  await expect(page.locator('#caption .caption-text')).toHaveCount(1);
});

// Cue times worked out here straight from map.json, independently of
// assets/captions.js, so a bug in its cue resolution can't hide behind a
// schedule computed by the same code.
function rawCueT(cue) {
  const offset = cue.offset ?? 0;
  if (cue.event === 'riverStart') return map.rivers.find((r) => r.name === cue.river).startT + offset;
  if (cue.event === 'riverEnd') return map.rivers.find((r) => r.name === cue.river).endT + offset;
  if (cue.event === 'stateEnter') return map.states.find((s) => s.name === cue.state).enterT + offset;
  if (cue.event === 'end') return MAP_END + offset;
  throw new Error(`unknown cue ${cue.event}`);
}

test('each caption appears at its map event, or right after the previous caption if that is still being read', async ({ page }) => {
  await page.goto('/index.html?debug=1');
  await expect(page.locator('#map .river-line')).toHaveCount(map.rivers.length);
  for (const [i, item] of schedule.items.entries()) {
    const cueT = rawCueT(captions[i].cue);
    const prevEnd = i > 0 ? schedule.items[i - 1].end : 0;
    expect(item.start, item.id).toBeCloseTo(Math.max(cueT, prevEnd), 5);
    if (item.start - cueT < 1e-6 && i > 0) {
      // Cued exactly on its event: the previous caption is still up just before it.
      await seek(page, cueT - 0.3);
      expect((await liveCaption(page)).text, `${item.id} before its cue`).toBe(captions[i - 1].text);
      await seek(page, cueT + 0.3);
      expect((await liveCaption(page)).text, `${item.id} after its cue`).toBe(captions[i].text);
    }
  }
});

test('captions crossfade at each handoff', async ({ page }) => {
  await page.goto('/index.html?debug=1');
  await expect(page.locator('#map .river-line')).toHaveCount(map.rivers.length);
  const [, second] = schedule.items;
  await seek(page, second.start - 0.1);
  const out = await liveCaption(page);
  expect(out.text).toBe(captions[0].text);
  expect(out.opacity).toBeGreaterThan(0);
  expect(out.opacity).toBeLessThan(1);
  await seek(page, second.start + 0.1);
  const into = await liveCaption(page);
  expect(into.text).toBe(captions[1].text);
  expect(into.opacity).toBeGreaterThan(0);
  expect(into.opacity).toBeLessThan(1);
});

test('the intro runs past the map coming to rest until the last caption has held', async () => {
  expect(INTRO_END).toBeGreaterThan(MAP_END);
  expect(schedule.items.at(-1).end).toBeCloseTo(INTRO_END, 5);
});

// Skipping (or arriving any other way) lands on the dashboard with the map
// moved into the basin panel.
async function expectDashboard(page, { focused = true } = {}) {
  await expect(page.locator('body')).toHaveClass(/dashboard-mode/);
  await expect(page.locator('#dashboard')).toBeVisible();
  await expect(page.locator('#intro')).toBeHidden();
  await expect(page.locator('#map-slot .river-line')).toHaveCount(map.rivers.length);
  const offsets = await page.$$eval('#map-slot .river-line', (els) => els.map((e) => Number(e.style.strokeDashoffset)));
  expect(offsets.every((d) => d === 0)).toBe(true);
  if (focused) await expect(page.locator('#dash-title')).toBeFocused();
}

test('skip button goes straight to the dashboard and remembers the visit', async ({ page }) => {
  await page.goto('/index.html');
  await expect(page.locator('#map .river-line')).toHaveCount(map.rivers.length);
  await expect(page.locator('#skip')).toBeVisible();
  await page.locator('#skip').click();
  await settle(page);
  await expectDashboard(page);
  expect(await seen(page)).toBe('1');
});

for (const key of ['Escape', 'Enter', ' ']) {
  test(`${key === ' ' ? 'Space' : key} skips the intro`, async ({ page }) => {
    await page.goto('/index.html');
    await expect(page.locator('#map .river-line')).toHaveCount(map.rivers.length);
    await page.keyboard.press(key);
    await settle(page);
    await expectDashboard(page);
  });
}

test('skip is reachable by keyboard', async ({ page }) => {
  await page.goto('/index.html');
  await expect(page.locator('#map .river-line')).toHaveCount(map.rivers.length);
  await page.keyboard.press('Tab');
  await expect(page.locator('#skip')).toBeFocused();
});

test.describe('returning visitor', () => {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript((key) => localStorage.setItem(key, '1'), SEEN_KEY);
  });

  test('lands on the dashboard without playing', async ({ page }) => {
    await page.goto('/index.html');
    await settle(page);
    await expectDashboard(page, { focused: false });
  });

  test('?replay=1 plays the intro again', async ({ page }) => {
    await page.goto('/index.html?replay=1');
    await expect(page.locator('#map .river-line')).toHaveCount(map.rivers.length);
    await settle(page);
    await expect(page.locator('#skip')).toBeVisible();
    const offsets = await page.$$eval('.river-line', (els) => els.map((e) => Number(e.style.strokeDashoffset)));
    expect(offsets.some((d) => d > 0)).toBe(true);
  });

  test('the dashboard footer links to the replay', async ({ page }) => {
    await page.goto('/index.html');
    await expect(page.getByRole('link', { name: 'Replay intro' })).toHaveAttribute('href', '?replay=1');
  });
});

test('blocked storage does not break the intro', async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(window, 'localStorage', { get() { throw new Error('blocked'); } });
  });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('/index.html');
  await expect(page.locator('#map .river-line')).toHaveCount(map.rivers.length);
  await page.locator('#skip').click();
  await settle(page);
  await expectDashboard(page);
  expect(errors).toEqual([]);
});

test.describe('prefers-reduced-motion', () => {
  test.use({ reducedMotion: 'reduce' });

  test('shows the final frame, every caption as a static list and the CTA; nothing to skip', async ({ page }) => {
    await page.goto('/index.html');
    await expect(page.locator('#map .river-line')).toHaveCount(map.rivers.length);
    await expect(page.locator('#caption-list')).toBeVisible();
    await expect(page.locator('#caption-list li')).toHaveCount(captions.length);
    for (const li of await page.locator('#caption-list li').all()) await expect(li).toBeVisible();
    await expect(page.locator('#caption')).toBeHidden();
    await expect(page.locator('#skip')).toBeHidden();
    await expect(page.locator('#cta')).toBeVisible();
    const offsets = await page.$$eval('.river-line', (els) => els.map((e) => Number(e.style.strokeDashoffset)));
    expect(offsets.every((d) => d === 0)).toBe(true);
  });

  test('does not auto-advance; the button cuts to the dashboard', async ({ page }) => {
    await page.clock.install();
    await page.goto('/index.html');
    await expect(page.locator('#cta')).toBeVisible();
    await page.clock.runFor(120_000);
    await expect(page.locator('#intro')).toBeVisible();
    await page.locator('#enter').click();
    await expectDashboard(page);
  });
});

test.describe('without JavaScript', () => {
  test.use({ javaScriptEnabled: false });

  test('shows the captions as text, a link into the dashboard, and the dashboard shell', async ({ page }) => {
    await page.goto('/index.html');
    await expect(page.locator('#caption-list')).toBeVisible();
    for (const c of captions) await expect(page.getByText(c.text, { exact: true })).toBeVisible();
    await expect(page.locator('#map')).toBeHidden();
    await expect(page.locator('#skip')).toBeHidden();
    await expect(page.getByRole('link', { name: 'Go to the dashboard' })).toHaveAttribute('href', '#dashboard');
    await expect(page.locator('#dashboard')).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Open this week' })).toBeVisible();
  });
});
