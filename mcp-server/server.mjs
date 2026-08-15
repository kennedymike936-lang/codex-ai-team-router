import { execFileSync } from "node:child_process";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { evaluateWorkerResult } from "./quality-policy.mjs";
import { isModelUnavailable, modelSelector } from "./model-selector.mjs";
import { previewProjectTask, runProjectTask } from "./project-task.mjs";
import { planTaskTeam } from "./team-planner.mjs";
import { recordUsage, usageEvent, usageSummary } from "./usage-ledger.mjs";
import { xaiSearchClient } from "./xai-search.mjs";
import { createBudgetRouter } from "./budget-router.mjs";
import { isNetworkRequestError, resilientFetch } from "./network-client.mjs";
import { runDoctor } from "./doctor.mjs";

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

function readUserEnv(name) {
  if (process.env[name]) return process.env[name];
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
    apiKey: readUserEnv("GROQ_API_KEY"),
    baseUrl: process.env.GROQ_MCP_BASE_URL || "https://api.groq.com/openai/v1",
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
  if (!value) return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    throw new Error("AI_TEAM_MODEL_METADATA_JSON must be a valid JSON object.");
  }
}

const budgetRouter = createBudgetRouter({
  allowOpenRouterFreeFallback: process.env.AI_TEAM_OPENROUTER_FREE_FALLBACK === "true",
  modelMetadata: budgetRouterMetadata(),
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

  if (needsLiveSearch && hasCode && team.use_grok) return "team";
  if (needsLiveSearch) return "grok";
  if (team.coding_assistants >= 2) return "both";
  if (hasCode) return "deepseek";
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

async function delegate(args) {
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

  if (args.dry_run === true) {
    return routingHeader;
  }

  if (route === "qwen") {
    try {
      const qwen = await callQwen({ task, context, outputSchema, maxTokens, budget: args.budget || "low" });
      return `${routingHeader}\n\n## Qwen\n${formattedWorker("Qwen", qwen)}`;
    } catch (error) {
      if (!safeAssistantFailover(error)) throw error;
      const deepseek = await callDeepSeek({ task, context, outputSchema, maxTokens, budget: args.budget || "low" });
      return `${routingHeader}\nFailover: qwen -> deepseek (${error.diagnostic.category})\n\n## DeepSeek\n${formattedWorker("DeepSeek", deepseek)}`;
    }
  }
  if (route === "deepseek") {
    try {
      const deepseek = await callDeepSeek({ task, context, outputSchema, maxTokens, budget: args.budget || "low" });
      return `${routingHeader}\n\n## DeepSeek\n${formattedWorker("DeepSeek", deepseek)}`;
    } catch (error) {
      if (!safeAssistantFailover(error)) throw error;
      const qwen = await callQwen({ task, context, outputSchema, maxTokens, budget: args.budget || "low" });
      return `${routingHeader}\nFailover: deepseek -> qwen (${error.diagnostic.category})\n\n## Qwen\n${formattedWorker("Qwen", qwen)}`;
    }
  }
  if (route === "grok") {
    const source = searchSourceForText(`${task}\n${context}`);
    try {
      const grok = await callGrokSearch({
        query: [task, context ? `Context:\n${context}` : ""].filter(Boolean).join("\n\n"),
        source,
        budget: args.budget || "low",
      });
      return `${routingHeader}\n\n## Grok Search\n${formattedGrok(grok)}`;
    } catch (error) {
      if (isNetworkRequestError(error)) {
        return `${routingHeader}\n\n${JSON.stringify(networkFailureResult(error), null, 2)}`;
      }
      throw error;
    }
  }

  if (route === "team") {
    const source = searchSourceForText(`${task}\n${context}`);
    const [qwen, deepseek, grok] = await Promise.allSettled([
      callQwen({ task, context, outputSchema, maxTokens, budget: args.budget || "low" }),
      callDeepSeek({ task, context, outputSchema, maxTokens, budget: args.budget || "low" }),
      callGrokSearch({
        query: [task, context ? `Context:\n${context}` : ""].filter(Boolean).join("\n\n"),
        source,
        budget: args.budget || "low",
      }),
    ]);
    const qwenText = qwen.status === "fulfilled" ? formattedWorker("Qwen", qwen.value, 2400) : `FAILED: ${qwen.reason?.message || qwen.reason}`;
    const deepSeekText = deepseek.status === "fulfilled" ? formattedWorker("DeepSeek", deepseek.value, 2400) : `FAILED: ${deepseek.reason?.message || deepseek.reason}`;
    const grokText = grok.status === "fulfilled" ? formattedGrok(grok.value, 1800) : `FAILED: ${grok.reason?.message || grok.reason}`;
    return `${routingHeader}\n\n## Qwen\n${qwenText}\n\n## DeepSeek\n${deepSeekText}\n\n## Grok Search\n${grokText}`;
  }

  const [qwen, deepseek] = await Promise.allSettled([
    callQwen({ task, context, outputSchema, maxTokens, budget: args.budget || "low" }),
    callDeepSeek({ task, context, outputSchema, maxTokens, budget: args.budget || "low" }),
  ]);
  const qwenText = qwen.status === "fulfilled" ? formattedWorker("Qwen", qwen.value, 3000) : `FAILED: ${qwen.reason?.message || qwen.reason}`;
  const deepSeekText = deepseek.status === "fulfilled" ? formattedWorker("DeepSeek", deepseek.value, 3000) : `FAILED: ${deepseek.reason?.message || deepseek.reason}`;
  return `${routingHeader}\n\n## Qwen\n${qwenText}\n\n## DeepSeek\n${deepSeekText}`;
}

const tools = [
  {
    name: "delegate_task",
    description: "Automatically size a model-only team from one to three assistants based on task complexity. Qwen and DeepSeek handle general work; Grok joins only for complex work that needs current Web/X research. Set dry_run to preview without spending model tokens.",
    inputSchema: {
      type: "object",
      properties: {
        task: { type: "string" },
        context: { type: "string" },
        output_schema: { type: "string" },
        preferred: { type: "string", enum: ["auto", "qwen", "deepseek", "grok", "both"] },
        max_assistants: { type: "integer", minimum: 1, maximum: 3 },
        budget: { type: "string", enum: ["low", "normal", "deep"] },
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
    description: "Free-tier-aware, capability-aware routing across registered providers including OpenRouter, Groq, Gemini, SiliconFlow, and an administrator-configured OpenAI-compatible endpoint. dry_run defaults to true. Actual execution uses only configured provider keys and falls back only on quota, rate-limit, capacity, or 5xx responses.",
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
          items: { type: "string", enum: ["openrouter", "groq", "gemini", "siliconflow", "openai", "openai_compatible"] },
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
        dry_run: { type: "boolean" },
      },
      additionalProperties: false,
    },
  },
  {
    name: "project_task",
    description: "Delegate one whole local project phase to an automatically sized AI team. Small work uses one coding assistant; broader work adds a read-only planner; complex implementation can use an explicitly enabled official Grok Build CLI, while time-sensitive work can add read-only Grok research. Retryable worker failures can switch once to an independent assistant/harness. Implementation is noninteractive and can run the deterministic quality gate.",
    inputSchema: {
      type: "object",
      properties: {
        task: { type: "string", minLength: 1 },
        cwd: { type: "string", minLength: 1 },
        task_id: { type: "string" },
        mode: { type: "string", enum: ["auto", "inspect", "implement"] },
        preferred: { type: "string", enum: ["auto", "qwen", "deepseek", "grok"] },
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
        worker_failover: { type: "boolean" },
        dry_run: { type: "boolean" },
      },
      required: ["task", "cwd"],
    },
  },
  {
    name: "worker_gate_review",
    description: "Evaluate a worker result. Structured evaluations use the deterministic quality/takeover policy; diff-only calls use a lightweight model review.",
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
    name: "doctor",
    description: "Read-only diagnostic of local AI Team configuration and tool availability. Reports Node, PowerShell, Git, Qwen/Grok Build harness availability, Grok account-session presence, per-provider configuration (presence only, never values), and trusted HTTP/HTTPS or Windows system proxy presence. Never reads login files, makes paid model calls, writes to environment/registry/system, or changes proxies. Public proxy discovery and TLS verification bypass are forbidden.",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
  },
];

const server = new Server(
  { name: "ai-team-mcp-server", version: "0.7.0" },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const name = request.params.name;
  const args = request.params.arguments || {};

  if (name === "delegate_task") {
    return result(await delegate(args));
  }

  if (name === "budget_route") {
    const dryRun = args.dry_run !== false;
    const mode = args.mode || "balanced";
    const providers = args.providers || ["openrouter", "groq", "gemini"];
    const requirements = args.requirements || {};
    const maxTokens = args.max_tokens || 1024;

    if (!args.task && (!Array.isArray(args.messages) || args.messages.length === 0)) {
      throw new Error("budget_route requires task or at least one message.");
    }
    const openrouter = openRouterConfig();
    const groq = groqConfig();
    const gemini = geminiConfig();
    const siliconflow = siliconFlowConfig();
    const openaiCompatible = openAiCompatibleConfig();
    const openai = openAiResponsesConfig();
    const apiKeys = {
      openrouter: openrouter.apiKey,
      groq: groq.apiKey,
      gemini: gemini.apiKey,
      siliconflow: siliconflow.apiKey,
      openai_compatible: openaiCompatible.apiKey,
      openai: openai.apiKey,
    };
    const baseUrls = {
      openrouter: openrouter.baseUrl,
      groq: groq.baseUrl,
      gemini: gemini.baseUrl,
      siliconflow: siliconflow.baseUrl,
      openai_compatible: openaiCompatible.baseUrl,
      openai: openai.baseUrl,
    };
    const messages = args.messages || [{ role: "user", content: args.task }];

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
      dry_run: dryRun,
    });

    return result(JSON.stringify(outcome, null, 2));
  }

  if (name === "doctor") {
    return result(JSON.stringify(runDoctor(), null, 2));
  }

  if (name === "grok_search") {
    const source = !args.source || args.source === "auto" ? searchSourceForText(args.query) : args.source;
    if (args.dry_run === true) return result(`Route: grok search (${source}); one server-side tool turn`);
    try {
      const grok = await callGrokSearch({
        query: args.query,
        source,
        allowedXHandles: args.allowed_x_handles || [],
        fromDate: args.from_date || "",
        toDate: args.to_date || "",
        budget: args.budget || "low",
      });
      return result(`Route: grok\n\n## Grok Search\n${formattedGrok(grok)}`);
    } catch (error) {
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
    const projectResult = await runProjectTask({ ...args, research_context: researchContext });
    if (research) {
      projectResult.research = {
        model: research.event?.model || null,
        usage: research.event ? usageSummary(research.event) : null,
        citations: research.citations || [],
      };
    } else if (researchError) {
      projectResult.research = { error: researchError };
    }
    return result(JSON.stringify(projectResult, null, 2));
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
    const preferred = args.preferred || "deepseek";
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
