# MicroVM 决策（LR2-4 P4-D）

## 结论

**Firecracker / MicroVM 不是普通 rootless Cell 的直接替代品** —— 它需要
KVM（/dev/kvm）访问 + jailer/cgroup/namespace/seccomp 多层限制，是具备明确
宿主能力时的 **extreme-risk Backend**（计划 §8.4）。

**本机（WSL2）无 KVM** → MicroVM 后端不可用（MICROVM_WITHOUT_KVM = 0：
探测失败必须明确拒绝，不得静默降级为普通执行）。

## 适用

```text
未知二进制
递归生成的运行时代码
供应链恶意样本
安全实验
Evolution Kernel 候选
```

## 不适用

```text
普通 Git
普通测试
普通 TypeScript build
Repo Map
```

（这些场景 Bubblewrap/Rootless Podman 已覆盖，MicroVM 冷启动成本不值得。）

## 启用条件（全部满足才可接线）

```text
/dev/kvm 存在且可读写
jailer 二进制可用
Firecracker 二进制可用
宿主 CPU 虚拟化扩展（KVM 生效）
```

## 接线状态

- 探测函数：`src/runtime/linux/microvm.ts`（`detectKvm()`）；
- 后端注册：探测失败 → 后端不可用（`microvm.available = false`），
  严格 Profile 选择 microvm 时拒绝执行（不降级）。

## 评测要求（接入前）

Firecracker 后端需通过：原始 socket 绕过 / 重定向绕过 / DNS 重绑定 /
IPv6 绕过 等评测（与 Egress Gateway 强制安全同一套评测）。
