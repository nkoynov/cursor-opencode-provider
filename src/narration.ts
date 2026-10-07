import { isAssistantMessageBlob } from "./model-fallback.js"

// Claude Opus 5.5 returns the prose it writes between tool calls as a
// progress-update thinking block (at most one before each tool call), and
// Cursor streams it as `thinking_delta` like the model's reasoning. Only the
// block's signature, which reaches the client in the step's stored assistant
// message after the step's tool results, says which kind a block was.

const streamedThinkingKinds = new WeakMap<object, string[]>()

/** Records how a streamed thinking block was shown (`R` reasoning, `N` text), for the debug log. */
export function noteThinkingKind(session: object, kind: "R" | "N"): void {
  const kinds = streamedThinkingKinds.get(session) ?? []
  kinds.push(kind)
  streamedThinkingKinds.set(session, kinds)
}

/** The kinds recorded since the last call, which Cursor's next stored assistant message should match. */
export function takeThinkingKinds(session: object): string[] {
  const kinds = streamedThinkingKinds.get(session) ?? []
  streamedThinkingKinds.delete(session)
  return kinds
}

/** Whether an Anthropic thinking signature marks a progress-update ("narration") block. */
export function isNarrationSignature(signature: string): boolean {
  if (!signature) return false
  const bytes = Buffer.from(signature, "base64")
  return bytes.subarray(0, 96).includes("narration")
}

/**
 * The block kinds of an assistant-message KV blob, in order: `R` reasoning,
 * `N` narration, `T` text, `C` tool call. Undefined for other blobs.
 */
export function assistantBlobShape(data: Uint8Array): string[] | undefined {
  if (!isAssistantMessageBlob(data)) return undefined
  let message: { content?: unknown }
  try {
    message = JSON.parse(Buffer.from(data.buffer, data.byteOffset, data.length).toString("utf8"))
  } catch {
    return undefined
  }
  const shape: string[] = []
  for (const part of Array.isArray(message.content) ? message.content : []) {
    const p = part as { type?: unknown; signature?: unknown }
    if (p?.type === "reasoning") {
      shape.push(typeof p.signature === "string" && isNarrationSignature(p.signature) ? "N" : "R")
    } else if (p?.type === "text") {
      shape.push("T")
    } else if (p?.type === "tool-call") {
      shape.push("C")
    }
  }
  return shape
}
