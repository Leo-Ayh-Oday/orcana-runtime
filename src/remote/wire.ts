/** LR2-7（P7-A）：RemoteWire —— 远程线协议（签名消息编解码）。
 *
 *  复用 execd 语义（LR2-1：4-byte 帧 + JSON 载荷），但远程消息必须：
 *  1. 带身份（workerId/coordinatorId）；
 *  2. 带 nonce（重放防护）；
 *  3. 载荷签名（Ed25519）——签名覆盖 canonical JSON digest。
 *  第一版内存传输（RemoteTransport 接口），签名/验证真实（node:crypto）。
 */

import { createHash, createPublicKey, createPrivateKey, sign as cryptoSign, verify as cryptoVerify } from "node:crypto"
import { canonicalJson } from "../runtime/linux/receipt"

export const REMOTE_PROTOCOL_VERSION = 1

export interface RemoteIdentity {
  /** 身份名（worker-xxx / coordinator-xxx）。 */
  id: string
  /** Ed25519 公钥（PEM）。 */
  publicKeyPem: string
}

export type RemoteMessageType =
  | "worker-hello"
  | "submit-cell"
  | "watch-events"
  | "cancel-cell"
  | "renew-lease"
  | "report-receipt"
  | "fetch-artifact"
  | "coordinator-role"

export interface SignedMessage {
  version: number
  type: RemoteMessageType
  senderId: string
  nonce: string
  /** 消息正文（不参与签名的元数据之外的部分）。 */
  payload: unknown
  /** 载荷 canonical JSON 的 SHA-256。 */
  payloadDigest: string
  /** Ed25519 签名（hex，覆盖 payloadDigest + type + senderId + nonce）。 */
  signature: string
}

export interface SigningKey {
  /** 生成密钥对。 */
  generate(): { publicKeyPem: string; privateKeyPem: string }
  /** 签名载荷。 */
  sign(privateKeyPem: string, message: { type: string; senderId: string; nonce: string; payloadDigest: string }): string
}

export const ed25519: SigningKey = {
  generate() {
    const { publicKey, privateKey } = generateKeyPairSyncEd25519()
    return { publicKeyPem: publicKey, privateKeyPem: privateKey }
  },
  sign(privateKeyPem, msg) {
    // Ed25519 内部自带哈希 —— OpenSSL 不接受外部 digest 参数（COMMAND_NOT_SUPPORTED）
    return cryptoSign(null, Buffer.from(canonicalJson(msg), "utf8"), createPrivateKey(privateKeyPem)).toString("hex")
  },
}

function generateKeyPairSyncEd25519(): { publicKey: string; privateKey: string } {
  // bun 的 crypto.generateKeyPairSync 对 ed25519 的支持：走 node:crypto 等价路径
  const { publicKey, privateKey } = (require("node:crypto") as typeof import("node:crypto")).generateKeyPairSync("ed25519")
  return {
    publicKey: publicKey.export({ type: "spki", format: "pem" }).toString(),
    privateKey: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
  }
}

/** 构造签名消息。 */
export function buildSignedMessage(opts: {
  type: RemoteMessageType
  senderId: string
  nonce: string
  payload: unknown
  privateKeyPem: string
}): SignedMessage {
  const payloadDigest = createHash("sha256").update(canonicalJson(opts.payload)).digest("hex")
  const signature = ed25519.sign(opts.privateKeyPem, {
    type: opts.type,
    senderId: opts.senderId,
    nonce: opts.nonce,
    payloadDigest,
  })
  return {
    version: REMOTE_PROTOCOL_VERSION,
    type: opts.type,
    senderId: opts.senderId,
    nonce: opts.nonce,
    payload: opts.payload,
    payloadDigest,
    signature,
  }
}

export type VerifyResult =
  | { ok: true; reason: string }
  | { ok: false; reason: string }

/** 验证签名消息：版本 / 签名 / 载荷摘要 / 发送者身份一致。 */
export function verifySignedMessage(msg: SignedMessage, expectedSenderPublicKeyPem: string): VerifyResult {
  if (msg.version !== REMOTE_PROTOCOL_VERSION) {
    return { ok: false, reason: `protocol version mismatch: ${msg.version}` }
  }
  const recomputedDigest = createHash("sha256").update(canonicalJson(msg.payload)).digest("hex")
  if (recomputedDigest !== msg.payloadDigest) {
    return { ok: false, reason: "payload digest mismatch (tampered payload)" }
  }
  const verifier = cryptoVerify(
    null,
    Buffer.from(canonicalJson({
      type: msg.type,
      senderId: msg.senderId,
      nonce: msg.nonce,
      payloadDigest: msg.payloadDigest,
    }), "utf8"),
    createPublicKey(expectedSenderPublicKeyPem),
    Buffer.from(msg.signature, "hex"),
  )
  if (!verifier) return { ok: false, reason: "signature invalid" }
  return { ok: true, reason: "signed message verified" }
}

/** 序列化（传输字节）。 */
export function encodeMessage(msg: SignedMessage): Buffer {
  return Buffer.from(canonicalJson(msg), "utf8")
}

export function decodeMessage(bytes: Buffer): { ok: true; msg: SignedMessage } | { ok: false; error: string } {
  try {
    const parsed = JSON.parse(bytes.toString("utf8")) as SignedMessage
    if (typeof parsed !== "object" || parsed === null || typeof parsed.signature !== "string") {
      return { ok: false, error: "malformed signed message" }
    }
    return { ok: true, msg: parsed }
  } catch (error) {
    return { ok: false, error: `decode failed: ${error instanceof Error ? error.message : String(error)}` }
  }
}

/** 身份指纹：公钥 PEM 的 SHA-256（workerId = 指纹，天然绑定身份）。 */
export function identityFingerprint(publicKeyPem: string): string {
  return createHash("sha256").update(publicKeyPem).digest("hex")
}
