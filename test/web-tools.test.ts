import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { processShared } from "../src/process-shared.js"
import {
  executeOpenCodeWebSearch,
  fetchOpenCodeWebSearchText,
  parseOpenCodeWebSearchResponse,
  parseExaWebSearchResults,
} from "../src/web-tools.js"

const originalExaApiKey = process.env.EXA_API_KEY
const keylessQuota = processShared("web-search.exa-keyless-quota.v1", () => ({ refusedUntil: 0 }))

beforeEach(() => {
  delete process.env.EXA_API_KEY
  keylessQuota.refusedUntil = 0
})

afterEach(() => {
  if (originalExaApiKey === undefined) delete process.env.EXA_API_KEY
  else process.env.EXA_API_KEY = originalExaApiKey
})

function apiKeyHeader(init: RequestInit | undefined): string | undefined {
  return new Headers(init?.headers).get("x-api-key") ?? undefined
}

function context(asks: unknown[]) {
  return {
    sessionID: "session",
    messageID: "message",
    agent: "build",
    directory: "/workspace",
    worktree: "/workspace",
    abort: new AbortController().signal,
    metadata() {},
    async ask(input: unknown) { asks.push(input) },
  } as any
}

describe("OpenCode-backed websearch tool", () => {
  it("parses JSON and SSE MCP responses", () => {
    const payload = { result: { content: [{ type: "text", text: "result" }] } }
    expect(parseOpenCodeWebSearchResponse(JSON.stringify(payload))).toBe("result")
    expect(parseOpenCodeWebSearchResponse(`event: message\ndata: ${JSON.stringify(payload)}\n`)).toBe("result")
  })

  it("uses OpenCode permission semantics and calls Exa's MCP tool", async () => {
    const asks: unknown[] = []
    let requestUrl = ""
    let requestInit: RequestInit | undefined
    process.env.EXA_API_KEY = "test-key"
    const result = await executeOpenCodeWebSearch(
      { query: "current release", numResults: 3, livecrawl: "preferred" },
      context(asks),
      (async (url: string | URL | Request, init?: RequestInit) => {
        requestUrl = String(url)
        requestInit = init
        return new Response(JSON.stringify({
          result: { content: [{ type: "text", text: "search output" }] },
        }))
      }) as unknown as typeof fetch,
    )

    expect(asks).toEqual([expect.objectContaining({
      permission: "websearch",
      patterns: ["current release"],
    })])
    expect(requestUrl).toBe("https://mcp.exa.ai/mcp")
    expect(apiKeyHeader(requestInit)).toBeUndefined()
    const body = JSON.parse(String(requestInit?.body))
    expect(body.params).toEqual({
      name: "web_search_exa",
      arguments: {
        query: "current release",
        type: "auto",
        numResults: 3,
        livecrawl: "preferred",
      },
    })
    expect(result).toEqual({
      title: "Exa Web Search: current release",
      output: "search output",
      metadata: { provider: "exa" },
    })
  })
})

