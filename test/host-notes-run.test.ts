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
import type { LanguageModelV3CallOptions, LanguageModelV3StreamPart } from "@ai-sdk/provider"
import { createCursor } from "../src/index.js"
import { decodeMessage, encodeMessage } from "../src/protocol/messages.js"
import { cacheHttp2SessionForTests, closeCachedHttp2SessionsForTests } from "../src/transport/connect.js"
import { setHostCacheDirOverride } from "../src/context/paths.js"
import { sessionManager } from "../src/session.js"
import { resetTurnStateForTests, restorePersistedHostNotes } from "../src/language-model.js"
import { encodePersistedHostNotes } from "../src/protocol/host-notes.js"
import { resetConversationBindingsForTests } from "../src/protocol/conversation-bind.js"
import { resetCheckpointsForTests } from "../src/protocol/checkpoint.js"
import { resetConversationPersistenceForTests } from "../src/protocol/conversation-persistence.js"

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

describe("host notes through a full provider Run", () => {
  it("lifts read instructions when their pending result arrives with a fresh user message", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "cursor-host-notes-fresh-"))
    cacheHttp2SessionForTests(ORIGIN, client)
    try {
      const file = path.join(root, "probe.txt")
      fs.writeFileSync(file, "alpha\n")
      const instruction = `Instructions from: ${path.join(root, "AGENTS.md")}\nUse bazel.`
      const sessionKey = "ses_fresh_read_note"
      const model = createCursor({ name: "cursor", accessToken: "test-token", agentBaseURL: ORIGIN, cacheDir: root }).languageModel("composer-2.5")
      onRun = (run, message) => {
        if (message.run_request && runs.indexOf(run) === 0) {
          run.send({ exec_server_message: { id: 1, read_args: { path: file } } })
        } else if (message.exec_client_message?.read_result) {
          endTurn(run, "Read complete.")
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
        .toEqual([instruction])
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
      expect(userText).toContain("<system_reminder>\nInstructions for the following MCP servers are available.\n</system_reminder>")
      expect(userText).not.toContain("builds with bazel")
      expect(runs[1]!.received.filter((message) => message.conversation_action?.inject_context_action)).toEqual([])
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  }, 30_000)
})
