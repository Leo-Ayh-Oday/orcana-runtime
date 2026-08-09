# ADR-AK-004 Capability vs Tool

**状态：** 已定案（AK-0）
**Task：** `AK0-FND-001`

## 背景

Tool 是面向模型的调用接口。若 Tool 名称、参数或 backend 隐式决定权限，就会产生 ambient authority，并使模型能够绕过用户与策略上限。

## 决策

Tool Registry 继续负责 LLM-facing API disclosure；Kernel 中的 `CapabilityHandle` 才代表某个 Principal 对某个 AgentObject 的具体 rights 与 constraints。Tool Adapter 只能发起 Capability Request，不能授权自身。

CapabilityDefinition 描述系统能做什么，CapabilityHandle 描述当前 Principal 被允许做什么。委托只能 attenuation：`ChildRights ⊆ ParentRights`。

## 边界

- backend routing 不得改变 authority；
- Tool/LLM 不得持有真实宿主秘密；
- revoke、expire 与 object scope 在 Kernel 授权路径强制执行；
- 现有 CapabilityDescriptor 通过兼容适配器迁移。

## 不变量

```text
TOOL_AS_AUTHORITY = 0
AMBIENT_CAPABILITY_ACCESS = 0
CHILD_RIGHTS_GT_PARENT = 0
```
