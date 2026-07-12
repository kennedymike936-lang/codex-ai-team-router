import { addTask } from "./validation.js";

export function runCommand(argv, tasks = []) {
  const [command, id, ...titleParts] = argv;
  if (command === "list") return tasks;
  if (command === "add") return addTask(tasks, { id, title: titleParts.join(" ") });
  throw new Error(`Unknown command: ${command}`);
}
