import { existsSync, readFileSync } from "node:fs"
import { resolve } from "node:path"
import type { VerificationKind, VerificationResult } from "../verification/result"
import { ingestVerificationResults, type EvidenceLedger } from "./evidence-ledger"

export type TaskIntent = "readonly" | "narrow_edit" | "long_task"
export type TaskStepStatus = "pending" | "running" | "done" | "failed"

export interface TaskStep {
  id: string
  title: string
  status: TaskStepStatus
  evidence?: string
}

export interface TaskTracker {
  goal: string
  intent: TaskIntent
  phase: "planning" | "building" | "complete"
  requiredFiles: string[]
  requiredVerificationKinds: VerificationKind[]
  verificationEvidence: Partial<Record<VerificationKind, string>>
  verification: string[]
  steps: TaskStep[]
}

function hasAny(text: string, patterns: RegExp[]): boolean {
  return patterns.some(pattern => pattern.test(text))
}

function addUnique(items: string[], value: string) {
  if (!items.includes(value)) items.push(value)
}

function hasStep(tracker: TaskTracker, id: string): boolean {
  return tracker.steps.some(step => step.id === id)
}

function safeRead(cwd: string, path: string): string {
  const fullPath = resolve(cwd, path)
  if (!existsSync(fullPath)) return ""
  try {
    return readFileSync(fullPath, "utf-8")
  } catch {
    return ""
  }
}

function addVerificationKind(items: VerificationKind[], kind: VerificationKind) {
  if (!items.includes(kind)) items.push(kind)
}

function verificationKindLabel(kind: VerificationKind): string {
  if (kind === "typecheck") return "typecheck"
  if (kind === "test") return "test"
  if (kind === "build") return "build"
  if (kind === "smoke") return "smoke"
  if (kind === "lint") return "lint"
  return "unknown"
}

/**
 * @deprecated PR 2 — use {@link createTaskTrackerFromPacket} from "./task-packet" instead.
 * Keyword-based tracker creation with hardcoded file paths and template steps.
 * Kept for backward compatibility (loop.ts fallback path, existing tests).
 */
export function createTaskTracker(prompt: string, intent: TaskIntent): TaskTracker | null {
  if (intent !== "long_task") return null
  const text = prompt.toLowerCase()
  const requiredFiles = ["package.json", "tsconfig.json"]
  const requiredVerificationKinds: VerificationKind[] = ["typecheck"]
  const verification = ["运行类型检查", "运行测试或构建"]
  const steps: TaskStep[] = [
    { id: "plan", title: "规划项目结构", status: "running" },
  ]

  const wantsBackend = hasAny(text, [/全栈/i, /后端/i, /api/i, /backend/i, /hono/i, /server/i])
  const wantsFrontend = hasAny(text, [/全栈/i, /前端/i, /frontend/i, /react/i, /vite/i, /页面/i])
  const wantsBlog = hasAny(text, [/博客/i, /blog/i, /posts?/i, /文章/i])
  const wantsTests = hasAny(text, [/测试/i, /test/i, /typecheck/i, /build/i, /验证/i])

  if (wantsBackend) {
    steps.push({ id: "backend", title: "创建后端接口", status: "pending" })
    addUnique(requiredFiles, "server/index.ts")
    addUnique(requiredFiles, "server/index.test.ts")
    addVerificationKind(requiredVerificationKinds, "test")
  }
  if (wantsBlog) {
    steps.push({ id: "content", title: "准备博客内容数据", status: "pending" })
    addUnique(requiredFiles, "server/posts.json")
  }
  if (wantsFrontend) {
    steps.push({ id: "frontend", title: "创建前端页面", status: "pending" })
    addUnique(requiredFiles, "client/src/App.tsx")
    addUnique(requiredFiles, "client/src/App.css")
    addVerificationKind(requiredVerificationKinds, "build")
  }
  if (wantsFrontend && wantsBackend) {
    steps.push({ id: "integration", title: "接入前后端数据流", status: "pending" })
  }
  if (wantsTests || wantsFrontend || wantsBackend) {
    steps.push({ id: "verification", title: "运行验证命令", status: "pending" })
  }

  if (hasAny(text, [/smoke/i, /browser/i, /curl/i, /api smoke/i, /娴忚鍣?/i])) {
    addVerificationKind(requiredVerificationKinds, "smoke")
  }

  return {
    goal: prompt.trim().slice(0, 120) || "长任务",
    intent,
    phase: "planning",
    requiredFiles,
    requiredVerificationKinds,
    verificationEvidence: {},
    verification,
    steps,
  }
}

