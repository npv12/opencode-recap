import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { OpenCode } from "@opencode/client";
import { testRender, type JSX } from "@opentui/solid";
import { createStore, produce } from "solid-js/store";
import plugin, { Controller, recapTranscript } from "../src/tui";

type Props = Parameters<typeof Controller>[0];
type Message = Parameters<typeof recapTranscript>[0][number];
type Generate = Props["context"]["client"]["generate"]["text"];

const START = 1_000_000;
let clock = START;
let restoreClock: () => void;
const cleanup: Array<() => void> = [];
const settle = () => new Promise<void>((resolve) => setImmediate(resolve));

beforeEach(() => {
  clock = START;
  const mocked = spyOn(Date, "now").mockImplementation(() => clock);
  restoreClock = () => mocked.mockRestore();
});

afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) close();
  await settle();
  restoreClock();
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

const assistant = (text: string, id = "a", created = clock + 1) => ({
  id,
  type: "assistant",
  time: { created },
  content: [{ type: "reasoning", text }],
});

async function mount(options: {
  cache?: Message[];
  state?: Props["state"];
  handled?: Props["handled"];
  model?: Record<string, unknown>;
  generate?: Generate;
  parentID?: string;
  write?: (mutate: Parameters<Props["updateHandled"]>[0], state: Props["state"], handled: Props["handled"]) => Promise<void>;
} = {}) {
  const cache = options.cache ?? [];
  const state = options.state ?? { sessions: {} };
  const handled = options.handled ?? { sessions: {} };
  const calls: Array<{
    input: Parameters<Generate>[0];
    signal: AbortSignal;
    result: ReturnType<typeof deferred<Awaited<ReturnType<Generate>>>>;
  }> = [];
  let step!: (event: { data: { sessionID: string } }) => void;
  let layer!: Parameters<Props["context"]["keymap"]["layer"]>[0];
  let subscribed = false;
  const context = {
    options: options.model ?? {},
    data: {
      session: {
        get: () => ({ id: "root", parentID: options.parentID, location: { directory: "/review/session" } }),
        message: { list: () => cache },
      },
      on: (type: string, handler: typeof step) => {
        expect(type).toBe("session.step.ended");
        step = handler;
        subscribed = true;
        return () => { subscribed = false; };
      },
    },
    ui: { router: { current: () => ({ type: "session", sessionID: "root" }) } },
    keymap: { layer: (input: typeof layer) => { layer = input; } },
    client: { generate: { text: options.generate ?? ((input, requestOptions) => {
      const signal = requestOptions?.signal;
      if (!signal) throw new Error("Generation must receive a cancellation signal");
      const result = deferred<Awaited<ReturnType<Generate>>>();
      calls.push({ input, signal, result });
      signal.addEventListener("abort", () => result.reject(signal.reason), { once: true });
      return result.promise;
    }) satisfies Generate } },
  } as unknown as Props["context"];
  const setup = await testRender(() => Controller({
    context,
    state,
    handled,
    update: (mutate) => mutate(state),
    updateHandled: (mutate) => {
      if (options.write) return options.write(mutate, state, handled);
      mutate(handled);
      return Promise.resolve();
    },
  }), { width: 20, height: 5 });
  cleanup.push(() => setup.renderer.destroy());
  expect(subscribed).toBe(true);
  return {
    cache,
    state,
    handled,
    calls,
    step: () => step({ data: { sessionID: "root" } }),
    commands: () => layer().commands!,
    command: (id: string) => {
      const command = layer().commands!.find((entry) => entry.id === id)!;
      expect(command.enabled).toBe(true);
      command.run();
    },
    close: () => setup.renderer.destroy(),
    subscribed: () => subscribed,
  };
}

test("pre-mount history never triggers, post-mount work does", async () => {
  const env = await mount({ cache: [assistant("x".repeat(30_000), "old", START - 60_000)] });
  env.step();
  expect(env.calls).toHaveLength(0);
  env.cache.push(assistant("y".repeat(11_000)));
  env.step();
  expect(env.calls).toHaveLength(1);
  env.calls[0]!.result.resolve({ text: "New work covered." });
  await settle();
  expect(env.handled.sessions.root).toEqual({ messageID: "a", part: 1, offsets: [11_000] });
});

