import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { access, readdir, stat } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { mechanicalInspect } from "./mechanical-inspector.mjs";
import { planTaskTeam } from "./team-planner.mjs";
import { buildTargetedRetryPrompt, selectTurnPolicy } from "./turn-policy.mjs";

const execFileAsync = promisify(execFile);
const serverDir = dirname(fileURLToPath(import.meta.url));

const INSPECTION_WORDS = /\b(inspect|audit|investigate|find|locate|map|read logs?|analy[sz]e|triage|review existing)\b|检查|分析|查找|定位|日志|盘点|侦查|审计|项目地图/i;
const DOCUMENT_WORDS = /\b(docs?|readme|summary|summarize|organize|translate)\b|文档|总结|整理|翻译|润色/i;
const CODE_WORDS = /\b(code|bug|fix|implement|refactor|test|build|lint|typecheck|typescript|javascript|python|powershell|css|react|api)\b|代码|脚本|修复|实现|测试|构建|重构|页面|接口/i;

function compact(value, maxChars = 2600) {
  const text = String(value || "").trim();
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars)}\n[truncated; use the artifact path for full output]`;
}

function parseJsonOutput(stdout, label) {
  const text = String(stdout || "").replace(/^\uFEFF/, "").trim();
  try {
    return JSON.parse(text);
  } catch {
    const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    for (let index = lines.length - 1; index >= 0; index -= 1) {
      try {
        return JSON.parse(lines[index]);
      } catch {}
    }
  }
  throw new Error(`${label} did not return valid JSON: ${compact(text, 1200)}`);
}

function normalizeAllowedPaths(values = []) {
  if (!Array.isArray(values)) return [];
  return [...new Set(values.map((value) => String(value).trim()).filter(Boolean))].map((value) => {
    const normalized = value.replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/$/, "");
    if (!normalized || normalized === ".") return ".";
    if (isAbsolute(value) || normalized === ".." || normalized.startsWith("../") || normalized.includes("/../")) {
      throw new Error(`allowed_paths must stay inside cwd: ${value}`);
    }
    return normalized;
  });
}

async function resolveScript(name) {
  const configuredRoot = process.env.AI_TEAM_SCRIPT_ROOT;
  const candidates = [
    configuredRoot ? resolve(configuredRoot, name) : "",
    resolve(serverDir, "..", "scripts", name),
    resolve(serverDir, "..", name),
  ].filter(Boolean);
  for (const candidate of candidates) {
    try {
      await access(candidate);
      return candidate;
    } catch {}
  }
  throw new Error(`AI Team script not found: ${name}`);
}

async function runPowerShell(script, scriptArgs, timeoutMs) {
  try {
    return await execFileAsync(
      "powershell.exe",
      ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", script, ...scriptArgs],
      { encoding: "utf8", windowsHide: true, timeout: timeoutMs, maxBuffer: 1024 * 1024 },
    );
  } catch (error) {
    const details = compact([error?.message, error?.stdout, error?.stderr].filter(Boolean).join("\n"), 1800);
    throw new Error(`Local project worker failed: ${details}`);
  }
}

async function resolveGitCommand() {
  const candidates = [
    process.env.AI_TEAM_GIT_DIR ? join(process.env.AI_TEAM_GIT_DIR, "git.exe") : "",
    process.env.USERPROFILE ? join(process.env.USERPROFILE, ".cache", "codex-runtimes", "codex-primary-runtime", "dependencies", "native", "git", "cmd", "git.exe") : "",
    process.env.ProgramFiles ? join(process.env.ProgramFiles, "Git", "cmd", "git.exe") : "",
    process.env["ProgramFiles(x86)"] ? join(process.env["ProgramFiles(x86)"], "Git", "cmd", "git.exe") : "",
  ].filter(Boolean);
  const portableRoot = process.env.LOCALAPPDATA
    ? join(process.env.LOCALAPPDATA, "Programs", "PortableGit")
    : "";
  if (portableRoot) {
    const entries = await readdir(portableRoot, { withFileTypes: true }).catch(() => []);
    for (const entry of entries.filter((item) => item.isDirectory()).sort((a, b) => b.name.localeCompare(a.name))) {
      candidates.unshift(join(portableRoot, entry.name, "cmd", "git.exe"));
    }
  }
  for (const candidate of candidates) {
    try {
      await access(candidate);
      return candidate;
    } catch {}
  }
  return "git";
}

export async function ensureGitBaseline(cwd, mode) {
  if (mode !== "implement") return { status: "not_needed", initialized: false };
  const gitCommand = await resolveGitCommand();
  try {
    await execFileAsync(gitCommand, ["rev-parse", "--is-inside-work-tree"], {
      cwd,
      encoding: "utf8",
      windowsHide: true,
      timeout: 5000,
    });
    return { status: "existing", initialized: false };
  } catch {}

  try {
    await execFileAsync(gitCommand, ["init", "-q"], {
      cwd,
      encoding: "utf8",
      windowsHide: true,
      timeout: 10000,
    });
    return { status: "initialized", initialized: true };
  } catch (error) {
    return { status: "unavailable", initialized: false, error: compact(error?.message, 300) };
  }
}

async function runScout({ task, cwd, worker, harness = "qwen", budget, maxWallTime, timeoutMs, maxTurns = 2, summaryMaxChars = 2400 }) {
  const scoutScript = await resolveScript("codex-scout.ps1");
  const scriptArgs = [
    "-Task", String(task),
    "-Cwd", cwd,
    "-Worker", worker,
    "-Budget", budget,
    "-MaxWallTime", maxWallTime,
    "-MaxSessionTurns", String(maxTurns),
    "-SummaryMaxChars", String(summaryMaxChars),
    "-JsonOnly",
  ];
  if (worker === "deepseek") scriptArgs.push("-DeepSeekHarness", harness);
  const execution = await runPowerShell(scoutScript, scriptArgs, timeoutMs);
  const result = parseJsonOutput(execution.stdout, `${worker} scout worker`);
  return { ...result, worker: result.worker || worker, harness: result.harness || harness };
}

export function compactPackMetadata(scoutPack) {
  if (!scoutPack) return null;
  return {
    enabled: Boolean(scoutPack.enabled),
    reason: String(scoutPack.reason || ""),
    char_count: Number(scoutPack.char_count || 0),
    max_chars: Number(scoutPack.max_chars || 0),
    truncated: Boolean(scoutPack.truncated),
    file_count: Number(scoutPack.file_count || 0),
    match_count: Number(scoutPack.match_count || 0),
    elapsed_ms: Number(scoutPack.elapsed_ms || 0),
    wrapper_elapsed_ms: Number(scoutPack.wrapper_elapsed_ms || 0),
  };
}

export function combineScoutPacks(packs = []) {
  const present = packs.map(compactPackMetadata).filter(Boolean);
  if (present.length === 0) return null;
  const enabledCount = present.filter((pack) => pack.enabled).length;
  return {
    all_enabled: enabledCount === present.length,
    enabled_count: enabledCount,
    disabled_count: present.length - enabledCount,
    total_char_count: present.reduce((s, p) => s + (Number(p.char_count) || 0), 0),
    max_chars: Math.max(...present.map((p) => Number(p.max_chars) || 0)),
    total_truncated: present.some((p) => p.truncated),
    total_file_count: present.reduce((s, p) => s + (Number(p.file_count) || 0), 0),
    total_match_count: present.reduce((s, p) => s + (Number(p.match_count) || 0), 0),
    total_elapsed_ms: present.reduce((s, p) => s + (Number(p.elapsed_ms) || 0), 0),
    total_wrapper_elapsed_ms: present.reduce((s, p) => s + (Number(p.wrapper_elapsed_ms) || 0), 0),
    count: present.length,
  };
}

function combineInspectionResults(results) {
  const successful = results.filter((result) => result?.status === "success");
  const usable = successful.length > 0 ? successful : results.filter(Boolean);
  const usage = usable.reduce((sum, result) => {
    for (const key of ["input_tokens", "output_tokens", "cache_read_tokens", "total_tokens", "num_turns"]) {
      sum[key] += Number(result?.usage?.[key] || 0);
    }
    return sum;
  }, { input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, total_tokens: 0, num_turns: 0 });
  const scoutPacks = usable.map((r) => r.scout_pack).filter(Boolean);
  return {
    status: successful.length > 0 ? "success" : "failed",
    error: successful.length > 0 ? "" : usable.map((result) => result.error || result.summary).filter(Boolean).join("\n"),
    model: usable.map((result) => result.model).filter(Boolean).join(", "),
    summary: usable.map((result, index) => `## Scout ${index + 1}\n${result.summary || "No summary."}`).join("\n\n"),
    usage,
    changed_files: [],
    scout_pack: compactPackMetadata(usable[0]?.scout_pack),
    scout_packs_combined: combineScoutPacks(scoutPacks),
    artifacts: usable[0]?.artifacts || {},
    team_runs: usable.map((result) => result.artifacts?.run_dir).filter(Boolean),
  };
}

