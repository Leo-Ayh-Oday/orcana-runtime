# RC 修复总指挥（Supervisor）— 四窗口并行调度表

> 目的：消除多线互锁。四个 Claude Code 窗口共享同一 git 工作区，并行前提是
> **文件域完全不相交**。任何跨域改动（含"帮忙修语法"）先报告总指挥协调，禁止代劳。
> 状态在此表更新；会话恢复先看此表。

## 窗口与领地（硬边界）

| 窗口 | 域 | 当前任务 | 状态 |
|---|---|---|---|
| ~~W1 Linux 沙盒~~ | src/runtime/**、src/tools/{shell,process,service}.ts、src/index.ts、tests/runtime/**、tests/shell_stream.test.ts | ✅ **PR-9（8951349）+ PR-10 Gate 回填 5 项（38c86aa/9f8f4fc/d7c8fb9/d5fc7d8/04c35b8，F2/F4/F7/C5/C1）已落地**；gate-matrix 5 TBD 已回填 0 | 💀 窗口丢失（PR-10 由重派 W3 完成） |
| ~~W2 RC 台账~~ | src/session/**、src/ui/**、src/provider/**、src/tools/其余、tests/其余 | ✅ RC-10 完成（3520a1e+c9c8018）；RC-11 余项（D4/H8/H9）悬空待接盘 | 💀 窗口丢失 |
| W3 Linux 执行（重派） | src/runtime/**、src/tools/{shell,process,service}.ts、src/index.ts、tests/runtime/**、tests/shell_stream.test.ts | ✅ **PR-10 Gate 回填完成**（5 commits 全绿，200 pass/8 skip）→ **M15 定义丢失无法派**；可派：RC-11 余项 D4（checkpoint 恢复接线）/H8/H9（需先查 harness-2.0-plan 域重叠）、或待命汇合 | 🔧 存活（上下文已清空重开） |
| W4 RC-18 K | src/agent/round/**、src/agent/kernel/**、src/agent/其他、src/memory/**、src/harness/context/**、src/context/** + 对应 tests | ✅ Batch A（af12939）+ Batch B（a4472d0+5322c48：K3/K8/K19/K22/K23/K36 + RC-11 D3）K 16 fixed/39 open → **Batch E 已授权**（memory 14：K10/K12-K18/K42-K47）→ 之后 Batch D（harness-context 14）→ Batch C（context 3） | 🔧 存活 |
| Claude（总指挥） | evals/**、docs/reliability/supervisor.md、docs/ormb-microbench-plan.md | 调度 + 冲突裁决 + P3/P4 待命（等 RC-18） | — |

**窗口风暴教训（2026-08-06 ~15:2x）**：曾开 9 窗 → 8G 内存爆掉全卡死。资源数学：并行度 = 内存/每窗占用，8G 上限 **2 窗**，且每窗子代理并发 ≤ 4。窗口丢失只丢上下文，未提交改动在磁盘不丢（见 git status 归域表）。W1 领地：loop.ts/run/scope.ts 已随 PR-9 提交解锁，其他窗口可恢复常规访问。

**汇合门禁（2026-08-06 15:2x，总指挥执行）**：typecheck ✅；全量 test 除 W4 在途 K21 2 fail 外全绿（RT-7 9 fail 已适配修复：4475363 + cc5637a）；W2 观测的 Linux 领地不稳定失败（shellStream/write observation/G4）已确认消除。PR-9 必验 shellStream 6/6 ✅（一次 4967ms 超时 flaky，重跑通过）。

**git 共享索引竞态事故（cc5637a）**：总指挥 add 单文件后，W3 恰在同一时刻 add 了自己的文件 → commit 误卷 W3 11 个文件（workflow 6 + tests 5）。内容无损（693 insertions 完整）；不 reset（W3 存活，避免打乱其 git 状态）。教训：窗口 add 与总指挥 commit 之间仍有竞态窗口——**总指挥提交前先 git status 核对 staged 集，提交后立即通报全窗**。
| Claude（总指挥） | evals/**、docs/reliability/supervisor.md、docs/ormb-microbench-plan.md | 调度 + 冲突裁决 + P3/P4 待命（等 RC-18） | — |

**域切分说明（2026-08-06 14:5x）**：K 系列 49 项 open 中，46 项文件域与 RC-10 零重叠（session/ui vs agent/memory/harness-context/context）→ 拆给 W4。K6/K11 落在 src/ui/**（W2 领地，RC-10 同域）留 W2；K48 全库项最后由总指挥裁定。

## 红线（四窗口共同）

- 跨域文件零触碰；git add 严禁 `-A`（工作区有他域未提交 + .rt6-prof-* 垃圾目录）
- **W1 的 src/agent/loop.ts + src/agent/run/scope.ts 是临时领地，其他窗口连读改都不行**
- 全量门禁只在**汇合点**跑：所有窗口各自批次提交完、工作区干净时
- 版本合流：0.8.26.2（Linux 已发 0.8.26.1；W2 批次 23 项未发布）
- 已发生交叉记档：aba50c3（W2 改 policy-compiler 注释）、W2 预适配 4 测试文件——不再发生

## 依赖链（谁等谁）

```
W1 PR-9~15 ──────────┐
W2 RC-10/11 ─────────┤
W3 MW 批次 ──────────┼──► 汇合门禁 ──► 0.8.26.2 ──► P3(总指挥) ──► P4
W4 K 系列(46) ──► RC-18 完成 ──► P3 解锁 ──────────┘
```

## 检查点纪律

- 每窗口批次完成 → 各自提交（分域 add）→ 向用户汇报 → 用户转告总指挥 → 更新此表
- 两窗口或全部提交后：跑一次全量门禁（typecheck/test/build/pack/diff-check）
- **W4 的 RC-18 完成 = 触发 P3**（恢复手册：docs/ormb-microbench-plan.md §P3）
- **W1 的 PR-9 commit 必验 shellStream cancel（0 fail）**——注意：W2 于 15:0x 观测 shell_stream > run cancellation **5/5 fail**，与此前 0 fail 矛盾，疑似 W1 迭代中状态；PR-9 提交前 W1 必须重跑该测试，若提交后仍 fail 则 F2 为 PR-10 首位
- 汇合点：所有窗口批次提交完、工作区干净时跑全量门禁 → 0.8.26.2

## P3 探针（✅ 已完成 2026-08-06 19:xx，总指挥）

**全量 8/8 case（32k 窗口，compress 4 + rollover 4）→ 判定 8/8 通过**（C2 初判 CONSTRAINT_VIOLATED 经探针语义修正后确认假阳性）。8/8 触发 epoch 机制、8/8 触发 rollover、Tool Chain 8/8 无失败。结论 13-18 + 总裁定记入 `evals/microbench/observations.md`。

- **多源探针机制**：① 最终报告 JSON ② 进度 JSON 流 ③ 行为观测（写路径/写内容/读路径，**不受压缩影响**）。因 `epochRollover` 归档首条 user prompt，最终报告通道在 rollover case 上确定性失效——行为通道独立兜底，rollover 组 4/4 零 MISSING。
- **P3 总裁定：边测边修**——压缩不丢关键事实/决策/义务（决策复活零出现），K context 系列不再盲修；每个 context K 修复落地后用 run.ts 重跑对应 case 验证。
- **探针假阳性修正**：负约束 substring 匹配过宽（配置内容引用/自报提及 lib.ts 误判违禁）→ 只认行为写路径精确路径段。
- **事故与缺陷**：D7 TOOL_PATH_BASE_BOUND（file.ts 用 cwd 解析相对路径，评测写错位置；评测层 chdir 规避，生产待修）；state-machine 补执行状态→DONE 出口（post-loop isDone 兼容，agent_run_state 6/6）；done 后长尾收尾 warning 判定为正确拒绝（非缺陷）。
- **探针修复集已入库（17f5372）**：run.ts 多源探针 + cases.ts 别名组 + state-machine DONE 出口 + risk-policy eval bypass。中途两起 git 竞态事故（均内容无损）：
  1. 总指挥 add 6 文件后 W3 提交 **a3c37dd**（H9）卷走 → W3 随后 reset 丢弃 a3c37dd，探针集随 reset 出库
  2. 总指挥 b7cf90e 提交时卷走 W3 重新 staged 的 H9 4 文件（rewind.ts/checkpoint.ts/sqlite-session.ts/tests/rewind.test.ts，md5 与 a3c37dd 版相同 = 无损）——**W3 注意：H9 实际入库于 b7cf90e**
  教训：窗口 reset/rebase 与总指挥 add/commit 均构成竞态；总指挥提交改为 add 后立即 commit，窗口 reset 前先通报。

## 当前动作（2026-08-06 18:1x）

1. W3（Linux 域）：✅ PR-10 Gate 回填 5 项全绿（F2/F4/F7/C5/C1，5 commits；F4 修真缺陷×2、F7 修 pid<=0 防护缺失、C5 修无清理路径）→ gate-matrix 5 TBD 已回填 0。下一批候选：RC-11 余项 D4/H8/H9（D4 属 src/session；H8/H9 需查 harness-2.0-plan 与 W4 域重叠后定）
2. W4：✅ Batch D（e149587+55141ff）K 43/12 → **Batch C 已授权**（K37/K38/K39 + K40 根因 staged.ts）进行中
3. 总指挥：✅ **P3 收尾完成**——全量 8/8 case 判定通过（C2 假阳性修正后确认）、observations 结论 13-18 + 总裁定"边测边修"（b7cf90e）、探针集代码入库（17f5372）。**11 个专项高难度题：用户已放行移交其他窗口全权执行**（2026-08-06 晚，总指挥今晚休息不再调度）——**执行窗口可自由复用/修改 evals/microbench/context/**（总指挥域已放行），引用探针用法见 observations 结论 13-18 与 run.ts 注释；结果或阻塞向用户汇报
4. 汇合点：W4 Batch C 已提交（fecc426 H12 清偿）；W3 余批（H9 已入库 b7cf90e，K11 待）；探针集已提交（17f5372）→ 全量门禁 → 0.8.26.2 合流
