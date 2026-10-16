# OpenCode general lessons

[Index](../lessons.md) · [1.x](opencode-1.md) · [2.0](opencode-2.md)

These are failure lessons shared by both hosts, not a replacement for
[AGENTS.md](../../AGENTS.md). Host-specific details live in the linked files.

## Investigation and evidence

- **Trace the whole path.** PR #34's image review missed another delivery route;
  filtered plan searches missed the defining files. Read callers, intent and
  history before declaring a gap.
- **Verify the active branch and loaded build.** Partial-read work targeted MCP
  while live traffic used native reads; a stale SDK survived plugin reload.
  Record the exact binary, entrypoint, rebuilt files and host log.
- **Measure behavior, not presence.** A truncation flag reached the wire but was
  ignored. Use an A/B fixture that cannot reveal the answer independently;
  model claims about its prompt are not evidence.
- **Inspect the encoded payload.** A pre-encoder counter included a dropped
  history entry. Matching limits on two layers also misattributed truncation;
  follow the data before blaming a boundary.
- **Separate advertisement from execution and live tests from fixtures.** A
  hidden tool can remain executable. Unit success, a host badge or absence of
  error text does not prove the payload or permissions worked.
- **Observe races while active.** Completed-file checks missed transient growth;
  a shell trace disproved a lost-TERM diagnosis. Stress the producer and inspect
  its actual wait/state transitions (`test/terminal-runner.test.ts`).

## Boundaries and tool contracts

- **Moving compatibility code requires proving its replacement.** A neutral
  bridge import still coupled the provider to OCP. Keep fork detection and
  schemas in OCP, with catalog/call/result/path parity there
  (`test/architecture.test.ts`).
- **Use native defaults beneath structural overrides.** A bridge-only plan
  path broke standalone OpenCode. Installation directories do not identify the
  running host (`src/context/paths.ts`, `src/host-plan-file.ts`).
- **Preserve semantics, not names.** Similar tools can differ in merge behavior,
  required fields or execution language. Normalize before validation; a file
  tool once accepted a shell command and silently returned a listing
  (`test/tools.test.ts`).
- **Translate from permitted capabilities.** Patch substitution and Task routing
  failed when fixed tool names outlived a model/catalog change. Read the current
  turn, preserving native operations when permitted (`remapEditToolsForCatalog`,
  `remapNativeSubagentForCatalog`, `test/apply-patch.test.ts`).
- **Display completion is not execution authority.** Replaying a completed UI
  record duplicates effects without returning its result to Cursor. Mirror only
  final todo/plan state; Task executes through #28, using its correlated display
  title (`test/tool-call-bridge.test.ts`).
- **Aliases need execution mappings and capability flags.** Wording alone did
  not prevent native web/resource collisions. Unknown underscore names are not
  MCP server ids (`resolveToolServerIdentity`, `test/tools.test.ts`).
- **Dynamic discovery must include invocation identity.** The inner schema hid
  required outer `namespace`/`toolName`; server-side wrapper failures may appear
  only in display completion (`test/dynamic-catalog.test.ts`).
- **Read argument keys from the advertised schema.** Passing 1.x skill `name`
  to 2.0's `id` (or vice versa) was stripped to an empty object (`skillArgKey`,
  `test/tools.test.ts`).
- **Virtual MCP servers need a control plane.** Answer state probes from the
  same descriptors, validate nested inputs, and echo the requested path when
  discovery spills to a file (`test/runtime-files-pump.test.ts`).
- **Replace-all input is destructive.** A permissive normalizer turned malformed
  todos into deletion. Expand merge updates against the observed list or refuse;
  that small in-memory list intentionally resets on restart
  (`test/todo-tools.test.ts`, `test/tool-call-bridge.test.ts`).

## Protocol and recovery

- **Use independent wire evidence.** The extracted proto lagged live frame
  members, request/result field numbers differ, and local round trips hid schema
  errors. Consult the shipped descriptors and canonical fixtures
  (`src/protocol/exec-variants.ts`, `test/exec-variants.test.ts`).
