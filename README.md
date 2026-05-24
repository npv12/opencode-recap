# @npv12/opencode-recap

OpenCode TUI sidebar plugin that generates a short Markdown session recap on demand.

## Features

- Auto-generates a recap every 5 messages
- Recap is discarded after 5 more messages (10-message cycle)
- Click **Recap** in the sidebar to manually trigger generation
- Stays in the sidebar (does not pollute the chat thread)
- Uses the most recent 10 messages as recap context
- Creates a short-lived throwaway session for generation

## Installation

```bash
opencode plugin add @npv12/opencode-recap
```

Or add to your `opencode.json`:

```json
{
  "plugins": {
    "@npv12/opencode-recap": {}
  }
}
```

## Model Selection

By default, recap uses `opencode/deepseek-v4-flash-free`.

You can override it by setting both `providerID` and `modelID`:

```json
{
  "plugins": {
    "@npv12/opencode-recap": {
      "providerID": "github-copilot",
      "modelID": "gemini-3-flash-preview"
    }
  }
}
```

## Attribution

This plugin is adapted from [streetturtle's recap plugin](https://github.com/streetturtle/opencode-better-sidebar/blob/main/plugins/recap/README.md) in the [opencode-better-sidebar](https://github.com/streetturtle/opencode-better-sidebar) repository.

## License

MIT
