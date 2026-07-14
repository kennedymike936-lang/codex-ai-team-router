import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ModelSelector, estimateCostCny, isModelUnavailable, modelsEndpoint, rankValueModels } from "./model-selector.mjs";
import { recordUsage, usageEvent } from "./usage-ledger.mjs";

let fetchCount = 0;
const fetchImpl = async (url) => {
  fetchCount += 1;
  const ids = url.includes("deepseek")
    ? ["deepseek-v4-flash", "deepseek-v4-pro"]
    : ["qwen3.6-flash", "qwen3.7-plus"];
  return { ok: true, json: async () => ({ data: ids.map((id) => ({ id })) }) };
};
const selector = new ModelSelector({ fetchImpl, ttlMs: 1000, now: () => 100 });

assert.deepEqual(await selector.candidates({ provider: "qwen", budget: "low", baseUrl: "https://qwen/v1", apiKey: "hidden" }), ["qwen3.6-flash", "qwen3.7-plus"]);
assert.deepEqual(await selector.candidates({ provider: "qwen", budget: "normal", baseUrl: "https://qwen/v1", apiKey: "hidden" }), ["qwen3.7-plus", "qwen3.6-flash"]);
assert.equal(fetchCount, 1, "model discovery should be cached");
assert.deepEqual(await selector.candidates({ provider: "deepseek", budget: "deep", baseUrl: "https://api.deepseek.com/anthropic", apiKey: "hidden" }), ["deepseek-v4-pro", "deepseek-v4-flash"]);
assert.deepEqual(await selector.candidates({ provider: "qwen", budget: "low", configuredModel: "custom", mode: "fixed", baseUrl: "x", apiKey: "hidden" }), ["custom"]);
assert.equal(modelsEndpoint("deepseek", "https://api.deepseek.com/anthropic"), "https://api.deepseek.com/models");
assert.equal(isModelUnavailable(404, "model not found"), true);
assert.equal(isModelUnavailable(429, "model unavailable"), false);
assert.equal(estimateCostCny("deepseek", "deepseek-v4-flash", { input_tokens: 1_000_000, output_tokens: 1_000_000 }), 3);
assert.deepEqual(
  rankValueModels("qwen", "normal", ["qwen3.7-plus", "qwen3.8-plus", "qwen3.8-flash", "qwen3.8-plus-2027-01-01"]),
  ["qwen3.8-plus", "qwen3.8-flash"],
);
assert.deepEqual(
  rankValueModels("deepseek", "low", ["deepseek-v4-flash", "deepseek-v5-pro", "deepseek-v5-flash"]),
  ["deepseek-v5-flash", "deepseek-v5-pro"],
);

const dir = await mkdtemp(join(tmpdir(), "ai-team-ledger-"));
try {
  const path = join(dir, "usage.jsonl");
  const event = usageEvent({ provider: "qwen", model: "qwen3.6-flash", budget: "low", usage: { input_tokens: 100, output_tokens: 20 }, latencyMs: 12 });
  await recordUsage(event, path);
  const saved = JSON.parse((await readFile(path, "utf8")).trim());
  assert.equal(saved.model, "qwen3.6-flash");
  assert.equal(saved.usage.input_tokens, 100);
} finally {
  await rm(dir, { recursive: true, force: true });
}

{
  const event = usageEvent({
    provider: "xai",
    model: "grok-4.20-0309-non-reasoning",
    budget: "low",
    usage: { input_tokens: 100, output_tokens: 20 },
    latencyMs: 12,
    actualCostUsdTicks: 87840500,
    serverSideToolsUsed: 1,
    citations: ["https://x.com/xai/status/1"],
  });
  assert.equal(event.actual_cost_usd, 0.00878405);
  assert.equal(event.server_side_tools_used, 1);
  assert.deepEqual(event.citations, ["https://x.com/xai/status/1"]);
}

console.log("Model selector and ledger: 13 scenarios passed");
