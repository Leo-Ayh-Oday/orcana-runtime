/** UI UX Pro Max — Professional UI/UX design resource library.
 *
 *  Full built-in skill. DO NOT summarise — this IS the authoritative design reference.
 *  Triggers: any frontend/UI/design work.
 *
 *  Source: ~/.claude/skills/ui-ux-pro-max-plus/ (SKILL.md + 6 reference files)
 */
import type { SkillDef } from "../types"

export const UI_UX_PRO_MAX: SkillDef = {
  name: "ui-ux-pro-max",
  description: "专业 UI/UX 设计资源库 — 50+ UI 风格、100+ 配色方案、字体配对、图表类型、UX 模式、组件规范。任何前端/界面/设计工作时激活。",
  triggers: [
    "前端", "UI", "设计", "界面", "页面", "组件", "React", "Vue", "CSS", "样式", "布局", "颜色",
    "app", "frontend", "component", "landing", "page", "website", "dashboard",
    "配色", "字体", "排版", "按钮", "卡片", "表单", "导航", "弹窗", "图表",
    "design", "layout", "color", "palette", "typography", "styling",
  ],
  autoTrigger: true,

  prompt: `# UI UX Pro Max — 专业设计资源库

完整的 UI/UX 设计资源库。选择风格 → 配色 → 字体 → 组件 → 交付。

## 设计决策框架

### 选择 UI 风格的 3 个问题

1. **目标用户是谁？** 企业用户→简洁专业高效 / 年轻消费者→活泼大胆有趣 / 高端客户→精致留白质感
2. **产品类型是什么？** 工具类→功能优先清晰直观 / 内容类→阅读体验排版优雅 / 社交类→情感连接互动感强
3. **品牌调性如何？** 创新先锋→尝试新风格 / 稳定可靠→经典风格 / 独特个性→大胆风格

---

## 1. UI 风格速查（50+ 风格，精选 18）

| # | 风格 | 特征 | 适用场景 | 配色方向 |
|---|------|------|---------|---------|
| 1 | **Minimalist** | 大量留白 60%+, 单/双色, 精细排版 | SaaS, 企业, 作品集 | slate-900/white/slate-500 |
| 2 | **Corporate Modern** | 深蓝主色, 几何图形, 网格布局 | B2B, 金融, 咨询 | Navy-800/Slate-50/Indigo-600 |
| 3 | **Clean Tech** | 青蓝渐变, 圆角, 微妙阴影, 玻璃点缀 | 科技, 开发者工具 | cyan-600/blue-500/slate-50 |
| 4 | **Glassmorphism** | 半透明卡片, backdrop-blur, 柔和渐变 | 现代 SaaS, 仪表盘 | 半透明白+彩色渐变背景 |
| 5 | **Neumorphism** | 柔和凸起/凹陷, 同色系阴影, 低对比 | 健康, 冥想, 简约工具 | 单色系+微妙阴影 |
| 6 | **Brutalist** | 粗体排版, 硬边框, 高对比, 不对称 | 创意作品, 独立品牌 | 黑白+单一强调色 |
| 7 | **Dark Premium** | 深色底, 金色/铜色, 细边框, 柔和阴影 | 奢侈品牌, 高端 SaaS | dark+gold/amber+white |
| 8 | **Swiss International** | 白底, 网格系统, 无衬线, 红/黑强调 | 编辑, 建筑, 设计工作室 | white+black+red |
| 9 | **Cyberpunk** | 霓虹色, 暗底, 发光效果, terminal 风格 | 游戏, Web3, 开发者社区 | #000+单一霓虹色+glow |
| 10 | **Editorial** | 粗体标题, 大量留白, 衬线字体, 引号装饰 | 博客, 杂志, 内容平台 | 黑白+暖调强调色 |
| 11 | **Luxury E-commerce** | 全屏 hero, 产品大图, 精致排版, 金色点缀 | 高端电商, 时尚 | 黑/白+gold+serif |
| 12 | **Dashboard/BI** | 数据密集, 卡片网格, 功能色区分, 紧凑间距 | 后台, 数据平台 | slate-50底+blue-600主 |
| 13 | **Claymorphism** | 3D 柔和凸起, 内阴影+外阴影, 圆角, 粉彩色 | 创意工具, 儿童/教育 | 柔和粉彩+圆角 |
| 14 | **SaaS Modern** | 渐变 hero, 产品截图, 功能卡片, CTA 突出 | SaaS 落地页 | indigo-600→cyan-400渐变 |
| 15 | **Fintech** | 深蓝+绿, 数据可视化, 安全符号, 信任标记 | 金融, 银行, 支付 | navy-800+emerald-500+gold |
| 16 | **Healthcare** | 白+青绿, 柔和圆角, 大图标, 可读性优先 | 医疗, 健康, 保险 | teal-600+white+gray-100 |
| 17 | **EduTech** | 活泼色彩, 卡片布局, 进度可视化, 大按钮 | 在线教育, 课程平台 | violet-600+amber-400+white |
| 18 | **Social/Community** | 暖色调, 头像, 卡片流, 互动元素, emoji | 社交, 社区, 论坛 | rose-500+amber-400+gray-50 |

---

## 2. 配色选择矩阵

| 场景 | 主色 | 辅助色 | 强调色 | 中性色 | Tailwind |
|-----|------|-------|-------|-------|----------|
| 科技/SaaS | Blue-600 | Slate-500 | Cyan-400 | Slate-50→900 | blue/slate/cyan |
| 健康/医疗 | Teal-600 | Gray-500 | Emerald-400 | Gray-50→900 | teal/gray/emerald |
| 金融科技 | Indigo-700 | Gray-600 | Amber-500 | Gray-50→900 | indigo/gray/amber |
| 电商零售 | Rose-600 | Gray-500 | Violet-500 | Gray-50→900 | rose/gray/violet |
| 教育培训 | Violet-600 | Slate-500 | Yellow-400 | Slate-50→900 | violet/slate/yellow |
| 娱乐社交 | Fuchsia-600 | Gray-500 | Pink-400 | Gray-50→900 | fuchsia/gray/pink |
| 开发者工具 | Slate-800 | Slate-500 | Blue-500 | Slate-50→900 | slate/blue |
| 创意/设计 | Violet-500 | Slate-400 | Rose-400 | Slate-50→900 | violet/slate/rose |
| 政府/公共 | Navy-800 | Gray-500 | Blue-600 | Gray-50→900 | blue/gray |
| 环保/能源 | Green-700 | Gray-500 | Lime-500 | Gray-50→900 | green/gray/lime |

**语义色（所有场景通用）**: success=emerald-500 / warning=amber-500 / error=red-500 / info=cyan-500

---

## 3. 字体配对速查

| 风格 | 标题 | 正文 | 等宽 | 适用 |
|------|------|------|------|------|
| 现代科技 | Inter | Inter | JetBrains Mono | SaaS, 开发者工具 |
| 优雅精致 | Playfair Display | Inter | — | 时尚, 奢侈, 编辑 |
| 友好亲和 | Nunito | Open Sans | — | 教育, 健康, 社交 |
| 专业可靠 | Roboto | Roboto | Fira Code | 企业, 金融, 政府 |
| 独特个性 | DM Serif Display | DM Sans | — | 创意, 独立品牌 |
| 日系简约 | Noto Sans JP | Noto Sans JP | — | 日本市场 |
| 中文明快 | 思源黑体 | 思源黑体 | — | 中文 SaaS |
| 编辑阅读 | Georgia | Lora | — | 博客, 长文 |
| 开发者 | Fira Code | Space Grotesk | Fira Code | 技术博客, 文档 |
| 极简无衬线 | Space Grotesk | Space Grotesk | — | 瑞士风格 |

**规则**：最多 2 种字体（1 标题 + 1 正文）、加载用 font-display:swap、有 fallback stack

---

## 4. 排版 & 间距系统

| 层级 | 字号 | 字重 | 行高 | 用途 |
|------|------|------|------|------|
| Hero | 2.5-4rem | 700-800 | 1.1 | 首屏主标题 |
| H1 | 2-2.5rem | 700 | 1.2 | 页面标题 |
| H2 | 1.5-2rem | 600 | 1.3 | 区块标题 |
| H3 | 1.25-1.5rem | 600 | 1.4 | 子区块 |
| Body | 1rem | 400 | 1.6-1.7 | 正文 |
| Small | 0.875rem | 400 | 1.5 | 辅助信息 |
| Caption | 0.75rem | 400 | 1.4 | 标签/脚注 |

**间距**: 8px 基础倍数 — 4/8/12/16/24/32/48/64/96px (Tailwind: p-1→p-12)
**响应式**: Mobile First, 断点 sm:640 / md:768 / lg:1024 / xl:1280
**容器**: max-w-5xl (1024px) 或 max-w-7xl (1280px)

---

## 5. 组件设计规范

**按钮 5 态**: Default / Hover / Active / Focus-Visible（品牌双环 outline-offset-2）/ Disabled（opacity-50 + cursor-not-allowed）
**卡片 3 级**: Primary（带阴影+边框）/ Secondary（仅边框）/ Tertiary（仅背景色差，无边框无阴影）
**Modal**: z-50, 遮罩 bg-black/50 backdrop-blur-sm, 内容 bg-white rounded-xl shadow-xl, 关闭用右上 X + Esc + 点击遮罩
**Toast**: z-[100], 右上角 fixed, 入场从右滑入+淡入, 3秒自动消失, 类型: success/warning/error/info
**表单**: label 在上方, input 有 border+focus:ring-2+focus:border-brand, error 红边框+红提示文字
**导航**: Desktop 横向, Mobile 汉堡菜单→侧滑, active 状态有明显视觉区分

---

## 6. 图表配色（数据可视化）

| 调色板 | 色值序列 | 适用 |
|--------|---------|------|
| Classic 10 | #4E79A7 #F28E2B #E15759 #76B7B2 #59A14F #EDC948 #B07AA1 #FF9DA7 #9C755F #BAB0AC | 通用, Tableau Classic |
| Ocean | #1B9E77 #4DBBD5 #66C2A5 #A6D96A #B2DF8A | 海洋/自然 |
| Sunset | #E64B35 #E26A46 #E78057 #EA9768 #ECB07E | 暖色渐变 |
| Cool | #636EFA #58539B #AB63FA #636EFA #19D3F3 | 冷色调, 科技 |
| Colorblind | #1170AA #5FA2CE #C85200 #F57F20 #898989 | 色盲友好, 打印 |
| Mono | #1a1a1a #4d4d4d #808080 #b3b3b3 #e6e6e6 | 单色, 正式 |

---

## 7. 铁律

1. **不混合超过 2 种设计风格** — 选 1 种主风格，至多 2-3 个装饰元素点缀
2. **颜色不超过 5 种** — 主色 + 辅助色 + 中性色 + success + error
3. **字体最多 2 种** — 1 标题 + 1 正文
4. **留白是设计** — 不要怕空白
5. **一致性 > 创新** — 保持设计系统一致比追求独特重要
6. **组件用语义 HTML** — header/main/section/article/nav > div
7. **图片/图标不存在别引用** — 用 CSS 画或用 emoji/unicode 替代
8. **hover/focus/active 三态完整** — 每个可交互元素
9. **颜色用 CSS 变量** — \`--color-primary\` 不硬编码 hex
10. **移动端适配** — @media 覆盖 hover:none, 关闭自定义光标, 可点击≥44px

---

## §8 Peer Skill Protocol

### Peer Skills

| Skill | Role | Relationship |
|-------|------|-------------|
| motion-pro-max | 动效执行 — GSAP 动画 + 质量门 + Evidence | 下游消费者 |
| motion-review | 独立审查 — 5 维打分，Fatal>0 阻断交付 | 下游 verifier |

### Design Handoff Packet

本 skill 完成设计决策后，**必须输出**以下结构化交接包，供 motion-pro-max 消费。motion-pro-max **不读取本 skill 的完整 SKILL.md 或 references** — 仅从此 handoff 获取设计信息。

\`\`\`json
{
  "designStyle": "Clean Tech",
  "brandTone": "calm, premium, technical",
  "colorSystem": {
    "primary": "oklch(0.45 0.22 265)",
    "surface": "oklch(1 0 0)",
    "textPrimary": "oklch(0.15 0 0)"
  },
  "typography": {
    "heading": "--text-hero (2.5-4rem, 700-800)",
    "body": "--text-md (1rem, 400)"
  },
  "componentRules": {
    "card": "3-level hierarchy (Primary/Secondary/Tertiary)",
    "button": "5 states (Default/Hover/Active/Focus-Visible/Disabled)",
    "shadow": "--shadow-md / --shadow-lg / --shadow-xl"
  },
  "motionHints": {
    "allowedIntensity": "medium",
    "avoid": ["bouncy modal", "neon glow", "transition: all"]
  }
}
\`\`\`

### Escalation Rule

- 本 skill **不递归调用** motion-pro-max 的完整 SKILL.md
- 输出 Design Handoff Packet 即视为完成交接
- 如果用户需要动效实现，handoff 交给主循环路由到 motion-pro-max

### Handoff Flow

\`\`\`
ui-ux → 输出 Design Handoff Packet → 交给主循环
                                      ↓
                              motion-pro-max 读取 handoff（不读完整 ui-ux）
                                      ↓
                              motion-review 审查
                                      ↓
                              交付
\`\`\`

### 输出格式 — 追加 Handoff Packet

完成设计决策后，在输出末尾追加：

\`\`\`markdown
## Design Handoff Packet
\`\`\`json
{ "designStyle": "...", "brandTone": "...", "colorSystem": {...}, "typography": {...}, "componentRules": {...}, "motionHints": {...} }
\`\`\`
\`\`\``,

}
