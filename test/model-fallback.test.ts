import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test"
import { createHash } from "node:crypto"
import { EventEmitter } from "node:events"
import fs from "node:fs"
import http2 from "node:http2"
import os from "node:os"
import path from "node:path"
import type { LanguageModelV3CallOptions } from "@ai-sdk/provider"
import { createCursor } from "../src/index.js"
import {
  ALLOW_MODEL_FALLBACK_ENV,
  describeToolRun,
  fallbackOverridePhrase,
  isFallbackOverride,
  matchModelFallbackReply,
  modelDisplayName,
  modelFallbackStopMessage,
  modelSwitchInBlob,
  modelSwitchInNotice,
  parseModelFallbackStop,
  peekModelFallbackStop,
  rememberModelFallbackStop,
  resetModelFallbackStopsForTests,
  serializeModelFallbackStop,
  type ModelFallbackStop,
} from "../src/model-fallback.js"
import { pump, resetTurnStateForTests } from "../src/language-model.js"
import { sessionManager, type CursorSession, type Frame } from "../src/session.js"
import { encodeFrame } from "../src/protocol/framing.js"
import { decodeMessage, encodeMessage } from "../src/protocol/messages.js"
import { toolsToDescriptors } from "../src/protocol/tools.js"
import { getCheckpoint, resetCheckpointsForTests, setCheckpoint } from "../src/protocol/checkpoint.js"
import {
  peekConversationId,
  resetConversationBindingsForTests,
  restoreConversationBinding,
} from "../src/protocol/conversation-bind.js"
import {
  loadPersistedConversation,
  resetConversationPersistenceForTests,
} from "../src/protocol/conversation-persistence.js"
import { setHostCacheDirOverride } from "../src/context/paths.js"
import { resetFrozenRequestContextsForTests } from "../src/context/frozen.js"
import { admitContextEpoch, peekContextEpoch } from "../src/context/epoch.js"
import { closeCachedHttp2SessionsForTests } from "../src/transport/connect.js"

type Prompt = LanguageModelV3CallOptions["prompt"]

const NOTICE = "\n\nSwitched to Claude Opus 4.8\n\nClaude Opus 5.5 hit a safety filter, and the conversation was automatically "
  + "switched to Claude Opus 4.8. Start a new conversation to continue with Claude Opus 5.5, or continue this "
  + "conversation with Claude Opus 4.8.\n\n"
// The thinking signature Cursor stored for an Opus 4.8 fallback step: its metadata names the model.
const OPUS_48_SIGNATURE = "EsMDCpIBCBIQAhgCKkCs+S+U071z0SP9hUwRAAayRXDlqawXI6XlXbd2+ExPxL2bAkC46RHDR7j8IMguYqnn2lIGnCwf"
  + "RC+56d365RhrMg9jbGF1ZGUtb3B1cy00LTg4AEIIdGhpbmtpbmda"

function assistantMessage(options: {
  fallback?: { from: string; to: string }
  toolCallIds?: string[]
  text?: string
  signature?: string
  native?: string
}): Record<string, unknown> {
  const content: Array<Record<string, unknown>> = []
  if (options.signature) content.push({ type: "reasoning", text: "thinking", signature: options.signature })
  if (options.text) content.push({ type: "text", text: options.text })
  for (const id of options.toolCallIds ?? []) content.push({ type: "tool-call", toolCallId: id, toolName: "Shell", args: {} })
  const native = [
    ...(options.fallback ? [{ type: "fallback", from: { model: options.fallback.from }, to: { model: options.fallback.to } }] : []),
    ...(options.text ? [{ type: "text", text: options.text }] : []),
    ...(options.toolCallIds ?? []).map((id) => ({ type: "tool_use", id, name: "Shell", input: {} })),
  ]
  return {
    role: "assistant",
    content,
    id: "1",
    providerOptions: { cursor: { anthropicNativeContent: options.native ?? JSON.stringify(native) } },
  }
}
const blob = (message: Record<string, unknown>) => new Uint8Array(Buffer.from(JSON.stringify(message)))
const FALLBACK = { from: "claude-opus-5-5-high-fast", to: "claude-opus-4-8" }

