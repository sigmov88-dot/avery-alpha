import assert from "node:assert/strict";
import { test } from "node:test";
import { computeWindow } from "../src/tui/select.ts";

test("computeWindow returns the whole list when it fits", () => {
  assert.deepEqual(computeWindow(5, 2, 12), { start: 0, end: 5 });
  assert.deepEqual(computeWindow(12, 0, 12), { start: 0, end: 12 });
});

test("computeWindow centers the cursor in long lists", () => {
  const { start, end } = computeWindow(87, 40, 12);
  assert.equal(end - start, 12);
  assert.ok(start <= 40 && 40 < end);
});

test("computeWindow clamps at both ends", () => {
  assert.deepEqual(computeWindow(87, 0, 12), { start: 0, end: 12 });
  assert.deepEqual(computeWindow(87, 86, 12), { start: 75, end: 87 });
});

test("computeWindow handles empty lists", () => {
  assert.deepEqual(computeWindow(0, 0, 12), { start: 0, end: 0 });
});
