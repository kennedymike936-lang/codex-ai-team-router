import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  adapterForProvider,
  geminiContentsFromMessages,
  groqCapabilities,
  normalizeGroqModel,
  normalizeGeminiModel,
  normalizeGeminiResponse,
  normalizeOpenAiCompatibleModel,
  normalizeOpenAiResponsesResponse,
  normalizeOpenRouterModel,
  normalizeSiliconFlowModel,
  parseRateLimitHeaders,
  preferredModelsForProvider,
  registeredProviders,
  redactHeaders,
  redactKeys,
} from "./provider-adapters.mjs";
import { createBudgetRouter, scoreCandidate } from "./budget-router.mjs";
import { ProviderHealthTracker, modelKey, parseRetryAfter } from "./provider-health.mjs";
import { mergeBuiltinModelMetadata } from "./autonomy-policy.mjs";

{
  const dir = mkdtempSync(join(tmpdir(), "ai-team-health-"));
  try {
    const now = Date.parse("2026-08-21T00:00:00Z");
    assert.equal(parseRetryAfter("8", now), now + 8000);
    assert.equal(parseRetryAfter(new Date(now + 9000).toUTCString(), now), now + 9000);
    const tracker = new ProviderHealthTracker({ stateDir: dir });
    tracker.load(now);
    tracker.recordFailure("openrouter", "vendor/model:v2", 429, "8", now);
    tracker.save();
    const reloaded = new ProviderHealthTracker({ stateDir: dir });
    reloaded.load(now + 1000);
    const key = modelKey("openrouter", "vendor/model:v2");
    assert.equal(reloaded.getCooldownRemainingMs(key, now + 1000), 7000);
    assert.equal(reloaded.filterActiveCooldown([{ provider: "openrouter", id: "vendor/model:v2" }], now + 1000).excluded_with_reason[0].reason, "provider_cooldown");
    assert.equal(reloaded.filterActiveCooldown([{ provider: "openrouter", id: "vendor/model:v2" }], now + 9000).included.length, 1);
    reloaded.recordSuccess("openrouter", "vendor/model:v2", { remaining_requests: 10 }, now + 10000);
    reloaded.save();
    assert.equal(reloaded.getCooldownRemainingMs(key, now + 10000), 0);
    const persisted = readFileSync(join(dir, "providers.json"), "utf8");
    assert.equal(persisted.includes("secret-token"), false);
    assert.equal(persisted.includes("vendor/model:v2"), true);
    writeFileSync(join(dir, "providers.json"), JSON.stringify({ version: 1, entries: [{ provider: "xai", model_id: "old", cooldown_end_ms: now, failure_count: 1, updated_at: now - 8 * 86400000 }] }));
    const pruned = new ProviderHealthTracker({ stateDir: dir });
    pruned.load(now);
    assert.equal(pruned.getEntry(modelKey("xai", "old")), null);
    assert.equal(pruned.shouldRecordCooldown(401, false), false);
    assert.equal(pruned.shouldRecordCooldown(429, false), true);
    assert.equal(pruned.shouldRecordCooldown(null, true), true);
    console.log("Provider health: persistence, cooldown, expiry, status classification, and redaction passed");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const OPENROUTER_TEST_CREDENTIAL = "openrouter-test-value";
const GROQ_TEST_CREDENTIAL = "groq-test-value";
const GEMINI_TEST_CREDENTIAL = "gemini-test-value";
const SILICONFLOW_TEST_CREDENTIAL = ["sk", "siliconflow-test-value"].join("-");
const FABRIC_TEST_CREDENTIAL = "fabric-provider-test-value";

function credentialArgs(credential) {
  return { ["api" + "Key"]: credential };
}

function headers(values = {}) {
  const normalized = Object.fromEntries(Object.entries(values).map(([key, value]) => [key.toLowerCase(), String(value)]));
  return { get: (name) => normalized[name.toLowerCase()] ?? null };
}

function response(status, body, headerValues = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: headers(headerValues),
    text: async () => typeof body === "string" ? body : JSON.stringify(body),
    json: async () => typeof body === "string" ? JSON.parse(body) : body,
  };
}

function candidate(id, provider = "openrouter", extra = {}) {
  return {
    id,
    provider,
    capabilities: [],
    context_length: 32_768,
    pricing: provider === "openrouter" ? { input: 0, output: 0 } : { input: null, output: null },
    is_free: provider === "openrouter",
    is_zero_data_retention: false,
    health: "unknown",
    latency_ms: null,
    quota_remaining: null,
    ...extra,
  };
}

function successBody(content = "ok") {
  return { choices: [{ message: { content } }], usage: { prompt_tokens: 12, completion_tokens: 4 } };
}

assert.equal(redactKeys("Bearer sample-secret-value"), "Bearer ***REDACTED***");
assert.equal(redactKeys(`failure ${OPENROUTER_TEST_CREDENTIAL}`, [OPENROUTER_TEST_CREDENTIAL]), "failure ***REDACTED***");
assert.equal(redactKeys(`failure ${SILICONFLOW_TEST_CREDENTIAL}`), "failure ***REDACTED***");
assert.deepEqual(redactHeaders({ Authorization: "Bearer hidden", Accept: "json" }), { Authorization: "***REDACTED***", Accept: "json" });
assert.deepEqual(redactHeaders({ "x-goog-api-key": "hidden" }), { "x-goog-api-key": "***REDACTED***" });

for (const provider of ["zhipu", "modelscope", "nvidia", "mistral", "cloudflare"]) {
  assert.equal(registeredProviders().includes(provider), true, `${provider} must be independently registered`);
}
assert.deepEqual(preferredModelsForProvider("zhipu"), ["glm-4.7-flash", "glm-4.6", "glm-4.5"]);
assert.deepEqual(preferredModelsForProvider("NVIDIA"), ["nvidia/nemotron-3-ultra-550b-a55b"]);
assert.deepEqual(preferredModelsForProvider("openrouter"), [
  "z-ai/glm-5.2:free",
  "thinkingmachines/inkling:free",
  "cohere/north-mini-code:free",
  "nvidia/nemotron-3-ultra-550b-a55b:free",
]);
assert.deepEqual(preferredModelsForProvider("unknown"), []);

{
  // Groq free-tier preferred model order
  const groqPreferred = preferredModelsForProvider("groq");
  assert.deepEqual(groqPreferred, [
    "openai/gpt-oss-120b",
    "qwen/qwen3.6-27b",
    "openai/gpt-oss-20b",
    "groq/compound",
    "groq/compound-mini",
  ]);
}

{
  // Daily request limit caps for Groq free-tier models
  const metadata = mergeBuiltinModelMetadata();
  const entries = [
    { id: "groq:openai/gpt-oss-120b", expectedLimit: 1000 },
    { id: "groq:qwen/qwen3.6-27b", expectedLimit: 1000 },
    { id: "groq:openai/gpt-oss-20b", expectedLimit: 1000 },
    { id: "groq:groq/compound", expectedLimit: 250 },
    { id: "groq:groq/compound-mini", expectedLimit: 250 },
  ];
  for (const entry of entries) {
    assert.ok(metadata[entry.id], `${entry.id} must exist in BUILTIN_MODEL_METADATA`);
    assert.equal(metadata[entry.id].daily_request_limit, entry.expectedLimit, `${entry.id} daily_request_limit`);
    assert.equal(metadata[entry.id].context_length, 131_072, `${entry.id} context_length`);
    assert.equal(metadata[entry.id].is_free, true, `${entry.id} is_free`);
    assert.equal(metadata[entry.id].catalog_source, "official_free_plan_limits", `${entry.id} catalog_source`);
    assert.equal(metadata[entry.id].catalog_updated_at, "2026-08-24", `${entry.id} catalog_updated_at`);
  }
}

{
  // GLM-4.7-Flash retains primary preference — paid containment rules untouched
  assert.deepEqual(preferredModelsForProvider("zhipu"), ["glm-4.7-flash", "glm-4.6", "glm-4.5"]);
  const metadata = mergeBuiltinModelMetadata();
  const zhipuPrimary = metadata["zhipu:glm-4.7-flash"];
  assert.ok(zhipuPrimary, "zhipu:glm-4.7-flash must exist");
  assert.equal(zhipuPrimary.routing_priority, 25);
}

{
  // Free-only eligibility: all five Groq models pass as confirmed-free
  const router = createBudgetRouter({ modelMetadata: mergeBuiltinModelMetadata() });
  const groqCandidates = [
    candidate("openai/gpt-oss-120b", "groq", { pricing: { input: 0, output: 0 }, is_free: true, capabilities: ["code"] }),
    candidate("qwen/qwen3.6-27b", "groq", { pricing: { input: 0, output: 0 }, is_free: true, capabilities: ["code"] }),
    candidate("openai/gpt-oss-20b", "groq", { pricing: { input: 0, output: 0 }, is_free: true, capabilities: ["code"] }),
    candidate("groq/compound", "groq", { pricing: { input: 0, output: 0 }, is_free: true, capabilities: ["code"] }),
    candidate("groq/compound-mini", "groq", { pricing: { input: 0, output: 0 }, is_free: true, capabilities: ["code"] }),
  ];
  const route = router.route({ candidates: groqCandidates, mode: "free_only", requirements: { capabilities: ["code"] } });
  assert.notEqual(route.selected, null, "one of the five Groq free models should be selected");
  assert.ok(
    ["openai/gpt-oss-120b", "qwen/qwen3.6-27b", "openai/gpt-oss-20b", "groq/compound", "groq/compound-mini"].includes(route.selected.id),
    `selected model ${route.selected.id} must be one of the five Groq free-tier models`,
  );
  assert.equal(route.excluded.length, 0, "no excluded Groq free-tier models in free_only mode");
}

for (const spec of [
  ["zhipu", "https://open.bigmodel.cn/api/paas/v4/models"],
  ["modelscope", "https://api-inference.modelscope.cn/v1/models"],
  ["nvidia", "https://integrate.api.nvidia.com/v1/models"],
  ["mistral", "https://api.mistral.ai/v1/models"],
]) {
  const [provider, expectedUrl] = spec;
  let request;
  const adapter = adapterForProvider(provider, async (url, options) => {
    request = { url, options };
    return response(200, { data: [{ id: `${provider}/discovered-model` }] });
  });
  const models = await adapter.discoverModels(credentialArgs(FABRIC_TEST_CREDENTIAL));
  assert.equal(request.url, expectedUrl);
  assert.equal(request.options.headers.authorization, `Bearer ${FABRIC_TEST_CREDENTIAL}`);
  assert.equal(models[0].provider, provider);
  assert.equal(models[0].id, `${provider}/discovered-model`);
}

{
  let requestBody;
  const adapter = adapterForProvider("zhipu", async (_url, options) => {
    requestBody = JSON.parse(options.body);
    return response(200, successBody("ok"));
  });
  await adapter.chatCompletion({
    ...credentialArgs(FABRIC_TEST_CREDENTIAL),
    model: "glm-4.7-flash",
    messages: [{ role: "user", content: "hello" }],
    max_tokens: 32,
    thinking: "disabled",
  });
  assert.deepEqual(requestBody.thinking, { type: "disabled" });
}

{
  let currentTime = 10_000;
  let fetchCalls = 0;
  const cacheCredential = "fabric-cache-test-value";
  const cachedRouter = createBudgetRouter({
    modelMetadata: mergeBuiltinModelMetadata(),
    modelDiscoveryTtlMs: 1_000,
    now: () => currentTime,
  });
  const discover = () => cachedRouter.discoverCandidates({
    providers: ["zhipu"],
    apiKeys: { zhipu: cacheCredential },
    fetchImpl: async () => {
      fetchCalls += 1;
      return response(200, { data: [{ id: "glm-4.6" }] });
    },
  });
  const firstDiscovery = await discover();
  await discover();
  assert.equal(fetchCalls, 1, "model discovery should use the in-process TTL cache");
  const freeRoute = cachedRouter.route({
    candidates: firstDiscovery.candidates,
    mode: "free_only",
    requirements: { capabilities: ["code"] },
  });
  assert.equal(freeRoute.selected.id, "glm-4.7-flash");
  assert.equal(firstDiscovery.candidates.find((model) => model.id === "glm-4.7-flash").discovery, "verified_preference_hint");
  assert.equal(adapterForProvider("zhipu", async () => {}).isSafeFallbackStatus(404), true);
  assert.equal(JSON.stringify([...cachedRouter.modelDiscoveryCache.keys()]).includes(cacheCredential), false);
  currentTime += 1_001;
  await discover();
  assert.equal(fetchCalls, 2, "expired model discovery cache should refresh");
}

{
  const metadata = mergeBuiltinModelMetadata();
  const mistral = normalizeOpenAiCompatibleModel(
    { id: "devstral-latest" },
    {},
    {},
    "mistral",
  );
  const routerWithMetadata = createBudgetRouter({ modelMetadata: metadata });
  const freeRoute = routerWithMetadata.route({ candidates: [mistral], mode: "free_only" });
  assert.equal(freeRoute.selected, null, "promotional credit must not be treated as permanent zero-price inference");
  const balancedRoute = routerWithMetadata.route({ candidates: [mistral], mode: "balanced" });
  assert.equal(balancedRoute.selected.id, "devstral-latest");
}

const openRouterObject = normalizeOpenRouterModel({
  id: "vendor/code-model:free",
  pricing: { prompt: "0", completion: "0" },
  context_length: 131_072,
  supported_parameters: ["tools"],
  capabilities: ["code"],
  data_policy: { zero_data_retention: true },
});
assert.equal(openRouterObject.is_free, true);
assert.deepEqual(openRouterObject.pricing, { input: 0, output: 0 });
assert.deepEqual(openRouterObject.capabilities, ["code", "tools"]);
assert.equal(openRouterObject.is_zero_data_retention, true);

const openRouterString = normalizeOpenRouterModel({
  id: "vendor/paid",
  pricing: JSON.stringify({ input: "0.000001", output: "0.000002" }),
});
assert.deepEqual(openRouterString.pricing, { input: 0.000001, output: 0.000002 });
assert.equal(openRouterString.is_free, false);

const groqUnknown = normalizeGroqModel({ id: "unknown-model" });
assert.deepEqual(groqUnknown.pricing, { input: null, output: null });
assert.equal(groqUnknown.is_free, false);
assert.deepEqual(groqUnknown.capabilities, []);
assert.deepEqual(groqCapabilities("groq/compound").capabilities, ["code", "tools", "web"]);

const genericUnknown = normalizeOpenAiCompatibleModel({ id: "local/model" });
assert.equal(genericUnknown.provider, "openai_compatible");
assert.deepEqual(genericUnknown.pricing, { input: null, output: null });
assert.equal(genericUnknown.is_free, false);

const geminiUnknown = normalizeGeminiModel({
  name: "models/gemini-test",
  inputTokenLimit: 1_000_000,
  supportedGenerationMethods: ["generateContent"],
});
assert.equal(geminiUnknown.id, "gemini-test");
assert.equal(geminiUnknown.is_free, false);
assert.equal(geminiUnknown.is_zero_data_retention, false);
assert.deepEqual(geminiUnknown.pricing, { input: null, output: null });

const siliconFlowUnknown = normalizeSiliconFlowModel({ id: "vendor/chat-model" });
assert.equal(siliconFlowUnknown.provider, "siliconflow");
assert.equal(siliconFlowUnknown.data_boundary, "siliconflow_cloud");
assert.equal(siliconFlowUnknown.privacy_sensitive_task_policy, "deny");
assert.equal(siliconFlowUnknown.content_policy, "restricted");
assert.equal(siliconFlowUnknown.is_free, false);
assert.equal(siliconFlowUnknown.is_zero_data_retention, false);
assert.deepEqual(siliconFlowUnknown.pricing, { input: null, output: null });

assert.deepEqual(geminiContentsFromMessages([
  { role: "system", content: "Be precise" },
  { role: "user", content: "hello" },
  { role: "assistant", content: "hi" },
]), {
  systemInstruction: { parts: [{ text: "Be precise" }] },
  contents: [
    { role: "user", parts: [{ text: "hello" }] },
    { role: "model", parts: [{ text: "hi" }] },
  ],
});

const normalizedGemini = normalizeGeminiResponse({
  candidates: [{
    finishReason: "STOP",
    content: { parts: [{ text: "done" }, { functionCall: { name: "lookup", args: { id: 7 } } }] },
  }],
  usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 3 },
});
assert.equal(normalizedGemini.content, "done");
assert.equal(normalizedGemini.tool_calls[0].function.name, "lookup");
assert.equal(normalizedGemini.tool_calls[0].function.arguments, '{"id":7}');
assert.equal(normalizedGemini.finish_reason, "STOP");
assert.deepEqual(normalizedGemini.usage, { input_tokens: 10, output_tokens: 3 });