describe("detecting Cursor's safety-filter model switch", () => {
  it("reads the fallback block Cursor stores with the step's Anthropic content", () => {
    const found = modelSwitchInBlob(blob(assistantMessage({ fallback: FALLBACK, text: "WAIT-DONE" })), "claude-opus-5-5")
    expect(found).toEqual({ from: "claude-opus-5-5-high-fast", to: "claude-opus-4-8", source: "fallback-block" })
    expect(modelSwitchInBlob(
      blob(assistantMessage({ fallback: { from: "claude-opus-5-5@default", to: "claude-opus-4-8@default" }, toolCallIds: ["toolu_1"] })),
      "claude-opus-5-5",
    )?.to).toBe("claude-opus-4-8@default")
  })

  it("finds nothing in a step the requested model answered, in other blobs, or in malformed content", () => {
    expect(modelSwitchInBlob(blob(assistantMessage({ text: "PONG" })), "claude-opus-5-5")).toBeUndefined()
    expect(modelSwitchInBlob(blob({ role: "user", content: [{ type: "text", text: '"type":"fallback"' }] }), "claude-opus-5-5"))
      .toBeUndefined()
    expect(modelSwitchInBlob(new Uint8Array([0x0a, 0x20, 1, 2, 3]), "claude-opus-5-5")).toBeUndefined()
    expect(modelSwitchInBlob(blob(assistantMessage({ text: "x", native: "[{not json" })), "claude-opus-5-5")).toBeUndefined()
    expect(modelSwitchInBlob(blob(assistantMessage({ fallback: { from: "claude-opus-5-5", to: "claude-opus-5-5@default" } })), "claude-opus-5-5"))
      .toBeUndefined()
    // The model that answered is the one the user asked for.
    expect(modelSwitchInBlob(blob(assistantMessage({ fallback: FALLBACK })), "claude-opus-4-8")).toBeUndefined()
  })

  it("reads a thinking signature that names another version of the requested model's family", () => {
    expect(modelSwitchInBlob(blob(assistantMessage({ signature: OPUS_48_SIGNATURE, text: "hi" })), "claude-opus-5-5"))
      .toEqual({ from: "claude-opus-5-5", to: "claude-opus-4-8", source: "thinking-signature" })
    expect(modelSwitchInBlob(blob(assistantMessage({ signature: OPUS_48_SIGNATURE })), "claude-opus-4-8")).toBeUndefined()
    expect(modelSwitchInBlob(blob(assistantMessage({ signature: OPUS_48_SIGNATURE })), "claude-sonnet-5")).toBeUndefined()
    expect(modelSwitchInBlob(blob(assistantMessage({ signature: OPUS_48_SIGNATURE })), "gpt-5.6")).toBeUndefined()
  })

  it("reads Cursor's end-of-turn notice, but not the model quoting part of it", () => {
    expect(modelSwitchInNotice(NOTICE, false)).toEqual({ to: "Claude Opus 4.8", source: "server-notice" })
    expect(modelSwitchInNotice("\n\nSwitched to Claude Opus 4.8\n\n", true)?.to).toBe("Claude Opus 4.8")
    expect(modelSwitchInNotice("The banner said: Switched to Claude Opus 4.8", false)).toBeUndefined()
    expect(modelSwitchInNotice(
      "Cursor's banner read: Claude Opus 5.5 hit a safety filter, and the conversation was automatically switched to Claude Opus 4.8. Start a new one.",
      false,
    )).toBeUndefined()
  })

  it("names models the way Cursor's notice does", () => {
    expect(modelDisplayName("claude-opus-4-8@default")).toBe("Claude Opus 4.8")
    expect(modelDisplayName("claude-opus-5-5-high-fast")).toBe("Claude Opus 5.5")
    expect(modelDisplayName("claude-sonnet-5")).toBe("Claude Sonnet 5")
    expect(modelDisplayName("Claude Opus 4.8")).toBe("Claude Opus 4.8")
    expect(modelDisplayName("gpt-5.6")).toBe("gpt-5.6")
  })
})

describe("accepting the other model once", () => {
  it("takes only the whole documented reply", () => {
    expect(fallbackOverridePhrase("claude-opus-4-8")).toBe("continue with opus 4.8")
    expect(fallbackOverridePhrase("Claude Opus 4.8")).toBe("continue with opus 4.8")
    for (const reply of ["continue with opus 4.8", "Continue with Opus 4.8.", "`continue with opus 4.8`", "`continue with opus 4.8`.", "\"Continue with Opus 4.8.\"", "  continue  with opus 4.8 ", "continue with Claude Opus 4.8"]) {
      expect(isFallbackOverride(reply, "claude-opus-4-8")).toBe(true)
    }
    for (const reply of ["continue", "yes", "please continue with opus 4.8", "continue with opus 4.8 and fix the test", "continue with opus 5.5", "use opus 4.8"]) {
      expect(isFallbackOverride(reply, "claude-opus-4-8")).toBe(false)
    }
  })

  it("explains what happened, what already ran and both choices in a short message", () => {
    const message = modelFallbackStopMessage({
      requestedModel: "claude-opus-5-5",
      servedModel: "claude-opus-4-8",
      toolsKept: [{ toolName: "read", input: JSON.stringify({ path: "src/app.ts" }) }],
      toolsSwitched: [{ toolName: "shell", input: JSON.stringify({ command: "npm test" }) }],
    })
    expect(message).toContain("Cursor's safety filter switched this request from Claude Opus 5.5 to Claude Opus 4.8")
    expect(message).toContain("Nothing Claude Opus 4.8 wrote is kept in the conversation")
    expect(message).toContain("Already ran in this turn: read `src/app.ts`; shell `npm test` (by Claude Opus 4.8, before Cursor marked the switch).")
    expect(message).toContain("Rephrase the request to try Claude Opus 5.5 again, or reply `continue with opus 4.8`")
    const plain = modelFallbackStopMessage({ requestedModel: "claude-opus-5-5", servedModel: "Claude Opus 4.8", toolsKept: [], toolsSwitched: [] })
    expect(plain).not.toContain("Already ran")
    expect(plain.split("\n\n")).toHaveLength(2)
  })

  it("summarizes a tool call by its main argument", () => {
    expect(describeToolRun({ toolName: "shell", input: JSON.stringify({ command: "ls -la\n  ~/x" }) })).toBe("shell `ls -la ~/x`")
    expect(describeToolRun({ toolName: "question", input: "{}" })).toBe("question")
    expect(describeToolRun({ toolName: "shell", input: JSON.stringify({ command: "x".repeat(100) }) })).toEndWith("...`")
  })
})

