# Codex AI Cluster Agent Rules

## Mandatory post-clone and post-pull self-check

Before implementation in a fresh clone, and after every pull that changes `mcp-server/`, a Codex agent must:

1. Run the installer from the repository root:

   ```powershell
   powershell -NoProfile -ExecutionPolicy Bypass -File .\install.ps1
   ```

2. Confirm that `npm run self-check` reports `status: "pass"` and note its `expected_build_id`.
3. If this repository is configured as the local `ai_cluster_mcp` server, call the MCP `doctor` tool and compare `runtime_identity.build_id` with `expected_build_id`.
4. If the build IDs differ, the PID did not change after an update, or the active process started before the server source was modified, stop and tell the user to open **Settings > MCP servers > Restart**. Restarting only a Codex task or closing a window is not sufficient proof that the STDIO child process restarted.
5. After the MCP restart, call `doctor` again. If Groq is configured, call `budget_route` with `providers: ["groq"]`, `mode: "free_only"`, and `dry_run: true`. A healthy result has a selected model and no Groq provider exclusion.

The self-check and dry run must not perform chat inference. Never read, print, hash, commit, or send credential values to a helper model. Report the cluster as healthy only after the active PID, build ID, Doctor result, and configured-provider dry run agree.
