import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";

const ENGLISH_ACTION = /^(?:what (?:is|are)|get|tell me|show|display|print|output|return|read|report|list)\b/i;
const ENGLISH_PACKAGE = /\bpackage(?:\.json)?\b/i;
const NEGATIVE = /\b(explain|describe|how|why|compare|update|change|modify|fix|implement|build|deploy|audit|security|vulnerabilit(?:y|ies)|dependenc(?:y|ies)|architect(?:ure|ural)?|structure|meaning|purpose|latest|current|newest|recent|upgrade|downgrade|install|publish|add|remove|delete|create|refactor|rewrite|web|search)\b/i;
const ZH_ACTIONS = ["\u8bfb\u53d6", "\u663e\u793a", "\u544a\u8bc9\u6211", "\u5217\u51fa", "\u67e5\u770b", "\u8fd4\u56de", "\u62a5\u544a"];
const ZH_NEGATIVE = [
  "\u89e3\u91ca", "\u5982\u4f55", "\u4e3a\u4ec0\u4e48", "\u6bd4\u8f83", "\u66f4\u65b0", "\u4fee\u6539", "\u4fee\u590d",
  "\u5b9e\u73b0", "\u6784\u5efa", "\u90e8\u7f72", "\u5ba1\u8ba1", "\u5b89\u5168", "\u6f0f\u6d1e", "\u4f9d\u8d56", "\u67b6\u6784",
  "\u7ed3\u6784", "\u6700\u65b0", "\u5f53\u524d", "\u5347\u7ea7", "\u964d\u7ea7", "\u5b89\u88c5", "\u53d1\u5e03", "\u6dfb\u52a0",
  "\u5220\u9664", "\u521b\u5efa", "\u91cd\u6784", "\u641c\u7d22",
];

function includesAny(text, values) {
  return values.some((value) => text.includes(value));
}

export function matchMechanicalRule(task = "") {
  const text = String(task || "").trim();
  if (!text || text.length > 220 || NEGATIVE.test(text) || includesAny(text, ZH_NEGATIVE)) return null;

  const lower = text.toLowerCase();
  const hasEnglishAction = ENGLISH_ACTION.test(text);
  const hasChineseAction = includesAny(text, ZH_ACTIONS);
  const hasPackageContext = ENGLISH_PACKAGE.test(text)
    || lower.includes("package.json")
    || text.includes("\u5305\u540d")
    || text.includes("\u9879\u76ee\u540d\u79f0")
    || text.includes("\u7248\u672c\u53f7");
  if ((!hasEnglishAction && !hasChineseAction) || !hasPackageContext) return null;

  const fields = [];
  if (/\bname\b/i.test(text) || text.includes("\u5305\u540d") || text.includes("\u9879\u76ee\u540d\u79f0")) fields.push("name");
  if (/\bversion\b/i.test(text) || text.includes("\u7248\u672c") || text.includes("\u7248\u672c\u53f7")) fields.push("version");
  if (/\bscripts?\b/i.test(text) || text.includes("\u811a\u672c")) fields.push("scripts");
  if (fields.length === 0) return null;

  return { rule: "mechanical:package-json-metadata", fields: [...new Set(fields)] };
}

export async function mechanicalInspect(task, cwd) {
  const match = matchMechanicalRule(task);
  if (!match) return null;

  let pkg;
  try {
    pkg = JSON.parse(await readFile(join(resolve(String(cwd)), "package.json"), "utf8"));
  } catch {
    return null;
  }

  const lines = [];
  if (match.fields.includes("name")) lines.push(`Package name: ${String(pkg.name || "(not set)")}`);
  if (match.fields.includes("version")) lines.push(`Package version: ${String(pkg.version || "(not set)")}`);
  if (match.fields.includes("scripts")) {
    const names = pkg.scripts && typeof pkg.scripts === "object" ? Object.keys(pkg.scripts).sort() : [];
    lines.push(`Package scripts: ${names.length > 0 ? names.join(", ") : "(none)"}`);
  }

  return {
    schema_version: "1.0",
    task_id: "mechanical-package-metadata",
    mode: "inspect",
    route: "mechanical",
    planner: null,
    complexity: { level: "small", score: 0, reasons: ["mechanical package metadata"], needs_live_research: false },
    team: { assistant_count: 0, coding_assistants: 0, use_planner: false, use_grok: false, max_assistants: 0, actual_assistant_count: 0 },
    budget: "none",
    deadline: null,
    git_baseline: { status: "not_needed", initialized: false },
    status: "success",
    worker_status: "not_applicable",
    model: null,
    summary: lines.join("\n"),
    usage: { availability: "not_applicable", reason: "Deterministic local parser; no model call.", input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, total_tokens: 0, num_turns: 0 },
    matched_rule: match,
    scout_pack: null,
    scout_packs_combined: null,
    planner_scout_pack: null,
    changed_files: [],
    attempts: [],
    gate: null,
    artifacts: { worker_run: null, worker_result: null, full_result: null, planner_run: null, team_runs: [], gate_report: null, handoff: null },
    research: null,
  };
}
