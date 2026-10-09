import { execFile } from "node:child_process"
import { promisify } from "node:util"
import path from "node:path"
import { errorMessage, trace } from "../debug.js"

const execFileAsync = promisify(execFile)
const GIT_TIMEOUT_MS = 5_000

/** Trimmed stdout, or `undefined` when git failed or timed out. */
async function git(cwd: string, args: string[]): Promise<string | undefined> {
  const started = Date.now()
  try {
    const { stdout } = await execFileAsync("git", args, { cwd, encoding: "utf-8", timeout: GIT_TIMEOUT_MS })
    return stdout.trim()
  } catch (error) {
    const killed = (error as { killed?: boolean }).killed === true
    trace(
      `git: \`${args.join(" ")}\` ${killed ? `timed out after ${GIT_TIMEOUT_MS}ms` : "failed"} ` +
        `elapsedMs=${Date.now() - started}${killed ? "" : `: ${errorMessage(error).split("\n")[0]}`}`,
    )
    return undefined
  }
}

export type RepoInfo = {
  relative_workspace_path: string
  remote_urls: string[]
  remote_names: string[]
  repo_name: string
  repo_owner: string
  is_tracked: boolean
  is_local: boolean
  workspace_uri: string
}

export type GitRepoInfo = {
  path: string
  status: string
  branch_name: string
  remote_url?: string
}

export type GitFacts = {
  repositoryInfo: RepoInfo[]
  gitRepos: GitRepoInfo[]
  /** False when `git status` failed or timed out, so the status is not the real one. */
  statusComplete: boolean
}

export async function collectGit(workspaceRoot: string): Promise<GitFacts> {
  const started = Date.now()
  const root = await git(workspaceRoot, ["rev-parse", "--show-toplevel"])
  if (!root) return { repositoryInfo: [], gitRepos: [], statusComplete: true }

  const remotesRaw = (await git(root, ["remote", "-v"])) ?? ""
  const remote_urls: string[] = []
  const remote_names: string[] = []
  for (const line of remotesRaw.split("\n")) {
    const m = line.match(/^(\S+)\s+(\S+)\s+\(fetch\)/)
    if (!m) continue
    remote_names.push(m[1]!)
    remote_urls.push(m[2]!)
  }
  const primary = remote_urls[0] ?? ""
  let repo_owner = ""
  let repo_name = path.basename(root)
  const gh = primary.match(/[:/]([^/]+)\/([^/]+?)(?:\.git)?$/)
  if (gh) {
    repo_owner = gh[1]!
    repo_name = gh[2]!
  }

  const branch = (await git(root, ["rev-parse", "--abbrev-ref", "HEAD"])) || "HEAD"
  const statusStarted = Date.now()
  const status = await git(root, ["status", "--porcelain", "-b"])
  trace(`git: discovery elapsedMs=${Date.now() - started} statusMs=${Date.now() - statusStarted} statusComplete=${status !== undefined}`)

  const repositoryInfo: RepoInfo[] = [
    {
      relative_workspace_path: ".",
      remote_urls,
      remote_names,
      repo_name,
      repo_owner,
      is_tracked: remote_urls.length > 0,
      is_local: remote_urls.length === 0,
      workspace_uri: `file://${root}`,
    },
  ]

  const gitRepos: GitRepoInfo[] = [
    {
      path: root,
      status: (status ?? "").slice(0, 4000),
      branch_name: branch,
      ...(primary ? { remote_url: primary } : {}),
    },
  ]

  return { repositoryInfo, gitRepos, statusComplete: status !== undefined }
}
