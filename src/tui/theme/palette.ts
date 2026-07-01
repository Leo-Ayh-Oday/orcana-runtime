/** palette — 原始 hex 色值，不含语义。
 *  被 theme.ts 引用，也可被需要精确控制颜色的组件直接引用。 */

export const palette = {
  cyan: "#38BDF8",
  blue: "#60A5FA",
  white: "#E5E7EB",
  dim: "#64748B",
  green: "#22C55E",
  yellow: "#F59E0B",
  red: "#EF4444",
  border: "#334155",
} as const

export type PaletteColor = keyof typeof palette
