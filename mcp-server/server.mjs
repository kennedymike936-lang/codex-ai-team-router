import { execFileSync } from "node:child_process";
import { statSync } from "node:fs";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { evaluateWorkerResult } from "./quality-policy.mjs";
import { isModelUnavailable, modelSelector } from "./model-selector.mjs";
import { compactProjectTaskResult, previewProjectTask, runProjectTask } from "./project-task.mjs";
import { planTaskTeam } from "./team-planner.mjs";
import { recordUsage, usageEvent, usageSummary } from "./usage-ledger.mjs";
import { xaiSearchClient } from "./xai-search.mjs";
import { writeRouteDecision } from "./audit-artifacts.mjs";
import { createBudgetRouter } from "./budget-router.mjs";
import { isNetworkRequestError, resilientFetch } from "./network-client.mjs";
import { runDoctor } from "./doctor.mjs";
import { mergeBuiltinModelMetadata } from "./autonomy-policy.mjs";
import { runRoutineWorkpack } from "./routine-workpack.mjs";
import { createFabricStateStore } from "./fabric-state.mjs";
import { createMissionControl } from "./mission-control.mjs";

const SERVER_NAME = "ai-cluster-mcp-server";
const SERVER_VERSION = "1.0.1";
const SERVER_BUILD_ID = "20260824-groq-proxy-first-r2";
const SERVER_RUNTIME_IDENTITY = Object.freeze({
  server_name: SERVER_NAME,
  version: SERVER_VERSION,
  build_id: SERVER_BUILD_ID,
  pid: process.pid,
  started_at: new Date(Date.now() - process.uptime() * 1000).toISOString(),
  source_mtime_at_start: statSync(new URL(import.meta.url)).mtime.toISOString(),
  script_path: process.argv[1] || null,
});

const DEFAULT_CHECKLIST = [
  "code can run/build",
  "tests pass",
  "type check passes",
  "lint passes",
  "no forbidden files changed",
  "diff is not too large",
  "no unjustified new dependency",
  "no API key or secret touched",
];

function readWindowsUserEnv(name) {
  try {
    const output = execFileSync(
      "powershell.exe",
      [
        "-NoProfile",
        "-Command",
        `[Environment]::GetEnvironmentVariable('${name}', 'User')`,
      ],
      { encoding: "utf8", timeout: 3000, windowsHide: true },
    );
    return output.trim();
  } catch {
    return "";
  }
}

function readUserEnv(name) {
  if (process.env[name]) return process.env[name];
  return readWindowsUserEnv(name);
}

function readFreshUserEnv(name) {
  return readWindowsUserEnv(name) || process.env[name] || "";
}

function qwenConfig() {
  const apiKey =
    readUserEnv("DASHSCOPE_API_KEY") ||
    readUserEnv("OPENAI_API_KEY") ||
    readUserEnv("QWEN_API_KEY");
  if (!apiKey) throw new Error("Qwen API key is not configured.");
  return {
    apiKey,
    baseUrl:
      process.env.QWEN_MCP_BASE_URL ||
      process.env.OPENAI_BASE_URL ||
      "https://dashscope.aliyuncs.com/compatible-mode/v1",
    configuredModel:
      process.env.QWEN_MCP_MODEL ||
      process.env.AI_TEAM_QWEN_MODEL ||
      "qwen3.7-plus",
    mode: process.env.AI_TEAM_MODEL_MODE === "fixed" ? "fixed" : "auto",
  };
}

function deepSeekConfig() {
  const apiKey =
    readUserEnv("ANTHROPIC_API_KEY") ||
    readUserEnv("ANTHROPIC_AUTH_TOKEN") ||
    readUserEnv("DEEPSEEK_API_KEY");
  if (!apiKey) throw new Error("DeepSeek API key is not configured.");
  return {
    apiKey,
    baseUrl:
      process.env.DEEPSEEK_MCP_BASE_URL ||
      process.env.ANTHROPIC_BASE_URL ||
      "https://api.deepseek.com/anthropic",
    configuredModel:
      process.env.DEEPSEEK_MCP_MODEL ||
      process.env.ANTHROPIC_MODEL ||
      "deepseek-v4-pro",
    mode: process.env.AI_TEAM_MODEL_MODE === "fixed" ? "fixed" : "auto",
  };
}

function xaiConfig() {
  const apiKey = readUserEnv("XAI_API_KEY");
  if (!apiKey) throw new Error("XAI_API_KEY is not configured.");
  return {
    apiKey,
    baseUrl: process.env.XAI_MCP_BASE_URL || "https://api.x.ai/v1",
    configuredModel: process.env.XAI_SEARCH_MODEL || "grok-4.20-0309-non-reasoning",
    mode:
      process.env.XAI_MODEL_MODE === "fixed" || process.env.AI_TEAM_MODEL_MODE === "fixed"
        ? "fixed"
        : "auto",
  };
}

function openRouterConfig() {
  return {
    apiKey: readUserEnv("OPENROUTER_API_KEY"),
    baseUrl: process.env.OPENROUTER_MCP_BASE_URL || "https://openrouter.ai/api/v1",
  };
}

function groqConfig() {
  return {
    // Prefer the current user-scoped value so key rotation works even when
    // Codex hot-reloads MCP servers without refreshing its parent environment.
    apiKey: readFreshUserEnv("GROQ_API_KEY"),
    baseUrl: process.env.GROQ_BASE_URL || process.env.GROQ_MCP_BASE_URL || "https://api.groq.com/openai/v1",
  };
}

function zhipuConfig() {
  return {
    apiKey: readUserEnv("ZHIPU_API_KEY"),
    baseUrl: process.env.ZHIPU_BASE_URL || process.env.ZHIPU_MCP_BASE_URL || "https://open.bigmodel.cn/api/paas/v4",
  };
}

function modelScopeConfig() {
  return {
    apiKey: readUserEnv("MODELSCOPE_API_KEY"),
    baseUrl: process.env.MODELSCOPE_BASE_URL || process.env.MODELSCOPE_MCP_BASE_URL || "https://api-inference.modelscope.cn/v1",
  };
}

function nvidiaConfig() {
  return {
    apiKey: readUserEnv("NVIDIA_API_KEY") || readUserEnv("NVIDIA_NIM_API_KEY"),
    baseUrl: process.env.NVIDIA_BASE_URL || process.env.NVIDIA_MCP_BASE_URL || "https://integrate.api.nvidia.com/v1",
  };
}

