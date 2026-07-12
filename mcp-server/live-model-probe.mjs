import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const client = new Client({ name: "ai-team-live-probe", version: "0.3.0" });
const transport = new StdioClientTransport({
  command: process.execPath,
  args: ["server.mjs"],
  cwd: process.cwd(),
});

await client.connect(transport);
try {
  for (const preferred of ["qwen", "deepseek"]) {
    const response = await client.callTool({
      name: "delegate_task",
      arguments: {
        task: "Reply with exactly MODEL_PROBE_OK and nothing else.",
        preferred,
        budget: "low",
        output_schema: "MODEL_PROBE_OK",
      },
    });
    const text = response.content?.[0]?.text || "";
    const lines = text.split(/\r?\n/).filter((line) => /^(Route:|Model:|Usage:|MODEL_PROBE_OK)/.test(line));
    console.log(lines.join("\n"));
  }
} finally {
  await client.close();
}
