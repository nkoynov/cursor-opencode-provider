import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import fs from "node:fs"
import path from "node:path"
import type { LanguageModelV3StreamPart } from "@ai-sdk/provider"
import { deliverContinuationResults, pump, pumpWithRecovery, resetTurnStateForTests } from "../src/language-model.js"
import { noteToolRequestsListedSeen, resetToolRequestsListedSeenForTests } from "../src/parallel-step.js"
import { decodeMessage, encodeMessage } from "../src/protocol/messages.js"
import { toolsToDescriptors } from "../src/protocol/tools.js"
import { readSessionFrame, sessionManager, type Frame } from "../src/session.js"
import { sessionFixture } from "./session-fixture.js"

function frame(message: Record<string, unknown>): Frame {
  return { flags: 0, payload: encodeMessage("AgentServerMessage", message) }
}

const listed = (call_count: number) => frame({ interaction_update: { tool_requests_listed: { call_count } } })
const ended = () => frame({ interaction_update: { turn_ended: {} } })
const text = (value: string) => frame({ interaction_update: { text_delta: { text: value } } })
const shell = (id: number, tool_call_id = `call-${id}`) => frame({
  exec_server_message: { id, shell_stream_args: { command: "echo test", tool_call_id } },
})
const mode = (tool_call_id: string) => frame({ interaction_query: {
  id: 42,
  switch_mode_request_query: encodeMessage("SwitchModeRequestQuery", {
    args: { target_mode_id: "plan", tool_call_id },
  }),
} })
const question = (tool_call_id: string) => frame({ interaction_query: {
  id: 43,
  ask_question_interaction_query: encodeMessage("AskQuestionInteractionQuery", {
    tool_call_id,
    args: { questions: [{ id: "q", prompt: "Continue?", options: [{ id: "yes", label: "Yes" }] }] },
  }),
} })
const completed = (call_id: string) => frame({ interaction_update: { tool_call_completed: { call_id } } })

function fixture(frames: Frame[]) {
  const writes: Uint8Array[] = []
  let reads = 0
  const iterator: AsyncIterator<Frame> = {
    next: async () => {
      reads++
      const value = frames.shift()
      return value ? { done: false, value } : { done: true, value: undefined }
    },
  }
  const tools = [{ name: "bash", description: "Run shell command" }]
  const session = sessionFixture({
    sessionId: "parallel-pump", conversationId: "parallel-conversation",
    stream: {
      write(data) { writes.push(data) }, end() {}, destroy() {}, isClosed: () => false,
      onTerminal: () => () => {},
      frames: () => ({ [Symbol.asyncIterator]: () => iterator }),
    },
    frames: iterator, pending: new Map(), displayToolCalls: new Map(),
    nextBridgedExecId: 900_000, blobs: new Map(), toolCatalog: tools,
    toolDescriptors: toolsToDescriptors(tools, "opencode"), requestContext: {},
    allowTools: true, pumpActive: false, heartbeat: null,
    usageEstimate: { inputTokens: 0, outputTokens: 0, cacheRead: 0, cacheWrite: 0, reasoningTokens: 0 },
  })
  return { session, writes, reads: () => reads }
}

function collect() {
  const parts: LanguageModelV3StreamPart[] = []
  const controller = {
    desiredSize: 1, close() {},
    enqueue(part: LanguageModelV3StreamPart) { parts.push(part) },
    error(error: unknown) { throw error },
  } as ReadableStreamDefaultController<LanguageModelV3StreamPart>
  return { parts, controller }
}

const ids = { textId: "text", reasoningId: "reasoning" }
const toolCalls = (parts: LanguageModelV3StreamPart[]) => parts.filter(p => p.type === "tool-call")
const finishes = (parts: LanguageModelV3StreamPart[]) => parts.filter(p => p.type === "finish")

