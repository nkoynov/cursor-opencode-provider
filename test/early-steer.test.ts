import { describe, it, expect, afterEach } from "bun:test"
import type { LanguageModelV3CallOptions } from "@ai-sdk/provider"
import { sessionManager, type CursorSession, type Frame } from "../src/session.js"
import { resetTurnStateForTests } from "../src/language-model.js"
import { createCursor } from "../src/index.js"
import { decodeMessage, encodeMessage } from "../src/protocol/messages.js"
import {
  announceHostSteer,
  clearEarlySteers,
  forgetEarlySteers,
  listenForHostSteers,
  recordEarlySteer,
  rememberQueuedSteer,
  takeEarlySteers,
  takeQueuedSteer,
  type HostSteer,
} from "../src/host-steer.js"

type Prompt = LanguageModelV3CallOptions["prompt"]
type HeldSession = CursorSession & { writes: Uint8Array[] }

const OPENCODE_SESSION = "ses_early"
const REMINDER = "<system-reminder>\nKeep answers short.\n</system-reminder>"

function heldReads(id: string, execIds = [1, 2]): HeldSession {
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
    writes,
  } as unknown as HeldSession
  sessionManager.registerSession(session)
  for (const execId of execIds) {
    sessionManager.registerPending(execId, session, "read_result", "read", false, { path: `/w/${execId}.ts` }, `call_${execId}`)
  }
  return session
}

const read2 = (file: string) => `Read file ${file}, lines 1-2\n1: alpha\n2: beta`
const user = (...texts: string[]) => ({ role: "user", content: texts.map((text) => ({ type: "text", text })) })
const assistant = (text: string) => ({ role: "assistant", content: [{ type: "text", text }] })
const calls = (sid: string, ids: number[]) => ({
  role: "assistant",
  content: ids.map((id) => ({ type: "tool-call", toolCallId: `cursor_${sid}_${id}`, toolName: "read", input: "{}" })),
})
const toolResult = (sid: string, execId: number) => ({
  role: "tool",
  content: [{ type: "tool-result", toolCallId: `cursor_${sid}_${execId}`, toolName: "read", output: { type: "text", value: read2(`/w/${execId}.ts`) } }],
})
const readStep = (sid: string) => [user("look at 1.ts and 2.ts"), calls(sid, [1, 2]), toolResult(sid, 1), toolResult(sid, 2)]

const clientMessages = (writes: Uint8Array[]): any[] =>
  writes.map((frame) => decodeMessage<any>("AgentClientMessage", frame))
const injections = (writes: Uint8Array[]): any[] =>
  clientMessages(writes).map((message) => message.conversation_action?.inject_context_action).filter((action) => action)
const execResults = (writes: Uint8Array[]): any[] =>
  clientMessages(writes).map((message) => message.exec_client_message).filter((message) => message)

const serverFrame = (update: Record<string, unknown>): Frame => ({
  flags: 0,
  payload: encodeMessage("AgentServerMessage", { interaction_update: update }),
})
const injectionState = (injectionId: string, state: Record<string, unknown>) =>
  serverFrame({ context_injection_state: { injection_id: injectionId, state } })
const turnEnded = () => serverFrame({ turn_ended: { input_tokens: 1, output_tokens: 1 } })

function serve(held: HeldSession, script: Array<() => Frame>): void {
  held.frames = {
    next: async () => {
      const frame = script.shift()
      return frame ? { done: false, value: frame() } : { done: true, value: undefined }
    },
  } as unknown as CursorSession["frames"]
}

async function stream(prompt: Prompt): Promise<{ parts: Array<{ type: string }>; fetched: string[] }> {
  const realFetch = globalThis.fetch
  const fetched: string[] = []
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    fetched.push(String(input))
    throw new Error("no network in this test")
  }) as unknown as typeof fetch
  try {
    const model = createCursor({ name: "cursor", accessToken: "token" }).languageModel("cursor-test")
    const result = await model.doStream({
      prompt,
      headers: { "x-opencode-session-id": OPENCODE_SESSION },
      tools: [{ type: "function", name: "read", description: "Read a file", inputSchema: { type: "object", properties: {} } }],
    } as LanguageModelV3CallOptions)
    const parts: Array<{ type: string }> = []
    const reader = result.stream.getReader()
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      parts.push(value)
    }
    return { parts, fetched }
  } finally {
    globalThis.fetch = realFetch
  }
}

