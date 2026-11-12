import { describe, expect, it } from "bun:test"
import { CursorTransportError } from "../src/errors.js"
import {
  analyzeReplayFrame,
  announcedCallsClaimed,
  AttemptReplaySafety,
  describeFrameLayout,
  heldRunLossRebuildable,
  historyCoverage,
  hostExecs,
  markResumeCheckpoint,
  markRunInjectionDelivered,
  resumedReplaySafety,
  takeAppendedInjection,
  trackRunInjection,
  uncoveredExecs,
  type ProviderAnswer,
  type ReplaySafetyState,
  type RunInjection,
} from "../src/replay-safety.js"
import { decodeMessage, encodeMessage } from "../src/protocol/messages.js"

function varint(value: number): number[] {
  const out: number[] = []
  while (value > 0x7f) {
    out.push((value & 0x7f) | 0x80)
    value >>>= 7
  }
  out.push(value)
  return out
}

function lengthDelimited(field: number, bytes: Uint8Array = new Uint8Array()): number[] {
  return [...varint((field << 3) | 2), ...varint(bytes.length), ...bytes]
}

function kvFrame(...fields: number[][]): Uint8Array {
  return Uint8Array.from(lengthDelimited(4, Uint8Array.from(fields.flat())))
}

const id = [...varint(1 << 3), 7]
const getBlob = lengthDelimited(2, Uint8Array.from(lengthDelimited(1, new TextEncoder().encode("blob"))))
// `KvServerMessage.span_context` (#4): Cursor sends it on live KV requests.
const span = lengthDelimited(4, Uint8Array.from(lengthDelimited(1, new TextEncoder().encode("trace"))))
const kv = { id: 7, get_blob_args: { blob_id: new TextEncoder().encode("blob") } }

describe("inline catalog recovery", () => {
  const analyze = (completed: boolean, extra: number[] = [], spill = false, toolExtra: number[] = []) => {
    const args = lengthDelimited(1, new TextEncoder().encode("opencode"))
    const success = [...lengthDelimited(1, new TextEncoder().encode("tools")),
      ...(spill ? lengthDelimited(2, new TextEncoder().encode("/catalog.json")) : [])]
    const catalog = [...lengthDelimited(1, Uint8Array.from(args)),
      ...(completed ? lengthDelimited(2, Uint8Array.from(lengthDelimited(1, Uint8Array.from(success)))) : []), ...extra]
    const frame = updateFrame(completed ? 3 : 2, [
      ...lengthDelimited(1, new TextEncoder().encode("catalog")),
      ...lengthDelimited(2, Uint8Array.from([
        ...lengthDelimited(44, Uint8Array.from(catalog)),
        ...lengthDelimited(57, new TextEncoder().encode("catalog")),
        ...varint(59 << 3), 1,
        ...(completed ? [...varint(60 << 3), 2] : []),
        ...toolExtra,
      ])),
    ])
    const decoded = decodeMessage<{ interaction_update: Record<string, unknown> }>("AgentServerMessage", frame)
    return analyzeReplayFrame(frame, { interactionUpdate: decoded.interaction_update }).toolLifecycle
  }

  it("accounts for a completed read-only catalog but does not authorize a naked replay", () => {
    const state: ReplaySafetyState = {}
    const safety = new AttemptReplaySafety("run", state)
    safety.recordToolLifecycle(analyze(false))
    expect(announcedCallsClaimed(state)).toBe(false)
    safety.recordToolLifecycle(analyze(true))
    expect(state.historyRebaseUnsafe).toBeUndefined()
    expect(announcedCallsClaimed(state)).toBe(true)
    expect(safety.applyTo(new CursorTransportError("drop", { transient: true, replaySafe: true })).replaySafe).toBe(false)
  })

  it.each([
    ["unknown field", lengthDelimited(90), false],
    ["repeated args", lengthDelimited(1), false],
    ["spilled result", [], true],
  ] as const)("rejects a catalog completion with %s", (_name, extra, spill) => {
    const state: ReplaySafetyState = {}
    const safety = new AttemptReplaySafety("run", state)
    safety.recordToolLifecycle(analyze(false))
    const completion = analyze(true, [...extra], spill)
    expect(completion?.catalog).toBeUndefined()
    safety.recordToolLifecycle(completion)
    // Fork: an unexec'd completion waits for a bridge in the claim gate; nothing bridges a catalog lookup.
    expect(state.completedCalls).toEqual(["catalog"])
    expect(announcedCallsClaimed(state)).toBe(false)
  })

  it("does not let a rebuild leave out a catalog lookup the interrupted step started", () => {
    const state: ReplaySafetyState = {}
    const earlier = new AttemptReplaySafety("run", state)
    earlier.recordExec(1, "shell")
    const step = new AttemptReplaySafety("run", state)
    step.recordToolLifecycle(analyze(false))
    expect(state.attempt).toEqual({ announcedCalls: ["catalog"] })
    expect(announcedCallsClaimed(state, state.attempt!.announcedCalls)).toBe(false)
    step.recordToolLifecycle(analyze(true))
    expect(announcedCallsClaimed(state, state.attempt!.announcedCalls)).toBe(true)
  })

  it.each([
    ["unknown field", lengthDelimited(90), []],
    ["repeated args", lengthDelimited(1), []],
    ["a group field in the tool call", [], [...varint((90 << 3) | 3), ...varint((90 << 3) | 4)]],
  ] as const)("keeps a catalog start with %s from any rebuild", (_name, extra, toolExtra) => {
    const state: ReplaySafetyState = {}
    const step = new AttemptReplaySafety("run", state)
    const start = analyze(false, [...extra], false, [...toolExtra])
    expect(start).toEqual({ kind: "started", callId: "catalog", unverifiedCatalog: true })
    step.recordToolLifecycle(start)
    expect(state.historyRebaseUnsafe).toBe(true)
    expect(step.applyTo(new CursorTransportError("drop", { transient: true, replaySafe: true })).replayBarrier).toBe("stateful")
  })

  it("keeps blocking a lookup completed without its ToolCall, as after a resume", () => {
    const state: ReplaySafetyState = {}
    new AttemptReplaySafety("run-1", state).recordToolLifecycle(analyze(false))
    new AttemptReplaySafety("run-2", state).recordToolLifecycle({ kind: "completed", callId: "catalog" })
    expect(announcedCallsClaimed(state)).toBe(false)
  })

  it("does not count a lookup under a call id Cursor first used for something else", () => {
    const state: ReplaySafetyState = {}
    const safety = new AttemptReplaySafety("run", state)
    safety.recordToolLifecycle({ kind: "started", callId: "catalog" })
    safety.recordToolLifecycle({ kind: "completed", callId: "catalog" })
    safety.recordToolLifecycle(analyze(false))
    safety.recordToolLifecycle(analyze(true))
    expect(announcedCallsClaimed(state)).toBe(false)
  })

  it("requires the matching start and rejects duplicate starts", () => {
    const state: ReplaySafetyState = {}
    const safety = new AttemptReplaySafety("run", state)
    safety.recordToolLifecycle(analyze(true))
    expect(state.catalogCalls).toBeUndefined()
    expect(announcedCallsClaimed(state)).toBe(false)
    const duplicate: ReplaySafetyState = {}
    const other = new AttemptReplaySafety("run", duplicate)
    other.recordToolLifecycle(analyze(false))
    other.recordToolLifecycle(analyze(false))
    other.recordToolLifecycle(analyze(true))
    expect(duplicate.historyRebaseUnsafe).toBe(true)
  })

  it("does not discard mixed variants or malformed catalog metadata", () => {
    for (const extra of [lengthDelimited(15), lengthDelimited(90), lengthDelimited(59),
      [...varint(59 << 3), 3], lengthDelimited(57), [...varint(60 << 3), 3]]) {
      expect(analyze(true, [], false, extra)?.catalog).toBeUndefined()
    }
  })
})

