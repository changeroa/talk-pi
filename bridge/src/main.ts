#!/usr/bin/env bun
import { classifyKakaoChat, KakaoTalkClient, KakaoTalkListener } from "agent-messenger/kakaotalk";
import { Bridge, type ChatInfo, type SocketLike } from "./core";

const required = (name: string) => {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set`);
  return value;
};
const AGENT_WS_URL = required("AGENT_WS_URL");
const BRIDGE_TOKEN = required("BRIDGE_TOKEN");

const log = (event: string, fields: Record<string, string | number | boolean>) =>
  console.log(JSON.stringify({ at: new Date().toISOString(), event, ...fields }));

const client = await new KakaoTalkClient().login();
const listener = new KakaoTalkListener(client);
const chats = new Map<string, ChatInfo>();

const bridge = new Bridge({
  selfUserId: String(client.getCredentials().userId),
  connect: () => new WebSocket(AGENT_WS_URL, { headers: { Authorization: `Bearer ${BRIDGE_TOKEN}` } }) as unknown as SocketLike,
  sendKakao: async (chatId, text) => {
    await client.sendMessage(chatId, text);
  },
  chatInfo: async (chatId) => {
    const cached = chats.get(chatId);
    if (cached) return cached;
    const chat = await client.getChat(chatId);
    const info: ChatInfo = { kind: classifyKakaoChat(chat), title: chat.title ?? undefined };
    chats.set(chatId, info);
    return info;
  },
  log,
  setTimer: (fn, ms) => setTimeout(fn, ms),
  sleep: (ms) => Bun.sleep(ms),
  random: Math.random,
});

listener.on("connected", () => log("kakao_connected", {}));
listener.on("disconnected", () => log("kakao_disconnected", {}));
listener.on("error", (err) => log("kakao_error", { name: err.name }));
listener.on("message", (ev) => {
  bridge.onKakaoMessage(ev).catch((err: Error) => log("forward_failed", { messageId: ev.log_id, error: err.name }));
});

const shutdown = () => {
  bridge.stop();
  listener.stop();
  client.close();
  process.exit(0);
};
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);

bridge.start();
await listener.start();
