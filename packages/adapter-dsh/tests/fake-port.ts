/**
 * fake DSH subagent port —— 契约测试基建
 * 模拟 seam 语义:start 抛错=基础设施故障;result 永不 reject;dispose 幂等。
 */
import type {
  PortStartSubagent,
  PortSubagentResult,
  PortSubagentRun,
  PortSubagentStartRequest,
} from "../src/port.js"

export interface FakePortCalls {
  requests: PortSubagentStartRequest[]
  disposed: string[]
}

export interface FakePortOptions {
  /** 每次 start 的结果工厂(按调用序;默认 completed 文本 "ok") */
  results?: Array<PortSubagentResult | ((signal: AbortSignal) => Promise<PortSubagentResult>)>
  /** start 本身抛错(基础设施故障路径) */
  startThrows?: (request: PortSubagentStartRequest) => Error | undefined
}

export function createFakePort(options: FakePortOptions = {}): {
  start: PortStartSubagent
  calls: FakePortCalls
} {
  const calls: FakePortCalls = { requests: [], disposed: [] }
  let seq = 0
  const start: PortStartSubagent = async (request) => {
    const error = options.startThrows?.(request)
    if (error) throw error
    calls.requests.push(request)
    const index = seq++
    const id = `fake-run-${index}`
    const slot = options.results?.[index]
    const result: PortSubagentResult =
      slot === undefined
        ? { output: [{ type: "text", text: "ok" }], stopReason: "completed" }
        : typeof slot === "function"
          ? await slot(request.signal)
          : slot
    const run: PortSubagentRun = {
      id,
      result: Promise.resolve(result),
      dispose: () => {
        calls.disposed.push(id)
        return Promise.resolve()
      },
    }
    return run
  }
  return { start, calls }
}

/** 常用结果工厂 */
export const textResult = (text: string): PortSubagentResult => ({
  output: [{ type: "text", text }],
  stopReason: "completed",
})

export const structuredResult = (value: unknown): PortSubagentResult => ({
  output: [],
  structured: value,
  stopReason: "completed",
})

export const failedResult = (diagnostic = "child failed"): PortSubagentResult => ({
  output: [],
  diagnostic,
  stopReason: "error",
})

export const cancelledResult = (diagnostic = "cancelled"): PortSubagentResult => ({
  output: [],
  diagnostic,
  stopReason: "cancelled",
})
