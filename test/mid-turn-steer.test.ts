import { describe, it, expect, afterEach } from "bun:test"
import type { LanguageModelV3CallOptions } from "@ai-sdk/provider"
import { sessionManager, type CursorSession, type Frame } from "../src/session.js"
import {
  extractLiveSteerResults,
  extractPromptHistory,
  extractTrailingToolResults,
  FRESH_TURN_PENDING_CANCEL_REASON,
  mayBeUserStep,
  pumpWithRecovery,
  resetTurnStateForTests,
  type CursorRunRecovery,
} from "../src/language-model.js"
import { CursorRunInterruptedError } from "../src/transport/connect.js"
import { createCursor } from "../src/index.js"
import { getCheckpoint, setCheckpoint } from "../src/protocol/checkpoint.js"
import { decodeMessage, encodeMessage } from "../src/protocol/messages.js"
import { analyzeReplayFrame } from "../src/replay-safety.js"
import { resetCursorShellCalls } from "../src/shell-timeout.js"
import { CURSOR_COMPACTION_OPTION } from "../src/shared.js"

type Prompt = LanguageModelV3CallOptions["prompt"]
type HeldSession = CursorSession & { writes: Uint8Array[] }

const OPENCODE_SESSION = "ses_steer"
const MODEL = "cursor-test"
const NOTE = "<system-update>\nInstructions from: /w/pkg/AGENTS.md\nIndent with tabs.\n</system-update>"
const ABORTED = JSON.stringify({ error: { type: "aborted", message: "Tool execution interrupted" }, content: [] })

function heldSession(id: string, modelId?: string): HeldSession {
  const writes: Uint8Array[] = []
  const session = {
    sessionId: id,
    conversationId: `conv_${id}`,
    runId: `run_${id}`,
    openCodeSessionId: OPENCODE_SESSION,
    stream: {
      write(frame: Uint8Array) { writes.push(frame); return true },
      end() {},
      frames: () => ({ [Symbol.asyncIterator]: () => ({ next: async () => ({ done: true, value: undefined }) }) }),
      destroy() {},
      isClosed: () => false,
    },
    frames: { next: async () => ({ done: true, value: undefined }) },
    pending: new Map(),
    displayToolCalls: new Map(),
    nextBridgedExecId: 900_000,
    blobs: new Map(),
    toolDescriptors: [],
    requestContext: { env: { workspace_paths: ["/w"] } },
    usageEstimate: { inputTokens: 0, outputTokens: 0, cacheRead: 0, cacheWrite: 0, reasoningTokens: 0 },
    allowTools: true,
    pumpActive: false,
    heartbeat: null,
    cacheDiagnostics: modelId ? { modelId } : undefined,
    writes,
  } as unknown as HeldSession
  sessionManager.registerSession(session)
  return session
}

function heldReads(id: string, execIds = [1, 2], modelId?: string): HeldSession {
  const held = heldSession(id, modelId)
  for (const execId of execIds) {
    sessionManager.registerPending(execId, held, "read_result", "read", false, { path: `/w/${execId}.ts` }, `call_${execId}`)
  }
  return held
}

const read2 = (file: string) => `Read file ${file}, lines 1-2\n1: alpha\n2: beta`
const user = (...texts: string[]) => ({ role: "user", content: texts.map((text) => ({ type: "text", text })) })
const calls = (sid: string, ids: number[], toolName = "read") => ({
  role: "assistant",
  content: ids.map((id) => ({ type: "tool-call", toolCallId: `cursor_${sid}_${id}`, toolName, input: "{}" })),
})
const toolResult = (sid: string, execId: number, value: string, toolName = "read") => ({
  role: "tool",
  content: [{ type: "tool-result", toolCallId: `cursor_${sid}_${execId}`, toolName, output: { type: "text", value } }],
})
const readStep = (sid: string, second = read2("/w/2.ts")) => [
  user("look at 1.ts and 2.ts"),
  calls(sid, [1, 2]),
  toolResult(sid, 1, read2("/w/1.ts")),
  toolResult(sid, 2, second),
]
const steer = (sid: string, ...tail: unknown[]) => [...readStep(sid), ...tail] as Prompt

const clientMessages = (writes: Uint8Array[]): any[] =>
  writes.map((frame) => decodeMessage<any>("AgentClientMessage", frame))
