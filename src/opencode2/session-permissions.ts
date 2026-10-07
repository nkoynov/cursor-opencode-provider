import type { PermissionRule } from "./types.js"

// OpenCode's Wildcard.match for an action name.
function matchesAction(action: string, pattern: string): boolean {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".")
  return new RegExp(`^${escaped}$`, "s").test(action)
}

/**
 * OpenCode checks a session's own rules after its agent's and the last match decides, so a session
 * rule denying `edit` everywhere outlasts any agent switch (a client's plan mode, for example).
 */
export function sessionRulesDenyEdits(rules: readonly PermissionRule[] | undefined): boolean {
  const last = [...(rules ?? [])].reverse().find((rule) => rule.resource === "*" && matchesAction("edit", rule.action))
  return last?.effect === "deny"
}
