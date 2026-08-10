/** IC01: WorkspaceIoAuthority —— 统一工作区 I/O 权威。
 *
 *  production 下读取根 = TrustedExecutionAuthority.workspace.hostRoot（realpath
 *  物理根）——AgentRunScope 构造时从 authority 派生并绑定进 ALS 上下文。
 *
 *  不变式：
 *    - WORKSPACE_PATH_BASE_DRIFT = 0 —— ToolExecutionContext.projectRoot 与权威
 *      读取根不一致时 fail closed（同一物理目录的别名路径经 realpath 归一化后
 *      不算漂移）。
 *    - OUTSIDE_WORKSPACE_READ = 0 —— 解析结果（canonical target）必须在
 *      readRoot 之内。
 *    - SYMLINK_READ_ESCAPE = 0 —— 解析路径的 deepest realpath 不得离开 readRoot；
 *      open 后的 fd canonical 路径（/proc/self/fd）不得离开 readRoot
 *      （check/open race 由 IC01 在 open 侧闭环，完整 rename TOCTOU 由 IC14 覆盖）。
 *    - SECRET_READ = 0 —— .env/私钥/credentials 等拒绝读取；秘密判定对
 *      lexical 路径与 canonical target（realpath 后）各执行一次，workspace 内
 *      symlink alias 指向秘密文件同样拒绝；.env.example 允许；
 *      显式 secret grant 只能由 Runtime 提供（secretGrants 集合），绝不从
 *      Tool 参数接收（read_file 无 grant 参数）。
 *
 *  path 算法仍复用 tools/path-authority 的 resolveToolPath（唯一算法入口），
 *  本模块只做权威根/秘密文件策略，不新建第二套路径算法。
 */

import { realpathSync } from "node:fs"
import { readlink } from "node:fs/promises"
import { basename, resolve } from "node:path"
import type { TrustedExecutionAuthority } from "../linux/contracts"
import { deepestExistingRealpath, isWithin } from "../../tools/path-authority"

export type WorkspaceIoViolationCode =
  | "WORKSPACE_PATH_BASE_DRIFT"
  | "OUTSIDE_WORKSPACE_READ"
  | "SECRET_READ"
  | "SYMLINK_READ_ESCAPE"

export interface WorkspaceIoAuthority {
  /** 权威物理读取根（realpath 归一化）。 */
  readonly readRoot: string
  /** hostRoot 别名（与 readRoot 相同，语义显式化）。 */
  readonly hostRoot: string
  /** Runtime 显式 secret grant（完整解析路径集合）——绝不来自 Tool 参数。 */
  readonly secretGrants: ReadonlySet<string>
}

export interface WorkspaceIoViolation {
  code: WorkspaceIoViolationCode
  reason: string
}

export interface CreateWorkspaceIoAuthorityOptions {
  secretGrants?: readonly string[]
}

/** 构造权威（读取根做 realpath 归一化；根缺失时退回规范化绝对路径）。 */
export function createWorkspaceIoAuthority(
  hostRoot: string,
  options: CreateWorkspaceIoAuthorityOptions = {},
): WorkspaceIoAuthority {
  const canonical = canonicalizeRoot(hostRoot)
  return {
    readRoot: canonical,
    hostRoot: canonical,
    secretGrants: new Set((options.secretGrants ?? []).map(p => resolve(p))),
  }
}

/** 从 Trusted Execution Authority 派生（production 唯一来源：
 *  workspace.hostRoot 是 realpath 后的物理根）。 */
export function workspaceIoAuthorityFromTrusted(
  authority: TrustedExecutionAuthority,
): WorkspaceIoAuthority {
  return createWorkspaceIoAuthority(authority.workspace.hostRoot)
}

