import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";

function safeId(value) {
  return String(value || "task").replace(/[^a-zA-Z0-9._-]/g, "-").slice(0, 120);
}

export function auditRoot() {
  return process.env.AI_TEAM_AUDIT_ROOT || join(homedir(), ".codex-ai-team", "audit");
}

export function artifactPath(taskId, name) {
  return join(auditRoot(), safeId(taskId), name);
}

async function atomicJson(path, value) {
  await mkdir(dirname(path), { recursive: true });
  const temp = `${path}.${randomUUID()}.tmp`;
  await writeFile(temp, JSON.stringify(value, null, 2), "utf8");
  await rename(temp, path);
  return path;
}

export async function writeRouteDecision(taskId, decision = {}) {
  const path = artifactPath(taskId, "route-decision.json");
  const safe = {
    schema_version: "1.0",
    task_id: safeId(taskId),
    generated_at: new Date().toISOString(),
    kind: String(decision.kind || "project"),
    mode: String(decision.mode || ""),
    budget: String(decision.budget || ""),
    selected: decision.selected || null,
    planner: decision.planner || null,
    complexity: decision.complexity ? {
      level: decision.complexity.level,
      score: Number(decision.complexity.score || 0),
      reasons: (decision.complexity.reasons || []).map(String).slice(0, 20),
      needs_live_research: decision.complexity.needs_live_research === true,
    } : null,
    candidates: (decision.candidates || []).map((item) => ({ provider: item.provider, id: item.id, score: item.score ?? null })).slice(0, 100),
    excluded: (decision.excluded || []).map((item) => ({ provider: item.provider, id: item.id, reasons: item.reasons || [item.reason].filter(Boolean), remaining_ms: item.remaining_ms ?? null })).slice(0, 100),
    fallback_chain: (decision.fallback_chain || []).map((item) => ({ provider: item.provider, id: item.id, score: item.score ?? null })).slice(0, 100),
    isolation: decision.isolation ? { enabled: Boolean(decision.isolation.enabled), status: decision.isolation.status } : null,
  };
  return atomicJson(path, safe);
}

export async function saveCheckpoint(taskId, state = {}) {
  const path = artifactPath(taskId, "checkpoint.json");
  const safe = {
    schema_version: "1.0",
    task_id: safeId(taskId),
    updated_at: new Date().toISOString(),
    phase: String(state.phase || "started"),
    status: String(state.status || "running"),
    next_attempt: Number(state.next_attempt || 1),
    changed_files: (state.changed_files || []).map(String).slice(0, 200),
    isolation: state.isolation ? {
      enabled: Boolean(state.isolation.enabled),
      status: state.isolation.status,
      original_cwd: state.isolation.original_cwd,
      working_cwd: state.isolation.working_cwd,
      path: state.isolation.path,
      head: state.isolation.head,
    } : null,
    last_gate: state.last_gate ? { decision: state.last_gate.decision, score: state.last_gate.score, hard_failures: state.last_gate.hard_failures || [] } : null,
  };
  return atomicJson(path, safe);
}

export async function loadCheckpoint(taskId) {
  const path = artifactPath(taskId, "checkpoint.json");
  try {
    const parsed = JSON.parse(await readFile(path, "utf8"));
    return parsed?.schema_version === "1.0" ? { ...parsed, path } : null;
  } catch {
    return null;
  }
}
