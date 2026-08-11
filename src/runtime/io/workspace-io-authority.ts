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
 *      open 后的 fd canonical 路径（/proc/self/fd）不得离开 readRoot。
 *    - SECRET_READ = 0 —— .env/私钥/credentials 等拒绝读取；秘密判定对
 *      lexical 路径与 canonical target（realpath 后）各执行一次，workspace 内
 *      symlink alias 指向秘密文件同样拒绝；.env.example 只能精确放行
 *      （.env.example.secret / .env.example.production 拒绝）；hardlink alias
 *      （同一 inode 的另一个名字）指向秘密文件同样拒绝；
 *      显式 secret grant 只能由 Runtime 提供（secretGrants 集合，realpath
 *      canonicalize 后精确匹配），绝不从 Tool 参数接收。
 *    - FD_CANONICAL_UNAVAILABLE = 0 —— readlink(/proc/self/fd/N) 失败、procfs
 *      不可用、canonical 目标被删除/替换（dev/inode 复核不一致）时 fail
 *      closed（SYMLINK_READ_ESCAPE），绝不静默放行。
 *
 *  path 算法仍复用 tools/path-authority 的 resolveToolPath（唯一算法入口），
 *  本模块只做权威根/秘密文件策略，不新建第二套路径算法。
 */

import { fstatSync, readlinkSync, realpathSync, statSync } from "node:fs"
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
  /** Runtime 显式 secret grant（canonical 解析路径集合）——绝不来自 Tool 参数。 */
  readonly secretGrants: ReadonlySet<string>
}

export interface WorkspaceIoViolation {
  code: WorkspaceIoViolationCode
  reason: string
}

export interface CreateWorkspaceIoAuthorityOptions {
  secretGrants?: readonly string[]
}

/** 构造权威（读取根做 realpath 归一化；根缺失时退回规范化绝对路径）。
 *  grant 必须 canonicalize（realpath）后精确匹配 —— symlink 形式的 grant
 *  与真实目标等价；不存在时退回规范化绝对路径。 */
