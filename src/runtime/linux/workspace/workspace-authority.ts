/** R2 PR-9：Workspace Authority（INV-B 宿主目录权威）。
 *
 *  模型只能声明相对逻辑目录；最终宿主路径必须经过：
 *
 *    requestedRelativeCwd
 *    → Runtime AuthorizedWorkspace
 *    → canonical resolve
 *    → containment check
 *    → backend host cwd / mount
 *
 *  register* 拒绝：根目录、真实 HOME、凭证目录（.ssh/.gnupg/.aws/.kube）、
 *  容器 socket 目录、不存在的目录。workspaceId 由 canonical root 稳定生成
 *  （同一物理目录 = 同一锁身份）。
 */

import { createHash } from "node:crypto"
import { dirname, isAbsolute, join, normalize, resolve, sep } from "node:path"
import { existsSync, realpathSync } from "node:fs"
import { homedir } from "node:os"
import type { AuthorizedWorkspace } from "../contracts"
import { LinuxExecutionError } from "../errors"

/** 凭证/敏感路径段（任意层级命中即拒绝注册）。 */
const FORBIDDEN_SEGMENTS = [
  ".ssh", ".gnupg", ".aws", ".kube", ".config/gcloud", ".config/git",
]

/** 容器 socket / 运行时路径段。 */
const FORBIDDEN_ROOT_PREFIXES = [
  "/run/podman", "/run/systemd", "/run/user", "/var/run/docker.sock",
]

function canonicalHostRoot(hostRoot: string): string {
  if (!existsSync(hostRoot)) {
    throw new LinuxExecutionError("WORKSPACE_NOT_AUTHORIZED", `workspace root missing: ${hostRoot}`)
  }
  let real: string
  try {
    real = realpathSync(hostRoot)
  } catch {
    throw new LinuxExecutionError("WORKSPACE_NOT_AUTHORIZED", `workspace root not resolvable: ${hostRoot}`)
  }
  if (real === "/") {
    throw new LinuxExecutionError("WORKSPACE_NOT_AUTHORIZED", "workspace root must not be /")
  }
  const home = homedir()
  if (home && real === resolve(home)) {
    throw new LinuxExecutionError("WORKSPACE_NOT_AUTHORIZED", "workspace root must not be the real HOME directory")
  }
  const segments = normalize(real).split(sep).filter(Boolean)
  const path = (p: string): string => p.replace(/\/+/g, "/")
  for (const seg of FORBIDDEN_SEGMENTS) {
    if (path(`/${segments.join("/")}`).split(seg).length > 1) {
      const depth = seg.split("/").length
      for (let i = 0; i <= segments.length - depth; i++) {
        if (segments.slice(i, i + depth).join("/") === seg) {
          throw new LinuxExecutionError("WORKSPACE_NOT_AUTHORIZED", `workspace root contains credential path segment: ${seg}`)
        }
      }
    }
  }
  for (const prefix of FORBIDDEN_ROOT_PREFIXES) {
    if (real === prefix || real.startsWith(prefix + sep)) {
      throw new LinuxExecutionError("WORKSPACE_NOT_AUTHORIZED", `workspace root is a forbidden runtime path: ${real}`)
    }
  }
  return real
}

function workspaceIdOf(projectId: string, hostRoot: string, kind: AuthorizedWorkspace["kind"]): string {
  const digest = createHash("sha256")
    .update(JSON.stringify({ projectId, hostRoot, kind }))
    .digest("hex")
    .slice(0, 16)
  return `ws_${digest}`
}

export interface RegisterWorkspaceInput {
  projectId: string
  hostRoot: string
  kind?: AuthorizedWorkspace["kind"]
  access: AuthorizedWorkspace["access"]
  ownerFiles?: readonly string[]
}

/** R2 PR-9：Workspace Registry —— 唯一受信工作区来源。 */
export class WorkspaceAuthorityRegistry {
  private readonly workspaces = new Map<string, AuthorizedWorkspace>()

  registerMainWorkspace(input: RegisterWorkspaceInput): AuthorizedWorkspace {
    return this.register({ ...input, kind: "main" })
  }

  registerAgentWorktree(input: RegisterWorkspaceInput): AuthorizedWorkspace {
    return this.register({ ...input, kind: "worktree" })
  }

