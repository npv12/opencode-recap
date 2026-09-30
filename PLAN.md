# Delta recaps

Supersedes the reasoning-threshold plan this file previously held. Recaps become an
append-only stream: each generation summarizes only what the agent produced since the
last one, so nothing is thrown away and the trigger bounds the input instead of a
history slice bounding it.

Goal: the panel reflects in-progress work, so during a turn you can see what the agent is
doing rather than waiting for the turn to end and reading the last settled answer.

## Trigger

Two conditions, OR'd, both evaluated only at a step boundary (`session.step.ended`, one
model invocation, so mid-turn recaps work):

| Condition | Value | Meaning |
| --- | --- | --- |
| agent output chars since the last recap | >= 10,000 | the agent worked hard |
| elapsed since the last recap | >= 3 min | the agent worked steadily |

`charsOf` sums `text.length` over `reasoning` and `text` parts. Tool parts and your
messages are not counted, so you cannot trip the trigger by typing.

## Why these numbers

Measured on `opencode.db`, `session_message` rows, 1,285 sessions. Simulating the real
trigger over that history (10,000 chars OR 3 min, message by message) gives 10,867
cycles, 8.5 per session.

Per-message agent output, 64,250 messages: p50 399, p75 1,217, p90 3,415, p99 17,122,
max 294,475. So 10,000 is roughly 7 messages at the mean and 25 at the median.

Which clause fires, 9,909 attributable cycles:

| fired on | share |
| --- | --- |
| chars only | 47.1% |
| elapsed only | 49.1% |
| both at once | 3.8% |

The two split almost evenly, which is the intent: the char clause is what makes a hard
turn recap early instead of waiting out the interval, and the interval is what recaps a
slow steady turn that never reaches 10,000 chars. Seconds between recaps: p50 181,
p75 210, p90 422.

10,000 is the one number worth tuning. 6,000 fires more often, 20,000 less.

## Positions are part-level, in both the cursor and the anchor

This is the load-bearing mechanic and the easiest thing to get wrong.

One assistant message spans several steps: the model asks for tools, they run, the model
is called again, and it appends more `reasoning` and `text` parts to the *same* message.
`session.step.ended` carries `assistantMessageID` but no step id. So any position that
remembers only a message id is wrong the same way twice: a trigger cursor keyed on a
message id skips every part later steps appended to that message, and an anchor keyed on
a message id excludes them from the next recap. In both cases the work is described by
neither.

Every position is therefore a part position:

```ts
type Position = { id: string; part: number };
```

`RuntimeState.cursor` is one. The persisted anchor is one, so `HandledEntry` becomes
`{ messageID: string; part?: number }`. The field is optional rather than the store being
re-keyed: a v4 entry has no `part` and means "that whole message was consumed", which is
exactly what it meant, so read a missing `part` as `Number.MAX_SAFE_INTEGER`. Re-keying
to v5 would start every existing user from an empty store and run that rule against
nothing.

`outputChars(messages, cursor, cursorAtMs)` sums `reasoning` and `text` part lengths
from the position to the end of the array, resolving the boundary as:

1. the message whose id is `position.id`, starting at part `position.part`, or
2. failing that, the first message created after `atMs`, counting all of its parts, or
3. failing that, nothing.

Rule 2 is the eviction fallback. `message.list()` is a paginated cache, so a position's
message can stop being present. Messages older than it are not in the cache either, so
starting at the oldest surviving message newer than `atMs` loses nothing still readable.
The uncounted remainder of the evicted message is genuinely gone; that is unavoidable
with a paginated cache, and bounded by one message.

The cursor always advances to the newest message in the cache with all of its parts
marked counted, never to the message named by the event. That makes it structurally
monotonic, so a redelivered `session.step.ended` (it is a durable event) cannot walk it
backwards and cause intervening output to be counted twice.

## Baselines use mount time, not event ids

A session's first step must not count pre-mount history, and must not skip a step that
arrived while the cache was still catching up.

The boundary is the oldest message in the cache created after the controller was
constructed. `startedAtMs` is captured once at construction, and on a session's first
sighting the cursor goes to part 0 of that oldest post-mount message. If no message
qualifies, the cursor goes to the end of the newest one, so pre-mount history is never
counted and the next message to arrive is counted from its start.