function mistralConfig() {
  return {
    apiKey: readUserEnv("MISTRAL_API_KEY"),
    baseUrl: process.env.MISTRAL_BASE_URL || process.env.MISTRAL_MCP_BASE_URL || "https://api.mistral.ai/v1",
  };
}

function cloudflareConfig() {
  const accountId = readUserEnv("CLOUDFLARE_ACCOUNT_ID");
  return {
    apiKey: readUserEnv("CLOUDFLARE_API_TOKEN") || readUserEnv("CLOUDFLARE_AUTH_TOKEN"),
    accountId,
    baseUrl: accountId
      ? `https://api.cloudflare.com/client/v4/accounts/${accountId}/ai/v1`
      : "",
  };
}

function geminiConfig() {
  return {
    apiKey: readUserEnv("GEMINI_API_KEY") || readUserEnv("GOOGLE_API_KEY"),
    baseUrl: process.env.GEMINI_MCP_BASE_URL || "https://generativelanguage.googleapis.com/v1beta",
  };
}

function siliconFlowConfig() {
  return {
    apiKey: readUserEnv("SILICONFLOW_API_KEY"),
    baseUrl: process.env.SILICONFLOW_MCP_BASE_URL || "https://api.siliconflow.cn/v1",
  };
}

function openAiCompatibleConfig() {
  return {
    apiKey: readUserEnv("OPENAI_COMPATIBLE_API_KEY"),
    // Administrator-controlled only. Tool callers cannot supply arbitrary URLs.
    baseUrl: process.env.OPENAI_COMPATIBLE_BASE_URL || "",
  };
}

function openAiResponsesConfig() {
  return {
    apiKey: readUserEnv("OPENAI_API_KEY"),
    baseUrl: process.env.OPENAI_MCP_BASE_URL || "https://api.openai.com/v1",
  };
}

function budgetRouterMetadata() {
  const value = process.env.AI_TEAM_MODEL_METADATA_JSON;
  if (!value) return mergeBuiltinModelMetadata();
  try {
    const parsed = JSON.parse(value);
    return mergeBuiltinModelMetadata(
      parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {},
    );
  } catch {
    throw new Error("AI_TEAM_MODEL_METADATA_JSON must be a valid JSON object.");
  }
}

function positiveEnvInteger(name, fallback) {
  const value = Number(process.env[name]);
  return Number.isInteger(value) && value > 0 ? value : fallback;
}

function missionModelRoster(modelMetadata) {
  const qwenReady = Boolean(readUserEnv("DASHSCOPE_API_KEY") || readUserEnv("QWEN_API_KEY"));
  const deepSeekReady = Boolean(readUserEnv("ANTHROPIC_API_KEY") || readUserEnv("ANTHROPIC_AUTH_TOKEN") || readUserEnv("DEEPSEEK_API_KEY"));
  const grokReady = Boolean(readUserEnv("XAI_API_KEY"));
  const providerReady = {
    openrouter: Boolean(openRouterConfig().apiKey),
    groq: Boolean(groqConfig().apiKey),
    zhipu: Boolean(zhipuConfig().apiKey),
    modelscope: Boolean(modelScopeConfig().apiKey),
    nvidia: Boolean(nvidiaConfig().apiKey),
    mistral: Boolean(mistralConfig().apiKey),
    cloudflare: Boolean(cloudflareConfig().apiKey && cloudflareConfig().accountId),
    gemini: Boolean(geminiConfig().apiKey),
    siliconflow: Boolean(siliconFlowConfig().apiKey),
    openai: Boolean(openAiResponsesConfig().apiKey),
  };
  const workers = [
    { provider: "qwen", model: process.env.AI_TEAM_QWEN_MODEL || "qwen3.7-plus", tier: "primary worker", quota_label: "free-first", status: qwenReady ? "ready" : "offline" },
    { provider: "deepseek", model: process.env.DEEPSEEK_MCP_MODEL || "deepseek-v4-pro", tier: "paid", quota_label: "paid · manual only", status: deepSeekReady ? "manual" : "offline" },
    { provider: "grok", model: process.env.XAI_SEARCH_MODEL || "grok search", tier: "live research", quota_label: "live scout · manual/needed", status: grokReady ? "manual" : "offline" },
  ];
  const pool = Object.entries(modelMetadata).map(([key, metadata]) => {
    const separator = key.indexOf(":");
    const provider = separator > 0 ? key.slice(0, separator) : "unknown";
    const model = separator > 0 ? key.slice(separator + 1) : key;
    const ready = providerReady[provider] === true;
    const status = !ready
      ? "offline"
      : metadata.is_free === true
        ? "free"
        : String(metadata.quota_kind || "").includes("promotional")
          ? "credit"
          : "ready";
    const quotaLabel = Number.isFinite(metadata.daily_request_limit)
      ? `${metadata.daily_request_limit}/day local cap`
      : Number.isFinite(metadata.daily_neuron_limit)
        ? `${metadata.daily_neuron_limit.toLocaleString("en-US")} neurons/day shared`
        : metadata.is_free === true
          ? "free allocation"
          : String(metadata.quota_kind || "account quota").replaceAll("_", " ");
    return {
      provider,
      model,
      tier: metadata.is_free === true ? "free" : "account",
      quota_label: quotaLabel,
      status,
      ...(Number.isFinite(metadata.daily_request_limit) ? { daily_request_limit: metadata.daily_request_limit } : {}),
      ...(Number.isFinite(metadata.daily_neuron_limit) ? { daily_neuron_limit: metadata.daily_neuron_limit } : {}),
    };
  });
  return [...workers, ...pool].sort((a, b) => {
    const workerRank = ["qwen", "deepseek", "grok"];
    const ar = workerRank.indexOf(a.provider);
    const br = workerRank.indexOf(b.provider);
    if (ar >= 0 || br >= 0) return (ar < 0 ? 99 : ar) - (br < 0 ? 99 : br);
    return String(a.provider).localeCompare(String(b.provider)) || String(a.model).localeCompare(String(b.model));
  });
}

const fabricStateStore = await createFabricStateStore({
  persistent: process.env.AI_TEAM_FABRIC_STATE !== "memory",
  ...(process.env.AI_TEAM_FABRIC_DB_PATH ? { path: process.env.AI_TEAM_FABRIC_DB_PATH } : {}),
});

