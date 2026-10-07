import { beforeEach, describe, it, expect } from "bun:test"
import type { LanguageModelV3CallOptions } from "@ai-sdk/provider"
import { createCursor } from "../src/index.js"
import {
  computeAllowTools,
  MAX_TURN_STATE_SESSIONS,
  notPermittedToolReason,
  resetTurnStateForTests,
  restoreTurnToolCatalog,
  resolveTurnConversationReset,
  resolveTurnToolState,
  textOnlyTurnText,
} from "../src/language-model.js"
import {
  bindConversationId,
  resetConversationBindingsForTests,
} from "../src/protocol/conversation-bind.js"
import { buildExecClientMessages } from "../src/protocol/tools.js"
import { decodeMessage } from "../src/protocol/messages.js"

describe("computeAllowTools", () => {
  it("is false when OpenCode advertises no tools (compaction/summary)", () => {
    expect(computeAllowTools(0, undefined)).toBe(false)
    expect(computeAllowTools(0, { type: "auto" })).toBe(false)
  })

  it("is false when toolChoice is none", () => {
    expect(computeAllowTools(3, { type: "none" })).toBe(false)
  })

  it("is true when tools are present and toolChoice allows them", () => {
    expect(computeAllowTools(1, undefined)).toBe(true)
    expect(computeAllowTools(2, { type: "auto" })).toBe(true)
    expect(computeAllowTools(1, { type: "required" })).toBe(true)
  })
})

