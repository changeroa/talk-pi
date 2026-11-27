import { PROVENANCE, type Provenance } from "./notes";

export type ChatKind = "dm" | "group" | "open" | "unknown";

export type InboundMessage = {
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

export type BridgeFrame =
  | InboundMessage
  | { type: "delivered"; messageId: string }
  | { type: "restart" }
  /** Operator frames: bulk-write notes and read them back by path prefix. */
  | { type: "import_notes"; notes: ImportNote[] }
  | { type: "read_notes"; prefix: string };

export type ImportNote = { path: string; description: string; source: Provenance; body: string };

export type AgentFrame =
  | { type: "hello"; bootId: string }
  | { type: "ack"; messageId: string; status: "accepted" | "duplicate" }
  | { type: "reply"; replyTo: string; chatId: string; text: string }
  | { type: "imported"; saved: string[]; errors: { path: string; error: string }[] }
  | { type: "notes"; notes: ImportNote[] };

const KINDS: readonly ChatKind[] = ["dm", "group", "open", "unknown"];

export function parseBridgeFrame(raw: string): BridgeFrame | undefined {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (typeof value !== "object" || value === null) return undefined;
  const f = value as Record<string, unknown>;
  const s = (k: string) => typeof f[k] === "string" && (f[k] as string).length > 0;
  switch (f.type) {
    case "restart":
      return { type: "restart" };
    case "read_notes":
      return typeof f.prefix === "string" ? { type: "read_notes", prefix: f.prefix } : undefined;
    case "import_notes": {
      if (!Array.isArray(f.notes)) return undefined;
      const notes: ImportNote[] = [];
      for (const n of f.notes as Record<string, unknown>[]) {
        if (typeof n?.path !== "string" || typeof n.description !== "string" || typeof n.body !== "string") return undefined;
        if (!PROVENANCE.includes(n.source as Provenance)) return undefined;
        notes.push({ path: n.path, description: n.description, source: n.source as Provenance, body: n.body });
      }
      return { type: "import_notes", notes };
    }
    case "delivered":
      return s("messageId") ? { type: "delivered", messageId: f.messageId as string } : undefined;
    case "message":
      if (!s("messageId") || !s("chatId") || !s("senderId") || !s("text") || typeof f.ts !== "number") return undefined;
      return {
        type: "message",
        messageId: f.messageId as string,
        chatId: f.chatId as string,
        chatKind: KINDS.includes(f.chatKind as ChatKind) ? (f.chatKind as ChatKind) : "unknown",
        chatTitle: typeof f.chatTitle === "string" ? f.chatTitle : undefined,
        senderId: f.senderId as string,
        senderName: typeof f.senderName === "string" && f.senderName ? f.senderName : "이름 모름",
        text: f.text as string,
        ts: f.ts,
      };
    default:
      return undefined;
  }
}