const configuredMissionPort = Number(process.env.AI_TEAM_MISSION_CONTROL_PORT || 0);
const modelMetadata = budgetRouterMetadata();
const missionControl = createMissionControl({
  stateStore: fabricStateStore,
  roster: missionModelRoster(modelMetadata),
  host: "127.0.0.1",
  port: Number.isInteger(configuredMissionPort) && configuredMissionPort >= 0 ? configuredMissionPort : 0,
});

const budgetRouter = createBudgetRouter({
  healthPersistence: true,
  allowOpenRouterFreeFallback: process.env.AI_TEAM_OPENROUTER_FREE_FALLBACK === "true",
  modelMetadata,
  stateStore: fabricStateStore,
  runtimeOptions: {
    maxConcurrency: positiveEnvInteger("AI_TEAM_PROVIDER_MAX_CONCURRENCY", 2),
    maxQueue: positiveEnvInteger("AI_TEAM_PROVIDER_MAX_QUEUE", 32),
    timeoutMs: positiveEnvInteger("AI_TEAM_PROVIDER_TIMEOUT_MS", 60_000),
    failureThreshold: positiveEnvInteger("AI_TEAM_PROVIDER_FAILURE_THRESHOLD", 3),
    cooldownMs: positiveEnvInteger("AI_TEAM_PROVIDER_COOLDOWN_MS", 30_000),
  },
});

function maxTokensForBudget(budget = "low") {
  if (budget === "deep") return 3800;
  if (budget === "normal") return 2000;
  return 900;
}

function searchTokensForBudget(budget = "low") {
  if (budget === "deep") return 800;
  if (budget === "normal") return 550;
  return 350;
}

function baseSystem(worker) {
  return [
    `You are the ${worker} background worker for Codex.`,
    "Codex is the project manager, architect, scheduler, and final reviewer.",
    "Your output is for Codex, not the end user.",
    "Be terse, concrete, and operational.",
    "Return conclusions and artifacts, not a chronological work log.",
    "Keep the final response under 500 words unless the requested schema requires more.",
    "Do not ask follow-up questions unless the task is impossible.",
    "Never expose, request, or invent API keys or secrets.",
  ].join("\n");
}

function schemaNote(outputSchema) {
  if (!outputSchema) return "";
  return `\nReturn output matching this schema or shape:\n${outputSchema}`;
}

function openAiUsage(usage = {}) {
  return {
    input_tokens: usage.prompt_tokens || usage.input_tokens || 0,
    output_tokens: usage.completion_tokens || usage.output_tokens || 0,
    cache_read_tokens: usage.prompt_tokens_details?.cached_tokens || 0,
  };
}

function anthropicUsage(usage = {}) {
  return {
    input_tokens: usage.input_tokens || 0,
    output_tokens: usage.output_tokens || 0,
    cache_read_tokens: usage.cache_read_input_tokens || 0,
  };
}

async function callQwen({ task, context, outputSchema, maxTokens, budget }) {
  const { apiKey, baseUrl, configuredModel, mode } = qwenConfig();
  const url = `${baseUrl.replace(/\/$/, "")}/chat/completions`;
  const models = await modelSelector.candidates({
    provider: "qwen", budget, configuredModel, mode, baseUrl, apiKey,
  });
  let lastError = "";

  for (let index = 0; index < models.length; index += 1) {
    const model = models[index];
    const started = Date.now();
    const body = {
      model,
      messages: [
        { role: "system", content: baseSystem("Qwen") },
        {
          role: "user",
          content: [
            `Task:\n${task}`,
            context ? `Context:\n${context}` : "",
            schemaNote(outputSchema),
          ].filter(Boolean).join("\n\n"),
        },
      ],
      temperature: 0.2,
      max_tokens: maxTokens,
      stream: false,
    };
    const response = await resilientFetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
      body: JSON.stringify(body),
    });
    const text = await response.text();
    if (response.ok) {
      const json = JSON.parse(text);
      const event = usageEvent({
        provider: "qwen", model, budget, usage: openAiUsage(json.usage),
        latencyMs: Date.now() - started, fallbackCount: index,
      });
      await recordUsage(event);
      return { text: json.choices?.[0]?.message?.content || text, event };
    }
    lastError = `Qwen ${response.status} ${response.statusText}: ${text.slice(0, 800)}`;
    if (index + 1 < models.length && isModelUnavailable(response.status, text)) continue;
    const event = usageEvent({
      provider: "qwen", model, budget, latencyMs: Date.now() - started,
      fallbackCount: index, success: false, error: lastError,
    });
    await recordUsage(event);
    throw new Error(lastError);
  }
  throw new Error(lastError || "Qwen request failed: no value-tier model is available.");
}

function anthropicText(content) {
  if (!Array.isArray(content)) return "";
  return content.map((part) => (typeof part?.text === "string" ? part.text : "")).filter(Boolean).join("\n");
}

async function callDeepSeek({ task, context, outputSchema, maxTokens, budget }) {
  const { apiKey, baseUrl, configuredModel, mode } = deepSeekConfig();
  const url = `${baseUrl.replace(/\/$/, "")}/v1/messages`;
  const models = await modelSelector.candidates({
    provider: "deepseek", budget, configuredModel, mode, baseUrl, apiKey,
  });

  const headerSets = [
    {
      "content-type": "application/json",
      "anthropic-version": "2023-06-01",
      "x-api-key": apiKey,
    },
    {
      "content-type": "application/json",
      "anthropic-version": "2023-06-01",
      authorization: `Bearer ${apiKey}`,
    },
  ];

  let lastError = "";
  for (let index = 0; index < models.length; index += 1) {
    const model = models[index];
    const started = Date.now();
    const body = {
      model,
      max_tokens: maxTokens,
      temperature: 0.2,
      system: baseSystem("DeepSeek"),
      messages: [{
        role: "user",
        content: [
          `Task:\n${task}`,
          context ? `Context:\n${context}` : "",
          schemaNote(outputSchema),
        ].filter(Boolean).join("\n\n"),
      }],
    };
    let unavailable = false;
    for (let headerIndex = 0; headerIndex < headerSets.length; headerIndex += 1) {
      const response = await resilientFetch(url, {
        method: "POST", headers: headerSets[headerIndex], body: JSON.stringify(body),
      });
      const text = await response.text();
      if (response.ok) {
        const json = JSON.parse(text);
        const event = usageEvent({
          provider: "deepseek", model, budget, usage: anthropicUsage(json.usage),
          latencyMs: Date.now() - started, fallbackCount: index,
        });
        await recordUsage(event);
        return { text: anthropicText(json.content) || text, event };
      }
      lastError = `DeepSeek ${response.status} ${response.statusText}: ${text.slice(0, 800)}`;
      unavailable = isModelUnavailable(response.status, text);
      if (response.status === 401 && headerIndex + 1 < headerSets.length) continue;
      break;
    }
    if (index + 1 < models.length && unavailable) continue;
    const event = usageEvent({
      provider: "deepseek", model, budget, latencyMs: Date.now() - started,
      fallbackCount: index, success: false, error: lastError,
    });
    await recordUsage(event);
    throw new Error(lastError);
  }
  throw new Error(lastError || "DeepSeek request failed.");
}

