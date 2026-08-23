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
- Recaps refresh automatically when **any** of these happen since the last recap:
  - **3 minutes** elapse (counted from the last recap, or from startup) with at least one new message exchanged,
  - **3 new user messages** arrive, or
  - **20 assistant turns** complete.
- Recaps fire **mid-turn too**: a long-running agent gets its progress summarized while it works, without waiting for the turn to end.
- Generation is a read-only side request — nothing ever enters your transcript.
- The trigger state resets on every recap, on dismissal, and on restart, so recaps only happen in response to real activity.

By default, recaps use a dedicated model (`opencode-go/mimo-v2.5`) with an explicitly attached transcript. If that model or endpoint is unavailable, generation falls back to OpenCode's built-in session-scoped endpoint using your current model.

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

> **Note:** OpenCode V2 is under active development. If the plugin fails to render when installed from npm, load it from source instead (see below) — local files are processed by OpenCode's runtime transforms, which is more forgiving of version drift.

### Configuration

Options go in the object form of a plugin entry, in `cli.json` (TUI config) or `opencode.jsonc`:

| Option    | Type     | Default            | Description                                    |
| --------- | -------- | ------------------ | ---------------------------------------------- |
| `providerID` | `string` | `"opencode-go"` | Provider for side-request recaps               |
| `modelID`    | `string` | `"mimo-v2.5"`   | Model for side-request recaps                  |

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
3. Create a GitHub release tagged `v<version>` (e.g. `v0.1.0`). The [`publish.yml`](.github/workflows/publish.yml) workflow verifies the tag matches the package version, typechecks, tests, builds, and publishes via OIDC — no token secrets involved.

For local publishing instead, use `npm publish` as usual; the same provenance settings apply from a supported CI only.

Implementation notes for contributors:

- The entry file is deliberately self-contained; OpenCode's hot-reloader cache-busts only the entrypoint, so relative imports can load stale.
- Auto-trigger state lives in memory and is driven entirely by events (`session.inbox.enqueued`, `session.step.ended`). Never derive counts from `message.list()` — it's a paginated cache, not full history.
- Failures back off exponentially-ish: 2-minute cooldown per failed attempt, auto disabled after 3 consecutive failures until the next message.

## License

MIT © [Pranav](https://github.com/npv12)