- **Apply protobuf defaults deliberately.** Omitted scalars may mean zero;
  omission assertions need sparse decoding. Fragmented varints also need a
  streaming prefix parser (`test/conversation-maintenance.test.ts`).
- **Every inbound request needs a typed answer.** Ignoring an interaction
  deadlocked both peers. Known unsupported variants need a correlated refusal;
  unknown fields remain protocol drift (`test/interactions.test.ts`).
- **HTTP 200 and EOF are not completion.** Require Cursor's terminal event and
  retain trailer/GOAWAY evidence (`test/run-interruption.test.ts`).
- **Keep one iterator and dispatch serially.** Concurrent reads crossed handoff
  boundaries; a timed-out read still owned its promise. Drains must read past
  display completion until a genuine wait or terminal boundary
  (`test/parallel-pump.test.ts`).
- **Backpressure belongs to every response-required write.** KV replies filled
  the stream before an awaited heartbeat exposed it. Serialize writes, label the
  failing operation, and do not replay ambiguous buffered delivery
  (`test/stream-write.test.ts`).
- **A checkpoint is not permission to replay side effects.** Resume the newest
  eligible checkpoint only behind the replay barrier; a late tool result needs
  history recovery because `resume_action` re-requests that tool
  (`pumpWithRecovery`, `test/parallel-pump.test.ts`).
- **A helper must not take over its parent.** A smaller catalog was mistaken for
  a helper despite carrying the parent's pending result. Reconcile that result
  first; isolate genuine helpers (`test/fresh-turn-drain.test.ts`).
- **Drain before replacing a held Run.** Cancellation preserves warmth only with
  a valid terminal acknowledgement and fresh checkpoint. An incomplete drain
  must rebuild without losing the new request (`test/host-interrupt.test.ts`).
- **Ownership can change during an await.** Recheck the pending exec after each
  write; serialize continuations and release cleanup only for its pump owner
  (`test/session.test.ts`, `test/run-interruption.test.ts`).
- **Notes and media are not fresh user turns.** Misclassification superseded a
  held Run or fabricated a plan refusal. Preserve tool results, attribute only
  uniquely owned media, and keep ambiguous attachments in history
  (`test/host-notes-run.test.ts`, `test/image-input.test.ts`).
- **Injection needs acknowledgement and ordered fallback.** A written note is
  not necessarily consumed. Retry/defer it with its owning turn; an action may
  remove only the batches it captured (`test/host-notes.test.ts`).

## Planning and file mutations

- **Gate the unavoidable transition.** The model wrote a plan and stopped
  without volunteering SwitchMode. Attach approval to CreatePlan; refinement
  and dismissal must not return execution success (`test/create-plan.test.ts`).
- **Show the plan before asking.** Putting the full plan in the question dock
  hid the conversation. Render it in the assistant transcript and match the
  exact prompt echoed by the answer (`test/create-plan.test.ts`).
- **Approval must reach the host's next turn.** Flipping only Cursor mode did
  not start implementation. Queue the native switch after successful delivery
  and a terminal Run; serialize callbacks so an older one cannot erase a newer
  request (`test/switch-mode.test.ts`).
- **Lifecycle interactions must not mutate state.** Hard SwitchMode rejection
  polluted the real turn; soft-ack it without changing mode. Do not let a title
  turn write a plan (`test/switch-mode.test.ts`).
- **Tool-less narration can pollute the answer.** Give explicit context-only
  guidance and suppress narration before a refused call; otherwise it becomes
  the session title (`test/prompt-history.test.ts`).
- **A private edit read needs complete content.** Cursor's streamed edit is a
  read/whole-file-write handshake; a capped preview corrupted its replacement.
  Preserve correlation and edit intent, including edit-only turns and missing
  targets; external reads need exact host authorization first
  (`test/parallel-pump.test.ts`, `test/apply-patch.test.ts`).
- **Test bytes after the actual patch parser.** Stripping an empty payload line
  lost blank lines; endings differed by major and by direct/native route.
  Explicit replacement writes must stay distinct from targeted edits
  (`test/apply-patch.test.ts`; host-specific lessons below).
