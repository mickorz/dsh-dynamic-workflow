/**
 * BackgroundRunManager —— DSH 引擎的后台 run 注册表(OpenCode 版同构语义)
 *
 * 生命周期:
 *  start(input) -> 同步预验脚本(parseWorkflowScript)-> 注册 runId -> 分离执行
 *    -> 完成/失败/中止后终态固化(最近 20 条保留)
 *  status(runId?) -> 单个/全部快照
 *  stop(runId)    -> abort 级联(runtime 停止派发 + 子代理取消)
 *
 * 与宿主 jobs 的关系(capability backgroundJobs):DSH 真机接入 ctx.jobs 时,
 * 本注册表仍负责 engine 内状态,jobs 层包装生命周期 —— port 层先以内建注册表落地。
 */
import { parseWorkflowScript, type AgentRecord } from "@mickorz/dynamic-workflow-core"
import type { DynamicWorkflowEngine, EngineRunInput, EngineRunOutput } from "./engine.js"

export type BackgroundStatus = "running" | "completed" | "failed" | "aborted"

export interface BackgroundRunInfo {
  runId: string
  name: string
  status: BackgroundStatus
  startedAt: number
  endedAt?: number
  /** 各 agent 终态记录(实时) */
  agents: AgentRecord[]
  logs: string[]
  error?: string
  /** 完成时的返回值(status=completed) */
  value?: unknown
}

/** 注册表保留的历史条数 */
const HISTORY_CAP = 20

export interface BackgroundStartDeps {
  engine: DynamicWorkflowEngine
  /** run 级外部中止信号(宿主生命周期;可选) */
  signal?: AbortSignal
}

export class BackgroundRunManager {
  private readonly runs = new Map<string, { info: BackgroundRunInfo; controller: AbortController }>()

  /** 启动后台 run:同步预验脚本,非法即抛(调用方立即看到);合法返回 runId */
  start(deps: BackgroundStartDeps, input: EngineRunInput): string {
    // 先验脚本:parseWorkflowScript 同步抛错(与前台行为一致)
    parseWorkflowScript(input.script)
    const controller = new AbortController()
    if (deps.signal) {
      if (deps.signal.aborted) controller.abort()
      else deps.signal.addEventListener("abort", () => controller.abort(), { once: true })
    }
    const runId = input.resumeFromRunId ?? `run-${Date.now().toString(36)}`
    const info: BackgroundRunInfo = {
      runId,
      name: "pending",
      status: "running",
      startedAt: Date.now(),
      agents: [],
      logs: [],
    }
    this.runs.set(runId, { info, controller })
    // 分离执行:终态固化;异常不逃出(注册表自洽)
    void deps.engine
      .run({
        ...input,
        runId,
        signal: controller.signal,
      })
      .then((output: EngineRunOutput) => {
        info.status = "completed"
        info.value = output.result
        this.finish(info, output)
      })
      .catch((error: unknown) => {
        info.status = controller.signal.aborted ? "aborted" : "failed"
        info.error = error instanceof Error ? error.message : String(error)
        this.finish(info, undefined)
      })
    return runId
  }

  /** 查询单个(缺省返回全部快照,不含内部对象) */
  status(runId?: string): BackgroundRunInfo[] {
    if (runId !== undefined) {
      const entry = this.runs.get(runId)
      return entry ? [entry.info] : []
    }
    return [...this.runs.values()].map((e) => e.info)
  }

  /** 停止:abort 级联;未知 runId 返回 false */
  stop(runId: string): boolean {
    const entry = this.runs.get(runId)
    if (!entry) return false
    entry.controller.abort()
    return true
  }

  private finish(info: BackgroundRunInfo, output?: EngineRunOutput): void {
    info.endedAt = Date.now()
    if (output) {
      info.name = output.meta.name
      info.agents = output.agents
      info.logs = output.logs
    }
    // 历史封顶:淘汰最旧的终态条目
    if (this.runs.size > HISTORY_CAP) {
      for (const [id, entry] of this.runs) {
        if (entry.info.status !== "running") {
          this.runs.delete(id)
          break
        }
      }
    }
  }
}
