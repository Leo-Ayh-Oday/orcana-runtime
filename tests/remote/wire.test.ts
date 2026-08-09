/** LR2-7（P7-A）验收：RemoteWire 签名消息编解码。 */

import { describe, test, expect } from "bun:test"
import {
  buildSignedMessage,
  verifySignedMessage,
  encodeMessage,
  decodeMessage,
  identityFingerprint,
  ed25519,
  REMOTE_PROTOCOL_VERSION,
} from "../../src/remote/wire"

describe("P7-A: RemoteWire", () => {
  const key = ed25519.generate()

  test("key generation produces PEM pair", () => {
    expect(key.publicKeyPem).toContain("BEGIN PUBLIC KEY")
    expect(key.privateKeyPem).toContain("BEGIN PRIVATE KEY")
  })

  test("signed message round-trip verifies", () => {
    const msg = buildSignedMessage({
      type: "worker-hello",
      senderId: "worker-1",
      nonce: "n1",
      payload: { capabilities: ["run_process", "git"] },
      privateKeyPem: key.privateKeyPem,
    })
    const v = verifySignedMessage(msg, key.publicKeyPem)
    expect(v.ok).toBe(true)
  })

  test("tampered payload → digest mismatch rejected", () => {
    const msg = buildSignedMessage({
      type: "submit-cell",
      senderId: "coordinator-1",
      nonce: "n2",
      payload: { executable: "/bin/true", args: [] },
      privateKeyPem: key.privateKeyPem,
    })
    // 篡改载荷（改变 executable）
    msg.payload = { executable: "/bin/rm", args: ["-rf", "/"] }
    const v = verifySignedMessage(msg, key.publicKeyPem)
    expect(v.ok).toBe(false)
    expect(v.reason).toContain("digest mismatch")
  })

  test("wrong signer key → signature invalid", () => {
    const other = ed25519.generate()
    const msg = buildSignedMessage({
      type: "worker-hello",
      senderId: "worker-1",
      nonce: "n3",
      payload: {},
      privateKeyPem: other.privateKeyPem,
    })
    const v = verifySignedMessage(msg, key.publicKeyPem)
    expect(v.ok).toBe(false)
    expect(v.reason).toContain("signature")
  })

  test("protocol version mismatch rejected", () => {
    const msg = buildSignedMessage({
      type: "worker-hello",
      senderId: "worker-1",
      nonce: "n4",
      payload: {},
      privateKeyPem: key.privateKeyPem,
    })
    msg.version = 99
    const v = verifySignedMessage(msg, key.publicKeyPem)
    expect(v.ok).toBe(false)
    expect(v.reason).toContain("version")
  })

  test("encode/decode round-trip preserves message", () => {
    const msg = buildSignedMessage({
      type: "report-receipt",
      senderId: "worker-1",
      nonce: "n5",
      payload: { receiptId: "r1", exitCode: 0 },
      privateKeyPem: key.privateKeyPem,
    })
    const decoded = decodeMessage(encodeMessage(msg))
    expect(decoded.ok).toBe(true)
    if (decoded.ok) {
      expect(decoded.msg.type).toBe("report-receipt")
      expect(decoded.msg.signature).toBe(msg.signature)
      const v = verifySignedMessage(decoded.msg, key.publicKeyPem)
      expect(v.ok).toBe(true)
    }
  })

  test("malformed message rejected", () => {
    const d = decodeMessage(Buffer.from("not-json"))
    expect(d.ok).toBe(false)
  })

  test("identity fingerprint is stable and distinct", () => {
    const other = ed25519.generate()
    const fp1 = identityFingerprint(key.publicKeyPem)
    expect(fp1).toHaveLength(64)
    expect(fp1).toBe(identityFingerprint(key.publicKeyPem))
    expect(fp1).not.toBe(identityFingerprint(other.publicKeyPem))
  })

  test("nonce is part of signed content (replay with same payload different nonce still verifies, nonce swap invalid)", () => {
    const msg = buildSignedMessage({
      type: "worker-hello",
      senderId: "worker-1",
      nonce: "n6",
      payload: { caps: ["x"] },
      privateKeyPem: key.privateKeyPem,
    })
    const original = msg.signature
    msg.nonce = "n7" // 换 nonce = 消息被改
    const v = verifySignedMessage(msg, key.publicKeyPem)
    expect(v.ok).toBe(false)
    expect(msg.signature).toBe(original)
  })
})
