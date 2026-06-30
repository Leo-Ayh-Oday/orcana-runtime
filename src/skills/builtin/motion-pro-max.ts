/** Motion Pro Max — Design-system-aware GSAP animation harness.
 *
 *  Harness-ready production animation skill. Routable, reviewable, evidence-output.
 *  Source: ~/.claude/skills/motion-pro-max/ (SKILL.md + 7 references, ~114KB total)
 *
 *  Architecture: progressive disclosure via reference routing table.
 *  SKILL.md = router + dispatch table + fatal rules. References loaded on demand.
 */
import type { SkillDef } from "../types"

export const MOTION_PRO_MAX: SkillDef = {
  name: "motion-pro-max",
  description:
    "设计系统感知的生产级动效引擎 — 26 场景速查 + 设计约束注入 + 三级质量门审查 + Evidence 输出。" +
    "路由 GSAP/ScrollTrigger/Flip/DrawSVG/MorphSVG 方案。任何动效/动画/过渡/页面切换时激活。",
  triggers: [
    "动效", "动画", "motion", "animation", "GSAP", "ScrollTrigger",
    "丝滑", "高级感", "页面过渡", "scroll", "parallax", "入场",
    "hover", "stagger", "弹跳", "淡入", "滑动", "animate",
    "tween", "timeline", "scrollTrigger", "Flip", "DrawSVG",
  ],
  autoTrigger: true,

  prompt: `# Motion Pro Max — 设计感知版动效 Harness

**GSAP 动效引擎。派发方案 → 设计约束注入 → 代码生成 → 质量门审查 → Evidence 输出 → 交付。**

---

## Reference Routing — 渐进加载

不是一次性读完。按用户意图读对应文件：

| 用户意图 | 必读内容（下方内联） | 按需深读 |
|---------|-------------------|---------|
| 生成 Hero / 卡片 / Modal 等场景 | 场景速查表 + Design Constraints 列 | scene-recipes（代码模板） |
| 选择弹簧 / 时长 / 曲线 | 弹簧速查表 + CSS 变量词典 | motion-system |
| 风格转动效策略 | 风格→动效映射表 | style-motion-map |
| React / Next / Vue / Svelte | 框架铁律（下方§框架） | framework-integration |
| 审查已有代码 | 质量门（下方§质量门） | quality-gates |
| 找灵感 / 参考 | 场景速查 + 弹簧表 | real-references |
| Canvas / 粒子 / VFX | Canvas 行 + L5 规则 | gsap-canvas |

---

## 引擎路由 — 不默认 GSAP

\`\`\`
用户要 GSAP / ScrollTrigger / page motion → GSAP
简单 hover / transition / 无 JS              → CSS-only
React 组件状态动画 / 未指定 GSAP              → 考虑 Framer Motion
TUI / terminal / CLI                          → 不使用本 skill
Canvas / 粒子                                 → GSAP Canvas + 性能 gate
\`\`\`

---

## 26 场景速查 → 技能 + 插件 + 弹簧 + 时长 + 设计约束

| # | 场景 | 技能 | 插件 | 弹簧 | 时长 | 设计约束 |
|---|------|------|------|------|------|---------|
| 1 | Hero 标题逐字入场 | gsap-text | SplitText(可选) | dramatic | 600-900ms | 字号--text-* · --ease-out-expo · stagger指数递减 · 禁ease |
| 2 | 卡片列表依次出现 | gsap-scroll | ScrollTrigger | smooth | 400-600ms | --shadow-md · 间距4n · 卡片3级 · stagger匹配列数 |
| 3 | 滚动驱动叙事 | gsap-scroll+gsap-text | ScrollTrigger | cinematic | scrub | --ease-in-out-quart · reduced-motion · 禁transition:all |
| 4 | 卡片 3D 倾斜+浮起 | gsap-interact | 无 | gentle | 300-500ms | --z-raised · 阴影加深 · 移动端matchMedia关闭 |
| 5 | 按钮/链接磁吸 | gsap-interact | 无 | snappy+elastic | 400/700ms | 5态完整 · --ease-spring · focus-visible双环 |
| 6 | 数字滚动计数器 | gsap-vfx | 无 | smooth | 2000-2500ms | --text-* · 颜色语义token · 禁ease · snap整数 |
| 7 | 自定义光标 | gsap-cursor | 无 | snappy/smooth | 100/400ms | quickTo高频 · L5氛围 · 移动端关闭 |
| 8 | Canvas 粒子/星空 | gsap-canvas | 无 | — | ticker | L5氛围 · 移动端默认关闭 · 性能审计必查 |
| 9 | SVG 线条描绘 | gsap-svg | DrawSVG | smooth | 800-1500ms | --ease-in-out-quart · ScrollTrigger once |
| 10 | SVG 形状变体 | gsap-svg | MorphSVG | smooth | 600-1000ms | --ease-in-out-quart · reduced-motion降级 |
| 11 | 页面/路由切换 | gsap-animate | 无 | power2.in/out | 300-500ms | 退<入 · no-preference包裹 · 入--ease-out-expo出--ease-in-expo |
| 12 | 视差滚动 | gsap-scroll | ScrollTrigger | none(scrub) | scrub | reduced-motion降级 · 禁动width/height |
| 13 | 图片画廊/布局切换 | gsap-scroll+gsap-plugins | ScrollTrigger+Flip | smooth | 400-600ms | --z-raised拖动时 · --shadow-lg |
| 14 | 骨架屏→内容 | gsap-scroll/gsap-animate | ScrollTrigger(可选) | gentle | 500-800ms | shimmer纯CSS · crossfade≤500ms · 语义token |
| 15 | Modal/Dialog 开合 | gsap-animate | 无 | snappy开/power2.in关 | 200-400ms | --z-modal · 遮罩OKLCH · --shadow-xl · 入--ease-out-expo出--ease-in-expo · 退<入 |
| 16 | Toast/通知入场 | gsap-animate | 无 | bouncy入/power2.in出 | 400/300ms | --z-toast · 禁霓虹发光 · 出--ease-in-expo · --shadow-lg |
| 17 | 列表项添加/删除 | gsap-animate+gsap-plugins | Flip | snappy | 300-500ms | Flip三步走 · 新项--ease-spring · 间距4n |
| 18 | 表单校验反馈 | gsap-animate | 无 | snappy | 150-300ms | shake 6帧×60ms · focus-visible品牌双环 · 错误色语义 · 禁bouncy |
| 19 | Tab/Accordion 切换 | gsap-animate | 无 | smooth | 300-400ms | Accordion先量高度 · reduced-motion · 指示器动x+width |
| 20 | Dropdown/Menu 展开 | gsap-animate | 无 | snappy | 150-250ms | --z-dropdown · scaleY+transformOrigin · 禁height · --shadow-lg |
| 21 | 拖拽排序 | gsap-interact+gsap-plugins | Draggable+Flip | snappy | 200-300ms | --z-raised拖动时 · Flip三步走 · --shadow-lg拖动态 |
| 22 | 加载/进度条 | gsap-vfx | 无 | smooth | 取决于加载 | 颜色语义token · --ease-in-out-quart · 禁ease |
| 23 | 品牌 Logo 动画 | gsap-svg+gsap-showcase | DrawSVG | cinematic | 1000-2000ms | --ease-out-expo · reduced-motion · 品牌色OKLCH |
| 24 | 光标辉光跟随 | gsap-cursor+gsap-vfx | 无 | smooth | 200-500ms | quickTo高频 · L5氛围 · 移动端关闭 · 禁霓虹发光 |
| 25 | 性能审计 | gsap-optimise→gsap-test | 无 | — | — | → 必跑 quality-gates 🔴Fatal |
| 26 | React/Next.js 集成 | gsap-react+gsap-frameworks | 无 | — | — | useGSAP()+gsap.context()+scope ref |

---

## 弹簧速查（映射到 CSS 变量）

\`\`\`
snappy    → --ease-out-quart (0.25, 1, 0.5, 1)   · 150-300ms  · Toggle/Tooltip/Dropdown/列表
smooth    → --ease-in-out-quart (0.76, 0, 0.24, 1) · 300-500ms  · 页面切换/卡片/Hover
gentle    → --ease-out-expo (0.16, 1, 0.3, 1)     · 500-800ms  · 骨架屏/悬浮卡片
dramatic  → --ease-out-expo (0.16, 1, 0.3, 1)     · 800-1200ms · Hero标题/品牌Logo
bouncy    → --ease-spring (0.34, 1.56, 0.64, 1)   · 400-600ms  · Toast/成功反馈/游戏化
cinematic → --ease-in-out-quart (0.76, 0, 0.24, 1) · 1000-2000ms· 滚动叙事/品牌故事
instant   → none                                    · 50-100ms   · 状态切换/数值更新
\`\`\`

---

## CSS 变量完整词典

\`\`\`css
:root {
  --ease-out-expo:   cubic-bezier(0.16, 1, 0.3, 1);
  --ease-out-quart:  cubic-bezier(0.25, 1, 0.5, 1);
  --ease-in-expo:    cubic-bezier(0.7, 0, 0.84, 0);
  --ease-in-quart:   cubic-bezier(0.5, 0, 0.75, 0);
  --ease-spring:     cubic-bezier(0.34, 1.56, 0.64, 1);
  --ease-back-out:   cubic-bezier(0.34, 1.3, 0.64, 1);
  --ease-in-out-quart: cubic-bezier(0.76, 0, 0.24, 1);
  --duration-instant:  50ms;
  --duration-fast:     100ms;
  --duration-normal:   200ms;
  --duration-slow:     350ms;
  --duration-enter:    450ms;
  --duration-exit:     250ms; /* 退场必须比入场快 */
}
\`\`\`

---

## Z-index 系统

\`\`\`css
--z-base: 0;         --z-raised: 10;     /* 卡片悬浮 */
--z-dropdown: 50;    --z-sticky: 100;    /* 吸顶导航 */
--z-overlay: 150;    --z-modal: 200;     /* 模态框 */
--z-toast: 250;      --z-tooltip: 300;   /* 工具提示 */
\`\`\`

## 阴影分层

\`\`\`css
--shadow-sm:  0 1px 2px rgba(0,0,0,0.06), 0 1px 3px rgba(0,0,0,0.1);
--shadow-md:  0 4px 6px rgba(0,0,0,0.05), 0 2px 4px rgba(0,0,0,0.06);
--shadow-lg:  0 10px 15px rgba(0,0,0,0.06), 0 4px 6px rgba(0,0,0,0.05);
--shadow-xl:  0 20px 25px rgba(0,0,0,0.08), 0 8px 10px rgba(0,0,0,0.05);
--shadow-2xl: 0 25px 50px rgba(0,0,0,0.12);
\`\`\`

---

## 插件依赖 & 授权说明

| 插件 | 是否需要额外授权 | 免费替代 |
|------|----------------|---------|
| ScrollTrigger | 常规可用 | IntersectionObserver + CSS |
| Flip | 常规可用 | 手写 FLIP |
| Draggable | 常规可用 | — |
| CustomEase | 免费（需注册） | — |
| SplitText | 视版本/授权而定 | 手动 split text |
| DrawSVG | 视授权而定 | stroke-dasharray/stroke-dashoffset |
| MorphSVG | 视授权而定 | CSS clip-path / 简化 crossfade |
| ScrambleText | 视授权而定 | CSS animation + steps() |
| CustomBounce | 免费（需注册） | — |
| Lenis | 免费（独立库） | — |

> **原则**：不写用户无法安装/授权的方案。如果插件不可用，直接用免费替代，不降级体验。

---

## 五级运动层级

\`\`\`
L1 焦点 — Hero/CTA → 投入50%精力，最丰富
L2 结构 — 内容区块揭示 → 有序stagger
L3 反馈 — 按钮/表单 hover → 150-300ms，禁bouncy（🟡Warning）
L4 过渡 — 路由/Tab/Modal → 一致ease，退场快于入场
L5 氛围 — 背景粒子/极光 → 可选，移动端关闭
\`\`\`

---

## 设计风格 → 动效速查

| 风格 | 弹簧 | 主打技能 | 禁止 |
|------|------|---------|------|
| Minimalist | snappy | gsap-scroll | 炫技、L5 |
| Corporate | smooth | gsap-scroll+gsap-text | bouncy |
| Glassmorphism | gentle+smooth | gsap-interact+gsap-cursor | 硬切 |
| Brutalist | instant/dramatic | gsap-scroll | 缓冲、弹性 |
| Dark Premium | smooth | gsap-cursor+gsap-vfx | — |
| Cyberpunk | bouncy+dramatic | gsap-vfx+gsap-svg+gsap-text | 克制 |
| Editorial | cinematic | gsap-scroll(pin)+gsap-text | 快切 |
| Luxury E-com | cinematic+smooth | gsap-scroll(视差)+gsap-text | 廉价弹跳 |
| Dashboard | snappy | gsap-vfx(计数器)+gsap-scroll | L1大动画 |
| Claymorphism | bouncy | gsap-interact(3D tilt) | snappy |
| Fintech | snappy+smooth | gsap-vfx(数据)+gsap-scroll | bouncy |
| Health | gentle | gsap-scroll(柔揭示) | 任何快的 |

---

## 移动端 / reduced-motion 降级矩阵

| 效果 | 桌面 (>=1024px) | 平板 (768-1023px) | 手机 (<768px) | reduced-motion |
|------|----------------|-------------------|--------------|----------------|
| 3D tilt | 开启 | 关闭 | 关闭 | 关闭 |
| cursor glow | 开启 | 关闭 | 关闭 | 关闭 |
| parallax | 轻度 | 关闭/弱化 | 关闭 | 关闭 |
| hero reveal | 完整 stagger | 简化 (y→30) | opacity fade | opacity fade |
| modal | scale + opacity | opacity + y(20px) | opacity | opacity |
| toast | slide + back | slide | opacity | opacity |
| card stagger | 完整 batch | 2列简化 | autoAlpha only | autoAlpha only |
| L5 particles | 开启 | 关闭 | 关闭 | 关闭 |
| ScrollTrigger | 完整 | 保留 L1+L2 | L1 only | clearProps |

---

## §框架 — React / Next.js 铁律（🔴Fatal）

\`\`\`tsx
// ✅ 正确: useGSAP + scope + matchMedia + cleanup
'use client';
import { useRef } from 'react';
import gsap from 'gsap';
import { ScrollTrigger } from 'gsap/ScrollTrigger';
import { useGSAP } from '@gsap/react';

gsap.registerPlugin(useGSAP, ScrollTrigger);

export default function HeroSection() {
  const scope = useRef<HTMLElement>(null);

  useGSAP(() => {
    const mm = gsap.matchMedia();
    mm.add('(min-width: 769px) and (prefers-reduced-motion: no-preference)', () => {
      const tl = gsap.timeline({ defaults: { ease: 'power3.out' } });
      tl.from('.hero-title .char', { y: 80, autoAlpha: 0, stagger: 0.02, duration: 0.7 });
      gsap.to('.hero-bg', {
        y: -100, ease: 'none',
        scrollTrigger: { trigger: '.hero', start: 'top top', end: 'bottom top', scrub: 1 }
      });
    });
    mm.add('(max-width: 768px)', () => {
      gsap.set('.hero-title .char, .hero-bg', { clearProps: 'all' });
    });
    return () => mm.revert();
  }, { scope });

  return <section ref={scope}>...</section>;
}
\`\`\`

### Fatal checklist — 任一不通过=不能交付

- [ ] **必须 \`'use client'\`** — Next.js App Router 标记
- [ ] **必须 \`useGSAP(() => {...}, { scope })\`** — 不能用 useEffect/useLayoutEffect
- [ ] **必须 scope ref** — 限定动画作用域，防止选到其他组件
- [ ] **ScrollTrigger 必须 register** — \`gsap.registerPlugin(ScrollTrigger)\`
- [ ] **matchMedia 必须 auto revert** — \`return () => mm.revert()\`
- [ ] **路由切换后不能泄漏 timeline** — useGSAP 自动 cleanup
- [ ] **同一属性多个 from() 必须设 \`immediateRender: false\`** — 否则第二个被跳过

### ❌ Bad → ✅ Good

\`\`\`tsx
// ❌ BAD: useEffect + 无 scope + 无 cleanup
useEffect(() => {
  gsap.from('.title', { y: 80 }); // 每次重渲染都重新执行
  gsap.from('.title', { x: 20 }); // 第二个 from() 跳过 Y 动画！
}, []);

// ✅ GOOD: useGSAP + scope + immediateRender
useGSAP(() => {
  gsap.from('.title', { y: 80, duration: 0.8 });
  gsap.from('.title', { x: 20, duration: 0.6, immediateRender: false });
}, { scope });
\`\`\`

---

## 质量门 — 交付前审查

### 🔴 Fatal — 必须通过（不通过=不能交付）

1. **禁止 \`outline: none\`** — 破坏键盘无障碍。改用 \`:focus-visible\` 品牌双环
2. **禁止 z-index 裸值** — 禁止 9999/1000。使用 \`--z-modal\`/\`--z-tooltip\` 变量
3. **禁止单层 box-shadow** — 使用 \`--shadow-md\`/\`--shadow-xl\` 多层变量
4. **禁止 \`color: #000\` / \`background: #fff\`** — 使用带色相的 OKLCH 近似值
5. **禁止 \`transition: all\`** — 显式指定属性列表
6. **禁止 \`ease\`/\`linear\` 关键字** — 使用 \`--ease-out-expo\`/\`--ease-in-out-quart\`
7. **动画只动 transform + opacity** — 禁止 width/height/top/left/margin/padding
8. **\`prefers-reduced-motion\` 正确降级** — 复杂动效包裹在 \`no-preference\` 中，\`reduce\` 时只保留 opacity fade
9. **正文对比度 ≥ 4.5:1，大标题 ≥ 3:1** — WCAG AA
10. **高频 mousemove/pointermove 中禁止反复 gsap.to** — 用 \`gsap.quickTo\`
11. **ScrollTrigger \`markers: true\` 不得出现在生产代码**
12. **will-change 必须在 animation complete 后释放**
13. **React 组件必须 useGSAP + scope + cleanup** — 见 §框架铁律

### 🟡 Warning — 强烈建议修复

- [ ] **无 AI 紫粉渐变** — \`#8B5CF6→#EC4899\` 是 AI 指纹。用品牌色 OKLCH
- [ ] **无霓虹发光边框** — 改用 \`--shadow-brand\` 低饱和品牌阴影
- [ ] **同项目弹簧 ≤ 2 种** — 主题弹簧(L1+L2) + 反馈弹簧(L3+L4)
- [ ] **字号使用 \`--text-*\` 阶梯** — 禁止 13px/17px/22px 随意值
- [ ] **颜色使用 OKLCH** — 禁止 HEX/RGB/HSL 直接写入
- [ ] **间距为 4 的倍数** — 禁止 5px/13px/23px
- [ ] **卡片有 3 级层级区分** — Primary/Secondary/Tertiary
- [ ] **\`font-family\` 不是 Arial/Helvetica 默认** — 加载品牌字体

### 🔵 Suggestion — 按上下文判断

- [ ] stagger 指数递减 \`delay(n)=delay(n-1)*0.8\`
- [ ] 退场比入场快 — Modal 开 450ms 关 250ms；Toast 入 400ms 出 300ms
- [ ] 交互元素 5 态完整 — Default/Hover/Active/Focus-Visible/Disabled
- [ ] \`:focus-visible\` 品牌双环 — 白色间隔+品牌色外框
- [ ] 毛玻璃有 \`border\` + \`inset\` 内发光 — 不是裸 \`backdrop-filter: blur()\`
- [ ] 移动端可点击元素 ≥ 44×44px
- [ ] L5 氛围动效移动端用 \`matchMedia\` 关闭

---

## 铁律

- **先查表，再写代码。** 26 场景速查 + 设计约束列。
- **弹簧不过 2。** 主题弹簧(L1+L2) + 反馈弹簧(L3+L4)。
- **只动 transform+opacity。** 动 width/height/top/left = 卡顿（🔴Fatal）。
- **L3 不用 bouncy。** 按钮弹跳=廉价。bouncy 仅 Toast/游戏化（🟡Warning）。
- **尊重 reduced-motion。** \`no-preference\` 包裹 + \`reduce\` 降级 opacity。
- **Z-index 用变量。** 禁裸值 9999（🔴Fatal）。
- **阴影要分层。** 禁单层 box-shadow（🔴Fatal）。
- **颜色用 OKLCH。** 禁 HEX/RGB/HSL 直接写入。
- **做完跑质量门。** 🔴Fatal→自动修 → 🟡Warning→提示 → 交付。
- **不给用户写不可安装的插件方案。** 查授权表，用免费替代。

---

## 输出格式 — 每次激活必须输出

\`\`\`markdown
## Motion Strategy
- Scene: [场景名]
- Style: [设计风格]
- Motion language: [L1/L2/L3/L4/L5]
- Spring: [弹簧名]
- Duration: [ms]
- Plugin: [插件列表]

## Design Constraints
- Tokens: [CSS 变量列表]
- Reduced motion: [降级方案]
- Performance: [transform+opacity only / will-change cleanup]
- Accessibility: [focus-visible / contrast]

## Implementation
[代码]

## Quality Gate Result
Fatal: [N] — [通过/未通过项]
Warning: [N]
Suggestion: [N]

## Evidence
- usedReferences: [引用了哪些速查表]
- selectedSceneRecipe: [场景#]
- selectedStyle: [风格]
- generatedFiles: [文件列表]
- qualityGate: { fatal: N, warning: N, suggestion: N }
- accessibility: { reducedMotion: true/false, focusVisible: true/false }
- performance: { transformOpacityOnly: true/false, quickToForPointerMove: true/false }

## Notes
[需要用户确认/需要安装插件/需要替换 token]
\`\`\``,
}