describe("replay frame analysis", () => {
  it("treats a KV request with its span context as a control frame", () => {
    expect(analyzeReplayFrame(kvFrame(id, getBlob, span), { kv })).toEqual({ barrier: undefined })
    expect(analyzeReplayFrame(kvFrame(id, getBlob), { kv }).barrier).toBeUndefined()
  })

  it("keeps the barrier for unknown or repeated KV fields", () => {
    const unknown = [...varint((20 << 3) | 0), 1]
    expect(analyzeReplayFrame(kvFrame(id, getBlob, unknown), { kv }).barrier).toBe("unknown-or-malformed-frame")
    expect(analyzeReplayFrame(kvFrame(id, getBlob, span, span), { kv }).barrier).toBe("unknown-or-malformed-frame")
  })
})

function updateFrame(field: number, body: number[]): Uint8Array {
  return Uint8Array.from(lengthDelimited(1, Uint8Array.from(lengthDelimited(field, Uint8Array.from(body)))))
}

describe("interaction update analysis", () => {
  const text = lengthDelimited(1, new TextEncoder().encode("hm"))

  it("accepts Cursor's informational updates and styled thinking", () => {
    // thinking_completed{thinking_duration_ms} #5, token_delta{tokens} #8.
    expect(analyzeReplayFrame(updateFrame(5, [...varint(1 << 3), 42]), { interactionUpdate: {} }).barrier).toBeUndefined()
    expect(analyzeReplayFrame(updateFrame(8, [...varint(1 << 3), 3]), { interactionUpdate: {} }).barrier).toBeUndefined()
    // thinking_delta{text, thinking_style} #4.
    const styled = updateFrame(4, [...text, ...varint(2 << 3), 1])
    expect(analyzeReplayFrame(styled, { interactionUpdate: { thinking_delta: { text: "hm" } } }))
      .toEqual({ barrier: undefined })
  })

  it("keeps the barrier for undeclared updates and unknown delta fields", () => {
    // shell_output_delta #12 is not a member this client declares.
    expect(analyzeReplayFrame(updateFrame(12, text), { interactionUpdate: {} }).barrier).toBe("unknown-or-malformed-frame")
    const textWithUnknown = updateFrame(1, [...text, ...varint(3 << 3), 1])
    expect(analyzeReplayFrame(textWithUnknown, { interactionUpdate: { text_delta: { text: "hm" } } }).barrier)
      .toBe("unknown-or-malformed-frame")
    // A second top-level oneof member, or a repeated timing field, is not a frame this client knows.
    const twoMembers = Uint8Array.from([...updateFrame(13, []), ...lengthDelimited(4, Uint8Array.from(id))])
    expect(analyzeReplayFrame(twoMembers, { interactionUpdate: { heartbeat: {} } }).barrier).toBe("unknown-or-malformed-frame")
  })
})

describe("user-message-appended updates", () => {
  // Independent bytes from the shipped CLI descriptors: InteractionUpdate #6,
  // UserMessageAppendedUpdate.user_message #1, UserMessage text #1 / id #2 / mode #4.
  const userMessage = Uint8Array.of(0x0a, 0x02, 0x68, 0x69, 0x12, 0x02, 0x6d, 0x31, 0x20, 0x03)
  const appended = lengthDelimited(1, userMessage)
  const frame = updateFrame(6, appended)
  const decoded = decodeMessage<{ interaction_update: Record<string, unknown> }>("AgentServerMessage", frame)

  it("decodes the appended user message using the vendor field numbers", () => {
    expect(decoded).toMatchObject({ interaction_update: {
      user_message_appended: { user_message: { text: "hi", message_id: "m1", mode: 3 } },
    } })
  })

  it("recognizes a stateful update, including the timing field seen after injection", () => {
    expect(analyzeReplayFrame(frame, { interactionUpdate: decoded.interaction_update }).barrier)
      .toBe("stateful-interaction")
    const timed = Uint8Array.from(lengthDelimited(1, Uint8Array.from([
      ...lengthDelimited(6, Uint8Array.from(appended)), 0xc8, 0x01, 0x01,
    ])))
    expect(describeFrameLayout(timed)).toBe("1:2{6:2{1:2},25:0}")
    expect(analyzeReplayFrame(timed, { interactionUpdate: decoded.interaction_update }).barrier)
      .toBe("stateful-interaction")
  })

  it("keeps missing, repeated, unknown, or mistyped appended-message fields unknown", () => {
    for (const body of [[], [...appended, ...appended], lengthDelimited(2, userMessage), [0x08, 0x01]]) {
      expect(analyzeReplayFrame(updateFrame(6, body), { interactionUpdate: decoded.interaction_update }).barrier)
        .toBe("unknown-or-malformed-frame")
    }
    expect(analyzeReplayFrame(frame, { interactionUpdate: {} }).barrier).toBe("unknown-or-malformed-frame")
  })

  it("keeps mixed update members unknown", () => {
    const mixed = Uint8Array.from(lengthDelimited(1, Uint8Array.from([
      ...lengthDelimited(6, Uint8Array.from(appended)), ...lengthDelimited(13),
    ])))
    expect(analyzeReplayFrame(mixed, { interactionUpdate: decoded.interaction_update }).barrier)
      .toBe("unknown-or-malformed-frame")
  })
})

