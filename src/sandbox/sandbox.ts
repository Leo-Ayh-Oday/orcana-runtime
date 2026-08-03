/** SandboxManager — defense-in-depth for shell commands.
 *
 *  Layers:
 *    1. Job Object — process tree kill-on-close guarantee (kernel32, Windows only)
 *    2. Path Guard — post-exec file change detection (audit, NOT real-time prevention)
 *    3. Env filtering — whitelist-only environment variables
 *    4. Timeout — hard cap on execution time
 *
 *  Honest limitations:
 *    - Path Guard is post-hoc: it detects damage after the fact, does not prevent it
 *    - No network isolation (requires admin on Windows)
 *    - No filesystem interception during execution (requires kernel driver)
 *    - macOS/Linux: degraded to env filtering + timeout only
 */

import { resolve } from "node:path"
import { createJob, setLimits, assignProcess, killJob, disposeJob, type JobObject } from "./job-object"
import { PathGuard, type PathGuardReport } from "./path-guard"

export interface SandboxConfig {
  projectRoot: string
  jobMemoryLimitMb?: number
  maxRuntimeSec: number
}

export interface SandboxVerdict {
  allowed: boolean
  reason?: string
  /** Env vars to inject before spawn (whitelist) */
  injectedEnv?: Record<string, string>
  /** Reduced timeout for sandboxed execution */
  timeoutOverride?: number
}

// Safe env vars to pass through to child processes
const ENV_ALLOWLIST = new Set([
  "PATH", "PATHEXT", "SystemRoot", "SystemDrive", "TEMP", "TMP",
  "USERPROFILE", "APPDATA", "LOCALAPPDATA", "HOMEDRIVE", "HOMEPATH",
  "NODE_ENV", "ORCANA_SANDBOX", "ORCANA_SANDBOX_TIMEOUT_SEC",
  "PROCESSOR_ARCHITECTURE", "NUMBER_OF_PROCESSORS",
  "npm_config_cache", "BUN_INSTALL", "GIT_SSH",
])

export class SandboxManager {
  private config: SandboxConfig
  private pathGuard: PathGuard
  private job: JobObject | null = null
  /** Files that ripple has blocked — shell must not write to these. */
  private blockedFiles = new Set<string>()

  constructor(config: SandboxConfig) {
    this.config = config
    this.pathGuard = new PathGuard(config.projectRoot)
    this.job = createJob("orcana-sandbox")
  }

  /** Mark a file as blocked (called when ripple blocks a write). */
  blockFileWrite(path: string): void {
    this.blockedFiles.add(path.replace(/\\/g, "/"))
  }

  /** Clear blocked files (call at start of new round). */
  clearBlockedFiles(): void {
    this.blockedFiles.clear()
  }

  /** Snapshot the project tree before any shell command. This is separate from
   * sandbox eligibility because ordinary shell commands can still mutate files. */
  snapshotWorkspace(): void {
    this.pathGuard.snapshotTree()
  }

  /** Check a command before spawning. Returns verdict + env to inject. */
  check(command: string, _workingDir?: string): SandboxVerdict {
    // Pre-check: block shell commands that try to write to ripple-blocked files
    for (const blocked of this.blockedFiles) {
      const base = blocked.split("/").pop() ?? blocked
      if (command.includes(blocked) || command.includes(base)) {
        // Only match write patterns, not read-only commands
        if (/(Write-|Set-Content|>|writeFile|write_file|Out-File|tee\b|cp\b|mv\b|move\b)/i.test(command)) {
          return {
            allowed: false,
            reason: `Shell blocked: file ${base} was blocked by ripple. Use multi_edit to apply the ripple cascade, or resolve pending caller obligations first.`,
          }
        }
      }
    }

    if (!this.needsSandbox(command)) {
      return { allowed: true }
    }

    // Take pre-exec file snapshot
    this.pathGuard.snapshotTree()

    // Build env whitelist
    const injectedEnv: Record<string, string> = {}
    for (const key of ENV_ALLOWLIST) {
      if (process.env[key] !== undefined) {
        injectedEnv[key] = process.env[key]!
      }
    }
    // Always set sandbox flag + production NODE_ENV
    injectedEnv["ORCANA_SANDBOX"] = "1"
    injectedEnv["NODE_ENV"] = process.env.NODE_ENV ?? "production"

    return {
      allowed: true,
      injectedEnv,
      timeoutOverride: this.config.maxRuntimeSec,
    }
  }

  /**
   * Called after spawn — assign the process to the Job Object.
   * This ensures it will be killed when cleanup() is called.
   */
  track(pid: number): void {
    if (this.job) {
      setLimits(this.job, {
        memoryMb: this.config.jobMemoryLimitMb,
        timeSec: this.config.maxRuntimeSec,
      })
      assignProcess(this.job, pid)
    }
  }

  /** Diff after execution. Returns violations if any. */
  diff(expectedPaths: string[] = []): PathGuardReport {
    return this.pathGuard.diff(expectedPaths)
  }

  /** Kill all tracked processes and dispose the Job Object. */
  async cleanup(): Promise<void> {
    if (this.job) {
      killJob(this.job)
    }
  }

  /** Dispose the Job Object handle (called on clean shutdown). */
  dispose(): void {
    if (this.job) {
      disposeJob(this.job)
      this.job = null
    }
  }

  /** Delegate to the existing heuristic in shell.ts (kept here for use by shell). */
  needsSandbox(command: string): boolean {
    const lower = command.toLowerCase()
    if (/\b(npm|pnpm|yarn|pip|pip3|gem|cargo|go\s+get|composer)\s+(install|add|i)\b/.test(lower)) return true
    if (/\b(curl|wget|Invoke-WebRequest)\b/.test(lower) && !/\blocalhost|127\.0\.0\.1\b/.test(lower)) return true
    if (/\b(bun|node|python|python3|tsx|ts-node)\s+(run\s+)?.*\.(js|ts|py)\b/.test(lower)) return true
    if (/\bnpx\s/.test(lower)) return true
    return false
  }
}
