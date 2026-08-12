import { resilientFetch } from "./network-client.mjs";

const DEFAULT_TTL_MS = 60 * 60 * 1000;

export const MODEL_CATALOG = {
  qwen: {
    "qwen3.6-flash": { input_cny: 1.2, output_cny: 7.2 },
    "qwen3.7-plus": { input_cny: 2, output_cny: 8 },
  },
  deepseek: {
    "deepseek-v4-flash": { input_cny: 1, output_cny: 2 },
    "deepseek-v4-pro": { input_cny: 3, output_cny: 6 },
  },
};

const VALUE_ORDER = {
  qwen: {
    low: ["qwen3.6-flash", "qwen3.7-plus"],
    normal: ["qwen3.7-plus", "qwen3.6-flash"],
    deep: ["qwen3.7-plus", "qwen3.6-flash"],
  },
  deepseek: {
    low: ["deepseek-v4-flash", "deepseek-v4-pro"],
    normal: ["deepseek-v4-pro", "deepseek-v4-flash"],
    deep: ["deepseek-v4-pro", "deepseek-v4-flash"],
  },
};

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

function modelTraits(provider, id) {
  const value = String(id || "").toLowerCase();
  const match = provider === "qwen"
    ? value.match(/^qwen(\d+(?:\.\d+)?)-(flash|plus)(?:$|-\d{4}-\d{2}-\d{2}$)/)
    : value.match(/^deepseek-v(\d+(?:\.\d+)?)-(flash|pro)(?:$|-\d{4}-\d{2}-\d{2}$)/);
  if (!match || /preview|realtime|audio|image|omni|vl/.test(value)) return null;
  return {
    id,
    generation: Number.parseFloat(match[1]),
    tier: match[2],
    stableAlias: !/-\d{4}-\d{2}-\d{2}$/.test(value),
  };
}

export function rankValueModels(provider, budget, available) {
  const preferredTier = provider === "qwen"
    ? (budget === "low" ? "flash" : "plus")
    : (budget === "low" ? "flash" : "pro");
  const bestByTier = new Map();
  for (const id of available || []) {
    const traits = modelTraits(provider, id);
    if (!traits) continue;
    const existing = bestByTier.get(traits.tier);
    if (
      !existing ||
      traits.generation > existing.generation ||
      (traits.generation === existing.generation && !existing.stableAlias && traits.stableAlias)
    ) {
      bestByTier.set(traits.tier, traits);
    }
  }
  return [...bestByTier.values()]
    .sort((a, b) => {
      const aTier = a.tier === preferredTier ? 1 : 0;
      const bTier = b.tier === preferredTier ? 1 : 0;
      return bTier - aTier || b.generation - a.generation || Number(b.stableAlias) - Number(a.stableAlias);
    })
    .map((item) => item.id);
}

export function modelsEndpoint(provider, baseUrl) {
  const base = String(baseUrl || "").replace(/\/$/, "");
  if (provider === "deepseek") {
    return `${base.replace(/\/anthropic(?:\/v1)?$/, "")}/models`;
  }
  return `${base}/models`;
}

export function isModelUnavailable(status, text = "") {
  if (![400, 403, 404].includes(Number(status))) return false;
  return /model.{0,40}(not found|not exist|unavailable|unsupported|no access|permission)|unknown model/i.test(String(text));
}

export function estimateCostCny(provider, model, usage = {}) {
  const price = MODEL_CATALOG[provider]?.[model];
  if (!price) return null;
  const input = Number(usage.input_tokens || 0);
  const output = Number(usage.output_tokens || 0);
  return Number(((input * price.input_cny + output * price.output_cny) / 1_000_000).toFixed(8));
}

export class ModelSelector {
  constructor({ fetchImpl = resilientFetch, ttlMs = DEFAULT_TTL_MS, now = () => Date.now() } = {}) {
    this.fetchImpl = fetchImpl;
    this.ttlMs = ttlMs;
    this.now = now;
    this.cache = new Map();
  }

  async discover({ provider, baseUrl, apiKey }) {
    const cacheKey = `${provider}|${String(baseUrl).replace(/\/$/, "")}`;
    const cached = this.cache.get(cacheKey);
    if (cached && this.now() - cached.fetched_at < this.ttlMs) return cached.models;

    try {
      const response = await this.fetchImpl(modelsEndpoint(provider, baseUrl), {
        headers: { authorization: `Bearer ${apiKey}` },
      });
      if (!response.ok) return null;
      const json = await response.json();
      const models = new Set((json.data || []).map((item) => item?.id).filter(Boolean));
      this.cache.set(cacheKey, { fetched_at: this.now(), models });
      return models;
    } catch {
      return null;
    }
  }

  invalidate(provider, baseUrl) {
    this.cache.delete(`${provider}|${String(baseUrl).replace(/\/$/, "")}`);
  }

  async candidates({ provider, budget = "low", configuredModel = "", mode = "auto", baseUrl, apiKey }) {
    const valueOrder = VALUE_ORDER[provider]?.[budget] || VALUE_ORDER[provider]?.low || [];
    if (mode === "fixed" && configuredModel) return [configuredModel];

    const available = await this.discover({ provider, baseUrl, apiKey });
    if (available) {
      const dynamic = rankValueModels(provider, budget, available);
      if (dynamic.length > 0) return dynamic.slice(0, 2);
      if (configuredModel && available.has(configuredModel)) return [configuredModel];
    }
    return unique([...valueOrder, configuredModel]).slice(0, 2);
  }
}

export const modelSelector = new ModelSelector();