describe("echoes of the Run's own injections", () => {
  const utf8 = (text: string) => new TextEncoder().encode(text)
  // Independent bytes: UserMessage text #1, message_id #2, then the flag and two
  // timestamps (#24–#26, varints) a recorded echo of an injection carries.
  const metadata = [...varint(24 << 3), 1, ...varint(25 << 3), ...varint(1_791_275_000), ...varint(26 << 3), ...varint(1_791_275_001)]
  const userMessage = (text = "steer", messageId = "m-1", extra: number[] = metadata) =>
    [...lengthDelimited(1, utf8(text)), ...lengthDelimited(2, utf8(messageId)), ...extra]
  const echo = (body: number[]) => updateFrame(6, lengthDelimited(1, Uint8Array.from(body)))
  const analyze = (frame: Uint8Array) => analyzeReplayFrame(frame, {
    interactionUpdate: decodeMessage<{ interaction_update: Record<string, unknown> }>("AgentServerMessage", frame).interaction_update,
  })

  it("reads the message id and text of an echo, with or without Cursor's metadata", () => {
    expect(describeFrameLayout(echo(userMessage()), 4)).toBe("1:2{6:2{1:2{1:2,2:2,24:0,25:0,26:0}}}")
    for (const body of [userMessage(), userMessage("steer", "m-1", [])]) {
      expect(analyze(echo(body))).toEqual({
        barrier: "stateful-interaction", appendedUserMessage: { messageId: "m-1", text: "steer" },
      })
    }
  })

  it("does not read a message carrying anything an injection does not send", () => {
    for (const body of [
      [], // an empty user_message
      [...userMessage(), ...varint(4 << 3), 3], // mode
      [...userMessage(), ...lengthDelimited(3)], // selected_context
      [...userMessage(), ...lengthDelimited(1, utf8("again"))],
      [...userMessage(), ...varint(24 << 3), 0],
      [...lengthDelimited(1, utf8("steer")), ...lengthDelimited(2, utf8("m-1")), ...lengthDelimited(24)],
      [...lengthDelimited(1, utf8("steer")), ...metadata],
      [...lengthDelimited(2, utf8("m-1")), ...metadata],
      [...lengthDelimited(1, Uint8Array.of(0xff)), ...lengthDelimited(2, utf8("m-1"))],
    ]) {
      const result = analyze(echo(body))
      expect(result.barrier).toBe("stateful-interaction")
      expect(result.appendedUserMessage).toBeUndefined()
    }
  })

  it("matches a delivered injection once, by message id and text", () => {
    const injections: RunInjection[] = []
    trackRunInjection(injections, { kind: "note", injectionId: "i-1", messageId: "m-1", text: "note", notes: ["<system-update>note</system-update>"] })
    trackRunInjection(injections, { kind: "steer", injectionId: "i-2", messageId: "m-2", text: "steer" })
    expect(takeAppendedInjection(injections, { messageId: "m-2", text: "steer" })).toBeUndefined()
    markRunInjectionDelivered(injections, "i-2")
    expect(takeAppendedInjection(injections, { messageId: "m-2", text: "other" })).toBeUndefined()
    expect(takeAppendedInjection(injections, { messageId: "m-3", text: "steer" })).toBeUndefined()
    expect(takeAppendedInjection(injections, { messageId: "m-2", text: "steer" })).toEqual({ kind: "steer", injectionId: "i-2" })
    expect(takeAppendedInjection(injections, { messageId: "m-2", text: "steer" })).toBeUndefined()
    markRunInjectionDelivered(injections, "i-1")
    expect(takeAppendedInjection(injections, { messageId: "m-1", text: "note" }))
      .toEqual({ kind: "note", injectionId: "i-1", notes: ["<system-update>note</system-update>"] })
  })

  it("keeps a matched echo a stateful barrier that leaves the rebuild to its history check", () => {
    const failure = () => new CursorTransportError("drop", { transient: true, replaySafe: true })
    const state: ReplaySafetyState = {}
    const safety = new AttemptReplaySafety("run-1", state)
    safety.recordAppendedMessage({ kind: "steer", injectionId: "i-1" })
    expect(safety.applyTo(failure())).toMatchObject({ replaySafe: false, replayBarrier: "stateful", replayBarrierEchoesOnly: true })
    // Fork: the pass stays rebuildable from history, not from a lost held Run.
    expect(state).toEqual({
      statefulBarrier: "stateful-interaction",
      appendedInjections: [{ kind: "steer", injectionId: "i-1" }],
      attempt: { unrebuildable: "appended-injection" },
    })

    safety.recordAppendedMessage(undefined)
    expect(state.historyRebaseUnsafe).toBe(true)
    expect(safety.applyTo(failure()).replayBarrierEchoesOnly).toBeUndefined()
  })

  it("leaves no echo-only exemption to an attempt with other activity", () => {
    for (const other of [
      (safety: AttemptReplaySafety) => safety.markBarrier("visible-text"),
      (safety: AttemptReplaySafety) => safety.markBarrier("non-control-exec"),
    ]) {
      const safety = new AttemptReplaySafety("run-1", {})
      safety.recordAppendedMessage({ kind: "note", injectionId: "i-1", notes: ["note"] })
      other(safety)
      expect(safety.applyTo(new CursorTransportError("drop", { transient: true, replaySafe: true })))
        .toMatchObject({ replayBarrier: "stateful", replaySafe: false })
      expect(safety.applyTo(new CursorTransportError("drop", { transient: true, replaySafe: true })).replayBarrierEchoesOnly)
        .toBeUndefined()
    }
  })
})

