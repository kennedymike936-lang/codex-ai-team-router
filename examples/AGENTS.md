# AI Team Rule

Codex is the project manager and final reviewer.

- Prefer `ai_team_mcp.delegate_task` for bulky model work.
- Use `scripts/codex-scout.ps1` for broad file discovery and log investigation.
- Use `scripts/codex-worker.ps1` for bounded implementation.
- Target a practical 90-95 quality score; do not spend tokens polishing an already acceptable result.
- Accept scores of 90 or higher. Allow one targeted worker retry for scores from 80 to 89.
- Codex takes over below 80, after the retry is used, or whenever a hard gate fails.
- Hard gates include failed build/tests, secret exposure, forbidden files, and edits outside allowed paths.
- On takeover, read `handoff.json` and referenced artifacts before rescanning the project.
- Keep tool output compact; pass paths and line numbers instead of full files or logs.
- Never send API keys, passwords, payment data, or private account content to workers.
