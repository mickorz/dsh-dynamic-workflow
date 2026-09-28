/**
 * Host Capability Model(P0;ADR-001 计划项)
 *
 * Runtime 的宿主差异分支一律走能力位,禁止平台 if-else(isDSH / isOpenCode)。
 * adapter 声明自己的能力面;core 消费能力位决定降级路径(如 interactiveCheckpoint
 * 缺失时 checkpoint 走 headless default —— 现有 confirm 注入缝的正式化)。
 */

/**
 * 宿主能力声明。
 * 每一位对应一个 adapter 必须明确回答的问题;未声明按 false 处理(保守降级)。
 */
export interface HostCapabilities {
  /** 结构化输出:子代理 schema 约束结果(OpenCode: json_schema;DSH: outputSchema) */
  structuredOutput: boolean
  /** 后台运行(OpenCode: BackgroundRunManager;DSH: ctx jobs) */
  backgroundJobs: boolean
  /** 人工确认通道(OpenCode: ToolContext ask;DSH: 待定,先 headless) */
  interactiveCheckpoint: boolean
  /** 进程级隔离执行后端(DSH: PTC;OpenCode: 无) */
  processIsolation: boolean
  /** 宿主原生 workflow 进度事件(DSH: workflow 事件;OpenCode: 快照文件轮询) */
  nativeWorkflowEvents: boolean
  /** git worktree 隔离可用(取决于宿主文件策略) */
  worktreeIsolation: boolean
  /** 子代理 token 用量回传(OpenCode: prompt 响应携带;DSH: SubagentResult 无 usage 面,P0 为 false) */
  usageReporting: boolean
}

/** 全 false 兜底(未声明能力的宿主按最保守面处理) */
export const MINIMAL_HOST_CAPABILITIES: HostCapabilities = {
  structuredOutput: false,
  backgroundJobs: false,
  interactiveCheckpoint: false,
  processIsolation: false,
  nativeWorkflowEvents: false,
  worktreeIsolation: false,
  usageReporting: false,
}