/** 基线漂移检查：ToolExecutionContext.projectRoot 与权威读取根必须一致。 */
export function checkWorkspaceBaseDrift(
  workspace: WorkspaceIoAuthority,
  contextProjectRoot: string | undefined,
): WorkspaceIoViolation | null {
  if (!contextProjectRoot) return null
  let contextRoot: string
  try {
    contextRoot = canonicalizeRoot(contextProjectRoot)
  } catch {
    return {
      code: "WORKSPACE_PATH_BASE_DRIFT",
      reason: `WORKSPACE_PATH_BASE_DRIFT: ToolExecutionContext.projectRoot 无法解析为物理根: ${contextProjectRoot}`,
    }
  }
  if (contextRoot !== workspace.readRoot) {
    return {
      code: "WORKSPACE_PATH_BASE_DRIFT",
      reason: `WORKSPACE_PATH_BASE_DRIFT: ToolExecutionContext.projectRoot (${contextRoot}) 与 WorkspaceIoAuthority.readRoot (${workspace.readRoot}) 不一致，fail closed`,
    }
  }
  return null
}

/** 权威读取强制：秘密文件 / 工作区外 / symlink 逃逸。
 *
 *  判定基于 canonical target（deepest realpath）：
 *    - 秘密文件对 lexical 路径与 canonical target 各执行一次 —— workspace 内
 *      symlink alias 指向 .env 等秘密文件同样拒绝（SECRET_READ）。
 *    - containment 用 canonical target（realpath 归一化后）判定 —— projectRoot
 *      为 workspace 的 symlink alias 时（如 /project-link -> /real/project），
 *      lexical 前缀不在 readRoot 内但 canonical 在，正常读取放行。
 *    - lexical 在 projectRoot（lexical 形式，alias 场景区别于 canonical 根）
 *      之内而 canonical 逃出根 → SYMLINK_READ_ESCAPE；lexical 直接逃逸 →
 *      OUTSIDE_WORKSPACE_READ。
 *
 *  lexicalRoot 为 ToolExecutionContext.projectRoot（canonical 前的形式）；
 *  未提供时退回 readRoot（非 alias 项目两者一致）。 */
export function enforceWorkspaceRead(
  workspace: WorkspaceIoAuthority,
  resolvedPath: string,
  rawPath: string,
  lexicalRoot?: string,
): WorkspaceIoViolation | null {
  const realTarget = deepestExistingRealpath(resolvedPath)
  // SECRET_READ：lexical + canonical 双查（symlink alias → 秘密文件必须命中）。
  const secret = checkSecretRead(workspace, resolvedPath)
    ?? (realTarget !== undefined ? checkSecretRead(workspace, realTarget) : null)
  if (secret) return secret

  const lexicalRootNorm = lexicalRoot ? resolve(lexicalRoot) : workspace.readRoot
  const lexicalInRoot = isWithin(lexicalRootNorm, resolvedPath)
  const canonicalTarget = realTarget ?? resolvedPath
  if (!isWithin(workspace.readRoot, canonicalTarget)) {
    return {
      code: lexicalInRoot ? "SYMLINK_READ_ESCAPE" : "OUTSIDE_WORKSPACE_READ",
      reason: lexicalInRoot
        ? `SYMLINK_READ_ESCAPE: path 经 symlink 逃逸出权威工作区读取根: ${rawPath}`
        : `OUTSIDE_WORKSPACE_READ: path 超出权威工作区读取根 (${workspace.readRoot}): ${rawPath}`,
    }
  }
  return null
}

/** open 后 fd canonical 校验（关闭 check/open race 的读取侧）：
 *  通过 /proc/self/fd/{fd} 取得 open 目标的当前 canonical 路径，确认仍在
 *  权威读取根内（SYMLINK_READ_ESCAPE）。readlink 不可用（非 Linux）或 fd
 *  无 canonical 路径时返回 null —— 该边界由 IC14 的完整 TOCTOU 闭环覆盖。 */
