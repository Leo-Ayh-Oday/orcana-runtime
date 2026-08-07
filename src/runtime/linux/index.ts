/** LNXF-1.0: linux runtime entry — unified execution surface.
 *
 *  ADR-L1: all Linux child processes must flow through the broker. The
 *  runtime exports the broker, backends and process primitives; anything
 *  else in the codebase that needs Linux execution must consume these.
 */

// LNXF-R2 9.7：导出面收窄 —— 后端工厂 / spawn 原语 / applyProfileDefaults /
// selectBackend 不再公开导出（ADR-L1 单入口：进程执行只能经 broker）。
// 后端由 broker 内部注册；policy 编译唯一入口 compileCellSpec / compileRequest。
export { createLinuxBroker, getLinuxBroker, registerBackend } from "./broker"
export type { LinuxExecutionBroker, ShadowExecutionRecord, LinuxBrokerOptions } from "./broker"
export { probeLinuxCapabilities, capabilitiesDigest, requireLinuxPlatform } from "./capability-probe"
export { buildExplicitEnvironment, hostKeyDenied, DEFAULT_DENIED_KEYS, DEFAULT_ENV_VARS } from "./environment"
export { bindSecrets, newSecretBinding } from "./secrets"
export { buildReceipt, receiptComplete, cellSpecDigest, computePolicyDigest } from "./receipt"
export { validateCellSpec, compileCellSpec, validateMountSet } from "./policy-compiler"
export { PROFILE_DEFAULTS, profileDefaults, isStrictProfile } from "./profiles"
export { ResourceLedger, defaultHostReserve, cpuQuotaFromCores } from "./scheduler/resource-ledger"
export { FairQueue, PRIORITY_WEIGHT } from "./scheduler/queue"
export type { QueuePriority, QueueItem } from "./scheduler/queue"
export { IsolationDomainLock } from "./workspace/isolation-lock"
export type { LockKind } from "./workspace/isolation-lock"
export { CacheManager, PortLeaseManager, validateBindAddress, SHARED_READONLY_KINDS } from "./workspace/cache-port"
export { AgentDomainManager } from "./workspace/agent-domain"
export { buildEgressPolicy, checkEgressHop, checkEgressRedirect, dnsRebindingGuard, validateNetworkMode } from "./network-policy"
export { compileLandlockRuleset, landlockUsable, compileSeccompProfile, seccompBackwardCompatible } from "./landlock-seccomp"
export { RuntimeStateStore, BootIdentityStore, startupJanitor, readBootId } from "./recovery/state-store"
export type { RecoveryReceipt } from "./recovery/state-store"
export { LinuxExecutionError, LINUX_ERROR_CODES, LINUX_ERROR_OUTCOME } from "./errors"
export type { LinuxErrorCode, LinuxErrorOutcome } from "./errors"
export type {
  LinuxCapabilities,
  ExecutionCellSpec,
  ExecutionCell,
  ExecutionCellEvent,
  ExecutionProfile,
  IsolationMinimum,
  BackendId,
  NetworkMode,
  MountRule,
  TmpfsRule,
  SecretBinding,
  CacheMountRequest,
  SandboxReceipt,
  SandboxViolation,
  AgentExecutionDomain,
  DomainResourceBudget,
  ResourceRequest,
  ResourceReservation,
  EnvironmentPolicy,
  PortLease,
  BackendAvailability,
  CompiledExecution,
} from "./contracts"
