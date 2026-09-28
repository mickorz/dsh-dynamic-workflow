/**
 * DSH Cordis glue —— 真机接线层(P0;standalone 模式)
 *
 * P0 说明:npm 上的 @deepseek-ai rc 版本与 thirdparties 源码不同步,
 * 本文件不 import @deepseek-ai 包;宿主侧以结构最小面自持
 * (peerDependencies 已声明 @deepseek-ai/cordis 与 dsh-subagent,真机安装时生效)。
 * 真机联调点(装好 DSH 环境后核对,共三处):
 *  1. ctx.subagents.start(provider, request) 的二参形状(见 toDshStartRequest)
 *  2. ctx.tools.register 的工具注册形状(官方经 defineTool 包装,此处同构 plain object)
 *  3. 工具执行语境的 exec.agent(parent 归属)与 exec.signal(步骤中止)字段
 */

import type { DynamicWorkflowEngine } from "./engine.js"
import { buildDynamicWorkflowTool } from "./tool.js"
import type { PortStartSubagent, PortSubagentStartRequest } from "./port.js"

/** 工具注册面的结构最小面(真机联调点 2:切换为真实 ctx.tools 类型) */
export interface ToolRegistryMin {
  register(tool: Record<string, unknown>): void
}

export interface DshGlueConfig {
  /** subagent provider 名(默认官方 spawn) */
  provider?: string
}

export interface DshGlueDeps {
  engine: DynamicWorkflowEngine
  /** 脱壳 start:port 请求 -> ctx.subagents.start(provider, {...request, parent}) */
  startSubagent: PortStartSubagent
}

/**
 * 注册 dynamic_workflow 工具。
 * parent(子代理归属)与 signal(步骤中止)在每次工具执行时从执行语境获得
 * (官方 tool-workflow 的 exec.agent / exec.signal 同款模式;真机联调点 3)。
 */
export function registerDynamicWorkflowTool(
  tools: ToolRegistryMin,
  deps: DshGlueDeps,
  config: DshGlueConfig = {},
): void {
  void deps.startSubagent
  void config.provider
  tools.register({
    ...buildDynamicWorkflowTool({ engine: deps.engine }),
  })
}

/** port 请求 -> DSH seam 请求的适配形状(parent 由调用语境注入;真机联调点 1) */
export function toDshStartRequest(
  request: PortSubagentStartRequest,
  parent: unknown,
): Record<string, unknown> {
  return {
    label: request.label,
    prompt: request.prompt,
    signal: request.signal,
    ...(request.agentOptions ? { agentOptions: request.agentOptions } : {}),
    ...(request.outputSchema ? { outputSchema: request.outputSchema } : {}),
    parent,
  }
}
