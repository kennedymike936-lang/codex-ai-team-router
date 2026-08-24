import { recordUsage, usageEvent } from "./usage-ledger.mjs";
import { resilientFetch } from "./network-client.mjs";

const DEFAULT_TTL_MS = 60 * 60 * 1000;
const FALLBACK_MODELS = [
  "grok-4.20-0309-non-reasoning",
  "grok-4.3",
  "grok-build-0.1",
];

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

function finitePrice(value) {
  const price = Number(value);
  return Number.isFinite(price) && price >= 0 ? price : Number.POSITIVE_INFINITY;
}

function supportsText(model) {
  const input = Array.isArray(model?.input_modalities) ? model.input_modalities : [];
  const output = Array.isArray(model?.output_modalities) ? model.output_modalities : [];
  return input.includes("text") && output.includes("text");
}

function searchModelTraits(model) {
  const id = String(model?.id || "").toLowerCase();
  if (!id || !supportsText(model)) return null;
  if (/imagine|image|video|audio|voice|embedding|multi-agent/.test(id)) return null;
  if (/beta|experimental|preview/.test(id)) return null;
  if (/(^|-)reasoning($|-)/.test(id) && !id.includes("non-reasoning")) return null;

  const promptPrice = finitePrice(model.prompt_text_token_price);
  const outputPrice = finitePrice(model.completion_text_token_price);
  const priceScore = promptPrice + outputPrice * 0.25;
  const reasoningMultiplier = id.includes("non-reasoning") ? 1 : /build|code/.test(id) ? 2 : 1.35;
  return {
    id: model.id,
    valueScore: priceScore * reasoningMultiplier,
    created: Number(model.created || 0),
  };
}

export function rankXaiSearchModels(models = []) {
  return models
    .map(searchModelTraits)
    .filter(Boolean)
    .sort((a, b) => (
      a.valueScore - b.valueScore ||
      b.created - a.created ||
      a.id.localeCompare(b.id)
    ))
    .map((item) => item.id);
}

export function xaiLanguageModelsEndpoint(baseUrl) {
  return `${String(baseUrl || "https://api.x.ai/v1").replace(/\/$/, "")}/language-models`;
}

export class XaiSearchModelSelector {
  constructor({ fetchImpl = resilientFetch, ttlMs = DEFAULT_TTL_MS, now = () => Date.now() } = {}) {
    this.fetchImpl = fetchImpl;
    this.ttlMs = ttlMs;
    this.now = now;
    this.cache = new Map();
  }

  async discover({ baseUrl, apiKey }) {
    const cacheKey = String(baseUrl).replace(/\/$/, "");
    const cached = this.cache.get(cacheKey);
    if (cached && this.now() - cached.fetchedAt < this.ttlMs) return cached.models;

    try {
      const response = await this.fetchImpl(xaiLanguageModelsEndpoint(baseUrl), {
        headers: { authorization: `Bearer ${apiKey}` },
        signal: AbortSignal.timeout(20_000),
      });
      if (!response.ok) return null;
      const json = await response.json();
      const models = Array.isArray(json.models) ? json.models : [];
      this.cache.set(cacheKey, { fetchedAt: this.now(), models });
      return models;
    } catch {
      return null;
    }
  }

  invalidate(baseUrl) {
    this.cache.delete(String(baseUrl).replace(/\/$/, ""));
  }

  async candidates({ baseUrl, apiKey, configuredModel = "", mode = "auto" }) {
    if (mode === "fixed" && configuredModel) return [configuredModel];
    const available = await this.discover({ baseUrl, apiKey });
    if (available) {
      const ranked = rankXaiSearchModels(available);
      if (ranked.length > 0) return unique([...ranked, configuredModel]).slice(0, 3);
    }
    return unique([...FALLBACK_MODELS, configuredModel]).slice(0, 3);
  }
}

export function extractXaiText(response = {}) {
  const parts = [];
  for (const item of response.output || []) {
    if (item?.type !== "message") continue;
    for (const content of item.content || []) {
      if (content?.type === "output_text" && typeof content.text === "string") parts.push(content.text);
    }
  }
  return parts.join("\n").trim();
}

