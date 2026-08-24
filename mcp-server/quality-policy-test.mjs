import assert from "node:assert/strict";
import { evaluateWorkerResult } from "./quality-policy.mjs";

const scores = (functionality, requirements, codeQuality, safety, maintainability) => ({
  functionality,
  requirements,
  code_quality: codeQuality,
  safety,
  maintainability,
});

assert.equal(evaluateWorkerResult({ scores: scores(40, 25, 10, 10, 10) }).decision, "accept");
assert.equal(evaluateWorkerResult({ scores: scores(35, 20, 10, 10, 10), attempt: 1 }).decision, "retry");
assert.equal(evaluateWorkerResult({ scores: scores(35, 20, 10, 10, 10), attempt: 2 }).decision, "takeover");
assert.equal(evaluateWorkerResult({ scores: scores(30, 15, 10, 10, 5) }).decision, "takeover");
assert.equal(evaluateWorkerResult({
  scores: scores(40, 25, 15, 10, 10),
  hard_failures: ["tests failed"],
}).decision, "takeover");

const normalized = evaluateWorkerResult({
  task_id: "quality-test",
  scores: scores(999, -1, 15, 10, 10),
  changed_files: ["a.js", "a.js", "b.js"],
});
assert.equal(normalized.score, 75);
assert.deepEqual(normalized.changed_files, ["a.js", "b.js"]);

console.log("Quality policy: 6 scenarios passed");
