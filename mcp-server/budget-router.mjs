import { adapterForProvider, redactKeys } from "./provider-adapters.mjs";

export const ROUTING_MODES = ["free_only", "balanced", "quality_first"];
const KNOWN_CAPABILITIES = new Set(["code", "tools", "web"]);

function round(value) {
  return Number(Number(value || 0).toFixed(4));
}

function modelKey(model) {
  return `${model.provider}:${model.id}`;
}

function capabilitiesFor(model) {
  return Array.isArray(model.capabilities)
    ? [...new Set(model.capabilities.map((item) => String(item).toLowerCase()))].sort()
    : [];
}

function normalizedRequirements(requirements = {}) {
  const capabilities = [...new Set((requirements.capabilities || []).map((item) => String(item).toLowerCase()))];
  const unknown = capabilities.filter((item) => !KNOWN_CAPABILITIES.has(item));
  if (unknown.length > 0) throw new Error(`Unknown capabilities: ${unknown.join(", ")}`);
  return {
    capabilities,
    min_context_length: Math.max(0, Number(requirements.min_context_length || 0)),
    sensitive: requirements.sensitive === true,
    require_zero_data_retention: requirements.require_zero_data_retention === true,
  };
}

export function meetsRequirements(model, requirements = {}) {
  const normalized = normalizedRequirements(requirements);
  const reasons = [];
  const capabilities = capabilitiesFor(model);
  for (const capability of normalized.capabilities) {
    if (!capabilities.includes(capability)) reasons.push(`missing_capability:${capability}`);
  }
  if (normalized.min_context_length > 0 && Number(model.context_length || 0) < normalized.min_context_length) {
    reasons.push(`context_too_short:${Number(model.context_length || 0)}<${normalized.min_context_length}`);
  }
  if ((normalized.sensitive || normalized.require_zero_data_retention) && model.is_zero_data_retention !== true) {
    reasons.push("privacy:zero_data_retention_not_explicitly_confirmed");
  }
  return { passed: reasons.length === 0, reasons, requirements: normalized };
}

function costComponent(model, mode) {
  const input = model.pricing?.input;
  const output = model.pricing?.output;
  const known = Number.isFinite(input) && Number.isFinite(output);
  if (!known) return mode === "balanced" ? -5 : 0;
  if (input === 0 && output === 0) return mode === "balanced" ? 30 : 8;
  const perMillionMaximum = Math.max(input, output) * 1_000_000;
  const value = Math.max(-5, 15 - Math.log10(perMillionMaximum + 1) * 4);
  return mode === "balanced" ? value : Math.min(3, value / 5);
}

export function scoreCandidate(model, mode, requirements = {}, runtimeState = {}) {
  const capabilities = capabilitiesFor(model);
  const quality = Number.isFinite(model.quality_score) ? Math.min(model.quality_score, 1) * 30 : 0;
  const context = model.context_length > 0 ? Math.min(10, Math.log2(model.context_length) / 2) : 0;
  const capability = capabilities.length * (mode === "quality_first" ? 5 : 2);
  const cost = mode === "free_only" ? 0 : costComponent(model, mode);
  const latency = Number.isFinite(model.latency_ms) ? Math.max(-5, 10 - model.latency_ms / 200) : 0;
  const state = runtimeState[modelKey(model)] || {};
  const healthName = String(state.health || model.health || "unknown").toLowerCase();
  let health = healthName === "healthy" ? 5 : healthName === "degraded" ? -20 : healthName === "unhealthy" ? -40 : 0;
  const remaining = state.remaining_requests ?? model.quota_remaining;
  if (remaining === 0) health -= 30;
  else if (Number.isFinite(remaining) && remaining > 0) health += Math.min(5, Math.log10(remaining + 1));
  const privacy = model.is_zero_data_retention === true ? 3 : 0;
  const required = normalizedRequirements(requirements);
  const requirementMatch = required.capabilities.filter((item) => capabilities.includes(item)).length * 3;
  const components = {
    quality: round(quality),
    capability: round(capability + requirementMatch),
    context: round(context),
    cost: round(cost),
    latency: round(latency),
    health: round(health),
    privacy: round(privacy),
  };
  const total = round(Object.values(components).reduce((sum, value) => sum + value, 0));
  return { total, components };
}