describe("compaction tool catalog", () => {
  beforeEach(() => {
    resetTurnStateForTests()
    resetConversationBindingsForTests()
  })

  it("advertises the prior catalog during compaction but refuses execution", async () => {
    const tools = [{ name: "bash" }, { name: "grep" }]
    expect(await resolveTurnToolState({
      sessionKey: "ses_1",
      incomingTools: tools,
      isCompaction: false,
    })).toEqual({ advertisedTools: tools, allowTools: true })

    expect(await resolveTurnToolState({
      sessionKey: "ses_1",
      incomingTools: [],
      isCompaction: true,
    })).toEqual({ advertisedTools: tools, allowTools: false })
  })

  it("preserves a literal no-tool call when no session key can correlate a sibling", async () => {
    expect(await resolveTurnToolState({
      incomingTools: [],
      toolChoice: { type: "none" },
      isCompaction: false,
    })).toEqual({ advertisedTools: [], allowTools: false })
  })

  it("advertises the catalog to compaction only, not to a title or other zero-tool turn", async () => {
    // A title Run has a conversation of its own and never executes a tool; an
    // advertised catalog only makes the model try tools that are refused.
    const tools = [{ name: "read", inputSchema: { type: "object" } }]
    restoreTurnToolCatalog("ses_restored_catalog", tools)

    expect(await resolveTurnToolState({
      sessionKey: "ses_restored_catalog",
      incomingTools: [],
      isCompaction: false,
    })).toEqual({ advertisedTools: [], allowTools: false })
    expect(await resolveTurnToolState({
      sessionKey: "ses_restored_catalog",
      incomingTools: [],
      toolChoice: { type: "none" },
      isCompaction: false,
    })).toEqual({ advertisedTools: [], allowTools: false })
    expect(await resolveTurnToolState({
      sessionKey: "ses_restored_catalog",
      incomingTools: [],
      isCompaction: true,
    })).toEqual({ advertisedTools: tools, allowTools: false })
  })

  it("does not wait for a catalog on a cold-start title turn", async () => {
    expect(await resolveTurnToolState({
      sessionKey: "ses_cold_title",
      incomingTools: [],
      isCompaction: false,
    })).toEqual({ advertisedTools: [], allowTools: false })
  })

  it("waits indefinitely for a sibling catalog on cold-start compaction turns", async () => {
    // The production race exceeded one second. A timeout merely moves the race
    // threshold, so assert that the compaction call remains blocked well beyond
    // the old 100 ms cutoff and resolves only when the real catalog arrives.
    const tools = [{ name: "bash" }, { name: "read" }]
    const sessionKey = "ses_cold_start"
    let settled = false

    const lifecycle = resolveTurnToolState({
      sessionKey,
      incomingTools: [],
      isCompaction: true,
    }).then((state) => {
      settled = true
      return state
    })

    await new Promise((r) => setTimeout(r, 150))
    expect(settled).toBe(false)

    await resolveTurnToolState({
      sessionKey,
      incomingTools: tools,
      isCompaction: false,
    })

    expect(await lifecycle).toEqual({ advertisedTools: tools, allowTools: false })
  })

  it("cancels a catalog wait instead of sending tools=0", async () => {
    const abort = new AbortController()
    const lifecycle = resolveTurnToolState({
      sessionKey: "ses_cancelled",
      incomingTools: [],
      isCompaction: true,
      abortSignal: abort.signal,
    })

    abort.abort()
    await expect(lifecycle).rejects.toThrow("tool-catalog wait cancelled")
  })

  it("does not park OpenCode 2's stateless generate.text on a sibling catalog", async () => {
    // OpenCode 2 `generate.text`: one user message, no tools, no AbortSignal,
    // and only a freshly minted `x-opencode-session` header.
    const model = createCursor({
      name: "cursor",
      accessToken: "token",
      agentBaseURL: "https://not-cursor.example",
    }).languageModel("cursor-test")
    const call = model.doGenerate({
      prompt: [{ role: "user", content: [{ type: "text", text: "Pick the relevant memories." }] }],
      headers: { "x-opencode-session": "ses_generate_text_only" },
    } as LanguageModelV3CallOptions)
    const parked = new Promise<never>((_, reject) => {
      setTimeout(() => reject(new Error("generate.text is still waiting for a sibling tool catalog")), 10_000).unref?.()
    })

    // Reaching the agent-host check means the call went on to open its Run.
    await expect(Promise.race([call, parked])).rejects.toThrow("Invalid Cursor agent base URL override")
  }, 20_000)

  it("advertises every enabled tool in a fixed name order", async () => {
    expect(await resolveTurnToolState({
      sessionKey: "ses_order",
      incomingTools: [{ name: "write" }, { name: "bash" }, { name: "read" }],
      isCompaction: false,
    })).toEqual({
      advertisedTools: [{ name: "bash" }, { name: "read" }, { name: "write" }],
      allowTools: true,
    })
  })

  it("keeps epoch catalog when host shrinks tools (plan denies edit)", async () => {
    const full = [{ name: "bash" }, { name: "read" }, { name: "write" }]
    const planRestricted = [{ name: "read" }]
    await resolveTurnToolState({ sessionKey: "ses_restricted", incomingTools: full, isCompaction: false })

    // OpenCode plan filters edit tools out of the request catalog. Advertising
    // that shrink to Cursor would retokenize RequestContext — keep the epoch
    // catalog; allowTools still follows the current turn.
    expect(await resolveTurnToolState({
      sessionKey: "ses_restricted",
      incomingTools: planRestricted,
      isCompaction: false,
    })).toEqual({ advertisedTools: full, allowTools: true })
  })

  it("grows the epoch catalog when new tool names appear", async () => {
    await resolveTurnToolState({
      sessionKey: "ses_grow",
      incomingTools: [{ name: "read" }],
      isCompaction: false,
    })
    expect(await resolveTurnToolState({
      sessionKey: "ses_grow",
      incomingTools: [{ name: "bash" }, { name: "read" }],
      isCompaction: false,
    })).toEqual({
      advertisedTools: [{ name: "read" }, { name: "bash" }],
      allowTools: true,
    })
  })

  it("appends multiple new names in UTF-16 order at the tail", async () => {
    await resolveTurnToolState({
      sessionKey: "ses_append_batch",
      incomingTools: [{ name: "write" }],
      isCompaction: false,
    })
    expect(await resolveTurnToolState({
      sessionKey: "ses_append_batch",
      incomingTools: [{ name: "write" }, { name: "read" }, { name: "bash" }],
      isCompaction: false,
    })).toEqual({
      advertisedTools: [{ name: "write" }, { name: "bash" }, { name: "read" }],
      allowTools: true,
    })
  })

  it("holds first-catalog order when the host reshuffles the same names", async () => {
    const first = await resolveTurnToolState({
      sessionKey: "ses_reshuffle",
      incomingTools: [{ name: "write" }, { name: "bash" }, { name: "read" }],
      isCompaction: false,
    })
    expect(first.advertisedTools.map((tool) => tool.name)).toEqual(["bash", "read", "write"])
    expect(await resolveTurnToolState({
      sessionKey: "ses_reshuffle",
      incomingTools: [{ name: "read" }, { name: "write" }, { name: "bash" }],
      isCompaction: false,
    })).toEqual(first)
  })

  it("keeps frozen descriptors when the name set is unchanged", async () => {
    const original = [{ name: "read", description: "v1", inputSchema: { type: "object" } }]
    await resolveTurnToolState({
      sessionKey: "ses_same_names",
      incomingTools: original,
      isCompaction: false,
    })
    expect(await resolveTurnToolState({
      sessionKey: "ses_same_names",
      incomingTools: [{ name: "read", description: "v2", inputSchema: { type: "string" } }],
      isCompaction: false,
    })).toEqual({ advertisedTools: original, allowTools: true })
  })

  it("merges new names without rewriting existing descriptors", async () => {
    const original = [{ name: "read", description: "v1" }]
    await resolveTurnToolState({
      sessionKey: "ses_grow_hold",
      incomingTools: original,
      isCompaction: false,
    })
    expect(await resolveTurnToolState({
      sessionKey: "ses_grow_hold",
      incomingTools: [{ name: "bash", description: "shell" }, { name: "read", description: "v2" }],
      isCompaction: false,
    })).toEqual({
      advertisedTools: [{ name: "read", description: "v1" }, { name: "bash", description: "shell" }],
      allowTools: true,
    })
  })

  it("rebases after the summary checkpoint, restores execution, then stays stable", async () => {
    const sessionKey = "ses_transition"
    const tools = [{ name: "bash" }, { name: "grep" }]

    await resolveTurnToolState({ sessionKey, incomingTools: tools, isCompaction: false })
    const beforeCompaction = bindConversationId(sessionKey).conversationId

    const compactionReset = resolveTurnConversationReset({ sessionKey, isCompaction: true })
    const compacted = await resolveTurnToolState({
      sessionKey,
      incomingTools: [],
      isCompaction: true,
    })
    const afterCompaction = bindConversationId(sessionKey, compactionReset).conversationId
    expect(afterCompaction).not.toBe(beforeCompaction)
    expect(compactionReset).toEqual({ reset: true, reason: "compaction" })
    expect(compacted).toEqual({ advertisedTools: tools, allowTools: false })

    const resumedReset = resolveTurnConversationReset({ sessionKey, isCompaction: false })
    const resumed = await resolveTurnToolState({
      sessionKey,
      incomingTools: tools,
      isCompaction: false,
    })
    const afterRebase = bindConversationId(sessionKey, resumedReset).conversationId
    expect(resumedReset).toEqual({ reset: true, reason: "post-compaction-rebase" })
    expect(afterRebase).not.toBe(afterCompaction)
    expect(resumed).toEqual({ advertisedTools: tools, allowTools: true })

    expect(resolveTurnConversationReset({ sessionKey, isCompaction: false }))
      .toEqual({ reset: false })
    expect(bindConversationId(sessionKey).conversationId).toBe(afterRebase)
  })

  it("does not reset ordinary no-tool turns", () => {
    expect(resolveTurnConversationReset({ sessionKey: "ses_no_tools", isCompaction: false }))
      .toEqual({ reset: false })
  })

  it("rebases once when the host rewrites history without a model compaction turn", () => {
    const sessionKey = "ses_local_rewrite"
    const before = bindConversationId(sessionKey).conversationId
    const reset = resolveTurnConversationReset({ sessionKey, isCompaction: false, historyRewrite: true })
    expect(reset).toEqual({ reset: true, reason: "history-rewrite" })
    const after = bindConversationId(sessionKey, reset).conversationId
    expect(after).not.toBe(before)
    expect(resolveTurnConversationReset({ sessionKey, isCompaction: false }))
      .toEqual({ reset: false })
  })

  it("keeps sticky conversation across host agent or system prompt hash changes", () => {
    const sessionKey = "ses_prompt_identity"
    expect(resolveTurnConversationReset({
      sessionKey,
      isCompaction: false,
      promptIdentity: { hostAgent: "build", systemPromptHash: "prompt-a" },
    })).toEqual({ reset: false })
    // Title/generate lifecycle calls deliberately omit promptIdentity.
    expect(resolveTurnConversationReset({
      sessionKey,
      isCompaction: false,
    })).toEqual({ reset: false })
    expect(resolveTurnConversationReset({
      sessionKey,
      isCompaction: false,
      promptIdentity: { hostAgent: "build", systemPromptHash: "prompt-a" },
    })).toEqual({ reset: false })
    // Agent flip must not remint (CLI keeps agentId across mode changes).
    expect(resolveTurnConversationReset({
      sessionKey,
      isCompaction: false,
      promptIdentity: { hostAgent: "plan", systemPromptHash: "prompt-a" },
    })).toEqual({ reset: false })
    // Remint path ignores promptIdentity entirely (hash is frozen separately).
    expect(resolveTurnConversationReset({
      sessionKey,
      isCompaction: false,
      promptIdentity: { hostAgent: "plan", systemPromptHash: "prompt-b" },
    })).toEqual({ reset: false })
  })

  it("bounds cached tool catalogs and pending post-compaction rebases", async () => {
    await resolveTurnToolState({
      sessionKey: "oldest",
      incomingTools: [{ name: "read" }],
      isCompaction: false,
    })
    resolveTurnConversationReset({ sessionKey: "oldest", isCompaction: true })

    for (let i = 0; i < MAX_TURN_STATE_SESSIONS; i++) {
      const sessionKey = `new-${i}`
      await resolveTurnToolState({
        sessionKey,
        incomingTools: [{ name: "bash" }],
        isCompaction: false,
      })
      resolveTurnConversationReset({ sessionKey, isCompaction: true })
    }

    // The evicted session has no safe catalog. It must wait rather than emit an
    // empty one; cancellation tears down the wait without changing advertisement.
    const abort = new AbortController()
    const evicted = resolveTurnToolState({
      sessionKey: "oldest",
      incomingTools: [],
      isCompaction: true,
      abortSignal: abort.signal,
    })
    abort.abort()
    await expect(evicted).rejects.toThrow("tool-catalog wait cancelled")
    expect(resolveTurnConversationReset({ sessionKey: "oldest", isCompaction: false }))
      .toEqual({ reset: false })
  })
})

