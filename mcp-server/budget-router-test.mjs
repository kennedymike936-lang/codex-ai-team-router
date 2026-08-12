import assert from "node:assert/strict";
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
  parseRateLimitHeaders,
  registeredProviders,
  redactHeaders,
  redactKeys,
} from "./provider-adapters.mjs";
import { createBudgetRouter, scoreCandidate } from "./budget-router.mjs";

const OPENROUTER_TEST_CREDENTIAL = "openrouter-test-value";
const GROQ_TEST_CREDENTIAL = "groq-test-value";
const GEMINI_TEST_CREDENTIAL = "gemini-test-value";

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
assert.deepEqual(redactHeaders({ Authorization: "Bearer hidden", Accept: "json" }), { Authorization: "***REDACTED***", Accept: "json" });
assert.deepEqual(redactHeaders({ "x-goog-api-key": "hidden" }), { "x-goog-api-key": "***REDACTED***" });

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
assert.deepEqual(registeredProviders(), ["gemini", "groq", "openai", "openai_compatible", "openrouter"]);
assert.throws(() => adapterForProvider("unknown", async () => {}), /Supported: gemini, groq, openai, openai_compatible, openrouter/);

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

const context = router.route({ candidates: [free], mode: "balanced", requirements: { min_context_length: 100_000 } });
assert.equal(context.selected, null);
assert.equal(context.excluded[0].reasons[0], "context_too_short:64000<100000");

const scored = router.route({ candidates: [free, paid], mode: "quality_first", requirements: { capabilities: ["code"] } });
assert.equal(scored.selected.id, "vendor/paid");
assert.equal(typeof scored.selected.score, "number");
assert.equal(typeof scored.selected.score_components.quality, "number");
assert.ok(scoreCandidate({ ...free, health: "unhealthy" }, "balanced").total < scoreCandidate({ ...free, health: "healthy" }, "balanced").total);

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
  assert.equal(execution.attempts[0].retry_after, "9");
  assert.equal(execution.attempts[0].health.remaining_requests, 0);
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

console.log("Budget-aware provider routing: registered OpenRouter, Groq, Gemini, OpenAI Responses, and generic OpenAI-compatible scenarios passed");
