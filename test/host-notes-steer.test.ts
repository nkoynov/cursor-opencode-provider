import { describe, it, expect, afterEach } from "bun:test"
import type { LanguageModelV3CallOptions } from "@ai-sdk/provider"
import { sessionManager, type CursorSession } from "../src/session.js"
import {
  cancelRunForHostInterrupt,
  deliverContinuationResults,
  extractTrailingToolResults,
  preparePriorSessionForFreshTurn,
  prepareUserTurnHostNotes,
  pump,
  releaseHostNoteInjectionsForTests,
  resetTurnStateForTests,
} from "../src/language-model.js"
import { decodeMessage, encodeMessage } from "../src/protocol/messages.js"
import { resetCursorShellCalls } from "../src/shell-timeout.js"
import { toolsToDescriptors } from "../src/protocol/tools.js"
import { resetConversationBindingsForTests, restoreConversationBinding } from "../src/protocol/conversation-bind.js"
import { resetCheckpointsForTests } from "../src/protocol/checkpoint.js"
import { resetConversationPersistenceForTests } from "../src/protocol/conversation-persistence.js"
import { hydrateConversationState } from "../src/protocol/conversation-state.js"
import { decodePersistedHostNotes } from "../src/protocol/host-notes.js"
import fs from "node:fs"
import path from "node:path"

type Prompt = LanguageModelV3CallOptions["prompt"]

const NOTE = "<system-update>\nInstructions from: /repo/pkg/AGENTS.md\nIndent with tabs.\n</system-update>"
const NOTE_TEXT = "Instructions from: /repo/pkg/AGENTS.md\nIndent with tabs."
const LATER = "<system-update>\nThe subagent finished: 3 files changed.\n</system-update>"
const LATER_TEXT = "The subagent finished: 3 files changed."

let seq = 0
function heldRun(writes: Uint8Array[], frames: Array<{ flags: number; payload: Uint8Array }> = []): CursorSession {
  const id = `steernotes${++seq}`
  const next = async () => frames.length > 0 ? { done: false, value: frames.shift()! } : { done: true, value: undefined }
  return {
    sessionId: id,
    conversationId: `conv-${id}`,
    runId: `run-${id}`,
    openCodeSessionId: `ses_${id}`,
    stream: {
      write(frame: Uint8Array) { writes.push(frame) },
      end() {},
      frames: () => ({ [Symbol.asyncIterator]: () => ({ next }) }),
      destroy() {},
      isClosed: () => false,
    } as any,
    frames: { next } as any,
    pending: new Map(),
    blobs: new Map(),
    displayToolCalls: new Map(),
    toolDescriptors: [],
    requestContext: { env: { workspace_paths: ["/tmp"] } },
    usageEstimate: { inputTokens: 0, outputTokens: 0, cacheRead: 0, cacheWrite: 0, reasoningTokens: 0 },
    allowTools: true,
    pumpActive: false,
    heartbeat: null,
    expiresAt: Date.now() + 10_000,
  } as unknown as CursorSession
}

function readResult(live: CursorSession, execId: number): Prompt[number] {
  sessionManager.registerPending(execId, live, "read_result", "read", false, { path: "/tmp/a.ts" })
  return {
    role: "tool",
    content: [{
      type: "tool-result",
      toolCallId: `cursor_${live.sessionId}_${execId}`,
      toolName: "read",
      output: { type: "text", value: "Read file /tmp/a.ts, lines 1-1\n1: alpha" },
    }],
  } as Prompt[number]
}

const user = (text: string) => ({ role: "user", content: [{ type: "text", text }] }) as Prompt[number]

function clientMessages(writes: Uint8Array[]): any[] {
  return writes.map((frame) => decodeMessage<any>("AgentClientMessage", frame))
}

function injected(writes: Uint8Array[]): Array<{ id: string; text: string }> {
  return clientMessages(writes)
    .map((message) => message.conversation_action?.inject_context_action)
    .filter((action) => action !== undefined)
    .map((action) => ({ id: action.injection_id, text: action.user_context.user_message.text }))
}

function injectionState(injectionId: string, state: Record<string, unknown>) {
  return {
    flags: 0,
    payload: encodeMessage("AgentServerMessage", {
      interaction_update: { context_injection_state: { injection_id: injectionId, state } },
    }),
  }
}

