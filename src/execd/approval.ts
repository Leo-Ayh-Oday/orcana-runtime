/** LR2-1v2（L2-D）：approvalToken 校验 —— 受信 token 源 + 逐操作校验。
 *
 *  v1 信任客户端（M17 遗留）。v2：
 *  - execd 启动注入受信 token 源（env / 调用方提供）；
 *  - SubmitCell 必须携带 approvalToken 且匹配 → 否则 UNAUTHORIZED_APPROVAL
 *    拒绝（不启动 Cell）；
 *  - Cancel 类操作（CancelCell/CancelAgent/CancelRun/CleanupRun）同样校验
 *    （持有 token 才可取消/清理 —— 防未授权方终止他人执行）；
 *  - 幂等重试不受影响：已缓存的响应在 token 校验之后查询。
 */

import { createHash, timingSafeEqual } from "node:crypto"

export interface ApprovalTokenProvider {
  /** 当前受信 token 列表（可空 = 未配置 → 拒绝一切授权操作）。 */
  currentTokens(): string[]
  /** token 是否受信（恒定时间比较）。 */
  isValid(token: string | undefined): boolean
}

/** env 注入式 token 源：ORCANA_EXECD_APPROVAL_TOKEN（可逗号分隔多个）。 */
export function envApprovalTokenProvider(env: NodeJS.ProcessEnv = process.env): ApprovalTokenProvider {
  const raw = env.ORCANA_EXECD_APPROVAL_TOKEN ?? ""
  const tokens = raw.split(",").map(t => t.trim()).filter(t => t.length > 0)
  return fixedApprovalTokenProvider(tokens)
}

/** 固定 token 列表（测试/启动注入）。 */
export function fixedApprovalTokenProvider(tokens: string[]): ApprovalTokenProvider {
  const digests = tokens.map(t => digest(t))
  return {
    currentTokens: () => [...tokens],
    isValid(token: string | undefined): boolean {
      if (!token || digests.length === 0) return false
      const d = digest(token)
      return digests.some(known => constantTimeEqual(d, known))
    },
  }
}

function digest(token: string): Buffer {
  return createHash("sha256").update(token, "utf8").digest()
}

function constantTimeEqual(a: Buffer, b: Buffer): boolean {
  return a.length === b.length && timingSafeEqual(a, b)
}

export type ApprovalVerdict =
  | { ok: true }
  | { ok: false; reason: string }

/** 校验操作授权（默认要求 token；allowlist 可选豁免 —— 如 Hello/GetCell
 *  这类只读查询可豁免，由调用方决定）。 */
export function checkApproval(provider: ApprovalTokenProvider, token: string | undefined, operation: string): ApprovalVerdict {
  if (provider.isValid(token)) return { ok: true }
  return { ok: false, reason: `UNAUTHORIZED_APPROVAL: ${operation} requires valid approvalToken` }
}
