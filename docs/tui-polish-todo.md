# 天枢 UI 美化待办

> 2026-06-03 — 从 UI 质感讨论中提炼，按优先级排列。

## 1. 消息层级与视觉节奏 ✅

- [x] 回合边界标记：Turn N · phase trail · files · duration，加粗主色，thick 分隔线
- [x] 工具调用链缩进：depth 字段 + tree connectors（├─ │），ToolCard 支持 depth prop

## 2. 色彩与主题深化

- [ ] 星域人格色彩：不同 star domain（天枢/天璇/天府）微调整体色调氛围
  - 天枢（领航）→ 冷静蓝紫
  - 天璇（寻迹）→ 探索青绿
  - 天府（守藏）→ 温暖金橙
- [ ] 语义色一致性审查：确保 tool family 颜色在所有主题下可辨识
- [ ] 高对比度模式（accessibility）

## 3. 排版与间距

- [x] 消息间呼吸间距 ✅
- [ ] 代码块左右 padding 对齐
- [ ] 窄终端（<80 列）自适应：减少 padding，折叠 GlanceBar 信息
- [ ] Markdown 表格列对齐优化

## 4. 动画与反馈

- [x] 流式输出微动效 ✅
- [ ] 工具执行中旋转指示器（替代静态 …）
- [ ] 阶段过渡动画（phase change 时的小过渡）
- [ ] 思考折叠/展开过渡

## 5. 折叠/展开的优雅化 ✅

- [x] 折叠标记：盒式标记 `┌─ 34 lines ─┐` 替代 `... N lines hidden ...`
- [x] 一键展开：Enter/Tab 切换展开，聚焦时高亮提示
- [x] 文件预览：read_file 折叠时显示文件头部预览 + 尾部截断

## 6. 信息架构

- [ ] GlanceBar 自定义：允许用户配置显示哪些指标
- [ ] 折叠历史回合：长对话中折叠旧回合为摘要行
- [ ] 工具输出智能截断：根据内容类型（diff/code/table）自适应截断策略

## 6. 工程约束

- 所有改动需保持 Ink 渲染性能（避免过多 Box 嵌套导致 flicker）
- 终端兼容性：确保在 256 色和 truecolor 终端都能正常显示
- 不破坏现有 Static 渲染模型（ring buffer → Static items）
