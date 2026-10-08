# Host compatibility acceptance checklist

Run this checklist before releasing changes to CreatePlan, SwitchMode, tool-catalog caching, or the structural host boundary. Unit/type tests support the result; they are not proof of interactive behavior.

## Build/install preflight

- [ ] Provider HARD STOP: `bun run generate:pricing && bun run check:pricing` must both exit 0; commit mapping/`pricing-data.ts` updates before any version bump or `v*` tag (do not tag first and rely on publish CI)
- [ ] Provider: `bun test && bun run typecheck && bun run build`
- [ ] Provider: `bun test test/architecture.test.ts` again **after** build (covers `dist/`)
- [ ] OCP: `bun test ./test && bun run typecheck && bun run build`
- [ ] OCP: `bun test test/architecture.test.ts` again after build
- [ ] `git diff --check` in both repositories
- [ ] Rebuild/reinstall the exact package entries the stock host loads; verify symlink/install tree, loaded `dist` path, and copied package manifests/exports as well as file contents
- [ ] OCP plugin discovery accepts valid JSONC without joining tokens across comments, and rejects malformed JSONC and unterminated block comments
- [ ] Do not modify a host/vendor checkout

## Classic OpenCode — approval without `plan_exit`

1. Start stock OpenCode in a TTY with provider debug logging enabled, in the default build agent.
2. Enter plan mode and ask for a small plan that makes Cursor raise CreatePlan, with `question` advertised and `plan_exit` absent.
3. Verify the plan file is written to OpenCode's plan location and the plan is visible in the assistant transcript before the `question` approval prompt (`src/protocol/interactions.ts`, `src/protocol/create-plan.ts`).
4. Answer No: planning stays active. Answer Yes: after successful reply delivery, verify a native build-agent turn starts and the requested implementation happens once (`src/language-model.ts`, `src/host-agent-mode.ts`).

## OpenCode 1.x without `plan_enter`

1. Start OpenCode 1.x in a TTY with `OPENCODE_EXPERIMENTAL_PLAN_MODE=1` (so `plan_exit` is advertised) and provider debug logging, in the default build agent.
2. Ask the model to switch to plan mode and plan a tiny change.
3. Verify `host-agent-mode: pending … target=plan`, any CreatePlan in that Run replies `outcome=failed` (deferred, nothing written), and `host-agent-mode: switched … target=plan` follows the Run's end.
4. Verify the next turn runs under the `plan` agent with `cursorMode=plan`; CreatePlan logs `BRIDGED create_plan … bridge=exit hostTool=plan_exit`, the plan is shown and written to the session plan file (`.opencode/plans/<created>-<slug>.md` in a git project), and the `plan_exit` question appears. The model makes no `get_mcp_tools` lookup for `plan_exit`.
5. Answer No: the session stays in `plan` and nothing outside the plan file changes.
6. Approve: verify `host-agent-mode: host left plan agent`, the session returns to the build agent, and the change is applied exactly once.
7. Verify no turn is injected into subagent or hidden sessions.
8. New session: pick `plan` in the agent picker (Tab) before asking for a plan. Verify `host-agent-mode: host entered plan agent`, the Run logs `cursorMode=plan`, and steps 4–6 hold without any SwitchMode: CreatePlan bridges to `plan_exit`, no `write` of the plan file and no MCP `plan_exit` call by the model, and no `get_mcp_tools` lookup.

## OpenCode 2.0

