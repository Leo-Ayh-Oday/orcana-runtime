# ADR-AK-005 Effect Semantics

**状态：** 已定案（AK-0）
**Task：** `AK0-FND-001`

## 背景

外部动作可能在远端成功、但在本地 Receipt 持久化前崩溃。把调用异常等同于“未发生”并自动重试，会重复 Git push、发布、邮件或其他不可逆动作。

## 决策

外部 Effect 分为 `PURE`、`IDEMPOTENT`、`RECONCILABLE`、`IRREVERSIBLE`，并持久经历 Intent、Authorization、Prepare、Dispatch、Result 与 Reconciliation。已 dispatch 但结果不明的 Effect 进入 `UNKNOWN`。

`UNKNOWN` 禁止盲目重试。支持 reconcile 的 Driver 必须查询外部事实；无法确定时转为 `HUMAN_REQUIRED`。Graph 的 write/external node 在 Effect 未 settlement 前不得完成。

## 边界

- World mutation 与 external effect 是两个维度；
- Driver 不得绕过 Effect Journal；
- 不可逆 Effect 需要显式审批；
- Effect Receipt 必须绑定 provenance 与 Evidence。

## 不变量

```text
UNKNOWN_EFFECT_BLIND_RETRY = 0
EFFECT_WITHOUT_INTENT = 0
NODE_COMPLETES_WITH_UNKNOWN = 0
```
