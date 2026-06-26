/** [PR 2] TaskPacket — plan-driven task definition.
 *
 *  Replaces keyword-based createTaskTracker with structured per-node task packets.
 *  Each MasterPlan node produces a TaskPacket that carries concrete scope, verification
 *  requirements, and resource budgets. createTaskTrackerFromPacket converts it to the
 *  existing TaskTracker format for loop.ts consumption.
 *
 *  Flow:
 *    plan text → nodesFromPlanText (titles + deps)
 *             → extractScopeFromLine (per-node files + verification hints)
 *             → TaskPacket (structured)
 *             → createTaskTrackerFromPacket → TaskTracker
 */

import type { VerificationKind } from "../verification/result"
import { type TaskIntent, type TaskStep, type TaskTracker } from "./task-tracker"

// ── TaskPacket types ──

export interface TaskPacket {
  taskId: string
  nodeId: string
  title: string
  goal: string
  /** ContextMap that justified this task packet, when available. */
  contextMapId?: string
  /** Evidence lines proving required context was acquired before coding. */
  requiredContextEvidence?: string[]
  /** Concrete deliverables — file paths or action descriptions. */
  scope: string[]
  /** Checkable completion conditions. Auto-derived from scope if empty. */
  doneCriteria: string[]
  /** Required verification evidence. */
  verification: VerificationRequirement[]
  /** How node completion propagates to dependents. */
  ripplePolicy: RipplePolicy
  /** Resource budget for this node. */
  contextBudget: ContextBudget
}

export interface VerificationRequirement {
  kind: VerificationKind
  command?: string
  description: string
}

export interface RipplePolicy {
  /** Auto-unblock downstream nodes when this node completes. */
  autoPropagate: boolean
  /** Require verification evidence before marking done. */
  requireEvidence: boolean
  /** Max react-count nudges before declaring blocked. */
  maxRetries: number
}

export interface ContextBudget {
  /** Max tool calls allowed for this node. */
  maxToolsPerNode: number
  /** Max conversation rounds for this node. */
  maxRoundsPerNode: number
  /** Estimated token budget for this node. */
  estimatedTokens: number
}

export const DEFAULT_RIPPLE: RipplePolicy = {
  autoPropagate: true,
  requireEvidence: true,
  maxRetries: 3,
}

export const DEFAULT_BUDGET: ContextBudget = {
  maxToolsPerNode: 20,
  maxRoundsPerNode: 8,
  estimatedTokens: 50_000,
}

// ── Scope extraction (heuristic — replaced by model-structured output in PR 8) ──

// Negative lookbehind (?<![.\d]) prevents false matches like "0.ts" from "version-2.0.ts"
// [\w-]* (instead of +) in the second alt allows dotfiles like .gitignore and .env
export const FILE_PATH_RE = /([\w-]+\/[\w\/.-]*\.\w{1,6}|(?<![.\d])[\w-]*\.(?:ts|tsx|js|jsx|json|css|scss|html|md|yaml|yml|toml|env|gitignore)\b)/gi

/** True when a scope item looks like a concrete file path rather than an abstract description. */
export function isFilePath(s: string): boolean {
  return /\.(ts|tsx|js|jsx|json|css|scss|html|md|yaml|yml|toml|env|gitignore|dockerfile)$/i.test(s) || s.includes("/")
}

function extractVerificationHints(text: string): VerificationKind[] {
  const kinds: VerificationKind[] = []
  if (/typecheck|tsc|类型检查/i.test(text)) kinds.push("typecheck")
  if (/test|测试/i.test(text)) kinds.push("test")
  if (/build|构建|打包/i.test(text)) kinds.push("build")
  if (/lint|eslint/i.test(text)) kinds.push("lint")
  return kinds
}

/** Result of heuristically parsing a plan line for scope information. */
export interface ScopeExtraction {
  files: string[]
  verificationHints: VerificationKind[]
  deliverable: string
}

/** Extract concrete scope (files, verification hints, deliverable text) from a plan line.
 *
 *  Handles plan text formats like:
 *  - "创建package.json、tsconfig.json、项目结构"
 *  - "创建server/index.ts、server/index.test.ts，实现API接口和错误处理"
 *  - "运行typecheck、test、build三个验证命令，确保全部通过"
 */
