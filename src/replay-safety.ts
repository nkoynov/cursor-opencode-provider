import type { CursorProviderError } from "./errors.js"
import { trace } from "./debug.js"
import { readAllFieldsStrict, type StrictRawField } from "./protocol/struct.js"

export type ReplayBarrierReason =
  | "visible-text"
  | "visible-reasoning"
  | "visible-tool-row"
  | "display-tool-lifecycle"
  | "non-control-exec"
  | "stateful-interaction"
  | "unknown-or-malformed-frame"

/** Host output without execution authority: sending the turn again repeats no side effect. */
const OUTPUT_ONLY_BARRIERS: ReadonlySet<ReplayBarrierReason> = new Set([
  "visible-text", "visible-reasoning", "visible-tool-row",
])

/**
 * A mid-turn `inject_context_action.user_context` this Run wrote: an OpenCode 2.x early steer or
 * host notes. Cursor answers a delivered one with `user_message_appended` echoing its `message_id`.
 */
export type RunInjection = {
  kind: "steer" | "note"
  injectionId: string
  messageId: string
  text: string
  /** The raw host note bodies the text was built from. */
  notes?: string[]
  /** Cursor reported `context_injection_state` delivered. */
  delivered?: boolean
}

/** One of the Run's own injections Cursor appended; a rebuild needs host history to hold it. */
export type AppendedInjection = { kind: "steer"; injectionId: string } | { kind: "note"; injectionId: string; notes: string[] }

/** Past this many tracked injections a Run's echoes are no longer matched (fail closed). */
const MAX_RUN_INJECTIONS = 64
const MAX_APPENDED_INJECTIONS = 128

/** Remember an injection before writing it, so its echo can be recognized. */
export function trackRunInjection(injections: RunInjection[], injection: RunInjection): void {
  injections.push(injection)
  if (injections.length > MAX_RUN_INJECTIONS) injections.splice(0, injections.length - MAX_RUN_INJECTIONS)
}

export function markRunInjectionDelivered(injections: RunInjection[] | undefined, injectionId: string | undefined): void {
  const injection = injectionId ? injections?.find((candidate) => candidate.injectionId === injectionId) : undefined
  if (injection) injection.delivered = true
}

/**
 * The injection an appended message echoes: the same `message_id` and text, already delivered.
 * A match is consumed, so a second echo of the same message stays unmatched.
 */
export function takeAppendedInjection(
  injections: RunInjection[] | undefined,
  message: AppendedUserMessage | undefined,
): AppendedInjection | undefined {
  if (!injections || !message) return undefined
  const index = injections.findIndex((candidate) => candidate.messageId === message.messageId)
  const injection = index === -1 ? undefined : injections[index]!
  if (!injection?.delivered || injection.text !== message.text) return undefined
  injections.splice(index, 1)
  return injection.kind === "steer"
    ? { kind: "steer", injectionId: injection.injectionId }
    : { kind: "note", injectionId: injection.injectionId, notes: [...injection.notes ?? []] }
}

/**
 * An exec the provider answered itself, so it has no host result. Each ran nothing on the host:
 * - `terminal-read`: a read of a host shell's terminal record (Cursor's AwaitShell polls);
 * - `missing-read`: the typed `file_not_found` / `invalid_file` of a read whose target is missing;
 * - `edit-handshake`: the empty read before an edit creates a new file;
 * - `task-attachment`: the placeholder read of a Task's attachment.
 * The last two are only complete with their call's host result: the edit's write, the Task.
 * Fork: `refusal`, the provider's refusal of a call (a refusal burst, a held call cancelled after a refused change,
 * a soft-denied Cursor-native exec the host cannot run).
 */
export type ProviderAnswer = "terminal-read" | "missing-read" | "edit-handshake" | "task-attachment" | "refusal"

const OWNED_ANSWERS: ReadonlySet<ProviderAnswer> = new Set(["edit-handshake", "task-attachment"])

type ReplayExec = {
  sessionId: string
  id: number
  callId?: string
  answer?: ProviderAnswer
  /** Fork: an exec handed to a host tool. */
  host?: true
  /** Fork: an exec step order still holds back: nothing ran it and the host has not seen it. */
  held?: true
}

