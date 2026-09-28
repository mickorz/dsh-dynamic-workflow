/**
 * DSH subagent seam 的端口类型(port 层,宿主脱壳)
 *
 * 形状与 @deepseek-ai/dsh-subagent 的 SubagentStartRequest / SubagentRun / SubagentResult
 * 逐字段对齐(thirdparties/deepseek-harness/packages/subagent/subagent/src/types.ts),
 * 但不 import @deepseek-ai 任何包 —— P0 阶段 npm 上的 rc 版本与源码不同步,
 * adapter 以自有 port 类型运行,glue 负责物理接线(真机联调点)。
 *
 * 忠实保留的 seam 语义:
 *  - start() 抛错 = 基础设施故障(未发布 run);
 *  - result 永不 reject:子级失败 resolve 为 stopReason 非 completed;
 *  - 消费方必须 dispose()。
 */

/** ContentBlock 的最小消费面(runner 只拼/读 text 块) */
export interface PortContentBlock {
  type: "text"
  text: string
}

/** host-Agent 覆盖(runner 只用 provider / model 两字段) */
export interface PortAgentOptions {
  provider?: string
  model?: string
}

/** start 请求(对齐 SubagentStartRequest 的 workflow 消费面) */
export interface PortSubagentStartRequest {
  label?: string
  prompt: PortContentBlock[]
  signal: AbortSignal
  agentOptions?: PortAgentOptions
  outputSchema?: Record<string, unknown>
}

/** 终局(对齐 SubagentResult;result 永不 reject) */
export interface PortSubagentResult {
  output: PortContentBlock[]
  structured?: unknown
  diagnostic?: string
  stopReason: "completed" | "cancelled" | "error"
}

/** 一次性子 run 句柄(对齐 SubagentRun) */
export interface PortSubagentRun {
  id: string
  result: Promise<PortSubagentResult>
  dispose(): Promise<void>
}

/** 脱壳后的 subagents.start(provider 名在装配时闭包绑定,与 seam 的 start(name, request) 二参形状等价) */
export type PortStartSubagent = (request: PortSubagentStartRequest) => Promise<PortSubagentRun>
