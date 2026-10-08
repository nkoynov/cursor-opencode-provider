# Feature Parity: cursor-opencode-provider vs Cursor CLI

Comparison against the decompiled Cursor agent CLI **2026.08.25-3e8eec8** (local `~/.local/share/cursor-agent/versions/`; client version resolved via `src/protocol/client-version.ts`). Last verified 2026-08-30.

Parity target is interactive `cursor-agent` (`Run` client: TUI and `--print`). `cursor-agent worker` / `runBridgeMode` / Cloud Agents are out of scope.

**Legend:** ✅ full parity · 🔶 partial/adapted · ❌ not implemented · ⚪ N/A (not an interactive CLI concern)

## Wire protocol (agent service)

| Feature | Cursor CLI | This provider | Match |
|---|---|---|---|
| Connect-RPC `Run` bidi stream over HTTP/2 | Yes (`createAgentService`, Run) | Yes (`src/transport/connect.ts`) | ✅ |
| `RunSSE` / `RunPoll` transports | Yes | No (HTTP/2 bidi only) | ❌ |
| Client msgs: run_request, exec, kv, conversation_action, exec_control, interaction_response, client_heartbeat, prewarm | All 8 | All except `prewarm_request` (RunRequest.mcp_tools is prewarm-only, empty on real turns) | 🔶 |
| Server msgs: interaction_update, exec, checkpoint_update, kv, exec_control, interaction_query, ttft_breakdown | All | All except `ttft_breakdown` (not decoded) | 🔶 |
| ConversationActions | 15 oneof actions + 3 metadata fields (`triggering_auth_id`, `triggering_user_info`, `request_context_parts`): user_message, resume, cancel, summarize, shell_command, start/execute_plan, async_ask_question_completion, cancel_subagent, background_task/shell/subagent, subscription_notification, goal_continuation, inject_context | Schema encodes 5: user_message, resume, cancel, async_ask_question_completion, inject_context (system payload only) — summarize emulated via compaction marker | 🔶 |
| Sparse protobuf decode w/ full schema | Native protobuf | Hand-rolled `struct.ts` sparse decoder + full schema table (`messages.ts`) | ✅ |
| Checksums / framing / device id / client-version | Yes | Yes (`checksum.ts`, `framing.ts`, `device-id.ts`, `client-version.ts`) | ✅ |
| Response-required write backpressure + heartbeat | Yes (blocks on heartbeats) | Yes (drain-await per stream, heartbeat replies) | ✅ |

## Tools (exec requests) — `src/protocol/exec-variants.ts`

