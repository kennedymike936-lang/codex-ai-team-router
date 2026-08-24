import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const client = new Client({ name: "ai-team-xai-live-probe", version: "0.1.0" });
const transport = new StdioClientTransport({
  command: process.execPath,
  args: ["server.mjs"],
  cwd: process.cwd(),
});

await client.connect(transport);
try {
  const response = await client.callTool({
    name: "grok_search",
    arguments: {
      query: "Find the latest official xAI developer or API update. Return one concise finding and its source URL.",
      source: "x",
      allowed_x_handles: ["xai"],
      budget: "low",
    },
  });
  const text = response.content?.[0]?.text || "";
  for (const required of ["Route: grok", "Model:", "USD", "actual", "Search calls: 1", "Sources:"]) {
    if (!text.includes(required)) throw new Error(`xAI MCP probe missing ${required}: ${text.slice(0, 800)}`);
  }
  console.log(text.split(/\r?\n/).slice(0, 12).join("\n"));
  console.log("xAI MCP live probe: PASS");
} finally {
  await client.close();
}
