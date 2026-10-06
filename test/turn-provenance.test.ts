import { afterAll, beforeEach, describe, expect, it, jest } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { APICallError, type LanguageModelV3CallOptions } from "@ai-sdk/provider"
import {
  beginEmittedStep,
  detectForeignHistory,
  getTurnProvenance,
  MAX_PROVENANCE_SESSIONS,
  parseTurnProvenance,
  recordEmittedPart,
  resetTurnProvenanceForTests,
  serializeTurnProvenance,
  trackTurnProvenance,
} from "../src/protocol/turn-provenance.js"
import {
  assertForeignHistoryRebaseFits,
  extractPromptHistory,
  HELD_RUN_SAVE_DELAY_MS,
  pump,
  resetTurnStateForTests,
} from "../src/language-model.js"
import { createCursor } from "../src/index.js"
import {
  getPersistedConversation,
  resetConversationPersistenceForTests,
  type PersistedConversation,
} from "../src/protocol/conversation-persistence.js"
import { hydrateConversationState, hydrateTurnProvenance } from "../src/protocol/conversation-state.js"
import {
  peekConversationId,
  resetConversationBindingsForTests,
  restoreConversationBinding,
} from "../src/protocol/conversation-bind.js"
import { getCheckpoint, resetCheckpointsForTests } from "../src/protocol/checkpoint.js"
import {
  conversationBlobCount,
  resetConversationBlobsForTests,
  setConversationBlob,
} from "../src/protocol/blob-store.js"
import { resetFrozenRequestContextsForTests } from "../src/context/frozen.js"
import { setHostCacheDirOverride } from "../src/context/paths.js"
import { encodeMessage } from "../src/protocol/messages.js"
import { sessionManager, type CursorSession, type Frame } from "../src/session.js"

type Prompt = LanguageModelV3CallOptions["prompt"]

const SESSION = "ses_mixed"
const CONVERSATION = "conv-1"

function promptEndingWith(assistant: Prompt[number]): Prompt {
  return [
    { role: "user", content: [{ type: "text", text: "first" }] },
    assistant,
    { role: "user", content: [{ type: "text", text: "next" }] },
  ]
}

function assistantText(text: string): Prompt[number] {
  return { role: "assistant", content: [{ type: "text", text }] }
}

function assistantToolCall(toolCallId: string, text = ""): Prompt[number] {
  return {
    role: "assistant",
    content: [
      ...(text ? [{ type: "text" as const, text }] : []),
      { type: "tool-call", toolCallId, toolName: "read", input: { path: "a.ts" } },
    ],
  }
}

function detect(prompt: Prompt) {
  return detectForeignHistory({ sessionKey: SESSION, conversationId: CONVERSATION, prompt })
}

