import { afterEach, describe, expect, it } from "bun:test"
import {
  executeOpenCodeWebSearch,
  fetchOpenCodeWebSearchText,
  parseOpenCodeWebSearchResponse,
  parseExaWebSearchResults,
} from "../src/web-tools.js"

const originalExaApiKey = process.env.EXA_API_KEY

afterEach(() => {
  if (originalExaApiKey === undefined) delete process.env.EXA_API_KEY
  else process.env.EXA_API_KEY = originalExaApiKey
})

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
    expect(requestUrl).toContain("https://mcp.exa.ai/mcp?exaApiKey=test-key")
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
    const { fetchImpl } = scripted([() => limited(null), () => limited("120"), ok])
    const c = clock()
    await fetchOpenCodeWebSearchText({ query: "q" }, undefined, fetchImpl, c.options)
    expect(c.waits).toEqual([1_500, 5_500])
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
    const answers: Array<(response: Response) => void> = []
    let inFlight = 0
    let maxInFlight = 0
    const fetchImpl = (async (_url: string | URL | Request, init?: RequestInit) => {
      started.push(JSON.parse(String(init?.body)).params.arguments.query)
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
    return { fetchImpl, started, answerNext, maxInFlight: () => maxInFlight }
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

  it("does not limit searches made with an EXA_API_KEY", async () => {
    process.env.EXA_API_KEY = "test-key"
    const gate = gatedFetch()
    const searches = ["k0", "k1", "k2", "k3", "k4"].map((q) => search(q, gate.fetchImpl))
    await tick()
    expect(gate.started).toEqual(["k0", "k1", "k2", "k3", "k4"])
    for (let i = 0; i < 5; i++) await gate.answerNext()
    await Promise.all(searches)
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
