export function validateTitle(title) {
  if (typeof title !== "string" || title.trim() === "") throw new Error("Title is required");
  if (title.length > 80) throw new Error("Title is too long");
  return title.trim();
}

export function addTask(tasks, task) {
  const clean = { ...task, title: validateTitle(task.title) };
  tasks.push(clean);
  return clean;
}