function candidateSummary(model, score = null) {
  return {
    id: model.id,
    provider: model.provider,
    capabilities: capabilitiesFor(model),
    context_length: Number(model.context_length || 0),
    pricing: {
      input: Number.isFinite(model.pricing?.input) ? model.pricing.input : null,
      output: Number.isFinite(model.pricing?.output) ? model.pricing.output : null,
    },
    is_free: model.is_free === true,
    is_zero_data_retention: model.is_zero_data_retention === true,
    health: model.health || "unknown",
    latency_ms: Number.isFinite(model.latency_ms) ? model.latency_ms : null,
    quota_remaining: Number.isFinite(model.quota_remaining) ? model.quota_remaining : null,
    ...(score ? { score: score.total, score_components: score.components } : {}),
  };
}

function buildFallbackChain(candidates, mode, requirements, runtimeState) {
  const eligible = [];
  const excluded = [];
  for (const model of candidates) {
    const check = meetsRequirements(model, requirements);
    const knownZeroPrice = model.pricing?.input === 0 && model.pricing?.output === 0;
    if (mode === "free_only" && (!knownZeroPrice || model.is_free !== true)) {
      check.reasons.push("not_confirmed_zero_price");
    }
    if (check.reasons.length > 0) {
      excluded.push({ ...candidateSummary(model), reasons: [...new Set(check.reasons)] });
      continue;
    }
    eligible.push({ model, score: scoreCandidate(model, mode, requirements, runtimeState) });
  }
  eligible.sort((a, b) =>
    b.score.total - a.score.total ||
    String(a.model.provider).localeCompare(String(b.model.provider)) ||
    String(a.model.id).localeCompare(String(b.model.id))
  );
  return { eligible, excluded };
}

function freeRouterCandidate() {
  return {
    id: "openrouter/free",
    provider: "openrouter",
    capabilities: [],
    context_length: 0,
    pricing: { input: 0, output: 0 },
    is_free: true,
    is_zero_data_retention: false,
    health: "unknown",
    latency_ms: null,
    quota_remaining: null,
  };
}

function mergeMetadata(model, overrides = {}) {
  const override = overrides[`${model.provider}:${model.id}`] || overrides[model.id] || {};
  if (Object.keys(override).length === 0) return model;
  return {
    ...model,
    ...override,
    capabilities: [...new Set([...(model.capabilities || []), ...(override.capabilities || [])])],
    pricing: { ...(model.pricing || {}), ...(override.pricing || {}) },
  };
}

