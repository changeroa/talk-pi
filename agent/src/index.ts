import { Agent, routeAgentRequest, type Connection, type WSMessage } from "agents";
import { PiHarness } from "agents/harness/pi";
import { createModels, createProvider } from "@earendil-works/pi-ai/models";
import type { Model } from "@earendil-works/pi-ai";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { createRegistry, Harness, type Extension, type ToolRegistration } from "@earendil-works/pi-durable";
import { int, obj, oneOf, opt, str } from "@earendil-works/pi-schema";
import { NO_REPLY, persona } from "./persona";
import { parseBridgeFrame, type AgentFrame, type InboundMessage } from "./protocol";
import { applyEdit, checkPath, PROVENANCE, render, search, type Edit, type Note, type Provenance } from "./notes";
import {
  checkNudge,
  CONTEXT_BUDGET_CHARS,
  KIBITZER_PERSONA,
  recalledMemory,
  reseedEnvelope,
  seedEnvelope,
  TOOL_BUDGET,
  wakeEnvelope,
  type ChatEvent,
  type EventKind,
} from "./kibitzer";

export interface Env {
  TalkPi: DurableObjectNamespace<TalkPi>;
  LITELLM_KEY: string;
  BRIDGE_TOKEN: string;
  /** Comma-separated KakaoTalk user ids of the owner; given to the model as context, never used as a gate. */
  OWNER_KAKAO_IDS: string;
  LITELLM_BASE_URL: string;
  MODEL_ID: string;
  KIBITZER_MODEL_ID: string;
  AGENT_NAME: string;
  OWNER_HONORIFIC: string;
  /** Optional deployment-specific tone/preference text appended to the persona. */
  PERSONA_TONE?: string;
}

const PROVIDER_ID = "litellm";

function liteLlmModel(env: Env, id: string): Model<"openai-completions"> {
  return {
    id,
    name: `${id} (LiteLLM)`,
    api: "openai-completions",
    provider: PROVIDER_ID,
    baseUrl: env.LITELLM_BASE_URL,
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128_000,
    maxTokens: 4_096,
    compat: { supportsStore: false },
  };
}

type Row = Record<string, string | number | null>;
type Turn = { chatId: string; senderId: string };
type KibitzerTurn = Turn & { nudged: number };

const text = (t: string) => ({ output: [{ type: "text" as const, text: t }] });
const fail = (t: string) => ({ output: [{ type: "text" as const, text: t }], isError: true });
const log = (event: string, fields: Record<string, unknown>) => console.log(JSON.stringify({ event, ...fields }));

export class TalkPi extends Agent<Env> {
  /** Changes on every DO start; lets the e2e harness prove a restart happened. */
  readonly bootId = crypto.randomUUID();
  readonly registry = createRegistry();
  readonly primary: Extension = this.primaryExtension();
  readonly kibitzer: Extension = this.kibitzerExtension();
  private readonly kibitzerTurns = new Map<string, KibitzerTurn>();

