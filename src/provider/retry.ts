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

export function providerRetryDelayMs(info: ProviderErrorInfo, attempt: number): number {
  if (info.retryAfterMs !== undefined) return info.retryAfterMs
  // Capacity errors need longer backoff (DeepSeek may be under heavy load)
  const base = info.kind === "capacity" ? 5_000 : info.kind === "rate_limit" ? 2_000 : 1_000
  return Math.min(30_000, base * 2 ** attempt)
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
