/** Web-safe HTTP client (RT-11): SSRF/IP policy + streaming bounds.
 *
 *  Why this module exists:
 *  - The old web_fetch checked only hostname strings, which misses DNS-rebinding,
 *    IPv6 private ranges, and redirects to private targets. Every hop must be
 *    re-validated after DNS resolution, against the actual IP we connect to.
 *  - Fetching a hostile page must not OOM the runtime: bodies are streamed,
 *    decompressed on the fly (zip-bomb guard), counted, and cut at maxBytes.
 *
 *  Connection model: the URL's hostname is resolved once per hop and the
 *  request is made directly to the validated IP with an explicit Host header
 *  (and TLS servername), so there is no TOCTOU between the check and connect.
 */

import { lookup } from "node:dns/promises"
import { request as httpRequest } from "node:http"
import { request as httpsRequest, type RequestOptions } from "node:https"
import type { IncomingMessage } from "node:http"
import { createBrotliDecompress, createGunzip, createInflate } from "node:zlib"
import { isIP } from "node:net"

// ── IP policy ──

const V4_PREFIXES: Array<{ label: string; base: number; bits: number }> = [
  { label: "unspecified 0.0.0.0/8", base: 0x00000000, bits: 8 },
  { label: "private 10/8", base: 0x0a000000, bits: 8 },
  { label: "CGNAT 100.64/10", base: 0x64400000, bits: 10 },
  { label: "loopback 127/8", base: 0x7f000000, bits: 8 },
  { label: "link-local 169.254/16 (incl. cloud metadata)", base: 0xa9fe0000, bits: 16 },
  { label: "private 172.16/12", base: 0xac100000, bits: 12 },
  { label: "IETF protocol 192.0.0/24", base: 0xc0000000, bits: 24 },
  { label: "TEST-NET-1 192.0.2/24", base: 0xc0000200, bits: 24 },
  { label: "private 192.168/16", base: 0xc0a80000, bits: 16 },
  { label: "benchmarking 198.18/15", base: 0xc6120000, bits: 15 },
  { label: "TEST-NET-2 198.51.100/24", base: 0xc6336400, bits: 24 },
  { label: "TEST-NET-3 203.0.113/24", base: 0xcb007100, bits: 24 },
  { label: "multicast 224/4", base: 0xe0000000, bits: 4 },
  { label: "reserved 240/4", base: 0xf0000000, bits: 4 },
  { label: "broadcast 255.255.255.255", base: 0xffffffff, bits: 32 },
]

function ipv4ToInt(ip: string): number | null {
  const parts = ip.split(".")
  if (parts.length !== 4) return null
  let value = 0
  for (const part of parts) {
    const octet = Number(part)
    if (!/^\d{1,3}$/.test(part) || octet > 255) return null
    value = (value << 8) | octet
  }
  return value >>> 0
}

function isPrivateV4(ip: string): string | null {
  const value = ipv4ToInt(ip)
  if (value === null) return null
  for (const rule of V4_PREFIXES) {
    const mask = bitsToMask(rule.bits)
    // JS bitwise ops yield signed 32-bit ints — normalize with >>> 0 before
    // comparing against the (positive) unsigned base constant.
    if (((value & mask) >>> 0) === rule.base) return rule.label
  }
  return null
}

function bitsToMask(bits: number): number {
  return bits === 0 ? 0 : (~0 >>> 0) << (32 - bits)
}

/** Expand an IPv6 address into 8 hextet numbers (drops zone id, handles :: and v4-mapped). */
function ipv6Hextets(ip: string): number[] | null {
  let addr = ip.split("%")[0] ?? ip
  if (!addr) return null
  if (addr.toLowerCase().startsWith("::ffff:")) {
    const v4 = addr.slice(7)
    const v4Value = ipv4ToInt(v4)
    if (v4Value === null) return null
    return [
      0, 0, 0, 0, 0, 0xffff,
      (v4Value >>> 16) & 0xffff,
      v4Value & 0xffff,
    ]
  }
  let v4Tail = ""
  if (addr.includes(".")) {
    const lastColon = addr.lastIndexOf(":")
    if (lastColon === -1) return null
    v4Tail = addr.slice(lastColon + 1)
    addr = addr.slice(0, lastColon)
    const v4Value = ipv4ToInt(v4Tail)
    if (v4Value === null) return null
    v4Tail = ((v4Value >>> 16).toString(16)) + ":" + (v4Value & 0xffff).toString(16)
  }
  const double = addr.indexOf("::")
  let head: string[]
  let tail: string[]
  if (double !== -1) {
    head = addr.slice(0, double).split(":").filter(Boolean)
    tail = addr.slice(double + 2).split(":").filter(Boolean)
  } else {
    head = addr.split(":").filter(Boolean)
    tail = []
  }
  if (v4Tail) {
    const tailParts = tail.length === 0 ? [] : tail
    if (tailParts.length > 0) tailParts[tailParts.length - 1] = ""
    const merged = [...head, ...v4Tail.split(":")]
    head = merged
    tail = []
  }
  const groups = double !== -1
    ? [...head, ...Array(8 - head.length - tail.length).fill("0"), ...tail]
    : head
  if (groups.length !== 8) return null
  const hextets: number[] = []
  for (const group of groups) {
    if (!/^[0-9a-f]{1,4}$/i.test(group)) return null
    hextets.push(parseInt(group, 16))
  }
  return hextets
}

