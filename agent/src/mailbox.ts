// Lead mailbox: the lead (chief-of-staff agent) drops instructions into the inbox; every instruction gets an
// "ack" line on receipt and exactly one "done" line when its turn ends. Code guarantees only storage, order
// and receipts; what the instruction means is the model's call.

export type Sql = <T = Record<string, string | number | null>>(strings: TemplateStringsArray, ...values: (string | number | null)[]) => T[];

export type OutLine = { cursor: number; inboxId: number; kind: "ack" | "done"; text: string; at: number };
export type Pending = { id: number; text: string };

export const MAX_INSTRUCTION_CHARS = 8_000;

export function migrateMailbox(sql: Sql): void {
  sql`CREATE TABLE IF NOT EXISTS kk_mail_in (id INTEGER PRIMARY KEY AUTOINCREMENT, text TEXT NOT NULL, status TEXT NOT NULL, at INTEGER NOT NULL)`;
  sql`CREATE TABLE IF NOT EXISTS kk_mail_out (cursor INTEGER PRIMARY KEY AUTOINCREMENT, inbox_id INTEGER NOT NULL, kind TEXT NOT NULL, text TEXT NOT NULL, at INTEGER NOT NULL)`;
}

export function parseInstruction(body: unknown): string | undefined {
  const t = typeof body === "object" && body !== null ? (body as { text?: unknown }).text : undefined;
  if (typeof t !== "string") return undefined;
  const trimmed = t.trim();
  return trimmed && trimmed.length <= MAX_INSTRUCTION_CHARS ? trimmed : undefined;
}

const oneLine = (s: string) => s.replace(/\s+/g, " ").trim();

export function enqueue(sql: Sql, text: string, now = Date.now()): number {
  const [row] = sql<{ id: number }>`INSERT INTO kk_mail_in (text, status, at) VALUES (${text}, 'pending', ${now}) RETURNING id`;
  const id = Number(row.id);
  const summary = oneLine(text);
  sql`INSERT INTO kk_mail_out (inbox_id, kind, text, at) VALUES (${id}, 'ack', ${`ack #${id} ${summary.length > 80 ? `${summary.slice(0, 80)}…` : summary}`}, ${now})`;
  return id;
}

/** Oldest instruction not yet finished; instructions run strictly in arrival order. */
export function nextPending(sql: Sql): Pending | undefined {
  const [row] = sql`SELECT id, text FROM kk_mail_in WHERE status = 'pending' ORDER BY id LIMIT 1`;
  return row ? { id: Number(row.id), text: String(row.text) } : undefined;
}

/** Writes the single done receipt for an instruction; a second call for the same id is a no-op. */
export function finish(sql: Sql, id: number, result: string, now = Date.now()): boolean {
  const updated = sql`UPDATE kk_mail_in SET status = 'done' WHERE id = ${id} AND status = 'pending' RETURNING id`;
  if (!updated.length) return false;
  sql`INSERT INTO kk_mail_out (inbox_id, kind, text, at) VALUES (${id}, 'done', ${`done #${id} ${oneLine(result) || "(no text)"}`}, ${now})`;
  return true;
}

export function readOutbox(sql: Sql, since: number, limit = 100): OutLine[] {
  return sql`SELECT cursor, inbox_id, kind, text, at FROM kk_mail_out WHERE cursor > ${since} ORDER BY cursor LIMIT ${limit}`.map((r) => ({
    cursor: Number(r.cursor),
    inboxId: Number(r.inbox_id),
    kind: r.kind as OutLine["kind"],
    text: String(r.text),
    at: Number(r.at),
  }));
}
