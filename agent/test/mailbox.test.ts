import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { enqueue, finish, MAX_INSTRUCTION_CHARS, migrateMailbox, nextPending, parseInstruction, readOutbox, type Sql } from "../src/mailbox";

function sqlite(): Sql {
  const db = new Database(":memory:");
  return ((strings: TemplateStringsArray, ...values: (string | number | null)[]) =>
    db.query(strings.join("?")).all(...values)) as Sql;
}

function box(): Sql {
  const sql = sqlite();
  migrateMailbox(sql);
  return sql;
}

describe("lead mailbox", () => {
  test("accepts only a non-empty text instruction within the limit", () => {
    expect(parseInstruction({ text: "  ping  " })).toBe("ping");
    expect(parseInstruction({ text: "   " })).toBeUndefined();
    expect(parseInstruction({ text: 1 })).toBeUndefined();
    expect(parseInstruction(undefined)).toBeUndefined();
    expect(parseInstruction({ text: "x".repeat(MAX_INSTRUCTION_CHARS + 1) })).toBeUndefined();
  });

  test("every instruction gets an ack on receipt and is processed in arrival order", () => {
    const sql = box();
    const a = enqueue(sql, "first\nline", 1);
    const b = enqueue(sql, "second", 2);
    expect(readOutbox(sql, 0).map((l) => [l.inboxId, l.kind, l.text])).toEqual([
      [a, "ack", `ack #${a} first line`],
      [b, "ack", `ack #${b} second`],
    ]);
    expect(nextPending(sql)).toEqual({ id: a, text: "first\nline" });
    finish(sql, a, "ok");
    expect(nextPending(sql)).toEqual({ id: b, text: "second" });
    finish(sql, b, "");
    expect(nextPending(sql)).toBeUndefined();
  });

  test("done is written exactly once and the cursor reads only newer lines", () => {
    const sql = box();
    const id = enqueue(sql, "ping: reply done pong");
    const [ack] = readOutbox(sql, 0);
    expect(finish(sql, id, "pong")).toBeTrue();
    expect(finish(sql, id, "again")).toBeFalse();
    const after = readOutbox(sql, ack.cursor);
    expect(after.map((l) => [l.kind, l.text])).toEqual([["done", `done #${id} pong`]]);
    expect(readOutbox(sql, after[0].cursor)).toEqual([]);
  });

  test("long instructions are summarized in the ack but kept whole for the turn", () => {
    const sql = box();
    const long = "가".repeat(200);
    const id = enqueue(sql, long);
    expect(readOutbox(sql, 0)[0].text).toBe(`ack #${id} ${"가".repeat(80)}…`);
    expect(nextPending(sql)?.text).toBe(long);
  });
});
