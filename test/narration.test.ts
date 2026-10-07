import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { pump, resetTurnStateForTests } from "../src/language-model.js"
import { assistantBlobShape, isNarrationSignature } from "../src/narration.js"
import { sessionManager, type CursorSession, type Frame } from "../src/session.js"
import { decodeMessage, encodeMessage } from "../src/protocol/messages.js"
import { toolsToDescriptors } from "../src/protocol/tools.js"
import { resetCheckpointsForTests } from "../src/protocol/checkpoint.js"
import {
  resetConversationBindingsForTests,
  restoreConversationBinding,
} from "../src/protocol/conversation-bind.js"
import { resetConversationPersistenceForTests } from "../src/protocol/conversation-persistence.js"
import { setHostCacheDirOverride } from "../src/context/paths.js"
import { resetFrozenRequestContextsForTests } from "../src/context/frozen.js"

// Prefixes of real Opus 5.5 signatures from Cursor's stored assistant messages.
const REASONING_SIGNATURE = "CAQSoAkKEggSEAIYAjgBQgh0aGlua2luZxIMJRBnnUuo7eQv5WR4GgztZ2gBdJtO"
const NARRATION_SIGNATURE = "CAQS5wYKEwgSEAIYAjgBQgluYXJyYXRpb24SDMFdI5ZS24+5d6CpIRoMkeUb2lmr"

const frame = (message: Record<string, unknown>): Frame => ({ flags: 0, payload: encodeMessage("AgentServerMessage", message) })
const thinking = (text: string) => frame({ interaction_update: { thinking_delta: { text, thinking_style: 1 } } })
const thinkingCompleted = frame({ interaction_update: { thinking_completed: { thinking_duration_ms: 1200 } } })
const textFrame = (text: string) => frame({ interaction_update: { text_delta: { text } } })
const checkpointFrame = frame({
  conversation_checkpoint_update: encodeMessage("ConversationStateStructure", { token_details: { used_tokens: 200, max_tokens: 1_000_000 } }),
})
const listed = (count: number) => frame({ interaction_update: { tool_requests_listed: { call_count: count } } })
const shellCall = (id: number, callId: string, command: string) => [
  frame({ interaction_update: { tool_call_started: { call_id: callId, tool_call: { shell_tool_call: { args: { command, tool_call_id: callId } } } } } }),
  listed(1),
  frame({ exec_server_message: { id, shell_stream_args: { command, tool_call_id: callId } } }),
]

describe("signature kinds", () => {
  it("tells progress-update signatures from reasoning ones", () => {
    expect(isNarrationSignature(NARRATION_SIGNATURE)).toBe(true)
    expect(isNarrationSignature(REASONING_SIGNATURE)).toBe(false)
    expect(isNarrationSignature("")).toBe(false)
  })

  it("reads the block kinds of a stored assistant message", () => {
    const message = {
      role: "assistant",
      content: [
        { type: "reasoning", text: "Checking.", signature: REASONING_SIGNATURE },
        { type: "reasoning", text: "Here is the plan.", signature: NARRATION_SIGNATURE },
        { type: "tool-call", toolCallId: "t1", toolName: "AskQuestion", input: {} },
      ],
    }
    expect(assistantBlobShape(new Uint8Array(Buffer.from(JSON.stringify(message))))).toEqual(["R", "N", "C"])
    expect(assistantBlobShape(new Uint8Array(Buffer.from('{"role":"user","content":[]}')))).toBeUndefined()
  })
})