async function callGrokSearch({
  query,
  source = "x",
  allowedXHandles = [],
  fromDate = "",
  toDate = "",
  budget = "low",
}) {
  const { apiKey, baseUrl, configuredModel, mode } = xaiConfig();
  return xaiSearchClient.search({
    query,
    source,
    allowedXHandles,
    fromDate,
    toDate,
    maxOutputTokens: searchTokensForBudget(budget),
    budget,
    apiKey,
    baseUrl,
    configuredModel,
    mode,
  });
}

function routeTask({ task = "", context = "", preferred = "auto", maxAssistants = 3 }) {
  if (["qwen", "deepseek", "grok", "both"].includes(preferred)) return preferred;

  const allowDeepSeekAuto = String(readUserEnv("AI_TEAM_ALLOW_DEEPSEEK_AUTO") || "false").toLowerCase() === "true";

  const text = `${task}\n${context}`.toLowerCase();
  const team = planTaskTeam({ task, context, maxAssistants });
  const searchWords = [
    "x.com", "twitter", "search x", "x search", "posts on x", "latest posts",
    "web search", "search the web", "latest news", "current news", "social sentiment",
    "latest information", "latest update", "recent update", "breaking news", "official announcement",
    "推特", "x 上", "x平台", "最新帖子", "最新消息", "最新资讯", "近期动态", "实时消息",
    "最新版本", "最新价格", "官方公告", "今日新闻", "联网搜索", "网上查证",
  ];
  const codeWords = [
    "bug", "debug", "fix", "diff", "patch", "typescript", "javascript",
    "python", "powershell", "api", "test", "lint", "typecheck", "build",
    "代码", "脚本", "报错", "修复", "测试", "类型", "重构",
  ];
  const broadWords = [
    "summarize", "summary", "docs", "document", "整理", "总结", "文档",
    "清单", "计划", "方案", "提纲", "翻译", "润色",
  ];
  const hasCode = codeWords.some((word) => text.includes(word));
  const hasBroad = broadWords.some((word) => text.includes(word));
  const needsLiveSearch = team.complexity.needs_live_research || searchWords.some((word) => text.includes(word));

  if (needsLiveSearch && hasCode && team.use_grok) return allowDeepSeekAuto ? "team" : "qwen_grok";
  if (needsLiveSearch) return "grok";
  if (team.coding_assistants >= 2) return allowDeepSeekAuto ? "both" : "qwen";
  if (hasCode) return allowDeepSeekAuto ? "deepseek" : "qwen";
  if (hasBroad) return "qwen";
  return "qwen";
}

function searchSourceForText(text = "") {
  const value = String(text).toLowerCase();
  return /x\.com|twitter|search x|x search|posts? on x|social sentiment|推特|x 上|x平台|帖子|舆论|社区讨论/.test(value)
    ? "x"
    : "web";
}

function result(text) {
  return { content: [{ type: "text", text }] };
}

function compactText(text, maxChars = 5000) {
  const value = String(text || "").trim();
  if (value.length <= maxChars) return value;
  return `[truncated; full worker artifact should be used for details]\n${value.slice(0, maxChars)}`;
}

function formattedWorker(name, response, maxChars = 5000) {
  return `Model: ${response.event.model}\nUsage: ${usageSummary(response.event)}\n\n${compactText(response.text, maxChars)}`;
}

function formattedGrok(response, maxChars = 4500) {
  const toolCount = response.event.server_side_tools_used ?? 0;
  const sources = response.citations.length > 0
    ? `\n\nSources:\n${response.citations.map((url) => `- ${url}`).join("\n")}`
    : "";
  return `Model: ${response.event.model}\nUsage: ${usageSummary(response.event)}\nSearch calls: ${toolCount}\n\n${compactText(response.text, maxChars)}${sources}`;
}

function networkFailureResult(error, route = "grok") {
  const diagnostic = error.diagnostic || {};
  return {
    status: "network_unavailable",
    route,
    retryable: diagnostic.transient === true && diagnostic.delivery_uncertain !== true,
    fallback_recommended: true,
    diagnostic,
    message: error.message,
  };
}

function safeAssistantFailover(error) {
  return isNetworkRequestError(error) && error.diagnostic?.delivery_uncertain !== true;
}

