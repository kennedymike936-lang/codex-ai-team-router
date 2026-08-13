import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  buildTargetedRetryTask,
  buildWorkerFailoverTask,
  classifyWorkerFailure,
  combineScoutPacks,
  computeProjectDeadline,
  compactPackMetadata,
  ensureGitBaseline,
  previewProjectTask,
  requirementStatusForWorker,
  runProjectTask,
  selectProjectMode,
  selectProjectWorker,
  selectWorkerFailoverRoute,
  shouldRunTargetedRetry,
  usageAvailability,
} from "./project-task.mjs";
import { analyzeTaskComplexity, planTaskTeam } from "./team-planner.mjs";

test("routes broad inspection to the low-cost Qwen scout", () => {
  assert.equal(selectProjectMode("Map the project and inspect the logs"), "inspect");
  assert.equal(selectProjectWorker("Map the project", "inspect"), "qwen");
});

test("routes implementation to one DeepSeek worker by default", () => {
  assert.equal(selectProjectMode("Fix the TypeScript build"), "implement");
  assert.equal(selectProjectWorker("Fix the TypeScript build", "implement"), "deepseek");
});

test("uses one noninteractive worker plus a deterministic gate", () => {
  const preview = previewProjectTask({ task: "Implement the feature", approval: "auto" });
  assert.equal(preview.mode, "implement");
  assert.equal(preview.worker, "deepseek");
  assert.equal(preview.planner, null);
  assert.equal(preview.team.assistant_count, 1);
  assert.equal(preview.approval, "yolo");
  assert.equal(preview.run_gate, true);
});

test("does not send an inspection task through the write gate", () => {
  const preview = previewProjectTask({ task: "审计项目日志", mode: "auto" });
  assert.equal(preview.mode, "inspect");
  assert.equal(preview.approval, "auto");
  assert.equal(preview.run_gate, false);
});

test("does not mark a failed worker as a complete success", () => {
  assert.equal(requirementStatusForWorker({ status: "failed", changed_files: ["NOTES.md"] }), "partial");
  assert.equal(requirementStatusForWorker({ status: "failed", changed_files: [] }), "fail");
  assert.equal(requirementStatusForWorker({ status: "success", changed_files: [] }), "unknown");
  assert.equal(requirementStatusForWorker({ status: "success", changed_files: [], summary: "Blocked: edit denied" }), "fail");
});

test("allows exactly one targeted internal retry", () => {
  const gate = {
    decision: "retry",
    reason: "Requirement is incomplete.",
    requirement_status: "partial",
    checks: { html_smoke: "fail", lint: "not_detected" },
    retry: { instruction: "Fix only the failed check." },
  };
  assert.equal(shouldRunTargetedRetry(gate, 1), true);
  assert.equal(shouldRunTargetedRetry(gate, 2), false);
  const task = buildTargetedRetryTask(gate, { summary: "Created a partial page." });
  assert.match(task, /attempt 2 of 2/i);
  assert.match(task, /html_smoke/);
  assert.doesNotMatch(task, /lint/);
});

test("classifies retryable helper failures without bypassing configuration errors", () => {
  assert.deepEqual(
    classifyWorkerFailure({ status: "failed", error: "FatalTurnLimitedError: Reached max session turns" }),
    { kind: "turn_limit", retryable: true },
  );
  assert.deepEqual(
    classifyWorkerFailure({ status: "failed", error: "401 Unauthorized: API key is not configured" }),
    { kind: "configuration_or_safety", retryable: false },
  );
  assert.deepEqual(
    classifyWorkerFailure({ status: "failed", error: "Warning: no stdin data received in 3s" }),
    { kind: "harness_stdin", retryable: true },
  );
  assert.deepEqual(selectWorkerFailoverRoute({ worker: "qwen", harness: "qwen" }), {
    worker: "deepseek", harness: "claude",
  });
  const task = buildWorkerFailoverTask(
    {
      summary: "partial inspection",
      changed_files: ["locales/one.reds"],
      allowed_paths: ["locales/one.reds", "locales/two.reds"],
    },
    { kind: "turn_limit" },
    { worker: "qwen", harness: "qwen" },
    { worker: "deepseek", harness: "claude" },
  );
  assert.match(task, /attempt 2 of 2/i);
  assert.match(task, /do not repeat broad discovery/i);
  assert.match(task, /deepseek\/claude/i);
  assert.match(task, /locales\/one\.reds/);
  assert.match(task, /compar(?:e|ing).*current workspace diff/i);
});

