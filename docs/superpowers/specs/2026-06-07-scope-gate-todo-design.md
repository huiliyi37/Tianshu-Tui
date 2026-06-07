# Scope Gate: TODO 层的依赖识别与范围缩窄

> 日期：2026-06-07
> 状态：设计待实施
> 根因：用户指令覆盖太宽 → 模型在 thinking 中试图一次消化全部范围 → thinking 爆炸/循环
> 核心约束：**不追加 prompt 文本**，通过代码行为缩窄工作集

---

## 一、问题

用户给了一条宽指令（"设计一下怎么优化规划循环"），模型在 turn 0 试图用 thinking 一次规划全部内容——涉及多个子系统、多个依赖关系、多个设计决策。thinking 膨胀到 9.2k tokens 后超时。

这不是 thinking budget 的问题，是**输入范围无约束**的问题。

## 二、机制

**触发点**：模型调用 `todo` 工具 `write` 时。

**不新加 prompt**。在 todo 工具的 execute 返回值中做两件事：

### 2.1 范围检测

当 todo 列表写入时，用纯代码逻辑检测：

```typescript
// 在 todo.ts execute() 内，write 成功后
const todos = data.todos

// 1. 统计 pending 数量
const pendingCount = todos.filter(t => t.status === 'pending').length

// 2. 检测隐含依赖链：如果 todo content 提到另一个 todo 的 id
//    例如 T3 写了 "基于 T2 的结果" → T3 depends on T2
const dependencyEdges = detectDependencies(todos)

// 3. 计算最大依赖深度
const maxDepth = computeMaxDepth(dependencyEdges)
```

### 2.2 自动标记当前焦点

当 pending 数量 > 阈值（比如 5），或依赖深度 > 3 时：

```typescript
// 自动将第一个 pending 标记为 in_progress
// 其余保持 pending
// 在返回的 content 中体现这个缩窄
```

**不修改 prompt**。模型看到的是 todo 工具的返回值，自然就知道当前焦点在哪。

### 2.3 依赖阻断

当某个 todo 的前置依赖未完成时（比如 T3 依赖 T2，但 T2 还是 pending），在 todo 工具返回中标注：

```
⚠️ T3 "实现天梁 profile" depends on T1 "计划解析器" (pending)
  当前焦点: T1
```

这让模型**看到**依赖关系，但不是通过追加 prompt，而是通过工具返回值。

## 三、依赖检测算法

```typescript
interface TodoDeps {
  id: string
  dependsOn: string[]  // 引用的其他 todo id
}

function detectDependencies(todos: TodoItem[]): TodoDeps[] {
  const idSet = new Set(todos.map(t => t.id))
  return todos.map(t => {
    // 在 content 中查找引用的 id
    const refs: string[] = []
    for (const other of idSet) {
      if (other === t.id) continue
      if (t.content.includes(other)) {
        refs.push(other)
      }
    }
    return { id: t.id, dependsOn: refs }
  })
}
```

不需要 NLP。模型的 todo content 通常会自然包含 "基于 T1" "依赖 Task2" 等 id 引用。

## 四、与 taskProgress 的联动

todo 工具写入后，`turn-end.ts` 的 `processTurnEnd` 已经会用 `taskStateFromTodos` 更新 `taskProgress`。

改动点：`taskStateFromTodos` 增加**焦点缩窄**逻辑——当依赖深度过大时，`current` 只指向第一个可执行的 todo（前置依赖都已完成的第一个 pending），`remaining` 排除被阻断的项。

```typescript
export function taskStateFromTodos(todos: TodoItem[], decisions: string[]): TaskState {
  const deps = detectDependencies(todos)
  const completedSet = new Set(todos.filter(t => t.status === 'completed').map(t => t.id))
  
  // 找第一个可执行的 pending（所有依赖已完成）
  const executable = todos.filter(t => 
    t.status === 'pending' && 
    deps.find(d => d.id === t.id)?.dependsOn.every(dep => completedSet.has(dep)) !== false
  )
  
  const current = executable[0]?.content ?? todos.find(t => t.status === 'in_progress')?.content ?? 'working'
  
  return {
    completed: todos.filter(t => t.status === 'completed').map(t => t.content),
    current,
    remaining: executable.slice(1).map(t => t.content),
    decisions,
  }
}
```

## 五、改动文件清单

| 文件 | 改动 |
|------|------|
| `src/tools/todo-store.ts` | 新增 `detectDependencies()`、`computeMaxDepth()` |
| `src/tools/todo.ts` | write 路径增加范围检测 + 焦点标记 + 依赖标注 |
| `src/agent/task-state.ts` | `taskStateFromTodos` 增加依赖过滤 |

## 六、不做的事

- ❌ 不追加 prompt 文本
- ❌ 不用正则做用户输入的门控
- ❌ 不在 addUserMessage 之前加 LLM 调用
- ❌ 不改 convergence-detector（那是事后检测，这是事前预防）

## 七、验证标准

1. todo 写入 5+ 个 pending 项时，返回值自动标注当前焦点
2. T3 依赖 T2（pending）时，T3 被标注为"依赖未满足"
3. taskStateFromTodos 只返回可执行的项
4. 不增加任何 prompt token
