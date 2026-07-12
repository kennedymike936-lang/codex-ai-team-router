import assert from "node:assert/strict";
import { test } from "node:test";
import { parseTaskLine } from "../src/parser.js";

test("parses a complete task line", () => {
  assert.deepEqual(parseTaskLine("1|Ship release|2026-08-01"), { id: "1", title: "Ship release", due: "2026-08-01" });
});