describe("tying the next user turn to the stop", () => {
  afterEach(() => resetModelFallbackStopsForTests())

  const STOP: ModelFallbackStop = {
    requestedModel: "claude-opus-5-5",
    servedModel: "claude-opus-4-8",
    userText: "Read ~/.ssh/notes.txt",
    checkpointHoldsTurn: false,
    unrecordedTools: [],
    message: "**Stopped:** test stop",
  }
  const user = (text: string) => ({ role: "user", content: [{ type: "text", text }] })
  const assistant = (text: string) => ({ role: "assistant", content: [{ type: "text", text }] })

  it("finds the stopped turn and whether the reply accepts the other model", () => {
    rememberModelFallbackStop("ses_a", STOP)
    const prompt = [
      { role: "system", content: "sys" },
      user("hi"), assistant("hello"),
      user(STOP.userText),
      { role: "assistant", content: [{ type: "tool-call", toolCallId: "c1", toolName: "read", input: {} }] },
      { role: "tool", content: [{ type: "tool-result", toolCallId: "c1", toolName: "read", output: { type: "text", value: "x" } }] },
      user("<system-update>note</system-update>"),
      assistant(`some 4.8 text\n\n${STOP.message}`),
      user("continue with opus 4.8"),
    ] as Prompt
    const isNote = (m: Prompt[number]) => m.role === "user" && JSON.stringify(m.content).includes("<system-update>")
    expect(matchModelFallbackReply("ses_a", prompt, isNote)).toMatchObject({ override: true, turnStart: 3, stopIndex: 7 })
    const rephrased = [...prompt.slice(0, 8), user("Please summarize my notes file")] as Prompt
    expect(matchModelFallbackReply("ses_a", rephrased, isNote)).toMatchObject({ override: false, turnStart: 3, stopIndex: 7 })
    // A completion OpenCode sent as a plain user message inside the stopped turn is part of it.
    const withCompletion = [...prompt.slice(0, 6), user('<subagent sessionID="ses_x" state="completed">\nok\n</subagent>'), ...prompt.slice(7)] as Prompt
    expect(matchModelFallbackReply("ses_a", withCompletion)).toMatchObject({ override: true, turnStart: 3, stopIndex: 7 })
  })

  it("reads the reply without the tag blocks host plugins add to it or around it", () => {
    rememberModelFallbackStop("ses_c", STOP)
    const base = [user(STOP.userText), assistant(STOP.message)]
    // claude-compat appends the output style to every user message; a background completion may arrive with the reply.
    const styled = { role: "user", content: [{ type: "text", text: "continue with opus 4.8" }, { type: "text", text: "<system-reminder>\nBe concise.\n</system-reminder>" }] }
    const completion = user('<subagent sessionID="ses_x" state="completed">\nAll done.\n</subagent>')
    expect(matchModelFallbackReply("ses_c", [...base, completion, styled] as Prompt)?.override).toBe(true)
    const wordy = { role: "user", content: [{ type: "text", text: "continue with opus 4.8, and also fix the test" }, { type: "text", text: "<system-reminder>\nBe concise.\n</system-reminder>" }] }
    expect(matchModelFallbackReply("ses_c", [...base, wordy] as Prompt)?.override).toBe(false)
    expect(matchModelFallbackReply("ses_c", [...base, user("hello"), styled] as Prompt)?.override).toBe(false)
  })

  it("waits while no reply follows the stop, and drops the stop once the host history moved past it", () => {
    rememberModelFallbackStop("ses_b", STOP)
    expect(matchModelFallbackReply("ses_b", [user("x"), assistant(STOP.message)] as Prompt)).toBeUndefined()
    expect(peekModelFallbackStop("ses_b")).toBe(STOP)
    expect(matchModelFallbackReply("ses_b", [user("x"), assistant("a different answer"), user("continue with opus 4.8")] as Prompt))
      .toBeUndefined()
    expect(peekModelFallbackStop("ses_b")).toBeUndefined()
  })

  it("survives a restart through its serialized form", () => {
    expect(parseModelFallbackStop(serializeModelFallbackStop({ ...STOP, unrecordedTools: [{ toolName: "shell", input: "{}" }] })))
      .toEqual({ ...STOP, unrecordedTools: [{ toolName: "shell", input: "{}" }] })
    expect(parseModelFallbackStop("{}")).toBeUndefined()
    expect(parseModelFallbackStop("not json")).toBeUndefined()
  })
})

// ── The stop inside a Run ──

const frame = (message: Record<string, unknown>): Frame => ({ flags: 0, payload: encodeMessage("AgentServerMessage", message) })
const textFrame = (text: string, notice = false) =>
  frame({ interaction_update: { text_delta: { text, ...(notice ? { is_server_notice: true } : {}) } } })
const thinking = (text: string) => frame({ interaction_update: { thinking_delta: { text } } })
const kvSet = (id: number, data: Uint8Array) => frame({
  kv_server_message: { id, set_blob_args: { blob_id: createHash("sha256").update(data).digest(), blob_data: data } },
})
const checkpointFrame = (used: number) => frame({
  conversation_checkpoint_update: encodeMessage("ConversationStateStructure", { token_details: { used_tokens: used, max_tokens: 1_000_000 } }),
})
const stepCompleted = frame({ interaction_update: { step_completed: { step_id: 1, step_duration_ms: 5 } } })
const turnEnded = frame({ interaction_update: { turn_ended: { input_tokens: 10, output_tokens: 2 } } })
const listed = (count: number) => frame({ interaction_update: { tool_requests_listed: { call_count: count } } })
const shellCall = (id: number, callId: string, command: string) => [
  frame({ interaction_update: { tool_call_started: { call_id: callId, tool_call: { shell_tool_call: { args: { command, tool_call_id: callId } } } } } }),
  listed(1),
  frame({ exec_server_message: { id, shell_stream_args: { command, tool_call_id: callId } } }),
]