describe("display tool lifecycle", () => {
  // Independent bytes from the shipped CLI descriptors: InteractionUpdate
  // tool_call_started #2 / tool_call_completed #3; both updates carry call_id #1.
  const lifecycleFrame = (field: 2 | 3, callId?: string) =>
    updateFrame(field, callId === undefined ? [] : lengthDelimited(1, new TextEncoder().encode(callId)))
  const analyze = (field: 2 | 3, callId?: string) => {
    const frame = lifecycleFrame(field, callId)
    const decoded = decodeMessage<{ interaction_update: Record<string, unknown> }>("AgentServerMessage", frame)
    return analyzeReplayFrame(frame, { interactionUpdate: decoded.interaction_update })
  }
  const failure = () => new CursorTransportError("Cursor Run transport interrupted", { transient: true, replaySafe: true })

  it("correlates started and completed frames by call id", () => {
    expect(analyze(2, "call-1")).toEqual({
      barrier: "display-tool-lifecycle", toolLifecycle: { kind: "started", callId: "call-1" },
    })
    expect(analyze(3, "call-1")).toEqual({
      barrier: "display-tool-lifecycle", toolLifecycle: { kind: "completed", callId: "call-1" },
    })
  })

  it("does not correlate a frame without a call id or with another member", () => {
    expect(analyze(2)).toEqual({ barrier: "display-tool-lifecycle" })
    const frame = lifecycleFrame(2, "call-1")
    const decoded = decodeMessage<{ interaction_update: Record<string, unknown> }>("AgentServerMessage", frame)
    const mixed = Uint8Array.from(lengthDelimited(1, Uint8Array.from([
      ...lengthDelimited(2, Uint8Array.from(lengthDelimited(1, new TextEncoder().encode("call-1")))),
      ...lengthDelimited(13),
    ])))
    expect(analyzeReplayFrame(mixed, { interactionUpdate: decoded.interaction_update }))
      .toEqual({ barrier: "display-tool-lifecycle" })
  })

  it("lets history represent a call its host exec claimed", () => {
    const state: ReplaySafetyState = {}
    const toolStep = new AttemptReplaySafety("run-1", state)
    toolStep.recordToolLifecycle(analyze(2, "call-1").toolLifecycle)
    expect(announcedCallsClaimed(state)).toBe(false)
    toolStep.markBarrier("non-control-exec")
    toolStep.recordExec(1, "call-1")
    expect(toolStep.applyTo(failure())).toMatchObject({ replaySafe: false, replayBarrier: "stateful" })
    expect(state.historyRebaseUnsafe).toBeUndefined()
    expect(announcedCallsClaimed(state)).toBe(true)

    // The completion Cursor sends after the delivered result marks nothing.
    const continuation = new AttemptReplaySafety("run-1", state)
    continuation.recordToolLifecycle(analyze(3, "call-1").toolLifecycle)
    const continued = continuation.applyTo(failure())
    expect(continued.replayBarrier).toBeUndefined()
    expect(continued.replaySafe).toBe(false)
    expect(state.historyRebaseUnsafe).toBeUndefined()
  })

  it("retains a preceding Run's display claim across resume", () => {
    const state: ReplaySafetyState = {}
    const previous = new AttemptReplaySafety("run-1", state)
    previous.recordToolLifecycle(analyze(2, "call-1").toolLifecycle)
    previous.markBarrier("non-control-exec")
    previous.recordExec(1, "call-1")
    previous.recordToolLifecycle(analyze(3, "call-1").toolLifecycle)

    const resumed = new AttemptReplaySafety("run-2", state)
    resumed.recordToolLifecycle(analyze(3, "call-1").toolLifecycle)
    expect(state.historyRebaseUnsafe).toBeUndefined()
    expect(announcedCallsClaimed(state)).toBe(true)
    expect(resumed.applyTo(failure()).replayBarrier).toBeUndefined()
  })

  it("keeps malformed nested lifecycle fields from claiming completed work", () => {
    const callId = lengthDelimited(1, new TextEncoder().encode("call-1"))
    for (const body of [
      [...callId, ...callId],
      [...callId, ...lengthDelimited(99)],
      [...callId, ...varint(3 << 3), 0],
    ]) {
      const frame = updateFrame(3, body)
      const decoded = decodeMessage<{ interaction_update: Record<string, unknown> }>("AgentServerMessage", frame)
      expect(analyzeReplayFrame(frame, { interactionUpdate: decoded.interaction_update }))
        .toEqual({ barrier: "display-tool-lifecycle" })
    }
  })

  it("keeps blocking calls no host exec claimed and unknown lifecycle frames", () => {
    const cursorRun: ReplaySafetyState = {}
    const run = new AttemptReplaySafety("run-1", cursorRun)
    run.recordToolLifecycle(analyze(2, "web-1").toolLifecycle)
    expect(announcedCallsClaimed(cursorRun)).toBe(false)
    run.recordToolLifecycle(analyze(3, "web-1").toolLifecycle)
    // Fork: a completion no exec claimed blocks through the claim check, which only a bridge satisfies.
    expect(announcedCallsClaimed(cursorRun)).toBe(false)
    expect(run.applyTo(failure()).replayBarrier).toBe("stateful")

    const unknown: ReplaySafetyState = {}
    const unknownRun = new AttemptReplaySafety("run-1", unknown)
    unknownRun.recordToolLifecycle(analyze(3, "never-started").toolLifecycle)
    expect(announcedCallsClaimed(unknown)).toBe(false)
    expect(unknownRun.applyTo(failure()).replayBarrier).toBe("stateful")

    for (const record of [
      (safety: AttemptReplaySafety) => safety.recordToolLifecycle(analyze(2).toolLifecycle),
      (safety: AttemptReplaySafety) => {
        safety.recordExec(1, "call-1")
        safety.recordToolLifecycle(analyze(2, "call-1").toolLifecycle)
      },
    ]) {
      const state: ReplaySafetyState = {}
      const safety = new AttemptReplaySafety("run-1", state)
      record(safety)
      expect(state.historyRebaseUnsafe).toBe(true)
      expect(safety.applyTo(failure()).replayBarrier).toBe("stateful")
    }
  })

  it("lets a rebuild leave out calls the interrupted step announced but nothing ran", () => {
    const state: ReplaySafetyState = {}
    const earlier = new AttemptReplaySafety("run-1", state)
    earlier.recordToolLifecycle(analyze(2, "earlier").toolLifecycle)
    const step = new AttemptReplaySafety("run-1", state)
    step.recordToolLifecycle(analyze(2, "next-edit").toolLifecycle)
    expect(state.attempt).toEqual({ announcedCalls: ["next-edit"] })
    // An earlier step's call might be one Cursor ran itself.
    expect(announcedCallsClaimed(state, state.attempt!.announcedCalls)).toBe(false)

    const fresh: ReplaySafetyState = {}
    const only = new AttemptReplaySafety("run-1", fresh)
    only.recordToolLifecycle(analyze(2, "next-edit").toolLifecycle)
    expect(announcedCallsClaimed(fresh)).toBe(false)
    expect(announcedCallsClaimed(fresh, fresh.attempt!.announcedCalls)).toBe(true)
    // Cursor completed it, so it ran on Cursor's side and history lacks it.
    only.recordToolLifecycle(analyze(3, "next-edit").toolLifecycle)
    expect(announcedCallsClaimed(fresh, fresh.attempt!.announcedCalls)).toBe(false)
  })

  it("leaves history nothing to hold for an AwaitShell Cursor ran, but not for a call beside it", () => {
    // Cursor CLI 2026.11.11: ToolCall await_tool_call #42 { args #1 { task_id #1, block_until_ms #2, regex #3 },
    // result #2 AwaitResult { complete #1, still_running #2, error #3, success #4 { complete #1, still_running #2 } } }.
    const text = (value: string) => new TextEncoder().encode(value)
    const message = (fn: number, ...fields: number[][]) => lengthDelimited(fn, Uint8Array.from(fields.flat()))
    const number = (fn: number, value: number) => [...varint(fn << 3), ...varint(value)]
    const args = message(1, lengthDelimited(1, text("545432")), number(2, 1_800_000))
    // A timed-out wait as Cursor stores it: success { still_running { task_id, runtime_ms, output_file_path, output_length } }.
    const running = (...extra: number[][]) => message(2, lengthDelimited(1, text("545432")), number(2, 1_800_000),
      lengthDelimited(3, text("/terminals/545432.txt")), number(4, 812), ...extra)
    const success = (...fields: number[][]) => message(2, message(4, ...fields))
    const wait = (...fields: number[][]) => message(42, ...fields)
    const fetch = message(37, message(1, lengthDelimited(1, text("https://example.com"))))
    const analyzeTool = (field: 2 | 3, callId: string, tool: number[]) => {
      const frame = updateFrame(field, [...lengthDelimited(1, text(callId)), ...lengthDelimited(2, Uint8Array.from(tool))])
      let decoded: { interaction_update?: Record<string, unknown> }
      try {
        decoded = decodeMessage<{ interaction_update: Record<string, unknown> }>("AgentServerMessage", frame)
      } catch {
        // The decoder already refuses a wrong wire type on a field the schema declares; the pump fails the Run on it.
        decoded = {}
      }
      return analyzeReplayFrame(frame, { interactionUpdate: decoded.interaction_update })
    }
    const timedOut = wait(args, success(running()))
    expect(analyzeTool(2, "wait", wait(args)).toolLifecycle).toEqual({ kind: "started", callId: "wait", wait: true })
    expect(analyzeTool(3, "wait", timedOut).toolLifecycle).toEqual({ kind: "completed", callId: "wait", wait: true })
    // A wait for a pattern that never appeared.
    expect(analyzeTool(3, "wait", wait(args, success(running(number(5, 1))))).toolLifecycle)
      .toEqual({ kind: "completed", callId: "wait", wait: true })
    // Fails closed: a frame beside the wait, history short of what the wait returned, or bytes the schema lacks.
    for (const [why, field, tool] of [
      ["call beside it", 3, [...timedOut, ...fetch]],
      ["started with a result", 2, timedOut],
      ["completed without a result", 3, wait(args)],
      ["still running outside success", 3, wait(args, message(2, running()))],
      ["finished task", 3, wait(args, success(message(1, lengthDelimited(1, text("545432")), number(7, 0))))],
      ["finished task outside success", 3, wait(args, message(2, message(1, lengthDelimited(1, text("545432")))))],
      ["error", 3, wait(args, message(2, message(3, lengthDelimited(1, text("no such task")))))],
      ["matched output", 3, wait(args, success(running(number(5, 1), lengthDelimited(6, text("BUILD OK")))))],
      ["wake reason regex_match", 3, wait(args, success(running(number(5, 1), lengthDelimited(7, text("regex_match")))))],
      ["wake reason timeout", 3, wait(args, success(running(lengthDelimited(7, text("timeout")))))],
      ["unknown wake reason", 3, wait(args, success(running(lengthDelimited(7, text("shell_exit")))))],
      ["unknown await field", 3, wait(args, success(running()), lengthDelimited(99, text("x")))],
      ["unknown args field", 2, wait(message(1, lengthDelimited(1, text("545432")), number(9, 1)))],
      ["unknown result field", 3, wait(args, success(running(lengthDelimited(99, text("x")))))],
      ["two results", 3, wait(args, message(2, message(4, running(), running())))],
      ["repeated args", 2, wait(args, args)],
      ["repeated task id", 2, wait(message(1, lengthDelimited(1, text("545432")), lengthDelimited(1, text("1"))))],
      ["repeated output length", 3, wait(args, success(running(number(4, 900))))],
      ["block_until_ms as bytes", 2, wait(message(1, lengthDelimited(1, text("545432")), lengthDelimited(2, text("1"))))],
      ["result as varint", 3, wait(args, number(2, 1))],
      ["output length as bytes", 3, wait(args, success(message(2, lengthDelimited(1, text("545432")), lengthDelimited(4, text("8")))))],
    ] as const) {
      expect([why, analyzeTool(field, "other", [...tool]).toolLifecycle?.wait]).toEqual([why, undefined])
    }

    const state: ReplaySafetyState = {}
    const earlier = new AttemptReplaySafety("run-1", state)
    earlier.recordToolLifecycle(analyzeTool(2, "wait", wait(args)).toolLifecycle)
    earlier.recordToolLifecycle(analyzeTool(3, "wait", timedOut).toolLifecycle)
    expect(state.announcedCalls).toBeUndefined()
    expect(state.completedCalls).toBeUndefined()
    expect(earlier.applyTo(failure())).toMatchObject({ replaySafe: false, replayBarrier: "stateful" })
    const step = new AttemptReplaySafety("run-1", state)
    expect(heldRunLossRebuildable(state)).toBe(true)
    step.recordToolLifecycle(analyzeTool(2, "unknown", wait(args)).toolLifecycle)
    step.recordToolLifecycle(analyzeTool(3, "unknown", wait(args, success(running(lengthDelimited(7, text("regex_match")))))).toolLifecycle)
    expect(heldRunLossRebuildable(state)).toBe(false)
  })

  it("lets a host exec that names no call claim the display call it serves", () => {
    const state: ReplaySafetyState = {}
    const image = new AttemptReplaySafety("run-1", state)
    image.recordToolLifecycle({ kind: "started", callId: "gen" })
    image.recordExec(1)
    image.recordHostExec(1, "gen")
    image.recordToolLifecycle({ kind: "completed", callId: "gen" })
    const step = new AttemptReplaySafety("run-1", state)
    step.recordToolLifecycle({ kind: "started", callId: "task" })
    step.recordExec(2, "task")
    step.recordHostExec(2)
    expect(state.completedCalls).toBeUndefined()
    expect(heldRunLossRebuildable(state)).toBe(true)
    // An exec that names its own call keeps it.
    step.recordToolLifecycle({ kind: "started", callId: "own" })
    step.recordExec(3, "edit")
    step.recordHostExec(3, "own")
    expect(state.execs?.find((exec) => exec.id === 3)?.callId).toBe("edit")
  })

  it("tells host execs from execs the provider answered, per attempt", () => {
    const state: ReplaySafetyState = {}
    const step = new AttemptReplaySafety("run-1", state)
    step.markBarrier("non-control-exec")
    step.recordExec(1, "read-1")
    step.markBarrier("visible-text")
    step.recordShownText("Reading the file.")
    expect(state.attempt).toEqual({ shownText: "Reading the file." })
    expect(hostExecs(state)).toEqual([])

    step.markBarrier("non-control-exec")
    step.recordExec(2, "shell-1")
    step.recordHostExec(2)
    expect(hostExecs(state)).toEqual([{ sessionId: "run-1", id: 2, callId: "shell-1", host: true }])
    expect(state.attempt?.unrepresentable).toBe(true)

    // The next pass starts clean; the Run-wide record stays.
    new AttemptReplaySafety("run-1", state)
    expect(state.attempt).toEqual({})
    expect(hostExecs(state)).toHaveLength(1)
    expect(state.statefulBarrier).toBe("non-control-exec")
  })

  it("owes no host result for terminal reads and refusals, but refuses them in the interrupted pass", () => {
    const state: ReplaySafetyState = {}
    const step = new AttemptReplaySafety("run-1", state)
    step.recordExec(1, "shell-1")
    step.recordHostExec(1)
    step.recordExec(2)
    step.recordProviderAnswer(2, "terminal-read")
    step.recordExec(3, "grep-1")
    step.recordProviderAnswer(3, "refusal")
    step.recordExec(4)
    expect(uncoveredExecs(state, new Set()).map(exec => exec.id)).toEqual([1, 4])
    expect(historyCoverage(state, new Set(["run-1:1", "run-1:4"]))).toEqual({
      hostExecs: 2, answers: { "terminal-read": 1, refusal: 1 }, complete: true,
    })
    expect(state.attempt?.unrepresentable).toBe(true)

    const next = new AttemptReplaySafety("run-1", state)
    next.recordExec(5)
    expect(state.attempt?.unrepresentable).toBeUndefined()
    next.recordProviderAnswer(5, "terminal-read")
    expect(state.attempt?.unrepresentable).toBe(true)
    expect(uncoveredExecs(state, new Set()).map(exec => exec.id)).toEqual([1, 4])
  })

  it("names the execs history is short of as historyCoverage judges them", () => {
    const state: ReplaySafetyState = {}
    const step = new AttemptReplaySafety("run-1", state)
    step.recordExec(1, "edit-1")
    step.recordProviderAnswer(1, "edit-handshake")
    step.recordExec(2, "edit-1")
    step.recordHostExec(2)
    step.recordExec(3, "task-1")
    step.recordProviderAnswer(3, "task-attachment")
    step.recordExec(4, "task-1")
    step.recordHostExec(4)
    step.recordExec(5)
    step.recordProviderAnswer(5, "missing-read")
    step.recordExec(6)
    step.recordProviderAnswer(6, "edit-handshake")
    for (const completed of [new Set<string>(), new Set(["run-1:2"]), new Set(["run-1:2", "run-1:4"])]) {
      const uncovered = uncoveredExecs(state, completed)
      expect(historyCoverage(state, completed).complete).toBe(uncovered.length === 0)
    }
    expect(uncoveredExecs(state, new Set()).map(exec => exec.id)).toEqual([1, 2, 3, 4, 6])
    expect(uncoveredExecs(state, new Set(["run-1:2", "run-1:4"])).map(exec => exec.id)).toEqual([6])
    // A refusal under the same call is no owner.
    const other: ReplaySafetyState = {}
    const pass = new AttemptReplaySafety("run-1", other)
    pass.recordExec(1, "edit-1")
    pass.recordProviderAnswer(1, "edit-handshake")
    pass.recordExec(2, "edit-1")
    pass.recordProviderAnswer(2, "refusal")
    expect(uncoveredExecs(other, new Set(["run-1:2"])).map(exec => exec.id)).toEqual([1])
  })

  it("leaves the answers of a Run lost while the host runs the pass's calls to the coverage rule", () => {
    const state: ReplaySafetyState = {}
    const step = new AttemptReplaySafety("run-1", state)
    for (const [id, answer] of [[1, "edit-handshake"], [2, "task-attachment"], [3, "missing-read"], [4, "terminal-read"], [5, "refusal"]] as const) {
      step.recordExec(id, `call-${id}`)
      step.recordProviderAnswer(id, answer)
    }
    expect(state.attempt).toEqual({ unrepresentable: true })
    expect(uncoveredExecs(state, new Set()).map(exec => exec.id)).toEqual([1, 2])
  })

  it("leaves out an exec step order still holds, but not one it released", () => {
    const state: ReplaySafetyState = {}
    const step = new AttemptReplaySafety("run-1", state)
    step.recordExec(1, "first")
    step.recordHostExec(1)
    for (const id of [2, 3, 4, 5]) {
      step.recordExec(id, `call-${id}`)
      step.recordHeldExec(id)
    }
    expect(uncoveredExecs(state, new Set(["run-1:1"]))).toEqual([])
    expect(uncoveredExecs(state, new Set()).map(exec => exec.id)).toEqual([1])

    const next = new AttemptReplaySafety("run-1", state)
    next.recordReleasedExec(2)
    next.recordHostExec(2)
    // A held call cancelled behind a refused change is refused without a release.
    next.recordProviderAnswer(3, "refusal")
    next.recordReleasedExec(4)
    next.recordProviderAnswer(4, "edit-handshake")
    next.recordHeldExec(2)
    expect(state.execs?.filter(exec => exec.held).map(exec => exec.id)).toEqual([5])
    expect(uncoveredExecs(state, new Set(["run-1:1"])).map(exec => exec.id)).toEqual([2, 4])
    expect(uncoveredExecs(state, new Set(["run-1:1", "run-1:2"])).map(exec => exec.id)).toEqual([4])
  })

  it("carries into a resumed Run only the calls past its checkpoint something besides the provider ran", () => {
    const state: ReplaySafetyState = {}
    const answer = (pass: AttemptReplaySafety, id: number, callId: string, kind: ProviderAnswer = "edit-handshake") => {
      pass.recordExec(id, callId)
      pass.recordProviderAnswer(id, kind)
    }
    const first = new AttemptReplaySafety("run-1", state)
    first.recordToolLifecycle({ kind: "started", callId: "edit-held" })
    answer(first, 1, "edit-held")
    first.recordToolLifecycle({ kind: "started", callId: "edit-announced" })
    markResumeCheckpoint(state)
    first.recordToolLifecycle({ kind: "started", callId: "edit-split" })
    first.recordToolLifecycle({ kind: "started", callId: "edit-ran" })
    answer(first, 2, "edit-ran")
    first.recordExec(3, "edit-ran")
    first.recordHostExec(3)
    const cut = new AttemptReplaySafety("run-1", state)
    answer(cut, 4, "edit-split")
    answer(cut, 5, "edit-announced")
    cut.recordToolLifecycle({ kind: "started", callId: "task-begun" })
    answer(cut, 6, "task-begun", "task-attachment")
    answer(cut, 7, "edit-unannounced")
    const resumed = resumedReplaySafety(state)
    expect(resumed.execs?.map(exec => exec.id)).toEqual([1, 2, 3, 5])
    expect(resumed.announcedCalls).toEqual(["edit-held", "edit-announced", "edit-ran"])
    expect(resumed.sinceCheckpoint).toBeUndefined()
    expect(uncoveredExecs(resumed, new Set(["run-1:3"])).map(exec => exec.id)).toEqual([1, 5])
    expect(state.execs?.map(exec => exec.id)).toEqual([1, 2, 3, 4, 5, 6, 7])
  })

  it("marks only the attempt for provider state a rebuild cannot carry", () => {
    const state: ReplaySafetyState = {}
    new AttemptReplaySafety("run-1", state).recordUnrepresentable("background-shell-end-read")
    expect(state.attempt?.unrepresentable).toBe(true)
    expect(state.historyRebaseUnsafe).toBeUndefined()
    new AttemptReplaySafety("run-1", state)
    expect(state.attempt).toEqual({})
  })

  it("records the provider's own host calls under their exec ids", () => {
    const state: ReplaySafetyState = {}
    const step = new AttemptReplaySafety("run-1", state)
    step.claimBridgedCall("todo-1")
    step.recordHostCall(900_000, "todo-1")
    step.recordHostCall(900_001)
    expect(hostExecs(state)).toEqual([
      { sessionId: "run-1", id: 900_000, callId: "todo-1", host: true },
      { sessionId: "run-1", id: 900_001, host: true },
    ])
    expect(state.attempt?.unrepresentable).toBe(true)
    step.recordHostCall(900_001)
    expect(state.historyRebaseUnsafe).toBe(true)
  })

  it("marks an attempt unrepresentable for bridges, stateful interactions, unknown frames and unrecorded host execs", () => {
    const cases: Array<[string, (safety: AttemptReplaySafety) => void, boolean]> = [
      ["bridge", (safety) => safety.claimBridgedCall("todo-1"), false],
      ["unknown frame", (safety) => safety.markBarrier("unknown-or-malformed-frame"), true],
      ["appended user message", (safety) => safety.markBarrier("stateful-interaction"), true],
      ["unrecorded host exec", (safety) => safety.recordHostExec(7), true],
    ]
    for (const [, record, unsafe] of cases) {
      const state: ReplaySafetyState = {}
      record(new AttemptReplaySafety("run-1", state))
      expect(state.attempt?.unrepresentable).toBe(true)
      expect(state.historyRebaseUnsafe).toBe(unsafe ? true : undefined)
    }
    const output: ReplaySafetyState = {}
    const shown = new AttemptReplaySafety("run-1", output)
    for (const reason of ["visible-text", "visible-reasoning", "visible-tool-row", "non-control-exec"] as const) shown.markBarrier(reason)
    shown.recordToolLifecycle(analyze(2, "call-1").toolLifecycle)
    expect(output.attempt?.unrepresentable).toBeUndefined()
  })
})

