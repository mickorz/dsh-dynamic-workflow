/**
 * @mickorz/dynamic-workflow-core — Agent Workflow Runtime 宿主无关核心
 *
 * 分层:
 *  contracts — 类型词汇表 / 错误纪律 / 注入缝接口(AgentSessionRunner, WorkflowExecutor)
 *  runtime   — 编排核心(runWorkflow) / 并发闸门 / 结果处理
 *  nodes     — 组合节点三态执行器(sequence/fallback/race 的底层契约)
 *  journal   — 运行日志持久化(resume 回放源)
 *  registry  — 子 workflow 目录注册表
 *  tier      — 模型分层配置加载
 *  isolation — git worktree 隔离
 *  script    — 脚本契约解析(meta 信封 + 确定性校验;执行在 executor-vm 等后端)
 *
 * 依赖边界:不 import 宿主 SDK / node:vm(scripts/check-core-boundary.mjs 守门)。
 */

// ---- contracts ----
export type {
  AgentUsage,
  AgentRecordStatus,
  AgentUsageSplit,
  AgentExecutionRecord,
  WorkflowExecutionRecord,
  AgentRecord,
  CompositeRecord,
  WorkflowMeta,
  WorkflowRunResult,
  JournalEntry,
  CheckpointRequest,
  CheckpointRecord,
} from "./contracts/types.js"
export { WorkflowError, WorkflowErrorCode, wrapError } from "./contracts/errors.js"
export type { AgentRunOptions, AgentExecutionResult, AgentSessionRunner } from "./contracts/session-runner.js"
export type { WorkflowExecutor } from "./contracts/executor.js"
export type { HostCapabilities } from "./contracts/host.js"
export { MINIMAL_HOST_CAPABILITIES } from "./contracts/host.js"

// ---- runtime ----
export {
  MAX_CONCURRENCY,
  MAX_AGENTS_PER_RUN,
  MAX_AGENT_RETRIES,
  MAX_WORKFLOW_DEPTH,
  runWorkflow,
} from "./runtime/workflow-runtime.js"
export type {
  ScriptAgentOptions,
  WorkflowRef,
  WorkflowRunOptions,
  CheckpointOptions,
} from "./runtime/workflow-runtime.js"
export { createLimiter } from "./runtime/semaphore.js"
export type { Limiter } from "./runtime/semaphore.js"
export { buildOutputPreview, truncatePromptForJournal, truncateUtf8ByBytes, redactValue, OUTPUT_PREVIEW_LIMIT_BYTES } from "./runtime/agent-result.js"

// ---- nodes ----
export { createNodeExecutor, compositeScopeStorage } from "./nodes/node-contract.js"
export type { WorkflowNode } from "./nodes/node-contract.js"

// ---- journal ----
export { JournalStore } from "./journal/journal.js"

// ---- registry ----
export { loadRegistry, workflowsDir, readWorkflowScript } from "./registry/workflow-registry.js"
export type { RegisteredWorkflow } from "./registry/workflow-registry.js"

// ---- tier ----
export { loadModelTiers } from "./tier/model-tiers.js"
export type { ModelTiers } from "./tier/model-tiers.js"

// ---- isolation ----
export { createWorktree, removeWorktree } from "./isolation/worktree.js"
export type { WorktreeInfo } from "./isolation/worktree.js"

// ---- script ----
export { parseWorkflowScript } from "./script/parse.js"
