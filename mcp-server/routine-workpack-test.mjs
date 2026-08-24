import assert from "node:assert/strict";
import test from "node:test";
import {
  BUILTIN_MODEL_METADATA,
  classifyAutonomyItem,
  lunaWorkerSlot,
  mergeBuiltinModelMetadata,
} from "./autonomy-policy.mjs";
import { planRoutineWorkpack, runRoutineWorkpack } from "./routine-workpack.mjs";

test("reserves Luna without credentials or a local worker runner", () => {
  assert.deepEqual(lunaWorkerSlot(), {
    id: "openai:gpt-5.6-luna",
    provider: "openai",
    model: "gpt-5.6-luna",
    role: "high_volume_routine_worker",
    execution: "responses_api",
    state: "reserved",
    reason: "AI_TEAM_LUNA_ENABLED is not true",
    capabilities: ["model_only", "structured_output", "tool_calling"],
  });
  assert.equal(BUILTIN_MODEL_METADATA["openai:gpt-5.6-luna"].context_length, 1_050_000);
});

test("keeps built-in Luna metadata while allowing administrator overrides", () => {
  const metadata = mergeBuiltinModelMetadata({
    "openai:gpt-5.6-luna": { capabilities: ["custom"], quality_score: 0.7 },
  });
  assert.deepEqual(metadata["openai:gpt-5.6-luna"].capabilities, ["code", "tools", "web", "custom"]);
  assert.equal(metadata["openai:gpt-5.6-luna"].quality_score, 0.7);
  assert.equal(metadata["openai:gpt-5.6-luna"].pricing.output, 1.2 / 1_000_000);
});

test("allows bounded routine implementation and escalates unbounded work", () => {
  assert.equal(classifyAutonomyItem({ task: "Fix the parser", allowed_paths: ["src/parser.js"] }, "implement").disposition, "autonomous");
  assert.equal(classifyAutonomyItem({ task: "Fix the parser" }, "implement").disposition, "escalate");
  assert.throws(() => classifyAutonomyItem({ task: "Fix the parser", allowed_paths: ["../outside"] }, "implement"), /must stay inside cwd/);
});

test("escalates high-risk and external-write items", () => {
  assert.equal(classifyAutonomyItem({ task: "Deploy the auth migration", allowed_paths: ["src"] }, "implement").risk, "high");
  assert.equal(classifyAutonomyItem({ task: "Deploy to production", risk: "low", allowed_paths: ["deploy"] }, "implement").risk, "high");
  assert.equal(classifyAutonomyItem({ task: "更新发布说明", allowed_paths: ["CHANGELOG.md"] }, "implement").risk, "low");
  assert.equal(classifyAutonomyItem({ task: "Post the report", external_write: true }, "inspect").disposition, "escalate");
});

test("rejects duplicate audit ids", () => {
  assert.throws(() => planRoutineWorkpack({ items: [
    { id: "same", task: "Update docs", allowed_paths: ["README.md"] },
    { id: "same", task: "Update examples", allowed_paths: ["examples"] },
  ] }), /must be unique/);
});

test("plans one-writer workpack and keeps risky items out of execution", () => {
  const plan = planRoutineWorkpack({ items: [
    { id: "docs", task: "Update README", allowed_paths: ["README.md"] },
    { id: "deploy", task: "Deploy to production", allowed_paths: ["deploy"] },
    { id: "logs", task: "Inspect the logs", mode: "inspect" },
  ] });
  assert.equal(plan.autonomous_count, 2);
  assert.equal(plan.escalation_count, 1);
  assert.equal(plan.execution_policy.writer_concurrency, 1);
  assert.deepEqual(plan.allowed_paths, ["README.md"]);
  assert.deepEqual(plan.batches.map((batch) => batch.mode), ["inspect", "implement"]);
});

