/**
 * End-to-end host-note flow through the real provider: doStream → startSession
 * → bidiRunStream → pump, against a local HTTP/2 server that plays Cursor's
 * Run endpoint. No network access.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test"
import fs from "node:fs"
import http2 from "node:http2"
import net from "node:net"
import os from "node:os"
import path from "node:path"
import { APICallError, type LanguageModelV3CallOptions, type LanguageModelV3StreamPart } from "@ai-sdk/provider"
import { createCursor } from "../src/index.js"
import { CURSOR_COMPACTION_OPTION } from "../src/shared.js"
import { decodeFramePayload } from "../src/protocol/framing.js"
import { decodeMessage, encodeMessage } from "../src/protocol/messages.js"
import { encodeJsonAsValue, readAllFields } from "../src/protocol/struct.js"
import { cacheHttp2SessionForTests, closeCachedHttp2SessionsForTests } from "../src/transport/connect.js"
import { setHostCacheDirOverride } from "../src/context/paths.js"
import { sessionManager } from "../src/session.js"
import { notifyHostInterrupt } from "../src/host-interrupt.js"
import { resetTurnStateForTests, restorePersistedHostNotes } from "../src/language-model.js"
import { encodePersistedHostNotes } from "../src/protocol/host-notes.js"
import { peekConversationId, resetConversationBindingsForTests, sessionIdToUuid } from "../src/protocol/conversation-bind.js"
import { getCheckpoint, resetCheckpointsForTests } from "../src/protocol/checkpoint.js"
import { resetConversationPersistenceForTests } from "../src/protocol/conversation-persistence.js"
import { resetConversationBlobsForTests } from "../src/protocol/blob-store.js"
import { resetFrozenRequestContextsForTests } from "../src/context/frozen.js"
import { resetTurnProvenanceForTests } from "../src/protocol/turn-provenance.js"

type Prompt = LanguageModelV3CallOptions["prompt"]
type ClientMessage = Record<string, any>

const ORIGIN = "https://agentn.hostnotes-test.cursor.sh"
const PROXY_KEYS = ["HTTPS_PROXY", "https_proxy", "NO_PROXY", "no_proxy"] as const

/** One Run as the fake Cursor server sees it. */
type FakeRun = {
  received: ClientMessage[]
  send(message: Record<string, unknown>): void
  end(error?: string): void
}

let server: http2.Http2Server
let client: http2.ClientHttp2Session
let onRun: (run: FakeRun, message: ClientMessage) => void = () => {}
const runs: FakeRun[] = []
const savedProxy: Record<string, string | undefined> = {}

function frame(payload: Uint8Array, flags = 0): Buffer {
  const header = Buffer.alloc(5)
  header[0] = flags
  header.writeUInt32BE(payload.length, 1)
  return Buffer.concat([header, Buffer.from(payload)])
}

beforeAll(async () => {
  for (const key of PROXY_KEYS) {
    savedProxy[key] = process.env[key]
    delete process.env[key]
  }
  server = http2.createServer()
  server.on("stream", (stream) => {
    stream.respond({ ":status": 200, "content-type": "application/connect+proto" })
    stream.on("error", () => {})
    const run: FakeRun = {
      received: [],
      send: (message) => {
        if (!stream.destroyed && !stream.closed) stream.write(frame(encodeMessage("AgentServerMessage", message)))
      },
      end: (error) => {
        if (error) stream.write(frame(Buffer.from(JSON.stringify({ error: { code: error } })), 2))
        stream.end()
      },
    }
    runs.push(run)
    let pending = Buffer.alloc(0)
    stream.on("data", (chunk: Buffer) => {
      pending = Buffer.concat([pending, chunk])
      while (pending.length >= 5) {
        const length = pending.readUInt32BE(1)
        if (pending.length < 5 + length) break
        const message = decodeMessage<ClientMessage>(
          "AgentClientMessage",
          decodeFramePayload({ flags: pending[0]!, payload: pending.subarray(5, 5 + length) }),
        )
        pending = pending.subarray(5 + length)
        run.received.push(message)
        onRun(run, message)
      }
    })
  })
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject)
    server.listen(0, "127.0.0.1", resolve)
  })
  const address = server.address() as net.AddressInfo
  client = http2.connect(`http://127.0.0.1:${address.port}`)
  await new Promise<void>((resolve, reject) => {
    client.once("connect", () => resolve())
    client.once("error", reject)
  })
})

afterAll(async () => {
  closeCachedHttp2SessionsForTests()
  client?.destroy()
  await new Promise<void>((resolve) => server.close(() => resolve()))
  for (const key of PROXY_KEYS) {
    if (savedProxy[key] === undefined) delete process.env[key]
    else process.env[key] = savedProxy[key]
  }
})

afterEach(() => {
  // createCursor({ cacheDir }) sets the process-wide host cache root.
  setHostCacheDirOverride(undefined)
  sessionManager.dispose()
  resetTurnStateForTests()
  resetConversationPersistenceForTests()
  resetConversationBindingsForTests()
  resetCheckpointsForTests()
  runs.length = 0
  onRun = () => {}
})

function openStream(
  model: ReturnType<ReturnType<typeof createCursor>["languageModel"]>,
  prompt: Prompt,
  sessionKey: string,
  abortSignal?: AbortSignal,
  tools?: LanguageModelV3CallOptions["tools"],
) {
  return model.doStream({
    prompt,
    abortSignal,
    tools: tools ?? [{
      type: "function",
      name: "read",
      description: "Read a file from the local filesystem.",
      inputSchema: {
        type: "object",
        properties: { filePath: { type: "string" } },
        required: ["filePath"],
        additionalProperties: false,
      },
    }],
    headers: { "x-opencode-session-id": sessionKey },
  } as LanguageModelV3CallOptions)
}

async function collect(model: ReturnType<ReturnType<typeof createCursor>["languageModel"]>, prompt: Prompt, sessionKey: string,
  tools?: LanguageModelV3CallOptions["tools"]) {
  const { stream } = await openStream(model, prompt, sessionKey, undefined, tools)
  const parts: LanguageModelV3StreamPart[] = []
  const reader = stream.getReader()
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    parts.push(value)
  }
  return parts
}

const textOf = (parts: LanguageModelV3StreamPart[]) =>
  parts.filter((part) => part.type === "text-delta").map((part) => (part as { delta: string }).delta).join("")

function endTurn(run: FakeRun, text: string): void {
  run.send({ interaction_update: { text_delta: { text } } })
  run.send({ conversation_checkpoint_update: Uint8Array.from([0x0a, 0x00]) })
  run.send({ interaction_update: { turn_ended: { input_tokens: 10, output_tokens: 2 } } })
}

