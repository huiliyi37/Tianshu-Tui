import type { PreTurnRuntimeHook, RuntimeHookContext } from '../runtime-hooks.js'
import type { AdvisoryBus } from '../advisory-bus.js'
import { detectSpecToExecuteJump } from './spec-verify-gate.js'

export interface SpecVerifyGateHookDeps {
  advisoryBus: Pick<AdvisoryBus, 'submit'>
}

export function createSpecVerifyGateHook(deps: SpecVerifyGateHookDeps): PreTurnRuntimeHook {
  return {
    phase: 'preTurn',
    name: 'spec-verify-gate',
    run(ctx: RuntimeHookContext) {
      const result = detectSpecToExecuteJump({
        recentToolHistory: ctx.snapshot.recentToolHistory.map(h => ({
          tool: h.tool,
          target: h.target,
        })),
      })
      if (result.triggered) {
        deps.advisoryBus.submit({
          key: 'spec-verify-gate',
          priority: 0.9,
          category: 'constitutional',
          tier: 'constitutional',
          content: `⚠ 你刚读完 \`${result.specDocPath ?? '一份诊断方案'}\` 但尚未独立验证。先做以下至少一项再动手编辑代码：
1. 读原始运行时数据（日志、session JSONL、cache-log）交叉验证文档中的数值声明
2. 写一个复现测试看到 RED，确认缺陷确实存在
3. 运行已有测试确认当前 baseline 是绿的

诊断文档是假说，不是 spec。验证之后再实现。`,
          ttl: 1,
        })
      }
    },
  }
}
