# Wave 1 任务文档：用户文档重写

> 任务编号：W1-04
> 优先级：中
> 预估：单 session，1 小时
> 前置依赖：#02 (multi-provider), #03 (install)

## 目标

README 面向用户重写。新用户 5 分钟内理解天枢是什么、怎么装、怎么用。

## 设计

### README 结构

```markdown
# 天枢 (Tiānshū)

一句话：终端 AI 编程助手，比你用过的任何 agent 都更少返工。

## 为什么选天枢

- 模型会主动验证，不等你催
- 模型敢说"你的方案有问题"，不盲目服从
- 40+ 轮长对话不退化
- 支持 DeepSeek / Claude / GPT

## 安装

npx tianshu

## 快速开始

（3 步示例：安装 → 配置 → 第一个任务）

## 命令参考

（斜杠命令表）

## 配置

（provider 切换、API key、项目规则）

## 与 Claude Code / Cursor 的区别

（一段话，不贬低竞品，突出差异）
```

### 不放在 README 中的

- 架构图（在 dev-guide.md）
- CVM 原理（在设计文档中）
- 贡献指南（单独文件）
- 开发者文档（单独文件）

## 实现计划

### Task 1: README.md 面向用户改写

原始 README 已备份到 `docs/archive/2026-05-21-pre-w1/README.md`。

改写 `README.md`（保留有价值的内容，重组结构）：
- 面向用户，不面向开发者
- 简洁，不超过 200 行
- 包含安装、快速开始、命令参考、配置
- 开发者信息移至 CONTRIBUTING.md

### Task 2: CONTRIBUTING.md

创建 `CONTRIBUTING.md`：
- 开发环境搭建
- 代码规范
- 测试要求
- PR 流程

### Task 3: docs/user-guide.md

创建 `docs/user-guide.md`：
- 详细使用指南
- 高级功能（session replay、memory、verification）
- 常见问题

## 验证

- README 中的安装命令可执行
- 快速开始示例可复现
- 无断链

## 不做的事

- 不写 API 文档（没有 SDK 导出）
- 不写架构文档（已有 dev-guide.md）
- 不做多语言文档（先中文，后续加英文）
