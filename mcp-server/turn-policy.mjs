const MAX_TURNS = 12;
const RETRY_TURNS = 4;
const COMPLEX_TURNS = 12;
const MEDIUM_TURNS = 10;
const SMALL_TURNS = 6;
const SCOUT_RETRY_TURNS = 4;
const SCOUT_TURNS = { small: 4, medium: 5, complex: 7 };

export function selectScoutTurnPolicy({ complexity = "medium", attempt = 1 } = {}) {
  const normalized = Object.hasOwn(SCOUT_TURNS, complexity) ? complexity : "medium";
  const isRetry = attempt > 1;
  const turns = isRetry ? SCOUT_RETRY_TURNS : SCOUT_TURNS[normalized];
  return {
    max_session_turns: turns,
    policy: isRetry ? "focused_scout_failover" : `${normalized}_scout_turns`,
    complexity: normalized,
    attempt,
    hard_cap: 7,
    reason: isRetry
      ? "Focused read-only failover reserves a tool-free final answer turn after bounded evidence checks"
      : `Read-only ${normalized} inspection reserves a tool-free final answer turn after bounded discovery`,
  };
}

/**
 * Selects the max-session-turns policy for a project_task worker attempt.
 * Direct codex-worker default stays at 8; this function adjusts per attempt.
 *
 * - First attempt: complexity-based (small=6, medium=10, complex=12)
 * - Retry (attempt > 1): strict short cap of 4 turns
 * - Hard cap: never exceeds 12
 * - Planner: independently capped at 4 (handled in computeProjectDeadline)
 */
export function selectTurnPolicy({ complexity = "medium", attempt = 1 } = {}) {
  if (attempt > 1) {
    return {
      max_session_turns: RETRY_TURNS,
      policy: "targeted_retry",
      complexity,
      attempt,
      hard_cap: MAX_TURNS,
      reason: "Strict short cap for targeted retry; no re-investigation",
    };
  }

  let turns;
  let policy;

  switch (complexity) {
    case "small":
      turns = SMALL_TURNS;
      policy = "small_task_low_turns";
      break;
    case "medium":
      turns = MEDIUM_TURNS;
      policy = "medium_task_extended_turns";
      break;
    case "complex":
      turns = COMPLEX_TURNS;
      policy = "complex_task_high_turns";
      break;
    default:
      turns = MEDIUM_TURNS;
      policy = "default";
  }

  return {
    max_session_turns: Math.min(turns, MAX_TURNS),
    policy,
    complexity,
    attempt,
    hard_cap: MAX_TURNS,
    reason: `First-attempt policy for ${complexity} task complexity`,
  };
}

/**
 * Builds a targeted retry prompt that forbids re-investigation
 * and prioritizes validating/finalizing the existing diff.
 *
 * If the previous attempt hit FatalTurnLimitedError with partial files,
 * the prompt is extra strict about not restarting broad work.
 */
export function buildTargetedRetryPrompt({ gate = {}, workerResult = {} } = {}) {
  const summary = String(workerResult.summary || "");
  const error = String(workerResult.error || "");
  const hitTurnLimit = /FatalTurnLimited|turn.limit|max.session.turns|turn.limited/i.test(
    `${error} ${summary}`,
  );
  const hasPartialFiles = Array.isArray(workerResult.changed_files) && workerResult.changed_files.length > 0;

  const parts = [];

  if (hitTurnLimit && hasPartialFiles) {
    parts.push(
      "CRITICAL: Previous attempt hit the turn limit with partial changes already on disk.",
      "Continue from the current workspace state. Do NOT restart or re-investigate.",
      "Validate the existing diff, finalize incomplete work, and fix only remaining failures.",
    );
  } else {
    parts.push(
      "TARGETED RETRY: Do NOT re-investigate or restart broad work.",
      "Priority: validate and finalize the existing diff.",
      "Fix only the incomplete outcome or failed checks.",
    );
  }

  const failedChecks = Object.entries(gate.checks || {})
    .filter(([, status]) => status === "fail")
    .map(([name]) => name);

  if (gate.reason) parts.push(`Gate reason: ${gate.reason}`);
  if (gate.requirement_status) parts.push(`Requirement status: ${gate.requirement_status}`);
  if (failedChecks.length > 0) parts.push(`Failed checks: ${failedChecks.join(", ")}`);

  return parts.join("\n");
}