export function extractXaiCitations(response = {}, text = "") {
  const urls = new Set();
  const stack = [response.citations, response.output];
  let visited = 0;
  while (stack.length > 0 && visited < 5000) {
    const value = stack.pop();
    visited += 1;
    if (typeof value === "string") {
      if (/^https?:\/\//i.test(value)) urls.add(value);
      continue;
    }
    if (!value || typeof value !== "object") continue;
    if (Array.isArray(value)) {
      stack.push(...value);
      continue;
    }
    for (const [key, child] of Object.entries(value)) {
      if (/^(url|source_url)$/i.test(key) && typeof child === "string" && /^https?:\/\//i.test(child)) {
        urls.add(child);
      } else {
        stack.push(child);
      }
    }
  }
  for (const match of String(text).matchAll(/https?:\/\/[^\s\])}>"']+/gi)) urls.add(match[0]);
  return [...urls].slice(0, 12);
}

export function xaiUsage(usage = {}) {
  return {
    input_tokens: Number(usage.input_tokens || 0),
    output_tokens: Number(usage.output_tokens || 0),
    cache_read_tokens: Number(
      usage.input_tokens_details?.cached_tokens ||
      usage.cached_prompt_text_tokens ||
      0,
    ),
  };
}

export function isXaiSearchUnavailable(status, text = "") {
  if (![400, 403, 404].includes(Number(status))) return false;
  return /(model|x_search|web_search|search tool).{0,80}(not found|not exist|unavailable|unsupported|not supported|no access|permission)|unknown model/i.test(String(text));
}

function cleanHandles(handles) {
  return unique((handles || [])
    .map((handle) => String(handle || "").trim().replace(/^@/, ""))
    .filter((handle) => /^[A-Za-z0-9_]{1,15}$/.test(handle)))
    .slice(0, 20);
}

function validDate(value) {
  if (!value) return "";
  const text = String(value);
  return /^\d{4}-\d{2}-\d{2}$/.test(text) ? text : "";
}

function searchTool({ source, allowedXHandles, fromDate, toDate }) {
  if (source === "web") return { type: "web_search" };
  const tool = { type: "x_search" };
  const handles = cleanHandles(allowedXHandles);
  if (handles.length > 0) tool.allowed_x_handles = handles;
  const from = validDate(fromDate);
  const to = validDate(toDate);
  if (from) tool.from_date = from;
  if (to) tool.to_date = to;
  return tool;
}

export class XaiSearchClient {
  constructor({
    fetchImpl = resilientFetch,
    selector = new XaiSearchModelSelector({ fetchImpl }),
    recordUsageImpl = recordUsage,
  } = {}) {
    this.fetchImpl = fetchImpl;
    this.selector = selector;
    this.recordUsageImpl = recordUsageImpl;
  }

  async search({
    query,
    source = "x",
    allowedXHandles = [],
    fromDate = "",
    toDate = "",
    maxOutputTokens = 350,
    budget = "low",
    apiKey,
    baseUrl = "https://api.x.ai/v1",
    configuredModel = "",
    mode = "auto",
  }) {
    if (!String(query || "").trim()) throw new Error("xAI search query is required.");
    const models = await this.selector.candidates({ baseUrl, apiKey, configuredModel, mode });
    const tool = searchTool({ source, allowedXHandles, fromDate, toDate });
    let lastError = "";

    for (let index = 0; index < models.length; index += 1) {
      const model = models[index];
      const started = Date.now();
      const body = {
        model,
        instructions: [
          "You are Grok, a read-only research scout for Codex.",
          `Use exactly one ${source === "web" ? "Web" : "X"} search operation and do not perform follow-up searches.`,
          "Return concise factual findings with source URLs. Distinguish facts from inference.",
          "Do not write code, edit files, request secrets, or perform actions outside search.",
        ].join("\n"),
        input: String(query || "").trim(),
        tools: [tool],
        tool_choice: "required",
        parallel_tool_calls: false,
        max_turns: 1,
        max_output_tokens: Math.max(100, Math.min(1000, Number(maxOutputTokens || 350))),
        store: false,
      };
      const response = await this.fetchImpl(`${String(baseUrl).replace(/\/$/, "")}/responses`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(90_000),
      });
      const raw = await response.text();
      let json = {};
      try { json = JSON.parse(raw); } catch {}

      if (response.ok) {
        const answer = extractXaiText(json);
        const citations = extractXaiCitations(json, answer);
        const event = usageEvent({
          provider: "xai",
          model,
          budget,
          usage: xaiUsage(json.usage),
          latencyMs: Date.now() - started,
          fallbackCount: index,
          actualCostUsdTicks: json.usage?.cost_in_usd_ticks,
          serverSideToolsUsed: json.usage?.num_server_side_tools_used,
          citations,
        });
        await this.recordUsageImpl(event);
        return { text: answer || raw, citations, event };
      }

      lastError = `xAI ${response.status} ${response.statusText}: ${raw.slice(0, 800)}`;
      const canFallback = index + 1 < models.length && isXaiSearchUnavailable(response.status, raw);
      if (canFallback) continue;
      const event = usageEvent({
        provider: "xai",
        model,
        budget,
        usage: xaiUsage(json.usage),
        latencyMs: Date.now() - started,
        fallbackCount: index,
        success: false,
        error: lastError,
        actualCostUsdTicks: json.usage?.cost_in_usd_ticks,
        serverSideToolsUsed: json.usage?.num_server_side_tools_used,
      });
      await this.recordUsageImpl(event);
      throw new Error(lastError);
    }
    throw new Error(lastError || "xAI search failed: no compatible value model is available.");
  }
}

export const xaiSearchClient = new XaiSearchClient();
