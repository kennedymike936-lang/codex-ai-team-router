# Security Policy

## Project status

Codex AI Team Router is early-stage local developer tooling. It coordinates agents that may read files, execute commands, call external services, and modify a selected workspace. Its validation Gate reduces risk but is not a sandbox or a security guarantee.

Only the latest commit on the default branch is currently supported with security fixes. Published releases will be listed here when a stable release process is established.

## Report a vulnerability

Do not disclose exploitable details in a public issue.

Use GitHub's private vulnerability reporting flow for this repository: open the **Security** tab, choose **Advisories**, and select **Report a vulnerability**. Include:

- affected commit or version;
- the preconditions and minimum reproduction;
- expected and observed behavior;
- affected files, credentials, or network boundaries;
- a suggested mitigation, if available.

For non-sensitive hardening ideas, open a normal issue and omit exploit details. The maintainer will acknowledge a private report as soon as practical, validate its scope, and coordinate a fix and disclosure. No guaranteed response deadline is offered while the project has a single volunteer maintainer.

## Threat model

The project treats the following as trust boundaries:

### Repository and prompt content

Files, issues, logs, and task text may contain prompt-injection instructions intended to make an agent ignore scope, reveal data, or run unrelated commands. Agents must treat repository content as untrusted data and follow the explicit task and allowed paths.

### Working directory and filesystem

`project_task` accepts a user-supplied `cwd` and optional `allowed_paths`. A validation mistake, path traversal, symlink, junction, case-normalization error, or model mistake could affect files outside the intended scope. Run workers in a dedicated, recoverable Git checkout and review the final diff.

### Shell and project scripts

Implementation workers can execute model-generated commands. The Gate may also run build, test, lint, type-check, HTML, or browser scripts from the target project. A malicious repository can therefore execute code under the current user's permissions. Do not use the router on untrusted projects outside an appropriate operating-system sandbox.

### Credentials and child processes

Provider credentials are read from environment variables and may be inherited by child processes. A compromised dependency, worker harness, target-project script, or redirected provider endpoint could attempt to read or exfiltrate them. Use narrowly scoped credentials, separate development accounts where possible, and rotate a credential after suspected exposure.

### Network requests

The router calls configured Qwen, DeepSeek, and xAI-compatible endpoints. Configuration or dependency compromise could redirect traffic or send unintended context. Verify endpoints, review what is included in tasks, and do not send private repositories or account data without authorization.

### Logs and artifacts

Worker prompts, summaries, provider output, file paths, and command output may be stored under the local run directory. Automatic redaction is not guaranteed. Review artifacts before sharing them and delete sensitive local artifacts according to your own retention policy.

### Dependencies and contributions

`npm` dependencies, CLI worker harnesses, installer changes, GitHub Actions, and third-party pull requests are supply-chain inputs. Lockfiles, minimal CI permissions, reviewable diffs, tests, and maintainer approval reduce but do not eliminate this risk.

## Safe-use baseline

- Use a dedicated Git branch or disposable checkout.
- Set the narrowest correct `cwd` and `allowed_paths`.
- Keep backups for non-Git files.
- Never place API keys, passwords, payment data, or private chats in tasks.
- Review diffs and Gate artifacts before accepting changes.
- Treat failed scope or secret checks as hard failures.
- Do not run target-project scripts you would not run manually.
- Keep Node.js, PowerShell, worker CLIs, and dependencies patched.

## Out of scope

Reports that only demonstrate expected execution inside an explicitly authorized working directory are not vulnerabilities by themselves. Social engineering, denial-of-service against third-party model providers, and testing systems or repositories without authorization are also out of scope.
