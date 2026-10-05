import { afterEach, describe, expect, it } from "bun:test"
import { encodeMessage } from "../src/protocol/messages.js"
import { toolsToDescriptors } from "../src/protocol/tools.js"
import { pump, resetTurnStateForTests } from "../src/language-model.js"
import { sessionManager, type CursorSession, type Frame } from "../src/session.js"

const frame = (message: Record<string, unknown>): Frame => ({
  flags: 0,
  payload: encodeMessage("AgentServerMessage", message),
})
const started = (callId: string, toolCall: Record<string, unknown>) =>
  frame({ interaction_update: { tool_call_started: { call_id: callId, tool_call: toolCall } } })
const completed = (callId: string, toolCall: Record<string, unknown>) =>
  frame({ interaction_update: { tool_call_completed: { call_id: callId, tool_call: toolCall } } })
const listed = (count: number) => frame({ interaction_update: { tool_requests_listed: { call_count: count } } })
const text = (value: string) => frame({ interaction_update: { text_delta: { text: value } } })
const shell = (id: number, callId: string) => [
  started(callId, { shell_tool_call: { args: { command: `echo ${callId}`, tool_call_id: callId } } }),
  frame({ exec_server_message: { id, shell_stream_args: { command: `echo ${callId}`, tool_call_id: callId } } }),
]
// Cursor answers a get_mcp_tools call itself: started, listed, completed, no exec.
const serverSideStep = [
  started("lookup", { get_mcp_tools_tool_call: {} }),
  listed(1),
  completed("lookup", { get_mcp_tools_tool_call: {} }),
]

/** Frames in order; `hold()` makes reads wait until `release()` (Cursor waiting for results). */
function scriptedFrames(initial: Frame[]) {
  const queue = [...initial]
  let waiting: ((result: IteratorResult<Frame>) => void) | undefined
  let reads = 0
  const frames: AsyncIterator<Frame> = {
    next: () => {
      reads++
      const next = queue.shift()
      if (next) return Promise.resolve({ done: false, value: next })
      return new Promise((resolve) => { waiting = resolve })
    },
  }
  return {
    frames,
    reads: () => reads,
    push(next: Frame) {
      if (waiting) {
        const resolve = waiting
        waiting = undefined
        resolve({ done: false, value: next })
      } else queue.push(next)
    },
  }
}

function fakeSession(frames: AsyncIterator<Frame>): CursorSession {
  const definitions = [{ name: "bash", description: "Shell" }]
  const tools = toolsToDescriptors(definitions, "opencode", [])
  return {
    sessionId: "parallel-session",
    conversationId: "parallel-conversation",
    stream: {
      write() {},
      end() {},
      destroy() {},
      frames: () => ({ [Symbol.asyncIterator]: () => frames }),
    } as any,
    frames,
    pending: new Map(),
    displayToolCalls: new Map(),
    nextBridgedExecId: 900_000,
    blobs: new Map(),
    toolCatalog: definitions,
    knownMcpServers: [],
    toolDescriptors: tools,
    requestContext: { tools },
    usageEstimate: { inputTokens: 0, outputTokens: 0, cacheRead: 0, cacheWrite: 0, reasoningTokens: 0 },
    allowTools: true,
    pumpActive: true,
    heartbeat: null,
    expiresAt: Date.now() + 10_000,
  } as unknown as CursorSession
}

async function pumpOnce(session: CursorSession) {
  const parts: any[] = []
  const controller = {
    enqueue(part: unknown) { parts.push(part) },
    error(error: Error) { throw error },
  } as unknown as ReadableStreamDefaultController<any>
  await pump(session, controller, { textId: "text", reasoningId: "reasoning" })
  return parts
}

const toolCallIds = (parts: any[]) => parts.filter((p) => p.type === "tool-call").map((p) => p.toolCallId)
const finishes = (parts: any[]) => parts.filter((p) => p.type === "finish").map((p) => p.finishReason.unified)

