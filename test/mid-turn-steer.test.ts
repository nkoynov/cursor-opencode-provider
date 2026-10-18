import { describe, it, expect, afterEach } from "bun:test"
import type { LanguageModelV3CallOptions, LanguageModelV3StreamPart } from "@ai-sdk/provider"
import { sessionManager, type CursorSession, type Frame } from "../src/session.js"
import {
  continuationAfterEarlySteers,
  extractPromptHistory,
  extractTrailingToolResults,
  FRESH_TURN_PENDING_CANCEL_REASON,
  mayBeUserStep,
  pumpWithRecovery,
  resetTurnStateForTests,
  type CursorRunRecovery,
} from "../src/language-model.js"
import { needsHostHistory, recordEarlySteer } from "../src/host-steer.js"
import { CursorRunInterruptedError, lastFrameArrival, noteFrameArrivalForTests } from "../src/transport/connect.js"
import { createCursor } from "../src/index.js"
import { billingLedger } from "../src/billing.js"
import { getCheckpoint, setCheckpoint } from "../src/protocol/checkpoint.js"
import { getTurnProvenance } from "../src/protocol/turn-provenance.js"
import { decodeMessage, encodeMessage } from "../src/protocol/messages.js"
import { analyzeReplayFrame } from "../src/replay-safety.js"
import { resetCursorShellCalls } from "../src/shell-timeout.js"
import { CURSOR_COMPACTION_OPTION } from "../src/shared.js"

type Prompt = LanguageModelV3CallOptions["prompt"]
type HeldSession = CursorSession & { writes: Uint8Array[] }

