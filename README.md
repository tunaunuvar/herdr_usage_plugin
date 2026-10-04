# AI Usage Limits for Herdr

A small, collapsible terminal popup for account quota windows, with a discovery list for common AI CLIs. It runs on Windows, macOS, and Linux and has no third-party package dependencies.

## What it shows

- Codex account rate limits from Codex's local `app-server` RPC.
- Quota windows returned by authenticated providers in Oh My Pi (OMP). OMP account identifiers are requested in redacted form.
- Installed AI CLI names discovered on the `PATH` inherited by the Herdr server.

The discovery list currently checks for Codex, OMP, Claude Code, Gemini CLI, Amp, OpenCode, Cursor Agent, GitHub Copilot CLI, Aider, Hermes, Pi, Goose, Crush, Kiro CLI, Qwen Code, Kimi CLI, LLM CLI, and Ollama. A detected tool without an adapter is identified as such; the plugin does not invent quota data. AI CLIs have no shared quota interface, and each provider decides what it exposes.

Claude Code's interactive `/usage`, Gemini CLI's `/stats model`, and Amp's `amp usage` are shown as manual hints when those tools are detected. The plugin does not run those commands.

## Install

Requires Herdr 0.9.0+ and Node.js on the Herdr server's `PATH`. Install from GitHub:

```sh
herdr plugin install tunaunuvar/herdr_usage_plugin
herdr plugin action invoke open --plugin tunaunuvar.herdr-usage-limits
```

Codex and/or OMP must also be installed and signed in to show live quota bars. The discovery list is scanned when the popup starts; close and reopen it after installing another CLI.

Optional shortcut (`prefix` then `u`, Ctrl+B then `u` by default), add to Herdr's `config.toml`:

```toml
[[keys.command]]
key = "prefix+u"
type = "plugin_action"
command = "tunaunuvar.herdr-usage-limits.open"
description = "Open AI usage limits"
```

Then run `herdr server reload-config`.

## Use

Press `c` or `o` to collapse/expand Codex or OMP, `d` to collapse/expand detected tools, `a` to toggle all sections, `r` to refresh, and `q` or `Esc` to close. Use Up/Down or Page Up/Page Down to scroll, and Home/End to jump to either end.

Shortcuts stay the same regardless of the active AI tool. The footer only lists quota-card shortcuts for detected adapters; `d`, `a`, `r`, and `q`/`Esc` are always available. The popup-opening shortcut belongs to each user's Herdr configuration, so installing a different AI CLI does not change it. Detected tools without a quota adapter appear in the discovery list rather than receiving a quota-card shortcut.

The panel uses responsive, bordered quota cards with color-coded usage bars and remaining percentages. Seven-day windows are marked `WEEKLY`; reset rows show local date/time and a countdown. The discovery list starts collapsed. The panel adapts when its terminal is resized and keeps keyboard controls visible. It redraws only on data refresh, keyboard input or resize, with the same 60-second refresh interval and no animation loop.

## Privacy and limits

The plugin checks executable names on `PATH` and queries only the Codex and OMP interfaces described above. It does not scan credential/config files, call provider websites, or send telemetry. CLI discovery is limited to the command list in `usage.js` and to the PATH available to the Herdr server.

## Local development

```sh
herdr plugin link .
herdr plugin pane open --plugin tunaunuvar.herdr-usage-limits --entrypoint usage
node --check usage.js
node --test usage.test.js
```

To uninstall the GitHub-managed copy, run `herdr plugin uninstall tunaunuvar.herdr-usage-limits`.