describe("textOnlyTurnText", () => {
  it("opens a text-only user turn with the host's task and keeps the message as its input", () => {
    expect(textOnlyTurnText("  You are a title generator.\n", "get my latest Slack message")).toBe(
      "You are a title generator.\n\n<input>\nget my latest Slack message\n</input>",
    )
  })

  it("leaves the message alone without a host system prompt", () => {
    expect(textOnlyTurnText(undefined, "hello")).toBe("hello")
    expect(textOnlyTurnText("  ", "hello")).toBe("hello")
  })
})

describe("refuse exec while tools disallowed", () => {
  it("builds a typed grep_result error + stream_close (compaction refuse path)", () => {
    const frames = buildExecClientMessages({
      execId: 1,
      resultField: "grep_result",
      output: "",
      error: "Tool calls are not available during this turn (summary/compaction).",
    })
    expect(frames.length).toBe(2)
    const acm = decodeMessage("AgentClientMessage", frames[0]) as Record<string, unknown>
    const ecm = acm.exec_client_message as Record<string, unknown>
    expect(ecm.id).toBe(1)
    const grep = ecm.grep_result as Record<string, unknown>
    expect(grep.error).toEqual({
      error: "Tool calls are not available during this turn (summary/compaction).",
    })
    const close = decodeMessage("AgentClientMessage", frames[1]) as Record<string, unknown>
    expect(close.exec_client_control_message).toEqual({ stream_close: { id: 1 } })
  })
})

describe("notPermittedToolReason", () => {
  it("points a tool left out of the direct list at Code Mode when execute is permitted", () => {
    const reason = notPermittedToolReason("linear_list_issues", new Set(["read", "execute"]))
    expect(reason).toContain("OpenCode tool 'linear_list_issues' is not in the direct tool list this turn")
    expect(reason).toContain("Permitted tools: execute, read.")
    expect(reason).toContain("`<namespace>_<tool>` appears there as `<namespace>.<tool>`")
    expect(reason).toContain("call it through OpenCode `execute` with the catalog's exact path")
    expect(reason).not.toContain("not permitted for the current agent")
  })

  it("keeps the plain refusal on hosts without Code Mode", () => {
    expect(notPermittedToolReason("edit", new Set(["read", "grep"]))).toBe(
      "OpenCode tool 'edit' is not permitted for the current agent this turn. "
        + "Permitted tools: grep, read. Continue using only permitted tools; do not retry 'edit'.",
    )
  })
})