const OPENCODE_SESSION = "ses_steer"
const MODEL = "cursor-test"
const NOTE = "<system-update>\nInstructions from: /w/pkg/AGENTS.md\nIndent with tabs.\n</system-update>"
/** The note as Cursor gets it: a host note is injected as plain text. */
const NOTE_TEXT = "Instructions from: /w/pkg/AGENTS.md\nIndent with tabs."
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
    billing: { key: `run:${id}`, prefixTokens: 0 },
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
  }) as unknown as typeof fetch
  try {
    const model = createCursor({ name: "cursor", accessToken: "token" }).languageModel(MODEL)
    const result = await model.doStream({
      prompt,
      headers: { "x-opencode-session-id": OPENCODE_SESSION },
      tools: [{ type: "function", name: "read", description: "Read a file", inputSchema: { type: "object", properties: {} } }],
    } as LanguageModelV3CallOptions)
    const parts: Array<{ type: string }> = []
    for await (const part of result.stream as unknown as AsyncIterable<LanguageModelV3StreamPart>) parts.push(part)
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

const TOOLS = [{ name: "read" }]

/** The held-Run continuation of a user step for `wireModelId`, and the messages it injects. */
function steered(prompt: Prompt, sessionKey: string | undefined = OPENCODE_SESSION, wireModelId = MODEL, incomingTools = TOOLS) {
  const found = continuationAfterEarlySteers(prompt, sessionKey, { userStep: true, wireModelId, incomingTools })
  return found && { results: found.results, messages: found.inject.map((record) => record.text) }
}

/** A message the held Run `run` was sent, as OpenCode promoted it after the step's results. */
function promoted(run: string, text: string, fields: { delivered?: boolean; checkpointed?: boolean } = {}) {
  recordEarlySteer({
    sessionID: OPENCODE_SESSION, inboxID: `inbox-${text}`, injectionId: `inj-${text}`, run, text,
    delivered: fields.delivered ?? false, checkpointed: fields.checkpointed ?? false, answered: false, promoted: true,
  })
}

describe("mid-turn user message after a complete step", () => {
  it("returns the step's results unchanged and the message for injection", () => {
    heldReads("reads")
    const prompt = steer("reads", user("also check 3.ts", "and 4.ts"))
    expect(extractTrailingToolResults(prompt)).toEqual([])

    const found = steered(prompt)!
    expect(found.results.map((r) => [r.execId, r.notes])).toEqual([[1, undefined], [2, undefined]])
    expect(found.messages).toEqual(["also check 3.ts\nand 4.ts"])
  })

  it("injects a message once when the host repeats the step", () => {
    heldReads("repeated")
    const prompt = steer("repeated", user("also check 3.ts"))
    expect(steered(prompt)?.messages).toEqual(["also check 3.ts"])
    expect(steered(prompt)?.messages).toEqual([])
  })

  it("keeps each message separate, and the step's host notes with its results", () => {
    heldReads("ordered")
    const found = steered(steer("ordered", user("also check 3.ts"), user(NOTE), user("then stop")))!
    expect(found.messages).toEqual(["also check 3.ts", "then stop"])
    expect(found.results.at(-1)!.notes).toEqual([NOTE])
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
      expect({ output, steered: steered(prompt)?.messages }).toEqual({ output, steered: ["b"] })
      sessionManager.dispose()
    }
  })

  it("keeps the message for a follow-up while a later call of the step is still deferred", () => {
    const held = heldReads("deferred")
    held.toolCallOrder = {
      calls: [{ callId: "call_3", mutating: true }],
      deferred: [{ execId: 3, callId: "call_3", mutating: true, read: { done: true, value: undefined } }],
      progressAt: Date.now(),
    }
    const found = steered(steer("deferred", user("b")))!
    expect(found.results.map((r) => r.execId)).toEqual([1, 2])
    expect(found.messages).toEqual([])
    expect(steered(steer("deferred", user("b")))?.messages).toEqual([])
  })

  it("keeps the message for a follow-up while a later or unfinished call has no exec yet", () => {
    const held = heldReads("announced")
    held.toolCallOrder = {
      calls: [{ callId: "call_1", mutating: false }, { callId: "call_2", mutating: false }, { callId: "call_3", mutating: true }],
      deferred: [],
      progressAt: Date.now(),
    }
    expect(steered(steer("announced", user("b")))?.messages).toEqual([])
    sessionManager.dispose()
    const edit = heldReads("edit-read")
    edit.editToolCalls = new Map([["call_2", {}]]) as CursorSession["editToolCalls"]
    edit.toolCallOrder = { calls: [{ callId: "call_1", mutating: false }, { callId: "call_2", mutating: true }], deferred: [], progressAt: Date.now() }
    expect(steered(steer("edit-read", user("b")))?.messages).toEqual([])
    sessionManager.dispose()
    const partial = heldReads("partial-only")
    partial.announcedCallIds = new Set(["call_3"])
    expect(steered(steer("partial-only", user("b")))?.messages).toEqual([])
    sessionManager.dispose()
    const carried = heldReads("carried")
    carried.carriedToolStep = { listed: 3, resolved: new Set(["call_1", "call_2"]) }
    expect(steered(steer("carried", user("b")))?.messages).toEqual([])
    sessionManager.dispose()
    const uncounted = heldReads("uncounted")
    uncounted.carriedToolStep = { listed: undefined, resolved: new Set(["call_1", "call_2"]) }
    expect(steered(steer("uncounted", user("b")))?.messages).toEqual(["b"])
    sessionManager.dispose()
    const answered = heldReads("answered")
    answered.toolCallOrder = { calls: [{ callId: "call_1", mutating: false }, { callId: "call_2", mutating: false }], deferred: [], progressAt: Date.now() }
    expect(steered(steer("answered", user("b")))?.messages).toEqual(["b"])
  })

  it("accepts a step whose results have no text slot", () => {
    const held = heldSession("writes")
    sessionManager.registerPending(1, held, "write_result", "write", false, { path: "/w/out.ts" })
    const prompt = [user("a"), toolResult("writes", 1, "Wrote file successfully.", "write"), user("b")] as Prompt
    expect(steered(prompt)?.messages).toEqual(["b"])
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
    expect(steered(prompt)).toBeUndefined()
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
      expect(steered([...step, user("b")] as Prompt)).toBeUndefined()
      sessionManager.dispose()
    }
  })

  it("an in-session helper replaying the history under a reduced catalog", () => {
    const held = heldReads("helper")
    held.toolCatalog = [{ name: "read" }, { name: "bash" }, { name: "task" }] as CursorSession["toolCatalog"]
    const prompt = steer("helper", user("summarize the session so far"))
    expect(steered(prompt, OPENCODE_SESSION, MODEL, [{ name: "read" }, { name: "bash" }])).toBeUndefined()
    expect(steered(prompt, OPENCODE_SESSION, MODEL, [{ name: "read" }, { name: "bash" }, { name: "task" }])).toBeDefined()
  })

  it("a title, summary or compaction call", () => {
    heldReads("helper-call")
    const prompt = steer("helper-call", user("summarize the session so far"))
    expect(continuationAfterEarlySteers(prompt, OPENCODE_SESSION, { userStep: false, wireModelId: MODEL, incomingTools: TOOLS })).toBeUndefined()
  })

  it("no held Run waiting on the results", () => {
    expect(steered(steer("gone", user("b")))).toBeUndefined()
  })

  it("a held Run of another OpenCode session", () => {
    heldReads("other")
    expect(steered(steer("other", user("b")), "ses_someone_else")).toBeUndefined()
    expect(continuationAfterEarlySteers(steer("other", user("b")), undefined, { userStep: true, wireModelId: MODEL, incomingTools: TOOLS })).toBeUndefined()
  })

  it("a held Run still waiting on another exec", () => {
    heldReads("partial", [1, 2, 3])
    expect(steered(steer("partial", user("b")))).toBeUndefined()
  })

  it("a held Run without a known run id", () => {
    const held = heldReads("norun")
    held.runId = undefined
    expect(steered(steer("norun", user("b")))).toBeUndefined()
  })

  it("a held Run the host stopped", () => {
    const held = heldReads("stopped-run")
    held.hostInterrupted = "user"
    expect(steered(steer("stopped-run", user("b")))).toBeUndefined()
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
    expect(steered(prompt)).toBeUndefined()
  })

  it("a message with an attachment", () => {
    heldReads("image")
    const message = { role: "user", content: [{ type: "text", text: "see this" }, { type: "file", mediaType: "image/png", data: "AA==" }] }
    expect(steered(steer("image", message))).toBeUndefined()
  })

  it("a host note alone, which stays an ordinary continuation", () => {
    heldReads("note")
    const prompt = steer("note", user(NOTE))
    expect(steered(prompt)).toBeUndefined()
    expect(extractTrailingToolResults(prompt).map((r) => r.execId)).toEqual([1, 2])
  })

  it("a message sent with another model selected", () => {
    heldReads("switched", [1, 2], "claude-opus")
    expect(steered(steer("switched", user("b")), OPENCODE_SESSION, "gpt-5")).toBeUndefined()
    expect(steered(steer("switched", user("b")), OPENCODE_SESSION, "claude-opus")).toBeDefined()
  })
})