This is why `startedAtMs` stays. Keying the baseline off event ids instead looks
equivalent and is not: if step A ends before its message is cached and step B ends after
both are cached, the first sighting initialises against B and A's output, which precedes
B, is never counted. Comparing creation time against mount has no such ordering to get
wrong.

Losing a step from the count delays the trigger; it does not lose content, because the
recap window is anchored on the last successful recap rather than on the cursor.

Mounting mid-turn is the one case this cannot cover. The in-flight message was created
before mount, so it does not qualify as post-mount and the cursor starts at its end, and
the parts already appended to it are not counted. Correcting it would need per-part
timestamps, which the cache does not carry. Accepted, and bounded by one message: it costs
trigger latency, not content, for the same reason as above.

## Content

The window is every part after the persisted anchor. Output parts keep their array order
and are labelled apart:

```
User: repair every remaining reviewer finding
Thinking: checking whether the refresh path can double-fire
Assistant: the race is in the token refresh, patching it now
Thinking: verifying the guard holds under concurrency
```

Your messages are inside the window but outside the trigger count. That split is the
point: the request that started the work is in the transcript whenever the window starts
with one, and your typing never trips the trigger.

`recapTranscript` falls back to the tail of the cache when there is no anchor, or when
the anchor leaves an empty window. The second case matters because the anchor is durable
while the recap text is not, so after a restart or a dismissal a manual recap would
otherwise find an empty delta and produce nothing. Today a manual recap always summarizes
the tail and always produces something; the fallback preserves that.

The previous recap is fed into the prompt so the new one covers only what is new. It
lives in the existing `recaps-v2` memory store, so no new state.

## Sizing the content caps

A single reasoning part reaches 294,475 chars, so without a per-part cap one block
becomes the whole transcript. That is how the current tail slice ends up reporting on
deliberation while dropping your actual request.

Per-part lengths over 106,301 `reasoning` and `text` parts (p50 118, p75 563, p90 2,028,
p99 12,139), 93.67m chars total. A 4,000-char cap on those parts leaves 94.9% of blocks
completely untouched and retains 68.0% of all characters. The 32% it drops is concentrated
in the blocks over 4,000, which is the intended trade: the cap guards against one
pathological block, it is not a budget mechanism, so it sits well above p90.

Your messages need a cap too: 4,795 of them, p50 94, p90 1,407, p99 6,132, max 67,026.
A pasted file is not recap material. Compaction summaries are 111, p50 4,118, max
13,059. Both are capped at 2,000.

With parts capped at 4,000 and user and summary text at 2,000, the delta actually sent
per recap, over 10,867 cycles in which every cycle succeeded:

| p50 | p75 | p90 | p95 | p99 | max |
| --- | --- | --- | --- | --- | --- |
| 5,791 | 9,830 | 11,425 | 12,385 | 14,009 | 19,302 |

`TRANSCRIPT_MAX_CHARS` goes from 16,000 to 24,000.

## Why the slice keeps a head

A tail slice drops the head of the delta, and the head is where a request sits when the
window begins with one. In the simulation above 24,000 never fires, but that simulation
assumed every cycle succeeded. A failed attempt does not advance the anchor, so the next
successful recap covers everything since the last success, which is several trigger
cycles.

Measured per bucket of 10,000 uncapped chars (6,240 buckets), capped content is p50
10,372, p90 12,747, max 19,623. So after two consecutive failures the median delta is
about 20,700 and after three it is about 31,100, and a 24,000 tail slice bites at two or
three failures, which is when a recap matters most.

So the slice keeps both ends: the first `TRANSCRIPT_HEAD_CHARS` and the remainder up to
`maxChars`, joined by a `...` marker, with the tail budget computed as
`maxChars - TRANSCRIPT_HEAD_CHARS - 3` so the marker fits inside the cap.

