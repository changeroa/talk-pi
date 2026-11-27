#!/usr/bin/env bun
// Plays the bridge side of the socket against the deployed agent; no KakaoTalk account involved.
// Memory writes and kibitzer nudges are observed through the Worker's structured logs (wrangler tail).
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const URL_ = process.env.AGENT_WS_URL;
if (!URL_) throw new Error("AGENT_WS_URL is not set (wss://<worker host>/agents/talk-pi/main)");
const WORKER = process.env.WORKER_NAME ?? "talk-pi";
const OWNER_ID = process.env.E2E_OWNER_ID ?? "e2e-owner";
const CONFIG = process.env.TALK_PI_CONFIG ?? join(homedir(), ".config/talk-pi");
const token = process.env.BRIDGE_TOKEN ?? readFileSync(join(CONFIG, "bridge.env"), "utf8").match(/^BRIDGE_TOKEN=(.+)$/m)![1];

type Frame = { type: string; [k: string]: unknown };
type LogEvent = { event: string; chatId?: string; path?: string; accepted?: boolean; [k: string]: unknown };
const log = (dir: string, f: unknown) => console.log(`${new Date().toISOString()} ${dir} ${JSON.stringify(f)}`);

function waiterQueue<T>() {
  const items: T[] = [];
  const waiters: { pred: (x: T) => boolean; done: (x: T) => void }[] = [];
  return {
    items,
    push(x: T) {
      items.push(x);
      const i = waiters.findIndex((w) => w.pred(x));
      if (i >= 0) waiters.splice(i, 1)[0].done(x);
    },
    next(pred: (x: T) => boolean, ms: number, what: string): Promise<T> {
      return new Promise((done, fail) => {
        const hit = items.find(pred);
        if (hit) return done(hit);
        const t = setTimeout(() => fail(new Error(`timeout after ${ms}ms waiting for ${what}`)), ms);
        waiters.push({ pred, done: (x) => (clearTimeout(t), done(x)) });
      });
    },
  };
}

const workerLogs = waiterQueue<LogEvent>();
const tail = Bun.spawn(["bunx", "wrangler", "tail", WORKER, "--format", "pretty"], { stdout: "pipe", stderr: "pipe" });
const tailReady = (async () => {
  let ready: () => void = () => {};
  const isReady = new Promise<void>((r) => (ready = r));
  void (async () => {
    const decoder = new TextDecoder();
    let buf = "";
    for await (const chunk of tail.stdout) {
      buf += decoder.decode(chunk, { stream: true });
      let nl: number;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        if (/Connected to|tail.*started|Waiting for logs/i.test(line)) ready();
        const m = line.match(/\{"event".*\}\s*$/);
        if (m) {
          const ev = JSON.parse(m[0]) as LogEvent;
          log("log", ev);
          workerLogs.push(ev);
        }
      }
    }
  })();
  void (async () => {
    const decoder = new TextDecoder();
    for await (const chunk of tail.stderr) if (/Connected to|Waiting for logs/i.test(decoder.decode(chunk))) ready();
  })();
  return isReady;
})();

function open(auth: string | undefined): Promise<{ ws: WebSocket; next: (pred: (f: Frame) => boolean, ms: number) => Promise<Frame> }> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(URL_!, auth ? { headers: { Authorization: `Bearer ${auth}` } } : undefined);
    const frames = waiterQueue<Frame>();
    ws.onmessage = (e) => {
      const f = JSON.parse(String(e.data)) as Frame;
      log("<-", f);
      frames.push(f);
    };
    const next = (pred: (f: Frame) => boolean, ms: number) => frames.next(pred, ms, "frame");
    ws.onopen = () => resolve({ ws, next });
    ws.onerror = () => reject(new Error("socket error"));
    ws.onclose = (e) => reject(new Error(`closed ${e.code}`));
  });
}

const send = (ws: WebSocket, f: Frame) => (log("->", f), ws.send(JSON.stringify(f)));
const run = Date.now().toString(36);
const msg = (n: string, chatId: string, senderId: string, senderName: string, text: string): Frame => ({
  type: "message", messageId: `e2e-${run}-${n}`, chatId, chatKind: "dm", senderId, senderName, text, ts: Math.floor(Date.now() / 1000),
});
const chatA = `e2e-chat-a-${run}`;
const chatB = `e2e-chat-b-${run}`;
const result: Record<string, unknown> = { run };

// One connection per turn: a Durable Object flushes its logs to wrangler tail only when the socket's request ends.
async function turn(m: Frame): Promise<{ text: string; ack: unknown }> {
  const c = await open(token);
  send(c.ws, m);
  const ack = (await c.next((f) => f.type === "ack" && f.messageId === m.messageId, 10_000)).status;
  const r = await c.next((f) => f.type === "reply" && f.replyTo === m.messageId, 180_000);
  send(c.ws, { type: "delivered", messageId: m.messageId as string });
  c.ws.close();
  return { text: String(r.text), ack };
}

