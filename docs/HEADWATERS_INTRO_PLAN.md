# Headwaters intro plan

Status: plan only. No Headwaters code has been written. Data feasibility for the river geometry was tested (section 3). Facts in section 6 were checked against sources on 2026-09-20; re-check anything dated before shipping.

## 0. Read first

1. Target repo: a new repository named `co-headwaters`, deployed on GitHub Pages. Create it in M0. It is separate from the `portfolio` repo (the jamisonducey.com Next.js site with a dark instrument-panel aesthetic, hosted on Vercel). Do not import portfolio conventions (dark theme, amber accent, JetBrains Mono) into `co-headwaters`. Pages URL path will be `/co-headwaters/`, so all asset and data paths in the site must be relative, not root-absolute.
2. Public audience rule from the project doc: no crypto vocabulary anywhere in public UI or copy (no "blockchain", "NEAR", "anchor", "on-chain"). The verification affordance is out of scope for this pass.
3. Structural framing rule: describe how systems function and who decides and who pays. No explicit ideological vocabulary.
4. Never fabricate data. Any number shown in the dashboard comes from a file the watcher produced, or the UI shows an explicit empty state.

## 1. Scope

In scope: (a) intro sequence, (b) call-to-action, (c) transition into (d) dashboard shell that reads JSON and renders honest empty/loading/stale states.

Out of scope: watcher/sealer pipeline, NEAR anchoring, comment drafting, Boulder franchise content, verification page.

## 2. Intended experience

1. Load: blank off-white page. Nothing else.
2. Colorado outline fades in, centered.
3. Rivers begin at their true headwaters and draw downstream at constant screen speed. The camera zooms out as they leave the frame. Each state fades in the moment a river first enters it.
4. Captions below the map state facts in sequence (section 6). Each caption is tied to a map event, not a timer alone.
5. Final caption is a call-to-action addressed to everyone affected. It holds; a button ("Enter Headwaters") advances, and it auto-advances after a 10 s hold. Decision recorded: auto-advance exists because the brief says the dashboard appears when the intro finishes; the button is the early exit.
6. The map does not disappear. It scales and translates into the dashboard's basin panel (shared element transition), the rest of the dashboard fades in around it.
7. Skip control visible from t=0 (bottom right, keyboard: Esc/Enter/Space). Returning visitors skip by default via `localStorage` flag (wrapped in try/catch); a "Replay intro" link lives in the dashboard footer.

Duration target: 40–50 s to CTA. Longer than that is a bounce risk; the Skip control is not optional.

## 3. River data (feasibility verified)

Source: USGS NLDI over NHDPlus V2. Endpoints tested and working from the build sandbox on 2026-09-20:

- Snap a point to a flowline: `GET https://api.water.usgs.gov/nldi/linked-data/comid/position?coords=POINT(<lon>%20<lat>)&f=json` → `properties.comid`.
- Downstream mainstem geometry: `GET https://api.water.usgs.gov/nldi/linked-data/comid/<comid>/navigation/DM/flowlines?f=json&distance=<km>`. Returns flowlines in flow order, source to mouth, each with `nhdplus_comid`.

Tested results (seed → DM trace, gap-free continuity check between consecutive flowlines, gaps = 0 for all):

| Seed river | Flowlines | Length traced | Ends at |
|---|---|---|---|
| Colorado | 1873 | 2135 km | US–Mexico border (-114.81, 32.49) |
| Green | 2410 | 2550 km | same border point (joins Colorado) |
| Yampa | 1927 | 2191 km | same |
| Gunnison | 1722 | 2017 km | same |
| San Juan | 1709 | 1847 km | same |
| Dolores | 1631 | 1971 km | same |
| Rio Grande | 1542 | 3054 km | Gulf of Mexico (-97.15, 25.96) |
| Arkansas | 2210 | 4010 km | Mississippi delta (-89.70, 29.50) |
| South Platte | 2209 | 4002 km | Mississippi delta (-89.68, 29.47) |
| North Platte | 2807 | 4006 km | Mississippi delta (-91.35, 30.70) |

Findings that change the design:

