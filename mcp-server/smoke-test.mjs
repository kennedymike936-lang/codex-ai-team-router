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
const expected = ["delegate_task", "doctor", "grok_search", "project_task", "routine_workpack", "worker_gate_review"];

for (const name of expected) {
  if (!names.includes(name)) throw new Error(`Missing MCP tool: ${name}`);
}

const doctorCall = await client.callTool({ name: "doctor", arguments: {} });
const doctor = JSON.parse(doctorCall.content?.[0]?.text || "{}");
if (!doctor.summary || !Array.isArray(doctor.providers) || !doctor.proxy || !Array.isArray(doctor.notes)) {
  throw new Error(`Unexpected doctor result shape: ${JSON.stringify(doctor)}`);
}

const preview = await client.callTool({
  name: "delegate_task",
  arguments: { task: "Fix a TypeScript bug", dry_run: true },
});
const previewText = preview.content?.[0]?.text || "";
if (!previewText.includes("deepseek")) {
  throw new Error(`Unexpected dry-run route: ${previewText}`);
}

const grokPreview = await client.callTool({
  name: "delegate_task",
  arguments: { task: "Find the latest posts on X about xAI", dry_run: true },
});
const grokPreviewText = grokPreview.content?.[0]?.text || "";
if (!grokPreviewText.includes("grok")) {
  throw new Error(`Unexpected Grok dry-run route: ${grokPreviewText}`);
}

const searchPreview = await client.callTool({
  name: "grok_search",
  arguments: { query: "latest package price", source: "auto", dry_run: true },
});
const searchPreviewText = searchPreview.content?.[0]?.text || "";
if (!searchPreviewText.includes("(web)") || !searchPreviewText.includes("one server-side tool turn")) {
  throw new Error(`Unexpected search dry-run: ${searchPreviewText}`);
}

const projectPreview = await client.callTool({
  name: "project_task",
  arguments: { task: "Fix a bounded TypeScript bug", cwd: process.cwd(), dry_run: true },
});
const projectPreviewJson = JSON.parse(projectPreview.content?.[0]?.text || "{}");
if (projectPreviewJson.mode !== "implement" || projectPreviewJson.worker !== "deepseek" || projectPreviewJson.run_gate !== true) {
  throw new Error(`Unexpected project dry-run: ${JSON.stringify(projectPreviewJson)}`);
}

const workpackPreview = await client.callTool({
  name: "routine_workpack",
  arguments: {
    cwd: process.cwd(),
    dry_run: true,
    items: [
      { id: "docs", task: "Update README", allowed_paths: ["README.md"] },
      { id: "deploy", task: "Deploy to production", allowed_paths: ["deploy"] },
    ],
  },
});
const workpackPreviewJson = JSON.parse(workpackPreview.content?.[0]?.text || "{}");
if (workpackPreviewJson.autonomous_count !== 1 || workpackPreviewJson.escalation_count !== 1) {
  throw new Error(`Unexpected workpack dry run: ${JSON.stringify(workpackPreviewJson)}`);
}
if (workpackPreviewJson.worker_slots?.[0]?.model !== "gpt-5.6-luna") {
  throw new Error(`Missing reserved Luna worker slot: ${JSON.stringify(workpackPreviewJson.worker_slots)}`);
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
console.log(`Grok dry run: ${grokPreviewText}`);
console.log(`Project dry run: ${projectPreviewJson.worker} -> gate ${projectPreviewJson.run_gate}`);
console.log(`Routine workpack: ${workpackPreviewJson.autonomous_count} autonomous, ${workpackPreviewJson.escalation_count} escalated`);
console.log(`Quality gate: ${handoff.score} -> ${handoff.decision}`);
await client.close();
