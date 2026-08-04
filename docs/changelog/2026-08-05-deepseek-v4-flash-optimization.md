# DeepSeek V4 Flash 优化（2026-08）

分支：`feat/deepseek-v4-flash-optimization`

## P0

- `normalizeDeepSeekChatEffort`：Chat Completions 线上 `medium→low`；preset Flash `reasoningEffort: low`
- thinking 开启时剥离 `temperature` / `top_p` / penalties；回归断言 body 无 temperature
- UI `/effort` medium 文案标明「DeepSeek 线上映射为 low」；`oai-types` 注释同步

## P1

- 工具族 effort overlay + `routeRoutineEffort` 合成取 **min**（`effort-overlay.ts`）
- `workers.routing.planning` 默认 `capable`；capability 卡 planning 归 Pro（不全押 Flash）
- GlanceBar `◉N%` = reasoning / output

## P2

- Responses 双栈：`protocol: responses` 或 `RIVET_DEEPSEEK_RESPONSES=1`（仅 Flash）
- conformance：`deepseek_dual_stack` / `deepseek_effort_norm`
- 自托管 MTP/FP4 边界：`docs/deepseek-self-host-mtp-fp4.md`
- `banditPromotion.effort` 默认 `auto`（闸门满足后真投票）
