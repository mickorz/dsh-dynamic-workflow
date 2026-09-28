/**
 * DshSubagentRunner —— core 的 AgentSessionRunner 注入缝在 DSH 上的实现(port 层)
 *
 * 映射(OpenCode 惯例形状 -> DSH subagent seam):
 *  prompt            -> [{ type: 'text', text }]
 *  label             -> label(展示名)
 *  model "prov/id"   -> agentOptions { provider, model }(单串拆双字段)
 *  schema            -> outputSchema(seam 原生结构化输出,无需 OpenCode 的降级双路)
 *  signal            -> signal(seam 同一信号:start 前后都是权威取消通道)
 *  onSessionCreated  -> start() resolve 后立即回传 run.id
 *  onUsage           -> 不调用(DSH 无 usage 面;capabilities.usageReporting=false)
 *  agentType         -> 不映射(DSH 以 provider 概念替代,由引擎配置 defaultProvider)
 *  directory         -> 不映射(worktree 注入 prompt 的语义在 core;DSH file policy 后续接)
 *
 * 结果模型(错误纪律对齐 core / OpenCode 版):
 *  completed + schema -> structured ?? null 包装为 { type: 'structured' }
 *                        (seam 契约:带 outputSchema 的 completed 无 structured = 子级失败 -> null)
 *  completed 无 schema -> output text 拼接为 { type: 'text' }
 *  stopReason error   -> throw WorkflowError(AGENT_FAILED, recoverable) -> core 重试/塌缩
 *  stopReason cancelled -> throw WorkflowError(WORKFLOW_ABORTED, recoverable) -> run 级中止
 *  start() 抛错       -> 基础设施故障,原样上抛(core 按不可恢复处理)
 *  任何路径 finally dispose()(seam 消费方契约)
 */

import {
  WorkflowError,
  WorkflowErrorCode,
  type AgentExecutionResult,
  type AgentRunOptions,
  type AgentSessionRunner,
} from "@mickorz/dynamic-workflow-core"
import type { PortStartSubagent } from "./port.js"

/** OpenCode 惯例 "provider/modelId" 拆为 DSH 双字段;裸 modelId 时只传 model */
function parseModelSpec(model: string | undefined): { provider?: string; model?: string } {
  if (!model) return {}
  const sep = model.indexOf("/")
  if (sep <= 0 || sep === model.length - 1) {
    throw new Error(`agent model 必须是 "provider/modelId" 格式,收到: ${model}`)
  }
  return { provider: model.slice(0, sep), model: model.slice(sep + 1) }
}

function outputText(blocks: ReadonlyArray<{ type: string; text?: string }>): string {
  return blocks
    .filter((block) => block.type === "text" && typeof block.text === "string")
    .map((block) => block.text)
    .join("")
    .trim()
}

export interface DshSubagentRunnerOptions {
  /** 脱壳后的 subagents.start(glue 装配时闭包绑定 provider 名) */
  startSubagent: PortStartSubagent
}

export class DshSubagentRunner implements AgentSessionRunner {
  private readonly startSubagent: PortStartSubagent

  constructor(options: DshSubagentRunnerOptions) {
    this.startSubagent = options.startSubagent
  }

  async run(prompt: string, options?: AgentRunOptions): Promise<AgentExecutionResult> {
    const run = await this.startSubagent({
      label: options?.label,
      prompt: [{ type: "text", text: prompt }],
      ...(options?.model ? { agentOptions: parseModelSpec(options.model) } : {}),
      ...(options?.schema ? { outputSchema: options.schema } : {}),
      ...(options?.signal ? { signal: options.signal } : { signal: new AbortController().signal }),
    })
    // 建立即回传:running 态就带上子 run id(core 的 record.sessionId)
    options?.onSessionCreated?.(run.id)

    try {
      // seam 契约:result 永不 reject;子级失败经 stopReason 表达
      const result = await run.result
      if (result.stopReason !== "completed") {
        if (result.stopReason === "cancelled") {
          throw new WorkflowError(
            `子代理被取消${result.diagnostic ? `: ${result.diagnostic}` : ""}`,
            WorkflowErrorCode.WORKFLOW_ABORTED,
            { recoverable: true },
          )
        }
        throw new WorkflowError(
          `子代理失败${result.diagnostic ? `: ${result.diagnostic}` : "(无诊断信息)"}`,
          WorkflowErrorCode.AGENT_FAILED,
          { recoverable: true },
        )
      }
      if (options?.schema) {
        // 带 outputSchema 的 completed 无 structured:seam 定义为子级失败 -> null(与官方 runtime 同语义)
        return { type: "structured", value: result.structured ?? null, sessionId: run.id }
      }
      return { type: "text", value: outputText(result.output), sessionId: run.id }
    } finally {
      await run.dispose().catch(() => {
        // dispose 失败不改变结果语义;seam 允许幂等清理
      })
    }
  }
}
