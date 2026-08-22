import { execFile } from "node:child_process";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

async function git(cwd, args, timeout = 15000) {
  return execFileAsync("git", args, { cwd, encoding: "utf8", windowsHide: true, timeout, maxBuffer: 8 * 1024 * 1024 });
}

function safeTaskId(value) {
  return String(value || "task").replace(/[^a-zA-Z0-9._-]/g, "-").slice(0, 96);
}

export async function prepareWorktreeIsolation({ cwd, taskId, enabled = true, root, existing } = {}) {
  const original = resolve(String(cwd || ""));
  if (!enabled) return { enabled: false, status: "disabled", original_cwd: original, working_cwd: original };
  try {
    if (existing?.enabled && existing.working_cwd && existing.head) {
      const resumedHead = (await git(existing.working_cwd, ["rev-parse", "HEAD"])).stdout.trim();
      const originalHead = (await git(original, ["rev-parse", "HEAD"])).stdout.trim();
      if (resumedHead === existing.head && originalHead === existing.head) {
        return { ...existing, enabled: true, status: "resumed", original_cwd: original, working_cwd: existing.working_cwd, path: existing.path || existing.working_cwd };
      }
      return { enabled: false, status: "resume_head_mismatch", original_cwd: original, working_cwd: original };
    }
    const inside = (await git(original, ["rev-parse", "--is-inside-work-tree"])).stdout.trim() === "true";
    if (!inside) return { enabled: false, status: "not_git", original_cwd: original, working_cwd: original };
    const head = (await git(original, ["rev-parse", "HEAD"])).stdout.trim();
    const dirty = (await git(original, ["status", "--porcelain", "--untracked-files=all"])).stdout.trim();
    if (dirty) return { enabled: false, status: "dirty_original", original_cwd: original, working_cwd: original, head };
    const base = resolve(root || join(homedir(), ".codex-ai-team", "worktrees"));
    const path = join(base, safeTaskId(taskId));
    await mkdir(dirname(path), { recursive: true });
    await rm(path, { recursive: true, force: true });
    await git(original, ["worktree", "add", "--detach", path, head], 30000);
    return { enabled: true, status: "isolated", original_cwd: original, working_cwd: path, path, head };
  } catch (error) {
    return { enabled: false, status: "unavailable", original_cwd: original, working_cwd: original, error: String(error?.message || error).slice(0, 300) };
  }
}

export async function finalizeWorktreeIsolation(isolation, { accepted = false } = {}) {
  if (!isolation?.enabled) return isolation;
  if (!accepted) return { ...isolation, status: "retained_for_takeover", retained: true };
  const { original_cwd: original, working_cwd: working, head } = isolation;
  try {
    const currentHead = (await git(original, ["rev-parse", "HEAD"])).stdout.trim();
    const dirty = (await git(original, ["status", "--porcelain", "--untracked-files=all"])).stdout.trim();
    if (currentHead !== head || dirty) {
      return { ...isolation, status: "original_changed", retained: true, applied: false };
    }
    await git(working, ["add", "-A"]);
    const patch = (await git(working, ["diff", "--cached", "--binary", "--full-index", "HEAD"], 30000)).stdout;
    if (patch) {
      const patchPath = join(dirname(working), `${safeTaskId(isolation.path)}.patch`);
      await writeFile(patchPath, patch, "utf8");
      try {
        await git(original, ["apply", "--binary", "--whitespace=nowarn", patchPath], 30000);
        await git(original, ["diff", "--check"]);
      } finally {
        await rm(patchPath, { force: true });
      }
    }
    await git(original, ["worktree", "remove", "--force", working], 30000);
    return { ...isolation, status: "applied", retained: false, applied: true, had_changes: Boolean(patch) };
  } catch (error) {
    return { ...isolation, status: "apply_failed", retained: true, applied: false, error: String(error?.message || error).slice(0, 500) };
  }
}