assert.deepEqual(parseRateLimitHeaders(headers({
  "Retry-After": "8",
  "X-RateLimit-Limit-Requests": "100",
  "X-RateLimit-Remaining-Requests": "0",
  "X-RateLimit-Remaining-Tokens": "42",
  "X-RateLimit-Reset-Tokens": "2.5s",
})), {
  retry_after: "8",
  limit_requests: 100,
  limit_tokens: null,
  remaining_requests: 0,
  remaining_tokens: 42,
  reset_requests: null,
  reset_tokens: "2.5s",
});

assert.equal(adapterForProvider("openrouter", async () => {}).isSafeFallbackStatus(402), true);
assert.equal(adapterForProvider("openrouter", async () => {}).isSafeFallbackStatus(429), true);
assert.equal(adapterForProvider("groq", async () => {}).isSafeFallbackStatus(498), true);
assert.equal(adapterForProvider("groq", async () => {}).isAuthOrPermissionStop(401), true);
assert.equal(adapterForProvider("siliconflow", async () => {}).isSafeFallbackStatus(429), true);
assert.deepEqual(registeredProviders(), [
  "cloudflare", "gemini", "groq", "mistral", "modelscope", "nvidia",
  "openai", "openai_compatible", "openrouter", "siliconflow", "zhipu",
]);
assert.throws(
  () => adapterForProvider("unknown", async () => {}),
  /Supported: cloudflare, gemini, groq, mistral, modelscope, nvidia, openai, openai_compatible, openrouter, siliconflow, zhipu/,
);

