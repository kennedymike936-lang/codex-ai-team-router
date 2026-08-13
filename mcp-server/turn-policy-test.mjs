import assert from "node:assert/strict";
import test from "node:test";
import { buildTargetedRetryPrompt, selectScoutTurnPolicy, selectTurnPolicy } from "./turn-policy.mjs";

test("read-only scouts reserve a final answer turn by complexity", () => {
  assert.equal(selectScoutTurnPolicy({ complexity: "small", attempt: 1 }).max_session_turns, 3);
  assert.equal(selectScoutTurnPolicy({ complexity: "medium", attempt: 1 }).max_session_turns, 4);
  assert.equal(selectScoutTurnPolicy({ complexity: "complex", attempt: 1 }).max_session_turns, 6);
  const retry = selectScoutTurnPolicy({ complexity: "complex", attempt: 2 });
  assert.equal(retry.max_session_turns, 3);
  assert.equal(retry.policy, "focused_scout_failover");
  assert.match(retry.reason, /final answer turn/i);
});

test("small task gets lower turns than the default 8", () => {
  const policy = selectTurnPolicy({ complexity: "small", attempt: 1 });
  assert.equal(policy.max_session_turns, 6);
  assert.equal(policy.policy, "small_task_low_turns");
  assert.equal(policy.complexity, "small");
  assert.equal(policy.attempt, 1);
  assert.equal(policy.hard_cap, 12);
  assert.ok(policy.reason.includes("small"));
});

test("medium task gets a bounded extension after repeated failures at 8 turns", () => {
  const policy = selectTurnPolicy({ complexity: "medium", attempt: 1 });
  assert.equal(policy.max_session_turns, 10);
  assert.equal(policy.policy, "medium_task_extended_turns");
  assert.equal(policy.complexity, "medium");
});

test("complex task gets moderately higher turns but never exceeds 12", () => {
  const policy = selectTurnPolicy({ complexity: "complex", attempt: 1 });
  assert.equal(policy.max_session_turns, 12);
  assert.equal(policy.policy, "complex_task_high_turns");
  assert.equal(policy.complexity, "complex");
  assert.ok(policy.max_session_turns <= 12);
});

test("hard cap: max_session_turns never exceeds 12 regardless of input", () => {
  // Even if someone passes a fake complexity that would be high, the cap holds.
  const policy = selectTurnPolicy({ complexity: "complex", attempt: 1 });
  assert.ok(policy.max_session_turns <= 12);
  assert.equal(policy.hard_cap, 12);
});

test("attempt 2 (retry) gets strict short cap of 4 turns", () => {
  for (const complexity of ["small", "medium", "complex"]) {
    const policy = selectTurnPolicy({ complexity, attempt: 2 });
    assert.equal(policy.max_session_turns, 4, `retry cap for ${complexity}`);
    assert.equal(policy.policy, "targeted_retry");
    assert.equal(policy.attempt, 2);
    assert.ok(policy.reason.includes("no re-investigation"));
  }
});

test("attempt 3+ also gets strict short cap", () => {
  const policy = selectTurnPolicy({ complexity: "medium", attempt: 3 });
  assert.equal(policy.max_session_turns, 4);
  assert.equal(policy.policy, "targeted_retry");
});

test("metadata fields are present and deterministic", () => {
  const policy = selectTurnPolicy({ complexity: "complex", attempt: 1 });
  const keys = Object.keys(policy).sort();
  assert.deepEqual(keys, ["attempt", "complexity", "hard_cap", "max_session_turns", "policy", "reason"]);
  assert.equal(typeof policy.max_session_turns, "number");
  assert.equal(typeof policy.policy, "string");
  assert.equal(typeof policy.reason, "string");
});

test("retry prompt forbids re-investigation for targeted retry", () => {
  const prompt = buildTargetedRetryPrompt({
    gate: { reason: "incomplete", requirement_status: "partial" },
    workerResult: { summary: "partial output", changed_files: ["src/a.ts"] },
  });
  assert.match(prompt, /TARGETED RETRY/);
  assert.match(prompt, /Do NOT re-investigate/);
  assert.match(prompt, /validate and finalize the existing diff/);
  assert.match(prompt, /Gate reason: incomplete/);
});

test("retry prompt is extra strict after FatalTurnLimitedError with partial files", () => {
  const prompt = buildTargetedRetryPrompt({
    gate: { checks: { lint: "fail" } },
    workerResult: {
      error: "FatalTurnLimitedError: Reached max session turns",
      summary: "Work in progress",
      changed_files: ["src/a.ts"],
    },
  });
  assert.match(prompt, /CRITICAL/);
  assert.match(prompt, /turn limit with partial changes already on disk/);
  assert.match(prompt, /Do NOT restart or re-investigate/);
  assert.match(prompt, /Failed checks: lint/);
});

test("retry prompt without partial files still forbids re-investigation", () => {
  const prompt = buildTargetedRetryPrompt({
    gate: {},
    workerResult: { summary: "ran out of turns", changed_files: [] },
  });
  assert.match(prompt, /TARGETED RETRY/);
  assert.match(prompt, /Do NOT re-investigate/);
  assert.doesNotMatch(prompt, /CRITICAL/);
});

test("retry prompt handles missing gate gracefully", () => {
  const prompt = buildTargetedRetryPrompt({
    workerResult: { summary: "done", changed_files: ["out.txt"] },
  });
  assert.match(prompt, /TARGETED RETRY/);
  assert.doesNotMatch(prompt, /Gate reason/);
});
