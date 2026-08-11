import { providerRetryFingerprint, type RetryLedger } from "../runtime/retry-ledger"
import { providerFinishReasonFromErrorKind, type ProviderFinishInfo, type StreamEvent } from "./types"

export type ProviderErrorKind = "rate_limit" | "server" | "network" | "auth" | "client" | "capacity" | "quota" | "unknown"

export interface ProviderErrorInfo {
  kind: ProviderErrorKind
  retryable: boolean
  status?: number
  retryAfterMs?: number
  message: string
}

export function classifyProviderError(error: unknown): ProviderErrorInfo {
  const record = isRecord(error) ? error : {}
  const response = isRecord(record.response) ? record.response : undefined
  const status = numberValue(record.status) ?? numberValue(record.statusCode) ?? numberValue(response?.status)
  const message = error instanceof Error
    ? error.message
    : typeof record.message === "string"
    ? record.message
    : String(error)
  const retryAfterMs = retryAfterHeaderMs(record.headers) ?? retryAfterHeaderMs(response?.headers)

  // Check response body for DeepSeek-specific error types
  const body = responseBody(record.response) ?? responseBody(record.error) ?? responseBody(record)
  const bodyError = isRecord(body?.error) ? body.error as Record<string, unknown> : undefined
  const dsErrorType = typeof body?.type === "string" ? body.type : typeof bodyError?.type === "string" ? bodyError.type : undefined
  const isCapacityError = dsErrorType ? /capacity_error|model_overloaded|busy|upstream_error|overloaded/i.test(dsErrorType) : false
  const diagnosticText = [
    message,
    typeof record.code === "string" ? record.code : "",
    typeof body?.message === "string" ? body.message : "",
    typeof bodyError?.message === "string" ? bodyError.message : "",
    typeof body?.code === "string" ? body.code : "",
    typeof bodyError?.code === "string" ? bodyError.code : "",
    typeof body?.type === "string" ? body.type : "",
    typeof bodyError?.type === "string" ? bodyError.type : "",
  ].join(" ")
  const isQuotaError = /insufficient[_\s-]*quota|quota[_\s-]*(?:exceeded|insufficient)|(?:exceeded|insufficient)[_\s-]*quota|balance|billing|payment\s*required|prepaid|credits?|额度|余额|欠费|账户余额|资源包|套餐/i.test(diagnosticText)

  // 408 Request Timeout is a transient server-side timeout (proxy/load balancer)
  if (status === 408) return { kind: "network", retryable: true, status, retryAfterMs, message }
  if (status === 402 || isQuotaError) return { kind: "quota", retryable: false, status, message }
  if (status === 429) return { kind: "rate_limit", retryable: true, status, retryAfterMs, message }
  if (isCapacityError) return { kind: "capacity", retryable: true, status, retryAfterMs, message }
  if (status && status >= 500 && status <= 599) return { kind: "server", retryable: true, status, retryAfterMs, message }
  if (status === 401 || status === 403) return { kind: "auth", retryable: false, status, message }
  if (status && status >= 400 && status <= 499) return { kind: "client", retryable: false, status, message }

  const code = String(record.code ?? "").toUpperCase()
  if (
    code === "ETIMEDOUT" ||
    code === "ECONNRESET" ||
    code === "ECONNREFUSED" ||
    code === "ENOTFOUND" ||
    code === "ECONNABORTED" ||
    code === "ERR_CANCELED" ||
    code === "ABORT_ERR" ||
    code === "EAI_AGAIN" ||
    code === "EPIPE" ||
    (code.startsWith("UND_ERR_") && /SOCKET|HEADERS_TIMEOUT|BODY_TIMEOUT|CONNECT_TIMEOUT/i.test(code)) ||
    (code.startsWith("ERR_SSL_")) ||
    /timeout|timed out|connection reset|network|fetch failed|socket connection was closed|socket.*closed|stream.*closed|socket hang up|unexpected event order|message_start before|aborted|request aborted|stream ended unexpectedly/i.test(message)
  ) {
    return { kind: "network", retryable: true, message }
  }

  return { kind: "unknown", retryable: false, status, message }
}

const MAX_RETRY_AFTER_MS = 60_000

export function providerRetryDelayMs(info: ProviderErrorInfo, attempt: number): number {
  if (info.retryAfterMs !== undefined) return Math.min(info.retryAfterMs, MAX_RETRY_AFTER_MS)
  // Capacity errors need longer backoff (DeepSeek may be under heavy load)
  const base = info.kind === "capacity" ? 5_000 : info.kind === "rate_limit" ? 2_000 : 1_000
  return Math.min(30_000, base * 2 ** attempt)
}

export function canRetryProviderAttempt(
  info: ProviderErrorInfo,
  attempt: number,
  maxRetries: number,
  unsafeToRetry: boolean,
  ledger?: RetryLedger,
): boolean {
  if (!info.retryable || unsafeToRetry) return false
  // PR-GATE-06：注入 Run 级 RetryLedger 时，预算由统一账本裁决（rate_limit
  // → rateLimit 类，其余 retryable（server/network/capacity）→ transport
  // 类），构造时 maxRetries 仅作无 ledger 时的 legacy 兜底。
  if (ledger) {
    const retryClass = info.kind === "rate_limit" ? "rateLimit" : "transport"
    return ledger.canRetry(retryClass, providerRetryFingerprint(info.kind, info.status))
  }
  return attempt < maxRetries
}

