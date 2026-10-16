// Caption timing. Each caption is cued to a map event from map.json (a river
// starting or reaching its terminus, a state first entered, or the map coming
// to rest), not to a fixed timer. Captions then hold long enough to read: a
// cue that lands before the previous caption has had its reading time is
// pushed back. The schedule is a pure function of (captions, map), so the
// page, the tests and scripts/check-copy.mjs all derive the same timeline.
//
// No DOM access at module scope: Node imports this file too.

export const CAPTION_FADE_S = 0.2; // half of the 400 ms crossfade (plan 4.9)
const MIN_READ_S = 3.5;
const WORDS_PER_S = 4.5; // ~270 wpm
const READ_PAD_S = 1;

export const CUE_EVENTS = ['riverStart', 'riverEnd', 'stateEnter', 'end'];

export function mapEndT(map) {
  return Math.max(...map.rivers.map((r) => r.endT));
}

export function readingTime(text) {
  const words = text.trim().split(/\s+/).length;
  return Math.max(MIN_READ_S, READ_PAD_S + words / WORDS_PER_S);
}

// Map time of a cue, or throws naming what didn't resolve — a cue that points
// at a river or state the map doesn't have is a copy error, not a fallback.
export function resolveCue(cue, map) {
  const offset = cue.offset ?? 0;
  const river = (name) => {
    const r = map.rivers.find((x) => x.name === name);
    if (!r) throw new Error(`cue names unknown river "${name}"`);
    return r;
  };
  switch (cue.event) {
    case 'riverStart':
      return river(cue.river).startT + offset;
    case 'riverEnd':
      return river(cue.river).endT + offset;
    case 'stateEnter': {
      const s = map.states.find((x) => x.name === cue.state);
      if (!s) throw new Error(`cue names unknown state "${cue.state}"`);
      return s.enterT + offset;
    }
    case 'end':
      return mapEndT(map) + offset;
    default:
      throw new Error(`unknown cue event "${cue.event}"`);
  }
}

// captions: [{ id, text, cue }] in display order.
// Returns { items: [{ id, start, end }], end } where `end` is when the intro
// is over (last caption has held for its reading time).
export function buildSchedule(captions, map) {
  const items = [];
  let earliest = 0;
  for (const c of captions) {
    const start = Math.max(resolveCue(c.cue, map), earliest);
    items.push({ id: c.id, start, read: readingTime(c.text) });
    earliest = start + readingTime(c.text);
  }
  items.forEach((item, i) => {
    item.end = i + 1 < items.length ? items[i + 1].start : item.start + item.read;
  });
  const end = Math.max(mapEndT(map), items.length ? items.at(-1).end : 0);
  return { items: items.map(({ id, start, end: e }) => ({ id, start, end: e })), end };
}

// Index of the caption on screen at t and its opacity (crossfade: fade out
// over the last CAPTION_FADE_S of a window, next fades in over its first).
// The last caption stays up after its window instead of fading to nothing.
export function captionAt(t, schedule) {
  const { items } = schedule;
  for (let i = items.length - 1; i >= 0; i--) {
    const { start, end } = items[i];
    if (t < start) continue;
    const isLast = i === items.length - 1;
    const fadeIn = Math.min(1, (t - start) / CAPTION_FADE_S);
    const fadeOut = isLast ? 1 : Math.max(0, Math.min(1, (end - t) / CAPTION_FADE_S));
    return { index: i, opacity: Math.min(fadeIn, fadeOut) };
  }
  return { index: -1, opacity: 0 };
}
