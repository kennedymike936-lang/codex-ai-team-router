export function parseTaskLine(line) {
  const [id, title, due] = line.split("|");
  return { id: id.trim(), title: title.trim(), due: due.trim() };
}
