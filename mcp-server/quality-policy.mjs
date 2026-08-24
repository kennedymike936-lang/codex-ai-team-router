const SCORE_LIMITS = {
  functionality: 40,
  requirements: 25,
  code_quality: 15,
  safety: 10,
  maintainability: 10,
};

function boundedNumber(value, max) {
  const number = Number(value);
  if (!Number.isFinite(number)) return 0;
  return Math.max(0, Math.min(max, Math.round(number)));
}

function uniqueStrings(values) {
  if (!Array.isArray(values)) return [];
  return [...new Set(values.map((value) => String(value).trim()).filter(Boolean))];
}

export function evaluateWorkerResult(input = {}) {
  const attempt = Math.max(1, Math.min(2, Number.parseInt(input.attempt, 10) || 1));
  const scores = Object.fromEntries(
    Object.entries(SCORE_LIMITS).map(([name, limit]) => [
      name,
      boundedNumber(input.scores?.[name], limit),
    ]),
  );
  const score = Object.values(scores).reduce((total, value) => total + value, 0);
  const hardFailures = uniqueStrings(input.hard_failures);

  let decision = "accept";
  let reason = "Quality target reached; further polishing is optional.";

  if (hardFailures.length > 0) {
    decision = "takeover";
    reason = "A hard gate failed; Codex should take control immediately.";
  } else if (score < 80) {
    decision = "takeover";
    reason = "Quality is below the worker recovery threshold.";
  } else if (score < 90 && attempt >= 2) {
    decision = "takeover";
    reason = "The single targeted retry was already used.";
  } else if (score < 90) {
    decision = "retry";
    reason = "One targeted worker retry is allowed before Codex takes over.";
  }

  const taskId = String(input.task_id || "").trim() || `task-${Date.now()}`;
  const summary = String(input.summary || "").trim();
  const checks = input.checks && typeof input.checks === "object" ? input.checks : {};
  const changedFiles = uniqueStrings(input.changed_files);
  const artifacts = input.artifacts && typeof input.artifacts === "object" ? input.artifacts : {};

  return {
    schema_version: "1.0",
    task_id: taskId,
    task: String(input.task || "").trim(),
    attempt,
    decision,
    score,
    scores,
    reason,
    hard_failures: hardFailures,
    summary,
    checks,
    changed_files: changedFiles,
    artifacts,
    retry: {
      allowed: decision === "retry",
      remaining: decision === "retry" ? 1 : 0,
      instruction: decision === "retry"
        ? "Fix only the failed or incomplete checks, keep the diff bounded, then run the gate again with attempt=2."
        : "",
    },
    codex_takeover: {
      required: decision === "takeover",
      instruction: decision === "takeover"
        ? "Read this handoff and the referenced artifacts, restore a working deliverable first, then diagnose why the worker fell short."
        : "",
    },
  };
}

export { SCORE_LIMITS };
