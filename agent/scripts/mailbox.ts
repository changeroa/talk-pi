#!/usr/bin/env bun
// Lead side of the talk-pi mailbox.
//   bun scripts/mailbox.ts send "<instruction>"   -> {"id": N}
//   bun scripts/mailbox.ts read [since]           -> outbox lines after a cursor
//   bun scripts/mailbox.ts watch <log file>       -> appends new outbox lines to the log (tail/monitor it to be woken)
// Config: TALK_PI_URL (https://<worker host>) and MAILBOX_TOKEN, from the environment or $TALK_PI_CONFIG/mailbox.env.
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const CONFIG = process.env.TALK_PI_CONFIG ?? join(homedir(), ".config/talk-pi");
const file = join(CONFIG, "mailbox.env");
const vars = existsSync(file) ? Object.fromEntries([...readFileSync(file, "utf8").matchAll(/^([A-Z_]+)=(.*)$/gm)].map((m) => [m[1], m[2]])) : {};
const base = process.env.TALK_PI_URL ?? vars.TALK_PI_URL;
const token = process.env.MAILBOX_TOKEN ?? vars.MAILBOX_TOKEN;
if (!base || !token) throw new Error(`set TALK_PI_URL and MAILBOX_TOKEN (env or ${file})`);
const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };

type Line = { cursor: number; inboxId: number; kind: string; text: string; at: number };

async function read(since: number): Promise<Line[]> {
  const res = await fetch(`${base}/mailbox/outbox?since=${since}`, { headers });
  if (!res.ok) throw new Error(`outbox ${res.status}`);
  return ((await res.json()) as { lines: Line[] }).lines;
}

const [cmd, arg] = process.argv.slice(2);
if (cmd === "send") {
  const res = await fetch(`${base}/mailbox/inbox`, { method: "POST", headers, body: JSON.stringify({ text: arg ?? "" }) });
  console.log(res.status, await res.text());
  if (!res.ok) process.exit(1);
} else if (cmd === "read") {
  for (const l of await read(Number(arg ?? 0))) console.log(JSON.stringify(l));
} else if (cmd === "watch" && arg) {
  const cursorFile = `${arg}.cursor`;
  let since = existsSync(cursorFile) ? Number(readFileSync(cursorFile, "utf8")) : 0;
  for (;;) {
    try {
      for (const l of await read(since)) {
        appendFileSync(arg, `${new Date(l.at).toISOString()} ${l.text}\n`);
        since = l.cursor;
        writeFileSync(cursorFile, String(since));
      }
    } catch (err) {
      console.error(new Date().toISOString(), String(err));
    }
    await Bun.sleep(10_000);
  }
} else {
  console.error("usage: mailbox.ts send <text> | read [since] | watch <log file>");
  process.exit(2);
}