/** Plain Run-owned state retained across host tool-step pump calls. */
export type ReplaySafetyState = {
  statefulBarrier?: ReplayBarrierReason
  /**
   * Every exec needs its owner's host result; ids can restart on a resumed Run.
   * `callId` is the display call the exec claims. `answer` marks an exec the provider answered
   * itself (`ProviderAnswer`); history holds no result for it.
   */
  execs?: ReplayExec[]
  /** Display calls Cursor announced; history holds one only through the host exec that claims it. */
  announcedCalls?: string[]
  /** Only strict inline catalog lookups qualify; spilled catalogs remain barriers. */
  catalogCalls?: Record<string, "started" | "completed">
  /** History cannot represent opaque interactions, unknown frames or unclaimed display work. */
  historyRebaseUnsafe?: boolean
  /** Fork: display calls the provider bridged to a host tool; the host result stands for each. */
  bridgedCalls?: string[]
  /** Fork: calls Cursor completed without an exec; history holds one only once it is bridged. */
  completedCalls?: string[]
  /**
   * Fork: what the Run did after the last checkpoint it accepted, which a Run resumed from that checkpoint does again:
   * the calls it announced, and the `sessionId:execId` of each handshake or attachment read the provider answered.
   */
  sinceCheckpoint?: { announcedCalls?: string[]; ownedAnswers?: string[] }
  /** Fork: the latest pump pass, which a history rebuild generates again. */
  attempt?: {
    /** Calls it announced: nothing ran them unless an exec claimed them or Cursor completed them. */
    announcedCalls?: string[]
    /** It handed work to the host or did something history cannot hold. */
    unrepresentable?: boolean
    /** Fork: what it did that history cannot hold, apart from the host calls whose results history gets. */
    unrebuildable?: string
    /** Text the host already shows from it. */
    shownText?: string
  }
  /**
   * Echoes of this Run's own steers and host notes. Each stays a stateful barrier, but a history
   * rebuild may proceed when the prompt it seeds holds every one (checked at rebuild time).
   */
  appendedInjections?: AppendedInjection[]
}

/**
 * Fork: whether a Run Cursor ended while the host still ran its calls can go on from host history once their
 * results are in. Those calls are the interrupted pass's own; anything else it did must be history-representable.
 */
export function heldRunLossRebuildable(state: ReplaySafetyState | undefined): boolean {
  return !state?.attempt?.unrebuildable && announcedCallsClaimed(state, state?.attempt?.announcedCalls)
}

/**
 * Every display call Cursor announced must be represented by a host exec, a bridge to a host tool, or a
 * completed inline catalog lookup. `unfinished`: calls of the interrupted step that nothing ran, which a
 * rebuild may leave out. A started catalog lookup is Cursor's own work, so only its validated completion counts.
 */
export function announcedCallsClaimed(state: ReplaySafetyState | undefined, unfinished: readonly string[] = []): boolean {
  const bridged = new Set(state?.bridgedCalls)
  const completed = new Set(state?.completedCalls)
  const claimed = new Set([
    ...bridged,
    ...state?.execs?.flatMap((exec) => exec.callId ? [exec.callId] : []) ?? [],
    ...Object.entries(state?.catalogCalls ?? {}).flatMap(([callId, stage]) => stage === "completed" ? [callId] : []),
    ...unfinished.filter((callId) => !completed.has(callId) && !state?.catalogCalls?.[callId]),
  ])
  return (state?.announcedCalls ?? []).every((callId) => claimed.has(callId))
    && (state?.completedCalls ?? []).every((callId) => bridged.has(callId))
}

/** Fork: execs a host tool ran. */
export function hostExecs(state: ReplaySafetyState | undefined): NonNullable<ReplaySafetyState["execs"]> {
  return state?.execs?.filter((exec) => exec.host) ?? []
}

export type HistoryCoverage = {
  /** Execs that went to the host. */
  hostExecs: number
  /** Provider answers by kind. */
  answers: Partial<Record<ProviderAnswer, number>>
  /** Every host exec has its result in history, and every owned answer its call's host result. */
  complete: boolean
}

/**
 * Whether host history holds everything the Run's execs did. `completed` holds
 * `sessionId:execId` of each host result in the prompt being rebuilt. A provider
 * answer needs no result of its own; an edit handshake or Task attachment read
 * needs a host exec of the same call whose result history holds.
 */
export function historyCoverage(state: ReplaySafetyState | undefined, completed: ReadonlySet<string>): HistoryCoverage {
  const execs = state?.execs ?? []
  const hostExecs = execs.filter((exec) => !exec.answer)
  const resultHeld = (exec: { sessionId: string; id: number }) => completed.has(`${exec.sessionId}:${exec.id}`)
  const answers: Partial<Record<ProviderAnswer, number>> = {}
  let complete = hostExecs.every(resultHeld)
  for (const exec of execs) {
    if (!exec.answer) continue
    answers[exec.answer] = (answers[exec.answer] ?? 0) + 1
    if (OWNED_ANSWERS.has(exec.answer)
      && !(exec.callId && hostExecs.some((owner) => owner.callId === exec.callId && resultHeld(owner)))) {
      complete = false
    }
  }
  return { hostExecs: hostExecs.length, answers, complete }
}

/**
 * Fork: the execs `historyCoverage` finds history short of, for a lost held Run's check: an exec without an answer
 * and without its result, or an edit handshake or Task attachment read without its call's host result. An exec step
 * order still holds ran nothing and never reached the host, so a rebuild leaves it out like an unfinished call.
 */
export function uncoveredExecs(state: ReplaySafetyState | undefined, completed: ReadonlySet<string>): ReplayExec[] {
  const execs = state?.execs ?? []
  const hostExecs = execs.filter((exec) => !exec.answer)
  const resultHeld = (exec: ReplayExec) => completed.has(`${exec.sessionId}:${exec.id}`)
  return execs.filter((exec) => !exec.held && (!exec.answer
    ? !resultHeld(exec)
    : OWNED_ANSWERS.has(exec.answer) && !(exec.callId && hostExecs.some((owner) => owner.callId === exec.callId && resultHeld(owner)))))
}

