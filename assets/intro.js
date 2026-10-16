// Intro director + renderer. State is a pure function of time: renderAt(t),
// driven by a single master clock (rAF-based, pausable/seekable). Skip =
// seek to end. Reduced motion = render the final frame once and show the
// captions as a static list. A ?debug=1 scrub slider seeks the clock
// directly for review.
//
// Captions come from the list in index.html (rendered there from
// data/copy.json by scripts/check-copy.mjs), timed by assets/captions.js.
// After the last caption the call-to-action card holds, then the map scales
// and moves into the dashboard's basin panel (shared-element transition) as
// the dashboard fades in around it. All of that is a function of t too, so
// the debug scrubber and the tests can seek into the middle of it.

import { buildSchedule, captionAt, timeline, CTA_FADE_S, TRANSITION_S } from './captions.js';

const SVG_NS = 'http://www.w3.org/2000/svg';
const STATE_FADE_S = 1.2; // plan section 4.6
const HEADWATER_FADE_S = 0.2;
const HEADWATER_PULSE_S = 1.0;
const TERMINUS_FADE_S = 0.5;
// Labels ride the drawing tip, so their lifetime is tied to the draw, not to
// a flat timer. The plan (section 4.2) said "fades after 3s" from the river's
// start; in practice that fades the label out mid-draw for every river longer
// than ~3s of drawing (i.e. all but two), and — because five tributaries all
// start at the same beat — pops five labels on and off together for no reason
// visible on screen. Fade in at the headwater, follow the tip, then fade out a
// beat after the river reaches its terminus.
const LABEL_FADE_IN_S = 0.4;
const LABEL_HOLD_AFTER_END_S = 1.2;
const LABEL_FADE_S = 0.6;

function el(name, attrs = {}) {
  const node = document.createElementNS(SVG_NS, name);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
  return node;
}

function clamp01(x) {
  return Math.max(0, Math.min(1, x));
}

// Smoothstep easing for camera interpolation between keyframes.
function ease(t) {
  return t * t * (3 - 2 * t);
}

function buildScene(map, container) {
  const svg = el('svg', {
    viewBox: `0 0 ${map.width} ${map.height}`,
    width: '100%',
    role: 'img',
    'aria-label': 'Map of Colorado-region rivers from source to terminus',
  });

  const stateLayer = el('g', { class: 'state-layer' });
  const stateEls = new Map();
  for (const state of map.states) {
    if (!state.path) continue;
    const path = el('path', { d: state.path, class: 'state-outline' });
    stateLayer.appendChild(path);
    stateEls.set(state.name, { path, enterT: state.enterT });
  }
  svg.appendChild(stateLayer);

  const riverLayer = el('g', { class: 'river-layer' });
  // Wide invisible strokes over each river: hover targets in the dashboard
  // (thin river lines are too hard to hit).
  const hitLayer = el('g', { class: 'hit-layer' });
  const markerLayer = el('g', { class: 'marker-layer' });
  // River names are HTML over the SVG, not SVG text: SVG text re-lays out
  // whenever its on-screen size or position changes, and moving ten labels
  // with the drawing tips made that most of each frame's layout cost. HTML
  // labels move by CSS transform, which needs no layout.
  const labelLayer = document.createElement('div');
  labelLayer.className = 'label-layer';
  const rivers = new Map();

  for (const river of map.rivers) {
    const path = el('path', { d: river.path, class: 'river-line', pathLength: '1' });
    riverLayer.appendChild(path);
    const hit = el('path', { d: river.path, class: 'river-hit', 'data-river': river.name });
    hitLayer.appendChild(hit);

    const [hx, hy] = river.headwaterPx;
    const headwaterDot = el('circle', { cx: hx, cy: hy, r: 3, class: 'headwater-dot' });
    const headwaterPulse = el('circle', { cx: hx, cy: hy, r: 3, class: 'headwater-pulse' });
    markerLayer.appendChild(headwaterPulse);
    markerLayer.appendChild(headwaterDot);

    let terminusDot = null;
    if (river.terminusPx) {
      const [tx, ty] = river.terminusPx;
      terminusDot = el('circle', { cx: tx, cy: ty, r: 3, class: 'terminus-dot' });
      markerLayer.appendChild(terminusDot);
    }

    const label = document.createElement('span');
    label.className = 'river-label';
    label.textContent = river.name;
    labelLayer.appendChild(label);

    rivers.set(river.name, {
      cfg: river,
      path,
      headwaterDot,
      headwaterPulse,
      terminusDot,
      label,
      hit,
      totalLength: null, // filled in after mount, once layout exists
    });
  }
  svg.appendChild(riverLayer);
  svg.appendChild(markerLayer);
  svg.appendChild(hitLayer);

  container.replaceChildren(svg, labelLayer);

  // Geometry needs the path in the document. Each river's points along its
  // length are sampled once here: calling getPointAtLength every frame,
  // after that frame's style writes, forced a layout per river per frame
  // (~11 per frame), which halved the frame rate on a throttled phone.
  for (const r of rivers.values()) {
    r.totalLength = r.path.getTotalLength();
    const n = Math.max(2, Math.min(4000, Math.ceil(r.totalLength / 0.5)));
    r.samples = new Float32Array(n * 2);
    for (let i = 0; i < n; i++) {
      const pt = r.path.getPointAtLength((i / (n - 1)) * r.totalLength);
      r.samples[i * 2] = pt.x;
      r.samples[i * 2 + 1] = pt.y;
    }
  }

  return { svg, labelLayer, stateEls, rivers };
}

