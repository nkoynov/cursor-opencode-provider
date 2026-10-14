/**
 * Preserve native result status before OpenCode's AI SDK lowers errors to text.
 * Upstream: https://github.com/anomalyco/opencode/blob/v2.0.27/packages/core/src/aisdk.ts#L652-L685
 * Native part.providerMetadata becomes SDK part.providerOptions (same file, L717-L720).
 */
export type ToolRefusal = "permission_denied" | "rejected"
export type NativeToolFailure = { type: string; text: string; refusal?: ToolRefusal }
export const TOOL_RESULT_STATUS_KEY = "opencodeToolResult"

const record = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined

export function nativeToolFailure(value: unknown, refusal?: ToolRefusal): NativeToolFailure {
  const envelope = record(value)
  const error = record(envelope?.error)
  const type = typeof error?.type === "string" && error.type ? error.type : "tool.execution"
  const message = typeof error?.message === "string" && error.message
    ? error.message : typeof value === "string" && value ? value : `OpenCode tool failed (${type})`
  const content = Array.isArray(envelope?.content) ? envelope.content.flatMap(item => {
    const part = record(item)
    return part?.type === "text" && typeof part.text === "string" && part.text ? [part.text] : []
  }).join("\n") : ""
  return { type, text: content ? `${message}\n\n${content}` : message,
    ...(refusal ? { refusal } : type === "permission.rejected" ? { refusal: "rejected" as const } : {}) }
}

/** The native tool hook preserves the underlying typed permission cause. */
export function nativeToolRefusal(error: unknown): ToolRefusal | undefined {
  const seen = new Set<unknown>()
  for (let depth = 0; depth < 16 && !seen.has(error); depth++) {
    seen.add(error)
    const cause = record(error)
    if (!cause) return undefined
    if (cause._tag === "Permission.BlockedError") return "permission_denied"
    if (cause._tag === "Permission.CorrectedError" || cause._tag === "Permission.DeclinedError") return "rejected"
    error = cause.error
  }
  return undefined
}

/** Metadata travels with each part, including history and independently loaded SDK copies. */
export function preserveNativeToolResults(
  messages: readonly unknown[] | undefined, refusals: ReadonlyMap<string, ToolRefusal> = new Map(),
): any[] {
  if (!Array.isArray(messages)) return []
  return messages.map(message => {
    const msg = record(message)
    if (msg?.role !== "tool" || !Array.isArray(msg.content)) return message
    return { ...msg, content: msg.content.map(item => {
      const part = record(item)
      const result = record(part?.result)
      if (part?.type !== "tool-result" || typeof part.id !== "string" || !result
        || typeof result.type !== "string" || !["error", "text", "json", "content"].includes(result.type)) return item
      const metadata = record(part.providerMetadata)
      const cursor = record(metadata?.cursor)
      const status = result.type === "error"
        ? { callID: part.id, status: "error", failure: nativeToolFailure(result.value, refusals.get(part.id)) }
        : { callID: part.id, status: "completed" }
      return { ...part, providerMetadata: { ...metadata, cursor: { ...cursor, [TOOL_RESULT_STATUS_KEY]: status } } }
    }) }
  })
}

export function toolResultFailure(options: unknown, callID: string): NativeToolFailure | undefined {
  const status = record(record(record(options)?.cursor)?.[TOOL_RESULT_STATUS_KEY])
  if (status?.callID !== callID || status.status !== "error") return undefined
  const failure = record(status.failure)
  if (!failure || typeof failure.type !== "string" || typeof failure.text !== "string") return undefined
  const refusal = failure.refusal === "permission_denied" || failure.refusal === "rejected" ? failure.refusal : undefined
  return { type: failure.type, text: failure.text || `OpenCode tool failed (${failure.type || "tool.execution"})`,
    ...(refusal ? { refusal } : {}) }
}