/** Fork: the Run accepted a checkpoint it may resume from. */
export function markResumeCheckpoint(state: ReplaySafetyState | undefined): void {
  if (state) state.sinceCheckpoint = undefined
}

/**
 * Fork: the replay state a Run resumed from the cut Run's checkpoint carries. The resume does again what followed
 * that checkpoint, so a call that began after it and that only the provider answered (an edit's handshake, a Task's
 * attachment read) is gone with its answers, and no host result can ever cover them. A call the checkpoint saw
 * announced, or with an answer before it, stays.
 */
export function resumedReplaySafety(state: ReplaySafetyState | undefined): ReplaySafetyState {
  const execs = state?.execs ?? []
  const since = state?.sinceCheckpoint
  const answeredSince = new Set(since?.ownedAnswers)
  const afterCheckpoint = (exec: ReplayExec) => answeredSince.has(`${exec.sessionId}:${exec.id}`)
  const abandoned = new Set(execs.filter(afterCheckpoint).flatMap((exec) => exec.callId ? [exec.callId] : [])
    .filter((callId) => execs.every((exec) => exec.callId !== callId || afterCheckpoint(exec))
      && (!state?.announcedCalls?.includes(callId) || !!since?.announcedCalls?.includes(callId))
      && !state?.bridgedCalls?.includes(callId) && !state?.completedCalls?.includes(callId)))
  return {
    ...state,
    execs: state?.execs?.filter((exec) => !exec.callId || !abandoned.has(exec.callId)),
    announcedCalls: state?.announcedCalls?.filter((callId) => !abandoned.has(callId)),
    bridgedCalls: state?.bridgedCalls?.slice(),
    completedCalls: state?.completedCalls?.slice(),
    catalogCalls: state?.catalogCalls && { ...state.catalogCalls },
    appendedInjections: state?.appendedInjections?.slice(),
    sinceCheckpoint: undefined,
  }
}

export class AttemptReplaySafety {
  private barrierReason: ReplayBarrierReason | undefined
  private stateful = false
  /** A barrier of this attempt other than an echo of the Run's own injection. */
  private otherBarrier = false

  constructor(
    private readonly sessionId: string,
    private readonly state: ReplaySafetyState = {},
  ) {
    this.stateful = state.statefulBarrier !== undefined
    state.attempt = {}
  }

  markBarrier(reason: ReplayBarrierReason): void {
    this.mark(reason, reason === "non-control-exec")
  }

  /**
   * A display lifecycle frame. A started call stays a stateful barrier but
   * blocks a history rebuild only until a host exec claims it; completion of a
   * claimed call adds nothing history lacks. The sole server-side exception is
   * a completed inline catalog lookup: it has no execution side effect. Other
   * server-side calls and frames without a call id cannot be rebuilt.
   */
  recordToolLifecycle(lifecycle: ReplayToolLifecycle | undefined): void {
    if (lifecycle?.catalog && lifecycle.kind === "completed"
      && this.state.catalogCalls?.[lifecycle.callId] === "started") {
      this.state.catalogCalls[lifecycle.callId] = "completed"
      trace(`recovery: inline-catalog-completed callId=${lifecycle.callId} sessionId=${this.sessionId}`)
      return
    }
    const claimed = !!lifecycle && (!!this.state.execs?.some((exec) => exec.callId === lifecycle.callId)
      || !!this.state.bridgedCalls?.includes(lifecycle.callId))
    if (lifecycle?.kind === "completed" && claimed) {
      trace(`replay: display completion of claimed callId=${lifecycle.callId} sessionId=${this.sessionId}`)
      return
    }
    // Fork: Cursor runs AwaitShell itself, and a wait changes nothing, so history needs nothing for it.
    if (lifecycle?.wait) {
      trace(`replay: Cursor-side wait ${lifecycle.kind} callId=${lifecycle.callId} sessionId=${this.sessionId}`)
      this.mark("display-tool-lifecycle", true)
      return
    }
    if (lifecycle?.kind === "started" && !claimed) {
      // Fork: the unfinished-call exemption would otherwise let a rebuild drop Cursor's own lookup.
      if (this.state.catalogCalls?.[lifecycle.callId] || lifecycle.unverifiedCatalog) {
        this.mark("display-tool-lifecycle", false)
        return
      }
      if (lifecycle.catalog) {
        this.state.catalogCalls ??= Object.create(null) as Record<string, "started" | "completed">
        this.state.catalogCalls[lifecycle.callId] = "started"
      }
      const announced = this.state.announcedCalls ??= []
      if (!announced.includes(lifecycle.callId)) announced.push(lifecycle.callId)
      const sinceCheckpoint = (this.state.sinceCheckpoint ??= {}).announcedCalls ??= []
      if (!sinceCheckpoint.includes(lifecycle.callId)) sinceCheckpoint.push(lifecycle.callId)
      const attempt = this.state.attempt!.announcedCalls ??= []
      if (!attempt.includes(lifecycle.callId)) attempt.push(lifecycle.callId)
      this.mark("display-tool-lifecycle", true)
      return
    }
    // The provider may bridge this completion to a host tool while handling the same frame.
    if (lifecycle?.kind === "completed") {
      const completed = this.state.completedCalls ??= []
      if (!completed.includes(lifecycle.callId)) completed.push(lifecycle.callId)
      this.mark("display-tool-lifecycle", true)
      return
    }
    this.mark("display-tool-lifecycle", false)
  }

