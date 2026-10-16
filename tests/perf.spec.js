// M7 performance probe: frame pacing of the intro on a throttled mid-tier
// mobile profile (4x CPU slowdown, as Lighthouse's mobile preset uses).
// Not part of the default run: timing depends on the machine, and CI
// runners have no GPU. Excluded from `npm test` by playwright.config.js;
// run with `npm run perf`.
import { test, expect } from '@playwright/test';

test('intro holds ~60 fps through the busiest stretch @perf', async ({ page }) => {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 });
  await page.goto('/index.html?debug=1');
  await page.waitForSelector('.river-line');
  // t = 12-20 s: ten rivers drawing, camera zooming out, states fading in.
  await page.locator('.debug-scrubber input').evaluate((i) => {
    i.value = '12';
    i.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await page.locator('.debug-scrubber [data-action="toggle"]').click();
  const frames = await page.evaluate(
    () =>
      new Promise((resolve) => {
        const times = [];
        const start = performance.now();
        const tick = (now) => {
          times.push(now);
          if (now - start < 8000) requestAnimationFrame(tick);
          else resolve(times);
        };
        requestAnimationFrame(tick);
      })
  );
  const deltas = frames.slice(1).map((t, i) => t - frames[i]).sort((a, b) => a - b);
  const pct = (q) => deltas[Math.min(deltas.length - 1, Math.floor(q * deltas.length))];
  const fps = (deltas.length / (frames.at(-1) - frames[0])) * 1000;
  console.log(`frames=${deltas.length} avg_fps=${fps.toFixed(1)} p50=${pct(0.5).toFixed(1)}ms p95=${pct(0.95).toFixed(1)}ms p99=${pct(0.99).toFixed(1)}ms`);
  expect(fps).toBeGreaterThan(55);
  expect(pct(0.95)).toBeLessThan(20);
});
