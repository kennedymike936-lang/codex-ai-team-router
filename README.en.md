# Codex AI Team Router

[Simplified Chinese](README.md) | English

Codex AI Team Router is an MIT-licensed local MCP server that lets Codex remain the project manager and final reviewer while delegating bounded work to Qwen, DeepSeek, and read-only Grok Search.

The project is designed for Windows-based maintainer workflows. It combines model routing with local PowerShell workers and a deterministic Gate that checks tests, change scope, diff size, and secret-like content before Codex accepts a result.

> This is an early-stage project. Routing decisions and quality scores are heuristics, not security guarantees. Review agent-generated changes before merging or releasing them.

## What it provides

- One MCP server with seven tools: `delegate_task`, `grok_search`, `budget_route`, `doctor`, `project_task`, `routine_workpack`, and `worker_gate_review`.
- Automatic routing between Qwen and DeepSeek based on task type and complexity.
- Optional read-only Web/X research through Grok Search.
- Staged multi-agent work: read-only planning, one writing worker, then deterministic validation.
- Bounded working directories and optional allowed-path enforcement.
- Build, test, type-check, lint, diff-size, scope, and secret-pattern checks where supported by the target project.
- Compact MCP responses with full worker artifacts stored locally.
- Exception-driven routine workpacks: up to 12 bounded chores are split into a read-only lane and one writer lane with a mandatory Gate, while risky or unbounded items are returned to Codex as a compact exception packet.
- Local token and cost ledgers based on provider-reported usage when available.
- Persistent provider/model health and cooldown state, with retryable failures separated from terminal authentication, permission, invalid-request, and safety failures.
- Clean Git implementations run in temporary detached worktrees; accepted Gate patches return only when the original HEAD and clean state are unchanged.
- Redacted route decisions and resumable checkpoints feed a read-only shadow analyzer; routing weights are never changed automatically.
- On Windows, the router can inherit the enabled system HTTP/HTTPS proxy and safely move past a stale explicit loopback endpoint only after a pre-connect failure; diagnostics never expose endpoints or credentials.
- Explainable, budget-aware OpenRouter and Groq selection with conservative capability and privacy filtering.
- An isolated eight-task benchmark with hidden acceptance checks.

## Requirements

- Windows PowerShell
- Node.js 20 or later
- npm and Git
- Codex Desktop or another MCP-compatible Codex environment
- At least one supported provider API key

The optional local worker harness is Qwen Code CLI. It runs both Qwen and DeepSeek through isolated OpenAI-compatible provider settings; Claude Code is not required.

## Install

```powershell
git clone https://github.com/kennedymike936-lang/codex-ai-team-router.git
cd codex-ai-team-router
powershell -NoProfile -ExecutionPolicy Bypass -File .\install.ps1
```

The installer installs the locked Node dependencies when possible, runs the complete offline test suite, and prints the absolute Node and MCP server paths.

To deploy a separate runtime copy:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\install.ps1 -DeployRoot "D:\AI-Team"
```

## Configure Codex

Copy and adapt [examples/config.toml.example](examples/config.toml.example). Use absolute paths:

```toml
[mcp_servers.ai_team_mcp]
command = 'C:\Program Files\nodejs\node.exe'
args = ['C:\absolute\path\codex-ai-team-router\mcp-server\server.mjs']
startup_timeout_sec = 60

