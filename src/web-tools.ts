// Type-only: these erase at build time. This module must stay free of *value*
// imports from `@opencode-ai/plugin`, because the OpenCode 2.0 entrypoint pulls
// it in and 2.0's root export has no `tool` — a value import here would throw at
// plugin load under `opencode2`. The classic `tool(...)` registration therefore
// lives in ./web-search-tool.ts.
import type { ToolContext, ToolResult } from "@opencode-ai/plugin"

const EXA_MCP_URL = "https://mcp.exa.ai/mcp"
const WEB_SEARCH_TIMEOUT_MS = 25_000
// Exa's keyless MCP endpoint answers bursts (parallel subagents searching) with 429 and `retry-after: 1`
const RATE_LIMIT_MAX_ATTEMPTS = 6
const RATE_LIMIT_MAX_WAIT_MS = 5_000
const RATE_LIMIT_JITTER_MS = 1_000

export type WebSearchRetryOptions = {
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>
  random?: () => number
  now?: () => number
}

function abortableSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(signal.reason)
    const onAbort = () => {
      clearTimeout(timer)
      reject(signal.reason)
    }
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort)
      resolve()
    }, ms)
    signal.addEventListener("abort", onAbort, { once: true })
  })
}

function retryAfterMs(header: string | null, now: number): number {
  const value = header?.trim()
  if (value) {
    if (/^\d+(\.\d+)?$/.test(value)) return Number(value) * 1000
    const date = Date.parse(value)
    if (Number.isFinite(date)) return Math.max(0, date - now)
  }
  return 1_000
}

export type OpenCodeWebSearchArgs = {
  query: string
  numResults?: number
  livecrawl?: "fallback" | "preferred"
  type?: "auto" | "fast" | "deep"
  contextMaxCharacters?: number
}

function exaMcpUrl(): string {
  const apiKey = process.env.EXA_API_KEY
  if (!apiKey) return EXA_MCP_URL
  const url = new URL(EXA_MCP_URL)
  url.searchParams.set("exaApiKey", apiKey)
  return url.href
}

function mcpText(value: unknown): string | undefined {
  if (!value || typeof value !== "object") return undefined
  const result = (value as { result?: unknown }).result
  if (!result || typeof result !== "object") return undefined
  const content = (result as { content?: unknown }).content
  if (!Array.isArray(content)) return undefined
  for (const item of content) {
    if (
      item &&
      typeof item === "object" &&
      (item as { type?: unknown }).type === "text" &&
      typeof (item as { text?: unknown }).text === "string"
    ) {
      return (item as { text: string }).text
    }
  }
  return undefined
}

export function parseOpenCodeWebSearchResponse(raw: string): string | undefined {
  const trimmed = raw.trim()
  if (!trimmed) return undefined
  try {
    const text = mcpText(JSON.parse(trimmed))
    if (text) return text
  } catch {
    // MCP may respond as an SSE stream instead of one JSON object.
  }
  for (const line of raw.split("\n")) {
    if (!line.startsWith("data: ")) continue
    try {
      const text = mcpText(JSON.parse(line.slice(6)))
      if (text) return text
    } catch {
      // Ignore non-JSON SSE events.
    }
  }
  return undefined
}

/**
 * Raw Exa web-search call: no host tool context, no permission prompt.
 *
 * Split out so both the classic plugin's `custom_websearch` tool and the
 * OpenCode 2.0 plugin's tool registration share one implementation — 2.0's
 * ToolContext has no `ask`, permissions being handled by the host instead.
 */

export type OpenCode2WebSearchResult = {
  url: string
  title?: string
  content?: string
  time: { published?: number }
}

function tryParseJson(raw: string): unknown {
  try {
    return JSON.parse(raw)
  } catch {
    return undefined
  }
}

function publishedMs(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value < 1e12 ? Math.floor(value * 1000) : Math.floor(value)
  }
  if (typeof value === "string" && value.trim()) {
    const parsed = Date.parse(value)
    return Number.isFinite(parsed) ? parsed : undefined
  }
  return undefined
}

function asWebSearchResult(row: unknown): OpenCode2WebSearchResult | undefined {
  if (!row || typeof row !== "object") return undefined
  const record = row as Record<string, unknown>
  const url =
    typeof record.url === "string" ? record.url
    : typeof record.href === "string" ? record.href
    : undefined
  if (!url) return undefined
  const title = typeof record.title === "string" ? record.title : undefined
  const content =
    typeof record.content === "string" ? record.content
    : typeof record.text === "string" ? record.text
    : typeof record.snippet === "string" ? record.snippet
    : undefined
  const published = publishedMs(record.publishedDate ?? record.published ?? record.date)
  return {
    url,
    ...(title ? { title } : {}),
    ...(content ? { content } : {}),
    time: published !== undefined ? { published } : {},
  }
}

