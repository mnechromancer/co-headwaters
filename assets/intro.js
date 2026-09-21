// Intro director + renderer. State is a pure function of time: renderAt(t),
// driven by a single master clock (not implemented yet — M3). For now this
// just renders the static final frame from data/map.json so M2's layers can
// be reviewed: all rivers full-drawn, states shown, headwater + terminus
// markers. No camera, no captions, no animation yet.
//
// M3 label placement: don't pin river-name labels at the static headwater
// dot (M1's final-frame.svg review copy does this and several overlap —
// Colorado/Yampa/Gunnison/Arkansas/Platte headwaters all cluster in central
// CO). Instead, track each label to the leading edge of its river as it
// draws, per review feedback on the M1 static render.

const SVG_NS = 'http://www.w3.org/2000/svg';

function el(name, attrs = {}) {
  const node = document.createElementNS(SVG_NS, name);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
  return node;
}

function renderFinalFrame(map, container) {
  const svg = el('svg', {
    viewBox: `0 0 ${map.width} ${map.height}`,
    width: '100%',
    role: 'img',
    'aria-label': 'Map of Colorado-region rivers from source to terminus',
  });

  const states = el('g', { class: 'state-layer' });
  for (const state of map.states) {
    if (!state.path) continue;
    states.appendChild(el('path', { d: state.path, class: 'state-outline' }));
  }
  svg.appendChild(states);

  const rivers = el('g', { class: 'river-layer' });
  for (const river of map.rivers) {
    rivers.appendChild(el('path', { d: river.path, class: 'river-line' }));
  }
  svg.appendChild(rivers);

  const markers = el('g', { class: 'marker-layer' });
  for (const river of map.rivers) {
    const [hx, hy] = river.headwaterPx;
    markers.appendChild(el('circle', { cx: hx, cy: hy, r: 3, class: 'headwater-dot' }));
    if (river.terminusPx) {
      const [tx, ty] = river.terminusPx;
      markers.appendChild(el('circle', { cx: tx, cy: ty, r: 3, class: 'terminus-dot' }));
    }
  }
  svg.appendChild(markers);

  container.replaceChildren(svg);
}

async function init() {
  const container = document.getElementById('intro');
  if (!container) return;
  try {
    const res = await fetch('data/map.json');
    const map = await res.json();
    if (!map.rivers?.length) return; // placeholder map.json, nothing to draw yet
    renderFinalFrame(map, container);
  } catch (err) {
    console.error('Failed to load river map data:', err);
  }
}

init();