function scriptedFrames(initial: Frame[]) {
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

describe("stopping a Run at the first switched step", () => {
  let root: string
  let seq = 0
  const writes: Uint8Array[] = []

  beforeAll(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "cursor-model-fallback-"))
    setHostCacheDirOverride(path.join(root, "cache"))
  })
  afterAll(() => {
    setHostCacheDirOverride(undefined)
    fs.rmSync(root, { recursive: true, force: true })
  })
  afterEach(() => {
    delete process.env[ALLOW_MODEL_FALLBACK_ENV]
    writes.length = 0
    sessionManager.dispose()
    resetTurnStateForTests()
    resetCheckpointsForTests()
    resetConversationBindingsForTests()
    resetConversationPersistenceForTests()
    resetFrozenRequestContextsForTests()
  })

  function fakeRun(frames: AsyncIterator<Frame>, init: { turnBase?: Uint8Array } = {}): CursorSession {
    const sessionKey = `ses_fallback_${++seq}`
    const conversationId = `conv-${sessionKey}`
    restoreConversationBinding(sessionKey, conversationId)
    if (init.turnBase) setCheckpoint(conversationId, init.turnBase)
    const definitions = [{ name: "bash", description: "Shell" }]
    const tools = toolsToDescriptors(definitions, "opencode", [])
    const session = {
      sessionId: `run-${seq}`,
      conversationId,
      cacheDir: path.join(root, "cache"),
      openCodeSessionId: sessionKey,
      stream: {
        write(data: Uint8Array) { writes.push(data); return true },
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
      requestedModelId: "claude-opus-5-5",
      modelSwitchGuard: {
        turnBase: init.turnBase,
        latestCheckpoint: init.turnBase,
        stepBase: init.turnBase,
        stepOpen: false,
        toolRuns: [],
        userText: "Read ~/.ssh/notes.txt",
      },
    } as unknown as CursorSession
    sessionManager.registerSession(session)
    return session
  }

  async function pass(session: CursorSession) {
    const parts: any[] = []
    const controller = {
      enqueue(part: unknown) { parts.push(part) },
      error(error: Error) { throw error },
    } as unknown as ReadableStreamDefaultController<any>
    await pump(session, controller, { textId: "text", reasoningId: "reasoning" })
    return parts
  }
  const visibleText = (parts: any[]) => parts.filter((p) => p.type === "text-delta").map((p) => p.delta).join("")
  const finishes = (parts: any[]) => parts.filter((p) => p.type === "finish").map((p) => p.finishReason.unified)
  const toolCalls = (parts: any[]) => parts.filter((p) => p.type === "tool-call").map((p) => p.toolName)
  const cancelled = () => writes.some((w) => {
    try { return !!decodeMessage<any>("AgentClientMessage", w).conversation_action?.cancel_action } catch { return false }
  })

  it("ends the turn with the stop message instead of Cursor's notice, and rolls the conversation back before the turn", async () => {
    const turnBase = encodeMessage("ConversationStateStructure", { token_details: { used_tokens: 100, max_tokens: 1_000_000 } })
    const script = scriptedFrames([
      thinking("I should reply."),
      textFrame("WAIT-DONE"),
      kvSet(1, blob(assistantMessage({ fallback: FALLBACK, text: "WAIT-DONE" }))),
      checkpointFrame(200),
      stepCompleted,
      textFrame(NOTICE, true),
      turnEnded,
    ])
    const session = fakeRun(script.frames, { turnBase })
    const sessionKey = session.openCodeSessionId!
    const before = session.conversationId

    const parts = await pass(session)

    const text = visibleText(parts)
    expect(text).toStartWith("WAIT-DONE**Stopped:** Cursor's safety filter switched this request from Claude Opus 5.5 to Claude Opus 4.8.")
    expect(text).not.toContain("Switched to Claude Opus 4.8")
    const stopPart = parts.find((p) => p.type === "text-delta" && p.delta.startsWith("**Stopped:**"))
    expect(stopPart.id).not.toBe("text")
    expect(finishes(parts)).toEqual(["stop"])
    expect(session.closed).toBe(true)
    expect(cancelled()).toBe(true)
    // A fresh conversation continues from the checkpoint the turn started from.
    const next = peekConversationId(sessionKey)
    expect(next).not.toBe(before)
    expect(getCheckpoint(next)).toEqual(turnBase)
    expect(getCheckpoint(before)).toBeUndefined()
    expect(peekModelFallbackStop(sessionKey)).toMatchObject({ servedModel: "claude-opus-4-8", checkpointHoldsTurn: false })
    const persisted = (await loadPersistedConversation(path.join(root, "cache"), sessionKey)).value
    expect(persisted?.conversationId).toBe(next)
    expect(persisted?.checkpoint).toEqual(turnBase)
    expect(parseModelFallbackStop(persisted!.modelFallbackStop!)?.userText).toBe("Read ~/.ssh/notes.txt")
  })

  it("rolls the context epoch back with a checkpoint from before the turn", async () => {
    const turnBase = encodeMessage("ConversationStateStructure", { token_details: { used_tokens: 100, max_tokens: 1_000_000 } })
    const script = scriptedFrames([textFrame("answer"), kvSet(1, blob(assistantMessage({ fallback: FALLBACK, text: "answer" }))), turnEnded])
    const session = fakeRun(script.frames, { turnBase })
    const epochInput = (hostSystem: string, hasCheckpoint: boolean) => ({
      conversationId: session.conversationId, hasCheckpoint, hostSystem, guidance: "g", workspaceRoot: root,
    })
    admitContextEpoch(epochInput("build agent", false))
    session.modelSwitchGuard!.epochAtTurnStart = peekContextEpoch(session.conversationId)
    // The stopped turn admitted a host change (plan agent); its rolled-back checkpoint never saw it.
    expect(admitContextEpoch(epochInput("plan agent", true)).midConversationMessage).toContain("plan agent")

    await pass(session)

    const next = peekConversationId(session.openCodeSessionId!)
    expect(peekContextEpoch(next)?.snapshot).toEqual(session.modelSwitchGuard!.epochAtTurnStart!.snapshot)
    expect(admitContextEpoch({ ...epochInput("plan agent", true), conversationId: next }).midConversationMessage).toContain("plan agent")
  })

  it("stops after a switched tool step's results, before the next step's tool runs, and says what ran", async () => {
    const script = scriptedFrames([...shellCall(1, "toolu_a", "cat ~/.ssh/notes.txt")])
    const session = fakeRun(script.frames)

    const first = await pass(session)
    expect(toolCalls(first)).toEqual(["bash"])
    expect(finishes(first)).toEqual(["tool-calls"])

    // The host ran the call and returned its result; Cursor then stores the step and starts the next one.
    session.pending.clear()
    script.push(
      kvSet(2, blob(assistantMessage({ fallback: FALLBACK, toolCallIds: ["toolu_a"] }))),
      checkpointFrame(300),
      ...shellCall(2, "toolu_b", "rm -rf build"),
    )
    const second = await pass(session)

    expect(toolCalls(second)).toEqual([])
    expect(finishes(second)).toEqual(["stop"])
    expect(visibleText(second)).toContain("Already ran in this turn: bash `cat ~/.ssh/notes.txt` (by Claude Opus 4.8, before Cursor marked the switch).")
    const stop = peekModelFallbackStop(session.openCodeSessionId!)!
    expect(stop.unrecordedTools).toEqual([{ toolName: "bash", input: expect.stringContaining("notes.txt") }])
    // No checkpoint preceded the switched step: the next turn starts without one.
    expect(getCheckpoint(peekConversationId(session.openCodeSessionId!))).toBeUndefined()
  })

  it("keeps the requested model's earlier steps: rolls back to the checkpoint before the switched step", async () => {
    const script = scriptedFrames([...shellCall(1, "toolu_a", "ls")])
    const session = fakeRun(script.frames)
    await pass(session)
    session.pending.clear()
    const afterStep1 = encodeMessage("ConversationStateStructure", { token_details: { used_tokens: 150, max_tokens: 1_000_000 } })
    script.push(
      kvSet(2, blob(assistantMessage({ toolCallIds: ["toolu_a"] }))),
      frame({ conversation_checkpoint_update: afterStep1 }),
      thinking("Now the answer"),
      textFrame("Here is the summary"),
      kvSet(3, blob(assistantMessage({ fallback: FALLBACK, text: "Here is the summary" }))),
      checkpointFrame(400),
      turnEnded,
    )

    const parts = await pass(session)

    expect(finishes(parts)).toEqual(["stop"])
    expect(visibleText(parts)).toContain("Already ran in this turn: bash `ls`.")
    const stop = peekModelFallbackStop(session.openCodeSessionId!)!
    expect(stop.checkpointHoldsTurn).toBe(true)
    expect(stop.unrecordedTools).toEqual([])
    expect(getCheckpoint(peekConversationId(session.openCodeSessionId!))).toEqual(afterStep1)
  })

  it("acts on a switch the held-Run watcher read while the host still ran the step's tools", async () => {
    const script = scriptedFrames([...shellCall(1, "toolu_a", "ls")])
    const session = fakeRun(script.frames)
    await pass(session)
    session.modelSwitch = {
      ...FALLBACK,
      source: "fallback-block",
      rollback: undefined,
      holdsTurn: false,
      toolsKept: [],
      toolsSwitched: [{ toolName: "shell", input: "{\"command\":\"ls\"}" }],
    }
    session.pending.clear()
    script.push(textFrame("more 4.8 output"))

    const parts = await pass(session)

    expect(visibleText(parts)).not.toContain("more 4.8 output")
    expect(finishes(parts)).toEqual(["stop"])
  })

  it("stops on Cursor's notice alone and rolls back to the turn's start when no step was marked", async () => {
    const turnBase = encodeMessage("ConversationStateStructure", { token_details: { used_tokens: 50, max_tokens: 1_000_000 } })
    const script = scriptedFrames([textFrame("answer"), kvSet(1, blob(assistantMessage({ text: "answer", native: "" }))), checkpointFrame(90), textFrame(NOTICE), turnEnded])
    const session = fakeRun(script.frames, { turnBase })

    const parts = await pass(session)

    expect(finishes(parts)).toEqual(["stop"])
    expect(visibleText(parts)).toContain("**Stopped:**")
    expect(getCheckpoint(peekConversationId(session.openCodeSessionId!))).toEqual(turnBase)
  })

  it("lets an accepted switch answer, replaces Cursor's notice, and moves to a fresh conversation afterwards", async () => {
    const script = scriptedFrames([
      textFrame("Here you go"),
      kvSet(1, blob(assistantMessage({ fallback: FALLBACK, text: "Here you go" }))),
      checkpointFrame(500),
      textFrame(NOTICE, true),
      turnEnded,
    ])
    const session = fakeRun(script.frames)
    session.allowModelSwitch = true
    const before = session.conversationId

    const parts = await pass(session)

    const text = visibleText(parts)
    expect(text).toStartWith("Here you go")
    expect(text).toContain("Claude Opus 4.8 answered this request, as you asked. Your next request goes to Claude Opus 5.5 again.")
    expect(text).not.toContain("Switched to")
    expect(finishes(parts)).toEqual(["stop"])
    expect(cancelled()).toBe(false)
    const next = peekConversationId(session.openCodeSessionId!)
    expect(next).not.toBe(before)
    expect(getCheckpoint(next)).toBeDefined()
  })

  it(`continues on the other model with ${ALLOW_MODEL_FALLBACK_ENV}=1, as before`, async () => {
    process.env[ALLOW_MODEL_FALLBACK_ENV] = "1"
    const script = scriptedFrames([
      textFrame("answer"),
      kvSet(1, blob(assistantMessage({ fallback: FALLBACK, text: "answer" }))),
      textFrame(NOTICE, true),
      turnEnded,
    ])
    const session = fakeRun(script.frames)
    const before = session.conversationId

    const parts = await pass(session)

    expect(visibleText(parts)).toBe(`answer${NOTICE}`)
    expect(peekConversationId(session.openCodeSessionId!)).toBe(before)
    expect(peekModelFallbackStop(session.openCodeSessionId!)).toBeUndefined()
  })

  it("leaves Runs that are not agent turns alone", async () => {
    const script = scriptedFrames([textFrame("Title"), kvSet(1, blob(assistantMessage({ fallback: FALLBACK, text: "Title" }))), turnEnded])
    const session = fakeRun(script.frames)
    session.modelSwitchGuard = undefined

    const parts = await pass(session)

    expect(visibleText(parts)).toBe("Title")
    expect(finishes(parts)).toEqual(["stop"])
  })
})

