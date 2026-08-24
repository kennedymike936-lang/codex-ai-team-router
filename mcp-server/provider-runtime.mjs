const RETRYABLE_STATUSES = new Set([402, 429, 498, 500, 502, 503, 504]);

export class ProviderRuntimeError extends Error {
  constructor(message, code, provider) {
    super(message);
    this.name = "ProviderRuntimeError";
    this.code = code;
    this.provider = provider;
  }
}

export class ProviderRuntime {
  constructor({
    provider,
    maxConcurrency = 2,
    maxQueue = 32,
    timeoutMs = 60_000,
    failureThreshold = 3,
    cooldownMs = 30_000,
    now = () => Date.now(),
    stateStore = null,
  } = {}) {
    if (!provider) throw new Error("ProviderRuntime requires provider.");
    this.provider = String(provider);
    this.maxConcurrency = Math.max(1, Number(maxConcurrency) || 1);
    this.maxQueue = Math.max(0, Number(maxQueue) || 0);
    this.timeoutMs = Math.max(1, Number(timeoutMs) || 60_000);
    this.failureThreshold = Math.max(1, Number(failureThreshold) || 1);
    this.cooldownMs = Math.max(1, Number(cooldownMs) || 30_000);
    this.now = now;
    this.stateStore = stateStore;
    this.active = 0;
    this.queue = [];
    this.circuit = "closed";
    this.failureCount = 0;
    this.openedAt = 0;
    this.halfOpenProbeActive = false;
  }

  snapshot() {
    return {
      provider: this.provider,
      circuit: this.circuit,
      active: this.active,
      queued: this.queue.length,
      max_concurrency: this.maxConcurrency,
      max_queue: this.maxQueue,
      failure_count: this.failureCount,
      opened_at: this.openedAt || null,
    };
  }

  _persist() {
    if (!this.stateStore?.recordProviderState) return;
    void this.stateStore.recordProviderState(this.snapshot()).catch(() => {});
  }

  _refreshCircuit() {
    if (this.circuit === "open" && this.now() - this.openedAt >= this.cooldownMs) {
      this.circuit = "half_open";
      this.halfOpenProbeActive = false;
      this._persist();
    }
  }

  reportSuccess() {
    this.failureCount = 0;
    this.openedAt = 0;
    this.circuit = "closed";
    this.halfOpenProbeActive = false;
    this._persist();
  }

  reportFailure(status = null) {
    if (status != null && !RETRYABLE_STATUSES.has(Number(status))) return;
    this.failureCount += 1;
    if (this.circuit === "half_open" || this.failureCount >= this.failureThreshold) {
      this.circuit = "open";
      this.openedAt = this.now();
      this.halfOpenProbeActive = false;
    }
    this._persist();
  }

  run(operation, { timeoutMs = this.timeoutMs } = {}) {
    if (typeof operation !== "function") return Promise.reject(new Error("Provider operation must be a function."));
    this._refreshCircuit();
    if (this.circuit === "open") {
      return Promise.reject(new ProviderRuntimeError(`${this.provider} circuit is open.`, "PROVIDER_CIRCUIT_OPEN", this.provider));
    }
    if (this.circuit === "half_open" && (this.halfOpenProbeActive || this.active > 0)) {
      return Promise.reject(new ProviderRuntimeError(`${this.provider} half-open probe is already running.`, "PROVIDER_CIRCUIT_OPEN", this.provider));
    }
    if (this.active >= this.maxConcurrency && this.queue.length >= this.maxQueue) {
      return Promise.reject(new ProviderRuntimeError(`${this.provider} queue is full.`, "PROVIDER_QUEUE_FULL", this.provider));
    }
    return new Promise((resolve, reject) => {
      this.queue.push({ operation, timeoutMs: Math.max(1, Number(timeoutMs) || this.timeoutMs), resolve, reject });
      this._drain();
    });
  }

  _drain() {
    this._refreshCircuit();
    while (this.active < this.maxConcurrency && this.queue.length > 0) {
      if (this.circuit === "open") break;
      if (this.circuit === "half_open" && (this.halfOpenProbeActive || this.active > 0)) break;
      const item = this.queue.shift();
      this.active += 1;
      if (this.circuit === "half_open") this.halfOpenProbeActive = true;
      this._execute(item);
    }
  }

  async _execute(item) {
    const controller = new AbortController();
    let timer;
    try {
      const timeout = new Promise((_, reject) => {
        timer = setTimeout(() => {
          controller.abort();
          reject(new ProviderRuntimeError(`${this.provider} request timed out.`, "PROVIDER_TIMEOUT", this.provider));
        }, item.timeoutMs);
      });
      const value = await Promise.race([
        Promise.resolve().then(() => item.operation({ signal: controller.signal })),
        timeout,
      ]);
      item.resolve(value);
    } catch (error) {
      item.reject(error);
    } finally {
      if (timer) clearTimeout(timer);
      this.active -= 1;
      if (this.circuit === "half_open") this.halfOpenProbeActive = false;
      this._persist();
      queueMicrotask(() => this._drain());
    }
  }
}

export class ProviderRuntimePool {
  constructor({ defaults = {}, providers = {}, stateStore = null, now } = {}) {
    this.defaults = defaults;
    this.providers = providers;
    this.stateStore = stateStore;
    this.now = now;
    this.runtimes = new Map();
  }

  runtime(provider) {
    const name = String(provider || "").toLowerCase();
    if (!this.runtimes.has(name)) {
      this.runtimes.set(name, new ProviderRuntime({
        provider: name,
        ...this.defaults,
        ...(this.providers[name] || {}),
        stateStore: this.stateStore,
        ...(this.now ? { now: this.now } : {}),
      }));
    }
    return this.runtimes.get(name);
  }

  run(provider, operation, options) {
    return this.runtime(provider).run(operation, options);
  }

  reportSuccess(provider) {
    this.runtime(provider).reportSuccess();
  }

  reportFailure(provider, status) {
    this.runtime(provider).reportFailure(status);
  }

  snapshots() {
    return Object.fromEntries([...this.runtimes.entries()].map(([name, runtime]) => [name, runtime.snapshot()]));
  }
}