  readonly harness = new PiHarness({
    harness: ({ storage, context, onWake }) => {
      const models = createModels();
      const ids = [...new Set([this.env.MODEL_ID, this.env.KIBITZER_MODEL_ID])];
      models.setProvider(
        createProvider({
          id: PROVIDER_ID,
          baseUrl: this.env.LITELLM_BASE_URL,
          auth: {
            apiKey: {
              name: "LiteLLM virtual key",
              resolve: async () => ({ auth: { apiKey: this.env.LITELLM_KEY }, source: "LITELLM_KEY" }),
            },
          },
          models: ids.map((id) => liteLlmModel(this.env, id)),
          api: openAICompletionsApi(),
        }),
      );
      return Harness.open(storage, { models, registry: this.registry, onWake }, context);
    },
    defaults: { model: { provider: PROVIDER_ID, id: this.env.MODEL_ID }, maxTurns: 6 },
  });

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.registry.install(this.primary);
    this.registry.install(this.kibitzer);
    this.lifecycle.use(this.harness);
    this.migrate();
  }

  private migrate(): void {
    this.sql`CREATE TABLE IF NOT EXISTS kk_chats (chat_id TEXT PRIMARY KEY, session_id TEXT NOT NULL, kind TEXT, title TEXT)`;
    this.sql`CREATE TABLE IF NOT EXISTS kk_people (sender_id TEXT PRIMARY KEY, name TEXT)`;
    this.sql`DROP TABLE IF EXISTS kk_allow`;
    this.sql`CREATE TABLE IF NOT EXISTS kk_turn (session_id TEXT PRIMARY KEY, chat_id TEXT NOT NULL, sender_id TEXT NOT NULL)`;
    this.sql`CREATE TABLE IF NOT EXISTS kk_seen (message_id TEXT PRIMARY KEY, at INTEGER NOT NULL)`;
    this.sql`CREATE TABLE IF NOT EXISTS kk_outbox (message_id TEXT PRIMARY KEY, chat_id TEXT NOT NULL, text TEXT NOT NULL, created_at INTEGER NOT NULL)`;
    this.sql`CREATE TABLE IF NOT EXISTS kk_notes (path TEXT PRIMARY KEY, description TEXT NOT NULL, source TEXT NOT NULL, body TEXT NOT NULL, updated_at INTEGER NOT NULL)`;
    this.sql`CREATE TABLE IF NOT EXISTS kk_events (cursor INTEGER PRIMARY KEY AUTOINCREMENT, chat_id TEXT NOT NULL, kind TEXT NOT NULL, tool TEXT, body TEXT NOT NULL)`;
    this.sql`CREATE TABLE IF NOT EXISTS kk_kibitzer (chat_id TEXT PRIMARY KEY, session_id TEXT NOT NULL, cursor INTEGER NOT NULL, chars INTEGER NOT NULL)`;
    this.sql`CREATE TABLE IF NOT EXISTS kk_judged (chat_id TEXT NOT NULL, path TEXT NOT NULL, status TEXT NOT NULL, hint TEXT, at INTEGER NOT NULL, PRIMARY KEY (chat_id, path))`;
    this.migrateLegacyMemories();
  }

  private migrateLegacyMemories(): void {
    if (!this.sql<Row>`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'kk_memories'`.length) return;
    for (const r of this.sql<Row>`SELECT id, scope, subject, content, created_at FROM kk_memories`) {
      const dir = r.scope === "person" ? "people" : "chats";
      const path = `${dir}/${String(r.subject).replace(/[^\w.-]/g, "_")}/legacy-${r.id}.md`;
      this.sql`INSERT OR IGNORE INTO kk_notes (path, description, source, body, updated_at) VALUES (${path}, ${String(r.content).slice(0, 120)}, 'inferred', ${String(r.content)}, ${Number(r.created_at)})`;
    }
    this.sql`DROP TABLE kk_memories`;
  }

  private turnFor(sessionId: string): Turn | undefined {
    const [row] = this.sql<Row>`SELECT chat_id, sender_id FROM kk_turn WHERE session_id = ${sessionId}`;
    return row ? { chatId: String(row.chat_id), senderId: String(row.sender_id) } : undefined;
  }

  private note(path: string): Note | undefined {
    const [r] = this.sql<Row>`SELECT path, description, source, body, updated_at FROM kk_notes WHERE path = ${path}`;
    return r ? { path, description: String(r.description), source: r.source as Provenance, body: String(r.body), updatedAt: Number(r.updated_at) } : undefined;
  }

  /** Notes one conversation may see: its speaker's, its own, and shared topics. Other people's notes stay out. */
  private visibleNotes(turn: Turn): Note[] {
    const people = `people/${turn.senderId}/%`;
    const chat = `chats/${turn.chatId}/%`;
    return this.sql<Row>`SELECT path, description, source, body, updated_at FROM kk_notes WHERE path LIKE ${people} OR path LIKE ${chat} OR path LIKE 'topics/%' ORDER BY updated_at DESC`.map(
      (r) => ({ path: String(r.path), description: String(r.description), source: r.source as Provenance, body: String(r.body), updatedAt: Number(r.updated_at) }),
    );
  }

  private appendEvent(chatId: string, kind: EventKind, body: string, tool?: string): void {
    this.sql`INSERT INTO kk_events (chat_id, kind, tool, body) VALUES (${chatId}, ${kind}, ${tool ?? null}, ${body})`;
  }

  private events(chatId: string, since: number, limit = 200): ChatEvent[] {
    return this.sql<Row>`SELECT cursor, kind, tool, body FROM kk_events WHERE chat_id = ${chatId} AND cursor > ${since} ORDER BY cursor LIMIT ${limit}`.map(
      (r) => ({ cursor: Number(r.cursor), kind: r.kind as EventKind, tool: r.tool === null ? undefined : String(r.tool), body: String(r.body) }),
    );
  }

  private speaker(turn: Turn): string {
    const [person] = this.sql<Row>`SELECT name FROM kk_people WHERE sender_id = ${turn.senderId}`;
    const owner = this.isOwner(turn.senderId) ? `주인(${this.env.OWNER_HONORIFIC}) 맞음` : "주인 아님";
    const [chat] = this.sql<Row>`SELECT kind, title FROM kk_chats WHERE chat_id = ${turn.chatId}`;
    const paths = this.visibleNotes(turn).map((n) => `- ${n.path}`);
    return [
      `지금 말하는 사람: ${person?.name ?? "이름 모름"} (id ${turn.senderId}), ${owner}`,
      `대화방: ${chat?.kind ?? "unknown"}${chat?.title ? ` "${chat.title}"` : ""} (id ${turn.chatId})`,
      `이 사람 메모 폴더: people/${turn.senderId}/, 이 대화방 메모 폴더: chats/${turn.chatId}/, 공용: topics/`,
      "저장된 메모 경로(내용은 memory view로 읽기):",
      paths.length ? paths.join("\n") : "- (아직 없음)",
    ].join("\n");
  }

  private primaryExtension(): Extension {
    const Memory = obj({
      command: oneOf(["view", "create", "str_replace", "insert"], { description: "view: 메모 읽기. create: 새 메모. str_replace: 본문 일부 교체. insert: 줄 삽입." }),
      path: str({ description: "people/<id>/<이름>.md, chats/<id>/<이름>.md, topics/<이름>.md" }),
      description: opt(str({ description: "create: 메모가 무엇을 기록하는지 한 줄 요약." })),
      source: opt(oneOf([...PROVENANCE], { description: "create: user(상대가 직접 말함), agent(네가 제안), inferred(네가 추론)." })),
      file_text: opt(str({ description: "create: 메모 본문." })),
      old_string: opt(str({ description: "str_replace: 바꿀 본문 조각(유일해야 함)." })),
      new_string: opt(str({ description: "str_replace: 새 조각." })),
      insert_line: opt(int({ description: "insert: 1부터 시작하는 줄 번호." })),
      insert_text: opt(str({ description: "insert: 넣을 텍스트." })),
    });

    const memory: ToolRegistration<typeof Memory> = {
      name: "memory",
      description: "오래 기억할 사실을 메모(마크다운+frontmatter)로 저장·수정·조회한다. 선호·약속·사실을 알게 된 그 순간 저장하고, 출처(source)를 꼭 기록한다.",
      parameters: Memory,
      replay: "safe",
      execute: async (args, api) => {
        const turn = this.turnFor(String(api.conversationId));
        if (!turn) throw new Error("no active chat for this session");
        const bad = checkPath(args.path);
        if (bad) return fail(bad);
        const current = this.note(args.path);
        if (args.command === "view") return current ? text(render(current)) : fail("note not found");
        const edit: Edit =
          args.command === "create"
            ? { command: "create", description: args.description ?? "", source: args.source ?? "inferred", body: args.file_text ?? "" }
            : args.command === "str_replace"
              ? { command: "str_replace", oldString: args.old_string ?? "", newString: args.new_string ?? "" }
              : { command: "insert", line: args.insert_line ?? 0, text: args.insert_text ?? "" };
        const next = applyEdit(current, edit);
        if ("error" in next) return fail(next.error);
        this.sql`INSERT OR REPLACE INTO kk_notes (path, description, source, body, updated_at) VALUES (${args.path}, ${next.description}, ${next.source}, ${next.body}, ${Date.now()})`;
        this.appendEvent(turn.chatId, "tool_call", JSON.stringify(args), "memory");
        log("memory_write", { chatId: turn.chatId, command: args.command, path: args.path, source: next.source });
        return text(`saved ${args.path}`);
      },
    };
    return {
      name: "talk-pi.primary",
      sections: [
        { key: "persona", render: () => persona({ agentName: this.env.AGENT_NAME, ownerHonorific: this.env.OWNER_HONORIFIC, tone: this.env.PERSONA_TONE }), tag: false },
        {
          key: "speaker",
          render: ({ conversationId }) => {
            const turn = this.turnFor(String(conversationId));
            return turn ? this.speaker(turn) : undefined;
          },
        },
      ],
      tools: [memory],
    };
  }

  private kibitzerExtension(): Extension {
    const Since = obj({ since: int({ description: "Return events after this cursor." }) });
    const Memory = obj({
      operation: oneOf(["search", "read"]),
      query: opt(str({ description: "search: keywords." })),
      path: opt(str({ description: "read: a note path." })),
    });
    const Nudge = obj({
      path: str({ description: "A candidate path or a path returned by memory search." }),
      hint: str({ description: "One sentence, at most 200 characters, stating what the note records." }),
    });
    const turnOf = (conversationId: unknown) => {
      const turn = this.kibitzerTurns.get(String(conversationId));
      if (!turn) throw new Error("kibitzer is not awake");
      return turn;
    };

    const sessionEntries: ToolRegistration<typeof Since> = {
      name: "session_entries",
      description: "Read this conversation's events after a cursor (read-only).",
      parameters: Since,
      replay: "safe",
      execute: async ({ since }, api) => {
        const turn = turnOf(api.conversationId);
        const lines = this.events(turn.chatId, since, 30).map((e) => `[${e.cursor}] ${e.kind}${e.tool ? `(${e.tool})` : ""}: ${e.body.slice(0, 1500)}`);
        return text(lines.join("\n") || "(no events)");
      },
    };
    const memory: ToolRegistration<typeof Memory> = {
      name: "memory",
      description: "Read-only memory: search finds notes visible to this conversation, read returns one.",
      parameters: Memory,
      replay: "safe",
      execute: async ({ operation, query, path }, api) => {
        const turn = turnOf(api.conversationId);
        const visible = this.visibleNotes(turn);
        if (operation === "read") {
          const note = visible.find((n) => n.path === path);
          return note ? text(render(note)) : fail("note not found");
        }
        const hits = search(visible, query ?? "", 5);
        return text(hits.map((h) => `${h.path} — ${h.description}`).join("\n") || "(no matches)");
      },
    };
    const nudge: ToolRegistration<typeof Nudge> = {
      name: "nudge",
      description: "Surface one stored note to the primary agent's next turn. Your only output.",
      parameters: Nudge,
      replay: "safe",
      execute: async ({ path, hint }, api) => {
        const turn = turnOf(api.conversationId);
        const delivered = new Set(this.sql<Row>`SELECT path FROM kk_judged WHERE chat_id = ${turn.chatId} AND status IN ('delivered', 'pending')`.map((r) => String(r.path)));
        const visible = new Set(this.visibleNotes(turn).map((n) => n.path));
        const reason = checkNudge(path, visible, delivered);
        log("nudge", { chatId: turn.chatId, path, accepted: !reason, reason });
        if (reason) return fail(`rejected: ${reason}`);
        turn.nudged++;
        this.sql`INSERT OR REPLACE INTO kk_judged (chat_id, path, status, hint, at) VALUES (${turn.chatId}, ${path}, 'pending', ${hint}, ${Date.now()})`;
        return text("queued for the primary agent's next turn");
      },
    };

    return {
      name: "talk-pi.kibitzer",
      sections: [{ key: "kibitzer", render: () => KIBITZER_PERSONA, tag: false }],
      tools: [sessionEntries, memory, nudge],
    };
  }

  /** Every visible note the kibitzer has not judged yet (or that changed since it declined it); relevance is its call. */
  private candidates(turn: Turn): Note[] {
    const judged = new Map(this.sql<Row>`SELECT path, status, at FROM kk_judged WHERE chat_id = ${turn.chatId}`.map((r) => [String(r.path), r]));
    return this.visibleNotes(turn).filter((n) => {
      const j = judged.get(n.path);
      return !j || (j.status === "rejected" && n.updatedAt > Number(j.at));
    });
  }

  private async newKibitzerSession(): Promise<string> {
    const session = await this.harness.sessions.create({
      agent: { extensions: [this.kibitzer], model: { provider: PROVIDER_ID, modelId: this.env.KIBITZER_MODEL_ID }, maxTurns: TOOL_BUDGET + 1 },
    });
    return session.id;
  }

  private async wakeKibitzer(turn: Turn, messageId: string): Promise<void> {
    const candidates = this.candidates(turn);
    if (!candidates.length) return;
    const [state] = this.sql<Row>`SELECT session_id, cursor, chars FROM kk_kibitzer WHERE chat_id = ${turn.chatId}`;
    let sessionId: string;
    let envelope: string;
    let chars: number;
    if (!state) {
      sessionId = await this.newKibitzerSession();
      const all = this.events(turn.chatId, 0);
      const recent = all.slice(-4);
      envelope = seedEnvelope({ session: turn.chatId, events: recent, history: all.slice(0, -4), candidates, cursorFrom: all[0]?.cursor ?? 0 });
      chars = 0;
    } else if (Number(state.chars) > CONTEXT_BUDGET_CHARS) {
      sessionId = await this.newKibitzerSession();
      const judged = this.sql<Row>`SELECT path, status FROM kk_judged WHERE chat_id = ${turn.chatId}`;
      const pick = (s: string[]) => judged.filter((r) => s.includes(String(r.status))).map((r) => String(r.path));
      const events = this.events(turn.chatId, Number(state.cursor));
      const summary = this.events(turn.chatId, 0).filter((e) => e.kind === "prompt").slice(-6).map((e) => e.body).join(" | ");
      envelope = reseedEnvelope({ session: turn.chatId, events, candidates, cursorFrom: Number(state.cursor) + 1, summary, delivered: pick(["delivered", "pending"]), rejected: pick(["rejected"]), lastCursor: Number(state.cursor) });
      chars = 0;
      log("kibitzer_reseed", { chatId: turn.chatId, previousChars: Number(state.chars) });
    } else {
      sessionId = String(state.session_id);
      envelope = wakeEnvelope({ session: turn.chatId, events: this.events(turn.chatId, Number(state.cursor)), candidates, cursorFrom: Number(state.cursor) + 1 });
      chars = Number(state.chars);
    }

    const kTurn: KibitzerTurn = { ...turn, nudged: 0 };
    this.kibitzerTurns.set(sessionId, kTurn);
    try {
      const result = await this.harness.session(sessionId).prompt(envelope, { operationId: `kibitzer:${messageId}` });
      log("kibitzer_turn", { chatId: turn.chatId, kind: state ? "wake" : "seed", candidates: candidates.map((c) => c.path), nudged: kTurn.nudged, status: result.status });
    } finally {
      this.kibitzerTurns.delete(sessionId);
    }
    const now = Date.now();
    for (const c of candidates) {
      this.sql`INSERT INTO kk_judged (chat_id, path, status, at) VALUES (${turn.chatId}, ${c.path}, 'rejected', ${now}) ON CONFLICT(chat_id, path) DO UPDATE SET at = excluded.at WHERE status = 'rejected'`;
    }
    const [last] = this.sql<Row>`SELECT MAX(cursor) AS c FROM kk_events WHERE chat_id = ${turn.chatId}`;
    this.sql`INSERT OR REPLACE INTO kk_kibitzer (chat_id, session_id, cursor, chars) VALUES (${turn.chatId}, ${sessionId}, ${Number(last?.c ?? 0)}, ${chars + envelope.length})`;
  }

  private takeRecalled(chatId: string): string[] {
    const rows = this.sql<Row>`SELECT path, hint FROM kk_judged WHERE chat_id = ${chatId} AND status = 'pending' ORDER BY at`;
    this.sql`UPDATE kk_judged SET status = 'delivered' WHERE chat_id = ${chatId} AND status = 'pending'`;
    for (const r of rows) log("recall_delivered", { chatId, path: String(r.path) });
    return rows.map((r) => recalledMemory(String(r.path), String(r.hint)));
  }

  private isOwner(senderId: string): boolean {
    return this.env.OWNER_KAKAO_IDS.split(",").map((s) => s.trim()).includes(senderId);
  }

  private send(connection: Connection, frame: AgentFrame): void {
    connection.send(JSON.stringify(frame));
  }

  onConnect(connection: Connection): void {
    this.send(connection, { type: "hello", bootId: this.bootId });
    for (const row of this.sql<Row>`SELECT message_id, chat_id, text FROM kk_outbox ORDER BY created_at`) {
      this.send(connection, { type: "reply", replyTo: String(row.message_id), chatId: String(row.chat_id), text: String(row.text) });
    }
  }

  async onMessage(connection: Connection, raw: WSMessage): Promise<void> {
    if (typeof raw !== "string") return;
    const frame = parseBridgeFrame(raw);
    if (!frame) return;
    switch (frame.type) {
      case "message":
        return this.handleMessage(connection, frame);
      case "delivered":
        this.sql`DELETE FROM kk_outbox WHERE message_id = ${frame.messageId}`;
        return;
      case "restart":
        // Test hook: drop all in-memory state; durable SQLite survives.
        this.ctx.abort("restart requested by bridge");
        return;
      case "import_notes": {
        const saved: string[] = [];
        const errors: { path: string; error: string }[] = [];
        for (const n of frame.notes) {
          const bad = checkPath(n.path) ?? (n.description.trim() ? undefined : "description is required");
          if (bad) {
            errors.push({ path: n.path, error: bad });
            continue;
          }
          this.sql`INSERT OR REPLACE INTO kk_notes (path, description, source, body, updated_at) VALUES (${n.path}, ${n.description}, ${n.source}, ${n.body}, ${Date.now()})`;
          saved.push(n.path);
        }
        log("notes_imported", { saved: saved.length, errors: errors.length });
        return this.send(connection, { type: "imported", saved, errors });
      }
      case "read_notes": {
        const like = `${frame.prefix.replace(/[%_]/g, "")}%`;
        const notes = this.sql<Row>`SELECT path, description, source, body FROM kk_notes WHERE path LIKE ${like} ORDER BY path`.map((r) => ({
          path: String(r.path),
          description: String(r.description),
          source: r.source as Provenance,
          body: String(r.body),
        }));
        return this.send(connection, { type: "notes", notes });
      }
    }
  }

  private sessionFor(msg: InboundMessage): string {
    const [row] = this.sql<Row>`SELECT session_id FROM kk_chats WHERE chat_id = ${msg.chatId}`;
    return row ? String(row.session_id) : "";
  }

  private async handleMessage(connection: Connection, msg: InboundMessage): Promise<void> {
    if (this.sql<Row>`SELECT 1 FROM kk_seen WHERE message_id = ${msg.messageId}`.length) {
      this.send(connection, { type: "ack", messageId: msg.messageId, status: "duplicate" });
      return;
    }
    this.sql`INSERT INTO kk_seen (message_id, at) VALUES (${msg.messageId}, ${Date.now()})`;
    this.sql`INSERT INTO kk_people (sender_id, name) VALUES (${msg.senderId}, ${msg.senderName}) ON CONFLICT(sender_id) DO UPDATE SET name = excluded.name`;

    this.send(connection, { type: "ack", messageId: msg.messageId, status: "accepted" });

    let sessionId = this.sessionFor(msg);
    if (!sessionId) {
      const session = await this.harness.sessions.create({ agent: { extensions: [this.primary] } });
      sessionId = session.id;
      this.sql`INSERT INTO kk_chats (chat_id, session_id, kind, title) VALUES (${msg.chatId}, ${sessionId}, ${msg.chatKind}, ${msg.chatTitle ?? null})`;
    }
    const turn: Turn = { chatId: msg.chatId, senderId: msg.senderId };
    this.sql`INSERT OR REPLACE INTO kk_turn (session_id, chat_id, sender_id) VALUES (${sessionId}, ${msg.chatId}, ${msg.senderId})`;

    const userText = (msg.chatKind === "dm" ? "" : `[${msg.senderName}] `) + msg.text;
    this.appendEvent(msg.chatId, "prompt", userText);
    try {
      await this.wakeKibitzer(turn, msg.messageId);
    } catch (err) {
      log("kibitzer_error", { chatId: msg.chatId, error: String(err) });
    }
    const recalled = this.takeRecalled(msg.chatId);

    const prompt = [...recalled, userText].join("\n\n");
    const result = await this.harness.session(sessionId).prompt(prompt, { operationId: `kakao:${msg.messageId}` });
    const out = result.status === "done" ? result.text?.trim() : undefined;
    const reply = out === NO_REPLY ? undefined : out;
    log("turn", { chatId: msg.chatId, messageId: msg.messageId, status: result.status, reason: result.reason, recalled: recalled.length, silent: out === NO_REPLY });
    if (!reply) return;
    this.appendEvent(msg.chatId, "assistant", reply);

    this.sql`INSERT OR REPLACE INTO kk_outbox (message_id, chat_id, text, created_at) VALUES (${msg.messageId}, ${msg.chatId}, ${reply}, ${Date.now()})`;
    this.send(connection, { type: "reply", replyTo: msg.messageId, chatId: msg.chatId, text: reply });
  }
}

function timingSafeEqual(a: string, b: string): boolean {
  const enc = new TextEncoder();
  const x = enc.encode(a);
  const y = enc.encode(b);
  return x.byteLength === y.byteLength && crypto.subtle.timingSafeEqual(x, y);
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const response = await routeAgentRequest(request, env, {
      onBeforeConnect: (req) => {
        const auth = req.headers.get("Authorization") ?? "";
        if (!timingSafeEqual(auth, `Bearer ${env.BRIDGE_TOKEN}`)) return new Response("unauthorized", { status: 401 });
      },
      onBeforeRequest: () => new Response("not found", { status: 404 }),
    });
    return response ?? new Response("not found", { status: 404 });
  },
} satisfies ExportedHandler<Env>;
