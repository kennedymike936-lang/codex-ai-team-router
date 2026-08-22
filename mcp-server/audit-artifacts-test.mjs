import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = mkdtempSync(join(tmpdir(), "ai-team-audit-"));
process.env.AI_TEAM_AUDIT_ROOT = root;
const { loadCheckpoint, saveCheckpoint, writeRouteDecision } = await import("./audit-artifacts.mjs");
try {
  const routePath = await writeRouteDecision("task/1", { kind: "project", selected: { provider: "qwen", id: "worker" }, excluded: [{ provider: "xai", id: "grok", reason: "cooldown", remaining_ms: 10 }], secret: "must-not-appear" });
  assert.equal(readFileSync(routePath, "utf8").includes("must-not-appear"), false);
  await saveCheckpoint("task/1", { phase: "gate", next_attempt: 2, changed_files: ["src/a.js"], isolation: { enabled: true, status: "retained", path: "safe", head: "abc" } });
  const checkpoint = await loadCheckpoint("task/1");
  assert.equal(checkpoint.next_attempt, 2);
  assert.deepEqual(checkpoint.changed_files, ["src/a.js"]);
  console.log("Audit artifacts: redacted route decision and resumable checkpoint passed");
} finally {
  rmSync(root, { recursive: true, force: true });
}