async function delegate(args, { onEvent = null, taskId = `delegate-${Date.now()}` } = {}) {
  const preferred = args.preferred || "auto";
  const team = planTaskTeam({
    task: args.task,
    context: args.context,
    maxAssistants: args.max_assistants,
  });
  const route = routeTask({
    task: args.task || "",
    context: args.context || "",
    preferred,
    maxAssistants: args.max_assistants,
  });
  const maxTokens = maxTokensForBudget(args.budget || "low");
  const task = args.task || "";
  const context = args.context || "";
  const outputSchema = args.output_schema || "";
  const routingHeader = `Complexity: ${team.complexity.level} (${team.complexity.score})\nAssistants: ${team.assistant_count}\nRoute: ${route}`;
  const emit = async (event = {}) => {
    if (typeof onEvent !== "function") return;
    try { await onEvent({ task_id: taskId, ...event }); } catch {}
  };
  const observed = async (actor, operation) => {
    await emit({ type: "agent.started", actor, title: `Codex requested input from ${actor}`, detail: `Model-only route: ${route}`, status: "running" });
    try {
      const value = await operation();
      await emit({ type: "agent.proposal", actor, title: `${actor} submitted a specialist opinion`, detail: "Structured response received by Codex.", status: "success" });
      return value;
    } catch (error) {
      await emit({ type: "agent.completed", actor, title: `${actor} could not complete the request`, detail: "Codex will evaluate fallback options.", status: "failed" });
      throw error;
    }
  };

  if (args.dry_run === true) {
    return routingHeader;
  }
  await emit({ type: "leader.delegated", actor: "codex", title: "Codex convened the AI team", detail: `Route: ${route} · assistants: ${team.assistant_count}`, status: "running" });

  if (route === "qwen") {
    try {
      const qwen = await observed("qwen", () => callQwen({ task, context, outputSchema, maxTokens, budget: args.budget || "low" }));
      return `${routingHeader}\n\n## Qwen\n${formattedWorker("Qwen", qwen)}`;
    } catch (error) {
      const allowPaidFallback = args.allow_paid_fallback === true || String(readUserEnv("AI_TEAM_ALLOW_DEEPSEEK_AUTO") || "false").toLowerCase() === "true";
      if (!allowPaidFallback || !safeAssistantFailover(error)) throw error;
      await emit({ type: "provider.failover", actor: "codex", title: "Codex switched specialist", detail: "qwen → deepseek", status: "warning" });
      const deepseek = await observed("deepseek", () => callDeepSeek({ task, context, outputSchema, maxTokens, budget: args.budget || "low" }));
      return `${routingHeader}\nFailover: qwen -> deepseek (${error.diagnostic.category})\n\n## DeepSeek\n${formattedWorker("DeepSeek", deepseek)}`;
    }
  }
  if (route === "deepseek") {
    try {
      const deepseek = await observed("deepseek", () => callDeepSeek({ task, context, outputSchema, maxTokens, budget: args.budget || "low" }));
      return `${routingHeader}\n\n## DeepSeek\n${formattedWorker("DeepSeek", deepseek)}`;
    } catch (error) {
      if (!safeAssistantFailover(error)) throw error;
      await emit({ type: "provider.failover", actor: "codex", title: "Codex switched specialist", detail: "deepseek → qwen", status: "warning" });
      const qwen = await observed("qwen", () => callQwen({ task, context, outputSchema, maxTokens, budget: args.budget || "low" }));
      return `${routingHeader}\nFailover: deepseek -> qwen (${error.diagnostic.category})\n\n## Qwen\n${formattedWorker("Qwen", qwen)}`;
    }
  }
  if (route === "grok") {
    const source = searchSourceForText(`${task}\n${context}`);
    try {
      const grok = await observed("grok", () => callGrokSearch({
        query: [task, context ? `Context:\n${context}` : ""].filter(Boolean).join("\n\n"),
        source,
        budget: args.budget || "low",
      }));
      return `${routingHeader}\n\n## Grok Search\n${formattedGrok(grok)}`;
    } catch (error) {
      if (isNetworkRequestError(error)) {
        return `${routingHeader}\n\n${JSON.stringify(networkFailureResult(error), null, 2)}`;
      }
      throw error;
    }
  }

  if (route === "qwen_grok") {
    const source = searchSourceForText(`${task}\n${context}`);
    const [qwen, grok] = await Promise.allSettled([
      observed("qwen", () => callQwen({ task, context, outputSchema, maxTokens, budget: args.budget || "low" })),
      observed("grok", () => callGrokSearch({
        query: [task, context ? `Context:\n${context}` : ""].filter(Boolean).join("\n\n"),
        source,
        budget: args.budget || "low",
      })),
    ]);
    const qwenText = qwen.status === "fulfilled" ? formattedWorker("Qwen", qwen.value, 3000) : `FAILED: ${qwen.reason?.message || qwen.reason}`;
    const grokText = grok.status === "fulfilled" ? formattedGrok(grok.value, 2200) : `FAILED: ${grok.reason?.message || grok.reason}`;
    return `${routingHeader}\n\n## Qwen\n${qwenText}\n\n## Grok Search\n${grokText}`;
  }

  if (route === "team") {
    const source = searchSourceForText(`${task}\n${context}`);
    const [qwen, deepseek, grok] = await Promise.allSettled([
      observed("qwen", () => callQwen({ task, context, outputSchema, maxTokens, budget: args.budget || "low" })),
      observed("deepseek", () => callDeepSeek({ task, context, outputSchema, maxTokens, budget: args.budget || "low" })),
      observed("grok", () => callGrokSearch({
        query: [task, context ? `Context:\n${context}` : ""].filter(Boolean).join("\n\n"),
        source,
        budget: args.budget || "low",
      })),
    ]);
    const qwenText = qwen.status === "fulfilled" ? formattedWorker("Qwen", qwen.value, 2400) : `FAILED: ${qwen.reason?.message || qwen.reason}`;
    const deepSeekText = deepseek.status === "fulfilled" ? formattedWorker("DeepSeek", deepseek.value, 2400) : `FAILED: ${deepseek.reason?.message || deepseek.reason}`;
    const grokText = grok.status === "fulfilled" ? formattedGrok(grok.value, 1800) : `FAILED: ${grok.reason?.message || grok.reason}`;
    return `${routingHeader}\n\n## Qwen\n${qwenText}\n\n## DeepSeek\n${deepSeekText}\n\n## Grok Search\n${grokText}`;
  }

  const [qwen, deepseek] = await Promise.allSettled([
    observed("qwen", () => callQwen({ task, context, outputSchema, maxTokens, budget: args.budget || "low" })),
    observed("deepseek", () => callDeepSeek({ task, context, outputSchema, maxTokens, budget: args.budget || "low" })),
  ]);
  const qwenText = qwen.status === "fulfilled" ? formattedWorker("Qwen", qwen.value, 3000) : `FAILED: ${qwen.reason?.message || qwen.reason}`;
  const deepSeekText = deepseek.status === "fulfilled" ? formattedWorker("DeepSeek", deepseek.value, 3000) : `FAILED: ${deepseek.reason?.message || deepseek.reason}`;
  return `${routingHeader}\n\n## Qwen\n${qwenText}\n\n## DeepSeek\n${deepSeekText}`;
}

