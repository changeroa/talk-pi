export type ChatKind = "dm" | "group" | "open" | "unknown";

export type KakaoEvent = {
  chat_id: string;
  log_id: string;
  author_id: number;
  author_name: string | null;
  message: string;
  sent_at: number;
  mentions?: { user_id: string }[];
};

export type ChatInfo = { kind: ChatKind; title?: string };

export type Inbound = {
  type: "message";
  messageId: string;
  chatId: string;
  chatKind: ChatKind;
  chatTitle?: string;
  senderId: string;
  senderName: string;
  text: string;
  ts: number;
};

type AgentFrame =
  | { type: "hello"; bootId: string }
  | { type: "ack"; messageId: string; status: string }
  | { type: "reply"; replyTo: string; chatId: string; text: string };

export interface SocketLike {
  send(data: string): void;
  close(): void;
  onopen: (() => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onclose: (() => void) | null;
  onerror: (() => void) | null;
}

export interface BridgeDeps {
  connect(): SocketLike;
  sendKakao(chatId: string, text: string): Promise<void>;
  /** Shows "typing" in the chat for a few seconds, as the KakaoTalk app does while a person types. */
  sendTyping(chatId: string): Promise<void>;
  chatInfo(chatId: string): Promise<ChatInfo>;
  selfUserId: string;
  log(event: string, fields: Record<string, string | number | boolean>): void;
  setTimer(fn: () => void, ms: number): unknown;
  sleep(ms: number): Promise<void>;
  random(): number;
}

/** Sources for each constant are in the lane result (reply_delay.research). */
export const REPLY_DELAY = { readMsPerChar: 85, thinkMs: 1_500, typeMsPerChar: 330, sigma: 0.35, minMs: 1_200, capMs: 45_000 } as const;

/** The typing signal fades on the other side, so it is renewed this often while the delay runs. */
export const TYPING_REFRESH_MS = 4_000;

/** Standard normal from two uniforms (Box-Muller), so the jitter is log-normal with median 1. */
export function normal(u1: number, u2: number): number {
  return Math.sqrt(-2 * Math.log(Math.max(u1, 1e-12))) * Math.cos(2 * Math.PI * u2);
}

/** Pause before one outgoing message: read the incoming text (first part only), think, type this part. */
export function replyDelayMs(incomingChars: number, part: string, z: number): number {
  const { readMsPerChar, thinkMs, typeMsPerChar, sigma, minMs, capMs } = REPLY_DELAY;
  const ms = (readMsPerChar * incomingChars + thinkMs + typeMsPerChar * [...part].length) * Math.exp(sigma * z);
  return Math.round(Math.min(capMs, Math.max(minMs, ms)));
}

/** Each line goes out as its own message, as people send several short ones. */
export function splitReply(text: string): string[] {
  const parts = text.split("\n").map((p) => p.trim()).filter(Boolean);
  return parts.length ? parts : [text];
}

/** Mechanical only: skip our own messages (loop guard) and empty text. Whether to answer is the agent's call. */
export function shouldForward(ev: KakaoEvent, selfUserId: string): boolean {
  return String(ev.author_id) !== selfUserId && ev.message.trim() !== "";
}

export function backoffMs(attempt: number): number {
  return Math.min(60_000, 1_000 * 2 ** Math.min(attempt, 6));
}

export class Deduper {
  private readonly seen = new Set<string>();
  constructor(private readonly limit = 5_000) {}

  firstTime(id: string): boolean {
    if (this.seen.has(id)) return false;
    this.seen.add(id);
    if (this.seen.size > this.limit) this.seen.delete(this.seen.values().next().value as string);
    return true;
  }
}

export class Bridge {
  private socket: SocketLike | undefined;
  private open = false;
  private attempt = 0;
  private stopped = false;
  private readonly pending: Inbound[] = [];
  private readonly inbound = new Deduper();
  /** Parts already sent per replyTo, so a resent reply continues where it stopped instead of repeating. */
  private readonly sentParts = new Map<string, number>();
  private readonly sending = new Set<string>();
  private readonly incomingChars = new Map<string, number>();
  /** Chats whose typing signal failed once; they get no more typing until restart, so a rejected packet never repeats. */
  private readonly typingOff = new Set<string>();

  constructor(private readonly deps: BridgeDeps) {}

  start(): void {
    this.dial();
  }

  stop(): void {
    this.stopped = true;
    this.socket?.close();
  }

