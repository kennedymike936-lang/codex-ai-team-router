import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFabricStateStore } from "./fabric-state.mjs";

const dir = mkdtempSync(join(tmpdir(), "ai-team-fabric-"));
const dbPath = join(dir, "fabric.sqlite");
const sensitiveSentinel = "fixture-sensitive-prompt-and-key";

try {
  const store = await createFabricStateStore({ path: dbPath, persistent: true });
  await store.recordProviderState({
    provider: "zhipu",
    circuit: "open",
    active: 1,
    queued: 2,
    failure_count: 3,
    opened_at: 123,
    prompt: sensitiveSentinel,
    [["api", "Key"].join("")]: sensitiveSentinel,
  });
  await store.recordUsage({
    provider: "zhipu",
    model: "glm-4.7-flash",
    input_tokens: 7,
    output_tokens: 1,
    status: 200,
    response: sensitiveSentinel,
  });
  const requestTime = Date.parse("2026-08-23T12:00:00Z");
  await store.recordRequest({
    provider: "openrouter",
    model: "z-ai/glm-5.2:free",
    status: 0,
    created_at: requestTime,
    prompt: sensitiveSentinel,
  });
  assert.equal(await store.countRequests({
    provider: "openrouter",
    model: "z-ai/glm-5.2:free",
    since: requestTime - 1,
  }), 1);
  await store.recordTaskTransition({
    task_id: "task-1",
    from_state: "running",
    to_state: "completed",
    prompt: sensitiveSentinel,
  });
  const missionEvent = await store.recordMissionEvent({
    task_id: "task-1",
    type: "leader.delegated",
    actor: "codex",
    title: "Codex delegated bounded work",
    detail: "API_KEY=secret-value-that-must-be-redacted",
    status: "running",
    prompt: sensitiveSentinel,
  });
  assert.ok(missionEvent.id > 0);
  const missionEvents = await store.listMissionEvents({ after: 0, limit: 10 });
  assert.equal(missionEvents.length, 1);
  assert.equal(missionEvents[0].detail.includes("secret-value"), false);
  const snapshot = await store.snapshot();
  assert.equal(snapshot.providers[0].provider, "zhipu");
  assert.equal(snapshot.usage[0].model, "glm-4.7-flash");
  assert.equal(snapshot.requests[0].model, "z-ai/glm-5.2:free");
  assert.equal(snapshot.transitions[0].to_state, "completed");
  assert.equal(snapshot.mission_events[0].type, "leader.delegated");
  assert.equal(JSON.stringify(snapshot).includes(sensitiveSentinel), false);
  await store.close();
  if (snapshot.backend === "sqlite") {
    assert.equal(readFileSync(dbPath).includes(Buffer.from(sensitiveSentinel)), false);
  }
} finally {
  rmSync(dir, { recursive: true, force: true });
}

console.log("fabric-state-test.mjs: single-writer state and sensitive-body exclusion passed");