export async function validateOpenFileCanonical(
  workspace: WorkspaceIoAuthority,
  resolvedPath: string,
  fd: number,
): Promise<WorkspaceIoViolation | null> {
  try {
    const canonical = await readlink(`/proc/self/fd/${fd}`)
    // open 目标已被 rename/替换（deleted）—— TOCTOU 窗口，fail closed。
    if (canonical.endsWith(" (deleted)")) {
      return {
        code: "SYMLINK_READ_ESCAPE",
        reason: `SYMLINK_READ_ESCAPE: open 目标已被替换或删除（TOCTOU），fail closed: ${resolvedPath}`,
      }
    }
    if (!isWithin(workspace.readRoot, canonical)) {
      return {
        code: "SYMLINK_READ_ESCAPE",
        reason: `SYMLINK_READ_ESCAPE: open 目标 canonical 路径逃逸权威工作区读取根: ${resolvedPath} -> ${canonical}`,
      }
    }
  } catch {
    // 非 Linux /proc 不可用：完整 TOCTOU 由 IC14 覆盖（文档边界）。
    return null
  }
  return null
}

// ── 秘密文件 deny policy ──

/** 文件名级 deny 规则（basename 匹配；.env.example 在 checkSecretRead 先行放行）。 */
const SECRET_FILE_RULES: ReadonlyArray<{ pattern: RegExp; reason: string }> = [
  { pattern: /^\.env$/, reason: "environment file" },
  { pattern: /^\.env\..+/, reason: "environment file" },
  { pattern: /^\.(netrc|npmrc|pypirc|yarnrc|yarnrc\.yml)$/, reason: "credential file" },
  { pattern: /^credentials\.(json|yaml|yml|toml|ini|txt)$/, reason: "credential store" },
  { pattern: /^(id_rsa|id_dsa|id_ecdsa|id_ed25519|id_ec2_user|id_ec2user)$/, reason: "private key" },
  { pattern: /\.(pem|key|p12|pfx|ppk|jks|keystore|asc|gpg)$/, reason: "key material" },
  { pattern: /^settings\.xml$/, reason: "build credential (maven)" },
]

/** 路径级 deny 规则（目录段匹配）。 */
const SECRET_PATH_RULES: ReadonlyArray<{ pattern: RegExp; reason: string }> = [
  { pattern: /(^|\/)\.ssh(\/|$)/, reason: "ssh directory" },
  { pattern: /(^|\/)\.aws(\/|$)/, reason: "aws credentials directory" },
  { pattern: /(^|\/)\.config\/gcloud(\/|$)/, reason: "gcloud credentials directory" },
  { pattern: /(^|\/)\.m2(\/|$)/, reason: "maven settings/credentials directory" },
  { pattern: /(^|\/)secrets(\/|$)/, reason: "secrets directory" },
]

/** 秘密文件判定：先查 Runtime grant（精确解析路径），再查 deny 规则；
 *  `.env.example` 系文件始终允许（示例不是秘密）。 */
export function checkSecretRead(
  workspace: WorkspaceIoAuthority,
  resolvedPath: string,
): WorkspaceIoViolation | null {
  if (workspace.secretGrants.has(resolvedPath)) return null
  const normalized = resolvedPath.replace(/\\/g, "/")
  const base = basename(normalized)
  if (/^\.env\.example/.test(base)) return null
  for (const { pattern, reason } of SECRET_FILE_RULES) {
    if (pattern.test(base)) {
      return {
        code: "SECRET_READ",
        reason: `SECRET_READ: 拒绝读取${reason} (${base})`,
      }
    }
  }
  for (const { pattern, reason } of SECRET_PATH_RULES) {
    if (pattern.test(normalized)) {
      return {
        code: "SECRET_READ",
        reason: `SECRET_READ: 拒绝读取${reason} (${normalized})`,
      }
    }
  }
  return null
}

/** realpath 归一化（存在则取物理根；不存在退回规范化绝对路径）。 */
function canonicalizeRoot(root: string): string {
  try {
    return realpathSync(resolve(root))
  } catch {
    return resolve(root)
  }
}