function combineUsage(results = []) {
  const keys = [
    "input_tokens", "output_tokens", "cache_read_tokens", "uncached_input_tokens",
    "thinking_tokens", "total_tokens", "num_turns", "request_count", "provider_duration_ms",
  ];
  let anyUnavailable = false;
  const usage = results.reduce((sum, result) => {
    const u = result?.usage;
    if (u && u.availability === "unavailable") {
      anyUnavailable = true;
      return sum;
    }
    for (const key of keys) sum[key] += Number(u?.[key] || 0);
    return sum;
  }, Object.fromEntries(keys.map((key) => [key, 0])));
  const hasTokens = Object.values(usage).some((value) => value > 0);
  if (hasTokens) {
    if (anyUnavailable) usage.availability_note = "Some worker runs did not report usage";
    return usage;
  }
  if (anyUnavailable || results.some((r) => r?.usage?.availability === "unavailable")) {
    return { availability: "unavailable", reason: "No worker runs reported token usage" };
  }
  return null;
}

export function usageAvailability(usage, reason = "") {
  if (usage && usage.availability === "unavailable") return usage;
  if (usage && Object.values(usage).some((v) => Number(v) > 0)) return usage;
  return {
    availability: "unavailable",
    reason: reason || "CLI usage not available; structured output could not be parsed",
  };
}