let inboxSeq = 0
const hostSteer = (text: string, inboxID = `msg_early_${++inboxSeq}`): HostSteer => ({ sessionID: OPENCODE_SESSION, inboxID, text })

afterEach(() => {
  sessionManager.dispose()
  resetTurnStateForTests()
  forgetEarlySteers(OPENCODE_SESSION)
})

describe("host steer registry", () => {
  it("hands a steer only to the listener of its session", () => {
    const seen: HostSteer[] = []
    expect(announceHostSteer(hostSteer("early"))).toBe(false)
    const stop = listenForHostSteers(OPENCODE_SESSION, (steer) => { seen.push(steer); return true })
    expect(announceHostSteer({ ...hostSteer("other"), sessionID: "ses_other" })).toBe(false)
    expect(announceHostSteer(hostSteer("early"))).toBe(true)
    stop()
    expect(announceHostSteer(hostSteer("late"))).toBe(false)
    expect(seen.map((steer) => steer.text)).toEqual(["early"])
  })

  it("hands each inbox message over once, however many plugin copies announce it", () => {
    let calls = 0
    const stop = listenForHostSteers(OPENCODE_SESSION, () => { calls++; return true })
    const steer = hostSteer("twice")
    expect(announceHostSteer(steer)).toBe(true)
    expect(announceHostSteer({ ...steer })).toBeUndefined()
    rememberQueuedSteer(steer)
    expect(takeQueuedSteer(steer.inboxID)).toBeUndefined()
    stop()
    expect(calls).toBe(1)
  })

  it("keeps a newer listener when an older one stops", () => {
    const stopOld = listenForHostSteers(OPENCODE_SESSION, () => false)
    listenForHostSteers(OPENCODE_SESSION, () => true)
    stopOld()
    expect(announceHostSteer(hostSteer("still heard"))).toBe(true)
  })

  it("matches a promoted message carrying host parts before or after the text, once", () => {
    const record = (text: string, injectionId: string) =>
      recordEarlySteer({ ...hostSteer(text, injectionId), injectionId, conversationId: "conv", answered: false })
    record("also check 3.ts", "a")
    record("then stop", "b")
    const { remaining, taken } = takeEarlySteers(
      OPENCODE_SESSION,
      [`also check 3.ts\n${REMINDER}`, "unrelated", `skill text\nthen stop`],
      () => true,
    )
    expect(remaining).toEqual(["unrelated"])
    expect(taken.map((r) => r.injectionId)).toEqual(["a", "b"])
    expect(takeEarlySteers(OPENCODE_SESSION, ["also check 3.ts"], () => true).taken).toEqual([])
  })

  it("consumes nothing unless every message matches when asked for all", () => {
    recordEarlySteer({ ...hostSteer("one", "a"), injectionId: "a", conversationId: "conv", answered: true })
    expect(takeEarlySteers(OPENCODE_SESSION, ["one", "two"], () => true, true).taken).toEqual([])
    expect(takeEarlySteers(OPENCODE_SESSION, ["one"], (r) => !r.answered, true).taken).toEqual([])
    expect(takeEarlySteers(OPENCODE_SESSION, ["one"], (r) => r.answered, true).taken.length).toBe(1)
  })

  it("forgets records when a new user turn begins", () => {
    recordEarlySteer({ ...hostSteer("one", "a"), injectionId: "a", conversationId: "conv", answered: true })
    clearEarlySteers(OPENCODE_SESSION)
    expect(takeEarlySteers(OPENCODE_SESSION, ["one"], () => true).taken).toEqual([])
  })

  it("remembers a queued message until it becomes a steer", () => {
    rememberQueuedSteer(hostSteer("queued", "msg_q"))
    expect(takeQueuedSteer("msg_q")?.text).toBe("queued")
    expect(takeQueuedSteer("msg_q")).toBeUndefined()
  })
})

