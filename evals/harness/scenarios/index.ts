/** H12 HR scenario registry (plan §18.6). */

import { readFileSync } from "node:fs"
import { join } from "node:path"
import type { RunReplayCase } from "../contracts"
import { HR_DUAL_CASES } from "./hr-dual"

interface HrCoreFile {
  cases: Omit<RunReplayCase, "caseId">[] & Array<Record<string, unknown>>
}

/** Load the single-run core scenarios from hr-core.json. */
export function loadHrCoreCases(): RunReplayCase[] {
  const raw = readFileSync(join(__dirname, "hr-core.json"), "utf-8")
  const parsed = JSON.parse(raw) as HrCoreFile
  return parsed.cases as unknown as RunReplayCase[]
}

/** All first-batch scenarios (single-run core + dual-run). */
export function loadHrScenarios(): RunReplayCase[] {
  return [...loadHrCoreCases(), ...HR_DUAL_CASES]
}