  /** Fork: a display call handed to a host tool; its result in host history stands for the call. */
  claimBridgedCall(callId: string): void {
    const bridged = this.state.bridgedCalls ??= []
    if (!bridged.includes(callId)) bridged.push(callId)
    this.state.attempt!.unrepresentable = true
  }

  recordExec(id: unknown, callId?: string): void {
    const execs = this.state.execs ??= []
    if (typeof id !== "number" || !Number.isSafeInteger(id)
      || execs.some(exec => exec.sessionId === this.sessionId && exec.id === id)) {
      this.markHistoryUnsafe(`invalid-or-repeated-exec-id id=${String(id)}`)
      this.state.attempt!.unrebuildable ??= "repeated-exec-id"
      return
    }
    execs.push({ sessionId: this.sessionId, id, ...(callId ? { callId } : {}) })
  }

  /** Fork: step order holds a recorded exec back until the calls before it finish. */
  recordHeldExec(id: number): void {
    const exec = this.state.execs?.find((entry) => entry.sessionId === this.sessionId && entry.id === id)
    if (exec && !exec.host && !exec.answer) exec.held = true
  }

  /** Fork: a held exec is dispatched again: to the host, or to an answer of the provider's own. */
  recordReleasedExec(id: number): void {
    const exec = this.state.execs?.find((entry) => entry.sessionId === this.sessionId && entry.id === id)
    if (exec) delete exec.held
  }

  /**
   * Fork: a recorded exec goes to a host tool, so its result must reach host history before a rebuild.
   * `callId`: the display call it serves when the exec names none (a generated image's write); its host result
   * stands for that call too.
   */
  recordHostExec(id: number, callId?: string): void {
    const exec = this.state.execs?.find((entry) => entry.sessionId === this.sessionId && entry.id === id)
    if (exec) {
      exec.host = true
      delete exec.held
      if (callId && !exec.callId) exec.callId = callId
    } else {
      this.markHistoryUnsafe(`unrecorded-host-exec id=${id}`)
      this.state.attempt!.unrebuildable ??= "unrecorded-host-exec"
    }
    this.state.attempt!.unrepresentable = true
  }

  /**
   * Fork: a host tool call the provider made up (a mirrored display call, AskQuestion, SwitchMode, CreatePlan)
   * under its own exec id; its result must reach host history before a rebuild too.
   */
  recordHostCall(id: number, callId?: string): void {
    const execs = this.state.execs ??= []
    if (execs.some((exec) => exec.sessionId === this.sessionId && exec.id === id)) {
      this.markHistoryUnsafe(`repeated-exec-id id=${id}`)
      this.state.attempt!.unrebuildable ??= "repeated-exec-id"
    } else execs.push({ sessionId: this.sessionId, id, ...(callId ? { callId } : {}), host: true })
    this.state.attempt!.unrepresentable = true
  }

  /** Fork: the interrupted pass changed provider state that a history rebuild cannot carry. */
  recordUnrepresentable(why: string): void {
    this.state.attempt!.unrepresentable = true
    this.state.attempt!.unrebuildable ??= why
    trace(`replay: attempt not rebuildable from history (${why}) sessionId=${this.sessionId}`)
  }

  /** Fork: text the host shows, which a rebuilt step must continue rather than repeat. */
  recordShownText(text: string): void {
    this.state.attempt!.shownText = (this.state.attempt!.shownText ?? "") + text
  }

  /**
   * The provider answered this exec itself; nothing ran on the host.
   * Fork: a post-result rebuild cannot account for one in the interrupted pass. In a Run lost while the host runs
   * the pass's calls, the answer came before those calls' results, so `uncoveredExecs` judges it as an earlier one.
   */
  recordProviderAnswer(id: number, answer: ProviderAnswer): void {
    const exec = this.state.execs?.find(exec => exec.sessionId === this.sessionId && exec.id === id)
    if (exec) {
      exec.answer = answer
      delete exec.held
    }
    if (exec?.callId && OWNED_ANSWERS.has(answer)) {
      ((this.state.sinceCheckpoint ??= {}).ownedAnswers ??= []).push(`${this.sessionId}:${id}`)
    }
    this.state.attempt!.unrepresentable = true
  }

  /**
   * A `user_message_appended` update, with the Run's own injection it echoes. A stateful barrier
   * either way; only a matched echo leaves the history rebuild to the rebuild-time check.
   */
  recordAppendedMessage(injection: AppendedInjection | undefined): void {
    const appended = this.state.appendedInjections ??= []
    if (!injection || appended.length >= MAX_APPENDED_INJECTIONS) {
      this.mark("stateful-interaction", false, injection ? "too-many-appended-injections" : "unmatched-appended-message")
      return
    }
    appended.push(injection)
    // Fork: a Run lost while the host runs tools has no rebuild-time check, so it stays closed to rebuild.
    this.state.attempt!.unrebuildable ??= "appended-injection"
    trace(`recovery: appended-echo kind=${injection.kind} injectionId=${injection.injectionId} sessionId=${this.sessionId}`)
    this.mark("stateful-interaction", true, undefined, true)
  }

