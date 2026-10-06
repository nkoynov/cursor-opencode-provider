import { afterEach, describe, expect, it } from "bun:test"
import { SessionActivityTracker } from "../src/activity.js"
import {
  deliverContinuationResults,
  pendingExecIds,
  preparePriorSessionForFreshTurn,
  pumpWithRecovery,
  resetTurnStateForTests,
} from "../src/language-model.js"
import { decodeMessage, encodeMessage } from "../src/protocol/messages.js"
import { toolsToDescriptors } from "../src/protocol/tools.js"
import { SessionManager, sessionManager, type CursorSession, type Frame } from "../src/session.js"
import { resetCursorShellCalls } from "../src/shell-timeout.js"

const frame = (message: Record<string, unknown>, flags = 0): Frame => ({
  flags,
  payload: encodeMessage("AgentServerMessage", message),
})
const text = (value: string) => frame({ interaction_update: { text_delta: { text: value } } })
const heartbeat = () => frame({ interaction_update: { heartbeat: {} } })
const turnEnded = () => frame({ interaction_update: { turn_ended: { input_tokens: 1, output_tokens: 1 } } })
const execAbort = (id: number) => frame({ exec_server_control_message: { abort: { id } } })
const kvSet = (id: number) => frame({
  kv_server_message: { id, set_blob_args: { blob_id: Uint8Array.from([id, 1, 2, 3]), blob_data: Uint8Array.from([4, 5]) } },
})
const listed = (count: number) => frame({ interaction_update: { tool_requests_listed: { call_count: count } } })
const shell = (id: number, callId: string) => [
  frame({ interaction_update: { tool_call_started: { call_id: callId, tool_call: { shell_tool_call: { args: { command: "sleep 60", tool_call_id: callId } } } } } }),
  frame({ exec_server_message: { id, shell_stream_args: { command: "sleep 60", tool_call_id: callId } } }),
]

/** Frames in order; a read past the end waits for `push` (Cursor is quiet). */
function scriptedFrames(initial: Frame[] = []) {
  const queue = [...initial]
  let waiting: ((result: IteratorResult<Frame>) => void) | undefined
  const frames: AsyncIterator<Frame> = {
    next: () => {
      const next = queue.shift()
      if (next) return Promise.resolve({ done: false, value: next })
      return new Promise((resolve) => { waiting = resolve })
    },
  }
  return {
    frames,
    push(...next: Frame[]) {
      for (const item of next) {
        if (waiting) {
          const resolve = waiting
          waiting = undefined
          resolve({ done: false, value: item })
        } else queue.push(item)
      }
    },
  }
}

type Held = CursorSession & { writes: Uint8Array[] }
let seq = 0

function heldSession(frames: AsyncIterator<Frame>): Held {
  const writes: Uint8Array[] = []
  const definitions = [{ name: "bash", description: "Shell" }]
  const tools = toolsToDescriptors(definitions, "opencode", [])
  const session = {
    sessionId: `abort_${++seq}`,
    conversationId: `conv_abort_${seq}`,
    runId: `run_${seq}`,
    openCodeSessionId: `ses_abort_${seq}`,
    stream: {
      write(data: Uint8Array) { writes.push(data); return true },
      end() {},
      destroy() {},
      isClosed: () => false,
      frames: () => ({ [Symbol.asyncIterator]: () => frames }),
    },
    frames,
    pending: new Map(),
    displayToolCalls: new Map(),
    nextBridgedExecId: 900_000,
    blobs: new Map(),
    toolCatalog: definitions,
    knownMcpServers: [],
    toolDescriptors: tools,
    requestContext: { tools, env: { workspace_paths: ["/w"] } },
    usageEstimate: { inputTokens: 0, outputTokens: 0, cacheRead: 0, cacheWrite: 0, reasoningTokens: 0 },
    allowTools: true,
    pumpActive: false,
    heartbeat: null,
    writes,
  } as unknown as Held
  sessionManager.registerSession(session)
  return session
}

const clientMessages = (writes: Uint8Array[]): any[] => writes.map((data) => decodeMessage<any>("AgentClientMessage", data))
const execResults = (writes: Uint8Array[]) =>
  clientMessages(writes).map((message) => message.exec_client_message).filter((message) => message)

function collector() {
  const parts: any[] = []
  const controller = {
    enqueue(part: unknown) { parts.push(part) },
    close() {},
    error() {},
  } as unknown as ReadableStreamDefaultController<any>
  return { parts, controller }
}

const until = async (check: () => boolean) => {
  for (let i = 0; i < 200 && !check(); i++) await Bun.sleep(5)
}