describe("history coverage of provider answers", () => {
  // `sessionId:execId` of each host result the rebuilt prompt holds.
  const run = (record: (safety: AttemptReplaySafety) => void, sessionId = "run-1", state: ReplaySafetyState = {}) => {
    record(new AttemptReplaySafety(sessionId, state))
    return state
  }

  it("needs a result for every exec the host ran", () => {
    const state = run((safety) => { safety.recordExec(1, "a"); safety.recordExec(2, "b") })
    expect(historyCoverage(state, new Set(["run-1:1", "run-1:2"]))).toEqual({ hostExecs: 2, answers: {}, complete: true })
    expect(historyCoverage(state, new Set(["run-1:1"])).complete).toBe(false)
    expect(historyCoverage(undefined, new Set())).toEqual({ hostExecs: 0, answers: {}, complete: true })
  })

  it("needs no result for terminal-record and missing-target reads", () => {
    const state = run((safety) => {
      safety.recordExec(1, "shell")
      safety.recordExec(50, "poll")
      safety.recordProviderAnswer(50, "terminal-read")
      safety.recordExec(60)
      safety.recordProviderAnswer(60, "missing-read")
    })
    expect(historyCoverage(state, new Set(["run-1:1"]))).toEqual({
      hostExecs: 1, answers: { "terminal-read": 1, "missing-read": 1 }, complete: true,
    })
  })

  for (const answer of ["edit-handshake", "task-attachment"] as const) {
    it(`needs the host result of the call a ${answer} read belongs to`, () => {
      const state = run((safety) => {
        safety.recordExec(61, "call")
        safety.recordProviderAnswer(61, answer)
        safety.recordExec(2, "call")
      })
      expect(historyCoverage(state, new Set(["run-1:2"]))).toEqual({ hostExecs: 1, answers: { [answer]: 1 }, complete: true })
      // The call's own exec has no result in history.
      expect(historyCoverage(state, new Set(["run-1:9"])).complete).toBe(false)

      // No host exec of that call: its write or Task never reached the host.
      const unowned = run((safety) => {
        safety.recordExec(1, "other")
        safety.recordExec(61, "call")
        safety.recordProviderAnswer(61, answer)
      })
      expect(historyCoverage(unowned, new Set(["run-1:1"])).complete).toBe(false)

      // Without a call id nothing can own it, and another answer of the same call is no owner.
      const uncorrelated = run((safety) => {
        safety.recordExec(1, "other")
        safety.recordExec(61)
        safety.recordProviderAnswer(61, answer)
      })
      expect(historyCoverage(uncorrelated, new Set(["run-1:1"])).complete).toBe(false)
      const answeredOwner = run((safety) => {
        safety.recordExec(1, "other")
        safety.recordExec(61, "call")
        safety.recordProviderAnswer(61, answer)
        safety.recordExec(62, "call")
        safety.recordProviderAnswer(62, "missing-read")
      })
      expect(historyCoverage(answeredOwner, new Set(["run-1:1"])).complete).toBe(false)
    })
  }

  it("matches an owner on a resumed Run by call id", () => {
    const state = run((safety) => {
      safety.recordExec(61, "call")
      safety.recordProviderAnswer(61, "edit-handshake")
    })
    run((safety) => safety.recordExec(1, "call"), "run-2", state)
    expect(historyCoverage(state, new Set(["run-2:1"])).complete).toBe(true)
  })

  it("marks only the current Run's exec", () => {
    const state = run((safety) => safety.recordExec(1, "call"))
    run((safety) => safety.recordProviderAnswer(1, "missing-read"), "run-2", state)
    expect(state.execs).toEqual([{ sessionId: "run-1", id: 1, callId: "call" }])
  })
})