const MCP_TIMEOUT_SECONDS = Number(process.env.AI_TEAM_MCP_TIMEOUT_SECONDS) || 300;

export function computeProjectDeadline({
  requestedMinutes = 5,
  mode = "implement",
  hasPlanner = false,
  runGate = true,
  initialAttempt = 1,
  allowWorkerFailover = true,
  mcpTimeoutSeconds = MCP_TIMEOUT_SECONDS,
} = {}) {
  const outerSeconds = Math.max(90, Number(mcpTimeoutSeconds) || 300);
  const safeTotalSeconds = Math.max(60, outerSeconds - 25);
  const attemptCount = initialAttempt < 2 && ((mode === "implement" && runGate) || allowWorkerFailover) ? 2 : 1;
  const gateSecondsEach = runGate ? 15 : 0;
  const overheadSeconds = 10;
  const plannerTimeoutSeconds = hasPlanner ? Math.min(45, Math.max(30, Math.floor(safeTotalSeconds * 0.16))) : 0;
  const workerPoolSeconds = Math.max(
    30,
    safeTotalSeconds - overheadSeconds - plannerTimeoutSeconds - (gateSecondsEach * attemptCount),
  );
  const requestedSeconds = Math.max(30, Math.floor(Number(requestedMinutes) * 60));
  const retryTimeoutSeconds = attemptCount === 2
    ? Math.min(45, Math.max(30, Math.floor(workerPoolSeconds * 0.20)))
    : 0;
  const firstTimeoutSeconds = Math.min(requestedSeconds + 8, workerPoolSeconds - retryTimeoutSeconds);
  const attemptTimeoutSeconds = attemptCount === 2
    ? [Math.max(30, firstTimeoutSeconds), Math.max(30, Math.min(requestedSeconds + 8, retryTimeoutSeconds))]
    : [Math.max(30, Math.min(requestedSeconds + 8, workerPoolSeconds))];
  const maxWallTimeSeconds = attemptTimeoutSeconds.map((seconds) => Math.max(22, seconds - 8));
  const allocatedSeconds = overheadSeconds + plannerTimeoutSeconds
    + (gateSecondsEach * attemptCount) + attemptTimeoutSeconds.reduce((sum, seconds) => sum + seconds, 0);
  return {
    outer_timeout_seconds: outerSeconds,
    safe_total_seconds: safeTotalSeconds,
    safety_buffer_seconds: outerSeconds - safeTotalSeconds,
    planner_max_turns: hasPlanner ? 4 : 0,
    planner_timeout_seconds: plannerTimeoutSeconds,
    attempt_timeout_seconds: attemptTimeoutSeconds,
    max_wall_time_seconds: maxWallTimeSeconds,
    gate_timeout_seconds: gateSecondsEach,
    attempt_count: attemptCount,
    allocated_seconds: allocatedSeconds,
    clamped: attemptTimeoutSeconds.some((seconds) => seconds < requestedSeconds + 8),
  };
}

