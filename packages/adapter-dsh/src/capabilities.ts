/**
 * DSH 宿主能力声明(P0;ADR-001)
 * 注意 usageReporting:DSH SubagentResult 无 token 用量面 —— 统计缺省,agent 记录不带 tokens。
 */
import type { HostCapabilities } from "@mickorz/dynamic-workflow-core"

export const DSH_HOST_CAPABILITIES: HostCapabilities = {
  structuredOutput: true,       // subagent seam 的 outputSchema(capture tool 强制)
  backgroundJobs: true,         // ctx jobs(shipped composition 内建)
  interactiveCheckpoint: false, // P0 未定通道;checkpoint 走 headless default
  processIsolation: true,       // PTC 可作为后续执行后端
  nativeWorkflowEvents: true,   // 宿主有 observe-only 事件体系
  worktreeIsolation: true,      // 文件策略允许范围内
  usageReporting: false,        // SubagentResult 无 usage 回传面
}