function parseExaTextResults(text: string): OpenCode2WebSearchResult[] {
  return text.split(/\n\n---\n\n/).flatMap((block) => {
    const url = block.match(/^URL:\s*(.+)$/m)?.[1]?.trim()
    if (!url) return []
    const title = block.match(/^Title:\s*(.+)$/m)?.[1]?.trim()
    const publishedText = block.match(/^Published:\s*(.+)$/m)?.[1]?.trim()
    const published = publishedText && publishedText !== "N/A"
      ? publishedMs(publishedText)
      : undefined
    const content = block.match(/^(?:Highlights|Text):\s*\n?([\s\S]*)$/m)?.[1]?.trim()
    return [{
      url,
      ...(title && title !== "N/A" ? { title } : {}),
      ...(content ? { content } : {}),
      time: published === undefined ? {} : { published },
    }]
  })
}

/**
 * Turn an Exa MCP text blob into OpenCode 2.0 `websearch` results
 * (`{ url, title?, content?, time }`). Unknown shapes yield an empty list.
 */
export function parseExaWebSearchResults(raw: string): OpenCode2WebSearchResult[] {
  const text = parseOpenCodeWebSearchResponse(raw) ?? raw.trim()
  if (!text) return []
  const parsed = tryParseJson(text)
  const rows = Array.isArray(parsed)
    ? parsed
    : parsed && typeof parsed === "object"
      ? Array.isArray((parsed as { results?: unknown }).results)
        ? (parsed as { results: unknown[] }).results
        : Array.isArray((parsed as { data?: unknown }).data)
          ? (parsed as { data: unknown[] }).data
          : []
      : []
  if (rows.length > 0) {
    return rows.flatMap((row) => {
      const result = asWebSearchResult(row)
      return result ? [result] : []
    })
  }
  return parseExaTextResults(text)
}
export async function fetchOpenCodeWebSearchText(
  args: OpenCodeWebSearchArgs,
  signal: AbortSignal | undefined,
  fetchImpl: typeof fetch = fetch,
  retry: WebSearchRetryOptions = {},
): Promise<string> {
  const sleep = retry.sleep ?? abortableSleep
  const random = retry.random ?? Math.random
  const now = retry.now ?? Date.now
  const deadline = now() + WEB_SEARCH_TIMEOUT_MS
  const controller = new AbortController()
  const abort = () => controller.abort(signal?.reason)
  if (signal?.aborted) abort()
  else signal?.addEventListener("abort", abort, { once: true })
  const timeout = setTimeout(() => controller.abort(new Error("Web search timed out")), WEB_SEARCH_TIMEOUT_MS)
  const body = JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: {
      name: "web_search_exa",
      arguments: {
        query: args.query,
        type: args.type ?? "auto",
        numResults: args.numResults ?? 8,
        livecrawl: args.livecrawl ?? "fallback",
        contextMaxCharacters: args.contextMaxCharacters,
      },
    },
  })

  try {
    for (let attempt = 1; ; attempt++) {
      const response = await fetchImpl(exaMcpUrl(), {
        method: "POST",
        headers: {
          accept: "application/json, text/event-stream",
          "content-type": "application/json",
        },
        body,
        signal: controller.signal,
      })
      const raw = await response.text()
      if (response.status === 429 && attempt < RATE_LIMIT_MAX_ATTEMPTS) {
        const wait = Math.min(retryAfterMs(response.headers.get("retry-after"), now()), RATE_LIMIT_MAX_WAIT_MS)
          + Math.floor(random() * RATE_LIMIT_JITTER_MS)
        if (now() + wait < deadline) {
          await sleep(wait, controller.signal)
          continue
        }
      }
      if (!response.ok) throw new Error(`Web search failed (${response.status}): ${raw.slice(0, 500)}`)
      return parseOpenCodeWebSearchResponse(raw) ?? "No search results found. Please try a different query."
    }
  } finally {
    clearTimeout(timeout)
    signal?.removeEventListener("abort", abort)
  }
}

export async function executeOpenCodeWebSearch(
  args: OpenCodeWebSearchArgs,
  context: ToolContext,
  fetchImpl: typeof fetch = fetch,
): Promise<ToolResult> {
  await context.ask({
    permission: "websearch",
    patterns: [args.query],
    always: ["*"],
    metadata: {
      query: args.query,
      numResults: args.numResults,
      livecrawl: args.livecrawl,
      type: args.type,
      contextMaxCharacters: args.contextMaxCharacters,
      provider: "exa",
    },
  })

  const output = await fetchOpenCodeWebSearchText(args, context.abort, fetchImpl)
  return {
    title: `Exa Web Search: ${args.query}`,
    output,
    metadata: { provider: "exa" },
  }
}
