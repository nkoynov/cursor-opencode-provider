import { encodeMessage, getMessageTypes } from "./messages.js"
import type { OpencodeToolDef } from "./tools.js"
import type { CursorImageInput } from "../image-input.js"

export type SeedHistoryMessage = {
  role: "system" | "user" | "assistant"
  content: string
  /** A user message with no reply after it; OpenCode records a steer the model answered early after that answer. */
  unanswered?: boolean
}

export type RunRequestInput = {
  text: string
  images?: CursorImageInput[]
  modelId: string
  conversationId: string
  /** Stable parent group; unlike conversationId, this survives compaction/rebase. */
  conversationGroupId?: string
  /**
   * Prior chat turns for a Run without a checkpoint, carried in the live user
   * text (see {@link seedHistoryUserText}). Tool outputs, when required for
   * compaction/recovery, are represented as user-role OpenCode host
   * observations rather than assistant-authored prose.
   */
  history?: SeedHistoryMessage[]
  /**
   * Opaque ConversationStateStructure bytes from the last
   * conversation_checkpoint_update for this conversation_id. When set, echoed
   * as AgentRunRequest.conversation_state (CLI parity). When absent, an empty
   * seed state is sent and `history` travels in the user text.
   */
  conversationState?: Uint8Array
  parameterValues?: Array<{ id: string; value: string }>
  maxMode?: boolean
  messageId?: string
  tools?: OpencodeToolDef[]
  /** Pre-resolved descriptors (including config-backed MCP server identity). */
  toolDescriptors?: Array<Record<string, unknown>>
  /** Prebuilt RequestContext (OpenCode-sourced). */
  requestContext?: Record<string, unknown>
  /** Resume the supplied checkpoint instead of submitting another user turn. */
  action?: "user" | "resume"
  /**
   * Cursor mode of this user turn (`UserMessage.mode`, an `agent.v1.AgentMode`
   * value). Cursor CLI sends its current mode on every user message.
   */
  mode?: number
}

/**
 * Empty ConversationStateStructure for a Run without a checkpoint (turn 1,
 * compaction, rebase, reseed). After the first checkpoint arrives we stop
 * inventing state and echo the server's opaque structure instead (CLI behavior).
 *
 * Nothing goes in `root_prompt_messages_json` (#1). Neither Cursor client
 * writes it: Cursor checkpoints fill it with references to the conversation's
 * own rendered root prompt. A client-written entry stands in for that prompt,
 * so Cursor stops rendering RequestContext rules, skills and subagents — the
 * host system-instructions rule included. Verified live 2026-10-09
 * (claude-sonnet-5-5): two seeded history messages there gave checkpoint
 * categories `rules:0, subagents:0` and a reply that ignored the rule; the same
 * history in the user text kept both. History therefore travels in the user
 * text ({@link seedHistoryUserText}).
 *
 * We deliberately do NOT use `AgentRunRequest.custom_system_prompt` (#8): that
 * field is the internal `--system-prompt` CLI override and the server rejects
 * it for normal accounts.
 */
export function buildSeedConversationState(): Uint8Array {
  const type = getMessageTypes().lookupType("ConversationStateStructure")
  return type.encode(type.fromObject({})).finish()
}

const SEED_HISTORY_TAGS = /<\/(conversation_history|user|assistant)>/gi
const HISTORY_PREAMBLE =
  "Cursor's copy of this conversation was lost, so the host replays it here. It is the real conversation " +
  "between you and the user so far: the tool calls listed were run and returned the results shown " +
  "(a call or result that says so was shortened to fit). Continue from it and do not redo work it shows as done."
const NO_REPLY_PREAMBLE =
  "A user message marked unanswered=\"true\" has no answer after it: if what you wrote before it already answers it, " +
  "it reached you while you were still working, so do not answer it again."

/**
 * Prior turns of a Run without a checkpoint, as a transcript block. `system`
 * entries are dropped: host system context travels as the system-instructions
 * rule in RequestContext. Closing tags inside a message are escaped so a
 * message cannot end its own block early.
 */
