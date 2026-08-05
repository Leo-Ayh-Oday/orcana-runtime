# Changelog

All notable changes to Orcana Runtime.

## [0.8.8] — 2026-08-05

### Added (LNXF-1 — Linux 契约、能力探测与 Shadow 模式)
- **Linux execution foundation contracts** — `LinuxCapabilities` (cgroup v2 + controllers + delegation, 8 namespaces, bubblewrap/podman/Landlock/seccomp/tmpfs/systemd probes with explicit degradation reasons), `ExecutionCellSpec` (immutable/serializable/hashable/replayable; `inheritHost: false` enforced; policyDigest binding), `SandboxReceipt` (identity + 5 policy digests + outcomes + metrics + observed writes + cleanup), MountRule/TmpfsRule/SecretBinding/CacheMountRequest/DomainResourceBudget/ResourceRequest/PortLease/BackendAvailability.
- **Capability probe** — real system probing (cgroup v2 via mountinfo + controllers + delegation detection; namespaces via /proc/self/ns; bwrap/podman binaries + unprivileged usability; Landlock ABI derivation; seccomp mode; tmpfs/overlayfs; systemd). Stable `capabilitiesDigest` (bootId excluded). No numeric scoring — every degradation carries an explicit reason.
- **Policy compiler skeleton** — mount-rule validation (path normalization, realpath escape checks, credential-path + host-socket forbidden lists, duplicate-target and parent/child mount conflict detection), full spec validation, `compileCellSpec` with policyDigest. The compiler is the only formal spec entry point.
- **Backend router** — fail-closed selection: strict profiles (untrusted/evolution/test/dependency/service) refuse when their backend is unavailable (`DEGRADATION_NOT_ALLOWED` / `ISOLATION_REQUIREMENT_UNMET`); Host Audit is only reachable with `minimum=audit` + explicit degradation.
- **7 sandbox profiles** — inspect/build/test/dependency/service/untrusted/evolution with default backends, isolation minimums, network modes, resource ranges and strictness.
- **Broker skeleton + shadow mode** — `LinuxExecutionBroker` interface (probe/compileSpec/selectBackendFor/shadow/execute/createAgentDomain/cancel*/cleanupRun); shadow records the would-be spec + backend selection while execution stays on the legacy path (BEHAVIOR_CHANGE: 0).
- **`orcana doctor` linux-foundation check** — capability summary, digest and degradation reasons.
- 24 tests; full gate 938 pass, bench no regression.



### Added (MACP-M7 — 角色与输出契约)
- **Three role output contracts** — Planner (`planText` + proposed assignments/dependencies/approvals), Coder (`changes` + declared `deviations` + `evidenceIds`), Reviewer (`verdict` approved/rejected/needs_repair + comments). Every model output is validated against its role schema BEFORE any downstream use; invalid output becomes a structured `invalid_role_output` failure (never a silent pass-through, never triggers writes).
- **Bound envelopes** — valid outputs wrap in `RoleOutputEnvelope` bound to runId / nodeRunId / planVersion / workspaceDigest and persist to the ArtifactStore (`plan` / `delivery_report` / `ripple_report` kinds) via the awaitable `persistRoleOutput`.
- **Authority baseline** (no new execution machinery — the M3 writable/ownership enforcement already carries the write side) — Planner and Reviewer cannot write or merge; Coder cannot approve its own output; silent deviation is rejected (`deviations` must be declared).
- **Separation** — a Coder can never be its own only Reviewer (SELF_APPROVAL: 0).
- **Reviewer read surface** — the reviewer context is filtered to plan / final diff / relevant sources / evidence; hidden reasoning (thinking, scratchpad, internal notes) is excluded (tasks 7/8).
- 13 tests: per-role pass/reject paths, structured failures, silent-deviation rejection, artifact persistence, role derivation, self-approval rejection, authority violations, hidden-reasoning filtering.



### Added (MACP-M6 — 类型化计划契约)
- **CompletionCriterion** — completion conditions are now typed: stable ID, hard/soft weight, deterministic/semantic mode, and one of five structured checks (command / file_exists / file_content / evidence / semantic_review). Natural-language conditions MUST be declared `semantic_review` — they can never be smuggled into grep-style checks (FAKE_DETERMINISTIC_CHECK: 0), and `semantic_review` never auto-passes (human adjudication is the only resolution).
- **TypedPlanContract** — planner output is machine-checkable: `version` (bound to criterion IDs; any modification must produce a new version), `criteria`, typed `tasks` (scope + criterionIds + writes). A JSON Schema gate (shared validator keyword subset) rejects structurally invalid plans (PLAN_CONTRACT_SCHEMA: PASS).
- **Enforcement rules** — duplicate or malformed criterion IDs rejected; write tasks MUST bind at least one deterministic command/evidence verification criterion and one hard criterion (HARD_CRITERION_BYPASS: 0); key permission/security conditions (ownership + path escape) are automatically injected as a hard criterion (`sys.ownership_and_no_escape`) unless the task already binds ownership evidence.
- **Criterion evaluator** — deterministic checks evaluate mechanically against a context (command runner, file system, evidence ledger); `compileCriterionVerifications` compiles deterministic criteria into verification nodes (task 10).
- **Compatibility** — legacy TaskPacket `doneCriteria` stays displayable; typed criteria are an optional extension.
- 17 tests covering all rejection paths, evaluation semantics and compile behavior.



### Added (MACP-M5 — 冲突安全合并，替换 later-wins)
- **later-wins removed from the production path** — `reduce.merge_agents` never overwrites fields: identical values deduplicate, differing values for the same key become `valueConflicts` (structural, never silent).
- **Per-agent result bundles** (`AgentResultBundle`) — outputs stay isolated under their agent id (no field overwriting); patches / evidence / files indexed per file.
- **Conflict policy** (`buildConflictSet`) — same-file identical patches deduplicate (not a conflict); different patches produce a `FileConflict` (never auto-overwritten) plus a derived symbol-level conflict; contract-level collisions are declared via `outputs.contracts`. All sets are order-independent (sorted agents/writers).
- **Integration plan** — disjoint writes and deduped files enter `automatic`; everything else blocks.
- **Transactional integration** (`integrateWithVerification`) — automatic files merge through a single-writer `FileTransaction`; post-merge whole-workspace verification is MANDATORY (per-agent pre-merge verification never substitutes); any failure or interruption rolls the official workspace back to its exact pre-merge state (no half-written files). Unresolved conflicts return `blocked_conflict` and never touch the official workspace; agent worktrees are preserved until adjudication ends.
- **Scheduler status** — a merge node reporting `conflicts` or `valueConflicts` sets the run status to `blocked_conflict`.
- 14 new tests + G7 merge tests updated to the conflict-safe semantics.



