# Changelog

All notable changes are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses semantic versioning from v1.0 onward.

## [Unreleased]

## [1.0.1] - 2026-08-24

### Fixed

- Added an explicit UTF-8 BOM to the two synchronized `codex-worker.ps1` copies so Windows PowerShell 5.1 parses the non-ASCII failure-classification expression correctly on English GitHub-hosted runners.

### Changed

- Marked v1.0.1 as the recommended build without changing the v1.0 routing architecture or provider policy.

## [1.0.0] - 2026-08-23

### Added

- Codex AI Cluster as a distinct multi-provider inference control plane.
- `budget_route` for dry-run or live free-tier-aware routing across Zhipu, OpenRouter, Cloudflare Workers AI, Groq, ModelScope, NVIDIA, Mistral, Gemini, SiliconFlow, OpenAI, and OpenAI-compatible endpoints.
- GLM-4.7-Flash as the preferred primary route through an explicit routing-priority component.
- Provider adapters, live model discovery, capability normalization, conservative free-price classification, and provider-aware thinking control.
- A locally capped 50-call-per-day OpenRouter pool: GLM 5.2 (10), Inkling (10), North Mini Code (20), and Nemotron Ultra (10).
- Cloudflare Workers AI support for Gemma 4 26B and Nemotron 3 120B with shared daily free-neuron policy metadata.
- Persistent SQLite request records, runtime queues, circuit state, provider health, quota state, and cooldowns.
- `fabric_status` for sanitized, read-only runtime inspection.
- `doctor` for credential-presence, runtime, worker harness, and trusted-proxy diagnostics without making model calls.
- Optional local Mission Control with a full provider/model roster, activity timeline, explicit expert-debate view, and dynamic locally enforceable quota display.
- `routine_workpack` for bounded batches of read-only and single-writer chores.
- Worker Protocol v2 event handling, first-event timeout detection, checkpoints, worktree isolation, resumable retained workspaces, and compact exception packets.
- Full English v1 documentation and a dedicated architecture specification.

### Changed

- Rebranded the product from Codex AI Team Router to **Codex AI Cluster**.
- Separated the AI Cluster control plane from the optional AI Team local execution plane.
- Renamed the private Node package to `codex-ai-cluster-router` and the MCP server identity to `ai-cluster-mcp-server`.
- Renamed the example MCP entry to `ai_cluster_mcp`.
- Changed deployed runtime copies from `ai-team-mcp-server` to `ai-cluster-mcp-server`.
- Made Qwen the free-first execution worker and reduced automatic validation/review loops for routine work.
- Made DeepSeek paid/manual-only by default; automatic failover requires explicit request-level permission.
- Limited provider failover to quota, rate-limit, capacity, empty-output, and server failure classes; authentication and permission failures stop immediately.
- Made root `README.md` the canonical English entrypoint.

### Security

- Added credential redaction across provider headers, errors, state, and diagnostics.
- Prevented API keys from entering model-discovery cache keys, Mission Control events, or public status output.
- Added secret-pattern regression checks and restricted Mission Control to `127.0.0.1`.
- Kept local implementation single-writer and added scope/worktree validation before automated apply.

### Compatibility

- Existing `AI_TEAM_*` environment variables remain supported in v1.0.
- The historical GitHub repository URL remains unchanged.

## [0.6.0] - 2026-07-16

### Added

- Single MCP router for Qwen, DeepSeek, and read-only Grok Search.
- Bounded `project_task` workflow with staged planning, one writing worker, and deterministic Gate validation.
- Automatic model discovery, routing budgets, retry/takeover policy, compact result summaries, and local usage ledgers.
- Eight-task isolated benchmark and offline Node.js/PowerShell test suite.

This entry records the version declared by the earlier package metadata; it does not claim that a GitHub Release was published on that date.

[Unreleased]: https://github.com/kennedymike936-lang/codex-ai-team-router/compare/v1.0.1...HEAD
[1.0.1]: https://github.com/kennedymike936-lang/codex-ai-team-router/compare/v1.0.0...v1.0.1
[1.0.0]: https://github.com/kennedymike936-lang/codex-ai-team-router/releases/tag/v1.0.0
[0.6.0]: https://github.com/kennedymike936-lang/codex-ai-team-router/tree/caf8a06
