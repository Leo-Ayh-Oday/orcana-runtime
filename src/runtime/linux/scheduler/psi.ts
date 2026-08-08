/** LR2-3（P3-B）：PSI 背压 —— Linux Pressure Stall Information。
 *
 *  读取 /proc/pressure/{cpu,memory,io}（系统级）+ cell cgroup 级
 *  （cpu.pressure 等，有委托时）。策略状态机：
 *  NORMAL → CONSTRAINED → CRITICAL → RECOVERY。
 *
 *  阈值必须从真实机器基线校准（PSI_THRESHOLD_UNCALIBRATED = 0）：
 *  - 进入 CRITICAL：memory.some.avg10 ≥ criticalEnter（高阈值）；
 *  - 退出 CRITICAL：memory.some.avg10 ≤ criticalExit（低阈值，滞后防振荡）；
 *  - RECOVERY：逐步恢复并发（不允许瞬间回到满并发）。
 */

import { readFileSync } from "node:fs"

export type PsiResource = "cpu" | "memory" | "io"
export type PressureState = "NORMAL" | "CONSTRAINED" | "CRITICAL" | "RECOVERY"

export interface PsiReading {
  resource: PsiResource
  some: { avg10: number; avg60: number; avg300: number; total: number }
  full?: { avg10: number; avg60: number; avg300: number; total: number }
}

export interface PsiThresholds {
  /** CONSTRAINED 进入阈值（some.avg10）。 */
  constrainedEnter: number
  /** CRITICAL 进入阈值（memory.some.avg10 —— 内存压力最影响调度）。 */
  criticalEnter: number
  /** 退出阈值（滞后 —— 防止振荡）。 */
  criticalExit: number
}

export const DEFAULT_PSI_THRESHOLDS: PsiThresholds = {
  constrainedEnter: 10,
  criticalEnter: 40,
  criticalExit: 15,
}

/** PSI 阈值校准（PSI_THRESHOLD_UNCALIBRATED = 0）：基于本机空闲基线
 *  推导阈值（不复制云服务器参数）。
 *  - 空闲压力基线 p50（空闲负载读数）；
 *  - constrainedEnter = max(10, baseline × 20)（空闲基线 20 倍以上才算约束）；
 *  - criticalEnter = max(40, baseline × 50)；
 *  - criticalExit = criticalEnter × 0.4（滞后退出）。
 *  M1 修复：全部钳制到 [0,100]（PSI avg10 是百分比 —— 超 100 的阈值
 *  永远不可达，背压静默失效）；constrainedEnter ≤ criticalEnter。 */
export function calibratePsiThresholds(samples: number[]): PsiThresholds {
  const sorted = [...samples].sort((a, b) => a - b)
  const baseline = sorted.length > 0 ? sorted[Math.floor(sorted.length * 0.5)]! : 0
  const constrainedEnter = Math.min(100, Math.max(10, baseline * 20))
  const criticalEnter = Math.min(100, Math.max(40, baseline * 50, constrainedEnter))
  return {
    constrainedEnter,
    criticalEnter,
    criticalExit: Math.min(criticalEnter, criticalEnter * 0.4),
  }
}

/** 解析 /proc/pressure/<res> 的一行（avg10=.. avg60=.. avg300=.. total=..）。 */
export function parsePsiLine(line: string): { avg10: number; avg60: number; avg300: number; total: number } {
  const values: Record<string, number> = {}
  for (const part of line.trim().split(/\s+/)) {
    const [key, value] = part.split("=")
    if (key && value !== undefined) values[key] = Number(value)
  }
  return {
    avg10: values["avg10"] ?? 0,
    avg60: values["avg60"] ?? 0,
    avg300: values["avg300"] ?? 0,
    total: values["total"] ?? 0,
  }
}

/** 读取系统级 PSI（文件缺失 → undefined）。 */
export function readSystemPsi(resource: PsiResource): PsiReading | undefined {
  try {
    const lines = readFileSync(`/proc/pressure/${resource}`, "utf8").split("\n").filter(l => l.trim())
    const reading: PsiReading = { resource, some: parsePsiLine(lines[0] ?? "") }
    if (lines[1]?.startsWith("full")) reading.full = parsePsiLine(lines[1])
    return reading
  } catch {
    return undefined
  }
}

