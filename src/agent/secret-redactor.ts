/** SecretRedactor — unified secret/PII redaction for all output channels.
 *
 *  PR-5.4: Single shared redactor used by run-trace, checkpoint, evidence-ledger,
 *  and tool-output. Ensures secret-like content never enters prompt, trace,
 *  or checkpoint storage.
 *
 *  Redaction rules (in priority order):
 *    1. Key-based: any object key matching secret patterns → value redacted
 *    2. Content-based: string values matching credential patterns → redacted
 *    3. Structural: depth limit + length limit to prevent context bloat
 *
 *  Design invariants:
 *    - Zero LLM dependency — pure regex + structural scanning
 *    - Fail-open for data: if we can't parse, pass through (don't block data)
 *    - Fail-closed for secrets: if we see a secret pattern, ALWAYS redact
 */

// ── Key-based patterns (object keys that trigger value redaction) ──

const SECRET_KEY_PATTERNS = [
  /api[_-]?key/i,
  /apikey/i,
  /secret/i,
  /token/i,
  /password/i,
  /passwd/i,
  /authorization/i,
  /auth[_-]?token/i,
  /bearer/i,
  /credential/i,
  /private[_-]?key/i,
  /access[_-]?key/i,
  /session[_-]?token/i,
  /refresh[_-]?token/i,
  /jwt/i,
  /signing[_-]?key/i,
  /encryption[_-]?key/i,
]

// ── Content-based patterns (string values that look like secrets) ──

const SECRET_CONTENT_PATTERNS: RegExp[] = [
  // Private keys
  /-----BEGIN\s+(?:RSA\s+)?PRIVATE\s+KEY-----/,
  /-----BEGIN\s+EC\s+PRIVATE\s+KEY-----/,
  /-----BEGIN\s+DSA\s+PRIVATE\s+KEY-----/,
  /-----BEGIN\s+OPENSSH\s+PRIVATE\s+KEY-----/,
  /-----BEGIN\s+PGP\s+PRIVATE\s+KEY\s+BLOCK-----/,

  // API key formats
  /sk-[a-zA-Z0-9_-]{20,}/,                         // OpenAI/Anthropic/DeepSeek style
  /sk-ant-[a-zA-Z0-9_-]{20,}/,                     // Anthropic API key
  /dsk-[a-zA-Z0-9_-]{20,}/,                         // DeepSeek API key
  /AKIA[0-9A-Z]{16}/,                              // AWS Access Key
  /ghp_[a-zA-Z0-9]{36}/,                           // GitHub Personal Access Token (classic)
  /github_pat_[a-zA-Z0-9_]{20,}/,                  // GitHub PAT (fine-grained)
  /gho_[a-zA-Z0-9]{36}/,                           // GitHub OAuth
  /ghu_[a-zA-Z0-9]{36}/,                           // GitHub User-to-Server
  /ghs_[a-zA-Z0-9]{36}/,                           // GitHub Server-to-Server
  /xox[bpras]-[a-zA-Z0-9-]{10,}/,                  // Slack tokens
  /eyJ[a-zA-Z0-9_-]{10,}\.[a-zA-Z0-9_-]{10,}\.[a-zA-Z0-9_-]{10,}/,  // JWT triplets

  // Connection strings
  /mongodb(?:\+srv)?:\/\/[^@\s]+@/,                // MongoDB
  /postgres(?:ql)?:\/\/[^@\s]+@/,                  // PostgreSQL
  /mysql:\/\/[^@\s]+@/,                            // MySQL
  /redis:\/\/[^@\s]+@/,                            // Redis
  /sqlite:\/\/[^@\s]+@/,                           // SQLite with auth (unusual)

  // Generic credential patterns
  /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}:[^\s]{8,}/,  // email:password in URLs

  // Private IP + credential
  /(?:https?:\/\/)?[^:@\s]{3,}:[^:@\s]{8,}@(?:\d{1,3}\.){3}\d{1,3}/,
]

// ── Redaction constants ──

const REDACTED_PLACEHOLDER = "[redacted]"
const TRUNCATED_SUFFIX = "...[truncated]"
const MAX_STRING_LENGTH = 2000
const MAX_ARRAY_LENGTH = 50
const MAX_OBJECT_KEYS = 80
const MAX_DEPTH = 4