### Added (MACP-M4 — 持久化中断、人工等待与恢复)
- **Persistent interrupts** — a workflow run can pause at a human node instead of blocking the process: the interrupt record is persisted to `.orcana/workflow/interrupts/<id>.json`, the run returns `waiting_interrupt` with a resume token, and the process is released (PROCESS_BOUND_WAITING: 0). Downstream subgraphs do not run while waiting; in-flight nodes drain, then the run exits.
- **Resume flow** — a validated reply is checked against the token (base64url binding spec digest + expiry + interrupt id), the stored record (status `waiting`, not expired), the current graph version (`computeSpecDigest` — any spec change invalidates outstanding tokens), the recorded response schema, and workspace freshness (a changed workspace since the interrupt requires re-verification and rejects the resume). Resuming injects the answer at the interrupted node; completed nodes are restored from the checkpoint and never re-execute.
- **One-time tokens** — resolving the record (or cancelling) makes the token permanently invalid (DOUBLE_RESUME: 0).
- **Failure transparency** — the interrupt never produces a `failed` node result: `WorkflowInterruptError` propagates to the scheduler which emits the waiting outcome; the H11 HumanNode is not even started while paused.
- 11 tests: pause + persisted record, restart reads waiting state, subgraph stop, valid resume completes, wrong schema rejected, expired token rejected, graph-version change rejected, token reuse rejected, workspace change rejected, checkpoint no-re-execute, spec digest stability.



### Added (MACP-M3 — 真实工作区隔离与所有权强制)
- **Ownership as enforcement, not declaration** — `ownerFiles` / `worktree` / `canWrite` on `AgentPool` now constrain every write node: the declared path is authorized before launch (normalized + owned) and the actual written paths reported by the tool are re-verified afterwards (`metadata.paths` is mandatory for assigned write nodes — missing it fails the node).
- **Escape defenses** — `../` traversal, absolute-path bypass, symlink escape (realpath of the nearest existing ancestor) and case variance (normalized lower-case keys) are all rejected; ownership matches on the project-relative path so worktree copies validate identically.
- **Worktree isolation** — assigned write nodes execute with the agent worktree as their resolution root (shared ledger/artifacts/cancellation); two agents write into their own worktrees and the main workspace stays untouched until merge (merge itself is MACP-M5). Worktree creation failure fails the write node — no silent degradation to the shared workspace; read-only nodes keep the shared workspace.
- **Lifecycle** — worktrees are reused per agent within a run and disposed when the run finishes; `detectLegacyWorktrees()` identifies leftovers from crashed runs.
- **Participant capability** — `AgentSpec.writable: false` marks planners/reviewers that must never write the project workspace.
- **Explicit policy allowances** — `harness.policy.allowCapabilities` grants node-mode tool execution (still strict: no interactive confirm channel); the strict scope-derived gate stays the default.
- **Zero regression** — no pool / unassigned nodes behave exactly as before (SINGLE_AGENT_REGRESSION: 0).
- 12 tests: owned write passes, another agent's file rejected, declared≠actual rejected, `../`/symlink/absolute escapes rejected, planner write denied, dual-worktree isolation with untouched main workspace, dispose at run end, legacy detection, no-pool regression.



### Added (MACP-M2 — Workflow-Harness 正式适配)
- **H11 unified node runtime for workflows** — workflow nodes may declare an H11 execution kind; model nodes run through `LlmAgentNode`, tool nodes through `ToolNode` (CapabilityExecutor), verification nodes through `VerificationNode` (H8 artifact/evidence adapter), human nodes through `HumanNode` (interrupt bridge).
- **Single source of truth** (plan §23) — the workflow never constructs its own budget or model path: run scope (evidence ledger, artifact store, trace, cancellation), run-level budget ledger and capability registry all come from the harness environment (`SchedulerOptions.harness`).
- **Preserved chain** — `NodeResult` evidence / diagnostics / usage are carried verbatim on the workflow node result, plus a structured `errorKind` (capability_not_found, policy_blocked, cancelled, budget exhaustion …) so downstream policy can branch without string matching.
- **Fail-closed wiring** — a node declaring H11 execution with no harness environment, or an `llm_agent` node with no loop deps, fails instead of falling back to a handler bypass (DIRECT_LLM_BYPASS / DIRECT_TOOL_BYPASS = 0). The handler registry remains a read-only deterministic reducer surface.
- **Governance parity** — write-class tool capabilities respect readonly mode and the single-writer lock exactly like write handlers; harness nodes are never cache-replayed.
- **Cancellation propagation** — the run scope's abort signal reaches running nodes (tool abort signal, human `throwIfCancelled`, agent loop signal).
- 14 tests: LlmAgentNode text/usage propagation, ToolNode capability execution + structured `capability_not_found`, VerificationNode evidence ingestion, HumanNode interrupt + invalid response diagnostic, cancellation, budget exhaustion structure, fail-closed paths, readonly write protection, M1 conditional-dependency composition.



### Added (MACP-M1 — conditional dependencies & result propagation)
- **`WorkflowDependency { nodeId, when }`** — dependencies may now declare `terminal | succeeded | failed | accepted | rejected | blocked` conditions; `schemaVersion: "0.2"` enables them, while `"0.1"` specs keep the legacy terminal semantics (a failed upstream still lets downstream run — exactly as before).
- **Execution / acceptance separation** — a node may execute successfully while its output is not accepted; acceptance is declared via `output.metadata.acceptance` (this layer only interprets it; who may declare it is a coordination-authority concern, MACP M7/M9).
- **Fail-closed readiness** — the scheduler evaluates every dependency condition before launching: a finished-but-unsatisfied dependency puts the dependent into a terminal `blocked` state (no deadlock, no failed-upstream leak into downstream work). `blocked`-condition branches (escalation paths) are supported.
- **Checkpoint consistency** — restored runs recompute dependency conditions from restored results and reach identical verdicts without re-executing.
- **P0 fixed**: "Planner 失败后 Coder 仍然执行" is impossible in 0.2 specs (planner→coder must be `accepted` or `succeeded`).
- 16 tests: policy units, planner→coder chains (accepted / not-accepted / rejected), failed→repair branches, blocked escalation, all-blocked no-deadlock, legacy compatibility, checkpoint restore consistency.



### Added (Typed Execution Graph, G7 — T3R Multi-Agent, Graph Runtime finale)
- **Agent Pool** (`src/workflow/agents/agent-pool.ts`) — register agents with disjoint file ownership (overlaps rejected with a structured violation report), owner lookup, `canWrite` checks, and cancellation; cancelled agents fail fast.
- **Per-agent budget** (`agent-budget.ts`) — node/write caps; exceeding a cap blocks only that agent's subgraph (`budget_exhausted`), other agents keep running.
- **Worktree isolation** (`worktree.ts`) — `git worktree add --detach` for git repos, directory snapshot fallback for non-git projects; `dispose` cleans up.
- **Conflict detection** (`conflict-detect.ts`) — same-file cross-agent writes produce an evidence-backed conflict report (fingerprints); failed writes never count.
- **Merge node** (`merge.ts`) — `reduce.merge_agents` deterministic merge (later-wins) with structural conflict reporting.
- **Scheduler wiring** — optional `pool` in `SchedulerOptions`: cancelled agents fail fast, budgets are charged per node; the G3 single-writer lock and evidence gate are untouched. No pool = unchanged single-agent semantics.
- **Prerequisites verified** (PR-G7 gate): G0–G6 stable, PatchTransaction Phase 2 (temp→swap atomic + TOCTOU + partial rollback), Replay/Checkpoint stable; the "single-agent bottleneck" data premise is proxied by the deterministic evidence (H12 blocked/failed cases, G4 convergence rounds) until live-eval credit returns.
- 17 new tests: pool/ownership/cancellation, budget verdicts, worktree isolation + dispose, conflict reports, merge semantics, two-agent scheduler runs, cancellation and budget isolation between agents.