[mcp_servers.ai_team_mcp.env]
QWEN_MCP_BASE_URL = 'https://dashscope.aliyuncs.com/compatible-mode/v1'
DEEPSEEK_MCP_BASE_URL = 'https://api.deepseek.com/anthropic'
XAI_MCP_BASE_URL = 'https://api.x.ai/v1'
OPENROUTER_MCP_BASE_URL = 'https://openrouter.ai/api/v1'
GROQ_MCP_BASE_URL = 'https://api.groq.com/openai/v1'
GEMINI_MCP_BASE_URL = 'https://generativelanguage.googleapis.com/v1beta'
SILICONFLOW_MCP_BASE_URL = 'https://api.siliconflow.cn/v1'
```

Provider keys are read from environment variables. Do not put keys in the repository, prompts, or Codex configuration examples.

Network failures are classified as DNS, connect timeout/refusal, unreachable network, reset connection, TLS, request timeout, or unknown fetch failure. Safely replayable failures receive at most one bounded retry. Paid POST requests are not replayed after a reset or timeout when delivery is uncertain. Configure only a trusted HTTP/HTTPS proxy through `AI_TEAM_TRUSTED_PROXY_URL` or standard `HTTPS_PROXY` / `HTTP_PROXY` variables. `AI_TEAM_PROXY_MODE` accepts `fallback` (default), `always`, or `off`; public proxy discovery is intentionally unsupported. Proxy URLs and credentials are never included in diagnostics.

On Windows, `scripts/codex-proxy-health.ps1 -JsonOnly` can check the currently configured trusted local system proxy against xAI, Grok, and GitHub. It does not read subscriptions, discover public proxies, switch nodes, expose proxy URLs, or disable TLS verification.

`budget_route` reads the key for each selected provider, including `OPENROUTER_API_KEY`, `GROQ_API_KEY`, `GEMINI_API_KEY`, and `SILICONFLOW_API_KEY`. It defaults to `dry_run=true`; a preview may call a provider's model-list endpoint, but it never sends a generation request. Set `AI_TEAM_OPENROUTER_FREE_FALLBACK=true` only if you intentionally want `openrouter/free` considered in `free_only` mode. Verified per-model capability, privacy, latency, price, or quality metadata can be supplied as JSON through `AI_TEAM_MODEL_METADATA_JSON`; see the example config.

SiliconFlow is treated as its own cloud data and content-policy boundary, regardless of whether a hosted model ID names Qwen, DeepSeek, or another upstream family. It is opt-in rather than a default provider. Unknown prices are not treated as free. Mark private or confidential work with `sensitive=true`, and work subject to provider/jurisdiction content restrictions with `policy_sensitive=true`; SiliconFlow is excluded for either category. Provider routing must not be used to evade applicable law or provider policy.

## Example

Delegate a bounded implementation and run the Gate:

```json
{
  "task": "Fix the failing login validation and run existing checks",
  "cwd": "C:\\path\\to\\project",
  "mode": "implement",
  "allowed_paths": ["src/auth", "tests"],
  "budget": "low",
  "run_gate": true
}
```

Use `mode: "inspect"` for read-only investigation. `max_assistants` is a cost cap, not a requested team size.

Batch routine chores while keeping production work out of the worker path:

```json
{
  "cwd": "C:\\path\\to\\project",
  "items": [
    { "id": "docs", "task": "Update the README examples", "allowed_paths": ["README.md"] },
    { "id": "tests", "task": "Add parser boundary tests", "allowed_paths": ["test/parser.test.js"] },
    { "id": "deploy", "task": "Deploy to production", "allowed_paths": ["deploy"] }
  ],
  "budget": "low"
}
```

The first two items are eligible for the bounded writer lane. Production deployment is classified as high risk and appears only in `escalations`. An explicit low-risk label cannot downgrade detected high-risk work.

`openai:gpt-5.6-luna` is registered as a future high-volume routine-worker slot with dated built-in catalog metadata. It remains `reserved` until explicitly enabled, configured with `OPENAI_API_KEY`, and backed by a separate bounded local tool runner. The placeholder never receives local write access and does not make an API request.

Preview budget-aware routing:

```json
{
  "task": "Review this code for concurrency bugs",
  "mode": "balanced",
  "providers": ["openrouter", "groq"],
  "requirements": {
    "capabilities": ["code", "tools"],
    "min_context_length": 32000,
    "sensitive": false,
    "policy_sensitive": false
  },
  "dry_run": true
}
```

The modes are `free_only`, `balanced`, and `quality_first`. `free_only` requires explicit zero input and output prices; a Groq developer allowance is not treated as zero price. Missing capability or zero-retention metadata is never inferred. Actual execution falls back only on OpenRouter `402`/`429`, Groq `429`/`498`, or server `5xx`; authentication, permission, and other client errors stop the chain. Provider prices, free-model availability, and limits remain changeable external data.

## Validation policy

The Gate expresses delivery confidence rather than mathematically measuring code quality:

- 90-100: accept.
- 80-89: allow one targeted retry.
- Below 80, a repeated retry, or a hard failure: Codex takes over.

Hard failures include failed required checks, secret-like content, forbidden files, edits outside allowed paths, and uncontrolled diffs.

Run the offline suite locally:

```powershell
cd mcp-server
npm ci
npm test
```

Live provider probes are separate commands and may incur provider charges. They are not run by `npm test` or CI.

## Benchmark

The repository includes an eight-task isolated benchmark covering project mapping, log diagnosis, fixes, tests, refactoring, documentation, and scope discipline. The recorded 2026-07-12 run reports eight accepted outcomes; see [benchmark/RESULTS-2026-07-12.md](benchmark/RESULTS-2026-07-12.md).

That result is a repository-specific sample, not a universal success-rate or token-savings claim.

## Security boundaries

Workers may read and modify files, execute commands, inherit provider credentials, make outbound requests, run target-project scripts, and store task material in local logs. Repository content processed by an agent can also contain prompt-injection instructions.

Use the narrowest practical `cwd` and `allowed_paths`, work in a recoverable Git checkout, review diffs, and never provide secrets or private account data to a worker. See [SECURITY.md](SECURITY.md) for the threat model and reporting process.

For sensitive `budget_route` work, set `sensitive=true` or `require_zero_data_retention=true`. Candidates without explicitly confirmed zero-data-retention metadata are excluded. This is a routing guardrail, not a legal or privacy guarantee; verify provider terms yourself.

## Current limitations

- PowerShell workers are Windows-oriented.
- Routing is heuristic and can select the wrong worker.
- The Gate cannot prove that generated code is safe.
- `routine_workpack` runs at most one read-only batch and one single-writer/Gate batch; it is not yet a persistent background queue.
- GPT-5.6 Luna is a disabled worker slot until its local bounded runner and representative evals are complete.
- Logs are not automatically guaranteed to be redacted.
- Running target-project tests can execute untrusted project code.
- Usage estimates may differ from provider billing.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) before opening a pull request. Security-sensitive reports should follow [SECURITY.md](SECURITY.md), not a public issue.

## License

[MIT](LICENSE)
