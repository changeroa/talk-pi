/**
 * Which chat gets the next Kakao turn. Owner rule: chats take turns round-robin; a chat that keeps the agent busy
 * for WATCH_MS is left alone for REST_MS. Messages that arrive meanwhile wait and go into one turn when it is
 * that chat's turn again.
 */
export const WATCH_MS = 2 * 60_000;
export const REST_MS = 15 * 60_000;
/** Activity in a chat counts as one stretch while its turns are less than this apart. */
export const STRETCH_GAP_MS = 2 * 60_000;

export class ChatScheduler<T> {
  private readonly pending = new Map<string, T[]>();
  private readonly ring: string[] = [];
  private cursor = 0;
  private readonly stretch = new Map<string, { since: number; last: number }>();
  private readonly restUntil = new Map<string, number>();

  add(chatId: string, item: T): void {
    const queue = this.pending.get(chatId);
    if (queue) queue.push(item);
    else this.pending.set(chatId, [item]);
    if (!this.ring.includes(chatId)) this.ring.push(chatId);
  }

  next(now: number): { chatId: string; items: T[] } | undefined {
    for (let i = 0; i < this.ring.length; i++) {
      const at = (this.cursor + i) % this.ring.length;
      const chatId = this.ring[at];
      const items = this.pending.get(chatId);
      if (!items?.length || (this.restUntil.get(chatId) ?? 0) > now) continue;
      this.pending.delete(chatId);
      this.cursor = (at + 1) % this.ring.length;
      return { chatId, items };
    }
    return undefined;
  }

  turnDone(chatId: string, now: number): void {
    const s = this.stretch.get(chatId);
    const cur = s && now - s.last < STRETCH_GAP_MS ? { since: s.since, last: now } : { since: now, last: now };
    if (now - cur.since >= WATCH_MS) {
      this.restUntil.set(chatId, now + REST_MS);
      this.stretch.delete(chatId);
    } else {
      this.stretch.set(chatId, cur);
    }
  }

  wakeAt(now: number): number | undefined {
    let at: number | undefined;
    for (const [chatId, items] of this.pending) {
      const until = this.restUntil.get(chatId) ?? 0;
      if (items.length && until > now && (at === undefined || until < at)) at = until;
    }
    return at;
  }
}