await Promise.race([tailReady, new Promise((_, fail) => setTimeout(() => fail(new Error("wrangler tail did not connect")), 60_000))]);

let unauthorized = false;
await open("wrong-token").catch(() => (unauthorized = true));
result.unauthorized_rejected = unauthorized;

// Only mechanical guarantees are checked here; what the models choose to remember or recall is not.
// (a) chat A: two owner turns, each must be accepted and answered.
const allergyMsg = msg("1", chatA, OWNER_ID, "Owner", "나 갑각류 알레르기 있어. 꼭 기억해 둬.");
const first = await turn(allergyMsg);
result.first_ack = first.ack;
const second = await turn(msg("2", chatA, OWNER_ID, "Owner", "그리고 나 제일 좋아하는 색은 하늘색이야."));
result.chat_a_replied = first.text.length > 0 && second.text.length > 0;

let c = await open(token);
const hello1 = await c.next((f) => f.type === "hello", 10_000);
send(c.ws, allergyMsg);
result.duplicate_ack = (await c.next((f) => f.type === "ack" && f.messageId === allergyMsg.messageId, 10_000)).status;
const closed = new Promise<void>((r) => c.ws.addEventListener("close", () => r()));
send(c.ws, { type: "restart" });
await closed;
c = await open(token);
const hello2 = await c.next((f) => f.type === "hello", 10_000);
result.restarted = hello1.bootId !== hello2.bootId;
c.ws.close();

// Strangers are no longer filtered by code: the turn must be accepted and finish without error (reply or silence is the model's call).
const strangerChat = `e2e-chat-x-${run}`;
const stranger = msg("x", strangerChat, "e2e-stranger", "Stranger", "안녕하세요");
c = await open(token);
send(c.ws, stranger);
result.stranger_ack = (await c.next((f) => f.type === "ack" && f.messageId === stranger.messageId, 10_000)).status;
const strangerReply = await c.next((f) => f.type === "reply" && f.replyTo === stranger.messageId, 120_000).catch(() => undefined);
if (strangerReply) send(c.ws, { type: "delivered", messageId: stranger.messageId as string });
c.ws.close();
// A reply already proves the turn finished. Only a silent turn needs the log, and a live bridge socket can hold the
// restarted Durable Object's logs until it disconnects, so the log is not required when a reply arrived.
const strangerTurn = strangerReply
  ? { status: "done" }
  : await workerLogs.next((e) => e.event === "turn" && e.chatId === strangerChat, 120_000, "stranger turn log");
result.stranger_turn = strangerTurn;

// (b) chat B after restart: the agent still answers.
const dinner = msg("3", chatB, OWNER_ID, "Owner", "오늘 저녁에 새우 감바스 해 먹으려는데, 레시피 좀 짧게 알려줘.");
const dinnerReply = (await turn(dinner)).text;
await workerLogs.next((e) => e.event === "turn" && e.chatId === chatB, 60_000, "chat B turn log");
const nudgesB = () => workerLogs.items.filter((e) => e.event === "recall_delivered" && e.chatId === chatB).map((e) => String(e.path));
result.recall_reply = dinnerReply;
result.delivered_after_dinner = nudgesB();

// (d) a follow-up in the same chat: no recall path is delivered twice.
const followUp = msg("4", chatB, OWNER_ID, "Owner", "고마워. 그럼 곁들일 샐러드도 하나 추천해 줘.");
result.follow_up_reply = (await turn(followUp)).text;
await workerLogs.next((e) => e.event === "turn" && e.chatId === chatB && e.messageId === followUp.messageId, 60_000, "follow-up turn log");
tail.kill();

const delivered = nudgesB();
result.delivered_paths = delivered;
result.kibitzer_turns = workerLogs.items.filter((e) => e.event === "kibitzer_turn" && e.chatId === chatB);
const checks = {
  chat_a_replied: result.chat_a_replied === true,
  chat_b_replied_after_restart: dinnerReply.length > 0 && String(result.follow_up_reply).length > 0,
  no_repeat_delivery: new Set(delivered).size === delivered.length,
  restarted: result.restarted === true,
  unauthorized_rejected: unauthorized,
  duplicate_ack: result.duplicate_ack === "duplicate",
  stranger_handled: result.stranger_ack === "accepted" && strangerTurn.status === "done",
};
result.checks = checks;
result.e2e_passed = Object.values(checks).every(Boolean);
console.log(JSON.stringify(result, null, 2));
process.exit(result.e2e_passed ? 0 : 1);
