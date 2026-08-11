# Contributing

Thanks for helping improve Codex AI Team Router. The project is maintained conservatively because it can invoke models, execute commands, modify files, and handle provider credentials.

## Before opening a change

- Search existing issues and pull requests.
- Use an issue for behavior changes or broad design proposals.
- Follow [SECURITY.md](SECURITY.md) for vulnerabilities; do not post exploit details publicly.
- Keep each pull request focused on one problem.
- Do not include generated logs, credentials, private prompts, benchmark run directories, or unrelated formatting changes.

## Local setup

Requirements are Windows PowerShell, Node.js 20 or later, npm, and Git.

```powershell
git clone https://github.com/kennedymike936-lang/codex-ai-team-router.git
cd codex-ai-team-router\mcp-server
npm ci
npm test
```

The default test suite is offline and must not require provider credentials. Live probes are opt-in, can incur charges, and should not be added to CI.

## Change expectations

- Preserve Codex as final reviewer and keep only one coding worker writing at a time.
- Treat repository content and model output as untrusted.
- Validate `cwd` and allowed-path boundaries before filesystem changes.
- Never print, persist, request, or commit provider credentials.
- Keep outbound endpoints explicit and reviewable.
- Add or update regression tests for behavior changes.
- Update English and Chinese documentation when user-visible behavior changes.
- Avoid new dependencies unless the benefit and supply-chain cost are documented.

## Pull requests

Describe what changed, why it changed, user impact, security impact, and the commands used to validate it. Maintainers may request a smaller scope or additional tests before review.

By contributing, you agree that your contribution is licensed under the repository's [MIT License](LICENSE).