// Base sizes are in screen pixels; `scale` (user-space units per screen pixel,
// from the camera box against the SVG's laid-out box) converts them to
// user-space units so dots, labels and river strokes stay a constant apparent
// size as the camera zooms in and out — and, just as importantly, at any
// viewport width. (Scaling by the map's native 1000 instead of the rendered
// width made everything shrink with the screen: ~4px labels and hairline
// rivers on a 390px phone.)
const HEADWATER_DOT_PX = 3;
const HEADWATER_PULSE_MAX_PX = 18;
const TERMINUS_DOT_PX = 3;
const RIVER_STROKE_PX = 1.5;
const LABEL_OFFSET_PX = 8;
const HIT_STROKE_PX = 12;

// How many user-space units one screen pixel is worth right now. preserveAspect
// Ratio is the default "meet", so the effective zoom is whichever of the two
// axes is the tighter fit; taking the min keeps sizes right whether the box or
// the element is the taller of the two.
function userUnitsPerScreenPx(scene, box, mapWidth) {
  const rect = svgBox(scene);
  const pxPerUnit = Math.min(
    rect.width > 0 ? rect.width / box.w : Infinity,
    rect.height > 0 ? rect.height / box.h : Infinity
  );
  return pxPerUnit > 0 && Number.isFinite(pxPerUnit) ? 1 / pxPerUnit : box.w / mapWidth;
}

// The SVG's on-screen box. In the intro its size is fixed for the whole
// sequence (aspect ratio set from the tallest camera frame, so the camera
// letterboxes inside it rather than resizing it), so it is measured once and
// again on resize; reading it every frame, right after the viewBox write,
// forced a layout per frame. During the transition and in the dashboard it
// is measured (the transform and the panel decide it there).
function svgBox(scene) {
  const { svg } = scene;
  const home = scene.layout?.home;
  if (home && svg.parentNode === home && !svg.style.transform) {
    if (!scene.homeBox) {
      const r = svg.getBoundingClientRect();
      scene.homeBox = { width: r.width, height: r.height };
    }
    return scene.homeBox;
  }
  return svg.getBoundingClientRect();
}

function renderAt(t, scene, camera, endT, mapWidth) {
  const { stage } = scene;
  const p = t >= stage.end ? 1 : ease(clamp01((t - stage.ctaEnd) / TRANSITION_S));
  // Camera first (the SVG's box follows the viewBox aspect), then place the
  // map, then draw: renderMap sizes strokes and dots from the SVG's
  // on-screen box, which the transition is changing.
  applyCamera(t, scene, camera, endT);
  placeMap(scene, p);
  renderMap(t, scene, camera, endT, mapWidth);

  const ctaIn = clamp01((t - stage.introEnd) / CTA_FADE_S);
  renderCaption(t, scene.captions, 1 - ctaIn);
  scene.cta.hidden = t < stage.introEnd || p >= 1;
  scene.cta.style.opacity = String(ctaIn * (1 - p));
  scene.skip.hidden = t >= stage.introEnd;
}

// One caption element; its text swaps when the active caption changes and
// its opacity carries the crossfade (and the fade out as the CTA comes in).
function renderCaption(t, captions, fade) {
  const { index, opacity } = captionAt(t, captions.schedule);
  if (index !== captions.shown) {
    captions.el.replaceChildren(...(index >= 0 ? captions.nodes[index].map((n) => n.cloneNode(true)) : []));
    captions.shown = index;
  }
  captions.el.style.opacity = String(opacity * fade);
}

