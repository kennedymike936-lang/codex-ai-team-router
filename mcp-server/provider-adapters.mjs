export const OPENROUTER_DEFAULT_BASE = "https://openrouter.ai/api/v1";
export const GROQ_DEFAULT_BASE = "https://api.groq.com/openai/v1";

function headerValue(headers, name) {
  if (!headers) return null;
  if (typeof headers.get === "function") return headers.get(name);
  const key = Object.keys(headers).find((item) => item.toLowerCase() === name.toLowerCase());
  return key ? String(headers[key]) : null;
}

function numericHeader(headers, name) {
  const value = headerValue(headers, name);
  if (value === null || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : value;
}

export function redactKeys(text, secrets = []) {
  if (typeof text !== "string") return text;
  let value = text;
  for (const secret of secrets) {
    if (!secret) continue;
    value = value.split(String(secret)).join("***REDACTED***");
  }
  return value
    .replace(/(authorization\s*:\s*bearer\s+|bearer\s+)[^\s,;"')\]}]+/gi, "$1***REDACTED***")
    .replace(/\b(?:sk-or-|gsk_)[A-Za-z0-9._-]+\b/gi, "***REDACTED***");
}

export function redactHeaders(headers) {
  if (!headers) return headers;
  const safe = {};
  for (const [key, value] of Object.entries(headers)) {
    safe[key] = ["authorization", "x-api-key"].includes(key.toLowerCase())
      ? "***REDACTED***"
      : String(value);
  }
  return safe;
}

function parseObject(value) {
  if (value && typeof value === "object" && !Array.isArray(value)) return value;
  if (typeof value !== "string") return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function nonNegative(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : fallback;
}

function optionalNumber(value) {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : null;
}

function normalizedCapabilities(...values) {
  const capabilities = new Set();
  for (const value of values.flat()) {
    const name = String(value || "").toLowerCase();
    if (["code", "tools", "web"].includes(name)) capabilities.add(name);
  }
  return [...capabilities].sort();
}

function normalizeCommon(raw, override = {}) {
  return {
    capabilities: normalizedCapabilities(raw.capabilities || [], override.capabilities || []),
    quality_score: optionalNumber(override.quality_score ?? raw.quality_score),
    latency_ms: optionalNumber(override.latency_ms ?? raw.latency_ms),
    health: String(override.health ?? raw.health ?? "unknown").toLowerCase(),
    quota_remaining: optionalNumber(override.quota_remaining ?? raw.quota_remaining),
  };
}

export function normalizeOpenRouterModel(raw, override = {}) {
  if (!raw || typeof raw.id !== "string") return null;
  const pricing = parseObject(raw.pricing);
  const inputPrice = optionalNumber(pricing.prompt ?? pricing.input);
  const outputPrice = optionalNumber(pricing.completion ?? pricing.output);
  const supported = Array.isArray(raw.supported_parameters) ? [...raw.supported_parameters] : [];
  const common = normalizeCommon(raw, override);
  if (supported.some((item) => ["tools", "tool_choice", "functions"].includes(String(item).toLowerCase()))) {
    common.capabilities = normalizedCapabilities(common.capabilities, ["tools"]);
  }

  return {
    id: raw.id,
    provider: "openrouter",
    context_length: nonNegative(override.context_length ?? raw.context_length),
    architecture: raw.architecture && typeof raw.architecture === "object" ? { ...raw.architecture } : {},
    pricing: { input: inputPrice, output: outputPrice },
    supported_parameters: supported,
    is_free: inputPrice === 0 && outputPrice === 0,
    is_zero_data_retention:
      override.is_zero_data_retention === true ||
      raw.is_zero_data_retention === true ||
      raw.zero_data_retention === true ||
      raw.data_policy?.zero_data_retention === true,
    ...common,
    raw,
  };
}

// This intentionally small catalog contains only capabilities explicitly exposed by
// Groq systems. Users can extend or replace it through router metadata overrides.
export const GROQ_CAPABILITY_CATALOG = {
  "groq/compound": { capabilities: ["code", "tools", "web"] },
  "groq/compound-mini": { capabilities: ["code", "tools", "web"] },
};

export function groqCapabilities(modelId, overrides = {}) {
  const entry = overrides[modelId] || GROQ_CAPABILITY_CATALOG[modelId] || {};
  return {
    capabilities: normalizedCapabilities(entry.capabilities || []),
    contextLengthOverride: nonNegative(entry.context_length),
  };
}

export function normalizeGroqModel(raw, override = {}, capabilityCatalog = {}) {
  if (!raw || typeof raw.id !== "string") return null;
  const catalog = groqCapabilities(raw.id, capabilityCatalog);
  const common = normalizeCommon(raw, {
    ...override,
    capabilities: normalizedCapabilities(catalog.capabilities, override.capabilities || []),
  });
  return {
    id: raw.id,
    provider: "groq",
    context_length: nonNegative(
      override.context_length ?? raw.context_window ?? raw.max_context_length ?? catalog.contextLengthOverride,
    ),
    architecture: {},
    pricing: {
      input: optionalNumber(override.pricing?.input),
      output: optionalNumber(override.pricing?.output),
    },
    supported_parameters: [],
    is_free: override.is_free === true && override.pricing?.input === 0 && override.pricing?.output === 0,
    is_zero_data_retention: override.is_zero_data_retention === true,
    ...common,
    raw,
  };
}

function providerHeaders(apiKey) {
  return apiKey ? { authorization: `Bearer ${apiKey}` } : {};
}

export function parseRateLimitHeaders(headers) {
  return {
    retry_after: headerValue(headers, "retry-after"),
    limit_requests: numericHeader(headers, "x-ratelimit-limit-requests"),
    limit_tokens: numericHeader(headers, "x-ratelimit-limit-tokens"),
    remaining_requests: numericHeader(headers, "x-ratelimit-remaining-requests"),
    remaining_tokens: numericHeader(headers, "x-ratelimit-remaining-tokens"),
    reset_requests: headerValue(headers, "x-ratelimit-reset-requests"),
    reset_tokens: headerValue(headers, "x-ratelimit-reset-tokens"),
  };
}

function createAdapter({ provider, defaultBaseUrl, normalizeModel, safeFallbackStatuses, fetchImpl }) {
  return {
    provider,
    fetchImpl,

    async discoverModels({ baseUrl = defaultBaseUrl, apiKey, metadata = {}, capabilityCatalog = {} } = {}) {
      const response = await this.fetchImpl(`${baseUrl.replace(/\/$/, "")}/models`, {
        headers: providerHeaders(apiKey),
      });
      if (!response.ok) {
        const body = await response.text();
        throw new Error(redactKeys(`${provider} model discovery failed (${response.status}): ${body.slice(0, 300)}`, [apiKey]));
      }
      const json = await response.json();
      return (json.data || [])
        .map((raw) => normalizeModel(raw, metadata[raw.id] || {}, capabilityCatalog))
        .filter(Boolean);
    },

    async chatCompletion({ baseUrl = defaultBaseUrl, apiKey, messages, model, max_tokens, temperature = 0.2 }) {
      const response = await this.fetchImpl(`${baseUrl.replace(/\/$/, "")}/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json", ...providerHeaders(apiKey) },
        body: JSON.stringify({ model, messages, max_tokens, temperature }),
      });
      return { response };
    },

    isSafeFallbackStatus(status) {
      return safeFallbackStatuses.has(Number(status)) || (Number(status) >= 500 && Number(status) <= 599);
    },

    isAuthOrPermissionStop(status) {
      return Number(status) === 401 || Number(status) === 403;
    },

    parseHealthFromHeaders(headers) {
      return parseRateLimitHeaders(headers);
    },
  };
}

export function createOpenRouterAdapter(fetchImpl = fetch) {
  return createAdapter({
    provider: "openrouter",
    defaultBaseUrl: OPENROUTER_DEFAULT_BASE,
    normalizeModel: normalizeOpenRouterModel,
    safeFallbackStatuses: new Set([402, 429]),
    fetchImpl,
  });
}

export function createGroqAdapter(fetchImpl = fetch) {
  return createAdapter({
    provider: "groq",
    defaultBaseUrl: GROQ_DEFAULT_BASE,
    normalizeModel: normalizeGroqModel,
    safeFallbackStatuses: new Set([429, 498]),
    fetchImpl,
  });
}

export function adapterForProvider(provider, fetchImpl) {
  if (provider === "openrouter") return createOpenRouterAdapter(fetchImpl);
  if (provider === "groq") return createGroqAdapter(fetchImpl);
  throw new Error(`Unknown provider: ${provider}. Supported: openrouter, groq`);
}
