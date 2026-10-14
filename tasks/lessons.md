# Lessons

Mistakes made in this repository and the principle each one taught. The
current rules live in `AGENTS.md`; this file records why they exist, so the
same mistake is not made twice. Entries are grouped by topic. Each one states
the principle first, then the incident behind it and the test or symbol that
now guards it.

When adding a lesson, put it in the matching section, merge it with an
existing entry that covers the same principle, and correct or remove any entry
it supersedes. Cite tests and symbols rather than line numbers, which drift.

## Investigating and verifying

- **Trace the whole feature before calling something a gap.** A review of
  PR #34 reported tool-read images as never reaching Cursor because one helper
  dropped the media caption; the feature delivered them through another path.
  Search the feature across `src/` and read the comments that state intent
  before reporting a regression.
- **Do not conclude that something is absent from a filtered search.** A search
  for `plan_enter` that excluded the files defining plan mode concluded that
  OpenCode had no such tool, and missed its prompt file, the commit that
  disabled it, and the synthetic-message mechanism behind it. Widen the search
  and read the git history before declaring absence.
- **Confirm which branch live traffic takes before optimizing it.** A stale
  comment ("most reads arrive via `mcp_result`") sent the first partial-read fix
  to a path that real sessions never used; one end-to-end run showed every read
  going through `read_result`.
- **Treat documentation of an unreleased API as a hypothesis.** The shipped
  `.d.ts` for OpenCode 2 contradicted its docs on hook arity, the `aisdk:`
  package discriminator and which domains exist. Read the published types for
  the exact version users install.
- **Verify that a signal changes model behavior, not only that it is on the
  wire.** `truncated: true` was already sent and models still treated partial
  content as the whole file; only a marker inside the content changed the
  answer. Design an A/B fixture so the signal under test is the only way to the
  right answer: a fixture whose lines carried their own index let the model
  infer truncation without the notice.
- **A model's account of its own prompt is not evidence about the prompt.** A
  model denied having content that its system prompt carried and that it could
  use on request. Dump what the provider sends to check prompt contents, and
  invoke a capability to check that it exists.
- **A value computed before the encoder is not evidence of what was sent.** A
  trace counter included a history entry that the encoder later drops, so the
  log looked like a prompt sent twice. Read the encode path before reporting a
  payload defect derived from trace arithmetic.
- **A matching constant on both sides does not show which side applied it.**
  Two independent 50 KiB budgets looked like one server-side cap, and the real
  truncation was on the read that fed the write. Trace the data path before
  attributing a boundary.
- **Separate "absent from the model's tool list" from "absent from the host".**
  A host can keep tools executable while presenting only a few of them as
  callable schema; nothing in the provider was broken. Look for a host
  presentation setting before changing wire code.
- **Trace a stuck process before designing its fix.** A reviewer blamed a lost
  TERM for a stuck shell supervisor, and so did the first reading; a `set -x`
  trace under parallel load showed it blocked in `wait` for a child that had
  already exited (see "Shell supervisor and terminal records").
- **Validate bounds while the producer is still running.** Checking only the
  completed file missed transient disk growth. Stress a fast producer and
  sample its live size (`test/terminal-runner.test.ts`).
- **Diagnose from the host's own log first.** OpenCode's log showed four
  "loading plugin" entries for two directories, which explained a disposed
  setup removing a live one.
- **Pin host binaries by absolute path in live runs.** A login shell put an
  OpenCode 1.x install ahead of 2.0, so the "2.0" runs were 1.x runs. Verify
  OpenCode 2.0 through its `plugin/opencode2` entry in a dedicated
  `OPENCODE_CONFIG_DIR`, never through a global config that loads the classic
  entry.
- **Rebuild `dist/` and restart the host before a live check.** A stale build
  still behaved the old way while the source was fixed, and a reloaded plugin
  header did not prove the host had replaced its cached SDK; only a full daemon
  restart did.

## Reviews, process and releases

- **A reviewer's suggested patch is a hypothesis about one branch.** The
  timeout-handoff suggestion bounded its wait by the supervisor's grace alone,
  skipped the cancellation drain, and left the other launcher with the same
  race. State the invariant first, apply it everywhere it holds, and derive
  bounds from what the other process actually does.
- **A rebase can bring in new review rules.** Rebasing PR #51 onto a `main`
  that had just added `.greptile/config.json` re-reviewed the whole PR under
  its protocol-evidence rule, and wire fields that had passed earlier reviews
  became a blocker. Check the PR against any rule change on the new base
  before pushing.
- **A later "do not commit" does not cancel an earlier request.** A request to
  raise coverage still stood after the user asked not to commit; finish it in
  the same change unless the user drops it.
- **Run the pricing gate before every version bump.** Tagging `v0.6.4` before
  `generate:pricing` passed locally failed the publish on an unmapped docs row
  and forced a retag. CI regenerating pricing is a backstop, not permission to
  skip the local gate (`AGENTS.md`, release gate).