What this does and does not buy, stated precisely. It preserves the start of the window,
so a recap that follows a user message keeps that request. It does not guarantee the
originating request survives: a window that starts mid-turn, because the anchor was
written partway through one, has no request at its head, and when the cap fires the
omitted middle is retired by `through` without being described. That loss is real, it is
bounded by three consecutive failures, and it is accepted rather than paid for with more
machinery. Bounding the delta is the trigger's job; this only makes the backstop keep the
window's opening instead of amputating it.

## The line cap goes

`TRANSCRIPT_MAX_MESSAGES = 40` caps lines, not messages, and under a delta window it is a
second bound on something already bounded by characters. Measured: 2.5% of cycles exceed
40 lines (p50 7, p75 13, p90 21, p99 55, max 141), and the slice discards a median of 11
and at most 101 real lines when it fires. It buys nothing and silently drops content the
char cap would have kept. Deleted, along with its parameter.

## Why not `tokens.reasoning`

`session.step.ended` carries `data.tokens.reasoning`, which would remove the cache read
entirely. Rejected on measurement: across 4,000 messages with more than 200 reasoning
tokens, chars-per-token is mean 3.02 but ranges 0.18 to 5.26, and only 73.5% land in a
2 to 6 band. Some messages report thousands of reasoning tokens with almost no reasoning
text in the cache. Too noisy to threshold on.

(An earlier revision rejected the same field for the opposite reason, citing 1.08 chars
per token. That figure was wrong. The conclusion survives, the reasoning does not.)

## Why the count still reads the cache

The event payload cannot replace it. The event names a message, not a step, and that
message accumulates parts across steps, so a message-level count is either wrong
(multiplied by step count) or incomplete (misses later parts). The mapping is not
recoverable from the message either: messages average 1.1 reasoning parts at one tool
call and 1.9 at four or more, which is nowhere near one reasoning part per step.

## Lifecycle, which is where this is easy to get wrong

**The persisted anchor is the last part the transcript actually covered.** `complete`
currently records `latestMessageID()` after the await. Under a delta window that is wrong
twice over: parts appended to that message after the snapshot, and output from a step
that ended while the request was in flight, are skipped by the next delta and never
described. So `recapTranscript` returns the position it reached, from the same array
snapshot it built its text from, and that is what gets written. The transcript is built
synchronously before the first await, so the position in the snapshot is exactly what was
summarized.

**The panel is committed before the anchor is written, and supersession is checked across
the write.** `updateHandled` returns a promise and the current code discards it, so
`complete` awaits it, and a request can be superseded during that await by a manual
generate or by `dismiss`, both of which abort the in-flight request. So `complete`
checks the existing `superseded()` helper before touching state, and again after the
await: return early on the first check, and after the await `settle()` and re-check the
trigger. The first check skips a request already overtaken by the time its model call
returns. The second is not about the panel, since the commit already happened before the
await: it stops a superseded completion from reaching the trigger re-check, which would
call `generate` and in doing so abort whichever request now holds the slot.

The order of the commit and the write is what keeps content from being lost. The text is
set on the panel first, then the anchor is written. The anchor is a durable side effect
that retires its window, so it must only ever be written for a recap that was actually
shown; writing first and bailing on supersession afterwards would advance the anchor past
a window whose recap was never displayed, and because the next window starts after that
anchor, the omitted content could never be recapped. Committing first means a supersession
during the write costs at most one repeated delta, which is transient and self-correcting,
rather than a permanently retired window.

The residual cost of committing first is that the palette command re-enables before the
anchor lands, and the header click dispatches `session.recap` directly regardless of the
command's `enabled` flag, so a click inside that one-storage-write window regenerates the
same delta. Accepted rather than guarded.

`fail` awaits nothing, so it must still `settle()` before re-checking.

**Counters are zeroed when generation starts, not when they settle.** `generate` calls
`resetCycle` at the top, so every entry point (both clauses, the palette command, the
header click) re-arms identically. The `resetCycle` call currently in `complete` is
removed, because it would discard work done during the request.

**A threshold crossed during an in-flight request is not stranded.** The trigger is only
evaluated on a step boundary, so a count that crosses 10,000 while a request is in flight
would otherwise sit there with no step left to notice. After a request settles the
trigger is re-checked once and may fire again. Self-limiting: each `generate` zeroes the
count, so each extra attempt needs another 10,000 chars. The cost is that a hard burst
can produce two recaps seconds apart, and since the panel shows one recap the first is
replaced by the second. The panel already behaves that way, and the alternative is leaving
work undescribed.