{
  let request;
  const adapter = adapterForProvider("cloudflare", async (url, options) => {
    request = { url, options };
    return response(200, { result: [{
      name: "@cf/google/gemma-4-26b-a4b-it",
      properties: [
        { property_id: "context_window", value: "256000" },
        { property_id: "function_calling", value: "true" },
      ],
    }] });
  });
  const models = await adapter.discoverModels({
    baseUrl: "https://api.cloudflare.com/client/v4/accounts/account-fixture/ai/v1",
    apiKey: FABRIC_TEST_CREDENTIAL,
    metadata: mergeBuiltinModelMetadata(),
  });
  assert.equal(request.url, "https://api.cloudflare.com/client/v4/accounts/account-fixture/ai/models/search?per_page=100");
  assert.equal(models[0].provider, "cloudflare");
  assert.equal(models[0].context_length, 256000);
  assert.equal(models[0].capabilities.includes("tools"), true);
}

const normalizedResponses = normalizeOpenAiResponsesResponse({
  status: "completed",
  output: [
    { type: "message", content: [{ type: "output_text", text: "response-ok" }] },
    { type: "function_call", call_id: "call-1", name: "lookup", arguments: '{"id":9}' },
  ],
  usage: { input_tokens: 6, output_tokens: 2 },
});
assert.equal(normalizedResponses.content, "response-ok");
assert.equal(normalizedResponses.tool_calls[0].id, "call-1");
assert.deepEqual(normalizedResponses.usage, { input_tokens: 6, output_tokens: 2 });

