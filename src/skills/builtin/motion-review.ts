/** Motion Review — Independent motion quality reviewer.
 *
 *  Takes generated animation code and scores it against 5 dimensions.
 *  Fatal > 0 → cannot deliver. Score < 80 → cannot deliver.
 *
 *  Activated when user asks for motion/animation code review,
 *  or when motion-pro-max completes code generation.
 */
import type { SkillDef } from "../types"

export const MOTION_REVIEW: SkillDef = {
  name: "motion-review",
  description:
    "动效代码独立审查器 — 5 维打分（设计一致性/物理感/性能/可访问性/框架正确性），三级质量门。" +
    "Fatal>0 或总分<80 不能交付。任何动效代码审查/质量检查时激活。",
  triggers: [
    "审查动效", "review motion", "动效审查", "动画审查",
    "motion review", "animation review", "检查动画", "动效质量",
  ],
  autoTrigger: false, // Manual trigger only — invoked explicitly or by motion-pro-max

  prompt: `# Motion Review — 动效交付审查器

独立审查动效代码。5 维打分 + 三级质量门。Fatal > 0 或总分 < 80 = 不能交付。

---

## 审查工作流

\`\`\`
接收动效代码
  ↓
逐项检查 🔴Fatal → 发现任何 → 自动修复 → 重跑
  ↓
逐项检查 🟡Warning → 列出 → 用户确认
  ↓
逐项检查 🔵Suggestion → 按上下文判断 → 提示
  ↓
5 维打分 → 总分 < 80 不能交付
  ↓
输出 Review Report
\`\`\`

---

## 5 维评分（每维 20 分，满分 100）

### 1. 设计系统一致性（0-20）
- Token 使用：颜色 OKLCH? Z-index 用变量? 阴影分层?
- 弹簧：命名曲线? 不用 ease/linear?
- 字号：用 --text-* 阶梯? 没有随意 px 值?
- 间距：4 的倍数?

### 2. 动效物理感（0-20）
- 弹簧选择契合场景? 无机械生硬感?
- Stagger 节奏合理? 总揭示时长 ≤ 600ms?
- 退场比入场快?
- L3 反馈无 bouncy?

### 3. 性能（0-20）
- 只动 transform + opacity?
- 高频事件用 quickTo?
- will-change 用完释放?
- 无 transition: all?
- ScrollTrigger markers 不出现?
- 大量元素 batch/Stagger 而非独立 ScrollTrigger?

### 4. 可访问性（0-20）
- prefers-reduced-motion 包裹?
- :focus-visible 品牌双环? 无 outline: none?
- 对比度 ≥ 4.5:1?
- 移动端可点击 ≥ 44×44px?
- 移动端降级矩阵正确?

### 5. 框架正确性（0-20）
- React: useGSAP + scope + cleanup?
- Next.js: 'use client'?
- ScrollTrigger: registerPlugin?
- matchMedia: auto revert?
- 无 timeline 泄漏?
- 同一属性多个 from() 设 immediateRender: false?

---

## 交付规则

\`\`\`
Fatal > 0        → 不能交付。列出所有 Fatal，逐项自动修复。
Warning > 3      → 建议修。列出所有 Warning，用户确认。
Score < 80       → 不能交付。逐维度说明扣分原因和修复方向。
Score >= 80      → 通过。输出 Review Report。
\`\`\`

---

## 🔴 Fatal Checklist — 逐项检查

| # | Fatal | 检查方式 | 自动修复 |
|---|-------|---------|---------|
| 1 | 无 \`outline: none\` | grep \`outline\\s*:\\s*none\` | 改为 \`:focus-visible\` 双环 |
| 2 | 无 z-index 裸值 | grep \`z-index\\s*:\\s*(?!var)\d+\` | 替换为 --z-* 变量 |
| 3 | 无单层 box-shadow | 检查阴影值数量 | 用 --shadow-md/xl 替换 |
| 4 | 无 \`color: #000\`/\`background: #fff\` | grep 纯黑白 | 改为 OKLCH 近似值 |
| 5 | 无 \`transition: all\` | grep | 显式列出属性 |
| 6 | 无 \`ease\`/\`linear\` | grep ease/linear 关键字 | 改为命名曲线 |
| 7 | 只动 transform+opacity | grep width/height/top/left/margin | 用 transform 替代 |
| 8 | \`prefers-reduced-motion\` 包裹 | grep 存在性 | 包裹在 no-preference 中 |
| 9 | 对比度 ≥ 4.5:1 | 手动计算/Chrome DevTools | 调色 |
| 10 | 高频事件中无裸 gsap.to | grep mousemove/pointermove 内的 gsap.to | 改为 quickTo |
| 11 | 无 ScrollTrigger markers | grep \`markers\\s*:\\s*true\` | 改为 false/删除 |
| 12 | will-change 释放 | 检查 onComplete 回调 | 加 \`onComplete: () => el.style.willChange = 'auto'\` |
| 13 | React: useGSAP + scope + cleanup | 检查导入+模板 | 修复模板 |

---

## 输出格式

\`\`\`markdown
## Motion Review Report

### Quality Gates
🔴 Fatal: [N] — [通过项/未通过项列表]
🟡 Warning: [N] — [列表]
🔵 Suggestion: [N] — [列表]

### 5-Dimension Scores
| 维度 | 得分 | 扣分原因 |
|------|------|---------|
| 1. 设计系统一致性 | /20 | |
| 2. 动效物理感 | /20 | |
| 3. 性能 | /20 | |
| 4. 可访问性 | /20 | |
| 5. 框架正确性 | /20 | |
| **总分** | **/100** | |

### Verdict
[PASS / FAIL] — [说明]

### Fixes Applied (if any)
[自动修复的变更列表]

### Recommendations
[给用户的建议]
\`\`\``,
}