describe("seeded Runs through a full provider Run", () => {
  it("rebuilds a closed Run with the history in the user text and the system-instructions rule intact", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "cursor-seed-run-"))
    cacheHttp2SessionForTests(ORIGIN, client)
    try {
      const file = path.join(root, "probe.txt")
      fs.writeFileSync(file, "alpha\n")
      const sessionKey = "ses_seed_rebuild"
      const model = createCursor({ name: "cursor", accessToken: "test-token", agentBaseURL: ORIGIN, cacheDir: root }).languageModel("composer-2.5")
      onRun = (run, message) => {
        if (!message.run_request) return
        if (runs.indexOf(run) === 0) run.send({ exec_server_message: { id: 1, read_args: { path: file } } })
        else endTurn(run, "Done.")
      }
      const initial: Prompt = [
        { role: "system", content: "Host system prompt: build with bazel." },
        { role: "user", content: [{ type: "text", text: "Read probe.txt." }] },
      ]
      const first = await collect(model, initial, sessionKey)
      const call = first.find((part) => part.type === "tool-call") as { toolCallId: string; input: string }
      // The held Run is gone when the result arrives (hard cap, process restart).
      sessionManager.dispose()
      const second = await collect(model, [
        ...initial,
        { role: "assistant", content: [{ type: "tool-call", toolCallId: call.toolCallId, toolName: "read", input: JSON.parse(call.input) }] },
        { role: "tool", content: [{ type: "tool-result", toolCallId: call.toolCallId, toolName: "read", output: { type: "text", value: "alpha" } }] },
      ] as Prompt, sessionKey)
      expect(textOf(second)).toBe("Done.")
      expect(runs).toHaveLength(2)
      const request = runs[1]!.received.find((message) => message.run_request)!.run_request
      const state = decodeMessage<Record<string, any>>("ConversationStateStructure", request.conversation_state)
      expect(state.root_prompt_messages_json ?? []).toEqual([])
      const text = request.action.user_message_action.user_message.text as string
      expect(text).toStartWith("<conversation_history>\n")
      expect(text).toContain("<user>\nRead probe.txt.\n</user>\n\n<assistant>\n[called read] ")
      expect(text).toContain("<user>\nOpenCode host observation ")
      expect(text).toContain("alpha\n</user>\n</conversation_history>\n\nContinue the interrupted turn")
      const rules = request.action.user_message_action.request_context.rules as Array<{ content: string }>
      expect(rules).toHaveLength(1)
      expect(rules[0]!.content).toStartWith("Host system prompt: build with bazel.")
    } finally { fs.rmSync(root, { recursive: true, force: true }) }
  }, 30_000)
})