{
  let request;
  const adapter = adapterForProvider("openrouter", async (url, options) => {
    request = { url, options };
    return response(200, { data: [{ id: "vendor/free", pricing: { prompt: "0", completion: "0" } }] });
  });
  const credential = OPENROUTER_TEST_CREDENTIAL;
  const models = await adapter.discoverModels({ baseUrl: "https://router.invalid/v1/", apiKey: credential });
  assert.equal(request.url, "https://router.invalid/v1/models");
  assert.equal(request.options.headers.authorization, `Bearer ${OPENROUTER_TEST_CREDENTIAL}`);
  assert.equal(models[0].is_free, true);
}

{
  let request;
  const adapter = adapterForProvider("siliconflow", async (url, options) => {
    request = { url, options };
    return response(200, { data: [{ id: "vendor/chat-model" }] });
  });
  const models = await adapter.discoverModels(credentialArgs(SILICONFLOW_TEST_CREDENTIAL));
  assert.equal(request.url, "https://api.siliconflow.cn/v1/models?type=text&sub_type=chat");
  assert.equal(request.options.headers.authorization, `Bearer ${SILICONFLOW_TEST_CREDENTIAL}`);
  assert.equal(models[0].provider, "siliconflow");
  assert.equal(models[0].is_free, false);
}