test("reserves the MCP deadline across planner, retries, and gates", () => {
  const deadline = computeProjectDeadline({
    requestedMinutes: 12,
    mode: "implement",
    hasPlanner: true,
    runGate: true,
    initialAttempt: 1,
    mcpTimeoutSeconds: 300,
  });
  assert.equal(deadline.planner_max_turns, 4);
  assert.equal(deadline.attempt_count, 2);
  assert.equal(deadline.clamped, true);
  assert.ok(deadline.allocated_seconds <= deadline.safe_total_seconds);
  assert.ok(deadline.safe_total_seconds < deadline.outer_timeout_seconds);
  assert.ok(deadline.attempt_timeout_seconds[0] > deadline.attempt_timeout_seconds[1]);
  assert.ok(deadline.attempt_timeout_seconds[1] <= 45);
});

test("gives the first large worker enough time to finish one provider response", () => {
  const deadline = computeProjectDeadline({
    requestedMinutes: 12,
    mode: "implement",
    hasPlanner: false,
    runGate: true,
    initialAttempt: 1,
    mcpTimeoutSeconds: 300,
  });
  assert.deepEqual(deadline.attempt_timeout_seconds, [190, 45]);
  assert.deepEqual(deadline.max_wall_time_seconds, [182, 37]);
});

test("keeps focused scouts cheap and marks unavailable usage explicitly", () => {
  const deadline = computeProjectDeadline({
    requestedMinutes: 2,
    mode: "inspect",
    hasPlanner: false,
    runGate: false,
    mcpTimeoutSeconds: 300,
  });
  assert.equal(deadline.planner_max_turns, 0);
  assert.equal(deadline.attempt_count, 2);
  const unavailable = usageAvailability(null, "FatalTurnLimitedError before result event");
  assert.equal(unavailable.availability, "unavailable");
  assert.match(unavailable.reason, /FatalTurnLimitedError/);
  const reported = usageAvailability({ total_tokens: 42, input_tokens: 30, output_tokens: 12 });
  assert.equal(reported.total_tokens, 42);
});

test("compacts scout pack metadata without leaking pack content", () => {
  const compacted = compactPackMetadata({
    enabled: false,
    reason: "benchmark off",
    char_count: 123,
    max_chars: 10000,
    truncated: false,
    file_count: 7,
    match_count: 3,
    elapsed_ms: 40,
    wrapper_elapsed_ms: 900,
    content: "must not propagate",
  });
  assert.equal(compacted.enabled, false);
  assert.equal(compacted.reason, "benchmark off");
  assert.equal(compacted.wrapper_elapsed_ms, 900);
  assert.equal("content" in compacted, false);
});

test("aggregates multiple scout packs with explicit enabled counts", () => {
  const combined = combineScoutPacks([
    { enabled: true, char_count: 5000, file_count: 10, match_count: 4, elapsed_ms: 50, wrapper_elapsed_ms: 800 },
    { enabled: false, reason: "A/B off", char_count: 0, file_count: 0, match_count: 0, elapsed_ms: 0, wrapper_elapsed_ms: 1200 },
  ]);
  assert.equal(combined.count, 2);
  assert.equal(combined.enabled_count, 1);
  assert.equal(combined.disabled_count, 1);
  assert.equal(combined.all_enabled, false);
  assert.equal(combined.total_char_count, 5000);
  assert.equal(combined.total_wrapper_elapsed_ms, 2000);
});