describe("frame layout", () => {
  it("accepts known exec metadata without hiding unknown or malformed variants", () => {
    for (const variant of [10, 36]) {
      for (const [valid, extra] of [
        [true, [...varint(55 << 3), 1]],
        [false, lengthDelimited(55)],
        [false, [...varint(55 << 3), 1, ...varint(55 << 3), 0]],
        [false, [...varint(55 << 3), 1, ...lengthDelimited(90)]],
      ] as const) {
        const frame = Uint8Array.from(lengthDelimited(2, Uint8Array.from([
          ...id, ...lengthDelimited(variant), ...extra,
        ])))
        const result = analyzeReplayFrame(frame, { exec: { id: 7 } })
        expect(result.barrier).toBe(valid ? undefined : "non-control-exec")
      }
    }
  })
  it("names field numbers and wire types without payload bytes", () => {
    const frame = updateFrame(16, [...varint(1 << 3), 5])
    expect(describeFrameLayout(frame)).toBe("1:2{16:2{1:0}}")
    expect(describeFrameLayout(kvFrame(id, getBlob))).toBe("4:2{1:0,2:2{1:2}}")
  })
})

function fixed64(field: number): number[] {
  return [...varint((field << 3) | 1), 1, 0, 0, 0, 0, 0, 0, 0]
}

