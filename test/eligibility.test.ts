import { expect, test } from "bun:test";
// Import from the entry on purpose: trigger logic lives inline there so the
// TUI hot-reloader can never serve a stale copy of a separate module.
import { AUTO_RECAP_CHARS, AUTO_RECAP_INTERVAL_MS, autoRecapDue, outputChars, recapTranscript } from "../src/tui";

type Message = Parameters<typeof recapTranscript>[0][number];

const START = 1_000_000;

const assistant = (id: string, parts: NonNullable<Message["content"]>, created = 0) => ({
  id,
  type: "assistant",
  time: { created },
  content: parts,
});

const user = (id: string, text: string, created = 0) => ({ id, type: "user", time: { created }, text });

function state(overrides: Partial<{ chars: number; anchorAtMs: number }> = {}) {
  return { chars: 0, anchorAtMs: START + 2 * 60_000, ...overrides };
}

test("never due below both thresholds", () => {
  expect(autoRecapDue(state(), START + 4 * 60_999)).toBe(false);
  expect(autoRecapDue(state({ chars: AUTO_RECAP_CHARS - 1 }), START + 2 * 60_001)).toBe(false);
});

test("due at the three-minute mark", () => {
  expect(autoRecapDue(state(), START + 5 * 60_000)).toBe(true);
});

test("hard work fires well before the interval", () => {
  const early = START + 2 * 60_000 + 1_000;
  expect(autoRecapDue(state({ chars: AUTO_RECAP_CHARS - 1 }), early)).toBe(false);
  expect(autoRecapDue(state({ chars: AUTO_RECAP_CHARS }), early)).toBe(true);
});

test("threshold constants match the documented contract", () => {
  expect(AUTO_RECAP_INTERVAL_MS).toBe(180_000);
  expect(AUTO_RECAP_CHARS).toBe(10_000);
});

test("counting skips tool parts and user messages", () => {
  const messages = [
    assistant("msg_1", [{ type: "reasoning", text: "12345" }]),
    assistant("msg_2", [{ type: "tool", text: "1234567890" }]),
    user("msg_3", "123456789012345"),
    assistant("msg_4", [{ type: "text", text: "1234" }]),
  ];
  expect(outputChars(messages, { id: "msg_1", part: 1 })).toBe(4);
});

test("counting returns zero without a cursor", () => {
  expect(outputChars([assistant("msg_1", [{ type: "text", text: "1234" }])])).toBe(0);
});

test("a part cursor resumes mid-message, so later steps of one message count", () => {
  // One assistant message spans several steps, each appending parts. A cursor
  // parked at part 1 must pick up parts 1 and 2 without touching part 0 again.
  const message = assistant("msg_1", [
    { type: "reasoning", text: "aaaa" },
    { type: "tool", text: "tttt" },
    { type: "reasoning", text: "bb" },
  ]);
  expect(outputChars([message], { id: "msg_1", part: 1 })).toBe(2);
  expect(outputChars([message], { id: "msg_1", part: 3 })).toBe(0);
});

test("an exhausted part cursor counts only later messages", () => {
  const messages = [assistant("msg_1", [{ type: "text", text: "aaaa" }]), assistant("msg_2", [{ type: "text", text: "bb" }])];
  expect(outputChars(messages, { id: "msg_1", part: 1 })).toBe(2);
});

test("an evicted cursor falls back to its creation time, counting the survivor", () => {
  const messages = [assistant("msg_9", [{ type: "text", text: "bb" }], 5_000)];
  // The cursor's own message is gone. The message at t=5000 is newer than the
  // cursor (t=1000) and must be counted, not skipped as the boundary.
  expect(outputChars(messages, { id: "gone", part: 0 }, 1_000)).toBe(2);
  // A message older than the cursor was summarized and must not be recounted.
  expect(outputChars([assistant("msg_8", [{ type: "text", text: "zz" }], 500)], { id: "gone", part: 0 }, 1_000)).toBe(0);
});

test("no cursor and no timestamp counts nothing", () => {
  expect(outputChars([assistant("msg_1", [{ type: "text", text: "aaaa" }])], { id: "gone", part: 0 })).toBe(0);
});

test("an advancing cursor never double counts", () => {
  const first = [assistant("msg_1", [{ type: "text", text: "aaaa" }], 1)];
  const second = [...first, assistant("msg_2", [{ type: "text", text: "bbbb" }], 2)];
  const cursor = { id: "msg_1", part: 1 };
  expect(outputChars(first, cursor)).toBe(0);
  expect(outputChars(second, cursor)).toBe(4);
  expect(outputChars(second, { id: "msg_2", part: 1 })).toBe(0);
});