describe("parallel tool calls", () => {
  afterEach(() => {
    sessionManager.dispose()
    resetTurnStateForTests()
  })

  it("emits every call of a model step in one step, closing when Cursor's listed count is reached", async () => {
    // Order seen live: the first execs arrive while the model still generates,
    // `tool_requests_listed` follows once it is done, then the last call.
    const script = scriptedFrames([
      ...serverSideStep,
      ...shell(1, "a"),
      ...shell(2, "b"),
      listed(3),
      ...shell(3, "c"),
    ])
    const session = fakeSession(script.frames)

    const parts = await pumpOnce(session)

    expect(toolCallIds(parts)).toEqual([
      "cursor_parallel-session_1",
      "cursor_parallel-session_2",
      "cursor_parallel-session_3",
    ])
    expect(finishes(parts)).toEqual(["tool-calls"])
    expect([...session.pending.keys()]).toEqual([1, 2, 3])
    // The step closed on the count, without waiting for another frame.
    expect(script.reads()).toBe(10)
  })

  it("does not count the previous step's completed calls toward the current step", async () => {
    // Live: after the results of one step are delivered, Cursor closes those
    // calls (tool_call_completed) at the start of the next pass.
    const script = scriptedFrames([
      ...serverSideStep,
      completed("previous-step-call", { shell_tool_call: {} }),
      ...shell(1, "a"),
      started("b", { shell_tool_call: {} }),
      listed(2),
      ...shell(2, "b").slice(1),
    ])
    const session = fakeSession(script.frames)

    const parts = await pumpOnce(session)

    expect(toolCallIds(parts)).toEqual(["cursor_parallel-session_1", "cursor_parallel-session_2"])
    expect(finishes(parts)).toEqual(["tool-calls"])
  })

  it("ends the step at a single call when the listed count is already met", async () => {
    const script = scriptedFrames([...serverSideStep, started("a", { shell_tool_call: {} }), listed(1), ...shell(1, "a").slice(1)])
    const session = fakeSession(script.frames)

    const parts = await pumpOnce(session)

    expect(toolCallIds(parts)).toEqual(["cursor_parallel-session_1"])
    expect(finishes(parts)).toEqual(["tool-calls"])
  })

  it("keeps one call per step until Cursor has listed a call count in this process", async () => {
    const script = scriptedFrames([...shell(1, "a"), ...shell(2, "b")])
    const session = fakeSession(script.frames)

    const parts = await pumpOnce(session)

    expect(toolCallIds(parts)).toEqual(["cursor_parallel-session_1"])
    expect(finishes(parts)).toEqual(["tool-calls"])
    expect(script.reads()).toBe(2)
  })

  it("puts model output that follows held calls back for the next pass", async () => {
    const script = scriptedFrames([...serverSideStep, ...shell(1, "a"), text("Both done.")])
    const session = fakeSession(script.frames)

    const parts = await pumpOnce(session)

    expect(toolCallIds(parts)).toEqual(["cursor_parallel-session_1"])
    expect(finishes(parts)).toEqual(["tool-calls"])
    expect(parts.some((p) => p.type === "text-delta")).toBe(false)
    expect(session.queuedFrame).toBeDefined()
    expect(((await session.queuedFrame!).value as Frame).payload).toEqual(text("Both done.").payload)
  })

  it("closes a held step once the Run goes quiet, and the next read gets the late frame", async () => {
    const script = scriptedFrames([...serverSideStep, ...shell(1, "a")])
    const session = fakeSession(script.frames)

    const parts = await pumpOnce(session)

    expect(toolCallIds(parts)).toEqual(["cursor_parallel-session_1"])
    expect(finishes(parts)).toEqual(["tool-calls"])
    const late = text("after the quiet close")
    script.push(late)
    expect(session.queuedFrame).toBeDefined()
    expect(((await session.queuedFrame!).value as Frame).payload).toEqual(late.payload)
  }, 10_000)
})