describe("detectForeignHistory", () => {
  beforeEach(resetTurnProvenanceForTests)

  it("has no opinion without a record for this conversation", () => {
    expect(detect(promptEndingWith(assistantText("anything")))).toBeUndefined()
    trackTurnProvenance(SESSION, "other-conversation")
    expect(detect(promptEndingWith(assistantText("anything")))).toBeUndefined()
  })

  it("accepts the host echo of our own text regardless of whitespace", () => {
    trackTurnProvenance(SESSION, CONVERSATION)
    recordEmittedPart(SESSION, CONVERSATION, { type: "text-delta", delta: "Done.\n\nThe  fix " })
    recordEmittedPart(SESSION, CONVERSATION, { type: "text-delta", delta: "is in place." })
    expect(detect(promptEndingWith(assistantText("Done. The fix is in place.")))).toBeUndefined()
  })

  it("accepts an assistant turn carrying one of our tool call ids", () => {
    trackTurnProvenance(SESSION, CONVERSATION)
    recordEmittedPart(SESSION, CONVERSATION, { type: "tool-call", toolCallId: "call_ours" })
    expect(detect(promptEndingWith(assistantToolCall("call_ours", "Reading it")))).toBeUndefined()
  })

  it("accepts a turn carrying a tool call id this provider minted, even without its record", () => {
    trackTurnProvenance(SESSION, CONVERSATION)
    recordEmittedPart(SESSION, CONVERSATION, { type: "text-delta", delta: "Earlier step" })
    const ours = "cursor_db32c773-3087-4d91-818c-9d0813c22cd4_900000"
    expect(detect(promptEndingWith(assistantToolCall(ours, "Asking the user")))).toBeUndefined()
    expect(detect(promptEndingWith(assistantToolCall("call_theirs", "Asking the user")))).toBe("foreign-assistant")
    expect(detect(promptEndingWith(assistantToolCall("cursor_no-exec-id", "Asking the user"))))
      .toBe("foreign-assistant")
  })

  it("flags an assistant turn another model produced", () => {
    trackTurnProvenance(SESSION, CONVERSATION)
    recordEmittedPart(SESSION, CONVERSATION, { type: "text-delta", delta: "Cursor answer" })
    recordEmittedPart(SESSION, CONVERSATION, { type: "tool-call", toolCallId: "call_ours" })
    expect(detect(promptEndingWith(assistantText("Local model answer")))).toBe("foreign-assistant")
    expect(detect(promptEndingWith(assistantToolCall("call_theirs")))).toBe("foreign-assistant")
  })

  it("ignores reasoning when comparing and has no opinion on an empty turn", () => {
    trackTurnProvenance(SESSION, CONVERSATION)
    recordEmittedPart(SESSION, CONVERSATION, { type: "text-delta", delta: "Answer" })
    expect(detect(promptEndingWith({
      role: "assistant",
      content: [{ type: "reasoning", text: "private thoughts" }, { type: "text", text: "Answer" }],
    }))).toBeUndefined()
    expect(detect(promptEndingWith({ role: "assistant", content: [{ type: "reasoning", text: "x" }] })))
      .toBeUndefined()
  })

  it("accepts our turn when OpenCode 1.x replays our reasoning as text after a model switch", () => {
    // OpenCode 1.x session/message-v2.ts: when the request model differs from the
    // message's model, reasoning parts are replayed as text parts in place.
    trackTurnProvenance(SESSION, CONVERSATION)
    beginEmittedStep(SESSION, CONVERSATION)
    recordEmittedPart(SESSION, CONVERSATION, { type: "reasoning-delta", delta: "Check the file." })
    recordEmittedPart(SESSION, CONVERSATION, { type: "text-delta", delta: "First." })
    recordEmittedPart(SESSION, CONVERSATION, { type: "reasoning-delta", delta: "Then the test." })
    recordEmittedPart(SESSION, CONVERSATION, { type: "text-delta", delta: "Done." })
    const replayedAsText = { role: "assistant", content: [
      { type: "text", text: "Check the file." },
      { type: "text", text: "First." },
      { type: "text", text: "Then the test." },
      { type: "text", text: "Done." },
    ] } as Prompt[number]
    expect(detect(promptEndingWith(replayedAsText))).toBeUndefined()
    // Same model: reasoning stays typed and the text parts alone match.
    expect(detect(promptEndingWith({ role: "assistant", content: [
      { type: "reasoning", text: "Check the file." },
      { type: "text", text: "First." },
      { type: "reasoning", text: "Then the test." },
      { type: "text", text: "Done." },
    ] }))).toBeUndefined()
    // Reordered or foreign text still does not match.
    expect(detect(promptEndingWith(assistantText("First.Check the file.Done.Then the test.")))).toBe("foreign-assistant")
    expect(detect(promptEndingWith({ role: "assistant", content: [
      { type: "text", text: "Other model thinking" },
      { type: "text", text: "Done." },
    ] }))).toBe("foreign-assistant")
  })

  it("records a reasoning-only step so its replay as text still matches", () => {
    trackTurnProvenance(SESSION, CONVERSATION)
    beginEmittedStep(SESSION, CONVERSATION)
    recordEmittedPart(SESSION, CONVERSATION, { type: "text-delta", delta: "Earlier answer" })
    beginEmittedStep(SESSION, CONVERSATION)
    recordEmittedPart(SESSION, CONVERSATION, { type: "reasoning-delta", delta: "Only thinking" })
    expect(getTurnProvenance(SESSION)).toMatchObject({ text: "", textWithReasoning: "Onlythinking" })
    expect(detect(promptEndingWith(assistantText("Only thinking")))).toBeUndefined()
    expect(detect(promptEndingWith(assistantText("Earlier answer")))).toBe("foreign-assistant")
  })

  it("compares only against the latest step, not older Cursor turns", () => {
    trackTurnProvenance(SESSION, CONVERSATION)
    beginEmittedStep(SESSION, CONVERSATION)
    recordEmittedPart(SESSION, CONVERSATION, { type: "text-delta", delta: "Done." })
    beginEmittedStep(SESSION, CONVERSATION)
    recordEmittedPart(SESSION, CONVERSATION, { type: "text-delta", delta: "Refactored the parser." })
    // A foreign model answering "Done." must not match the older Cursor step.
    expect(detect(promptEndingWith(assistantText("Done.")))).toBe("foreign-assistant")
    expect(detect(promptEndingWith(assistantText("Refactored the parser.")))).toBeUndefined()
    // Nor a fragment of the latest step.
    expect(detect(promptEndingWith(assistantText("Refactored")))).toBe("foreign-assistant")
  })

  it("keeps the previous step when a new step emits nothing", () => {
    trackTurnProvenance(SESSION, CONVERSATION)
    beginEmittedStep(SESSION, CONVERSATION)
    recordEmittedPart(SESSION, CONVERSATION, { type: "tool-call", toolCallId: "call_ours" })
    beginEmittedStep(SESSION, CONVERSATION)
    expect(detect(promptEndingWith(assistantToolCall("call_ours")))).toBeUndefined()
  })

  it("identifies a long step by its first 4 KiB of text", () => {
    trackTurnProvenance(SESSION, CONVERSATION)
    beginEmittedStep(SESSION, CONVERSATION)
    const long = "a".repeat(10_000)
    recordEmittedPart(SESSION, CONVERSATION, { type: "text-delta", delta: long })
    expect(getTurnProvenance(SESSION)!.text.length).toBe(4 * 1024)
    expect(detect(promptEndingWith(assistantText(long)))).toBeUndefined()
    expect(detect(promptEndingWith(assistantText("b" + long)))).toBe("foreign-assistant")
  })

  it("bounds the number of tracked sessions", () => {
    for (let i = 0; i <= MAX_PROVENANCE_SESSIONS; i++) trackTurnProvenance(`ses_${i}`, "conv")
    expect(getTurnProvenance("ses_0")).toBeUndefined()
    expect(getTurnProvenance(`ses_${MAX_PROVENANCE_SESSIONS}`)).toBeDefined()
  })

  it("keeps one record across Runs on the same conversation (Cursor model switch)", () => {
    trackTurnProvenance(SESSION, CONVERSATION)
    recordEmittedPart(SESSION, CONVERSATION, { type: "text-delta", delta: "Answer" })
    expect(detect(promptEndingWith(assistantText("Answer")))).toBeUndefined()
    // A Run on another Cursor model keeps the conversation, so it keeps the record.
    trackTurnProvenance(SESSION, CONVERSATION)
    beginEmittedStep(SESSION, CONVERSATION)
    recordEmittedPart(SESSION, CONVERSATION, { type: "text-delta", delta: "Second" })
    expect(detect(promptEndingWith(assistantText("Second")))).toBeUndefined()
    expect(getTurnProvenance(SESSION)?.conversationId).toBe(CONVERSATION)
  })

  it("starts a fresh record when the conversation is reminted", () => {
    trackTurnProvenance(SESSION, CONVERSATION)
    recordEmittedPart(SESSION, CONVERSATION, { type: "text-delta", delta: "Old" })
    trackTurnProvenance(SESSION, "conv-2")
    expect(getTurnProvenance(SESSION)).toEqual({
      conversationId: "conv-2",
      toolCallIds: [],
      text: "",
      textWithReasoning: "",
    })
  })

  it("round-trips through its persisted JSON form", () => {
    trackTurnProvenance(SESSION, CONVERSATION)
    recordEmittedPart(SESSION, CONVERSATION, { type: "reasoning-delta", delta: "Thinking" })
    recordEmittedPart(SESSION, CONVERSATION, { type: "text-delta", delta: "Answer" })
    recordEmittedPart(SESSION, CONVERSATION, { type: "tool-call", toolCallId: "call_ours" })
    const value = getTurnProvenance(SESSION)!
    expect(value.textWithReasoning).toBe("ThinkingAnswer")
    expect(parseTurnProvenance(serializeTurnProvenance(value))).toEqual(value)
    expect(parseTurnProvenance("{not json")).toBeUndefined()
    expect(parseTurnProvenance("{}")).toBeUndefined()
  })
})