test("one message spanning several steps counts every new part", async () => {
  const env = await mount();
  const entry = assistant("a".repeat(4_000));
  env.cache.push(entry);
  env.step();
  entry.content.push({ type: "reasoning", text: "b".repeat(4_000) });
  env.step();
  expect(env.calls).toHaveLength(0);
  entry.content.push({ type: "reasoning", text: "c".repeat(4_000) });
  env.step();
  expect(env.calls).toHaveLength(1);
  expect(env.calls[0]!.input.prompt).toContain("b".repeat(200));
  expect(env.calls[0]!.input.prompt).toContain("c".repeat(200));
});

test("the time clause fires on slow steady work", async () => {
  const env = await mount();
  env.cache.push(assistant("s".repeat(500)));
  env.step();
  expect(env.calls).toHaveLength(0);
  clock += 180_000;
  env.step();
  expect(env.calls).toHaveLength(1);
});

test("growth within an existing part reaches the character threshold", async () => {
  const env = await mount();
  const entry = assistant("x".repeat(5_000));
  env.cache.push(entry);
  env.step();
  entry.content[0]!.text += "y".repeat(6_000);
  env.step();
  expect(env.calls).toHaveLength(1);
});

test("the dedicated default and only the latest previous recap reach later prompts", async () => {
  const env = await mount();
  const entry = assistant("x".repeat(11_000));
  env.cache.push(entry);
  env.step();
  expect(env.calls[0]!.input.model).toEqual({ providerID: "openai", id: "gpt-6-luna", variant: "none" });
  expect(Object.keys(env.calls[0]!.input).sort()).toEqual(["model", "prompt"]);
  env.calls[0]!.result.resolve({ text: "FIRST_RECAP" });
  await settle();
  entry.content.push({ type: "reasoning", text: "y".repeat(11_000) });
  env.step();
  expect(env.calls[1]!.input.prompt).toContain("<<<PREVIOUS>>>\nFIRST_RECAP\n<<<END PREVIOUS>>>");
  expect(env.calls[1]!.input.prompt).not.toContain("Thinking: " + "x".repeat(100));
  env.calls[1]!.result.resolve({ text: "LATEST_RECAP" });
  await settle();
  entry.content.push({ type: "reasoning", text: "z".repeat(11_000) });
  env.step();
  expect(env.calls[2]!.input.prompt).toContain("<<<PREVIOUS>>>\nLATEST_RECAP\n<<<END PREVIOUS>>>");
  expect(env.calls[2]!.input.prompt).not.toContain("FIRST_RECAP");
});

test("custom provider/model selections do not inherit the Luna variant", async () => {
  const env = await mount({ model: { providerID: " amazon-bedrock ", modelID: " claude-haiku-4-5 " } });
  env.cache.push(assistant("Work to summarize."));
  env.command("session.recap");
  expect(env.calls[0]!.input.model).toEqual({ providerID: "amazon-bedrock", id: "claude-haiku-4-5" });
});

test("output gained during an in-flight request gets a delta-only follow-up", async () => {
  const env = await mount();
  const entry = assistant("x".repeat(11_000));
  env.cache.push(entry);
  env.step();
  entry.content.push({ type: "reasoning", text: "y".repeat(11_000) });
  env.step();
  expect(env.calls).toHaveLength(1);
  env.calls[0]!.result.resolve({ text: "First window." });
  await settle();
  expect(env.calls).toHaveLength(2);
  expect(env.calls[1]!.input.prompt).toContain("Thinking: " + "y".repeat(100));
  expect(env.calls[1]!.input.prompt).not.toContain("Thinking: " + "x".repeat(100));
});

test("manual generation does not retire later growth in several open parts", async () => {
  const env = await mount();
  const entry = assistant("Initial reasoning.");
  entry.content.push({ type: "text", text: "Initial answer." });
  env.cache.push(entry);
  env.command("session.recap");
  env.calls[0]!.result.resolve({ text: "Initial observations." });
  await settle();
  entry.content[0]!.text += " LATE_REASONING_RESULT";
  entry.content[1]!.text += " LATE_ANSWER_RESULT";
  clock += 180_001;
  env.step();
  expect(env.calls).toHaveLength(2);
  expect(env.calls[1]!.input.prompt).toContain("LATE_REASONING_RESULT");
  expect(env.calls[1]!.input.prompt).toContain("LATE_ANSWER_RESULT");
  expect(env.calls[1]!.input.prompt).not.toContain("Initial reasoning.");
  expect(env.calls[1]!.input.prompt).not.toContain("Initial answer.");
});

