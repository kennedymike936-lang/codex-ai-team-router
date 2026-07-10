import { execFileSync } from "node:child_process";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

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
    model:
      process.env.QWEN_MCP_MODEL ||
      process.env.AI_TEAM_QWEN_MODEL ||
      "qwen3.7-plus",
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
    model:
      process.env.DEEPSEEK_MCP_MODEL ||
      process.env.ANTHROPIC_MODEL ||
      "deepseek-v4-pro[1m]",
  };
}

function maxTokensForBudget(budget = "low") {
  if (budget === "deep") return 3800;
  if (budget === "normal") return 2000;
  return 900;
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

async function callQwen({ task, context, outputSchema, maxTokens }) {
  const { apiKey, baseUrl, model } = qwenConfig();
  const url = `${baseUrl.replace(/\/$/, "")}/chat/completions`;
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

  const response = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`Qwen ${response.status} ${response.statusText}: ${text.slice(0, 800)}`);
  }
  const json = JSON.parse(text);
  return json.choices?.[0]?.message?.content || text;
}

function anthropicText(content) {
  if (!Array.isArray(content)) return "";
  return content.map((part) => (typeof part?.text === "string" ? part.text : "")).filter(Boolean).join("\n");
}

async function callDeepSeek({ task, context, outputSchema, maxTokens }) {
  const { apiKey, baseUrl, model } = deepSeekConfig();
  const url = `${baseUrl.replace(/\/$/, "")}/v1/messages`;
  const body = {
    model,
    max_tokens: maxTokens,
    temperature: 0.2,
    system: baseSystem("DeepSeek"),
    messages: [
      {
        role: "user",
        content: [
          `Task:\n${task}`,
          context ? `Context:\n${context}` : "",
          schemaNote(outputSchema),
        ].filter(Boolean).join("\n\n"),
      },
    ],
  };

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
  for (const headers of headerSets) {
    const response = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });
    const text = await response.text();
    if (response.ok) {
      const json = JSON.parse(text);
      return anthropicText(json.content) || text;
    }
    lastError = `DeepSeek ${response.status} ${response.statusText}: ${text.slice(0, 800)}`;
  }
  throw new Error(lastError || "DeepSeek request failed.");
}

function routeTask({ task = "", context = "", preferred = "auto" }) {
  if (["qwen", "deepseek", "both"].includes(preferred)) return preferred;

  const text = `${task}\n${context}`.toLowerCase();
  const codeWords = [
    "bug", "debug", "fix", "diff", "patch", "typescript", "javascript",
    "python", "powershell", "api", "test", "lint", "typecheck", "build",
    "代码", "脚本", "报错", "修复", "测试", "类型", "重构",
  ];
  const broadWords = [
    "summarize", "summary", "docs", "document", "整理", "总结", "文档",
    "清单", "计划", "方案", "提纲", "翻译", "润色",
  ];
  const complexWords = [
    "architecture", "复杂", "架构", "多步骤", "方案比较", "review", "审查",
  ];

  const hasCode = codeWords.some((word) => text.includes(word));
  const hasBroad = broadWords.some((word) => text.includes(word));
  const hasComplex = complexWords.some((word) => text.includes(word));

  if (hasCode && hasComplex) return "both";
  if (hasCode) return "deepseek";
  if (hasBroad) return "qwen";
  return "qwen";
}

function result(text) {
  return { content: [{ type: "text", text }] };
}

function compactText(text, maxChars = 5000) {
  const value = String(text || "").trim();
  if (value.length <= maxChars) return value;
  return `[truncated; full worker artifact should be used for details]\n${value.slice(0, maxChars)}`;
}

async function delegate(args) {
  const preferred = args.preferred || "auto";
  const route = routeTask({
    task: args.task || "",
    context: args.context || "",
    preferred,
  });
  const maxTokens = maxTokensForBudget(args.budget || "low");
  const task = args.task || "";
  const context = args.context || "";
  const outputSchema = args.output_schema || "";

  if (args.dry_run === true) {
    return `Route: ${route}`;
  }

  if (route === "qwen") {
    const qwen = await callQwen({ task, context, outputSchema, maxTokens });
    return `Route: qwen\n\n## Qwen\n${compactText(qwen)}`;
  }
  if (route === "deepseek") {
    const deepseek = await callDeepSeek({ task, context, outputSchema, maxTokens });
    return `Route: deepseek\n\n## DeepSeek\n${compactText(deepseek)}`;
  }

  const [qwen, deepseek] = await Promise.allSettled([
    callQwen({ task, context, outputSchema, maxTokens }),
    callDeepSeek({ task, context, outputSchema, maxTokens }),
  ]);
  const qwenText = qwen.status === "fulfilled" ? compactText(qwen.value, 3000) : `FAILED: ${qwen.reason?.message || qwen.reason}`;
  const deepSeekText = deepseek.status === "fulfilled" ? compactText(deepseek.value, 3000) : `FAILED: ${deepseek.reason?.message || deepseek.reason}`;
  return `Route: both\n\n## Qwen\n${qwenText}\n\n## DeepSeek\n${deepSeekText}`;
}

const tools = [
  {
    name: "delegate_task",
    description: "Route a task to Qwen, DeepSeek, or both. Set dry_run to preview routing without a model call.",
    inputSchema: {
      type: "object",
      properties: {
        task: { type: "string" },
        context: { type: "string" },
        output_schema: { type: "string" },
        preferred: { type: "string", enum: ["auto", "qwen", "deepseek", "both"] },
        budget: { type: "string", enum: ["low", "normal", "deep"] },
        dry_run: { type: "boolean" },
      },
      required: ["task"],
    },
  },
  {
    name: "worker_gate_review",
    description: "Review a diff against Codex's lightweight safety gate.",
    inputSchema: {
      type: "object",
      properties: {
        diff: { type: "string" },
        checklist: {
          anyOf: [{ type: "string" }, { type: "array", items: { type: "string" } }],
        },
        preferred: { type: "string", enum: ["auto", "qwen", "deepseek", "both"] },
        budget: { type: "string", enum: ["low", "normal", "deep"] },
      },
      required: ["diff"],
    },
  },
];

const server = new Server(
  { name: "ai-team-mcp-server", version: "0.1.0" },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const name = request.params.name;
  const args = request.params.arguments || {};

  if (name === "delegate_task") {
    return result(await delegate(args));
  }

  if (name === "worker_gate_review") {
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
