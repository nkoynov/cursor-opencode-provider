# Changelog

## [Unreleased]

### Fixed

- Host notes that follow a step's tool results (nested `AGENTS.md` instructions, background completions, other `<system-update>` notes) no longer turn an OpenCode 2 read into its numbered raw text or get lost on errors, searches and writes: they are added after the result is parsed, to the last result with a text field other than a read's file content, or else the Run's next result, or the next user message when the turn ends first ([#49](https://github.com/oakimov/cursor-opencode-provider/pull/49) by [@nkoynov](https://github.com/nkoynov))
- A message sent while a step's tools run no longer cancels the held Run's pending results and makes the model redo them: when the Run waits on exactly that step's results, the message is injected into that Run the way Cursor CLI steers, then the results are delivered, and a message Cursor does not take is sent as a follow-up when the turn ends ([#50](https://github.com/oakimov/cursor-opencode-provider/pull/50) by [@nkoynov](https://github.com/nkoynov))
- A tool that runs for more than 10 minutes without OpenCode activity (a long foreground shell, a slow MCP call) no longer closes the held Run and restarts the turn without its earlier tool results: the Run is held while OpenCode reports one of its tools running, up to 4 hours, and each pending exec gets Cursor CLI's exec heartbeat ([#52](https://github.com/oakimov/cursor-opencode-provider/pull/52) by [@nkoynov](https://github.com/nkoynov))
- When Cursor withdraws an exec (`ExecServerControlMessage.abort`), the provider stops holding the Run for it and drops its late result without writing anything back, as Cursor CLI does, instead of ignoring the abort. Frames Cursor sends while the host still runs a step's tools (KV writes, exec aborts) are now answered as they arrive ([#58](https://github.com/oakimov/cursor-opencode-provider/pull/58) by [@nkoynov](https://github.com/nkoynov))
- Stopping a turn in OpenCode 2 now stops the Cursor Run. OpenCode 2 never aborts the model stream on Stop, so the Run used to keep generating, or stay held waiting for a tool result that never came, until the next message, which then restarted the stopped step on it. The plugin now hears OpenCode's interrupt and cancels the session's open Runs the way Cursor CLI's Stop does (`cancel_action`, then the stream is closed if Cursor has not ended the Run within 3 seconds) ([#58](https://github.com/oakimov/cursor-opencode-provider/pull/58) by [@nkoynov](https://github.com/nkoynov))

## [0.8.0] - 2026-10-04

### Changed

- Host system context is delivered as a single always-apply rule; the provider no longer rediscovers local `AGENTS.md`, skills, or agent files for Cursor `RequestContext` ([#37](https://github.com/oakimov/cursor-opencode-provider/pull/37))
- RequestContext tool overlay is names-only; full tool definitions are answered from the live host catalog on exec #36 ([#37](https://github.com/oakimov/cursor-opencode-provider/pull/37))

### Fixed

- Cursor browser-login and API-key credentials renew the same way Cursor's own clients do, so long sessions stop failing after token expiry ([#35](https://github.com/oakimov/cursor-opencode-provider/issues/35))
- Cursor conversations stay consistent across OpenCode 2.x subagents, model switches, and host mid-turn notes instead of superseding the held Run or losing tool continuations ([#34](https://github.com/oakimov/cursor-opencode-provider/pull/34))
- Recovered RequestContext and standalone tool catalogs survive restart and lifecycle turns without dropping MCP/tool state

Prior releases before the changelog was introduced are available via git tags (`v0.7.6`, `v0.7.5`, …).