const execMessages = (writes: Uint8Array[]): any[] =>
  clientMessages(writes).map((message) => message.exec_client_message).filter((message) => message)
const injections = (writes: Uint8Array[]): any[] =>
  clientMessages(writes).map((message) => message.conversation_action?.inject_context_action).filter((action) => action)

const serverFrame = (update: Record<string, unknown>): Frame => ({
  flags: 0,
  payload: encodeMessage("AgentServerMessage", { interaction_update: update }),
})
const injectionState = (injectionId: string, state: Record<string, unknown>) =>
  serverFrame({ context_injection_state: { injection_id: injectionId, state } })
const turnEnded = () => serverFrame({ turn_ended: { input_tokens: 1, output_tokens: 1 } })
const completed = (callId: string) => () => serverFrame({ tool_call_completed: { call_id: callId } })
const checkpoint = (): Frame => ({
  flags: 0,
  payload: encodeMessage("AgentServerMessage", { conversation_checkpoint_update: Uint8Array.from([7, 7]) }),
})

/** Feeds `next` frames, letting each frame be computed after the writes before it. */
function serve(held: HeldSession, script: Array<() => Frame>): void {
  held.frames = {
    next: async () => {
      const frame = script.shift()
      return frame ? { done: false, value: frame() } : { done: true, value: undefined }
    },
  } as unknown as CursorSession["frames"]
}

async function streamSteer(held: HeldSession, prompt: Prompt): Promise<{ parts: Array<{ type: string }>; fetched: string[] }> {
  const realFetch = globalThis.fetch
  const fetched: string[] = []
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    fetched.push(String(input))
    throw new Error("no network in this test")
  }) as typeof fetch
  try {
    const model = createCursor({ name: "cursor", accessToken: "token" }).languageModel(MODEL)
    const result = await model.doStream({
      prompt,
      headers: { "x-opencode-session-id": OPENCODE_SESSION },
      tools: [{ type: "function", name: "read", description: "Read a file", inputSchema: { type: "object", properties: {} } }],
    } as LanguageModelV3CallOptions)
    const parts: Array<{ type: string }> = []
    for await (const part of result.stream) parts.push(part)
    return { parts, fetched }
  } finally {
    globalThis.fetch = realFetch
  }
}

afterEach(() => {
  sessionManager.dispose()
  resetCursorShellCalls()
  resetTurnStateForTests()
})