describe("Cursor CLI 2026.09.28 frame shapes", () => {
  const text = lengthDelimited(1, new TextEncoder().encode("hm"))
  const startedAt = [...varint(25 << 3), ...varint(1_791_275_000)]
  const update = (field: number, body: number[], extra: number[] = startedAt): number[] =>
    lengthDelimited(1, Uint8Array.from([...lengthDelimited(field, Uint8Array.from(body)), ...extra]))
  const ttft = lengthDelimited(8, Uint8Array.from([...fixed64(1), ...fixed64(2), ...fixed64(3), ...fixed64(4)]))
  const callId = lengthDelimited(1, new TextEncoder().encode("call-1"))
  const nested = lengthDelimited(2, Uint8Array.from(lengthDelimited(1, new TextEncoder().encode("x"))))

  // Layouts logged live by `replay frame unknown: layout=…`.
  const cases: Array<[string, number[], Record<string, unknown>]> = [
    ["1:2{4:2{1:2,2:0},25:0},8:2{1:1,2:1,3:1,4:1}", [...update(4, [...text, ...varint(2 << 3), 1]), ...ttft], { thinking_delta: { text: "hm" } }],
    ["1:2{4:2{1:2,2:0},25:0}", update(4, [...text, ...varint(2 << 3), 1]), { thinking_delta: { text: "hm" } }],
    ["1:2{5:2{1:0},25:0}", update(5, [...varint(1 << 3), 42]), {}],
    ["1:2{1:2{1:2},25:0}", update(1, text), { text_delta: { text: "hm" } }],
    ["1:2{27:2{1:0}}", update(27, [...varint(1 << 3), 2], []), {}],
    ["1:2{7:2{1:2,2:2,4:2},25:0}", update(7, [...callId, ...nested, ...lengthDelimited(4, new TextEncoder().encode("m"))]), { partial_tool_call: {} }],
    ["1:2{15:2{1:2,2:2,3:2},25:0}", update(15, [...callId, ...nested, ...lengthDelimited(3, new TextEncoder().encode("m"))]), {}],
    // context_injection_state{injection_id, state} after an inject_context_action.
    ["1:2{23:2{1:2,2:2}}", update(23, [...callId, ...lengthDelimited(2, Uint8Array.from(lengthDelimited(3)))], []), {}],
  ]

  for (const [layout, bytes, interactionUpdate] of cases) {
    it(`accepts ${layout}`, () => {
      const frame = Uint8Array.from(bytes)
      expect(describeFrameLayout(frame)).toBe(layout)
      expect(analyzeReplayFrame(frame, { interactionUpdate }).barrier).toBeUndefined()
    })
  }

  it("decodes an injection state update as status without a barrier", () => {
    const frame = encodeMessage("AgentServerMessage", {
      interaction_update: {
        context_injection_state: { injection_id: "inj-1", state: { rejected: { reason: "run ended" } } },
      },
    })
    const decoded = decodeMessage<any>("AgentServerMessage", frame).interaction_update
    expect(decoded.context_injection_state.injection_id).toBe("inj-1")
    expect(decoded.context_injection_state.state.rejected.reason).toBe("run ended")
    expect(analyzeReplayFrame(frame, { interactionUpdate: decoded })).toEqual({ barrier: undefined })
  })

  it("keeps the barrier for an undeclared member or a repeated timing field", () => {
    // `grok_bot_nudge` #26 is not one this client accepts.
    expect(analyzeReplayFrame(Uint8Array.from(update(26, text)), { interactionUpdate: {} }).barrier).toBe("unknown-or-malformed-frame")
    expect(analyzeReplayFrame(Uint8Array.from([...update(1, text), ...ttft, ...ttft]), { interactionUpdate: { text_delta: { text: "hm" } } }).barrier)
      .toBe("unknown-or-malformed-frame")
  })
})