describe("Exa rate limits", () => {
  const ok = () => new Response(JSON.stringify({ result: { content: [{ type: "text", text: "found" }] } }))
  const limited = (retryAfter: string | null = "1") =>
    new Response(JSON.stringify({ jsonrpc: "2.0", error: { code: -32000, message: "You've hit Exa's free MCP rate limit." } }), {
      status: 429,
      headers: retryAfter === null ? {} : { "retry-after": retryAfter },
    })
  function scripted(responses: Array<() => Response>) {
    let calls = 0
    const fetchImpl = (async () => responses[Math.min(calls++, responses.length - 1)]!()) as unknown as typeof fetch
    return { fetchImpl, calls: () => calls }
  }
  function clock() {
    let t = 1_000_000
    const waits: number[] = []
    return {
      waits,
      options: {
        now: () => t,
        random: () => 0.5,
        sleep: async (ms: number) => { waits.push(ms); t += ms },
      },
    }
  }

  it("waits out a 429 as Retry-After asks, with jitter, then returns the results", async () => {
    const { fetchImpl, calls } = scripted([() => limited("1"), () => limited("2"), ok])
    const c = clock()
    await expect(fetchOpenCodeWebSearchText({ query: "q" }, undefined, fetchImpl, c.options)).resolves.toBe("found")
    expect(calls()).toBe(3)
    expect(c.waits).toEqual([1_500, 2_500])
  })

  it("assumes one second when a 429 has no usable Retry-After and caps long ones", async () => {
    const { fetchImpl } = scripted([() => limited(null), () => limited("40"), ok])
    const c = clock()
    await fetchOpenCodeWebSearchText({ query: "q" }, undefined, fetchImpl, c.options)
    expect(c.waits).toEqual([1_500, 5_500])
  })

  it("fails at once when Exa asks for a wait longer than the whole search budget", async () => {
    delete process.env.EXA_API_KEY
    const { fetchImpl, calls } = scripted([() => limited("67785"), ok])
    const c = clock()
    await expect(fetchOpenCodeWebSearchText({ query: "q" }, undefined, fetchImpl, c.options))
      .rejects.toThrow("Web search failed (429): Exa refuses searches for another 18.8 h; set EXA_API_KEY to search sooner.")
    expect(calls()).toBe(1)
    expect(c.waits).toEqual([])
  })

  it("reports the 429 after six attempts", async () => {
    const { fetchImpl, calls } = scripted([() => limited("1")])
    const c = clock()
    await expect(fetchOpenCodeWebSearchText({ query: "q" }, undefined, fetchImpl, c.options))
      .rejects.toThrow("Web search failed (429)")
    expect(calls()).toBe(6)
  })

  it("stops retrying when the next wait would pass the 45 s budget", async () => {
    const c = clock()
    let calls = 0
    const slowLimited = (async () => {
      calls++
      c.options.sleep(10_000)
      return limited("5")
    }) as unknown as typeof fetch
    await expect(fetchOpenCodeWebSearchText({ query: "q" }, undefined, slowLimited, c.options))
      .rejects.toThrow("Web search failed (429)")
    expect(calls).toBe(3)
    expect(c.waits).toEqual([10_000, 5_500, 10_000, 5_500, 10_000])
  })

  it("does not retry other failures", async () => {
    const { fetchImpl, calls } = scripted([() => new Response("boom", { status: 500 }), ok])
    await expect(fetchOpenCodeWebSearchText({ query: "q" }, undefined, fetchImpl, clock().options))
      .rejects.toThrow("Web search failed (500): boom")
    expect(calls()).toBe(1)
  })

  it("ends a rate-limit wait when the call is aborted", async () => {
    const { fetchImpl, calls } = scripted([() => limited("1"), ok])
    const controller = new AbortController()
    const pending = fetchOpenCodeWebSearchText({ query: "q" }, controller.signal, fetchImpl)
    setTimeout(() => controller.abort(new Error("stopped")), 20)
    await expect(pending).rejects.toThrow("stopped")
    expect(calls()).toBe(1)
  })
})

