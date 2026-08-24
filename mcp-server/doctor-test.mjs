import assert from "node:assert/strict";
import { commandExists, DIAGNOSTIC_ONLY, PROXY_POLICY, runDoctor } from "./doctor.mjs";

const fakeExec = (file, args) => {
  if (file === "where") {
    if (args[0] === "qwen") return "C:\\tools\\qwen.cmd";
    throw new Error("not found");
  }
  if (file === "node" && args[0] === "--version") return "v20.11.0";
  if (file === "powershell.exe") return "7.4.1";
  if (file === "git" && args[0] === "--version") return "git version 2.43.0.windows.1";
  throw new Error(`unexpected exec: ${file} ${args.join(" ")}`);
};

const providerVariable = ["DASHSCOPE", "API", "KEY"].join("_");
const providerSentinel = ["fixture", "provider", "opaque", "value"].join("_");
const proxySentinel = ["http://fixture-user", "fixture-pass@proxy.invalid:8080"].join(":");
const env = {
  [providerVariable]: providerSentinel,
  ANTHROPIC_BASE_URL: "https://api.deepseek.com/anthropic",
  HTTP_PROXY: proxySentinel,
  HTTPS_PROXY: proxySentinel,
  NO_PROXY: "localhost,127.0.0.1",
};

const testRuntimeIdentity = {
  server_name: "ai-cluster-mcp-server",
  version: "1.0.1",
  build_id: "test-build",
  pid: 4242,
  started_at: "2026-08-24T00:00:00.000Z",
  source_mtime_at_start: "2026-08-24T00:00:00.000Z",
  script_path: "D:\\AI-Team\\ai-cluster-mcp-server\\server.mjs",
};
const result = runDoctor({
  env,
  exec: fakeExec,
  platform: "win32",
  systemProxyPresence: false,
  runtimeIdentity: testRuntimeIdentity,
});
const json = JSON.stringify(result);

// Structured runtime + harness availability.
assert.deepEqual(result.runtime_identity, testRuntimeIdentity);
assert.deepEqual(
  result.runtime.map((r) => [r.check, r.available, r.version]),
  [
    ["node", true, "v20.11.0"],
    ["powershell", true, "7.4.1"],
    ["git", true, "git version 2.43.0.windows.1"],
  ],
);
assert.deepEqual(result.harness.map((h) => [h.command, h.available]), [
  ["qwen", true],
]);

// Providers: presence only, never values.
const qwen = result.providers.find((p) => p.provider === "qwen");
const deepseek = result.providers.find((p) => p.provider === "deepseek");
assert.equal(qwen.status, "configured");
assert.equal(deepseek.status, "unconfigured");
assert.ok(!json.includes(providerSentinel), "must not leak provider credential values");

// Proxy presence without URLs or credentials.
assert.equal(result.proxy.http_proxy_configured, true);
assert.equal(result.proxy.https_proxy_configured, true);
assert.equal(result.proxy.no_proxy_configured, true);
assert.equal(result.proxy.trusted_proxy_configured, false);
assert.equal(result.proxy.system_proxy_configured, false);
assert.ok(!json.includes("proxy.invalid"), "must not leak proxy URLs");
assert.ok(!json.includes("fixture-pass"), "must not leak proxy credentials");

// Forbidden policy + diagnostic-only guarantees are explicit.
assert.ok(json.includes(PROXY_POLICY));
assert.ok(json.includes(DIAGNOSTIC_ONLY));

// Findings are separated by severity.
assert.ok(Array.isArray(result.findings));
assert.ok(result.findings.every((f) => ["pass", "warn", "fail"].includes(f.severity)));
assert.equal(result.summary.pass, result.findings.filter((f) => f.severity === "pass").length);
assert.equal(result.summary.warn, result.findings.filter((f) => f.severity === "warn").length);
assert.equal(result.summary.fail, result.findings.filter((f) => f.severity === "fail").length);
assert.equal(result.summary.fail, 0);
assert.deepEqual(result.findings_by_severity.fail, []);
assert.equal(result.findings_by_severity.pass.length, result.summary.pass);
assert.equal(result.findings_by_severity.warn.length, result.summary.warn);

// Warn findings carry safe suggestions and never mention values.
const warn = result.findings.filter((f) => f.severity === "warn");
assert.ok(warn.length > 0);
assert.ok(warn.every((f) => typeof f.suggestion === "string" && f.suggestion.length > 0));

// commandExists helper is deterministic.
assert.equal(commandExists("qwen", fakeExec, "win32"), true);

// Unconfigured provider (no env) reports unconfigured for every provider.
const empty = runDoctor({ env: {}, exec: fakeExec, envPresence: () => false, systemProxyPresence: false, platform: "win32" });
assert.ok(empty.providers.every((p) => p.status === "unconfigured"));
assert.ok(empty.findings.some((f) => f.severity === "warn" && /No trusted HTTP\/HTTPS proxy/.test(f.message)));

// Windows user-scope provider checks receive only a boolean, never the value.
const userScopeExec = (file, args) => {
  if (file === "powershell.exe" && args.at(-1).includes("GetEnvironmentVariable")) {
    return args.at(-1).includes("'GROQ_API_KEY'") ? "True" : "False";
  }
  return fakeExec(file, args);
};
const userScope = runDoctor({ env: {}, exec: userScopeExec, platform: "win32" });
assert.equal(userScope.providers.find((p) => p.provider === "groq").status, "configured");

for (const provider of ["zhipu", "modelscope", "nvidia", "mistral"]) {
  assert.ok(userScope.providers.some((p) => p.provider === provider), `${provider} must be reported by doctor`);
}
const fabricSentinel = "fixture-fabric-provider-value";
const fabricDoctor = runDoctor({
  env: {
    ZHIPU_API_KEY: fabricSentinel,
    MODELSCOPE_API_KEY: fabricSentinel,
    NVIDIA_API_KEY: fabricSentinel,
    MISTRAL_API_KEY: fabricSentinel,
  },
  exec: fakeExec,
  platform: "win32",
  systemProxyPresence: false,
});
for (const provider of ["zhipu", "modelscope", "nvidia", "mistral"]) {
  assert.equal(fabricDoctor.providers.find((p) => p.provider === provider).status, "configured");
}
assert.equal(JSON.stringify(fabricDoctor).includes(fabricSentinel), false);

const systemProxy = runDoctor({
  env: {},
  exec: fakeExec,
  envPresence: () => false,
  systemProxyPresence: true,
  platform: "win32",
});
assert.equal(systemProxy.proxy.system_proxy_configured, true);
assert.equal(systemProxy.proxy.trusted_proxy_configured, true);
assert.ok(systemProxy.findings.some((f) => /trusted HTTP\/HTTPS proxy is configured/i.test(f.message)));
assert.ok(!JSON.stringify(systemProxy).includes("127.0.0.1"));

console.log("doctor-test.mjs: all assertions passed");
