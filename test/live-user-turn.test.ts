import { describe, it, expect, beforeAll, afterAll, afterEach } from "bun:test"
import { EventEmitter } from "node:events"
import fs from "node:fs"
import http2 from "node:http2"
import os from "node:os"
import path from "node:path"
import type { LanguageModelV3CallOptions } from "@ai-sdk/provider"
import { createCursor } from "../src/index.js"
import { resetTurnStateForTests, restoreTurnToolCatalog } from "../src/language-model.js"
import { sessionManager } from "../src/session.js"
import { forgetEarlySteers, recordEarlySteer } from "../src/host-steer.js"
import { encodeFrame } from "../src/protocol/framing.js"
import { decodeMessage, encodeMessage } from "../src/protocol/messages.js"
import { resetCheckpointsForTests, setCheckpoint } from "../src/protocol/checkpoint.js"
import { resetConversationBindingsForTests, restoreConversationBinding } from "../src/protocol/conversation-bind.js"
import { resetConversationPersistenceForTests } from "../src/protocol/conversation-persistence.js"
import { persistConversationState } from "../src/protocol/conversation-state.js"
import { opencodeGlobalCacheDir, setHostCacheDirOverride } from "../src/context/paths.js"
import { resetFrozenRequestContextsForTests } from "../src/context/frozen.js"
import { systemInstructionsRule } from "../src/context/build.js"
import { closeCachedHttp2SessionsForTests } from "../src/transport/connect.js"

type Prompt = LanguageModelV3CallOptions["prompt"]

