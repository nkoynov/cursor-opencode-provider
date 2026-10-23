import path from "node:path"
import { executeCursorImageSave, IMAGE_PERMISSION_DENIED_PREFIX } from "../image-save.js"
import { cursorImageSaveTool } from "../image-save-tool.js"
import { CURSOR_IMAGE_SAVE_TOOL } from "../protocol/generate-image.js"
import { getSessionDirectory } from "../session-directory.js"
import { hostHasTool, OPENCODE2_DIRECT_TOOL_OPTIONS } from "./todo-tools.js"
import { assertToolPermission } from "./permissions.js"
import type { PluginContext, ToolDraft, ToolExecutionContext } from "./types.js"

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
 * catalog. Catalog permission filtering cannot enforce path-specific rules;
 * permission.assert checks the actual target with the executing agent/session.
 */
export function registerCursorImageSaveTool(draft: ToolDraft, ctx: PluginContext): void {
  if (hostHasTool(draft, CURSOR_IMAGE_SAVE_TOOL)) return

  draft.add({
    name: CURSOR_IMAGE_SAVE_TOOL,
    description: cursorImageSaveTool.description,
    input: IMAGE_SAVE_INPUT_SCHEMA,
    output: IMAGE_SAVE_OUTPUT_SCHEMA,
    options: { ...OPENCODE2_DIRECT_TOOL_OPTIONS, permission: "edit" },
    execute: async (input: { image_id?: unknown }, context: ToolExecutionContext) => {
      const sessionID = context.sessionID
      if (typeof sessionID !== "string" || !sessionID) {
        throw new Error("OpenCode 2.0 image-save context did not provide a sessionID")
      }
      const directory = await workspaceForSession(ctx, sessionID)
      const assertPermission = ctx.permission?.assert
      const fallbackAsk = toolAsk(context)
      if (!assertPermission && !fallbackAsk) {
        throw new Error(`${IMAGE_PERMISSION_DENIED_PREFIX} This host did not provide a permission assertion for the write.`)
      }
      let permissionFailure: { error: unknown } | undefined
      const ask: NonNullable<ReturnType<typeof toolAsk>> = assertPermission
        ? async request => {
            try {
              // Native file resources are relative inside the workspace and
              // absolute outside it. The shared saver supplies relative edit
              // patterns plus the resolved target as metadata.filepath.
              const resources = request.patterns.map(pattern => request.permission === "edit"
                && (pattern === ".." || pattern.startsWith(`..${path.sep}`) || path.isAbsolute(pattern))
                && typeof request.metadata.filepath === "string"
                ? request.metadata.filepath.replaceAll("\\", "/")
                : pattern.replaceAll("\\", "/"))
              await assertToolPermission(ctx, context, {
                action: request.permission,
                resources,
                save: request.always,
                metadata: request.metadata,
              })
            } catch (error) {
              // A plain native rejection ends the host step. Preserve the
              // original error across the shared saver's classic error wrapper.
              permissionFailure = { error }
              throw error
            }
          }
        : fallbackAsk!
      const result = await executeCursorImageSave(
        { image_id: input?.image_id },
        {
          worktree: directory,
          directory,
          ask,
        },
      ).catch(error => {
        if (permissionFailure) throw permissionFailure.error
        throw error
      })
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
