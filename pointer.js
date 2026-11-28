// What the in-page agent pointer shows for one action: page.overlay draws it.
//
// While an agent drives a tab, a red dot marks where its mouse is, pulses when it
// clicks, and a red caret marks a field it typed into — so the person watching can
// follow along. It is drawn only from here, i.e. only for an agent's action: the
// person's own mouse never moves it.
//
// Pure, like policy.js: no chrome.*, no DOM, so `node --test` covers it. background.js
// turns each pointer op into a command with `pointerCommand` and hands it to
// page.overlay, which restates nothing from here — it only draws what it is given.

// How long the dot stays after the agent's last action before it fades out. Like a
// mouse cursor, it stays where the agent left it — across page loads too (background.js
// draws it again) — until the agent is paused or unpaired, or has done nothing for this
// long, so a finished task does not leave a dot on the person's page for good.
export const IDLE_MS = 5 * 60_000;
// How long the caret stays after typing finishes.
export const CARET_MS = 1500;
// Time for a stroke's animation: about what the input itself takes (a segment's moves
// plus its 8 ms pause), bounded so a long stroke never leaves the dot behind for long.
const MS_PER_SEGMENT = 12;
const MAX_STROKE_MS = 6000;
// The dot glides from where it was to where the next action starts the way a hand moves
// a mouse, so the eye can follow it: a short hop is quick and a long reach slower
// (about Fitts's law: `minMs` plus `msPerDoubling` for each doubling of the distance
// over 16 px, at most `maxMs`), along a slight arc (bowed sideways by `arc` of the
// distance, at most `maxArcPx`), speeding up and then slowing as it lands.
// page.overlay draws it from this; background.js waits for the glide (its `lead`)
// before acting, so the action lands as the dot arrives.
export const GLIDE = Object.freeze({ minMs: 280, maxMs: 1100, msPerDoubling: 120, arc: 0.1, maxArcPx: 60 });
// A drag held down from its source to its target: about as long as page.drag takes.
const DRAG_MS = 450;
// A scroll is shown as a short drag in its direction, from the middle of what scrolls.
const SCROLL_MS = 350;
const SCROLL_SWIPE_PX = 60;
const SWIPE = { up: [0, -1], down: [0, 1], left: [-1, 0], right: [1, 0] };

/** Animation time for a path of `points` (CSS pixels); 0 for fewer than two. */
export function strokeMs(points) {
  if (!Array.isArray(points) || points.length < 2) return 0;
  return Math.min(MAX_STROKE_MS, (points.length - 1) * MS_PER_SEGMENT);
}

const finite = (p) => Array.isArray(p) && p.length === 2 && p.every(Number.isFinite);

/**
 * The overlay command for one mouse action whose point (or path) is already resolved
 * to CSS pixels of the viewport.
 *
 * Every command is `{points, glide, ms, hold, pulses, pressed}`: the dot glides to
 * the first of `points` as `glide` says (GLIDE; null: it is put there at once), then
 * travels through the rest over `ms`. A
 * `hold` command is pressed for that travel (a stroke, a drag, a scroll) and pulses
 * as the button goes down and comes up; any other pulses `pulses` times on arrival (a
 * click once, a double click twice, a press or a release once) and leaves a button
 * held or not by `pressed` — `null` leaves it as it was (a move or a wheel turn).
 * Null for an action with nothing to show.
 */
export function pointerCommand(action, loc) {
  if (!loc) return null;
  if (action === "path") {
    if (!Array.isArray(loc.points) || loc.points.length < 2) return null;
    return { points: loc.points, glide: GLIDE, ms: strokeMs(loc.points), hold: true, pulses: 0, pressed: false };
  }
  if (!Number.isFinite(loc.x) || !Number.isFinite(loc.y)) return null;
  const at = { points: [[loc.x, loc.y]], glide: GLIDE, ms: 0, hold: false };
  switch (action) {
    case "click":
      return { ...at, pulses: 1, pressed: false };
    case "double_click":
      return { ...at, pulses: 2, pressed: false };
    case "press":
      return { ...at, pulses: 1, pressed: true };
    case "release":
      return { ...at, pulses: 1, pressed: false };
    case "move":
    case "wheel":
      return { ...at, pulses: 0, pressed: null };
    default:
      return null;
  }
}

/** The command for a click on a snapshot ref: page.overlay finds the element's centre. */
export function refClickCommand(ref) {
  return { ref: String(ref), points: null, glide: GLIDE, ms: 0, hold: false, pulses: 1, pressed: false };
}

/** A drag (page.drag's dry run: `from`, `to`): pressed at the source, released on the target. */
export function dragCommand(plan) {
  if (!plan || !finite(plan.from) || !finite(plan.to)) return null;
  return { points: [plan.from, plan.to], glide: GLIDE, ms: DRAG_MS, hold: true, pulses: 0, pressed: false };
}

/**
 * A scroll (page.scroll's dry run: `x`, `y`, the middle of what scrolls), shown as a
 * short drag in the direction it scrolls, pressed and released.
 */
export function scrollCommand(plan, direction) {
  const dir = SWIPE[direction];
  if (!plan || !dir || !Number.isFinite(plan.x) || !Number.isFinite(plan.y)) return null;
  const to = [plan.x + dir[0] * SCROLL_SWIPE_PX, plan.y + dir[1] * SCROLL_SWIPE_PX];
  return { points: [[plan.x, plan.y], to], glide: GLIDE, ms: SCROLL_MS, hold: true, pulses: 0, pressed: false };
}

/**
 * The dot drawn again where the agent left it, on a page that has just loaded: no
 * glide, no pulse, pressed state as it was. `last.at` is when the agent last acted;
 * null once IDLE_MS has passed since (`now`), or for a point that is not one.
 */
export function restoreCommand(last, now) {
  if (!last || !finite(last.point) || !Number.isFinite(last.at)) return null;
  const idleMs = IDLE_MS - (now - last.at);
  if (idleMs <= 0) return null;
  return { points: [last.point], glide: null, ms: 0, hold: false, pulses: 0, pressed: null, idleMs };
}

/** The command that takes the dot (and any caret) off the page at once. */
export function hideCommand() {
  return { hide: true };
}

/** The command for text typed into a snapshot ref: a caret at the end of its text. */
export function caretCommand(ref) {
  return { caret: String(ref), caretMs: CARET_MS };
}

/**
 * What browser_end_task leaves behind when the AI app says its whole task is over: the
 * dot goes from every tab it was drawn on (`pointed`: the worker's memory and session
 * storage, so repeats are fine), and the debugger lets go of every tab it holds
 * (`attached`) — Chrome's "started debugging this browser" bar closes, and with it any
 * faked responses, console/network logging and viewport change — except a tab being
 * filmed (`filming`): a recording is ended only by browser_record's stop.
 * `{hide, release, filming}`, each a sorted list of tab ids.
 */
export function endTaskPlan({ pointed = [], attached = [], filming = [] } = {}) {
  const ids = (list) => [...new Set(list)].filter(Number.isInteger).sort((a, b) => a - b);
  const filmed = new Set(ids(filming));
  return {
    hide: ids(pointed),
    release: ids(attached).filter((t) => !filmed.has(t)),
    filming: [...filmed],
  };
}