**Every step arms one deferred re-read, because the cache lags the event in two ways.** The
event's message may not be cached yet, and a message that is already cached may not yet
have the parts this step appended. Checking only for the message's presence misses the
second case, and a step whose parts arrive after the event, with no further step to pick
them up, would never trigger. So every `session.step.ended` schedules one per-session
250ms timer that re-runs the same accumulation. Accumulation is idempotent because the
cursor only moves forward, so a redundant re-read costs one extra cache read and nothing
else, and there is no loop: the timer fires once and is not re-armed by the read. This is
the only timer left. `onCleanup` clears it.

**Dismissal must not advance the persisted anchor.** `dismiss` clears the text and resets
the cycle, but writing the anchor there would retire everything between the last recap
and the dismissal without describing any of it.

## Failure

No fallback, no breaker, no cooldown, no failure counter. On failure the previous text
stays on screen, the spinner clears, and the next 10,000 chars try again.

The honest bound on retry rate, which is weaker than "a threshold crossing is its own
rate limit": an automatic attempt needs 10,000 chars only when the char clause is what
fired. The 3-minute clause allows one attempt per 3 minutes of activity regardless of
volume, and the palette command and header click bypass thresholds, so a user clicking
the header can issue requests back to back. Concurrency is still bounded to one in-flight
request per session, because `generate` aborts any previous request before starting a new
one. No breaker is added, per the decision to keep this simple; a dead endpoint costs one
failed call per 3 minutes of active work, and it is also what makes the next successful
window span several trigger cycles, which is why the slice keeps a head.

## Changes

All in `src/tui.tsx`.

1. Constants: `AUTO_RECAP_CHARS = 10_000` replaces `AUTO_RECAP_USER_MESSAGES` and
   `AUTO_RECAP_ASSISTANT_TURNS`. `AUTO_RECAP_INTERVAL_MS` stays at 3 min.
   `TRANSCRIPT_MAX_CHARS` goes 16,000 to 24,000. New `BLOCK_CHARS = 4_000`,
   `USER_CHARS = 2_000`, `TRANSCRIPT_HEAD_CHARS = 4_000`.
   `TRANSCRIPT_MAX_MESSAGES` and its parameter are deleted.

2. `Position` is `{ id: string; part: number }`, shared by the trigger cursor and the
   persisted anchor. `RuntimeState` becomes `chars`, `anchorAtMs`, `cursor?`,
   `cursorAtMs?`. `HandledEntry` becomes `{ messageID: string; part?: number }`; the store
   key stays `recap-handled-v4` and a missing `part` reads as `Number.MAX_SAFE_INTEGER`.
   The `active` flag goes: both clauses are only reachable from a step boundary, so both
   are already gated on work having happened. `seeded` and `lastUserID` go with the
   deleted seeding block. `startedAtMs` stays and gains a second use, as the baseline.

3. `autoRecapDue` takes `Pick<RuntimeState, "chars" | "anchorAtMs">` and returns the
   two-clause check. Still exported, still pure, still unit tested.

4. `CachedMessage`, `partsOf(message)`, and `chronology(context, sessionID)` move to
   module scope as the single sorted accessor and the single part counter, replacing the
   closure copy and the two inline sorts. The controller calls `chronology`;
   `recapTranscript` and `outputChars` take already-sorted arrays.

5. `charsOf(message)` sums `reasoning` and `text` part lengths, uncapped: it is the
   trigger unit and must measure real output volume, not the capped transcript.

6. `outputChars(messages, cursor?, cursorAtMs?)` sums from the resolved boundary to the
   end of the array, by the three-step rule above. Exported for tests.