test("scales from one assistant to a pair and then a live-research team", () => {
  assert.equal(planTaskTeam({ task: "Fix a typo" }).assistant_count, 1);
  assert.equal(planTaskTeam({ task: "Refactor the architecture across the API and test modules" }).assistant_count, 2);
  const complex = planTaskTeam({
    task: "Build a production-ready full-stack system with a database, security, tests, deployment, and the latest official API version.",
  });
  assert.equal(complex.complexity.level, "complex");
  assert.equal(complex.assistant_count, 3);
  assert.equal(complex.use_grok, true);
  assert.equal(planTaskTeam({
    task: "Build a production-ready full-stack system with a database, security, tests, deployment, and the latest official API version.",
    maxAssistants: 1,
  }).assistant_count, 1);
});

test("complexity analysis recognizes multi-discipline project work", () => {
  const result = analyzeTaskComplexity({
    task: "Migrate and redesign the full-stack app, including frontend, backend, database, tests, and deployment.",
  });
  assert.equal(result.level, "complex");
  assert.ok(result.score >= 6);
});

test("complex single-file browser games receive a planning assistant", () => {
  const result = planTaskTeam({
    task: "Build a single-file Canvas FPS game with pointer lock, raycasting, enemy waves, health, ammo, reload, pickups, HUD, and a minimap.",
    allowedPaths: ["outputs/fps-training.html"],
  });
  assert.equal(result.complexity.level, "medium");
  assert.equal(result.coding_assistants, 2);
  assert.equal(result.use_planner, true);
});

