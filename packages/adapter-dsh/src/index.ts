/**
 * @mickorz/dynamic-workflow-adapter-dsh — DSH 宿主 adapter(P0 Spike)
 *
 * 分层:
 *  port             — DSH subagent seam 的脱壳类型(不依赖 @deepseek-ai 包;形状逐字段对齐)
 *  capabilities     — DSH 宿主能力声明(ADR-001)
 *  subagent-runner  — core AgentSessionRunner 的 DSH 实现(错误纪律/取消级联/结构化输出映射)
 *  engine           — standalone 增强引擎(runWorkflow + vmExecutor + runner;不碰 ctx.workflowEngine)
 *  tool             — dynamic_workflow 工具(宿主无关形状)
 *  glue             — 真机接线(type-only;真机联调点三处见文件头注释)
 */

export type {
  PortStartSubagent,
  PortSubagentStartRequest,
  PortSubagentResult,
  PortSubagentRun,
  PortAgentOptions,
  PortContentBlock,
} from "./port.js"
export { DSH_HOST_CAPABILITIES } from "./capabilities.js"
export { DshSubagentRunner } from "./subagent-runner.js"
export { DynamicWorkflowEngine } from "./engine.js"
export type { DynamicWorkflowEngineOptions, WorkflowProgressEvent, EngineRunInput } from "./engine.js"
export { buildDynamicWorkflowTool } from "./tool.js"
export type { DynamicWorkflowToolDeps, DynamicWorkflowToolCallArgs, DynamicWorkflowToolResult } from "./tool.js"
export { registerDynamicWorkflowTool, toDshStartRequest } from "./glue.js"
export type { DshGlueConfig, DshGlueDeps } from "./glue.js"
