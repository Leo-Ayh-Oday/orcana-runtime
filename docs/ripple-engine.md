# Ripple Engine 2.0

<p align="center"><strong>TypeScript-aware cascade detection engine. Prevents broken writes by tracing API change impact across the codebase.</strong></p>

---

## Architecture Overview

```
                           ┌──────────────────────────┐
                           │     previewEdit()         │
                           │  oldContent + newContent  │
                           └────────────┬─────────────┘
                                        │
                  ┌─────────────────────┼─────────────────────┐
                  │                     ▼                     │
                  │  ┌─────────────────────────────────────┐  │
                  │  │        Layer 1: API Diff             │  │
                  │  │  extractSymbols → toSymbolShapes     │  │
                  │  │  → diffApiSurface → ApiChange[]      │  │
                  │  │  (8 change kinds, pre-computed       │  │
                  │  │   severity, structural diff)         │  │
                  │  └──────────────────┬──────────────────┘  │
                  │                     │                     │
                  │         changedSymbolNames()              │
                  │                     │                     │
                  │     ┌───────────────┼───────────────┐     │
                  │     │               │               │     │
                  │     ▼               ▼               ▼     │
                  │ ┌─────────┐  ┌───────────┐  ┌──────────┐ │
                  │ │ Layer 2 │  │  Legacy   │  │ Layer 7  │ │
                  │ │Semantic │  │ findCallers│  │ AstGrep  │ │
                  │ │Reference│  │ (text AST) │  │Provider  │ │
                  │ │(PRIMARY)│  │ (FALLBACK) │  │(ENRICH)  │ │
                  │ └────┬────┘  └─────┬─────┘  └────┬─────┘ │
                  │      │             │             │       │
                  │      └──────────┬──┴─────────────┘       │
                  │                 │  dedup by file:line     │
                  │                 ▼                         │
                  │     ┌───────────────────┐                 │
                  │     │  RippleCaller[]   │                 │
                  │     │  (all call sites) │                 │
                  │     └────────┬──────────┘                 │
                  │              │                            │
                  │              ▼                            │
                  │  ┌─────────────────────────────────────┐  │
                  │  │      Layer 3: Usage Classifier       │  │
                  │  │  classifyCallers(callers, changes)   │  │
                  │  │  → 14 UsageKind patterns             │  │
                  │  │  → resolveAction(kind × usage)       │  │
                  │  │  → 500+ concrete action mappings     │  │
                  │  └──────────────────┬──────────────────┘  │
                  │                     │                     │
                  │                     ▼                     │
                  │  ┌─────────────────────────────────────┐  │
                  │  │    Layer 4: Verification Map         │  │
                  │  │  buildVerificationMap()              │  │
                  │  │  → findTestFiles (4 conventions)     │  │
                  │  │  → buildSteps (typecheck + test)     │  │
                  │  │  → coverage estimation               │  │
                  │  │  → verificationStrictness wired      │  │
                  │  └──────────────────┬──────────────────┘  │
                  │                     │                     │
                  │                     ▼                     │
                  │  ┌─────────────────────────────────────┐  │
                  │  │        Layer 5: Findings             │  │
                  │  │  switch(change.kind) → 8 patterns    │  │
                  │  │  + memory hits + overflow/depth      │  │
                  │  └──────────────────┬──────────────────┘  │
                  │                     │                     │
                  │                     ▼                     │
                  │           ┌─────────────────┐             │
                  │           │  RippleReport    │             │
                  │           └────────┬────────┘             │
                  │                    │                      │
                  └────────────────────┼──────────────────────┘
                                       │
                       ┌───────────────┼───────────────┐
                       │               │               │
                       ▼               ▼               ▼
               ┌──────────────┐ ┌────────────┐ ┌────────────┐
               │  Gate: Block │ │ Obligation │ │  Cascade   │
               │  the write   │ │  Tracker   │ │   Plan     │
               │  (pre-round) │ │ (exit gate)│ │ (suggestion)│
               └──────────────┘ └────────────┘ └────────────┘
```

## Data Flow (Timeline)

```
 Time ──────────────────────────────────────────────────────────►

 ┌──────┐    ┌──────┐    ┌──────────┐    ┌───────────┐    ┌──────────┐
 │ old  │    │ Api  │    │ Caller   │    │  Usage    │    │ Verify   │
 │content│───►│ Diff │───►│ Discovery│───►│ Classify  │───►│   Map    │───► Report
 │ new  │    │ PR 2 │    │ PR 3+7   │    │  PR 4     │    │  PR 6    │
 │content│    │      │    │          │    │           │    │          │
 └──────┘    └──────┘    └──────────┘    └───────────┘    └──────────┘
                │              │               │               │
                ▼              ▼               ▼               ▼
          8 change        semantic      14 usage kinds    test files
          kinds with      → text fall    → 500+ actions   + coverage
          severity        → ast-grep     per combo        + strictness
```

## 7-Layer Architecture

