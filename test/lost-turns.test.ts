import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test"
import { EventEmitter } from "node:events"
import fs from "node:fs"
import http2 from "node:http2"
import os from "node:os"
import path from "node:path"
import type { LanguageModelV3CallOptions } from "@ai-sdk/provider"
import { createCursor } from "../src/index.js"
import { resetTurnStateForTests } from "../src/language-model.js"
import { noteFailedTurn, resetLostTurnsForTests, takeLostRequests, withLostRequests } from "../src/lost-turns.js"
import { sessionManager, type CursorSession } from "../src/session.js"
import { encodeFrame } from "../src/protocol/framing.js"
import { decodeMessage, encodeMessage } from "../src/protocol/messages.js"
import { resetCheckpointsForTests, setCheckpoint } from "../src/protocol/checkpoint.js"
import { resetConversationBindingsForTests, restoreConversationBinding } from "../src/protocol/conversation-bind.js"
import { resetConversationPersistenceForTests } from "../src/protocol/conversation-persistence.js"
import { setHostCacheDirOverride } from "../src/context/paths.js"
import { resetFrozenRequestContextsForTests } from "../src/context/frozen.js"
import { closeCachedHttp2SessionsForTests } from "../src/transport/connect.js"

type Prompt = LanguageModelV3CallOptions["prompt"]
type ScriptedFrame = Record<string, unknown> | { endStreamError: string }

