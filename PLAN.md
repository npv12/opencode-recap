# Remaining verification

- Run a live multi-step TUI session and request a recap while text is streaming, then confirm a later recap includes the remaining text. The controller regressions use controlled cache updates rather than a live provider.
- Check a live tool-heavy turn: recaps should include parsed tool names/inputs, exclude tool results, and use the latest previous recap without adding anything to session history.
- Test a fresh npm installation through `opencode.jsonc` and a CLI-only installation through `cli.json`. Isolated package/root-entry checks do not cover the host's complete discovery and loading path.
- On the next release, verify GitHub's tagged build and npm trusted publication end to end. Local checks validate the tag/version logic and package contents but do not publish.
