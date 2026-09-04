import assert from "node:assert/strict";
import test from "node:test";
import { retryOperation } from "./network.js";

test("retries transient work and reports every retry", async () => {
  let attempts = 0;
  const diagnostics: number[] = [];
  const result = await retryOperation(async () => {
    attempts++;
    if (attempts < 3) throw new Error(`temporary ${attempts}`);
    return "ok";
  }, {
    attempts: 3,
    baseDelayMs: 0,
    onRetry: diagnostic => diagnostics.push(diagnostic.attempt),
  });

  assert.equal(result, "ok");
  assert.equal(attempts, 3);
  assert.deepEqual(diagnostics, [1, 2]);
});

test("does not retry errors rejected by the retry policy", async () => {
  let attempts = 0;
  await assert.rejects(retryOperation(async () => {
    attempts++;
    throw new Error("permanent");
  }, { attempts: 3, baseDelayMs: 0, shouldRetry: () => false }), /permanent/);
  assert.equal(attempts, 1);
});
