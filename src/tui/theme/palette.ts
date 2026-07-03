/** palette — 原始 hex 色值，不含语义。
 *  被 theme.ts 引用，也可被需要精确控制颜色的组件直接引用。
 *
 *  Phase 1: 扩展到 18 色。gate/evidence/patch 各有独立色，不再共用 green/blue/yellow。
 *  旧 C.* 别名完全向后兼容。 */

export const palette = {
  // ── 旧色（保持向后兼容）──
  cyan: "#38BDF8",
  blue: "#60A5FA",
  white: "#E5E7EB",
  dim: "#64748B",
  green: "#22C55E",
  yellow: "#F59E0B",
  red: "#EF4444",
  border: "#334155",

  // ── Phase 1 新增语义色 ──
  /** Orcana 品牌蓝 — Header/Logo/mode/ripple */
  abyss: "#0EA5E9",
  /** 深海蓝亮色 — 涟漪扫光用 */
  abyssShimmer: "#7DD3FC",
  /** 暗流青 — task/plan */
  teal: "#2DD4BF",
  /** 暗流青亮色 — task 扫光 */
  tealShimmer: "#5EEAD4",
  /** 珊瑚红 — error/danger/blocked（比 red 柔和） */
  coral: "#FB7185",
  /** 珊瑚红亮色 — error 扫光 / stalled 渐变终点 */
  coralShimmer: "#FDA4AF",
  /** 琥珀黄 — warning/pending gate */
  amber: "#FBBF24",
  /** 琥珀黄亮色 — warning 扫光 */
  amberShimmer: "#FDE68A",
  /** 翡翠绿 — success/done */
  jade: "#34D399",
  /** 翡翠绿亮色 — success 扫光 / settled 相位 */
  jadeShimmer: "#6EE7B7",
  /** 紫罗兰 — evidence 专属 */
  evidence: "#A78BFA",
  /** 粉红 — gate 专属 */
  gate: "#F472B6",
  /** 薄荷 — patch 专属 */
  patch: "#5EEAD4",
  /** 声呐蓝 — info/streaming/active */
  sonar: "#38BDF8",
  /** 薄雾 — 次要文本（比 dim 更可读） */
  mist: "#94A3B8",
  /** 浓雾 — 最弱文本（gutter/separator） */
  fog: "#475569",
} as const

export type PaletteColor = keyof typeof palette
