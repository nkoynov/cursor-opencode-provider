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
import { decodeMessage, encodeMessage } from "../src/protocol/messages.js"
import { cacheHttp2SessionForTests, closeCachedHttp2SessionsForTests } from "../src/transport/connect.js"
import { setHostCacheDirOverride } from "../src/context/paths.js"
import { sessionManager } from "../src/session.js"
import { resetTurnStateForTests, restorePersistedHostNotes } from "../src/language-model.js"
import { encodePersistedHostNotes } from "../src/protocol/host-notes.js"
import { resetConversationBindingsForTests, sessionIdToUuid } from "../src/protocol/conversation-bind.js"
import { getCheckpoint, resetCheckpointsForTests } from "../src/protocol/checkpoint.js"
import { resetConversationPersistenceForTests } from "../src/protocol/conversation-persistence.js"
import { resetConversationBlobsForTests } from "../src/protocol/blob-store.js"
import { resetFrozenRequestContextsForTests } from "../src/context/frozen.js"
import { resetTurnProvenanceForTests } from "../src/protocol/turn-provenance.js"
import { notifyHostInterrupt } from "../src/host-interrupt.js"

type Prompt = LanguageModelV3CallOptions["prompt"]
type ClientMessage = Record<string, any>

const ORIGIN = "https://agentn.hostnotes-test.cursor.sh"
const PROXY_KEYS = ["HTTPS_PROXY", "https_proxy", "NO_PROXY", "no_proxy"] as const

/** One Run as the fake Cursor server sees it. */
type FakeRun = {
  received: ClientMessage[]
  send(message: Record<string, unknown>): void
  end(): void
}

let server: http2.Http2Server
let client: http2.ClientHttp2Session
let onRun: (run: FakeRun, message: ClientMessage) => void = () => {}
const runs: FakeRun[] = []
const savedProxy: Record<string, string | undefined> = {}

function frame(payload: Uint8Array): Buffer {
  const header = Buffer.alloc(5)
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
      end: () => stream.end(),
    }
    runs.push(run)
    let pending = Buffer.alloc(0)
    stream.on("data", (chunk: Buffer) => {
      pending = Buffer.concat([pending, chunk])
      while (pending.length >= 5) {
        const length = pending.readUInt32BE(1)
        if (pending.length < 5 + length) break
        const message = decodeMessage<ClientMessage>("AgentClientMessage", pending.subarray(5, 5 + length))
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

async function collect(model: ReturnType<ReturnType<typeof createCursor>["languageModel"]>, prompt: Prompt, sessionKey: string) {
  const { stream } = await model.doStream({
    prompt,
    tools: [{
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