const QUESTION = "Is cursor cli better than open code"
const TASK_NOTE = '<task id="ses_bg" state="completed">\n<summary>Background task completed: run the tests</summary>\n<task_result>\nAll 12 tests pass.\n</task_result>\n</task>'
const SYSTEM_UPDATE = "<system-update>\nThe available tools have changed.\n</system-update>"
const STEER = "Also check the README"
const SYSTEM = "You are a coding agent."

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
  const sessions: string[] = []

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
    for (const sessionKey of sessions.splice(0)) forgetEarlySteers(sessionKey)
    sessionManager.dispose()
    resetTurnStateForTests()
    resetCheckpointsForTests()
    resetConversationBindingsForTests()
    resetConversationPersistenceForTests()
    resetFrozenRequestContextsForTests()
  })

  /** `bound`: this process already runs the session's conversation; `checkpointed`: and holds its checkpoint. */
  function newSession(options: { bound?: boolean; checkpointed?: boolean } = {}): string {
    const sessionKey = `ses_live_turn_${++seq}`
    sessions.push(sessionKey)
    if (options.bound || options.checkpointed) restoreConversationBinding(sessionKey, `conv-${sessionKey}`)
    if (options.checkpointed) setCheckpoint(`conv-${sessionKey}`, checkpoint())
    return sessionKey
  }

  /** Run one step; returns the Run request Cursor got, if the step opened one. */
  async function step(sessionKey: string, prompt: Prompt, options: { toolsAllowed?: boolean; tools?: [] } = {}): Promise<any> {
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
        tools: options.tools ?? [{ type: "function", name: "read", description: "Read a file", inputSchema: { type: "object", properties: {} } }],
        ...(options.toolsAllowed === false ? { toolChoice: { type: "none" } } : {}),
      } as LanguageModelV3CallOptions)
      const reader = result.stream.getReader()
      while (!(await reader.read()).done) { /* drain */ }
      expect(cursor.runs.length - before).toBeLessThanOrEqual(1)
      return cursor.runs.length > before ? cursor.runs.at(-1) : undefined
    } finally {
      globalThis.fetch = realFetch
    }
  }

  const userText = (run: any): string => run.action.user_message_action.user_message.text
  /** A Run without a checkpoint opens its user message with the replayed history. */
  const splitTranscript = (run: any): { transcript: string; live: string } => {
    const text = userText(run)
    const end = text.indexOf("</conversation_history>")
    if (end === -1) return { transcript: "", live: text }
    const close = end + "</conversation_history>".length
    return { transcript: text.slice(0, close), live: text.slice(close).replace(/^\n\n/, "") }
  }
  const occurrences = (text: string, part: string) => text.split(part).length - 1
  const answeredEarly = (sessionKey: string, text: string) => recordEarlySteer({
    sessionID: sessionKey,
    inboxID: `msg_${text.length}`,
    text,
    injectionId: `inj_${text.length}`,
    conversationId: `conv-${sessionKey}`,
    answered: true,
  })

  it("sends the user's message and a host note that arrived right after it, in order, on a Run with a checkpoint", async () => {
    const run = await step(newSession({ checkpointed: true }), [
      { role: "system", content: "You are a coding agent." },
      user("hello"),
      assistant("Hi."),
      user(QUESTION),
      user(TASK_NOTE),
    ] as Prompt)

    expect(new Uint8Array(run.conversation_state)).toEqual(checkpoint())
    const text = userText(run)
    expect(text).toStartWith(`${QUESTION}\n\n${TASK_NOTE}`)
    expect(occurrences(text, QUESTION)).toBe(1)
    expect(occurrences(text, TASK_NOTE)).toBe(1)
  })

  it("sends a host note queued before the user's message ahead of it on a Run with a checkpoint", async () => {
    const run = await step(newSession({ checkpointed: true }), [
      { role: "system", content: "You are a coding agent." },
      user("hello"),
      assistant("Hi."),
      user(SYSTEM_UPDATE),
      user(QUESTION),
    ] as Prompt)

    expect(userText(run)).toStartWith(`${SYSTEM_UPDATE}\n\n${QUESTION}`)
  })

  it("keeps the user's message and the note out of the replayed history of a Run without a checkpoint", async () => {
    const run = await step(newSession({ bound: true }), [
      { role: "system", content: "You are a coding agent." },
      user("hello"),
      assistant("Hi."),
      user(QUESTION),
      user(TASK_NOTE),
    ] as Prompt)

    const { transcript, live } = splitTranscript(run)
    expect(live).toStartWith(`${QUESTION}\n\n${TASK_NOTE}`)
    expect(transcript).toContain("[User]\nhello")
    expect(transcript).toContain("[Assistant]\nHi.")
    expect(transcript).not.toContain(QUESTION)
    expect(transcript).not.toContain("task_result")
    expect(transcript).not.toContain("no reply")
  })

  /** Two reads whose results are `earlyChars` and `laterChars` long, then the user's question. */
  const readsPrompt = (earlyChars: number, laterChars: number) => [
    { role: "system", content: SYSTEM },
    user("Read a and b"),
    { role: "assistant", content: [{ type: "tool-call", toolCallId: "call_a", toolName: "read", input: { path: "a" } }] },
    { role: "tool", content: [{ type: "tool-result", toolCallId: "call_a", toolName: "read", output: { type: "text", value: `a-start ${"a".repeat(earlyChars)} a-end` } }] },
    { role: "assistant", content: [{ type: "tool-call", toolCallId: "call_b", toolName: "read", input: { path: "b" } }] },
    { role: "tool", content: [{ type: "tool-result", toolCallId: "call_b", toolName: "read", output: { type: "text", value: `b-start ${"b".repeat(laterChars)} b-end` } }] },
    assistant("Read both."),
    user(QUESTION),
  ] as Prompt

  it("replays every earlier tool result whole on a Run without a checkpoint", async () => {
    const { transcript } = splitTranscript(await step(newSession({ bound: true }), readsPrompt(50_000, 50_000)))
    expect(transcript).toContain("a-end")
    expect(transcript).toContain("b-end")
    expect(transcript).not.toContain("left out of this replay")
  })

  it("shortens only the oldest tool result when the replay would exceed the context budget", async () => {
    // cursor-test has the 200K default context, so the replay may take 80% of it: ~280K characters.
    const { transcript } = splitTranscript(await step(newSession({ bound: true }), readsPrompt(200_000, 150_000)))
    expect(transcript).toContain("a-start")
    expect(transcript).not.toContain("a-end")
    expect(transcript).toContain("more characters left out of this replay to fit the context window]")
    expect(transcript).toContain("b-end")
    expect(transcript.length).toBeLessThan(280_000)
  })

  it("leaves a call without tools, such as a title, to its own last message", async () => {
    const run = await step(newSession(), [
      { role: "system", content: "Write a short title." },
      user(QUESTION),
      user("Generate a title for this conversation."),
    ] as Prompt, { toolsAllowed: false })

    expect(splitTranscript(run).live).toBe("Write a short title.\n\n<input>\nGenerate a title for this conversation.\n</input>")
  })

  it("sends a title call without the session's tools, its task opening the user turn", async () => {
    const sessionKey = newSession()
    restoreTurnToolCatalog(sessionKey, [{ name: "read", description: "Read a file", inputSchema: { type: "object", properties: {} } }])
    const run = await step(sessionKey, [
      { role: "system", content: "You are a title generator." },
      user("get my latest Slack message"),
    ] as Prompt, { tools: [] })

    const requestContext = run.action.user_message_action.request_context
    expect(requestContext.mcp_meta_tool_options?.mcp_descriptors ?? []).toEqual([])
    expect(userText(run)).toBe("You are a title generator.\n\n<input>\nget my latest Slack message\n</input>")
  })

  it("does not send again a steer the model answered early when a note follows it", async () => {
    const sessionKey = newSession({ checkpointed: true })
    answeredEarly(sessionKey, STEER)

    const run = await step(sessionKey, [
      user("Read the docs"),
      assistant("Read them, and the README too."),
      user(STEER),
      user(TASK_NOTE),
    ] as Prompt)

    expect(userText(run)).toStartWith(TASK_NOTE)
    expect(userText(run)).not.toContain(STEER)
  })

  it("does not send again an answered steer that ended its step without a Run", async () => {
    const sessionKey = newSession({ checkpointed: true })
    answeredEarly(sessionKey, STEER)
    const answered = [user("Read the docs"), assistant("Read them, and the README too."), user(STEER)] as Prompt

    expect(await step(sessionKey, answered)).toBeUndefined()
    const run = await step(sessionKey, [...answered, user(QUESTION)] as Prompt)

    expect(userText(run)).toStartWith(QUESTION)
    expect(userText(run)).not.toContain(STEER)
  })

  it("keeps an answered steer in the replay as a message with no reply", async () => {
    const sessionKey = newSession({ bound: true })
    answeredEarly(sessionKey, STEER)

    const run = await step(sessionKey, [
      user("Read the docs"),
      assistant("Read them, and the README too."),
      user(STEER),
      user(QUESTION),
    ] as Prompt)

    const { transcript, live } = splitTranscript(run)
    expect(live).toStartWith(QUESTION)
    expect(live).not.toContain(STEER)
    expect(transcript).toContain(`[User, no reply]\n${STEER}`)
  })

  /** The last turn ended and saved its snapshot; then the provider restarted. */
  async function savedBeforeRestart(sessionKey: string, saved: { answeredSteers?: string[]; hostNote?: string }): Promise<void> {
    await persistConversationState(opencodeGlobalCacheDir(), {
      sessionKey,
      conversationId: `conv-${sessionKey}`,
      requestContext: { rules_info_complete: true, rules: [systemInstructionsRule(SYSTEM)] },
      ...saved,
    })
    resetConversationPersistenceForTests()
    resetConversationBindingsForTests()
    resetCheckpointsForTests()
    resetTurnStateForTests()
  }

  it("does not send again an answered steer after a restart", async () => {
    const sessionKey = newSession({ checkpointed: true })
    await savedBeforeRestart(sessionKey, { answeredSteers: [STEER] })

    const run = await step(sessionKey, [
      user("Read the docs"),
      assistant("Read them, and the README too."),
      user(STEER),
      user(QUESTION),
    ] as Prompt)

    expect(new Uint8Array(run.conversation_state)).toEqual(checkpoint())
    expect(userText(run)).toStartWith(QUESTION)
    expect(userText(run)).not.toContain(STEER)
  })

  it("after a restart that lost the snapshot, sends the last message and replays the earlier ones as no reply", async () => {
    const run = await step(newSession(), [
      user("What is 17 * 23?"),
      assistant("391"),
      user(STEER),
      user(QUESTION),
    ] as Prompt)

    const { transcript, live } = splitTranscript(run)
    expect(live).toStartWith(QUESTION)
    expect(live).not.toContain(STEER)
    expect(transcript).toContain(`[User, no reply]\n${STEER}`)
  })

  it("sends a note and the user's first message of a new session together", async () => {
    const run = await step(newSession(), [
      { role: "system", content: SYSTEM },
      user(SYSTEM_UPDATE),
      user(QUESTION),
    ] as Prompt)

    expect(splitTranscript(run).live).toStartWith(`${SYSTEM_UPDATE}\n\n${QUESTION}`)
  })

  it("still sends a user turn the restart snapshot would leave empty", async () => {
    const sessionKey = newSession({ checkpointed: true })
    await savedBeforeRestart(sessionKey, { answeredSteers: [STEER, QUESTION] })

    const run = await step(sessionKey, [
      user("Read the docs"),
      assistant("Read them, and the README too."),
      user(STEER),
      user(QUESTION),
    ] as Prompt)

    expect(userText(run)).toStartWith(`${STEER}\n\n${QUESTION}`)
  })

  it("sends an undelivered host note once when the user turn holds it too", async () => {
    const sessionKey = newSession({ checkpointed: true })
    await savedBeforeRestart(sessionKey, { hostNote: SYSTEM_UPDATE })

    const run = await step(sessionKey, [
      { role: "system", content: SYSTEM },
      user("hello"),
      assistant("Hi."),
      user(SYSTEM_UPDATE),
      user(QUESTION),
    ] as Prompt)

    const text = userText(run)
    expect(text).toStartWith(`${SYSTEM_UPDATE}\n\n${QUESTION}`)
    expect(occurrences(text, SYSTEM_UPDATE)).toBe(1)
  })

  it("still sends a steer the model has not answered", async () => {
    const sessionKey = newSession({ checkpointed: true })
    recordEarlySteer({
      sessionID: sessionKey,
      inboxID: "msg_open",
      text: STEER,
      injectionId: "inj_open",
      conversationId: `conv-${sessionKey}`,
      answered: false,
    })

    const run = await step(sessionKey, [
      user("Read the docs"),
      assistant("Reading."),
      user(STEER),
      user(TASK_NOTE),
    ] as Prompt)

    expect(userText(run)).toStartWith(`${STEER}\n\n${TASK_NOTE}`)
  })
})
