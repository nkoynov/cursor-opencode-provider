import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import {
  defaultUnaryTimeoutMs,
  fetchAgentUrl,
  UNARY_ATTEMPTS,
  unaryAvailableModels,
  unaryWorstCaseMs,
} from "../src/transport/connect.js"
import { INSTALLER_WAIT_MS, resetClientVersionCache } from "../src/protocol/client-version.js"
import { CursorServerError, CursorTransportError } from "../src/errors.js"

const INSTALLER_FIXTURE = `var x="https://downloads.cursor.com/lab/2026.07.09-a3815c0/";`
const AGENT_CONFIG = { agentUrlConfig: { agentnUrl: "https://agentn.us.api5.cursor.sh" } }
const ENV_KEYS = ["CURSOR_CLIENT_VERSION", "CURSOR_PROVIDER_RPC_TIMEOUT_MS", "HOME", "XDG_CACHE_HOME"] as const

let tmp: string
let realFetch: typeof globalThis.fetch
let savedEnv: Map<string, string | undefined>

function pendingFetchUntilAbort(init?: RequestInit): Promise<Response> {
  return new Promise((_resolve, reject) => {
    const signal = init?.signal
    if (!signal) return reject(new Error("missing timeout signal"))
    if (signal.aborted) return reject(signal.reason)
    signal.addEventListener("abort", () => reject(signal.reason), { once: true })
  })
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "unary-cold-start-"))
  realFetch = globalThis.fetch
  savedEnv = new Map(ENV_KEYS.map((key) => [key, process.env[key]]))
  for (const key of ENV_KEYS) delete process.env[key]
  process.env.HOME = tmp
  process.env.CURSOR_CLIENT_VERSION = "cli-test-1"
  resetClientVersionCache()
})

afterEach(() => {
  globalThis.fetch = realFetch
  for (const [key, value] of savedEnv) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  resetClientVersionCache()
  fs.rmSync(tmp, { recursive: true, force: true })
})

describe("unary budget", () => {
  it("starts after the client version is known", async () => {
    delete process.env.CURSOR_CLIENT_VERSION
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      if (String(input).includes("cursor.com/install")) {
        await sleep(300)
        return new Response(INSTALLER_FIXTURE, { status: 200 })
      }
      return Response.json(AGENT_CONFIG)
    }) as unknown as typeof fetch

    expect(await fetchAgentUrl("token", { timeoutMs: 150 })).toBe("https://agentn.us.api5.cursor.sh")
    expect(await unaryAvailableModels("token", { timeoutMs: 150 })).toEqual(AGENT_CONFIG)
  })

  it("does not wait out a hanging installer before asking Cursor", async () => {
    delete process.env.CURSOR_CLIENT_VERSION
    const versions: string[] = []
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).includes("cursor.com/install")) return pendingFetchUntilAbort(init)
      versions.push(new Headers(init?.headers as HeadersInit).get("x-cursor-client-version") ?? "")
      return Response.json(AGENT_CONFIG)
    }) as unknown as typeof fetch

    const started = Date.now()
    expect(await fetchAgentUrl("token", { timeoutMs: 1_000 })).toBe("https://agentn.us.api5.cursor.sh")
    expect(Date.now() - started).toBeLessThan(INSTALLER_WAIT_MS + 1_000)
    expect(versions).toHaveLength(1)
    expect(versions[0]).toMatch(/^cli-/)
  })

  it("reads CURSOR_PROVIDER_RPC_TIMEOUT_MS and ignores a malformed value", async () => {
    expect(defaultUnaryTimeoutMs()).toBe(5_000)
    process.env.CURSOR_PROVIDER_RPC_TIMEOUT_MS = "12000"
    expect(defaultUnaryTimeoutMs()).toBe(12_000)
    expect(unaryWorstCaseMs()).toBeGreaterThan(UNARY_ATTEMPTS * 12_000)
    for (const bad of ["0", "-5", "1.5", "5s", "99999999999"]) {
      process.env.CURSOR_PROVIDER_RPC_TIMEOUT_MS = bad
      expect(defaultUnaryTimeoutMs()).toBe(5_000)
    }

    process.env.CURSOR_PROVIDER_RPC_TIMEOUT_MS = "40"
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) =>
      pendingFetchUntilAbort(init)) as unknown as typeof fetch
    const error = await fetchAgentUrl("token").then(() => undefined, (cause) => cause)
    expect(error).toBeInstanceOf(CursorTransportError)
    expect(error.message).toBe("GetServerConfig timed out after 40ms")
  })
})