describe("progress updates streamed as thinking", () => {
  let root: string
  let seq = 0

  beforeAll(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "cursor-narration-"))
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

  function fakeRun(frames: Frame[], queue: Frame[] = [...frames]): CursorSession {
    const iterator: AsyncIterator<Frame> = {
      next: () => {
        const next = queue.shift()
        return next ? Promise.resolve({ done: false, value: next }) : new Promise(() => {})
      },
    }
    const sessionKey = `ses_narration_${++seq}`
    const conversationId = `conv-${sessionKey}`
    restoreConversationBinding(sessionKey, conversationId)
    const definitions = [{ name: "bash", description: "Shell" }]
    const tools = toolsToDescriptors(definitions, "opencode", [])
    const session = {
      sessionId: `run-${seq}`,
      conversationId,
      cacheDir: path.join(root, "cache"),
      openCodeSessionId: sessionKey,
      stream: {
        write() { return true },
        end() {},
        destroy() {},
        frames: () => ({ [Symbol.asyncIterator]: () => iterator }),
      } as any,
      frames: iterator,
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
    } as unknown as CursorSession
    sessionManager.registerSession(session)
    return session
  }

  async function pass(frames: Frame[], prepare?: (session: CursorSession, queue: Frame[]) => void) {
    const parts: any[] = []
    const controller = {
      enqueue(part: unknown) { parts.push(part) },
      error(error: Error) { throw error },
    } as unknown as ReadableStreamDefaultController<any>
    const queue = [...frames]
    const session = fakeRun(frames, queue)
    prepare?.(session, queue)
    await pump(session, controller, { textId: "text", reasoningId: "reasoning" })
    return parts
  }
  const joined = (parts: any[], type: string) => parts.filter((p) => p.type === type).map((p) => p.delta).join("")
  const kinds = (parts: any[]) => parts.map((p) => p.type).filter((type) => !type.endsWith("-delta"))

  it("shows the block after a finished reasoning block as text, before the tool call", async () => {
    const parts = await pass([
      thinking("The user wants a choice. "),
      thinking("I'll explain, then ask.\n\n"),
      thinkingCompleted,
      thinking("Three options fit; I recommend the first.\n\n"),
      thinkingCompleted,
      ...shellCall(1, "call-1", "echo hi"),
    ])
    expect(joined(parts, "reasoning-delta")).toBe("The user wants a choice. I'll explain, then ask.\n\n")
    expect(joined(parts, "text-delta")).toBe("Three options fit; I recommend the first.\n\n")
    expect(kinds(parts)).toEqual([
      "reasoning-start", "reasoning-end", "text-start", "text-end", "tool-call", "finish",
    ])
  })

  it("keeps a lone reasoning block as reasoning", async () => {
    const parts = await pass([
      thinking("Just run it."),
      thinking(" Nothing to say first.\n\n"),
      thinkingCompleted,
      ...shellCall(1, "call-1", "echo hi"),
    ])
    expect(joined(parts, "reasoning-delta")).toBe("Just run it. Nothing to say first.\n\n")
    expect(joined(parts, "text-delta")).toBe("")
  })

  it("leaves real text alone", async () => {
    const parts = await pass([
      thinking("Explain first.\n\n"),
      thinkingCompleted,
      textFrame("Here is what I found."),
      ...shellCall(1, "call-1", "echo hi"),
    ])
    expect(joined(parts, "reasoning-delta")).toBe("Explain first.\n\n")
    expect(joined(parts, "text-delta")).toBe("Here is what I found.")
  })

  it("starts counting again after each tool call", async () => {
    const parts = await pass([
      thinking("Look up the tools.\n\n"),
      thinkingCompleted,
      frame({ interaction_update: { tool_call_started: { call_id: "internal-1", tool_call: {} } } }),
      frame({ interaction_update: { tool_call_completed: { call_id: "internal-1", tool_call: {} } } }),
      thinking("Now the shell.\n\n"),
      thinkingCompleted,
      thinking("Running the check now.\n\n"),
      thinkingCompleted,
      ...shellCall(1, "call-1", "echo hi"),
    ])
    expect(joined(parts, "reasoning-delta")).toBe("Look up the tools.\n\nNow the shell.\n\n")
    expect(joined(parts, "text-delta")).toBe("Running the check now.\n\n")
  })

  it("keeps spans apart when reasoning follows a progress update across a Cursor-side tool", async () => {
    const parts = await pass([
      thinking("Need the MCP tools.\n\n"),
      thinkingCompleted,
      thinking("Looking up the tools first.\n\n"),
      thinkingCompleted,
      frame({ interaction_update: { tool_call_started: { call_id: "internal-1", tool_call: {} } } }),
      frame({ interaction_update: { tool_call_completed: { call_id: "internal-1", tool_call: {} } } }),
      thinking("Now run it.\n\n"),
      thinkingCompleted,
      textFrame("Running the check."),
      ...shellCall(1, "call-1", "echo hi"),
    ])
    const open = new Set<string>()
    const ended = new Set<string>()
    for (const part of parts) {
      const [kind, phase] = String(part.type).split("-")
      if (!["text", "reasoning"].includes(kind!) || !part.id) continue
      const key = `${kind}:${part.id}`
      if (phase === "start") {
        expect(ended.has(key)).toBe(false)
        expect(open.size).toBe(0)
        open.add(key)
      } else if (phase === "delta") {
        expect(open.has(key)).toBe(true)
      } else if (phase === "end") {
        expect(open.delete(key)).toBe(true)
        ended.add(key)
      }
    }
    expect(open.size).toBe(0)
    expect(joined(parts, "reasoning-delta")).toBe("Need the MCP tools.\n\nNow run it.\n\n")
    expect(joined(parts, "text-delta")).toBe("Looking up the tools first.\n\nRunning the check.")
  })

  it("starts counting again in a Run the same step reopens", async () => {
    let reopened = 0
    const parts = await pass(
      [
        thinking("Plan the check.\n\n"),
        thinkingCompleted,
        thinking("Checking the workspace files"),
        thinkingCompleted,
        checkpointFrame,
        frame({ interaction_update: { turn_ended: { input_tokens: 10, output_tokens: 2 } } }),
      ],
      (session, queue) => {
        session.reopenWithUserMessage = async () => {
          reopened++
          queue.push(
            thinking("Fresh reasoning in the follow-up.\n\n"),
            thinkingCompleted,
            textFrame("All files are present."),
            frame({ interaction_update: { turn_ended: { input_tokens: 12, output_tokens: 3 } } }),
          )
        }
      },
    )
    expect(reopened).toBe(1)
    expect(joined(parts, "reasoning-delta")).toBe("Plan the check.\n\nFresh reasoning in the follow-up.\n\n")
    expect(joined(parts, "text-delta")).toBe("Checking the workspace filesAll files are present.")
  })

  it("decodes thinking_completed and thinking_style", () => {
    const decoded = decodeMessage<any>("AgentServerMessage", thinkingCompleted.payload)
    expect(decoded.interaction_update.thinking_completed.thinking_duration_ms).toBe(1200)
    const style = decodeMessage<any>("AgentServerMessage", thinking("x").payload)
    expect(style.interaction_update.thinking_delta.thinking_style).toBe(1)
  })
})
