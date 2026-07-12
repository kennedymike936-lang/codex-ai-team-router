import assert from "node:assert/strict";
import { test } from "node:test";
import { runCommand } from "../src/cli.js";
import { validateTitle } from "../src/validation.js";

test("list returns tasks", () => {
  const tasks = [{ id: "1", title: "Ship" }];
  assert.equal(runCommand(["list"], tasks), tasks);
});

test("add creates a task", () => {
  const tasks = [];
  assert.deepEqual(runCommand(["add", "1", "Write", "tests"], tasks), { id: "1", title: "Write tests" });
});

test("title is trimmed", () => {
  assert.equal(validateTitle("  ready  "), "ready");
});
