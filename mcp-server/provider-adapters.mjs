export const OPENROUTER_DEFAULT_BASE = "https://openrouter.ai/api/v1";
export const GROQ_DEFAULT_BASE = "https://api.groq.com/openai/v1";
export const GEMINI_DEFAULT_BASE = "https://generativelanguage.googleapis.com/v1beta";
export const OPENAI_DEFAULT_BASE = "https://api.openai.com/v1";
export const SILICONFLOW_DEFAULT_BASE = "https://api.siliconflow.cn/v1";

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
    .replace(/\b(?:sk-|gsk_|AIza|AQ\.)[A-Za-z0-9._-]+\b/gi, "***REDACTED***");
}

export function redactHeaders(headers) {
  if (!headers) return headers;
  const safe = {};
  for (const [key, value] of Object.entries(headers)) {
    safe[key] = ["authorization", "x-api-key", "x-goog-api-key"].includes(key.toLowerCase())
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

export function normalizeOpenAiCompatibleModel(raw, override = {}, _catalog = {}, provider = "openai_compatible") {
  if (!raw || typeof raw.id !== "string") return null;
  const common = normalizeCommon(raw, override);
  const pricing = parseObject(raw.pricing);
  const inputPrice = optionalNumber(override.pricing?.input ?? pricing.input ?? pricing.prompt);
  const outputPrice = optionalNumber(override.pricing?.output ?? pricing.output ?? pricing.completion);
  return {
    id: raw.id,
    provider,
    context_length: nonNegative(override.context_length ?? raw.context_length ?? raw.context_window),
    architecture: raw.architecture && typeof raw.architecture === "object" ? { ...raw.architecture } : {},
    pricing: { input: inputPrice, output: outputPrice },
    supported_parameters: Array.isArray(raw.supported_parameters) ? [...raw.supported_parameters] : [],
    is_free: override.is_free === true && inputPrice === 0 && outputPrice === 0,
    is_zero_data_retention: override.is_zero_data_retention === true,
    ...common,
    raw,
  };
}

export function normalizeSiliconFlowModel(raw, override = {}) {
  const model = normalizeOpenAiCompatibleModel(raw, override, {}, "siliconflow");
  if (!model) return null;
  return {
    ...model,
    // Requests cross the SiliconFlow cloud boundary even when the model ID
    // names Qwen, DeepSeek, or another upstream model family.
    data_boundary: "siliconflow_cloud",
    privacy_sensitive_task_policy: "deny",
    content_policy: "restricted",
    is_zero_data_retention: override.is_zero_data_retention === true,
  };
}

export function normalizeGeminiModel(raw, override = {}) {
  const name = typeof raw?.name === "string" ? raw.name.replace(/^models\//, "") : "";
  if (!name) return null;
  const inputPrice = optionalNumber(override.pricing?.input);
  const outputPrice = optionalNumber(override.pricing?.output);
  return {
    id: name,
    provider: "gemini",
    context_length: nonNegative(override.context_length ?? raw.inputTokenLimit),
    architecture: {},
    pricing: { input: inputPrice, output: outputPrice },
    supported_parameters: Array.isArray(raw.supportedGenerationMethods) ? [...raw.supportedGenerationMethods] : [],
    is_free: override.is_free === true && inputPrice === 0 && outputPrice === 0,
    // Gemini unpaid-service requests are not treated as ZDR. A deployment may
    // override this only when its administrator has verified a different contract.
    is_zero_data_retention: override.is_zero_data_retention === true,
    ...normalizeCommon(raw, override),
    raw,
  };
}

function bearerHeaders(apiKey) {
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

function requireBaseUrl(baseUrl, provider) {
  if (!String(baseUrl || "").trim()) throw new Error(`${provider} base URL is not configured.`);
  return String(baseUrl).replace(/\/$/, "");
}

export function normalizeOpenAiResponse(json = {}) {
  const message = json.choices?.[0]?.message || {};
  return {
    content: typeof message.content === "string" ? message.content : "",
    tool_calls: Array.isArray(message.tool_calls) ? message.tool_calls : [],
    finish_reason: json.choices?.[0]?.finish_reason || null,
    usage: {
      input_tokens: Number(json.usage?.prompt_tokens || json.usage?.input_tokens || 0),
      output_tokens: Number(json.usage?.completion_tokens || json.usage?.output_tokens || 0),
    },
    raw: json,
  };
}

function createOpenAiCompatibleAdapter({
  provider,
  defaultBaseUrl = "",
  normalizeModel = (raw, override, catalog) => normalizeOpenAiCompatibleModel(raw, override, catalog, provider),
  safeFallbackStatuses = new Set([429]),
  modelListPath = "/models",
  requiresApiKey = true,
  fetchImpl = fetch,
} = {}) {
  return {
    provider,
    protocol: "openai_chat_completions",
    requiresApiKey,
    fetchImpl,

    async discoverModels({ baseUrl = defaultBaseUrl, apiKey, metadata = {}, capabilityCatalog = {} } = {}) {
      const root = requireBaseUrl(baseUrl, provider);
      const response = await this.fetchImpl(`${root}${modelListPath}`, { headers: bearerHeaders(apiKey) });
      if (!response.ok) {
        const body = await response.text();
        throw new Error(redactKeys(`${provider} model discovery failed (${response.status}): ${body.slice(0, 300)}`, [apiKey]));
      }
      const json = await response.json();
      return (json.data || []).map((raw) => normalizeModel(raw, metadata[raw.id] || {}, capabilityCatalog)).filter(Boolean);
    },

    async chatCompletion({ baseUrl = defaultBaseUrl, apiKey, messages, model, max_tokens, temperature = 0.2 }) {
      const root = requireBaseUrl(baseUrl, provider);
      const response = await this.fetchImpl(`${root}/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json", ...bearerHeaders(apiKey) },
        body: JSON.stringify({ model, messages, max_tokens, temperature }),
      });
      return { response };
    },

    parseResponse: normalizeOpenAiResponse,
    isSafeFallbackStatus: (status) => safeFallbackStatuses.has(Number(status)) || (Number(status) >= 500 && Number(status) <= 599),
    isAuthOrPermissionStop: (status) => Number(status) === 401 || Number(status) === 403,
    parseHealthFromHeaders: parseRateLimitHeaders,
  };
}

export function geminiContentsFromMessages(messages = []) {
  const systemParts = [];
  const contents = [];
  for (const message of messages) {
    const text = typeof message?.content === "string" ? message.content : "";
    if (!text) continue;
    if (message.role === "system") {
      systemParts.push({ text });
      continue;
    }
    contents.push({ role: message.role === "assistant" ? "model" : "user", parts: [{ text }] });
  }
  return {
    contents,
    ...(systemParts.length > 0 ? { systemInstruction: { parts: systemParts } } : {}),
  };
}

export function normalizeGeminiResponse(json = {}) {
  const candidate = json.candidates?.[0] || {};
  const parts = Array.isArray(candidate.content?.parts) ? candidate.content.parts : [];
  return {
    content: parts.map((part) => typeof part.text === "string" ? part.text : "").filter(Boolean).join(""),
    tool_calls: parts.filter((part) => part.functionCall).map((part, index) => ({
      id: part.functionCall.id || `gemini-call-${index + 1}`,
      type: "function",
      function: {
        name: part.functionCall.name || "",
        arguments: JSON.stringify(part.functionCall.args || {}),
      },
    })),
    finish_reason: candidate.finishReason || null,
    usage: {
      input_tokens: Number(json.usageMetadata?.promptTokenCount || 0),
      output_tokens: Number(json.usageMetadata?.candidatesTokenCount || 0),
    },
    raw: json,
  };
}

export function createGeminiAdapter(fetchImpl = fetch) {
  return {
    provider: "gemini",
    protocol: "gemini_generate_content",
    requiresApiKey: true,
    fetchImpl,

    async discoverModels({ baseUrl = GEMINI_DEFAULT_BASE, apiKey, metadata = {} } = {}) {
      const root = requireBaseUrl(baseUrl, "gemini");
      const response = await this.fetchImpl(`${root}/models?pageSize=1000`, { headers: { "x-goog-api-key": apiKey } });
      if (!response.ok) {
        const body = await response.text();
        throw new Error(redactKeys(`gemini model discovery failed (${response.status}): ${body.slice(0, 300)}`, [apiKey]));
      }
      const json = await response.json();
      return (json.models || [])
        .filter((raw) => raw.supportedGenerationMethods?.includes("generateContent"))
        .map((raw) => {
          const id = String(raw.name || "").replace(/^models\//, "");
          return normalizeGeminiModel(raw, metadata[id] || {});
        })
        .filter(Boolean);
    },

    async chatCompletion({ baseUrl = GEMINI_DEFAULT_BASE, apiKey, messages, model, max_tokens, temperature = 0.2 }) {
      const root = requireBaseUrl(baseUrl, "gemini");
      const cleanModel = String(model || "").replace(/^models\//, "");
      const converted = geminiContentsFromMessages(messages);
      const response = await this.fetchImpl(`${root}/models/${encodeURIComponent(cleanModel)}:generateContent`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-goog-api-key": apiKey },
        body: JSON.stringify({
          ...converted,
          generationConfig: { maxOutputTokens: max_tokens, temperature },
        }),
      });
      return { response };
    },

    parseResponse: normalizeGeminiResponse,
    isSafeFallbackStatus: (status) => Number(status) === 429 || (Number(status) >= 500 && Number(status) <= 599),
    isAuthOrPermissionStop: (status) => Number(status) === 401 || Number(status) === 403,
    parseHealthFromHeaders: parseRateLimitHeaders,
  };
}

export function createOpenRouterAdapter(fetchImpl = fetch) {
  return createOpenAiCompatibleAdapter({
    provider: "openrouter",
    defaultBaseUrl: OPENROUTER_DEFAULT_BASE,
    normalizeModel: normalizeOpenRouterModel,
    safeFallbackStatuses: new Set([402, 429]),
    fetchImpl,
  });
}

export function createGroqAdapter(fetchImpl = fetch) {
  return createOpenAiCompatibleAdapter({
    provider: "groq",
    defaultBaseUrl: GROQ_DEFAULT_BASE,
    normalizeModel: normalizeGroqModel,
    safeFallbackStatuses: new Set([429, 498]),
    fetchImpl,
  });
}

export function createGenericOpenAiAdapter(fetchImpl = fetch) {
  return createOpenAiCompatibleAdapter({ provider: "openai_compatible", requiresApiKey: false, fetchImpl });
}

export function createSiliconFlowAdapter(fetchImpl = fetch) {
  return createOpenAiCompatibleAdapter({
    provider: "siliconflow",
    defaultBaseUrl: SILICONFLOW_DEFAULT_BASE,
    normalizeModel: normalizeSiliconFlowModel,
    modelListPath: "/models?type=text&sub_type=chat",
    safeFallbackStatuses: new Set([429]),
    fetchImpl,
  });
}

export function normalizeOpenAiResponsesModel(raw, override = {}) {
  return normalizeOpenAiCompatibleModel(raw, override, {}, "openai");
}

export function normalizeOpenAiResponsesResponse(json = {}) {
  const output = Array.isArray(json.output) ? json.output : [];
  const messageText = output
    .filter((item) => item?.type === "message")
    .flatMap((item) => Array.isArray(item.content) ? item.content : [])
    .map((part) => part?.type === "output_text" && typeof part.text === "string" ? part.text : "")
    .filter(Boolean)
    .join("");
  return {
    content: typeof json.output_text === "string" ? json.output_text : messageText,
    tool_calls: output.filter((item) => item?.type === "function_call").map((item, index) => ({
      id: item.call_id || item.id || `openai-call-${index + 1}`,
      type: "function",
      function: { name: item.name || "", arguments: item.arguments || "{}" },
    })),
    finish_reason: json.status || null,
    usage: {
      input_tokens: Number(json.usage?.input_tokens || 0),
      output_tokens: Number(json.usage?.output_tokens || 0),
    },
    raw: json,
  };
}

export function createOpenAiResponsesAdapter(fetchImpl = fetch) {
  return {
    provider: "openai",
    protocol: "openai_responses",
    requiresApiKey: true,
    fetchImpl,

    async discoverModels({ baseUrl = OPENAI_DEFAULT_BASE, apiKey, metadata = {} } = {}) {
      const root = requireBaseUrl(baseUrl, "openai");
      const response = await this.fetchImpl(`${root}/models`, { headers: bearerHeaders(apiKey) });
      if (!response.ok) {
        const body = await response.text();
        throw new Error(redactKeys(`openai model discovery failed (${response.status}): ${body.slice(0, 300)}`, [apiKey]));
      }
      const json = await response.json();
      return (json.data || [])
        .map((raw) => normalizeOpenAiResponsesModel(raw, metadata[raw.id] || {}))
        .filter(Boolean);
    },

    async chatCompletion({ baseUrl = OPENAI_DEFAULT_BASE, apiKey, messages, model, max_tokens }) {
      const root = requireBaseUrl(baseUrl, "openai");
      const input = (messages || []).map((message) => ({
        role: message.role,
        content: message.content,
      }));
      const response = await this.fetchImpl(`${root}/responses`, {
        method: "POST",
        headers: { "content-type": "application/json", ...bearerHeaders(apiKey) },
        body: JSON.stringify({ model, input, max_output_tokens: max_tokens, store: false }),
      });
      return { response };
    },

    parseResponse: normalizeOpenAiResponsesResponse,
    isSafeFallbackStatus: (status) => Number(status) === 429 || (Number(status) >= 500 && Number(status) <= 599),
    isAuthOrPermissionStop: (status) => Number(status) === 401 || Number(status) === 403,
    parseHealthFromHeaders: parseRateLimitHeaders,
  };
}

const providerRegistry = new Map();

export function registerProvider(provider, factory, { replace = false } = {}) {
  const name = String(provider || "").trim().toLowerCase();
  if (!name || typeof factory !== "function") throw new Error("Provider registration requires a name and factory.");
  if (providerRegistry.has(name) && !replace) throw new Error(`Provider already registered: ${name}`);
  providerRegistry.set(name, factory);
}

export function registeredProviders() {
  return [...providerRegistry.keys()].sort();
}

registerProvider("openrouter", createOpenRouterAdapter);
registerProvider("groq", createGroqAdapter);
registerProvider("gemini", createGeminiAdapter);
registerProvider("openai_compatible", createGenericOpenAiAdapter);
registerProvider("openai", createOpenAiResponsesAdapter);
registerProvider("siliconflow", createSiliconFlowAdapter);

export function adapterForProvider(provider, fetchImpl) {
  const name = String(provider || "").trim().toLowerCase();
  const factory = providerRegistry.get(name);
  if (!factory) throw new Error(`Unknown provider: ${name}. Supported: ${registeredProviders().join(", ")}`);
  return factory(fetchImpl);
}
