// Intro director + renderer. State is a pure function of time: renderAt(t),
// driven by a single master clock (rAF-based, pausable/seekable). Skip =
// seek to end. Reduced motion = render once at t = END. A ?debug=1 scrub
// slider seeks the clock directly for review.
//
// No captions, skip control, or CTA yet (M4/M5) — this milestone (M3) is
// just the director: river draw, state reveal, camera, markers.

const SVG_NS = 'http://www.w3.org/2000/svg';
const STATE_FADE_S = 1.2; // plan section 4.6
const HEADWATER_FADE_S = 0.2;
const HEADWATER_PULSE_S = 1.0;
const TERMINUS_FADE_S = 0.5;
const LABEL_HOLD_S = 3.0; // plan section 4.2: "fades after 3s"
const LABEL_FADE_S = 0.5;

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

// Base sizes are in screen pixels; `scale` (current viewBox width / the map's
// native width) converts them to user-space units so dots and labels stay a
// constant apparent size on screen as the camera zooms in and out. Stroke
// widths don't need this — they use vector-effect: non-scaling-stroke (CSS).
const HEADWATER_DOT_PX = 3;
const HEADWATER_PULSE_MAX_PX = 18;
const TERMINUS_DOT_PX = 3;
const LABEL_FONT_PX = 11;
const LABEL_OFFSET_PX = 8;

function renderAt(t, scene, camera, endT, mapWidth) {
  const box = cameraBoxAt(t, camera, endT);
  const scale = box.w / mapWidth;
  scene.svg.setAttribute('viewBox', `${box.x.toFixed(1)} ${box.y.toFixed(1)} ${box.w.toFixed(1)} ${box.h.toFixed(1)}`);

  for (const { path, enterT } of scene.stateEls.values()) {
    path.style.opacity = clamp01((t - enterT) / STATE_FADE_S);
  }

  for (const r of scene.rivers.values()) {
    const { cfg, path, headwaterDot, headwaterPulse, terminusDot, label, totalLength } = r;
    const duration = cfg.endT - cfg.startT;
    const fraction = duration > 0 ? clamp01((t - cfg.startT) / duration) : (t >= cfg.startT ? 1 : 0);

    path.style.strokeDasharray = '1';
    path.style.strokeDashoffset = String(1 - fraction);

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

    const labelAge = t - cfg.startT;
    if (labelAge < 0) {
      label.style.opacity = '0';
    } else {
      const opacity = labelAge <= LABEL_HOLD_S
        ? 1
        : clamp01(1 - (labelAge - LABEL_HOLD_S) / LABEL_FADE_S);
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

function mountDebugScrubber(clock, endT) {
  const wrap = document.createElement('div');
  wrap.className = 'debug-scrubber';
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
  const container = document.getElementById('intro');
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

  const debugScrubber = new URLSearchParams(location.search).get('debug') === '1'
    ? mountDebugScrubber
    : null;

  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (reducedMotion) {
    renderAt(endT, scene, camera, endT, map.width);
    return;
  }

  const clock = createClock(endT, (t) => {
    renderAt(t, scene, camera, endT, map.width);
    if (scrubber) scrubber.sync(t);
  });
  const scrubber = debugScrubber ? debugScrubber(clock, endT) : null;
  clock.play();
}

init();
