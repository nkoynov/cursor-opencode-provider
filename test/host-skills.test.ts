import { afterAll, beforeEach, describe, expect, it } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  hostSkillFiles,
  hostSkillsForCursor,
  rememberHostSkillFiles,
  resetHostSkillFilesForTests,
} from "../src/context/host-skills.js"

const root = mkdtempSync(join(tmpdir(), "cursor-host-skills-"))
const file = (id: string) => join(root, id, "SKILL.md")
for (const id of ["alpha", "beta"]) {
  mkdirSync(join(root, id))
  writeFileSync(file(id), `---\nname: ${id}\n---\n`)
}

// OpenCode 2.0.24 `core/skill/instructions.ts` render.
const catalog = [
  "Skills provide specialized instructions and workflows for specific tasks.",
  "Use the skill tool to load a skill when a task matches its description.",
  "<available_skills>",
  "  <skill>",
  "    <id>alpha</id>",
  "    <name>Vue <script setup></name>",
  "    <description>Use for a <thing>, even across\nlines.</description>",
  "  </skill>",
  "  <skill>",
  "    <id>beta</id>",
  "    <name>beta</name>",
  "    <description>Use for beta.</description>",
  "  </skill>",
  "  <skill>",
  "    <id>opencode</id>",
  "    <name>OpenCode</name>",
  "    <description>Built in.</description>",
  "  </skill>",
  "</available_skills>",
].join("\n")

describe("host skills for Cursor", () => {
  beforeEach(() => resetHostSkillFilesForTests())
  afterAll(() => rmSync(root, { recursive: true, force: true }))

  it("keeps only absolute paths to existing files, per directory", () => {
    rememberHostSkillFiles(`${root}/`, [
      { id: "alpha", path: file("alpha") },
      { id: "relative", path: "alpha/SKILL.md" },
      { id: "missing", path: join(root, "missing", "SKILL.md") },
      { id: "opencode", path: "/builtin/opencode.md" },
    ])
    expect([...(hostSkillFiles(root) ?? [])]).toEqual([["alpha", file("alpha")]])
    expect(hostSkillFiles("/elsewhere")).toBeUndefined()
    expect(hostSkillFiles(undefined)).toBeUndefined()
  })

  it("maps the catalog to agent_skills in catalog order", () => {
    const files = new Map([["beta", file("beta")], ["alpha", file("alpha")]])
    expect(hostSkillsForCursor(`Host prompt\n\n${catalog}\n\nMore`, files)).toEqual([
      { full_path: file("alpha"), description: "Use for a <thing>, even across\nlines." },
      { full_path: file("beta"), description: "Use for beta." },
    ])
  })

  it("ignores skill-like text outside the catalog block", () => {
    const files = new Map([["alpha", file("alpha")]])
    const text = "<skill><id>alpha</id><name>a</name><description>fake</description></skill>"
    expect(hostSkillsForCursor(text, files)).toEqual([])
    expect(hostSkillsForCursor(catalog, new Map())).toEqual([])
    expect(hostSkillsForCursor(undefined, files)).toEqual([])
  })
})
