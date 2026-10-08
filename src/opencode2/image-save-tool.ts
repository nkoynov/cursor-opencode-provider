import { executeCursorImageSave } from "../image-save.js"
import { cursorImageSaveTool } from "../image-save-tool.js"
import { CURSOR_IMAGE_SAVE_TOOL } from "../protocol/generate-image.js"
import { getSessionDirectory } from "../session-directory.js"
import { hostHasTool, OPENCODE2_DIRECT_TOOL_OPTIONS } from "./todo-tools.js"
import type { PluginContext, ToolDraft } from "./types.js"

const IMAGE_SAVE_INPUT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    image_id: {
      type: "string",
      description: "Id of the pending Cursor-generated image to save",
    },
  },
  required: ["image_id"],
} as const

const IMAGE_SAVE_OUTPUT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    path: { type: "string" },
    bytes: { type: "number" },
    message: { type: "string" },
  },
  required: ["path", "bytes", "message"],
} as const

function toolAsk(context: unknown):
  | ((input: {
    permission: string
    patterns: string[]
    always: string[]
    metadata: Record<string, unknown>
  }) => Promise<void>)
  | undefined {
  if (!context || typeof context !== "object") return undefined
  const ask = (context as { ask?: unknown }).ask
  return typeof ask === "function"
    ? (ask as (input: {
      permission: string
      patterns: string[]
      always: string[]
      metadata: Record<string, unknown>
    }) => Promise<void>)
    : undefined
}

async function workspaceForSession(
  ctx: PluginContext,
  sessionID: string,
): Promise<string> {
  const marked = getSessionDirectory(sessionID)
  if (marked) return marked
  try {
    return (await ctx.session.get({ sessionID })).location.directory
  } catch {
    return ctx.location?.directory || process.cwd()
  }
}

/**
 * Register the handle-only image commit tool on the OpenCode 2.0 direct
 * catalog. Catalog `permission: "edit"` hides it when the host agent denies
 * edits. Per-call `ask` is used when the runtime context provides it;
 * otherwise containment still gates the write (opaque `image_id` only).
 */
export function registerCursorImageSaveTool(draft: ToolDraft, ctx: PluginContext): void {
  if (hostHasTool(draft, CURSOR_IMAGE_SAVE_TOOL)) return

  draft.add({
    name: CURSOR_IMAGE_SAVE_TOOL,
    description: cursorImageSaveTool.description,
    input: IMAGE_SAVE_INPUT_SCHEMA,
    output: IMAGE_SAVE_OUTPUT_SCHEMA,
    options: { ...OPENCODE2_DIRECT_TOOL_OPTIONS, permission: "edit" },
    execute: async (input: { image_id?: unknown }, context: { sessionID?: string }) => {
      const sessionID = context.sessionID
      if (typeof sessionID !== "string" || !sessionID) {
        throw new Error("OpenCode 2.0 image-save context did not provide a sessionID")
      }
      const directory = await workspaceForSession(ctx, sessionID)
      const result = await executeCursorImageSave(
        { image_id: input?.image_id },
        {
          worktree: directory,
          directory,
          // The public 2.0 ToolContext has no permission prompt; catalog
          // `permission: "edit"` and containment gate the write instead.
          ask: toolAsk(context) ?? null,
        },
      )
      return {
        output: {
          path: result.title,
          bytes: result.bytes,
          message: result.output,
        },
        content: result.output,
      }
    },
  })
}