describe("foreign-history rebase", () => {
  it("replays every tool result as host observations", () => {
    const history = extractPromptHistory([
      { role: "user", content: [{ type: "text", text: "fix it" }] },
      assistantToolCall("call_theirs", "Reading"),
      {
        role: "tool",
        content: [{
          type: "tool-result",
          toolCallId: "call_theirs",
          toolName: "read",
          output: { type: "text", value: "file body" },
        }],
      },
      assistantText("Fixed"),
      { role: "user", content: [{ type: "text", text: "next" }] },
    ], { toolResults: "all" })
    const text = history.map((message) => message.content).join("\n")
    expect(text).toContain("file body")
    expect(text).toContain("Fixed")
    expect(history.some((message) => message.role === "assistant" && message.content.includes("file body")))
      .toBe(false)
  })

  it("passes when the rebased history fits the model context", () => {
    expect(() => assertForeignHistoryRebaseFits({
      modelInfo: { id: "m", maxContext: 1_000, variants: [] },
      cursorModelId: "m",
      maxMode: false,
      history: [{ role: "user", content: "x".repeat(3_000) }],
      systemPrompt: "system",
      userText: "next",
    })).not.toThrow()
  })

  it("raises a host-recognised context overflow when it does not fit", () => {
    let thrown: unknown
    try {
      assertForeignHistoryRebaseFits({
        modelInfo: { id: "m", maxContext: 1_000, maxContextForMaxMode: 100_000, variants: [] },
        cursorModelId: "m",
        maxMode: false,
        history: [{ role: "user", content: "x".repeat(4_000) }],
        systemPrompt: undefined,
        userText: "next",
      })
    } catch (error) {
      thrown = error
    }
    expect(APICallError.isInstance(thrown)).toBe(true)
    expect((thrown as APICallError).statusCode).toBe(413)
    expect((thrown as APICallError).message).toMatch(/prompt is too long/i)
  })

  it("uses the long-context window in max mode", () => {
    expect(() => assertForeignHistoryRebaseFits({
      modelInfo: { id: "m", maxContext: 1_000, maxContextForMaxMode: 100_000, variants: [] },
      cursorModelId: "m",
      maxMode: true,
      history: [{ role: "user", content: "x".repeat(4_000) }],
      systemPrompt: undefined,
      userText: "next",
    })).not.toThrow()
  })
})