- **Envelope stripping must retain incompleteness.** `[Partial read: …]` changed
  behavior where a boolean did not. Parse markers by position; block destructive
  marker echoes, allow source quoting them in targeted edits, and do not label
  ordinary pagination truncated (`test/read-cap-repro.test.ts`).
- **Content fields are not transport metadata.** Filtering `file_bytes` removed
  legitimate writes. Binary images need staged bytes, not a display-preview
  write or media attachment that starts another turn (`test/generate-image.test.ts`).

## Context, caching and accounting

- **Freeze bytes, not just a map entry.** Concurrent builds mutated the prefix;
  recursively freeze, deduplicate first builds and compare encoded bytes
  (`test/frozen-request-context.test.ts`).
- **Hold an epoch without freezing capability truth.** Equal name sets retain
  descriptors/order; new names append. Permission is independently current.
  Compaction rotates state but transfers workspace context
  (`test/context-epoch.test.ts`, `test/prompt-history.test.ts`).
- **Do not seed Cursor's rendered root prompt.** Client entries suppressed rules
  and subagents. Rebuilt history belongs in the user transcript; checkpoint
  category drops expose lost context (`test/prompt-history.test.ts`).
- **Host instructions are host-owned.** Skill changes arrive through host
  updates, not per-turn relevance guesses. Restart tests must check the latest
  effective instruction, not merely the first frozen rule
  (`test/context-epoch.test.ts`).
- **Instructions need an instruction carrier.** Models refused host rules buried
  in tool output. Inject them as user context and retain acknowledgements;
  reserve hook context for notices about one result (`test/host-notes-run.test.ts`).
- **Empty tools are not compaction evidence.** Waiting for a sibling catalog
  stalled standalone titles. Tool-less Runs advertise empty tools; explicit
  compaction metadata controls reset (`resolveTurnToolState`).
- **Ground paths and tool observations explicitly.** Structured workspace facts
  alone did not prevent invented prefixes; flattening tool output into assistant
  prose taught fake execution (`test/prompt-history.test.ts`).
- **Keep occupancy, work and money separate.** Hosts replace message tokens but
  add step costs; Run-wide generation inflated tok/s. Use checkpoint occupancy,
  retain stale markers, and keep raw counters distinct from synthetic billing
  partitions (`test/usage-from-turn-ended.test.ts`).
- **Book charges only after accepted delivery.** Cancelled estimates must not
  credit another Run. Aggregate counters cannot prove per-call tiers; compare
  both hosts' pricing formulas (`test/billing.test.ts`).
- **Diagnostics need the same bounds as usage.** Unclamped prefixes and a
  double-counted footer token created false validations. An aggregate cache
  ratio cannot locate a miss; compare identities, hashes and categories, and
  preserve zero counters ([runbook](../../docs/cache-log-runbook.md)).

## Persistence and process lifetime

- **A restart snapshot is more than a checkpoint.** Bindings, reachable blobs,
  context, provenance, deferred notes and steer receipts must agree. Preserve
  all blobs if reachability is uncertain (`test/conversation-persistence.test.ts`).
- **Atomic replacement does not prevent lost writers.** Partition by host
  session; gzip protobuf bytes rather than base64 JSON. Revalidate cleanup
  candidates, expire loaded sessions too, and avoid decoded snapshot duplicates
  (`test/conversation-maintenance.test.ts`).
- **Bound indexes without discarding warm state.** Soft binding eviction must
  retain checkpoint/blobs/context and allow disk hydration; a process cap must
  not close pumping or pending Runs (`test/session.test.ts`).
- **Exercise Node and Bun filesystem edges.** Descriptor ownership, disappearing
  directory entries and either-side rename failures differ
  (`test/conversation-maintenance.test.ts`).
- **Shared state needs a real second module graph.** Query-string imports did
  not duplicate dependencies under Bun. Assert distinct exports; global records
  must be plain data (`test/process-shared.test.ts`).

## Shell supervision

