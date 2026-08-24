# Security Policy

## Project status

Codex AI Cluster is local developer tooling with two distinct surfaces: a multi-provider inference control plane and an optional AI Team execution plane. Provider calls can transmit task content, while local workers may read files, execute commands, and modify a selected workspace. Routing policy and the validation Gate reduce risk but are not a sandbox or security guarantee.

Security fixes target the latest release and the latest commit on the default branch. Version 1.0.0 establishes the stable release line; older 0.x builds are not supported.

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

### Network requests and provider failover

The cluster can call configured Zhipu, OpenRouter, Cloudflare, Groq, ModelScope, NVIDIA, Mistral, Gemini, SiliconFlow, OpenAI, xAI, Qwen, DeepSeek, and compatible endpoints. Configuration or dependency compromise could redirect traffic or send unintended context. Verify endpoints, review task content, and do not send private repositories or account data without authorization. Authentication and permission failures intentionally stop routing; do not weaken this boundary to increase availability.

### Local state and Mission Control

Provider/model identifiers, counters, status classes, cooldowns, and sanitized orchestration events may be stored locally. Mission Control binds only to `127.0.0.1` and must not expose credentials, prompts, raw responses, private artifacts, or hidden reasoning. Treat changes to event serialization, redaction, binding, or static asset serving as security-sensitive.

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