{
  let request;
  const adapter = adapterForProvider("openai", async (url, options) => {
    request = { url, options };
    return response(200, {
      status: "completed",
      output: [{ type: "message", content: [{ type: "output_text", text: "responses-ok" }] }],
      usage: { input_tokens: 3, output_tokens: 1 },
    });
  });
  const { response: openaiResponse } = await adapter.chatCompletion({
    ...credentialArgs("openai-test-value"),
    model: "test-model",
    messages: [{ role: "user", content: "hello" }],
    max_tokens: 8,
  });
  assert.equal(request.url, "https://api.openai.com/v1/responses");
  const body = JSON.parse(request.options.body);
  assert.equal(body.max_output_tokens, 8);
  assert.equal(body.store, false);
  assert.equal(adapter.parseResponse(JSON.parse(await openaiResponse.text())).content, "responses-ok");
}

{
  let calls = 0;
  const routerWithoutKey = createBudgetRouter();
  const discovery = await routerWithoutKey.discoverCandidates({
    providers: ["openai_compatible"],
    apiKeys: {},
    baseUrls: { openai_compatible: "http://127.0.0.1:1234/v1" },
    fetchImpl: async () => {
      calls += 1;
      return response(200, { data: [{ id: "local-model" }] });
    },
  });
  assert.equal(calls, 1);
  assert.equal(discovery.candidates[0].id, "local-model");
}

{
  const requests = [];
  const adapter = adapterForProvider("gemini", async (url, options) => {
    requests.push({ url, options });
    if (url.includes("?pageSize=")) {
      return response(200, { models: [
        { name: "models/gemini-test", inputTokenLimit: 1000, supportedGenerationMethods: ["generateContent"] },
        { name: "models/embed-test", supportedGenerationMethods: ["embedContent"] },
      ] });
    }
    return response(200, {
      candidates: [{ content: { parts: [{ text: "gemini-ok" }] }, finishReason: "STOP" }],
      usageMetadata: { promptTokenCount: 8, candidatesTokenCount: 2 },
    });
  });
  const models = await adapter.discoverModels(credentialArgs(GEMINI_TEST_CREDENTIAL));
  assert.equal(models.length, 1);
  assert.equal(requests[0].options.headers["x-goog-api-key"], GEMINI_TEST_CREDENTIAL);
  const { response: geminiResponse } = await adapter.chatCompletion({
    ...credentialArgs(GEMINI_TEST_CREDENTIAL),
    model: "gemini-test",
    messages: [{ role: "user", content: "hello" }],
    max_tokens: 12,
  });
  assert.match(requests[1].url, /models\/gemini-test:generateContent$/);
  const requestBody = JSON.parse(requests[1].options.body);
  assert.equal(requestBody.generationConfig.maxOutputTokens, 12);
  const parsed = adapter.parseResponse(JSON.parse(await geminiResponse.text()));
  assert.equal(parsed.content, "gemini-ok");
  assert.deepEqual(parsed.usage, { input_tokens: 8, output_tokens: 2 });
}

const router = createBudgetRouter();
const free = candidate("vendor/free", "openrouter", { capabilities: ["code"], context_length: 64_000 });
const paid = candidate("vendor/paid", "openrouter", {
  capabilities: ["code", "tools"],
  pricing: { input: 0.000001, output: 0.000002 },
  is_free: false,
  quality_score: 0.9,
});
const unknownPrice = candidate("groq/unknown", "groq", { capabilities: ["code"] });
const freeOnly = router.route({ candidates: [paid, unknownPrice, free], mode: "free_only", requirements: { capabilities: ["code"] } });
assert.equal(freeOnly.selected.id, "vendor/free");
assert.equal(freeOnly.excluded.find((item) => item.id === "vendor/paid").reasons.includes("not_confirmed_zero_price"), true);
assert.equal(freeOnly.excluded.find((item) => item.id === "groq/unknown").reasons.includes("not_confirmed_zero_price"), true);