  private markHistoryUnsafe(cause: string): void {
    this.state.historyRebaseUnsafe = true
    trace(`recovery: history-unsafe cause=${cause} sessionId=${this.sessionId}`)
  }

  private mark(reason: ReplayBarrierReason, historyRepresentable: boolean, detail?: string, injectionEcho = false): void {
    if (!injectionEcho) this.otherBarrier = true
    if (!OUTPUT_ONLY_BARRIERS.has(reason)) {
      this.stateful = true
      this.state.statefulBarrier ??= reason
      if (!historyRepresentable) {
        this.markHistoryUnsafe(detail ? `${reason} ${detail}` : reason)
        this.state.attempt!.unrebuildable ??= reason
      }
      // Fork: an echo of the Run's own injection is left to the rebuild-time check (`appendedInjectionsInRebuild`).
      if (!injectionEcho && reason !== "non-control-exec" && reason !== "display-tool-lifecycle") {
        this.state.attempt!.unrepresentable = true
      }
    }
    if (this.barrierReason) return
    this.barrierReason = reason
    trace(`replay barrier: reason=${reason} sessionId=${this.sessionId}`)
  }

  applyTo(failure: CursorProviderError): CursorProviderError {
    failure.replaySafe = this.barrierReason === undefined && !this.stateful && failure.replaySafe
    if (this.barrierReason) {
      failure.replayBarrier = this.stateful ? "stateful" : "output-only"
      if (!this.otherBarrier) failure.replayBarrierEchoesOnly = true
      trace(
        `replay suppressed: reason=${this.barrierReason} barrier=${failure.replayBarrier} ` +
          `sessionId=${this.sessionId}`,
      )
    }
    return failure
  }
}

export type DecodedReplayFrame = {
  interactionUpdate?: Record<string, unknown>
  exec?: Record<string, unknown>
  kv?: Record<string, unknown>
  execControl?: Record<string, unknown>
  interactionQuery?: Record<string, unknown>
}

/**
 * Fork: `unverifiedCatalog` marks a frame failing `inlineCatalog` that is a catalog lookup, or whose tool call is too
 * malformed to tell. `wait` marks an AwaitShell call and nothing else (`awaitVariant`).
 */
export type ReplayToolLifecycle = {
  kind: "started" | "completed"; callId: string; catalog?: true; unverifiedCatalog?: true; wait?: true
}

// Cursor CLI 2026.11.11 `agent.v1`: AwaitArgs {task_id #1, block_until_ms #2, regex #3}; AwaitTaskStillRunning
// {task_id #1, runtime_ms #2, output_file_path #3, output_length #4, regex_requested #5, regex_match #6, wake_reason #7}.
// A timed-out wait carries neither regex_match nor wake_reason (none of 170 stored Await results had wake_reason).
const AWAIT_ARGS: Record<number, number> = { 1: 2, 2: 0, 3: 2 }
// output_length is an observation history lacks, but every timed-out wait has one, and a rebuild repeats nothing after it.
const AWAIT_STILL_RUNNING: Record<number, number> = { 1: 2, 2: 0, 3: 2, 4: 0, 5: 0 }

/** Fields only from `spec` (field number to wire type), each at most once, and every `required` one present. */
function strictFields(
  bytes: Uint8Array | undefined, spec: Record<number, number>, required: readonly number[] = [],
): StrictRawField[] | undefined {
  const fields = bytes && readAllFieldsStrict(bytes)
  return fields && fields.every(field => spec[field.fn] === field.wt)
    && Object.entries(spec).every(([fn, wt]) => optionalField(fields, Number(fn), wt))
    && required.every(fn => fields.some(field => field.fn === fn)) ? fields : undefined
}

/** The bytes of a message's only field, a length-delimited `fn`. */
function soleMessage(bytes: Uint8Array | undefined, fn: number): Uint8Array | undefined {
  const fields = bytes && readAllFieldsStrict(bytes)
  return fields?.length === 1 && fields[0]!.fn === fn && fields[0]!.wt === 2 ? fields[0]!.bytes : undefined
}

/**
 * Fork: the lifecycle's tool call is only `await_tool_call` #42 {args #1, result #2}, beside Cursor's call id and
 * timestamps: a start with its args alone, or a completion whose AwaitResult is `success` #4 holding `still_running` #2,
 * the shape of a wait that timed out. A finished task's `complete` carries its exit code, `error` what went wrong, and a
 * wake reason why the wait ended early; history holds none of them.
 */