describe("mid-turn user message after a complete step", () => {
  it("returns the step's results unchanged and the message for injection", () => {
    heldReads("reads")
    const prompt = steer("reads", user("also check 3.ts", "and 4.ts"))
    expect(extractTrailingToolResults(prompt)).toEqual([])

    const steered = extractLiveSteerResults(prompt, OPENCODE_SESSION, MODEL)!
    expect(steered.results.map((r) => [r.execId, r.note])).toEqual([[1, undefined], [2, undefined]])
    expect(steered.messages).toEqual(["also check 3.ts\nand 4.ts"])
  })

  it("keeps host notes on the results and each message separate", () => {
    heldReads("ordered")
    const steered = extractLiveSteerResults(
      steer("ordered", user("also check 3.ts"), user(NOTE), user("then stop")),
      OPENCODE_SESSION,
      MODEL,
    )!
    expect(steered.messages).toEqual(["also check 3.ts", "then stop"])
    expect(steered.results.at(-1)!.note).toBe(NOTE)
  })

  it("takes a completed result that only looks like OpenCode's interrupted-tool error for a result", () => {
    const lookalikes = [
      `${ABORTED}\nmore output`,
      ` ${ABORTED}`,
      JSON.stringify({ error: { type: "aborted", message: "Tool execution interrupted" }, content: [], exitCode: 0 }),
      JSON.stringify({ error: { type: "aborted", message: "Tool execution interrupted" }, content: [] }, null, 2),
      JSON.stringify({ error: { type: "unknown", message: "Tool execution interrupted later" }, content: [] }),
    ]
    for (const [i, output] of lookalikes.entries()) {
      const sid = `lookalike_${i}`
      heldReads(sid)
      const prompt = [...readStep(sid, output), user("b")] as Prompt
      expect({ output, steered: extractLiveSteerResults(prompt, OPENCODE_SESSION, MODEL)?.messages }).toEqual({ output, steered: ["b"] })
      sessionManager.dispose()
    }
  })

  it("accepts a step whose results have no text slot", () => {
    const held = heldSession("writes")
    sessionManager.registerPending(1, held, "write_result", "write", false, { path: "/w/out.ts" })
    const prompt = [user("a"), toolResult("writes", 1, "Wrote file successfully.", "write"), user("b")] as Prompt
    expect(extractLiveSteerResults(prompt, OPENCODE_SESSION, MODEL)?.messages).toEqual(["b"])
  })

  it("keeps the step's results in the seed history if the held Run has to be rebased", () => {
    const history = extractPromptHistory(steer("seed", user("also check 3.ts")), { preserveTrailingUser: true, toolResults: "trailing", trailingSteer: true })
    const text = JSON.stringify(history)
    expect(text).toContain("/w/1.ts")
    expect(text).toContain("/w/2.ts")
    expect(history.at(-1)).toEqual({ role: "user", content: "also check 3.ts" })
  })

  it("keeps a steer's results in the seed history when a later step of the turn is rebased", () => {
    const prompt = steer("later", user("also check 3.ts"), calls("later", [3]), toolResult("later", 3, read2("/w/3.ts")))
    const kept = JSON.stringify(extractPromptHistory(prompt, {
      preserveTrailingUser: true,
      toolResults: "trailing",
      keepToolCallIds: new Set(["cursor_later_1", "cursor_later_2"]),
    }))
    expect(kept).toContain("/w/1.ts")
    expect(kept.indexOf("/w/2.ts")).toBeLessThan(kept.indexOf("also check 3.ts"))
    expect(kept.indexOf("also check 3.ts")).toBeLessThan(kept.indexOf("/w/3.ts"))

    const plain = JSON.stringify(extractPromptHistory(prompt, { preserveTrailingUser: true, toolResults: "trailing" }))
    expect(plain).not.toContain("/w/1.ts")
    expect(plain).toContain("/w/3.ts")
  })

  it("leaves the seed of any other rebased turn that ends with a user message unchanged", () => {
    const history = extractPromptHistory(steer("other", user("also check 3.ts")), { preserveTrailingUser: true, toolResults: "trailing" })
    expect(JSON.stringify(history)).not.toContain("/w/1.ts")
    expect(history.at(-1)).toEqual({ role: "user", content: "also check 3.ts" })
  })
})

describe("calls that are never a user step", () => {
  const call = (overrides: Partial<LanguageModelV3CallOptions>) => ({
    prompt: [],
    headers: { "x-opencode-session-id": OPENCODE_SESSION },
    tools: [{ type: "function", name: "read", description: "Read a file", inputSchema: { type: "object", properties: {} } }],
    ...overrides,
  }) as LanguageModelV3CallOptions

  it("a title or summary call without tools", () => {
    expect(mayBeUserStep(call({}))).toBe(true)
    expect(mayBeUserStep(call({ tools: [] }))).toBe(false)
    expect(mayBeUserStep(call({ toolChoice: { type: "none" } }))).toBe(false)
  })

  it("a compaction call", () => {
    expect(mayBeUserStep(call({ providerOptions: { cursor: { [CURSOR_COMPACTION_OPTION]: true } } }))).toBe(false)
    expect(mayBeUserStep(call({ providerOptions: { cursor: { [CURSOR_COMPACTION_OPTION]: false } } }))).toBe(true)
  })
})

