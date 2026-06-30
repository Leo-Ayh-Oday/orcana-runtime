# Reference Implementation: motion-pro-max v2.0.0

**The canonical Level 3 Harness-grade Skill.** Every design decision in the standard is exercised here.

---

## Directory Structure (15 files, 184KB)

```
motion-pro-max/
├── SKILL.md                 (17.9KB)  Router + dispatch table + fatal rules + output contract
├── manifest.json            (1.5KB)   Machine routing: triggers, useWhen, doNotUseWhen,
│                                       allowedTools, referenceRouting, peerSkills
├── provenance.json          (1.2KB)   Origin trace: source material, changelog, security posturé
├── checks.json              (3.8KB)   13 Fatal (regex + structural), 8 Warning, 7 Suggestion
├── rubric.md                (1.9KB)   5-dimension scoring 0-100, delivery rules
├── evidence.schema.json     (2.3KB)   JSON Schema for EvidenceLedger required fields
├── references/              (7 files, 114KB)
│   ├── scene-recipes.md             27 scene recipes with code templates
│   ├── motion-system.md             Spring/duration → CSS variable mapping
│   ├── motion-principles.md         Seven principles of animation
│   ├── quality-gates.md             Fatal/Warning/Suggestion checklist
│   ├── style-motion-map.md          22 styles → animation mapping
│   ├── framework-integration.md     React/Vue/Svelte integration
│   └── real-references.md           Search patterns + classic effects
└── examples/
    ├── hero-nextjs.bad.tsx          6 Fatal violations annotated
    └── hero-nextjs.fixed.tsx        All fixed + Evidence block attached
```

---

## How Each Component Contributes

### SKILL.md — The Router, Not the Encyclopedia

The first thing you see: "GSAP 动效引擎。派发方案 → 设计约束注入 → 代码生成 → 质量门审查 → Evidence 输出 → 交付。"

Then immediately: **a routing table**. Not a wall of text:

| 用户意图 | 必读 | 按需深读 |
|---------|------|---------|
| 生成 Hero | 场景速查表 | scene-recipes.md |
| 选弹簧 | 弹簧速查表 | motion-system.md |
| 风格转动效 | 风格→动效映射表 | style-motion-map.md |

This is progressive disclosure in action — the harness knows exactly what to load.

### manifest.json — Machine Contract

```json
{
  "name": "motion-pro-max",
  "version": "2.0.0",
  "lifecycle": "active",
  "tier": "harness-grade",
  "triggers": ["动效", "motion", "GSAP", ...],
  "useWhen": ["用户要求生成前端动效代码", ...],
  "doNotUseWhen": ["纯视觉静态UI", "后端/CLI/TUI", ...],
  "allowedTools": ["read_file", "search", "web_search"],
  "riskLevel": "medium",
  "referenceRouting": {
    "生成 Hero": ["scene-recipes.md"],
    "选弹簧": ["motion-system.md"],
    ...
  }
}
```

The harness reads this *before* loading SKILL.md. If the prompt doesn't match triggers, or matches doNotUseWhen, the skill never enters context.

### checks.json — Machine-Executable Quality Gates

```json
{
  "fatal": [
    {
      "id": "no-transition-all",
      "pattern": "transition\\s*:\\s*all\\b",
      "message": "禁止 transition: all",
      "autoFix": false
    }
  ]
}
```

These are regex patterns. A harness can scan generated code without an LLM and flag violations instantly.

### evidence.schema.json — Required Output Fields

```json
{
  "required": ["usedReferences", "qualityGate", "accessibility", "performance"],
  "properties": {
    "qualityGate": { "required": ["fatal", "warning", "suggestion"] },
    "accessibility": { "required": ["reducedMotion", "focusVisible"] }
  }
}
```

The model MUST fill these fields. The EvidenceLedger records them. If the model claims "tests passed" but `qualityGate.fatal > 0`, the system knows it's lying.

### provenance.json — Supply Chain Trace

```json
{
  "name": "motion-pro-max",
  "version": "2.0.0",
  "source": {
    "origin": "Built from GSAP official docs + DESIGN_SYSTEM_v1.1",
    "references": ["https://gsap.com/resources/React/", ...]
  },
  "changelog": [
    {"version": "1.0.0", "date": "2026-06-04", "changes": "Initial version"},
    {"version": "2.0.0", "date": "2026-06-30", "changes": "Harness-grade upgrade"}
  ]
}
```

If GSAP changes its React API, we know exactly which skills to update and who to notify.

### Peer Skill Protocol — Three-Skill Collaboration

motion-pro-max doesn't work alone. It's part of a chain:

```
ui-ux-pro-max-plus → Design Handoff Packet (JSON)
        ↓
motion-pro-max → reads handoff → generates animation code
        ↓
motion-review → scores 0-100 → Fatal>0 blocks delivery
```

The Handoff Packet is the interface contract — 6 JSON fields. No reading the other skill's full SKILL.md. No recursive activation.

---

## What Makes This "Harness-grade"?

1. **Routeable**: manifest.json routing table + doNotUseWhen prevents wrong activation
2. **Progressive**: reference routing loads only relevant files per user intent
3. **Reviewable**: checks.json for machines, rubric.md for humans, motion-review for independent verification
4. **Evidence-output**: every generation produces structured evidence for the EvidenceLedger
5. **Traceable**: provenance.json records origin, version, and security posture
6. **Safe**: allowedTools whitelist, riskLevel declaration, peer review required
7. **Anti-recursive**: peer protocol prevents infinite activation loops

---

## What a New Level 3 Skill Author Should Copy

From this reference, copy:

- `manifest.json` structure (fill in your own triggers/useWhen/doNotUseWhen)
- `checks.json` format (define your domain-specific fatal/warning/suggestion patterns)
- `rubric.md` template (define your scoring dimensions)
- `evidence.schema.json` structure (define your required evidence fields)
- `provenance.json` structure (fill in your source material)
- `SKILL.md` section order: What → Reference Routing → Dispatch Table → Quality Gates → Output Contract → Peer Protocol

**What NOT to copy**: the specific content. Your skill's dispatch table, quality gates, and reference routing are domain-specific.

---

## Key Design Decisions Made During Development

1. **26 scenes → one table, not 26 sections**: A single dispatch table (scene → skill + plugin + spring + duration + constraint) saved ~15KB of context vs. one subsection per scene.

2. **Engine routing before scene dispatch**: The "不默认 GSAP" decision tree prevents the skill from forcing GSAP on CSS-only or Framer Motion situations.

3. **Fatal rules are ordered**: outline:none first (a11y), z-index bare values second (design system), transition:all third (performance). Order matters — the first hit stops the scan.

4. **Bad → Good examples are adjacent**: The reader sees the mistake and the fix on the same screen. No scrolling between "here's what not to do" and "here's the correct version."

5. **Mobile degradation as a matrix, not prose**: 9 effects × 4 breakpoints = a table, not 9 paragraphs. Models parse tables more reliably than prose conditionals.