function awaitVariant(topLevel: StrictRawField | undefined, completed: boolean): boolean {
  const update = nestedFields(topLevel, 1).find(field => field.fn === (completed ? 3 : 2))
  const call = update?.bytes && readAllFieldsStrict(update.bytes)?.find(field => field.fn === 2)
  const toolFields = call?.bytes && readAllFieldsStrict(call.bytes)
  if (!toolFields || !optionalField(toolFields, 57, 2)
    || !optionalField(toolFields, 59, 0) || !optionalField(toolFields, 60, 0)) return false
  const variants = toolFields.filter(field => ![57, 59, 60].includes(field.fn))
  if (variants.length !== 1 || variants[0]!.fn !== 42 || variants[0]!.wt !== 2) return false
  const wait = strictFields(variants[0]!.bytes, { 1: 2, 2: 2 })
  const args = wait?.find(field => field.fn === 1)
  // Every stored Await had task_id and every stored timed-out wait all four fields; Cursor CLI defaults a missing block_until_ms.
  if (!args || !strictFields(args.bytes, AWAIT_ARGS, [1])) return false
  const result = wait!.find(field => field.fn === 2)
  if (!completed || !result) return completed === !!result
  return !!strictFields(soleMessage(soleMessage(result.bytes, 4), 2), AWAIT_STILL_RUNNING, [1, 2, 3, 4])
}

function catalogVariant(topLevel: StrictRawField | undefined): boolean {
  const update = nestedFields(topLevel, 1).find(field => field.fn === 2 || field.fn === 3)
  const call = update?.bytes && readAllFieldsStrict(update.bytes)?.find(field => field.fn === 2)
  if (!call?.bytes) return false
  const toolFields = readAllFieldsStrict(call.bytes)
  return !toolFields || toolFields.some(field => field.fn === 44)
}

/** Validate the raw oneof and its nested fields; decoding alone drops unknown bytes. */
function inlineCatalog(topLevel: StrictRawField | undefined, completed: boolean): boolean {
  const update = nestedFields(topLevel, 1).find(field => field.fn === (completed ? 3 : 2))
  const lifecycle = update?.bytes && readAllFieldsStrict(update.bytes)
  const call = lifecycle && lifecycle.find(field => field.fn === 2)
  const toolFields = call?.bytes && readAllFieldsStrict(call.bytes)
  // Cursor CLI: tool_call_id #57, started_at_ms #59, completed_at_ms #60.
  if (!toolFields || !optionalField(toolFields, 57, 2)
    || !optionalField(toolFields, 59, 0) || !optionalField(toolFields, 60, 0)) return false
  const variants = toolFields.filter(field => ![57, 59, 60].includes(field.fn))
  if (variants.length !== 1 || variants[0]!.fn !== 44 || variants[0]!.wt !== 2) return false
  const catalog = variants[0]!.bytes && readAllFieldsStrict(variants[0]!.bytes!)
  if (!catalog || !catalog.every(field => [1, 2].includes(field.fn) && field.wt === 2)
    || ![1, 2].every(field => optionalField(catalog, field, 2))) return false
  const args = catalog.find(field => field.fn === 1)?.bytes
  const fields = args && readAllFieldsStrict(args)
  if (!fields || !fields.every(field => [1, 2, 3, 4].includes(field.fn) && field.wt === 2)
    || ![1, 2, 3, 4].every(field => optionalField(fields, field, 2))) return false
  const result = catalog.find(field => field.fn === 2)?.bytes
  if (!completed) return result === undefined
  const outcome = result && readAllFieldsStrict(result)
  if (!outcome || outcome.length !== 1 || outcome[0]!.fn !== 1 || outcome[0]!.wt !== 2) return false
  const success = outcome[0]!.bytes && readAllFieldsStrict(outcome[0]!.bytes!)
  return !!success && success.every(field => [1, 2].includes(field.fn) && field.wt === 2)
    && [1, 2].every(field => optionalField(success, field, 2))
    && success.some(field => field.fn === 1)
    && !success.some(field => field.fn === 2 && field.bytes?.length)
}

export type AppendedUserMessage = { messageId: string; text: string }

export type ReplayFrameAnalysis = {
  barrier?: ReplayBarrierReason
  /** Set for a well-formed lifecycle frame with a call id. */
  toolLifecycle?: ReplayToolLifecycle
  /** Set for an appended message shaped like the echo of a client injection. */
  appendedUserMessage?: AppendedUserMessage
}

const strictUtf8 = new TextDecoder("utf-8", { fatal: true })

// Cursor's echo of an injection carries, besides text #1 and message_id #2, a
// flag and two timestamps (#24–#26, varints) in a recorded 2026 frame; the
// shipped CLI descriptors this client follows predate them.
const APPENDED_ECHO_METADATA = [24, 25, 26]

/**
 * `UserMessageAppendedUpdate.user_message` holding only what a client
 * `user_context` injection sends (text #1 and message_id #2, each once) plus
 * Cursor's echo metadata. Anything else (selected context, mode, another
 * field) is not an echo of this client's own message. Call only on a frame
 * `validInteractionUpdateWire` accepted: update #6 then holds exactly one
 * length-delimited `user_message` #1.
 */
function appendedEcho(topLevel: StrictRawField | undefined): AppendedUserMessage | undefined {
  const update = nestedFields(topLevel, 1).find((field) => field.fn === 6)!
  const message = readAllFieldsStrict(readAllFieldsStrict(update.bytes!)![0]!.bytes!)
  if (!message
    || !message.every((field) => [1, 2].includes(field.fn) ? field.wt === 2 : APPENDED_ECHO_METADATA.includes(field.fn) && field.wt === 0)
    || ![1, 2, ...APPENDED_ECHO_METADATA].every((fn) => message.filter((field) => field.fn === fn).length <= 1)) return undefined
  const text = message.find((field) => field.fn === 1)?.bytes
  const id = message.find((field) => field.fn === 2)?.bytes
  if (!text?.length || !id?.length) return undefined
  try {
    return { messageId: strictUtf8.decode(id), text: strictUtf8.decode(text) }
  } catch {
    return undefined
  }
}

