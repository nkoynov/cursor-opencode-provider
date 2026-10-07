import { afterEach, describe, expect, it } from "bun:test"
import {
  executeOpenCodeWebSearch,
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