export function buildTargetedRetryTask(gate = {}, workerResult = {}) {
  const turnPolicyPrompt = buildTargetedRetryPrompt({ gate, workerResult });
  const parts = [
    "Targeted retry: this is attempt 2 of 2. Continue from the current workspace state.",
    turnPolicyPrompt,
  ];
  if (gate.retry?.instruction) parts.push(`Gate instruction: ${gate.retry.instruction}`);
  if (workerResult.summary) parts.push(`Previous attempt summary:\n${compact(workerResult.summary, 900)}`);
  return parts.filter(Boolean).join("\n");
}

export function shouldRunTargetedRetry(gate, attempt, finalAttempt = 2) {
  return gate?.decision === "retry" && attempt < finalAttempt;
}

const TERMINAL_WORKER_FAILURE = /\b(?:401|403|unauthori[sz]ed|forbidden|authentication|invalid (?:api|auth)[ _-]?key|(?:api|auth)[ _-]?key.*(?:missing|not configured)|permission denied|access denied)\b|(?:api|auth)[ _-]?key[^\n]*is not configured|allowed_paths? must|outside allowed|secret detected|forbidden path|invalid cwd|script not found/i;
const TURN_LIMIT_FAILURE = /FatalTurnLimited|reached max(?:imum)? session turns|max session turns|session turn limit|turn limit(?:ed)?/i;
const TIMEOUT_FAILURE = /ETIMEDOUT|timed? out|timeout|exceeded.*wall.?time/i;
const HARNESS_STDIN_FAILURE = /no stdin data received|stdin.*(?:not received|initiali[sz]|closed|unavailable)/i;
const TRANSIENT_WORKER_FAILURE = /\b(?:429|rate.?limit|500|502|503|504|service unavailable|bad gateway|gateway timeout|ECONNRESET|ECONNREFUSED|connection reset|temporary|capacity|overloaded)\b|structured output could not be parsed|did not return valid json|produced no result|process.*(?:failed|crash)|cli.*(?:failed|not found|not recognized)/i;

export function classifyWorkerFailure(workerResult = {}) {
  if (workerResult?.status === "success") return { kind: "none", retryable: false };
  const text = [workerResult?.error, workerResult?.summary, workerResult?.message]
    .filter(Boolean).join("\n");
  if (TERMINAL_WORKER_FAILURE.test(text)) return { kind: "configuration_or_safety", retryable: false };
  if (TURN_LIMIT_FAILURE.test(text)) return { kind: "turn_limit", retryable: true };
  if (TIMEOUT_FAILURE.test(text)) return { kind: "timeout", retryable: true };
  if (HARNESS_STDIN_FAILURE.test(text)) return { kind: "harness_stdin", retryable: true };
  if (TRANSIENT_WORKER_FAILURE.test(text)) return { kind: "transient_or_harness", retryable: true };
  return { kind: "worker_failure", retryable: true };
}

export function selectWorkerFailoverRoute(route = {}) {
  const worker = route.worker === "qwen" ? "qwen" : "deepseek";
  const harness = route.harness === "claude" ? "claude" : "qwen";
  if (worker === "qwen" || harness === "qwen") {
    return { worker: "deepseek", harness: "claude" };
  }
  return { worker: "qwen", harness: "qwen" };
}

