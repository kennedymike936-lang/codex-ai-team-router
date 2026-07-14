import { appendFile, mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { estimateCostCny } from "./model-selector.mjs";

export function ledgerPath() {
  return process.env.AI_TEAM_USAGE_LEDGER || join(homedir(), ".codex-ai-team", "usage", "usage.jsonl");
}

export function usageEvent({
  provider,
  model,
  budget,
  usage = {},
  latencyMs,
  fallbackCount = 0,
  success = true,
  error = "",
  actualCostUsdTicks = null,
  serverSideToolsUsed = null,
  citations = [],
}) {
  const normalizedUsage = {
    input_tokens: Number(usage.input_tokens || 0),
    output_tokens: Number(usage.output_tokens || 0),
    cache_read_tokens: Number(usage.cache_read_tokens || 0),
  };
  const event = {
    schema_version: "1.0",
    timestamp: new Date().toISOString(),
    provider,
    model,
    budget,
    success,
    fallback_count: fallbackCount,
    latency_ms: Math.max(0, Math.round(Number(latencyMs || 0))),
    usage: normalizedUsage,
    estimated_cost_cny: estimateCostCny(provider, model, normalizedUsage),
    error: String(error || "").slice(0, 240),
  };
  if (actualCostUsdTicks != null && Number.isFinite(Number(actualCostUsdTicks))) {
    event.actual_cost_usd_ticks = Number(actualCostUsdTicks);
    event.actual_cost_usd = Number((Number(actualCostUsdTicks) / 10_000_000_000).toFixed(10));
  }
  if (serverSideToolsUsed != null && Number.isFinite(Number(serverSideToolsUsed))) {
    event.server_side_tools_used = Math.max(0, Math.round(Number(serverSideToolsUsed)));
  }
  if (Array.isArray(citations) && citations.length > 0) {
    event.citations = citations.slice(0, 20);
  }
  return event;
}

export async function recordUsage(event, path = ledgerPath()) {
  try {
    await mkdir(dirname(path), { recursive: true });
    await appendFile(path, `${JSON.stringify(event)}\n`, "utf8");
    return path;
  } catch {
    return "";
  }
}

export function usageSummary(event) {
  const cost = event.actual_cost_usd != null
    ? `USD ${event.actual_cost_usd.toFixed(6)} actual`
    : event.estimated_cost_cny == null
      ? "price unavailable"
      : `~CNY ${event.estimated_cost_cny.toFixed(6)}`;
  return `${event.model}; ${event.usage.input_tokens} in / ${event.usage.output_tokens} out; ${cost}`;
}