  registerSystemWorkspace(input: RegisterWorkspaceInput): AuthorizedWorkspace {
    return this.register({ ...input, kind: "system" })
  }

  register(input: RegisterWorkspaceInput): AuthorizedWorkspace {
    const hostRoot = canonicalHostRoot(input.hostRoot)
    const kind = input.kind ?? "system"
    const workspaceId = workspaceIdOf(input.projectId, hostRoot, kind)
    const workspace: AuthorizedWorkspace = {
      workspaceId,
      projectId: input.projectId,
      hostRoot,
      kind,
      access: input.access,
      ownerFiles: [...(input.ownerFiles ?? [])],
    }
    this.workspaces.set(workspaceId, workspace)
    return workspace
  }

  get(workspaceId: string): AuthorizedWorkspace | undefined {
    return this.workspaces.get(workspaceId)
  }

  require(workspaceId: string): AuthorizedWorkspace {
    const workspace = this.workspaces.get(workspaceId)
    if (!workspace) {
      throw new LinuxExecutionError("WORKSPACE_NOT_AUTHORIZED", `workspace not authorized: ${workspaceId}`)
    }
    return workspace
  }

  /** 相对逻辑 cwd → canonical host cwd（INV-B 完整链）。
   *  拒绝绝对路径/空字节/父目录逃逸/符号链接逃逸/不存在目录。 */
  resolveCwd(workspace: AuthorizedWorkspace, requestedRelativeCwd?: string): string {
    const relative = requestedRelativeCwd ?? "."
    if (relative.includes("\0")) {
      throw new LinuxExecutionError("WORKSPACE_PATH_ESCAPE", "cwd contains NUL byte")
    }
    if (isAbsolute(relative)) {
      throw new LinuxExecutionError("WORKSPACE_PATH_ESCAPE", `cwd must be relative to workspace: ${relative}`)
    }
    if (relative.split(sep).includes("..")) {
      throw new LinuxExecutionError("WORKSPACE_PATH_ESCAPE", `cwd must stay inside workspace: ${relative}`)
    }
    const candidate = resolve(workspace.hostRoot, normalize(relative))
    if (candidate !== workspace.hostRoot && !candidate.startsWith(workspace.hostRoot + sep)) {
      throw new LinuxExecutionError("WORKSPACE_PATH_ESCAPE", `cwd escapes workspace: ${relative}`)
    }
    // 最近存在父目录 realpath（防符号链接逃逸）。
    let probe = candidate
    while (probe !== "/" && !existsSync(probe)) {
      probe = dirname(probe)
    }
    if (!existsSync(probe)) {
      throw new LinuxExecutionError("WORKSPACE_CWD_MISSING", `cwd missing: ${candidate}`)
    }
    let realProbe: string
    try {
      realProbe = realpathSync(probe)
    } catch {
      throw new LinuxExecutionError("WORKSPACE_CWD_MISSING", `cwd not resolvable: ${candidate}`)
    }
    if (realProbe !== workspace.hostRoot && !realProbe.startsWith(workspace.hostRoot + sep)) {
      throw new LinuxExecutionError("WORKSPACE_PATH_ESCAPE", `cwd escapes workspace via symlink: ${candidate}`)
    }
    const canonical = join(realProbe, candidate.slice(probe.length))
    if (!existsSync(canonical)) {
      throw new LinuxExecutionError("WORKSPACE_CWD_MISSING", `cwd missing: ${candidate}`)
    }
    return canonical
  }

  /** 只读工作区拒绝写语义（access 检查由编译器在授权挂载时执行）。 */
  verifyReadonly(workspace: AuthorizedWorkspace): void {
    if (workspace.access === "readonly") {
      throw new LinuxExecutionError("WORKSPACE_READONLY", `workspace ${workspace.workspaceId} is readonly`)
    }
  }

  verifyOwnerFiles(workspace: AuthorizedWorkspace, files: readonly string[]): void {
    for (const file of files) {
      if (!workspace.ownerFiles.includes(file)) {
        throw new LinuxExecutionError("WORKSPACE_OWNER_FILE_VIOLATION", `file not owned by workspace: ${file}`)
      }
    }
  }
}