### Added (Strong Single v1.0, PR-10.1 — RunTrace event taxonomy)
- **Standardized event classification** (`src/telemetry/taxonomy.ts`) — the free-form `RunTraceEvent.type` strings now map onto a finite 9-category set: `lifecycle / model / tool / gate / verification / evidence / workflow / error / internal`.
- **Specialized-first prefix rules** — `verification_started` is verification (not lifecycle), `mode_transition` is gate, `model_selected` is model; unknown types land in `internal` for discoverability.
- **Canonical event table** — every category documents its runtime-produced event types; a category summary (`summarizeTrace`) counts per-category and lists unknown types for future taxonomy rules.
- 6 tests covering per-category classification, unknown-type discovery, summaries and canonical-table consistency.



### Docs (Strong Single v1.0, PR-10.2 / PR-10.3)
- **ARCHITECTURE.md** — module status table realigned to the v1.0 closure facts: PatchTransaction, EvidenceLedger, Completion Orchestrator, MasterPlan/TaskPacket, ModeContract and Secret Redaction moved to 🟢 stable (with the SS-Next-2B rollback and command-to-file details); new rows for AgentHarness 2.0, Typed Execution Graph (G0–G6), replay/mini-benchmark, `orcana doctor` and FreshnessGate.
- **SECURITY.md** — supported-version table refreshed; key management now documents `~/.orcana/auth.json` (0600) and the `ORCANA_*`/legacy `DEEPSEEK_*` env mirror; MCP default-untrusted trust policy; the redaction boundary (shared across trace/snapshots/cache/checkpoints with the token-metering whitelist); a new evidence-chain section (L1/L2/L3, rollback-aware invalidation, command-to-file coverage) and the FreshnessGate write-preflight boundary; completion-gate bypass added to the report list.



### Added (Strong Single v1.0, PR-10.4 — `orcana doctor`)
- **Full environment self-check** (`src/diagnostics/doctor.ts`) — `orcana doctor` now emits a complete diagnostic report with eight checks:
  - **version** — runtime-resolved package version;
  - **runtime** — Node ≥ 20, Bun presence, session-store capability;
  - **config** — global config existence + JSONC parse integrity;
  - **model / auth** — provider/model resolution and credential source (auth.json / env / local / missing);
  - **provider reachability** — concurrent probes (any HTTP response proves the endpoint is alive; local Ollama/LM Studio ports included; never a billed model request);
  - **sandbox** — OS capability matrix with rating (cgroups/PathGuard/network isolation/…);
  - **MCP** — server config validation + enabled state;
  - **paths** — config/session/workflow directory readiness.
- **Output** — human-readable by default, `--json` for structured `DoctorReport`; warn/fail counts printed; fail count > 0 maps to exit code 1 (CI-friendly).
- 5 structural tests (check completeness, shape, counts, version echo).



### Fixed (Strong Single v1.0 — command-to-file coverage)
- **Unmanaged-write deadlock closed**: shell/`run_process` writes used to poison the transaction binding (`currentTransactionEvidenceBinding → undefined`) and force the completion gate to require a binding forever — any run that legitimately used a command after editing could never complete.
- **Exact paths** — `recordRuntimeObservedWrites` now records the precise file set from the sandbox diff (`getUnmanagedWritePaths`), not just a flag.
- **Command-to-file coverage** — a PASSING `run_targeted_verification` records the files it verified (`recordVerificationCoverage`); it runs against the current disk state, so covered unmanaged writes are authoritative.
- **Gate relaxation is provably safe** — `shouldRequireEvidenceBinding` relaxes the binding requirement only when EVERY unmanaged write path is covered; partial coverage and any new unmanaged write after coverage keep the requirement, and L1 (latest-result) / L2 (write-generation) freshness always stay hard. Managed-only runs still require the binding.
- 7 regression tests covering path recording, partial/full coverage, coverage reset, gate pass without binding, L2 hardness under coverage, and managed-binding integrity.



### Added (Strong Single v1.0, PR-8.3 — SWE-style Mini Benchmark)
- **`evals/mini-benchmark.ts`** — deterministic, offline, no-LLM benchmark: runs the H12 scripted scenario suite (12 cases, hr-core + hr-dual) through the real AgentHarness and aggregates three indicators:
  - **pass@1** — share of scenarios whose single run passes assertions with the expected outcome (currently 100%);
  - **false done rate** — share of runs that COMPLETED against a non-completed expectation (currently 0%);
  - **cost** — estimated USD from the scripted token-usage events (currently ≈ $0.002 per full suite).
- **Regression gate** — a baseline is persisted at `~/.orcana/evals/mini-benchmark-baseline.json`; later runs compare and exit 1 when pass@1 drops >0.05, false done rate rises >0.05, or cost rises >10% ("每次 PR 不退化").
- **`bun run bench:mini`** — `[--filter <id>] [--report] [--update-baseline]`.
- 6 unit tests covering aggregation and every regression direction.



### Fixed (Strong Single v1.0, SS-Next-2B — rollback-aware evidence invalidation)
- **The rollback hole is closed**: `rollback_transaction` used to revert files without invalidating evidence, so verification of the pre-rollback (committed) code state stayed "fresh" and could satisfy the completion gate for code that no longer existed.
- **L2** — a managed rollback now advances the runtime write-generation (`recordRuntimeRollback`), so evidence collected before the rollback fails the freshness check.
- **L3** — the rollback advances the committed-transaction evidence state (`recordRollbackInEvidenceState`, stateId chain in a distinct `rb` namespace that can never collide with a commit), so pre-rollback transaction bindings no longer match.
- **No deadlock** — unlike an unmanaged write, a rollback does not poison the binding: after rolling back, a fresh re-verification produces new, authoritative, passable evidence again.
- Wired into the `rollback_transaction` tool and both commit-failure auto-revert paths in `patch-transaction` (full and committed-paths variants).
- Regression tests in `src/agent/rollback-evidence.test.ts`: L3 mismatch, post-rollback re-verification passes, completion gate rejects pre-rollback evidence end-to-end, files actually revert.



### Added (Typed Execution Graph, G6 — Dynamic Workflow Compiler)
- **Dynamic graphs** (`src/workflow/dynamic/`) — a model may now author a controlled graph as JSON and have it compiled into a `WorkflowSpec`, exactly the shape static templates produce: dynamic graphs and static templates share the scheduler and the G3 single-writer/verification semantics.
- **No arbitrary code** — `parseDynamicSpec` is a pure JSON parse (no eval); `schemaVersion`, `mode`, `maxParallel` and the node shape are whitelisted.
- **Registered types only** — nodes may only use the registered node types (read / write / verify / reduce) with handlers from the matching family (`type_mismatch` otherwise).
- **Registered handlers only** — the G2 five-validator contract (Schema / DAG / Capability / Budget / Side-effect) is reused as-is; unknown handlers and write-in-readonly are rejected.
- **Write safety** — write budget (`maxWrites`), write cycles rejected by the DAG validator, and verification completeness: a write node without a verify successor is rejected by default (or auto-appended via `autoAppendVerification`).
- **PermissionGate** — read-only graphs are approved automatically; any graph with write nodes goes `needs_approval` until `approve()`; parse/validation failures are `rejected` and never produce a spec, so the model cannot bypass the gate.
- Off by default — the dynamic compiler is an explicit API only; no configuration changes.