test("a deferred read cannot retire the next step's still-streaming text", async () => {
  const env = await mount();
  const entry = assistant("x".repeat(500));
  env.cache.push(entry);
  env.step();
  clock += 179_900;
  entry.content.push({ type: "reasoning", text: "y".repeat(500) });
  env.step();
  entry.content.push({ type: "text", text: "Partial next step." });
  clock += 250;
  await Bun.sleep(300);
  expect(env.calls).toHaveLength(1);
  env.calls[0]!.result.resolve({ text: "Partial progress." });
  await settle();
  entry.content[2]!.text += " LATE_VERIFIED_RESULT";
  env.step();
  clock += 180_001;
  entry.content.push({ type: "text", text: "Subsequent work." });
  env.step();
  expect(env.calls).toHaveLength(2);
  expect(env.calls[1]!.input.prompt).toContain("LATE_VERIFIED_RESULT");
  expect(env.calls[1]!.input.prompt).not.toContain("Partial next step.");
});

test("tool inputs are included without outputs and do not trip the character threshold", async () => {
  const env = await mount();
  const part = {
    type: "tool",
    name: "write",
    state: {
      status: "completed",
      input: { path: "src/index.ts", content: "x".repeat(20_000) },
      content: [{ type: "text", text: "EXCLUDED_RESULT" }],
      metadata: { note: "EXCLUDED_METADATA" },
      error: "EXCLUDED_ERROR",
    },
  };
  env.cache.push({ id: "a", type: "assistant", time: { created: clock + 1 }, content: [part] });
  env.step();
  expect(env.calls).toHaveLength(0);
  clock += 180_001;
  env.step();
  expect(env.calls).toHaveLength(1);
  expect(env.calls[0]!.input.prompt).toContain('Tool input: write: {"path":"src/index.ts"');
  expect(env.calls[0]!.input.prompt).not.toContain("EXCLUDED_");
});

test("a tool input becomes eligible after parsing rather than being skipped by its old anchor", async () => {
  const env = await mount();
  const entry: Message = {
    id: "a", type: "assistant", time: { created: clock + 1 },
    content: [
      { type: "text", text: "Inspecting the entry." },
      { type: "tool", name: "read", state: { status: "streaming", input: '{"path":' } },
    ],
  };
  env.cache.push(entry);
  env.command("session.recap");
  expect(env.calls[0]!.input.prompt).not.toContain("Tool input:");
  env.calls[0]!.result.resolve({ text: "Inspection started." });
  await settle();
  entry.content![1]!.state = { status: "running", input: { path: "src/index.ts" } };
  clock += 180_001;
  env.step();
  expect(env.calls[1]!.input.prompt).toContain('Tool input: read: {"path":"src/index.ts"}');
});

test.each([{ messageID: "a" }, { messageID: "a", part: 1 }])(
  "legacy durable entries retain their consumed-part semantics: %j",
  async (entry) => {
    const env = await mount({ handled: { sessions: { root: entry } } });
    env.cache.push(assistant("Previously handled."));
    env.cache.push(assistant("x".repeat(11_000), "b"));
    env.step();
    expect(env.calls[0]!.input.prompt).not.toContain("Previously handled.");
    expect(env.calls[0]!.input.prompt).toContain("Thinking: " + "x".repeat(100));
  },
);

test("manual recap after dismissal still has a stale-window fallback", async () => {
  const env = await mount();
  env.cache.push(assistant("x".repeat(11_000)));
  env.step();
  env.calls[0]!.result.resolve({ text: "Covered work." });
  await settle();
  const anchor = structuredClone(env.handled.sessions.root);
  env.command("session.recap.dismiss");
  expect(env.state.sessions.root).toBeUndefined();
  expect(env.handled.sessions.root).toEqual(anchor);
  env.command("session.recap");
  expect(env.calls).toHaveLength(2);
  expect(env.calls[1]!.input.prompt).toContain("Thinking: " + "x".repeat(100));
});