Install and leftover-dump cleanup: [OpenCode 2.0 setup](./opencode-2.md) ([safe transition](./opencode-2.md#safe-transition)).

1. Load only `cursor-opencode-provider/plugin/opencode2` in stock 2.0 (prefer a dedicated `OPENCODE_CONFIG_DIR`; use a `$OPENCODE_CONFIG_DIR/plugins/<name>/` package directory, not a bare `.js` path).
2. Confirm Cursor auth + models: `/connect` → Cursor, then Cursor models in the picker (in-memory `ctx.provider` inventory). There must be no leftover `providers.cursor` in `opencode.json`. Filter picker by provider Cursor if needed (`time.released` is `0`).
3. Enter plan mode (Tab to Plan, or ask the model to switch). If the model uses SwitchMode from the build agent, that Run should end and a Plan-agent turn should start (`host-agent-mode: switched`); CreatePlan belongs in that Plan turn.
4. Verify the plan is written to the Plan directory, the plan appears in the transcript before the advertised `question` approval prompt, and the session is the Plan agent.
5. Answer No: remain in plan mode. Answer Yes: verify the native build-agent continuation and one implementation. Also check a manual switch to build: `host-agent-mode: host left plan agent`, `cursorMode=agent`, and implementation follows the plan.
6. Verify no private/unsupported host API is invoked.

## OMP interactive plan review

For each choice, start from a fresh plan-mode session:

- **Approve and execute**: one success, plan mode exits, one follow-up execution starts.
- **Refine plan**: tool returns error, message says refinement was requested, plan mode stays enabled, no execution starts.
- **Dismiss/cancel**: tool returns error, message says not approved/cancelled (not “refinement requested”), plan mode stays enabled, no execution starts.
- Host denials/rejections map to Cursor's user-reject reason.

Capture transcript and side effects; confirm no retries/duplicate follow-ups.

## Mode-switch delivery and concurrency

Use controlled transport/host-callback failures for these supporting checks;
then exercise the successful handoff in the stock host's interactive session.

1. Fail delivery of an approved CreatePlan reply. Verify recorded Cursor mode stays in plan mode and no implementation or native build-agent switch is queued.
2. Deliver the approval successfully. Verify the native switch waits for the owning Run to end and starts exactly one implementation turn.
3. Trigger overlapping native-agent switch flushes for one session. Verify at most one host callback runs at a time.
4. Queue a replacement while the callback is pending. Verify completion or failure of the older callback preserves the replacement and its Run ownership, and releases the callback lock so the replacement can run.

## OCP host capabilities and continuations

Run on stock MiMo, Kilo, Pi, OMP, and DSH through OCP, using the shared
[Cursor + OCP self-verify checklist](https://github.com/oakimov/opencode-plugin-compat/blob/main/docs/guides/cursor-ocp-self-verify.md).

1. Exercise each available question, todo, helper, plan-review, and image-save capability. Skip only unavailable capabilities; an unanswered question or unexercised image save is not a pass.
2. Verify todo snapshots preserve completed entries and leave no exercised item open at the end. Check both stored task status and the live task display: completing a task must show a checked row, including after row reordering; cancelling a task must not appear as completion. Verify helper output reaches the parent once.
3. On DSH, verify a child notice after a tool result still delivers that result and resumes the pending assistant tool call. Notices after a completed text-only assistant reply must not start another turn.
4. Verify plan approval precedes implementation, refinement/dismissal keeps planning active, and execution happens once. If plan staging fails, verify no execution starts and a later explicit retry can complete the review.
5. Verify an image save succeeds, its file exists with the reported byte count, and its default artifact location stays outside the worktree unless an in-repository path was requested.
6. With a plugin that changes `chat.params`, verify provider options, temperature, topP, topK, and maxOutputTokens reach the model with the plugin's values. Report a failed field independently of successful registration or tool execution.

## Pi generic-provider isolation

1. Configure a generic/non-Cursor OpenCode provider through pi-bridge.
2. Start stock Pi with no Cursor provider installed.
3. Verify generic provider/model registration and one text + one tool-loop turn.
4. Verify no Cursor host tools are imported/registered and no missing-Cursor error is logged.
5. Configure a provider whose name merely contains “cursor”; verify Cursor tools still do not activate.

## Catalog/cache diagnostics

For one cold session followed by a normal continuation:

- a compaction call may arrive with `incomingTools=0`, but wire advertisement equals the full sibling catalog; a title or other zero-tool call advertises no tools and does not wait for the catalog;
- compaction and real Run use identical RequestContext hashes;
- tool order and definitions are byte-stable;
- with tools present, `allowTools=false` only affects execution permission, not advertisement;
- subsequent diagnostics show warm continuity/cache reads rather than a catalog-induced rebuild;
- a smaller incoming catalog that carries a result matching a pending parent call reconciles that result on the parent conversation before helper isolation;
- a real helper uses its own conversation and leaves the held parent intact;
- plan approval and the following implementation request retain the parent conversation with a nonempty checkpoint, `reset=false`, and `requestContextReused=true` at each transition;
- every emitted usage-validation record reports `status=ok`; a later warm Run does not excuse an earlier unexpected parent reset.

Use `docs/cache-log-runbook.md` for exact fields and handoff evidence.

## Filesystem hygiene

- [ ] `git status --porcelain -uall` unchanged in the test project
- [ ] no package install or unrelated host configuration created by CreatePlan
- [ ] plan uses the host's own location: the known session plan file for OpenCode 1.x (which may be worktree `.opencode/plans/`), the Plan directory for OpenCode 2.0, or the structural bridge's location (`src/context/paths.ts`, `src/host-plan-file.ts`)
- [ ] no temporary/debug/agent-worktree files remain in either repository

## Reporting

State each item as **passed**, **failed**, **skipped** (capability unavailable),
or **not run**. Record the host/provider/OCP versions, loaded package entries,
and evidence location with transcript records or debug-log line numbers for
each result. Redact credentials, identities, and private local paths. Keep
interactive outcomes separate from controlled regressions and build/package
checks; never infer a TTY result from unit tests or a supplied run made before
the current rebuild. Store dated run reports separately from this reusable
checklist.
