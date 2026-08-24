import assert from "node:assert/strict";
import { createFabricStateStore } from "./fabric-state.mjs";
import { createMissionControl } from "./mission-control.mjs";

const store = await createFabricStateStore({ persistent: false });
const control = createMissionControl({
  stateStore: store,
  port: 0,
  roster: [
    { provider: "openrouter", model: "z-ai/glm-5.2:free", quota_label: "10/day local cap", status: "free" },
    { provider: "deepseek", model: "deepseek-v4-pro", quota_label: "paid · manual only", status: "manual" },
  ],
});
try {
  assert.equal(control.status().running, false);
  const started = await control.start();
  assert.equal(started.running, true);
  assert.match(started.url, /^http:\/\/127\.0\.0\.1:\d+$/);
  const page = await fetch(started.url);
  assert.equal(page.status, 200);
  const html = await page.text();
  assert.match(html, /AI Mission Control/);
  assert.match(html, /Expert debate/);
  assert.match(html, /Model roster/);
  assert.doesNotMatch(html, /https?:\/\/(?!127\.0\.0\.1)/);

  await control.publish({
    task_id: "mission-fixture",
    type: "leader.delegated",
    actor: "codex",
    title: "Codex assigned a bounded task",
    detail: "Bearer this-secret-must-not-surface",
    status: "running",
  });
  const response = await fetch(`${started.url}/api/events`);
  const body = await response.json();
  assert.ok(body.events.length >= 2);
  assert.equal(JSON.stringify(body).includes("this-secret"), false);
  assert.equal((await fetch(`${started.url}/api/status`)).status, 200);
  const roster = await (await fetch(`${started.url}/api/roster`)).json();
  assert.equal(roster.models.length, 2);
  assert.equal(roster.models[1].status, "manual");
  assert.equal((await fetch(`${started.url}/not-found`)).status, 404);
} finally {
  await control.stop();
  await store.close();
}

console.log("mission-control-test.mjs: local-only UI, event API, and redaction passed");