test("the window starts at the anchor's part, not after the anchor message", () => {
  const message = assistant("msg_1", [
    { type: "text", text: "already summarized" },
    { type: "reasoning", text: "still new" },
  ]);
  expect(recapTranscript([message], { id: "msg_1", part: 1 })).toEqual({
    text: "Thinking: still new",
    through: { id: "msg_1", part: 2, offsets: ["already summarized".length, "still new".length] },
  });
});

test("a pre-part-level anchor consumes its whole message", () => {
  const messages = [assistant("msg_1", [{ type: "text", text: "old" }]), assistant("msg_2", [{ type: "text", text: "new" }])];
  const { text, through } = recapTranscript(messages, { id: "msg_1", part: Number.MAX_SAFE_INTEGER });
  expect(text).toBe("Assistant: new");
  expect(through).toEqual({ id: "msg_2", part: 1, offsets: [3] });
});

test("reasoning is kept in part order, labelled apart from answers", () => {
  expect(
    recapTranscript([
      assistant("msg_1", [
        { type: "reasoning", text: "locating the parser" },
        { type: "text", text: "reading the file" },
        { type: "reasoning", text: "patching the branch" },
      ]),
    ]).text,
  ).toBe("Thinking: locating the parser\n\nAssistant: reading the file\n\nThinking: patching the branch");
});

test("tool parts without stable inputs and blank parts contribute nothing", () => {
  expect(recapTranscript([assistant("msg_1", [{ type: "tool", text: "bash ls" }])])).toEqual({});
  expect(recapTranscript([assistant("msg_1", [{ type: "text", text: "  " }])])).toEqual({});
  expect(recapTranscript([])).toEqual({});
});

test("user messages are inside the window", () => {
  const { text } = recapTranscript([user("msg_1", "fix the race"), assistant("msg_2", [{ type: "text", text: "patched" }])]);
  expect(text).toBe("User: fix the race\n\nAssistant: patched");
});

test("an over-long part is capped and an over-long user message too", () => {
  const big = "x".repeat(5_000);
  const { text } = recapTranscript([assistant("msg_1", [{ type: "reasoning", text: big }]), user("msg_2", "y".repeat(67_000))]);
  expect(text?.startsWith("Thinking: " + "x".repeat(3_997) + "...")).toBe(true);
  expect(text?.includes("x".repeat(3_998))).toBe(false);
  expect(text?.includes("y".repeat(1_998))).toBe(false);
  expect(text?.includes("y".repeat(1_997) + "...")).toBe(true);
});

test("an over-cap transcript keeps its head and its tail", () => {
  const messages: Message[] = [];
  for (let i = 0; i < 40; i++) {
    messages.push(assistant(`msg_${i}`, [{ type: "text", text: `${i}`.repeat(2_000) }]));
  }
  const { text } = recapTranscript(messages, undefined, 24_000);
  expect(text?.length).toBeLessThanOrEqual(24_000);
  // The window's opening survives, and so does its most recent end.
  expect(text?.startsWith("Assistant: 0")).toBe(true);
  expect(text?.endsWith("39".repeat(2_000).slice(-50))).toBe(true);
  expect(text).toContain("...");
});

test("the manual path falls back to the whole cache, the automatic path does not", () => {
  const messages = [assistant("msg_1", [{ type: "text", text: "older work" }])];
  const atEnd = { id: "msg_1", part: 1 };
  // A person asked for a recap now, so it answers with the session as a whole.
  expect(recapTranscript(messages, atEnd, undefined, true).text).toBe("Assistant: older work");
  // An empty delta automatically means there is nothing new. Re-sending the
  // session would repeat the previous recap verbatim, which is what the whole
  // delta window exists to prevent.
  expect(recapTranscript(messages, atEnd)).toEqual({});
});

test("an automatic window never re-reports content the anchor consumed", () => {
  const messages = [
    assistant("msg_1", [{ type: "reasoning", text: "consumed reasoning" }]),
    assistant("msg_2", [{ type: "reasoning", text: "tool only, no output" }]),
  ];
  const { text } = recapTranscript(messages, { id: "msg_1", part: 1 });
  expect(text).toBe("Thinking: tool only, no output");
  expect(text).not.toContain("consumed reasoning");
});

