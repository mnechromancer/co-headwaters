Playwright specs. `intro.spec.js` covers the M3 director: every check seeks the clock through
the `?debug=1` scrubber and asserts the frame against the timings in `data/map.json`
(river draw fraction, state fades, final camera, constant on-screen marker/label size,
seek-pauses-clock, deterministic seeking, `prefers-reduced-motion`), plus screenshot
baselines at t = 2, 6, 12, 20, 30, END for desktop (1280×800) and mobile (390×844).
`captions.spec.js` covers M4: caption list in the DOM from load, captions on their map cues
(cue times recomputed independently of `assets/captions.js`), crossfade, skip by button and
keyboard, returning-visitor flag and `?replay=1`, blocked storage, reduced motion, no-JS.
`transition.spec.js` covers M5 (CTA card, auto-advance, Enter Headwaters, keyboard on the card,
shared-element transition landing on the panel without a jump, river hover). `dashboard.spec.js`
covers M6: every panel state, driven by routing `tests/fixtures/*.json` in place of the watcher
files (fixtures are never deployed). `acceptance.spec.js` covers M7: contrast, payload, third-party
requests, layout shift, keyboard-only run, screen-reader tree. `perf.spec.js` measures frame rate
at 4x CPU throttle; it is excluded from `npm test` and runs with `npm run perf`.

```bash
npm install
npx playwright install chromium   # once
npm test                          # everything
npm test -- --grep-invert @screenshot   # behaviour only (what CI runs)
npm run check-data                # schemas vs runtime validators vs fixtures
npm run perf                      # frame-rate probe (machine-dependent)
npm run test:update               # re-render screenshot baselines after an intended visual change
```

`tests/serve.mjs` serves the repo root on port 4173; Playwright starts it automatically.

Screenshot baselines (`intro.spec.js-snapshots/`) are platform-suffixed and depend on the
machine's fonts, so they only compare cleanly on the machine that rendered them. Re-render
locally before trusting a screenshot diff from somewhere else, and look at the new images
before committing them.

If the environment provides its own Chromium build that doesn't match the installed
`@playwright/test` version, point at it with `PW_CHROMIUM_PATH=/path/to/chrome`.