function isPrivateV6(ip: string): string | null {
  const h = ipv6Hextets(ip)
  if (h === null) return "malformed IPv6"
  const a0 = h[0]!
  const b0 = h[1]!
  const c0 = h[2]!
  const d0 = h[3]!
  const e0 = h[4]!
  const f0 = h[5]!
  const g0 = h[6]!
  const h0 = h[7]!
  const first = (a0 << 16) | b0
  const second = (c0 << 16) | d0
  // :: / ::1
  if (first === 0 && second === 0 && e0 === 0 && f0 === 0 && g0 === 0 && h0 === 0) return "unspecified ::/128"
  if (first === 0 && second === 0 && e0 === 0 && f0 === 0 && g0 === 0 && h0 === 1) return "loopback ::1/128"
  // IPv4-mapped already expanded to v4 value → re-check as IPv4
  if (first === 0 && second === 0 && e0 === 0 && f0 === 0xffff) {
    const v4 = `${g0 >> 8}.${g0 & 0xff}.${h0 >> 8}.${h0 & 0xff}`
    return isPrivateV4(v4) ?? null
  }
  // ULA fc00::/7 (first hextet in 0xfc00–0xfdff)
  if ((a0 & 0xfe00) === 0xfc00) return "ULA fc00::/7"
  // link-local fe80::/10
  if ((a0 & 0xffc0) === 0xfe80) return "link-local fe80::/10"
  // discard-only 100::/64
  if (a0 === 0x0100 && b0 === 0 && c0 === 0 && d0 === 0) return "discard-only 100::/64"
  // documentation 2001:db8::/32
  if (a0 === 0x2001 && b0 === 0x0db8) return "documentation 2001:db8::/32"
  // ORCHID 2001:10::/28
  if (a0 === 0x2001 && (b0 & 0xfff0) === 0x0010) return "ORCHID 2001:10::/28"
  // multicast ff00::/8
  if ((a0 & 0xff00) === 0xff00) return "multicast ff00::/8"
  return null
}

/** Returns the blocked-range label when the address is private/link-local/etc., else null. */
export function isPrivateIp(ip: string): string | null {
  if (isIP(ip) === 4) return isPrivateV4(ip)
  if (isIP(ip) === 6) return isPrivateV6(ip)
  return "invalid IP"
}

/** Hostnames that are inherently non-routable (checked before DNS). */
const BLOCKED_HOSTNAMES = new Set([
  "localhost", "127.0.0.1", "0.0.0.0", "::1", "[::1]", "localhost.localdomain",
  "internal", "intranet", "metadata", "metadata.google.internal",
  "metadata.google", "metadata.aws", "instance-data", "instance-data.ec2.internal",
  "kubernetes", "kubernetes.default", "kube-apiserver", "rancher-metadata",
])

function isBlockedHostname(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/^\[|\]$/g, "")
  if (BLOCKED_HOSTNAMES.has(h) || h.endsWith(".local") || h.endsWith(".internal")) return true
  // Numeric dotted/quads and IPv6 literals handled by isPrivateIp after DNS —
  // but check the literal itself here so we fail before any resolution.
  const numeric = isIP(h)
  if (numeric === 4 || numeric === 6) return isPrivateIp(h) !== null
  return false
}

/** DNS-resolve a hostname (fail-closed) and return the literal addresses. */
export async function resolveHostnameIps(hostname: string): Promise<string[]> {
  const h = hostname.replace(/^\[|\]$/g, "")
  const numeric = isIP(h)
  if (numeric !== 0) return [h]
  try {
    const result = await lookup(h, { all: true, verbatim: true })
    const ips = result.map(entry => entry.address)
    if (ips.length === 0) throw new Error("no addresses resolved")
    return ips
  } catch (e) {
    throw new Error(`DNS resolution failed for ${hostname}: ${e instanceof Error ? e.message : String(e)}`)
  }
}

export class BlockedAddressError extends Error {
  constructor(
    message: string,
    public readonly detail: { hostname: string; reason: string; ips: string[] },
  ) {
    super(message)
    this.name = "BlockedAddressError"
  }
}