7. `recapTranscript(messages, after?: Position, maxChars = TRANSCRIPT_MAX_CHARS)` returns
   `{ text?: string; through?: Position }`, where `through` is the position it reached,
   from the same array it built its text from. The window starts at the anchor message's
   part `after.part`, or at the following message when that part is at or past the end.
   `reasoning` and `text` parts are capped at `BLOCK_CHARS` with a trailing `...`; `tool`
   parts contribute nothing; `user` text and compaction summaries are capped at
   `USER_CHARS` and keep their current labels. Falls back to the tail of `messages` when
   there is no anchor or the window is empty. Over `maxChars`, keeps the first
   `TRANSCRIPT_HEAD_CHARS` and the last `maxChars - TRANSCRIPT_HEAD_CHARS - 3`, joined by
   `...`.

8. `generate` takes one snapshot and passes it down, so the text and the anchor come from
   the same array:

   ```ts
   const messages = chronology(props.context, sessionID);
   const after = anchorOf(props.handled.sessions[sessionID]);
   const previous = props.state.sessions[sessionID]?.text;
   ```

   `generateWithRecapModel` takes `{ messages, after, previous }` instead of reaching for
   the cache itself, and returns `recapTranscript`'s `{ text, through }` normalized.
   `RECAP_PROMPT` gains "Report only what is new; do not repeat what the previous recap
   already covered" and its first line becomes "...since the previous recap". The prompt
   gains a `<<<PREVIOUS>>>` block defaulting to `none`.

9. `generate` calls `resetCycle` at the top, right after the `parentID` bail.
   `resetCycle` zeroes `chars` and re-anchors `anchorAtMs`.

10. `complete` becomes async and runs strictly in this order: return if `superseded()`,
    `setRecap({ text, loading: false })`, `await updateHandled(through)`, return if
    `superseded()`, `settle()`, then re-check the trigger once and call `generate` if
    still due. The panel is committed before the anchor is written so the anchor is never
    written for a recap that was not shown. Its `resetCycle` call is deleted. `fail` runs
    `setRecap({ loading: false })`, `settle()`, then the same re-check. Neither touches an
    `attempts` map; `AUTO_RETRY_COOLDOWN_MS` and `AUTO_MAX_CONSECUTIVE_FAILURES` are
    deleted.

11. `advance(sessionID)` holds the whole accumulation, so the event handler and the
    deferred re-read share it. It snapshots the cache and returns early if empty. If the
    cursor is unset it places it at part 0 of the oldest message created after
    `startedAtMs`, or at the end of the newest message when none qualifies. It then
    unconditionally adds `outputChars`, advances the cursor to the newest message at
    `partsOf(newest)`, sets `cursorAtMs` to that message's `time.created` and nothing else,
    returns early if a request is in flight, and calls `generate` when `autoRecapDue`.

12. The `session.step.ended` handler: bail on child sessions, call `advance(sessionID)`,
    then `armRetry(sessionID)` unconditionally. `armRetry` holds one timer per session,
    replacing any pending one, and fires `advance(sessionID)` once after 250ms. The
    `session.inbox.enqueued` subscription and the 10s `setInterval` poll are deleted.
    `onCleanup` clears the retry timers along with the in-flight requests; the hot-reload
    spinner cleanup stays.

13. Deleted: `evaluate`, `newUserInput`, `invalidateRecap`, the seeding and reconcile
    block, the `active`/`userCount`/`turns`/`seeded`/`lastUserID` fields, the home-screen
    and tabs gate, the `props.state.sessions[sessionID]?.loading` guard in `evaluate`
    (the `requests` map already covers it), `latestUserID` (already dead), and the anchor
    write in `dismiss`.

14. `test/eligibility.test.ts`: rewrite the trigger tests against the two-clause
    `autoRecapDue` and the new constants. `outputChars` coverage: ignores tool parts and
    user messages; returns 0 for an undefined cursor; resumes mid-message from a part
    cursor, so parts appended by a later step of the same message are counted; falls back
    to the `cursorAtMs` boundary when the cursor's message is absent, counting that
    message's parts rather than starting after them; returns 0 when neither resolves; does
    not double count across two calls with an advancing cursor.
    `recapTranscript` coverage: the window starts at the anchor's part, not after the
    anchor message; a v4-style anchor with no `part` starts at the next message; user
    messages are present; a 5,000-char part truncates at 4,000; a 67,000-char user message
    truncates at 2,000; an over-cap result keeps its first 4,000 characters and its last
    `maxChars - 4_003`; an anchor with nothing after it falls back to the tail; `through`
    matches the position reached; an empty array gives `{ text: undefined }`. Keep the
    existing part-order test.

