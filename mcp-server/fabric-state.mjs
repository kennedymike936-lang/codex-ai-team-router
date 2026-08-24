import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { homedir } from "node:os";

const DEFAULT_PATH = join(homedir(), ".codex-ai-team", "state", "fabric.sqlite");

class MemoryFabricStateStore {
  constructor(reason = "persistence_disabled") {
    this.backend = "memory";
    this.fallback_reason = reason;
    this.providers = new Map();
    this.usage = [];
    this.requests = [];
    this.transitions = [];
    this.missionEvents = [];
    this.nextMissionEventId = 1;
  }

  async recordProviderState(state = {}) {
    const safe = safeProviderState(state);
    this.providers.set(safe.provider, safe);
  }

  async recordUsage(event = {}) {
    this.usage.push(safeUsage(event));
  }

  async recordRequest(event = {}) {
    this.requests.push(safeRequest(event));
  }

  async countRequests({ provider = "", model = "", since = 0 } = {}) {
    return this.requests.filter((event) =>
      event.provider === String(provider) &&
      event.model === String(model) &&
      event.created_at >= number(since)
    ).length;
  }

  async recordTaskTransition(event = {}) {
    this.transitions.push(safeTransition(event));
  }

  async recordMissionEvent(event = {}) {
    const safe = { id: this.nextMissionEventId++, ...safeMissionEvent(event) };
    this.missionEvents.push(safe);
    if (this.missionEvents.length > 1000) this.missionEvents.splice(0, this.missionEvents.length - 1000);
    return safe;
  }

  async listMissionEvents({ after = 0, limit = 200 } = {}) {
    const boundedLimit = Math.max(1, Math.min(500, number(limit) || 200));
    return this.missionEvents.filter((event) => event.id > number(after)).slice(-boundedLimit);
  }

  async snapshot() {
    return {
      backend: this.backend,
      providers: [...this.providers.values()],
      usage: [...this.usage],
      requests: [...this.requests],
      transitions: [...this.transitions],
      mission_events: [...this.missionEvents],
    };
  }

  async flush() {}
  async close() {}
}

function text(value, max = 240) {
  return String(value || "").slice(0, max);
}

