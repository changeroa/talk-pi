import { describe, expect, test } from "bun:test";
import { ChatScheduler, REST_MS, WATCH_MS } from "../src/schedule";

describe("ChatScheduler", () => {
  test("chats with waiting messages take turns round-robin, each turn taking all of that chat's messages", () => {
    const s = new ChatScheduler<string>();
    s.add("a", "a1");
    s.add("a", "a2");
    s.add("b", "b1");
    expect(s.next(0)).toEqual({ chatId: "a", items: ["a1", "a2"] });
    s.add("a", "a3");
    expect(s.next(0)).toEqual({ chatId: "b", items: ["b1"] });
    expect(s.next(0)).toEqual({ chatId: "a", items: ["a3"] });
    expect(s.next(0)).toBeUndefined();
  });

  test("a chat busy for WATCH_MS rests for REST_MS while others go on, then its waiting messages come as one turn", () => {
    const s = new ChatScheduler<string>();
    s.turnDone("a", 0);
    s.turnDone("a", 60_000);
    s.turnDone("a", WATCH_MS);
    s.add("a", "late1");
    s.add("a", "late2");
    s.add("b", "b1");
    expect(s.next(WATCH_MS + 1)).toEqual({ chatId: "b", items: ["b1"] });
    expect(s.next(WATCH_MS + 1)).toBeUndefined();
    expect(s.wakeAt(WATCH_MS + 1)).toBe(WATCH_MS + REST_MS);
    expect(s.next(WATCH_MS + REST_MS)).toEqual({ chatId: "a", items: ["late1", "late2"] });
  });

  test("a quiet gap ends the stretch, so occasional turns never send a chat to rest", () => {
    const s = new ChatScheduler<string>();
    for (let t = 0; t <= 10 * WATCH_MS; t += WATCH_MS + 1) s.turnDone("a", t);
    s.add("a", "x");
    expect(s.next(10 * WATCH_MS + 20)).toEqual({ chatId: "a", items: ["x"] });
  });
});