const tools = [
  {
    name: "delegate_task",
    description: "Automatically size a model-only team with Qwen as the free-first general worker and Grok as a read-only live research scout. DeepSeek is paid and is used only when explicitly selected or allow_paid_fallback is true. Set dry_run to preview without spending model tokens.",
    inputSchema: {
      type: "object",
      properties: {
        task: { type: "string" },
        context: { type: "string" },
        output_schema: { type: "string" },
        preferred: { type: "string", enum: ["auto", "qwen", "deepseek", "grok", "both"] },
        max_assistants: { type: "integer", minimum: 1, maximum: 3 },
        budget: { type: "string", enum: ["low", "normal", "deep"] },
        allow_paid_fallback: { type: "boolean", description: "Permit a Qwen failure to fall back to paid DeepSeek. Defaults to false." },
        dry_run: { type: "boolean" },
      },
      required: ["task"],
    },
  },
  {
    name: "grok_search",
    description: "Read-only low-cost live research using one xAI X Search or Web Search call. Returns citations and exact billed USD cost.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", minLength: 1 },
        source: { type: "string", enum: ["auto", "x", "web"] },
        allowed_x_handles: {
          type: "array",
          maxItems: 20,
          items: { type: "string" },
        },
        from_date: { type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}$" },
        to_date: { type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}$" },
        budget: { type: "string", enum: ["low", "normal", "deep"] },
        dry_run: { type: "boolean" },
      },
      required: ["query"],
    },
  },
  {
    name: "budget_route",
    description: "Free-tier-aware, capability-aware routing across registered providers including Cloudflare Workers AI and a locally capped 50-call OpenRouter free pool. dry_run defaults to true. Actual execution uses only configured provider keys and falls back only on quota, rate-limit, capacity, empty-output, or 5xx responses.",
    inputSchema: {
      type: "object",
      properties: {
        task: { type: "string", minLength: 1 },
        messages: {
          type: "array",
          items: {
            type: "object",
            properties: {
              role: { type: "string", enum: ["system", "user", "assistant"] },
              content: { type: "string" },
            },
            required: ["role", "content"],
          },
        },
        mode: { type: "string", enum: ["free_only", "balanced", "quality_first"] },
        providers: {
          type: "array",
          items: { type: "string", enum: ["openrouter", "cloudflare", "groq", "zhipu", "modelscope", "nvidia", "mistral", "gemini", "siliconflow", "openai", "openai_compatible"] },
        },
        requirements: {
          type: "object",
          properties: {
            capabilities: {
              type: "array",
              items: { type: "string", enum: ["code", "tools", "web"] },
            },
            min_context_length: { type: "number" },
            sensitive: { type: "boolean" },
            policy_sensitive: { type: "boolean" },
            require_zero_data_retention: { type: "boolean" },
          },
        },
        max_tokens: { type: "integer", minimum: 1, maximum: 128000 },
        thinking: { type: "string", enum: ["auto", "enabled", "disabled"], description: "Provider-aware thinking control. Currently applied to Zhipu GLM; auto preserves provider defaults." },
        dry_run: { type: "boolean" },
      },
      additionalProperties: false,
    },
  },
  {
    name: "project_task",
    description: "Delegate one whole local project phase to a free-first Qwen worker under Codex review. Validation is risk-tiered. Paid DeepSeek is never selected automatically; it is used only when preferred=deepseek or worker_failover=true is explicitly requested.",
    inputSchema: {
      type: "object",
      properties: {
        task: { type: "string", minLength: 1 },
        cwd: { type: "string", minLength: 1 },
        task_id: { type: "string" },
        mode: { type: "string", enum: ["auto", "inspect", "implement"] },
        preferred: { type: "string", enum: ["auto", "qwen", "deepseek"] },
        max_assistants: { type: "integer", minimum: 1, maximum: 3 },
        budget: { type: "string", enum: ["low", "normal", "deep"] },
        allowed_paths: {
          type: "array",
          maxItems: 20,
          items: { type: "string", minLength: 1 },
        },
        max_minutes: { type: "integer", minimum: 1, maximum: 15 },
        attempt: { type: "integer", minimum: 1, maximum: 2 },
        run_gate: { type: "boolean" },
        validation_profile: {
          type: "string",
          enum: ["auto", "fast", "standard", "full"],
          description: "Risk-tiered validation. auto selects fast for read-only, standard for ordinary implementation, and full for high-risk work.",
        },
        response_detail: {
          type: "string",
          enum: ["compact", "full"],
          description: "compact is the default and omits internal scheduling diagnostics; full returns the complete project result.",
        },
        worker_failover: { type: "boolean", description: "Allow one paid DeepSeek failover after a retryable Qwen failure. Defaults to false." },
        worktree_isolation: { type: "boolean", description: "Run implementation in a temporary detached Git worktree when the original repository is clean. Defaults to true." },
        resume: { type: "boolean", description: "Resume a retained isolated workspace/checkpoint for the same task_id after interruption." },
        dry_run: { type: "boolean" },
      },
      required: ["task", "cwd"],
    },
  },
  {
    name: "routine_workpack",
    description: "Execute up to 12 bounded routine chores in least-privilege read-only and single-writer lanes. Implementation always passes the deterministic Gate. High-risk, destructive, external-write, and unbounded implementation items return as a compact Codex exception packet. GPT-5.6 Luna is a reserved future worker slot until explicitly enabled, configured, and backed by a local bounded runner.",
    inputSchema: {
      type: "object",
      properties: {
        cwd: { type: "string", minLength: 1 },
        task_id: { type: "string" },
        items: {
          type: "array",
          minItems: 1,
          maxItems: 12,
          items: {
            type: "object",
            properties: {
              id: { type: "string" },
              task: { type: "string", minLength: 1 },
              mode: { type: "string", enum: ["auto", "inspect", "implement"] },
              risk: { type: "string", enum: ["auto", "low", "medium", "high"] },
              allowed_paths: {
                type: "array",
                maxItems: 20,
                items: { type: "string", minLength: 1 },
              },
              destructive: { type: "boolean" },
              external_write: { type: "boolean" },
            },
            required: ["task"],
            additionalProperties: false,
          },
        },
        preferred: { type: "string", enum: ["auto", "qwen", "deepseek"] },
        max_assistants: { type: "integer", minimum: 1, maximum: 3 },
        budget: { type: "string", enum: ["low", "normal", "deep"] },
        max_minutes: { type: "integer", minimum: 1, maximum: 15 },
        worker_failover: { type: "boolean", description: "Allow one paid DeepSeek failover. Defaults to false." },
        worktree_isolation: { type: "boolean", description: "Run implementation in a temporary detached Git worktree when the original repository is clean. Defaults to true; unsafe apply conditions retain the worktree for Codex takeover." },
        dry_run: { type: "boolean" },
      },
      required: ["cwd", "items"],
      additionalProperties: false,
    },
  },
  {
    name: "worker_gate_review",
    description: "Optional exception review for ambiguous or explicitly requested cases. Structured evaluations use the deterministic takeover policy; diff-only calls use a lightweight model review. Do not call this after the deterministic project Gate already passes.",
    inputSchema: {
      type: "object",
      properties: {
        diff: { type: "string" },
        evaluation: {
          type: "object",
          properties: {
            task_id: { type: "string" },
            task: { type: "string" },
            attempt: { type: "integer", minimum: 1, maximum: 2 },
            scores: {
              type: "object",
              properties: {
                functionality: { type: "number", minimum: 0, maximum: 40 },
                requirements: { type: "number", minimum: 0, maximum: 25 },
                code_quality: { type: "number", minimum: 0, maximum: 15 },
                safety: { type: "number", minimum: 0, maximum: 10 },
                maintainability: { type: "number", minimum: 0, maximum: 10 },
              },
              required: ["functionality", "requirements", "code_quality", "safety", "maintainability"],
            },
            hard_failures: { type: "array", items: { type: "string" } },
            summary: { type: "string" },
            checks: { type: "object" },
            changed_files: { type: "array", items: { type: "string" } },
            artifacts: { type: "object" },
          },
          required: ["scores"],
        },
        checklist: {
          anyOf: [{ type: "string" }, { type: "array", items: { type: "string" } }],
        },
        preferred: { type: "string", enum: ["auto", "qwen", "deepseek", "grok", "both"] },
        budget: { type: "string", enum: ["low", "normal", "deep"] },
      },
    },
  },
  {
    name: "mission_control",
    description: "Start, stop, or inspect the optional local AI Mission Control window. It binds only to 127.0.0.1 and displays sanitized orchestration events; prompts, credentials, responses, and hidden reasoning are never exposed.",
    inputSchema: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["start", "stop", "status"] },
      },
      required: ["action"],
      additionalProperties: false,
    },
  },
  {
    name: "fabric_status",
    description: "Read-only Local AI Fabric status: provider runtime queues/circuits and sanitized SQLite or memory state. Never returns prompts, responses, or credentials.",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
  },
  {
    name: "doctor",
    description: "Read-only diagnostic of local AI Cluster configuration and optional AI Team tool availability. Reports Node, PowerShell, Git, Qwen harness availability, per-provider configuration (presence only, never values), and trusted HTTP/HTTPS or Windows system proxy presence. Never makes paid model calls, never writes to environment/registry/system, and never changes proxies. Public proxy discovery and TLS verification bypass are forbidden.",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
  },
];