// p = 0: map in the intro. p = 1: map in the dashboard's basin panel.
// In between, the SVG stays in the intro (now a fixed, transparent overlay)
// and is transformed so its drawn content moves from where it sits in the
// intro to the panel slot, while the dashboard fades in underneath and the
// rest of the intro fades out.
function placeMap(scene, p) {
  const { svg, home, slot, dashboard } = scene.layout;
  const body = document.body;
  if (p >= 1) {
    if (svg.parentNode !== slot) slot.prepend(svg);
    svg.style.transform = '';
    body.classList.remove('transitioning');
    body.classList.add('dashboard-mode');
    dashboard.style.opacity = '';
    return;
  }
  if (svg.parentNode !== home) home.appendChild(svg);
  body.classList.remove('dashboard-mode');
  svg.style.transform = '';
  if (p <= 0) {
    body.classList.remove('transitioning');
    dashboard.style.opacity = '';
    return;
  }
  body.classList.add('transitioning');
  dashboard.style.opacity = String(p);

  // The SVG box can be letterboxed (its max-height caps it), so move the
  // drawn content box, not the element box. The slot has the viewBox's
  // aspect ratio, so there the content fills it exactly.
  const from = svg.getBoundingClientRect();
  const to = slot.getBoundingClientRect();
  const vb = svg.viewBox.baseVal;
  const fit = Math.min(from.width / vb.width, from.height / vb.height);
  const cw = vb.width * fit;
  const ch = vb.height * fit;
  const ox = (from.width - cw) / 2;
  const oy = (from.height - ch) / 2;
  const left = from.left + ox + (to.left - (from.left + ox)) * p;
  const top = from.top + oy + (to.top - (from.top + oy)) * p;
  const k = (cw + (to.width - cw) * p) / cw;
  svg.style.transformOrigin = '0 0';
  svg.style.transform = `translate(${(left - from.left - ox * k).toFixed(2)}px, ${(top - from.top - oy * k).toFixed(2)}px) scale(${k.toFixed(4)})`;
}

// Where the camera box sits inside #map, in CSS px, for placing the HTML
// labels: { left, top, k } with k = CSS px per map unit. Only meaningful
// while the SVG is in the intro and untransformed (labels have faded out
// before the transition starts).
function labelFrame(scene, box) {
  if (scene.frame?.box === box) return scene.frame;
  const svgSize = svgBox(scene);
  if (!scene.homeWidth) scene.homeWidth = scene.layout?.home.clientWidth ?? svgSize.width;
  const k = Math.min(svgSize.width / box.w, svgSize.height / box.h);
  const left = (scene.homeWidth - svgSize.width) / 2 + (svgSize.width - box.w * k) / 2;
  const top = (svgSize.height - box.h * k) / 2;
  scene.frame = { box, left, top, k };
  return scene.frame;
}

// Point at `fraction` of a river's length, from the samples taken in buildScene.
function pointAt(samples, fraction) {
  const n = samples.length / 2;
  const f = clamp01(fraction) * (n - 1);
  const i = Math.min(n - 2, Math.floor(f));
  const k = f - i;
  return [
    samples[i * 2] + (samples[i * 2 + 2] - samples[i * 2]) * k,
    samples[i * 2 + 1] + (samples[i * 2 + 3] - samples[i * 2 + 1]) * k,
  ];
}

function applyCamera(t, scene, camera, endT) {
  const box = cameraBoxAt(t, camera, endT);
  scene.svg.setAttribute('viewBox', `${box.x.toFixed(1)} ${box.y.toFixed(1)} ${box.w.toFixed(1)} ${box.h.toFixed(1)}`);
  return box;
}