  async onKakaoMessage(ev: KakaoEvent): Promise<void> {
    if (!this.inbound.firstTime(ev.log_id)) return;
    if (!shouldForward(ev, this.deps.selfUserId)) return;
    const info = await this.deps.chatInfo(ev.chat_id);
    const frame: Inbound = {
      type: "message",
      messageId: ev.log_id,
      chatId: ev.chat_id,
      chatKind: info.kind,
      chatTitle: info.title,
      senderId: String(ev.author_id),
      senderName: ev.author_name ?? "",
      text: ev.message,
      ts: ev.sent_at,
    };
    this.incomingChars.set(ev.log_id, [...ev.message].length);
    if (this.incomingChars.size > 5_000) this.incomingChars.delete(this.incomingChars.keys().next().value as string);
    this.deps.log("forward", { chatId: ev.chat_id, messageId: ev.log_id, kind: info.kind });
    if (this.open) this.socket!.send(JSON.stringify(frame));
    else this.pending.push(frame);
  }

  private dial(): void {
    if (this.stopped) return;
    const socket = this.deps.connect();
    this.socket = socket;
    socket.onopen = () => {
      this.open = true;
      this.attempt = 0;
      this.deps.log("agent_connected", {});
      for (const frame of this.pending.splice(0)) socket.send(JSON.stringify(frame));
    };
    socket.onmessage = (ev) => void this.onAgentFrame(String(ev.data));
    socket.onerror = () => this.deps.log("agent_error", {});
    socket.onclose = () => {
      this.open = false;
      if (this.stopped) return;
      const wait = backoffMs(this.attempt++);
      this.deps.log("agent_disconnected", { retryInMs: wait });
      this.deps.setTimer(() => this.dial(), wait);
    };
  }

  /**
   * Waits out the delay while showing "typing", and reports whether typing was shown the whole time.
   * Nothing is sent without it (owner rule: a message must look typed). A chat whose typing failed once stays off
   * until restart, so a rejected packet is never repeated. For open chats main.ts passes the room link id the typing
   * packet needs.
   */
  private async typeFor(chatId: string, ms: number): Promise<boolean> {
    if (this.typingOff.has(chatId)) return false;
    for (let left = ms; left > 0; left -= TYPING_REFRESH_MS) {
      try {
        await this.deps.sendTyping(chatId);
      } catch (error) {
        this.typingOff.add(chatId);
        this.deps.log("typing_failed", { chatId, error: (error as Error).name });
        return false;
      }
      await this.deps.sleep(Math.min(left, TYPING_REFRESH_MS));
    }
    return true;
  }

  private async onAgentFrame(raw: string): Promise<void> {
    let frame: AgentFrame;
    try {
      frame = JSON.parse(raw) as AgentFrame;
    } catch {
      return;
    }
    if (frame.type === "ack") {
      this.deps.log("ack", { messageId: frame.messageId, status: frame.status });
      return;
    }
    if (frame.type !== "reply") return;
    if (this.sending.has(frame.replyTo)) return;
    const parts = splitReply(frame.text);
    let done = this.sentParts.get(frame.replyTo) ?? 0;
    if (done < parts.length) {
      this.sending.add(frame.replyTo);
      try {
        for (; done < parts.length; done++) {
          const read = done === 0 ? (this.incomingChars.get(frame.replyTo) ?? 0) : 0;
          if (!(await this.typeFor(frame.chatId, replyDelayMs(read, parts[done], normal(this.deps.random(), this.deps.random()))))) {
            // Confirm so the agent stops resending: this reply is dropped, not pending.
            this.deps.log("reply_dropped_no_typing", { chatId: frame.chatId, replyTo: frame.replyTo, sentParts: done });
            break;
          }
          await this.deps.sendKakao(frame.chatId, parts[done]);
          this.sentParts.set(frame.replyTo, done + 1);
        }
        if (done === parts.length) this.deps.log("replied", { chatId: frame.chatId, replyTo: frame.replyTo, parts: parts.length });
        else this.sentParts.set(frame.replyTo, parts.length);
      } catch (error) {
        this.deps.log("send_failed", { chatId: frame.chatId, replyTo: frame.replyTo, error: (error as Error).name });
        return;
      } finally {
        this.sending.delete(frame.replyTo);
      }
      if (this.sentParts.size > 5_000) this.sentParts.delete(this.sentParts.keys().next().value as string);
    }
    this.socket?.send(JSON.stringify({ type: "delivered", messageId: frame.replyTo }));
  }
}
