// OpenCode 2 and 1.x's newer session engine replay a failed tool as plain text holding exactly
// `{ error: { type, message }, content }`, the same output type as a completed tool's.
export type HostToolError = {
  type: string
  message: string
  content: string
}

export type HostToolRefusal = "permission_denied" | "rejected"

export function parseHostToolErrorEnvelope(output: string): HostToolError | undefined {
  if (!output.startsWith('{"error":{')) return undefined
  let envelope: unknown
  try {
    envelope = JSON.parse(output)
  } catch {
    return undefined
  }
  const { error, content, ...rest } = envelope as Record<string, unknown>
  if (Object.keys(rest).length > 0 || !Array.isArray(content) || JSON.stringify(envelope) !== output) return undefined
  // OpenCode's Session.StructuredError, in its field order.
  const { type, message, status, response, ...extra } = error as Record<string, unknown>
  if (typeof type !== "string" || typeof message !== "string" || Object.keys(extra).length > 0) return undefined
  if (Object.keys(error as object).slice(0, 2).join() !== "type,message") return undefined
  if (status !== undefined && !Number.isInteger(status)) return undefined
  if (response !== undefined) {
    const { body, ...responseExtra } = (response ?? {}) as Record<string, unknown>
    if (typeof body !== "string" || Object.keys(responseExtra).length > 0) return undefined
  }
  const text = content
    .map((item) => {
      const part = item as Record<string, unknown> | null
      return part?.type === "text" && typeof part.text === "string" ? part.text : ""
    })
    .filter(Boolean)
    .join("\n")
  return { type, message, content: text }
}

export function hostToolErrorText(error: HostToolError): string {
  // Encoders tell an error from a success by a non-empty error text.
  const message = error.message || `OpenCode tool failed (${error.type})`
  return error.content ? `${message}\n\n${error.content}` : message
}

export function isHostToolInterrupted(error: HostToolError): boolean {
  return error.type === "aborted"
    || error.type === "tool.interrupted"
    || error.message === "Tool execution interrupted"
    || error.message.startsWith("Tool execution interrupted: ")
}

// A configured deny rule fails with OpenCode's fixed `Permission denied: <action>`; other refusal text is the user's reason.
export function hostToolRefusal(error: HostToolError | undefined): HostToolRefusal | undefined {
  if (error?.type !== "permission.rejected") return undefined
  return /^Permission denied: \S+$/.test(error.message) ? "permission_denied" : "rejected"
}
