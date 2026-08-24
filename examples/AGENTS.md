# AI Cluster and optional AI Team rule

Codex is the project manager and final reviewer.

- Prefer `ai_cluster_mcp.budget_route` for model-only work that can use the GLM-first free provider fabric.
- Prefer `ai_cluster_mcp.delegate_task` for bulky model work that benefits from the optional execution-team policy.
- Use `ai_cluster_mcp.grok_search` for latest facts, prices, versions, announcements, news, Web/X information, social sentiment, and citation-backed research. Default to `source=auto`, `budget=low`, and one focused query.
- Invoke Grok Search automatically during project work whenever a decision depends on time-sensitive external information; the user should not need to request it.
- Grok Search is read-only research only. Do not assign code edits, file access, secrets, or private account data to it.
- Treat DeepSeek as paid/manual-only. Enable a paid fallback only when the user or task explicitly justifies it.
- Use `scripts/codex-scout.ps1` for broad file discovery and log investigation.
- Use `scripts/codex-worker.ps1` for bounded implementation.
- Target a practical 90-95 quality score; do not spend tokens polishing an already acceptable result.
- Accept scores of 90 or higher. Allow one targeted worker retry for scores from 80 to 89.
- Codex takes over below 80, after the retry is used, or whenever a hard gate fails.
- Hard gates include failed build/tests, secret exposure, forbidden files, and edits outside allowed paths.
- On takeover, read `handoff.json` and referenced artifacts before rescanning the project.
- Keep tool output compact; pass paths and line numbers instead of full files or logs.
- Never send API keys, passwords, payment data, or private account content to workers.