export interface SchedulerDecision {
  state: PressureState
  /** true = 暂停新 build/test（保留交互任务）。 */
  pauseNewBuilds: boolean
  /** true = 停止低优先级预取/Evolution。 */
  stopLowPriorityPrefetch: boolean
  /** true = 逐步恢复并发（RECOVERY 状态）。 */
  gradualRecovery: boolean
  /** 并发上限建议（0 = 不限）。 */
  concurrencyCap: number
}

/** PSI 背压状态机（带滞后阈值的状态转换）。
 *  M5 修复：RECOVERY 带爬坡 —— 压力悬在死区（[constrainedEnter,
 *  criticalExit)）时并发上限逐级恢复（2→3→4→5→6），不会永久停在 2。 */
export class PsiBackpressure {
  private state: PressureState = "NORMAL"
  /** RECOVERY 爬坡等级（0-4，对应 cap 2-6）。 */
  private recoveryLevel = 0

  constructor(
    private readonly thresholds: PsiThresholds = DEFAULT_PSI_THRESHOLDS,
    private readonly readPsi: (resource: PsiResource) => PsiReading | undefined = readSystemPsi,
  ) {}

  get current(): PressureState {
    return this.state
  }

  /** 读一次压力并推进状态机。
   *  M2 修复：非有限读数（NaN/Infinity）按 0 处理 —— NaN 会让所有比较
   *  恒 false（CRITICAL 下卡死暂停构建 / NORMAL 下掩盖真实压力）。 */
  tick(): SchedulerDecision {
    const memory = this.readPsi("memory")
    const cpu = this.readPsi("cpu")
    const io = this.readPsi("io")
    const finite = (v: number | undefined): number => (v !== undefined && Number.isFinite(v) ? v : 0)
    const memPressure = finite(memory?.some.avg10)
    const cpuPressure = finite(cpu?.some.avg10)
    const ioPressure = finite(io?.some.avg10)
    const peak = Math.max(memPressure, cpuPressure, ioPressure)

    switch (this.state) {
      case "NORMAL":
        if (peak >= this.thresholds.criticalEnter) this.state = "CRITICAL"
        else if (peak >= this.thresholds.constrainedEnter) this.state = "CONSTRAINED"
        break
      case "CONSTRAINED":
        if (peak >= this.thresholds.criticalEnter) this.state = "CRITICAL"
        else if (peak < this.thresholds.constrainedEnter) this.state = "NORMAL"
        break
      case "CRITICAL":
        // 滞后：必须低于 criticalExit 才退出（防振荡）
        if (peak <= this.thresholds.criticalExit) {
          this.state = "RECOVERY"
          this.recoveryLevel = 0
        }
        break
      case "RECOVERY":
        if (peak >= this.thresholds.criticalEnter) {
          this.state = "CRITICAL"
          this.recoveryLevel = 0
        } else if (peak < this.thresholds.constrainedEnter) {
          this.state = "NORMAL"
          this.recoveryLevel = 0
        } else {
          // M5 爬坡：压力仍高于 constrainedEnter（死区）→ 逐级恢复并发
          this.recoveryLevel = Math.min(this.recoveryLevel + 1, 4)
        }
        break
    }

    return this.decision()
  }

  private decision(): SchedulerDecision {
    switch (this.state) {
      case "NORMAL":
        return { state: "NORMAL", pauseNewBuilds: false, stopLowPriorityPrefetch: false, gradualRecovery: false, concurrencyCap: 0 }
      case "CONSTRAINED":
        return { state: "CONSTRAINED", pauseNewBuilds: false, stopLowPriorityPrefetch: true, gradualRecovery: false, concurrencyCap: 0 }
      case "CRITICAL":
        return { state: "CRITICAL", pauseNewBuilds: true, stopLowPriorityPrefetch: true, gradualRecovery: false, concurrencyCap: 0 }
      case "RECOVERY":
        // M5：cap 逐级恢复（2 + recoveryLevel）
        return { state: "RECOVERY", pauseNewBuilds: false, stopLowPriorityPrefetch: true, gradualRecovery: true, concurrencyCap: 2 + this.recoveryLevel }
    }
  }
}
