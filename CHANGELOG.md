# Changelog

All notable changes to this project will be documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project intends to use semantic versioning for future releases.

## [Unreleased]

### Added

- English project entrypoint.
- Security policy and threat model.
- Contribution guide, issue forms, and pull request template.
- Windows CI coverage for supported Node.js versions.

### Changed

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

[Unreleased]: https://github.com/kennedymike936-lang/codex-ai-team-router/compare/caf8a06...HEAD
[0.6.0]: https://github.com/kennedymike936-lang/codex-ai-team-router/tree/caf8a06