- **A changelog bullet must describe a change from the last release.** Bullets
  that fixed only intermediate states of an unreleased feature, or that
  described internals, were flagged in review. Compare against the released tag
  before writing a "Fixed" entry.
- **State one policy identically everywhere.** The docs, the plan-mode
  reminder and the SwitchMode refusal drifted to "the provider never asks"
  while the code still asked. When a policy changes, update code, reminders,
  `README.md`, `docs/` and `AGENTS.md` together.
- **Keep acceptance documents reusable.** Turn review findings into checklist
  criteria, and keep dated results and validation counts in separate run
  reports.
- **Keep user-facing documentation short.** Point maintainers to the source
  and tests; prompt transport and checkpoint mechanics belong in code unless
  users need them to operate the feature.

## Provider boundary and host contracts

- **The compatibility dependency is one-way.** A host-neutral bridge is not
  enough if the provider imports the bridge package; host detection, fork
  environment variables and alternate tool vocabulary belong entirely to the
  compatibility layer. Before removing compatibility handling from the
  provider, prove the same catalog, call, result, path and schema behavior at
  its new home (`AGENTS.md`, provider boundary).
- **Describe, implement and test every fix as OpenCode behavior.** Clone-host
  names in the changelog, another host's agent names in tests and its approval
  wording in comments all broke the boundary. Checking the OpenCode source
  showed the case was simply "OpenCode 1.x", which has no `plan_enter`.
- **A structural bridge member may override a native rule, never replace it.**
  A bridge `planFile` without a native fallback left stock OpenCode with no plan
  file; the provider now follows `Session.plan` itself (`hostPlanFilePath` in
  `src/context/paths.ts`).
- **"Host location" means each OpenCode version's own default.** That is
  `Session.plan` on 1.x and the Plan directory on 2.0, not the operator's config
  or environment. Install directories on disk are evidence of installation,
  not of which host is running; route host-owned state only from explicit
  options or the provider's own install path.
- **A host may substitute one capability for another.** OpenCode 1.x replaces
  `edit`/`write` with `apply_patch` for some models. Translate keyed off the
  advertised set alone, never off a model id or host version, so the
  translation stays inert wherever the substitution does not apply
  (`remapEditToolsForCatalog`).
- **Host retry loops key off error text, not provider flags.** OpenCode's
  `SessionRetry` matches substrings such as `unavailable` and `exhausted`. After
  the provider spends its own retry budget, the message it hands the host must
  not contain those words, or OpenCode retries until restarted. Keep the real
  error code on structured fields.
- **Check each host's cost formula, not one host's override.** OpenCode 1.x
  honours `providerMetadata.copilot.totalNanoAiu`; OpenCode 2 prices every
  step's tokens. A $0 override hid the cost on one host and billed every
  occupancy snapshot as a full prompt on the other (`test/billing.test.ts`
  replicates both formulas).

## OpenCode plugin surfaces

- **OpenCode 1.18 "v2" and OpenCode 2.0 are different plugin APIs.** They share
  a version-adjacent name but differ in hook signatures, credential value types
  and provider schema. Keep separate entrypoints, and diff the published
  declarations when advancing a pin.
- **OpenCode 1.18 `/plugin/v2` has no `tool` domain.** `cursor_image_save` and
  `custom_websearch` exist only on the classic plugin, so a v2-only load
  silently disables image generation. The OpenCode 2.0 entry registers
  `cursor_image_save` through `ctx.tool.transform` with the host-neutral
  `executeCursorImageSave`, never `src/image-save-tool.ts`, which imports the
  classic `tool()`.
- **A shared module couples every entrypoint to its heaviest import.** A value
  import that one host's package root exports and another's does not breaks
  the second host, and an in-repo smoke test cannot see it because the dev
  dependency always resolves. Keep such imports in a leaf module owned by the
  host that needs them, and audit the built dependency graph.
- **The package root is a plugin entrypoint, not a general barrel.** The
  classic loader calls every exported function as a plugin; publish auxiliary
  APIs from subpath exports.
- **Confirm that an emulated hook writes to a channel the host reads.** A
  mutation to a field the host ignores compiles and silently drops the
  behavior.
- **A classic experimental messages hook must keep the array's identity.** The
  host passes `{ messages: msgs }` and later converts `msgs`, ignoring the
  returned object. Replace entries with request-only clones
  (`test/plugin.test.ts`).
- **Reproduce the host's hook order.** Test provider hooks with a
  pre-populated SDK, because OpenCode 2's generic loader can run first; keeping
  that fallback bypassed per-request credential resolution while tests that
  started from an empty SDK passed (`test/plugin-opencode2.test.ts`).
- **A plugin cleanup removes only what its own setup installed.** OpenCode 2.0
  sets a plugin up per location and again on reload, then disposes older
  setups. A cleanup that reset process-wide state removed the live setup's agent
  switch and plan directory, and approved plans never started. Setters return
  a disposer for their own registration (`setHostAgentModeSwitch`,
  `setNativePlansDir`).
