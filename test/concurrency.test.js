import test from "node:test";
import assert from "node:assert/strict";
import { runWithConcurrency } from "../server/src/utils/concurrency.js";

test("runWithConcurrency processes every item exactly once", async () => {
  const items = Array.from({ length: 23 }, (_, index) => index);
  const seen = [];
  await runWithConcurrency(items, async (item) => {
    seen.push(item);
  }, 6);
  assert.deepEqual([...seen].sort((a, b) => a - b), items);
});

test("runWithConcurrency never runs more than the given limit at once", async () => {
  const items = Array.from({ length: 20 }, (_, index) => index);
  let active = 0;
  let maxActive = 0;
  await runWithConcurrency(items, async () => {
    active += 1;
    maxActive = Math.max(maxActive, active);
    await new Promise((resolve) => setTimeout(resolve, 5));
    active -= 1;
  }, 4);
  assert.ok(maxActive <= 4, `expected at most 4 concurrent tasks, saw ${maxActive}`);
  assert.ok(maxActive > 1, "expected tasks to actually overlap, not run one at a time");
});

test("runWithConcurrency propagates a handler error", async () => {
  await assert.rejects(
    runWithConcurrency([1, 2, 3], async (item) => {
      if (item === 2) throw new Error("boom");
    }, 3),
    /boom/,
  );
});

test("runWithConcurrency handles an empty list and a limit larger than the list", async () => {
  let calls = 0;
  await runWithConcurrency([], async () => { calls += 1; }, 6);
  assert.equal(calls, 0);

  const items = [1, 2];
  const seen = [];
  await runWithConcurrency(items, async (item) => { seen.push(item); }, 6);
  assert.deepEqual(seen.sort(), [1, 2]);
});