describe("cases that stay a fresh turn", () => {
  it("a stop then a new message", () => {
    heldReads("stopped")
    const prompt = [...readStep("stopped", ABORTED), user("b")] as Prompt
    expect(extractLiveSteerResults(prompt, OPENCODE_SESSION, MODEL)).toBeUndefined()
  })

  it("a stop then a new message, as OpenCode 1.x reports the interrupted tool", () => {
    const engine = JSON.stringify({ error: { type: "unknown", message: "Tool execution interrupted" }, content: [] })
    const interrupted = [
      { type: "text", value: engine },
      { type: "error-text", value: "Tool execution aborted" },
      { type: "error-text", value: "[Tool execution was interrupted]" },
    ]
    for (const [i, output] of interrupted.entries()) {
      const sid = `stopped_v1_${i}`
      heldReads(sid)
      const step = readStep(sid)
      step[3] = { role: "tool", content: [{ type: "tool-result", toolCallId: `cursor_${sid}_2`, toolName: "read", output }] }
      expect(extractLiveSteerResults([...step, user("b")] as Prompt, OPENCODE_SESSION, MODEL)).toBeUndefined()
      sessionManager.dispose()
    }
  })

  it("an in-session helper replaying the history under a reduced catalog", () => {
    const held = heldReads("helper")
    held.toolCatalog = [{ name: "read" }, { name: "bash" }, { name: "task" }] as CursorSession["toolCatalog"]
    const prompt = steer("helper", user("summarize the session so far"))
    expect(extractLiveSteerResults(prompt, OPENCODE_SESSION, MODEL, [{ name: "read" }, { name: "bash" }])).toBeUndefined()
    expect(extractLiveSteerResults(prompt, OPENCODE_SESSION, MODEL, [{ name: "read" }, { name: "bash" }, { name: "task" }])).toBeDefined()
  })

  it("no held Run waiting on the results", () => {
    expect(extractLiveSteerResults(steer("gone", user("b")), OPENCODE_SESSION, MODEL)).toBeUndefined()
  })

  it("a held Run of another OpenCode session", () => {
    heldReads("other")
    expect(extractLiveSteerResults(steer("other", user("b")), "ses_someone_else", MODEL)).toBeUndefined()
    expect(extractLiveSteerResults(steer("other", user("b")), undefined, MODEL)).toBeUndefined()
  })

  it("a held Run still waiting on another exec", () => {
    heldReads("partial", [1, 2, 3])
    expect(extractLiveSteerResults(steer("partial", user("b")), OPENCODE_SESSION, MODEL)).toBeUndefined()
  })

  it("a held Run without a known run id", () => {
    const held = heldReads("norun")
    held.runId = undefined
    expect(extractLiveSteerResults(steer("norun", user("b")), OPENCODE_SESSION, MODEL)).toBeUndefined()
  })

  it("a turn that already ended with assistant text", () => {
    heldReads("done", [1])
    const prompt = [
      user("a"),
      calls("done", [1]),
      toolResult("done", 1, read2("/w/1.ts")),
      { role: "assistant", content: [{ type: "text", text: "done" }] },
      user("b"),
    ] as Prompt
    expect(extractLiveSteerResults(prompt, OPENCODE_SESSION, MODEL)).toBeUndefined()
  })

  it("a message with an attachment", () => {
    heldReads("image")
    const message = { role: "user", content: [{ type: "text", text: "see this" }, { type: "file", mediaType: "image/png", data: "AA==" }] }
    expect(extractLiveSteerResults(steer("image", message), OPENCODE_SESSION, MODEL)).toBeUndefined()
  })

  it("a host note alone, which stays an ordinary continuation", () => {
    heldReads("note")
    const prompt = steer("note", user(NOTE))
    expect(extractLiveSteerResults(prompt, OPENCODE_SESSION, MODEL)).toBeUndefined()
    expect(extractTrailingToolResults(prompt).map((r) => r.execId)).toEqual([1, 2])
  })

  it("a message sent with another model selected", () => {
    heldReads("switched", [1, 2], "claude-opus")
    expect(extractLiveSteerResults(steer("switched", user("b")), OPENCODE_SESSION, "gpt-5")).toBeUndefined()
    expect(extractLiveSteerResults(steer("switched", user("b")), OPENCODE_SESSION, "claude-opus")).toBeDefined()
  })
})

