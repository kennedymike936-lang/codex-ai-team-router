# Codex AI Cluster architecture

This document defines the v1.0 boundary between the inference control plane and the optional local execution plane. It is intentionally stricter than the product name: adding another model does not automatically create another autonomous agent.

## 1. Control plane: AI Cluster

The AI Cluster is responsible for model capacity, not project authority. `budget_route` receives a task, optional messages, a cost mode, provider constraints, capability requirements, and an execution flag. It then:

1. discovers models from configured providers;
2. merges live data with dated, conservative metadata;
3. excludes routes that violate price, capability, privacy, content, context, quota, or cooldown requirements;
4. ranks the remaining routes;
5. executes the selected route only when `dry_run=false`;
6. fails over only for explicitly safe failure classes; and
7. records sanitized operational state locally.

### Routing invariants

- GLM-4.7-Flash is preferred by policy, not hard-coded as an unconditional winner.
- Capability, policy, remaining quota, and health can override preference.
- `free_only` accepts only models with confirmed zero input and output prices.
- Unknown prices and temporary promotional credits are not free capacity.
- A 401 or 403 stops execution; credentials are not tested against another provider.
- Safe fallback is limited to quota/capacity responses, rate limits, empty output, and server-side failures.
- Provider/model cooldown state prevents immediate retry storms.
- Request accounting is based on successful local executions and provider-reported usage where available.
- Prompts, responses, credentials, and hidden reasoning are excluded from Mission Control and fabric status output.

## 2. Execution plane: AI Team

The AI Team exists only for tasks that need a bounded worker workflow. It does not control the cluster and it does not replace Codex as final authority.

### Roles

- **Codex:** task owner, architect, exception handler, integrator, and final reviewer.
- **Qwen:** default free-first local worker for inspection and implementation.
- **DeepSeek:** paid worker available only by explicit request or explicit paid failover permission.
- **Grok Search:** read-only live Web/X scout; it never receives local file or secret-bearing tasks.
- **Scout:** read-only filesystem discovery and compact evidence collection.
- **Worker:** the only model-controlled writer during an implementation stage.
- **Gate:** deterministic checks and a structured accept/retry/takeover decision.

### Execution invariants

- Planning and inspection are read-only.
- At most one coding worker writes to a workspace at a time.
- `allowed_paths` narrows implementation scope when supplied.
- Eligible clean Git repositories use a temporary detached worktree by default.
- Validation is selected by risk: fast, standard, or full.
- One targeted retry is the maximum automatic rework loop.
- Hard failures immediately return control to Codex.
- Full worker artifacts stay on disk; MCP responses are compact by default.

## 3. State and observability

The runtime stores only the operational information required for routing and review:

- model and provider identifiers;
- timestamps and sanitized event types;
- status codes and classified failure reasons;
- request/token counters where available;
- quota reset timestamps and locally enforceable caps;
- queue, circuit, health, and cooldown state;
- worker task identifiers, changed-file summaries, and Gate decisions.

Mission Control binds to `127.0.0.1` and is optional. Its expert-debate view contains explicit model outputs such as proposals, challenges, citations, and decisions. It is not a chain-of-thought viewer.

## 4. Trust boundaries

Provider APIs, discovered metadata, repository content, worker output, project scripts, environment variables, and dependencies are separate trust boundaries. The control plane reduces accidental cost and noisy failure; the Gate reduces integration risk. Neither is a security sandbox.

The project therefore keeps four forms of authority separate:

| Authority | Owner |
|---|---|
| Decide what the user asked for | Codex |
| Select eligible inference capacity | AI Cluster router |
| Modify a bounded local workspace | One AI Team worker |
| Accept the final result | Deterministic Gate plus Codex |

## 5. Compatibility policy

v1.0 changes the public product identity, package name, MCP server identity, example MCP entry, and deployed directory. Historical `AI_TEAM_*` environment variables remain accepted as compatibility names because renaming credentials and state paths provides no architectural benefit. A future removal requires a deprecation cycle and a migration note.

The repository URL remains `codex-ai-team-router` to preserve existing clones, issues, and links. Repository naming may be revisited separately from runtime compatibility.
