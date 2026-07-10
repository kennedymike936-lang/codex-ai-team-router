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

console.log(`MCP tools: ${names.join(", ")}`);
console.log(`Dry run: ${previewText}`);
await client.close();
