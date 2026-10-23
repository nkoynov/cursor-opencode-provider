import { encodeMessage } from "./messages.js"

/**
 * Answer exec #44 without running Git. GetDiffResponse has no error oneof —
 * failures use exec_client_control_message.throw, matching Cursor CLI `class Dc`.
 */
function throwAndClose(execId: number, error: string): Uint8Array[] {
  return [
    encodeMessage("AgentClientMessage", {
      exec_client_control_message: {
        throw: { id: execId, error },
      },
    }),
    encodeMessage("AgentClientMessage", {
      exec_client_control_message: {
        stream_close: { id: execId },
      },
    }),
  ]
}

/** Private exec #44 has no native permission seam; use the advertised shell executor instead. */
export function buildGitDiffUnavailableMessages(execId: number, reason?: string): Uint8Array[] {
  return throwAndClose(execId, reason ?? "git_diff requires native host permission checks. "
    + "Use the advertised shell tool to run git diff; do not retry this private exec.")
}
