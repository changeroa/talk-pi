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
  chatInfo(chatId: string): Promise<ChatInfo>;
  selfUserId: string;
  log(event: string, fields: Record<string, string | number | boolean>): void;
  setTimer(fn: () => void, ms: number): unknown;
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
  private readonly replies = new Deduper();

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
    if (this.replies.firstTime(frame.replyTo)) {
      try {
        await this.deps.sendKakao(frame.chatId, frame.text);
        this.deps.log("replied", { chatId: frame.chatId, replyTo: frame.replyTo });
      } catch (error) {
        this.deps.log("send_failed", { chatId: frame.chatId, replyTo: frame.replyTo, error: (error as Error).name });
        return;
      }
    }
    this.socket?.send(JSON.stringify({ type: "delivered", messageId: frame.replyTo }));
  }
}
