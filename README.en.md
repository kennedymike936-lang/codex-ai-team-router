# Codex AI Team Router

[Simplified Chinese](README.md) | English

Codex AI Team Router is an MIT-licensed local MCP server that lets Codex remain the project manager and final reviewer while delegating bounded work to Qwen, DeepSeek, and read-only Grok Search.

The project is designed for Windows-based maintainer workflows. It combines model routing with local PowerShell workers and a deterministic Gate that checks tests, change scope, diff size, and secret-like content before Codex accepts a result.

> This is an early-stage project. Routing decisions and quality scores are heuristics, not security guarantees. Review agent-generated changes before merging or releasing them.

## What it provides

- One MCP server with four tools: `delegate_task`, `grok_search`, `project_task`, and `worker_gate_review`.
- Automatic routing between Qwen and DeepSeek based on task type and complexity.
- Optional read-only Web/X research through Grok Search.
- Staged multi-agent work: read-only planning, one writing worker, then deterministic validation.
- Bounded working directories and optional allowed-path enforcement.
- Build, test, type-check, lint, diff-size, scope, and secret-pattern checks where supported by the target project.
- Compact MCP responses with full worker artifacts stored locally.
- Local token and cost ledgers based on provider-reported usage when available.
- An isolated eight-task benchmark with hidden acceptance checks.

## Requirements

- Windows PowerShell
- Node.js 20 or later
- npm and Git
- Codex Desktop or another MCP-compatible Codex environment
- At least one supported provider API key

Optional worker harnesses include Qwen Code CLI and Claude Code CLI.

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
```

Provider keys are read from environment variables. Do not put keys in the repository, prompts, or Codex configuration examples.

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

## Current limitations

- PowerShell workers are Windows-oriented.
- Routing is heuristic and can select the wrong worker.
- The Gate cannot prove that generated code is safe.
- Logs are not automatically guaranteed to be redacted.
- Running target-project tests can execute untrusted project code.
- Usage estimates may differ from provider billing.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) before opening a pull request. Security-sensitive reports should follow [SECURITY.md](SECURITY.md), not a public issue.

## License

[MIT](LICENSE)
