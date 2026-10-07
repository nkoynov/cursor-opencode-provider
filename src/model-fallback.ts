import type { LanguageModelV3CallOptions } from "@ai-sdk/provider"

// Cursor's safety filter can answer a request with another model (Claude Opus
// 4.8 for Opus 5.5) without telling the client while it streams. Cursor only
// records the switch when it stores a step's assistant message (a KV blob whose
// Anthropic content starts with a `fallback` block) and announces it in a text
// notice when the turn ends. By default the provider stops the turn at the first
// step marked this way and lets the user rephrase or accept the other model once.

export const ALLOW_MODEL_FALLBACK_ENV = "CURSOR_ALLOW_MODEL_FALLBACK"

export function modelFallbackAllowedByEnv(): boolean {
  const value = process.env[ALLOW_MODEL_FALLBACK_ENV]?.trim().toLowerCase()
  return value === "1" || value === "true"
}

export type ModelSwitch = {
  /** Model the request asked for, as Cursor names it, when known. */
  from?: string
  /** Model that answered instead. */
  to: string
  source: "fallback-block" | "thinking-signature" | "server-notice"
}

const CLAUDE_MODEL = /^claude-([a-z]+)-(\d+)(?:-(\d{1,2}))?(?![0-9])/

function claudeVersion(id: string): { family: string; version: string } | undefined {
  const match = CLAUDE_MODEL.exec(id.trim().toLowerCase())
  if (!match) return undefined
  return { family: match[1]!, version: match[3] ? `${match[2]}.${match[3]}` : match[2]! }
}

/** "claude-opus-4-8@default" → "Claude Opus 4.8"; names that are already readable stay as they are. */
export function modelDisplayName(id: string): string {
  const parsed = claudeVersion(id)
  if (!parsed) return id.trim()
  return `Claude ${parsed.family[0]!.toUpperCase()}${parsed.family.slice(1)} ${parsed.version}`
}

function sameModel(a: string, b: string): boolean {
  const left = claudeVersion(a)
  const right = claudeVersion(b)
  if (left && right) return left.family === right.family && left.version === right.version
  return a.trim().toLowerCase() === b.trim().toLowerCase()
}

const ASSISTANT_BLOB_PREFIX = Buffer.from('{"role":"assistant"')

/** Cursor stores each model step's assistant message as a JSON KV blob once the step and its tool results are done. */
export function isAssistantMessageBlob(data: Uint8Array): boolean {
  return data.length > ASSISTANT_BLOB_PREFIX.length
    && Buffer.from(data.buffer, data.byteOffset, ASSISTANT_BLOB_PREFIX.length).equals(ASSISTANT_BLOB_PREFIX)
}

/**
 * The model switch an assistant-message KV blob records: Anthropic's `fallback`
 * content block, or a thinking signature that names another version of the
 * requested model's family (Opus 5.5 signatures name no model; Opus 4.8's do).
 */
export function modelSwitchInBlob(data: Uint8Array, requestedModelId: string): ModelSwitch | undefined {
  if (!isAssistantMessageBlob(data)) return undefined
  let message: Record<string, unknown>
  try {
    message = JSON.parse(Buffer.from(data.buffer, data.byteOffset, data.length).toString("utf8"))
  } catch {
    return undefined
  }
  const cursor = (message.providerOptions as Record<string, unknown> | undefined)?.cursor as
    Record<string, unknown> | undefined
  if (typeof cursor?.anthropicNativeContent === "string") {
    try {
      const blocks = JSON.parse(cursor.anthropicNativeContent) as unknown
      for (const block of Array.isArray(blocks) ? blocks : []) {
        const b = block as { type?: unknown; from?: { model?: unknown }; to?: { model?: unknown } }
        if (b?.type !== "fallback" || typeof b.to?.model !== "string" || !b.to.model) continue
        const from = typeof b.from?.model === "string" ? b.from.model : undefined
        if ((from && sameModel(from, b.to.model)) || sameModel(requestedModelId, b.to.model)) continue
        return { ...(from ? { from } : {}), to: b.to.model, source: "fallback-block" }
      }
    } catch {
      // A malformed native copy carries no evidence either way.
    }
  }
  const requested = claudeVersion(requestedModelId)
  if (!requested) return undefined
  for (const part of Array.isArray(message.content) ? message.content : []) {
    const p = part as { type?: unknown; signature?: unknown }
    if (p?.type !== "reasoning" || typeof p.signature !== "string") continue
    const named = signatureModel(p.signature)
    const served = named ? claudeVersion(named) : undefined
    if (served && served.family === requested.family && served.version !== requested.version) {
      return { from: requestedModelId, to: named!, source: "thinking-signature" }
    }
  }
  return undefined
}

