import { existsSync, realpathSync } from "node:fs"
import { resolve } from "node:path"
import type { LegacyHookHandler } from "./index"

export interface SafetyPolicyOptions {
  projectRoot?: string
  allowOutsideProject?: boolean
}

const DANGEROUS_COMMANDS = new Set([
  "bcdedit",
  "chmod",
  "chown",
  "del",
  "diskpart",
  "fdisk",
  "format",
  "mkfs",
  "mount",
  "netsh",
  "parted",
  "rd",
  "reboot",
  "reg",
  "regedit",
  "rm",
  "rmdir",
  "shutdown",
  "takeown",
  "umount",
])

const SECRET_FILE_PATTERNS = [
  /(^|[\\/])\.env($|[\\/.])/i,
  /(^|[\\/])\.npmrc$/i,
  /(^|[\\/])\.pypirc$/i,
  /(^|[\\/])id_rsa$/i,
  /(^|[\\/])id_ed25519$/i,
  /(^|[\\/])known_hosts$/i,
  /(^|[\\/])credentials($|[\\/.])/i,
  /(^|[\\/])secrets?($|[\\/.])/i,
]

function firstShellWord(command: string): string {
  const trimmed = command.trim()
  if (!trimmed) return ""
  // Strip known shell prefixes: cmd, powershell, pwsh, wsl, bash, full paths to cmd.exe
  const withoutPrefix = trimmed.replace(
    /^((?:[A-Za-z]:\\?(?:[^\\]+\\)*)?cmd(?:\.exe)?\s+\/[ck]|powershell(?:\.exe)?\s+(?:-[^ ]+\s+)*|pwsh(?:\.exe)?\s+(?:-[^ ]+\s+)*|wsl(?:\.exe)?\s+|bash(?:\.exe)?\s+-c\s+)/i,
    "",
  )
  return withoutPrefix.trim().split(/\s+/)[0]?.replace(/^["']|["']$/g, "").toLowerCase() ?? ""
}

function hasDangerousShellPattern(command: string): string | null {
  const normalized = command.replace(/\s+/g, " ").trim()
  const base = firstShellWord(normalized)
  if (DANGEROUS_COMMANDS.has(base)) return `dangerous command '${base}'`
  if (/\brm\s+(-[^\s]*r|-[^\s]*f|--recursive|--force)/i.test(normalized)) return "recursive or forced rm"
  if (/\bRemove-Item\b[\s\S]*\s-(Recurse|Force)\b/i.test(normalized)) return "recursive or forced Remove-Item"
  if (/\bgit\s+reset\s+--hard\b/i.test(normalized)) return "git reset --hard"
  if (/\bgit\s+clean\b[\s\S]*\s-[^\s]*f/i.test(normalized)) return "git clean -f"
  if (/\bgit\s+push\b[\s\S]*\s(--force|-f)\b/i.test(normalized)) return "force push"
  return null
}

function canonicalProjectRoot(projectRoot: string): string {
  const resolved = resolve(projectRoot)
  return existsSync(resolved) ? realpathSync(resolved) : resolved
}

function isPathInside(root: string, target: string): boolean {
  const resolved = resolve(target)
  const canonicalTarget = existsSync(resolved) ? realpathSync(resolved) : resolved
  const normalizedRoot = root.replace(/[\\/]$/, "").toLowerCase()
  const normalizedTarget = canonicalTarget.toLowerCase()
  return normalizedTarget === normalizedRoot || normalizedTarget.startsWith(`${normalizedRoot}\\`) || normalizedTarget.startsWith(`${normalizedRoot}/`)
}

function isSecretLikePath(path: string): boolean {
  const normalized = path.replace(/\\/g, "/")
  return SECRET_FILE_PATTERNS.some(pattern => pattern.test(normalized))
}

function pathFromParams(params: Record<string, unknown> | undefined): string | undefined {
  const path = params?.path
  return typeof path === "string" && path.trim() ? path : undefined
}

export function createSafetyPolicyHook(options: SafetyPolicyOptions = {}): LegacyHookHandler {
  const projectRoot = canonicalProjectRoot(options.projectRoot ?? process.cwd())
  const allowOutsideProject = options.allowOutsideProject ?? false

  return (input) => {
    const tool = input.tool ?? ""
    const params = input.params ?? {}

    if (tool === "shell" || tool === "start_service") {
      const command = typeof params.command === "string" ? params.command : ""
      const reason = hasDangerousShellPattern(command)
      if (reason) return { blocked: true, warn: `Safety policy blocked ${tool}: ${reason}`, source: "hooks:safety-policy" }
      if (tool === "shell") return {}
      const cwd = typeof params.cwd === "string" ? params.cwd : ""
      if (cwd && !allowOutsideProject && !isPathInside(projectRoot, cwd)) {
        return { blocked: true, warn: `Safety policy blocked service cwd outside project: ${cwd}`, source: "hooks:safety-policy" }
      }
    }

    const path = pathFromParams(params)
    if (!path) return {}

    const isFileTool = tool === "read_file" || tool === "write_file" || tool === "edit_file" || tool === "edit_fim"
    if (!isFileTool) return {}

    if (isSecretLikePath(path)) {
      return { blocked: true, warn: `Safety policy blocked access to sensitive path: ${path}`, source: "hooks:safety-policy" }
    }

    if (!allowOutsideProject && !isPathInside(projectRoot, path)) {
      // Block only clearly dangerous paths (system dirs, other drives)
      // Allow non-existent or unresolvable paths — let the tool fail naturally
      const normalized = resolve(path).toLowerCase()
      const dangerousPrefixes = [
        "c:\\windows\\", "c:\\windows\\system32\\", "c:\\program files\\",
        "c:\\program files (x86)\\", "c:\\programdata\\",
        "/system/", "/etc/", "/boot/", "/sys/", "/proc/",
      ]
      if (dangerousPrefixes.some(p => normalized.startsWith(p))) {
        return { blocked: true, warn: `Safety policy blocked dangerous path: ${path}`, source: "hooks:safety-policy" }
      }
      // Path may be unresolvable or in a different project — let the tool handle it
      return {}
    }

    return {}
  }
}