describe("history images through a full provider Run", () => {
  const IMAGE_A = "AQID"
  const IMAGE_B = "BAUG"
  const checkpoint = (n: number) => Uint8Array.from([0x98, 0x06, n])
  const model = (root: string) => createCursor({ name: "cursor", accessToken: "test-token", agentBaseURL: ORIGIN, cacheDir: root })
    .languageModel("claude-sonnet-5-5")
  const user = (text: string, image?: string): Prompt[number] => ({
    role: "user",
    content: [{ type: "text", text }, ...(image ? [{ type: "file" as const, mediaType: "image/png", data: image }] : [])],
  })
  const assistant = (text: string): Prompt[number] => ({ role: "assistant", content: [{ type: "text", text }] })
  const request = (index: number) => runs[index]!.received.find((message) => message.run_request)!.run_request
  const sentImages = (index: number) =>
    ((request(index).action.user_message_action.user_message.selected_context?.selected_images ?? []) as Array<{ data: Uint8Array }>)
      .map((image) => Buffer.from(image.data).toString("base64"))
  const sentCheckpoint = (index: number) => {
    const state = request(index).conversation_state as Uint8Array | undefined
    return state?.length ? Uint8Array.from(state) : undefined
  }

  function endTurnOn(run: FakeRun, bytes: Uint8Array | undefined): void {
    run.send({ interaction_update: { text_delta: { text: "Done." } } })
    if (bytes) run.send({ conversation_checkpoint_update: bytes })
    run.send({ interaction_update: { turn_ended: { input_tokens: 10, output_tokens: 2 } } })
  }

  function restartProcess(): void {
    sessionManager.dispose()
    resetTurnStateForTests()
    resetTurnProvenanceForTests()
    resetConversationPersistenceForTests()
    resetConversationBindingsForTests()
    resetCheckpointsForTests()
    resetConversationBlobsForTests()
    resetFrozenRequestContextsForTests()
  }

  // Each registration adds listeners to the shared client.
  beforeAll(() => cacheHttp2SessionForTests(ORIGIN, client))

  async function withRoot(run: (root: string) => Promise<void>): Promise<void> {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "cursor-history-images-"))
    try { await run(root) } finally { fs.rmSync(root, { recursive: true, force: true }) }
  }

  it("attaches an explicit image once, and not again after a restart", () => withRoot(async (root) => {
    const sessionKey = "ses_images_restart"
    onRun = (run, message) => { if (message.run_request) endTurnOn(run, checkpoint(runs.indexOf(run) + 1)) }
    const turn1: Prompt = [user("Here is the screenshot.", IMAGE_A)]
    await collect(model(root), turn1, sessionKey)
    const turn2: Prompt = [...turn1, assistant("Done."), user("Second question.")]
    await collect(model(root), turn2, sessionKey)
    restartProcess()
    await collect(model(root), [...turn2, assistant("Done."), user("Third question.")], sessionKey)

    expect(sentImages(0)).toEqual([IMAGE_A])
    expect(sentImages(1)).toEqual([])
    expect(sentCheckpoint(2)).toEqual(checkpoint(2))
    expect(sentImages(2)).toEqual([])
  }), 30_000)

  it("sends again an image whose turn ended without a checkpoint of its own, after a restart too", () => withRoot(async (root) => {
    const sessionKey = "ses_images_no_checkpoint"
    onRun = (run, message) => {
      if (message.run_request) endTurnOn(run, runs.indexOf(run) === 1 ? undefined : checkpoint(runs.indexOf(run) + 1))
    }
    const turn1: Prompt = [user("First screenshot.", IMAGE_A)]
    await collect(model(root), turn1, sessionKey)
    const turn2: Prompt = [...turn1, assistant("Done."), user("Second screenshot.", IMAGE_B)]
    await collect(model(root), turn2, sessionKey)
    restartProcess()
    await collect(model(root), [...turn2, assistant("Done."), user("Which one is newer?")], sessionKey)

    expect(sentImages(1)).toEqual([IMAGE_B])
    expect(sentCheckpoint(2)).toEqual(checkpoint(1))
    expect(sentImages(2)).toEqual([IMAGE_B])
  }), 30_000)

  it("sends again the image of a turn the user stopped, even when Cursor ends it on a checkpoint", () => withRoot(async (root) => {
    const sessionKey = "ses_images_stopped"
    onRun = (run, message) => {
      const index = runs.indexOf(run)
      if (message.run_request && index === 1) {
        run.send({ interaction_update: { text_delta: { text: "Looking" } } })
        run.send({ conversation_checkpoint_update: checkpoint(20) })
      } else if (message.conversation_action?.cancel_action) {
        endTurnOn(run, checkpoint(21))
      } else if (message.run_request) {
        endTurnOn(run, checkpoint(index + 1))
      }
    }
    const turn1: Prompt = [user("First screenshot.", IMAGE_A)]
    await collect(model(root), turn1, sessionKey)
    const turn2: Prompt = [...turn1, assistant("Done."), user("Second screenshot.", IMAGE_B)]
    const stopped = collect(model(root), turn2, sessionKey).then(() => undefined, (error: unknown) => error)
    const conversationId = sessionIdToUuid(sessionKey)
    for (let i = 0; i < 200 && getCheckpoint(conversationId)?.[2] !== 20; i++) await Bun.sleep(10)
    notifyHostInterrupt(sessionKey, "user", Date.now())
    await stopped
    for (let i = 0; i < 200 && getCheckpoint(conversationId)?.[2] !== 21; i++) await Bun.sleep(10)
    await collect(model(root), [...turn2, assistant("Looking"), user("Try again.")], sessionKey)

    expect(sentImages(1)).toEqual([IMAGE_B])
    expect(sentCheckpoint(2)).toEqual(checkpoint(21))
    expect(sentImages(2)).toEqual([IMAGE_B])
  }), 30_000)

  it("sends again the image of a stopped turn whose cancellation Cursor confirmed on a checkpoint", () => withRoot(async (root) => {
    const sessionKey = "ses_images_stopped_confirmed"
    const file = path.join(root, "probe.txt")
    fs.writeFileSync(file, "alpha\n")
    onRun = (run, message) => {
      const index = runs.indexOf(run)
      if (message.run_request && index === 1) {
        run.send({ conversation_checkpoint_update: checkpoint(20) })
        run.send({ exec_server_message: { id: 1, read_args: { path: file } } })
      } else if (message.exec_client_message?.read_result) {
        run.send({ interaction_update: { text_delta: { text: "Unseen follow-up." } } })
      } else if (message.conversation_action?.cancel_action) {
        run.send({ conversation_checkpoint_update: checkpoint(21) })
        run.end("canceled")
      } else if (message.run_request) {
        endTurnOn(run, checkpoint(index + 1))
      }
    }
    const turn1: Prompt = [user("First screenshot.", IMAGE_A)]
    await collect(model(root), turn1, sessionKey)
    const turn2: Prompt = [...turn1, assistant("Done."), user("Second screenshot.", IMAGE_B)]
    const call = (await collect(model(root), turn2, sessionKey)).find((part) => part.type === "tool-call")
    if (call?.type !== "tool-call") throw new Error("Expected read")
    await collect(model(root), [
      ...turn2,
      { role: "assistant", content: [{ type: "tool-call", toolCallId: call.toolCallId, toolName: "read", input: JSON.parse(call.input) }] },
      { role: "tool", content: [{ type: "tool-result", toolCallId: call.toolCallId, toolName: "read",
        output: { type: "error-text", value: "Tool execution aborted" } }] },
      user("Try again."),
    ] as Prompt, sessionKey)

    expect(runs[1]!.received.filter((message) => message.conversation_action?.cancel_action)).toHaveLength(1)
    expect(sentImages(1)).toEqual([IMAGE_B])
    expect(sentCheckpoint(2)).toEqual(checkpoint(21))
    expect(sentImages(2)).toEqual([IMAGE_B])
  }), 30_000)

  // A cancelled turn's last checkpoint may not hold the request it cancelled, so even a turn_ended
  // after the cancel leaves the turn's images to be sent again.
  it.each([
    ["an OpenCode 2 Stop, when Cursor does not answer the cancel", 2, undefined, checkpoint(20)],
    ["an OpenCode 2 Stop, when Cursor confirms the cancel on a checkpoint", 2, "canceled", checkpoint(21)],
    ["an OpenCode 2 Stop, when Cursor ends the turn on a checkpoint", 2, "turn_ended", checkpoint(22)],
    ["an OpenCode 1.x Stop", 1, undefined, checkpoint(20)],
    ["an OpenCode 1.x Stop, when Cursor ends the turn on a checkpoint", 1, "turn_ended", checkpoint(22)],
  ] as const)("after %s while text streams, resumes the latest checkpoint and resends the turn's image", (_, host, reply, resumed) => withRoot(async (root) => {
    const sessionKey = `ses_images_stopped_${host}_${reply ?? "none"}`
    onRun = (run, message) => {
      const index = runs.indexOf(run)
      if (message.run_request && index === 1) {
        run.send({ interaction_update: { text_delta: { text: "Looking" } } })
        run.send({ conversation_checkpoint_update: checkpoint(20) })
      } else if (message.conversation_action?.cancel_action && reply === "canceled") {
        run.send({ conversation_checkpoint_update: checkpoint(21) })
        run.end("canceled")
      } else if (message.conversation_action?.cancel_action && reply === "turn_ended") {
        endTurnOn(run, checkpoint(22))
      } else if (message.run_request) {
        endTurnOn(run, checkpoint(index + 1))
      }
    }
    const turn1: Prompt = [user("First screenshot.", IMAGE_A)]
    await collect(model(root), turn1, sessionKey)
    const turn2: Prompt = [...turn1, assistant("Done."), user("Second screenshot.", IMAGE_B)]
    const stop = new AbortController()
    const { stream } = await openStream(model(root), turn2, sessionKey, stop.signal)
    const reader = stream.getReader()
    const drained = (async () => { try { while (!(await reader.read()).done); } catch { /* cancelled */ } })()
    const conversationId = sessionIdToUuid(sessionKey)
    for (let i = 0; i < 200 && getCheckpoint(conversationId)?.[2] !== 20; i++) await Bun.sleep(10)
    if (host === 1) {
      // What the AI SDK does when OpenCode 1.x stops a turn.
      stop.abort()
      await reader.cancel()
    } else {
      await reader.cancel()
      await notifyHostInterrupt(sessionKey, "user", Date.now())
    }
    await drained
    for (let i = 0; i < 500 && sessionManager.findOpenByOpenCodeSessionId(sessionKey); i++) await Bun.sleep(10)
    await collect(model(root), [...turn2, assistant("Looking"), user("Try again.")], sessionKey)

    expect(runs[1]!.received.filter((message) => message.conversation_action?.cancel_action)).toHaveLength(1)
    expect(sentImages(1)).toEqual([IMAGE_B])
    expect(sentCheckpoint(2)).toEqual(resumed)
    expect(sentImages(2)).toEqual([IMAGE_B])
  }), 30_000)

  it.each([
    ["sends it again when the turn's last checkpoint arrived before it, queued while the tool ran", 100, undefined, checkpoint(40), [IMAGE_B]],
    ["sends it again when the turn's last checkpoint arrived before it, unread when the result was written", 0, undefined, checkpoint(40), [IMAGE_B]],
    ["counts it as held when the turn ends on a checkpoint sent after it", 100, checkpoint(41), checkpoint(41), []],
  ] as const)("after a restart, a tool-result image: %s", (_, toolMs, afterResult, resumed, resent) => withRoot(async (root) => {
    const sessionKey = `ses_images_tool_result_${toolMs}_${afterResult?.[2] ?? "none"}`
    const file = path.join(root, "shot.png")
    fs.writeFileSync(file, Buffer.from(IMAGE_B, "base64"))
    onRun = (run, message) => {
      const index = runs.indexOf(run)
      if (message.run_request && index === 1) {
        run.send({ exec_server_message: { id: 1, read_args: { path: file } } })
        run.send({ conversation_checkpoint_update: checkpoint(40) })
      } else if (message.exec_client_message?.read_result) {
        endTurnOn(run, afterResult)
      } else if (message.run_request) {
        endTurnOn(run, checkpoint(index + 1))
      }
    }
    const turn1: Prompt = [user("First screenshot.", IMAGE_A)]
    await collect(model(root), turn1, sessionKey)
    const turn2: Prompt = [...turn1, assistant("Done."), user("Read shot.png.")]
    const call = (await collect(model(root), turn2, sessionKey)).find((part) => part.type === "tool-call")
    if (call?.type !== "tool-call") throw new Error("Expected read")
    await Bun.sleep(toolMs)
    const turn3: Prompt = [
      ...turn2,
      { role: "assistant", content: [{ type: "tool-call", toolCallId: call.toolCallId, toolName: "read", input: JSON.parse(call.input) }] },
      { role: "tool", content: [{ type: "tool-result", toolCallId: call.toolCallId, toolName: "read",
        output: { type: "content", value: [{ type: "text", text: "Image read successfully" },
          { type: "image-data", mediaType: "image/png", data: IMAGE_B }] } }] },
    ] as Prompt
    await collect(model(root), turn3, sessionKey)
    restartProcess()
    await collect(model(root), [...turn3, assistant("Done."), user("What was in it?")], sessionKey)

    const result = runs[1]!.received.find((message) => message.exec_client_message?.read_result)!
    expect(Buffer.from(result.exec_client_message.read_result.success.data).toString("base64")).toBe(IMAGE_B)
    expect(sentCheckpoint(2)).toEqual(resumed)
    expect(sentImages(2)).toEqual([...resent])
  }), 30_000)

  it("sends again the image of a turn whose Run failed after a checkpoint", () => withRoot(async (root) => {
    const sessionKey = "ses_images_failed"
    onRun = (run, message) => {
      const index = runs.indexOf(run)
      if (message.run_request && index === 1) {
        run.send({ conversation_checkpoint_update: checkpoint(30) })
        run.end()
      } else if (message.run_request) {
        endTurnOn(run, checkpoint(index + 1))
      }
    }
    const turn1: Prompt = [user("First screenshot.", IMAGE_A)]
    await collect(model(root), turn1, sessionKey)
    const turn2: Prompt = [...turn1, assistant("Done."), user("Second screenshot.", IMAGE_B)]
    await collect(model(root), turn2, sessionKey)
    await collect(model(root), [...turn2, assistant("Done."), user("Which one is newer?")], sessionKey)

    expect(sentImages(1)).toEqual([IMAGE_B])
    // Run recovery resumes the turn on the checkpoint the failed Run received.
    expect(sentCheckpoint(2)).toEqual(checkpoint(30))
    expect(sentCheckpoint(3)).toEqual(checkpoint(3))
    expect(sentImages(3)).toEqual([IMAGE_B])
  }), 30_000)

  it("sends every image again after a compaction", () => withRoot(async (root) => {
    const sessionKey = "ses_images_compaction"
    onRun = (run, message) => { if (message.run_request) endTurnOn(run, checkpoint(runs.indexOf(run) + 1)) }
    const turn1: Prompt = [user("Here is the screenshot.", IMAGE_A)]
    await collect(model(root), turn1, sessionKey)
    const { stream } = await model(root).doStream({
      prompt: [...turn1, assistant("Done."), user("Summarize the conversation.")],
      tools: [],
      providerOptions: { cursor: { [CURSOR_COMPACTION_OPTION]: true } },
      headers: { "x-opencode-session-id": sessionKey },
    } as LanguageModelV3CallOptions)
    for (const reader = stream.getReader(); !(await reader.read()).done;);
    await collect(model(root), [...turn1, assistant("Done."), user("Summary: a screenshot."), user("Next question.")], sessionKey)

    expect(sentCheckpoint(1)).toBeUndefined()
    expect(sentImages(1)).toEqual([IMAGE_A])
    expect(sentCheckpoint(2)).toBeUndefined()
    expect(sentImages(2)).toEqual([IMAGE_A])
  }), 30_000)
})