const mismatch = router.route({ candidates: [free], mode: "balanced", requirements: { capabilities: ["tools"] } });
assert.equal(mismatch.selected, null);
assert.deepEqual(mismatch.excluded[0].reasons, ["missing_capability:tools"]);

const privacy = router.route({ candidates: [free], mode: "balanced", requirements: { sensitive: true } });
assert.equal(privacy.selected, null);
assert.equal(privacy.excluded[0].reasons[0], "privacy:zero_data_retention_not_explicitly_confirmed");

const siliconFlowPolicy = router.route({
  candidates: [siliconFlowUnknown],
  mode: "balanced",
  requirements: { policy_sensitive: true },
});
assert.equal(siliconFlowPolicy.selected, null);
assert.equal(siliconFlowPolicy.excluded[0].reasons[0], "provider_policy:policy_sensitive_topics_disabled");

const siliconFlowPrivacy = router.route({
  candidates: [siliconFlowUnknown],
  mode: "balanced",
  requirements: { sensitive: true },
});
assert.equal(siliconFlowPrivacy.selected, null);
assert.equal(siliconFlowPrivacy.excluded[0].reasons[0], "provider_policy:privacy_sensitive_tasks_disabled");

const context = router.route({ candidates: [free], mode: "balanced", requirements: { min_context_length: 100_000 } });
assert.equal(context.selected, null);
assert.equal(context.excluded[0].reasons[0], "context_too_short:64000<100000");

const scored = router.route({ candidates: [free, paid], mode: "quality_first", requirements: { capabilities: ["code"] } });
assert.equal(scored.selected.id, "vendor/paid");
assert.equal(typeof scored.selected.score, "number");
assert.equal(typeof scored.selected.score_components.quality, "number");
assert.ok(scoreCandidate({ ...free, health: "unhealthy" }, "balanced").total < scoreCandidate({ ...free, health: "healthy" }, "balanced").total);
{
  const primary = candidate("glm-4.7-flash", "zhipu", {
    capabilities: ["code", "tools"], pricing: { input: 0, output: 0 }, is_free: true,
    quality_score: 0.88, routing_priority: 25,
  });
  const higherRawQuality = candidate("fallback-free", "openrouter", {
    capabilities: ["code", "tools"], quality_score: 0.99,
  });
  const preferenceRoute = createBudgetRouter().route({
    candidates: [higherRawQuality, primary], mode: "free_only", requirements: { capabilities: ["code"] },
  });
  assert.equal(preferenceRoute.selected.id, "glm-4.7-flash");
  assert.equal(preferenceRoute.selected.score_components.preference, 25);
}

{
  let fetchCalls = 0;
  const outcome = await router.execute({
    candidates: [free],
    mode: "free_only",
    requirements: { capabilities: ["code"] },
    providers: ["openrouter"],
    apiKeys: { openrouter: OPENROUTER_TEST_CREDENTIAL },
    fetchImpl: async () => { fetchCalls += 1; throw new Error("must not run"); },
    messages: [{ role: "user", content: "test" }],
    dry_run: true,
  });
  assert.equal(fetchCalls, 0);
  assert.equal(outcome.dry_run, true);
  assert.equal(outcome.explanation.selected.id, "vendor/free");
}

{
  const geminiCandidate = candidate("gemini-test", "gemini", {
    pricing: { input: 0, output: 0 },
    is_free: true,
  });
  const execution = await createBudgetRouter().execute({
    candidates: [geminiCandidate],
    mode: "free_only",
    providers: ["gemini"],
    apiKeys: { gemini: GEMINI_TEST_CREDENTIAL },
    baseUrls: { gemini: "https://gemini.invalid/v1beta" },
    fetchImpl: async () => response(200, {
      candidates: [{ content: { parts: [{ text: "native" }] }, finishReason: "STOP" }],
      usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 1 },
    }),
    messages: [{ role: "user", content: "test" }],
    dry_run: false,
  });
  assert.equal(execution.result.protocol, "gemini_generate_content");
  assert.equal(execution.result.content, "native");
  assert.deepEqual(execution.result.usage, { input_tokens: 5, output_tokens: 1 });
}

for (const status of [429, 500, 503]) {
  let calls = 0;
  const models = [
    candidate(`gemini-a-${status}`, "gemini", { pricing: { input: 0, output: 0 }, is_free: true }),
    candidate(`gemini-b-${status}`, "gemini", { pricing: { input: 0, output: 0 }, is_free: true }),
  ];
  const execution = await createBudgetRouter().execute({
    candidates: models,
    mode: "free_only",
    providers: ["gemini"],
    apiKeys: { gemini: GEMINI_TEST_CREDENTIAL },
    fetchImpl: async () => (++calls === 1
      ? response(status, { error: { status: "RESOURCE_EXHAUSTED" } })
      : response(200, { candidates: [{ content: { parts: [{ text: "fallback" }] } }] })),
    messages: [{ role: "user", content: "test" }],
    dry_run: false,
  });
  assert.equal(calls, 2);
  assert.equal(execution.result.content, "fallback");
}

