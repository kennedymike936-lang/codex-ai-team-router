import { isAbsolute } from "node:path";

export const GPT_5_6_LUNA_MODEL = "gpt-5.6-luna";

// Prices are expressed per token, matching the budget router's normalized
// provider metadata. Keep this catalog small and dated so stale pricing is
// visible instead of silently treated as current provider truth.
export const BUILTIN_MODEL_METADATA = Object.freeze({
  [`openai:${GPT_5_6_LUNA_MODEL}`]: Object.freeze({
    capabilities: Object.freeze(["code", "tools", "web"]),
    context_length: 1_050_000,
    pricing: Object.freeze({ input: 0.20 / 1_000_000, output: 1.20 / 1_000_000 }),
    is_free: false,
    catalog_source: "official_openai_model_page",
    catalog_updated_at: "2026-08-20",
  }),
});

const HIGH_RISK = /\b(?:security|auth(?:entication|orization)?|permission|credential|secret|payment|billing|production|release to production|production release|publish(?: a)? (?:release|package)|deploy(?:ment)?|infrastructure|database migration|data migration|schema migration|destructive|delete data|rotate keys?)\b|安全|认证|授权|权限|凭据|密钥|支付|计费|生产环境|发布到生产|发布版本|发布软件包|上线|部署|基础设施|数据库迁移|数据迁移|删库|轮换密钥/i;
const MEDIUM_RISK = /\b(?:architecture|migration|cross[- ]module|multi[- ]module|refactor|rewrite|dependency|upgrade|performance|concurrency)\b|架构|迁移|跨模块|多模块|重构|重写|依赖|升级|性能|并发/i;

function normalizedPaths(values = []) {
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

export function mergeBuiltinModelMetadata(overrides = {}) {
  const safeOverrides = overrides && typeof overrides === "object" && !Array.isArray(overrides)
    ? overrides
    : {};
  const merged = { ...BUILTIN_MODEL_METADATA };
  for (const [key, value] of Object.entries(safeOverrides)) {
    const builtin = merged[key] || {};
    merged[key] = {
      ...builtin,
      ...(value && typeof value === "object" && !Array.isArray(value) ? value : {}),
      capabilities: [
        ...new Set([...(builtin.capabilities || []), ...(value?.capabilities || [])]),
      ],
      pricing: { ...(builtin.pricing || {}), ...(value?.pricing || {}) },
    };
  }
  return merged;
}

export function lunaWorkerSlot({ enabled = false, configured = false, runnerAvailable = false } = {}) {
  let state = "ready";
  let reason = "configured";
  if (!enabled) {
    state = "reserved";
    reason = "AI_TEAM_LUNA_ENABLED is not true";
  } else if (!configured) {
    state = "reserved";
    reason = "OPENAI_API_KEY is not configured";
  } else if (!runnerAvailable) {
    state = "reserved";
    reason = "local bounded worker runner is not enabled";
  }
  return {
    id: `openai:${GPT_5_6_LUNA_MODEL}`,
    provider: "openai",
    model: GPT_5_6_LUNA_MODEL,
    role: "high_volume_routine_worker",
    execution: "responses_api",
    state,
    reason,
    capabilities: ["model_only", "structured_output", "tool_calling"],
  };
}

export function classifyAutonomyItem(item = {}, resolvedMode = "implement") {
  const task = String(item.task || "").trim();
  const requestedRisk = ["low", "medium", "high"].includes(item.risk) ? item.risk : "auto";
  const allowedPaths = normalizedPaths(item.allowed_paths);
  const reasons = [];

  const detectedRisk = HIGH_RISK.test(task) ? "high" : MEDIUM_RISK.test(task) ? "medium" : "low";
  const rank = { low: 0, medium: 1, high: 2 };
  const risk = requestedRisk === "auto" || rank[detectedRisk] > rank[requestedRisk]
    ? detectedRisk
    : requestedRisk;
  if (requestedRisk !== "auto") reasons.push(`risk explicitly set to ${requestedRisk}`);
  if (detectedRisk !== "low") reasons.push(`${detectedRisk}-risk task language detected`);
  if (requestedRisk !== "auto" && risk !== requestedRisk) reasons.push("explicit risk cannot downgrade detected risk");

  if (item.destructive === true) reasons.push("destructive action requested");
  if (item.external_write === true) reasons.push("external write requested");
  if (resolvedMode === "implement" && allowedPaths.length === 0) reasons.push("implementation has no allowed_paths boundary");

  const requiresCodex = risk === "high"
    || item.destructive === true
    || item.external_write === true
    || (resolvedMode === "implement" && allowedPaths.length === 0);

  return {
    id: String(item.id || "").trim(),
    task,
    mode: resolvedMode,
    risk,
    allowed_paths: allowedPaths,
    disposition: requiresCodex ? "escalate" : "autonomous",
    reasons,
  };
}