// Field numbers follow Cursor CLI 2026.09.28 `agent.v1`; the extracted
// agent.proto lags the live server.
// `InteractionUpdate` oneof members this client recognizes. Besides the
// declared ones: `thinking_completed` #5 (duration), `token_delta` #8 (count),
// `tool_call_delta` #15 (argument stream, like `partial_tool_call` #7),
// `context_injection_state` #23 (status of a client injection, which Cursor
// CLI only shows for queued steers), `routed_model` #24 (display name) and
// `tool_requests_listed` #27 (count) carry no output and no state. Other
// members stay barriers. `user_message_appended` #6 is recognized but stateful:
// the shipped CLI commits its pending turn and starts one from the user message.
// An echo of this client's own injection can still be rebuilt from host history.
const INTERACTION_UPDATE_FIELDS = new Set([1, 2, 3, 4, 5, 6, 7, 8, 13, 14, 15, 16, 17, 23, 24, 27])
/** `InteractionUpdate.message_started_at_ms` #25: a timestamp beside the oneof member. */
const INTERACTION_UPDATE_STARTED_AT = 25
const INTERACTION_QUERY_FIELDS = new Set([2, 3, 4, 7, 8, 9, 10, 11, 12, 13, 14])
const TOP_LEVEL_FIELDS = new Set([1, 2, 3, 4, 5, 7])
/** `AgentServerMessage.ttft_breakdown` #8: timing metrics beside the oneof member. */
const SERVER_MESSAGE_TTFT = 8

/** At most one occurrence of an optional field, with the expected wire type. */
function optionalField(fields: readonly StrictRawField[], fn: number, wt: number): boolean {
  const matches = fields.filter((field) => field.fn === fn)
  return matches.length <= 1 && matches.every((field) => field.wt === wt)
}

function nestedFields(topLevel: StrictRawField | undefined, field: number): StrictRawField[] {
  if (topLevel?.fn !== field || topLevel.wt !== 2 || !topLevel.bytes) return []
  return readAllFieldsStrict(topLevel.bytes) ?? []
}

function analyzeExecWire(topLevel: StrictRawField | undefined) {
  const fields = nestedFields(topLevel, 2)
  // accept_hook_additional_contexts #55 is metadata, not an execution variant.
  const metadataValid = optionalField(fields, 1, 0) && optionalField(fields, 15, 2)
    && optionalField(fields, 19, 2) && optionalField(fields, 55, 0)
  const variants = fields.filter((field) => ![1, 15, 19, 55].includes(field.fn))
  const exactVariant = (field: number): boolean =>
    metadataValid && variants.length === 1 && variants[0]!.fn === field && variants[0]!.wt === 2
  return {
    exactRequestContext: exactVariant(10),
    exactMcpState: exactVariant(36),
  }
}

// `KvServerMessage` = id #1, oneof get #2 / set #3, `span_context` #4 (tracing);
// Cursor sends the span on live KV requests.
function validKvWire(topLevel: StrictRawField | undefined): boolean {
  const fields = nestedFields(topLevel, 4)
  const spans = fields.filter((field) => field.fn === 4)
  if (spans.length > 1 || spans.some((field) => field.wt !== 2)) return false
  const variants = fields.filter((field) => field.fn !== 1 && field.fn !== 4)
  const variant = variants.length === 1 ? variants[0] : undefined
  const args = variant?.wt === 2 && variant.bytes
    ? (readAllFieldsStrict(variant.bytes) ?? [])
    : []
  const blobIds = args.filter(
    (field) => field.fn === 1 && field.wt === 2 && (field.bytes?.length ?? 0) > 0,
  )
  return !!variant
    && [2, 3].includes(variant.fn)
    && variant.wt === 2
    && blobIds.length === 1
    && args.every(
      (field) => field.wt === 2 && (field.fn === 1 || (variant.fn === 3 && field.fn === 2)),
    )
}

function validInteractionUpdateWire(
  topLevel: StrictRawField | undefined,
  decoded: Record<string, unknown> | undefined,
): boolean {
  if (!decoded) return true
  const all = nestedFields(topLevel, 1)
  if (!optionalField(all, INTERACTION_UPDATE_STARTED_AT, 0)) return false
  const fields = all.filter((field) => field.fn !== INTERACTION_UPDATE_STARTED_AT)
  const update = fields.length === 1 ? fields[0] : undefined
  if (!update || update.wt !== 2 || !INTERACTION_UPDATE_FIELDS.has(update.fn)) return false
  if (update.fn === 6) {
    const appended = update.bytes ? readAllFieldsStrict(update.bytes) : undefined
    return !!decoded.user_message_appended && appended?.length === 1
      && appended[0]!.fn === 1 && appended[0]!.wt === 2
  }
  if (update.fn === 2 || update.fn === 3) {
    // ToolCallStarted / ToolCallCompleted: call_id #1, tool_call #2,
    // model_call_id #3. A decoder can discard unknown or repeated fields;
    // those bytes must not authorize a history rebuild.
    const lifecycle = update.bytes ? readAllFieldsStrict(update.bytes) : undefined
    return !!lifecycle && lifecycle.every((field) => [1, 2, 3].includes(field.fn))
      && [1, 2, 3].every((field) => optionalField(lifecycle, field, 2))
  }
  if (![1, 4].includes(update.fn)) return true
  const delta = update.bytes ? (readAllFieldsStrict(update.bytes) ?? []) : []
  const text = delta.filter((field) => field.fn === 1)
  // #2 is `TextDeltaUpdate.is_server_notice` (bool) or
  // `ThinkingDeltaUpdate.thinking_style` (enum); both varints.
  const flag = delta.filter((field) => field.fn === 2)
  return text.length === 1 && text[0]!.wt === 2
    && optionalField(delta, 2, 0)
    && delta.length === text.length + flag.length
}

