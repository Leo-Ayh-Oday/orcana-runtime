# CLAUDE.md — Orcana Project Instructions for AI Agents

**If you are an AI agent reading this file**: you are working on DeepSeek Orcana, a constraint-first terminal coding agent runtime. Follow the OpenWolf protocol at `.wolf/OPENWOLF.md`.

## Critical Rules

1. **YAGNI. Minimum scope.** Only implement what was asked. Never touch unrelated files.
2. **Read before write.** Check `.wolf/anatomy.md` before reading project files. Check `.wolf/cerebrum.md` Do-Not-Repeat before generating code.
3. **Log to .wolf.** After writing files, update `anatomy.md` and append to `memory.md`. After fixing bugs, log to `buglog.json`.
4. **Never hardcode keys.** Secrets stay in `.env`, never in source.
5. **Never push `.wolf/`.** It's in `.gitignore` and tracked by git but contains private development records.
6. **tsc must pass.** Always run `bun run typecheck` after changes.

## Skill System

If you need to create, modify, or evaluate a Skill, read the **Gold Standard Skill Template** first:

→ **`docs/skill-template/README.md`** — start here for overview
→ **`docs/skill-template/for-ai/ai-readme.md`** — step-by-step AI agent instructions
→ **`docs/skill-template/for-ai/ai-manifest.json`** — machine-readable schema

Three built-in Skills live in `src/skills/builtin/`:
- `ui-ux-pro-max.ts` — design authority (static visual: color, font, layout)
- `motion-pro-max.ts` — motion authority (GSAP, springs, scene dispatch)
- `motion-review.ts` — independent verifier (5-dimension scoring)

These three skills form a **Peer Skill Protocol** chain — they communicate via Design Handoff Packet (JSON), not by reading each other's full SKILL.md. The chain is: `ui-ux → handoff → motion-pro-max → code → motion-review → pass/fail`. Never allow recursive activation between them.

## Self-Evolution System

The Recursive Evolution OS can autonomously design new Skills. When it does, it reads `docs/skill-template/for-ai/ai-readme.md §Self-Evolution` for the protocol. Generated skills always start as `lifecycle: "candidate"` — never auto-promote to active.

## Key Files for AI Navigation

| To understand... | Read... |
|-----------------|---------|
| Project structure | `.wolf/anatomy.md` |
| Design decisions | `.wolf/cerebrum.md` |
| Full roadmap | `docs/v1.0-roadmap.md` |
| Architecture | `ARCHITECTURE.md` |
| Skill standard | `docs/skill-template/` |
| Gate chain | `src/agent/gates/` |
| Agent loop | `src/agent/loop.ts` |
| Hook system | `src/hooks/index.ts` |
