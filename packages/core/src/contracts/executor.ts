/**
 * WorkflowExecutor 契约:脚本 body 的沙箱执行后端接口。
 *
 * core 不依赖任何具体执行器(node:vm / PTC / ...);
 * 由 adapter 组装具体实现(如 @mickorz/dynamic-workflow-executor-vm)注入 runWorkflow。
 */

/**
 * 脚本执行后端接口。
 * 语义:在隔离上下文中执行 `(async () => { body })()`,返回脚本 return 值;
 * 负责确定性加固(DETERMINISM_PRELUDE);body 来自 parseWorkflowScript 的输出(已剥离 meta)。
 */
export interface WorkflowExecutor {
  /**
   * 在沙箱中执行 workflow body,返回脚本 return 值。
   * @param body 已剥离 meta 的脚本正文
   * @param metaName 展示名(错误堆栈 filename 用)
   * @param globals 注入脚本的全局(agent/parallel/pipeline/...)
   */
  runScriptInVm(body: string, metaName: string, globals: Record<string, unknown>): Promise<unknown>
}