describe("a message sent while Cursor works on the step", () => {
  it("is injected into the pumping Run at once and needs no step of its own afterwards", async () => {
    const held = heldReads("pumping")
    let taken: boolean | undefined
    const injectionId = () => injections(held.writes)[0].injection_id
    serve(held, [
      () => {
        taken = announceHostSteer(hostSteer("change of plan"))
        return serverFrame({ thinking_delta: { text: "waiting on the shell" } })
      },
      () => injectionState(injectionId(), { queued: {} }),
      () => injectionState(injectionId(), { delivered: { step: 3 } }),
      () => serverFrame({ text_delta: { text: "STEERED" } }),
      turnEnded,
    ])

    await stream(readStep("pumping") as Prompt)

    expect(taken).toBe(true)
    expect(injections(held.writes)).toMatchObject([
      { expected_run_id: "run_pumping", user_context: { user_message: { text: "change of plan" } } },
    ])
    expect(announceHostSteer(hostSteer("after the pump"))).toBe(false)

    const writesBefore = held.writes.length
    const { parts, fetched } = await stream([
      ...readStep("pumping"),
      assistant("STEERED"),
      user("change of plan", REMINDER),
    ] as Prompt)
    expect(parts.map((part) => part.type)).toEqual(["stream-start", "finish"])
    expect((parts[1] as any).finishReason.unified).toBe("stop")
    expect(fetched).toEqual([])
    expect(held.writes.length).toBe(writesBefore)
  })

  it("is not injected again when OpenCode promotes it after the step's results", async () => {
    const held = heldReads("promoted")
    held.steerInjections = [{ id: "inj-early", text: "change of plan", state: "queued" }]
    recordEarlySteer({ ...hostSteer("change of plan"), injectionId: "inj-early", conversationId: held.conversationId, answered: false })
    serve(held, [
      () => injectionState("inj-early", { delivered: { step: 2 } }),
      () => serverFrame({ text_delta: { text: "ok" } }),
      turnEnded,
    ])

    await stream([...readStep("promoted"), user("change of plan", REMINDER)] as Prompt)

    expect(injections(held.writes)).toEqual([])
    expect(execResults(held.writes).map((message) => message.id)).toEqual([1, 2])
    expect(held.resultsAfterCheckpoint?.toolCallIds).toEqual(new Set(["cursor_promoted_1", "cursor_promoted_2"]))
  })

  it("is injected as a steer when the held Run is not the conversation that took it", async () => {
    const held = heldReads("elsewhere")
    recordEarlySteer({ ...hostSteer("change of plan"), injectionId: "inj-old", conversationId: "conv_gone", answered: false })
    serve(held, [
      () => injectionState(injections(held.writes)[0].injection_id, { delivered: { step: 2 } }),
      turnEnded,
    ])

    await stream([...readStep("elsewhere"), user("change of plan")] as Prompt)

    expect(injections(held.writes).map((action) => action.user_context.user_message.text)).toEqual(["change of plan"])
  })

  it("waits for the next step when it arrives while the Run's turn ends", async () => {
    const held = heldReads("ending")
    held.resumeCheckpoint = new Uint8Array([1])
    let duringFollowUp: boolean | undefined
    held.reopenWithUserMessage = async () => {
      duringFollowUp = announceHostSteer(hostSteer("too late for this turn"))
      serve(held, [() => serverFrame({ text_delta: { text: "ok" } }), turnEnded])
    }
    serve(held, [
      () => {
        announceHostSteer(hostSteer("change of plan"))
        return injectionState(injections(held.writes)[0].injection_id, { queued_for_next_turn: {} })
      },
      () => ({ flags: 0, payload: encodeMessage("AgentServerMessage", { conversation_checkpoint_update: Uint8Array.from([7, 7]) }) }),
      turnEnded,
    ])

    await stream(readStep("ending") as Prompt)

    expect(duringFollowUp).toBe(false)
    expect(injections(held.writes).map((action) => action.user_context.user_message.text)).toEqual(["change of plan"])
  })

  it("is left to the next step while the Run waits on the host's tools", () => {
    heldReads("held")
    expect(announceHostSteer(hostSteer("change of plan"))).toBe(false)
  })
})