- **OpenCode 2 has no `todowrite`/`todoread`, and its executor is
  `subagent`.** Plugin-owned todos are an opt-in fallback
  (`CURSOR_OPENCODE2_TODOS`), kept in memory per session. Cursor Task is
  remapped to `subagent` when `task` is absent (`remapNativeSubagentForCatalog`).
  OpenCode 2 `execute` is Code Mode JavaScript taking `{ code }`; OS commands go
  to `shell`/`bash`.
- **An OpenCode 2 plugin tool must opt out of Code Mode to reach the model.**
  Only `codemode === false` tools are in the AI SDK catalog. A tool that returns
  `output` must declare an `output` schema, or the host dies instead of
  reporting a tool error.
- **The OpenCode 2 `ToolContext` cannot ask for permission.** Do not register a
  second web-search path through it; supply a backend for the host's
  permission-gated `websearch` instead. `cursor_image_save` stays handle-only (an opaque id plus
  containment) and must never become a general file writer.
- **Do not write MCP server `codemode` to move tools into the direct
  catalog.** That field also changes what a remote server returns. Placement is
  the tool's `options.codemode`, set through `ctx.tool.transform`
  (`exposeDirectMcpTools`). OpenCode connects MCP servers asynchronously, so a
  first turn without MCP tools is expected and needs no delay.
- **The `skill` argument key differs by OpenCode major.** OpenCode 1.x
  requires `{name}` and 2.0 requires `{id}`, and each strips the other to `{}`.
  Detect the key from the advertised schema (`skillArgKey`).

## Cursor wire protocol

- **Follow the live schema, not the extracted proto.** A strict frame
  classifier counted `KvServerMessage.span_context` as a second variant, then
  rejected `InteractionUpdate` members it did not list, so every Run lost
  automatic retry. The extracted `agent.proto` lagged the server; the installed
  Cursor CLI bundle had the current descriptors. Debug runs trace unknown
  frame layouts (`replay frame unknown: layout=…`); read that before changing
  the set, and admit only members that carry no output or state.
- **Apply protobuf defaults before declaring a frame malformed.** proto3 omits
  default scalars, so a missing `uint32` can mean zero. For omission
  assertions, decode with `decodeMessageSparse`; `decodeMessage` invents
  defaults, so an absent string reads as empty.
- **A round trip through one local schema does not prove wire
  compatibility.** Use independent canonical field fixtures, especially where a
  reused field number changes wire type, and never register an alias under
  another message's name.
- **Never infer a response field number from the request's.** Request and
  result oneofs can be offset; keep an explicit mapping, and keep a complete
  request/result inventory so known-unsupported capabilities are
  distinguishable from protocol drift.
- **Every server-initiated request needs a correlated answer.** Treating an
  unfamiliar interaction query as an ignorable event left both peers waiting
  forever. A capability Cursor exercises implicitly, with no descriptor and no
  flag to disable it, still needs a total, typed answer.
- **HTTP success or a clean EOF is not a turn boundary.** Require the
  protocol's terminal event, capture trailers and GOAWAY, and rebuild from host
  history when a held Run disappears.
- **Fields can become live across client releases.**
  `RequestContextArgs.use_cached` was unused in an earlier CLI and live in a
  later one. Verify against the exact shipped build before treating a field as
  inert.
- **Dispatch each inbound frame to completion before reading the next.**
  Concurrent fan-out on a held stream consumed past the handoff boundary and
  lost continuation frames.
- **A timed-out read still owns the iterator.** Racing a read against a timer
  does not cancel the read. Keep its promise until consumed, including a late
  EOF or error, and use the same reader everywhere
  (`retains late %s after a frame-read timeout`, `test/parallel-pump.test.ts`).
- **Read the whole frame tail before giving up a Run.** A display
  `tool_call_completed` never waits on the client; a drain that stopped there
  superseded the Run about 150 ms before its checkpoint. Stop only on frames
  Cursor waits on: a new tool, exec or interaction. `step_completed` is not a
  text boundary either, because one step can span several tool calls.
- **Check a protocol action's live semantics before building on it.**
  `resume_action` re-runs the model step from the last checkpoint and
  re-requests the tool under a new id, so it cannot deliver a late tool result.
- **Serialize response-required writes and await each drain.** A heartbeat
  backpressure error was only the first awaited write to expose a backlog of KV
  replies queued elsewhere. Label failures with the operation that filled the
  stream.
- **A full-buffer reader is not a streaming parser.** `protobufjs`
  `Reader.uint64()` accepted a fragmented varint before its last byte; prefix
  inspection must tell incomplete values from complete ones
  (`test/conversation-maintenance.test.ts`).

## Runs, sessions and recovery

- **An in-session helper on a busy parent is not a fresh user turn.**
  Cancelling the parent's pending call and reusing its conversation reminted
  it, and the model resumed lost. Isolate such a helper on an ephemeral
  conversation. A smaller catalog alone is not evidence of a helper when the
  request carries a result for the parent's pending call
  (`preparePriorSessionForFreshTurn`, `test/fresh-turn-drain.test.ts`).
