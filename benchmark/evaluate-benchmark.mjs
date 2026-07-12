import assert from "node:assert/strict";
import { readFile, readdir, mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const [taskId, workspaceArg] = process.argv.slice(2);
const workspace = resolve(workspaceArg || "");
if (!/^T[3-8]$/.test(taskId || "") || !workspaceArg) {
  throw new Error("Usage: node evaluate-benchmark.mjs T3..T8 <workspace>");
}

async function moduleFrom(relative) {
  return import(`${pathToFileURL(join(workspace, relative)).href}?t=${Date.now()}`);
}

async function allTestsText() {
  const dir = join(workspace, "test");
  const files = (await readdir(dir)).filter((file) => file.endsWith(".js"));
  return (await Promise.all(files.map((file) => readFile(join(dir, file), "utf8")))).join("\n");
}

if (taskId === "T3") {
  const { normalizeDate } = await moduleFrom("src/date.js");
  assert.equal(normalizeDate("2026-01-01"), "2026-01-01");
}

if (taskId === "T4") {
  const text = await allTestsText();
  assert.match(text, /validateTitle/);
  assert.match(text, /\s{2,}|whitespace|spaces|空格/i);
  assert.match(text, /81|repeat\s*\(/);
}

if (taskId === "T5") {
  const { addTask } = await moduleFrom("src/validation.js");
  const tasks = [{ id: "same", title: "Existing" }];
  assert.throws(() => addTask(tasks, { id: "same", title: "Duplicate" }), /duplicate|exists|重复/i);
}

if (taskId === "T6") {
  const source = await readFile(join(workspace, "src/storage.js"), "utf8");
  assert.ok((source.match(/readFile\s*\(/g) || []).length <= 1, "file reading should be centralized");
  const dir = await mkdtemp(join(tmpdir(), "ai-team-storage-"));
  try {
    const path = join(dir, "tasks.json");
    await writeFile(path, JSON.stringify({ tasks: [1], archived: [2] }));
    const { readTasks, readArchived } = await moduleFrom("src/storage.js");
    assert.deepEqual(await readTasks(path), [1]);
    assert.deepEqual(await readArchived(path), [2]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

if (taskId === "T7") {
  const text = (await readFile(join(workspace, "README.md"), "utf8")).toLowerCase();
  for (const word of ["add", "list"]) assert.ok(text.includes(word), `README missing ${word}`);
  assert.ok(text.includes("error") || text.includes("错误"), "README missing error handling");
}

if (taskId === "T8") {
  const { parseTaskLine } = await moduleFrom("src/parser.js");
  assert.equal(parseTaskLine("1|missing due"), null);
  assert.equal(parseTaskLine(""), null);
}

console.log(`${taskId} hidden acceptance: PASS`);
