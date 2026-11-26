export type Provenance = "user" | "agent" | "inferred";
export const PROVENANCE: readonly Provenance[] = ["user", "agent", "inferred"];

export type Note = {
  path: string;
  description: string;
  source: Provenance;
  body: string;
  updatedAt: number;
};

// Only people/<id>/, chats/<id>/ and topics/ notes exist; system/ and traversal are unreachable by construction.
const PATH = /^(people|chats)\/[\w.-]+\/[\w.\-가-힣]+\.md$|^topics\/[\w.\-가-힣]+\.md$/u;

export function checkPath(path: string): string | undefined {
  if (path.includes("..")) return "path must not contain ..";
  if (!PATH.test(path)) return "path must look like people/<id>/<name>.md, chats/<id>/<name>.md or topics/<name>.md";
  return undefined;
}

export function render(note: Pick<Note, "description" | "source" | "body">): string {
  const oneLine = (s: string) => s.replace(/\s+/g, " ").trim();
  return `---\ndescription: ${oneLine(note.description)}\nsource: ${note.source}\n---\n${note.body.replace(/\n+$/, "")}\n`;
}

export type Edit =
  | { command: "create"; description: string; source: Provenance; body: string }
  | { command: "str_replace"; oldString: string; newString: string }
  | { command: "insert"; line: number; text: string };

export function applyEdit(
  current: Pick<Note, "description" | "source" | "body"> | undefined,
  edit: Edit,
): { description: string; source: Provenance; body: string } | { error: string } {
  switch (edit.command) {
    case "create":
      if (current) return { error: "note already exists; use str_replace or insert" };
      if (!edit.description.trim()) return { error: "description is required" };
      return { description: edit.description, source: edit.source, body: edit.body };
    case "str_replace": {
      if (!current) return { error: "note not found" };
      const at = current.body.indexOf(edit.oldString);
      if (!edit.oldString || at < 0) return { error: "old_string not found in note body" };
      if (current.body.indexOf(edit.oldString, at + 1) >= 0) return { error: "old_string is not unique in note body" };
      return { ...current, body: current.body.slice(0, at) + edit.newString + current.body.slice(at + edit.oldString.length) };
    }
    case "insert": {
      if (!current) return { error: "note not found" };
      const lines = current.body.split("\n");
      if (!Number.isInteger(edit.line) || edit.line < 1 || edit.line > lines.length + 1) return { error: `insert_line must be 1..${lines.length + 1}` };
      lines.splice(edit.line - 1, 0, edit.text);
      return { ...current, body: lines.join("\n") };
    }
  }
}

// Bigrams, not whitespace tokens: Korean words carry particles (고양이는/고양이를), so token match misses them.
export function bigrams(text: string): Set<string> {
  const out = new Set<string>();
  for (const word of text.toLowerCase().split(/[^\p{L}\p{N}]+/u)) {
    if (word.length === 1) out.add(word);
    for (let i = 0; i + 1 < word.length; i++) out.add(word.slice(i, i + 2));
  }
  return out;
}

export function search(notes: readonly Note[], query: string, limit: number): Note[] {
  const q = bigrams(query);
  if (!q.size) return [];
  return notes
    .map((note) => {
      const doc = bigrams(`${note.path} ${note.description} ${note.body}`);
      let hits = 0;
      for (const g of q) if (doc.has(g)) hits++;
      return { note, hits };
    })
    .filter((s) => s.hits > 0)
    .sort((a, b) => b.hits - a.hits || b.note.updatedAt - a.note.updatedAt)
    .slice(0, limit)
    .map((s) => s.note);
}
