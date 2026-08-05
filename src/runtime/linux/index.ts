/** LNXF-1.0: linux runtime entry — unified execution surface.
 *
 *  ADR-L1: all Linux child processes must flow through the broker. The
 *  runtime exports the broker, backends and process primitives; anything
 *  else in the codebase that needs Linux execution must consume these.
 */

export { createLinuxBroker, getLinuxBroker, registerBackend } from "./broker"
export type { LinuxExecutionBroker, ShadowExecutionRecord, LinuxBrokerOptions } from "./broker"
export { probeLinuxCapabilities, capabilitiesDigest, requireLinuxPlatform } from "./capability-probe"
export { createHostAuditBackend } from "./backends/host-audit"
export { createBubblewrapBackend } from "./backends/bubblewrap"
export { createPodmanBackend, validateImageRef, DIGEST_PATTERN } from "./backends/podman"
export { runSupervised, spawnSupervised } from "./process/supervisor"
export { buildExplicitEnvironment, hostKeyDenied, DEFAULT_DENIED_KEYS, DEFAULT_ENV_VARS } from "./environment"
export { bindSecrets, newSecretBinding } from "./secrets"
export { buildReceipt, receiptComplete, cellSpecDigest, computePolicyDigest } from "./receipt"
export { validateCellSpec, compileCellSpec, validateMountSet } from "./policy-compiler"
export { selectBackend, backendAvailability } from "./backend-router"
export { PROFILE_DEFAULTS, profileDefaults, isStrictProfile, applyProfileDefaults } from "./profiles"
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