describe("compaction Runs through a full provider Run", () => {
  const SUMMARY_PROMPT = "Summarize only what the user and the assistant said. Use the template headings."
  const NUDGE = "The previous response did not fill in the required summary template."

  async function compact(model: ReturnType<ReturnType<typeof createCursor>["languageModel"]>, prompt: Prompt, sessionKey: string) {
    const { stream } = await model.doStream({
      prompt,
      tools: [],
      providerOptions: { cursor: { [CURSOR_COMPACTION_OPTION]: true } },
      headers: { "x-opencode-session-id": sessionKey },
    } as LanguageModelV3CallOptions)
    const parts: LanguageModelV3StreamPart[] = []
    const reader = stream.getReader()
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      parts.push(value)
    }
    return parts
  }

  const history = (output: string): Prompt => [
    { role: "system", content: "Host system prompt." },
    { role: "user", content: [{ type: "text", text: "Read probe.txt." }] },
    { role: "assistant", content: [{ type: "tool-call", toolCallId: "call_read", toolName: "read", input: { filePath: "probe.txt" } }] },
    { role: "tool", content: [{ type: "tool-result", toolCallId: "call_read", toolName: "read", output: { type: "text", value: output } }] },
    { role: "assistant", content: [{ type: "text", text: "Read it." }] },
  ] as Prompt

  it("rejects a compaction request over the window as too large before opening a Run, the nudge included", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "cursor-compaction-size-"))
    cacheHttp2SessionForTests(ORIGIN, client)
    try {
      const model = createCursor({ name: "cursor", accessToken: "test-token", agentBaseURL: ORIGIN, cacheDir: root }).languageModel("composer-2.5")
      onRun = (run, message) => {
        if (message.run_request) endTurn(run, "Done.")
      }
      const prompted: Prompt = [...history("x".repeat(400_000)), { role: "user", content: [{ type: "text", text: SUMMARY_PROMPT }] }]
      for (const prompt of [prompted, [...prompted, { role: "user", content: [{ type: "text", text: NUDGE }] }] as Prompt]) {
        const error = await compact(model, prompt, "ses_compaction_too_large").then(() => undefined, (thrown: unknown) => thrown)
        expect(APICallError.isInstance(error)).toBe(true)
        expect((error as APICallError).statusCode).toBe(413)
        expect((error as APICallError).message).toStartWith("request too large: this compaction request needs ~")
        expect((error as APICallError).message).not.toMatch(/prompt is too long/i)
      }
      expect(runs).toHaveLength(0)
    } finally { fs.rmSync(root, { recursive: true, force: true }) }
  }, 30_000)

  it("sends a compaction request that fits, with the history and the summary prompt last", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "cursor-compaction-fits-"))
    cacheHttp2SessionForTests(ORIGIN, client)
    try {
      const model = createCursor({ name: "cursor", accessToken: "test-token", agentBaseURL: ORIGIN, cacheDir: root }).languageModel("composer-2.5")
      onRun = (run, message) => {
        if (message.run_request) endTurn(run, "## Objective\nRead probe.txt.")
      }
      const transcript = `[user] Read probe.txt.\n[assistant] read probe.txt\n[tool] ${"x".repeat(1_250)}`
      const parts = await compact(model, [
        { role: "system", content: "Host system prompt." },
        { role: "user", content: [{ type: "text", text: transcript }] },
        { role: "user", content: [{ type: "text", text: SUMMARY_PROMPT }] },
      ], "ses_compaction_fits")
      expect(textOf(parts)).toBe("## Objective\nRead probe.txt.")
      expect(runs).toHaveLength(1)
      const text = runs[0]!.received.find((message) => message.run_request)!.run_request
        .action.user_message_action.user_message.text as string
      expect(text).toContain(transcript)
      expect(text).toEndWith(SUMMARY_PROMPT)
    } finally { fs.rmSync(root, { recursive: true, force: true }) }
  }, 30_000)
})

