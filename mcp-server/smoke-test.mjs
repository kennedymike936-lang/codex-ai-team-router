import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const client = new Client({ name: "ai-team-smoke", version: "0.1.0" });
const transport = new StdioClientTransport({
  command: process.execPath,
  args: ["server.mjs"],
  cwd: process.cwd(),
});

await client.connect(transport);
const listed = await client.listTools();
const names = listed.tools.map((tool) => tool.name).sort();
const expected = ["delegate_task", "worker_gate_review"];

for (const name of expected) {
  if (!names.includes(name)) throw new Error(`Missing MCP tool: ${name}`);
}

const preview = await client.callTool({
  name: "delegate_task",
  arguments: { task: "Fix a TypeScript bug", dry_run: true },
});
const previewText = preview.content?.[0]?.text || "";
if (!previewText.includes("deepseek")) {
  throw new Error(`Unexpected dry-run route: ${previewText}`);
}

const quality = await client.callTool({
  name: "worker_gate_review",
  arguments: {
    evaluation: {
      task_id: "smoke-quality",
      attempt: 1,
      scores: {
        functionality: 35,
        requirements: 20,
        code_quality: 10,
        safety: 10,
        maintainability: 10,
      },
    },
  },
});
const handoff = JSON.parse(quality.content?.[0]?.text || "{}");
if (handoff.decision !== "retry" || handoff.score !== 85) {
  throw new Error(`Unexpected quality decision: ${JSON.stringify(handoff)}`);
}

console.log(`MCP tools: ${names.join(", ")}`);
console.log(`Dry run: ${previewText}`);
console.log(`Quality gate: ${handoff.score} -> ${handoff.decision}`);
await client.close();