/** The model a thinking signature names: a length-prefixed protobuf string in its clear metadata. */
function signatureModel(signature: string): string | undefined {
  const bytes = Buffer.from(signature, "base64")
  for (let at = bytes.indexOf("claude-"); at > 0; at = bytes.indexOf("claude-", at + 1)) {
    const length = bytes[at - 1]!
    if (length < 8 || length > 64 || at + length > bytes.length) continue
    const name = bytes.subarray(at, at + length).toString("latin1")
    if (/^claude-[a-z0-9.@-]+$/.test(name)) return name
  }
  return undefined
}

const NOTICE_SWITCH = /hit a safety filter, and the conversation was automatically switched to ([^\n]+?)\.(?:\s|$)/
const NOTICE_HEADING = /^\s*Switched to ([^\n]+?)\s*$/m

/** The switch Cursor's end-of-turn notice ("Switched to Claude Opus 4.8 …") announces. */
export function modelSwitchInNotice(text: string, isServerNotice: boolean): ModelSwitch | undefined {
  const to = NOTICE_SWITCH.exec(text)?.[1] ?? (isServerNotice ? NOTICE_HEADING.exec(text)?.[1] : undefined)
  return to ? { to: to.trim(), source: "server-notice" } : undefined
}

/** The reply that lets the other model answer the stopped request once, e.g. "continue with opus 4.8". */
export function fallbackOverridePhrase(servedModel: string): string {
  return `continue with ${modelDisplayName(servedModel).replace(/^claude\s+/i, "").toLowerCase()}`
}

function normalizeReply(text: string): string {
  return text
    .trim()
    .replace(/^[`"'“”]+|[`"'“”]+$/g, "")
    .replace(/[.!]+$/, "")
    .replace(/\s+/g, " ")
    .toLowerCase()
}

/** Only the whole reply counts, so the phrase inside a longer message never accepts the other model. */
export function isFallbackOverride(text: string, servedModel: string): boolean {
  const reply = normalizeReply(text)
  const phrase = fallbackOverridePhrase(servedModel)
  const full = `continue with ${modelDisplayName(servedModel).toLowerCase()}`
  return reply === phrase || reply === full
}

export type HostToolRun = { toolName: string; input: string }

const TOOL_SUMMARY_KEYS = ["command", "filePath", "path", "file_path", "pattern", "url", "query", "description"]

/** "shell `npm test`": the tool and its main argument, short. */
export function describeToolRun(run: HostToolRun): string {
  let args: Record<string, unknown> | undefined
  try {
    const parsed = JSON.parse(run.input) as unknown
    if (parsed && typeof parsed === "object") args = parsed as Record<string, unknown>
  } catch {
    args = undefined
  }
  const key = TOOL_SUMMARY_KEYS.find((name) => typeof args?.[name] === "string" && (args[name] as string).trim())
  if (!key) return run.toolName
  const value = (args![key] as string).replace(/\s+/g, " ").trim()
  const short = value.length > 60 ? `${value.slice(0, 57)}...` : value
  return `${run.toolName} \`${short.replace(/`/g, "'")}\``
}

export function modelFallbackStopMessage(input: {
  requestedModel: string
  servedModel: string
  /** Host tools that ran earlier in the turn, on the requested model. */
  toolsKept: readonly HostToolRun[]
  /** Host tools of the switched step: Cursor marks a step only after its tool results. */
  toolsSwitched: readonly HostToolRun[]
}): string {
  const requested = modelDisplayName(input.requestedModel)
  const served = modelDisplayName(input.servedModel)
  const lines = [
    `**Stopped:** Cursor's safety filter switched this request from ${requested} to ${served}. `
      + `This can happen with safe requests. Nothing ${served} wrote is kept in the conversation.`,
  ]
  const ran: string[] = []
  if (input.toolsKept.length) ran.push(`${input.toolsKept.map(describeToolRun).join(", ")}`)
  if (input.toolsSwitched.length) {
    ran.push(`${input.toolsSwitched.map(describeToolRun).join(", ")} (by ${served}, before Cursor marked the switch)`)
  }
  if (ran.length) lines.push(`Already ran in this turn: ${ran.join("; ")}.`)
  lines.push(
    `Rephrase the request to try ${requested} again, or reply \`${fallbackOverridePhrase(input.servedModel)}\` `
      + `to let ${served} answer it this once.`,
  )
  return lines.join("\n\n")
}

/** Told to the model with the next request when host tools ran that its rolled-back history lacks. */
export function unrecordedToolsNote(runs: readonly HostToolRun[]): string | undefined {
  if (!runs.length) return undefined
  return (
    "<system-update>Before the previous request was stopped, these tool calls already ran and their effects "
    + `are real, but their results are not in this conversation: ${runs.map(describeToolRun).join(", ")}.</system-update>`
  )
}

export type ModelFallbackStop = {
  requestedModel: string
  servedModel: string
  /** The stopped turn's request, sent again if the user accepts the other model. */
  userText: string
  /** The rolled-back checkpoint already holds that request and the steps before the switch. */
  checkpointHoldsTurn: boolean
  /** Host tools that ran but are not in the rolled-back conversation; the next request is told about them. */
  unrecordedTools: HostToolRun[]
  /** The stop text the turn ended with; finding it in the host history ties the reply to this stop. */
  message: string
}