function renderMap(t, scene, camera, endT, mapWidth) {
  const box = applyCamera(t, scene, camera, endT);
  const scale = userUnitsPerScreenPx(scene, box, mapWidth);

  for (const { path, enterT } of scene.stateEls.values()) {
    path.style.opacity = clamp01((t - enterT) / STATE_FADE_S);
  }

  for (const r of scene.rivers.values()) {
    const { cfg, path, headwaterDot, headwaterPulse, terminusDot, label, hit } = r;
    hit.style.strokeWidth = (HIT_STROKE_PX * scale).toFixed(3);
    const duration = cfg.endT - cfg.startT;
    const fraction = duration > 0 ? clamp01((t - cfg.startT) / duration) : (t >= cfg.startT ? 1 : 0);

    // pathLength="1" normalises the path to one unit, so a dash of 1 unit
    // followed by a gap of 1 unit, shifted by (1 - fraction), reveals exactly
    // the first `fraction` of the line, growing from the headwater.
    path.style.strokeDasharray = '1';
    path.style.strokeDashoffset = String(1 - fraction);
    path.style.strokeWidth = (RIVER_STROKE_PX * scale).toFixed(3);

    headwaterDot.style.opacity = clamp01((t - cfg.startT) / HEADWATER_FADE_S);
    headwaterDot.setAttribute('r', (HEADWATER_DOT_PX * scale).toFixed(2));

    const pulseAge = t - cfg.startT;
    if (pulseAge >= 0 && pulseAge <= HEADWATER_PULSE_S) {
      const pulseT = pulseAge / HEADWATER_PULSE_S;
      headwaterPulse.setAttribute('r', (HEADWATER_DOT_PX + pulseT * HEADWATER_PULSE_MAX_PX) * scale);
      headwaterPulse.style.opacity = String(1 - pulseT);
    } else {
      headwaterPulse.style.opacity = '0';
    }

    if (terminusDot) {
      terminusDot.setAttribute('r', (TERMINUS_DOT_PX * scale).toFixed(2));
      terminusDot.style.opacity = fraction >= 1 ? String(clamp01((t - cfg.endT) / TERMINUS_FADE_S)) : '0';
    }

    // Fade in as the river leaves its headwater, ride the tip for the whole
    // draw, then fade out a beat after it lands at its terminus.
    const fadeOutStart = cfg.endT + LABEL_HOLD_AFTER_END_S;
    if (t < cfg.startT) {
      label.style.opacity = '0';
    } else {
      const opacity = Math.min(
        clamp01((t - cfg.startT) / LABEL_FADE_IN_S),
        clamp01(1 - (t - fadeOutStart) / LABEL_FADE_S)
      );
      label.style.opacity = String(opacity);
      if (opacity > 0) {
        // World point -> CSS px in #map: the camera box is fitted ("meet")
        // and centred in the SVG box, which is centred in #map.
        const [px, py] = pointAt(r.samples, fraction);
        const view = labelFrame(scene, box);
        // Kept inside the map area so names at the edge aren't cut off.
        // Width is measured once (fixed text and font).
        r.labelWidth ??= label.offsetWidth;
        r.labelHeight ??= label.offsetHeight;
        const half = r.labelWidth / 2 + 2;
        const sx = Math.min(Math.max(view.left + (px - box.x) * view.k, half), scene.homeWidth - half);
        const sy = view.top + (py - box.y) * view.k - LABEL_OFFSET_PX;
        // Whole pixels: crisp text, and identical frames for the same t.
        label.style.transform = `translate(${Math.round(sx - r.labelWidth / 2)}px, ${Math.round(sy - r.labelHeight)}px)`;
      }
    }
  }
}

function cameraBoxAt(t, camera, endT) {
  const clamped = Math.max(0, Math.min(endT, t));
  let i = 0;
  while (i < camera.length - 2 && camera[i + 1].t < clamped) i++;
  const a = camera[i];
  const b = camera[Math.min(i + 1, camera.length - 1)];
  const span = b.t - a.t;
  const localT = span > 0 ? ease(clamp01((clamped - a.t) / span)) : 0;
  return {
    x: a.x + (b.x - a.x) * localT,
    y: a.y + (b.y - a.y) * localT,
    w: a.w + (b.w - a.w) * localT,
    h: a.h + (b.h - a.h) * localT,
  };
}

function createClock(endT, onTick) {
  let t = 0;
  let running = false;
  let lastFrameTime = null;
  let rafId = null;

  function frame(now) {
    if (!running) return;
    if (lastFrameTime !== null) {
      t = Math.min(endT, t + (now - lastFrameTime) / 1000);
    }
    lastFrameTime = now;
    onTick(t);
    if (t < endT) {
      rafId = requestAnimationFrame(frame);
    } else {
      running = false;
    }
  }

  return {
    play() {
      if (running) return;
      running = true;
      lastFrameTime = null;
      rafId = requestAnimationFrame(frame);
    },
    pause() {
      running = false;
      if (rafId) cancelAnimationFrame(rafId);
    },
    seek(value) {
      t = Math.max(0, Math.min(endT, value));
      onTick(t);
    },
    get time() {
      return t;
    },
  };
}

