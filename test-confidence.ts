import { computeConfidence, calcFreshness, calcInvalidationFactor, findDecayedEvidence, DEFAULT_CONFIDENCE_CONFIG } from "./src/verification/confidence";
import { EvidenceLedger } from "./src/verification/evidence-ledger";

// Test 1: Freshness
console.log("=== Test 1: Freshness ===");
const now = Date.now();
console.log("Fresh (0 min):", calcFreshness(now, 30 * 60 * 1000, now)); // 1.0
console.log("At halflife (30 min):", calcFreshness(now - 30 * 60 * 1000, 30 * 60 * 1000, now)); // 0.5
console.log("2x halflife (60 min):", calcFreshness(now - 60 * 60 * 1000, 30 * 60 * 1000, now)); // 0.25

// Test 2: Invalidation
console.log("\n=== Test 2: Invalidation ===");
console.log("No changes:", calcInvalidationFactor(["a.ts", "b.ts"], [])); // 1.0
console.log("1 of 2 changed:", calcInvalidationFactor(["a.ts", "b.ts"], ["a.ts"])); // ~0.29

// Test 3: Full confidence
console.log("\n=== Test 3: Full Confidence ===");
const result = computeConfidence({
  kind: "typecheck",
  collectedAt: now,
  filesInEvidenceScope: ["src/main.ts"],
  changedFiles: [],
  totalAffectedFiles: ["src/main.ts"],
});
console.log("Fresh typecheck:", JSON.stringify(result, null, 2));

// Test 4: Decayed confidence
console.log("\n=== Test 4: Decayed Confidence ===");
const decayed = computeConfidence({
  kind: "test",
  collectedAt: now - 90 * 60 * 1000, // 90 min ago
  filesInEvidenceScope: ["src/main.ts", "src/utils.ts"],
  changedFiles: ["src/utils.ts"],
  totalAffectedFiles: ["src/main.ts", "src/utils.ts"],
});
console.log("Old + changed test:", JSON.stringify(decayed, null, 2));

// Test 5: EvidenceLedger
console.log("\n=== Test 5: EvidenceLedger ===");
const ledger = new EvidenceLedger();
ledger.recordEvidence(
  { kind: "typecheck", command: "tsc", passed: true, issues: 0, durationMs: 100, summary: "ok" },
  ["src/main.ts"],
  ["src/main.ts"]
);
ledger.recordEvidence(
  { kind: "test", command: "bun test", passed: true, issues: 0, durationMs: 500, summary: "tests passed" },
  ["src/main.ts", "src/utils.ts"],
  ["src/main.ts", "src/utils.ts"]
);

console.log("Initial summary:", JSON.stringify(ledger.getSummary(), null, 2));

// Simulate file change
ledger.markFilesChanged(["src/utils.ts"]);
console.log("After file change:", JSON.stringify(ledger.getSummary(), null, 2));

console.log("\n=== All tests completed ===");