export function buildWorkerFailoverTask(workerResult = {}, failure = {}, fromRoute = {}, toRoute = {}) {
  const changedFiles = (workerResult.changed_files || []).map(String).filter(Boolean);
  const allowedPaths = (workerResult.allowed_paths || []).map(String).filter(Boolean);
  return [
    "Worker failover: this is attempt 2 of 2. Continue from the current workspace state.",
    "Do not repeat broad discovery. Inspect only what is needed to finish or verify the prior partial work.",
    `Previous route ${fromRoute.worker || "unknown"}/${fromRoute.harness || "unknown"} failed (${failure.kind || "worker_failure"}).`,
    `Continue with ${toRoute.worker || "fallback"}/${toRoute.harness || "default"}; do not bypass authentication, permission, quota, or safety restrictions.`,
    changedFiles.length > 0 ? `Useful partial files already changed: ${changedFiles.join(", ")}. Preserve them unless focused validation proves they are wrong.` : "",
    allowedPaths.length > 0 ? `Original allowed paths: ${allowedPaths.join(", ")}. Determine the remaining scope by comparing these paths with the current workspace diff.` : "",
    workerResult.summary ? `Previous attempt summary:\n${compact(workerResult.summary, changedFiles.length > 0 ? 450 : 900)}` : "",
  ].filter(Boolean).join("\n");
}

export function selectProjectMode(task = "", requested = "auto") {
  if (["inspect", "implement"].includes(requested)) return requested;
  return INSPECTION_WORDS.test(String(task)) ? "inspect" : "implement";
}

export function selectProjectWorker(task = "", mode = "implement", preferred = "auto") {
  if (["qwen", "deepseek"].includes(preferred)) return preferred;
  if (mode === "inspect") return "qwen";
  const text = String(task);
  if (DOCUMENT_WORDS.test(text) && !CODE_WORDS.test(text)) return "qwen";
  return "deepseek";
}

export function previewProjectTask(args = {}) {
  const mode = selectProjectMode(args.task, args.mode);
  const worker = selectProjectWorker(args.task, mode, args.preferred);
  const team = planTaskTeam({
    task: args.task,
    context: args.context,
    allowedPaths: args.allowed_paths,
    maxAssistants: args.max_assistants,
  });
  const planner = worker === "qwen" ? "deepseek" : "qwen";
  return {
    dry_run: true,
    mode,
    worker,
    planner: team.use_planner ? planner : null,
    complexity: team.complexity,
    team: {
      assistant_count: team.assistant_count,
      coding_assistants: team.coding_assistants,
      use_grok: team.use_grok,
      max_assistants: team.max_assistants,
    },
    budget: args.budget || "low",
    approval: mode === "inspect" ? "auto" : "yolo",
    run_gate: mode === "implement" && args.run_gate !== false,
    worker_failover: args.worker_failover !== false,
    max_minutes: Number(args.max_minutes) || (mode === "inspect" ? 5 : 8),
  };
}

export function requirementStatusForWorker(workerResult = {}, mode = "implement") {
  const changedFiles = Array.isArray(workerResult.changed_files) ? workerResult.changed_files : [];
  if (mode !== "implement") return workerResult.status === "success" ? "pass" : "unknown";
  const summary = String(workerResult.summary || "");
  if (workerResult.status !== "success") return changedFiles.length > 0 ? "partial" : "fail";
  if (changedFiles.length > 0) return "pass";
  if (/\b(blocked|cannot|unable|denied|permission)\b|无法|不能|拒绝|权限/i.test(summary)) return "fail";
  return "unknown";
}

