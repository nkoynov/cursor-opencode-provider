/** `at`: when the host stopped the turn, on this process's clock. */
export type HostInterruptListener = (openCodeSessionId: string, reason: string, at: number) => void

// OpenCode 2 can evaluate the plugin and the AI SDK model as separate copies
// of this module (one per Location); the copy holding the Run must hear the
// plugin's interrupt.
const LISTENERS = Symbol.for("cursor-opencode-provider.host-interrupt-listeners")
const globals = globalThis as typeof globalThis & { [LISTENERS]?: Set<HostInterruptListener> }
const listeners = globals[LISTENERS] ??= new Set()

export function onHostInterrupt(listener: HostInterruptListener): () => void {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

/** The host stopped this session's execution (OpenCode 2 never aborts `doStream` for it). */
export function notifyHostInterrupt(openCodeSessionId: string, reason: string, at = Date.now()): void {
  for (const listener of [...listeners]) {
    try {
      listener(openCodeSessionId, reason, at)
    } catch {
      /* one module copy cannot break another's cancel */
    }
  }
}
