/** Tool Runtime 2.0 (RT-2): capability mode feature flag.
 *
 *  Migration ladder (plan §8): legacy → shadow → enabled.
 *    - legacy  (default): the new contract runs, but divergences never
 *      disturb the legacy path — the executor records them as
 *      capability.shadow_mismatch observations only.
 *    - shadow:  same observation behavior (kept for parity with the ladder;
 *      divergence recording is the distinguishing feature of both).
 *    - enabled: the new contract is authoritative — schema failures block.
 *
 *  Read via ORCANA_CAPABILITIES_MODE env var; unknown values fall back to
 *  legacy (fail closed, never silently "enabled").
 */

export type CapabilityMode = "legacy" | "shadow" | "enabled"

export const CAPABILITY_MODE_DEFAULT: CapabilityMode = "legacy"

const VALID_MODES: ReadonlySet<string> = new Set(["legacy", "shadow", "enabled"])

export function getCapabilityMode(env: Record<string, string | undefined> = process.env): CapabilityMode {
  const raw = env["ORCANA_CAPABILITIES_MODE"]
  if (raw && VALID_MODES.has(raw)) return raw as CapabilityMode
  return CAPABILITY_MODE_DEFAULT
}

/** Shadow/enabled both record divergence observations. */
export function isShadowMode(mode: CapabilityMode = getCapabilityMode()): boolean {
  return mode === "shadow" || mode === "enabled"
}

/** Enabled is the only authoritative mode (schema failures block). */
export function isEnabledMode(mode: CapabilityMode = getCapabilityMode()): boolean {
  return mode === "enabled"
}