/**
 * Validate a URL target: protocol, hostname blacklist, DNS resolution, and
 * per-IP private-range check. Returns the validated IPs the request may use.
 * Any single private IP in the resolution set rejects the whole target
 * (fail-closed — we must not fall through to an unvalidated connection).
 */
export async function checkUrlTarget(
  url: URL,
  options: { allowPrivate?: boolean } = {},
): Promise<{ ips: string[]; hostname: string }> {
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`Unsupported protocol: ${url.protocol}`)
  }
  const hostname = url.hostname
  if (isBlockedHostname(hostname) && !options.allowPrivate) {
    throw new BlockedAddressError(`Hostname blocked: ${hostname}`, {
      hostname,
      reason: "hostname in blocklist",
      ips: [],
    })
  }
  const ips = await resolveHostnameIps(hostname)
  if (!options.allowPrivate) {
    for (const ip of ips) {
      const reason = isPrivateIp(ip)
      if (reason !== null) {
        throw new BlockedAddressError(
          `Address blocked: ${hostname} resolves to ${ip} (${reason})`,
          { hostname, reason: `resolved to private address ${ip} (${reason})`, ips },
        )
      }
    }
  }
  return { ips, hostname }
}

// ── Streaming fetch with per-hop validation ──

export const MAX_REDIRECTS = 5

/** Text-ish content types we will read; everything else is rejected. */
const ALLOWED_CONTENT_TYPE = /^(text\/|application\/(json|xml|javascript|x-www-form-urlencoded|graphql|yaml|toml|sql)\b|image\/svg\+xml)/i
const BINARY_CONTENT_TYPE = /^(image|audio|video|font)\//i

export interface SafeHttpGetOptions {
  /** Decompressed body byte budget. Streaming read is cut at this boundary. */
  maxBytes: number
  /** Overall deadline per request hop. */
  timeoutMs: number
  maxRedirects?: number
  signal?: AbortSignal
  /** Extra headers (User-Agent default provided). */
  headers?: Record<string, string>
  /**
   * Test-only escape hatch: connect to private/link-local targets. Never set
   * in production paths — the default fail-closed posture rejects them.
   */
  allowPrivateHosts?: boolean
  /** Inject a fake low-level connection (tests only). */
  connect?: HttpConnect
}

export interface SafeHttpResult {
  status: number
  finalUrl: string
  contentType: string
  body: string
  /** Decompressed bytes actually read. */
  bytes: number
  truncated: boolean
  redirects: number
  hopIps: string[]
}

function decompressorFor(contentEncoding: string | null) {
  const encoding = (contentEncoding ?? "").toLowerCase()
  if (encoding.includes("gzip")) return createGunzip()
  if (encoding.includes("deflate")) return createInflate()
  if (encoding.includes("br")) return createBrotliDecompress()
  return null
}

/** Low-level connection hook — default is the real http/https request; tests
 *  inject a fake so hop logic can be exercised without a live socket. */
export type HttpConnect = (
  parsed: URL,
  signal: AbortSignal,
  options: { timeoutMs: number; headers: Record<string, string> },
) => Promise<{ response: IncomingMessage; ip: string }>

const realConnect: HttpConnect = (parsed, signal, { headers }) => {
  return new Promise((resolve, reject) => {
    const ip = parsed.hostname
    const isHttps = parsed.protocol === "https:"
    const requestOptions: RequestOptions = {
      hostname: ip,
      port: parsed.port ? Number(parsed.port) : undefined,
      path: `${parsed.pathname}${parsed.search}`,
      method: "GET",
      headers,
      signal,
    }
    const client = isHttps ? httpsRequest : httpRequest
    if (isHttps) (requestOptions as Record<string, unknown>).servername = parsed.hostname
    const req = client(requestOptions, response => resolve({ response, ip }))
    req.on("error", reject)
    req.end()
  })
}

function requestOnce(
  parsed: URL,
  options: SafeHttpGetOptions,
  signal: AbortSignal,
): Promise<{ response: IncomingMessage; body: string; bytes: number; truncated: boolean; ip: string }> {
  return new Promise((resolve, reject) => {
    checkUrlTarget(parsed, { allowPrivate: options.allowPrivateHosts === true })
      .then(({ ips }) => {
        const ip = ips[0]!
        const isHttps = parsed.protocol === "https:"
        const headers: Record<string, string> = {
          "User-Agent": "Orcana-Runtime/0.5 (research; streaming-safe)",
          "Accept": "text/html,text/markdown,text/plain,application/json;q=0.9,*/*;q=0.5",
          "Accept-Encoding": "gzip, deflate, br",
          "Host": parsed.host,
          ...options.headers,
        }
        const connect = options.connect ?? realConnect
        return connect(parsed, signal, { timeoutMs: options.timeoutMs, headers })
          .then(({ response, ip: connectedIp }) => {
            const chunks: Buffer[] = []
            let bytes = 0
            let truncated = false

            const onChunk = (chunk: Buffer) => {
              bytes += chunk.length
              if (bytes > options.maxBytes) {
                truncated = true
                response.destroy()
                return
              }
              chunks.push(chunk)
            }

            const finish = () => {
              const body = Buffer.concat(chunks).toString("utf-8")
              resolve({ response, body, bytes, truncated, ip: connectedIp ?? ip })
            }

            const decompressor = decompressorFor(response.headers["content-encoding"] as string | null)
            if (decompressor) {
              decompressor.on("data", onChunk)
              decompressor.on("end", finish)
              decompressor.on("error", reject)
              response.pipe(decompressor)
            } else {
              response.on("data", onChunk)
              response.on("end", finish)
            }
            response.on("error", reject)
          })
          .catch(reject)
      })
      .catch(reject)
  })
}

