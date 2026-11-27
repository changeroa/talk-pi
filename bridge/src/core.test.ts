import { describe, expect, test } from "bun:test";
import { backoffMs, Bridge, normal, REPLY_DELAY, replyDelayMs, shouldForward, splitReply, TYPING_REFRESH_MS, type ChatInfo, type KakaoEvent, type SocketLike } from "./core";

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

function setup(chats: Record<string, ChatInfo> = { c1: { kind: "dm" } }, failSend = false, failTyping = false) {
  const sockets: FakeSocket[] = [];
  const kakao: { chatId: string; text: string }[] = [];
  const timers: number[] = [];
  const logs: string[] = [];
  const sleeps: number[] = [];
  const events: string[] = [];
  const bridge = new Bridge({
    sleep: async (ms) => {
      sleeps.push(ms);
      events.push(`sleep ${ms}`);
    },
    sendTyping: async (chatId) => {
      if (failTyping) throw new Error("typing down");
      events.push(`typing ${chatId}`);
    },
    random: () => 0.25,
    selfUserId: SELF,
    connect: () => {
      const s = new FakeSocket();
      sockets.push(s);
      return s;
    },
    sendKakao: async (chatId, text) => {
      if (failSend) throw new Error("boom");
      kakao.push({ chatId, text });
      events.push(`send ${text}`);
    },
    chatInfo: async (id) => chats[id] ?? { kind: "unknown" },
    log: (e, fields) => logs.push(`${e} ${JSON.stringify(fields)}`),
    setTimer: (fn, ms) => {
      timers.push(ms);
      fn();
    },
  });
  bridge.start();
  return { bridge, sockets, kakao, timers, logs, sleeps, events };
}

describe("reply delay", () => {
  test("median is read + think + type; grows with both lengths; log-normal jitter; floor and cap", () => {
    const { readMsPerChar, thinkMs, typeMsPerChar, sigma, minMs, capMs } = REPLY_DELAY;
    expect(replyDelayMs(10, "응 알았어", 0)).toBe(10 * readMsPerChar + thinkMs + 5 * typeMsPerChar);
    expect(replyDelayMs(40, "응", 0)).toBeGreaterThan(replyDelayMs(0, "응", 0));
    expect(replyDelayMs(0, "응 알았어", 1)).toBe(Math.round((thinkMs + 5 * typeMsPerChar) * Math.exp(sigma)));
    expect(replyDelayMs(0, "", -5)).toBe(minMs);
    expect(replyDelayMs(0, "x".repeat(5_000), 0)).toBe(capMs);
    expect(normal(1, 0)).toBeCloseTo(0);
    expect(normal(Math.exp(-0.5), 0)).toBeCloseTo(1);
  });
  test("splits on every line break and drops blank lines", () => {
    expect(splitReply("한 줄")).toEqual(["한 줄"]);
    expect(splitReply("한 줄\n두 줄\n\n \n세 줄 ")).toEqual(["한 줄", "두 줄", "세 줄"]);
  });
});

