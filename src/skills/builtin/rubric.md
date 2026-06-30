# Motion Review — 5 维评分标准

每次动效代码审查按此标准打分。满分 100，< 80 不能交付。

---

## 1. 设计系统一致性（0-20 分）

| 分数 | 标准 |
|------|------|
| 18-20 | 全部 token 化：OKLCH 颜色、CSS 变量 z-index、多层阴影、--text-* 字号、--ease-* 曲线、--duration-* 时长。0 个裸值 |
| 14-17 | 大部分 token 化。1-2 个裸 z-index 或 HEX 颜色但已注释说明 |
| 8-13 | 半数 token 化。3-5 个裸值散布在代码中 |
| 0-7 | 几乎不 token 化。9999 z-index、#000/#fff、linear ease、随机 px 字号 |

---

## 2. 动效物理感（0-20 分）

基于七原理：Momentum、Hierarchy、Weight、Delay、Follow-through、Anticipation、Overshoot。

| 分数 | 标准 |
|------|------|
| 18-20 | 7/7 原理体现清晰。入场 ease-out、退场 ease-in、stagger 指数递减、退<入、不同重量不同时长、附属元素滞后、Anticipation 克制恰当 |
| 14-17 | 5-6/7 原理体现。1-2 个原理模糊但大体方向正确 |
| 8-13 | 3-4/7 原理体现。多个元素同时动、无 Weight 区分、stagger 线性 |
| 0-7 | 0-2/7 原理体现。所有元素同时闪入、ease-in 入场、无任何节奏感 |

---

## 3. 性能（0-20 分）

| 检查项 | 分值 |
|--------|------|
| 所有动画仅动 transform + opacity | 7 |
| 高频事件（mousemove/pointermove）使用 quickTo 而非 gsap.to | 5 |
| will-change 在 onComplete 中释放 | 5 |
| 大量元素使用 batch/stagger 而非每项独立 ScrollTrigger | 3 |

---

## 4. 可访问性（0-20 分）

| 检查项 | 分值 |
|--------|------|
| prefers-reduced-motion 正确包裹 + reduce 降级为 opacity fade | 8 |
| :focus-visible 品牌双环，无 outline: none | 6 |
| 正文对比度 ≥ 4.5:1（通过 DevTools 或手动计算验证） | 6 |

---

## 5. 框架正确性（0-20 分）

| 检查项 | 分值 |
|--------|------|
| React: useGSAP + useRef scope + 自动 cleanup（不用 useEffect） | 8 |
| ScrollTrigger/plugin 正确 registerPlugin | 6 |
| matchMedia 有 return () => mm.revert() cleanup | 6 |

---

## 交付规则

| Fatal | Score | Verdict |
|-------|-------|---------|
| > 0 | — | ❌ CANNOT DELIVER. Fix all Fatal first. |
| 0 | < 80 | ❌ CANNOT DELIVER. Address dimension gaps. |
| 0 | 80-89 | ✅ PASS with Warnings. Fix warnings before merge. |
| 0 | 90-100 | ✅ PASS. Ship it. |
