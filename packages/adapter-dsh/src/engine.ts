/**
 * DynamicWorkflowEngine —— standalone 增强引擎(P0.5:journal 落盘 + resume)
 *
 * Durability 语义(ADR-003/005):
 *  - 每个成功 agent 完成即原子落盘(<cwd>/.dynamic-workflows/journal/<runId>.json);
 *    失败/中止 attempt 只进 executions 历史(绝不写 hash,resume 不受影响)
 *  - resumeFromRunId:从盘加载 journal 注入 runWorkflow,未变前缀回放(不调子代理),
 *    首个变更调用及其后全部重跑
 *  - 副作用红线:回放保证执行语义,不保证外部副作用 exactly-once(见 README)
 *
 * 进度事件:onAgentUpdate 转发为宿主无关的 WorkflowProgressEvent。
 */

import {
  runWorkflow,
  JournalStore,
  loadModelTiers,
  type AgentRecord,
  type JournalEntry,
} from "@mickorz/dynamic-workflow-core"
import { vmExecutor } from "@mickorz/dynamic-workflow-executor-vm"
import { DshSubagentRunner } from "./subagent-runner.js"
import type { PortStartSubagent } from "./port.js"

/** journal 落盘目录(相对 cwd;与 OpenCode 版 .opencode-workflows 同构,DSH 宿主命名) */
export const JOURNAL_DIR = ".dynamic-workflows/journal"
/** workflow 注册表目录(相对 cwd;workflow() 按名引用的查找目录) */
export const REGISTRY_DIR = ".dynamic-workflows/workflows"
/** tier 配置目录(相对 cwd;其下 model-tiers.json) */
export const TIER_ROOT = ".dynamic-workflows"

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
  /** 续跑历史 run:从盘加载 journal,未变前缀回放 */
  resumeFromRunId?: string
}

/** engine 面的 run 结果(runWorkflow 返回 + journal 落盘信息) */
export interface EngineRunOutput {
  meta: { name: string }
  result: unknown
  logs: string[]
  phases: string[]
  agents: AgentRecord[]
  agentCount: number
  durationMs: number
  /** 本 run 的 journal 身份(resume 时为传入值) */
  runId: string
  /** resume 注入的 journal 是否命中(未命中说明传错 runId,已按新 run 跑) */
  resumedFromDisk: boolean
}

export class DynamicWorkflowEngine {
  private readonly runner: DshSubagentRunner
  private readonly journalStore: JournalStore
  // agent-start 去重:core 的 onAgentUpdate 在每次状态迁移都回调(running 无 id -> running 带 sessionId),
  // seam 语义的 agent-start 只发一次(record.id 首见时)
  private readonly startedIds = new Set<string>()

  constructor(private readonly options: DynamicWorkflowEngineOptions) {
    this.runner = new DshSubagentRunner({ startSubagent: options.startSubagent })
    this.journalStore = new JournalStore(options.cwd, JOURNAL_DIR)
  }

  /**
   * 执行一次 workflow。journal 逐 agent 原子落盘;中断(abort/异常)后已落盘部分
   * 可经 resumeFromRunId 续跑。不可恢复错误原样上抛,由工具层映射为错误结果。
   */
  async run(input: EngineRunInput): Promise<EngineRunOutput> {
    const resumeJournal = input.resumeFromRunId
      ? this.journalStore.load(input.resumeFromRunId)
      : undefined
    const resumedFromDisk = resumeJournal !== undefined && resumeJournal.size > 0
    const runId = input.resumeFromRunId ?? `run-${Date.now().toString(36)}`
    const onProgress = this.options.onProgress

    const result = await runWorkflow(input.script, {
      executor: vmExecutor,
      agent: this.runner,
      args: input.args,
      concurrency: input.concurrency,
      maxAgents: input.maxAgents,
      signal: input.signal,
      cwd: this.options.cwd,
      registryRootDir: REGISTRY_DIR,
      resolveTier: (tier) => loadModelTiers({ projectDir: this.options.cwd, projectRootDir: TIER_ROOT })[tier],
      runId,
      resumeJournal: resumedFromDisk ? resumeJournal : undefined,
      onAgentJournal: (entry: JournalEntry & { key: string }) => {
        try {
          const { key, ...body } = entry
          this.journalStore.append(runId, key, body)
        } catch {
          // 落盘失败不阻断运行(journal 仅影响回放优化)
        }
      },
      onAgentExecution: (payload) => {
        try {
          this.journalStore.recordExecution(runId, payload.key, payload.execution)
        } catch {
          // 同上:落盘失败不阻断
        }
      },
      onAgentUpdate: onProgress ? (record: AgentRecord) => emitProgress(onProgress, record, this.startedIds) : undefined,
    })

    return {
      meta: result.meta,
      result: result.result,
      logs: result.logs,
      phases: result.phases,
      agents: result.agents,
      agentCount: result.agentCount,
      durationMs: result.durationMs,
      runId,
      resumedFromDisk,
    }
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
