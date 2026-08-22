import { EnvHttpProxyAgent, fetch as undiciFetch } from "undici";
import { execFileSync } from "node:child_process";

const PRECONNECT_CATEGORIES = new Set([
  "dns_failed",
  "dns_temporary",
  "connect_refused",
  "connect_timeout",
  "network_unreachable",
]);

const TRANSIENT_CATEGORIES = new Set([
  ...PRECONNECT_CATEGORIES,
  "connection_reset",
  "request_timeout",
  "fetch_failed",
]);

function firstEnv(env, lower, upper) {
  return String(env[lower] || env[upper] || "").trim();
}

function validHttpProxy(value) {
  if (!value) return "";
  try {
    const parsed = new URL(value);
    return ["http:", "https:"].includes(parsed.protocol) ? value : "";
  } catch {
    return "";
  }
}

function safeNoProxy(value) {
  return [...new Set(["localhost", "127.0.0.1", "::1", ...String(value || "").split(/[ ,]+/).filter(Boolean)])].join(",");
}

export function windowsSystemProxyUrl() {
  if (process.platform !== "win32") return "";
  try {
    const script = "$p=Get-ItemProperty -LiteralPath 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings' -ErrorAction Stop;if($p.ProxyEnable -ne 1){exit 0};[Console]::Out.Write([string]$p.ProxyServer)";
    let value = String(execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
      encoding: "utf8", windowsHide: true, timeout: 3000,
    }) || "").trim();
    if (!value) return "";
    if (value.includes("=")) {
      const entries = Object.fromEntries(value.split(";").map((part) => part.split("=", 2)).filter((part) => part.length === 2));
      value = entries.https || entries.http || "";
    }
    if (value && !/^https?:\/\//i.test(value)) value = `http://${value}`;
    return validHttpProxy(value);
  } catch {
    return "";
  }
}

export function trustedProxyConfig(env = process.env, systemProxyUrl = "") {
  const explicit = String(env.AI_TEAM_TRUSTED_PROXY_URL || "").trim();
  const allProxy = firstEnv(env, "all_proxy", "ALL_PROXY");
  const httpProxy = validHttpProxy(explicit || firstEnv(env, "http_proxy", "HTTP_PROXY") || allProxy);
  const httpsProxy = validHttpProxy(explicit || firstEnv(env, "https_proxy", "HTTPS_PROXY") || allProxy || httpProxy);
  const requestedMode = String(env.AI_TEAM_PROXY_MODE || "fallback").trim().toLowerCase();
  const mode = ["off", "fallback", "always"].includes(requestedMode) ? requestedMode : "fallback";
  const proxies = [];
  if (httpProxy || httpsProxy) proxies.push({ httpProxy, httpsProxy, source: explicit ? "explicit" : "environment" });
  const systemProxy = validHttpProxy(systemProxyUrl);
  if (systemProxy && !proxies.some((item) => item.httpProxy === systemProxy && item.httpsProxy === systemProxy)) {
    proxies.push({ httpProxy: systemProxy, httpsProxy: systemProxy, source: "windows_system" });
  }
  return {
    configured: proxies.length > 0,
    enabled: mode !== "off" && proxies.length > 0,
    mode,
    httpProxy,
    httpsProxy,
    noProxy: safeNoProxy(firstEnv(env, "no_proxy", "NO_PROXY")),
    proxies,
  };
}

function errorChain(error) {
  const chain = [];
  let current = error;
  while (current && chain.length < 6) {
    chain.push(current);
    current = current.cause;
  }
  return chain;
}