describe("display calls bridged to host tools", () => {
  it("counts a bridged call as claimed whether Cursor announced or completed it", () => {
    const state: ReplaySafetyState = {}
    const attempt = new AttemptReplaySafety("run", state)
    attempt.recordToolLifecycle({ kind: "started", callId: "todo" })
    attempt.recordToolLifecycle({ kind: "completed", callId: "todo" })
    expect(state.historyRebaseUnsafe).toBeFalsy()
    expect(announcedCallsClaimed(state)).toBe(false)
    attempt.claimBridgedCall("todo")
    expect(announcedCallsClaimed(state)).toBe(true)
  })

  it("keeps a completion no exec claimed blocking unless that call is bridged", () => {
    const state: ReplaySafetyState = {}
    const attempt = new AttemptReplaySafety("run", state)
    attempt.recordExec(1, "shell")
    attempt.recordToolLifecycle({ kind: "completed", callId: "cursor-side" })
    expect(announcedCallsClaimed(state)).toBe(false)
    attempt.recordExec(2, "cursor-side")
    expect(announcedCallsClaimed(state)).toBe(false)
    attempt.claimBridgedCall("cursor-side")
    expect(announcedCallsClaimed(state)).toBe(true)
  })

  it("ignores Cursor's completion of a call it already bridged", () => {
    const state: ReplaySafetyState = { statefulBarrier: "non-control-exec", bridgedCalls: ["todo"] }
    const closing = new AttemptReplaySafety("run", state)
    closing.recordToolLifecycle({ kind: "completed", callId: "todo" })
    expect(closing.applyTo(new CursorTransportError("drop", { transient: true, replaySafe: true })).replayBarrier).toBeUndefined()
    expect(state.completedCalls).toBeUndefined()
  })

  it("still treats a lifecycle frame without a call id as unrepresentable", () => {
    const state: ReplaySafetyState = {}
    const attempt = new AttemptReplaySafety("run", state)
    attempt.recordToolLifecycle(undefined)
    expect(state.historyRebaseUnsafe).toBe(true)
  })
})