export function createBudgetRouter({
  allowOpenRouterFreeFallback = false,
  modelMetadata = {},
  capabilityCatalog = {},
  now = () => Date.now(),
} = {}) {
  const runtimeState = {};

  function updateRuntimeState(model, status, headers = {}) {
    const key = modelKey(model);
    runtimeState[key] = {
      health: status === "success" ? "healthy" : "degraded",
      remaining_requests: Number.isFinite(headers.remaining_requests) ? headers.remaining_requests : null,
      remaining_tokens: Number.isFinite(headers.remaining_tokens) ? headers.remaining_tokens : null,
      retry_after: headers.retry_after || null,
      updated_at: now(),
    };
    return runtimeState[key];
  }

  return {
    runtimeState,
    allowOpenRouterFreeFallback,

    async discoverCandidates({ providers = [], apiKeys = {}, baseUrls = {}, fetchImpl, candidates }) {
      if (Array.isArray(candidates) && candidates.length > 0) {
        return { candidates: candidates.map((model) => mergeMetadata(model, modelMetadata)), provider_exclusions: [] };
      }
      const discovered = [];
      const providerExclusions = [];
      for (const provider of [...new Set(providers)]) {
        let adapter;
        try {
          adapter = adapterForProvider(provider, fetchImpl);
        } catch (error) {
          providerExclusions.push({ provider, reason: redactKeys(error.message || String(error), Object.values(apiKeys)) });
          continue;
        }
        const credential = apiKeys[provider];
        if (adapter.requiresApiKey !== false && !credential) {
          providerExclusions.push({ provider, reason: "api_key_not_configured" });
          continue;
        }
        try {
          const models = await adapter.discoverModels({
            apiKey: credential,
            baseUrl: baseUrls[provider],
            metadata: modelMetadata,
            capabilityCatalog,
          });
          discovered.push(...models.map((model) => mergeMetadata(model, modelMetadata)));
        } catch (error) {
          providerExclusions.push({ provider, reason: redactKeys(error.message || String(error), Object.values(apiKeys)) });
        }
      }
      return { candidates: discovered, provider_exclusions: providerExclusions };
    },

    route({ candidates = [], mode = "balanced", requirements = {}, provider_exclusions = [] }) {
      if (!ROUTING_MODES.includes(mode)) {
        throw new Error(`Invalid mode: ${mode}. Must be one of: ${ROUTING_MODES.join(", ")}`);
      }
      const normalized = normalizedRequirements(requirements);
      const { eligible, excluded } = buildFallbackChain(candidates, mode, normalized, runtimeState);
      const fallback = eligible.map(({ model, score }) => candidateSummary(model, score));
      return {
        mode,
        requirements: normalized,
        candidates: candidates.map((model) => candidateSummary(model)),
        provider_exclusions,
        excluded,
        selected: fallback[0] || null,
        fallback_chain: fallback,
      };
    },

    async execute({
      candidates,
      mode = "balanced",
      requirements = {},
      providers = [],
      apiKeys = {},
      baseUrls = {},
      fetchImpl,
      messages,
      max_tokens = 1024,
      temperature = 0.2,
      dry_run = true,
    }) {
      const discovery = await this.discoverCandidates({ providers, apiKeys, baseUrls, fetchImpl, candidates });
      const pool = [...discovery.candidates];
      if (
        this.allowOpenRouterFreeFallback &&
        mode === "free_only" &&
        apiKeys.openrouter &&
        !pool.some((model) => model.provider === "openrouter" && model.id === "openrouter/free")
      ) {
        pool.push(mergeMetadata(freeRouterCandidate(), modelMetadata));
      }
      const explanation = this.route({
        candidates: pool,
        mode,
        requirements,
        provider_exclusions: discovery.provider_exclusions,
      });
      if (dry_run) return { dry_run: true, explanation };
      if (explanation.fallback_chain.length === 0) {
        return { dry_run: false, explanation, result: null, attempts: [], error: "No eligible model found." };
      }

      const attempts = [];
      for (const entry of explanation.fallback_chain) {
        const credential = apiKeys[entry.provider];
        const adapter = adapterForProvider(entry.provider, fetchImpl);
        if (adapter.requiresApiKey !== false && !credential) {
          attempts.push({ model: entry.id, provider: entry.provider, success: false, stopped: true, error: "API key is not configured." });
          return { dry_run: false, explanation, result: null, attempts, error: `API key is not configured for ${entry.provider}.` };
        }
        let response;
        try {
          ({ response } = await adapter.chatCompletion({
            apiKey: credential,
            baseUrl: baseUrls[entry.provider],
            messages,
            model: entry.id,
            max_tokens,
            temperature,
          }));
        } catch (error) {
          const safeError = redactKeys(error.message || String(error), Object.values(apiKeys));
          attempts.push({ model: entry.id, provider: entry.provider, success: false, stopped: true, error: safeError });
          return { dry_run: false, explanation, result: null, attempts, error: safeError };
        }

        const body = await response.text();
        const headers = adapter.parseHealthFromHeaders(response.headers);
        if (!response.ok) {
          const status = Number(response.status);
          const error = redactKeys(`HTTP ${status}: ${body.slice(0, 300)}`, Object.values(apiKeys));
          if (adapter.isSafeFallbackStatus(status)) {
            const health = updateRuntimeState(entry, "fallback", headers);
            attempts.push({
              model: entry.id,
              provider: entry.provider,
              success: false,
              status,
              retry_after: headers.retry_after || null,
              health,
              error,
            });
            continue;
          }
          attempts.push({ model: entry.id, provider: entry.provider, success: false, stopped: true, status, error });
          return { dry_run: false, explanation, result: null, attempts, error };
        }

        let json;
        try {
          json = JSON.parse(body);
        } catch {
          const error = "Provider returned a non-JSON success response; routing stopped.";
          attempts.push({ model: entry.id, provider: entry.provider, success: false, stopped: true, status: 200, error });
          return { dry_run: false, explanation, result: null, attempts, error };
        }
        const health = updateRuntimeState(entry, "success", headers);
        const normalized = adapter.parseResponse(json);
        attempts.push({ model: entry.id, provider: entry.provider, success: true, status: 200, health });
        return {
          dry_run: false,
          explanation,
          result: {
            provider: entry.provider,
            model: entry.id,
            protocol: adapter.protocol,
            content: normalized.content,
            tool_calls: normalized.tool_calls,
            finish_reason: normalized.finish_reason,
            usage: normalized.usage,
          },
          attempts,
        };
      }
      return {
        dry_run: false,
        explanation,
        result: null,
        attempts,
        error: redactKeys("All eligible models were exhausted by safe fallback responses.", Object.values(apiKeys)),
      };
    },
  };
}

export const defaultBudgetRouter = createBudgetRouter();