describe("parallel tool-call pump", () => {
  beforeEach(resetToolRequestsListedSeenForTests)
  afterEach(() => {
    sessionManager.dispose()
    resetToolRequestsListedSeenForTests()
    resetTurnStateForTests()
  })

  it("emits three calls before one finish when the count arrives after the second", async () => {
    noteToolRequestsListedSeen()
    const { session, writes, reads } = fixture([shell(1), shell(2), listed(3), text("between"), shell(3), ended()])
    const { parts, controller } = collect()
    await pump(session, controller, ids)
    expect(toolCalls(parts)).toHaveLength(3)
    expect(finishes(parts).map(p => p.finishReason.unified)).toEqual(["tool-calls"])
    expect(reads()).toBe(5)
    expect(session.pending.size).toBe(3)
    expect(session.closed).toBe(false)
    const results = toolCalls(parts).map((p, i) => ({
      toolCallId: p.toolCallId, sessionId: session.sessionId, execId: i + 1,
      toolName: p.toolName, output: "done",
    }))
    expect(deliverContinuationResults(session, results)).toBe(session)
    expect(session.pending.size).toBe(0)
    expect(writes.length).toBeGreaterThanOrEqual(3)
    await pump(session, controller, ids)
    expect(finishes(parts).map(p => p.finishReason.unified)).toEqual(["tool-calls", "stop"])
  })

  it("finishes a counted single call immediately", async () => {
    const { session, reads } = fixture([listed(1), shell(1), ended()])
    const { controller } = collect()
    await pump(session, controller, ids)
    expect(reads()).toBe(2)
    expect(session.parallelStep).toBeUndefined()
  })

  it("preserves immediate one-call steps before capability discovery", async () => {
    const { session, reads } = fixture([shell(1), shell(2)])
    await pump(session, collect().controller, ids)
    expect(reads()).toBe(1)
    expect(session.pending.size).toBe(1)
  })

  it("counts an internally approved interaction after an emitted exec", async () => {
    const { session, reads } = fixture([listed(2), shell(1), mode("mode-call"), text("next-generation")])
    const { parts, controller } = collect()
    await pump(session, controller, ids)
    expect(reads()).toBe(3)
    expect(toolCalls(parts)).toHaveLength(1)
    expect(finishes(parts).map(p => p.finishReason.unified)).toEqual(["tool-calls"])
  })

  it("counts a refused binary write and finishes without reading the next generation", async () => {
    const binary = frame({ exec_server_message: { id: 2, write_args: {
      path: "/workspace/assets/test.png", file_bytes: Uint8Array.of(0, 255, 0), tool_call_id: "binary-call",
    } } })
    const { session, reads } = fixture([listed(2), shell(1), binary, text("next-generation")])
    await pump(session, collect().controller, ids)
    expect(reads()).toBe(3)
    expect(session.pending.size).toBe(1)
  })

  it.each([false, true])("counts a streamed edit only after its write (patch catalog: %s)", async patch => {
    const root = fs.mkdtempSync("/tmp/cursor-parallel-edit-")
    const target = path.join(root, "target.ts")
    fs.writeFileSync(target, "export const value = 1\n")
    const { session, reads, writes } = fixture([
      listed(2), shell(1),
      frame({ interaction_update: { tool_call_started: {
        call_id: "edit", tool_call: { edit_tool_call: { args: { path: target } } },
      } } }),
      frame({ exec_server_message: { id: 2, read_args: { path: target, tool_call_id: "edit" } } }),
      frame({ exec_server_message: { id: 3, write_args: {
        path: target, file_text: "export const value = 2\n", tool_call_id: "edit",
      } } }),
      text("later"),
    ])
    const tools = [...session.toolCatalog!, { name: "read", description: "Read" },
      ...(patch ? [{ name: "apply_patch", description: "Patch" }]
        : [{ name: "write", description: "Write" }, { name: "edit", description: "Edit" }]),
    ]
    session.toolCatalog = tools
    session.toolDescriptors = toolsToDescriptors(tools, "opencode")
    session.requestContext.env = { workspace_paths: [root] }
    try {
      const { parts, controller } = collect()
      await pump(session, controller, ids)
      expect(reads()).toBe(5)
      expect(toolCalls(parts).map(p => p.toolName)).toEqual(["bash", patch ? "apply_patch" : "edit"])
      expect(finishes(parts)).toHaveLength(1)
      expect(session.pending.size).toBe(2)
      expect(session.pending.has(2)).toBe(false)
      expect(decodeMessage<any>("AgentClientMessage", writes[0]!).exec_client_message.read_result.success.content)
        .toBe("export const value = 1\n")
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  it("includes a display-only todo mirror in the same host step", async () => {
    const tool_call = { update_todos_tool_call: { args: {
      todos: [{ id: "todo", content: "Review", status: 1 }],
    } } }
    const { session, reads } = fixture([
      listed(2), shell(1),
      frame({ interaction_update: { tool_call_started: { call_id: "todo-call", tool_call } } }),
      frame({ interaction_update: { tool_call_completed: { call_id: "todo-call", tool_call } } }),
      text("later"),
    ])
    const tools = [...session.toolCatalog!, { name: "todowrite", description: "Todos" }]
    session.toolCatalog = tools
    session.toolDescriptors = toolsToDescriptors(tools, "opencode")
    const { parts, controller } = collect()
    await pump(session, controller, ids)
    expect(reads()).toBe(4)
    expect(toolCalls(parts).map(p => p.toolName)).toEqual(["bash", "todowrite"])
    expect(finishes(parts)).toHaveLength(1)
    expect(session.pending.size).toBe(2)
  })

  it("retains refusals that precede the first count in the process", async () => {
    const { session, writes, reads } = fixture([question("refused"), listed(2), shell(1), text("later")])
    await pump(session, collect().controller, ids)
    expect(reads()).toBe(3)
    expect(decodeMessage<any>("AgentClientMessage", writes[0]!).interaction_response.id).toBe(43)
  })

  it("clears all-internal and zero-call generations before the next host step", async () => {
    const { session, reads } = fixture([listed(0), listed(1), question("refused"), listed(2), shell(1), shell(2)])
    const { parts, controller } = collect()
    await pump(session, controller, ids)
    expect(reads()).toBe(6)
    expect(toolCalls(parts)).toHaveLength(2)
    expect(session.priorParallelStepCallIds?.has("refused")).toBe(true)
  })

  it("counts a server-side completion without a separate start frame", async () => {
    const { session, reads } = fixture([listed(2), shell(1), completed("server-tool"), text("later")])
    await pump(session, collect().controller, ids)
    expect(reads()).toBe(3)
    expect(session.pending.size).toBe(1)
  })

  it("ignores duplicate completions and calls from every earlier step", async () => {
    const { session, reads } = fixture([
      listed(1), shell(1), listed(1), shell(2),
      listed(2), shell(3), completed("call-1"), completed("call-2"), completed("call-3"), shell(4),
    ])
    await pump(session, collect().controller, ids)
    sessionManager.resolve(session.sessionId, 1)
    await pump(session, collect().controller, ids)
    sessionManager.resolve(session.sessionId, 2)
    const { parts, controller } = collect()
    await pump(session, controller, ids)
    expect(reads()).toBe(10)
    expect(toolCalls(parts)).toHaveLength(2)
  })

  it("lets a title Run discover the capability without owning the parent's step", async () => {
    const title = fixture([listed(0), ended()]).session
    title.allowTools = false
    await pump(title, collect().controller, ids)
    const { session } = fixture([shell(1), shell(2), listed(2)])
    const { parts, controller } = collect()
    await pump(session, controller, ids)
    expect(toolCalls(parts)).toHaveLength(2)
  })

  it.each([false, true])("bridges human prompts in a held step (known count: %s)", async known => {
    noteToolRequestsListedSeen()
    const { session, reads } = fixture([
      ...(known ? [listed(3)] : []), shell(1), question("human"), shell(2),
    ])
    const tools = [...session.toolCatalog!, { name: "question", description: "Ask" }]
    session.toolCatalog = tools
    session.toolDescriptors = toolsToDescriptors(tools, "opencode")
    const { parts, controller } = collect()
    await pump(session, controller, ids)
    expect(toolCalls(parts)).toHaveLength(known ? 3 : 2)
    expect(reads()).toBe(known ? 4 : 2)
  })

  it("services KV inline without counting it as a tool", async () => {
    const kv = frame({ kv_server_message: { id: 50, get_blob_args: { blob_id: Uint8Array.of(1) } } })
    const { session, writes } = fixture([listed(2), shell(1), kv, shell(2)])
    const { parts, controller } = collect()
    await pump(session, controller, ids)
    expect(toolCalls(parts)).toHaveLength(2)
    expect(decodeMessage<any>("AgentClientMessage", writes[0]!).kv_client_message.id).toBe(50)
  })

  it("uses raw CLI field 15 deltas as progress for the idle guard", async () => {
    // AgentServerMessage #1 / InteractionUpdate #15 / empty delta update.
    const delta: Frame = { flags: 0, payload: Uint8Array.of(0x0a, 0x02, 0x7a, 0x00) }
    const { session } = fixture([listed(2), shell(1), delta, shell(2)])
    const next = session.frames.next.bind(session.frames)
    let reads = 0
    let recent = false
    session.frames.next = () => {
      reads++
      if (reads === 3) session.parallelStep!.lastProgressAt = Date.now() - 1_400
      if (reads === 4) recent = Date.now() - session.parallelStep!.lastProgressAt < 100
      return next()
    }
    await pump(session, collect().controller, ids)
    expect(recent).toBe(true)
  })

  it("does not extend a held step for request-context control probes", async () => {
    const probe = frame({ exec_server_message: { id: 40, request_context_args: {} } })
    const { session, writes } = fixture([listed(2), shell(1), probe, shell(2)])
    const next = session.frames.next.bind(session.frames)
    let reads = 0
    let stale = false
    session.frames.next = () => {
      reads++
      if (reads === 3) session.parallelStep!.lastProgressAt = Date.now() - 1_400
      if (reads === 4) stale = Date.now() - session.parallelStep!.lastProgressAt >= 1_400
      return next()
    }
    await pump(session, collect().controller, ids)
    expect(stale).toBe(true)
    expect(decodeMessage<any>("AgentClientMessage", writes[0]!).exec_client_message.id).toBe(40)
  })

  it("clears an aborted step's emission state while retaining its pending exec", async () => {
    const abort = new AbortController()
    const { session } = fixture([listed(2), shell(1), listed(1), shell(2)])
    const first = collect()
    const enqueue = first.controller.enqueue.bind(first.controller)
    first.controller.enqueue = part => {
      enqueue(part)
      if (part?.type === "tool-call") abort.abort()
    }
    await pump(session, first.controller, ids, abort.signal)
    expect(session.pending.size).toBe(1)
    expect(session.parallelStep).toBeUndefined()
    sessionManager.resolve(session.sessionId, 1)
    const second = collect()
    await pump(session, second.controller, ids)
    expect(toolCalls(second.parts)).toHaveLength(1)
  })

  it.each(["eof", "error"])("retains late %s after a frame-read timeout", async kind => {
    const { session } = fixture([])
    let finish: (result: IteratorResult<Frame>) => void = () => {}
    let fail: (error: Error) => void = () => {}
    const pending = new Promise<IteratorResult<Frame>>((resolve, reject) => { finish = resolve; fail = reject })
    let reads = 0
    session.frames = { next: () => { reads++; return pending } }
    expect(await readSessionFrame(session, 1)).toMatchObject({ timedOut: true })
    if (kind === "eof") finish({ done: true, value: undefined })
    else fail(new Error("late failure"))
    await new Promise(resolve => setTimeout(resolve, 1))
    if (kind === "eof") expect(await readSessionFrame(session)).toMatchObject({ done: true })
    else await expect(readSessionFrame(session)).rejects.toThrow("late failure")
    expect(reads).toBe(1)
    expect(session.pendingFrameRead).toBeUndefined()
  })

  it("keeps pending results when TurnEnded arrives during a hold", async () => {
    const { session } = fixture([listed(2), shell(1), ended()])
    const { parts, controller } = collect()
    await pump(session, controller, ids)
    expect(finishes(parts).map(p => p.finishReason.unified)).toEqual(["tool-calls"])
    expect(session.pending.size).toBe(1)
    expect(session.closed).toBe(false)
    sessionManager.resolve(session.sessionId, 1)
    await pump(session, controller, ids)
    expect(finishes(parts).map(p => p.finishReason.unified)).toEqual(["tool-calls", "stop"])
  })

  it.each(["eof", "error", "envelope"])("does not recover after emitting tools before %s", async kind => {
    const terminal: Frame = { flags: 2, payload: new TextEncoder().encode('{"error":{"code":"unavailable","message":"closed"}}') }
    const { session } = fixture([listed(2), shell(1), ...(kind === "envelope" ? [terminal] : [])])
    if (kind === "error") {
      const next = session.frames.next.bind(session.frames)
      let read = 0
      session.frames.next = () => ++read === 3 ? Promise.reject(new Error("closed")) : next()
    }
    // A checkpoint must not make replay eligible after host side effects.
    session.resumeCheckpoint = Uint8Array.of(1)
    const { parts, controller } = collect()
    let recoveries = 0
    await pumpWithRecovery({ initialSession: session, controller, recover: async () => {
      recoveries++
      return fixture([ended()]).session
    } })
    expect(recoveries).toBe(0)
    expect(finishes(parts).map(p => p.finishReason.unified)).toEqual(["tool-calls"])
    expect(session.closed).toBe(true)
  })

  it("retains a guard-timed-out iterator read for the continuation", async () => {
    noteToolRequestsListedSeen()
    const { session } = fixture([])
    let release: (value: IteratorResult<Frame>) => void = () => {}
    const waiting = new Promise<IteratorResult<Frame>>(resolve => { release = resolve })
    let reads = 0
    session.frames = { next: () => {
      reads++
      if (reads === 1) return Promise.resolve({ done: false, value: shell(1) })
      if (reads === 2) return waiting
      return Promise.resolve({ done: false, value: ended() })
    } }
    const first = collect()
    await pump(session, first.controller, ids)
    expect(reads).toBe(2)
    sessionManager.resolve(session.sessionId, 1)
    const second = collect()
    const continuation = pump(session, second.controller, ids)
    await Promise.resolve()
    expect(reads).toBe(2)
    release({ done: false, value: text("retained") })
    await continuation
    expect(second.parts.filter(p => p.type === "text-delta").map(p => p.delta).join("")).toBe("retained")
  })
})
