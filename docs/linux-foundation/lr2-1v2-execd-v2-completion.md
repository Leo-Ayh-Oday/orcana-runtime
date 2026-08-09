# execd v2 完成记录（LR2-1v2）

**计划编号：** LR2-1v2
**英文名称：** execd v2 — 跨进程句柄接管 + AttachLogs + 背压 + approvalToken
**基线：** `b2d5723` → 完成于 `b488b37`（含独立审核修复）
**状态：** ✅ 完成（L2-A~E + 独立审核闭环）

## 交付内容

| 阶段 | Commit | 内容 |
| --- | --- | --- |
| 计划 | `26c8966` | L2-A~E 阶段划分 |
| L2-A | `9263883` | 执行句柄持久化（execution_handles 表）+ cgroup.events 探活接管 |
| L2-B | `5ca2fa9` | LogStore 大对象落盘 + AttachLogs 回放原语 |
| L2-C | `6b54109` | EventStream 有界队列 + 落后标记 |
| L2-D | `e8aba74` | approvalToken 校验（env/注入 + 恒定时间 + fail-closed） |
| L2-E | `530d302` | 7 项 Gate 验收 |
| 审核修复 | `b488b37` | B1-B5 + M1-M4 + N2/N5 全处置 |

## 独立审核（5 BLOCKER + 4 MAJOR + 7 MINOR，全部处置）

### BLOCKER（生产接线缺失 —— 全部修复）

- **B1**：执行句柄从未写入生产路径（表恒空 → 接管逻辑死代码）→
  cell-manager RUNNING 时经 `broker.cgroupBase()` + hierarchyPaths 记录
  句柄；cell 终结（CLEANED/CANCELLED）时删除（无泄漏/无复用错接管）。
- **B2**：LogStore/AttachLogs 完全未接线 → createExecd 装配 LogStore
  （logRoot 可配）、log_index 表入库、cell-manager stdout/stderr 同时
  落盘、server AttachLogs 路由（UNKNOWN_CELL 拒绝）。
- **B3**：EventStream 背压未接入 server → publishEvent 检测 socket 写
  缓冲（writableLength），慢消费者停推实时事件（落库补读）——
  socket 写缓冲不无限增长。
- **B4**：RECOVERED 是"假装恢复"（无取消/监控）→ cancelCell 在 broker
  内存映射丢失（重启后）时走持久化句柄的 cgroup.kill 树杀路径；
  不把 CANCELLED 标给活进程。
- **B5**：L2-E Gate 全函数级假绿 → 新增生产路径集成测试 6 条（句柄
  生命周期、AttachLogs 协议路由含 >16KB 完整回放与断点续读、socket 级
  token 拒绝、Hello 豁免）。

### MAJOR

- **M1**：cgroup.events 读失败 → ABSENT→START_FAILED 孤儿化活进程 →
  改为 UNKNOWN 保持 RUNNING 待重试（不谎报终态）。
- **M2**：LogStore.read 整文件入内存 + UTF-16 错位 → readTail 字节
  offset 流式读（fd 定位读尾部）+ UTF-8 边界剥尾 + lengthBytes 用
  Buffer.byteLength。
- **M3**：appendFileSync 阻塞事件循环 → 保字节计数一致（文件系统
  缓冲策略留 v2 后续）。
- **M4**：acknowledge 未补读可跳越丢事件 → 落后时禁止越过补读窗口
  （逐事件确认或追平最新发布才清落后）。

### MINOR（N2/N5 修复，N1/N4/N6/N7 文档化/已验证）

- N2：recovery receipt 幂等键（cellId+attemptId，反复重启不重复写）。
- N5：maxQueued ≤ 0 抛错。
- N1：cgroup 预创建威胁模型注释；N4：token 校验在幂等缓存前（fail-
  closed 合理，已文档化）；N6：remove 即时截断语义；N7：测试名修正。

## Gate 状态

```text
EXECD_RESTART_LOSES_RUNNING_CELL   = 0 ✅（生产路径句柄 + RECOVERED）
CGROUP_POPULATED_UNTRACKED         = 0 ✅（UNKNOWN 不孤儿化）
ATTACH_LOGS_TRUNCATED              = 0 ✅（协议路由 + >16KB 完整回放）
EVENT_QUEUE_UNBOUNDED              = 0 ✅（有界队列 + 写缓冲检测）
SLOW_CONSUMER_EVENT_LOSS           = 0 ✅（落后补读 + ack 守卫）
UNAUTHORIZED_APPROVAL              = 0 ✅（socket 级集成验证）
LOG_LEAK_AFTER_CLEANUP             = 0 ✅
```

## 测试

`tests/execd/` 全量 95 测试全绿（含 6 条生产路径集成测试）；全量门禁
（typecheck/test/build/diff-check）通过。

## 遗留（v2.1 范围）

- M3 缓冲刷盘：append 异步缓冲 + fsync 策略（当前同步写保正确性）；
- AttachLogs 分页流式（当前单次读到 EOF —— 超大日志内存边界）；
- 接管后的周期性 cgroup 探活（当前恢复时一次性判定）；
- systemd socket activation / mTLS 传输层。