- **Background completion notices are context, not a new turn.** They can
  arrive as trailing user messages beside pending tool results; keep the
  results on the held Run and inject the notices after them
  (`test/host-notes-run.test.ts`).
- **A busy or incomplete fresh-turn drain does not establish a safe
  checkpoint.** Rebuild from the host's results while keeping the new user
  request, and never deduplicate commands by their text.
- **A rejected host call can leave Cursor generating an unseen follow-up.**
  Keep the conversation warm through the cancel action only after a terminal
  acknowledgement and a new checkpoint, and gate that cancel on settled
  results rather than a refusal flag, which OpenCode 1.x, interruptions and a
  restarted OpenCode 2 decline do not carry. Verified live: Cursor answered
  the cancel within 100 ms and the next Run stayed on the same conversation.
- **Once a host tool has been emitted, finish its step before rebuilding.** A
  checkpoint does not make replaying already-started side effects safe
  (`does not recover after emitting tools before %s`,
  `test/parallel-pump.test.ts`).
- **On a transient failure, resume from the newest checkpoint.** Fall back to
  history replay only when no stateful progress was made
  (`pumpWithRecovery`).
- **Revalidate the pending exec's owner after every awaited write.** A closed
  or replaced owner keeps its terminal state, pending entry and approval state.
  Serialize the whole continuation so overlapping calls cannot split claims or
  inject the same notes twice (`test/session.test.ts`,
  `test/host-notes.test.ts`).
- **Retry cleanup after the pump's owner releases it.** A cancelled consumer
  can stop the pump without a remote terminal event; never release or close a
  newer owner's pump (`test/run-interruption.test.ts`).
- **Process-global session metadata needs a finite lifetime.** Bound tool
  catalogs, lifecycle markers and conversation bindings, and evict them
  together with their checkpoints and blobs.

## Tool bridges and argument contracts

- **A translation needs compatible semantics, not similar names.** Decline a
  bridge that would turn a read into a replacement write, lose merge state,
  substitute a search term for a URL, or invent a structured choice from a
  boolean.
- **A completed display event is not authority to execute.** Mirror only
  self-contained final UI state; data, answers, side effects and failures need
  a request/reply channel.
- **Cursor's Task display does not run the subagent.** Exec #28 is
  `SubagentArgs`; emit it once through the host executor and answer with
  `SubagentResult`. Normalize Cursor's built-in agent names (`generalPurpose`
  to `general`, `bugbot` to `explore`), or host validation fails before
  anything spawns.
- **The per-turn host catalog is the allowlist for every exec.** Cursor's
  native capabilities exceed what the agent advertises; answer an unavailable
  request through its typed result instead of letting the host synthesize an
  `invalid` call.
- **A name collision with a native Cursor capability needs an alias.** Prompt
  wording does not route reliably. Advertise a collision-safe alias, map it
  back per session, set the matching capability flag to false on every context
  path, and apply the same remedy to each new collision.
- **An approval channel that cannot carry output is not a tool bridge.**
  Expose an executable host tool instead of auto-approving a server-side
  substitute.
- **Register a fallback tool under its final public id.** Hosts can reserve ids
  beyond their built-ins and filter after plugin tools merge; test the
  host-visible catalog.
- **Complete every required field before validation.** Native shell requests
  have no description; keep a supplied one and derive one from the command
  only when the schema requires it. Translation of another host's schemas
  belongs in the compatibility layer, and weakening the validator would hide
  those defects.
- **Gate guidance on the same catalog as execution.** Advertising AskQuestion
  as bridged without `question` invited a refusal, and silence about a missing
  `task` executor invited attempts.
- **Tool-less calls still see Cursor's native tools.** Give them an explicit
  text-only instruction. They still narrate and try tools, and the refused
  calls are invisible to the host, so hold their text and drop the part before
  a refused call, or the narration ends up in the session title. Check
  normalized arguments against the catalog's required keys before emitting a
  call; a correlated error can request a correction.
- **Carry a dynamic tool's full identity in its definition.** A reminder was
  not enough when discovery showed only the inner argument schema. Invocation
  identity (`namespace`, `toolName`) must accompany every call, including
  parallel ones, and server-side wrapper errors can arrive only in a display
  completion.
- **Host success does not prove the requested operation ran.** A file tool with
  optional fields accepted an unrelated `command` and returned a default
  listing; reject misplaced shell commands against the canonical schema.
- **A replace-all tool must reject malformed input before side effects.** A
  permissive storage normalizer at the validation boundary turned a missing
  list into a deletion. OpenCode `todowrite` replaces the whole list, so a
  Cursor `merge: true` patch must expand against the last observed list or be
  declined; that per-session snapshot is in memory only, and clearing it on
  restart is intentional.
