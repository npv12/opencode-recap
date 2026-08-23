import { expect, test } from "bun:test";
// Import from the entry on purpose: trigger logic lives inline there so the
// TUI hot-reloader can never serve a stale copy of a separate module.
import { AUTO_RECAP_ASSISTANT_TURNS, AUTO_RECAP_INTERVAL_MS, AUTO_RECAP_USER_MESSAGES, autoRecapDue } from "../src/tui";

const START = 1_000_000;

function state(
  overrides: Partial<{ active: boolean; userCount: number; turns: number; anchorAtMs: number }> = {},
) {
  return { active: true, userCount: 1, turns: 0, anchorAtMs: START + 2 * 60_000, ...overrides };
}

test("never due without any activity since the last cycle", () => {
  expect(autoRecapDue(state({ active: false }), START + 60 * 60_000)).toBe(false);
  expect(autoRecapDue(state({ active: false, userCount: 5, turns: 40 }), START + 60 * 60_000)).toBe(false);
});

test("due at the three-minute mark of the interval when activity happened", () => {
  expect(autoRecapDue(state(), START + 4 * 60_999)).toBe(false);
  expect(autoRecapDue(state(), START + 5 * 60_000)).toBe(true);
});

test("assistant-only activity counts toward the interval", () => {
  // Agent steps with no newer user message still satisfy "activity happened".
  expect(autoRecapDue(state({ userCount: 0, turns: 12 }), START + 5 * 60_000)).toBe(true);
});

test("three new user messages trigger an immediate recap", () => {
  const early = START + 2 * 60_000 + 1_000;
  expect(autoRecapDue(state({ userCount: AUTO_RECAP_USER_MESSAGES - 1 }), early)).toBe(false);
  expect(autoRecapDue(state({ userCount: AUTO_RECAP_USER_MESSAGES }), early)).toBe(true);
});

test("twenty assistant turns trigger an immediate recap", () => {
  const early = START + 2 * 60_000 + 1_000;
  expect(autoRecapDue(state({ turns: AUTO_RECAP_ASSISTANT_TURNS - 1 }), early)).toBe(false);
  expect(autoRecapDue(state({ turns: AUTO_RECAP_ASSISTANT_TURNS }), early)).toBe(true);
});

test("threshold constants match the documented contract", () => {
  expect(AUTO_RECAP_INTERVAL_MS).toBe(180_000);
  expect(AUTO_RECAP_USER_MESSAGES).toBe(3);
  expect(AUTO_RECAP_ASSISTANT_TURNS).toBe(20);
});