for (const status of [400, 401, 403]) {
  let calls = 0;
  const models = [
    candidate(`gemini-stop-a-${status}`, "gemini", { pricing: { input: 0, output: 0 }, is_free: true }),
    candidate(`gemini-stop-b-${status}`, "gemini", { pricing: { input: 0, output: 0 }, is_free: true }),
  ];
  const execution = await createBudgetRouter().execute({
    candidates: models,
    mode: "free_only",
    providers: ["gemini"],
    apiKeys: { gemini: GEMINI_TEST_CREDENTIAL },
    fetchImpl: async () => { calls += 1; return response(status, { error: "stop" }); },
    messages: [{ role: "user", content: "test" }],
    dry_run: false,
  });
  assert.equal(calls, 1);
  assert.equal(execution.attempts[0].stopped, true);
}

{
  let requestedUrl;
  const execution = await router.execute({
    candidates: [free],
    mode: "free_only",
    providers: ["openrouter"],
    apiKeys: { openrouter: OPENROUTER_TEST_CREDENTIAL },
    baseUrls: { openrouter: "https://custom.invalid/api" },
    fetchImpl: async (url) => { requestedUrl = url; return response(200, successBody("success")); },
    messages: [{ role: "user", content: "test" }],
    dry_run: false,
  });
  assert.equal(requestedUrl, "https://custom.invalid/api/chat/completions");
  assert.equal(execution.result.content, "success");
  assert.deepEqual(execution.result.usage, { input_tokens: 12, output_tokens: 4 });
}

for (const status of [402, 429, 502, 503]) {
  let calls = 0;
  const first = candidate(`first-${status}`);
  const second = candidate(`second-${status}`);
  const execution = await createBudgetRouter().execute({
    candidates: [first, second],
    mode: "free_only",
    providers: ["openrouter"],
    apiKeys: { openrouter: OPENROUTER_TEST_CREDENTIAL },
    fetchImpl: async () => {
      calls += 1;
      return calls === 1
        ? response(status, { error: "temporary" }, { "retry-after": "9", "x-ratelimit-remaining-requests": "0" })
        : response(200, successBody(`fallback-${status}`));
    },
    messages: [{ role: "user", content: "test" }],
    dry_run: false,
  });
  assert.equal(calls, 2);
  assert.equal(execution.result.content, `fallback-${status}`);
  if (status === 402 || status === 429) {
    assert.equal(execution.attempts[0].retry_after, "9");
    assert.equal(execution.attempts[0].health.remaining_requests, 0);
  } else {
    assert.equal(execution.attempts[0].delivery_attempts, 2);
    assert.equal(execution.attempts[0].success, true);
  }
}

{
  let calls = 0;
  const execution = await createBudgetRouter({ retryBaseDelayMs: 0 }).execute({
    candidates: [candidate("retry-503-a"), candidate("retry-503-b")],
    mode: "free_only",
    providers: ["openrouter"],
    apiKeys: { openrouter: OPENROUTER_TEST_CREDENTIAL },
    fetchImpl: async () => {
      calls += 1;
      return calls <= 2 ? response(503, { error: "capacity" }) : response(200, successBody("after-single-retry"));
    },
    messages: [{ role: "user", content: "test" }],
    dry_run: false,
  });
  assert.equal(calls, 3);
  assert.equal(execution.attempts[0].delivery_attempts, 2);
  assert.equal(execution.result.content, "after-single-retry");
}

{
  let calls = 0;
  const execution = await createBudgetRouter().execute({
    candidates: [candidate("empty-output-a"), candidate("empty-output-b")],
    mode: "free_only",
    providers: ["openrouter"],
    apiKeys: { openrouter: OPENROUTER_TEST_CREDENTIAL },
    fetchImpl: async () => {
      calls += 1;
      return calls === 1
        ? response(200, { choices: [{ message: { content: "" }, finish_reason: "length" }], usage: { completion_tokens: 8 } })
        : response(200, successBody("usable-output"));
    },
    messages: [{ role: "user", content: "test" }],
    dry_run: false,
  });
  assert.equal(calls, 2);
  assert.equal(execution.attempts[0].failure_kind, "empty_output");
  assert.equal(execution.attempts[0].success, false);
  assert.equal(execution.result.content, "usable-output");
}

{
  let calls = 0;
  const models = [candidate("groq/compound", "groq", { capabilities: ["code"] }), candidate("groq/compound-mini", "groq", { capabilities: ["code"] })];
  const execution = await createBudgetRouter().execute({
    candidates: models,
    mode: "balanced",
    providers: ["groq"],
    apiKeys: { groq: GROQ_TEST_CREDENTIAL },
    fetchImpl: async () => (++calls === 1 ? response(498, { error: "capacity" }) : response(200, successBody("groq-fallback"))),
    messages: [{ role: "user", content: "test" }],
    dry_run: false,
  });
  assert.equal(calls, 2);
  assert.equal(execution.result.content, "groq-fallback");
}

