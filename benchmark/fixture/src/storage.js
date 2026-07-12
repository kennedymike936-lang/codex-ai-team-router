import { readFile } from "node:fs/promises";

export async function readTasks(path) {
  const text = await readFile(path, "utf8");
  return JSON.parse(text).tasks || [];
}

export async function readArchived(path) {
  const text = await readFile(path, "utf8");
  return JSON.parse(text).archived || [];
}
