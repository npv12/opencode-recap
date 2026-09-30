# @npv12/opencode-recap

A session recap for the [OpenCode](https://opencode.ai) V2 TUI. A persistent **Recap** panel in the sidebar keeps a one-sentence summary of what your session has been doing — generated on demand or refreshed automatically, without ever touching your transcript.

```
 SIDEBAR
┌──────────────────────────────────┐
│ Current session                  │
│                                  │
│ Recap                            │ ← click to regenerate
│ Refactored auth middleware and   │
│ fixed the token refresh race;    │
│ next step is reviewing the diff. │
│                                  │
│ Context                          │
│ 84.2k tokens · 41% · $0.38       │
├──────────────────────────────────┤
│ ~/work/api:main                  │
└──────────────────────────────────┘
```

## How it works

- **Click the Recap header** (or run **Generate session recap** from `ctrl+p`) to generate immediately.
- Each recap summarizes only what the agent has produced **since the previous recap**, so it describes new work rather than restating the session.
- The latest previous recap is included as context. Tool names and parsed inputs describe requested actions; tool outputs are excluded.
- Recaps refresh automatically when **any** of these happen since the last recap:
  - **10,000 characters** of agent output (reasoning and answers) have accumulated, or
  - **3 minutes** have elapsed with the agent working.
- Recaps fire **mid-turn too**: a long-running agent gets its progress summarized while it works, without waiting for the turn to end.
- Generation is a read-only side request — nothing ever enters your transcript.
- The trigger state resets on every recap, on dismissal, and on restart, so recaps only happen in response to real activity.

By default, recaps use a dedicated model (`openai/gpt-6-luna`) with an explicitly attached transcript. If that model or endpoint is unavailable, recap generation fails rather than using the active session model.

The plugin selects Luna explicitly, so no global `model` setting is required. The sessionless endpoint uses the server's base configuration: the selected provider/model must be available there, and project-only provider customizations do not apply. Luna uses its `none` variant; custom model selections use their model's default variant.

Failures show their reason in the panel while keeping the last displayed recap.

## Requirements

- An [OpenCode V2](https://github.com/anomalyco/opencode/tree/v2) build exposing the `sidebar.content` TUI slot and the sessionless `generate.text` endpoint.
- [Bun](https://bun.sh) (only for building from source).

## Install

Add the package to your `opencode.jsonc`:

```jsonc
{
  "plugins": ["@npv12/opencode-recap"],
}
```

and restart OpenCode.

The server entry is a no-op; OpenCode automatically loads the `./tui` entry. For a CLI-only installation, put the same plugin entry in `~/.config/opencode/cli.json` instead.

> **Note:** OpenCode V2 is under active development. If the plugin fails to render when installed from npm, load it from source instead (see below) — local files are processed by OpenCode's runtime transforms, which is more forgiving of version drift.

### Configuration

Options go in the object form of a plugin entry, in `cli.json` (TUI config) or `opencode.jsonc`:

| Option    | Type     | Default            | Description                                    |
| --------- | -------- | ------------------ | ---------------------------------------------- |
| `providerID` | `string` | `"openai"`       | Provider for side-request recaps               |
| `modelID`    | `string` | `"gpt-6-luna"` | Model for side-request recaps                  |

```jsonc
{
  "plugins": [
    {
      "package": "@npv12/opencode-recap",
      "options": { "providerID": "amazon-bedrock", "modelID": "claude-haiku-4-5" }
    }
  ]
}
```

## Commands

| Command                | Where        | Effect                                    |
| ---------------------- | ------------ | ----------------------------------------- |
| Generate session recap | Palette (`ctrl+p`), clicking the header | Generates a fresh recap |
| Dismiss session recap  | Palette (`ctrl+p`) | Cancels any attempt and clears the text |

## Local development

```sh
git clone https://github.com/npv12/opencode-recap ~/.local/share/opencode/plugins-local/opencode-recap
cd ~/.local/share/opencode/plugins-local/opencode-recap && bun install
```

Point your V2 TUI config (`~/.config/opencode/cli.json`) at the raw source — local files outside `node_modules` are compiled by OpenCode's Solid transform and share its runtime:

```jsonc
{ "plugins": ["/Users/you/.local/share/opencode/plugins-local/opencode-recap/src/tui.tsx"] }
```

The TUI watches this file: edits hot-reload, no restart needed.

## Development

```sh
bun install
bun run check   # typecheck + tests
bun run build   # emit dist/
npm publish     # prepack builds automatically
```

## Releasing

Publishing is automated: pushing a GitHub release publishes the matching version to npm with provenance attestations.

1. Bump `version` in `package.json` and commit.
2. One-time setup on [npmjs.com](https://www.npmjs.com): package settings → **Trusted Publisher** → GitHub Actions → owner `npv12`, repository `opencode-recap`, workflow filename `publish.yml`. Requires npm CLI ≥ 11.5.1 (the workflow runs Node 24 and upgrades npm).
3. Create a GitHub release tagged `v<version>` (e.g. `v0.1.0`). The [`publish.yml`](.github/workflows/publish.yml) workflow checks out that tag, verifies its package version, typechecks, tests, builds, and publishes via OIDC. It does not change the version or push a commit.

For local publishing instead, use `npm publish` as usual; the same provenance settings apply from a supported CI only.

Implementation notes for contributors:

- The entry file is deliberately self-contained; OpenCode's hot-reloader cache-busts only the entrypoint, so relative imports can load stale.
- Trigger state lives in memory and is driven by `session.step.ended`, followed by one 250 ms re-read. The host updates its cache before the step handler; the deferred read may also see the next step's growing parts.
- Counting cursors and durable anchors record a message, part count, and raw per-part character offsets. This keeps later growth eligible even in earlier parts. Legacy anchors without offsets still consume whole parts. The message cache is paginated, not full history.
- Only reasoning and answer characters count toward the 10,000-character trigger. Parsed tool inputs can produce an elapsed-trigger recap, but their size cannot trip the character threshold. Streaming raw JSON inputs wait until parsed.
- Output blocks and tool inputs are capped at 4,000 characters; user messages and compaction summaries at 2,000. The total transcript keeps a 4,000-character head plus a tail within 24,000 characters. Clipped material is retired, so these are content trade-offs, not a guarantee that every action is described.
- There is no failure breaker. Automatic retries need another 10,000 output characters or an elapsed three minutes of activity; manual requests bypass those thresholds. Empty automatic deltas make no model call, while manual requests can fall back to the cached history.
- Manual generation can cause an identical-transcript follow-up if a step counts the same output during that request. Durable anchors are shared across TUI instances, and an older completion can overwrite a newer anchor. Both behaviors are intentionally accepted.
- `bun run test` loads the Solid transform so the tests mount the actual controller and run its lifecycle hooks.

## License

MIT © [Pranav](https://github.com/npv12)