// ── Public API ──

export interface RedactorOptions {
  /** Maximum depth for recursive redaction (default 4). */
  maxDepth?: number
  /** Maximum string length before truncation (default 2000). */
  maxStringLength?: number
  /** Additional key patterns to redact (project-specific). */
  extraKeyPatterns?: RegExp[]
  /** Additional content patterns to redact. */
  extraContentPatterns?: RegExp[]
}

/**
 * Redact secrets from any value. Safe to call on primitives, objects,
 * arrays, or deeply nested structures.
 *
 * Used by:
 *   - run-trace.ts: sanitize trace events before writing to JSONL
 *   - checkpoint.ts: sanitize checkpoint data before saving
 *   - evidence-ledger.ts: sanitize evidence entries
 *   - tool output: sanitize tool results before returning to model
 */
export function redact(value: unknown, opts: RedactorOptions = {}): unknown {
  return redactInternal(value, 0, opts)
}

function redactInternal(value: unknown, depth: number, opts: RedactorOptions): unknown {
  const maxDepth = opts.maxDepth ?? MAX_DEPTH
  const maxStringLength = opts.maxStringLength ?? MAX_STRING_LENGTH

  if (depth > maxDepth) return TRUNCATED_SUFFIX

  // Primitives
  if (value === null || value === undefined) return value
  if (typeof value === "number" || typeof value === "boolean") return value

  // Strings — check for secret content
  if (typeof value === "string") {
    const s: string = value.length > maxStringLength
      ? value.slice(0, maxStringLength) + TRUNCATED_SUFFIX
      : value
    return redactStringContent(s, opts)
  }

  // Arrays
  if (Array.isArray(value)) {
    return value.slice(0, MAX_ARRAY_LENGTH).map(item => redactInternal(item, depth + 1, opts))
  }

  // Objects
  if (typeof value === "object") {
    const out: Record<string, unknown> = {}
    const entries = Object.entries(value as Record<string, unknown>).slice(0, MAX_OBJECT_KEYS)
    for (const [key, val] of entries) {
      if (isSecretKey(key, opts)) {
        out[key] = REDACTED_PLACEHOLDER
      } else {
        out[key] = redactInternal(val, depth + 1, opts)
      }
    }
    return out
  }

  return String(value)
}

// ── Key checking ──

function isSecretKey(key: string, opts: RedactorOptions): boolean {
  const patterns = [...SECRET_KEY_PATTERNS, ...(opts.extraKeyPatterns ?? [])]
  for (const p of patterns) {
    if (p.test(key)) return true
  }
  return false
}

// ── Content checking ──

function redactStringContent(value: string, opts: RedactorOptions): string {
  const patterns = [...SECRET_CONTENT_PATTERNS, ...(opts.extraContentPatterns ?? [])]
  for (const p of patterns) {
    if (p.test(value)) return REDACTED_PLACEHOLDER
  }
  return value
}

// ── Convenience: redact for specific channels ──

/**
 * Redact trace event data before writing to run-trace JSONL.
 * Stricter than general redaction — redacts anything that might
 * contain secrets in unstructured data.
 */
export function redactForTrace(data: unknown): unknown {
  return redact(data, {
    maxStringLength: 2000,
    maxDepth: 4,
  })
}

/**
 * Redact checkpoint data before saving to SQLite.
 */
export function redactForCheckpoint(data: unknown): unknown {
  return redact(data, {
    maxStringLength: 1000,
    maxDepth: 4,
  })
}

/**
 * Redact evidence entries before storing.
 */
export function redactForEvidence(data: unknown): unknown {
  return redact(data, {
    maxStringLength: 2000,
    maxDepth: 3,
  })
}

/**
 * Redact tool output before returning to the model context.
 * Most permissive — we want to keep useful output but catch obvious secrets.
 */
export function redactForToolOutput(data: unknown): unknown {
  return redact(data, {
    maxStringLength: 5000,
    maxDepth: 4,
  })
}

/**
 * Check if a string contains any secret-like patterns.
 * Used for pre-flight checks before storing data.
 */
export function containsSecret(value: string): boolean {
  for (const p of SECRET_CONTENT_PATTERNS) {
    if (p.test(value)) return true
  }
  return false
}
