import type { CursorSession } from "../src/session.js"

/** Fields `SessionManager.registerSession` initializes on a new Run. */
type ManagedSessionKeys =
  | "closed"
  | "closeError"
  | "pumpOwner"
  | "heartbeatCancel"
  | "hardDeadlineTimer"
  | "semanticDeadlineCancel"
  | "terminalUnsubscribe"
  | "deferredTerminalReason"
  | "policy"
  | "createdAt"
  | "lastInboundAt"
  | "lastHeartbeatWriteAt"
  | "semanticDeadlineAt"

/** A Run as tests build it before registration: everything except the managed fields. */
export type CursorSessionFixture =
  Omit<CursorSession, ManagedSessionKeys> & Partial<Pick<CursorSession, ManagedSessionKeys>>

/**
 * Type a test Run. The managed fields stay unset until `registerSession`
 * fills them, exactly as for a Run the provider opens.
 */
export function sessionFixture(init: CursorSessionFixture): CursorSession {
  return init as CursorSession
}
