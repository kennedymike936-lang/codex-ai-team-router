import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const EXPECTED_PACKAGE_NAME = "codex-ai-cluster-router";
const EXPECTED_BUILD_ID = "20260824-groq-proxy-first-r2";

function textResult(response) {
  const block = response?.content?.find((item) => item.type === "text");
  if (!block?.text) throw new Error("MCP tool returned no text result.");
  return JSON.parse(block.text);
}

function selectedId(selected) {
  if (typeof selected === "string") return selected;
  return selected?.id || selected?.model || null;
}

const serverDir = path.dirname(fileURLToPath(import.meta.url));
const packageJson = JSON.parse(fs.readFileSync(path.join(serverDir, "package.json"), "utf8"));
const liveGroqRequested = process.argv.includes("--live-groq");
const structuralChecks = {
  package_name: packageJson.name === EXPECTED_PACKAGE_NAME,
  package_version_present: typeof packageJson.version === "string" && packageJson.version.length > 0,
  server_source_present: fs.existsSync(path.join(serverDir, "server.mjs")),
};

const client = new Client({ name: "codex-ai-cluster-self-check", version: packageJson.version || "0.0.0" });
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [path.join(serverDir, "server.mjs")],
  cwd: serverDir,
  env: process.env,
});

let output;
try {
  await client.connect(transport);
  const doctor = textResult(await client.callTool({ name: "doctor", arguments: {} }));
  const groqConfigured = doctor.providers?.some(
    (provider) => provider.provider === "groq" && provider.status === "configured",
  ) === true;
  const runtimeBuildMatches = doctor.runtime_identity?.build_id === EXPECTED_BUILD_ID;
  const doctorPasses = Number(doctor.summary?.fail || 0) === 0;

  let groq = {
    requested: liveGroqRequested,
    configured: groqConfigured,
    status: liveGroqRequested ? (groqConfigured ? "pending" : "skipped_unconfigured") : "skipped_offline",
    selected: null,
    provider_exclusions: [],
  };

  if (liveGroqRequested && groqConfigured) {
    const route = textResult(await client.callTool({
      name: "budget_route",
      arguments: {
        task: "Read-only Groq model discovery self-check; do not perform inference.",
        providers: ["groq"],
        mode: "free_only",
        dry_run: true,
        max_tokens: 1,
      },
    }));
    const explanation = route.explanation || {};
    groq = {
      ...groq,
      status: selectedId(explanation.selected) && (explanation.provider_exclusions || []).length === 0
        ? "pass"
        : "fail",
      selected: selectedId(explanation.selected),
      provider_exclusions: explanation.provider_exclusions || [],
    };
  }

  const structuralPasses = Object.values(structuralChecks).every(Boolean);
  const liveGroqPasses = !liveGroqRequested || !groqConfigured || groq.status === "pass";
  const passed = structuralPasses && doctorPasses && runtimeBuildMatches && liveGroqPasses;
  output = {
    status: passed ? "pass" : "fail",
    expected_build_id: EXPECTED_BUILD_ID,
    structural_checks: structuralChecks,
    runtime_identity: doctor.runtime_identity || null,
    doctor_summary: doctor.summary || null,
    groq,
    active_runtime_note: "This script validates a fresh local server process. Codex must also call the active ai_cluster_mcp doctor tool and compare PID/build ID after installation or pull.",
    restart_notice: "After MCP source, path, or configuration changes, use Settings > MCP servers > Restart; then verify a new PID and matching build ID.",
  };
  if (!passed) process.exitCode = 1;
} catch (error) {
  output = {
    status: "fail",
    expected_build_id: EXPECTED_BUILD_ID,
    error: error?.message || String(error),
    restart_notice: "Fix local installation errors first. After MCP changes, use Settings > MCP servers > Restart.",
  };
  process.exitCode = 1;
} finally {
  await client.close().catch(() => {});
}

console.log(JSON.stringify(output, null, 2));
