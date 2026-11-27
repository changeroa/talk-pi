#!/usr/bin/env bun
import { classifyKakaoChat, KakaoTalkClient, KakaoTalkListener } from "agent-messenger/kakaotalk";
import { Long } from "bson";
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
const linkIds = new Map<string, string | undefined>();
const memberNames = new Map<string, string>();

/**
 * The client only knows names from the login snapshot, which misses most members of a large open chat.
 * Look up an unknown author once (a MEMBER request for that one id) and remember the answer, even an empty one.
 */
const authorName = async (chatId: string, authorId: number): Promise<string> => {
  const key = `${chatId}:${authorId}`;
  const known = memberNames.get(key);
  if (known !== undefined) return known;
  const [member] = await client.getMembersByIds(chatId, [String(authorId)]);
  const name = member?.nickname ?? "";
  memberNames.set(key, name);
  return name;
};

/** Replies queued before a restart arrive before any inbound message, so the chat kind is looked up, never assumed. */
const chatInfo = async (chatId: string): Promise<ChatInfo> => {
  const cached = chats.get(chatId);
  if (cached) return cached;
  const chat = await client.getChat(chatId);
  const info: ChatInfo = { kind: classifyKakaoChat(chat), title: chat.title ?? undefined };
  chats.set(chatId, info);
  return info;
};

/**
 * Open chats need the room's link id on the typing packet, and KakaoChat does not expose it,
 * so read it once per room from CHATINFO (`chatInfo.li`, a number or a BSON Long).
 */
const openLinkId = async (chatId: string): Promise<string | undefined> => {
  if (linkIds.has(chatId)) return linkIds.get(chatId);
  const session = await client.acquireSession();
  const res = await session.getChannelInfo(Long.fromString(chatId));
  const li = (res.body as { chatInfo?: { li?: unknown } }).chatInfo?.li;
  const id = li === undefined || li === null ? undefined : Long.isLong(li) ? li.toString() : typeof li === "number" ? String(li) : undefined;
  const linkId = id && id !== "0" ? id : undefined;
  linkIds.set(chatId, linkId);
  return linkId;
};

const bridge = new Bridge({
  selfUserId: String(client.getCredentials().userId),
  connect: () => new WebSocket(AGENT_WS_URL, { headers: { Authorization: `Bearer ${BRIDGE_TOKEN}` } }) as unknown as SocketLike,
  sendKakao: async (chatId, text) => {
    await client.sendMessage(chatId, text);
  },
  sendTyping: async (chatId) => {
    const linkId = (await chatInfo(chatId)).kind === "open" ? await openLinkId(chatId) : undefined;
    await client.sendTyping(chatId, linkId ? { linkId } : undefined);
  },
  chatInfo,
  log,
  setTimer: (fn, ms) => setTimeout(fn, ms),
  sleep: (ms) => Bun.sleep(ms),
  random: Math.random,
});

listener.on("connected", () => log("kakao_connected", {}));
listener.on("disconnected", () => log("kakao_disconnected", {}));
listener.on("error", (err) => log("kakao_error", { name: err.name }));
/** Optional operator switch: when set, only these chats are forwarded (comma-separated chat ids). */
const onlyChats = new Set((process.env.ONLY_CHAT_IDS ?? "").split(",").map((s) => s.trim()).filter(Boolean));

listener.on("message", (ev) => {
  if (onlyChats.size && !onlyChats.has(ev.chat_id)) return;
  (async () => {
    const own = String(ev.author_id) === String(client.getCredentials().userId);
    const name = ev.author_name || (own ? "" : await authorName(ev.chat_id, ev.author_id).catch(() => ""));
    await bridge.onKakaoMessage({ ...ev, author_name: name || null });
  })().catch((err: Error) => log("forward_failed", { messageId: ev.log_id, error: err.name }));
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