describe("provenance through a Cursor Run", () => {
  const roots: string[] = []

  beforeEach(() => {
    resetTurnProvenanceForTests()
    resetConversationPersistenceForTests()
    resetConversationBindingsForTests()
    resetCheckpointsForTests()
    resetConversationBlobsForTests()
    resetFrozenRequestContextsForTests()
    resetTurnStateForTests()
  })

  afterAll(async () => {
    await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })))
  })

  function textTurnSession(root: string, text: string): CursorSession {
    return runSession(root, [
      encodeMessage("AgentServerMessage", { interaction_update: { text_delta: { text } } }),
      encodeMessage("AgentServerMessage", { conversation_checkpoint_update: Uint8Array.from([1, 2, 3]) }),
      encodeMessage("AgentServerMessage", {
        interaction_update: { turn_ended: { input_tokens: 3, output_tokens: 1 } },
      }),
    ])
  }

  function runSession(root: string, payloads: Uint8Array[], sessionId = "provenance-run"): CursorSession {
    let index = 0
    const frames: AsyncIterator<Frame> = {
      next: async () => index < payloads.length
        ? { done: false, value: { flags: 0, payload: payloads[index++]! } }
        : { done: true, value: undefined },
    }
    return {
      sessionId,
      conversationId: CONVERSATION,
      cacheDir: root,
      openCodeSessionId: SESSION,
      cacheDiagnostics: {
        sessionKey: SESSION,
        conversationId: CONVERSATION,
        modelId: "gpt-5",
        startedWithCheckpoint: false,
        requestContextReused: false,
        requestContextHash: "hash",
        checkpointUpdates: 0,
        tokenDetailUpdates: 0,
        pumpPasses: 0,
        stepStarts: 0,
        stepCompletes: 0,
        displayToolCalls: 0,
        execRequests: 0,
      },
      stream: {
        write() {},
        end() {},
        destroy() {},
        frames: () => ({ [Symbol.asyncIterator]: () => frames }),
      } as CursorSession["stream"],
      frames,
      pending: new Map(),
      displayToolCalls: new Map(),
      nextBridgedExecId: 900_000,
      blobs: new Map(),
      toolDescriptors: [{ name: "opencode-question", tool_name: "question", provider_identifier: "opencode" }],
      requestContext: { rules_info_complete: true },
      allowTools: true,
      usageEstimate: { inputTokens: 0, outputTokens: 0, cacheRead: 0, cacheWrite: 0, reasoningTokens: 0 },
      pumpActive: true,
      heartbeat: null,
      expiresAt: Date.now() + 10_000,
    } as unknown as CursorSession
  }

  it("records streamed text and restores it after a restart", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "cursor-provenance-"))
    roots.push(root)
    restoreConversationBinding(SESSION, CONVERSATION)
    const session = textTurnSession(root, "Cursor wrote this")
    await pump(session, {
      enqueue() {},
      error(error: unknown) { throw error },
    } as unknown as ReadableStreamDefaultController<any>, { textId: "text", reasoningId: "reasoning" })

    expect(detect(promptEndingWith(assistantText("Cursor wrote this")))).toBeUndefined()
    expect(detect(promptEndingWith(assistantText("Somebody else")))).toBe("foreign-assistant")
    expect((await getPersistedConversation(root, SESSION))?.turnProvenance).toBeDefined()

    // Simulate a host restart: drop all in-memory state, then hydrate.
    resetTurnProvenanceForTests()
    resetConversationPersistenceForTests()
    resetConversationBindingsForTests()
    expect(detect(promptEndingWith(assistantText("Somebody else")))).toBeUndefined()
    await hydrateConversationState(root, SESSION)
    expect(detect(promptEndingWith(assistantText("Cursor wrote this")))).toBeUndefined()
    expect(detect(promptEndingWith(assistantText("Somebody else")))).toBe("foreign-assistant")

    // Only the provenance entry evicted while the binding stays in memory.
    resetTurnProvenanceForTests()
    await hydrateTurnProvenance(root, SESSION)
    expect(detect(promptEndingWith(assistantText("Somebody else")))).toBe("foreign-assistant")
  })

  // A decodable checkpoint that references no blobs, so TurnEnded compaction would drop them all.
  const MID_RUN_CHECKPOINT = Uint8Array.from([0x98, 0x06, 0x01])
  const LATER_CHECKPOINT = Uint8Array.from([0x98, 0x06, 0x02])

  function questionStep(checkpoint: Uint8Array, interactionId: number): Uint8Array[] {
    return [
      encodeMessage("AgentServerMessage", { conversation_checkpoint_update: checkpoint }),
      encodeMessage("AgentServerMessage", { interaction_update: { thinking_delta: { text: "The user seems confused" } } }),
      encodeMessage("AgentServerMessage", {
        interaction_query: {
          id: interactionId,
          ask_question_interaction_query: encodeMessage("AskQuestionInteractionQuery", {
            args: {
              title: "Question",
              questions: [{ id: "q1", prompt: "Do all five?", options: [{ id: "yes", label: "Yes" }] }],
            },
            tool_call_id: `toolu_question_${interactionId}`,
          }),
        },
      }),
    ]
  }

  function questionRunSession(root: string): CursorSession {
    return runSession(root, [
      ...questionStep(MID_RUN_CHECKPOINT, 42),
      ...questionStep(LATER_CHECKPOINT, 43),
    ], "question-run")
  }

  async function pumpUntilQuestion(session: CursorSession): Promise<string> {
    const parts: any[] = []
    await pump(session, {
      enqueue(part: unknown) { parts.push(part) },
      error(error: unknown) { throw error },
    } as unknown as ReadableStreamDefaultController<any>, { textId: "text", reasoningId: "reasoning" })
    // pumpWithRecovery's endPump: OpenCode now runs the question tool.
    session.pumpActive = false
    const toolCall = parts.find((part) => part.type === "tool-call")
    expect(toolCall?.toolName).toBe("question")
    expect(session.pending.size).toBe(1)
    return toolCall.toolCallId
  }

  async function persistedOnDisk(root: string, until: (value: PersistedConversation | undefined) => boolean) {
    for (let attempt = 0; attempt < 200; attempt++) {
      resetConversationPersistenceForTests()
      const value = await getPersistedConversation(root, SESSION)
      if (until(value)) return value
      await Bun.sleep(5)
    }
    throw new Error("snapshot never reached the expected state")
  }

  function restartProcess(session: CursorSession): void {
    sessionManager.close(session, "process-disposed")
    resetTurnProvenanceForTests()
    resetConversationPersistenceForTests()
    resetConversationBindingsForTests()
    resetCheckpointsForTests()
    resetConversationBlobsForTests()
    resetFrozenRequestContextsForTests()
    resetTurnStateForTests()
  }

  // OpenCode 2 marks the interrupted question as an error and replays the
  // errored step's reasoning as text.
  function promptAfterRestart(toolCallId: string): Prompt {
    return [
      { role: "user", content: [{ type: "text", text: "first" }] },
      assistantText("Cursor wrote this"),
      { role: "user", content: [{ type: "text", text: "what are you talking about?" }] },
      {
        role: "assistant",
        content: [
          { type: "text", text: "The user seems confused" },
          { type: "tool-call", toolCallId, toolName: "question", input: { questions: [] } },
        ],
      },
      {
        role: "tool",
        content: [{
          type: "tool-result",
          toolCallId,
          toolName: "question",
          output: { type: "error-text", value: "Tool execution interrupted" },
        }],
      },
      { role: "user", content: [{ type: "text", text: "okay, I rebuilt the system" }] },
    ]
  }

  // Runs the next fresh turn up to the point where it would open the Run: the
  // agent host override is rejected only after the conversation is bound.
  async function conversationOfNextTurn(root: string, prompt: Prompt): Promise<string> {
    const model = createCursor({
      name: "cursor",
      accessToken: "token",
      agentBaseURL: "https://evil.example",
      cacheDir: root,
    }).languageModel("cursor-test")
    try {
      await expect(model.doStream({
        prompt,
        tools: [{ type: "function", name: "question", description: "Ask", inputSchema: { type: "object" } }],
        headers: { "x-opencode-session-id": SESSION, "x-opencode-directory": root },
      } as LanguageModelV3CallOptions)).rejects.toThrow("Invalid Cursor agent base URL override")
    } finally {
      setHostCacheDirOverride(undefined)
    }
    return peekConversationId(SESSION)
  }

  async function turnThenQuestion(root: string): Promise<{ session: CursorSession; toolCallId: string }> {
    restoreConversationBinding(SESSION, CONVERSATION)
    await pump(textTurnSession(root, "Cursor wrote this"), {
      enqueue() {},
      error(error: unknown) { throw error },
    } as unknown as ReadableStreamDefaultController<any>, { textId: "text", reasoningId: "reasoning" })
    const session = questionRunSession(root)
    beginEmittedStep(SESSION, CONVERSATION)
    return { session, toolCallId: await pumpUntilQuestion(session) }
  }

  it("keeps the conversation and the latest checkpoint after a restart while a question is pending", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "cursor-provenance-"))
    roots.push(root)
    jest.useFakeTimers()
    let session: CursorSession
    let toolCallId: string
    try {
      ;({ session, toolCallId } = await turnThenQuestion(root))
      jest.advanceTimersByTime(HELD_RUN_SAVE_DELAY_MS)
    } finally {
      jest.useRealTimers()
    }
    const saved = await persistedOnDisk(root, (value) => value?.checkpoint?.join() === MID_RUN_CHECKPOINT.join())
    expect(parseTurnProvenance(saved!.turnProvenance!)?.toolCallIds).toEqual([toolCallId])

    restartProcess(session)
    expect(await conversationOfNextTurn(root, promptAfterRestart(toolCallId))).toBe(CONVERSATION)
    expect(getCheckpoint(CONVERSATION)).toEqual(MID_RUN_CHECKPOINT)
    expect((await getPersistedConversation(root, SESSION))?.conversationId).toBe(CONVERSATION)
  })

  it("keeps the conversation when the restart comes before the held Run is saved", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "cursor-provenance-"))
    roots.push(root)
    jest.useFakeTimers()
    let session: CursorSession
    let toolCallId: string
    try {
      ;({ session, toolCallId } = await turnThenQuestion(root))
      jest.advanceTimersByTime(HELD_RUN_SAVE_DELAY_MS - 1)
    } finally {
      jest.useRealTimers()
    }
    restartProcess(session)
    expect(await conversationOfNextTurn(root, promptAfterRestart(toolCallId))).toBe(CONVERSATION)
    expect(getCheckpoint(CONVERSATION)).toEqual(Uint8Array.from([1, 2, 3]))
  })

  it("still rebases after a restart when another model answered last", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "cursor-provenance-"))
    roots.push(root)
    jest.useFakeTimers()
    let session: CursorSession
    try {
      ;({ session } = await turnThenQuestion(root))
      jest.advanceTimersByTime(HELD_RUN_SAVE_DELAY_MS)
    } finally {
      jest.useRealTimers()
    }
    await persistedOnDisk(root, (value) => value?.checkpoint?.join() === MID_RUN_CHECKPOINT.join())
    restartProcess(session)
    const prompt = promptEndingWith(assistantToolCall("call_theirs", "Another model asked this"))
    expect(await conversationOfNextTurn(root, prompt)).not.toBe(CONVERSATION)
  })

  it("saves only a Run still waiting on the host, and keeps the blobs the Run may still need", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "cursor-provenance-"))
    roots.push(root)
    let session: CursorSession
    jest.useFakeTimers()
    try {
      ;({ session } = await turnThenQuestion(root))
      // The answer came back and the Run is generating again when the delay ends.
      session.pending.clear()
      session.pumpActive = true
      jest.advanceTimersByTime(HELD_RUN_SAVE_DELAY_MS)
    } finally {
      jest.useRealTimers()
    }
    await Bun.sleep(20)
    expect((await getPersistedConversation(root, SESSION))?.checkpoint).toEqual(Uint8Array.from([1, 2, 3]))

    setConversationBlob(CONVERSATION, Uint8Array.from([0xab]), Uint8Array.from([7]))
    jest.useFakeTimers()
    try {
      await pumpUntilQuestion(session)
      jest.advanceTimersByTime(HELD_RUN_SAVE_DELAY_MS)
    } finally {
      jest.useRealTimers()
    }
    const saved = await persistedOnDisk(root, (value) => value?.checkpoint?.join() === LATER_CHECKPOINT.join())
    expect(saved!.blobs.map((blob) => blob.id)).toContain("ab")
    expect(conversationBlobCount(CONVERSATION)).toBe(1)
    sessionManager.close(session, "ordinary-cleanup")
  })
})
