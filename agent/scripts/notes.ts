#!/usr/bin/env bun
// Operator tool over the bridge socket: `import <notes.json>` writes notes, `read <prefix>` prints them back.
// notes.json is [{ path, description, source, body }]; keep it outside the repo when it holds personal notes.
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const [cmd, arg] = process.argv.slice(2);
if ((cmd !== "import" && cmd !== "read") || !arg) throw new Error("usage: bun scripts/notes.ts import <notes.json> | read <path prefix>");
const env = readFileSync(join(process.env.TALK_PI_CONFIG ?? join(homedir(), ".config/talk-pi"), "bridge.env"), "utf8");
const pick = (k: string) => process.env[k] ?? env.match(new RegExp(`^${k}=(.+)$`, "m"))?.[1];
const url = pick("AGENT_WS_URL");
const token = pick("BRIDGE_TOKEN");
if (!url || !token) throw new Error("AGENT_WS_URL and BRIDGE_TOKEN are required");

const frame = cmd === "import" ? { type: "import_notes", notes: JSON.parse(readFileSync(arg, "utf8")) } : { type: "read_notes", prefix: arg };
const want = cmd === "import" ? "imported" : "notes";
const ws = new WebSocket(url, { headers: { Authorization: `Bearer ${token}` } });
const timer = setTimeout(() => (console.error(`timeout waiting for ${want}`), process.exit(1)), 30_000);
ws.onopen = () => ws.send(JSON.stringify(frame));
ws.onmessage = (e) => {
  const f = JSON.parse(String(e.data));
  if (f.type !== want) return;
  clearTimeout(timer);
  console.log(JSON.stringify(f, null, 2));
  ws.close();
  process.exit(cmd === "import" && f.errors.length ? 1 : 0);
};
ws.onerror = () => (console.error("socket error"), process.exit(1));