export async function runProjectTask(args = {}) {
  if (!String(args.task || "").trim()) throw new Error("project_task requires task.");
  if (!String(args.cwd || "").trim()) throw new Error("project_task requires cwd.");

  const cwd = resolve(String(args.cwd));
  const cwdStat = await stat(cwd).catch(() => null);
  if (!cwdStat?.isDirectory()) throw new Error(`cwd is not a directory: ${cwd}`);

  const preview = previewProjectTask(args);
  const allowedPaths = normalizeAllowedPaths(args.allowed_paths || []);
  if (args.dry_run === true) return { ...preview, cwd, allowed_paths: allowedPaths };

  const mechanical = preview.mode === "inspect" && !args.research_context
    ? await mechanicalInspect(args.task, cwd)
    : null;
  if (mechanical) {
    mechanical.task_id = String(args.task_id || mechanical.task_id || `mechanical-${Date.now()}-${randomUUID().slice(0, 8)}`);
    mechanical.cwd = cwd;
    mechanical.allowed_paths = allowedPaths;
    return mechanical;
  }

  const taskId = String(args.task_id || `project-${Date.now()}-${randomUUID().slice(0, 8)}`);
  const maxMinutes = Math.max(1, Math.min(15, preview.max_minutes));
  const initialAttempt = Number(args.attempt) === 2 ? 2 : 1;
  const finalAttempt = initialAttempt < 2 && (preview.run_gate !== false || preview.worker_failover)
    ? 2
    : initialAttempt;
  const hasPlanner = preview.mode === "implement" && preview.team.coding_assistants >= 2;
  const deadline = computeProjectDeadline({
    requestedMinutes: maxMinutes,
    mode: preview.mode,
    hasPlanner,
    runGate: preview.run_gate !== false,
    initialAttempt,
    allowWorkerFailover: preview.worker_failover,
  });
  const gateTimeoutMs = Math.max(1, deadline.gate_timeout_seconds) * 1000;
  const allowedJson = JSON.stringify(allowedPaths);
  const gitBaseline = await ensureGitBaseline(cwd, preview.mode);
  let plannerResult = null;
  let workerResult;
  let gate = null;
  const workerResults = [];
  const attempts = [];
  const changedFileSet = new Set();

  if (preview.mode === "inspect") {
    const workers = preview.team.coding_assistants >= 2
      ? [preview.worker, preview.planner]
      : [preview.worker];
    const initialRoutes = workers.map((worker) => ({ worker, harness: "qwen" }));
    const settled = await Promise.allSettled(initialRoutes.map((route) => runScout({
      task: args.task,
      cwd,
      worker: route.worker,
      harness: route.harness,
      budget: preview.budget,
      maxWallTime: `${deadline.max_wall_time_seconds[0]}s`,
      timeoutMs: deadline.attempt_timeout_seconds[0] * 1000,
    })));
    const results = settled.map((entry, index) => entry.status === "fulfilled"
      ? entry.value
      : {
          status: "failed",
          error: compact(entry.reason?.message || entry.reason),
          summary: compact(entry.reason?.message || entry.reason),
          changed_files: [],
          ...initialRoutes[index],
        });
    workerResults.push(...results);
    workerResult = results.length === 1 ? results[0] : combineInspectionResults(results);
    const firstFailure = classifyWorkerFailure(workerResult);
    attempts.push({
      attempt: initialAttempt,
      worker: initialRoutes.map((route) => route.worker).join(","),
      harness: initialRoutes.map((route) => route.harness).join(","),
      worker_status: workerResult.status,
      changed_files: [],
      worker_run: workerResult.artifacts?.run_dir || null,
      gate_decision: null,
      gate_score: null,
      failure_kind: firstFailure.kind,
      turn_policy: selectTurnPolicy({ complexity: preview.complexity.level, attempt: initialAttempt }),
    });

    if (preview.worker_failover && firstFailure.retryable && initialAttempt < finalAttempt) {
      const fromRoute = initialRoutes[0];
      const fallbackRoute = selectWorkerFailoverRoute(fromRoute);
      const fallbackTask = buildWorkerFailoverTask(workerResult, firstFailure, fromRoute, fallbackRoute);
      let fallbackResult;
      try {
        fallbackResult = await runScout({
          task: [String(args.task), fallbackTask].join("\n\n"),
          cwd,
          worker: fallbackRoute.worker,
          harness: fallbackRoute.harness,
          budget: preview.budget,
          maxWallTime: `${deadline.max_wall_time_seconds[1]}s`,
          timeoutMs: deadline.attempt_timeout_seconds[1] * 1000,
          maxTurns: selectTurnPolicy({ complexity: preview.complexity.level, attempt: 2 }).max_session_turns,
        });
      } catch (error) {
        fallbackResult = {
          status: "failed",
          error: compact(error?.message || error),
          summary: compact(error?.message || error),
          changed_files: [],
          ...fallbackRoute,
        };
      }
      workerResults.push(fallbackResult);
      workerResult = fallbackResult.status === "success"
        ? fallbackResult
        : combineInspectionResults([...results, fallbackResult]);
      const fallbackFailure = classifyWorkerFailure(fallbackResult);
      attempts[0].failover_to = fallbackRoute;
      attempts.push({
        attempt: 2,
        ...fallbackRoute,
        worker_status: fallbackResult.status,
        changed_files: [],
        worker_run: fallbackResult.artifacts?.run_dir || null,
        gate_decision: null,
        gate_score: null,
        failure_kind: fallbackFailure.kind,
        turn_policy: selectTurnPolicy({ complexity: preview.complexity.level, attempt: 2 }),
      });
    }
  } else {
    if (preview.team.coding_assistants >= 2) {
      try {
        plannerResult = await runScout({
          task: [
            "Prepare a concise implementation plan for another coding worker.",
            "Inspect only the files needed for this task. Identify exact files, risks, and validation commands.",
            "Do not edit files.",
            String(args.task),
          ].join("\n\n"),
          cwd,
          worker: preview.planner,
          budget: "low",
          maxWallTime: `${Math.max(22, deadline.planner_timeout_seconds - 8)}s`,
          timeoutMs: deadline.planner_timeout_seconds * 1000,
          maxTurns: deadline.planner_max_turns,
          summaryMaxChars: 1600,
        });
      } catch (error) {
        plannerResult = { status: "failed", summary: `Planner unavailable: ${compact(error?.message || error, 500)}` };
      }
    }

    const baseWorkerTask = [
      String(args.task),
      plannerResult?.summary ? `Planning scout notes (verify before acting):\n${compact(plannerResult.summary, 1600)}` : "",
      args.research_context ? `Current external research (read-only; verify relevance):\n${compact(args.research_context, 1800)}` : "",
    ].filter(Boolean).join("\n\n");
    const workerScript = await resolveScript("codex-worker.ps1");
    const gateScript = preview.run_gate ? await resolveScript("codex-gate.ps1") : null;
    let retryTask = "";
    let currentRoute = { worker: preview.worker, harness: "qwen" };

    for (let attempt = initialAttempt; attempt <= finalAttempt; attempt += 1) {
      const attemptIndex = attempt - initialAttempt;
      const attemptTimeoutSeconds = deadline.attempt_timeout_seconds[attemptIndex] || deadline.attempt_timeout_seconds.at(-1);
      const attemptWallSeconds = deadline.max_wall_time_seconds[attemptIndex] || deadline.max_wall_time_seconds.at(-1);
      const turnPolicy = selectTurnPolicy({ complexity: preview.complexity.level, attempt });
      const workerTask = [baseWorkerTask, retryTask].filter(Boolean).join("\n\n");
      const workerArgs = [
        "-Worker", currentRoute.worker,
        "-Task", workerTask,
        "-Cwd", cwd,
        "-TaskId", taskId,
        "-Attempt", String(attempt),
        "-Approval", preview.approval,
        "-Budget", preview.budget,
        "-MaxWallTime", `${attemptWallSeconds}s`,
        "-MaxSessionTurns", String(turnPolicy.max_session_turns),
        "-SummaryMaxChars", "2600",
        "-AllowedPathJson", allowedJson,
        "-JsonOnly",
      ];
      if (currentRoute.worker === "deepseek") workerArgs.push("-DeepSeekHarness", currentRoute.harness);
      try {
        const workerExecution = await runPowerShell(workerScript, workerArgs, attemptTimeoutSeconds * 1000);
        workerResult = parseJsonOutput(workerExecution.stdout, "Project worker");
        workerResult = {
          ...workerResult,
          worker: workerResult.worker || currentRoute.worker,
          harness: workerResult.harness || currentRoute.harness,
        };
      } catch (error) {
        workerResult = {
          status: "failed",
          error: compact(error?.message || error),
          summary: compact(error?.message || error),
          changed_files: [],
          artifacts: {},
          ...currentRoute,
        };
      }
      workerResults.push(workerResult);
      for (const file of workerResult.changed_files || []) changedFileSet.add(String(file));

      const workerFailure = classifyWorkerFailure(workerResult);
      if (preview.worker_failover && workerFailure.retryable && attempt < finalAttempt) {
        const fallbackRoute = selectWorkerFailoverRoute(currentRoute);
        attempts.push({
          attempt,
          ...currentRoute,
          worker_status: workerResult.status,
          changed_files: workerResult.changed_files || [],
          worker_run: workerResult.artifacts?.run_dir || null,
          gate_decision: null,
          gate_score: null,
          failure_kind: workerFailure.kind,
          failover_to: fallbackRoute,
          turn_policy: turnPolicy,
        });
        retryTask = buildWorkerFailoverTask(workerResult, workerFailure, currentRoute, fallbackRoute);
        currentRoute = fallbackRoute;
        continue;
      }

      if (gateScript) {
        const gateArgs = [
          "-Cwd", cwd,
          "-TaskId", taskId,
          "-Task", String(args.task),
          "-Attempt", String(attempt),
          "-RequirementStatus", requirementStatusForWorker(workerResult, preview.mode),
          "-AllowedPathJson", allowedJson,
          "-ChangedPathJson", JSON.stringify([...changedFileSet]),
          "-WorkerRunDir", String(workerResult.artifacts?.run_dir || ""),
          "-JsonOnly",
        ];
        const gateExecution = await runPowerShell(gateScript, gateArgs, gateTimeoutMs);
        gate = parseJsonOutput(gateExecution.stdout, "Project gate");
      }

      attempts.push({
        attempt,
        ...currentRoute,
        worker_status: workerResult.status,
        changed_files: workerResult.changed_files || [],
        worker_run: workerResult.artifacts?.run_dir || null,
        gate_decision: gate?.decision || null,
        gate_score: gate?.score ?? null,
        failure_kind: workerFailure.kind,
        turn_policy: turnPolicy,
      });
      if (!shouldRunTargetedRetry(gate, attempt, finalAttempt)) break;
      retryTask = buildTargetedRetryTask(gate, workerResult);
    }
  }

  const combinedChangedFiles = preview.mode === "implement"
    ? [...changedFileSet]
    : (workerResult.changed_files || []);
  const combinedWorkerRuns = preview.mode === "implement"
    ? workerResults.map((result) => result.artifacts?.run_dir).filter(Boolean)
    : workerResults.map((result) => result.artifacts?.run_dir).filter(Boolean);
  const combinedModels = [...new Set(workerResults.map((result) => result.model).filter(Boolean))].join(", ");
  const finalSummary = attempts.length > 1
    ? `Completed ${attempts.length} worker attempts. Final attempt:\n${workerResult.summary || "No summary."}`
    : workerResult.summary;

  return {
    schema_version: "1.0",
    task_id: taskId,
    mode: preview.mode,
    route: preview.worker,
    route_history: attempts.map((entry) => ({
      attempt: entry.attempt,
      worker: entry.worker,
      harness: entry.harness,
      failure_kind: entry.failure_kind,
    })),
    planner: preview.planner,
    complexity: preview.complexity,
    turn_policy: {
      first_attempt: selectTurnPolicy({ complexity: preview.complexity.level, attempt: 1 }),
      targeted_retry: selectTurnPolicy({ complexity: preview.complexity.level, attempt: 2 }),
      planner_max_session_turns: deadline.planner_max_turns,
    },
    team: {
      ...preview.team,
      actual_assistant_count: preview.mode === "inspect"
        ? Math.max(1, workerResults.length) + (args.research_context ? 1 : 0)
        : 1 + (plannerResult?.status === "success" ? 1 : 0) + (args.research_context ? 1 : 0),
    },
    budget: preview.budget,
    deadline,
    git_baseline: gitBaseline,
    status: gate?.decision || workerResult.status,
    worker_status: workerResult.status,
    model: combinedModels || workerResult.model,
    summary: compact(finalSummary),
    usage: usageAvailability(
      combineUsage(workerResults),
      workerResult?.error || "CLI usage was not reported",
    ),
    scout_pack: preview.mode === "inspect" ? compactPackMetadata(workerResult.scout_pack) : null,
    scout_packs_combined: preview.mode === "inspect" ? (workerResult.scout_packs_combined || null) : null,
    planner_scout_pack: preview.mode === "implement" ? compactPackMetadata(plannerResult?.scout_pack) : null,
    changed_files: combinedChangedFiles,
    attempts,
    gate: gate ? {
      decision: gate.decision,
      score: gate.score,
      reason: gate.reason,
      hard_failures: gate.hard_failures || [],
      checks: gate.checks || {},
      metrics: gate.metrics || {},
      retry: gate.retry || {},
      codex_takeover: gate.codex_takeover || {},
    } : null,
    artifacts: {
      worker_run: workerResult.artifacts?.run_dir || null,
      worker_result: workerResult.artifacts?.worker_result || null,
      full_result: workerResult.artifacts?.full_result || null,
      planner_run: plannerResult?.artifacts?.run_dir || null,
      team_runs: combinedWorkerRuns,
      gate_report: gate?.artifacts?.gate_report || null,
      handoff: gate?.artifacts?.handoff || null,
    },
  };
}
