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
  "openrouter:z-ai/glm-5.2:free": Object.freeze({
    capabilities: Object.freeze(["code", "tools"]),
    context_length: 256_000,
    pricing: Object.freeze({ input: 0, output: 0 }),
    is_free: true,
    pool_member: true,
    daily_request_limit: 10,
    quality_score: 0.94,
    quota_kind: "local_daily_request_allocation",
    catalog_source: "live_openrouter_models_api",
    catalog_updated_at: "2026-08-23",
  }),
  "openrouter:thinkingmachines/inkling:free": Object.freeze({
    capabilities: Object.freeze(["code", "tools"]),
    context_length: 262_144,
    pricing: Object.freeze({ input: 0, output: 0 }),
    is_free: true,
    pool_member: true,
    daily_request_limit: 10,
    quality_score: 0.9,
    quota_kind: "local_daily_request_allocation",
    catalog_source: "live_openrouter_models_api",
    catalog_updated_at: "2026-08-23",
  }),
  "openrouter:cohere/north-mini-code:free": Object.freeze({
    capabilities: Object.freeze(["code", "tools"]),
    context_length: 256_000,
    pricing: Object.freeze({ input: 0, output: 0 }),
    is_free: true,
    pool_member: true,
    daily_request_limit: 20,
    quality_score: 0.87,
    quota_kind: "local_daily_request_allocation",
    catalog_source: "live_openrouter_models_api",
    catalog_updated_at: "2026-08-23",
  }),
  "openrouter:nvidia/nemotron-3-ultra-550b-a55b:free": Object.freeze({
    capabilities: Object.freeze(["code", "tools"]),
    context_length: 1_000_000,
    pricing: Object.freeze({ input: 0, output: 0 }),
    is_free: true,
    pool_member: true,
    daily_request_limit: 10,
    quality_score: 0.96,
    quota_kind: "local_daily_request_allocation",
    catalog_source: "live_openrouter_models_api",
    catalog_updated_at: "2026-08-23",
  }),
  "cloudflare:@cf/google/gemma-4-26b-a4b-it": Object.freeze({
    capabilities: Object.freeze(["code", "tools"]),
    context_length: 256_000,
    pricing: Object.freeze({ input: 0, output: 0 }),
    is_free: true,
    pool_member: true,
    quality_score: 0.9,
    quota_kind: "daily_shared_free_neurons",
    daily_neuron_limit: 10_000,
    free_plan_hard_stop: true,
    catalog_source: "official_cloudflare_catalog_and_live_probe",
    catalog_updated_at: "2026-08-23",
  }),
  "cloudflare:@cf/nvidia/nemotron-3-120b-a12b": Object.freeze({
    capabilities: Object.freeze(["code", "tools"]),
    context_length: 256_000,
    pricing: Object.freeze({ input: 0, output: 0 }),
    is_free: true,
    pool_member: true,
    quality_score: 0.92,
    quota_kind: "daily_shared_free_neurons",
    daily_neuron_limit: 10_000,
    free_plan_hard_stop: true,
    catalog_source: "official_cloudflare_catalog_and_live_probe",
    catalog_updated_at: "2026-08-23",
  }),
  "zhipu:glm-4.7-flash": Object.freeze({
    capabilities: Object.freeze(["code", "tools"]),
    context_length: 200_000,
    pricing: Object.freeze({ input: 0, output: 0 }),
    is_free: true,
    allow_unlisted: true,
    quality_score: 0.88,
    routing_priority: 25,
    quota_kind: "provider_free_plan",
    catalog_source: "official_pricing_and_live_probe",
    catalog_updated_at: "2026-08-23",
  }),
  "zhipu:glm-4.6": Object.freeze({
    capabilities: Object.freeze(["code", "tools"]),
    quality_score: 0.84,
    quota_kind: "account_dependent",
    catalog_source: "live_account_probe",
    catalog_updated_at: "2026-08-23",
  }),
  "zhipu:glm-4.5": Object.freeze({
    capabilities: Object.freeze(["code", "tools"]),
    quality_score: 0.8,
    quota_kind: "account_dependent",
    catalog_source: "live_account_probe",
    catalog_updated_at: "2026-08-23",
  }),
  "modelscope:ZhipuAI/GLM-4.7-Flash": Object.freeze({
    capabilities: Object.freeze(["code"]),
    pricing: Object.freeze({ input: 0, output: 0 }),
    is_free: true,
    quality_score: 0.86,
    quota_kind: "daily_free_calls",
    catalog_source: "live_account_probe",
    catalog_updated_at: "2026-08-23",
  }),
  "modelscope:deepseek-ai/DeepSeek-V4-Flash-0731": Object.freeze({
    capabilities: Object.freeze(["code"]),
    pricing: Object.freeze({ input: 0, output: 0 }),
    is_free: true,
    quality_score: 0.84,
    quota_kind: "daily_free_calls",
    catalog_source: "live_account_probe",
    catalog_updated_at: "2026-08-23",
  }),
  "modelscope:stepfun-ai/Step-3.7-Flash": Object.freeze({
    capabilities: Object.freeze(["code"]),
    pricing: Object.freeze({ input: 0, output: 0 }),
    is_free: true,
    quality_score: 0.82,
    quota_kind: "daily_free_calls",
    catalog_source: "live_account_probe",
    catalog_updated_at: "2026-08-23",
  }),
  "groq:openai/gpt-oss-120b": Object.freeze({
    capabilities: Object.freeze(["code", "tools"]),
    context_length: 131_072,
    pricing: Object.freeze({ input: 0, output: 0 }),
    is_free: true,
    quality_score: 0.86,
    quota_kind: "provider_free_plan",
    daily_request_limit: 1000,
    catalog_source: "official_free_plan_limits",
    catalog_updated_at: "2026-08-24",
  }),
  "groq:qwen/qwen3.6-27b": Object.freeze({
    capabilities: Object.freeze(["code", "tools"]),
    context_length: 131_072,
    pricing: Object.freeze({ input: 0, output: 0 }),
    is_free: true,
    quality_score: 0.8,
    quota_kind: "provider_free_plan",
    daily_request_limit: 1000,
    catalog_source: "official_free_plan_limits",
    catalog_updated_at: "2026-08-24",
  }),
  "groq:openai/gpt-oss-20b": Object.freeze({
    capabilities: Object.freeze(["code", "tools"]),
    context_length: 131_072,
    pricing: Object.freeze({ input: 0, output: 0 }),
    is_free: true,
    quality_score: 0.75,
    quota_kind: "provider_free_plan",
    daily_request_limit: 1000,
    catalog_source: "official_free_plan_limits",
    catalog_updated_at: "2026-08-24",
  }),
  "groq:groq/compound": Object.freeze({
    capabilities: Object.freeze(["code", "tools", "web"]),
    context_length: 131_072,
    pricing: Object.freeze({ input: 0, output: 0 }),
    is_free: true,
    quality_score: 0.78,
    quota_kind: "provider_free_plan",
    daily_request_limit: 250,
    catalog_source: "official_free_plan_limits",
    catalog_updated_at: "2026-08-24",
  }),
  "groq:groq/compound-mini": Object.freeze({
    capabilities: Object.freeze(["code", "tools", "web"]),
    context_length: 131_072,
    pricing: Object.freeze({ input: 0, output: 0 }),
    is_free: true,
    quality_score: 0.74,
    quota_kind: "provider_free_plan",
    daily_request_limit: 250,
    catalog_source: "official_free_plan_limits",
    catalog_updated_at: "2026-08-24",
  }),
  "nvidia:nvidia/nemotron-3-ultra-550b-a55b": Object.freeze({
    capabilities: Object.freeze(["code", "tools"]),
    pricing: Object.freeze({ input: 0, output: 0 }),
    is_free: true,
    quality_score: 0.94,
    quota_kind: "hosted_developer_access",
    catalog_source: "live_account_probe",
    catalog_updated_at: "2026-08-23",
  }),
  "mistral:devstral-latest": Object.freeze({
    capabilities: Object.freeze(["code", "tools"]),
    quality_score: 0.87,
    quota_kind: "promotional_credit",
    catalog_source: "live_account_probe",
    catalog_updated_at: "2026-08-23",
  }),
  "mistral:mistral-vibe-cli-fast": Object.freeze({
    capabilities: Object.freeze(["code", "tools"]),
    quality_score: 0.78,
    quota_kind: "promotional_credit",
    catalog_source: "live_account_probe",
    catalog_updated_at: "2026-08-23",
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
