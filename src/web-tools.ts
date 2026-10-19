// Type-only: these erase at build time. This module must stay free of *value*
// imports from `@opencode-ai/plugin`, because the OpenCode 2.0 entrypoint pulls
// it in and 2.0's root export has no `tool` — a value import here would throw at
// plugin load under `opencode2`. The classic `tool(...)` registration therefore
// lives in ./web-search-tool.ts.
import type { ToolContext, ToolResult } from "@opencode-ai/plugin"
import { trace } from "./debug.js"
import { processShared } from "./process-shared.js"

const EXA_MCP_URL = "https://mcp.exa.ai/mcp"
const WEB_SEARCH_TIMEOUT_MS = 45_000
// Exa's keyless MCP endpoint answers bursts (parallel subagents searching) with 429 and `retry-after: 1`
const RATE_LIMIT_MAX_ATTEMPTS = 6
const RATE_LIMIT_MAX_WAIT_MS = 5_000
const RATE_LIMIT_JITTER_MS = 1_000
// Exa's keyless tier allows about three requests in flight per IP: three sustained, a fourth is refused with 429
const EXA_KEYLESS_CONCURRENCY = 3
const EXA_KEYLESS_MAX_QUEUE_WAIT_MS = 30_000

type SearchSlots = { active: number; waiting: Array<() => void> }
const exaKeylessSlots = processShared("web-search.exa-keyless-slots.v1", (): SearchSlots => ({ active: 0, waiting: [] }))
const exaKeylessQuota = processShared("web-search.exa-keyless-quota.v1", () => ({ refusedUntil: 0 }))

