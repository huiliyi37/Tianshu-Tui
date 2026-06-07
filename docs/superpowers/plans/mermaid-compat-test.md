# Mermaid 模板库 — 兼容性实测样图

> 用途：在 **VSCode（Markdown Preview）/ GitHub / Obsidian** 三处分别打开本文件，对照下方「实测记录」勾选每张图的渲染结果。
> 目的：确认语义词汇（形状）与 classDef 调色板的**可移植基线**——哪些三处都渲染、哪些某处退化。**这一步定模板库第 2 层能做多少。**
> 题材：天枢意图路由流（真实子系统，兼作可用样例）。

---

## 图 1 · 全语义词汇 + dark 调色板（架构图）

测试点：7 种语义形状 + 4 种边类型 + classDef 着色 + `%%{init}%%` 主题 + subgraph 分层。

```mermaid
%%{init: {'theme':'base', 'themeVariables': {'fontFamily':'monospace','fontSize':'14px'}}}%%
flowchart TD
    subgraph IN["输入层"]
        U(用户消息)
        LA(上一轮回复)
    end

    subgraph LOGIC["逻辑层"]
        SAN[[意图脱敏]]
        RC[[上下文解析]]
        LLM{{LLM 分类器}}
        DEC{HEAD 变了?}
    end

    subgraph STORE["存储层"]
        DB[(MeridianDB)]
        TC[(TaskContract)]
    end

    OUT([路由结果])

    U --> SAN
    LA -.-> RC
    U --> RC
    SAN --富化--> LLM
    RC --映射--> LLM
    LLM --> DEC
    DEC -->|否| OUT
    DEC -->|是| DB
    LLM ==> TC
    DB -.缓存.-> LLM

    classDef model fill:#1e293b,stroke:#38bdf8,color:#e0f2fe,stroke-width:2px
    classDef agent fill:#0f172a,stroke:#818cf8,color:#e0e7ff
    classDef store fill:#1e1b4b,stroke:#a78bfa,color:#ede9fe
    classDef io fill:#022c22,stroke:#34d399,color:#d1fae5
    class LLM model
    class SAN,RC agent
    class DB,TC store
    class U,LA,OUT io
```

---

## 图 2 · 极简黑白调色板（mono，无主题依赖）

测试点：不依赖 `%%{init}%%`，纯 classDef 扁平描边——验证**最保守基线**是否三处都稳。

```mermaid
flowchart LR
    A(请求) --> B[[路由]]
    B --> C{命中?}
    C -->|是| D[(缓存)]
    C -->|否| E{{LLM}}
    E ==> F([响应])

    classDef box fill:#ffffff,stroke:#333333,color:#111111
    class A,B,C,D,E,F box
```

---

## 图 3 · 时序图（sequenceDiagram，不同图型语法）

测试点：flowchart 之外的图型在三处是否都支持。

```mermaid
sequenceDiagram
    participant U as 用户
    participant R as 路由器
    participant L as LLM 分类器
    participant S as 存储
    U->>R: 做 P1
    R->>S: 取上一轮回复
    S-->>R: P1 = 修复内存泄露
    R->>L: 富化后分类
    L-->>R: bug_fix
    R->>U: 执行修复
```

---

## 图 4 · 对比图（并列 subgraph）

测试点：subgraph 并列布局 + 跨组无连线时的排版。

```mermaid
flowchart TB
    subgraph CC["Claude Code"]
        direction TB
        C1[无显式意图分类]
        C2[靠 system prompt]
    end
    subgraph TS["天枢"]
        direction TB
        T1[三层意图富化]
        T2[抗锚定 hooks]
    end

    classDef other fill:#1e293b,stroke:#64748b,color:#e2e8f0
    classDef ours fill:#1e1b4b,stroke:#a78bfa,color:#ede9fe
    class C1,C2 other
    class T1,T2 ours
```

---

## 实测记录（请在三处查看后填写）

| 测试点 | VSCode Preview | GitHub | Obsidian |
|--------|:---:|:---:|:---:|
| 图1 七种形状正确 | ☐ | ☐ | ☐ |
| 图1 classDef 着色生效 | ☐ | ☐ | ☐ |
| 图1 `%%{init}%%` 主题/字体生效 | ☐ | ☐ | ☐ |
| 图1 四种边（实/粗/虚/标签）区分 | ☐ | ☐ | ☐ |
| 图1 subgraph 分层正确 | ☐ | ☐ | ☐ |
| 图2 mono 纯 classDef（无 init）生效 | ☐ | ☐ | ☐ |
| 图3 sequenceDiagram 渲染 | ☐ | ☐ | ☐ |
| 图4 并列 subgraph 布局正确 | ☐ | ☐ | ☐ |

> 填写规则：✅ 完美 / ⚠️ 渲染但样式退化（注明：如"classDef 忽略"）/ ❌ 破图或不渲染。
>
> **校准结论**：三处都 ✅ 的进模板库基线；某处 ⚠️ 的标注"该查看器降级"；任何 ❌ 的从词汇里剔除或换写法。
> 这张表的结果直接决定 `2026-06-07-mermaid-diagram-template-library.md` 第 2 层（调色板）和第 1 层（形状）能承诺多少。
