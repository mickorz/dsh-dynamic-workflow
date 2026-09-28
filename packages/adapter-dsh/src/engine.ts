/**
 * DynamicWorkflowEngine —— standalone 增强引擎(P0 最小版)
 *
 * 组装:core.runWorkflow + executor-vm + DshSubagentRunner(port 层)。
 * 不注册 ctx.workflowEngine(standalone 模式:故障半径与官方引擎隔离)。
 * 进度事件:onAgentUpdate 转发为宿主无关的 WorkflowProgressEvent
 * (nativeWorkflowEvents 能力位为 true 时,由 glue 转发进 DSH 事件体系)。
 */

import {
  runWorkflow,
  type AgentRecord,
} from "@mickorz/dynamic-workflow-core"
import { vmExecutor } from "@mickorz/dynamic-workflow-executor-vm"
import { DshSubagentRunner } from "./subagent-runner.js"
import type { PortStartSubagent } from "./port.js"

export interface DynamicWorkflowEngineOptions {
  startSubagent: PortStartSubagent
  /** 项目基准目录(journal/worktree/registry 的锚点) */
  cwd: string
  /** 进度事件出口(宿主事件体系或测试观察者) */
  onProgress?: (event: WorkflowProgressEvent) => void
  concurrency?: number
  maxAgents?: number
}

/** 进度事件(observe-only 快照;对齐官方 workflow/* 事件的最小面) */
export type WorkflowProgressEvent =
  | { type: "agent-start"; label: string; phase?: string; sessionId?: string }
  | { type: "agent-end"; label: string; status: "ok" | "failed" | "aborted"; replayed?: boolean }
  | { type: "phase"; title: string }

export interface EngineRunInput {
  script: string
  args?: unknown
  signal?: AbortSignal
  concurrency?: number
  maxAgents?: number
}

export class DynamicWorkflowEngine {
  private readonly runner: DshSubagentRunner

  constructor(private readonly options: DynamicWorkflowEngineOptions) {
    this.runner = new DshSubagentRunner({ startSubagent: options.startSubagent })
    // agent-start 去重:core 的 onAgentUpdate 在每次状态迁移都回调(running 无 id -> running 带 sessionId),
    // seam 语义的 agent-start 只发一次(record.id 首见时)
    this.startedIds = new Set()
  }

  private readonly startedIds: Set<string>

  /** 执行一次 workflow(runWorkflow 语义;不可恢复错误原样上抛,由工具层映射为错误结果) */
  async run(input: EngineRunInput) {
    const onProgress = this.options.onProgress
    return runWorkflow(input.script, {
      executor: vmExecutor,
      agent: this.runner,
      args: input.args,
      concurrency: this.options.concurrency,
      maxAgents: this.options.maxAgents,
      signal: input.signal,
      cwd: this.options.cwd,
      onAgentUpdate: onProgress ? (record: AgentRecord) => emitProgress(onProgress, record, this.startedIds) : undefined,
    })
  }
}

/** AgentRecord 状态迁移 -> 事件流(record.id 首见发 agent-start,终态发 agent-end) */
function emitProgress(
  onProgress: (event: WorkflowProgressEvent) => void,
  record: AgentRecord,
  startedIds: Set<string>,
): void {
  if (record.status === "running") {
    if (startedIds.has(record.id)) return
    startedIds.add(record.id)
    onProgress({
      type: "agent-start",
      label: record.label,
      ...(record.phase ? { phase: record.phase } : {}),
      ...(record.sessionId ? { sessionId: record.sessionId } : {}),
    })
  } else {
    onProgress({
      type: "agent-end",
      label: record.label,
      status: record.status,
      ...(record.replayed ? { replayed: true } : {}),
    })
  }
}