- **Read native execution before emulating it.** Both hosts own shell choice,
  permission and process-group cancellation. Preserve native background support;
  the remaining redesign is tracked in [todo](../todo.md).
- **Use clocks and retain real outcomes.** Poll counts exceeded promised
  deadlines; stdout markers impersonated timeout/exit records. Pick the owning
  outcome across marker types (`test/shell-timeout.test.ts`).
- **Test every supported shell.** dash rejected bash-shaped `kill` syntax;
  macOS sh hid the problem. Disown lost exit status, and trapped bash `wait`
  could block after reaping a child (`test/terminal-runner.test.ts`).
- **Force signal gaps.** A child inherited traps before exec; a cancel arrived
  before `$!`. Latch cancellation, use marker-before-signal coordination and
  one-way stop state; instrumentation must not hide the race.
- **Missing completion does not mean unstarted.** Startup and cleanup need one
  atomic claim; repeated release may remove only truly unstarted jobs
  (`releaseUnstartedTerminal`).
- **Detached helpers need bounded owner-death cleanup.** A FIFO detects even
  SIGKILL; descendants can hold output open forever. Disarm on success so an
  explicitly detached daemon survives (`test/terminal-runner.test.ts`).
- **A PID is not ownership.** Keep the group leader alive through drain and
  verify identity before signalling either a child group or its supervisor.
- **Prove streaming and bounds while running.** BSD head/dd buffered output;
  command text in the record header faked early delivery. Drain excess bytes
  after the storage cap (`test/terminal-runner.test.ts`).
- **Read the real tail and provenance.** Long headers hid terminal footers;
  payload text resembled storage-failure records. Teardown collector exit must
  not replace native cancellation (`test/runtime-files.test.ts`).
- **Spawn success differs from payload success.** An already-finished fast
  command still needs a valid handle and its actual final exit.

## Auth, models and delivery process

- **Use the client with the actual credential flow.** CLI inspection missed IDE
  browser renewal; HTTP 200 with `shouldLogout` was rejection. Session and API-key
  renewal must stay separate (`test/auth-renewal.test.ts`).
- **Keep secrets out of serializable SDK options.** OpenCode exposes provider
  options. Resolve credentials on demand, persist only unchanged credentials,
  and hash secrets only for private lookup keys (`test/plugin.test.ts`).
- **Discovery failures need explicit outcomes.** Silent legacy-host fallback
  misrouted regional accounts; deadlines must include body reads, and telemetry
  remains opt-in (`test/agent-url.test.ts`).
- **Harden only owned paths.** A file override does not authorize chmod of its
  parent. Validate temporary directories; parse hostile delimiters in linear
  passes (`test/debug.test.ts`, `test/read-cap-repro.test.ts`).
- **Model metadata has separate owners.** Keep wire parameters isolated; make
  metadata-changing variants separate catalog entries. Invalidate cache schema
  before config consumes it; live negative capabilities outrank docs
  (`test/model-metadata.test.ts`).
- **Inspect generator inputs before changing mappings.** Pricing and model
  metadata came from distinct markdown endpoints. Run the live pricing gate
  before a bump; the v0.6.4 failure forced a retag ([release gate](../../AGENTS.md#hard-stop--release--version-bump--tag-gate-non-optional)).
- **Make tests capable of failing.** Type guards once sat outside tsc's include;
  root ignored permission fixtures. Use real usages, deterministic faults and
  independent host/frame evidence (`test/workspace-facts.test.ts`).
- **Isolate fixture state.** Capture teardown paths before awaiting; restore
  host-agent callbacks and cache overrides. One leaked cache root broke later
  plugin tests (`test/host-interrupt.test.ts`).
- **Match CI environments.** Narrow PATH fixtures omitted mkdir; Linux shell
  tests need an init reaper. Strip temporary module copies from coverage and
  include Bun editor types (`scripts/strip-copied-coverage.ts`).
- **Keep one current policy across docs and prompts.** A rebase can add review
  rules; reviewer patches still need whole-path validation. Changelog fixes
  compare with the release, not an intermediate PR state. Acceptance checklists
  stay reusable; dated counts and logs stay in run reports.