test("through matches the position reached", () => {
  const messages = [user("msg_1", "go"), assistant("msg_2", [{ type: "text", text: "a" }, { type: "text", text: "b" }])];
  expect(recapTranscript(messages).through).toEqual({ id: "msg_2", part: 2, offsets: [1, 1] });
  // A message with no contributable part never becomes the position reached.
  expect(recapTranscript([assistant("msg_1", [{ type: "tool", text: "bash" }]), user("msg_2", "hi")]).through).toEqual({
    id: "msg_2",
    part: 0,
    offsets: [],
  });
});

test("counting picks up growth in every snapshotted part", () => {
  const message = assistant("msg_1", [
    { type: "reasoning", text: "abcghi" },
    { type: "text", text: "defjkl" },
    { type: "text", text: "mn" },
  ]);
  expect(outputChars([message], { id: "msg_1", part: 2, offsets: [3, 3] })).toBe(8);
  expect(outputChars([message], { id: "msg_1", part: 3, offsets: [6, 6, 2] })).toBe(0);
});

test("a transcript resumes within several growing parts without repeating their prefixes", () => {
  const message = assistant("msg_1", [
    { type: "reasoning", text: "abc" },
    { type: "text", text: "def" },
  ]);
  const first = recapTranscript([message]);
  message.content[0]!.text += "ghi";
  message.content[1]!.text += "jkl";
  expect(first.through).toEqual({ id: "msg_1", part: 2, offsets: [3, 3] });
  expect(recapTranscript([message], first.through)).toEqual({
    text: "Thinking: ghi\n\nAssistant: jkl",
    through: { id: "msg_1", part: 2, offsets: [6, 6] },
  });
});

test("tool inputs are included once, but output, errors, and metadata are excluded", () => {
  const part = {
    type: "tool",
    name: "read",
    state: {
      status: "completed",
      input: { path: "src/index.ts", limit: 20 },
      content: [{ type: "text", text: "EXCLUDED_TOOL_OUTPUT" }],
      metadata: { note: "EXCLUDED_TOOL_METADATA" },
      error: "EXCLUDED_TOOL_ERROR",
    },
  };
  const message = assistant("msg_1", [part]);
  const result = recapTranscript([message]);
  expect(result.text).toBe('Tool input: read: {"path":"src/index.ts","limit":20}');
  expect(result.text).not.toContain("EXCLUDED_TOOL");
  expect(recapTranscript([message], result.through)).toEqual({});
  expect(outputChars([message], { id: "msg_1", part: 0 })).toBe(0);
});

test("streaming tool input is deferred until its parsed object is available", () => {
  const message = assistant("msg_1", [
    { type: "text", text: "Reading the entry." },
    { type: "tool", name: "read", state: { status: "streaming", input: '{"path":' } },
  ]);
  const first = recapTranscript([message]);
  expect(first.text).toBe("Assistant: Reading the entry.");
  expect(first.through?.offsets).toEqual(["Reading the entry.".length, 0]);
  message.content[1]!.state = { status: "running", input: { path: "src/index.ts" } };
  const next = recapTranscript([message], first.through);
  expect(next.text).toBe('Tool input: read: {"path":"src/index.ts"}');
  expect(recapTranscript([message], next.through)).toEqual({});
});

test("positions record raw lengths rather than clipped transcript lengths", () => {
  const message = assistant("msg_1", [{ type: "reasoning", text: "x".repeat(5_000) }]);
  const first = recapTranscript([message]);
  expect(first.through?.offsets).toEqual([5_000]);
  message.content[0]!.text += "New result.";
  expect(recapTranscript([message], first.through).text).toBe("Thinking: New result.");
});

test("tool inputs use the same per-block cap", () => {
  const message = assistant("msg_1", [{
    type: "tool",
    name: "write",
    state: { status: "running", input: { content: "x".repeat(10_000) } },
  }]);
  const result = recapTranscript([message]);
  expect(result.text?.length).toBe("Tool input: ".length + 4_000);
  expect(result.text?.endsWith("...")).toBe(true);
  expect(result.through?.offsets?.[0]).toBeGreaterThan(10_000);
});

test.each([0, 1, 2, 3, 4, 99, 100, 4_000, 4_001, 4_003, 4_004, 24_000])(
  "transcript respects a %i-character maximum",
  (maxChars) => {
    const messages = Array.from({ length: 10 }, (_, i) => assistant(`msg_${i}`, [{ type: "text", text: "x".repeat(5_000) }]));
    const result = recapTranscript(messages, undefined, maxChars);
    expect(result.text!.length).toBeLessThanOrEqual(maxChars);
    expect(result.through).toEqual({ id: "msg_9", part: 1, offsets: [5_000] });
  },
);