const stopsBySession = new Map<string, ModelFallbackStop>()
const MAX_STOPS = 256

export function rememberModelFallbackStop(sessionKey: string, stop: ModelFallbackStop): void {
  stopsBySession.delete(sessionKey)
  stopsBySession.set(sessionKey, stop)
  while (stopsBySession.size > MAX_STOPS) {
    const oldest = stopsBySession.keys().next().value as string | undefined
    if (!oldest) break
    stopsBySession.delete(oldest)
  }
}

export function peekModelFallbackStop(sessionKey: string): ModelFallbackStop | undefined {
  return stopsBySession.get(sessionKey)
}

export function forgetModelFallbackStop(sessionKey: string, stop?: ModelFallbackStop): void {
  if (!stop || stopsBySession.get(sessionKey) === stop) stopsBySession.delete(sessionKey)
}

export function serializeModelFallbackStop(stop: ModelFallbackStop): string {
  return JSON.stringify(stop)
}

export function parseModelFallbackStop(raw: string): ModelFallbackStop | undefined {
  try {
    const v = JSON.parse(raw) as Partial<ModelFallbackStop>
    if (
      typeof v.requestedModel !== "string" || typeof v.servedModel !== "string" || typeof v.userText !== "string"
      || typeof v.message !== "string" || !v.message
    ) return undefined
    return {
      requestedModel: v.requestedModel,
      servedModel: v.servedModel,
      userText: v.userText,
      checkpointHoldsTurn: v.checkpointHoldsTurn === true,
      unrecordedTools: Array.isArray(v.unrecordedTools)
        ? v.unrecordedTools.filter((r): r is HostToolRun => typeof r?.toolName === "string" && typeof r?.input === "string")
        : [],
      message: v.message,
    }
  } catch {
    return undefined
  }
}

export function resetModelFallbackStopsForTests(): void {
  stopsBySession.clear()
}

type Prompt = LanguageModelV3CallOptions["prompt"]

function textParts(message: Prompt[number]): string[] {
  if (typeof message.content === "string") return [message.content]
  return (message.content as unknown as Array<{ type?: string; text?: unknown }>)
    .filter((part) => part.type === "text" && typeof part.text === "string")
    .map((part) => part.text as string)
}

function messageText(message: Prompt[number]): string {
  return textParts(message).join("")
}

const TAG_BLOCK = /^<([a-z][\w-]*)(?:\s[^>]*)?>[\s\S]*<\/\1>$/i

/** The user's own words: host plugins add tag blocks (an output-style `<system-reminder>`, notes) as text parts or messages. */
function ownText(message: Prompt[number]): string {
  return textParts(message).filter((text) => !TAG_BLOCK.test(text.trim())).join("").trim()
}

export type ModelFallbackReply = {
  stop: ModelFallbackStop
  /** The user accepted the other model for the stopped request. */
  override: boolean
  /** First message of the stopped turn: its request and everything after it up to `stopIndex`. */
  turnStart: number
  /** The host assistant message holding the stop text. */
  stopIndex: number
}

/**
 * Tie a user turn to the session's pending stop. The stop counts only while the
 * host history's latest assistant message still holds its text and a user reply
 * follows it; otherwise the host moved on (edit, revert, compaction) and the stop
 * is dropped.
 */
export function matchModelFallbackReply(
  sessionKey: string,
  prompt: Prompt,
  /** OpenCode sends its own notes (background completions, nested rules) as user messages. */
  isHostNote: (message: Prompt[number]) => boolean = () => false,
): ModelFallbackReply | undefined {
  const stop = stopsBySession.get(sessionKey)
  if (!stop) return undefined
  let stopIndex = -1
  for (let i = prompt.length - 1; i >= 0; i--) {
    if (prompt[i]!.role === "assistant") {
      stopIndex = i
      break
    }
  }
  if (stopIndex < 0 || !messageText(prompt[stopIndex]!).includes(stop.message)) {
    stopsBySession.delete(sessionKey)
    return undefined
  }
  const replies = prompt.slice(stopIndex + 1).filter((message) => message.role === "user" && !isHostNote(message))
  if (replies.length === 0) return undefined
  let turnStart = stopIndex
  const inTurn = (message: Prompt[number]) =>
    message.role === "assistant" || message.role === "tool" || (message.role === "user" && isHostNote(message))
  while (turnStart > 0 && inTurn(prompt[turnStart - 1]!)) turnStart--
  while (turnStart > 0 && prompt[turnStart - 1]!.role === "user") turnStart--
  const said = replies.map(ownText).filter(Boolean)
  const override = said.length === 1 && isFallbackOverride(said[0]!, stop.servedModel)
  return { stop, override, turnStart, stopIndex }
}