export type WebSearchRetryOptions = {
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>
  random?: () => number
  now?: () => number
  log?: (message: string) => void
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

function formatWait(ms: number): string {
  return ms >= 3_600_000 ? `${(ms / 3_600_000).toFixed(1)} h` : `${Math.ceil(ms / 60_000)} min`
}

function exaKeylessSlotRelease(): () => void {
  const slots = exaKeylessSlots
  let released = false
  return () => {
    if (released) return
    released = true
    const next = slots.waiting.shift()
    if (next) next()
    else slots.active--
  }
}

/** Take a free keyless Exa slot without waiting; undefined when all are busy. */
function tryAcquireExaKeylessSlot(): (() => void) | undefined {
  if (exaKeylessSlots.active >= EXA_KEYLESS_CONCURRENCY) return undefined
  exaKeylessSlots.active++
  return exaKeylessSlotRelease()
}

/** Wait for one of the process's keyless Exa slots, first come first served; resolves to its release. */
function acquireExaKeylessSlot(
  signal: AbortSignal,
  sleep: NonNullable<WebSearchRetryOptions["sleep"]>,
): Promise<() => void> {
  const slots = exaKeylessSlots
  if (signal.aborted) return Promise.reject(signal.reason)
  const free = tryAcquireExaKeylessSlot()
  if (free) return Promise.resolve(free)
  const release = exaKeylessSlotRelease()
  return new Promise((resolve, reject) => {
    const timer = new AbortController()
    const leave = () => {
      timer.abort()
      signal.removeEventListener("abort", onAbort)
      const index = slots.waiting.indexOf(grant)
      if (index >= 0) slots.waiting.splice(index, 1)
    }
    const grant = () => {
      leave()
      resolve(release)
    }
    const onAbort = () => {
      leave()
      reject(signal.reason)
    }
    signal.addEventListener("abort", onAbort, { once: true })
    slots.waiting.push(grant)
    sleep(EXA_KEYLESS_MAX_QUEUE_WAIT_MS, timer.signal).then(() => {
      if (!slots.waiting.includes(grant)) return
      leave()
      reject(new Error(
        `Web search gave up after waiting ${EXA_KEYLESS_MAX_QUEUE_WAIT_MS / 1000} s in line: Exa's keyless tier `
          + `takes ${EXA_KEYLESS_CONCURRENCY} searches at a time and ${slots.waiting.length} more are waiting. `
          + "Search again shortly, or set EXA_API_KEY",
      ))
    }, () => {})
  })
}

export type OpenCodeWebSearchArgs = {
  query: string
  numResults?: number
  livecrawl?: "fallback" | "preferred"
  type?: "auto" | "fast" | "deep"
  contextMaxCharacters?: number
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

/** The JSON-RPC messages of an MCP response: one JSON object, or the `data:` events of an SSE stream. */
function mcpMessages(raw: string): unknown[] {
  const trimmed = raw.trim()
  if (!trimmed) return []
  const whole = tryParseJson(trimmed)
  if (whole !== undefined) return [whole]
  return raw.split("\n").flatMap((line) => {
    if (!line.startsWith("data: ")) return []
    const message = tryParseJson(line.slice(6))
    return message === undefined ? [] : [message]
  })
}

export function parseOpenCodeWebSearchResponse(raw: string): string | undefined {
  for (const message of mcpMessages(raw)) {
    const text = mcpText(message)
    if (text) return text
  }
  return undefined
}

/** Exa's MCP answers a failed keyed search (invalid key, no credit) with HTTP 200 and an error result. */
function mcpToolError(raw: string): string | undefined {
  for (const message of mcpMessages(raw)) {
    if (!message || typeof message !== "object") continue
    const { result, error } = message as { result?: { isError?: unknown }; error?: { message?: unknown } }
    if (result && typeof result === "object" && result.isError === true) return mcpText(message) ?? "Exa reported an error"
    if (error && typeof error === "object") return typeof error.message === "string" ? error.message : "Exa reported an error"
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

  const apiKey = process.env.EXA_API_KEY?.trim()
  const log = retry.log ?? trace
  let release = () => {}
  try {
    // With a key, keyless still goes first to save the key's credit; the key only takes what keyless can't
    let keyed = false
    let reason = ""
    if (!apiKey) release = await acquireExaKeylessSlot(controller.signal, sleep)
    else if (now() < exaKeylessQuota.refusedUntil) {
      keyed = true
      reason = `keyless quota used up until ${new Date(exaKeylessQuota.refusedUntil).toISOString()}`
    } else {
      const slot = tryAcquireExaKeylessSlot()
      if (slot) release = slot
      else {
        keyed = true
        reason = "keyless slots busy"
      }
    }
    for (let attempt = 1; ; attempt++) {
      // fetch's invalid-header error quotes the whole value, key included
      if (keyed && apiKey && /[\0\r\n]/.test(apiKey)) {
        throw new Error("Web search failed: EXA_API_KEY contains a line break or NUL character, so it can't be sent to Exa")
      }
      log(`web-search: ${keyed ? "keyed" : "keyless"} request, attempt ${attempt}${reason ? ` (${reason})` : ""}`)
      const response = await fetchImpl(EXA_MCP_URL, {
        method: "POST",
        headers: {
          accept: "application/json, text/event-stream",
          "content-type": "application/json",
          ...(keyed && apiKey ? { "x-api-key": apiKey } : {}),
        },
        body,
        signal: controller.signal,
      })
      const raw = await response.text()
      const retryAfter = response.status === 429 ? retryAfterMs(response.headers.get("retry-after"), now()) : 0
      if (response.status === 429 && !keyed) {
        if (retryAfter > WEB_SEARCH_TIMEOUT_MS) {
          exaKeylessQuota.refusedUntil = Math.max(exaKeylessQuota.refusedUntil, now() + retryAfter)
        }
        if (apiKey) {
          release()
          keyed = true
          reason = retryAfter > WEB_SEARCH_TIMEOUT_MS
            ? `keyless quota used up for ${formatWait(retryAfter)}`
            : "keyless 429"
          attempt = 0
          continue
        }
      }
      // Exa's keyless daily quota answers with a Retry-After of hours, until midnight UTC
      if (retryAfter > WEB_SEARCH_TIMEOUT_MS) {
        throw new Error(
          `Web search failed (429): Exa refuses searches for another ${formatWait(retryAfter)}`
            + `${apiKey ? "" : "; set EXA_API_KEY to search sooner"}. ${raw.slice(0, 300)}`,
        )
      }
      if (response.status === 429 && attempt < RATE_LIMIT_MAX_ATTEMPTS) {
        const wait = Math.min(retryAfter, RATE_LIMIT_MAX_WAIT_MS) + Math.floor(random() * RATE_LIMIT_JITTER_MS)
        if (now() + wait < deadline) {
          await sleep(wait, controller.signal)
          continue
        }
      }
      if (!response.ok) throw new Error(`Web search failed (${response.status}): ${raw.slice(0, 500)}`)
      const toolError = mcpToolError(raw)
      if (toolError !== undefined) throw new Error(`Web search failed: ${toolError.slice(0, 500)}`)
      return parseOpenCodeWebSearchResponse(raw) ?? "No search results found. Please try a different query."
    }
  } finally {
    release()
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
