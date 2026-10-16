// Intro director + renderer. State is a pure function of time: renderAt(t),
// driven by a single master clock (rAF-based, pausable/seekable). Skip =
// seek to end. Reduced motion = render the final frame once and show the
// captions as a static list. A ?debug=1 scrub slider seeks the clock
// directly for review.
//
// Captions come from the list in index.html (rendered there from
// data/copy.json by scripts/check-copy.mjs), timed by assets/captions.js.
// No CTA yet (M5).

import { buildSchedule, captionAt } from './captions.js';

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
  const markerLayer = el('g', { class: 'marker-layer' });
  const labelLayer = el('g', { class: 'label-layer' });
  const rivers = new Map();

  for (const river of map.rivers) {
    const path = el('path', { d: river.path, class: 'river-line', pathLength: '1' });
    riverLayer.appendChild(path);

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

    const label = el('text', { class: 'river-label' });
    label.textContent = river.name;
    labelLayer.appendChild(label);

    rivers.set(river.name, {
      cfg: river,
      path,
      headwaterDot,
      headwaterPulse,
      terminusDot,
      label,
      totalLength: null, // filled in after mount, once layout exists
    });
  }
  svg.appendChild(riverLayer);
  svg.appendChild(markerLayer);
  svg.appendChild(labelLayer);

  container.replaceChildren(svg);

  // getTotalLength() needs the path in the document.
  for (const r of rivers.values()) r.totalLength = r.path.getTotalLength();

  return { svg, stateEls, rivers };
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
const LABEL_FONT_PX = 11;
const LABEL_OFFSET_PX = 8;

// How many user-space units one screen pixel is worth right now. preserveAspect
// Ratio is the default "meet", so the effective zoom is whichever of the two
// axes is the tighter fit; taking the min keeps sizes right whether the box or
// the element is the taller of the two.
function userUnitsPerScreenPx(svg, box, mapWidth) {
  const rect = svg.getBoundingClientRect();
  const pxPerUnit = Math.min(
    rect.width > 0 ? rect.width / box.w : Infinity,
    rect.height > 0 ? rect.height / box.h : Infinity
  );
  return pxPerUnit > 0 && Number.isFinite(pxPerUnit) ? 1 / pxPerUnit : box.w / mapWidth;
}

function renderAt(t, scene, camera, endT, mapWidth) {
  renderMap(t, scene, camera, endT, mapWidth);
  if (scene.captions) renderCaption(t, scene.captions);
  if (scene.skip) scene.skip.hidden = t >= scene.captions.schedule.end;
}

// One caption element; its text swaps when the active caption changes and
// its opacity carries the crossfade.
function renderCaption(t, captions) {
  const { index, opacity } = captionAt(t, captions.schedule);
  if (index !== captions.shown) {
    captions.el.replaceChildren(...(index >= 0 ? captions.nodes[index].map((n) => n.cloneNode(true)) : []));
    captions.shown = index;
  }
  captions.el.style.opacity = String(opacity);
}

function renderMap(t, scene, camera, endT, mapWidth) {
  const box = cameraBoxAt(t, camera, endT);
  const scale = userUnitsPerScreenPx(scene.svg, box, mapWidth);
  scene.svg.setAttribute('viewBox', `${box.x.toFixed(1)} ${box.y.toFixed(1)} ${box.w.toFixed(1)} ${box.h.toFixed(1)}`);

  for (const { path, enterT } of scene.stateEls.values()) {
    path.style.opacity = clamp01((t - enterT) / STATE_FADE_S);
  }

  for (const r of scene.rivers.values()) {
    const { cfg, path, headwaterDot, headwaterPulse, terminusDot, label, totalLength } = r;
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
        const pt = path.getPointAtLength(fraction * totalLength);
        label.setAttribute('x', pt.x.toFixed(1));
        label.setAttribute('y', (pt.y - LABEL_OFFSET_PX * scale).toFixed(1));
        label.setAttribute('font-size', (LABEL_FONT_PX * scale).toFixed(2));
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

// Esc, Enter and Space skip, unless focus is on another control that owns
// those keys (the skip button handles its own Enter/Space as a click).
function mountSkip(button, onSkip, isRunning) {
  button.addEventListener('click', onSkip);
  document.addEventListener('keydown', (e) => {
    if (!isRunning() || e.defaultPrevented || e.altKey || e.ctrlKey || e.metaKey) return;
    if (!['Escape', 'Enter', ' '].includes(e.key)) return;
    const target = e.target;
    if (target !== document.body && target !== button && target.closest?.('a, button, input, select, textarea, [contenteditable]')) return;
    if (target === button && e.key !== 'Escape') return;
    e.preventDefault();
    onSkip();
  });
}

function mountDebugScrubber(clock, endT) {
  const wrap = document.createElement('div');
  wrap.className = 'debug-scrubber';
  document.body.classList.add('debug');
  wrap.innerHTML = `
    <button type="button" data-action="toggle">Pause</button>
    <input type="range" min="0" max="${endT}" step="0.01" value="0" />
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

  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (reducedMotion) {
    // Final frame, captions as a static list instead of the live caption,
    // nothing to skip. renderMap sizes dots/labels/strokes off the SVG's
    // laid-out box, which isn't final on the first pass, so re-render once
    // layout has settled and again if the window is resized (the animated path
    // self-corrects every frame; this one has no second chance).
    document.body.classList.add('static-captions');
    if (skipButton) skipButton.hidden = true;
    const draw = () => renderMap(endT, scene, camera, endT, map.width);
    draw();
    requestAnimationFrame(draw);
    window.addEventListener('resize', draw);
    return;
  }

  const captionList = readCaptions();
  const schedule = buildSchedule(captionList, map);
  const introEnd = schedule.end;
  scene.captions = {
    el: document.getElementById('caption'),
    schedule,
    nodes: captionList.map((c) => c.nodes),
    shown: null,
  };
  scene.skip = skipButton;

  let completed = false;
  const complete = () => {
    if (completed) return;
    completed = true;
    markIntroSeen();
  };

  const clock = createClock(introEnd, (t) => {
    renderAt(t, scene, camera, endT, map.width);
    if (scrubber) scrubber.sync(t);
    if (t >= introEnd) complete();
  });
  const scrubber = params.get('debug') === '1' ? mountDebugScrubber(clock, introEnd) : null;

  const skip = () => {
    // Keep focus somewhere sensible once the button hides itself.
    if (document.activeElement === skipButton) skipButton.blur();
    clock.pause();
    clock.seek(introEnd);
  };
  if (skipButton) mountSkip(skipButton, skip, () => clock.time < introEnd);

  // ?replay=1 plays the intro even after it has been seen (the dashboard's
  // "Replay intro" link, M6). Debug review always starts from the top.
  if (introSeen() && params.get('replay') !== '1' && !scrubber) {
    clock.seek(introEnd);
    // Same layout-settling re-render as the reduced-motion path.
    requestAnimationFrame(() => clock.seek(introEnd));
    return;
  }
  clock.play();
}

init();
