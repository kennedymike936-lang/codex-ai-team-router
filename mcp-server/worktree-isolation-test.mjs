import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { finalizeWorktreeIsolation, prepareWorktreeIsolation } from "./worktree-isolation.mjs";

const root = mkdtempSync(join(tmpdir(), "ai-team-worktree-test-"));
const repo = join(root, "repo");
try {
  execFileSync("git", ["init", "-q", repo]);
  execFileSync("git", ["-C", repo, "config", "user.email", "test@example.invalid"]);
  execFileSync("git", ["-C", repo, "config", "user.name", "AI Team Test"]);
  writeFileSync(join(repo, "a.txt"), "base\n");
  execFileSync("git", ["-C", repo, "add", "a.txt"]);
  execFileSync("git", ["-C", repo, "commit", "-qm", "base"]);
  const isolation = await prepareWorktreeIsolation({ cwd: repo, taskId: "safe/test", root: join(root, "worktrees") });
  assert.equal(isolation.status, "isolated");
  writeFileSync(join(isolation.working_cwd, "a.txt"), "changed\n");
  writeFileSync(join(isolation.working_cwd, "new.txt"), "new\n");
  const applied = await finalizeWorktreeIsolation(isolation, { accepted: true });
  assert.equal(applied.status, "applied");
  assert.equal(readFileSync(join(repo, "a.txt"), "utf8").replace(/\r\n/g, "\n"), "changed\n");
  assert.equal(readFileSync(join(repo, "new.txt"), "utf8").replace(/\r\n/g, "\n"), "new\n");

  execFileSync("git", ["-C", repo, "add", "-A"]);
  execFileSync("git", ["-C", repo, "commit", "-qm", "applied"]);
  writeFileSync(join(repo, "a.txt"), "dirty\n");
  const bypass = await prepareWorktreeIsolation({ cwd: repo, taskId: "dirty", root: join(root, "worktrees") });
  assert.equal(bypass.status, "dirty_original");
  assert.equal(bypass.enabled, false);
  console.log("Worktree isolation: accepted patch apply and dirty-worktree bypass passed");
} finally {
  rmSync(root, { recursive: true, force: true });
}
