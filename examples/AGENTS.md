# AI Team Rule

Codex is the project manager and final reviewer.

- Prefer `ai_team_mcp.delegate_task` for bulky model work.
- Use `scripts/codex-scout.ps1` for broad file discovery and log investigation.
- Use `scripts/codex-worker.ps1` for bounded implementation.
- Keep tool output compact; pass paths and line numbers instead of full files or logs.
- Never send API keys, passwords, payment data, or private account content to workers.