- Natural Earth 10m rivers is not adequate: it lacks Yampa, Gunnison, Dolores, and is coarse. Do not use it for rivers. It is acceptable for the state and country outlines.
- NHDPlus V2 ends at the US–Mexico border. The Colorado River below the border (delta) is not in the data. Terminate at the border; do not extrapolate.
- The seeds above are approximate and snap to a mid-stream point. They are not the true sources (Arkansas seed returned a start near -106.17, 39.30, which is downstream of the headwater lakes). The build script must first run `navigation/UM` (upstream mainstem, unverified endpoint behavior at large distance) from the seed to find the farthest headwater, then run DM from there. Validate each source coordinate against a named source (USGS GNIS or NPS/USGS documentation) and record the citation in `rivers.config.json`.
- Terminus policy (clip in the build script, do not draw to the delta): Colorado system → US–Mexico border; Rio Grande → Gulf of Mexico; Arkansas → Mississippi confluence; South and North Platte → Missouri confluence (Platte joins Missouri near Omaha/Plattsmouth; find by first flowline downstream whose name is Missouri, or by comid list). Downstream water economy beyond those points stays implied.
- Dedupe by `nhdplus_comid` across rivers. The first river to claim a flowline draws it. A later river stops at the first claimed comid, so tributaries visibly merge into the trunk. South Platte and North Platte merge at North Platte, NE.
- Confluence timing constraint: a tributary must arrive at its confluence no earlier than the trunk's drawn line reaches that point. Build script computes arrival times and delays the tributary start until satisfied. Assert in the build.

## 4. Architecture

Static site, no framework, no runtime dependencies. Vanilla JS modules + one SVG. Deployable on GitHub Pages as-is.

```
co-headwaters/
/index.html
/assets/style.css            tokens on :root, light theme only for the intro
/assets/intro.js             director + renderer
/assets/dashboard.js         shell
/data/map.json               generated; committed
/data/copy.json              captions + sources; hand-authored
/data/status.json            watcher output; may be absent (empty state)
/data/events.json            watcher output; may be absent
/scripts/build-map.mjs       dev-time only; Node 20+, d3-geo, topojson-simplify or simplify-js
/scripts/rivers.config.json  seeds, source citations, terminus rules
/tests/                      Playwright
```

Key decisions:

1. State is a pure function of time: `renderAt(t)`. A single master clock (rAF, `performance.now`, pausable) calls it. Skip = seek to end. Reduced motion = render at `t = END`. Tests screenshot at fixed `t`. No animation logic outside `renderAt`.
2. One SVG path per river (merged from its own, non-deduped flowlines, source to stop point). About 10 animated paths, not thousands. Draw with `stroke-dasharray`/`stroke-dashoffset` on `pathLength="1"`, or clip the path by prefix length. Headwater marker (small filled circle) appears at t_start with a brief pulse; river name in small caps label, fades after 3 s.
3. Projection at build time. Conic equal-area (Albers), parallels 29.5/45.5, central meridian -96. Output already-projected SVG path strings in a fixed 1000×~700 coordinate space. Runtime has no projection code.
4. Simplification at build time in projected space, tolerance ~0.4 px at 1000 px width. Budget: `map.json` ≤ 250 KB gzipped, total page ≤ 400 KB gzipped.
5. Camera: animate `viewBox`. Build script emits keyframes `{t, x, y, w, h}` derived from the union bbox of drawn geometry at each time plus margin; ease-in-out between keyframes; aspect ratio locked to container (letterbox on portrait).
6. State reveal: build script point-in-polygon tests each river vertex (projected or geographic) against state polygons, emitting `enterT` per state (first time any river enters it). State outlines fade over 1.2 s starting at `enterT`. Colorado is visible from t≈1.2 s.
7. Fills: none or ≤4% tint. Outlines 1 px, low contrast. Rivers 1.5–2 px, one ink-blue hue with lightness variation by system (Colorado / Rio Grande / Arkansas / Platte), not four saturated hues. Validate contrast (text ≥4.5:1, river vs background ≥3:1).
8. Tokens (starting values, adjust on review): bg `#F6F3EC`, ink `#1E2A33`, muted ink `#5B6770`, river `#2C6E91`, state line `#C9C4B8`, CTA accent `#B4471F`. System font stack; no external requests.
9. Captions: HTML element under the map, crossfade 400 ms, one caption visible at a time. Visually-hidden ordered list containing all captions is in the DOM from load; the animated SVG and live caption are `aria-hidden`. No `aria-live` announcements per beat.
10. No `<canvas>`/WebGL. SVG is enough for ~10 paths and keeps text crisp.

## 5. Beat sheet (target; tune in review)