// ── The next turn, end to end ──

/** Cursor's Run endpoint: records each Run request and plays one scripted frame list per Run. */
function fakeCursorRuns(script: Array<Array<Record<string, unknown>>>): { runs: any[]; restore: () => void } {
  const runs: any[] = []
  const connect = http2.connect
  ;(http2 as any).connect = () => {
    const session: any = Object.assign(new EventEmitter(), {
      closed: false,
      destroyed: false,
      request() {
        const stream: any = Object.assign(new EventEmitter(), {
          closed: false,
          destroyed: false,
          rstCode: 0,
          write(data: Uint8Array) {
            const message = decodeMessage<any>("AgentClientMessage", data.subarray(5))
            if (message.run_request) {
              runs.push(message.run_request)
              const frames = script.shift() ?? [{ interaction_update: { turn_ended: { input_tokens: 1, output_tokens: 1 } } }]
              setImmediate(() => {
                stream.emit("response", { ":status": 200 })
                for (const item of frames) stream.emit("data", encodeFrame(0, encodeMessage("AgentServerMessage", item)))
              })
            }
            return true
          },
          end() {},
          close() { stream.closed = true },
          destroy() {
            stream.destroyed = true
            stream.closed = true
            stream.emit("close")
          },
        })
        return stream
      },
      ping(callback: (error: Error | null) => void) {
        callback(null)
        return true
      },
      close() { session.closed = true },
      destroy() { session.destroyed = true },
    })
    setImmediate(() => session.emit("connect"))
    return session
  }
  return {
    runs,
    restore: () => {
      ;(http2 as any).connect = connect
      closeCachedHttp2SessionsForTests()
    },
  }
}

