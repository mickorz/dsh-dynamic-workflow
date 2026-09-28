/**
 * dynamic_workflow 工具定义(宿主无关形状;glue 拿去注册到宿主工具面)
 *
 * P0 参数面(最小集;resume/checkpoint/嵌套等增强参数随 P0.5/P1 扩展):
 *  script       脚本原文,OpenCode 式 meta 信封契约(core parseWorkflowScript)
 *  args         暴露给脚本的全局
 *  concurrency  并发上限(钳制 16)
 *  maxAgents    本次 run 的 agent 总数上限
 *
 * 与官方 workflow 工具的分工(prompt section 指引,glue 注册):
 *  简单一两层编排 -> 官方 workflow;高级编排 -> dynamic_workflow
 */

import type { DynamicWorkflowEngine } from "./engine.js"

export interface DynamicWorkflowToolDeps {
  engine: DynamicWorkflowEngine
  /** 调用方中止信号(宿主工具执行语境;P0 由 glue 从 exec.signal 传入) */
  signal?: AbortSignal
}

export interface DynamicWorkflowToolCallArgs {
  script: string
  args?: Record<string, unknown>
  concurrency?: number
  maxAgents?: number
  /** 续跑历史 run（上次结果里的 runId）：未变 agent 调用直接从 journal 回放 */
  resumeFromRunId?: string
}

export interface DynamicWorkflowToolResult {
  ok: boolean
  /** 汇总渲染文本(成功含结果 JSON 摘要;失败含错误与定位信息) */
  output: string
  /** 结果 JSON(脚本 return 值;失败为 null) */
  value: unknown
  agentCount: number
  durationMs: number
  runId: string
}

const DESCRIPTION = [
  "运行动态工作流:执行一段 JavaScript 编排脚本,通过 agent() 将任务分发给子代理并行执行,",
  "parallel()/pipeline() 组合调度,脚本内汇总后仅返回最终结果,避免子代理上下文污染主会话。",
  "适用:全仓检查、独立并行调研、多视角评审、扇出汇总。",
  "脚本契约:首条语句 export const meta = { name, description };可用全局 agent/parallel/pipeline/phase/log/args;",
  "禁止 import/require/Date.now()/Math.random()/new Date();agent() 至少调用一次。",
].join("")

export function buildDynamicWorkflowTool(deps: DynamicWorkflowToolDeps) {
  return {
    name: "dynamic_workflow",
    description: DESCRIPTION,
    parameters: {
      type: "object",
      properties: {
        script: { type: "string", description: "JavaScript 编排脚本原文(含 meta 信封),无 markdown 围栏" },
        args: { type: "object", description: "暴露给脚本的全局 args 对象(JSON)" },
        concurrency: { type: "number", description: "最大并发 agent 数,钳制上限 16" },
        maxAgents: { type: "number", description: "本次 run 的 agent 总数上限,缺省 1000" },
        resumeFromRunId: { type: "string", description: "续跑历史 run(上次结果里的 runId):未变 agent 调用直接从 journal 回放,首个变更调用及其后重跑" },
      },
      required: ["script"],
    } as Record<string, unknown>,
    async execute(input: DynamicWorkflowToolCallArgs): Promise<DynamicWorkflowToolResult> {
      const script = normalizeScript(input.script)
      try {
        const result = await deps.engine.run({
          script,
          args: input.args,
          concurrency: input.concurrency,
          maxAgents: input.maxAgents,
          resumeFromRunId: input.resumeFromRunId,
          signal: deps.signal,
        })
        const rendered = renderResult(result.result as unknown)
        return {
          ok: true,
          output: `workflow "${result.meta.name}" 完成(${result.agentCount} agents,${result.durationMs}ms${result.resumedFromDisk ? ",resume 回放" : ""})\n${rendered}`,
          value: result.result,
          agentCount: result.agentCount,
          durationMs: result.durationMs,
          runId: result.runId,
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        return {
          ok: false,
          output: `dynamic_workflow 失败: ${message}`,
          value: null,
          agentCount: 0,
          durationMs: 0,
          runId: "",
        }
      }
    },
  }
}

/** 剥离可能的 markdown 围栏(与 OpenCode 版 normalizeWorkflowScript 同语义) */
function normalizeScript(script: string): string {
  let text = script.trim()
  const fence = text.match(/^```(?:js|javascript)?\s*\n([\s\S]*?)\n```$/i)
  if (fence) text = fence[1].trim()
  return text
}

const MAX_RESULT_CHARS = 50_000

function renderResult(value: unknown): string {
  const rendered = JSON.stringify(value, null, 2) ?? "null"
  return rendered.length > MAX_RESULT_CHARS
    ? `${rendered.slice(0, MAX_RESULT_CHARS)}\n... [截断: 共 ${rendered.length} 字符]`
    : rendered
}
