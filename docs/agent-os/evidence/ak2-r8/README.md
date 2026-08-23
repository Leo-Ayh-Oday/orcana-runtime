# AK2-R8 Completion — Reservation Failure Terminalization

**R8 BASE:** `c286a04c9a8b31ecc25157fcd5f031064e1fcec1`（R7 audited candidate）
**INTERMEDIATE:** `e316c27a21c2c4ba7b8483d3e03847138628c7ab`（post-audit follow-up：
intentReservationPath 类型级必填 + reserveDetailed 抛错不再逃逸 execute）
**FINAL CANDIDATE:** 见本分支 HEAD（completion commit）

## 与历史审计的关系

- R7 fresh independent audit（PASS_WITH_RISK）仅覆盖 `421f1a73..c286a04`。
- e316c27 之后另有三轮并行独立审计（dynamic-verification /
  counterexample-armament / fresh-surface），对象同为
  `421f1a73..c286a04`——**均不覆盖本 R8 completion 代码**。
- 本轮新增语义以 `tests/kernel/projection/r8-counterexamples.test.ts`
  冻结，等待 fresh independent audit。

## 语义清单（相对 c286a04 的累计 R8 delta）

1. `ProjectionCoordinatorOptions.intentReservationPath` 类型级必填
   （SOURCE_BREAKING；runtime 自 R7-03 已强制 —— type contract 对齐）。
2. `reserveDetailed` 抛错 ⇒ executor 零启动 → owned-reservation 登记 →
   统一终态化（rejected）→ settlement 失败可观测进 receipt reason →
   ProjectionError 重抛（行保留供 reconcile）。
3. terminalize 幂等护栏（`session.terminalized`）：最多一个终态、一份
   receipt；重复调用 no-op；durable settlement 写失败转为 settlement
   note + 行保留（TERMINALIZED_BIT_COMMIT_POINT：bit 在入口置位，
   durable settlement 失败被转换为可观测证据而非要求 bit 回滚 —— 由 ★
   veto 测试钉死）。
4. EBADF 条件上报（closeSync 幂等竞态静默；其它错误 console.error，
   不改控制流）。

## 测试与门禁

- `tests/kernel/projection/r8-counterexamples.test.ts`：6 用例
  （含 ★ R8_TERMINALIZE_PARTIAL_FAILURE_RETRY veto）。
- 回归：r3/r4/r6 全绿；r5 = KNOWN RED R5-00-9 唯一失败；
  r7-counterexamples + r7-representation 14/14（R7-00-3 负载时序敏感，
  solo/复批绿）；vertical-slice、coordinator、store.test 绿；
  projection+world 目录 320 tests（1 KNOWN RED）；authority-graph 10/10。
- typecheck / build exit 0；oxlint changed-paths 清洁；
  `git diff --check` 清洁。

## KNOWN RED / ENV BLOCKED / OWNER-DECISION

- R5-00-9 same-UID sealed-upper 直写：KNOWN RED / OWNER-DECISION-REQUIRED。
- B/cgroup delegated lane：ENV_BLOCKED。
- reservation durability 宿主 daemon 化/跨主机：后续架构决策。
