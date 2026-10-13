/**
 * `openCodeSessionId` undefined: every session (the host is shutting down).
 * `at`: when the host stopped, on this process's clock.
 */
export type HostInterruptListener = (
  openCodeSessionId: string | undefined,
  reason: string,
  at: number,
) => void | Promise<void>

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

/**
 * The host stopped this session's execution (OpenCode 2 never aborts `doStream`
 * for it). `reason: "shutdown"` keeps the turn for the next server start: its
 * state is saved, nothing is cancelled. Resolves once every listener settled.
 */
export async function notifyHostInterrupt(
  openCodeSessionId: string | undefined,
  reason: string,
  at = Date.now(),
): Promise<void> {
  await Promise.allSettled([...listeners].map(async (listener) => listener(openCodeSessionId, reason, at)))
}