export function markPlanAccepted(tracker: TaskTracker) {
  if (tracker.phase !== "planning") return
  tracker.phase = "building"
  const plan = tracker.steps.find(step => step.id === "plan")
  if (plan) {
    plan.status = "done"
    plan.evidence = "已生成执行计划"
  }
  const next = tracker.steps.find(step => step.status === "pending")
  if (next) next.status = "running"
}

/** Revise the plan — called when the agent is stuck and needs to re-plan.
 *
 *  Resets phase to planning, marks the current running step as failed
 *  with the given reason, and returns a guidance prompt for the model.
 */
export function revisePlan(tracker: TaskTracker, reason: string): string {
  // Mark current running step as failed
  const running = tracker.steps.find(s => s.status === "running")
  if (running) {
    running.status = "failed"
    running.evidence = reason.slice(0, 120)
  }

  // Mark all pending steps as cancelled (not failed — they never started)
  for (const s of tracker.steps) {
    if (s.status === "pending") s.status = "failed"
  }

  // Reset to planning
  tracker.phase = "planning"

  // Add a new "revise" step at the front so the agent knows this is a re-plan
  if (!tracker.steps.find(s => s.id === "revise")) {
    tracker.steps.unshift({ id: "revise", title: "修正方案", status: "running" })
  } else {
    const rs = tracker.steps.find(s => s.id === "revise")!
    rs.status = "running"
  }

  return [
    "<system-reminder>",
    "[方案修正] 当前方案遇到阻碍，需要重新规划。",
    `原因: ${reason}`,
    `失败步骤: ${running?.title ?? "未知"}`,
    "缩小范围，从最小可交付单元开始。不继续原方案。",
    "</system-reminder>",
  ].join("\n")
}

export function updateTaskTrackerAfterTools(input: {
  tracker: TaskTracker | null
  changedFiles: string[]
  toolNames: string[]
  typecheckPassed?: boolean
  verificationPassed?: boolean
  verificationResults?: VerificationResult[]
  /** PR 2: when true, skip hardcoded step-ID matching (backend/frontend/etc.) —
   *  packet-driven trackers use scope-1/verify-typecheck IDs instead. */
  skipLegacyStepIds?: boolean
  /** PR 6: optional evidence ledger — when provided, verification results are also ingested. */
  evidenceLedger?: EvidenceLedger
}) {
  const tracker = input.tracker
  if (!tracker || tracker.phase === "complete") return
  const files = input.changedFiles.map(file => file.replace(/\\/g, "/"))

  const markDone = (id: string, evidence: string) => {
    const step = tracker.steps.find(item => item.id === id)
    if (!step) return
    step.status = "done"
    step.evidence = evidence
  }
  const hasChangedFile = (requiredFile: string) => {
    const normalized = requiredFile.replace(/\\/g, "/")
    return files.some(file => file === normalized || file.endsWith(`/${normalized}`))
  }

  // Legacy step-ID matching — only meaningful for keyword-based trackers
  if (!input.skipLegacyStepIds) {
    if (files.some(file => file.startsWith("server/") || file.includes("/server/"))) {
      markDone("backend", "已写入后端文件")
    }
    if (files.some(file => file.includes("posts.") || file.includes("/data/"))) {
      markDone("content", "已写入内容数据")
    }
    if (files.some(file => file.startsWith("client/") || file.includes("/client/"))) {
      markDone("frontend", "已写入前端文件")
    }
    if (
      files.some(file => file.startsWith("client/") || file.includes("/client/")) &&
      (tracker.steps.find(step => step.id === "backend")?.status === "done" || files.some(file => file.startsWith("server/")))
    ) {
      markDone("integration", "已同时具备前端和后端文件")
    }
    if (input.verificationPassed) {
      markDone("verification", "验证命令通过")
    }
  } else {
    tracker.requiredFiles.forEach((file, index) => {
      if (hasChangedFile(file)) {
        markDone(`scope-${index + 1}`, `已写入 ${file}`)
      }
    })
  }

  if (input.typecheckPassed) {
    tracker.verificationEvidence.typecheck = "typecheck passed"
    if (input.skipLegacyStepIds) {
      markDone("verify-typecheck", "类型检查通过")
    }
  }
  for (const result of input.verificationResults ?? []) {
    if (result.passed) {
      tracker.verificationEvidence[result.kind] = `${verificationKindLabel(result.kind)} passed: ${result.command}`
      if (input.skipLegacyStepIds) {
        markDone(`verify-${result.kind}`, `${verificationKindLabel(result.kind)} passed: ${result.command}`)
      }
    }
  }
  if (input.verificationPassed && tracker.requiredVerificationKinds.length === 0) {
    tracker.verificationEvidence.unknown = "verification passed"
  }
  const requiredVerificationSatisfied = tracker.requiredVerificationKinds.every(kind => Boolean(tracker.verificationEvidence[kind]))
  const verificationStep = tracker.steps.find(step => step.id === "verification")
  if (verificationStep && tracker.requiredVerificationKinds.length > 0 && !requiredVerificationSatisfied) {
    verificationStep.status = "pending"
    verificationStep.evidence = `missing required verification: ${tracker.requiredVerificationKinds.filter(kind => !tracker.verificationEvidence[kind]).map(verificationKindLabel).join(", ")}`
  }
  if (requiredVerificationSatisfied) {
    markDone("verification", `楠岃瘉鍛戒护閫氳繃: ${tracker.requiredVerificationKinds.map(verificationKindLabel).join(", ")}`)
  }

  const running = tracker.steps.find(step => step.status === "running")
  if (!running || running.status === "done") {
    const next = tracker.steps.find(step => step.status === "pending")
    if (next) next.status = "running"
  }
  if (running?.status === "done") {
    const next = tracker.steps.find(step => step.status === "pending")
    if (next) next.status = "running"
  }
  if (!tracker.steps.some(step => step.status === "pending" || step.status === "running")) {
    tracker.phase = "complete"
  }

  // PR 6: also populate evidence ledger when provided
  if (input.evidenceLedger && input.verificationResults && input.verificationResults.length > 0) {
    ingestVerificationResults(input.evidenceLedger, input.verificationResults)
  }
}

