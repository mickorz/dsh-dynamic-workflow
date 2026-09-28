/**
 * dynamic_workflow_control —— 后台 run 的查询与停止(OpenCode workflow_control 同构)
 * 操作:list(全部快照)/ status(runId)/ stop(runId)
 */
import type { BackgroundRunManager, BackgroundRunInfo } from "./background-runs.js"

export interface WorkflowControlCallArgs {
  operation: "list" | "status" | "stop"
  runId?: string
}

export interface WorkflowControlToolResult {
  ok: boolean
  output: string
}

function renderRun(info: BackgroundRunInfo): string {
  const parts = [
    `${info.runId} [${info.status}] ${info.name}`,
    `agents: ${info.agents.length}, started: ${new Date(info.startedAt).toISOString()}`,
  ]
  if (info.endedAt !== undefined) parts.push(`ended: ${new Date(info.endedAt).toISOString()} (${info.endedAt - info.startedAt}ms)`)
  if (info.error !== undefined) parts.push(`error: ${info.error}`)
  if (info.status === "completed" && info.value !== undefined) {
    const rendered = JSON.stringify(info.value, null, 2) ?? "null"
    parts.push(rendered.length > 4000 ? `${rendered.slice(0, 4000)}\n... [截断]` : rendered)
  }
  return parts.join("\n")
}

export function buildWorkflowControlTool(manager: BackgroundRunManager) {
  return {
    name: "dynamic_workflow_control",
    description: [
      "查询或停止后台动态工作流。",
      "operation: list 列出全部 run 快照;status 查单个 run(需 runId);stop 停止运行中的 run(需 runId,abort 级联子代理)。",
    ].join(""),
    parameters: {
      type: "object",
      properties: {
        operation: { type: "string", enum: ["list", "status", "stop"], description: "list / status / stop" },
        runId: { type: "string", description: "status 与 stop 必填;list 忽略" },
      },
      required: ["operation"],
    } as Record<string, unknown>,
    async execute(input: WorkflowControlCallArgs): Promise<WorkflowControlToolResult> {
      if (input.operation === "list") {
        const all = manager.status()
        if (all.length === 0) return { ok: true, output: "无后台 run 记录" }
        return { ok: true, output: all.map(renderRun).join("\n\n---\n\n") }
      }
      if (!input.runId) return { ok: false, output: "status 与 stop 需要 runId 参数" }
      if (input.operation === "status") {
        const [info] = manager.status(input.runId)
        if (!info) return { ok: false, output: `未找到 run "${input.runId}"(用 operation:list 查看)` }
        return { ok: true, output: renderRun(info) }
      }
      if (input.operation === "stop") {
        const stopped = manager.stop(input.runId)
        return {
          ok: stopped,
          output: stopped ? `停止信号已发送(abort 级联);终态经 status 确认:${input.runId}` : `未找到运行中的 run "${input.runId}"`,
        }
      }
      return { ok: false, output: `未知 operation "${String(input.operation)}"` }
    },
  }
}
