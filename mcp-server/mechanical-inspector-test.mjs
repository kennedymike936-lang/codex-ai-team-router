import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { matchMechanicalRule, mechanicalInspect } from "./mechanical-inspector.mjs";
import { runProjectTask } from "./project-task.mjs";

test("matches only narrow package metadata requests", () => {
  assert.deepEqual(matchMechanicalRule("Read package.json and report only the package name and version.")?.fields, ["name", "version"]);
  assert.deepEqual(matchMechanicalRule("\u8bfb\u53d6 package.json \u7684\u5305\u540d\u548c\u7248\u672c\u53f7")?.fields, ["name", "version"]);
  assert.deepEqual(matchMechanicalRule("List package.json scripts")?.fields, ["scripts"]);
  for (const task of [
    "Explain the package name and version",
    "Update the package version",
    "Compare the current package version",
    "Audit package.json dependencies for security",
    "Implement a package version command",
    "Map the package architecture",
    "What is the version?",
  ]) assert.equal(matchMechanicalRule(task), null, task);
});

test("reads package metadata without exposing script commands", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "mechanical-inspector-"));
  try {
    await writeFile(join(cwd, "package.json"), JSON.stringify({
      name: "fixture-package",
      version: "1.2.3",
      scripts: { test: "node secret-command.js", build: "node build.js" },
    }));
    const result = await mechanicalInspect("List package.json scripts", cwd);
    assert.equal(result.route, "mechanical");
    assert.equal(result.usage.total_tokens, 0);
    assert.match(result.summary, /build, test/);
    assert.doesNotMatch(result.summary, /secret-command/);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("project_task returns the normal zero-assistant schema without a model call", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "mechanical-project-task-"));
  try {
    await writeFile(join(cwd, "package.json"), JSON.stringify({ name: "fixture-package", version: "9.8.7" }));
    const result = await runProjectTask({
      task: "Read package.json and report only the package name and version.",
      cwd,
      mode: "inspect",
      max_assistants: 2,
    });
    assert.equal(result.status, "success");
    assert.equal(result.route, "mechanical");
    assert.equal(result.team.actual_assistant_count, 0);
    assert.equal(result.usage.availability, "not_applicable");
    assert.equal(result.usage.total_tokens, 0);
    assert.match(result.summary, /fixture-package/);
    assert.match(result.summary, /9\.8\.7/);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});