export function extractScopeFromLine(line: string): ScopeExtraction {
  // Strip leading number/bullet prefix
  const clean = line.replace(/^\d+[\.\)\-、]\s*|^[-*]\s*/, "").trim()

  // Extract file paths
  const files: string[] = []
  let match: RegExpExecArray | null
  // Reset regex state before use
  FILE_PATH_RE.lastIndex = 0
  while ((match = FILE_PATH_RE.exec(clean)) !== null) {
    const f = match[1]!
    // Skip bare extensions (e.g. ".ts" from "build.end.ts") — dotfiles like
    // ".gitignore" or ".env" have >= 4 chars, bare extensions are shorter.
    if (!f.startsWith(".") || f.length >= 4) {
      if (!files.includes(f)) files.push(f)
    }
  }

  // Deduplicate (package.json might match both file and path patterns)
  const deduped = [...new Set(files)]

  // Extract verification hints
  const verificationHints = extractVerificationHints(clean)

  return {
    files: deduped,
    verificationHints,
    deliverable: clean.slice(0, 120),
  }
}

// ── TaskPacket → TaskTracker conversion ──

interface VerificationDefault {
  description: string
  command: string
}

const VERIFICATION_DEFAULTS: Record<VerificationKind, VerificationDefault> = {
  typecheck: { description: "运行类型检查", command: "tsc --noEmit" },
  test: { description: "运行测试", command: "bun test" },
  build: { description: "运行构建", command: "bun run build" },
  lint: { description: "运行 lint", command: "eslint ." },
  smoke: { description: "运行冒烟测试", command: "bun run smoke" },
  unknown: { description: "运行验证", command: "" },
}

/** Convert a TaskPacket into the existing TaskTracker format.
 *
 *  The returned tracker starts in "building" phase (plan is already accepted
 *  at the MasterPlan level). Steps are derived from scope items + verification
 *  requirements. The first scope item is marked "running".
 */
export function createTaskTrackerFromPacket(packet: TaskPacket, intent: TaskIntent = "long_task"): TaskTracker {
  const steps: TaskStep[] = []
  let stepIdx = 0

  // Scope items → task steps
  for (const item of packet.scope) {
    stepIdx++
    const label = isFilePath(item) ? `创建 ${item}` : item.slice(0, 120)
    steps.push({
      id: `scope-${stepIdx}`,
      title: label,
      status: stepIdx === 1 ? "running" : "pending",
    })
  }

  // Verification requirements → verification steps
  for (const v of packet.verification) {
    stepIdx++
    steps.push({
      id: `verify-${v.kind}`,
      title: v.description.slice(0, 120),
      status: "pending",
    })
  }

  // If no scope at all, add a minimal default step
  if (steps.length === 0) {
    steps.push({ id: "implement", title: "实现核心逻辑", status: "running" })
  }

  // Extract concrete file paths from scope
  const requiredFiles = packet.scope.filter(isFilePath)

  return {
    goal: `${packet.goal} — ${packet.title}`,
    intent,
    phase: "building", // plan already accepted at MasterPlan level
    requiredFiles,
    requiredVerificationKinds: packet.verification.map(v => v.kind),
    verificationEvidence: {},
    verification: packet.verification.map(v => v.description),
    steps,
  }
}

/** Build a TaskPacket from a plan line with heuristic scope extraction.
 *
 *  This is the bridge between raw plan text and structured task definition.
 *  When model-structured output arrives (PR 8 ModeContract), the heuristic
 *  extraction will be replaced by model-provided JSON TaskPackets.
 */
export function buildPacketFromLine(opts: {
  title: string
  goal: string
  nodeId: string
  taskId?: string
}): TaskPacket {
  const { title, goal, nodeId } = opts
  const scope = extractScopeFromLine(title)

  // Derive verification requirements from hints, with fallback defaults
  const verification: VerificationRequirement[] = scope.verificationHints.length > 0
    ? scope.verificationHints.map(kind => {
        const def = VERIFICATION_DEFAULTS[kind]
        return {
          kind,
          description: def.description,
          command: def.command,
        }
      })
    : [
        { kind: "typecheck", description: VERIFICATION_DEFAULTS.typecheck.description, command: VERIFICATION_DEFAULTS.typecheck.command },
      ]

  // Scope items: extracted files first, then deliverable text
  const scopeItems = scope.files.length > 0
    ? scope.files
    : [scope.deliverable]

  // Auto-derive done criteria from scope + verification
  const doneCriteria = scope.files.length > 0
    ? scope.files.map(f => `文件 ${f} 已创建并通过验证`)
    : scope.verificationHints.length > 0
      ? scope.verificationHints.map(kind => {
          const label: Record<string, string> = { typecheck: "类型检查通过", test: "测试全部通过", build: "构建成功", lint: "lint 无错误" }
          return label[kind] ?? `${kind} 验证通过`
        })
      : ["核心逻辑已实现并通过验证"]

  return {
    taskId: opts.taskId ?? `task-${nodeId}`,
    nodeId,
    title,
    goal,
    scope: scopeItems,
    doneCriteria,
    verification,
    ripplePolicy: { ...DEFAULT_RIPPLE },
    contextBudget: { ...DEFAULT_BUDGET },
  }
}