describe("doStream with a mid-turn user message", () => {
  it("injects the message before the results and opens no new Run", async () => {
    const held = heldReads("stream")
    const injectionId = () => injections(held.writes)[0].injection_id
    serve(held, [
      () => injectionState(injectionId(), { queued: {} }),
      () => injectionState(injectionId(), { delivered: { step: 2 } }),
      turnEnded,
    ])

    const { parts, fetched } = await streamSteer(held, steer("stream", user("also check 3.ts")))

    expect(parts.at(-1)?.type).toBe("finish")
    const messages = clientMessages(held.writes)
    expect(messages[0].conversation_action.inject_context_action).toMatchObject({
      expected_run_id: "run_stream",
      user_context: { user_message: { text: "also check 3.ts" } },
    })
    const results = execMessages(held.writes)
    expect(results.map((message) => message.id)).toEqual([1, 2])
    expect(results.map((message) => message.read_result.success.content)).toEqual(["alpha\nbeta", "alpha\nbeta"])
    expect(held.resultsAfterCheckpoint).toEqual({
      awaiting: new Set(["call_1", "call_2"]),
      unconfirmed: false,
      toolCallIds: new Set(["cursor_stream_1", "cursor_stream_2"]),
    })
    expect(JSON.stringify(messages)).not.toContain(FRESH_TURN_PENDING_CANCEL_REASON)
    expect(held.pending.size).toBe(0)
    expect(fetched).toEqual([])
  })

  it("sends a message Cursor did not deliver as a follow-up Run", async () => {
    const held = heldReads("rejected")
    held.resumeCheckpoint = new Uint8Array([1])
    const followUps: string[] = []
    held.reopenWithUserMessage = async (text) => {
      followUps.push(text)
      serve(held, [
        () => serverFrame({ thinking_delta: { text: "checking 3.ts" } }),
        () => serverFrame({ text_delta: { text: "ok" } }),
        turnEnded,
      ])
    }
    serve(held, [
      () => injectionState(injections(held.writes)[0].injection_id, { rejected: { reason: "run_mismatch" } }),
      completed("call_1"),
      completed("call_2"),
      () => serverFrame({ text_delta: { text: "Both files say alpha." } }),
      checkpoint,
      turnEnded,
    ])

    const { parts } = await streamSteer(held, steer("rejected", user("also check 3.ts")))

    expect(parts.at(-1)?.type).toBe("finish")
    expect(followUps).toEqual(["also check 3.ts"])
    const spans = parts
      .filter((part: any) => /^(text|reasoning)-(start|delta|end)$/.test(part.type))
      .map((part: any) => part.type === "text-delta" || part.type === "reasoning-delta" ? `${part.type}:${part.delta}` : part.type)
    expect(spans).toEqual([
      "text-start", "text-delta:Both files say alpha.", "text-end",
      "reasoning-start", "reasoning-delta:checking 3.ts", "reasoning-end",
      "text-start", "text-delta:ok", "text-end",
    ])
  })

  it("fails the turn instead of sending a follow-up from a checkpoint older than the results, and drops it", async () => {
    const held = heldReads("stale")
    setCheckpoint(held.conversationId, new Uint8Array([1]))
    held.resumeCheckpoint = new Uint8Array([1])
    held.reopenWithUserMessage = async () => { throw new Error("must not reopen from a checkpoint before the results") }
    serve(held, [
      checkpoint,
      () => injectionState(injections(held.writes)[0].injection_id, { cancelled: {} }),
      turnEnded,
    ])

    const outcome = await streamSteer(held, steer("stale", user("also check 3.ts"))).then(
      ({ parts }) => parts.find((part: any) => part.type === "error") as any,
      (error) => ({ error }),
    )

    expect(String(outcome?.error)).toContain("no checkpoint to send it as a follow-up")
    expect(getCheckpoint(held.conversationId)).toBeUndefined()
  })

  it("fails the turn instead of sending a follow-up from a checkpoint read before Cursor completed the results", async () => {
    const held = heldReads("in-flight")
    held.resumeCheckpoint = new Uint8Array([1])
    held.reopenWithUserMessage = async () => { throw new Error("must not reopen from a checkpoint before the results") }
    const injectionId = () => injections(held.writes)[0].injection_id
    serve(held, [
      () => injectionState(injectionId(), { queued: {} }),
      checkpoint,
      completed("call_1"),
      completed("call_2"),
      () => injectionState(injectionId(), { cancelled: {} }),
      turnEnded,
    ])

    const outcome = await streamSteer(held, steer("in-flight", user("also check 3.ts"))).then(
      ({ parts }) => parts.find((part: any) => part.type === "error") as any,
      (error) => ({ error }),
    )

    expect(String(outcome?.error)).toContain("no checkpoint to send it as a follow-up")
  })

  it("never trusts a checkpoint for results Cursor does not confirm", async () => {
    const held = heldSession("unconfirmed")
    sessionManager.registerPending(1, held, "read_result", "read", false, { path: "/w/1.ts" }, "call_1")
    sessionManager.registerPending(2, held, "read_result", "read", false, { path: "/w/2.ts" })
    serve(held, [
      () => injectionState(injections(held.writes)[0].injection_id, { delivered: { step: 2 } }),
      completed("call_1"),
      checkpoint,
      turnEnded,
    ])

    await streamSteer(held, steer("unconfirmed", user("also check 3.ts")))

    expect(held.resultsAfterCheckpoint).toEqual({
      awaiting: new Set(),
      unconfirmed: true,
      toolCallIds: new Set(["cursor_unconfirmed_1", "cursor_unconfirmed_2"]),
    })
  })

  it("fails the turn instead of dropping a message it cannot send as a follow-up", async () => {
    const held = heldReads("nocheckpoint")
    setCheckpoint(held.conversationId, new Uint8Array([9]))
    held.reopenWithUserMessage = async () => { throw new Error("must not reopen without a checkpoint") }
    serve(held, [
      () => injectionState(injections(held.writes)[0].injection_id, { cancelled: {} }),
      turnEnded,
    ])

    const outcome = await streamSteer(held, steer("nocheckpoint", user("also check 3.ts"))).then(
      ({ parts }) => parts.find((part: any) => part.type === "error") as any,
      (error) => ({ error }),
    )

    expect(String(outcome?.error)).toContain("no checkpoint to send it as a follow-up")
    expect(getCheckpoint(held.conversationId)).toBeUndefined()
  })

  it("adds a later result of the turn to steer results no checkpoint holds yet", async () => {
    const outcomes: Record<string, unknown> = {}
    const cases: Array<[string, Array<() => Frame>]> = [
      ["carried", [turnEnded]],
      ["checkpointed", [checkpoint, turnEnded]],
    ]
    for (const [sid, tail] of cases) {
      const held = heldReads(sid, [3])
      setCheckpoint(held.conversationId, new Uint8Array([1]))
      held.resumeCheckpoint = new Uint8Array([1])
      held.resultsAfterCheckpoint = { awaiting: new Set(), unconfirmed: false, toolCallIds: new Set([`cursor_${sid}_1`]) }
      let written: unknown
      serve(held, [
        () => {
          written = structuredClone(held.resultsAfterCheckpoint)
          return completed("call_3")()
        },
        ...tail,
      ])

      await streamSteer(held, steer(sid, user("also check 3.ts"), calls(sid, [3]), toolResult(sid, 3, read2("/w/3.ts"))))

      outcomes[sid] = { written, checkpoint: getCheckpoint(held.conversationId) }
      sessionManager.dispose()
    }

    expect(outcomes["carried"]).toEqual({
      written: { awaiting: new Set(["call_3"]), unconfirmed: false, toolCallIds: new Set(["cursor_carried_1", "cursor_carried_3"]) },
      checkpoint: undefined,
    })
    expect(outcomes["checkpointed"]).toMatchObject({ checkpoint: Uint8Array.from([7, 7]) })
  })

  it("injects a host note that trails the step's results along with the message, never as a follow-up", async () => {
    const outcomes: Record<string, unknown> = {}
    for (const state of ["delivered", "rejected"]) {
      const held = heldReads(`noted-${state}`)
      held.resumeCheckpoint = new Uint8Array([1])
      const followUps: string[] = []
      held.reopenWithUserMessage = async (text) => {
        followUps.push(text)
        serve(held, [turnEnded])
      }
      serve(held, [
        () => injectionState(injections(held.writes)[0].injection_id, { [state]: {} }),
        () => injectionState(injections(held.writes)[1].injection_id, { [state]: {} }),
        completed("call_1"),
        completed("call_2"),
        checkpoint,
        turnEnded,
      ])

      await streamSteer(held, steer(`noted-${state}`, user(NOTE), user("also check 3.ts")))

      outcomes[state] = {
        injected: injections(held.writes).map((action) => action.user_context.user_message.text),
        followUps,
      }
      expect(JSON.stringify(execMessages(held.writes))).not.toContain("system-update")
      sessionManager.dispose()
    }

    expect(outcomes).toEqual({
      delivered: { injected: ["also check 3.ts", NOTE], followUps: [] },
      rejected: { injected: ["also check 3.ts", NOTE], followUps: ["also check 3.ts"] },
    })
  })

  it("sends no follow-up for a delivered message", async () => {
    const held = heldReads("delivered")
    held.resumeCheckpoint = new Uint8Array([1])
    const followUps: string[] = []
    held.reopenWithUserMessage = async (text) => { followUps.push(text) }
    serve(held, [
      () => injectionState(injections(held.writes)[0].injection_id, { delivered: { step: 2 } }),
      () => serverFrame({ text_delta: { text: "ok" } }),
      turnEnded,
    ])

    await streamSteer(held, steer("delivered", user("also check 3.ts")))

    expect(followUps).toEqual([])
  })
})

