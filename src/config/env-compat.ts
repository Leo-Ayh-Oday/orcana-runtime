/** Legacy environment compatibility (rename migration).
 *
 *  deepseek-code → Orcana rename: DEEPSEEK_* env vars are mirrored to their
 *  ORCANA_* counterparts when the new name is unset, so existing user
 *  configurations keep working without changes. The mapping runs once at
 *  module load — import this FIRST in every entry point (src/index.ts) and
 *  the bin launcher loads dist/index.js which starts with this import.
 *
 *  DeepSeek API vars (DEEPSEEK_API_KEY / DEEPSEEK_ANTHROPIC_BASE_URL /
 *  DEEPSEEK_BETA_BASE_URL) are NOT mapped — they keep their canonical names
 *  as part of the DeepSeek provider ecosystem.
 */

const LEGACY_PREFIX = "DEEPSEEK_"
const NEW_PREFIX = "ORCANA_"
const EXCLUDED = new Set([
  "DEEPSEEK_API_KEY",
  "DEEPSEEK_ANTHROPIC_BASE_URL",
  "DEEPSEEK_BETA_BASE_URL",
])

/** Mirror legacy DEEPSEEK_* vars to ORCANA_* (new names win when both set). */
export function applyLegacyEnvCompat(): void {
  for (const [key, value] of Object.entries(process.env)) {
    if (!key.startsWith(LEGACY_PREFIX) || EXCLUDED.has(key)) continue
    if (value === undefined) continue
    const newKey = NEW_PREFIX + key.slice(LEGACY_PREFIX.length)
    if (process.env[newKey] === undefined) {
      process.env[newKey] = value
    }
  }
}

// Runs on module load — keep this import first in entry points.
applyLegacyEnvCompat()
