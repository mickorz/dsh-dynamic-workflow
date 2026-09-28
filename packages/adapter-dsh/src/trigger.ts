/**
 * createCronTrigger —— cron 触发薄层(P3;Trigger 定位,冻结稿:不建存储不做深)
 *
 * 职责边界:本模块只负责"何时启动"(nextRun 驱动 setTimeout);
 * 多实例去重 / 持久化 / 管理面由宿主调度器(DSH jobs / cron / 外部 scheduler)负责。
 * cron 校验与 slot 计算复用 core(生产验证实现)。
 */
import { validateCron, nextRun } from "@mickorz/dynamic-workflow-core"
import type { DynamicWorkflowEngine, EngineRunInput, EngineRunOutput } from "./engine.js"

export interface CronTriggerOptions {
  /** cron 表达式(core 支持的四模式子集;见 validateCron) */
  cron: string
  /** 每次 tick 要跑的 run 输入(script 等固定内容;动态内容经函数) */
  input: EngineRunInput | (() => EngineRunInput)
  /** 触发结果回调(缺省仅记录;抛错不中断下一轮) */
  onResult?: (output: EngineRunOutput) => void
  /** 触发失败回调 */
  onError?: (error: unknown) => void
  /** now 注入(测试缝;缺省 Date.now) */
  now?: () => number
}

export interface CronTrigger {
  /** 开始调度(首个 slot 到点触发) */
  start(): void
  /** 停止调度(进行中的 run 不打断;只取消后续 tick) */
  stop(): void
  /** 是否在调度中 */
  readonly running: boolean
}

export function createCronTrigger(engine: DynamicWorkflowEngine, options: CronTriggerOptions): CronTrigger {
  const invalid = validateCron(options.cron)
  if (invalid) throw new Error(`cron 表达式非法:${invalid}`)
  const now = options.now ?? Date.now
  let timer: NodeJS.Timeout | undefined
  let active = false

  const schedule = (): void => {
    if (!active) return
    const next = nextRun(options.cron, new Date(now()))
    const delay = Math.max(0, next.getTime() - now())
    timer = setTimeout(() => {
      void fire()
    }, delay)
  }

  const fire = async (): Promise<void> => {
    if (!active) return
    try {
      const input = typeof options.input === "function" ? options.input() : options.input
      const output = await engine.run(input)
      options.onResult?.(output)
    } catch (error) {
      options.onError?.(error)
    }
    schedule() // 无论成败,继续下一轮
  }

  return {
    start() {
      if (active) return
      active = true
      schedule()
    },
    stop() {
      active = false
      if (timer !== undefined) {
        clearTimeout(timer)
        timer = undefined
      }
    },
    get running() {
      return active
    },
  }
}
