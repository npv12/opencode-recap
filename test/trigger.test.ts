import { expect, test } from "bun:test";
// Import from the entry on purpose: trigger logic lives inline there so the
// TUI hot-reloader can never serve a stale copy of a separate module.
import { autoRecapDue, outputChars, recapTranscript } from "../src/tui";

type Part = { type: string; text: string };
type Msg = { id: string; type: string; time: { created: number }; content: Part[] };
type Cache = Msg[];

const START = 1_000_000;

const message = (id: string, created: number): Msg => ({ id, type: "assistant", time: { created }, content: [] });

/**
 * Replays the controller's counting loop: each step the cache is re-read whole,
 * the cursor counts forward from where it parked, then moves to the newest
 * message. This is the only place the interaction between the cursor, the
 * trigger and the transcript window is exercised together, and it is where a
 * message spanning several steps has to be modelled as one growing object
 * rather than as separate messages.
 */
class Run {
  chars = 0;
  anchorAtMs: number;
  cursor?: { id: string; part: number };
  cursorAtMs?: number;
  anchor?: { id: string; part: number };
  fired: Array<{ chars: number; text?: string; through?: { id: string; part: number } }> = [];
  readonly cache: Cache = [];

  constructor(startedAtMs: number, first: Msg) {
    this.cache.push(first);
    this.anchorAtMs = first.time.created;
    // The baseline is the oldest post-mount message, as advance() places it.
    const post = this.cache.find((entry) => entry.time.created > startedAtMs);
    const newest = first;
    this.cursor = post ? { id: post.id, part: 0 } : { id: newest.id, part: newest.content.length };
    this.cursorAtMs = (post ?? newest).time.created;
  }

  add(entry: Msg) {
    this.cache.push(entry);
  }

  get last() {
    const entry = this.fired[this.fired.length - 1];
    if (!entry) throw new Error("no recap fired");
    return entry;
  }

  step(atMs = this.cache[this.cache.length - 1]?.time.created ?? this.anchorAtMs) {
    const newest = this.cache[this.cache.length - 1];
    if (!newest) return;
    this.chars += outputChars(this.cache as never, this.cursor, this.cursorAtMs);
    this.cursor = { id: newest.id, part: newest.content.length };
    this.cursorAtMs = newest.time.created;
    if (!autoRecapDue({ chars: this.chars, anchorAtMs: this.anchorAtMs }, atMs)) return;
    const result = recapTranscript(this.cache as never, this.anchor);
    this.fired.push({ chars: this.chars, text: result.text, through: result.through });
    this.anchor = result.through;
    this.chars = 0;
    this.anchorAtMs = atMs;
  }
}

test("pre-mount history never triggers, post-mount work does", () => {
  const old = message("m1", START - 60_000);
  old.content.push({ type: "reasoning", text: "x".repeat(30_000) });
  const before = new Run(START, old);
  before.step();
  expect(before.fired).toHaveLength(0);

  const fresh = message("n1", START + 1_000);
  fresh.content.push({ type: "reasoning", text: "x".repeat(30_000) });
  const after = new Run(START, fresh);
  after.step();
  expect(after.fired).toHaveLength(1);
  expect(after.last.chars).toBe(30_000);
});

test("one message spanning several steps is counted across all of them", () => {
  // A message-level cursor would only ever see the first part, so a hard turn
  // made of tool calls would contribute one step's worth of characters.
  const entry = message("s1", START + 1_000);
  const run = new Run(START, entry);
  entry.content.push({ type: "reasoning", text: "a".repeat(4_000) });
  run.step();
  entry.content.push({ type: "reasoning", text: "b".repeat(4_000) });
  run.step();
  expect(run.fired).toHaveLength(0);
  entry.content.push({ type: "reasoning", text: "c".repeat(4_000) });
  run.step();
  expect(run.fired).toHaveLength(1);
  expect(run.last.chars).toBe(12_000);
  // The window carries the parts the earlier steps appended, not just the last.
  expect(run.last.text).toContain("b".repeat(200));
  expect(run.last.text).toContain("c".repeat(200));
  expect(run.last.through).toEqual({ id: "s1", part: 3 });
});

test("a later recap covers only what came after the earlier one", () => {
  const first = message("m1", START + 1_000);
  const run = new Run(START, first);
  first.content.push({ type: "reasoning", text: "p".repeat(11_000) });
  run.step();
  const second = message("m2", START + 200_000);
  second.content.push({ type: "reasoning", text: "q".repeat(11_000) });
  run.add(second);
  run.step(START + 200_000);
  expect(run.fired).toHaveLength(2);
  expect(run.fired[0]?.text).toContain("p");
  expect(run.fired[0]?.text).not.toContain("q");
  expect(run.fired[1]?.text).toContain("q");
  expect(run.fired[1]?.text).not.toContain("p");
});

test("the time clause fires on slow steady work that never reaches the char threshold", () => {
  const entry = message("m1", START + 1_000);
  const run = new Run(START, entry);
  entry.content.push({ type: "reasoning", text: "s".repeat(500) });
  run.step();
  expect(run.fired).toHaveLength(0);
  run.step(START + 200_000);
  expect(run.fired).toHaveLength(1);
  expect(run.last.chars).toBe(500);
});
