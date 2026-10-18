/**
 * Cursor refusing gzip Runs, through the real provider: doStream → startSession → bidiRunStream → pump,
 * against a local HTTP/2 server that plays Cursor's Run endpoint. No network access.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test"
import { randomBytes } from "node:crypto"
import fs from "node:fs"
import http2 from "node:http2"
import net from "node:net"
import os from "node:os"
import path from "node:path"
import type { LanguageModelV3CallOptions, LanguageModelV3StreamPart } from "@ai-sdk/provider"
import { createCursor } from "../src/index.js"
import { setHostCacheDirOverride } from "../src/context/paths.js"
import { resetTurnStateForTests, settleRunSavesForTests } from "../src/language-model.js"
import { resetCheckpointsForTests } from "../src/protocol/checkpoint.js"
import { resetConversationBindingsForTests } from "../src/protocol/conversation-bind.js"
import { resetConversationPersistenceForTests } from "../src/protocol/conversation-persistence.js"
import { decodeFramePayload, encodeFrame, FLAG_GZIP } from "../src/protocol/framing.js"
import { decodeMessage, encodeMessage } from "../src/protocol/messages.js"
import { sessionManager } from "../src/session.js"
import {
  closeCachedHttp2SessionsForTests,
  resetRunCompressionForTests,
  routeHttp2ConnectionsForTests,
} from "../src/transport/connect.js"

const ORIGIN = "https://agentn.gzip-refusal-test.cursor.sh"
const PROXY_KEYS = ["HTTPS_PROXY", "https_proxy", "NO_PROXY", "no_proxy"] as const
const UNSUPPORTED = JSON.stringify({ error: { code: "unimplemented", message: "unknown compression \"gzip\": supported encodings are identity" } })

type SeenRun = { encoding?: string; compressedFrames: number; runRequestText?: string }

let server: http2.Http2Server
const seen: SeenRun[] = []
const savedProxy: Record<string, string | undefined> = {}

const serverFrame = (message: Record<string, unknown>) => encodeFrame(0x00, encodeMessage("AgentServerMessage", message))

beforeAll(async () => {
  for (const key of PROXY_KEYS) {
    savedProxy[key] = process.env[key]
    delete process.env[key]
  }
  server = http2.createServer()
  server.on("stream", (stream, headers) => {
    const run: SeenRun = { compressedFrames: 0 }
    if (typeof headers["connect-content-encoding"] === "string") run.encoding = headers["connect-content-encoding"]
    seen.push(run)
    stream.on("error", () => {})
    stream.respond({ ":status": 200, "content-type": "application/connect+proto" })
    if (run.encoding && run.encoding !== "identity") {
      // As a Connect server without gzip: refused from the headers, before the body is read.
      stream.end(encodeFrame(0x02, new TextEncoder().encode(UNSUPPORTED)), () => {
        try { stream.close(http2.constants.NGHTTP2_NO_ERROR) } catch { /* already closed */ }
      })
      return
    }
    let pending = Buffer.alloc(0)
    let answered = false
    stream.on("data", (chunk: Buffer) => {
      pending = Buffer.concat([pending, chunk])
      while (pending.length >= 5) {
        const length = pending.readUInt32BE(1)
        if (pending.length < 5 + length) break
        const flags = pending[0]!
        if (flags & FLAG_GZIP) run.compressedFrames++
        const message = decodeMessage<Record<string, any>>(
          "AgentClientMessage",
          decodeFramePayload({ flags, payload: pending.subarray(5, 5 + length) }),
        )
        pending = pending.subarray(5 + length)
        if (message.run_request && !answered) {
          answered = true
          run.runRequestText = message.run_request.action?.user_message_action?.user_message?.text
          stream.write(serverFrame({ interaction_update: { text_delta: { text: "Done." } } }))
          stream.write(serverFrame({ conversation_checkpoint_update: Uint8Array.from([0x0a, 0x00]) }))
          stream.write(serverFrame({ interaction_update: { turn_ended: { input_tokens: 10, output_tokens: 2 } } }))
        }
      }
    })
  })
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject)
    server.listen(0, "127.0.0.1", resolve)
  })
  const port = (server.address() as net.AddressInfo).port
  routeHttp2ConnectionsForTests(() => net.connect(port, "127.0.0.1"))
})

afterAll(async () => {
  closeCachedHttp2SessionsForTests()
  routeHttp2ConnectionsForTests()
  resetRunCompressionForTests()
  await new Promise<void>((resolve) => server.close(() => resolve()))
  for (const key of PROXY_KEYS) {
    if (savedProxy[key] === undefined) delete process.env[key]
    else process.env[key] = savedProxy[key]
  }
})

const roots: string[] = []

afterEach(async () => {
  await settleRunSavesForTests()
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true })
  setHostCacheDirOverride(undefined)
  sessionManager.dispose()
  resetTurnStateForTests()
  resetConversationPersistenceForTests()
  resetConversationBindingsForTests()
  resetCheckpointsForTests()
  closeCachedHttp2SessionsForTests()
  resetRunCompressionForTests()
  seen.length = 0
})

async function turn(text: string, sessionKey: string): Promise<LanguageModelV3StreamPart[]> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cursor-gzip-refusal-"))
  roots.push(root)
  const model = createCursor({ name: "cursor", accessToken: "test-token", agentBaseURL: ORIGIN, cacheDir: root })
    .languageModel("composer-2.5")
  const { stream } = await model.doStream({
    prompt: [{ role: "user", content: [{ type: "text", text }] }],
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

describe("Cursor refusing a gzip Run", () => {
  it("sends the Run again uncompressed when the refusal arrives after the request went out", async () => {
    const parts = await turn("Say done.", "ses_gzip_refused_small")

    expect(textOf(parts)).toBe("Done.")
    expect(parts.some((part) => part.type === "error")).toBe(false)
    expect(seen.map((run) => run.encoding)).toEqual(["gzip", undefined])
    expect(seen[1]!.compressedFrames).toBe(0)
    expect(seen[1]!.runRequestText).toContain("Say done.")
  })

  it("sends the Run again uncompressed when the refusal arrives while a large request is still uploading", async () => {
    const large = `Summarize this: ${randomBytes(4_500_000).toString("base64")}`
    const parts = await turn(large, "ses_gzip_refused_large")

    expect(textOf(parts)).toBe("Done.")
    expect(parts.some((part) => part.type === "error")).toBe(false)
    expect(seen.map((run) => run.encoding)).toEqual(["gzip", undefined])
    expect(seen[1]!.compressedFrames).toBe(0)
    expect(seen[1]!.runRequestText).toContain(large)
  }, 30_000)

  it("keeps later turns uncompressed after a refusal", async () => {
    await turn("Say done.", "ses_gzip_refused_first")
    await turn("Say done again.", "ses_gzip_refused_second")

    expect(seen.map((run) => run.encoding)).toEqual(["gzip", undefined, undefined])
  })
})