test("keeps read-only and write-capable chores in separate least-privilege lanes", async () => {
  const calls = [];
  const result = await runRoutineWorkpack({
    cwd: "C:/fixture",
    items: [
      { id: "inspect", task: "Inspect parser behavior", mode: "inspect" },
      { id: "fix", task: "Fix parser", mode: "implement", allowed_paths: ["src/parser.js"] },
    ],
  }, {
    runner: async (args) => {
      calls.push(args);
      return args.mode === "inspect"
        ? { status: "success", summary: "inspected" }
        : { status: "accept", summary: "fixed", gate: { decision: "accept", score: 95 } };
    },
  });
  assert.equal(result.status, "accepted");
  assert.equal(result.receipt.accepted, 2);
  assert.deepEqual(calls.map((call) => [call.mode, call.run_gate]), [["inspect", false], ["implement", true]]);
  assert.match(calls[0].task, /strictly read-only/);
  assert.doesNotMatch(calls[1].task, /\[inspect\]/);
});

test("executes autonomous items as one bounded project task", async () => {
  let captured;
  const result = await runRoutineWorkpack({
    cwd: "C:/fixture",
    items: [
      { id: "one", task: "Fix parser", allowed_paths: ["src/parser.js"] },
      { id: "two", task: "Add parser test", allowed_paths: ["test/parser.test.js"] },
    ],
  }, {
    runner: async (args) => {
      captured = args;
      return {
        task_id: "project-1",
        route: "deepseek",
        status: "accept",
        summary: "Both chores completed.",
        changed_files: ["src/parser.js", "test/parser.test.js"],
        attempts: [{ attempt: 1, gate_decision: "accept" }],
        gate: { decision: "accept", score: 95, checks: { tests: "pass" } },
        artifacts: { handoff: "handoff.json" },
      };
    },
  });
  assert.equal(result.status, "accepted");
  assert.equal(result.receipt.accepted, 2);
  assert.deepEqual(captured.allowed_paths, ["src/parser.js", "test/parser.test.js"]);
  assert.equal(captured.run_gate, true);
  assert.match(captured.task, /\[one\]/);
  assert.match(captured.task, /\[two\]/);
});

test("returns a compact exception packet when the Gate rejects the batch", async () => {
  const result = await runRoutineWorkpack({
    cwd: "C:/fixture",
    items: [{ id: "one", task: "Fix parser", allowed_paths: ["src/parser.js"] }],
  }, {
    runner: async () => ({
      task_id: "project-2",
      route: "deepseek",
      status: "takeover",
      summary: "tests failed",
      changed_files: ["src/parser.js"],
      gate: { decision: "takeover", score: 70, reason: "tests failed", checks: { tests: "fail" } },
      attempts: [],
      artifacts: { handoff: "handoff.json" },
    }),
  });
  assert.equal(result.status, "takeover");
  assert.equal(result.receipt.accepted, 0);
  assert.equal(result.escalations.length, 1);
  assert.equal(result.escalation_count, 1);
  assert.match(result.escalations[0].reasons.join(" "), /tests failed/);
});

test("turns runner exceptions into a Codex takeover packet", async () => {
  const result = await runRoutineWorkpack({
    cwd: "C:/fixture",
    items: [{ id: "one", task: "Fix parser", allowed_paths: ["src/parser.js"] }],
  }, { runner: async () => { throw new Error("worker unavailable"); } });
  assert.equal(result.status, "takeover");
  assert.equal(result.execution.batches[0].status, "error");
  assert.equal(result.escalation_count, 1);
  assert.match(result.escalations[0].reasons.join(" "), /worker unavailable/);
});

test("does not call a worker when every item requires Codex", async () => {
  let called = false;
  const result = await runRoutineWorkpack({
    cwd: "C:/fixture",
    items: [{ task: "Deploy the payment migration", allowed_paths: ["deploy"] }],
  }, { runner: async () => { called = true; } });
  assert.equal(called, false);
  assert.equal(result.status, "takeover");
});
