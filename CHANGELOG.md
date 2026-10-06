# Changelog

## [Unreleased]

### Fixed

- OpenCode 2 plugin `generate.text` calls (memory recall, summaries) complete instead of waiting forever for a tool catalog ([#40](https://github.com/oakimov/cursor-opencode-provider/pull/40) by [@nkoynov](https://github.com/nkoynov))
- OpenCode 2.0 loads the AI SDK provider at the installed plugin's version instead of the latest npm release ([#41](https://github.com/oakimov/cursor-opencode-provider/pull/41) by [@nkoynov](https://github.com/nkoynov))
- Images returned by MCP tools reach the model in the same turn instead of after the next user message ([#46](https://github.com/oakimov/cursor-opencode-provider/pull/46) by [@nkoynov](https://github.com/nkoynov))
- Images read with the `read` tool reach the model in the same turn instead of a "Media attached" placeholder ([#42](https://github.com/oakimov/cursor-opencode-provider/pull/42) by [@nkoynov](https://github.com/nkoynov))
- Cursor models carry a model `family`, so OpenCode writes session titles and summaries with its small model (for example GPT-5.6 Luna) instead of the model you are coding with ([#43](https://github.com/oakimov/cursor-opencode-provider/pull/43) by [@nkoynov](https://github.com/nkoynov))
- Tool calls the model makes in parallel (for example several subagents) run at the same time instead of one after another ([#N](https://github.com/oakimov/cursor-opencode-provider/pull/N) by [@nkoynov](https://github.com/nkoynov))
- Host notes that follow a step's tool results (nested `AGENTS.md` instructions, background completions, other `<system-update>` notes) no longer turn an OpenCode 2 read into its numbered raw text or get lost on errors, searches and writes: they are added after the result is parsed, to the last result with a text field or else the Run's next result ([#N](https://github.com/oakimov/cursor-opencode-provider/pull/N) by [@nkoynov](https://github.com/nkoynov))
- A message sent while a step's tools run no longer cancels the held Run's pending results and makes the model redo them: when the Run waits on exactly that step's results, the message is injected into that Run the way Cursor CLI steers, then the results are delivered, and a message Cursor does not take is sent as a follow-up when the turn ends ([#N](https://github.com/oakimov/cursor-opencode-provider/pull/N) by [@nkoynov](https://github.com/nkoynov))

## [0.8.0] - 2026-10-04

### Changed

- Host system context is delivered as a single always-apply rule; the provider no longer rediscovers local `AGENTS.md`, skills, or agent files for Cursor `RequestContext` ([#37](https://github.com/oakimov/cursor-opencode-provider/pull/37))
- RequestContext tool overlay is names-only; full tool definitions are answered from the live host catalog on exec #36 ([#37](https://github.com/oakimov/cursor-opencode-provider/pull/37))

### Fixed

- Cursor browser-login and API-key credentials renew the same way Cursor's own clients do, so long sessions stop failing after token expiry ([#35](https://github.com/oakimov/cursor-opencode-provider/issues/35))
- Cursor conversations stay consistent across OpenCode 2.x subagents, model switches, and host mid-turn notes instead of superseding the held Run or losing tool continuations ([#34](https://github.com/oakimov/cursor-opencode-provider/pull/34))
- Recovered RequestContext and standalone tool catalogs survive restart and lifecycle turns without dropping MCP/tool state

Prior releases before the changelog was introduced are available via git tags (`v0.7.6`, `v0.7.5`, …).