test("an elapsed check with no new delta does not request another automatic recap", async () => {
  const env = await mount();
  env.cache.push(assistant("x".repeat(11_000)));
  env.step();
  env.calls[0]!.result.resolve({ text: "Covered work." });
  await settle();
  clock += 180_001;
  env.step();
  await settle();
  expect(env.calls).toHaveLength(1);
  expect(env.state.sessions.root).toEqual({ text: "Covered work.", loading: false, error: undefined });
});

test("generation failure preserves the displayed recap and exposes the reason", async () => {
  const env = await mount();
  env.cache.push(assistant("Work to summarize."));
  env.command("session.recap");
  env.calls[0]!.result.resolve({ text: "Previous recap." });
  await settle();
  const anchor = structuredClone(env.handled.sessions.root);
  env.command("session.recap");
  env.calls[1]!.result.reject(new Error("provider model unavailable"));
  await settle();
  expect(env.state.sessions.root).toEqual({ text: "Previous recap.", loading: false, error: "provider model unavailable" });
  expect(env.handled.sessions.root).toEqual(anchor);
  env.command("session.recap");
  expect(env.state.sessions.root?.error).toBeUndefined();
});

test.each([
  { status: 400, tag: "InvalidRequestError" },
  { status: 401, tag: "UnauthorizedError" },
  { status: 503, tag: "ServiceUnavailableError" },
])("serialized SDK failures preserve their message: %j", async ({ status, tag }) => {
  const client = OpenCode.make({
    baseUrl: "https://recap.test",
    fetch: Object.assign(async () => new Response(JSON.stringify({ _tag: tag, message: "provider model unavailable" }), {
      status,
      headers: { "content-type": "application/json" },
    }), { preconnect: globalThis.fetch.preconnect }),
  });
  const env = await mount({
    generate: client.generate.text,
    state: { sessions: { root: { text: "Previous recap." } } },
    handled: { sessions: { root: { messageID: "older", part: 1 } } },
  });
  env.cache.push(assistant("Work to summarize."));
  env.command("session.recap");
  await settle();
  expect(env.state.sessions.root).toEqual({ text: "Previous recap.", loading: false, error: "provider model unavailable" });
  expect(env.handled.sessions.root).toEqual({ messageID: "older", part: 1 });
});

test("storage failure keeps the newly displayed text and reports the write error", async () => {
  const env = await mount({
    write: async (_mutate, state) => {
      expect(state.sessions.root?.text).toBe("Visible before persistence.");
      expect(state.sessions.root?.loading).toBe(false);
      throw new Error("Anchor write failed");
    },
  });
  env.cache.push(assistant("Work to summarize."));
  env.command("session.recap");
  env.calls[0]!.result.resolve({ text: "Visible before persistence." });
  await settle();
  expect(env.state.sessions.root).toEqual({ text: "Visible before persistence.", loading: false, error: "Anchor write failed" });
  expect(env.handled.sessions.root).toBeUndefined();
});

test("a superseded storage completion cannot settle or abort the newer request", async () => {
  const write = deferred<void>();
  const env = await mount({ write: async (mutate, _state, handled) => {
    await write.promise;
    mutate(handled);
  } });
  env.cache.push(assistant("First work."));
  env.command("session.recap");
  env.calls[0]!.result.resolve({ text: "First recap." });
  await settle();
  env.command("session.recap");
  write.resolve();
  await settle();
  expect(env.calls).toHaveLength(2);
  expect(env.calls[1]!.signal.aborted).toBe(false);
  expect(env.state.sessions.root?.loading).toBe(true);
  env.calls[1]!.result.resolve({ text: "Second recap." });
  await settle();
  expect(env.state.sessions.root?.text).toBe("Second recap.");
});

test("dismissal aborts pending generation without exposing a cancellation error", async () => {
  const env = await mount();
  env.cache.push(assistant("Work to summarize."));
  env.command("session.recap");
  env.command("session.recap.dismiss");
  await settle();
  expect(env.calls[0]!.signal.aborted).toBe(true);
  expect(env.state.sessions.root).toBeUndefined();
  expect(env.handled.sessions.root).toBeUndefined();
});

test("unmount unsubscribes, aborts generation, and clears deferred reads", async () => {
  const env = await mount();
  env.cache.push(assistant("x".repeat(11_000)));
  env.step();
  env.close();
  expect(env.subscribed()).toBe(false);
  expect(env.calls[0]!.signal.aborted).toBe(true);
  env.cache.push(assistant("y".repeat(11_000), "b"));
  await Bun.sleep(300);
  expect(env.calls).toHaveLength(1);
});

