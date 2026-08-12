# Changelog

All notable changes to this project will be documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project intends to use semantic versioning for future releases.

## [Unreleased]

### Added

- One bounded assistant/harness failover for local `project_task` turn limits, timeouts, transient provider failures, process failures, and malformed structured output.
- Extensible Provider Registry with native Gemini REST, native OpenAI Responses, and administrator-configured generic OpenAI-compatible adapters.
- Normalized provider protocol, text, tool calls, finish reason, and token usage in `budget_route` results.

### Security

- Authentication, permission, API-key configuration, path-scope, and secret-policy failures stop immediately instead of switching assistants.
- Gemini unpaid/free candidates are not treated as zero-data-retention, and provider Base URLs cannot be supplied by task input.

## [0.7.0] - 2026-08-11

### Added

- `budget_route` with `free_only`, `balanced`, and `quality_first` policies for OpenRouter and Groq.
- Unified provider adapters, explainable candidate scoring, conservative capability/privacy filters, and opt-in `openrouter/free` routing.
- Offline coverage for model metadata, 200, 402, 429, 498, 5xx, authentication stops, capability/privacy mismatches, rate-limit headers, and credential redaction.
- English project entrypoint.
- Security policy and threat model.
- Contribution guide, issue forms, and pull request template.
- Windows CI coverage for supported Node.js versions.

### Changed

- Package and MCP server version advanced to 0.7.0 without claiming a GitHub Release or package publication.
- Fallback is limited to documented quota, rate-limit, temporary-capacity, and server failures; authentication, permission, and other client errors stop routing.
- Installer uses the lockfile-based clean install path when available.
- Package metadata now documents the supported Node.js version and repository links.
- MCP SDK and transitive dependencies use versions that pass the current production dependency audit.

## [0.6.0] - 2026-07-16

### Added

- Single MCP router for Qwen, DeepSeek, and read-only Grok Search.
- Bounded `project_task` workflow with staged planning, one writing worker, and deterministic Gate validation.
- Automatic model discovery, routing budgets, retry/takeover policy, compact result summaries, and local usage ledgers.
- Eight-task isolated benchmark and offline Node.js/PowerShell test suite.

This changelog records the version already declared in `mcp-server/package.json`; it does not claim that a GitHub Release or package publication occurred on this date.

[Unreleased]: https://github.com/kennedymike936-lang/codex-ai-team-router/compare/e9b6c29...HEAD
[0.7.0]: https://github.com/kennedymike936-lang/codex-ai-team-router/compare/e9b6c29...HEAD
[0.6.0]: https://github.com/kennedymike936-lang/codex-ai-team-router/tree/caf8a06