describe("doStream with a host note after a step of reads", () => {
  it("injects the note into the held Run before the results", async () => {
    const held = heldReads("plain-note")
    serve(held, [
      () => injectionState(injections(held.writes)[0].injection_id, { delivered: { step: 2 } }),
      turnEnded,
    ])

    const { parts, fetched } = await streamSteer(held, steer("plain-note", user(NOTE)))

    expect(parts.at(-1)?.type).toBe("finish")
    const [first] = clientMessages(held.writes)
    expect(first.conversation_action.inject_context_action).toMatchObject({
      expected_run_id: "run_plain-note",
      user_context: { user_message: { text: NOTE } },
    })
    expect(execMessages(held.writes).map((message) => message.read_result.success.content)).toEqual(["alpha\nbeta", "alpha\nbeta"])
    expect(held.resultsAfterCheckpoint).toBeUndefined()
    expect(fetched).toEqual([])
  })
})

describe("Run recovery around a mid-turn user message", () => {
  const controller = (parts: unknown[]) => ({
    enqueue(part: unknown) { parts.push(part) },
    error(error: Error) { throw error },
  }) as unknown as ReadableStreamDefaultController<any>

  it("resends the follow-up when opening its Run fails", async () => {
    const held = heldSession("reopen-fails")
    held.resumeCheckpoint = new Uint8Array([1])
    held.steerInjections = [{ id: "inj-1", text: "also check 3.ts", state: "rejected", checkpointed: true }]
    held.reopenWithUserMessage = async () => { throw new CursorRunInterruptedError() }
    serve(held, [turnEnded])
    const recoveries: CursorRunRecovery[] = []
    let recovered: HeldSession | undefined

    await pumpWithRecovery({
      initialSession: held,
      controller: controller([]),
      recover: async (recovery) => {
        recoveries.push(recovery)
        recovered = heldSession("reopen-recovered")
        serve(recovered, [() => serverFrame({ text_delta: { text: "ok" } }), turnEnded])
        return recovered
      },
    })

    expect(recoveries).toEqual([{ kind: "resume", conversationId: held.conversationId, checkpoint: new Uint8Array([1]), followUp: "also check 3.ts" }])
    expect(recovered!.closed).toBe(true)
  })

  it("rebases a steer's Run that drops before any checkpoint as a steer, and no other", async () => {
    const recoveries: CursorRunRecovery[] = []
    for (const steer of [true, false]) {
      const held = heldSession(`no-checkpoint-drop-${steer}`)
      serve(held, [])
      await pumpWithRecovery({
        initialSession: held,
        controller: controller([]),
        steer,
        recover: async (recovery) => {
          recoveries.push(recovery)
          const rebased = heldSession(`no-checkpoint-rebased-${steer}`)
          serve(rebased, [turnEnded])
          return rebased
        },
      })
    }

    expect(recoveries).toEqual([{ kind: "rebase", steer: true }, { kind: "rebase" }])
  })

  it("resumes a steer's Run only from a checkpoint read after Cursor completed every result", async () => {
    const cases: Array<[string, Array<() => Frame>, boolean]> = [
      ["none", [], false],
      ["in-flight", [checkpoint], false],
      ["before-completion", [completed("call_1"), checkpoint, completed("call_2")], false],
      ["after-completion", [completed("call_1"), completed("call_2"), checkpoint], false],
      ["unconfirmed", [completed("call_1"), completed("call_2"), checkpoint], true],
    ]
    const outcomes: Record<string, CursorRunRecovery | string> = {}
    for (const [name, script, unconfirmed] of cases) {
      const held = heldSession(`stale-checkpoint-drop-${name}`)
      held.resumeCheckpoint = new Uint8Array([1])
      held.resultsAfterCheckpoint = { awaiting: new Set(["call_1", "call_2"]), unconfirmed, toolCallIds: new Set(["cursor_a_1"]) }
      serve(held, script)
      await pumpWithRecovery({
        initialSession: held,
        controller: controller([]),
        steer: true,
        recover: async (recovery) => {
          outcomes[name] = recovery
          const next = heldSession(`stale-checkpoint-next-${name}`)
          serve(next, [turnEnded])
          return next
        },
      }).catch((error: Error) => { outcomes[name] = error.message })
    }

    expect(outcomes["none"]).toEqual({ kind: "rebase", steer: true, toolCallIds: new Set(["cursor_a_1"]) })
    expect(outcomes["in-flight"]).toEqual({ kind: "rebase", steer: true, toolCallIds: new Set(["cursor_a_1"]) })
    // Cursor's tool lifecycle frames bar a blind rebase, and the checkpoint cannot be resumed.
    expect(outcomes["before-completion"]).toContain("automatic retry unsafe")
    expect(outcomes["unconfirmed"]).toContain("automatic retry unsafe")
    expect(outcomes["after-completion"]).toMatchObject({ kind: "resume", checkpoint: Uint8Array.from([7, 7]) })
  })

  it("resends only the messages the resumed checkpoint may not hold", async () => {
    const held = heldSession("partial-resume")
    held.resumeCheckpoint = new Uint8Array([1])
    held.steerInjections = [
      { id: "inj-a", text: "first", state: "delivered", checkpointed: true },
      { id: "inj-b", text: "second", state: "delivered" },
    ]
    serve(held, [])
    const followUps: string[] = []

    await pumpWithRecovery({
      initialSession: held,
      controller: controller([]),
      recover: async () => {
        const resumed = heldSession("partial-resumed")
        resumed.resumeCheckpoint = new Uint8Array([2])
        resumed.reopenWithUserMessage = async (text) => {
          followUps.push(text)
          serve(resumed, [turnEnded])
        }
        serve(resumed, [checkpoint, turnEnded])
        return resumed
      },
    })

    expect(followUps).toEqual(["second"])
  })

  it("resends even a delivered message when the Run resumes from a checkpoint older than it", async () => {
    const held = heldSession("stale-resume")
    held.resumeCheckpoint = new Uint8Array([1])
    held.steerInjections = [{ id: "inj-4", text: "also check 3.ts", state: "delivered" }]
    serve(held, [])
    const followUps: string[] = []

    await pumpWithRecovery({
      initialSession: held,
      controller: controller([]),
      recover: async () => {
        const resumed = heldSession("stale-resumed")
        resumed.resumeCheckpoint = new Uint8Array([2])
        resumed.reopenWithUserMessage = async (text) => {
          followUps.push(text)
          serve(resumed, [turnEnded])
        }
        serve(resumed, [checkpoint, turnEnded])
        return resumed
      },
    })

    expect(followUps).toEqual(["also check 3.ts"])
  })

  it("keeps undelivered messages across a resumed Run and sends them when it ends", async () => {
    const held = heldSession("resumed")
    held.resumeCheckpoint = new Uint8Array([1])
    held.steerInjections = [{ id: "inj-2", text: "then stop", state: "queued" }]
    serve(held, [])
    const followUps: string[] = []
    const recover = async () => {
      const recovered = heldSession("resumed-next")
      recovered.resumeCheckpoint = new Uint8Array([2])
      recovered.reopenWithUserMessage = async (text) => {
        followUps.push(text)
        serve(recovered, [() => serverFrame({ text_delta: { text: "ok" } }), turnEnded])
      }
      serve(recovered, [checkpoint, turnEnded])
      return recovered
    }

    await pumpWithRecovery({ initialSession: held, controller: controller([]), recover })

    expect(followUps).toEqual(["then stop"])
  })

  it("treats injection progress as control frames for replay safety", () => {
    for (const update of [
      { context_injection_state: { injection_id: "inj", state: { queued: {} } } },
      { user_message_appended: { user_message: { text: "b", message_id: "inj" } } },
    ]) {
      const payload = encodeMessage("AgentServerMessage", { interaction_update: update })
      const decoded = decodeMessage<any>("AgentServerMessage", payload)
      expect(analyzeReplayFrame(payload, { interactionUpdate: decoded.interaction_update }).barrier).toBeUndefined()
    }
  })
})
