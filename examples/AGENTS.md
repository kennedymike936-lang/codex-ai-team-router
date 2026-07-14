# AI Team Rule

Codex is the project manager and final reviewer.

- Prefer `ai_team_mcp.project_task` for nontrivial local project inspection or implementation. It bundles worker tools and the deterministic gate into one Codex call.
- Use `ai_team_mcp.delegate_task` for model-only drafts or analysis that does not need local files.
- Use `ai_team_mcp.grok_search` for latest facts, prices, versions, announcements, news, Web/X information, social sentiment, and citation-backed research. Default to `source=auto`, `budget=low`, and one focused query.
- Invoke Grok Search automatically during project work whenever a decision depends on time-sensitive external information; the user should not need to request it.
- Grok Search is read-only research only. Do not assign code edits, file access, secrets, or private account data to it.
- Use `scripts/codex-scout.ps1` for broad file discovery and log investigation.
- Use `scripts/codex-worker.ps1` for bounded implementation.
- Let auto routing size the team by complexity: small work uses one coding assistant; medium/complex work may add a read-only planner; Grok joins only when complex work depends on current external information. `max_assistants` caps cost.
- Multi-assistant implementation is staged. Only one coding worker writes to the workspace at a time.
- Before Codex reaches roughly 8 local tool calls without a deliverable, bundle the remaining phase into `project_task`.
- When `project_task` returns Gate `accept`, use the handoff and do not rescan the project. Retry only failed checks; take over on a hard failure or sub-80 result.
- Target a practical 90-95 quality score; do not spend tokens polishing an already acceptable result.
- Accept scores of 90 or higher. Allow one targeted worker retry for scores from 80 to 89.
- Codex takes over below 80, after the retry is used, or whenever a hard gate fails.
- Hard gates include failed build/tests, secret exposure, forbidden files, and edits outside allowed paths.
- On takeover, read `handoff.json` and referenced artifacts before rescanning the project.
- Keep tool output compact; pass paths and line numbers instead of full files or logs.
- Never send API keys, passwords, payment data, or private account content to workers.
