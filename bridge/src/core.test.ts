import { describe, expect, test } from "bun:test";
import { backoffMs, Bridge, shouldForward, type ChatInfo, type KakaoEvent, type SocketLike } from "./core";

class FakeSocket implements SocketLike {
  sent: Record<string, unknown>[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  send(data: string) {
    this.sent.push(JSON.parse(data));
  }
  close() {
    this.onclose?.();
  }
  async deliver(frame: unknown) {
    this.onmessage?.({ data: JSON.stringify(frame) });
    await Promise.resolve();
    await Promise.resolve();
  }
}

const SELF = "1000";
const ev = (over: Partial<KakaoEvent> = {}): KakaoEvent => ({
  chat_id: "c1", log_id: "L1", author_id: 42, author_name: "Owner", message: "안녕", sent_at: 1, ...over,
});

function setup(chats: Record<string, ChatInfo> = { c1: { kind: "dm" } }, failSend = false) {
  const sockets: FakeSocket[] = [];
  const kakao: { chatId: string; text: string }[] = [];
  const timers: number[] = [];
  const logs: string[] = [];
  const bridge = new Bridge({
    selfUserId: SELF,
    connect: () => {
      const s = new FakeSocket();
      sockets.push(s);
      return s;
    },
    sendKakao: async (chatId, text) => {
      if (failSend) throw new Error("boom");
      kakao.push({ chatId, text });
    },
    chatInfo: async (id) => chats[id] ?? { kind: "unknown" },
    log: (e, fields) => logs.push(`${e} ${JSON.stringify(fields)}`),
    setTimer: (fn, ms) => {
      timers.push(ms);
      fn();
    },
  });
  bridge.start();
  return { bridge, sockets, kakao, timers, logs };
}

describe("shouldForward", () => {
  test("forwards any non-empty message from someone else", () => {
    expect(shouldForward(ev(), SELF)).toBe(true);
    expect(shouldForward(ev({ message: "점심 뭐 먹지" }), SELF)).toBe(true);
  });
  test("skips own messages and empty text", () => {
    expect(shouldForward(ev({ author_id: 1000 }), SELF)).toBe(false);
    expect(shouldForward(ev({ message: "  " }), SELF)).toBe(false);
  });
});

describe("backoffMs", () => {
  test("doubles from 1s and caps at 60s", () => {
    expect([0, 1, 2, 5, 6, 20].map(backoffMs)).toEqual([1000, 2000, 4000, 32000, 60000, 60000]);
  });
});

describe("Bridge", () => {
  test("queues messages until the agent socket opens, then flushes them in order", async () => {
    const { bridge, sockets } = setup();
    await bridge.onKakaoMessage(ev({ log_id: "A" }));
    await bridge.onKakaoMessage(ev({ log_id: "B" }));
    expect(sockets[0].sent).toEqual([]);
    sockets[0].onopen!();
    expect(sockets[0].sent.map((f) => f.messageId)).toEqual(["A", "B"]);
    expect(sockets[0].sent[0]).toMatchObject({ type: "message", chatId: "c1", chatKind: "dm", senderId: "42", senderName: "Owner", text: "안녕", ts: 1 });
  });

  test("forwards each Kakao log id once, including unaddressed group chatter", async () => {
    const { bridge, sockets } = setup({ c1: { kind: "dm" }, g: { kind: "group", title: "팀" } });
    sockets[0].onopen!();
    await bridge.onKakaoMessage(ev({ log_id: "A" }));
    await bridge.onKakaoMessage(ev({ log_id: "A" }));
    await bridge.onKakaoMessage(ev({ log_id: "G1", chat_id: "g", message: "회의 몇 시?" }));
    await bridge.onKakaoMessage(ev({ log_id: "G2", chat_id: "g", message: "아리야 회의 몇 시?" }));
    expect(sockets[0].sent.map((f) => f.messageId)).toEqual(["A", "G1", "G2"]);
    expect(sockets[0].sent[1]).toMatchObject({ chatKind: "group", chatTitle: "팀" });
  });

  test("sends a reply to KakaoTalk once and confirms delivery even for a resent reply", async () => {
    const { sockets, kakao } = setup();
    sockets[0].onopen!();
    const reply = { type: "reply", replyTo: "A", chatId: "c1", text: "응 오빠" };
    await sockets[0].deliver(reply);
    await sockets[0].deliver(reply);
    expect(kakao).toEqual([{ chatId: "c1", text: "응 오빠" }]);
    expect(sockets[0].sent).toEqual([
      { type: "delivered", messageId: "A" },
      { type: "delivered", messageId: "A" },
    ]);
  });

  test("does not confirm delivery when the Kakao send fails, so the agent resends it", async () => {
    const { sockets, logs } = setup({ c1: { kind: "dm" } }, true);
    sockets[0].onopen!();
    await sockets[0].deliver({ type: "reply", replyTo: "A", chatId: "c1", text: "비밀 내용" });
    expect(sockets[0].sent).toEqual([]);
    expect(logs.some((l) => l.startsWith("send_failed"))).toBe(true);
    expect(logs.join("\n")).not.toContain("비밀 내용");
  });

  test("reconnects with growing backoff after the agent socket closes, and stop() ends it", () => {
    const { bridge, sockets, timers } = setup();
    sockets[0].onclose!();
    sockets[1].onclose!();
    expect(timers).toEqual([1000, 2000]);
    sockets[2].onopen!();
    sockets[2].onclose!();
    expect(timers).toEqual([1000, 2000, 1000]);
    bridge.stop();
    expect(sockets.length).toBe(4);
  });

  test("never logs message bodies", async () => {
    const { bridge, sockets, logs } = setup();
    sockets[0].onopen!();
    await bridge.onKakaoMessage(ev({ log_id: "A", message: "오빠 비밀번호는 1234" }));
    expect(logs.join("\n")).not.toContain("1234");
  });
});
