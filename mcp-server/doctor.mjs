import { execFileSync } from "node:child_process";

// Diagnostic-only. Presence checks return booleans; values are never read,
// copied, logged, or returned. No paid model calls, no writes, no proxy edits.
export const PROVIDER_ENV_VARS = {
  qwen: ["DASHSCOPE_API_KEY", "OPENAI_API_KEY", "QWEN_API_KEY"],
  deepseek: ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "DEEPSEEK_API_KEY"],
  xai: ["XAI_API_KEY"],
  openrouter: ["OPENROUTER_API_KEY"],
  cloudflare: ["CLOUDFLARE_ACCOUNT_ID", "CLOUDFLARE_API_TOKEN", "CLOUDFLARE_AUTH_TOKEN"],
  groq: ["GROQ_API_KEY"],
  zhipu: ["ZHIPU_API_KEY"],
  modelscope: ["MODELSCOPE_API_KEY"],
  nvidia: ["NVIDIA_API_KEY", "NVIDIA_NIM_API_KEY"],
  mistral: ["MISTRAL_API_KEY"],
  gemini: ["GEMINI_API_KEY", "GOOGLE_API_KEY"],
  siliconflow: ["SILICONFLOW_API_KEY"],
  openai: ["OPENAI_API_KEY"],
  openai_compatible: ["OPENAI_COMPATIBLE_API_KEY"],
};

export const PROXY_POLICY =
  "Public proxy discovery and TLS verification bypass are forbidden. Only administrator-configured trusted HTTP/HTTPS proxies are used.";

export const DIAGNOSTIC_ONLY =
  "Diagnostic only: no environment, registry, or system writes; no paid model calls; no automatic proxy changes.";

const HARNESS_COMMANDS = [
  { command: "qwen", label: "Qwen harness" },
];

function defaultExec(file, args) {
  return execFileSync(file, args, {
    encoding: "utf8",
    timeout: 3000,
    windowsHide: true,
  }).trim();
}

function tryRun(exec, file, args) {
  try {
    return { ok: true, output: String(exec(file, args)).trim() };
  } catch {
    return { ok: false, output: "" };
  }
}

export function commandExists(command, exec = defaultExec, platform = process.platform) {
  try {
    if (platform === "win32") {
      exec("where", [command]);
    } else {
      exec("sh", ["-c", `command -v ${JSON.stringify(command)}`]);
    }
    return true;
  } catch {
    return false;
  }
}

function hasValue(env, name) {
  const value = env[name];
  return typeof value === "string" && value.trim().length > 0;
}