15. `README.md`: the trigger list becomes "10,000 characters of agent output" and
    "3 minutes"; drop the user-message and assistant-turn bullets. The contributor note
    forbidding counts from `message.list()` is replaced with the actual constraint: the
    list is a paginated cache, so the count is a forward-only sum from a part cursor with
    a time fallback, never a re-derivation of totals, and every step is followed by one
    deferred re-read because the cache can lag the event on parts as well as on messages.
    The failure-backoff note is deleted. The note that recaps need "at least one new
    message exchanged" no longer applies, since the 3-minute clause is only reached from a
    step boundary.

## Verification

- `bun x tsc --noEmit` and `bun test`. Run them directly, not `bun run check`: the
  `check` script shells out to `bun` through a mise shim with no version pinned, which
  errors. `bun` itself is at `~/.local/share/mise/installs/bun/1.3.5/bin`.
- Live: hot reload the TUI, run a multi-step task, confirm a recap lands before 3 minutes
  during the hard stretch and that the second recap describes new work rather than
  restating the first.
- Live: run a turn that calls tools repeatedly, so one message spans several steps, and
  confirm the recap mentions work from the later steps and not just the first. This is
  the case the part-level position exists for.
- Live: send a message, dismiss the recap, then click the header with no new work.
  Confirm it still produces something. This is the fallback path and the easiest one to
  regress.
- Live: confirm nothing enters the transcript. It is a side request and should stay one.

## Accepted trade-offs

- **Tool calls are not in the transcript and not counted.** The recap can say what the
  agent worked out and what it said, not what it touched. A turn that reads fifty files
  and changes nothing produces a recap about deliberation. This was a deliberate decision
  to keep the logic simple, and it is the main thing the recap cannot tell you.
- **A recap in flight when you send a new message is not aborted.** Dropping the
  `session.inbox.enqueued` subscription is what makes the trigger one event. The stale recap
  is replaced only by a step that crosses a threshold, or by a manual click. A step that
  stays under both thresholds replaces nothing, so if you go idle after one the stale recap
  stays indefinitely. A periodic re-check would bound that, and is the poll this design
  removes.
- **Every session with a running step is now evaluated, not just the active one and open
  tabs.** Deleting the home-screen and tabs gate is what removes the last piece of
  per-session bookkeeping, and it means background parent sessions also get recaps, so
  more side requests than today. Restricting it would mean reintroducing a session filter
  and the state to track which sessions are visible.
- **The transcript fence is not nonce'd.** A message containing `<<<END TRANSCRIPT>>>`
  passes through verbatim. The window holds only your own messages and your agent's own
  output, so this is not a trust boundary, and the prompt already marks the block as data.
- **The char counter is runtime-only.** A restart resets it, so the first recap after a
  restart waits for 10,000 fresh chars or 3 minutes. The anchor is durable, so no content
  is lost, only delayed.
- **The eviction fallback is approximate.** When a position's message leaves the cache, its
  uncounted remaining parts are gone. Bounded by one message, and unavoidable with a
  paginated cache.
- **The deferred re-read is one fixed 250ms delay.** A cache slower than that leaves the
  step to be counted by the next one. A retry loop would be more correct and is exactly
  the poll this design is removing.
- **The omitted middle of an over-cap window is lost.** It needs three consecutive
  failures to reach, and the head-keeping slice is what keeps the common single-cycle case
  whole.

## Deferred

- Tool calls in the transcript, and per-tool summarisation. This is the one that would most
  improve the recap, and the one most likely to reintroduce the budget problem.
- `AUTO_RECAP_CHARS` is a code constant, so tuning it needs a rebuild. Worth promoting to
  a plugin option only after it has been watched in real use.
- Claude Code's native recap caps output at 400 chars and triggers on terminal unfocus.
  `RECAP_MAX_CHARS` is 480 here, and opencode exposes no focus signal.