describe("Exa keyless concurrency", () => {
  const found = () => new Response(JSON.stringify({ result: { content: [{ type: "text", text: "found" }] } }))
  const tick = () => new Promise((resolve) => setTimeout(resolve, 0))

  function gatedFetch() {
    const started: string[] = []
    const keyed: string[] = []
    const answers: Array<(response: Response) => void> = []
    let inFlight = 0
    let maxInFlight = 0
    const fetchImpl = (async (_url: string | URL | Request, init?: RequestInit) => {
      const query = JSON.parse(String(init?.body)).params.arguments.query
      started.push(query)
      if (apiKeyHeader(init)) keyed.push(query)
      maxInFlight = Math.max(maxInFlight, ++inFlight)
      try {
        return await new Promise<Response>((resolve) => answers.push(resolve))
      } finally {
        inFlight--
      }
    }) as unknown as typeof fetch
    const answerNext = async (response: Response = found()) => {
      answers.shift()!(response)
      await tick()
    }
    return { fetchImpl, started, keyed, answerNext, maxInFlight: () => maxInFlight }
  }

  function heldSleep() {
    const waits: number[] = []
    const fire: Array<() => void> = []
    const sleep = (ms: number, signal: AbortSignal) => new Promise<void>((resolve, reject) => {
      waits.push(ms)
      fire.push(resolve)
      signal.addEventListener("abort", () => reject(signal.reason), { once: true })
    })
    return { waits, fire, options: { sleep } }
  }

  function search(query: string, fetchImpl: typeof fetch, options = heldSleep().options, signal?: AbortSignal) {
    return fetchOpenCodeWebSearchText({ query }, signal, fetchImpl, options)
  }

  it("runs at most three keyless searches at once and starts queued ones in arrival order", async () => {
    delete process.env.EXA_API_KEY
    const gate = gatedFetch()
    const searches = ["q0", "q1", "q2", "q3", "q4"].map((q) => search(q, gate.fetchImpl))
    await tick()
    expect(gate.started).toEqual(["q0", "q1", "q2"])
    await gate.answerNext()
    expect(gate.started).toEqual(["q0", "q1", "q2", "q3"])
    for (let i = 0; i < 4; i++) await gate.answerNext()
    expect(await Promise.all(searches)).toEqual(["found", "found", "found", "found", "found"])
    expect(gate.started).toEqual(["q0", "q1", "q2", "q3", "q4"])
    expect(gate.maxInFlight()).toBe(3)
  })

  it("fails a search that waits in line past its queue budget, then serves the next one normally", async () => {
    delete process.env.EXA_API_KEY
    const gate = gatedFetch()
    const holders = ["a", "b", "c"].map((q) => search(q, gate.fetchImpl))
    const queued = heldSleep()
    const late = search("late", gate.fetchImpl, queued.options)
    await tick()
    expect(queued.waits).toEqual([30_000])
    queued.fire[0]!()
    await expect(late).rejects.toThrow("Web search gave up after waiting 30 s in line")
    for (let i = 0; i < 3; i++) await gate.answerNext()
    await Promise.all(holders)
    const next = search("next", gate.fetchImpl)
    await tick()
    expect(gate.started).toEqual(["a", "b", "c", "next"])
    await gate.answerNext()
    await expect(next).resolves.toBe("found")
  })

  it("shares the three slots with every copy of the provider in the process", async () => {
    delete process.env.EXA_API_KEY
    const copy = await import(`../src/web-tools.js?copy=${crypto.randomUUID()}`) as typeof import("../src/web-tools.js")
    const gate = gatedFetch()
    const fromCopy = ["c0", "c1", "c2"].map((q) =>
      copy.fetchOpenCodeWebSearchText({ query: q }, undefined, gate.fetchImpl, heldSleep().options))
    const fromThis = search("mine", gate.fetchImpl)
    await tick()
    expect(gate.started).toEqual(["c0", "c1", "c2"])
    await gate.answerNext()
    expect(gate.started).toEqual(["c0", "c1", "c2", "mine"])
    for (let i = 0; i < 3; i++) await gate.answerNext()
    await Promise.all([...fromCopy, fromThis])
  })

  it("lets an aborted search leave the line without taking a slot", async () => {
    delete process.env.EXA_API_KEY
    const gate = gatedFetch()
    const holders = ["a", "b", "c"].map((q) => search(q, gate.fetchImpl))
    const controller = new AbortController()
    const stopped = search("stopped", gate.fetchImpl, undefined, controller.signal)
    await tick()
    controller.abort(new Error("stopped"))
    await expect(stopped).rejects.toThrow("stopped")
    for (let i = 0; i < 3; i++) await gate.answerNext()
    await Promise.all(holders)
    expect(gate.started).toEqual(["a", "b", "c"])
    const again = ["d", "e", "f"].map((q) => search(q, gate.fetchImpl))
    await tick()
    expect(gate.started).toEqual(["a", "b", "c", "d", "e", "f"])
    for (let i = 0; i < 3; i++) await gate.answerNext()
    await Promise.all(again)
  })

  it("frees the slot of a search aborted mid-request for the next one in line", async () => {
    delete process.env.EXA_API_KEY
    const gate = gatedFetch()
    const controller = new AbortController()
    const abortable = (async (url: string | URL | Request, init?: RequestInit) => {
      const pending = gate.fetchImpl(url, init)
      return Promise.race([pending, new Promise<never>((_, reject) =>
        init!.signal!.addEventListener("abort", () => reject(init!.signal!.reason), { once: true }))])
    }) as unknown as typeof fetch
    const stopped = search("stopped", abortable, undefined, controller.signal)
    const holders = ["b", "c"].map((q) => search(q, gate.fetchImpl))
    const queued = search("queued", gate.fetchImpl)
    await tick()
    controller.abort(new Error("stopped"))
    await expect(stopped).rejects.toThrow("stopped")
    await tick()
    expect(gate.started).toEqual(["stopped", "b", "c", "queued"])
    for (let i = 0; i < 4; i++) await gate.answerNext()
    await Promise.all([...holders, queued])
  })

  it("keeps its slot while it waits out a 429, then retries", async () => {
    delete process.env.EXA_API_KEY
    const gate = gatedFetch()
    const retrying = heldSleep()
    const first = search("first", gate.fetchImpl, retrying.options)
    const holders = ["b", "c"].map((q) => search(q, gate.fetchImpl))
    const queued = search("queued", gate.fetchImpl)
    await tick()
    await gate.answerNext(new Response("{}", { status: 429, headers: { "retry-after": "1" } }))
    expect(retrying.waits).toHaveLength(1)
    expect(gate.started).toEqual(["first", "b", "c"])
    retrying.fire[0]!()
    await tick()
    expect(gate.started).toEqual(["first", "b", "c", "first"])
    for (let i = 0; i < 4; i++) await gate.answerNext()
    expect(await Promise.all([first, ...holders, queued])).toEqual(["found", "found", "found", "found"])
    expect(gate.started).toEqual(["first", "b", "c", "first", "queued"])
  })

  it("with an EXA_API_KEY, fills the keyless slots and sends the rest with the key at once", async () => {
    process.env.EXA_API_KEY = "test-key"
    const gate = gatedFetch()
    const queue = heldSleep()
    const searches = ["k0", "k1", "k2", "k3", "k4"].map((q) => search(q, gate.fetchImpl, queue.options))
    await tick()
    expect(gate.started).toEqual(["k0", "k1", "k2", "k3", "k4"])
    expect(gate.keyed).toEqual(["k3", "k4"])
    expect(queue.waits).toEqual([])
    for (let i = 0; i < 5; i++) await gate.answerNext()
    expect(await Promise.all(searches)).toEqual(["found", "found", "found", "found", "found"])
  })

  it("with an EXA_API_KEY, frees the keyless slot of a search that moved to the key", async () => {
    process.env.EXA_API_KEY = "test-key"
    const gate = gatedFetch()
    const moved = search("moved", gate.fetchImpl)
    await tick()
    await gate.answerNext(new Response("{}", { status: 429, headers: { "retry-after": "1" } }))
    expect(gate.started).toEqual(["moved", "moved"])
    expect(gate.keyed).toEqual(["moved"])
    const others = ["a", "b", "c"].map((q) => search(q, gate.fetchImpl))
    await tick()
    expect(gate.keyed).toEqual(["moved"])
    for (let i = 0; i < 4; i++) await gate.answerNext()
    expect(await Promise.all([moved, ...others])).toEqual(["found", "found", "found", "found"])
  })
})

