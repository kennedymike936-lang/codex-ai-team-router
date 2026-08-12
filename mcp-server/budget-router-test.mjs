import assert from "node:assert/strict";
import {
  adapterForProvider,
  groqCapabilities,
  normalizeGroqModel,
  normalizeOpenRouterModel,
  parseRateLimitHeaders,
  redactHeaders,
  redactKeys,
} from "./provider-adapters.mjs";
import { createBudgetRouter, scoreCandidate } from "./budget-router.mjs";

const OPENROUTER_TEST_KEY = "openrouter-test-value";
const GROQ_TEST_KEY = "groq-test-value";

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
assert.equal(redactKeys(`failure ${OPENROUTER_TEST_KEY}`, [OPENROUTER_TEST_KEY]), "failure ***REDACTED***");
assert.deepEqual(redactHeaders({ Authorization: "Bearer hidden", Accept: "json" }), { Authorization: "***REDACTED***", Accept: "json" });

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

{
  let request;
  const adapter = adapterForProvider("openrouter", async (url, options) => {
    request = { url, options };
    return response(200, { data: [{ id: "vendor/free", pricing: { prompt: "0", completion: "0" } }] });
  });
  const credential = OPENROUTER_TEST_KEY;
  const models = await adapter.discoverModels({ baseUrl: "https://router.invalid/v1/", apiKey: credential });
  assert.equal(request.url, "https://router.invalid/v1/models");
  assert.equal(request.options.headers.authorization, `Bearer ${OPENROUTER_TEST_KEY}`);
  assert.equal(models[0].is_free, true);
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
    apiKeys: { openrouter: OPENROUTER_TEST_KEY },
    fetchImpl: async () => { fetchCalls += 1; throw new Error("must not run"); },
    messages: [{ role: "user", content: "test" }],
    dry_run: true,
  });
  assert.equal(fetchCalls, 0);
  assert.equal(outcome.dry_run, true);
  assert.equal(outcome.explanation.selected.id, "vendor/free");
}

{
  let requestedUrl;
  const execution = await router.execute({
    candidates: [free],
    mode: "free_only",
    providers: ["openrouter"],
    apiKeys: { openrouter: OPENROUTER_TEST_KEY },
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
    apiKeys: { openrouter: OPENROUTER_TEST_KEY },
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
    apiKeys: { groq: GROQ_TEST_KEY },
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
    apiKeys: { openrouter: OPENROUTER_TEST_KEY },
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
    apiKeys: { openrouter: OPENROUTER_TEST_KEY },
    fetchImpl: async () => { calls += 1; throw new Error(`socket failed ${OPENROUTER_TEST_KEY}`); },
    messages: [{ role: "user", content: "test" }],
    dry_run: false,
  });
  assert.equal(calls, 1);
  assert.equal(execution.error.includes(OPENROUTER_TEST_KEY), false);
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
    apiKeys: { openrouter: OPENROUTER_TEST_KEY },
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
    apiKeys: { openrouter: OPENROUTER_TEST_KEY },
    fetchImpl: async () => (++calls === 1 ? response(429, { error: "limited" }) : response(200, successBody())),
    messages: [{ role: "user", content: "test" }],
    dry_run: false,
  });
  const reroute = persistent.route({ candidates: [first, second], mode: "free_only" });
  assert.equal(reroute.selected.id, "health-b");
  assert.equal(persistent.runtimeState["openrouter:health-a"].updated_at, 123);
}

console.log("Budget-aware provider routing: 39 offline scenarios passed");
