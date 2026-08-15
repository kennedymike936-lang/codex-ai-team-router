import assert from "node:assert/strict";
import {
  NetworkRequestError,
  classifyNetworkError,
  createResilientFetch,
  trustedProxyConfig,
} from "./network-client.mjs";

function failure(code, name = "TypeError") {
  const cause = new Error("socket detail");
  cause.code = code;
  const error = new Error("fetch failed", { cause });
  error.name = name;
  return error;
}

assert.equal(classifyNetworkError(failure("ENOTFOUND")).category, "dns_failed");
assert.equal(classifyNetworkError(failure("EAI_AGAIN")).category, "dns_temporary");
assert.equal(classifyNetworkError(failure("ECONNREFUSED")).category, "connect_refused");
assert.equal(classifyNetworkError(failure("UND_ERR_CONNECT_TIMEOUT")).category, "connect_timeout");
assert.equal(classifyNetworkError(failure("ECONNRESET")).category, "connection_reset");
assert.equal(classifyNetworkError(failure("UNABLE_TO_VERIFY_LEAF_SIGNATURE")).category, "tls_error");

const proxyConfig = trustedProxyConfig({ HTTPS_PROXY: "http://127.0.0.1:7890", AI_TEAM_PROXY_MODE: "fallback" });
assert.equal(proxyConfig.enabled, true);
assert.equal(proxyConfig.mode, "fallback");
assert.match(proxyConfig.noProxy, /localhost/);
assert.equal(Object.values(proxyConfig).join(" ").includes("password"), false);
assert.equal(trustedProxyConfig({ ALL_PROXY: "socks5://127.0.0.1:1080" }).enabled, false);

{
  const routes = [];
  let calls = 0;
  const fetchImpl = async (_url, options) => {
    calls += 1;
    routes.push(options.dispatcher ? "proxy" : "direct");
    if (calls === 1) throw failure("ENOTFOUND");
    return new Response("ok", { status: 200 });
  };
  const fetchWithFallback = createResilientFetch({
    fetchImpl,
    env: { HTTPS_PROXY: "http://127.0.0.1:7890", AI_TEAM_PROXY_MODE: "fallback" },
    sleepImpl: async () => {},
    dispatcherFactory: () => ({ trusted: true }),
  });
  const response = await fetchWithFallback("https://api.example.test/models");
  assert.equal(response.status, 200);
  assert.deepEqual(routes, ["direct", "proxy"]);
}

{
  let calls = 0;
  const fetchWithRetry = createResilientFetch({
    fetchImpl: async () => {
      calls += 1;
      if (calls === 1) throw failure("ECONNREFUSED");
      return new Response("ok", { status: 200 });
    },
    env: {},
    sleepImpl: async () => {},
  });
  await fetchWithRetry("https://api.example.test/responses", { method: "POST" });
  assert.equal(calls, 2);
}

{
  let calls = 0;
  const fetchWithoutReplay = createResilientFetch({
    fetchImpl: async () => { calls += 1; throw failure("ECONNRESET"); },
    env: { HTTPS_PROXY: "http://127.0.0.1:7890" },
    sleepImpl: async () => {},
    dispatcherFactory: () => ({ trusted: true }),
  });
  await assert.rejects(
    fetchWithoutReplay("https://api.example.test/responses", { method: "POST" }),
    (error) => {
      assert.ok(error instanceof NetworkRequestError);
      assert.equal(error.diagnostic.category, "connection_reset");
      assert.equal(error.diagnostic.delivery_uncertain, true);
      assert.equal(error.diagnostic.attempts, 1);
      assert.equal(error.diagnostic.proxy.configured, true);
      assert.equal(JSON.stringify(error.diagnostic).includes("7890"), false);
      return true;
    },
  );
  assert.equal(calls, 1);
}

console.log("Network client: 15 diagnosis, retry, and trusted-proxy scenarios passed");