describe("the turn after a stop", () => {
  let root: string
  let seq = 0

  beforeAll(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "cursor-model-fallback-e2e-"))
    setHostCacheDirOverride(path.join(root, "cache"))
  })
  afterAll(() => {
    setHostCacheDirOverride(undefined)
    fs.rmSync(root, { recursive: true, force: true })
  })
  afterEach(() => {
    sessionManager.dispose()
    resetTurnStateForTests()
    resetCheckpointsForTests()
    resetConversationBindingsForTests()
    resetConversationPersistenceForTests()
    resetFrozenRequestContextsForTests()
  })

  const user = (text: string) => ({ role: "user", content: [{ type: "text", text }] })
  const assistant = (text: string) => ({ role: "assistant", content: [{ type: "text", text }] })
  const SYSTEM = { role: "system", content: "You are a coding agent." }
  const switchedTurn = (answer: string) => [
    { interaction_update: { text_delta: { text: answer } } },
    { kv_server_message: { id: 1, set_blob_args: { blob_id: createHash("sha256").update(answer).digest(), blob_data: blob(assistantMessage({ fallback: FALLBACK, text: answer })) } } },
    { conversation_checkpoint_update: encodeMessage("ConversationStateStructure", { token_details: { used_tokens: 999, max_tokens: 1_000_000 } }) },
    { interaction_update: { text_delta: { text: NOTICE, is_server_notice: true } } },
    { interaction_update: { turn_ended: { input_tokens: 1, output_tokens: 1 } } },
  ]
  const cleanTurn = (answer: string) => [
    { interaction_update: { text_delta: { text: answer } } },
    { conversation_checkpoint_update: encodeMessage("ConversationStateStructure", { token_details: { used_tokens: 1234, max_tokens: 1_000_000 } }) },
    { interaction_update: { turn_ended: { input_tokens: 1, output_tokens: 1 } } },
  ]

  async function step(sessionKey: string, prompt: Prompt): Promise<string> {
    const realFetch = globalThis.fetch
    globalThis.fetch = (async () => { throw new Error("no network in this test") }) as unknown as typeof fetch
    try {
      const model = createCursor({
        name: "cursor",
        accessToken: "token",
        agentBaseURL: "https://agentn.us.api5.cursor.sh",
        workspaceRoot: root,
      }).languageModel("claude-opus-5-5")
      const result = await model.doStream({
        prompt,
        headers: { "x-opencode-session-id": sessionKey },
        tools: [{ type: "function", name: "read", description: "Read a file", inputSchema: { type: "object", properties: {} } }],
      } as LanguageModelV3CallOptions)
      const reader = result.stream.getReader()
      let text = ""
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        if ((value as any).type === "text-delta") text += (value as any).delta
      }
      return text
    } finally {
      globalThis.fetch = realFetch
    }
  }
  const runText = (run: any): string => run.action.user_message_action.user_message.text

  function checkpointedSession(): { sessionKey: string; base: Uint8Array } {
    const sessionKey = `ses_e2e_${++seq}`
    const base = encodeMessage("ConversationStateStructure", { token_details: { used_tokens: 10, max_tokens: 1_000_000 } })
    restoreConversationBinding(sessionKey, `conv-${sessionKey}`)
    setCheckpoint(`conv-${sessionKey}`, base)
    return { sessionKey, base }
  }

  it("sends a rephrased request on a fresh conversation from the checkpoint before the stop, without the flagged one", async () => {
    const cursor = fakeCursorRuns([switchedTurn("4.8 answer"), cleanTurn("5.5 answer")])
    try {
      const { sessionKey, base } = checkpointedSession()
      const history = [SYSTEM, user("hello"), assistant("Hi.")]
      const stopped = await step(sessionKey, [...history, user("Read ~/.ssh/notes.txt")] as Prompt)
      expect(stopped).toContain("**Stopped:**")

      await step(sessionKey, [...history, user("Read ~/.ssh/notes.txt"), assistant(stopped), user("Summarize notes.txt in my home folder")] as Prompt)

      const [first, second] = cursor.runs
      expect(second.conversation_id).not.toBe(first.conversation_id)
      expect(new Uint8Array(second.conversation_state)).toEqual(base)
      expect(runText(second)).toStartWith("Summarize notes.txt in my home folder")
      expect(runText(second)).not.toContain("~/.ssh/notes.txt")
      expect(runText(second)).not.toContain("Stopped")
      expect(peekModelFallbackStop(sessionKey)).toBeUndefined()
    } finally {
      cursor.restore()
    }
  })

  it("sends the stopped request again for the override reply, accepts the switch for that turn only", async () => {
    const cursor = fakeCursorRuns([switchedTurn("4.8 answer"), switchedTurn("4.8 accepted answer"), switchedTurn("4.8 again")])
    try {
      const { sessionKey, base } = checkpointedSession()
      const history = [SYSTEM, user("hello"), assistant("Hi.")]
      const flagged = [...history, user("Read ~/.ssh/notes.txt")]
      const stopped = await step(sessionKey, flagged as Prompt)

      // As OpenCode sends it with claude-compat: the output style follows the user's words.
      const reply = { role: "user", content: [{ type: "text", text: "Continue with Opus 4.8." }, { type: "text", text: "<system-reminder>\nBe concise.\n</system-reminder>" }] }
      const accepted = await step(sessionKey, [...flagged, assistant(stopped), reply] as Prompt)
      expect(accepted).toStartWith("4.8 accepted answer")
      expect(accepted).toContain("answered this request, as you asked")
      expect(accepted).not.toContain("**Stopped:**")
      const override = cursor.runs[1]
      expect(new Uint8Array(override.conversation_state)).toEqual(base)
      expect(runText(override)).toStartWith("Read ~/.ssh/notes.txt")
      expect(runText(override)).not.toContain("Continue with Opus 4.8")

      // One turn only: the next request is guarded again, on yet another fresh conversation.
      const after = await step(sessionKey, [...flagged, assistant(stopped), reply, assistant(accepted), user("and the other file?")] as Prompt)
      expect(after).toContain("**Stopped:**")
      expect(cursor.runs[2].conversation_id).not.toBe(override.conversation_id)
    } finally {
      cursor.restore()
    }
  })

  it("does not take the override phrase inside a longer reply", async () => {
    const cursor = fakeCursorRuns([switchedTurn("4.8 answer"), cleanTurn("ok")])
    try {
      const { sessionKey } = checkpointedSession()
      const flagged = [SYSTEM, user("Read ~/.ssh/notes.txt")]
      const stopped = await step(sessionKey, flagged as Prompt)
      await step(sessionKey, [...flagged, assistant(stopped), user("no, do not continue with opus 4.8 — use the README instead")] as Prompt)
      expect(runText(cursor.runs[1])).toStartWith("no, do not continue with opus 4.8")
    } finally {
      cursor.restore()
    }
  })

  async function stepParts(sessionKey: string, prompt: Prompt): Promise<any[]> {
    const realFetch = globalThis.fetch
    globalThis.fetch = (async () => { throw new Error("no network in this test") }) as unknown as typeof fetch
    try {
      const model = createCursor({ name: "cursor", accessToken: "token", agentBaseURL: "https://agentn.us.api5.cursor.sh", workspaceRoot: root })
        .languageModel("claude-opus-5-5")
      const result = await model.doStream({
        prompt,
        headers: { "x-opencode-session-id": sessionKey },
        tools: [{ type: "function", name: "read", description: "Read a file", inputSchema: { type: "object", properties: {} } }],
      } as LanguageModelV3CallOptions)
      const reader = result.stream.getReader()
      const parts: any[] = []
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        parts.push(value)
      }
      return parts
    } finally {
      globalThis.fetch = realFetch
    }
  }
  /** A turn whose read step Cursor marks as switched once the host returns the read's result. */
  async function stoppedToolTurn(sessionKey: string) {
    const file = path.join(root, "README.md")
    fs.writeFileSync(file, "# demo\n")
    const flagged = [SYSTEM, user("Read README.md")]
    const first = await stepParts(sessionKey, flagged as Prompt)
    const call = first.find((p) => p.type === "tool-call")
    expect(call).toBeDefined()
    const withResult = [
      ...flagged,
      { role: "assistant", content: [{ type: "tool-call", toolCallId: call.toolCallId, toolName: "read", input: JSON.parse(call.input) }] },
      { role: "tool", content: [{ type: "tool-result", toolCallId: call.toolCallId, toolName: "read", output: { type: "text", value: "# demo" } }] },
    ]
    const second = await stepParts(sessionKey, withResult as Prompt)
    const stopped = second.filter((p) => p.type === "text-delta").map((p) => p.delta).join("")
    expect(stopped).toContain("**Stopped:**")
    return { prompt: [...withResult, assistant(stopped)], conversationId: peekConversationId(sessionKey) }
  }
  const readTurn = (callId: string) => [
    { interaction_update: { tool_call_started: { call_id: callId, tool_call: { read_tool_call: { args: { path: path.join(root, "README.md") } } } } } },
    { interaction_update: { tool_requests_listed: { call_count: 1 } } },
    { exec_server_message: { id: 1, read_args: { path: path.join(root, "README.md"), tool_call_id: callId } } },
    { kv_server_message: { id: 1, set_blob_args: { blob_id: createHash("sha256").update(callId).digest(), blob_data: blob(assistantMessage({ fallback: FALLBACK, toolCallIds: [callId] })) } } },
    { conversation_checkpoint_update: encodeMessage("ConversationStateStructure", { token_details: { used_tokens: 999, max_tokens: 1_000_000 } }) },
    { interaction_update: { turn_ended: { input_tokens: 1, output_tokens: 1 } } },
  ]

  it("keeps the next turn on the moved conversation after a stop in a tool step", async () => {
    const cursor = fakeCursorRuns([readTurn("toolu_r1"), cleanTurn("ok")])
    try {
      const sessionKey = `ses_e2e_${++seq}`
      const { prompt, conversationId } = await stoppedToolTurn(sessionKey)
      await step(sessionKey, [...prompt, user("What is in package.json?")] as Prompt)
      expect(cursor.runs[1].conversation_id).toBe(conversationId)
    } finally {
      cursor.restore()
    }
  })

  it("still notices another model's answer after a stop", async () => {
    const cursor = fakeCursorRuns([readTurn("toolu_r2"), cleanTurn("ok")])
    try {
      const sessionKey = `ses_e2e_${++seq}`
      const { prompt, conversationId } = await stoppedToolTurn(sessionKey)
      await step(sessionKey, [...prompt, user("Ask another model"), assistant("An answer from another provider."), user("Back to Cursor")] as Prompt)
      expect(cursor.runs[1].conversation_id).not.toBe(conversationId)
      expect(runText(cursor.runs[1])).toContain("An answer from another provider.")
    } finally {
      cursor.restore()
    }
  })

  it("stops a Run that rebases a lost Run's tool results too", async () => {
    const cursor = fakeCursorRuns([switchedTurn("4.8 answer")])
    try {
      const sessionKey = `ses_e2e_${++seq}`
      // The held Run that asked for this result is gone (a restart): the result rebases a fresh Run.
      const text = await step(sessionKey, [
        SYSTEM,
        user("Read README.md"),
        { role: "assistant", content: [{ type: "tool-call", toolCallId: "cursor_gone-run_1", toolName: "read", input: {} }] },
        { role: "tool", content: [{ type: "tool-result", toolCallId: "cursor_gone-run_1", toolName: "read", output: { type: "text", value: "# demo" } }] },
      ] as Prompt)
      expect(text).toContain("**Stopped:**")
      expect(peekModelFallbackStop(sessionKey)?.userText).toBe("Read README.md")
    } finally {
      cursor.restore()
    }
  })

  it("does not send the stopped request's image with the rephrased one", async () => {
    const cursor = fakeCursorRuns([switchedTurn("4.8 answer"), cleanTurn("ok")])
    try {
      const sessionKey = `ses_e2e_${++seq}`
      const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 7]).toString("base64")
      const flagged = { role: "user", content: [{ type: "text", text: "What is in this picture?" }, { type: "file", mediaType: "image/png", data: `data:image/png;base64,${png}`, filename: "/w/shot.png" }] }
      const stopped = await step(sessionKey, [SYSTEM, flagged] as Prompt)
      expect(cursor.runs[0].action.user_message_action.user_message.selected_context?.selected_images ?? []).toHaveLength(1)
      await step(sessionKey, [SYSTEM, flagged, assistant(stopped), user("What is in README.md?")] as Prompt)
      expect(cursor.runs[1].action.user_message_action.user_message.selected_context?.selected_images ?? []).toHaveLength(0)
    } finally {
      cursor.restore()
    }
  })

  it("replays history without the stopped turn when no checkpoint preceded it", async () => {
    const cursor = fakeCursorRuns([switchedTurn("4.8 answer"), cleanTurn("ok")])
    try {
      const sessionKey = `ses_e2e_${++seq}`
      const history = [SYSTEM, user("first question"), assistant("first answer")]
      const stopped = await step(sessionKey, [...history, user("Read ~/.ssh/notes.txt")] as Prompt)
      await step(sessionKey, [...history, user("Read ~/.ssh/notes.txt"), assistant(stopped), user("What is in README.md?")] as Prompt)
      const text = runText(cursor.runs[1])
      expect(text).toContain("first question")
      expect(text).not.toContain("~/.ssh/notes.txt")
      expect(text).not.toContain("Stopped")
      expect(text).toEndWith("What is in README.md?")
    } finally {
      cursor.restore()
    }
  })
})