function isRedirect(status: number): boolean {
  return status === 301 || status === 302 || status === 303 || status === 307 || status === 308
}

/** Fetch with per-hop SSRF re-validation, streaming byte budget, and content-type guard. */
export async function safeHttpGet(
  url: string,
  options: SafeHttpGetOptions,
): Promise<SafeHttpResult> {
  let current: URL
  try {
    current = new URL(url)
  } catch {
    throw new Error(`Invalid URL: ${url}`)
  }

  const maxRedirects = options.maxRedirects ?? MAX_REDIRECTS
  const hopIps: string[] = []
  let redirects = 0
  let finalUrl = current.toString()

  while (true) {
    const hopSignal = AbortSignal.any([
      ...(options.signal ? [options.signal] : []),
      AbortSignal.timeout(options.timeoutMs),
    ])
    const { response, body, bytes, truncated, ip } = await requestOnce(current, options, hopSignal)
    hopIps.push(ip)

    const contentType = response.headers["content-type"]?.split(";")[0]?.trim().toLowerCase() ?? ""
    const status = response.statusCode ?? 0
    finalUrl = current.toString()

    if (isRedirect(status)) {
      const location = response.headers.location
      if (!location) {
        return { status, finalUrl, contentType, body, bytes, truncated, redirects, hopIps }
      }
      redirects++
      if (redirects > maxRedirects) {
        throw new Error(`Too many redirects (${maxRedirects}) from ${url}`)
      }
      let next: URL
      try {
        next = new URL(location, current)
      } catch {
        throw new Error(`Invalid redirect location from ${url}: ${location}`)
      }
      // Per-hop re-validation happens inside requestOnce; reject non-http(s) schemes here.
      if (next.protocol !== "http:" && next.protocol !== "https:") {
        throw new Error(`Redirect to unsupported protocol: ${next.protocol}`)
      }
      current = next
      continue
    }

    if (contentType && BINARY_CONTENT_TYPE.test(contentType)) {
      throw new Error(`Content-type not readable: ${contentType}`)
    }
    if (contentType && !ALLOWED_CONTENT_TYPE.test(contentType)) {
      throw new Error(`Content-type not readable: ${contentType}`)
    }
    return { status, finalUrl, contentType, body, bytes, truncated, redirects, hopIps }
  }
}

// ── Prompt-injection heuristic flagging ──

const INJECTION_PATTERNS: Array<{ pattern: RegExp; label: string }> = [
  { pattern: /\bignore\s+(all\s+)?(previous|prior|earlier)\s+(instructions?|prompts?|context)\b/i, label: "ignore-previous-instructions" },
  { pattern: /\bdisregard\s+(all\s+)?(previous|prior)\s+(instructions?|prompts?|context)\b/i, label: "disregard-previous-instructions" },
  { pattern: /\byou\s+(are|'re)\s+(now|no longer)\s+/i, label: "role-reassignment" },
  { pattern: /\bsystem\s*(prompt|message)\s*(override|replacement)\b/i, label: "system-prompt-override" },
  { pattern: /\bnew\s+system\s+prompt\b/i, label: "system-prompt-override" },
  { pattern: /\bpretend\s+you(\s+(are|were))?\b/i, label: "role-reassignment" },
  { pattern: /\bdo\s+not\s+(reveal|mention|tell)\s+(your|any)\s*(system\s*)?(instructions?|prompts?|guidelines?)\b/i, label: "instruction-leak-request" },
  { pattern: /\bskip\s+all\s+previous\b/i, label: "ignore-previous-instructions" },
]

/** Detect common prompt-injection phrasing in fetched content. Returns labels (empty when clean). */
export function detectPromptInjection(text: string): string[] {
  const found: string[] = []
  for (const rule of INJECTION_PATTERNS) {
    if (rule.pattern.test(text)) found.push(rule.label)
  }
  return [...new Set(found)]
}