export function missingTaskRequirements(tracker: TaskTracker | null, cwd = process.cwd()): string[] {
  if (!tracker) return []
  const missing: string[] = []
  for (const step of tracker.steps) {
    if (step.status !== "done") missing.push(step.title)
  }
  for (const file of tracker.requiredFiles) {
    // also check blog/ and client/ subdirectory projects
    const candidates = [file, `blog/${file}`, `client/${file}`]
    const found = candidates.some(candidate => existsSync(resolve(cwd, candidate)))
    if (!found) missing.push(`缺少文件：${file}`)
  }
  for (const kind of tracker.requiredVerificationKinds) {
    if (!tracker.verificationEvidence[kind]) missing.push(`缂哄皯楠岃瘉璇佹嵁: ${verificationKindLabel(kind)}`)
  }
  missing.push(...frontendDesignFindings(tracker, cwd))
  missing.push(...backendQualityFindings(tracker, cwd))
  return missing
}

export function frontendDesignFindings(tracker: TaskTracker | null, cwd = process.cwd()): string[] {
  if (!tracker || !hasStep(tracker, "frontend")) return []
  if (!existsSync(resolve(cwd, "client/src/App.tsx"))) return []

  const app = safeRead(cwd, "client/src/App.tsx")
  const css = [
    safeRead(cwd, "client/src/App.css"),
    safeRead(cwd, "client/src/index.css"),
  ].join("\n")
  const surface = `${app}\n${css}`
  const findings: string[] = []

  if (css.trim().length < 3200) {
    findings.push("前端设计不足：CSS 太薄，疑似功能样板而非成品界面")
  }
  if (!/@media\b/i.test(css)) {
    findings.push("前端设计不足：缺少响应式断点")
  }
  if (!/\b(grid|flex)\b/i.test(css)) {
    findings.push("前端设计不足：缺少明确布局系统")
  }
  if (!/\b(hero|featured|archive|reader|topbar|visual|cover)\b/i.test(surface)) {
    findings.push("前端设计不足：缺少首屏、精选、归档或阅读页等视觉结构")
  }
  if (!/(<img\b|background\s*:|background-image\s*:|url\(|<picture\b|<video\b|<canvas\b)/i.test(surface)) {
    findings.push("前端设计不足：缺少视觉资产或真实媒体承载")
  }

  return findings
}

export function backendQualityFindings(tracker: TaskTracker | null, cwd = process.cwd()): string[] {
  if (!tracker || !hasStep(tracker, "backend")) return []
  if (!existsSync(resolve(cwd, "server/index.ts"))) return []

  const server = safeRead(cwd, "server/index.ts")
  const tests = safeRead(cwd, "server/index.test.ts")
  const surface = `${server}\n${tests}`
  const findings: string[] = []

  if (!tests.trim()) {
    findings.push("后端质量不足：缺少 API 测试")
    return findings
  }
  if (!/\b(describe|test|it)\s*\(/i.test(tests) || !/\bfetch\s*\(/i.test(tests)) {
    findings.push("后端质量不足：测试没有真实请求 API")
  }
  if (!/(beforeAll|afterAll|server\.stop|\.stop\s*\()/i.test(tests)) {
    findings.push("后端质量不足：服务型测试必须自启自停")
  }
  if (!/(404|not found|Not found|OPTIONS|CORS|Access-Control-Allow|Content-Type|status\s*:)/i.test(surface)) {
    findings.push("后端质量不足：缺少错误路径、CORS 或响应契约处理")
  }

  return findings
}

export function taskTrackerComplete(tracker: TaskTracker | null): boolean {
  return !tracker || tracker.phase === "complete"
}

export interface TaskTrackerSnapshot {
  goal: string
  phase: TaskTracker["phase"]
  done: number
  total: number
  current: string
  steps: TaskStep[]
}

export function snapshotTaskTracker(tracker: TaskTracker | null): TaskTrackerSnapshot | null {
  if (!tracker) return null
  const done = tracker.steps.filter(step => step.status === "done").length
  const total = tracker.steps.length
  const current = tracker.steps.find(step => step.status === "running") ?? tracker.steps.find(step => step.status === "pending")
  return {
    goal: tracker.goal,
    phase: tracker.phase,
    done,
    total,
    current: current?.title ?? "all done",
    steps: tracker.steps.map(step => ({ ...step })),
  }
}

export function formatTaskTrackerStatus(tracker: TaskTracker | null): string {
  if (!tracker) return ""
  const done = tracker.steps.filter(step => step.status === "done").length
  const total = tracker.steps.length
  const current = tracker.steps.find(step => step.status === "running") ?? tracker.steps.find(step => step.status === "pending")
  return `任务追踪: ${done}/${total} ${current ? `当前：${current.title}` : "全部完成"}`
}

export function formatTaskPlanningPrompt(tracker: TaskTracker, round: number): string {
  const lines = [
    "## 长任务规划阶段",
    "你现在必须先输出项目计划和交付清单，再进入写文件阶段。",
    "如果当前目录是空项目，不要继续读取 deepseek-run.out.txt、deepseek-run.err.txt、.deepseek-code/runs 或其他运行日志。",
    round > 0
      ? "本轮不要调用工具，只输出可执行计划。"
      : "最多做一次必要的项目结构扫描；如果没有真实项目文件，直接输出计划。",
    "",
    `目标：${tracker.goal}`,
    "",
    "计划必须覆盖这些步骤：",
    ...tracker.steps.map(step => `- ${step.title}`),
    "",
    "必须交付的文件或目录：",
    ...tracker.requiredFiles.map(file => `- ${file}`),
    ...(hasStep(tracker, "frontend") ? [
      "",
      "前端设计验收：不能只做默认列表页。必须包含首屏视觉、明确排版层级、响应式 CSS、阅读页样式，以及至少一个真实视觉资产或媒体承载。",
    ] : []),
    ...(hasStep(tracker, "backend") ? [
      "",
      "后端质量验收：不能只做 happy path。必须包含真实 API 请求测试、错误路径、响应契约，并且服务型测试要自启自停。",
    ] : []),
    "",
    "验证要求：",
    ...tracker.verification.map(item => `- ${item}`),
    "Required verification evidence:",
    ...tracker.requiredVerificationKinds.map(kind => `- ${verificationKindLabel(kind)}`),
    "",
    "输出计划后停止本轮自然语言说明，等待运行时进入执行阶段。",
  ]
  return lines.join("\n")
}

export function formatTaskTrackerPrompt(tracker: TaskTracker): string {
  const lines = [
    "## 任务追踪模式",
    "这是长任务，不能因为单个 TypeScript 文件验证通过就结束。",
    "请按下面清单逐步执行。只有全部完成并验证后才能给最终答复。",
    "",
    `目标：${tracker.goal}`,
    "",
    "交付清单：",
    ...tracker.steps.map(step => `- [${step.status === "done" ? "x" : " "}] ${step.title}`),
    "",
    "必须出现的文件或目录：",
    ...tracker.requiredFiles.map(file => `- ${file}`),
    ...(hasStep(tracker, "frontend") ? [
      "",
      "前端设计验收：不能用 bare list / default demo 糊弄。必须交付有品牌感的首屏、视觉资产、响应式布局、文章卡片层级和阅读页排版。",
    ] : []),
    ...(hasStep(tracker, "backend") ? [
      "",
      "后端质量验收：必须交付 API 测试、自启自停、404/错误路径、JSON 响应契约和必要的 CORS/Content-Type 处理。",
    ] : []),
    "",
    "验证要求：",
    ...tracker.verification.map(item => `- ${item}`),
    "Required verification evidence:",
    ...tracker.requiredVerificationKinds.map(kind => `- ${verificationKindLabel(kind)}${tracker.verificationEvidence[kind] ? " passed" : ""}`),
    "",
    "下一步：从第一个未完成项继续，优先使用 write_file 或 multi_edit 批量创建相关文件，然后运行最小验证。",
  ]
  return lines.join("\n")
}