for (const status of [400, 401, 403, 404]) {
  let calls = 0;
  const execution = await createBudgetRouter().execute({
    candidates: [candidate(`stop-${status}-a`), candidate(`stop-${status}-b`)],
    mode: "free_only",
    providers: ["openrouter"],
    apiKeys: { openrouter: OPENROUTER_TEST_CREDENTIAL },
    fetchImpl: async () => { calls += 1; return response(status, { error: "stop" }); },
    messages: [{ role: "user", content: "test" }],
    dry_run: false,
  });
  assert.equal(calls, 1);
  assert.equal(execution.result, null);
  assert.equal(execution.attempts[0].stopped, true);
}

{
  let calls = 0;
  const execution = await createBudgetRouter().execute({
    candidates: [candidate("network-a"), candidate("network-b")],
    mode: "free_only",
    providers: ["openrouter"],
    apiKeys: { openrouter: OPENROUTER_TEST_CREDENTIAL },
    fetchImpl: async () => { calls += 1; throw new Error(`socket failed ${OPENROUTER_TEST_CREDENTIAL}`); },
    messages: [{ role: "user", content: "test" }],
    dry_run: false,
  });
  assert.equal(calls, 1);
  assert.equal(execution.error.includes(OPENROUTER_TEST_CREDENTIAL), false);
  assert.equal(execution.error.includes("***REDACTED***"), true);
}

{
  const missingKey = await createBudgetRouter().execute({
    candidates: [free],
    mode: "free_only",
    providers: ["openrouter"],
    apiKeys: {},
    fetchImpl: async () => { throw new Error("must not run"); },
    messages: [{ role: "user", content: "test" }],
    dry_run: false,
  });
  assert.equal(missingKey.attempts[0].stopped, true);
}

{
  const configured = createBudgetRouter({
    allowOpenRouterFreeFallback: true,
    modelMetadata: { "openrouter:openrouter/free": { capabilities: ["code"] } },
  });
  const dryRun = await configured.execute({
    candidates: [paid],
    mode: "free_only",
    requirements: { capabilities: ["code"] },
    providers: ["openrouter"],
    apiKeys: { openrouter: OPENROUTER_TEST_CREDENTIAL },
    messages: [{ role: "user", content: "test" }],
    dry_run: true,
  });
  assert.equal(dryRun.explanation.fallback_chain.some((item) => item.id === "openrouter/free"), true);
}

{
  let calls = 0;
  const persistent = createBudgetRouter({ now: () => 123 });
  const first = candidate("health-a");
  const second = candidate("health-b");
  await persistent.execute({
    candidates: [first, second],
    mode: "free_only",
    providers: ["openrouter"],
    apiKeys: { openrouter: OPENROUTER_TEST_CREDENTIAL },
    fetchImpl: async () => (++calls === 1 ? response(429, { error: "limited" }) : response(200, successBody())),
    messages: [{ role: "user", content: "test" }],
    dry_run: false,
  });
  const reroute = persistent.route({ candidates: [first, second], mode: "free_only" });
  assert.equal(reroute.selected.id, "health-b");
  assert.equal(persistent.runtimeState["openrouter:health-a"].updated_at, 123);
}

{
  const now = Date.parse("2026-08-23T12:00:00Z");
  const requestEvents = [{ provider: "openrouter", model: "capped-free", created_at: now - 1000 }];
  const stateStore = {
    countRequests: async ({ provider, model, since }) => requestEvents.filter((event) =>
      event.provider === provider && event.model === model && event.created_at >= since
    ).length,
    recordRequest: async (event) => requestEvents.push(event),
  };
  const capped = createBudgetRouter({ stateStore, now: () => now });
  const exhausted = await capped.execute({
    candidates: [candidate("capped-free", "openrouter", { daily_request_limit: 1 })],
    mode: "free_only",
    providers: ["openrouter"],
    apiKeys: { openrouter: OPENROUTER_TEST_CREDENTIAL },
    messages: [{ role: "user", content: "test" }],
    dry_run: true,
  });
  assert.equal(exhausted.explanation.selected, null);
  assert.equal(exhausted.explanation.excluded[0].reasons.includes("daily_request_limit_exhausted"), true);
  assert.equal(exhausted.explanation.excluded[0].daily_requests_used, 1);
}

{
  const metadata = mergeBuiltinModelMetadata();
  const pool = createBudgetRouter({ modelMetadata: metadata });
  const discovered = await pool.discoverCandidates({
    providers: ["openrouter"],
    apiKeys: { openrouter: OPENROUTER_TEST_CREDENTIAL },
    fetchImpl: async () => response(200, { data: [
      { id: "z-ai/glm-5.2:free", pricing: { prompt: "0", completion: "0" } },
      { id: "unlisted/other:free", pricing: { prompt: "0", completion: "0" } },
    ] }),
  });
  assert.deepEqual(discovered.candidates.map((model) => model.id), ["z-ai/glm-5.2:free"]);
}

console.log("Budget-aware provider routing: Cloudflare, capped OpenRouter pool, and registered provider scenarios passed");
