/** palette — 原始 hex 色值（Depthline P5：收敛到 7 token）。
 *
 *  色彩预算：
 *    - white  text（正文，终端默认前景）
 *    - dim    muted（路径、耗时、统计、分隔）
 *    - mist   muted-light（次要文本）
 *    - fog    faint（最弱文本 / 边框派生）
 *    - accent #38BDF8（Orcana、焦点、运行中 — 唯一动画色）
 *    - success / warning / danger
 *
 *  P5 删除的领域分类色：gate pink、evidence purple、patch mint、task teal、
 *  planning purple、reading blue、tooling green、composing pink。
 *  旧键保留为兼容别名并收敛到 7 token（C.* 别名完全向后兼容）。
 */

export const palette = {
  // ── 7 core tokens ──
  white: "#E5E7EB",
  dim: "#64748B",
  mist: "#94A3B8",
  fog: "#475569",
  accent: "#38BDF8",
  success: "#34D399",
  warning: "#FBBF24",
  danger: "#FB7185",

  // ── 兼容别名（收敛到 core）──
  cyan: "#38BDF8",
  sonar: "#38BDF8",
  abyss: "#38BDF8",
  abyssShimmer: "#7DD3FC",
  blue: "#E5E7EB", // assistant 正文 → 终端默认前景
  green: "#34D399",
  jade: "#34D399",
  jadeShimmer: "#6EE7B7",
  yellow: "#FBBF24",
  amber: "#FBBF24",
  amberShimmer: "#FDE68A",
  red: "#FB7185",
  coral: "#FB7185",
  coralShimmer: "#FDA4AF",
  border: "#475569", // 边框从 faint 派生
  // 领域分类色收敛 → muted（结构/标签区分，不再独立主色）
  teal: "#64748B",
  tealShimmer: "#64748B",
  gate: "#64748B",
  evidence: "#64748B",
  patch: "#64748B",
} as const

export type PaletteColor = keyof typeof palette