describe("Exa keyless first, then EXA_API_KEY", () => {
  const KEY = "exa-test-secret-4f9c2a"
  const ok = () => new Response(JSON.stringify({ result: { content: [{ type: "text", text: "found" }] } }))
  const limited = (retryAfter: string) => new Response("{\"error\":\"rate limited\"}", {
    status: 429,
    headers: { "retry-after": retryAfter },
  })

  function recorded(responses: Array<() => Response>) {
    const requests: Array<{ url: string; key: string | undefined }> = []
    const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
      requests.push({ url: String(url), key: apiKeyHeader(init) })
      return responses[Math.min(requests.length - 1, responses.length - 1)]!()
    }) as unknown as typeof fetch
    return { fetchImpl, requests, routes: () => requests.map((r) => r.key ? "keyed" : "keyless") }
  }

  function clock() {
    let t = 1_000_000
    const waits: number[] = []
    const logs: string[] = []
    return {
      waits,
      logs,
      advance: (ms: number) => { t += ms },
      options: {
        now: () => t,
        random: () => 0.5,
        sleep: async (ms: number) => { waits.push(ms); t += ms },
        log: (message: string) => { logs.push(message) },
      },
    }
  }

  it("uses keyless when it answers, without sending the key", async () => {
    process.env.EXA_API_KEY = KEY
    const exa = recorded([ok])
    const c = clock()
    await expect(fetchOpenCodeWebSearchText({ query: "q" }, undefined, exa.fetchImpl, c.options)).resolves.toBe("found")
    expect(exa.requests).toEqual([{ url: "https://mcp.exa.ai/mcp", key: undefined }])
    expect(c.logs).toEqual(["web-search: keyless request, attempt 1"])
  })

  it("sends a search Exa refuses keyless with a burst 429 again with the key, without waiting", async () => {
    process.env.EXA_API_KEY = KEY
    const exa = recorded([() => limited("1"), ok])
    const c = clock()
    await expect(fetchOpenCodeWebSearchText({ query: "q" }, undefined, exa.fetchImpl, c.options)).resolves.toBe("found")
    expect(exa.routes()).toEqual(["keyless", "keyed"])
    expect(exa.requests[1]).toEqual({ url: "https://mcp.exa.ai/mcp", key: KEY })
    expect(c.waits).toEqual([])
    expect(c.logs).toEqual([
      "web-search: keyless request, attempt 1",
      "web-search: keyed request, attempt 1 (keyless 429)",
    ])
    expect(keylessQuota.refusedUntil).toBe(0)
  })

  it("remembers a used-up keyless quota until its Retry-After and goes straight to the key until then", async () => {
    process.env.EXA_API_KEY = KEY
    const c = clock()
    const first = recorded([() => limited("3600"), ok])
    await expect(fetchOpenCodeWebSearchText({ query: "q" }, undefined, first.fetchImpl, c.options)).resolves.toBe("found")
    expect(first.routes()).toEqual(["keyless", "keyed"])
    expect(c.logs[1]).toBe("web-search: keyed request, attempt 1 (keyless quota used up for 1.0 h)")

    c.advance(3_599_000)
    const during = recorded([ok])
    await fetchOpenCodeWebSearchText({ query: "q" }, undefined, during.fetchImpl, c.options)
    expect(during.routes()).toEqual(["keyed"])
    expect(c.logs[2]).toBe(`web-search: keyed request, attempt 1 (keyless quota used up until ${new Date(1_000_000 + 3_600_000).toISOString()})`)

    const copy = await import(`../src/web-tools.js?copy=${crypto.randomUUID()}`) as typeof import("../src/web-tools.js")
    const fromCopy = recorded([ok])
    await copy.fetchOpenCodeWebSearchText({ query: "q" }, undefined, fromCopy.fetchImpl, c.options)
    expect(fromCopy.routes()).toEqual(["keyed"])

    c.advance(1_000)
    const after = recorded([ok])
    await fetchOpenCodeWebSearchText({ query: "q" }, undefined, after.fetchImpl, c.options)
    expect(after.routes()).toEqual(["keyless"])
    expect(c.waits).toEqual([])
  })

  it("retries a keyed 429 after its Retry-After, as without the fallback", async () => {
    process.env.EXA_API_KEY = KEY
    const exa = recorded([() => limited("1"), () => limited("2"), ok])
    const c = clock()
    await expect(fetchOpenCodeWebSearchText({ query: "q" }, undefined, exa.fetchImpl, c.options)).resolves.toBe("found")
    expect(exa.routes()).toEqual(["keyless", "keyed", "keyed"])
    expect(c.waits).toEqual([2_500])
  })

  it("without a key, ignores the remembered quota and keeps the keyless behaviour", async () => {
    keylessQuota.refusedUntil = 1_000_000 + 3_600_000
    const exa = recorded([() => limited("1"), ok])
    const c = clock()
    await expect(fetchOpenCodeWebSearchText({ query: "q" }, undefined, exa.fetchImpl, c.options)).resolves.toBe("found")
    expect(exa.routes()).toEqual(["keyless", "keyless"])
    expect(c.waits).toEqual([1_500])
  })

  it("without a key, still remembers a used-up quota for when a key is set", async () => {
    const exa = recorded([() => limited("600")])
    const c = clock()
    await expect(fetchOpenCodeWebSearchText({ query: "q" }, undefined, exa.fetchImpl, c.options))
      .rejects.toThrow("Exa refuses searches for another 10 min; set EXA_API_KEY to search sooner.")
    expect(keylessQuota.refusedUntil).toBe(1_000_000 + 600_000)
  })

  it("fails a keyed search Exa answers with an MCP error result, as it does for an invalid key", async () => {
    process.env.EXA_API_KEY = KEY
    const invalidKey = () => new Response(
      `event: message\ndata: ${JSON.stringify({
        result: {
          content: [{ type: "text", text: "web_search_exa error (401): Invalid API key. Provide a valid key using 'Authorization: Bearer <key>' or 'x-api-key: <key>'." }],
          isError: true,
        },
        jsonrpc: "2.0",
        id: 1,
      })}\n\n`,
      { headers: { "content-type": "text/event-stream" } },
    )
    const exa = recorded([() => limited("1"), invalidKey])
    await expect(fetchOpenCodeWebSearchText({ query: "q" }, undefined, exa.fetchImpl, clock().options))
      .rejects.toThrow("Web search failed: web_search_exa error (401): Invalid API key.")
    expect(exa.routes()).toEqual(["keyless", "keyed"])
  })

  it("fails a search whose 200 answer is a JSON-RPC error", async () => {
    const exa = recorded([() => new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, error: { code: -32602, message: "Invalid params" } }))])
    await expect(fetchOpenCodeWebSearchText({ query: "q" }, undefined, exa.fetchImpl, clock().options))
      .rejects.toThrow("Web search failed: Invalid params")
  })

  it("keeps the key out of the URL, the route log and errors", async () => {
    process.env.EXA_API_KEY = KEY
    const exa = recorded([() => limited("7200"), () => new Response("{\"error\":\"invalid api key\"}", { status: 401 })])
    const c = clock()
    const error = await fetchOpenCodeWebSearchText({ query: "q" }, undefined, exa.fetchImpl, c.options).catch((e: Error) => e)
    expect(String(error)).toContain("Web search failed (401)")
    expect(exa.routes()).toEqual(["keyless", "keyed"])
    for (const text of [String(error), ...c.logs, ...exa.requests.map((r) => r.url)]) expect(text).not.toContain(KEY)
  })

  it("sends a key read with a trailing newline without it, and refuses one with a line break inside without quoting it", async () => {
    process.env.EXA_API_KEY = `${KEY}\n`
    const trailing = recorded([() => limited("1"), ok])
    await fetchOpenCodeWebSearchText({ query: "q" }, undefined, trailing.fetchImpl, clock().options)
    expect(trailing.requests[1]!.key).toBe(KEY)

    process.env.EXA_API_KEY = `${KEY}\nsecond-line`
    const broken = recorded([() => limited("1"), ok])
    const error = await fetchOpenCodeWebSearchText({ query: "q" }, undefined, broken.fetchImpl, clock().options).catch((e: Error) => e)
    expect(String(error)).toContain("EXA_API_KEY contains a line break or NUL character")
    expect(String(error)).not.toContain(KEY)
    expect(broken.routes()).toEqual(["keyless"])
  })

  it("writes each search's route to the debug log and never the key", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "web-search-log-"))
    const logFile = path.join(dir, "debug.log")
    const script = `
      import { fetchOpenCodeWebSearchText } from ${JSON.stringify(path.resolve(import.meta.dir, "../src/web-tools.ts"))}
      const ok = () => new Response(JSON.stringify({ result: { content: [{ type: "text", text: "found" }] } }))
      let calls = 0
      const fetchImpl = async () => ++calls === 1 ? new Response("{}", { status: 429, headers: { "retry-after": "1" } }) : ok()
      console.log(await fetchOpenCodeWebSearchText({ query: "q" }, undefined, fetchImpl))
    `
    const child = Bun.spawnSync([process.execPath, "-e", script], {
      env: { ...process.env, EXA_API_KEY: KEY, CURSOR_PROVIDER_DEBUG: "1", CURSOR_PROVIDER_DEBUG_FILE: logFile },
    })
    try {
      expect(child.stdout.toString().trim()).toBe("found")
      const log = fs.readFileSync(logFile, "utf8")
      expect(log).toContain("web-search: keyless request, attempt 1\n")
      expect(log).toContain("web-search: keyed request, attempt 1 (keyless 429)\n")
      expect(log).not.toContain(KEY)
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe("parseExaWebSearchResults", () => {
  it("maps Exa JSON results into the OpenCode 2.0 websearch shape", () => {
    const payload = {
      result: {
        content: [{
          type: "text",
          text: JSON.stringify({
            results: [
              { url: "https://example.com", title: "Example", text: "Hello", publishedDate: "2024-01-02T00:00:00Z" },
            ],
          }),
        }],
      },
    }
    expect(parseExaWebSearchResults(JSON.stringify(payload))).toEqual([
      {
        url: "https://example.com",
        title: "Example",
        content: "Hello",
        time: { published: Date.parse("2024-01-02T00:00:00Z") },
      },
    ])
  })

  it("maps Exa's native text-block response into OpenCode 2.0 results", () => {
    const payload = {
      result: {
        content: [{
          type: "text",
          text: [
            "Title: First",
            "URL: https://example.com/first",
            "Published: 2025-03-04T00:00:00Z",
            "Text: First result",
            "",
            "---",
            "",
            "Title: N/A",
            "URL: https://example.com/second",
            "Published: N/A",
            "Highlights:",
            "Second result",
          ].join("\n"),
        }],
      },
    }
    expect(parseExaWebSearchResults(JSON.stringify(payload))).toEqual([
      {
        url: "https://example.com/first",
        title: "First",
        content: "First result",
        time: { published: Date.parse("2025-03-04T00:00:00Z") },
      },
      {
        url: "https://example.com/second",
        content: "Second result",
        time: {},
      },
    ])
  })
})
