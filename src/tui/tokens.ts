/** tuiTokens — TUI 布局/动画/响应式的集中配置。
 *
 *  设计原则：
 *    - 所有组件引用这里的令牌，不从环境变量/自己定义常量
 *    - 环境变量只在 tokens.ts 读一次，提供 override 入口
 *    - 新增布局参数统一加到这里，不在组件里写死
 *
 *  Phase 3: 新增 glyphs 双主题（ascii / unicode）。
 *    - DEEPSEEK_TUI_UNICODE=1 使用 unicode 主题（完整 Braille/Block/几何字符）
 *    - 默认使用 ascii 主题（ASCII-safe，Windows Terminal 所有字体兼容）
 *
 *  Phase 5: 每类 pending activity 独立 glyph 序列。
 *    - routing: 波浪扫描 (~-~=~-~=)
 *    - reading: 眼动扫描 (.oO@Oo.)
 *    - streaming: 专用 spinner
 *    - DEEPSEEK_TUI_REDUCED_MOTION=1 关闭所有动画 glyph
 */

// ── Glyph 主题 ──

export interface GlyphTheme {
  spinnerChars: string
  spinnerLen: number
  verifyWave: string
  verifyWaveLen: number
  editingGlow: string
  editingGlowLen: number
  /** Phase 5: per-activity glyph sequences */
  routingGlyphs: string
  routingGlyphsLen: number
  readingGlyphs: string
  readingGlyphsLen: number
  streamingGlyphs: string
  streamingGlyphsLen: number
  stalledGlyph: string
  /** PR-1: SonarPulse 帧序列 — Orcana 专属声呐动效 */
  sonarFrames: string
  sonarFramesLen: number
  progressFill: string
  progressEmpty: string
  checkMark: string
  crossMark: string
  readonlyIcon: string
  sineWave: string
  rewindIcon: string
  warningIcon: string
  circleFill: string
  circleEmpty: string
  circleHalf: string
  diamondIcon: string
  arrowUp: string
  arrowDown: string
  dot: string
  separator: string
}

const ASCII_GLYPHS: GlyphTheme = {
  spinnerChars: "-\\|/-\\|/-\\|/",
  spinnerLen: 10,
  verifyWave: ".-=+*#@#*+=-.",
  verifyWaveLen: 14,
  editingGlow: "><><><><><",
  editingGlowLen: 10,
  // Phase 5: per-activity glyph sequences — visually distinct ASCII animations
  routingGlyphs: "~-~=~-~=~-~",
  routingGlyphsLen: 12,
  readingGlyphs: ".oO@Oo.oO@Oo.",
  readingGlyphsLen: 12,
  streamingGlyphs: "-\\|/-\\|/-\\|/",
  streamingGlyphsLen: 10,
  stalledGlyph: "Z",
  // PR-1: SonarPulse ASCII fallback — growing dot
  sonarFrames: ".oO0Oo",
  sonarFramesLen: 6,
  progressFill: "#",
  progressEmpty: "-",
  checkMark: "v",
  crossMark: "x",
  readonlyIcon: "(R)",
  sineWave: "~",
  rewindIcon: "<<",
  warningIcon: "!",
  circleFill: "*",
  circleEmpty: "o",
  circleHalf: "@",
  diamondIcon: "<>",
  arrowUp: "^",
  arrowDown: "v",
  dot: ".",
  separator: "-",
}

const UNICODE_GLYPHS: GlyphTheme = {
  spinnerChars: "⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏",
  spinnerLen: 10,
  verifyWave: "▁▂▃▄▅▆▇█▇▆▅▄▃▂",
  verifyWaveLen: 14,
  editingGlow: "›‹›‹›‹›‹›‹",
  editingGlowLen: 10,
  // Phase 5: per-activity glyph sequences — Unicode variants
  routingGlyphs: "⤴⤵⤴⤵⤴⤵⤴⤵",
  routingGlyphsLen: 8,
  readingGlyphs: "◌◉◎●◎◉◌○",
  readingGlyphsLen: 8,
  streamingGlyphs: "⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏",
  streamingGlyphsLen: 10,
  stalledGlyph: "☡",
  // PR-1: SonarPulse Unicode — Orcana 声呐脉冲
  sonarFrames: "◌◍◎◉◎◍",
  sonarFramesLen: 6,
  progressFill: "▓",
  progressEmpty: "░",
  checkMark: "✓",
  crossMark: "✗",
  readonlyIcon: "⦿",
  sineWave: "∿",
  rewindIcon: "⟲",
  warningIcon: "⚠",
  circleFill: "●",
  circleEmpty: "○",
  circleHalf: "◉",
  diamondIcon: "◆",
  arrowUp: "↑",
  arrowDown: "↓",
  dot: "·",
  separator: "·",
}

/** 根据环境变量选择 glyph 主题。默认 ASCII-safe。 */
export function getGlyphTheme(): GlyphTheme {
  return process.env.DEEPSEEK_TUI_UNICODE === "1" ? UNICODE_GLYPHS : ASCII_GLYPHS
}

// ── 主要令牌 ──

export const tuiTokens = {
  layout: {
    /** 窄屏断点：低于此值隐藏右栏、只显示单栏。 */
    breakpointCompact: 96,
    /** 舒适断点：高于此值显示完整右栏。 */
    breakpointComfortable: 120,
    rail: {
      min: 28,
      ideal: 36,
      max: 42,
    },
    scrollStep: Number(process.env.DEEPSEEK_TUI_SCROLL_STEP ?? "3"),
  },
  motion: {
    startupMs: Number(process.env.DEEPSEEK_TUI_STARTUP_MS ?? "700"),
    frameMs: Number(process.env.DEEPSEEK_TUI_FRAME_MS ?? "96"),
    streamFlushMs: Number(process.env.DEEPSEEK_TUI_STREAM_FLUSH_MS ?? "40"),
    /** Sonar line character sets */
    sonar: {
      idle: "─",
      active: "~",
      pulse: "=",
      stop: "!",
    },
  },
  spacing: {
    pageX: 1,
    sectionGap: 1,
    cardPadX: 1,
  },
} as const
