import { mkdirSync, readFileSync, writeFileSync, renameSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { randomUUID } from "node:crypto";

const DEFAULT_STATE_DIR = join(homedir(), ".codex-ai-team", "state");
const STATE_FILE = "providers.json";
const MAX_ENTRIES = 200;
const STALE_DAYS = 7;
const STALE_MS = STALE_DAYS * 86_400_000;
const MAX_COOLDOWN_S = 300;
const BACKOFF_BASE_S = 5;

const RETRYABLE_STATUSES = new Set([402, 429, 498, 500, 502, 503, 504]);

export function modelKey(provider, modelId) {
  return `${String(provider).replace(/[^a-zA-Z0-9._-]/g, "_")}:${String(modelId).replace(/[^a-zA-Z0-9._-]/g, "_")}`;
}

export function parseRetryAfter(value, nowMs) {
  if (value == null) return null;
  const s = String(value).trim();
  if (!s) return null;
  const secs = Number(s);
  if (Number.isFinite(secs) && secs >= 0) {
    return nowMs + Math.min(Math.ceil(secs), MAX_COOLDOWN_S) * 1_000;
  }
  const dateMs = Date.parse(s);
  if (Number.isFinite(dateMs) && dateMs > nowMs) {
    return Math.min(dateMs, nowMs + MAX_COOLDOWN_S * 1_000);
  }
  return null;
}

export function computeBackoffCooldown(attempts, nowMs) {
  const secs = Math.min(BACKOFF_BASE_S * (1 << Math.min(attempts - 1, 5)), MAX_COOLDOWN_S);
  return nowMs + secs * 1_000;
}

export class ProviderHealthTracker {
  constructor({ stateDir = DEFAULT_STATE_DIR, persistent = true, isAuthOrPermissionStop, isSafeFallbackStatus } = {}) {
    this.stateDir = stateDir;
    this.statePath = join(stateDir, STATE_FILE);
    this.persistent = persistent;
    this.isAuthOrPermissionStop = isAuthOrPermissionStop || ((s) => s === 401 || s === 403);
    this.isSafeFallbackStatus = isSafeFallbackStatus || ((s) => RETRYABLE_STATUSES.has(s));
    this._state = {};
    this._loaded = false;
    this._dirty = false;
  }

  _ensureDir() {
    try {
      mkdirSync(this.stateDir, { recursive: true });
    } catch {
      // directory already exists or permissions — fine
    }
  }

  _prune(staleSince) {
    let pruned = false;
    for (const key of Object.keys(this._state)) {
      if (this._state[key].updated_at < staleSince) {
        delete this._state[key];
        pruned = true;
      }
    }
    if (pruned) this._dirty = true;
    // If still over max, drop oldest entries
    const keys = Object.keys(this._state).sort((a, b) => this._state[a].updated_at - this._state[b].updated_at);
    while (keys.length > MAX_ENTRIES) {
      const removed = keys.shift();
      delete this._state[removed];
      this._dirty = true;
    }
  }

  load(nowMs) {
    if (this._loaded) return;
    this._loaded = true;
    if (!this.persistent) return;
    try {
      const raw = readFileSync(this.statePath, "utf8");
      const data = JSON.parse(raw);
      if (data && typeof data === "object" && Array.isArray(data.entries)) {
        for (const entry of data.entries.slice(0, MAX_ENTRIES)) {
          if (!entry || typeof entry.provider !== "string" || typeof entry.model_id !== "string") continue;
          this._state[modelKey(entry.provider, entry.model_id)] = {
            provider: entry.provider,
            model_id: entry.model_id,
            cooldown_end_ms: Number(entry.cooldown_end_ms) || 0,
            failure_count: Number(entry.failure_count) || 0,
            last_status: Number(entry.last_status) || null,
            cleared_at: Number(entry.cleared_at) || 0,
            updated_at: Number(entry.updated_at) || 0,
          };
        }
      }
    } catch {
    }
    this._prune(nowMs - STALE_MS);
  }

  save() {
    if (!this.persistent) return;
    if (!this._dirty) return;
    this._dirty = false;
    this._ensureDir();
    const entries = [];
    for (const entry of Object.values(this._state)) {
      entries.push({
        provider: entry.provider,
        model_id: entry.model_id,
        cooldown_end_ms: entry.cooldown_end_ms,
        failure_count: entry.failure_count,
        last_status: entry.last_status,
        cleared_at: entry.cleared_at,
        updated_at: entry.updated_at,
      });
    }
    const payload = JSON.stringify({ version: 1, updated_at: Date.now(), entries });
    const safe = JSON.stringify({ ...JSON.parse(payload) }, null, 0); // compact, no extra formatting
    const tmpPath = join(this.stateDir, `${STATE_FILE}.${randomUUID()}.tmp`);
    writeFileSync(tmpPath, safe, "utf8");
    try {
      renameSync(tmpPath, this.statePath);
    } catch (error) {
      try { unlinkSync(tmpPath); } catch {}
      this._dirty = true;
      throw error;
    }
  }

  getCooldownRemainingMs(key, nowMs) {
    const entry = this._state[key];
    if (!entry || !entry.cooldown_end_ms) return 0;
    return Math.max(0, entry.cooldown_end_ms - nowMs);
  }

  isActiveCooldown(key, nowMs) {
    return this.getCooldownRemainingMs(key, nowMs) > 0;
  }

  getEntry(key) {
    return this._state[key] ?? null;
  }

  recordFailure(provider, modelId, status, retryAfterHeader, nowMs) {
    const key = modelKey(provider, modelId);
    const existing = this._state[key] || { provider, model_id: modelId, cooldown_end_ms: 0, failure_count: 0, last_status: null, updated_at: 0 };
    existing.failure_count = (existing.failure_count || 0) + 1;
    existing.last_status = Number(status) || null;
    existing.updated_at = nowMs;
    const parsedOverride = parseRetryAfter(retryAfterHeader, nowMs);
    if (parsedOverride != null) {
      existing.cooldown_end_ms = parsedOverride;
    } else {
      const backoff = computeBackoffCooldown(existing.failure_count, nowMs);
      const currentEnd = existing.cooldown_end_ms || 0;
      existing.cooldown_end_ms = Math.max(backoff, currentEnd);
    }
    this._state[key] = existing;
    this._dirty = true;
  }

  recordSuccess(provider, modelId, headers, nowMs) {
    const key = modelKey(provider, modelId);
    const existing = this._state[key] || { provider, model_id: modelId };
    existing.cooldown_end_ms = 0;
    existing.failure_count = 0;
    existing.last_status = null;
    existing.cleared_at = nowMs;
    existing.updated_at = nowMs;
    if (headers && Number.isFinite(headers.remaining_requests)) {
      existing.remaining_requests = headers.remaining_requests;
    }
    if (headers && Number.isFinite(headers.remaining_tokens)) {
      existing.remaining_tokens = headers.remaining_tokens;
    }
    this._state[key] = existing;
    this._dirty = true;
  }

  shouldRecordCooldown(status, preconnectNetworkError = false) {
    if (preconnectNetworkError) return true;
    if (status == null) return false;
    if (this.isAuthOrPermissionStop(status)) return false;
    return this.isSafeFallbackStatus(status);
  }

  checkAndClearCooldown(key, nowMs) {
    const remaining = this.getCooldownRemainingMs(key, nowMs);
    if (remaining <= 0) {
      if (this._state[key]) {
        this._state[key].cooldown_end_ms = 0;
        this._state[key].updated_at = nowMs;
        this._dirty = true;
      }
      return { active: false, reason: null, remaining_ms: 0 };
    }
    return { active: true, reason: "provider_cooldown", remaining_ms: remaining };
  }

  filterActiveCooldown(candidates, nowMs) {
    const included = [];
    const excludedWithReason = [];
    for (const model of candidates) {
      const key = modelKey(model.provider, model.id);
      const result = this.checkAndClearCooldown(key, nowMs);
      if (result.active) {
        excludedWithReason.push({
          id: model.id,
          provider: model.provider,
          reason: "provider_cooldown",
          remaining_ms: result.remaining_ms,
        });
      } else {
        included.push(model);
      }
    }
    return { included, excluded_with_reason: excludedWithReason };
  }
}
