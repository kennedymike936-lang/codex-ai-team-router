import assert from "node:assert/strict";
import {
  XaiSearchClient,
  XaiSearchModelSelector,
  extractXaiCitations,
  rankXaiSearchModels,
} from "./xai-search.mjs";

const models = [
  {
    id: "grok-build-0.1",
    created: 3,
    input_modalities: ["text", "image"],
    output_modalities: ["text"],
    prompt_text_token_price: 10000,
    completion_text_token_price: 20000,
  },
  {
    id: "grok-4.20-0309-non-reasoning",
    created: 2,
    input_modalities: ["text", "image"],
    output_modalities: ["text"],
    prompt_text_token_price: 12500,
    completion_text_token_price: 25000,
  },
  {
    id: "grok-4.3",
    created: 4,
    input_modalities: ["text", "image"],
    output_modalities: ["text"],
    prompt_text_token_price: 12500,
    completion_text_token_price: 25000,
  },
  {
    id: "grok-4.20-0309-reasoning",
    input_modalities: ["text"],
    output_modalities: ["text"],
    prompt_text_token_price: 1,
    completion_text_token_price: 1,
  },
];

assert.deepEqual(rankXaiSearchModels(models), [
  "grok-4.20-0309-non-reasoning",
  "grok-4.3",
  "grok-build-0.1",
]);

let discoveryCalls = 0;
const selector = new XaiSearchModelSelector({
  now: () => 100,
  fetchImpl: async () => {
    discoveryCalls += 1;
    return new Response(JSON.stringify({ models }), { status: 200 });
  },
});
assert.deepEqual(await selector.candidates({ baseUrl: "https://api.x.ai/v1", apiKey: "test" }), [
  "grok-4.20-0309-non-reasoning",
  "grok-4.3",
  "grok-build-0.1",
]);
await selector.candidates({ baseUrl: "https://api.x.ai/v1", apiKey: "test" });
assert.equal(discoveryCalls, 1);

const successJson = {
  model: "grok-4.20-0309-non-reasoning",
  output: [{
    type: "message",
    content: [{
      type: "output_text",
      text: "Current finding https://x.com/xai/status/1",
      annotations: [{ type: "url_citation", url: "https://x.com/xai/status/1" }],
    }],
  }],
  usage: {
    input_tokens: 4247,
    output_tokens: 89,
    total_tokens: 4336,
    num_server_side_tools_used: 1,
    cost_in_usd_ticks: 87840500,
  },
};

let capturedBody;
let savedEvent;
const client = new XaiSearchClient({
  selector: { candidates: async () => ["grok-4.20-0309-non-reasoning"] },
  fetchImpl: async (_url, options) => {
    capturedBody = JSON.parse(options.body);
    return new Response(JSON.stringify(successJson), { status: 200 });
  },
  recordUsageImpl: async (event) => { savedEvent = event; },
});

const response = await client.search({
  query: "latest update",
  source: "x",
  allowedXHandles: ["@xai"],
  apiKey: "test",
  baseUrl: "https://api.x.ai/v1",
  budget: "low",
});
assert.equal(capturedBody.max_turns, 1);
assert.equal(capturedBody.parallel_tool_calls, false);
assert.equal(capturedBody.tool_choice, "required");
assert.equal(capturedBody.store, false);
assert.deepEqual(capturedBody.tools, [{ type: "x_search", allowed_x_handles: ["xai"] }]);
assert.equal(response.text, "Current finding https://x.com/xai/status/1");
assert.deepEqual(response.citations, ["https://x.com/xai/status/1"]);
assert.equal(savedEvent.actual_cost_usd, 0.00878405);
assert.equal(savedEvent.server_side_tools_used, 1);

let requestCount = 0;
const fallbackClient = new XaiSearchClient({
  selector: { candidates: async () => ["cheap-unsupported", "supported"] },
  fetchImpl: async () => {
    requestCount += 1;
    if (requestCount === 1) {
      return new Response(JSON.stringify({ error: "x_search is not supported for this model" }), { status: 400 });
    }
    return new Response(JSON.stringify(successJson), { status: 200 });
  },
  recordUsageImpl: async () => {},
});
const fallback = await fallbackClient.search({ query: "latest", apiKey: "test" });
assert.equal(requestCount, 2);
assert.equal(fallback.event.fallback_count, 1);

assert.deepEqual(extractXaiCitations({ citations: ["https://example.com/a"] }, ""), ["https://example.com/a"]);
console.log("xAI search selector and client: 10 scenarios passed");