export function classifyNetworkError(error) {
  const chain = errorChain(error);
  const codes = chain.map((item) => String(item?.code || "").toUpperCase()).filter(Boolean);
  const names = chain.map((item) => String(item?.name || "")).filter(Boolean);
  const messages = chain.map((item) => String(item?.message || "")).join(" ").toLowerCase();
  const hasCode = (...values) => values.some((value) => codes.includes(value));

  let category = "fetch_failed";
  if (hasCode("ENOTFOUND")) category = "dns_failed";
  else if (hasCode("EAI_AGAIN")) category = "dns_temporary";
  else if (hasCode("ECONNREFUSED")) category = "connect_refused";
  else if (hasCode("UND_ERR_CONNECT_TIMEOUT")) category = "connect_timeout";
  else if (hasCode("ENETUNREACH", "EHOSTUNREACH")) category = "network_unreachable";
  else if (hasCode("ECONNRESET", "UND_ERR_SOCKET")) category = "connection_reset";
  else if (
    codes.some((code) => code.startsWith("ERR_TLS_") || code.startsWith("CERT_") || code.includes("CERT")) ||
    hasCode("UNABLE_TO_VERIFY_LEAF_SIGNATURE", "DEPTH_ZERO_SELF_SIGNED_CERT") ||
    /certificate|tls handshake|self[- ]signed/.test(messages)
  ) category = "tls_error";
  else if (names.includes("AbortError") || names.includes("TimeoutError") || hasCode("ETIMEDOUT", "UND_ERR_HEADERS_TIMEOUT", "UND_ERR_BODY_TIMEOUT")) {
    category = "request_timeout";
  }

  const advice = {
    dns_failed: "Check DNS and the provider hostname. A proxy may help only if direct DNS is blocked.",
    dns_temporary: "DNS appears temporarily unavailable; retry after checking the network signal.",
    connect_refused: "The destination or configured proxy refused the connection; verify its host and port.",
    connect_timeout: "The connection could not be established in time; check routing, firewall, or a trusted proxy.",
    network_unreachable: "No usable route to the provider was found; check the active network and firewall.",
    connection_reset: "The connection was reset after it started; delivery is uncertain, so paid POST requests are not replayed.",
    request_timeout: "The request timed out after it started; delivery is uncertain, so paid POST requests are not replayed.",
    tls_error: "TLS verification failed. Fix the certificate trust chain; never disable certificate validation.",
    fetch_failed: "The network request failed for an unclassified reason; inspect the underlying network or proxy logs.",
  };
  return {
    category,
    code: codes[0] || null,
    transient: TRANSIENT_CATEGORIES.has(category),
    preconnect: PRECONNECT_CATEGORIES.has(category),
    advice: advice[category],
  };
}

export class NetworkRequestError extends Error {
  constructor(diagnostic) {
    super(`Network request failed (${diagnostic.category}). ${diagnostic.advice}`);
    this.name = "NetworkRequestError";
    this.diagnostic = diagnostic;
  }
}

export function isNetworkRequestError(error) {
  return error instanceof NetworkRequestError || error?.name === "NetworkRequestError";
}

function replayIsSafe(method, classification) {
  if (["GET", "HEAD", "OPTIONS"].includes(method)) return classification.transient;
  return classification.preconnect;
}

function originFor(url) {
  try { return new URL(url).origin; } catch { return "unknown"; }
}

export function createResilientFetch({
  fetchImpl = undiciFetch,
  env = process.env,
  sleepImpl = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
  dispatcherFactory = (config) => new EnvHttpProxyAgent({
    httpProxy: config.httpProxy || undefined,
    httpsProxy: config.httpsProxy || undefined,
    noProxy: config.noProxy || undefined,
  }),
  inheritSystemProxy = env === process.env,
  systemProxyResolver = windowsSystemProxyUrl,
} = {}) {
  const proxy = trustedProxyConfig(env, inheritSystemProxy ? systemProxyResolver() : "");
  const proxyDispatchers = new Map();

  return async function resilientFetch(url, options = {}) {
    const method = String(options.method || "GET").toUpperCase();
    const proxyRoutes = proxy.proxies.map((config, index) => ({ kind: "proxy", config, index }));
    const attemptRoutes = proxy.enabled && proxy.mode === "always"
      ? [...proxyRoutes, { kind: "direct" }]
      : proxy.enabled && proxy.mode === "fallback"
        ? [{ kind: "direct" }, ...proxyRoutes]
        : [{ kind: "direct" }, { kind: "direct" }];
    let lastClassification = null;

    for (let attempt = 0; attempt < attemptRoutes.length; attempt += 1) {
      const route = attemptRoutes[attempt];
      const requestOptions = { ...options };
      if (route.kind === "proxy") {
        if (!proxyDispatchers.has(route.index)) {
          proxyDispatchers.set(route.index, dispatcherFactory({ ...route.config, noProxy: proxy.noProxy }));
        }
        requestOptions.dispatcher = proxyDispatchers.get(route.index);
      }
      try {
        return await fetchImpl(url, requestOptions);
      } catch (error) {
        const classification = classifyNetworkError(error);
        lastClassification = classification;
        const hasNextAttempt = attempt + 1 < attemptRoutes.length;
        if (!hasNextAttempt || !replayIsSafe(method, classification)) {
          throw new NetworkRequestError({
            kind: "network_failure",
            ...classification,
            origin: originFor(url),
            method,
            attempts: attempt + 1,
            delivery_uncertain: !classification.preconnect && !["GET", "HEAD", "OPTIONS"].includes(method),
            proxy: {
              configured: proxy.configured,
              mode: proxy.mode,
              attempted: attemptRoutes.slice(0, attempt + 1).some((item) => item.kind === "proxy"),
            },
          });
        }
        await sleepImpl(250 * (attempt + 1));
      }
    }

    throw new NetworkRequestError({
      kind: "network_failure",
      ...lastClassification,
      origin: originFor(url),
      method,
      attempts: attemptRoutes.length,
      delivery_uncertain: false,
      proxy: { configured: proxy.configured, mode: proxy.mode, attempted: attemptRoutes.some((item) => item.kind === "proxy") },
    });
  };
}

export const resilientFetch = createResilientFetch();
