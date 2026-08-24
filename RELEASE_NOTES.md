# Codex AI Cluster v1.0.1

> v1.0.1 is the recommended build. It contains the full Codex AI Cluster v1.0 launch plus a Windows PowerShell 5.1 encoding fix discovered by the first public CI run. The routing behavior and architecture are unchanged from v1.0.0.

Codex AI Cluster v1.0.0 turns the original AI Team Router into a real multi-provider inference control plane. Codex remains the commander and final reviewer, while the cluster manages model discovery, eligibility, quotas, health, failover, and observability. The previous AI Team workflow remains available as a separate, optional local execution plane.

## Release highlights

### GLM is now the primary route

Zhipu GLM-4.7-Flash is the preferred default for eligible free-tier work. The preference is implemented as a visible routing-policy component, not an unconditional shortcut: capabilities, policy constraints, health, cooldown, remaining quota, context requirements, and explicit provider filters still take precedence.

### One cluster across multiple free pools

The new `budget_route` tool can discover and route across Zhipu, OpenRouter, Cloudflare Workers AI, Groq, ModelScope, NVIDIA NIM, Mistral, Gemini, SiliconFlow, OpenAI, and generic OpenAI-compatible endpoints.

The included policy catalog covers:

- Zhipu GLM-4.7-Flash as the preferred primary, with GLM-4.6 and GLM-4.5 as account-dependent capacity;
- a locally enforced 50-call daily OpenRouter pool split 10/10/20/10 across GLM 5.2, Inkling, North Mini Code, and Nemotron Ultra;
- Cloudflare Gemma 4 26B and Nemotron 3 120B under a shared 10,000-neuron free allocation policy;
- Groq GPT-OSS 120B and Qwen 3.6 27B;
- ModelScope GLM 4.7 Flash, DeepSeek V4 Flash, and Step 3.7 Flash;
- NVIDIA Nemotron 3 Ultra 550B; and
- Mistral promotional-credit routes that are deliberately not mislabeled as permanently free.

Free plans and catalogs change. The router merges dated metadata with live account discovery and never treats an unknown price as free.

### Paid DeepSeek is contained

DeepSeek is no longer an automatic fallback. It can be used only when the request explicitly selects it or explicitly enables a paid fallback. This keeps ordinary worker failures from becoming surprise paid calls.

### Resilient provider runtime

The cluster adds persistent request records, provider/model cooldowns, queue limits, circuit state, retry-after handling, and sanitized health inspection. Failover is limited to safe operational failures such as rate limits, quota/capacity responses, empty output, and server errors. Authentication and permission failures stop the route.

### Mission Control now represents the whole cluster

The optional local Mission Control window lists the configured provider/model roster and displays assignments, failovers, explicit expert debate, quota state, and final decisions. It binds only to `127.0.0.1` and excludes prompts, credentials, raw model responses, private artifacts, and hidden reasoning.

### AI Team remains available — as an execution plane

`project_task`, `routine_workpack`, `delegate_task`, `grok_search`, and `worker_gate_review` preserve bounded delegation. Local implementation remains single-writer, uses risk-tiered deterministic validation, allows at most one targeted automatic retry, and returns control to Codex on hard failure.

## Breaking identity changes

- Product: `Codex AI Team Router` → `Codex AI Cluster`
- Private package: `codex-ai-team-router` → `codex-ai-cluster-router`
- MCP server identity: `ai-team-mcp-server` → `ai-cluster-mcp-server`
- Example Codex MCP entry: `ai_team_mcp` → `ai_cluster_mcp`
- Deployed runtime directory: `ai-team-mcp-server` → `ai-cluster-mcp-server`

The historical GitHub repository URL remains unchanged, and existing `AI_TEAM_*` environment variables remain supported in v1.0 for compatibility.

## Validation

The release passed the complete offline Node.js and PowerShell suite, including provider routing, GLM preference, quota accounting, cooldowns, runtime circuits, credential redaction, Mission Control binding/redaction, Worker Protocol v2, worktree isolation, project-task retry/takeover behavior, proxy safety, and 19 deterministic Gate scenarios. The worker scripts are UTF-8 BOM-safe for Windows PowerShell 5.1 on non-Chinese runners. `npm audit` reported zero known dependency vulnerabilities at release time.

See the [README](README.md), [architecture specification](ARCHITECTURE.md), [changelog](CHANGELOG.md), and [security policy](SECURITY.md) for installation, migration, and trust-boundary details.
