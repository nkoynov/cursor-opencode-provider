/**
 * Structural host-skills capability installed before an unchanged provider loads.
 * Same install timing as `opencode.host.path-bridge`.
 */

export const HOST_SKILLS_BRIDGE = Symbol.for("opencode.host.skills")

/** One host catalog skill the provider may advertise to Cursor. */
export type HostSkill = {
  name: string
  id?: string
  description: string
  /** Absolute path, `file:` URL, or host URI (`skill://…`). Omit built-ins / markers. */
  location?: string
}

export type OpenCodeSkillsBridge = {
  list(input: { directory: string; sessionID?: string }): Promise<HostSkill[]>
}

export function skillsBridge(): OpenCodeSkillsBridge | undefined {
  const value = (globalThis as Record<PropertyKey, unknown>)[HOST_SKILLS_BRIDGE]
  if (!value || typeof value !== "object") return undefined
  const bridge = value as Partial<OpenCodeSkillsBridge>
  return typeof bridge.list === "function" ? bridge as OpenCodeSkillsBridge : undefined
}

/** Test helper: install or clear the structural skills bridge. */
export function setHostSkillsBridgeForTests(bridge: OpenCodeSkillsBridge | undefined): void {
  const globals = globalThis as Record<PropertyKey, unknown>
  if (bridge) globals[HOST_SKILLS_BRIDGE] = bridge
  else delete globals[HOST_SKILLS_BRIDGE]
}