function number(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function safeProviderState(state) {
  return {
    provider: text(state.provider, 80),
    circuit: ["closed", "open", "half_open"].includes(state.circuit) ? state.circuit : "closed",
    active: number(state.active),
    queued: number(state.queued),
    failure_count: number(state.failure_count),
    opened_at: state.opened_at == null ? null : number(state.opened_at),
    updated_at: Date.now(),
  };
}

function safeUsage(event) {
  return {
    provider: text(event.provider, 80),
    model: text(event.model, 240),
    input_tokens: number(event.input_tokens),
    output_tokens: number(event.output_tokens),
    status: number(event.status),
    created_at: number(event.created_at) || Date.now(),
  };
}

function safeRequest(event) {
  return {
    provider: text(event.provider, 80),
    model: text(event.model, 240),
    status: number(event.status),
    created_at: number(event.created_at) || Date.now(),
  };
}

function safeTransition(event) {
  return {
    task_id: text(event.task_id, 120),
    from_state: text(event.from_state, 40),
    to_state: text(event.to_state, 40),
    created_at: number(event.created_at) || Date.now(),
  };
}

function missionText(value, max = 320) {
  return text(value, max)
    .replace(/\b(?:sk-|gsk_|cfut_)[A-Za-z0-9._-]{16,}\b/gi, "[redacted]")
    .replace(/\bnvapi-[A-Za-z0-9_-]{16,}\b/g, "[redacted]")
    .replace(/\bms-[A-Za-z0-9_-]{16,}\b/g, "[redacted]")
    .replace(/\bBearer\s+[A-Za-z0-9._~-]{12,}\b/gi, "Bearer [redacted]")
    .replace(/\bapi[_ -]?key\s*[:=]\s*[^\s,;]+/gi, "api_key=[redacted]");
}

export function safeMissionEvent(event = {}) {
  return {
    task_id: missionText(event.task_id, 120),
    type: missionText(event.type, 64).replace(/[^a-z0-9_.-]/gi, "_") || "system.event",
    actor: missionText(event.actor, 64) || "system",
    title: missionText(event.title, 160),
    detail: missionText(event.detail, 500),
    status: missionText(event.status, 32) || "info",
    created_at: number(event.created_at) || Date.now(),
  };
}

class SqliteFabricStateStore {
  constructor(db, path) {
    this.backend = "sqlite";
    this.path = path;
    this.db = db;
    this._writer = Promise.resolve();
    this.db.exec(`
      PRAGMA journal_mode=WAL;
      PRAGMA synchronous=NORMAL;
      CREATE TABLE IF NOT EXISTS provider_state (
        provider TEXT PRIMARY KEY, circuit TEXT NOT NULL, active INTEGER NOT NULL,
        queued INTEGER NOT NULL, failure_count INTEGER NOT NULL,
        opened_at INTEGER, updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS usage_event (
        id INTEGER PRIMARY KEY AUTOINCREMENT, provider TEXT NOT NULL, model TEXT NOT NULL,
        input_tokens INTEGER NOT NULL, output_tokens INTEGER NOT NULL,
        status INTEGER NOT NULL, created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS request_event (
        id INTEGER PRIMARY KEY AUTOINCREMENT, provider TEXT NOT NULL, model TEXT NOT NULL,
        status INTEGER NOT NULL, created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS request_event_provider_model_created
        ON request_event(provider, model, created_at);
      CREATE TABLE IF NOT EXISTS task_transition (
        id INTEGER PRIMARY KEY AUTOINCREMENT, task_id TEXT NOT NULL,
        from_state TEXT NOT NULL, to_state TEXT NOT NULL, created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS mission_event (
        id INTEGER PRIMARY KEY AUTOINCREMENT, task_id TEXT NOT NULL,
        type TEXT NOT NULL, actor TEXT NOT NULL, title TEXT NOT NULL,
        detail TEXT NOT NULL, status TEXT NOT NULL, created_at INTEGER NOT NULL
      );
    `);
  }

  _write(operation) {
    const run = this._writer.then(operation);
    this._writer = run.catch(() => {});
    return run;
  }

  recordProviderState(state = {}) {
    const value = safeProviderState(state);
    return this._write(() => {
      this.db.prepare(`INSERT INTO provider_state
        (provider,circuit,active,queued,failure_count,opened_at,updated_at)
        VALUES (?,?,?,?,?,?,?)
        ON CONFLICT(provider) DO UPDATE SET circuit=excluded.circuit,active=excluded.active,
        queued=excluded.queued,failure_count=excluded.failure_count,
        opened_at=excluded.opened_at,updated_at=excluded.updated_at`).run(
        value.provider, value.circuit, value.active, value.queued,
        value.failure_count, value.opened_at, value.updated_at,
      );
    });
  }

  recordUsage(event = {}) {
    const value = safeUsage(event);
    return this._write(() => {
      this.db.prepare(`INSERT INTO usage_event
        (provider,model,input_tokens,output_tokens,status,created_at) VALUES (?,?,?,?,?,?)`).run(
        value.provider, value.model, value.input_tokens, value.output_tokens, value.status, value.created_at,
      );
    });
  }

  recordRequest(event = {}) {
    const value = safeRequest(event);
    return this._write(() => {
      this.db.prepare(`INSERT INTO request_event
        (provider,model,status,created_at) VALUES (?,?,?,?)`).run(
        value.provider, value.model, value.status, value.created_at,
      );
    });
  }

  async countRequests({ provider = "", model = "", since = 0 } = {}) {
    await this.flush();
    const row = this.db.prepare(`SELECT COUNT(*) AS count FROM request_event
      WHERE provider = ? AND model = ? AND created_at >= ?`).get(
        String(provider), String(model), number(since),
      );
    return number(row?.count);
  }

  recordTaskTransition(event = {}) {
    const value = safeTransition(event);
    return this._write(() => {
      this.db.prepare(`INSERT INTO task_transition
        (task_id,from_state,to_state,created_at) VALUES (?,?,?,?)`).run(
        value.task_id, value.from_state, value.to_state, value.created_at,
      );
    });
  }

  recordMissionEvent(event = {}) {
    const value = safeMissionEvent(event);
    return this._write(() => {
      const result = this.db.prepare(`INSERT INTO mission_event
        (task_id,type,actor,title,detail,status,created_at) VALUES (?,?,?,?,?,?,?)`).run(
        value.task_id, value.type, value.actor, value.title,
        value.detail, value.status, value.created_at,
      );
      return { id: Number(result.lastInsertRowid), ...value };
    });
  }

  async listMissionEvents({ after = 0, limit = 200 } = {}) {
    await this.flush();
    const boundedLimit = Math.max(1, Math.min(500, number(limit) || 200));
    return this.db.prepare(`SELECT id,task_id,type,actor,title,detail,status,created_at
      FROM mission_event WHERE id > ? ORDER BY id ASC LIMIT ?`).all(number(after), boundedLimit);
  }

  async snapshot() {
    await this.flush();
    return {
      backend: this.backend,
      providers: this.db.prepare("SELECT * FROM provider_state ORDER BY provider").all(),
      usage: this.db.prepare("SELECT provider,model,input_tokens,output_tokens,status,created_at FROM usage_event ORDER BY id").all(),
      requests: this.db.prepare("SELECT provider,model,status,created_at FROM request_event ORDER BY id").all(),
      transitions: this.db.prepare("SELECT task_id,from_state,to_state,created_at FROM task_transition ORDER BY id").all(),
      mission_events: this.db.prepare("SELECT id,task_id,type,actor,title,detail,status,created_at FROM mission_event ORDER BY id DESC LIMIT 500").all().reverse(),
    };
  }

  async flush() {
    await this._writer;
  }

  async close() {
    await this.flush();
    this.db.close();
  }
}

export async function createFabricStateStore({ path = DEFAULT_PATH, persistent = true } = {}) {
  if (!persistent) return new MemoryFabricStateStore();
  try {
    const { DatabaseSync } = await import("node:sqlite");
    await mkdir(dirname(path), { recursive: true });
    return new SqliteFabricStateStore(new DatabaseSync(path), path);
  } catch (error) {
    return new MemoryFabricStateStore(error?.code || error?.message || "sqlite_unavailable");
  }
}