### Added (Typed Execution Graph, G5 — Context Slice / Cache / Replay)
- **Result cache** (`results/result-cache.ts`) — read-node results keyed by `stableHash({ handler, input })` (the G0 stableHash primitive is now consumed by the cache). Same input ⇒ cache hit ⇒ replay, never re-execute.
- **File-change invalidation** — a completed write node invalidates the cache (superset invalidation): after any write, read results are recomputed, so modified files always produce fresh reads.
- **Checkpoint resume wired into the scheduler** — G1's `ResultStore.restore` is finally connected: a crashed run resumes finished nodes without re-executing them, and their results refill the cache for later runs.
- **Replay markers** — replayed nodes carry `metadata.replayed = true` and `durationMs 0`; tool execution is skipped entirely on a hit.
- **Context slice** (`context/context-slice.ts`) — a node's execution context is explicitly its own input plus its direct dependencies' outputs; unrelated history and siblings never enter.
- **Cache persistence** (`persistence/result-cache-store.ts`) — best-effort disk round-trip under the same `redactForTrace` boundary as checkpoints.
- All of it is opt-in via `SchedulerOptions.cache` — old behavior is unchanged (old-run compatibility).



### Added (Typed Execution Graph, G4 — Convergent Repair Graph)
- **RepairLoop** (`src/workflow/convergence/repair-loop.ts`) — provably convergent fix loop on top of the G3 single-writer transaction graph: each round fingerprints failures and converges.
- **Failure signatures** (`failure-signature.ts`) — finite error-category whitelist; rewording never bypasses dedupe (`handler nodeId | category`).
- **Convergence semantics** — seen/confirmed separation; the same signature never re-executes the same failed fix; two consecutive dry rounds exit `dry`; metric gain (passing evidence up, failing writes down) keeps the loop going; `maxAttempts` hard cap; budget exhaustion emits a structured blocked report (`budget_exhausted` with blocked node list, seen signatures, attempt counts).

### Fixed
- **Scheduler completion gate (G3 semantic gap)** — a failed write node now never completes the run, even when a verification node reported `passed`; status is `blocked_no_evidence` so the repair loop can converge instead of declaring done.



### Added (Typed Execution Graph, G3 — Graph Runtime first usable release)
- **Single-writer transaction graph** — read-write `WorkflowSpec`s execute the whitelisted write handlers (`tool.apply_patch` via the patch transaction tool, `tool.run_process`, `tool.run_targeted_verification`) under a single-writer lock: write nodes serialize globally (FIFO) while read nodes keep the parallel budget.
- **Write protection stays layered** — read-only specs reject write handlers at runtime; the write whitelist is enforced at registration, validation and execution.
- **Transaction semantics** — apply_patch nodes reuse the existing transaction chain (dry-run validation of every patch → atomic commit → automatic rollback on conflict, file left untouched).
- **Evidence gate** — verification nodes bind to the write nodes they verify (`aggregate-evidence`); a run whose write nodes lack passing verification completes as `blocked_no_evidence` instead of done.
- **Write templates** — `narrow_fix` (locate → read → patch → verify) and `test_repair` (run tests → read → patch → verify), structure-enforced write→verify edges, stable spec ids.



### Version strategy
- **0.6.0** consolidates every feature line before the Typed Execution Graph: Tool Runtime 2.0 (RT-7..13, previously unpublished as npm versions) + TUI convergence work (user track). The Graph Runtime series starts at **0.7.0** (G3 = Single Writer Transaction Graph) and continues on 0.7.x.

### Added (Tool Runtime 2.0, RT-7..13)
- **Parameterized process execution** — `run_process` / `run_shell_script` (RT-7): `shell:false` default, args arrays, process groups, timeout kill-tree, stdout/stderr artifacts.
- **Structured git** — `git_status` / `git_diff` porcelain=v2 + numstat parsing, write-tool risk separation (RT-8).
- **Repo map** — `build_repo_map` / `query_repo_map` / `build_context_slice` with authority/confidence metadata (RT-9).
- **Verification toolchain** — `discover_verification` / `run_targeted_verification` / `classify_command_failure` / `verify_claim` (RT-10).
- **Web/Service/MCP hardening** (RT-11) — SSRF DNS/IP re-validation per redirect hop, streaming byte budgets + decompression-bomb protection, summarize-mode-separated web cache keys, prompt-injection flagging; service lease (`service_start`/`status`/`logs`/`stop`) with run-end auto-cleanup; MCP trust policy (unknown tools default to non-readonly high-risk + first-run approval).
- **Capability router** (RT-12) — layered dynamic tool disclosure with token estimation and fallback sets.
- **Production tool eval** (RT-13) — TL-001..020 scenarios; executor trace-pair fix.

### Added (TUI — user track)
- Visual convergence (7-token palette + golden matrix), block model (collapsible tool groups), action registry (single key/hint source), container language + branded empty state, Depthline canvas layout, slash-command guard.

### Fixed
- Trace token metering redaction (G0 fix, included in 0.5.23+).



### Added (Typed Execution Graph, G2)
- **Workflow compiler** — `compileMasterPlan()`: MasterPlan nodes (+ attached TaskPackets) compile into validated `WorkflowSpec`s with stable ids (specId = hash of goal + node identities), normalized topological order and deduplicated edges; kernel/`master-plan.ts` untouched. Handler inference for packet-less nodes covers zh + en titles with plan-intent fallback.
- **Validation suite** — `validateSpec()` aggregates five checkers: DAG (unknown dependencies, cycles, empty specs), capability (unknown / write handlers), side-effect (write nodes in read-only mode), budget (200-node cap, maxParallel ≥ 1) and input schema (shallow typing).
- **Read-only templates** — `code_explain` (find_symbol → find_references → read_file), `security_audit` (project_structure → read_file fan-out → merge_diagnostics), `research_report` (git_status → git_diff → symbol/file reads); all validated read-only at compile time, stable output for equal inputs.
- **Plan projection** — `projectResultsToPlan()` writes run results back onto MasterPlan status (done / blocked + evidence head summary).



