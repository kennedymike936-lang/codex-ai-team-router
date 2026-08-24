import assert from "node:assert/strict";
import { ProviderRuntime } from "./provider-runtime.mjs";

{
  const runtime = new ProviderRuntime({ provider: "test", maxConcurrency: 2, maxQueue: 8, timeoutMs: 1_000 });
  let active = 0;
  let maxActive = 0;
  const jobs = Array.from({ length: 6 }, (_, index) => runtime.run(async () => {
    active += 1;
    maxActive = Math.max(maxActive, active);
    await new Promise((resolve) => setTimeout(resolve, 8));
    active -= 1;
    return index;
  }));
  assert.deepEqual(await Promise.all(jobs), [0, 1, 2, 3, 4, 5]);
  assert.equal(maxActive, 2);
}

{
  const runtime = new ProviderRuntime({ provider: "bounded", maxConcurrency: 1, maxQueue: 1, timeoutMs: 1_000 });
  let release;
  const first = runtime.run(() => new Promise((resolve) => { release = resolve; }));
  const second = runtime.run(async () => "second");
  await assert.rejects(runtime.run(async () => "overflow"), (error) => error.code === "PROVIDER_QUEUE_FULL");
  release("first");
  assert.equal(await first, "first");
  assert.equal(await second, "second");
}

{
  let now = 1_000;
  const runtime = new ProviderRuntime({
    provider: "circuit",
    failureThreshold: 2,
    cooldownMs: 100,
    now: () => now,
  });
  runtime.reportFailure(503);
  runtime.reportFailure(503);
  assert.equal(runtime.snapshot().circuit, "open");
  await assert.rejects(runtime.run(async () => "blocked"), (error) => error.code === "PROVIDER_CIRCUIT_OPEN");
  now += 101;
  assert.equal(await runtime.run(async () => "probe"), "probe");
  assert.equal(runtime.snapshot().circuit, "half_open");
  runtime.reportSuccess();
  assert.equal(runtime.snapshot().circuit, "closed");
}

{
  const runtime = new ProviderRuntime({ provider: "timeout", timeoutMs: 10 });
  await assert.rejects(
    runtime.run(() => new Promise(() => {})),
    (error) => error.code === "PROVIDER_TIMEOUT",
  );
}

console.log("provider-runtime-test.mjs: concurrency, queue bounds, timeout, and circuit transitions passed");