- **Skill and MCP calls stay on Cursor's dynamic catalog.** Cursor models call
  them through GetDynamicTools/CallDynamicTool; do not try to promote them to
  top-level tools. Never infer an MCP server from an underscore prefix
  (`apply_patch` is not server `apply`); use `resolveToolServerIdentity`.
- **Advertising a virtual MCP server commits the provider to its control
  plane.** Answer state probes from the advertised descriptors, validated
  against the nested schema. Oversized catalogs spill through `write_args`;
  echo `WriteArgs.path` on the success so the model can read the spill.
- **Cursor's streamed edit is a handshake.** An existing file goes through
  `edit_tool_call`, `read_args`, then `write_args`. Answer a correlated
  missing target's read as an empty file, satisfy the private read with
  complete content, and translate only the correlated whole-file write back to
  a targeted host edit.
- **Check that a fallback in a dispatch path is reachable.** A display bridge
  gated on a small variant allowlist never saw the variant its fallback
  handled.
- **An allowlist named for transport metadata will swallow content.** Check
  existing filters before adding a decoded field; `file_bytes` was dropped as
  if it were metadata.
- **Background requests and timeouts have typed outcomes.** A background
  request cannot be renamed to a foreground shell call, and host timeout prose
  is metadata to strip before persistence, not stdout.

## Plan mode, SwitchMode and CreatePlan

- **An approval the model has to volunteer is not a gate.** The model wrote the
  plan and ended the turn without raising SwitchMode, so the prompt on that
  path never fired. Attach the prompt to the step that always happens.
- **Name one approval contract and route every channel through it.** One path
  asked but reported both answers as success, so a refinement request started
  implementation; another never asked. Success means approved for execution,
  error means written but not accepted. Writing a plan needs no consent;
  executing it does.
- **The user must see what they approve.** Cursor routes the plan body through
  the interaction query, so nothing had displayed it. Put the plan in the
  assistant message, not the question: OpenCode's question dock renders
  outside the scrollbox and a full plan pushes the conversation off screen.
- **Parse an answer with the exact anchor that was asked.** The answer is
  sliced relative to the echoed prompt, so a prompt built from a different
  label could never be approved.
- **A missing host plan tool is not a refusal.** OpenCode's plan tools ask the
  user and then switch the primary agent; entering a provider-owned mode needs
  no host tool, and only the execution approval needs one, falling back to
  `question`. Absence is the common case on many hosts, so the emulated path
  must be as careful as the native one.
- **An approval must start the host's next turn.** Acking Cursor and flipping
  the session mode only closed the held Run. The provider now selects the host
  `build` agent and continues (`queueHostAgentModeSwitch`,
  `src/host-agent-mode.ts`).
- **A deferred mode handoff must not depend on the model stopping.** Cancel the
  old Run explicitly, keep its final checkpoint, and accept only the requested
  cancellation as terminal before switching agents.
- **Lifecycle turns soft-ack interactions.** A hard rejection on a title turn
  entered the transcript and the real turn narrated that mode switches were
  blocked. Reply `approved{}` without changing the mode, and gate bridged
  interactions on this turn's permission, not on advertisement.
- **Prefer the host's own review.** Use a plan-stage tool or `plan_exit` under
  the `plan` agent first; only without one does CreatePlan ask through
  `question`, using upstream `PlanExitTool`'s wording.
- **Apply mode transitions only after delivery succeeds.** Encode approval
  replies without mutating state, and serialize native agent switches per
  session so an older callback cannot clear a newer request
  (`test/create-plan.test.ts`, `test/switch-mode.test.ts`).
- **After approval, tell the model the edit ban is over.** The older
  plan-mode reminder claimed to supersede other instructions, and the
  execution turn fell back to editing through the shell.
