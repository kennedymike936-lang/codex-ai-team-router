# Changelog

All notable changes to this project will be documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project intends to use semantic versioning for future releases.

## [Unreleased]

### Added

- `routine_workpack` for exception-driven execution of up to 12 bounded chores with separate read-only and single-writer lanes, a mandatory implementation Gate, compact success receipts, and Codex escalation packets.
- A disabled `openai:gpt-5.6-luna` high-volume worker slot plus dated built-in capability, context, and pricing metadata. No Luna request or local write path is enabled.
- One bounded assistant/harness failover for local `project_task` turn limits, timeouts, transient provider failures, process failures, and malformed structured output.
- Extensible Provider Registry with native Gemini REST, native OpenAI Responses, and administrator-configured generic OpenAI-compatible adapters.
- Opt-in SiliconFlow adapter with conservative pricing, privacy, data-boundary, and content-policy metadata.
- Normalized provider protocol, text, tool calls, finish reason, and token usage in `budget_route` results.
- Structured network diagnostics, bounded safe retries, trusted HTTP/HTTPS proxy fallback, and assistant failover for pre-connect failures.
- Exact run-local Qwen request accounting, including cached versus uncached input, thinking tokens, provider API time, and per-request breakdowns after partial or timed-out runs.
- Read-only `doctor` diagnostics for local runtimes, AI harness commands, provider credential presence, and trusted proxy presence without exposing credential or proxy values.
- A read-only Windows trusted-proxy health check that tests the user-configured local proxy without reading subscriptions, discovering public proxies, switching nodes, or bypassing TLS.

### Changed

- Mixed inspection-and-mutation prompts now route to implementation so requests such as “find and fix” and “分析并修复” do not silently become read-only work.
- The Gate discovers nested Node package roots from changed paths and requires executable verification evidence for source-code changes before accepting them.
- The project Gate timeout budget increased from 15 to 45 seconds so discovered subproject checks can finish.
- Large-output workers receive an explicit wall-clock stop policy, a longer primary completion window, and a narrower focused fallback window.
- Worker failover preserves completed partial files and identifies remaining scope from the allowed paths and current workspace diff.
- `project_task` recovers structured partial handoffs from nonzero PowerShell exits so timed-out workers retain changed files, exact usage, and the correct failover classification.

### Fixed

- DeepSeek's Claude-compatible harness now receives the worker task through explicit text stdin instead of a long positional argument, preventing the Windows three-second stdin initialization failure.
- Isolated Qwen workers now create their own minimal settings file and use a stable prompt file, avoiding inherited configuration noise and command-line truncation.
- Read-only Scouts now use a bounded mechanical preflight by default and receive 4/5/7-turn budgets with an explicit tool-free final answer turn.
- DeepSeek workers now always use the isolated Qwen Code OpenAI-compatible harness, removing the unavailable Claude compatibility path and accepting `DEEPSEEK_API_KEY` directly.
- The parent `project_task` ID now propagates through Planner, Scout, Worker, usage, and Gate artifacts for end-to-end auditability.

### Security

- Authentication, permission, API-key configuration, path-scope, and secret-policy failures stop immediately instead of switching assistants.
- Gemini unpaid/free candidates are not treated as zero-data-retention, and provider Base URLs cannot be supplied by task input.
- SiliconFlow is excluded from privacy-sensitive and policy-sensitive tasks and is never inferred to be a direct connection to its hosted model vendor.
- Public proxy discovery, TLS verification bypass, proxy credential disclosure, and uncertain paid-POST replay are explicitly prohibited.

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