const turnEnded = () => ({
  flags: 0,
  payload: encodeMessage("AgentServerMessage", { interaction_update: { turn_ended: { input_tokens: 1, output_tokens: 1 } } }),
})

function collect() {
  return { enqueue() {}, error() {}, close() {}, desiredSize: 1 } as unknown as ReadableStreamDefaultController<any>
}

afterEach(() => {
  sessionManager.dispose()
  resetTurnStateForTests()
  resetCursorShellCalls()
  resetConversationPersistenceForTests()
  resetConversationBindingsForTests()
  resetCheckpointsForTests()
})

describe("host notes in a steer step", () => {
  it("injects the step's notes, then the steer's messages and notes, after the results in prompt order", async () => {
    const writes: Uint8Array[] = []
    const live = heldRun(writes)
    sessionManager.registerSession(live)
    const results = extractTrailingToolResults([user("go"), readResult(live, 1), user(NOTE)] as Prompt)

    expect(await deliverContinuationResults(live, results, {
      steer: [{ text: "also check b.ts" }, { text: LATER, hostNote: true }, { text: "then stop" }],
    })).toBe(live)

    const messages = clientMessages(writes)
    const readAt = messages.findIndex((message) => message.exec_client_message?.read_result)
    const firstInjection = messages.findIndex((message) => message.conversation_action?.inject_context_action)
    expect(firstInjection).toBeGreaterThan(readAt)
    expect(injected(writes).map((injection) => injection.text)).toEqual([NOTE_TEXT, "also check b.ts", LATER_TEXT, "then stop"])
    expect(live.steerInjections?.map((injection) => injection.text)).toEqual(["also check b.ts", "then stop"])
  })

  it("tracks a steer's acknowledgement on the Run and a note's in the note store, from one handler", async () => {
    const writes: Uint8Array[] = []
    const live = heldRun(writes)
    sessionManager.registerSession(live)
    const results = extractTrailingToolResults([user("go"), readResult(live, 1)] as Prompt)
    await deliverContinuationResults(live, results, { steer: [{ text: "also check b.ts" }, { text: LATER, hostNote: true }] })
    const [steer, note] = injected(writes)

    const frames = [
      injectionState(steer!.id, { delivered: {} }),
      injectionState(note!.id, { rejected: { reason: "too late" } }),
      turnEnded(),
    ]
    live.frames = {
      next: async () => frames.length > 0 ? { done: false, value: frames.shift()! } : { done: true, value: undefined },
    } as CursorSession["frames"]
    await pump(live, collect(), { textId: "t", reasoningId: "r" })

    expect(releaseHostNoteInjectionsForTests(live.openCodeSessionId!)).toEqual({ inFlight: [], undelivered: [LATER] })
  })

  it("injects a message an earlier delivery of the same results did not carry", async () => {
    const writes: Uint8Array[] = []
    const live = heldRun(writes)
    sessionManager.registerSession(live)
    const results = extractTrailingToolResults([user("go"), readResult(live, 1), user(NOTE)] as Prompt)

    await deliverContinuationResults(live, results)
    await deliverContinuationResults(live, results, { steer: [{ text: "also check b.ts" }, { text: LATER, hostNote: true }] })

    expect(injected(writes).map((injection) => injection.text)).toEqual([NOTE_TEXT, "also check b.ts", LATER_TEXT])
  })

  it("does not inject a step's notes or messages again when its results were already delivered", async () => {
    const writes: Uint8Array[] = []
    const live = heldRun(writes)
    sessionManager.registerSession(live)
    const results = extractTrailingToolResults([user("go"), readResult(live, 1), user(NOTE)] as Prompt)
    const steer = [{ text: "also check b.ts" }]

    await deliverContinuationResults(live, results, { steer })
    await deliverContinuationResults(live, results, { steer })

    expect(injected(writes).map((injection) => injection.text)).toEqual([NOTE_TEXT, "also check b.ts"])
  })
})