describe("host notes through a full provider Run", () => {
  const refusedRead = (toolCallId: string) => ({ type: "tool-result", toolCallId, toolName: "read",
    output: { type: "text", value: "The user declined this tool call" },
    providerOptions: { cursor: { opencodeToolResult: { callID: toolCallId, status: "error",
      failure: { type: "permission.rejected", text: "The user declined this tool call", refusal: "rejected" },
    } } },
  })
  // Hosts that do not identify a refusal: an OpenCode 1.x rejection or
  // interruption, and an OpenCode 2 decline after a host restart.
  const unattributedResults: Record<string, (toolCallId: string) => Record<string, unknown>> = {
    "classic error": (toolCallId) => ({ type: "tool-result", toolCallId, toolName: "read",
      output: { type: "error-text", value: "The user rejected permission to use this specific tool call." } }),
    "native abort": (toolCallId) => ({ type: "tool-result", toolCallId, toolName: "read",
      output: { type: "text", value: "The user declined this tool call" },
      providerOptions: { cursor: { opencodeToolResult: { callID: toolCallId, status: "error",
        failure: { type: "aborted", text: "The user declined this tool call" } } } } }),
  }

  async function abandonReadThenAsk(sessionKey: string, acknowledgement: string,
    toolResult: ((toolCallId: string) => Record<string, unknown>) | undefined) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "cursor-abandoned-read-"))
    cacheHttp2SessionForTests(ORIGIN, client)
    try {
      const file = path.join(root, "probe.txt")
      fs.writeFileSync(file, "protected\n")
      const checkpoint = Uint8Array.from([0x0a, 0x00])
      const model = createCursor({ name: "cursor", accessToken: "test-token", agentBaseURL: ORIGIN, cacheDir: root }).languageModel("composer-2.5")
      onRun = (run, message) => {
        if (message.run_request && runs.indexOf(run) === 0) {
          run.send({ conversation_checkpoint_update: checkpoint })
          run.send({ exec_server_message: { id: 1, read_args: { path: file } } })
        } else if (message.exec_client_message?.read_result) {
          run.send({ interaction_update: { text_delta: { text: "Unseen follow-up." } } })
        } else if (message.conversation_action?.cancel_action) {
          if (acknowledgement !== "no-checkpoint") run.send({ conversation_checkpoint_update: checkpoint })
          run.end(acknowledgement === "unexpected-error" ? "internal" : "canceled")
        } else if (message.run_request) endTurn(run, "New user message received.")
      }
      const initial: Prompt = [{ role: "user", content: [{ type: "text", text: "Read probe.txt." }] }]
      const first = await collect(model, initial, sessionKey)
      const call = first.find((part) => part.type === "tool-call")!
      if (call.type !== "tool-call") throw new Error("Expected read")
      const second = await collect(model, [
        ...initial,
        ...(toolResult ? [
          { role: "assistant", content: [{ type: "tool-call", toolCallId: call.toolCallId, toolName: "read", input: JSON.parse(call.input) }] },
          { role: "tool", content: [toolResult(call.toolCallId)] },
        ] : []),
        { role: "user", content: [{ type: "text", text: "Answer this new message without reading again." }] },
      ] as Prompt, sessionKey)
      expect(textOf(second)).toBe("New user message received.")
      expect(runs).toHaveLength(2)
      const before = runs[0]!.received[0]!.run_request
      const after = runs[1]!.received[0]!.run_request
      expect(runs[0]!.received.filter((message) => message.exec_client_message?.read_result)).toHaveLength(1)
      const cancels = runs[0]!.received.filter((message) => message.conversation_action?.cancel_action)
      expect(cancels).toHaveLength(1)
      expect(cancels[0]!.conversation_action.cancel_action.reason).toBe("host_new_user_turn")
      if (acknowledgement === "checkpoint") {
        expect(after.conversation_id).toBe(before.conversation_id)
        expect(after.conversation_state).toEqual(checkpoint)
        expect(after.action.user_message_action.user_message.text).not.toContain("<conversation_history>")
      } else expect(after.conversation_id).not.toBe(before.conversation_id)
      expect(after.action.user_message_action.user_message.text).toContain("Answer this new message without reading again.")
    } finally { fs.rmSync(root, { recursive: true, force: true }) }
  }

  // The fork delivers a result that is not an interruption on the held Run and injects the next message as a steer.
  async function answerReadThenSteer(sessionKey: string, toolResult: (toolCallId: string) => Record<string, unknown>) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "cursor-steered-read-"))
    cacheHttp2SessionForTests(ORIGIN, client)
    try {
      const file = path.join(root, "probe.txt")
      fs.writeFileSync(file, "protected\n")
      const model = createCursor({ name: "cursor", accessToken: "test-token", agentBaseURL: ORIGIN, cacheDir: root }).languageModel("composer-2.5")
      const message = "Answer this new message without reading again."
      onRun = (run, received) => {
        const injection = received.conversation_action?.inject_context_action
        if (received.run_request && runs.indexOf(run) === 0) {
          run.send({ conversation_checkpoint_update: Uint8Array.from([0x0a, 0x00]) })
          run.send({ exec_server_message: { id: 1, read_args: { path: file } } })
        } else if (injection) {
          run.send({ interaction_update: { context_injection_state: { injection_id: injection.injection_id, state: { delivered: {} } } } })
          endTurn(run, "New user message received.")
        } else if (received.run_request) endTurn(run, "Unexpected new Run.")
      }
      const initial: Prompt = [{ role: "user", content: [{ type: "text", text: "Read probe.txt." }] }]
      const first = await collect(model, initial, sessionKey)
      const call = first.find((part) => part.type === "tool-call")!
      if (call.type !== "tool-call") throw new Error("Expected read")
      const second = await collect(model, [
        ...initial,
        { role: "assistant", content: [{ type: "tool-call", toolCallId: call.toolCallId, toolName: "read", input: JSON.parse(call.input) }] },
        { role: "tool", content: [toolResult(call.toolCallId)] },
        { role: "user", content: [{ type: "text", text: message }] },
      ] as Prompt, sessionKey)
      expect(textOf(second)).toContain("New user message received.")
      expect(runs).toHaveLength(1)
      const results = runs[0]!.received.filter((received) => received.exec_client_message?.read_result)
      expect(results).toHaveLength(1)
      expect(runs[0]!.received.filter((received) => received.conversation_action?.cancel_action)).toHaveLength(0)
      const injections = runs[0]!.received.filter((received) => received.conversation_action?.inject_context_action)
      expect(injections.map((received) => received.conversation_action.inject_context_action.user_context.user_message.text))
        .toEqual([message])
    } finally { fs.rmSync(root, { recursive: true, force: true }) }
  }

  it("keeps the checkpoint after a native abort result is followed by a new user turn", async () => {
    await abandonReadThenAsk("ses_unattributed_native_abort", "checkpoint", unattributedResults["native abort"])
  }, 30_000)

  it("steers the held Run after a classic error result is followed by a new message", async () => {
    await answerReadThenSteer("ses_unattributed_classic_error", unattributedResults["classic error"]!)
  }, 30_000)

  it("keeps the checkpoint after a call the host never answered is followed by a new user turn", async () => {
    await abandonReadThenAsk("ses_abandoned_read", "checkpoint", undefined)
  }, 30_000)

  it("delivers a rejected read and steers the held Run with the next message", async () => {
    await answerReadThenSteer("ses_rejected_read", refusedRead)
  }, 30_000)

  for (const acknowledgement of ["checkpoint", "no-checkpoint", "unexpected-error"]) {
    it(`settles an interrupted read before the next user turn (${acknowledgement})`, async () => {
      await abandonReadThenAsk("ses_interrupted_read", acknowledgement, unattributedResults["native abort"])
    }, 30_000)
  }

  it("continues four pending background launches with completion notices without launching them again", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "cursor-background-notes-"))
    cacheHttp2SessionForTests(ORIGIN, client)
    try {
      const sessionKey = "ses_background_notifications"
      const model = createCursor({ name: "cursor", accessToken: "test-token", agentBaseURL: ORIGIN, cacheDir: root }).languageModel("composer-2.5")
      const tools: LanguageModelV3CallOptions["tools"] = [{
        type: "function", name: "shell", description: "Run a native shell command",
        inputSchema: { type: "object", properties: {
          command: { type: "string" }, background: { type: "boolean" },
        }, required: ["command"] },
      }]
      let results = 0
      onRun = (run, message) => {
        if (message.run_request) {
          // Reopening the pre-result Run re-requests all four side effects.
          run.send({ interaction_update: { tool_requests_listed: { call_count: 4 } } })
          for (let id = 1; id <= 4; id++) {
            const struct = readAllFields(encodeJsonAsValue({ command: `echo MARKER-P${id}; exit ${id}`, background: true }))
              .find((field) => field.fn === 5)!.bytes!
            run.send({ exec_server_message: { id, mcp_args: {
              name: "opencode-shell", args: readAllFields(struct).map((field) => field.bytes!),
            } } })
          }
        } else if (message.exec_client_message?.mcp_result) {
          if (++results === 4) run.send({ interaction_update: { text_delta: { text: "All four jobs were launched once." } } })
        } else if (message.conversation_action?.inject_context_action) {
          const injection = message.conversation_action.inject_context_action
          run.send({ interaction_update: { context_injection_state: {
            injection_id: injection.injection_id, state: { delivered: { step: 1 } },
          } } })
          endTurn(run, "Completion notices received.")
        }
      }
      // Background shells change state, so the fork runs them one per step, in Cursor's order.
      let prompt: Prompt = [{ role: "user", content: [{ type: "text", text: "Launch four uniquely labelled background jobs once." }] }]
      let step = await collect(model, prompt, sessionKey, tools)
      for (let index = 1; index <= 4; index++) {
        const calls = step.filter((part) => part.type === "tool-call")
        expect(calls).toHaveLength(1)
        const call = calls[0]!
        if (call.type !== "tool-call") throw new Error("Expected a shell call")
        expect(JSON.parse(call.input).command).toBe(`echo MARKER-P${index}; exit ${index}`)
        prompt = [
          ...prompt,
          { role: "assistant", content: [{ type: "tool-call", toolCallId: call.toolCallId, toolName: "shell", input: JSON.parse(call.input) }] },
          { role: "tool", content: [{ type: "tool-result", toolCallId: call.toolCallId, toolName: "shell", output: { type: "text", value: `Command moved to the background (shell ID: sh_test_${index}).` } }] },
        ] as Prompt
        if (index < 4) step = await collect(model, prompt, sessionKey, tools)
      }
      const notices = [1, 2, 3].map((id) => `<shell id="sh_test_${id}" state="completed" command="echo MARKER-P${id}; exit ${id}">\nMARKER-P${id}\n\nExited with code ${id}\n</shell>`)
      const second = await collect(model, [
        ...prompt,
        ...notices.map((text) => ({ role: "user", content: [{ type: "text", text }] })),
      ] as Prompt, sessionKey, tools)
      expect(second.filter((part) => part.type === "tool-call")).toHaveLength(0)
      expect(runs).toHaveLength(1)
      expect(results).toBe(4)
      expect(textOf(second)).toContain("All four jobs were launched once.")
      const injections = runs[0]!.received.filter((message) => message.conversation_action?.inject_context_action)
      expect(injections).toHaveLength(1)
      expect(injections[0]!.conversation_action.inject_context_action.user_context.user_message.text).toBe(notices.join("\n\n"))
    } finally { fs.rmSync(root, { recursive: true, force: true }) }
  }, 30_000)

  it("lifts read instructions when their pending result arrives with a mid-step user message", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "cursor-host-notes-fresh-"))
    cacheHttp2SessionForTests(ORIGIN, client)
    try {
      const file = path.join(root, "probe.txt")
      fs.writeFileSync(file, "alpha\n")
      const instruction = `Instructions from: ${path.join(root, "AGENTS.md")}\nUse bazel.`
      const sessionKey = "ses_fresh_read_note"
      const model = createCursor({ name: "cursor", accessToken: "test-token", agentBaseURL: ORIGIN, cacheDir: root }).languageModel("composer-2.5")
      // The fork injects a message sent during the step into the held Run, as a steer, after the read's note.
      onRun = (run, message) => {
        const injection = message.conversation_action?.inject_context_action
        if (message.run_request && runs.indexOf(run) === 0) {
          run.send({ exec_server_message: { id: 1, read_args: { path: file } } })
        } else if (injection) {
          run.send({ interaction_update: { context_injection_state: { injection_id: injection.injection_id, state: { delivered: {} } } } })
          if (injection.user_context.user_message.text === "Which build command should I use?") endTurn(run, "Use bazel.")
        } else if (message.run_request) {
          endTurn(run, "Use bazel.")
        }
      }
      const initial: Prompt = [
        { role: "system", content: "Host system prompt." },
        { role: "user", content: [{ type: "text", text: "Read probe.txt." }] },
      ]
      const first = await collect(model, initial, sessionKey)
      const call = first.find((part) => part.type === "tool-call") as { toolCallId: string; input: string }
      const second = await collect(model, [
        ...initial,
        { role: "assistant", content: [{ type: "tool-call", toolCallId: call.toolCallId, toolName: "read", input: JSON.parse(call.input) }] },
        { role: "tool", content: [{ type: "tool-result", toolCallId: call.toolCallId, toolName: "read", output: {
          type: "text", value: `<path>${file}</path>\n<type>file</type>\n<content>\n1: alpha\n</content>\n<system-reminder>\n${instruction}\n</system-reminder>`,
        } }] },
        { role: "user", content: [{ type: "text", text: "Which build command should I use?" }] },
      ] as Prompt, sessionKey)
      expect(textOf(second)).toBe("Use bazel.")
      const steers = runs[0]!.received.filter((message) => message.conversation_action?.inject_context_action)
      expect(steers.map((message) => message.conversation_action.inject_context_action.user_context.user_message.text))
        .toEqual([instruction, "Which build command should I use?"])
      expect(runs).toHaveLength(1)
    } finally { fs.rmSync(root, { recursive: true, force: true }) }
  }, 30_000)

  it("rebases a fresh turn when finishing the prior Run throws", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "cursor-prior-throw-"))
    cacheHttp2SessionForTests(ORIGIN, client)
    try {
      const file = path.join(root, "probe.txt")
      fs.writeFileSync(file, "already-read\n")
      const sessionKey = "ses_prior_throw"
      const model = createCursor({ name: "cursor", accessToken: "test-token", agentBaseURL: ORIGIN, cacheDir: root }).languageModel("composer-2.5")
      onRun = (run, message) => {
        if (message.run_request && runs.indexOf(run) === 0) {
          run.send({ exec_server_message: { id: 1, read_args: { path: file } } })
        } else if (runs.indexOf(run) === 0 && message.exec_client_message) {
          run.send({ exec_server_message: { id: 9, read_args: { path: file } } })
        } else if (message.run_request) endTurn(run, "Recovered after the prior drain failed.")
      }
      const initial: Prompt = [{ role: "user", content: [{ type: "text", text: "Read probe.txt once." }] }]
      const first = await collect(model, initial, sessionKey)
      const call = first.find((part) => part.type === "tool-call")!
      if (call.type !== "tool-call") throw new Error("Expected the initial read")
      const prior = sessionManager.findOpenByOpenCodeSessionId(sessionKey)
      if (!prior) throw new Error("Expected the held Run")
      const write = prior.stream.write.bind(prior.stream)
      prior.stream.write = (chunk: Uint8Array) => {
        if (Buffer.from(chunk).includes("host_new_user_turn")) throw new Error("cancel write failed")
        return write(chunk)
      }
      // A completed result would steer the held Run; an interrupted one starts a fresh turn.
      const second = await collect(model, [
        ...initial,
        { role: "assistant", content: [{ type: "tool-call", toolCallId: call.toolCallId, toolName: "read", input: JSON.parse(call.input) }] },
        { role: "tool", content: [unattributedResults["native abort"]!(call.toolCallId)] },
        { role: "user", content: [{ type: "text", text: "Continue from the completed read." }] },
      ] as Prompt, sessionKey)
      expect(textOf(second)).toBe("Recovered after the prior drain failed.")
      expect(runs.length).toBeGreaterThan(1)
    } finally { fs.rmSync(root, { recursive: true, force: true }) }
  }, 30_000)

  it("delivers a completed result and steers the held Run when the next message carries tools", async () => {
    await answerReadThenSteer("ses_completed_read_steer", (toolCallId) => ({
      type: "tool-result", toolCallId, toolName: "read", output: { type: "text", value: "already-read" },
    }))
  }, 30_000)

  // With tools the message steers the held Run (above); a tool-less one is a separate request.
  for (const toolsEnabled of [false]) it(`preserves completed results after an undrained prior Run (tools=${toolsEnabled})`, async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "cursor-undrained-turn-"))
    cacheHttp2SessionForTests(ORIGIN, client)
    try {
      const file = path.join(root, "probe.txt")
      fs.writeFileSync(file, "already-read\n")
      const sessionKey = "ses_undrained_user_turn"
      const model = createCursor({ name: "cursor", accessToken: "test-token", agentBaseURL: ORIGIN, cacheDir: root }).languageModel("composer-2.5")
      onRun = (run, message) => {
        if (message.run_request && runs.indexOf(run) === 0) {
          run.send({ conversation_checkpoint_update: Uint8Array.from([0x0a, 0x00]) })
          run.send({ exec_server_message: { id: 1, read_args: { path: file } } })
        } else if (message.exec_client_message?.read_result) {
          // The drain stops on resumed output before any post-result checkpoint.
          run.send({ interaction_update: { text_delta: { text: "Invisible prior answer." } } })
        } else if (message.conversation_action?.cancel_action) {
          run.end("canceled")
        } else if (message.run_request) endTurn(run, "Newest request received.")
      }
      const initial: Prompt = [{ role: "user", content: [{ type: "text", text: "Read probe.txt once." }] }]
      const first = await collect(model, initial, sessionKey)
      const call = first.find((part) => part.type === "tool-call")!
      if (call.type !== "tool-call") throw new Error("Expected the initial read")
      const second = await collect(model, [
        ...initial,
        { role: "assistant", content: [{ type: "tool-call", toolCallId: call.toolCallId, toolName: "read", input: JSON.parse(call.input) }] },
        { role: "tool", content: [{ type: "tool-result", toolCallId: call.toolCallId, toolName: "read", output: { type: "text", value: "already-read" } }] },
        { role: "user", content: [{ type: "text", text: "Summarize the completed read; do not read it again." }] },
      ] as Prompt, sessionKey, toolsEnabled ? undefined : [])
      expect(textOf(second)).toBe("Newest request received.")
      expect(runs).toHaveLength(2)
      expect(runs[0]!.received.filter((message) => message.conversation_action?.cancel_action)).toHaveLength(1)
      const previous = runs[0]!.received[0]!.run_request
      const request = runs[1]!.received[0]!.run_request
      expect(request.conversation_id).not.toBe(previous.conversation_id)
      const text = request.action.user_message_action.user_message.text as string
      expect(text).toContain("already-read")
      expect(text).toContain("OpenCode host observation")
      expect(text).toEndWith("Summarize the completed read; do not read it again.")
      // A tool-less lifecycle Run remains ephemeral and cannot rotate the
      // owning conversation's binding merely because preparation was busy.
      if (!toolsEnabled) expect(peekConversationId(sessionKey)).toBe(previous.conversation_id)
    } finally { fs.rmSync(root, { recursive: true, force: true }) }
  }, 30_000)

  it("preserves a deferred note missing from rewritten history across an early Run failure", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "cursor-host-notes-rebase-"))
    cacheHttp2SessionForTests(ORIGIN, client)
    try {
      const sessionKey = "ses_note_rebase"
      const note = "<system-update>Use bazel for builds.</system-update>"
      restorePersistedHostNotes(sessionKey, encodePersistedHostNotes([note]))
      const model = createCursor({
        name: "cursor", accessToken: "test-token", agentBaseURL: ORIGIN, cacheDir: root,
        retry: { maxAttempts: 2, baseDelayMs: 1, maxDelayMs: 1 },
      }).languageModel("composer-2.5")
      onRun = (run, message) => {
        if (!message.run_request) return
        if (runs.indexOf(run) === 0) run.end()
        else endTurn(run, "Use bazel.")
      }
      const parts = await collect(model, [
        { role: "system", content: "Host system prompt." },
        { role: "user", content: [{ type: "text", text: "Continue from the compacted summary." }] },
      ] as Prompt, sessionKey)
      expect(textOf(parts)).toBe("Use bazel.")
      expect(runs).toHaveLength(2)
      for (const run of runs) {
        const request = run.received.find((message) => message.run_request)!.run_request
        expect(request.action.user_message_action.user_message.text)
          .toContain("<system_reminder>\nUse bazel for builds.\n</system_reminder>")
      }
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  }, 30_000)

  it("does not repeat a deferred read instruction that the replayed history of a Run without a checkpoint holds", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "cursor-host-notes-replay-"))
    cacheHttp2SessionForTests(ORIGIN, client)
    try {
      const sessionKey = `ses_replay_note_${Date.now()}`
      const instruction = `Instructions from: ${path.join(root, "pkg", "AGENTS.md")}\nUse bazel.`
      restorePersistedHostNotes(sessionKey, encodePersistedHostNotes([instruction]))
      const model = createCursor({ name: "cursor", accessToken: "test-token", agentBaseURL: ORIGIN, cacheDir: root }).languageModel("composer-2.5")
      onRun = (run, message) => {
        if (message.run_request) endTurn(run, "Use bazel.")
      }
      const callId = "call_replayed_read"
      await collect(model, [
        { role: "system", content: "Host system prompt." },
        { role: "user", content: [{ type: "text", text: "Read pkg/probe.txt." }] },
        { role: "assistant", content: [{ type: "tool-call", toolCallId: callId, toolName: "read", input: { filePath: "pkg/probe.txt" } }] },
        { role: "tool", content: [{ type: "tool-result", toolCallId: callId, toolName: "read", output: {
          type: "text", value: `<path>pkg/probe.txt</path>\n<type>file</type>\n<content>\n1: alpha\n</content>\n<system-reminder>\n${instruction}\n</system-reminder>`,
        } }] },
        { role: "assistant", content: [{ type: "text", text: "It says alpha." }] },
        { role: "user", content: [{ type: "text", text: "Which build tool?" }] },
      ] as Prompt, sessionKey)
      const text = runs[0]!.received.find((message) => message.run_request)!.run_request.action.user_message_action.user_message.text as string
      expect(text).toStartWith("<conversation_history>\n")
      expect(text.split("Use bazel.")).toHaveLength(2)
      expect(text).not.toContain("<system_reminder>")
    } finally { fs.rmSync(root, { recursive: true, force: true }) }
  }, 30_000)

  it("still sends a deferred read instruction when the replay budget cuts the result that carried it", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "cursor-host-notes-replay-cut-"))
    cacheHttp2SessionForTests(ORIGIN, client)
    try {
      const sessionKey = `ses_replay_cut_${Date.now()}`
      const instruction = `Instructions from: ${path.join(root, "pkg", "AGENTS.md")}\nUse bazel.`
      restorePersistedHostNotes(sessionKey, encodePersistedHostNotes([instruction]))
      const model = createCursor({ name: "cursor", accessToken: "test-token", agentBaseURL: ORIGIN, cacheDir: root }).languageModel("composer-2.5")
      onRun = (run, message) => {
        if (message.run_request) endTurn(run, "Use bazel.")
      }
      const callId = "call_cut_read"
      await collect(model, [
        { role: "system", content: "Host system prompt." },
        { role: "user", content: [{ type: "text", text: "Read pkg/big.txt." }] },
        { role: "assistant", content: [{ type: "tool-call", toolCallId: callId, toolName: "read", input: { filePath: "pkg/big.txt" } }] },
        { role: "tool", content: [{ type: "tool-result", toolCallId: callId, toolName: "read", output: {
          type: "text", value: `<path>pkg/big.txt</path>\n<content>\n${"x".repeat(2_500_000)}\n</content>\n<system-reminder>\n${instruction}\n</system-reminder>`,
        } }] },
        { role: "assistant", content: [{ type: "text", text: "It is long." }] },
        { role: "user", content: [{ type: "text", text: "Which build tool?" }] },
      ] as Prompt, sessionKey)
      const text = runs[0]!.received.find((message) => message.run_request)!.run_request.action.user_message_action.user_message.text as string
      expect(text).toContain("more characters left out of this replay")
      expect(text.split("Use bazel.")).toHaveLength(2)
      expect(text).toContain("<system_reminder>")
    } finally { fs.rmSync(root, { recursive: true, force: true }) }
  }, 30_000)

  it("injects a mid-step OpenCode 2 instruction once and carries a between-turns update with the next message", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "cursor-host-notes-run-"))
    cacheHttp2SessionForTests(ORIGIN, client)
    try {
      const file = path.join(root, "probe.txt")
      fs.writeFileSync(file, "The build uses make.\n")
      const instructions = `Instructions from: ${path.join(root, "AGENTS.md")}\nThis project builds with bazel.`
      const mcpUpdate = "<system-update>\nInstructions for the following MCP servers are available.\n</system-update>"
      const sessionKey = `ses_run_${Date.now()}`
      const model = createCursor({ name: "cursor", accessToken: "test-token", agentBaseURL: ORIGIN, cacheDir: root }).languageModel("composer-2.5")

      onRun = (run, message) => {
        if (message.run_request && runs.indexOf(run) === 0) {
          run.send({ exec_server_message: { id: 0, exec_id: "exec-0", read_args: { path: file, tool_call_id: "tc-0" } } })
        } else if (message.conversation_action?.inject_context_action) {
          const injectionId = message.conversation_action.inject_context_action.injection_id
          run.send({ interaction_update: { context_injection_state: { injection_id: injectionId, state: { queued: {} } } } })
          run.send({ interaction_update: { context_injection_state: { injection_id: injectionId, state: { delivered: { step: 1 } } } } })
          endTurn(run, "Use bazel.")
        } else if (message.run_request) {
          endTurn(run, "bazel build //...")
        }
      }

      const system = { role: "system", content: "Host system prompt." } as Prompt[number]
      const ask = { role: "user", content: [{ type: "text", text: "Read probe.txt; how do I build?" }] } as Prompt[number]
      const first = await collect(model, [system, ask], sessionKey)
      const call = first.find((part) => part.type === "tool-call") as { toolCallId: string; toolName: string; input: string }
      expect(call.toolName).toBe("read")

      const step: Prompt = [
        system,
        ask,
        { role: "assistant", content: [{ type: "tool-call", toolCallId: call.toolCallId, toolName: "read", input: JSON.parse(call.input) }] },
        { role: "tool", content: [{ type: "tool-result", toolCallId: call.toolCallId, toolName: "read", output: { type: "text", value: `Read file ${file}, lines 1-1\n1: The build uses make.` } }] },
        { role: "user", content: [{ type: "text", text: instructions }] },
      ] as Prompt
      const second = await collect(model, step, sessionKey)
      expect(textOf(second)).toBe("Use bazel.")

      const turn1 = runs[0]!.received
      const readAt = turn1.findIndex((message) => message.exec_client_message?.read_result)
      const injectAt = turn1.findIndex((message) => message.conversation_action?.inject_context_action)
      expect(readAt).toBeGreaterThanOrEqual(0)
      expect(injectAt).toBeGreaterThan(readAt)
      expect(turn1[readAt]!.exec_client_message.read_result.success.content).toBe("The build uses make.\n")
      const injection = turn1[injectAt]!.conversation_action.inject_context_action
      expect(injection.user_context.user_message.text).toBe(instructions)
      expect(injection.expected_run_id).toBe(turn1[0]!.run_request.run_id)
      expect(turn1.filter((message) => message.conversation_action?.inject_context_action)).toHaveLength(1)

      const third = await collect(model, [
        ...step,
        { role: "assistant", content: [{ type: "text", text: "Use bazel." }] },
        { role: "user", content: [{ type: "text", text: mcpUpdate }] },
        { role: "user", content: [{ type: "text", text: "Which command should CI run?" }] },
      ] as Prompt, sessionKey)
      expect(textOf(third)).toBe("bazel build //...")

      expect(runs).toHaveLength(2)
      const run2 = runs[1]!.received[0]!.run_request
      expect(run2.conversation_state.length).toBeGreaterThan(0)
      const userText = run2.action.user_message_action.user_message.text as string
      expect(userText).toContain("Which command should CI run?")
      // `liveUserTurn` carries a note OpenCode put between turns in the turn's own text, once.
      expect(userText.split("Instructions for the following MCP servers are available.")).toHaveLength(2)
      expect(userText).toContain("<system-update>\nInstructions for the following MCP servers are available.\n</system-update>")
      expect(userText).not.toContain("builds with bazel")
      expect(runs[1]!.received.filter((message) => message.conversation_action?.inject_context_action)).toEqual([])
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  }, 30_000)
})