| Layer | PR | Module | Input | Output | Rating |
|-------|----|--------|-------|--------|--------|
| **Baseline** | — | engine.ts | old/new content | string[] callers | 5.5 |
| **Layer 1** | PR 2 | `api-diff.ts` | SymbolShape maps | ApiChange[] (8 kinds) | 6.8 |
| **Layer 2** | PR 3 | `semantic-reference-provider.ts` | changedSymbols | SemanticFindResult | 7.5 |
| **Layer 3** | PR 4 | `usage-classifier.ts` | callers × changes | UsageImpact[] (14 kinds) | 7.9 |
| **Layer 4** | PR 5 | `obligations.ts` | report → obligations | Hard exit gate | 8.2 |
| **Layer 5** | PR 6 | `verification-map.ts` | changes × callers | VerificationMap | 8.4 |
| **Layer 6** | PR 7 | `astgrep-provider.ts` | symbols → sg scan | extra callers | 8.5 |
| **Final** | — | engine.ts integration | all layers | RippleReport | **8.5/10** |

## Layer Details

### Layer 1 — API Diff (`api-diff.ts`)

Compares old and new symbol tables, produces structured change records.

```
SymbolShape (old)        SymbolShape (new)
┌─────────────────┐      ┌─────────────────┐
│ name, kind      │      │ name, kind      │
│ exported, async │      │ exported, async │
│ header, return  │      │ header, return  │
│ fields[], line  │      │ fields[], line  │
│ precision pos   │      │ precision pos   │
└────────┬────────┘      └────────┬────────┘
         │                        │
         └───────────┬────────────┘
                     ▼
            diffApiSurface()
                     │
                     ▼
              ApiChange[]
         ┌───────────────────────────────┐
         │ 8 change kinds:               │
         │ • export_removed     (block)  │
         │ • export_added       (info)   │
         │ • signature_changed  (block)  │
         │ • async_boundary     (block)  │
         │ • return_type        (warn)   │
         │ • kind_changed       (block)  │
         │ • field_removed      (block)  │
         │ • field_added        (info)   │
         │                               │
         │ Each: severity + detail       │
         │ pre-computed                  │
         └───────────────────────────────┘
```

### Layer 2+7 — Caller Discovery (3 paths)

```
          ┌─────────────────────────────┐
          │  PRIMARY: Semantic Reference │
          │  ts.createProgram +          │
          │  TypeChecker.findReferences  │
          │  → resolves imports/exports  │
          │  → follows alias chains      │
          │  → filters false positives   │
          └──────────┬──────────────────┘
                     │ ready? ──── yes ──► semantic result
                     │ no
                     ▼
          ┌─────────────────────────────┐
          │  FALLBACK: Text AST Scan     │
          │  ts.createSourceFile + walk  │
          │  + alias resolution map      │
          │  + verifyCallersSemantically │
          └──────────┬──────────────────┘
                     │
                     ▼
          ┌─────────────────────────────┐
          │  ENRICH: AstGrep Provider    │
          │  sg scan --json (external)   │
          │  6 pattern types per symbol  │
          │  dedup by file:line          │
          │  graceful degrade (no sg)    │
          └─────────────────────────────┘
```

**AstGrep patterns (6 per symbol):**
| # | Pattern | Matches |
|---|---------|---------|
| 1 | `import { $$, sym, $$ } from '$$$'` | Named imports |
| 2 | `export { $$, sym, $$ }` | Re-exports |
| 3 | `new sym($$$)` | Constructor calls |
| 4 | `$$$.sym($$$)` | Method calls |
| 5 | `sym($$$)` | Direct calls |
| 6 | `sym` | All references (catch-all) |

### Layer 3 — Usage Classifier (`usage-classifier.ts`)

```
          RippleCaller + ApiChange
                    │
                    ▼
          classifyOneCaller()
          (14 regex patterns, ordered by specificity)
                    │
    ┌───────┬───────┼───────┬───────┬───────┐
    ▼       ▼       ▼       ▼       ▼       ▼
 extends  new    generic  spread  method  call_expr
implements       _arg     _expr   _call     │
    │       │       │       │       │       │
    └───────┴───────┴───────┴───────┴───────┘
                    │
                    ▼
          resolveAction(kind × usage)
          ┌───────────────────────────────────────────┐
          │ async_boundary + call_expr                 │
          │   → "add await to this call"               │
          │ export_removed + type_ref                  │
          │   → "migrate type reference to replacement"│
          │ signature_changed + call_expr              │
          │   → "update arguments to new signature"    │
          │ ... 500+ concrete mappings                 │
          └───────────────────────────────────────────┘
```

### Layer 4 — Verification Map (`verification-map.ts`)

```
Target file: src/ripple/engine.ts
Callers: [src/tools/file.ts, src/agent/loop.ts, src/gates/pre-round.ts]
                     │
                     ▼
          findTestFiles() × 4 conventions
          ┌──────────────────────────────────────┐
          │ 1. tests/engine.test.ts              │
          │ 2. tests/ripple/engine.test.ts       │
          │ 3. __tests__/engine.test.ts          │
          │ 4. index → parent directory test     │
          └──────────────────────────────────────┘
                     │
                     ▼
          buildSteps()
          ┌──────────────────────────────────────┐
          │ Required:                             │
          │  • bun run typecheck                  │
          │  • bun test tests/ripple.test.ts      │
          │                                       │
          │ Recommended:                          │
          │  • bun test tests/tool_policy.test.ts │
          │                                       │
          │ Coverage: 78% (2/9 symbols uncovered) │
          │ Strictness: strict (async change)     │
          └──────────────────────────────────────┘
```