test("initializes a local git baseline for implementation work", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "ai-team-baseline-"));
  try {
    const baseline = await ensureGitBaseline(cwd, "implement");
    assert.equal(baseline.status, "initialized");
    const second = await ensureGitBaseline(cwd, "implement");
    assert.equal(second.status, "existing");
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("project_task completes one internal retry without another MCP call", async () => {
  const root = await mkdtemp(join(tmpdir(), "ai-team-retry-"));
  const cwd = join(root, "workspace");
  const scripts = join(root, "scripts");
  const previousScriptRoot = process.env.AI_TEAM_SCRIPT_ROOT;
  await mkdir(cwd);
  await mkdir(scripts);
  const workerScript = String.raw`param(
  [string]$Worker, [string]$Task, [string]$Cwd, [string]$TaskId, [int]$Attempt,
  [string]$Approval, [string]$Budget, [string]$MaxWallTime, [int]$MaxSessionTurns,
  [int]$SummaryMaxChars, [string]$AllowedPathJson, [switch]$JsonOnly
)
$runDir = Join-Path $env:TEMP "fake-worker-$TaskId-$Attempt"
New-Item -ItemType Directory -Force -Path $runDir | Out-Null
$changed = @()
if ($Attempt -eq 2) {
  "ready" | Set-Content -LiteralPath (Join-Path $Cwd "out.txt") -Encoding UTF8
  $changed = @("out.txt")
}
[ordered]@{
  status = "success"; model = "fake-model"; summary = "attempt $Attempt";
  usage = [ordered]@{ input_tokens = 10; output_tokens = 2; cache_read_tokens = 0; total_tokens = 12; num_turns = 1 };
  changed_files = $changed; artifacts = [ordered]@{ run_dir = $runDir; worker_result = ""; full_result = "" }
} | ConvertTo-Json -Depth 5 -Compress
`;
  const gateScript = String.raw`param(
  [string]$Cwd, [string]$TaskId, [string]$Task, [int]$Attempt, [string]$RequirementStatus,
  [string]$AllowedPathJson, [string]$ChangedPathJson, [string]$WorkerRunDir, [switch]$JsonOnly
)
$decision = $(if ($Attempt -eq 1) { "retry" } else { "accept" })
$score = $(if ($Attempt -eq 1) { 85 } else { 95 })
[ordered]@{
  decision = $decision; score = $score; reason = "fixture"; requirement_status = $RequirementStatus;
  hard_failures = @(); checks = [ordered]@{}; metrics = [ordered]@{};
  retry = [ordered]@{ allowed = ($Attempt -eq 1); instruction = "finish the output" };
  codex_takeover = [ordered]@{ required = $false };
  artifacts = [ordered]@{ gate_report = ""; handoff = "" }
} | ConvertTo-Json -Depth 5 -Compress
`;

  try {
    await writeFile(join(scripts, "codex-worker.ps1"), workerScript, "utf8");
    await writeFile(join(scripts, "codex-gate.ps1"), gateScript, "utf8");
    process.env.AI_TEAM_SCRIPT_ROOT = scripts;
    const result = await runProjectTask({
      cwd,
      task: "Implement the bounded fixture",
      mode: "implement",
      max_assistants: 1,
      max_minutes: 1,
      allowed_paths: ["out.txt"],
      run_gate: true,
    });
    assert.equal(result.status, "accept");
    assert.equal(result.attempts.length, 2);
    assert.deepEqual(result.attempts.map((entry) => entry.gate_decision), ["retry", "accept"]);
    assert.deepEqual(result.attempts.map((entry) => entry.turn_policy.max_session_turns), [6, 4]);
    assert.equal(result.turn_policy.first_attempt.max_session_turns, 6);
    assert.equal(result.turn_policy.targeted_retry.max_session_turns, 4);
    assert.equal(result.turn_policy.planner_max_session_turns, 0);
    assert.deepEqual(result.changed_files, ["out.txt"]);
    assert.equal(result.usage.total_tokens, 24);
    assert.equal(result.artifacts.team_runs.length, 2);
  } finally {
    if (previousScriptRoot === undefined) delete process.env.AI_TEAM_SCRIPT_ROOT;
    else process.env.AI_TEAM_SCRIPT_ROOT = previousScriptRoot;
    await rm(root, { recursive: true, force: true });
  }
});

test("project_task switches once from a turn-limited Qwen scout to an independent DeepSeek harness", async () => {
  const root = await mkdtemp(join(tmpdir(), "ai-team-failover-"));
  const cwd = join(root, "workspace");
  const scripts = join(root, "scripts");
  const previousScriptRoot = process.env.AI_TEAM_SCRIPT_ROOT;
  await mkdir(cwd);
  await mkdir(scripts);
  const scoutScript = String.raw`param(
  [string]$Task, [string]$TaskId, [string]$Cwd, [string]$Worker, [string]$DeepSeekHarness,
  [string]$Budget, [string]$MaxWallTime, [int]$MaxSessionTurns,
  [int]$SummaryMaxChars, [switch]$JsonOnly
)
$failed = $Worker -eq "qwen"
[ordered]@{
  status = $(if ($failed) { "failed" } else { "success" })
  worker = $Worker
  harness = $(if ($Worker -eq "deepseek") { $DeepSeekHarness } else { "qwen" })
  model = "fake-$Worker"
  error = $(if ($failed) { "FatalTurnLimitedError: Reached max session turns" } else { "" })
  summary = $(if ($failed) { "Reached max session turns" } else { "fallback inspection complete" })
  usage = [ordered]@{ input_tokens = 4; output_tokens = 2; total_tokens = 6; num_turns = 1 }
  changed_files = @()
  scout_pack = [ordered]@{ enabled = $false; reason = "fixture"; char_count = 0; max_chars = 1000; truncated = $false; file_count = 0; match_count = 0; elapsed_ms = 0; wrapper_elapsed_ms = 1 }
  task_id = $TaskId
  artifacts = [ordered]@{ run_dir = "fake-$TaskId-$Worker-$DeepSeekHarness"; worker_result = ""; full_result = "" }
  received_task_id = $TaskId
} | ConvertTo-Json -Depth 5 -Compress
`;

  try {
    await writeFile(join(scripts, "codex-scout.ps1"), scoutScript, "utf8");
    process.env.AI_TEAM_SCRIPT_ROOT = scripts;
    const result = await runProjectTask({
      cwd,
      task: "Inspect the helper recovery path",
      mode: "inspect",
      preferred: "qwen",
      max_assistants: 1,
      max_minutes: 1,
      research_context: "fixture: bypass mechanical inspection",
    });
    assert.equal(result.status, "success");
    assert.equal(result.attempts.length, 2);
    assert.deepEqual(result.route_history, [
      { attempt: 1, worker: "qwen", harness: "qwen", failure_kind: "turn_limit" },
      { attempt: 2, worker: "deepseek", harness: "claude", failure_kind: "none" },
    ]);
    assert.deepEqual(result.attempts[0].failover_to, { worker: "deepseek", harness: "claude" });
    assert.match(result.summary, /fallback inspection complete/);
    assert.equal(result.artifacts.team_runs.length, 2);
    assert.ok(result.artifacts.team_runs.every((run) => run.includes(result.task_id)));
    assert.equal(result.turn_policy.first_attempt.max_session_turns, 3);
    assert.equal(result.turn_policy.targeted_retry.max_session_turns, 3);
  } finally {
    if (previousScriptRoot === undefined) delete process.env.AI_TEAM_SCRIPT_ROOT;
    else process.env.AI_TEAM_SCRIPT_ROOT = previousScriptRoot;
    await rm(root, { recursive: true, force: true });
  }
});

test("project_task recovers a structured partial handoff from a nonzero PowerShell exit", async () => {
  const root = await mkdtemp(join(tmpdir(), "ai-team-nonzero-handoff-"));
  const cwd = join(root, "workspace");
  const scripts = join(root, "scripts");
  const previousScriptRoot = process.env.AI_TEAM_SCRIPT_ROOT;
  await mkdir(cwd);
  await mkdir(scripts);
  const workerScript = String.raw`param(
  [string]$Worker, [string]$Task, [string]$Cwd, [string]$TaskId, [int]$Attempt,
  [string]$Approval, [string]$Budget, [string]$MaxWallTime, [int]$MaxSessionTurns,
  [int]$SummaryMaxChars, [string]$AllowedPathJson, [string]$DeepSeekHarness, [switch]$JsonOnly
)
$partial = Join-Path $Cwd "partial.txt"
if ($Attempt -eq 1) { "useful" | Set-Content -LiteralPath $partial -Encoding UTF8 }
[ordered]@{
  status = $(if ($Attempt -eq 1) { "failed" } else { "success" })
  worker = $Worker
  harness = $(if ($Worker -eq "deepseek") { $DeepSeekHarness } else { "qwen" })
  model = "fake-$Worker"
  error = $(if ($Attempt -eq 1) { "wall-clock timeout with partial output" } else { "" })
  summary = $(if ($Attempt -eq 1) { "timed out after preserving partial.txt" } else { "fallback preserved and completed partial.txt" })
  usage = [ordered]@{ input_tokens = 10; output_tokens = 2; total_tokens = 12; num_turns = 1 }
  changed_files = @("partial.txt")
  allowed_paths = @("partial.txt")
  artifacts = [ordered]@{ run_dir = "fake-$Attempt"; worker_result = "fake-worker-result.json"; full_result = "fake-result.txt" }
} | ConvertTo-Json -Depth 5 -Compress
if ($Attempt -eq 1) { exit 55 }
`;

  try {
    await writeFile(join(scripts, "codex-worker.ps1"), workerScript, "utf8");
    process.env.AI_TEAM_SCRIPT_ROOT = scripts;
    const result = await runProjectTask({
      cwd,
      task: "Implement the bounded timeout recovery fixture",
      mode: "implement",
      preferred: "qwen",
      max_assistants: 1,
      max_minutes: 1,
      allowed_paths: ["partial.txt"],
      run_gate: false,
    });
    assert.equal(result.status, "success");
    assert.equal(result.attempts.length, 2);
    assert.equal(result.attempts[0].failure_kind, "timeout");
    assert.deepEqual(result.attempts[0].failover_to, { worker: "deepseek", harness: "claude" });
    assert.deepEqual(result.changed_files, ["partial.txt"]);
    assert.equal(result.usage.total_tokens, 24);
    assert.equal(result.artifacts.team_runs.length, 2);
  } finally {
    if (previousScriptRoot === undefined) delete process.env.AI_TEAM_SCRIPT_ROOT;
    else process.env.AI_TEAM_SCRIPT_ROOT = previousScriptRoot;
    await rm(root, { recursive: true, force: true });
  }
});
