/** LR2-2（P2-B）：缓存对象状态机（计划 §6.2）。
 *
 *  STAGING（写入中）→ VALID（已发布）→ EVICTING（淘汰中）；
 *  STAGING/写入校验失败 → INVALID；检测到污染/损坏 → QUARANTINED。
 *  只有 VALID 可被消费者读取（QUARANTINED/INVALID 拒绝读取）。
 */

export type CacheObjectState = "STAGING" | "VALID" | "QUARANTINED" | "INVALID" | "EVICTING"

export const READABLE_CACHE_STATES: ReadonlySet<CacheObjectState> = new Set(["VALID"])

export interface CacheObjectRecord {
  digest: string
  state: CacheObjectState
  bytes: number
  producerRunId?: string
  producerCellId?: string
  createdAt: number
  quarantinedReason?: string
}
