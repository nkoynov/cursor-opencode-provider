import { describe, it, expect, beforeAll, afterAll, afterEach } from "bun:test"
import { EventEmitter } from "node:events"
import fs from "node:fs"
import http2 from "node:http2"
import os from "node:os"
import path from "node:path"
import type { LanguageModelV3CallOptions } from "@ai-sdk/provider"
import { createCursor } from "../src/index.js"
import { resetTurnStateForTests } from "../src/language-model.js"
import { sessionManager } from "../src/session.js"
import { encodeFrame } from "../src/protocol/framing.js"
import { decodeMessage, encodeMessage } from "../src/protocol/messages.js"
import { resetCheckpointsForTests, setCheckpoint } from "../src/protocol/checkpoint.js"
import { resetConversationBindingsForTests, restoreConversationBinding } from "../src/protocol/conversation-bind.js"
import { resetConversationPersistenceForTests } from "../src/protocol/conversation-persistence.js"
import { resetFrozenRequestContextsForTests } from "../src/context/frozen.js"
import { setHostCacheDirOverride } from "../src/context/paths.js"
import { closeCachedHttp2SessionsForTests } from "../src/transport/connect.js"

type Prompt = LanguageModelV3CallOptions["prompt"]

const QUESTION = "Is cursor cli better than open code"
const TASK_NOTE = '<task id="ses_bg" state="completed">\n<summary>Background task completed: run the tests</summary>\n<task_result>\nAll 12 tests pass.\n</task_result>\n</task>'
const SYSTEM_UPDATE = "<system-update>\nThe available tools have changed.\n</system-update>"

const user = (text: string) => ({ role: "user", content: [{ type: "text", text }] })
const assistant = (text: string) => ({ role: "assistant", content: [{ type: "text", text }] })
const checkpoint = () => encodeMessage("ConversationStateStructure", { token_details: { used_tokens: 1_000, max_tokens: 200_000 } })

/** Stands in for Cursor's Run endpoint: records each Run request and ends its turn. */
function fakeCursorRuns(): { runs: any[]; restore: () => void } {
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
          write(frame: Uint8Array) {
            const message = decodeMessage<any>("AgentClientMessage", frame.subarray(5))
            if (message.run_request) {
              runs.push(message.run_request)
              setImmediate(() => {
                stream.emit("response", { ":status": 200 })
                stream.emit("data", encodeFrame(0, encodeMessage("AgentServerMessage", {
                  interaction_update: { turn_ended: { input_tokens: 1, output_tokens: 1 } },
                })))
                stream.emit("end")
                stream.closed = true
                stream.emit("close")
              })
            }
            return true
          },
          end() {},
          close() { stream.closed = true },
          destroy() { stream.destroyed = true },
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

describe("the user turn of a fresh Run", () => {
  let root: string
  let cursor: ReturnType<typeof fakeCursorRuns>
  let seq = 0

  beforeAll(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "cursor-live-turn-"))
    setHostCacheDirOverride(path.join(root, "cache"))
    cursor = fakeCursorRuns()
  })

  afterAll(() => {
    cursor.restore()
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

  /** Run one step of a new OpenCode session; with `checkpointed`, Cursor already holds the conversation. */
  async function runStep(prompt: Prompt, options: { checkpointed?: boolean; toolsAllowed?: boolean } = {}): Promise<any> {
    const sessionKey = `ses_live_turn_${++seq}`
    if (options.checkpointed) {
      restoreConversationBinding(sessionKey, `conv-${sessionKey}`)
      setCheckpoint(`conv-${sessionKey}`, checkpoint())
    }
    const realFetch = globalThis.fetch
    globalThis.fetch = (async () => { throw new Error("no network in this test") }) as unknown as typeof fetch
    try {
      const model = createCursor({
        name: "cursor",
        accessToken: "token",
        agentBaseURL: "https://agentn.us.api5.cursor.sh",
        workspaceRoot: root,
      }).languageModel("cursor-test")
      const before = cursor.runs.length
      const result = await model.doStream({
        prompt,
        headers: { "x-opencode-session-id": sessionKey },
        tools: [{ type: "function", name: "read", description: "Read a file", inputSchema: { type: "object", properties: {} } }],
        ...(options.toolsAllowed === false ? { toolChoice: { type: "none" } } : {}),
      } as LanguageModelV3CallOptions)
      const reader = result.stream.getReader()
      while (!(await reader.read()).done) { /* drain */ }
      expect(cursor.runs.length).toBe(before + 1)
      return cursor.runs.at(-1)
    } finally {
      globalThis.fetch = realFetch
    }
  }

  const userText = (run: any): string => run.action.user_message_action.user_message.text
  /** Prior turns go out as seeded root messages or as a transcript that opens the user message. */
  const splitHistory = (run: any): { history: string; live: string } => {
    const seeded = (decodeMessage<any>("ConversationStateStructure", run.conversation_state).root_prompt_messages_json ?? []).join("\n")
    const text = userText(run)
    const end = text.indexOf("</conversation_history>")
    if (end === -1) return { history: seeded, live: text }
    const close = end + "</conversation_history>".length
    return { history: `${seeded}\n${text.slice(0, close)}`, live: text.slice(close).replace(/^\n\n/, "") }
  }
  const occurrences = (text: string, part: string) => text.split(part).length - 1

  it("sends the user's message and a host note that arrived right after it, in order, on a Run with a checkpoint", async () => {
    const run = await runStep([
      { role: "system", content: "You are a coding agent." },
      user("hello"),
      assistant("Hi."),
      user(QUESTION),
      user(TASK_NOTE),
    ] as Prompt, { checkpointed: true })

    expect(new Uint8Array(run.conversation_state)).toEqual(checkpoint())
    const text = userText(run)
    expect(text).toStartWith(`${QUESTION}\n\n${TASK_NOTE}`)
    expect(occurrences(text, QUESTION)).toBe(1)
    expect(occurrences(text, TASK_NOTE)).toBe(1)
  })

  it("sends a host note queued before the user's message ahead of it on a Run with a checkpoint", async () => {
    const run = await runStep([
      { role: "system", content: "You are a coding agent." },
      user("hello"),
      assistant("Hi."),
      user(SYSTEM_UPDATE),
      user(QUESTION),
    ] as Prompt, { checkpointed: true })

    expect(userText(run)).toStartWith(`${SYSTEM_UPDATE}\n\n${QUESTION}`)
  })

  it("keeps the user's message and the note out of the seeded history of a Run without a checkpoint", async () => {
    const run = await runStep([
      { role: "system", content: "You are a coding agent." },
      user("hello"),
      assistant("Hi."),
      user(QUESTION),
      user(TASK_NOTE),
    ] as Prompt)

    const { history, live } = splitHistory(run)
    expect(live).toStartWith(`${QUESTION}\n\n${TASK_NOTE}`)
    expect(history).toContain("hello")
    expect(history).toContain("Hi.")
    expect(history).not.toContain(QUESTION)
    expect(history).not.toContain("task_result")
  })

  it("leaves a call without tools, such as a title, to its own last message", async () => {
    const run = await runStep([
      { role: "system", content: "Write a short title." },
      user(QUESTION),
      user("Generate a title for this conversation."),
    ] as Prompt, { toolsAllowed: false })

    expect(splitHistory(run).live).toStartWith("Generate a title for this conversation.")
  })
})