| Tool | Interactive CLI | This provider | Match |
|---|---|---|---|
| read / write / edit / delete / grep / ls | Native | Native + OpenCode permission-aware read/write; edit via catalog-aware remap | ✅ |
| apply_patch (edit/write substitution) | Native `apply_patch` exists | Synthesizes `apply_patch` envelopes when OpenCode 1.x drops edit/write | 🔶 (parity by design) |
| shell (streaming, stdin, background, force-background, allowlist precheck) | Native pty | `shell_args` + `shell_stream` + `background_shell_spawn` (bash/nohup); stdin / force-background / allowlist precheck unsupported | 🔶 |
| mcp, list_mcp_resources, read_mcp_resource, mcp_state | Native | MCP exec + provider-control variants | ✅ |
| subagent, subagent_await | Full SubagentType oneof (computer_use, browser_use, explore, custom, bash, shell, vm_setup_helper, debug, cursor_guide, watch_video, media_review) + permission modes | subagent bridged to OpenCode `task`; subtype set limited to what OpenCode advertises; await unsupported | 🔶 |
| request_context | Native | provider-control | ✅ |
| diagnostics | Native `read_lints` via codebase-ref / LSP (`DiagnosticsArgs.path`; empty list if `--disable-codebase-ref`) | Soft-deny error. OpenCode already appends LSP errors on write/edit/apply_patch (those remaps already carry them). Dedicated pull `#9` is **not planned**: the public host surface is `GET /lsp` status and the `lsp` **navigation** tool, not a diagnostics fetch. Do not remap `#9` onto `lsp`, spawn language servers, or change OpenCode. | ⚪ |
| canvas_diagnostics | Worker exec-daemon only (`getCanvasDiagnostics`); interactive `createLocalResourceProvider` never registers it | — | ⚪ |
| fetch / web_fetch | Native exec + UI | Native exec unsupported; capability via host `custom_webfetch` / `webfetch` (see Interactions) | 🔶 (parity by design) |
| record_screen, computer_use | Native X11 executor is worker-only (`setupDaemon` `--computer-use` / `enableRecordScreen`). Interactive: `--computer-use-coords` (coords only), Darwin harness stub throws, Mac bundled `computer-use` MCP — not exec #21/#22 | — | ⚪ |
| execute_hook | Native (interactive `hookExecutor`) | ❌ | ❌ |
| redacted_read | Worker-only inbound exec #29; registered only when `isSecretRedactionEnabled` (bridge hardcodes `true`; interactive never sets `registerRedactedReadExecutor`) | Soft-deny | ⚪ |
| smart_mode_classifier | Native `--auto-review` (Smart Auto): client classifier ALLOW/BLOCK | Soft-deny error; OpenCode has no Auto-review mode — not planned | ⚪ |
| git_diff_request | Native (always registered) | provider-control local `git` (`FILE_DIFFS` default; `origin/HEAD` or `origin/<main\|master\|develop>`) | ✅ |
| mini_swe_agent_bash (#52→#55) | Native Mini-SWE shell (same `ShellArgs` / `ShellResult` as #2, Pi-style result offset) | Soft-deny `rejected`; Mini-SWE / SWE-agent bash is not planned | ⚪ |
| conversation_search | Native local/cloud conversation index | Soft-deny empty `{hits:[]}` | ❌ |
| agent_store_conflict | Agent-store journal (cloud/worker-shaped) | Soft-deny typed error | ❌ |
| adopt | Cloud agent adoption | Soft-deny typed error | ❌ |
| pi_read/bash/edit/write/grep/find/ls (Pi/OMP protocol) | — | ✅ (pi-bridge hosts) | ✅ (provider extra) |

## Interactions (server-side queries)

| Interaction | Interactive CLI | This provider | Match |
|---|---|---|---|
| #2 web_search | Native search UI | Rejected by design; `web_search_enabled=false` so Cursor prefers host `custom_websearch` (interaction replies cannot carry OpenCode tool results) | 🔶 (parity by design) |
| #3 ask_question | Blocks until user answers; async variant via `async_ask_question_completion_action` | Bridged to OpenCode `question` tool, CLI-verbatim semantics, async echo of server args | ✅ |
| #4 switch_mode | Blocks until approve/reject | OpenCode 1.x uses advertised `plan_enter`/`plan_exit`; without `plan_enter`, a 1.x host's primary-agent session enters its `plan` agent through a synthetic `session.promptAsync` turn after the Run is terminal (CreatePlan waits for that turn; inside it, CreatePlan writes the host's own plan file and runs the host `plan_exit` review); OpenCode 2 selects its native `plan`/`build` primary agent after the Run is terminal. Without `plan_exit`, leaving the host `plan` agent is the user's agent switch (the provider never asks its own question); provider reminders are the structural fallback. As in the CLI, every user message carries the current mode (`UserMessage.mode`, `agent.v1.AgentMode`); Cursor plan mode follows the host `plan` agent both ways, including a switch in the host's agent picker. Agent/prompt changes rotate incompatible checkpoints. | ✅ |
| #7 create_plan | Writes Cursor plan file, returns plan_uri | Writes plain markdown where the host keeps plans; executing needs approval through the host's channel: a host plan-stage tool, the `plan_exit` review under the `plan` agent, or else in plan mode the `question` prompt (Yes switches to build); with none, the user switches to the build agent | 🔶 |
| #8 setup_vm | Ack `success:{}` (no VM; TUI `setupVmEnvironmentArgs` is the same no-op) | Ack `success:{}` | ✅ |
| #9 web_fetch | Native fetch UI | Rejected by design; `web_fetch_enabled=false` so Cursor prefers host `custom_webfetch` / `webfetch` | 🔶 (parity by design) |
| #10 pr_management | Errors `PR management is only available in cloud agents` | Rejected | ⚪ |
| #11 mcp_auth | Rejected (`MCP authentication is not supported in CLI mode`) | Rejected | ⚪ |
| #12 generate_image | Approve → server generates → binary write exec | Approve + stage bytes + `cursor_image_save` (byte-exact verified). Classic/OCP raise `external_directory`/`edit`. Stock OpenCode 2.0 advertises the same handle-only tool (`permission: "edit"`) and commits after containment because public `ToolContext` has no `ask`. | 🔶 |
| #13 replace_env | Failed (`Environment replacement is not supported in CLI mode`) | Failed (`Environment replacement is not supported by the OpenCode provider.`) | ✅ |
| #14 connect_scm | Rejected (`Connecting GitHub is not supported in CLI mode`) | Rejected | ⚪ |

## Display / transcript surface

| Feature | Cursor CLI | This provider | Match |
|---|---|---|---|
| Tool-call display variants (~40 UIs: read/write/edit/shell/mcp/web-search/image/ask/switch/plan/todos/sem-search/…) | Full | Subset bridged to OpenCode tools (todowrite, websearch, question, webfetch, plan_enter, generateimage); non-bridgeable variants dropped with replay-safety | 🔶 |
| Thinking blocks (`thinking_delta`) | Yes (--show-thinking) | Yes (`thinking.ts`) | ✅ |
| Compaction (`summarize_action` / checkpoint reset) | Native | Emulated via `compaction-marker.ts` + conversation rotation | 🔶 |

## Persistence & state

| Feature | Cursor CLI | This provider | Match |
|---|---|---|---|
| Checkpoint handling | Full read/write (agent-kv); soft-reuse incomplete/large | Decode + reachable-blob export graph; warn on >100 MiB / incomplete, never remint | ✅ |
| KV blobs | sqlite blob store + AES-GCM encryption + merkle tree | Blob store + reachability; writes serialized w/ backpressure | ✅ |
| Conversation restart/resume | store.db, resume.tsx, fork-chat-session, export | `conversation-persistence.ts` (atomic pb.gz snapshot, 24h expiry, compaction rotation) | 🔶 |
| Token details (used/max/category breakdown) | `ConversationStateStructure.tokenDetails` → UI tray | `token-details.ts` → `providerMetadata.cursor.context`; AI SDK usage = authoritative total | ✅ |
| Session lifecycle (superseded, cap) | Managed by CLI | `maxOpenSessions` backstop, superseded-by-new-run | ✅ |

## Context & discovery

| Feature | Cursor CLI | This provider | Match |
|---|---|---|---|
| Rules (AGENTS.md/CLAUDE.md/CONTEXT.md, global config, instructions globs) | Native | OpenCode's system prompt as one `global` (alwaysApply) rule, like the CLI's AGENTS.md | ✅ |
| Skills, agents, plugins discovery | Native | Skills/agents via host tools; plugins still collected for `hooks_additional_context` | 🔶 |
| Git + layout + env + terminal epochs | Native (direnv, terminal env) | Git/layout/env; no terminal-state epochs | 🔶 |
| Slash commands / custom modes | Native | Not sent as context | ❌ |
| @-file selections, selected skills, cursor commands | Native (selectedContext) | Images from user messages; no @-file/skills picking UI | ❌ |
| Stable prompt-cache base (frozen + byte-identical reuse) | CLI relies on server cache | Explicit freeze/compare/overlay per conversation_id | ✅ (provider extra) |

## Auth, models, host

| Feature | Cursor CLI | This provider | Match |
|---|---|---|---|
| PKCE OAuth + API key + refresh | Yes + keychain (macOS) | Yes (auth.json); no keychain | 🔶 |
| GetServerConfig / agent host resolution | Yes, memoized | Yes, memoized in-memory, HTTPS `*.cursor.sh` validation | ✅ |
| Model registry | GetUsableModels + fixed catalog + picker | cursor-models.json cache + pricing | ✅ |
| Telemetry | statsig (~599 flags) + quality metrics | Opt-in GetServerConfig telemetry only | 🔶 |

## Beyond the wire (CLI-only surface)

These have no provider equivalent by design — the provider is a *host language model*, not a terminal app: commands (`agent`, `ls`, `resume`, `login`, `cloud`, `env`, `mcp`, `sandbox`, `worker`, `automations`, `repo search`, `bedrock`, `acp`…), TUI, headless `-p` modes, notifications (OSC 9/777/99), sudo askpass, cursor-blame, background-jobs UI, history rewind, statsig gating, worktrees, sandbox binary, PDF worker, terminal image rendering. ⚪/❌ where Cursor needs them (e.g. goal continuation, autorun, queued-message-enter — the host OpenCode provides the equivalents: autorun, plan mode, resume).

Worker / cloud-bridge only (not a parity target): secret redaction / `redacted_read`, X11 computer-use and record-screen executors, `replace_env` as a working VM swap, PR management, `readOnlyBareMode`, `--pool` / `ClaimWorker`, mounted agent-store claim.

Not planned (OpenCode has no equivalent mode): `smart_mode_classifier` / Cursor `--auto-review`. The host keeps OpenCode allow/ask/deny as the permission gate; inbound `#38` stays a typed soft-deny. Do not implement ALLOW/BLOCK classification.

Not planned (same Mini-SWE / SWE-agent surface): `mini_swe_agent_bash` (`#52`→`#55`). Inbound stays a typed `rejected` soft-deny. Do not remap it onto OpenCode `bash`.

Not planned (no presented pull capability): `diagnostics` / Cursor `read_lints` (`#9`). OpenCode LSP feedback already rides write/edit/apply_patch tool output, which this provider remaps. Public plugin/SDK surface is `GET /lsp` **status** and the `lsp` tool (definition/hover/symbols only). We do not add OpenCode APIs, call host-internal `lsp.diagnostics()`, shell out to `opencode debug lsp`, spawn our own language servers, remap `#9` onto `lsp`, or return an empty success list (that would claim the file is clean). Inbound `#9` stays a typed error deny.

## Bottom line

- **Core agent protocol:** near-total parity — every message class, checkpoint/KV semantics, token accounting, backpressure, and the interaction machinery are mirrored, many CLI-verbatim.
- **Tools:** the full read/write/edit/grep/ls/mcp/subagent family plus Pi variants, `shell_args`/`shell_stream`, and background shell spawn; `git_diff` is answered locally. Deliberately unsupported vs interactive CLI: shell stdin/force/allowlist, hooks, conversation_search, agent_store_conflict, adopt. Native computer-use / record_screen / redacted_read are worker-only, not gaps. `smart_mode_classifier`, `mini_swe_agent_bash`, and dedicated `diagnostics` / `read_lints` are **not planned** (LSP errors still arrive via write/edit/apply_patch output).
- **Interactions:** ask_question and switch_mode bridge on both OpenCode majors; generate_image is complete on permission-aware classic/OCP surfaces and safely unavailable on stock OpenCode 2.0; CreatePlan uses a host plan file + execution gate. Web search/fetch interactions are rejected by design and covered by executable host web tools; setup_vm and replace_env match the interactive CLI (ack / fail). PR / MCP auth / SCM are not interactive CLI capabilities.
- **Biggest remaining gaps:** hooks, full ConversationAction surface (background jobs, goal continuation, user-context injection, shell_command), await/force-background shell continuity, and everything UI-shaped (TUI, notifications, sudo, worktrees, sandbox). Web search/fetch, PR management, computer use, screen recording, Auto-review / `smart_mode_classifier`, Mini-SWE bash, and dedicated diagnostics pull are **not** interactive gaps.
