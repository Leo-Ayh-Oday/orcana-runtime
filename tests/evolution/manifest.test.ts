/** LR2-6（P6-A）验收：EvolutionManifest + Environment Digest。 */

import { describe, test, expect } from "bun:test"
import {
  validateManifestInput,
  manifestIdOf,
  parseManifest,
  serializeManifest,
  type EvolutionManifestInput,
} from "../../src/evolution/manifest"
import {
  computeEnvironmentDigest,
  buildEnvironmentFacts,
  environmentDrift,
  assertEnvironmentMatchesManifest,
  type EnvironmentFacts,
} from "../../src/evolution/digest"

const sha = (s: string) => require("node:crypto").createHash("sha256").update(s).digest("hex")

function baseFacts(overrides: Partial<EnvironmentFacts> = {}): EnvironmentFacts {
  return buildEnvironmentFacts({
    sourceDigest: sha("baseline-src"),
    lockfileDigest: sha("lockfile"),
    toolchainDigest: sha("bun-1.3.14"),
    kernelCapabilityDigest: sha("kernel-cap"),
    cellSpecDigest: sha("cellspec"),
    networkPolicyDigest: sha("netpol"),
    resourcePolicyDigest: sha("respol"),
    evaluatorVersion: "eval-1.0",
    benchmarkManifestDigest: sha("bench"),
    ...overrides,
  })
}

function manifestInput(overrides: Partial<EvolutionManifestInput> = {}): EvolutionManifestInput {
  return {
    benchmarkSet: [{ id: "case-1", inputDigest: sha("input-1"), name: "add" }],
    scorer: { scorerDigest: sha("scorer"), correctnessRulesDigest: sha("rules") },
    environment: baseFacts(),
    promotionCriteria: { requireZeroRegression: true, requireSecurityGateNonRegression: true, maxPerfRegressionRatio: 0.1, requireNoHiddenFailure: true, canaryWatchWindowMs: 60_000 },
    baselineRef: "commit-baseline",
    evaluatorVersion: "eval-1.0",
    ...overrides,
  }
}

describe("P6-A: EvolutionManifest", () => {
  test("valid input produces manifest with full sha256 id", () => {
    const r = validateManifestInput(manifestInput())
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.manifest.manifestId).toHaveLength(64)
      expect(r.manifest.environmentDigest).toHaveLength(64)
      expect(r.manifest.schemaVersion).toBe("1.0")
    }
  })

  test("empty benchmarkSet rejected", () => {
    const r = validateManifestInput(manifestInput({ benchmarkSet: [] }))
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.errors.join()).toContain("benchmarkSet")
  })

  test("duplicate case id rejected", () => {
    const r = validateManifestInput(manifestInput({
      benchmarkSet: [{ id: "x", inputDigest: sha("a") }, { id: "x", inputDigest: sha("b") }],
    }))
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.errors.join()).toContain("duplicate")
  })

  test("invalid perf threshold rejected", () => {
    const r = validateManifestInput(manifestInput({
      promotionCriteria: { ...manifestInput().promotionCriteria, maxPerfRegressionRatio: 1.5 },
    }))
    expect(r.ok).toBe(false)
  })

  test("content addressing: same input → same id", () => {
    expect(manifestIdOf(manifestInput())).toBe(manifestIdOf(manifestInput()))
  })

  test("any field change → new manifestId (evaluatorVersion)", () => {
    expect(manifestIdOf(manifestInput())).not.toBe(manifestIdOf(manifestInput({ evaluatorVersion: "eval-2.0" })))
  })

  test("any field change → new manifestId (promotion criteria)", () => {
    expect(manifestIdOf(manifestInput())).not.toBe(manifestIdOf(manifestInput({
      promotionCriteria: { ...manifestInput().promotionCriteria, requireZeroRegression: false },
    })))
  })

  test("parse round-trip preserves manifestId; tampered id rejected", () => {
    const r = validateManifestInput(manifestInput())
    if (!r.ok) throw new Error("setup failed")
    const json = serializeManifest(r.manifest)
    const parsed = parseManifest(json)
    expect(parsed.ok).toBe(true)
    if (parsed.ok) expect(parsed.manifest.manifestId).toBe(r.manifest.manifestId)
    const tampered = JSON.parse(json)
    tampered.promotionCriteria.requireZeroRegression = false
    const bad = parseManifest(JSON.stringify(tampered))
    expect(bad.ok).toBe(false)
    if (!bad.ok) expect(bad.error).toContain("immutability")
  })

  test("CANDIDATE_CONTROLS_BENCHMARK: candidate cannot swap scorer without new id", () => {
    const orig = manifestInput()
    const swapped = manifestInput({ scorer: { scorerDigest: sha("evil-scorer"), correctnessRulesDigest: sha("evil-rules") } })
    expect(manifestIdOf(swapped)).not.toBe(manifestIdOf(orig))
  })
})

describe("P6-A: Environment Digest", () => {
  test("digest is full sha256 and deterministic", () => {
    const a = computeEnvironmentDigest(baseFacts())
    const b = computeEnvironmentDigest(baseFacts())
    expect(a).toHaveLength(64)
    expect(a).toBe(b)
  })

  test("missing required field throws", () => {
    expect(() => buildEnvironmentFacts({ evaluatorVersion: "e", benchmarkManifestDigest: sha("b") } as never)).toThrow()
  })

  test("drift detection: differing toolchain detected", () => {
    const base = baseFacts()
    const cand = baseFacts({ toolchainDigest: sha("bun-2.0") })
    const d = environmentDrift(base, cand)
    expect(d.drift).toBe(true)
    expect(d.differingFields).toContain("toolchainDigest")
  })

  test("allowFields exempts declared differences (source only)", () => {
    const base = baseFacts()
    const cand = baseFacts({ sourceDigest: sha("candidate-src") })
    const d = environmentDrift(base, cand, { allowFields: ["sourceDigest"] })
    expect(d.drift).toBe(false)
  })

  test("assertEnvironmentMatchesManifest: consistent → ok", () => {
    const facts = baseFacts()
    const envDigest = computeEnvironmentDigest(facts)
    expect(assertEnvironmentMatchesManifest(envDigest, facts).ok).toBe(true)
  })

  test("assertEnvironmentMatchesManifest: drifted env rejected", () => {
    const facts = baseFacts()
    const envDigest = computeEnvironmentDigest(facts)
    const r = assertEnvironmentMatchesManifest(envDigest, baseFacts({ lockfileDigest: sha("other") }))
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toContain("mismatch")
  })
})
