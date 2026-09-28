/**
 * 示例工作流集(P3;冒烟测试 examples.smoke.test.ts 逐个经 engine 跑通,保证示例永不失效)
 * 每个示例:meta 合法、DSL 用法典型、人类可直接抄改。
 */

export interface WorkflowExample {
  /** 建议文件名 */
  file: string
  /** 一句话说明 */
  summary: string
  /** 脚本原文 */
  script: string
}

export const EXAMPLES: WorkflowExample[] = [
  {
    file: "fan-out-research.js",
    summary: "并行扇出调研 + 汇总:多源独立调研,聚合结论(上下文不进主会话)",
    script: `export const meta = {
  name: 'fan_out_research',
  description: '多源并行调研并汇总',
  phases: [{ title: 'fan' }, { title: 'summarize' }],
}
phase('fan')
const topics = ['性能', '安全', '兼容性']
const findings = await parallel(topics.map((t) => () => agent(\`调研主题:\${t},给出要点\`, { label: t })))
phase('summarize')
const digest = await agent('汇总以下调研为三行结论:' + JSON.stringify(findings), { label: 'digest' })
return { findings, digest }`,
  },
  {
    file: "multi-angle-review.js",
    summary: "评审团择优:多方案各配多评委打分,取最高均分",
    script: `export const meta = { name: 'multi_angle_review', description: '多方案评审择优' }
const proposals = ['方案甲', '方案乙', '方案丙']
const best = await judgePanel(proposals, { judges: 2, rubric: '可行性与成本' })
return best`,
  },
  {
    file: "verify-claim.js",
    summary: "对抗式验证:多 reviewer 试图反驳断言,投票达阈值判真",
    script: `export const meta = { name: 'verify_claim', description: '对抗式验证断言' }
const verdict = await verify('断言:该项目测试覆盖率达到 80%', { reviewers: 3, threshold: 0.6 })
return verdict`,
  },
  {
    file: "gate-then-deploy.js",
    summary: "人工门禁:checkpoint 审批后才执行后续(拒绝即强停止,幂等可续跑)",
    script: `export const meta = { name: 'gate_then_deploy', description: '人工门禁后执行' }
const plan = await agent('产出上线计划', { label: 'plan' })
const approved = await checkpoint({ id: 'deploy-gate', message: '计划如下,是否上线?', payload: { plan }, defaultAction: false })
if (!approved) return { deployed: false, reason: '未获批准' }
const deployed = await agent('执行上线', { label: 'deploy' })
return { deployed: true, result: deployed }`,
  },
  {
    file: "resilient-pipeline.js",
    summary: "容错流水线:单条失败塌缩 null 不影响整体,失败项显式报告",
    script: `export const meta = { name: 'resilient_pipeline', description: '容错的批量处理' }
const items = ['a', 'b', 'c']
const results = await pipeline(
  items,
  (item) => agent(\`处理 \${item}\`, { label: \`proc-\${item}\`, retries: 1 }),
  (r, item) => ({ item, r }),
)
return {
  ok: results.filter(Boolean).length,
  failed: results.map((r, i) => (r ? null : items[i])).filter(Boolean),
}`,
  },
]