| t (s) | Map | Caption |
|---|---|---|
| 0.0–1.2 | Blank | none |
| 1.2–3.0 | Colorado outline fades in | none |
| 3.0 | Headwater dots appear (Colorado, Rio Grande, Arkansas, South Platte, North Platte) staggered 0.3 s | C1 |
| 3.5–20 | Rivers draw; camera eases out; states fade in on entry | C1 → C3 |
| 12–24 | Green, Yampa, Gunnison, San Juan, Dolores start (timing constrained per section 3) and merge into the Colorado | C3 → C4 |
| 24–34 | All rivers reach terminus; full downstream map at rest | C4 → C6 |
| 34–44 | Map at rest, slow breathing highlight on terminus points | C7 → C8 |
| 44–54 | Final CTA card over map | CTA (10 s hold or button) |

## 6. Copy and sourcing

Rule: every factual caption has an entry in `copy.json` with `source_url`, `retrieved`, and `verify_before_ship`. Shipping check fails on any entry without a source. Numbers that could go stale carry an "as of" date rendered in small type.

| ID | Caption draft | Source | Status 2026-09-20 |
|---|---|---|---|
| C1 | The Arkansas, Colorado, Platte, and Rio Grande all begin in Colorado. | Water Education Colorado, Major River Basins | Verified (quote: "the Arkansas, Colorado, Platte, and the Rio Grande") |
| C2 | Most of Colorado's rivers begin in the Rocky Mountains and flow across state lines. | same | Verified |
| C3 | The Colorado River supplies more than 40 million people in seven states and Mexico. | Water Education Colorado, Colorado River Basin | Verified. Optional add: "about 75 percent of the water that feeds the river originates in Colorado" — read the full sentence on the page before use; the extraction was truncated |
| C3b | Water from these four systems crosses N states. | computed by build script from geometry | N is generated, not typed. Do not use "18 states"; not confirmed by any source found |
| C4 | Natural streamflow ran at 22% of normal from April through July, the lowest in 110 years. | Denver Water board resolution, 2026-08-26 | Reported by Denver Water. Confirm the geographic scope (Denver Water supply basins vs statewide) and word the caption to match. Attribute: "Denver Water reports" |
| C5 | Lake Powell and Lake Mead have reached record-low combined storage. | Western Water 2026-08-21 | Single secondary source. Verify against Reclamation before ship |
| C6 | On August 21, Reclamation set a two-year operating plan for 2027–2028 inside a ten-year framework. Lower Basin cuts are mandatory: 1.25 million acre-feet per year. Upper Basin participation is voluntary. | Western Water 2026-08-21; Reclamation ROD PDF (usbr.gov/ColoradoRiverBasin/post2026/decision-doc/P26_RecordofDecision_Final.pdf) | Secondary verified. Confirm figures in the ROD PDF. The ten-year framework does not lock in amounts for the decade |
| C7 | On August 26, Denver Water ordered lawn watering to end October 1, through at least spring 2027. Hand-watering of trees and gardens is still allowed. | Denver Water, board resolution page | Verified |
| C8 | On September 4, the Colorado PUC cut Xcel's requested gas rate increase from $190 million to $122.7 million a year. New rates take effect October 6. | puc.colorado.gov press release, 2026-09-04, Proceeding 25AL-0538G | Verified |
| C9 | Three exposures: the interstate compact, the utility, the local supply. A ratepayer carries the second whatever happens to the first. | Project analytical frame (three-axes) | Framing, not a factual claim. Keep as the closing statement before the CTA |
| CTA | Everyone downstream of these decisions is affected: people who drink this water, farm with it, heat homes with the gas, and pay the bills. This is the record. | none | Editorial. Jamison to approve wording |

Corrections to the project record discovered while sourcing (the project doc and memory notes are stale on these):

- The Xcel gas case (25AL-0538G) is not pending for a Q4 decision. The PUC announced its decision on 2026-09-04. Per the press release, a final written decision is expected about October 1, and parties have 20 days to seek reconsideration. The "hard deadline" sequencing in the project doc needs rewriting.
- The Colorado River decision is a two-year operating plan for 2027–2028 within a ten-year framework, not a flat "2027–2036 Decision Framework" with fixed terms.
- Denver Water's August 26 action: lawn watering ends October 1 (after September 30); the Stage 1 declaration was amended with additional restrictions. It is not immediate.

## 7. Dashboard shell (v1)

Purpose: answer the organizer's question, "is there anything to act on this week, and what do I say," and show what the record covers. No numbers without a source file.

Panels:

1. Basin map panel (the intro map, at rest, interactive hover on rivers shows name only).
2. "Open this week" panel: reads `events.json` filtered to items with a comment deadline. Empty state text: "No open proceedings are being tracked yet." Do not show the gas-case comment window as open; it is decided (section 6).
3. Three-axes timeline: three horizontal tracks (Compact, Utility, Local supply) on one time axis. Empty tracks render the axis and labels with "No records yet". Data comes from `events.json` entries with `axis: compact|utility|supply`.
4. Sources and freshness: one row per source (six from the project doc: PUC gas, PUC electric, Denver Water notices, Lake Powell elevation, reservoirs.earth, Colorado River decision documents) with `last_successful_poll` from `status.json`. Missing file, poll older than 2× cadence, or failed poll renders a visible amber-free warning state (use a distinct border + text, not color alone). Stale data is worse than none; the UI must say so.
5. Footer: Replay intro, methodology link (placeholder, no crypto terms), "Colorado only" scope statement.

Data contracts (JSON Schema files in `/schema`, validated in CI):

```json
// status.json
{"generated":"ISO-8601","sources":[{"id":"puc-25AL-0538G","label":"PUC gas rate case","cadence":"daily","last_success":"ISO-8601|null","last_error":"string|null"}]}
// events.json
{"events":[{"id":"…","date":"YYYY-MM-DD","axis":"compact|utility|supply","title":"…","source_url":"…","archive_url":"…|null","comment_deadline":"YYYY-MM-DD|null"}]}
```

## 8. Milestones

- M0. Create the `co-headwaters` repo; scaffold static structure; add tokens; set up Playwright; enable GitHub Pages. Done when `index.html` serves a blank off-white page from the Pages URL with relative paths resolving under `/co-headwaters/`.
- M1. `build-map.mjs`: rivers config with cited sources, UM→DM trace, dedupe, clip at terminus, projection, simplification, state entry times, camera keyframes, confluence timing assertions. Output `map.json` under budget. Done when a static SVG of the final frame matches a visual check of all ten rivers and their sources.
- M2. Static final-frame render from `map.json` (all layers). Screenshot review desktop + 390 px mobile.
- M3. Director and `renderAt(t)`: river draw, state reveal, camera, markers. Scrub control behind `?debug=1`. Done when screenshots at t = 2, 6, 12, 20, 30, END are stable and correct.
- M4. Captions from `copy.json`, source check script, hidden ordered list, reduced-motion path, skip, replay flag.
- M5. CTA card and shared-element transition into the dashboard panel.
- M6. Dashboard shell with schema-validated empty/stale states; fixture files used only in tests, never shipped.
- M7. Accessibility and performance pass: keyboard-only run, screen-reader read of the hidden list, `prefers-reduced-motion`, 60 fps on a throttled mid-tier mobile profile, payload budget.
- M8. Deploy to GitHub Pages; record commit and date in the repo README.

## 9. Acceptance criteria

- Blank off-white on load; Colorado visible by 3 s; no layout shift.
- Every river starts at a cited headwater coordinate. Every river line is continuous from source to terminus with no gaps (build assertion).
- No tributary appears to enter a trunk before the trunk is drawn there.
- Every state appears only after a river enters it; no state appears with no river in it.
- Each caption has a source entry and passes `check-copy`; dated claims show an as-of date.
- Skip works at any time; reduced-motion visitors see the final state with captions as a static list.
- Works without JavaScript: `<noscript>` shows the captions text and a link into the dashboard content.
- Text contrast ≥ 4.5:1; keyboard reachable Skip/Enter; no color-only state.
- Dashboard never shows a value not present in a data file; missing or stale files show explicit states.
- Payload ≤ 400 KB gzipped; no third-party requests.
- Zero occurrences of crypto vocabulary in shipped HTML, JS strings, or JSON (grep gate in CI).

## 10. Risks

- Intro length costs visitors who want data. Mitigation: Skip from t=0, default-skip for returners.
- NLDI is a third-party service. Mitigation: build-time only; commit `map.json`; cache raw NLDI responses in `/scripts/cache/` (git-ignored) to make builds repeatable.
- Data-currency drift in captions. Mitigation: dated captions, source check, a short list of claims to re-verify before each deploy.
- Duplicate merged lines look like a trunk from two colors. Mitigation: dedupe by comid; draw the trunk in its own color; tributaries in the trunk color family.
- Mobile portrait leaves a wide map small. Mitigation: caption sits below, map letterboxed, minimum river stroke 1.5 px, camera keyframes recomputed for portrait aspect.

## 11. First prompt to give Claude Code

"Read HEADWATERS_INTRO_PLAN.md. Create the `co-headwaters` repo. Execute M0 and M1 only. For M1, use the NLDI endpoints in section 3, add the UM step to find true headwaters, and stop with a rendered SVG of the final frame and a table of each river's source coordinate, the citation for it, and the terminus. Do not start M2 until the sources are reviewed."
