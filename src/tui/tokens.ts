/** tuiTokens — TUI 布局/动画/响应式的集中配置。
 *
 *  设计原则：
 *    - 所有组件引用这里的令牌，不从环境变量/自己定义常量
 *    - 环境变量只在 tokens.ts 读一次，提供 override 入口
 *    - 新增布局参数统一加到这里，不在组件里写死
 *
 *  对标报告建议的 breakpoints + rail + scroll + motion 令牌系统。
 */
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
    /** Spinner characters for pending animation (10-frame braille). */
    spinnerChars: "⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏",
    /** Sonar line character sets */
    sonar: {
      idle: "─",
      active: "~",
      pulse: "=",
      stop: "!",
      dot: "·",
    },
  },
  spacing: {
    pageX: 1,
    sectionGap: 1,
    cardPadX: 1,
  },
} as const