function validInteractionQueryWire(
  topLevel: StrictRawField | undefined,
  decoded: Record<string, unknown> | undefined,
): boolean {
  if (!decoded) return true
  const fields = nestedFields(topLevel, 7)
  const ids = fields.filter((field) => field.fn === 1)
  const variants = fields.filter((field) => field.fn !== 1)
  return ids.length <= 1
    && ids.every((field) => field.wt === 0)
    && variants.length === 1
    && variants[0]!.wt === 2
    && INTERACTION_QUERY_FIELDS.has(variants[0]!.fn)
}

function decodedMatchesWire(topLevel: StrictRawField | undefined, decoded: DecodedReplayFrame): boolean {
  return !(
    (topLevel?.fn === 1 && !decoded.interactionUpdate)
    || (topLevel?.fn === 2 && !decoded.exec)
    || (topLevel?.fn === 4 && !decoded.kv)
    || (topLevel?.fn === 5 && !decoded.execControl)
    || (topLevel?.fn === 7 && !decoded.interactionQuery)
  )
}

/**
 * Field numbers and wire types of a frame, nested three levels, without any
 * payload bytes: `1:2{16:2{1:0}}`. Compare it with `agent.proto` when a frame
 * is classified unknown.
 */
export function describeFrameLayout(payload: Uint8Array, depth = 3): string {
  const fields = readAllFieldsStrict(payload)
  if (!fields) return "?"
  return fields.map((field) => {
    const nested = depth > 1 && field.wt === 2 && field.bytes && field.bytes.length > 0
      ? readAllFieldsStrict(field.bytes)
      : undefined
    const inner = nested && nested.length > 0 ? `{${describeFrameLayout(field.bytes!, depth - 1)}}` : ""
    return `${field.fn}:${field.wt}${inner}`
  }).join(",")
}

/** Classify one decoded server frame without performing any protocol side effects. */
export function analyzeReplayFrame(
  payload: Uint8Array,
  decoded: DecodedReplayFrame,
): ReplayFrameAnalysis {
  const allTopLevel = readAllFieldsStrict(payload) ?? []
  const ttftValid = optionalField(allTopLevel, SERVER_MESSAGE_TTFT, 2)
  const topLevelFields = allTopLevel.filter((field) => field.fn !== SERVER_MESSAGE_TTFT)
  const topLevel = ttftValid && topLevelFields.length === 1 ? topLevelFields[0] : undefined
  const exec = analyzeExecWire(topLevel)
  const validKv = validKvWire(topLevel)
  const malformed = !topLevel
    || topLevel.wt !== 2
    || !TOP_LEVEL_FIELDS.has(topLevel.fn)
    || !validInteractionUpdateWire(topLevel, decoded.interactionUpdate)
    || !validInteractionQueryWire(topLevel, decoded.interactionQuery)
    || !decodedMatchesWire(topLevel, decoded)
    || !!decoded.execControl

  const started = decoded.interactionUpdate?.tool_call_started as Record<string, unknown> | undefined
  const completed = decoded.interactionUpdate?.tool_call_completed as Record<string, unknown> | undefined
  if (started || completed) {
    const callId = (started ?? completed)?.call_id
    return {
      barrier: "display-tool-lifecycle",
      ...(!malformed && typeof callId === "string" && callId.length > 0
        ? { toolLifecycle: { kind: started ? "started" : "completed", callId,
          ...(inlineCatalog(topLevel, !!completed) ? { catalog: true as const }
            : catalogVariant(topLevel) ? { unverifiedCatalog: true as const }
            : awaitVariant(topLevel, !!completed) ? { wait: true as const } : {}),
        } }
        : {}),
    }
  }
  let barrier: ReplayBarrierReason | undefined
  if (malformed || (topLevel.fn === 4 && !validKv)) {
    barrier = "unknown-or-malformed-frame"
  } else if (topLevel.fn === 1 && decoded.interactionUpdate?.user_message_appended) {
    const appendedUserMessage = appendedEcho(topLevel)
    return { barrier: "stateful-interaction", ...(appendedUserMessage ? { appendedUserMessage } : {}) }
  } else if (topLevel.fn === 2 && !exec.exactRequestContext && !exec.exactMcpState) {
    barrier = "non-control-exec"
  }

  return { barrier }
}