describe("typing before a reply", () => {
  test("shows typing, renewed every TYPING_REFRESH_MS, for the whole delay before each part", async () => {
    const { sockets, events, sleeps } = setup();
    sockets[0].onopen!();
    await sockets[0].deliver({ type: "reply", replyTo: "R", chatId: "c1", text: "x".repeat(40) });
    await new Promise((r) => setImmediate(r));
    const total = sleeps.reduce((a, b) => a + b, 0);
    expect(sleeps.every((ms) => ms <= TYPING_REFRESH_MS)).toBe(true);
    expect(total).toBe(replyDelayMs(0, "x".repeat(40), normal(0.25, 0.25)));
    expect(events.filter((e) => e === "typing c1").length).toBe(Math.ceil(total / TYPING_REFRESH_MS));
    expect(events.at(-1)).toBe(`send ${"x".repeat(40)}`);
    expect(events[0]).toBe("typing c1");
  });
  test("open chats show typing and get the reply like any other chat", async () => {
    const { bridge, sockets, events, kakao } = setup({ o1: { kind: "open" } });
    sockets[0].onopen!();
    await bridge.onKakaoMessage(ev({ chat_id: "o1", log_id: "L9" }));
    await sockets[0].deliver({ type: "reply", replyTo: "L9", chatId: "o1", text: "응" });
    await new Promise((r) => setImmediate(r));
    expect(events[0]).toBe("typing o1");
    expect(kakao).toEqual([{ chatId: "o1", text: "응" }]);
  });
  test("after one failed typing signal that chat gets no more typing packets", async () => {
    const { sockets, logs } = setup(undefined, false, true);
    sockets[0].onopen!();
    await sockets[0].deliver({ type: "reply", replyTo: "R1", chatId: "c1", text: "x".repeat(40) });
    await new Promise((r) => setImmediate(r));
    await sockets[0].deliver({ type: "reply", replyTo: "R2", chatId: "c1", text: "x".repeat(40) });
    await new Promise((r) => setImmediate(r));
    expect(logs.filter((l) => l.startsWith("typing_failed")).length).toBe(1);
  });
  test("two replies to one chat go out one after the other, not interleaved", async () => {
    const { sockets, kakao } = setup();
    sockets[0].onopen!();
    void sockets[0].deliver({ type: "reply", replyTo: "A", chatId: "c1", text: "a1\na2" });
    void sockets[0].deliver({ type: "reply", replyTo: "B", chatId: "c1", text: "b1\nb2" });
    for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
    expect(kakao.map((k) => k.text)).toEqual(["a1", "a2", "b1", "b2"]);
  });
  test("a failing typing signal sends nothing, and the drop is confirmed", async () => {
    const { sockets, kakao, logs } = setup(undefined, false, true);
    sockets[0].onopen!();
    await sockets[0].deliver({ type: "reply", replyTo: "R", chatId: "c1", text: "응" });
    await new Promise((r) => setImmediate(r));
    expect(kakao).toEqual([]);
    expect(logs.some((l) => l.startsWith("typing_failed"))).toBe(true);
    expect(sockets[0].sent.at(-1)).toEqual({ type: "delivered", messageId: "R" });
  });
});

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
    await new Promise((r) => setImmediate(r));
    await sockets[0].deliver(reply);
    await new Promise((r) => setImmediate(r));
    expect(kakao).toEqual([{ chatId: "c1", text: "응 오빠" }]);
    expect(sockets[0].sent).toEqual([
      { type: "delivered", messageId: "A" },
      { type: "delivered", messageId: "A" },
    ]);
  });

  test("waits before each line and confirms delivery only after the last send", async () => {
    const { bridge, sockets, kakao, sleeps } = setup();
    sockets[0].onopen!();
    await bridge.onKakaoMessage(ev({ log_id: "A", message: "오늘 저녁 먹었어?" }));
    await sockets[0].deliver({ type: "reply", replyTo: "A", chatId: "c1", text: "응\n알았어" });
    await new Promise((r) => setImmediate(r));
    const z = normal(0.25, 0.25);
    expect(sleeps).toEqual([replyDelayMs(10, "응", z), replyDelayMs(0, "알았어", z)]);
    expect(kakao.map((k) => k.text)).toEqual(["응", "알았어"]);
    expect(sockets[0].sent.filter((f) => f.type === "delivered")).toEqual([{ type: "delivered", messageId: "A" }]);
  });

  test("a resend after a mid-reply failure sends only the remaining parts, then confirms", async () => {
    const sockets: FakeSocket[] = [];
    const kakao: string[] = [];
    let failOn = "둘";
    const bridge = new Bridge({
      selfUserId: SELF,
      connect: () => (sockets.push(new FakeSocket()), sockets.at(-1)!),
      sendKakao: async (_c, text) => {
        if (text === failOn) throw new Error("boom");
        kakao.push(text);
      },
      chatInfo: async () => ({ kind: "dm" }),
      log: () => {},
      setTimer: () => {},
      sleep: async () => {},
      sendTyping: async () => {},
      random: () => 0.5,
    });
    bridge.start();
    sockets[0].onopen!();
    const reply = { type: "reply", replyTo: "A", chatId: "c1", text: "하나\n둘\n셋" };
    await sockets[0].deliver(reply);
    await new Promise((r) => setImmediate(r));
    expect(kakao).toEqual(["하나"]);
    expect(sockets[0].sent).toEqual([]);
    failOn = "";
    await sockets[0].deliver(reply);
    await new Promise((r) => setImmediate(r));
    await sockets[0].deliver(reply);
    await new Promise((r) => setImmediate(r));
    expect(kakao).toEqual(["하나", "둘", "셋"]);
    expect(sockets[0].sent).toEqual([
      { type: "delivered", messageId: "A" },
      { type: "delivered", messageId: "A" },
    ]);
  });

  test("does not confirm delivery when the Kakao send fails, so the agent resends it", async () => {
    const { sockets, logs } = setup({ c1: { kind: "dm" } }, true);
    sockets[0].onopen!();
    await sockets[0].deliver({ type: "reply", replyTo: "A", chatId: "c1", text: "비밀 내용" });
    await new Promise((r) => setImmediate(r));
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