/** Cursor's Run endpoint: records each Run request and plays one scripted frame list per Run. */
function fakeCursorRuns(script: ScriptedFrame[][]): { runs: any[]; restore: () => void } {
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
                for (const item of frames) {
                  if ("endStreamError" in item) {
                    const body = new TextEncoder().encode(JSON.stringify({ error: { code: item.endStreamError } }))
                    stream.emit("data", encodeFrame(0x02, body))
                  } else {
                    stream.emit("data", encodeFrame(0, encodeMessage("AgentServerMessage", item)))
                  }
                }
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

const REQUEST = "Create catalog.md with a 120-row table of fictional minerals in a single write call."
const CONTINUE = "The previous response was interrupted. Continue from where you left off without repeating completed content."
const SYSTEM = { role: "system", content: "You are a coding agent." }
const user = (text: string) => ({ role: "user", content: [{ type: "text", text }] })
const assistant = (text: string) => ({ role: "assistant", content: [{ type: "text", text }] })
const thoughtOnly = (text: string) => ({ role: "assistant", content: [{ type: "reasoning", text }] })
const checkpointFrame = (used: number) => ({
  conversation_checkpoint_update: encodeMessage("ConversationStateStructure", { token_details: { used_tokens: used, max_tokens: 1_000_000 } }),
})
/** The model thinks, Cursor announces a write, and the stream fails before the step ends, so no checkpoint. */
const failedFirstStep = (): ScriptedFrame[] => [
  { interaction_update: { thinking_delta: { text: "Writing the table." } } },
  { interaction_update: { partial_tool_call: { call_id: "toolu_w", tool_call: { edit_tool_call: { args: { path: "catalog.md" } } } } } },
  { endStreamError: "internal" },
]
const cleanTurn = (answer: string): ScriptedFrame[] => [
  { interaction_update: { text_delta: { text: answer } } },
  checkpointFrame(1234),
  { interaction_update: { turn_ended: { input_tokens: 1, output_tokens: 1 } } },
]
const runText = (run: any): string => run.action.user_message_action.user_message.text

describe("a turn whose Run failed before Cursor checkpointed the request", () => {
  let root: string
  let seq = 0

  beforeAll(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "cursor-lost-turns-"))
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

  /** One OpenCode step; a failed Run surfaces as the stream's error. */
  async function step(sessionKey: string, prompt: Prompt): Promise<{ text: string; error?: Error }> {
    const realFetch = globalThis.fetch
    globalThis.fetch = (async () => { throw new Error("no network in this test") }) as unknown as typeof fetch
    let text = ""
    try {
      const model = createCursor({ name: "cursor", accessToken: "token", agentBaseURL: "https://agentn.us.api5.cursor.sh", workspaceRoot: root })
        .languageModel("claude-opus-5-5")
      const result = await model.doStream({
        prompt,
        headers: { "x-opencode-session-id": sessionKey },
        tools: [{ type: "function", name: "write", description: "Write a file", inputSchema: { type: "object", properties: {} } }],
      } as LanguageModelV3CallOptions)
      const reader = result.stream.getReader()
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        if ((value as any).type === "text-delta") text += (value as any).delta
        if ((value as any).type === "error") return { text, error: (value as any).error }
      }
      return { text }
    } catch (error) {
      return { text, error: error as Error }
    } finally {
      globalThis.fetch = realFetch
    }
  }

  function checkpointedSession(): { sessionKey: string; base: Uint8Array } {
    const sessionKey = `ses_lost_${++seq}`
    const base = encodeMessage("ConversationStateStructure", { token_details: { used_tokens: 10, max_tokens: 1_000_000 } })
    restoreConversationBinding(sessionKey, `conv-${sessionKey}`)
    setCheckpoint(`conv-${sessionKey}`, base)
    return { sessionKey, base }
  }
  const history = [SYSTEM, user("Reply with just: ok"), assistant("ok")]

  it("sends the request again with OpenCode's continue message, from the same checkpoint", async () => {
    const cursor = fakeCursorRuns([failedFirstStep(), cleanTurn("done")])
    try {
      const { sessionKey, base } = checkpointedSession()
      const failed = await step(sessionKey, [...history, user(REQUEST)] as Prompt)
      expect(failed.error?.message).toContain("automatic retry unsafe")

      const retried = await step(sessionKey, [...history, user(REQUEST), thoughtOnly("Writing the table."), user(CONTINUE)] as Prompt)
      expect(retried.text).toBe("done")
      const [first, second] = cursor.runs
      expect(second.conversation_id).toBe(first.conversation_id)
      expect(new Uint8Array(second.conversation_state)).toEqual(base)
      expect(runText(second)).toStartWith(`${REQUEST}\n\n${CONTINUE}`)
    } finally {
      cursor.restore()
    }
  })

  it("sends it once when OpenCode retries the same prompt", async () => {
    const cursor = fakeCursorRuns([failedFirstStep(), cleanTurn("done")])
    try {
      const { sessionKey } = checkpointedSession()
      await step(sessionKey, [...history, user(REQUEST)] as Prompt)
      await step(sessionKey, [...history, user(REQUEST)] as Prompt)
      const text = runText(cursor.runs[1])
      expect(text).toEndWith(REQUEST)
      expect(text.split(REQUEST)).toHaveLength(2)
    } finally {
      cursor.restore()
    }
  })

  it("keeps the request through repeated failures without repeating the continue message", async () => {
    const cursor = fakeCursorRuns([failedFirstStep(), failedFirstStep(), cleanTurn("done")])
    try {
      const { sessionKey } = checkpointedSession()
      const failedTurn = [...history, user(REQUEST), thoughtOnly("Writing the table.")]
      await step(sessionKey, [...history, user(REQUEST)] as Prompt)
      await step(sessionKey, [...failedTurn, user(CONTINUE)] as Prompt)
      await step(sessionKey, [...failedTurn, user(CONTINUE), thoughtOnly("Writing the table."), user(CONTINUE)] as Prompt)
      expect(runText(cursor.runs[1])).toStartWith(`${REQUEST}\n\n${CONTINUE}`)
      const third = runText(cursor.runs[2])
      expect(third).toStartWith(`${REQUEST}\n\n${CONTINUE}`)
      expect(third.split(CONTINUE)).toHaveLength(2)
    } finally {
      cursor.restore()
    }
  })

  it("does not carry a request Cursor checkpointed before the Run and its recoveries failed", async () => {
    const resumesFailing: ScriptedFrame[][] = [[{ endStreamError: "internal" }], [{ endStreamError: "internal" }]]
    const cursor = fakeCursorRuns([
      [
        { interaction_update: { text_delta: { text: "Reading first." } } },
        checkpointFrame(500),
        { endStreamError: "internal" },
      ],
      ...resumesFailing,
      cleanTurn("done"),
    ])
    try {
      const { sessionKey } = checkpointedSession()
      const failed = await step(sessionKey, [...history, user(REQUEST)] as Prompt)
      expect(failed.error).toBeDefined()
      await step(sessionKey, [...history, user(REQUEST), assistant("Reading first."), user(CONTINUE)] as Prompt)
      const text = runText(cursor.runs.at(-1))
      expect(text).toEndWith(`</conversation_history>\n\n${CONTINUE}`)
      expect(text.split(REQUEST)).toHaveLength(2)
    } finally {
      cursor.restore()
    }
  })

  it("does not carry anything after a turn that ended normally", async () => {
    const cursor = fakeCursorRuns([cleanTurn("first"), cleanTurn("second")])
    try {
      const { sessionKey } = checkpointedSession()
      await step(sessionKey, [...history, user(REQUEST)] as Prompt)
      await step(sessionKey, [...history, user(REQUEST), assistant("first"), user("Next one.")] as Prompt)
      expect(runText(cursor.runs[1])).toStartWith("Next one.")
      expect(runText(cursor.runs[1])).not.toContain(REQUEST)
    } finally {
      cursor.restore()
    }
  })
})