const server = new Server(
  { name: SERVER_NAME, version: SERVER_VERSION },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const name = request.params.name;
  const args = request.params.arguments || {};

  if (name === "delegate_task") {
    const taskId = `delegate-${Date.now()}`;
    try {
      const delegated = await delegate(args, { onEvent: (event) => missionControl.publish(event), taskId });
      if (args.dry_run !== true) {
        await missionControl.publish({ task_id: taskId, type: "leader.decision", actor: "codex", title: "Codex received the specialist opinions", detail: "The final synthesis remains under Codex control.", status: "success" });
      }
      return result(delegated);
    } catch (error) {
      await missionControl.publish({ task_id: taskId, type: "leader.decision", actor: "codex", title: "Codex took over the model-only task", detail: "Specialist execution failed; no private response content was recorded.", status: "takeover" });
      throw error;
    }
  }

  if (name === "budget_route") {
    const budgetTaskId = `budget-${Date.now()}`;
    const dryRun = args.dry_run !== false;
    const mode = args.mode || "balanced";
    const providers = args.providers || ["zhipu", "modelscope", "groq", "nvidia", "mistral", "cloudflare", "gemini", "openrouter"];
    const requirements = args.requirements || {};
    const maxTokens = args.max_tokens || 1024;
    const thinking = args.thinking || "auto";

    if (!args.task && (!Array.isArray(args.messages) || args.messages.length === 0)) {
      throw new Error("budget_route requires task or at least one message.");
    }
    const openrouter = openRouterConfig();
    const groq = groqConfig();
    const zhipu = zhipuConfig();
    const modelscope = modelScopeConfig();
    const nvidia = nvidiaConfig();
    const mistral = mistralConfig();
    const cloudflare = cloudflareConfig();
    const gemini = geminiConfig();
    const siliconflow = siliconFlowConfig();
    const openaiCompatible = openAiCompatibleConfig();
    const openai = openAiResponsesConfig();
    const apiKeys = {
      openrouter: openrouter.apiKey,
      groq: groq.apiKey,
      zhipu: zhipu.apiKey,
      modelscope: modelscope.apiKey,
      nvidia: nvidia.apiKey,
      mistral: mistral.apiKey,
      cloudflare: cloudflare.apiKey,
      gemini: gemini.apiKey,
      siliconflow: siliconflow.apiKey,
      openai_compatible: openaiCompatible.apiKey,
      openai: openai.apiKey,
    };
    const baseUrls = {
      openrouter: openrouter.baseUrl,
      groq: groq.baseUrl,
      zhipu: zhipu.baseUrl,
      modelscope: modelscope.baseUrl,
      nvidia: nvidia.baseUrl,
      mistral: mistral.baseUrl,
      cloudflare: cloudflare.baseUrl,
      gemini: gemini.baseUrl,
      siliconflow: siliconflow.baseUrl,
      openai_compatible: openaiCompatible.baseUrl,
      openai: openai.baseUrl,
    };
    const messages = args.messages || [{ role: "user", content: args.task }];

    await missionControl.publish({
      task_id: budgetTaskId,
      type: "leader.delegated",
      actor: "codex",
      title: dryRun ? "Codex planned a free-model route" : "Codex dispatched a free-model route",
      detail: `Mode: ${mode} · providers: ${providers.join(", ")}`,
      status: "running",
    });

    const outcome = await budgetRouter.execute({
      candidates: null,
      mode,
      requirements,
      providers,
      apiKeys,
      baseUrls,
      fetchImpl: resilientFetch,
      messages,
      max_tokens: maxTokens,
      thinking,
      dry_run: dryRun,
    });
    outcome.route_decision_path = await writeRouteDecision(budgetTaskId, {
      kind: "budget", mode, budget: dryRun ? "dry_run" : "live",
      selected: outcome.explanation?.selected,
      candidates: outcome.explanation?.candidates,
      excluded: outcome.explanation?.excluded,
      fallback_chain: outcome.explanation?.fallback_chain,
    });

    for (const attempt of outcome.attempts || []) {
      if (attempt.success) continue;
      await missionControl.publish({
        task_id: budgetTaskId,
        type: "provider.failover",
        actor: attempt.provider || "system",
        title: `${attempt.model || "model"} yielded to the next free route`,
        detail: attempt.failure_kind || (attempt.status ? `HTTP ${attempt.status}` : "provider unavailable"),
        status: "warning",
      });
    }
    if (outcome.result) {
      await missionControl.publish({
        task_id: budgetTaskId,
        type: "agent.proposal",
        actor: outcome.result.provider,
        title: `${outcome.result.model} returned usable output`,
        detail: `Free-first route accepted · ${outcome.result.usage?.input_tokens || 0} in / ${outcome.result.usage?.output_tokens || 0} out`,
        status: "success",
      });
    }
    await missionControl.publish({
      task_id: budgetTaskId,
      type: "leader.decision",
      actor: "codex",
      title: outcome.result ? "Codex accepted the free-model result" : dryRun ? "Codex completed the route preview" : "Codex retained control after free routes failed",
      detail: outcome.result ? `${outcome.result.provider} · ${outcome.result.model}` : `${outcome.explanation?.fallback_chain?.length || 0} eligible routes`,
      status: outcome.result || dryRun ? "success" : "takeover",
    });

    return result(JSON.stringify(outcome, null, 2));
  }

  if (name === "doctor") {
    return result(JSON.stringify(runDoctor({ runtimeIdentity: SERVER_RUNTIME_IDENTITY }), null, 2));
  }

  if (name === "mission_control") {
    const action = args.action || "status";
    const missionStatus = action === "start"
      ? await missionControl.start()
      : action === "stop"
        ? await missionControl.stop()
        : missionControl.status();
    return result(JSON.stringify(missionStatus, null, 2));
  }

  if (name === "fabric_status") {
    const state = await fabricStateStore.snapshot();
    return result(JSON.stringify({
      backend: state.backend,
      runtime: budgetRouter.providerRuntimePool.snapshots(),
      providers: state.providers,
      usage_events: state.usage.length,
      request_events: state.requests?.length || 0,
      task_transitions: state.transitions.length,
      mission_events: state.mission_events?.length || 0,
      privacy: "Prompts, responses, and credentials are never stored in Fabric state.",
    }, null, 2));
  }

  if (name === "routine_workpack") {
    const workpack = await runRoutineWorkpack(args, {
      luna: {
        enabled: process.env.AI_TEAM_LUNA_ENABLED === "true",
        configured: Boolean(readUserEnv("OPENAI_API_KEY")),
        // The Responses adapter can already perform model-only budget routes.
        // Local write access stays disabled until a bounded tool runner exists.
        runnerAvailable: false,
      },
    });
    return result(JSON.stringify(workpack, null, 2));
  }

  if (name === "grok_search") {
    const source = !args.source || args.source === "auto" ? searchSourceForText(args.query) : args.source;
    if (args.dry_run === true) return result(`Route: grok search (${source}); one server-side tool turn`);
    const taskId = `research-${Date.now()}`;
    await missionControl.publish({ task_id: taskId, type: "research.started", actor: "grok", title: "Codex assigned live research to Grok", detail: `Source: ${source}`, status: "running" });
    try {
      const grok = await callGrokSearch({
        query: args.query,
        source,
        allowedXHandles: args.allowed_x_handles || [],
        fromDate: args.from_date || "",
        toDate: args.to_date || "",
        budget: args.budget || "low",
      });
      await missionControl.publish({ task_id: taskId, type: "research.verified", actor: "grok", title: "Grok returned current research", detail: `Citations: ${grok.citations?.length || 0}`, status: "success" });
      return result(`Route: grok\n\n## Grok Search\n${formattedGrok(grok)}`);
    } catch (error) {
      await missionControl.publish({ task_id: taskId, type: "agent.completed", actor: "grok", title: "Grok research did not complete", detail: "Codex retained control; no query content was recorded.", status: "failed" });
      if (isNetworkRequestError(error)) return result(JSON.stringify(networkFailureResult(error), null, 2));
      throw error;
    }
  }

  if (name === "project_task") {
    const preview = previewProjectTask(args);
    let research = null;
    let researchError = "";
    if (args.dry_run !== true && preview.team.use_grok) {
      try {
        research = await callGrokSearch({
          query: [
            "Find only current official documentation, release information, or other time-sensitive facts needed for this engineering task.",
            String(args.task || ""),
          ].join("\n\n"),
          source: searchSourceForText(args.task),
          budget: "low",
        });
      } catch (error) {
        researchError = compactText(error?.message || error, 500);
      }
    }
    const researchContext = research
      ? [research.text, research.citations?.length ? `Sources:\n${research.citations.join("\n")}` : ""].filter(Boolean).join("\n\n")
      : "";
    const projectResult = await runProjectTask(
      { ...args, research_context: researchContext },
      { onEvent: (event) => missionControl.publish(event) },
    );
    if (research) {
      projectResult.research = {
        model: research.event?.model || null,
        usage: research.event ? usageSummary(research.event) : null,
        citations: research.citations || [],
      };
    } else if (researchError) {
      projectResult.research = { error: researchError };
    }
    return result(JSON.stringify(compactProjectTaskResult(projectResult, args.response_detail || "compact"), null, 2));
  }

  if (name === "worker_gate_review") {
    if (args.evaluation) {
      return result(JSON.stringify(evaluateWorkerResult(args.evaluation), null, 2));
    }
    if (!args.diff) {
      throw new Error("worker_gate_review requires either evaluation or diff.");
    }
    const checklist = Array.isArray(args.checklist)
      ? args.checklist
      : args.checklist
        ? String(args.checklist).split(/\r?\n/).filter(Boolean)
        : DEFAULT_CHECKLIST;
    const preferred = args.preferred || "qwen";
    const task = [
      "Review this diff for Codex. Do not perform exhaustive code review.",
      "Only check this gate. Return PASS, CHECK, or BLOCK with concise bullets.",
      `Checklist:\n${checklist.map((item, i) => `${i + 1}. ${item}`).join("\n")}`,
      `Diff:\n${args.diff}`,
    ].join("\n\n");
    return result(await delegate({
      task,
      context: "",
      output_schema: "PASS/CHECK/BLOCK plus concise bullets",
      preferred,
      budget: args.budget || "low",
    }));
  }

  throw new Error(`Unknown tool: ${name}`);
});

await server.connect(new StdioServerTransport());