const shellResult = (session: CursorSession, execId: number) => ({
  toolCallId: `cursor_${session.sessionId}_${execId}`,
  sessionId: session.sessionId,
  execId,
  toolName: "shell",
  output: "done",
})

afterEach(() => {
  sessionManager.dispose()
  resetCursorShellCalls()
  resetTurnStateForTests()
})

describe("Cursor's exec abort (ExecServerControlMessage.abort)", () => {
  it("is answered while the host still runs the tool, and leaves other frames for the pump", async () => {
    const script = scriptedFrames([listed(1), ...shell(1, "a")])
    const session = heldSession(script.frames)
    const { controller, parts } = collector()
    await pumpWithRecovery({ initialSession: session, controller, recover: async () => { throw new Error("no") } })
    expect(parts.filter((part) => part.type === "tool-call").map((part) => part.toolCallId)).toEqual([`cursor_${session.sessionId}_1`])
    expect(pendingExecIds(session)).toEqual([1])

    script.push(kvSet(7), heartbeat(), execAbort(1), text("Moving on."))
    await until(() => session.pending.get(1)?.aborted === true && session.queuedFrame !== undefined)

    expect(clientMessages(session.writes).map((message) => message.kv_client_message?.id).filter((id) => id !== undefined)).toEqual([7])
    expect(session.pending.get(1)?.aborted).toBe(true)
    expect(pendingExecIds(session)).toEqual([])
    const queued = await session.queuedFrame!
    expect((queued.value as Frame).payload).toEqual(text("Moving on.").payload)
  })

  it("leaves a KV read on the held Run to the pump", async () => {
    const script = scriptedFrames([listed(1), ...shell(1, "a")])
    const session = heldSession(script.frames)
    const { controller } = collector()
    await pumpWithRecovery({ initialSession: session, controller, recover: async () => { throw new Error("no") } })

    const get = frame({ kv_server_message: { id: 8, get_blob_args: { blob_id: Uint8Array.from([8, 1, 2, 3]) } } })
    script.push(get)
    await until(() => session.queuedFrame !== undefined)
    await Bun.sleep(10)

    expect(clientMessages(session.writes).filter((message) => message.kv_client_message)).toEqual([])
    expect(((await session.queuedFrame!).value as Frame).payload).toEqual(get.payload)
  })

  it("drops the host's late result without a write and keeps the same Run", () => {
    const session = heldSession(scriptedFrames().frames)
    sessionManager.registerPending(1, session, "shell_stream", "shell")
    sessionManager.registerPending(2, session, "shell_stream", "shell")
    expect(sessionManager.markExecAborted(session, 1)).toBe(true)

    const continued = deliverContinuationResults(session, [shellResult(session, 1), shellResult(session, 2)])

    expect(continued).toBe(session)
    expect([...new Set(execResults(session.writes).map((message) => message.id))]).toEqual([2])
    expect(session.pending.size).toBe(0)
  })

  it("is not answered with an error when the host starts a new turn", async () => {
    const script = scriptedFrames([turnEnded()])
    const session = heldSession(script.frames)
    sessionManager.registerPending(3, session, "shell_stream", "shell")
    sessionManager.markExecAborted(session, 3)

    expect(await preparePriorSessionForFreshTurn(session.openCodeSessionId, { timeoutMs: 200 })).toBe("drained")
    expect(execResults(session.writes)).toEqual([])
  })

  it("no longer holds the Run for the host's running tool", () => {
    let now = Date.now()
    const timers: Array<{ at: number; fn: () => void; live: boolean }> = []
    const tracker = new SessionActivityTracker()
    const manager = new SessionManager({
      now: () => now,
      setTimer: (fn, delayMs) => {
        const timer = { at: now + delayMs, fn, live: true }
        timers.push(timer)
        return timer as unknown as ReturnType<typeof setTimeout>
      },
      clearTimer: (timer) => { (timer as unknown as { live: boolean }).live = false },
      activitySource: tracker,
    })
    const advance = (ms: number) => {
      const target = now + ms
      for (;;) {
        const due = timers.filter((timer) => timer.live && timer.at <= target).sort((a, b) => a.at - b.at)[0]
        if (!due) break
        now = due.at
        due.live = false
        due.fn()
      }
      now = target
    }
    const session = heldSession(scriptedFrames().frames)
    sessionManager.close(session, "ordinary-cleanup")
    session.closed = false
    manager.registerPending(1, session, "shell_stream", "shell")
    tracker.toolStarted(session.openCodeSessionId!, `cursor_${session.sessionId}_1`)
    advance(20 * 60_000)
    expect(session.closed).toBe(false)

    manager.markExecAborted(session, 1)
    advance(10 * 60_000)
    expect(session.closed).toBe(true)
  })
})