### Added (Typed Execution Graph, G1)
- **Read-only DAG scheduler** — `src/workflow/`: bounded-concurrency parallel execution over a validated `WorkflowSpec`; ready queue (indegree 0), failure isolation (a failed node's siblings and dependents keep running), deadlock guard (cycles rejected up front, self-loops included).
- **Write protection (two layers)** — handler registry rejects any non-`isReadonly` tool at registration; the tool executor re-verifies `isReadonly` before every call (fail-closed). Whitelist: `read_file` / `find_symbol` / `find_references` / `project_structure` / `git_diff` / `git_status` + `reduce.dedupe` / `reduce.merge_diagnostics` / `reduce.noop`.
- **Graph checkpoint** — `ResultStore` writes every finished node incrementally (`.orcana/workflow/checkpoints/`, redacted); restored runs never re-execute finished nodes.
- **Snapshot compiler bridge** — G0 snapshots compile to executable read-only specs; write tools in a snapshot are rejected at compile time.
- **Config** — `workflow.mode` gains `"readonly"` (shadow record + real read-only parallel execution); `workflow.maxParallel` (default 4). G1 is standalone: not wired into `agentLoop` until G3.



### Added (Typed Execution Graph, G0)
- **Shadow graph projection** — `src/workflow/`: `WorkflowProjector` maps the existing run-trace event stream (rounds / tool calls / gate decisions / verifications / terminal events) into a typed execution graph snapshot (nodes, containment edges, metrics), written to `.orcana/workflow/<runId>.graph.json` on run completion.
- **Zero-overhead wiring** — `workflow.mode` config (`off` default / `shadow`); `runtime.startRunTrace` wraps the run trace via `ProjectingRunTrace` (CLI + TUI paths), kernel/loop untouched; `off` returns the trace unchanged.
- **Safe by design** — tool inputs projected as parameter-key summaries only; snapshots pass through the trace redactor; projection never throws.
- **G1 foundations** — `stableHash` / `stableSerialize` (recursive key-sorted deterministic hashing) for the future read-only result cache.

### Fixed
- **Trace token metering** — `redactForTrace` exempts token/cost counter fields (`inputTokens` etc.); the `/token/i` secret-key pattern was redacting every cost metric to `[redacted]`, zeroing all §12 live-eval observability.

## [0.5.22] — 2026-08-05

### Added (Tool Runtime 2.0, RT-13)
- **Tool Production Eval** — TL-001..020 scenarios (`tests/capabilities/tool_production_eval.test.ts`) exercising real tool handlers, the executor 8-step chain, policy gates, the router, and the service registry: run sandbox isolation, orphan-free cancellation, patch path-escape / stale-baseHash / atomic rollback, verification-gated commits, artifact-kept truncation, git/process injection safety, SSRF redirect re-validation, web cache mode separation, MCP unknown-tool posture, run-end service cleanup, freshness stale rejection, router schema economy, paired trace events, writable-root coverage, oversized-output artifacts.
- **Trace-pair fix** — the node-mode executor now emits `tool.call.completed` on successful handler runs (started/completed were unpaired, TL-018).

## [0.5.21] — 2026-08-05

### Added (Tool Runtime 2.0, RT-12)
- **Capability Router** — layered dynamic tool disclosure: always-on stable core (`read_file` / `run_process` / `apply_patch` / `git_status` / `verify_claim` — `read_file` with selectors covers the plan's not-yet-created `inspect_file`) + task-selected specialist groups (code intelligence / verification / git ops / web research / service ops); interaction-critical meta tools always present.
- **Schema economy** — per-profile token estimates; small context budgets collapse disclosure to the stable core; excluded tools are listed as fallback for on-demand disclosure (TL-017: simple tasks never load web/MCP/LSP schemas).
- **Bootstrap wiring** — `toolDisclosure.profile` option trims the runtime tool list; default keeps full disclosure (no behavior change).

## [0.5.20] — 2026-08-05

### Security (Tool Runtime 2.0, RT-11)
- **`web_fetch` SSRF hardening** — every hop (initial + each redirect) is re-validated: hostname blocklist → DNS resolution → per-IP private/link-local/cloud-metadata rejection (IPv4 RFC1918/CGNAT/link-local/documentation/multicast, IPv6 loopback/ULA/link-local/mapped/documentation/multicast), fail-closed. Requests connect to the validated IP with explicit Host header/TLS servername — no TOCTOU between check and connection.
- **Streaming byte budget** — bodies stream and decompress on the fly (zip-bomb guard, `content-encoding` gzip/deflate/br), cut at 500KB; binary content-types rejected; per-hop timeout.
- **Cache-key mode split** — cache key now includes `summarize` and engine, so a summary and its raw content can never share an entry.
- **Prompt-injection flagging** — fetched content is scanned for injection phrasing (`ignore-previous-instructions`, `role-reassignment`, `system-prompt-override`, …) and flagged in `metadata.promptInjectionDetected`.
- **Service supervisor split** — `start_service` → `service_start` / `service_status` / `service_logs` / `service_stop` with run-bound `ServiceLease` (runId + `cleanupPolicy`); `cleanupPolicy=run-end` services are stopped automatically when the harness run is removed (no background leaks); logs stream to `~/.orcana/services/<id>.log`. Legacy `start_service` kept as a compatibility forwarder.
- **MCP trust policy** — per-server `trust: untrusted|restricted|trusted` + `allowedToolPatterns` / `deniedToolPatterns` / `defaultRiskLevel` / `allowOpenWorld` in `~/.orcana/mcp.json`. Unknown tools default to non-readonly high risk with first-execution confirmation; MCP annotations are hints only and can never lower risk; shared bridge client (shutdown now actually stops servers) + per-call timeouts.

## [0.5.19] — 2026-08-05

### Added (Tool Runtime 2.0, RT-10)
- **Verification toolchain** — `discover_verification` (package.json scripts/workspace/CI discovery), `run_targeted_verification` (minimal verification set from modified files), `classify_command_failure` (ANSI-aware root-cause classification), `verify_claim` (evidence-bound claim checking against artifact/evidence/workspace-hash state).

## [0.5.18] — 2026-08-05

### Added (Tool Runtime 2.0, RT-9)
- **Repo map** — `build_repo_map` / `query_repo_map` / `build_context_slice` (compiler-AST code intelligence with authority/confidence annotation).

## [0.5.17] — 2026-08-05

### Added (Tool Runtime 2.0, RT-8)
- **Git 2.0** — `git status --porcelain=v2 -z` structured parsing, `git diff --numstat` + patch artifacts, risk-separated write tools (`git_add`/`git_commit` require confirmation, detached from read-only surface).

## [0.5.16] — 2026-08-05

### Added (Tool Runtime 2.0, RT-7)
- **`run_process`** — parameterized executable execution (`shell:false`, args as arrays, never command strings): process-group tree-kill on timeout/cancel (no orphans), AbortSignal support, structured `exitCode`/`signal`/`durationMs` results, env merge.
- **`run_shell_script`** — explicit shell type (bash/sh/zsh/cmd/powershell) invoked via shell executable + args (never `shell:true`), with an auto-generated declarative side-effect plan (write/network/privilege).
- **`start_service` de-shelled** — detached spawn now parameterized (`shell:false`); `Result.failWithMetadata` added for structured failures.

## [0.5.15] — 2026-08-05

### Added (Tool Runtime 2.0, RT-6)
- **`apply_patch`** — standard unified-diff application with base-hash freshness, path-escape rejection (writable-root boundary, `../` and absolute escapes blocked before any write), dry-run previews, structured per-file stats, new-file patches, atomic writes (temp → rename).
- **`apply_patch_transaction`** — multi-file all-or-nothing: every patch validates in memory first (nothing touches disk on failure), then commits; `idempotencyKey` replays report already-applied (crash-safe).
- **`edit_symbol`** — TypeScript-AST-anchored symbol editing (function/method/class/interface/type alias), `dryRun` previews text + span with `authority: "compiler"`.
- **`read_file` selectors** — `selector: {kind: lines|symbol|byte_range}` windows + `expectedHash` freshness (mismatch → `STALE_FILE`).

## [0.5.14] — 2026-08-05

### Added (Tool Runtime 2.0, RT-5)
- **Policy chain modularized** — the 8-gate `evaluateToolPolicy` now composes standalone modules under `src/harness/capabilities/policy/`: `writable-root-policy` (path boundary), `network-policy` (network tool set + web-search gate), `risk-policy` (Risk 4-5 per-invocation confirmation + `isSessionAllowableRisk`), `approval-policy` (ask→allow promotion rules, gate order preserved), `concurrency-policy` (declared per-group caps; writes/external serialize). One shared boundary for shell/file/patch/git writers — no "shell blocked but patch can write" paths.
- **Writable-root gate** — node mode passes the run scope's `projectRoot`; write calls whose paths escape it are blocked with `writable_root` before any handler runs (loop mode omits roots → gate skipped, unchanged).

## [0.5.13] — 2026-08-05

### Added (Tool Runtime 2.0, RT-4)
- **Output limiting** — `limitOutput` stores oversized results verbatim in the run's artifact store and returns a preview + artifact ref (`CapabilityDescriptor.maxOutputBytes`, default 8000 = legacy shell cap); the node-mode executor truncates handler output into `… [output truncated: full content in artifact <id>]` without ever returning raw megabytes.
- **First-batch output schemas** — structured target schemas declared for `typecheck` / `git_status` / `git_diff` / `lsp_diagnostics` / `web_search` (`FIRST_BATCH_OUTPUT_SCHEMAS`) as the migration contract for RT-8/9/10.

## [0.5.12] — 2026-08-05

### Added (Tool Runtime 2.0, RT-3)
- **Kernel project root is explicit** — `AgentOptions.projectRoot` (harness always passes the run scope root); kernel context, permission config loading, sandbox init, context map and coordinator path checks resolve against it instead of a hidden `process.cwd()` (`kernel/context.ts`, `prepare.ts`, `verification/coordinator.ts`).
- **ToolExecutionContext threaded into node-mode handlers** — `CapabilityExecuteInput.context`; `ToolNode` builds it from the run scope (strict approval, run cancellation signal) and the executor hands it to handlers via `metadata.runContext`; `contextFromRunScope` / `buildExecutionContext` with `readableRoots`/`writableRoots`/`ApprovalContext`/`Clock`.
- **Parallel run isolation tests** — two run scopes executing concurrently keep artifact stores disjoint; cancelling one run's signal never aborts the other.

## [0.5.11] — 2026-08-05

### Added (Tool Runtime 2.0, RT-2)
- **Capability mode feature flag** — `ORCANA_CAPABILITIES_MODE` (`legacy` default / `shadow` / `enabled`; unknown values fall back to legacy, never silently enabled).
- **Shadow divergence observation** — in `shadow` mode the executor records `capability.shadow_mismatch` events when the new contract sees a schema divergence from the legacy path, leaving the result untouched (observe only); `legacy`/`enabled` keep validation authoritative. `CapabilityDescriptor.source` marks ToolDef-projected capabilities as `"legacy"`.

## [0.5.10] — 2026-08-05

### Added (Tool Runtime 2.0, RT-1)
- **Standard tool error codes** — canonical 26-code list (`TOOL_ERROR_CODES`), `ToolError` throwable + `toolError` info builder with per-code category/retryability defaults (`src/harness/capabilities/errors.ts`).
- **Structured execution results** — `ToolExecutionResult` with 6 statuses (`succeeded` / `domain_failed` / `execution_failed` / `blocked` / `cancelled` / `timed_out`), artifact/evidence refs, diagnostics, metrics; `domain_failed` (domain said NO) vs `execution_failed` (could not run) explicitly distinct; `resultHelpers` constructors.
- **Retry policy** — code-scoped `shouldRetry` + exponential backoff with cap (`retry.ts`).
- **ToolExecutionContext type** — explicit run-scoped context contract (roots/signal/budget/approval/sandbox/artifactStore/evidenceLedger/trace/fileState/ripple/patchStore/clock) with `buildExecutionContext` / `contextFromRunScope` (RT-3 wiring target).
- **Shared schema validator** — `validateJsonSchema` extracted to `capabilities/schema-validator.ts` (executor + interrupt manager + human node share one; `response-validator.ts` re-exports, zero behavior change).

## [0.5.9] — 2026-08-04

### Fixed (Graph Readiness G0-4)
- **Completion Gate hardened — tracker-less write claims need evidence** — the orchestrator evidence gate now supplies explicit `["typecheck"]` required kinds when a run performed writes without a task tracker (previously `canClaimDone` had no required kinds on that path, so any write-then-claim completed with zero verification). **HR-031 flips to `blocked`** (R1 calibrated it as `completed` with the gap recorded; the regression probe now locks the hardened behavior — verified by A/B: with the fix reverted HR-031 is `completed` again). Graph Readiness Gate G0-4 — completion decisions are sound before Graph commits build on them.

## [0.5.8] — 2026-08-04

### Added (Graph Readiness G0-3)
- **Artifact content persists with the run** — `SerializableRun` gains `artifactState` (artifact entities + resolved content); `collectArtifacts` gathers metadata AND content map at terminal save, `createArtifactStore` hydrates synchronously on restore. A restored run can now read artifact content back via its hash ref (was: *"artifact content is not restored, refs are"* — `serialization.ts` comment, removed). Old pre-G0-3 files hydrate an empty store, unchanged. End-to-end: a real run writing `.ts` files persists its `typecheck_result` artifacts and a fresh harness reads them after restore. Graph Readiness Gate G0-3 — restored evidence chains are provable.

## [0.5.7] — 2026-08-04

### Fixed (Graph Readiness G0-2)
- **Trace write failures are now fail-loud** — `TraceWriter` counts failed batch writes (`writeFailures()` / `pendingEvents()`); `createJsonlTraceWriter` accepts an `onWriteFailure` observer and the RunController warns once when a run ended with lost events. Writes still never fail the run (audit stream policy unchanged — the Run/Snapshot JSON remain the restore source), but a gap is no longer silent.
- **Restore trace integrity check** — `HarnessStore.traceIntegrity(runId)` reports event-file existence + count; `AgentHarness` restore/inspect paths surface a missing or incomplete audit stream as a warning. Graph Readiness Gate G0-2 — observability step toward Event Sourcing for Graph checkpoints.

## [0.5.6] — 2026-08-04

### Fixed (Graph Readiness G0-1)
- **Terminal vs stopped status semantics** — new `STOPPED_RUN_STATUSES` (`blocked`/`waiting`/`paused`) alongside `TERMINAL_RUN_STATUSES`: terminal means finished forever (no transitions out), stopped means not auto-advancing but resumable (`blocked → running`, `waiting → resuming`). `isStoppedRunStatus()` covers both. Replay/HR invariants now check "stopped" instead of treating `blocked` as a terminal status; every stopped run must carry an outcome. RunController comments corrected (waiting/blocked/paused are not terminal events). Graph Readiness Gate G0-1 — pre-requisite for Graph scheduler node-terminal decisions.

## [0.5.5] — 2026-08-04

### Docs (Harness Closure R1 · freeze)
- `docs/harness-2.0-plan.md` §27 — Harness Closure R1 实施记录：六项逐条 + HR-031 校准结论（False-done 门当前放行，已知加固缺口）+ **冻结声明**（H0–H12 + R1 冻结，禁止非 Graph 前置结构改动，Execution Graph GEP-1.0 启动）。
- `ARCHITECTURE.md` 状态表：Node Runtime (H11) → 🟢 stable（强制 Policy + 证据链已落地；scheduler/Graph deferred）。

## [0.5.4] — 2026-08-04

### Added (Harness Closure R1)
- **Rubric wired into the eval CLI** — `run-replay-cli.ts` evaluates the §18.4/18.5 rubric over every replay result: 8-dimension scores per case, quality-floor report (correctness/safety/truthfulness), warnings and P0 violations printed, `rubric` block in per-case JSON and an aggregated `summary.json` under `--report`.
- **Non-required rubric checks are real warnings** — `RubricEvaluation.warnings` separate from `failures`; a non-required failure no longer vetoes the run (was: pushed into `failures` with `passed` requiring an empty list, contradicting the "warnings only" comment).
- **Shared-process dual-run policy isolation test** — two run scopes in one process sharing one projectRoot permission file: the R1 run-scope-derived gate honors the shared deny rule for both runs, per-run allow overrides don't leak, and different project roots load different permission files. (hr-dual stays as honest independent-harness sanity; real plan/mode/cancel isolation remains H3.)
- **HR-031 False-done calibration scenario** — write tool executed + completion claim with no verification evidence. Calibrated against the real orchestrator: it **accepts** the completion (no task tracker → `canClaimDone` has no required evidence kinds). Recorded as a known Completion Gate hardening gap — the scenario is a regression probe that flips to `blocked` when the gate hardens. HR-004 retitled to match its actual semantics.

## [0.5.3] — 2026-08-04

### Fixed (Harness Closure R1)
- **Replay events carry the real sequence** — `RunReplayResult.events`/`ReplayEvent` keep the envelope `sequence` (was dropped before, making HR-025 sequence continuity vacuous); synthetic `interrupt.answered` events carry no sequence so resume scenarios can't fake continuity.
- **Tool-call termination pairs by `toolCallId`** — `batch-executor` `tool_result` now carries `tc.id`; the bridged `tool.call.completed` event carries `toolCallId` (contract field added). HR-026 asserts exactly one terminal per requested call: no terminal (unless a policy-block trace exists), duplicate terminals, and out-of-order terminals all fail; legacy events without a callId fall back to name pairing.
- **Node artifact paths resolve against the run scope's `projectRoot`** — artifact tracker relative paths (complements the VerificationNode fix in 0.5.2); loop keeps the cwd fallback.

## [0.5.2] — 2026-08-04

### Added (Harness Closure R1, P0-2)
- **NodeResult.evidence chain landed** — `NodeResult.evidence` is now the ledger diff of the node run: `snapshotEvidence`/`diffEvidence` helpers, wired into ToolNode, VerificationNode and LlmAgentNode. `AgentNodeOutput` carries `artifactIds` / `patchTransactionIds` (from patch artifacts, new `txId` field on `HarnessArtifact`) / `unresolvedRippleObligations` (honest `unknown[]` until the typed trace) / `resultingWorkspaceDigest` (run scope `projectRoot` hash). VerificationNode's ingested entries now appear in its `evidence`, bound to artifacts.
- **Single authoritative evidence ledger** — the kernel now accepts an injected `options.evidenceLedger` (same single-ownership pattern as sandbox/artifactStore); `buildLoopOptions` passes `run.scope.evidenceLedger`, so kernel verification and node diffs share ONE instance. Absent the option, the kernel creates its own (unchanged behavior).
- VerificationNode resolves relative modified files against `runScope.projectRoot` instead of `process.cwd()`.

## [0.5.1] — 2026-08-04

### Fixed (Harness Closure R1, P0-1)
- **ToolNode Policy Gate is now mandatory** — `executeCapability` no longer has a silent skip path: when neither `policyDecision` nor `policyContext` is supplied, the conservative default context is itself evaluated as a policy. `ToolNode` derives its policy context from the run scope (`createNodePolicyContextFromRunScope`), loading project permission rules under `scope.projectRoot/.orcana/permissions.json` — node-mode executions now obey the same permission surface as the loop, and strict mode fails closed (no interactive confirm channel in node mode).
- **Gate 2 name-only fallback** — `evaluateToolPolicy` now runs the permission gate when a concrete tool name exists even without a resolved tool descriptor, so unknown write-class capabilities are blocked by category inference instead of passing unexamined (loop mode always passes a descriptor — unchanged).
- **Rate-limit counter fix** — node-mode round usage counters were `Infinity`, which saturated Gate 1 and blocked every call; they now start at zero (run-level call budgets stay on the BudgetLedger).
- Tool calls carry `toolCallId` through policy/events; artifact tracker resolves relative paths against `projectRoot` when provided.

## [0.5.0] — 2026-08-04

### Added
- **Capability Registry / CapabilityExecutor (H9)** — `src/harness/capabilities/*`: unified Tool/Model/Verifier capability descriptions (§15); Tool→Capability projection over the canonical ToolContract (no second tool system); 8-step execution chain (Budget Reserve → Policy → Before Hook → Handler → After Hook → Schema Validation → Artifact/Evidence → Budget Commit); the normal loop and the future Node Runtime share one execution entry (`executeCapability`). Loop tool executions now route through it; write/external_action budgets are enforced (H4 debt cleared); patch/plan/ripple artifacts wired into the run flow (H8 debt cleared).
- **Context Provider Pipeline (H10)** — `src/harness/context/*`: 13 context providers (§16) layered stable/plan/node/volatile; pipeline (collect → dedupe → freshness → sort → budget → trim → ContextSlice); the loop no longer assembles context sources inline (byte-frozen parity with the legacy assembly).
- **Unified Node Runtime (H11)** — `src/harness/nodes/*`: `HarnessNode` primitives (function/tool/llm_agent/verification/human) + sequential `runNode` (no scheduler); **a single agent is now formally one `LlmAgentNode`** (reuses the LegacyLoopAdapter with byte-parity verified three ways); NodeEvent side stream (nodeRunId-stamped envelopes); run-level budget/cancellation/artifact governance throughout.
- **Eval Harness 2.0 (H12)** — `evals/harness/*` + `tests/harness-replay/*`: `RunReplayCase` contracts (§18.2) with ScriptedProvider (purpose routing, round_end boundaries, idle-timeout hang semantics) and scripted tools; `runReplayCase` hermetic executor (temp workspace, always-on trace invariants: sequence continuity / tool-call termination / terminal outcome); §18.4/18.5 multidimensional rubric (8 dimensions, quality floors, Safety/Truthfulness P0 veto — never a plain pass-rate); HR scenario matrix batch A — 11 scenarios green (readonly no-write, false-done blocking, typecheck repair, stream-interrupt recovery, plan approval / clarification resume, idempotent re-resume, context budget degrade/pause, permission deny, tool-call termination, secret redaction) + 3 dual-run isolation cases; Tier-1 replay assertion extensions (nested paths, regex, array length, not-exists, set containment); run-replay CLI (`bun run eval:replay --report`); CI tiers documented (§18.1); BudgetGuard cumulative-token double-count fixed (delta accounting) and `LEGACY_CONTEXT_MAX_TOKENS` plumbed for context-budget scenarios.
- **Rename leftovers fixed (H12)** — legacy eval paths migrated from `~/.deepseek-code/evals` to `~/.orcana/`.

## [0.4.0] — 2026-08-03

### Added
- **Harness 2.0 (H0–H8)** — `src/harness/`: `AgentHarness` facade is now the single production entry (CLI/TUI run through `AgentHarness.run()` → `LegacyLoopAdapter` → `agentLoop`; direct `agentLoop()` calls removed). Typed `HarnessEvent` contracts, `RunLifecycleMachine` + exhaustive `LoopDecision → RunOutcome` mapping, per-run isolation via `AgentRunScope`, `BudgetLedger` + cancellation policy (model/tool/token/wall-time budgets with a wall-time watchdog), typed JSONL event trace with legacy migration, `HarnessStore` persistence (sessions/runs/snapshots + workspace hash), persistent interrupt/resume for plan approval and clarification (cross-instance), artifact/evidence integration with freshness (workspace + file-hash drift → stale detection, `CompletionOrchestrator` derives completion facts from `EvidenceLedger`).

### Changed
- **Agent Loop Kernel slimming (ALK-1.0, L0–L7 complete)** — `src/agent/loop.ts` reduced from **2077 → 132 lines** (stage orchestrator only). Phase bodies moved into `src/agent/kernel/` (prepare / round / finalize) and the L3–L6 coordinators (`ProviderRoundRunner`, `ToolBatchExecutor`, `VerificationCoordinator`, `MaintenanceCoordinator`). All phase exits unified as `LoopDecision` (continue/break/return); stream/trace/state emission unified as `RunEffect` with field-level `AgentRunStatePatch`; single terminal switch + `finalizeRun()` + unified `finally` lifecycle. `loop.ts` no longer executes tools, parses provider streams, or performs verification/checkpoint/file-system work itself. L0 Golden Trace preserved.

## [0.3.0] — 2026-06-28

### Added
- **Phase 6 — ModelRouter / Provider**: purpose routing (cheap sub-calls → flash, same-provider preference), ProviderCapabilities (8-field per-model capability declarations), DeepSeekTranscriptManager (unclosed chain + adjacency + tool limit validation), unified structured output (fail-closed `callWithStructuredOutput` + `zodToJsonSchema`), FIM safety constraints (`checkFimSafety` with forbidden/scope/TOCTOU guard).
- **Phase 5 — Tool Risk / Permission / Sandbox**: ToolRiskTaxonomy (Risk 0-5, 40 tests), Permission UX (9-gate source/priority trace, confirm-stubs), ShellSideEffectGuard (18 patterns, 29 tests), SecretRedaction full pipeline (unified redactor, run-trace integration, 38 tests), SandboxCapability visibility (6 features, OS banner).
- **Phase 4 — PatchTransaction + Rewind**: PatchTransaction state machine (proposed→committed→rolled_back), atomic file writes (temp→verify→commit), `/rewind` command (3 modes: code/conv/both), Checkpoint UUID.
- **Phase 3 — Completion Orchestrator + Evidence**: CompletionOrchestrator unified final gate evaluation (loop.ts ~180→~50 lines), `canClaimDone()` single evidence entry point, FinalTruthfulnessGate future-tense filtering.
- **Phase 2 — MasterPlan / ModeContract / TaskPacket**: TaskPacket validation (9-field checks), ModeContract auto-transition (4 rules), TaskPacket takeover for long tasks, PlanValidator enhancements.
- **Phase 1 — Single Agent Long-Runtime Skeleton**: MasterPlan→TaskPacket→ContextEpoch→PatchTransaction→Evidence→Ripple→ModeContract→Replay Harness (9 PRs).
- **Phase 0 — Runtime Bootstrap**: unified `createRuntime()` for CLI/TUI, architecture docs truthfulness fix, v0.2.2 version baseline.
- **Ripple Engine 2.0**: ApiChange structured diff (8 change kinds), SemanticReferenceProvider (TypeScript type-checker based caller discovery), UsageImpact classifier (14 usage kinds), VerificationMap (convention-based test discovery), AstGrep fallback provider (6 pattern types).

### Fixed
- `.key$` false-positive on i18n/keyboard layout files → narrowed to SSH private key filenames.
- `tool_risk` gate invisible to telemetry → added to `toolGateNames` array.
- Scope matching bypass in FIM guard (substring/suffix overscope) → path-boundary-aware matching.
- Divergent forbidden-file lists across 3 modules → canonical `forbidden-patterns.ts`.
- Duplicate `hasUnclosedToolChain` across context-epoch + transcript-manager → single canonical source.
- 3 pre-existing test regressions from ModeContract shouldTransitionMode.

### Changed
- `maxRounds` default now 50, env-overridable via `DEEPSEEK_MAX_ROUNDS`.
- Flash Triage default changed to `"auto"` (matches design intent).
- Search backend: SearXNG Docker + DuckDuckGo → Exa semantic search + Jina Reader (zero Docker).
- Replaced `[PLAN_APPROVED]` string protocol with `AgentOptions.initialPlanState`.

## [0.2.1] — 2026-06-24

### Fixed
- Remove dead `_usage` type-penetration code (`loop.ts:324`) — written but never read.
- Replace `[PLAN_APPROVED]` string protocol with `AgentOptions.initialPlanState` field. Plan approval now passes through typed options instead of synthetic message content.
- Flash Triage now defaults to `"auto"` instead of `"off"`, matching the design intent of replacing 4 keyword classifiers.
- Remove duplicate field assignments in `buildTrackerFromTriage` spread — `requiredFiles`, `requiredVerificationKinds`, `steps` were already provided by the spread.

### Changed
- `DEEPSEEK_MAX_ROUNDS` env var as fallback for `maxRounds` default (was hardcoded 50).
- Softened "zero identity bias" → "reduced identity bias" in ARCHITECTURE.md, with training-distribution limitation noted.
- Documented FIM `/beta/completions` endpoint risk and Gate Overflow prompt-only limitation.

### Removed
- `package-lock.json` — Bun-only project, no npm lockfile.
- `parse_trending.mjs` moved from root to `scripts/`.
- `Co-Authored-By: Claude` attribution disabled via `~/.claude/settings.json`.

## [0.2.0] — 2026-06-24

### Added
- **GateChain architecture**: 14 gates across 4 phases (pre-round, tool policy, completion, overflow). 3 pass-through filters, 4 guards, 3 verify gates, 4 safety nets.
- **GateTelemetry**: pure data collector with `record`, `markFalsePositive`, `markMissed`, `report`, `summary`, `toJSON`/`fromJSON`, `merge`, cross-session persistence via `saveToFile`/`loadFromFile`. Wired into `agentLoop` at all 3 exit points.
- **Gate Manifest**: decision matrix (`keep`/`tune`/`observe`/`delete`/`safety_net`/`pass_through`) encoded as code in `src/agent/gates/manifest.ts`, with `generateManifest` and `manifestReport`.
- `gateTelemetryFile` option auto-saved to `.wolf/gate-telemetry.json` on every agent run, with additive merge across runs.
- `--model` flag for CLI runtime model override.
- `modelRouter` field in `AgentOptions` for sub-purpose model selection.
- 46 gate tests (33 telemetry + 13 manifest).

### Changed
- Planning gate re-architecture: `forcePlanningPassAfterLimit` integrated into completion chain.
- `maxRounds` default now reads `DEEPSEEK_MAX_ROUNDS` env var, falls back to 50.

## [0.1.2] — 2026-06-23

### Added
- Auto-detect user language (Chinese/English/Japanese) from prompt text.
- All system prompts adapt to detected language.
- `UILanguage` type and `detectLanguage` / `languageInstruction` helpers.

## [0.1.1] — 2026-06-23

### Fixed
- User confirmation now bypasses the planning gate to prevent infinite re-planning loop.
- Block Unix system paths (`/System`, `/etc`, `/boot`, `/sys`, `/proc`) in safety policy.

## [0.1.0] — 2026-06-22

### Added
- Initial open-source release.
- CLI (`src/ui/cli.ts`) and TUI (`src/tui/main.tsx`, Ink React) entry points.
- Agent loop with staged context, thinking store, knowledge base, ripple engine.
- DeepSeek V4 provider with thinking tokens, Flash sub-processing, FIM endpoint, prefix caching.
- 26 safety mechanisms: permission gate, Flash Judge, state machine, ripple engine, sandbox, memory compaction.
- MCP server bridge, tool registry, hook system.
- Session checkpoint (save/resume).
- npm distribution (`orcana-runtime` package, `orcana` CLI command).