### Layer 5 — Obligation Gate (`obligations.ts`)

```
  RippleReport
       │
       ▼
  obligationsFromReport()
  → RippleObligation[]
       │
       ├─── resolveObligations(modifiedFiles)
       │    → removes resolved callers
       │
       ├─── mergeObligations(existing, next)
       │    → dedup, new report overwrites stale waiver
       │
       ├─── waiveObligation(obl, reason)
       │    → reason required (empty rejected)
       │
       ▼
  getBlockingObligations()
  → non-waived only
       │
       ├─── Pre-round Gate: blocks write tools
       ├─── Exit Gate: blocks completion
       └─── Completion Gate: ripple check
```

## Integration Points

```
  agent loop
      │
      ├── Pre-round Gate (gates/pre-round.ts)
      │   └── RippleToolFilterGate
      │       → checks pending obligations
      │       → disables write tools when blocking
      │
      ├── Tool Execution (tools/file.ts)
      │   └── write_file / edit_file / multi_edit / edit_fim
      │       → previewEdit() before write
      │       → cascadeAwareDecision() for multi_edit
      │       → block if ripple finds issues
      │
      ├── Completion Gate (gates/completion.ts)
      │   └── RippleExitGate
      │       → getBlockingObligations()
      │       → blocks completion if unresolved
      │
      └── Gate Overflow (loop.ts)
          └── processGateOverflow()
              → ripple blocking count input
```

## Key Design Decisions

| Decision | Rationale |
|----------|-----------|
| Semantic-first caller discovery | TypeChecker resolution eliminates text-grep false positives |
| Async fallback for SEM provider | Never blocks ripple check on `ts.createProgram` build |
| DI pattern for ast-grep tests | `_execFn` injection avoids `mock.module` cross-file leakage |
| Info-severity for strictness gap | Advisory, not blocking — actual blocks come from specific findings |
| Waiver requires reason | Prevents silent obligation dismissal |
| Convention-based test discovery | Zero-config, works across project layouts |

## Known Limitations

| Limitation | Mitigation | Phase 2 |
|------------|-----------|---------|
| Semantic path unavailable on 1st call | Text fallback always works | Phase 2: pre-warm |
| Test discovery is convention-only | Falls back to manual cmd | Phase 2: config file |
| `bun run typecheck` hardcoded | Most Bun projects use this | Phase 2: detect tool |
| Coverage is binary (has test / no test) | Uncovered symbols surfaced explicitly | Phase 2: actual coverage |
| No type-compatibility simulation | Severity heuristics approximate | Phase 2: assignability check |
| Waive has no production caller | Waivers via resolveObligations only | Phase 2: tool pathway |

## Source Map

| File | Layer | Lines | Key Export |
|------|-------|-------|------------|
| `src/ripple/api-diff.ts` | 1 | 282 | `diffApiSurface`, `ApiChange`, `SymbolShape` |
| `src/ripple/program.ts` | infra | 319 | `ProjectProgram` (ts.createProgram wrapper) |
| `src/ripple/semantic-reference-provider.ts` | 2 | 146 | `SemanticReferenceProvider`, `findCallers` |
| `src/ripple/usage-classifier.ts` | 3 | 344 | `classifyCallers`, `resolveAction`, `UsageImpact` |
| `src/ripple/obligations.ts` | 4 | 108 | `obligationsFromReport`, `waiveObligation` |
| `src/ripple/verification-map.ts` | 5 | 423 | `buildVerificationMap`, `verificationStrictness` |
| `src/ripple/astgrep-provider.ts` | 6 | 271 | `AstGrepProvider`, `discoverCallers` |
| `src/ripple/engine.ts` | core | 934 | `previewEdit`, `formatRippleBlock`, `decide` |
| `src/ripple/types.ts` | types | 85 | `RippleReport`, `RippleCaller`, `RippleFinding` |

## Test Map

| File | Tests | Covers |
|------|-------|--------|
| `tests/api-diff.test.ts` | 27 | 8 change kinds, severity, multi-change |
| `tests/semantic-reference-provider.test.ts` | 16 | lifecycle, singleton, dedup, contracts |
| `tests/usage-classifier.test.ts` | 49 | 14 usage kinds, action resolution, edge cases |
| `tests/ripple_obligations.test.ts` | 32 | waive, blocking, merge, resolve, lifecycle |
| `tests/verification-map.test.ts` | 47 | discovery, coverage, steps, formatting, strictness |
| `tests/astgrep-provider.test.ts` | 24 | availability, patterns, dedup, DI, degradation |
| `tests/ripple.test.ts` | 17 | integration — cascade, multi_edit, rollback, gates |

**Total: 212 tests across 7 files. 0 failures.**