// Captions as written into index.html: text plus an optional as-of line.
function readCaptions() {
  return [...document.querySelectorAll('#caption-list li')].map((li) => ({
    id: li.dataset.id,
    cue: JSON.parse(li.dataset.cue),
    text: li.querySelector('.caption-text').textContent,
    nodes: [...li.childNodes],
  }));
}

// Returning visitors skip the intro by default (plan 2.7). Storage can be
// unavailable (private mode, blocked site data), so every access is guarded
// and a failure just means the intro plays.
const SEEN_KEY = 'headwaters:intro-seen';

function introSeen() {
  try {
    return localStorage.getItem(SEEN_KEY) === '1';
  } catch {
    return false;
  }
}

function markIntroSeen() {
  try {
    localStorage.setItem(SEEN_KEY, '1');
  } catch {
    // Nothing to do: the intro will just play again next visit.
  }
}

// Esc, Enter and Space act on the intro unless focus is on another control
// that owns those keys: during the captions they skip; on the CTA card,
// Enter/Space enter the dashboard and Esc skips the transition.
function mountKeys({ skip, enter, phase, ownButtons }) {
  document.addEventListener('keydown', (e) => {
    if (e.defaultPrevented || e.altKey || e.ctrlKey || e.metaKey) return;
    if (!['Escape', 'Enter', ' '].includes(e.key)) return;
    const current = phase();
    if (current === 'done') return;
    const target = e.target;
    const ownButton = ownButtons.includes(target);
    if (ownButton && e.key !== 'Escape') return; // the button's own click handles it
    if (!ownButton && target !== document.body && target.closest?.('a, button, input, select, textarea, [contenteditable]')) return;
    e.preventDefault();
    if (current === 'captions' || e.key === 'Escape') skip();
    else enter();
  });
}

// Dashboard map: hovering a river shows its name, nothing else (plan 7.1).
function mountRiverHover(svg, slot) {
  const tip = document.createElement('div');
  tip.className = 'river-tip';
  tip.hidden = true;
  slot.appendChild(tip);
  svg.addEventListener('pointermove', (e) => {
    const name = e.target.dataset?.river;
    if (!name || !document.body.classList.contains('dashboard-mode')) {
      tip.hidden = true;
      return;
    }
    const box = slot.getBoundingClientRect();
    tip.textContent = name;
    tip.style.left = `${e.clientX - box.left}px`;
    tip.style.top = `${e.clientY - box.top}px`;
    tip.hidden = false;
  });
  svg.addEventListener('pointerleave', () => {
    tip.hidden = true;
  });
}

function mountDebugScrubber(clock, endT) {
  const wrap = document.createElement('div');
  wrap.className = 'debug-scrubber';
  document.body.classList.add('debug');
  wrap.innerHTML = `
    <button type="button" data-action="toggle">Pause</button>
    <input type="range" min="0" max="${Math.ceil(endT * 100) / 100}" step="0.01" value="0" />
    <span data-role="t">0.00</span>
  `;
  document.body.appendChild(wrap);

  const button = wrap.querySelector('[data-action="toggle"]');
  const slider = wrap.querySelector('input');
  const readout = wrap.querySelector('[data-role="t"]');
  let playing = true;

  button.addEventListener('click', () => {
    playing = !playing;
    button.textContent = playing ? 'Pause' : 'Play';
    if (playing) clock.play(); else clock.pause();
  });

  slider.addEventListener('input', () => {
    playing = false;
    button.textContent = 'Play';
    clock.pause();
    clock.seek(Number(slider.value));
  });

  return {
    sync(t) {
      slider.value = String(t);
      readout.textContent = t.toFixed(2);
    },
  };
}