describe("lost turn records", () => {
  const base = Uint8Array.from([1, 2, 3])
  const failed = (init: Partial<CursorSession>): CursorSession => ({
    openCodeSessionId: "ses_unit",
    conversationId: "conv-unit",
    modelSwitchGuard: { turnBase: base, latestCheckpoint: base, stepOpen: false, toolRuns: [], userText: REQUEST },
    ...init,
  }) as CursorSession
  afterEach(() => resetLostTurnsForTests())

  it("are taken once, only by a Run on the same conversation and checkpoint", () => {
    noteFailedTurn(failed({}))
    expect(takeLostRequests("ses_unit", "conv-other", base)).toBeUndefined()
    expect(takeLostRequests("ses_unit", "conv-unit", base)).toBeUndefined()
    noteFailedTurn(failed({}))
    expect(takeLostRequests("ses_unit", "conv-unit", Uint8Array.from([1, 2, 4]))).toBeUndefined()
    noteFailedTurn(failed({}))
    expect(takeLostRequests("ses_unit", "conv-unit", Uint8Array.from(base))).toEqual([REQUEST])
    expect(takeLostRequests("ses_unit", "conv-unit", base)).toBeUndefined()
  })

  it("are not kept for a turn without a starting checkpoint or with a newer one", () => {
    noteFailedTurn(failed({ modelSwitchGuard: { latestCheckpoint: undefined, stepOpen: false, toolRuns: [], userText: REQUEST } }))
    expect(takeLostRequests("ses_unit", "conv-unit", undefined)).toBeUndefined()
    noteFailedTurn(failed({ modelSwitchGuard: { turnBase: base, latestCheckpoint: Uint8Array.from([9]), stepOpen: false, toolRuns: [], userText: REQUEST } }))
    expect(takeLostRequests("ses_unit", "conv-unit", base)).toBeUndefined()
  })

  it("join the live request unless it repeats one of them", () => {
    expect(withLostRequests([REQUEST], CONTINUE)).toEqual([REQUEST, CONTINUE])
    expect(withLostRequests([REQUEST, CONTINUE], CONTINUE)).toEqual([REQUEST, CONTINUE])
    expect(withLostRequests([REQUEST], REQUEST)).toEqual([REQUEST])
    expect(withLostRequests([REQUEST], ".")).toEqual([REQUEST])
  })
})
