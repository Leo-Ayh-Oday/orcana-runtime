/** GS-P5 fingerprint primitives —— 确定性观察指纹 + run-scoped seen-set + recon 预算。
 *
 *  Progress 与 Activity 的边界由这里的指纹决定：
 *    - read 类观察：id = digest(name + input + output)。同 id 已见 → 重复观察（不算进展）。
 *    - command 类观察：双指纹 —— cmdId（命令身份）与 outId（命令+输出）。
 *      outId 已见 → 完全重复；cmdId 已见而 outId 新 → 新输出探索增量；
 *      cmdId 未见 → 新命令。
 *    - verification 类观察：vid = digest(kind + command + passed)。同 vid 重复不算；
 *      另维护 lastVerifyByCommand —— FAIL↔PASS 转换是 evidence 增量。
 *
 *  seen-set 生命周期 = ProgressGovernor 实例（run-scoped）。phase 切换不清空
 *  （DIAGNOSE 重读 RECON 读过的文件仍是重复——防重读刷分）。
 */

import { createHash } from "node:crypto"

export const PROGRESS_SEEN_CAP_DEFAULT = 1024
export const PROGRESS_RECON_BUDGET_DEFAULT = 20

/** 稳定摘要：sha256 hex 前 16 字符（与 monitor.ts/workspace-lease.ts 同惯例）。 */
export function stableDigest(parts: string[]): string {
  const hash = createHash("sha256")
  for (const part of parts) hash.update(part)
  return hash.digest("hex").slice(0, 16)
}

/** 输入 canonicalize：递归键排序的稳定 JSON（对象键序不影响指纹）。
 *
 *  LR2-0 provenance bug 修复：原实现只排序顶层键，嵌套对象经
 *  JSON.stringify 保持原始键序 —— 键序不同但逻辑相同的嵌套输入会产出
 *  不同指纹（与 receipt.ts 的 canonicalJson 语义不一致）。这里递归展开：
 *  - 对象：键排序后递归，值为 undefined 的键被丢弃（与 JSON.stringify 一致）；
 *  - 数组：逐元素递归（undefined 元素 → "null"）；
 *  - 其余值交给 JSON.stringify（number/string/bool/null/NaN→null）；
 *  顶层 undefined → "null"（与 canonicalJson 一致）。
 */
export function canonicalInput(input: unknown): string {
  return canonicalStringify(input)
}

function canonicalStringify(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value) ?? "null"
  }
  if (Array.isArray(value)) {
    return "[" + value.map(v => canonicalStringify(v)).join(",") + "]"
  }
  const obj = value as Record<string, unknown>
  const keys = Object.keys(obj).filter(k => obj[k] !== undefined).sort()
  return "{" + keys.map(k => JSON.stringify(k) + ":" + canonicalStringify(obj[k])).join(",") + "}"
}

/** 从 toolResult 提取输出文本（best-effort：content 缺失时退化为空串）。 */
export function outputTextOf(result: unknown): string {
  if (result === null || result === undefined || typeof result !== "object") return ""
  const rec = result as Record<string, unknown>
  if (typeof rec.content === "string") return rec.content
  if (typeof rec.output === "string") return rec.output
  if (rec.content !== undefined) return JSON.stringify(rec.content)
  return ""
}

/** run-scoped 观察去重集合（近似 LRU：超 cap 淘汰最旧 25%）。 */
export class FingerprintLedger {
  private seen = new Map<string, number>()
  private order: string[] = []

  constructor(readonly cap: number = PROGRESS_SEEN_CAP_DEFAULT) {}

  /** 记录观察指纹；返回是否首次见到（novel）。 */
  note(id: string): boolean {
    if (this.seen.has(id)) return false
    this.seen.set(id, this.order.length)
    this.order.push(id)
    if (this.order.length > this.cap) this.evictOldest(Math.ceil(this.cap * 0.25))
    return true
  }

  private evictOldest(count: number): void {
    for (let i = 0; i < count && this.order.length > 0; i++) {
      const oldest = this.order.shift()
      if (oldest !== undefined) this.seen.delete(oldest)
    }
  }

  /** read 类观察：id = digest(name + input + output)；返回是否 novel。 */
  noteRead(name: string, input: unknown, output: unknown): boolean {
    return this.note(stableDigest(["read", name, canonicalInput(input), outputTextOf(output)]))
  }

  /** command 类观察：双指纹。cmdNovel=新命令；outNovel=同命令新输出。 */
  noteCommand(name: string, input: unknown, output: unknown): { cmdNovel: boolean; outNovel: boolean } {
    const cmdId = stableDigest(["cmd", name, canonicalInput(input)])
    const outId = stableDigest(["out", name, canonicalInput(input), outputTextOf(output)])
    const cmdNovel = this.note(cmdId)
    const outNovel = this.note(outId)
    return { cmdNovel, outNovel }
  }

  /** verification 类观察。resultNovel=该 (kind,command,passed) 组合首次见；
   *  verdictChanged = 同一命令的通过/失败判定发生翻转（FAIL↔PASS）。 */
  noteVerification(
    kind: string,
    command: string,
    passed: boolean,
  ): { resultNovel: boolean; verdictChanged: boolean } {
    const vid = stableDigest(["verify", kind, command, String(passed)])
    const resultNovel = this.note(vid)
    const prev = this.verifyVerdicts.get(command)
    const verdictChanged = prev !== undefined && prev !== passed
    this.verifyVerdicts.set(command, passed)
    return { resultNovel, verdictChanged }
  }

  /** 重复观察统计（STALLED 报告用）：本轮命中的已见指纹数。 */
  private repeats = 0

  /** 记录一次重复观察（调用方在 note* 返回 false 时调用）。 */
  noteRepeat(): void {
    this.repeats++
  }

  /** 本次 run 累计重复观察次数（重读/同命令同输出/同验证结果）。 */
  get repeatCount(): number {
    return this.repeats
  }

  private verifyVerdicts = new Map<string, boolean>()
}

/** GS-P5 recon 预算：只约束 epistemic 维度。超限后 novel read 不再产生 progress。
 *  预算随阶段切换 reset（由 governor 调用）。 */
export class ReconBudget {
  used = 0

  constructor(readonly limit: number = PROGRESS_RECON_BUDGET_DEFAULT) {}

  get exhausted(): boolean {
    return this.used >= this.limit
  }

  /** 尝试花费 1 个 recon 名额；超限返回 false。 */
  trySpend(): boolean {
    if (this.exhausted) return false
    this.used++
    return true
  }

  reset(): void {
    this.used = 0
  }
}