function defaultEnvPresence(name, env, exec, platform) {
  if (hasValue(env, name)) return true;
  if (platform !== "win32") return false;
  // Ask PowerShell for a boolean only. The user-level value is never emitted
  // into this process, logs, findings, or tool output.
  const escapedName = String(name).replace(/'/g, "''");
  const check = tryRun(
    exec,
    "powershell.exe",
    ["-NoProfile", "-Command", `[bool][Environment]::GetEnvironmentVariable('${escapedName}', 'User')`],
  );
  return check.ok && check.output.trim().toLowerCase() === "true";
}

function defaultSystemProxyPresence(exec, platform) {
  if (platform !== "win32") return false;
  const check = tryRun(
    exec,
    "powershell.exe",
    [
      "-NoProfile",
      "-Command",
      "$p=Get-ItemProperty 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings' -ErrorAction SilentlyContinue; [bool]($p.ProxyEnable -and -not [string]::IsNullOrWhiteSpace([string]$p.ProxyServer))",
    ],
  );
  return check.ok && check.output.trim().toLowerCase() === "true";
}

export function runDoctor(options = {}) {
  const env = options.env || process.env;
  const exec = options.exec || defaultExec;
  const platform = options.platform || process.platform;
  const envPresence = options.envPresence || ((name) => defaultEnvPresence(name, env, exec, platform));
  const systemProxyPresence = options.systemProxyPresence ?? defaultSystemProxyPresence(exec, platform);
  const runtimeIdentity = options.runtimeIdentity || {
    server_name: "ai-cluster-mcp-server",
    version: null,
    build_id: null,
    pid: process.pid,
    started_at: new Date(Date.now() - process.uptime() * 1000).toISOString(),
    source_mtime_at_start: null,
    script_path: process.argv[1] || null,
  };

  const findings = [];
  const add = (severity, message, suggestion = null) => {
    findings.push(suggestion ? { severity, message, suggestion } : { severity, message });
  };

  const runtime = [];
  const node = tryRun(exec, "node", ["--version"]);
  runtime.push({ check: "node", available: node.ok, version: node.ok ? node.output : null });
  add(
    node.ok ? "pass" : "fail",
    node.ok ? `Node.js available (${node.output})` : "Node.js is not available",
    node.ok ? null : "Install Node.js 20+ and ensure it is on PATH.",
  );

  const powershellFile = platform === "win32" ? "powershell.exe" : "pwsh";
  const ps = tryRun(exec, powershellFile, ["-NoProfile", "-Command", "$PSVersionTable.PSVersion.ToString()"]);
  runtime.push({ check: "powershell", available: ps.ok, version: ps.ok ? ps.output : null });
  add(
    ps.ok ? "pass" : "fail",
    ps.ok ? `PowerShell available (${ps.output})` : "PowerShell is not available",
    ps.ok ? null : "Install PowerShell and ensure it is on PATH.",
  );

  const git = tryRun(exec, "git", ["--version"]);
  runtime.push({ check: "git", available: git.ok, version: git.ok ? git.output : null });
  add(
    git.ok ? "pass" : "fail",
    git.ok ? `Git available (${git.output})` : "Git is not available",
    git.ok ? null : "Install Git and ensure it is on PATH.",
  );

  const harness = HARNESS_COMMANDS.map(({ command, label }) => {
    const available = commandExists(command, exec, platform);
    if (available) {
      add("pass", `${label} command is available (${command})`);
    } else {
      add("warn", `${label} command is not available (${command})`, `Install the ${label} CLI and ensure "${command}" is on PATH.`);
    }
    return { command, label, available };
  });

  const providers = Object.entries(PROVIDER_ENV_VARS).map(([provider, names]) => {
    const configured = provider === "cloudflare"
      ? envPresence("CLOUDFLARE_ACCOUNT_ID") && ["CLOUDFLARE_API_TOKEN", "CLOUDFLARE_AUTH_TOKEN"].some((name) => envPresence(name))
      : names.some((name) => envPresence(name));
    if (configured) {
      add("pass", `${provider} provider is configured`);
    } else {
      add(
        "warn",
        `${provider} provider is unconfigured`,
        `Set any of these environment variables to enable the ${provider} provider: ${names.join(", ")}. Values are never inspected or returned.`,
      );
    }
    return { provider, status: configured ? "configured" : "unconfigured", checked_env_vars: names };
  });

  const proxy = {
    trusted_proxy_configured: ["AI_TEAM_TRUSTED_PROXY_URL"].some(envPresence) || Boolean(systemProxyPresence),
    http_proxy_configured: ["HTTP_PROXY", "http_proxy", "ALL_PROXY", "all_proxy"].some(envPresence),
    https_proxy_configured: ["HTTPS_PROXY", "https_proxy", "ALL_PROXY", "all_proxy"].some(envPresence),
    no_proxy_configured: ["NO_PROXY", "no_proxy"].some(envPresence),
    system_proxy_configured: Boolean(systemProxyPresence),
    policy: PROXY_POLICY,
  };
  if (proxy.trusted_proxy_configured || proxy.http_proxy_configured || proxy.https_proxy_configured) {
    add("pass", "A trusted HTTP/HTTPS proxy is configured. Proxy URLs and credentials are never returned.");
  } else {
    add("warn", "No trusted HTTP/HTTPS proxy is configured.", "Configure AI_TEAM_TRUSTED_PROXY_URL, HTTP_PROXY, or HTTPS_PROXY only if direct provider access requires a trusted proxy.");
  }
  add("pass", PROXY_POLICY);

  const summary = findings.reduce(
    (acc, finding) => {
      if (finding.severity === "pass") acc.pass += 1;
      else if (finding.severity === "warn") acc.warn += 1;
      else if (finding.severity === "fail") acc.fail += 1;
      return acc;
    },
    { pass: 0, warn: 0, fail: 0 },
  );

  return {
    runtime_identity: runtimeIdentity,
    summary,
    runtime,
    harness,
    providers,
    proxy,
    findings,
    findings_by_severity: {
      pass: findings.filter((finding) => finding.severity === "pass"),
      warn: findings.filter((finding) => finding.severity === "warn"),
      fail: findings.filter((finding) => finding.severity === "fail"),
    },
    notes: [DIAGNOSTIC_ONLY],
  };
}
