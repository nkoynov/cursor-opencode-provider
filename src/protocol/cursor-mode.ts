/**
 * Cursor unified-mode ids and the OpenCode primary agents that serve them.
 *
 * Cursor CLI's SwitchMode handler sends `chat`, `ask` and `search` to its
 * read-only Ask mode, and derives `UserMessage.mode` (`agent.v1.AgentMode`)
 * from the current mode: plan, Ask and debug are their own wire modes; every
 * other mode (agent, spec, triage, …) runs as agent. This provider serves
 * `plan` and `spec` with the host plan agent and every implementing mode with
 * the host build agent; a read-only mode keeps the current agent.
 */

export type CursorModeRole = "plan" | "read-only" | "implement"

/** Which Cursor CLI-shaped reminder describes the mode. */
export type CursorModeGuidance =
  | "plan"
  | "ask"
  | "debug"
  | "multitask"
  | "triage"
  | "project"
  | "background"
  | "agent"

/** OpenCode primary agent a Cursor mode selects, on both host generations. */
export type HostPrimaryAgent = "plan" | "build"

export const HOST_PLAN_AGENT = "plan"

export type CursorModeSpec = {
  role: CursorModeRole
  /** `agent.v1.AgentMode`. */
  wire: number
  guidance: CursorModeGuidance
}

const AGENT_MODE = { agent: 1, ask: 2, plan: 3, debug: 4 } as const

const ASK: CursorModeSpec = { role: "read-only", wire: AGENT_MODE.ask, guidance: "ask" }
/** agent, build, edit and unknown ids: implementation mode. */
const IMPLEMENT: CursorModeSpec = { role: "implement", wire: AGENT_MODE.agent, guidance: "agent" }

const MODES = new Map<string, CursorModeSpec>([
  ["plan", { role: "plan", wire: AGENT_MODE.plan, guidance: "plan" }],
  ["spec", { role: "plan", wire: AGENT_MODE.agent, guidance: "plan" }],
  ["chat", ASK],
  ["ask", ASK],
  ["search", ASK],
  ["debug", { role: "implement", wire: AGENT_MODE.debug, guidance: "debug" }],
  ["multitask", { ...IMPLEMENT, guidance: "multitask" }],
  ["triage", { ...IMPLEMENT, guidance: "triage" }],
  ["project", { ...IMPLEMENT, guidance: "project" }],
  ["background", { ...IMPLEMENT, guidance: "background" }],
])

/** Normalize Cursor mode ids for comparison. */
export function normalizeCursorModeId(modeId: string | undefined): string {
  return (modeId ?? "").trim().toLowerCase()
}

/** undefined only for an empty id. */
export function cursorModeSpec(modeId: string | undefined): CursorModeSpec | undefined {
  const id = normalizeCursorModeId(modeId)
  return id ? MODES.get(id) ?? IMPLEMENT : undefined
}

export function cursorModeRole(modeId: string | undefined): CursorModeRole | undefined {
  return cursorModeSpec(modeId)?.role
}

/** A read-only mode selects no primary agent. */
export function hostAgentForCursorMode(modeId: string | undefined): HostPrimaryAgent | undefined {
  const role = cursorModeRole(modeId)
  return role === "plan" ? HOST_PLAN_AGENT : role === "implement" ? "build" : undefined
}

/** `UserMessage.mode` for a Cursor mode id; no recorded mode runs as agent. */
export function cursorAgentModeWireValue(modeId: string | undefined): number {
  return cursorModeSpec(modeId)?.wire ?? AGENT_MODE.agent
}

export function isHostPlanAgent(agent: string | undefined): boolean {
  return agent === HOST_PLAN_AGENT
}
