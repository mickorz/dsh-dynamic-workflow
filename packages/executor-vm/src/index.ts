/**
 * VM 沙箱执行(原 src/runtime/vm.ts 的执行半部;WorkflowExecutor 的 node:vm 实现)
 *
 * 执行流程：
 *  vm.createContext(仅注入运行时函数，不注入宿主内建)
 *   -> DETERMINISM_PRELUDE（vm 域内中和 Math.random / Date.now / new Date()）
 *   -> 包裹为 (async () => { body })() 执行
 *
 * 注意：vm 不是安全沙箱，防的是可信脚本的"意外非确定性"，不是攻击。
 * 已知天花板(ponytail 注):同步自旋(while true)不可杀 —— production 后端见 executor-ptc(规划中)。
 */

import vm from "node:vm"
import type { WorkflowExecutor } from "@mickorz/dynamic-workflow-core"

/**
 * 运行时确定性加固，在 vm 域内、用户脚本之前执行：
 *   - Math.random()        -> 抛错
 *   - Date.now()           -> 抛错
 *   - Date() / new Date()  -> 抛错（无参）；new Date(arg) 仍可用
 */
const DETERMINISM_PRELUDE = [
  '"use strict";',
  'Math.random = () => { throw new Error("Math.random() is unavailable in a workflow (it breaks resume); pass randomness via args or vary by index"); };',
  "{",
  "  const RealDate = Date;",
  '  const fail = (w) => { throw new Error(w + " is unavailable in a workflow (it breaks resume); pass a timestamp via args"); };',
  "  const SafeDate = function (...a) {",
  '    if (!new.target) fail("Date()");',
  '    if (a.length === 0) fail("new Date()");',
  "    return Reflect.construct(RealDate, a, SafeDate);",
  "  };",
  "  SafeDate.UTC = RealDate.UTC;",
  "  SafeDate.parse = RealDate.parse;",
  '  SafeDate.now = () => fail("Date.now()");',
  "  SafeDate.prototype = RealDate.prototype;",
  "  globalThis.Date = SafeDate;",
  "}",
].join("\n")

/** 在 vm 沙箱中执行 workflow body,返回脚本 return 值 */
export async function runScriptInVm(
  body: string,
  metaName: string,
  globals: Record<string, unknown>,
): Promise<unknown> {
  const context = vm.createContext({
    ...globals,
    // Object/Array/JSON/Math/Date/Promise 等来自 vm 域自身——刻意不注入宿主内建，
    // 其 .constructor 会是宿主 Function（绕过确定性护栏）；Math/Date 由 PRELUDE 在域内中和
  })

  const wrapped = `${DETERMINISM_PRELUDE}\n(async () => {\n${body}\n})()`
  const script = new vm.Script(wrapped, { filename: `${metaName || "workflow"}.js` })
  return (await script.runInContext(context)) as unknown
}

/** WorkflowExecutor 的 node:vm 实现(MVP 执行后端) */
export const vmExecutor: WorkflowExecutor = { runScriptInVm }
