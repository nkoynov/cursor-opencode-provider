/**
 * Early tool rows: show a host tool row while Cursor's model is still writing
 * a large tool input.
 *
 * Cursor announces a call with `partial_tool_call` (its kind, then for an edit
 * its path) as soon as the model starts it, but sends the input only when the
 * model has finished, up to a minute later for a large file. The provider
 * learns the call's final id and host tool name only from the exec. OpenCode 2
 * kills the step when a `tool-call` names a different tool than the
 * `tool-input-start` with its id, so a row opens only when the name is
 * predictable, under a provisional id the final `tool-call` reuses. Results
 * for that id route back to Cursor's exec through `resolveEarlyToolCallId`.
 *
 * A row opens with `providerExecuted: true`: OpenCode then fails a row whose
 * call never comes on every way the step ends, and a later `tool-call`
 * without the flag still runs locally. A row the provider gives up on is
 * closed at once as a failed provider-executed call.
 */
import fs from "node:fs"
import path from "node:path"
import type { LanguageModelV3StreamPart } from "@ai-sdk/provider"
import { APPLY_PATCH_TOOL } from "./protocol/apply-patch.js"

const EARLY_ROW_VARIANTS = new Set(["edit_tool_call", "task_tool_call"])
/** Cursor's own pre-write read threshold, as `remapCorrelatedEditWriteForCatalog` uses it. */
const MAX_EDIT_SOURCE_BYTES = 50 * 1024 * 1024
const MAX_ALIASES = 4096

export type ComposingToolCall = {
  variant: string
  args: Record<string, unknown>
  /** Eligible once, with no predictable host tool name: never opens a row. */
  skipped?: boolean
}

export type EarlyToolRow = {
  toolCallId: string
  toolName: string
  /** The synthetic exec id in `toolCallId`; a call Cursor completes without an exec is bridged under it. */
  bridgedExecId: number
  /** The call's own exec or completion came without reusing this row; it closes with this text. */
  settle?: string
}

export type EarlyToolRowState = {
  /** Calls Cursor announced whose exec has not arrived yet, by Cursor call id. */
  composing: Map<string, ComposingToolCall>
  /** Rows shown to the host and not yet bound to a tool call or closed, by Cursor call id. */
  open: Map<string, EarlyToolRow>
  /** Calls whose own exec the provider already handled; they will not end a later step. */
  handled: Set<string>
}

export function earlyToolRowState(session: { earlyToolRows?: EarlyToolRowState }): EarlyToolRowState {
  return session.earlyToolRows ??= { composing: new Map(), open: new Map(), handled: new Set() }
}

const aliases = new Map<string, { sessionId: string; execId: number }>()

/** The host's id for an exec registered under a provisional row id. */
export function aliasEarlyToolCall(toolCallId: string, sessionId: string, execId: number): void {
  aliases.delete(toolCallId)
  aliases.set(toolCallId, { sessionId, execId })
  while (aliases.size > MAX_ALIASES) aliases.delete(aliases.keys().next().value as string)
}

export function resolveEarlyToolCallId(toolCallId: string): { sessionId: string; execId: number } | undefined {
  return aliases.get(toolCallId)
}

export function resetEarlyToolRowsForTests(): void {
  aliases.clear()
}

/**
 * Record what a `partial_tool_call` says about a call; later frames add to it.
 * Every kind is kept: a call without a row still holds back rows for the calls
 * after it, whose exec it can precede.
 */
export function noteComposingToolCall(state: EarlyToolRowState, partial: Record<string, unknown>): void {
  const callId = typeof partial.call_id === "string" ? partial.call_id : ""
  const toolCall = partial.tool_call as Record<string, unknown> | undefined
  if (!callId || !toolCall || state.handled.has(callId) || state.open.has(callId)) return
  const variant = Object.keys(toolCall).find((key) => key.endsWith("_tool_call") && toolCall[key]) ?? "unknown"
  const payload = toolCall[variant] as Record<string, unknown> | undefined
  const args = payload?.args && typeof payload.args === "object" ? payload.args as Record<string, unknown> : {}
  const prior = state.composing.get(callId)
  state.composing.set(callId, {
    variant: prior?.variant ?? variant,
    args: { ...prior?.args, ...args },
    skipped: prior?.skipped || !EARLY_ROW_VARIANTS.has(variant),
  })
}

export type EarlyToolNameContext = {
  advertised: ReadonlySet<string>
  permitted?: ReadonlySet<string>
  workspaceRoot: string
}

/**
 * The host tool the call's exec will become, or undefined when that is not
 * certain now. An edit mirrors the pump: Cursor's private read is answered by
 * the provider only inside the workspace, then the whole-file write becomes
 * `edit` for a non-empty existing file and stays `write` for a new or empty
 * one, or `apply_patch` on a host that offers it instead.
 */
export function predictEarlyToolName(call: ComposingToolCall, context: EarlyToolNameContext): string | undefined {
  const { advertised } = context
  let name: string | undefined
  if (call.variant === "task_tool_call") {
    name = advertised.has("task") ? "task" : advertised.has("subagent") ? "subagent" : undefined
  } else if (call.variant === "edit_tool_call") {
    const target = typeof call.args.path === "string" ? call.args.path : ""
    if (!target || !(advertised.has("write") || advertised.has(APPLY_PATCH_TOOL))) return undefined
    const base = editTargetToolName(target, context)
    if (!base) return undefined
    name = advertised.has(base) ? base : advertised.has(APPLY_PATCH_TOOL) ? APPLY_PATCH_TOOL : undefined
  }
  if (!name) return undefined
  const permitted = context.permitted
  if (permitted && permitted.size > 0 && !permitted.has(name)) return undefined
  return name
}

function editTargetToolName(target: string, context: EarlyToolNameContext): "write" | "edit" | undefined {
  const absolute = path.resolve(context.workspaceRoot, target)
  try {
    fs.lstatSync(absolute)
  } catch (error) {
    return (error as { code?: unknown }).code === "ENOENT" ? "write" : undefined
  }
  try {
    const relative = path.relative(fs.realpathSync(context.workspaceRoot), fs.realpathSync(absolute))
    if (relative.startsWith(`..${path.sep}`) || relative === ".." || path.isAbsolute(relative)) return undefined
    const stat = fs.statSync(absolute)
    if (!stat.isFile() || stat.size > MAX_EDIT_SOURCE_BYTES) return undefined
    const editable = context.advertised.has("edit") || context.advertised.has(APPLY_PATCH_TOOL)
    return stat.size > 0 && editable ? "edit" : "write"
  } catch {
    return undefined
  }
}

export function earlyRowStartPart(row: EarlyToolRow): LanguageModelV3StreamPart {
  return { type: "tool-input-start", id: row.toolCallId, toolName: row.toolName, providerExecuted: true }
}

export function earlyRowEndPart(row: EarlyToolRow): LanguageModelV3StreamPart {
  return { type: "tool-input-end", id: row.toolCallId }
}

/** A failed provider-executed call: OpenCode settles the row without running anything or continuing the step. */
export function earlyRowCloseParts(row: EarlyToolRow, reason: string): LanguageModelV3StreamPart[] {
  return [
    { type: "tool-input-end", id: row.toolCallId },
    { type: "tool-call", toolCallId: row.toolCallId, toolName: row.toolName, input: "{}", providerExecuted: true },
    { type: "tool-result", toolCallId: row.toolCallId, toolName: row.toolName, result: reason, isError: true },
  ]
}