/** PR-GATE-06：实际发起一次重试前记账（返回本次重试计数）。 */
export function recordProviderRetry(
  info: ProviderErrorInfo,
  ledger: RetryLedger | undefined,
): void {
  if (!ledger) return
  const retryClass = info.kind === "rate_limit" ? "rateLimit" : "transport"
  ledger.record(retryClass, providerRetryFingerprint(info.kind, info.status))
}

/**
 * Abort-aware retry backoff (RC-19 ABORT_RETRIED). Resolves false when the
 * abort signal fires before the delay elapsed — the caller must NOT issue
 * another request. The injected sleep keeps test seams working (tests abort
 * inside the sleep and assert no further fetch).
 */
export function providerBackoffWait(
  delayMs: number,
  signal: AbortSignal | undefined,
  sleep: (ms: number) => Promise<void> = ms => new Promise(resolve => setTimeout(resolve, ms)),
): Promise<boolean> {
  if (signal?.aborted) return Promise.resolve(false)
  return new Promise(resolve => {
    let settled = false
    const onAbort = () => finish(false)
    const finish = (ok: boolean) => {
      if (settled) return
      settled = true
      signal?.removeEventListener("abort", onAbort)
      resolve(ok)
    }
    signal?.addEventListener("abort", onAbort, { once: true })
    void sleep(delayMs).then(() => finish(true), () => finish(true))
  })
}

export function formatProviderRetryStatus(info: ProviderErrorInfo, delayMs: number, attempt: number, maxRetries: number): string {
  const label = info.status ? `${info.kind} ${info.status}` : info.kind
  const seconds = Math.ceil(delayMs / 1000)
  return `provider retry: ${label}, waiting ${seconds}s (${attempt + 1}/${maxRetries})`
}

function retryAfterHeaderMs(headers: unknown): number | undefined {
  if (!headers) return undefined
  let raw: unknown
  if (typeof (headers as { get?: unknown }).get === "function") {
    raw = (headers as { get(name: string): unknown }).get("retry-after")
  } else if (isRecord(headers)) {
    raw = headers["retry-after"] ?? headers["Retry-After"]
  }
  if (raw === undefined || raw === null) return undefined
  const value = String(raw).trim()
  const seconds = Number(value)
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000
  const dateMs = Date.parse(value)
  if (Number.isFinite(dateMs)) return Math.max(0, dateMs - Date.now())
  return undefined
}

function responseBody(response: unknown): Record<string, unknown> | undefined {
  if (!isRecord(response)) return undefined
  // Anthropic SDK stores response data in different locations
  const data = response.data ?? response.body ?? response.jsonBody
  return isRecord(data) ? data as Record<string, unknown> : undefined
}

function numberValue(value: unknown): number | undefined {
  const n = Number(value)
  return Number.isFinite(n) ? n : undefined
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}

// ── IC04 §34: coordinator deny 终止（结构化 finish + 最后一次真实失败）──

/**
 * Provider retry authority 决定不再发起同 request 时，以最后一次真实
 * provider 失败终止（结构化 finish 事件）。legacy 路径（无 coordinator）
 * 由 canRetryProviderAttempt/recordProviderRetry 维持原语义（§35）。
 */
export function* denyProviderRetryFinish(lastInfo: ProviderErrorInfo): Generator<StreamEvent> {
  const message = lastInfo.status
    ? `${lastInfo.kind} ${lastInfo.status}: ${lastInfo.message}`
    : `${lastInfo.kind}: ${lastInfo.message}`
  yield { type: "error", data: message }
  yield {
    type: "finish",
    data: {
      finishReason: providerFinishReasonFromErrorKind(lastInfo.kind),
      rawStopReason: undefined,
      completedToolCallCount: 0,
      partialToolCall: false,
    } satisfies ProviderFinishInfo,
  }
}

// ── IC04 §31: run-scoped RetryCoordinator wrapper ──

/**
 * 包装 provider 使其所有 ProviderCallOptions 自动携带 run-scoped
 * RetryCoordinator —— FlashTriage/FlashJudge/compaction/主 round 等只要
 * 拿的是被包装的 provider 实例，都继承同一 retry authority（§31）。
 * 未被包装的 standalone provider 走 legacy maxRetries（§35）。
 */
export function withRetryCoordinator(
  provider: import("./types").LLMProvider,
  coordinator: import("../runtime/retry/coordinator").RetryCoordinator | undefined,
): import("./types").LLMProvider {
  if (!coordinator) return provider
  const original = provider.streamChat.bind(provider)
  return {
    ...provider,
    /**
     * IC04 §23: initial physical attempt 在 wrapper 层授权（每次 streamChat
     * 调用 = 1 physical provider request）——与底层 provider 是否读取
     * options.retryCoordinator 无关（custom/scripted provider 同样计数）。
     * production provider 内部的 retry（同一 streamChat 内循环）仍由自身
     * authorize（§34）。deny → cancellation 语义结构化终止（§44）。
     */
    async *streamChat(options: import("./types").ProviderCallOptions) {
      const permit = coordinator.authorizeProviderAttempt({})
      if (!permit.allowed) {
        yield { type: "error", data: "provider request not issued: physical provider request budget exhausted" }
        yield {
          type: "finish",
          data: {
            finishReason: "cancelled",
            rawStopReason: undefined,
            completedToolCallCount: 0,
            partialToolCall: false,
          } satisfies import("./types").ProviderFinishInfo,
        }
        return
      }
      yield* original({ ...options, retryCoordinator: coordinator })
    },
  }
}