describe("unary retry", () => {
  it("tries a timed-out request once more", async () => {
    let calls = 0
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      calls++
      if (calls === 1) return pendingFetchUntilAbort(init)
      return Response.json(AGENT_CONFIG)
    }) as unknown as typeof fetch

    expect(await unaryAvailableModels("token", { timeoutMs: 50 })).toEqual(AGENT_CONFIG)
    expect(calls).toBe(2)
  })

  it("tries a failed network request once more", async () => {
    let calls = 0
    globalThis.fetch = (async () => {
      calls++
      if (calls === 1) throw new TypeError("connection reset")
      return Response.json(AGENT_CONFIG)
    }) as unknown as typeof fetch

    expect(await fetchAgentUrl("token", { timeoutMs: 1_000 })).toBe("https://agentn.us.api5.cursor.sh")
    expect(calls).toBe(2)
  })

  it("gives up after the last attempt with the timeout error", async () => {
    let calls = 0
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      calls++
      return pendingFetchUntilAbort(init)
    }) as unknown as typeof fetch

    const error = await fetchAgentUrl("token", { timeoutMs: 30 }).then(() => undefined, (cause) => cause)
    expect(error).toMatchObject({ code: "CURSOR_AGENT_URL_TIMEOUT", transient: true, replaySafe: true })
    expect(calls).toBe(UNARY_ATTEMPTS)
  })

  it("does not repeat a request Cursor answered", async () => {
    let calls = 0
    globalThis.fetch = (async () => {
      calls++
      return new Response("busy", { status: 503 })
    }) as unknown as typeof fetch

    const error = await unaryAvailableModels("token", { timeoutMs: 1_000 }).then(() => undefined, (cause) => cause)
    expect(error).toBeInstanceOf(CursorServerError)
    expect(calls).toBe(1)
  })
})

describe("cold process", () => {
  it("lists models and resolves the agent URL with a fresh HOME while cursor.com hangs", async () => {
    const answered: string[] = []
    const server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      async fetch(request) {
        const url = new URL(request.url)
        answered.push(url.pathname)
        if (url.pathname.endsWith("/AvailableModels")) return Response.json({ models: [] })
        return Response.json(AGENT_CONFIG)
      },
    })
    const script = path.join(tmp, "cold.ts")
    const connect = path.resolve(import.meta.dir, "../src/transport/connect.ts")
    fs.writeFileSync(script, `
      const realFetch = globalThis.fetch
      globalThis.fetch = (input, init) => String(input).includes("cursor.com")
        ? new Promise((_resolve, reject) => init?.signal?.addEventListener("abort", () => reject(init.signal.reason)))
        : realFetch(input, init)
      const started = performance.now()
      const { unaryAvailableModels, fetchAgentUrl } = await import(${JSON.stringify(connect)})
      const apiBaseURL = process.env.TEST_API_BASE
      const [models, agentUrl] = await Promise.all([
        unaryAvailableModels("token", { apiBaseURL }),
        fetchAgentUrl("token", { apiBaseURL }),
      ])
      console.log(JSON.stringify({ models, agentUrl, ms: Math.round(performance.now() - started) }))
    `)
    try {
      const home = path.join(tmp, "home")
      fs.mkdirSync(home)
      const child = Bun.spawn([process.execPath, script], {
        env: { PATH: process.env.PATH ?? "", HOME: home, TEST_API_BASE: `http://127.0.0.1:${server.port}` },
        stdout: "pipe",
        stderr: "pipe",
      })
      const [stdout, stderr, code] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ])
      expect({ code, stderr: stderr.slice(-500) }).toEqual({ code: 0, stderr: "" })
      const result = JSON.parse(stdout.trim())
      expect(result.models).toEqual({ models: [] })
      expect(result.agentUrl).toBe("https://agentn.us.api5.cursor.sh")
      expect(result.ms).toBeLessThan(INSTALLER_WAIT_MS + 2_000)
      expect(answered.sort()).toEqual([
        "/aiserver.v1.AiService/AvailableModels",
        "/aiserver.v1.ServerConfigService/GetServerConfig",
      ])
    } finally {
      server.stop(true)
    }
  }, 20_000)
})
