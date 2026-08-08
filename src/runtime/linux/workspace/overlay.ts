/** LR2-2（P2-C）：Workspace Overlay —— 瞬时工作区。
 *
 *  探测链（计划 §6.3）：native OverlayFS → fuse-overlayfs → Git Worktree
 *  fallback（本机验证主路径）。结构语义：
 *  - lowerdir = 基础只读仓库快照；
 *  - upperdir = Agent 写层；workdir = Overlay 内部工作目录；
 *  - merged   = Cell 可见工作区。
 *
 *  Git 负责：版本事实 / 提交 / 合并 / 回滚。
 *  Overlay 负责：瞬时克隆 / 写入差异 / 失败丢弃 / Reviewer 只读快照 /
 *  Evolution 候选复制。
 *
 *  Landlock 注意：与 OverlayFS 组合时，必须针对最终 merged hierarchy
 *  建立规则（内核文档：OverlayFS 各层与 merged hierarchy 在 Landlock
 *  看来是独立文件层级 —— 限制 lower/upper 不自动限制合并视图）。
 */

import { existsSync } from "node:fs"
import { join } from "node:path"
import { execFileSync } from "node:child_process"

export type OverlayBackend = "overlayfs" | "fuse-overlayfs" | "git-worktree" | "none"

export interface OverlayDiff {
  created: string[]
  changed: string[]
  deleted: string[]
}

export interface OverlayInstance {
  backend: Exclude<OverlayBackend, "none">
  /** Cell 可见工作区（merged / worktree 根）。 */
  mergedPath: string
  /** 写层（upper / worktree 写目录）。 */
  writeLayerPath: string
  /** 相对快照的写入差异。 */
  diff(): OverlayDiff
  /** 丢弃写层（失败丢弃 / 瞬时克隆清理）。 */
  discard(): void
  /** 只读快照引用（Reviewer / Evolution 候选）。 */
  snapshot(): string
}

/** 探测可用的 Overlay 后端（按优先级）。 */
export function detectOverlayBackend(): OverlayBackend {
  // 1. native OverlayFS：需要 mount 权限（WSL 上通常无 —— 条件启用）。
  try {
    execFileSync("mount", ["-t", "overlay", "--help"], { stdio: "ignore" })
    // 实际挂载测试：无权限则抛错 → 降级。
    const probe = execFileSync("sh", ["-c", "test -r /sys/module/overlay/version && echo yes"], { encoding: "utf8" }).trim()
    if (probe === "yes") return "overlayfs"
  } catch {
    // 降级
  }
  // 2. fuse-overlayfs：可执行文件存在。
  try {
    execFileSync("fuse-overlayfs", ["--version"], { stdio: "ignore" })
    return "fuse-overlayfs"
  } catch {
    // 降级
  }
  // 3. Git Worktree fallback（git 可用即返回）。
  try {
    execFileSync("git", ["--version"], { stdio: "ignore" })
    return "git-worktree"
  } catch {
    return "none"
  }
}

/** Git Worktree fallback：worktree = 独立可写目录（upper），仓库快照
 *  = lower（只读引用）。 */
export class GitWorktreeOverlay {
  readonly backend = "git-worktree" as const

  /**
   * @param repoPath 仓库路径（快照来源）
   * @param snapshotRef 快照引用（commit/branch/tag；HEAD 默认）
   * @param workRoot worktree 放置根
   * @param label worktree 标签（cellId 等）
   */
  create(repoPath: string, snapshotRef: string, workRoot: string, label: string): OverlayInstance {
    const worktreePath = join(workRoot, `wt-${label}`)
    if (!existsSync(repoPath)) throw new Error(`repo not found: ${repoPath}`)
    const run = (args: string[]): string => execFileSync("git", args, { cwd: repoPath, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] })
    run(["worktree", "add", "--detach", worktreePath, snapshotRef])
    const snapshotBase = snapshotRef

    return {
      backend: "git-worktree",
      mergedPath: worktreePath,
      writeLayerPath: worktreePath,
      diff(): OverlayDiff {
        // 相对快照的差异（未提交改动 = upper 写层差异）。
        const out = execFileSync("git", ["status", "--porcelain"], { cwd: worktreePath, encoding: "utf8" })
        const created: string[] = []
        const changed: string[] = []
        const deleted: string[] = []
        for (const line of out.split("\n")) {
          if (!line.trim()) continue
          const code = line.slice(0, 2)
          const path = line.slice(3)
          if (code.startsWith("??") || code.startsWith("A")) created.push(path)
          else if (code.startsWith("D")) deleted.push(path)
          else changed.push(path)
        }
        return { created, changed, deleted }
      },
      discard(): void {
        try {
          execFileSync("git", ["worktree", "remove", "--force", worktreePath], { cwd: repoPath, stdio: "ignore" })
        } catch {
          // 幂等容忍
        }
      },
      snapshot(): string {
        // 只读快照：提交写层为临时 commit（Evolution/Reviewer 候选）。
        const runIn = (args: string[]): string => execFileSync("git", args, { cwd: worktreePath, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] })
        runIn(["add", "-A"])
        runIn(["commit", "--allow-empty", "-m", `overlay snapshot ${label}`])
        return runIn(["rev-parse", "HEAD"]).trim() ?? snapshotBase
      },
    }
  }
}
