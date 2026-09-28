# 示例工作流(dynamic_workflow 脚本集)

每个脚本可直接作为 `dynamic_workflow` 工具的 `script` 参数使用(建议存盘后经 `scriptPath`/宿主方式引用;DSH 侧首版为 script 原文参数)。`examples.smoke.test.ts` 逐个冒烟,保证示例永不失效。

| 示例 | 展示能力 |
|---|---|
| fan-out-research | parallel 扇出 + phase 分组 + 汇总(上下文不进主会话) |
| multi-angle-review | judgePanel 评审团(schema 结构化打分) |
| verify-claim | verify 对抗式验证(投票阈值) |
| gate-then-deploy | checkpoint 人工门禁(Human Reject 强停止;defaultAction 幂等) |
| resilient-pipeline | pipeline 容错(单条失败塌缩 null,整体继续) |

## 通用契约

- 首条语句 `export const meta = { name, description, phases? }`
- 禁 `Date.now() / Math.random() / new Date() / import`(resume 确定性)
- `agent()` 至少一次;脚本 return 的 JSON 值即工具结果
- 中断后把结果里的 runId 传 `resumeFromRunId` 续跑(已完成 agent 从 journal 回放不重调)