describe("host notes of a Run the host leaves", () => {
  it("keeps an unacknowledged note for the next user turn when the host stops the turn", async () => {
    const writes: Uint8Array[] = []
    const live = heldRun(writes, [{ flags: 0x02, payload: new Uint8Array() }])
    sessionManager.registerSession(live)
    await deliverContinuationResults(live, extractTrailingToolResults([user("go"), readResult(live, 1), user(NOTE)] as Prompt))
    expect(injected(writes)).toHaveLength(1)

    await cancelRunForHostInterrupt(live, "user", { graceMs: 200 })

    expect(live.closed).toBe(true)
    expect(releaseHostNoteInjectionsForTests(live.openCodeSessionId!)).toEqual({ inFlight: [], undelivered: [NOTE] })
  })

  it("keeps an unacknowledged note when a fresh turn supersedes a Run that never ends its turn", async () => {
    const writes: Uint8Array[] = []
    const prior = heldRun(writes)
    sessionManager.registerSession(prior)
    await deliverContinuationResults(prior, extractTrailingToolResults([user("go"), readResult(prior, 1), user(NOTE)] as Prompt))
    prior.frames = {
      next: async () => ({ done: false, value: { flags: 0x02, payload: new Uint8Array() } }),
    } as CursorSession["frames"]

    expect(await preparePriorSessionForFreshTurn(prior.openCodeSessionId!, { timeoutMs: 1_000 })).toBe("settled-only")

    expect(releaseHostNoteInjectionsForTests(prior.openCodeSessionId!)).toEqual({ inFlight: [], undelivered: [NOTE] })
  })
})

describe("host notes in the snapshot of a held Run", () => {
  it("saves deferred and unacknowledged notes when the Run waits on its next tool call", async () => {
    const root = fs.mkdtempSync(path.join("/tmp", "cursor-steer-notes-"))
    try {
      const writes: Uint8Array[] = []
      const exec = {
        flags: 0,
        payload: encodeMessage("AgentServerMessage", {
          exec_server_message: { id: 2, shell_stream_args: { command: "echo b", tool_call_id: "call-b" } },
        }),
      }
      const checkpoint = { flags: 0, payload: encodeMessage("AgentServerMessage", { conversation_checkpoint_update: Uint8Array.from([7]) }) }
      const live = heldRun(writes, [checkpoint, exec])
      live.cacheDir = root
      const tools = [{ name: "read", description: "Read" }, { name: "bash", description: "Run shell command" }]
      live.toolCatalog = tools
      live.toolDescriptors = toolsToDescriptors(tools, "opencode")
      restoreConversationBinding(live.openCodeSessionId!, live.conversationId)
      sessionManager.registerSession(live)
      await deliverContinuationResults(live, extractTrailingToolResults([user("go"), readResult(live, 1), user(NOTE)] as Prompt))

      await pump(live, collect(), { textId: "t", reasoningId: "r" })
      expect(live.pending.size).toBe(1)
      await new Promise((resolve) => setTimeout(resolve, 1_300))

      const sessionKey = live.openCodeSessionId!
      resetConversationPersistenceForTests()
      resetConversationBindingsForTests()
      resetCheckpointsForTests()
      resetTurnStateForTests()
      const restored = await hydrateConversationState(root, sessionKey)
      expect(decodePersistedHostNotes(restored?.hostNote)).toEqual([NOTE])
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })
})

describe("host notes on the next user turn", () => {
  it("does not add a deferred note as a reminder when the turn's own text already carries it", async () => {
    const writes: Uint8Array[] = []
    const live = heldRun(writes, [{ flags: 0x02, payload: new Uint8Array() }])
    const sessionKey = live.openCodeSessionId!
    sessionManager.registerSession(live)
    await deliverContinuationResults(live, extractTrailingToolResults([user("go"), readResult(live, 1), user(NOTE)] as Prompt))
    await cancelRunForHostInterrupt(live, "user", { graceMs: 200 })

    const base = {
      sessionKey,
      startedWithCheckpoint: true,
      isCompaction: false,
      ephemeralRun: false,
      resuming: false,
    }
    // `liveUserTurn` sends every user message since the model's last output, a note between turns included.
    const carried = prepareUserTurnHostNotes({ ...base, prompt: [user(NOTE), user("next")] as Prompt, turnText: `${NOTE}\n\nnext` })
    expect(carried.reminders).toEqual([])
    const separate = prepareUserTurnHostNotes({ ...base, prompt: [user("next")] as Prompt, turnText: "next" })
    expect(separate.reminders).toEqual([`<system_reminder>\n${NOTE_TEXT}\n</system_reminder>`])

    carried.sent()
    expect(releaseHostNoteInjectionsForTests(sessionKey).undelivered).toEqual([])
  })
})