- **SwitchMode has two separate Cursor channels.** InteractionQuery #4 is the
  synchronous consent gate; display `switch_mode_tool_call` (#25) is a
  transcript record that is never replayed.
- **Mark the mirrored CreatePlan todo `completed`.** It is mirrored after the
  plan file exists; `pending` left a checklist item open forever.

## Context, prompt cache and instructions

- **Freeze cached context for real.** A snapshot kept in a map is not frozen:
  freeze it recursively, deduplicate concurrent first builds, and compare
  encoded bytes, or races change the prompt prefix.
- **Cache stability must not freeze capability truth.** Keep workspace context
  stable but rediscover tools, MCP, subagents and plugins every Run, and reuse
  the previous bytes only when the encoding is identical. A compaction resets
  the conversation id, not the workspace base.
- **Hold the catalog for the whole epoch.** Equal name sets keep frozen
  descriptors, and new names append at the tail; re-sorting the merged list or
  refreshing schemas retokenized the tools prefix. A recovered epoch has no
  original baseline bytes, so live host text must not be frozen as one.
- **A host-empty tool list is a lifecycle turn: advertise `[]` and do not
  wait.** An earlier design made zero-tool Runs wait for a sibling catalog to
  protect the cache; that stalled standalone no-tool calls and serialized title
  generation, and was replaced. OpenCode 2 compaction still sends a nonempty
  catalog and keeps the epoch advertisement, with execution refused
  (`src/language-model.ts`, tool-catalog resolution).
- **Detect lifecycle turns from explicit metadata.** An empty tool list or
  `toolChoice: none` alone does not identify compaction.
- **Compaction must keep real tool results and its own identity.** Replacing
  results with tool-name summaries made later turns claim tools had run. Never
  resume the compaction agent's checkpoint as the normal agent; rebuild from
  the host's compacted prompt.
- **Checkpoint categories show what reached the prompt.** A persistent drop of
  `rules`, `skills` or `subagents` to zero after a rebuild was a prompt
  assembly failure, not accounting noise: client entries in
  `root_prompt_messages_json` stopped Cursor from rendering them. Compare each
  rebuilt conversation's first checkpoint with its predecessor.
- **Skill catalog changes reach Cursor through the host.** Per-turn "relevant
  skill" nudges re-loaded skills whenever user text overlapped a description;
  OpenCode never does that. The host's `<system-update>` is the catalog-change
  channel, and `agent_skills` carries paths and descriptions only.
- **Provider guidance must follow the exact per-turn catalog.** Naming
  unavailable tools turned a fallback into another unexecutable request; leave
  guidance out of lifecycle prompts.
- **Deferred instructions keep their order and carrier.** A fresh seed does
  not prove a deferred note is present; match the note's text inside the seed.
  Acknowledgement order is not instruction order, and sending a user action
  removes only the batches it captured (`test/host-notes.test.ts`).
- **Test restart recovery against the latest effective context.** Matching the
  frozen first-turn prefix does not prove the checkpoint's current
  instructions (`test/context-epoch.test.ts`).
- **Never flatten tool results into assistant prose.** It teaches the model to
  write fake results instead of calling the tool; mark needed evidence as a host
  observation.
- **Derive a path anchor from the same root as the structured context.**
  Structured workspace context alone did not stop invented path prefixes after
  a rebuild.
- **Result correlation filters delivery, not ownership.** Keep host-owned
  results until attribution of attached media is complete, and attribute only
  slices that are uniquely determined.

## Reads, writes and truncation

- **Stripping an envelope must keep what it said.** A capped read without its
  footer looks complete, and the model rewrote the file from a partial view.
  Re-state the limit in the content as `[Partial read: …]` and through
  structured fields.
- **Parse control markers by position, not by substring.** A file that quotes a
  marker otherwise impersonates it.
- **Guard the destructive operation, not every echo.** Reject whole-file writes
  and overwriting patches that echo the partial-read marker; allow targeted
  edits, because source can legitimately quote the warning.
- **Permission and completeness are separate facts.** A host-authorized
  external read can establish permission for an edit's private read; read the
  exact file completely only after that host read succeeds.
- **A bounded result's length is not the resource's length.** Preserve the
  requested range and full-resource metadata, and recover missing counts in
  fixed-size chunks rather than buffering the whole file.

## Usage, cost and diagnostics

- **Hosts replace message tokens but add up cost.** OpenCode replaces an
  assistant message's tokens (the TUI footer needs `output > 0`) and adds every
  step-finish to session cost. Emit the last-known occupancy snapshot at every
  boundary and bill through `src/billing.ts`; occupancy deltas would show only
  the increment.
- **`TurnEnded` spans the whole held Run; a finish spans one slice.** Emitting
  its output tokens made host tokens-per-second reach six figures. Exact
  counters belong under `providerMetadata.cursor.*Raw`.
- **Use checkpoint `usedTokens` for occupancy.** Aggregate `TurnEnded` input is
  not context occupancy. Keep an older breakdown marked stale rather than
  presenting it as current; categories can lag occupancy.
- **Verify counter semantics across several live turns.** Totals can already
  contain their cache subsets, and one increasing sample made request-local
  counters look cumulative.
- **Book a charge only after its consumer accepts the finish.** Tool-step
  estimates belong to their Run; a cancelled Run's estimates must not become a
  credit against another Run. Aggregate counters cannot prove per-call tiers,
  so document the estimate's limits instead of promising an exact invoice
  match (`test/billing.test.ts`).
- **A diagnostic must apply the same bounds as the value it checks, and check
  its own total.** An unclamped prior prefix reported a mismatch for correct
  usage, and counting the footer token as extra input made the totals
  disagree (`test/usage-from-turn-ended.test.ts`).
- **An aggregate cache ratio cannot say why reuse is low.** Log the prior
  occupancy, category deltas and context fingerprints, report a zero counter
  without guessing its cause, and mark per-call accounting unavailable.
- **Match fallbacks to live data.** Cursor Auto (`default`) has no static
  context size; live checkpoints report 256k, not a generic 200k.
- **Append to an existing debug log.** Truncating on every module load wiped
  earlier lines and made verification fail falsely; the log caps itself at
  10 MiB instead.

## Persistence and cache files

- **A checkpoint alone is not restart recovery.** Its session binding, blobs,
  stable context base, lifecycle tool fallback and pending compaction rebase
  must be saved together at a successful turn end. Keep only blobs reachable
  from the latest checkpoint, and keep everything when the graph cannot be
  proven complete.
- **Measure before choosing a storage format.** Protobuf bytes plus whole-file
  gzip shrank snapshots far more than compact JSON, which pays base64 for every
  blob.
- **Partition durable state by its single writer.** Atomic replacement stops
  torn files, not lost updates when several processes rewrite one aggregate
  file. One file per OpenCode session, with cleanup that revalidates anything
  it moves aside.
- **Do not exempt loaded sessions from expiry.** Pinning them disabled
  expiry on long-running servers; the per-file operation queue already
  serializes loads, writes and cleanup.
- **Do not keep a decoded copy of every loaded snapshot.** It duplicated the
  live state of every session the process touched; keep only the head and
  re-read from disk (`takeConversation`).
- **Runtime file APIs differ in edge cases.** Disposing a Bun file stream
  closed a supplied descriptor despite `autoClose: false`; Bun's `opendir`
  throws `ENOENT` mid-iteration where Node yields nothing
  (`removableDirectoryEntries`); a `rename` `ENOENT` can name either side
  (`discardCacheCandidate`). Test file maintenance on Node and Bun.

## Shell supervisor and terminal records

- **Read the native execution paths of both OpenCode versions first.** Shell
  selection, permission, spawn, exit and cancellation differ, and OpenCode 2
  runs its shell create hook before the permission scanner. Source anchors are
  in `docs/opencode-2.md`.
- **Pass through a capability the host already has.** OpenCode 2's shell
  `background` option keeps completion notices that a provider substitute
  dropped. Recognize only the provider's own files, and resolve relative
  working directories against the workspace before registering a policy.
- **Keep failures in the host's execution status.** OpenCode 2 lowers every
  tool error to text, so preserve native status before conversion, for every
  tool and in restarted history (`test/opencode2-tool-results.test.ts`).
  Classic rejection and interruption differ again; test both on both versions
  (`test/classic-tool-results.test.ts`).
- **A decline or interruption can bypass `execute.after`.** Cleanup also
  follows native permission and terminal events, must be idempotent, and must
  keep ready or running jobs.
- **Pair anonymous creates with their owner by what makes them ambiguous.**
  OpenCode 2 `create.before` has no call id. A process-wide gate let one
  rewritten command stall every session's shells. Lanes keyed by command text
  limit waiting to identical commands, and matching against the holder's live
  `execute.before` input attributes a command a later hook rewrote
  (`test/shell-timeout.test.ts`).
- **Time deadlines with clocks, not poll counts.** 500 × `sleep 0.02` took
  15.8 s on macOS. Both OpenCode versions kill the command's whole process
  group on timeout, abort or failure, so the supervisor must not be a plain
  child of the launcher; it naps until a child sends `USR1`.
- **Outcome markers inside stdout are data.** Choose the launcher's outcome
  across all marker kinds before interpreting it.
- **Run generated scripts under every supported `/bin/sh`.** dash rejects
  `kill -TERM -- -PGID` and prints "Terminated" to its own stderr when `wait`
  reaps a signalled job. macOS `sh` is bash, so force the dash path with a
  `sh` link first on `PATH`.
- **bash discards a disowned job's status.** Keep the payload a job and
  silence notices by redirecting the shell's own stderr.
- **bash's `wait` can lose a child it reaped.** A trapped signal arriving
  during `wait` jumps out after `waitpid` reaps the child but before it is
  recorded (bash 5.2 and 5.3 `waitchld`), and a later `wait` for that child
  blocks while any other child lives. Wait only for children `kill -0` still
  sees, carry exit status in files, and read a vanished leader's status only
  when no other child is left.
- **A signal can be swallowed by a just-forked child.** Before it execs or
  resets traps, the child still has the parent's trap; bash clears pending
  traps in a new subshell and dash clears its traps. Stop plain sleeps with
  KILL, and give helper subshells a marker file, written before the signal, to
  stop on (`stops deadline sleeps at once even when TERM cannot reach them`).
- **Record a one-way transition instead of re-deriving it.** bash can list a
  job it just killed as running, so a second stop waited out a full grace.
  Forking instrumentation hid that race; an in-memory trace exposed it.
- **Latch a signal that arrives between fork and `$!`.** Force that gap in the
  real generated script instead of relying on a stress loop.
- **A missing completion marker does not prove work never started.** Cleanup
  and startup both take one atomic claim (`mkdir`), and a failed startup hands
  the claim back (`releaseUnstartedTerminal`).
- **Tie a detached helper to its owner with a FIFO.** The kernel closes the
  owner's write end on any exit, including SIGKILL, so the reader sees EOF.
  Disarm the watcher on success so explicitly detached daemons survive. A
  helper that must not hold the FIFO needs another owner-death path: the
  updater, which polls the supervisor anyway, stops the hard-timeout watchdog
  and, after a bounded drain, the collector, whose output a descendant in its
  own process group can hold open indefinitely.
- **Keep a group's leader alive through draining, and signal only a process
  you can show is still yours.** PIDs are reused, and shell ids identify
  records, not processes. This holds upward too: a helper signalling its
  supervisor checks `is_ours` first, because a day-long deadline can outlive
  an abruptly killed supervisor.
- **Copy pipe output as it is read.** BSD `head -c` and macOS `dd` with
  `count` above 1 buffer. Prove streaming with text that is not also in the
  command, because the record header repeats it.
- **A collector's exit during teardown is not an I/O failure.** Keep the native
  cancellation outcome and the writer's explicit error record; the collector
  marks a complete drain itself.
- **Do not assume a terminal record's header fits a fixed prefix.** The
  command and title precede `status` and have no length limit. A prefix scan
  missed the completion footer when the header alone exceeded the head
  budget, and a 64 KiB read left a record with a dead supervisor reporting
  `running`. Read the real file tail for the footer, and read until the header
  ends when patching it (`test/runtime-files.test.ts`).
- **A background spawn reports its handle once the command runs.** A fast
  command that already finished is still a successful spawn.

## Auth, endpoints and security

- **Check the Cursor client that actually has the flow.** Cursor CLI never
  renews a browser login; the IDE does, through `/oauth/token`. The endpoint
  previously called, `/auth/token`, did not exist. A failed refresh can be
  HTTP 200 with `shouldLogout`, so read the body.
- **Never let one credential stand in for another.** A browser login and an
  API key renew differently, and a fallback between them hid which one was
  broken.
- **Do no more with credentials than OpenCode's own providers do.** Renew on
  demand, store the real expiry, and hand the SDK a token function: provider
  options are served unredacted from `/provider`.
- **Fail closed when account-specific discovery fails.** A silent fallback to a
  legacy global host routed regional accounts to a host that rejects them.
  Telemetry on discovery calls is off unless explicitly enabled, and the API
  base URL and the Run host are separate options.
- **Harden only provider-owned paths.** An explicit file override authorizes
  that file, not a chmod of its parent; validate provider temp directories as
  real, current-user-owned directories.
- **A network deadline must cover reading the body.** Clear the timer after
  the body is consumed, or a server can hang initialization after the headers.
- **Security scanners judge by shape.** When a token is hashed only for an
  in-memory key, keep the raw secret out of global state and suppress the rule
  narrowly with the reason.
- **Parse structural delimiters in linear passes.** Regexes with repeated
  prefixes and lazy wildcards became polynomial; keep stress fixtures for those
  inputs.

## Models and pricing

- **Give generated wire parameters their own typed payload.** OpenCode merges
  provider, model, agent and variant options into one namespace.
- **A variant that changes host metadata is a separate model entry.** Carry the
  upstream wire id in a dedicated option when the host uses `id` for
  inheritance.
- **Invalidate a cache schema before configuration reads it.** Refreshing the
  file later does not update a catalog already built in memory.
- **Inspect the fetched artifact before extending a generator.** Cursor's
  pricing and model data come from separate markdown endpoints that render as
  one table.
- **Publish a capability flag only when the wire keeps the matching parts.**
  Live negative values outrank documentation, because account catalogs can
  contradict the public table.

## Testing and tooling

- **A type-conformance test proves nothing unless the build checks it.**
  `include: ["src"]` excluded the test tree and the first guard passed
  vacuously; break a guard on purpose to confirm it fails. Assert real usages
  rather than whole-interface assignability.
- **Load a physical second module graph to test shared state.** A
  query-string import neither reloads dependencies nor creates another module
  under Bun; assert different exported identities (`test/process-shared.test.ts`).
- **Check every fixture that narrows `PATH` after changing a launcher.** The
  no-bash fixture lacked `mkdir`, and only Linux CI ran it. Run Linux-only paths
  in `docker run --init oven/bun` before pushing; without `--init`, killed
  descendants stay zombies and look alive.
- **Capture per-test state before awaiting in a shared `afterEach`.** A hook
  timeout otherwise deletes the next test's files. Clear installed host-agent
  switches after each fixture, because Bun's file order differs across
  filesystems (`test/switch-mode.test.ts`).
- **Choose fixtures that fail the same way for every user.** A permission-mode
  fixture does not fail under root; a malformed Git index does
  (`test/workspace-facts.test.ts`).
- **A malformed response is not a passing injected-failure test.** Count
  launches across the transcript and require the intended owner before scoring
  output bounds. Live-test prompts must separate interactive answers from host
  actions that deliberately stop the turn (`docs/execution-self-verify.md`).
- **Strip coverage records for temporary module copies.** Codecov maps them
  onto the real file and counts their lines as misses
  (`scripts/strip-copied-coverage.ts`).
- **Keep Bun types in the editor's TypeScript config.** Include `bun` in
  `compilerOptions.types` so OpenCode's LSP resolves `bun:test` without
  widening the build.