describe("doStream with a mid-turn user message", () => {
  it("injects the message after the results and opens no new Run", async () => {
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
    const injectedAt = messages.findIndex((message) => message.conversation_action?.inject_context_action)
    expect(injectedAt).toBeGreaterThan(messages.map((message) => !!message.exec_client_message).lastIndexOf(true))
    expect(messages[injectedAt].conversation_action.inject_context_action).toMatchObject({
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
      "text-start", "text-delta:\n\nok", "text-end",
    ])
  })

  it("runs a deferred later call of the step before the message, which goes as a follow-up Run", async () => {
    const held = heldReads("deferred-stream")
    held.resumeCheckpoint = new Uint8Array([1])
    held.toolCallOrder = {
      calls: [{ callId: "call_1", mutating: false }, { callId: "call_2", mutating: false }, { callId: "call_3", mutating: true }],
      deferred: [{
        execId: 3, callId: "call_3", mutating: true,
        read: { done: false, value: serverFrame({ text_delta: { text: "Deferred call ran." } }) },
      }],
      progressAt: Date.now(),
    }
    const followUps: string[] = []
    held.reopenWithUserMessage = async (text) => {
      followUps.push(text)
      serve(held, [() => serverFrame({ text_delta: { text: "ok" } }), turnEnded])
    }
    serve(held, [completed("call_1"), completed("call_2"), checkpoint, turnEnded])

    const { parts } = await streamSteer(held, steer("deferred-stream", user("also check 3.ts")))

    expect(injections(held.writes)).toEqual([])
    expect(followUps).toEqual(["also check 3.ts"])
    const texts = parts.filter((part: any) => part.type === "text-delta").map((part: any) => part.delta)
    expect(texts).toEqual(["Deferred call ran.", "\n\nok"])
  })

  it("keeps the step unfinished while a steer's follow-up Run continues it, so a Stop there keeps the conversation", async () => {
    const held = heldReads("rejected-stop")
    held.resumeCheckpoint = new Uint8Array([1])
    let unfinishedDuringFollowUp: boolean | undefined
    held.reopenWithUserMessage = async () => {
      unfinishedDuringFollowUp = getTurnProvenance(OPENCODE_SESSION)?.unfinished
      serve(held, [() => serverFrame({ text_delta: { text: "ok" } }), turnEnded])
    }
    serve(held, [
      () => injectionState(injections(held.writes)[0].injection_id, { rejected: { reason: "run_mismatch" } }),
      completed("call_1"),
      completed("call_2"),
      () => serverFrame({ text_delta: { text: "Both files say alpha." } }),
      checkpoint,
      turnEnded,
    ])

    await streamSteer(held, steer("rejected-stop", user("also check 3.ts")))

    expect(unfinishedDuringFollowUp).toBe(true)
    expect(getTurnProvenance(OPENCODE_SESSION)?.unfinished).toBeUndefined()
  })

  it("bills both Cursor turns on the last step when a steer goes out as a follow-up Run", async () => {
    const held = heldReads("rejected-usage")
    held.resumeCheckpoint = new Uint8Array([1])
    held.tokenDetails = { usedTokens: 1_000, maxTokens: 256_000 }
    held.billing = { key: OPENCODE_SESSION, cost: { input: 2, output: 6, cache_read: 0.5 }, prefixTokens: 0 }
    const ended = (output: number) => () => serverFrame({ turn_ended: { input_tokens: 400, cache_read: 400, output_tokens: output } })
    held.reopenWithUserMessage = async () => {
      serve(held, [() => serverFrame({ text_delta: { text: "ok" } }), ended(50)])
    }
    serve(held, [
      () => injectionState(injections(held.writes)[0].injection_id, { rejected: { reason: "run_mismatch" } }),
      completed("call_1"),
      completed("call_2"),
      () => serverFrame({ text_delta: { text: "Both files say alpha." } }),
      checkpoint,
      ended(30),
    ])

    try {
      const { parts } = await streamSteer(held, steer("rejected-usage", user("also check 3.ts")))

      const finishes = parts.filter((part) => part.type === "finish") as any[]
      expect(finishes).toHaveLength(1)
      expect(finishes[0].usage.inputTokens.total + finishes[0].usage.outputTokens.total).toBe(1_000)
      // (400 × 0.5 + 30 × 6) + (400 × 0.5 + 50 × 6) per million.
      expect(Math.abs(finishes[0].providerMetadata.cursor.billing.stepUsd - 880e-6)).toBeLessThan(1e-6)
      expect(Math.abs(billingLedger.outstanding(OPENCODE_SESSION))).toBeLessThan(1e-6)
    } finally {
      billingLedger.clear()
    }
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
      delivered: { injected: [NOTE_TEXT, "also check 3.ts"], followUps: [] },
      rejected: { injected: [NOTE_TEXT, "also check 3.ts"], followUps: ["also check 3.ts"] },
    })
  })

  it("injects the step's host notes, then its messages, after the step's results", async () => {
    const held = heldReads("interleaved")
    serve(held, [
      () => injectionState(injections(held.writes)[0].injection_id, { delivered: { step: 2 } }),
      () => injectionState(injections(held.writes)[1].injection_id, { delivered: { step: 2 } }),
      () => injectionState(injections(held.writes)[2].injection_id, { delivered: { step: 2 } }),
      turnEnded,
    ])

    await streamSteer(held, steer("interleaved", user("also check 3.ts"), user(NOTE), user("then stop")))

    const messages = clientMessages(held.writes)
    expect(injections(held.writes).map((action) => action.user_context.user_message.text)).toEqual([NOTE_TEXT, "also check 3.ts", "then stop"])
    expect(messages.findIndex((message) => message.conversation_action))
      .toBeGreaterThan(messages.map((message) => !!message.exec_client_message).lastIndexOf(true))
    expect(JSON.stringify(execMessages(held.writes))).not.toContain("system-update")
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
  it("injects the note into the held Run after the results", async () => {
    const held = heldReads("plain-note")
    serve(held, [
      () => injectionState(injections(held.writes)[0].injection_id, { delivered: { step: 2 } }),
      turnEnded,
    ])

    const { parts, fetched } = await streamSteer(held, steer("plain-note", user(NOTE)))

    expect(parts.at(-1)?.type).toBe("finish")
    const messages = clientMessages(held.writes)
    expect(messages.at(-1).conversation_action.inject_context_action).toMatchObject({
      expected_run_id: "run_plain-note",
      user_context: { user_message: { text: NOTE_TEXT } },
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

  it("fails the turn when the follow-up Run cannot open, and the next turn rebuilds from host history", async () => {
    const held = heldSession("reopen-fails")
    held.resumeCheckpoint = new Uint8Array([1])
    promoted(held.sessionId, "also check 3.ts")
    held.reopenWithUserMessage = async () => { throw new CursorRunInterruptedError() }
    serve(held, [turnEnded])
    const recoveries: CursorRunRecovery[] = []

    const error = await pumpWithRecovery({
      initialSession: held,
      controller: controller([]),
      recover: async (recovery) => {
        recoveries.push(recovery)
        return heldSession("reopen-recovered")
      },
    }).then(() => undefined, (failure: Error) => failure)

    expect(error?.message).toContain("sending it again failed")
    expect(recoveries).toEqual([])
    expect(needsHostHistory(OPENCODE_SESSION, undefined)).toBe(true)
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
    const queued = [completed("call_1"), completed("call_2"), checkpoint].map((make) => {
      const frame = make()
      noteFrameArrivalForTests(frame)
      return () => frame
    })
    cases.push(["queued-before-result", queued, false])
    const outcomes: Record<string, CursorRunRecovery | string> = {}
    for (const [name, script, unconfirmed] of cases) {
      const held = heldSession(`stale-checkpoint-drop-${name}`)
      held.resumeCheckpoint = new Uint8Array([1])
      held.resultsAfterCheckpoint = { awaiting: new Set(["call_1", "call_2"]), unconfirmed, toolCallIds: new Set(["cursor_a_1"]) }
      if (name === "queued-before-result") held.resumeCheckpointAfterFrame = lastFrameArrival()
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
    expect(outcomes["queued-before-result"]).toContain("automatic retry unsafe")
    expect(outcomes["after-completion"]).toMatchObject({ kind: "resume", checkpoint: Uint8Array.from([7, 7]) })
  })

  it("resends only the messages the resumed checkpoint may not hold", async () => {
    const held = heldSession("partial-resume")
    held.resumeCheckpoint = new Uint8Array([1])
    promoted(held.sessionId, "first", { delivered: true, checkpointed: true })
    promoted(held.sessionId, "second", { delivered: true })
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
    promoted(held.sessionId, "also check 3.ts", { delivered: true })
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
    promoted(held.sessionId, "then stop")
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