export function createWorkspaceIoAuthority(
  hostRoot: string,
  options: CreateWorkspaceIoAuthorityOptions = {},
): WorkspaceIoAuthority {
  const canonical = canonicalizeRoot(hostRoot)
  return {
    readRoot: canonical,
    hostRoot: canonical,
    secretGrants: new Set(
      (options.secretGrants ?? []).map(p => {
        const resolved = resolve(p)
        const real = deepestExistingRealpath(resolved)
        return real ?? resolved
      }),
    ),
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

/** 权威读取强制：秘密文件 / 工作区外 / symlink 逃逸 / hardlink 秘密别名。
 *
 *  判定基于 canonical target（deepest realpath）：
 *    - 秘密文件对 lexical 路径与 canonical target 各执行一次 —— workspace 内
 *      symlink alias 指向 .env 等秘密文件同样拒绝（SECRET_READ）。
 *    - hardlink alias：目标为多链接普通文件时，扫描工作区内全部秘密规则
 *      命中的文件，若存在同一 (dev,ino) 则拒绝（SECRET_READ）——benign
 *      basename（public.txt）不能掩盖其与 .env 的同一文件身份。
 *    - containment 用 canonical target（realpath 归一化后）判定 —— projectRoot
 *      为 workspace 的 symlink alias 时（如 /project-link -> /real/project），
 *      lexical 前缀不在 readRoot 内但 canonical 在，正常读取放行。
 *    - lexical 在 projectRoot（lexical 或 canonical 形式，alias 场景下二者都算）
 *      之内而 canonical 逃出根 → SYMLINK_READ_ESCAPE；lexical 直接逃逸 →
 *      OUTSIDE_WORKSPACE_READ。尚不存在的路径若 lexical 位于 project root
 *      （或其 canonical 形式）之内则放行 —— 打开后 fd canonical 校验兜底
 *      （fail closed），避免"漂移检查通过后对 alias 内路径误报
 *      OUTSIDE_WORKSPACE_READ"的矛盾行为。
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

  // hardlink 策略：nlink>1 而未获 Runtime 精确路径授权 → fail closed
  // （O(1)，无全树扫描；工作区外秘密 hardlink、不可枚举目录内的秘密文件
  // 都无法通过扫描发现，因此默认拒绝）。grant 只放行被授权路径本身，
  // 不扩散到同一 inode 的其他 hardlink 名称。
  let st
  try {
    st = statSync(resolvedPath)
  } catch {
    st = undefined
  }
  if (st && st.isFile()) {
    const hardlink = checkHardlinkPolicy(workspace, resolvedPath, realTarget, st.nlink)
    if (hardlink) return hardlink
  }

  // projectRoot 的 lexical 与 canonical 形式都视为"根内"（symlink alias
  // 场景下二者等价；漂移检查已保证物理根一致）。
  const lexicalRootNorm = lexicalRoot ? resolve(lexicalRoot) : workspace.readRoot
  const canonicalLexicalRoot = lexicalRoot ? canonicalizeRoot(lexicalRoot) : workspace.readRoot
  const lexicalInRoot = isWithin(lexicalRootNorm, resolvedPath) || isWithin(canonicalLexicalRoot, resolvedPath)

  const canonicalTarget = realTarget ?? resolvedPath
  if (!isWithin(workspace.readRoot, canonicalTarget)) {
    // 路径尚不存在且 lexical 位于 project root（或其 canonical 形式）内：
    // 放行，由 open 后 fd canonical 校验 fail closed 兜底（不存在则读失败）。
    if (realTarget === undefined && lexicalInRoot) return null
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
 *  通过 /proc/self/fd/{fd} 取得 open 目标的当前 canonical 路径，并对其
 *  重新执行完整 authority 验证：
 *    1. 未 deleted/replaced（TOCTOU 窗口 fail closed）。
 *    2. canonical target 仍在权威读取根内（SYMLINK_READ_ESCAPE）。
 *    3. canonical target 不是秘密文件（除非 Runtime grant）—— post-open
 *       看到的最终真实对象与 open 前 policy 判定一致（SECRET_READ）。
 *    4. canonical 路径当前仍指向同一 (dev, ino)（目标被替换 → fail closed）。
 *    5. fd 目标为多链接文件时执行 hardlink 秘密 inode 复核。
 *  readlink 失败、procfs 不可用、无法完成复核时一律 fail closed
 *  （SYMLINK_READ_ESCAPE）——绝不静默放行。 */
export async function validateOpenFileCanonical(
  workspace: WorkspaceIoAuthority,
  resolvedPath: string,
  fd: number,
): Promise<WorkspaceIoViolation | null> {
  let canonical: string
  try {
    canonical = await readlink(`/proc/self/fd/${fd}`)
  } catch (error) {
    return {
      code: "SYMLINK_READ_ESCAPE",
      reason: `SYMLINK_READ_ESCAPE: 无法读取 open 目标的 canonical 路径（/proc/self/fd/${fd} 不可用），fail closed: ${resolvedPath} (${describeFsError(error)})`,
    }
  }
  return checkOpenFdCanonical(workspace, resolvedPath, canonical, fd)
}

/** 同步版 open 后 fd canonical 校验（ContextMap 同步管线 / readSync 用）。
 *  语义与 validateOpenFileCanonical 完全一致，readlink 失败同样 fail closed。 */
export function validateOpenFileCanonicalSync(
  workspace: WorkspaceIoAuthority,
  resolvedPath: string,
  fd: number,
): WorkspaceIoViolation | null {
  let canonical: string
  try {
    canonical = readlinkSync(`/proc/self/fd/${fd}`)
  } catch (error) {
    return {
      code: "SYMLINK_READ_ESCAPE",
      reason: `SYMLINK_READ_ESCAPE: 无法读取 open 目标的 canonical 路径（/proc/self/fd/${fd} 不可用），fail closed: ${resolvedPath} (${describeFsError(error)})`,
    }
  }
  return checkOpenFdCanonical(workspace, resolvedPath, canonical, fd)
}

/** fd canonical 校验公共逻辑（sync/async 共用）。 */
function checkOpenFdCanonical(
  workspace: WorkspaceIoAuthority,
  resolvedPath: string,
  canonical: string,
  fd: number,
): WorkspaceIoViolation | null {
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
  // P1-6 复审：post-open 对 fd 真实目标重跑 secret policy —— open 前的
  // lexical/canonical 检查无法覆盖 check→open 间的对象替换。
  const secret = checkSecretRead(workspace, canonical)
  if (secret) {
    return {
      code: "SECRET_READ",
      reason: `SECRET_READ: open 目标为秘密文件（post-open canonical）: ${resolvedPath} -> ${canonical}`,
    }
  }
  try {
    const fdStat = fstatSync(fd)
    if (!fdStat.isFile()) {
      return {
        code: "SYMLINK_READ_ESCAPE",
        reason: `SYMLINK_READ_ESCAPE: open 目标不是普通文件（post-open fstat），fail closed: ${resolvedPath}`,
      }
    }
    // dev/inode 复核：canonical 路径当前仍指向同一文件；被替换/删除 →
    // fail closed（始终只读已验证句柄）。
    const nowStat = statSync(canonical)
    if (fdStat.dev !== nowStat.dev || fdStat.ino !== nowStat.ino) {
      return {
        code: "SYMLINK_READ_ESCAPE",
        reason: `SYMLINK_READ_ESCAPE: open 目标在打开后被替换（dev/inode 不一致），fail closed: ${resolvedPath}`,
      }
    }
    // hardlink 策略（post-open）：多链接文件必须获得 Runtime 精确路径授权，
    // 否则 fail closed —— canonical 或请求路径命中 grant 均视为已授权；
    // 未授信的别名（public.txt）一律拒绝（grant 不扩散到其他 hardlink 名称）。
    if (fdStat.nlink > 1 && !workspace.secretGrants.has(canonical) && !workspace.secretGrants.has(resolvedPath)) {
      return {
        code: "SECRET_READ",
        reason: `SECRET_READ: open 目标为多链接文件（hardlink）且未获 Runtime 精确路径授权，fail closed: ${resolvedPath} -> ${canonical}`,
      }
    }
  } catch (error) {
    return {
      code: "SYMLINK_READ_ESCAPE",
      reason: `SYMLINK_READ_ESCAPE: 无法完成 open 目标 dev/inode 复核，fail closed: ${resolvedPath} (${describeFsError(error)})`,
    }
  }
  return null
}

// ── 秘密文件 deny policy ──

/** 文件名级 deny 规则（basename 匹配；.env.example 在 checkSecretRead 先行精确放行）。 */
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

/** 秘密文件判定：先查 Runtime grant（canonical 精确路径），再查 deny 规则；
 *  `.env.example` 系文件仅精确文件名放行（示例不是秘密，后缀变体拒绝）。 */
export function checkSecretRead(
  workspace: WorkspaceIoAuthority,
  resolvedPath: string,
): WorkspaceIoViolation | null {
  if (workspace.secretGrants.has(resolvedPath)) return null
  const normalized = resolvedPath.replace(/\\/g, "/")
  const base = basename(normalized)
  if (base === ".env.example") return null
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

// ── hardlink 策略 ──

/** IC01-R3: hardlink 策略 —— 未获得 Runtime 精确路径授权的 nlink>1 文件
 *  默认 fail closed（SECRET_READ）。不做全树扫描：
 *    - 工作区外的秘密文件被 hardlink 进工作区（如 /home/u/.ssh/id_ed25519
 *      -> public.txt）无法从工作区树内发现，扫描方案必然放行；
 *    - 不可枚举目录（无读权限）内的 .env 无法被扫描到，扫描方案同样放行；
 *    - 每次读取扫描整棵树是 O(候选数 × 工作区条目数) 的同步放大。
 *  精确 grant（realpath canonicalize 后）只放行被授权路径本身，不扩散到
 *  同一 inode 的其他 hardlink 名称。 */
function checkHardlinkPolicy(
  workspace: WorkspaceIoAuthority,
  resolvedPath: string,
  realTarget: string | undefined,
  nlink: number,
): WorkspaceIoViolation | null {
  if (nlink <= 1) return null
  const granted = workspace.secretGrants.has(resolvedPath)
    || (realTarget !== undefined && workspace.secretGrants.has(realTarget))
  if (granted) return null
  return {
    code: "SECRET_READ",
    reason: `SECRET_READ: 多链接文件（hardlink）未获 Runtime 精确路径授权，fail closed: ${resolvedPath}`,
  }
}

/** realpath 归一化（存在则取物理根；不存在退回规范化绝对路径）。 */
function canonicalizeRoot(root: string): string {
  try {
    return realpathSync(resolve(root))
  } catch {
    return resolve(root)
  }
}

function describeFsError(error: unknown): string {
  if (error && typeof error === "object" && "code" in error) {
    return String((error as { code?: unknown }).code ?? "unknown")
  }
  return error instanceof Error ? error.message : String(error)
}