test("child sessions neither auto-generate nor enable manual recap", async () => {
  const env = await mount({ parentID: "parent" });
  env.cache.push(assistant("x".repeat(11_000)));
  env.step();
  expect(env.calls).toHaveLength(0);
  expect(env.commands().find((command) => command.id === "session.recap")?.enabled).toBe(false);
});

test("empty model responses report a useful error rather than moving the anchor", async () => {
  const env = await mount();
  env.cache.push(assistant("Work to summarize."));
  env.command("session.recap");
  env.calls[0]!.result.resolve({ text: " \n\t " });
  await settle();
  expect(env.state.sessions.root?.error).toBe("The recap model returned no text.");
  expect(env.state.sessions.root?.loading).toBe(false);
  expect(env.handled.sessions.root).toBeUndefined();
  env.command("session.recap.dismiss");
  expect(env.state.sessions.root).toBeUndefined();
});

test("recap text normalizes whitespace and respects its output cap", async () => {
  const env = await mount();
  env.cache.push(assistant("Work to summarize."));
  env.command("session.recap");
  env.calls[0]!.result.resolve({ text: "  inspected\n the\t API  " + "x".repeat(500) });
  await settle();
  expect(env.state.sessions.root?.text?.startsWith("inspected the API ")).toBe(true);
  expect(env.state.sessions.root?.text?.length).toBe(480);
  expect(env.state.sessions.root?.text?.endsWith("...")).toBe(true);
});

test("accepted behavior: a manual recap can cause an identical-transcript follow-up", async () => {
  const env = await mount();
  env.cache.push(assistant("x".repeat(11_000)));
  env.command("session.recap");
  env.step();
  env.calls[0]!.result.resolve({ text: "Manual recap." });
  await settle();
  expect(env.calls).toHaveLength(2);
  const transcript = (prompt: string) => prompt.slice(prompt.indexOf("Output since then"));
  expect(transcript(env.calls[1]!.input.prompt)).toBe(transcript(env.calls[0]!.input.prompt));
});

test("accepted behavior: the older completion can overwrite a newer shared anchor", async () => {
  const cache: Message[] = [];
  const handled: Props["handled"] = { sessions: {} };
  const first = await mount({ cache, handled });
  const second = await mount({ cache, handled });
  const entry = assistant("x".repeat(11_000));
  cache.push(entry);
  first.step();
  entry.content.push({ type: "text", text: "y".repeat(11_000) });
  second.step();
  second.calls[0]!.result.resolve({ text: "Both parts covered." });
  await settle();
  expect(handled.sessions.root?.part).toBe(2);
  first.calls[0]!.result.resolve({ text: "First part covered." });
  await settle();
  expect(handled.sessions.root).toEqual({ messageID: "a", part: 1, offsets: [11_000] });
  clock += 180_001;
  second.step();
  expect(second.calls).toHaveLength(2);
  expect(second.calls[1]!.input.prompt).toContain("Assistant: " + "y".repeat(100));
});

test("the sidebar renders failure reasons alongside the last recap", async () => {
  const [state, setState] = createStore<Props["state"]>({ sessions: {} });
  let sidebar!: (props: { sessionID: string }) => JSX.Element;
  const context = {
    storage: {
      memory: () => [state, (mutate: Parameters<Props["update"]>[0]) => setState(produce(mutate))],
      store: () => [{ sessions: {} }, async () => {}],
    },
    theme: { text: { base: "#ffffff", muted: "#999999" } },
    ui: { slot: (slot: { append: string; render: typeof sidebar }) => {
      if (slot.append === "sidebar.content") sidebar = slot.render;
      return () => {};
    } },
  } as unknown as Props["context"];
  const dispose = plugin.setup(context);
  const setup = await testRender(() => sidebar({ sessionID: "root" }), { width: 80, height: 8 });
  cleanup.push(() => { dispose(); setup.renderer.destroy(); });
  setState(produce((draft) => {
    draft.sessions.root = { text: "Previously displayed recap.", error: "Provider unavailable", loading: false };
  }));
  await setup.renderOnce();
  const frame = setup.captureCharFrame();
  expect(frame).toContain("Previously displayed recap.");
  expect(frame).toContain("Recap failed: Provider unavailable");
});
