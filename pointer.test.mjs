// Run with: node --test apps/browser_probe/extension/*.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import {
  CARET_MS,
  GLIDE,
  IDLE_MS,
  caretCommand,
  endTaskPlan,
  dragCommand,
  hideCommand,
  pointerCommand,
  refClickCommand,
  restoreCommand,
  scrollCommand,
  strokeMs,
} from "./pointer.js";

const at = { x: 10, y: 20 };
const point = (extra) => ({ points: [[10, 20]], glide: GLIDE, ms: 0, hold: false, ...extra });

test("a click pulses once, a double click twice, and neither leaves a button held", () => {
  assert.deepEqual(pointerCommand("click", at), point({ pulses: 1, pressed: false }));
  assert.deepEqual(pointerCommand("double_click", at), point({ pulses: 2, pressed: false }));
});

test("press holds the dot down and release lets it go, each with a pulse", () => {
  assert.deepEqual(pointerCommand("press", at), point({ pulses: 1, pressed: true }));
  assert.deepEqual(pointerCommand("release", at), point({ pulses: 1, pressed: false }));
});

test("a move or a wheel turn moves the dot and leaves the pressed state alone", () => {
  for (const action of ["move", "wheel"]) {
    assert.deepEqual(pointerCommand(action, at), point({ pulses: 0, pressed: null }));
  }
});

test("a path is held down along its points for about the stroke's own time", () => {
  const points = [[0, 0], [5, 5], [10, 10]];
  assert.deepEqual(pointerCommand("path", { points }), {
    points, glide: GLIDE, ms: 24, hold: true, pulses: 0, pressed: false,
  });
});

test("a long stroke's animation is bounded", () => {
  const points = Array.from({ length: 500 }, (_, i) => [i, i]);
  assert.equal(strokeMs(points), 5988);
  assert.equal(strokeMs(Array.from({ length: 2000 }, (_, i) => [i, i])), 6000);
  assert.equal(strokeMs([[1, 1]]), 0);
  assert.equal(strokeMs(null), 0);
});

test("nothing to show: no location, no usable point, an unknown action", () => {
  assert.equal(pointerCommand("click", null), null);
  assert.equal(pointerCommand("click", { x: NaN, y: 1 }), null);
  assert.equal(pointerCommand("click", {}), null);
  assert.equal(pointerCommand("path", { points: [[1, 1]] }), null);
  assert.equal(pointerCommand("path", {}), null);
  assert.equal(pointerCommand("hover", at), null);
});

test("a ref click names the ref for the page to find, and pulses", () => {
  assert.deepEqual(refClickCommand(7), {
    ref: "7", points: null, glide: GLIDE, ms: 0, hold: false, pulses: 1, pressed: false,
  });
});

test("a drag is pressed on its source and released on its target", () => {
  const cmd = dragCommand({ ok: true, from: [1, 2], to: [30, 40] });
  assert.deepEqual(cmd.points, [[1, 2], [30, 40]]);
  assert.equal(cmd.hold, true);
  assert.ok(cmd.ms > 0);
  assert.equal(dragCommand(null), null);
  assert.equal(dragCommand({ from: [1, 2] }), null);
  assert.equal(dragCommand({ from: [1, NaN], to: [3, 4] }), null);
});

test("a scroll is a short held drag in its direction, from the middle of what scrolls", () => {
  const plan = { ok: true, x: 100, y: 200 };
  assert.deepEqual(scrollCommand(plan, "down").points, [[100, 200], [100, 260]]);
  assert.deepEqual(scrollCommand(plan, "up").points, [[100, 200], [100, 140]]);
  assert.deepEqual(scrollCommand(plan, "left").points, [[100, 200], [40, 200]]);
  assert.deepEqual(scrollCommand(plan, "right").points, [[100, 200], [160, 200]]);
  assert.equal(scrollCommand(plan, "down").hold, true);
  assert.equal(scrollCommand(plan, "sideways"), null);
  assert.equal(scrollCommand(null, "down"), null);
  assert.equal(scrollCommand({ x: 1 }, "down"), null);
});

test("typing shows the caret for a moment on that ref", () => {
  assert.deepEqual(caretCommand(3), { caret: "3", caretMs: CARET_MS });
  assert.ok(CARET_MS > 0 && CARET_MS < IDLE_MS);
});

test("the dot stays for minutes after the last action, like a mouse cursor", () => {
  assert.ok(IDLE_MS >= 60_000);
});

test("after a page load the dot comes back where it was, still, for the rest of its time", () => {
  const last = { point: [10, 20], at: 1000 };
  assert.deepEqual(restoreCommand(last, 1000 + 500), {
    points: [[10, 20]],
    glide: null,
    ms: 0,
    hold: false,
    pulses: 0,
    pressed: null,
    idleMs: IDLE_MS - 500,
  });
  assert.equal(restoreCommand(last, 1000 + IDLE_MS), null);
  assert.equal(restoreCommand(null, 0), null);
  assert.equal(restoreCommand({ point: [1], at: 0 }, 0), null);
  assert.equal(restoreCommand({ point: [1, 2] }, 0), null);
});

test("hiding takes the dot off the page", () => {
  assert.deepEqual(hideCommand(), { hide: true });
});

test("the glide is a hand's pace: a fraction of a second, never more than about one", () => {
  assert.ok(Object.isFrozen(GLIDE));
  assert.ok(GLIDE.minMs >= 200 && GLIDE.minMs < GLIDE.maxMs && GLIDE.maxMs <= 1500);
  assert.ok(GLIDE.msPerDoubling > 0 && GLIDE.arc > 0 && GLIDE.maxArcPx > 0);
});

test("ending the task hides the dot everywhere it was and lets go of every tab not being filmed", () => {
  assert.deepEqual(endTaskPlan({ pointed: [7, 3, 7, "x"], attached: [3, 9, 5], filming: [9, 9] }), {
    hide: [3, 7],
    release: [3, 5],
    filming: [9],
  });
});

test("ending a task that drew nothing and holds nothing does nothing", () => {
  assert.deepEqual(endTaskPlan(), { hide: [], release: [], filming: [] });
  assert.deepEqual(endTaskPlan({}), { hide: [], release: [], filming: [] });
});
