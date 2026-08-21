import { runProjectTask, selectProjectMode } from "./project-task.mjs";
import { classifyAutonomyItem, lunaWorkerSlot } from "./autonomy-policy.mjs";

const MAX_WORKPACK_ITEMS = 12;
const MAX_WORKPACK_PATHS = 40;

function compact(value, maxChars = 500) {
  const text = String(value || "").trim();
  return text.length <= maxChars ? text : `${text.slice(0, maxChars)}\n[truncated]`;
}

function normalizeItems(items = []) {
  if (!Array.isArray(items) || items.length === 0) throw new Error("routine_workpack requires at least one item.");
  if (items.length > MAX_WORKPACK_ITEMS) throw new Error(`routine_workpack accepts at most ${MAX_WORKPACK_ITEMS} items.`);
  const normalized = items.map((item, index) => {
    const task = String(item?.task || "").trim();
    if (!task) throw new Error(`routine_workpack item ${index + 1} requires task.`);
    const requestedId = String(item?.id || "").trim();
    return { ...item, id: requestedId || `item-${index + 1}`, task };
  });
  const duplicates = normalized
    .map((item) => item.id)
    .filter((id, index, ids) => ids.indexOf(id) !== index);
  if (duplicates.length > 0) {
    throw new Error(`routine_workpack item ids must be unique: ${[...new Set(duplicates)].join(", ")}`);
  }
  return normalized;
}

function combinedTask(items, mode) {
  const lines = [
    `Routine workpack ${mode} lane: complete the following independent, bounded chores in one worker run.`,
    "Do not work on any escalated item. Keep changes inside the union of allowed paths.",
    mode === "inspect" ? "This lane is strictly read-only; do not modify files." : "This is the only write-capable lane; make the smallest sufficient changes.",
    "Report completion and validation for each item ID; stop if their requirements conflict.",
    "",
  ];
  for (const item of items) {
    lines.push(`- [${item.id}] (${item.mode}, ${item.risk} risk) ${item.task}`);
  }
  return lines.join("\n");
}

export function planRoutineWorkpack(args = {}, slotOptions = {}) {
  const items = normalizeItems(args.items);
  const classified = items.map((item) => classifyAutonomyItem(
    item,
    selectProjectMode(item.task, item.mode || "auto"),
  ));
  const autonomous = classified.filter((item) => item.disposition === "autonomous");
  const escalated = classified.filter((item) => item.disposition === "escalate");
  const allowedPaths = [...new Set(autonomous.flatMap((item) => item.allowed_paths))];
  if (allowedPaths.length > MAX_WORKPACK_PATHS) {
    throw new Error(`routine_workpack allows at most ${MAX_WORKPACK_PATHS} unique allowed_paths.`);
  }
  const inspectItems = autonomous.filter((item) => item.mode === "inspect");
  const implementItems = autonomous.filter((item) => item.mode === "implement");
  const batches = [
    inspectItems.length > 0 ? {
      mode: "inspect",
      item_ids: inspectItems.map((item) => item.id),
      allowed_paths: [...new Set(inspectItems.flatMap((item) => item.allowed_paths))],
    } : null,
    implementItems.length > 0 ? {
      mode: "implement",
      item_ids: implementItems.map((item) => item.id),
      allowed_paths: [...new Set(implementItems.flatMap((item) => item.allowed_paths))],
    } : null,
  ].filter(Boolean);
  const mode = batches.length === 2 ? "mixed" : batches[0]?.mode || "inspect";

  return {
    schema_version: "1.0",
    kind: "routine_workpack_plan",
    item_count: classified.length,
    autonomous_count: autonomous.length,
    escalation_count: escalated.length,
    mode,
    allowed_paths: allowedPaths,
    autonomous_items: autonomous,
    batches,
    escalations: escalated,
    worker_slots: [lunaWorkerSlot(slotOptions)],
    execution_policy: {
      writer_concurrency: 1,
      lane_order: ["inspect", "implement"],
      retry_limit: 1,
      gate_required_for_implementation: true,
      success_delivery: "compact_receipt",
      failure_delivery: "codex_exception_packet",
    },
  };
}

export async function runRoutineWorkpack(args = {}, {
  runner = runProjectTask,
  luna = {},
} = {}) {
  if (!String(args.cwd || "").trim()) throw new Error("routine_workpack requires cwd.");
  const plan = planRoutineWorkpack(args, luna);
  if (args.dry_run === true) return { ...plan, dry_run: true };
  if (plan.autonomous_count === 0) {
    return {
      ...plan,
      dry_run: false,
      status: "takeover",
      receipt: { accepted: 0, escalated: plan.escalation_count, changed_files: [] },
      execution: null,
    };
  }

  const executions = [];
  const runtimeEscalations = [];
  const acceptedIds = [];
  const changedFiles = new Set();
  for (const batch of plan.batches) {
    const batchItems = plan.autonomous_items.filter((item) => batch.item_ids.includes(item.id));
    let execution;
    try {
      execution = await runner({
        task: combinedTask(batchItems, batch.mode),
        cwd: args.cwd,
        task_id: args.task_id ? `${args.task_id}-${batch.mode}` : undefined,
        mode: batch.mode,
        preferred: args.preferred,
        max_assistants: args.max_assistants,
        budget: args.budget || "low",
        allowed_paths: batch.allowed_paths,
        max_minutes: args.max_minutes,
        // routine_workpack is stricter than project_task: implementation
        // verification is part of the contract and cannot be bypassed.
        run_gate: batch.mode === "implement",
        worker_failover: args.worker_failover !== false,
      });
    } catch (error) {
      execution = { status: "error", summary: compact(error?.message || error, 240) };
    }
    const accepted = batch.mode === "inspect"
      ? execution.status === "success"
      : execution.status === "accept" || execution.gate?.decision === "accept";
    for (const file of execution.changed_files || []) changedFiles.add(file);
    if (accepted) {
      acceptedIds.push(...batch.item_ids);
    } else {
      runtimeEscalations.push(...batchItems.map((item) => ({
        ...item,
        disposition: "escalate",
        reasons: [
          `workpack ${batch.mode} lane ended with ${execution.status || "unknown"}`,
          execution.gate?.reason || execution.summary || "independent verification did not accept the workpack",
        ].filter(Boolean).map((value) => compact(value, 300)),
      })));
    }
    executions.push({
      mode: batch.mode,
      item_ids: batch.item_ids,
      task_id: execution.task_id || null,
      route: execution.route || null,
      status: execution.status || null,
      gate_score: execution.gate?.score ?? null,
      checks: execution.gate?.checks || {},
      attempts: execution.attempts || [],
      artifacts: execution.artifacts || {},
      worker_summary: accepted ? compact(execution.summary, 500) : "",
    });
  }
  const escalations = [...plan.escalations, ...runtimeEscalations];
  const acceptedCount = acceptedIds.length;

  return {
    ...plan,
    dry_run: false,
    status: acceptedCount === 0 ? "takeover" : (escalations.length > 0 ? "partial" : "accepted"),
    escalation_count: escalations.length,
    escalations,
    receipt: {
      accepted: acceptedCount,
      accepted_ids: acceptedIds,
      escalated: escalations.length,
      changed_files: [...changedFiles],
    },
    execution: { batches: executions },
  };
}