async function init() {
  const container = document.getElementById('map');
  if (!container) return;
  let map;
  try {
    const res = await fetch('data/map.json');
    map = await res.json();
  } catch (err) {
    console.error('Failed to load river map data:', err);
    return;
  }
  if (!map.rivers?.length) return; // placeholder map.json, nothing to draw yet

  const scene = buildScene(map, container);
  const endT = Math.max(...map.rivers.map((r) => r.endT));
  const camera = map.camera;
  const params = new URLSearchParams(location.search);
  const skipButton = document.getElementById('skip');
  const enterButton = document.getElementById('enter');
  const heading = document.getElementById('dash-title');
  const slot = document.getElementById('map-slot');
  const last = camera[camera.length - 1];
  slot.style.aspectRatio = `${last.w} / ${last.h}`;
  slot.style.setProperty('--map-aspect', String(last.w / last.h));
  // A constant box for the intro map: tall enough for the tallest camera
  // frame (plan 4.5: aspect locked to the container, letterboxed). Letting
  // the box follow each frame's aspect resized it every frame, which moved
  // the caption under it and forced a page layout per frame.
  const tallest = Math.max(...camera.map((c) => c.h / c.w));
  scene.svg.style.aspectRatio = `1 / ${tallest.toFixed(4)}`;
  scene.layout = {
    svg: scene.svg,
    home: container,
    slot,
    dashboard: document.getElementById('dashboard'),
    intro: document.getElementById('intro'),
  };
  mountRiverHover(scene.svg, slot);

  const captionList = readCaptions();
  const schedule = buildSchedule(captionList, map);
  const stage = timeline(schedule);
  scene.stage = stage;
  scene.captions = {
    el: document.getElementById('caption'),
    schedule,
    nodes: captionList.map((c) => c.nodes),
    shown: null,
  };
  scene.cta = document.getElementById('cta');
  scene.skip = skipButton;

  // Arriving at the dashboard: remember the visit, and if the visitor got
  // here by acting (or focus was on intro controls that are now gone), put
  // focus at the top of the dashboard.
  let arrived = false;
  let focusOnArrival = false;
  const arrive = () => {
    if (arrived) return;
    arrived = true;
    markIntroSeen();
    const intro = scene.layout.intro;
    if (focusOnArrival || intro.contains(document.activeElement)) heading.focus();
  };

  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (reducedMotion) {
    // Final frame and the CTA, captions as a static list instead of the live
    // caption, nothing to skip, no auto-advance (the visitor is reading a
    // list). Entering the dashboard is a cut, not an animation.
    // renderMap sizes dots/labels/strokes off the SVG's laid-out box, which
    // isn't final on the first pass, so re-render once layout has settled and
    // again on resize (the animated path self-corrects every frame).
    document.body.classList.add('static-captions');
    skipButton.hidden = true;
    scene.cta.hidden = false;
    let inDashboard = false;
    const draw = () => {
      placeMap(scene, inDashboard ? 1 : 0);
      renderMap(endT, scene, camera, endT, map.width);
    };
    const showDashboard = () => {
      inDashboard = true;
      focusOnArrival = true;
      draw();
      arrive();
    };
    enterButton.addEventListener('click', showDashboard);
    if (introSeen() && params.get('replay') !== '1') {
      inDashboard = true;
      arrive();
    }
    draw();
    requestAnimationFrame(draw);
    window.addEventListener('resize', () => {
      scene.homeBox = null;
      scene.homeWidth = null;
      draw();
    });
    return;
  }

  const clock = createClock(stage.end, (t) => {
    renderAt(t, scene, camera, endT, map.width);
    if (scrubber) scrubber.sync(t);
    if (t >= stage.end) arrive();
  });
  const scrubber = params.get('debug') === '1' ? mountDebugScrubber(clock, stage.end) : null;
  window.addEventListener('resize', () => {
    scene.homeBox = null;
    scene.homeWidth = null;
    renderAt(clock.time, scene, camera, endT, map.width);
  });

  const skip = () => {
    focusOnArrival = true;
    clock.pause();
    clock.seek(stage.end);
  };
  const enter = () => {
    focusOnArrival = true;
    clock.seek(Math.max(clock.time, stage.ctaEnd));
    clock.play();
  };
  skipButton.addEventListener('click', skip);
  enterButton.addEventListener('click', enter);
  mountKeys({
    skip,
    enter,
    ownButtons: [skipButton, enterButton],
    phase: () => {
      const t = clock.time;
      if (t < stage.introEnd) return 'captions';
      if (t < stage.ctaEnd) return 'cta';
      return 'done';
    },
  });

  // ?replay=1 plays the intro even after it has been seen (the dashboard's
  // "Replay intro" link). Debug review always starts from the top.
  if (introSeen() && params.get('replay') !== '1' && !scrubber) {
    clock.seek(stage.end);
    // Same layout-settling re-render as the reduced-motion path.
    requestAnimationFrame(() => clock.seek(stage.end));
    return;
  }
  clock.play();
}

init();