export function renderHistoryTranscript(history: readonly SeedHistoryMessage[] | undefined): string | undefined {
  const entries = (history ?? []).filter((entry) => entry.content && entry.role !== "system")
  if (entries.length === 0) return undefined
  const transcript = entries
    .map((entry) => {
      const open = entry.role === "user" && entry.unanswered ? `<user unanswered="true">` : `<${entry.role}>`
      return `${open}\n${entry.content.replace(SEED_HISTORY_TAGS, "<\\/$1>")}\n</${entry.role}>`
    })
    .join("\n\n")
  const preamble = entries.some((entry) => entry.unanswered)
    ? `${HISTORY_PREAMBLE} ${NO_REPLY_PREAMBLE}`
    : HISTORY_PREAMBLE
  return `<conversation_history>\n${preamble}\n\n${transcript}\n</conversation_history>`
}

/** The live user text of a Run without a checkpoint, after its history transcript. */
export function seedHistoryUserText(
  text: string,
  history: readonly SeedHistoryMessage[] | undefined,
): string {
  const transcript = renderHistoryTranscript(history)
  return transcript ? `${transcript}\n\n${text}` : text
}

/**
 * Build an AgentClientMessage{run_request} for a conversation turn.
 *
 * Live `user_message.text` is the current prompt only — same as Cursor CLI.
 * Cross-turn history is the last server checkpoint re-sent as conversation_state.
 */
export function buildRunRequest(input: RunRequestInput): Uint8Array {
  const msgId = input.messageId ?? crypto.randomUUID()

  // Advertise host tools on UserMessageAction.request_context (#2) via slim
  // mcp_meta_tool_options. AgentRunRequest.mcp_tools (#4) stays empty on real
  // turns (CLI prewarm-only). Full defs are session.toolDescriptors + exec #36.
  const requestContext = input.requestContext
  const seeded = !(input.conversationState && input.conversationState.length > 0)
  const userMessage: Record<string, unknown> = {
    text: seeded && input.action !== "resume" ? seedHistoryUserText(input.text, input.history) : input.text,
    message_id: msgId,
  }
  if (input.mode !== undefined) userMessage.mode = input.mode
  if (input.images?.length) {
    userMessage.selected_context = {
      selected_images: input.images.map((image) => ({
        data: image.data,
        uuid: crypto.randomUUID(),
        path: image.filename,
        mime_type: image.mimeType,
      })),
    }
  }
  const userMessageAction: Record<string, unknown> = { user_message: userMessage }
  if (requestContext) userMessageAction.request_context = requestContext
  const action = input.action === "resume"
    ? { resume_action: {} }
    : { user_message_action: userMessageAction }

  const conversationState = seeded
    ? buildSeedConversationState()
    : input.conversationState!

  const runRequest: Record<string, unknown> = {
    conversation_id: input.conversationId,
    conversation_group_id: input.conversationGroupId ?? input.conversationId,
    run_id: msgId,
    action,
    requested_model: {
      // The provider always selects a concrete model. Cursor's "default"
      // pseudo-model (Auto) is never used here — we send the real id plus the
      // chosen variant's parameter values.
      model_id: input.modelId,
      max_mode: input.maxMode ?? false,
      parameters: input.parameterValues ?? [],
    },
    conversation_state: conversationState,
    mcp_tools: { mcp_tools: [] },
    unknown_flag: 0,
    field_12: 0,
  }

  return encodeMessage("AgentClientMessage", {
    run_request: runRequest,
  })
}

/**
 * Build a heartbeat message.
 */
export function buildHeartbeat(): Uint8Array {
  return encodeMessage("AgentClientMessage", {
    client_heartbeat: {},
  })
}

/** Exec control heartbeat for an exec still running, which Cursor CLI sends every 3 s. */
export function buildExecHeartbeat(execId: number): Uint8Array {
  return encodeMessage("AgentClientMessage", {
    exec_client_control_message: { heartbeat: { id: execId } },
  })
}

/** Stops the live Run, as Cursor CLI does on a user Stop before it closes the stream. */
export function buildCancelAction(reason: string): Uint8Array {
  return encodeMessage("AgentClientMessage", {
    conversation_action: { cancel_action: { reason } },
  })
}
